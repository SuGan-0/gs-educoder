'use strict';

/**
 * 提醒存储（reminder-store）离线测试。
 *
 * 核心是**失败不破坏已有数据**：采集失败 / 越界写入时，旧快照与去重记录必须原样保留。
 * 用内存库跑，不落盘、不联网。
 */

const test = require('node:test');
const assert = require('node:assert');

const { openStore } = require('../extractor/lib/reminder-store');

const NOW = '2026-09-24T12:00:00+08:00';
const LATER = '2026-09-24T18:00:00+08:00';

function homework(changes = {}) {
  return {
    accountId: 'acct',
    classroomId: 1,
    classroomName: '软件工程1班',
    classroomCode: 'DEMO0001',
    kind: 4,
    kindName: '课堂实验',
    homeworkId: 100,
    name: '单元测试',
    deadline: '2026-09-25T12:00:00+08:00',
    publishAt: '2026-09-01T12:00:00+08:00',
    archived: false,
    completed: false,
    status: ['提交中'],
    url: 'https://www.educoder.net/classrooms/DEMO0001/shixun_homework',
    ...changes
  };
}

function withStore(work) {
  const store = openStore(':memory:');
  try {
    return work(store);
  } finally {
    store.close();
  }
}

test('快照：写入后能按账号读回，并记录同步时间', () => {
  withStore((store) => {
    const result = store.saveSnapshot('acct', [homework()], NOW);
    assert.strictEqual(result.saved, 1);
    assert.strictEqual(result.deadlineChanges, 0);

    const rows = store.listPresent('acct');
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].homework.name, '单元测试');
    assert.strictEqual(rows[0].revision, 0);
    assert.strictEqual(store.lastSync('acct'), NOW);
    assert.deepStrictEqual(store.listAccounts(), ['acct']);
  });
});

test('快照：完成状态未知写成 NULL，不被当成 false', () => {
  withStore((store) => {
    store.saveSnapshot('acct', [homework({ completed: null })], NOW);
    const rows = store.listPresent('acct');
    assert.strictEqual(rows[0].homework.completed, null);
  });
});

test('快照：截止时间变化被记录，并让 revision 递增（延期后能重新提醒）', () => {
  withStore((store) => {
    store.saveSnapshot('acct', [homework()], NOW);
    store.saveSnapshot('acct', [homework({ deadline: '2026-09-30T12:00:00+08:00' })], LATER);
    const rows = store.listPresent('acct');
    assert.strictEqual(rows[0].revision, 1);
    assert.strictEqual(rows[0].homework.deadline, '2026-09-30T12:00:00+08:00');

    // 同一截止时间再同步一次：不产生新的变更记录（幂等）。
    store.saveSnapshot('acct', [homework({ deadline: '2026-09-30T12:00:00+08:00' })], LATER);
    assert.strictEqual(store.listPresent('acct')[0].revision, 1);
  });
});

test('快照：全量同步后消失的作业标记为 present=0，不再出现在有效清单里', () => {
  withStore((store) => {
    store.saveSnapshot('acct', [homework()], NOW);
    store.saveSnapshot('acct', [], LATER);
    assert.strictEqual(store.listPresent('acct').length, 0);
    assert.strictEqual(store.countPresent('acct'), 0);
  });
});

test('快照：范围同步只重置该范围，其它课堂/类型不受影响', () => {
  withStore((store) => {
    store.saveSnapshot('acct', [
      homework(),
      homework({ classroomCode: 'OTHER', homeworkId: 200, name: '别的班作业' }),
      homework({ kind: 1, homeworkId: 300, name: '图文作业' })
    ], NOW);

    // 只刷新 DEMO0001 的课堂实验，且这次它「消失」了。
    store.saveSnapshot('acct', [], LATER, { scopes: [['DEMO0001', 4]] });

    const names = store.listPresent('acct').map((row) => row.homework.name).sort();
    assert.deepStrictEqual(names, ['别的班作业', '图文作业']);
  });
});

test('快照：范围同步混入范围外作业 → 抛错并整体回滚', () => {
  withStore((store) => {
    store.saveSnapshot('acct', [homework()], NOW);
    assert.throws(
      () => store.saveSnapshot('acct', [homework({ classroomCode: 'OTHER' })], LATER, { scopes: [['DEMO0001', 4]] }),
      /不属于本次刷新的范围/
    );
    // 回滚后：旧数据仍在、同步时间没被推进。
    assert.strictEqual(store.listPresent('acct').length, 1);
    assert.strictEqual(store.lastSync('acct'), NOW);
  });
});

test('快照：缺少账号或非法时间直接抛错', () => {
  withStore((store) => {
    assert.throws(() => store.saveSnapshot('', [homework()], NOW), /缺少账号标识/);
    assert.throws(() => store.saveSnapshot('acct', [homework()], '不是时间'), /同步时间不合法/);
  });
});

test('推送记账：额度按「接收方 + 北京时间日期」统计', () => {
  withStore((store) => {
    assert.strictEqual(store.quotaRemaining('recv', '2026-09-24', 5), 5);
    store.beginAttempt('recv', '2026-09-24', NOW, ['e1']);
    assert.strictEqual(store.quotaRemaining('recv', '2026-09-24', 5), 4);
    store.beginAttempt('recv', '2026-09-25', NOW, ['e2']);
    assert.strictEqual(store.quotaRemaining('recv', '2026-09-24', 5), 4, '别的日期不影响今天');
  });
});

test('推送记账：beginAttempt 后是 inflight，markSent 才变 sent', () => {
  withStore((store) => {
    const attempt = store.beginAttempt('recv', '2026-09-24', NOW, ['e1']);
    let state = store.pushStates('recv', ['e1']).get('e1');
    assert.strictEqual(state.state, 'inflight');
    assert.strictEqual(state.attempts, 1);

    store.markSent(attempt);
    state = store.pushStates('recv', ['e1']).get('e1');
    assert.strictEqual(state.state, 'sent');
  });
});

test('推送记账：失败会记 attempts 与最后尝试时间（供退避判定）', () => {
  withStore((store) => {
    const attempt = store.beginAttempt('recv', '2026-09-24', NOW, ['e1']);
    store.markFailed(attempt, '网络失败');
    const state = store.pushStates('recv', ['e1']).get('e1');
    assert.strictEqual(state.state, 'failed');
    assert.strictEqual(state.attempts, 1);
    assert.strictEqual(state.lastAttempt, NOW);

    // 再试一次：attempts 累加，供「超过上限不再重试」使用。
    store.beginAttempt('recv', '2026-09-24', LATER, ['e1']);
    assert.strictEqual(store.pushStates('recv', ['e1']).get('e1').attempts, 2);
  });
});

test('推送记账：markSkipped 后不再重发', () => {
  withStore((store) => {
    store.markSkipped('recv', ['e1', 'e2'], NOW);
    const states = store.pushStates('recv', ['e1', 'e2']);
    assert.strictEqual(states.get('e1').state, 'skipped');
    assert.strictEqual(states.get('e2').state, 'skipped');
  });
});

test('推送记账：未知事件返回空表，不报错', () => {
  withStore((store) => {
    assert.strictEqual(store.pushStates('recv', ['nope']).size, 0);
    assert.strictEqual(store.pushStates('recv', []).size, 0);
  });
});

test('多账号：各账号的作业互不可见', () => {
  withStore((store) => {
    store.saveSnapshot('acct1', [homework({ accountId: 'acct1' })], NOW);
    store.saveSnapshot('acct2', [homework({ accountId: 'acct2', homeworkId: 200 })], NOW);
    assert.deepStrictEqual(store.listPresent('acct1').map((row) => row.homework.homeworkId), [100]);
    assert.deepStrictEqual(store.listPresent('acct2').map((row) => row.homework.homeworkId), [200]);
    assert.strictEqual(store.listAccounts().length, 2);
  });
});
