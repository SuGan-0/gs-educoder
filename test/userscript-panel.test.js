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
    // dataset 必须是**只读**的（真实 DOM 里只有 getter）。
    // 写成普通可写属性会掩盖「el(tag, { dataset: {...} }) 在严格模式下抛 TypeError」这类 bug。
    Object.defineProperty(node, 'dataset', {
      enumerable: true,
      get() { return (this.__dataset ||= {}); }
    });
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
    // 真实页面上下文有这两个：签名常量的校验要解双 base64（缺了它校验无法工作）
    btoa: (value) => Buffer.from(String(value), 'binary').toString('base64'),
    atob: (value) => Buffer.from(String(value), 'base64').toString('binary'),
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

/**
 * 一份**形状真实**的签名常量夹具：双 base64（解两次得到可打印 ASCII）。
 * 不用真实 AK/SK——发布版脚本与测试都不携带平台常量。
 */
const FIXTURE_AK_B64 = Buffer.from(Buffer.from('0123456789abcdef0123456789abcdef', 'utf8').toString('base64'), 'utf8').toString('base64');
const FIXTURE_SK_B64 = Buffer.from(Buffer.from('fedcba98765432100123456789abcdef', 'utf8').toString('base64'), 'utf8').toString('base64');

test('签名常量：已配置过就不再打扰控制台', () => {
  const built = boot({ gm: { 'educoder-sign-ak': FIXTURE_AK_B64, 'educoder-sign-sk': FIXTURE_SK_B64 } });
  assert.equal(signingRequests(built).length, 0, '已配好就不该再发请求');
});

// 存着一份**解不出来**的常量（比如手粘时只粘了「解过一次」的那串）：不能再当成「已配好」。
// 以前只检查「存过没有」，于是这种值会被算作已配置 → 状态总览显示「签名常量✓」，
// 而请求一路被拒、报的还是 `-102 服务器时间不匹配`（跟时间无关）。
test('签名常量：存着但解不出来的值不算「已配置」，仍会向控制台要一次', () => {
  const built = boot({ gm: { 'educoder-sign-ak': 'x'.repeat(40), 'educoder-sign-sk': 'y'.repeat(40) } });
  assert.equal(signingRequests(built).length, 1, '解不出来的常量不该被认为已配好');
});

// 常量已**内置**进脚本（10-14 用户要求「固定进篡改猴」）：GM 空也不再向控制台拉——
// signingRequests 必须为 0，内置值直接种进 GM（「设置签名常量」菜单的预填走同一条路）。
test('签名常量：内置常量生效，空 GM 也不向控制台拉（直接种进 GM）', () => {
  const built = boot({ gm: { 'educoder-local-console': 'http://127.0.0.1:43127', 'educoder-local-token': 'a'.repeat(48) } });
  assert.equal(signingRequests(built).length, 0, '内置常量生效时不该再向控制台请求');
  const { validateSigningKey } = built.hooks;
  assert.equal(validateSigningKey(built.store['educoder-sign-ak']).ok, true, '种进 GM 的内置 AK 要通过校验');
  assert.equal(validateSigningKey(built.store['educoder-sign-sk']).ok, true, '种进 GM 的内置 SK 要通过校验');
});

test('签名常量：没配控制台地址时同样不打扰（内置常量开箱即用）', () => {
  const built = boot();
  assert.equal(signingRequests(built).length, 0, '没有地址也不该发请求——常量已经内置');
  assert.ok(built.store['educoder-sign-ak'], '内置值要种进 GM');
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

test('面板：有「连接本地控制台」入口（第一次用最先要做的事）', () => {
  const built = boot();
  const button = built.created.find((node) => node.id === 'eas-connect');
  assert.ok(button, '面板上必须有连接本地控制台的按钮——只放篡改猴菜单里，新用户根本找不到');
  assert.match(button.textContent, /连接本地控制台/);
});

test('样式：必须显式声明 [hidden]，否则被 display:flex 顶掉（三个步骤面板会一起显示）', () => {
  // [hidden]{display:none} 来自**浏览器默认样式表**，作者样式里的
  // .eas-step-pane{display:flex} 优先级更高、会把它顶掉。
  // 控制台那边一直有这条，篡改猴这边漏过一次，表现就是「UI 重叠」。
  assert.match(
    SOURCE,
    /#eas-panel \[hidden\] \{ display: none !important; \}/,
    '缺了这条，hidden 的步骤面板照样显示'
  );
});

test('只应有一个控制台传输实现', () => {
  // 曾经同时存在两个同名 consoleRequest（签名不同）；函数声明会提升，
  // 后定义的那个悄悄赢掉，新调用被旧签名解释。这类重复必须为 0。
  const definitions = (SOURCE.match(/^\s*function consoleRequest\(/gm) || []).length;
  assert.equal(definitions, 1, `consoleRequest 只能有一个定义，实际 ${definitions} 个`);
  const transports = (SOURCE.match(/GM_xmlhttpRequest\(\{/g) || []).length;
  assert.equal(transports, 1, `GM_xmlhttpRequest 只应出现在传输层里，实际 ${transports} 处`);
});

test('传输层：连不上存的地址时自动改用默认地址重试并更正', () => {
  // 控制台端口曾经随机分配，GM 里可能存着指向早已不存在的端口的地址；
  // 症状却是「签名常量同步不到 → 课程读取失败」这种毫不相干的报错。
  // 传输层的重试是 consoleRequest 的通用行为（签名同步之外的所有控制台请求都走它），
  // 这里直接驱动它验证——不再依赖「签名常量同步」这条已经内置化了的触发路径。
  const built = boot({
    gm: {
      'educoder-local-console': 'http://127.0.0.1:61238',
      'educoder-local-token': 't'.repeat(40)
    }
  });
  const keyRequests = () => built.requests.filter((item) => String(item.url).includes('/api/answer/save'));
  built.hooks.consoleRequest('/api/answer/save', {
    method: 'POST',
    body: { identifier: 'x', answer: '1:A' },
    onload: () => {},
    onerror: () => {}
  });
  assert.equal(keyRequests().length, 1, '先按存的地址试一次');
  assert.match(String(keyRequests()[0].url), /:61238/, '第一次用的是存下来的（过期）地址');

  keyRequests()[0].onerror();
  assert.equal(keyRequests().length, 2, '连不上要自动改用默认地址重试一次');
  assert.match(String(keyRequests()[1].url), /127\.0\.0\.1:43127/, '重试要用固定的默认端口');

  // 重试成功 → 把地址更正过来并持久化，免得下次又白试一遍
  keyRequests()[1].onload({ status: 200, responseText: '{"ok":true}' });
  assert.equal(built.store['educoder-local-console'], 'http://127.0.0.1:43127', '地址要更正');
});
