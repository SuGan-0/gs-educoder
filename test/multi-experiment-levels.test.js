/**
 * 多实验关卡选择：选多个课堂实验时，必须一次列出**所有**实验的关卡，
 * 而不是逐个实验串行询问（那样界面上只会看到第一个实验的关卡）。
 *
 * 这里直接构造引擎并覆写 loadLevels，聚焦选择/分发逻辑本身，不依赖站点夹具。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const originalLoad = Module._load;
Module._load = function (request) {
  if (request === 'playwright') {
    return { chromium: { async launchPersistentContext() { throw new Error('本测试不应启动浏览器'); } } };
  }
  return originalLoad.apply(this, arguments);
};
test.after(() => {
  Module._load = originalLoad;
});

const { ExtractEngine } = require('../extractor/lib/extract-engine');

/** 造一个引擎，loadLevels 按实验名返回固定关卡。events 收集所有推给界面的事件。 */
function makeEngine(levelsByExperiment, control = {}) {
  const events = [];
  const engine = new ExtractEngine({
    exportRoot: require('node:os').tmpdir(),
    profileDir: require('node:os').tmpdir(),
    onEvent: (event) => events.push(event),
    control: {
      waitForCourse: async (courses) => courses[0],
      waitForExperiments: async (experiments) => experiments,
      shouldStop: async () => false,
      ...control
    }
  });
  const calls = [];
  engine.loadLevels = async (experiment, options = {}) => {
    calls.push({ name: experiment.name, emit: options.emit });
    return levelsByExperiment[experiment.name] || [];
  };
  engine.__levelCalls = calls;
  engine.__events = events;
  return engine;
}

const EXPERIMENT_A = { name: 'CNN', homeworkId: 1, shixunIdentifier: 'aaaa', taskCount: 2 };
const EXPERIMENT_B = { name: '模型评估与选择', homeworkId: 2, shixunIdentifier: 'bbbb', taskCount: 1 };

const LEVELS_A = [
  { identifier: 'conv', name: 'conv', index: 1, position: 1, challengeId: '11' },
  { identifier: 'pool', name: 'pool', index: 2, position: 2, challengeId: '12' }
];
const LEVELS_B = [{ identifier: '', name: '评估指标A', index: 1, position: 1, challengeId: '21' }];

test('多实验：一次列出全部实验的关卡，并标注所属实验', async () => {
  let askedOnce = 0;
  let received = null;
  const engine = makeEngine(
    { CNN: LEVELS_A, 模型评估与选择: LEVELS_B },
    {
      waitForAllLevels: async (levels) => {
        askedOnce += 1;
        received = levels;
        return levels; // 全选
      },
      waitForLevels: async () => {
        throw new Error('多实验路径不应逐个实验询问关卡');
      }
    }
  );

  const plans = await engine.selectLevelsForAll([EXPERIMENT_A, EXPERIMENT_B]);

  assert.equal(askedOnce, 1, '「关卡选择」只应询问一次');
  assert.equal(received.length, 3, `合并列表应含 2+1=3 关，实际 ${received.length}`);
  assert.deepEqual(
    [...new Set(received.map((level) => level.experimentName))].sort(),
    ['CNN', '模型评估与选择'].sort(),
    '每条关卡必须标注所属实验'
  );
  assert.deepEqual(
    engine.__levelCalls,
    [{ name: 'CNN', emit: false }, { name: '模型评估与选择', emit: false }],
    '两个实验的关卡列表都要读到，且不许各自发 levels 事件（会互相覆盖）'
  );
  assert.equal(engine.phase, 'waiting-levels', '必须推进到等待关卡阶段');

  // 回归（用户反馈的真实 bug）：界面只能靠 levels 事件拿到列表，
  // 而 loadLevels 的事件被抑制后，必须由这里一次性推出**合并后的全部关卡**，
  // 否则关卡区只会显示「最后一个被读取的实验」的关卡。
  const levelEvents = engine.__events.filter((event) => event.type === 'levels');
  assert.equal(levelEvents.length, 1, `只应发一次 levels 事件，实际 ${levelEvents.length}`);
  assert.equal(levelEvents[0].levels.length, 3, '事件必须带全部实验的关卡');
  assert.equal(levelEvents[0].multi, true, '必须标记为多实验合并列表');
  assert.deepEqual(levelEvents[0].experimentNames, ['CNN', '模型评估与选择']);
  assert.deepEqual(
    levelEvents[0].levels.map((level) => level.experimentName),
    ['CNN', 'CNN', '模型评估与选择'],
    '事件里的每条关卡都要能标出所属实验'
  );

  // 分发：每个实验拿到属于自己、且被选中的关卡
  assert.equal(plans.length, 2);
  assert.equal(plans[0].selection.length, 2, 'CNN 选中 2 关');
  assert.equal(plans[1].selection.length, 1, '第二个实验选中 1 关');
  assert.deepEqual([...plans[0].selectedIds].sort(), ['conv', 'pool']);
  assert.equal(plans[1].selectedIds, null, '该实验关卡无标识，应改用序号过滤');
  assert.deepEqual([...plans[1].selectedPositions], [1]);
});

test('多实验：只勾选部分关卡时按实验正确分发', async () => {
  const engine = makeEngine(
    { CNN: LEVELS_A, 模型评估与选择: LEVELS_B },
    {
      waitForAllLevels: async (levels) => levels.filter((level) => level.identifier !== 'pool')
    }
  );

  const plans = await engine.selectLevelsForAll([EXPERIMENT_A, EXPERIMENT_B]);

  assert.equal(plans[0].selection.length, 1, 'CNN 只选第 1 关');
  assert.deepEqual([...plans[0].selectedIds], ['conv']);
  assert.equal(plans[1].selection.length, 1, '第二个实验的关卡仍被选中');
});

test('多实验：一个关卡都不选时返回 null（不误当成全选）', async () => {
  const engine = makeEngine(
    { CNN: LEVELS_A, 模型评估与选择: LEVELS_B },
    { waitForAllLevels: async () => [] }
  );

  const plans = await engine.selectLevelsForAll([EXPERIMENT_A, EXPERIMENT_B]);
  assert.equal(plans, null, '空选择必须返回 null，由调用方结束任务');
});

test('多实验：所有实验都没有关卡列表时按关卡链抓全部（不询问）', async () => {
  let asked = false;
  const engine = makeEngine(
    { CNN: [], 模型评估与选择: [] },
    {
      waitForAllLevels: async () => {
        asked = true;
        return [];
      }
    }
  );

  const plans = await engine.selectLevelsForAll([EXPERIMENT_A, EXPERIMENT_B]);

  assert.equal(asked, false, '没有关卡列表时不应弹出空的选择步骤');
  assert.equal(plans.length, 2);
  assert.equal(plans[0].selection, null, 'selection 为 null 表示按关卡链抓全部');
  assert.equal(plans[1].selection, null);
  // 必须推出一个空列表，界面才能把上一次的关卡列表清掉。
  const levelEvents = engine.__events.filter((event) => event.type === 'levels');
  assert.equal(levelEvents.length, 1);
  assert.deepEqual(levelEvents[0].levels, [], '应推出空列表，避免界面残留上一个实验的关卡');
});

test('多实验：单个实验关卡列表读取失败时不影响其它实验', async () => {
  const engine = makeEngine({ CNN: LEVELS_A, 模型评估与选择: LEVELS_B });
  engine.loadLevels = async (experiment) => {
    if (experiment.name === 'CNN') throw new Error('接口超时');
    return LEVELS_B;
  };
  let received = null;
  engine.control.waitForAllLevels = async (levels) => {
    received = levels;
    return levels;
  };

  const plans = await engine.selectLevelsForAll([EXPERIMENT_A, EXPERIMENT_B]);

  assert.equal(received.length, 1, '只有读到列表的那个实验贡献关卡');
  assert.equal(received[0].experimentName, '模型评估与选择');
  assert.equal(plans[0].selection, null, '读列表失败的实验退回按关卡链抓全部');
  assert.equal(plans[1].selection.length, 1);
});
