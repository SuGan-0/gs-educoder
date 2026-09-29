'use strict';

/**
 * 缺答案清单 HTTP 接口的端到端测试（真实 HTTP，假 export root）。
 *
 * 契约：GET /api/missing 取清单；POST /api/missing { action: add | remove | clear }。
 * 调用方是篡改猴扩展（Origin 不是本机），因此与 /api/answer/save 同口径：只校验 token。
 *
 * 运行：node --test test/missing-api.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const ITEM = {
  course: '机器学习',
  experiment: '第1课时：模型评估',
  level: '第2关 留出法',
  level_id: 'L002',
  identifier: 'vnf9hpj8sx7i',
  url: 'https://www.educoder.net/tasks/HCEAP94S/3965742/vnf9hpj8sx7i',
  reason: 'no-answer'
};

test('缺答案清单接口：add / 幂等 / remove / clear 往返，且校验 token', async (t) => {
  const exportRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'touge-missing-api-'));
  const previous = process.env.EDUCODER_EXPORT_ROOT;
  process.env.EDUCODER_EXPORT_ROOT = exportRoot;
  const { startUiServer } = require(path.join(ROOT, 'extractor/ui/server.js'));
  const ui = await startUiServer({ open: false });
  t.after(async () => {
    await ui.close();
    if (previous === undefined) delete process.env.EDUCODER_EXPORT_ROOT;
    else process.env.EDUCODER_EXPORT_ROOT = previous;
    fs.rmSync(exportRoot, { recursive: true, force: true });
  });

  const token = new URL(ui.url).searchParams.get('token');
  const call = async (method, body) => {
    const response = await fetch(`http://127.0.0.1:${ui.port}/api/missing?token=${token}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: response.status, payload: await response.json() };
  };

  const empty = await call('GET');
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.payload.items, []);

  const added = await call('POST', { action: 'add', items: [ITEM, { course: '', experiment: '', level: '' }] });
  assert.equal(added.status, 200);
  assert.equal(added.payload.added, 1);
  assert.equal(added.payload.skipped, 1, '被丢弃的条目要如实回给调用方，不能静默');

  const addedAgain = await call('POST', { action: 'add', items: [ITEM] });
  assert.equal(addedAgain.payload.added, 0, '同一关卡重复上报不得新增');
  assert.equal((await call('GET')).payload.items.length, 1);

  const id = (await call('GET')).payload.items[0].id;
  const removed = await call('POST', { action: 'remove', ids: [id] });
  assert.equal(removed.payload.removed, 1);
  assert.equal((await call('GET')).payload.items.length, 0);

  await call('POST', { action: 'add', items: [ITEM] });
  const cleared = await call('POST', { action: 'clear' });
  assert.equal(cleared.payload.cleared, 1);
  assert.equal((await call('GET')).payload.items.length, 0, 'clear 之后清单必须真的为空');

  const unknown = await call('POST', { action: '???', items: [] });
  assert.equal(unknown.status, 400);
  assert.match(String(unknown.payload.error), /未知 action/);

  const wrongMethod = await fetch(`http://127.0.0.1:${ui.port}/api/missing?token=${token}`, { method: 'PUT' });
  assert.equal(wrongMethod.status, 405, '非 GET/POST 必须 405');

  const badJson = await fetch(`http://127.0.0.1:${ui.port}/api/missing?token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{not json'
  });
  assert.equal(badJson.status, 400);

  const tooLarge = await fetch(`http://127.0.0.1:${ui.port}/api/missing?token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'add', items: [{ padding: 'x'.repeat(70 * 1024) }] })
  });
  assert.equal(tooLarge.status, 413, '超过 64KB 必须 413');

  const missingItems = await call('POST', { action: 'add' });
  assert.equal(missingItems.status, 400);
  assert.match(String(missingItems.payload.error), /items/);

  const denied = await fetch(`http://127.0.0.1:${ui.port}/api/missing?token=wrong`);
  assert.equal(denied.status, 403, '错 token 必须被拒（与既有接口同口径）');
});