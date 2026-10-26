#!/usr/bin/env node
'use strict';

/**
 * 图文作业附件下载：把某个课堂（默认「软件工程导论」）下**每个图文作业详情页
 * 挂载的附件文档**（docx/xlsx/pdf 等）下载到本地目录。
 *
 * ## 数据链路（tools/probe-homework-attachments.js 实测得出）
 *
 *     /api/users/{account}/courses.json                     → 本人进行中课堂
 *     /api/courses/{code}/homework_commons.json?type=1      → 图文作业列表
 *     /api/homework_commons/{homework_id}.json              → 作业详情
 *         └─ attachments[] ── download_url ──→ 阿里云 OSS 预签名直链
 *
 * `download_url` 是平台预签名好的 OSS 直链，**不需要 cookie、不需要签名头**，
 * 普通 HTTP GET 即可下载；链接由本工具每次运行时现取，不存在过期问题。
 *
 * ## 用法
 *
 * ```powershell
 * node tools/download-homework-attachments.js
 * node tools/download-homework-attachments.js --course=软件工程导论
 * node tools/download-homework-attachments.js --classroom=2i6ng7vp --out=D:\somewhere
 * node tools/download-homework-attachments.js --dry-run
 * ```
 *
 * ## 与提醒链路的关系
 *
 * 只读：不写题库存档、不碰答案、不提交任何东西；唯一写入的是 `--out` 目录。
 * 课堂/作业列表复用 `homework-collector.js`（分页完整性校验同一套）。
 *
 * ## Profile
 *
 * 登录态复用 `.educoder-browser`（与 npm run ui / reminder 共用），可用
 * `EDUCODER_PROFILE_DIR` 换一个 profile——**同一 profile 被另一个 Chromium
 * 占用时启动会失败**，这里做退避重试，仍失败会明确提示谁可能占着。
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch {
  /* 没有 .env 就只用环境变量 */
}

const { chromium } = require('playwright');
const api = require('../extractor/lib/educoder-api');
const { DATA_ORIGIN, discoverClassrooms, collectHomeworks } = require('../extractor/lib/homework-collector');

const SITE = 'https://www.educoder.net';
const DEFAULT_PROFILE_DIR = path.join(ROOT, '.educoder-browser');
const DEFAULT_OUT_DIR = 'E:\\jp-project\\touge\\未分类';
const DEFAULT_COURSE = '软件工程导论';

/** 浏览器启动退避（profile 偶发被占/刚释放）。 */
const LAUNCH_RETRY_DELAYS = [1000, 2000, 4000, 8000, 15000, 30000];

/** 命令行 `--key=value` 解析；非法/缺失键返回 null。 */
function argOf(argv, name) {
  const prefix = `--${name}=`;
  const hit = argv.find((item) => item.startsWith(prefix));
  if (!hit) return null;
  const value = hit.slice(prefix.length).trim();
  return value || null;
}

function log(message) {
  process.stdout.write(`${message}\n`);
}

/** Windows 文件名清洗：非法字符、结尾的点和空格、超长。 */
function safeFilename(name) {
  const cleaned = String(name || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/[\s.]+$/g, '')
    .slice(0, 200);
  return cleaned || 'unnamed';
}

/**
 * 启动持久化浏览器（与 reminder.js 同一套坑：channel=chromium、profile 占用重试）。
 */
async function launchContext(profileDir) {
  let lastError = null;
  for (let attempt = 0; attempt <= LAUNCH_RETRY_DELAYS.length; attempt += 1) {
    try {
      return await chromium.launchPersistentContext(profileDir, {
        headless: true,
        channel: 'chromium',
        viewport: { width: 1440, height: 900 }
      });
    } catch (error) {
      lastError = error;
      const message = String((error && error.message) || error);
      if (/Executable doesn't exist|playwright install/i.test(message)) {
        throw new Error('找不到 Chromium：请先 `npx playwright install chromium`。');
      }
      const busy = /ProcessSingleton|already in use|Target page, context or browser has been closed|exitCode=21/i.test(message);
      if (!busy || attempt === LAUNCH_RETRY_DELAYS.length) {
        throw new Error(
          `浏览器启动失败（${message.split('\n')[0]}）。`
          + ` 若提示 profile 占用，请关掉正在使用 ${profileDir} 的其它工具，或设 EDUCODER_PROFILE_DIR 换一个已登录的 profile。`
        );
      }
      await new Promise((resolve) => setTimeout(resolve, LAUNCH_RETRY_DELAYS[attempt]));
    }
  }
  throw new Error(`浏览器启动失败：${(lastError && lastError.message) || lastError}`);
}

/**
 * 打开浏览器确认登录，返回 { page, accountId, get, request }。
 * `get` 是带签名头的 data API 传输层；`request` 是可下载文件的 APIRequestContext。
 */
async function withSession(profileDir, work) {
  const context = await launchContext(profileDir);
  try {
    const page = context.pages()[0] || (await context.newPage());
    await page.goto(`${SITE}/`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    const probe = await api.checkLogin(page);
    if (!probe.loggedIn) {
      throw new Error(`${probe.reason}；请先用 npm run ui 打开控制台完成登录（profile：${profileDir}）。`);
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
      if (!verdict.ok) throw new Error(`接口读取失败（${pathname}）：${verdict.reason}`);
      return response.json();
    };
    return await work({ context, page, accountId, get });
  } finally {
    await context.close();
  }
}

/** 下载一个附件到 outDir，返回 { savedAs, bytes, skipped }。 */
async function downloadAttachment(request, outDir, filename, url) {
  const target = path.join(outDir, filename);
  if (fs.existsSync(target)) {
    const size = fs.statSync(target).size;
    if (size > 0) return { savedAs: filename, bytes: size, skipped: true };
  }

  // OSS 预签名直链：不带任何头直接 GET。拿 buffer 后一次落盘。
  const response = await request.get(url, { timeout: 120000 });
  const buffer = await response.body();
  const contentType = String(response.headers()['content-type'] || '');
  if (!response.ok() || !buffer || !buffer.length) {
    throw new Error(`下载失败（HTTP ${response.status()}，${buffer ? buffer.length : 0} 字节）`);
  }
  // 命中平台错误页时内容是 HTML/XML 而不是文档本体，宁可不写盘。
  if (/text\/html|application\/xml|text\/xml/i.test(contentType)) {
    throw new Error(`下载到的是错误页而非文档（content-type=${contentType}），链接可能已失效`);
  }
  fs.writeFileSync(target, buffer);
  return { savedAs: filename, bytes: buffer.length, skipped: false };
}

(async () => {
  const argv = process.argv.slice(2);
  const courseName = argOf(argv, 'course') || DEFAULT_COURSE;
  const outDir = path.resolve(argOf(argv, 'out') || DEFAULT_OUT_DIR);
  const classroomCode = argOf(argv, 'classroom');
  const dryRun = argv.includes('--dry-run');
  const profileDir = path.resolve(process.env.EDUCODER_PROFILE_DIR || DEFAULT_PROFILE_DIR);

  log(`输出目录：${outDir}${dryRun ? '（dry-run，不落盘）' : ''}`);
  log(`登录 profile：${profileDir}`);

  const summary = await withSession(profileDir, async ({ context, page, accountId, get }) => {
    // 1) 课堂：优先按课堂码指定，否则按名称匹配。
    let classrooms;
    let allowed;
    if (classroomCode) {
      classrooms = [{ id: null, name: `（指定）${classroomCode}`, code: classroomCode, canVisit: true }];
      allowed = new Set([classroomCode]);
    } else {
      const discovered = await discoverClassrooms(get, accountId);
      allowed = new Set(discovered.map((c) => c.code));
      classrooms = discovered.filter((c) => c.name.includes(courseName));
    }
    if (!classrooms.length) {
      throw new Error(`进行中课堂里没有名称包含「${courseName}」的课堂。`);
    }
    for (const classroom of classrooms) {
      log(`课堂：${classroom.name}（${classroom.code}）`);
    }

    // 2) 图文作业列表（cutoffDays=0：不做逾期过滤，全部要）。
    const homeworks = [];
    for (const classroom of classrooms) {
      homeworks.push(...(await collectHomeworks(get, classroom, 1, allowed, { accountId, cutoffDays: 0 })));
    }
    log(`图文作业：${homeworks.length} 个\n`);
    if (!homeworks.length) return { files: [] };

    fs.mkdirSync(outDir, { recursive: true });
    const manifest = [];
    let okCount = 0;
    let skipCount = 0;
    let failCount = 0;

    for (const homework of homeworks) {
      const entry = {
        homeworkId: homework.homeworkId,
        name: homework.name,
        deadline: homework.deadline,
        attachments: []
      };
      const detail = await get(`/api/homework_commons/${homework.homeworkId}.json`);
      const attachments = Array.isArray(detail.attachments) ? detail.attachments : [];
      if (!attachments.length) {
        log(`  ○ ${homework.name} —— 无附件`);
        entry.attachments.push({ status: 'none' });
        manifest.push(entry);
        continue;
      }
      for (const att of attachments) {
        const title = att && (att.title || att.filename);
        const url = att && (att.download_url || att.url);
        if (!title || !url) {
          failCount += 1;
          entry.attachments.push({ title: title || null, status: 'fail', reason: '缺少文件名或下载链接' });
          log(`  × ${homework.name} —— 附件字段异常：${JSON.stringify(att).slice(0, 120)}`);
          continue;
        }
        const filename = safeFilename(title);
        if (dryRun) {
          log(`  · ${filename}（${att.filesize || '?'}）`);
          entry.attachments.push({ title, status: 'dry-run' });
          continue;
        }
        try {
          const result = await downloadAttachment(context.request, outDir, filename, url);
          if (result.skipped) {
            skipCount += 1;
            entry.attachments.push({ title, savedAs: result.savedAs, bytes: result.bytes, status: 'skip' });
            log(`  = ${filename}（已存在，跳过）`);
          } else {
            okCount += 1;
            entry.attachments.push({ title, savedAs: result.savedAs, bytes: result.bytes, status: 'ok' });
            log(`  ↓ ${filename}（${(result.bytes / 1024).toFixed(1)} KB）`);
          }
        } catch (error) {
          failCount += 1;
          entry.attachments.push({ title, status: 'fail', reason: error.message });
          log(`  × ${filename} —— ${error.message}`);
        }
      }
      manifest.push(entry);
    }

    if (!dryRun) {
      const manifestPath = path.join(outDir, '_附件清单.json');
      fs.writeFileSync(manifestPath, JSON.stringify({
        generatedAt: new Date().toISOString(),
        course: courseName,
        classrooms: classrooms.map((c) => ({ name: c.name, code: c.code })),
        homeworks: manifest
      }, null, 2));
      log(`\n清单：${manifestPath}`);
    }
    log(`\n完成：新下载 ${okCount}，已存在 ${skipCount}，失败 ${failCount}。`);
    if (failCount > 0) process.exitCode = 1;
    return { files: manifest };
  });

  return summary;
})().catch((error) => {
  console.error(`\n失败：${(error && error.message) || error}`);
  process.exitCode = 1;
});
