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
const fmt = require('./answer-format');

const CLASS_KIND = 'class-answers';
const CLASS_VERSION = 2;

/** 关卡任务 URL → 平台关卡标识（游戏标识），单段式/三段式同口径；解析统一走 answer-format。 */
function identifiersFromSource(source) {
  return [fmt.identifierFromTaskUrl(source)].filter(Boolean);
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
    position: Number((record && record.taskIndex) || 0) || fmt.taskIndexOf(answer.level_id) || undefined,
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
    base.verified = Boolean(answer.verified);
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
    const identity = classroom?.experiments?.find((experiment) => experiment?.answerDoc)?.answerDoc?.classroom || {};
    const block = { name: String(classroom?.name || identity.name || '').trim(), code: String(classroom?.code || identity.code || '').trim(), experiments: [] };
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
      // 只提取答案时没有 levels.jsonl；工作答案本身仍完整记录了关卡身份。
      const included = new Set(levels.map((level) => level.level_id));
      for (const entry of byLevelId.values()) {
        if (!entry.level_id || included.has(entry.level_id)) continue;
        levels.push({ ...levelEntry(null, entry), answered: true });
        included.add(entry.level_id);
      }
      for (const entry of answerDoc?.unanswered || []) {
        if (!entry.level_id || included.has(entry.level_id)) continue;
        levels.push({ level_id: entry.level_id, position: fmt.taskIndexOf(entry.level_id) || undefined, title: '', kind: 'unknown', identifiers: [], answered: false });
        included.add(entry.level_id);
      }
      levels.sort((a, b) => (a.position || 0) - (b.position || 0));
      experimentCount += 1;
      levelCount += levels.length;
      answeredCount += levels.filter((level) => level.answered).length;
      block.experiments.push({
        name: String(experiment?.name || answerDoc?.experiment?.name || '').trim(),
        chapter: String((experiment && experiment.chapter) || '').trim(),
        // homework_id：简易版按答案导航时要拼任务 URL（/tasks/{关卡}?homework_common_id={作业号}）
        homework_id: Number(experiment?.homeworkId || experiment?.homework_id || answerDoc?.experiment?.homework_id || 0) || 0,
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
  if (Number(previous.version) > CLASS_VERSION) throw new Error(`班级答案版本 ${previous.version} 比本工具支持的 ${CLASS_VERSION} 新，拒绝覆盖。`);
  const key = key_;
  const matchedClassrooms = new Set();
  for (const classroom of next.classrooms || []) {
    // 两边有码时必须一致；缺码时只接受唯一同名课堂，避免同名不同班串答案。
    const candidates = (previous.classrooms || []).filter((item) => (
      key(item.code) && key(classroom.code)
        ? key(item.code) === key(classroom.code)
        : key(item.name) === key(classroom.name)
    ));
    const prevClassroom = candidates.length === 1 ? candidates[0] : null;
    if (!prevClassroom) continue;
    matchedClassrooms.add(prevClassroom);
    if (!classroom.code && prevClassroom.code) classroom.code = prevClassroom.code;
    const matchedExperiments = new Set();
    for (const experiment of classroom.experiments || []) {
      const experiments = (prevClassroom.experiments || []).filter((item) => (
        Number(item.homework_id) > 0 && Number(experiment.homework_id) > 0
          ? Number(item.homework_id) === Number(experiment.homework_id)
          : key(item.name) === key(experiment.name)
      ));
      const prevExp = experiments.length === 1 ? experiments[0] : null;
      if (!prevExp) continue;
      matchedExperiments.add(prevExp);
      if (!experiment.homework_id && prevExp.homework_id) experiment.homework_id = prevExp.homework_id;
      const prevByLevel = new Map((prevExp.levels || []).map((l) => [key(l.level_id), l]));
      for (const level of experiment.levels || []) {
        const prevLevel = prevByLevel.get(key(level.level_id));
        if (!prevLevel) continue;
        prevByLevel.delete(key(level.level_id));
        level.identifiers = [...new Set([...(level.identifiers || []), ...(prevLevel.identifiers || [])])];
        level.title = level.title || prevLevel.title;
        level.position = level.position || prevLevel.position;
        if (prevLevel.answered && (!level.answered || (prevLevel.verified && !level.verified))) {
          // 新导出没答案或只有未验证答案时，保留平台已经确认通过的内容。
          for (const field of ['answer', 'kind', 'source', 'verified']) {
            if (prevLevel[field] !== undefined) level[field] = structuredClone(prevLevel[field]);
          }
          level.answered = true;
        }
      }
      experiment.levels.push(...[...prevByLevel.values()].map((level) => structuredClone(level)));
    }
    classroom.experiments.push(...(prevClassroom.experiments || []).filter((item) => !matchedExperiments.has(item)).map((item) => structuredClone(item)));
  }
  next.classrooms.push(...(previous.classrooms || []).filter((item) => !matchedClassrooms.has(item)).map((item) => structuredClone(item)));
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
    answered,
    missing: levels - answered
  };
  return { ok: errors.length === 0, errors, warnings, stats };
}

function key_(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

/** 班级文件的默认落盘路径：exports/answers/{年级}-{班级名}.answers.json */
function classAnswersPathFor(exportRoot, { grade, className }) {
  const safe = (value) => fmt.safeFilePart(value) || '未命名班级';
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
