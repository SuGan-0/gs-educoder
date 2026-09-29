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

const { validateAnswers } = require('../extractor/lib/answer-validator');
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
    assert.match(missing.out, /answers\/课程A__实验B\.answers\.json/, '要指出期望的文件名（带课程与实验）');

    // ② 放一份正确答案 → 通过
    fs.writeFileSync(
      path.join(answerDir, '课程A__实验B.answers.json'),
      JSON.stringify({
        course: '课程A',
        experiment: '实验B',
        answers: [
          {
            level_id: 'L001',
            kind: 'code',
            language: 'python',
            answer: 'def f():\n    ########## begin ##########\n    return 1\n    ########## end ##########'
          }
        ]
      }),
      'utf8'
    );
    const ok = run();
    assert.match(ok, /通过\s+课程A \/ 实验B：1\/1 关有答案（answers[\\/]课程A__实验B\.answers\.json）/);

    // ③ course 写错 → 报不一致
    fs.writeFileSync(
      path.join(answerDir, '课程A__实验B.answers.json'),
      JSON.stringify({
        course: '别的课程',
        experiment: '实验B',
        answers: [
          {
            level_id: 'L001',
            kind: 'code',
            language: 'python',
            answer: 'def f():\n    ########## begin ##########\n    return 1\n    ########## end ##########'
          }
        ]
      }),
      'utf8'
    );
    const mismatch = runFailing();
    assert.equal(mismatch.status, 1);
    assert.match(mismatch.out, /course-mismatch/);
  });
});
