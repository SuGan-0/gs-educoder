'use strict';

/**
 * 校验答案文件：按关卡存档核对「每关都有答案、题型对得上、选项字母没越界、代码不是占位文本」。
 *
 * 用法（CLI 见 tools/validate-answers.js）：
 *   const report = validateAnswers({ levels, answers });
 *   report.ok        // 全部通过
 *   report.issues[]  // { level, kind, code, message }
 *
 * 答案的形状由 `answer-format.js` 定义（v2），这里只做**内容**层面的检查。
 */

const fmt = require('./answer-format');

/** 代码答案的占位文本：AI 没真作答时会留下这些。 */
const PLACEHOLDER = /完整代码|可直接放入|保留题目给的框架|TODO|待补充|\.\.\.\s*$/;

function codeLetters(count) {
  return Array.from({ length: count }, (_value, index) => String.fromCharCode(65 + index));
}

/** 从原始条目里取出「写出来的字母」，用于发现被规范化过滤掉的非法字母。 */
function writtenLetters(raw) {
  if (Array.isArray(raw?.answer?.questions)) return writtenLetters(raw.answer);
  if (Array.isArray(raw?.answer)) return writtenLetters({ questions: raw.answer });
  if (Array.isArray(raw?.questions)) {
    const joined = raw.questions
      .flatMap((item) => (Array.isArray(item.selected) ? item.selected : []))
      .join(',');
    return joined.match(/[A-Za-z]/g) || [];
  }
  if (Array.isArray(raw?.answers)) {
    const joined = raw.answers
      .map((item) => (item && item.answer ? [].concat(item.answer).join(',') : ''))
      .join(';');
    return joined.match(/[A-Za-z]/g) || [];
  }
  return String(raw?.answer ?? '').match(/[A-Za-z]/g) || [];
}

/**
 * @param {{levels: Array, answers: Object|Array}} input
 *   levels  — 关卡存档记录（含 taskIndex / type / choiceQuestions / codeLanguage）
 *   answers — `{ level_id: 答案 }` 或 `[{ level_id, ... }]`
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
    const id = fmt.levelIdOf(level.taskIndex);
    const kind = level.type === fmt.KINDS.CHOICE ? fmt.KINDS.CHOICE : fmt.KINDS.CODE;
    const raw = map.get(id);
    if (raw === undefined) {
      add(id, kind, 'missing', `缺少答案（${level.title || level.level || id}）`);
      continue;
    }

    const normalized = fmt.normalizeAnswer(id, raw, { kind, language: level.codeLanguage });
    if (normalized.kind !== kind) {
      add(id, kind, 'kind-mismatch', `题型不符：存档是 ${kind}，答案是 ${normalized.kind}`);
      continue;
    }

    if (kind === fmt.KINDS.CHOICE) {
      const questions = level.choiceQuestions || [];
      // 字母必须真的出现在写法里：规范化会过滤非法字母，所以这里同时看原始文本。
      const written = writtenLetters(raw).map((letter) => letter.toUpperCase());
      if (!normalized.questions.length) {
        add(id, kind, 'empty', '选择题答案为空');
        continue;
      }
      const byQuestion = new Map(normalized.questions.map((item) => [Number(item.number), item.selected]));
      for (let index = 0; index < Math.max(questions.length, 1); index += 1) {
        const questionNo = index + 1;
        const letters = byQuestion.get(questionNo)
          || (questions.length <= 1 ? normalized.questions[0].selected : null);
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
      const recognized = new Set(normalized.questions.flatMap((item) => item.selected));
      const unknown = [...new Set(written.filter((letter) => !recognized.has(letter)))];
      if (unknown.length) {
        add(id, kind, 'invalid-letter', `答案里出现了无法识别的选项字母：${unknown.join('、')}（有效范围 A–H）`);
      }
      if (byQuestion.size > questions.length) {
        add(id, kind, 'extra-question', `答案里的题号多于题目小问数（题目 ${questions.length} 问，答案 ${byQuestion.size} 问）`);
      }
    } else {
      const code = normalized.code;
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
 * 直接校验「答案文件里的答案数组」。
 *
 * 注意校验的是**文件里写着的结构**，不是规范化后的结果：
 * 规范化会把非法字母直接丢掉，那样就看不见「模型写了 Z」这类问题。
 */
function validateAnswerList(list, levels) {
  const map = {};
  for (const item of Array.isArray(list) ? list : []) {
    if (item && item.level_id) map[String(item.level_id)] = item;
  }
  return validateAnswers({ levels, answers: map });
}

/** 不依赖题目存档的工作文档检查；保留原始结构，避免规范化掩盖非法字段。 */
function validateAnswerDocument(raw, { classroom, experiment, standalone = false } = {}) {
  const issues = [];
  const add = (level, code, message, kind = '-') => issues.push({ level, kind, code, message });
  const document = fmt.normalizeDocument(raw, { classroom, experiment });
  const matchesName = (declared, expected) => !expected || declared === expected || fmt.safeFilePart(declared) === expected;
  if (!matchesName(document.classroom.name, classroom?.name)) add('-', 'course-mismatch', `答案课堂「${document.classroom.name}」与目录「${classroom.name}」不一致`);
  if (classroom?.code && document.classroom.code && classroom.code !== document.classroom.code) add('-', 'classroom-code-mismatch', '答案课堂码与目录/存档不一致');
  if (!matchesName(document.experiment.name, experiment?.name)) add('-', 'experiment-mismatch', `答案实验「${document.experiment.name}」与目录「${experiment.name}」不一致`);
  const homeworkId = Number(experiment?.homework_id || experiment?.homeworkId) || 0;
  if (homeworkId && document.experiment.homework_id && homeworkId !== document.experiment.homework_id) add('-', 'homework-mismatch', '答案作业号与题目存档不一致');
  if (document.classroom.name === '未命名班级') add('-', 'missing-classroom', '缺少课堂名称');
  if (document.experiment.name === '未命名实验') add('-', 'missing-experiment', '缺少实验名称');
  if (standalone && !document.classroom.code) add('-', 'missing-classroom-code', '仅答案文档缺少课堂码，无法确认班级身份');
  if (standalone && document.experiment.homework_id <= 0) add('-', 'missing-homework', '仅答案文档缺少有效作业号');
  if (Number(raw.schema_version) === 2 && !Array.isArray(raw.answers)) add('-', 'answers-shape', 'v2 answers 必须是数组');
  const list = Array.isArray(raw.answers) ? raw.answers : Object.entries(raw.answers || {}).map(([level_id, entry]) => ({
    ...(entry && typeof entry === 'object' ? entry : { answer: entry }), level_id
  }));
  const ids = new Set();
  let covered = 0;
  for (const entry of list) {
    const id = String(entry?.level_id || '');
    const kind = entry?.kind;
    if (!/^L\d{3,6}$/.test(id)) add(id || '-', 'invalid-level-id', '关卡号必须是 L001 这类格式', kind);
    if (ids.has(id)) add(id, 'duplicate-level', '同一实验包含重复关卡号', kind);
    ids.add(id);
    if (!['code', 'choice'].includes(kind)) add(id, 'invalid-kind', '题型必须为 code 或 choice', kind);
    if (entry?.source !== undefined && !fmt.SOURCES.includes(entry.source)) add(id, 'invalid-source', '答案来源不在支持列表中', kind);
    if (entry?.verified !== undefined && typeof entry.verified !== 'boolean') add(id, 'invalid-verified', 'verified 必须是真正的布尔值', kind);
    if (standalone && !String(entry?.task_identifier || '').trim()) add(id, 'missing-identifier', '仅答案关卡缺少平台 task_identifier', kind);
    const answer = fmt.normalizeAnswer(id, entry);
    if (kind === 'code') {
      if (!answer.code) add(id, 'empty', '编程题答案为空', kind);
      else {
        covered += 1;
        if (PLACEHOLDER.test(answer.code)) add(id, 'placeholder', '编程题答案仍含占位文本', kind);
      }
      if (Number(raw.schema_version) === 2 && (typeof entry.answer !== 'object' || Array.isArray(entry.answer) || !entry.answer || typeof entry.answer.code !== 'string')) add(id, 'code-shape', 'v2 编程答案必须为 answer: { language, code }', kind);
    } else if (kind === 'choice') {
      if (!answer.questions.length) add(id, 'empty', '选择题答案为空', kind);
      else covered += 1;
      const rawQuestions = entry.answer?.questions || entry.questions || (Array.isArray(entry.answer) ? entry.answer : null);
      if (Number(raw.schema_version) === 2 && !Array.isArray(entry.answer?.questions)) add(id, 'choice-shape', 'v2 选择答案必须为 answer: { questions: [...] }', kind);
      const numbers = new Set();
      for (const question of Array.isArray(rawQuestions) ? rawQuestions : answer.questions) {
        const number = Number(question?.number);
        if (!Number.isInteger(number) || number <= 0) add(id, 'invalid-question-number', '选择题题号必须为正整数', kind);
        if (numbers.has(number)) add(id, 'duplicate-question', `第 ${number} 问题号重复`, kind);
        numbers.add(number);
        const selected = question?.selected;
        if (!Array.isArray(selected) || !selected.length || selected.some((letter) => typeof letter !== 'string' || !/^[A-H]$/.test(letter))) add(id, 'invalid-selection', `第 ${number} 问必须包含非空 A–H 选项数组`, kind);
      }
    }
  }
  for (const entry of document.unanswered) {
    if (ids.has(entry.level_id)) add(entry.level_id, 'answer-unanswered-conflict', '同一关同时出现在 answers 和 unanswered');
    else if (standalone) add(entry.level_id, 'missing', entry.reason || '该关仍未作答');
  }
  if (!list.length && !document.unanswered.length) add('-', 'empty-document', '答案文档没有任何关卡');
  return { ok: issues.length === 0, total: list.length + document.unanswered.length, covered, issues, document };
}

module.exports = { validateAnswers, validateAnswerList, validateAnswerDocument };
