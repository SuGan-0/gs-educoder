'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { installEducoderPasteUnlock } = require('../userscript/lib/paste-unlock');
const { buildUserscripts } = require('../tools/build-userscripts');

function nativeNode(properties = {}) {
  const node = {
    tagName: 'TEXTAREA', type: 'text', disabled: false, readOnly: false,
    hasAttribute: () => false,
    closest: (selector) => selector.startsWith('.monaco') ? null : node,
    ...properties
  };
  return node;
}

function editorNode(kind = '.monaco-editor') {
  const node = {
    matches: (selector) => selector === kind,
    contains: (other) => other === node,
    // 编辑器目标来自 closest('.monaco-editor, .CodeMirror, .ace_editor, .cm-editor')：
    // 假节点要对组合选择器命中自己
    closest: (selector) => String(selector).includes(kind.slice(1)) ? node : null
  };
  return node;
}

function fixture({ pathname = '/tasks/course/homework/level', enabled = true, document: docOverride, ...options } = {}) {
  const listeners = new Map();
  const errors = [];
  const host = {
    document: docOverride || {}, location: { pathname },
    addEventListener(name, listener, capture) {
      assert.equal(capture, true);
      listeners.set(name, listener);
    },
    removeEventListener(name, listener, capture) {
      assert.equal(capture, true);
      assert.equal(listeners.get(name), listener);
      listeners.delete(name);
    }
  };
  host.top = host;
  const controller = installEducoderPasteUnlock(host, { enabled, onError: (error) => errors.push(error), ...options });
  function dispatch(type, target = nativeNode(), properties = {}) {
    const event = {
      type, target, prevented: false, stopped: false,
      preventDefault() { this.prevented = true; },
      stopImmediatePropagation() { this.stopped = true; },
      clipboardData: { getData: () => 'INSERT INTO client VALUES (1);\n' },
      ...properties
    };
    listeners.get(type)?.(event);
    return event;
  }
  return { host, controller, listeners, errors, dispatch };
}

function monacoEditor(container, { readOnly = false, fail = false } = {}) {
  const calls = [];
  const model = { getValue: () => 'updated SQL' };
  return {
    calls, model,
    getDomNode: () => container,
    getRawOptions: () => ({ readOnly }),
    getModel: () => model,
    getSelections: () => [
      { startLineNumber: 1, startColumn: 2, endLineNumber: 1, endColumn: 4 },
      { startLineNumber: 3, startColumn: 1, endLineNumber: 3, endColumn: 1 }
    ],
    pushUndoStop: () => calls.push('undo-stop'),
    executeEdits(source, edits, cursorState) {
      if (fail) throw new Error('editor unavailable');
      calls.push({ source, edits, cursors: cursorState(edits) });
      return true;
    }
  };
}

test('粘贴：构建产物与共享源码保持一致', () => {
  assert.deepEqual(buildUserscripts({ check: true }), []);
});

test('粘贴：输入框保留浏览器默认行为，并拦住页面的 paste/beforeinput/contextmenu 限制', () => {
  const { dispatch } = fixture();
  for (const type of ['paste', 'beforeinput', 'contextmenu']) {
    const event = dispatch(type, nativeNode(), { inputType: 'insertFromPaste' });
    assert.equal(event.stopped, true, type);
    assert.equal(event.prevented, false, 'native paste must retain its default action');
  }
  assert.equal(dispatch('beforeinput', nativeNode(), { inputType: 'insertText' }).stopped, false);
});

test('粘贴：仅放行粘贴快捷键，保留复制、普通按键、输入法与其他页面的行为', () => {
  const { dispatch, host } = fixture();
  for (const keys of [
    { key: 'v', ctrlKey: true }, { key: 'V', metaKey: true }, { key: 'Insert', shiftKey: true }
  ]) {
    const event = dispatch('keydown', nativeNode(), keys);
    assert.equal(event.stopped, true);
    assert.equal(event.prevented, false);
  }
  for (const keys of [
    { key: 'c', ctrlKey: true }, { key: 'v' }, { key: 'v', ctrlKey: true, altKey: true },
    { key: 'v', ctrlKey: true, isComposing: true }
  ]) assert.equal(dispatch('keydown', nativeNode(), keys).stopped, false);
  host.location.pathname = '/classrooms/example';
  assert.equal(dispatch('paste').stopped, false);
});

test('粘贴：只读、禁用、非文本输入框和非编辑区域不被改写', () => {
  const { dispatch } = fixture();
  const nodes = [
    nativeNode({ readOnly: true }), nativeNode({ disabled: true }),
    nativeNode({ tagName: 'INPUT', type: 'number' }),
    nativeNode({ hasAttribute: () => true, isContentEditable: false }),
    { closest: () => null }
  ];
  for (const node of nodes) assert.equal(dispatch('paste', node).stopped, false);
});

test('粘贴：支持 Shadow DOM 内的真实编辑目标以及同源任务子框架', () => {
  const { dispatch, host } = fixture({ pathname: '/embedded/editor' });
  host.top = { location: { pathname: '/tasks/x' } };
  const event = dispatch('paste', {}, { composedPath: () => [nativeNode()] });
  assert.equal(event.stopped, true);
  Object.defineProperty(host.top, 'location', { get() { throw new Error('cross-origin'); } });
  assert.equal(dispatch('paste').stopped, false);
});

test('粘贴：Monaco 按编辑器容器匹配，替换全部选区、保留撤销边界并同步页面状态', () => {
  const { dispatch, host } = fixture();
  const target = editorNode();
  const active = monacoEditor(target);
  const other = monacoEditor(editorNode());
  const synced = [];
  host.Monaco = { editor: { getEditors: () => [other, active] } };
  host.updateMonacoValue = (value) => synced.push(value);
  const event = dispatch('paste', target);
  assert.equal(event.stopped, true);
  assert.equal(event.prevented, true);
  assert.deepEqual(other.calls, []);
  assert.equal(active.calls[0], 'undo-stop');
  assert.equal(active.calls[2], 'undo-stop');
  const edit = active.calls[1];
  assert.equal(edit.source, 'educoder-paste-unlock');
  assert.equal(edit.edits.length, 2);
  assert.equal(edit.edits[0].text, 'INSERT INTO client VALUES (1);\n');
  assert.equal(edit.edits[0].range.startColumn, 2);
  assert.equal(edit.cursors[0].positionColumn, 4);
  assert.deepEqual(synced, ['updated SQL']);
});

test('粘贴：兼容小写 monaco；同步状态出错后仍只插入一次', () => {
  const { dispatch, host, errors } = fixture();
  const target = editorNode();
  const active = monacoEditor(target);
  host.monaco = { editor: { getEditors: () => [active] } };
  host.updateMonacoValue = () => { throw new Error('state sync failed'); };
  assert.equal(dispatch('paste', target).prevented, true);
  assert.equal(errors.length, 1);
  assert.equal(active.calls.filter((value) => typeof value === 'object').length, 1);
});

test('粘贴：只读 Monaco、缺少 API、空剪贴板和失败的编辑操作均保留原流程', () => {
  const { dispatch, host, errors } = fixture();
  const target = editorNode();
  assert.equal(dispatch('paste', target).prevented, false);
  const editor = monacoEditor(target, { readOnly: true });
  host.Monaco = { editor: { getEditors: () => [editor] } };
  assert.equal(dispatch('paste', target).prevented, false);
  assert.deepEqual(editor.calls, []);
  assert.equal(dispatch('paste', target, { clipboardData: { getData: () => '' } }).prevented, false);
  const failed = monacoEditor(target, { fail: true });
  host.Monaco.editor.getEditors = () => [failed];
  assert.equal(dispatch('paste', target).prevented, false);
  assert.equal(errors.length, 1);
});

test('粘贴：CodeMirror 与 Ace 使用选区插入，不覆盖整份代码', () => {
  const { dispatch } = fixture();
  const cm = editorNode('.CodeMirror');
  const writes = [];
  cm.CodeMirror = {
    getOption: () => false,
    replaceSelection: (...args) => writes.push(args)
  };
  assert.equal(dispatch('paste', cm).prevented, true);
  assert.deepEqual(writes[0], ['INSERT INTO client VALUES (1);\n', 'end', '+input']);
  cm.CodeMirror.getOption = () => 'nocursor';
  assert.equal(dispatch('paste', cm).prevented, false);
  const ace = editorNode('.ace_editor');
  ace.env = { editor: { getReadOnly: () => false, insert: (text) => writes.push(text) } };
  assert.equal(dispatch('paste', ace).prevented, true);
  assert.equal(writes[1], 'INSERT INTO client VALUES (1);\n');
});

test('粘贴：开关可恢复原限制，重复安装不重复监听，销毁后可以重新安装', () => {
  const { host, controller, dispatch, listeners } = fixture({ enabled: false });
  assert.equal(dispatch('paste').stopped, false);
  controller.setEnabled(true);
  assert.equal(dispatch('paste').stopped, true);
  assert.equal(installEducoderPasteUnlock(host), controller);
  assert.equal(listeners.size, 4);
  controller.setEnabled(false);
  assert.equal(dispatch('paste').stopped, false);
  controller.destroy();
  assert.equal(listeners.size, 0);
  assert.notEqual(installEducoderPasteUnlock(host), controller);
});

test('粘贴：实训壳路径（/myshixuns/*/challenges/*）同样激活，不必依赖 /tasks/', () => {
  const { dispatch, host } = fixture({ pathname: '/myshixuns/8z3rmh6icvwq/challenges/9zz8yy7abc' });
  const target = editorNode();
  host.Monaco = { editor: { getEditors: () => [monacoEditor(target)] } };
  const event = dispatch('paste', target);
  assert.equal(event.stopped, true, '实训壳里粘贴也要解锁');
  assert.equal(event.prevented, true);
});

test('粘贴：非任务路径但页面上有代码编辑器时同样激活（编辑器在场就是门槛）', () => {
  const { dispatch } = fixture({
    pathname: '/classrooms/example',
    document: { querySelector: (selector) => String(selector).includes('monaco-editor') ? {} : null }
  });
  const target = editorNode();
  const host = { Monaco: { editor: { getEditors: () => [monacoEditor(target)] } } };
  // fixture 里 install 已完成，host.Monaco 需要在 install 前注入——见下个用例；
  // 这里先验证路径判定本身放行（有编辑器 → contextOf 命中 → 原生行为拦截）。
  const event = dispatch('paste', nativeNode());
  assert.equal(event.stopped, true, '有编辑器的页面：原生输入框的粘贴限制也要解除');
  assert.equal(event.prevented, false);
});

test('粘贴：编辑器 API 与打字通道都失败时不再静默——onFail 要喊出来', () => {
  const fails = [];
  const { dispatch } = fixture({ onFail: (message) => fails.push(message) });
  const event = dispatch('paste', editorNode());
  assert.equal(event.prevented, false, '两条通道都失败时不能白白拦掉默认粘贴');
  assert.equal(event.stopped, true, '但仍要拦掉站点自己的监听器');
  assert.equal(fails.length, 1);
  assert.match(fails[0], /两条写入通道都失败/);
});

test('粘贴：编辑器 API 缺 getEditors 时退回打字通道（execCommand insertText）', () => {
  const typed = [];
  const target = editorNode();
  const { dispatch } = fixture({
    document: { activeElement: target, execCommand: (name, ui, text) => { typed.push([name, text]); return true; } }
  });
  // 不注入 host.Monaco：getEditors 路线整体不可用
  const event = dispatch('paste', target);
  assert.deepEqual(typed, [['insertText', 'INSERT INTO client VALUES (1);\n']]);
  assert.equal(event.prevented, true, '打字通道成功就要拦掉原生 paste（避免 onDidPaste 删除）');
  assert.equal(event.stopped, true);
});

test('粘贴：CodeMirror 6（.cm-editor）用视图 replaceSelection 插入，只读不动', () => {
  const { dispatch } = fixture();
  const cm = editorNode('.cm-editor');
  const dispatched = [];
  cm.cmView = {
    view: {
      state: {
        readOnly: false,
        replaceSelection: (text) => ({ text })
      },
      dispatch: (spec) => dispatched.push(spec)
    }
  };
  const event = dispatch('paste', cm);
  assert.equal(event.prevented, true);
  assert.deepEqual(dispatched, [{ text: 'INSERT INTO client VALUES (1);\n' }]);
  cm.cmView.view.state.readOnly = true;
  assert.equal(dispatch('paste', cm).prevented, false);
  assert.equal(dispatched.length, 1);
});
