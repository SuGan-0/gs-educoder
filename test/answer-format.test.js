'use strict';

/**
 * 答案格式 v2（answer-format）离线测试。
 *
 * 这个模块是答案契约的**唯一事实来源**，所以三条线都要锁住：
 *   ① 选择题最简写法（模型只输出这个）的解析；
 *   ② v1 旧文件能升级、且不丢信息；
 *   ③ 版本比本工具新时拒绝解析（不猜未来格式）。
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const fmt = require('../extractor/lib/answer-format');

test('levelIdOf / taskIndexOf：关卡号与序号互转', () => {
  assert.strictEqual(fmt.levelIdOf(1), 'L001');
  assert.strictEqual(fmt.levelIdOf(11), 'L011');
  assert.strictEqual(fmt.taskIndexOf('L011'), 11);
  assert.strictEqual(fmt.taskIndexOf('l7'), 7);
  assert.strictEqual(fmt.taskIndexOf('不是关卡号'), 0);
  assert.strictEqual(fmt.taskIndexOf(''), 0);
});

test('选择题：最简写法解析成结构化小问', () => {
  assert.deepStrictEqual(fmt.parseChoiceAnswer('B'), [{ number: 1, selected: ['B'] }]);
  assert.deepStrictEqual(fmt.parseChoiceAnswer('C,A'), [{ number: 1, selected: ['A', 'C'] }], '字母要升序去重');
  assert.deepStrictEqual(fmt.parseChoiceAnswer('a,c'), [{ number: 1, selected: ['A', 'C'] }]);
  assert.deepStrictEqual(
    fmt.parseChoiceAnswer('1:C;2:A,B'),
    [{ number: 1, selected: ['C'] }, { number: 2, selected: ['A', 'B'] }]
  );
  assert.deepStrictEqual(fmt.parseChoiceAnswer('1：A；2：B'), [{ number: 1, selected: ['A'] }, { number: 2, selected: ['B'] }], '全角分隔符');
  assert.deepStrictEqual(fmt.parseChoiceAnswer('AB'), [{ number: 1, selected: ['A', 'B'] }], '连写字母要拆开');
});

test('选择题：空值与非字母不产出小问', () => {
  for (const value of ['', '   ', null, undefined, '？？', '123']) {
    assert.deepStrictEqual(fmt.parseChoiceAnswer(value), []);
  }
});

test('选择题：结构化输入直接采用（已是 v2 形态时不再解析字符串）', () => {
  assert.deepStrictEqual(
    fmt.parseChoiceAnswer({ questions: [{ number: 2, selected: ['B'] }, { number: 1, selected: ['A'] }] }),
    [{ number: 2, selected: ['B'] }, { number: 1, selected: ['A'] }]
  );
  assert.deepStrictEqual(
    fmt.parseChoiceAnswer([{ number: 1, selected: ['D'] }]),
    [{ number: 1, selected: ['D'] }]
  );
});

test('选择题：结构化 → 最简写法（回给模型/人工看）', () => {
  assert.strictEqual(fmt.formatChoiceAnswer([{ number: 1, selected: ['A', 'C'] }]), 'A,C');
  assert.strictEqual(
    fmt.formatChoiceAnswer([{ number: 2, selected: ['B', 'D'] }, { number: 1, selected: ['A'] }]),
    '1:A;2:B,D',
    '要按题号排序'
  );
  assert.strictEqual(fmt.formatChoiceAnswer([]), '');
});

test('规范化：编程题（v1 的 language + answer 字符串）', () => {
  const entry = fmt.normalizeAnswer('L001', { kind: 'code', language: 'python', answer: 'print(1)' });
  assert.deepStrictEqual(entry, {
    level_id: 'L001',
    task_identifier: '',
    title: '',
    kind: 'code',
    source: 'unknown',
    verified: false,
    language: 'python',
    code: 'print(1)'
  });
});

test('规范化：v1 的 `answers: [{question, answer:[]}]` 也能读', () => {
  const entry = fmt.normalizeAnswer('L002', {
    kind: 'choice',
    answers: [{ question: 1, answer: ['A'] }, { question: 2, answer: ['B', 'D'] }]
  });
  assert.strictEqual(entry.kind, 'choice');
  assert.deepStrictEqual(entry.questions, [
    { number: 1, selected: ['A'] },
    { number: 2, selected: ['B', 'D'] }
  ]);
});

test('规范化：补上平台关卡标识、标题、来源与验证状态', () => {
  const entry = fmt.normalizeAnswer('L003', 'A', {
    kind: 'choice',
    taskIdentifier: 'glz47yx2f8vb',
    title: '欠拟合与过拟合',
    source: 'platform',
    verified: true
  });
  assert.strictEqual(entry.task_identifier, 'glz47yx2f8vb');
  assert.strictEqual(entry.title, '欠拟合与过拟合');
  assert.strictEqual(entry.source, 'platform');
  assert.strictEqual(entry.verified, true);
});

test('规范化：来源只接受白名单，非法值退成 unknown', () => {
  assert.strictEqual(fmt.normalizeAnswer('L001', { source: '随便写的' }).source, 'unknown');
  assert.strictEqual(fmt.normalizeAnswer('L001', { source: 'manual' }).source, 'manual');
});

test('落盘结构：编程题 answer 是对象，选择题是小问数组', () => {
  const code = fmt.toDocumentEntry(fmt.normalizeAnswer('L001', { kind: 'code', language: 'python', answer: 'x=1' }));
  assert.deepStrictEqual(code.answer, { language: 'python', code: 'x=1' });
  assert.strictEqual(code.level_id, 'L001');

  // 题型必须由调用方给出（关卡存档里就有），**不靠猜**：
  // 一个字符串答案既可能是代码也可能是选项字母，猜错会把编程题当成选择题。
  const choice = fmt.toDocumentEntry(fmt.normalizeAnswer('L002', '1:A;2:B,D', { kind: 'choice' }));
  assert.deepStrictEqual(choice.answer, {
    questions: [{ number: 1, selected: ['A'] }, { number: 2, selected: ['B', 'D'] }]
  });
});

test('文档：v1 升级到 v2，班级从 course 字符串取', () => {
  const document = fmt.normalizeDocument({
    course: '软件工程导论2026年下半年',
    experiment: 'CNN',
    generated_at: '2026-09-29T09:07:00.745Z',
    model: 'export',
    answers: [
      { level_id: 'L001', kind: 'choice', answer: '1:B;2:A' },
      { level_id: 'L002', kind: 'code', language: 'python', answer: 'print(1)' }
    ],
    unanswered: [{ level_id: 'L003', reason: '题干依赖图片' }]
  });

  assert.strictEqual(document.schema_version, 2);
  assert.strictEqual(document.classroom.name, '软件工程导论2026年下半年');
  assert.strictEqual(document.classroom.code, '', 'v1 没有课堂码，留空而不是编造');
  assert.strictEqual(document.experiment.name, 'CNN');
  assert.strictEqual(document.answers.length, 2);
  assert.strictEqual(document.answers[0].source, 'export', '文件级 model=export 应推断为抓取端导出');
  assert.strictEqual(document.answers[1].source, 'export');
  assert.deepStrictEqual(document.unanswered, [{ level_id: 'L003', reason: '题干依赖图片' }]);
});

test('文档：班级与实验缺字段时用调用方提供的补上（目录名里就有）', () => {
  const document = fmt.normalizeDocument(
    { answers: [] },
    { classroom: { name: '机器学习_2026年下半年', code: 'HCEAP94S' }, experiment: { name: 'CNN', homeworkId: 3965745 } }
  );
  assert.deepStrictEqual(document.classroom, { name: '机器学习_2026年下半年', code: 'HCEAP94S', id: 0 });
  assert.deepStrictEqual(document.experiment, { name: 'CNN', homework_id: 3965745 });
});

test('文档：v2 原样读回，版本比工具新时拒绝解析', () => {
  const v2 = {
    schema_version: 2,
    classroom: { name: 'A班', code: 'CODE1', id: 7 },
    experiment: { name: 'CNN', homework_id: 1 },
    answers: [{ level_id: 'L001', kind: 'choice', answer: { questions: [{ number: 1, selected: ['B'] }] } }]
  };
  const document = fmt.normalizeDocument(v2);
  assert.deepStrictEqual(document.classroom, { name: 'A班', code: 'CODE1', id: 7 });
  assert.deepStrictEqual(document.answers[0].questions, [{ number: 1, selected: ['B'] }]);

  assert.throws(
    () => fmt.normalizeDocument({ schema_version: 99, answers: [] }),
    fmt.AnswerFormatError,
    '不猜未来格式'
  );
});

test('文档：answers 写成「以关卡号为键」的旧写法也能读', () => {
  const document = fmt.normalizeDocument({
    answers: { L001: { kind: 'choice', answer: 'A' }, L002: { kind: 'code', language: 'go', answer: 'x' } }
  });
  assert.deepStrictEqual(document.answers.map((item) => item.level_id), ['L001', 'L002']);
});

test('文档：坏输入抛错而不是静默当成空', () => {
  for (const bad of [null, undefined, [], 'string']) {
    assert.throws(() => fmt.normalizeDocument(bad), fmt.AnswerFormatError);
  }
});

test('落盘：字符串化是稳定且可读的，且带 schema_version', () => {
  const document = fmt.emptyDocument({ name: 'A班', code: 'CODE1' }, { name: 'CNN', homeworkId: 1 });
  document.answers = [fmt.normalizeAnswer('L001', 'A', { kind: 'choice', taskIdentifier: 'abc', source: 'ai' })];
  const text = fmt.stringifyDocument(document);
  const parsed = JSON.parse(text);
  assert.strictEqual(parsed.schema_version, 2);
  assert.strictEqual(parsed.classroom.code, 'CODE1');
  assert.strictEqual(parsed.experiment.homework_id, 1);
  assert.strictEqual(parsed.answers[0].task_identifier, 'abc');
  assert.match(text, /\n$/, '文件以换行结尾');
});

test('路径：答案按班级分目录，班级码进目录名', () => {
  const root = path.join('E:', 'x', 'exports');
  const target = fmt.answerPathFor(root, { name: '机器学习_2026年下半年', code: 'HCEAP94S' }, { name: 'CNN' });
  assert.strictEqual(target, path.join(root, 'answers', '机器学习_2026年下半年（HCEAP94S）', 'CNN.answers.json'));
});

test('路径：没有课堂码时退化成只有班级名；非法字符被替换', () => {
  const root = path.join('E:', 'x');
  assert.strictEqual(
    fmt.answerPathFor(root, { name: 'A班' }, { name: 'CNN' }),
    path.join(root, 'answers', 'A班', 'CNN.answers.json')
  );
  assert.strictEqual(
    fmt.answerPathFor(root, { name: 'A/B', code: 'C:D' }, { name: 'E*F' }),
    path.join(root, 'answers', 'A～B（C～D）', 'E～F.answers.json')
  );
});

test('路径：旧位置仍能算出来（只读兼容用）', () => {
  const root = path.join('E:', 'x');
  assert.strictEqual(
    fmt.legacyAnswerPathFor(root, { name: 'A班' }, { name: 'CNN' }),
    path.join(root, 'answers', 'A班__CNN.answers.json')
  );
});
