// ==UserScript==
// @name         头歌课程资料提取器
// @namespace    local.educoder.extractor
// @version      1.1.0
// @description  提取头歌课堂实验、关卡、选择题和代码初始模板到本地目录
// @match        https://www.educoder.net/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @connect      127.0.0.1
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const API = 'http://127.0.0.1:43127';
  const KEYS = {
    course: 'educoder-course',
    experiments: 'educoder-experiments',
    currentExperiment: 'educoder-current-experiment',
    tasks: 'educoder-task-queue',
    saved: 'educoder-saved-count',
    phase: 'educoder-phase',
    message: 'educoder-message'
  };
  const state = {
    course: GM_getValue(KEYS.course, null),
    experiments: GM_getValue(KEYS.experiments, []),
    currentExperiment: GM_getValue(KEYS.currentExperiment, ''),
    tasks: GM_getValue(KEYS.tasks, []),
    saved: GM_getValue(KEYS.saved, 0),
    phase: GM_getValue(KEYS.phase, 'idle'),
    message: GM_getValue(KEYS.message, '')
  };
  const text = (node) => (node?.innerText || node?.textContent || '').replace(/\s+/g, ' ').trim();

  function status(message, error = false) {
    console[error ? 'error' : 'log'](`[头歌提取器] ${message}`);
    state.message = message;
    if (error) state.phase = 'error';
    GM_setValue(KEYS.message, message);
    GM_setValue(KEYS.phase, state.phase);
    const node = document.querySelector('#educoder-extractor-status');
    if (node) {
      node.textContent = message;
      node.style.color = error ? '#b42318' : '#222';
    }
    const progress = document.querySelector('#educoder-extractor-progress');
    if (progress) progress.textContent = `阶段：${state.phase}｜已保存：${state.saved}`;
  }

  function setState(key, value) {
    state[key] = value;
    GM_setValue(KEYS[key], value);
  }

  function clearRun() {
    for (const key of Object.values(KEYS)) GM_deleteValue(key);
    state.course = null;
    state.experiments = [];
    state.currentExperiment = '';
    state.tasks = [];
    state.saved = 0;
    state.phase = 'idle';
    state.message = '';
  }

  function phase(value, message, error = false) {
    state.phase = value;
    GM_setValue(KEYS.phase, value);
    status(message, error);
  }

  function findReactProps(root, predicate) {
    const key = Object.keys(root || {}).find((item) => item.startsWith('__reactFiber'));
    let fiber = key ? root[key] : null;
    for (let depth = 0; fiber && depth < 25; depth += 1, fiber = fiber.return) {
      if (fiber.memoizedProps && predicate(fiber.memoizedProps)) return fiber.memoizedProps;
    }
    return null;
  }

  function reactCourseList() {
    const result = [];
    const seen = new Set();
    for (const anchor of document.querySelectorAll('a')) {
      const props = findReactProps(anchor, (value) => Array.isArray(value.dataSource));
      for (const course of props?.dataSource || []) {
        if (!course?.name || !course.first_category_url || seen.has(course.id)) continue;
        seen.add(course.id);
        result.push({
          id: course.id,
          name: String(course.name).trim(),
          classroomCode: course.first_category_url.split('/')[2],
          classroomUrl: new URL(course.first_category_url, location.origin).href
        });
      }
    }
    return result;
  }

  function currentClassroom() {
    const match = location.pathname.match(/^\/classrooms\/([^/]+)/);
    if (!match) return null;
    const name = text(document.querySelector('strong')) || document.title;
    if (!name || /头歌|实践教学平台/.test(name)) return null;
    return {
      id: '',
      name,
      classroomCode: match[1],
      classroomUrl: location.href
    };
  }

  function experimentCards() {
    return [...document.querySelectorAll('div[class*="listItem"]')].map((card) => {
      const props = findReactProps(card, (value) => value.v?.homework_id);
      const value = props?.v;
      const name = text(card.querySelector('[class*="name"]'));
      return value?.homework_id && name ? {
        name,
        homeworkId: value.homework_id,
        taskCount: value.challenge_count || 0
      } : null;
    }).filter(Boolean);
  }

  function taskData() {
    const titleNode = [...document.querySelectorAll('h3')]
      .find((node) => /^第\s*\d+\s*关/.test(text(node)));
    const title = text(titleNode) || document.title || '未命名关卡';
    const match = title.match(/^第\s*(\d+)\s*关\s*[：:]\s*(.*)$/);
    const section = (name) => {
      const heading = [...document.querySelectorAll('h4')].find((node) => text(node) === name);
      if (!heading) return '';
      const values = [];
      for (let node = heading.nextElementSibling; node; node = node.nextElementSibling) {
        if (/^H[1-4]$/.test(node.tagName)) break;
        if (text(node)) values.push(text(node));
      }
      return values.join('\n\n');
    };
    const starterCode = [...document.querySelectorAll('textarea, code, pre')]
      .map(text).filter((value) => value.length > 10)
      .sort((a, b) => b.length - a.length)[0] || '';
    const choices = [...document.querySelectorAll('label, [role="radio"], [role="checkbox"]')]
      .map(text).filter(Boolean);
    return {
      course: state.course?.name || '',
      experiment: state.currentExperiment || '',
      level: match ? `第${match[1]}关_${match[2] || '未命名'}` : title,
      title,
      type: starterCode ? 'code' : choices.length ? 'choice' : 'unsupported',
      source: location.href,
      taskDescription: section('任务描述'),
      programmingRequirements: section('编程要求'),
      testDescription: section('测试说明'),
      starterCode,
      choices: [...new Set(choices)],
      bodyText: text(document.body).slice(0, 20000)
    };
  }

  function request(path, options = {}) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: options.method || 'GET',
        url: `${API}${path}`,
        headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
        data: options.body ? JSON.stringify(options.body) : undefined,
        onload: (event) => {
          try {
            const value = JSON.parse(event.responseText || '{}');
            if (event.status >= 200 && event.status < 300 && value.ok !== false) resolve(value);
            else reject(new Error(value.error || `本地服务返回 HTTP ${event.status}`));
          } catch (error) {
            reject(error);
          }
        },
        onerror: () => reject(new Error('无法连接本地服务，请先运行 npm run writer'))
      });
    });
  }

  async function saveCurrentTask() {
    const task = taskData();
    if (!task.course) throw new Error('未识别到课程，请从课程列表重新开始');
    phase('saving-task', `正在保存 ${task.experiment} / ${task.level}`);
    await request('/api/save-task', { method: 'POST', body: task });
    setState('saved', state.saved + 1);
    phase('task-saved', `已保存：${task.experiment} / ${task.level}（累计 ${state.saved} 关）`);
  }

  function nextTask() {
    const [current, ...rest] = state.tasks;
    setState('tasks', rest);
    return current;
  }

  function taskLinks() {
    const links = [...document.querySelectorAll('a[href*="/tasks/"]')]
      .map((node) => ({ href: node.href, text: text(node) }))
      .filter((item) => item.href && item.text);
    return [...new Map(links.map((item) => [item.href, item])).values()]
      .sort((a, b) => {
        const aNumber = Number(a.text.match(/第\s*(\d+)\s*关/)?.[1] || 999999);
        const bNumber = Number(b.text.match(/第\s*(\d+)\s*关/)?.[1] || 999999);
        return aNumber - bNumber;
      });
  }

  async function waitForTaskLinks(timeout = 15000) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const links = taskLinks();
      if (links.length) return links;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return [];
  }

  async function continueChallengeIfNeeded() {
    const button = [...document.querySelectorAll('button, a, div, span')]
      .find((node) => /^继续挑战$/.test(text(node)));
    if (!button) return false;
    phase('continue-challenge', '已进入“继续挑战”页面，正在打开关卡列表');
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 1200));
    return true;
  }

  async function startExperimentList() {
    const cards = experimentCards();
    if (!cards.length) {
      status('没有识别到课堂实验卡片，请等待页面加载后刷新', true);
      return;
    }
    if (!state.experiments.length) {
      setState('experiments', cards.map((item) => item.name));
    }
    const current = cards.find((item) => item.name === state.experiments[0]);
    if (!current) throw new Error(`找不到待处理实验：${state.experiments[0] || '未命名'}`);
    setState('currentExperiment', current.name);
    setState('experiments', state.experiments.slice(1));
    phase('opening-experiment', `正在打开实验“${current.name}”，请等待页面完成加载`);
    const start = [...cardChildren(current.name)].find((node) => text(node) === '开始学习');
    if (!start) throw new Error(`实验“${current.name}”没有找到“开始学习”按钮`);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    start.click();
    setTimeout(() => {
      if (location.pathname.includes('/shixun_homework')) {
        setState('experiments', [current.name, ...state.experiments]);
        if (/验证|安全|异常|频繁|人机|captcha/i.test(text(document.body))) {
          phase('blocked', '头歌页面出现安全验证或访问限制，已停止自动操作，请按页面提示手动处理', true);
        } else {
          phase('waiting-manual', `实验“${current.name}”仍在当前页面，可能需要手动点击并等待页面响应`, true);
        }
      }
    }, 10000);
  }

  function cardChildren(name) {
    const card = [...document.querySelectorAll('div[class*="listItem"]')]
      .find((item) => text(item.querySelector('[class*="name"]')) === name);
    return card ? card.querySelectorAll('*') : [];
  }

  async function startTaskList() {
    await continueChallengeIfNeeded();
    const links = await waitForTaskLinks();
    if (!links.length) {
      status('已进入实验，但 15 秒内没有识别到关卡列表；请检查页面是否停在继续挑战或权限提示', true);
      return;
    }
    setState('tasks', links);
    phase('opening-first-task', `发现 ${links.length} 个关卡，已按第 1 关排序，正在进入第一关`);
    location.href = nextTask().href;
  }

  async function run() {
    try {
      if (location.pathname.includes('/tasks/')) {
        await saveCurrentTask();
        const next = nextTask();
        if (next) location.href = next.href;
        else if (state.experiments.length) location.href = `${location.origin}/classrooms/${state.course.classroomCode}/shixun_homework`;
        else phase('completed', `课程提取完成，共保存 ${state.saved} 个关卡`);
        return;
      }
      if (location.pathname.includes('/shixuns/')) {
        if (/404|不存在|找不到/i.test(text(document.body))) {
          throw new Error(`头歌返回 404：${location.pathname}。已停止自动跳转，请从实验卡片重新进入`);
        }
        await startTaskList();
        return;
      }
      if (location.pathname.includes('/shixun_homework')) {
        await startExperimentList();
      }
    } catch (error) {
      status(error.message, true);
    }
  }

  function addPanel() {
    if (document.querySelector('#educoder-extractor-panel')) return;
    const panel = document.createElement('aside');
    panel.id = 'educoder-extractor-panel';
    panel.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:99999;background:#fff;color:#222;padding:14px;width:320px;border:1px solid #bbb;border-radius:8px;box-shadow:0 4px 20px #0003;font:14px sans-serif';
    panel.innerHTML = '<b>头歌资料提取器 v1.2</b><div id="educoder-extractor-status" style="margin:10px 0">检测本地服务...</div><div id="educoder-extractor-progress" style="font-size:12px;color:#666;margin-bottom:8px"></div><select id="educoder-extractor-courses" style="width:100%;margin-bottom:8px"></select><div><button id="educoder-extractor-start">开始提取</button> <button id="educoder-extractor-reset">重置</button></div>';
    document.body.appendChild(panel);
    const select = panel.querySelector('#educoder-extractor-courses');
    const courses = reactCourseList();
    const current = currentClassroom();
    if (!courses.length && current) courses.push(current);
    select.innerHTML = courses.map((item, index) => `<option value="${index}">${item.name}</option>`).join('');
    const progress = panel.querySelector('#educoder-extractor-progress');
    progress.textContent = `阶段：${state.phase}｜已保存：${state.saved}`;
    request('/health').then(() => {
      if (state.message) status(state.message, state.phase === 'error');
      else status(courses.length ? '服务已连接，请选择课程' : '服务已连接，但未识别课程', !courses.length);
    }).catch((error) => status(error.message, true));
    panel.querySelector('#educoder-extractor-start').addEventListener('click', () => {
      const course = courses[Number(select.value)];
      if (!course) return status('没有可选择的课程', true);
      setState('course', course);
      setState('experiments', []);
      setState('tasks', []);
      setState('saved', 0);
      phase('opening-experiment-list', `已选择：${course.name}，正在进入课堂实验`);
      location.href = `${location.origin}/classrooms/${course.classroomCode}/shixun_homework`;
    });
    panel.querySelector('#educoder-extractor-reset').addEventListener('click', () => {
      clearRun();
      status('已重置，请重新选择课程');
    });
  }

  setTimeout(() => {
    addPanel();
    run();
  }, 1200);
})();
