'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { chromium } = require('playwright');
const { startUiServer } = require('../extractor/ui/server');

const ROOT = path.join(__dirname, '..');
const CLASSROOM = { name: '数据库系统原理', code: 'DEMO001', id: 1 };
let browser;

test.before(async () => {
  await fs.mkdir(path.join(ROOT, '.shots'), { recursive: true });
  browser = await chromium.launch({ channel: 'chromium', headless: true });
});
test.after(async () => { if (browser) await browser.close(); });

async function fixture(t, { viewport = { width: 1440, height: 1040 }, colorScheme = 'light', onControl } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'touge-console-ui-'));
  const prior = process.env.EDUCODER_EXPORT_ROOT;
  process.env.EDUCODER_EXPORT_ROOT = root;
  // Answers-only fixture: no levels.jsonl or question directory exists.
  const folder = path.join(root, 'answers', '数据库系统原理（DEMO001）');
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, 'MySQL-数据的插入、修改与删除.answers.json'), JSON.stringify({
    schema_version: 2, classroom: CLASSROOM,
    experiment: { name: 'MySQL-数据的插入、修改与删除', homework_id: 123 },
    answers: [{
      level_id: 'L001', task_identifier: 'sql-task', title: '插入数据', kind: 'code', source: 'platform', verified: true,
      answer: { language: 'sql', code: 'INSERT INTO sample VALUES (1);\n' }
    }]
  }));
  const actions = [];
  const ui = await startUiServer({ open: false, onControl: async (action, payload) => {
    actions.push({ action, payload });
    return onControl ? onControl(action, payload) : { ok: true };
  } });
  ui.setSnapshot({
    phase: 'waiting-course', loggedIn: true, user: '示例账号', message: '选择课程与抓取范围，题目可交给 Agent 补全。',
    courses: [CLASSROOM, { id: 2, name: '软件工程导论', code: 'DEMO002' }, { id: 3, name: '机器学习', code: 'DEMO003' }],
    experiments: [], levels: [], progress: { saved: 0, skipped: 0, failed: 0, current: 0, total: 0 }
  });
  const context = await browser.newContext({ viewport, colorScheme, acceptDownloads: true });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text) => { window.__copied = text; } } });
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  t.after(async () => {
    await context.close();
    await ui.close();
    if (prior === undefined) delete process.env.EDUCODER_EXPORT_ROOT;
    else process.env.EDUCODER_EXPORT_ROOT = prior;
    await fs.rm(root, { recursive: true, force: true });
    assert.deepEqual(errors, [], 'console must not throw browser errors');
  });
  await page.goto(ui.url);
  await page.waitForFunction(() => document.getElementById('agent-answered').textContent === '1');
  return { page, ui, root, actions, errors };
}

test('控制台浏览器：展示 Agent 工作流和仅答案产物，下载完整说明', async (t) => {
  const { page } = await fixture(t);
  assert.equal(await page.locator('h1').innerText(), '课程资料工作台');
  assert.equal(await page.locator('[data-view-target]').count(), 2);
  assert.equal(await page.locator('#panel-virtual').count(), 0);
  assert.equal(await page.locator('#panel-agent').isVisible(), false);
  await page.locator('[data-view-target="handoff"]').click();
  assert.equal(await page.locator('#panel-answer, #btn-answer-run, #answer-model-name').count(), 0);
  assert.equal(await page.locator('#agent-experiments').textContent(), '1');
  assert.equal(await page.locator('#agent-levels').textContent(), '1');
  assert.match(await page.locator('#agent-catalog').innerText(), /数据库系统原理/);
  const downloading = page.waitForEvent('download');
  await page.locator('#btn-agent-guide').click();
  const download = await downloading;
  assert.equal(download.suggestedFilename(), 'AGENT-ANSWERING.md');
  const guide = await fs.readFile(await download.path(), 'utf8');
  assert.match(guide, /schema_version/);
  assert.match(guide, /verified/);
  assert.match(guide, /只抓取已有答案/);
  const raiseColor = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--raise').trim());
  assert.ok(raiseColor, 'semantic CSS tokens must be inside a valid selector');
});

test('控制台浏览器：复制 Agent 任务包含真实工作路径，复制连接地址为独立动作', async (t) => {
  const { page, ui } = await fixture(t);
  await page.locator('[data-view-target="handoff"]').click();
  await page.locator('#btn-agent-copy').click();
  // copyAgentTask 是异步的（先拉本地资料、再写剪贴板）；不等待就是抢跑读 undefined。
  await page.waitForFunction(() => Boolean(window.__copied));
  const task = await page.evaluate(() => window.__copied);
  assert.match(task, /docs\/AGENT-ANSWERING.md/);
  assert.match(task, /工作答案：.*answers\.json/);
  assert.match(task, /schema_version: 2/);
  assert.ok(!task.includes(new URL(ui.url).searchParams.get('token')), 'Agent task must not carry console credentials');
  await page.locator('#btn-console-copy').click();
  assert.equal(await page.evaluate(() => window.__copied), ui.url);
});

test('控制台浏览器：只抓答案模式随选择提交，运行中锁定设置', async (t) => {
  const { page, ui, actions } = await fixture(t);
  await page.locator('#opt-answers-only').check();
  assert.match(await page.locator('#mode-description').innerText(), /不保存题目/);
  await page.locator('#list-courses input').first().check();
  await page.locator('#btn-course').click();
  await page.waitForFunction(() => document.getElementById('btn-course').disabled);
  assert.equal(actions[0].action, 'select-course');
  assert.equal(actions[0].payload.answersOnly, true);
  assert.equal(actions[0].payload.skipExisting, true);
  ui.emit({ type: 'status', phase: 'running', message: '抓取中' });
  await page.waitForFunction(() => document.getElementById('opt-answers-only').disabled);
  assert.equal(await page.locator('#opt-redownload').isDisabled(), true);
});

test('控制台浏览器：选择请求发出后立即锁定抓取模式', async (t) => {
  let finish, entered;
  const waiting = new Promise((resolve) => { finish = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  const { page } = await fixture(t, { onControl: () => { entered(); return waiting; } });
  await page.locator('#list-courses input').first().check();
  await page.locator('#btn-course').click();
  await started;
  try {
    assert.equal(await page.locator('#opt-answers-only').isDisabled(), true);
    assert.equal(await page.locator('#opt-redownload').isDisabled(), true);
    assert.equal(await page.locator('#btn-course').isDisabled(), true);
  } finally { finish({ ok: true }); }
});

test('控制台浏览器：搜索保留原始实验序号，批量操作保留搜索范围外的选择', async (t) => {
  const { page, ui, actions } = await fixture(t);
  await page.waitForFunction(() => document.getElementById('chip-conn-text').textContent.includes('已连接'));
  await page.locator('#search-courses').fill('demo002');
  assert.equal(await page.locator('#list-courses input').count(), 1);
  await page.locator('#list-courses input').check();
  await page.locator('#search-courses').fill('');
  assert.equal(await page.locator('#list-courses input').nth(1).isChecked(), true);
  ui.emit({ type: 'experiments', experiments: [
    { name: 'SQL 基础', homeworkId: 101, taskCount: 2 },
    { name: 'Linux 基础', homeworkId: 102, taskCount: 3 },
    { name: '图形设计', homeworkId: 103, taskCount: 4 }
  ] });
  ui.emit({ type: 'status', phase: 'waiting-experiments' });
  await page.locator('#list-experiments input').first().check();
  await page.locator('#search-experiments').fill('图形');
  await page.locator('[data-target="experiments"][data-bulk="all"]').click();
  assert.equal(await page.locator('#badge-experiments').textContent(), '已选 2 / 3');
  await page.locator('[data-target="experiments"][data-bulk="none"]').click();
  assert.equal(await page.locator('#badge-experiments').textContent(), '已选 1 / 3');
  await page.locator('[data-target="experiments"][data-bulk="invert"]').click();
  await page.locator('#search-experiments').fill('');
  assert.equal(await page.locator('#list-experiments input').nth(0).isChecked(), true);
  assert.equal(await page.locator('#list-experiments input').nth(1).isChecked(), false);
  assert.equal(await page.locator('#list-experiments input').nth(2).isChecked(), true);
  await page.locator('#btn-experiments').click();
  assert.deepEqual(actions[0].payload.indices, [0, 2]);
});

test('控制台浏览器：不同实验的同序号关卡独立勾选，过滤全选跳过已有答案', async (t) => {
  const { page, ui, actions } = await fixture(t);
  await page.waitForFunction(() => document.getElementById('chip-conn-text').textContent.includes('已连接'));
  const levels = [
    { experimentIndex: 0, experimentName: '实验甲', name: '建表', position: 1, challengeId: 'shared', type: 'code' },
    { experimentIndex: 1, experimentName: '实验乙', name: '建表', position: 1, challengeId: 'shared', type: 'code' },
    { experimentIndex: 1, experimentName: '实验乙', name: '删除数据', position: 2, identifier: 'b2', type: 'choice', localDone: { answered: true } }
  ];
  ui.emit({ type: 'levels', multi: true, levels, experimentNames: ['实验甲', '实验乙'] });
  ui.emit({ type: 'status', phase: 'waiting-levels' });
  await page.locator('#search-levels').fill('实验乙');
  await page.locator('[data-target="levels"][data-bulk="all"]').click();
  assert.equal(await page.locator('#badge-levels').textContent(), '已选 1 / 3');
  await page.locator('#search-levels').fill('');
  assert.equal(await page.locator('#list-levels input').nth(0).isChecked(), false);
  assert.equal(await page.locator('#list-levels input').nth(1).isChecked(), true);
  assert.equal(await page.locator('#list-levels input').nth(2).isChecked(), false);
  await page.screenshot({ path: path.join(ROOT, '.shots', 'console-level-selection.png'), fullPage: true, animations: 'disabled' });
  await page.locator('#btn-levels').click();
  assert.equal(actions[0].payload.levels.length, 1);
  assert.equal(actions[0].payload.levels[0].experimentIndex, 1);
  assert.deepEqual(ui.getSnapshot().selectedLevels, [levels[1]]);
});

test('控制台浏览器：刷新恢复同名实验时按作业身份勾选', async (t) => {
  const { page, ui } = await fixture(t);
  const experiments = [{ name: '同名实验', homeworkId: 100 }, { name: '同名实验', homeworkId: 200 }];
  ui.setSnapshot({ phase: 'waiting-experiments', experiments, selectedExperiments: [experiments[1]] });
  await page.reload();
  await page.locator('#list-experiments input').nth(1).waitFor();
  assert.equal(await page.locator('#list-experiments input').nth(0).isChecked(), false);
  assert.equal(await page.locator('#list-experiments input').nth(1).isChecked(), true);
});

test('控制台浏览器：实时进度、保存、复用与重置事件保持有效', async (t) => {
  const { page, ui } = await fixture(t);
  await page.waitForFunction(() => document.getElementById('chip-conn-text').textContent.includes('已连接'));
  ui.emit({ type: 'status', phase: 'running' });
  ui.emit({ type: 'progress', saved: 2, current: 3, total: 6 });
  await page.waitForFunction(() => document.getElementById('count-saved').textContent === '2');
  assert.equal(await page.locator('#badge-progress').textContent(), '3 / 6');
  ui.emit({ type: 'saved', title: '插入数据', level: '第1关 插入数据', taskType: 'code', images: 0, path: 'exports/example.md' });
  await page.locator('#panel-extracted').waitFor();
  assert.match(await page.locator('#extracted-list').innerText(), /插入数据/);
  ui.emit({ type: 'reused', title: '删除数据', level: '第2关 删除数据', taskType: 'code', images: 0, path: 'exports/reused.md' });
  await page.waitForFunction(() => document.getElementById('extracted-list').textContent.includes('删除数据'));
  ui.emit({ type: 'reset' });
  await page.waitForFunction(() => document.getElementById('panel-extracted').hidden);
  assert.equal(await page.locator('#count-saved').textContent(), '0');
});

test('控制台浏览器：复制任务严格限制课堂码及所选实验，空范围不扩大', async (t) => {
  const { page, ui, root } = await fixture(t);
  await page.locator('[data-view-target="handoff"]').click();
  const original = JSON.parse(await fs.readFile(path.join(root, 'answers', '数据库系统原理（DEMO001）', 'MySQL-数据的插入、修改与删除.answers.json'), 'utf8'));
  const otherClass = path.join(root, 'answers', '数据库系统原理（DEMO099）');
  await fs.mkdir(otherClass, { recursive: true });
  await fs.writeFile(path.join(otherClass, '同名课堂实验.answers.json'), JSON.stringify({ ...original,
    classroom: { ...CLASSROOM, code: 'DEMO099' }, experiment: { name: '同名课堂实验', homework_id: 999 }
  }));
  await fs.writeFile(path.join(root, 'answers', '数据库系统原理（DEMO001）', '未选实验.answers.json'), JSON.stringify({ ...original,
    experiment: { name: '未选实验', homework_id: 456 }
  }));
  ui.setSnapshot({ selectedCourse: { name: CLASSROOM.name, classroomCode: CLASSROOM.code },
    selectedExperiments: [{ name: original.experiment.name, homeworkId: 123 }] });
  await page.reload();
  await page.locator('#btn-agent-copy').click();
  await page.waitForFunction(() => Boolean(window.__copied));
  const task = await page.evaluate(() => window.__copied);
  assert.match(task, /MySQL-数据的插入、修改与删除/);
  assert.ok(!task.includes('DEMO099'));
  assert.ok(!task.includes('未选实验'));
  ui.setSnapshot({ selectedCourse: { name: '未抓取课程', classroomCode: 'NONE' }, selectedExperiments: [] });
  await page.reload();
  await page.locator('#btn-agent-copy').click();
  await page.waitForFunction(() => Boolean(window.__copied));
  const empty = await page.evaluate(() => window.__copied);
  assert.match(empty, /尚无可匹配/);
  assert.ok(!empty.includes('MySQL-数据的插入、修改与删除'));
});

test('控制台浏览器：仅答案文件可通过表单导出班级 v2，刷新保留班级字段', async (t) => {
  const { page, root } = await fixture(t);
  await page.locator('[data-view-target="handoff"]').click();
  await page.locator('#publish-grade').fill('2024级');
  await page.locator('#publish-class').fill('测试班');
  await page.locator('#btn-publish').click();
  await page.locator('#publish-result').waitFor();
  const published = JSON.parse(await fs.readFile(path.join(root, 'answers', '2024级-测试班.answers.json'), 'utf8'));
  assert.equal(published.version, 2);
  assert.equal(published.kind, 'class-answers');
  assert.equal(published.classrooms[0].code, CLASSROOM.code);
  assert.equal(published.classrooms[0].experiments[0].levels[0].answer.code, 'INSERT INTO sample VALUES (1);');
  await page.reload();
  await page.locator('#publish-form').waitFor();
  assert.equal(await page.locator('#publish-grade').inputValue(), '2024级');
  assert.equal(await page.locator('#publish-class').inputValue(), '测试班');
});

test('控制台浏览器：桌面、窄屏与深色布局无横向溢出，设置卡片易于点击', async (t) => {
  await fs.mkdir(path.join(ROOT, '.shots'), { recursive: true });
  for (const [name, viewport, colorScheme] of [
    ['desktop', { width: 1440, height: 1040 }, 'light'],
    ['compact', { width: 1100, height: 900 }, 'light'],
    ['tablet', { width: 820, height: 1024 }, 'light'],
    ['mobile', { width: 390, height: 844 }, 'light'],
    ['dark', { width: 1440, height: 1040 }, 'dark']
  ]) {
    const { page } = await fixture(t, { viewport, colorScheme });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), name);
    const progress = await page.locator('#panel-progress').boundingBox();
    assert.ok(progress.width >= Math.min(280, viewport.width - 28), `${name}: the progress panel must use the available column width`);
    for (const card of await page.locator('.mode-card').all()) {
      const bounds = await card.boundingBox();
      assert.ok(bounds.width >= 200 && bounds.height >= 100, `${name}: settings need a complete, comfortable click target`);
    }
    const toggle = await page.locator('#opt-answers-only').boundingBox();
    assert.ok(Math.round(toggle.width) >= 44 && Math.round(toggle.height) >= 28, `${name}: the switch must be legible: ${JSON.stringify(toggle)}`);
    await page.locator('.mode-option .mode-title').click();
    assert.equal(await page.locator('#opt-answers-only').isChecked(), true, `${name}: clicking the card label must toggle the option`);
    await page.locator('#opt-answers-only').focus();
    await page.keyboard.press('Space');
    assert.equal(await page.locator('#opt-answers-only').isChecked(), false, `${name}: keyboard controls must work`);
    await page.locator('#workspace-title').click();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: path.join(ROOT, '.shots', `console-${name}.png`), fullPage: true, animations: 'disabled' });
    if (name === 'desktop') await page.screenshot({ path: path.join(ROOT, '.shots', 'console-overview.png'), animations: 'disabled' });
    await page.locator('#opt-answers-only').check();
    await page.locator('#workspace-title').click();
    await page.locator('#extract-options').screenshot({ path: path.join(ROOT, '.shots', `console-settings-${name}.png`), animations: 'disabled' });
    await page.locator('#opt-answers-only').uncheck();
    for (const view of ['handoff']) {
      await page.locator(`[data-view-target="${view}"]`).click();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${name}/${view}`);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: path.join(ROOT, '.shots', `console-${name}-${view}.png`), fullPage: true, animations: 'disabled' });
    }
  }
});
