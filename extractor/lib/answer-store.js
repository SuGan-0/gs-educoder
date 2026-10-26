'use strict';

/**
 * 答案文件的落盘与合并（抓取端与控制台共用）。
 *
 * ## 位置（v2）
 *
 * ```text
 * exports/answers/{班级名}（{课堂码}）/{实验名}.answers.json
 * ```
 *
 * 按**班级分目录、班级码进目录名**：班级边界因此是结构性的，
 * 而不是靠文件名里的一段字符串。旧位置（扁平目录 + `{课程}__{实验}.answers.json`）
 * 仍然**只读兼容**：读到就升级，但不再往那里写。
 *
 * ## 三个写入来源，一套合并规则
 *
 * - 抓取端：关卡「已通过测评」时导出提交的代码 / 所选项；
 * - 控制台：篡改猴提交通过后回传（`POST /api/answer/save`）；
 * - Agent 作答：读取题目后在本地合并答案，不依赖模型 API。
 *
 * 规则：同一 `level_id` 合并，其它关卡原样保留；未验证答案默认不能覆盖已验证答案。
 *
 * ## 班级一致性（安全闸）
 *
 * 如果文件里已经写着某个课堂码，而本次写入的课堂码不同，**直接报错**而不是覆盖。
 * 那说明文件被放错了目录（或调用方拿错了班级），继续写会把两个班的答案混在一起。
 */

const fs = require('node:fs/promises');
const path = require('node:path');

const fmt = require('./answer-format');
const writeQueues = new Map();

/** 答案文件的规范位置（v2）。 */
function answerPathFor(exportRoot, classroom, experiment) {
  return fmt.answerPathFor(exportRoot, classroom, experiment);
}

/**
 * 从**已存在的答案目录名**里认出课堂码：`answers/{班级}（{码}）/` → `{码}`。
 *
 * 为什么必须有这一步：**写入**时课堂码是调用方给的（篡改猴从关卡页的 `course_identifier`
 * 拿到，很稳），但**读取**时只能从关卡存档的 `classroomCode` 字段推。早期抓的存档没有这个字段，
 * 于是读的时候算出的路径是 `answers/{班级}/{实验}.answers.json`（没班级码），与真实位置
 * `answers/{班级}（{码}）/…` 对不上——以前靠**回退 v1 扁平文件**兜住，结果就是
 * 「答案明明迁到 v2 了，工具却读不回来，旧文件也不敢删」。
 *
 * 目录名本身就是课堂码的持久记录（`answerDirFor` 写进去的），在这里补上这一步，读写才对称。
 */
async function classroomCodeFromDir(exportRoot, classroomName) {
  const wanted = String(classroomName || '').trim();
  if (!wanted) return '';
  let entries = [];
  try {
    entries = await fs.readdir(path.join(exportRoot, 'answers'), { withFileTypes: true });
  } catch {
    return '';
  }
  const codes = new Set();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const parsed = fmt.classroomFromDirName(entry.name);
    if (parsed.code && parsed.name === fmt.safeFilePart(wanted)) codes.add(parsed.code);
  }
  return codes.size === 1 ? [...codes][0] : '';
}

/**
 * 「已通过测评」判定：得分达到满分。
 *
 * 实测（2026-09-28，示例课程A）：
 * - `challenge.score` 是**满分**（编程题 100；选择题每题 10 分，5 题就是 50）；
 * - `game.final_score` 是**得分**：未提交是 0，满分通过才等于满分。
 *
 * 别拿 `test_sets[].output` 判定——那是测试点的**期望输出**，未提交的关卡也可能是「通过」。
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
 * 两者都只在提交后才有：页面加载时的 GET 里是 null。
 */
function choiceAnswerText(payload) {
  const rows = Array.isArray(payload?.choose_test_cases?.test_sets) ? payload.choose_test_cases.test_sets : [];
  return rows
    .slice()
    .sort((a, b) => (Number(a.position) || 0) - (Number(b.position) || 0))
    .map((row) => ({
      position: Number(row.position) || 0,
      answer: String(row.standard_answer ?? '').trim() || String(row.actual_output ?? '').trim()
    }))
    .filter((row) => row.position > 0 && row.answer)
    .map((row) => `${row.position}:${row.answer}`)
    .join(';');
}

/** 读一个答案文件并升级到 v2；不存在 / 坏文件 / 版本太新都返回 null。 */
async function readAnswerDocument(answerPath, { strict = false } = {}) {
  try {
    return fmt.normalizeDocument(JSON.parse(await fs.readFile(answerPath, 'utf8')));
  } catch (error) {
    if (strict && error.code !== 'ENOENT') throw new Error(`无法读取已有答案文件，已保留原文件：${answerPath}（${error.message}）`);
    return null;
  }
}

/**
 * 读该实验的答案文档：**优先 v2 位置，其次 v1 旧位置**。
 * @returns {Promise<{document: object, path: string, legacy: boolean}|null>}
 */
async function loadAnswerDocument(exportRoot, classroom, experiment, options = {}) {
  const current = fmt.answerPathFor(exportRoot, classroom, experiment);
  const legacy = fmt.legacyAnswerPathFor(exportRoot, classroom, experiment);
  for (const [target, isLegacy] of [[current, false], [legacy, true]]) {
    const document = await readAnswerDocument(target, options);
    if (document) return { document, path: target, legacy: isLegacy };
  }
  return null;
}

/** 去掉时间戳再比较：内容没变就不该反复写文件。 */
function stripGeneratedAt(text) {
  return String(text).replace(/"generated_at":\s*"[^"]*"/, '"generated_at":""');
}

/** 把一条已规范化的答案并入文档；返回是覆盖还是新增。 */
function mergeEntryInto(document, entry) {
  let replaced = false;
  document.answers = document.answers.map((item) => {
    if (String(item.level_id) !== entry.level_id) return item;
    replaced = true;
    return {
      ...entry,
      task_identifier: entry.task_identifier || item.task_identifier,
      title: entry.title || item.title,
      ...(entry.kind === fmt.KINDS.CODE ? { language: entry.language || item.language || '' } : {})
    };
  });
  if (!replaced) document.answers.push(entry);
  document.unanswered = document.unanswered.filter((item) => String(item.level_id) !== entry.level_id);
  return replaced;
}

/**
 * 把**一批**答案合并进答案文件（v2），一次读、一次写。
 *
 * 为什么要有批量版：AI 作答一次就是一个实验的几十关。逐条调用单条版会
 * 「读全文 → 写全文」几十遍（O(N²) 写放大），而且中途失败会留下写了一半的实验。
 *
 * @param {{exportRoot:string, classroom:object|string, experiment:object|string,
 *          entries:Array<object>, model?:string}} options
 * @returns {Promise<{ok:boolean, error?:string, answerPath?:string, count?:number,
 *   changed?:boolean, legacyUpgraded?:boolean, replaced?:string[], skipped?:Array}>}
 */
async function mergeAnswersUnlocked({ exportRoot, classroom, experiment, entries, model, overwriteVerified = false }) {
  const classroomBlock = fmt.classroomBlock(classroom);
  const experimentBlock = fmt.experimentBlock(experiment);
  if (classroomBlock.name === '未命名班级' || experimentBlock.name === '未命名实验') {
    return { ok: false, error: '缺少班级/实验名，无法定位答案文件' };
  }

  const skipped = [];
  const normalized = [];
  for (const raw of Array.isArray(entries) ? entries : []) {
    const id = String(raw?.levelId ?? raw?.level_id ?? '').trim();
    if (!/^L\d{3}$/.test(id)) {
      skipped.push({ levelId: id, reason: `关卡号不合法（应为 L001 这类）：${id || '(空)'}` });
      continue;
    }
    // `verified` 的含义是「平台确认这条答案能过」。抓取端导出与篡改猴回传
    // 都来自**已通过测评**的关卡，所以默认就是已验证；AI 产出默认未验证。
    const source = raw?.source;
    const verified = raw?.verified === undefined
      ? (source === 'platform' || source === 'export')
      : raw.verified;
    const entry = fmt.normalizeAnswer(id, raw, {
      kind: raw?.kind,
      language: raw?.language,
      taskIdentifier: raw?.taskIdentifier,
      title: raw?.title,
      source,
      verified
    });
    const hasAnswer = entry.kind === fmt.KINDS.CHOICE ? entry.questions.length > 0 : Boolean(entry.code);
    if (!hasAnswer) {
      skipped.push({ levelId: id, reason: '答案为空' });
      continue;
    }
    normalized.push(entry);
  }
  if (!normalized.length) {
    return { ok: false, error: '没有可写入的答案', skipped };
  }

  let existing;
  try {
    existing = await loadAnswerDocument(exportRoot, classroomBlock, experimentBlock, { strict: true });
  } catch (error) {
    return { ok: false, error: error.message, skipped };
  }
  const answerPath = fmt.answerPathFor(exportRoot, classroomBlock, experimentBlock);

  // 班级一致性：文件里已有课堂码且与本次不同 → 报错，不覆盖。
  // 说明文件被放错了目录（或调用方拿错了班级），继续写会把两个班的答案混在一起。
  const existingCode = existing?.document?.classroom?.code || '';
  if (existingCode && classroomBlock.code && existingCode !== classroomBlock.code) {
    return {
      ok: false,
      error: `答案文件属于另一个班级（文件里是 ${existingCode}，本次是 ${classroomBlock.code}）：${existing.path}`
    };
  }
  const previousExperiment = existing?.document?.experiment;
  const knownName = (name) => name && name !== '未命名班级' && name !== '未命名实验';
  if (existing && (
    (knownName(existing.document.classroom.name) && existing.document.classroom.name !== classroomBlock.name)
    || (knownName(previousExperiment.name) && previousExperiment.name !== experimentBlock.name)
    || (previousExperiment.homework_id && experimentBlock.homework_id && previousExperiment.homework_id !== experimentBlock.homework_id)
  )) {
    return { ok: false, error: `答案路径发生身份冲突（班级名、实验名或作业号不同），已保留原文件：${existing.path}` };
  }

  const document = existing ? existing.document : fmt.emptyDocument(classroomBlock, experimentBlock);
  if (classroomBlock.code) document.classroom = { ...classroomBlock, id: classroomBlock.id || document.classroom.id };
  if (experimentBlock.homework_id) document.experiment = experimentBlock;
  document.generated_at = new Date().toISOString();
  document.model = document.model || model || '';

  const replaced = [];
  for (const entry of normalized) {
    const previous = document.answers.find((item) => item.level_id === entry.level_id);
    if (previous?.verified && !entry.verified && !overwriteVerified) {
      skipped.push({ levelId: entry.level_id, reason: '已有平台验证通过的答案，未用未验证答案覆盖' });
      continue;
    }
    if (mergeEntryInto(document, entry)) replaced.push(entry.level_id);
  }
  document.answers.sort((a, b) => fmt.taskIndexOf(a.level_id) - fmt.taskIndexOf(b.level_id));
  const count = document.answers.length;
  const text = fmt.stringifyDocument(document);

  // 幂等：内容（除时间戳外）与磁盘一致时**不写盘**。
  // 为什么必须这样：重跑同一门课时，内容没变的关卡本来会被「重新导出」一遍——
  // 文件只有 generated_at 变了，但 mtime/哈希都变，日志里还会打「已导出答案」，
  // 看起来就像工具又把整门课重抓了一遍（实测就是这个现象）。
  if (existing && !existing.legacy) {
    const previous = await fs.readFile(existing.path, 'utf8').catch(() => '');
    if (previous && stripGeneratedAt(previous) === stripGeneratedAt(text)) {
      return { ok: true, answerPath, count, replaced, skipped, changed: false };
    }
  }

  await fs.mkdir(path.dirname(answerPath), { recursive: true });
  const temporaryPath = `${answerPath}.${process.pid}.${require('node:crypto').randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, text, 'utf8');
    await fs.rename(temporaryPath, answerPath);
  } finally {
    await fs.rm(temporaryPath, { force: true });
  }
  return {
    ok: true,
    answerPath,
    count,
    replaced,
    skipped,
    changed: true,
    legacyUpgraded: Boolean(existing && existing.legacy)
  };
}

/** 同一路径的并发回传串行合并，避免后写者丢掉先写者的关卡。 */
async function mergeAnswers(options) {
  const answerPath = fmt.answerPathFor(options.exportRoot, options.classroom, options.experiment);
  const previous = writeQueues.get(answerPath) || Promise.resolve();
  const pending = previous.catch(() => {}).then(() => mergeAnswersUnlocked(options));
  writeQueues.set(answerPath, pending);
  try {
    return await pending;
  } finally {
    if (writeQueues.get(answerPath) === pending) writeQueues.delete(answerPath);
  }
}

/**
 * 合并一条答案（批量版的单条包装，保留给抓取端与篡改猴回传这类「一次一关」的调用方）。
 *
 * @returns {Promise<{ok:boolean, error?:string, answerPath?:string, levelId?:string,
 *   count?:number, replaced?:boolean, changed?:boolean, legacyUpgraded?:boolean}>}
 */
async function mergeAnswer(options) {
  const id = String(options?.levelId ?? '').trim();
  const result = await mergeAnswers({
    ...options,
    entries: [{
      levelId: id,
      kind: options.kind,
      language: options.language,
      answer: options.answer,
      taskIdentifier: options.taskIdentifier,
      title: options.title,
      source: options.source,
      verified: options.verified
    }]
  });
  if (!result.ok) return result;
  return {
    ok: true,
    answerPath: result.answerPath,
    levelId: id,
    count: result.count,
    replaced: result.replaced.includes(id),
    changed: result.changed,
    legacyUpgraded: result.legacyUpgraded
  };
}

module.exports = {
  answerPathFor,
  classroomCodeFromDir,
  levelPassed,
  choiceAnswerText,
  readAnswerDocument,
  loadAnswerDocument,
  mergeAnswer,
  mergeAnswers
};
