'use strict';

/**
 * 把**旧格式（v1 扁平文件）**的答案迁移到**当前格式（v2 按班级分目录）**，并清理已迁移的旧文件。
 *
 * 背景：v2 的落盘规则是「只有 v2」，旧位置
 * （`exports/answers/{课程}__{实验}.answers.json`）**只读兼容**——工具读到会升级，但从不删除。
 * 于是迁移做了一半时，磁盘上会同时存在两种文件：v2 目录里有更新的，扁平目录里躺着旧的，
 * 谁也说不清哪个是「现在生效的」。这个工具就是来收尾的：
 *
 *   1. 逐个读旧扁平文件，按 v1→v2 规则升级（`answer-format.normalizeDocument`）；
 *   2. 补齐 v2 才有的字段：`task_identifier` / `title` 从关卡存档（`levels.jsonl`）里取，
 *      `source` / `verified` 由文件级 `model` 推断（export→export/已验证，其余→manual 或 ai）；
 *   3. 写入 v2 位置（走 `answer-store.mergeAnswers`，与抓取端/控制台/篡改猴同一个写入器）；
 *   4. `--cleanup`：旧文件的内容**已被 v2 完整覆盖**时，把它移进 `answers/.legacy-backup/`。
 *
 * **安全默认**：
 * - 只读不写：`--dry-run`（先看一遍会做什么）；
 * - **绝不覆盖已存在的 v2 文件**——平台回传的标准答案与人工修过的条目都比旧文件权威；
 *   v2 已存在时只核对覆盖度，够覆盖才算「可清理」；
 * - 清理是**移动**不是删除：备份留在 `answers/.legacy-backup/`，随时可恢复。
 *
 * 用法：
 *   node tools/migrate-answers.js --dry-run
 *   node tools/migrate-answers.js
 *   node tools/migrate-answers.js --cleanup
 *   node tools/migrate-answers.js --code=Java设计模式2024=n9ijr3s6    # 补课堂码（可多次）
 *
 * 课堂码从哪来（按优先级）：`--code` 覆盖 → 同班级已有的 v2 目录名（`班级（码）`）→
 * 关卡存档里的课堂码 → 班级答案文件（`kind: class-answers`）的 `classrooms[]`。
 * 四路都没有时退化成「只有班级名」的目录——格式本身允许，但篡改猴无法核对班级，日志会提示。
 *
 * 退出码：0 正常；1 有文件迁移失败。
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const fmt = require(path.join(ROOT, 'extractor', 'lib', 'answer-format'));
const store = require(path.join(ROOT, 'extractor', 'lib', 'answer-store'));

/** 取 `--key=value`，可重复（返回数组）。 */
function argsOf(name) {
  const prefix = `--${name}=`;
  return process.argv.filter((arg) => arg.startsWith(prefix)).map((arg) => arg.slice(prefix.length));
}

const hasFlag = (name) => process.argv.includes(`--${name}`);

/** 文件级 `model` → 逐条 `source` / `verified`。 */
function provenanceFromModel(model) {
  const value = String(model || '').trim();
  if (value === 'export') return { source: 'export', verified: true };
  if (value === 'manual') return { source: 'manual', verified: false };
  // `zcode-manual` 是 ZCode（AI）写出来的，README 里也是这么标的——归到 ai。
  if (value) return { source: 'ai', verified: false };
  return { source: 'unknown', verified: false };
}

/** 读 `exports/{课程}/{实验}/levels.jsonl`，给出 `L001 → {title, taskIdentifier, kind, language}`。 */
function readLevelIndex(exportRoot, courseName, experimentName) {
  const file = path.join(exportRoot, courseName, experimentName, 'levels.jsonl');
  const index = new Map();
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return index;
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    const taskIndex = Number(record.taskIndex) || 0;
    if (!taskIndex) continue;
    // 追加制、最后一行生效——与 level-store 的读取口径一致
    index.set(fmt.levelIdOf(taskIndex), {
      title: String(record.title || ''),
      taskIdentifier: record.source ? (String(record.source).match(/\/tasks\/([^/?#]+)/)?.[1] || '') : '',
      kind: record.type === 'choice' ? fmt.KINDS.CHOICE : fmt.KINDS.CODE,
      language: String(record.codeLanguage || '')
    });
  }
  return index;
}

/** 收集「班级名 → 课堂码」的所有已知来源。 */
function collectClassroomCodes(exportRoot, answerDir, overrides) {
  const codes = new Map();
  const remember = (name, code) => {
    if (!name || !code) return;
    if (!codes.has(name)) codes.set(name, code);
  };
  // 明确指定的优先
  for (const [name, code] of overrides) codes.set(name, code);
  // 1) 已有的 v2 目录名
  let names = [];
  try { names = fs.readdirSync(answerDir); } catch { /* 目录不存在：后面按空处理 */ }
  for (const name of names) {
    const full = path.join(answerDir, name);
    if (!fs.statSync(full).isDirectory()) continue;
    const { name: classroomName, code } = fmt.classroomFromDirName(name);
    remember(classroomName, code);
  }
  // 2) 关卡存档里的课堂码
  for (const courseName of names) {
    const full = path.join(exportRoot, courseName);
    if (courseName === 'answers' || !fs.existsSync(full) || !fs.statSync(full).isDirectory()) continue;
    for (const experimentName of fs.readdirSync(full)) {
      const file = path.join(full, experimentName, 'levels.jsonl');
      if (!fs.existsSync(file)) continue;
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line);
          remember(courseName, record.classroomCode || '');
          const fromSource = String(record.source || '').match(/\/tasks\/([^/?#]+)\/\d+\//)?.[1];
          remember(courseName, fromSource || '');
        } catch { /* 坏行跳过 */ }
      }
    }
  }
  // 3) 班级答案文件（kind: class-answers）里的 classrooms[]
  for (const name of names) {
    if (!name.endsWith('.answers.json')) continue;
    let doc;
    try { doc = JSON.parse(fs.readFileSync(path.join(answerDir, name), 'utf8')); } catch { continue; }
    if (!doc || doc.kind !== 'class-answers' || !Array.isArray(doc.classrooms)) continue;
    for (const classroom of doc.classrooms) remember(String(classroom.name || ''), String(classroom.code || ''));
  }
  return codes;
}

/** 当前答案文件里「真正有答案」的关卡号集合。 */
function answeredLevels(document) {
  const set = new Set();
  for (const item of document.answers || []) {
    const usable = item.kind === fmt.KINDS.CHOICE ? (item.questions || []).length > 0 : Boolean(item.code);
    if (usable) set.add(String(item.level_id));
  }
  return set;
}

async function main() {
  const exportRoot = process.env.EDUCODER_EXPORT_ROOT || path.join(ROOT, 'exports');
  const answerDir = path.join(exportRoot, 'answers');
  const dryRun = hasFlag('dry-run');
  const cleanup = hasFlag('cleanup');
  const backupDir = path.join(answerDir, '.legacy-backup');

  const overrides = argsOf('code').map((pair) => {
    const separator = pair.indexOf('=');
    return separator < 0 ? [pair.trim(), ''] : [pair.slice(0, separator).trim(), pair.slice(separator + 1).trim()];
  }).filter(([name, code]) => name && code);

  if (overrides.length) {
    console.log(`课堂码覆盖：${overrides.map(([name, code]) => `${name}=${code}`).join('、')}`);
  }
  const codes = collectClassroomCodes(exportRoot, answerDir, overrides);

  let legacyFiles = [];
  try {
    legacyFiles = fs.readdirSync(answerDir).filter((name) => name.endsWith('.answers.json') && name.includes('__'));
  } catch {
    console.error(`找不到答案目录：${answerDir}`);
    process.exitCode = 1;
    return;
  }
  if (!legacyFiles.length) {
    console.log('没有旧格式（扁平）答案文件，无需迁移。');
    return;
  }

  const rows = [];
  let failed = 0;
  for (const name of legacyFiles) {
    const filePath = path.join(answerDir, name);
    let raw;
    try { raw = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch {
      rows.push({ name, note: '不是合法 JSON，跳过' });
      continue;
    }
    if (raw.kind === 'class-answers') continue; // 班级答案文件不是 v1 单实验答案
    let legacy;
    try { legacy = fmt.normalizeDocument(raw); } catch (error) {
      rows.push({ name, note: `解析失败：${error.message}` });
      failed += 1;
      continue;
    }
    const classroomName = legacy.classroom.name;
    const experimentName = legacy.experiment.name;
    const code = codes.get(classroomName) || '';
    const classroom = { name: classroomName, code };

    // 作业号：优先关卡存档里 source 的 homework_common_id
    const levelIndex = readLevelIndex(exportRoot, classroomName, experimentName);
    let homeworkId = 0;
    {
      const archive = path.join(exportRoot, classroomName, experimentName, 'levels.jsonl');
      try {
        for (const line of fs.readFileSync(archive, 'utf8').split('\n')) {
          if (!line.trim()) continue;
          const hit = String(JSON.parse(line).source || '').match(/homework_common_id=(\d+)/);
          if (hit) { homeworkId = Number(hit[1]) || 0; break; }
        }
      } catch { /* 没存档：作业号留 0 */ }
    }
    const experiment = { name: experimentName, homeworkId };
    const targetPath = fmt.answerPathFor(exportRoot, classroom, experiment);
    const targetExists = fs.existsSync(targetPath);
    const legacyAnswered = answeredLevels(legacy);

    if (targetExists) {
      const existing = fmt.normalizeDocument(JSON.parse(fs.readFileSync(targetPath, 'utf8')), { classroom, experiment });
      const covered = answeredLevels(existing);
      const missing = [...legacyAnswered].filter((id) => !covered.has(id));
      rows.push({
        name,
        classroom,
        experiment: experimentName,
        legacyCount: legacyAnswered.size,
        v2Count: covered.size,
        note: missing.length
          ? `v2 已存在但缺 ${missing.join('、')}（不覆盖已有 v2，未迁移）`
          : 'v2 已存在且完整覆盖',
        cleanup: missing.length === 0
      });
      continue;
    }

    // 迁移：v1 条目 + 存档补齐 task_identifier / title
    const provenance = provenanceFromModel(raw.model);
    const entries = legacy.answers.map((item) => {
      const meta = levelIndex.get(String(item.level_id)) || {};
      const base = {
        levelId: String(item.level_id),
        kind: item.kind,
        taskIdentifier: meta.taskIdentifier || item.task_identifier || '',
        title: meta.title || item.title || '',
        source: provenance.source,
        verified: provenance.verified
      };
      return item.kind === fmt.KINDS.CHOICE
        ? { ...base, answer: item.questions }
        : { ...base, language: item.language || meta.language || '', answer: item.code };
    }).filter((entry) => (entry.kind === fmt.KINDS.CHOICE ? (entry.answer || []).length > 0 : Boolean(entry.answer)));

    if (!entries.length) {
      rows.push({ name, classroom, experiment: experimentName, legacyCount: 0, v2Count: 0, note: '旧文件里没有可用答案，跳过' });
      continue;
    }
    if (dryRun) {
      rows.push({ name, classroom, experiment: experimentName, legacyCount: entries.length, v2Count: 0, note: '将写入 v2（--dry-run 未执行）' });
      continue;
    }
    const saved = await store.mergeAnswers({
      exportRoot,
      classroom,
      experiment,
      entries,
      model: String(raw.model || '')
    });
    if (!saved.ok) {
      rows.push({ name, classroom, experiment: experimentName, legacyCount: entries.length, v2Count: 0, note: `写入失败：${saved.error}` });
      failed += 1;
      continue;
    }
    const written = fmt.normalizeDocument(JSON.parse(fs.readFileSync(saved.answerPath, 'utf8')), { classroom, experiment });
    const covered = answeredLevels(written);
    const lost = [...legacyAnswered].filter((id) => !covered.has(id));
    rows.push({
      name,
      classroom,
      experiment: experimentName,
      legacyCount: legacyAnswered.size,
      v2Count: covered.size,
      note: lost.length ? `已迁移，但少写 ${lost.join('、')}` : '已迁移到 v2',
      cleanup: lost.length === 0
    });
    if (lost.length) failed += 1;
  }

  // ------------------------------------------------------------- 报告
  console.log(`\n旧格式文件 ${legacyFiles.length} 个，目标目录：${path.relative(ROOT, answerDir)}\n`);
  for (const row of rows) {
    const where = row.classroom ? `${row.classroom.name}${row.classroom.code ? `（${row.classroom.code}）` : ''} / ${row.experiment}` : row.name;
    console.log(`- ${where}\n    旧 ${row.legacyCount ?? '-'} 关｜v2 ${row.v2Count ?? '-'} 关｜${row.note}`);
  }

  // ------------------------------------------------------------- 清理
  const cleanable = rows.filter((row) => row.cleanup);
  if (!cleanup) {
    console.log(`\n可清理（内容已被 v2 完整覆盖）的旧文件：${cleanable.length} / ${legacyFiles.length}`);
    if (cleanable.length) console.log('加 --cleanup 把它们移进 answers/.legacy-backup/（移动不是删除，可恢复）。');
  } else {
    let moved = 0;
    for (const row of cleanable) {
      const from = path.join(answerDir, row.name);
      const to = path.join(backupDir, row.name);
      try {
        fs.mkdirSync(backupDir, { recursive: true });
        fs.rmSync(to, { force: true });
        fs.renameSync(from, to);
        moved += 1;
      } catch (error) {
        console.error(`  移不动 ${row.name}：${error.message}`);
        failed += 1;
      }
    }
    console.log(`\n已清理 ${moved} 个旧文件 → ${path.relative(ROOT, backupDir)}/`);
    const left = rows.filter((row) => !row.cleanup).length;
    if (left) console.log(`仍有 ${left} 个旧文件未清理（内容未被 v2 完整覆盖，见上）。`);
  }

  if (failed) {
    console.error(`\n有 ${failed} 处需要处理。`);
    process.exitCode = 1;
  } else {
    console.log('\n完成。建议接着跑：node tools/validate-answers.js 与 npm run check-fit');
  }
}

main().catch((error) => {
  console.error(`迁移失败：${error.stack || error.message}`);
  process.exitCode = 1;
});
