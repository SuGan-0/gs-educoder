'use strict';

/**
 * AI 自动作答：读关卡存档 → 让模型出答案 → 写进集中的答案目录。
 *
 * ## 契约（见 answer-format.js，那里是唯一事实来源）
 *
 * - 输入：`exports/{班级}/{实验}/{实验}.md`（一个实验一个文件，含每关的「作答格式」）
 * - 输出：`exports/answers/{班级}（{课堂码}）/{实验}.answers.json`
 *
 * ## 模型只需输出最简写法
 *
 * 落盘是结构化的 v2，但**提示词刻意只要求最简写法**——模型对短字符串最不容易出错，
 * 而结构转换是确定性的代码，不该交给模型：
 *
 * ```json
 * { "answers": [ { "level_id": "L001", "kind": "code", "language": "python", "answer": "完整代码" },
 *                { "level_id": "L002", "kind": "choice", "answer": "B" } ],
 *   "unanswered": [ { "level_id": "L005", "reason": "原因" } ] }
 * ```
 *
 * ## 写入走合并，不是重写
 *
 * 旧实现直接重写整份实验答案文件——只重答一关也会把其它关卡（包括人工改过的）覆盖掉。
 * 现在走 `mergeAnswers`：同一 `level_id` 覆盖，其它关卡原样保留，
 * 与抓取端导出、篡改猴回传**共用同一条合并路径**。
 */

const fs = require('node:fs/promises');
const path = require('node:path');

const { readArchive, orderedLevels } = require('./level-store');
const { mergeAnswers, classroomCodeFromDir } = require('./answer-store');
const { validateAnswerList } = require('./answer-validator');
const fmt = require('./answer-format');

const DEFAULT_BASE_URL = 'https://api.deepseek.com/v1';
const DEFAULT_MODEL = 'deepseek-chat';
const DEFAULT_TIMEOUT = 120000;

/** 控制台与答案文件都用的提示词（刻意只要求「关卡题号 + 答案」）。 */
const SYSTEM_PROMPT = [
  '你是头歌（Educoder）实验题的解题助手，需要按给定格式给出每道关卡的答案。',
  '只输出 JSON，不要输出解释、不要复述题目、不要用 Markdown 代码块包裹。',
  '格式：',
  '{',
  '  "answers": [',
  '    { "level_id": "L001", "kind": "code", "language": "python", "answer": "完整代码" },',
  '    { "level_id": "L002", "kind": "choice", "answer": "B" },',
  '    { "level_id": "L003", "kind": "choice", "answer": "1:A;2:B,D" }',
  '  ],',
  '  "unanswered": [ { "level_id": "L005", "reason": "原因" } ]',
  '}',
  '规则：',
  '1. level_id 必须与题目里的「- 关卡 id：」完全一致，一关一条；',
  '2. 编程题给完整可运行代码，保留题目框架与 ########## begin/end ########## 标记，不要改动无关代码；',
  '3. 选择题只给选项字母：多选写成 "A,C"（升序）；一关多个小问写成 "1:A;2:B,D"；',
  '4. 无法确定的关卡放进 unanswered 并说明原因，禁止编造。'
].join('\n');

const USER_PROMPT_HEADER = '下面是这个实验的题目（Markdown），请按上述格式给出全部关卡的答案：';

/** 解析模型返回：容忍被 ```json 围栏包裹、或夹杂前后说明文字的情况。 */
function parseModelJson(text) {
  const raw = String(text || '').trim();
  const candidates = [];
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  if (fence) candidates.push(fence[1]);
  candidates.push(raw);
  const braces = /\{[\s\S]*\}/.exec(raw);
  if (braces) candidates.push(braces[0]);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      /* 试下一个 */
    }
  }
  throw new Error('模型返回的不是合法 JSON');
}

/** 默认模型客户端：OpenAI 兼容的 /chat/completions。 */
async function defaultCallModel({ baseUrl, apiKey, model, system, user, timeout = DEFAULT_TIMEOUT }) {
  if (!apiKey) throw new Error('缺少 API Key');
  const url = `${String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '')}/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: model || DEFAULT_MODEL,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user }
        ],
        temperature: 0,
        response_format: { type: 'json_object' }
      }),
      signal: controller.signal
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`模型接口 HTTP ${response.status}：${text.slice(0, 200)}`);
    const payload = JSON.parse(text);
    const content = payload?.choices?.[0]?.message?.content;
    if (!content) throw new Error(`模型响应里没有内容：${text.slice(0, 200)}`);
    return content;
  } finally {
    clearTimeout(timer);
  }
}

/** 从关卡存档的 `source`（任务页 URL）里取平台关卡标识：**永远是最后一段**。 */
function identifierFromSource(source) {
  const match = /\/tasks\/([^/?#]+(?:\/[^/?#]+)*)/.exec(String(source || ''));
  if (!match) return '';
  const segments = match[1].split('/').filter(Boolean);
  return segments.length ? segments[segments.length - 1] : '';
}

/** 从关卡存档里取「班级 / 实验」的身份（名称会重名，课堂码不会）。 */
function identityFromLevels(levels, fallbackCourse, fallbackExperiment) {
  const first = levels.find(Boolean) || {};
  return {
    classroom: {
      name: first.course || fallbackCourse || '',
      code: first.classroomCode || ''
    },
    experiment: {
      name: first.experiment || fallbackExperiment || '',
      homeworkId: Number(first.experimentHomeworkId) || 0
    }
  };
}

/** 列出「可以出答案」的班级/实验/关卡（来自 exports 下的关卡存档）。 */
async function listTargets(exportRoot) {
  const courses = [];
  let courseDirs = [];
  try {
    courseDirs = await fs.readdir(exportRoot, { withFileTypes: true });
  } catch {
    return courses;
  }
  for (const courseDir of courseDirs) {
    if (!courseDir.isDirectory() || courseDir.name === 'answers') continue;
    const coursePath = path.join(exportRoot, courseDir.name);
    const experiments = [];
    for (const experimentDir of await fs.readdir(coursePath, { withFileTypes: true })) {
      if (!experimentDir.isDirectory()) continue;
      const dir = path.join(coursePath, experimentDir.name);
      let levels = [];
      try {
        levels = orderedLevels((await readArchive(path.join(dir, 'levels.jsonl'))).records);
      } catch {
        continue;
      }
      if (!levels.length) continue;
      const identity = identityFromLevels(levels, courseDir.name, experimentDir.name);
      // 先映射（含作业号 / 课堂码提取），再算实验级 homeworkId——顺序反了会拿到 0（10-11 实测）
      const mappedLevels = levels.map((level) => ({
        taskIndex: Number(level.taskIndex) || 0,
        id: fmt.levelIdOf(level.taskIndex),
        title: level.title || '',
        type: level.type || '',
        language: level.codeLanguage || '',
        taskIdentifier: level.source ? identifierFromSource(level.source) : '',
        // 作业号也在 source 的查询串里：班级答案文件按它拼任务 URL（/tasks/{关卡}?homework_common_id={作业号}）
        homeworkCommonId: level.source
          ? (String(level.source).match(/[?&]homework_common_id=(\d+)/)?.[1] || '')
          : '',
        // 课堂码在三段式 source 的第一段（/tasks/{课堂码}/{作业号}/{关卡标识}）——
        // 存档记录本身没有这个字段，班级文件的课堂码只能从这里来（10-11 实测）
        classroomCode: level.source
          ? (String(level.source).match(/\/tasks\/([^/?#]+)\/\d+\//)?.[1] || '')
          : ''
      }));
      const homeworkFromLevels = mappedLevels
        .map((level) => Number(level.homeworkCommonId) || 0)
        .find((value) => value > 0) || 0;
      // 课堂码三路兜底：存档字段 / 三段式 source → **已有 v2 目录名** → 空。
      // 最后那一路不是可有可无：早期抓的存档没有 `classroomCode`，只靠前两路会算出一个
      // **没有班级码**的路径（`answers/{班级}/…`），与真实位置 `answers/{班级}（{码}）/…` 对不上，
      // 只能靠回退 v1 扁平文件兜住——于是「答案迁到 v2 了却读不回来，旧文件也不敢删」。
      // 目录名本身就是课堂码的持久记录（`answerDirFor` 写进去的），读的时候必须认它。
      const classroomCode = identity.classroom.code
        || mappedLevels.map((level) => level.classroomCode).find(Boolean)
        || await classroomCodeFromDir(exportRoot, identity.classroom.name)
        || '';
      const classroom = { name: identity.classroom.name, code: classroomCode };
      // 答案文件位置：**v2 优先，不存在则回退 v1 扁平文件**。
      // 少了这步回退，只写过 v1 的实验会被当成「没有答案」——实测重新导出班级答案文件时
      // 有答案的关卡从 102 掉到 16（86 条答案静默丢失），控制台的「已有答案几关」也会显示 0。
      // 两处位置的口径必须与控制台 `/api/answers`（v2 优先、v1 兜底）一致。
      let answerPath = fmt.answerPathFor(exportRoot, classroom, identity.experiment);
      const legacyPath = fmt.legacyAnswerPathFor(exportRoot, classroom, identity.experiment);
      try {
        await fs.access(answerPath);
      } catch {
        try {
          await fs.access(legacyPath);
          answerPath = legacyPath;
        } catch { /* 两个位置都没有：保留 v2 路径，后续报「缺答案」时指的就是它 */ }
      }
      let answered = 0;
      try {
        const parsed = fmt.normalizeDocument(JSON.parse(await fs.readFile(answerPath, 'utf8')), {
          classroom,
          experiment: { name: identity.experiment.name, homeworkId: identity.experiment.homeworkId }
        });
        answered = parsed.answers.filter((item) => item.level_id).length;
      } catch {
        answered = 0;
      }
      experiments.push({
        name: experimentDir.name,
        directory: dir,
        answerPath,
        classroom,
        homeworkId: identity.experiment.homeworkId || homeworkFromLevels,
        levelCount: mappedLevels.length,
        answered,
        levels: mappedLevels
      });
    }
    if (experiments.length) {
      courses.push({ name: courseDir.name, directory: coursePath, experiments });
    }
  }
  return courses.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
}

/** 取某个实验的题目 Markdown（视图文件；没有就按存档现场渲染，避免依赖预生成）。 */
async function readExperimentMarkdown(experimentDirectory, experimentName, courseName) {
  const markdownPath = path.join(experimentDirectory, `${experimentName}.md`);
  try {
    return await fs.readFile(markdownPath, 'utf8');
  } catch {
    const { makeLevelSection, makeExperimentDocument } = require('./task-parser');
    const levels = orderedLevels((await readArchive(path.join(experimentDirectory, 'levels.jsonl'))).records);
    return makeExperimentDocument({
      course: courseName,
      experiment: experimentName,
      generatedAt: new Date().toISOString(),
      levels: levels.map((level) => makeLevelSection(level))
    });
  }
}

/**
 * 给一个实验出答案。
 *
 * @returns {Promise<{ok:boolean, answerPath:string, answered:number, total:number,
 *   issues:Array, unanswered:Array, replaced:string[], skipped:Array}>}
 */
async function answerExperiment({
  exportRoot,
  course,
  experiment,
  apiKey,
  baseUrl,
  model,
  onlyLevelIds = null,
  callModel = defaultCallModel,
  log = () => {}
}) {
  const directory = path.join(exportRoot, course, experiment);
  const levels = orderedLevels((await readArchive(path.join(directory, 'levels.jsonl'))).records);
  if (!levels.length) throw new Error(`实验「${experiment}」没有关卡存档（先抓取，或用 tools/build-exports.js 生成）`);
  const identity = identityFromLevels(levels, course, experiment);
  // 存档没有 classroomCode 时，从已有 v2 目录名认码。**写入侧也必须认**：
  // 否则答案会被写进「没有班级码」的目录（`answers/{班级}/…`），而读取侧认的是带码的目录，
  // 等于写了一份谁也不会读到的答案。
  if (!identity.classroom.code) {
    identity.classroom.code = await classroomCodeFromDir(exportRoot, identity.classroom.name);
  }

  const wanted = onlyLevelIds && onlyLevelIds.length
    ? levels.filter((level) => onlyLevelIds.includes(fmt.levelIdOf(level.taskIndex)))
    : levels;
  const markdown = (await readExperimentMarkdown(directory, experiment, course))
    // 若开启了 EDUCODER_INLINE_IMAGES，md 里会有 `data:image/...;base64,...` 的图片；
    // 文本模型既看不懂又会被撑爆 token，这里一律替换成占位，只告诉模型「这里有图」。
    .replace(/!\[([^\]]*)\]\(data:[^)]*\)/g, '（图片：$1）');

  log(`正在让模型作答：${course} / ${experiment}（${wanted.length} 关）`);
  const content = await callModel({
    baseUrl,
    apiKey,
    model,
    system: SYSTEM_PROMPT,
    user: `${USER_PROMPT_HEADER}\n\n（只作答以下关卡：${wanted.map((level) => fmt.levelIdOf(level.taskIndex)).join('、')}）\n\n${markdown}`
  });
  const parsed = parseModelJson(content);

  const rawList = Array.isArray(parsed.answers) ? parsed.answers : Object.values(parsed.answers || {});
  const entries = [];
  for (const item of rawList) {
    if (!item || !item.level_id) continue;
    const level = wanted.find((candidate) => fmt.levelIdOf(candidate.taskIndex) === String(item.level_id));
    if (!level) continue; // 模型多答了不在范围内的关卡：丢弃
    entries.push({
      levelId: String(item.level_id),
      kind: item.kind || (level.type === fmt.KINDS.CHOICE ? fmt.KINDS.CHOICE : fmt.KINDS.CODE),
      language: item.language || level.codeLanguage,
      answer: item.answer ?? item.code,
      taskIdentifier: level.source ? identifierFromSource(level.source) : '',
      title: level.title || '',
      source: 'ai',
      verified: false
    });
  }

  const saved = await mergeAnswers({
    exportRoot,
    classroom: identity.classroom,
    experiment: identity.experiment,
    entries,
    model: model || DEFAULT_MODEL
  });
  if (!saved.ok) throw new Error(`答案写入失败：${saved.error}`);

  // 立刻自校验：覆盖度 / 题型 / 选项字母 / 占位代码（校验的就是刚写进去的结构）
  const written = fmt.normalizeDocument(JSON.parse(await fs.readFile(saved.answerPath, 'utf8')), identity);
  const report = validateAnswerList(written.answers, wanted);
  log(
    report.ok
      ? `答案已写入：${saved.answerPath}（${report.covered}/${report.total} 关）`
      : `答案已写入但有 ${report.issues.length} 处问题：${saved.answerPath}`,
    report.ok ? 'info' : 'warn'
  );
  return {
    ok: report.ok,
    answerPath: saved.answerPath,
    answered: report.covered,
    total: report.total,
    issues: report.issues,
    unanswered: written.unanswered,
    replaced: saved.replaced,
    skipped: saved.skipped || []
  };
}

module.exports = {
  SYSTEM_PROMPT,
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  parseModelJson,
  defaultCallModel,
  identifierFromSource,
  listTargets,
  answerExperiment
};
