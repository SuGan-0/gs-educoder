'use strict';

/**
 * 核对「本地答案」与「关卡存档」是否对得上——**跑队列前先跑这个**。
 *
 * 为什么需要它：篡改猴是按「每道题的选项个数」给选择题分组的，一旦答案的题数与关卡
 * 实际题数不一致，那一关就勾不上（跳过并进缺答案清单）。而这种不一致在答案文件里
 * 是**看不出来**的——它要么是答案过期/挂错实验（实测 5 个实验的 L001 被跨实验串台的
 * 答案污染），要么是答案只答了一部分（实测「McCabe方法」2 道题只答了 1 道）。
 *
 * 与 `validate-answers.js` 的分工：那个查答案本身的格式（覆盖度/题型/字母越界/占位代码），
 * 这个查**答案能不能用在这一关上**（题数是否吻合）。两者互补。
 *
 * 解析刻意**复用篡改猴脚本自己的 `readAnswer`**（在 vm 里加载脚本，与离线单测同一套做法）——
 * 口径必须和真机完全一致，否则「这里说没问题、真机上却对不上」就又白查了。
 *
 * 用法：
 *   node tools/check-answer-fit.js              # 全部课程
 *   node tools/check-answer-fit.js --course=软件工程导论2026年下半年
 * 退出码：有对不上的关卡 → 1。
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const fmt = require(path.join(ROOT, 'extractor', 'lib', 'answer-format'));

/** 在假 DOM 里加载篡改猴脚本，拿回纯函数（与 test/userscript-*.test.js 同一套做法）。 */
function loadUserscriptHooks() {
  const hooks = {};
  const fakeDocument = {
    querySelectorAll: () => [],
    querySelector: () => null,
    getElementById: () => null,
    createElement: () => ({ style: {}, append() {}, addEventListener() {}, setAttribute() {} }),
    head: { append() {} },
    body: { append() {} }
  };
  const sandbox = {
    window: { document: fakeDocument, __educoderAutosubmitTestHooks: hooks },
    document: fakeDocument,
    location: { pathname: '/tasks/000', href: 'https://www.educoder.net/tasks/000' },
    navigator: { userAgent: 'check-answer-fit' },
    URL,
    URLSearchParams,
    console,
    setTimeout,
    clearTimeout,
    GM_getValue: (_key, fallback) => fallback,
    GM_setValue: () => {},
    GM_deleteValue: () => {},
    GM_registerMenuCommand: () => {},
    GM_xmlhttpRequest: () => {}
  };
  sandbox.window.location = sandbox.location;
  vm.createContext(sandbox);
  new vm.Script(fs.readFileSync(path.join(ROOT, 'userscript', 'educoder-autosubmit.user.js'), 'utf8'))
    .runInContext(sandbox);
  if (typeof hooks.readAnswer !== 'function') throw new Error('加载篡改猴脚本失败：拿不到 readAnswer');
  return hooks;
}

/** 读一个实验的存档：每个 taskIndex 取**最后一行**（追加制，最后一行生效）。 */
function readArchive(dir) {
  const file = path.join(dir, 'levels.jsonl');
  if (!fs.existsSync(file)) return null;
  const last = new Map();
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const text = line.trim();
    if (!text) continue;
    let record;
    try { record = JSON.parse(text); } catch { continue; }
    last.set(Number(record.taskIndex) || 0, record);
  }
  return last.size ? last : null;
}

/**
 * 找这个实验的答案文件：v2 位置（按班级分目录）优先，回退 v1 扁平文件。
 * 与控制台 `/api/answers` 的口径一致（它也是 v2 优先、v1 兜底）。
 */
function findAnswerFile(exportRoot, identity) {
  const v2 = fmt.answerPathFor(exportRoot, identity.classroom, identity.experiment);
  if (fs.existsSync(v2)) return v2;
  const v1 = fmt.legacyAnswerPathFor(exportRoot, identity.classroom, identity.experiment);
  if (fs.existsSync(v1)) return v1;
  return null;
}

/**
 * 班级名 → 课堂码，**从已有 v2 目录名（`{班级}（{码}）`）里认**。
 *
 * 早期抓的关卡存档没有 `classroomCode` 字段，只靠它算出的答案路径会缺班级码
 * （`answers/{班级}/…`），与真实位置 `answers/{班级}（{码}）/…` 对不上——
 * 于是明明有 v2 答案却一个都核对不到（`answerer.listTargets` 同样做了这一步）。
 */
function classroomCodesFromDirs(exportRoot) {
  const codes = new Map();
  let entries = [];
  try {
    entries = fs.readdirSync(path.join(exportRoot, 'answers'), { withFileTypes: true });
  } catch {
    return codes;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const parsed = fmt.classroomFromDirName(entry.name);
    if (parsed.code && !codes.has(parsed.name)) codes.set(parsed.name, parsed.code);
  }
  return codes;
}

function main() {
  const courseFilter = (process.argv.find((arg) => arg.startsWith('--course=')) || '').split('=')[1] || '';
  const exportRoot = process.env.EDUCODER_EXPORT_ROOT || path.join(ROOT, 'exports');
  const dirCodes = classroomCodesFromDirs(exportRoot);
  const { readAnswer } = loadUserscriptHooks();

  const problems = [];
  const missing = [];
  let checked = 0;
  let codeLevels = 0;
  let files = 0;
  let filesSkipped = 0;

  const courses = fs.readdirSync(exportRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'answers' && entry.name !== 'logs')
    .map((entry) => entry.name)
    .filter((name) => !courseFilter || name === courseFilter);

  for (const course of courses) {
    const courseDir = path.join(exportRoot, course);
    for (const experimentDir of fs.readdirSync(courseDir, { withFileTypes: true })) {
      if (!experimentDir.isDirectory()) continue;
      const dir = path.join(courseDir, experimentDir.name);
      const archive = readArchive(dir);
      if (!archive) continue;

      const first = [...archive.values()][0] || {};
      const classroomName = first.course || course;
      const identity = {
        // 存档没有 classroomCode 时，从已有 v2 目录名认码（否则算出的路径缺班级码、找不到答案文件）
        classroom: { name: classroomName, code: first.classroomCode || dirCodes.get(classroomName) || '' },
        experiment: { name: first.experiment || experimentDir.name }
      };
      const answerFile = findAnswerFile(exportRoot, identity);
      if (!answerFile) { filesSkipped += 1; continue; }

      let document;
      try {
        document = fmt.normalizeDocument(JSON.parse(fs.readFileSync(answerFile, 'utf8')), identity);
      } catch { filesSkipped += 1; continue; }
      files += 1;
      const byLevel = new Map(document.answers.map((item) => [String(item.level_id), item]));

      for (const [taskIndex, record] of [...archive.entries()].sort((a, b) => a[0] - b[0])) {
        const levelId = fmt.levelIdOf(taskIndex);
        const questions = Array.isArray(record.choiceQuestions) ? record.choiceQuestions : [];
        if (record.type !== 'choice' || !questions.length) { codeLevels += 1; continue; }
        const entry = byLevel.get(levelId);
        if (!entry) {
          missing.push({ course, experiment: experimentDir.name, levelId, title: record.title });
          continue;
        }
        // 控制台发给篡改猴之前会走一次 toDocumentEntry（把扁平结构包成 `answer:{questions}`），
        // 这里必须同口径，否则 readAnswer 永远解析出 0 道题。
        const parsed = readAnswer(fmt.toDocumentEntry(entry));
        const got = parsed && parsed.kind === 'choice' ? Object.keys(parsed.map).length : 0;
        checked += 1;
        if (got !== questions.length) {
          problems.push({
            course,
            experiment: experimentDir.name,
            levelId,
            title: record.title,
            expect: questions.length,
            sizes: questions.map((question) => (question.options || []).length).join('+'),
            got,
            file: path.relative(ROOT, answerFile)
          });
        }
      }
    }
  }

  console.log(`扫描 ${files} 份答案文件（跳过 ${filesSkipped} 个没有答案文件的实验）`);
  console.log(`核对选择题 ${checked} 关；非选择题 ${codeLevels} 关（本工具不管）；有答案条目但没核对到的另计`);
  console.log('');

  if (problems.length) {
    console.log(`✗ 答案用不上（题数与关卡不符）——${problems.length} 关，跑队列时会被跳过：`);
    for (const item of problems) {
      console.log(`   ${item.course} / ${item.experiment}`);
      console.log(`     ${item.levelId} ${item.title}：这一关 ${item.expect} 道题（选项数 ${item.sizes}），`
        + `本地答案解析出 ${item.got} 道`);
      console.log(`     文件：${item.file}`);
    }
    console.log('');
  } else {
    console.log('✓ 没有「答案题数与关卡不符」的关卡。');
    console.log('');
  }

  if (missing.length) {
    console.log(`· 另有 ${missing.length} 关**没有本地答案**（跑队列时也会跳过，属正常缺答案）：`);
    for (const item of missing.slice(0, 20)) {
      console.log(`   ${item.experiment} / ${item.levelId} ${item.title}`);
    }
    if (missing.length > 20) console.log(`   …还有 ${missing.length - 20} 关，详见缺答案清单`);
    console.log('');
  }

  process.exitCode = problems.length ? 1 : 0;
}

main();
