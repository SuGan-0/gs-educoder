/**
 * 本地题目与答案目录：题目存档、仅答案模式、v1/v2 兼容与身份隔离。
 *
 * 运行：node --test test/archive-catalog.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { listTargets } = require('../extractor/lib/archive-catalog');
const { toArchiveRecord } = require('../extractor/lib/level-store');

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

// 回归（10-12 实测）：答案只在 v1 扁平位置（`answers/{课程}__{实验}.answers.json`）时，
// 也要被当成「已有答案」。少了这个回退，重新导出班级答案文件会把 86 条答案当成不存在
// （有答案的关卡 102 → 16），控制台的「已有答案几关」也会显示 0。
test('listTargets：答案只在 v1 扁平位置时也要数出来（v2 优先、v1 回退）', async (t) => {
  const exportRoot = tmpDir();
  t.after(() => fs.rmSync(exportRoot, { recursive: true, force: true }));
  seedExperiment(exportRoot, '课程A', '实验B', [CODE_LEVEL(), CHOICE_LEVEL()]);
  // 只写 v1 位置，v2 目录不存在
  const legacy = path.join(exportRoot, 'answers', '课程A__实验B.answers.json');
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.writeFileSync(legacy, JSON.stringify({
    course: '课程A',
    experiment: '实验B',
    answers: [{ level_id: 'L001', kind: 'code', answer: { language: 'python', code: 'x' } }],
    unanswered: []
  }), 'utf8');

  const courses = await listTargets(exportRoot);
  const experiment = courses[0].experiments[0];
  assert.equal(experiment.answered, 1, 'v1 位置的答案不能被当成没有答案');
  assert.equal(experiment.answerPath, legacy, '要把路径指向实际存在的 v1 文件');
});

// 回归（10-14 实测）：关卡存档里没有 `classroomCode` 字段时（早期抓的存档都这样），
// 课堂码必须能从**已有的 v2 目录名**（`{班级}（{码}）`）里认出来。只靠存档字段会算出一个
// 缺班级码的路径 `answers/{班级}/…`，与真实位置 `answers/{班级}（{码}）/…` 对不上——
// 表现就是「答案明明迁到 v2 了却读不回来」，旧扁平文件也因此不敢删。
test('listTargets：存档无课堂码时，从已有 v2 目录名认出课堂码', async (t) => {
  const exportRoot = tmpDir();
  t.after(() => fs.rmSync(exportRoot, { recursive: true, force: true }));
  seedExperiment(exportRoot, '课程A', '实验B', [CODE_LEVEL(), CHOICE_LEVEL()]);
  // v2 目录名带班级码；关卡存档里并没有 classroomCode 字段
  const answerFile = path.join(exportRoot, 'answers', '课程A（DEMO0001）', '实验B.answers.json');
  fs.mkdirSync(path.dirname(answerFile), { recursive: true });
  fs.writeFileSync(answerFile, JSON.stringify({
    schema_version: 2,
    classroom: { name: '课程A', code: 'DEMO0001' },
    experiment: { name: '实验B', homework_id: 0 },
    answers: [{ level_id: 'L001', kind: 'code', answer: { language: 'python', code: 'x' } }]
  }), 'utf8');

  const courses = await listTargets(exportRoot);
  const experiment = courses[0].experiments[0];
  assert.equal(experiment.classroom.code, 'DEMO0001', '课堂码要从目录名认出来');
  assert.equal(experiment.answerPath, answerFile, '路径必须指向带班级码的 v2 文件');
  assert.equal(experiment.answered, 1, '认不出码就会当成没有答案');
});

function seedAnswers(exportRoot, classroom, experiment, answers, filename = '') {
  const file = path.join(exportRoot, 'answers', `${classroom.name}（${classroom.code}）`, filename || `${experiment.name}.answers.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ schema_version: 2, classroom, experiment, answers }), 'utf8');
  return file;
}

test('listTargets：只抓取答案而没有题目存档时，保留身份与可用于发布的关卡元数据', async (t) => {
  const root = tmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const answerPath = seedAnswers(root, { name: '数据库原理', code: 'MYSQL01' }, { name: 'Insert,Update,Delete', homework_id: 99 }, [{
    level_id: 'L003', task_identifier: 'insert-task', title: '插入数据', kind: 'code',
    source: 'platform', verified: true, answer: { language: 'sql', code: 'INSERT INTO student VALUES (1);' }
  }]);
  const [course] = await listTargets(root);
  const [experiment] = course.experiments;
  assert.equal(experiment.directory, '');
  assert.equal(experiment.mdPath, '');
  assert.equal(experiment.answerPath, answerPath);
  assert.equal(experiment.classroom.code, 'MYSQL01');
  assert.equal(experiment.homeworkId, 99);
  assert.equal(experiment.levelCount, 1);
  assert.equal(experiment.answered, 1);
  assert.deepEqual(experiment.levels[0], {
    id: 'L003', taskIndex: 3, title: '插入数据', type: 'code', language: 'sql', taskIdentifier: 'insert-task', answered: true
  });
  assert.equal(experiment.answerDoc.answers[0].verified, true);
});

test('listTargets：按课堂码和作业号合并带分类前缀的题目与答案，并补上仅答案关卡', async (t) => {
  const root = tmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const record = CODE_LEVEL();
  Object.assign(record, { classroomCode: 'A001', experimentHomeworkId: 15 });
  seedExperiment(root, '课程A', '[第一章] 实验B', [record]);
  seedAnswers(root, { name: '课程A', code: 'A001' }, { name: '实验B', homework_id: 15 }, [{
    level_id: 'L002', title: '选择题', kind: 'choice', answer: { questions: [{ number: 1, selected: ['B'] }] }
  }]);
  const [course] = await listTargets(root);
  assert.equal(course.experiments.length, 1);
  assert.equal(course.experiments[0].name, '[第一章] 实验B');
  assert.deepEqual(course.experiments[0].levels.map((level) => [level.id, level.answered]), [['L001', false], ['L002', true]]);
});

test('listTargets：同名课堂不同课堂码、同名实验不同作业号均保持独立', async (t) => {
  const root = tmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const answer = [{ level_id: 'L001', kind: 'code', answer: { code: 'SELECT 1', language: 'sql' } }];
  seedAnswers(root, { name: '课程', code: 'A' }, { name: '实验', homework_id: 1 }, answer, 'one.answers.json');
  seedAnswers(root, { name: '课程', code: 'A' }, { name: '实验', homework_id: 2 }, answer, 'two.answers.json');
  seedAnswers(root, { name: '课程', code: 'B' }, { name: '实验', homework_id: 1 }, answer);
  const courses = await listTargets(root);
  assert.equal(courses.length, 2);
  assert.deepEqual(courses.find((course) => course.classroom.code === 'A').experiments.map((experiment) => experiment.homeworkId), [1, 2]);
  assert.equal(courses.find((course) => course.classroom.code === 'B').experiments.length, 1);
});

test('listTargets：v2 优先且旧文件仍补全缺关，不读取未来格式或损坏文件', async (t) => {
  const root = tmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const answer = (id, code) => ({ level_id: id, kind: 'code', answer: { code, language: 'sql' } });
  const current = seedAnswers(root, { name: '课程', code: 'A' }, { name: '实验', homework_id: 1 }, [answer('L001', 'new')]);
  fs.writeFileSync(path.join(root, 'answers', '课程__实验.answers.json'), JSON.stringify({
    course: '课程', experiment: '实验', answers: [answer('L001', 'old'), answer('L002', 'legacy')]
  }));
  const future = seedAnswers(root, { name: '未来', code: 'F' }, { name: '实验' }, []);
  fs.writeFileSync(future, '{"schema_version":999,"answers":[]}');
  fs.writeFileSync(path.join(root, 'answers', 'broken.answers.json'), '{');
  const [course] = await listTargets(root);
  const [experiment] = course.experiments;
  assert.equal(experiment.answerPath, current);
  assert.deepEqual(experiment.answerDoc.answers.map((entry) => [entry.level_id, entry.code]), [['L001', 'new'], ['L002', 'legacy']]);
  assert.equal(fs.readFileSync(future, 'utf8'), '{"schema_version":999,"answers":[]}');
});

