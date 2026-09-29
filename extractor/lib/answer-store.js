'use strict';

/**
 * 答案文件的落盘与合并（抓取端与控制台共用）。
 *
 * 规范位置：`exports/answers/{课程}__{实验}.answers.json`（见 docs/AI-ANSWER-FORMAT.md）。
 * 两个写入来源：
 * - 抓取端：关卡「已通过测评」时，把提交的代码 / 所选项当作答案导出（extract-engine 调用）；
 * - 控制台：篡改猴提交通过后回传答案（`POST /api/answer/save` 调用）。
 *
 * 合并规则：同一 `level_id` 覆盖，其它关卡与文件里已有的写法原样保留——
 * AI 写过的答案、人工改过的答案都不会被一次导出抹掉。
 */

const fs = require('node:fs/promises');
const path = require('node:path');

const { answerFileName, normalizeAnswer, stringifyAnswer, KINDS } = require('./task-parser');

/** 答案文件的规范位置。 */
function answerPathFor(exportRoot, course, experiment) {
  return path.join(exportRoot, 'answers', `${answerFileName(course, experiment)}.answers.json`);
}

/**
 * 「已通过测评」判定：得分达到满分。
 *
 * 实测（2026-09-28，软件工程导论）：
 * - `challenge.score` 是**满分**（编程题 100；选择题每题 10 分，5 题就是 50）；
 * - `game.final_score` 是**得分**：未提交是 0，满分通过才等于满分（60 分的 6 题全对就是 60）。
 *
 * 别拿 `test_sets[].output` 判定——那是测试点的**期望输出**，未提交的关卡也可能是「通过」
 * （实测「高质量的代码」L001：final_score=0，output 却是「通过」）。
 */
function levelPassed(payload) {
  const max = Number(payload?.challenge?.score);
  const got = Number(payload?.game?.final_score);
  return Number.isFinite(max) && max > 0 && Number.isFinite(got) && got >= max;
}

/**
 * 已提交选择题的答案串（`1:B;2:A,C`）。
 *
 * `standard_answer`（平台标准答案）优先于 `actual_output`（用户答的）。
 * 两者都只在提交后才有：页面加载时的 GET 里是 null（标准答案只在提交响应里）。
 */
function choiceAnswerText(payload) {
  const rows = Array.isArray(payload?.choose_test_cases?.test_sets) ? payload.choose_test_cases.test_sets : [];
  return rows
    .slice()
    .sort((a, b) => (Number(a.position) || 0) - (Number(b.position) || 0))
    .map((row) => ({
      position: Number(row.position) || 0,
      answer: String(row.standard_answer ?? row.actual_output ?? '')
    }))
    .filter((row) => row.position > 0 && row.answer)
    .map((row) => `${row.position}:${row.answer}`)
    .join(';');
}

/** 读回已有答案文件；不存在或坏文件返回 null（不能因为一个坏文件就不写新答案）。 */
async function readAnswerDocument(answerPath) {
  try {
    const parsed = JSON.parse(await fs.readFile(answerPath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 稳定序列化（键名递归排序）：用来判断「新旧内容是不是同一份」。
 * 直接 JSON.stringify 比会受键顺序影响——同一份内容从不同来源（AI / 导出）写出时顺序可能不同。
 */
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

/**
 * 把一条答案合并进答案文件。
 *
 * @returns {Promise<{ok:boolean, error?:string, answerPath?:string, levelId?:string, count?:number, replaced?:boolean}>}
 */
async function mergeAnswer({ exportRoot, course, experiment, levelId, kind, language, answer, model }) {
  const id = String(levelId || '').trim();
  if (!/^L\d{3}$/.test(id)) return { ok: false, error: `关卡号不合法（应为 L001 这类）：${levelId || '(空)'}` };
  const courseName = String(course || '').trim();
  const experimentName = String(experiment || '').trim();
  if (!courseName || !experimentName) return { ok: false, error: '缺少课程/实验名，无法定位答案文件' };

  const normalizedKind = kind === KINDS.CHOICE ? KINDS.CHOICE : KINDS.CODE;
  const entry = stringifyAnswer(
    normalizeAnswer(id, { kind: normalizedKind, language, answer }, { kind: normalizedKind, language })
  );
  if (!entry || !String(entry.answer || '').trim()) return { ok: false, error: `答案为空（${id}）` };

  const answerPath = answerPathFor(exportRoot, courseName, experimentName);
  const existing = await readAnswerDocument(answerPath);
  const document = {
    course: courseName,
    experiment: experimentName,
    generated_at: new Date().toISOString(),
    model: (existing && existing.model) || model || 'export',
    answers: [],
    unanswered: []
  };

  let replaced = false;
  const previous = existing && existing.answers;
  if (Array.isArray(previous)) {
    // 原位替换：保持关卡顺序（L001、L002…），新关卡追加到末尾。
    document.answers = previous.map((item) => {
      if (item && String(item.level_id) === id) {
        replaced = true;
        return entry;
      }
      return item;
    });
    if (!replaced) document.answers.push(entry);
  } else if (previous && typeof previous === 'object') {
    // 兼容「以 level_id 为键」的旧写法：保持原写法，只替换这一关。
    replaced = Object.prototype.hasOwnProperty.call(previous, id);
    document.answers = { ...previous, [id]: entry };
  } else {
    document.answers = [entry];
  }

  if (Array.isArray(existing?.unanswered)) {
    document.unanswered = existing.unanswered.filter((item) => String(item?.level_id || '') !== id);
  } else if (existing && existing.unanswered) {
    document.unanswered = existing.unanswered;
  }

  const count = Array.isArray(document.answers) ? document.answers.length : Object.keys(document.answers).length;

  // 幂等：除 `generated_at` 外与磁盘上的文件完全一致时**不写盘**（也不刷新时间戳）。
  // 为什么必须这样：重跑同一门课时，内容没变的关卡本来会被"重新导出"一遍——
  // 文件内容只有 generated_at 变了，但 mtime/哈希都变，日志里还会打「已导出答案」，
  // 看起来就像工具又把整门课重抓了一遍（实测就是这个现象）。
  const unchanged = Boolean(existing) &&
    stableStringify({ ...existing, generated_at: null }) === stableStringify({ ...document, generated_at: null });
  if (unchanged) {
    return { ok: true, answerPath, levelId: id, replaced, count, changed: false };
  }

  await fs.mkdir(path.dirname(answerPath), { recursive: true });
  await fs.writeFile(answerPath, JSON.stringify(document, null, 2), 'utf8');
  return { ok: true, answerPath, levelId: id, replaced, count, changed: true };
}

module.exports = { answerPathFor, levelPassed, choiceAnswerText, mergeAnswer };