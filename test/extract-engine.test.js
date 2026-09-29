/**
 * 引擎集成测试：用假的 Playwright 驱动完整流水线（登录 → 课程 → 实验 → 关卡 → 落盘）。
 * 不触网、不需要头歌账号，可在 CI/干净 checkout 上运行。
 *
 * 运行：node --test test/
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');

const BASE64 = (value) => Buffer.from(value, 'utf8').toString('base64');

// ---------------------------------------------------------------- 假数据

const COURSE_A = {
  id: 120386,
  name: '机器学习_2026年下半年',
  school: '河南农业大学',
  members_count: 649,
  homework_commons_count: 41,
  is_end: false,
  first_category_url: '/classrooms/HCEAP94S/announcement'
};
const COURSE_B = {
  id: 120586,
  name: '网络编程技术-26-27第一学期',
  school: '河南农业大学',
  members_count: 60,
  homework_commons_count: 5,
  is_end: false,
  first_category_url: '/classrooms/vx58gtjp/announcement'
};

const EXPERIMENTS = {
  status: 0,
  homeworks: [
    {
      name: 'CNN',
      homework_id: 3965745,
      shixun_identifier: 'k2mqxzlf',
      myshixun_identifier: 'sb5zfhoq8g',
      challenge_count: 2,
      is_shixun: true
    },
    {
      name: '模型评估与选择',
      homework_id: 3965742,
      shixun_identifier: 'j2negfl5',
      myshixun_identifier: '9gu4khxlts',
      challenge_count: 1,
      is_shixun: true
    },
    { name: '这是一次普通作业', homework_id: 1, is_shixun: false }
  ]
};

// 关卡链：conv(编程题) -> pool(编程题) -> quiz(选择题)
const TASKS = {
  conv: {
    challenge: {
      subject: 'conv',
      homework_challenge_index: 1,
      with_code_file: true,
      path: 'conv.py',
      task_pass: '本关任务：实现卷积。\n\n### 任务描述\n\n编写一个实现卷积操作的函数。\n\n### 编程要求\n\n根据提示补充代码。\n\n<p align="center"><img src="/api/attachments/1536226" /></p>'
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
      task_pass: '### 任务描述\n\n实现池化。\n\n### 编程要求\n\n补充池化代码。\n\n### 测试说明\n\n不要保存我。'
    },
    next_game: 'quiz',
    chooses: []
  },
  quiz: {
    challenge: {
      subject: '欠拟合与过拟合',
      homework_challenge_index: 3,
      with_code_file: true,
      path: 'quiz.py',
      task_pass: '### 任务描述\n\n这段不应该出现在选择题里。'
    },
    next_game: null,
    chooses: [
      {
        subject: '![,](/api/attachments/1550120)\n请问图中处于什么状态？',
        challenge_question: [
          { option_name: '欠拟合，欠拟合' },
          { option_name: '欠拟合，过拟合' },
          { option_name: '' },
          { option_name: '过拟合，过拟合' }
        ]
      },
      { subject: '', challenge_question: [{ option_name: 'A' }] }
    ]
  }
};

const CHALLENGES = [
  { identifier: 'conv', subject: 'conv', homework_challenge_index: 1, with_code_file: true, chooses: [] },
  { identifier: 'pool', subject: 'pool', homework_challenge_index: 2, with_code_file: true, chooses: [] },
  {
    identifier: 'quiz',
    subject: '欠拟合与过拟合',
    homework_challenge_index: 3,
    with_code_file: true,
    chooses: [{ subject: 'q', challenge_question: [{ option_name: 'A' }] }]
  }
];

// ---- 第二个实验（跨实验串台回归用）：自己的关卡链与自己的关卡标识 ----
const EXPERIMENTS_B = {
  status: 0,
  homeworks: [
    { name: 'CNN', homework_id: 3965745, shixun_identifier: 'k2mqxzlf', myshixun_identifier: 'sb5zfhoq8g', challenge_count: 2, is_shixun: true },
    { name: '白盒测试', homework_id: 4157467, shixun_identifier: 'z9uitj5y', myshixun_identifier: 'cccccccccc', challenge_count: 2, is_shixun: true }
  ]
};

const CHALLENGES_B = [
  { identifier: '', subject: '语句覆盖', homework_challenge_index: 1, with_code_file: true },
  { identifier: '', subject: '判定覆盖', homework_challenge_index: 2, with_code_file: true }
];

const TASKS_B = {
  'b1-cover': {
    challenge: {
      subject: '语句覆盖',
      homework_challenge_index: 1,
      with_code_file: true,
      path: 'cover.py',
      task_pass: '### 任务描述\n\n语句覆盖。\n\n### 编程要求\n\n补充代码。'
    },
    prev_game: null,
    next_game: 'b2-cover',
    chooses: []
  },
  'b2-cover': {
    challenge: {
      subject: '判定覆盖',
      homework_challenge_index: 2,
      with_code_file: true,
      path: 'decide.py',
      task_pass: '### 任务描述\n\n判定覆盖。\n\n### 编程要求\n\n补充代码。'
    },
    prev_game: 'b1-cover',
    next_game: null,
    chooses: []
  }
};

// ---------------------------------------------------------------- 假 Playwright

function createFakePage(state) {
  const responseListeners = new Set();
  let replayTimer = null;

  const emit = async (fragment, body) => {
    for (const listener of [...responseListeners]) {
      await listener({
        url: () => fragment,
        status: () => 200,
        ok: () => true,
        async text() {
          return body;
        },
        async json() {
          return JSON.parse(body);
        }
      });
    }
  };

  // 捕获型 listener：模拟「页面自身发出 API 请求」。
  const replay = async () => {
    if (!state.ownResponses) return;
    for (const [fragment, body] of state.ownResponses) await emit(fragment, body);
  };

  // 真实页面在页面存活期间会持续发请求，与「谁在监听」无关。
  // 因此回放必须挂在页面生命周期上，而不是随最后一个 listener 被移除而停止。
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
    async goto(url) {
      state.currentUrl = url;
      state.gotos.push(url);
      await replay();
      return null;
    },
    async reload() {
      state.reloads += 1;
      return null;
    },
    async waitForTimeout() {
      return null;
    },
    async waitForLoadState() {
      return null;
    },
    async close() {
      state.closedPages += 1;
      return null;
    },
    async evaluate(fn, arg) {
      const source = fn.toString();
      // apiGet 传对象 { url, headers }（签名头在 Node 侧算好），图片回调仍传字符串 URL。
      // 顺序敏感：图片回调里也含 fetch(，必须先判 arrayBuffer，否则会被 JSON 分支截走。
      const url = typeof arg === 'string' ? arg : String((arg && arg.url) || '');
      if (url && /arrayBuffer/.test(source)) {
        return state.imageResponse(url);
      }
      if (url && /fetch\s*\(/.test(source)) {
        return state.apiResponse(url);
      }
      return fn(arg);
    },
    /**
     * 引擎用 evaluateHandle 在页面里定位「实验卡片 / 进入关卡按钮」并返回元素句柄
     * （真实 Playwright 里句柄支持 asElement/evaluate/click/dispose）。
     * 假页面没有 DOM，这里统一返回一个「可点击的假句柄」，让入口流程能继续往下走。
     */
    async evaluateHandle() {
      const handle = {
        async asElement() {
          return element;
        },
        async dispose() {
          return null;
        }
      };
      const element = {
        ...handle,
        async evaluate() {
          return '开始学习';
        },
        async click() {
          return null;
        }
      };
      return handle;
    },
    async waitForResponse(predicate) {
      const url = await state.nextResponseUrl(predicate);
      if (!url) return null;
      return state.responseFor(url);
    },
    async waitForEvent() {
      return null;
    },
    locator(selector) {
      const element = {
        first: () => element,
        filter: () => element,
        // 真实站点上实训页的入口控件是「继续挑战」，卡片里是「开始学习」；
        // 夹具给出「有一个可点控件」即可（文本内容供 clickEntryButton 判定文案）。
        getByText: () => element,
        async textContent() {
          return '继续挑战';
        },
        async count() {
          return selector.includes('listItem') ? 1 : selector.includes('/tasks/') ? 1 : 0;
        },
        async click() {
          return null;
        },
        async evaluateAll(fn, arg) {
          if (selector === 'a') return fn(state.pageAnchors || [], arg);
          return [];
        }
      };
      return element;
    },
    // page.getByText 是真实 Playwright 的 API（引擎用它找「继续挑战」等入口控件），夹具必须提供
    getByText() {
      return this.locator('button');
    },
    async request_get(url) {
      return state.requestGet(url);
    }
  };
  page.request = {
    async get(url) {
      return state.requestGet(url);
    }
  };
  return page;
}

function createFakeContext(state) {
  const page = createFakePage(state);
  state.page = page;
  return {
    pages: () => [page],
    async newPage() {
      return page;
    },
    async close() {
      state.contextClosed += 1;
    }
  };
}

function installFakePlaywright() {
  const state = {
    currentUrl: 'https://www.educoder.net/users/p8sxailt2/classrooms',
    gotos: [],
    reloads: 0,
    closedPages: 0,
    contextClosed: 0,
    requestGetCalls: 0,
    // apiGet 的响应。优先查 ownResponses——引擎现在直接调接口，那些原本作为
    // 「页面自身请求」提供的夹具，在新架构下就是接口响应，语义等价。
    apiResponse(url) {
      const own = Array.isArray(this.ownResponses) ? this.ownResponses : null;
      if (own) {
        const hit = own.find(([fragment]) => url.includes(fragment));
        if (hit) return jsonResponse(hit[1]);
      }
      return fakeApiResponse(url);
    },
    // 「页面自身请求」的响应：[URL 片段, 响应体]。仅供仍走页面截获的路径使用。
    ownResponses: null,
    // 页面数据回退（React Fiber）用的假 anchor：挂一个 __reactFiber 链，memoizedProps.dataSource 里放课程。
    pageAnchors: [],
    pageCourseFallback: [],
    // 附件图片：返回一段合法的 1x1 PNG，让 detectImageExtension / base64 落盘路径被真实验证。
    // 置为 'error-json' 时模拟服务端返回 `{"status":-1,"message":"文件不存在"}`（真实事故 BUG-034）。
    imageResponse(url) {
      if (state.imageMode === 'error-json') {
        return {
          base64: Buffer.from('{"status":-1,"message":"文件不存在"}', 'utf8').toString('base64'),
          contentType: 'application/octet-stream'
        };
      }
      if (!url.includes('/api/attachments/')) return { error: `假图片接口未覆盖：${url}` };
      return {
        base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
        contentType: 'image/png'
      };
    },
    responseFor(url) {
      if (url.includes('homework_commons.json')) {
        return {
          ok: () => true,
          url: () => url,
          async json() {
            return EXPERIMENTS;
          }
        };
      }
      if (url.includes('shixun_exec.json')) {
        return {
          ok: () => true,
          url: () => url,
          async json() {
            return { game_identifier: 'conv' };
          }
        };
      }
      return null;
    },
    async nextResponseUrl(predicate) {
      const candidates = [
        'https://data.educoder.net/api/courses/HCEAP94S/homework_commons.json',
        // 只回放 CNN 的实训上下文：第二个实验拿不到自己的 shixun_exec，
        // 正好用来验证「不得复用上一个实验的入口」。
        'https://data.educoder.net/api/shixuns/k2mqxzlf/shixun_exec.json'
      ];
      return candidates.find((url) => predicate({ url: () => url })) || null;
    },
    async requestGet(url) {
      this.requestGetCalls += 1;
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
  };

  const originalLoad = Module._load;
  Module._load = function patched(request, parent, isMain) {
    if (request === 'playwright') {
      return {
        chromium: {
          async launchPersistentContext() {
            return createFakeContext(state);
          }
        }
      };
    }
    return originalLoad.apply(this, arguments);
  };
  return {
    state,
    restore() {
      Module._load = originalLoad;
    }
  };
}

/**
 * apiGet 在浏览器上下文里的 evaluate 回调返回形状是 { status, body }。
 * 注意不是 { ok, status, text, json }——那是 apiGet 自己的返回形状。
 */
function jsonResponse(bodyText, status = 200) {
  return { status, body: bodyText };
}

/**
 * 假接口分发：按 URL 返回 apiGet 形状的响应。
 * 只覆盖前端/引擎真正会用到的接口；其余一律抛错，避免测试悄悄依赖真实网络。
 */
function fakeApiResponse(url) {
  const parsed = new URL(url);
  if (parsed.pathname.endsWith('/courses.json')) {
    const pageNumber = Number(parsed.searchParams.get('page') || 1);
    const perPage = Number(parsed.searchParams.get('per_page') || 100);
    const all = [COURSE_A, COURSE_B];
    return jsonResponse(JSON.stringify({ count: all.length, courses: all.slice((pageNumber - 1) * perPage, pageNumber * perPage) }));
  }
  if (parsed.pathname.endsWith('challenges.json')) {
    return jsonResponse(JSON.stringify(CHALLENGES));
  }
  if (parsed.pathname.endsWith('homework_commons.json')) {
    return jsonResponse(JSON.stringify(EXPERIMENTS));
  }
  const taskId = parsed.pathname.match(/\/api\/tasks\/([^/.]+)\.json/)?.[1];
  if (taskId) {
    if (!TASKS[taskId]) return jsonResponse(JSON.stringify({ error: 'not found' }), 404);
    return jsonResponse(JSON.stringify(TASKS[taskId]));
  }
  if (parsed.pathname.endsWith('rep_content.json')) {
    return jsonResponse(JSON.stringify({ content: { content: BASE64('print("starter")\n') } }));
  }
  throw new Error(`假接口未覆盖：${url}`);
}

/** 每个用例都必须让引擎重新 require playwright，否则会命中上一个用例缓存的假模块。 */
function freshEngineModule() {
  for (const key of Object.keys(require.cache)) {
    if (/extract-engine\.js$/.test(key)) delete require.cache[key];
  }
  return require('../extractor/lib/extract-engine');
}

/** 只 stub 契约里明确属于「登录探测」的 checkLogin。
 * listCourses / listExperiments / listChallenges 一律跑真实的 educoder-api 代码，
 * 由假 page.evaluate 按 URL 提供响应，这样字段映射也在测试覆盖范围内。
 */
function patchApiForFakes() {
  const api = require('../extractor/lib/educoder-api');
  const original = { checkLogin: api.checkLogin };
  api.checkLogin = async () => ({ loggedIn: true, user: 'p8sxailt2', status: 200 });
  return () => {
    api.checkLogin = original.checkLogin;
  };
}

function withTempExportRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'touge-test-'));
}

// ---------------------------------------------------------------- 测试

/** 各用例共用的「页面自身请求」回放数据（引擎优先走这条路径）。 */
function defaultOwnResponses(experiments = EXPERIMENTS, tasks = TASKS) {
  const entries = [
    ['api/courses/HCEAP94S/homework_commons.json', JSON.stringify(experiments)],
    ['api/myshixuns/sb5zfhoq8g/challenges.json', JSON.stringify(CHALLENGES)]
  ];
  for (const [id, payload] of Object.entries(tasks)) {
    entries.push([`api/tasks/${id}.json`, JSON.stringify(payload)]);
  }
  return entries;
}

test('引擎：图片接口返回错误 JSON 时不得写出假图片文件（BUG-034 回归）', async (t) => {
  const fake = installFakePlaywright();
  fake.state.ownResponses = defaultOwnResponses();
  fake.state.imageMode = 'error-json';
  const restoreApi = patchApiForFakes();
  const { ExtractEngine } = freshEngineModule();
  const exportRoot = withTempExportRoot();
  const logs = [];

  t.after(() => {
    restoreApi();
    fake.restore();
    fs.rmSync(exportRoot, { recursive: true, force: true });
  });

  const engine = new ExtractEngine({
    exportRoot,
    profileDir: path.join(exportRoot, 'profile'),
    pageSettleMs: 0,
    onEvent: (event) => {
      if (event.type === 'log') logs.push(event.message);
    },
    control: {
      waitForCourse: async (courses) => courses[0],
      waitForExperiments: async (experiments) => [experiments[0]],
      waitForLevels: async (levels) => levels
    }
  });

  await engine.run();

  const experimentDir = path.join(exportRoot, '机器学习_2026年下半年', 'CNN');
  const assetsDir = path.join(experimentDir, 'assets');
  const files = fs.existsSync(assetsDir) ? fs.readdirSync(assetsDir) : [];
  assert.deepEqual(files, [], `错误 JSON 绝不能落盘成图片文件，实际写了：${files.join(', ')}`);

  // 存档里该字段应指向远程地址，而不是一个坏掉的本地文件
  const archive = fs.readFileSync(path.join(experimentDir, 'levels.jsonl'), 'utf8');
  const rows = archive.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const mapped = rows.flatMap((row) => Object.values(row.imageMap || {}));
  for (const value of mapped) {
    assert.ok(
      !value.startsWith('assets/'),
      `下载失败时不应把远程地址改成本地相对路径（会指向不存在的文件），实际：${value}`
    );
  }
  assert.ok(
    logs.some((line) => /图片内容不是图片/.test(line)),
    `应明确记录「返回的不是图片」，实际日志：${logs.join(' | ')}`
  );
});

test('引擎：完整流水线（选课 → 选实验 → 选关卡）产生正确产物与事件', async (t) => {
  const START = Date.now();
  const fake = installFakePlaywright();
  fake.state.ownResponses = defaultOwnResponses();
  const restoreApi = patchApiForFakes();
  const { ExtractEngine } = freshEngineModule();
  const exportRoot = withTempExportRoot();
  const events = [];
  const calls = { courses: 0, experiments: 0, levels: 0 };

  t.after(() => {
    restoreApi();
    fake.restore();
    fs.rmSync(exportRoot, { recursive: true, force: true });
  });

  const engine = new ExtractEngine({
    exportRoot,
    profileDir: path.join(exportRoot, 'profile'),
    pageSettleMs: 0,
    onEvent: (event) => {
      events.push(event);
      if (process.env.TRACE_ENGINE) {
        const mark = `[t+${Date.now() - START}ms]`;
        process.stderr.write(`${mark} ${event.type}${event.phase ? ':' + event.phase : ''} ${event.message || event.path || ''}\n`);
        if (event.type === 'status' && event.phase === 'waiting-course') {
          process.stderr.write(`${mark} cache=${[...engine.responseCache.keys()].join(' || ') || '(空)'}\n`);
        }
      }
    },
    control: {
      async waitForCourse(courses) {
        calls.courses += 1;        assert.equal(courses.length, 2, '应读到两门课程');
        assert.equal(courses[0].name, '机器学习_2026年下半年');
        assert.equal(courses[0].classroomCode, 'HCEAP94S');
        return courses[0];
      },
      async waitForExperiments(experiments) {
        calls.experiments += 1;
        assert.equal(experiments.length, 2, 'is_shixun=false 的条目必须被过滤');
        assert.deepEqual(
          experiments.map((item) => item.name),
          ['CNN', '模型评估与选择']
        );
        return [experiments[0]];
      },
      async waitForLevels(levels) {
        calls.levels += 1;
        assert.equal(levels.length, 3);
        assert.equal(levels[2].type, 'choice', 'chooses 非空应判为 choice');
        assert.equal(levels[0].type, 'code');
        return levels;
      },
      async shouldStop() {
        return false;
      }
    }
  });

  await engine.run();

  assert.deepEqual(calls, { courses: 1, experiments: 1, levels: 1 });
  assert.deepEqual(engine.stats, { saved: 3, skipped: 0, failed: 0, existing: 0, dropped: 0 }, '三关都应保存');

  const experimentDir = path.join(exportRoot, '机器学习_2026年下半年', 'CNN');
  const experimentMd = path.join(experimentDir, 'CNN.md');
  const experimentMeta = path.join(experimentDir, 'CNN.metadata.json');

  assert.ok(fs.existsSync(experimentMd), '整个实验应只有一个 md 文件');
  assert.ok(fs.existsSync(experimentMeta), '应有实验级 metadata.json');
  assert.ok(fs.existsSync(path.join(experimentDir, 'assets', 'L001-image-1.png')), '应下载图片');
  assert.ok(!fs.existsSync(path.join(experimentDir, '第1关_conv')), '不应再按关卡建目录');

  const document = fs.readFileSync(experimentMd, 'utf8');
  assert.match(document, /^---\ncourse: 机器学习_2026年下半年\nexperiment: CNN\nlevels: 3\n/m, 'frontmatter 应带课程/实验/关卡数');
  assert.equal(document.match(/^## 第\d+关：/gm).length, 3, '三关各一节');
  assert.match(document, /## 第1关：conv/);
  assert.match(document, /## 第2关：pool/);
  assert.match(document, /## 第3关：欠拟合与过拟合/);

  const convSection = document.slice(document.indexOf('## 第1关：'), document.indexOf('## 第2关：'));
  assert.match(convSection, /- 关卡 id：L001/);
  assert.match(convSection, /- 题型：编程题（code）/);
  assert.match(convSection, /### 任务描述/);
  assert.match(convSection, /### 编程要求/);
  assert.match(convSection, /### 初始代码/);
  assert.match(convSection, /```python/);
  assert.match(convSection, /print\("starter"\)/, '初始代码应被写入');
  assert.match(convSection, /!\[题目图片\]\(assets\/L001-image-1\.png\)/, '图片应改成本地路径');
  assert.match(convSection, /### 作答格式/);
  assert.match(convSection, /"kind": "code"/);
  assert.ok(!document.includes('/api/attachments/'), '不应残留远程图片地址');

  const quizSection = document.slice(document.indexOf('## 第3关：'));
  const poolSection = document.slice(document.indexOf('## 第2关：'), document.indexOf('## 第3关：'));
  assert.match(poolSection, /### 测试说明\n\n不要保存我。/, 'code 关卡保留测试说明小节');
  assert.ok(!quizSection.includes('不要保存我'), '测试说明不得串到别的关卡');

  assert.match(quizSection, /### 选择题/);
  assert.match(quizSection, /1\. !\[题目图片\]\(assets\/L003-image-1\.png\)/, '题干图片应改成本地路径');
  assert.match(quizSection, /A\. 欠拟合，欠拟合/);
  assert.match(quizSection, /B\. 欠拟合，过拟合/);
  assert.match(quizSection, /C\. 过拟合，过拟合/);
  assert.match(quizSection, /"kind": "choice"/, '选择题必须给出 choice 作答格式');
  assert.ok(!quizSection.includes('### 任务描述'), '选择题不保存任务描述');
  assert.ok(!document.includes('这段不应该出现在选择题里'), '选择题正文不落盘');
  assert.ok(!quizSection.includes('D.'), 'option_name 为空的选项必须被过滤');

  const quizMeta = JSON.parse(fs.readFileSync(experimentMeta, 'utf8'));
  assert.equal(quizMeta.levelCount, 3);
  const quizLevel = quizMeta.levels.find((level) => level.taskIndex === 3);
  assert.equal(quizLevel.type, 'choice');
  assert.equal(quizLevel.choiceQuestions.length, 1, 'subject 为空的问题必须被丢弃');
  assert.equal(quizLevel.choiceQuestions[0].options.length, 3);
  assert.deepEqual(quizLevel.images, ['L003-image-1.png']);

  const types = events.map((event) => event.type);
  for (const expected of ['status', 'courses', 'experiments', 'levels', 'progress', 'saved', 'done']) {
    assert.ok(types.includes(expected), `应发出 ${expected} 事件`);
  }
  const phases = events.filter((event) => event.type === 'status').map((event) => event.phase);
  assert.ok(phases.includes('waiting-login') === false, '已登录时不应进入等待登录');
  for (const expected of ['courses', 'waiting-course', 'waiting-experiments', 'waiting-levels', 'running', 'done']) {
    assert.ok(phases.includes(expected), `应经过阶段 ${expected}`);
  }

  const done = events.find((event) => event.type === 'done');
  assert.deepEqual(
    { saved: done.saved, skipped: done.skipped, failed: done.failed, stopped: done.stopped },
    { saved: 3, skipped: 0, failed: 0, stopped: false }
  );
  assert.equal(done.exportRoot, exportRoot);
  assert.equal(done.dropped, 0, '三关都是编程题/选择题，不应有被抛弃的关卡');
  // saved 事件指向「关卡存档」（每关只追加一行）；md/metadata 是整轮结束时生成的视图。
  const savedEvents = events.filter((event) => event.type === 'saved');
  assert.equal(savedEvents.length, 3);
  for (const event of savedEvents) {
    assert.equal(event.path, path.join(experimentDir, 'levels.jsonl'), 'saved.path 应指向关卡存档');
    assert.equal(event.directory, experimentDir, 'saved.directory 应是实验目录');
  }
});

test('引擎：多实验连抓时每个实验都走自己的关卡链（不得复用上一个实验的入口）', async (t) => {
  const fake = installFakePlaywright();
  fake.state.ownResponses = [
    ...defaultOwnResponses(EXPERIMENTS_B, TASKS),
    ['api/shixuns/z9uitj5y/challenges.json?id=z9uitj5y', JSON.stringify(CHALLENGES_B)],
    ['api/myshixuns/cccccccccc/challenges.json?homework_common_id=4157467', JSON.stringify(CHALLENGES_B)],
    ...Object.entries(TASKS_B).map(([id, payload]) => [`api/tasks/${id}.json`, JSON.stringify(payload)])
  ];
  const restoreApi = patchApiForFakes();
  const { ExtractEngine } = freshEngineModule();
  const exportRoot = withTempExportRoot();
  const entries = [];

  t.after(() => {
    restoreApi();
    fake.restore();
    fs.rmSync(exportRoot, { recursive: true, force: true });
  });

  const engine = new ExtractEngine({
    exportRoot,
    profileDir: path.join(exportRoot, 'profile'),
    pageSettleMs: 0,
    onEvent: (event) => {
      if (event.type === 'log') engine.__logs = (engine.__logs || []).concat(event.message);
    },
    control: {
      waitForCourse: async (courses) => courses[0],
      waitForExperiments: async (experiments) => experiments,
      waitForAllLevels: async (levels) => levels
    }
  });
  // 记录每个实验进入时解析出来的入口标识
  const originalOpen = engine.openExperiment.bind(engine);
  engine.openExperiment = async (experiment, course) => {
    const page = await originalOpen(experiment, course);
    entries.push({ name: experiment.name, gameIdentifier: experiment.gameIdentifier || null });
    return page;
  };

  await engine.run();

  assert.equal(entries.length, 2, '两个实验都应执行');
  assert.equal(entries[0].name, 'CNN');
  assert.equal(entries[1].name, '白盒测试');
  assert.equal(entries[0].gameIdentifier, 'conv', `第一个实验应解析出 conv，实际 ${JSON.stringify(entries[0])}`);
  // 回归断言：第二个实验**绝不能复用**第一个实验的入口（真实 bug：白盒/黑盒都拿到了「单元测试」的入口）。
  // 夹具里白盒测试的实训上下文没有声明（假页面只回放 CNN 的 shixun_exec），
  // 因此这里正确的结果是「拒绝复用 → 入口为空」，而不是拿到 conv/quiz。
  assert.notEqual(
    entries[1].gameIdentifier,
    entries[0].gameIdentifier,
    '第二个实验复用了第一个实验的入口标识，说明入口是从残留页面反推的'
  );
  assert.ok(
    entries[1].gameIdentifier === null || entries[1].gameIdentifier === 'b1-cover',
    `第二个实验要么拿到自己的入口，要么明确为空，实际 ${JSON.stringify(entries[1].gameIdentifier)}`
  );

  // 「进入实验前是否该回课堂列表页」的判定：只对「停在别的实验关卡页」才导航
  const navigations = [];
  engine.page = {
    url: () => fake.state.currentUrl,
    waitForLoadState: async () => {},
    goto: async (url) => {
      navigations.push(url);
      fake.state.currentUrl = url;
    },
    on: () => {},
    off: () => {}
  };
  const others = { name: '白盒测试', shixunIdentifier: 'z9uitj5y' };
  const course = { classroomUrl: 'https://www.educoder.net/classrooms/HCEAP94S/announcement' };

  fake.state.currentUrl = 'https://www.educoder.net/shixuns/k2mqxzlf/challenges'; // 别的实验的页面
  await engine.prepareExperimentEntry(others, course);
  assert.equal(navigations.length, 1, '停在别的实验关卡页时必须回课堂列表页');
  assert.match(navigations[0], /shixun_homework$/, '应导航到课堂实验列表页');
  assert.equal(others.gameIdentifier, undefined, '残留的入口标识必须被清掉');

  fake.state.currentUrl = 'https://www.educoder.net/shixuns/z9uitj5y/challenges'; // 自己实验的页面
  await engine.prepareExperimentEntry(others, course);
  assert.equal(navigations.length, 1, '已经在自己的实训页时不要重复导航（会冲掉入口状态）');
});

test('引擎：关卡列表不得取到「别的实验」的同名端点响应（缓存归属校验）', (t) => {
  const fake = installFakePlaywright();
  const restoreApi = patchApiForFakes();
  const { ExtractEngine } = freshEngineModule();
  t.after(() => {
    restoreApi();
    fake.restore();
  });

  const engine = new ExtractEngine({ onEvent: () => {} });
  // 缓存里同时有「单元测试」（2 关）与「白盒测试」（7 关）的响应，顺序把别人的放前面。
  engine.responseCache.set(
    'https://data.educoder.net/api/shixuns/z9uitj5y/challenges.json?id=z9uitj5y',
    JSON.stringify({
      challenge_list: Array.from({ length: 7 }, (_value, index) => ({
        name: `白盒第${index + 1}关`,
        position: index + 1,
        challenge_id: 500 + index
      }))
    })
  );
  engine.responseCache.set(
    'https://data.educoder.net/api/shixuns/k2mqxzlf/challenges.json?id=k2mqxzlf',
    JSON.stringify({
      challenge_list: [
        { name: '使用Junit进行单元测试', position: 1, challenge_id: 601 },
        { name: '单元测试覆盖率', position: 2, challenge_id: 602 }
      ]
    })
  );

  const unitTest = {
    name: '单元测试',
    shixunIdentifier: 'k2mqxzlf',
    myshixunIdentifier: 'sb5zfhoq8g'
  };
  const levels = engine.levelsFromCache(
    [`api/shixuns/${unitTest.shixunIdentifier}/challenges.json`, `api/myshixuns/${unitTest.myshixunIdentifier}/challenges.json`],
    unitTest
  );
  assert.equal(levels.length, 2, `必须取到本实验的 2 关，实际 ${levels.length}`);
  assert.deepEqual(
    levels.map((level) => level.name),
    ['使用Junit进行单元测试', '单元测试覆盖率'],
    '不得把别的实验（白盒测试 7 关）的列表当成自己的'
  );
});

test('引擎：课堂实验下的「子标签实验」也要列出来（软件工程导论实测形态）', async (t) => {
  const fake = installFakePlaywright();
  const restoreApi = patchApiForFakes();
  const { ExtractEngine } = freshEngineModule();
  t.after(() => {
    restoreApi();
    fake.restore();
  });

  const engine = new ExtractEngine({ onEvent: () => {} });
  // 顶层是「单元测试」，它下面挂着子标签「软件工程初体验」（只有 homework_id、没有 shixun_identifier），
  // 顶层还混了一个普通作业（is_shixun=false，不该被收）。
  const payload = {
    homeworks: [
      {
        name: '单元测试',
        homework_id: 1586165,
        homework_commons_id: 1586165,
        shixun_identifier: 'z9uitj5y',
        myshixun_identifier: 'cccccccccc',
        challenge_count: 2,
        is_shixun: true,
        children: [
          {
            name: '软件工程初体验',
            homework_id: 1586166,
            is_shixun: false,
            challenge_count: 1
          }
        ]
      },
      { name: '第一章作业', homework_id: 999, is_shixun: false }
    ]
  };

  const experiments = engine.parseExperiments(JSON.stringify(payload), 'page');
  assert.deepEqual(
    experiments.map((item) => item.name),
    ['单元测试', '软件工程初体验'],
    `子标签实验必须列出来，普通作业不能收进来，实际：${experiments.map((item) => item.name).join(',')}`
  );
  const parent = experiments[0];
  const child = experiments[1];
  assert.equal(parent.nested, false);
  assert.equal(parent.shixunIdentifier, 'z9uitj5y');
  assert.equal(child.nested, true, '子标签要标出来');
  assert.equal(child.parentName, '单元测试', '子标签要记住挂在哪个实验下');
  assert.equal(child.homeworkId, 1586166, '子标签靠 homework_id 定位');
  assert.equal(child.shixunIdentifier, '', '子标签可能没有 shixun 标识');
});

test('引擎：只有 homework_id 的子标签实验，关卡列表走「作业页」而不是 shixun 页', async (t) => {
  const fake = installFakePlaywright();
  const restoreApi = patchApiForFakes();
  const { ExtractEngine } = freshEngineModule();
  t.after(() => {
    restoreApi();
    fake.restore();
  });

  const engine = new ExtractEngine({ onEvent: () => {} });
  const navigated = [];
  engine.page = {
    url: () => 'https://www.educoder.net/classrooms/2i6ng7vp/shixun_homework',
    goto: async (url) => {
      navigated.push(url);
    },
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
    on: () => {},
    off: () => {}
  };
  engine.currentCourse = { name: '软件工程导论2026年下半年', classroomCode: '2i6ng7vp' };
  engine.levelsFromCache = () => []; // 没有缓存 → 会按「等不到列表」收尾，但导航已经发生

  await engine.loadLevels({ name: '软件工程初体验', homeworkId: 1586166, shixunIdentifier: '', myshixunIdentifier: '' }, { emit: false });

  assert.ok(navigated.length, '必须发生导航');
  assert.match(
    navigated[0],
    /\/classrooms\/2i6ng7vp\/shixun_homework\/1586166\?tabs=0$/,
    `子标签实验应打开它的作业页，实际：${navigated[0]}`
  );
});

test('引擎：课堂实验按「章标签」分视图，必须逐个读取并合并（软件工程导论实测）', (t) => {
  const fake = installFakePlaywright();
  const restoreApi = patchApiForFakes();
  const { ExtractEngine } = freshEngineModule();
  t.after(() => {
    restoreApi();
    fake.restore();
  });

  const engine = new ExtractEngine({ onEvent: () => {} });

  // 侧栏响应给出 7 个章分类（与真实 left_banner.json 同形）
  const banner = JSON.stringify({
    course_modules: [
      { id: 2032062, name: '课堂实验', type: 'shixun', second_category: [
        { name: '课堂实验', category_id: 1586166, second_category_url: '/classrooms/2i6ng7vp/shixun_homework/1586166' },
        { name: '课堂实验', category_id: 1588241, second_category_url: '/classrooms/2i6ng7vp/shixun_homework/1588241' },
        { name: '课堂实验', category_id: 1588242, second_category_url: '/classrooms/2i6ng7vp/shixun_homework/1588242' }
      ] }
    ]
  });
  const categories = engine.shixunCategoriesFromBanner(banner);
  assert.deepEqual(categories.map((item) => item.id), ['1586166', '1588241', '1588242'], '要取出每个章的 category_id');
  assert.equal(categories[0].url, '/classrooms/2i6ng7vp/shixun_homework/1586166');
  assert.deepEqual(engine.shixunCategoriesFromBanner('不是 JSON'), [], '坏响应不能抛错');
  assert.deepEqual(engine.shixunCategoriesFromBanner(JSON.stringify({ course_modules: [] })), []);

  // 合并：各章为主；默认视图带来新实验时追加；重复项按「作业主键+实训标识」去重
  const initial = [
    { name: '集成测试和确认测试', homeworkId: 4157470, shixunIdentifier: 'igoyjkcv' },
    { name: '单元测试', homeworkId: 4157469, shixunIdentifier: 'x' },
    { name: '只在默认视图里的实验', homeworkId: 999, shixunIdentifier: 'only-default' }
  ];
  const chapterLists = [
    [[{ name: '找出代码中的bug', homeworkId: 4000335, shixunIdentifier: 'a' },
      { name: '制定进度计划', homeworkId: 4000334, shixunIdentifier: 'b' }], '1、软件工程初体验'],
    [[{ name: '软件过程模型', homeworkId: 4000338, shixunIdentifier: 'c' }], '2、软件工程概述'],
    // 第 3 章与默认视图有重复（同一个 homework_id），不能重复计入
    [[{ name: '集成测试和确认测试', homeworkId: 4157470, shixunIdentifier: 'igoyjkcv' }], '3、可行性研究']
  ];

  const merged = engine.mergeExperimentLists(initial, chapterLists);
  const names = merged.map((item) => item.name);
  // 章内 4 个（第 3 章那条与默认视图重复，只算一次）+ 默认视图独有的 2 个（单元测试、只在默认视图里的实验）
  assert.equal(merged.length, 6, `实际：${names.join(' | ')}`);
  assert.equal(names.filter((name) => /集成测试和确认测试/.test(name)).length, 1, '重复项只保留一次');
  assert.ok(
    names.includes('[1、软件工程初体验] 找出代码中的bug'),
    '章内条目要带所属章前缀，便于界面区分'
  );
  assert.equal(merged[0].categoryName, '1、软件工程初体验');
  assert.ok(names.includes('只在默认视图里的实验'), '默认视图里独有的实验要保留');

  // 没有章视图时原样返回（保持旧行为）
  assert.deepEqual(engine.mergeExperimentLists(initial, []), initial);
  assert.deepEqual(engine.mergeExperimentLists(initial, null), initial);
});

test('引擎：签名被拒（-102）时快速失败并指向 educoder-sign.js，不再抓页面兜底', async (t) => {
  const fake = installFakePlaywright();
  fake.state.ownResponses = defaultOwnResponses();
  const { ExtractEngine } = freshEngineModule();
  const api = require('../extractor/lib/educoder-api');
  const originalCheckLogin = api.checkLogin;
  const exportRoot = withTempExportRoot();
  const events = [];

  // -102 的真实含义是签名没通过，处置是改 AK/SK，不是去登录、也不是调系统时间。
  api.checkLogin = async () => ({
    loggedIn: false,
    signatureRejected: true,
    status: 200,
    reason: '签名被拒（-102）：请求头缺失或签名算法已变更。',
    preview: '{"status":-102,"message":"服务器时间与您的设备时间不匹配"}'
  });

  t.after(() => {
    api.checkLogin = originalCheckLogin;
    fake.restore();
    fs.rmSync(exportRoot, { recursive: true, force: true });
  });

  const engine = new ExtractEngine({
    exportRoot,
    profileDir: path.join(exportRoot, 'profile'),
    pageSettleMs: 0,
    onEvent: (event) => events.push(event),
    control: {
      async waitForCourse(courses) {
        return courses[0];
      },
      async waitForExperiments(experiments) {
        return [experiments[0]];
      },
      async waitForLevels(levels) {
        return levels;
      },
      async shouldStop() {
        return false;
      }
    }
  });

  await engine.run();

  const phases = events.filter((e) => e.type === 'status').map((e) => e.phase);
  assert.ok(!phases.includes('waiting-login'), '签名问题不是登录问题，不该让用户去登录');
  assert.ok(phases.includes('error'), '必须进入 error 终态，而不是停住或当成 0 门课程');

  const messages = events.filter((e) => e.type === 'log').map((e) => e.message).join('\n');
  assert.match(messages, /educoder-sign/, '必须指出要改的文件，否则用户无从下手');
  assert.match(messages, /SIGNING_VERSION/, '必须给出常量版本，便于判断是算法变了还是会话掉了');
  assert.match(messages, /probe-signature/, '必须给出可自助验证的命令');
});

test('引擎：登录探测已判定为已登录时不得停留在等待登录', async (t) => {
  const fake = installFakePlaywright();
  fake.state.ownResponses = defaultOwnResponses();
  const { ExtractEngine } = freshEngineModule();
  const api = require('../extractor/lib/educoder-api');
  const originalCheckLogin = api.checkLogin;
  const exportRoot = withTempExportRoot();
  const events = [];
  let loginChecks = 0;

  api.checkLogin = async () => {
    loginChecks += 1;
    // 只要 loggedIn 为真就必须往下走；这里刻意带上额外的诊断字段，
    // 确认引擎不会因为多了几个不认识的字段就退化成「等待登录」。
    return {
      loggedIn: true,
      user: 'p8sxailt2',
      status: 200,
      reason: '已登录',
      preview: '{"login":"p8sxailt2"}'
    };
  };

  t.after(() => {
    api.checkLogin = originalCheckLogin;
    fake.restore();
    fs.rmSync(exportRoot, { recursive: true, force: true });
  });

  const engine = new ExtractEngine({
    exportRoot,
    profileDir: path.join(exportRoot, 'profile'),
    pageSettleMs: 0,
    onEvent: (event) => events.push(event),
    control: {
      async waitForCourse(courses) {
        return courses[0];
      },
      async waitForExperiments(experiments) {
        return [experiments[0]];
      },
      async waitForLevels(levels) {
        return [levels[0]];
      },
      async shouldStop() {
        return false;
      }
    }
  });

  await engine.run();

  assert.equal(loginChecks, 1, '已登录时只应检查一次，不能进入轮询');
  const phases = events.filter((e) => e.type === 'status').map((e) => e.phase);
  assert.ok(!phases.includes('waiting-login'), '不得停留在等待登录阶段');
  assert.ok(phases.includes('done'));
});

test('引擎：课程没有课堂实验时不得回退直连 API（否则报出误导性的 -102 错误）', async (t) => {
  const fake = installFakePlaywright();
  const restoreApi = patchApiForFakes();
  const api = require('../extractor/lib/educoder-api');
  const originalListExperiments = api.listExperiments;
  const { ExtractEngine } = freshEngineModule();
  const exportRoot = withTempExportRoot();
  const events = [];
  let apiCalls = 0;

  // 页面明确回答「没有课堂实验」：真实响应无顶层 status，homeworks 为 []
  fake.state.ownResponses = [
    ['api/courses/VX58GTJP/homework_commons.json', JSON.stringify({ course_identity: 5, homeworks: [], all_count: 0 })]
  ];
  // 直连 API 若被调用（不该被调用）就抛 -102，用于证明没回退
  api.listExperiments = async () => {
    apiCalls += 1;
    throw new Error('data 接口拒绝了本工具的直连请求（-102 设备时间校验）');
  };

  t.after(() => {
    api.listExperiments = originalListExperiments;
    restoreApi();
    fake.restore();
    fs.rmSync(exportRoot, { recursive: true, force: true });
  });

  const engine = new ExtractEngine({
    exportRoot,
    profileDir: path.join(exportRoot, 'profile'),
    pageSettleMs: 0,
    onEvent: (event) => events.push(event),
    control: {
      waitForCourse: async (c) => c[0],
      waitForExperiments: async (e) => e,
      waitForLevels: async () => null,
      shouldStop: async () => false
    }
  });
  await engine.launch();

  const experiments = await engine.loadExperiments({
    name: '网络编程技术-26-27第一学期',
    classroomCode: 'VX58GTJP',
    classroomUrl: 'https://www.educoder.net/classrooms/VX58GTJP/announcement'
  });

  assert.deepEqual(experiments, [], '该课程没有课堂实验，应返回空数组');
  assert.equal(apiCalls, 0, '页面已给出响应时不得再回退直连 API');
  assert.ok(
    events.some((event) => event.type === 'log' && /没有可提取的课堂实验|都不是课堂实验/.test(event.message)),
    '必须明确说明该课程没有课堂实验，而不是报错'
  );
  assert.ok(
    !events.some((event) => event.type === 'log' && event.level === 'warn' && /-102/.test(event.message)),
    '不应出现 -102 相关告警'
  );

  // 整条 run() 也必须以「正常结束」收场，而不是 error 阶段
  events.length = 0;
  const engine2 = new ExtractEngine({
    exportRoot,
    profileDir: path.join(exportRoot, 'profile'),
    pageSettleMs: 0,
    onEvent: (event) => events.push(event),
    control: {
      waitForCourse: async (c) => c[0],
      waitForExperiments: async (e) => e,
      waitForLevels: async () => null,
      shouldStop: async () => false
    }
  });
  await engine2.run();

  const phases = events.filter((event) => event.type === 'status').map((event) => event.phase);
  assert.ok(!phases.includes('error'), `没有实验时不应进入 error 阶段，实际：${phases.join(' → ')}`);
  assert.ok(phases.includes('done'), '应以 done 结束');
  const done = events.find((event) => event.type === 'done');
  assert.equal(done.stopped, true, '没有可提取实验时标记为提前结束');
  assert.equal(done.saved, 0);
  assert.ok(
    events.some((event) => event.type === 'status' && /没有可提取的课堂实验/.test(event.message)),
    '结束说明必须点明「该课程没有课堂实验」'
  );
});

test('引擎：重复提取时默认跳过本地已存在的关卡，不覆盖也不重抓', async (t) => {
  const fake = installFakePlaywright();
  fake.state.ownResponses = defaultOwnResponses();
  const restoreApi = patchApiForFakes();
  const { ExtractEngine } = freshEngineModule();
  const exportRoot = withTempExportRoot();
  const events = [];
  const control = {
    waitForCourse: async (c) => c[0],
    waitForExperiments: async (e) => [e[0]],
    waitForLevels: async (l) => l,
    shouldStop: async () => false
  };

  t.after(() => {
    restoreApi();
    fake.restore();
    fs.rmSync(exportRoot, { recursive: true, force: true });
  });

  // 第一轮：三关全部写入
  const first = new ExtractEngine({
    exportRoot,
    profileDir: path.join(exportRoot, 'profile'),
    pageSettleMs: 0,
    onEvent: () => {},
    control
  });
  await first.run();
  assert.equal(first.stats.saved, 3, '第一轮应写入三关');
  assert.equal(first.stats.existing, 0);

  const experimentMd = path.join(exportRoot, '机器学习_2026年下半年', 'CNN', 'CNN.md');
  const before = fs.readFileSync(experimentMd, 'utf8');

  // 第二轮：同样的三关，应全部识别为已存在并跳过
  const second = new ExtractEngine({
    exportRoot,
    profileDir: path.join(exportRoot, 'profile'),
    pageSettleMs: 0,
    onEvent: (event) => events.push(event),
    control
  });
  await second.run();

  assert.equal(second.stats.saved, 0, '第二轮不应重复写入');
  assert.equal(second.stats.existing, 3, '三关都应识别为已存在');
  assert.equal(second.stats.failed, 0);
  assert.equal(fs.readFileSync(experimentMd, 'utf8'), before, '已存在的内容不得被覆盖');
  assert.ok(
    events.some((event) => event.type === 'reused'),
    '应发出 reused 事件，界面才能显示「已存在」'
  );

  // 第三轮：显式要求重新下载时，应重新写入
  const third = new ExtractEngine({
    exportRoot,
    profileDir: path.join(exportRoot, 'profile'),
    pageSettleMs: 0,
    skipExisting: false,
    onEvent: () => {},
    control
  });
  await third.run();
  assert.equal(third.stats.saved, 3, 'skipExisting=false 时应重新抓取并覆盖');
  assert.equal(third.stats.existing, 0);

  // 题目内容变了（例如上次抓取缺初始代码，这次拿到了）：必须重写该小节，而不是当成「已存在」。
  const fourth = new ExtractEngine({
    exportRoot,
    profileDir: path.join(exportRoot, 'profile'),
    pageSettleMs: 0,
    onEvent: (event) => events.push(event),
    control
  });
  const originalConv = TASKS.conv;
  TASKS.conv = {
    ...originalConv,
    challenge: { ...originalConv.challenge, task_pass: `${originalConv.challenge.task_pass}\n\n补充的新要求：必须使用向量化实现。` }
  };
  // 页面自身响应是预渲染的快照，改了 TASKS 之后必须重建，否则回放的是旧内容。
  fake.state.ownResponses = defaultOwnResponses();
  try {
    await fourth.run();
  } finally {
    TASKS.conv = originalConv;
    fake.state.ownResponses = defaultOwnResponses();
  }
  assert.equal(fourth.stats.saved, 1, '内容变化的那一关应重新写入');
  assert.equal(fourth.stats.existing, 2, '内容未变的两关仍应跳过');
  assert.match(
    fs.readFileSync(experimentMd, 'utf8'),
    /补充的新要求：必须使用向量化实现。/,
    '更新后的题目正文必须落盘'
  );
});

test('引擎：重跑同一门课不再"重新抓一遍"——不重下图片、不重写答案、不追加存档', async (t) => {
  const fake = installFakePlaywright();
  fake.state.ownResponses = defaultOwnResponses();
  // 数一下图片下载次数：复用快路径生效时，第二轮应当一次都不下载。
  let imageCalls = 0;
  const originalImageResponse = fake.state.imageResponse;
  fake.state.imageResponse = function patched(url) {
    imageCalls += 1;
    return originalImageResponse.call(this, url);
  };
  const restoreApi = patchApiForFakes();
  const { ExtractEngine } = freshEngineModule();
  const exportRoot = withTempExportRoot();
  const events = [];
  const control = {
    waitForCourse: async (c) => c[0],
    waitForExperiments: async (e) => [e[0]],
    waitForLevels: async (l) => l,
    shouldStop: async () => false
  };
  // 让第 1 关成为「已通过测评」的关卡：这样答案导出链路也在两轮里各走一遍。
  const originalConv = TASKS.conv;
  TASKS.conv = {
    ...originalConv,
    challenge: { ...originalConv.challenge, score: 100 },
    game: { final_score: 100 }
  };
  fake.state.ownResponses = defaultOwnResponses();

  t.after(() => {
    TASKS.conv = originalConv;
    restoreApi();
    fake.restore();
    fs.rmSync(exportRoot, { recursive: true, force: true });
  });

  const options = () => ({
    exportRoot,
    profileDir: path.join(exportRoot, 'profile'),
    pageSettleMs: 0,
    control
  });
  const experimentDir = path.join(exportRoot, '机器学习_2026年下半年', 'CNN');
  const archivePath = path.join(experimentDir, 'levels.jsonl');
  const answerFile = path.join(exportRoot, 'answers', '机器学习_2026年下半年__CNN.answers.json');
  const lineCount = (file) => fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).length;

  // 第一轮：真抓真写
  const first = new ExtractEngine({ ...options(), onEvent: () => {} });
  await first.run();
  assert.equal(first.stats.saved, 3);
  assert.ok(imageCalls > 0, '首轮必须真的下载图片');
  assert.ok(fs.existsSync(answerFile), '首轮应导出通过关卡的答案');
  const imageCallsAfterFirst = imageCalls;
  const answersAfterFirst = fs.readFileSync(answerFile, 'utf8');
  const linesAfterFirst = lineCount(archivePath);

  // 第二轮：同一门课、同一实验。内容没变 → 不该有任何"重新抓取"的动作。
  const second = new ExtractEngine({ ...options(), onEvent: (event) => events.push(event) });
  await second.run();
  assert.equal(second.stats.existing, 3, '三关都应复用');
  assert.equal(second.stats.saved, 0);
  assert.equal(imageCalls, imageCallsAfterFirst, '重跑不得重新下载图片（复用快路径）');
  assert.equal(
    fs.readFileSync(answerFile, 'utf8'),
    answersAfterFirst,
    '答案没变就不该重写文件（generated_at 也不得刷新）'
  );
  assert.equal(lineCount(archivePath), linesAfterFirst, '不得重复追加存档');

  const logs = events.filter((event) => event.type === 'log').map((event) => event.message).join('\n');
  assert.match(logs, /答案已是最新，未重写：L001/, '日志要说清"没重写"，而不是又"已导出"一遍');
  assert.doesNotMatch(logs, /已导出答案/, '重跑日志里不应再出现「已导出答案」');
});

test('引擎：页面崩溃（Target crashed）时重开实验页继续，而不是整条链报废', async (t) => {
  const fake = installFakePlaywright();
  fake.state.ownResponses = defaultOwnResponses();
  // 让「第 2 关的关卡数据」请求崩一次（真机形态：page.evaluate: Target crashed）。
  // 只崩一次：重开实验页之后的同一次请求必须能成功，链路才能继续。
  let crashesLeft = 1;
  const originalApiResponse = fake.state.apiResponse;
  fake.state.apiResponse = function patched(url) {
    if (crashesLeft > 0 && /\/api\/tasks\/pool\.json/.test(String(url))) {
      crashesLeft -= 1;
      throw new Error('page.evaluate: Target crashed');
    }
    return originalApiResponse.call(this, url);
  };
  const restoreApi = patchApiForFakes();
  const { ExtractEngine } = freshEngineModule();
  const exportRoot = withTempExportRoot();
  const logs = [];

  t.after(() => {
    restoreApi();
    fake.restore();
    fs.rmSync(exportRoot, { recursive: true, force: true });
  });

  const engine = new ExtractEngine({
    exportRoot,
    profileDir: path.join(exportRoot, 'profile'),
    pageSettleMs: 0,
    onEvent: (event) => {
      if (event.type === 'log') logs.push(event.message);
    },
    control: {
      waitForCourse: async (courses) => courses[0],
      waitForExperiments: async (experiments) => [experiments[0]],
      waitForLevels: async (levels) => levels,
      shouldStop: async () => false
    }
  });
  await engine.run();

  const output = logs.join('\n');
  assert.match(output, /页面已不可用/, '崩溃必须被识别出来');
  assert.match(output, /已在新打开的实验页上恢复抓取/, '重开页面后要继续，而不是放弃整条链');
  assert.equal(engine.stats.saved, 3, '重开后三关都应抓到');
  assert.equal(engine.stats.failed, 0, '恢复成功后不应记失败');
});

test('引擎：多实验里一关都没被勾选的实验必须跳过（不再按「全不选＝全部」抓一遍）', async (t) => {
  const { ExtractEngine } = freshEngineModule();
  const exportRoot = withTempExportRoot();
  const events = [];
  t.after(() => fs.rmSync(exportRoot, { recursive: true, force: true }));

  const engine = new ExtractEngine({ exportRoot, onEvent: (event) => events.push(event) });
  let opened = 0;
  engine.openExperiment = async () => {
    opened += 1;
    return engine.page;
  };
  // 真机场景：合并列表里只勾了 CNN 的 5 关，另一个实验一关没勾——
  // 它必须被跳过（界面上写着「开始抓取选中的 5 个关卡」，不能偷偷把别的实验也抓了）。
  await engine.runExperiment(
    { name: '模型评估与选择', homeworkId: 3965742 },
    { name: '机器学习_2026年下半年' },
    { levels: [{ position: 1 }, { position: 2 }, { position: 3 }], selection: [], onlySelected: true }
  );
  assert.equal(opened, 0, '没勾选任何关卡的实验不允许进入');
  assert.match(
    events.filter((event) => event.type === 'log').map((event) => event.message).join('\n'),
    /一关都没被勾选，跳过/
  );
});

test('引擎：多实验时进度按整轮勾选数计（不被单个实验的 0/N 覆盖）', () => {
  const { ExtractEngine } = freshEngineModule();
  const events = [];
  const engine = new ExtractEngine({ exportRoot: 'x', onEvent: (event) => events.push(event) });
  engine.runProgress = { current: 3, total: 5 };
  // 单个实验自己报 0/3（切到下一个实验时的正常行为）——整轮模式下必须忽略它。
  engine.progress({ current: 0, total: 3, experimentName: '模型评估与选择' });
  const last = events[events.length - 1];
  assert.equal(last.total, 5, '总进度应是整轮勾选的关卡数');
  assert.equal(last.current, 3, '当前进度应是整轮已完成数，而不是当前实验的 0');
});

test('引擎：三段式关卡 URL 必须取最后一段作标识（取第一段会拿到课程码）', () => {
  const { ExtractEngine } = freshEngineModule();
  const from = ExtractEngine.identifierFromTaskUrl;

  // 真实形态（软件工程导论实训 igoyjkcv）：/tasks/{课程码}/{作业ID}/{关卡标识}
  assert.equal(
    from('https://www.educoder.net/tasks/2i6ng7vp/4157470/fru3ys8acf6n'),
    'fru3ys8acf6n',
    '三段式必须取最后一段，第一段 2i6ng7vp 是课程码'
  );
  // 旧形态：/tasks/{关卡标识}
  assert.equal(from('https://www.educoder.net/tasks/vrtbzlmexi3f?homework_common_id=3965745'), 'vrtbzlmexi3f');
  assert.equal(from('https://www.educoder.net/tasks/abc123'), 'abc123');
  // 非关卡 URL
  assert.equal(from('https://www.educoder.net/shixuns/igoyjkcv/challenges'), '');
  assert.equal(from(''), '');
  assert.equal(from(null), '');
});

test('引擎：入口必须是链首（第 1 关），列表最小序号为 1 时才免回溯', async (t) => {
  const fake = installFakePlaywright();
  const restoreApi = patchApiForFakes();
  const { ExtractEngine } = freshEngineModule();
  const exportRoot = withTempExportRoot();
  t.after(() => {
    restoreApi();
    fake.restore();
    fs.rmSync(exportRoot, { recursive: true, force: true });
  });

  const engine = new ExtractEngine({
    exportRoot,
    profileDir: path.join(exportRoot, 'profile'),
    pageSettleMs: 0,
    onEvent: () => {},
    control: {
      waitForCourse: async (c) => c[0],
      waitForExperiments: async (e) => e,
      waitForLevels: async () => null,
      shouldStop: async () => false
    }
  });
  await engine.launch();

  // 真实场景（Java 面向对象分析与设计）：实训页没有链接，
  // game_identifier 指向「上次停留的第 10 关」，必须定位到第 1 关。
  engine.discoveredLevels = [
    { identifier: 'a9trjhw67fzq', name: '设计模式', index: 10, type: 'choice' },
    { identifier: 'tbm7vw5ghuso', name: '面向对象技术的基本概念', index: 1, type: 'choice' },
    { identifier: '7yl9mvp8rg6x', name: '顺序图和通信图', index: 5, type: 'choice' },
    { identifier: 'wka96q3tjz7i', name: 'UML综合案例', index: 11, type: 'choice' }
  ];

  // 列表里已有序号 1 → 直接采用，不必回溯（省一次导航）
  const entry = await engine.resolveEntry({ gameIdentifier: 'a9trjhw67fzq' }, []);
  assert.equal(entry.identifier, 'tbm7vw5ghuso', '必须取序号为 1 的那一关');
  assert.equal(entry.index, 1);
  assert.equal(entry.source, 'level-list');

  // 页面链接指向列表中的关卡时也要取序号最小者
  const fromLinks = await engine.resolveEntry({ gameIdentifier: 'a9trjhw67fzq' }, [
    'https://www.educoder.net/tasks/wka96q3tjz7i?homework_common_id=1',
    'https://www.educoder.net/tasks/7yl9mvp8rg6x?homework_common_id=1'
  ]);
  assert.equal(fromLinks.identifier, '7yl9mvp8rg6x', '链接里的关卡要取序号最小者，而不是第一个链接');

  // 列表里没有序号 1（不完整）→ 必须用 prev_game 回溯纠正，不能直接把候选当第 1 关
  fake.state.ownResponses = [
    ['api/tasks/7yl9mvp8rg6x.json', JSON.stringify({ challenge: { subject: '顺序图和通信图', homework_challenge_index: 5 }, prev_game: 'tbm7vw5ghuso', next_game: null })],
    ['api/tasks/tbm7vw5ghuso.json', JSON.stringify({ challenge: { subject: '面向对象技术的基本概念', homework_challenge_index: 1 }, prev_game: null, next_game: '7yl9mvp8rg6x' })]
  ];
  engine.discoveredLevels = [
    { identifier: '7yl9mvp8rg6x', name: '顺序图和通信图', index: 5, type: 'choice' },
    { identifier: 'a9trjhw67fzq', name: '设计模式', index: 10, type: 'choice' }
  ];
  const corrected = await engine.resolveEntry({ gameIdentifier: 'a9trjhw67fzq' }, []);
  assert.equal(corrected.identifier, 'tbm7vw5ghuso', '列表不含第 1 关时必须回溯到链首');
  assert.equal(corrected.index, 1);
  assert.ok(String(corrected.source).startsWith('backtrack'), '来源应标记为回溯');
});

test('引擎：回溯读取失败时必须报告未确认，而不是假装成功', async (t) => {
  const fake = installFakePlaywright();
  const restoreApi = patchApiForFakes();
  const { ExtractEngine } = freshEngineModule();
  const exportRoot = withTempExportRoot();
  const events = [];
  t.after(() => {
    restoreApi();
    fake.restore();
    fs.rmSync(exportRoot, { recursive: true, force: true });
  });

  const engine = new ExtractEngine({
    exportRoot,
    profileDir: path.join(exportRoot, 'profile'),
    pageSettleMs: 0,
    onEvent: (event) => events.push(event),
    control: {
      waitForCourse: async (c) => c[0],
      waitForExperiments: async (e) => e,
      waitForLevels: async () => null,
      shouldStop: async () => false
    }
  });
  await engine.launch();
  engine.discoveredLevels = [];

  // 没有任何可用响应 → 回溯必然失败
  fake.state.ownResponses = [];
  const entry = await engine.resolveEntry({ gameIdentifier: 'unknownid123' }, []);
  assert.equal(entry.exact, false, '回溯失败必须标记为未确认');
  assert.ok(
    events.some((event) => event.type === 'log' && event.level === 'warn' && /未确认/.test(event.message)),
    '回溯失败必须给出 warn，提示产物可能与第 1 关不一致'
  );
});

test('引擎：关卡列表只有名称（无标识）时，用 findChainStart 回溯到第 1 关', async (t) => {
  const fake = installFakePlaywright();
  const restoreApi = patchApiForFakes();
  const { ExtractEngine } = freshEngineModule();
  const exportRoot = withTempExportRoot();

  // 真实形态：/api/shixuns/{id}/challenges.json 返回 { challenge_list:[{name,position}] }，
  // 只有名称与序号、没有关卡标识。这里直接预置响应缓存，验证解析与入口判定本身。
  const nameOnly = [
    { name: '面向对象技术的基本概念', position: 1, challenge_id: 1 },
    { name: 'UML概述', position: 2, challenge_id: 2 }
  ];

  t.after(() => {
    restoreApi();
    fake.restore();
    fs.rmSync(exportRoot, { recursive: true, force: true });
  });

  const engine = new ExtractEngine({
    exportRoot,
    profileDir: path.join(exportRoot, 'profile'),
    pageSettleMs: 0,
    onEvent: () => {},
    control: {
      waitForCourse: async (c) => c[0],
      waitForExperiments: async (e) => e,
      waitForLevels: async () => null,
      shouldStop: async () => false
    }
  });

  await engine.launch();

  // 1) challenge_list 形态能被解析（带查询串的真实 key 也要命中）
  engine.responseCache.set(
    'https://data.educoder.net/api/shixuns/zzzunique1/challenges.json?id=zzzunique1',
    JSON.stringify({ challenge_list: nameOnly })
  );
  const levels = engine.levelsFromCache(
    ['api/shixuns/zzzunique1/challenges.json', 'api/myshixuns/zzzunique2/challenges.json'],
    { name: '面向对象分析与设计' }
  );
  assert.equal(levels.length, 2, '必须能解析 challenge_list 形态');
  assert.equal(levels[0].name, '面向对象技术的基本概念');
  assert.equal(levels[0].index, 1, 'position 必须映射为 index');
  assert.equal(levels[0].identifier, '', '该形态没有标识，应留空而不是编造');

  // 2) 列表只有名称（无标识）时仍要能定位入口：回溯实训上下文得到链首
  engine.discoveredLevels = levels;
  fake.state.ownResponses = [
    ['api/tasks/quiz.json', JSON.stringify({ challenge: { subject: 'quiz', homework_challenge_index: 3 }, prev_game: 'pool', next_game: null })],
    ['api/tasks/pool.json', JSON.stringify({ challenge: { subject: 'pool', homework_challenge_index: 2 }, prev_game: 'conv', next_game: 'quiz' })],
    ['api/tasks/conv.json', JSON.stringify({ challenge: { subject: 'conv', homework_challenge_index: 1 }, prev_game: null, next_game: 'pool' })]
  ];
  const resolved = await engine.resolveEntry({ gameIdentifier: 'quiz' }, []);
  assert.equal(resolved.identifier, 'conv', '列表无标识时必须回溯到第 1 关');
  assert.equal(resolved.index, 1);
  assert.equal(resolved.exact, true);

  // 3) 回溯：沿 prev_game 一直走到 prev_game 为 null 的那一关
  const start = await engine.findChainStart('quiz', { homeworkId: 3965745 });
  assert.equal(start.identifier, 'conv', '必须回溯到 prev_game 为 null 的第一关');
  assert.equal(start.exact, true);
});

test('引擎：关卡多选时只抓选中的关卡，并能沿 next_game 链跳过未选关卡', async (t) => {
  const fake = installFakePlaywright();
  fake.state.ownResponses = defaultOwnResponses();
  const restoreApi = patchApiForFakes();
  const { ExtractEngine } = freshEngineModule();
  const exportRoot = withTempExportRoot();

  t.after(() => {
    restoreApi();
    fake.restore();
    fs.rmSync(exportRoot, { recursive: true, force: true });
  });

  const engine = new ExtractEngine({
    exportRoot,
    profileDir: path.join(exportRoot, 'profile'),
    pageSettleMs: 0,
    onEvent: () => {},
    control: {
      async waitForCourse(courses) {
        return courses[0];
      },
      async waitForExperiments(experiments) {
        return [experiments[0]];
      },
      async waitForLevels(levels) {
        // 只选第 1 关与第 3 关，跳过中间的 pool
        return [levels[0], levels[2]];
      },
      async shouldStop() {
        return false;
      }
    }
  });

  await engine.run();

  assert.deepEqual(engine.stats, { saved: 2, skipped: 0, failed: 0, existing: 0, dropped: 0 }, '只应保存选中的两关');
  const experimentDir = path.join(exportRoot, '机器学习_2026年下半年', 'CNN');
  const document = fs.readFileSync(path.join(experimentDir, 'CNN.md'), 'utf8');
  assert.ok(document.includes('## 第1关：conv'), '第1关应保存');
  assert.ok(!document.includes('## 第2关：pool'), '未选中的第2关不应保存');
  assert.ok(document.includes('## 第3关：欠拟合与过拟合'), '第3关应保存');
});

test('引擎：关卡列表无标识时「全选」不得把链上关卡全部跳过', async (t) => {
  const fake = installFakePlaywright();
  fake.state.ownResponses = defaultOwnResponses();
  const restoreApi = patchApiForFakes();
  const { ExtractEngine } = freshEngineModule();
  const exportRoot = withTempExportRoot();
  const events = [];

  t.after(() => {
    restoreApi();
    fake.restore();
    fs.rmSync(exportRoot, { recursive: true, force: true });
  });

  const engine = new ExtractEngine({
    exportRoot,
    profileDir: path.join(exportRoot, 'profile'),
    pageSettleMs: 0,
    onEvent: (event) => events.push(event),
    control: {
      async waitForCourse(courses) {
        return courses[0];
      },
      async waitForExperiments(experiments) {
        return [experiments[0]];
      },
      async waitForLevels(levels) {
        // 真实场景（软件工程导论 / 单元测试）：关卡列表只有名称，identifier 全是空串。
        // 前端「全选」时传回来的就是这样一份列表，按空串过滤会把所有关卡判成未选中。
        return levels.map((level) => ({ ...level, identifier: '' }));
      },
      async shouldStop() {
        return false;
      }
    }
  });

  await engine.run();

  assert.equal(engine.stats.saved, 3, '无标识的全选必须抓到全部关卡，不能被跳过');
  assert.equal(engine.stats.failed, 0);
  const experimentDir = path.join(exportRoot, '机器学习_2026年下半年', 'CNN');
  const document = fs.readFileSync(path.join(experimentDir, 'CNN.md'), 'utf8');
  for (const heading of ['## 第1关：conv', '## 第2关：pool', '## 第3关：欠拟合与过拟合']) {
    assert.ok(document.includes(heading), `${heading} 应被保存`);
  }
  assert.ok(
    events.some((event) => event.type === 'log' && /没有标识/.test(event.message)),
    '必须说明关卡列表没有标识、按关卡链抓取'
  );
  assert.ok(
    !events.some((event) => event.type === 'log' && /关卡链上只到达 0 关/.test(event.message)),
    '不应再出现「选中 N 关却到达 0 关」'
  );
});

test('引擎：非编程题/选择题的关卡（虚拟机等）计入 dropped 而不是 failed', async (t) => {
  const fake = installFakePlaywright();
  const restoreApi = patchApiForFakes();
  const { ExtractEngine } = freshEngineModule();

  // 虚拟机/图形化形态：标记为代码题但没有代码文件路径，也没有选题。
  const originalConv = TASKS.conv;
  const vmConv = {
    challenge: {
      subject: '虚拟机实操',
      homework_challenge_index: 1,
      with_code_file: true,
      path: null,
      task_pass: '### 任务描述\n\n请在虚拟机里启动 nginx 服务。'
    },
    next_game: null,
    chooses: []
  };
  TASKS.conv = vmConv;
  fake.state.ownResponses = [
    ['api/courses/HCEAP94S/homework_commons.json', JSON.stringify(EXPERIMENTS)],
    ['api/myshixun/sb5zfhoq8g/challenges.json', JSON.stringify(CHALLENGES)],
    ['api/myshixuns/sb5zfhoq8g/challenges.json', JSON.stringify(CHALLENGES)],
    ['api/tasks/conv.json', JSON.stringify(vmConv)]
  ];

  const exportRoot = withTempExportRoot();
  const events = [];
  t.after(() => {
    TASKS.conv = originalConv;
    restoreApi();
    fake.restore();
    fs.rmSync(exportRoot, { recursive: true, force: true });
  });

  const engine = new ExtractEngine({
    exportRoot,
    profileDir: path.join(exportRoot, 'profile'),
    pageSettleMs: 0,
    onEvent: (event) => events.push(event),
    control: {
      async waitForCourse(courses) {
        return courses[0];
      },
      async waitForExperiments(experiments) {
        return [experiments[0]];
      },
      async waitForLevels(levels) {
        return [levels[0]];
      },
      async shouldStop() {
        return false;
      }
    }
  });

  await engine.run();

  assert.equal(engine.stats.saved, 0);
  assert.equal(engine.stats.skipped, 1, '被抛弃的关卡计为 skipped');
  assert.equal(engine.stats.dropped, 1, 'dropped 单独计数，便于界面说明「抛弃了 N 关」');
  assert.equal(engine.stats.failed, 0);
  const dropped = events.find((event) => event.type === 'dropped');
  assert.ok(dropped, '应发出 dropped 事件');
  assert.match(dropped.reason, /没有代码文件路径/, '必须说明为什么抛弃');
  // 被抛弃的关卡不得进入产物
  const experimentDir = path.join(exportRoot, '机器学习_2026年下半年', 'CNN');
  assert.ok(!fs.existsSync(path.join(experimentDir, 'CNN.md')), '全是被抛弃关卡时不应产生实验文件');
});

test('引擎：stop 请求后停止且不产生 done.stopped=false', async (t) => {
  const fake = installFakePlaywright();
  fake.state.ownResponses = defaultOwnResponses();
  const restoreApi = patchApiForFakes();
  const { ExtractEngine } = freshEngineModule();
  const exportRoot = withTempExportRoot();
  let stopCalls = 0;
  const events = [];

  t.after(() => {
    restoreApi();
    fake.restore();
    fs.rmSync(exportRoot, { recursive: true, force: true });
  });

  const engine = new ExtractEngine({
    exportRoot,
    profileDir: path.join(exportRoot, 'profile'),
    pageSettleMs: 0,
    onEvent: (event) => events.push(event),
    control: {
      async waitForCourse(courses) {
        return courses[0];
      },
      async waitForExperiments(experiments) {
        return [experiments[0]];
      },
      async waitForLevels(levels) {
        return levels;
      },
      async shouldStop() {
        stopCalls += 1;
        return stopCalls > 2;
      }
    }
  });

  await engine.run();

  assert.ok(engine.stats.saved < 3, '应在抓完全部关卡前停止');
  assert.ok(engine.stopRequested, '应记录停止请求');
  const done = events.find((event) => event.type === 'done');
  assert.ok(done, '停止后也必须发 done，界面才能回到终态');
  assert.equal(done.stopped, true, 'done.stopped 必须为 true');
});

test('引擎：等待登录期间收到停止请求也必须以 done 收场（否则界面永远停在等待登录）', async (t) => {
  const fake = installFakePlaywright();
  fake.state.ownResponses = defaultOwnResponses();
  const restoreApi = patchApiForFakes();
  const { ExtractEngine } = freshEngineModule();
  const exportRoot = withTempExportRoot();
  const events = [];

  // 让登录判定永远失败，把引擎压在 waiting-login 阶段；随后模拟用户点了「停止」。
  const api = require('../extractor/lib/educoder-api');
  const originalCheckLogin = api.checkLogin;
  const originalProbe = api.probeLogin;
  api.checkLogin = async () => ({ loggedIn: false, reason: '测试：未登录', pageUrl: '' });
  api.probeLogin = async () => ({ loggedIn: false, reason: '测试：未登录', pageUrl: '', status: 200, preview: '' });

  t.after(() => {
    api.checkLogin = originalCheckLogin;
    api.probeLogin = originalProbe;
    restoreApi();
    fake.restore();
    fs.rmSync(exportRoot, { recursive: true, force: true });
  });

  const engine = new ExtractEngine({
    exportRoot,
    profileDir: path.join(exportRoot, 'profile'),
    pageSettleMs: 0,
    onEvent: (event) => events.push(event),
    control: {
      waitForCourse: async () => null,
      waitForExperiments: async () => [],
      waitForLevels: async () => null,
      shouldStop: async () => true
    }
  });

  await engine.run();

  const phases = events.filter((event) => event.type === 'status').map((event) => event.phase);
  assert.ok(phases.includes('waiting-login'), '应先进入等待登录');
  assert.ok(
    ['done', 'error', 'stopping'].some((phase) => phases.includes(phase)),
    `停止后必须进入终态，实际阶段：${phases.join(' → ')}`
  );
  const done = events.find((event) => event.type === 'done');
  assert.ok(done, '必须发出 done 事件，前端的「开始提取/继续提取」才会重新可用');
  assert.equal(done.stopped, true, '应标记为「已停止」而不是正常完成');
});

test('引擎：EDUCODER_INLINE_IMAGES=1 时图片以 data URI 内嵌进 imageMap', async (t) => {
  const fake = installFakePlaywright();
  const restoreApi = patchApiForFakes();
  const { ExtractEngine } = freshEngineModule();
  const exportRoot = withTempExportRoot();
  const previous = process.env.EDUCODER_INLINE_IMAGES;
  process.env.EDUCODER_INLINE_IMAGES = '1';
  t.after(() => {
    restoreApi();
    fake.restore();
    fs.rmSync(exportRoot, { recursive: true, force: true });
    if (previous === undefined) delete process.env.EDUCODER_INLINE_IMAGES;
    else process.env.EDUCODER_INLINE_IMAGES = previous;
  });

  const engine = new ExtractEngine({
    exportRoot,
    profileDir: path.join(exportRoot, 'profile'),
    pageSettleMs: 0,
    onEvent: () => {},
    control: {
      waitForCourse: async (courses) => courses[0],
      waitForExperiments: async (experiments) => [experiments[0]],
      waitForLevels: async (levels) => levels
    }
  });
  await engine.launch();

  const task = {
    taskIndex: 1,
    taskDescription: '<img src="/api/attachments/123">',
    programmingRequirements: '',
    choices: [],
    choiceQuestions: []
  };
  await engine.attachImages(engine.page, task);

  const mapped = Object.values(task.imageMap || {});
  assert.equal(mapped.length, 1, `应有一张图，实际 ${mapped.length}`);
  assert.ok(
    String(mapped[0]).startsWith('data:image/png;base64,'),
    `内置时 imageMap 应是 data URI，实际：${String(mapped[0]).slice(0, 48)}`
  );
});

test('引擎：初始代码必须走带签名接口（无签名请求 + 页面重载兜底都不再使用）', async (t) => {
  const fake = installFakePlaywright();
  fake.state.ownResponses = defaultOwnResponses();
  // 真实的无签名请求必被 -102 拒绝（实测）：旧实现因此永远拿不到内容，只能靠
  // 「重载页面、等页面自己请求」兜底——那只在页面恰好停在本题时才命中，
  // 属于「每个实验最多只有一关有初始代码」的根因。这里把无签名路径显式模拟成 -102。
  fake.state.requestGet = async () => ({
    ok: () => true,
    async json() {
      return { status: -102, message: '服务器时间与您的设备时间不匹配' };
    }
  });
  const restoreApi = patchApiForFakes();
  const { ExtractEngine } = freshEngineModule();
  const exportRoot = withTempExportRoot();

  t.after(() => {
    restoreApi();
    fake.restore();
    fs.rmSync(exportRoot, { recursive: true, force: true });
  });

  const engine = new ExtractEngine({
    exportRoot,
    profileDir: path.join(exportRoot, 'profile'),
    pageSettleMs: 0,
    onEvent: () => {},
    control: {
      async waitForCourse(courses) {
        return courses[0];
      },
      async waitForExperiments(experiments) {
        return [experiments[0]];
      },
      async waitForLevels(levels) {
        return levels;
      },
      async shouldStop() {
        return false;
      }
    }
  });
  await engine.run();

  const document = fs.readFileSync(path.join(exportRoot, '机器学习_2026年下半年', 'CNN', 'CNN.md'), 'utf8');
  assert.match(document, /print\("starter"\)/, '初始代码必须来自带签名的 apiGet');
  assert.equal(fake.state.requestGetCalls, 0, '不得再发无签名请求（真实环境里必被 -102 拒绝）');
});

test('引擎：已通过测评的关卡自动导出答案（代码取文件内容、选择题取所选项）', async (t) => {
  const { ExtractEngine } = freshEngineModule();
  const { taskFromApi } = require('../extractor/lib/task-parser');
  const exportRoot = withTempExportRoot();
  const events = [];
  t.after(() => fs.rmSync(exportRoot, { recursive: true, force: true }));

  const engine = new ExtractEngine({ exportRoot, onEvent: (event) => events.push(event) });
  const course = '软件工程导论2026年下半年';
  const experiment = '[6、软件实现] 编程风格';
  // captureLevel 传给 captureAnswer 的是 Course / Experiment 对象（不是名字）：
  // 用真实形状调用，锁定「别写出 [object Object]__… 这种答案文件」。
  const courseObj = { name: course, classroomCode: 'HCEAP94S' };
  const experimentObj = { name: experiment, homeworkId: 4157465 };

  // 编程题：满分通过 → rep_content 的内容（就是用户提交的代码）作为答案
  const codePayload = {
    challenge: {
      subject: '命名',
      homework_challenge_index: 1,
      with_code_file: true,
      path: 'src/step1/source.java',
      score: 100,
      task_pass: '#### 1 任务描述\n\n本关任务：命名规范。'
    },
    game: { final_score: 100 },
    chooses: []
  };
  const codeTask = taskFromApi(codePayload, courseObj, experimentObj, 'https://www.educoder.net/tasks/apyx7ui9womq');
  codeTask.starterCode = '//请修改类名使其符合命名规范\npublic class MailService {\n}\n';
  const codeSaved = await engine.captureAnswer(codeTask, codePayload, courseObj, experimentObj);
  assert.equal(codeSaved.ok, true, JSON.stringify(codeSaved));

  // 选择题：满分通过 → choose_test_cases 里的选项（按题号，多选连写要归一成逗号分隔）
  const choicePayload = {
    challenge: { subject: '选择正确的编程语言', homework_challenge_index: 2, score: 50 },
    game: { final_score: 50 },
    chooses: [
      { subject: 'SQLite 用什么语言开发', challenge_question: [{ option_name: 'A' }, { option_name: 'B' }, { option_name: 'C' }, { option_name: 'D' }] }
    ],
    choose_test_cases: {
      had_submmit: true,
      test_sets: [
        { position: 2, actual_output: 'B', standard_answer: null },
        { position: 1, actual_output: 'CA', standard_answer: null }
      ]
    }
  };
  const choiceTask = taskFromApi(choicePayload, courseObj, experimentObj, 'https://www.educoder.net/tasks/6a42oymgfkjt');
  const choiceSaved = await engine.captureAnswer(choiceTask, choicePayload, courseObj, experimentObj);
  assert.equal(choiceSaved.ok, true, JSON.stringify(choiceSaved));

  const answerFile = path.join(exportRoot, 'answers', `${course}__${experiment}.answers.json`);
  assert.equal(codeSaved.answerPath, answerFile);
  const document = JSON.parse(fs.readFileSync(answerFile, 'utf8'));
  assert.equal(document.course, course);
  assert.equal(document.experiment, experiment);
  assert.deepEqual(
    document.answers.map((item) => [item.level_id, item.kind]),
    [['L001', 'code'], ['L002', 'choice']],
    '两关都要按顺序写入'
  );
  assert.match(document.answers[0].answer, /public class MailService/, '编程题答案是提交的文件内容');
  assert.equal(document.answers[1].answer, '1:A,C;2:B', '选择题答案按题号，多选字母升序');

  const logs = events.filter((event) => event.type === 'log').map((event) => event.message).join('\n');
  assert.match(logs, /已导出答案（已通过测评）：L001/, '导出要留日志，用户要知道答案写哪去了');
});

test('引擎：未通过测评 / 非可作答题型不得导出答案', async (t) => {
  const { ExtractEngine } = freshEngineModule();
  const { taskFromApi } = require('../extractor/lib/task-parser');
  const exportRoot = withTempExportRoot();
  t.after(() => fs.rmSync(exportRoot, { recursive: true, force: true }));
  const engine = new ExtractEngine({ exportRoot, onEvent: () => {} });
  const course = 'c';
  const experiment = 'e';

  // 未提交：final_score = 0，即使测试点的 output 写着「通过」也不算通过
  const pending = {
    challenge: { subject: 'x', homework_challenge_index: 1, with_code_file: true, path: 'a.py', score: 100 },
    game: { final_score: 0 },
    test_sets: [{ result: null, output: '通过' }],
    chooses: []
  };
  const pendingTask = taskFromApi(pending, course, experiment, 'https://www.educoder.net/tasks/x');
  pendingTask.starterCode = 'print(1)';
  const skipped = await engine.captureAnswer(pendingTask, pending, course, experiment);
  assert.equal(skipped.ok, false);
  assert.equal(skipped.skipped, '未通过测评');

  // 虚拟机/图形化题（白名单外）：即使满分也不导出——那份内容不是"答案"
  const rejected = {
    challenge: { subject: '画用例图', homework_challenge_index: 2, with_code_file: true, path: 'AT/step2', score: 100 },
    game: { final_score: 100 },
    code_editor: {},
    chooses: []
  };
  const rejectedTask = taskFromApi(rejected, course, experiment, 'https://www.educoder.net/tasks/y');
  rejectedTask.starterCode = '图形化内容';
  const dropped = await engine.captureAnswer(rejectedTask, rejected, course, experiment);
  assert.equal(dropped.ok, false);
  assert.equal(dropped.skipped, '不是可作答题型');

  assert.equal(fs.existsSync(path.join(exportRoot, 'answers')), false, '不允许留下答案文件');
});

test('引擎：只提取答案模式只写 answers，不写 levels.jsonl / md / 图片', async (t) => {
  const fake = installFakePlaywright();
  // 本地夹具：conv 已通过（有代码答案），pool 未通过（必须计「跳过」而不是失败）
  const tasks = {
    conv: {
      challenge: {
        subject: 'conv',
        homework_challenge_index: 1,
        with_code_file: true,
        path: 'conv.py',
        score: 100,
        task_pass: '### 任务描述\n\n实现卷积。'
      },
      game: { final_score: 100 },
      next_game: 'pool',
      chooses: []
    },
    pool: {
      challenge: {
        subject: 'pool',
        homework_challenge_index: 2,
        with_code_file: true,
        path: 'pool.py',
        score: 100,
        task_pass: '### 任务描述\n\n实现池化。'
      },
      game: { final_score: 0 },
      next_game: null,
      chooses: []
    }
  };
  fake.state.ownResponses = [
    ['api/courses/HCEAP94S/homework_commons.json', JSON.stringify(EXPERIMENTS)],
    ['api/myshixuns/sb5zfhoq8g/challenges.json', JSON.stringify([
      { identifier: 'conv', subject: 'conv', homework_challenge_index: 1, with_code_file: true, chooses: [] },
      { identifier: 'pool', subject: 'pool', homework_challenge_index: 2, with_code_file: true, chooses: [] }
    ])],
    ...Object.entries(tasks).map(([id, payload]) => [`api/tasks/${id}.json`, JSON.stringify(payload)])
  ];
  const restoreApi = patchApiForFakes();
  const { ExtractEngine } = freshEngineModule();
  const exportRoot = withTempExportRoot();
  const events = [];
  t.after(() => {
    restoreApi();
    fake.restore();
    fs.rmSync(exportRoot, { recursive: true, force: true });
  });

  const engine = new ExtractEngine({
    exportRoot,
    profileDir: path.join(exportRoot, 'profile'),
    pageSettleMs: 0,
    answersOnly: true,
    onEvent: (event) => events.push(event),
    control: {
      waitForCourse: async (courses) => courses[0],
      waitForExperiments: async (experiments) => [experiments[0]],
      waitForLevels: async (levels) => levels
    }
  });

  await engine.run();

  // ① 答案文件照写：只有已通过的 conv（代码内容来自 rep_content，与「已提交的代码」同口径）
  const answerPath = path.join(exportRoot, 'answers', '机器学习_2026年下半年__CNN.answers.json');
  const document = JSON.parse(fs.readFileSync(answerPath, 'utf8'));
  assert.deepEqual(document.answers.map((item) => item.level_id), ['L001']);
  assert.equal(document.answers[0].kind, 'code');
  assert.match(String(document.answers[0].answer), /print\("starter"\)/);

  // ② 题目存档一律不写：连实验目录都不该出现（levels.jsonl / 实验.md / assets 都在它下面）
  const experimentDir = path.join(exportRoot, '机器学习_2026年下半年', 'CNN');
  assert.equal(
    fs.existsSync(experimentDir),
    false,
    `只提取答案不得创建实验目录，实际内容：${fs.existsSync(experimentDir) ? fs.readdirSync(experimentDir).join(',') : '(不存在)'}`
  );

  // ③ 计数口径：已通过 = 已保存（答案已导出）；未通过 = 跳过
  const done = events.filter((event) => event.type === 'done').pop();
  assert.ok(done, '应发出 done');
  assert.equal(done.saved, 1, '已通过关卡应计「已保存」（答案已导出）');
  assert.equal(done.skipped, 1, '未通过关卡应计「跳过」');
});
