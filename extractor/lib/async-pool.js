'use strict';

/** 有界只读任务池：结果保持输入顺序，停止后不再分配新任务。已发出的任务仍会收尾。 */
async function mapConcurrent(items, limit, mapper, shouldStop = () => false) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      if (await shouldStop()) return;
      if (cursor >= items.length) return;
      const index = cursor++;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

module.exports = { mapConcurrent };
