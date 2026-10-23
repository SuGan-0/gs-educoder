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

/**
 * 把脚本沙箱里造出来的对象「洗」成当前 realm 的普通对象。
 *
 * 脚本跑在 vm 里，它造的数组/对象原型与测试不是同一个 —— `assert.deepEqual`
 * 是严格比较（deepStrictEqual），会因原型不同而失败，报错信息还很迷惑
 * （expected/actual 看起来一模一样）。凡是要 deepEqual 的跨边界结构都先过这一道。
 */
const plain = (value) => JSON.parse(JSON.stringify(value));

/** 在假 DOM 里加载脚本，拿回测试钩子。 */
function loadChoiceHooks(inputs, options = {}) {
  const hooks = {};
  // 默认的 GM 存储是个「读不到就给默认值」的空壳；要测跨标签页行为就传 options.store
  const store = options.store || new Map();
  const fakeDocument = {
    querySelectorAll(selector) {
      // 选项控件查询返回 inputs；分组容器查询返回空（实测页面没有分组容器）
      if (String(selector).includes('input[type')) return inputs;
      return [];
    },
    querySelector: () => null,
    getElementById: () => null,
    // 导入答案会 createElement('input') 后 append 进 body、再 click()：
    // 桩里必须给全 remove/click/addEventListener，否则那条路径在测试里会抛 TypeError。
    createElement: () => ({
      style: {}, append() {}, addEventListener() {}, setAttribute() {},
      remove() {}, click() {}
    }),
    head: { append() {} },
    body: { append() {} }
  };
  const sandbox = {
    window: {
      __educoderAutosubmitTestHooks: hooks,
      close: options.onClose || (() => {}),
      // fetchTaskData / fetchLevelCode 在无 unsafeWindow 的环境退回 window.fetch —— 测试用它回放接口
      fetch: options.fetch,
      // 仓库代码解码要用（fetchLevelCode：base64 → UTF-8 文本）
      atob: (value) => Buffer.from(String(value), 'base64').toString('binary'),
      TextDecoder
    },
    document: fakeDocument,
    location: {
      pathname: options.pathname || '/tasks/zq3cef619ac5',
      href: options.href || 'https://www.educoder.net/tasks/zq3cef619ac5',
      reload: options.onReload || (() => {})
    },
    navigator: { userAgent: 'test' },
    URL,
    URLSearchParams,
    console,
    setTimeout,
    clearTimeout,
    GM_getValue: (key, fallback) => (store.has(key) ? store.get(key) : fallback),
    GM_setValue: (key, value) => { store.set(key, value); },
    GM_deleteValue: (key) => { store.delete(key); },
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

// 实机回归：页面 1 道题 3 选项、答案却有 6 道题（答案库挂错/过期）。
// 之前的报错是「页面关卡数据没读到」——但上一行日志刚打印过「读到关卡数据：1 道题，选项数 3」，
// 自相矛盾，把排查方向从「答案过期」带偏成「网络钩子没装上」。
test('诊断：题数对不上时，报错必须说清「读到了但对不上」，不能谎称没读到', async () => {
  const hooks = loadChoiceHooks([
    fakeOptionInput('radio'),
    fakeOptionInput('radio'),
    fakeOptionInput('radio')
  ]);
  // 页面自己的关卡数据：1 道题，3 个选项
  hooks.observeTaskJson('https://data.educoder.net/api/tasks/zq3cef619ac5.json', {
    chooses: [{ position: 1, challenge_question: [1, 2, 3] }]
  });
  hooks.state.levelIndex.zq3cef619ac5 = 'L001';

  // 答案却是 6 道题（旧答案库挂到了同名关卡上）
  const picked = Array.from(await hooks.answerChoiceLevel({
    1: ['C'], 2: ['C'], 3: ['A'], 4: ['B'], 5: ['A'], 6: ['A', 'B', 'C']
  }));
  assert.deepEqual(picked, [], '两边不是同一版，必须放弃勾选而不是硬猜');

  const errors = hooks.state.logs.filter((row) => row.tone === 'error').map((row) => row.message);
  const hit = errors.find((text) => text.includes('无法确定题目分组'));
  assert.ok(hit, `应有放弃勾选的报错，实际：${JSON.stringify(errors)}`);
  assert.match(hit, /页面关卡数据：1 道题（选项数 3）/, '要报出页面读到的题数');
  assert.match(hit, /答案却有 6 道题/, '要报出答案的题数');
  assert.doesNotMatch(hit, /页面关卡数据没读到/, '读到了就不能说没读到');
});

// 反面：两个来源都空时，仍然要老实说「没读到」。
test('诊断：两个来源都没有数据时，照实说「没读到」', async () => {
  const hooks = loadChoiceHooks([
    fakeOptionInput('radio'),
    fakeOptionInput('radio'),
    fakeOptionInput('radio')
  ]);
  const picked = Array.from(await hooks.answerChoiceLevel({ 1: ['C'] }));
  assert.deepEqual(picked, []);

  const errors = hooks.state.logs.filter((row) => row.tone === 'error').map((row) => row.message);
  const hit = errors.find((text) => text.includes('无法确定题目分组'));
  assert.ok(hit, '应有放弃勾选的报错');
  assert.match(hit, /两个来源都没读到/, '没有数据就说没有数据');
});

// 队列预检：答案过期/残缺时，队列要按「答案不可用」跳过并记账，而不是整队停。
// 实机就是这么卡死的：5 个 [8、面向对象分析] 实验的 L001 被跨实验串台的答案污染
// （页面 1 题、答案 6 题），一开队列就停在第 1 关。
test('预检 choiceAnswerFit：答案题数与关卡对不上时判为不可用', () => {
  const hooks = loadChoiceHooks([]);
  hooks.observeTaskJson('https://data.educoder.net/api/tasks/zq3cef619ac5.json', {
    chooses: [{ position: 1, challenge_question: [1, 2, 3] }]
  });
  hooks.state.levelIndex.zq3cef619ac5 = 'L001';
  hooks.state.optionCounts.zq3cef619ac5 = [3];

  const stale = hooks.choiceAnswerFit({
    1: ['C'], 2: ['C'], 3: ['A'], 4: ['B'], 5: ['A'], 6: ['A', 'B', 'C']
  });
  assert.equal(stale.ok, false, '6 题的答案用不到 1 道题的关卡上');
  assert.match(stale.reason, /本地答案有 6 道题，这一关只有 1 道题（选项数 3）/);

  assert.equal(hooks.choiceAnswerFit({ 1: ['C'] }).ok, true, '题数一致就放行');
});

test('预检 choiceAnswerFit：只有页面数据、页面也取不到题数时不得误判为不可用', () => {
  const hooks = loadChoiceHooks([]);
  // 页面关卡数据没读到、控制台也没给这一关 → 无从判断，交给作答内核按原样报错
  const unknown = hooks.choiceAnswerFit({ 1: ['C'], 2: ['A'] });
  assert.equal(unknown.ok, true, '无从判断时不能一口咬定答案不可用');
  assert.equal(unknown.unknown, true);
});

test('预检 choiceAnswerFit：页面与控制台只要有一个题数对得上就算可用', () => {
  const hooks = loadChoiceHooks([]);
  hooks.observeTaskJson('https://data.educoder.net/api/tasks/zq3cef619ac5.json', {
    chooses: [
      { position: 1, challenge_question: [1, 2, 3, 4] },
      { position: 2, challenge_question: [1, 2, 3, 4] }
    ]
  });
  hooks.state.levelIndex.zq3cef619ac5 = 'L001';
  // 页面给 2 题，控制台给 3 题；答案 3 题 → 控制台那份对得上
  // （控制台的 optionCounts 是按**答案键**存的，即 levelIndex 映射后的 'L001'）
  hooks.state.optionCounts.L001 = [4, 4, 4];
  const fit = hooks.choiceAnswerFit({ 1: ['A'], 2: ['B'], 3: ['C'] });
  assert.equal(fit.ok, true, '任一来源题数一致即认为答案可用');
});

// 回归（10-12 实测）：`readAnswer()` 的返回值是 `{ kind, map }` **包了一层**，
// 题号映射在 `.map` 里。直接对整个返回值取 `Object.keys()` 只会数出 kind/map 两个键，
// 于是「答案其实是对的」被一律判成「题数对不上」——整批选择题被跳过、进了缺答案清单
// （实测「集成测试」存的是 6 道题的正确解答，却被报成「本地答案有 2 道题」）。
test('预检 choiceAnswerFit：readAnswer 的外层包装不能被当成「2 道题」', () => {
  const hooks = loadChoiceHooks([]);
  // 页面：6 道题，选项数 4+2+2+4+2+2（与「集成测试」实测一致）
  hooks.observeTaskJson('https://data.educoder.net/api/tasks/zq3cef619ac5.json', {
    chooses: [4, 2, 2, 4, 2, 2].map((size, i) => ({
      position: i + 1,
      challenge_question: Array.from({ length: size }, (_, k) => k)
    }))
  });
  hooks.state.levelIndex.zq3cef619ac5 = 'L001';

  const parsed = hooks.readAnswer({
    level_id: 'L001',
    kind: 'choice',
    answer: '1:C,D;2:B;3:B;4:A;5:A;6:B'
  });
  assert.equal(Object.keys(parsed.map).length, 6, '多小问答案要解析出 6 道题');

  assert.equal(hooks.choiceAnswerFit(parsed.map).ok, true, '按映射数题数才对得上');
  assert.equal(
    hooks.choiceAnswerFit(parsed).ok, true,
    '直接传 readAnswer 的返回值也要能识别（函数内部解包，别再数出 kind/map 两个键）'
  );
});

// 头歌的「开启挑战」「下一关」会开新标签页：一关攒一个标签页，旧页还停在旧关卡上。
// 这里负责的是「改道」——点击期间接管 window.open / target=_blank，强制当前页跳转。
test('点跳转控件：强制在当前标签页跳转，不许开新标签页', async () => {
  const hooks = loadChoiceHooks([]);
  const host = hooks.pageWindow();
  let opened = 0;
  host.open = () => { opened += 1; return host; };
  const originalOpen = host.open;

  // 真机上「下一关」是个 <a target="_blank"> 包着 <button>
  const attributes = { target: '_blank' };
  const anchor = {
    getAttribute: (name) => (name === 'target' ? attributes.target : null),
    setAttribute: (name, value) => { attributes[name] = value; },
    removeAttribute: (name) => { delete attributes[name]; }
  };
  const button = {
    tagName: 'BUTTON',
    closest: (selector) => (selector === 'a[target]' ? anchor : null),
    click() { host.open('https://www.educoder.net/tasks/next-level'); }
  };

  const intercepted = hooks.clickStayingInThisTab(button, 0);

  assert.equal(opened, 0, '页面想开新标签页，但不该真的开出来');
  assert.equal(host.location.href, 'https://www.educoder.net/tasks/next-level', '要改成当前页跳转');
  assert.equal(attributes.target, '_self', '点击期间锚点的 target 被临时改成 _self');
  assert.equal(
    intercepted, 'https://www.educoder.net/tasks/next-level',
    '要把拦到的地址返回给调用方——点不动时靠它兜底导航'
  );

  await hooks.sleep(30);
  assert.equal(attributes.target, '_blank', '点完要还原 target');
  assert.equal(host.open, originalOpen, '点完要还原 window.open');
});

// 控件点不动（改版/被遮/合成事件没接上）时，至少要知道它想去哪。
// 实测：点「查看实战」后页面毫无反应、日志一片安静，最后只能等超时停队。
test('兜底导航：控件点不动时，能从拦到的地址或锚点 href 推出目标', () => {
  const hooks = loadChoiceHooks([]);

  assert.equal(
    hooks.clickTargetOf(null, 'https://www.educoder.net/tasks/abc'),
    'https://www.educoder.net/tasks/abc',
    '拦到的地址优先'
  );

  const anchor = {
    tagName: 'A',
    getAttribute: (name) => (name === 'href' ? '/tasks/from-href' : null),
    closest: () => null
  };
  assert.equal(
    hooks.clickTargetOf(anchor),
    'https://www.educoder.net/tasks/from-href',
    '锚点 href 要解析成绝对地址'
  );

  const fakeAnchor = {
    tagName: 'A',
    getAttribute: (name) => (name === 'href' ? 'javascript:void(0)' : null),
    closest: () => null
  };
  assert.equal(hooks.clickTargetOf(fakeAnchor), '', 'javascript: 伪地址不能用（跟着走只会原地打转）');

  const button = { tagName: 'BUTTON', getAttribute: () => null, closest: () => null };
  assert.equal(hooks.clickTargetOf(button), '', '什么都拿不到就返回空串，调用方照旧报「点了没反应」');
});

// 万一还是被开走了：旧标签页要安静退场，而且**绝不能**去停共享的队列状态。
// 队列状态存在 GM 存储里、同一个域的所有标签页共用——僵尸页一停，
// 真正在跑的那个标签页也会跟着停。
test('旧标签页退场：别人接手后关掉自己，且不把共享队列写成「已停」', async () => {
  const store = new Map();
  let closed = 0;
  const hooks = loadChoiceHooks([], { store, onClose: () => { closed += 1; } });
  store.set('educoder-teach-queue', {
    running: true,
    activeTabId: 'another-tab',
    activeTabAt: Date.now()
  });

  const stale = await hooks.closeSelfIfStale(50);
  assert.equal(stale, true, '应判定为「已退场」');
  assert.equal(closed, 1, '要尝试关闭自己');
  assert.equal(store.get('educoder-teach-queue').running, true, '绝不能把共享队列写成已停');
});

test('旧标签页退场：自己就是当前标签页时不许关自己', async () => {
  const store = new Map();
  let closed = 0;
  const hooks = loadChoiceHooks([], { store, onClose: () => { closed += 1; } });
  store.set('educoder-teach-queue', {
    running: true,
    activeTabId: hooks.tabId,
    activeTabAt: Date.now()
  });

  const stale = await hooks.closeSelfIfStale(50);
  assert.equal(stale, false);
  assert.equal(closed, 0, '自己正是在干活的那个，不能关');
});

test('旧标签页退场：上一轮残留的认领标识（太旧）不算数', async () => {
  const store = new Map();
  let closed = 0;
  const hooks = loadChoiceHooks([], { store, onClose: () => { closed += 1; } });
  store.set('educoder-teach-queue', {
    running: true,
    activeTabId: 'last-session-tab',
    activeTabAt: Date.now() - 10 * 60 * 1000
  });

  const stale = await hooks.closeSelfIfStale(50);
  assert.equal(stale, false, '太旧的认领记录不能拿来判自己没用了');
  assert.equal(closed, 0);
});

// 「不装本地控制台」这条路的关键一环：班级答案文件（kind: class-answers）里选择题的
// `answer` 是**扁平数组** `[{number, selected}]`（见 class-answers.js 的 levelEntry），
// 不是控制台那种 `{questions: [...]}`。readAnswer 少认这一支，导入的选择题就全是空的。
test('readAnswer：班级答案文件的扁平数组答案要能解析', () => {
  const hooks = loadChoiceHooks([]);
  const parsed = hooks.readAnswer({
    level_id: 'L001',
    kind: 'choice',
    answer: [{ number: 1, selected: ['C'] }, { number: 2, selected: ['A', 'B'] }]
  });
  assert.equal(parsed.kind, 'choice');
  assert.deepEqual(Object.keys(parsed.map), ['1', '2'], '要按小问号建键');
  assert.deepEqual(parsed.map['2'], ['A', 'B'], '多选要保持多字母');
});

test('flattenClassAnswers：班级文件摊平成答案表 + 标识/标题索引', () => {
  const hooks = loadChoiceHooks([]);
  const flat = hooks.flattenClassAnswers({
    kind: 'class-answers',
    class: { grade: '2024级', name: '软工24-15、16班' },
    classrooms: [{
      name: '软件工程导论2026年下半年',
      code: '2i6ng7vp',
      experiments: [
        {
          name: '[8、面向对象分析] 面向对象分析之顺序图',
          levels: [{
            level_id: 'L001',
            title: '顺序图题目初体验',
            kind: 'choice',
            answered: true,
            identifiers: ['v4yiw8px3bur'],
            answer: [{ number: 1, selected: ['C'] }]
          }]
        },
        {
          name: '[8、面向对象分析] 面向对象分析之类图',
          levels: [
            // 与上一个实验同名的关卡：全局不唯一 → 不能进 titleOnlyIndex
            {
              level_id: 'L001', title: '顺序图题目初体验', kind: 'choice', answered: true,
              identifiers: ['dup-id'], answer: [{ number: 1, selected: ['A'] }]
            },
            {
              level_id: 'L002', title: '类图的基本概念', kind: 'choice', answered: false,
              identifiers: ['xisagfyphfqc'], answer: []
            }
          ]
        }
      ]
    }]
  });

  const key = '软件工程导论2026年下半年__[8、面向对象分析] 面向对象分析之顺序图__L001';
  assert.ok(flat.answers[key], '答案要按「班级__实验__L001」复合键存');
  assert.equal(flat.answers[key].classroomCode, '2i6ng7vp', '要带班级码（作答前核对用）');
  assert.equal(flat.stats.levels, 3);
  assert.equal(flat.stats.answered, 2);

  assert.equal(flat.levelIndex['v4yiw8px3bur'], key, '关卡标识要映射到复合键');
  // 实验名带 [分类] 前缀：去前缀的变体也要建，否则关卡页上对不上
  assert.equal(
    flat.titleIndex['面向对象分析之顺序图__顺序图题目初体验'], key,
    '要去掉 [分类] 前缀再建一份标题索引'
  );
  assert.ok(!flat.titleOnlyIndex['顺序图题目初体验'], '同名关卡不许进 titleOnlyIndex（会串答案）');
  assert.ok(
    flat.titleOnlyIndex['类图的基本概念'],
    '全局唯一的关卡名才收进 titleOnlyIndex'
  );
});

// 「从本地加答案」是一个入口两条路：连得上控制台就拉，连不上就选文件。
// 原来是两个菜单项，且没连控制台时点「拉取」只弹一句「还没配本地控制台」就完了——
// 手上明明有班级答案文件却走不通，等于死路。
test('从本地加答案：没配控制台时直接退到「选文件导入」，不是死路提示', () => {
  const hooks = loadChoiceHooks([]);
  hooks.state.local = '';
  hooks.state.token = '';
  assert.equal(hooks.consoleEndpoint('/api/answers'), '', '前提：没配控制台地址');

  hooks.loadAnswersFromLocal();

  const messages = hooks.state.logs.map((row) => row.message);
  assert.ok(
    messages.some((text) => text.includes('改为从本地文件导入')),
    `应退到文件导入，实际日志：${JSON.stringify(messages)}`
  );
});

// 实测（2026-10-12 截图）：头歌自己的 `/api/tasks/{id}.json` 会 **Failed to fetch**，
// 站点同时弹「本地网络不稳定…刷新后重试」。这跟「还没加载完」完全不是一回事：
// 等多久都不会来，**只有刷新页面才能重发**。原来的行为是干等 60 秒然后停队。
test('关卡数据请求失败要能识别，并且不再干等（直接交给刷新重试）', async () => {
  const hooks = loadChoiceHooks([]);

  assert.equal(hooks.taskFetchFailedJustNow(), false, '没失败过就是 false');
  hooks.noteTaskFetchFailure('https://data.educoder.net/api/tasks/zq3cef619ac5.json', 'Failed to fetch');
  assert.equal(hooks.taskFetchFailedJustNow(), true, '当前关卡的失败要认出来');

  // 失败的是**别的**关卡（页面会预取相邻关卡）→ 不能把本关的记录覆盖掉，
  // 也不能因此认为「本关也失败了」。
  hooks.noteTaskFetchFailure('https://data.educoder.net/api/tasks/other-level.json', 'boom');
  assert.equal(hooks.taskFetchFailedJustNow(), true, '别关的失败不该冲掉本关的记录');

  // 本关后来**成功**拉到了 → 失败记号要清掉
  hooks.observeTaskJson('https://data.educoder.net/api/tasks/zq3cef619ac5.json', {
    challenge: { position: 1 },
    chooses: [{ position: 1, challenge_question: [1, 2, 3] }]
  });
  assert.equal(hooks.taskFetchFailedJustNow(), false, '成功后要清掉失败记号');

  // 已知失败 + 过了 bail 门槛 → 立刻收手（不再白等剩下的几十秒）
  hooks.noteTaskFetchFailure('https://data.educoder.net/api/tasks/zq3cef619ac5.json', 'Failed to fetch');
  hooks.state.taskContext = null; // 把观察到的数据清掉，模拟「这一轮没读到」
  const started = Date.now();
  const task = await hooks.waitForLevelData(60_000, 1);
  assert.equal(task, null, '失败时不该继续等');
  assert.ok(Date.now() - started < 3000, '应当很快收手，而不是等到 60 秒超时');
});

test('刷新重试：每关最多 2 次，超了就不再刷（免得无限刷）', async () => {
  const store = new Map();
  let reloads = 0;
  const hooks = loadChoiceHooks([], { store, onReload: () => { reloads += 1; } });

  const queue = { running: true };
  assert.equal(await hooks.reloadForLevelData(queue), true, '第 1 次要刷');
  assert.equal(await hooks.reloadForLevelData(queue), true, '第 2 次要刷');
  assert.equal(await hooks.reloadForLevelData(queue), false, '第 3 次必须收手');
  assert.equal(reloads, 2, '实际只刷新了 2 次');
  assert.equal(queue.reloads.count, 2, '计数记在队列里（刷新后仍然有效）');
});

// 用户要的「一键导出」必须和「导入」是同一个格式，否则导出看着有、导回读不出。
// 这条往返测试就是那句话的机器化：导入 → 构建导出文件 → 再导回来，答案必须一模一样。
test('导出与导入对齐：往返一圈后答案不变（含班级块、关卡标识）', () => {
  const hooks = loadChoiceHooks([]);
  const source = {
    kind: 'class-answers',
    class: { grade: '2024级', name: '软工24-15、16班' },
    classrooms: [{
      name: '软件工程导论2026年下半年',
      code: '2i6ng7vp',
      experiments: [{
        name: '[7、软件测试] 集成测试和确认测试',
        levels: [
          {
            level_id: 'L001', title: '集成测试', kind: 'choice', answered: true,
            identifiers: ['id-a'],
            answer: [{ number: 1, selected: ['C', 'D'] }, { number: 2, selected: ['B'] }]
          },
          {
            level_id: 'L002', title: '确认测试', kind: 'choice', answered: false,
            identifiers: ['id-b'], answer: []
          },
          {
            level_id: 'L003', title: '编程小题', kind: 'code', answered: true,
            identifiers: ['id-c'], answer: { language: 'python', code: 'print(1)' }
          }
        ]
      }]
    }]
  };

  // ① 导入
  const flat = hooks.flattenClassAnswers(source);
  hooks.state.answers = { ...flat.answers };
  hooks.state.levelIndex = { ...flat.levelIndex };
  hooks.state.titleIndex = { ...flat.titleIndex };
  hooks.state.titleOnlyIndex = { ...flat.titleOnlyIndex };
  hooks.state.classInfo = { grade: '2024级', name: '软工24-15、16班' };

  // ② 导出
  const doc = hooks.buildClassAnswersDoc();
  assert.equal(doc.kind, 'class-answers', '导出的必须是班级答案文件格式（才和导入对应）');
  assert.equal(doc.class.name, '软工24-15、16班', '班级块要原样写回');
  const levels = doc.classrooms[0].experiments[0].levels;
  assert.equal(levels.length, 3);
  const l001 = levels.find((item) => item.level_id === 'L001');
  assert.equal(l001.answered, true);
  assert.deepEqual(plain(l001.identifiers), ['id-a'], '关卡标识要写回，否则导入方按标识查不到');
  assert.equal(l001.kind, 'choice');
  assert.deepEqual(
    plain(l001.answer), [{ number: 1, selected: ['C', 'D'] }, { number: 2, selected: ['B'] }],
    '答案形状要与导入要求的一致'
  );
  assert.equal(
    levels.find((item) => item.level_id === 'L002').answered, false,
    '没答案的关卡不能假装有'
  );
  const l003 = levels.find((item) => item.level_id === 'L003');
  assert.equal(l003.kind, 'code', '编程题不能被当成选择题');
  assert.equal(l003.answer.code, 'print(1)');

  // ③ 再导回来 —— 两边必须一致
  const again = hooks.flattenClassAnswers(doc);
  const key = '软件工程导论2026年下半年__[7、软件测试] 集成测试和确认测试__L001';
  const parsed = hooks.readAnswer(again.answers[key]);
  assert.deepEqual(plain(parsed.map), { 1: ['C', 'D'], 2: ['B'] }, '往返一圈后答案必须一模一样');
  assert.equal(again.levelIndex['id-a'], key, '关卡标识映射也要能重建');
  assert.equal(again.answers[again.levelIndex['id-c']].kind, 'code', '编程题的 kind 不能在往返中丢掉');
});

// 「导出本实验全部答案」= 从平台回捞标准答案 → **叠加进已导入的答案库**（不下载文件）。
// 叠加这点必须两条路都通：平台没换标识时按标识，换了标识时按「实验名__关卡名」兜底——
// 只认标识的话，平台重发实验后回捞到的答案就全丢在门外。
test('回捞的标准答案要能叠加进已导入的答案库（标识 / 标题兜底两条路）', () => {
  const hooks = loadChoiceHooks([]);
  const flat = hooks.flattenClassAnswers({
    kind: 'class-answers',
    classrooms: [{
      name: '课程A',
      code: 'C1',
      experiments: [{
        name: '实验B',
        levels: [{
          level_id: 'L001', title: '某关', kind: 'choice', answered: false,
          identifiers: ['old-id'], answer: []
        }]
      }]
    }]
  });
  hooks.state.answers = { ...flat.answers };
  hooks.state.levelIndex = { ...flat.levelIndex };
  hooks.state.titleIndex = { ...flat.titleIndex };
  hooks.state.titleOnlyIndex = { ...flat.titleOnlyIndex };
  const key = Object.keys(flat.answers)[0];

  // ① 按关卡标识叠加
  assert.equal(
    hooks.mergeStandardAnswer({ identifier: 'old-id', position: 1, title: '某关', answer: '1:C;2:A,B' }, '实验B'),
    true
  );
  assert.deepEqual(plain(hooks.readAnswer(hooks.state.answers[key]).map), { 1: ['C'], 2: ['A', 'B'] });
  assert.equal(hooks.state.answers[key].source, 'platform', '要标成平台标准答案（比推导出来的权威）');
  assert.equal(hooks.state.answers[key].verified, true);

  // ② 平台换了标识：按「实验名__关卡名」兜底也能叠加
  hooks.state.answers[key] = { level_id: 'L001', title: '某关', kind: 'choice', answer: [] };
  assert.equal(
    hooks.mergeStandardAnswer({ identifier: 'brand-new-id', position: 1, title: '某关', answer: '1:D' }, '实验B'),
    true,
    '平台重发实验换了标识，靠标题兜底也要能对上'
  );
  assert.deepEqual(plain(hooks.readAnswer(hooks.state.answers[key]).map), { 1: ['D'] });

  // ③ 库里根本没有这一关 → 如实返回 false（调用方据此提示「先去导入」）
  assert.equal(
    hooks.mergeStandardAnswer({ identifier: 'zzz', position: 9, title: '不存在的关', answer: '1:A' }, '实验B'),
    false
  );
});

// 用户明确要求：**库里已经有答案时要覆盖**，不是「已有就跳过」。
// 平台标准答案就是判分依据，比导入来的那份权威，留旧的反而是错的。
test('回捞的标准答案要覆盖库里已有的答案（不是跳过），并算进 overwritten', () => {
  const hooks = loadChoiceHooks([]);
  const flat = hooks.flattenClassAnswers({
    kind: 'class-answers',
    classrooms: [{
      name: '课程A', code: 'C1',
      experiments: [{
        name: '实验B',
        levels: [{
          level_id: 'L001', title: '某关', kind: 'choice', answered: true,
          identifiers: ['old-id'], answer: [{ number: 1, selected: ['A'] }]
        }]
      }]
    }]
  });
  hooks.state.answers = { ...flat.answers };
  hooks.state.levelIndex = { ...flat.levelIndex };
  hooks.state.titleIndex = { ...flat.titleIndex };
  hooks.state.titleOnlyIndex = { ...flat.titleOnlyIndex };
  const key = Object.keys(flat.answers)[0];
  assert.deepEqual(
    plain(hooks.readAnswer(hooks.state.answers[key]).map),
    { 1: ['A'] },
    '前置条件：库里这一关本来是有答案的'
  );

  const stats = { added: 0, overwritten: 0, kept: 0, unplaced: 0 };
  assert.equal(
    hooks.mergeStandardAnswer({ identifier: 'old-id', position: 1, title: '某关', answer: '1:C;2:B' }, '实验B', stats),
    true,
    '已有答案也必须写入（覆盖）'
  );
  assert.deepEqual(
    plain(hooks.readAnswer(hooks.state.answers[key]).map),
    { 1: ['C'], 2: ['B'] },
    '旧答案要被平台标准答案盖掉'
  );
  assert.deepEqual(stats, { added: 0, overwritten: 1, kept: 0, unplaced: 0 }, '要记成 overwritten 而不是 added');

  // 空壳条目（answer 为空）不算「已有答案」→ 记成 added
  hooks.state.answers[key] = { level_id: 'L001', title: '某关', kind: 'choice', answer: [] };
  const stats2 = { added: 0, overwritten: 0, kept: 0, unplaced: 0 };
  hooks.mergeStandardAnswer({ identifier: 'old-id', position: 1, title: '某关', answer: '1:D' }, '实验B', stats2);
  assert.deepEqual(stats2, { added: 1, overwritten: 0, kept: 0, unplaced: 0 }, '原来是空壳 → 记成 added');
});

// 唯一的例外：库里是**代码**答案、回捞到的是选择题标准答案（含选择小题的编程题）。
// 答题时一个条目只能是一种 kind，覆盖会把那份代码彻底弄丢——所以保留代码。
test('库里是代码答案时不许被选择题标准答案覆盖（保留代码）', () => {
  const hooks = loadChoiceHooks([]);
  const flat = hooks.flattenClassAnswers({
    kind: 'class-answers',
    classrooms: [{
      name: '课程A', code: 'C1',
      experiments: [{
        name: '实验B',
        levels: [{
          level_id: 'L001', title: '编程关', kind: 'code', answered: true,
          identifiers: ['code-id'], answer: { language: 'c', code: 'int main(){return 0;}' }
        }]
      }]
    }]
  });
  hooks.state.answers = { ...flat.answers };
  hooks.state.levelIndex = { ...flat.levelIndex };
  hooks.state.titleIndex = { ...flat.titleIndex };
  hooks.state.titleOnlyIndex = { ...flat.titleOnlyIndex };
  const key = Object.keys(flat.answers)[0];

  const stats = { added: 0, overwritten: 0, kept: 0, unplaced: 0 };
  assert.equal(
    hooks.mergeStandardAnswer({ identifier: 'code-id', position: 1, title: '编程关', answer: '1:A' }, '实验B', stats),
    false
  );
  assert.equal(hooks.state.answers[key].kind, 'code', 'kind 不能被改成 choice');
  assert.equal(
    hooks.readAnswer(hooks.state.answers[key]).code,
    'int main(){return 0;}',
    '代码必须原样留着'
  );
  assert.deepEqual(stats, { added: 0, overwritten: 0, kept: 1, unplaced: 0 }, '要记成 kept，好让日志说清「为什么没写」');
});

// 脱控制台时，通过的关卡**必须**自己入库：原来这条答案是 pushAnswerToConsole 回传、
// 由控制台落盘的，纯脚本模式下那条路走不通（只警告一句）——用户跑完一轮会发现
// 答案库还是导入时那么多，「跑队列自动攒答案」等于没发生。
test('通过一关要能把答案收进本地答案库（选择题与编程题都算）', () => {
  const hooks = loadChoiceHooks([]);
  const flat = hooks.flattenClassAnswers({
    kind: 'class-answers',
    classrooms: [{
      name: '课程A',
      code: 'C1',
      experiments: [{
        name: '实验B',
        levels: [
          { level_id: 'L001', title: '选择题', kind: 'choice', answered: false, identifiers: ['sel'], answer: [] },
          { level_id: 'L002', title: '编程题', kind: 'code', answered: false, identifiers: ['cod'], answer: {} }
        ]
      }]
    }]
  });
  hooks.state.answers = { ...flat.answers };
  hooks.state.levelIndex = { ...flat.levelIndex };
  hooks.state.titleIndex = { ...flat.titleIndex };
  hooks.state.titleOnlyIndex = { ...flat.titleOnlyIndex };

  // 选择题：走标准答案那条路
  assert.equal(hooks.harvestPassedAnswer({
    identifier: 'sel', levelId: 'L001', experiment: '实验B', levelName: '选择题',
    kind: 'choice', answer: '1:C;2:A,B'
  }), true);
  const selKey = hooks.state.levelIndex['sel'];
  assert.deepEqual(plain(hooks.readAnswer(hooks.state.answers[selKey]).map), { 1: ['C'], 2: ['A', 'B'] });

  // 编程题：把提交成功的代码写进库
  assert.equal(hooks.harvestPassedAnswer({
    identifier: 'cod', levelId: 'L002', experiment: '实验B', levelName: '编程题',
    kind: 'code', answer: 'print(1)', language: 'python'
  }), true);
  const codeEntry = hooks.state.answers[hooks.state.levelIndex['cod']];
  assert.equal(codeEntry.kind, 'code');
  assert.equal(codeEntry.answer.code, 'print(1)');
  assert.equal(codeEntry.answer.language, 'python');

  // 库里没有这一关 → 如实返回 false
  assert.equal(hooks.harvestPassedAnswer({
    identifier: 'nope', levelId: 'L009', experiment: '实验B', levelName: '不存在',
    kind: 'choice', answer: '1:A'
  }), false);
});

// 实测 16:11：队列还是停在「关卡数据没读到」。原因是**两条入口各写了一份逻辑**——
// maybeContinueTeachQueue（进关卡后的续跑）只等约 9.5 秒就停队，processTeachLevel 那份
// 等面板设置的 60 秒；前者先跑，后者永远轮不到，「60 秒设置不生效」就是这么来的。
// 现在两处共用 ensureLevelData。
test('关卡数据卡住：两条入口共用同一套逻辑，且重试前必须等够间隔', async () => {
  const store = new Map();
  let reloads = 0;
  const hooks = loadChoiceHooks([], { store, onReload: () => { reloads += 1; } });
  // 已知这一关的请求失败 → waitForLevelData 会早退（不会等满 60 秒）
  hooks.noteTaskFetchFailure('https://data.educoder.net/api/tasks/zq3cef619ac5.json', 'Failed to fetch');

  const queue = { running: true };
  const started = Date.now();
  // 注意 gapMs 要**大于** waitForLevelData 的一轮轮询（400ms），否则「补足间隔」这段
  // 本来就会被跳过（elapsed 已经够了），断言就测了个寂寞。
  const ready = await hooks.ensureLevelData(queue, { gapMs: 1200, bailAfterMs: 1 });
  const used = Date.now() - started;

  assert.equal(ready.reloading, true, '卡住要发起刷新重试，而不是停队');
  assert.equal(reloads, 1, '确实刷新了一次');
  assert.ok(used >= 1200, `重试前要等够间隔（这里注入 1200ms），实际 ${used}ms`);
  assert.ok(
    hooks.state.logs.some((row) => row.message.includes('两次重试间隔不少于')),
    '日志要说清「等够间隔再重试」，不然用户看到的就是「怎么又停了」'
  );

  // 重试预算用完 → 如实收手（由调用方去停队并说明）
  const spent = { running: true, reloads: { identifier: 'zq3cef619ac5', count: 2 } };
  hooks.noteTaskFetchFailure('https://data.educoder.net/api/tasks/zq3cef619ac5.json', 'Failed to fetch');
  const giveUp = await hooks.ensureLevelData(spent, { gapMs: 1, bailAfterMs: 1 });
  assert.equal(giveUp.reloading, false, '刷满 2 次就别再刷');
  assert.equal(giveUp.task, null);
});

// 实测 16:23：`结构化分析工具 IPO图` 把整条队列停掉了，原因只是**这一关的答案残缺**
// （库里存成 kind:code、answered:false、answer:null，即只登记了「是编程题」但没存代码）。
// 一关的残缺答案不该拖垮整条队列——与「答案对不上这一关」同一条原则：记账 + 跳过。
test('答案残缺（只登记没存代码）要按缺答案处理，而不是停整队', async () => {
  const hooks = loadChoiceHooks([]);
  const outcome = await hooks.answerCurrentLevel({ answer: { kind: 'code', code: '' } });
  assert.equal(outcome.status, 'blocked');
  assert.equal(outcome.unusableAnswer, true, '要标成「答案本身不可用」，调用方才会记账+跳过');
  assert.match(outcome.text, /没有代码内容/);

  const noAnswer = await hooks.answerCurrentLevel({ answer: null });
  assert.equal(noAnswer.unusableAnswer, true, '没有本地答案同属答案问题');
});

// 进关卡是整页刷新，关卡数据是异步拉的——进页面立刻查常常查不到。
// 实测 12:54:14 进「单元测试」、12:54:24 就判「没读到」停队，而数据 12:54:25 才到。
// 注意：传 0/不传都会走**面板设置**（默认 60 秒），所以测「等不到就收手」必须传显式小值。
test('waitForLevelData：数据已在就立刻返回；没有就按时返回 null', async () => {
  const hooks = loadChoiceHooks([]);
  assert.ok(hooks.state.levelWaitSeconds >= 5, '等待上限要有默认值，且不能太短');
  assert.equal(await hooks.waitForLevelData(1), null, '没有数据时按时收手，不无限等');

  hooks.observeTaskJson('https://data.educoder.net/api/tasks/zq3cef619ac5.json', {
    challenge: { position: 1 },
    chooses: [{ position: 1, challenge_question: [1, 2, 3] }]
  });
  const task = await hooks.waitForLevelData(1);
  assert.ok(task, '数据到了要立刻返回');
  assert.equal(task.id, 'zq3cef619ac5');
  assert.equal(task.levelPosition, 1);
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

// 「导出本实验全部答案」的回捞链路：接口口径要和作答/导入对齐。
test('回捞接口要带 homework_common_id（一实训多作业的课程按作业算序号与答案）', async () => {
  const requested = [];
  const hooks = loadChoiceHooks([], {
    fetch: async (url) => {
      requested.push(String(url));
      return {
        ok: true,
        json: async () => ({ challenge: { subject: '某关', homework_challenge_index: 2, position: 17 } })
      };
    }
  });
  hooks.state.taskContext = { homeworkId: 88000002, id: 'conv' };
  const data = await hooks.fetchTaskData('conv');
  assert.equal(requested.length, 1);
  assert.match(requested[0], /__easBatch=1/, '批量标记不能丢（网络钩子靠它跳过）');
  assert.match(requested[0], /homework_common_id=88000002/, '必须带作业号，否则序号是实训内全局的');
  // 序号取本作业内的 homework_challenge_index（2），不能用全局 position（17）
  assert.equal(hooks.harvestPositionOf(data), 2, '回捞序号要用本作业内的序号，不能用实训内全局序号');
  // 两个都没有时退回 position（老数据形状），再没有就是 0
  assert.equal(hooks.harvestPositionOf({ challenge: { position: 5 } }), 5);
  assert.equal(hooks.harvestPositionOf({ challenge: {} }), 0);
  assert.equal(hooks.harvestPositionOf(null), 0);
});

// 没导入过答案、也不在队列里时，实验名要能从平台关卡数据（homework_common_name）兜底拿到——
// 否则回传控制台的 payload 连实验名都没有，控制台只能猜目录。
test('实验名兜底：队列没有、库里也没有时，用平台关卡数据里给的实验名', () => {
  const hooks = loadChoiceHooks([]);
  hooks.state.taskContext = { experimentName: '平台给的实验名', homeworkId: 88000002 };
  assert.equal(hooks.currentExperimentName(), '平台给的实验名');
  // 队列线索仍然最优先（教学课程流程的实验名是选择界面给的那份）
  hooks.state.levelHint = { experimentName: '队列线索名' };
  assert.equal(hooks.currentExperimentName(), '队列线索名');
  // 都没有 → 空串（调用方自己处理），不能瞎编
  const hooks2 = loadChoiceHooks([]);
  assert.equal(hooks2.currentExperimentName(), '');
});

// 「导出本实验全部答案」此前只收选择题标准答案，纯编程题全部落进 missing——
// 用户实测「导不出编程题的答案」。编程题的第二条来源：**已通过**关卡的仓库代码
// （rep_content.json，提取器同款）。未通过的关卡仓库里是题目模板，绝不能收。
test('编程题答案回捞：取仓库代码（rep_content.json），语言按文件后缀推断', async () => {
  const codeB64 = Buffer.from('#include <stdio.h>\nint main() { return 0; } // 中文注释', 'utf8').toString('base64');
  const requested = [];
  const hooks = loadChoiceHooks([], {
    fetch: async (url) => {
      requested.push(String(url));
      return { ok: true, json: async () => ({ content: { content: codeB64 } }) };
    }
  });
  hooks.state.taskContext = { homeworkId: 88000002 };
  const code = await hooks.fetchLevelCode('conv', 'main.c');
  assert.match(code, /int main/, '代码内容要解出来');
  assert.match(code, /中文注释/, 'base64 要按 UTF-8 解（中文不能乱码）');
  assert.equal(requested.length, 1);
  assert.match(requested[0], /\/api\/tasks\/conv\/rep_content\.json/, '要打仓库文件接口');
  assert.match(requested[0], /path=main\.c/, '要带文件路径');
  assert.match(requested[0], /homework_common_id=88000002/, '要带作业号');
  assert.match(requested[0], /__easBatch=1/, '批量标记不能丢');

  assert.equal(hooks.codeLanguageFromPath('main.c'), 'c');
  assert.equal(hooks.codeLanguageFromPath('Main.java'), 'java');
  assert.equal(hooks.codeLanguageFromPath('run.py'), 'python');
  assert.equal(hooks.codeLanguageFromPath(''), '');
});

test('mergeCodeAnswer：代码答案的覆盖语义与 mergeStandardAnswer 镜像', () => {
  // 夹具：库里已有「白盒测试」实验的两个条目——一个空壳 choice、一个已填 choice
  const hooks = loadChoiceHooks([]);
  const flat = hooks.flattenClassAnswers({
    kind: 'class-answers',
    classrooms: [{
      name: '课程A', code: 'C1',
      experiments: [{
        name: '实验B',
        levels: [
          { level_id: 'L001', title: '空壳关', kind: 'choice', answered: false, identifiers: ['empty-id'], answer: [] },
          { level_id: 'L002', title: '已有选择答案', kind: 'choice', answered: true, identifiers: ['choice-id'], answer: [{ number: 1, selected: ['A'] }] }
        ]
      }]
    }]
  });
  hooks.state.answers = { ...flat.answers };
  hooks.state.levelIndex = { ...flat.levelIndex };
  hooks.state.titleIndex = { ...flat.titleIndex };
  hooks.state.titleOnlyIndex = { ...flat.titleOnlyIndex };
  const emptyKey = hooks.state.levelIndex['empty-id'];
  const choiceKey = hooks.state.levelIndex['choice-id'];

  // ① 空壳条目 → 写入，记 added
  const stats = { added: 0, overwritten: 0, kept: 0, unplaced: 0 };
  assert.equal(
    hooks.mergeCodeAnswer({ identifier: 'empty-id', position: 1, title: '空壳关', answer: 'int main(){}', language: 'c' }, '实验B', stats),
    true
  );
  assert.deepEqual(stats, { added: 1, overwritten: 0, kept: 0, unplaced: 0 });
  const merged = hooks.readAnswer(hooks.state.answers[emptyKey]);
  assert.equal(merged.kind, 'code');
  assert.match(merged.code, /int main/, '代码要进条目');
  assert.equal(hooks.state.answers[emptyKey].source, 'platform', '已通过关卡的代码是平台收下的答案，标记 platform');
  assert.equal(hooks.state.answers[emptyKey].verified, true);

  // ② 库里已有**选择题**答案 → 保留（镜像 mergeStandardAnswer 的代码保护）
  const stats2 = { added: 0, overwritten: 0, kept: 0, unplaced: 0 };
  assert.equal(
    hooks.mergeCodeAnswer({ identifier: 'choice-id', position: 2, title: '已有选择答案', answer: 'print(1)', language: 'python' }, '实验B', stats2),
    false
  );
  assert.deepEqual(stats2, { added: 0, overwritten: 0, kept: 1, unplaced: 0 }, '要记成 kept');
  assert.equal(hooks.readAnswer(hooks.state.answers[choiceKey]).kind, 'choice', '选择题答案不能被代码盖掉');
  assert.deepEqual(plain(hooks.readAnswer(hooks.state.answers[choiceKey]).map), { 1: ['A'] });

  // ③ 库里已有**代码**答案 → 覆盖（新通过的代码更权威）
  const stats3 = { added: 0, overwritten: 0, kept: 0, unplaced: 0 };
  assert.equal(
    hooks.mergeCodeAnswer({ identifier: 'empty-id', position: 1, title: '空壳关', answer: 'int better(){}', language: 'c' }, '实验B', stats3),
    true
  );
  assert.deepEqual(stats3, { added: 0, overwritten: 1, kept: 0, unplaced: 0 }, '要记成 overwritten');
  assert.match(hooks.readAnswer(hooks.state.answers[emptyKey]).code, /better/);

  // ④ 库里没有这一关 → unplaced
  const stats4 = { added: 0, overwritten: 0, kept: 0, unplaced: 0 };
  assert.equal(
    hooks.mergeCodeAnswer({ identifier: 'ghost-id', position: 9, title: '不存在的关', answer: 'x' }, '实验B', stats4),
    false
  );
  assert.deepEqual(stats4, { added: 0, overwritten: 0, kept: 0, unplaced: 1 });

  // ⑤ 空代码不写
  const stats5 = { added: 0, overwritten: 0, kept: 0, unplaced: 0 };
  assert.equal(hooks.mergeCodeAnswer({ identifier: 'empty-id', position: 1, title: '空壳关', answer: '  ' }, '实验B', stats5), false);
  assert.deepEqual(stats5, { added: 0, overwritten: 0, kept: 0, unplaced: 1 });
});
