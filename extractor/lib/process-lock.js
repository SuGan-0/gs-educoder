'use strict';

/**
 * 单实例进程锁。
 *
 * 为什么需要：常驻提醒服务由 systemd 拉起，但用户也可能手工跑一条 `once`。
 * 两个进程同时跑会**重复推送**——用户收到两条一样的提醒，还会白烧额度。
 *
 * ## 为什么不能只看文件年龄
 *
 * 最早的实现是「锁文件超过 1 小时就当陈旧」。这有两个问题：
 * - 进程被强杀（Ctrl+C、OOM、`kill -9`）后锁会一直留着，1 小时内谁也别想启动；
 * - 反过来，一个跑了 2 小时的健康进程，锁会被误判为陈旧而被抢走。
 *
 * 所以判据是**进程是否还活着**（`process.kill(pid, 0)`），文件年龄只作为兜底。
 *
 * 注：PID 可能被系统复用，所以「活着」不等于「就是那个进程」。这里接受这一点——
 * 误判的后果是「多等一会儿」而不是「重复推送」，方向是安全的。
 */

const fs = require('node:fs');
const path = require('node:path');

/** 文件年龄兜底阈值：超过它即使 PID 活着也当陈旧（防 PID 复用导致的永久卡死）。 */
const DEFAULT_STALE_MS = 6 * 60 * 60 * 1000;

/** 进程是否存活。`EPERM` 表示进程存在但当前用户无权发信号 → 仍算存活。 */
function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error) && error.code === 'EPERM';
  }
}

/** 读锁文件里记录的 PID；读不到返回 NaN。 */
function readLockPid(lockFile) {
  try {
    return Number.parseInt(String(fs.readFileSync(lockFile, 'utf8')).trim(), 10);
  } catch {
    return Number.NaN;
  }
}

/**
 * 取锁。成功返回 `release()`；已被占用时抛错。
 *
 * @param {string} lockFile
 * @param {{staleMs?: number, pid?: number}} [options] `pid` 仅用于测试注入。
 */
function acquireLock(lockFile, options = {}) {
  const target = String(lockFile || '');
  if (!target) throw new Error('缺少锁文件路径。');
  const staleMs = Number.isFinite(options.staleMs) ? options.staleMs : DEFAULT_STALE_MS;
  const ownPid = Number.isInteger(options.pid) ? options.pid : process.pid;

  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });

  // 清掉陈旧锁：记录进程已不存在，或文件老到不可信。
  try {
    const stat = fs.statSync(target);
    const holder = readLockPid(target);
    if (!isProcessAlive(holder) || Date.now() - stat.mtimeMs > staleMs) {
      fs.rmSync(target, { force: true });
    }
  } catch {
    /* 锁文件不存在，正常 */
  }

  try {
    fs.writeFileSync(target, String(ownPid), { flag: 'wx' });
  } catch {
    const holder = readLockPid(target);
    throw new Error(
      `已有提醒进程在运行（${target}，PID ${Number.isInteger(holder) ? holder : '未知'}），请勿重复启动。`
    );
  }

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      fs.rmSync(target, { force: true });
    } catch {
      /* 已被别的进程清掉，无所谓 */
    }
  };
  process.on('exit', release);
  // 被 Ctrl+C / systemd stop 时也要把锁带走，否则下次启动会白等。
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      release();
      process.exit(0);
    });
  }
  return release;
}

module.exports = { DEFAULT_STALE_MS, isProcessAlive, readLockPid, acquireLock };
