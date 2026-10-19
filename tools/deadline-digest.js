#!/usr/bin/env node
'use strict';

/**
 * 作业截止摘要（给 DSH 定时任务用）。
 *
 * 规则（按使用者要求固化，不交给模型判断）：
 *   - 只看 **48 小时内**截止的「待处理」作业；
 *   - **已逾期的一律不列**（不提醒）；
 *   - 已完成 / 已归档 / 未发布 / 完成状态未知，一律不列；
 *   - **没有截止时间**的作业：给出该课堂（作业单）里**最近一个**未来截止时间。
 *
 * 用法：node tools/deadline-digest.js [--hours=48]
 * 前置：先跑过 `node extractor/reminder.js sync`；否则会提示先同步。
 */

const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch {
  /* 没有 .env 也继续 */
}

const { openStore } = require(path.join(ROOT, 'extractor', 'lib', 'reminder-store'));
const { reminderState } = require(path.join(ROOT, 'extractor', 'lib', 'homework-model'));

const HOUR_MS = 60 * 60 * 1000;
const argHours = process.argv.slice(2).find((item) => item.startsWith('--hours='));
const HOURS = Math.max(1, Number(argHours ? argHours.slice('--hours='.length) : 48) || 48);

function formatDeadline(iso) {
  if (!iso) return '无';
  return String(iso).replace('T', ' ').replace(/:\d{2}([+-]\d{2}:\d{2}|Z)?$/, '').slice(0, 16);
}

function formatLeft(ms) {
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `还剩 ${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `还剩 ${hours} 小时 ${minutes % 60} 分钟`;
  return `还剩 ${Math.floor(hours / 24)} 天 ${hours % 24} 小时`;
}

function line(homework, nowMs) {
  const left = Date.parse(homework.deadline) - nowMs;
  return `  · ${homework.classroomName} · ${homework.kindName} · ${homework.name}\n`
    + `    截止 ${formatDeadline(homework.deadline)}（${formatLeft(left)}）`;
}

function main() {
  const dataDir = process.env.EDUCODER_DATA_DIR || path.join(ROOT, 'data');
  const dbPath = process.env.EDUCODER_REMINDER_DB || path.join(dataDir, 'reminder.sqlite3');
  const store = openStore(dbPath);
  try {
    const accountId = String(process.env.EDUCODER_ACCOUNT || '').trim() || store.listAccounts()[0] || '';
    if (!accountId) {
      console.log('本地还没有任何快照，请先运行：node extractor/reminder.js sync');
      return;
    }
    const nowMs = Date.now();
    const rows = store.listPresent(accountId).map((row) => row.homework);

    // 只保留「待处理」；逾期、已完成、已归档等一律排除
    const pending = rows.filter((homework) => reminderState(homework, nowMs) === 'pending');
    const dated = pending
      .filter((homework) => homework.deadline && Date.parse(homework.deadline) - nowMs <= HOURS * HOUR_MS)
      .sort((a, b) => (a.deadline < b.deadline ? -1 : 1));
    const undated = pending.filter((homework) => !homework.deadline);

    const lastSync = store.lastSync(accountId) || '';
    console.log(`作业截止提醒 · 生成于 ${new Date().toLocaleString('zh-CN', { hour12: false })}（上次同步：${lastSync || '未知'}）`);

    console.log(`\n${HOURS} 小时内截止（${dated.length} 项）`);
    if (!dated.length) {
      console.log('  （无）');
    } else {
      for (const homework of dated) console.log(line(homework, nowMs));
    }

    if (undated.length) {
      // 没有截止时间的作业：取同一课堂里最近的未来截止时间作为参考
      const future = pending.filter((homework) => homework.deadline && Date.parse(homework.deadline) > nowMs);
      console.log(`\n无截止时间（${undated.length} 项）→ 该作业单最近一个截止时间`);
      for (const homework of undated) {
        const nearest = future
          .filter((other) => other.classroomCode === homework.classroomCode)
          .sort((a, b) => (a.deadline < b.deadline ? -1 : 1))[0];
        const hint = nearest
          ? `最近一个截止：${formatDeadline(nearest.deadline)}（${nearest.name}）`
          : '该作业单里没有其它带截止时间的作业';
        console.log(`  · ${homework.classroomName} · ${homework.kindName} · ${homework.name}\n    ${hint}`);
      }
    }
  } finally {
    store.close();
  }
}

try {
  main();
} catch (error) {
  console.log(`生成摘要失败：${error.message}`);
  process.exitCode = 1;
}
