const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');

const ROOT = path.resolve(__dirname, '..');
const COOKIE_FILE = path.join(ROOT, '.educoder-cookie.json');
const SERVER_PORT = 43128;
const BROWSER_DATA_FILE = path.join(ROOT, '.educoder-browser-data.json');

function sendJson(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(body));
}

function safeName(value) {
  return String(value || 'untitled')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function readCookieFile() {
  try {
    const raw = await fs.readFile(COOKIE_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    return { cookie: '', userAgent: 'Mozilla/5.0' };
  }
}

async function writeCookieFile(data) {
  await fs.writeFile(COOKIE_FILE, JSON.stringify(data, null, 2), 'utf8');
}

async function writeBrowserData(data) {
  let current = {};
  try {
    current = JSON.parse(await fs.readFile(BROWSER_DATA_FILE, 'utf8'));
  } catch {}
  current[data.url] = { pageUrl: data.pageUrl || '', payload: data.payload, savedAt: new Date().toISOString() };
  await fs.writeFile(BROWSER_DATA_FILE, JSON.stringify(current, null, 2), 'utf8');
}

async function readBrowserResponse(urlPart) {
  try {
    const browserData = JSON.parse(await fs.readFile(BROWSER_DATA_FILE, 'utf8'));
    const entry = Object.entries(browserData).find(([url]) => url.includes(urlPart))?.[1];
    return entry?.payload || null;
  } catch {
    return null;
  }
}

async function fetchPage(url, session) {
  const referer = session.pageUrl || 'https://www.educoder.net/';
  const res = await fetch(url, {
    headers: {
      'Cookie': session.cookie,
      'User-Agent': session.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36',
      'Referer': referer,
      'Origin': 'https://www.educoder.net',
      'X-Requested-With': 'XMLHttpRequest',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Accept': 'application/json, text/plain, */*'
    },
    redirect: 'follow'
  });
  if (!res.ok) {
    throw new Error(`fetch failed ${res.status}: ${url}`);
  }
  return { response: res, text: await res.text() };
}

function extractCourseLinks(html) {
  const matches = [...html.matchAll(/<a[^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gis)];
  const seen = new Set();
  const result = [];
  for (const match of matches) {
    const href = match[1];
    const text = (match[2] || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (!href || !text || !/^\//.test(href)) continue;
    if (!/classrooms\//.test(href) || /announcement|students|teachers|home|p8sxailt2/.test(href)) continue;
    const normalized = text.replace(/\s+/g, ' ').trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push({ href, text: normalized });
  }
  return result.filter((item) => item.text.length > 4);
}

function extractExperimentLinks(html) {
  const matches = [...html.matchAll(/<a[^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gis)];
  const seen = new Set();
  const result = [];
  for (const match of matches) {
    const href = match[1];
    const text = (match[2] || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (!href || !text || !/\/tasks\//.test(href)) continue;
    const normalized = text.replace(/\s+/g, ' ').trim();
    if (!normalized || seen.has(href)) continue;
    seen.add(href);
    result.push({ href, text: normalized });
  }
  return result;
}

function extractTaskBodies(html) {
  const out = {};
  const title = (html.match(/<h1[^>]*>(.*?)<\/h1>/is) || html.match(/<h2[^>]*>(.*?)<\/h2>/is) || html.match(/<h3[^>]*>(.*?)<\/h3>/is) || [])[1] || '';
  const text = title.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  out.title = text || '未命名题目';
  out.body = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ');
  return out;
}

async function queryCourses(cookie) {
  const courseId = cookie.courseId || cookie.pageUrl?.match(/\/classrooms\/([^/]+)/)?.[1];
  if (courseId) {
    const infoUrl = `https://data.educoder.net/api/users/get_user_info.json?course_id=${encodeURIComponent(courseId)}&school=1&zzud=${encodeURIComponent(cookie.username || '')}`;
    const infoResult = await fetchPage(infoUrl, cookie);
    let info;
    try {
      info = JSON.parse(infoResult.text);
    } catch {
      throw new Error(`课程信息接口返回的不是 JSON（HTTP ${infoResult.response.status}）`);
    }
    if (info.status && info.status < 0) {
      throw new Error(info.message || `课程信息接口返回错误 ${info.status}`);
    }
    const course = info.course;
    if (course?.id) {
      return [{
        href: `/classrooms/${courseId}/shixun_homework`,
        text: course.course_name || `课程 ${course.id}`,
        id: courseId
      }];
    }
  }
  const username = cookie.username;
  if (!username) {
    throw new Error('未识别到登录用户名，请在头歌课程页重新点击“同步 Cookie”');
  }
  const url = `https://data.educoder.net/api/users/${encodeURIComponent(username)}/courses.json?category=&status=processing&page=1&per_page=100&sort_by=updated_at&sort_direction=desc&username=${encodeURIComponent(username)}&zzud=${encodeURIComponent(username)}`;
  const result = await fetchPage(url, cookie);
  let payload;
  try {
    payload = JSON.parse(result.text);
  } catch {
    throw new Error(`课程接口返回的不是 JSON（HTTP ${result.response.status}）`);
  }
  if (payload.status && payload.status < 0) {
    throw new Error(payload.message || `课程接口返回错误 ${payload.status}`);
  }
  const rows = payload.courses || payload.data || payload.classrooms || [];
  const courses = Array.isArray(rows) ? rows.map((item) => ({
    href: item.url || item.href || item.course_url || `/courses/${item.id}`,
    text: item.name || item.title || item.course_name || `课程 ${item.id}`
  })).filter((item) => item.href && item.text) : [];
  if (!courses.length) {
    throw new Error('课程接口未返回课程，请确认账号有进行中的课程');
  }
  return courses;
}

async function collectCourse(courseHref, cookie) {
  const courseId = cookie.courseId || courseHref.match(/\/classrooms\/([^/]+)/)?.[1];
  if (courseId) {
    const url = `https://data.educoder.net/api/courses/${encodeURIComponent(courseId)}/homework_commons.json?limit=100&status=0&id=${encodeURIComponent(courseId)}&type=4&order=0&zzud=${encodeURIComponent(cookie.username || '')}`;
    let result;
    try {
      const browserData = JSON.parse(await fs.readFile(BROWSER_DATA_FILE, 'utf8'));
      const saved = Object.entries(browserData).find(([key]) => key.includes(`/courses/${courseId}/homework_commons.json`))?.[1];
      if (saved?.payload) result = { response: { status: 200 }, text: JSON.stringify(saved.payload) };
    } catch {}
    result = result || await fetchPage(url, cookie);
    let payload;
    try {
      payload = JSON.parse(result.text);
    } catch {
      throw new Error(`课堂实验接口返回的不是 JSON（HTTP ${result.response.status}）`);
    }
    if (payload.status && payload.status < 0) {
      throw new Error(payload.message || `课堂实验接口返回错误 ${payload.status}`);
    }
    const rows = payload.homeworks || payload.homework_commons || payload.data || payload.list || [];
    const experiments = Array.isArray(rows) ? rows.map((item) => ({
      href: item.task_operation?.[1] || item.url || item.href || item.shixun_url || `/shixuns/${item.shixun_identifier || item.identifier || item.id}`,
      text: item.name || item.shixun_name || item.subject || item.title || `实验 ${item.homework_id || item.id}`,
      homeworkId: item.homework_id,
      shixunId: item.shixun_identifier,
      challengeCount: item.challenge_count || 0,
      myshixunId: item.myshixun_identifier || ''
    })).filter((item) => item.href && item.text) : [];
    for (const experiment of experiments) {
      if (!experiment.myshixunId || !experiment.homeworkId) continue;
      const challengePayload = await readBrowserResponse(`/myshixuns/${experiment.myshixunId}/challenges.json`);
      const challenges = Array.isArray(challengePayload)
        ? challengePayload
        : challengePayload?.challenges || challengePayload?.data || [];
      experiment.challenges = challenges.map((item) => ({
        name: item.name || `关卡 ${item.position || ''}`.trim(),
        position: item.position,
        identifier: item.identifier,
        status: item.status,
        finishedTime: item.finished_time
      })).filter((item) => item.identifier);
      if (experiment.challenges.length) experiment.challengeCount = experiment.challenges.length;
    }
    return { fullUrl: `https://www.educoder.net/classrooms/${courseId}/shixun_homework`, experiments: experiments.slice(0, 100), html: '' };
  }
  const fullUrl = `https://www.educoder.net${courseHref}`;
  const result = await fetchPage(fullUrl, cookie);
  const experiments = extractExperimentLinks(result.text).slice(0, 50);
  return { fullUrl, experiments, html: result.text };
}

async function saveTask(dir, title, content) {
  const fullDir = path.join(ROOT, 'exports', dir);
  await fs.mkdir(fullDir, { recursive: true });
  await fs.writeFile(path.join(fullDir, 'metadata.json'), JSON.stringify({ title, savedAt: new Date().toISOString(), source: content.source || '' }, null, 2), 'utf8');
  await fs.writeFile(path.join(fullDir, '题目.md'), content.markdown || '', 'utf8');
}

function buildMarkdown(taskTitle, bodyText) {
  return `# ${taskTitle}\n\n${bodyText}`;
}

async function runFromCookie(cookie) {
  const courses = await queryCourses(cookie);
  console.log('可用课程：');
  courses.forEach((course, index) => console.log(`${index + 1}. ${course.text} => ${course.href}`));

  const pickedIndex = Number(process.argv[2] || '1') - 1;
  const course = courses[pickedIndex];
  if (!course) throw new Error('课程编号无效');

  const experiment = await collectCourse(course.href, cookie);
  console.log('\n实验链接：');
  experiment.experiments.forEach((link, index) => {
    console.log(`${index + 1}. ${link.text}（${link.challengeCount} 个关卡）=> ${link.href}`);
    link.challenges?.forEach((challenge) => console.log(`   - ${challenge.position}. ${challenge.name} => ${challenge.identifier}`));
  });

  const chosen = experiment.experiments[Number(process.argv[3] || '1') - 1];
  if (!chosen) throw new Error('关卡编号无效');

  const taskResult = await fetchPage(`https://www.educoder.net${chosen.href}`, cookie);
  const taskHtml = taskResult.text;
  const body = extractTaskBodies(taskHtml);
  const dir = safeName(`传统抓取_${course.text}_${chosen.text}`);
  await saveTask(dir, body.title, { markdown: buildMarkdown(body.title, body.body.slice(0, 12000)), source: chosen.href });
  console.log(`\n已保存到：${path.join(ROOT, 'exports', dir)}`);
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    sendJson(res, 204, { ok: true });
    return;
  }
  if (req.method === 'GET' && req.url === '/bridge') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>Educoder bridge</title><p>Local bridge ready.</p>');
    return;
  }
  if (req.method === 'POST' && req.url === '/api/session') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        const username = payload.username || new URL(payload.pageUrl || 'https://www.educoder.net/').pathname.match(/\/users\/([^/]+)/)?.[1] || '';
        await writeCookieFile({
          cookie: payload.cookie || '',
          userAgent: payload.userAgent || '',
          pageUrl: payload.pageUrl || '',
          username,
          courseId: payload.courseId || new URL(payload.pageUrl || 'https://www.educoder.net/').pathname.match(/^\/classrooms\/([^/]+)/)?.[1] || ''
        });
        sendJson(res, 200, { ok: true, saved: true });
      } catch (error) {
        sendJson(res, 400, { ok: false, error: String(error) });
      }
    });
    return;
  }
  if (req.method === 'POST' && req.url === '/api/browser-response') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        if (!payload.url || payload.payload === undefined) throw new Error('Invalid browser response');
        await writeBrowserData(payload);
        sendJson(res, 200, { ok: true, saved: true });
      } catch (error) {
        sendJson(res, 400, { ok: false, error: String(error) });
      }
    });
    return;
  }
  if (req.method === 'GET' && req.url === '/health') {
    sendJson(res, 200, { ok: true, service: 'traditional-crawler' });
    return;
  }
  sendJson(res, 404, { ok: false, error: 'not found' });
});

async function main() {
  const session = await readCookieFile();
  if (process.argv.includes('--server')) {
    server.listen(SERVER_PORT, '127.0.0.1', () => {
      console.log(`传统抓取服务器已启动：http://127.0.0.1:${SERVER_PORT}`);
    });
    return;
  }
  if (!session.cookie) {
    console.log('未检测到浏览器 cookie。请先运行油猴脚本同步 session。');
    console.log('示例：node extractor/traditional-crawler.js --server');
    process.exitCode = 1;
    return;
  }
  await runFromCookie(session);
}

main().catch((error) => {
  console.error('traditional crawler failed:', error.message);
  process.exitCode = 1;
});
