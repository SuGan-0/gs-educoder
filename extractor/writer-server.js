const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');

const PORT = 43127;
const EXPORT_ROOT = path.resolve(__dirname, '..', 'exports');

function safeName(value) {
  return String(value || 'untitled')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function send(response, status, body) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  response.end(JSON.stringify(body));
}

function markdown(task) {
  const sections = [
    `# ${task.title || task.level}`,
    '',
    `- 课程：${task.course}`,
    `- 实验：${task.experiment}`,
    `- 关卡：${task.level}`,
    `- 类型：${task.type}`,
    `- 来源：${task.source}`,
    '',
    '## 任务描述',
    '',
    task.taskDescription || '页面未识别到任务描述。',
    '',
    '## 编程要求',
    '',
    task.programmingRequirements || '页面未识别到编程要求。',
    '',
    '## 测试说明',
    '',
    task.testDescription || '页面未识别到测试说明。'
  ];
  if (task.choices?.length) {
    sections.push('', '## 选项', '', ...task.choices.map((item, index) => `${index + 1}. ${item}`));
  }
  return sections.join('\n');
}

async function saveTask(task) {
  const folder = path.join(
    EXPORT_ROOT,
    safeName(task.course),
    safeName(task.experiment),
    safeName(task.level)
  );
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, 'metadata.json'), JSON.stringify(task, null, 2), 'utf8');
  await fs.writeFile(path.join(folder, '题目.md'), markdown(task), 'utf8');
  if (task.starterCode) {
    await fs.writeFile(path.join(folder, '初始代码.txt'), task.starterCode, 'utf8');
  }
  return folder;
}

const server = http.createServer(async (request, response) => {
  if (request.method === 'OPTIONS') {
    send(response, 204, { ok: true });
    return;
  }
  if (request.method === 'GET' && request.url === '/health') {
    send(response, 200, { ok: true, service: 'educoder-writer' });
    return;
  }
  if (request.method !== 'POST' || request.url !== '/api/save-task') {
    send(response, 404, { ok: false, error: 'Not found' });
    return;
  }

  let body = '';
  request.setEncoding('utf8');
  request.on('data', (chunk) => {
    body += chunk;
    if (body.length > 5 * 1024 * 1024) request.destroy();
  });
  request.on('end', async () => {
    try {
      const task = JSON.parse(body);
      if (!task || typeof task !== 'object' || !task.course || !task.level) {
        throw new Error('Invalid task payload');
      }
      const folder = await saveTask(task);
      send(response, 200, { ok: true, folder });
    } catch (error) {
      send(response, 400, { ok: false, error: error.message });
    }
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`头歌本地写入服务已启动：http://127.0.0.1:${PORT}`);
  console.log(`输出目录：${EXPORT_ROOT}`);
});
