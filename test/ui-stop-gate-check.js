/**
 * 验证「停止」按钮在各阶段的可点击性。
 * 之前 can('stop') 用枚举漏掉了 courses / levels 等阶段，导致读课程、读实验时无法中止。
 * 本脚本用一个假后端 + 真实 SSE 推送驱动页面，逐个阶段检查按钮状态。
 *
 * 运行：node test/ui-stop-gate.test.js
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'extractor', 'ui', 'public', 'index.html'), 'utf8');
const TOKEN = 'stopgate';

const snapshot = {
  phase: 'starting',
  message: '就绪',
  user: null,
  loggedIn: false,
  courses: [],
  experiments: [],
  levels: [],
  selectedCourse: null,
  selectedExperiments: [],
  selectedLevels: [],
  progress: { saved: 0, skipped: 0, failed: 0, current: 0, total: 0 },
  logs: [],
  extracted: [],
  done: null
};

const clients = new Set();

/**
 * 假服务器要像真服务器一样维护快照：saved/reused 累积「已提取内容」、reset 清空。
 * 只做纯广播会让 /api/state 与实际事件脱节，测不出真实行为。
 */
function applyFakeEvent(evt) {
  if (evt.type === 'progress') {
    snapshot.progress = { ...snapshot.progress, ...evt };
    delete snapshot.progress.type;
    return;
  }
  if (evt.type === 'saved' || evt.type === 'reused') {
    snapshot.extracted.push({
      status: evt.type === 'reused' || evt.status === 'reused' ? 'reused' : 'saved',
      title: String(evt.title || ''),
      level: String(evt.level || evt.title || ''),
      taskType: String(evt.taskType || ''),
      images: Number.isFinite(evt.images) ? evt.images : 0,
      path: String(evt.path || ''),
      experiment: String(snapshot.progress.experimentName || ''),
      course: String(snapshot.progress.courseName || (snapshot.selectedCourse && snapshot.selectedCourse.name) || '')
    });
    return;
  }
  if (evt.type === 'reset') {
    snapshot.courses = [];
    snapshot.experiments = [];
    snapshot.levels = [];
    snapshot.selectedCourse = null;
    snapshot.extracted = [];
    snapshot.done = null;
    snapshot.phase = 'starting';
    return;
  }
  if (evt.type === 'status' && evt.phase) snapshot.phase = evt.phase;
  if (evt.type === 'done') snapshot.done = evt;
}

function startFakeServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(HTML);
      return;
    }
    if (url.pathname === '/api/state') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(snapshot));
      return;
    }
    if (url.pathname === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      });
      res.write(': connected\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (url.pathname === '/api/action') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        // 与真服务器一致：reset 动作也会清空快照（引擎会另发 reset 事件，这里保证顺序无关）
        try {
          const parsed = JSON.parse(body || '{}');
          if (parsed.action === 'reset') applyFakeEvent({ type: 'reset' });
          if (parsed.action === 'start') snapshot.phase = 'starting';
        } catch { /* 忽略非法请求体 */ }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true }));
      });
      return;
    }
    res.writeHead(404).end('{}');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function pushStatus(phase, message = '') {
  snapshot.phase = phase;
  snapshot.message = message;
  const frame = `data: ${JSON.stringify({ type: 'status', phase, message })}\n\n`;
  for (const client of clients) client.write(frame);
}

const results = [];
function check(name, ok, extra = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  ${extra}` : ''}`);
}

(async () => {
  const realChromium = require('playwright').chromium;
  const { server, port } = await startFakeServer();
  const browser = await realChromium.launch({ channel: 'chromium' });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));

  try {
    await page.goto(`http://127.0.0.1:${port}/?token=${TOKEN}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(600);

    const stop = page.locator('#btn-stop');
    const start = page.locator('#btn-start');

    check('starting：停止按钮禁用（引擎未启动）', await stop.isDisabled());
    check('starting：开始按钮可用', await start.isEnabled());

    // 引擎存活期间的所有阶段都必须能停止
    for (const phase of [
      'browser',
      'login',
      'waiting-login',
      'courses',
      'waiting-course',
      'levels',
      'waiting-experiments',
      'waiting-levels',
      'running',
      'stopping'
    ]) {
      pushStatus(phase, `阶段 ${phase}`);
      await page.waitForTimeout(150);
      const enabled = await stop.isEnabled();
      check(`阶段 ${phase}：停止按钮可用`, enabled);
    }

    // 终态不可停止，但**必须可以再次开始**（否则就成了「一次性」工具）
    for (const phase of ['done', 'error']) {
      pushStatus(phase, `阶段 ${phase}`);
      await page.waitForTimeout(150);
      check(`阶段 ${phase}：停止按钮禁用（已结束）`, await stop.isDisabled());
      check(`阶段 ${phase}：开始按钮可用（可再次提取）`, await start.isEnabled());
    }

    // 引擎存活期间不可重复启动
    for (const phase of ['browser', 'waiting-course', 'running']) {
      pushStatus(phase, `阶段 ${phase}`);
      await page.waitForTimeout(150);
      check(`阶段 ${phase}：开始按钮禁用（任务进行中）`, await start.isDisabled());
    }

    // 终态下点「开始提取」：必须真的发出 start 动作，并收起上一轮结果面板
    let startPosted = false;
    page.on('request', (request) => {
      const body = request.postData() || '';
      if (request.method() === 'POST' && body.includes('"start"')) startPosted = true;
    });
    pushStatus('done', '抓取完成');
    await page.waitForTimeout(200);
    await start.click();
    await page.waitForTimeout(500);
    check('终态下点击「开始提取」会发出 start 动作', startPosted);
    check('再次开始后结果面板收起', await page.locator('#panel-done').isHidden());

    // ---- 「已提取内容」面板 + 开始/继续分开 ----
    const pushEvent = (event) => {
      applyFakeEvent(event);
      const frame = `data: ${JSON.stringify(event)}\n\n`;
      for (const client of clients) client.write(frame);
    };
    // 先让快照里带上课程名（与真实流程一致：选课程后才有 courseName）
    snapshot.selectedCourse = { name: '示例课程A', classroomCode: 'zqf25f66' };
    pushEvent({ type: 'progress', experimentName: '单元测试', courseName: '示例课程A', saved: 0, current: 0, total: 2 });
    pushEvent({ type: 'saved', title: '使用Junit进行单元测试', level: '第1关_使用Junit进行单元测试', taskType: 'choice', images: 1, path: 'x/题目.md', directory: 'x', course: '示例课程A', experiment: '单元测试' });
    pushEvent({ type: 'reused', title: '单元测试覆盖率', level: '第2关_单元测试覆盖率', taskType: 'choice', path: 'y/题目.md', directory: 'y', course: '示例课程A', experiment: '单元测试' });
    await page.waitForTimeout(400);

    const panelExtracted = page.locator('#panel-extracted');
    check('已提取内容面板出现', await panelExtracted.isVisible());
    check('已提取内容计数为 2', (await page.locator('#extracted-badge').textContent()) === '2');
    const summary = await page.locator('#extracted-summary').textContent();
    check('汇总含「新保存 1」「复用已存在 1」', /新保存 1/.test(summary) && /复用已存在 1/.test(summary), summary);
    const listText = await page.locator('#extracted-list').textContent();
    check('列表含课程与实验归组', /示例课程A/.test(listText) && /单元测试/.test(listText), listText.slice(0, 120));
    check('列表含两个关卡', /使用Junit进行单元测试/.test(listText) && /单元测试覆盖率/.test(listText));

    const restart = page.locator('#btn-restart');
    const cont = page.locator('#btn-continue');
    check('存在「开始提取（清空重来）」按钮', (await restart.count()) === 1);
    check('存在「继续提取（保留）」按钮', (await cont.count()) === 1);
    check('两个按钮都可见可点', (await cont.isEnabled()) && (await restart.isEnabled()));

    // 未勾选/未启动时的门控：任务进行中两个按钮都不可点
    pushStatus('running', '抓取中');
    await page.waitForTimeout(200);
    check('任务进行中：「继续提取」不可点', await cont.isDisabled());
    check('任务进行中：「开始提取」不可点', await restart.isDisabled());

    // 两个按钮各自发出正确的动作
    let posted = [];
    page.on('request', (request) => {
      if (request.method() !== 'POST') return;
      const body = request.postData() || '';
      const matched = body.match(/"action":"([a-z-]+)"/);
      if (matched) posted.push(matched[1]);
    });

    pushStatus('done', '提取结束');
    await page.waitForTimeout(200);
    // 元素可能在面板隐藏状态，用 JS 直接触发 click（这里验证的是动作语义）。
    await cont.evaluate((node) => node.click());
    await page.waitForTimeout(300);
    check('「继续提取」发出 start（不清空）', posted.includes('start'), posted.join(','));

    posted = [];
    pushStatus('done', '提取结束');
    await page.waitForTimeout(200);
    await restart.evaluate((node) => node.click());
    await page.waitForTimeout(300);
    check('「开始提取」发出 reset（清空重来）', posted.includes('reset'), posted.join(','));
    check('清空后已提取内容面板隐藏', await panelExtracted.isHidden());
    check('清空后提取结果为 0', (await page.locator('#extracted-badge').textContent()) === '0' || await panelExtracted.isHidden());

    check('页面无脚本错误', errors.length === 0, errors.slice(0, 2).join(' | '));

    const failed = results.filter((item) => !item.ok);
    console.log(`\n=== ${results.length - failed.length}/${results.length} PASS ===`);
    process.exitCode = failed.length ? 1 : 0;
  } finally {
    await browser.close();
    server.close();
  }
})().catch((e) => {
  console.error(`验证失败：${e.message}`);
  process.exitCode = 1;
});
