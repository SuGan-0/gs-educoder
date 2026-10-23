'use strict';

/**
 * 把工作层的答案汇总成**班级答案文件**（`kind: "class-answers"`）——不用开本地控制台。
 *
 * 用途：篡改猴「导入答案文件」吃的是班级文件。原来它只能从控制台点「导出班级答案文件」生成，
 * 而这个工具让你补完答案后在终端直接重导一份，不必开浏览器、不必开控制台。
 *
 * 口径与 `extractor/ui/server.js` 的 `exportClassAnswers` **完全一致**（那才是唯一事实来源，
 * 这里只是把它搬到命令行）：
 *   1. `answerer.listTargets()` 扫存档 → 每个实验找到答案文件（**v2 位置优先，回退 v1 扁平**）；
 *   2. `class-answers.buildClassDocument()` 汇总；
 *   3. 与已有文件 `mergeClassDocuments()`（新一轮没答案的关卡保留旧答案，不丢）；
 *   4. `validateClassDocument()` 校验后落盘。
 *
 * 用法：
 *   node tools/build-class-answers.js                       # 从已有班级文件里认出年级/班级名
 *   node tools/build-class-answers.js --grade=2024级 --class=软工24-15、16班
 * 退出码：校验有错 → 1。
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const answerer = require(path.join(ROOT, 'extractor', 'lib', 'answerer'));
const fmt = require(path.join(ROOT, 'extractor', 'lib', 'answer-format'));
const classAnswers = require(path.join(ROOT, 'extractor', 'lib', 'class-answers'));

/** 从 `--key=value` 取参数。 */
function argOf(name) {
  const hit = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : '';
}

/** 已经导过班级文件时，直接从它身上认出「年级 / 班级名」，省得每次手敲。 */
function detectClassFromExisting(answerDir) {
  let names = [];
  try { names = fs.readdirSync(answerDir); } catch { return null; }
  for (const name of names) {
    if (!name.endsWith('.answers.json')) continue;
    try {
      const doc = JSON.parse(fs.readFileSync(path.join(answerDir, name), 'utf8'));
      if (doc && doc.kind === classAnswers.CLASS_KIND && doc.class && doc.class.name) {
        return { grade: String(doc.class.grade || ''), className: String(doc.class.name) };
      }
    } catch { /* 坏文件跳过 */ }
  }
  return null;
}

async function main() {
  const exportRoot = process.env.EDUCODER_EXPORT_ROOT || path.join(ROOT, 'exports');
  const answerDir = path.join(exportRoot, 'answers');

  let { grade, className } = {
    grade: argOf('grade'),
    className: argOf('class')
  };
  if (!grade || !className) {
    const detected = detectClassFromExisting(answerDir);
    if (detected) {
      grade = grade || detected.grade;
      className = className || detected.className;
      console.log(`从已有班级文件认出：年级「${grade}」班级「${className}」（可用 --grade/--class 覆盖）`);
    }
  }
  if (!className) {
    console.error('缺少班级名。用法：node tools/build-class-answers.js --grade=2024级 --class=软工24-15、16班');
    process.exitCode = 1;
    return;
  }

  const courses = await answerer.listTargets(exportRoot);
  if (!courses.length) {
    console.error(`exports/ 下没有可汇总的课程存档：${exportRoot}`);
    process.exitCode = 1;
    return;
  }

  const classrooms = courses.map((course) => {
    const first = course.experiments[0] || {};
    const block = first.classroom || { name: course.name };
    const experiments = course.experiments.map((experiment) => {
      let answerDoc = null;
      try {
        // listTargets 已经算好了 answerPath（v2 优先、v1 回退），照用即可
        answerDoc = fmt.normalizeDocument(
          JSON.parse(fs.readFileSync(experiment.answerPath, 'utf8')),
          { classroom: experiment.classroom, experiment: { name: experiment.name } }
        );
      } catch { /* 这个实验还没答案文件：照常进班级文件（answered=false） */ }
      return {
        name: experiment.name,
        chapter: (String(experiment.name).match(/^\[([^\]]+)\]/) || [])[1] || '',
        homeworkId: experiment.homeworkId || 0,
        records: experiment.levels.map((level) => ({
          levelId: level.id,
          taskIndex: level.taskIndex,
          title: level.title,
          type: level.type,
          taskIdentifier: level.taskIdentifier || ''
        })),
        answerDoc
      };
    });
    return { name: block.name || course.name, code: block.code || '', experiments };
  });

  const next = classAnswers.buildClassDocument({ grade, className, classrooms });
  const classPath = classAnswers.classAnswersPathFor(exportRoot, { grade, className });
  let previous = null;
  try {
    previous = JSON.parse(fs.readFileSync(classPath, 'utf8'));
  } catch { /* 首次导出 */ }
  const merged = previous ? classAnswers.mergeClassDocuments(previous, next) : next;
  const verdict = classAnswers.validateClassDocument(merged);

  fs.mkdirSync(path.dirname(classPath), { recursive: true });
  fs.writeFileSync(classPath, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');

  console.log(`已写出：${path.relative(ROOT, classPath)}`);
  console.log(
    `课堂 ${verdict.stats.classrooms}｜实验 ${verdict.stats.experiments}｜关卡 ${verdict.stats.levels}｜`
      + `有答案 ${verdict.stats.answered}｜缺 ${verdict.stats.missing}`
  );
  if (verdict.errors.length) {
    console.error(`校验错误 ${verdict.errors.length} 条，首条：${verdict.errors[0]}`);
    process.exitCode = 1;
    return;
  }
  console.log('下一步：篡改猴菜单「导入答案文件」选这份 JSON 即可（不需要本地控制台）。');
}

main().catch((error) => {
  console.error(`导出失败：${error.message}`);
  process.exitCode = 1;
});
