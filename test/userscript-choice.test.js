'use strict';

/**
 * 选择题分组的**行为**测试（离线）。
 *
 * 针对的回归：用户页面 3 道题，脚本却报「4 组」「15 个选项框」而放弃勾选。
 * 实机排查（无头浏览器）确认了两件事：
 *   ① 页面上**没有**任何分组容器（`.ant-radio-group` 等全是 0 个），选项是
 *      裸 `<li>` 平铺：`input < label.ant-radio-wrapper.choice < div.option`；
 *   ② 真正的选项只有 3 × 4 = 12 个，其余多出来的 radio/checkbox 是「标记本题」
 *      之类的杂项控件——必须靠外层 `.choice` / `.option` 标记筛掉。
 *
 * 于是分组改为：**优先用「每道题的选项个数」切分**（个数来自页面自己的关卡数据
 * `chooses[].challenge_question.length`，或控制台的 optionCounts），
 * 并且只统计「选项」控件、不把杂项算进去。
 * 这些逻辑只有真跑代码才验得出来，沿用篡改猴的测试钩子。
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

/** 在假 DOM 里加载脚本，拿回测试钩子。 */
function loadChoiceHooks(inputs) {
  const hooks = {};
  const fakeDocument = {
    querySelectorAll(selector) {
      // 选项控件查询返回 inputs；分组容器查询返回空（实测页面没有分组容器）
      if (String(selector).includes('input[type')) return inputs;
      return [];
    },
    querySelector: () => null,
    getElementById: () => null,
    createElement: () => ({ style: {}, append() {}, addEventListener() {}, setAttribute() {} }),
    head: { append() {} },
    body: { append() {} }
  };
  const sandbox = {
    window: { __educoderAutosubmitTestHooks: hooks },
    document: fakeDocument,
    location: { pathname: '/tasks/zq3cef619ac5', href: 'https://www.educoder.net/tasks/zq3cef619ac5' },
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
  sandbox.window.document = fakeDocument;
  sandbox.window.location = sandbox.location;
  vm.createContext(sandbox);
  new vm.Script(SOURCE).runInContext(sandbox);
  assert.ok(typeof hooks.partitionByCounts === 'function', '测试钩子应被挂上');
  return hooks;
}

/** 一个「选项」控件：外层带 .choice，closest 返回真值。 */
function fakeOptionInput(type) {
  return {
    type,
    checked: false,
    click() {
      this.checked = type === 'checkbox' ? !this.checked : true;
    },
    getClientRects: () => [{}],
    closest: () => ({ textContent: '选项' }),
    parentElement: null
  };
}

/** 一个「杂项」checkbox（如「标记本题」）：外层没有 .choice，closest 返回 null。 */
function fakeStrayInput() {
  return {
    type: 'checkbox',
    checked: false,
    click() {
      this.checked = !this.checked;
    },
    getClientRects: () => [{}],
    closest: () => null,
    parentElement: null
  };
}

/** 3 道题 × 4 选项：前两题单选、第三题多选。 */
function fakeInputs() {
  return [
    ...Array.from({ length: 4 }, () => fakeOptionInput('radio')),
    ...Array.from({ length: 4 }, () => fakeOptionInput('radio')),
    ...Array.from({ length: 4 }, () => fakeOptionInput('checkbox'))
  ];
}

/** 模拟页面自己拉的关卡 JSON（字段与真实 /api/tasks/{id}.json 一致）。 */
function fakeTaskJson() {
  return {
    choose_test_cases: { challenge_chooses_count: 3 },
    chooses: [
      { position: 1, challenge_question: [1, 2, 3, 4] },
      { position: 2, challenge_question: [1, 2, 3, 4] },
      { position: 3, challenge_question: [1, 2, 3, 4] }
    ]
  };
}

test('分组：按「每道题的选项个数」切分，总数对不上返回 null', () => {
  const hooks = loadChoiceHooks([]);
  const three = hooks.partitionByCounts(fakeInputs(), [4, 4, 4]);
  assert.equal(three.length, 3, '3 题应切成 3 组');
  assert.equal(three[0].length, 4);
  assert.equal(three[2][0].type, 'checkbox', '第三题是多选，应为 checkbox');

  assert.equal(hooks.partitionByCounts(fakeInputs(), [4, 4]), null, '总数对不上必须返回 null');
  assert.equal(hooks.partitionByCounts([...fakeInputs(), fakeOptionInput('radio')], [4, 4, 4]), null, '多一个选项框也要返回 null');
});

test('回归：12 个选项 + 3 个「标记本题」杂项，仍按 [4,4,4] 勾出 3 组', async () => {
  const all = [...fakeInputs(), fakeStrayInput(), fakeStrayInput(), fakeStrayInput()];
  const hooks = loadChoiceHooks(all);

  // 先统计：杂项必须被 isOptionInput 筛掉
  assert.equal(hooks.visibleChoiceInputs().length, 12, '15 个控件里应只剩 12 个选项');

  // 模拟脚本在页面上读到的关卡数据（最权威来源）
  hooks.observeTaskJson('https://data.educoder.net/api/tasks/zq3cef619ac5.json', fakeTaskJson());
  hooks.state.levelIndex.zq3cef619ac5 = 'L001';

  const picked = Array.from(await hooks.answerChoiceLevel({ 1: ['C'], 2: ['A'], 3: ['A', 'C', 'D'] }));
  assert.deepEqual(picked, ['1:C', '2:A', '3:ACD'], `实际勾选：${JSON.stringify(picked)}`);
});

test('观察关卡数据：从 chooses 里读出的选项数必须是 [4,4,4]', () => {
  const hooks = loadChoiceHooks([]);
  hooks.observeTaskJson('https://data.educoder.net/api/tasks/zq3cef619ac5.json', fakeTaskJson());
  assert.equal(hooks.state.taskContext.id, 'zq3cef619ac5');
  assert.deepEqual(Array.from(hooks.state.taskContext.sizes), [4, 4, 4], '按 position 排序取 challenge_question.length');
});

test('回归：答案题数与选项个数对不上时，宁可放弃也不硬勾', async () => {
  const hooks = loadChoiceHooks(fakeInputs());
  hooks.observeTaskJson('https://data.educoder.net/api/tasks/zq3cef619ac5.json', {
    chooses: [
      { position: 1, challenge_question: [1, 2, 3, 4] },
      { position: 2, challenge_question: [1, 2, 3, 4] }
    ]
  });
  hooks.state.levelIndex.zq3cef619ac5 = 'L001';
  // 答案 2 题，但页面有 3 题 × 4 选项 → 切分会因总数对不上而失败
  const picked = Array.from(await hooks.answerChoiceLevel({ 1: ['C'], 2: ['A'] }));
  assert.deepEqual(picked, [], '分不清就必须放弃勾选');
});

test('诊断：描述分组时带出「每组的选项个数」，便于定位多出来的那组', () => {
  const hooks = loadChoiceHooks([]);
  const group = [1, 2, 3, 4].map(() => fakeOptionInput('radio'));
  const text = hooks.describeGroups([group]);
  assert.match(text, /#1\(4项:/, '应报告组号、选项数与选项文本');
});

// 平台重新发布实验 / 课堂与教学课程是两份副本时，同一关卡会拿到**完全不同**的平台标识
// （实测本地存档是 kbfiscelzp9a，页面上是 v4nyrg6lex7q，标题都是 stride）。
// 此时按标识映射必然落空，必须退回按内容（实验名+关卡名）匹配。
test('关卡键：平台换了标识时，按「实验名__关卡名」兜底匹配', () => {
  const hooks = loadChoiceHooks([]);
  hooks.state.titleIndex['CNN__stride'] = '示例课程B__CNN__L003';
  hooks.state.levelHint = { experimentName: 'CNN', levelName: 'stride' };
  assert.equal(hooks.answerKeyForCurrentLevel(), '示例课程B__CNN__L003');
});

test('关卡键：有精确映射时优先用映射，不走标题兜底', () => {
  const hooks = loadChoiceHooks([]);
  hooks.state.levelIndex.zq3cef619ac5 = '课程__实验__L001';
  hooks.state.titleIndex['CNN__stride'] = '别的__实验__L003';
  hooks.state.levelHint = { experimentName: 'CNN', levelName: 'stride' };
  assert.equal(hooks.answerKeyForCurrentLevel(), '课程__实验__L001', '精确映射优先，标题兜底只做后备');
});

test('关卡键：都查不到时退回平台标识（绝不乱匹配到别的关卡）', () => {
  const hooks = loadChoiceHooks([]);
  hooks.state.levelHint = { experimentName: 'CNN', levelName: '不存在的关卡名' };
  assert.equal(hooks.answerKeyForCurrentLevel(), 'zq3cef619ac5', '查不到就原样返回标识，让上层报缺答案');
});

test('关卡键：实验名对不上（带分类前缀）时，靠「关卡名」兜底', () => {
  const hooks = loadChoiceHooks([]);
  // 控制台建的是「目录名__关卡名」的键（目录名带 [分类] 前缀），
  // 脚本用的是平台侧实验名 → 按实验名查必然落空，要能退到只按关卡名查。
  hooks.state.titleIndex['[4、分类] 需求分析的基本概念__系统的8个综合需求'] = '课程__实验__L002';
  hooks.state.titleOnlyIndex['系统的8个综合需求'] = '课程__实验__L002';
  hooks.state.levelHint = { experimentName: '需求分析的基本概念', levelName: '系统的8个综合需求' };
  assert.equal(hooks.answerKeyForCurrentLevel(), '课程__实验__L002', '实验名对不上时要靠关卡名兜底');
});

test('关卡键：有精确映射时优先级最高（兜底表不抢）', () => {
  const hooks = loadChoiceHooks([]);
  hooks.state.levelIndex.zq3cef619ac5 = '课程__实验__L009';
  hooks.state.titleOnlyIndex['任意关卡'] = '课程__别的__L001';
  hooks.state.levelHint = { experimentName: 'X', levelName: '任意关卡' };
  assert.equal(hooks.answerKeyForCurrentLevel(), '课程__实验__L009');
});
