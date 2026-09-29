'use strict';

/**
 * 答案落盘（answer-store）的行为测试。
 *
 * 覆盖两件事，两者都以 2026-09-28 的真实 payload 为准：
 * 1) 「已通过测评」判定：`challenge.score` 是满分、`game.final_score` 是得分；
 *    `test_sets[].output` 是期望输出，**不能**拿来判定（未提交的关卡也可能是「通过」）。
 * 2) 合并落盘：同一 level_id 覆盖，其它关卡与文件里已有的写法原样保留。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { levelPassed, choiceAnswerText, mergeAnswer, answerPathFor } = require('../extractor/lib/answer-store');

const COURSE = '示例课程A';
const EXPERIMENT = '[6、软件实现] 编程风格';

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'touge-answers-'));
}

test('levelPassed：满分才算通过（含未提交的对照组）', () => {
  // 编程风格 L001：已提交且满分通过
  assert.equal(levelPassed({ challenge: { score: 100 }, game: { final_score: 100 } }), true);
  // 选择题：满分 = 每题 10 分 × 题数（6 题 60 分）
  assert.equal(levelPassed({ challenge: { score: 60 }, game: { final_score: 60 } }), true);
  // 高质量的代码 L001：未提交（final_score=0），即使 test_sets 的 output 写着「通过」也不算
  assert.equal(
    levelPassed({
      challenge: { score: 100 },
      game: { final_score: 0 },
      test_sets: [{ result: null, output: '通过' }]
    }),
    false,
    'output 是测试点的期望输出，不能作为通过判据'
  );
  // 没有 game / 满分缺失时一律不算通过（宁可不导出，也不写错答案）
  assert.equal(levelPassed({ challenge: { score: 100 } }), false);
  assert.equal(levelPassed({ challenge: { score: 0 }, game: { final_score: 0 } }), false);
});

test('choiceAnswerText：按 position 排序、优先 standard_answer、多选保持原样', () => {
  const payload = {
    choose_test_cases: {
      had_submmit: true,
      test_sets: [
        { position: 3, actual_output: 'A', standard_answer: 'C' },
        { position: 1, actual_output: 'D', standard_answer: null },
        { position: 2, actual_output: 'B', standard_answer: 'AB' }
      ]
    }
  };
  assert.equal(choiceAnswerText(payload), '1:D;2:AB;3:C');
  assert.equal(choiceAnswerText({}), '', '没有 choose_test_cases 时返回空串');
});

test('mergeAnswer：新建答案文件写入规范格式', async (t) => {
  const root = tempRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const saved = await mergeAnswer({
    exportRoot: root,
    course: COURSE,
    experiment: EXPERIMENT,
    levelId: 'L005',
    kind: 'code',
    language: 'java',
    answer: '//重构后的代码\nwhile (x) {\n  x -= x & -x;\n  ++res;\n}\n'
  });
  assert.equal(saved.ok, true);
  const file = path.join(root, 'answers', `${COURSE}__${EXPERIMENT}.answers.json`);
  assert.equal(saved.answerPath, file);
  const document = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(document.course, COURSE);
  assert.equal(document.experiment, EXPERIMENT);
  assert.equal(document.model, 'export');
  assert.deepEqual(document.answers, [{
    level_id: 'L005',
    kind: 'code',
    language: 'java',
    // 代码答案在落盘前会 trim（与 normalizeAnswer 的既有行为一致），这里也按 trim 后的结果断言
    answer: '//重构后的代码\nwhile (x) {\n  x -= x & -x;\n  ++res;\n}'
  }]);
});

test('mergeAnswer：同一关覆盖，其它关卡的答案与写法原样保留（AI 答案不能被抹掉）', async (t) => {
  const root = tempRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = answerPathFor(root, COURSE, EXPERIMENT);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    course: COURSE,
    experiment: EXPERIMENT,
    generated_at: '2026-09-28T00:00:00.000Z',
    model: 'deepseek-chat',
    answers: [
      { level_id: 'L001', kind: 'code', language: 'java', answer: 'AI 写的代码' },
      { level_id: 'L002', kind: 'choice', answer: '1:A;2:B' }
    ],
    unanswered: [{ level_id: 'L005', reason: '题干依赖图片' }]
  }, null, 2), 'utf8');

  const saved = await mergeAnswer({
    exportRoot: root,
    course: COURSE,
    experiment: EXPERIMENT,
    levelId: 'L001',
    kind: 'code',
    language: 'java',
    answer: '用户提交并通过的代码（不含逗号' // 故意带括号，验证不被二次解析
  });
  assert.equal(saved.ok, true);
  assert.equal(saved.replaced, true);
  const document = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(document.answers.length, 2, '只覆盖同一关，不新增条目');
  assert.equal(document.answers[0].answer, '用户提交并通过的代码（不含逗号');
  assert.equal(document.answers[1].answer, '1:A;2:B', '其它关卡原样保留');
  assert.equal(document.model, 'deepseek-chat', '文件既有的来源标注不改写');
});

test('mergeAnswer：选择题答案归一成「字母升序、逗号分隔」', async (t) => {
  const root = tempRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const saved = await mergeAnswer({
    exportRoot: root,
    course: COURSE,
    experiment: EXPERIMENT,
    levelId: 'L002',
    kind: 'choice',
    answer: '1:CA;2:B' // 平台 actual_output 的多选是连写（如 "AC"）：落盘要规范成 "A,C"
  });
  assert.equal(saved.ok, true);
  const document = JSON.parse(fs.readFileSync(saved.answerPath, 'utf8'));
  assert.equal(document.answers[0].answer, '1:A,C;2:B');
});

test('mergeAnswer：关卡号不合法 / 答案为空时必须报错而不是写文件', async (t) => {
  const root = tempRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bad = await mergeAnswer({ exportRoot: root, course: COURSE, experiment: EXPERIMENT, levelId: 'abc', kind: 'code', answer: 'x' });
  assert.equal(bad.ok, false);
  const empty = await mergeAnswer({ exportRoot: root, course: COURSE, experiment: EXPERIMENT, levelId: 'L001', kind: 'code', answer: '   ' });
  assert.equal(empty.ok, false);
  assert.equal(fs.existsSync(path.join(root, 'answers')), false, '失败时不允许留下文件');
});

test('mergeAnswer：内容没变时不写盘（重跑不会刷新 generated_at、文件逐字节不变）', async (t) => {
  const root = tempRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const input = { exportRoot: root, course: COURSE, experiment: EXPERIMENT, levelId: 'L001', kind: 'code', language: 'java', answer: 'print(1)' };

  const created = await mergeAnswer(input);
  assert.equal(created.changed, true, '首次写入必须落盘');
  const file = created.answerPath;
  const before = fs.readFileSync(file, 'utf8');

  // 同一份答案再写一次：不能写盘。否则重跑同一门课时，答案文件只有 generated_at 变了，
  // 但 mtime/哈希都变，看起来像"又把整门课抓了一遍"（实测就是这个现象）。
  const again = await mergeAnswer(input);
  assert.equal(again.ok, true);
  assert.equal(again.changed, false, '内容没变就不该写盘');
  assert.equal(fs.readFileSync(file, 'utf8'), before, '文件必须逐字节不变（含 generated_at）');

  // 答案真的变了：必须写
  const changed = await mergeAnswer({ ...input, answer: 'print(2)' });
  assert.equal(changed.changed, true, '答案变化必须落盘');
  assert.match(fs.readFileSync(file, 'utf8'), /print\(2\)/);
});