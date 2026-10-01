'use strict';

/**
 * 作业模型（homework-model）离线测试。
 *
 * 重点覆盖三类最容易出错、后果又最严重的判定：
 *   ① 北京时间解析（错了就整体漏提醒或误报）；
 *   ② 完成状态未知时必须保持 null（当成「未完成」会对已交作业反复提醒）；
 *   ③ 身份键不依赖名称（同名课堂/作业不能互相覆盖）。
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  HomeworkError,
  toBeijingIso,
  parseBeijingTime,
  readDeadline,
  classroomCodeFromPath,
  parseClassroom,
  parseHomework,
  homeworkKey,
  reminderState
} = require('../extractor/lib/homework-model');

/** 固定「现在」：2026-09-24 12:00 北京时间。 */
const NOW = Date.parse('2026-09-24T12:00:00+08:00');

const CLASSROOM = { id: 1, name: '软件工程1班', code: 'DEMO0001' };

function row(changes = {}) {
  return {
    homework_id: 100,
    name: '单元测试',
    is_archive: false,
    status: ['提交中'],
    shixun_finished_status: 0,
    un_commit_work: true,
    publish_time: '2026-09-01 12:00',
    end_time: '2026-09-25 12:00',
    end_time_s: '2026-09-25 12:00:30',
    ...changes
  };
}

test('北京时间：空格分隔的墙上时间按 +08:00 解释', () => {
  const parsed = parseBeijingTime('2026-09-25 12:00:30');
  assert.strictEqual(parsed.iso, '2026-09-25T12:00:30+08:00');
  assert.strictEqual(parsed.ms, Date.parse('2026-09-25T12:00:30+08:00'));
});

test('北京时间：带时区后缀时按原时区解释，不叠加偏移', () => {
  assert.strictEqual(parseBeijingTime('2026-09-25T04:00:00Z').iso, '2026-09-25T12:00:00+08:00');
  assert.strictEqual(parseBeijingTime('2026-09-25T12:00:00+08:00').iso, '2026-09-25T12:00:00+08:00');
});

test('北京时间：空值返回 null，非法值抛错（不猜测）', () => {
  for (const value of [null, undefined, '', '  ', '--']) {
    assert.strictEqual(parseBeijingTime(value), null);
  }
  assert.throws(() => parseBeijingTime('第一组明天，第二组后天'), HomeworkError);
  assert.throws(() => parseBeijingTime(20260925), HomeworkError);
});

test('toBeijingIso：输出固定 +08:00 且可逆', () => {
  const iso = toBeijingIso(NOW);
  assert.strictEqual(iso, '2026-09-24T12:00:00+08:00');
  assert.strictEqual(Date.parse(iso), NOW);
});

test('截止时间：优先精确的 end_time_s，缺失才退回 end_time', () => {
  assert.strictEqual(readDeadline(row()).iso, '2026-09-25T12:00:30+08:00');
  assert.strictEqual(readDeadline(row({ end_time_s: null })).iso, '2026-09-25T12:00:00+08:00');
  assert.strictEqual(readDeadline(row({ end_time_s: '--', end_time: '--' })), null);
});

test('课堂标识：从 first_category_url 提取', () => {
  assert.strictEqual(classroomCodeFromPath('/classrooms/Abc-123_x/shixun_homework'), 'Abc-123_x');
  assert.strictEqual(classroomCodeFromPath(''), '');
  assert.strictEqual(classroomCodeFromPath(null), '');
});

test('课堂解析：结构完整才接受，缺标识/缺结束状态都抛错', () => {
  const classroom = parseClassroom({
    id: 7, name: '软件工程1班', is_end: false,
    first_category_url: '/classrooms/DEMO0001/announcement', can_visited: true
  });
  assert.strictEqual(classroom.code, 'DEMO0001');
  assert.strictEqual(classroom.name, '软件工程1班');
  assert.strictEqual(classroom.url, 'https://www.educoder.net/classrooms/DEMO0001/shixun_homework');

  assert.throws(() => parseClassroom({ id: 7, name: 'x', is_end: false, first_category_url: '/nope' }), HomeworkError);
  assert.throws(() => parseClassroom({ id: 7, name: 'x', first_category_url: '/classrooms/a/b' }), HomeworkError);
  assert.throws(() => parseClassroom({ id: '7', name: 'x', is_end: false, first_category_url: '/classrooms/a/b' }), HomeworkError);
  assert.throws(() => parseClassroom({ id: 7, name: '  ', is_end: false, first_category_url: '/classrooms/a/b' }), HomeworkError);
});

test('作业解析：两类作业用不同字段判完成，无法识别时保持 null', () => {
  const code = parseHomework(row({ shixun_finished_status: 1 }), CLASSROOM, 4, 'acct');
  assert.strictEqual(code.completed, true);
  assert.strictEqual(code.kindName, '课堂实验');

  const common = parseHomework(row({ un_commit_work: false }), CLASSROOM, 1, 'acct');
  assert.strictEqual(common.completed, true);
  assert.strictEqual(common.kindName, '图文作业');

  // 99 不是已知状态 → 「未知」，绝不能当成未完成。
  const unknown = parseHomework(row({ shixun_finished_status: 99 }), CLASSROOM, 4, 'acct');
  assert.strictEqual(unknown.completed, null);
});

test('作业解析：结构不合法一律抛错，拒绝静默存半份', () => {
  assert.throws(() => parseHomework(row({ homework_id: '100' }), CLASSROOM, 4, 'acct'), HomeworkError);
  assert.throws(() => parseHomework(row({ name: '' }), CLASSROOM, 4, 'acct'), HomeworkError);
  assert.throws(() => parseHomework(row({ is_archive: 'no' }), CLASSROOM, 4, 'acct'), HomeworkError);
  assert.throws(() => parseHomework(row({ status: '提交中' }), CLASSROOM, 4, 'acct'), HomeworkError);
  assert.throws(() => parseHomework(row(), null, 4, 'acct'), HomeworkError);
  assert.throws(() => parseHomework(row(), CLASSROOM, 9, 'acct'), HomeworkError);
});

test('身份键：同名作业在不同班级/账号下不冲突', () => {
  const a = parseHomework(row(), { ...CLASSROOM, code: 'AAA' }, 4, 'acct1');
  const b = parseHomework(row(), { ...CLASSROOM, code: 'BBB' }, 4, 'acct1');
  const c = parseHomework(row(), { ...CLASSROOM, code: 'AAA' }, 4, 'acct2');
  const d = parseHomework(row(), { ...CLASSROOM, code: 'AAA' }, 1, 'acct1');
  assert.strictEqual(new Set([homeworkKey(a), homeworkKey(b), homeworkKey(c), homeworkKey(d)]).size, 4);
  assert.strictEqual(homeworkKey(a), 'acct1|AAA|4|100');
});

test('提醒状态：归档/已完成/未知/未发布/无截止/逾期/待处理', () => {
  const make = (changes, kind = 4) => parseHomework(row(changes), CLASSROOM, kind, 'acct');

  assert.strictEqual(reminderState(make({ is_archive: true }), NOW), 'archived');
  assert.strictEqual(reminderState(make({ shixun_finished_status: 1 }), NOW), 'completed');
  assert.strictEqual(reminderState(make({ shixun_finished_status: 99 }), NOW), 'unknown_completion');
  assert.strictEqual(reminderState(make({ status: ['未发布'] }), NOW), 'unpublished');
  assert.strictEqual(reminderState(make({ publish_time: '2026-10-01 00:00' }), NOW), 'unpublished');
  assert.strictEqual(reminderState(make({ publish_time: null }), NOW), 'unknown_publication');
  assert.strictEqual(reminderState(make({ end_time_s: null, end_time: null }), NOW), 'no_deadline');
  assert.strictEqual(reminderState(make({ end_time_s: '2026-09-24 12:00:00', end_time: '2026-09-24 12:00:00' }), NOW), 'overdue');
  assert.strictEqual(reminderState(make(), NOW), 'pending');
});

test('提醒状态：缺少合法 nowMs 直接抛错（避免拿 NaN 判成「都过期」）', () => {
  const homework = parseHomework(row(), CLASSROOM, 4, 'acct');
  assert.throws(() => reminderState(homework, NaN), HomeworkError);
});
