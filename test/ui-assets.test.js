'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startUiServer } = require('../extractor/ui/server');

test('控制台静态资源：GET/HEAD 类型正确，仅公开指定文件，API 仍要求凭据', async (t) => {
  const ui = await startUiServer({ open: false });
  t.after(() => ui.close());
  const base = new URL(ui.url).origin;
  for (const [file, type] of [
    ['/assets/console.css', 'text/css'],
    ['/assets/console.js', 'text/javascript'],
    ['/assets/selection-model.js', 'text/javascript']
  ]) {
    const response = await fetch(base + file);
    assert.equal(response.status, 200);
    assert.ok(response.headers.get('content-type').startsWith(type));
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.ok((await response.text()).length > 100);
    const head = await fetch(base + file, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    assert.equal(head.headers.get('content-length'), response.headers.get('content-length'));
    assert.equal((await fetch(base + file, { method: 'POST' })).status, 405);
  }
  assert.equal((await fetch(base + '/assets/server.js')).status, 404);
  assert.equal((await fetch(base + '/assets/%2e%2e/.env')).status, 404);
  assert.equal((await fetch(base + '/api/state')).status, 403);
  assert.equal((await fetch(base + '/assets/console.local.js')).status, 404);
  assert.equal((await fetch(base + '/api/virtual/submit', { method: 'POST' })).status, 404);
});

test('关卡选择 HTTP：重复序号按实验归属解析，空选与错误身份不扩大抓取范围', async (t) => {
  const actions = [];
  const ui = await startUiServer({ open: false, onControl: async (...args) => { actions.push(args); } });
  t.after(() => ui.close());
  const levels = [0, 1].map(experimentIndex => ({ experimentIndex, position: 1, challengeId: 'shared' }));
  ui.setSnapshot({ phase: 'waiting-levels', levels });
  const base = new URL(ui.url).origin;
  const token = new URL(ui.url).searchParams.get('token');
  async function select(picked) {
    return fetch(base + '/api/action', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'select-levels', token, levels: picked })
    });
  }
  for (const invalid of [[], [{ position: 1 }], [{ identifier: 'missing', position: 1, experimentIndex: 1 }]]) {
    assert.equal((await select(invalid)).status, 400);
    assert.deepEqual(ui.getSnapshot().selectedLevels, []);
  }
  assert.equal(actions.length, 0, '无效选择不得触发引擎');
  assert.equal((await select([{ challengeId: 'shared', position: 1, experimentIndex: 1 }])).status, 200);
  assert.deepEqual(ui.getSnapshot().selectedLevels, [levels[1]]);
  assert.equal(actions.length, 1);
});
