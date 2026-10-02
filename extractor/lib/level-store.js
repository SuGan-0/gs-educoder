'use strict';

/**
 * 关卡存档（append-only）。
 *
 * 为什么需要它：早先每抓一关都要「读回整个实验 md → 重新渲染全部关卡 → 整份重写
 * md + metadata」，一个 N 关的实验累计写入约 N² × 单关体积 / 2，且把「数据库」和
 * 「给人/AI 看的视图」混在同一个文件里，中断就会留下半截文档。
 *
 * 现在拆成两层：
 * - 存档：`exports/课程/实验/levels.jsonl`，**每关只追加一行**，写完即返回，永不读回；
 * - 视图：`实验.md` / `实验.metadata.json`，由存档生成，整轮结束时写一次
 *   （或事后用 `node tools/build-exports.js` 重建）。
 *
 * 追加语义里的「更新」：同一关（taskIndex 相同）再次捕获时追加**新行**，
 * 读取时最后一行生效（last-wins）。这样既保持纯追加，又能覆盖旧内容。
 */

const fs = require('node:fs/promises');
const path = require('node:path');

/** 存档文件名（放在实验目录下，与 views 同目录）。 */
const ARCHIVE_NAME = 'levels.jsonl';

/** 读取整个存档：返回 { records, index }（index: taskIndex → 最后一条记录）。 */
async function readArchive(filePath) {
  let text = '';
  try {
    text = await fs.readFile(filePath, 'utf8');
  } catch {
    return { records: [], index: new Map(), broken: 0 };
  }
  const records = [];
  let broken = 0;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch {
      // 半截行（写入过程中被中断）只计数，不影响其余关卡。
      broken += 1;
    }
  }
  return { records, index: indexRecords(records), broken };
}

function indexRecords(records) {
  const index = new Map();
  for (const record of records) {
    index.set(Number(record.taskIndex) || 0, record);
  }
  return index;
}

/** 追加一关：单次 open-append-write + fsync，无读回、无重写。 */
async function appendLevel(filePath, record) {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const line = `${JSON.stringify(record)}\n`;
  // fsync 之后再返回：断电时最坏丢最后一行（读侧会把它计入 broken 并跳过），
  // 而不是留下一个被后续追加「接上」的半截行。存档是唯一事实来源，值得这一次 fsync。
  const handle = await fs.open(filePath, 'a', 0o600);
  try {
    await handle.appendFile(line, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** 把「最后一行生效」的关卡去重、按关卡号排序——视图与答案都以这个顺序为准。 */
function orderedLevels(records) {
  return [...indexRecords(records).values()].sort(
    (a, b) => (Number(a.taskIndex) || 0) - (Number(b.taskIndex) || 0)
  );
}

/** net 记录瘦身：存档只需要「渲染与作答」需要的字段，去掉运行期中间态。 */
function toArchiveRecord(task, contentHash) {
  const record = {
    taskIndex: Number(task.taskIndex) || 0,
    title: task.title || '',
    level: task.level || '',
    type: task.type || '',
    course: task.course || '',
    // 班级的机器身份：答案目录名、篡改猴核对班级都靠它，名称会重名而码不会。
    classroomCode: task.classroomCode || '',
    experiment: task.experiment || '',
    experimentHomeworkId: Number(task.experimentHomeworkId) || 0,
    source: task.source || '',
    taskDescription: task.taskDescription || '',
    programmingRequirements: task.programmingRequirements || '',
    testDescription: task.testDescription || '',
    extraRequirements: task.extraRequirements || '',
    starterCode: task.starterCode || '',
    codeLanguage: task.codeLanguage || '',
    choices: task.choices || [],
    choiceQuestions: task.choiceQuestions || [],
    withCodeFile: Boolean(task.withCodeFile),
    codePath: task.codePath || '',
    imageMap: task.imageMap || {},
    images: (task.images || []).map((image) => image.filename),
    contentHash: contentHash || task.contentHash || '',
    capturedAt: new Date().toISOString()
  };
  return record;
}

module.exports = { ARCHIVE_NAME, readArchive, appendLevel, orderedLevels, indexRecords, toArchiveRecord };
