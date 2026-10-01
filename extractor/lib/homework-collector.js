'use strict';

/**
 * 课堂作业采集（移植自参考实现 educoder-reminder 的采集语义，Node 侧重写）。
 *
 * 数据流：
 *
 *     /api/users/{account}/courses.json            → 本人进行中课堂（=班级）
 *     /api/courses/{classroomCode}/homework_commons.json
 *         ?type=4 （课堂实验） / type=1 （图文作业） → 作业列表
 *
 * ## 为什么传输层是注入的
 *
 * `get(path, params)` 由调用方传入：线上实现走带签名头的 Educoder 请求，
 * 离线测试直接塞一个返回固定分页的假实现。这样**分页完整性、状态判定、
 * 归档过滤这些最容易出错的逻辑全部可离线回归**，不需要账号、不联网。
 *
 * ## 分页完整性（宁可整批失败，不要静默存半份）
 *
 * 三道闸 + 重复检测，任一命中即抛 `HomeworkError`：
 *   1. `query_total_count` 必须是 ≥ 0 的整数，`homeworks` 必须是数组；
 *   2. 分页期间 `count` 变化 → 数据在动，本次结果不可信；
 *   3. 跨页出现重复 `homework_id` → 分页错乱；
 *   4. 累计数超过 `count` → 服务端给了预期之外的东西；
 *   5. 提前遇到空页但累计数不足 `count` → 分页被截断；
 *   6. 超出安全页数上限 → 接口可能忽略了 page 参数。
 *
 * ## 与参考实现的差异（有意为之）
 *
 * - `cutoffDays` 默认 5，只作为**提醒视图**的过滤（逾期超过 5 天的作业不再提醒）。
 *   它是可配置的，设为 0 即关闭——题目存档不受它影响。
 * - 不写 SQLite：本模块只负责「取回来」，落盘由 reminder-store.js 负责。
 */

const {
  KINDS,
  KIND_ORDER,
  HomeworkError,
  parseClassroom,
  parseHomework,
  readDeadline
} = require('./homework-model');

const DATA_ORIGIN = 'https://data.educoder.net';

/** 分页安全上限，防止接口忽略 page 参数时死循环。 */
const PAGE_LIMIT = 1000;
const CLASSROOM_PER_PAGE = 15;
const HOMEWORK_PER_PAGE = 20;

/** 默认「逾期超过多少天就不再提醒」。 */
const DEFAULT_CUTOFF_DAYS = 5;

const DAY_MS = 24 * 60 * 60 * 1000;

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : fallback;
}

/**
 * 采集本人进行中的课堂（= 班级）。
 *
 * 只看 `status=processing` 的进行中课堂；`is_end=true` 的课堂跳过。
 * 分页同样带完整性校验：count 变化 / 重复 id / 提前结束都判失败。
 *
 * @param {(path: string, params: object) => Promise<object>} get
 * @param {string} accountId 登录账号标识（`get_user_info.json` 的 `login`）
 * @param {{perPage?: number, sleep?: Function}} [options]
 * @returns {Promise<Array<{id:number,name:string,code:string,url:string,canVisit:boolean}>>}
 */
async function discoverClassrooms(get, accountId, options = {}) {
  const account = String(accountId || '').trim();
  if (!account) throw new HomeworkError('缺少账号标识，无法读取课堂列表。');
  const perPage = toInt(options.perPage, CLASSROOM_PER_PAGE) || CLASSROOM_PER_PAGE;
  const sleep = options.sleep || defaultSleep;

  const seen = new Set();
  const classrooms = [];
  let expected = null;

  for (let page = 1; page <= PAGE_LIMIT; page += 1) {
    const data = await get(`/api/users/${encodeURIComponent(account)}/courses.json`, {
      category: '',
      status: 'processing',
      page,
      per_page: perPage,
      sort_by: 'updated_at',
      sort_direction: 'desc',
      username: account
    });
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new HomeworkError('课堂接口返回结构异常。');
    }
    const count = data.count;
    const rows = data.courses;
    if (!Number.isInteger(count) || count < 0 || !Array.isArray(rows)) {
      throw new HomeworkError('课堂接口缺少有效的 count 或 courses，拒绝视为空课堂。');
    }
    if (expected !== null && expected !== count) {
      throw new HomeworkError(`采集期间课堂数量发生变化（${expected} → ${count}），本次结果不可信，请重试。`);
    }
    expected = count;

    const ids = [];
    const parsed = [];
    for (const row of rows) {
      if (!row || typeof row !== 'object' || !Number.isInteger(row.id)) {
        throw new HomeworkError('课堂 ID 格式异常。');
      }
      ids.push(row.id);
      if (row.is_end === true) continue;
      const classroom = parseClassroom(row);
      parsed.push(classroom);
    }
    if (ids.length !== new Set(ids).size || ids.some((id) => seen.has(id))) {
      throw new HomeworkError('课堂分页出现重复，拒绝保存不完整结果。');
    }
    for (const id of ids) seen.add(id);
    classrooms.push(...parsed);

    if (seen.size === count) return classrooms;
    if (!rows.length) throw new HomeworkError('课堂分页提前结束，未保存不完整结果。');
    if (seen.size > count) throw new HomeworkError('返回课堂数超过 count。');
    await sleep(200);
  }
  throw new HomeworkError('课堂分页超出安全上限。');
}

/**
 * 采集一个课堂下某一类作业。
 *
 * @param {(path: string, params: object) => Promise<object>} get
 * @param {{id:number,name:string,code:string,canVisit?:boolean}} classroom
 * @param {number} kind 4 课堂实验 / 1 图文作业
 * @param {Set<string>|string[]} allowedCodes 本次已确认的课堂清单（白名单，防越权访问）
 * @param {{accountId?: string, nowMs?: number, cutoffDays?: number,
 *          perPage?: number, sleep?: Function}} [options]
 * @returns {Promise<Array<object>>} 解析后的作业数组（不含归档、不含超期）
 */
async function collectHomeworks(get, classroom, kind, allowedCodes, options = {}) {
  const kindInfo = KINDS[Number(kind)];
  if (!kindInfo) throw new HomeworkError('仅支持课堂实验和图文作业。');
  if (!classroom || !classroom.code) throw new HomeworkError('缺少课堂标识。');
  const allowed = allowedCodes instanceof Set ? allowedCodes : new Set(allowedCodes || []);
  if (!allowed.has(classroom.code)) {
    throw new HomeworkError('拒绝访问本次已加入课堂清单以外的课堂。');
  }
  if (classroom.canVisit === false) {
    throw new HomeworkError('课堂当前不可访问，本次同步未保存。');
  }

  const accountId = String(options.accountId || '').trim();
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const cutoffDays = Number.isFinite(options.cutoffDays) ? options.cutoffDays : DEFAULT_CUTOFF_DAYS;
  const cutoffMs = cutoffDays > 0 ? nowMs - cutoffDays * DAY_MS : null;
  const perPage = toInt(options.perPage, HOMEWORK_PER_PAGE) || HOMEWORK_PER_PAGE;
  const sleep = options.sleep || defaultSleep;

  const seen = new Set();
  const result = [];
  let expected = null;

  for (let page = 1; page <= PAGE_LIMIT; page += 1) {
    const data = await get(`/api/courses/${encodeURIComponent(classroom.code)}/homework_commons.json`, {
      limit: perPage,
      page,
      status: 0,
      id: classroom.code,
      type: Number(kind),
      order: 0
    });
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new HomeworkError('作业接口返回结构异常。');
    }
    if (Number(data.homework_type) !== Number(kind) || data.is_end !== false) {
      throw new HomeworkError('课堂状态或作业类型变化，请重新同步。');
    }
    const count = data.query_total_count;
    const rows = data.homeworks;
    if (!Number.isInteger(count) || count < 0 || !Array.isArray(rows)) {
      throw new HomeworkError('作业接口缺少有效分页字段。');
    }
    if (expected !== null && expected !== count) {
      throw new HomeworkError(`分页期间作业数量发生变化（${expected} → ${count}），请重试。`);
    }
    expected = count;

    const ids = [];
    const parsed = [];
    for (const row of rows) {
      if (!row || typeof row !== 'object' || !Number.isInteger(row.homework_id)) {
        throw new HomeworkError('作业 ID 格式异常。');
      }
      if (typeof row.is_archive !== 'boolean') throw new HomeworkError('作业归档状态缺失。');
      ids.push(row.homework_id);
      // 归档项只计入分页数量，**不解析内容、不入库、不提醒**。
      // （实测：列表接口在「已截止」筛选下仍会附带归档记录。）
      if (row.is_archive) continue;
      // 逾期超过 cutoffDays 的作业在读截止时间后就跳过，不再解析其余字段。
      const deadline = readDeadline(row);
      if (cutoffMs !== null && deadline && deadline.ms < cutoffMs) continue;
      parsed.push(parseHomework(row, classroom, kind, accountId));
    }
    if (ids.length !== new Set(ids).size || ids.some((id) => seen.has(id))) {
      throw new HomeworkError('作业分页重复，拒绝保存不完整结果。');
    }
    for (const id of ids) seen.add(id);
    result.push(...parsed);

    if (seen.size === count) return result;
    if (!rows.length || seen.size > count) {
      throw new HomeworkError('作业分页数量不一致，拒绝保存不完整结果。');
    }
    await sleep(200);
  }
  throw new HomeworkError('作业分页超出安全上限。');
}

/**
 * 一次完整同步：先刷新进行中课堂清单，再逐课堂逐类型采集。
 *
 * 任何一步失败都抛错，**由调用方保留上一份成功快照**——不会写出半份结果。
 *
 * @returns {Promise<{accountId: string, classrooms: Array, homeworks: Array}>}
 */
async function crawl(get, accountId, options = {}) {
  const account = String(accountId || '').trim();
  if (!account) throw new HomeworkError('缺少账号标识。');
  const sleep = options.sleep || defaultSleep;

  const classrooms = await discoverClassrooms(get, account, { ...options, sleep });
  const allowed = new Set(classrooms.map((item) => item.code));
  const homeworks = [];
  for (const classroom of classrooms) {
    for (const kind of KIND_ORDER) {
      homeworks.push(
        ...(await collectHomeworks(get, classroom, kind, allowed, { ...options, accountId: account, sleep }))
      );
    }
    await sleep(200);
  }
  return { accountId: account, classrooms, homeworks };
}

module.exports = {
  DATA_ORIGIN,
  PAGE_LIMIT,
  CLASSROOM_PER_PAGE,
  HOMEWORK_PER_PAGE,
  DEFAULT_CUTOFF_DAYS,
  discoverClassrooms,
  collectHomeworks,
  crawl
};
