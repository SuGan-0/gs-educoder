'use strict';

/**
 * 篡改猴：**作答前核对班级** + 答案 v2 结构解析。
 *
 * 为什么这两件事必须一起测：
 * - 答案库现在吐的是 v2（`answer: { language, code }` / `answer: { questions: [...] }`），
 *   脚本若还按字符串读就会拿到 `[object Object]`，把整段代码填成这两个字；
 * - 而 v2 顺带带来了 `classroomCode`，于是「这份答案是不是当前班级的」第一次可以被核对。
 *
 * 班级身份只能从**关卡数据**里拿：关卡页 URL（`/tasks/{课程码}/{作业ID}/{关卡标识}`）
 * 里没有班级码，只有 `tasks/{id}.json` 的 `course_identifier` 是课堂码。
 * 所以这里用真实的 `observeTaskJson` 喂一份关卡数据，再验证判定结果。
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

/**
 * 跨 vm 领域取值：vm 里造出来的对象原型与本文件的不同，
 * `deepStrictEqual` 会因为「结构相同但引用不同」直接失败。过一遍 JSON 归一。
 */
const plain = (value) => JSON.parse(JSON.stringify(value));

/** 起一个只挂测试钩子的沙箱（不启动面板、不装网络钩子）。 */
function bootHooks({ pathname = '/tasks/HCEAP94S/3965745/vrtbzlmexi3f' } = {}) {
  const hooks = {};
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    GM_getValue: (_key, fallback) => fallback,
    GM_setValue: () => {},
    GM_registerMenuCommand: () => {},
    GM_xmlhttpRequest: () => {},
    location: { pathname, href: `https://www.educoder.net${pathname}`, search: '', hash: '' },
    document: {
      readyState: 'complete',
      addEventListener: () => {},
      // `log()` 会顺手刷新面板上的日志状态，因此这几个查询方法必须存在。
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      body: { innerText: '', appendChild: () => {} },
      createElement: () => ({
        style: {},
        dataset: {},
        children: [],
        appendChild() {},
        addEventListener() {},
        removeEventListener() {},
        setAttribute() {},
        remove() {}
      })
    }
  };
  sandbox.window = sandbox;
  sandbox.window.__educoderAutosubmitTestHooks = hooks;
  sandbox.unsafeWindow = sandbox;
  vm.createContext(sandbox);
  new vm.Script(SOURCE).runInContext(sandbox);
  return hooks;
}

/** 一份真实的关卡数据（字段与 2026-10-01 实测一致）。 */
function taskPayload({ courseIdentifier = 'HCEAP94S' } = {}) {
  return {
    course_identifier: courseIdentifier,
    course_id: 120386,
    homework_common_id: 3965745,
    homework_common_name: 'CNN',
    challenge: { subject: 'conv', position: 1, score: 100 },
    game: { final_score: 100 },
    prev_game: null,
    next_game: 'pool'
  };
}

test('答案解析：v2 的编程题答案是对象，不能再吐 [object Object]', () => {
  const hooks = bootHooks();
  const parsed = hooks.readAnswer({
    level_id: 'L001',
    kind: 'code',
    source: 'ai',
    answer: { language: 'python', code: 'def f():\n    return 1' }
  });
  assert.deepEqual(plain(parsed), { kind: 'code', code: 'def f():\n    return 1' });
});

test('答案解析：v2 的选择题是结构化小问，直接取 selected', () => {
  const hooks = bootHooks();
  const parsed = hooks.readAnswer({
    level_id: 'L002',
    kind: 'choice',
    answer: { questions: [{ number: 1, selected: ['A', 'C'] }, { number: 2, selected: ['B'] }] }
  });
  assert.deepEqual(plain(parsed), { kind: 'choice', map: { 1: ['A', 'C'], 2: ['B'] } });
});

test('答案解析：历史写法（字符串 / answers 数组）仍然能读', () => {
  const hooks = bootHooks();
  assert.deepEqual(
    plain(hooks.readAnswer({ kind: 'choice', answer: '1:A;2:B,D' })),
    { kind: 'choice', map: { 1: ['A'], 2: ['B', 'D'] } }
  );
  assert.deepEqual(
    plain(hooks.readAnswer({ kind: 'choice', answer: 'B' })),
    { kind: 'choice', map: { 1: ['B'] } }
  );
  assert.deepEqual(
    plain(hooks.readAnswer({ kind: 'choice', answers: [{ question: 2, answer: ['C'] }] })),
    { kind: 'choice', map: { 2: ['C'] } }
  );
  assert.deepEqual(
    plain(hooks.readAnswer({ kind: 'code', answer: 'print(1)' })),
    { kind: 'code', code: 'print(1)' }
  );
  assert.equal(hooks.readAnswer(null), null);
});

test('班级核对：答案与当前页面同班 → 放行', () => {
  const hooks = bootHooks();
  hooks.observeTaskJson('https://data.educoder.net/api/tasks/vrtbzlmexi3f.json', taskPayload());
  assert.equal(hooks.state.taskContext.classroomCode, 'HCEAP94S', '班级码要从关卡数据里读出来');
  assert.equal(hooks.state.taskContext.homeworkId, 3965745);

  hooks.state.levelIndex = { vrtbzlmexi3f: 'CNN__conv__L001' };
  hooks.state.answers = {
    'CNN__conv__L001': {
      level_id: 'L001',
      kind: 'code',
      classroomCode: 'HCEAP94S',
      classroomName: '机器学习_2026年下半年',
      answer: { language: 'python', code: 'print(1)' }
    }
  };

  const resolved = hooks.resolveAnswerForCurrentLevel();
  assert.equal(resolved.blocked, '');
  assert.equal(resolved.entry.level_id, 'L001');
});

test('班级核对：答案属于别的班 → 拒绝作答并说明两边分别是什么', () => {
  const hooks = bootHooks();
  hooks.observeTaskJson('https://data.educoder.net/api/tasks/vrtbzlmexi3f.json', taskPayload({ courseIdentifier: 'HCEAP94S' }));

  hooks.state.levelIndex = { vrtbzlmexi3f: 'CNN__conv__L001' };
  hooks.state.answers = {
    'CNN__conv__L001': {
      level_id: 'L001',
      kind: 'code',
      // 同一份实验在另一个班里也存在——旧实现只按关卡名兜底，就会把这份答案填进来
      classroomCode: 'OTHER123',
      classroomName: '另一个班的机器学习',
      answer: { language: 'python', code: 'print(别班的答案)' }
    }
  };

  const resolved = hooks.resolveAnswerForCurrentLevel();
  assert.ok(resolved.blocked, '必须拒绝作答');
  assert.match(resolved.blocked, /班级不一致/);
  assert.match(resolved.blocked, /OTHER123/, '要说清答案属于哪个班');
  assert.match(resolved.blocked, /HCEAP94S/, '要说清当前页面是哪个班');
});

test('班级核对：拿不到班级时只提示不拦（页面刚打开还没发请求）', () => {
  const hooks = bootHooks();
  // 故意不调用 observeTaskJson → taskContext 为空
  hooks.state.levelIndex = { vrtbzlmexi3f: 'CNN__conv__L001' };
  hooks.state.answers = {
    'CNN__conv__L001': { level_id: 'L001', kind: 'code', classroomCode: 'HCEAP94S', answer: { code: 'x' } }
  };
  const resolved = hooks.resolveAnswerForCurrentLevel();
  assert.equal(resolved.blocked, '', '拿不到班级不能直接把功能锁死');
  assert.equal(resolved.entry.level_id, 'L001');
});

test('班级核对：老答案库没有班级码 → 只提示不拦', () => {
  const hooks = bootHooks();
  hooks.observeTaskJson('https://data.educoder.net/api/tasks/vrtbzlmexi3f.json', taskPayload());
  hooks.state.levelIndex = { vrtbzlmexi3f: 'CNN__conv__L001' };
  hooks.state.answers = {
    'CNN__conv__L001': { level_id: 'L001', kind: 'code', answer: { code: 'x' } }
  };
  const resolved = hooks.resolveAnswerForCurrentLevel();
  assert.equal(resolved.blocked, '', '老答案库要能继续用');
});

test('班级核对：这一关根本没有答案时不拦（交给后续流程报「没答案」）', () => {
  const hooks = bootHooks();
  hooks.observeTaskJson('https://data.educoder.net/api/tasks/vrtbzlmexi3f.json', taskPayload());
  hooks.state.levelIndex = { vrtbzlmexi3f: 'CNN__conv__L001' };
  hooks.state.answers = {};
  const resolved = hooks.resolveAnswerForCurrentLevel();
  assert.equal(resolved.blocked, '');
  assert.equal(resolved.entry, null);
});
