/**
 * 关卡存档（levels.jsonl）与视图生成：
 * - 抓取时每关只追加一行存档，**不再**读回/重写整个实验文档；
 * - `实验.md` / `实验.metadata.json` 是视图，整轮结束时生成，可离线重建；
 * - last-wins：同一关再次捕获时追加新行，读取时以最后一行为准。
 *
 * 运行：node --test test/level-store.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { readArchive, appendLevel, orderedLevels, toArchiveRecord } = require('../extractor/lib/level-store');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'touge-store-'));
}

function task(index, title, extra = {}) {
  return {
    taskIndex: index,
    title,
    level: `第${index}关_${title}`,
    type: 'code',
    course: 'C',
    experiment: 'E',
    source: `https://www.educoder.net/tasks/${title}`,
    taskDescription: `任务 ${title}`,
    programmingRequirements: '补充代码。',
    starterCode: `# ${title}`,
    codeLanguage: 'python',
    images: [],
    imageMap: {},
    ...extra
  };
}

test('readArchive：不存在的存档返回空，半截行只计数不炸', async (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'levels.jsonl');

  const empty = await readArchive(file);
  assert.deepEqual(empty.records, []);
  assert.equal(empty.broken, 0);

  await fsp.writeFile(file, '{"taskIndex":1,"title":"a"}\n{"taskIndex":2,"title":\n', 'utf8');
  const partial = await readArchive(file);
  assert.equal(partial.records.length, 1, '完整的第一行要被读出来');
  assert.equal(partial.broken, 1, '半截行只计数');
  assert.equal(partial.index.get(1).title, 'a');
});

test('appendLevel + orderedLevels：只追加、按关卡号排序、同关号 last-wins', async (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'levels.jsonl');

  await appendLevel(file, toArchiveRecord(task(2, 'second'), 'h2'));
  await appendLevel(file, toArchiveRecord(task(1, 'first'), 'h1'));
  await appendLevel(file, toArchiveRecord(task(2, 'second-改'), 'h2b')); // 同一关再次捕获

  const archive = await readArchive(file);
  assert.equal(archive.records.length, 3, '三次捕获写三行（纯追加）');
  const levels = orderedLevels(archive.records);
  assert.deepEqual(levels.map((level) => level.title), ['first', 'second-改'], '排序 + 最后一行为准');
  assert.equal(levels[1].contentHash, 'h2b');
  assert.equal(archive.index.get(2).title, 'second-改');
});

test('toArchiveRecord：只保留渲染与作答需要的字段', () => {
  const record = toArchiveRecord(
    { ...task(3, 'third'), exportKind: 'code', dropReason: '', images: [{ filename: 'L003-image-1.png', base64: 'x' }] },
    'hash'
  );
  assert.equal(record.taskIndex, 3);
  assert.equal(record.contentHash, 'hash');
  assert.deepEqual(record.images, ['L003-image-1.png'], '图片只留文件名，不把 base64 写进存档');
  assert.equal(record.exportKind, undefined, '运行期字段不进存档');
  assert.equal(record.dropReason, undefined);
  assert.ok(record.capturedAt, '带捕获时间，便于判断新鲜度');
});

test('build-exports：从存档重建视图，且幂等（第二次无变化）', async (t) => {
  const { execFileSync } = require('node:child_process');
  const exportRoot = tmpDir();
  const experimentDir = path.join(exportRoot, 'C', 'E');
  fs.mkdirSync(path.join(experimentDir, 'assets'), { recursive: true });
  await appendLevel(path.join(experimentDir, 'levels.jsonl'), toArchiveRecord(task(1, 'alpha'), 'ha'));
  await appendLevel(path.join(experimentDir, 'levels.jsonl'), toArchiveRecord(task(2, 'beta'), 'hb'));
  // 视图文件先删掉，验证能从存档重建
  const markdownPath = path.join(experimentDir, 'E.md');
  assert.ok(!fs.existsSync(markdownPath));

  t.after(() => fs.rmSync(exportRoot, { recursive: true, force: true }));

  const run = () =>
    execFileSync(process.execPath, [path.join(__dirname, '..', 'tools', 'build-exports.js')], {
      encoding: 'utf8',
      env: { ...process.env, EDUCODER_EXPORT_ROOT: exportRoot }
    });

  const first = run();
  assert.match(first, /已写入\s+C \/ E：2 关/);
  const markdown = fs.readFileSync(markdownPath, 'utf8');
  assert.match(markdown, /^---\ncourse: C\nexperiment: E\nlevels: 2\n/m, 'frontmatter 由存档生成');
  assert.match(markdown, /## 第1关：alpha/);
  assert.match(markdown, /## 第2关：beta/);
  const metadata = JSON.parse(fs.readFileSync(path.join(experimentDir, 'E.metadata.json'), 'utf8'));
  assert.equal(metadata.levelCount, 2);
  assert.deepEqual(metadata.levels.map((level) => level.title), ['alpha', 'beta']);

  const second = run();
  assert.match(second, /无变化\s+C \/ E：2 关/, '第二次重建应无变化（幂等）');
});
