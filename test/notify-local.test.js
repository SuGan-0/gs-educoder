'use strict';

/**
 * 本地投递通道（notify-local）离线测试。
 *
 * 关注两点：**待办文件是原子替换的**（读到半截会误以为作业少了），
 * 以及**流水序号会累加**（方便在文件里定位每次触发）。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { localPaths, writePending, appendLog, PENDING_FILE, LOG_FILE } = require('../extractor/lib/notify-local');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'touge-notify-'));
}

test('localPaths：两个文件的路径都在数据目录下', () => {
  const dir = tempDir();
  const paths = localPaths(dir);
  assert.strictEqual(paths.pending, path.join(dir, PENDING_FILE));
  assert.strictEqual(paths.log, path.join(dir, LOG_FILE));
});

test('待办文件：目录不存在时自动创建，写入后没有残留临时文件', async () => {
  const dir = path.join(tempDir(), 'nested', 'deeper');
  const { pending } = localPaths(dir);

  const result = await writePending(pending, '# 待办\n');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(fs.readFileSync(pending, 'utf8'), '# 待办\n');
  assert.strictEqual(fs.existsSync(`${pending}.tmp`), false, '原子替换后不该留下 .tmp');
});

test('待办文件：重复写入是覆盖，不是追加', async () => {
  const dir = tempDir();
  const { pending } = localPaths(dir);
  await writePending(pending, '第一版');
  await writePending(pending, '第二版');
  assert.strictEqual(fs.readFileSync(pending, 'utf8'), '第二版');
});

test('提醒流水：序号累加，内容按段分隔', async () => {
  const dir = tempDir();
  const { log } = localPaths(dir);

  const first = await appendLog(log, { title: '作业提醒：1 项', body: '正文一', nowLabel: '2026-10-01 09:00:00' });
  const second = await appendLog(log, { title: '作业提醒：2 项', body: '正文二', nowLabel: '2026-10-01 17:30:00' });
  assert.strictEqual(first.seq, 1);
  assert.strictEqual(second.seq, 2);

  const text = fs.readFileSync(log, 'utf8');
  assert.match(text, /===== 第 1 次提醒 · 2026-10-01 09:00:00 =====/);
  assert.match(text, /===== 第 2 次提醒 · 2026-10-01 17:30:00 =====/);
  assert.match(text, /正文一/);
  assert.match(text, /正文二/);
});

test('提醒流水：文件不存在时从第 1 次开始', async () => {
  const dir = tempDir();
  const { log } = localPaths(dir);
  assert.strictEqual(fs.existsSync(log), false);
  const result = await appendLog(log, { title: 't', body: 'b', nowLabel: 'now' });
  assert.strictEqual(result.seq, 1);
});
