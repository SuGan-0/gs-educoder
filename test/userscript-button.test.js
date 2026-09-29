'use strict';

/**
 * 篡改猴脚本的**行为**测试（离线，不需要浏览器、不联网）。
 *
 * 做法：给脚本一个最小可用的假 `document` / `window` / `GM_*`，在 `vm` 里真跑一遍，
 * 然后拿**真实页面上的按钮 HTML**去验证匹配结果。
 *
 * 为什么必须是行为测试而不是字符串断言：
 * 按钮匹配已经错过两次——先是只匹配「提交」而漏掉「评测」，
 * 后来又用带 `^$` 锚点的模式去匹配「文本 + title」的拼接结果。
 * 这两种错误字符串断言都发现不了，只有真跑代码才看得见。
 *
 * 运行：node --test test/userscript-button.test.js
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
 * 造一个假按钮。
 * @param {{text?: string, title?: string, aria?: string, value?: string, class?: string, disabled?: boolean, hidden?: boolean}} options
 */
function fakeButton(options = {}) {
  const attrs = {
    title: options.title,
    'aria-label': options.aria,
    class: options.class
  };
  return {
    textContent: options.text || '',
    value: options.value,
    disabled: Boolean(options.disabled),
    getAttribute(name) {
      const value = attrs[name];
      return value === undefined ? null : value;
    },
    getClientRects() {
      return options.hidden ? [] : [{}];
    },
    disabled: Boolean(options.disabled)
  };
}

/** 在假 DOM 里加载脚本，拿回测试钩子。 */
function loadHooks(buttons) {
  const hooks = {};
  const fakeDocument = {
    querySelectorAll: () => buttons,
    querySelector: () => null,
    getElementById: () => null,
    createElement: () => ({ style: {}, append() {}, addEventListener() {}, setAttribute() {} }),
    head: { append() {} },
    body: { append() {} }
  };
  const sandbox = {
    window: { __educoderAutosubmitTestHooks: hooks },
    document: fakeDocument,
    location: { pathname: '/tasks/j5nxiy2lfu8m', href: 'https://www.educoder.net/tasks/j5nxiy2lfu8m' },
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
  assert.ok(typeof hooks.findButton === 'function', '测试钩子应该被挂上（脚本应提前返回、不启动面板）');
  return hooks;
}

/** 用户从真实页面复制过来的按钮：可见文本「评测」、title「运行评测」。 */
const REAL_EVALUATE_BUTTON = fakeButton({
  text: '\n                ',
  title: '运行评测',
  class: 'btn-run___fh7pl'
});
// <b>评测</b> 在 textContent 里就是「评测」
REAL_EVALUATE_BUTTON.textContent = '\n                评测 ';

test('按钮匹配：真实页面上的「评测」按钮（文本=评测、title=运行评测）必须能找到', () => {
  const hooks = loadHooks([REAL_EVALUATE_BUTTON]);
  const found = hooks.findButton(hooks.SUBMIT_PATTERNS);
  assert.ok(found, '找不到「评测」按钮——这正是用户在真实页面上遇到的问题');
  assert.equal(hooks.buttonLabel(found), '评测', '日志里应报可见文本「评测」');
});

test('按钮匹配：带空白的文本与 <b> 包裹都要能识别', () => {
  const hooks = loadHooks([fakeButton({ text: '  提 交  ' })]);
  const found = hooks.findButton(hooks.SUBMIT_PATTERNS);
  assert.ok(found, '「提 交」去空白后应匹配');
  assert.equal(hooks.buttonLabel(found), '提交');
});

test('按钮匹配：优先级由模式顺序决定，不按 DOM 顺序', () => {
  // 「运行」排在「评测」前面时，也必须点「评测」——评测才是提交判分那个
  const hooks = loadHooks([
    fakeButton({ text: '运行', title: '运行代码' }),
    fakeButton({ text: '评测', title: '运行评测' })
  ]);
  const found = hooks.findButton(hooks.SUBMIT_PATTERNS);
  assert.equal(hooks.buttonLabel(found), '评测', '两个都在时必须选中「评测」');
});

test('按钮匹配：常见文案都能识别，禁用的不算', () => {
  for (const text of ['提交', '提交本题', '交卷', '评测', '测评', '运行']) {
    const hooks = loadHooks([fakeButton({ text })]);
    assert.ok(hooks.findButton(hooks.SUBMIT_PATTERNS), `「${text}」应被识别为提交类按钮`);
  }
  const disabled = loadHooks([fakeButton({ text: '提交', disabled: true })]);
  assert.equal(disabled.findButton(disabled.SUBMIT_PATTERNS), null, '禁用中的按钮不能点');
});

test('按钮匹配：什么都不是的页面返回 null（而不是随便点一个）', () => {
  const hooks = loadHooks([fakeButton({ text: '收藏' }), fakeButton({ text: '分享' })]);
  assert.equal(hooks.findButton(hooks.SUBMIT_PATTERNS), null);
});

test('按钮枚举：找不到时要能报出「评测[运行评测]」这种可核对的信息', () => {
  const hooks = loadHooks([
    fakeButton({ text: '评测', title: '运行评测' }),
    fakeButton({ text: '收藏' }),
    fakeButton({ text: '隐藏的', hidden: true })
  ]);
  const labels = hooks.describeButtons();
  assert.ok(labels.includes('评测[运行评测]'), `应带 title 便于核对，实际：${JSON.stringify(labels)}`);
  assert.ok(labels.includes('收藏'));
  assert.ok(!labels.includes('隐藏的'), '不可见的按钮不该列出来');
});

test('按钮匹配：「题目1未提交」是状态标签，不能当提交按钮', () => {
  const hooks = loadHooks([
    fakeButton({ text: '题目1未提交' }),
    fakeButton({ text: '评测', title: '运行评测' })
  ]);
  const found = hooks.findButton(hooks.SUBMIT_PATTERNS);
  assert.ok(found, '要能找到「评测」按钮');
  assert.equal(hooks.buttonLabel(found), '评测', '不能点「题目1未提交」状态标签');
});

test('按钮匹配：只有状态标签、没有真提交按钮时返回 null', () => {
  const hooks = loadHooks([
    fakeButton({ text: '题目1未提交' }),
    fakeButton({ text: '题目2已提交' })
  ]);
  assert.equal(hooks.findButton(hooks.SUBMIT_PATTERNS), null, '状态标签不是提交动作');
});

test('按钮匹配：最后一关的通关按钮是「完成」，也要当成「下一关」', () => {
  const hooks = loadHooks([fakeButton({ text: '完成' })]);
  const found = hooks.findButton(hooks.NEXT_LEVEL_PATTERNS);
  assert.ok(found, '「完成」必须被认出来，否则最后一关永远判不到通过');
  assert.equal(hooks.buttonLabel(found), '完成');
});

test('按钮匹配：「已完成 / 未完成」是状态标签，不能当通关按钮', () => {
  const hooks = loadHooks([fakeButton({ text: '已完成' }), fakeButton({ text: '未完成' })]);
  assert.equal(hooks.findButton(hooks.NEXT_LEVEL_PATTERNS), null, '进度文案不是按钮动作');
});

test('按钮匹配：绝不能匹配到本脚本自己的面板按钮（曾点错「一键作答并提交」）', () => {
  // 面板自己的按钮：closest('#eas-panel') 命中 → 必须被排除。
  // 曾经因为它含「提交」二字被 /提交/ 命中，导致「本该点页面的评测」变成点自己，
  // 触发双重流程、最后卡在「当前状态未提交」。
  const panelButton = {
    textContent: '一键作答并提交',
    value: '',
    disabled: false,
    getAttribute: () => null,
    closest: (selector) => (selector === '#eas-panel' ? {} : null),
    getClientRects: () => [{}]
  };
  const pageButton = fakeButton({ text: '评测', title: '运行评测' });
  const hooks = loadHooks([panelButton, pageButton]);
  const found = hooks.findButton(hooks.SUBMIT_PATTERNS);
  assert.ok(found, '要能找到真正的提交按钮');
  assert.equal(hooks.buttonLabel(found), '评测', '不能点自己的面板按钮');
});

test('按钮匹配：面板按钮是唯一候选时，宁可找不到也不能点自己', () => {
  const panelButton = {
    textContent: '一键作答并提交',
    value: '',
    disabled: false,
    getAttribute: () => null,
    closest: (selector) => (selector === '#eas-panel' ? {} : null),
    getClientRects: () => [{}]
  };
  const hooks = loadHooks([panelButton]);
  assert.equal(hooks.findButton(hooks.SUBMIT_PATTERNS), null, '自己的按钮永远不是页面按钮');
});
