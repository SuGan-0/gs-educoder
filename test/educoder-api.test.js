'use strict';

/**
 * extractor/lib/educoder-api.js 离线单元测试（无网络、无浏览器、无账号）。
 * 用 stub page 模拟 page.evaluate 返回不同响应，验证契约 docs/ARCHITECTURE.md 第 2 节。
 *
 * 运行：node --test test/educoder-api.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const api = require('../extractor/lib/educoder-api');

const AUTH_USER = 'p8sxailt2';
const MODULE_PATH = path.join(__dirname, '..', 'extractor', 'lib', 'educoder-api.js');
const COURSES_URL = (index, perPage) => 'https://data.educoder.net/api/users/p8sxailt2/courses.json'
  + `?category=&status=processing&page=${index}&per_page=${perPage}`
  + '&sort_by=updated_at&sort_direction=desc&username=p8sxailt2';

/**
 * 假 page：记录 evaluate 的 url / headers / 回调源码，返回 handler 预置的 {status, body}。
 *
 * 两种参数形态都要接受：apiGet 传对象 `{ url, headers }`（签名头），
 * 图片回调仍传字符串 URL。
 */
function stubPage(handler) {
  const calls = [];
  return {
    calls,
    evaluate(fn, arg) {
      const url = typeof arg === 'string' ? arg : String((arg && arg.url) || '');
      const headers = arg && typeof arg === 'object' ? arg.headers : undefined;
      calls.push({ url, headers, source: Function.prototype.toString.call(fn) });
      const result = handler(url, calls.length);
      return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
    }
  };
}

const ok = (body) => ({ status: 200, body });
const courseItem = (id, name, code) => ({ id, name, first_category_url: `/classrooms/${code}/announcement` });

// ---------------------------------------------------------------- apiGet

test('apiGet：在浏览器上下文 fetch（credentials: include）并返回 {ok,status,text,json}', async () => {
  const page = stubPage(() => ok('{"count":1,"courses":[]}'));
  const response = await api.apiGet(page, 'https://data.educoder.net/api/thing.json');
  assert.equal(response.ok, true);
  assert.equal(response.status, 200);
  assert.equal(response.text, '{"count":1,"courses":[]}');
  assert.deepEqual(response.json(), { count: 1, courses: [] });
  assert.equal(page.calls[0].url, 'https://data.educoder.net/api/thing.json');
  assert.match(page.calls[0].source, /fetch\(/, '必须用浏览器内 fetch');
  assert.match(page.calls[0].source, /credentials:\s*'include'/, '必须带 credentials: include');
});

test('apiGet：每个请求都带签名头与 X-EDU-Type: pc（-102 的真实修复点）', async () => {
  const page = stubPage(() => ok('{"count":1,"courses":[]}'));
  await api.apiGet(page, 'https://data.educoder.net/api/thing.json');
  const { headers } = page.calls[0];
  assert.ok(headers, '必须把签名头传进页面');
  assert.match(headers['X-EDU-Timestamp'], /^\d{13}$/, '毫秒时间戳');
  assert.match(headers['X-EDU-Signature'], /^[0-9a-f]{32}$/, 'md5 十六进制');
  assert.equal(headers['X-EDU-Type'], 'pc', 'X-EDU-Type 必须精确为 pc，写成 web 会被拒');
});

test('apiGet：签名里的 method 跟随入参（GET/POST 不可混用）', async () => {
  const get = stubPage(() => ok('{}'));
  await api.apiGet(get, 'https://data.educoder.net/api/x.json');
  const post = stubPage(() => ok('{}'));
  await api.apiGet(post, 'https://data.educoder.net/api/x.json', { method: 'POST' });
  assert.notEqual(
    get.calls[0].headers['X-EDU-Signature'],
    post.calls[0].headers['X-EDU-Signature'],
    'method 参与签名，不能固定写 GET'
  );
});

test('apiGet：json 是惰性且记忆化的解析函数', async () => {
  const page = stubPage(() => ok('{"a":1}'));
  const response = await api.apiGet(page, 'https://data.educoder.net/api/thing.json');
  assert.equal(response.json(), response.json(), '重复调用返回同一对象（记忆化）');
});

test('apiGet：空响应抛出「接口返回空响应：{url}」', async () => {
  const url = 'https://data.educoder.net/api/empty.json';
  const page = stubPage(() => ok(''));
  await assert.rejects(() => api.apiGet(page, url), (error) => {
    assert.equal(error.message, `接口返回空响应：${url}`);
    return true;
  });
});

test('apiGet：网络异常抛出而不是返回空结果', async () => {
  const page = stubPage(() => new Error('Failed to fetch'));
  await assert.rejects(() => api.apiGet(page, 'https://data.educoder.net/api/x.json'), /请求失败/);
});

test('apiGet：非 JSON 正文在 json() 调用时抛出', async () => {
  const page = stubPage(() => ok('<html>login</html>'));
  const response = await api.apiGet(page, 'https://data.educoder.net/api/x.json');
  assert.equal(response.ok, true);
  assert.throws(() => response.json(), /不是合法 JSON/);
});

test('apiGet：非 2xx 时 ok=false 且保留 status', async () => {
  const page = stubPage(() => ({ status: 401, body: '{"error":"unauthorized"}' }));
  const response = await api.apiGet(page, 'https://data.educoder.net/api/x.json');
  assert.equal(response.ok, false);
  assert.equal(response.status, 401);
});

// ------------------------------------------------------- classifyResponse

test('classifyResponse：字符串 status 不是业务错误码（真实响应里会出现 status:"required"）', () => {
  // 实测 `/api/tasks/{id}.json` 在带 `homework_common_id` 时返回 `status:"required"`，
  // 而同一个响应的 challenge / prev_game / test_sets 数据齐全、完全可用；
  // 不带该参数时这个字段干脆不出现。曾因把非数字 status 当错误码，
  // 报出「接口业务失败：status=required」，整条关卡链一关都抓不到。
  const body = JSON.stringify({
    status: 'required', st: 0, prev_game: null, next_game: 'x',
    challenge: { subject: '人机交互', homework_challenge_index: 1 }
  });
  const verdict = api.classifyResponse(200, body);
  assert.equal(verdict.ok, true, '字符串 status 必须被忽略，不能当成业务错误码');
  assert.equal(verdict.kind, 'ok');
});

test('classifyResponse：数字 status 仍然是业务错误码，0/200 视为成功', () => {
  const businessError = api.classifyResponse(200, JSON.stringify({ status: 50001, message: '无权访问' }));
  assert.equal(businessError.ok, false);
  assert.equal(businessError.kind, 'api');
  assert.match(businessError.reason, /50001/);

  assert.equal(api.classifyResponse(200, JSON.stringify({ status: 0, courses: [] })).ok, true);
  assert.equal(api.classifyResponse(200, JSON.stringify({ status: 200 })).ok, true);
  // 成功响应通常**根本没有** status 字段（如 homework_commons 的真实响应）
  assert.equal(api.classifyResponse(200, JSON.stringify({ course_identity: 5, homeworks: [] })).ok, true);
});

test('classifyResponse：-102 归为签名问题、401 归为会话失效、5xx 归为接口错误', () => {
  const blocked = api.classifyResponse(200, '{"status":-102,"message":"服务器时间与您的设备时间不匹配"}');
  assert.equal(blocked.ok, false);
  assert.equal(blocked.kind, 'signature');
  assert.equal(api.classifyResponse(401, '{"error":"x"}').kind, 'auth');
  assert.equal(api.classifyResponse(403, '{"error":"x"}').kind, 'auth');
  assert.equal(api.classifyResponse(500, '{"error":"x"}').kind, 'api');
  assert.equal(api.classifyResponse(200, '<html>登录</html>').kind, 'html');
});

// ------------------------------------------------------------ checkLogin

test('checkLogin：身份接口返回 login → loggedIn true，login 即账号来源', async () => {
  const page = stubPage(() => ok('{"login":"p8sxailt2","real_name":"x","user_id":1}'));
  const result = await api.checkLogin(page);
  assert.equal(result.loggedIn, true);
  assert.equal(result.user, AUTH_USER);
  assert.equal(result.status, 200);
  assert.equal(result.reason, '已登录');
  assert.equal(
    page.calls[0].url,
    'https://data.educoder.net/api/users/get_user_info.json?school=1',
    '用身份接口做登录探针：它免签名也能通，能把「会话掉了」和「签名坏了」分开'
  );
});

test('checkLogin：登录态但缺 login 字段 → 不算已登录（避免拿到空账号继续跑）', async () => {
  const page = stubPage(() => ok('{"user_id":1,"real_name":"x"}'));
  const result = await api.checkLogin(page);
  assert.equal(result.loggedIn, false);
  assert.match(result.reason, /login/);
});

test('checkLogin：401 / 403 → loggedIn false 且带 status 与可读原因', async () => {
  for (const status of [401, 403]) {
    const page = stubPage(() => ({ status, body: '{"error":"unauthorized"}' }));
    const result = await api.checkLogin(page);
    assert.equal(result.loggedIn, false);
    assert.equal(result.status, status);
    assert.equal(result.reason, '会话已失效（未登录）');
  }
});

test('checkLogin：不抛异常——HTML 登录页 / 空响应 / 网络异常统一降级且带原因', async () => {
  const html = stubPage(() => ok('<html>登录</html>'));
  const htmlResult = await api.checkLogin(html);
  assert.equal(htmlResult.loggedIn, false);
  assert.match(htmlResult.reason, /HTML/, '必须说明拿到的是 HTML 登录页，而不是静默失败');
  assert.ok(htmlResult.preview.includes('登录'), '必须保留返回内容片段用于诊断');

  const empty = stubPage(() => ok(''));
  assert.equal((await api.checkLogin(empty)).loggedIn, false);

  const broken = stubPage(() => new Error('Target closed'));
  const brokenResult = await api.checkLogin(broken);
  assert.equal(brokenResult.loggedIn, false);
  assert.match(brokenResult.reason, /Target closed/);

  const blocked = stubPage(() => ok('{"status":-102,"message":"服务器时间与您的设备时间不匹配"}'));
  const blockedResult = await api.checkLogin(blocked);
  assert.equal(blockedResult.loggedIn, false);
  assert.equal(blockedResult.status, 200);
  assert.equal(blockedResult.signatureRejected, true, '必须识别 -102 是签名问题而不是未登录');
  assert.match(blockedResult.reason, /签名被拒/);
});

test('checkLogin：-102 归类为签名问题（不是设备时间、也不是未登录）', async () => {
  const page = stubPage(() => ok('{"status":-102,"message":"服务器时间与您的设备时间不匹配，请检查您的设备时间设置并重新加载页面。"}'));
  const result = await api.checkLogin(page);
  assert.equal(result.loggedIn, false);
  assert.equal(result.signatureRejected, true);
  assert.match(result.reason, /签名被拒/, '文案要指向真实原因，而不是照抄接口的「时间不匹配」');
  assert.match(result.reason, /educoder-sign/, '必须指向要改的文件，否则用户无从下手');
  assert.ok(result.preview.includes('-102'), '必须保留接口原文用于诊断');

  // 正常登录态不应带该标记
  const healthy = stubPage(() => ok('{"login":"p8sxailt2"}'));
  const healthyResult = await api.checkLogin(healthy);
  assert.equal(healthyResult.loggedIn, true);
  assert.equal(healthyResult.signatureRejected, undefined);
});

test('probeLogin：诊断信息包含页面 URL 与实际状态', async () => {
  const page = stubPage(() => ({ status: 500, body: '{"error":"boom"}' }));
  const probe = await api.probeLogin(page);
  assert.equal(probe.loggedIn, false);
  assert.equal(probe.status, 500);
  assert.equal(probe.reason, 'HTTP 500');
  assert.equal(typeof probe.pageUrl, 'string');
});

// ----------------------------------------------------------- listCourses

test('listCourses：分页累加，累计数达到 count 即停', async () => {
  const page = stubPage((url) => {
    const index = Number(new URL(url).searchParams.get('page'));
    if (index === 1) {
      return ok(JSON.stringify({ count: 150, courses: Array.from({ length: 100 }, (_v, i) => courseItem(i + 1, `课程${i + 1}`, `C${i + 1}`)) }));
    }
    if (index === 2) {
      return ok(JSON.stringify({ count: 150, courses: Array.from({ length: 50 }, (_v, i) => courseItem(i + 101, `课程${i + 101}`, `C${i + 101}`)) }));
    }
    throw new Error(`不应请求第 ${index} 页`);
  });
  const courses = await api.listCourses(page, { perPage: 100 });
  assert.equal(courses.length, 150, '两页共 150 条');
  assert.equal(page.calls.length, 2, '达到 count 后不再请求第 3 页');
  assert.equal(page.calls[0].url, COURSES_URL(1, 100), 'URL 必须与网络日志确认的真实接口一致');
  assert.equal(page.calls[1].url, COURSES_URL(2, 100));
});

test('listCourses：opts.perPage 生效，默认 100', async () => {
  const page = stubPage((url) => {
    const perPage = new URL(url).searchParams.get('per_page');
    return ok(JSON.stringify({ count: 1, courses: [courseItem(1, 'A', 'AAA')] }));
  });
  await api.listCourses(page, { perPage: 15 });
  assert.match(page.calls[0].url, /per_page=15/);

  const defaultPage = stubPage(() => ok(JSON.stringify({ count: 1, courses: [courseItem(1, 'A', 'AAA')] })));
  await api.listCourses(defaultPage);
  assert.match(defaultPage.calls[0].url, /per_page=100/);
});

test('listCourses：本次返回为空即终止（count 缺失时不依赖 count）', async () => {
  const page = stubPage((url) => {
    const index = Number(new URL(url).searchParams.get('page'));
    if (index === 1) return ok(JSON.stringify({ courses: [courseItem(1, 'A', 'AAA'), courseItem(2, 'B', 'BBB')] }));
    return ok('{"courses":[]}');
  });
  const courses = await api.listCourses(page);
  assert.equal(courses.length, 2);
  assert.equal(page.calls.length, 2, '空页后停止');
});

test('listCourses：20 页上限保护（接口忽略 page 时不死循环，且不静默返回半份）', async () => {
  let id = 0;
  const page = stubPage(() => ok(JSON.stringify({
    count: 100000,
    courses: Array.from({ length: 100 }, () => courseItem((id += 1), `课程${id}`, `C${id}`))
  })));
  await assert.rejects(() => api.listCourses(page), /安全上限/, '取不全就要报错，不能返回 2000 门当成功');
  assert.equal(page.calls.length, 20, '最多请求 20 页');
  assert.equal(page.calls[19].url, COURSES_URL(20, 100));
});

test('listCourses：分页期间 count 变化 → 报错而不是存下半份', async () => {
  const page = stubPage((url) => {
    const index = Number(new URL(url).searchParams.get('page'));
    return index === 1
      ? ok(JSON.stringify({ count: 3, courses: [courseItem(1, 'A', 'AAA'), courseItem(2, 'B', 'BBB')] }))
      : ok(JSON.stringify({ count: 4, courses: [courseItem(3, 'C', 'CCC')] }));
  });
  await assert.rejects(() => api.listCourses(page), /总数发生变化/);
});

test('listCourses：提前遇到空页但没取到 count 声明的数量 → 报错', async () => {
  const page = stubPage((url) => {
    const index = Number(new URL(url).searchParams.get('page'));
    return index === 1
      ? ok(JSON.stringify({ count: 9, courses: [courseItem(1, 'A', 'AAA')] }))
      : ok('{"count":9,"courses":[]}');
  });
  await assert.rejects(() => api.listCourses(page), /分页提前结束/);
});

test('listCourses：opts.user 覆盖账号（不再写死一个人）', async () => {
  const page = stubPage(() => ok(JSON.stringify({ count: 1, courses: [courseItem(1, 'A', 'AAA')] })));
  await api.listCourses(page, { user: 'someone-else' });
  assert.match(page.calls[0].url, /\/api\/users\/someone-else\/courses\.json/);
  assert.match(page.calls[0].url, /username=someone-else/);
});

test('listCourses：字段映射、name 归一化、丢弃缺 name/first_category_url 的条目', async () => {
  const real = {
    id: 120001,
    name: '  示例课程B_2026年\n下半年  ',
    school: '示例大学',
    visits: 1200,
    members_count: 60,
    homework_commons_count: 41,
    is_end: false,
    first_category_url: '/classrooms/DEMO0001/announcement'
  };
  const page = stubPage(() => ok(JSON.stringify({
    count: 5,
    courses: [
      real,
      { id: 2, name: '', first_category_url: '/classrooms/x/announcement' },
      { id: 3, name: '缺 url', first_category_url: '' },
      { id: 4, name: '缺 url 字段' },
      null
    ]
  })));
  const courses = await api.listCourses(page);
  assert.equal(courses.length, 1);
  assert.deepEqual(courses[0], {
    id: 120001,
    name: '示例课程B_2026年 下半年',
    school: '示例大学',
    visits: 1200,
    membersCount: 60,
    homeworkCommonsCount: 41,
    classroomCode: 'DEMO0001',
    classroomUrl: 'https://www.educoder.net/classrooms/DEMO0001/announcement',
    isEnd: false
  });
});

test('listCourses：跨页重复 id 去重', async () => {
  const page = stubPage((url) => {
    const index = Number(new URL(url).searchParams.get('page'));
    const batch = index === 1
      ? [courseItem(1, 'A', 'AAA'), courseItem(2, 'B', 'BBB')]
      : [courseItem(2, 'B', 'BBB'), courseItem(3, 'C', 'CCC')];
    return ok(JSON.stringify({ count: 3, courses: batch }));
  });
  const courses = await api.listCourses(page);
  assert.deepEqual(courses.map((course) => course.id), [1, 2, 3]);
  assert.equal(page.calls.length, 2);
});

// ------------------------------------------------------- listExperiments

test('listExperiments：只保留 is_shixun，字段映射严格按契约', async () => {
  const payload = {
    course_public: false,
    is_end: false,
    homeworks: [
      {
        is_shixun: true,
        homework_id: 88000002,
        name: 'CNN',
        shixun_identifier: 'zq655f1e',
        myshixun_identifier: 'zqad65672b',
        challenge_count: 5
      },
      { is_shixun: false, homework_id: 1, name: '普通作业', challenge_count: 3 },
      { is_shixun: true, homework_id: 2, name: '无 challenge_count', shixun_identifier: 's2', myshixun_identifier: 'm2' }
    ]
  };
  const page = stubPage(() => ok(JSON.stringify(payload)));
  const experiments = await api.listExperiments(page, { classroomCode: 'DEMO0001' });
  assert.equal(
    page.calls[0].url,
    'https://data.educoder.net/api/courses/DEMO0001/homework_commons.json'
      + '?limit=100&page=1&status=0&id=DEMO0001&type=4&order=0&zzud=p8sxailt2',
    '必须带完整查询参数：裸 URL 会被服务端按默认 limit 截断实验列表'
  );
  assert.deepEqual(experiments, [
    { name: 'CNN', categoryName: '', homeworkId: 88000002, shixunIdentifier: 'zq655f1e', myshixunIdentifier: 'zqad65672b', taskCount: 5 },
    { name: '无 challenge_count', categoryName: '', homeworkId: 2, shixunIdentifier: 's2', myshixunIdentifier: 'm2', taskCount: 0 }
  ]);
});

test('listExperiments：章名取 upper_category_name，没有章时为空串', async () => {
  const payload = {
    query_total_count: 2,
    homeworks: [
      { is_shixun: true, homework_id: 1, name: '顺序图', shixun_identifier: 'a', myshixun_identifier: 'm', upper_category_name: '8、面向对象分析' },
      { is_shixun: true, homework_id: 2, name: 'CNN', shixun_identifier: 'b', myshixun_identifier: 'n', upper_category_name: null }
    ]
  };
  const page = stubPage(() => ok(JSON.stringify(payload)));
  const experiments = await api.listExperiments(page, { classroomCode: 'DEMO0001' });
  assert.deepEqual(experiments.map((item) => item.categoryName), ['8、面向对象分析', '']);
});

test('listExperiments：按 query_total_count 分页取全', async () => {
  const pages = {
    1: { query_total_count: 2, homeworks: [{ is_shixun: true, homework_id: 1, name: 'A', shixun_identifier: 'a', myshixun_identifier: 'm' }] },
    2: { query_total_count: 2, homeworks: [{ is_shixun: true, homework_id: 2, name: 'B', shixun_identifier: 'b', myshixun_identifier: 'n' }] }
  };
  const seenPages = [];
  const page = stubPage((url) => {
    const pageNo = Number(/[?&]page=(\d+)/.exec(url)[1]);
    seenPages.push(pageNo);
    return ok(JSON.stringify(pages[pageNo] || { query_total_count: 2, homeworks: [] }));
  });
  const experiments = await api.listExperiments(page, { classroomCode: 'DEMO0001', perPage: 1 });
  assert.deepEqual(experiments.map((item) => item.name), ['A', 'B']);
  assert.deepEqual(seenPages, [1, 2], '凑够声明的数量就停，不多请求');
});

test('listExperiments：分页被截断（页数不足）时整批失败', async () => {
  const page = stubPage(() => ok(JSON.stringify({
    query_total_count: 5,
    homeworks: [{ is_shixun: true, homework_id: 1, name: 'A', shixun_identifier: 'a', myshixun_identifier: 'm' }]
  })));
  await assert.rejects(
    () => api.listExperiments(page, { classroomCode: 'DEMO0001' }),
    /分页提前结束/,
    '声明 5 条只给 1 条且后续页为空，必须整批失败而不是静默少抓'
  );
});

test('listExperiments：分页期间总数变化时整批失败', async () => {
  const pages = [
    { query_total_count: 2, homeworks: [{ is_shixun: true, homework_id: 1, name: 'A', shixun_identifier: 'a', myshixun_identifier: 'm' }] },
    { query_total_count: 3, homeworks: [{ is_shixun: true, homework_id: 2, name: 'B', shixun_identifier: 'b', myshixun_identifier: 'n' }] }
  ];
  let index = 0;
  const page = stubPage(() => ok(JSON.stringify(pages[Math.min(index++, pages.length - 1)])));
  await assert.rejects(
    () => api.listExperiments(page, { classroomCode: 'DEMO0001', perPage: 1 }),
    /总数发生变化/
  );
});

test('listExperiments：真实健康响应无顶层 status，不得抛错', async () => {
  const page = stubPage(() => ok('{"course_identity":5,"homeworks":[{"is_shixun":true,"homework_id":1,"name":"CNN","challenge_count":5}]}'));
  const experiments = await api.listExperiments(page, { classroomCode: 'DEMO0001' });
  assert.equal(experiments.length, 1);
});

test('listExperiments：homeworks 为空数组时返回空列表而不是抛错（课程没有课堂实验）', async () => {
  // 真实响应：无顶层 status，homeworks 为 []（页面显示「暂时还没有相关数据哦!」）
  const page = stubPage(() =>
    ok('{"course_identity":5,"homework_type":4,"homeworks":[],"all_count":0,"task_count":0}')
  );
  const experiments = await api.listExperiments(page, { classroomCode: 'zq22d977' });
  assert.deepEqual(experiments, [], '没有课堂实验是正常情况，必须返回空数组');
});

test('listExperiments：-102 归类为签名问题，而不是课程或账号出错', async () => {
  const page = stubPage(() => ok('{"status":-102,"message":"服务器时间与您的设备时间不匹配，请检查您的设备时间设置并重新加载页面。"}'));
  await assert.rejects(
    () => api.listExperiments(page, { classroomCode: 'DEMO0001' }),
    /签名被拒/,
    '必须指向签名，不要复述接口误导性的「时间不匹配」'
  );
});

test('listExperiments：HTTP 非 200 时抛错并带状态码', async () => {
  const page = stubPage(() => ({ status: 500, body: '{"error":"boom"}' }));
  await assert.rejects(() => api.listExperiments(page, { classroomCode: 'X' }), /HTTP 500/);
});

test('listExperiments：status 为 0 视为成功；缺 classroomCode 抛错', async () => {
  const page = stubPage(() => ok('{"status":0,"homeworks":[{"is_shixun":true,"homework_id":1,"name":"CNN"}]}'));
  assert.equal((await api.listExperiments(page, { classroomCode: 'X' })).length, 1);
  await assert.rejects(() => api.listExperiments(page, {}), /缺少 classroomCode/);
});

// -------------------------------------------------------- listChallenges

const CHALLENGES_URL = 'https://data.educoder.net/api/myshixuns/zqad65672b/challenges.json'
  + '?homework_common_id=88000002&zzud=p8sxailt2';
const experiment = { homeworkId: 88000002, myshixunIdentifier: 'zqad65672b' };

test('listChallenges：兼容数组 / {data:[]} / {challenges:[]} 三种形状', async () => {
  const items = [{
    identifier: 'abc',
    subject: '第1关',
    homework_challenge_index: 1,
    chooses: [{ subject: 'q' }],
    with_code_file: true
  }];
  for (const body of [JSON.stringify(items), JSON.stringify({ data: items }), JSON.stringify({ challenges: items })]) {
    const page = stubPage(() => ok(body));
    const challenges = await api.listChallenges(page, experiment);
    assert.equal(page.calls[0].url, CHALLENGES_URL);
    assert.deepEqual(challenges, [{ identifier: 'abc', name: '第1关', index: 1, position: 1, challengeId: '', type: 'choice' }]);
  }
});

test('listChallenges：position 优先于 index（关卡顺序以后者为准会错序）', async () => {
  const page = stubPage(() => ok(JSON.stringify([
    { identifier: 'a', subject: 'A', homework_challenge_index: 7, position: 2 },
    { identifier: 'b', subject: 'B', homework_challenge_index: 2 }
  ])));
  const challenges = await api.listChallenges(page, experiment);
  assert.deepEqual(challenges.map((item) => [item.index, item.position]), [[7, 2], [2, 2]]);
});

test('listChallenges：type 判定 choice > code > unknown', async () => {
  const page = stubPage(() => ok(JSON.stringify([
    { identifier: 'a', subject: '选择题', chooses: [{ subject: 'q' }], with_code_file: true },
    { identifier: 'b', subject: '编程题', chooses: [], with_code_file: true },
    { identifier: 'c', name: '无类型' },
    { identifier: 'd', chooses: [], with_code_file: false }
  ])));
  const challenges = await api.listChallenges(page, experiment);
  assert.deepEqual(challenges.map((item) => item.type), ['choice', 'code', 'unknown', 'unknown']);
  assert.deepEqual(challenges.map((item) => item.name), ['选择题', '编程题', '无类型', '']);
});

test('listChallenges：index 回退 homework_challenge_index → index → 0，缺 identifier 丢弃', async () => {
  const page = stubPage(() => ok(JSON.stringify([
    { identifier: 'a', subject: 'A', homework_challenge_index: 0, index: 7 },
    { identifier: 'b', subject: 'B', index: 3 },
    { identifier: 'c', subject: 'C' },
    { subject: 'D', homework_challenge_index: 4 },
    { identifier: '', subject: 'E' },
    { identifier: null, subject: 'F' },
    'not-an-object'
  ])));
  const challenges = await api.listChallenges(page, experiment);
  assert.deepEqual(challenges.map((item) => [item.identifier, item.index]), [['a', 0], ['b', 3], ['c', 0]]);
});

test('listChallenges：接口失败一律返回 []（不抛出）', async () => {
  const networkError = stubPage(() => new Error('net::ERR_CONNECTION_RESET'));
  assert.deepEqual(await api.listChallenges(networkError, experiment), []);

  const emptyBody = stubPage(() => ({ status: 500, body: '' }));
  assert.deepEqual(await api.listChallenges(emptyBody, experiment), []);

  const deviceTime = stubPage(() => ok('{"status":-102,"message":"服务器时间与您的设备时间不匹配"}'));
  assert.deepEqual(await api.listChallenges(deviceTime, experiment), []);

  const weird = stubPage(() => ok('"just a string"'));
  assert.deepEqual(await api.listChallenges(weird, experiment), []);

  // 只有 homework_id（子标签实验）时改为按作业主键问一次；两样都没有才不发请求
  const noMyshixun = stubPage(() => ok('{"data":[]}'));
  assert.deepEqual(await api.listChallenges(noMyshixun, { homeworkId: 1 }), []);
  assert.equal(noMyshixun.calls.length, 1, '只有 homeworkId 时应按作业主键问一次');
  assert.match(noMyshixun.calls[0].url, /homework_commons\/1\/shixun_challenge_data\.json/);

  const nothing = stubPage(() => ok('[]'));
  assert.deepEqual(await api.listChallenges(nothing, {}), []);
  assert.equal(nothing.calls.length, 0, '既无 myshixun 标识也无 homeworkId 时不应发请求');
});

// ---------------------------------------------------- listChallengeNames

test('listChallengeNames：解析 challenge_list 为「名称 + 序号 + challengeId」，不编造标识', async () => {
  const page = stubPage(() => ok(JSON.stringify({
    challenge_list: [
      { challenge_id: 5547038, position: 1, name: '顺序图题目初体验', score: 12.5 },
      { challenge_id: 5547039, position: 2, name: '请画出酒店工作人员角色' },
      { challenge_id: 5547040, position: 3 },
      'not-an-object'
    ]
  })));
  const levels = await api.listChallengeNames(page, { shixunIdentifier: 'qgiwumjn' });
  assert.match(page.calls[0].url, /\/api\/shixuns\/qgiwumjn\/challenges\.json/);
  assert.deepEqual(levels, [
    { name: '顺序图题目初体验', position: 1, challengeId: '5547038' },
    { name: '请画出酒店工作人员角色', position: 2, challengeId: '5547039' }
  ]);
  assert.ok(levels.every((level) => !('identifier' in level)), '这条接口没有关卡标识，不得编造');
});

test('listChallengeNames：没有 shixun 标识时不发请求，接口失败返回 []', async () => {
  const none = stubPage(() => ok('{}'));
  assert.deepEqual(await api.listChallengeNames(none, { shixunIdentifier: '' }), []);
  assert.equal(none.calls.length, 0);

  const networkError = stubPage(() => new Error('net::ERR_CONNECTION_RESET'));
  assert.deepEqual(await api.listChallengeNames(networkError, { shixunIdentifier: 'x' }), []);
});

// ------------------------------------------------------ 模块导出面 / 只读约束

test('导出面严格等于契约', () => {
  assert.equal(api.AUTH_USER, AUTH_USER);
  assert.deepEqual(
    Object.keys(api).sort(),
    [
      'AUTH_USER',
      'ApiError',
      'AuthExpiredError',
      'SignatureRejectedError',
      'apiGet',
      'checkLogin',
      'classifyResponse',
      'listChallengeNames',
      'listChallenges',
      'listCourses',
      'listExperiments',
      'listShixunCategories',
      'probeLogin'
    ]
  );
});

test('静态约束：只允许引入同目录纯函数模块，且不含写操作接口', () => {
  const source = fs.readFileSync(MODULE_PATH, 'utf8');
  // 只检查代码本体：注释里会提到被禁止的接口名，不算实现。
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const required = [...code.matchAll(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/g)].map((match) => match[1]);
  assert.deepEqual(
    required,
    ['./educoder-sign'],
    '数据层只允许引入同目录纯函数模块（签名）；禁止引入 Node 侧 HTTP 客户端'
  );
  assert.doesNotMatch(code, /method\s*:\s*['"]?(POST|PUT|DELETE|PATCH)/i, '只允许 GET');
  assert.doesNotMatch(code, /_delete|update_file|session_report/i, '禁止实现写操作接口');
  assert.doesNotMatch(code, /\bhttps?\.request\b|node:https?/, '禁止 Node 原生 HTTP 客户端');
});
