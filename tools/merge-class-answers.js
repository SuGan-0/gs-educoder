'use strict';

/**
 * 把一份「班级答案文件」并进另一份（通常是本项目 `exports/answers/{年级}-{班级}.answers.json`）。
 *
 * 与 `mergeClassDocuments()` 的区别（那个是 `build-class-answers` 用的）：
 * 那里是「工作层 → 班级文件」，规则是**新的没答案就保留旧的**；
 * 这里处理的是「别人机器导出的班级文件 → 我的班级文件」，规则按用户口径：
 * **新增的、或内容不一样的，一律以传入文件为准**（覆盖），只有传入文件里没答案的关卡才保留旧答案。
 *
 * 三种用法：
 *   node tools/merge-class-answers.js --from="D:/download/本机导出.answers (2).json" --dry-run
 *   node tools/merge-class-answers.js --from="D:/download/本机导出.answers (2).json"
 *   node tools/merge-class-answers.js --course=数据库系统原理-软工24级     # 从工作层取某个课程
 *
 * 覆盖时**不丢元信息**：新条目的 `answer.language` 为空而旧条目有时，保留旧的
 * （实测「本机导出」把 language 全导成空串，直接覆盖会让篡改猴拿不到语言类型）。
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const fmt = require(path.join(ROOT, 'extractor', 'lib', 'answer-format'));
const classAnswers = require(path.join(ROOT, 'extractor', 'lib', 'class-answers'));
const answerer = require(path.join(ROOT, 'extractor', 'lib', 'answerer'));

/** `--key=value` 取值。 */
function argOf(name) {
  const hit = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : '';
}

const DRY_RUN = process.argv.includes('--dry-run');
const SYNC_WORK = process.argv.includes('--sync-work');

const EXPORT_ROOT = process.env.EDUCODER_EXPORT_ROOT || path.join(ROOT, 'exports');

function key(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

/** 重算 stats，口径与 class-answers.buildClassDocument 一致（含 perClassroom）。 */
function recomputeStats(doc) {
  let experimentCount = 0;
  let levelCount = 0;
  let answeredCount = 0;
  const perClassroom = {};
  for (const classroom of doc.classrooms || []) {
    let answeredIn = 0;
    for (const experiment of classroom.experiments || []) {
      experimentCount += 1;
      for (const level of experiment.levels || []) {
        levelCount += 1;
        if (level.answered) {
          answeredCount += 1;
          answeredIn += 1;
        }
      }
    }
    perClassroom[classroom.name] = { experiments: classroom.experiments.length, answered: answeredIn };
  }
  doc.stats = {
    classrooms: (doc.classrooms || []).length,
    experiments: experimentCount,
    levels: levelCount,
    answered: answeredCount,
    missing: levelCount - answeredCount,
    perClassroom
  };
  return doc;
}

/** 两个答案体的内容签名：只比「答了什么」，不比 source/verified。 */
function answerSignature(level) {
  const answer = (level && level.answer) || {};
  if (answer.code !== undefined) return `code:${answer.code}`;
  if (answer.questions !== undefined) return `choice:${JSON.stringify(answer.questions)}`;
  if (Array.isArray(level && level.answer)) return `choice:${JSON.stringify(level.answer)}`;
  return 'none';
}

/**
 * 合并：incoming 覆盖 target。
 * @returns {{added:Array, changed:Array, kept:Array, newClassrooms:Array, newExperiments:Array}}
 */
function mergeInto(target, incoming) {
  const report = { added: [], changed: [], kept: [], newClassrooms: [], newExperiments: [], touched: [] };

  const classroomIndex = new Map();
  for (const classroom of target.classrooms || []) {
    if (key(classroom.code)) classroomIndex.set(key(classroom.code), classroom);
    if (key(classroom.name) && !classroomIndex.has(key(classroom.name))) {
      classroomIndex.set(key(classroom.name), classroom);
    }
  }

  for (const srcClassroom of incoming.classrooms || []) {
    let classroom = classroomIndex.get(key(srcClassroom.code)) || classroomIndex.get(key(srcClassroom.name));
    if (!classroom) {
      // 新课堂：整体搬进来（本机导出里可能有本项目还没抓过的课程）
      classroom = { name: srcClassroom.name, code: srcClassroom.code, experiments: [] };
      target.classrooms.push(classroom);
      classroomIndex.set(key(srcClassroom.code) || key(srcClassroom.name), classroom);
      report.newClassrooms.push(`${srcClassroom.name}（${srcClassroom.code || '无码'}）`);
    } else if (!key(classroom.code) && key(srcClassroom.code)) {
      classroom.code = srcClassroom.code;
    }

    for (const srcExperiment of srcClassroom.experiments || []) {
      let experiment = (classroom.experiments || []).find((item) => key(item.name) === key(srcExperiment.name));
      if (!experiment) {
        experiment = {
          name: srcExperiment.name,
          chapter: srcExperiment.chapter || '',
          homework_id: srcExperiment.homework_id || 0,
          levels: []
        };
        classroom.experiments.push(experiment);
        report.newExperiments.push(`${classroom.name} / ${srcExperiment.name}`);
      }

      for (const srcLevel of srcExperiment.levels || []) {
        const levelId = key(srcLevel.level_id);
        const existing = (experiment.levels || []).find((item) => key(item.level_id) === levelId);
        const label = `${classroom.name} / ${srcExperiment.name} / ${levelId}（${srcLevel.title || ''}）`;

        if (!existing) {
          const copy = JSON.parse(JSON.stringify(srcLevel));
          experiment.levels.push(copy);
          if (srcLevel.answered) {
            report.added.push(label);
            report.touched.push({ classroom, experiment, level: copy });
          }
          continue;
        }

        // 传入文件这一关没有答案：保留旧答案，绝不因为「这次没抓到」把答案抹掉
        if (!srcLevel.answered) {
          if (existing.answered) report.kept.push(label);
          continue;
        }

        if (!existing.answered) {
          Object.assign(existing, JSON.parse(JSON.stringify(srcLevel)), { answered: true });
          report.added.push(label);
          report.touched.push({ classroom, experiment, level: existing });
          continue;
        }

        if (answerSignature(existing) === answerSignature(srcLevel)) {
          // 答案一致：只把标识符/来源这类元信息补上
          if (!existing.identifiers || !existing.identifiers.length) existing.identifiers = srcLevel.identifiers || [];
          continue;
        }

        const oldLanguage = key((existing.answer || {}).language);
        const next = JSON.parse(JSON.stringify(srcLevel));
        if (next.answer && next.answer.code !== undefined && !key(next.answer.language) && oldLanguage) {
          next.answer.language = oldLanguage;
        }
        Object.assign(existing, next, { answered: true });
        report.changed.push(label);
        report.touched.push({ classroom, experiment, level: existing });
      }

      // 按 position 稳定排序，让关卡顺序与平台一致
      experiment.levels.sort((a, b) => (Number(a.position) || 0) - (Number(b.position) || 0));
    }
  }

  return report;
}

/** 从工作层汇总某个课程（一次只取一个课程），产出班级文件结构。 */
async function buildFromCourse(courseName, template) {
  const exportRoot = process.env.EDUCODER_EXPORT_ROOT || path.join(ROOT, 'exports');
  const courses = await answerer.listTargets(exportRoot);
  const course = courses.find((item) => key(item.name) === key(courseName));
  if (!course) {
    throw new Error(`exports/ 下没有课程「${courseName}」的存档。`);
  }
  const block = (course.experiments[0] || {}).classroom || { name: course.name };
  // 课堂码：`listTargets` 只从三段式 source 里取，早期存档（`/tasks/{关卡}?homework_common_id=`）
  // 取不到；levels.jsonl 的每条记录里其实有 classroomCode，直接读存档补上。
  let code = block.code || '';
  if (!code) {
    for (const experiment of course.experiments) {
      try {
        const first = fs
          .readFileSync(path.join(exportRoot, courseName, experiment.name, 'levels.jsonl'), 'utf8')
          .trim()
          .split('\n')[0];
        code = JSON.parse(first).classroomCode || '';
        if (code) break;
      } catch { /* 读不到就继续找 */ }
    }
  }
  const experiments = course.experiments.map((experiment) => {
    let answerDoc = null;
    try {
      answerDoc = fmt.normalizeDocument(JSON.parse(fs.readFileSync(experiment.answerPath, 'utf8')), {
        classroom: experiment.classroom,
        experiment: { name: experiment.name }
      });
    } catch { /* 还没答案文件 */ }
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
  return classAnswers.buildClassDocument({
    grade: (template.class || {}).grade || '',
    className: (template.class || {}).name || '',
    classrooms: [{ name: block.name || course.name, code, experiments }]
  });
}

/** 班级文件里的关卡 → 工作层 v2 答案条目（normalizeAnswer 的扁平形状）。 */
function toNormalizedEntry(level) {
  const answer = level.answer || {};
  const entry = {
    level_id: level.level_id,
    task_identifier: (level.identifiers || [])[0] || '',
    title: level.title || '',
    kind: level.kind === 'choice' ? 'choice' : 'code',
    source: level.source || 'unknown',
    verified: Boolean(level.verified)
  };
  if (entry.kind === 'choice') {
    entry.questions = Array.isArray(answer)
      ? answer
      : Array.isArray(answer.questions)
        ? answer.questions
        : [];
  } else {
    entry.language = answer.language || '';
    entry.code = answer.code || '';
  }
  return entry;
}

/**
 * 把本次并进去的答案**回写工作层**（`answers/{班级}（{课堂码}）/{实验}.answers.json`）。
 *
 * 不写会怎样：班级文件下次被 `npm run build-class-answers` 重建时，工作层里还是旧的 AI 答案，
 * 平台标准答案被静默覆盖回去 —— class-answers.js 的注释里记的就是这个坑。
 */
function syncWork(report) {
  const groups = new Map();
  for (const item of report.touched) {
    const classroom = { name: item.classroom.name, code: item.classroom.code };
    const experiment = { name: item.experiment.name, homeworkId: item.experiment.homework_id };
    const id = `${classroom.name}\u0000${experiment.name}`;
    if (!groups.has(id)) groups.set(id, { classroom, experiment, levels: [] });
    groups.get(id).levels.push(item.level);
  }

  const written = [];
  for (const group of groups.values()) {
    const file = fmt.answerPathFor(EXPORT_ROOT, group.classroom, group.experiment);
    let doc;
    try {
      doc = fmt.normalizeDocument(JSON.parse(fs.readFileSync(file, 'utf8')), {
        classroom: group.classroom,
        experiment: group.experiment
      });
    } catch {
      doc = fmt.emptyDocument(group.classroom, group.experiment);
    }
    const byLevel = new Map((doc.answers || []).map((entry) => [String(entry.level_id), entry]));
    for (const level of group.levels) {
      byLevel.set(String(level.level_id), toNormalizedEntry(level));
    }
    doc.answers = [...byLevel.values()].sort(
      (a, b) => Number(String(a.level_id).slice(1)) - Number(String(b.level_id).slice(1))
    );
    doc.unanswered = (doc.unanswered || []).filter(
      (item) => !group.levels.some((level) => String(level.level_id) === String(item.level_id))
    );
    doc.generated_at = new Date().toISOString();
    doc.model = doc.model || 'export';
    if (!DRY_RUN) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, fmt.stringifyDocument(doc), 'utf8');
    }
    written.push(`${path.relative(ROOT, file)}（${group.levels.length} 关）`);
  }
  return written;
}

function printReport(report) {
  const section = (title, items) => {
    if (!items.length) return;
    console.log(`\n${title}（${items.length}）`);
    for (const item of items) console.log(`  - ${item}`);
  };
  section('新增课堂', report.newClassrooms);
  section('新增实验', report.newExperiments);
  section('新增答案', report.added);
  section('覆盖为传入文件的答案', report.changed);
  section('传入文件没答案、保留旧答案', report.kept);
}

async function main() {
  const fromPath = argOf('from');
  const courseName = argOf('course');
  const toPath = argOf('to');

  const answerDir = path.join(process.env.EDUCODER_EXPORT_ROOT || path.join(ROOT, 'exports'), 'answers');
  let targetPath = toPath;
  if (!targetPath) {
    const name = fs
      .readdirSync(answerDir)
      .find((file) => file.endsWith('.answers.json') && JSON.parse(fs.readFileSync(path.join(answerDir, file), 'utf8')).kind === classAnswers.CLASS_KIND);
    if (!name) {
      console.error('没找到班级答案文件，请用 --to= 指定。');
      process.exitCode = 1;
      return;
    }
    targetPath = path.join(answerDir, name);
  }

  const target = JSON.parse(fs.readFileSync(targetPath, 'utf8'));
  if (target.kind !== classAnswers.CLASS_KIND) {
    console.error(`目标不是班级答案文件：${targetPath}`);
    process.exitCode = 1;
    return;
  }

  let incoming;
  if (fromPath) {
    incoming = JSON.parse(fs.readFileSync(fromPath, 'utf8'));
    if (incoming.kind !== classAnswers.CLASS_KIND) {
      console.error(`--from 指向的不是班级答案文件（kind=${incoming.kind}）：${fromPath}`);
      process.exitCode = 1;
      return;
    }
    console.log(`来源：${fromPath}`);
  } else if (courseName) {
    incoming = await buildFromCourse(courseName, target);
    console.log(`来源：工作层课程「${courseName}」`);
  } else {
    console.error('用法：--from=<班级答案文件> 或 --course=<课程名>（可加 --dry-run）');
    process.exitCode = 1;
    return;
  }
  console.log(`目标：${targetPath}`);

  const report = mergeInto(target, incoming);
  recomputeStats(target);
  target.generated_at = new Date().toISOString();

  const verdict = classAnswers.validateClassDocument(target);
  printReport(report);
  console.log(`\n统计：${JSON.stringify(target.stats)}`);
  if (!verdict.ok) {
    console.error('\n校验失败：');
    for (const error of verdict.errors) console.error(`  - ${error}`);
    process.exitCode = 1;
    return;
  }
  for (const warning of verdict.warnings) console.log(`  警告：${warning}`);

  if (SYNC_WORK && report.touched.length) {
    const written = syncWork(report);
    console.log(`\n回写工作层（${written.length} 个答案文件）`);
    for (const item of written) console.log(`  - ${item}`);
  }

  if (DRY_RUN) {
    console.log('\n--dry-run：未写入磁盘。');
    return;
  }
  fs.writeFileSync(targetPath, `${JSON.stringify(target, null, 2)}\n`, 'utf8');
  console.log('\n已写入。');
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
