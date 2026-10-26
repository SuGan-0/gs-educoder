'use strict';

// Real keyboard/clipboard events on a local fixture; never contacts an Educoder account.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');

const source = fs.readFileSync(path.join(__dirname, '../userscript/educoder-paste-unlock.user.js'), 'utf8');
const fullSource = fs.readFileSync(path.join(__dirname, '../userscript/educoder-autosubmit.user.js'), 'utf8');
// Optional local Monaco distribution (the min/vs directory); no runtime dependency is added.
const monacoAssets = process.env.EDUCODER_MONACO_ASSETS || '';
const SQL = "INSERT INTO client VALUES (1, '张三');\nUPDATE client SET name = '李四' WHERE id = 1;";
let server, browser, origin, clipboardContext, savedClipboard;

const fixture = `<!doctype html><meta charset="utf-8">
<textarea id="sql" onpaste="return false" style="width:600px;height:150px">before after</textarea>
<input id="input" value="abcDEF" onpaste="return false">
<div id="rich" contenteditable="true">old</div>
<textarea id="readonly" readonly>keep</textarea>
<div id="editor" style="height:300px;width:800px"></div>
<script>
window.blocked = 0; window.inputEvents = 0;
document.addEventListener('input', () => window.inputEvents++);
window.addEventListener('keydown', (event) => {
  if (((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v')
    || (event.shiftKey && event.key === 'Insert')) { window.blocked++; event.preventDefault(); }
}, true);
document.addEventListener('paste', (event) => { window.blocked++; event.preventDefault(); }, true);
document.addEventListener('beforeinput', (event) => {
  if (event.inputType === 'insertFromPaste') { window.blocked++; event.preventDefault(); }
}, true);
document.addEventListener('contextmenu', (event) => { window.blocked++; event.preventDefault(); });
</script>`;

const monacoFixture = `<script src="/_monaco/loader.js"></script><script>
require.config({ paths: { vs: '/_monaco' } });
require(['vs/editor/editor.main'], function () {
  window.Monaco = monaco;
  window.pageState = ''; window.pasteDeletions = 0; window.explicitSyncs = 0;
  window.editor = monaco.editor.create(document.getElementById('editor'), {
    value: 'SELECT old;\\n-- keep', language: 'sql', automaticLayout: true, minimap: { enabled: false }
  });
  editor.onDidChangeModelContent(() => window.pageState = editor.getValue());
  window.updateMonacoValue = (value) => { window.explicitSyncs++; window.pageState = value; };
  // Reproduce the site's second restriction: delete pasted content after Monaco inserts it.
  editor.onDidPaste((event) => {
    window.pasteDeletions++;
    editor.executeEdits('site-forbid-copy', [{ range: event.range, text: '' }]);
  });
});
</script>`;

test.before(async () => {
  server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname.startsWith('/_monaco/')) {
      const relative = decodeURIComponent(pathname.slice('/_monaco/'.length));
      const file = path.resolve(monacoAssets, relative);
      const inside = path.relative(path.resolve(monacoAssets), file);
      if (!monacoAssets || inside === '..' || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) {
        res.writeHead(404).end(); return;
      }
      try {
        const data = await fs.promises.readFile(file);
        res.writeHead(200, { 'Content-Type': file.endsWith('.css') ? 'text/css' : 'application/javascript' }).end(data);
      } catch { res.writeHead(404).end(); }
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fixture + (pathname === '/tasks/monaco' ? monacoFixture : ''));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ channel: 'chromium', headless: true });
  clipboardContext = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await clipboardContext.newPage();
  await page.goto(origin);
  savedClipboard = await page.evaluate(() => navigator.clipboard.readText());
});

test.after(async () => {
  if (clipboardContext && savedClipboard !== undefined) {
    const page = clipboardContext.pages()[0];
    await page.evaluate((text) => navigator.clipboard.writeText(text), savedClipboard);
  }
  if (browser) await browser.close();
  if (server) await new Promise((resolve) => server.close(resolve));
});

async function openPage(t, route = '/tasks/example', script = source) {
  const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  t.after(() => context.close());
  await context.addInitScript({ content: `
    window.unsafeWindow = window;
    window.__menus = {};
    window.GM_getValue = (key, fallback) => {
      try { const value = localStorage.getItem(key); return value === null ? fallback : JSON.parse(value); }
      catch { return fallback; }
    };
    window.GM_setValue = (key, value) => localStorage.setItem(key, JSON.stringify(value));
    window.GM_deleteValue = (key) => localStorage.removeItem(key);
    window.GM_registerMenuCommand = (name, handler) => window.__menus[name] = handler;
    window.GM_xmlhttpRequest = (options) => setTimeout(() => options.onerror?.({ error: 'Offline fixture' }), 0);
    window.alert = (message) => window.__lastAlert = message;
    ${script}
  ` });
  const page = await context.newPage();
  await page.goto(origin + route);
  return page;
}

async function paste(page, text, shortcut = 'Control+v') {
  await page.evaluate((value) => navigator.clipboard.writeText(value), text);
  await page.keyboard.press(shortcut);
}

async function selectText(page, selector, start, end) {
  await page.locator(selector).evaluate((node, range) => { node.focus(); node.setSelectionRange(...range); }, [start, end]);
}

async function toggle(page) {
  await page.evaluate(() => Object.values(window.__menus)[0]());
}

test('浏览器：多行 SQL 在光标处插入，产生 input 事件并可原生撤销', async (t) => {
  const page = await openPage(t);
  await selectText(page, '#sql', 7, 7);
  await paste(page, SQL);
  assert.equal(await page.locator('#sql').inputValue(), `before ${SQL}after`);
  assert.ok(await page.evaluate(() => window.inputEvents) > 0);
  assert.equal(await page.evaluate(() => window.blocked), 0);
  await page.keyboard.press('Control+z');
  assert.equal(await page.locator('#sql').inputValue(), 'before after');
});

test('浏览器：替换输入框选区，Shift+Insert 可粘贴', async (t) => {
  const page = await openPage(t);
  await selectText(page, '#input', 3, 6);
  await paste(page, '中文<>&', 'Shift+Insert');
  assert.equal(await page.locator('#input').inputValue(), 'abc中文<>&');
});

test('浏览器：contenteditable 保持纯文本粘贴与正常输入事件', async (t) => {
  const page = await openPage(t);
  await page.locator('#rich').focus();
  await page.keyboard.press('Control+a');
  await paste(page, '<b>SQL</b>');
  assert.equal(await page.locator('#rich').innerText(), '<b>SQL</b>');
  assert.equal(await page.locator('#rich b').count(), 0);
});

test('浏览器：关闭开关会恢复原限制，刷新后仍关闭，再打开立即生效', async (t) => {
  const page = await openPage(t);
  await toggle(page);
  await page.reload();
  await selectText(page, '#sql', 0, 6);
  await paste(page, 'blocked');
  assert.equal(await page.locator('#sql').inputValue(), 'before after');
  assert.ok(await page.evaluate(() => window.blocked) > 0);
  await toggle(page);
  await paste(page, 'allowed');
  assert.equal(await page.locator('#sql').inputValue(), 'allowed after');
});

test('浏览器：普通页面保持原行为，SPA 进入任务后动态创建的编辑框立即可粘贴', async (t) => {
  const page = await openPage(t, '/classrooms/course');
  await selectText(page, '#sql', 0, 6);
  await paste(page, 'blocked');
  assert.equal(await page.locator('#sql').inputValue(), 'before after');
  await page.evaluate(() => {
    history.pushState({}, '', '/tasks/new-level');
    const node = document.createElement('textarea'); node.id = 'dynamic';
    node.onpaste = () => false; document.body.append(node); node.focus();
  });
  await paste(page, SQL);
  assert.equal(await page.locator('#dynamic').inputValue(), SQL);
});

test('浏览器：同源子框架继承任务范围，开关同步生效', async (t) => {
  const page = await openPage(t);
  await page.evaluate(() => { const frame = document.createElement('iframe'); frame.src = '/embedded/editor'; document.body.append(frame); });
  const frame = page.frameLocator('iframe');
  await frame.locator('#sql').waitFor();
  await frame.locator('#sql').evaluate((node) => { node.focus(); node.setSelectionRange(0, 6); });
  await paste(page, 'frame');
  assert.equal(await frame.locator('#sql').inputValue(), 'frame after');
  await toggle(page);
  await paste(page, 'blocked');
  assert.equal(await frame.locator('#sql').inputValue(), 'frame after');
});

test('浏览器：Shadow DOM 的输入框可粘贴，右键菜单不再被页面禁止', async (t) => {
  const page = await openPage(t);
  await page.evaluate(() => {
    const host = document.createElement('div'); document.body.append(host);
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = '<textarea id="shadow"></textarea>'; root.firstChild.focus();
  });
  await paste(page, SQL);
  assert.equal(await page.locator('#shadow').inputValue(), SQL);
  const prevented = await page.locator('#sql').evaluate((node) => {
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    node.dispatchEvent(event); return event.defaultPrevented;
  });
  assert.equal(prevented, false);
});

test('浏览器：只读输入框保留原状态', async (t) => {
  const page = await openPage(t);
  await page.locator('#readonly').focus();
  await paste(page, SQL);
  assert.equal(await page.locator('#readonly').inputValue(), 'keep');
});

test('浏览器：完整版脚本的面板开关接通粘贴功能并保留设置', async (t) => {
  const page = await openPage(t, '/tasks/example', fullSource);
  const button = page.locator('#eas-paste-unlock');
  await button.waitFor();
  assert.equal(await button.textContent(), '粘贴解锁：开');
  await selectText(page, '#sql', 0, 6);
  await paste(page, 'full');
  assert.equal(await page.locator('#sql').inputValue(), 'full after');
  await button.click();
  assert.equal(await button.textContent(), '粘贴解锁：关');
  await page.reload();
  assert.equal(await button.textContent(), '粘贴解锁：关');
  await selectText(page, '#sql', 0, 6);
  await paste(page, 'blocked');
  assert.equal(await page.locator('#sql').inputValue(), 'before after');
});

test('真实 Monaco：替换选区、同步代码状态、阻止粘贴后删除并支持撤销', { skip: !monacoAssets }, async (t) => {
  const page = await openPage(t, '/tasks/monaco');
  await page.waitForFunction(() => Boolean(window.editor));
  await page.evaluate(() => { editor.focus(); editor.setSelection(new Monaco.Selection(1, 8, 1, 11)); });
  await paste(page, 'id\nFROM client');
  const expected = 'SELECT id\nFROM client;\n-- keep';
  assert.equal(await page.evaluate(() => editor.getValue()), expected);
  assert.equal(await page.evaluate(() => window.pageState), expected);
  assert.equal(await page.evaluate(() => window.pasteDeletions), 0);
  assert.equal(await page.evaluate(() => window.explicitSyncs), 1);
  await page.keyboard.press('Control+z');
  assert.equal(await page.evaluate(() => editor.getValue()), 'SELECT old;\n-- keep');
});

test('真实 Monaco：多个光标均插入一次，只读状态保留', { skip: !monacoAssets }, async (t) => {
  const page = await openPage(t, '/tasks/monaco');
  await page.waitForFunction(() => Boolean(window.editor));
  await page.evaluate(() => {
    editor.focus(); editor.setSelections([new Monaco.Selection(1, 1, 1, 1), new Monaco.Selection(2, 1, 2, 1)]);
  });
  await paste(page, '-- ');
  assert.equal(await page.evaluate(() => editor.getValue()), '-- SELECT old;\n-- -- keep');
  await page.evaluate(() => editor.updateOptions({ readOnly: true }));
  await paste(page, 'unchanged');
  assert.equal(await page.evaluate(() => editor.getValue()), '-- SELECT old;\n-- -- keep');
});
