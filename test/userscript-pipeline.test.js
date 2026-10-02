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
    // dataset 必须是**只读**的（真实 DOM 里只有 getter）。
    // 写成普通可写属性会掩盖「el(tag, { dataset: {...} }) 在严格模式下抛 TypeError」这类 bug——
    // 那个 bug 曾让整个面板不出现，而测试全绿。
    Object.defineProperty(node, 'dataset', {
      enumerable: true,
      get() { return (this.__dataset ||= {}); }
    });
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

/** 扫出所有 `el('tag', { ... })` 的顶层属性名。 */
function elementPropNames(source) {
  const names = new Set();
  const opener = /el\(\s*'[a-z0-9]+'\s*,\s*\{/g;
  let match;
  while ((match = opener.exec(source))) {
    let index = match.index + match[0].length - 1;
    let depth = 0;
    let end = index;
    for (; end < source.length; end += 1) {
      if (source[end] === '{') depth += 1;
      else if (source[end] === '}') {
        depth -= 1;
        if (!depth) break;
      }
    }
    const body = source.slice(index + 1, end);
    let nest = 0;
    let current = '';
    for (const char of body) {
      if ('{(['.includes(char)) nest += 1;
      else if ('})]'.includes(char)) nest -= 1;
      if (char === ',' && nest === 0) {
        current = '';
        continue;
      }
      current += char;
    }
    for (const part of body.split(/,(?![^(\[{]*[)\]}])/)) {
      const key = /^\s*([A-Za-z_$][\w$]*)\s*:/.exec(part);
      if (key) names.add(key[1]);
    }
  }
  return names;
}

test('篡改猴脚本：el() 的 props 里不许出现只读的 DOM 属性（面板消失过一次）', () => {
  // el() 是 `Object.assign(node, props)`。真实 DOM 上 dataset / classList 这类
  // **只有 getter**，严格模式下赋值会抛 TypeError，把 buildPanel 整条打断——
  // 表现就是「面板直接不出现」。这个 bug 真发生过一次，而当时的测试全绿
  // （假 DOM 把 dataset 写成了普通可写属性）。
  const readonly = [
    'dataset', 'classList', 'attributes', 'children', 'parentNode', 'parentElement',
    'ownerDocument', 'firstChild', 'lastChild', 'nextSibling', 'previousSibling',
    'nodeName', 'nodeType', 'tagName', 'offsetParent'
  ];
  const used = elementPropNames(SOURCE);
  const offenders = readonly.filter((name) => used.has(name));
  assert.deepEqual(
    offenders,
    [],
    `这些属性只能创建后再赋（严格模式下赋值会抛错）：${offenders.join(', ')}`
  );

  // 上面那条断言成立的前提：el() 确实用 Object.assign 套 props
  assert.match(
    SOURCE,
    /function el\(tag, props = \{\}, children = \[\]\) \{[\s\S]{0,80}?Object\.assign\(node, props\)/,
    'el() 应当是 createElement + Object.assign'
  );
});

test('步骤条：三项必须在一行、不许被裁、不许太暗', () => {
  // 纯视觉问题只能用「关键属性」来守。曾经三项又矮又暗，看着像「半隐藏」。
  const item = /#eas-panel \.eas-steps li \{([^}]*)\}/.exec(SOURCE);
  assert.ok(item, '要有步骤条 li 的样式');
  const body = item[1];
  assert.match(body, /flex: 1 1 0;/, '三项等分，才能占满一行');
  assert.match(body, /min-width: 0;/, '允许收缩，否则长文本会撑破容器');
  assert.match(body, /white-space: nowrap;/, '不许换行——换行就不是一行了');
  assert.doesNotMatch(body, /\bheight:/, '高度靠 padding 撑；写死高度就会裁字');

  // 标签与摘要都要能省略，否则长课程名会把「课程」两字挤出可视区
  assert.match(SOURCE, /#eas-panel \.eas-steps li > span \{ overflow: hidden; text-overflow: ellipsis; \}/, '标签要能省略');
  assert.match(SOURCE, /\.eas-step-note \{[^}]*text-overflow: ellipsis;/, '摘要要能省略');

  // 未轮到的那两步不能暗到看不见（原来的 #6d7a8c 太暗）
  assert.match(SOURCE, /\.eas-steps li\[data-state="locked"\] \{ color: #6d7a8c; \}/, 'locked 用可读的灰');
  assert.match(SOURCE, /\.eas-steps li\[data-state="active"\] \{[^}]*color: #f0f4fa;/, 'active 要高对比');
});
