'use strict';

/**
 * 单实例进程锁（process-lock）离线测试。
 *
 * 重点：**残留的锁不能把服务永久卡死**，同时**活着的进程不能被抢锁**。
 * 用临时目录跑，不依赖真实进程。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { isProcessAlive, readLockPid, acquireLock } = require('../extractor/lib/process-lock');

function tempLockPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'touge-lock-'));
  return path.join(dir, 'nested', 'reminder.lock');
}

/** 一个几乎肯定不存在的 PID（比 2^22 大，Windows/Linux 上都超出常规范围）。 */
const DEAD_PID = 4194303;

test('isProcessAlive：当前进程存活，不存在的 PID 判死', () => {
  assert.strictEqual(isProcessAlive(process.pid), true);
  assert.strictEqual(isProcessAlive(DEAD_PID), false);
  assert.strictEqual(isProcessAlive(NaN), false);
  assert.strictEqual(isProcessAlive(0), false);
  assert.strictEqual(isProcessAlive(-1), false);
});

test('取锁：目录不存在时自动创建，release 后文件消失', () => {
  const lockFile = tempLockPath();
  const release = acquireLock(lockFile);
  assert.strictEqual(fs.existsSync(lockFile), true);
  assert.strictEqual(readLockPid(lockFile), process.pid);
  release();
  assert.strictEqual(fs.existsSync(lockFile), false);
});

test('取锁：release 可重复调用，不报错', () => {
  const lockFile = tempLockPath();
  const release = acquireLock(lockFile);
  release();
  assert.doesNotThrow(() => release());
});

test('取锁：记录进程还活着时，第二个进程拿不到锁', () => {
  const lockFile = tempLockPath();
  // 用当前进程 PID 写锁：模拟「锁被一个活着的进程持有」。
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  fs.writeFileSync(lockFile, String(process.pid));

  assert.throws(
    () => acquireLock(lockFile),
    (error) => {
      assert.match(error.message, /已有提醒进程在运行/);
      assert.ok(error.message.includes(String(process.pid)), '报错里应带上持有者 PID');
      return true;
    }
  );
  // 抢锁失败不得破坏原有的锁。
  assert.strictEqual(readLockPid(lockFile), process.pid);
});

test('取锁：残留的死进程锁会被接管（这是最容易踩的坑）', () => {
  const lockFile = tempLockPath();
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  fs.writeFileSync(lockFile, String(DEAD_PID));

  const release = acquireLock(lockFile);
  assert.strictEqual(readLockPid(lockFile), process.pid, '应当接管残留锁');
  release();
});

test('取锁：内容损坏（非数字）视为陈旧并接管', () => {
  const lockFile = tempLockPath();
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  fs.writeFileSync(lockFile, 'not-a-pid');

  const release = acquireLock(lockFile);
  assert.strictEqual(readLockPid(lockFile), process.pid);
  release();
});

test('取锁：文件老到超过 staleMs 时，即使 PID 活着也接管', () => {
  const lockFile = tempLockPath();
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  fs.writeFileSync(lockFile, String(process.pid));
  const old = Date.now() - 10_000;
  fs.utimesSync(lockFile, old / 1000, old / 1000);

  const release = acquireLock(lockFile, { staleMs: 1000 });
  assert.strictEqual(readLockPid(lockFile), process.pid);
  release();
});

test('取锁：缺少路径直接抛错', () => {
  assert.throws(() => acquireLock(''), /缺少锁文件路径/);
});
