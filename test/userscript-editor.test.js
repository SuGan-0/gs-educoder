'use strict';

/**
 * 「头歌代码编辑器怎么找」的行为测试（离线）。
 *
 * 真机实测（2026-09-28，编程风格第 1 关）：
 *   - 编辑器是 **monaco**，DOM 在顶层文档（没有 iframe）：`.monaco-editor[data-uri="inmemory://model/1"]`
 *     + `.view-lines` + 1×1 的 `.inputarea`；
 *   - 页面把 monaco 挂在 **`window.Monaco`（大写 M）**，旧的 `window.monaco`（小写）是 undefined
 *     → 旧脚本三样（monaco / .CodeMirror / 大 textarea）全落空，报「页面上找不到代码编辑器」；
 *   - 脚本带 `@grant`，`window` 是油猴沙箱的 window，读页面全局必须走 `unsafeWindow`
 *     （与 fetch 钩子同一个坑）；
 *   - 页面还暴露 `window.updateMonacoValue`（把编辑器内容同步回 React state）。
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

function makeModel(uri, value) {
  return {
    uri,
    value,
    getValue() {
      return this.value;
    },
    setValue(next) {
      this.value = next;
    }
  };
}

function loadEditorHooks({
  models = [],
  dataUri = '',
  textarea = null,
  codeMirror = false,
  updateMonacoValue = null
} = {}) {
  const hooks = {};
  const editorContainer = dataUri ? { getAttribute: (name) => (name === 'data-uri' ? dataUri : null) } : null;
  const fakeDocument = {
    querySelectorAll: (selector) => (selector === 'textarea' && textarea ? [textarea] : []),
    querySelector: (selector) => {
      if (selector === '.monaco-editor[data-uri]') return editorContainer;
      if (selector === '.CodeMirror') {
        return codeMirror ? { CodeMirror: { getValue: () => 'cm', setValue() {} } } : null;
      }
      return null;
    },
    getElementById: () => null,
    createElement: () => ({ style: {}, append() {}, addEventListener() {}, setAttribute() {} }),
    head: { append() {} },
    body: { append() {} }
  };
  // 页面真实 window：monaco 命名空间与 updateMonacoValue 都在它上面
  const pageHost = {};
  if (models.length) pageHost.Monaco = { editor: { getModels: () => models } };
  if (updateMonacoValue) pageHost.updateMonacoValue = updateMonacoValue;

  const sandbox = {
    window: { __educoderAutosubmitTestHooks: hooks },
    unsafeWindow: pageHost,
    document: fakeDocument,
    location: { pathname: '/tasks/zq044df30560', href: 'https://www.educoder.net/tasks/zq044df30560' },
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
  assert.ok(typeof hooks.findCodeEditor === 'function', '测试钩子应被挂上');
  return hooks;
}

test('编辑器：monaco 挂在 window.Monaco（大写）+ unsafeWindow，必须能找到', () => {
  const main = makeModel('inmemory://model/1', '//请修改类名使其符合命名规范\npublic class MailService {\n}\n');
  const hooks = loadEditorHooks({ models: [main], dataUri: 'inmemory://model/1' });
  const editor = hooks.findCodeEditor();
  assert.ok(editor, '必须找到编辑器（旧代码找 window.monaco，实测是 undefined，永远找不到）');
  assert.equal(editor.kind, 'monaco');
  assert.equal(editor.read(), '//请修改类名使其符合命名规范\npublic class MailService {\n}\n');
});

test('编辑器：写入必须同时同步页面状态（updateMonacoValue），否则提交仍是旧代码', () => {
  const main = makeModel('inmemory://model/1', 'old code');
  const synced = [];
  const hooks = loadEditorHooks({
    models: [main],
    dataUri: 'inmemory://model/1',
    updateMonacoValue: (value) => synced.push(value)
  });
  const editor = hooks.findCodeEditor();
  editor.write('public class A {}\n');
  assert.equal(main.getValue(), 'public class A {}\n', '模型要更新（编辑器里立刻可见）');
  assert.deepEqual(synced, ['public class A {}\n'], '必须调用页面的 updateMonacoValue 同步 React state');
});

test('编辑器：多个模型时按容器 data-uri 挑主编辑器（别把答案写进自测用例）', () => {
  const main = makeModel('inmemory://model/1', 'main code');
  const selfTest = makeModel('inmemory://model/2', 'self test case');
  const hooks = loadEditorHooks({ models: [selfTest, main], dataUri: 'inmemory://model/1' });
  const editor = hooks.findCodeEditor();
  assert.equal(editor.kind, 'monaco');
  assert.equal(editor.read(), 'main code', '应挑 data-uri 配对上的那个模型');
  assert.equal(
    hooks.pickEditorModel([selfTest, main, makeModel('inmemory://model/3', 'x'.repeat(80))]).uri,
    'inmemory://model/1',
    '有 data-uri 时优先配对，而不是按内容长度猜'
  );
});

test('编辑器：没有 monaco 时仍能退回 CodeMirror / 大 textarea / null', () => {
  const cmHooks = loadEditorHooks({ codeMirror: true });
  assert.equal(cmHooks.findCodeEditor().kind, 'codemirror');

  const bigArea = {
    id: 'code',
    className: '',
    value: 'x',
    getAttribute: () => '',
    getBoundingClientRect: () => ({ width: 400, height: 300 }),
    dispatchEvent() {}
  };
  const areaHooks = loadEditorHooks({ textarea: bigArea });
  assert.equal(areaHooks.findCodeEditor().kind, 'textarea');

  const noneHooks = loadEditorHooks({});
  assert.equal(noneHooks.findCodeEditor(), null, '什么都没有时返回 null，不能乱猜');
});