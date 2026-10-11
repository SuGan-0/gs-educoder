'use strict';

/**
 * 班级答案文件（version 2，kind: "class-answers"）。
 *
 * 用户定的标准：**一个班级只有一份答案文件**，装这个班所有课堂 × 所有实验 × 所有关卡，
 * 供篡改猴「简易版」导入后完全脱离控制台独立作答。
 *
 * 与工作层的关系：`answer-store.js` 的 per-experiment 文件仍是 AI 作答 / 标准答案回传的
 * 工作粒度；本模块把它们的**汇总**成班级文件（追加式合并，旧答案不丢）。
 *
 * 层级：class → classrooms[] → experiments[] → levels[]
 * 每关带 `identifiers[]`（平台关卡标识，篡改猴匹配的第一优先级）与 `challenge_id`
 * （挑战数字 id，任务 payload 里的稳定身份），二者是解耦后对得上关的命门。
 */

const path = require('node:path');

const CLASS_KIND = 'class-answers';
const CLASS_VERSION = 2;

/** 关卡任务 URL → 平台关卡标识（游戏标识）。
 *  两种形态与 ExtractEngine.identifierFromTaskUrl 同口径：
 *  - 旧形态 `/tasks/{关卡标识}?homework_common_id=…`
 *  - 三段式 `/tasks/{课程码}/{作业号}/{关卡标识}`（只有最后一段是关卡标识）
 */
function identifiersFromSource(source) {
  const raw = String(source || '').match(/\/tasks\/([^/?#]+(?:\/[^/?#]+)*)/)?.[1] || '';
  const segments = raw.split('/').filter(Boolean);
  if (!segments.length) return [];
  const last = segments[segments.length - 1];
  if (segments.length >= 3) return [last]; // 三段式：前两段是课程码/作业号
  return [last];
}

/** 从一条存档记录 + 一条答案条目，拼出班级文件里的一个关卡对象。 */
function levelEntry(record, answerEntry) {
  const answer = answerEntry || {};
  const kind = answer.kind || (record && record.type) || 'unknown';
  const identifiers = [...identifiersFromSource(record && record.source)];
  // 控制台收集数据时直接给了 taskIdentifier（从 source 提取好的），两种来源都收
  if (record && record.taskIdentifier && !identifiers.includes(record.taskIdentifier)) {
    identifiers.unshift(record.taskIdentifier);
  }
  if (answer.task_identifier && !identifiers.includes(answer.task_identifier)) {
    identifiers.unshift(answer.task_identifier);
  }
  const base = {
    level_id: String((record && record.levelId) || answer.level_id || ''),
    position: Number((record && record.taskIndex) || 0) || undefined,
    title: String((record && record.title) || answer.title || '').trim(),
    kind: kind === 'choice' ? 'choice' : kind === 'code' ? 'code' : 'unknown',
    identifiers
  };
  // 注意形状：normalizeAnswer 的输出是**扁平**的——choice 用 questions[]，code 用 language/code
  if (answerEntry) {
    if (base.kind === 'choice') {
      base.answer = (answer.questions || []).map((q) => ({ number: q.number, selected: q.selected }));
    } else if (base.kind === 'code') {
      base.answer = { language: answer.language || '', code: answer.code || '' };
    }
    if (answer.source) base.source = answer.source;
  }
  return base;
}

/**
 * 汇总出班级文件。输入由调用方（控制台）从磁盘收集：
 * classrooms: [{ name, code, experiments: [{ name, chapter, records, answerDoc }] }]
 *   - records：该实验 levels.jsonl 的原始记录行（含 taskIndex/title/type/source）
 *   - answerDoc：该实验的 v2 答案文档（normalizeDocument 的产物；可为 null = 还没答案）
 */
function buildClassDocument({ grade, className, classrooms }) {
  const doc = {
    version: CLASS_VERSION,
    kind: CLASS_KIND,
    generated_at: new Date().toISOString(),
    class: { grade: String(grade || '').trim(), name: String(className || '').trim() || '未命名班级' },
    classrooms: [],
    stats: {}
  };
  let experimentCount = 0;
  let levelCount = 0;
  let answeredCount = 0;
  const perClassroom = {};

  for (const classroom of classrooms || []) {
    const block = { name: String((classroom && classroom.name) || '').trim(), code: String((classroom && classroom.code) || '').trim(), experiments: [] };
    for (const experiment of (classroom && classroom.experiments) || []) {
      const records = (experiment && experiment.records) || [];
      const answerDoc = (experiment && experiment.answerDoc) || null;
      const byLevelId = new Map(
        ((answerDoc && answerDoc.answers) || []).map((entry) => [String(entry.level_id), entry])
      );
      const levels = records.map((record) => {
        const levelId = String((record && record.levelId) || '');
        const entry = byLevelId.get(levelId) || null;
        const level = levelEntry(record, entry);
        level.answered = Boolean(entry);
        return level;
      });
      experimentCount += 1;
      levelCount += levels.length;
      answeredCount += levels.filter((level) => level.answered).length;
      block.experiments.push({
        name: String((experiment && experiment.name) || '').trim(),
        chapter: String((experiment && experiment.chapter) || '').trim(),
        levels
      });
    }
    perClassroom[block.name] = {
      experiments: block.experiments.length,
      answered: block.experiments.reduce((sum, e) => sum + e.levels.filter((l) => l.answered).length, 0)
    };
    doc.classrooms.push(block);
  }

  doc.stats = {
    classrooms: doc.classrooms.length,
    experiments: experimentCount,
    levels: levelCount,
    answered: answeredCount,
    missing: levelCount - answeredCount,
    perClassroom
  };
  return doc;
}

/** 重算 doc.stats（merge 之后计数会变，必须重算再落盘）。 */
function computeStats(doc) {
  let experimentCount = 0;
  let levelCount = 0;
  let answeredCount = 0;
  const perClassroom = {};
  for (const classroom of doc.classrooms || []) {
    let answeredIn = 0;
    for (const experiment of classroom.experiments || []) {
      experimentCount += 1;
      for (const level of experiment.levels || []) {
        levelCount += 1;
        if (level.answered) { answeredCount += 1; answeredIn += 1; }
      }
    }
    perClassroom[classroom.name] = { experiments: classroom.experiments.length, answered: answeredIn };
  }
  doc.stats = {
    classrooms: doc.classrooms.length,
    experiments: experimentCount,
    levels: levelCount,
    answered: answeredCount,
    missing: levelCount - answeredCount,
    perClassroom
  };
  return doc;
}

/**
 * 合并两份班级文件（已有文件 + 新导出）：按 课堂码/课堂名 → 实验名 → level_id 对齐。
 * 规则：新文件里有答案的关卡**覆盖**旧值；新文件没有的关卡保留旧答案（不丢）。
 */
function mergeClassDocuments(previous, next) {
  if (!previous || previous.kind !== CLASS_KIND) return next;
  const key = (value) => String(value || '').trim();
  const prevByCode = new Map(
    (previous.classrooms || []).map((c) => [key(c.code) || key(c.name), c])
  );
  for (const classroom of next.classrooms || []) {
    const code = key(classroom.code) || key(classroom.name);
    const prevClassroom = prevByCode.get(code);
    if (!prevClassroom) continue;
    const prevByExp = new Map((prevClassroom.experiments || []).map((e) => [key(e.name), e]));
    for (const experiment of classroom.experiments || []) {
      const prevExp = prevByExp.get(key(experiment.name));
      if (!prevExp) continue;
      const prevByLevel = new Map((prevExp.levels || []).map((l) => [key(l.level_id), l]));
      for (const level of experiment.levels || []) {
        const prevLevel = prevByLevel.get(key(level.level_id));
        if (!prevLevel) continue;
        if (!level.answered && prevLevel.answered) {
          // 新导出没这个答案（比如这次没抓到），保留旧答案
          Object.assign(level, prevLevel, { answered: true });
        }
      }
    }
  }
  next.generated_at = new Date().toISOString();
  return computeStats(next);
}

/**
 * 校验班级文件：结构 + identifier 全局唯一 + 覆盖度。
 * @returns {{ok: boolean, errors: string[], warnings: string[], stats: object}}
 */
function validateClassDocument(doc) {
  const errors = [];
  const warnings = [];
  if (!doc || doc.kind !== CLASS_KIND) errors.push(`kind 必须是 ${CLASS_KIND}。`);
  if (!doc || Number(doc.version) > CLASS_VERSION) {
    errors.push(`版本 ${doc && doc.version} 比本工具支持的 ${CLASS_VERSION} 新，请升级工具。`);
  }
  if (!doc || !((doc.class || {}).name)) errors.push('缺少 class.name（班级名）。');

  const idOwners = new Map();
  let levels = 0;
  let answered = 0;
  for (const classroom of (doc && doc.classrooms) || []) {
    if (!key_(classroom.code) && !key_(classroom.name)) errors.push(`课堂缺少 code 与 name。`);
    for (const experiment of classroom.experiments || []) {
      if (!key_(experiment.name)) errors.push(`课堂「${classroom.name}」有实验缺少 name。`);
      for (const level of experiment.levels || []) {
        levels += 1;
        if (level.answered) answered += 1;
        if (level.answered && level.kind === 'choice') {
          // 选择题的"空答案"= 每道题都没有选中项（questions 数组存在但全空选也算空）
          const questions = Array.isArray((level.answer || {}).questions)
            ? level.answer.questions
            : Array.isArray(level.answer)
              ? level.answer
              : [];
          const hasSelection = questions.some((q) => (q.selected || []).length > 0);
          if (!hasSelection) {
            errors.push(`「${experiment.name}」第 ${level.position || '?'} 关（${level.title}）选择题答案为空。`);
          }
        }
        if (level.answered && level.kind === 'code' && !((level.answer || {}).code || '').trim()) {
          errors.push(`「${experiment.name}」第 ${level.position || '?'} 关（${level.title}）代码答案为空。`);
        }
        for (const identifier of level.identifiers || []) {
          if (idOwners.has(identifier) && idOwners.get(identifier) !== `${classroom.name}/${experiment.name}`) {
            warnings.push(
              `关卡标识 ${identifier} 同时出现在 ${idOwners.get(identifier)} 与 ${classroom.name}/${experiment.name}（同一实训被多个作业引用时属正常）。`
            );
          }
          idOwners.set(identifier, `${classroom.name}/${experiment.name}`);
        }
      }
    }
  }
  const stats = {
    classrooms: ((doc && doc.classrooms) || []).length,
    experiments: ((doc && doc.classrooms) || []).reduce((sum, c) => sum + (c.experiments || []).length, 0),
    levels,
    answered
  };
  return { ok: errors.length === 0, errors, warnings, stats };
}

function key_(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

/** 班级文件的默认落盘路径：exports/answers/{年级}-{班级名}.answers.json */
function classAnswersPathFor(exportRoot, { grade, className }) {
  const safe = (value) => String(value || '').replace(/[\\/:*?"<>|]/g, '～').trim() || '未命名班级';
  const name = [grade, className].filter(Boolean).map(safe).join('-');
  return path.join(exportRoot, 'answers', `${name}.answers.json`);
}

module.exports = {
  CLASS_KIND,
  CLASS_VERSION,
  identifiersFromSource,
  levelEntry,
  buildClassDocument,
  mergeClassDocuments,
  validateClassDocument,
  classAnswersPathFor
};
