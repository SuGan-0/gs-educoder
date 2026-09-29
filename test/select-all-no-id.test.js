/* 核心逻辑单测（不需要真实站点/登录）：验证「无标识全选」不再跳过关卡链。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const BASE64 = (v) => Buffer.from(v, 'utf8').toString('base64');

const EXPERIMENTS = {
  status: 0,
  homeworks: [
    { name: '单元测试', homework_id: 88000012, shixun_identifier: 'zqf495e6', myshixun_identifier: 'mx1', challenge_count: 2, is_shixun: true }
  ]
};
// 真实形态：challenge_list 只有 name/position，没有 identifier
const NAME_ONLY_CHALLENGES = JSON.stringify({
  challenge_list: [
    { challenge_id: 1, position: 1, name: '使用Junit进行单元测试' },
    { challenge_id: 2, position: 2, name: '单元测试覆盖率' }
  ]
});
const TASKS = {
  zq802d68bc2d: { challenge: { subject: '使用Junit进行单元测试', homework_challenge_index: 1, with_code_file: false, task_pass: '' }, prev_game: null, next_game: 'zqf54ffa32f5', chooses: [{ subject: 'q1', challenge_question: [{ option_name: 'A' }] }] },
  zqf54ffa32f5: { challenge: { subject: '单元测试覆盖率', homework_challenge_index: 2, with_code_file: false, task_pass: '' }, prev_game: 'zq802d68bc2d', next_game: null, chooses: [{ subject: 'q2', challenge_question: [{ option_name: 'B' }] }] }
};

function jsonBody(body, status = 200) {
  return { status, body };
}

const state = {
  currentUrl: 'https://www.educoder.net/users/p8sxailt2/classrooms',
  ownResponses: [
    ['api/courses/zqf25f66/homework_commons.json', JSON.stringify(EXPERIMENTS)],
    ['api/shixuns/zqf495e6/challenges.json?id=zqf495e6', NAME_ONLY_CHALLENGES],
    ['api/tasks/zq802d68bc2d.json', JSON.stringify(TASKS.zq802d68bc2d)],
    ['api/tasks/zqf54ffa32f5.json', JSON.stringify(TASKS.zqf54ffa32f5)]
  ]
};

const listeners = new Set();
const replay = async () => {
  for (const [fragment, body] of state.ownResponses) {
    for (const listener of [...listeners]) {
      await listener({
        url: () => `https://data.educoder.net/${fragment}`,
        status: () => 200,
        ok: () => true,
        request: () => ({ method: () => 'GET' }),
        async text() { return body; },
        async json() { return JSON.parse(body); }
      });
    }
  }
};
const loop = setInterval(() => replay().catch(() => {}), 20);
if (loop.unref) loop.unref();

function apiBody(url) {
  const parsed = new URL(url);
  if (parsed.pathname.endsWith('/courses.json')) return jsonBody(JSON.stringify({ count: 1, courses: [{ id: 120003, name: '示例课程A', first_category_url: '/classrooms/zqf25f66/announcement' }] }));
  if (parsed.pathname.endsWith('homework_commons.json')) return jsonBody(JSON.stringify(EXPERIMENTS));
  if (parsed.pathname.endsWith('challenges.json')) return jsonBody(NAME_ONLY_CHALLENGES);
  if (parsed.pathname.endsWith('rep_content.json')) return jsonBody(JSON.stringify({ content: { content: BASE64('x') } }));
  const id = parsed.pathname.match(/\/api\/tasks\/([^/.]+)\.json/)?.[1];
  if (id && TASKS[id]) return jsonBody(JSON.stringify(TASKS[id]));
  throw new Error(`未覆盖：${url}`);
}

const page = {
  url: () => state.currentUrl,
  on: (e, h) => { if (e === 'response') listeners.add(h); return page; },
  off: (e, h) => { if (e === 'response') listeners.delete(h); return page; },
  async goto(u) { state.currentUrl = u; await replay(); },
  async reload() { await replay(); },
  async waitForTimeout() {},
  async waitForLoadState() {},
  async close() {},
  async evaluate(fn, arg) {
    const src = fn.toString();
    // apiGet 传对象 { url, headers }，图片回调传字符串 URL。
    const url = typeof arg === 'string' ? arg : String((arg && arg.url) || '');
    if (url && /arrayBuffer/.test(src)) return { base64: 'iVBORw0KGgo=', contentType: 'image/png' };
    if (url && /fetch\s*\(/.test(src)) return apiBody(url);
    return fn(arg);
  },
  async waitForResponse() { return null; },
  async waitForEvent() { return null; },
  /**
   * 引擎用 evaluateHandle 在页面里定位「实验卡片 / 进入关卡按钮」（真实 Playwright 的句柄
   * 支持 asElement/evaluate/click/dispose）。假页面没有 DOM，返回一个可点的假句柄即可。
   */
  async evaluateHandle() {
    const handle = { async asElement() { return el; }, async dispose() {} };
    const el = { ...handle, async evaluate() { return '开始学习'; }, async click() {} };
    return handle;
  },
  locator() {
    const el = {
      first: () => el, filter: () => el, getByText: () => el,
      async count() { return 0; },
      async click() {},
      async evaluateAll(fn, arg) { return fn([], arg); }
    };
    return el;
  },
  getByText() {
    const el = { first: () => el, async count() { return 0; }, async click() {} };
    return el;
  },
  request: { method: () => 'GET', async get() { return { ok: () => false, status: () => 404, async json() {} }; } }
};
const context = { pages: () => [page], async newPage() { return page; }, async close() {} };

const originalLoad = Module._load;
Module._load = function (request) {
  if (request === 'playwright') return { chromium: { async launchPersistentContext() { return context; } } };
  return originalLoad.apply(this, arguments);
};

const api = require('../extractor/lib/educoder-api');
api.checkLogin = async () => ({ loggedIn: true, user: 'p8sxailt2' });

// 两个用例都要用这份桩：不在单个用例里还原 Module._load / checkLogin，
// 否则后一个用例会走真实网络并空转到超时。
test.after(() => {
  Module._load = originalLoad;
});

test('无标识的关卡列表 + 全选：必须抓完关卡链上的全部关卡', async (t) => {
  for (const key of Object.keys(require.cache)) {
    if (/extract-engine\.js$/.test(key)) delete require.cache[key];
  }
  const { ExtractEngine } = require('../extractor/lib/extract-engine');
  const exportRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'touge-selcheck-'));
  const events = [];

  t.after(() => {
    fs.rmSync(exportRoot, { recursive: true, force: true });
  });

  const engine = new ExtractEngine({
    exportRoot,
    profileDir: path.join(exportRoot, 'profile'),
    pageSettleMs: 0,
    onEvent: (e) => events.push(e),
    control: {
      waitForCourse: async (c) => c[0],
      async waitForExperiments(experiments) {
        // 入口已由 openExperiment / 查看实战 + 回溯解析好（本用例只验证选择过滤）。
        experiments[0].entryIdentifier = 'zq802d68bc2d';
        return experiments;
      },
      async waitForLevels(levels) {
        // 前端「全选」的真实形态：identifier 全是空串
        return levels.map((l) => ({ ...l, identifier: '' }));
      },
      shouldStop: async () => false
    }
  });

  await engine.run();

  const logs = events.filter((e) => e.type === 'log').map((e) => e.message);
  assert.equal(engine.stats.saved, 2, `应抓完 2 关，实际 ${engine.stats.saved}；日志：${logs.join(' | ')}`);
  assert.equal(engine.stats.failed, 0);
  assert.ok(
    logs.some((m) => /按序号过滤/.test(m)),
    '应说明按序号过滤选中关卡'
  );
  assert.ok(
    !logs.some((m) => /只到达 0 关/.test(m)),
    '不应再出现「到达 0 关」'
  );

  const dir = path.join(exportRoot, '示例课程A', '单元测试');
  const document = fs.readFileSync(path.join(dir, '单元测试.md'), 'utf8');
  assert.ok(document.includes('## 第1关：使用Junit进行单元测试'), '第1关应保存');
  assert.ok(document.includes('## 第2关：单元测试覆盖率'), '第2关应保存');
});

test('无标识的关卡列表：只勾选其中一关时必须能跳过其它关', async (t) => {
  for (const key of Object.keys(require.cache)) {
    if (/extract-engine\.js$/.test(key)) delete require.cache[key];
  }
  // 清掉上一个用例留下的响应监听器：假页面的回放循环会持续向旧监听器投递响应，
  // 不清理会让后一个用例读到前一个用例的状态。
  listeners.clear();
  state.currentUrl = 'https://www.educoder.net/users/p8sxailt2/classrooms';
  const { ExtractEngine } = require('../extractor/lib/extract-engine');
  const exportRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'touge-skipcheck-'));
  const events = [];

  t.after(() => {
    fs.rmSync(exportRoot, { recursive: true, force: true });
  });

  const engine = new ExtractEngine({
    exportRoot,
    profileDir: path.join(exportRoot, 'profile'),
    pageSettleMs: 0,
    onEvent: (e) => events.push(e),
    control: {
      waitForCourse: async (c) => c[0],
      async waitForExperiments(experiments) {
        experiments[0].entryIdentifier = 'zq802d68bc2d';
        return experiments;
      },
      async waitForLevels(levels) {
        // 只勾选第 2 关（无标识，靠序号表达选择）
        return levels
          .filter((l) => Number(l.position) === 2)
          .map((l) => ({ ...l, identifier: '' }));
      },
      shouldStop: async () => false
    }
  });

  await engine.run();

  const logs = events.filter((e) => e.type === 'log').map((e) => e.message);
  assert.equal(engine.stats.saved, 1, `只应抓第 2 关，实际 ${engine.stats.saved}；日志：${logs.join(' | ')}`);
  assert.equal(engine.stats.failed, 0, '跳过未选关卡不应计为失败');

  const dir = path.join(exportRoot, '示例课程A', '单元测试');
  const document = fs.readFileSync(path.join(dir, '单元测试.md'), 'utf8');
  assert.ok(
    !document.includes('## 第1关：使用Junit进行单元测试'),
    '未勾选的第 1 关不得被抓取'
  );
  assert.ok(document.includes('## 第2关：单元测试覆盖率'), '勾选的第 2 关应被抓取');
  assert.ok(
    logs.some((m) => /跳过未选中的关卡：第 1 关/.test(m)),
    '应记录跳过了第 1 关'
  );
});
