// ==UserScript==
// @name         头歌解除禁止粘贴
// @namespace    local.educoder.paste-unlock
// @version      1.0.1
// @description  恢复头歌实验编辑器的快捷键和右键粘贴，支持 Monaco、CodeMirror、Ace 和普通输入框。默认开启，无需本地服务或签名常量。
// @match        https://www.educoder.net/*
// @match        https://educoder.net/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  // BEGIN GENERATED: paste-unlock
  // Source: userscript/lib/paste-unlock.js; rebuild with npm run build:userscripts.
  function installEducoderPasteUnlock(host, options = {}) {
    const key = '__educoderPasteUnlockV1';
    if (host[key]) return host[key];
    let enabled = options.enabled !== false;
    const isEnabled = () => typeof options.isEnabled === 'function' ? options.isEnabled() : enabled;
    const doc = host.document;
    const listeners = [];
    const report = (error) => {
      if (typeof options.onError === 'function') options.onError(error);
    };
    // 写入编辑器失败时必须喊一声——「解除禁止粘贴没效果」最难的排查点就是它静默。
    const notify = (message) => {
      if (typeof options.onFail === 'function') options.onFail(message);
    };

    function inTaskPage() {
      try {
        const path = String(host.location.pathname || '');
        // 任务页与实训壳：新 TPI 的「代码文件」页签挂在这些路径下
        if (/^\/tasks(?:\/|$)/.test(path)) return true;
        if (/^\/(?:my)?shixuns\/[^/]+\/challenges(?:\/|$)/.test(path)) return true;
        if (host.top !== host) {
          try {
            const topPath = String(host.top.location.pathname || '');
            if (/^\/tasks(?:\/|$)/.test(topPath)) return true;
            if (/^\/(?:my)?shixuns\/[^/]+\/challenges/.test(topPath)) return true;
            if (/^\/classrooms\//.test(topPath)) return true; // 课堂内嵌实训
          } catch { /* 跨域 top：按本框继续判断 */ }
        }
        // 路径形态再改也不怕：页面上真有代码编辑器就激活——
        // 拦截的最终目标本来就必须命中编辑器（editableOf），路径只是提示，不是门槛。
        return Boolean(doc.querySelector('.monaco-editor, .CodeMirror, .ace_editor, .cm-editor'));
      } catch {
        return false;
      }
    }

    function targetOf(event) {
      const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
      const target = path[0] || event.target || doc.activeElement;
      return target && target.nodeType === 3 ? target.parentElement : target;
    }

    function editableOf(target) {
      if (!target || typeof target.closest !== 'function') return null;
      const editor = target.closest('.monaco-editor, .CodeMirror, .ace_editor, .cm-editor');
      if (editor) return { kind: 'editor', node: editor };
      const node = target.closest('textarea, input, [contenteditable]');
      if (!node || node.disabled || node.readOnly) return null;
      if (node.tagName === 'INPUT' && !/^(text|search|url|tel|email|password)$/i.test(node.type)) return null;
      if (node.hasAttribute('contenteditable') && !node.isContentEditable) return null;
      return { kind: 'native', node };
    }

    function contextOf(event) {
      if (!isEnabled() || !inTaskPage()) return null;
      return editableOf(targetOf(event));
    }

    function syncMonaco(model) {
      // Educoder also keeps the current code in React state.
      try {
        if (typeof host.updateMonacoValue === 'function') host.updateMonacoValue(model.getValue());
      } catch (error) {
        report(error);
      }
    }

    function pasteIntoMonaco(container, text) {
      const monaco = host.Monaco || host.monaco;
      const api = monaco && monaco.editor;
      if (!api || typeof api.getEditors !== 'function') return false;
      const editor = api.getEditors().find((item) => {
        const node = item.getDomNode();
        return node && (node === container || container.contains(node));
      });
      if (!editor) return false;
      const raw = typeof editor.getRawOptions === 'function' ? editor.getRawOptions() : {};
      if (raw.readOnly || raw.domReadOnly) return false;
      const selections = editor.getSelections();
      const model = editor.getModel();
      if (!model || !selections || !selections.length) return false;
      // executeEdits avoids Educoder's onDidPaste callback, which deletes pasted text.
      // Each paste is one undo step and replaces only the current selection(s).
      editor.pushUndoStop();
      const changed = editor.executeEdits('educoder-paste-unlock', selections.map((range) => ({
        range, text, forceMoveMarkers: true
      })), (inverseEdits) => inverseEdits.map(({ range }) => ({
        selectionStartLineNumber: range.endLineNumber,
        selectionStartColumn: range.endColumn,
        positionLineNumber: range.endLineNumber,
        positionColumn: range.endColumn
      })));
      editor.pushUndoStop();
      if (!changed) return false;
      syncMonaco(model);
      return true;
    }

    function pasteIntoEditor(container, text) {
      if (container.matches('.monaco-editor')) return pasteIntoMonaco(container, text);
      if (container.matches('.CodeMirror')) {
        const cm = container.CodeMirror;
        if (!cm || cm.getOption('readOnly')) return false;
        cm.replaceSelection(text, 'end', '+input');
        return true;
      }
      // CodeMirror 6：容器是 .cm-editor，视图实例挂在 cmView 上
      if (container.matches('.cm-editor')) {
        const view = container.cmView && container.cmView.view;
        if (!view || view.state.readOnly) return false;
        view.dispatch(view.state.replaceSelection(text));
        return true;
      }
      const ace = container.env && container.env.editor;
      if (!ace || ace.getReadOnly()) return false;
      ace.insert(text);
      return true;
    }

    /**
     * 兜底通道：把内容当成**打字**塞给当前焦点元素（document.execCommand('insertText')）。
     *
     * 为什么需要它：编辑器 API 写入失败（monaco 版本没有 getEditors、容器对不上、
     * 站点换了编辑器实现）时不至于全军覆没。走输入管线有个额外好处——它不产生 paste
     * 事件，站点挂在 paste / onDidPaste 上的「删掉粘贴内容」逻辑根本不会触发；
     * 光标、选区替换和撤销由浏览器与编辑器自己的输入处理维持，光标处的原有选区被替换。
     */
    function pasteByTyping(text) {
      const active = doc.activeElement;
      if (!active || typeof doc.execCommand !== 'function') return false;
      let ok = false;
      try {
        ok = doc.execCommand('insertText', false, text);
      } catch (error) {
        report(error);
        return false;
      }
      return Boolean(ok);
    }

    function onPaste(event) {
      const context = contextOf(event);
      if (!context) return;
      if (context.kind === 'native') {
        // Keep the browser's own paste, input events, selection and undo behavior.
        event.stopImmediatePropagation();
        return;
      }
      const clipboard = event.clipboardData;
      const text = clipboard ? clipboard.getData('text/plain') : '';
      if (!text) return;
      const reasons = [];
      try {
        if (pasteIntoEditor(context.node, text)) {
          event.preventDefault();
          event.stopImmediatePropagation();
          return;
        }
      } catch (error) {
        report(error);
        reasons.push(error.message);
      }
      try {
        if (pasteByTyping(text)) {
          event.preventDefault();
          event.stopImmediatePropagation();
          return;
        }
        reasons.push('execCommand(insertText) 不可用');
      } catch (error) {
        report(error);
        reasons.push(error.message);
      }
      // 编辑器 API 与打字通道都失败：别拦默认行为（拦了粘贴就彻底没反应），
      // 但拦住站点自己的监听器，并把失败喊出来——面板日志里能直接看到原因。
      event.stopImmediatePropagation();
      notify(`已拦住站点限制，但两条写入通道都失败（${reasons.join('；') || '原因未知'}），已放行平台默认粘贴`);
    }

    function onKeyDown(event) {
      if (event.isComposing || event.altKey) return;
      const keyName = String(event.key || '').toLowerCase();
      const pasteShortcut = ((event.ctrlKey || event.metaKey) && keyName === 'v')
        || (event.shiftKey && keyName === 'insert');
      if (pasteShortcut && contextOf(event)) event.stopImmediatePropagation();
    }

    function onBeforeInput(event) {
      const context = /^insertFromPaste/.test(event.inputType || '') && contextOf(event);
      if (context && context.kind === 'native') event.stopImmediatePropagation();
    }

    function onContextMenu(event) {
      if (contextOf(event)) event.stopImmediatePropagation();
    }

    const controller = {
      get enabled() { return isEnabled(); },
      setEnabled(value) { enabled = Boolean(value); },
      destroy() {
        for (const [name, listener] of listeners) host.removeEventListener(name, listener, true);
        listeners.length = 0;
        delete host[key];
      }
    };
    host[key] = controller;
    // One set of capture listeners also covers editors mounted later and SPA navigation.
    // Tampermonkey injects the script in matching same-origin frames as well.
    if (typeof host.addEventListener === 'function') {
      for (const [name, listener] of Object.entries({
        paste: onPaste, keydown: onKeyDown, beforeinput: onBeforeInput, contextmenu: onContextMenu
      })) {
        host.addEventListener(name, listener, true);
        listeners.push([name, listener]);
      }
    }
    return controller;
  }
  // END GENERATED: paste-unlock

  const host = typeof unsafeWindow !== 'undefined' && unsafeWindow ? unsafeWindow : window;
  const storageKey = 'educoder-paste-unlock';
  const controller = installEducoderPasteUnlock(host, {
    enabled: GM_getValue(storageKey, true),
    isEnabled: () => GM_getValue(storageKey, true),
    onError: (error) => console.warn('[头歌粘贴解锁]', error),
    onFail: (message) => console.warn('[头歌粘贴解锁]', message)
  });
  if (host.top === host) {
    GM_registerMenuCommand('切换解除禁止粘贴（默认开启）', () => {
      const enabled = !controller.enabled;
      controller.setEnabled(enabled);
      GM_setValue(storageKey, enabled);
      host.alert(`解除禁止粘贴：已${enabled ? '开启' : '关闭'}。刷新页面后同样生效。`);
    });
  }
})();
