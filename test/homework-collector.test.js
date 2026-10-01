'use strict';

/**
 * 作业采集（homework-collector）离线测试。
 *
 * 传输层是注入的，所以这里能完整覆盖「分页完整性」「归档与超期过滤」
 * 「越权访问拒绝」这些**错了就会静默丢数据或重复提醒**的逻辑，
 * 不需要账号、不联网。
 */

const test = require('node:test');
const assert = require('node:assert');

const { HomeworkError } = require('../extractor/lib/homework-model');
const { discoverClassrooms, collectHomeworks, crawl } = require('../extractor/lib/homework-collector');

const NOW = Date.parse('2026-09-24T12:00:00+08:00');
const CLASSROOM = { id: 1, name: '软件工程1班', code: 'joined', canVisit: true };

const noSleep = async () => {};

function homeworkRow(id, changes = {}) {
  return {
    homework_id: id,
    name: `作业${id}`,
    is_archive: false,
    status: ['提交中'],
    shixun_finished_status: 0,
    un_commit_work: true,
    publish_time: '2026-09-01 12:00',
    end_time: '2026-09-25 12:00',
    end_time_s: '2026-09-25 12:00',
    ...changes
  };
}

function homeworkPage(rows, count = rows.length, changes = {}) {
  return { homework_type: 4, is_end: false, query_total_count: count, all_count: 99, homeworks: rows, ...changes };
}

/** 按 `page` 参数取页的假传输层。 */
function pagedTransport(pages) {
  const calls = [];
  const get = async (pathname, params) => {
    calls.push({ pathname, params });
    return pages[params.page - 1];
  };
  return { get, calls };
}

// ---------------------------------------------------------------- 课堂发现

test('课堂发现：过滤已结束课堂，并保留 can_visited', async () => {
  const { get } = pagedTransport([{
    count: 3,
    courses: [
      { id: 1, name: '进行中A', is_end: false, first_category_url: '/classrooms/aaa/announcement', can_visited: true },
      { id: 2, name: '已结束', is_end: true, first_category_url: '/classrooms/bbb/announcement' },
      { id: 3, name: '进行中B', is_end: false, first_category_url: '/classrooms/ccc/announcement', can_visited: false }
    ]
  }]);
  const classrooms = await discoverClassrooms(get, 'acct', { sleep: noSleep });
  assert.deepStrictEqual(classrooms.map((item) => item.code), ['aaa', 'ccc']);
  assert.strictEqual(classrooms[0].canVisit, true);
  assert.strictEqual(classrooms[1].canVisit, false);
});

test('课堂发现：分页期间 count 变化 → 整批失败', async () => {
  const { get } = pagedTransport([
    { count: 2, courses: [{ id: 1, name: 'a', is_end: false, first_category_url: '/classrooms/a/x' }] },
    { count: 3, courses: [{ id: 2, name: 'b', is_end: false, first_category_url: '/classrooms/b/x' }] }
  ]);
  await assert.rejects(() => discoverClassrooms(get, 'acct', { perPage: 1, sleep: noSleep }), HomeworkError);
});

test('课堂发现：跨页重复 → 拒绝保存', async () => {
  const dup = { id: 1, name: 'a', is_end: false, first_category_url: '/classrooms/a/x' };
  const { get } = pagedTransport([{ count: 2, courses: [dup] }, { count: 2, courses: [dup] }]);
  await assert.rejects(() => discoverClassrooms(get, 'acct', { perPage: 1, sleep: noSleep }), HomeworkError);
});

test('课堂发现：提前结束（累计数不足 count）→ 拒绝保存', async () => {
  const { get } = pagedTransport([
    { count: 5, courses: [{ id: 1, name: 'a', is_end: false, first_category_url: '/classrooms/a/x' }] },
    { count: 5, courses: [] }
  ]);
  await assert.rejects(() => discoverClassrooms(get, 'acct', { perPage: 1, sleep: noSleep }), HomeworkError);
});

test('课堂发现：count/courses 缺失时不当成「空课堂」', async () => {
  const { get } = pagedTransport([{ courses: [] }]);
  await assert.rejects(() => discoverClassrooms(get, 'acct', { sleep: noSleep }), HomeworkError);
});

test('课堂发现：缺账号标识直接抛错', async () => {
  await assert.rejects(() => discoverClassrooms(async () => ({}), '', {}), HomeworkError);
});

// ---------------------------------------------------------------- 作业采集

test('作业采集：归档项只计入分页、不入库', async () => {
  const archived = { homework_id: 1, is_archive: true };
  const { get } = pagedTransport([homeworkPage([archived], 2), homeworkPage([homeworkRow(2)], 2)]);
  const result = await collectHomeworks(get, CLASSROOM, 4, new Set(['joined']), {
    accountId: 'acct', nowMs: NOW, perPage: 1, sleep: noSleep
  });
  assert.deepStrictEqual(result.map((item) => item.homeworkId), [2]);
});

test('作业采集：逾期超过 cutoffDays 的作业在读截止时间后就跳过', async () => {
  const old = homeworkRow(1, { end_time_s: '2026-09-19 11:59:59', end_time: '2026-09-19 11:59:59' });
  const boundary = homeworkRow(2, { end_time_s: '2026-09-19 12:00:00', end_time: '2026-09-19 12:00:00' });
  const undated = homeworkRow(3, { end_time_s: null, end_time: null });
  const { get } = pagedTransport([homeworkPage([old, boundary, undated])]);
  const result = await collectHomeworks(get, CLASSROOM, 4, new Set(['joined']), {
    accountId: 'acct', nowMs: NOW, sleep: noSleep
  });
  // 恰好 5 天保留；无截止时间保留；更早的丢弃。
  assert.deepStrictEqual(result.map((item) => item.homeworkId), [2, 3]);
});

test('作业采集：cutoffDays=0 关闭超期过滤', async () => {
  const old = homeworkRow(1, { end_time_s: '2020-01-01 00:00:00', end_time: '2020-01-01 00:00:00' });
  const { get } = pagedTransport([homeworkPage([old])]);
  const result = await collectHomeworks(get, CLASSROOM, 4, new Set(['joined']), {
    accountId: 'acct', nowMs: NOW, cutoffDays: 0, sleep: noSleep
  });
  assert.strictEqual(result.length, 1);
});

test('作业采集：类型或课堂状态变化 → 失败', async () => {
  const wrongType = pagedTransport([homeworkPage([homeworkRow(1)], 1, { homework_type: 1 })]).get;
  await assert.rejects(
    () => collectHomeworks(wrongType, CLASSROOM, 4, new Set(['joined']), { accountId: 'acct', nowMs: NOW, sleep: noSleep }),
    HomeworkError
  );
  const ended = pagedTransport([homeworkPage([homeworkRow(1)], 1, { is_end: true })]).get;
  await assert.rejects(
    () => collectHomeworks(ended, CLASSROOM, 4, new Set(['joined']), { accountId: 'acct', nowMs: NOW, sleep: noSleep }),
    HomeworkError
  );
});

test('作业采集：分页重复与提前结束都拒绝保存', async () => {
  const dup = pagedTransport([homeworkPage([homeworkRow(1)], 2), homeworkPage([homeworkRow(1)], 2)]).get;
  await assert.rejects(
    () => collectHomeworks(dup, CLASSROOM, 4, new Set(['joined']), { accountId: 'acct', nowMs: NOW, perPage: 1, sleep: noSleep }),
    HomeworkError
  );
  const short = pagedTransport([homeworkPage([homeworkRow(1)], 5), homeworkPage([], 5)]).get;
  await assert.rejects(
    () => collectHomeworks(short, CLASSROOM, 4, new Set(['joined']), { accountId: 'acct', nowMs: NOW, perPage: 1, sleep: noSleep }),
    HomeworkError
  );
});

test('作业采集：白名单外的课堂直接拒绝，且不发请求', async () => {
  const { get, calls } = pagedTransport([homeworkPage([], 0)]);
  await assert.rejects(
    () => collectHomeworks(get, CLASSROOM, 4, new Set(['other']), { accountId: 'acct', nowMs: NOW, sleep: noSleep }),
    HomeworkError
  );
  assert.strictEqual(calls.length, 0);
});

test('作业采集：不可访问的课堂不采集', async () => {
  const { get } = pagedTransport([homeworkPage([], 0)]);
  await assert.rejects(
    () => collectHomeworks(get, { ...CLASSROOM, canVisit: false }, 4, new Set(['joined']), {
      accountId: 'acct', nowMs: NOW, sleep: noSleep
    }),
    HomeworkError
  );
});

test('作业采集：请求带上 type/id/status 与分页参数', async () => {
  const { get, calls } = pagedTransport([homeworkPage([homeworkRow(1)], 1, { homework_type: 1 })]);
  await collectHomeworks(get, CLASSROOM, 1, new Set(['joined']), { accountId: 'acct', nowMs: NOW, sleep: noSleep });
  assert.strictEqual(calls[0].pathname, '/api/courses/joined/homework_commons.json');
  assert.strictEqual(calls[0].params.type, 1);
  assert.strictEqual(calls[0].params.id, 'joined');
  assert.strictEqual(calls[0].params.status, 0);
});

// ---------------------------------------------------------------- 完整同步

test('完整同步：课堂 × 两类作业都要采到，且账号写进身份', async () => {
  const pages = {
    '/api/users/acct/courses.json': [{
      count: 1,
      courses: [{
        id: 1,
        name: '班级A',
        is_end: false,
        can_visited: true,
        first_category_url: '/classrooms/joined/announcement'
      }]
    }]
  };
  const get = async (pathname, params) => {
    if (pages[pathname]) return pages[pathname][0];
    if (pathname === '/api/courses/joined/homework_commons.json') {
      const rows = [homeworkRow(Number(params.type) * 10)];
      return { homework_type: Number(params.type), is_end: false, query_total_count: 1, homeworks: rows };
    }
    throw new Error(`未预期的请求：${pathname}`);
  };
  const result = await crawl(get, 'acct', { nowMs: NOW, cutoffDays: 0, sleep: noSleep });
  assert.strictEqual(result.accountId, 'acct');
  assert.strictEqual(result.classrooms.length, 1);
  assert.deepStrictEqual(result.homeworks.map((item) => item.kind), [4, 1]);
  assert.ok(result.homeworks.every((item) => item.accountId === 'acct'));
});
