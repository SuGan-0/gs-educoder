'use strict';

/**
 * Educoder 数据访问层（只读）。
 *
 * 契约见 docs/ARCHITECTURE.md 第 2 节。本文件在 opt/102-signature 分支上做过一次
 * 重要修正，改动理由见 docs/FIX-102-SIGNATURE.md：
 *
 * ## 修正内容：所有请求都带签名头
 *
 * 旧实现认为「本工具直连 data API 会被 -102 拒绝」，于是把请求放进页面里发，
 * 结果仍然被拒（因为页面内 fetch 也不会替我们加签名头）。真正的原因是
 * **请求缺少 Educoder 前端的签名头**，与设备时间无关。
 *
 * 现在每次请求都带上 `X-EDU-Timestamp` / `X-EDU-Signature` / `X-EDU-Type: pc`
 * （见 `./educoder-sign`），接口即可正常返回；不再需要任何响应截获或 DOM 兜底。
 *
 * ## 其余硬约束
 *
 * 1. 只读：本模块只调用 GET 读取接口，不实现任何写操作接口
 *    （version_repository_delete / update_file / session_report 等一律不碰）。
 * 2. 本模块只允许 require **同目录的纯函数模块**（`./educoder-sign`）：
 *    不得引入 Node 侧 HTTP 客户端——请求必须经浏览器上下文发出，
 *    这样会话 cookie 由浏览器维护，登录流程与数据层共用同一份会话。
 */

const { signingHeaders, EDU_TYPE } = require('./educoder-sign');

/**
 * 兜底账号：仅用于「还没拿到身份就构造 URL」的场景（例如离线测试）。
 * 运行时应以 `get_user_info.json` 返回的 `login` 为准，不要依赖这个常量。
 * @deprecated 用 checkLogin() 返回的 user。
 */
const AUTH_USER = 'p8sxailt2';

const DATA_ORIGIN = 'https://data.educoder.net';
const SITE_ORIGIN = 'https://www.educoder.net';
const IDENTITY_PATH = '/api/users/get_user_info.json';

/** 分页安全上限，防止接口忽略 page 参数时死循环。 */
const COURSES_PAGE_LIMIT = 20;
const DEFAULT_PER_PAGE = 100;

/** 被拒业务码。文案是「服务器时间与您的设备时间不匹配」，但真实含义是签名没通过。 */
const BLOCKED_STATUS = -102;

// --------------------------------------------------------------- 错误分层
//
// 分层的意义：**权限/签名失败不得触发重新登录**，否则会白烧登录次数，
// 还会把「算法变了」误报成「你密码过期了」。

/** 本层所有错误的基类。 */
class ApiError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ApiError';
    Object.assign(this, details);
  }
}

/** 会话确实失效（服务端明确 401，或身份接口拿不到 login）。处置：重新登录。 */
class AuthExpiredError extends ApiError {
  constructor(message, details = {}) {
    super(message, details);
    this.name = 'AuthExpiredError';
  }
}

/** 签名被拒（-102）。处置：更新 AK/SK 常量，**不要**重新登录。 */
class SignatureRejectedError extends ApiError {
  constructor(message, details = {}) {
    super(message, details);
    this.name = 'SignatureRejectedError';
  }
}

// ------------------------------------------------------------------ 工具

/** 把任意值归一化成单行文本（连续空白压成单空格 + 首尾去空白）。 */
function normalizeText(value) {
  if (value === undefined || value === null) return '';
  return String(value).replace(/\s+/g, ' ').trim();
}

/** 数字归一化：无法转成有限数字时返回 fallback。 */
function toNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

/**
 * 判定一个响应意味着什么。
 *
 * `kind` 的取值与处置：
 * - `ok`        正常
 * - `auth`      401 / 403 → 会话失效，需要重新登录
 * - `signature` -102     → 签名被拒，需要更新 AK/SK（**不是**重新登录）
 * - `empty`     空响应
 * - `html`      拿到 HTML（多半是登录页）
 * - `api`       其它业务错误码 / HTTP 非 200
 *
 * @returns {{ok: boolean, kind: string, reason: string, status: number|undefined, preview: string}}
 */
function classifyResponse(status, text) {
  const preview = normalizeText(text).slice(0, 200);
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    payload = null;
  }

  if (payload && payload.status === BLOCKED_STATUS) {
    return {
      ok: false,
      kind: 'signature',
      status,
      preview,
      reason: `签名被拒（${BLOCKED_STATUS}）：请求头缺失或签名算法已变更。`
        + '注意这条接口文案写的是「设备时间不匹配」，但它与系统时间无关。'
    };
  }
  if (status === 401 || status === 403) {
    return { ok: false, kind: 'auth', status, preview, reason: '会话已失效（未登录）' };
  }
  if (typeof status === 'number' && (status < 200 || status >= 300)) {
    return { ok: false, kind: 'api', status, preview, reason: `HTTP ${status}` };
  }
  if (!text) {
    return { ok: false, kind: 'empty', status, preview: '', reason: '接口返回空响应' };
  }
  // 只有**数字** status 才是业务错误码。
  //
  // 真实响应里 `status` 还会是字符串：实测 `/api/tasks/{id}.json` 在带
  // `homework_common_id` 时返回 `status:"required"`，而同一个响应的
  // `challenge`/`prev_game`/`test_sets` 数据齐全、完全可用；不带该参数时
  // 这个字段干脆不出现。把非数字 status 当错误码，会把好响应判死
  // （本项目曾因此报「接口业务失败：status=required」，整条关卡链抓不到）。
  // listExperiments 的注释里早写过同一条教训：「不要盲目判 payload.status」。
  if (payload && typeof payload.status === 'number' && ![0, 200].includes(payload.status)) {
    return {
      ok: false,
      kind: 'api',
      status,
      preview,
      reason: `接口业务失败：status=${payload.status} ${normalizeText(payload.message)}`
    };
  }
  if (/^\s*<(!doctype|html)/i.test(text)) {
    return { ok: false, kind: 'html', status, preview, reason: '接口返回的是 HTML 页面（多半仍是未登录页）' };
  }
  return { ok: true, kind: 'ok', status, preview, reason: 'OK' };
}

/** 惰性 + 记忆化的 JSON 解析函数，作为 apiGet 返回值的 json 字段。 */
function lazyJson(text, url) {
  let parsed;
  let done = false;
  return () => {
    if (!done) {
      try {
        parsed = JSON.parse(text);
      } catch (error) {
        throw new ApiError(`接口返回内容不是合法 JSON：${url}`);
      }
      done = true;
    }
    return parsed;
  };
}

// --------------------------------------------------------------- apiGet

/**
 * 在页面里发起 GET —— **这个函数会被序列化后送进浏览器执行，不能引用外部作用域**。
 * 签名头由 Node 侧算好放在 input.headers 里传进来（浏览器里没有 md5，也不该有 AK/SK）。
 */
async function fetchInPage(input) {
  try {
    const response = await fetch(input.url, { credentials: 'include', headers: input.headers });
    return { status: response.status, body: await response.text() };
  } catch (error) {
    return { error: String((error && error.message) || error) };
  }
}

/**
 * 在浏览器上下文里发起 GET，并带上 Educoder 签名头。
 *
 * @param {import('playwright').Page} page
 * @param {string} url
 * @param {{method?: string, headers?: object}} [options]
 * @returns {Promise<{ok: boolean, status: number, text: string, json: () => any}>}
 * 空响应 / 网络异常一律抛出，由调用方决定降级。
 */
async function apiGet(page, url, options = {}) {
  if (!page || typeof page.evaluate !== 'function') {
    throw new ApiError('apiGet 需要 Playwright page 对象：请求必须走浏览器上下文（page.evaluate/fetch）。');
  }
  const method = String(options.method || 'GET').toUpperCase();
  const headers = {
    // 签名 + X-EDU-Type 是接口能通的必要条件，见 educoder-sign.js 的说明。
    ...signingHeaders({ method }),
    'X-EDU-Type': EDU_TYPE,
    ...(options.headers || {})
  };

  let result;
  try {
    result = await page.evaluate(fetchInPage, { url, headers });
  } catch (error) {
    throw new ApiError(`请求失败：${url}（${(error && error.message) || error}）`, { cause: error });
  }
  if (!result || typeof result !== 'object') throw new ApiError(`请求失败：${url}`);
  if (result.error) throw new ApiError(`请求失败：${url}（${result.error}）`);
  const status = toNumber(result.status, NaN);
  if (!Number.isFinite(status)) throw new ApiError(`请求失败：${url}（未取到 HTTP 状态码）`);
  const text = typeof result.body === 'string' ? result.body : '';
  if (!text) {
    // 把实际拿到的东西挂在错误上，便于调用方把原因显示给用户而不是「未知失败」。
    throw new ApiError(`接口返回空响应：${url}`, { details: { status, body: '' }, status });
  }
  return {
    ok: status >= 200 && status < 300,
    status,
    text,
    json: lazyJson(text, url)
  };
}

// ------------------------------------------------------------ 登录与身份

/**
 * 登录态与身份探测。
 *
 * 用 `get_user_info.json`：它是唯一能拿到 `login` 的端点，而且**即使签名失效也能通**，
 * 因此它是「会话还在不在」最干净的判据——签名坏掉和会话掉线可以被区分开。
 *
 * 不抛异常，任何失败都归一化成对象。
 * @returns {Promise<{loggedIn: boolean, user?: string, status?: number, pageUrl: string,
 *   reason: string, preview: string, signatureRejected?: boolean}>}
 */
async function probeLogin(page) {
  const url = `${DATA_ORIGIN}${IDENTITY_PATH}?school=1`;
  let pageUrl = '';
  try {
    pageUrl = typeof page?.url === 'function' ? page.url() : '';
  } catch (error) {
    pageUrl = '';
  }

  let response;
  try {
    response = await apiGet(page, url);
  } catch (error) {
    return { loggedIn: false, pageUrl, reason: error.message, preview: '' };
  }

  const verdict = classifyResponse(response.status, response.text);
  if (verdict.kind === 'signature') {
    return {
      loggedIn: false,
      status: response.status,
      pageUrl,
      reason: verdict.reason,
      preview: verdict.preview,
      signatureRejected: true
    };
  }
  if (!verdict.ok) {
    return { loggedIn: false, status: response.status, pageUrl, reason: verdict.reason, preview: verdict.preview };
  }

  let payload = null;
  try {
    payload = response.json();
  } catch (error) {
    return { loggedIn: false, status: response.status, pageUrl, reason: error.message, preview: verdict.preview };
  }
  const login = normalizeText(payload && payload.login);
  if (!login) {
    return {
      loggedIn: false,
      status: response.status,
      pageUrl,
      reason: '已是登录态，但身份接口没有返回 login 字段',
      preview: verdict.preview
    };
  }
  return { loggedIn: true, user: login, status: response.status, pageUrl, reason: '已登录', preview: verdict.preview };
}

/**
 * 登录态判定。
 *
 * 现在只有两句话：身份接口说登录了就是登录了；说没登录就没登录。
 * （旧实现在这里叠了 cookie + DOM 三重兜底，那是为了绕开 -102 而存在的，
 * 而 -102 的真实原因——缺签名头——已经在 apiGet 里修掉了。）
 */
async function checkLogin(page) {
  const probe = await probeLogin(page);
  if (probe.loggedIn) return probe;
  if (probe.signatureRejected) {
    return {
      ...probe,
      loggedIn: false,
      reason: `${probe.reason}（这不是登录问题，请检查 educoder-sign.js 的常量与 SIGNING_VERSION）`
    };
  }
  return probe;
}

// ---------------------------------------------------------------- 课程

/** 单条课程原始数据 → Course，缺少 name / first_category_url 时返回 null。 */
function toCourse(item) {
  if (!item || typeof item !== 'object') return null;
  const name = normalizeText(item.name);
  const categoryUrl = typeof item.first_category_url === 'string' ? item.first_category_url.trim() : '';
  if (!name || !categoryUrl) return null;
  let classroomUrl;
  try {
    classroomUrl = new URL(categoryUrl, SITE_ORIGIN).href;
  } catch (error) {
    return null;
  }
  const match = /\/classrooms\/([^/?#]+)/.exec(classroomUrl) || /\/classrooms\/([^/?#]+)/.exec(categoryUrl);
  return {
    id: item.id,
    name,
    school: typeof item.school === 'string' ? item.school : '',
    visits: toNumber(item.visits, 0),
    membersCount: toNumber(item.members_count, 0),
    homeworkCommonsCount: toNumber(item.homework_commons_count, 0),
    classroomCode: match ? match[1] : '',
    classroomUrl,
    isEnd: Boolean(item.is_end)
  };
}

/**
 * 分页拉取课程全量。响应形如 `{ count, courses: [...] }`。
 *
 * 分页完整性三道闸（宁可整批失败重来，也不要静默少存课程）：
 * 1. 分页期间 `count` 变化 → 数据在动，结果不可信；
 * 2. 唯一课程数超过 `count` → 服务端返回了预期之外的东西；
 * 3. 提前遇到空页但累计数不足 `count` → 分页提前结束，结果不完整。
 *
 * 跨页重复 id 仍然去重（`sort_by=updated_at` 下翻页时有真实重叠），
 * 重复条数挂在返回值的 `duplicates` 上（不可枚举，不参与 JSON 序列化），
 * 便于上层判断数据是不是在动。
 */
async function listCourses(page, opts = {}) {
  const user = normalizeText(opts.user) || AUTH_USER;
  const requestedPerPage = toNumber(opts && opts.perPage, NaN);
  const perPage = Number.isFinite(requestedPerPage) && requestedPerPage > 0
    ? Math.floor(requestedPerPage)
    : DEFAULT_PER_PAGE;

  const courses = [];
  const seenIds = new Set();
  const rawIds = new Set();
  let duplicates = 0;
  let rawFetched = 0;
  let count = null;
  let truncated = false;

  for (let index = 1; index <= COURSES_PAGE_LIMIT; index += 1) {
    const url = `${DATA_ORIGIN}/api/users/${encodeURIComponent(user)}/courses.json`
      + `?category=&status=processing&page=${index}&per_page=${perPage}`
      + '&sort_by=updated_at&sort_direction=desc'
      + `&username=${encodeURIComponent(user)}`;
    const response = await apiGet(page, url);
    const verdict = classifyResponse(response.status, response.text);
    if (!verdict.ok) throw new ApiError(`读取课程列表失败：${verdict.reason}`, { status: response.status });
    const payload = response.json();
    const batch = payload && Array.isArray(payload.courses) ? payload.courses : [];
    if (payload && Number.isFinite(Number(payload.count))) {
      const observed = Number(payload.count);
      if (count !== null && observed !== count) {
        throw new ApiError(`分页期间课程总数发生变化（${count} → ${observed}），本次结果不可信，请重试。`);
      }
      count = observed;
    }
    if (!batch.length) {
      // 提前遇到空页但累计行数还没到 count：分页被截断了，结果不完整。
      if (count !== null && rawFetched < count) {
        throw new ApiError(`课程分页提前结束：只取到 ${rawFetched} 行，count 声明 ${count} 行。`);
      }
      break;
    }
    // 用「原始行数」而不是「有效课程数」对齐 count：count 会包含被 toCourse 丢弃的
    // 不可用条目（缺 name / 缺 first_category_url），按有效数对齐必然误判成不完整。
    rawFetched += batch.length;
    for (const item of batch) {
      const rawKey = item && typeof item === 'object' && item.id !== undefined && item.id !== null
        ? String(item.id)
        : '';
      if (rawKey) rawIds.add(rawKey);
      const course = toCourse(item);
      if (!course) continue;
      const key = course.id === undefined || course.id === null ? '' : String(course.id);
      if (key) {
        if (seenIds.has(key)) {
          duplicates += 1;
          continue;
        }
        seenIds.add(key);
      }
      courses.push(course);
    }
    if (count !== null && rawFetched >= count) break;
    if (index === COURSES_PAGE_LIMIT) truncated = true;
  }

  if (count !== null && rawIds.size > count) {
    throw new ApiError(`返回课程数（${rawIds.size}）超过 count（${count}），接口结果不可信。`);
  }
  if (truncated) {
    throw new ApiError(
      `课程分页超出安全上限（${COURSES_PAGE_LIMIT} 页）仍未取全，已停止；`
      + '接口可能忽略了 page 参数，请检查接口是否变更。'
    );
  }
  Object.defineProperty(courses, 'duplicates', { value: duplicates, enumerable: false });
  return courses;
}

// ---------------------------------------------------------------- 实验

/**
 * 读取课程下可提取的实训（实验）列表。只保留 `item.is_shixun` 为真的条目。
 *
 * ## 为什么不需要按「章」逐个读取
 *
 * 实测（2026-10-01，软件工程导论 `2i6ng7vp`，8 个章）：
 *
 * | 取法 | 结果 |
 * |---|---|
 * | 不带 `category`，分页取全 | 40 个实验 |
 * | 8 个章各自读取后合并去重（9+3+4+6+6+2+5+5） | 40 个实验 |
 * | 差异 | **0 个** |
 *
 * 章名由每条记录的 `upper_category_name` 直接给出（无章的课堂该字段为 `null`），
 * 所以「按章逐个导航 + 截获响应 + 合并」整套机制是多余的。
 *
 * 注意：成功的响应**往往根本不带 status 字段**（实测真实响应为
 * `{ course_identity, homeworks, all_count, ... }`），因此不盲目判 `payload.status`。
 */
async function listExperiments(page, course, opts = {}) {
  const classroomCode = course && course.classroomCode;
  if (!classroomCode) throw new ApiError('缺少 classroomCode，无法读取课程实验。');
  const user = normalizeText(opts.user) || AUTH_USER;
  const perPage = toNumber(opts.perPage, DEFAULT_PER_PAGE) || DEFAULT_PER_PAGE;

  const raw = [];
  const seenIds = new Set();
  let expected = null;
  for (let index = 1; index <= COURSES_PAGE_LIMIT; index += 1) {
    const url = `${DATA_ORIGIN}/api/courses/${encodeURIComponent(classroomCode)}/homework_commons.json`
      + `?limit=${perPage}&page=${index}&status=0&id=${encodeURIComponent(classroomCode)}&type=4&order=0`
      + `&zzud=${encodeURIComponent(user)}`;
    const response = await apiGet(page, url);
    const verdict = classifyResponse(response.status, response.text);
    if (!verdict.ok) throw new ApiError(`读取课程实验失败：${verdict.reason}`, { status: response.status });
    const payload = response.json();
    const batch = payload && Array.isArray(payload.homeworks) ? payload.homeworks : [];
    if (payload && Number.isFinite(Number(payload.query_total_count))) {
      const observed = Number(payload.query_total_count);
      if (expected !== null && observed !== expected) {
        throw new ApiError(`分页期间实验总数发生变化（${expected} → ${observed}），本次结果不可信，请重试。`);
      }
      expected = observed;
    }

    let fresh = 0;
    for (const item of batch) {
      const key = item && item.homework_id !== undefined && item.homework_id !== null ? String(item.homework_id) : '';
      if (key && seenIds.has(key)) continue;
      if (key) seenIds.add(key);
      raw.push(item);
      fresh += 1;
    }

    // 用「原始行数」对齐 count：count 包含被过滤掉的非实训条目，按有效数对齐必然误判。
    if (expected !== null && raw.length >= expected) break;
    if (!batch.length || fresh === 0) {
      // 空页、或整页都是已见过的条目（服务端忽略了 page 参数）——都到此为止。
      // 若此时仍没凑够声明的数量，说明分页被截断，宁可整批失败也不静默少抓。
      if (expected !== null && raw.length < expected) {
        throw new ApiError(`实验分页提前结束：只取到 ${raw.length} 行，接口声明 ${expected} 行。`);
      }
      break;
    }
    if (index === COURSES_PAGE_LIMIT) {
      throw new ApiError(`实验分页超出安全上限（${COURSES_PAGE_LIMIT} 页）仍未取全，已停止。`);
    }
  }

  const experiments = [];
  const seen = new Set();
  for (const item of raw) {
    if (!item || !item.is_shixun) continue;
    const key = item.homework_id === undefined || item.homework_id === null ? '' : String(item.homework_id);
    if (key) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    experiments.push({
      name: normalizeText(item.name),
      // 章名：有章的课堂才有值，界面与导出目录靠它加 `[章名] ` 前缀。
      categoryName: normalizeText(item.upper_category_name),
      homeworkId: item.homework_id,
      shixunIdentifier: normalizeText(item.shixun_identifier),
      myshixunIdentifier: normalizeText(item.myshixun_identifier),
      taskCount: toNumber(item.challenge_count, 0)
    });
  }
  Object.defineProperty(experiments, 'rawTotal', { value: raw.length, enumerable: false });
  return experiments;
}

/**
 * 读取课堂的「课堂实验」章分类（`left_banner.json`）。
 *
 * **只有兜底路径用得到**：没有 `myshixun_identifier` 的实验拿不到关卡标识，
 * 只能靠导航到它所在的章页再点卡片（见 extract-engine 的 openExperiment）。
 * 主路径（有 myshixun 标识）完全不需要章分类。
 *
 * 返回 `[{ id, name }]`，`name` 形如「8、面向对象分析」。
 */
async function listShixunCategories(page, course, opts = {}) {
  const classroomCode = course && course.classroomCode;
  if (!classroomCode) throw new ApiError('缺少 classroomCode，无法读取章分类。');
  const user = normalizeText(opts.user) || AUTH_USER;
  const url = `${DATA_ORIGIN}/api/courses/${encodeURIComponent(classroomCode)}/left_banner.json`
    + `?zzud=${encodeURIComponent(user)}`;
  const response = await apiGet(page, url);
  const verdict = classifyResponse(response.status, response.text);
  if (!verdict.ok) throw new ApiError(`读取章分类失败：${verdict.reason}`, { status: response.status });
  const payload = response.json();
  const modules = payload && Array.isArray(payload.course_modules) ? payload.course_modules : [];
  const module = modules.find((item) => item && item.name === '课堂实验')
    || modules.find((item) => item && Array.isArray(item.second_category) && item.second_category.length && item.type === 'shixun');
  return ((module && module.second_category) || [])
    .filter((item) => item && item.category_id)
    .map((item) => ({ id: String(item.category_id), name: normalizeText(item.name) }));
}

// ---------------------------------------------------------------- 关卡

/** 单条关卡原始数据 → Challenge，identifier 缺失时返回 null。 */
function toChallenge(item) {
  if (!item || typeof item !== 'object') return null;
  const identifier = item.identifier;
  if (identifier === undefined || identifier === null || normalizeText(identifier) === '') return null;
  const rawIndex = item.homework_challenge_index !== undefined && item.homework_challenge_index !== null
    ? item.homework_challenge_index
    : item.index !== undefined && item.index !== null ? item.index : 0;
  const rawPosition = item.position !== undefined && item.position !== null ? item.position : rawIndex;
  return {
    identifier,
    name: item.subject || item.name || '',
    index: rawIndex,
    position: toNumber(rawPosition, 0),
    // 关卡的数字主键：列表没有 identifier 时靠它做「选中的是哪一关」的身份（见 BUG-019）。
    challengeId: item.challenge_id === undefined || item.challenge_id === null ? '' : String(item.challenge_id),
    type: Array.isArray(item.chooses) && item.chooses.length
      ? 'choice'
      : item.with_code_file ? 'code' : 'unknown'
  };
}

/**
 * 读取实训的关卡列表——**只有名称与序号，没有关卡标识**。
 *
 * `/api/shixuns/{id}/challenges.json` 一定拿得到（`challenge_list`），
 * 但响应里没有 `identifier`（实测字段是 `challenge_id` / `position` / `name` / `score` …）。
 * 因此它只用于「没有 `myshixun_identifier` 的实验」显示关卡名与序号；
 * 关卡标识只能靠页面上的「查看实战」+ `prev_game` 回溯取得。
 *
 * 接口失败返回 []（不抛出），与 `listChallenges` 同口径。
 */
async function listChallengeNames(page, experiment, opts = {}) {
  const shixunIdentifier = experiment && experiment.shixunIdentifier;
  if (shixunIdentifier === undefined || shixunIdentifier === null || String(shixunIdentifier) === '') return [];
  const user = normalizeText(opts.user) || AUTH_USER;
  const url = `${DATA_ORIGIN}/api/shixuns/${encodeURIComponent(shixunIdentifier)}/challenges.json`
    + `?id=${encodeURIComponent(shixunIdentifier)}&zzud=${encodeURIComponent(user)}`;
  let payload;
  try {
    payload = (await apiGet(page, url)).json();
  } catch (error) {
    return [];
  }
  const items = Array.isArray(payload)
    ? payload
    : payload && Array.isArray(payload.challenge_list)
      ? payload.challenge_list
      : payload && Array.isArray(payload.data)
        ? payload.data
        : payload && Array.isArray(payload.challenges) ? payload.challenges : [];
  return items
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const name = normalizeText(item.name || item.subject);
      if (!name) return null;
      return {
        name,
        position: toNumber(item.position, 0),
        challengeId: item.challenge_id === undefined || item.challenge_id === null ? '' : String(item.challenge_id)
      };
    })
    .filter(Boolean);
}

/**
 * 读取实训的关卡列表。响应可能是数组 / `{data:[]}` / `{challenges:[]}`。
 * 接口失败时返回 []（不抛出），引擎会退化为按 `next_game` 链遍历。
 */
async function listChallenges(page, experiment, opts = {}) {
  const myshixunIdentifier = experiment && experiment.myshixunIdentifier;
  const homeworkId = experiment && experiment.homeworkId;
  // 子标签实验只有 homework_id、没有 myshixun 标识：仍然可以按作业主键问一次接口，
  // 拿不到就返回 []（引擎会退化为沿关卡链遍历）。
  if (
    (myshixunIdentifier === undefined || myshixunIdentifier === null || String(myshixunIdentifier) === '') &&
    (homeworkId === undefined || homeworkId === null || String(homeworkId) === '')
  ) {
    return [];
  }
  const user = normalizeText(opts.user) || AUTH_USER;
  const url = myshixunIdentifier
    ? `${DATA_ORIGIN}/api/myshixuns/${encodeURIComponent(myshixunIdentifier)}/challenges.json`
      + `?homework_common_id=${homeworkId === undefined || homeworkId === null ? '' : encodeURIComponent(homeworkId)}`
      + `&zzud=${encodeURIComponent(user)}`
    : `${DATA_ORIGIN}/api/homework_commons/${encodeURIComponent(homeworkId)}/shixun_challenge_data.json`
      + `?categoryId=${encodeURIComponent(homeworkId)}&zzud=${encodeURIComponent(user)}`;
  let payload;
  try {
    payload = (await apiGet(page, url)).json();
  } catch (error) {
    return [];
  }
  const items = Array.isArray(payload)
    ? payload
    : payload && Array.isArray(payload.data)
      ? payload.data
      : payload && Array.isArray(payload.challenges) ? payload.challenges : [];
  return items.map(toChallenge).filter(Boolean);
}

module.exports = {
  AUTH_USER,
  apiGet,
  checkLogin,
  probeLogin,
  classifyResponse,
  listCourses,
  listExperiments,
  listShixunCategories,
  listChallenges,
  listChallengeNames,
  ApiError,
  AuthExpiredError,
  SignatureRejectedError
};
