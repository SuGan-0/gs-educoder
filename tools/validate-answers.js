#!/usr/bin/env node
'use strict';

/** 离线校验题目答案和“只提取答案”产物；没有目标或文件损坏时均以非零退出。 */
const fs = require('node:fs/promises');
const path = require('node:path');
const { listTargets } = require('../extractor/lib/archive-catalog');
const { readArchive, orderedLevels } = require('../extractor/lib/level-store');
const { validateAnswers, validateAnswerDocument } = require('../extractor/lib/answer-validator');
const fmt = require('../extractor/lib/answer-format');

const EXPORT_ROOT = process.env.EDUCODER_EXPORT_ROOT || path.join(__dirname, '..', 'exports');

async function exists(file) {
  try { await fs.access(file); return true; } catch { return false; }
}

async function rawAnswerFiles() {
  const root = path.join(EXPORT_ROOT, 'answers');
  let entries;
  try { entries = await fs.readdir(root, { withFileTypes: true }); } catch { return []; }
  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (entry.isDirectory()) {
      const classroom = fmt.classroomFromDirName(entry.name);
      for (const child of await fs.readdir(path.join(root, entry.name), { withFileTypes: true })) {
        if (child.isFile() && child.name.endsWith('.answers.json')) files.push({
          path: path.join(root, entry.name, child.name), classroom,
          experiment: { name: child.name.replace(/\.answers\.json$/, '') }
        });
      }
    } else if (entry.isFile() && entry.name.endsWith('.answers.json')) {
      const [course, ...experiment] = entry.name.replace(/\.answers\.json$/, '').split('__');
      files.push({ path: path.join(root, entry.name), classroom: { name: course, code: '' }, experiment: { name: experiment.join('__') } });
    }
  }
  return files;
}

async function findAnswerFile(target) {
  const { classroom, experiment, dir, answerPath } = target;
  const candidates = [answerPath, fmt.answerPathFor(EXPORT_ROOT, classroom, { name: experiment }), fmt.legacyAnswerPathFor(EXPORT_ROOT, classroom, { name: experiment })];
  if (dir) candidates.push(path.join(dir, 'answers', `${experiment}.answers.json`), path.join(dir, `${experiment}.answers.json`));
  for (const candidate of candidates.filter(Boolean)) if (await exists(candidate)) return candidate;
  return null;
}

async function main() {
  const [courseFilter, experimentFilter] = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
  const selected = (course, experiment) => (!courseFilter || course === courseFilter) && (!experimentFilter || experiment === experimentFilter);
  const rawFiles = await rawAnswerFiles();
  const pathIdentity = new Map(rawFiles.map((file) => [file.path, file]));
  const courses = await listTargets(EXPORT_ROOT);
  const targets = courses.flatMap((course) => course.experiments.map((experiment) => ({
    course: course.name, experiment: experiment.name, dir: experiment.directory,
    classroom: experiment.classroom || course.classroom || { name: course.name },
    homeworkId: experiment.homeworkId, answerPath: experiment.answerPath
  }))).filter((target) => selected(target.course, target.experiment));
  const checkedFiles = new Set();
  let checked = 0;
  let failed = 0;
  const printReport = (target, answerFile, report, standalone) => {
    checked += 1;
    const tail = `${target.course} / ${target.experiment}：${report.covered}/${report.total} 关有答案（${path.relative(EXPORT_ROOT, answerFile)}）`;
    if (!report.issues.length) console.log(`通过    ${tail}`);
    else {
      failed += 1;
      console.log(`有问题  ${tail}，${report.issues.length} 处：`);
      for (const issue of report.issues.slice(0, 12)) console.log(`        · ${issue.level} [${issue.code}] ${issue.message}`);
      if (report.issues.length > 12) console.log(`        · …还有 ${report.issues.length - 12} 处`);
    }
    if (standalone) console.log('        仅答案结构校验：没有题目存档，无法核对题干、小问完整性、选项范围、代码框架或答案正确性。');
  };

  for (const target of targets) {
    const levels = target.dir ? orderedLevels((await readArchive(path.join(target.dir, 'levels.jsonl'))).records) : [];
    const answerFile = await findAnswerFile(target);
    if (!answerFile) {
      checked += 1;
      failed += 1;
      console.log(`缺答案  ${target.course} / ${target.experiment}：${levels.length} 关，未找到 ${path.relative(EXPORT_ROOT, target.answerPath)}`);
      continue;
    }
    checkedFiles.add(answerFile);
    try {
      const raw = JSON.parse(await fs.readFile(answerFile, 'utf8'));
      const structure = validateAnswerDocument(raw, { classroom: target.classroom, experiment: { name: target.experiment, homeworkId: target.homeworkId }, standalone: !levels.length });
      const identity = pathIdentity.get(answerFile);
      if (identity) {
        const pathReport = validateAnswerDocument(raw, { classroom: identity.classroom, experiment: identity.experiment });
        for (const issue of pathReport.issues) {
          if (!structure.issues.some((existing) => existing.level === issue.level && existing.code === issue.code)) structure.issues.push(issue);
        }
      }
      const report = levels.length ? validateAnswers({ levels, answers: raw.answers }) : structure;
      if (levels.length) report.issues.push(...structure.issues);
      printReport(target, answerFile, report, !levels.length);
    } catch (error) {
      checked += 1;
      failed += 1;
      console.log(`答案坏  ${target.course} / ${target.experiment}：${error.message}`);
    }
  }

  // catalog 会跳过无法解析的文档；原始扫描确保这些文件不会被“全部通过”掩盖。
  for (const file of rawFiles) {
    if (checkedFiles.has(file.path) || !selected(file.classroom.name, file.experiment.name)) continue;
    try {
      const raw = JSON.parse(await fs.readFile(file.path, 'utf8'));
      if (raw.kind === 'class-answers') continue;
      const report = validateAnswerDocument(raw, { classroom: file.classroom, experiment: file.experiment, standalone: true });
      printReport({ course: file.classroom.name, experiment: file.experiment.name }, file.path, report, true);
    } catch (error) {
      checked += 1;
      failed += 1;
      console.log(`答案坏  ${path.relative(EXPORT_ROOT, file.path)}：${error.message}`);
    }
  }
  if (!checked) {
    console.log('未找到匹配的题目存档或工作答案，未执行校验。');
    process.exitCode = 1;
    return;
  }
  console.log(failed ? `\n${failed}/${checked} 个实验/文件未通过。` : `\n${checked} 个实验全部通过。`);
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`校验失败：${error.message}`);
  process.exitCode = 1;
});
