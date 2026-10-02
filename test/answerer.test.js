/**
 * AI 作答链路：列目标 → 调模型（注入假模型）→ 写集中答案文件 → 自校验。
 *
 * 运行：node --test test/answerer.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { listTargets, answerExperiment, parseModelJson } = require('../extractor/lib/answerer');
const { appendLevel, toArchiveRecord } = require('../extractor/lib/level-store');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'touge-answer-'));
}

function seedExperiment(exportRoot, course, experiment, levels) {
  const dir = path.join(exportRoot, course, experiment);
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  for (const record of levels) {
    fs.appendFileSync(path.join(dir, 'levels.jsonl'), `${JSON.stringify(record)}\n`, 'utf8');
  }
  return dir;
}

const CODE_LEVEL = () =>
  toArchiveRecord(
    {
      taskIndex: 1,
      title: 'conv',
      level: '第1关_conv',
      type: 'code',
      course: '课程A',
      experiment: '实验B',
      source: 'https://www.educoder.net/tasks/a',
      taskDescription: '实现卷积。',
      programmingRequirements: '补充代码。',
      starterCode: 'def f():\n    ########## begin ##########\n    pass\n    ########## end ##########',
      codeLanguage: 'python',
      choices: [],
      choiceQuestions: [],
      imageMap: {},
      images: []
    },
    'h1'
  );

const CHOICE_LEVEL = () =>
  toArchiveRecord(
    {
      taskIndex: 2,
      title: '选择题',
      level: '第2关_选择题',
      type: 'choice',
      course: '课程A',
      experiment: '实验B',
      source: 'https://www.educoder.net/tasks/b',
      taskDescription: '',
      programmingRequirements: '',
      starterCode: '',
      codeLanguage: '',
      choices: [],
      choiceQuestions: [{ subject: '第一题？', options: ['甲', '乙', '丙'] }],
      imageMap: {},
      images: []
    },
    'h2'
  );

test('parseModelJson：容忍 ```json 围栏与前后说明文字', () => {
  assert.deepEqual(parseModelJson('{"answers":[]}'), { answers: [] });
  assert.deepEqual(parseModelJson('```json\n{"answers":[]}\n```'), { answers: [] });
  assert.deepEqual(parseModelJson('好的，答案如下：\n{"answers":[]}\n以上就是答案'), { answers: [] });
  assert.throws(() => parseModelJson('没有 JSON'), /不是合法 JSON/);
});

test('listTargets：从关卡存档列课程/实验/关卡，并带上「已有答案几关」', async (t) => {
  const exportRoot = tmpDir();
  t.after(() => fs.rmSync(exportRoot, { recursive: true, force: true }));
  seedExperiment(exportRoot, '课程A', '实验B', [CODE_LEVEL(), CHOICE_LEVEL()]);
  // v2 位置：answers/{班级}/{实验}.answers.json
  const answerFile = path.join(exportRoot, 'answers', '课程A', '实验B.answers.json');
  fs.mkdirSync(path.dirname(answerFile), { recursive: true });
  fs.writeFileSync(answerFile, JSON.stringify({
    schema_version: 2,
    classroom: { name: '课程A', code: '' },
    experiment: { name: '实验B', homework_id: 0 },
    answers: [{ level_id: 'L001', kind: 'code', answer: { language: 'python', code: 'x' } }]
  }), 'utf8');

  const courses = await listTargets(exportRoot);
  assert.equal(courses.length, 1);
  assert.equal(courses[0].name, '课程A');
  const experiment = courses[0].experiments[0];
  assert.equal(experiment.name, '实验B');
  assert.equal(experiment.levelCount, 2);
  assert.equal(experiment.answered, 1, '应数出已有答案的关卡数');
  assert.deepEqual(experiment.levels.map((level) => level.id), ['L001', 'L002']);
  assert.equal(experiment.levels[1].type, 'choice');
});

test('answerExperiment：调模型 → 答案写到 exports/answers/课程__实验.answers.json → 自校验', async (t) => {
  const exportRoot = tmpDir();
  t.after(() => fs.rmSync(exportRoot, { recursive: true, force: true }));
  seedExperiment(exportRoot, '课程A', '实验B', [CODE_LEVEL(), CHOICE_LEVEL()]);

  let sawSystem = '';
  let sawUser = '';
  const result = await answerExperiment({
    exportRoot,
    course: '课程A',
    experiment: '实验B',
    apiKey: 'test-key',
    model: 'fake-model',
    callModel: async ({ system, user }) => {
      sawSystem = system;
      sawUser = user;
      return JSON.stringify({
        answers: [
          {
            level_id: 'L001',
            kind: 'code',
            language: 'python',
            answer: 'def f():\n    ########## begin ##########\n    return 1\n    ########## end ##########'
          },
          { level_id: 'L002', kind: 'choice', answer: 'C' }
        ]
      });
    }
  });

  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.equal(result.answered, 2);
  assert.ok(
    result.answerPath.endsWith(path.join('answers', '课程A', '实验B.answers.json')),
    `答案要按班级分目录，实际：${result.answerPath}`
  );

  const document = JSON.parse(fs.readFileSync(result.answerPath, 'utf8'));
  assert.equal(document.schema_version, 2);
  assert.equal(document.classroom.name, '课程A');
  assert.equal(document.experiment.name, '实验B');
  assert.equal(document.model, 'fake-model');
  assert.equal(document.answers.length, 2);
  // 模型输出最简写法（"C"），落盘是结构化小问——转换是确定性的代码，不交给模型
  assert.deepEqual(document.answers[1].answer, { questions: [{ number: 1, selected: ['C'] }] });
  assert.equal(document.answers[1].source, 'ai');
  assert.equal(document.answers[0].kind, 'code');
  assert.deepEqual(document.answers[0].answer, {
    language: 'python',
    code: 'def f():\n    ########## begin ##########\n    return 1\n    ########## end ##########'
  });

  // 提示词里必须带题目正文与关卡 id，模型才知道考什么
  assert.match(sawUser, /实现卷积|第1关/);
  assert.match(sawUser, /L001/);
  assert.match(sawSystem, /level_id/, 'system 提示词要说明输出格式');
});

test('answerExperiment：md 里的 data URI 图片要剥离，避免撑爆文本模型的 prompt', async (t) => {
  const exportRoot = tmpDir();
  t.after(() => fs.rmSync(exportRoot, { recursive: true, force: true }));
  const dir = seedExperiment(exportRoot, '课程A', '实验B', [CODE_LEVEL()]);
  // 手工写一份带 data URI 图片的 md（等价于 EDUCODER_INLINE_IMAGES=1 抓出来的产物）
  fs.writeFileSync(
    path.join(dir, '实验B.md'),
    '## 第1关：conv\n\n实现卷积。\n\n![题目图片](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==)\n',
    'utf8'
  );

  let sawUser = '';
  await answerExperiment({
    exportRoot,
    course: '课程A',
    experiment: '实验B',
    apiKey: 'k',
    model: 'fake-model',
    callModel: async ({ user }) => {
      sawUser = user;
      return JSON.stringify({ answers: [{ level_id: 'L001', kind: 'code', language: 'python', answer: 'return 1' }] });
    }
  });

  assert.ok(!sawUser.includes('data:image'), 'data URI 绝不能进 prompt');
  assert.ok(!sawUser.includes('base64'), 'base64 不能残留');
  assert.match(sawUser, /图片：题目图片/, '应替换成「图片」占位，告诉模型这里有图');
  assert.match(sawUser, /实现卷积/, '正文必须保留');
});

test('answerExperiment：只答指定关卡，模型多答的关卡被丢弃', async (t) => {
  const exportRoot = tmpDir();
  t.after(() => fs.rmSync(exportRoot, { recursive: true, force: true }));
  seedExperiment(exportRoot, '课程A', '实验B', [CODE_LEVEL(), CHOICE_LEVEL()]);

  const result = await answerExperiment({
    exportRoot,
    course: '课程A',
    experiment: '实验B',
    apiKey: 'k',
    onlyLevelIds: ['L002'],
    callModel: async () =>
      JSON.stringify({
        answers: [
          { level_id: 'L001', kind: 'code', language: 'python', answer: '不该出现' },
          { level_id: 'L002', kind: 'choice', answer: 'A' }
        ]
      })
  });

  const document = JSON.parse(fs.readFileSync(result.answerPath, 'utf8'));
  assert.deepEqual(document.answers.map((item) => item.level_id), ['L002'], '只保留范围内的关卡');
  assert.equal(result.total, 1);
  assert.equal(result.ok, true);
});

test('answerExperiment：答案不合规时 self-check 要报出来（但仍写文件便于人工修）', async (t) => {
  const exportRoot = tmpDir();
  t.after(() => fs.rmSync(exportRoot, { recursive: true, force: true }));
  seedExperiment(exportRoot, '课程A', '实验B', [CODE_LEVEL(), CHOICE_LEVEL()]);

  const result = await answerExperiment({
    exportRoot,
    course: '课程A',
    experiment: '实验B',
    apiKey: 'k',
    callModel: async () =>
      JSON.stringify({
        answers: [
          { level_id: 'L001', kind: 'code', language: 'python', answer: '完整代码（保留题目给的框架与 begin/end 标记）' },
          { level_id: 'L002', kind: 'choice', answer: 'Z' }
        ]
      })
  });

  assert.equal(result.ok, false);
  const codes = result.issues.map((issue) => issue.code);
  assert.ok(codes.includes('placeholder'), codes.join(','));
  assert.ok(codes.includes('letter-out-of-range'), codes.join(','));
  assert.ok(fs.existsSync(result.answerPath), '即使有问题也要留下文件，方便人工修或重跑');
});

test('answerExperiment：没有存档要明确报错', async (t) => {
  const exportRoot = tmpDir();
  t.after(() => fs.rmSync(exportRoot, { recursive: true, force: true }));
  await assert.rejects(
    () => answerExperiment({ exportRoot, course: '课程A', experiment: '不存在', apiKey: 'k', callModel: async () => '{}' }),
    /没有关卡存档/
  );
});
