/**
 * 控制台界面实测：启动真实 UI 服务 + 真实 server.js，用无头 Chromium 打开页面，
 * 断言渲染结果、抓取控制台报错、并截图。
 *
 * 用假 Playwright 驱动引擎（不触网、不需要账号），因此可以完整走完
 * 课程 → 实验 → 关卡 → 抓取 → done 的界面状态。
 *
 * 运行：node test/ui-visual-check.js
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');

const BASE64 = (v) => Buffer.from(v, 'utf8').toString('base64');
const IMAGE_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

const COURSE = {
  id: 120001,
  name: '示例课程B',
  school: '示例大学',
  members_count: 60,
  homework_commons_count: 41,
  is_end: false,
  first_category_url: '/classrooms/DEMO0001/announcement'
};
const COURSE2 = {
  id: 120002,
  name: '网络编程技术-26-27第一学期',
  school: '示例大学',
  members_count: 60,
  is_end: false,
  first_category_url: '/classrooms/zq22d977/announcement'
};
const EXPERIMENTS = {
  status: 0,
  homeworks: [
    { name: 'CNN', homework_id: 88000002, shixun_identifier: 'zq6177bf', myshixun_identifier: 'zq3a1b66ee', challenge_count: 3, is_shixun: true },
    { name: '模型评估与选择', homework_id: 88000001, shixun_identifier: 'zq655f1e', myshixun_identifier: 'zqad65672b', challenge_count: 3, is_shixun: true },
    { name: '普通作业（应被过滤）', homework_id: 9, is_shixun: false }
  ]
};
const CHALLENGES = [
  { identifier: 'conv', subject: 'conv', position: 1, challenge_id: 11, homework_challenge_index: 1, with_code_file: true, chooses: [] },
  { identifier: 'pool', subject: 'pool', position: 2, challenge_id: 12, homework_challenge_index: 2, with_code_file: true, chooses: [] },
  { identifier: 'quiz', subject: '欠拟合与过拟合', position: 3, challenge_id: 13, homework_challenge_index: 3, with_code_file: true, chooses: [{ subject: 'q', challenge_question: [{ option_name: 'A' }] }] }
];
const TASKS = {
  conv: { challenge: { subject: 'conv', homework_challenge_index: 1, with_code_file: true, path: 'conv.py', task_pass: '### 任务描述\n\n实现卷积。\n\n### 编程要求\n\n补充代码。\n\n<p><img src="/api/attachments/88000006" /></p>' }, next_game: 'pool', chooses: [] },
  pool: { challenge: { subject: 'pool', homework_challenge_index: 2, with_code_file: true, path: 'pool.py', task_pass: '### 任务描述\n\n实现池化。\n\n### 编程要求\n\n补充池化代码。' }, next_game: 'quiz', chooses: [] },
  quiz: { challenge: { subject: '欠拟合与过拟合', homework_challenge_index: 3, with_code_file: true, path: 'quiz.py', task_pass: '### 任务描述\n\n不应出现。' }, next_game: null, chooses: [{ subject: '该模型处于什么状态？', challenge_question: [{ option_name: '欠拟合' }, { option_name: '过拟合' }] }] }
};

const exportRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'touge-visual-'));
const state = { currentUrl: 'https://www.educoder.net/users/p8sxailt2/classrooms', closed: 0 };

function apiBody(url) {
  const parsed = new URL(url);
  if (parsed.pathname.endsWith('/courses.json')) {
    return { status: 200, body: JSON.stringify({ count: 2, courses: [COURSE, COURSE2] }) };
  }
  if (parsed.pathname.endsWith('challenges.json')) return { status: 200, body: JSON.stringify(CHALLENGES) };
  if (parsed.pathname.endsWith('homework_commons.json')) return { status: 200, body: JSON.stringify(EXPERIMENTS) };
  if (parsed.pathname.endsWith('rep_content.json')) {
    return { status: 200, body: JSON.stringify({ content: { content: BASE64('print("starter")\n') } }) };
  }
  const taskId = parsed.pathname.match(/\/api\/tasks\/([^/.]+)\.json/)?.[1];
  if (taskId && TASKS[taskId]) return { status: 200, body: JSON.stringify(TASKS[taskId]) };
  throw new Error(`假接口未覆盖：${url}`);
}

const responseListeners = new Set();
// 引擎优先用「页面自身请求」拿数据（data API 直连会被 -102 拒绝），导航时回放这些响应。
const replay = async () => {
  const entries = [
    ['api/courses/DEMO0001/homework_commons.json', JSON.stringify(EXPERIMENTS)],
    // 课堂实验页还会请求 left_banner.json（章标签分类）：引擎为拿分类会等它最多 8 秒，
    // 假页面不回放就会白等——曾因此让「课程选择后进入实验阶段」等 3 条检查全部超时失败。
    // 这里给一个「课堂实验」模块但没有任何章标签，等价于「不用按章补齐」。
    ['api/courses/DEMO0001/left_banner.json', JSON.stringify({ course_modules: [{ name: '课堂实验', second_category: [] }] })],
    ['api/myshixuns/zq3a1b66ee/challenges.json', JSON.stringify(CHALLENGES)],
    // 引擎先导航到实训关卡页，请求的是 shixun_identifier 端点（真实形态带查询串）。
    ['api/shixuns/zq6177bf/challenges.json?id=zq6177bf', JSON.stringify(CHALLENGES)],
    ...Object.entries(TASKS).map(([id, payload]) => [`api/tasks/${id}.json`, JSON.stringify(payload)])
  ];
  for (const [fragment, body] of entries) {
    for (const listener of responseListeners) {
      await listener({
        // 真实 Playwright 的 response.url() 永远是绝对 URL，桩必须一致。
        url: () => `https://data.educoder.net/${fragment}`,
        status: () => 200,
        ok: () => true,
        // attachNetworkCapture 会调用 response.request().method()
        request: () => ({ method: () => 'GET' }),
        async text() { return body; },
        async json() { return JSON.parse(body); }
      });
    }
  }
};

// 真实页面在存活期间会持续发请求，与「谁在监听」无关；
// 只在导航时回放会让引擎空等超时（关卡列表 8 秒、实验列表 15 秒）。
const replayLoop = setInterval(() => {
  replay().catch(() => {});
}, 20);
if (typeof replayLoop.unref === 'function') replayLoop.unref();

const page = {
  url: () => state.currentUrl,
  on: (event, handler) => {
    if (event === 'response') responseListeners.add(handler);
    return page;
  },
  off: (event, handler) => {
    if (event === 'response') responseListeners.delete(handler);
    return page;
  },
  async goto(u) { state.currentUrl = u; await replay(); },
  async reload() {},
  async waitForTimeout() {},
  async waitForLoadState() {},
  async close() { state.closed += 1; },
  async evaluate(fn, arg) {
    const src = fn.toString();
    if (typeof arg === 'string' && /arrayBuffer/.test(src)) return { base64: IMAGE_BASE64, contentType: 'image/png' };
    if (typeof arg === 'string' && /fetch\s*\(/.test(src)) return apiBody(arg);
    return fn(arg);
  },
  async waitForResponse(predicate) {
    const candidates = ['https://data.educoder.net/api/shixuns/zq6177bf/shixun_exec.json'];
    const url = candidates.find((u) => predicate({ url: () => u }));
    if (!url) return null;
    return { ok: () => true, url: () => url, async json() { return { game_identifier: 'conv' }; } };
  },
  async waitForEvent() { return null; },
  locator(selector) {
    const el = {
      first: () => el, filter: () => el, getByText: () => el,
      async count() { return selector.includes('listItem') || selector.includes('/tasks/') ? 1 : 0; },
      async click() {},
      async evaluateAll(fn) { return fn([]); }
    };
    return el;
  },
  request: {
    async get(u) {
      if (u.includes('rep_content')) return { ok: () => true, async json() { return { content: { content: BASE64('print("starter")\n') } }; } };
      return { ok: () => false, status: () => 404, async json() {} };
    }
  }
};
const context = { pages: () => [page], async newPage() { return page; }, async close() { state.closed += 1; } };
// 先取真实 playwright（用于驱动真实浏览器看界面），再打补丁给引擎用假实现。
const realChromium = require('playwright').chromium;
const originalLoad = Module._load;
Module._load = function (request) {
  if (request === 'playwright') return { chromium: { async launchPersistentContext() { return context; } } };
  return originalLoad.apply(this, arguments);
};

const api = require('../extractor/lib/educoder-api');
api.checkLogin = async () => ({ loggedIn: true, user: 'p8sxailt2', status: 200 });
process.env.EDUCODER_EXPORT_ROOT = exportRoot;
// 种一份关卡存档：让「AI 作答」面板的候选列表（课程/实验/关卡）有东西可渲染。
const seedDir = path.join(exportRoot, '示例课程B', 'CNN');
fs.mkdirSync(seedDir, { recursive: true });
fs.writeFileSync(
  path.join(seedDir, 'levels.jsonl'),
  [
    { taskIndex: 1, title: 'conv', level: '第1关_conv', type: 'code', codeLanguage: 'python' },
    { taskIndex: 2, title: 'pool', level: '第2关_pool', type: 'code', codeLanguage: 'python' },
    { taskIndex: 3, title: '欠拟合与过拟合', level: '第3关_欠拟合与过拟合', type: 'choice', codeLanguage: '' }
  ]
    .map((record) =>
      JSON.stringify({
        course: '示例课程B',
        experiment: 'CNN',
        source: 'https://www.educoder.net/tasks/x',
        choiceQuestions: [],
        choices: [],
        images: [],
        imageMap: {},
        contentHash: 'seed',
        ...record
      })
    )
    .join('\n') + '\n',
  'utf8'
);
const { ExtractEngine } = require('../extractor/lib/extract-engine');
const { startUiServer } = require('../extractor/ui/server');

const pending = { course: null, experiments: null, levels: null, stop: false };
let server = null;

const engine = new ExtractEngine({
  exportRoot,
  profileDir: path.join(exportRoot, 'profile'),
  pageSettleMs: 0,
  onEvent: (e) => server?.emit(e),
  control: {
    waitForCourse: (courses) => new Promise((r) => { pending.course = { courses, r }; }),
    waitForExperiments: (experiments) => new Promise((r) => { pending.experiments = { experiments, r }; }),
    waitForLevels: (levels) => new Promise((r) => { pending.levels = { levels, r }; }),
    shouldStop: async () => pending.stop
  }
});

async function onControl(action, payload = {}) {
  if (action === 'start') {
    // 用引擎的 running 状态守卫（started 已废弃）；否则重复 start 会重复调用 run()，
    // 后一次 run 的 resetForNextRun() 会清掉前一次刚读到的关卡列表。
    if (!engine.running) {
      engine.skipExisting = payload.skipExisting !== false;
      engine.run().catch((e) => server.emit({ type: 'error', message: e.message }));
    }
    return { ok: true };
  }
  if (action === 'reset') {
    engine.resetRun();
    pending.course = null;
    pending.experiments = null;
    pending.levels = null;
    return { ok: true, reset: true };
  }
  if (action === 'select-course') {
    const course = pending.course?.courses.find((c) => String(c.id) === String(payload.courseId));
    if (!course) throw new Error('课程编号无效。');
    const { r } = pending.course; pending.course = null; r(course);
    return { ok: true };
  }
  if (action === 'select-experiments') {
    const selected = (payload.indices || []).map((i) => pending.experiments?.experiments[i]).filter(Boolean);
    if (!selected.length) throw new Error('请至少选择一个实验。');
    const { r } = pending.experiments; pending.experiments = null; r(selected);
    return { ok: true, count: selected.length };
  }
  if (action === 'select-levels') {
    // 与真服务器一致：接受结构化选项（identifier / challengeId / position）与旧式 identifiers
    const wanted = Array.isArray(payload.levels) ? payload.levels : null;
    const ids = payload.identifiers || [];
    let selected = null;
    if (wanted && wanted.length) {
      selected = pending.levels.levels.filter((l) =>
        wanted.some((want) => {
          if (!want || typeof want !== 'object') return String(want) === String(l.identifier);
          if (want.identifier && String(want.identifier) === String(l.identifier)) return true;
          if (want.challengeId && String(want.challengeId) === String(l.challengeId)) return true;
          const position = Number(want.position);
          return Number.isFinite(position) && position > 0 && Number(l.position) === position;
        })
      );
    } else if (ids.length) {
      selected = pending.levels.levels.filter((l) => ids.includes(l.identifier));
    } else {
      selected = pending.levels.levels;
    }
    const { r } = pending.levels; pending.levels = null; r(selected.length ? selected : null);
    return { ok: true, count: selected.length };
  }
  if (action === 'stop') {
    pending.stop = true;
    return { ok: true };
  }
  throw new Error(`未知动作：${action}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, ok, extra = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  ${extra}` : ''}`);
}

(async () => {
  server = await startUiServer({ port: 0, onControl, open: false });
  const url = new URL(server.url);
  const token = url.searchParams.get('token');
  const base = `${url.protocol}//${url.host}`;
  // 截图写到临时目录，避免污染仓库工作区。
  const shotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'touge-shots-'));
  const shoot = path.join(shotDir, 'ui-selecting.png');
  const shootDone = path.join(shotDir, 'ui-done.png');

  // 本机只装了完整 chromium（没有 headless shell），因此显式走 channel。
  const browser = await realChromium.launch({ channel: 'chromium' });
  const page2 = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const errors = [];
  page2.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
  page2.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));

  // 1) 初始状态（starting）
  await page2.goto(`${base}/?token=${token}`, { waitUntil: 'domcontentloaded' });
  await sleep(400);
  const bodyText = await page2.innerText('body');
  check('页面加载并渲染标题', /头歌|提取|控制台/.test(bodyText));
  check('未登录时阶段可见', /starting|启动|就绪|等待/.test(bodyText));
  await page2.screenshot({ path: shoot, fullPage: true });

  // 2) 启动 → 课程列表
  await page2.evaluate((t) => fetch('/api/action', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'start', token: t })
  }), token);
  for (let i = 0; i < 60 && !pending.course; i += 1) await sleep(50);
  check('引擎进入课程选择阶段', Boolean(pending.course));
  await sleep(400);
  const courseText = await page2.innerText('body');
  check('课程列表渲染出两门课', courseText.includes('示例课程B') && courseText.includes('网络编程技术'));
  check('课程显示学校信息', courseText.includes('示例大学'));
  await page2.screenshot({ path: shoot, fullPage: true });

  // 3) 在 #list-courses 里选第一门课程，再点「确认课程并继续」
  await page2.locator('#list-courses input').first().click({ force: true });
  await sleep(150);
  const confirmCourse = page2.locator('#btn-course');
  check('「确认课程并继续」按钮可用', await confirmCourse.isEnabled());
  await confirmCourse.click();
  for (let i = 0; i < 60 && !pending.experiments; i += 1) await sleep(50);
  check('课程选择后进入实验阶段', Boolean(pending.experiments));
  await sleep(400);
  const expText = await page2.innerText('body');
  check('实验列表渲染', expText.includes('CNN') && expText.includes('模型评估与选择'));
  check('is_shixun=false 的作业未出现在界面', !expText.includes('普通作业（应被过滤）'));

  // 4) 用真实用户点击勾选实验，再点「选取选中的实验」
  const expBoxes = page2.locator('#list-experiments input[type=checkbox]');
  const boxCount = await expBoxes.count();
  check('实验复选框存在', boxCount === 2, `count=${boxCount}`);
  await expBoxes.first().click({ force: true });
  await sleep(200);
  check('实验已勾选', await expBoxes.first().isChecked());
  check('已选计数更新', /已选\s*1\s*\/\s*2/.test(await page2.innerText('body')));

  const submitExperiments = page2.locator('#btn-experiments');
  check('「提取选中的实验」按钮可用', await submitExperiments.isEnabled());
  await submitExperiments.click();
  for (let i = 0; i < 80 && !pending.levels; i += 1) await sleep(50);
  check('进入关卡选择阶段', Boolean(pending.levels));
  await sleep(400);
  const levelText = await page2.innerText('body');
  check('关卡列表渲染三关', levelText.includes('conv') && levelText.includes('pool'));
  check('关卡显示题型标签', /code/.test(levelText));
  await page2.screenshot({ path: shoot, fullPage: true });

  // 6) 关卡阶段：点 data-bulk="all" 全选，再点「开始抓取选中的关卡」
  await sleep(150);
  const bulkAll = page2.locator('[data-bulk="all"][data-target="levels"]');
  check('关卡区存在全选按钮', (await bulkAll.count()) === 1);
  await bulkAll.click();
  await sleep(150);
  const levelBoxes = page2.locator('#list-levels input[type=checkbox]');
  check('关卡已全选', (await levelBoxes.count()) === 3);
  check('关卡全部勾选', (await levelBoxes.nth(0).isChecked()) && (await levelBoxes.nth(2).isChecked()));

  const startBtn = page2.locator('#btn-levels');
  check('「开始抓取选中的关卡」按钮可用', await startBtn.isEnabled());
  check('按钮文案反映已选关卡数', /3 个关卡/.test(await startBtn.innerText()));
  await startBtn.click();

  for (let i = 0; i < 200; i += 1) {
    const snap = server.getSnapshot();
    if (snap.phase === 'done') break;
    await sleep(50);
  }
  await sleep(600);
  const doneText = await page2.innerText('body');
  check('完成后展示 exports 路径', doneText.includes(exportRoot) || /exports/.test(doneText));
  check('完成后展示汇总计数', /已保存/.test(doneText));
  await page2.screenshot({ path: shootDone, fullPage: true });

  // 6) 「AI 作答」面板：候选列表来自 exports 下的关卡存档（脚本开头已种好 CNN 三关）
  const answerText = await page2.innerText('#panel-answer');
  check('AI 作答面板存在', /AI 作答/.test(answerText));
  check('面板有模型设置字段', Boolean(await page2.locator('#answer-key').count()));
  check('面板列出可作答课程', /示例课程B/.test(await page2.innerText('#list-answer-courses')));
  // 默认只有一门课 → 自动选中，实验列表随之出现
  await sleep(300);
  check('实验列表列出 CNN', /CNN/.test(await page2.innerText('#list-answer-experiments')));
  await page2.locator('#list-answer-experiments input').first().click({ force: true });
  await sleep(200);
  const answerLevelText = await page2.innerText('#list-answer-levels');
  check('勾选实验后列出该实验的关卡', /第1关/.test(answerLevelText) && /第3关/.test(answerLevelText));
  check('关卡标出所属实验', /CNN/.test(answerLevelText));
  check('关卡标出题型', /编程题|选择题/.test(answerLevelText));
  await page2.locator('[data-abulk="all"][data-atarget="levels"]').click({ force: true });
  await sleep(200);
  check('关卡全选生效', /已选 3 \/ 3/.test(await page2.innerText('#badge-answer-levels')));
  check('未填 API Key 时点开始会提示（而不是静默）', await (async () => {
    await page2.locator('#btn-answer-run').click({ force: true });
    await sleep(300);
    return /API Key/.test(await page2.innerText('body'));
  })());
  const shootAnswer = path.join(shotDir, 'ui-answer.png');
  await page2.screenshot({ path: shootAnswer, fullPage: true });

  check('无浏览器控制台错误', errors.length === 0, errors.slice(0, 3).join(' | '));

  await browser.close();
  await server.close();
  Module._load = originalLoad;
  fs.rmSync(exportRoot, { recursive: true, force: true });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== ${results.length - failed.length}/${results.length} PASS ===`);
  console.log(`截图：${shoot}`);
  console.log(`截图：${shootDone}`);
  console.log(`截图：${shootAnswer}`);
  process.exitCode = failed.length ? 1 : 0;
})();
