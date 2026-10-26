'use strict';

/** 发现本地题目与答案；仅列目录和读取文档，不执行作答或访问模型。 */
const fs = require('node:fs/promises');
const path = require('node:path');
const { readArchive, orderedLevels } = require('./level-store');
const fmt = require('./answer-format');

async function entriesOf(directory) {
  try { return await fs.readdir(directory, { withFileTypes: true }); }
  catch { return []; }
}

function identifierFromSource(source) {
  return fmt.identifierFromTaskUrl(source);
}

function shortName(value) {
  return String(value || '').replace(/^\[[^\]]*\]\s*/, '').trim();
}

function sameClassroom(a, b) {
  if (a.code && b.code) return a.code === b.code;
  return Boolean(a.name && a.name === b.name);
}

function sameExperiment(a, b) {
  if (a.homeworkId && b.homeworkId) return a.homeworkId === b.homeworkId;
  return shortName(a.name) === shortName(b.name);
}

function levelsFromDocument(document) {
  return [...document.answers, ...document.unanswered].map((entry) => ({
    id: entry.level_id,
    taskIndex: Number(String(entry.level_id).replace(/^L/i, '')) || 0,
    title: entry.title || '',
    type: entry.kind || '',
    language: entry.language || '',
    taskIdentifier: entry.task_identifier || ''
  }));
}

function mergeDocument(previous, next) {
  if (!previous) return next;
  const answers = new Map(previous.answers.map((entry) => [entry.level_id, entry]));
  for (const entry of next.answers) answers.set(entry.level_id, entry);
  const unanswered = new Map(previous.unanswered.map((entry) => [entry.level_id, entry]));
  for (const entry of next.unanswered) unanswered.set(entry.level_id, entry);
  for (const id of answers.keys()) unanswered.delete(id);
  return { ...previous, ...next, answers: [...answers.values()], unanswered: [...unanswered.values()] };
}

/**
 * 返回课程 → 实验 → 关卡目录。答案模式没有 levels.jsonl 时也能发现实验。
 * v2 优先、旧扁平文件补缺；课堂码和作业号均存在时必须相同才可合并。
 */
async function listTargets(exportRoot) {
  const targets = [];
  const answerRoot = path.join(exportRoot, 'answers');
  const answerEntries = await entriesOf(answerRoot);
  const knownCodes = new Map();
  const rememberCode = ({ name, code }) => {
    if (!code) return;
    if (!knownCodes.has(name)) knownCodes.set(name, new Set());
    knownCodes.get(name).add(code);
  };
  for (const entry of answerEntries) {
    const match = entry.isDirectory() && /^(.*)（([^（）]*)）$/.exec(entry.name);
    if (match) rememberCode({ name: match[1], code: match[2] });
  }
  for (const courseDir of await entriesOf(exportRoot)) {
    if (!courseDir.isDirectory() || ['answers', 'logs'].includes(courseDir.name)) continue;
    const coursePath = path.join(exportRoot, courseDir.name);
    for (const experimentDir of await entriesOf(coursePath)) {
      if (!experimentDir.isDirectory()) continue;
      const directory = path.join(coursePath, experimentDir.name);
      const records = orderedLevels((await readArchive(path.join(directory, 'levels.jsonl'))).records);
      if (!records.length) continue;
      const first = records[0];
      const classroom = {
        name: first.course || courseDir.name,
        code: first.classroomCode || ''
      };
      const levels = records.map((level) => ({
        taskIndex: Number(level.taskIndex) || 0,
        id: fmt.levelIdOf(level.taskIndex),
        title: level.title || '',
        type: level.type || '',
        language: level.codeLanguage || '',
        taskIdentifier: identifierFromSource(level.source),
        homeworkCommonId: fmt.homeworkIdFromTaskUrl(level.source),
        classroomCode: fmt.classroomCodeFromTaskUrl(level.source)
      }));
      classroom.code ||= levels.map((level) => level.classroomCode).find(Boolean) || '';
      rememberCode(classroom);
      const codes = knownCodes.get(classroom.name);
      if (!classroom.code && codes?.size === 1) classroom.code = [...codes][0];
      const homeworkId = Number(first.experimentHomeworkId)
        || levels.map((level) => Number(level.homeworkCommonId)).find((value) => value > 0) || 0;
      targets.push({
        courseName: courseDir.name,
        courseDirectory: coursePath,
        name: experimentDir.name,
        directory,
        mdPath: path.join(directory, `${experimentDir.name}.md`),
        classroom,
        homeworkId,
        answerPath: fmt.answerPathFor(exportRoot, classroom, { name: first.experiment || experimentDir.name }),
        answerDoc: null,
        levels
      });
    }
  }

  const answerFiles = [];
  for (const entry of answerEntries) {
    const full = path.join(answerRoot, entry.name);
    if (entry.isDirectory()) {
      const match = /^(.*)（([^（）]*)）$/.exec(entry.name);
      const classroom = { name: match ? match[1] : entry.name, code: match ? match[2] : '' };
      for (const child of await entriesOf(full)) {
        if (child.isFile() && /\.answers\.json$/.test(child.name)) {
          answerFiles.push({ full: path.join(full, child.name), classroom, name: child.name.replace(/\.answers\.json$/, ''), priority: 2 });
        }
      }
    } else if (entry.isFile() && /\.answers\.json$/.test(entry.name)) {
      const [course, ...experiment] = entry.name.replace(/\.answers\.json$/, '').split('__');
      answerFiles.push({ full, classroom: { name: course, code: '' }, name: experiment.join('__'), priority: 1 });
    }
  }
  // 先处理旧文件，v2 文件可覆盖同一关卡的新答案。
  answerFiles.sort((a, b) => a.priority - b.priority || a.full.localeCompare(b.full, 'zh'));
  for (const file of answerFiles) {
    let document;
    try {
      document = fmt.normalizeDocument(JSON.parse(await fs.readFile(file.full, 'utf8')), {
        classroom: file.classroom,
        experiment: { name: file.name }
      });
    } catch { continue; }
    const identity = { name: document.experiment.name, homeworkId: Number(document.experiment.homework_id) || 0 };
    const matches = targets.filter((target) => {
      const ambiguousName = knownCodes.get(document.classroom.name)?.size > 1;
      if (ambiguousName && Boolean(target.classroom.code) !== Boolean(document.classroom.code)) return false;
      return sameClassroom(target.classroom, document.classroom) && sameExperiment(target, identity);
    });
    // 名称兜底有多个候选时保留独立条目，不能把答案猜进某个班级/实验。
    let target = matches.length === 1 ? matches[0] : null;
    if (!target) {
      target = {
        courseName: document.classroom.name,
        courseDirectory: '',
        name: identity.name,
        directory: '',
        mdPath: '',
        classroom: document.classroom,
        homeworkId: identity.homeworkId,
        answerDoc: null,
        levels: []
      };
      targets.push(target);
    }
    target.classroom = {
      name: target.classroom.name || document.classroom.name,
      code: target.classroom.code || document.classroom.code,
      id: Number(target.classroom.id) || Number(document.classroom.id) || 0
    };
    target.homeworkId ||= identity.homeworkId;
    target.answerPath = file.full;
    target.answerDoc = mergeDocument(target.answerDoc, document);
    const byId = new Map(target.levels.map((level) => [level.id, level]));
    for (const level of levelsFromDocument(document)) {
      const previous = byId.get(level.id);
      byId.set(level.id, previous ? {
        ...level, ...previous,
        title: previous.title || level.title,
        type: previous.type || level.type,
        language: previous.language || level.language,
        taskIdentifier: previous.taskIdentifier || level.taskIdentifier
      } : level);
    }
    target.levels = [...byId.values()];
  }

  const courses = [];
  for (const target of targets) {
    let course = courses.find((entry) => entry.classroom.code || target.classroom.code
      ? Boolean(entry.classroom.code && entry.classroom.code === target.classroom.code)
      : entry.classroom.name === target.classroom.name);
    if (!course) {
      course = { name: target.courseName, directory: target.courseDirectory, classroom: target.classroom, experiments: [] };
      courses.push(course);
    }
    const { courseName, courseDirectory, ...experiment } = target;
    experiment.levels.sort((a, b) => a.taskIndex - b.taskIndex);
    const answeredIds = new Set((experiment.answerDoc?.answers || []).map((entry) => entry.level_id));
    for (const level of experiment.levels) level.answered = answeredIds.has(level.id);
    experiment.levelCount = experiment.levels.length;
    experiment.answered = experiment.answerDoc?.answers.length || 0;
    course.experiments.push(experiment);
  }
  for (const course of courses) course.experiments.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  return courses.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
}

module.exports = { listTargets, identifierFromSource };
