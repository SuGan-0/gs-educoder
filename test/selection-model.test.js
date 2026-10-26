'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { levelKey, entries, resolveLevelSelection } = require('../extractor/lib/selection-model');
const levels = [
  { name: '第一关', experimentName: '实验甲', experimentIndex: 0, position: 1, challengeId: 'shared' },
  { name: '第一关', experimentName: '实验乙', experimentIndex: 1, position: 1, challengeId: 'shared' },
  { name: '第二关', experimentName: '实验乙', experimentIndex: 1, position: 2, identifier: 'task-b2' }
];
test('重复序号和 challengeId 按所属实验区分，筛选保留原始索引', () => {
  assert.notEqual(levelKey(levels[0], 0), levelKey(levels[1], 1));
  assert.deepEqual(entries(levels, '实验乙 第一关').map(entry => entry.index), [1]);
  assert.equal(resolveLevelSelection(levels, { levels: [{ experimentIndex: 1, challengeId: 'shared' }] })[0], levels[1]);
});
test('身份不匹配不能降级序号、歧义不能猜测、空选不能变成全选', () => {
  assert.throws(() => resolveLevelSelection(levels, { levels: [{ identifier: 'wrong', position: 1 }] }), /未找到关卡/);
  assert.throws(() => resolveLevelSelection(levels, { levels: [{ position: 1 }] }), /不唯一/);
  assert.throws(() => resolveLevelSelection(levels, { levels: [] }), /至少选择/);
  assert.throws(() => resolveLevelSelection(levels, { levels: [{ experimentIndex: -1, position: 1 }] }), /归属无效/);
});
test('兼容旧标识选择，并去掉重复的选择项', () => {
  assert.deepEqual(resolveLevelSelection(levels, { identifiers: ['task-b2', 'task-b2'] }), [levels[2]]);
});
