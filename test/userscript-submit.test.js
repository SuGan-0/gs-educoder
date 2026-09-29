'use strict';

/**
 * 提交结果判定的**行为**测试（离线）。
 *
 * 针对的回归：用户提交选择题后，页面文案是「当前状态已提交，将按照最新提交的
 * 答案计算成绩」，但旧的判定词表只认「通过/正确/满分」，于是判成 unknown，
 * 停在本题不往下走。选择题提交后**没有通过/失败**，只有「已提交」。
 *
 * 另外锁住一个顺序问题：「已提交，评测中」是编程题的中间态，必须继续等，
 * 不能因为含「已提交」就当终态——所以「评测中」要先于「已提交」判。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'userscript', 'educoder-autosubmit.user.js'),
  'utf8'
);

/** 在假 DOM 里加载脚本：结果区文本由 getText() 动态提供，可随时间变化。
 *  getModalText() 模拟通关弹窗（「恭喜您通过本关」）；buttons 模拟页面上的按钮。 */
function loadSubmitHooks(getText, getModalText = () => '', buttons = [], bodyText = '') {
  const hooks = {};
  const fakeDocument = {
    body: { innerText: bodyText, append() {} },
    querySelectorAll(selector) {
      const sel = String(selector);
      if (sel.includes('button')) return buttons;
      if (/modal|congrat|celebrat|dialog/.test(sel)) {
        const text = getModalText();
        return text ? [{ textContent: text }] : [];
      }
      if (/result|judge|evaluate|message|alert|notification/.test(sel)) {
        const text = getText();
        return text ? [{ textContent: text }] : [];
      }
      return [];
    },
    querySelector: () => null,
    getElementById: () => null,
    createElement: () => ({ style: {}, append() {}, addEventListener() {}, setAttribute() {} }),
    head: { append() {} }
  };
  const sandbox = {
    window: { __educoderAutosubmitTestHooks: hooks },
    document: fakeDocument,
    location: { pathname: '/tasks/zq3cef619ac5', href: 'https://www.educoder.net/tasks/zq3cef619ac5' },
    navigator: { userAgent: 'test' },
    URL,
    URLSearchParams,
    console,
    setTimeout,
    clearTimeout,
    GM_getValue: (_key, fallback) => fallback,
    GM_setValue: () => {},
    GM_deleteValue: () => {},
    GM_registerMenuCommand: () => {},
    GM_xmlhttpRequest: () => {}
  };
  sandbox.window.document = fakeDocument;
  sandbox.window.location = sandbox.location;
  vm.createContext(sandbox);
  new vm.Script(SOURCE).runInContext(sandbox);
  assert.ok(typeof hooks.waitForSubmitResult === 'function', '测试钩子应被挂上');
  return hooks;
}

test('提交结果判定：选择题「已提交」算成功', async () => {
  const hooks = loadSubmitHooks(() => '当前状态已提交，将按照最新提交的答案计算成绩，详情如下：');
  const result = await hooks.waitForSubmitResult(2000);
  assert.equal(result.status, 'passed', '「已提交」是选择题提交成功的标志');
});

test('提交结果判定：编程题「通过 / 满分」算成功', async () => {
  const hooks = loadSubmitHooks(() => '评测通过，得分 100');
  const result = await hooks.waitForSubmitResult(2000);
  assert.equal(result.status, 'passed');
});

test('提交结果判定：编译错误 / 未通过算失败', async () => {
  assert.equal((await loadSubmitHooks(() => '编译错误：SyntaxError').waitForSubmitResult(2000)).status, 'failed');
  assert.equal((await loadSubmitHooks(() => '未通过：得分 40').waitForSubmitResult(2000)).status, 'failed');
});

test('提交结果判定：「已提交，评测中」必须先等，等到「通过」才返回', async () => {
  let text = '已提交，评测中';
  const hooks = loadSubmitHooks(() => text);
  const promise = hooks.waitForSubmitResult(5000);
  setTimeout(() => {
    text = '通过，得分 100';
  }, 1200);
  const result = await promise;
  assert.equal(result.status, 'passed', '评测中不能因为含「已提交」就提前当终态');
});

test('提交结果判定：始终没结果算 timeout', async () => {
  const hooks = loadSubmitHooks(() => '');
  const result = await hooks.waitForSubmitResult(1200);
  assert.equal(result.status, 'timeout');
});

test('提交结果判定：「代码执行中」必须继续等（曾因词表缺「执行中」而中断队列）', async () => {
  let text = '自测输入运行结果代码执行中...';
  const hooks = loadSubmitHooks(() => text);
  const promise = hooks.waitForSubmitResult(5000);
  setTimeout(() => {
    text = '评测通过，得分 100';
  }, 1200);
  const result = await promise;
  assert.equal(result.status, 'passed', '「执行中」是进行中，不能当终态放弃');
});

test('提交结果判定：通关弹窗优先于测试输出区（否则「恭喜通过」会被读成「执行中」）', async () => {
  // 实测场景：页面已弹「恭喜您通过本关」，但测试输出区还停在「代码执行中…」
  const hooks = loadSubmitHooks(
    () => '自测输入运行结果代码执行中...',
    () => '恭喜您通过本关 下一关'
  );
  const result = await hooks.waitForSubmitResult(5000);
  assert.equal(result.status, 'passed', '弹窗说通过就必须判通过，不能被过期的输出区文案带偏');
  assert.match(result.text, /恭喜/);
});

test('提交结果判定：弹窗里出现的是失败/未通过，也要正确判失败', async () => {
  const hooks = loadSubmitHooks(() => '', () => '未通过 得分 40');
  const result = await hooks.waitForSubmitResult(5000);
  assert.equal(result.status, 'failed');
});

test('提交结果判定：出现「下一关」按钮即判通过（不读文案，最可靠）', async () => {
  const nextBtn = {
    textContent: '下一关',
    value: '',
    disabled: false,
    getAttribute: () => null,
    getClientRects: () => [{}]
  };
  // 结果区还停在过期的「执行中」，但通关弹窗的「下一关」按钮已经出现
  const hooks = loadSubmitHooks(() => '自测输入运行结果代码执行中...', () => '', [nextBtn]);
  const result = await hooks.waitForSubmitResult(5000);
  assert.equal(result.status, 'passed', '有「下一关」按钮就说明本关过了');
  assert.match(result.text, /下一关/);
});

test('提交结果判定：「完成提交」既像提交又像完成，不能当通关信号', async () => {
  const submitBtn = {
    textContent: '完成提交',
    value: '',
    disabled: false,
    getAttribute: () => null,
    getClientRects: () => [{}]
  };
  // 结果区一直没结论 → 应该走到 timeout，而不是因为按钮含「完成」就判通过
  const hooks = loadSubmitHooks(() => '', () => '', [submitBtn]);
  const result = await hooks.waitForSubmitResult(1200);
  assert.equal(result.status, 'timeout', '「完成提交」是提交按钮，不是通关按钮');
});

test('等待上限：从页面读「最大的测评时间」，取一半作为上限', () => {
  const hooks = loadSubmitHooks(() => '', () => '', [], '自测输入运行结果 代码执行中... 最大的测评时间是 300 秒');
  assert.equal(hooks.readMaxEvalSeconds(), 300, '要从页面正文里读出最大测评时间');
});

test('等待上限：页面没标注时返回 0（让调用方退回面板设置）', () => {
  const hooks = loadSubmitHooks(() => '');
  assert.equal(hooks.readMaxEvalSeconds(), 0);
});

test('提交前必须静置（太快提交会失败）', async () => {
  const hooks = loadSubmitHooks(() => '');
  const started = Date.now();
  await hooks.settleBeforeSubmit();
  assert.ok(Date.now() - started >= 2000, '静置时长应 >= 2 秒');
});

test('提交结果判定：跑满上限还在「执行中」要判超时（不是"没结论"）', async () => {
  // 实测文案有「自测输入无运行结果代码执行中…」这种变体，也必须认出来是"进行中"
  const hooks = loadSubmitHooks(() => '自测输入无运行结果代码执行中...');
  const result = await hooks.waitForSubmitResult(1200);
  assert.equal(result.status, 'timeout', '进行中跑满上限 = 超时，要和"读到看不懂的终态"区分开');
});
