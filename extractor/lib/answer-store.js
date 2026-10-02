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
 * - AI 作答：模型产出后写入（`answerer.js`）。
 *
 * 规则：同一 `level_id` 覆盖，其它关卡原样保留——AI 写过的、人工改过的都不会被一次导出抹掉。
 *
 * ## 班级一致性（安全闸）
 *
 * 如果文件里已经写着某个课堂码，而本次写入的课堂码不同，**直接报错**而不是覆盖。
 * 那说明文件被放错了目录（或调用方拿错了班级），继续写会把两个班的答案混在一起。
 */

const fs = require('node:fs/promises');
const path = require('node:path');

const fmt = require('./answer-format');

/** 答案文件的规范位置（v2）。 */
function answerPathFor(exportRoot, classroom, experiment) {
  return fmt.answerPathFor(exportRoot, classroom, experiment);
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
      answer: String(row.standard_answer ?? row.actual_output ?? '')
    }))
    .filter((row) => row.position > 0 && row.answer)
    .map((row) => `${row.position}:${row.answer}`)
    .join(';');
}

/** 读一个答案文件并升级到 v2；不存在 / 坏文件 / 版本太新都返回 null。 */
async function readAnswerDocument(answerPath) {
  try {
    return fmt.normalizeDocument(JSON.parse(await fs.readFile(answerPath, 'utf8')));
  } catch {
    return null;
  }
}

/**
 * 读该实验的答案文档：**优先 v2 位置，其次 v1 旧位置**。
 * @returns {Promise<{document: object, path: string, legacy: boolean}|null>}
 */
async function loadAnswerDocument(exportRoot, classroom, experiment) {
  const current = fmt.answerPathFor(exportRoot, classroom, experiment);
  const legacy = fmt.legacyAnswerPathFor(exportRoot, classroom, experiment);
  for (const [target, isLegacy] of [[current, false], [legacy, true]]) {
    const document = await readAnswerDocument(target);
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
    return entry;
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
async function mergeAnswers({ exportRoot, classroom, experiment, entries, model }) {
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

  const existing = await loadAnswerDocument(exportRoot, classroomBlock, experimentBlock);
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

  const document = existing ? existing.document : fmt.emptyDocument(classroomBlock, experimentBlock);
  if (classroomBlock.code) document.classroom = classroomBlock;
  if (experimentBlock.homework_id) document.experiment = experimentBlock;
  document.generated_at = new Date().toISOString();
  document.model = document.model || model || '';

  const replaced = normalized.filter((entry) => mergeEntryInto(document, entry)).map((entry) => entry.level_id);
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
  await fs.writeFile(answerPath, text, 'utf8');
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
  levelPassed,
  choiceAnswerText,
  readAnswerDocument,
  loadAnswerDocument,
  mergeAnswer,
  mergeAnswers
};
