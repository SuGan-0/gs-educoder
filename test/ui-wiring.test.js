'use strict';

/**
 * 控制台前端的接线契约（静态检查，不需要浏览器、不联网）。
 *
 * 为什么需要这个文件：
 *
 * 后端发的事件如果不在前端的 `EVENT_TYPES` 白名单里，会在入口被**静默丢弃**
 * ——AI 作答面板就曾因为白名单缺 `'answer'`，整条进度链在前端全丢，
 * 面板恒显示「尚未开始」，而 HTTP 级测试全绿（后端一切正常）。
 * 这类缺陷只有检查前端源码才看得见。
 *
 * 所以这里的第一个用例不写死类型列表，而是**从后端源码里提取实际发出的类型**，
 * 断言前端白名单必须全覆盖——以后后端新增事件而忘了改前端，测试会直接红。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'extractor', 'ui', 'public', 'index.html'), 'utf8');
const USERSCRIPT = fs.readFileSync(path.join(ROOT, 'userscript', 'educoder-autosubmit.user.js'), 'utf8');
/** 会发事件的文件：HTTP 服务、外壳、引擎。 */
const BACKEND_SOURCES = ['extractor/ui/server.js', 'extractor/run.js', 'extractor/lib/extract-engine.js']
  .map((file) => fs.readFileSync(path.join(ROOT, file), 'utf8'));

/** index.html 里的 `EVENT_TYPES` 白名单。 */
function frontendEventTypes() {
  const match = /var EVENT_TYPES = \[([^\]]*)\]/.exec(HTML);
  assert.ok(match, 'index.html 里应有 EVENT_TYPES 白名单');
  return match[1]
    .split(',')
    .map((item) => item.trim().replace(/^'/, '').replace(/'$/, ''))
    .filter(Boolean)
    .sort();
}

/**
 * 后端源码里所有 `type: 'xxx'` 字面量。
 *
 * 假设：这三个文件里 `type: '<小写字母>'` 只用于事件信封（任务题型走的是
 * `taskType` / `exportKind` 字段，不叫 `type`）。若将来出现别的同名用法，
 * 应当把那个字段改名，而不是放宽这里。
 */
function backendEventTypes() {
  const found = new Set();
  for (const source of BACKEND_SOURCES) {
    for (const match of source.matchAll(/type: '([a-z-]+)'/g)) found.add(match[1]);
  }
  return [...found].sort();
}

test('控制台：后端发出的每种事件都在前端白名单里（否则会被静默丢弃）', () => {
  const frontend = frontendEventTypes();
  const missing = backendEventTypes().filter((type) => !frontend.includes(type));
  assert.deepEqual(
    missing,
    [],
    `这些事件会在前端入口被丢掉，请把它们加进 index.html 的 EVENT_TYPES：${missing.join(', ')}`
  );
});

test('控制台：AI 作答（answer）事件的整条接线都在', () => {
  assert.ok(frontendEventTypes().includes('answer'), 'EVENT_TYPES 必须含 answer');
  assert.match(HTML, /case 'answer':/, 'applyEvent 必须有 answer 分支');
  assert.match(HTML, /function mergeAnswer\(/, 'mergeAnswer 必须存在');
  assert.match(HTML, /mergeAnswer\(snapshot\.answer\)/, '快照恢复必须带上 answer（刷新页面后仍能看到进度）');
  assert.match(HTML, /renderAnswerStatus\(\);\s*\n\s*\}/, 'renderAll 必须调用 renderAnswerStatus');

  // SSE 监听列表：从 connectEvents 里取那一段，确认注册了 answer
  const from = HTML.indexOf('function connectEvents()');
  assert.ok(from > 0, '应能找到 connectEvents');
  const segment = HTML.slice(from, HTML.indexOf('source.onerror', from));
  assert.match(segment, /'answer'/, 'SSE 监听列表必须注册 answer');
});

test('控制台：answer 的判定顺序不会被 done 截走', () => {
  // answer 事件载荷里有 stopped 字段，而 detectEventType 里 `'stopped' in data` 会判成 done。
  // 只要 EVENT_TYPES 含 answer（先判 data.type）就不会走到那一步——这里把这个前提锁住。
  const match = /function detectEventType\(named, data\) \{([\s\S]*?)\n  \}/.exec(HTML);
  assert.ok(match, '应能找到 detectEventType');
  const body = match[1];
  const byEnvelope = body.indexOf("EVENT_TYPES.indexOf(data.type)");
  const byStopped = body.indexOf("'stopped' in data");
  assert.ok(byEnvelope > 0 && byStopped > 0, '两条判据都应存在');
  assert.ok(
    byEnvelope < byStopped,
    '必须先按 data.type 判定，否则带 stopped 的 answer 事件会被当成 done'
  );
});

/* ------------------------- 篡改猴 ↔ 控制台 的接口契约 ------------------------- */

test('篡改猴脚本：语法可解析（不需要 GM_* 全局）', () => {
  assert.doesNotThrow(() => new vm.Script(USERSCRIPT), '脚本必须能通过语法编译');
});

test('篡改猴脚本：所有控制台请求都要走 consoleRequest（地址拼接只在传输层里）', () => {
  // 直接 `base + '/api/xxx'` 会在使用者粘贴「带 ?token= 的完整地址」时
  // 拼成 `http://127.0.0.1:PORT/?token=xxx/api/xxx` 这种非法 URL（曾就是这么错的）。
  // 现在更进一步：拼接与发送都收进 consoleRequest，各功能只给路径。
  assert.doesNotMatch(USERSCRIPT, /\$\{base\}\/api\//, '不允许再直接拼 base + path');
  assert.equal(
    (USERSCRIPT.match(/GM_xmlhttpRequest\(\{/g) || []).length,
    1,
    'GM_xmlhttpRequest 只应出现在传输层（consoleRequest）里，别处一律调它'
  );
  // 各功能点给的是路径，不是拼好的 URL
  for (const path of ['/api/answers', '/api/blueprint', '/api/log', '/api/answer/save', '/api/signing-keys']) {
    assert.match(USERSCRIPT, new RegExp(`consoleRequest\\('${path.replace(/\//g, '\\/')}'`), `${path} 应走 consoleRequest`);
  }
});

test('篡改猴脚本：答案键必须经 levelIds 折算', () => {
  // 答案按 L001 存、页面只能拿到 URL 里的平台标识，不折算两边永远对不上。
  assert.match(USERSCRIPT, /payload\.levelIds/, '必须消费控制台返回的 levelIds');
  assert.match(USERSCRIPT, /function answerKeyForCurrentLevel/, '必须有折算函数');
  assert.match(USERSCRIPT, /state\.answers\[answerKey\]/, '查答案要用折算后的键');
});

test('篡改猴脚本：安全默认——拿不到「通过」不得进入下一关', () => {
  // 原来靠 `strictAdvance` 开关控制；手动单关流程删除后，改由教学队列**无条件严格**把关：
  // 只有明确「通过」才推进，failed / timeout / 拿不到结论一律停队。
  assert.match(USERSCRIPT, /if \(outcome\.status !== 'passed'\)/, '非「通过」必须拦住');
  assert.match(USERSCRIPT, /stopTeachQueue\(/, '拦住时要停队并说明原因');
  assert.match(USERSCRIPT, /status === 'failed'/, '必须识别「提交未通过」并停下');
  // 提交后不能再用固定 sleep 直接点下一关
  assert.doesNotMatch(USERSCRIPT, /await sleep\(3000\);/, '不得用固定等待代替结果判定');
  // 推进必须发生在「提交成功」之后，不能提前
  const passed = USERSCRIPT.indexOf("：提交成功`, 'ok'");
  const advance = USERSCRIPT.indexOf('return advanceTeachQueue(queue);', passed);
  assert.ok(passed > 0 && advance > passed, '推进必须紧跟「提交成功」之后');
});

test('篡改猴脚本：提交通过后必须把答案回传控制台落盘', () => {
  // 需求：关卡通过测评后，把代码/选项（答案）按规范格式写进 exports/answers/。
  // 脚本只负责「抓到答案 + 回传」，定位文件与落盘格式由控制台的 /api/answer/save 负责。
  assert.match(USERSCRIPT, /consoleEndpoint\('\/api\/answer\/save'\)/, '回传答案必须走 consoleEndpoint');
  assert.match(USERSCRIPT, /function pushAnswerToConsole/, '必须有回传函数');
  assert.match(USERSCRIPT, /function passedAnswerPayload/, '回传内容必须由统一函数组装（便于行为测试）');
  // 必须在「通过」分支里调用——放到 failed/unknown 分支等于写错答案
  assert.match(
    USERSCRIPT,
    /status === 'passed'\) \{[\s\S]{0,800}?pushAnswerToConsole\(/,
    '通过后必须立刻回传答案'
  );
});

test('篡改猴脚本：编辑器必须取页面的 window.Monaco（大写 M）并同步页面状态', () => {
  // 真机实测：头歌把 monaco 挂在 window.Monaco（大写），而旧代码找 window.monaco（小写）
  // → 永远找不到编辑器，编程题一关都提交不了。且脚本带 @grant，读页面全局必须走 unsafeWindow。
  assert.match(USERSCRIPT, /function pageWindow\(/, '必须有「取页面真实 window」的辅助函数');
  assert.match(USERSCRIPT, /host\.Monaco \|\| host\.monaco/, 'monaco 命名空间在页面上是大写 Monaco');
  assert.match(USERSCRIPT, /updateMonacoValue/, '写入后必须调页面的 updateMonacoValue 同步 React state');
  assert.doesNotMatch(USERSCRIPT, /const monacoApi = window\.monaco/, '不得再直接读沙箱 window.monaco');
});

/* ------------------------------ 内联脚本自身 ------------------------------ */

/** index.html 里最大的那段内联脚本（控制台的全部前端逻辑）。 */
function inlineScript() {
  const blocks = [...HTML.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  assert.ok(blocks.length, 'index.html 应有内联脚本（单文件、无构建）');
  return blocks.reduce((longest, block) => (block.length >= longest.length ? block : longest));
}

test('控制台：内联脚本必须能通过语法编译', () => {
  // 前端是单文件内联脚本，一个字符打错整块就不执行——而 HTTP 级测试完全看不见。
  // 只编译不执行，所以不需要 document / location 这些浏览器全局。
  assert.doesNotThrow(() => new vm.Script(inlineScript()), '内联脚本存在语法错误，页面会整块失效');
});

test('控制台：作答面板的进度条与「复制地址」按钮已接线', () => {
  assert.match(HTML, /id="answer-bar"/, '应有作答进度条');
  assert.match(HTML, /id="answer-fill"/, '应有作答进度条填充');
  assert.match(HTML, /answer-fill'\)\.style\.width/, '进度条必须被更新');
  assert.match(HTML, /id="btn-answer-copy"/, '应有复制控制台地址按钮');
  assert.match(HTML, /btn-answer-copy'\)\.addEventListener/, '复制按钮必须接线');
});

test('篡改猴脚本：找不到提交按钮时必须把页面上的候选按钮列出来', () => {
  // 用户反馈「控制台上看不到自动答题」时，真正卡住的是「找不到提交按钮」——
  // 而原来的日志只说了「没有按钮」，用户无从下手。现在必须把候选按钮打出来。
  assert.match(USERSCRIPT, /function describeButtons/, '必须有按钮枚举函数');
  assert.match(USERSCRIPT, /function buttonLabel/, '按钮文案要合并 aria-label / title / value');
  assert.match(USERSCRIPT, /当前页面可见的按钮/, '找不到按钮时要把候选打印出来');
  assert.match(USERSCRIPT, /SUBMIT_PATTERNS/, '提交按钮的匹配规则要集中定义');
});

test('篡改猴脚本：端口固定，但 token 不许写死', () => {
  // 端口**故意固定**（原来是 port:0，每次随机 → 配好的地址下次就失效）。
  // 端口是公开信息，固定它没有安全代价；token 才是凭据。
  assert.match(
    USERSCRIPT,
    /const DEFAULT_LOCAL = 'http:\/\/127\.0\.0\.1:43127';/,
    '端口要固定，且与抓取端一致'
  );
  // 跨文件一致性：这个端口必须与 extractor/run.js 的 DEFAULT_UI_PORT 一致，
  // 否则脚本按 43127 连、控制台却在别的端口上听，用户只会看到连不上。
  const RUN_JS = fs.readFileSync(path.join(__dirname, '..', 'extractor', 'run.js'), 'utf8');
  const runPort = /const DEFAULT_UI_PORT = (\d+);/.exec(RUN_JS);
  const scriptPort = /127\.0\.0\.1:(\d+)/.exec(USERSCRIPT);
  assert.ok(runPort && scriptPort, '两边都要能取到端口');
  assert.equal(scriptPort[1], runPort[1], `脚本写的端口(${scriptPort[1]})必须等于控制台的(${runPort[1]})`);

  // token 仍然只能来自控制台：不进仓库、不进脚本源码
  assert.doesNotMatch(USERSCRIPT, /token=[0-9a-f]{32}/i, 'token 不许出现在源码里');
  assert.match(USERSCRIPT, /function setLocalAddress/, '要能设置地址/token');
});

test('篡改猴脚本：面板必须能拖动，且默认不挡右下角', () => {
  // 面板固定不动会盖住页面自己的控件——头歌的「提交」常在右下角，
  // 用户会以为是按钮不存在（这次就是这么误判的）。
  assert.match(USERSCRIPT, /function makeDraggable/, '必须有拖动实现');
  assert.match(USERSCRIPT, /left: 14px; bottom: 14px/, '默认应放左下角');
  assert.match(USERSCRIPT, /function resetPanelPosition/, '要能一键重置位置');
});

test('篡改猴脚本：网络钩子必须挂在 unsafeWindow 上（沙箱模式拦不到页面请求）', () => {
  // 脚本用了 @grant，Tampermonkey 会把它放进沙箱：改 window.fetch 只改到沙箱里那份，
  // 页面自己的请求（关卡数据 / 提交接口）根本看不见——「读到关卡数据」就永远不触发。
  // 必须 @grant unsafeWindow 并挂 unsafeWindow.fetch / unsafeWindow.XMLHttpRequest。
  assert.match(USERSCRIPT, /@grant\s+unsafeWindow/, '必须声明 unsafeWindow 权限');
  assert.match(USERSCRIPT, /const host = \(typeof unsafeWindow !== 'undefined' && unsafeWindow\) \? unsafeWindow : window/, '必须优先用 unsafeWindow、无则退回 window');
  assert.match(USERSCRIPT, /host\.fetch = function/, '必须挂 host.fetch 而非 window.fetch');
  assert.match(USERSCRIPT, /host\.XMLHttpRequest/, 'XHR 钩子同样要挂 host');
});

test('控制台：只提取答案的勾选、载荷与引擎接线都在', () => {
  assert.match(HTML, /id="opt-answers-only"/, 'index.html 必须有「只提取答案」勾选');
  assert.match(HTML, /answersOnly: Boolean\(/, '开始/继续提取的载荷必须带上 answersOnly');
  const runSource = fs.readFileSync(path.join(ROOT, 'extractor', 'run.js'), 'utf8');
  assert.match(runSource, /engine\.answersOnly = payload\.answersOnly === true/, 'run.js 必须把 answersOnly 传给引擎');
});

test('控制台：缺答案清单面板与接口接线都在', () => {
  assert.match(HTML, /id="panel-missing"/, '必须有缺答案清单面板');
  assert.match(HTML, /id="badge-missing"/, '面板徽标必须存在（显示条数）');
  assert.match(HTML, /'\/api\/missing\?token='/, '必须走 /api/missing + token');
  assert.match(HTML, /function renderMissing\(/, '必须有渲染函数');
  assert.match(HTML, /action: 'clear'/, '「清空」必须调用接口的 clear');
});

test('篡改猴脚本：导出标准答案要回传控制台（与控制台同一份答案库），而不是只下载文件', () => {
  // 与控制台「AI 作答」写的是同一份 exports/answers/，走既有的 /api/answer/save
  assert.match(USERSCRIPT, /pushAnswerToConsole\(\{\s*identifier/, '导出应走 pushAnswerToConsole');
  assert.match(USERSCRIPT, /consoleEndpoint\('\/api\/answer\/save'\)/, '要先探测控制台地址，连不上才退回下载');
});

test('篡改猴脚本：面板不再有「连续作答」（多关推进交给教学课程队列）', () => {
  assert.doesNotMatch(USERSCRIPT, /连续作答（通过后自动做下一关）/, '该选项已按用户决定移除');
  assert.doesNotMatch(USERSCRIPT, /state\.continuous/, '相关死代码也应清掉');
});

test('篡改猴脚本：goToChainStart 必须先尝试「直达目标关」，再判 prevGame 为空', () => {
  // 入口页常常正好落在第 1 关（prevGame 为空）。若先判空就会在链首提前 return，
  // 直达分支永远不执行——实测表现就是「还是先到第 1 关，再顺着走到我选的关卡」。
  const start = USERSCRIPT.indexOf('async function goToChainStart');
  assert.ok(start > 0, '应存在 goToChainStart');
  const body = USERSCRIPT.slice(start, start + 2000);
  const direct = body.indexOf('targetId && targetId !==');
  const headCheck = body.indexOf('!task.prevGame');
  assert.ok(direct > 0, '应保留「直达目标关」分支');
  assert.ok(headCheck > 0, '应保留链首判定');
  assert.ok(direct < headCheck, '直达必须排在 prevGame 判空之前，否则在第 1 关会被提前 return 掉');
});

test('篡改猴脚本：批量导出要逐关拉数据，且不能污染「当前关」上下文', () => {
  assert.match(USERSCRIPT, /导出本实验全部关卡的标准答案/, '要有菜单项');
  assert.match(USERSCRIPT, /__easBatch/, '批量请求要带标记');
  // fetch 与 XHR 两个网络钩子的 GET 观察都必须排除批量请求，否则会把别的关卡数据
  // 当成「当前关」写进 state.taskContext
  const guards = USERSCRIPT.match(/!\/__easBatch\/\.test\(/g) || [];
  assert.ok(guards.length >= 2, `fetch 与 XHR 都要排除批量请求，实际 ${guards.length} 处`);
});

test('篡改猴脚本：「停止」必须真能停教学课程队列（之前只置标志、没人读）', () => {
  const start = USERSCRIPT.indexOf('function requestStop()');
  assert.ok(start > 0, '应有 requestStop');
  const body = USERSCRIPT.slice(start, start + 700);
  assert.match(body, /readTeachQueue\(\)/, '要看队列是否在跑');
  assert.match(body, /requestTeachStop\(\)/, '在跑就停它——否则按钮是死的');
});

test('篡改猴脚本：面板日志能导出到本地，且队列跑完/停下自动传', () => {
  assert.match(USERSCRIPT, /consoleEndpoint\('\/api\/log'\)/, '要回传到控制台落盘');
  assert.match(USERSCRIPT, /导出日志到本地/, '面板要有按钮');
  // 两处终态都要自动导出
  const auto = USERSCRIPT.match(/exportLogs\(\); \/\//g) || [];
  assert.ok(auto.length >= 2, `队列完成与停止都要自动导出，实际 ${auto.length} 处`);
});

test('篡改猴脚本：面板不再显示「已录制的提交接口」列表（纯噪声）', () => {
  assert.doesNotMatch(USERSCRIPT, /已录制的提交接口/, '该行已移除');
});

test('篡改猴脚本：日志导出只发「上次之后的新行」，成功后清空面板并显示写入次数', () => {
  const start = USERSCRIPT.indexOf('function exportLogs()');
  assert.ok(start > 0, '应有 exportLogs');
  const body = USERSCRIPT.slice(start, start + 1600);
  // 只发新增行：否则控制台是追加写，全量重发会大量重复
  assert.match(body, /item\.time\) > since/, '要按上次导出时间戳过滤出新行');
  assert.match(body, /KEYS\.lastLogExportAt/, '要记住上次导出时间');
  // 写成功后清空面板（本地已有全量文件）
  assert.match(body, /clearLogs\(\)/, '落盘成功后要清空面板日志');
  assert.match(body, /result\.seq/, '要用控制台返回的写入编号');
  assert.match(USERSCRIPT, /已落盘第 \$\{seq\} 次/, '面板要显示已写入次数');
});

test('篡改猴脚本：评测等待上限取「完整的最大测评时间」（不是一半），并把上限打进日志', () => {
  assert.match(USERSCRIPT, /Math\.min\(pageMax, 600\)/, '上限用完整的页面最大测评时间');
  assert.doesNotMatch(USERSCRIPT, /pageMax \/ 2/, '不能再取一半——实测有关卡超过一半（30 秒的页面、15 秒就放弃了）');
  assert.match(USERSCRIPT, /等评测结果（最多/, '要把上限打进日志，否则只能靠时间戳反推等了多久');
});

test('篡改猴脚本：队列停下后「一键答题」按钮改文案，提示可续跑', () => {
  assert.match(USERSCRIPT, /继续答题（跳过已通过）/, '按钮文案要随队列状态变');
  assert.match(USERSCRIPT, /queue\.stoppedReason/, '按 stoppedReason 判断是否停下');
  assert.match(USERSCRIPT, /passed/, '续跑靠每关的 passed 判断来跳过已通过的');
});

test('篡改猴脚本：点了「下一关」页面没跳转时必须明确停队列（不能静默卡住）', () => {
  const start = USERSCRIPT.indexOf('async function advanceTeachQueue');
  assert.ok(start > 0, '应有 advanceTeachQueue');
  const body = USERSCRIPT.slice(start, start + 2800);
  assert.match(body, /waitForPathChange/, '要确认页面真的跳了');
  assert.match(body, /重试一次/, '没跳要重试');
  assert.match(body, /stopTeachQueue\('点了「下一关」但页面没有跳转/, '重试还不行就要明确停队列——实测就是这么静默断的（日志停在「进入下一关」后再无输出）');
});

test('篡改猴脚本：教学队列要能存档续跑（同一批实验接着上次的实验序号跑）', () => {
  const start = USERSCRIPT.indexOf('async function startTeachRun');
  assert.ok(start > 0, '应有 startTeachRun');
  const body = USERSCRIPT.slice(start, start + 5000);
  assert.match(body, /saved\.stoppedReason/, '只在「停下」的队列上续跑（跑完的不续）');
  assert.match(body, /experimentIndex: resume \?/, '续跑要保留上次的实验序号');
  assert.match(body, /visited: resume &&/, '续跑要保留已访问关卡');
  assert.match(USERSCRIPT, /清空答题进度（下次从头跑）/, '要给一个"重来"的出口');
});

test('篡改猴脚本：面板不再有单关的「导出标准答案」（已并入「导出本实验全部答案」）', () => {
  assert.doesNotMatch(USERSCRIPT, /textContent: '导出标准答案'/, '面板按钮已移除');
  assert.match(USERSCRIPT, /textContent: '导出本实验全部答案'/, '合并成一个按钮');
  assert.doesNotMatch(USERSCRIPT, /exportCurrentAnswer/, '单关导出函数已删除（逻辑并进批量导出）');
  assert.match(USERSCRIPT, /GM_registerMenuCommand\('导出标准答案（本实验全部）'/, '菜单项指向批量导出');
});

test('篡改猴脚本：落盘后清空面板日志要保留最后几行（否则「队列完成」被清掉，看着像卡住）', () => {
  assert.match(USERSCRIPT, /function clearLogs\(keep = 5\)/, '要保留最后几行');
  assert.match(USERSCRIPT, /state\.logs\.slice\(-keep\)/, '保留尾部而不是全清');
  assert.match(USERSCRIPT, /队列已完成/, '状态行要显示队列终态（课程区是折叠的，看不到）');
});

test('篡改猴脚本：作答内核只应有一份（勾选逻辑不得再分裂）', () => {
  assert.match(USERSCRIPT, /async function answerCurrentLevel/, '要有作答内核');
  const teach = USERSCRIPT.indexOf('async function processTeachLevel');
  assert.ok(teach > 0, '教学队列要在');
  assert.match(USERSCRIPT.slice(teach, teach + 4000), /await answerCurrentLevel\(/, '教学队列要用内核');
  // 手动单关流程（processCurrentLevel）已删除：多关推进统一交给队列，
  // 它那套「自动点下一关 / 判定通过才下一关」的开关也一并消失（见上面的安全默认用例）。
  assert.doesNotMatch(USERSCRIPT, /processCurrentLevel/, '不该再有第二套作答流程');
  // 勾选逻辑只应出现在内核里——再出现第二份实现就说明又分裂了
  const picks = (USERSCRIPT.match(/await answerChoiceLevel\(/g) || []).length;
  assert.equal(picks, 1, `answerChoiceLevel 只应在内核里被调用一次，实际 ${picks} 处`);
});

test('篡改猴脚本：读课堂实验必须带 limit（不带只能拿到默认一页，第 1~4 章整片没有）', () => {
  const start = USERSCRIPT.indexOf('async function loadClassroomExperiments');
  assert.ok(start > 0, '应有 loadClassroomExperiments');
  const body = USERSCRIPT.slice(start, start + 1000);
  assert.match(body, /limit=100/, '必须带 limit，与抓取端 listExperiments 同口径');
  assert.match(body, /status=0/, 'tab 口径（status）也要一致');
  assert.match(body, /type=4/, '类型口径一致');
  assert.match(body, /zzud=/, '要带 zzud');
  assert.match(body, /读到 \$\{list\.length\} 个/, '要把读到的数量与前几个名字打进日志');
});

test('篡改猴脚本：代码题必须等编辑器挂载（Monaco 异步插进 DOM，进页面就查会误判没有）', () => {
  assert.match(USERSCRIPT, /async function waitForCodeEditor/, '要有等待函数');
  const core = USERSCRIPT.indexOf('async function answerCurrentLevel');
  const body = USERSCRIPT.slice(core, core + 2200);
  assert.match(body, /await waitForCodeEditor\(\)/, '代码分支要等编辑器，不能立刻放弃');
  assert.match(body, /describeEditorScene\(\)/, '失败时要把现场（monaco 模型 / textarea / iframe 数量）打出来');
  // 动作判定前也要等：否则「没编辑器也没选项」会把代码题误判成虚拟机题跳过
  const teach = USERSCRIPT.indexOf('async function processTeachLevel');
  assert.match(USERSCRIPT.slice(teach, teach + 2200), /await waitForCodeEditor\(2500\)/, '动作判定前也要等编辑器');
});
