'use strict';

/**
 * 提醒筛选 / 去重 / 渲染（reminder-plan）离线测试。
 *
 * 这里锁的是「提醒的边界语义」——多提醒一次很烦，少提醒一次是事故，
 * 所以每个窗口边界都要有用例。
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  candidateNotices,
  applyDedup,
  recheckScopes,
  render,
  renderPending,
  renderUpcoming,
  formatRemaining,
  splitBatches,
  beijingDay,
  escapeMarkdown
} = require('../extractor/lib/reminder-plan');

/** 固定「现在」：2026-09-24 12:00 北京时间。 */
const NOW = Date.parse('2026-09-24T12:00:00+08:00');
const HOUR = 60 * 60 * 1000;

function homework(changes = {}) {
  return {
    accountId: 'acct',
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

function rows(list) {
  return list.map((item) => ({ homework: item, revision: 0 }));
}

test('候选筛选：还早于 24 小时的作业本轮不提醒', () => {
  const far = homework({ deadline: '2026-09-26T12:00:00+08:00' }); // 48 小时后
  assert.strictEqual(candidateNotices(rows([far]), NOW, 'once').length, 0);
});

test('候选筛选：24 小时窗口内为 24h 阶段', () => {
  const near = homework({ deadline: '2026-09-25T06:00:00+08:00' }); // 18 小时后
  const notices = candidateNotices(rows([near]), NOW, 'once');
  assert.strictEqual(notices.length, 1);
  assert.strictEqual(notices[0].stage, '24h');
});

test('候选筛选：进入 1 小时窗口只发紧急阶段，不叠加 24h', () => {
  const urgent = homework({ deadline: '2026-09-24T12:30:00+08:00' }); // 30 分钟后
  const notices = candidateNotices(rows([urgent]), NOW, 'once');
  assert.strictEqual(notices.length, 1);
  assert.strictEqual(notices[0].stage, '1h');
});

test('候选筛选：恰好 1 小时算紧急阶段（边界含等号）', () => {
  const edge = homework({ deadline: '2026-09-24T13:00:00+08:00' });
  assert.strictEqual(candidateNotices(rows([edge]), NOW, 'once')[0].stage, '1h');
  const justOver = homework({ deadline: '2026-09-24T13:00:01+08:00' });
  assert.strictEqual(candidateNotices(rows([justOver]), NOW, 'once')[0].stage, '24h');
});

test('候选筛选：无截止时间按 once / daily 两种分桶', () => {
  const undated = homework({ deadline: null });
  const once = candidateNotices(rows([undated]), NOW, 'once');
  assert.strictEqual(once[0].stage, 'undated');
  assert.strictEqual(once.length, 1);

  // daily 模式下，同一天只产生同一个事件键（第二天才换桶）。
  const dailyToday = candidateNotices(rows([undated]), NOW, 'daily');
  const dailySameDay = candidateNotices(rows([undated]), NOW + HOUR, 'daily');
  assert.strictEqual(dailyToday[0].event, dailySameDay[0].event);
  const dailyNextDay = candidateNotices(rows([undated]), NOW + 24 * HOUR, 'daily');
  assert.notStrictEqual(dailyToday[0].event, dailyNextDay[0].event);
});

test('候选筛选：归档/已完成/未知完成/未发布/已逾期一律不提醒', () => {
  const cases = [
    homework({ archived: true }),
    homework({ completed: true }),
    homework({ completed: null }),
    homework({ status: ['未发布'] }),
    homework({ publishAt: '2026-10-01T00:00:00+08:00' }),
    homework({ deadline: '2026-09-24T11:00:00+08:00' })
  ];
  for (const item of cases) {
    assert.strictEqual(candidateNotices(rows([item]), NOW, 'once').length, 0, JSON.stringify(item.status));
  }
});

test('候选筛选：非法参数抛错', () => {
  assert.throws(() => candidateNotices(rows([homework()]), NaN, 'once'), /nowMs/);
  assert.throws(() => candidateNotices(rows([homework()]), NOW, 'weekly'), /once 或 daily/);
});

test('候选排序：紧急在前，其次按截止时间', () => {
  const urgent = homework({ homeworkId: 3, deadline: '2026-09-24T12:30:00+08:00' });
  const later = homework({ homeworkId: 1, deadline: '2026-09-25T06:00:00+08:00' });
  const earlier = homework({ homeworkId: 2, deadline: '2026-09-24T18:00:00+08:00' });
  const undated = homework({ homeworkId: 4, deadline: null });
  const notices = candidateNotices(rows([undated, later, urgent, earlier]), NOW, 'once');
  assert.deepStrictEqual(notices.map((item) => item.homework.homeworkId), [3, 2, 1, 4]);
});

test('事件键：延期（revision 变化）会换键，从而能重新提醒', () => {
  const item = homework({ deadline: '2026-09-24T18:00:00+08:00' });
  const before = candidateNotices([{ homework: item, revision: 0 }], NOW, 'once')[0].event;
  const after = candidateNotices([{ homework: item, revision: 1 }], NOW, 'once')[0].event;
  assert.notStrictEqual(before, after);
});

test('去重：已发送 / 已跳过 / 超重试上限的不再发', () => {
  const notices = candidateNotices(rows([homework({ deadline: '2026-09-24T18:00:00+08:00' })]), NOW, 'once');
  const event = notices[0].event;
  const at = (state, attempts, lastAttempt = null) => new Map([[event, { state, attempts, lastAttempt }]]);

  assert.strictEqual(applyDedup(notices, at('sent', 1), NOW).length, 0);
  assert.strictEqual(applyDedup(notices, at('skipped', 0), NOW).length, 0);
  assert.strictEqual(applyDedup(notices, at('failed', 3), NOW).length, 0);
  assert.strictEqual(applyDedup(notices, new Map(), NOW).length, 1);
});

test('去重：失败后要等够退避时间才重试（第 1 次 5 分钟、第 2 次 30 分钟）', () => {
  const notices = candidateNotices(rows([homework({ deadline: '2026-09-24T18:00:00+08:00' })]), NOW, 'once');
  const event = notices[0].event;

  const recent = new Map([[event, { state: 'failed', attempts: 1, lastAttempt: '2026-09-24T11:59:00+08:00' }]]);
  assert.strictEqual(applyDedup(notices, recent, NOW).length, 0, '刚失败过，5 分钟内不重试');

  const older = new Map([[event, { state: 'failed', attempts: 1, lastAttempt: '2026-09-24T11:50:00+08:00' }]]);
  assert.strictEqual(applyDedup(notices, older, NOW).length, 1, '超过 5 分钟可以重试');

  const second = new Map([[event, { state: 'failed', attempts: 2, lastAttempt: '2026-09-24T11:50:00+08:00' }]]);
  assert.strictEqual(applyDedup(notices, second, NOW).length, 0, '第 2 次失败要等 30 分钟');
});

test('复核范围：只保留实际要提醒的 (课堂, 类型)，不重复', () => {
  const notices = [
    { homework: homework({ classroomCode: 'A', kind: 4 }) },
    { homework: homework({ classroomCode: 'A', kind: 4 }) },
    { homework: homework({ classroomCode: 'A', kind: 1 }) },
    { homework: homework({ classroomCode: 'B', kind: 4 }) }
  ];
  assert.deepStrictEqual(recheckScopes(notices), [['A', 4], ['A', 1], ['B', 4]]);
  assert.deepStrictEqual(recheckScopes([]), []);
});

test('渲染：标题带数量，正文含班级、类型、截止与链接', () => {
  const notices = candidateNotices(rows([homework({ deadline: '2026-09-24T18:00:00+08:00' })]), NOW, 'once');
  const { title, body } = render(notices, NOW);
  assert.strictEqual(title, '作业提醒：1 项待处理');
  assert.match(body, /北京时间：2026-09-24 12:00:00/);
  assert.match(body, /24 小时内截止 · 软件工程1班（DEMO0001）/);
  assert.match(body, /课堂实验：单元测试/);
  assert.match(body, /截止：2026-09-24 18:00:00/);
  assert.match(body, /\[打开课堂作业列表\]\(https:\/\/www\.educoder\.net\/classrooms\/DEMO0001\/shixun_homework\)/);
});

test('渲染：无截止时间时提示人工确认，不编造时间', () => {
  const notices = candidateNotices(rows([homework({ deadline: null })]), NOW, 'once');
  const { body } = render(notices, NOW);
  assert.match(body, /请查看课程要求，确认提交时间。/);
});

test('渲染：作业名里的 Markdown 特殊字符被转义', () => {
  assert.strictEqual(escapeMarkdown('a*b_[c]'), 'a\\*b\\_\\[c\\]');
  const notices = candidateNotices(rows([homework({ name: '第*1*章 [必做]', deadline: null })]), NOW, 'once');
  const { body } = render(notices, NOW);
  assert.match(body, /第\\\*1\\\*章 \\\[必做\\\]/);
});

test('分批：正文超过上限时拆成多批，不静默丢作业', () => {
  const many = Array.from({ length: 60 }, (_v, index) => homework({
    homeworkId: index + 1,
    name: `作业${index + 1}${'很长的名字'.repeat(20)}`,
    deadline: null
  }));
  const notices = candidateNotices(rows(many), NOW, 'once');
  const batches = splitBatches(notices, NOW, 4000);
  assert.ok(batches.length > 1, '应该拆成多批');
  assert.strictEqual(batches.reduce((sum, batch) => sum + batch.length, 0), notices.length);
  for (const batch of batches) {
    assert.ok(Buffer.byteLength(render(batch, NOW).body, 'utf8') <= 4000);
  }
});

test('分批：单条就超限时返回空数组（由调用方报错，而不是发空消息）', () => {
  const huge = homework({ name: 'x'.repeat(5000), deadline: null });
  const notices = candidateNotices(rows([huge]), NOW, 'once');
  assert.deepStrictEqual(splitBatches(notices, NOW, 100), []);
});

test('汇总渲染：两类作业都列出，标注不占正式提醒名额', () => {
  const items = [
    homework({ kind: 4, kindName: '课堂实验', name: '单元测试', deadline: '2026-09-26T18:00:00+08:00' }),
    homework({ kind: 1, kindName: '图文作业', name: '需求文档', deadline: '2026-09-27T22:00:00+08:00' })
  ];
  const { title, body } = renderUpcoming(items, NOW, 5);
  assert.strictEqual(title, '作业测试汇总：5 天内截止 2 项');
  assert.match(body, /范围：现在起至 2026-09-29 12:00:00/);
  assert.match(body, /不占用正式的 24 小时 \/ 1 小时提醒名额/);
  assert.match(body, /课堂实验：单元测试/);
  assert.match(body, /图文作业：需求文档/);
  assert.match(body, /截止：2026-09-26 18:00:00/);
});

test('汇总渲染：没有到期作业时给出明确说明，而不是空正文', () => {
  const { title, body } = renderUpcoming([], NOW, 5);
  assert.strictEqual(title, '作业测试汇总：5 天内截止 0 项');
  assert.match(body, /未来 5 天内没有未完成且未归档的到期作业。/);
});

test('剩余时间文案：天/小时/分钟，逾期用「已逾期」', () => {
  assert.strictEqual(formatRemaining((3 * 24 + 2) * HOUR + 5 * 60000), '剩余 3 天 2 小时');
  assert.strictEqual(formatRemaining(40 * 60000), '剩余 40 分钟');
  assert.strictEqual(formatRemaining(30 * 1000), '剩余 不到 1 分钟');
  assert.strictEqual(formatRemaining(-90 * 60000), '已逾期 1 小时 30 分钟');
});

test('待办视图：按紧急程度分档，已完成/归档不出现在里面', () => {
  const items = [
    homework({ homeworkId: 1, name: '已逾期项', deadline: '2026-09-24T08:00:00+08:00' }),
    homework({ homeworkId: 2, name: '两小时内', deadline: '2026-09-24T14:00:00+08:00' }),
    homework({ homeworkId: 3, name: '三天后', deadline: '2026-09-27T12:00:00+08:00' }),
    homework({ homeworkId: 4, name: '很久以后', deadline: '2026-12-31T23:59:00+08:00' }),
    homework({ homeworkId: 5, name: '无截止', deadline: null }),
    homework({ homeworkId: 6, name: '已完成的', deadline: '2026-09-24T14:00:00+08:00', completed: true }),
    homework({ homeworkId: 7, name: '已归档的', deadline: '2026-09-24T14:00:00+08:00', archived: true })
  ];
  const document = renderPending(items, NOW);

  assert.match(document, /待处理共 5 项，其中 1 项没有截止时间。/);
  assert.match(document, /## 已逾期（仍未完成）（1 项）/);
  assert.match(document, /## 24 小时内截止（1 项）/);
  assert.match(document, /## 7 天内截止（1 项）/);
  assert.match(document, /## 7 天以上（1 项）/);
  assert.match(document, /## 未设置截止时间（1 项）/);

  assert.match(document, /已逾期项/);
  assert.match(document, /两小时内/);
  assert.match(document, /剩余 2 小时/);
  assert.match(document, /无截止时间/);
  assert.ok(!document.includes('已完成的'), '已完成作业不该出现在待办里');
  assert.ok(!document.includes('已归档的'), '已归档作业不该出现在待办里');
});

test('待办视图：全部完成时给出 0 项而不是报错', () => {
  const document = renderPending([homework({ completed: true })], NOW);
  assert.match(document, /待处理共 0 项。/);
  assert.match(document, /## 24 小时内截止（0 项）\n\n（无）/);
});

test('beijingDay：按北京时间切日期', () => {
  assert.strictEqual(beijingDay(Date.parse('2026-09-24T23:30:00+08:00')), '2026-09-24');
  assert.strictEqual(beijingDay(Date.parse('2026-09-25T00:30:00+08:00')), '2026-09-25');
});
