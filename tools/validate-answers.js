#!/usr/bin/env node
'use strict';

/**
 * 校验答案文件（离线，不需要账号与浏览器）。
 *
 * 用法：
 *   node tools/validate-answers.js                    # 校验 exports 下全部实验
 *   node tools/validate-answers.js 课程名 实验名        # 只校验一个实验
 *
 * 答案的规范位置：`exports/answers/{课程}__{实验}.answers.json`（一个文件夹集中放，
 * 文件名标清课程与实验）。同时也接受实验目录下的 `answers/` 或根目录同名文件（早期产物）。
 *
 * 检查内容（详见 extractor/lib/answer-validator.js）：
 *   ① 每关都有答案；② 题型与存档一致；③ 选择题字母不越界、小问不缺；
 *   ④ 编程题不是占位文本、保留了题目框架标记；⑤ 答案文件里的 course/experiment 与目录一致。
 *
 * 退出码：全部通过 0，有问题 1（方便接进 CI 或脚本）。
 */

const fs = require('node:fs/promises');
const path = require('node:path');

const { readArchive, orderedLevels } = require('../extractor/lib/level-store');
const { validateAnswers } = require('../extractor/lib/answer-validator');
const { answerFileName } = require('../extractor/lib/task-parser');

const ROOT = path.resolve(__dirname, '..');
const EXPORT_ROOT = process.env.EDUCODER_EXPORT_ROOT || path.join(ROOT, 'exports');
const ANSWER_DIR = path.join(EXPORT_ROOT, 'answers');

/** 按优先级找答案文件：集中目录 → 实验目录 answers/ → 实验目录根。 */
async function findAnswerFile(dir, experiment, course) {
  const candidates = [
    path.join(ANSWER_DIR, `${answerFileName(course, experiment)}.answers.json`),
    path.join(dir, 'answers', `${experiment}.answers.json`),
    path.join(dir, `${experiment}.answers.json`)
  ];
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      /* 继续找下一个 */
    }
  }
  return null;
}

async function listExperiments(root) {
  const found = [];
  let courses = [];
  try {
    courses = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const course of courses) {
    if (!course.isDirectory()) continue;
    const courseDir = path.join(root, course.name);
    for (const experiment of await fs.readdir(courseDir, { withFileTypes: true })) {
      if (!experiment.isDirectory()) continue;
      const dir = path.join(courseDir, experiment.name);
      try {
        await fs.access(path.join(dir, 'levels.jsonl'));
      } catch {
        continue;
      }
      found.push({ course: course.name, experiment: experiment.name, dir });
    }
  }
  return found;
}

async function main() {
  const [courseFilter, experimentFilter] = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
  const targets = (await listExperiments(EXPORT_ROOT)).filter(
    (item) =>
      (!courseFilter || item.course === courseFilter) && (!experimentFilter || item.experiment === experimentFilter)
  );

  if (!targets.length) {
    console.log(`没有找到任何关卡存档（${path.join(EXPORT_ROOT, '<课程>', '<实验>', 'levels.jsonl')}）。`);
    return;
  }

  let failed = 0;
  for (const target of targets) {
    const levels = orderedLevels((await readArchive(path.join(target.dir, 'levels.jsonl'))).records);
    const answerFile = await findAnswerFile(target.dir, target.experiment, target.course);
    if (!answerFile) {
      console.log(
        `缺答案  ${target.course} / ${target.experiment}：${levels.length} 关，` +
          `未找到 answers/${answerFileName(target.course, target.experiment)}.answers.json`
      );
      failed += 1;
      continue;
    }
    let answers = {};
    let declared = {};
    try {
      const parsed = JSON.parse(await fs.readFile(answerFile, 'utf8'));
      declared = { course: parsed.course || '', experiment: parsed.experiment || '' };
      answers = Array.isArray(parsed.answers)
        ? Object.fromEntries(parsed.answers.filter((item) => item && item.level_id).map((item) => [item.level_id, item]))
        : parsed.answers || parsed;
    } catch (error) {
      console.log(`答案坏  ${target.course} / ${target.experiment}：${error.message}`);
      failed += 1;
      continue;
    }

    const report = validateAnswers({ levels, answers });
    // 答案文件里写的课程/实验必须与所在目录一致，否则篡改猴会拿着别的实验的答案作答。
    if (declared.course && declared.course !== target.course) {
      report.issues.push({
        level: '-',
        kind: '-',
        code: 'course-mismatch',
        message: `答案文件里 course=「${declared.course}」，与目录「${target.course}」不一致`
      });
    }
    if (declared.experiment && declared.experiment !== target.experiment) {
      report.issues.push({
        level: '-',
        kind: '-',
        code: 'experiment-mismatch',
        message: `答案文件里 experiment=「${declared.experiment}」，与目录「${target.experiment}」不一致`
      });
    }
    const ok = report.issues.length === 0;
    const tail = `${target.course} / ${target.experiment}：${report.covered}/${report.total} 关有答案（${path.relative(EXPORT_ROOT, answerFile)}）`;
    if (ok) {
      console.log(`通过    ${tail}`);
    } else {
      failed += 1;
      console.log(`有问题  ${tail}，${report.issues.length} 处：`);
      for (const issue of report.issues.slice(0, 12)) {
        console.log(`        · ${issue.level} [${issue.code}] ${issue.message}`);
      }
      if (report.issues.length > 12) console.log(`        · …还有 ${report.issues.length - 12} 处`);
    }
  }

  console.log(failed ? `\n${failed}/${targets.length} 个实验未通过。` : `\n${targets.length} 个实验全部通过。`);
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`校验失败：${error.message}`);
  process.exitCode = 1;
});
