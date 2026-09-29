/**
 * 端到端测试：真实 HTTP + SSE 驱动 run.js --ui 的完整流程。
 * 用假 Playwright 替换浏览器层，因此不触网、不需要头歌账号。
 *
 * 覆盖：控制台启动 → 取快照 → 选课程 → 选实验 → 选关卡 → 开始 → 收到 done 事件 → 产物落盘。
 *
 * 运行：node --test "test/**\/*.test.js"
 */
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
          body = JSON.stringify(
            withSecondExperiment && parsed.pathname.includes('zq655f1e') ? CHALLENGES_B : CHALLENGES
          );
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

  const { server, engine } = await runUi({ open: false, headless: true });
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

  const experimentsState = await post(base, token, { action: 'select-course', courseId: COURSE.id }).then(() =>
    waitForPhase(base, token, (item) => item.phase === 'waiting-experiments')
  );
  assert.equal(experimentsState.experiments.length, 1, 'is_shixun=false 必须被过滤');
  assert.equal(experimentsState.experiments[0].name, 'CNN');

  const levelsState = await post(base, token, { action: 'select-experiments', indices: [0] }).then(() =>
    waitForPhase(base, token, (item) => item.phase === 'waiting-levels')
  );
  assert.equal(levelsState.levels.length, 2);
  assert.equal(levelsState.levels[0].type, 'code');

  await post(base, token, { action: 'select-levels', identifiers: ['conv', 'pool'] });

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

  const { server, engine } = await runUi({ open: false, headless: true });
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

test('run.js --ui：选多个实验时，关卡区必须一次拿到全部实验的关卡（回归）', async (t) => {
  const fake = createFakePlaywright({ withSecondExperiment: true });
  const restoreApi = installFakeApi();
  const { runUi } = freshRunModule();
  t.after(() => {
    restoreApi();
    fake.restore();
  });

  const { server } = await runUi({ open: false, headless: true });
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

test('run.js --ui：/api/answers 汇总答案库与提交蓝图（篡改猴只读接口）', async (t) => {
  const fake = createFakePlaywright();
  const restoreApi = installFakeApi();
  const exportRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'touge-answers-'));
  const previousExport = process.env.EDUCODER_EXPORT_ROOT;
  process.env.EDUCODER_EXPORT_ROOT = exportRoot;

  // 造两个实验的答案文件 + 一个提交蓝图
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
  fs.writeFileSync(
    path.join(exportRoot, '课程', '实验A', 'submit.blueprint.json'),
    JSON.stringify({ key: 'POST https://data.educoder.net/api/x', method: 'POST', url: 'https://data.educoder.net/api/x' }),
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

  const { server } = await runUi({ open: false, headless: true });
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
  assert.equal(payload.answers[keyL001].answer, 'print(1)', '答案按复合键汇总');
  assert.deepEqual(payload.answers[keyL002].answers[0].answer, ['A'], '选择题答案原样带出');
  assert.equal(payload.blueprints.length, 1, '提交蓝图要一并返回');
  assert.equal(payload.blueprints[0].method, 'POST');
  assert.equal(payload.levelIds.conv, keyL001, '平台关卡标识必须折算成全局唯一键');
  assert.equal(payload.levelIds.zq94fa325, keyL002, '三段式 URL 只取最后一段作标识');
  assert.deepEqual(payload.optionCounts[keyL002], [4, 2], '选择题每道题的选项个数要传给脚本，供它切分题目');
  // 平台重新发布实验会换掉一整组关卡标识（本地 kbfiscelzp9a / 页面 v4nyrg6lex7q），
  // 这时只能按内容兜底匹配，所以要给脚本一张「实验名__关卡名」表。
  assert.equal(payload.titleIds['实验A__conv'], keyL001, '兜底表：实验名__关卡名 → 复合键');
  assert.equal(payload.titleIds['实验A__tri'], keyL002);

  // 篡改猴录制到提交请求后回传蓝图：控制台要把它写进对应实验目录
  const blueprintFile = path.join(exportRoot, '课程', '实验A', 'submit.blueprint.json');
  const deniedPost = await fetch(`${base}/api/blueprint`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ levelId: 'conv', url: 'https://data.educoder.net/api/tasks/conv/submit.json' })
  });
  assert.equal(deniedPost.status, 403, '/api/blueprint 也必须校验 token');

  const posted = await fetch(`${base}/api/blueprint?token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      levelId: 'conv',
      url: 'https://data.educoder.net/api/tasks/conv/submit.json',
      method: 'POST',
      body: '{"code":"print(2)"}'
    })
  });
  assert.equal(posted.status, 200);
  const saved = await posted.json();
  assert.equal(saved.ok, true);
  assert.equal(saved.matchedLevel, true, '关卡标识应能定位到实验目录');
  assert.match(saved.path, /submit\.blueprint\.json$/);

  const stored = JSON.parse(fs.readFileSync(blueprintFile, 'utf8'));
  assert.ok(Array.isArray(stored), '蓝图以数组形式落盘（与篡改猴的 state.templates 同构）');
  assert.ok(
    stored.some((item) => item.url.includes('/submit.json')),
    '回传的蓝图要落进实验目录'
  );
  assert.ok(stored.some((item) => item.url === 'https://data.educoder.net/api/x'), '原有的蓝图不能被覆盖掉');

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
  assert.equal(answerResult.path, path.join('answers', '课程__实验A.answers.json'));

  const storedAnswers = JSON.parse(
    fs.readFileSync(path.join(exportRoot, 'answers', '课程__实验A.answers.json'), 'utf8')
  );
  assert.equal(storedAnswers.course, '课程');
  assert.equal(storedAnswers.experiment, '实验A');
  assert.deepEqual(
    storedAnswers.answers,
    [{ level_id: 'L002', kind: 'choice', answer: '1:A;2:B' }],
    '回传的答案要按规范格式落盘'
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
    body: JSON.stringify({ identifier: 'brand-new-id', levelName: '根本不存在的关卡名', kind: 'code', answer: 'x' })
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

test('run.js --ui：AI 作答接口（列出目标 / 启动 / 错误落进快照）', async (t) => {
  const fake = createFakePlaywright();
  const restoreApi = installFakeApi();
  const exportRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'touge-answer-ui-'));
  const previousExport = process.env.EDUCODER_EXPORT_ROOT;
  process.env.EDUCODER_EXPORT_ROOT = exportRoot;

  // 造一份关卡存档，让 /api/answer/targets 有东西可列
  const experimentDir = path.join(exportRoot, '课程A', '实验B');
  fs.mkdirSync(experimentDir, { recursive: true });
  fs.writeFileSync(
    path.join(experimentDir, 'levels.jsonl'),
    `${JSON.stringify({
      taskIndex: 1,
      title: 'conv',
      level: '第1关_conv',
      type: 'code',
      course: '课程A',
      experiment: '实验B',
      source: 'u',
      taskDescription: '实现卷积。',
      programmingRequirements: '补充代码。',
      starterCode: '',
      codeLanguage: 'python',
      choices: [],
      choiceQuestions: [],
      imageMap: {},
      images: [],
      contentHash: 'h'
    })}\n`,
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

  const { server } = await runUi({ open: false, headless: true });
  t.after(async () => {
    await server.close().catch(() => {});
  });
  const url = new URL(server.url);
  const token = url.searchParams.get('token');
  const base = `${url.protocol}//${url.host}`;

  const denied = await fetch(`${base}/api/answer/targets`);
  assert.equal(denied.status, 403, '未带 token 必须 403');

  const targets = await (await fetch(`${base}/api/answer/targets?token=${token}`)).json();
  assert.equal(targets.ok, true);
  assert.equal(targets.courses.length, 1);
  assert.equal(targets.courses[0].name, '课程A');
  assert.equal(targets.courses[0].experiments[0].name, '实验B');
  assert.deepEqual(targets.courses[0].experiments[0].levels.map((level) => level.id), ['L001']);

  const missingKey = await fetch(`${base}/api/answer/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, course: '课程A', experiments: ['实验B'] })
  });
  assert.equal(missingKey.status, 400, '缺 API Key 要 400');
  assert.match((await missingKey.json()).error, /API Key/);

  // 启动一次（会因为没有存档而失败，但整条链路要跑通并把错误落进快照）
  const started = await fetch(`${base}/api/answer/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, course: '课程A', experiments: ['不存在的实验'], apiKey: 'test-key' })
  });  assert.equal(started.status, 200);
  assert.equal((await started.json()).started, true);

  const deadline = Date.now() + 10000;
  let state = null;
  while (Date.now() < deadline) {
    state = await (await fetch(`${base}/api/state?token=${token}`)).json();
    if (state.answer && state.answer.done >= 1 && !state.answer.running) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(state.answer, '快照里要有 answer 状态');
  assert.equal(state.answer.done, 1, `任务应结束，实际 ${JSON.stringify(state.answer)}`);
  assert.match(state.answer.results[0].error || '', /没有关卡存档/);
});

test('run.js --ui：select-course 使用无效 id 时返回 4xx', async (t) => {
  const fake = createFakePlaywright();
  const restoreApi = installFakeApi();
  const { runUi } = freshRunModule();
  t.after(() => {
    restoreApi();
    fake.restore();
  });

  const { server } = await runUi({ open: false, headless: true });
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
