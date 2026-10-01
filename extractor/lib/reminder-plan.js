'use strict';

/**
 * 提醒的「筛选 / 去重 / 渲染」——纯函数，`nowMs` 与推送状态全部由调用方注入。
 *
 * 三阶段提醒（与参考实现一致）：
 *   - `24h`：截止前 24 小时内，提醒一次；
 *   - `1h` ：截止前 1 小时内，再提醒一次；**进入 1 小时窗口后只发紧急阶段，不叠加**；
 *   - `undated`：没有截止时间的未完成作业，按 `once`（每个阶段只提醒一次）
 *     或 `daily`（每天一次）处理，避免无限重复。
 *
 * 去重键把 `stage` 与「截止时间被修改的次数」（revision）一起算进哈希：
 * 老师延期后 revision 变化 → 事件键变化 → 会重新提醒，这是刻意设计的。
 *
 * 已完成 / 归档 / 未发布 / 已逾期 / 完成状态未知 一律不进入提醒。
 */

const { createHash } = require('node:crypto');
const { reminderState, fromBeijingIso, toBeijingIso } = require('./homework-model');

/** 正文长度上限（Server 酱本地保护）。 */
const MAX_BODY_BYTES = 30000;

/** 单个事件的失败重试上限与退避。 */
const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MINUTES = [5, 30];

const STAGE_ORDER = { '1h': 0, '24h': 1, undated: 2 };
const STAGE_LABEL = {
  '1h': '不足或剩余 1 小时',
  '24h': '24 小时内截止',
  undated: '未设置截止时间'
};

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** 北京时间日期（`YYYY-MM-DD`），用于「每天一次」的无截止提醒分桶与额度统计。 */
function beijingDay(nowMs) {
  return toBeijingIso(nowMs).slice(0, 10);
}

/** 北京时间 `YYYY-MM-DD HH:mm:ss`，用于展示。 */
function formatBeijing(iso) {
  return String(iso || '').replace('T', ' ').replace('+08:00', '');
}

/** 转义 Markdown 特殊字符，避免作业名里的 `*`/`[` 破坏消息结构。 */
function escapeMarkdown(text) {
  return String(text == null ? '' : text)
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/([\\`*_{}[\]()#+!|<>])/g, '\\$1');
}

function eventHash(parts) {
  return createHash('sha256').update(JSON.stringify(parts), 'utf8').digest('hex');
}

/**
 * 从快照记录筛出「此刻该提醒」的候选事件（尚未考虑是否已经发过）。
 *
 * @param {Array<{homework: object, revision: number}>} rows reminder-store.listPresent 的产物
 * @param {number} nowMs
 * @param {'once'|'daily'} undatedMode 无截止作业的提醒频率
 * @returns {Array<{event: string, homework: object, stage: string}>} 已排序
 */
function candidateNotices(rows, nowMs, undatedMode = 'once') {
  if (!Number.isFinite(nowMs)) throw new Error('nowMs 必须是有效时间戳。');
  if (undatedMode !== 'once' && undatedMode !== 'daily') {
    throw new Error('请设置无截止时间提醒频率为 once 或 daily。');
  }
  const notices = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const homework = row && row.homework;
    if (!homework) continue;
    const revision = Number(row.revision) || 0;
    const state = reminderState(homework, nowMs);

    let stage;
    let bucket = '';
    if (state === 'no_deadline') {
      stage = 'undated';
      bucket = undatedMode === 'daily' ? beijingDay(nowMs) : 'once';
    } else if (state === 'pending') {
      const remaining = fromBeijingIso(homework.deadline) - nowMs;
      if (remaining > DAY_MS) continue; // 还早，本轮不提醒
      stage = remaining <= HOUR_MS ? '1h' : '24h';
    } else {
      continue;
    }

    const event = eventHash([
      String(homework.accountId || ''),
      String(homework.classroomCode || ''),
      Number(homework.kind) || 0,
      homework.homeworkId,
      homework.deadline || null,
      revision,
      stage,
      bucket
    ]);
    notices.push({ event, homework, stage });
  }
  return notices.sort((a, b) => {
    const byStage = STAGE_ORDER[a.stage] - STAGE_ORDER[b.stage];
    if (byStage !== 0) return byStage;
    const left = a.homework.deadline || '';
    const right = b.homework.deadline || '';
    if (left !== right) return left < right ? -1 : 1;
    return Number(a.homework.homeworkId) - Number(b.homework.homeworkId);
  });
}

/**
 * 按已发送记录过滤：已成功 / 已跳过 / 超过重试上限的不再发；
 * 失败的重试要等够退避时间。**纯函数**——推送状态由调用方查库后传入。
 *
 * @param {Array} candidates candidateNotices 的产物
 * @param {Map<string, {state:string, attempts:number, lastAttempt:string|null}>} stateMap
 * @param {number} nowMs
 */
function applyDedup(candidates, stateMap, nowMs) {
  const states = stateMap instanceof Map ? stateMap : new Map();
  return (Array.isArray(candidates) ? candidates : []).filter((notice) => {
    const previous = states.get(notice.event);
    if (!previous) return true;
    if (previous.state === 'sent' || previous.state === 'skipped') return false;
    const attempts = Number(previous.attempts) || 0;
    if (attempts >= MAX_ATTEMPTS) return false;
    if (previous.lastAttempt) {
      const lastMs = Date.parse(previous.lastAttempt);
      const delayMinutes = RETRY_DELAYS_MINUTES[attempts - 1] ?? RETRY_DELAYS_MINUTES[RETRY_DELAYS_MINUTES.length - 1];
      if (Number.isFinite(lastMs) && nowMs < lastMs + delayMinutes * 60 * 1000) return false;
    }
    return true;
  });
}

/** 只复核「本次真要提醒的课堂/作业类型」——避免为了发一条提醒而全量重抓。 */
function recheckScopes(notices) {
  const seen = new Map();
  for (const notice of Array.isArray(notices) ? notices : []) {
    const key = `${notice.homework.classroomCode}|${notice.homework.kind}`;
    if (!seen.has(key)) seen.set(key, [String(notice.homework.classroomCode), Number(notice.homework.kind)]);
  }
  return [...seen.values()];
}

/** 渲染一条提醒消息。 */
function render(notices, nowMs) {
  const list = Array.isArray(notices) ? notices : [];
  const title = `作业提醒：${list.length} 项待处理`;
  const blocks = [`北京时间：${formatBeijing(toBeijingIso(nowMs))}`];
  for (const notice of list) {
    const { homework, stage } = notice;
    const lines = [`### ${STAGE_LABEL[stage]} · ${escapeMarkdown(homework.classroomName)}（${escapeMarkdown(homework.classroomCode)}）`];
    lines.push(`${escapeMarkdown(homework.kindName)}：${escapeMarkdown(homework.name)}`);
    lines.push(
      homework.deadline
        ? `截止：${formatBeijing(homework.deadline)}`
        : '请查看课程要求，确认提交时间。'
    );
    lines.push(`[打开课堂作业列表](${homework.url})`);
    blocks.push(lines.join('\n'));
  }
  return { title, body: blocks.join('\n\n') };
}

/** 把毫秒差渲染成「剩余 3 天 2 小时」/「已逾期 40 分钟」。 */
function formatRemaining(ms) {
  const abs = Math.abs(ms);
  // 向下取整：剩 30 秒时说「剩余 1 分钟」偏高，会让人以为还有整一分钟。
  const totalMinutes = Math.floor(abs / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const parts = [];
  if (days) parts.push(`${days} 天`);
  if (hours) parts.push(`${hours} 小时`);
  if (!days && minutes) parts.push(`${minutes} 分钟`);
  const text = parts.join(' ') || '不到 1 分钟';
  return ms < 0 ? `已逾期 ${text}` : `剩余 ${text}`;
}

/** 待办视图的分档。 */
const PENDING_BUCKETS = [
  { key: 'overdue', title: '已逾期（仍未完成）' },
  { key: '24h', title: '24 小时内截止' },
  { key: '7d', title: '7 天内截止' },
  { key: 'later', title: '7 天以上' },
  { key: 'undated', title: '未设置截止时间' }
];

function bucketOf(homework, nowMs) {
  if (!homework.deadline) return 'undated';
  const remaining = fromBeijingIso(homework.deadline) - nowMs;
  if (remaining <= 0) return 'overdue';
  if (remaining <= DAY_MS) return '24h';
  if (remaining <= 7 * DAY_MS) return '7d';
  return 'later';
}

/**
 * 渲染「当前全部待办」视图——本地通道下这是**你实际要去看的那份文件**。
 *
 * 与 `render` 的区别：`render` 只包含「此刻到点、该发一次」的事件（用于推送）；
 * 这里包含**所有未完成、未归档、已发布的作业**，按紧急程度分档，
 * 因此无论有没有发过提醒，看到的都是完整现状。
 */
function renderPending(homeworks, nowMs, options = {}) {
  const list = Array.isArray(homeworks) ? homeworks : [];
  const generatedAt = options.generatedAt || toBeijingIso(nowMs);
  const visible = list.filter((homework) => {
    const state = reminderState(homework, nowMs);
    return state === 'pending' || state === 'overdue' || state === 'no_deadline';
  });

  const grouped = new Map(PENDING_BUCKETS.map((bucket) => [bucket.key, []]));
  for (const homework of visible) grouped.get(bucketOf(homework, nowMs)).push(homework);
  for (const items of grouped.values()) {
    items.sort((a, b) => {
      const left = a.deadline || '9999';
      const right = b.deadline || '9999';
      if (left !== right) return left < right ? -1 : 1;
      return Number(a.homeworkId) - Number(b.homeworkId);
    });
  }

  const undatedCount = grouped.get('undated').length;
  const lines = [
    '# 待办作业（本地视图）',
    '',
    `更新时间：${formatBeijing(generatedAt)}（北京时间）`,
    `待处理共 ${visible.length} 项${undatedCount ? `，其中 ${undatedCount} 项没有截止时间` : ''}。`,
    '',
    '> 这份文件每次同步后自动重写，无需手工维护。'
  ];

  for (const bucket of PENDING_BUCKETS) {
    const items = grouped.get(bucket.key);
    lines.push('', `## ${bucket.title}（${items.length} 项）`, '');
    if (!items.length) {
      lines.push('（无）');
      continue;
    }
    for (const homework of items) {
      const remaining = homework.deadline ? `${formatRemaining(fromBeijingIso(homework.deadline) - nowMs)}` : '无截止时间';
      lines.push(
        `- **${escapeMarkdown(homework.classroomName)}（${escapeMarkdown(homework.classroomCode)}）**`
          + ` · ${escapeMarkdown(homework.kindName)} · ${escapeMarkdown(homework.name)}`
      );
      lines.push(`  - 截止：${homework.deadline ? formatBeijing(homework.deadline) : '—'}（${remaining}）`);
      lines.push(`  - ${homework.url}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

/**
 * 渲染「未来 N 天截止」汇总（人工核对用）。
 *
 * 与 `render` 的区别：这里列的是**尚未进入 24 小时窗口**的作业，用途是核对
 * 「采集到的作业与算出的截止时间对不对」，所以不按提醒阶段分档，
 * 而是按截止时间排序，并明确标注这是测试汇总、不占正式提醒名额。
 */
function renderUpcoming(homeworks, nowMs, days = 5) {
  const list = Array.isArray(homeworks) ? homeworks : [];
  const untilMs = nowMs + days * DAY_MS;
  const title = `作业测试汇总：${days} 天内截止 ${list.length} 项`;
  const blocks = [
    `北京时间：${formatBeijing(toBeijingIso(nowMs))}`,
    `范围：现在起至 ${formatBeijing(toBeijingIso(untilMs))}`,
    '（这是手动测试汇总，不占用正式的 24 小时 / 1 小时提醒名额。）'
  ];
  for (const homework of list) {
    blocks.push([
      `### ${escapeMarkdown(homework.classroomName)}（${escapeMarkdown(homework.classroomCode)}）`,
      `${escapeMarkdown(homework.kindName)}：${escapeMarkdown(homework.name)}`,
      `截止：${formatBeijing(homework.deadline)}`,
      `[打开课堂作业列表](${homework.url})`
    ].join('\n'));
  }
  if (!list.length) blocks.push(`未来 ${days} 天内没有未完成且未归档的到期作业。`);
  return { title, body: blocks.join('\n\n') };
}

/**
 * 按正文长度上限分批：额度一次可能不够，宁可分几批发，也不静默丢掉后面的作业。
 * 返回 `[]` 表示「一条都放不下」，调用方应报错而不是发送空消息。
 */
function splitBatches(notices, nowMs, maxBytes = MAX_BODY_BYTES) {
  const list = Array.isArray(notices) ? notices : [];
  const batches = [];
  let current = [];
  for (const notice of list) {
    const trial = [...current, notice];
    if (Buffer.byteLength(render(trial, nowMs).body, 'utf8') > maxBytes) {
      if (!current.length) return [];
      batches.push(current);
      current = [notice];
    } else {
      current = trial;
    }
  }
  if (current.length) batches.push(current);
  return batches;
}

module.exports = {
  MAX_BODY_BYTES,
  MAX_ATTEMPTS,
  RETRY_DELAYS_MINUTES,
  STAGE_LABEL,
  beijingDay,
  formatBeijing,
  formatRemaining,
  escapeMarkdown,
  candidateNotices,
  applyDedup,
  recheckScopes,
  render,
  renderPending,
  renderUpcoming,
  splitBatches
};
