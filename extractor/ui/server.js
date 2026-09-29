'use strict';

/**
 * 本地控制台 HTTP 服务（契约见 docs/ARCHITECTURE.md 第 4 节）。
 *
 * 职责：把引擎事件（emit）转成 SSE 推给浏览器，并把浏览器动作（POST /api/action）
 * 交回外壳的 onControl。本模块不接触 Playwright，只维护一份内存快照并转发。
 *
 * 安全边界（本地工具，不引入 HTTPS / 账号 / 持久化等机制）：
 * - 只监听 127.0.0.1；
 * - token 由 crypto.randomBytes 生成，随 url 交给浏览器；
 * - 所有 /api/* 必须同时通过 Origin（缺失或同源）与 token 校验，否则 403；
 * - POST /api/action 请求体上限 64KB；
 * - 内存中最多保留最近 500 条日志。
 */

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const { normalizeAnswer } = require('../lib/task-parser');
const { mergeAnswer } = require('../lib/answer-store');
const { readMissingDocument, addMissing, removeMissing, clearMissing } = require('../lib/missing-store');

const MAX_LOGS = 500; // 内存中最多保留的日志条数
const MAX_BODY_BYTES = 64 * 1024; // POST /api/action 请求体上限（字节）
const HARD_BODY_BYTES = MAX_BODY_BYTES * 16; // 超限后继续 drain 的硬上限，防御性
const HEARTBEAT_MS = 15_000; // SSE 心跳，防代理/浏览器判定空闲断连
const INDEX_FILE = path.join(__dirname, 'public', 'index.html');

const ACTIONS = new Set([
  'select-course',
  'select-experiments',
  'select-levels',
  'start',
  'reset',
  'stop',
  // 诊断：在已打开的抓取浏览器里检查 cookie / 登录接口原文 / DOM / 时间偏差。
  // 外壳 run.js 实现了该动作，这里必须放行，否则按钮永远返回「未知动作」。
  'diagnose'
]);
const LOGIN_PHASES = new Set(['login', 'waiting-login']);
const LOG_LEVELS = new Set(['info', 'warn', 'error']);
const ARRAY_KEYS = new Set([
  'courses',
  'experiments',
  'levels',
  'levelsExperiments',
  'selectedExperiments',
  'selectedLevels'
]);
/** 已提取内容的展示上限（避免长会话把快照撑大）。 */
const EXTRACTED_LIMIT = 500;

function createSnapshot() {
  return {
    phase: 'starting',
    message: '等待引擎启动…',
    user: null,
    loggedIn: false,
    courses: [],
    experiments: [],
    levels: [],
    levelsMulti: false,
    levelsExperiments: [],
    selectedCourse: null,
    selectedExperiments: [],
    selectedLevels: [],
    progress: { saved: 0, skipped: 0, failed: 0, current: 0, total: 0, existing: 0, dropped: 0 },
    // 本次会话已提取的内容（跨多轮累积，直到「开始提取」重置）
    extracted: [],
    // AI 作答任务的状态（课程/实验/进度/结果），由 /api/answer/* 驱动
    answer: { running: false, stopped: false, course: '', experiment: '', done: 0, total: 0, message: '', results: [], log: [] },
    logs: [],
    done: null
  };
}

function cloneSnapshot(snapshot) {
  const list = (value) => (Array.isArray(value) ? value.slice() : []);
  return {
    ...snapshot,
    courses: list(snapshot.courses),
    experiments: list(snapshot.experiments),
    levels: list(snapshot.levels),
    levelsExperiments: list(snapshot.levelsExperiments),
    selectedExperiments: list(snapshot.selectedExperiments),
    selectedLevels: list(snapshot.selectedLevels),
    progress: { ...(snapshot.progress && typeof snapshot.progress === 'object' ? snapshot.progress : {}) },
    extracted: list(snapshot.extracted).map((entry) => ({ ...entry })),
    logs: list(snapshot.logs).map((entry) => ({ ...entry })),
    done: snapshot.done ? { ...snapshot.done } : null
  };
}

function appendLog(snapshot, level, message) {
  if (!Array.isArray(snapshot.logs)) snapshot.logs = []; // setSnapshot 传了脏值时自愈
  snapshot.logs.push({
    time: new Date().toISOString(),
    level: LOG_LEVELS.has(level) ? level : 'info',
    message: String(message === undefined || message === null ? '' : message)
  });
  if (snapshot.logs.length > MAX_LOGS) {
    snapshot.logs.splice(0, snapshot.logs.length - MAX_LOGS);
  }
}

/**
 * 记录一条「已提取内容」，供界面展示本次会话抓到/复用了哪些关卡。
 * 跨多轮累积（便于「继续提取」后回顾），直到「开始提取」触发 reset 才清空。
 */
function appendExtracted(snapshot, entry) {
  if (!Array.isArray(snapshot.extracted)) snapshot.extracted = [];
  snapshot.extracted.push({
    time: new Date().toISOString().slice(11, 19),
    status: entry.status === 'reused' ? 'reused' : 'saved',
    title: String(entry.title || ''),
    level: String(entry.level || ''),
    taskType: String(entry.taskType || ''),
    images: Number.isFinite(entry.images) ? entry.images : 0,
    path: String(entry.path || ''),
    directory: String(entry.directory || ''),
    experiment: String(entry.experiment || ''),
    course: String(entry.course || '')
  });
  if (snapshot.extracted.length > EXTRACTED_LIMIT) {
    snapshot.extracted.splice(0, snapshot.extracted.length - EXTRACTED_LIMIT);
  }
}

// 只接受真实数字，避免字符串把计数污染成 NaN。
function toCount(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

/**
 * 把一条引擎事件并入内存快照（事件协议见 docs/ARCHITECTURE.md 第 3 节）。
 * 未知事件类型只转发、不改快照。
 */
function applyEvent(snapshot, evt) {
  switch (evt.type) {
    case 'status': {
      if (typeof evt.phase === 'string') snapshot.phase = evt.phase;
      if (typeof evt.message === 'string') snapshot.message = evt.message;
      if (typeof evt.user === 'string' && evt.user) snapshot.user = evt.user;
      // loggedIn 由事件显式给出最好；否则用户名字段可推断已登录，登录阶段推断未登录，
      // 其余阶段保持原值，不猜测。
      if (typeof evt.loggedIn === 'boolean') snapshot.loggedIn = evt.loggedIn;
      else if (typeof evt.user === 'string' && evt.user) snapshot.loggedIn = true;
      else if (LOGIN_PHASES.has(evt.phase)) snapshot.loggedIn = false;
      return;
    }
    case 'courses':
      snapshot.courses = Array.isArray(evt.courses) ? evt.courses : [];
      return;
    case 'experiments':
      snapshot.experiments = Array.isArray(evt.experiments) ? evt.experiments : [];
      // 引擎已确定课程（waitForCourse 已 resolve），同步 selectedCourse 保持快照自洽。
      if (evt.course && typeof evt.course === 'object') snapshot.selectedCourse = evt.course;
      return;
    case 'levels':
      snapshot.levels = Array.isArray(evt.levels) ? evt.levels : [];
      // 多实验合并列表：把「来自 N 个实验」也存进快照，刷新页面后仍能显示分组信息。
      snapshot.levelsMulti = Boolean(evt.multi);
      snapshot.levelsExperiments = Array.isArray(evt.experimentNames) ? evt.experimentNames.slice() : [];
      return;
    case 'progress':
      // 计数是覆盖语义，但 experimentName/levelName 等展示字段必须保留下来：
      // 早前整体替换会让「已提取内容」归组时拿不到实验名。
      snapshot.progress = {
        ...snapshot.progress,
        saved: toCount(evt.saved, snapshot.progress.saved),
        skipped: toCount(evt.skipped, snapshot.progress.skipped),
        failed: toCount(evt.failed, snapshot.progress.failed),
        current: toCount(evt.current, snapshot.progress.current),
        total: toCount(evt.total, snapshot.progress.total)
      };
      if (evt.experimentName != null) snapshot.progress.experimentName = String(evt.experimentName);
      if (evt.courseName != null) snapshot.progress.courseName = String(evt.courseName);
      if (evt.levelName != null) snapshot.progress.levelName = String(evt.levelName);
      if (evt.levelType != null) snapshot.progress.levelType = String(evt.levelType);
      return;
    case 'saved': {
      snapshot.progress.saved += 1;
      // 注意：事件协议里 saved 载荷的 type（题目类型）与事件判别字段 type 同名，
      // 引擎若沿用判别字段就无法同时携带题目类型，因此这里优先读 taskType。
      const taskType = evt.taskType || (evt.type && evt.type !== 'saved' ? evt.type : '');
      const type = taskType ? `[${taskType}] ` : '';
      const images = Number.isFinite(evt.images) && evt.images > 0 ? `（图片 ${evt.images} 张）` : '';
      appendExtracted(snapshot, {
        status: 'saved',
        title: evt.title || evt.level || '未命名关卡',
        level: evt.level || evt.title || '',
        taskType,
        images: Number.isFinite(evt.images) ? evt.images : 0,
        path: evt.path || '',
        directory: evt.directory || '',
        experiment: snapshot.progress.experimentName || '',
        course: snapshot.progress.courseName || snapshot.selectedCourse?.name || ''
      });
      appendLog(
        snapshot,
        'info',
        `已保存：${type}${evt.title || evt.level || '未命名关卡'}${images}${evt.path ? ` → ${evt.path}` : ''}`
      );
      return;
    }
    case 'reused': {
      // 本地已存在、未重复抓取的关卡：同样算「已提取内容」，只是来源标记为复用。
      appendExtracted(snapshot, {
        status: 'reused',
        title: evt.title || evt.level || '未命名关卡',
        level: evt.level || evt.title || '',
        taskType: evt.taskType || '',
        images: 0,
        path: evt.path || '',
        directory: evt.directory || '',
        experiment: snapshot.progress.experimentName || '',
        course: snapshot.progress.courseName || snapshot.selectedCourse?.name || ''
      });
      return;
    }
    case 'dropped': {
      // 题型白名单：非编程题/选择题（虚拟机、图形化、纯问答）被抛弃，只记日志与计数。
      snapshot.progress.dropped = toCount(evt.dropped, snapshot.progress.dropped + 1);
      appendLog(
        snapshot,
        'warn',
        `抛弃非编程题/选择题的关卡：${evt.title || evt.level || '未命名'}${evt.reason ? `（${evt.reason}）` : ''}`
      );
      return;
    }
    case 'answer': {
      // AI 作答进度：整包替换（字段少，直接覆盖最省心）。
      snapshot.answer = {
        running: Boolean(evt.running),
        stopped: Boolean(evt.stopped),
        course: String(evt.course || ''),
        experiment: String(evt.experiment || ''),
        done: toCount(evt.done, snapshot.answer.done),
        total: toCount(evt.total, snapshot.answer.total),
        message: String(evt.message || snapshot.answer.message || ''),
        results: Array.isArray(evt.results) ? evt.results : snapshot.answer.results,
        log: Array.isArray(evt.log) ? evt.log.slice(-50) : snapshot.answer.log
      };
      return;
    }
    case 'reset': {
      // 「开始提取」：清空上一轮的列表与已提取内容。
      // 选择相关的 pending 由外壳负责置空（否则引擎会等到新的选择）。
      snapshot.courses = [];
      snapshot.experiments = [];
      snapshot.levels = [];
      snapshot.selectedCourse = null;
      snapshot.selectedExperiments = [];
      snapshot.selectedLevels = [];
      snapshot.extracted = [];
      snapshot.done = null;
      snapshot.progress = { saved: 0, skipped: 0, failed: 0, current: 0, total: 0, existing: 0, dropped: 0 };
      snapshot.phase = 'starting';
      snapshot.message = '已清空上一轮内容，正在重新读取课程…';
      return;
    }
    case 'log':
      appendLog(snapshot, evt.level, evt.message);
      return;
    case 'done': {
      const payload = { ...evt };
      delete payload.type;
      // done 时把「已提取内容」一并带上：SSE 事件是短命的（会被后续事件覆盖），
      // 前端重启/刷新后靠快照也能恢复完整列表。
      payload.extracted = Array.isArray(snapshot.extracted) ? snapshot.extracted.slice() : [];
      snapshot.done = payload;
      snapshot.phase = 'done';
      snapshot.progress.saved = toCount(evt.saved, snapshot.progress.saved);
      snapshot.progress.skipped = toCount(evt.skipped, snapshot.progress.skipped);
      snapshot.progress.failed = toCount(evt.failed, snapshot.progress.failed);
      snapshot.message =
        `提取结束：已保存 ${snapshot.progress.saved}，跳过 ${snapshot.progress.skipped}，` +
        `失败 ${snapshot.progress.failed}` +
        `${snapshot.progress.dropped ? `，抛弃 ${snapshot.progress.dropped}` : ''}` +
        `${evt.stopped ? '（已手动停止）' : ''}`;
      return;
    }
    case 'error':
      snapshot.phase = 'error';
      if (typeof evt.message === 'string') snapshot.message = evt.message;
      if (evt.message) appendLog(snapshot, 'error', `错误：${evt.message}`);
      return;
    default:
      return;
  }
}

function sendJson(res, status, body) {
  if (res.writableEnded || res.destroyed) return;
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store'
  });
  res.end(text);
}

const badRequest = (message) => Object.assign(new Error(message), { status: 400 });

// 契约：动作失败返回 4xx/5xx + { ok:false, error }。onControl 未标注状态时按 400 处理。
function errorStatus(error) {
  const explicit = Number(error && (error.status !== undefined ? error.status : error.statusCode));
  if (Number.isInteger(explicit) && explicit >= 400 && explicit <= 599) return explicit;
  return 400;
}

/**
 * 启动本地控制台服务。
 *
 * @param {{ port?: number, onControl?: (action: string, payload: object) => any, open?: boolean }} options
 * @returns {Promise<{ url: string, port: number, close(): Promise<void>,
 *   emit(evt: object): number, getSnapshot(): object, setSnapshot(patch: object): object }>}
 */
async function startUiServer({ port = 0, onControl, onAnswerRun, onAnswerStop, open = true } = {}) {
  const token = crypto.randomBytes(24).toString('hex');
  const snapshot = createSnapshot();
  const clients = new Set();
  const allowedOrigins = new Set();
  /** AI 作答任务的状态（控制台面板用 /api/state 里的 answer 字段展示）。 */
  const answerJob = { running: false, stopped: false, course: '', experiment: '', done: 0, total: 0, message: '', results: [], log: [] };

  const exportRootDir = () => process.env.EDUCODER_EXPORT_ROOT || path.join(__dirname, '..', '..', 'exports');

  function answerLog(message, level = 'info') {
    answerJob.message = message;
    answerJob.log.push({ time: new Date().toISOString(), level, message });
    if (answerJob.log.length > 200) answerJob.log.splice(0, answerJob.log.length - 200);
    appendLog(snapshot, level, message);
    emit({ type: 'log', level, message });
  }

  /** 作答进度必须走 emit：它既进快照（刷新页面能恢复）也推 SSE。 */
  function publishAnswer(phase) {
    emit({ type: 'answer', phase, ...answerJob });
  }

  /**
   * 跑一个作答任务：只负责进度、日志、快照与 SSE，真正的模型调用由外壳（onAnswerRun）干。
   * 这样假服务（界面实测）与真实外壳都能注入自己的实现。
   */
  async function runAnswerJob(dispatch) {
    answerJob.running = true;
    answerJob.stopped = false;
    answerJob.results = [];
    answerJob.done = 0;
    answerJob.message = '';
    publishAnswer('running');
    try {
      const result = await dispatch({
        isStopped: () => answerJob.stopped,
        report: (patch) => {
          Object.assign(answerJob, patch);
          publishAnswer('running');
        },
        log: (message, level) => answerLog(message, level)
      });
      if (result && Array.isArray(result.results)) {
        answerJob.results = result.results;
        // 兜底：即便外壳没逐条上报 done，也按结果条数对齐进度。
        answerJob.done = Math.max(answerJob.done, result.results.length);
      }
      if (result && Number.isFinite(result.total)) answerJob.total = result.total;
      publishAnswer('done');
    } catch (error) {
      answerLog(`AI 作答失败：${error.message}`, 'error');
      answerJob.results.push({ experiment: answerJob.experiment || '-', ok: false, error: error.message });
    } finally {
      answerJob.running = false;
      answerJob.experiment = '';
      publishAnswer('done');
    }
  }

  let listeningPort = 0;
  let heartbeat = null;
  let closePromise = null;

  // ---------- 校验 ----------

  function isOriginAllowed(req) {
    const origin = req.headers.origin;
    if (!origin) return true; // Origin 缺失才放行（同源 GET / 非浏览器客户端）
    if (typeof origin !== 'string') return false;
    return allowedOrigins.has(origin.replace(/\/+$/, ''));
  }

  function pickToken(req, requestUrl, payload) {
    const headerToken = req.headers['x-ui-token'];
    if (typeof headerToken === 'string' && headerToken) return headerToken;
    const authorization = req.headers.authorization;
    if (typeof authorization === 'string' && /^Bearer\s+/i.test(authorization)) {
      return authorization.replace(/^Bearer\s+/i, '').trim();
    }
    const queryToken = requestUrl.searchParams.get('token');
    if (queryToken) return queryToken;
    if (payload && typeof payload === 'object' && typeof payload.token === 'string') return payload.token;
    return '';
  }

  function tokenMatches(provided) {
    if (typeof provided !== 'string' || provided.length === 0) return false;
    const a = Buffer.from(provided, 'utf8');
    const b = Buffer.from(token, 'utf8');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  function isAuthorized(req, requestUrl, payload) {
    return isOriginAllowed(req) && tokenMatches(pickToken(req, requestUrl, payload));
  }

  function deny(res) {
    sendJson(res, 403, { ok: false, error: '未授权：token 或 Origin 校验失败' });
  }

  // ---------- 请求体 ----------

  /**
   * 读请求体；`limit` 是缓存上限（超限返回 `{tooLarge:true}`，之后只 drain）。
   * 默认 64KB；答案回传允许更大，因为一关的代码答案可能很长。
   */
  function readBody(req, limit = MAX_BODY_BYTES) {
    return new Promise((resolve) => {
      const chunks = [];
      let size = 0;
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > limit) {
          chunks.length = 0;
          if (size > HARD_BODY_BYTES) {
            finish({ tooLarge: true, text: '' });
            req.destroy();
          }
          return; // 超限后只 drain，不再缓存
        }
        chunks.push(chunk);
      });
      req.on('end', () =>
        finish({ tooLarge: size > limit, text: Buffer.concat(chunks).toString('utf8') })
      );
      req.on('error', () => finish({ tooLarge: size > limit, text: '' }));
      req.on('aborted', () => finish({ tooLarge: size > limit, text: '' }));
    });
  }

  // ---------- SSE ----------

  function broadcast(evt) {
    if (clients.size === 0) return 0;
    // JSON.stringify 会转义换行，保证一条事件就是一行 data:。
    const line = `data: ${JSON.stringify(evt)}\n\n`;
    let sent = 0;
    for (const client of [...clients]) {
      try {
        client.res.write(line);
        sent += 1;
      } catch {
        clients.delete(client);
      }
    }
    return sent;
  }

  function openSse(req, res) {
    const client = { res };
    clients.add(client); // 先登记再写响应头，避免 emit 抢在订阅之前

    const drop = () => {
      clients.delete(client);
      try {
        if (!res.writableEnded) res.end();
      } catch {
        /* 连接已断开，忽略 */
      }
    };
    req.on('close', drop);
    req.on('error', drop);
    res.on('error', drop);
    res.on('close', drop);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    res.write(': connected\n\n'); // 注释行：立即建立流，同时作为首帧心跳
  }

  // ---------- 动作 ----------

  function resolveSelection(action, args) {
    if (action === 'select-course') {
      const courseId = args.courseId;
      if (courseId === undefined || courseId === null || courseId === '') {
        throw badRequest('缺少 courseId');
      }
      const course = snapshot.courses.find((item) => String(item && item.id) === String(courseId));
      if (!course) throw badRequest(`未找到课程：${courseId}`);
      return { selectedCourse: course };
    }
    if (action === 'select-experiments') {
      if (!Array.isArray(args.indices)) throw badRequest('indices 必须是数组');
      const picked = args.indices.map((raw) => {
        const index = Number(raw);
        const experiment = Number.isInteger(index) ? snapshot.experiments[index] : undefined;
        if (!experiment) throw badRequest(`实验序号越界：${raw}`);
        return experiment;
      });
      return { selectedExperiments: picked };
    }
    if (action === 'select-levels') {
      // 关卡选择支持两种载荷：
      // - 新式 { levels: [{identifier, position, challengeId}] }：关卡列表可能没有 identifier，
      //   只能靠序号/列表 id 表达选择；
      // - 旧式 { identifiers: [...] }：仅当列表带 identifier 时可用。
      const byPosition = (item, want) => {
        const position = Number(want.position != null ? want.position : want.index);
        if (!Number.isFinite(position) || position <= 0) return false;
        return Number(item.position != null ? item.position : item.index) === position;
      };
      let picked = [];
      if (Array.isArray(args.levels)) {
        picked = args.levels.map((want) => {
          const level = snapshot.levels.find((item) => {
            if (!item) return false;
            if (want && typeof want === 'object') {
              if (want.identifier && String(item.identifier) === String(want.identifier)) return true;
              if (want.challengeId && String(item.challengeId) === String(want.challengeId)) return true;
              return byPosition(item, want);
            }
            return String(item.identifier) === String(want);
          });
          if (!level) throw badRequest(`未找到关卡：${JSON.stringify(want)}`);
          return level;
        });
      } else if (Array.isArray(args.identifiers)) {
        picked = args.identifiers.map((identifier) => {
          const level = snapshot.levels.find(
            (item) => item && String(item.identifier) === String(identifier)
          );
          if (!level) throw badRequest(`未找到关卡：${identifier}`);
          return level;
        });
      } else {
        throw badRequest('levels 或 identifiers 必须是数组');
      }
      return { selectedLevels: picked };
    }
    return null; // start / stop 不改变选择
  }

  async function runAction(payload, res) {
    const action = typeof payload.action === 'string' ? payload.action.trim() : '';
    if (!ACTIONS.has(action)) {
      return sendJson(res, 400, { ok: false, error: `未知动作：${action || '(空)'}` });
    }
    if (typeof onControl !== 'function') {
      return sendJson(res, 500, { ok: false, error: 'onControl 未配置，无法处理动作' });
    }

    const args = { ...payload };
    delete args.action;
    delete args.token;

    let selection = null;
    let result = null;
    try {
      selection = resolveSelection(action, args);
      result = await onControl(action, args); // 动作真正生效后才更新快照
    } catch (error) {
      const status = errorStatus(error);
      const message = (error && error.message) || String(error);
      appendLog(snapshot, status >= 500 ? 'error' : 'warn', `动作 ${action} 失败：${message}`);
      return sendJson(res, status, { ok: false, error: message });
    }

    if (selection) Object.assign(snapshot, selection);
    if (action === 'start') {
      snapshot.phase = 'starting';
      snapshot.message = '正在启动引擎…';
    }
    if (action === 'stop') {
      snapshot.phase = 'stopping';
      snapshot.message = '正在停止…';
    }
    // 外壳返回的附加数据要一并回传（例如 diagnose 的结论行），否则前端拿不到诊断结果。
    const extra = result && typeof result === 'object' && !Array.isArray(result) ? result : {};
    return sendJson(res, 200, { ok: true, ...extra });
  }

  // ---------- 静态页 ----------

  async function serveIndex(req, res) {
    try {
      const html = await fs.readFile(INDEX_FILE);
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': html.length,
        'Cache-Control': 'no-store'
      });
      res.end(req.method === 'HEAD' ? undefined : html);
    } catch {
      const text = '控制台页面尚未生成：extractor/ui/public/index.html 缺失。\n';
      res.writeHead(404, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Length': Buffer.byteLength(text),
        'Cache-Control': 'no-store'
      });
      res.end(text);
    }
  }

  // ---------- 路由 ----------

  async function handleRequest(req, res) {
    let requestUrl;
    try {
      requestUrl = new URL(req.url, `http://127.0.0.1:${listeningPort}`);
    } catch {
      return sendJson(res, 400, { ok: false, error: '非法请求路径' });
    }
    const pathname = requestUrl.pathname;
    const method = req.method || 'GET';

    if (pathname === '/' || pathname === '/index.html') {
      if (method !== 'GET' && method !== 'HEAD') {
        return sendJson(res, 405, { ok: false, error: '方法不允许' });
      }
      return serveIndex(req, res);
    }
    if (pathname === '/favicon.ico') {
      res.writeHead(204);
      return res.end();
    }
    if (!pathname.startsWith('/api/')) {
      return sendJson(res, 404, { ok: false, error: 'Not found' });
    }

    if (pathname === '/api/state') {
      if (method !== 'GET') return sendJson(res, 405, { ok: false, error: '方法不允许' });
      if (!isAuthorized(req, requestUrl, null)) return deny(res);
      return sendJson(res, 200, cloneSnapshot(snapshot));
    }

    if (pathname === '/api/events') {
      if (method !== 'GET') return sendJson(res, 405, { ok: false, error: '方法不允许' });
      if (!isAuthorized(req, requestUrl, null)) return deny(res);
      return openSse(req, res);
    }

    if (pathname === '/api/answer/targets') {
      if (method !== 'GET') return sendJson(res, 405, { ok: false, error: '方法不允许' });
      if (!isAuthorized(req, requestUrl, null)) return deny(res);
      const courses = await require('../lib/answerer').listTargets(exportRootDir());
      return sendJson(res, 200, { ok: true, courses });
    }

    if (pathname === '/api/answer/run') {
      if (method !== 'POST') return sendJson(res, 405, { ok: false, error: '方法不允许' });
      if (!isOriginAllowed(req)) return deny(res);
      const body = await readBody(req);
      if (body.tooLarge) return sendJson(res, 413, { ok: false, error: '请求体超过 64KB 上限' });
      let payload = null;
      try {
        payload = JSON.parse(body.text || '{}');
      } catch {
        payload = null;
      }
      if (!tokenMatches(pickToken(req, requestUrl, payload))) return deny(res);
      if (!payload || typeof payload !== 'object') return sendJson(res, 400, { ok: false, error: '请求体必须是 JSON 对象' });
      if (answerJob.running) return sendJson(res, 409, { ok: false, error: '已有作答任务在跑，等它结束或先停止' });
      if (typeof onAnswerRun !== 'function') {
        return sendJson(res, 500, { ok: false, error: '未配置作答处理器（onAnswerRun）' });
      }
      const course = String(payload.course || '');
      const experiments = Array.isArray(payload.experiments) ? payload.experiments.map(String).filter(Boolean) : [];
      const levels = Array.isArray(payload.levels) ? payload.levels.map(String).filter(Boolean) : null;
      if (!course || !experiments.length) return sendJson(res, 400, { ok: false, error: '请指定课程与至少一个实验' });
      if (!payload.apiKey) return sendJson(res, 400, { ok: false, error: '缺少 API Key（在「AI 作答」面板里填一次即可）' });
      runAnswerJob(() =>
        onAnswerRun({
          course,
          experiments,
          levels,
          apiKey: payload.apiKey,
          baseUrl: payload.baseUrl,
          model: payload.model
        })
      ).catch(() => {});
      return sendJson(res, 200, { ok: true, started: true, course, experiments });
    }

    if (pathname === '/api/answer/stop') {
      if (method !== 'POST') return sendJson(res, 405, { ok: false, error: '方法不允许' });
      if (!isOriginAllowed(req)) return deny(res);
      const body = await readBody(req);
      let payload = null;
      try {
        payload = JSON.parse(body.text || '{}');
      } catch {
        payload = null;
      }
      if (!tokenMatches(pickToken(req, requestUrl, payload))) return deny(res);
      answerJob.stopped = true;
      if (typeof onAnswerStop === 'function') await onAnswerStop().catch(() => {});
      return sendJson(res, 200, { ok: true, stopping: true });
    }

    if (pathname === '/api/answers') {
      if (method !== 'GET') return sendJson(res, 405, { ok: false, error: '方法不允许' });
      // 这几个端点是给篡改猴（浏览器扩展）用的，扩展从 educoder.net 页面发起请求，
      // Origin 不是本机地址，用不了下面的同源白名单。因此这里**显式地只校验 token**，
      // 而不是依赖「GM 请求恰好不带 Origin 才放行」这种巧合（原来就是这样，很脆）。
      // 安全性依据：token 由 `npm run ui` 随机生成、只出现在用户自己的终端与本机 URL 里；
      // 且这些端点只读答案、只往 exports/ 下写蓝图或写缺答案清单，不碰引擎也不碰系统。
      res.setHeader('Access-Control-Allow-Origin', '*');
      if (!tokenMatches(pickToken(req, requestUrl, null))) return deny(res);
      const answers = await collectAnswers();
      return sendJson(res, 200, { ok: true, ...answers });
    }

    if (pathname === '/api/blueprint') {
      if (method !== 'POST') return sendJson(res, 405, { ok: false, error: '方法不允许' });
      // 与 /api/answers 同样的鉴权口径：只校验 token（理由见上）。
      res.setHeader('Access-Control-Allow-Origin', '*');
      if (!tokenMatches(pickToken(req, requestUrl, null))) return deny(res);
      const raw = await readBody(req);
      if (raw.tooLarge) {
        return sendJson(res, 413, { ok: false, error: '请求体超过 64KB 上限' });
      }
      let recorded = null;
      try {
        recorded = JSON.parse(raw.text || '{}');
      } catch {
        recorded = null;
      }
      if (!recorded || typeof recorded !== 'object') {
        return sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' });
      }
      const saved = await saveBlueprint(recorded);
      return sendJson(res, saved.ok ? 200 : 400, saved);
    }

    if (pathname === '/api/missing') {
      // 与 /api/answers、/api/answer/save 同样的鉴权口径：只校验 token（调用方是篡改猴扩展）。
      res.setHeader('Access-Control-Allow-Origin', '*');
      if (!tokenMatches(pickToken(req, requestUrl, null))) return deny(res);
      const root = exportRootDir();
      if (method === 'GET') {
        const document = await readMissingDocument(root);
        return sendJson(res, 200, { ok: true, items: document.items, updated_at: document.updated_at });
      }
      if (method !== 'POST') return sendJson(res, 405, { ok: false, error: '方法不允许' });
      const raw = await readBody(req);
      if (raw.tooLarge) return sendJson(res, 413, { ok: false, error: '请求体超过 64KB 上限' });
      let payload = null;
      try {
        payload = JSON.parse(raw.text || '{}');
      } catch {
        payload = null;
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return sendJson(res, 400, { ok: false, error: '请求体必须是 JSON 对象' });
      }
      if (payload.action === 'add') {
        // 只拦「字段压根没给」的调用方 bug（缺 items 不该被当成「加了 0 条」的成功）；
        // 单条对象 / 单条 id 由 missing-store 有意容忍，这里不拦。
        if (payload.items === undefined || payload.items === null) {
          return sendJson(res, 400, { ok: false, error: 'items 不能为空' });
        }
        const result = await addMissing(root, payload.items);
        return sendJson(res, 200, { ok: true, added: result.added, skipped: result.skipped, items: result.items });
      }
      if (payload.action === 'remove') {
        // 同上：缺 ids 不该被当成「删了 0 条」的成功。
        if (payload.ids === undefined || payload.ids === null) {
          return sendJson(res, 400, { ok: false, error: 'ids 不能为空' });
        }
        const result = await removeMissing(root, payload.ids);
        return sendJson(res, 200, { ok: true, removed: result.removed, items: result.items });
      }
      if (payload.action === 'clear') {
        const result = await clearMissing(root);
        return sendJson(res, 200, { ok: true, cleared: result.cleared, items: [] });
      }
      return sendJson(res, 400, { ok: false, error: `未知 action：${String(payload.action)}` });
    }

    if (pathname === '/api/answer/save') {
      if (method !== 'POST') return sendJson(res, 405, { ok: false, error: '方法不允许' });
      // 与 /api/answers、/api/blueprint 同样的鉴权口径：只校验 token（理由见上）。
      res.setHeader('Access-Control-Allow-Origin', '*');
      if (!tokenMatches(pickToken(req, requestUrl, null))) return deny(res);
      // 代码答案可能很长（AI 生成的整份源码），这里给到 256KB。
      const raw = await readBody(req, 256 * 1024);
      if (raw.tooLarge) {
        return sendJson(res, 413, { ok: false, error: '请求体超过 256KB 上限' });
      }
      let recorded = null;
      try {
        recorded = JSON.parse(raw.text || '{}');
      } catch {
        recorded = null;
      }
      if (!recorded || typeof recorded !== 'object') {
        return sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' });
      }
      const saved = await saveAnswer(recorded);
      return sendJson(res, saved.ok ? 200 : 400, saved);
    }

    if (pathname === '/api/log') {
      if (method !== 'POST') return sendJson(res, 405, { ok: false, error: '方法不允许' });
      // 与 /api/answers、/api/answer/save 同样的鉴权口径：只校验 token。
      res.setHeader('Access-Control-Allow-Origin', '*');
      if (!tokenMatches(pickToken(req, requestUrl, null))) return deny(res);
      // 日志可能很长（面板留 200 条），给到 512KB。
      const raw = await readBody(req, 512 * 1024);
      if (raw.tooLarge) {
        return sendJson(res, 413, { ok: false, error: '请求体超过 512KB 上限' });
      }
      let recorded = null;
      try {
        recorded = JSON.parse(raw.text || '{}');
      } catch {
        recorded = null;
      }
      if (!recorded || typeof recorded !== 'object') {
        return sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' });
      }
      const saved = await saveLog(recorded);
      return sendJson(res, saved.ok ? 200 : 400, saved);
    }

    if (pathname === '/api/action') {
      if (method !== 'POST') return sendJson(res, 405, { ok: false, error: '方法不允许' });
      if (!isOriginAllowed(req)) return deny(res);

      const body = await readBody(req);
      if (body.tooLarge) {
        return sendJson(res, 413, { ok: false, error: '请求体超过 64KB 上限' });
      }
      let payload = null;
      try {
        payload = JSON.parse(body.text || '{}');
      } catch {
        payload = null;
      }
      // token 可来自 query / 请求头 / 请求体（契约里 POST 体带 token）。
      if (!tokenMatches(pickToken(req, requestUrl, payload))) return deny(res);
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return sendJson(res, 400, { ok: false, error: '请求体必须是 JSON 对象' });
      }
      return runAction(payload, res);
    }

    return sendJson(res, 404, { ok: false, error: 'Not found' });
  }

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((error) => {
      const message = (error && error.message) || '内部错误';
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: message });
      else {
        try {
          res.end();
        } catch {
          /* 连接已断开，忽略 */
        }
      }
    });
  });

  server.on('clientError', (error, socket) => {
    if (socket.writable && !socket.destroyed) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    } else {
      socket.destroy();
    }
  });

  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once('error', onError);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', onError);
      resolve();
    });
  });

  listeningPort = server.address().port;
  allowedOrigins.add(`http://127.0.0.1:${listeningPort}`);
  allowedOrigins.add(`http://localhost:${listeningPort}`);
  // 监听之后的偶发错误（如 EMFILE）不应让进程崩溃。
  server.on('error', () => {});

  heartbeat = setInterval(() => {
    for (const client of [...clients]) {
      try {
        client.res.write(': ping\n\n');
      } catch {
        clients.delete(client);
      }
    }
  }, HEARTBEAT_MS);
  if (typeof heartbeat.unref === 'function') heartbeat.unref();

  const url = `http://127.0.0.1:${listeningPort}/?token=${token}`;

  // ---------- 对外 API ----------

  function emit(evt) {
    const event = evt && typeof evt === 'object' ? evt : { type: 'log', level: 'warn', message: String(evt) };
    applyEvent(snapshot, event);
    // 事件里若没带 status，用快照里最新一条补齐：前端据此区分「新保存」与「复用」。
    if ((event.status == null || event.status === '') && Array.isArray(snapshot.extracted) && snapshot.extracted.length) {
      const last = snapshot.extracted[snapshot.extracted.length - 1];
      if (last && (last.status === 'reused' || last.status === 'saved')) event.status = last.status;
    }
    // 同理补上课程/实验名：SSE 事件本身不带这些上下文，前端需要用来归组。
    if (event.type === 'saved' || event.type === 'reused') {
      if (event.course == null && snapshot.progress.courseName) event.course = snapshot.progress.courseName;
      if (event.experiment == null && snapshot.progress.experimentName) event.experiment = snapshot.progress.experimentName;
    }
    return broadcast(event);
  }

  function getSnapshot() {
    return cloneSnapshot(snapshot);
  }

  function setSnapshot(patch) {
    if (patch && typeof patch === 'object') {
      for (const [key, value] of Object.entries(patch)) {
        if (key === 'progress') {
          // progress 只做字段合并，永远保持对象形态，避免脏值让后续事件处理抛错。
          if (value && typeof value === 'object' && !Array.isArray(value)) {
            Object.assign(snapshot.progress, value);
          }
        } else if (key === 'logs') {
          if (Array.isArray(value)) snapshot.logs = value.map((entry) => ({ ...entry }));
        } else if (ARRAY_KEYS.has(key)) {
          if (Array.isArray(value)) snapshot[key] = value;
          else if (value === undefined || value === null) snapshot[key] = [];
        } else {
          snapshot[key] = value;
        }
      }
      if (snapshot.logs.length > MAX_LOGS) {
        snapshot.logs.splice(0, snapshot.logs.length - MAX_LOGS);
      }
    }
    return getSnapshot();
  }

  function close() {
    if (closePromise) return closePromise;
    closePromise = new Promise((resolve) => {
      if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat = null;
      }
      for (const client of [...clients]) {
        try {
          client.res.end();
        } catch {
          /* 连接已断开，忽略 */
        }
      }
      clients.clear();
      server.close(() => resolve());
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    }).then(() => undefined);
    return closePromise;
  }

  if (open) openInBrowser(url);

  return { url, port: listeningPort, close, emit, getSnapshot, setSnapshot };
}

function openInBrowser(url) {
  try {
    const [command, args] =
      process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : process.platform === 'darwin'
          ? ['open', [url]]
          : ['xdg-open', [url]];
    const child = spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true });
    child.on('error', () => {}); // 打不开浏览器不影响服务
    child.unref();
  } catch {
    /* 忽略：打开浏览器失败不是致命错误 */
  }
}

/**
 * 汇总 AI 答案与提交蓝图，供篡改猴一次性拉取。
 *
 * 答案的规范位置是**一个文件夹**：`exports/answers/{课程}__{实验}.answers.json`
 * （文件名标清课程与实验，见 docs/AI-ANSWER-FORMAT.md）。
 * 为兼容早期产物，仍然递归匹配 `exports/` 下所有 `*.answers.json`。
 *
 * 只读：不写任何文件；文件缺失就是空对象，不算错误。
 */
async function collectAnswers() {
  const root = process.env.EDUCODER_EXPORT_ROOT || path.join(__dirname, '..', '..', 'exports');
  const answers = {};
  const experiments = [];
  const blueprints = [];
  const files = [];

  const readAnswerFile = async (full) => {
    const parsed = JSON.parse(await fs.readFile(full, 'utf8'));
    // course/experiment 优先从**文件路径**推导（`exports/{课程}/{实验}/...` 下的答案文件，
    // 路径本身就有课程/实验，文件里可能没写这两个字段）；集中目录 `exports/answers/`
    // 下的文件没有路径信息，才退回文件自带字段。
    const rel = path.relative(root, full).split(path.sep);
    const fromPath = rel.length >= 3 && rel[0] !== 'answers';
    const course = fromPath ? rel[0] : String(parsed.course || '');
    const experiment = fromPath ? rel[1] : String(parsed.experiment || '');
    // `answers` 既可能是数组（[{level_id, kind, answer}]），也可能是以关卡 id 为键的对象。
    const raw = Array.isArray(parsed.answers)
      ? parsed.answers
      : parsed.answers && typeof parsed.answers === 'object'
        ? parsed.answers
        : parsed;
    const entries = Array.isArray(raw)
      ? raw.filter((item) => item && item.level_id).map((item) => [String(item.level_id), item])
      : Object.entries(raw || {}).filter(([key]) => /^L/.test(key));
    let count = 0;
    for (const [key, value] of entries) {
      // 用「课程__实验__level_id」做键：level_id（L001）只在单个实验内唯一，
      // 多个实验聚合到同一个 answers 对象时会互相覆盖（实测两个实验的 L001 打架，
      // 后遍历的答案把先遍历的盖掉，用户在关卡页上会拿到别实验的答案）。
      answers[compositeKey(course, experiment, key)] = { ...normalizeAnswer(key, value), course, experiment };
      count += 1;
    }
    return { course, experiment, count };
  };

  // ① 规范位置：exports/answers/
  const answerDir = path.join(root, 'answers');
  let entries = [];
  try {
    entries = await fs.readdir(answerDir, { withFileTypes: true });
  } catch {
    entries = [];
  }
  const seen = new Set();
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const full = path.join(answerDir, entry.name);
    seen.add(full);
    files.push(path.relative(root, full));
    try {
      if (entry.name === 'submit.blueprint.json') {
        blueprints.push({ path: path.relative(root, full), ...JSON.parse(await fs.readFile(full, 'utf8')) });
      } else if (/\.answers\.json$/.test(entry.name)) {
        // 兼容：answers/ 下若直接摆了答案文件（含 index.json 之类），course/experiment 可能为空。
        experiments.push(await readAnswerFile(full));
      }
    } catch {
      /* 单个文件坏了不影响其它文件 */
    }
  }

  // ③ 关卡标识映射：篡改猴在关卡页上只能拿到 URL 里的**平台关卡标识**（如 `zq3cef619ac5`），
  //    而答案是按 `L001` 这类 level_id 汇总的。没有这张映射表，两边永远对不上
  //    ——曾出现「答案拉到了，但一关都用不上」：脚本按平台标识查、答案按 L 编号存。
  //    映射来自关卡存档的 `source` 字段（形如 https://www.educoder.net/tasks/{标识}?…）。
  const levelIds = {};
  const levelDirs = {};
  /** 复合键（课程__实验__L001）→ 实验目录。按内容兜底回传答案时要用。 */
  const levelDirsByKey = {};
  /** level_id → 每道题的选项个数（选择题）。脚本靠它把页面上的选项按题切分。 */
  const optionCounts = {};
  /**
   * 「实验名__关卡名」→ 复合键。
   *
   * 为什么需要：平台会重新发布实验 / 同一份实验存在课堂与教学课程两个副本，
   * 平台会给**完全不同的一组关卡标识**（实测本地是 `kbfiscelzp9a`，页面上是
   * `v4nyrg6lex7q`，标题却都是 stride）。此时按标识映射必然落空，
   * 只能退回「按内容（实验名+关卡名）匹配」。同名冲突的条目直接丢弃，宁可不匹配也不串。
   */
  const titleIds = {};
  const titleDupes = new Set();
  /**
   * 「关卡名」→ 复合键，**仅当该关卡名在所有实验里全局唯一时**才收。
   *
   * 课堂流程里脚本拿不到实验名（只有教学课程队列会带上），所以还需要这张只按
   * 关卡名查的表。重名的一律丢弃——宁可匹配不上报错，也不能把答案写到别的关卡。
   */
  const titleOnlyIds = {};
  const titleOnlyDupes = new Set();
  const readLevelIds = async (archivePath) => {
    let text = '';
    try {
      text = await fs.readFile(archivePath, 'utf8');
    } catch {
      return;
    }
    const experimentDir = path.dirname(archivePath);
    const course = path.basename(path.dirname(experimentDir));
    const experiment = path.basename(experimentDir);
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let record = null;
      try {
        record = JSON.parse(trimmed);
      } catch {
        continue; // 半截行（写入被中断）跳过，不影响其它关卡
      }
      const identifier = taskIdentifierFromSource(record && record.source);
      if (!identifier) continue;
      const levelId = levelIdOf(record.taskIndex);
      // 与 readAnswerFile 一致的复合键，避免多个实验的 L001 互相覆盖
      const key = compositeKey(course, experiment, levelId);
      levelIds[identifier] = key;
      levelDirs[identifier] = experimentDir;
      levelDirsByKey[key] = experimentDir;
      // 按「实验名__关卡名」建一张兜底表：平台换标识时靠它匹配
      const title = String(record.title || '').trim();
      if (title) {
        // 两个键：完整实验目录名，以及**去掉开头 [分类] 前缀**的实验名。
        // 后者是必需的：脚本从教学课程拿到的是平台侧的实验名（「需求分析的基本概念」），
        // 而目录名带分类前缀（「[4、需求分析与结构化分析] 需求分析的基本概念」），
        // 只用一个键两边永远对不上。
        const shortExperiment = experiment.replace(/^\[[^\]]*\]\s*/, '');
        const pairKeys = [`${experiment}__${title}`];
        if (shortExperiment && shortExperiment !== experiment) pairKeys.push(`${shortExperiment}__${title}`);
        for (const titleKey of pairKeys) {
          if (titleIds[titleKey] && titleIds[titleKey] !== key) titleDupes.add(titleKey);
          else titleIds[titleKey] = key;
        }
        if (titleOnlyIds[title] && titleOnlyIds[title] !== key) titleOnlyDupes.add(title);
        else titleOnlyIds[title] = key;
      }
      // 选项个数是**确定**的信息，而页面上的题目分组只能靠 DOM 猜。
      // 把它带给脚本，脚本就能拿「总共多少个选项框」去校验/切分，
      // 而不是纯靠 class 名——这是分组数对不上的唯一可靠判据。
      const counts = Array.isArray(record.choiceQuestions)
        ? record.choiceQuestions
          .map((question) => (Array.isArray(question.options) ? question.options.length : 0))
          .filter((size) => size > 0)
        : [];
      if (counts.length) optionCounts[key] = counts;
    }
  };

  // ② 兼容：实验目录下的 answers/*.answers.json、submit.blueprint.json 与 levels.jsonl
  const walk = async (dir, depth = 0) => {
    if (depth > 3) return;
    let children = [];
    try {
      children = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const child of children) {
      const full = path.join(dir, child.name);
      if (child.isDirectory()) {
        if (child.name === 'answers' && dir === answerDir) continue;
        await walk(full, depth + 1);
        continue;
      }
      if (child.name === 'levels.jsonl') {
        await readLevelIds(full);
        continue;
      }
      if (!/\.answers\.json$/.test(child.name) && child.name !== 'submit.blueprint.json') continue;
      if (seen.has(full)) continue;
      seen.add(full);
      files.push(path.relative(root, full));
      try {
        if (child.name === 'submit.blueprint.json') {
          blueprints.push({ path: path.relative(root, full), ...JSON.parse(await fs.readFile(full, 'utf8')) });
        } else {
          experiments.push(await readAnswerFile(full));
        }
      } catch {
        /* 忽略坏文件 */
      }
    }
  };
  await walk(root);

  // 同名冲突（同一「实验名__关卡名」指向多个关卡）的条目一律丢弃：
  // 宁可匹配不上让人看到提示，也不能把答案串到别的关卡上。
  for (const dupe of titleDupes) delete titleIds[dupe];
  for (const dupe of titleOnlyDupes) delete titleOnlyIds[dupe];

  return {
    answers,
    experiments,
    blueprints,
    files,
    levelIds,
    titleIds,
    titleOnlyIds,
    levelDirs,
    levelDirsByKey,
    optionCounts,
    answerDir,
    exportRoot: root
  };
}

/**
 * 落盘一份由篡改猴回传的提交蓝图。
 *
 * 为什么需要它：`submit.blueprint.json` 原先**没有任何生成端**——只能靠使用者在
 * 篡改猴里导出录制结果、再手工放到实验目录。「录制一次、永久复用」的免录制链路
 * 因此名存实亡。现在脚本录到写请求就回传到这里，由控制台写进对应实验目录。
 */
async function saveBlueprint(payload) {
  const url = String(payload.url || '').trim();
  if (!url) return { ok: false, error: '缺少 url' };
  const method = String(payload.method || 'POST').trim().toUpperCase();
  const entry = {
    key: `${method} ${url.split('?')[0]}`,
    url,
    method,
    body: typeof payload.body === 'string' ? payload.body : '',
    recordedAt: new Date().toISOString()
  };

  const maps = await collectAnswers();
  const levelId = String(payload.levelId || '');
  const targetDir = maps.levelDirs[levelId] || path.join(maps.exportRoot, 'answers');
  const target = path.join(targetDir, 'submit.blueprint.json');

  // 同一 key 覆盖，其余保留；蓝图是数组，与脚本里 state.templates 的结构一致。
  let existing = [];
  try {
    const parsed = JSON.parse(await fs.readFile(target, 'utf8'));
    existing = Array.isArray(parsed) ? parsed : Array.isArray(parsed.blueprints) ? parsed.blueprints : [parsed];
  } catch {
    existing = [];
  }
  const merged = [entry, ...existing.filter((item) => item && item.key !== entry.key)].slice(0, 30);

  await fs.mkdir(targetDir, { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  return { ok: true, path: path.relative(maps.exportRoot, target), count: merged.length, matchedLevel: Boolean(maps.levelDirs[levelId]) };
}

/**
 * 落盘一条由篡改猴回传的答案（关卡提交通过后自动回传，或手动导出后回传）。
 *
 * 关卡标识 → 课程/实验的映射来自关卡存档（collectAnswers 的 levelIds/levelDirs），
 * 因此**实验必须先被抓取过**，否则控制台不知道该把答案写进哪个课程/实验的文件；
 * 这种情况必须明确报错，而不是猜一个目录写进去。
 *
 * 答案文件的落盘/合并交给 lib/answer-store.js（与抓取端共用同一套规则）：
 * 同一 level_id 覆盖，其它关卡的答案原样保留。
 */
async function saveAnswer(payload) {
  const identifier = String(payload.identifier || '').trim();
  if (!identifier) return { ok: false, error: '缺少 identifier（关卡页 URL 最后一段）' };
  const maps = await collectAnswers();
  let key = maps.levelIds[identifier] || '';
  let targetDir = maps.levelDirs[identifier];

  // 标识对不上时的兜底：平台**重新发布实验**会换掉一整组关卡标识（实测本地存档
  // `kbfiscelzp9a`、页面 `v4nyrg6lex7q`，标题都是 stride），或同一份实验在课堂与教学
  // 课程各有一份副本。按内容匹配：先「实验名__关卡名」（最精确），再「关卡名」
  // （课堂流程拿不到实验名，该表只收全局唯一的关卡名）。名字由脚本在 payload 里带上来。
  if (!targetDir || !key) {
    const experimentName = String(payload.experiment || '').trim();
    const levelName = String(payload.levelName || '').trim();
    const byPair = experimentName && levelName ? maps.titleIds[`${experimentName}__${levelName}`] : '';
    const byTitle = levelName ? maps.titleOnlyIds[levelName] : '';
    const hit = byPair || byTitle;
    if (hit) {
      key = hit;
      targetDir = maps.levelDirsByKey[hit];
    }
  }

  if (!targetDir || !key) {
    return {
      ok: false,
      error: '这个关卡还没有被抓取过，控制台也不知道它属于哪个课程/实验'
        + '（平台重新发布实验会换掉一整组关卡标识）。请先在控制台抓取该实验，再回传答案'
    };
  }

  // 复合键形如 `课程__实验__L001`：关卡号是最后一段（L 编号里没有下划线）。
  const levelId = key.split('__').pop() || String(payload.levelId || '');
  const rel = path.relative(maps.exportRoot, targetDir).split(path.sep);
  const course = rel[0] || '';
  const experiment = rel[1] || '';
  const saved = await mergeAnswer({
    exportRoot: maps.exportRoot,
    course,
    experiment,
    levelId,
    kind: payload.kind,
    language: payload.language,
    answer: payload.answer
  });
  if (!saved.ok) return saved;
  return {
    ok: true,
    path: path.relative(maps.exportRoot, saved.answerPath),
    levelId,
    course,
    experiment,
    replaced: saved.replaced,
    count: saved.count
  };
}

/**
 * 落盘一份来自篡改猴的日志。
 *
 * **追加**写，每段带「第 N 次写入」的标题，方便在文件里定位每次导出：
 * 脚本只发「上次导出之后的新行」，所以这里每次追加一段，文件跨多次运行累积成
 * 一份完整历史。N 是数文件里已有的标题数得来（不额外维护状态文件）。
 * 文件名做净化（去掉路径分隔符等），避免路径穿越。
 */
async function saveLog(payload) {
  const lines = Array.isArray(payload.lines) ? payload.lines.map((line) => String(line)) : [];
  if (!lines.length) return { ok: false, error: '没有新日志内容' };
  const rawName = String(payload.name || '篡改猴日志').trim() || '篡改猴日志';
  const name = rawName.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60);
  // 注意：exportRootDir 是 server 工厂里的闭包，模块级函数取不到，这里自己算一次
  // （与 collectAnswers 用的是同一个口径）。
  const root = process.env.EDUCODER_EXPORT_ROOT || path.join(__dirname, '..', '..', 'exports');
  const dir = path.join(root, 'logs');
  const file = path.join(dir, `${name}.log`);
  await fs.mkdir(dir, { recursive: true });

  // 数一下已有几段，本次就是第 N+1 次写入
  let seq = 1;
  try {
    const existing = await fs.readFile(file, 'utf8');
    seq = (existing.match(/^===== 第 \d+ 次写入/gm) || []).length + 1;
  } catch {
    seq = 1; // 文件还不存在
  }

  const stamp = new Date().toLocaleString();
  const header = `\n===== 第 ${seq} 次写入 · ${stamp}（${lines.length} 行）=====\n`;
  await fs.appendFile(file, `${header}${lines.join('\n')}\n`, 'utf8');
  return { ok: true, path: path.relative(root, file), lines: lines.length, seq, appended: true };
}

/** 关卡存档的 `source`（任务页 URL）→ 平台关卡标识；三段式 URL 取最后一段。 */
function taskIdentifierFromSource(source) {
  const match = /\/tasks\/([^/?#]+(?:\/[^/?#]+)*)/.exec(String(source || ''));
  if (!match) return '';
  const segments = match[1].split('/').filter(Boolean);
  return segments.length ? segments[segments.length - 1] : '';
}

/** 与 answerer 一致的 level_id 编号规则（taskIndex → L001）。 */
function levelIdOf(taskIndex) {
  return `L${String(Number(taskIndex) || 0).padStart(3, '0')}`;
}

/**
 * 全局唯一的关卡键：`课程__实验__level_id`。
 *
 * level_id 只在单个实验内唯一，`/api/answers` 把多个实验的答案聚合进同一个对象时，
 * 若直接拿 level_id 当键，不同实验的同名关卡会互相覆盖。
 */
function compositeKey(course, experiment, levelId) {
  return `${String(course || '')}__${String(experiment || '')}__${levelId}`;
}

module.exports = { startUiServer };