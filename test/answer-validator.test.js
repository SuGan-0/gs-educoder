/**
 * 答案校验：每关都有答案、题型对得上、选项字母不越界、代码不是占位文本。
 *
 * 运行：node --test test/answer-validator.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { validateAnswers, validateAnswerDocument } = require('../extractor/lib/answer-validator');
const { appendLevel, toArchiveRecord } = require('../extractor/lib/level-store');

const CODE_LEVEL = {
  taskIndex: 1,
  title: 'conv',
  type: 'code',
  codeLanguage: 'python',
  starterCode: 'def f():\n    ########## begin ##########\n    pass\n    ########## end ##########',
  choiceQuestions: []
};

const CHOICE_LEVEL = {
  taskIndex: 2,
  title: '选择题',
  type: 'choice',
  codeLanguage: '',
  starterCode: '',
  choiceQuestions: [
    { subject: '第一题？', options: ['甲', '乙', '丙'] },
    { subject: '第二题？', options: ['甲', '乙'] }
  ]
};

test('validateAnswers：全部正确时通过', () => {
  const report = validateAnswers({
    levels: [CODE_LEVEL, CHOICE_LEVEL],
    answers: [
      {
        level_id: 'L001',
        kind: 'code',
        language: 'python',
        answer: 'def f():\n    ########## begin ##########\n    return 1\n    ########## end ##########'
      },
      { level_id: 'L002', kind: 'choice', answer: '1:C;2:B' }
    ]
  });
  assert.equal(report.ok, true, JSON.stringify(report.issues));
  assert.equal(report.covered, 2);
  assert.equal(report.total, 2);
});

test('validateAnswers：缺答案 / 题型不符 / 字母越界 / 占位代码 / 缺框架标记 都能报出来', () => {
  const report = validateAnswers({
    levels: [CODE_LEVEL, CHOICE_LEVEL],
    answers: [
      { level_id: 'L001', kind: 'code', language: 'python', answer: '完整代码（保留题目给的框架与 begin/end 标记）' },
      { level_id: 'L002', kind: 'code', answer: 'print(1)' }
    ]
  });
  const codes = report.issues.map((issue) => issue.code);
  assert.equal(report.ok, false);
  assert.ok(codes.includes('placeholder'), `应报占位文本，实际 ${codes.join(',')}`);
  assert.ok(codes.includes('kind-mismatch'), `应报题型不符，实际 ${codes.join(',')}`);
});

test('validateAnswers：选择题少答一题、字母越界要分别报出来', () => {
  const report = validateAnswers({
    levels: [CHOICE_LEVEL],
    answers: { L002: { kind: 'choice', answer: '1:D' } } // 第 1 题只有 A-C；第 2 题没答
  });
  const codes = report.issues.map((issue) => issue.code);
  assert.ok(codes.includes('letter-out-of-range'), `应报选项越界，实际 ${codes.join(',')}`);
  assert.ok(codes.includes('missing-question'), `应报漏答小问，实际 ${codes.join(',')}`);
});

test('validateAnswers：缺关卡答案要报 missing', () => {
  const report = validateAnswers({
    levels: [CODE_LEVEL, CHOICE_LEVEL],
    answers: {
      L001: {
        kind: 'code',
        language: 'python',
        answer: 'def f():\n    ########## begin ##########\n    return 1\n    ########## end ##########'
      }
    }
  });
  assert.deepEqual(report.issues.map((issue) => issue.code), ['missing']);
  assert.equal(report.covered, 1);
});

test('tools/validate-answers.js：集中目录里的答案能通过，course/experiment 不一致要报错', (t) => {
  const exportRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'touge-valid-'));
  const experimentDir = path.join(exportRoot, '课程A', '实验B');
  const answerDir = path.join(exportRoot, 'answers');
  fs.mkdirSync(experimentDir, { recursive: true });
  fs.mkdirSync(answerDir, { recursive: true });

  // 存档：一关编程题
  return appendLevel(
    path.join(experimentDir, 'levels.jsonl'),
    toArchiveRecord(
      {
        taskIndex: 1,
        title: 'conv',
        level: '第1关_conv',
        type: 'code',
        course: '课程A',
        experiment: '实验B',
        source: 'u',
        taskDescription: '实现卷积。',
        programmingRequirements: '补充代码。',
        testCase: '',
        starterCode: 'def f():\n    ########## begin ##########\n    pass\n    ########## end ##########',
        codeLanguage: 'python',
        choices: [],
        choiceQuestions: [],
        imageMap: {},
        images: []
      },
      'h1'
    )
  ).then(() => {
    t.after(() => fs.rmSync(exportRoot, { recursive: true, force: true }));

    const run = () =>
      execFileSync(process.execPath, [path.join(__dirname, '..', 'tools', 'validate-answers.js')], {
        encoding: 'utf8',
        env: { ...process.env, EDUCODER_EXPORT_ROOT: exportRoot }
      });
    const runFailing = () => {
      try {
        run();
        return { status: 0, out: '' };
      } catch (error) {
        return { status: error.status, out: String(error.stdout || '') };
      }
    };

    // ① 没有答案文件 → 报「缺答案」，退出码 1
    const missing = runFailing();
    assert.equal(missing.status, 1);
    assert.match(missing.out, /缺答案.*课程A \/ 实验B/);
    assert.match(
      missing.out,
      /answers[\\/]课程A[\\/]实验B\.answers\.json/,
      '要指出期望的路径（v2：按班级分目录）'
    );

    // ② 放一份正确答案 → 通过。v2：班级是对象，答案是结构化对象。
    const v2File = path.join(answerDir, '课程A', '实验B.answers.json');
    fs.mkdirSync(path.dirname(v2File), { recursive: true });
    const writeAnswer = (classroomName) => fs.writeFileSync(v2File, JSON.stringify({
      schema_version: 2,
      classroom: { name: classroomName, code: '' },
      experiment: { name: '实验B', homework_id: 0 },
      answers: [
        {
          level_id: 'L001',
          task_identifier: 'abc',
          title: 'conv',
          kind: 'code',
          source: 'ai',
          answer: {
            language: 'python',
            code: 'def f():\n    ########## begin ##########\n    return 1\n    ########## end ##########'
          }
        }
      ]
    }), 'utf8');
    writeAnswer('课程A');

    const ok = run();
    assert.match(ok, /通过\s+课程A \/ 实验B：1\/1 关有答案（answers[\\/]课程A[\\/]实验B\.answers\.json）/);

    // ③ 班级名写错 → 报不一致
    writeAnswer('别的课程');
    const mismatch = runFailing();
    assert.equal(mismatch.status, 1);
    assert.match(mismatch.out, /course-mismatch/);
  });
});

function standaloneDocument() {
  return {
    schema_version: 2, classroom: { name: '数据库', code: 'DB1' }, experiment: { name: 'DML', homework_id: 12 },
    answers: [
      { level_id: 'L001', task_identifier: 'sql-id', title: '插入', kind: 'code', source: 'export', verified: true, answer: { language: 'sql', code: 'INSERT INTO t VALUES (1);' } },
      { level_id: 'L002', task_identifier: 'choice-id', title: '选择', kind: 'choice', source: 'ai', verified: false, answer: { questions: [{ number: 1, selected: ['A', 'C'] }, { number: 2, selected: ['B'] }] } }
    ], unanswered: []
  };
}

test('validateAnswers：原始 v2 嵌套选择答案不会把对象转成字母误报', () => {
  const report = validateAnswers({ levels: [CHOICE_LEVEL], answers: [{
    level_id: 'L002', kind: 'choice', answer: { questions: [{ number: 1, selected: ['A', 'C'] }, { number: 2, selected: ['B'] }] }
  }] });
  assert.equal(report.ok, true, JSON.stringify(report.issues));
});

test('validateAnswerDocument：无题目仍检查重复关卡/小问、原始非法选项、题型和验证标记', () => {
  const document = standaloneDocument();
  document.answers[0].verified = 'false';
  document.answers[1].answer.questions.push({ number: 1, selected: ['A', '9'] });
  document.answers.push({ level_id: 'L001', kind: 'unknown', task_identifier: '' });
  const report = validateAnswerDocument(document, { standalone: true });
  const codes = report.issues.map((issue) => issue.code);
  for (const expected of ['invalid-verified', 'duplicate-level', 'duplicate-question', 'invalid-selection', 'invalid-kind', 'missing-identifier']) assert.ok(codes.includes(expected), expected);
});

function runValidator(root, ...filters) {
  try {
    return { status: 0, output: execFileSync(process.execPath, [path.join(__dirname, '..', 'tools', 'validate-answers.js'), ...filters], { encoding: 'utf8', env: { ...process.env, EDUCODER_EXPORT_ROOT: root } }) };
  } catch (error) {
    return { status: error.status, output: String(error.stdout || '') + String(error.stderr || '') };
  }
}

test('tools/validate-answers.js：仅答案混合题实际校验，明确没有题干不能核对正确性', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'touge-only-valid-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'answers', '数据库（DB1）', 'DML.answers.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const document = standaloneDocument();
  fs.writeFileSync(file, JSON.stringify(document));
  const valid = runValidator(root, '数据库', 'DML');
  assert.equal(valid.status, 0, valid.output);
  assert.match(valid.output, /2\/2 关有答案/);
  assert.match(valid.output, /没有题目存档.*答案正确性/);
  document.answers[1].answer.questions[0].selected.push('9');
  fs.writeFileSync(file, JSON.stringify(document));
  const invalid = runValidator(root);
  assert.equal(invalid.status, 1);
  assert.match(invalid.output, /invalid-selection/);
});

test('tools/validate-answers.js：损坏/未来答案文件不能被目录扫描忽略成通过', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'touge-invalid-doc-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'answers', '数据库（DB1）', 'DML.answers.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (const original of ['{broken', JSON.stringify({ ...standaloneDocument(), schema_version: 99 })]) {
    fs.writeFileSync(file, original);
    const result = runValidator(root, '数据库', 'DML');
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /答案坏/);
    assert.equal(fs.readFileSync(file, 'utf8'), original);
  }
});

test('tools/validate-answers.js：仅答案正文课堂码必须与目录身份一致，没有目标不能称通过', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'touge-identity-valid-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const empty = runValidator(root);
  assert.equal(empty.status, 1);
  assert.match(empty.output, /未执行校验/);
  const file = path.join(root, 'answers', '数据库（DB1）', 'DML.answers.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const document = standaloneDocument();
  document.classroom.code = 'OTHER';
  fs.writeFileSync(file, JSON.stringify(document));
  const mismatch = runValidator(root);
  assert.equal(mismatch.status, 1, mismatch.output);
  assert.match(mismatch.output, /classroom-code-mismatch/);
});
