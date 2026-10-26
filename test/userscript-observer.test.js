'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'userscript', 'educoder-autosubmit.user.js'), 'utf8');
const QUEUE_KEY = 'educoder-teach-queue';
const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const flush = () => new Promise((resolve) => setImmediate(resolve));

function load({ onSettle = () => {}, buttons = [], fetchImpl, resultText = '', gmImpl, fastTimers = false } = {}) {
  const store = new Map();
  const requests = [];
  const fetches = [];
  const hooks = {};
  let response = { challenge: { position: 1, subject: '当前关卡' }, chooses: [] };
  let clones = 0;
  let code = 'template';
  const model = {
    uri: { path: '/code.sql' }, getValue: () => code,
    setValue: (value) => { code = value; }, isDisposed: () => false
  };
  function FakeXHR() { this.listeners = []; }
  FakeXHR.prototype.open = function () {};
  FakeXHR.prototype.send = function () {};
  FakeXHR.prototype.addEventListener = function (event, handler, options) {
    this.listeners.push({ event, handler, once: Boolean(options && options.once) });
  };
  FakeXHR.prototype.complete = function (payload, status = 200) {
    this.status = status;
    this.responseText = JSON.stringify(payload);
    const listeners = this.listeners.filter((item) => item.event === 'loadend');
    this.listeners = this.listeners.filter((item) => item.event !== 'loadend' || !item.once);
    for (const item of listeners) item.handler();
  };
  const document = {
    getElementById: () => null, querySelector: () => null,
    querySelectorAll: (selector) => String(selector).includes('button') ? buttons
      : /result|judge|evaluate|message|alert|notification/.test(String(selector)) && resultText
        ? [{ textContent: resultText }] : [],
    body: { append() {}, innerText: '' }, head: { append() {} },
    createElement: () => ({ style: {}, append() {}, setAttribute() {} })
  };
  const location = { pathname: '/tasks/current', href: 'https://www.educoder.net/tasks/current', origin: 'https://www.educoder.net', reload() {} };
  const host = {
    document, location, __educoderAutosubmitTestHooks: hooks,
    atob, btoa, TextDecoder,
    Monaco: { editor: { getModels: () => [model] } },
    fetch(input, init) {
      fetches.push({ input, init });
      return fetchImpl ? fetchImpl(input, init) : Promise.resolve({
        ok: true, status: 200,
        clone() { clones += 1; return { json: async () => response }; }
      });
    },
    XMLHttpRequest: FakeXHR
  };
  const sandbox = {
    window: host, unsafeWindow: host, document, location, URL, URLSearchParams,
    console: { log() {}, error() {} },
    setTimeout: (callback, ms) => {
      if (ms === 2000) onSettle({ hooks, location, buttons });
      return setTimeout(callback, fastTimers || ms === 2000 ? 1 : ms);
    },
    clearTimeout,
    GM_getValue: (key, fallback) => store.has(key) ? clone(store.get(key)) : fallback,
    GM_setValue: (key, value) => store.set(key, clone(value)),
    GM_deleteValue: (key) => store.delete(key),
    GM_registerMenuCommand() {},
    GM_xmlhttpRequest: (options) => { requests.push(options); if (gmImpl) gmImpl(options, hooks, location); }
  };
  vm.createContext(sandbox);
  new vm.Script(SOURCE).runInContext(sandbox);
  return {
    hooks, host, location, store, requests, fetches, FakeXHR,
    setResponse: (value) => { response = value; },
    clones: () => clones,
    code: () => code
  };
}

function configureTestSigning(env) {
  const key = btoa(btoa('test-only-signing-key'));
  env.store.set('educoder-sign-ak', key);
  env.store.set('educoder-sign-sk', key);
}

test('回捞实验通过带签名的 data API 读取全部已通过代码，不污染当前关卡', async () => {
  const calls = [];
  const code = { current: 'SELECT 1; -- fixture', next: 'SELECT 2; -- fixture' };
  const env = load({ fetchImpl: async (input, init) => {
    const url = new URL(String(input), 'https://www.educoder.net');
    calls.push({ url, init });
    let payload = { status: -102, message: '缺少签名' };
    if (url.origin === 'https://data.educoder.net' && init.headers?.['X-EDU-Signature']) {
      const id = /\/api\/tasks\/([^/.]+)/.exec(url.pathname)?.[1];
      payload = url.pathname.endsWith('/rep_content.json')
        ? { content: { content: Buffer.from(code[id]).toString('base64') } }
        : { challenge: { position: id === 'current' ? 1 : 2, subject: id, score: 100, with_code_file: true, path: 'src/main.sql' },
          game: { final_score: 100 }, next_game: id === 'current' ? 'next' : '', prev_game: id === 'next' ? 'current' : '' };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(payload), json: async () => payload };
  } });
  configureTestSigning(env);
  env.hooks.state.taskContext = { id: 'current', homeworkId: 123, levelPosition: 1, experimentName: 'SQL', classroomCode: 'DEMO' };
  for (const [id, position] of [['current', 1], ['next', 2]]) {
    const key = `课程__SQL__L00${position}`;
    env.hooks.state.levelIndex[id] = key;
    env.hooks.state.answers[key] = { experiment: 'SQL', kind: 'code', answer: 'old' };
  }
  const before = clone(env.hooks.state.taskContext);
  env.hooks.installNetworkHooks();
  await env.hooks.exportExperimentAnswers();
  assert.equal(calls.length, 4, '两关数据和两份代码各读取一次');
  for (const { url, init } of calls) {
    assert.equal(url.origin, 'https://data.educoder.net');
    assert.equal(url.searchParams.get('__easBatch'), '1');
    assert.equal(url.searchParams.get('homework_common_id'), '123');
    assert.equal(init.credentials, 'include');
    assert.equal(init.headers['X-EDU-Type'], 'pc');
    assert.match(init.headers['X-EDU-Signature'], /^[a-f0-9]{32}$/);
    assert.ok(Number(init.headers['X-EDU-Timestamp']) > 0);
    assert.ok(!init.method || init.method === 'GET', '回捞只发只读请求');
  }
  assert.deepEqual(clone(env.hooks.state.taskContext), before, '批量读取不能把相邻关卡写成当前关');
  for (const [id, answer] of Object.entries(code)) {
    const entry = env.hooks.state.answers[env.hooks.state.levelIndex[id]];
    assert.equal(env.hooks.readAnswer(entry).code, answer);
    assert.equal(entry.verified, true);
  }
});

test('回捞接口的 HTTP 200 拒绝响应必须报错，不能伪装成没有答案', async () => {
  for (const status of [-102, -1, 401, 403]) {
    const payload = { status, message: status === 401 ? '请登录后再操作' : '请求被拒绝' };
    const env = load({ fetchImpl: async () => ({ ok: true, status: 200,
      text: async () => JSON.stringify(payload), json: async () => payload }) });
    configureTestSigning(env);
    await assert.rejects(env.hooks.fetchTaskData('current'), /-102|请求被拒绝|请登录/);
  }
});

test('回捞遇到不含关卡的成功外壳响应时明确报告数据格式错误', async () => {
  const payload = { status: 0, data: null };
  const env = load({ fetchImpl: async () => ({ ok: true, status: 200,
    text: async () => JSON.stringify(payload), json: async () => payload }) });
  configureTestSigning(env);
  await assert.rejects(env.hooks.fetchTaskData('current'), /关卡数据|challenge/);
});

test('回捞被拒时提示读取失败，未通过的草稿不会被存成答案', async () => {
  const payload = { status: 401, message: '请登录后再操作' };
  const env = load({ fetchImpl: async () => ({ ok: true, status: 200,
    text: async () => JSON.stringify(payload), json: async () => payload }) });
  configureTestSigning(env);
  env.hooks.state.taskContext = { id: 'current', homeworkId: 123, levelPosition: 1, passed: false };
  env.hooks.state.levelIndex.current = 'sql';
  env.hooks.state.answers.sql = { kind: 'code', answer: 'saved answer' };
  await env.hooks.exportExperimentAnswers();
  assert.equal(env.hooks.readAnswer(env.hooks.state.answers.sql).code, 'saved answer');
  const logs = env.hooks.state.logs.map(row => row.message).join('\n');
  assert.match(logs, /接口拒绝（401）：请登录后再操作/);
  assert.match(logs, /1 关读取失败，结果不完整/);
  assert.doesNotMatch(logs, /导出.*成功/);
});

test('网络观察只解析当前关卡数据和选择题结果，不读取或存储其他写请求', async () => {
  const env = load();
  env.hooks.installNetworkHooks();
  const init = { method: 'POST' };
  Object.defineProperty(init, 'body', { get() { throw new Error('不应读取请求体'); } });
  await env.host.fetch('/api/users/profile.json', init);
  await env.host.fetch('/api/tasks/neighbor.json');
  await env.host.fetch('/api/tasks/current.json?__easBatch=1');
  await flush();
  assert.equal(env.clones(), 0);
  assert.equal(env.hooks.state.taskContext, null);
  await env.host.fetch(new URL('https://data.educoder.net/api/tasks/current.json'));
  await flush();
  assert.equal(env.clones(), 1);
  assert.equal(env.hooks.currentTask().id, 'current');
  assert.equal(env.store.has('educoder-submit-templates'), false);
  assert.equal(env.requests.length, 0);
});

test('网络观察重复安装不叠加 fetch 或 XHR 钩子', () => {
  const env = load();
  env.hooks.installNetworkHooks();
  const fetch = env.host.fetch;
  const send = env.FakeXHR.prototype.send;
  env.hooks.installNetworkHooks();
  assert.equal(env.host.fetch, fetch);
  assert.equal(env.FakeXHR.prototype.send, send);
});

test('关卡请求晚到时，不能覆盖已导航到下一关的上下文', async () => {
  let complete;
  const env = load({ fetchImpl: () => new Promise((resolve) => { complete = resolve; }) });
  env.hooks.installNetworkHooks();
  const pending = env.host.fetch('/api/tasks/current.json');
  env.location.pathname = '/tasks/next';
  complete({ ok: true, clone() { throw new Error('过期响应不应再解析'); } });
  await pending;
  await flush();
  assert.equal(env.hooks.state.taskContext, null);
});

test('XHR 可复用且不累积旧响应监听器，仍可观察选择题标准答案', () => {
  const env = load();
  env.hooks.installNetworkHooks();
  const xhr = new env.FakeXHR();
  xhr.open('GET', '/api/tasks/current.json');
  xhr.send();
  xhr.complete({ challenge: { position: 9, homework_challenge_index: 2, subject: 'SQL' } });
  assert.equal(env.hooks.currentTask().levelId, 'L002', '作业内序号与导出、导航一致');
  xhr.open('POST', '/api/tasks/current/choose_build.json');
  xhr.send('sensitive-body');
  xhr.complete({ test_sets: [{ position: 1, standard_answer: 'AC' }] });
  assert.equal(env.hooks.standardAnswerText(env.hooks.currentTask().standardAnswer), '1:AC');
  assert.equal(xhr.listeners.length, 0);
  assert.equal(env.hooks.state.logs.filter((row) => row.message.includes('提交后读到标准答案')).length, 1);
  assert.equal(env.store.has('educoder-submit-templates'), false);
});

test('单实验 v2 Agent 答案按 task_identifier 导入，与班级汇总形状共用解析', () => {
  const env = load();
  const flat = env.hooks.flattenAnswerImport({
    schema_version: 2, classroom: { name: '数据库系统原理', code: 'DB2026' },
    experiment: { name: 'MySQL-数据的插入、修改与删除(Insert,Update,Delete)', homework_id: 123 },
    answers: [{
      level_id: 'L001', title: '插入数据', kind: 'code', task_identifier: 'current',
      answer: { language: 'sql', code: 'INSERT INTO student VALUES (1);\n' }, source: 'manual'
    }]
  });
  const key = flat.levelIndex.current;
  assert.ok(key);
  assert.equal(flat.answers[key].classroomCode, 'DB2026');
  assert.equal(flat.answers[key].homeworkId, 123);
  assert.equal(flat.answers[key].strictIdentity, true);
  assert.equal(env.hooks.readAnswer(flat.answers[key]).code, 'INSERT INTO student VALUES (1);\n');
  assert.equal(flat.stats.answered, 1, '最新文件无需历史 answered 标志');
  env.hooks.state.answers = flat.answers;
  env.hooks.state.levelIndex = flat.levelIndex;
  env.hooks.state.taskContext = { id: 'current', classroomCode: 'DB2026', homeworkId: 123, sizes: [] };
  assert.equal(env.hooks.resolveAnswerForCurrentLevel().blocked, '');
  env.hooks.state.taskContext.homeworkId = 999;
  assert.match(env.hooks.resolveAnswerForCurrentLevel().blocked, /作业号/);
  env.hooks.state.taskContext.homeworkId = 123;
  env.hooks.state.taskContext.classroomCode = 'OTHER';
  assert.match(env.hooks.resolveAnswerForCurrentLevel().blocked, /不一致/);
  assert.equal(env.hooks.buildClassAnswersDoc().classrooms[0].experiments[0].homework_id, 123);
  assert.throws(() => env.hooks.flattenAnswerImport({
    schema_version: 2, classroom: { name: '课程', code: 'C' },
    experiment: { name: '实验', homework_id: 1 }, answers: [{ level_id: 'L001' }]
  }), /task_identifier/);
  const classFile = env.hooks.flattenAnswerImport({
    version: 2, kind: 'class-answers', classrooms: [{ name: '课程', code: 'C', experiments: [{
      name: '选择题', levels: [{ level_id: 'L001', kind: 'choice', identifiers: ['choice'],
        answer: [{ number: 1, selected: ['I'] }] }]
    }] }]
  });
  assert.equal(classFile.stats.answered, 1);
  assert.equal(env.hooks.readAnswer(classFile.answers[classFile.levelIndex.choice]).map['1'][0], 'I');
  assert.throws(() => env.hooks.flattenAnswerImport({ schema_version: 3 }), /不支持答案版本/);
});

test('停止后的旧队列副本不能恢复 running 或跳转，替换后的新队列也不会被旧副本覆盖', async () => {
  const env = load();
  const queue = { running: true, startedAt: 'run-1', mode: 'missing', index: 0, items: [{ url: 'first' }, { url: 'next' }] };
  env.store.set(QUEUE_KEY, clone(queue));
  env.hooks.requestStop();
  assert.equal(env.hooks.writeTeachQueue(queue), false);
  await env.hooks.advanceTeachQueue(queue);
  assert.equal(env.hooks.readTeachQueue().running, false);
  assert.equal(env.location.href, 'https://www.educoder.net/tasks/current');
  env.hooks.state.stopRequested = false;
  env.store.set(QUEUE_KEY, { running: true, startedAt: 'run-2' });
  assert.equal(env.hooks.writeTeachQueue(queue), false);
  assert.equal(env.hooks.readTeachQueue().startedAt, 'run-2');
});

test('提交静置期间请求停止或切换关卡，都不会点击评测按钮', async () => {
  for (const change of [({ hooks }) => { hooks.state.stopRequested = true; }, ({ location }) => { location.pathname = '/tasks/next'; }]) {
    let clicks = 0;
    const env = load({ onSettle: change, buttons: [{ textContent: '评测', value: '', disabled: false,
      getAttribute: () => null, getClientRects: () => [{}], click() { clicks += 1; } }] });
    const outcome = await env.hooks.answerCurrentLevel({
      answer: { kind: 'code', code: 'SELECT 1;' }, shouldContinue: () => !env.hooks.state.stopRequested
    });
    assert.equal(outcome.status, 'stopped');
    assert.equal(clicks, 0);
  }
});

test('有旧蓝图但无页面评测按钮时明确 blocked，绝不重放网络写请求', async () => {
  const env = load();
  env.hooks.state.templates = [{ url: '/api/tasks/current/judge.json', method: 'POST', body: '{}' }];
  const outcome = await env.hooks.answerCurrentLevel({ answer: { kind: 'code', code: 'SELECT 1;' }, allowReplay: true });
  assert.equal(outcome.status, 'blocked');
  assert.match(outcome.text, /找不到提交按钮/);
  assert.equal(env.fetches.length, 0);
});

test('代码队列等到本次评测结果才推进，实际失败则停在当前关', async () => {
  for (const status of [2, 0]) {
    let env;
    const submit = { textContent: '评测', value: '', disabled: false,
      getAttribute: () => null, getClientRects: () => [{}],
      click() { env.host.fetch('/api/tasks/current/game_build.json', { method: 'POST' }); } };
    env = load({ buttons: [submit], resultText: '已保存', fastTimers: true,
      gmImpl: (request) => request.onload({ status: 200, responseText: JSON.stringify({ ok: true, items: [] }) }) });
    env.hooks.installNetworkHooks();
    env.setResponse({ status: 1 });
    env.hooks.state.taskContext = { id: 'current', sizes: [], levelPosition: 1, levelId: 'L001',
      nextGame: 'next', passed: false, classroomCode: 'DEMO', homeworkId: 123, levelTitle: 'SQL', experimentName: 'SQL 实验' };
    env.hooks.state.levelIndex.current = 'sql-answer';
    env.hooks.state.answers['sql-answer'] = { kind: 'code', answer: 'SELECT 1;' };
    const queue = { running: true, startedAt: 'fresh-result-queue', mode: 'course', experimentIndex: 0,
      needChainStart: false, experiments: [{ name: 'SQL 实验', positions: [1, 2], levelNames: { 1: 'SQL' } }] };
    env.store.set(QUEUE_KEY, clone(queue));
    const processing = env.hooks.processTeachLevel(queue);
    for (let count = 0; count < 50 && !env.fetches.length; count++) await new Promise((resolve) => setTimeout(resolve, 2));
    assert.equal(env.fetches.length, 1, '页面真实评测按钮已点击');
    assert.equal(env.location.href, 'https://www.educoder.net/tasks/current', '自动保存不能触发下一关');
    env.setResponse({ status, test_sets: [{ result: status === 2, actual_output: status === 2 ? '' : '本次评测未通过' }] });
    await env.host.fetch('/api/tasks/current/game_status.json');
    await processing;
    if (status === 2) assert.match(env.location.href, /\/tasks\/next/);
    else {
      assert.equal(env.location.href, 'https://www.educoder.net/tasks/current');
      assert.equal(env.hooks.readTeachQueue().running, false);
      assert.match(env.hooks.readTeachQueue().stoppedReason, /本次评测未通过/);
    }
  }
});

test('准备队列时重复启动只发一个请求，停止后晚到的清单不会启动导航', async () => {
  const env = load();
  const first = env.hooks.startMissingRun();
  await env.hooks.startMissingRun();
  assert.equal(env.requests.length, 1);
  env.hooks.requestStop();
  env.requests[0].onload({ status: 200, responseText: JSON.stringify({ ok: true, items: [{ url: 'next' }] }) });
  await first;
  assert.equal(env.hooks.readTeachQueue(), null);
  assert.equal(env.location.href, 'https://www.educoder.net/tasks/current');
  assert.equal(env.hooks.state.busy, false);
});

test('运行中的课程队列不能被再次点击启动替换', async () => {
  const env = load();
  env.store.set(QUEUE_KEY, { running: true, startedAt: 'existing' });
  await env.hooks.startTeachRun();
  assert.equal(env.requests.length, 0);
  assert.equal(env.hooks.readTeachQueue().startedAt, 'existing');
});

test('刷新后「继续答题」直达中断关卡，保留完整 URL 且不回退链首', async () => {
  // 页面刷新后 GM 只恢复勾选状态，课程/实验列表（内存）是空的——
  // 以前这里会被「先点读取课程实验」拦住，逼用户把选择流程重走一遍。
  const env = load();
  env.store.set(QUEUE_KEY, clone({
    mode: 'course', running: false, stoppedReason: '用户点了停止', startedAt: 'run-9',
    experimentIndex: 1, visited: [1], needChainStart: true, startHops: 3, hopTrail: ['older'],
    expected: { identifier: 'level-2', position: 2,
      url: 'https://www.educoder.net/tasks/DEMO/123/level-2?homework_common_id=123' },
    experiments: [
      { identifier: 'exp-1', name: '实验一', positions: [1, 2], allPositions: [1, 2], levelNames: {}, levelIdentifiers: {} },
      { identifier: 'exp-2', name: '实验二', positions: [1, 2, 3], allPositions: [1, 2, 3], levelNames: {}, levelIdentifiers: {} }
    ]
  }));
  await env.hooks.startTeachRun();
  const queue = env.hooks.readTeachQueue();
  assert.equal(queue.running, true, '没选课也能直接续跑');
  assert.equal(queue.stoppedReason, '');
  assert.equal(queue.experimentIndex, 1, '续跑保留上次的实验序号');
  assert.notEqual(queue.startedAt, 'run-9', '续跑换运行标识，停止前的异步副本不能重新推进');
  assert.deepEqual(clone(queue.visited), [1]);
  assert.equal(queue.needChainStart, false);
  assert.equal(queue.startHops, 0);
  assert.deepEqual(clone(queue.hopTrail), []);
  assert.equal(env.location.href, 'https://www.educoder.net/tasks/DEMO/123/level-2?homework_common_id=123', '直接进上次停下的关卡');
  assert.equal(env.requests.length, 0, '不需要现读关卡列表');
});

test('作答受阻会保存本关位置，离开页面后继续仍直达这一关', async () => {
  const env = load({ fastTimers: true });
  env.location.search = '?homework_common_id=123';
  env.location.href += env.location.search;
  env.hooks.state.taskContext = { id: 'current', sizes: [], levelPosition: 3, nextGame: 'level-4', prevGame: 'level-2' };
  env.hooks.state.levelIndex.current = 'sql';
  env.hooks.state.answers.sql = { kind: 'code', answer: 'SELECT 1;' };
  env.store.set(QUEUE_KEY, clone({
    mode: 'course', running: true, startedAt: 'before-stop', experimentIndex: 0, visited: [1, 2], needChainStart: false,
    experiments: [{ identifier: 'exp', name: 'SQL', positions: [1, 2, 3, 4], levelNames: {} }]
  }));
  await env.hooks.processTeachLevel(env.hooks.readTeachQueue());
  const stopped = env.hooks.readTeachQueue();
  assert.equal(stopped.running, false);
  assert.equal(stopped.expected.identifier, 'current');
  assert.equal(stopped.expected.position, 3);
  assert.equal(stopped.expected.url, 'https://www.educoder.net/tasks/current?homework_common_id=123');
  env.location.pathname = '/classrooms/DEMO';
  env.location.href = 'https://www.educoder.net/classrooms/DEMO';
  env.location.search = '';
  await env.hooks.startTeachRun();
  assert.equal(env.location.href, stopped.expected.url);
  assert.equal(env.hooks.readTeachQueue().needChainStart, false);
  assert.equal(env.hooks.queueCanContinue({ ...stopped, running: true }), false, '旧任务不能覆盖续跑');
});

test('旧存档没有当前关卡时，按已访问序号直达首个未完成关卡', async () => {
  const env = load();
  env.location.pathname = '/paths/course';
  env.location.href = 'https://www.educoder.net/paths/course';
  env.store.set(QUEUE_KEY, clone({
    mode: 'course', running: false, stoppedReason: '用户点了停止', startedAt: 'legacy',
    experimentIndex: 0, visited: [1, 2], expected: { identifier: '', position: 0 },
    experiments: [{ identifier: 'exp', name: '实验', positions: [1, 2, 3, 4], allPositions: [1, 2, 3, 4],
      levelIdentifiers: { 1: 'one', 2: 'two', 3: 'three', 4: 'four' } }]
  }));
  await env.hooks.startTeachRun();
  assert.equal(env.location.href, 'https://www.educoder.net/tasks/three');
  assert.equal(env.hooks.readTeachQueue().expected.position, 3);
  assert.equal(env.hooks.readTeachQueue().needChainStart, false);
});

test('点击下一关时停止，续跑保留下一关目标和作业参数', async () => {
  let env;
  const next = { textContent: '下一关', value: '', disabled: false,
    getAttribute: () => null, getClientRects: () => [{}],
    click() {
      env.location.pathname = '/tasks/next-id';
      env.location.href = 'https://www.educoder.net/tasks/next-id?homework_common_id=123';
      env.hooks.requestStop();
    } };
  env = load({ buttons: [next], fastTimers: true });
  env.location.search = '?homework_common_id=123';
  env.hooks.state.taskContext = { id: 'current', levelPosition: 2, nextGame: 'next-id' };
  env.store.set(QUEUE_KEY, clone({
    mode: 'course', running: true, startedAt: 'before-jump', experimentIndex: 0, visited: [1], needChainStart: false,
    expected: { identifier: 'current', position: 2, url: env.location.href },
    experiments: [{ identifier: 'exp', name: '实验', positions: [1, 2, 3], allPositions: [1, 2, 3] }]
  }));
  await env.hooks.advanceTeachQueue(env.hooks.readTeachQueue());
  const stopped = env.hooks.readTeachQueue();
  assert.equal(stopped.running, false);
  assert.equal(stopped.expected.identifier, 'next-id');
  env.location.pathname = '/paths/course';
  env.location.href = 'https://www.educoder.net/paths/course';
  env.location.search = '';
  await env.hooks.startTeachRun();
  assert.equal(env.location.href, 'https://www.educoder.net/tasks/next-id?homework_common_id=123');
});

test('重新读过面板列表后继续，也使用存档关卡而非重新进入实验', async () => {
  const levels = [1, 2, 3].map((position) => ({ identifier: `level-${position}`, position, name: `第${position}关` }));
  const env = load({ fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify(levels) }) });
  Object.assign(env.host, { atob, btoa });
  const key = btoa(btoa('test-only-signing-key'));
  env.store.set('educoder-sign-ak', key);
  env.store.set('educoder-sign-sk', key);
  Object.assign(env.hooks.teachSelection(), {
    courseValue: 'path:course', courses: [{ identifier: 'course', name: '课程' }],
    experiments: [{ identifier: 'exp', name: '实验' }], selectedExperiments: { exp: true }, selectedLevels: {}
  });
  env.store.set(QUEUE_KEY, clone({
    mode: 'course', running: false, stoppedReason: '评测失败', startedAt: 'saved', experimentIndex: 0, visited: [1, 2],
    expected: { identifier: 'level-3', position: 3, url: 'https://www.educoder.net/tasks/level-3?homework_common_id=123' },
    experiments: [{ identifier: 'exp', name: '实验', positions: [1, 2, 3], allPositions: [1, 2, 3] }]
  }));
  await env.hooks.startTeachRun();
  assert.equal(env.location.href, 'https://www.educoder.net/tasks/level-3?homework_common_id=123');
  assert.deepEqual(clone(env.hooks.readTeachQueue().visited), [1, 2]);
  assert.equal(env.hooks.readTeachQueue().needChainStart, false);
});

test('找不到「下一关」按钮时按 next_game 直达，不再静默跳实验', async () => {
  // 旧实现找不到按钮就 experimentIndex += 1——未通过的路过关上没有「下一关」按钮，
  // 本实验剩余的选中关会被无声丢弃，一行日志都没有。
  const env = load({ buttons: [] });
  const queue = {
    mode: 'course', running: true, startedAt: 'run-1',
    experimentIndex: 0, visited: [],
    experiments: [{ identifier: 'exp-1', name: '实验一', positions: [1, 2], allPositions: [1, 2], levelNames: {}, levelIdentifiers: {} }]
  };
  env.store.set(QUEUE_KEY, clone(queue));
  env.hooks.state.taskContext = { id: 'current', levelPosition: 1, nextGame: 'next-id' };
  await env.hooks.advanceTeachQueue(queue);
  assert.equal(env.location.href, 'https://www.educoder.net/tasks/next-id', '直达 next_game 指向的关卡');
  const saved = env.hooks.readTeachQueue();
  assert.equal(saved.experimentIndex, 0, '不能跳到下一个实验');
  assert.equal(saved.running, true, '队列继续跑（不是停）');
  assert.equal(saved.expected.identifier, 'next-id', '要写 expected，落点校验才有据可依');
});

test('链尾没有下一关但清单里还有没走的关，按关卡标识直达', async () => {
  const env = load({ buttons: [] });
  const queue = {
    mode: 'course', running: true, startedAt: 'run-1',
    experimentIndex: 0, visited: [2],
    experiments: [{
      identifier: 'exp-1', name: '实验一', positions: [1, 2], allPositions: [1, 2],
      levelNames: {}, levelIdentifiers: { 1: 'level-1-id', 2: 'level-2-id' }
    }]
  };
  env.store.set(QUEUE_KEY, clone(queue));
  env.hooks.state.taskContext = { id: 'current', levelPosition: 2, nextGame: '' };
  await env.hooks.advanceTeachQueue(queue);
  assert.equal(env.location.href, 'https://www.educoder.net/tasks/level-1-id', '直达第一个没走的关卡');
  assert.equal(env.hooks.readTeachQueue().experimentIndex, 0, '不能静默跳到下一个实验');
});

test('标题索引跨文件合并：同名键指向不同关卡时删除（宁可不匹配也不串答案）', () => {
  const env = load();
  const merged = env.hooks.mergeTitleIndexes(
    { '实验A__题1': '班1__实验A__L001', '题1': '班1__实验A__L001' },
    { '实验A__题1': '班1__实验B__L001', '题1': '班1__实验B__L001', '题2': '班1__实验C__L002' }
  );
  // hooks 函数在 vm 沙箱里运行，返回对象的原型来自另一个 realm，
  // node:assert 的 deepEqual 会因原型不同而误报——先 JSON 往返再比。
  assert.deepEqual(JSON.parse(JSON.stringify(merged)), { '题2': '班1__实验C__L002' }, '冲突键要删掉（两个表都删），新键照常并入');
  assert.deepEqual(
    JSON.parse(JSON.stringify(env.hooks.mergeTitleIndexes({ k: 'v' }, { k: 'v' }))),
    { k: 'v' },
    '重复导入同一份文件不受影响'
  );
});

test('standardAnswerOf 标记答案来源：actual_output 是用户作答，不是平台标准答案', () => {
  const env = load();
  const rows = env.hooks.standardAnswerOf({
    choose_test_cases: { test_sets: [
      { position: 2, standard_answer: 'B', actual_output: 'A' },
      { position: 1, standard_answer: null, actual_output: 'C' }
    ] }
  });
  assert.deepEqual(rows.map((row) => row.position), [1, 2], '按题号排序');
  assert.equal(rows[0].fromActual, true, '没有标准答案的行要标 fromActual');
  assert.equal(rows[1].fromActual, false, '有标准答案的行不算 fromActual');
  assert.equal(rows[0].answer, 'C', '无标准答案时才退回用户作答');
  assert.equal(rows[1].answer, 'B', '标准答案优先');
});

function virtualFixture() {
  const env = load({ fastTimers: true });
  env.hooks.observeTaskJson('/api/tasks/current.json', {
    vnc_url: '/vnc', course_identifier: 'DEMO001', homework_common_id: 123,
    challenge: { position: 1, score: 100, subject: '虚拟桌面' }, game: { status: 0 }, next_game: 'next'
  });
  return env;
}

test('单关作答在虚拟机页直接跳过，不写编辑器或点击评测', async () => {
  const env = virtualFixture();
  assert.equal(env.hooks.currentTask().virtual, true);
  const outcome = await env.hooks.answerCurrentLevel({ answer: { kind: 'code', code: 'must not write' } });
  assert.equal(outcome.status, 'skipped');
  assert.match(outcome.text, /虚拟机题.*不处理/);
  assert.equal(env.code(), 'template');
  assert.equal(env.requests.length, 0);
  assert.equal(env.fetches.length, 0);
});

test('篡改猴不保留虚拟机任务接口、按钮或后台任务状态', () => {
  const env = virtualFixture();
  assert.doesNotMatch(SOURCE, /\/api\/virtual\/|eas-virtual-submit|activeVirtualJob|submitVirtualLevel|cancelVirtualJob/);
  assert.equal('activeVirtualJob' in env.hooks.state, false);
});

test('从纯虚拟机页回捞仍读取关卡链，但不读文件或保存虚拟机答案', async () => {
  const payload = { vnc_url: '/vnc', challenge: { position: 1, score: 100, with_code_file: true, path: 'instructions.txt' },
    game: { final_score: 100 } };
  const env = load({ fetchImpl: async input => {
    assert.match(String(input), /\/api\/tasks\/current\.json/);
    return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
  } });
  configureTestSigning(env);
  env.hooks.observeTaskJson('/api/tasks/current.json', payload);
  await env.hooks.exportExperimentAnswers();
  assert.equal(env.fetches.length, 1, '读取当前关元数据，查找同实验的其他关卡');
  assert.equal(env.requests.length, 0);
  assert.equal(Object.keys(env.hooks.state.answers).length, 0);
  assert.match(env.hooks.state.logs.map(row => row.message).join('\n'), /虚拟机题.*跳过/);
});

test('选择题特征优先于 VNC 或 Notebook 环境标记', () => {
  for (const environment of [{ vnc_url: '/vnc' }, { mirror_name: ['VNC图形化'] }, { is_jupyter: true }]) {
    for (const choice of [
      { chooses: [{ position: 1, challenge_question: [1, 2, 3, 4] }] },
      { choose_test_cases: { challenge_chooses_count: 2 } },
      { choose_test_cases: { test_sets: [{ position: 1, standard_answer: 'A' }] } }
    ]) {
      const env = load();
      env.hooks.observeTaskJson('/api/tasks/current.json', { ...environment, ...choice, challenge: { position: 1 } });
      assert.equal(env.hooks.currentTask().virtual, false, '不能因共用实验环境而跳过选择题');
    }
  }
});

test('选择题提交响应能纠正先前的虚拟机误判，并保留已捕获的答案供回捞', () => {
  const env = virtualFixture();
  env.hooks.observeSubmitResult('/api/tasks/current/choose_build.json', {
    test_sets: [{ position: 1, standard_answer: 'AC' }]
  });
  assert.equal(env.hooks.currentTask().virtual, false);
  const answer = env.hooks.currentLevelAnswer();
  assert.equal(answer.kind, 'choice');
  assert.equal(answer.answer, '1:AC');
});

test('混合实验从选择题或纯虚拟机页发起回捞，都能保存同环境下的其他选择题', async () => {
  for (const startVirtual of [false, true]) {
    const ids = startVirtual ? ['first', 'current', 'last'] : ['current', 'vm', 'last'];
    const virtualId = ids[1];
    const choices = [ids[0], ids[2]];
    const calls = [];
    const task = id => ({ vnc_url: '/vnc', mirror_name: ['VNC图形化'], homework_common_id: 123,
      challenge: { position: ids.indexOf(id) + 1, subject: id, score: 100, with_code_file: true, path: 'instructions.txt' },
      game: { final_score: id === virtualId ? 100 : 0 },
      next_game: ids[ids.indexOf(id) + 1] || '', prev_game: ids[ids.indexOf(id) - 1] || '',
      ...(id === virtualId ? {} : {
        chooses: [{ position: 1, challenge_question: [1, 2, 3, 4] }, { position: 2, challenge_question: [1, 2, 3, 4] }],
        choose_test_cases: { challenge_chooses_count: 2, had_submmit: true,
          test_sets: [{ position: 1, standard_answer: 'A' }, { position: 2, standard_answer: 'BC' }] }
      }) });
    const env = load({ fetchImpl: async input => {
      const url = new URL(String(input));
      calls.push(url);
      const id = /\/tasks\/([^/.]+)\.json/.exec(url.pathname)?.[1];
      assert.ok(id, '只读取关卡元数据，不读虚拟机文件');
      return { ok: true, status: 200, text: async () => JSON.stringify(task(id)) };
    } });
    configureTestSigning(env);
    env.hooks.observeTaskJson('/api/tasks/current.json', task('current'));
    for (const id of ids) {
      env.hooks.state.levelIndex[id] = id;
      env.hooks.state.answers[id] = id === virtualId ? { kind: 'code', answer: 'keep original' }
        : { kind: 'choice', answer: [] };
    }
    await env.hooks.exportExperimentAnswers();
    assert.equal(calls.length, 3, '每一关只读取一次，包括纯虚拟机两侧的选择题');
    for (const id of choices) {
      assert.deepEqual(clone(env.hooks.readAnswer(env.hooks.state.answers[id]).map), { 1: ['A'], 2: ['B', 'C'] });
      assert.equal(env.hooks.state.answers[id].verified, true);
    }
    assert.equal(env.hooks.readAnswer(env.hooks.state.answers[virtualId]).code, 'keep original');
    assert.equal(env.requests.some(request => request.data && JSON.parse(request.data).identifier === virtualId), false);
  }
});

test('Notebook 和桌面环境均跳过，普通代码镜像仍识别为代码题', async () => {
  for (const environment of [
    { is_jupyter: true }, { is_jupyter_lab: true }, { mirror_name: ['Jupyter'] },
    { shixun_environments: [{ environment_name: 'Notebook' }] },
    { shixun_environments: [{ name: '远程桌面' }] }
  ]) {
    const env = load();
    env.hooks.observeTaskJson('/api/tasks/current.json', {
      ...environment, challenge: { position: 1, with_code_file: true }, game: {}
    });
    assert.equal(env.hooks.currentTask().virtual, true);
    assert.equal((await env.hooks.answerCurrentLevel({ answer: { kind: 'code', code: 'do not write' } })).status, 'skipped');
    assert.equal(env.code(), 'template');
    assert.equal(env.requests.length, 0);
    assert.equal(env.fetches.length, 0);
  }
  const code = load();
  code.hooks.observeTaskJson('/api/tasks/current.json', { mirror_name: ['MySQL'], challenge: { position: 1, with_code_file: true } });
  assert.equal(code.hooks.currentTask().virtual, false);
});

test('回捞混合实验时跳过中间虚拟机关卡，保留它的原有条目并继续后续代码题', async () => {
  const calls = [];
  const ids = ['current', 'vm', 'last'];
  const env = load({ fetchImpl: async input => {
    const url = new URL(String(input));
    calls.push(url);
    const id = /\/tasks\/([^/.]+)/.exec(url.pathname)[1];
    const index = ids.indexOf(id);
    const payload = url.pathname.endsWith('/rep_content.json')
      ? { content: { content: Buffer.from(`SELECT ${index + 1};`).toString('base64') } }
      : { vnc_url: id === 'vm' ? '/vnc' : '',
        challenge: { position: index + 1, score: 100, with_code_file: true, path: 'main.sql', subject: id },
        game: { final_score: 100 }, next_game: ids[index + 1] || '', prev_game: ids[index - 1] || '' };
    return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
  } });
  configureTestSigning(env);
  env.hooks.state.taskContext = { id: 'current', homeworkId: 123, experimentName: 'mixed' };
  for (const id of ids) {
    env.hooks.state.levelIndex[id] = id;
    env.hooks.state.answers[id] = { kind: 'code', answer: 'keep original' };
  }
  await env.hooks.exportExperimentAnswers();
  assert.equal(calls.length, 5, '三关元数据，只读取两关代码');
  assert.equal(calls.some(url => url.pathname === '/api/tasks/vm/rep_content.json'), false);
  assert.equal(env.hooks.readAnswer(env.hooks.state.answers.current).code, 'SELECT 1;');
  assert.equal(env.hooks.readAnswer(env.hooks.state.answers.last).code, 'SELECT 3;');
  assert.equal(env.hooks.readAnswer(env.hooks.state.answers.vm).code, 'keep original');
  assert.equal(env.requests.some(request => request.data && JSON.parse(request.data).identifier === 'vm'), false);
});

test('课程队列遇到虚拟机题直接跳过，继续下一关且不上报缺答案', async () => {
  for (const passed of [true, false]) {
    const env = virtualFixture();
    env.hooks.currentTask().passed = passed;
    const queue = { running: true, startedAt: 'vm-queue', mode: 'course', experimentIndex: 0,
      experiments: [{ name: '桌面实验', positions: [1, 2], levelNames: { 1: '图形题' } }] };
    env.store.set(QUEUE_KEY, clone(queue));
    // 即使编辑器和另一班的代码答案同时存在，也不能处理虚拟机题。
    env.hooks.state.levelIndex.current = 'bad';
    env.hooks.state.answers.bad = { classroomCode: 'OTHER', kind: 'code', answer: 'wrong code' };
    await env.hooks.processTeachLevel(queue);
    const saved = env.hooks.readTeachQueue();
    assert.equal(saved.running, true);
    assert.match(env.location.href, /\/tasks\/next/);
    assert.deepEqual(clone(saved.visited), [1]);
    assert.equal(env.code(), 'template');
    assert.equal(env.fetches.length, 0);
    assert.equal(env.requests.length, 0, '不创建后台任务、不更新缺答案清单');
    assert.match(env.hooks.state.logs.map(row => row.message).join('\n'), /虚拟机题.*跳过/);
  }
});
