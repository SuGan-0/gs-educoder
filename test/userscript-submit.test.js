'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'userscript', 'educoder-autosubmit.user.js'), 'utf8');
const BUILD = '/api/tasks/current/game_build.json';
const RESULT = '/api/tasks/current/game_status.json';
const CHOICE = '/api/tasks/current/choose_build.json';
const flush = () => new Promise((resolve) => setImmediate(resolve));

function load({ text = '', modal = '', buttons = [], bodyText = '', realTimers = false, clock = null, storageEntries = [] } = {}) {
  const hooks = {};
  const pending = [];
  const storage = new Map(storageEntries);
  let code = '';
  const model = { getValue: () => code, setValue: (value) => { code = value; } };
  function FakeXHR() { this.listeners = []; }
  FakeXHR.prototype.open = function () {};
  FakeXHR.prototype.send = function () {};
  FakeXHR.prototype.addEventListener = function (event, callback) { this.listeners.push(callback); };
  FakeXHR.prototype.complete = function (payload, status = 200) {
    this.status = status;
    this.responseText = JSON.stringify(payload);
    for (const callback of this.listeners.splice(0)) callback();
  };
  const node = (value) => ({ textContent: value, getClientRects: () => [{}] });
  const document = {
    body: { innerText: bodyText, append() {} }, head: { append() {} },
    querySelectorAll(selector) {
      if (selector.includes('button')) return buttons;
      if (/modal|congrat|celebrat|dialog/.test(selector)) return modal ? [node(modal)] : [];
      if (/result|judge|evaluate|message|alert|notification/.test(selector)) return text ? [node(text)] : [];
      return [];
    },
    querySelector: () => null, getElementById: () => null,
    createElement: () => ({ style: {}, append() {}, setAttribute() {} })
  };
  const location = { pathname: '/tasks/current', href: 'https://www.educoder.net/tasks/current' };
  const host = { document, location, __educoderAutosubmitTestHooks: hooks, XMLHttpRequest: FakeXHR,
    localStorage: { get length() { return storage.size; }, key: (index) => [...storage.keys()][index],
      getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)) },
    Monaco: { editor: { getModels: () => [model] } },
    fetch(url, init) { return new Promise((resolve, reject) => pending.push({ url, init, resolve, reject })); }
  };
  const sandbox = {
    window: host, unsafeWindow: host, document, location, URL, URLSearchParams,
    console: { log() {}, error() {} },
    setTimeout: realTimers ? setTimeout : (callback, ms) => {
      const due = clock && clock.now + ms;
      return setTimeout(() => {
        if (clock) { clock.now = Math.max(clock.now, due); if (clock.onSleep) clock.onSleep(ms); }
        callback();
      }, clock || ms === 2000 ? 1 : Math.min(ms, 5));
    }, clearTimeout,
    GM_getValue: (_key, fallback) => fallback, GM_setValue() {}, GM_registerMenuCommand() {}, GM_xmlhttpRequest() {}
  };
  if (clock) sandbox.Date = class extends Date { static now() { return clock.now; } };
  vm.createContext(sandbox);
  new vm.Script(SOURCE).runInContext(sandbox);
  hooks.installNetworkHooks();
  function request(url, method = 'GET') {
    host.fetch(url, { method }).catch(() => {});
    const entry = pending.at(-1);
    return {
      async finish(payload, status = 200) {
        entry.resolve({ ok: status >= 200 && status < 300, status, clone: () => ({ json: async () => payload }) });
        await flush();
      },
      async fail(message = 'Failed to fetch') { entry.reject(new Error(message)); await flush(); }
    };
  }
  return { hooks, host, location, buttons, pending, request, FakeXHR, storage,
    text(value) { text = value; }, modal(value) { modal = value; }, code: () => code };
}

async function beginCode(env) {
  const submission = env.hooks.beginSubmissionAttempt('code');
  await env.request(BUILD, 'POST').finish({ status: 1 });
  return submission;
}

function button(text, click = () => {}, attrs = {}) {
  return { textContent: text, value: '', disabled: false, getAttribute: (name) => attrs[name] ?? null, getClientRects: () => [{}], click };
}

test('数据库的跨关卡冷却未结束时不提交，满 30 秒且页面按钮解禁后才点击', async () => {
  const clock = { now: 1_700_000_000_000 };
  const until = clock.now + 30_000;
  let env, clickedAt = 0, selfTestClicks = 0;
  const evaluate = button('30S', () => {
    clickedAt = clock.now;
    env.request(BUILD, 'POST').finish({ status: 1 }).then(() => env.request(RESULT).finish({ status: 2 }));
  }, { title: '运行评测', class: 'btn-run___main' });
  evaluate.disabled = true;
  clock.onSleep = () => {
    const rest = Math.max(0, Math.ceil((until - clock.now) / 1000));
    evaluate.textContent = rest ? `${rest}S` : '评测';
    evaluate.disabled = rest > 0;
  };
  env = load({ clock, buttons: [button('自测运行', () => { selfTestClicks++; }), evaluate],
    storageEntries: [['task-evaluate-cooldown:student', String(until)]] });
  const result = await env.hooks.answerCurrentLevel({ answer: { kind: 'code', code: 'SELECT 1;' } });
  assert.equal(result.status, 'passed');
  assert.ok(clickedAt >= until, '2 秒静置不能替代 30 秒冷却');
  assert.equal(selfTestClicks, 0, '不能转而点击自测运行');
  assert.equal(env.storage.get('task-evaluate-cooldown:student'), String(until), '只读平台冷却截止时间');
});

test('页面暂时显示可用但平台冷却仍在生效时，也不能提前提交', async () => {
  const clock = { now: 1_700_000_000_000 };
  const until = clock.now + 30_000;
  const evaluate = button('评测');
  const env = load({ clock, buttons: [evaluate], storageEntries: [['task-evaluate-cooldown:student', String(until)]] });
  const ready = await env.hooks.waitForSubmitButton(() => true);
  assert.equal(ready.button, evaluate);
  assert.ok(clock.now >= until);
});

test('冷却只剩 5 秒就等待剩余时间，不给所有关卡固定增加 30 秒', async () => {
  const clock = { now: 1_700_000_000_000 };
  const started = clock.now;
  const env = load({ clock, buttons: [button('评测')], storageEntries: [['task-evaluate-cooldown:student', String(started + 5000)]] });
  const ready = await env.hooks.waitForSubmitButton(() => true);
  assert.ok(ready.button);
  assert.ok(clock.now - started >= 5000 && clock.now - started < 6000);
});

test('没有可读存储时，30S 禁用按钮等待到恢复，而不是报找不到按钮', async () => {
  const clock = { now: 1_700_000_000_000 };
  const until = clock.now + 30_000;
  const evaluate = button('30S', () => {}, { title: '运行评测' });
  evaluate.disabled = true;
  clock.onSleep = () => { if (clock.now >= until) { evaluate.disabled = false; evaluate.textContent = '评测'; } };
  const env = load({ clock, buttons: [evaluate] });
  const ready = await env.hooks.waitForSubmitButton(() => true);
  assert.equal(ready.button, evaluate);
  assert.ok(clock.now >= until);
});

test('读取同账号的跨页面冷却时间，已过期记录不影响提交', () => {
  const clock = { now: 1_700_000_000_000 };
  const env = load({ clock, storageEntries: [
    ['task-evaluate-cooldown:student', String(clock.now + 30_000)],
    ['task-evaluate-cooldown:other', String(clock.now + 50_000)]
  ] });
  env.hooks.state.teachLogin = 'student';
  assert.equal(env.hooks.readSubmitCooldownMs(), 30_000);
  clock.now += 10_000;
  assert.equal(env.hooks.readSubmitCooldownMs(), 20_000);
  clock.now += 25_000;
  assert.equal(env.hooks.readSubmitCooldownMs(), 0);
  env.hooks.state.teachLogin = 'new-account';
  assert.equal(env.hooks.readSubmitCooldownMs(), 0, '不能使用其他账号的冷却时间');
});

test('等待冷却期间停止或换关卡，不会点击评测', async () => {
  for (const mode of ['stop', 'navigate']) {
    const clock = { now: 1_700_000_000_000 };
    const started = clock.now;
    let clicks = 0;
    const evaluate = button('30S', () => { clicks++; }, { title: '运行评测' });
    evaluate.disabled = true;
    const env = load({ clock, buttons: [evaluate] });
    clock.onSleep = () => {
      if (clock.now - started < 3000) return;
      if (mode === 'stop') env.hooks.state.stopRequested = true;
      else env.location.pathname = '/tasks/next';
    };
    const result = await env.hooks.answerCurrentLevel({ answer: { kind: 'code', code: 'SELECT 1;' },
      shouldContinue: () => !env.hooks.state.stopRequested });
    assert.equal(result.status, 'stopped', mode);
    assert.equal(clicks, 0);
  }
});

test('冷却或其他禁用状态超时必须明确说明原因，不能强制点击', async () => {
  const clock = { now: 1_700_000_000_000 };
  const evaluate = button('30S', () => { throw new Error('不应点击'); }, { title: '运行评测' });
  evaluate.disabled = true;
  const env = load({ clock, buttons: [evaluate] });
  const result = await env.hooks.waitForSubmitButton(() => true, 1000);
  assert.equal(result.button, null);
  assert.match(result.text, /冷却|不可用/);
});

test('旧成功、常驻下一关和完成按钮不会使运行中的本次评测提前通过', async () => {
  const env = load({ text: '评测通过，得分 100', modal: '恭喜您通过本关', buttons: [button('下一关'), button('完成')] });
  const submission = await beginCode(env);
  let settled = false;
  const waiting = env.hooks.waitForSubmitResult(1000, submission).then((result) => { settled = true; return result; });
  await env.request(RESULT).finish({ status: -1, test_sets: [{ result: true }] });
  assert.equal(settled, false);
  await env.request(RESULT).finish({ status: 0, test_sets: [{ result: false, actual_output: '本次 SQL 结果不匹配' }] });
  const result = await waiting;
  assert.equal(result.status, 'failed');
  assert.match(result.text, /本次 SQL 结果不匹配/);
});

test('仅出现导航、已保存、已提交或成功弹窗，均不能代替本次评测响应', async () => {
  for (const value of ['已保存', '当前状态已提交', '提交成功', '全部通过，得分 100']) {
    const env = load({ buttons: [button('下一关'), button('完成提交')] });
    const submission = env.hooks.beginSubmissionAttempt('code');
    env.text(value);
    env.modal('恭喜您通过本关');
    const result = await env.hooks.waitForSubmitResult(25, submission);
    assert.equal(result.status, 'timeout', value);
    assert.match(result.text, /本次提交的新评测结果/);
  }
});

test('代码评测只有受本次提交关联的 status=2 才确认通过，旧运行文案不会遮住响应', async () => {
  const env = load({ text: '自测输入运行结果代码执行中...' });
  const submission = await beginCode(env);
  await env.request(RESULT).finish({ status: 2 });
  assert.equal((await env.hooks.waitForSubmitResult(100, submission)).status, 'passed');
});

test('game_build 已接受请求仍不能当评测通过', async () => {
  const env = load();
  const submission = await beginCode(env);
  assert.equal((await env.hooks.waitForSubmitResult(25, submission)).status, 'timeout');
});

test('没有本次 game_build 时，游戏状态轮询与关卡资料里的旧通过均不能认领', async () => {
  const env = load();
  const submission = env.hooks.beginSubmissionAttempt('code');
  await env.request(RESULT).finish({ status: 2 });
  await env.request('/api/tasks/current.json').finish({ challenge: { position: 1, score: 100 }, game: { status: 2, final_score: 100 } });
  assert.equal((await env.hooks.waitForSubmitResult(25, submission)).status, 'timeout');
});

test('点击前在途的结果、其他关卡结果、上一次提交迟到的结果都不能推进本次作答', async () => {
  const env = load();
  const preClick = env.request(RESULT);
  await beginCode(env);
  const previousAttempt = env.request(RESULT);
  const submission = await beginCode(env);
  await preClick.finish({ status: 2 });
  await previousAttempt.finish({ status: 2 });
  await env.request('/api/tasks/neighbor/game_status.json').finish({ status: 2 });
  assert.equal((await env.hooks.waitForSubmitResult(25, submission)).status, 'timeout');
});

test('连续两次相同的实际失败依然分别确认，不依赖结果文字发生变化', async () => {
  const env = load({ text: '编译错误：上次失败' });
  for (let index = 0; index < 2; index++) {
    const submission = await beginCode(env);
    await env.request(RESULT).finish({ status: 0, last_compile_output: '编译错误：上次失败' });
    const result = await env.hooks.waitForSubmitResult(100, submission);
    assert.equal(result.status, 'failed');
    assert.match(result.text, /编译错误/);
  }
});

test('选择题旧已提交不能立即成功，必须等待本次 POST 的新提交结果', async () => {
  const env = load({ text: '当前状态已提交，将按照最新提交的答案计算成绩' });
  const submission = env.hooks.beginSubmissionAttempt('choice');
  const request = env.request(CHOICE, 'POST');
  let settled = false;
  const waiting = env.hooks.waitForSubmitResult(1000, submission).then((result) => { settled = true; return result; });
  await flush();
  assert.equal(settled, false);
  await request.finish({ had_all_submmit: true, test_sets: [{ actual_output: 'A', standard_answer: 'A' }] });
  assert.equal((await waiting).status, 'passed');
});

test('选择题本次明确成绩不满分或含错误时停止，不把已提交当全部正确', async () => {
  for (const payload of [{ challenge_chooses_count: 2, choose_correct_num: 1 }, { test_sets: [{ result: false, actual_output: '答案错误' }] }]) {
    const env = load();
    const submission = env.hooks.beginSubmissionAttempt('choice');
    await env.request(CHOICE, 'POST').finish(payload);
    assert.equal((await env.hooks.waitForSubmitResult(100, submission)).status, 'failed');
  }
});

test('选择题本次满分确认成功，空响应与已保存不算提交成功', async () => {
  const env = load();
  const first = env.hooks.beginSubmissionAttempt('choice');
  await env.request(CHOICE, 'POST').finish({ challenge_chooses_count: 2, choose_correct_num: 2 });
  assert.equal((await env.hooks.waitForSubmitResult(100, first)).status, 'passed');
  const second = env.hooks.beginSubmissionAttempt('choice');
  env.text('已保存');
  await env.request(CHOICE, 'POST').finish({});
  assert.equal((await env.hooks.waitForSubmitResult(25, second)).status, 'timeout');
});

test('选择题点击前已经发出的 POST 响应不能归入本次点击', async () => {
  const env = load();
  const old = env.request(CHOICE, 'POST');
  const submission = env.hooks.beginSubmissionAttempt('choice');
  await old.finish({ had_all_submmit: true });
  assert.equal((await env.hooks.waitForSubmitResult(25, submission)).status, 'timeout');
});

test('XHR 提交和轮询按同样规则关联，运行态不会返回成功', async () => {
  const env = load();
  const submission = env.hooks.beginSubmissionAttempt('code');
  const build = new env.FakeXHR();
  build.open('POST', BUILD); build.send(); build.complete({ status: 1 });
  const result = new env.FakeXHR();
  result.open('GET', RESULT); result.send(); result.complete({ status: -1 });
  result.open('GET', RESULT); result.send(); result.complete({ status: 2 });
  assert.equal((await env.hooks.waitForSubmitResult(100, submission)).status, 'passed');
});

test('提交网络失败、HTTP 失败和平台拒绝都会明确停止', async () => {
  for (const mode of ['network', 'http', 'rejected', 'xhr']) {
    const env = load();
    const submission = env.hooks.beginSubmissionAttempt('code');
    if (mode === 'xhr') {
      const xhr = new env.FakeXHR();
      xhr.open('POST', BUILD); xhr.send(); xhr.complete({}, 0);
    } else {
      const request = env.request(BUILD, 'POST');
      if (mode === 'network') await request.fail();
      else await request.finish(mode === 'rejected' ? { status: 403, message: '没有权限' } : {}, mode === 'http' ? 500 : 200);
    }
    assert.equal((await env.hooks.waitForSubmitResult(100, submission)).status, 'failed', mode);
  }
});

test('等结果期间停止、换关卡或开始另一次提交都不会恢复旧任务成功', async () => {
  for (const mode of ['stop', 'navigate', 'replace']) {
    const env = load();
    const submission = await beginCode(env);
    const response = env.request(RESULT);
    const waiting = env.hooks.waitForSubmitResult(1000, submission);
    if (mode === 'stop') env.hooks.state.stopRequested = true;
    else if (mode === 'navigate') env.location.pathname = '/tasks/next';
    else env.hooks.beginSubmissionAttempt('code');
    await response.finish({ status: 2 });
    assert.equal((await waiting).status, 'stopped', mode);
  }
});

test('页面新出现的提交失败可及时报错，原有失败文案不能提前终止新评测', async () => {
  const env = load({ text: '未通过：旧结果' });
  const submission = await beginCode(env);
  await env.request(RESULT).finish({ status: 2 });
  assert.equal((await env.hooks.waitForSubmitResult(100, submission)).status, 'passed');
  const next = env.hooks.beginSubmissionAttempt('code');
  env.text('提交失败：请重试');
  assert.equal((await env.hooks.waitForSubmitResult(100, next)).status, 'failed');
});

test('作答内核在点击前关联请求，等待本次新结果后才返回成功', async () => {
  const env = load({ text: '已保存', buttons: [button('下一关')] });
  env.buttons.push(button('评测', () => env.request(BUILD, 'POST').finish({ status: 1 })));
  let settled = false;
  const answering = env.hooks.answerCurrentLevel({ answer: { kind: 'code', code: 'SELECT 1;' } })
    .then((result) => { settled = true; return result; });
  for (let count = 0; count < 50 && !env.pending.length; count++) await new Promise((resolve) => setTimeout(resolve, 2));
  assert.equal(env.code(), 'SELECT 1;');
  assert.equal(env.pending.length, 1);
  assert.equal(settled, false, '不能把常驻下一关或自动保存当作本次成功');
  await env.request(RESULT).finish({ status: 2 });
  assert.equal((await answering).status, 'passed');
});

test('等待上限优先读取页面完整时长，未标注则使用设置', () => {
  assert.equal(load({ bodyText: '最大的测评时间是 300 秒' }).hooks.readMaxEvalSeconds(), 300);
  assert.equal(load().hooks.readMaxEvalSeconds(), 0);
});

test('提交前必须保留两秒静置', async () => {
  const env = load({ realTimers: true });
  const started = Date.now();
  await env.hooks.settleBeforeSubmit();
  assert.ok(Date.now() - started >= 2000);
});
