'use strict';

/**
 * 答案文档 v2：**唯一事实来源**。
 *
 * ## 为什么要有这个模块
 *
 * 旧格式的答案在四处各有一套解析：
 *   答案文件 ↔ AI 提示词 ↔ 控制台 `/api/answers` ↔ 篡改猴 `readAnswer`。
 * 改一处要四处一起改，改漏就静默出错（历史上真出现过：答案拉到了但一关都用不上）。
 * 现在只有这里定义「答案长什么样」，其余三处都从这里取。
 *
 * ## 硬约束
 *
 * **纯函数**：无 fs / 无网络 / 无 playwright，可离线测试（与 task-parser.js 同口径）。
 *
 * ## v2 相对 v1 改了什么
 *
 * | 项 | v1 | v2 |
 * |---|---|---|
 * | 班级 | 只有「课程名」字符串，且实际是课堂名 | `classroom: { name, code, id }`，**code 是平台课堂码** |
 * | 作业 | `experiment: "CNN"` | `experiment: { name, homework_id }` |
 * | 关卡身份 | 只有 `L001` | 加 `task_identifier`（平台关卡标识，稳定）与 `title` |
 * | 选择题 | 压成字符串 `"1:A;2:B,D"` | `{ questions: [{ number, selected: ["A","C"] }] }` |
 * | 编程题 | `language` + `answer` 字符串 | `answer: { language, code }` |
 * | 来源 | 只有文件级 `model` | 每条带 `source`（ai/manual/platform/export）与 `verified` |
 * | 版本 | 无 | `schema_version: 2` |
 *
 * **v1 仍然能读**（`normalizeDocument` 自动识别并升级），但只写 v2。
 *
 * ## 为什么文件仍然「一个实验一个」
 *
 * 不合并成一个大文件，理由有三条：
 * 1. AI 作答是**逐实验**进行的；单文件每次都要全量重写，并发写与部分失败会被放大；
 * 2. 一个实验写坏了不该影响其它实验；
 * 3. 答案是要人工改的，把几十个实验塞进一个文件就没法看了。
 *
 * 但**目录按班级分**：`exports/answers/{班级}（{课堂码}）/{实验}.answers.json`。
 * 班级边界因此是结构性的，而不是靠文件名里的字符串。
 */

const path = require('node:path');

/** 当前格式版本。读到更大版本时拒绝解析（不猜）。 */
const SCHEMA_VERSION = 2;

const KINDS = { CODE: 'code', CHOICE: 'choice' };

/** 合法来源。`unknown` 只用于兼容读到的旧数据。 */
const SOURCES = ['ai', 'manual', 'platform', 'export', 'unknown'];

class AnswerFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AnswerFormatError';
  }
}

// ------------------------------------------------------------------ 工具

function text(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function pad3(value) {
  return String(Number(value) || 0).padStart(3, '0');
}

/** `taskIndex` → `L001`。 */
function levelIdOf(taskIndex) {
  return `L${pad3(taskIndex)}`;
}

/** `L001` → `1`；不像关卡号时返回 0。 */
function taskIndexOf(levelId) {
  const match = /^L(\d{1,6})$/i.exec(text(levelId));
  return match ? Number(match[1]) : 0;
}

/** 文件名安全化：非法字符换全角波浪线，避免不同班级/实验撞名。 */
function safeFilePart(value) {
  return text(value).replace(/[\\/:*?"<>|]/g, '～').trim() || 'untitled';
}

/**
 * `{班级}（{课堂码}）` 目录名 → `{ name, code }`，**是 `answerDirFor` 的逆运算**。
 *
 * 为什么需要逆运算：写入时课堂码由调用方给（篡改猴从关卡页的 `course_identifier` 拿到，很稳），
 * 但**读取**时只能从关卡存档的 `classroomCode` 字段推。早期抓的存档没有这个字段，
 * 于是读的时候算出的路径缺班级码、与真实位置对不上，只能靠回退 v1 扁平文件兜住
 * ——「答案迁到 v2 了却读不回来，旧文件也不敢删」。目录名本身就是课堂码的持久记录，
 * 读的时候必须能把它认回来。
 *
 * 不含 `（…）` 时 `code` 为空（旧产物可能没有码）；班级名里本身带 `（…）` 也认（取最后一组）。
 */
function classroomFromDirName(dirName) {
  const match = /^(.*)（([^（）]*)）$/.exec(text(dirName));
  return match ? { name: match[1].trim(), code: match[2].trim() } : { name: text(dirName), code: '' };
}

// -------------------------------------------------------- 选择题答案解析

/**
 * 把最简写法解析成结构化的小问数组。
 *
 * 接受（**模型只需输出这些**）：
 * - `"A"`            单题单选
 * - `"A,C"`          单题多选
 * - `"1:A;2:B,D"`    多个小问（题号从 1 开始，分号分隔）
 *
 * 也接受已经结构化的 `[{ number, selected }]` 与 `{ questions: [...] }`。
 */
function parseChoiceAnswer(raw) {
  const pushLetters = (questions, number, value) => {
    const letters = (Array.isArray(value) ? value : String(value ?? '').split(/[,，、\s]+/))
      .map((token) => text(token).toUpperCase())
      // 只收集「字母」：范围是否合法（超过选项数）交给 answer-validator 报，
      // 这里早了会把模型写的非法字母静默吞掉，用户就看不到问题。
      .filter((token) => /^[A-Z]+$/.test(token))
      .flatMap((token) => token.split(''))
      .filter(Boolean);
    if (letters.length) {
      questions.push({ number: Number(number) || questions.length + 1, selected: [...new Set(letters)].sort() });
    }
  };

  // 已结构化
  const structured = Array.isArray(raw) ? raw : Array.isArray(raw?.questions) ? raw.questions : null;
  if (structured) {
    const questions = [];
    for (const item of structured) {
      if (item && typeof item === 'object') pushLetters(questions, item.number, item.selected ?? item.answer);
    }
    return questions;
  }

  const body = typeof raw === 'object' && raw !== null ? raw.answer : raw;
  const value = text(body);
  if (!value) return [];

  const questions = [];
  if (/[;；]/.test(value) || /^\d+\s*[:：]/.test(value)) {
    for (const part of value.split(/[;；]+/)) {
      const match = /^\s*(\d+)\s*[:：]\s*(.+)$/.exec(part);
      if (match) pushLetters(questions, match[1], match[2]);
    }
  } else {
    pushLetters(questions, 1, value);
  }
  return questions;
}

/** 结构化小问 → 最简写法（回传给模型/人工看时用）。 */
function formatChoiceAnswer(questions) {
  const list = Array.isArray(questions) ? questions : [];
  if (!list.length) return '';
  const single = list.length === 1 && Number(list[0].number) === 1;
  if (single) return (list[0].selected || []).join(',');
  return list
    .slice()
    .sort((a, b) => Number(a.number) - Number(b.number))
    .map((item) => `${Number(item.number)}:${(item.selected || []).join(',')}`)
    .join(';');
}

// ------------------------------------------------------------ 条目规范化

/**
 * 规范化一条答案。
 *
 * @param {string} levelIdValue `L001`
 * @param {object|string} raw  模型输出 / 旧文件条目 / 平台回传
 * @param {{kind?:string, language?:string, taskIdentifier?:string, title?:string,
 *          source?:string, verified?:boolean}} [fallback]
 * @returns {object} 内部结构（与 v2 落盘结构一致，`answer` 字段除外）
 */
function normalizeAnswer(levelIdValue, raw, fallback = {}) {
  const id = text(levelIdValue);
  const entry = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : { answer: raw };
  const nested = entry.answer && typeof entry.answer === 'object' ? entry.answer : null;
  const kind = text(entry.kind || fallback.kind || '')
    || (entry.questions || entry.answers || nested?.questions ? KINDS.CHOICE : KINDS.CODE);

  const base = {
    level_id: id,
    task_identifier: text(entry.task_identifier || fallback.taskIdentifier),
    title: text(entry.title || fallback.title),
    kind: kind === KINDS.CHOICE ? KINDS.CHOICE : KINDS.CODE,
    source: SOURCES.includes(text(entry.source)) ? text(entry.source) : (fallback.source || 'unknown'),
    verified: entry.verified === undefined ? Boolean(fallback.verified) : Boolean(entry.verified)
  };

  if (base.kind === KINDS.CHOICE) {
    // 兼容 v1 的 `answers: [{ question, answer: [...] }]`
    const legacy = Array.isArray(entry.answers) ? entry.answers : null;
    const questions = legacy
      ? legacy.flatMap((item) => (item && typeof item === 'object'
        ? parseChoiceAnswer([{ number: item.question, selected: item.answer }])
        : []))
      : parseChoiceAnswer(nested || entry);
    return { ...base, questions };
  }

  return {
    ...base,
    language: text(entry.language || nested?.language || fallback.language),
    code: text(nested ? nested.code : (entry.answer ?? entry.code))
  };
}

/** 内部结构 → v2 落盘结构。 */
function toDocumentEntry(answer) {
  const base = {
    level_id: text(answer.level_id),
    task_identifier: text(answer.task_identifier),
    title: text(answer.title),
    kind: answer.kind === KINDS.CHOICE ? KINDS.CHOICE : KINDS.CODE,
    source: SOURCES.includes(text(answer.source)) ? text(answer.source) : 'unknown',
    verified: Boolean(answer.verified)
  };
  if (base.kind === KINDS.CHOICE) {
    return {
      ...base,
      answer: {
        questions: (Array.isArray(answer.questions) ? answer.questions : []).map((item) => ({
          number: Number(item.number) || 1,
          selected: [...(item.selected || [])]
        }))
      }
    };
  }
  return { ...base, answer: { language: text(answer.language), code: text(answer.code) } };
}

// -------------------------------------------------------------- 文档

/** 班级标识块。`code` 是平台课堂码（`course_identifier`），也是油猴核对班级的依据。 */
function classroomBlock(classroom) {
  const source = typeof classroom === 'string' ? { name: classroom } : (classroom || {});
  return {
    name: text(source.name) || '未命名班级',
    code: text(source.code || source.classroomCode),
    id: Number.isFinite(Number(source.id)) && Number(source.id) > 0 ? Number(source.id) : 0
  };
}

function experimentBlock(experiment) {
  const source = typeof experiment === 'string' ? { name: experiment } : (experiment || {});
  return {
    name: text(source.name) || '未命名实验',
    homework_id: Number.isFinite(Number(source.homeworkId ?? source.homework_id))
      ? Number(source.homeworkId ?? source.homework_id)
      : 0
  };
}

/**
 * 规范化整份答案文档（v1 会被升级成 v2）。
 *
 * @param {object} raw
 * @param {{classroom?: object|string, experiment?: object|string}} [fallback]
 *        文件里缺班级/实验时用调用方提供的补上（目录名里就有）。
 * @throws {AnswerFormatError} 版本比本工具新时拒绝解析——不猜未来格式。
 */
function normalizeDocument(raw, fallback = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AnswerFormatError('答案文件不是一个 JSON 对象。');
  }
  const version = Number(raw.schema_version);
  if (Number.isFinite(version) && version > SCHEMA_VERSION) {
    throw new AnswerFormatError(
      `答案文件版本 ${version} 比本工具支持的 ${SCHEMA_VERSION} 新，请升级工具后再读。`
    );
  }

  const classroom = classroomBlock(raw.classroom || raw.course || fallback.classroom);
  const experiment = experimentBlock(raw.experiment || fallback.experiment);

  // v1 的 answers 既可能是数组，也可能是以关卡号为键的对象
  const rawAnswers = raw.answers;
  const list = Array.isArray(rawAnswers)
    ? rawAnswers
    : rawAnswers && typeof rawAnswers === 'object'
      ? Object.entries(rawAnswers).map(([key, value]) => ({ ...(value || {}), level_id: value?.level_id || key }))
      : [];

  // v1 没有逐条 source，只有文件级 `model`。按它的取值推断：
  // 抓取端导出的写 'export'，其余是模型产出的。
  const fileSource = text(raw.model) === 'export'
    ? 'export'
    : text(raw.model) ? 'ai' : 'unknown';

  const answers = list
    .filter((item) => item && (item.level_id || item.answer !== undefined))
    .map((item) => normalizeAnswer(item.level_id, item, {
      // v1 的 `language` 在条目上；选择题没有
      kind: item.kind,
      language: item.language,
      source: item.source || fileSource
    }))
    .filter((item) => item.level_id);

  const unanswered = (Array.isArray(raw.unanswered) ? raw.unanswered : [])
    .map((item) => ({
      level_id: text(item?.level_id),
      reason: text(item?.reason)
    }))
    .filter((item) => item.level_id);

  return {
    schema_version: SCHEMA_VERSION,
    classroom,
    experiment,
    generated_at: text(raw.generated_at) || new Date(0).toISOString(),
    model: text(raw.model),
    answers,
    unanswered
  };
}

/** 空文档（新建时用）。 */
function emptyDocument(classroom, experiment) {
  return {
    schema_version: SCHEMA_VERSION,
    classroom: classroomBlock(classroom),
    experiment: experimentBlock(experiment),
    generated_at: new Date(0).toISOString(),
    model: '',
    answers: [],
    unanswered: []
  };
}

/** 内部文档 → 落盘 JSON 文本。 */
function stringifyDocument(document) {
  const payload = {
    schema_version: SCHEMA_VERSION,
    classroom: classroomBlock(document.classroom),
    experiment: experimentBlock(document.experiment),
    generated_at: text(document.generated_at),
    model: text(document.model),
    answers: (document.answers || []).map(toDocumentEntry),
    unanswered: (document.unanswered || []).map((item) => ({
      level_id: text(item.level_id),
      reason: text(item.reason)
    }))
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

// ------------------------------------------------------- 路径与文件名

/**
 * 答案目录：**按班级分目录，班级码进目录名**。
 *
 *   `exports/answers/{班级名}（{课堂码}）/`
 *
 * 班级码缺失时退化成只有班级名（旧产物可能没有码）。
 */
function answerDirFor(exportRoot, classroom) {
  const block = classroomBlock(classroom);
  const folder = block.code ? `${safeFilePart(block.name)}（${safeFilePart(block.code)}）` : safeFilePart(block.name);
  return path.join(exportRoot, 'answers', folder);
}

/** 单个实验的答案文件路径（v2 位置）。 */
function answerPathFor(exportRoot, classroom, experiment) {
  const name = safeFilePart(experimentBlock(experiment).name);
  return path.join(answerDirFor(exportRoot, classroom), `${name}.answers.json`);
}

/**
 * v1 的旧位置（扁平目录 + `{课程}__{实验}.answers.json`）。
 * 只用于**只读兼容**：读到就升级，不往这里写。
 */
function legacyAnswerPathFor(exportRoot, classroom, experiment) {
  const block = classroomBlock(classroom);
  const name = `${safeFilePart(block.name)}__${safeFilePart(experimentBlock(experiment).name)}`;
  return path.join(exportRoot, 'answers', `${name}.answers.json`);
}

module.exports = {
  SCHEMA_VERSION,
  KINDS,
  SOURCES,
  AnswerFormatError,
  levelIdOf,
  taskIndexOf,
  safeFilePart,
  classroomFromDirName,
  parseChoiceAnswer,
  formatChoiceAnswer,
  normalizeAnswer,
  toDocumentEntry,
  classroomBlock,
  experimentBlock,
  normalizeDocument,
  emptyDocument,
  stringifyDocument,
  answerDirFor,
  answerPathFor,
  legacyAnswerPathFor
};
