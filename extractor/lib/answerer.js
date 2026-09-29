'use strict';

/**
 * AI 自动作答：读关卡存档 → 让模型出答案 → 写进集中的答案目录。
 *
 * 关键约定（详见 docs/AI-ANSWER-FORMAT.md）：
 * - 输入：`exports/课程/实验/实验.md`（一个实验一个文件，含每关的「作答格式」）
 * - 输出：`exports/answers/{课程}__{实验}.answers.json`
 * - 答案格式最小化：编程题 `{level_id, kind:'code', language, answer}`，
 *   选择题 `{level_id, kind:'choice', answer:'B' | 'A,C' | '1:A;2:B,D'}`
 *
 * 模型调用通过 `callModel` 注入（默认走 OpenAI 兼容的 /chat/completions），
 * 因此离线测试可以直接塞一个假模型，不联网。
 */

const fs = require('node:fs/promises');
const path = require('node:path');

const { readArchive, orderedLevels } = require('./level-store');
const { answerFileName, normalizeAnswer, stringifyAnswer, KINDS } = require('./task-parser');
const { validateAnswerList } = require('./answer-validator');

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

/** 列出「可以出答案」的课程/实验/关卡（来自 exports 下的关卡存档）。 */
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
      const answerPath = path.join(exportRoot, 'answers', `${answerFileName(courseDir.name, experimentDir.name)}.answers.json`);
      let answered = 0;
      try {
        const parsed = JSON.parse(await fs.readFile(answerPath, 'utf8'));
        const list = Array.isArray(parsed.answers) ? parsed.answers : Object.values(parsed.answers || {});
        answered = list.filter((item) => item && item.level_id).length;
      } catch {
        answered = 0;
      }
      experiments.push({
        name: experimentDir.name,
        directory: dir,
        answerPath,
        levelCount: levels.length,
        answered,
        levels: levels.map((level) => ({
          taskIndex: Number(level.taskIndex) || 0,
          id: `L${String(Number(level.taskIndex) || 0).padStart(3, '0')}`,
          title: level.title || '',
          type: level.type || '',
          language: level.codeLanguage || ''
        }))
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
 * @returns {Promise<{ok:boolean, answerPath:string, answered:number, total:number, issues:Array, unanswered:Array}>}
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

  const wanted = onlyLevelIds && onlyLevelIds.length
    ? levels.filter((level) => onlyLevelIds.includes(`L${String(Number(level.taskIndex) || 0).padStart(3, '0')}`))
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
    user: `${USER_PROMPT_HEADER}\n\n（只作答以下关卡：${wanted.map((level) => `L${String(level.taskIndex).padStart(3, '0')}`).join('、')}）\n\n${markdown}`
  });
  const parsed = parseModelJson(content);

  const rawList = Array.isArray(parsed.answers) ? parsed.answers : Object.values(parsed.answers || {});
  const normalized = [];
  for (const item of rawList) {
    if (!item || !item.level_id) continue;
    const level = wanted.find((candidate) => `L${String(Number(candidate.taskIndex) || 0).padStart(3, '0')}` === String(item.level_id));
    if (!level) continue; // 模型多答了不在范围内的关卡：丢弃
    normalized.push(
      normalizeAnswer(String(item.level_id), item, {
        kind: level.type === KINDS.CHOICE ? KINDS.CHOICE : KINDS.CODE,
        language: level.codeLanguage,
        source: level.source
      })
    );
  }

  const answerPath = path.join(exportRoot, 'answers', `${answerFileName(course, experiment)}.answers.json`);
  const document = {
    course,
    experiment,
    generated_at: new Date().toISOString(),
    model: model || DEFAULT_MODEL,
    // 文件里写最简写法（`answer: "B"` / `"1:A;2:B,D"`）：人一眼能看懂，也方便人工修。
    answers: normalized.map((item) => stringifyAnswer(item)),
    unanswered: Array.isArray(parsed.unanswered) ? parsed.unanswered : []
  };
  await fs.mkdir(path.dirname(answerPath), { recursive: true });
  await fs.writeFile(answerPath, JSON.stringify(document, null, 2), 'utf8');

  // 立刻自校验：覆盖度 / 题型 / 选项字母 / 占位代码（校验写进文件的最简写法）
  const report = validateAnswerList(document.answers, wanted);
  log(
    report.ok
      ? `答案已写入：${answerPath}（${report.covered}/${report.total} 关）`
      : `答案已写入但有 ${report.issues.length} 处问题：${answerPath}`,
    report.ok ? 'info' : 'warn'
  );
  return {
    ok: report.ok,
    answerPath,
    answered: report.covered,
    total: report.total,
    issues: report.issues,
    unanswered: document.unanswered
  };
}

module.exports = {
  SYSTEM_PROMPT,
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  parseModelJson,
  defaultCallModel,
  listTargets,
  answerExperiment
};
