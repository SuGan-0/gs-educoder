'use strict';

/** 简易版篡改猴（班级答案文件）的冒烟与行为测试：vm 沙箱 + 假 GM/文档。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'userscript', 'educoder-lite.user.js'), 'utf8');

const CLASS_DOC = {
  version: 2,
  kind: 'class-answers',
  class: { grade: '2024级', name: '软工24-15、16班' },
  classrooms: [
    {
      name: '软件工程导论2026年下半年',
      code: '2i6ng7vp',
      experiments: [
        {
          name: '[8、面向对象分析] 面向对象分析之类图',
          chapter: '8、面向对象分析',
          homework_id: 4200882,
          levels: [
            { level_id: 'L001', position: 1, title: '软件危机', kind: 'choice',
              identifiers: ['wafjr3xgmk5b'], answered: false },
            { level_id: 'L002', position: 2, title: '类图题目初体验', kind: 'choice',
              identifiers: ['efbt5uy9cgwj'], answered: true,
              answer: [{ number: 1, selected: ['A'] }] }
          ]
        }
      ]
    }
  ],
  stats: { classrooms: 1, experiments: 1, levels: 2, answered: 1, missing: 1 }
};

async function loadSandbox({ storedAnswers = null, storedAuto = false, gmWrites = [] } = {}) {
  const hooks = {};
  hooks.__location = { pathname: '/tasks/x', href: 'https://www.educoder.net/tasks/x', search: '' };
  const fakeDocument = {
    querySelectorAll: () => [],
    querySelector: () => null,
    getElementById: () => null,
    createElement: () => ({ style: {}, append() {}, appendChild() {}, remove() {}, replaceChildren() {}, addEventListener() {}, setAttribute() {}, click() {}, getClientRects: () => [] }),
    createTextNode: (text) => ({ textContent: String(text) }),
    head: { append() {} },
    body: { append() {}, appendChild() {} },
    addEventListener: () => {},
    readyState: 'complete'
  };
  const location = { pathname: '/tasks/x', href: 'https://www.educoder.net/tasks/x', search: '' };
  const sandbox = {
    window: { __liteTestHooks: hooks, btoa: (v) => Buffer.from(String(v), 'binary').toString('base64'), atob: (v) => Buffer.from(String(v), 'base64').toString('binary'), document: fakeDocument, innerWidth: 1440, innerHeight: 900 },
    document: fakeDocument,
    location,
    navigator: { userAgent: 'test' },
    URL, URLSearchParams, console, setTimeout, clearTimeout,
    GM_getValue: (key, fallback) => (key === 'lite-answers-v2' ? storedAnswers : key === 'lite-auto' ? storedAuto : fallback),
    GM_setValue: (key, value) => gmWrites.push({ key, value }),
    GM_deleteValue: () => {},
    GM_registerMenuCommand: () => {},
    unsafeWindow: null
  };
  sandbox.location = hooks.__location;
  sandbox.window.location = hooks.__location;
  vm.createContext(sandbox);
  new vm.Script(SOURCE).runInContext(sandbox);
  // boot 现在是 async 的（先取登录再载答案）——等它完成，测试才能拿到稳定状态
  await new Promise((resolve) => setTimeout(resolve, 30));
  return hooks;
}

test('简易版：脚本能在沙箱里加载（boot 不抛错）', async () => {
  const hooks = await loadSandbox();
  assert.ok(hooks.state, 'boot 完成后应能拿到状态');
});

test('简易版：导入校验拒绝非班级文件，接受合法班级文件', async () => {
  const hooks = await loadSandbox();
  assert.equal(hooks.validateImported({ foo: 1 }).ok, false, '非班级文件要拒绝');
  const verdict = hooks.validateImported(CLASS_DOC);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.stats.experiments, 1);
  assert.equal(verdict.stats.answered, 1);
});

test('简易版：按关卡标识找答案（identifiers 优先），没有标识的关卡不排进队列', async () => {
  const stored = JSON.parse(JSON.stringify(CLASS_DOC));
  stored.classrooms[0].experiments[0].levels[0].identifiers = [];
  const hooks = await loadSandbox({ storedAnswers: stored });
  // L002 有标识 → 能按标识找到
  const hit = hooks.findLevel({ gameId: 'efbt5uy9cgwj', subject: '类图题目初体验', position: 2 });
  assert.equal(hit.level.level_id, 'L002');
  // 队列只含有答案且有标识的关卡：L001 没答案不排；L002 有标识排 1 项
  const { queue, missingIdentifier } = hooks.buildWorkQueue();
  assert.equal(queue.length, 1, '只有有答案且有标识的关卡进队列');
  assert.equal(queue[0].gameId, 'efbt5uy9cgwj');
  assert.equal(queue[0].homeworkId, 4200882, '队列项要带作业号（导航拼 URL 用）');
  assert.equal(missingIdentifier, 0);
});

test('简易版：observeTaskPayload 能从 payload 建立关卡上下文', async () => {
  const hooks = await loadSandbox({ storedAnswers: CLASS_DOC });
  hooks.observeTaskPayload({
    challenge: { id: 777, subject: '类图题目初体验', homework_challenge_index: 2, score: 50 },
    game: { identifier: 'efbt5uy9cgwj', final_score: 50 },
    next_game: '', prev_game: 'wafjr3xgmk5b',
    chooses: [{ challenge_question: [1, 2, 3, 4] }]
  }, 'https://www.educoder.net/tasks/2i6ng7vp/4200882/efbt5uy9cgwj');
  assert.equal(hooks.findLevel({ gameId: 'efbt5uy9cgwj' }).level.level_id, 'L002');
});

test('简易版：gameIdFromUrl 两种任务 URL 形态都取到关卡标识（10-11 卡死防护）', async () => {
  const hooks = await loadSandbox({ storedAnswers: CLASS_DOC });
  // 旧式单段
  assert.equal(
    hooks.gameIdFromUrl('https://www.educoder.net/tasks/vrtbzlmexi3f?homework_common_id=4200911&zzud=x'),
    'vrtbzlmexi3f'
  );
  // 三段式（CNN 实测形态：/tasks/{课程码}/{作业号}/{关卡标识}）——前缀比对会在这里误判
  assert.equal(
    hooks.gameIdFromUrl('https://www.educoder.net/tasks/2xxxxxx/4200911/vrtbzlmexi3f?coursesId=x'),
    'vrtbzlmexi3f'
  );
});


test('简易版：startAuto 持久化开关并导航到第一个有答案的关卡（修复"点一下走一步"）', async () => {
  const stored = JSON.parse(JSON.stringify(CLASS_DOC));
  const gmWrites = [];
  const hooks = await loadSandbox({ storedAnswers: stored, gmWrites });
  // 当前页面（/tasks/x）不是任何目标关卡 → startAuto 应导航到第一个有答案的关卡
  await hooks.startAuto();
  // 一键开关现在按账号隔离（lite-auto:{login}）——断言用前缀匹配
  const autoWrites = gmWrites.filter((w) => String(w.key).startsWith('lite-auto'));
  assert.ok(autoWrites.length && autoWrites[autoWrites.length - 1].value === true, '一键开关必须持久化（跨页面续答的命门）');
  assert.match(
    String(hooks.__location.href),
    /\/tasks\/efbt5uy9cgwj\?homework_common_id=4200882$/,
    '要导航到第一个有答案的关卡（L002；L001 没答案不排队）'
  );
});

test('简易版：submitAndWait 在没有提交按钮时返回 blocked（函数必须存在——曾漏定义导致运行时才炸）', async () => {
  const hooks = await loadSandbox({ storedAnswers: CLASS_DOC });
  assert.equal(typeof hooks.submitAndWait, 'function', 'submitAndWait 必须有定义');
  const outcome = await hooks.submitAndWait(); // 假页面没有任何按钮
  assert.equal(outcome.status, 'blocked');
  assert.match(outcome.text, /找不到提交按钮/);
});
