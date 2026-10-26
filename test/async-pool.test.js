'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mapConcurrent } = require('../extractor/lib/async-pool');
const tick = () => new Promise(resolve => setImmediate(resolve));

test('清单读取池最多三个在途请求，乱序完成仍按输入顺序返回', async () => {
  const gates = Array.from({ length: 7 }, () => {
    let release;
    const promise = new Promise(resolve => { release = resolve; });
    return { promise, release };
  });
  let active = 0, peak = 0;
  const entered = [];
  const reading = mapConcurrent(gates, 3, async (gate, index) => {
    entered.push(index);
    peak = Math.max(peak, ++active);
    await gate.promise;
    active--;
    return index;
  });
  await tick();
  assert.deepEqual(entered, [0, 1, 2]);
  gates[2].release();
  await tick();
  assert.deepEqual(entered, [0, 1, 2, 3]);
  for (const gate of gates) gate.release();
  assert.deepEqual(await reading, [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(peak, 3);
});

test('停止后不再分配新清单请求，已发出的读取可以完成', async () => {
  let stopped = false;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const entered = [];
  const reading = mapConcurrent([0, 1, 2, 3, 4], 2, async item => {
    entered.push(item);
    await gate;
    return item;
  }, () => stopped);
  await tick();
  stopped = true;
  release();
  const result = await reading;
  assert.deepEqual(entered, [0, 1]);
  assert.deepEqual(result.slice(0, 2), [0, 1]);
  assert.equal(result[2], undefined);
});
