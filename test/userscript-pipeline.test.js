'use strict';

/**
 * 篡改猴面板的「课堂流水线」：读课程 → 选实验 → 选关卡。
 *
 * 这三步是顺序的，同一时刻只有一步是活的。原来三块竖着堆，前两块做完就只剩占地方，
 * 而且「一键答题」和「停止」被拆到两个地方。这里锁住改造后的结构：
 * 步骤条在顶、单步内容、一键答题与停止同行、辅助按钮沉到底部。
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

/** 起一个能建出面板的假页面（与 userscript-panel.test.js 同一套路）。 */
function boot() {
  const store = {};
  const created = [];
  const makeEl = (tag) => {
    const node = {
      tagName: String(tag).toUpperCase(),
      id: '',
      className: '',
      children: [],
      attrs: {},
      dataset: {},
      style: {},
      textContent: '',
      hidden: false,
      append(...items) { this.children.push(...items); return this; },
      appendChild(item) { this.children.push(item); return item; },
      replaceChildren(...items) { this.children = items; },
      setAttribute(name, value) { this.attrs[name] = String(value); },
      getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null; },
      removeAttribute(name) { delete this.attrs[name]; },
      addEventListener(type, handler) { (this.listeners ||= {})[type] = handler; },
      removeEventListener() {},
      querySelector(selector) {
        const wanted = String(selector).replace(/^#/, '').toUpperCase();
        const walk = (current) => {
          for (const child of current.children || []) {
            if (child.tagName === wanted) return child;
            const found = walk(child);
            if (found) return found;
          }
          return null;
        };
        return walk(this);
      },
      querySelectorAll() { return []; },
      closest() { return null; },
      remove() {},
      click() {
        const event = { preventDefault() {}, stopPropagation() {} };
        if (typeof this.onclick === 'function') this.onclick(event);
      },
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 380, height: 600 })
    };
    created.push(node);
    return node;
  };

  function FakeXHR() {}
  FakeXHR.prototype.open = function open() {};
  FakeXHR.prototype.send = function send() {};
  FakeXHR.prototype.setRequestHeader = function setRequestHeader() {};

  const hooks = { __skipBoot: false };
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
    URL,
    URLSearchParams,
    JSON,
    Math,
    Date,
    Number,
    String,
    Boolean,
    Array,
    Object,
    RegExp,
    Error,
    Promise,
    Map,
    Set,
    fetch: () => Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve('{}'),
      json: () => Promise.resolve({})
    }),
    XMLHttpRequest: FakeXHR,
    MutationObserver: function MutationObserver() {
      return { observe() {}, disconnect() {}, takeRecords: () => [] };
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    cancelAnimationFrame: () => {},
    GM_getValue: (key, fallback) => (key in store ? store[key] : fallback),
    GM_setValue: (key, value) => { store[key] = value; },
    GM_registerMenuCommand: () => {},
    GM_xmlhttpRequest: () => {},
    location: { pathname: '/tasks/HCEAP94S/3965745/vrtbzlmexi3f', href: 'https://www.educoder.net/', search: '', hash: '' },
    document: {
      readyState: 'complete',
      head: { append() {} },
      body: { append() {} },
      addEventListener: () => {},
      getElementById: (id) => created.find((node) => node.id === id || node.attrs.id === id) || null,
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: makeEl
    }
  };
  sandbox.window = sandbox;
  sandbox.unsafeWindow = sandbox;
  sandbox.window.__educoderAutosubmitTestHooks = hooks;
  vm.createContext(sandbox);
  new vm.Script(SOURCE).runInContext(sandbox);
  return { hooks, store, created, find: (id) => created.find((node) => node.id === id) };
}

/**
 * 按 DOM 顺序收集子树里的 id。
 * `created` 是**创建顺序**（子节点先于父节点），不等于同级先后，所以必须自己走一遍。
 */
function domOrder(node, out = []) {
  if (!node) return out;
  if (node.id) out.push(node.id);
  for (const child of node.children || []) domOrder(child, out);
  return out;
}

test('课堂流水线：三步一条线，初始只显示第 1 步', () => {
  const built = boot();
  const bar = built.find('eas-steps');
  assert.ok(bar, '要有步骤条');
  assert.equal(bar.children.length, 3, '课程 / 实验 / 关卡 三步');
  assert.deepEqual(
    bar.children.map((item) => item.dataset.state),
    ['active', 'locked', 'locked'],
    '还没读到实验，所以停在第一步、后两步锁着'
  );

  const panes = ['eas-pane-course', 'eas-pane-experiments', 'eas-pane-levels'];
  const visible = panes.filter((id) => {
    const pane = built.find(id);
    return pane && !pane.hidden;
  });
  assert.deepEqual(visible, ['eas-pane-course'], '同一时刻只显示一步');
});

test('课堂流水线：一键答题与停止在同一行', () => {
  const built = boot();
  const runRow = built.created.find((node) => Array.isArray(node.children)
    && node.children.some((child) => child.id === 'eas-teach-run')
    && node.children.some((child) => child.id === 'eas-stop'));
  assert.ok(runRow, '「一键答题（选中）」和「停止」必须在同一行——它们是同一件事的两面');
});

test('课堂流水线：课堂在上面，辅助按钮沉到下面', () => {
  const built = boot();
  const body = built.created.find((node) => node.className === 'eas-body');
  assert.ok(body, '面板要有 body');
  const order = domOrder(body);

  const steps = order.indexOf('eas-steps');
  const run = order.indexOf('eas-teach-run');
  const pull = order.indexOf('eas-pull');
  const logs = order.indexOf('eas-export-logs');
  assert.ok(steps >= 0 && run >= 0 && pull >= 0 && logs >= 0, '顺序里有缺失：' + order.join(','));
  assert.ok(steps < run, '步骤条要在一键答题之前');
  assert.ok(run < pull, '一键答题要在辅助按钮（从本地拉答案）之前');
  assert.ok(pull < logs, '辅助按钮之间保持原顺序');
});

test('课堂流水线：跳不到还没走到的步骤', () => {
  const built = boot();
  const bar = built.find('eas-steps');
  const third = bar.children[2];
  assert.equal(typeof third.onclick, 'function', '步骤要可点');

  // 还没读到实验：点第 3 步应当被拒绝，而不是显示一个空列表让人以为坏了
  third.onclick();
  assert.equal(third.dataset.state, 'locked', '跳不过去，仍停在第一步');
  assert.equal(bar.children[0].dataset.state, 'active');
});
