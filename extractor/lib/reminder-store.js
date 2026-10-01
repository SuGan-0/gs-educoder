'use strict';

/**
 * 提醒用的 SQLite 存储（快照 + 推送记账）。
 *
 * 用 Node **内置**的 `node:sqlite`（Node 22.5+），不新增任何 npm 依赖——
 * 与 docs/ARCHITECTURE.md 的「不新增依赖」硬约束一致。
 *
 * ## 为什么这里要 SQLite，而题目存档仍然是 JSONL
 *
 * 两者的读写模式完全不同：
 * - 题目存档（`levels.jsonl`）是「一次写入、可重建的视图」，追加式最合适；
 * - 作业状态需要**按主键更新、按时间查询、保留变更历史**，还要做发送去重与额度记账，
 *   用追加式文件会迅速变得难读且容易出错。
 *
 * 所以不强行统一：题目继续用现有存档，作业与提醒用 SQLite。
 *
 * ## 身份口径
 *
 * 作业主键 = `account_id + classroom_code + kind + homework_id`，与
 * homework-model.js 的 `homeworkKey()` 完全一致。名称只存进 payload 供展示。
 *
 * ## 一致性
 *
 * 所有写操作都在事务里；`saveSnapshot` 失败会整体回滚，
 * **旧快照与去重记录不受影响**——这是「采集失败不覆盖成功结果」的落点。
 */

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS homeworks (
  account_id      TEXT    NOT NULL,
  classroom_code  TEXT    NOT NULL,
  kind            INTEGER NOT NULL,
  homework_id     INTEGER NOT NULL,
  deadline        TEXT,
  completed       INTEGER,
  archived        INTEGER NOT NULL,
  present         INTEGER NOT NULL,
  payload         TEXT    NOT NULL,
  synced_at       TEXT    NOT NULL,
  PRIMARY KEY (account_id, classroom_code, kind, homework_id)
);
CREATE TABLE IF NOT EXISTS deadline_changes (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id      TEXT    NOT NULL,
  classroom_code  TEXT    NOT NULL,
  kind            INTEGER NOT NULL,
  homework_id     INTEGER NOT NULL,
  old_deadline    TEXT,
  new_deadline    TEXT,
  detected_at     TEXT    NOT NULL
);
CREATE TABLE IF NOT EXISTS sync_state (
  account_id      TEXT PRIMARY KEY,
  synced_at       TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS push_attempts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  receiver        TEXT    NOT NULL,
  day             TEXT    NOT NULL,
  attempted_at    TEXT    NOT NULL,
  status          TEXT    NOT NULL,
  error           TEXT
);
CREATE TABLE IF NOT EXISTS push_events (
  receiver        TEXT    NOT NULL,
  event           TEXT    NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  state           TEXT    NOT NULL,
  last_attempt    TEXT,
  attempt_id      INTEGER,
  PRIMARY KEY (receiver, event)
);
CREATE INDEX IF NOT EXISTS idx_homeworks_present ON homeworks (account_id, present);
`;

function ensureDirectory(filePath) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    /* Windows 上无意义，忽略 */
  }
}

function secureFile(filePath) {
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    /* 同上 */
  }
}

/**
 * 打开（或创建）存储。
 * @param {string} filePath 传 `:memory:` 可开内存库（测试用）
 */
function openStore(filePath) {
  const target = String(filePath || '');
  if (!target) throw new Error('缺少数据库路径。');
  const isMemory = target === ':memory:';
  if (!isMemory) ensureDirectory(target);
  const db = new DatabaseSync(target);
  if (!isMemory) secureFile(target);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);

  function transaction(work) {
    db.exec('BEGIN');
    try {
      const result = work();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* 回滚本身失败时保留原始错误 */
      }
      throw error;
    }
  }

  const upsertHomework = db.prepare(`
    INSERT INTO homeworks
      (account_id, classroom_code, kind, homework_id, deadline, completed, archived, present, payload, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT(account_id, classroom_code, kind, homework_id) DO UPDATE SET
      deadline   = excluded.deadline,
      completed  = excluded.completed,
      archived   = excluded.archived,
      present    = 1,
      payload    = excluded.payload,
      synced_at  = excluded.synced_at
  `);
  const selectDeadline = db.prepare(`
    SELECT deadline FROM homeworks
    WHERE account_id = ? AND classroom_code = ? AND kind = ? AND homework_id = ?
  `);
  const insertChange = db.prepare(`
    INSERT INTO deadline_changes
      (account_id, classroom_code, kind, homework_id, old_deadline, new_deadline, detected_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const touchSyncState = db.prepare(`
    INSERT INTO sync_state (account_id, synced_at) VALUES (?, ?)
    ON CONFLICT(account_id) DO UPDATE SET synced_at = excluded.synced_at
  `);

  /**
   * 写入一次完整同步结果。
   *
   * @param {string} accountId
   * @param {Array<object>} homeworks 解析后的作业（homework-model.parseHomework 产物）
   * @param {string} nowIso 同步时刻（北京时间 ISO）
   * @param {{scopes?: Array<[string, number]>}} [options]
   *        scopes 给出「本次实际刷新了哪些 (classroomCode, kind)」——
   *        只标记这些范围为 absent。不传则整账号重置（全量同步）。
   *        传了 scopes 却混入范围外的作业 → 抛错，避免把别的课堂误标为消失。
   * @returns {{saved: number, disappeared: number, deadlineChanges: number}}
   */
  function saveSnapshot(accountId, homeworks, nowIso, options = {}) {
    const account = String(accountId || '').trim();
    if (!account) throw new Error('缺少账号标识，无法保存快照。');
    if (!Number.isFinite(Date.parse(nowIso))) throw new Error('同步时间不合法。');
    const list = Array.isArray(homeworks) ? homeworks : [];
    const scopes = options.scopes
      ? options.scopes.map(([code, kind]) => [String(code), Number(kind)])
      : null;

    return transaction(() => {
      let disappeared = 0;
      if (scopes) {
        const reset = db.prepare(`
          UPDATE homeworks SET present = 0
          WHERE account_id = ? AND classroom_code = ? AND kind = ?
        `);
        for (const [code, kind] of scopes) reset.run(account, code, kind);
      } else {
        const resetAll = db.prepare('UPDATE homeworks SET present = 0 WHERE account_id = ?');
        resetAll.run(account);
      }

      let deadlineChanges = 0;
      for (const homework of list) {
        const key = [
          String(homework.classroomCode || ''),
          Number(homework.kind) || 0,
          homework.homeworkId
        ];
        if (scopes && !scopes.some(([code, kind]) => code === key[0] && kind === key[1])) {
          throw new Error('作业不属于本次刷新的范围，拒绝写入。');
        }
        const previous = selectDeadline.get(account, key[0], key[1], key[2]);
        if (previous && previous.deadline !== homework.deadline) {
          insertChange.run(
            account, key[0], key[1], key[2],
            previous.deadline ?? null, homework.deadline ?? null, nowIso
          );
          deadlineChanges += 1;
        }
        upsertHomework.run(
          account,
          key[0],
          key[1],
          key[2],
          homework.deadline ?? null,
          homework.completed === null || homework.completed === undefined
            ? null
            : (homework.completed ? 1 : 0),
          homework.archived ? 1 : 0,
          JSON.stringify(homework),
          nowIso
        );
      }

      if (!scopes) {
        disappeared = db.prepare('SELECT count(*) AS c FROM homeworks WHERE account_id = ? AND present = 0')
          .get(account).c;
      }
      touchSyncState.run(account, nowIso);
      return { saved: list.length, disappeared, deadlineChanges };
    });
  }

  /**
   * 读回该账号当前有效（present=1）的作业，并附带「截止时间被改过几次」——
   * 修订号进提醒去重键，老师延期后能重新提醒。
   */
  function listPresent(accountId) {
    const rows = db.prepare(`
      SELECT h.payload,
             (SELECT count(*) FROM deadline_changes d
               WHERE d.account_id = h.account_id AND d.classroom_code = h.classroom_code
                 AND d.kind = h.kind AND d.homework_id = h.homework_id) AS revision
        FROM homeworks h
       WHERE h.account_id = ? AND h.present = 1
    `).all(String(accountId || ''));
    return rows.map((row) => ({ homework: JSON.parse(row.payload), revision: Number(row.revision) || 0 }));
  }

  function lastSync(accountId) {
    const row = db.prepare('SELECT synced_at FROM sync_state WHERE account_id = ?').get(String(accountId || ''));
    return row ? row.synced_at : null;
  }

  /**
   * 已知账号标识，最近同步的在前。
   *
   * 常驻服务启动时并不知道「当前登录的是谁」——`get_user_info.json` 要开浏览器才问得到。
   * 先用库里记录的账号跑第一轮，只有真正同步时才去核对身份。
   */
  function listAccounts() {
    return db.prepare(`
      SELECT account_id, max(synced_at) AS latest FROM (
        SELECT account_id, synced_at FROM sync_state
        UNION ALL
        SELECT account_id, synced_at FROM homeworks
      ) GROUP BY account_id ORDER BY latest DESC
    `).all().map((row) => String(row.account_id));
  }

  function countPresent(accountId) {
    return db.prepare('SELECT count(*) AS c FROM homeworks WHERE account_id = ? AND present = 1')
      .get(String(accountId || '')).c;
  }

  /** 读若干事件的推送状态，供去重/退避判定。 */
  function pushStates(receiver, events) {
    const list = Array.isArray(events) ? events : [];
    const map = new Map();
    if (!list.length) return map;
    const stmt = db.prepare(`
      SELECT event, state, attempts, last_attempt FROM push_events
      WHERE receiver = ? AND event = ?
    `);
    for (const event of list) {
      const row = stmt.get(String(receiver), String(event));
      if (row) map.set(String(event), {
        state: row.state,
        attempts: Number(row.attempts) || 0,
        lastAttempt: row.last_attempt
      });
    }
    return map;
  }

  /** 今日剩余额度（按北京时间日期计）。 */
  function quotaRemaining(receiver, day, limit) {
    const used = db.prepare('SELECT count(*) AS c FROM push_attempts WHERE receiver = ? AND day = ?')
      .get(String(receiver), String(day)).c;
    return Math.max(0, Number(limit) - Number(used));
  }

  /**
   * 登记一次发送尝试：先写 inflight，再交给调用方真正发送。
   * 只有这里写成功，后续 markSent/markFailed 才有据可依。
   * @returns {number} attemptId
   */
  function beginAttempt(receiver, day, nowIso, events) {
    const list = Array.isArray(events) ? events : [];
    return transaction(() => {
      const attemptId = db.prepare(`
        INSERT INTO push_attempts (receiver, day, attempted_at, status) VALUES (?, ?, ?, 'inflight')
      `).run(String(receiver), String(day), nowIso).lastInsertRowid;
      const upsert = db.prepare(`
        INSERT INTO push_events (receiver, event, attempts, state, last_attempt, attempt_id)
        VALUES (?, ?, 1, 'inflight', ?, ?)
        ON CONFLICT(receiver, event) DO UPDATE SET
          attempts = attempts + 1, state = 'inflight',
          last_attempt = excluded.last_attempt, attempt_id = excluded.attempt_id
      `);
      for (const event of list) upsert.run(String(receiver), String(event), nowIso, attemptId);
      return Number(attemptId);
    });
  }

  function markSent(attemptId) {
    transaction(() => {
      db.prepare("UPDATE push_attempts SET status = 'sent' WHERE id = ?").run(Number(attemptId));
      db.prepare("UPDATE push_events SET state = 'sent' WHERE attempt_id = ?").run(Number(attemptId));
    });
  }

  function markFailed(attemptId, error) {
    transaction(() => {
      db.prepare("UPDATE push_attempts SET status = 'failed', error = ? WHERE id = ?")
        .run(String(error || '').slice(0, 500), Number(attemptId));
      db.prepare("UPDATE push_events SET state = 'failed' WHERE attempt_id = ?").run(Number(attemptId));
    });
  }

  /** 额度耗尽时把当前事件标记为 skipped，避免次日重复补发。 */
  function markSkipped(receiver, events, nowIso) {
    const list = Array.isArray(events) ? events : [];
    if (!list.length) return 0;
    return transaction(() => {
      const stmt = db.prepare(`
        INSERT INTO push_events (receiver, event, attempts, state, last_attempt)
        VALUES (?, ?, 0, 'skipped', ?)
        ON CONFLICT(receiver, event) DO UPDATE SET state = 'skipped'
      `);
      for (const event of list) stmt.run(String(receiver), String(event), nowIso);
      return list.length;
    });
  }

  function close() {
    try {
      db.close();
    } catch {
      /* 已关闭 */
    }
  }

  return {
    saveSnapshot,
    listPresent,
    lastSync,
    listAccounts,
    countPresent,
    pushStates,
    quotaRemaining,
    beginAttempt,
    markSent,
    markFailed,
    markSkipped,
    close
  };
}

module.exports = { openStore };
