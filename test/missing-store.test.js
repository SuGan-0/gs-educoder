'use strict';

/**
 * 缺答案清单的落盘与合并（离线，不触网）。
 *
 * 判据：同一条目重复上报不新增（幂等）、增/删/清各自生效、坏文件自愈。
 * 运行：node --test test/missing-store.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const {
  missingPathFor,
  readMissingDocument,
  addMissing,
  removeMissing,
  clearMissing
} = require('../extractor/lib/missing-store');

function withTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'touge-missing-'));
}

const ITEM_A = {
  course: '机器学习',
  experiment: '第1课时：模型评估',
  level: '第2关 留出法',
  level_id: 'L002',
  identifier: 'zq75a64d2b22',
  url: 'https://www.educoder.net/tasks/HCEAP94S/88000001/zq75a64d2b22?coursesId=HCEAP94S',
  reason: 'no-answer'
};

test('addMissing：写入文件，字段齐全且 id 稳定不重复', async () => {
  const root = withTempRoot();
  const first = await addMissing(root, [ITEM_A]);
  assert.equal(first.ok, true);
  assert.equal(first.added, 1);

  const document = JSON.parse(fs.readFileSync(missingPathFor(root), 'utf8'));
  assert.equal(document.items.length, 1);
  assert.match(document.items[0].id, /^[0-9a-f]{16}$/, 'id 应是稳定哈希');
  assert.equal(document.items[0].level, '第2关 留出法');
  assert.ok(document.items[0].reported_at, '应记录上报时间');

  const again = await addMissing(root, [{ ...ITEM_A, reported_at: '2026-01-01T00:00:00.000Z' }]);
  assert.equal(again.added, 0, '同一关卡重复上报不得新增');
  assert.equal(again.refreshed, 1, '重复上报应计 refreshed');
  assert.equal(again.items.length, 1);
  assert.equal(
    JSON.parse(fs.readFileSync(missingPathFor(root), 'utf8')).items[0].reported_at,
    '2026-01-01T00:00:00.000Z',
    'reported_at 应被刷新'
  );
});

test('addMissing：缺「课程/实验/关卡名」的条目直接丢弃', async () => {
  const root = withTempRoot();
  const result = await addMissing(root, [{ identifier: 'x', url: 'https://example.com' }]);
  assert.equal(result.added, 0);
  assert.equal(result.skipped, 1);
  assert.deepEqual((await readMissingDocument(root)).items, []);
});

test('removeMissing：按 id 删除；未知 id 不报错也不写盘', async () => {
  const root = withTempRoot();
  const added = await addMissing(root, [ITEM_A]);
  const id = added.items[0].id;

  const removed = await removeMissing(root, [id]);
  assert.equal(removed.removed, 1);
  assert.deepEqual((await readMissingDocument(root)).items, []);

  const before = fs.readFileSync(missingPathFor(root), 'utf8');
  const again = await removeMissing(root, ['不存在']);
  assert.equal(again.removed, 0);
  assert.equal(fs.readFileSync(missingPathFor(root), 'utf8'), before, '没有改动时不得写盘');
});

test('clearMissing：清空全部并返回清掉的条数', async () => {
  const root = withTempRoot();
  await addMissing(root, [ITEM_A, {
    ...ITEM_A,
    level: '第3关 F1值',
    level_id: 'L003',
    identifier: 'zq4fb34a',
    url: 'https://www.educoder.net/tasks/HCEAP94S/88000001/zq4fb34a'
  }]);
  const cleared = await clearMissing(root);
  assert.equal(cleared.cleared, 2);
  assert.deepEqual((await readMissingDocument(root)).items, []);
});

test('addMissing：同一关卡的不同 URL 形态收敛为一条（去重优先用关卡标识）', async () => {
  const root = withTempRoot();
  await addMissing(root, [ITEM_A]);
  const result = await addMissing(root, [{ ...ITEM_A, url: 'https://www.educoder.net/tasks/HCEAP94S/88000001/zq75a64d2b22' }]);
  assert.equal(result.added, 0);
  assert.equal(result.items.length, 1);
});

test('入参/结构漂移：合法 JSON 但 items 不是数组 → 空清单；非对象条目 → 计入 skipped', async () => {
  const root = withTempRoot();
  fs.writeFileSync(missingPathFor(root), JSON.stringify({ items: {} }), 'utf8');
  assert.deepEqual((await readMissingDocument(root)).items, []);
  const result = await addMissing(root, [123, null, ITEM_A]);
  assert.equal(result.added, 1);
  assert.equal(result.skipped, 2, '被丢弃的条目要计数，不能静默');
});

test('坏文件自愈：非法 JSON 视为空清单，后续写入重建', async () => {
  const root = withTempRoot();
  fs.writeFileSync(missingPathFor(root), 'not json at all', 'utf8');
  const empty = await readMissingDocument(root);
  assert.deepEqual(empty.items, []);
  const added = await addMissing(root, [ITEM_A]);
  assert.equal(added.added, 1, '坏文件不该阻断写入');
  assert.equal(JSON.parse(fs.readFileSync(missingPathFor(root), 'utf8')).items.length, 1);
});