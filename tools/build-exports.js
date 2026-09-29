#!/usr/bin/env node
'use strict';

/**
 * 从关卡存档重建「给人/AI 看的视图」。
 *
 * 存档 `exports/课程/实验/levels.jsonl` 是唯一事实来源（每关一行、只追加）；
 * `实验.md` 与 `实验.metadata.json` 都是从它生成的视图，可以随时删掉重建。
 *
 * 用法：
 *   node tools/build-exports.js                 # 重建全部
 *   node tools/build-exports.js 课程名 实验名    # 只重建一个实验
 *   node tools/build-exports.js --check         # 只检查（不改文件），列出需要重建的实验
 *
 * 特点：离线、幂等、不需要登录态与浏览器。视图被改坏、格式升级、误删文件都能靠它恢复。
 */

const fs = require('node:fs/promises');
const path = require('node:path');

const { readArchive, orderedLevels } = require('../extractor/lib/level-store');
const { makeLevelSection, makeExperimentDocument } = require('../extractor/lib/task-parser');

const ROOT = path.resolve(__dirname, '..');
const EXPORT_ROOT = process.env.EDUCODER_EXPORT_ROOT || path.join(ROOT, 'exports');

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
    let experiments = [];
    try {
      experiments = await fs.readdir(courseDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const experiment of experiments) {
      if (!experiment.isDirectory()) continue;
      const dir = path.join(courseDir, experiment.name);
      const archivePath = path.join(dir, 'levels.jsonl');
      try {
        await fs.access(archivePath);
      } catch {
        continue;
      }
      found.push({ course: course.name, experiment: experiment.name, dir, archivePath });
    }
  }
  return found;
}

/** 缺图片的关卡在这里点出来：视图里的相对路径必须指到真实文件。 */
async function missingImages(dir, levels) {
  const missing = [];
  for (const level of levels) {
    for (const filename of level.images || []) {
      try {
        await fs.access(path.join(dir, 'assets', filename));
      } catch {
        missing.push(`${level.level || level.title || level.taskIndex} → ${filename}`);
      }
    }
  }
  return missing;
}

/** 忽略 frontmatter 里的 generated_at 再比较：内容没变就不该反复写文件。 */
function stripGeneratedAt(text) {
  return String(text || '').replace(/^generated_at:.*$/m, 'generated_at:');
}

async function buildOne({ course, experiment, dir, archivePath }, { check }) {
  const archive = await readArchive(archivePath);
  const levels = orderedLevels(archive.records);
  if (!levels.length) return { course, experiment, levelCount: 0, skipped: '存档为空' };

  const sections = levels.map((level) => makeLevelSection(level)).filter(Boolean);
  const generatedAt = new Date().toISOString();
  const document = makeExperimentDocument({ course, experiment, generatedAt, levels: sections });
  const metadata = {
    course,
    experiment,
    generatedAt,
    levelCount: levels.length,
    kinds: {
      code: levels.filter((level) => level.type === 'code').length,
      choice: levels.filter((level) => level.type === 'choice').length
    },
    levels
  };

  const markdownPath = path.join(dir, `${experiment}.md`);
  const metadataPath = path.join(dir, `${experiment}.metadata.json`);
  let changed = true;
  try {
    const previous = await fs.readFile(markdownPath, 'utf8');
    changed = stripGeneratedAt(previous) !== stripGeneratedAt(document);
  } catch {
    changed = true;
  }
  if (!check && changed) {
    await fs.writeFile(markdownPath, document, 'utf8');
    await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2), 'utf8');
  }
  return {
    course,
    experiment,
    levelCount: levels.length,
    changed,
    brokenLines: archive.broken,
    missingImages: await missingImages(dir, levels)
  };
}

async function main() {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const [courseFilter, experimentFilter] = args.filter((arg) => !arg.startsWith('--'));

  const targets = (await listExperiments(EXPORT_ROOT)).filter(
    (item) =>
      (!courseFilter || item.course === courseFilter) && (!experimentFilter || item.experiment === experimentFilter)
  );

  if (!targets.length) {
    console.log(`没有找到任何关卡存档（${path.join(EXPORT_ROOT, '<课程>', '<实验>', 'levels.jsonl')}）。`);
    return;
  }

  let levels = 0;
  let changedCount = 0;
  for (const target of targets) {
    const result = await buildOne(target, { check });
    levels += result.levelCount;
    if (result.changed) changedCount += 1;
    const mark = result.changed ? (check ? '需重建' : '已写入') : '无变化';
    console.log(`${mark.padEnd(6)} ${result.course} / ${result.experiment}：${result.levelCount} 关`);
    if (result.brokenLines) console.log(`       ⚠ 存档里有 ${result.brokenLines} 行无法解析，已忽略`);
    if (result.missingImages?.length) {
      console.log(`       ⚠ 缺图片 ${result.missingImages.length} 张：${result.missingImages.slice(0, 5).join('、')}`);
    }
  }
  console.log(
    `\n共 ${targets.length} 个实验 / ${levels} 关；${check ? `其中 ${changedCount} 个需要重建` : `写入 ${changedCount} 个`}。`
  );
  if (check && changedCount) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`重建失败：${error.message}`);
  process.exitCode = 1;
});
