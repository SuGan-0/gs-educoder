const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium } = require('playwright');

const { safeName, makeLevelSection, makeExperimentDocument, taskFromApi, classifyTask, detectImageExtension, normalizeImageSource, levelId, KINDS } = require('./task-parser');
const { ARCHIVE_NAME, readArchive, appendLevel, orderedLevels, toArchiveRecord } = require('./level-store');
const { levelPassed, choiceAnswerText, mergeAnswer, loadAnswerDocument } = require('./answer-store');
const api = require('./educoder-api');
const { SIGNING_VERSION } = require('./educoder-sign');

// 本文件位于 extractor/lib/，仓库根需要上跳两级。
const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_EXPORT_ROOT = path.join(ROOT, 'exports');
const DEFAULT_PROFILE_DIR = path.join(ROOT, '.educoder-browser');
const CLASSROOMS_URL = 'https://www.educoder.net/users/p8sxailt2/classrooms';

const TEXT_LIMIT = 64 * 1024;
const REQUEST_TIMEOUT = 15000;
/** 关卡列表等待预算：真实环境实测导航后立即命中（0ms），留 8 秒余量即可。 */

function truncate(value, limit = TEXT_LIMIT) {
  const text = String(value ?? '');
  return text.length > limit ? `${text.slice(0, limit)}…[已截断 ${text.length - limit} 字符]` : text;
}

function questionText(question) {
  return [question?.subject, ...(question?.options || [])].join('\n');
}

function collectImageSources(task) {
  const blob = [
    task.taskDescription,
    task.programmingRequirements,
    ...(task.choiceQuestions || []).map(questionText),
    ...(task.choices || [])
  ].join('\n');
  const sources = new Set();
  for (const match of blob.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["']/gi)) {
    const url = normalizeImageSource(match[1]);
    if (url) sources.add(url);
  }
  for (const match of blob.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) {
    // 括号里可能是 `url "标题"` 或 ` <url> `：必须只取 URL 部分（见 normalizeImageSource）
    const url = normalizeImageSource(match[1]);
    if (url) sources.add(url);
  }
  return [...sources];
}

class ExtractEngine {
  constructor(options = {}) {
    const control = options.control || {};
    this.exportRoot = options.exportRoot || DEFAULT_EXPORT_ROOT;
    this.profileDir = options.profileDir || DEFAULT_PROFILE_DIR;
    this.headless = options.headless === true;
    this.networkLog = options.networkLog || null;
    this.pageSettleMs = Number.isFinite(options.pageSettleMs) ? options.pageSettleMs : null;
    /** 默认跳过本地已存在的关卡，避免重复抓取与覆盖。 */
    this.skipExisting = options.skipExisting !== false;
    /** 只提取答案：不写题目存档（levels.jsonl / md / 图片），只导出 answers。 */
    this.answersOnly = options.answersOnly === true;
    this.onEvent = typeof options.onEvent === 'function' ? options.onEvent : () => {};
    this.control = {
      waitForCourse: control.waitForCourse || (async (courses) => courses[0]),
      waitForExperiments: control.waitForExperiments || (async (items) => items),
      waitForLevels: control.waitForLevels || (async () => null),
      // 多实验统一选择：未提供时退回 waitForLevels，保持旧外壳可用。
      waitForAllLevels: control.waitForAllLevels || control.waitForLevels || (async () => null),
      shouldStop: control.shouldStop || (async () => false)
    };
    this.context = null;
    this.page = null;
    this.stopRequested = false;
    this.running = false;
    this.currentLevelPosition = null;
    this.currentLevelSubject = '';
    this.stats = { saved: 0, skipped: 0, failed: 0, existing: 0, dropped: 0 };
    /** 每个实验已写入的关卡（task 对象），落盘时合成「一个实验一个文件」。 */
    this.experimentLevels = new Map();
    this.discoveredCourses = [];
    this.discoveredExperiments = [];
    this.discoveredLevels = [];
    this.currentCourse = null;
    this.currentExperiment = null;
    this.currentTotal = 0;
    /** 多实验时的整轮进度计数 {current,total}；单实验为 null（沿用 currentIndex/currentTotal）。 */
    this.runProgress = null;
    this.timestamp = () => new Date().toISOString().slice(11, 19);
  }

  emit(event) {
    try {
      this.onEvent(event);
    } catch (error) {
      process.stderr.write(`事件回调异常：${error.message}\n`);
    }
  }

  status(phase, message, extra = {}) {
    this.phase = phase;
    this.emit({ type: 'status', phase, message, ...extra });
  }

  log(message, level = 'info') {
    this.emit({ type: 'log', level, message });
  }

  progress(extra = {}) {
    // 多实验（勾了多个实验的关卡）时用**整轮**计数：否则切到下一个实验时徽章会被打回
    // `0 / N`，看起来像前一个实验的成果丢了（实测：勾 2 个实验、跑完后徽章停在 `0 / 3`）。
    const run = this.runProgress;
    this.emit({
      type: 'progress',
      saved: this.stats.saved,
      skipped: this.stats.skipped,
      failed: this.stats.failed,
      existing: this.stats.existing || 0,
      dropped: this.stats.dropped || 0,
      current: run ? run.current : (extra.current ?? this.currentIndex ?? 0),
      total: run ? run.total : (extra.total ?? this.currentTotal ?? 0),
      experimentName: extra.experimentName ?? this.currentExperiment?.name ?? '',
      courseName: extra.courseName ?? this.currentCourse?.name ?? '',
      levelName: extra.levelName ?? '',
      levelType: extra.levelType ?? ''
    });
  }

  async stop() {
    this.stopRequested = true;
    if (this.context) await this.context.close().catch(() => {});
    this.context = null;
    this.page = null;
  }

  async stopping() {
    if (this.stopRequested) return true;
    if (await this.control.shouldStop()) {
      this.stopRequested = true;
      return true;
    }
    return false;
  }

  async sleep(ms) {
    if (this.pageSettleMs !== null) {
      await new Promise((resolve) => setTimeout(resolve, this.pageSettleMs));
      return;
    }
    if (this.page) await this.page.waitForTimeout(ms);
    else await new Promise((resolve) => setTimeout(resolve, ms));
  }

  async launch() {
    await fs.mkdir(this.exportRoot, { recursive: true });
    this.status('browser', '正在启动 Chromium（有头模式）…');
    try {
      this.context = await this.launchContextWithRetry();
    } catch (error) {
      const message = this.explainLaunchError(error);
      this.log(message, 'error');
      throw new Error(message);
    }
    this.page = this.context.pages()[0] || (await this.context.newPage());
    if (this.networkLog) this.attachNetworkCapture(this.page);
    this.log('浏览器已启动，登录状态取自本地浏览器目录。');
  }

  /**
   * 启动持久化浏览器，遇到「profile 被占用」时重试。
   *
   * 同一个 `--user-data-dir` 不能被两个 Chromium 同时使用：若已有实例（例如另一个
   * `npm run ui`、或上一次崩溃残留的进程）在用它，新进程会启动即退出（Chrome exitCode=21）。
   * 这类冲突多数是暂时的，重试几次即可；仍失败则给出可操作的说明。
   */
  async launchContextWithRetry(attempts = 3) {
    let lastError = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await chromium.launchPersistentContext(this.profileDir, {
          headless: this.headless,
          viewport: { width: 1440, height: 900 }
        });
      } catch (error) {
        lastError = error;
        const retriable = /Target page, context or browser has been closed|exitCode=21|ProcessSingleton|already in use/i.test(
          String(error && error.message)
        );
        if (!retriable || attempt === attempts) break;
        this.log(`浏览器启动失败（第 ${attempt} 次）：profile 可能被占用，2 秒后重试…`, 'warn');
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
    throw lastError;
  }

  /** 把启动失败翻译成用户能照着做的说明。 */
  explainLaunchError(error) {
    const raw = String((error && error.message) || error).split('\n')[0];
    const locked = /Target page, context or browser has been closed|exitCode=21|ProcessSingleton|already in use/i.test(raw);
    if (!locked) return `浏览器启动失败：${raw}`;
    return (
      '浏览器启动失败：登录用的浏览器目录正被另一个进程占用。' +
      `请先关闭其它正在运行的抓取窗口（或结束残留的 Chromium 进程）后再点「开始提取」。` +
      `目录：${this.profileDir}`
    );
  }

  attachNetworkCapture(page) {
    page.on('response', async (response) => {
      const url = response.url();
      if (!/educoder\.net\/api\//i.test(url)) return;
      const record = {
        time: new Date().toISOString(),
        status: response.status(),
        method: response.request().method(),
        url
      };
      try {
        record.body = await response.text();
      } catch (error) {
        record.bodyError = error.message;
      }
      await fs.appendFile(this.networkLog, `${JSON.stringify(record)}\n`, 'utf8').catch(() => {});
    });
  }



  /** 与 cachedResponse 同源，但返回命中的缓存键（响应 URL）与响应体，便于调用方判断归属。 */

  /** 只导航（已在目标页则跳过），不等待任何特定响应。 */
  async navigateTo(page, url) {
    let alreadyThere = false;
    try {
      alreadyThere = page.url() === url;
    } catch {
      alreadyThere = false;
    }
    if (alreadyThere) return;
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
    } catch (error) {
      this.log(`打开页面失败（继续尝试用已有上下文）：${(error && error.message) || error}`, 'warn');
    }
  }

  /** 导航到某页并等待页面自身发出匹配的 API 请求，返回其响应体。 */

  async ensureLogin() {
    this.status('login', '正在检查登录状态…');
    try {
      await this.page.goto(CLASSROOMS_URL, { waitUntil: 'domcontentloaded' });
    } catch (error) {
      this.log(`打开课堂页面失败（继续尝试检测登录）：${error.message}`, 'warn');
    }
    let check = await api.checkLogin(this.page).catch((error) => ({
      loggedIn: false,
      reason: `检查登录出错：${error.message}`
    }));

    // 签名坏掉和会话掉线是两件事，处置完全不同：
    // 签名问题重新登录一万次也没用，必须快速失败并说清要改哪里。
    // （旧实现在这里抓页面 DOM 兜底，那是为了绕开 -102 而存在的；
    //   -102 的真实原因是缺签名头，已在 educoder-api/apiGet 里修掉。）
    if (!check.loggedIn && check.signatureRejected) {
      const message = `请求签名被接口拒绝：${check.reason}`
        + '这既不是登录问题，也不是系统时间问题（接口的文案有误导性）。'
        + `请检查 extractor/lib/educoder-sign.js 的 AK/SK 常量与 SIGNING_VERSION（当前 ${SIGNING_VERSION}）`
        + '——网站改版会换掉这两个常量；也可先用 node tools/probe-signature.js 单独验证。';
      this.log(message, 'error');
      if (check.preview) this.log(`接口原文：${check.preview}`, 'error');
      this.status('error', message, { loggedIn: false });
      return false;
    }

    if (!check.loggedIn) {
      this.status('waiting-login', '请在打开的浏览器窗口中登录头歌，脚本会自动检测登录完成。', {
        loggedIn: false
      });
      this.log(`未检测到有效登录态（${check.reason || '未知原因'}），等待手动登录…`, 'warn');
      const deadline = Date.now() + 15 * 60 * 1000;
      let ticks = 0;
      let signatureStreak = 0;
      while (Date.now() < deadline) {
        if (await this.stopping()) return false;
        await this.sleep(3000);
        ticks += 1;
        check = await api.checkLogin(this.page).catch((error) => ({
          loggedIn: false,
          reason: `检查登录出错：${error.message}`
        }));
        if (check.loggedIn) break;

        // 签名被拒时登录再多次也不会好——快速失败，别让用户干等 15 分钟。
        if (check.signatureRejected) {
          signatureStreak += 1;
          if (signatureStreak >= 3) {
            const message = `请求签名被接口拒绝：${check.reason}`
              + '这不是登录问题。'
              + `请检查 extractor/lib/educoder-sign.js 的 AK/SK 常量（SIGNING_VERSION=${SIGNING_VERSION}）。`;
            this.log(message, 'error');
            if (check.preview) this.log(`接口原文：${check.preview}`, 'error');
            this.status('error', message, { loggedIn: false });
            return false;
          }
        } else {
          signatureStreak = 0;
        }

        // 首次立即汇报诊断信息，之后每 5 次（约 15 秒）汇报一次，便于定位为什么检测不到。
        if (ticks === 1 || ticks % 5 === 0) {
          const detail = [
            `状态：${check.reason || '未知'}`,
            check.status ? `HTTP ${check.status}` : '',
            `页面：${this.page.url()}`
          ]
            .filter(Boolean)
            .join('｜');
          this.log(`仍未检测到登录态。${detail}`, 'warn');
          if (check.preview) this.log(`接口返回内容片段：${check.preview}`, 'warn');
          this.status('waiting-login', `等待登录中。${check.reason || ''}`, { loggedIn: false });
        }
      }
    }

    if (!check.loggedIn) {
      this.status('error', '等待登录超时，请重新运行。', { loggedIn: false });
      return false;
    }

    this.user = check.user || api.AUTH_USER;
    this.status('courses', `已登录：${this.user}，正在读取课程列表…`, { user: this.user, loggedIn: true });
    this.log(`登录态有效：${this.user}`);
    return true;
  }

  /**
   * 现场诊断：在「已经打开的浏览器」里跑一遍关键检查，把结论写进日志。
   * 用于定位「明明登录了却一直显示等待登录」这类问题，不需要关闭浏览器或重开 profile。
   */
  async diagnose() {
    const page = this.page;
    if (!page) {
      this.log('尚未启动浏览器，无法诊断。', 'error');
      return { ok: false, reason: '浏览器未启动' };
    }
    const lines = [];
    const out = (message, level = 'info') => {
      lines.push(message);
      this.log(message, level);
    };

    out(`诊断开始。当前页面：${page.url()}`);

    // 1) cookie
    try {
      const context = typeof page.context === 'function' ? page.context() : null;
      const cookies = context && typeof context.cookies === 'function' ? await context.cookies() : [];
      const names = cookies.map((cookie) => cookie.name);
      const hasSession = names.some((name) => /_educoder_session|autologin/.test(name));
      out(`浏览器 cookie 共 ${cookies.length} 个，会话 cookie：${hasSession ? '存在' : '不存在'}`);
      if (cookies.length) out(`cookie 名：${names.slice(0, 12).join(', ')}`);
    } catch (error) {
      out(`读取 cookie 失败：${error.message}`, 'warn');
    }

    // 2) 登录探测（含接口原文）
    try {
      const probe = await api.checkLogin(page);
      out(`登录探测：loggedIn=${probe.loggedIn}｜${probe.reason || '无原因'}`);
      if (probe.preview) out(`接口原文：${probe.preview}`, probe.signatureRejected ? 'error' : 'info');
    } catch (error) {
      out(`登录探测异常：${error.message}`, 'error');
    }

    // 3) 页面是否已经显示为登录状态（DOM 兜底判据）
    try {
      const dom = await page.evaluate(() => {
        const text = (document.body?.innerText || '').replace(/\s+/g, ' ');
        return {
          hasLoginEntry: /登录\s*\/\s*注册|立即登录|请先登录/.test(text),
          hasUserMenu: /退出登录|个人中心|我的课堂|消息/.test(text),
          title: document.title,
          url: location.href
        };
      });
      out(
        `页面 DOM：标题「${dom.title}」｜出现登录入口=${dom.hasLoginEntry}｜出现用户菜单=${dom.hasUserMenu}`
      );
    } catch (error) {
      out(`读取页面 DOM 失败：${error.message}`, 'warn');
    }

    // 4) 签名自检：必须用一个**需要签名**的接口来验。
    //    身份接口免签名也能通，因此它只能证明会话没掉，证明不了签名没坏——
    //    这正是过去把「签名缺失」误判成「没登录 / 设备时间不对」的根源。
    try {
      const user = this.user || api.AUTH_USER;
      const url = `https://data.educoder.net/api/users/${user}/courses.json?per_page=1&zzud=${user}`;
      const response = await api.apiGet(page, url);
      const verdict = api.classifyResponse(response.status, response.text);
      out(
        `签名自检（常量版本 ${SIGNING_VERSION}）：${verdict.ok ? '有效' : `失败——${verdict.reason}`}`,
        verdict.ok ? 'info' : 'error'
      );
      if (!verdict.ok && verdict.preview) out(`接口原文：${verdict.preview}`, 'error');
    } catch (error) {
      out(`签名自检失败：${error.message}`, 'warn');
    }

    return { ok: true, lines };
  }

  async loadCourses() {
    let courses = [];
    try {
      courses = await api.listCourses(this.page, { user: this.user });
    } catch (error) {
      // 不再回退到页面 React Fiber：接口现在能通，抓不到就是真失败。
      // 静默换个来源会把「签名坏了」伪装成「你有 0 门课」，比直接报错危险得多。
      this.log(`课程接口读取失败：${error.message}`, 'warn');
    }
    if (courses.duplicates) {
      this.log(`课程分页有 ${courses.duplicates} 条跨页重复，已去重（sort_by=updated_at 下属正常现象）。`);
    }
    this.discoveredCourses = courses;
    this.emit({ type: 'courses', courses });
    return courses;
  }

  /**
   * 读取课堂下的实验列表。
   *
   * 直接调 `homework_commons.json`：**不截获页面响应、也不按章逐个读取**。
   * 实测不带 `category` 就返回全部实验，章名由每条记录的 `upper_category_name`
   * 给出（见 `educoder-api.listExperiments` 的实测表格）。
   *
   * 显示名加 `[章名] ` 前缀——**只在有章时才加**。这不是美化：导出目录名与答案
   * 文件名都用它，历史产物就是这么命名的（软件工程导论 30 个目录全部带前缀，
   * 而机器学习 / Java设计模式 这类没有章的课堂不加前缀），规则不一致就会把已有
   * 资料全部对不上。
   */
  async loadExperiments(course) {
    let experiments = [];
    try {
      experiments = await api.listExperiments(this.page, course, { user: this.user });
    } catch (error) {
      // 不回退到解析页面：接口现在能通，抓不到就是真失败。
      // 静默换个来源会把「签名坏了」伪装成「这个课堂没有实验」，比直接报错危险得多。
      this.log(`实验接口读取失败：${error.message}`, 'error');
      throw error;
    }
    // 未发布的实验被 listExperiments 滤掉了（学生页面上没有它们的卡片，
    // 进列表只会让提取白等一轮入口再跳过）。这里把名单打出来——
    // 「为什么我课程里的实验列表里没有它」必须有一句解释，不能静默变少。
    const skippedUnpublished = experiments.skippedUnpublished || [];
    if (skippedUnpublished.length) {
      const names = skippedUnpublished.map((item) => item.name).filter(Boolean);
      const listed = names.slice(0, 8).join('、') + (names.length > 8 ? '…' : '');
      this.log(
        `跳过 ${skippedUnpublished.length} 个未发布的实验（老师还没发布，课程页上看不到）：${listed}`,
        'warn'
      );
    }
    experiments = experiments.map((item) => ({
      ...item,
      name: item.categoryName ? `[${item.categoryName}] ${item.name}` : item.name
    }));

    // 兜底路径才需要章分类：没有 myshixun_identifier 的实验拿不到关卡标识，
    // 只能先打开它所在的章页再点卡片。主路径用不到，所以按需读取。
    if (experiments.some((item) => !item.myshixunIdentifier && item.categoryName)) {
      const categories = await api
        .listShixunCategories(this.page, course, { user: this.user })
        .catch((error) => {
          this.log(`章分类读取失败（只影响无标识实验的兜底路径）：${error.message}`, 'warn');
          return [];
        });
      // 分类名带编号前缀（left_banner 返回「8、面向对象分析」），实验的 categoryName 不带
      // （「面向对象分析」）——精确匹配必然落空，categoryId 全空 → 章页导航被跳过 →
      // 页面停在课堂列表页，整批实验「无法定位入口」（10-11 实测 5 个实验全这么挂的）。
      const stripIndex = (name) => String(name || '').replace(/^\d+、\s*/, '').trim();
      const idByExact = new Map(categories.map((item) => [String(item.name || '').trim(), item.id]));
      const idByBareName = new Map(categories.map((item) => [stripIndex(item.name), item.id]));
      experiments = experiments.map((item) => ({
        ...item,
        categoryId: idByExact.get(String(item.categoryName || '').trim())
          || idByBareName.get(stripIndex(item.categoryName))
          || ''
      }));
    }

    if (!experiments.length) this.log('该课堂没有可提取的课堂实验。');
    this.discoveredExperiments = experiments;
    this.emit({ type: 'experiments', course, experiments });
    return experiments;
  }

  /** 从 homework_commons 响应里取作业总数，用于区分「没有作业」与「有作业但没有课堂实验」。 */





  /** 解析 homework_commons.json 响应体 → Experiment[]（页面与 API 两条路径共用）。 */

  /**
   * 读取实验的关卡列表。
   *
   * 真实端点由**实训关卡页自身**发出（`api/shixuns/{id}/challenges.json` 与
   * `api/myshixuns/{id}/challenges.json` 都会出现），因此顺序必须是：
   * 先导航到该页（页面才会发请求）→ 命中响应缓存 → 都没拿到再用 data API。
   * 之前直接读缓存，而此前从未进过该页，缓存恒为空 → 关卡列表总是空。
   */

  /**
   * 读取某个实验的关卡列表。
   *
   * 默认会发 `levels` 事件（单实验路径用）。多实验统一选择时由 `selectLevelsForAll`
   * 一次性发出合并列表，这里必须 `{ emit: false }` —— 否则每读一个实验就覆盖一次界面，
   * 关卡区只会显示「最后一个被读取的实验」的关卡（多选实验时的真实 bug）。
   */
  /**
   * 读关卡列表。**两条路径都直连接口：不导航、不轮询、不等响应。**
   *
   * | 实验类型 | 接口 | 拿到什么 |
   * |---|---|---|
   * | 有 `myshixun_identifier`（实测 40 个里 35 个） | `/api/myshixuns/{id}/challenges.json` | 名称 + 序号 + **关卡标识** |
   * | 没有（新发布、本人还没打开过） | `/api/shixuns/{id}/challenges.json` | 名称 + 序号，**没有标识** |
   *
   * 没有标识时入口只能靠点页面上的「查看实战」再沿 `prev_game` 回溯（`enterFirstLevel`）。
   *
   * 旧实现是「先导航到实验页 → 等页面自己发请求 → 轮询响应缓存最多 8 秒 → 再重试一次导航」。
   * 那是在误以为直连会被 `-102` 拒绝的年代写的；现在没有任何理由，而且每个实验都要
   * 多等最多 8 秒、多一次完整页面导航。
   */
  async loadLevels(experiment, { emit = true } = {}) {
    let levels = [];
    if (experiment.myshixunIdentifier) {
      try {
        levels = await api.listChallenges(this.page, experiment, { user: this.user });
      } catch (error) {
        this.log(`关卡接口读取失败：${error.message}`, 'warn');
      }
      if (levels.length) this.log(`已通过接口读取到 ${levels.length} 个关卡（含关卡标识）。`);
    }

    if (!levels.length) {
      // 兜底：只有名称与序号。选关仍可用（按序号/challengeId），入口交给回溯。
      levels = await api.listChallengeNames(this.page, experiment, { user: this.user });
      if (levels.length) {
        this.log(`接口只给出 ${levels.length} 个关卡名称（无标识），入口将用 prev_game 回溯确定。`);
      }
    }

    if (!levels.length) {
      this.log('未能读取关卡列表；将尝试沿关卡链遍历，并尽可能从页面元素确定起点。', 'warn');
    }
    this.discoveredLevels = levels;
    // 归属白名单：本实验**应有**哪几关（challenge_id 与关卡名）。
    // 抓到的不在白名单里 = 入口串到了别的实训（10-11 实测 [8、面向对象分析] 5 个实验
    // 全串到同一个旧任务 wafjr3xgmk5b），captureLevel 在写盘前按这个清单拒收。
    experiment.expectedChallengeIds = new Set(
      levels.map((level) => String(level.challengeId || '')).filter(Boolean)
    );
    experiment.expectedSubjects = new Set(
      levels.map((level) => String(level.name || '').trim()).filter(Boolean)
    );
    if (emit) {
      // 单实验路径也标注跳过清单，与多实验路径（selectLevelsForAll）行为一致。
      let local = null;
      try {
        local = await this.localDoneIndex(this.currentCourse, experiment);
      } catch (error) {
        this.log(`实验「${experiment.name}」跳过清单读取失败：${error.message}`, 'warn');
      }
      levels = levels.map((level) => {
        const index = Number(level?.position ?? level?.index) || 0;
        return {
          ...level,
          localDone: {
            archived: local ? local.archived.has(index) : false,
            answered: local ? local.answered.has(index) : false
          }
        };
      });
      this.discoveredLevels = levels;
      this.emit({ type: 'levels', experiment, levels });
    }
    return levels;
  }

  /**
   * 从起点沿 `prev_game` 反向回溯，直到 `prev_game === null` 的那一关——那就是第 1 关。
   *
   * 为什么必须回溯而不能只看关卡列表：列表可能不完整（实测两个真实端点的信息量不同，
   * `challenge_list` 只有名称、没有序号可信度），页面链接更可能只指向「上次停留的关卡」。
   * 只有 `prev_game === null` 是「这是链首」的硬证据。
   *
   * @param {string} fromIdentifier 起始关卡标识（入口候选，如 game_identifier 或列表最小序号）
   * @param {object} experiment
   * @param {number} limit 最多回溯多少步，防止异常数据造成死循环
   * @returns {Promise<{identifier: string|null, index?: number, subject?: string, exact: boolean}>}
   *   exact=true 表示确认回溯到了链首；false 表示中途读取失败，结果可能不是真正的第 1 关。
   */
  async findChainStart(fromIdentifier, experiment, limit = 30) {
    let current = fromIdentifier;
    const seen = new Set();
    let steps = 0;
    while (current && !seen.has(current) && steps < limit) {
      seen.add(current);
      steps += 1;
      let payload;
      try {
        payload = await this.fetchTask(this.page, current, experiment);
      } catch (error) {
        this.log(`回溯关卡链时读取失败（${current}）：${error.message}`, 'warn');
        return { identifier: current, exact: false };
      }
      if (!payload?.prev_game) {
        return {
          identifier: current,
          index: payload?.challenge?.homework_challenge_index,
          subject: payload?.challenge?.subject,
          exact: true
        };
      }
      current = payload.prev_game;
    }
    return { identifier: current, exact: false };
  }

  /**
   * 决定从哪一关开始遍历。
   *
   * 入口只需满足一件事：**它是链首（第 1 关）**。因此宁可多走一次回溯，也不能从
   * 「上次停留的关卡」开始——否则前面的关卡整段丢失（实测只抓到第 5~11 关）。
   *
   * 做法：先用可信度最高的候选作为回溯起点，再沿 `prev_game` 回溯确认链首；
   * 若回溯结果与候选不一致，以回溯结果为准并记日志说明。
   *
   * @param {object} experiment
   * @param {string[]} pageLinks 页面上扫到的 /tasks/ 链接
   * @param {Array<{identifier?:string, position?:number, index?:number, name?:string}>} [levels]
   *   **当前这个实验自己的关卡列表**。多实验连抓时必须显式传入——
   *   引擎上的 `this.discoveredLevels` 在 selectLevelsForAll 之后停留在**最后一个**
   *   被读取的实验的列表上（10-14 实测：一门课所有实验的入口全部串到同一份列表的
   *   「第 1 关 软件危机」，每个实验都「选中 N 关，只到达 0 关」）。不传时才退回共享值
   *   （单实验路径刚调完 loadLevels，二者一致，老测试也依赖这个行为）。
   */
  async resolveEntry(experiment, pageLinks = [], levels = null) {
    const sourceLevels = Array.isArray(levels) ? levels : (this.discoveredLevels || []);
    const known = new Map(
      sourceLevels
        .filter((level) => level && level.identifier)
        .map((level) => [String(level.identifier), level])
    );
    /** 序号：接口给的 `position` 优先，其次 `index`（页面解析出来的只有 index）。 */
    const orderOf = (level) => {
      const value = Number(level.position ?? level.index);
      return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
    };
    const smallest = (list) => (list.length
      ? list.reduce((min, item) => (orderOf(item) < orderOf(min) ? item : min))
      : null);

    // 候选优先级：页面链接中序号最小者 → 关卡列表序号最小者 → 关卡列表首项 → 实训上下文。
    const linked = smallest(
      pageLinks
        .map((href) => ExtractEngine.identifierFromTaskUrl(href))
        .filter((id) => id && known.has(id))
        .map((id) => known.get(id))
    );
    const fromList = smallest([...known.values()]);

    // 接口已明确给出「第 1 关」时直接采用，**不必再回溯**。
    // 旧实现无论列表多完整都要沿 prev_game 回溯确认一次，每关多读一次 tasks.json；
    // 那是为「页面链接只指向上次停留的关卡」准备的兜底，不该用在接口已给出序号的场景。
    if (linked && orderOf(linked) === 1) {
      return { identifier: String(linked.identifier), index: 1, subject: linked.name, source: 'page-link', exact: true };
    }
    if (fromList && orderOf(fromList) === 1 && !linked) {
      this.log(`入口定位：第1关 ${fromList.name || ''}（来自关卡列表）`);
      return { identifier: String(fromList.identifier), index: 1, subject: fromList.name, source: 'level-list', exact: true };
    }

    const candidate = linked?.identifier
      || fromList?.identifier
      || sourceLevels.find((level) => level.identifier)?.identifier
      || experiment.gameIdentifier
      || null;

    if (!candidate) return { identifier: null, source: 'none' };

    const source = linked ? 'page-link' : fromList ? 'level-list' : 'context';

    // 其余情况一律回溯确认链首。
    const start = await this.findChainStart(candidate, experiment);
    if (start.exact) {
      const changed = String(start.identifier) !== String(candidate);
      this.log(
        `入口定位：第${start.index ?? '?'}关 ${start.subject || ''}（来自 ${source}）` +
          (changed ? `；已从 ${candidate} 回溯到链首` : '；确认已是链首')
      );
    } else {
      this.log(
        `入口定位未确认（从 ${candidate} 回溯未到达链首），可能与实际第 1 关不一致，请核对产物。`,
        'warn'
      );
    }
    return {
      identifier: start.identifier,
      index: start.index,
      subject: start.subject,
      source: `backtrack:${source}`,
      exact: start.exact
    };
  }

  /** 解析关卡列表响应。
   *  支持三种真实形态：
   *  1. `/api/myshixuns/{id}/challenges.json` → 数组或 {data|challenges:[]}（含 identifier）
   *  2. `/api/shixuns/{id}/challenges.json` → { challenge_list: [{ name, position, challenge_id }] }
   *     （只有名称与序号，没有关卡标识，标识需要沿关卡链取得）
   */
  parseChallenges(body, experiment, source) {
    let payload = null;
    try {
      payload = JSON.parse(body);
    } catch {
      this.log('关卡列表响应不是合法 JSON，已忽略。', 'warn');
      return [];
    }

    const toLevel = (item, fallbackIndex) => {
      if (!item || typeof item !== 'object') return null;
      const identifier = item.identifier || item.game_identifier || '';
      const chooses = Array.isArray(item.chooses) && item.chooses.length > 0;
      const index = item.homework_challenge_index ?? item.position ?? item.index ?? fallbackIndex;
      // challenge_id 是列表自带的稳定数字标识；关卡标识（identifier）缺失时用作选择身份，
      // 这样「只抓选中的关卡」在只有名称的列表上也能成立（见 BUG-019）。
      const challengeId = item.challenge_id ?? item.id ?? '';
      if (!identifier && !item.name && !item.subject) return null;
      return {
        identifier: identifier ? String(identifier) : '',
        name: String(item.subject || item.name || ''),
        index: Number(index) || fallbackIndex,
        position: Number(index) || fallbackIndex,
        challengeId: challengeId === '' ? '' : String(challengeId),
        type: chooses ? 'choice' : item.with_code_file ? 'code' : 'unknown',
        source
      };
    };

    const rawList = Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.data)
        ? payload.data
        : Array.isArray(payload?.challenges)
          ? payload.challenges
          : Array.isArray(payload?.challenge_list)
            ? payload.challenge_list
            : [];

    const levels = rawList.map((item, i) => toLevel(item, i + 1)).filter(Boolean);
    if (levels.length && source === 'page') {
      const withId = levels.filter((level) => level.identifier).length;
      this.log(
        `已通过页面自身请求读取到 ${levels.length} 个关卡${withId === levels.length ? '' : `（其中 ${levels.length - withId} 个只有名称，标识需沿关卡链取得）`}。`
      );
    }
    return levels;
  }

  /**
   * 「进入关卡」控件的文案。
   * 实测三种页面各不相同：章页卡片是「开始学习」、作业详情页是「开启挑战」、实训页是「继续挑战」。
   */
  static get ENTRY_BUTTON_TEXTS() {
    return [
      '开启挑战',
      '继续挑战',
      '开始挑战',
      '继续学习',
      '开始学习',
      '查看实战',
      '开始实战',
      '进入实训',
      '进入实验',
      '开始实训'
    ];
  }

  /**
   * 从 URL 里读出作业号，用于校验「进的是不是目标实验」。
   * 支持三种形态：
   * - `/tasks/{课程码}/{作业号}/{关卡标识}`（三段式）
   * - `/tasks/{关卡标识}?homework_common_id={作业号}`（旧形态）
   * - `/classrooms/{课程码}/shixun_homework/{作业号}/detail?tabs=1`（作业详情页）
   */
  static homeworkIdFromUrl(url) {
    const text = String(url || '');
    const quick = /[?&]homework_common_id=(\d+)/.exec(text)?.[1];
    if (quick) return quick;
    const detail = /\/shixun_homework\/(\d+)(?:\/|$|\?)/.exec(text)?.[1];
    if (detail) return detail;
    const raw = text.match(/\/tasks\/([^/?#]+(?:\/[^/?#]+)*)/)?.[1] || '';
    const segments = raw.split('/').filter(Boolean);
    if (segments.length >= 2 && /^\d+$/.test(segments[segments.length - 2])) return segments[segments.length - 2];
    return '';
  }

  /**
   * 在当前页面上点击「进入关卡」类控件，返回拿到的入口标识。
   *
   * 这是入口解析的关键一步：实训页（`/shixuns/{id}/challenges`）**没有 /tasks/ 链接**，
   * 唯一拿到关卡标识的办法就是点这个按钮——它会开一个新标签页
   * （如 `/tasks/zqf25f66/88000009/8fwqp6i5g3bm`，最后一段才是关卡标识），
   * 同时页面会发 `shixun_exec.json`（响应里的 `game_identifier` 就是标识）。
   *
   * 早期只找「开始学习」这一个文案，而这些实训页用的是「继续挑战」，
   * 结果按钮从没被点到，入口恒为空、整门课被跳过（实测示例课程A第 1 章）。
   *
   * @returns {{identifier: string, page: import('playwright').Page|null, label: string}}
   */
  /**
   * 在页面内找到「文本等于 target」的元素，向上找到第 hops 层祖先，返回它的元素句柄。
   *
   * 关键：**返回句柄而不是在页面里调 click()**。React 站点的按钮不响应 `element.click()`
   * 派发的合成事件（实测点了不跳转），必须由 Playwright 发真实鼠标事件（`elementHandle.click()`）。
   */
  async locateByText(target, hops = 0) {
    const handle = await this.page
      .evaluateHandle(
        (args) => {
          const { text, up } = args;
          const leaves = [...document.querySelectorAll('*')].filter(
            (node) => node.children.length === 0 && (node.textContent || '').trim() === text
          );
          if (!leaves.length) return null;
          let node = leaves[0];
          for (let i = 0; i < up && node.parentElement; i += 1) node = node.parentElement;
          return node;
        },
        { text: target, up: hops }
      )
      .catch(() => null);
    const element = handle ? await handle.asElement() : null;
    if (!element) {
      if (handle) await handle.dispose().catch(() => {});
      return null;
    }
    return element;
  }

  /**
   * 在页面内找到文案为 labels 之一的控件，返回元素句柄。
   *
   * 匹配方式很关键：只认「**直接文本节点**」等于目标文案的元素。
   * 早期用 `(node.textContent||'').trim() === label` 会把祖先容器的拼接文本也拿去比，
   * 于是匹配到别的元素（实测点到了**上一个页面残留的卡片**，
   * 文案是「提交中<作业名>开始学习<用户名>0」这种整卡文本），点完毫无反应。
   */
  async locateButtonByText(labels, page = this.page) {
    const handle = await page
      .evaluateHandle((list) => {
        const normalize = (value) => String(value || '').replace(/\s+/g, '').trim();
        const wanted = new Set(list.map(normalize));
        const all = [...document.querySelectorAll('button, a, [role="button"], span, div')];
        // ① 最内层节点（直接文本节点）精确命中
        let hit = all.find((node) => {
          const own = [...node.childNodes]
            .filter((child) => child.nodeType === 3)
            .map((child) => child.nodeValue)
            .join('');
          return wanted.has(normalize(own));
        });
        // ② 退而求其次：整个元素文本恰好等于某个文案（说明它内部没有别的文字）
        if (!hit) hit = all.find((node) => wanted.has(normalize(node.textContent)));
        if (!hit) return null;
        let node = hit;
        let hops = 0;
        while (node && node.parentElement && hops < 4) {
          const tag = node.tagName.toLowerCase();
          if (tag === 'button' || tag === 'a' || node.getAttribute('role') === 'button') break;
          node = node.parentElement;
          hops += 1;
        }
        return node || hit;
      }, labels)
      .catch(() => null);
    const element = handle ? await handle.asElement() : null;
    if (!element) {
      if (handle) await handle.dispose().catch(() => {});
      return null;
    }
    return element;
  }

  async clickTextOnPage(page, texts, timeout = 12000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const element = await this.locateButtonByText(texts, page);
      if (element) {
        const label = await element.evaluate((node) => (node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 20)).catch(() => '');
        // 真实鼠标点击：React 组件只认这个（element.click() 不触发合成事件）
        await element.click({ timeout: 5000 }).catch(() => {});
        await element.dispose().catch(() => {});
        return { clicked: true, label, tag: 'element' };
      }
      await this.sleep(400);
    }
    return { clicked: false, reason: '没找到该文案的可点元素' };
  }

  /**
   * 归属判定（纯函数）：这份关卡 payload 是不是目标实验自己的题。
   *
   * 10-11 实测：[8、面向对象分析] 5 个实验的入口全部串到同一个旧任务
   * （/tasks/wafjr3xgmk5b「软件危机」）——URL 里的 homework_common_id 是对的、
   * 任务却是错的，URL 级校验（entryBelongsToExperiment）挡不住，必须在内容级验。
   *
   * 判定：challenge_id 在白名单里 → 通过；不在 → 拒收（清单没读到时跳过校验，
   * 不做没有依据的拒绝）。payload 不带 challenge_id 时退化用关卡名比对。
   */
  static levelOwnership(payload, experiment) {
    const expectedIds = experiment && experiment.expectedChallengeIds;
    if (!expectedIds || !expectedIds.size) {
      return { ok: true, reason: '无白名单（关卡清单没读到），跳过内容校验' };
    }
    const challenge = (payload && payload.challenge) || {};
    const challengeId = String(challenge.id ?? challenge.challenge_id ?? '').trim();
    if (challengeId) {
      return expectedIds.has(challengeId)
        ? { ok: true }
        : { ok: false, reason: `challenge_id=${challengeId} 不在该实验的 ${expectedIds.size} 关清单里` };
    }
    const subject = String(challenge.subject || '').trim();
    const expectedSubjects = (experiment && experiment.expectedSubjects) || new Set();
    if (subject && expectedSubjects.size && !expectedSubjects.has(subject)) {
      return { ok: false, reason: `关卡名「${subject}」不在该实验的关卡清单里` };
    }
    return { ok: true, reason: 'payload 未带 challenge_id，关卡名在清单里，放行' };
  }

  async clickEntryButton(page, experiment) {
    const texts = ExtractEngine.ENTRY_BUTTON_TEXTS;
    const popupPromise = page.waitForEvent('popup', { timeout: 15000 }).catch(() => null);
    const execPromise = experiment.shixunIdentifier
      ? page
        .waitForResponse((response) => response.url().includes(`/shixuns/${experiment.shixunIdentifier}/shixun_exec.json`), {
          timeout: 15000
        })
        .catch(() => null)
      : Promise.resolve(null);
    // 控件可能异步渲染（作业详情页是 SPA 页签）：页面内轮询找文案并直接点击。
    const clicked = await this.clickTextOnPage(page, texts);
    if (!clicked.clicked) {
      this.log(`页面上没有可点的「进入关卡」按钮（${clicked.reason || '未知原因'}）。`, 'warn');
      await popupPromise;
      return { identifier: '', page: null, label: '' };
    }
    this.log(`已点击「${clicked.label}」(${clicked.tag})，等待进入关卡…`);

    const popup = await popupPromise;
    let popupPage = null;
    let identifier = '';
    let landing = '';
    if (popup) {
      await popup.waitForLoadState('domcontentloaded').catch(() => {});
      popupPage = popup;
      landing = popup.url();
      this.log(`实训标签页：${landing}`);
    }

    // **只有落点 URL 里的作业号与目标实验一致时**才认它的关卡标识。
    // 这是本 bug 的核心：`shixun_exec` 可能回放上一个实验的响应（stale），
    // 而落点 URL 里的作业号是页面自己给的，可校验、不会错位。
    const landingHomework = ExtractEngine.homeworkIdFromUrl(landing);
    if (landing && landingHomework === String(experiment.homeworkId)) {
      identifier = ExtractEngine.identifierFromTaskUrl(landing);
      if (identifier) this.log(`从新标签页 URL 取到关卡标识：${identifier}`);
    } else if (landing) {
      this.log(`新标签页（${landing}）的作业号是 ${landingHomework || '未知'}，与目标 ${experiment.homeworkId} 不符，暂不采用。`, 'warn');
    }

    if (!identifier) {
      const execResponse = await execPromise;
      if (execResponse) {
        try {
          const payload = await execResponse.json();
          const candidate = payload?.game_identifier ? String(payload.game_identifier) : '';
          // shixun_exec 可能是上一个实验的陈旧响应：只有当前落点确实属于本实验时才采用
          const landingOk = !landing || ExtractEngine.homeworkIdFromUrl(landing) === String(experiment.homeworkId);
          if (candidate && landingOk) {
            identifier = candidate;
            this.log(`已进入实训，上下文：${identifier}`);
          } else if (candidate) {
            this.log(`忽略不属于本实验的实训上下文：${candidate}`, 'warn');
          }
        } catch {
          /* 响应不可解析时继续看 URL */
        }
      }
    }

    if (!identifier) {
      // 没有新标签页时，页面可能是原地跳转到关卡页（也要校验作业号）
      const currentUrl = popupPage ? popupPage.url() : page.url();
      const fromUrl = ExtractEngine.identifierFromTaskUrl(currentUrl);
      if (fromUrl && this.entryBelongsToExperiment(currentUrl, experiment)) {
        identifier = fromUrl;
        this.log(`从当前页面 URL 取到关卡标识：${fromUrl}`);
      } else if (fromUrl) {
        this.log(`当前页面（${currentUrl}）不是该实验的关卡页，不采用其中的标识 ${fromUrl}。`, 'warn');
      }
    }
    return { identifier, page: popupPage, label: clicked.label || '', url: popup ? popup.url() : page.url() };
  }

  /**
   * 校验拿到的入口是不是「目标实验」的。
   *
   * 两处线索任一可用即可判定：
   * - 三段式 URL `/tasks/{课程码}/{homeworkId}/{关卡标识}` 的第二段是作业 ID；
   * - 旧形态 URL `/tasks/{关卡标识}?homework_common_id={作业ID}` 的查询串里有作业 ID。
   * 与实验的 homeworkId 对不上，说明页面属于**别的实验**（多实验连抓时最常见），
   * 此时绝不能采用它的关卡标识。两条线索都没有时视为「未知」，交给后续关卡链验证。
   */
  entryBelongsToExperiment(url, experiment) {
    const text = String(url || '');
    const expected = experiment.homeworkId === undefined || experiment.homeworkId === null ? '' : String(experiment.homeworkId);
    if (!expected) return true;
    const raw = text.match(/\/tasks\/([^/?#]+(?:\/[^/?#]+)*)/)?.[1] || '';
    const segments = raw.split('/').filter(Boolean);
    if (segments.length >= 2) {
      const homeworkId = segments[segments.length - 2];
      if (/^\d+$/.test(homeworkId)) return homeworkId === expected;
    }
    const fromQuery = /[?&]homework_common_id=(\d+)/.exec(text)?.[1];
    if (fromQuery) return fromQuery === expected;
    return true; // 看不出作业号：不武断拒绝
  }

  /**
   * 在页面内找到目标实验的卡片并点击它的「开始学习」。
   *
   * 为什么不用 Playwright 定位器：`div[class*="listItem"]` 实测会命中**不含卡片文字**的元素
   * （文本在更深的 `<span class="name___CCaOX">` 里），`filter({ hasText })` 得到的是假命中；
   * 而章页在 SPA 里异步渲染，固定等待也可能还没出列表。
   * 这里直接在页面里轮询：按「最内层文本等于实验名」找元素，向上找到含按钮的卡片容器，
   * 再点其中的「开始学习」——一步到位，也避免把元素句柄当定位符用（那不是合法定位符）。
   *
   * @returns {Promise<{clicked: boolean, buttonLabel: string}>}
   */
  async clickExperimentCard(experiment, timeout = 20000) {
    const name = String(experiment.name || '').replace(/^\[[^\]]+\]\s*/, '').trim();
    if (!name) return { clicked: false, buttonLabel: '' };
    const deadline = Date.now() + timeout;
    let lastReason = '页面还没有渲染出实验列表';
    while (Date.now() < deadline) {
      // 实验名在最内层节点里（如 <span class="name___CCaOX">），向上 4 层即卡片容器
      const card = await this.locateByText(name, 4);
      if (card) {
        const label = await card
          .evaluate((node) => (node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 32))
          .catch(() => '');
        // 真实鼠标点击（element.click() 不触发 React 合成事件，实测不会跳转）
        await card.click({ timeout: 8000 }).catch(() => {});
        await card.dispose().catch(() => {});
        return { clicked: true, buttonLabel: label };
      }
      const shallow = await this.locateByText(name, 1);
      if (shallow) {
        lastReason = '找到名字但点不动';
        await shallow.dispose().catch(() => {});
      }
      await this.sleep(500);
    }
    // 轮询失败：把现场打出来（当前 URL + 正文摘要 + 页面上实际可见的实验名），
    // 否则只能靠猜。可见名单是关键——一眼就能对出「目标实验确实不在这个课程页上」。
    const scene = await this.page
      .evaluate(() => {
        // 实验卡片：文字在 CSS Modules 类名的 span 里（如 name___CCaOX），外面套 listItem 容器。
        // 类名带哈希后缀，所以只能按前缀模糊匹配；抓不到也不影响主流程（兜底为空数组）。
        const nodes = document.querySelectorAll(
          'div[class*="listItem"] span[class*="name"], div[class*="listItem"] a[class*="name"]'
        );
        const seen = new Set();
        const visible = [];
        for (const node of nodes) {
          const text = String(node.textContent || '').replace(/\s+/g, ' ').trim();
          if (!text || text.length > 80 || seen.has(text)) continue;
          seen.add(text);
          visible.push(text);
          if (visible.length >= 40) break;
        }
        return {
          url: location.href,
          sample: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 240),
          visible
        };
      })
      .catch(() => ({ url: this.page.url(), sample: '(取不到页面内容)', visible: [] }));
    const visibleText = scene.visible && scene.visible.length
      ? `｜本页可见实验：${scene.visible.join('、')}`
      : '｜本页没扫到任何实验卡片（列表可能没渲染，或页面结构变了）';
    this.log(`章页卡片未找到的现场：${scene.url}｜正文摘要：${scene.sample}${visibleText}`, 'warn');
    return { clicked: false, buttonLabel: '', reason: lastReason };
  }

  async openExperiment(experiment, course) {
    const classroomCode = course?.classroomCode || this.currentCourse?.classroomCode || '';
    const expectedHomework = String(experiment.homeworkId || '');

    // ★ 主路径（10-14 起）：**直接打开作业详情页**。
    // 课程页的实验卡片列表**每页只渲染 20 张**（08-14 实测：机器学习 30 个实验，
    // 第 21~30 个的卡片在列表第 2 页，「卡片轮询 20 秒」永远找不到 → 整批「卡片未找到」）。
    // 而 homeworkId 本来就在实验列表接口里；详情页正是「点卡片」的落点
    // （/shixun_homework/{作业号}/detail?tabs=1），直达它等价、还省一次卡片轮询。
    let enteredPage = null;
    let landing = '';
    let execPromise = Promise.resolve(null);
    let usedCard = false;

    if (classroomCode && expectedHomework) {
      const detailUrl = `https://www.educoder.net/classrooms/${classroomCode}/shixun_homework/${expectedHomework}/detail?tabs=1`;
      await this.navigateTo(this.page, detailUrl);
      await this.page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
      await this.page.waitForTimeout(1500);
      landing = this.page.url();
      if (/\/detail/.test(landing)) {
        this.log(`直接打开作业详情页（绕过会分页的卡片列表）：${landing}`);
      } else {
        // 详情页没开出来（被重定向 / 登录态丢失）→ 退回旧的「章页找卡片」路径
        this.log(`详情页没有打开（当前在 ${landing}），退回章页找卡片的旧路径。`, 'warn');
      }
    }

    if (!/\/detail/.test(landing)) {
      // —— 旧路径：章页 → 卡片轮询 → popup。homeworkId 缺失或详情页打不开时才走。 ——
      usedCard = true;
      // 「分章视图」里的实验不在首页列表上（实测：示例课程A首页只有「7、软件测试」那 20 个，
      // 「1、软件工程初体验」的 9 个不在其中）。所以先打开它所属的章页，再在那一页里找卡片；
      // 否则卡片找不到时只能回落到「页面上第一个开始学习」，会**点到别的实验**。
      if (classroomCode) {
        // 有分类号就打开该章的列表；没有（分类匹配失败）也**必须**打开默认作业列表——
        // 它渲染全部实验的卡片（10-11 探针实测，列表不超过一页时成立）。什么都不打开会让卡片轮询必然失败。
        const chapterUrl = `https://www.educoder.net/classrooms/${classroomCode}/shixun_homework`
          + (experiment.categoryId ? `/${experiment.categoryId}` : '')
          + '?tabs=0';
        await this.navigateTo(this.page, chapterUrl);
        await this.page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
        await this.page.waitForTimeout(1500);
        this.log(`先打开所在章页：${experiment.categoryName || experiment.categoryId || '(全部分类)'}`);
      }
      // 在页面内找到卡片并点它（`clickExperimentCard` 会轮询等待 SPA 渲染完）。
      // 实测：点卡片会**开一个新标签页**到作业详情页，不是原地跳转；
      // 因此 popup 监听必须挂在点击**之前**，并且超时要够长（早期 8 秒的监听会过期 → 漏掉新标签页）。
      const popupPromise = this.page.waitForEvent('popup', { timeout: 25000 }).catch(() => null);
      // 有些实验点卡片后是**直接进关卡页**（如 CNN 那类老实训），此时页面会发 shixun_exec.json，
      // 响应里的 game_identifier 就是入口标识。监听要挂在点击之前。
      const execFragment = experiment.shixunIdentifier
        ? `/shixuns/${experiment.shixunIdentifier}/shixun_exec.json`
        : 'shixun_exec.json';
      execPromise = this.page
        .waitForResponse((response) => response.url().includes(execFragment), { timeout: 25000 })
        .catch(() => null);
      const clicked = await this.clickExperimentCard(experiment);
      if (!clicked.clicked) {
        this.log(`在章页上没找到实验「${experiment.name}」（${clicked.reason || '未知原因'}），无法进入。`, 'warn');
        await popupPromise;
        return this.page;
      }
      this.log(`已点击实验卡片（${clicked.buttonLabel || '开始学习'}），等待进入关卡…`);

      // 真实路径：点卡片 → **作业详情页** `/shixun_homework/{作业号}/detail?tabs=1`
      // → 在详情页点「开启挑战」→ 关卡页 `/tasks/{课程码}/{作业号}/{关卡标识}`。
      // 校验落点作业号是这里的关键：只有它一致才说明进的是目标实验。
      enteredPage = await popupPromise;
      if (enteredPage) {
        await enteredPage.waitForLoadState('domcontentloaded').catch(() => {});
        await enteredPage.waitForTimeout(1000);
      } else {
        await this.page.waitForTimeout(1500);
      }
      landing = enteredPage ? enteredPage.url() : this.page.url();
      this.log(`卡片落点：${landing}`);

      // 卡片可能点错：落点作业号必须与目标一致（直达详情页不存在这个问题，跳过）
      const landingHomework = ExtractEngine.homeworkIdFromUrl(landing);
      if (landingHomework && expectedHomework && landingHomework !== expectedHomework) {
        this.log(
          `落点作业号 ${landingHomework} 与目标 ${expectedHomework} 不符，卡片可能点错了，放弃这次进入。`,
          'warn'
        );
        return this.page;
      }
    }

    // 落在作业详情页时继续点「开启挑战」
    const entryPage = enteredPage || this.page;
    if (/\/detail/.test(landing)) {
      const entered = await this.clickEntryButton(entryPage, experiment).catch((error) => {
        this.log(`在作业详情页点击「开启挑战」失败：${error.message}`, 'warn');
        return { identifier: '', page: null, label: '' };
      });
      // 优先用 clickEntryButton 在页面内解析出的标识（它已按落点作业号校验过）。
      if (entered.identifier) {
        experiment.gameIdentifier = entered.identifier;
        experiment.entryIdentifier = entered.identifier;
        this.log(`入口定位完成：${entered.identifier}`);
      }
      // 落点要以「真正打开的那个页面」为准：点「继续挑战」会再开一个新标签页，
      // 而详情页本身的 URL 一直是 `/detail?tabs=1`（早期这里用 entryPage.url() 取标识，
      // 于是永远取到空串 → gameIdentifier 被清空 → 整个实验被跳过）。
      if (entered.page) {
        if (this.networkLog) this.attachNetworkCapture(entered.page);
        enteredPage = entered.page;
        landing = entered.url || entered.page.url();
      } else {
        landing = entered.url || entryPage.url();
      }
      if (!experiment.gameIdentifier) {
        const fromUrl = ExtractEngine.identifierFromTaskUrl(landing);
        if (fromUrl && this.entryBelongsToExperiment(landing, experiment)) {
          experiment.gameIdentifier = fromUrl;
          this.log(`从落点 URL 取到关卡标识：${fromUrl}`);
        }
      }
    } else {
      // 没落在详情页：可能是直接进了关卡页（如 CNN 那类实训）。
      // 先看落点 URL；落点还停在列表页（URL 里读不出作业号）时，等页面自身的
      // shixun_exec 响应——它由点卡片这个动作触发，是这类实验唯一的入口来源。
      const elseHomework = ExtractEngine.homeworkIdFromUrl(landing);
      const fromUrl = ExtractEngine.identifierFromTaskUrl(landing);
      if (fromUrl && this.entryBelongsToExperiment(landing, experiment)) {
        experiment.gameIdentifier = fromUrl;
        this.log(`从落点 URL 取到关卡标识：${fromUrl}`);
      } else if (!elseHomework || elseHomework === String(experiment.homeworkId)) {
        const execResponse = await execPromise;
        if (execResponse) {
          try {
            const payload = await execResponse.json();
            if (payload?.game_identifier) {
              experiment.gameIdentifier = String(payload.game_identifier);
              this.log(`已进入实训，上下文：${experiment.gameIdentifier}`);
            }
          } catch {
            /* 响应不可解析时留空，由后续流程兜底 */
          }
        }
      }
    }

    // 硬校验：最终落点的作业号必须与目标实验一致，否则宁可跳过也不抓错
    if (experiment.gameIdentifier && !this.entryBelongsToExperiment(landing, experiment)) {
      this.log(
        `入口校验失败：落点是 ${landing}，与目标实验「${experiment.name}」（作业 ${expectedHomework}）不符，已丢弃。`,
        'warn'
      );
      if (enteredPage && enteredPage !== this.page) await enteredPage.close().catch(() => {});
      enteredPage = null;
      delete experiment.gameIdentifier;
      delete experiment.entryIdentifier;
    }
    if (enteredPage) {
      if (this.networkLog) this.attachNetworkCapture(enteredPage);
      return enteredPage;
    }
    // 兜底：没拿到实训上下文时，依次从当前页面 URL、页面链接/页面数据里找关卡标识，
    // 否则入口定位将没有起点可用——入口绝不能只依赖 shixun_exec 的响应。
    // 但必须校验归属：多实验连抓时页面可能还停在上一个实验的关卡页。
    if (!experiment.gameIdentifier) {
      const currentUrl = this.page.url();
      const fromUrl = ExtractEngine.identifierFromTaskUrl(currentUrl);
      if (fromUrl && this.entryBelongsToExperiment(currentUrl, experiment)) {
        experiment.gameIdentifier = fromUrl;
        this.log(`未取到实训上下文，改用当前页面上的关卡标识：${fromUrl}`, 'warn');
      } else if (fromUrl) {
        this.log(`当前页面（${currentUrl}）属于别的实验，不采用其中的关卡标识 ${fromUrl}。`, 'warn');
      }
    }
    if (!experiment.gameIdentifier) {
      // 从页面链接/HTML 里发现关卡标识时也要确认「这页确实是本实验的」：
      // HTML 里常混着导航/其它实验的 /tasks/xxx 标识（实测在 CNN 的关卡页上扫到了 quiz），
      // 旧形态 URL（/tasks/{id}）没有作业号，事后无法判定，只能在取值前拦住。
      const pageUrl = this.page.url();
      const sameExperimentPage = this.entryBelongsToExperiment(pageUrl, experiment);
      if (!sameExperimentPage) {
        this.log(`当前页面（${pageUrl}）不是该实验的页面，跳过从其 DOM 里推断入口。`, 'warn');
      } else {
        const discovered = await this.page
          .evaluate(() => {
            const fromLinks = [...document.querySelectorAll('a[href*="/tasks/"]')]
              .map((a) => {
                // 与主解析保持一致：取 /tasks/ 后的最后一段（三段式 URL 的最后一段才是标识）
                const raw = String(a.getAttribute('href') || '').match(/\/tasks\/([^/?#]+(?:\/[^/?#]+)*)/)?.[1] || '';
                const parts = raw.split('/').filter(Boolean);
                return parts.length ? parts[parts.length - 1] : '';
              })
              .filter(Boolean);
            const html = document.documentElement.outerHTML;
            const fromHtml = [...html.matchAll(/\/tasks\/([a-z0-9]{10,14})\b/g)].map((m) => m[1]);
            return [...new Set([...fromLinks, ...fromHtml])].slice(0, 5);
          })
          .catch(() => []);
        if (discovered.length) {
          experiment.gameIdentifier = discovered[0];
          this.log(`未取到实训上下文，改用页面发现的关卡标识：${discovered.join(', ')}`, 'warn');
        }
      }
    }
    // 点卡片/「开始学习」时若开了新标签页，且校验通过，就直接用它当实验页
    if (enteredPage) {
      if (this.networkLog) this.attachNetworkCapture(enteredPage);
      await enteredPage.waitForTimeout(3000);
      this.log(`实训标签页：${enteredPage.url()}`);
      return enteredPage;
    }
    await this.page.waitForTimeout(3000);
    this.log(`实训页面：${this.page.url()}`);
    const links = await this.page.locator('a[href*="/tasks/"]').count();
    if (links) return this.page;

    // 实训关卡页上没有 /tasks/ 链接（实测 zqa079e5、示例课程A都是这种），
    // 靠点「进入关卡」按钮拿标识；再不行才交给 enterFirstLevel。
    const entered = await this.enterFirstLevel(experiment);
    if (entered.identifier) {
      experiment.entryIdentifier = entered.identifier;
      if (entered.page) return entered.page;
      return this.page;
    }

    // 最后再试一次「进入关卡」按钮（页面可能刚渲染出来）
    const retryPopupPromise = this.page.waitForEvent('popup', { timeout: 8000 }).catch(() => null);
    const retry = await this.clickEntryButton(this.page, experiment).catch(() => ({ identifier: '', page: null }));
    if (retry.identifier && !experiment.gameIdentifier) experiment.gameIdentifier = retry.identifier;
    if (retry.page) {
      if (this.networkLog) this.attachNetworkCapture(retry.page);
      return retry.page;
    }
    const retryPopup = await retryPopupPromise;
    if (retryPopup) {
      await retryPopup.waitForLoadState('domcontentloaded').catch(() => {});
      if (this.networkLog) this.attachNetworkCapture(retryPopup);
      return retryPopup;
    }
    return this.page;
  }

  /**
   * 解析本实验的入口关卡 URL。
   *
   * @param {object} experiment
   * @param {import('playwright').Page} page
   * @param {Array<object>} [levels] **本实验自己的关卡列表**——必须传！
   *   多实验连抓时共享的 `this.discoveredLevels` 停留在最后一个被读取的实验上，
   *   不传的话入口会串到别的实验（10-14 实测整门课全串到「第 1 关 软件危机」）。
   */
  async startPath(experiment, page, levels = null) {
    const links = await page
      .locator('a[href*="/tasks/"]')
      .evaluateAll((anchors) => anchors.map((anchor) => anchor.href))
      .catch(() => []);
    const unique = [...new Set(links.filter(Boolean))];
    if (unique.length) this.log(`实训页发现 ${unique.length} 个关卡链接。`);

    // 入口必须是链首（第 1 关）：resolveEntry 会用 prev_game 回溯确认/纠正。
    const entry = await this.resolveEntry(experiment, unique, levels);
    if (entry.identifier) return this.taskUrl(entry.identifier, experiment);

    // resolveEntry 的候选来自「关卡列表/页面链接/实训上下文」；若都拿不到，
    // openExperiment 里点「查看实战」拿到的入口标识就是最后的依据。
    if (experiment.entryIdentifier) {
      this.log(`入口取自「查看实战」：${experiment.entryIdentifier}`);
      return this.taskUrl(experiment.entryIdentifier, experiment);
    }
    return unique[0] || null;
  }

  taskUrl(identifier, experiment) {
    return `https://www.educoder.net/tasks/${identifier}?homework_common_id=${experiment.homeworkId}&zzud=p8sxailt2`;
  }

  /**
   * 从关卡页面 URL 里取关卡标识（game identifier）。
   *
   * 头歌真实存在两种形态：
   * - `/tasks/{identifier}`                          （旧形态）
   * - `/tasks/{courseCode}/{homeworkId}/{identifier}` （三段式，实测 zqa079e5 用这种）
   * **三段式里第一段是课程码、第二段是作业 ID，只有最后一段才是关卡标识**。
   * 早期只取 `/tasks/([^/?#]+)` 会得到课程码，导致后续接口全部 404。
   */
  static identifierFromTaskUrl(url) {
    const match = String(url || '').match(/\/tasks\/([^/?#]+(?:\/[^/?#]+)*)/);
    if (!match) return '';
    const segments = match[1].split('/').filter(Boolean);
    return segments.length ? segments[segments.length - 1] : '';
  }

  /**
   * 点击「查看实战」进入第一个关卡，返回 { identifier, page }。
   * 实训关卡页上没有 /tasks/ 链接时，这是拿到入口关卡标识的唯一途径。
   */
  async openFirstLevelFromShixunPage(shixunIdentifier, experiment) {
    // 用 locator('text=…') 而不是 getByText()：两者等价，但前者在测试桩里更通用，
    // 且不会因为桩缺少某个便捷方法就抛错中断整条抓取链。
    const control = this.page.locator('text=查看实战').first();
    if (!(await control.count().catch(() => 0))) return { identifier: '', page: null };

    this.log('实训页没有关卡链接，尝试点击「查看实战」进入第一个关卡。');
    const popupPromise = this.context
      ? this.context.waitForEvent('page', { timeout: 15000 }).catch(() => null)
      : Promise.resolve(null);
    const responsePromise = this.page
      .waitForResponse((response) => response.url().includes(`/shixuns/${shixunIdentifier}/shixun_exec.json`), {
        timeout: 15000
      })
      .catch(() => null);

    await control.click({ force: true }).catch((error) => {
      this.log(`点击「查看实战」失败：${error.message}`, 'warn');
    });

    const popup = await popupPromise;
    const response = await responsePromise;
    const target = popup || this.page;

    // 标识来源优先级：URL 最后一段 → shixun_exec 响应
    let identifier = ExtractEngine.identifierFromTaskUrl(target.url());
    if (!identifier && response) {
      try {
        const payload = await response.json();
        identifier = payload.game_identifier || payload.game?.identifier || '';
      } catch {
        identifier = '';
      }
    }
    await target.waitForLoadState('domcontentloaded').catch(() => {});
    await this.sleep(1500);

    if (identifier) {
      this.log(`已通过「查看实战」进入关卡：${identifier}`);
      if (this.networkLog) this.attachNetworkCapture(target);
    } else {
      this.log('「查看实战」未能拿到关卡标识。', 'warn');
    }
    return { identifier, page: popup ? popup : null };
  }

  /**
   * 实训关卡页没有 /tasks/ 链接时的完整入口流程：
   * 点「查看实战」拿到任意一关的标识 → 沿 `prev_game` 回溯到链首（第 1 关）。
   *
   * 「查看实战」进入的**不是第 1 关**（实测 zqa079e5 进的是第 2 关），
   * 因此必须再回溯一次，否则会丢掉前面的关卡。
   */
  async enterFirstLevel(experiment, course) {
    const entered = await this.openFirstLevelFromShixunPage(experiment.shixunIdentifier, experiment);
    if (!entered.identifier) return { identifier: '', page: entered.page };

    const workPage = entered.page || this.page;
    // 从三段式 URL 反推 homeworkId（/tasks/{courseCode}/{homeworkId}/{identifier}）
    const urlMatch = workPage.url().match(/\/tasks\/[^/?#]+\/([^/?#]+)\//);
    const homeworkId = urlMatch ? urlMatch[1] : experiment.homeworkId;
    if (homeworkId) experiment.homeworkId = homeworkId;

    const start = await this.findChainStart(entered.identifier, experiment);
    if (start.exact) {
      this.log(`「查看实战」入口回溯到第${start.index ?? '?'}关 ${start.subject || ''}（${start.identifier}）`);
      return { identifier: start.identifier, index: start.index, page: entered.page, exact: true };
    }
    this.log('从「查看实战」入口回溯未到达链首，将直接从该关卡开始。', 'warn');
    return { identifier: entered.identifier, page: entered.page, exact: false };
  }

  /**
   * 取单个关卡数据。
   *
   * 直接调 data 接口即可：请求现在带签名头（见 educoder-sign），
   * 不再需要「导航页面 → 等页面自己发请求 → 截获响应」那套绕行。
   */
  async fetchTask(page, gameIdentifier, experiment) {
    const user = this.user || api.AUTH_USER;
    const url = 'https://data.educoder.net/api/tasks/'
      + `${gameIdentifier}.json?homework_common_id=${experiment.homeworkId}`
      + `&zzud=${encodeURIComponent(user)}`;
    const response = await api.apiGet(page, url);
    const verdict = api.classifyResponse(response.status, response.text);
    if (!verdict.ok) throw new api.ApiError(`读取关卡接口失败：${verdict.reason}`, { status: response.status });
    const payload = response.json();
    // 不判 `status` 的取值：真实响应里它可能是字符串（带 homework_common_id 时实测为
    // "required"），而数据本身完全可用。直接看有没有关卡本体才可靠。
    if (!payload || typeof payload !== 'object' || !payload.challenge) {
      const detail = payload && payload.message ? `（${payload.message}）` : '';
      throw new api.ApiError(`关卡响应缺少 challenge 字段，无法解析：${gameIdentifier}${detail}`);
    }
    return payload;
  }

  /**
   * 取关卡的初始代码（rep_content.json）。
   *
   * 必须走**带签名**的 `apiGet`：这个接口和其他接口一样会拒绝无签名请求（-102）。
   * 早先用 `page.request.get` 直接请求，永远拿不到内容，只能靠「重载页面、等页面自己
   * 去请求」兜底——那只在当前页面恰好停在被抓关卡时才命中，实测结果是**每个实验最多
   * 只有一关有初始代码**（编程风格只有第 5 关、单元测试只有第 2 关、结构化分析工具只有第 1 关）。
   *
   * 注意返回的是**用户仓库里那份文件**：没提交过的关卡是题目模板（即初始代码），
   * 已提交的关卡就是用户提交的代码（对已通过的关卡来说，这份内容就是答案，见 captureAnswer）。
   */
  async attachStarterCode(page, task, payload, experiment, gameIdentifier) {
    const filePath = String(payload.challenge?.path || '').replace(/[；;]/g, '').trim();
    if (!filePath || !payload.challenge?.with_code_file) return task;
    const user = this.user || api.AUTH_USER;
    const url = 'https://data.educoder.net/api/tasks/'
      + `${gameIdentifier}/rep_content.json?path=${encodeURIComponent(filePath)}`
      + `&homework_common_id=${experiment.homeworkId}&exercise_id=&zzud=${encodeURIComponent(user)}`;
    try {
      const response = await api.apiGet(page, url);
      const encoded = response.json()?.content?.content;
      if (encoded) task.starterCode = Buffer.from(encoded, 'base64').toString('utf8');
      else this.log(`关卡文件内容为空（${filePath}）：${gameIdentifier}`, 'warn');
    } catch (error) {
      // 取不到不中断抓取（题干与题型仍然可用），但必须说出来——
      // 否则用户只会看到 md 里没有「初始代码」，无从判断是题目本来就没有还是抓取失败。
      this.log(`初始代码获取失败（${filePath}）：${error.message}`, 'warn');
    }
    return task;
  }

  /**
   * 关卡「已通过测评」时，把提交的代码 / 所选项当作答案导出到
   * `exports/answers/{课程}__{实验}.answers.json`（格式见 docs/AI-ANSWER-FORMAT.md）。
   *
   * 为什么放在抓取链路上：判据（满分/得分、选择题所选项）都在本次已经取到的 payload 里，
   * 代码内容也已经在 attachStarterCode 里取过一次（已提交的关卡，那份内容就是提交的代码），
   * 因此不需要额外开页面、也不需要重新提交一次。
   */
  async captureAnswer(task, payload, course, experiment) {
    const levelIdValue = levelId(task);
    // captureLevel 里传进来的是 Course / Experiment **对象**（`.name`），
    // 而答案文件路径要的是名字——这里统一归一，避免写出 `[object Object]__…`。
    const courseName = String(task?.course || (typeof course === 'string' ? course : course?.name) || '');
    const experimentName = String(task?.experiment || (typeof experiment === 'string' ? experiment : experiment?.name) || '');
    const { kind } = classifyTask(task);
    if (kind !== KINDS.CODE && kind !== KINDS.CHOICE) return { ok: false, skipped: '不是可作答题型' };
    if (!levelPassed(payload)) return { ok: false, skipped: '未通过测评' };
    const answer = kind === KINDS.CHOICE ? choiceAnswerText(payload) : String(task.starterCode || '');
    if (!answer.trim()) {
      this.log(`关卡已通过测评但取不到答案内容（${levelIdValue}）：选择题所选项为空，或关卡文件内容没取到`, 'warn');
      return { ok: false, skipped: '答案内容为空' };
    }
    const saved = await mergeAnswer({
      exportRoot: this.exportRoot,
      // v2：班级带课堂码（名称会重名，码不会），答案目录按班级分。
      classroom: {
        name: courseName,
        code: task.classroomCode || (typeof course === 'object' ? course?.classroomCode : '') || ''
      },
      experiment: {
        name: experimentName,
        homeworkId: task.experimentHomeworkId
          || (typeof experiment === 'object' ? experiment?.homeworkId : 0)
      },
      levelId: levelIdValue,
      kind,
      language: task.codeLanguage,
      answer,
      // 平台关卡标识：答案与关卡之间最稳的对应关系（关卡号 L001 只是文件内的序号）。
      taskIdentifier: ExtractEngine.identifierFromTaskUrl(task.source),
      title: task.title,
      source: 'export'
    });
    if (saved.ok) {
      const where = `answers/${path.basename(saved.answerPath)}`;
      // 内容没变时不写盘（mergeAnswer 幂等），日志也要说清"没重写"——
      // 否则重跑同一门课时满屏「已导出答案」，看起来像把整门课又抓了一遍。
      this.log(
        saved.changed === false
          ? `答案已是最新，未重写：${levelIdValue}（${where}）`
          : `已导出答案（已通过测评）：${levelIdValue} → ${where}（${kind === KINDS.CHOICE ? '选项' : '代码'}）`
      );
    } else {
      this.log(`答案导出失败（${levelIdValue}）：${saved.error}`, 'warn');
    }
    return saved;
  }

  async attachImages(page, task) {
    const sources = collectImageSources(task);
    task.images = [];
    task.imageMap = {};
    for (const [index, source] of sources.entries()) {
      const url = new URL(source, 'https://www.educoder.net').href;
      const result = await page
        .evaluate(async (target) => {
          try {
            const response = await fetch(target, { credentials: 'include' });
            if (!response.ok) return { error: `HTTP ${response.status}` };
            const buffer = await response.arrayBuffer();
            let binary = '';
            for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
            return {
              base64: btoa(binary),
              contentType: response.headers.get('content-type') || 'image/png'
            };
          } catch (error) {
            return { error: error.message };
          }
        }, url)
        .catch((error) => ({ error: error.message }));
      if (!result.base64) {
        this.log(`图片下载失败，保留远程地址：${url} (${result.error || 'unknown'})`, 'warn');
        task.imageMap[source] = url;
        continue;
      }
      const extension = detectImageExtension(result.contentType, result.base64);
      if (!extension) {
        // 拿回来的不是图片（实测是 `{"status":-1,"message":"文件不存在"}` 这类错误 JSON）。
        // 绝不能落盘成假图片文件——早期会存成 41 字节的 `.bin`，md 里还引用它，打开就是坏的。
        const peek = Buffer.from(result.base64.slice(0, 32), 'base64').toString('utf8').slice(0, 60).replace(/\s+/g, ' ');
        this.log(`图片内容不是图片（返回 ${peek}），已放弃并保留远程地址：${url}`, 'warn');
        task.imageMap[source] = url;
        continue;
      }
      // 文件名带关卡号：同一个实验文件里所有关卡的图片共用 assets\，不带前缀会互相覆盖。
      const levelTag = Number(task.taskIndex) > 0 ? `L${String(task.taskIndex).padStart(3, '0')}-` : '';
      const filename = `${levelTag}image-${index + 1}.${extension}`;
      task.images.push({ filename, base64: result.base64 });
      // 默认引用落盘的 assets\ 文件；`EDUCODER_INLINE_IMAGES=1` 时把图片以 data URI
      // 直接内嵌进 md——本地相对路径别的 AI 读不到，data URI 才能被多模态模型看见。
      // 代价是 md 体积随图片线性膨胀，且文本模型用不上，所以默认关、显式开启。
      const mime = extension === 'jpg' ? 'image/jpeg'
        : extension === 'svg' ? 'image/svg+xml'
          : `image/${extension}`;
      task.imageMap[source] = process.env.EDUCODER_INLINE_IMAGES
        ? `data:${mime};base64,${result.base64}`
        : `assets/${filename}`;
    }
  }

  /** 某个实验的落盘位置：exports\课程\实验\ + levels.jsonl / 实验.md / metadata / assets。 */
  experimentPaths(courseName, experimentName) {
    const directory = path.join(this.exportRoot, safeName(courseName), safeName(experimentName));
    const fileBase = safeName(experimentName) || 'untitled';
    return {
      directory,
      archivePath: path.join(directory, ARCHIVE_NAME),
      markdownPath: path.join(directory, `${fileBase}.md`),
      metadataPath: path.join(directory, `${fileBase}.metadata.json`),
      assetsDir: path.join(directory, 'assets')
    };
  }

  /**
   * 关卡内容指纹：题目正文/要求/初始代码/选项/图片任一变化都会变。
   * 用来决定「已存在的关卡」是否可以安全跳过——内容变了就必须重新写入。
   */
  taskContentHash(task) {
    const payload = {
      title: task.title || '',
      type: task.type || '',
      source: task.source || '',
      taskIndex: Number(task.taskIndex) || 0,
      taskDescription: task.taskDescription || '',
      programmingRequirements: task.programmingRequirements || '',
      testDescription: task.testDescription || '',
      extraRequirements: task.extraRequirements || '',
      starterCode: task.starterCode || '',
      codeLanguage: task.codeLanguage || '',
      choices: task.choices || [],
      choiceQuestions: task.choiceQuestions || [],
      imageMap: task.imageMap || {}
    };
    return crypto.createHash('sha1').update(JSON.stringify(payload)).digest('hex');
  }

  /**
   * 把某个实验的「视图」由存档重建并落盘：
   * `实验.md`（AI/人读）、`实验.metadata.json`（结构化）。
   *
   * 只在「该实验的关卡全部处理完」或整轮结束时调用一次——抓取过程中不再碰这两个文件，
   * 因此没有 N² 写放大，也不会在中途留下半截文档。
   */
  async writeExperimentViews(courseName, experimentName) {
    const { directory, markdownPath, metadataPath } = this.experimentPaths(courseName, experimentName);
    const entry = this.experimentLevels.get(markdownPath);
    if (!entry) return null;
    const levels = entry.levels.slice().sort((a, b) => (Number(a.taskIndex) || 0) - (Number(b.taskIndex) || 0));
    if (!levels.length) return null;

    const sections = levels
      .map((level) => (level.reused && level.section ? level.section : makeLevelSection(level)))
      .filter(Boolean);
    const generatedAt = new Date().toISOString();
    const document = makeExperimentDocument({
      course: courseName,
      experiment: experimentName,
      generatedAt,
      levels: sections
    });
    const metadata = {
      course: courseName,
      experiment: experimentName,
      generatedAt,
      levelCount: levels.length,
      kinds: {
        code: levels.filter((level) => level.type === 'code').length,
        choice: levels.filter((level) => level.type === 'choice').length
      },
      levels
    };
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(markdownPath, document, 'utf8');
    await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2), 'utf8');
    entry.dirty = false;
    return { markdownPath, metadataPath, levelCount: levels.length };
  }

  /** 把本轮碰过的实验视图全部重建（整轮结束时调用）。 */
  async flushExperimentViews() {
    // 只提取答案模式不生成任何题目视图（实验.md / metadata）。
    if (this.answersOnly) return;
    const written = [];
    for (const [, entry] of this.experimentLevels) {
      if (!entry.dirty) continue;
      const result = await this.writeExperimentViews(entry.course, entry.experiment).catch((error) => {
        this.log(`生成实验文件失败（${entry.experiment}）：${error.message}`, 'error');
        return null;
      });
      if (result) written.push(result);
    }
    return written;
  }

  /**
   * 读取（并按实验缓存）关卡存档索引：一个实验只读一次存档文件。
   * 复用快路径与落盘路径共用，两处的「已存在」判断因此看的是同一份数据。
   */
  async experimentEntry(course, experiment) {
    // 入参可能是 Course / Experiment 对象（captureLevel 传的是对象），也可能是名字：
    // 统一归一成名字再算路径——否则会得到 `[object Object]` 目录、永远找不到存档。
    const courseName = typeof course === 'string' ? course : String(course?.name || '');
    const experimentName = typeof experiment === 'string' ? experiment : String(experiment?.name || '');
    const { archivePath, markdownPath } = this.experimentPaths(courseName, experimentName);
    const cached = this.experimentLevels.get(markdownPath);
    if (cached) return cached;
    const archive = await readArchive(archivePath);
    const entry = {
      course: courseName,
      experiment: experimentName,
      levels: orderedLevels(archive.records),
      index: archive.index,
      dirty: false
    };
    if (archive.broken) {
      this.log(`存档里有 ${archive.broken} 行无法解析（可能是中断留下的半截行），已忽略。`, 'warn');
    }
    this.experimentLevels.set(markdownPath, entry);
    return entry;
  }

  /**
   * 「跳过清单」：本地已有的关卡序号集合（供选择界面在全选时自动排除）。
   *
   * 两条判据，满足其一即算「本地已有」：
   * ① **存档**（`levels.jsonl`）里已有该关 —— 之前抓过；就算重抓，复用快路径也会跳过它，
   *    但每个实验仍要白走一遍关卡链（每关一次 tasks.json），不如一开始就不勾；
   * ② **答案文件**里已有该关的可用答案（选择题有选项 / 编程题有代码）——
   *    不管答案是抓取导出的、AI 作答写的还是篡改猴回传的，都在同一份文件里。
   *
   * 判据刻意**宽松**（只看「有没有」，不比对内容指纹）：内容变没变由复用快路径
   * 的 contentHash 把关；这里只负责让「全选」默认避开已完成的部分。
   *
   * @returns {Promise<{archived: Set<number>, answered: Set<number>}>} 键是关卡序号（1 起）
   */
  async localDoneIndex(course, experiment) {
    const courseName = typeof course === 'string' ? course : String(course?.name || '');
    const experimentName = typeof experiment === 'string' ? experiment : String(experiment?.name || '');
    const entry = await this.experimentEntry(courseName, experimentName);
    const archived = new Set();
    for (const key of entry.index.keys()) {
      const value = Number(key);
      if (Number.isFinite(value) && value > 0) archived.add(value);
    }
    const answered = new Set();
    try {
      const loaded = await loadAnswerDocument(this.exportRoot, {
        name: courseName,
        code: typeof course === 'object' ? String(course?.classroomCode || '') : ''
      }, { name: experimentName });
      for (const item of (loaded?.document?.answers || [])) {
        const match = /^L(\d{3})$/.exec(String(item?.level_id || ''));
        if (!match) continue;
        // normalizeDocument 产出的条目是**扁平**结构（questions / code 直接在条目上）；
        // 磁盘 v2 落盘结构是嵌套的（answer.questions / answer.code）。两种都认，
        // 以防某个调用方绕过 normalize 直接给了原始文档。
        const questions = Array.isArray(item.questions)
          ? item.questions
          : Array.isArray(item.answer?.questions) ? item.answer.questions : null;
        const code = String(item.code ?? item.answer?.code ?? '');
        const has = item.kind === 'choice'
          ? Boolean(questions && questions.length > 0)
          : code.trim().length > 0;
        if (has) answered.add(Number(match[1]));
      }
    } catch (error) {
      // 答案文件读不了不算失败：跳过清单退化为「只按存档判断」
      this.log(`答案文件读取失败（跳过清单只按本地存档判断）：${error.message}`, 'warn');
    }
    return { archived, answered };
  }

  /** 「该关已存在且内容未变」的统一口径：计数 + reused 事件 + 日志 + 进度。 */
  emitReused(task, existingLevel) {
    const { directory, archivePath } = this.experimentPaths(task.course, task.experiment);
    this.stats.existing = (this.stats.existing || 0) + 1;
    this.emit({
      type: 'reused',
      status: 'reused',
      path: archivePath,
      directory,
      title: existingLevel?.title || task.title,
      level: existingLevel?.level || task.level,
      taskType: existingLevel?.type || task.type,
      reason: '存档里已有该关卡的相同内容，未重复抓取'
    });
    this.log(`已存在且内容未变，跳过：${task.level}`);
    this.progress({ levelName: task.level, levelType: task.type });
  }

  /**
   * 落盘一关：**只往 `levels.jsonl` 追加一行**（一次写入），不再读回/重写整个实验文档。
   *
   * - 存档：`exports\课程\实验\levels.jsonl`，同关卡号再次捕获时追加新行，读取时最后一行生效；
   * - 图片：`assets\L00N-image-N.ext`（文件名带关卡号，同实验内不撞名）；
   * - 视图（md/metadata）由 `writeExperimentViews` 在整轮结束时统一生成。
   */
  async saveExperimentLevel(task) {
    const { directory, archivePath, assetsDir } = this.experimentPaths(task.course, task.experiment);
    await fs.mkdir(directory, { recursive: true });

    const markdownPath = this.experimentPaths(task.course, task.experiment).markdownPath;
    let entry = this.experimentLevels.get(markdownPath);
    if (!entry) {
      // 每个实验只在第一次落盘时读一次存档（不是每关读一次），之后全部走内存索引。
      entry = await this.experimentEntry(task.course, task.experiment);
      this.experimentLevels.set(markdownPath, entry);
    }

    const index = Number(task.taskIndex) || 0;
    const existingLevel = entry.index.get(index);
    const contentHash = this.taskContentHash(task);
    // 已存在判断：同一关内容指纹一致就跳过，不重抓也不重复追加。
    if (this.skipExisting && existingLevel && existingLevel.contentHash === contentHash) {
      this.emitReused(task, existingLevel);
      return false;
    }
    if (existingLevel) {
      this.log(`本地该关卡内容与线上不一致，已更新：${task.level}`, 'warn');
    }

    // 图片必须在落存档前写好：视图里的相对路径要指向真实文件。
    if (task.images?.length) {
      await fs.mkdir(assetsDir, { recursive: true });
      for (const image of task.images) {
        await fs.writeFile(path.join(assetsDir, image.filename), Buffer.from(image.base64, 'base64'));
      }
    }

    const record = toArchiveRecord(task, contentHash);
    await appendLevel(archivePath, record); // ★ 每关只有这一次写
    entry.index.set(index, record);
    const position = entry.levels.findIndex((level) => Number(level.taskIndex) === index);
    if (position >= 0) entry.levels[position] = record;
    else entry.levels.push(record);
    entry.dirty = true;

    this.stats.saved += 1;
    this.emit({
      type: 'saved',
      path: archivePath,
      directory,
      archivePath,
      title: task.title,
      taskType: task.type,
      level: task.level,
      levelCount: entry.levels.length,
      images: (task.images || []).length
    });
    this.progress({ levelName: task.level, levelType: task.type });
    return true;
  }

  async saveTask(task) {
    const verdict = classifyTask(task);
    // 题型白名单：只保留编程题与选择题；其余（虚拟机、图形化、纯问答等）一律抛弃。
    if (verdict.kind === KINDS.REJECTED) {
      this.stats.skipped += 1;
      this.stats.dropped = (this.stats.dropped || 0) + 1;
      this.emit({
        type: 'dropped',
        source: task.source,
        title: task.title,
        level: task.level,
        reason: verdict.reason
      });
      this.log(`抛弃非编程题/选择题的关卡：${task.title || task.source}（${verdict.reason}）`, 'warn');
      this.progress({ levelName: task.level, levelType: task.type });
      return false;
    }
    return this.saveExperimentLevel(task);
  }

  /**
   * 「页面已经不可用」类错误（渲染进程崩溃 / 标签页被关）：值得重开一次实验页再继续。
   * 实测形态：`请求失败：https://data.educoder.net/api/tasks/xxx.json（page.evaluate: Target crashed）`。
   */
  static isPageGoneError(error) {
    return /Target crashed|Target closed|has been closed|page has been closed/i.test(String((error && error.message) || ''));
  }

  async captureLevel(page, gameIdentifier, experiment, course, prefetched = null) {
    const user = this.user || api.AUTH_USER;
    const taskUrl = 'https://www.educoder.net/tasks/'
      + `${gameIdentifier}?homework_common_id=${experiment.homeworkId}&zzud=${encodeURIComponent(user)}`;
    // 直接取接口：不再「先挂监听再导航、等页面自己发请求」，也不再 sleep。
    // 每关少一次完整页面导航，关卡多的实验是数量级的差别，也彻底不依赖页面结构。
    const payload = prefetched || await this.fetchTask(page, gameIdentifier, experiment);
    // ★ 归属校验（写任何东西之前）：这一关必须是当前实验自己的题。
    // 拒收时返回 null 终止整条链——链已经串到别的实训了，继续走只会产出更多错数据。
    const ownership = ExtractEngine.levelOwnership(payload, experiment);
    if (!ownership.ok) {
      this.log(
        `串台防护：实验「${experiment.name}」抓到的关卡不属于它（${ownership.reason}）`
        + '——入口串到了别的实训，本实验已放弃，不写入任何数据。'
        + '常见原因：该实验是图形化/虚拟机题（StarUML 等）且本机从未打开过它，'
        + '「查看实战」落点解析失败。可先在头歌网页里打开一次该实验再重抓。',
        'error'
      );
      this.stats.rejected = (this.stats.rejected || 0) + 1;
      return null;
    }
    const task = taskFromApi(payload, course, experiment, taskUrl);
    // 记录当前关卡的序号与主题：无标识的关卡列表靠序号做选择过滤与进度显示。
    this.currentLevelPosition = payload?.challenge?.homework_challenge_index ?? null;
    this.currentLevelSubject = payload?.challenge?.subject || '';
    await this.attachStarterCode(page, task, payload, experiment, gameIdentifier);

    // 只提取答案：链路照跑（答案判据与内容都在这份 payload 里），但不写任何题目存档。
    // 复用快路径在这里没有意义（不写存档，也就无所谓「复用」），image/md 一律跳过。
    if (this.answersOnly) {
      const result = await this.captureAnswer(task, payload, course, experiment);
      if (result && result.ok) {
        if (result.changed === false) {
          this.stats.existing = (this.stats.existing || 0) + 1;
        } else {
          this.stats.saved += 1;
        }
        this.emit({
          // 复用既有事件类型（前端白名单/「已提取内容」面板零改动即可正确归组）：
          // changed === false 表示答案本来就是最新的（未重写盘），与正常抓取的「复用」同口径。
          type: result.changed === false ? 'reused' : 'saved',
          status: result.changed === false ? 'reused' : 'saved',
          path: path.relative(this.exportRoot, result.answerPath || ''),
          directory: path.dirname(result.answerPath || ''),
          title: task.title,
          taskType: '答案',
          level: task.level,
          levelCount: 0,
          images: 0
        });
      } else if (result && result.skipped) {
        this.stats.skipped += 1;
        this.log(`只提取答案：${levelId(task)} ${result.skipped}`);
      } else {
        this.stats.failed += 1;
        this.log(`只提取答案失败（${levelId(task)}）：${(result && result.error) || '未知原因'}`, 'warn');
      }
      this.progress({ levelName: task.level, levelType: task.type });
      return payload.next_game || null;
    }

    // 复用快路径：正文（含文件内容）与图片清单都没变的关卡，**不重新下载图片、不追加存档**。
    // 以前只有「落盘时」才比对指纹，重跑同一门课时每关仍会重下图片、重写答案文件、
    // 日志里一路「已导出答案」——整体看起来就像又把整门课抓了一遍。
    const reusable = await this.findReusableLevel(task, course, experiment);
    if (reusable) {
      // 答案仍走一遍导出：落盘是幂等的（内容没变不写盘），但答案文件被删掉时能补回来。
      await this.captureAnswer(task, payload, course, experiment);
      this.emitReused(task, reusable);
      return payload.next_game || null;
    }

    // 已通过测评的关卡顺手导出答案（提交的代码/选项）——判据与内容都在这条链路上，
    // 不加这一步的话，用户就得为了拿答案再打开页面、重新提交一遍。
    await this.captureAnswer(task, payload, course, experiment);
    await this.attachImages(page, task);
    await this.saveTask(task);
    // 关卡链必须用 next_game 正向遍历：入口（第 1 关）的 prev_game 为 null、
    // 只有末关的 next_game 才是 null。用 prev_game 会在第一关就终止，只能抓到 1 关。
    return payload.next_game || null;
  }

  /**
   * 复用判定（快路径）：本地存档里同一关的内容指纹一致时返回存档记录，否则 null。
   *
   * 指纹用**存档里的图片映射**来算：图片文件名按关卡序号与出现顺序确定性生成，
   * 只要正文里的图片清单没变，重算出的映射就与存档一致——于是不必为了比对指纹
   * 先把图片重新下载一遍（重跑同一门课时这是最没意义的流量）。
   * 图片文件在磁盘上丢了则不算复用，走完整流程补回来。
   */
  async findReusableLevel(task, course, experiment) {
    if (!this.skipExisting) return null;
    // captureLevel 传进来的是对象；experimentPaths / 存档都要名字。以 task 上已归一好的名字为准。
    const courseName = String(task?.course || (typeof course === 'string' ? course : course?.name) || '');
    const experimentName = String(task?.experiment || (typeof experiment === 'string' ? experiment : experiment?.name) || '');
    const entry = await this.experimentEntry(courseName, experimentName);
    const existing = entry.index.get(Number(task.taskIndex) || 0);
    if (!existing || !existing.contentHash) return null;
    const sources = collectImageSources(task);
    const archivedSources = Object.keys(existing.imageMap || {});
    const sameImages = sources.length === archivedSources.length
      && sources.every((source, index) => source === archivedSources[index]);
    if (!sameImages) return null;
    if (archivedSources.length) {
      // imageMap 的值是**相对实验目录**的路径（形如 `assets/L001-image-1.png`），
      // 不能再去 join assetsDir，否则会拼成 assets/assets/…。
      const { directory } = this.experimentPaths(courseName, experimentName);
      for (const source of archivedSources) {
        const file = String(existing.imageMap[source] || '');
        if (!file || file.startsWith('data:')) continue;
        try {
          await fs.access(path.join(directory, file));
        } catch {
          return null; // 图片文件不在了：不复用，让完整流程重新下载
        }
      }
    }
    const hash = this.taskContentHash({ ...task, imageMap: existing.imageMap || {} });
    return hash === existing.contentHash ? existing : null;
  }

  /**
   * 多实验时的统一关卡选择。
   *
   * 逐个实验串行询问会让用户以为「关卡列表不完整」——选了 N 个实验却只看到第 1 个
   * 实验的关卡，其余要等第 1 个抓完才出现。这里改为：先把所有选中实验的关卡列表
   * 全部读出来、合并成一份（每条带所属实验）交给界面**一次选完**，再统一开抓。
   */
  async selectLevelsForAll(experiments) {
    this.status('levels', `正在读取所选 ${experiments.length} 个实验的关卡列表…`);
    const plans = [];
    const merged = [];
    let stoppedEarly = false;
    for (const experiment of experiments) {
      if (await this.stopping()) {
        stoppedEarly = true;
        break;
      }
      let levels = [];
      try {
        // 关键：不要在这里一个个发 levels 事件（会让界面只剩最后一个实验的关卡）。
        levels = await this.loadLevels(experiment, { emit: false });
      } catch (error) {
        this.log(`实验「${experiment.name}」关卡列表读取失败：${error.message}`, 'warn');
      }
      // 跳过清单：本实验里本地已有的关卡（存档 / 答案）。
      // 读不到不阻塞选择——大不了「全选」时多勾了几关，复用快路径会兜住。
      let local = null;
      try {
        local = await this.localDoneIndex(this.currentCourse, experiment);
      } catch (error) {
        this.log(`实验「${experiment.name}」跳过清单读取失败：${error.message}`, 'warn');
      }
      const planIndex = plans.length;
      plans.push({ experiment, levels, selection: null, selectedIds: null, selectedPositions: null });
      for (const level of levels) {
        // 序号口径与 levelId(task) 一致：taskIndex = 关卡的 homework_challenge_index，
        // 列表里 position 优先（接口给的），其次 index（页面解析的）。
        const index = Number(level?.position ?? level?.index) || 0;
        const archived = local ? local.archived.has(index) : false;
        const answered = local ? local.answered.has(index) : false;
        merged.push({
          ...level,
          experimentName: experiment.name,
          experimentIndex: planIndex,
          localDone: { archived, answered }
        });
      }
    }

    // 跳过清单的总数要让用户看见，否则「全选完怎么少了一截」会像 bug。
    const doneCount = merged.filter((level) => level.localDone && (level.localDone.archived || level.localDone.answered)).length;
    if (doneCount) {
      this.log(
        `跳过清单：${doneCount} 关本地已有（存档或已有答案），「全选」时会自动不勾；要重抓可手动勾上。`
      );
    }

    if (stoppedEarly) {
      // **被停止 ≠ 实验没有关卡列表**。原来两种情况共用同一句
      // 「所选实验都没有返回关卡列表，将按关卡链抓取全部关卡」，于是用户按了停止之后
      // 会看到一句与事实相反的话，还以为实验数据出了问题——真正的原因是他自己按了停止。
      this.log('收到停止请求，已中断关卡列表读取。', 'warn');
      this.mergedLevels = [];
      this.emit({ type: 'levels', levels: [], multi: experiments.length > 1 });
      return null;
    }

    const reachable = plans.filter((plan) => plan.levels.length).length;
    this.log(
      reachable
        ? `已读取 ${reachable} 个实验共 ${merged.length} 个关卡，可一次选择。`
        : '所选实验都没有返回关卡列表，将按关卡链抓取全部关卡。'
    );

    // 合并列表为空（都没列表）时退回「按关卡链抓全部」，不再询问。
    if (!merged.length) {
      this.mergedLevels = [];
      for (const plan of plans) plan.selection = null;
      this.emit({ type: 'levels', levels: [], multi: experiments.length > 1 });
      return plans;
    }

    // 一次性把**合并后的全部关卡**推给界面：每条带所属实验名，界面上标注出来。
    // 这里必须发事件，否则前端 state.levels 还停留在上一个实验的列表。
    this.emit({
      type: 'levels',
      levels: merged,
      multi: experiments.length > 1,
      experimentNames: experiments.map((item) => item.name)
    });

    this.status(
      'waiting-levels',
      `请选择要抓取的关卡：${plans.length} 个实验共 ${merged.length} 关（列表里已标注所属实验）。`
    );
    const chosen = await this.control.waitForAllLevels(merged);
    if (Array.isArray(chosen) && chosen.length === 0) {
      this.log('未选择任何关卡，已结束。', 'warn');
      return null;
    }
    const wanted = new Set(Array.isArray(chosen) && chosen.length ? chosen : merged);
    for (const level of wanted) {
      const owner = plans[level.experimentIndex];
      if (!owner) continue;
      if (!owner.selection) owner.selection = [];
      owner.selection.push(level);
    }
    // 每个实验按「关卡标识」或「序号」建立过滤依据（与单实验路径一致）
    for (const plan of plans) {
      const picked = plan.selection || [];
      plan.selectedIds =
        picked.length && picked.some((level) => level.identifier)
          ? new Set(picked.map((level) => String(level.identifier)))
          : null;
      plan.selectedPositions =
        picked.length && !plan.selectedIds
          ? new Set(picked.map((level) => Number(level.position ?? level.index)).filter(Number.isFinite))
          : null;
    }
    this.mergedLevels = merged;
    // 用户在合并列表里做过选择 → 这一轮只抓「勾选的关卡」。
    // 因此**列表里出现过、却一关都没被勾的实验要整个跳过**：旧的「该实验全不选＝抓全部」语义
    // 在这里是错的，它会把用户根本没勾的实验也整段抓一遍（实测：只勾了 CNN 的 5 关，
    // 却又去抓「模型评估与选择」，而界面上明明写着「开始抓取选中的 5 个关卡」）。
    // 注意只对「关卡确实出现在合并列表里」的实验这么判：连列表都没取到的实验（levels 为空）
    // 保持旧语义按关卡链抓全部——否则用户选了这个实验却什么都拿不到。
    for (const plan of plans) plan.onlySelected = (plan.levels || []).length > 0;
    return plans;
  }

  /**
   * 进入实验前把「上一次实验留下的页面状态」清干净。
   *
   * 为什么必须清：`openExperiment` 的兜底逻辑会从**当前页面 URL** 反推关卡标识。
   * 多实验连抓时页面还停在上一个实验的关卡页，于是本次实验的 `gameIdentifier` 会被写成
   * 上一个实验的入口（实测「白盒测试」「黑盒测试」都拿到了「单元测试」的 cxf3s54bhytu），
   * 结果整条关卡链走错，日志表现为「选中 7 关，但关卡链上只到达 2 关」。
   */
  async prepareExperimentEntry(experiment, course) {
    delete experiment.gameIdentifier;
    // 注意：不能 delete experiment.entryIdentifier —— 它是「查看实战」等路径确认过的入口，
    // 外壳/上一轮可能已经把它标好了，清掉会让入口定位失去起点（有测试锁定该行为）。
    const current = (() => {
      try {
        return this.page?.url?.() || '';
      } catch {
        return '';
      }
    })();
    const shixunId = String(experiment.shixunIdentifier || '');
    // 页面已经在本实验相关的地方（实训关卡页 / 已经在该实验的关卡页）时不要动它：
    // 一导航就会把「查看实战」等路径建立的页面状态冲掉。
    const onOwnShixunPage = shixunId && current.includes(`/shixuns/${shixunId}/`);
    // 关键只在于：页面若停在其他 shixun 的挑战页（多实验连抓时的典型残留），
    // 必须回课堂列表页——否则入口兜底会从 URL 反推，拿到**上一个实验**的关卡标识。
    const onOtherShixunPage = /\/shixuns\/[^/]+\/challenges/.test(current) && !onOwnShixunPage;
    if (!onOtherShixunPage) return;

    const classroomUrl = course?.classroomUrl
      ? course.classroomUrl.replace(/\/announcement$/, '/shixun_homework')
      : course?.classroomCode
        ? `https://www.educoder.net/classrooms/${course.classroomCode}/shixun_homework`
        : '';
    if (!classroomUrl) return;
    this.log(`上一个实验的页面还开着，先回到课堂实验列表页再进入「${experiment.name}」。`);
    await this.navigateTo(this.page, classroomUrl);
    await this.page.waitForLoadState?.('domcontentloaded', { timeout: 15000 }).catch(() => {});
  }

  async runExperiment(experiment, course, plan = null) {
    this.currentExperiment = experiment;
    let levels = [];
    let selected = null;
    if (plan) {
      // 多实验统一步骤：关卡列表与选择范围都已经在外面准备好
      levels = plan.levels || [];
      selected = plan.selection || null;
      // 合并列表里做过选择、但这个实验一关都没被勾 → 跳过它（别再按「全不选＝全部」抓一遍）。
      if (plan.onlySelected && !(selected && selected.length)) {
        this.log(`实验「${experiment.name}」一关都没被勾选，跳过。`);
        this.progress({ experimentName: experiment.name });
        return;
      }
      this.progress({ experimentName: experiment.name });
      if (!levels.length) {
        this.log(`实验「${experiment.name}」未返回关卡列表，将按关卡链抓取全部关卡。`, 'warn');
      }
    } else {
      this.status('levels', `正在读取实验「${experiment.name}」的关卡列表…`);
      levels = await this.loadLevels(experiment);
      this.progress({ experimentName: experiment.name });
      if (levels.length) {
        this.status('waiting-levels', `请选择「${experiment.name}」要抓取的关卡（共 ${levels.length} 关）。`);
        selected = await this.control.waitForLevels(levels);
        if (Array.isArray(selected) && selected.length === 0) {
          this.log(`未选择任何关卡，跳过实验「${experiment.name}」。`, 'warn');
          return;
        }
      } else {
        this.log('未取到关卡列表，将按关卡链抓取全部关卡。', 'warn');
      }
    }
    this.selectedLevels = selected;

    this.status('running', `正在进入实验「${experiment.name}」，首次进入可能需要几十秒…`);
    this.log(`开始进入实验「${experiment.name}」（若实训页没有关卡链接，会自动点「查看实战」并回溯到第 1 关）`);
    // 关键：先回到课堂实验列表页，避免上一个实验的关卡页影响本次入口定位。
    await this.prepareExperimentEntry(experiment, course).catch(() => {});
    let experimentPage = await this.openExperiment(experiment, course);
    // 入口解析必须用**本实验自己的**关卡列表：plan 路径下 loadLevels 是在选关阶段
    // 逐个调的，共享的 discoveredLevels 早已被最后一个实验覆盖（10-14 实测的串台根因）。
    const startUrl = await this.startPath(experiment, experimentPage, levels);
    this.log(`实验「${experiment.name}」入口解析完成`);
    if (!startUrl) {
      this.stats.failed += 1;
      // 这条实验的记录接口里有、但页面上没有入口。最常见的原因按概率排：
      // 未发布（listExperiments 已滤掉大多数，但 status/publish_time 都缺的会漏进来）、
      // 只对其他班级发布（同一课堂多个班，你所在的班不在发布范围）、或已被移出课程。
      this.log(
        `无法定位实验「${experiment.name}」的入口关卡，已跳过——多半是未发布、只对其他班级发布、或已从课程移除（接口里还留着这条记录）。`,
        'error'
      );
      this.progress({ experimentName: experiment.name });
      if (experimentPage !== this.page) await experimentPage.close().catch(() => {});
      return;
    }

    const startIdentifier = ExtractEngine.identifierFromTaskUrl(startUrl) || experiment.gameIdentifier;
    // 选择范围同时支持两种身份：
    // - 有 identifier 的列表 → 按关卡标识过滤；
    // - 只有名称的列表（实测 zqf495e6 等）→ 按序号（position）过滤。
    // 早期只按 identifier 过滤，无标识时会把链上关卡全部跳过；后来改成「空标识即全抓」，
    // 又导致无法选择性跳过。现在两种身份都在，选择性抓取在任何列表形态下都成立。
    // 多实验统一选择时，这两份依据已由 selectLevelsForAll 预先算好。
    const listIds = plan && plan.selectedIds
      ? [...plan.selectedIds]
      : Array.isArray(selected)
        ? selected.map((item) => String(item?.identifier || '')).filter(Boolean)
        : [];
    const listPositions = plan && plan.selectedPositions
      ? [...plan.selectedPositions]
      : Array.isArray(selected)
        ? selected.map((item) => Number(item?.position ?? item?.index)).filter((n) => Number.isFinite(n) && n > 0)
        : [];
    const byId = listIds.length ? new Set(listIds) : null;
    const byPosition = listPositions.length ? new Set(listPositions) : null;
    const wanted = byId || byPosition;
    if (Array.isArray(selected) && selected.length && !byId && byPosition) {
      this.log(`实验「${experiment.name}」的关卡列表没有标识，按序号过滤选中的 ${byPosition.size} 关。`);
    }
    this.currentTotal = wanted ? wanted.size : Math.max(levels.length, experiment.taskCount || 0);
    this.currentIndex = 0;
    // 进度按「用户选中的关卡数」计：total = 选中的关数，current 在每写完一关时自增。
    this.progress({ experimentName: experiment.name, current: 0, total: this.currentTotal });

    const visited = new Set();
    let gameIdentifier = startIdentifier;
    let index = 0;
    let taken = 0; // 已抓取的「选中」关卡数（index 只统计包括未选中在内的链上位置）
    let recovered = false; // 页面崩溃后是否已经重开过一次（只给一次机会，避免死循环）
    // 已抓到的关卡身份：收尾时用来点名「哪几关没抓到」。
    this.__takenIds = new Set();
    this.__takenPositions = new Set();
    // 链首的序号：以真实 payload 为准，下面每一轮都会先读到它再判断是否选中。
    this.currentLevelPosition = null;
    while (gameIdentifier && !visited.has(gameIdentifier)) {
      if (await this.stopping()) break;
      visited.add(gameIdentifier);

      // 序号过滤必须先拿到本关的 payload（序号在 payload 里），因此统一先取数据：
      // captureLevel 内部同样先抓取，这里把「已取到的 payload」传下去避免重复请求。
      let payload = null;
      try {
        payload = await this.fetchTask(experimentPage, gameIdentifier, experiment);
      } catch (error) {
        // 渲染进程崩溃 / 标签页被关掉（实测「page.evaluate: Target crashed」）会让整条关卡链
        // 立刻报废。这种情况重开一次实验页就能继续，比让用户重跑整门课便宜得多。
        if (!recovered && ExtractEngine.isPageGoneError(error)) {
          recovered = true;
          this.log(`页面已不可用（${error.message}），正在重新打开实验页后继续…`, 'warn');
          try {
            await this.prepareExperimentEntry(experiment, course).catch(() => {});
            const freshPage = await this.openExperiment(experiment, course);
            if (experimentPage && experimentPage !== freshPage && experimentPage !== this.page) {
              await experimentPage.close().catch(() => {});
            }
            experimentPage = freshPage;
            payload = await this.fetchTask(experimentPage, gameIdentifier, experiment);
            this.log('已在新打开的实验页上恢复抓取。');
          } catch (retryError) {
            this.log(`重新打开实验页后仍然失败：${retryError.message}`, 'error');
            payload = null;
          }
        }
        if (!payload) {
          this.log(`读取关卡数据失败（${gameIdentifier}）：${error.message}`, 'error');
          this.stats.failed += 1;
          this.progress({ experimentName: experiment.name });
          break;
        }
      }
      this.currentLevelPosition = payload?.challenge?.homework_challenge_index ?? null;
      this.currentLevelSubject = payload?.challenge?.subject || '';

      const inSelection = !wanted
        ? true
        : byId
          ? byId.has(String(gameIdentifier))
          : byPosition.has(Number(this.currentLevelPosition));
      if (inSelection) {
        index += 1;
        taken += 1;
        if (this.runProgress) this.runProgress.current += 1; // 整轮计数（多实验时徽章用它）
        this.currentIndex = index;
        this.__takenIds.add(String(gameIdentifier));
        if (Number.isFinite(Number(this.currentLevelPosition))) {
          this.__takenPositions.add(Number(this.currentLevelPosition));
        }
        this.status('running', `正在抓取「${experiment.name}」第 ${index} 关（${gameIdentifier}）…`);
        try {
          gameIdentifier = await this.captureLevel(experimentPage, gameIdentifier, experiment, course, payload);
        } catch (error) {
          this.stats.failed += 1;
          this.log(`关卡抓取失败（${gameIdentifier}）：${error.message}`, 'error');
          this.progress({ experimentName: experiment.name, current: taken, total: this.currentTotal });
          break;
        }
        // 进度按「已完成 / 用户选中的总数」报告，与界面上看到的选择一致。
        this.progress({ experimentName: experiment.name, current: taken, total: this.currentTotal });
        if (await this.stopping()) break;
        // 抓满选中数量即可收工。注意不能用 index 比较：按序号过滤时链上会夹着
        // 未选中的关卡，index 会比已抓取的选中关卡数增长得更快，导致提前结束。
        // 没有选中范围（wanted 为 null = 抓全部）时不要比较，只有 `wanted?.size` 存在才比。
        if (wanted && taken >= wanted.size) break;
      } else {
        this.log(`跳过未选中的关卡：第 ${this.currentLevelPosition ?? '?'} 关 ${this.currentLevelSubject || gameIdentifier}`);
        gameIdentifier = payload.next_game || null;
      }
    }

    if (wanted && taken < wanted.size && !this.stopRequested) {
      // 点名报出没抓到的关卡：只给「N 关只到达 M 关」用户无法判断是漏了哪几关。
      const missed = (selected || [])
        .filter((level) => {
          if (byId) return !this.__takenIds?.has(String(level.identifier));
          const position = Number(level.position ?? level.index);
          return !Number.isFinite(position) || !this.__takenPositions?.has(position);
        })
        .map((level) => `第${level.position ?? level.index ?? '?'}关 ${level.name || ''}`.trim())
        .slice(0, 10);
      this.log(
        `实验「${experiment.name}」选中 ${wanted.size} 关，但关卡链上只到达 ${taken} 关` +
          (missed.length ? `；没抓到的：${missed.join('、')}` : '') +
          '。可能是入口定位到了别的实验，或这些关卡不在同一条关卡链上。',
        'warn'
      );
      this.progress({ experimentName: experiment.name, current: taken, total: this.currentTotal });
    } else if (!wanted && !this.stopRequested && index < levels.length) {
      this.log(
        `实验「${experiment.name}」关卡列表显示 ${levels.length} 关，关卡链上抓到 ${index} 关（以关卡链为准）。`,
        'warn'
      );
    }

    if (experimentPage !== this.page) await experimentPage.close().catch(() => {});
    // 兜底：把这一轮顺手开出来的标签页全收掉。见 closeStrayPages 的说明。
    await this.closeStrayPages();
  }

  /**
   * 关掉所有「顺手开出来的」标签页，只留工作页（`this.page`）。
   *
   * 为什么必须收：平台自己的「进入关卡」「查看实战」是**新标签页**打开的，
   * 点一次就在 `context` 里多一页。各处虽然各有关闭，但入口有好几条
   * （openExperiment / clickEntryButton / enterFirstLevel …），漏一条就会累积——
   * 用户实测「每打开一个课程就多一个标签页」就是这么来的。
   *
   * 只在**一轮实验结束**这种没有在途导航的时刻调用，所以关掉非工作页是安全的。
   *
   * @returns {Promise<number>} 关掉的页数
   */
  async closeStrayPages() {
    if (!this.context || !this.page) return 0;
    let closed = 0;
    for (const page of this.context.pages()) {
      if (page === this.page) continue;
      if (typeof page.isClosed === 'function' && page.isClosed()) continue;
      await page.close().catch(() => {});
      closed += 1;
    }
    if (closed) this.log(`已收掉 ${closed} 个多余的标签页（只保留工作页）。`);
    return closed;
  }

  /** 启动浏览器（已启动则复用，不重复开窗口）。 */
  async ensureBrowser() {
    if (this.context && this.page && !this.page.isClosed?.()) return;
    await this.launch();
  }

  /**
   * 为「再一次提取」清理上一轮的状态。
   *
   * 引擎是长生命周期对象：一次 run() 结束（完成/停止/出错）后浏览器**保持打开**，
   * 用户可以换课程或换实验继续抓，不需要重启进程、也不需要重新登录。
   */
  resetForNextRun() {
    this.stopRequested = false;
    this.running = false;
    this.user = null;
    this.phase = 'starting';
    this.stats = { saved: 0, skipped: 0, failed: 0, existing: 0, dropped: 0 };
    this.experimentLevels = new Map();
    this.currentCourse = null;
    this.currentExperiment = null;
    this.currentIndex = 0;
    this.currentTotal = 0;
    this.currentLevelPosition = null;
    this.currentLevelSubject = '';
    this.runProgress = null;
    this.discoveredCourses = [];
    this.discoveredExperiments = [];
    this.discoveredLevels = [];
    this.loadedCourses = null;
  }

  /**
   * 「重新开始」：清空上一轮的课程/实验/关卡列表与选择状态。
   *
   * 与「继续提取」的区别：继续提取保留上一轮的课程/实验/关卡列表（便于补抓同一实验的
   * 其它关卡），而重新开始会把它们全部丢掉并重新读取课程列表。
   * 浏览器与登录态不受影响（窗口保持打开）。
   */
  resetRun() {
    if (this.running) throw new Error('任务正在进行中，请先等待结束或点击「停止」。');
    this.resetForNextRun();
    this.emit({ type: 'reset' });
  }

  /** 缓存只保留本次会话，避免跨轮运行时命中过期响应。 */

  async run() {
    if (this.running) throw new Error('已有提取任务正在运行。');
    // 先清理再置位：反过来的话 resetForNextRun() 会把 running 立刻改回 false，
    // 外壳的「是否已在运行」判断就会失效。
    this.resetForNextRun();
    this.running = true;
    await this.ensureBrowser();
    /**
     * 中途退出（停止请求、未登录、未选课程）也必须发 done：
     * 界面靠 done/error 进入终态，否则会永远停在中间阶段（例如「等待登录」），
     * 「开始提取/继续提取」按钮再也点不动，只能重启进程。
     */
    const finishEarly = (message, stopped) => {
      this.status(stopped ? 'stopping' : 'error', message, { user: this.user, loggedIn: Boolean(this.user) });
      this.emit({
        type: 'done',
        saved: this.stats.saved,
        skipped: this.stats.skipped,
        failed: this.stats.failed,
        existing: this.stats.existing || 0,
        dropped: this.stats.dropped || 0,
        stopped: Boolean(stopped),
        exportRoot: this.exportRoot
      });
    };
    try {
      const loggedIn = await this.ensureLogin();
      if (!loggedIn) {
        const stopped = this.stopRequested;
        const message = stopped
          ? '已停止（尚未登录）。浏览器保持打开，可再次点击「开始提取」。'
          : '未完成登录，已结束。请在弹出的浏览器窗口登录后重试。';
        finishEarly(message, stopped);
        return;
      }

      const courses = await this.loadCourses();
      if (!courses.length) {
        finishEarly('没有读取到任何课程，已结束。请确认账号下存在教学课程。', false);
        return;
      }
      this.status('waiting-course', `请选择要抓取的课程（共 ${courses.length} 门）。`, {
        user: this.user,
        loggedIn: true
      });
      const course = await this.control.waitForCourse(courses);
      if (!course) {
        const stopped = this.stopRequested;
        finishEarly(stopped ? '已停止（未选择课程）。' : '未选择课程，已终止。', stopped);
        return;
      }
      this.currentCourse = course;
      this.log(`已选择课程：${course.name}`);

      const experiments = await this.loadExperiments(course);
      if (!experiments.length) {
        // 「该课程没有课堂实验」是正常结果，不是故障：不要报错，也不该让用户以为坏了。
        const message = `课程「${course.name}」没有可提取的课堂实验，已结束。请改选其它课程。`;
        this.log(message, 'warn');
        this.status('done', message, { user: this.user, loggedIn: true });
        this.emit({
          type: 'done',
          saved: 0,
          skipped: 0,
          failed: 0,
          existing: 0,
          dropped: 0,
          stopped: true,
          exportRoot: this.exportRoot
        });
        return;
      }
      this.status('waiting-experiments', `请选择要抓取的课堂实验（共 ${experiments.length} 个）。`);
      const selectedExperiments = await this.control.waitForExperiments(experiments);
      if (!selectedExperiments?.length) {
        this.status('done', '未选择任何实验，已结束。', { user: this.user, loggedIn: true });
        this.emit({
          type: 'done',
          saved: 0,
          skipped: 0,
          failed: 0,
          existing: 0,
          dropped: 0,
          stopped: true,
          exportRoot: this.exportRoot
        });
        return;
      }
      this.log(`已选择 ${selectedExperiments.length} 个实验。`);

      // 先把所有选中实验的关卡列表读出来、合并成一份让用户一次选完，
      // 再逐个实验执行。逐个询问会让界面只显示「当前实验」的关卡。
      const plans = await this.selectLevelsForAll(selectedExperiments);
      if (plans === null) {
        // null 有两个来源：用户一个关卡都没选，或中途收到停止请求。
        // 这两种收场必须说清是哪一种，否则用户会把「自己按了停止」当成工具出了故障。
        this.status(
          'done',
          this.stopRequested ? '已停止（未读取关卡列表）。' : '未选择任何关卡，已结束。',
          { user: this.user, loggedIn: true }
        );
        this.emit({
          type: 'done',
          saved: this.stats.saved,
          skipped: this.stats.skipped,
          failed: this.stats.failed,
          existing: this.stats.existing || 0,
          dropped: this.stats.dropped || 0,
          stopped: true,
          exportRoot: this.exportRoot
        });
        return;
      }

      // 进度按「整轮勾选的关卡数」计：勾了多个实验的关卡时，不能被单个实验的
      // 0/N 覆盖（见 progress()）。只在每个要跑的实验都有明确勾选数时启用。
      const runnable = plans.filter((plan) => (plan.onlySelected ? (plan.selection || []).length > 0 : true));
      const pickedCounts = runnable.map((plan) => (plan.selection || []).length);
      this.runProgress = runnable.length > 1 && pickedCounts.every((count) => count > 0)
        ? { current: 0, total: pickedCounts.reduce((sum, count) => sum + count, 0) }
        : null;

      for (const plan of plans) {
        if (await this.stopping()) break;
        await this.runExperiment(plan.experiment, course, plan);
      }

      const stopped = this.stopRequested;
      // done 是「产物已就绪」的信号：**必须先把实验视图（md / metadata）写完再发**。
      // 视图是整轮结束才生成的，而客户端（控制台完成面板、篡改猴、测试）收到 done
      // 就会立刻去读 md——先发 done 再写文件，它们会读到还不存在的产物。
      // （原来的顺序就是反的：done 在 try 里发，写视图在 finally 里做，实测因此出现
      //   「报完成了但文件还没生成」的竞态，离线测试里表现为偶发失败。）
      // flushExperimentViews 幂等（写完会把 dirty 置回 false），
      // 所以下面 finally 里的兜底调用不会重复写。
      await this.flushExperimentViews().catch((error) => {
        this.log(`生成实验视图失败：${error.message}`, 'warn');
      });
      this.status(
        stopped ? 'stopping' : 'done',
        stopped
          ? `已停止。已保存 ${this.stats.saved} 关（部分结果）。`
          : `全部完成：已保存 ${this.stats.saved} 关。`,
        { user: this.user, loggedIn: true }
      );
      this.emit({
        type: 'done',
        saved: this.stats.saved,
        skipped: this.stats.skipped,
        failed: this.stats.failed,
        existing: this.stats.existing || 0,
        dropped: this.stats.dropped || 0,
        stopped,
        exportRoot: this.exportRoot
      });
    } catch (error) {
      this.stats.failed += 1;
      // 签名被拒是最容易被误判的一类：接口文案写「服务器时间与您的设备时间不匹配」，
      // 但它与系统时间无关。必须把「改哪个文件、怎么自证」直接写进日志，
      // 否则用户会去调系统时间、换账号、重装浏览器，永远查不到真正的原因。
      if (error && error.name === 'SignatureRejectedError') {
        this.log(
          `提取中断：${error.message}\n`
            + `请检查 extractor/lib/educoder-sign.js 的 AK/SK 常量与 SIGNING_VERSION`
            + `（当前 ${SIGNING_VERSION}），然后用 node tools/probe-signature.js 自证签名是否有效。`,
          'error'
        );
      } else {
        this.log(`提取中断：${error.message}`, 'error');
      }
      this.status('error', `提取失败：${error.message}`);
      this.emit({ type: 'error', message: error.message });
    } finally {
      // 关键：这里**不能**关闭浏览器。一次提取结束后窗口要留着，
      // 用户可以接着换课程/实验继续抓，或手动核对页面。
      // 只有用户主动「停止」或关闭控制台进程时才关闭（见 stop()）。
      // 视图（实验.md / metadata）在整轮结束时统一生成一次——抓取过程中只追加 levels.jsonl。
      await this.flushExperimentViews().catch(() => {});
      // 整轮结束时再收一次：中途退出（停止/出错）的路径不走 runExperiment 的收尾。
      await this.closeStrayPages().catch(() => {});
      this.running = false;
    }
  }
}

module.exports = { ExtractEngine, DEFAULT_EXPORT_ROOT, DEFAULT_PROFILE_DIR };
