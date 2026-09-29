'use strict';

/**
 * 缺答案清单的落盘（篡改猴上报 → 控制台保存）。
 *
 * 用途：教学课程「一键答题」遇到「没有本地答案、且不是虚拟机题」的关卡时，
 * 篡改猴把「课程 / 实验 / 关卡 / 关卡 URL」上报到这里；补上答案后可照清单定向再答。
 *
 * 规范位置：`exports/missing-answers.json`（跨课程汇总，单文件）。
 * 规则：同一条目（课程 + 实验 + 关卡；有标识用标识，没有才退回 URL）幂等去重；重复上报只刷新时间。
 * 读写风格与 lib/answer-store.js 一致：坏文件不炸、返回空清单，下次写入重建。
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

/** 清单文件的规范位置。 */
function missingPathFor(exportRoot) {
  return path.join(exportRoot, 'missing-answers.json');
}

/** 条目标识：课程 + 实验 + 关卡（优先关卡标识，没有标识才退回 URL）——同一关卡重复上报必须收敛成一条。 */
function itemId(item) {
  const raw = [item.course, item.experiment, item.identifier || item.url || '', item.level].join('|');
  return crypto.createHash('sha1').update(raw).digest('hex').slice(0, 16);
}

/** 只保留规范字段，避免把上报方的临时字段写进文件。 */
function normalizeItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const item = {
    course: String(raw.course || '').trim(),
    experiment: String(raw.experiment || '').trim(),
    level: String(raw.level || '').trim(),
    level_id: String(raw.level_id || raw.levelId || '').trim(),
    identifier: String(raw.identifier || '').trim(),
    url: String(raw.url || '').trim(),
    reason: String(raw.reason || 'no-answer').trim()
  };
  // 课程/实验是「归属」、关卡名是「叫什么」：缺了就没法补答案，直接丢弃。
  if (!item.course || !item.experiment || !item.level) return null;
  return {
    ...item,
    id: itemId(item),
    reported_at: String(raw.reported_at || '').trim() || new Date().toISOString()
  };
}

/** 读清单；文件不存在 / 坏文件 / 结构不对都返回空清单（不抛）。 */
async function readMissingDocument(exportRoot) {
  try {
    const parsed = JSON.parse(await fs.readFile(missingPathFor(exportRoot), 'utf8'));
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.items)) {
      return { updated_at: '', items: [] };
    }
    return { updated_at: String(parsed.updated_at || ''), items: parsed.items.filter((item) => item && item.id) };
  } catch {
    return { updated_at: '', items: [] };
  }
}

async function writeMissingDocument(exportRoot, document) {
  await fs.mkdir(exportRoot, { recursive: true });
  await fs.writeFile(missingPathFor(exportRoot), JSON.stringify(document, null, 2), 'utf8');
}

/**
 * 追加条目（幂等）。
 * @returns {Promise<{ok:boolean, added:number, refreshed:number, skipped:number, items:Array}>}
 */
async function addMissing(exportRoot, items) {
  const document = await readMissingDocument(exportRoot);
  const byId = new Map(document.items.map((item) => [item.id, item]));
  let added = 0;
  let refreshed = 0;
  let skipped = 0;
  for (const raw of Array.isArray(items) ? items : items ? [items] : []) {
    const item = normalizeItem(raw);
    if (!item) {
      skipped += 1;
      continue;
    }
    const existing = byId.get(item.id);
    if (existing) {
      // 重复上报：只刷新时间（同一关卡可能被多轮答题反复报到）
      if (existing.reported_at !== item.reported_at) {
        existing.reported_at = item.reported_at;
        refreshed += 1;
      }
      continue;
    }
    byId.set(item.id, item);
    added += 1;
  }
  if (!added && !refreshed) return { ok: true, added: 0, refreshed: 0, skipped, items: document.items };
  document.items = [...byId.values()].sort((a, b) => String(a.reported_at).localeCompare(String(b.reported_at)));
  document.updated_at = new Date().toISOString();
  await writeMissingDocument(exportRoot, document);
  return { ok: true, added, refreshed, skipped, items: document.items };
}

/** 按 id 删除；没有任何改动时不写盘。 */
async function removeMissing(exportRoot, ids) {
  const document = await readMissingDocument(exportRoot);
  const wanted = new Set((Array.isArray(ids) ? ids : ids ? [ids] : []).map((id) => String(id || '')));
  const before = document.items.length;
  document.items = document.items.filter((item) => !wanted.has(item.id));
  const removed = before - document.items.length;
  if (removed) {
    document.updated_at = new Date().toISOString();
    await writeMissingDocument(exportRoot, document);
  }
  return { ok: true, removed, items: document.items };
}

/** 清空全部。 */
async function clearMissing(exportRoot) {
  const document = await readMissingDocument(exportRoot);
  const cleared = document.items.length;
  if (cleared) await writeMissingDocument(exportRoot, { updated_at: new Date().toISOString(), items: [] });
  return { ok: true, cleared, items: [] };
}

module.exports = { missingPathFor, itemId, readMissingDocument, addMissing, removeMissing, clearMissing };