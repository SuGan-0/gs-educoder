'use strict';

/**
 * 「导出标准答案」的行为测试（离线）。
 *
 * 数据来源（实测）：平台在关卡提交后，`/api/tasks/{id}.json` 的
 * `choose_test_cases.test_sets[]` 里带 `standard_answer`（正确答案）和
 * `actual_output`（用户答的）。导出应优先取 standard_answer，
 * 未提交时退回 actual_output。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'userscript', 'educoder-autosubmit.user.js'),
  'utf8'
);

function loadExportHooks() {
  const hooks = {};
  const fakeDocument = {
    querySelectorAll: () => [],
    querySelector: () => null,
    getElementById: () => null,
    createElement: () => ({ style: {}, append() {}, addEventListener() {}, setAttribute() {} }),
    head: { append() {} },
    body: { append() {} }
  };
  const sandbox = {
    window: { __educoderAutosubmitTestHooks: hooks },
    document: fakeDocument,
    location: { pathname: '/tasks/pvz5hnmlxs2k', href: 'https://www.educoder.net/tasks/pvz5hnmlxs2k' },
    navigator: { userAgent: 'test' },
    URL,
    URLSearchParams,
    console,
    setTimeout,
    clearTimeout,
    GM_getValue: (_k, fb) => fb,
    GM_setValue: () => {},
    GM_deleteValue: () => {},
    GM_registerMenuCommand: () => {},
    GM_xmlhttpRequest: () => {}
  };
  sandbox.window.document = fakeDocument;
  sandbox.window.location = sandbox.location;
  vm.createContext(sandbox);
  new vm.Script(SOURCE).runInContext(sandbox);
  assert.ok(typeof hooks.standardAnswerText === 'function', '测试钩子应被挂上');
  return hooks;
}

/** 与真实 /api/tasks/{id}.json 字段一致的 payload（5 道题，已提交）。 */
function submittedTaskJson() {
  const choices = Array.from({ length: 5 }, (_, i) => ({ position: i + 1, challenge_question: [1, 2, 3, 4] }));
  return {
    chooses: choices,
    challenge: { position: 1, subject: '进度管理' },
    choose_test_cases: {
      challenge_chooses_count: 5,
      had_submmit: true,
      had_all_submmit: true,
      test_sets: [
        { result: true, actual_output: 'B', standard_answer: 'B', position: 1 },
        { result: true, actual_output: 'B', standard_answer: 'B', position: 2 },
        { result: true, actual_output: 'C', standard_answer: 'C', position: 3 },
        { result: true, actual_output: 'C', standard_answer: 'C', position: 4 },
        { result: true, actual_output: 'D', standard_answer: 'D', position: 5 }
      ]
    }
  };
}

test('导出：已提交关卡读 standard_answer，格式化成 1:B;2:B;...', () => {
  const hooks = loadExportHooks();
  hooks.observeTaskJson('https://data.educoder.net/api/tasks/pvz5hnmlxs2k.json', submittedTaskJson());
  const ctx = hooks.state.taskContext;
  assert.equal(ctx.submitted, true);
  assert.equal(ctx.levelId, 'L001', 'challenge.position=1 → L001');
  assert.equal(hooks.standardAnswerText(ctx.standardAnswer), '1:B;2:B;3:C;4:C;5:D');
});

test('导出：未提交时退回 actual_output（用户答的，不保证对）', () => {
  const hooks = loadExportHooks();
  const payload = submittedTaskJson();
  payload.choose_test_cases.had_submmit = false;
  payload.choose_test_cases.had_all_submmit = false;
  // 未提交：standard_answer 缺失，只有 actual_output
  payload.choose_test_cases.test_sets = [
    { result: false, actual_output: 'C', position: 1 },
    { result: false, actual_output: 'A', position: 2 }
  ];
  hooks.observeTaskJson('https://data.educoder.net/api/tasks/pvz5hnmlxs2k.json', payload);
  const ctx = hooks.state.taskContext;
  assert.equal(ctx.submitted, false);
  assert.equal(hooks.standardAnswerText(ctx.standardAnswer), '1:C;2:A', '未提交时只能取用户实际选的');
});

test('导出：standard_answer 优先于 actual_output（答错时也导出正确答案）', () => {
  const hooks = loadExportHooks();
  const payload = submittedTaskJson();
  payload.choose_test_cases.test_sets = [
    { result: false, actual_output: 'ABCD', standard_answer: 'ACD', position: 3 }
  ];
  payload.chooses = [{ position: 3, challenge_question: [1, 2, 3, 4] }];
  hooks.observeTaskJson('https://data.educoder.net/api/tasks/j5nxiy2lfu8m.json', payload);
  assert.equal(hooks.standardAnswerText(hooks.state.taskContext.standardAnswer), '3:ACD', '答错也要导出标准答案而非用户答的');
});

test('导出：提交响应（POST choose_build）也要抓标准答案（否则拿到空）', () => {
  const hooks = loadExportHooks();
  // 页面加载时先观察到「未提交」的关卡：此时没有标准答案
  hooks.observeTaskJson('https://data.educoder.net/api/tasks/wafjr3xgmk5b.json', {
    chooses: [{ position: 1, challenge_question: [1, 2, 3, 4] }],
    challenge: { position: 1 },
    choose_test_cases: { had_submmit: false, test_sets: [] }
  });
  assert.equal(hooks.state.taskContext.standardAnswer.length, 0, '未提交时没有标准答案');

  // 提交后，POST /choose_build 响应里才带 standard_answer
  hooks.observeSubmitResult('https://data.educoder.net/api/tasks/wafjr3xgmk5b/choose_build.json', {
    test_sets: [
      { position: 1, actual_output: 'D', standard_answer: 'D' },
      { position: 2, actual_output: 'C', standard_answer: 'C' },
      { position: 3, actual_output: 'A', standard_answer: 'A' }
    ]
  });
  assert.equal(hooks.standardAnswerText(hooks.state.taskContext.standardAnswer), '1:D;2:C;3:A');
  assert.equal(hooks.state.taskContext.submitted, true);
});

test('回传：选择题优先平台标准答案，勾选的选项兜底', () => {
  const hooks = loadExportHooks();
  hooks.observeTaskJson('https://data.educoder.net/api/tasks/pvz5hnmlxs2k.json', submittedTaskJson());
  const payload = hooks.passedAnswerPayload({ choiceMap: { 1: ['B'], 2: ['B'] } });
  assert.equal(payload.kind, 'choice');
  assert.equal(payload.answer, '1:B;2:B;3:C;4:C;5:D', '提交后优先 standard_answer');
  assert.equal(payload.identifier, 'pvz5hnmlxs2k');

  // 没抓到标准答案（比如只走了页面提交、还没等到 choose_build 响应）：用答题时勾选的选项
  const hooks2 = loadExportHooks();
  hooks2.observeTaskJson('https://data.educoder.net/api/tasks/xyz.json', {
    chooses: [{ position: 1, challenge_question: [1, 2, 3, 4] }],
    challenge: { position: 3 },
    choose_test_cases: { had_submmit: false, test_sets: [] }
  });
  const fallback = hooks2.passedAnswerPayload({ choiceMap: { 1: ['A', 'C'], 2: ['B'] } });
  assert.equal(fallback.levelId, 'L003');
  assert.equal(fallback.kind, 'choice');
  assert.equal(fallback.answer, '1:A,C;2:B', '勾选的选项要归一成「题号:字母（逗号分隔）」');
});

test('回传：编程题用提交的代码；什么都没有时不回传', () => {
  const hooks = loadExportHooks();
  const payload = hooks.passedAnswerPayload({ codeText: 'print("提交的代码")\n' });
  assert.equal(payload.kind, 'code');
  assert.equal(payload.answer, 'print("提交的代码")\n');
  assert.equal(payload.identifier, 'pvz5hnmlxs2k', '脚本只回传关卡页 URL 里的标识，课程/实验由控制台映射');
  assert.equal(payload.language, '', '语言从答案库里带（没有就留空）');

  // 既没标准答案、也没勾选、也没代码：返回 null，宁可不回传也不写空答案
  const empty = hooks.passedAnswerPayload({});
  assert.equal(empty, null);
});

test('批量导出：从关卡数据里取各关标准答案（按 position 排序、空值过滤）', () => {
  const hooks = loadExportHooks();
  const rows = hooks.standardAnswerOf({
    choose_test_cases: {
      test_sets: [
        { position: 2, standard_answer: 'B' },
        { position: 1, standard_answer: 'A' },
        { position: 3, standard_answer: '' },
        { position: 4, actual_output: 'D' }
      ]
    }
  });
  assert.deepEqual(JSON.parse(JSON.stringify(rows)), [
    { position: 1, answer: 'A' },
    { position: 2, answer: 'B' },
    { position: 4, answer: 'D' }
  ], 'standard_answer 优先、空值被过滤、缺 standard_answer 时退回 actual_output');
});

test('批量导出：没有 choose_test_cases（纯编程题）时返回空', () => {
  const hooks = loadExportHooks();
  assert.equal(hooks.standardAnswerOf({ challenge: { position: 1 } }).length, 0, '纯编程题没有标准答案');
});

test('课堂实验解析：挂在嵌套子项里的实训也要读出来（顶层过滤会整片漏掉）', () => {
  const hooks = loadExportHooks();
  const payload = {
    homeworks: [
      { name: '顶层实训', is_shixun: true, shixun_identifier: 'aaa111', challenge_count: 5 },
      { name: '普通作业', homework_id: 999 }, // 非实训：不能混进来
      {
        name: '软件工程概述',
        is_shixun: true,
        shixun_identifier: 'bbb222',
        children: [
          // 子项带实训标识 → 要读到
          { name: '软件危机', shixun_identifier: 'ccc333' },
          // 子项只有 homework_id → 面板暂时读不了（会计数并告警），但不能整片丢
          { name: '软件过程模型', homework_id: 4000332 }
        ]
      }
    ]
  };
  const list = hooks.parseClassroomExperiments(payload);
  assert.deepEqual(
    JSON.parse(JSON.stringify(list.map((x) => `${x.name}/${x.identifier}`))),
    ['顶层实训/aaa111', '软件工程概述/bbb222', '软件危机/ccc333'],
    '顶层与嵌套的实训都要读到，普通作业不能混进来'
  );
});

test('课堂实验解析：homework_commons 为空时不炸（返回空数组）', () => {
  const hooks = loadExportHooks();
  assert.equal(hooks.parseClassroomExperiments({}).length, 0);
  assert.equal(hooks.parseClassroomExperiments({ homeworks: [] }).length, 0);
});

test('等待编辑器：没有编辑器时 waitForCodeEditor 要按时返回 null（不能卡死）', async () => {
  const hooks = loadExportHooks();
  const started = Date.now();
  const editor = await hooks.waitForCodeEditor(400);
  assert.equal(editor, null, '没有编辑器就该返回 null');
  assert.ok(Date.now() - started >= 400, '要一直等到超时才放弃，不能立刻返回（Monaco 是异步挂载的）');
});
