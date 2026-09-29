'use strict';

/**
 * 教学课程「发现层 + 队列」的行为测试（离线）。
 * 响应样本取自 2026-09-29 真机实录（stages.json 裁剪到 2 条）。
 *
 * 运行：node --test test/userscript-teach.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'userscript', 'educoder-autosubmit.user.js'), 'utf8');

function loadHooks({ pathname = '/tasks/HCEAP94S/88000001/zq75a64d2b22', search = '' } = {}) {
  const hooks = {};
  const fakeDocument = {
    querySelectorAll: () => [],
    querySelector: () => null,
    getElementById: () => null,
    createElement: () => ({ style: {}, append() {}, addEventListener() {}, setAttribute() {} }),
    head: { append() {} },
    body: { append() {} }
  };
  const location = { pathname, search, origin: 'https://www.educoder.net', href: `https://www.educoder.net${pathname}${search}` };
  const sandbox = {
    window: {
      __educoderAutosubmitTestHooks: hooks,
      btoa: (value) => Buffer.from(String(value), 'binary').toString('base64'),
      atob: (value) => Buffer.from(String(value), 'base64').toString('binary'),
      document: fakeDocument,
      location
    },
    document: fakeDocument,
    location,
    navigator: { userAgent: 'test' },
    URL,
    URLSearchParams,
    console,
    setTimeout,
    clearTimeout,
    GM_getValue: (_key, fallback) => fallback,
    GM_setValue: () => {},
    GM_deleteValue: () => {},
    GM_registerMenuCommand: () => {},
    GM_xmlhttpRequest: () => {}
  };
  vm.createContext(sandbox);
  new vm.Script(SOURCE).runInContext(sandbox);
  return hooks;
}

const STAGES_SAMPLE = {
  status: 0,
  data: {
    stages: [
      {
        stage_name: '第一课时：开源软件及其开发概述（课堂 lecture）',
        items: [
          {
            item_type: 'Shixun',
            name: '开源软件及其开发概述（课堂 lecture）',
            identifier: 'zqbda7a6',
            challenges_count: 1,
            finished_challenges_count: 0,
            is_jupyter: false,
            is_jupyter_lab: false
          },
          { item_type: 'Attachment', name: 'lecture11.pdf' }
        ]
      },
      {
        stage_name: '第七课时：CI/CD（上机实习）',
        items: [
          {
            item_type: 'Shixun',
            name: 'CI/CD（上机实习）',
            identifier: 'zqbf6766',
            challenges_count: 3,
            finished_challenges_count: 1,
            is_jupyter: true,
            is_jupyter_lab: false
          }
        ]
      }
    ]
  }
};

test('发现层：课程信息与当前路径识别', () => {
  const hooks = loadHooks({ pathname: '/paths/zq3026ca' });
  assert.equal(hooks.parseCurrentPathIdentifier(), 'zq3026ca');
  assert.deepEqual(
    { ...hooks.parsePathCourse('zq3026ca', { id: 10084, name: 'OSS Development 开源软件技术' }) },
    { identifier: 'zq3026ca', id: 10084, name: 'OSS Development 开源软件技术' }
  );
});

test('发现层：课程实验摊平且只留 Shixun（含虚拟机标记与进度）', () => {
  const hooks = loadHooks();
  const rows = hooks.parseCourseExperiments(STAGES_SAMPLE);
  assert.equal(rows.length, 2);
  assert.deepEqual({ ...rows[0] }, {
    stageName: '第一课时：开源软件及其开发概述（课堂 lecture）',
    name: '开源软件及其开发概述（课堂 lecture）',
    identifier: 'zqbda7a6',
    challenges: 1,
    finished: 0,
    jupyter: false,
    progressKnown: true
  });
  assert.equal(rows[1].jupyter, true, 'is_jupyter 必须被识别为虚拟机');
});

test('发现层：我的课堂（courses.json）解析出课程与课堂码', () => {
  const hooks = loadHooks();
  const rows = hooks.parseClassrooms({
    count: 2,
    courses: [
      { id: 120386, name: '示例课程B', first_category_url: '/classrooms/HCEAP94S/announcement' },
      { id: 0, name: '坏数据' }
    ]
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].classroomCode, 'HCEAP94S');
  assert.equal(rows[0].kind, 'classroom');
  assert.equal(rows[0].name, '示例课程B');
});

test('发现层：课堂实验只留实训且必须有标识', () => {
  const hooks = loadHooks();
  const rows = hooks.parseClassroomExperiments({
    status: 0,
    homeworks: [
      { name: 'CNN', homework_id: 88000002, shixun_identifier: 'zq6177bf', myshixun_identifier: 'zq3a1b66ee', challenge_count: 5, is_shixun: true },
      { name: '普通作业', homework_id: 1, is_shixun: false },
      { name: '没标识的实训', homework_id: 2, is_shixun: true }
    ]
  });
  // vm 沙箱产出的对象原型与主 realm 不同，deepStrictEqual 前先摊成本地对象。
  assert.deepEqual(Array.from(rows, (item) => ({ ...item })), [{
    stageName: '课堂实验',
    name: 'CNN',
    identifier: 'zq6177bf',
    challenges: 5,
    finished: 0,
    jupyter: false,
    progressKnown: false
  }]);
});

test('发现层：关卡列表两种结构都认，并按序号排序', () => {
  const hooks = loadHooks();
  const fromList = hooks.parseChallenges({
    challenge_list: [
      { name: '第二关', position: 2, challenge_id: 9 },
      { name: '第一关', position: 1, challenge_id: 8 }
    ]
  });
  assert.deepEqual(fromList.map((item) => item.position), [1, 2]);
  assert.equal(fromList[1].name, '第二关');
  assert.equal(hooks.parseChallenges([{ name: '唯一关', position: 1 }]).length, 1);
});

test('队列构建：默认全选、按勾选过滤、虚拟机实验剔除', () => {
  const hooks = loadHooks();
  const experiments = hooks.parseCourseExperiments(STAGES_SAMPLE);
  const levelsByExperiment = {
    zqbda7a6: [{ name: '第1关', position: 1 }, { name: '第2关', position: 2 }]
  };
  const all = hooks.buildTeachQueue(experiments, { experiments: ['zqbda7a6', 'zqbf6766'], levels: {} }, levelsByExperiment);
  assert.equal(all.total, 2, '默认 = 该实验全部关卡');
  assert.deepEqual(Array.from(all.skippedJupyter), ['CI/CD（上机实习）']);
  const partial = hooks.buildTeachQueue(experiments, { experiments: ['zqbda7a6'], levels: { zqbda7a6: [2] } }, levelsByExperiment);
  assert.deepEqual(Array.from(partial.experiments[0].positions), [2], '勾选了的按勾选来');
});

test('每关动作判定：未选中 → 虚拟机 → 已通过 → 无答案 → 作答', () => {
  const hooks = loadHooks();
  assert.equal(hooks.teachLevelAction({ selected: false, hasEditor: true, hasChoice: false, passed: false, hasAnswer: true }), 'unselected');
  assert.equal(hooks.teachLevelAction({ selected: true, hasEditor: false, hasChoice: false, passed: false, hasAnswer: true }), 'vm');
  assert.equal(hooks.teachLevelAction({ selected: true, hasEditor: true, hasChoice: false, passed: true, hasAnswer: false }), 'passed');
  assert.equal(hooks.teachLevelAction({ selected: true, hasEditor: true, hasChoice: false, passed: false, hasAnswer: false }), 'missing');
  assert.equal(hooks.teachLevelAction({ selected: true, hasEditor: true, hasChoice: false, passed: false, hasAnswer: true }), 'answer');
});

test('缺答案上报载荷：字段齐全、编号是 L00N', () => {
  const hooks = loadHooks();
  const item = hooks.buildMissingItem({
    course: '机器学习',
    experiment: '第1课时',
    levelName: '第2关 留出法',
    position: 2,
    identifier: 'zq75a64d2b22',
    url: 'https://www.educoder.net/tasks/HCEAP94S/88000001/zq75a64d2b22'
  });
  assert.equal(item.level_id, 'L002');
  assert.equal(item.reason, 'no-answer');
  assert.equal(item.identifier, 'zq75a64d2b22');
});

test('队首匹配：序号命中即续跑、不命中不续；handoff 超过 90 秒视为过期', () => {
  const hooks = loadHooks();
  const queue = {
    mode: 'course',
    running: true,
    handoffAt: Date.now(),
    experimentIndex: 0,
    experiments: [{ identifier: 'x', positions: [1, 2] }],
    expected: { identifier: '', position: 0 }
  };
  assert.equal(
    hooks.queueMatchesCurrent(queue, { identifier: 'zq75a64d2b22', position: 2, href: 'https://www.educoder.net/tasks/a/b/zq75a64d2b22' }),
    true
  );
  assert.equal(
    hooks.queueMatchesCurrent(queue, { identifier: 'other', position: 9, href: 'https://www.educoder.net/tasks/other' }),
    false
  );
  assert.equal(hooks.queueFresh({ ...queue, handoffAt: Date.now() - 120000 }), false);
});

test('队首匹配：未选中的关卡也算队首（走过场），不会把队列卡死', () => {
  const hooks = loadHooks();
  const queue = {
    mode: 'course',
    running: true,
    handoffAt: Date.now(),
    experimentIndex: 0,
    experiments: [{ identifier: 'x', positions: [2], allPositions: [1, 2, 3] }],
    expected: { identifier: '', position: 0 }
  };
  assert.equal(hooks.queueMatchesCurrent(queue, { identifier: 'level-1', position: 1, href: 'https://www.educoder.net/tasks/level-1' }), true);
});

test('URL 回退：把最后一段换成上一关标识，查询串保留', () => {
  const hooks = loadHooks({
    pathname: '/tasks/HCEAP94S/88000001/zq75a64d2b22',
    search: '?coursesId=HCEAP94S'
  });
  assert.equal(
    hooks.urlForLevelIdentifier('abc123'),
    'https://www.educoder.net/tasks/HCEAP94S/88000001/abc123?coursesId=HCEAP94S'
  );
});

test('已通过判定：与 extractor 的 levelPassed 同口径（满分才通过）', () => {
  const hooks = loadHooks();
  assert.equal(hooks.levelPassedOf({ challenge: { score: 100 }, game: { final_score: 100 } }), true);
  assert.equal(hooks.levelPassedOf({ challenge: { score: 100 }, game: { final_score: 0 } }), false);
  assert.equal(hooks.levelPassedOf({}), false);
});

test('观察关卡数据：编程题（没有选择题）也必须建立 taskContext（队列靠它定位）', () => {
  const hooks = loadHooks();
  hooks.observeTaskJson('/api/tasks/zq2a7dad921e.json?homework_common_id=88000002', {
    challenge: { position: 1, score: 100 },
    game: { final_score: 0 },
    prev_game: null,
    next_game: 'glz47yx2f8vb',
    chooses: []
  });
  assert.ok(hooks.state.taskContext, '编程题页面也必须建立 taskContext（原实现会整段跳过）');
  assert.equal(hooks.state.taskContext.id, 'zq2a7dad921e');
  assert.equal(hooks.state.taskContext.levelPosition, 1);
  assert.equal(hooks.state.taskContext.nextGame, 'glz47yx2f8vb');
  assert.equal(hooks.state.taskContext.passed, false);
  assert.deepEqual(Array.from(hooks.state.taskContext.sizes), []);
});

test('currentTask：只认与当前 URL 标识一致的关卡数据（防上一关的残留）', () => {
  const hooks = loadHooks({ pathname: '/tasks/level-b' });
  assert.equal(hooks.currentTask(), null, '没有数据时为 null');
  hooks.state.taskContext = { id: 'level-a', levelPosition: 2, prevGame: '', nextGame: '' };
  assert.equal(hooks.currentTask(), null, '标识不一致（上一关残留）时必须为 null');
  hooks.state.taskContext = { id: 'level-b', levelPosition: 1, prevGame: '', nextGame: 'level-c' };
  assert.equal(hooks.currentTask().nextGame, 'level-c');
});

test('backtrackDecision：自指/打转/超次数都要停', () => {
  const hooks = loadHooks();
  assert.equal(hooks.backtrackDecision({ hops: 0, trail: [], previous: 'p', currentIdentifier: 'c' }), 'go');
  assert.match(hooks.backtrackDecision({ hops: 0, trail: [], previous: 'c', currentIdentifier: 'c' }), /^stop:自指/);
  assert.match(hooks.backtrackDecision({ hops: 0, trail: ['p'], previous: 'p', currentIdentifier: 'c' }), /^stop:打转/);
  assert.match(hooks.backtrackDecision({ hops: 8, trail: [], previous: 'p', currentIdentifier: 'c' }), /^stop:回退次数过多/);
  assert.match(hooks.backtrackDecision({ hops: 0, trail: [], previous: '', currentIdentifier: 'c' }), /^stop:没有上一关/);
});

test('shouldBacktrack：只有「刚进实验」阶段的 course 队列才允许回退链首', () => {
  const hooks = loadHooks();
  assert.equal(hooks.shouldBacktrack({ mode: 'course', needChainStart: true }), true);
  assert.equal(hooks.shouldBacktrack({ mode: 'course', needChainStart: false }), false);
  assert.equal(hooks.shouldBacktrack({ mode: 'missing', needChainStart: true }), false);
  assert.equal(hooks.shouldBacktrack(null), false);
});