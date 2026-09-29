'use strict';

/**
 * 校验答案文件：按关卡存档核对「每关都有答案、题型对得上、选项字母没越界、代码不是占位文本」。
 *
 * 用法（CLI 见 tools/validate-answers.js）：
 *   const report = validateAnswers({ levels, answers });
 *   report.ok        // 全部通过
 *   report.issues[]  // { level, kind, code, message }
 */

const { normalizeAnswer, KINDS } = require('./task-parser');

/** 代码答案的占位文本：AI 没真作答时会留下这些。 */
const PLACEHOLDER = /完整代码|可直接放入|保留题目给的框架|TODO|待补充|\.\.\.\s*$/;

function codeLetters(count) {
  return Array.from({ length: count }, (_value, index) => String.fromCharCode(65 + index));
}

/**
 * @param {{levels: Array, answers: Object|Array}} input
 *   levels  — 关卡存档记录（含 taskIndex / type / choiceQuestions / codeLanguage）
 *   answers — { level_id: 答案 } 或 [{ level_id, ... }]
 */
function validateAnswers({ levels = [], answers = {} } = {}) {
  const map = new Map();
  if (Array.isArray(answers)) {
    for (const item of answers) if (item && item.level_id) map.set(String(item.level_id), item);
  } else if (answers && typeof answers === 'object') {
    for (const [key, value] of Object.entries(answers)) map.set(String(key), value);
  }

  const issues = [];
  const covered = [];
  const add = (level, kind, code, message) => issues.push({ level, kind, code, message });

  for (const level of levels) {
    const id = `L${String(Number(level.taskIndex) || 0).padStart(3, '0')}`;
    const kind = level.type === KINDS.CHOICE ? KINDS.CHOICE : KINDS.CODE;
    const raw = map.get(id);
    if (raw === undefined) {
      add(id, kind, 'missing', `缺少答案（${level.title || level.level || id}）`);
      continue;
    }

    const normalized = normalizeAnswer(id, raw, { kind, language: level.codeLanguage, source: level.source });
    if (normalized.kind !== kind) {
      add(id, kind, 'kind-mismatch', `题型不符：存档是 ${kind}，答案是 ${normalized.kind}`);
      continue;
    }

    if (kind === KINDS.CHOICE) {
      const questions = level.choiceQuestions || [];
      // 字母必须真的出现在写法里：规范化会过滤非法字母，所以这里同时看原始文本。
      const rawText = Array.isArray(raw.answers)
        ? raw.answers.map((item) => (item && item.answer ? [].concat(item.answer).join(',') : '')).join(';')
        : String(raw.answer ?? '');
      const written = (rawText.match(/[A-Za-z]/g) || []).map((letter) => letter.toUpperCase());
      if (!normalized.answers.length) {
        add(id, kind, 'empty', '选择题答案为空');
        continue;
      }
      const byQuestion = new Map(normalized.answers.map((item) => [Number(item.question), item.answer]));
      for (let index = 0; index < Math.max(questions.length, 1); index += 1) {
        const questionNo = index + 1;
        const letters = byQuestion.get(questionNo) || (questions.length <= 1 ? normalized.answers[0].answer : null);
        if (!letters || !letters.length) {
          add(id, kind, 'missing-question', `第 ${questionNo} 题没有答案`);
          continue;
        }
        const options = questions[index]?.options || [];
        const allowed = codeLetters(options.length);
        const invalid = letters.filter((letter) => allowed.length && !allowed.includes(letter));
        if (invalid.length) {
          add(id, kind, 'letter-out-of-range', `第 ${questionNo} 题选项越界：${invalid.join('')}（本题只有 ${allowed.join('/')}）`);
        }
      }
      // 写法里出现的、根本没被识别成答案的字母（例如 "Z"、或超出 A-H 范围）也要点名。
      const recognized = new Set(normalized.answers.flatMap((item) => item.answer));
      const unknown = [...new Set(written.filter((letter) => !recognized.has(letter)))];
      if (unknown.length) {
        add(id, kind, 'invalid-letter', `答案里出现了无法识别的选项字母：${unknown.join('、')}（有效范围 A–H）`);
      }
      if (byQuestion.size > questions.length) {
        add(id, kind, 'extra-question', `答案里的题号多于题目小问数（题目 ${questions.length} 问，答案 ${byQuestion.size} 问）`);
      }
    } else {
      const code = normalized.answer;
      if (!code) {
        add(id, kind, 'empty', '编程题答案为空');
        continue;
      }
      if (PLACEHOLDER.test(code)) {
        add(id, kind, 'placeholder', '编程题答案看着还是占位文本（没有替换成真实代码）');
      }
      const marker = /#{3,}\s*begin\s*#{3,}/i.exec(level.starterCode || '');
      if (marker && !new RegExp(marker[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(code)) {
        add(id, kind, 'missing-marker', `代码里缺少题目框架的标记「${marker[0]}」`);
      }
    }
    covered.push({ level: id, kind });
  }

  return {
    ok: issues.length === 0,
    total: levels.length,
    covered: covered.length,
    issues,
    byLevel: Object.fromEntries(covered.map((item) => [item.level, item.kind]))
  };
}

/**
 * 直接校验「答案文件里的答案数组」——序列化之后（最简写法）再校验，
 * 而不是校验规范化后的结构：规范化会把非法字母直接丢掉，那样就看不见「模型写了 Z」这类问题。
 */
function validateAnswerList(list, levels) {
  const map = {};
  for (const item of Array.isArray(list) ? list : []) {
    if (item && item.level_id) map[String(item.level_id)] = item;
  }
  return validateAnswers({ levels, answers: map });
}

module.exports = { validateAnswers, validateAnswerList };
