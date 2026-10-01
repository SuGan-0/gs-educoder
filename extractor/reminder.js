#!/usr/bin/env node
'use strict';

/**
 * 作业提醒命令行（移植自参考实现 educoder-reminder 的运行语义，Node 侧重写）。
 *
 * ## 命令
 *
 * ```text
 * node extractor/reminder.js check          只校验配置，不联网、不投递
 * node extractor/reminder.js auth-check     验证登录态（失效时明确报出原因）
 * node extractor/reminder.js sync           采集一次并打印两类作业与截止时间
 * node extractor/reminder.js status         打印当前待办（并刷新本地待办文件）
 * node extractor/reminder.js preview        只用本地快照预览「此刻该提醒什么」
 * node extractor/reminder.js once           同步（如到期）+ 检查一次 + 按需投递
 * node extractor/reminder.js run            常驻：定期全量同步，每分钟检查提醒
 * node extractor/reminder.js test           投递一条测试通知
 * node extractor/reminder.js test-upcoming [--days=N]   投递「未来 N 天截止」真实数据汇总（默认 5 天）
 * ```
 *
 * `auth-check` / `sync` / `status` 只需要登录态或本地快照，**不需要任何推送密钥**。
 *
 * ## 投递通道（`REMINDER_CHANNEL`）
 *
 * | 通道 | 说明 |
 * | --- | --- |
 * | `local` | **不发手机**：待办写成 `data/pending-reminders.md`，提醒流水写 `data/reminders.log` |
 * | `serverchan` | 推到微信（Server 酱 Turbo / Server 酱³），需要 `SERVERCHAN_SENDKEY` |
 *
 * 未显式设置时自动判定：有 SendKey 走 `serverchan`，没有则走 `local`。
 *
 * 两个通道**共用同一套去重记账**，所以随时可以在两者之间切换，数据不用迁移。
 *
 * ## 运行形态
 *
 * 这是**常驻服务**，不是「每天跑一次」的脚本：1 小时提醒需要分钟级检查，
 * 每天跑一次必然漏掉它。部署方式见 README。
 *
 * ## 与抓题链路的关系
 *
 * 本命令**只读**：读课堂、读作业列表，不打开关卡、不写题目存档、不碰答案。
 * 它只写 `data/` 下的东西（SQLite 快照与记账、本地待办与流水、进程锁）。
 *
 * ## 安全
 *
 * - 登录态复用现有浏览器 profile；本文件不读取、不打印任何账号密码。
 * - SendKey 只用于计算接收方哈希与发起推送，**不进日志、不进错误信息**。
 */

const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

/** 先加载 .env（Node 内置；不做 shell 插值——密码/密钥里的 `$` 不会被吃掉）。 */
try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch {
  /* 没有 .env 就只用环境变量 */
}

const { chromium } = require('playwright');
const api = require('./lib/educoder-api');
const { crawl, collectHomeworks, discoverClassrooms } = require('./lib/homework-collector');
const { openStore } = require('./lib/reminder-store');
const { HomeworkError, KINDS, KIND_ORDER, reminderState, toBeijingIso } = require('./lib/homework-model');
const plan = require('./lib/reminder-plan');
const push = require('./lib/push-serverchan');
const notifyLocal = require('./lib/notify-local');
const processLock = require('./lib/process-lock');

const SITE = 'https://www.educoder.net';
const DATA_ORIGIN = 'https://data.educoder.net';
const DEFAULT_DATA_DIR = path.join(ROOT, 'data');
const DEFAULT_PROFILE_DIR = path.join(ROOT, '.educoder-browser');

const VALID_MODES = ['once', 'daily'];
const VALID_POLICIES = ['defer', 'skip'];
const VALID_CHANNELS = ['local', 'serverchan'];
const COMMANDS = ['check', 'auth-check', 'sync', 'status', 'preview', 'once', 'run', 'test', 'test-upcoming'];

/** `test-upcoming` 的默认范围（天）。 */
const UPCOMING_DAYS = 5;

/** 解析 `--days=N`（用于 `test-upcoming` 换个范围核对）。非法值回退到默认。 */
function parseDays(argv, fallback) {
  const arg = (Array.isArray(argv) ? argv : []).find((item) => String(item).startsWith('--days='));
  if (!arg) return fallback;
  const value = Number(String(arg).slice('--days='.length));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function log(message) {
  process.stdout.write(`${message}\n`);
}

/** 数据目录（SQLite、本地待办、流水、锁都在这）。 */
function dataDirOf() {
  return process.env.EDUCODER_DATA_DIR
    || path.dirname(process.env.EDUCODER_REMINDER_DB || path.join(DEFAULT_DATA_DIR, 'reminder.sqlite3'));
}

/**
 * 基础配置：登录态、路径、采集参数。
 *
 * 与提醒策略/通道配置分开，是为了让 `auth-check` 这类诊断命令在
 * **任何配置都不完整时**也能跑——排查问题不该被配置校验挡住。
 */
function readBaseConfig() {
  const dataDir = dataDirOf();
  return {
    dataDir,
    dbPath: process.env.EDUCODER_REMINDER_DB || path.join(dataDir, 'reminder.sqlite3'),
    lockFile: path.join(dataDir, 'reminder.lock'),
    profileDir: process.env.EDUCODER_PROFILE_DIR || DEFAULT_PROFILE_DIR,
    headless: process.env.EDUCODER_HEADLESS !== '0',
    cutoffDays: Number(process.env.REMINDER_CUTOFF_DAYS || 5),
    accountId: String(process.env.EDUCODER_ACCOUNT || '').trim()
  };
}

/** 解析投递通道；未显式设置时按有无 SendKey 自动判定。 */
function resolveChannel() {
  const sendKey = String(process.env.SERVERCHAN_SENDKEY || '').trim();
  const explicit = String(process.env.REMINDER_CHANNEL || '').trim().toLowerCase();
  const channel = explicit || (sendKey ? 'serverchan' : 'local');
  if (!VALID_CHANNELS.includes(channel)) {
    throw new HomeworkError(`REMINDER_CHANNEL 只能是 ${VALID_CHANNELS.join(' 或 ')}。`);
  }
  if (channel === 'serverchan' && !sendKey) {
    throw new HomeworkError('REMINDER_CHANNEL=serverchan 但缺少 SERVERCHAN_SENDKEY。');
  }
  return { channel, sendKey };
}

/**
 * 提醒配置。任何一项非法都直接抛错——**不猜默认值继续跑**：
 * 「配置错了但看起来在运行」比直接报错危险得多。
 */
function readReminderConfig() {
  const { channel, sendKey } = resolveChannel();
  const undatedMode = String(process.env.UNDATED_REMINDER_MODE || '').trim();
  if (!VALID_MODES.includes(undatedMode)) {
    throw new HomeworkError('请设置 UNDATED_REMINDER_MODE=once（只提醒一次）或 daily（每天一次）。');
  }
  const quotaPolicy = String(process.env.QUOTA_POLICY || '').trim();
  if (!VALID_POLICIES.includes(quotaPolicy)) {
    throw new HomeworkError('请设置 QUOTA_POLICY=defer（次日重判补发）或 skip（跳过当前阶段）。');
  }
  const syncHours = Number(process.env.SYNC_INTERVAL_HOURS || 6);
  const checkSeconds = Number(process.env.REMINDER_CHECK_INTERVAL_SECONDS || 60);
  if (!Number.isFinite(syncHours) || syncHours <= 0) throw new HomeworkError('SYNC_INTERVAL_HOURS 必须为正数。');
  if (!Number.isFinite(checkSeconds) || checkSeconds < 1) throw new HomeworkError('REMINDER_CHECK_INTERVAL_SECONDS 必须为正数。');

  let provider = '本地文件';
  let receiver = 'local';
  // 本地通道没有服务端额度限制；仍然记账，好处是 `data/reminders.log` 与
  // 「什么时候提醒过」有一份可查的历史。
  let dailyLimit = Number.POSITIVE_INFINITY;
  if (channel === 'serverchan') {
    provider = push.endpoint(sendKey).provider;
    receiver = push.receiverId(sendKey);
    dailyLimit = Number(process.env.SERVERCHAN_DAILY_LIMIT || 5);
    if (!Number.isFinite(dailyLimit) || dailyLimit < 1) {
      throw new HomeworkError('SERVERCHAN_DAILY_LIMIT 必须是正整数。');
    }
    if (provider === 'Turbo' && dailyLimit > 5) {
      throw new HomeworkError('当前使用免费 Turbo 通道，日发送上限不能超过 5 次。');
    }
  }

  return { ...readBaseConfig(), channel, provider, sendKey, receiver, dailyLimit, undatedMode, quotaPolicy, syncHours, checkSeconds };
}

/** 单实例锁：避免 systemd 与手工命令同时跑，导致重复投递。 */
function acquireLock(config) {
  return processLock.acquireLock(config.lockFile);
}

/** profile 被占用时的重试间隔（同一个 user-data-dir 不能被两个 Chromium 同时使用）。 */
const LAUNCH_RETRY_DELAYS = [1000, 2000, 4000];

/**
 * 启动持久化浏览器。
 *
 * 两个容易踩的坑，都在这里处理掉：
 *
 * 1. **无头模式必须显式 `channel: 'chromium'`**。Playwright 的 `headless: true` 默认去找
 *    `chrome-headless-shell`，而多数环境只装了完整 chromium（`npx playwright install chromium`），
 *    于是报「Executable doesn't exist」。指定 channel 后走完整 chromium 的新无头模式。
 * 2. **profile 被占用**（控制台还开着、或上次崩溃残留）会以
 *    「Target page, context or browser has been closed」这类含糊信息失败。
 *    这里重试几次，仍失败就给一句能照做的说明，而不是把 Playwright 的原始堆栈丢给用户。
 */
async function launchContext(config) {
  let lastError = null;
  for (let attempt = 0; attempt <= LAUNCH_RETRY_DELAYS.length; attempt += 1) {
    try {
      return await chromium.launchPersistentContext(config.profileDir, {
        ...(config.headless ? { headless: true, channel: 'chromium' } : { headless: false }),
        viewport: { width: 1440, height: 900 }
      });
    } catch (error) {
      lastError = error;
      const message = String((error && error.message) || error);
      if (/Executable doesn't exist|playwright install/i.test(message)) {
        throw new HomeworkError(
          '找不到 Chromium 可执行文件：请先执行 `npx playwright install chromium`（服务器上还需安装对应系统依赖）。'
        );
      }
      const locked = /ProcessSingleton|already in use|Target page, context or browser has been closed|exitCode=21/i.test(message);
      if (!locked) throw new HomeworkError(`浏览器启动失败：${message.split('\n')[0]}`);
      if (attempt === LAUNCH_RETRY_DELAYS.length) {
        throw new HomeworkError(
          `浏览器 profile 被占用（${config.profileDir}）：请先关闭正在运行的控制台（npm run ui）`
            + '或其它使用该目录的 Chromium，再重试。'
        );
      }
      await new Promise((resolve) => setTimeout(resolve, LAUNCH_RETRY_DELAYS[attempt]));
    }
  }
  throw new HomeworkError(`浏览器启动失败：${(lastError && lastError.message) || lastError}`);
}

/**
 * 打开浏览器、确认登录，然后返回注入式传输层。
 *
 * 必须**先访问站点**：`page.evaluate(fetch)` 是相对当前 origin 发出的，
 * 停在 `about:blank` 上会被 CORS 拦掉（null origin）。
 */
async function withSession(config, work) {
  const context = await launchContext(config);
  try {
    const page = context.pages()[0] || (await context.newPage());
    await page.goto(`${SITE}/`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    const probe = await api.checkLogin(page);
    if (!probe.loggedIn) {
      throw new HomeworkError(
        `${probe.reason}；请先用 npm run ui 打开一次控制台完成登录（登录态存于 ${config.profileDir}）。`
      );
    }
    const accountId = probe.user;
    const get = async (pathname, params = {}) => {
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries({ ...params, zzud: accountId })) {
        if (value === undefined || value === null) continue;
        query.set(key, String(value));
      }
      const response = await api.apiGet(page, `${DATA_ORIGIN}${pathname}?${query.toString()}`);
      const verdict = api.classifyResponse(response.status, response.text);
      if (!verdict.ok) throw new HomeworkError(`接口读取失败（${pathname}）：${verdict.reason}`);
      return response.json();
    };
    return await work({ page, accountId, get });
  } finally {
    await context.close();
  }
}

/** 距上次成功同步是否已超过间隔（没有记录时立即同步）。 */
function syncDue(lastSyncedAt, nowMs, syncHours) {
  if (!lastSyncedAt) return true;
  const ms = Date.parse(lastSyncedAt);
  if (!Number.isFinite(ms)) return true;
  return nowMs - ms >= syncHours * 60 * 60 * 1000;
}

/**
 * 重写本地待办视图（`data/pending-reminders.md`）。
 *
 * **与投递通道无关，永远维护**：它是「现在还剩什么没做」的完整现状，
 * 而提醒流水只记录「什么时候提醒过」。两者互补，缺一个都会让人看不明白。
 */
async function refreshPending(store, config, accountId, nowMs) {
  const rows = store.listPresent(accountId);
  const document = plan.renderPending(rows.map((row) => row.homework), nowMs, {
    generatedAt: toBeijingIso(nowMs)
  });
  const { pending } = notifyLocal.localPaths(config.dataDir);
  await notifyLocal.writePending(pending, document);
  return pending;
}

/** 全量同步一次并落盘。失败时不写任何东西（由 saveSnapshot 的事务保证）。 */
async function syncAll(store, config) {
  return withSession(config, async ({ accountId, get }) => {
    const { classrooms, homeworks } = await crawl(get, accountId, { cutoffDays: config.cutoffDays });
    const nowMs = Date.now();
    const result = store.saveSnapshot(accountId, homeworks, toBeijingIso(nowMs));
    log(`同步完成：${classrooms.length} 个课堂、${homeworks.length} 项作业（截止时间变更 ${result.deadlineChanges} 条）。`);
    const pendingPath = await refreshPending(store, config, accountId, nowMs);
    return { accountId, classrooms, homeworks, pendingPath, ...result };
  });
}

const STATE_LABEL = {
  archived: '已归档',
  completed: '已完成',
  unknown_completion: '完成状态未知',
  unpublished: '未发布',
  unknown_publication: '发布时间未知',
  no_deadline: '无截止时间',
  overdue: '已逾期',
  pending: '待处理'
};

/**
 * 打印一次采集结果：**两类作业都要逐项列出截止时间与状态**。
 *
 * 这是「采集链路是否真的通」的自检输出，不涉及投递。
 */
function summarizeCollection(accountId, classrooms, homeworks, nowMs) {
  log(`账号：${accountId}；进行中课堂 ${classrooms.length} 个；作业 ${homeworks.length} 项。`);
  if (classrooms.length) {
    log(`课堂：${classrooms.map((item) => `${item.name}（${item.code}）`).join('、')}`);
  }
  for (const kind of KIND_ORDER) {
    const list = homeworks.filter((item) => item.kind === kind);
    log(`\n【${KINDS[kind].name}】type=${kind}：${list.length} 项`);
    if (!list.length) {
      log('  （本次没有采集到该类作业）');
      continue;
    }
    const sorted = [...list].sort((a, b) => {
      const left = a.deadline || '9999';
      const right = b.deadline || '9999';
      if (left !== right) return left < right ? -1 : 1;
      return Number(a.homeworkId) - Number(b.homeworkId);
    });
    for (const item of sorted) {
      const state = reminderState(item, nowMs);
      log(`  · [${STATE_LABEL[state] || state}] ${item.classroomName}（${item.classroomCode}） / ${item.name}`);
      log(`      截止：${item.deadline ? plan.formatBeijing(item.deadline) : '（无截止时间）'}`);
    }
  }
  const counts = {};
  for (const item of homeworks) {
    const state = reminderState(item, nowMs);
    counts[state] = (counts[state] || 0) + 1;
  }
  log(`\n状态分布：${Object.entries(counts).map(([key, value]) => `${STATE_LABEL[key] || key} ${value}`).join('、') || '（无）'}`);
}

/** 只复核「本次真要提醒的课堂/作业类型」——不为了发一条提醒而全量重抓。 */
async function recheckScopes(store, config, accountId, notices) {
  const scopes = plan.recheckScopes(notices);
  if (!scopes.length) return;
  await withSession(config, async ({ get }) => {
    const classrooms = await discoverClassrooms(get, accountId, {});
    const byCode = new Map(classrooms.map((item) => [item.code, item]));
    const collected = [];
    for (const [code, kind] of scopes) {
      const classroom = byCode.get(code);
      // 课堂已退出/结束：本次不刷新，交给下次全量同步按 present 标记消失。
      if (!classroom) continue;
      collected.push(
        ...(await collectHomeworks(get, classroom, kind, new Set([code]), {
          accountId,
          cutoffDays: config.cutoffDays
        }))
      );
    }
    store.saveSnapshot(accountId, collected, toBeijingIso(Date.now()), { scopes });
  });
}

/** 用当前快照算出「此刻该提醒、且还没提醒过」的事件。 */
function dueNotices(store, config, accountId, nowMs) {
  const rows = store.listPresent(accountId);
  const candidates = plan.candidateNotices(rows, nowMs, config.undatedMode);
  const states = store.pushStates(config.receiver, candidates.map((item) => item.event));
  return plan.applyDedup(candidates, states, nowMs);
}

/**
 * 按通道投递一条提醒。
 *
 * 两个通道的**去重语义完全一致**：调用方在投递前后照常写 `push_attempts` /
 * `push_events`，所以从 `local` 换成 `serverchan` 不需要迁移任何数据。
 */
async function deliver(config, { title, body }) {
  if (config.channel === 'local') {
    const { log: logPath } = notifyLocal.localPaths(config.dataDir);
    const result = await notifyLocal.appendLog(logPath, {
      title,
      body,
      nowLabel: plan.formatBeijing(toBeijingIso(Date.now()))
    });
    log(`已写入本地提醒流水（第 ${result.seq} 次）：${logPath}`);
    return;
  }
  await push.send(config.sendKey, title, body);
}

/**
 * 一次提醒检查。
 * @returns {Promise<string>} nothing_due / delivered / quota_exhausted / preview
 */
async function tick(store, config, { preview = false } = {}) {
  let nowMs = Date.now();
  let accountId = config.accountId || store.listAccounts()[0] || '';

  if (preview) {
    if (!accountId) {
      log('本地还没有任何快照，先跑一次同步（npm run reminder -- sync）再预览。');
      return 'nothing_due';
    }
    const due = dueNotices(store, config, accountId, nowMs);
    log(`本地预览：${due.length} 项到达提醒窗口（未联网、未投递）。`);
    if (due.length) {
      const { title, body } = plan.render(due, nowMs);
      log(`${title}\n${body}`);
    }
    return 'preview';
  }

  // 到期就全量同步；库里还没账号时也必须先同步一次才能确定「当前登录的是谁」。
  if (!accountId || syncDue(store.lastSync(accountId), nowMs, config.syncHours)) {
    const result = await syncAll(store, config);
    accountId = result.accountId;
    nowMs = Date.now();
  }
  if (!accountId) return 'nothing_due';

  const due = dueNotices(store, config, accountId, nowMs);
  if (!due.length) return 'nothing_due';

  const day = plan.beijingDay(nowMs);
  if (store.quotaRemaining(config.receiver, day, config.dailyLimit) <= 0) {
    if (config.quotaPolicy === 'skip') {
      store.markSkipped(config.receiver, due.map((item) => item.event), toBeijingIso(nowMs));
      log(`今日额度已用尽，${due.length} 项按 skip 策略标记跳过。`);
    } else {
      log(`今日额度已用尽，${due.length} 项按 defer 策略留待下次重判。`);
    }
    return 'quota_exhausted';
  }

  // 投递前复核：老师可能刚延期、学生可能刚提交，不能拿旧快照提醒。
  await recheckScopes(store, config, accountId, due);
  nowMs = Date.now();
  const fresh = dueNotices(store, config, accountId, nowMs);
  if (!fresh.length) return 'nothing_due';

  const batches = plan.splitBatches(fresh, nowMs);
  if (!batches.length) throw new HomeworkError('单项通知内容过长，未投递；请检查作业名称。');

  let delivered = 0;
  let remaining = store.quotaRemaining(config.receiver, day, config.dailyLimit);
  for (const batch of batches) {
    if (remaining <= 0) break;
    const attemptId = store.beginAttempt(config.receiver, day, toBeijingIso(Date.now()), batch.map((item) => item.event));
    const { title, body } = plan.render(batch, Date.now());
    try {
      await deliver(config, { title, body });
    } catch (error) {
      store.markFailed(attemptId, error.message);
      throw error;
    }
    store.markSent(attemptId);
    delivered += batch.length;
    remaining -= 1;
  }
  if (delivered) await refreshPending(store, config, accountId, Date.now());
  return delivered ? 'delivered' : 'quota_exhausted';
}

/**
 * 投递「未来 N 天截止」的真实数据汇总。
 *
 * 与 `test` 的区别：内容来自**真实快照**，用来核对采集与截止时间是否算对。
 * 它占用一次额度（避免绕过额度保护），但**不写 push_events**，
 * 因此不会把正式的 24 小时 / 1 小时提醒「吃掉」。
 */
async function sendUpcoming(config, store, days = UPCOMING_DAYS) {
  const nowMs = Date.now();
  const day = plan.beijingDay(nowMs);
  if (store.quotaRemaining(config.receiver, day, config.dailyLimit) <= 0) {
    log('今日额度已用尽，未投递汇总。');
    return;
  }

  let accountId = config.accountId || store.listAccounts()[0] || '';
  if (!accountId) {
    const result = await syncAll(store, config);
    accountId = result.accountId;
  }
  const untilMs = nowMs + days * 24 * 60 * 60 * 1000;
  const homeworks = store.listPresent(accountId)
    .map((row) => row.homework)
    .filter((homework) => reminderState(homework, nowMs) === 'pending'
      && Date.parse(homework.deadline) <= untilMs)
    .sort((a, b) => (a.deadline < b.deadline ? -1 : 1));

  const { title, body } = plan.renderUpcoming(homeworks, nowMs, days);
  const attemptId = store.beginAttempt(config.receiver, day, toBeijingIso(nowMs), []);
  try {
    await deliver(config, { title, body });
  } catch (error) {
    store.markFailed(attemptId, error.message);
    throw error;
  }
  store.markSent(attemptId);
  log(`${title}（通道：${config.channel === 'local' ? '本地文件' : config.provider}）`);
}

/** 投递一条测试通知（占用一次额度，但不写正式提醒事件）。 */
async function sendTest(config) {
  const store = openStore(config.dbPath);
  try {
    const nowMs = Date.now();
    const day = plan.beijingDay(nowMs);
    if (store.quotaRemaining(config.receiver, day, config.dailyLimit) <= 0) {
      log('今日额度已用尽，未投递测试通知。');
      return;
    }
    const attemptId = store.beginAttempt(config.receiver, day, toBeijingIso(nowMs), []);
    try {
      await deliver(config, {
        title: '作业提醒工具 · 测试通知',
        body: '投递通道已连接。此消息仅用于测试，不代表有作业即将截止。'
      });
    } catch (error) {
      store.markFailed(attemptId, error.message);
      throw error;
    }
    store.markSent(attemptId);
    log(config.channel === 'local'
      ? '测试通知已写入本地提醒流水。'
      : `测试通知已被 Server 酱（${config.provider}）接受，请在接收端确认。`);
  } finally {
    store.close();
  }
}

/** 打印当前待办（并顺手刷新本地待办文件）。 */
async function showStatus(store, config) {
  const nowMs = Date.now();
  const accountId = config.accountId || store.listAccounts()[0] || '';
  if (!accountId) {
    log('本地还没有任何快照，先跑一次 npm run reminder -- sync。');
    return;
  }
  const pendingPath = await refreshPending(store, config, accountId, nowMs);
  const rows = store.listPresent(accountId);
  log(plan.renderPending(rows.map((row) => row.homework), nowMs, { generatedAt: toBeijingIso(nowMs) }));
  log(`上次同步：${store.lastSync(accountId) || '（无记录）'}`);
  log(`通道：${config.channel === 'local' ? '本地文件' : `Server 酱 ${config.provider}`}；待办文件：${pendingPath}`);
  if (config.channel === 'local') {
    log(`提醒流水：${notifyLocal.localPaths(config.dataDir).log}`);
  }
}

async function main() {
  const command = process.argv[2] || 'check';
  if (!COMMANDS.includes(command)) {
    throw new HomeworkError(`未知命令：${command}（可用：${COMMANDS.join(' / ')}）`);
  }

  // 纯诊断：只要登录态，不校验任何提醒/通道配置。
  if (command === 'auth-check') {
    await withSession(readBaseConfig(), async ({ accountId }) => {
      log(`Educoder 登录有效，账号标识：${accountId}。`);
    });
    return;
  }

  const config = readReminderConfig();

  if (command === 'check') {
    log(
      `配置有效：通道 ${config.channel === 'local' ? 'local（本地文件，不发手机）' : `serverchan / ${config.provider}`}；`
        + `同步间隔 ${config.syncHours} 小时；检查间隔 ${config.checkSeconds} 秒；`
        + `日额度 ${Number.isFinite(config.dailyLimit) ? config.dailyLimit : '不限'}；`
        + `无截止提醒 ${config.undatedMode}；额度策略 ${config.quotaPolicy}。`
    );
    log(`数据目录：${config.dataDir}`);
    return;
  }

  if (command === 'test') {
    await sendTest(config);
    return;
  }

  const release = acquireLock(config);
  const store = openStore(config.dbPath);
  try {
    if (command === 'sync') {
      const result = await syncAll(store, config);
      summarizeCollection(result.accountId, result.classrooms, result.homeworks, Date.now());
      log(`\n本地待办文件：${result.pendingPath}`);
      return;
    }
    if (command === 'status') {
      await showStatus(store, config);
      return;
    }
    if (command === 'test-upcoming') {
      await sendUpcoming(config, store, parseDays(process.argv.slice(3), UPCOMING_DAYS));
      return;
    }
    if (command === 'preview') {
      await tick(store, config, { preview: true });
      return;
    }
    if (command === 'once') {
      log(`提醒检查：${await tick(store, config)}`);
      return;
    }
    log(`定时任务已启动：每 ${config.syncHours} 小时同步，每 ${config.checkSeconds} 秒检查提醒；通道 ${config.channel}。`);
    for (;;) {
      const started = Date.now();
      try {
        const result = await tick(store, config);
        if (result !== 'nothing_due') log(`提醒检查：${result}`);
      } catch (error) {
        // 常驻模式不因单次失败退出；这些消息里不含凭据。
        log(`本轮检查失败：${error.message}`);
      }
      const elapsed = Date.now() - started;
      await new Promise((resolve) => setTimeout(resolve, Math.max(1000, config.checkSeconds * 1000 - elapsed)));
    }
  } finally {
    store.close();
    release();
  }
}

main().catch((error) => {
  log(`失败：${error.message}`);
  process.exitCode = 1;
});
