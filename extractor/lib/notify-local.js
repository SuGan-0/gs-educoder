'use strict';

/**
 * 本地投递通道：**不发手机**，把提醒写成本地文件。
 *
 * 什么时候用它：不想接 Server 酱 / 企业微信 / 钉钉这类推送服务，
 * 只想让服务在服务器上跑着、把待办整理成文件，自己去看。
 *
 * 它产出两份东西：
 *
 * | 文件 | 语义 | 更新方式 |
 * | --- | --- | --- |
 * | `data/pending-reminders.md` | **当前全部待办**（未完成、未归档、已发布），按紧急程度分档 | 每次运行重写 |
 * | `data/reminders.log` | **已触发的提醒流水**（什么时候提醒了哪几项） | 追加 |
 *
 * 为什么两份都要：
 * - 只看流水，你不知道「现在还剩什么没做」；
 * - 只看待办，你不知道「这条提醒到底发过没有」，而发送去重又需要它。
 *
 * 提醒事件仍然照常记账（`push_events`），所以「同一截止时间、同一阶段只提醒一次」
 * 的语义与推送通道完全一致——**换成推送通道时不需要改任何数据**。
 */

const fs = require('node:fs/promises');
const path = require('node:path');

const PENDING_FILE = 'pending-reminders.md';
const LOG_FILE = 'reminders.log';

/** 本地通道的文件路径。 */
function localPaths(dataDir) {
  return {
    pending: path.join(dataDir, PENDING_FILE),
    log: path.join(dataDir, LOG_FILE)
  };
}

/**
 * 重写「当前待办」视图。
 *
 * 用「写临时文件 + rename」原子替换：这份文件是给人看的，
 * 半截内容比旧内容更容易误导（读到一半会以为作业少了几项）。
 */
async function writePending(filePath, document) {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temp = `${filePath}.tmp`;
  await fs.writeFile(temp, document, 'utf8');
  await fs.rename(temp, filePath);
  return { ok: true, path: filePath, bytes: Buffer.byteLength(document, 'utf8') };
}

/**
 * 追加一段提醒流水。带分隔标题，便于在文件里定位每次触发。
 * 与篡改猴日志同款写法（`===== 第 N 次 =====`），数标题得出序号，不额外维护状态。
 */
async function appendLog(filePath, { title, body, nowLabel }) {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  let seq = 1;
  try {
    const existing = await fs.readFile(filePath, 'utf8');
    seq = (existing.match(/^===== 第 \d+ 次/gm) || []).length + 1;
  } catch {
    seq = 1;
  }
  const header = `\n===== 第 ${seq} 次提醒 · ${nowLabel} =====\n`;
  await fs.appendFile(filePath, `${header}${title}\n\n${body}\n`, 'utf8');
  return { ok: true, path: filePath, seq };
}

module.exports = { PENDING_FILE, LOG_FILE, localPaths, writePending, appendLog };
