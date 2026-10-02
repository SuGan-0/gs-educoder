'use strict';

/**
 * 篡改猴面板的行为测试：整体收起、课堂区常驻、签名常量自动同步。
 *
 * 这几件事都属于「用户天天碰、但坏了不会报错」的那类：
 * 面板收不起来只是碍事，签名常量同步失败只会在真正要用签名时才炸——
 * 而那时用户看到的是一句「缺少签名常量」，完全不知道该怎么修。
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

/** 只看签名接口的请求：boot 还会发别的请求（缺答案清单等），不能一把数。 */
const signingRequests = (built) => built.requests.filter((item) => String(item.url).includes('/api/signing-keys'));

/**
 * 起一个最小可用的假页面 + GM 存储。
 *
 * @param {{pathname?: string, gm?: object, requests?: Array}} options
 *   `requests` 会收集 GM_xmlhttpRequest 的调用，用来验证「是否真的去拉了」。
 */
function boot({ pathname = '/tasks/HCEAP94S/3965745/vrtbzlmexi3f', gm = {}, requests = [] } = {}) {
  const store = { ...gm };
  const created = [];
  const makeEl = (tag) => {
    const node = {
      tagName: String(tag).toUpperCase(),
      children: [],
      attrs: {},
      style: {},
      dataset: {},
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
      // makeDraggable(panel, panel.querySelector('header')) 真的会用到，
      // 返回 null 会让 boot 抛错。按标签名在最深一层里找第一个。
      querySelector(selector) {
        const wanted = String(selector).replace(/^#/, '').toUpperCase();
        const walk = (node) => {
          for (const child of node.children || []) {
            if (child.tagName === wanted || child.attrs.id === String(selector).replace(/^#/, '')) return child;
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
      // el() 用 Object.assign 设 onclick（属性），不是 addEventListener
      click() {
        const event = { preventDefault() {}, stopPropagation() {} };
        if (typeof this.onclick === 'function') this.onclick(event);
        if (this.listeners && this.listeners.click) this.listeners.click(event);
      },
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 380, height: 600 })
    };
    created.push(node);
    return node;
  };

  // 默认 __skipBoot 会让脚本只挂纯函数、不启动面板（其它测试靠它保持轻量）。
  // 这个文件要验的正是面板本身，所以显式关掉跳过。
  const hooks = { __skipBoot: false };

  // boot() 会装网络钩子（拦截页面的 fetch / XHR 来观察关卡数据与提交结果），
  // 所以这两样必须存在，否则 boot 直接抛错、面板根本建不出来。
  function FakeXHR() {}
  FakeXHR.prototype.open = function open() {};
  FakeXHR.prototype.send = function send() {};
  FakeXHR.prototype.setRequestHeader = function setRequestHeader() {};

  const sandbox = {
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
    // boot() 里 makeDraggable 要挂 window 上的 resize/pointer 事件
    addEventListener: () => {},
    removeEventListener: () => {},
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    cancelAnimationFrame: () => {},
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
    Blob: function Blob() {},
    GM_getValue: (key, fallback) => (key in store ? store[key] : fallback),
    GM_setValue: (key, value) => { store[key] = value; },
    GM_registerMenuCommand: () => {},
    GM_xmlhttpRequest: (options) => { requests.push(options); },
    location: { pathname, href: `https://www.educoder.net${pathname}`, search: '', hash: '' },
    document: {
      readyState: 'complete',
      head: { append() {} },
      body: { append() {} },
      addEventListener: () => {},
      // 脚本的 el() 是 `Object.assign(node, props)`——id 是**属性**而不是 attribute，
      // 所以这里必须同时看 node.id 与 attrs.id。
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
  return { hooks, store, created, requests, sandbox };
}

test('面板：默认展开，点一下能收起，状态记进 GM', () => {
  // 脚本 boot() 会自动建面板；这里直接找它建出来的节点
  const built = boot();
  const builtPanel = built.created.find((node) => node.id === 'eas-panel');
  assert.ok(builtPanel, 'boot 时应当建出面板');

  const foldButton = built.created.find((node) => node.id === 'eas-panel-fold');
  assert.ok(foldButton, '标题栏要有收起按钮');
  assert.equal(builtPanel.getAttribute('data-folded'), 'false', '默认展开');
  assert.equal(foldButton.textContent, '收起 ▴');

  foldButton.click();
  assert.equal(builtPanel.getAttribute('data-folded'), 'true', '点一下应收起');
  assert.equal(foldButton.textContent, '展开 ▾');
  assert.equal(foldButton.getAttribute('aria-expanded'), 'false');
  assert.equal(built.store['educoder-panel-folded'], true, '收起状态要记进 GM');

  foldButton.click();
  assert.equal(builtPanel.getAttribute('data-folded'), 'false', '再点一下展开');
  assert.equal(built.store['educoder-panel-folded'], false);

});

test('面板：上次收起过的话，刷新后保持收起（不自己弹开）', () => {
  const built = boot({ gm: { 'educoder-panel-folded': true } });
  const builtPanel = built.created.find((node) => node.id === 'eas-panel');
  assert.equal(builtPanel.getAttribute('data-folded'), 'true', '刷新后应保持收起');
  const foldButton = built.created.find((node) => node.id === 'eas-panel-fold');
  assert.equal(foldButton.textContent, '展开 ▾');
});

test('课堂区：主要控件都在，且没有多余的折叠层', () => {
  // 课堂区改成了「步骤条 + 单步内容」（见 userscript-pipeline.test.js）。
  // 这里只守住一件事：该有的控件一个不少，且不再有「课堂区自己的折叠按钮」——
  // 收起来的职责统一交给面板整体的收起。
  const built = boot();
  for (const id of [
    'eas-teach-course',
    'eas-teach-experiments',
    'eas-teach-levels',
    'eas-teach-run',
    'eas-teach-missing',
    'eas-teach-status'
  ]) {
    assert.ok(built.created.some((node) => node.id === id), `缺控件：${id}`);
  }
  assert.equal(
    built.created.find((node) => node.id === 'eas-teach-fold'),
    undefined,
    '课堂区自己的折叠按钮应已移除'
  );
  assert.equal(
    built.created.find((node) => node.id === 'eas-teach-body'),
    undefined,
    '旧的「一块折叠区」结构应已被流水线取代'
  );
});

test('签名常量：已配置过就不再打扰控制台', () => {
  const built = boot({ gm: { 'educoder-sign-ak': 'x'.repeat(40), 'educoder-sign-sk': 'y'.repeat(40) } });
  assert.equal(signingRequests(built).length, 0, '已配好就不该再发请求');
});

test('签名常量：没配过时向控制台拉一次，并缓存进 GM', async () => {
  const requests = [];
  const built = boot({ gm: { 'educoder-local-console': 'http://127.0.0.1:43127', 'educoder-local-token': 'a'.repeat(48) }, requests });
  const request = requests.find((item) => String(item.url).includes('/api/signing-keys'));
  assert.ok(request, '应当向控制台请求签名常量');
  assert.match(String(request.url), /token=a{48}/, '必须带上 token，否则控制台会 403');

  // 模拟控制台返回
  request.onload({ status: 200, responseText: JSON.stringify({ ok: true, ak: 'AKVALUE', sk: 'SKVALUE', version: '2026-09-24' }) });
  assert.equal(built.store['educoder-sign-ak'], 'AKVALUE', '拿到的常量要写进 GM');
  assert.equal(built.store['educoder-sign-sk'], 'SKVALUE');
});

test('签名常量：没配过地址时也按固定端口试一次（零配置的全部代价）', () => {
  const built = boot();
  const requests = signingRequests(built);
  assert.equal(requests.length, 1, '应当按默认端口试一次——地址已固定，不需要用户先配');
  assert.match(
    String(requests[0].url),
    /^http:\/\/127\.0\.0\.1:43127\/api\/signing-keys/,
    '要打到与 extractor/run.js 一致的固定端口'
  );

  // 没带 token 时控制台会 403：静默失败，不打扰用户、也不写入任何东西
  requests[0].onload({ status: 403, responseText: '{"ok":false,"error":"未授权"}' });
  assert.equal(built.store['educoder-sign-ak'], undefined, '失败时不该写入常量');
  assert.equal(built.store['educoder-sign-sk'], undefined);
});

test('面板：标题栏里的按钮不能被拖动逻辑吃掉（「收起没效果」的根因）', () => {
  const built = boot();
  const header = built.created.find((node) => node.tagName === 'HEADER');
  const button = built.created.find((node) => node.id === 'eas-panel-fold');
  assert.ok(header && button, '标题栏与收起按钮都要在');

  const handler = header.listeners && header.listeners.pointerdown;
  assert.ok(handler, '标题栏应挂了 pointerdown（拖动）');

  let captured = false;
  header.setPointerCapture = () => { captured = true; };
  const press = (target) => handler({
    button: 0,
    pointerId: 1,
    clientX: 10,
    clientY: 10,
    target,
    preventDefault() {}
  });

  // 点在按钮上：绝不能抢指针捕获。
  // 一旦 setPointerCapture，后续 click 会派发到捕获元素（标题栏）而不是按钮，
  // 按钮就永远点不动——「收起没效果」就是这么来的。
  press({ closest: () => button });
  assert.equal(captured, false, '点按钮时不该抢指针捕获，否则按钮收不到 click');

  // 点在标题栏空白处：拖动要照常工作
  press({ closest: () => null });
  assert.equal(captured, true, '点标题栏空白处应正常开始拖动');
});
