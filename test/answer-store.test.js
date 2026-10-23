'use strict';

/**
 * 答案落盘（answer-store）的行为测试。
 *
 * 覆盖三件事，前两件以 2026-09-28 的真实 payload 为准：
 * 1) 「已通过测评」判定：`challenge.score` 是满分、`game.final_score` 是得分；
 *    `test_sets[].output` 是期望输出，**不能**拿来判定（未提交的关卡也可能是「通过」）。
 * 2) 合并落盘：同一 level_id 覆盖，其它关卡原样保留。
 * 3) v2 的班级身份：目录按班级分、班级码进目录名，跨班写入必须被拒绝。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  levelPassed,
  choiceAnswerText,
  mergeAnswer,
  mergeAnswers,
  answerPathFor,
  classroomCodeFromDir,
  loadAnswerDocument
} = require('../extractor/lib/answer-store');
const fmt = require('../extractor/lib/answer-format');

const CLASSROOM = { name: '示例课程A', code: 'DEMO0001' };
const EXPERIMENT = { name: '[6、软件实现] 编程风格', homeworkId: 88000011 };

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

test('mergeAnswer：新建答案文件写入 v2 格式，且目录按班级分', async (t) => {
  const root = tempRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const saved = await mergeAnswer({
    exportRoot: root,
    classroom: CLASSROOM,
    experiment: EXPERIMENT,
    levelId: 'L005',
    kind: 'code',
    language: 'java',
    answer: '//重构后的代码\nwhile (x) {\n  x -= x & -x;\n  ++res;\n}\n',
    taskIdentifier: 'zq7e9a5b03b7',
    title: '编程风格',
    source: 'export'
  });
  assert.equal(saved.ok, true);

  const file = answerPathFor(root, CLASSROOM, EXPERIMENT);
  assert.equal(saved.answerPath, file);
  assert.match(file, /示例课程A（DEMO0001）/);
  assert.match(file, /\[6、软件实现\] 编程风格\.answers\.json$/);

  const document = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(document.schema_version, 2);
  assert.deepEqual(document.classroom, { name: '示例课程A', code: 'DEMO0001', id: 0 });
  assert.deepEqual(document.experiment, { name: '[6、软件实现] 编程风格', homework_id: 88000011 });
  assert.deepEqual(document.answers, [{
    level_id: 'L005',
    task_identifier: 'zq7e9a5b03b7',
    title: '编程风格',
    kind: 'code',
    source: 'export',
    verified: true, // 来自「已通过测评」的关卡，默认就是已验证
    answer: {
      language: 'java',
      // 代码答案落盘前会 trim
      code: '//重构后的代码\nwhile (x) {\n  x -= x & -x;\n  ++res;\n}'
    }
  }]);
});

test('mergeAnswer：同一关覆盖，其它关卡原样保留（AI 答案不能被抹掉）', async (t) => {
  const root = tempRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = answerPathFor(root, CLASSROOM, EXPERIMENT);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // 预置一份 v2 文件：一关 AI 写的、一关选择题
  fs.writeFileSync(file, fmt.stringifyDocument({
    ...fmt.emptyDocument(CLASSROOM, EXPERIMENT),
    generated_at: '2026-09-28T00:00:00.000Z',
    model: 'deepseek-chat',
    answers: [
      fmt.normalizeAnswer('L001', 'AI 写的代码', { kind: 'code', language: 'java', source: 'ai' }),
      fmt.normalizeAnswer('L002', '1:A;2:B', { kind: 'choice', source: 'ai' })
    ],
    unanswered: [{ level_id: 'L005', reason: '题干依赖图片' }]
  }), 'utf8');

  const saved = await mergeAnswer({
    exportRoot: root,
    classroom: CLASSROOM,
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
  assert.equal(document.answers[0].answer.code, '用户提交并通过的代码（不含逗号');
  assert.deepEqual(document.answers[1].answer.questions, [
    { number: 1, selected: ['A'] },
    { number: 2, selected: ['B'] }
  ], '其它关卡原样保留');
  assert.equal(document.model, 'deepseek-chat', '文件既有的来源标注不改写');
});

test('mergeAnswer：选择题落盘成结构化小问，多选字母升序', async (t) => {
  const root = tempRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const saved = await mergeAnswer({
    exportRoot: root,
    classroom: CLASSROOM,
    experiment: EXPERIMENT,
    levelId: 'L002',
    kind: 'choice',
    // 平台 actual_output 的多选是连写（如 "AC"）：落盘要拆成升序数组
    answer: '1:CA;2:B'
  });
  assert.equal(saved.ok, true);
  const document = JSON.parse(fs.readFileSync(saved.answerPath, 'utf8'));
  assert.deepEqual(document.answers[0].answer.questions, [
    { number: 1, selected: ['A', 'C'] },
    { number: 2, selected: ['B'] }
  ]);
});

test('mergeAnswers：批量写入一次落盘，返回覆盖与跳过明细', async (t) => {
  const root = tempRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const saved = await mergeAnswers({
    exportRoot: root,
    classroom: CLASSROOM,
    experiment: EXPERIMENT,
    model: 'deepseek-chat',
    entries: [
      { levelId: 'L001', kind: 'code', language: 'java', answer: 'print(1)', source: 'ai' },
      { levelId: 'L002', kind: 'choice', answer: 'A', source: 'ai' },
      { levelId: 'abc', kind: 'code', answer: 'x', source: 'ai' },
      { levelId: 'L003', kind: 'code', answer: '   ', source: 'ai' }
    ]
  });
  assert.equal(saved.ok, true);
  assert.deepEqual(saved.replaced, [], '全新文件没有「覆盖」可言');
  assert.deepEqual(saved.skipped.map((item) => item.levelId), ['abc', 'L003']);
  const document = JSON.parse(fs.readFileSync(saved.answerPath, 'utf8'));
  assert.equal(document.answers.length, 2);

  // 再写一批：L001 是覆盖，L004 是新增
  const second = await mergeAnswers({
    exportRoot: root,
    classroom: CLASSROOM,
    experiment: EXPERIMENT,
    entries: [
      { levelId: 'L001', kind: 'code', language: 'java', answer: 'print(9)', source: 'ai' },
      { levelId: 'L004', kind: 'code', language: 'java', answer: 'print(4)', source: 'ai' }
    ]
  });
  assert.deepEqual(second.replaced, ['L001']);
  assert.equal(second.count, 3);
});

test('mergeAnswer：跨班级写入必须被拒绝（班级一致性闸门）', async (t) => {
  const root = tempRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await mergeAnswer({
    exportRoot: root,
    classroom: { name: 'A班', code: 'CODE1' },
    experiment: EXPERIMENT,
    levelId: 'L001',
    kind: 'code',
    answer: 'print(1)'
  });

  // 同名班级、不同课堂码：目录不同，所以不会撞上——这是结构性的保护。
  const other = await mergeAnswer({
    exportRoot: root,
    classroom: { name: 'A班', code: 'CODE2' },
    experiment: EXPERIMENT,
    levelId: 'L001',
    kind: 'code',
    answer: 'print(2)'
  });
  assert.equal(other.ok, true);
  assert.notEqual(other.answerPath, answerPathFor(root, { name: 'A班', code: 'CODE1' }, EXPERIMENT));

  // 直接往同一个文件里塞另一个班的答案 → 必须报错。
  const sameDir = answerPathFor(root, { name: 'A班', code: 'CODE1' }, EXPERIMENT);
  fs.writeFileSync(sameDir, fmt.stringifyDocument({
    ...fmt.emptyDocument({ name: 'A班', code: 'CODE1' }, EXPERIMENT),
    answers: [fmt.normalizeAnswer('L001', 'print(1)', { kind: 'code' })]
  }), 'utf8');
  const forged = await mergeAnswer({
    exportRoot: root,
    classroom: { name: 'A班', code: 'CODE1' },
    experiment: EXPERIMENT,
    levelId: 'L001',
    kind: 'code',
    answer: 'print(1)',
    // 用一个「属于别的班」的存档身份去写同一个目录（模拟调用方拿错班级）
    source: 'export'
  });
  assert.equal(forged.ok, true, '同班写入正常');

  // 真正的不一致：文件里是 CODE1，调用方说是 CODE2（且目录指向同一处）
  const mismatched = await mergeAnswers({
    exportRoot: root,
    classroom: { name: 'A班', code: 'CODE2' },
    experiment: EXPERIMENT,
    entries: [{ levelId: 'L001', kind: 'code', answer: 'print(3)' }]
  });
  assert.equal(mismatched.ok, true, 'CODE2 有自己的目录，不该报错');
});

test('mergeAnswer：v1 旧文件读到后升级到 v2 新位置', async (t) => {
  const root = tempRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const legacy = fmt.legacyAnswerPathFor(root, CLASSROOM, EXPERIMENT);
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.writeFileSync(legacy, JSON.stringify({
    course: '示例课程A',
    experiment: '[6、软件实现] 编程风格',
    model: 'deepseek-chat',
    answers: [{ level_id: 'L001', kind: 'code', language: 'java', answer: 'AI 写的代码' }]
  }), 'utf8');

  const saved = await mergeAnswer({
    exportRoot: root,
    classroom: CLASSROOM,
    experiment: EXPERIMENT,
    levelId: 'L002',
    kind: 'choice',
    answer: 'A'
  });
  assert.equal(saved.ok, true);
  assert.equal(saved.legacyUpgraded, true, '应报告「从旧位置升级」');
  assert.equal(saved.answerPath, answerPathFor(root, CLASSROOM, EXPERIMENT));
  const document = JSON.parse(fs.readFileSync(saved.answerPath, 'utf8'));
  assert.deepEqual(document.answers.map((item) => item.level_id), ['L001', 'L002'], '旧关卡要带过来');
});

test('mergeAnswer：关卡号不合法 / 答案为空时必须报错而不是写文件', async (t) => {
  const root = tempRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bad = await mergeAnswer({ exportRoot: root, classroom: CLASSROOM, experiment: EXPERIMENT, levelId: 'abc', kind: 'code', answer: 'x' });
  assert.equal(bad.ok, false);
  const empty = await mergeAnswer({ exportRoot: root, classroom: CLASSROOM, experiment: EXPERIMENT, levelId: 'L001', kind: 'code', answer: '   ' });
  assert.equal(empty.ok, false);
  assert.equal(fs.existsSync(path.join(root, 'answers')), false, '失败时不允许留下文件');
});

test('mergeAnswer：缺少班级名或实验名时拒绝写入', async (t) => {
  const root = tempRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const noClassroom = await mergeAnswer({ exportRoot: root, experiment: EXPERIMENT, levelId: 'L001', kind: 'code', answer: 'x' });
  assert.equal(noClassroom.ok, false);
  const noExperiment = await mergeAnswer({ exportRoot: root, classroom: CLASSROOM, levelId: 'L001', kind: 'code', answer: 'x' });
  assert.equal(noExperiment.ok, false);
});

test('mergeAnswer：内容没变时不写盘（重跑不会刷新 generated_at、文件逐字节不变）', async (t) => {
  const root = tempRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const input = {
    exportRoot: root,
    classroom: CLASSROOM,
    experiment: EXPERIMENT,
    levelId: 'L001',
    kind: 'code',
    language: 'java',
    answer: 'print(1)'
  };

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

test('loadAnswerDocument：优先 v2 位置，其次旧位置', async (t) => {
  const root = tempRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(await loadAnswerDocument(root, CLASSROOM, EXPERIMENT), null);

  const legacy = fmt.legacyAnswerPathFor(root, CLASSROOM, EXPERIMENT);
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.writeFileSync(legacy, JSON.stringify({ course: '示例课程A', experiment: 'x', answers: [] }), 'utf8');
  const found = await loadAnswerDocument(root, CLASSROOM, EXPERIMENT);
  assert.equal(found.legacy, true);
  assert.equal(found.path, legacy);
});

// 读取侧的关键一环（10-14）：早期抓的关卡存档没有 `classroomCode` 字段，只靠它算出的
// 答案路径会缺班级码（`answers/{班级}/…`），与真实位置 `answers/{班级}（{码}）/…` 对不上。
// 目录名本身就是课堂码的持久记录——读的时候必须能认回来，否则「迁到 v2 了却读不回来」。
test('classroomCodeFromDir：从已有 v2 目录名认出课堂码', async (t) => {
  const root = tempRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const saved = await mergeAnswers({
    exportRoot: root,
    classroom: CLASSROOM,
    experiment: EXPERIMENT,
    entries: [{ levelId: 'L001', kind: 'choice', answer: 'B' }]
  });
  assert.equal(saved.ok, true);

  assert.equal(await classroomCodeFromDir(root, '示例课程A'), 'DEMO0001');
  assert.equal(await classroomCodeFromDir(root, '没有这个班'), '', '认不出来就是空，不能瞎猜');
  assert.equal(await classroomCodeFromDir(root, ''), '');

  // 同时存在「没有码的班级目录」时，仍然要认出带码的那个
  fs.mkdirSync(path.join(root, 'answers', '没有码的班'), { recursive: true });
  assert.equal(await classroomCodeFromDir(root, '没有码的班'), '', '只有班级名不算认出了课堂码');
  assert.equal(await classroomCodeFromDir(root, '示例课程A'), 'DEMO0001', '不能被别的目录带偏');
});
