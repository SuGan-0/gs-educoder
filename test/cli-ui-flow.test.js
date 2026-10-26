/**
 * 端到端测试：真实 HTTP + SSE 驱动 run.js --ui 的完整流程。
 * 用假 Playwright 替换浏览器层，因此不触网、不需要头歌账号。
 *
 * 覆盖：控制台启动 → 取快照 → 选课程 → 选实验 → 选关卡 → 开始 → 收到 done 事件 → 产物落盘。
 *
 * 运行：node --test "test/**\/*.test.js"
 */
require('./helpers/offline-signing');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');

const BASE64 = (value) => Buffer.from(value, 'utf8').toString('base64');

/**
 * 关掉 runUi() 打印的启动横幅，并关闭抓取网络日志。
 *
 * 两个原因，都是实测踩出来的：
 * 1. `node --test` 用子进程 stdout 的 IPC 协议回传结果，子进程里多余的 `console.log`
 *    会让运行器偶发报 `Unable to deserialize cloned data`——表现为整个文件级失败
 *    （`not ok 1 - test\cli-ui-flow.test.js`），而不是某条用例失败；
 * 2. `run.js` 默认把响应追加进仓库根的 `.educoder-network.jsonl`，离线测试回放的
 *    假请求会把它写脏（实测一次运行追加 6492 行、约 3MB）。
 */
const originalConsole = { log: console.log, info: console.info };
test.before(() => {
  process.env.EDUCODER_NETWORK_LOG = '';
  console.log = () => {};
  console.info = () => {};
});
test.after(() => {
  console.log = originalConsole.log;
  console.info = originalConsole.info;
});

/** 1x1 合法 PNG，用于验证图片下载与扩展名判定链路。 */
const IMAGE_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

const COURSE = {
  id: 120001,
  name: '示例课程B',
  school: '示例大学',
  members_count: 60,
  homework_commons_count: 41,
  is_end: false,
  first_category_url: '/classrooms/DEMO0001/announcement'
};

const EXPERIMENTS = {
  status: 0,
  homeworks: [
    {
      name: 'CNN',
      homework_id: 88000002,
      shixun_identifier: 'zq6177bf',
      myshixun_identifier: 'zq3a1b66ee',
      challenge_count: 2,
      is_shixun: true
    },
    { name: '普通作业', homework_id: 9, is_shixun: false }
  ]
};

const TASKS = {
  conv: {
    challenge: {
      subject: 'conv',
      homework_challenge_index: 1,
      with_code_file: true,
      path: 'conv.py',
      task_pass: '### 任务描述\n\n实现卷积。\n\n### 编程要求\n\n补充代码。\n\n<img src="/api/attachments/88000006" />'
    },
    next_game: 'pool',
    chooses: []
  },
  pool: {
    challenge: {
      subject: 'pool',
      homework_challenge_index: 2,
      with_code_file: true,
      path: 'pool.py',
      task_pass: '### 任务描述\n\n实现池化。\n\n### 编程要求\n\n补充池化代码。'
    },
    next_game: null,
    chooses: []
  }
};

const CHALLENGES = [
  { identifier: 'conv', subject: 'conv', homework_challenge_index: 1, with_code_file: true, chooses: [] },
  { identifier: 'pool', subject: 'pool', homework_challenge_index: 2, with_code_file: true, chooses: [] }
];

// ---- 第二个实验（多实验回归用）：关卡无标识（靠序号过滤），且与第一个实验的关卡号重号 ----
const EXPERIMENT_B = {
  name: '模型评估与选择',
  homework_id: 88000001,
  shixun_identifier: 'zq655f1e',
  myshixun_identifier: 'zqad65672b',
  challenge_count: 2,
  is_shixun: true
};

const CHALLENGES_B = [
  { identifier: '', subject: '欠拟合与过拟合', homework_challenge_index: 1, with_code_file: false },
  { identifier: '', subject: '留出法等常见评估方法', homework_challenge_index: 2, with_code_file: true }
];

const TASKS_B = {
  'b-quiz-1': {
    challenge: {
      subject: '欠拟合与过拟合',
      homework_challenge_index: 1,
      with_code_file: true,
      path: null,
      task_pass: ''
    },
    chooses: [
      { subject: '下列说法正确的是？', challenge_question: [{ option_name: '甲' }, { option_name: '乙' }] }
    ],
    prev_game: null,
    next_game: 'b-code-2'
  },
  'b-code-2': {
    challenge: {
      subject: '留出法等常见评估方法',
      homework_challenge_index: 2,
      with_code_file: true,
      path: 'holdout.py',
      task_pass: '### 任务描述\n\n实现留出法划分。\n\n### 编程要求\n\n补充代码。'
    },
    prev_game: 'b-quiz-1',
    next_game: null
  }
};

/** 当前活着的假页面：新用例创建时会把上一个停掉，避免旧回放循环向新用例投递旧数据。 */
let activeFake = null;

function createFakePlaywright(options = {}) {
  const withSecondExperiment = options.withSecondExperiment === true;
  const experiments = withSecondExperiment
    ? { status: 0, homeworks: [...EXPERIMENTS.homeworks, EXPERIMENT_B] }
    : EXPERIMENTS;
  const state = {
    currentUrl: 'https://www.educoder.net/users/p8sxailt2/classrooms',
    closed: 0
  };

  const responseListeners = new Set();
  // 导航时把「页面自身发出的 API 请求」回放给监听者，模拟真实页面行为。
  const replay = async () => {
    const entries = [];
    entries.push([
      'api/courses/DEMO0001/homework_commons.json',
      JSON.stringify(experiments)
    ]);
    entries.push([
      'api/myshixuns/zq3a1b66ee/challenges.json',
      JSON.stringify(CHALLENGES)
    ]);
    // 引擎会先导航到实训关卡页，请求的是 shixun_identifier 端点（带查询串的真实形态）。
    entries.push([
      'api/shixuns/zq6177bf/challenges.json?id=zq6177bf',
      JSON.stringify(CHALLENGES)
    ]);
    if (withSecondExperiment) {
      entries.push([
        'api/shixuns/zq655f1e/challenges.json?id=zq655f1e',
        JSON.stringify(CHALLENGES_B)
      ]);
      entries.push([
        'api/myshixuns/zqad65672b/challenges.json?homework_common_id=88000001',
        JSON.stringify(CHALLENGES_B)
      ]);
      for (const [taskId, payload] of Object.entries(TASKS_B)) {
        entries.push([`api/tasks/${taskId}.json`, JSON.stringify(payload)]);
      }
    }
    for (const [taskId, payload] of Object.entries(TASKS)) {
      entries.push([`api/tasks/${taskId}.json`, JSON.stringify(payload)]);
    }
    for (const [fragment, body] of entries) {
      for (const listener of responseListeners) {
        await listener({
          // 真实 Playwright 的 response.url() 永远是绝对 URL，桩必须一致。
          url: () => `https://data.educoder.net/${fragment}`,
          status: () => 200,
          ok: () => true,
          // attachNetworkCapture 会调用 response.request().method()
          request: () => ({ method: () => 'GET' }),
          async text() {
            return body;
          },
          async json() {
            return JSON.parse(body);
          }
        });
      }
    }
  };

  // 真实页面在存活期间会持续发请求，与「谁在监听」无关。
  // 只在导航时回放会让引擎空等超时（读取关卡列表要 8 秒、实验列表 15 秒），
  // 因此这里挂在页面生命周期上周期回放。
  let stopped = false;
  let replayLoop = null;
  const stop = () => {
    stopped = true;
    responseListeners.clear();
    if (replayLoop) clearInterval(replayLoop);
  };
  replayLoop = setInterval(() => {
    if (stopped) return;
    replay().catch(() => {});
  }, 20);
  if (typeof replayLoop.unref === 'function') replayLoop.unref();

  const page = {
    url: () => state.currentUrl,
    // 引擎优先用「页面自身请求」拿数据（data API 直连会被 -102 拒绝），
    // 因此假 page 必须支持响应监听并在导航时回放，否则引擎会空等超时。
    on: (event, handler) => {
      if (event === 'response') responseListeners.add(handler);
      return page;
    },
    off: (event, handler) => {
      if (event === 'response') responseListeners.delete(handler);
      return page;
    },
    async goto(url) {
      state.currentUrl = url;
      await replay();
    },
    async reload() {},
    async waitForTimeout() {},
    async waitForLoadState() {},
    async close() {
      state.closed += 1;
    },
    async evaluate(fn, arg) {
      const source = fn.toString();
      // 让真实的 educoder-api 代码路径跑起来：按 URL 分派 apiGet 期望的 { status, body }。
      // apiGet 传对象 { url, headers }（签名头在 Node 侧算好），图片回调仍传字符串 URL。
      // 顺序敏感：图片回调里也含 fetch(，必须先判 arrayBuffer。
      const target = typeof arg === 'string' ? arg : String((arg && arg.url) || '');
      if (target && /arrayBuffer/.test(source)) {
        return { base64: IMAGE_BASE64, contentType: 'image/png' };
      }
      if (target && /fetch\s*\(/.test(source)) {
        const parsed = new URL(target);
        let body;
        if (parsed.pathname.endsWith('get_user_info.json')) body = JSON.stringify({ login: 'p8sxailt2' });
        else if (parsed.pathname.endsWith('/courses.json')) body = JSON.stringify({ count: 1, courses: [COURSE] });
        else if (parsed.pathname.endsWith('challenges.json')) {
          // 引擎现在按**实验自己的 myshixun 标识**直接请求接口（不再导航后读页面响应），
          // 因此桩要按 myshixun 标识分派；同时保留 shixun 标识以兼容兜底路径。
          const isSecondExperiment = parsed.pathname.includes('zqad65672b') || parsed.pathname.includes('zq655f1e');
          body = JSON.stringify(withSecondExperiment && isSecondExperiment ? CHALLENGES_B : CHALLENGES);
        } else if (parsed.pathname.endsWith('homework_commons.json')) body = JSON.stringify(experiments);
        else if (parsed.pathname.endsWith('rep_content.json')) body = JSON.stringify({ content: { content: BASE64('print("starter")\n') } });
        else {
          const taskId = parsed.pathname.match(/\/api\/tasks\/([^/.]+)\.json/)?.[1];
          if (taskId && TASKS[taskId]) body = JSON.stringify(TASKS[taskId]);
          else if (taskId && TASKS_B[taskId]) body = JSON.stringify(TASKS_B[taskId]);
        }
        if (body === undefined) throw new Error(`假接口未覆盖：${target}`);
        return { status: 200, body };
      }
      return fn(arg);
    },
    async waitForResponse(predicate) {
      const candidates = [
        'https://data.educoder.net/api/courses/DEMO0001/homework_commons.json',
        'https://data.educoder.net/api/shixuns/zq6177bf/shixun_exec.json'
      ];
      const url = candidates.find((item) => predicate({ url: () => item }));
      if (!url) return null;
      if (url.includes('homework_commons.json')) {
        return {
          ok: () => true,
          url: () => url,
          async json() {
            return EXPERIMENTS;
          }
        };
      }
      return {
        ok: () => true,
        url: () => url,
        async json() {
          return { game_identifier: 'conv' };
        }
      };
    },
    async waitForEvent() {
      return null;
    },
    /**
     * 引擎用 evaluateHandle 在页面里定位「实验卡片 / 进入关卡按钮」（真实 Playwright 的句柄
     * 支持 asElement/evaluate/click/dispose）。假页面没有 DOM，返回可点的假句柄即可。
     */
    async evaluateHandle() {
      const handle = {
        async asElement() {
          return element;
        },
        async dispose() {}
      };
      const element = {
        ...handle,
        async evaluate() {
          return '开始学习';
        },
        async click() {}
      };
      return handle;
    },
    locator(selector) {
      const element = {
        first: () => element,
        filter: () => element,
        getByText: () => element,
        async count() {
          return selector.includes('listItem') || selector.includes('/tasks/') ? 1 : 0;
        },
        async click() {},
        async evaluateAll(fn) {
          return fn([]);
        }
      };
      return element;
    },
    request: {
      // 真实 Playwright 的 page.request 既是函数又是对象（page.request.get(...)）；
      // attachNetworkCapture 里会调用 response.request().method()，因此桩要提供闭包。
      method: () => 'GET',
      async get(url) {
        if (url.includes('rep_content.json')) {
          return {
            ok: () => true,
            async json() {
              return { content: { content: BASE64('print("starter")\n') } };
            }
          };
        }
        return { ok: () => false, status: () => 404, async json() {} };
      }
    }
  };

  const context = {
    pages: () => [page],
    async newPage() {
      return page;
    },
    async close() {
      state.closed += 1;
    }
  };

  const fakeChromium = {
    async launchPersistentContext() {
      return context;
    }
  };

  const originalLoad = Module._load;
  Module._load = function patched(request) {
    if (request === 'playwright') return { chromium: fakeChromium };
    return originalLoad.apply(this, arguments);
  };
  const self = { stop, restore };
  if (activeFake) activeFake.stop(); // 新用例创建时先停掉上一个假页面
  activeFake = self;

  function restore() {
    stop();
    // 只有当自己仍是「当前假页面」时才还原 Module._load：node:test 的 t.after 是后进先出，
    // 上一个用例的 restore 可能在后一个用例运行期间才执行，无条件还原会把新用例的假
    // Playwright 覆盖掉，让它去启动真 Chromium（表现为子进程被杀、运行器 IPC 反序列化失败）。
    if (activeFake === self) {
      Module._load = originalLoad;
      activeFake = null;
    }
  }

  return { state, restore, stop };
}

/**
 * 只 stub 登录探测；listCourses / listExperiments / listChallenges 一律跑真实的 educoder-api 代码，
 * 由假 page.evaluate 按 URL 提供 { status, body }（apiGet 在浏览器上下文里的返回形状）。
 * 注意：monkey-patch 导出对象对 api 模块内部调用无效——它走的是词法作用域的 apiGet。
 */
function installFakeApi() {
  const api = require('../extractor/lib/educoder-api');
  const original = { checkLogin: api.checkLogin };
  api.checkLogin = async () => ({ loggedIn: true, user: 'p8sxailt2', status: 200 });
  return () => {
    api.checkLogin = original.checkLogin;
  };
}

async function waitForPhase(base, token, predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const response = await fetch(`${base}/api/state?token=${token}`);
    last = await response.json();
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`等待阶段超时，最后状态：${JSON.stringify({ phase: last?.phase, message: last?.message })}`);
}

async function post(base, token, body) {
  const response = await fetch(`${base}/api/action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, ...body })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`动作 ${body.action} 失败：${payload.error || response.status}`);
  return payload;
}

/**
 * 取一份全新的外壳模块（run.js 及其依赖的引擎/数据层）。
 *
 * 必须这么做：`require('.../run')` 返回的是缓存里的同一个模块对象，而引擎是**有状态的**
 * （context / running / responseCache / user）。用例之间共享它，会让上一个用例的引擎状态
 * 泄漏到下一个用例——实测「多实验」用例因此复用了上一个用例的假浏览器上下文与实验列表，
 * 只读到 1 个实验，看起来像「引擎以单实验模式运行」。
 */
function freshRunModule() {
  for (const key of Object.keys(require.cache)) {
    if (/extractor[\\/](run|lib[\\/](extract-engine|educoder-api|task-parser))\.js$/.test(key)) {
      delete require.cache[key];
    }
  }
  return require('../extractor/run');
}

test.before(() => {
  // 关掉抓取网络日志：否则测试回放的假请求会被追加进仓库根的真实 .educoder-network.jsonl。
  process.env.EDUCODER_NETWORK_LOG = '';
});

test('run.js --ui：HTTP 驱动完整流程并落盘', async (t) => {
  const fake = createFakePlaywright();
  const restoreApi = installFakeApi();
  const exportRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'touge-ui-'));
  const previousExport = process.env.EDUCODER_EXPORT_ROOT;
  process.env.EDUCODER_EXPORT_ROOT = exportRoot;

  const { runUi } = freshRunModule();

  t.after(() => {
    restoreApi();
    fake.restore();
    if (previousExport === undefined) delete process.env.EDUCODER_EXPORT_ROOT;
    else process.env.EDUCODER_EXPORT_ROOT = previousExport;
    fs.rmSync(exportRoot, { recursive: true, force: true });
  });

  const { server, engine } = await runUi({ open: false, headless: true, port: 0, token: 'test-token' });
  t.after(async () => {
    await server.close().catch(() => {});
  });

  const url = new URL(server.url);
  const token = url.searchParams.get('token');
  const base = `${url.protocol}//${url.host}`;

  assert.ok(token, '控制台 URL 必须带 token');

  // 未带 token 的 API 请求必须被拒绝
  const denied = await fetch(`${base}/api/state`);
  assert.equal(denied.status, 403, '无 token 必须 403');

  // 引擎由 start 动作触发，因此必须先 start 再等待阶段推进。
  await post(base, token, { action: 'start' });
  const state = await waitForPhase(base, token, (item) => item.phase === 'waiting-course', 10000);
  assert.equal(state.loggedIn, true, '假 checkLogin 返回已登录，快照应同步');
  assert.equal(state.courses.length, 1);
  assert.equal(state.courses[0].name, COURSE.name);

  const experimentsState = await post(base, token, { action: 'select-course', courseId: COURSE.id, answersOnly: true, skipExisting: false }).then(() =>
    waitForPhase(base, token, (item) => item.phase === 'waiting-experiments')
  );
  assert.equal(engine.answersOnly, true, '自动启动后选课时也必须应用答案模式');
  assert.equal(engine.skipExisting, false);
  assert.equal(experimentsState.experiments.length, 1, 'is_shixun=false 必须被过滤');
  assert.equal(experimentsState.experiments[0].name, 'CNN');

  const levelsState = await post(base, token, { action: 'select-experiments', indices: [0], answersOnly: false }).then(() =>
    waitForPhase(base, token, (item) => item.phase === 'waiting-levels')
  );
  assert.equal(engine.answersOnly, false, '选实验时可显式切回题目模式');
  assert.equal(engine.skipExisting, false, '未传模式字段时应保留当前值');
  assert.equal(levelsState.levels.length, 2);
  assert.equal(levelsState.levels[0].type, 'code');

  await post(base, token, { action: 'select-levels', identifiers: ['conv', 'pool'], skipExisting: true });
  assert.equal(engine.answersOnly, false);
  assert.equal(engine.skipExisting, true, '选关卡时也可显式设置已有内容策略');

  // 引擎在抓取前会先读关卡列表、再用 prev_game 回溯确认入口，允许更宽的等待。
  const finished = await waitForPhase(base, token, (item) => item.done || item.phase === 'error', 90000);
  assert.equal(finished.phase, 'done', `应以 done 结束，实际 ${finished.phase}：${finished.message}`);
  assert.equal(finished.done.saved, 2);
  assert.equal(finished.done.failed, 0);

  const courseDir = path.join(finished.done.exportRoot, COURSE.name, 'CNN');
  const experimentMd = path.join(courseDir, 'CNN.md');
  assert.ok(fs.existsSync(experimentMd), `应生成 ${experimentMd}`);
  const firstDocument = fs.readFileSync(experimentMd, 'utf8');
  assert.match(firstDocument, /## 初始代码/, '编程题应带初始代码');
  assert.match(firstDocument, /^## 第1关：conv/m, '整个实验写在一个文件里');
  assert.ok(fs.existsSync(path.join(courseDir, 'CNN.metadata.json')), '应有实验级 metadata.json');
  const before = firstDocument;

  // 第二轮的完成信号：直接捕获 engine.run() 的 promise（轮询 running 会漏掉
  // 已经跑完的情况——假 Playwright 下整轮只需几百毫秒）。
  let secondRunPromise = null;
  const originalRun = engine.run.bind(engine);
  engine.run = (...args) => {
    secondRunPromise = originalRun(...args);
    return secondRunPromise;
  };
  await post(base, token, { action: 'start' });
  const secondCourse = await waitForPhase(base, token, (item) => item.phase === 'waiting-course', 30000);
  assert.equal(secondCourse.phase, 'waiting-course', '第二轮必须能重新进入课程选择（不能是一次性）');
  assert.equal(secondCourse.courses.length, 1, '第二轮应重新读到课程列表');

  await post(base, token, { action: 'select-course', courseId: COURSE.id });
  await waitForPhase(base, token, (item) => item.phase === 'waiting-experiments', 30000);
  await post(base, token, { action: 'select-experiments', indices: [0] });
  await waitForPhase(base, token, (item) => item.phase === 'waiting-levels', 30000);
  await post(base, token, { action: 'select-levels', identifiers: ['conv', 'pool'] });

  assert.ok(secondRunPromise, '第二轮必须真的启动（不能是一次性）');
  await secondRunPromise;
  const secondStats = { ...engine.stats };
  assert.equal(secondStats.saved, 0, '第二轮两关都已存在，不应重复写入');
  assert.equal(secondStats.existing, 2, '第二轮应识别出 2 关已存在');
  assert.equal(secondStats.failed, 0);
  assert.equal(fs.readFileSync(experimentMd, 'utf8'), before, '第二轮不得覆盖已存在的产物');

  // 停止动作必须幂等且不抛错
  await post(base, token, { action: 'stop' });
  await engine.stop();
});

test('run.js --ui：diagnose 必须在动作白名单里（否则「诊断」按钮永远 400）', async (t) => {
  const fake = createFakePlaywright();
  const restoreApi = installFakeApi();
  const { runUi } = freshRunModule();
  t.after(() => {
    restoreApi();
    fake.restore();
  });

  const { server, engine } = await runUi({ open: false, headless: true, port: 0, token: 'test-token' });
  t.after(async () => {
    await server.close().catch(() => {});
  });

  const url = new URL(server.url);
  const token = url.searchParams.get('token');
  const base = `${url.protocol}//${url.host}`;
  const call = () => fetch(`${base}/api/action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, action: 'diagnose' })
  });

  // ① 浏览器还没启动 → 必须是「请先点击开始提取」这类可操作提示，而不是「未知动作」。
  const early = await call();
  const earlyPayload = await early.json();
  assert.ok(!/未知动作/.test(earlyPayload.error || ''), 'diagnose 必须已被动作白名单接受');
  assert.match(earlyPayload.error || '', /开始提取|启动浏览器/, '未启动浏览器时应提示先启动');

  // ② 浏览器已启动 → 诊断必须被真正执行并返回结论行（这里用桩替换引擎诊断，只验证 HTTP 链路）。
  engine.context = {};
  engine.diagnose = async () => ({ ok: true, lines: ['诊断开始。当前页面：https://www.educoder.net/'] });
  const response = await call();
  assert.equal(response.status, 200, '浏览器存在时诊断应成功');
  const payload = await response.json();
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.lines, ['诊断开始。当前页面：https://www.educoder.net/'], '诊断结论必须回传');
});

test('run.js --ui：停止之后再开始，不得把上一轮的停止标记带进新一轮（回归）', async (t) => {
  const fake = createFakePlaywright({ withSecondExperiment: true });
  const restoreApi = installFakeApi();
  const { runUi } = freshRunModule();
  t.after(() => {
    restoreApi();
    fake.restore();
  });

  const { server } = await runUi({ open: false, headless: true, port: 0, token: 'test-token' });
  t.after(async () => {
    await server.close().catch(() => {});
  });

  const url = new URL(server.url);
  const token = url.searchParams.get('token');
  const base = `${url.protocol}//${url.host}`;

  // 第一轮：起来之后立刻按「停止」
  await post(base, token, { action: 'start' });
  await waitForPhase(base, token, (item) => item.phase === 'waiting-course', 30000);
  await post(base, token, { action: 'stop' });
  // 等这一轮真正收场（停止后的终态是 stopping），否则第二轮会撞上
  // 「已有提取任务正在运行」。
  await waitForPhase(
    base,
    token,
    (item) => ['stopping', 'done', 'error'].includes(item.phase),
    30000
  );

  // 第二轮：必须能照常走完「选课程 → 选实验 → 读到关卡」。
  // 修复前 `pending.stop` 是**一次性的粘滞标记**：按过一次停止之后，
  // 下一轮会在读关卡列表的第一个停止检查点静默中断，报出
  // 「所选实验都没有返回关卡列表」——与事实相反，然后卡在那里。
  await post(base, token, { action: 'start' });
  await waitForPhase(base, token, (item) => item.phase === 'waiting-course', 30000);
  await post(base, token, { action: 'select-course', courseId: COURSE.id });
  await waitForPhase(base, token, (item) => item.phase === 'waiting-experiments', 30000);
  await post(base, token, { action: 'select-experiments', indices: [0, 1] });

  const levelsState = await waitForPhase(
    base,
    token,
    (item) => item.phase === 'waiting-levels',
    60000
  );
  assert.ok(
    levelsState.levels.length > 0,
    `第二轮必须真的读到关卡，而不是被上一轮的停止标记卡死（实际 ${levelsState.levels.length} 关）`
  );
  assert.ok(
    !/都没有返回关卡列表/.test(levelsState.message || ''),
    '不得报出「所选实验都没有返回关卡列表」这种与事实相反的结论'
  );

  await post(base, token, { action: 'stop' });
});

test('run.js --ui：选多个实验时，关卡区必须一次拿到全部实验的关卡（回归）', async (t) => {
  const fake = createFakePlaywright({ withSecondExperiment: true });
  const restoreApi = installFakeApi();
  const { runUi } = freshRunModule();
  t.after(() => {
    restoreApi();
    fake.restore();
  });

  const { server } = await runUi({ open: false, headless: true, port: 0, token: 'test-token' });
  t.after(async () => {
    await server.close().catch(() => {});
  });

  const url = new URL(server.url);
  const token = url.searchParams.get('token');
  const base = `${url.protocol}//${url.host}`;

  await post(base, token, { action: 'start' });
  await waitForPhase(base, token, (item) => item.phase === 'waiting-course', 30000);
  await post(base, token, { action: 'select-course', courseId: COURSE.id });
  const experimentState = await waitForPhase(base, token, (item) => item.phase === 'waiting-experiments', 30000);
  assert.equal(
    experimentState.experiments.length,
    2,
    `这门课应读到 2 个课堂实验，实际 ${JSON.stringify((experimentState.experiments || []).map((item) => item.name))}`
  );

  // 两个实验都选
  await post(base, token, { action: 'select-experiments', indices: [0, 1] });
  const levelsState = await waitForPhase(
    base,
    token,
    (item) => item.phase === 'waiting-levels' && item.levels.length > 0,
    60000
  );

  // 用户反馈的 bug：修复前 state.levels 只会有「最后一个被读取的实验」的关卡。
  assert.equal(levelsState.levels.length, 4, `两个实验应共 4 关，实际 ${levelsState.levels.length}`);
  assert.deepEqual(
    [...new Set(levelsState.levels.map((level) => level.experimentName))].sort(),
    ['CNN', '模型评估与选择'].sort(),
    '每条关卡都要标注所属实验'
  );
  assert.equal(levelsState.levelsMulti, true, '快照必须标记为多实验合并列表');
  assert.deepEqual(levelsState.levelsExperiments, ['CNN', '模型评估与选择']);
  for (const name of ['conv', 'pool', '欠拟合与过拟合', '留出法等常见评估方法']) {
    assert.ok(
      levelsState.levels.some((level) => level.name === name),
      `列表里必须有「${name}」`
    );
  }

  // 停止，避免用例结束时还有任务在跑
  await post(base, token, { action: 'stop' });
});

test('run.js --ui：/api/answers 汇总答案库与关卡元信息（篡改猴只读接口）', async (t) => {
  const fake = createFakePlaywright();
  const restoreApi = installFakeApi();
  const exportRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'touge-answers-'));
  const previousExport = process.env.EDUCODER_EXPORT_ROOT;
  process.env.EDUCODER_EXPORT_ROOT = exportRoot;

  // 造实验答案文件与关卡存档
  const dirA = path.join(exportRoot, '课程', '实验A', 'answers');
  fs.mkdirSync(dirA, { recursive: true });
  fs.writeFileSync(
    path.join(dirA, '实验A.answers.json'),
    JSON.stringify({
      answers: [
        { level_id: 'L001', kind: 'code', language: 'python', answer: 'print(1)', explain: 'x' },
        { level_id: 'L002', kind: 'choice', answers: [{ question: 1, answer: ['A'], brief: 'y' }] }
      ]
    }),
    'utf8'
  );
  // 关卡存档：提供「平台关卡标识 → L001」的映射。
  // 篡改猴在关卡页上只能拿到 URL 里的标识，而答案是按 L001 汇总的；
  // 没有这张表两边永远对不上，会出现「答案拉到了但一关都用不上」。
  fs.writeFileSync(
    path.join(exportRoot, '课程', '实验A', 'levels.jsonl'),
    [
      JSON.stringify({ taskIndex: 1, title: 'conv', source: 'https://www.educoder.net/tasks/conv?homework_common_id=1' }),
      // 三段式 URL：只有最后一段才是关卡标识；顺带带一道选择题的选项个数，
      // 供 /api/answers 把 optionCounts 传给脚本（脚本靠它切分题目）
      JSON.stringify({
        taskIndex: 2,
        title: 'tri',
        source: 'https://www.educoder.net/tasks/zqf25f66/88000005/zq94fa325',
        choiceQuestions: [{ options: ['甲', '乙', '丙', '丁'] }, { options: ['一', '二'] }]
      })
    ].join('\n') + '\n',
    'utf8'
  );

  const { runUi } = freshRunModule();
  t.after(() => {
    restoreApi();
    fake.restore();
    if (previousExport === undefined) delete process.env.EDUCODER_EXPORT_ROOT;
    else process.env.EDUCODER_EXPORT_ROOT = previousExport;
    fs.rmSync(exportRoot, { recursive: true, force: true });
  });

  const { server } = await runUi({ open: false, headless: true, port: 0, token: 'test-token' });
  t.after(async () => {
    await server.close().catch(() => {});
  });
  const url = new URL(server.url);
  const token = url.searchParams.get('token');
  const base = `${url.protocol}//${url.host}`;

  const denied = await fetch(`${base}/api/answers`);
  assert.equal(denied.status, 403, '/api/answers 也必须校验 token');

  const response = await fetch(`${base}/api/answers?token=${token}`);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.ok, true);
  // 答案与映射都用「课程__实验__level_id」复合键：level_id 只在单个实验内唯一，
  // 多个实验聚合到同一对象时会互相覆盖（曾出现两个实验的 L001 打架）。
  const keyL001 = '课程__实验A__L001';
  const keyL002 = '课程__实验A__L002';
  // v2：编程题答案是对象、选择题是结构化小问；每条都带班级码供油猴核对
  assert.equal(payload.answers[keyL001].answer.code, 'print(1)', '答案按复合键汇总');
  assert.deepEqual(payload.answers[keyL002].answer.questions[0].selected, ['A'], '选择题答案原样带出');
  assert.equal(payload.answers[keyL001].kind, 'code');
  assert.ok('classroomCode' in payload.answers[keyL001], '每条答案都要带班级码');
  assert.equal(Object.hasOwn(payload, 'blueprints'), false, '不再返回提交请求蓝图');
  assert.equal(payload.levelIds.conv, keyL001, '平台关卡标识必须折算成全局唯一键');
  assert.equal(payload.levelIds.zq94fa325, keyL002, '三段式 URL 只取最后一段作标识');
  assert.deepEqual(payload.optionCounts[keyL002], [4, 2], '选择题每道题的选项个数要传给脚本，供它切分题目');
  // 平台重新发布实验会换掉一整组关卡标识（本地 kbfiscelzp9a / 页面 v4nyrg6lex7q），
  // 这时只能按内容兜底匹配，所以要给脚本一张「实验名__关卡名」表。
  assert.equal(payload.titleIds['实验A__conv'], keyL001, '兜底表：实验名__关卡名 → 复合键');
  assert.equal(payload.titleIds['实验A__tri'], keyL002);

  // 篡改猴提交通过后回传答案：控制台写进 exports/answers/{课程}__{实验}.answers.json
  const deniedAnswer = await fetch(`${base}/api/answer/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: 'conv', kind: 'code', answer: 'print(3)' })
  });
  assert.equal(deniedAnswer.status, 403, '/api/answer/save 也必须校验 token');

  // 没被抓取过的关卡：必须明确报「不知道它属于哪个课程/实验」，而不是猜一个目录写进去
  const unknown = await fetch(`${base}/api/answer/save?token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: 'never-captured', kind: 'code', answer: 'print(3)' })
  });
  assert.equal(unknown.status, 400);
  assert.match((await unknown.json()).error, /抓取/, '报错要告诉用户先抓取该实验');

  const postedAnswer = await fetch(`${base}/api/answer/save?token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: 'zq94fa325', kind: 'choice', answer: '1:A;2:B' })
  });
  assert.equal(postedAnswer.status, 200);
  const answerResult = await postedAnswer.json();
  assert.equal(answerResult.ok, true);
  assert.equal(answerResult.levelId, 'L002', '关卡号由控制台的映射表算出，而不是信脚本传的');
  assert.equal(answerResult.course, '课程');
  assert.equal(answerResult.experiment, '实验A');
  // v2：答案按班级分目录
  assert.equal(answerResult.path, path.join('answers', '课程（zqf25f66）', '实验A.answers.json'));

  const storedAnswers = JSON.parse(
    fs.readFileSync(path.join(exportRoot, 'answers', '课程（zqf25f66）', '实验A.answers.json'), 'utf8')
  );
  assert.equal(storedAnswers.schema_version, 2);
  assert.equal(storedAnswers.classroom.name, '课程');
  assert.equal(storedAnswers.experiment.name, '实验A');
  assert.deepEqual(
    storedAnswers.answers.map((item) => [item.level_id, item.kind, item.answer.questions]),
    [['L002', 'choice', [{ number: 1, selected: ['A'] }, { number: 2, selected: ['B'] }]]],
    '回传的答案要按 v2 结构化落盘'
  );
  assert.equal(storedAnswers.answers[0].task_identifier, 'zq94fa325', '平台关卡标识要落盘');
  assert.equal(storedAnswers.answers[0].source, 'platform');
  assert.equal(storedAnswers.answers[0].verified, true, '提交通过才回传，属于已验证');

  // 升级到 v2 之后，旧位置的扁平/实验目录答案文件**不会自动消失**。
  // 两份都读进来时 v2 必须优先——否则旧快照会把刚写进去的新答案盖回去。
  // 这里旧文件里 L002 只有第 1 问（['A']），v2 里是两问，正好能区分。
  const afterSave = await (await fetch(`${base}/api/answers?token=${token}`)).json();
  assert.deepEqual(
    afterSave.answers['课程__实验A__L002'].answer.questions,
    [{ number: 1, selected: ['A'] }, { number: 2, selected: ['B'] }],
    'L002 必须取 v2 里的新版，而不是旧文件里的快照'
  );
  assert.equal(
    afterSave.answers['课程__实验A__L001'].answer.code,
    'print(1)',
    '只存在于旧文件里的关卡仍要能读到（兼容不能丢）'
  );

  // 标识对不上时的兜底：平台重新发布实验会换掉一整组关卡标识（本地 kbfiscelzp9a、
  // 页面 v4nyrg6lex7q 这种）。此时脚本带上关卡名，控制台按内容匹配回正确的关卡。
  const byTitle = await fetch(`${base}/api/answer/save?token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: 'brand-new-id', levelName: 'tri', kind: 'choice', answer: '1:C;2:D' })
  });
  assert.equal(byTitle.status, 200, '标识对不上时也要能按关卡名兜底，而不是直接拒收');
  const byTitleResult = await byTitle.json();
  assert.equal(byTitleResult.levelId, 'L002', '按关卡名匹配回正确的关卡号');
  assert.equal(byTitleResult.course, '课程');

  // 关卡名对不上（或重名被丢弃）时仍然要明确报错，绝不猜一个目录写进去
  const stillUnknown = await fetch(`${base}/api/answer/save?token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: 'never-seen-again', levelName: '根本不存在的关卡名', kind: 'code', answer: 'x' })
  });
  assert.equal(stillUnknown.status, 400);
  assert.match((await stillUnknown.json()).error, /抓取/, '兜底也失败时要提示先抓取该实验');

  // 日志落盘：面板里日志一多就没法看，脚本把它传回来写成文件，用编辑器翻。
  // 是**追加**写，每段带「第 N 次写入」标题，方便定位每次导出。
  const logResponse = await fetch(`${base}/api/log?token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '篡改猴日志', lines: ['[ok] 第一行', '[warn] 第二行'] })
  });
  assert.equal(logResponse.status, 200);
  const logResult = await logResponse.json();
  assert.equal(logResult.ok, true);
  assert.equal(logResult.lines, 2);
  assert.equal(logResult.seq, 1, '第一次写入编号应为 1');
  const logFile = path.join(exportRoot, 'logs', '篡改猴日志.log');
  assert.ok(fs.existsSync(logFile), '日志应写成文件');
  assert.match(fs.readFileSync(logFile, 'utf8'), /第 1 次写入/);
  assert.match(fs.readFileSync(logFile, 'utf8'), /第一行/);

  // 第二次导出必须**追加**（不能覆盖），编号递增
  const secondLog = await fetch(`${base}/api/log?token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '篡改猴日志', lines: ['[ok] 第三次导出的新行'] })
  });
  const secondResult = await secondLog.json();
  assert.equal(secondResult.seq, 2, '第二次写入编号应为 2');
  const logText = fs.readFileSync(logFile, 'utf8');
  assert.match(logText, /第一行/, '追加不能把第一次的内容冲掉');
  assert.match(logText, /第三次导出的新行/);
  assert.match(logText, /第 2 次写入/, '两段标题都要在');

  // 文件名里的路径分隔符必须被净化，不能穿越目录
  const badName = await fetch(`${base}/api/log?token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '../../evil', lines: ['x'] })
  });
  assert.equal(badName.status, 200);
  const badResult = await badName.json();
  // 真正的安全属性：解析后的绝对路径必须仍在 logs 目录内（名字里的分隔符已被净化）
  const evilAbs = path.resolve(exportRoot, badResult.path);
  assert.ok(
    evilAbs.startsWith(path.resolve(exportRoot, 'logs') + path.sep),
    `日志必须落在 logs 目录内，实际 ${evilAbs}`
  );

  // 实验目录名带「[分类] 」前缀时，控制台必须**额外**建一个「去掉前缀的实验名__关卡名」的键。
  // 脚本从教学课程拿到的是平台侧实验名（「需求分析的基本概念」），不带「[4、需求分析与结构化分析] 」
  // 前缀；只建完整目录名的键，两边就永远对不上（实测就是这么漏掉 5 个关卡的）。
  const bracketDir = path.join(exportRoot, '课程', '[1、分类] 实验B');
  fs.mkdirSync(path.join(bracketDir, 'answers'), { recursive: true });
  fs.writeFileSync(
    path.join(bracketDir, 'levels.jsonl'),
    `${JSON.stringify({ taskIndex: 1, title: '专项题', source: 'https://www.educoder.net/tasks/zzz111?homework_common_id=9' })}\n`,
    'utf8'
  );
  fs.writeFileSync(
    path.join(bracketDir, 'answers', '实验B.answers.json'),
    JSON.stringify({ course: '课程', experiment: '[1、分类] 实验B', answers: [{ level_id: 'L001', kind: 'choice', answer: '1:A' }] }),
    'utf8'
  );
  const withBracket = await (await fetch(`${base}/api/answers?token=${token}`)).json();
  assert.equal(
    withBracket.titleIds['[1、分类] 实验B__专项题'],
    '课程__[1、分类] 实验B__L001',
    '完整目录名的键要在'
  );
  assert.equal(
    withBracket.titleIds['实验B__专项题'],
    '课程__[1、分类] 实验B__L001',
    '去掉分类前缀的键也要有（脚本用的是平台侧实验名）'
  );
});

test('run.js --ui：Agent 目录与说明只读，旧模型端点已移除且不会访问模型', async (t) => {
  const fake = createFakePlaywright();
  const restoreApi = installFakeApi();
  const exportRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'touge-agent-ui-'));
  const previousExport = process.env.EDUCODER_EXPORT_ROOT;
  process.env.EDUCODER_EXPORT_ROOT = exportRoot;
  const experimentDir = path.join(exportRoot, '课程A', '实验B');
  fs.mkdirSync(experimentDir, { recursive: true });
  fs.writeFileSync(path.join(experimentDir, 'levels.jsonl'), `${JSON.stringify({
    taskIndex: 1, title: 'conv', type: 'code', course: '课程A', experiment: '实验B',
    source: 'https://www.educoder.net/tasks/conv', codeLanguage: 'python'
  })}\n`, 'utf8');

  const originalFetch = global.fetch;
  const unexpectedRequests = [];
  global.fetch = (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.hostname !== '127.0.0.1') {
      unexpectedRequests.push(url.href);
      throw new Error(`测试禁止外网请求：${url.hostname}`);
    }
    return originalFetch(input, init);
  };
  const { runUi } = freshRunModule();
  t.after(() => {
    global.fetch = originalFetch;
    restoreApi();
    fake.restore();
    if (previousExport === undefined) delete process.env.EDUCODER_EXPORT_ROOT;
    else process.env.EDUCODER_EXPORT_ROOT = previousExport;
    fs.rmSync(exportRoot, { recursive: true, force: true });
  });
  const { server } = await runUi({ open: false, headless: true, port: 0, token: 'test-token' });
  t.after(() => server.close());
  const url = new URL(server.url);
  const token = url.searchParams.get('token');
  const base = url.origin;

  for (const endpoint of ['/api/agent/targets', '/api/agent/guide']) {
    assert.equal((await fetch(`${base}${endpoint}`)).status, 403, '未带 token 必须拒绝');
    assert.equal((await fetch(`${base}${endpoint}?token=${token}`, {
      headers: { Origin: 'https://untrusted.example' }
    })).status, 403, '有 token 的跨站请求仍须拒绝');
    assert.equal((await fetch(`${base}${endpoint}?token=${token}`, { method: 'POST' })).status, 405);
  }
  const targets = await (await fetch(`${base}/api/agent/targets?token=${token}`)).json();
  assert.deepEqual(Object.keys(targets), ['courses']);
  assert.equal(targets.courses[0].name, '课程A');
  const experiment = targets.courses[0].experiments[0];
  assert.equal(experiment.name, '实验B');
  assert.deepEqual(experiment.levels.map((level) => level.id), ['L001']);
  assert.equal(experiment.mdPath, path.join(experimentDir, '实验B.md'));
  const guide = await fetch(`${base}/api/agent/guide?token=${token}`);
  assert.equal(guide.status, 200);
  assert.match(guide.headers.get('content-type'), /text\/markdown/);
  assert.match(guide.headers.get('content-disposition'), /attachment.*AGENT-ANSWERING\.md/);
  assert.equal(await guide.text(), fs.readFileSync(path.join(__dirname, '..', 'docs', 'AGENT-ANSWERING.md'), 'utf8'));

  for (const endpoint of ['/api/answer/run', '/api/answer/stop', '/api/answer/config', '/api/answer/targets', '/api/blueprint']) {
    const response = await fetch(`${base}${endpoint}?token=${token}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, course: '课程A', experiments: ['实验B'], apiKey: 'unused' })
    });
    assert.equal(response.status, 404, `${endpoint} 已删除`);
  }
  const state = await (await fetch(`${base}/api/state?token=${token}`)).json();
  assert.equal(Object.hasOwn(state, 'ai'), false);
  assert.equal(Object.hasOwn(state, 'answer'), false);
  assert.deepEqual(unexpectedRequests, [], '启动与只读工作流不可调用模型或访问外网');
});

test('run.js --ui：select-course 使用无效 id 时返回 4xx', async (t) => {
  const fake = createFakePlaywright();
  const restoreApi = installFakeApi();
  const { runUi } = freshRunModule();
  t.after(() => {
    restoreApi();
    fake.restore();
  });

  const { server } = await runUi({ open: false, headless: true, port: 0, token: 'test-token' });
  t.after(async () => {
    await server.close().catch(() => {});
  });

  const url = new URL(server.url);
  const token = url.searchParams.get('token');
  const base = `${url.protocol}//${url.host}`;

  const response = await fetch(`${base}/api/action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, action: 'select-course', courseId: 999999 })
  });
  assert.ok(response.status >= 400, '无效课程 id 必须返回 4xx');
  const payload = await response.json();
  assert.equal(payload.ok, false);
  assert.ok(payload.error);
});

test('控制台：仅答案存档可读取、回传更新并导出班级文件，不依赖题目目录', async (t) => {
  const exportRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'touge-answer-only-ui-'));
  const previousExport = process.env.EDUCODER_EXPORT_ROOT;
  process.env.EDUCODER_EXPORT_ROOT = exportRoot;
  t.after(() => {
    if (previousExport === undefined) delete process.env.EDUCODER_EXPORT_ROOT;
    else process.env.EDUCODER_EXPORT_ROOT = previousExport;
    fs.rmSync(exportRoot, { recursive: true, force: true });
  });
  const answerPath = path.join(exportRoot, 'answers', '数据库（MYSQL01）', 'Insert,Update,Delete.answers.json');
  fs.mkdirSync(path.dirname(answerPath), { recursive: true });
  fs.writeFileSync(answerPath, JSON.stringify({
    schema_version: 2,
    classroom: { name: '数据库', code: 'MYSQL01' },
    experiment: { name: 'Insert,Update,Delete', homework_id: 99 },
    answers: [{
      level_id: 'L001', title: '插入数据', task_identifier: 'insert-task', kind: 'code', source: 'platform', verified: true,
      answer: { language: 'sql', code: 'INSERT INTO student VALUES (1);' }
    }]
  }), 'utf8');
  const { startUiServer } = require('../extractor/ui/server');
  const server = await startUiServer({ open: false, token: 'test-token', onControl: async () => ({ ok: true }) });
  t.after(() => server.close());
  const base = new URL(server.url).origin;
  const token = 'test-token';
  const targets = await (await fetch(`${base}/api/agent/targets?token=${token}`)).json();
  assert.equal(targets.courses[0].experiments[0].mdPath, '');
  assert.equal(targets.courses[0].experiments[0].answered, 1);
  const before = await (await fetch(`${base}/api/answers?token=${token}`)).json();
  const key = before.levelIds['insert-task'];
  assert.ok(key, '答案文档中的平台标识也应进入映射');
  assert.equal(before.answers[key].classroomCode, 'MYSQL01');
  assert.equal(before.answers[key].homeworkId, 99);

  const saved = await fetch(`${base}/api/answer/save?token=${token}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: 'insert-task', classroomCode: 'MYSQL01', kind: 'code', language: 'sql', answer: 'INSERT INTO student VALUES (2);' })
  });
  assert.equal(saved.status, 200);
  assert.equal(JSON.parse(fs.readFileSync(answerPath, 'utf8')).answers[0].answer.code, 'INSERT INTO student VALUES (2);');

  const exported = await post(base, token, { action: 'export-class-answers', grade: '2026级', className: '数据库班' });
  assert.equal(exported.ok, true, exported.message);
  assert.equal(exported.stats.answered, 1);
  const document = JSON.parse(fs.readFileSync(exported.path, 'utf8'));
  assert.equal(document.classrooms[0].code, 'MYSQL01');
  assert.equal(document.classrooms[0].experiments[0].homework_id, 99);
  assert.equal(document.classrooms[0].experiments[0].levels[0].answer.code, 'INSERT INTO student VALUES (2);');
});

test('控制台：同名课堂答案保持独立，重复平台标识不给出有歧义的映射', async (t) => {
  const exportRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'touge-identity-ui-'));
  const previousExport = process.env.EDUCODER_EXPORT_ROOT;
  process.env.EDUCODER_EXPORT_ROOT = exportRoot;
  t.after(() => {
    if (previousExport === undefined) delete process.env.EDUCODER_EXPORT_ROOT;
    else process.env.EDUCODER_EXPORT_ROOT = previousExport;
    fs.rmSync(exportRoot, { recursive: true, force: true });
  });
  for (const code of ['A', 'B']) {
    const file = path.join(exportRoot, 'answers', `同名课程（${code}）`, '实验.answers.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      schema_version: 2, classroom: { name: '同名课程', code }, experiment: { name: '实验', homework_id: 10 },
      answers: [
        { level_id: 'L001', task_identifier: `task-${code}`, kind: 'code', answer: { code, language: 'sql' } },
        { level_id: 'L002', task_identifier: 'shared-task', title: '重名关卡', kind: 'code', answer: { code, language: 'sql' } }
      ]
    }));
  }
  const { startUiServer } = require('../extractor/ui/server');
  const server = await startUiServer({ open: false, token: 'test-token' });
  t.after(() => server.close());
  const base = new URL(server.url).origin;
  const payload = await (await fetch(`${base}/api/answers?token=test-token`)).json();
  assert.equal(Object.keys(payload.answers).length, 4, '两个班的答案不能互相覆盖');
  assert.equal(payload.answers[payload.levelIds['task-A']].answer.code, 'A');
  assert.equal(payload.answers[payload.levelIds['task-B']].answer.code, 'B');
  assert.equal(payload.levelIds['shared-task'], undefined, '跨班重名标识应明确标为歧义');
  assert.equal(payload.titleOnlyIds['重名关卡'], undefined);
});

test('班级导出：已有文件损坏或新答案校验失败时，HTTP 与 CLI 均不覆盖文件', async (t) => {
  const exportRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'touge-class-protect-'));
  const previousExport = process.env.EDUCODER_EXPORT_ROOT;
  process.env.EDUCODER_EXPORT_ROOT = exportRoot;
  t.after(() => {
    if (previousExport === undefined) delete process.env.EDUCODER_EXPORT_ROOT;
    else process.env.EDUCODER_EXPORT_ROOT = previousExport;
    fs.rmSync(exportRoot, { recursive: true, force: true });
  });
  const answerPath = path.join(exportRoot, 'answers', '课程（A）', '实验.answers.json');
  fs.mkdirSync(path.dirname(answerPath), { recursive: true });
  const work = {
    schema_version: 2, classroom: { name: '课程', code: 'A' }, experiment: { name: '实验', homework_id: 10 },
    answers: [{ level_id: 'L001', kind: 'code', answer: { code: 'SELECT 1;', language: 'sql' } }]
  };
  fs.writeFileSync(answerPath, JSON.stringify(work));
  const identity = { grade: '2026级', className: '测试班' };
  const classPath = require('../extractor/lib/class-answers').classAnswersPathFor(exportRoot, identity);
  fs.writeFileSync(classPath, '{"important":"原文件不完整');
  const { startUiServer } = require('../extractor/ui/server');
  const server = await startUiServer({ open: false, token: 'test-token', onControl: async () => ({ ok: true }) });
  t.after(() => server.close());
  const base = new URL(server.url).origin;
  const request = () => fetch(`${base}/api/action?token=test-token`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'export-class-answers', ...identity })
  });
  const cli = () => require('node:child_process').spawnSync(process.execPath, [
    path.join(__dirname, '..', 'tools', 'build-class-answers.js'), `--grade=${identity.grade}`, `--class=${identity.className}`
  ], { env: process.env, encoding: 'utf8', windowsHide: true });
  const corruptResponse = await request();
  assert.equal(corruptResponse.status, 400);
  assert.match((await corruptResponse.json()).error, /保留原文件/);
  assert.equal(cli().status, 1);
  assert.equal(fs.readFileSync(classPath, 'utf8'), '{"important":"原文件不完整');

  fs.rmSync(classPath);
  work.answers[0].answer.code = '';
  fs.writeFileSync(answerPath, JSON.stringify(work));
  const invalidResponse = await request();
  const result = await invalidResponse.json();
  assert.equal(result.ok, false);
  assert.match(result.message, /校验失败.*未写入/);
  assert.equal(cli().status, 1);
  assert.equal(fs.existsSync(classPath), false, '校验失败不可发布一份损坏的班级文件');
});

