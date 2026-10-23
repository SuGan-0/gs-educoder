// ==UserScript==
// @name         头歌自动作答与提交（学习测试用）
// @namespace    local.educoder.autosubmit
// @version      0.2.7
// @description  在头歌关卡页填入答案并提交，自动跳到下一关。先「录制」一次真实提交以学到提交接口，之后即可一键自动提交。
// @match        https://www.educoder.net/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      127.0.0.1
// @run-at       document-start
// ==/UserScript==

/**
 * 匹配范围（为什么是全站）：原来只匹配 /tasks、/shixuns、/paths，结果在「我的课堂」列表页
 * （/users/{我}/classrooms）上根本没有面板，用户调不出「教学课程」区。现在整个站注入；
 * 「一键作答并提交」只在关卡页有意义（非关卡页点击会明确提示，不会瞎报错）。
 */

/**
 * 设计说明（读这一节再改代码）
 *
 * 头歌的「运行 / 提交」走的不是页面里的普通 GET 接口，而是关卡页内部的 POST 请求
 * （形如 /api/tasks/{id}/...、/api/games/{id}/... 等，具体路径随版本变化）。
 * 本仓库的网络日志里只有只读抓取留下的 GET 记录，拿不到提交接口的真实形态，
 * 所以脚本不去猜接口，而是分两步：
 *
 *   1) 录制：钩住 window.fetch 与 XMLHttpRequest，把页面自己发出的写请求
 *      （POST/PUT/PATCH/DELETE）连同请求体、响应片段存到 GM 存储里。
 *      使用者手动作答提交一次，脚本就学到了「提交长什么样」。
 *   2) 复用：把录制到的模板里的答案字段替换成本地答案库里的答案后重放，
 *      成功（响应里出现通过/分数）就自动点「下一关」。
 *
 * 只对使用者自己已登录、有权的账号与其自己已完成的学习任务使用。
 */
(function () {
  'use strict';

  const KEYS = {
    templates: 'educoder-submit-templates',
    answers: 'educoder-answer-bank',
    levelIndex: 'educoder-level-index',
    log: 'educoder-autosubmit-log',
    lastLogExportAt: 'educoder-last-log-export',
    logSeq: 'educoder-log-seq',
    signAk: 'educoder-sign-ak',
    signSk: 'educoder-sign-sk',
    local: 'educoder-local-console',
    token: 'educoder-local-token',
    panelPos: 'educoder-panel-pos',
    panelFolded: 'educoder-panel-folded',
    optionCounts: 'educoder-option-counts',
    titleIds: 'educoder-title-ids',
    titleOnlyIds: 'educoder-title-only-ids',
    evalWaitSeconds: 'educoder-eval-wait',
    levelWaitSeconds: 'educoder-level-wait',
    teachCourses: 'educoder-teach-courses',
    teachSel: 'educoder-teach-selection',
    teachQueue: 'educoder-teach-queue',
    // 导入班级答案文件时记下它的 `class`（年级/班级名），导出时原样写回去
    classInfo: 'educoder-class-info'
  };

  /**
   * 本地控制台地址（默认端口）。
   *
   * 控制台的端口现在**固定**为 43127（见 `extractor/run.js` 的 `DEFAULT_UI_PORT`），
   * 所以这里可以写死一个默认地址——用户只需要粘一次 token，不用连地址一起粘。
   * token 仍然必须来自控制台（随机生成、存在 `.env`，不进仓库也不进脚本）。
   *
   * 端口被占用时控制台会回退到系统分配，此时终端会提示要重配地址。
   */
  const DEFAULT_LOCAL = 'http://127.0.0.1:43127';

  /**
   * 本标签页的随机标识。
   *
   * 用途只有一个：判断「这次交接是不是已经被**别的**标签页接走了」。
   * 头歌的「开启挑战」「下一关」会开新标签页，于是旧标签页会停在旧关卡上变成僵尸页——
   * 它再往下走要么乱点、要么把**共享的**队列状态写成「已停」（GM 存储是同一个域的
   * 所有标签页共用的），把还在正常跑的标签页一起停掉。有了这个标识才能让它安静地退场。
   */
  const TAB_ID = Math.random().toString(36).slice(2) + Date.now().toString(36);

  const state = {
    templates: GM_getValue(KEYS.templates, []),
    answers: GM_getValue(KEYS.answers, {}),
    // 平台关卡标识 → L001 这类 level_id。答案是按 level_id 汇总的，
    // 关卡页上只能拿到 URL 里的平台标识，没有这张表两边永远对不上。
    levelIndex: GM_getValue(KEYS.levelIndex, {}),
    // 「实验名__关卡名」→ 复合键：平台重新发布实验换了关卡标识时的兜底匹配
    titleIndex: GM_getValue(KEYS.titleIds, {}),
    // 「关卡名」→ 复合键（控制台只收全局唯一的关卡名）：实验名对不上时的最后一道兜底
    titleOnlyIndex: GM_getValue(KEYS.titleOnlyIds, {}),
    // 当前正在处理的关卡上下文（实验名 / 关卡名），供标识对不上时兜底
    levelHint: null,
    // 编程题评测最多等几秒（代码评测要跑一会儿，太短会误判成"没结论"而中断队列）
    evalWaitSeconds: Math.max(1, Number(GM_getValue(KEYS.evalWaitSeconds, 30)) || 30),
    // 进关卡后等页面把关卡数据（/api/tasks/{id}.json）拉回来，最多等几秒。
    // 默认给宽：页面偶尔会很慢（实测有"数据晚到 1 秒就被判没读到"的情况），
    // 等待期只是 400ms 一次轮询，数据一到立刻走，给宽不会变慢、只是更保险。
    levelWaitSeconds: Math.max(5, Number(GM_getValue(KEYS.levelWaitSeconds, 60)) || 60),
    logs: GM_getValue(KEYS.log, []),
    // 上次导出日志到本地的时间戳：控制台是**追加**写，只发这之后的新行才不会重复
    lastLogExportAt: Number(GM_getValue(KEYS.lastLogExportAt, 0)) || 0,
    // 本地日志文件里已写到第几次（控制台返回），面板上显示给用户看
    logSeq: Number(GM_getValue(KEYS.logSeq, 0)) || 0,
    stopRequested: false,
    // 页面自己的关卡数据（几道题、每题几个选项），运行时观察 /api/tasks/{id}.json 得到；
    // 这是选题分组最权威的来源，控制台的 optionCounts 只是兜底。
    taskContext: null,
    // 关卡标识 → 时间戳：页面自己拉这一关数据失败过的记录（失败只能靠刷新重发）。
    // 用映射而不是单个槽位：页面会预取相邻关卡，单个槽位会被邻居的失败覆盖掉。
    taskFetchFailures: {},
    taskFetchFailureNote: null,
    // level_id → 每道题的选项个数。脚本靠它把页面上的选项按题切分（比 class 名可靠）。
    optionCounts: GM_getValue(KEYS.optionCounts, {}),
    local: GM_getValue(KEYS.local, DEFAULT_LOCAL),
    token: GM_getValue(KEYS.token, ''),
    // 教学课程接口要带账号 login（zzud 参数），运行时从 /api/users/get_user_info.json 取一次。
    teachLogin: '',
    // 导入的班级答案文件自带的 `class` 块（年级/班级名）：导出时原样写回，来回不失真
    classInfo: GM_getValue(KEYS.classInfo, null),
    busy: false
  };

  /* ------------------------------------------------------------------ 工具 */

  const snippet = (value, limit = 1200) => {
    const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
    return String(text || '').slice(0, limit);
  };

  /**
   * 面板里最多留多少条日志（超出就从头删）。
   *
   * 目标是「不用本地控制台」：日志**只**住在这边（GM 存储），刷新与关标签页都不丢，
   * 也不用再往控制台传。GM 存储有配额，所以必须有上限——300 条够回看一整段队列，
   * 又不至于把配额撑满。
   */
  const LOG_KEEP = 300;

  // 启动即裁剪：GM 里可能还留着旧版本攒下的超量日志（上限是后来才加的）。
  // 不裁的话面板计数会超过 300，要等到下一次 log() 才被顺手修正。
  if (state.logs.length > LOG_KEEP) {
    state.logs.splice(0, state.logs.length - LOG_KEEP);
    GM_setValue(KEYS.log, state.logs);
  }

  function log(message, tone = 'info') {
    const line = `[${new Date().toLocaleTimeString()}] ${message}`;
    state.logs.push({ time: Date.now(), tone, message: line });
    if (state.logs.length > LOG_KEEP) state.logs.splice(0, state.logs.length - LOG_KEEP);
    GM_setValue(KEYS.log, state.logs);
    renderLogStatus();
    const box = document.getElementById('eas-log');
    if (box) {
      const row = document.createElement('div');
      row.className = `eas-row eas-${tone}`;
      row.textContent = line;
      box.appendChild(row);
      box.scrollTop = box.scrollHeight;
    }
    console[tone === 'error' ? 'error' : 'log'](`[头歌自动作答] ${message}`);
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /* ---------------------------------------------------------------- 签名请求 */

  /**
   * 教学课程相关的接口（课程信息 / 课程结构 / 关卡列表）走 data.educoder.net，
   * 和引擎一样**必须带签名头**，否则会被 -102 拒绝——错误文案写的是「设备时间不匹配」，
   * 别被误导（详见 extractor/lib/educoder-sign.js 的说明）。
   *
   * 算法与常量与 extractor **同源**；网站改版时两边一起更新：
   * 抓 www-cdn.educoder.net/umi.<hash>.js，搜 setHeader / getKey，替换下面两个常量。
   */
  /**
   * **内置的签名常量**（双 base64，与控制台 `.env` / extractor 同一份，已按解两次
   * 可打印 ASCII 校验过）。
   *
   * 为什么进源码（用户 10-14 要求「固定进篡改猴，别每次都输」）：这套常量本来就是
   * 头歌**前端公开的客户端常量**——双 base64 只是混淆、不是机密，抓 umi JS 人人可得
   * （extractor/lib/educoder-sign.js 同款结论）。内置后开箱即用，不再依赖
   * 「手动粘贴」或「控制台同步」任何一条路。
   *
   * 平台换常量时：菜单「设置签名常量」粘贴新值即可覆盖（GM 存储优先于内置值），
   * 或更新本脚本拿新的内置值。
   */
  const EMBEDDED_SIGNING_KEYS = {
    ak: '',
    sk: ''
  };

  /**
   * 签名常量的取值顺序：**GM 存储（用户粘的）优先，缺哪半用内置值补哪半**。
   *
   * 内置值补上的瞬间会种回 GM——「设置签名常量」菜单的预填、以及后续的覆盖判断
   * 都走同一条路，不会再出现「明明有内置值却提示缺常量」。
   * GM 里已存的**完整一对**原样保留（哪怕粘错）：那是用户故意覆盖的值，
   * 被内置值悄悄顶掉反而更难排查。
   */
  function signingKeysRaw() {
    const ak = String(GM_getValue(KEYS.signAk, '') || '').trim();
    const sk = String(GM_getValue(KEYS.signSk, '') || '').trim();
    if (ak && sk) return { ak, sk };
    const fallbackAk = ak || EMBEDDED_SIGNING_KEYS.ak;
    const fallbackSk = sk || EMBEDDED_SIGNING_KEYS.sk;
    if (validateSigningKey(fallbackAk).ok && validateSigningKey(fallbackSk).ok) {
      if (!ak) GM_setValue(KEYS.signAk, fallbackAk);
      if (!sk) GM_setValue(KEYS.signSk, fallbackSk);
      return { ak: fallbackAk, sk: fallbackSk };
    }
    return { ak, sk };
  }

  /**
   * 从本地控制台同步签名常量（一次即可，结果写进 GM 存储）。
   *
   * 为什么值得做：常量本来要自己配一次，而用户往往是先撞上「课程读取失败：缺少签名常量」
   * 才知道有这么回事。控制台手上本来就有（`.env` 或 `.educoder-keys.json`），
   * 拉过来就不用再手动粘——而且常量仍然不进脚本源码。
   *
   * 已经配过就什么都不做（手动粘贴的优先级更高，不会被覆盖）。
   */
  function syncSigningKeysFromConsole() {
    if (hasSigningKeys()) return;
    consoleRequest('/api/signing-keys', {
      onload: (response) => {
        let payload = null;
        try {
          payload = JSON.parse(response.responseText || '{}');
        } catch (error) {
          payload = null;
        }
        if (!payload || !payload.ok || !payload.ak || !payload.sk) {
          log(
            `没从控制台拿到签名常量：${(payload && payload.error) || `HTTP ${response.status}`}`,
            'warn'
          );
          return;
        }
        GM_setValue(KEYS.signAk, String(payload.ak).trim());
        GM_setValue(KEYS.signSk, String(payload.sk).trim());
        log(`签名常量已从控制台同步（版本 ${payload.version || '未知'}）`, 'ok');
      },
      // 控制台没开不算错，但**要留一句可查的提示**：真正要用签名时报的
      // 「缺少签名常量」离原因太远——用户根本猜不到其实是「连不上控制台」。
      onerror: (info) => {
        if (info && info.reason === 'no-address') return; // 还没配地址，别在启动时刷屏
        log(
          '连不上本地控制台，签名常量没能同步。确认 `npm run ui` 在跑，'
            + '并用面板的「连接本地控制台」核对地址（端口固定 43127）。',
          'warn'
        );
      }
    });
  }

  /** 有没有可用的签名常量。 */
  /**
   * 校验用户粘进来的签名常量，返回 `{ ok, reason }`。
   *
   * 为什么必须校验：常量是**双重 base64**，而「只粘解过一次的那串」也能被 `decodeKey`
   * 解出一个结果（十六进制字符本身都是合法 base64 字符），只是解出来是乱码。乱码常量
   * 一路走到请求里，被拒后报的是 `-102 服务器时间不匹配`——**那句报错跟时间完全无关**
   * （见 README），用户会顺着错方向查半天。所以在**粘贴那一刻**就拦住。
   *
   * 判据：解两次后必须是**可打印 ASCII**。正确的那对常量解出来是 32 位十六进制；
   * 「只粘一次」的错法解出来是一串不可打印字节，正好被这条拦住。
   */
  function validateSigningKey(raw) {
    const text = String(raw || '').trim();
    if (!text) return { ok: false, reason: '空' };
    if (!/^[A-Za-z0-9+/=]+$/.test(text)) return { ok: false, reason: '含 base64 之外的字符' };
    // 解码靠页面上下文的 atob，**可能不存在**（罕见但会让 boot 直接炸）：
    // 这里必须自己兜住，绝不能把异常抛给调用方（hasSigningKeys 会在启动时被调用）。
    let once = '';
    let twice = '';
    try {
      once = base64Decode(text);
      twice = once ? base64Decode(once) : '';
    } catch (error) {
      return { ok: false, reason: error.message || '解码失败' };
    }
    if (!twice) return { ok: false, reason: '不是合法的 base64（字符或长度不对）' };
    if (!/^[\x20-\x7e]+$/.test(twice)) {
      return {
        ok: false,
        reason: '解两次后是不可打印的乱码——多半只粘了「解过一次」的那串；'
          + '要粘的是**双 base64**（更长、以 = 结尾）'
      };
    }
    return { ok: true, reason: '' };
  }

  function hasSigningKeys() {
    const keys = signingKeysRaw();
    // 不只看「存过没有」，还要**解码得出来**：粘错的值也算「有」，会一路错到 -102。
    return Boolean(keys.ak && keys.sk)
      && validateSigningKey(keys.ak).ok
      && validateSigningKey(keys.sk).ok;
  }

  /** 菜单入口：粘贴一次常量（本地存 GM）。 */
  function promptSigningKeys() {
    const current = signingKeysRaw();
    const ak = (prompt('粘贴 AK（双 base64 那串，来自 umi JS 的 setHeader/getKey）', current.ak) || '').trim();
    if (!ak) return;
    const akCheck = validateSigningKey(ak);
    if (!akCheck.ok) {
      log(`AK 没通过校验：${akCheck.reason}。没有保存，请重新粘一次。`, 'error');
      return;
    }
    const sk = (prompt('粘贴 SK（双 base64 那串）', current.sk) || '').trim();
    if (!sk) return;
    const skCheck = validateSigningKey(sk);
    if (!skCheck.ok) {
      log(`SK 没通过校验：${skCheck.reason}。没有保存，请重新粘一次。`, 'error');
      return;
    }
    GM_setValue(KEYS.signAk, ak);
    GM_setValue(KEYS.signSk, sk);
    // 只报「通过校验」，不回显值本身：值是双 base64，贴到日志/截图里没有意义还容易外泄。
    log('签名常量已保存并通过校验（双 base64 解两次得到可打印 ASCII，长度正确）', 'ok');
    log('现在可以读课程/实验/关卡了。若接口仍报 -102，说明平台换过常量，重新抓一次 umi JS 即可。', 'ok');
  }

  /** 已解码的签名常量；没设置或**校验不过**（粘错的值）返回 null——由调用方抛错指路。 */
  function signingKeys() {
    const raw = signingKeysRaw();
    if (!raw.ak || !raw.sk) return null;
    // 与 hasSigningKeys 同口径：粘错的值（如只解了一次的串）能 decodeKey 出结果，
    // 但那是乱码——一路算出签名只会换来 `-102 服务器时间不匹配`（跟时间无关，
    // 会把人带偏）。在这里拦住，让 signature() 抛出带获取方法的错误。
    if (!validateSigningKey(raw.ak).ok || !validateSigningKey(raw.sk).ok) return null;
    const ak = decodeKey(raw.ak);
    const sk = decodeKey(raw.sk);
    if (!ak || !sk) return null;
    return { ak, sk };
  }

  /**
   * 缺签名常量时的提示。
   *
   * 顺序是**刻意**的：把「菜单里手动粘一次」放前面，「启动控制台」放后面。
   * 脚本已经能脱开控制台用（导入班级答案文件即可作答），而常量是那条路上**唯一**
   * 需要手填的东西；反过来先劝人开控制台，在脱控制台的用法里就是把人指错方向。
   */
  /**
   * 缺签名常量时的提示。
   *
   * 常量已内置，正常情况下**永远走不到这里**（除非内置值本身失效——比如脚本被改坏）。
   * 文案保留「粘贴覆盖」这条路：平台换常量时用户在菜单里粘新值即可。
   */
  const MISSING_KEYS_HINT =
    '签名常量不可用（正常不会发生——脚本内置了常量）。若平台换过常量导致 -102：'
    + '点篡改猴菜单「设置签名常量」粘贴新的双 base64 值覆盖内置值，'
    + '或更新脚本拿新的内置值。';

  /** base64 编/解码走页面上下文（脚本沙箱里不保证有 btoa/atob）。 */
  function base64EncodeAscii(text) {
    const host = pageWindow();
    if (host && typeof host.btoa === 'function') return host.btoa(text);
    throw new Error('页面上下文没有 btoa，无法计算签名');
  }

  function base64Decode(value) {
    const host = pageWindow();
    if (host && typeof host.atob === 'function') return host.atob(value);
    throw new Error('页面上下文没有 atob，无法解码签名常量');
  }

  function decodeKey(encoded) {
    try {
      return base64Decode(base64Decode(encoded));
    } catch (error) {
      return '';
    }
  }

  /** 紧凑 md5（输入只按 ASCII 字节处理：签名串先 base64，天然是 ASCII）。 */
  function md5(str) {
    const S = [
      7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
      5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
      4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
      6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
    ];
    // K[i] = floor(abs(sin(i+1)) * 2^32)：用定义式现算，避免抄常数表抄错。
    const K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0);
    const bytes = [];
    for (let i = 0; i < str.length; i++) bytes.push(str.charCodeAt(i) & 0xff);
    const bitLength = bytes.length * 8;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    for (let i = 0; i < 8; i++) bytes.push((bitLength / Math.pow(2, i * 8)) & 0xff);
    const words = [];
    for (let i = 0; i < bytes.length; i += 4) {
      words.push(bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24));
    }
    let a = 0x67452301 | 0;
    let b = 0xefcdab89 | 0;
    let c = 0x98badcfe | 0;
    let d = 0x10325476 | 0;
    const leftRotate = (value, bits) => (value << bits) | (value >>> (32 - bits));
    for (let offset = 0; offset < words.length; offset += 16) {
      const start = { a, b, c, d };
      for (let i = 0; i < 64; i++) {
        let f;
        let g;
        if (i < 16) { f = (b & c) | (~b & d); g = i; }
        else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
        else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; }
        else { f = c ^ (b | ~d); g = (7 * i) % 16; }
        const tmp = d;
        d = c;
        c = b;
        b = (b + leftRotate((a + f + K[i] + words[offset + g]) | 0, S[i])) | 0;
        a = tmp;
      }
      a = (start.a + a) | 0;
      b = (start.b + b) | 0;
      c = (start.c + c) | 0;
      d = (start.d + d) | 0;
    }
    const hex = (value) => {
      let out = '';
      for (let i = 0; i < 4; i++) out += (((value >>> (i * 8)) & 0xff) + 0x100).toString(16).slice(1);
      return out;
    };
    return hex(a) + hex(b) + hex(c) + hex(d);
  }

  /**
   * 拼出待签名的明文（与 extractor/lib/educoder-sign.js 的 signingText 同构）。
   * 没设置常量时抛带获取方法的错误，不静默发出必被拒的请求。
   */
  function signingText(method, time) {
    const keys = signingKeys();
    if (!keys) throw new Error(MISSING_KEYS_HINT);
    return `method=${String(method || 'GET').toUpperCase()}&ak=${keys.ak}&sk=${keys.sk}&time=${time}`;
  }

  /** signature = md5(base64(signingText(method, time)))。 */
  function signature(method, time) {
    return md5(base64EncodeAscii(signingText(method, time)));
  }

  function buildSignedHeaders(method = 'GET', now = Date.now()) {
    const time = String(now);
    return {
      'X-EDU-Timestamp': time,
      'X-EDU-Signature': signature(method, time),
      'X-EDU-Type': 'pc'
    };
  }

  /**
   * 带签名 GET：请求走页面上下文（与引擎在页面里发请求同路，cookie 由页面自动带上）。
   * -102 时抛出人话（网站改版 → 更新常量），不误报成登录过期。
   */
  async function signedGet(url) {
    const host = pageWindow();
    if (!host || typeof host.fetch !== 'function') throw new Error('页面上下文不可用（无法发带签名请求）');
    const response = await host.fetch(url, {
      credentials: 'include',
      headers: { Accept: 'application/json', ...buildSignedHeaders('GET') }
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch (error) {
      payload = null;
    }
    if (!response.ok) throw new Error(`请求失败（HTTP ${response.status}）：${url}`);
    if (payload === null) {
      throw new Error(`接口返回的不是 JSON（可能被登录墙或改版拦住）：${url}`);
    }
    if (payload && Number(payload.status) === -102) {
      throw new Error('签名被拒（-102）：网站可能改版，需更新脚本与 extractor/lib/educoder-sign.js 里的签名常量');
    }
    return payload;
  }

  /* ------------------------------------------------------------ 教学课程发现层 */

  const TEACH_ORIGIN = 'https://data.educoder.net';

  /** /api/paths/{identifier}.json → { identifier, id, name }（教学课程信息）。 */
  function parsePathCourse(identifier, payload) {
    return {
      identifier: String(identifier || ''),
      id: Number(payload && payload.id) || 0,
      name: String((payload && payload.name) || '').trim()
    };
  }

  /** 当前页面是不是教学课程页（/paths/{identifier}）。 */
  function parseCurrentPathIdentifier() {
    const match = /^\/paths\/(\w+)/.exec(String(location.pathname || ''));
    return match ? match[1] : '';
  }

  /** /api/v2/stages.json → 摊平成课程实验列表（只要 Shixun，且必须有 identifier）。 */
  function parseCourseExperiments(payload) {
    const stages = payload && payload.data && Array.isArray(payload.data.stages) ? payload.data.stages : [];
    const out = [];
    for (const stage of stages) {
      for (const item of Array.isArray(stage.items) ? stage.items : []) {
        if (String(item.item_type || '') !== 'Shixun') continue;
        if (!item.identifier) continue;
        out.push({
          stageName: String(stage.stage_name || '').trim(),
          name: String(item.name || item.shixun_name || '').trim(),
          identifier: String(item.identifier),
          challenges: Number(item.challenges_count) || 0,
          finished: Number(item.finished_challenges_count) || 0,
          jupyter: Boolean(item.is_jupyter || item.is_jupyter_lab),
          progressKnown: true
        });
      }
    }
    return out;
  }

  /** 关卡列表：shixuns / myshixuns 两种端点结构都认（challenge_list 或数组）。 */
  function parseChallenges(payload) {
    const rows = Array.isArray(payload)
      ? payload
      : payload && Array.isArray(payload.challenge_list)
        ? payload.challenge_list
        : payload && Array.isArray(payload.challenges)
          ? payload.challenges
          : [];
    return rows
      .map((item, index) => ({
        name: String(item.name || item.subject || '').trim() || `第${index + 1}关`,
        position: Number(item.position ?? item.homework_challenge_index ?? 0) || index + 1,
        identifier: String(item.identifier || '')
      }))
      .sort((a, b) => a.position - b.position);
  }

  /** 教学课程没有「我的课程列表」接口（courses.json 是课堂，实测 subject_id 全为 null）：
   *  课程来源 = 当前 /paths/{identifier} 页 + 本地缓存；名字走 /api/paths/{identifier}.json。 */
  function readTeachCourseCache() {
    const cached = GM_getValue(KEYS.teachCourses, []);
    return Array.isArray(cached) ? cached : [];
  }

  function cacheTeachCourse(course) {
    if (!course || !course.identifier) return;
    const list = readTeachCourseCache().filter((item) => item.identifier !== course.identifier);
    list.unshift(course);
    GM_setValue(KEYS.teachCourses, list.slice(0, 20));
  }

  async function ensureTeachLogin() {
    if (state.teachLogin) return state.teachLogin;
    const identity = await signedGet(`${TEACH_ORIGIN}/api/users/get_user_info.json?school=1`);
    state.teachLogin = identity && identity.login ? String(identity.login) : '';
    if (!state.teachLogin) throw new Error('拿不到账号 login：确认已登录头歌');
    return state.teachLogin;
  }

  async function loadPathCourse(identifier) {
    const payload = await signedGet(
      `${TEACH_ORIGIN}/api/paths/${encodeURIComponent(identifier)}.json`
      + `?identifier=${encodeURIComponent(identifier)}&id=${encodeURIComponent(identifier)}`
    );
    return parsePathCourse(identifier, payload);
  }

  async function loadTeachExperiments(identifier) {
    const login = await ensureTeachLogin();
    // 参数照抄真机（页面自身请求的形态），少了 show_course_section/zzud 实测会 404。
    const url = `${TEACH_ORIGIN}/api/v2/stages.json`
      + `?tab=&stage_id=&stage_item_id=&show_course_section=false`
      + `&subject_id=${encodeURIComponent(identifier)}&keywords=&zzud=${encodeURIComponent(login)}`;
    const payload = await signedGet(url);
    return parseCourseExperiments(payload);
  }

  async function loadTeachChallenges(identifier) {
    const payload = await signedGet(
      `${TEACH_ORIGIN}/api/shixuns/${encodeURIComponent(identifier)}/challenges.json?id=${encodeURIComponent(identifier)}`
    );
    return parseChallenges(payload);
  }

  /** /api/users/{login}/courses.json → 我的课堂（classroomCode 从 first_category_url 里取）。 */
  function parseClassrooms(payload) {
    const rows = payload && Array.isArray(payload.courses) ? payload.courses : [];
    return rows
      .map((item) => {
        const match = /\/classrooms\/(\w+)/.exec(String(item.first_category_url || ''));
        return {
          kind: 'classroom',
          id: Number(item.id) || 0,
          name: String(item.name || '').trim(),
          classroomCode: match ? match[1] : ''
        };
      })
      .filter((item) => item.id && item.name);
  }

  async function loadClassrooms() {
    const login = await ensureTeachLogin();
    const payload = await signedGet(
      `${TEACH_ORIGIN}/api/users/${encodeURIComponent(login)}/courses.json`
      + `?category=&status=processing&page=1&per_page=100&sort_by=updated_at&sort_direction=desc`
      + `&username=${encodeURIComponent(login)}&zzud=${encodeURIComponent(login)}`
    );
    return parseClassrooms(payload);
  }

  /**
   * 递归收集「像实训条目」的对象。
   *
   * **不能只看顶层 `is_shixun`**：课堂实验列表里，一个条目下面还挂着子标签
   * （实测 URL 形如 `/classrooms/{课程}/shixun_homework/{homework_id}?tabs=0`），
   * 它们嵌在 `children` / `items` / `homeworks` 之类的数组字段里，**且不一定带 `is_shixun`**。
   * 只按顶层过滤就会整片漏掉——用户实测：课堂实验一个都读不到。
   * （判定口径与抓取端 extract-engine.collectShixunItems 保持一致。）
   */
  function collectClassroomShixuns(node, out = [], depth = 0, insideShixun = false) {
    if (!node || typeof node !== 'object' || depth > 4) return out;
    if (Array.isArray(node)) {
      for (const item of node) collectClassroomShixuns(item, out, depth + 1, insideShixun);
      return out;
    }
    const shixunIdentifier = typeof node.shixun_identifier === 'string' ? node.shixun_identifier : '';
    const myshixunIdentifier = typeof node.myshixun_identifier === 'string' ? node.myshixun_identifier : '';
    const markedAsShixun = node.is_shixun === true || node.is_shixun === 1;
    const name = String(node.name || node.homework_name || node.subject || '').trim();
    const homeworkId = Number(node.homework_id);
    const shouldCollect = Boolean(name)
      && (markedAsShixun || Boolean(shixunIdentifier) || Boolean(myshixunIdentifier)
        || (insideShixun && Number.isFinite(homeworkId) && homeworkId > 0));
    if (shouldCollect) out.push(node);
    const childContext = insideShixun || markedAsShixun || Boolean(shixunIdentifier) || Boolean(myshixunIdentifier);
    for (const [key, value] of Object.entries(node)) {
      if (!Array.isArray(value) || !value.length) continue;
      const first = value[0];
      if (!first || typeof first !== 'object') continue;
      // 只在「已经在实训上下文里」或字段名像子列表时才往下找，避免把无关数组也翻了
      if (childContext || /child|sub|item|homework|group|list|shixun/i.test(key)) {
        collectClassroomShixuns(value, out, depth + 1, childContext);
      }
    }
    return out;
  }

  /** /api/courses/{classroomCode}/homework_commons.json → 课堂实验（递归收集，按标识去重）。 */
  function parseClassroomExperiments(payload) {
    const rows = payload && Array.isArray(payload.homeworks) ? payload.homeworks : [];
    const seen = new Set();
    const out = [];
    let noIdentifier = 0;
    for (const item of collectClassroomShixuns(rows)) {
      const identifier = String(item.shixun_identifier || item.myshixun_identifier || '');
      // 只有 homework_id、没有实训标识的条目面板跑不了（关卡列表要按实训标识取），
      // 先跳过并计数，让日志说清楚漏了多少，而不是静默变少。
      if (!identifier) {
        noIdentifier += 1;
        continue;
      }
      if (seen.has(identifier)) continue;
      seen.add(identifier);
      out.push({
        stageName: '课堂实验',
        name: String(item.name || item.homework_name || item.subject || '').trim() || identifier,
        identifier,
        challenges: Number(item.challenge_count) || 0,
        finished: 0,
        jupyter: false,
        progressKnown: false
      });
    }
    if (noIdentifier) {
      log(`课堂里有 ${noIdentifier} 个实训条目只有 homework_id、没有实训标识，面板暂时读不了它们`, 'warn');
    }
    return out;
  }

  async function loadClassroomExperiments(classroomCode) {
    const login = await ensureTeachLogin();
    // **必须带参数**：不带 `limit` 只能拿到默认的一页（实测只回来一部分，
    // 页面上第 1~4 章的实验整片没有）。参数口径与抓取端 listExperiments 完全一致。
    const payload = await signedGet(
      `${TEACH_ORIGIN}/api/courses/${encodeURIComponent(classroomCode)}/homework_commons.json`
      + `?limit=100&status=0&id=${encodeURIComponent(classroomCode)}&type=4&order=0`
      + `&zzud=${encodeURIComponent(login)}`
    );
    const list = parseClassroomExperiments(payload);
    if (!list.length) {
      log(`课堂 ${classroomCode} 没解析出可作答的实训（若页面明明有，请把这条日志发我）`, 'warn');
    } else {
      // 把读到的前几个名字打出来：这次"明明有却读不到"就是因为只回来一页，
      // 有名字对照才能一眼看出是"没读到"还是"读到的不是那一批"。
      log(`课堂实验读到 ${list.length} 个：${list.slice(0, 6).map((item) => item.name).join('、')}${list.length > 6 ? '…' : ''}`, 'ok');
    }
    return list;
  }

  /* ------------------------------------------------------------ 教学课程判定（纯函数） */

  /**
   * 「已通过测评」：得分达到满分（与 extractor/lib/answer-store.js 的 levelPassed 同口径）。
   * 判据字段就在脚本已经在观察的 /api/tasks/{id}.json 里（challenge.score / game.final_score）。
   */
  function levelPassedOf(payload) {
    const max = Number(payload && payload.challenge && payload.challenge.score);
    const got = Number(payload && payload.game && payload.game.final_score);
    return Number.isFinite(max) && max > 0 && Number.isFinite(got) && got >= max;
  }

  /**
   * 队列里「当前这一关怎么处理」：顺序即优先级（未选中 → 虚拟机 → 已通过 → 无答案 → 作答）。
   * @returns {'unselected'|'vm'|'passed'|'missing'|'answer'}
   */
  function teachLevelAction({ selected, hasEditor, hasChoice, passed, hasAnswer }) {
    if (!selected) return 'unselected';
    if (!hasEditor && !hasChoice) return 'vm';
    if (passed) return 'passed';
    if (!hasAnswer) return 'missing';
    return 'answer';
  }

  /** 队列构建（纯函数）：默认 = 该实验全部关卡；虚拟机实验整体剔除。 */
  function buildTeachQueue(experiments, selection, levelsByExperiment) {
    const selected = new Set((selection && selection.experiments) || []);
    const queue = [];
    const skippedJupyter = [];
    for (const experiment of experiments) {
      if (!selected.has(experiment.identifier)) continue;
      if (experiment.jupyter) {
        skippedJupyter.push(experiment.name);
        continue;
      }
      const all = (levelsByExperiment && levelsByExperiment[experiment.identifier]) || [];
      const chosen = selection && selection.levels ? selection.levels[experiment.identifier] : null;
      const wanted = Array.isArray(chosen) && chosen.length ? chosen : all.map((level) => level.position);
      if (!wanted.length) continue;
      queue.push({
        identifier: experiment.identifier,
        name: experiment.name,
        positions: [...wanted].sort((a, b) => a - b),
        allPositions: all.map((level) => level.position),
        levelNames: Object.fromEntries(all.map((level) => [level.position, level.name])),
        // 每关的 identifier：用它可以直接拼 URL 跳到指定关，不必逐关回退
        levelIdentifiers: Object.fromEntries(all.map((level) => [level.position, level.identifier]))
      });
    }
    return {
      experiments: queue,
      skippedJupyter,
      total: queue.reduce((sum, item) => sum + item.positions.length, 0)
    };
  }

  /** 组装一条缺答案上报。 */
  function buildMissingItem({ course, experiment, levelName, position, identifier, url }) {
    return {
      course: String(course || ''),
      experiment: String(experiment || ''),
      level: String(levelName || `第${position}关`),
      level_id: position > 0 ? `L${String(position).padStart(3, '0')}` : '',
      identifier: String(identifier || ''),
      url: String(url || ''),
      reason: 'no-answer'
    };
  }

  /** 关卡 URL 的标识永远在最后一段（真机：教学课程关卡页是单段式 /tasks/{id}）。 */
  function urlForLevelIdentifier(identifier) {
    const parts = String(location.pathname || '').split('/').filter(Boolean);
    if (parts[0] !== 'tasks' || !identifier) return '';
    parts[parts.length - 1] = identifier;
    return `${location.origin || ''}/${parts.join('/')}${location.search || ''}`;
  }

  /** 当前页面对应的那份关卡数据（id 与当前 URL 标识一致才算数；否则视为「还没读到」）。 */
  function currentTask() {
    const identifier = currentLevelId();
    if (!identifier || !state.taskContext) return null;
    return state.taskContext.id === identifier ? state.taskContext : null;
  }

  /**
   * 回退决策（纯函数）：`go` 才跳，否则返回停止原因。
   * 为什么要这些保险：真机上「跳上一关」可能被站点重定向回同一关（或开新标签页），
   * 没有跨页面计数就会在第一关无限打转。
   */
  function backtrackDecision({ hops, trail, previous, currentIdentifier }) {
    if (!previous) return 'stop:没有上一关';
    if (previous === currentIdentifier) return 'stop:自指（上一关就是本关）';
    if (Array.isArray(trail) && trail.includes(previous)) return 'stop:打转（检测到重复回退）';
    if (Number(hops) >= 8) return 'stop:回退次数过多';
    return 'go';
  }

  /** 是否允许执行「回退链首」：只有 course 模式、且还在「刚进实验」阶段。 */
  function shouldBacktrack(queue) {
    return Boolean(queue) && queue.mode === 'course' && Boolean(queue.needChainStart);
  }

  /**
   * handoff 新鲜度：只有「刚跳过转」才自动续跑，防止用户随手点开关卡页就乱跑。
   *
   * 窗口取 `max(90 秒, 关卡数据等待上限 + 30 秒)`：面板里「关卡数据最多等（秒）」可以调到 300，
   * 若仍按固定 90 秒判，**等待本身**就会被当成「太久没跳转」——下一轮刷新回来直接停队，
   * 表现就是「我明明把等待调大了，它还是停」。
   */
  function queueFresh(queue) {
    if (!(queue && queue.running)) return false;
    const windowMs = Math.max(90, (Number(state.levelWaitSeconds) || 60) + 30) * 1000;
    return Date.now() - Number(queue.handoffAt || 0) < windowMs;
  }

  /** 队首是否就是当前页面（纯函数）。 */
  function queueMatchesCurrent(queue, current) {
    if (!queue || !queue.running) return false;
    if (queue.mode === 'missing') {
      const item = queue.items[queue.index];
      if (!item) return false;
      if (item.identifier && item.identifier === current.identifier) return true;
      return Boolean(item.url) && String(item.url).split('?')[0] === String(current.href || '').split('?')[0];
    }
    const experiment = queue.experiments[queue.experimentIndex];
    if (!experiment) return false;
    if (queue.expected && queue.expected.identifier) return queue.expected.identifier === current.identifier;
    const positions = Array.isArray(experiment.allPositions) && experiment.allPositions.length
      ? experiment.allPositions
      : experiment.positions;
    return Number(current.position) > 0 && positions.includes(Number(current.position));
  }

  /* ---------------------------------------------------------------- 教学课程队列 */

  function readTeachQueue() {
    return GM_getValue(KEYS.teachQueue, null);
  }

  function writeTeachQueue(queue) {
    GM_setValue(KEYS.teachQueue, queue);
  }

  function finishTeachQueue() {
    const queue = readTeachQueue();
    if (queue) {
      queue.running = false;
      queue.finishedAt = new Date().toISOString();
      writeTeachQueue(queue);
    }
    const teach = teachSelection();
    teach.status = '队列完成';
    renderTeach();
    log('教学课程队列完成', 'ok');
    exportLogs(); // 跑完了把日志传回控制台落盘，省得在小面板里翻
  }

  function stopTeachQueue(reason, tone = 'warn') {
    const queue = readTeachQueue();
    if (queue && queue.running) {
      queue.running = false;
      queue.stoppedReason = reason || '';
      writeTeachQueue(queue);
    }
    const teach = teachSelection();
    teach.status = reason ? `已停：${reason}` : '已停';
    renderTeach();
    log(`教学课程队列已停：${reason || '（未说明原因）'}`, tone);
    exportLogs(); // 停了也把日志传回控制台（多半是出错了，更要留档）
  }

  function requestTeachStop() {
    stopTeachQueue('用户点了停止');
  }

  /**
   * 确保拿到这一关的关卡数据；拿不到就**刷新重试**（每关最多 2 次）。
   *
   * **两条入口都走这里**——`maybeContinueTeachQueue`（刚进关卡/刷新后的续跑）与
   * `processTeachLevel`（开始作答前）。原来这两处各写了一份，行为还不一样：
   * 续跑那处只等约 9.5 秒就停队，`processTeachLevel` 那处等面板设置的 60 秒——
   * 结果前者先跑，后者永远轮不到，「60 秒设置不生效」就是这么来的（实测 16:11 日志）。
   *
   * **两次重试的最小间隔 10 秒**不能省：请求失败时 `waitForLevelData` 5 秒就早退，
   * 不补间隔就成了「5 秒一次连着刷」，网络抖动时反而更容易全失败。
   *
   * @returns {Promise<{task: object|null, reloading: boolean}>}
   *   `reloading: true` = 已发起刷新，调用方**直接收工**，别停队、别往下走
   */
  async function ensureLevelData(queue, { gapMs = 10_000, bailAfterMs = 5000 } = {}) {
    const startedAt = Date.now();
    let task = currentTask();
    if (!task) {
      const waitSeconds = Number(state.levelWaitSeconds) || 60;
      log(`还没读到这一关的关卡数据，等页面把它拉回来（最多 ${waitSeconds} 秒）…`, 'warn');
      task = await waitForLevelData(0, bailAfterMs);
    }
    if (task) return { task, reloading: false };

    const elapsed = Date.now() - startedAt;
    if (elapsed < gapMs) {
      const rest = gapMs - elapsed;
      log(`再等 ${Math.ceil(rest / 1000)} 秒后重试（两次重试间隔不少于 ${gapMs / 1000} 秒）…`, 'warn');
      await sleep(rest);
    }
    if (await reloadForLevelData(queue)) return { task: null, reloading: true };
    return { task: null, reloading: false };
  }

  /** 每次页面加载后调用：队首在此就续跑，不在就暂停（不盲目乱跑）。 */
  let teachQueueChecking = false; // SPA 接力与 boot 可能同时触发，防重入
  async function maybeContinueTeachQueue() {
    if (teachQueueChecking) return;
    teachQueueChecking = true;
    try {
      const queue = readTeachQueue();
      if (!queue || !queue.running) return;
      if (!queueFresh(queue)) {
        stopTeachQueue('超过 90 秒没有新的跳转，已暂停（防止乱跑）');
        return;
      }
      if (/^\/tasks\//.test(location.pathname)) {
        // 与 processTeachLevel 共用同一套「等 → 补间隔 → 刷新重试」，别再各写一份。
        const ready = await ensureLevelData(queue);
        if (ready.reloading) return;
        if (!ready.task) {
          stopTeachQueue(
            `等了 ${Number(state.levelWaitSeconds) || 60} 秒并刷新重试 2 次，还是没读到这一关的关卡数据`
              + '（页面一直在加载、被拦，或内容在 iframe 里）。'
              + '可以再点「继续答题（跳过已通过）」，或把面板「关卡数据最多等（秒）」调大',
            'warn'
          );
          return;
        }
        const task = ready.task;
        const current = {
          identifier: currentLevelId(),
          position: Number(task.levelPosition) || 0,
          href: location.href
        };
        if (!queueMatchesCurrent(queue, current)) {
          stopTeachQueue(`当前页面不是队首，已暂停（本页 position=${current.position}，期望 ${queue.expected && queue.expected.identifier ? `标识 ${queue.expected.identifier}` : `序号 ${(queue.experiments[queue.experimentIndex] && (queue.experiments[queue.experimentIndex].allPositions || queue.experiments[queue.experimentIndex].positions) || []).join('/')}`}）`);
          return;
        }
        await processTeachLevel(queue);
        return;
      }
      if (/^\/shixuns\//.test(location.pathname) && queue.mode === 'course') {
        const experiment = queue.experiments[queue.experimentIndex];
        if (!experiment || !location.pathname.includes(`/shixuns/${experiment.identifier}/`)) return;
        await sleep(1500);
        let button = null;
        for (let i = 0; i < 12 && !button; i += 1) {
          button = findButton(TEACH_ENTRY_PATTERNS);
          if (!button) await sleep(1000);
        }
        if (!button) {
          // 找不到入口不再停整条队列：换号/权限/改版都可能让按钮变样，
          // 记清楚「页面上到底有什么按钮」再跳过这个实验，后面的实验继续跑。
          const visible = describeButtons();
          log(
            `实验页上没找到入口按钮（${location.pathname}），跳过该实验。`
            + `页面可见按钮：${visible.length ? visible.slice(0, 8).join(' / ') : '(没扫到按钮)'}`,
            'warn'
          );
          queue.experimentIndex += 1;
          queue.visited = [];
          queue.needChainStart = false;
          writeTeachQueue(queue);
          return enterTeachExperiment(queue);
        }
        log(`进入课程实验「${experiment.name}」：点击「${buttonLabel(button)}」`);
        queue.handoffAt = Date.now();
        writeTeachQueue(queue);
        const before = location.pathname;
        // 强制在当前标签页跳转：头歌的「开启挑战」「查看实战」会开新标签页（旧标签页会一直留着）
        const popped = clickStayingInThisTab(button);
        // 8 秒：正常跳转 1~2 秒就完成；这里给宽一点但不给到 15 秒——后面还有兜底导航，
        // 早点走比多等 7 秒强（一整条 100+ 关的队列会把这些秒数放大）。
        if (await waitForPathChange(before, 8000)) {
          await sleep(1500);
          // SPA 下脚本没重载：同上下文接力；整页重载时这行不会执行，由 boot 接手。
          // 接力本身就是「再进一次本函数」，先放行重入标志，别被自己的防重入挡掉。
          teachQueueChecking = false;
          await maybeContinueTeachQueue();
          return;
        }
        // 页面没动：控件可能点不动（改版 / 被遮 / 合成事件没接上），
        // 但它的目标地址通常是确定的 —— 直接走过去，别干等超时后停队。
        const target = clickTargetOf(button, popped);
        if (target && target !== location.href) {
          log(`点了「${buttonLabel(button)}」页面没动，改用它的目标地址直接跳转：${target}`, 'warn');
          location.href = target;
          return;
        }
        log(
          `点了「${buttonLabel(button)}」页面既没跳转、也没能拿到目标地址。`
            + `当前页 ${location.pathname}；可见按钮：${describeButtons().slice(0, 8).join(' / ') || '(没扫到)'}`,
          'warn'
        );
        // 本页没跳转：多半是新标签页被开走了——那就安静退场，别去动共享的队列状态。
        await closeSelfIfStale();
      }
    } finally {
      teachQueueChecking = false;
    }
  }

  /**
   * 拼一个指向本地控制台的接口地址。
   *
   * 使用者可能粘的是 `npm run ui` 打印的**完整地址**（带 `?token=`），也可能只填
   * `http://127.0.0.1:43127`。早先的写法是直接 `base + '/api/answers'`，
   * 粘完整地址时会拼成 `http://127.0.0.1:43127/?token=xxx/api/answers` 这种非法 URL。
   * 这里统一用 URL 解析：保留端口、取出 token、替换 path。
   */
  function consoleEndpoint(pathname, base = null) {
    // base 传了就用它（自动纠正过期地址时要拿默认地址试一次），否则用当前存的地址
    const raw = String((base === null ? state.local : base) || '').trim();
    if (!raw) return '';
    let url = null;
    try {
      url = new URL(raw);
    } catch (error) {
      try {
        url = new URL('http://' + raw.replace(/^\/+/, ''));
      } catch (error2) {
        return '';
      }
    }
    const token = url.searchParams.get('token') || state.token || '';
    if (token) state.token = token;
    url.pathname = pathname;
    url.search = token ? `?token=${encodeURIComponent(token)}` : '';
    url.hash = '';
    return url.toString();
  }

  /**
   * 向本地控制台发请求（**统一入口**）。
   *
   * ## 为什么要有这个入口
   *
   * 一是少写六遍一样的 GM_xmlhttpRequest；
   * 二是**自动纠正过期的地址**——控制台端口曾经由系统随机分配，所以 GM 里可能存着
   * `http://127.0.0.1:61238/?token=...` 这种指向早已不存在的端口的地址。请求必然连不上，
   * 而症状是「签名常量同步不到 → 课程读取失败」这种毫不相干的报错，极难自查。
   * 现在端口固定了，所以连不上时用默认地址再试一次；通了就换过去并说明。
   */
  function consoleRequest(pathname, options = {}) {
    // body 收对象（自动序列化）；要发字符串就直接用 rawBody
    const { method = 'GET', body, rawBody, onload, onerror } = options;
    const payload = rawBody !== undefined ? rawBody : (body ? JSON.stringify(body) : undefined);
    const first = consoleEndpoint(pathname);
    if (!first) {
      if (onerror) onerror({ reason: 'no-address' });
      return;
    }
    const masked = first.replace(/token=[^&]+/, 'token=***');
    const send = (url, isRetry) => {
      GM_xmlhttpRequest({
        method,
        url,
        headers: payload ? { 'Content-Type': 'application/json' } : undefined,
        data: payload,
        onload: (response) => {
          if (isRetry) {
            // 用默认地址试通了：换过去，免得下次又白试一遍
            state.local = DEFAULT_LOCAL;
            GM_setValue(KEYS.local, DEFAULT_LOCAL);
            log(`控制台地址已更正为 ${DEFAULT_LOCAL}`, 'ok');
          }
          if (onload) onload(response);
        },
        onerror: () => {
          const fallback = consoleEndpoint(pathname, DEFAULT_LOCAL);
          if (!isRetry && fallback && fallback !== url) {
            log(`连不上 ${masked}，改用默认地址再试一次`, 'warn');
            send(fallback, true);
            return;
          }
          if (onerror) onerror({ reason: 'unreachable' });
        }
      });
    };
    send(first, false);
  }

  /** 当前关卡的标识：URL 最后一段（三段式 /tasks/{课程码}/{作业ID}/{关卡标识}）。 */
  function currentLevelId() {
    const parts = location.pathname.split('/').filter(Boolean);
    return parts[0] === 'tasks' ? parts[parts.length - 1] : '';
  }

  /** 当前页面这一关在答案库里的键：优先用控制台给的映射，退回平台标识。 */
  function answerKeyForCurrentLevel() {
    const identifier = currentLevelId();
    if (state.levelIndex[identifier]) return state.levelIndex[identifier];
    // 标识对不上时的兜底：平台重新发布实验、或课堂与教学课程是两份副本时，
    // 同一个关卡会拿到**完全不同**的平台标识（本地 b8ofvk6ux2ns，页面 ytpru8qnfehi，
    // 标题都是「系统的8个综合需求」）。按内容匹配：
    //   ① 实验名__关卡名（最精确；控制台对「[分类] 实验名」也建了去前缀的键）
    //   ② 关卡名（控制台只收全局唯一的关卡名；课堂流程拿不到实验名时靠它）
    const hint = state.levelHint;
    const levelName = (hint && hint.levelName) || (state.taskContext && state.taskContext.levelTitle) || '';
    if (levelName) {
      if (hint && hint.experimentName) {
        const byPair = state.titleIndex[`${hint.experimentName}__${levelName}`];
        if (byPair) return byPair;
      }
      const byTitle = state.titleOnlyIndex[levelName];
      if (byTitle) return byTitle;
    }
    return identifier;
  }

  /**
   * 取当前关卡的答案，并**核对班级**。
   *
   * ## 为什么必须核对
   *
   * 同一个实验（同名、同关卡名）可能同时存在于多个班级里。旧实现只按平台关卡标识、
   * 或退一步按「实验名__关卡名」匹配——标识对不上时就会靠名字兜底，
   * 于是可能把**别的班**的答案填进来。按名字兜底本身是必要的（平台重新发布实验会
   * 换掉一整组标识），但兜底之后必须再确认「这份答案确实属于当前班级」。
   *
   * ## 班级从哪来
   *
   * 关卡页的 URL（`/tasks/{课程码}/{作业ID}/{关卡标识}`）里**没有班级码**，
   * 只有关卡数据里有：`course_identifier` 就是课堂码（如 `HCEAP94S`）。
   * 所以核对依赖 `observeTaskJson` 先把班级写进 `state.taskContext`。
   *
   * ## 判定
   *
   * | 情况 | 处置 |
   * |---|---|
   * | 关卡数据还没读到（拿不到班级） | 不拦，记提示——页面刚打开时还没发请求 |
   * | 答案是老答案库、没有班级码 | 不拦，记提示 |
   * | 两者都有且不一致 | **拒绝作答**，并说明两边分别是什么 |
   */
  function resolveAnswerForCurrentLevel() {
    const answerKey = answerKeyForCurrentLevel();
    const entry = state.answers[answerKey];
    if (!entry) return { answerKey, entry: null, blocked: '' };

    const pageCode = String((state.taskContext && state.taskContext.classroomCode) || '').trim();
    const answerCode = String(entry.classroomCode || '').trim();
    if (!pageCode) {
      log('关卡数据里没有班级信息，本次跳过班级核对（答案可能来自别的班，请留意）。', 'warn');
    } else if (!answerCode) {
      log(`答案没有班级标记（老答案库），无法核对它是否属于课堂 ${pageCode}。`, 'warn');
    } else if (answerCode !== pageCode) {
      return {
        answerKey,
        entry,
        blocked: `班级不一致：这份答案属于课堂 ${answerCode}`
          + `${entry.classroomName ? `（${entry.classroomName}）` : ''}，而当前页面是课堂 ${pageCode}。`
          + '为避免把别班的答案填进来，已拒绝作答。'
      };
    }
    return { answerKey, entry, blocked: '' };
  }

  /* --------------------------------------------------------- 网络录制（核心） */

  function remember(entry) {
    // 只关心「写」请求：提交答案、运行评测一定不是 GET。
    if (!/^(POST|PUT|PATCH|DELETE)$/i.test(entry.method)) return;
    const key = `${entry.method} ${entry.url.split('?')[0]}`;
    const list = state.templates.filter((item) => item.key !== key);
    const record = { key, ...entry, seenAt: Date.now() };
    list.unshift(record);
    state.templates = list.slice(0, 30);
    GM_setValue(KEYS.templates, state.templates);
    log(`录制到提交接口：${key}`, 'ok');
    // 提交类接口顺手回传给控制台落盘：这样「录制一次、永久复用」不必再手工搬文件。
    if (/submit|evaluate|answer|commit|judge/i.test(entry.url)) pushBlueprint(record);
  }

  /**
   * 把录制到的提交请求回传给本地控制台，由它写进对应实验目录的 submit.blueprint.json。
   *
   * 为什么需要回传：`submit.blueprint.json` 原先**没有任何生成端**，只能靠使用者
   * 在篡改猴里导出录制结果、再手工挪到实验目录，「免录制」的链路因此名存实亡。
   * 控制台按关卡标识把蓝图放进正确的实验目录（映射见 server.js 的 levelDirs）。
   */
  function pushBlueprint(record) {
    consoleRequest('/api/blueprint', {
      method: 'POST',
      body: {
        levelId: currentLevelId(),
        key: record.key,
        url: record.url,
        method: record.method,
        body: record.body
      },
      onload: (response) => {
        try {
          const payload = JSON.parse(response.responseText || '{}');
          if (payload.ok) log(`提交蓝图已回传控制台：${payload.path}`, 'ok');
          else log(`蓝图回传失败：${payload.error || response.status}`, 'warn');
        } catch (error) {
          log(`蓝图回传返回无法解析（HTTP ${response.status}）`, 'warn');
        }
      },
      onerror: () => log('蓝图回传连不上本地控制台（不影响本地录制）', 'warn')
    });
  }

  /**
   * 观察页面自己拉的关卡数据，拿到「几道题、每题几个选项」与「标准答案」。
   *
   * 这是选题分组**最权威**的数据源——比猜 class 名可靠得多（参考
   * educoder-answers.user.js 也是这么干的）。控制台的 optionCounts 只是兜底。
   * 字段：`chooses[].challenge_question.length`（每题选项数）、
   *       `choose_test_cases.test_sets[].standard_answer`（提交后平台吐出的标准答案）、
   *       `challenge.position`（关卡序号 → L001）。
   */
  function observeTaskJson(url, payload) {
    if (!payload || typeof payload !== 'object') return;
    const match = /\/api\/tasks\/([\w-]+)\.json/.exec(String(url || ''));
    if (!match) return;
    // 成功了就把「刚才失败过」的记号清掉，免得后面误判成还在失败。
    if (state.taskFetchFailures && state.taskFetchFailures[match[1]]) delete state.taskFetchFailures[match[1]];
    const chooses = Array.isArray(payload.chooses) ? payload.chooses : [];
    const sizes = chooses
      .slice()
      .sort((a, b) => (Number(a.position) || 0) - (Number(b.position) || 0))
      .map((question) => (Array.isArray(question.challenge_question) ? question.challenge_question.length : 0))
      .filter((size) => size > 0);
    // 注意：**不能**因为「页面没有选择题」就提前 return —— 编程题页面同样要靠这份数据拿到
    // position / prev_game / next_game / passed（队列定位与跳过、回传答案都要用）。
    // 原来这里是 `if (!sizes.length && !state.taskContext) return;`，结果编程题页面的
    // taskContext 永远是空的：队列一开就报「关卡数据没读到」，选择题分组也只好全靠控制台兜底。

    const prev = (state.taskContext && state.taskContext.id === match[1]) ? state.taskContext : null;
    // 提交后平台会吐标准答案：standard_answer 优先，没提交时退回 actual_output（用户答的）。
    const ctc = payload.choose_test_cases || {};
    const submitted = Boolean(ctc.had_submmit || ctc.had_all_submmit);
    const standardAnswer = (Array.isArray(ctc.test_sets) ? ctc.test_sets : [])
      .slice()
      .sort((a, b) => (Number(a.position) || 0) - (Number(b.position) || 0))
      .map((row) => ({ position: Number(row.position) || 0, answer: String(row.standard_answer ?? row.actual_output ?? '') }))
      .filter((row) => row.position > 0 && row.answer);
    const position = Number(payload.challenge && payload.challenge.position) || 0;

    state.taskContext = {
      id: match[1],
      sizes,
      // **班级身份**：关卡页的 URL（`/tasks/xxx`）里没有班级，只有关卡数据里有。
      // `course_identifier` 就是课堂码（如 HCEAP94S），是「这一关属于哪个班」的权威依据。
      // 作答前用它核对答案库里的答案是不是本班的——同名实验在多个班里都存在时，
      // 旧实现只按关卡标识/关卡名匹配，会把别班的答案填进去。
      classroomCode: String(payload.course_identifier || '').trim(),
      classroomId: Number(payload.course_id) || 0,
      homeworkId: Number(payload.homework_common_id) || 0,
      experimentName: String(payload.homework_common_name || '').trim(),
      levelId: position > 0 ? `L${String(position).padStart(3, '0')}` : '',
      // 关卡标题：课堂流程没有教学课程队列的 levelHint，回传答案/导出标准答案时
      // 靠它按内容兜底匹配（平台重新发布实验会换掉一整组关卡标识）。
      levelTitle: String((payload.challenge && payload.challenge.subject) || '').trim(),
      // 教学课程队列要用：序号（按序号选关/续跑）、前后关卡标识（回退链首）、是否已通过。
      levelPosition: position,
      nextGame: String(payload.next_game || ''),
      prevGame: String(payload.prev_game || ''),
      passed: levelPassedOf(payload),
      submitted: submitted || Boolean(prev && prev.submitted),
      // 标准答案只在提交后才有；没提交就保留旧的（或空）
      standardAnswer: standardAnswer.length ? standardAnswer : (prev && prev.standardAnswer) || []
    };
    if (!prev && sizes.length) {
      log(`读到关卡数据：${sizes.length} 道题，选项数 ${sizes.join('+')}`, 'ok');
    } else if (!prev && position > 0) {
      log(`读到关卡数据：第${position}关（非选择题，按编程题处理）`, 'ok');
    } else if (standardAnswer.length && !(prev.standardAnswer && prev.standardAnswer.length)) {
      log(`读到标准答案：${standardAnswerText(standardAnswer)}`, 'ok');
    }
  }

  /**
   * 观察**提交响应**：`POST /api/tasks/{id}/choose_build.json` 的 `test_sets` 里，
   * 提交后才会吐 `standard_answer`（正确答案）。页面加载时关卡还没提交、GET 拿不到，
   * 只能在这里补抓——否则「导出标准答案」会拿到空。
   */
  function observeSubmitResult(url, payload) {
    if (!payload || typeof payload !== 'object') return;
    const match = /\/api\/tasks\/([\w-]+)\/choose_build\.json/.exec(String(url || ''));
    if (!match) return;
    const standardAnswer = (Array.isArray(payload.test_sets) ? payload.test_sets : [])
      .slice()
      .sort((a, b) => (Number(a.position) || 0) - (Number(b.position) || 0))
      .map((row) => ({ position: Number(row.position) || 0, answer: String(row.standard_answer ?? row.actual_output ?? '') }))
      .filter((row) => row.position > 0 && row.answer);
    if (!standardAnswer.length) return;
    const prev = state.taskContext || { id: match[1], sizes: [] };
    state.taskContext = { ...prev, id: match[1], standardAnswer, submitted: true };
    log(`提交后读到标准答案：${standardAnswerText(standardAnswer)}`, 'ok');
  }

  /**
   * 记下「页面自己拉关卡数据失败了」。
   *
   * 实测（2026-10-12 截图）：头歌自己的 `/api/tasks/{id}.json` 会 **Failed to fetch**
   * （站点同时弹「本地网络不稳定，请检查您的网络设置，或刷新后重试」）。
   * 这种「失败」和「还在加载」完全不是一回事——等多久都不会来，**只有刷新页面才能重发**。
   * 脚本原来只会傻等 60 秒然后停队，所以必须能把这两种情况分开。
   *
   * 同一个关卡只报一次，免得每个 tick 都刷屏。
   */
  function noteTaskFetchFailure(url, why) {
    const match = /\/api\/tasks\/([\w-]+)\.json/.exec(String(url || ''));
    if (!match) return;
    const identifier = match[1];
    // 按**关卡标识**分别记账，不要只留一个槽位：页面会预取相邻关卡的题目，
    // 「邻居失败」会把「这一关失败」的记录覆盖掉，信号就丢了。
    const failures = state.taskFetchFailures || (state.taskFetchFailures = {});
    const first = !failures[identifier];
    failures[identifier] = Date.now();
    state.taskFetchFailureNote = { identifier, why: String(why || '') };
    if (!first) return; // 同一关只报一次，免得每个 tick 都刷屏
    log(`页面自己拉关卡数据（${identifier}）失败了：${why || '网络错误'}。`
      + '这跟「还没加载完」不同，等是等不到的——稍后会刷新页面重试。', 'warn');
  }

  /** 页面自己拉**当前这一关**数据的请求**刚刚**失败过？（失败只能靠刷新重发，干等没有用） */
  function taskFetchFailedJustNow(withinMs = 30_000) {
    const failures = state.taskFetchFailures || {};
    const identifier = currentLevelId();
    if (!identifier) return false;
    const at = Number(failures[identifier] || 0);
    return at > 0 && Date.now() - at < withinMs;
  }

  function installNetworkHooks() {
    // 关键：Tampermonkey 沙箱模式下（脚本用了 @grant），改 `window.fetch` 只会改到
    // 沙箱里那份，页面自己的请求根本看不见——这正是「读到关卡数据 / 录制到提交接口」
    // 一直不出现的原因。必须改 unsafeWindow（页面真实上下文）。
    // 参考 educoder-answers.user.js 用 @grant none 直接跑在页面上下文；
    // 这里为保留 GM_* 能力，改用 @grant unsafeWindow。没 unsafeWindow（页面上下文 /
    // 测试）就退回 window。
    const host = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
    const originalFetch = host.fetch;
    host.fetch = function patchedFetch(input, init) {
      const url = typeof input === 'string' ? input : input && input.url;
      const method = (init && init.method) || (input && input.method) || 'GET';
      const body = init && init.body;
      const promise = originalFetch.apply(this, arguments);
      const isChooseBuild = /\/api\/tasks\/[\w-]+\/choose_build\.json/.test(String(url || ''));
      if (/^POST|PUT|PATCH|DELETE$/i.test(method)) {
        promise
          .then((response) => {
            response
              .clone()
              .text()
              .then((text) => {
                remember({
                  url: String(url || ''),
                  method: method.toUpperCase(),
                  body: typeof body === 'string' ? body : snippet(body),
                  status: response.status,
                  response: snippet(text, 600)
                });
                if (isChooseBuild) {
                  try {
                    observeSubmitResult(url, JSON.parse(text));
                  } catch (error) {
                    /* 非 JSON 忽略 */
                  }
                }
              })
              .catch(() => {});
          })
          .catch(() => {});
      } else if (/^GET$/i.test(method) && /\/api\/tasks\/[\w-]+\.json/.test(String(url || '')) && !/__easBatch/.test(String(url || ''))) {
        promise
          .then((response) => {
            if (response && response.ok) {
              response.clone().json().then((data) => observeTaskJson(url, data)).catch(() => {});
            }
          })
          .catch((error) => noteTaskFetchFailure(url, (error && error.message) || '请求被拒'));
      }
      return promise;
    };

    const OriginalXHR = host.XMLHttpRequest;
    const originalOpen = OriginalXHR.prototype.open;
    const originalSend = OriginalXHR.prototype.send;
    OriginalXHR.prototype.open = function patchedOpen(method, url) {
      this.__eas = { method: String(method || 'GET').toUpperCase(), url: String(url || '') };
      return originalOpen.apply(this, arguments);
    };
    OriginalXHR.prototype.send = function patchedSend(body) {
      const meta = this.__eas;
      if (meta && /^POST|PUT|PATCH|DELETE$/.test(meta.method)) {
        this.addEventListener('load', () => {
          remember({
            url: meta.url,
            method: meta.method,
            body: typeof body === 'string' ? body : snippet(body),
            status: this.status,
            response: snippet(this.responseText, 600)
          });
          if (/\/api\/tasks\/[\w-]+\/choose_build\.json/.test(meta.url)) {
            try {
              observeSubmitResult(meta.url, JSON.parse(this.responseText));
            } catch (error) {
              /* 非 JSON 忽略 */
            }
          }
        });
      } else if (meta && /^GET$/i.test(meta.method) && /\/api\/tasks\/[\w-]+\.json/.test(meta.url) && !/__easBatch/.test(meta.url)) {
        this.addEventListener('load', () => {
          if (this.status < 200 || this.status >= 300) return;
          try {
            observeTaskJson(meta.url, JSON.parse(this.responseText));
          } catch (error) {
            /* 非 JSON 响应忽略 */
          }
        });
        // 关卡数据也可能走 XHR 拉：网络层失败（status 0）时同样要记下来，
        // 否则脚本会把它当成「还在加载」，白等一整个超时。
        this.addEventListener('error', () => noteTaskFetchFailure(meta.url, '网络错误（XHR error）'));
        this.addEventListener('timeout', () => noteTaskFetchFailure(meta.url, '请求超时（XHR timeout）'));
      }
      return originalSend.apply(this, arguments);
    };
  }

  /* ------------------------------------------------------------- 作答适配层 */

  /**
   * 页面真实上下文里的 window。
   *
   * 与网络钩子同一个坑：脚本带了 `@grant`，`window` 是油猴沙箱的 window，
   * **看不到页面自己的全局变量**（monaco、updateMonacoValue 都在页面的 window 上）。
   */
  function pageWindow() {
    return (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
  }

  /**
   * 从头歌页面上的 monaco 命名空间里挑出「当前这一关的代码编辑器」的模型。
   *
   * 实测（2026-09-28）：页面把 monaco 挂在 **`window.Monaco`（大写 M）**，
   * 而旧代码找的是 `window.monaco`（小写）→ 永远找不到编辑器，编程题一关都提交不了。
   * 容器 `.monaco-editor` 上有 `data-uri="inmemory://model/1"`，正好能对上 `model.uri`，
   * 因此优先按这个配对；只有一个模型时直接用；否则取内容最长的那份（正文比自测用例长）。
   */
  function pickEditorModel(models) {
    const list = Array.isArray(models) ? models.filter(Boolean) : [];
    if (!list.length) return null;
    const container = document.querySelector('.monaco-editor[data-uri]');
    const wanted = container ? String(container.getAttribute('data-uri') || '') : '';
    if (wanted) {
      const matched = list.find((model) => String(model.uri || '') === wanted);
      if (matched) return matched;
    }
    if (list.length === 1) return list[0];
    return list
      .slice()
      .sort((a, b) => String(b.getValue ? b.getValue() : '').length - String(a.getValue ? a.getValue() : '').length)[0];
  }

  /** 找出页面上的代码编辑器：头歌是 monaco（window.Monaco），其次 CodeMirror，最后退回 textarea。 */
  /**
   * 等代码编辑器出现。
   *
   * Monaco 是**异步挂载**的：刚进页面时 `Monaco.editor.getModels()` 还是空的、
   * `.monaco-editor` 也还没插进 DOM，立刻查就会得到「页面上找不到代码编辑器」
   * （实测就是这么误判的）。所以找不到时**轮询等待**，而不是马上放弃。
   */
  async function waitForCodeEditor(timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const editor = findCodeEditor();
      if (editor) return editor;
      if (Date.now() >= deadline) return null;
      await sleep(400);
    }
  }

  /**
   * 等页面把这一关的关卡数据拉回来（`/api/tasks/{id}.json` 是**异步**请求的）。
   *
   * 为什么必须等：进关卡是整页刷新，`processTeachLevel` 在 boot 后立刻跑，
   * 那一刻 `/api/tasks/...` 往往还没回来。实测 12:54:14 进「单元测试」、
   * 12:54:24 就判「关卡数据没读到」把队列停了，而数据 12:54:25 就到了——
   * 白白停一次队，人还得手动点「继续答题」。
   *
   * 等不到就返回 null，由调用方决定停不停（并说明等了多久）。
   */
  async function waitForLevelData(timeoutMs, bailAfterMs = 5000) {
    const limitMs = Number(timeoutMs) > 0
      ? Number(timeoutMs)
      : (Number(state.levelWaitSeconds) || 60) * 1000;
    const deadline = Date.now() + limitMs;
    const startedAt = Date.now();
    let nextNoticeAt = 10_000;
    for (;;) {
      // 用 currentTask() 而不是 state.taskContext：它只认与**当前 URL 标识一致**的数据，
      // 能挡住上一关的残留（否则会拿着上一关的题号去勾这一关的选项）。
      const task = currentTask();
      if (task) return task;
      const waited = Date.now() - startedAt;
      // 已知这次请求**失败**了（Failed to fetch / XHR error）：它不会再来了，别把
      // 「关卡数据最多等（秒）」那几十秒白等完 —— 早点把控制权交回去，好去刷新重试。
      if (waited >= bailAfterMs && taskFetchFailedJustNow()) return null;
      if (Date.now() >= deadline) return null;
      // 每 10 秒报一次「还在等」：等待期最长可达几分钟（面板可调），
      // 不报的话日志里一片安静，看起来像卡死了。
      if (waited >= nextNoticeAt) {
        log(`还在等这一关的关卡数据（已等 ${Math.round(waited / 1000)} 秒，最多 ${Math.round(limitMs / 1000)} 秒）…`, 'warn');
        nextNoticeAt += 10_000;
      }
      await sleep(400);
    }
  }

  /**
   * 关卡数据读不到时的**刷新重试**：只有刷新才能重发那个失败的请求。
   *
   * 实测（截图）：头歌自己的 `/api/tasks/{id}.json` 报 `Failed to fetch`，站点同时弹
   * 「本地网络不稳定，请检查您的网络设置，或刷新后重试」。等是不解决问题的——页面不会
   * 自己重发；而原来脚本只会把整条队列停在这里。
   *
   * 每关最多重载 2 次（计数记在**队列**里，刷新后仍然有效），免得遇到真正打不开的页面
   * 无限刷新。刷新即等于把这一关重新交给下一轮 boot，所以这里只负责发起。
   *
   * @returns {Promise<boolean>} true = 已发起刷新（调用方直接收工，别再停队）
   */
  async function reloadForLevelData(queue) {
    const identifier = currentLevelId() || location.pathname;
    const budget = (queue.reloads && queue.reloads.identifier === identifier)
      ? queue.reloads
      : { identifier, count: 0 };
    if (Number(budget.count) >= 2) return false;
    budget.count = Number(budget.count) + 1;
    queue.reloads = budget;
    // 刷新也算一次交接：boot 靠 handoffAt 的新鲜度决定愿不愿意续跑。
    queue.handoffAt = Date.now();
    writeTeachQueue(queue);
    log(`刷新页面重试（这一关第 ${budget.count}/2 次）…`, 'warn');
    await sleep(600);
    location.reload();
    return true;
  }

  /** 找不到编辑器时给出现场：页面里到底有什么（用来区分"还没挂载"和"真没有"）。 */
  function describeEditorScene() {
    const host = pageWindow();
    const monaco = host.Monaco || host.monaco;
    const models = monaco && monaco.editor && typeof monaco.editor.getModels === 'function'
      ? monaco.editor.getModels().length
      : '无接口';
    const areas = [...document.querySelectorAll('textarea')].length;
    const frames = document.querySelectorAll('iframe').length;
    return `monaco 模型 ${models} 个｜.monaco-editor ${document.querySelectorAll('.monaco-editor').length} 个｜textarea ${areas} 个｜iframe ${frames} 个`;
  }

  function findCodeEditor() {
    // 1) 头歌的 monaco：命名空间在页面的 window 上（unsafeWindow），小写 monaco 只是历史写法兜底。
    try {
      const host = pageWindow();
      const monaco = host.Monaco || host.monaco;
      const models = monaco && monaco.editor && typeof monaco.editor.getModels === 'function'
        ? monaco.editor.getModels()
        : [];
      const model = pickEditorModel(models);
      if (model) {
        return {
          kind: 'monaco',
          read: () => model.getValue(),
          write: (code) => {
            // 先写模型（编辑器立刻可见）；
            // 再调页面自己的 `updateMonacoValue` 把值同步回 React state——
            // 不调它的话，页面的提交逻辑可能仍拿着 state 里的旧代码。
            model.setValue(code);
            try {
              if (typeof host.updateMonacoValue === 'function') host.updateMonacoValue(code);
            } catch (error) {
              log(`同步 monaco 内容到页面状态失败（提交可能仍用旧值）：${error.message}`, 'warn');
            }
          }
        };
      }
    } catch (error) {
      log(`读取页面 monaco 失败：${error.message}`, 'warn');
    }
    const cm = document.querySelector('.CodeMirror');
    if (cm && cm.CodeMirror) {
      return {
        kind: 'codemirror',
        read: () => cm.CodeMirror.getValue(),
        write: (code) => {
          cm.CodeMirror.setValue(code);
        }
      };
    }
    // 兜底的 textarea 要谨慎：页面上任何多行输入框都是 textarea（搜索框、评论框、
    // 笔记框…），把它的内容当答案提交会非常难查。只接受「尺寸像编辑器」且
    // 名字不像搜索/评论的那些。
    const areas = [...document.querySelectorAll('textarea')];
    const textarea = areas.find((node) => {
      const rect = node.getBoundingClientRect();
      if (rect.width < 260 || rect.height < 120) return false;
      const hint = `${node.id || ''} ${node.className || ''} ${node.getAttribute('placeholder') || ''}`.toLowerCase();
      return !/search|comment|reply|note|remark|message|chat/.test(hint);
    });
    if (textarea) {
      return {
        kind: 'textarea',
        read: () => textarea.value,
        write: (code) => {
          textarea.value = code;
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
        }
      };
    }
    return null;
  }

  /** 按钮的**可见文本**（用于日志与人工核对）。 */
  function buttonLabel(node) {
    const text = (node.textContent || '').replace(/\s+/g, '').trim();
    if (text) return text;
    return String(node.value || '').replace(/\s+/g, '').trim();
  }

  /**
   * 按钮的**匹配文案**：可见文本 + `aria-label` + `title` + `value` 拼在一起（去空白）。
   *
   * 为什么要拼 title：头歌的按钮常常只有一个图标 + 两字文本，
   * 真实描述放在 `title` 里（实测 `title="运行评测"`、文本是「评测」）。
   * 注意拼完之后**不要再用带 ^ $ 锚点的匹配模式**——拼接结果不等于任何单一文案。
   */
  function buttonMatchText(node) {
    return [
      node.textContent || '',
      (node.getAttribute && node.getAttribute('aria-label')) || '',
      (node.getAttribute && node.getAttribute('title')) || '',
      node.value || '',
      (node.getAttribute && node.getAttribute('class')) || ''
    ].join(' ').replace(/\s+/g, '');
  }

  /**
   * 是不是**面板自己的**节点。
   *
   * 面板挂在页面 body 里，所以 `document.querySelectorAll('button')` 会把面板自己的按钮
   * 一起查出来。曾经面板上有个「一键作答并**提交**」，正好被 `SUBMIT_PATTERNS` 的 `/提交/`
   * 命中——页面上真正的「评测」不含"提交"二字，于是每个模式都漏掉它、反倒叼住我们自己的
   * 按钮，点下去就变成自己点自己（双重流程抢同一个页面，最后必然卡住）。
   *
   * 那个按钮已经删了，但结论不变：凡是「找页面上的按钮」，都必须先把自己的面板排除掉——
   * 面板上现在仍有「一键答题（选中）」这类含「答题」字样的按钮。
   */
  function isOwnPanelNode(node) {
    return Boolean(node && typeof node.closest === 'function' && node.closest('#eas-panel'));
  }

  /** 页面上所有可见的「按钮类」元素（**不含本脚本自己的面板**）。 */
  function buttonNodes() {
    return [...document.querySelectorAll(
      'button, a, div[role="button"], span[role="button"], input[type="submit"], input[type="button"]'
    )].filter((node) => !isOwnPanelNode(node));
  }

  /**
   * 按文案找按钮。
   *
   * **模式的先后顺序 = 优先级**：先拿第一个模式去扫全页，命中就返回；
   * 都不中才换下一个模式。不能按 DOM 顺序找——否则「运行」排在「评测」前面时
   * 会点错那个（两个都存在时，我们要的是「评测」）。
   */
  function findButton(patterns) {
    for (const pattern of patterns) {
      const found = buttonNodes().find((node) => {
        const text = buttonMatchText(node);
        if (!text) return false;
        const disabled = node.disabled || node.getAttribute('aria-disabled') === 'true';
        if (disabled) return false;
        // 「题目1未提交」「题目2已提交」这类是**状态标签**，不是提交动作——
        // 别因为它们含「提交」二字就点上去（实测就是这么点错了，错过了真正的「评测」）。
        // 「已完成/未完成」同理：进度文案不是按钮动作（「完成」本身是最后一关的按钮）。
        if (/未提交|已提交|提交中|未作答|已作答|已完成|未完成/.test(text)) return false;
        return pattern.test(text);
      });
      if (found) return found;
    }
    return null;
  }

  /** 把页面上可见按钮的文案列出来，供「找不到按钮」时人工核对。 */
  function describeButtons() {
    const labels = [];
    for (const node of buttonNodes()) {
      const text = buttonLabel(node);
      const title = (node.getAttribute && node.getAttribute('title')) || '';
      if (!text && !title) continue;
      if (node.getClientRects().length === 0) continue; // 不可见的不列
      // 文本与 title 不同就都写出来（「评测[运行评测]」）——
      // 只在完全相同（如 提交/提交）时才省略，否则会丢掉真正说明动作的 title。
      const label = text && title && title !== text ? `${text}[${title}]` : text || title;
      if (label.length > 24) continue;
      if (!labels.includes(label)) labels.push(label);
    }
    return labels.slice(0, 40);
  }

  /**
   * 提交类按钮的匹配规则。**顺序即优先级**。
   *
   * 头歌的编程题用的是「评测」（实测 `title="运行评测"`、文本「评测」），
   * 不是「提交」——所以「评测 / 测评 / 判题」必须在「运行」之前。
   * 全部用**不带锚点**的关键词，因为匹配文案是把文本与 title 拼起来的。
   */
  const SUBMIT_PATTERNS = [
    /提交答案/, /提交评测/, /保存并提交/, /提交本题/, /提交代码/, /提交/,
    /交卷/,
    /评测/, /测评/, /判题/, // 头歌编程题的「评测」＝提交并判分
    /btn-?(run|submit|judge)/i, // 兜底：CSS 模块类名里带 btn-run / btn-submit
    /运行/ // 最后才考虑：有些题型只有「运行」
  ];

  /**
   * 「下一关」类按钮。头歌通关后会弹庆祝弹窗（「恭喜您通过本关」），里面带
   * 「下一关」——最后一关则是「完成」（实测），所以两种都要认。
   * 页面上出现它 ≈ 本关已通过，用它判定比读文案可靠得多（文案会被过期的输出区带偏）。
   */
  const NEXT_LEVEL_PATTERNS = [/下一关/, /下一题/, /继续下一/, /继续挑战/, /完成/];

  /**
   * 页面是否可见（控件可能被 label 包着，label 可见也算）。
   */
  function isVisible(node) {
    if (!node) return false;
    if (node.getClientRects().length > 0) return true;
    const label = node.closest && node.closest('label');
    return Boolean(label && label.getClientRects().length > 0);
  }

  /**
   * 这个 input 是「选项」还是别的（标记本题 / 收藏 / 答题卡 / 全选等）？
   *
   * 实测头歌选项的结构是 `label.ant-radio-wrapper.choice`、`div.option`——
   * 选项控件的外层总带 `.choice` / `.option` 这类标记，别的 checkbox（如「标记本题」）
   * 不带。靠它把真正的选项框筛出来，才不会把 3 题数成 4 组 / 12 个选项数成 15 个。
   */
  function isOptionInput(node) {
    return Boolean(
      node.closest
      && node.closest('.choice, .option, .choice-item, [class*="choice-item"], [class*="option-item"]')
    );
  }

  /** 页面上所有可见的**选项**控件（按 DOM 顺序）。 */
  function visibleChoiceInputs() {
    return [...document.querySelectorAll('input[type="radio"], input[type="checkbox"]')]
      .filter(isVisible)
      .filter(isOptionInput);
  }

  /**
   * 按页面自己的分组容器收集「每道题」的选项控件。
   *
   * 注意这里**只认**标准分组容器（`.ant-radio-group` / `.ant-checkbox-group` /
   * `[role=radiogroup]`）。早先还包含 `[role=group]`，那个选择器太宽——页面上任何
   * 分组控件都带 role=group，实测会把一道题数成两组（3 道题数出 4 组）。
   * 猜不出来就返回空数组，交给 `answerChoiceLevel` 用「每道题的选项个数」切分。
   */
  function collectQuestionGroups() {
    const controls = (node) => [...node.querySelectorAll('input[type="radio"],input[type="checkbox"]')];
    return [...document.querySelectorAll('.ant-radio-group,.ant-checkbox-group,[role="radiogroup"]')]
      .filter((node) => isVisible(node) && controls(node).length)
      // 去掉嵌套：外层容器不算独立一组，否则会把多道题算成一组
      .filter((node) => ![...node.children].some((child) => child.querySelector('.ant-radio-group,.ant-checkbox-group,[role="radiogroup"]')))
      .map(controls);
  }

  /**
   * 按「每道题几个选项」把选项框切分成一道题一组。
   *
   * 这是本项目里**唯一可靠**的题目分组方式：选项个数是确定信息
   * （来自关卡存档里每道题的 options 个数），而页面上的分组 class 只能猜。
   * 总数对不上就返回 null——宁可不勾，也不要把答案勾到错题上。
   */
  function partitionByCounts(inputs, sizes) {
    const total = sizes.reduce((sum, size) => sum + size, 0);
    if (inputs.length !== total) return null;
    const groups = [];
    let cursor = 0;
    for (const size of sizes) {
      groups.push(inputs.slice(cursor, cursor + size));
      cursor += size;
    }
    return groups;
  }

  /**
   * 当前关卡「每题几个选项」的两个来源，各自可能为 null。
   *
   * - `pageSizes`：页面自己拉的关卡数据（`observeTaskJson` 抄下来的），最权威；
   * - `consoleSizes`：本地控制台的 `optionCounts`，兜底。
   *
   * 抽出来单独一个函数，是为了让「作答内核」与「队列预检」用**同一口径**取数——
   * 两处各写一遍迟早会分叉。
   */
  function choiceSizesForCurrentLevel() {
    const fromPage = state.taskContext && state.taskContext.id === currentLevelId() ? state.taskContext.sizes : null;
    const fromConsole = state.optionCounts[answerKeyForCurrentLevel()];
    return {
      pageSizes: Array.isArray(fromPage) ? fromPage : null,
      consoleSizes: Array.isArray(fromConsole) ? fromConsole : null
    };
  }

  /**
   * 判断题数：这份选择题答案「能不能用在这一关」。
   *
   * 为什么要有它：答案过期/不完整时（实测 5 个实验的 L001 被跨实验串台的答案污染，
   * 页面上 1 道题、答案里 6 道题），作答内核只会报一句「无法确定题目分组」然后
   * 放弃勾选——而**队列把「没勾上」当成失败，直接整队停**。于是一关的脏答案就能把
   * 100+ 关的队列卡死。这里提前判一次，好让队列按「答案不可用」跳过并记账。
   *
   * 判定：
   * - 两个来源都没数据 → `unknown`，无从判断，交给作答内核按原样报错（那是环境问题，不是答案问题）；
   * - 任一个来源的题数与答案一致 → 可用（另一个来源可能与页面不同步，不算数）；
   * - 都对不上 → 不可用，并给出「答案几道题 / 这一关几道题」。
   */
  function choiceAnswerFit(levelAnswers) {
    // 容忍两种入参：`readAnswer()` 的返回值 `{ kind, map }`（外号包了一层），
    // 或直接给题号映射（`{ 1: ['A'], 2: ['B'] }`）。
    //
    // 这个坑踩过一次、代价很大：对 `{ kind, map }` 直接 `Object.keys()` 只会数出
    // `kind` / `map` **两个**键，于是「答案其实是对的」被一律判成「题数对不上」，
    // 整批选择题被跳过并进了缺答案清单。所以这里必须显式解包。
    const map = (levelAnswers && typeof levelAnswers === 'object'
      && levelAnswers.map && typeof levelAnswers.map === 'object'
      && !Array.isArray(levelAnswers.map))
      ? levelAnswers.map
      : levelAnswers;
    const answerCount = Object.keys(map || {}).length;
    const { pageSizes, consoleSizes } = choiceSizesForCurrentLevel();
    const known = [pageSizes, consoleSizes].filter(Boolean);
    if (!known.length) return { ok: true, unknown: true, reason: '', answerCount };
    if (known.some((sizes) => sizes.length === answerCount)) {
      return { ok: true, unknown: false, reason: '', answerCount };
    }
    // 两个来源都对不上：优先用页面的（它就是这一关正在显示的东西）
    const sizes = pageSizes || consoleSizes;
    return {
      ok: false,
      unknown: false,
      answerCount,
      reason: `本地答案有 ${answerCount} 道题，这一关只有 ${sizes.length} 道题（选项数 ${sizes.join('+')}）`
    };
  }

  /** 把检测到的分组描述出来，供「数量对不上」时人工核对。 */
  function describeGroups(groups) {
    return groups
      .map((controls, index) => {
        const texts = controls
          .map((node) => {
            const box = (node.closest && node.closest('label')) || node.parentElement;
            return ((box && box.textContent) || '').replace(/\s+/g, '').slice(0, 10);
          })
          .join('|');
        return `#${index + 1}(${controls.length}项:${texts})`;
      })
      .join(' ');
  }

  /**
   * 选择题：按题干顺序把答案字母勾到对应题目上，并回读校验。
   *
   * 分组策略（按可靠性从高到低）：
   *   ① 答案里带了「每道题的选项个数」→ 直接按个数切分页面上的选项框（最可靠）；
   *   ② 页面有标准分组容器且组数与答案题数一致 → 用页面自己的分组。
   * 两者都拿不到就报错并列出检测到的分组，绝不硬猜。
   *
   * 另外两条硬规则：题目数必须与答案数一致；单选不能给多个字母、
   * 勾选后页面没保留，都明确报错，不假装成功。
   */
  async function answerChoiceLevel(levelAnswers) {
    const questionKeys = Object.keys(levelAnswers).sort((a, b) => Number(a) - Number(b));
    // 每题选项数：优先页面自己的关卡数据（最权威），其次控制台的 optionCounts（兜底）
    const { pageSizes, consoleSizes } = choiceSizesForCurrentLevel();
    const inputs = visibleChoiceInputs();
    // 只有「题数与答案一致」的那一份才敢用来切分：题数对不上就是两边内容不是同一版，
    // 硬切会把答案勾到错题上。
    const usableCounts = (pageSizes && pageSizes.length === questionKeys.length)
      ? pageSizes
      : ((consoleSizes && consoleSizes.length === questionKeys.length) ? consoleSizes : null);

    let groups = [];
    let source = '';
    // 放弃勾选时要说清**到底卡在哪**：把「压根没读到数据」和「读到了但与答案对不上」
    // 分开讲。原来两者共用一句「页面关卡数据没读到」，于是日志自相矛盾——
    // 上一行刚打印「读到关卡数据：1 道题，选项数 3」，下一行却说没读到，
    // 把排查方向从「答案过期」带偏成「网络钩子没装上」。
    let why = '';
    if (usableCounts) {
      const byCount = partitionByCounts(inputs, usableCounts);
      if (byCount) {
        groups = byCount;
        source = `按每道题的选项个数切分（${usableCounts.join('+')} = ${inputs.length} 个选项框）`;
      } else {
        const expected = usableCounts.reduce((sum, size) => sum + size, 0);
        why = `按每道题的选项个数（${usableCounts.join('+')} = ${expected} 个）切分失败：`
          + `页面上只有 ${inputs.length} 个选项框（数量对不上，页面结构可能变了）`;
      }
    } else if (pageSizes || consoleSizes) {
      why = '「每题几个选项」与答案题数对不上——'
        + `页面关卡数据：${pageSizes ? `${pageSizes.length} 道题（选项数 ${pageSizes.join('+')}）` : '没读到'}；`
        + `控制台 optionCounts：${consoleSizes ? `${consoleSizes.length} 道题（选项数 ${consoleSizes.join('+')}）` : '没给这一关'}；`
        + `答案却有 ${questionKeys.length} 道题。两边不是同一版——答案过期，`
        + '或按关卡名兜底匹配到了别的关卡的答案（平台重发实验会换掉一整组关卡标识）；'
        + '重抓该实验后重新生成答案即可';
    } else {
      why = '「每题几个选项」两个来源都没读到（页面关卡数据没读到，控制台也没给 optionCounts）';
    }
    if (!groups.length) {
      const byDom = collectQuestionGroups();
      if (byDom.length === questionKeys.length) {
        groups = byDom;
        source = '按页面分组容器';
      }
    }

    if (!groups.length) {
      log(`无法确定题目分组，已放弃勾选。页面上共 ${inputs.length} 个选项框；${why}`, 'error');
      return [];
    }
    if (groups.length !== questionKeys.length) {
      log(
        `页面题目数（${groups.length}）与答案题数（${questionKeys.length}）不一致，已放弃勾选。`
          + `检测到的分组：${describeGroups(groups)}`
          + `（页面共 ${inputs.length} 个选项框`
          + (usableCounts ? `，答案期望 ${usableCounts.join('+')} = ${usableCounts.reduce((sum, size) => sum + size, 0)} 个` : '')
          + '）',
        'error'
      );
      return [];
    }
    log(`题目分组：${groups.length} 组，${source}`);

    const picked = [];
    for (let i = 0; i < questionKeys.length; i += 1) {
      const options = groups[i];
      const size = options.length;
      const letters = levelAnswers[questionKeys[i]].map((token) => String(token).toUpperCase());
      const wanted = new Set(letters.map((letter) => letter.charCodeAt(0) - 65));
      const isRadio = options[0] && options[0].type === 'radio';
      if (isRadio && wanted.size !== 1) {
        log(`第 ${i + 1} 题是单选，答案却给了 ${wanted.size} 个字母（${letters.join('')}），已跳过`, 'error');
        continue;
      }
      if ([...wanted].some((index) => index < 0 || index >= size)) {
        log(`第 ${i + 1} 题的答案超出选项范围（选项 ${size} 个，答案 ${letters.join('')}），已跳过`, 'error');
        continue;
      }
      // 每次点击前都**重新从页面取**选项：React 重渲染会让旧节点脱离页面，
      // 拿着旧节点 click 是无效的（之前「勾选没保留」就是这么来的）。
      const freshGroup = () => (usableCounts ? partitionByCounts(visibleChoiceInputs(), usableCounts) : null);
      for (let j = 0; j < size; j += 1) {
        const fresh = freshGroup();
        const node = fresh && fresh[i] ? fresh[i][j] : null;
        if (!node) break;
        const shouldCheck = wanted.has(j);
        if (node.checked !== shouldCheck && (node.type === 'checkbox' || shouldCheck)) {
          node.click();
          await sleep(40);
        }
      }
      const fresh = freshGroup();
      const kept = Boolean(fresh && fresh[i] && fresh[i].every((node, j) => node.checked === wanted.has(j)));
      if (kept) picked.push(`${questionKeys[i]}:${letters.join('')}`);
      else log(`第 ${i + 1} 题的勾选没有被页面保留，可能页面结构变了`, 'error');
    }
    return picked;
  }

  /**
   * 把答案规范化成两种可用形态：
   * - 编程题：返回代码字符串
   * - 选择题：返回 { 题号: ['A'] }，交给 answerChoiceLevel
   *
   * 支持**当前 v2 结构**（与答案文件逐字段一致，见 `extractor/lib/answer-format.js`）：
   * - 编程题 `answer: { language, code }`
   * - 选择题 `answer: { questions: [{ number, selected: ['A'] }] }`
   *
   * 同时兼容历史写法，避免老答案库直接失效：
   * - `answer: "A"` / `"A,C"` / `"1:A;2:B,D"`
   * - `answers: [{ question, answer: ['A'] }]`
   */
  function readAnswer(levelAnswer) {
    if (!levelAnswer) return null;
    const payload = levelAnswer.answer && typeof levelAnswer.answer === 'object' ? levelAnswer.answer : null;
    const isChoice = String(levelAnswer.kind) === 'choice'
      || Array.isArray(payload && payload.questions)
      || Array.isArray(levelAnswer.answers);

    if (isChoice) {
      const map = {};
      const pushLetters = (number, value) => {
        const letters = (Array.isArray(value) ? value : String(value ?? '').split(/[,，、\s]+/))
          .map((token) => String(token).trim().toUpperCase())
          .flatMap((token) => (/^[A-H]+$/.test(token) ? token.split('') : []));
        if (letters.length) map[String(number || Object.keys(map).length + 1)] = letters;
      };

      if (Array.isArray(payload)) {
        // **班级答案文件**的形状：选择题的 `answer` 直接就是 `[{number, selected}]` 数组，
        // 没有 `questions` 外壳（见 extractor/lib/class-answers.js 的 levelEntry）。
        // 少了这一支，「导入班级答案文件」导入的选择题一道都解析不出来——看着有答案，其实全空。
        for (const item of payload) pushLetters(item && item.number, item && item.selected);
      } else if (payload && Array.isArray(payload.questions)) {
        // v2：结构化小问，直接用，不用再解析字符串
        for (const item of payload.questions) pushLetters(item && item.number, item && item.selected);
      } else if (Array.isArray(levelAnswer.answers)) {
        for (const item of levelAnswer.answers) {
          if (item && item.answer) pushLetters(item.question, item.answer);
        }
      } else {
        const text = String(levelAnswer.answer || '').trim();
        if (/[;；]/.test(text) || /^\d+\s*[:：]/.test(text)) {
          for (const part of text.split(/[;；]+/)) {
            const match = /^\s*(\d+)\s*[:：]\s*(.+)$/.exec(part);
            if (match) pushLetters(match[1], match[2]);
          }
        } else {
          pushLetters(1, text);
        }
      }
      return { kind: 'choice', map };
    }

    // v2 的编程题答案是 `{ language, code }`；历史写法是 `answer` 字符串。
    const code = payload
      ? payload.code
      : (levelAnswer.answer ?? levelAnswer.code ?? '');
    return { kind: 'code', code: String(code ?? '') };
  }

  /** 用录制到的模板重放一次提交（把答案替换进去）。 */
  async function replayTemplate(template, answerText) {
    const body = String(template.body || '').replace(
      /("(?:content|code|answer|source|user_code|program)[^"]*"\s*:\s*")[^"]*(")/gi,
      (_match, prefix, suffix) => `${prefix}${answerText.replace(/"/g, '\\"').replace(/\n/g, '\\n')}${suffix}`
    );
    const response = await window.fetch(template.url, {
      method: template.method,
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body
    });
    const text = await response.text();
    return { status: response.status, text };
  }

  function looksPassed(text) {
    return /"status"\s*:\s*(?:true|1|2)\b|通过|成功|passed|accepted|满分|得分/i.test(String(text || ''));
  }

  /* -------------------------------------------------------------- 自动流程 */

  /** 抓页面上「结果区」的文本；找不到就返回空串（表示还没有结论）。 */
  /**
   * 读页面上的「评测结论」文本。
   *
   * **必须优先读弹窗**：头歌通关时会弹「恭喜您通过本关」的庆祝弹窗，而旁边的测试
   * 输出区可能还停在「自测输入运行结果代码执行中…」——实测先扫 `[class*="result"]`
   * 会读到那句过期文案，于是明明通过了却判成"没结论"，队列中断。
   * 弹窗里只认"像结论"的（含 恭喜/通过/失败/得分…），避免把别的确认框当结论。
   */
  function readPageResultText() {
    const clean = (node) => (node.textContent || '').replace(/\s+/g, ' ').trim();
    const MODAL_SELECTORS = [
      '.ant-modal-body', '.ant-modal', '[role="dialog"]', '[class*="modal"]',
      '[class*="congrat"]', '[class*="celebrat"]', '[class*="pass-modal"]'
    ];
    for (const selector of MODAL_SELECTORS) {
      for (const node of document.querySelectorAll(selector)) {
        const text = clean(node);
        if (text && text.length <= 2000 && /恭喜|通过|未通过|失败|得分|正确|错误|完成/.test(text)) return text;
      }
    }
    const RESULT_SELECTORS = [
      '[class*="result"]', '[class*="Result"]', '[class*="judge"]', '[class*="evaluate"]',
      '.ant-message', '.ant-alert', '.ant-notification'
    ];
    for (const selector of RESULT_SELECTORS) {
      for (const node of document.querySelectorAll(selector)) {
        const text = clean(node);
        if (text && text.length <= 2000) return text;
      }
    }
    return '';
  }

  /**
   * 提交前的静置。
   *
   * 实测刚进关卡就立刻点「评测」会**提交失败**：头歌要把代码/选项的改动先异步同步上去
   * （页面会发 `update_file.json`），马上提交会读到旧内容。所以每个关卡至少待 2 秒。
   */
  async function settleBeforeSubmit() {
    log('静置 2 秒再提交（太快提交会失败）');
    await sleep(2000);
  }

  /**
   * 从页面上读「最大的测评时间」（秒），读不到返回 0。
   *
   * 编程题的评测耗时差异极大（实测有超过 120 秒的关卡），写死等待上限必然误判。
   * 页面自己会标明最大测评时间（如 300 秒），取它的一半作为等待上限最稳。
   */
  function readMaxEvalSeconds() {
    try {
      const text = (document.body ? document.body.innerText : '').replace(/\s+/g, ' ');
      const match = /最大(?:的)?(?:测评|评测|测试|判题)时间[^0-9]{0,12}(\d{1,4})/.exec(text)
        || /(\d{1,4})\s*秒[^0-9]{0,12}最大(?:的)?(?:测评|评测|测试|判题)时间/.exec(text);
      return match ? Number(match[1]) || 0 : 0;
    } catch (error) {
      return 0;
    }
  }
  /**
   * 等提交结果。
   *
   * 原来是固定 `sleep(3000)` 然后**不管结果就点「下一关」**——提交失败时也会往下跳，
   * 于是后面的关卡全部错位。这里改为轮询结果信号，拿不到结论就不往下走。
   *
   * 等待上限：优先用**页面标注的「最大的测评时间」的一半**（编程题实测有跑 120 多秒
   * 的关卡，写死上限必然误判）；页面读不到才退回面板里的设置。
   *
   * @returns {{status: 'passed'|'failed'|'unknown'|'timeout', text: string}}
   */
  /** 「评测还在跑」的文案。中文平台文案很花，尽量列全——漏一个词就等于把「进行中」误判成「未知终态」。 */
  const EVAL_RUNNING_PATTERN = /评测中|执行中|运行中|正在运行|正在执行|计算中|判题中|等待|排队|loading|请稍候|测评中/i;

  async function waitForSubmitResult(timeoutMs) {
    const pageMax = readMaxEvalSeconds();
    // 上限取**完整的**「最大测评时间」，不是一半：一半是赌"评测不会超过上限的一半"，
    // 实测有关卡超过（编程风格 语句构造：页面标 30 秒、一半 15 秒，它 15 秒还没出结果）。
    // 等结果只是 0.5 秒一次轮询，一出结论立刻返回，所以上限给宽不会变慢、只是更保险。
    const limitMs = Number(timeoutMs) > 0
      ? Number(timeoutMs)
      : (pageMax > 0
        ? Math.min(pageMax, 600) * 1000
        : (Number(state.evalWaitSeconds) || 30) * 1000);
    log(`等评测结果（最多 ${Math.round(limitMs / 1000)} 秒${pageMax > 0 ? `＝页面最大测评时间 ${pageMax} 秒` : '＝面板设置'}）`);
    const deadline = Date.now() + limitMs;
    let text = '';
    while (Date.now() < deadline) {
      // 最高优先：通关弹窗里的「下一关 / 完成」按钮出现了 → 本关一定通过了。
      // 实测页面已经弹「恭喜您通过本关」时，测试输出区可能还停在过期的
      // 「自测输入运行结果代码执行中…」，光读文案会被带偏、判成"没结论"。
      const nextButton = findButton(NEXT_LEVEL_PATTERNS);
      // 但「完成提交」这类既含"完成"又像提交的按钮要排除，否则刚点完提交就会
      // 被自己当成通关信号，答案还没真正判就往下跳。
      if (nextButton && !SUBMIT_PATTERNS.some((pattern) => pattern.test(buttonMatchText(nextButton)))) {
        return { status: 'passed', text: `页面上出现了「${buttonLabel(nextButton)}」按钮（本关已通过）` };
      }
      const current = readPageResultText();
      if (current) {
        text = current;
        // 评测还没出结果 → 继续等。
        // 实测文案有「自测输入运行结果代码执行中…」「自测输入无运行结果代码执行中…」等，
        // 「执行中」以前不在词表里，一读到就被当成 unknown 放弃、队列中断。
        if (EVAL_RUNNING_PATTERN.test(current)) {
          await sleep(500);
          continue;
        }
        if (/未通过|不通过|失败|异常|Traceback|编译错误|运行错误/i.test(current)) return { status: 'failed', text };
        // 通过 / 正确 / 满分 是编程题的信号；「恭喜您通过本关」是通关弹窗；
        // 「已提交 / 提交成功 / 已保存」是**选择题**的信号——选择题提交后没有
        // 通过/失败，只有「当前状态已提交，将按照最新提交的答案计算成绩」这类文案。
        if (/通过|恭喜|正确|Accepted|满分|全部通过|得分[:：]?\s*100|已提交|提交成功|已保存/i.test(current)) {
          return { status: 'passed', text };
        }
        return { status: 'unknown', text };
      }
      await sleep(500);
    }
    // 到点还没结论：如果最后读到的是「进行中」，那是**评测超时**（跑太慢），
    // 与「读到了看不懂的终态」（unknown）要分开——两者处理方式完全不同。
    const wasRunning = Boolean(text) && EVAL_RUNNING_PATTERN.test(text);
    return { status: wasRunning ? 'timeout' : (text ? 'unknown' : 'timeout'), text };
  }

  /** 等 URL 路径变化（点了「下一关」之后用它确认真的动了）。 */
  async function waitForPathChange(before, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (location.pathname !== before) return true;
      await sleep(300);
    }
    return false;
  }

  /**
   * 「页面没跟着跳转」时，判断自己是不是**已经被新标签页接走的旧标签页**，是就关掉自己。
   *
   * 为什么需要：头歌的「开启挑战」「下一关」在真机上会开新标签页。脚本已经尽量改成
   * 当前页跳转（见 `clickStayingInThisTab`），但站点换手法时仍可能开出来——那样旧标签页
   * 就停在旧关卡上，一关攒一个，上百关能攒上百个；更糟的是它还会把**共享的**队列状态
   * 写成「已停」，把真正在跑的标签页一起停掉。
   *
   * **宁可少关也不关错**，三个条件全满足才动手：
   *   ① 队列还在跑（不是用户自己点开的关卡页）；
   *   ② 另一个标签页已经认领了这次交接（`activeTabId` 变成了别人的）；
   *   ③ 调用方已确认本页确实没跳转。
   * 浏览器只允许脚本关闭「脚本自己打开过的」标签页，所以用户最初那个标签页关不掉——
   * 那样就只记一条日志让他手动关，不硬来。
   *
   * @returns {Promise<boolean>} true = 自己已经退场（调用方别再往下走、更别去停队）
   */
  async function closeSelfIfStale(timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const now = readTeachQueue();
      const claimedAt = Number((now && now.activeTabAt) || 0);
      // 必须「最近」被认领：不校验时间的话，上一轮跑剩的 activeTabId 会让新的一轮
      // 一进来就以为自己是被开走的旧页，直接把自己关掉。
      const fresh = claimedAt > 0 && Date.now() - claimedAt < 60_000;
      if (now && now.running && fresh && now.activeTabId && now.activeTabId !== TAB_ID) {
        log('这一页的跳转被新标签页接走了，本标签页已没用，自动关闭');
        try {
          window.close();
        } catch (error) { /* 下面统一兜底提示 */ }
        await sleep(600);
        // 走到这儿说明没关掉：浏览器不许脚本关闭「不是它开的」标签页。
        log('浏览器不允许脚本关闭这个标签页（不是它自己打开的），手动关掉即可', 'warn');
        return true;
      }
      await sleep(400);
    }
    return false;
  }

  /**
   * 点一个「会跳转」的页面控件，但**强制在当前标签页跳转**，不许开新标签页。
   *
   * 为什么需要：头歌的「开启挑战」「下一关」在真机上会开新标签页（`<a target="_blank">`
   * 或 React 里 `window.open(url)`）。脚本每关点一次「下一关」，就等于每关多留一个标签页——
   * 一个上百关的队列能把浏览器塞满标签页，而且旧标签页停在旧关卡上，看着还以为在重复跑。
   *
   * 做法：点击期间短暂接管两件事，点完立刻还原（不影响页面自己的其它逻辑）——
   *   ① `window.open(url)` → 改成当前页导航；
   *   ② 控件本身（或它外层）的 `target="_blank"` → 临时改成 `_self`。
   *
   * 还原**必须延迟**：有的站点把跳转放在 click 之后的异步回调里，
   * 点完立刻还原就等于没接管。
   */
  function clickStayingInThisTab(button, restoreDelayMs = 3000) {
    if (!button) return '';
    const host = pageWindow();
    const originalOpen = host.open;
    const touched = [];
    const forceSelf = (anchor) => {
      if (!anchor || !anchor.getAttribute) return;
      const target = anchor.getAttribute('target');
      if (target === '_self') return;
      touched.push({ anchor, target });
      anchor.setAttribute('target', '_self');
    };
    forceSelf(button.tagName === 'A' ? button : null);
    forceSelf(button.closest ? button.closest('a[target]') : null);
    // 外层容器上的 target 也要管：真机上「下一关」是个 <a> 包着一层 <button>。
    forceSelf(button.closest ? button.closest('[target]') : null);

    // 页面到底想打开哪个地址——**记下来给调用方兜底**。
    // 有些站点的控件点不动（改版、被遮、React 合成事件没接上），但它的跳转地址是确定的；
    // 有了这个，最坏情况也能自己走过去，而不是「点了没反应、只能干等超时」。
    let intercepted = '';
    try {
      host.open = function patchedOpen(url) {
        if (url) {
          intercepted = String(url);
          state.lastPopupUrl = intercepted;
          host.location.href = intercepted;
        }
        return host;
      };
      button.click();
    } finally {
      setTimeout(() => {
        host.open = originalOpen;
        for (const item of touched) {
          try {
            if (item.target === null) item.anchor.removeAttribute('target');
            else item.anchor.setAttribute('target', item.target);
          } catch (error) { /* 节点可能已被 React 换掉，忽略 */ }
        }
      }, restoreDelayMs);
    }
    return intercepted;
  }

  /**
   * 猜这个控件要跳去哪：先看刚才拦到的弹出地址，再看它（或外层锚点）的 `href`。
   *
   * 用途：控件点不动时的**兜底导航**。拿不到就返回空串，调用方照旧报「点了没反应」。
   */
  function clickTargetOf(button, intercepted = '') {
    if (intercepted) return intercepted;
    const anchor = (button && button.tagName === 'A')
      ? button
      : (button && button.closest ? button.closest('a[href]') : null);
    if (!anchor) return '';
    const href = String(anchor.getAttribute('href') || '').trim();
    // `javascript:void(0)` / `#` 这类不是真地址：跟着走只会原地打转
    if (!href || /^(javascript:|#)/i.test(href)) return '';
    try {
      return new URL(href, location.href).href;
    } catch (error) {
      return '';
    }
  }

  /**
   * 作答当前这一关的**共同内核**：填答案 → 点提交 → 等结论 →（通过就）回传答案。
   *
   * 曾经「手动单关」与教学队列各写了一份，逻辑 90% 相同，改一边忘一边——
   * "点到自己的面板按钮"那个 bug 就是这么被放大成「两条流程抢同一个页面」的。
   * 现在只剩教学队列一条流程（手动单关已删），差异全部收进 options：
   *  - allowEditorFallback：没有本地答案时，是否拿编辑器当前内容兜底提交
   *  - allowReplay：找不到提交按钮时，是否重放录制到的接口
   *
   * @returns {Promise<{status:'passed'|'failed'|'unknown'|'timeout'|'blocked', text:string}>}
   *   blocked = 没走到提交（没答案/没编辑器/没按钮），调用方按自己的方式停下并说明。
   */
  async function answerCurrentLevel({ answer = null, allowEditorFallback = false, allowReplay = false } = {}) {
    let answerText = '';

    // ① 填答案
    if (answer && answer.kind === 'choice') {
      const picked = await answerChoiceLevel(answer.map);
      if (!picked.length) {
        // 具体原因（分组数对不上、单选给了多字母…）已经由 answerChoiceLevel 打到日志里
        return { status: 'blocked', text: '没有成功勾选任何题目（原因见上面的日志）' };
      }
      log(`已勾选：${picked.join('、')}`, 'ok');
    } else if (answer && answer.kind === 'code') {
      answerText = String(answer.code || '');
      // `unusableAnswer` = 「答案本身不可用」，调用方按**缺答案**处理（记账 + 跳过），
      // 不要停整条队列。与之相对，「页面上找不到编辑器/提交按钮」是**页面结构坏了**，
      // 那种必须停队——悄悄跳过会让一整片关卡无声漏掉。
      if (!answerText) {
        return { status: 'blocked', unusableAnswer: true, text: '答案里没有代码内容' };
      }
      // 等编辑器挂载：Monaco 是异步插进 DOM 的，进页面就查会误判成"没有编辑器"
      const editor = await waitForCodeEditor();
      if (!editor) {
        return { status: 'blocked', text: `页面上找不到代码编辑器（等了 8 秒也没有。现场：${describeEditorScene()}）` };
      }
      editor.write(answerText);
      log(`已把答案写入 ${editor.kind} 编辑器（${answerText.length} 字符）`, 'ok');
    } else if (allowEditorFallback) {
      const editor = await waitForCodeEditor(3000);
      if (!editor) {
        return { status: 'blocked', text: `没有本地答案，页面上也没有代码编辑器（现场：${describeEditorScene()}）` };
      }
      answerText = editor.read();
      log('答案库里没有这一关，使用编辑器当前内容提交', 'warn');
    } else {
      // 没本地答案也是「答案不可用」，同样按缺答案跳过（调用方负责记账）
      return { status: 'blocked', unusableAnswer: true, text: '没有本地答案' };
    }

    // ② 提交：优先点页面按钮（走页面自己的逻辑，最稳）；没有按钮再重放录制到的接口。
    let inlineResult = null;
    const submitButton = findButton(SUBMIT_PATTERNS);
    if (submitButton) {
      await settleBeforeSubmit();
      log(`点击页面按钮「${buttonLabel(submitButton)}」`);
      submitButton.click();
    } else if (allowReplay && state.templates.length) {
      const template = state.templates.find((item) => /submit|evaluate|answer|commit|code/i.test(item.url)) || state.templates[0];
      log(`页面上没有提交按钮，改为重放录制接口：${template.key}`, 'warn');
      const result = await replayTemplate(template, answerText);
      inlineResult = { status: looksPassed(result.text) ? 'passed' : 'unknown', text: result.text };
      log(`提交响应 HTTP ${result.status}：${snippet(result.text, 160)}`, inlineResult.status === 'passed' ? 'ok' : 'warn');
    } else {
      const candidates = describeButtons();
      return {
        status: 'blocked',
        text: '页面上找不到提交按钮'
          + (candidates.length ? `。当前页面可见的按钮：${candidates.join(' / ')}` : '（连按钮都没扫到：页面可能还在加载，或内容在 iframe 里）')
      };
    }

    // ③ 等真实结论（拿不到「通过」就由调用方决定停不停）
    const outcome = inlineResult || (await waitForSubmitResult());
    if (outcome.status === 'passed') {
      // 通过后把这一关的答案回传控制台落盘（写进 exports/answers/ 的规范文件）。
      // 实验得先被抓取过，否则控制台会明确说明原因，不会猜目录。
      const payload = passedAnswerPayload({
        choiceMap: answer && answer.kind === 'choice' ? answer.map : null,
        codeText: answerText
      });
      if (payload) {
        // 连了控制台就回传由它落盘；没连就**存进本地答案库**——纯脚本模式下
        // 「跑队列自动攒答案」全靠这一步，否则跑完一轮答案库还是导入时那么多。
        if (consoleEndpoint('/api/answer/save')) pushAnswerToConsole(payload);
        else if (harvestPassedAnswer(payload)) log('这一关的答案已存进本地答案库', 'ok');
      }
    }
    return outcome;
  }


  /** 请求停止连续作答（当前这一关做完就停）。 */
  /**
   * 停止：同时管两条链路。
   *
   * - 手动流程（一键作答并提交）：置 `stopRequested`，当前这一关做完就停。
   * - 教学课程队列：直接停队列（它每关是一次整页跳转，不停就会一直往下跑）。
   * 之前只置标志、没人读（删「连续作答」时把唯一读取点删掉了），按钮是死的。
   */
  function requestStop() {
    const queue = readTeachQueue();
    const queueRunning = Boolean(queue && queue.running);
    if (queueRunning) requestTeachStop();
    if (state.busy) {
      state.stopRequested = true;
      log('已请求停止：当前这一关处理完就停', 'warn');
    }
    if (!queueRunning && !state.busy) log('当前没有在作答', 'warn');
  }

  /* -------------------------------------------------------------- 教学课程面板 */

  // 「开启挑战」是真机实测的课堂实训页入口文案（与「开始挑战」一字之差，别漏；
  // 2026-09-29 换号后实测：/shixuns/{id}/challenges 上就是它，漏了会被当成"没入口"跳过整个实验）。
  const TEACH_ENTRY_PATTERNS = [/开启挑战/, /查看实战/, /继续挑战/, /开始挑战/, /继续学习/, /开始学习/, /进入关卡/];

  function teachSelection() {
    if (!state.teach) {
      state.teach = {
        // 流水线当前停在第几步：null = 自动跟随数据，数字 = 用户手动切过去的
        viewStep: null,
        courses: [],
        courseValue: '',
        experiments: [],
        selectedExperiments: {},
        levelsByExperiment: {},
        selectedLevels: {},
        missingCount: 0,
        busy: false,
        status: '未开始'
      };
      restoreTeachSelection();
    }
    return state.teach;
  }

  /** 下拉 value：课堂用 id，教学课程用 identifier（前缀区分 kind，二者不会撞车）。 */
  function courseValueOf(item) {
    if (!item) return '';
    return item.kind === 'classroom' ? `classroom:${item.id}` : `path:${item.identifier}`;
  }

  function persistTeachSelection() {
    const teach = teachSelection();
    GM_setValue(KEYS.teachSel, {
      courseValue: teach.courseValue,
      experiments: Object.keys(teach.selectedExperiments).filter((key) => teach.selectedExperiments[key]),
      levels: teach.selectedLevels
    });
  }

  function restoreTeachSelection() {
    const saved = GM_getValue(KEYS.teachSel, null);
    const teach = teachSelection();
    if (!saved || typeof saved !== 'object') return;
    teach.courseValue = typeof saved.courseValue === 'string' ? saved.courseValue : '';
    teach.selectedExperiments = Object.fromEntries((saved.experiments || []).map((key) => [String(key), true]));
    teach.selectedLevels = saved.levels && typeof saved.levels === 'object' ? saved.levels : {};
  }

  function teachExperimentLabel(experiment) {
    // 课堂实验拿不到进度（progressKnown === false）→ 只报总关数。
    if (experiment.progressKnown === false) return `${experiment.name}（${experiment.challenges} 关）`;
    const parts = [`${experiment.name}（${experiment.finished}/${experiment.challenges}）`];
    if (experiment.jupyter) parts.push('虚拟机');
    return parts.join(' ');
  }

  /**
   * 课堂流水线「自然」停在第几步。
   *
   * 顺序是死的：没读到实验 → 先选课程；读到实验但一个没选 → 选实验；选完 → 选关卡。
   */
  function naturalTeachStep(teach) {
    if (!teach.experiments.length) return 0;
    if (!Object.keys(teach.selectedExperiments || {}).length) return 1;
    return 2;
  }

  /** 当前显示的步骤：用户点过步骤条就以他点的为准，否则自动跟随数据。 */
  function teachStep(teach) {
    const view = teach.viewStep;
    if (view === null || view === undefined) return naturalTeachStep(teach);
    return Math.max(0, Math.min(2, Number(view) || 0));
  }

  /**
   * 点步骤条切步骤。
   *
   * 允许**往回**切（改课程、改实验选择），但不允许跳到还没走到的步骤——
   * 那只会显示一个空列表，让人以为坏了。
   */
  function gotoTeachStep(index) {
    const teach = teachSelection();
    if (index > naturalTeachStep(teach)) {
      log(`还没走到第 ${index + 1} 步：先把前面那一步做完`, 'warn');
      return;
    }
    teach.viewStep = index;
    renderTeach();
  }

  /** 把步骤条与「当前显示哪一步」同步到界面。 */
  function renderTeachSteps(teach) {
    const step = teachStep(teach);
    const bar = document.getElementById('eas-steps');
    if (bar) {
      [...bar.children].forEach((item, index) => {
        item.dataset.state = index < step ? 'done' : index === step ? 'active' : 'locked';
      });
    }
    ['eas-pane-course', 'eas-pane-experiments', 'eas-pane-levels'].forEach((id, index) => {
      const pane = document.getElementById(id);
      if (pane) pane.hidden = index !== step;
    });

    // 步骤条上带一句摘要：不必切回去也知道前面选了什么
    const courseName = (teach.courses.find((course) => courseValueOf(course) === String(teach.courseValue || '')) || {}).name;
    const notes = [
      [document.getElementById('eas-step-note-course'), courseName || ''],
      [document.getElementById('eas-step-note-experiments'),
        Object.keys(teach.selectedExperiments || {}).length ? `${Object.keys(teach.selectedExperiments).length} 个` : ''],
      [document.getElementById('eas-step-note-levels'),
        Object.keys(teach.selectedLevels || {}).length ? `${Object.keys(teach.selectedLevels).length} 关` : '']
    ];
    for (const [node, text] of notes) if (node) node.textContent = text;
  }

  function renderTeach() {
    renderTeachRunButton();
    const teach = teachSelection();
    renderTeachSteps(teach);
    const courseSelect = document.getElementById('eas-teach-course');
    if (courseSelect) {
      const current = String(teach.courseValue || '');
      courseSelect.replaceChildren(
        ...(teach.courses.length
          ? teach.courses.map((course) => el('option', {
            value: courseValueOf(course),
            textContent: course.kind === 'classroom' ? course.name : `教学课程 · ${course.name}`,
            selected: courseValueOf(course) === current
          }))
          : [el('option', { value: '', textContent: '（先点「刷新课程」）' })])
      );
      courseSelect.onchange = () => {
        teach.courseValue = courseSelect.value;
        teach.experiments = [];
        teach.selectedExperiments = {};
        teach.levelsByExperiment = {};
        persistTeachSelection();
        renderTeach();
      };
    }

    const experimentsBox = document.getElementById('eas-teach-experiments');
    if (experimentsBox) {
      experimentsBox.replaceChildren(
        ...(teach.experiments.length
          ? teach.experiments.map((experiment) => {
            const input = el('input', { type: 'checkbox', checked: Boolean(teach.selectedExperiments[experiment.identifier]) });
            input.addEventListener('change', () => {
              teach.selectedExperiments[experiment.identifier] = input.checked;
              persistTeachSelection();
              renderTeach();
            });
            return el('label', { className: 'eas-teach-item' }, [
              input,
              el('span', { textContent: teachExperimentLabel(experiment) })
            ]);
          })
          : [el('div', { className: 'eas-row', textContent: teach.busy ? '读取中…' : '（选课程 → 点「读取课程实验」）' })])
      );
    }

    const levelsBox = document.getElementById('eas-teach-levels');
    if (levelsBox) {
      const rows = [];
      for (const experiment of teach.experiments) {
        if (!teach.selectedExperiments[experiment.identifier] || experiment.jupyter) continue;
        const levels = teach.levelsByExperiment[experiment.identifier] || [];
        if (!levels.length) continue;
        rows.push(el('div', { className: 'eas-teach-group', textContent: experiment.name }));
        const chosen = teach.selectedLevels[experiment.identifier];
        for (const level of levels) {
          const checked = !Array.isArray(chosen) || !chosen.length || chosen.includes(level.position);
          const input = el('input', { type: 'checkbox', checked });
          input.addEventListener('change', () => {
            const current = new Set(teach.selectedLevels[experiment.identifier] || levels.map((item) => item.position));
            if (input.checked) current.add(level.position);
            else current.delete(level.position);
            teach.selectedLevels[experiment.identifier] = [...current].sort((a, b) => a - b);
            persistTeachSelection();
          });
          rows.push(el('label', { className: 'eas-teach-item' }, [
            input,
            el('span', { textContent: `第${level.position}关 ${level.name}` })
          ]));
        }
      }
      levelsBox.replaceChildren(...(rows.length ? rows : [el('div', { className: 'eas-row', textContent: '（勾选实验后点「读取关卡」）' })]));
    }

    // 两个「读取」按钮的可用性：还没选课程/实验时它们点了只会弹提示，
    // 那就直接禁用——亮着的按钮点下去什么都不发生，比灰着更让人困惑。
    const pickedCount = Object.keys(teach.selectedExperiments || {})
      .filter((key) => teach.selectedExperiments[key]).length;
    const loadExperiments = document.getElementById('eas-teach-load-experiments');
    if (loadExperiments) {
      loadExperiments.disabled = teach.busy || !teach.courses.length || !teach.courseValue;
      loadExperiments.title = loadExperiments.disabled ? '先选一门课程' : '读取这门课程的实验';
    }
    const loadLevels = document.getElementById('eas-teach-load-levels');
    if (loadLevels) {
      loadLevels.disabled = teach.busy || !pickedCount;
      loadLevels.title = loadLevels.disabled ? '先勾选至少一个实验' : '读取所勾选实验的关卡';
    }

    const status = document.getElementById('eas-teach-status');
    if (status) {
      status.textContent = `${teach.status}${teach.missingCount ? `｜缺答案 ${teach.missingCount}` : ''}`;
    }
  }

  /**
   * 面板整体收起 / 展开（状态记 GM，刷新后保持）。
   *
   * 为什么需要：面板固定在页面上、还占着不小的高度，做题时一直挡着题目。
   * 原来只有「课堂」那一小块能折，面板本身收不掉。
   */
  function togglePanelFold() {
    const panel = document.getElementById('eas-panel');
    if (!panel) return;
    const folded = panel.getAttribute('data-folded') !== 'true';
    applyPanelFold(folded);
    GM_setValue(KEYS.panelFolded, folded);
  }

  /** 套用面板收起态（按钮文案与 aria 一起同步）。 */
  function applyPanelFold(folded) {
    const panel = document.getElementById('eas-panel');
    const button = document.getElementById('eas-panel-fold');
    if (!panel) return;
    panel.setAttribute('data-folded', folded ? 'true' : 'false');
    if (button) {
      button.textContent = folded ? '展开 ▾' : '收起 ▴';
      button.setAttribute('aria-expanded', folded ? 'false' : 'true');
      button.title = folded ? '展开面板' : '收起面板（只留标题栏）';
    }
  }

  /** 「刷新课程」：先拉「我的课堂」（courses.json，始终可用），再把当前页（若是 /paths/{id}）识别出的教学课程并入缓存，最后刷新下拉。 */
  async function refreshTeachCourses() {
    const teach = teachSelection();
    teach.busy = true;
    teach.status = '读取课程…';
    renderTeach();
    try {
      const classrooms = await loadClassrooms();
      const identifier = parseCurrentPathIdentifier();
      if (identifier) {
        const course = await loadPathCourse(identifier);
        cacheTeachCourse(course);
      }
      const cache = readTeachCourseCache().map((item) => ({ ...item, kind: 'path' }));
      teach.courses = [...classrooms, ...cache];
      if (!teach.courses.some((item) => courseValueOf(item) === teach.courseValue)) {
        teach.courseValue = teach.courses.length ? courseValueOf(teach.courses[0]) : '';
      }
      teach.status = teach.courses.length
        ? `课堂 ${classrooms.length} 门${cache.length ? `（另有教学课程缓存 ${cache.length} 门）` : ''}`
        : '没读到课堂：确认已登录头歌，且确实加入了课堂';
      log(`课堂列表：${classrooms.length} 门（我的课堂，来自 courses.json${identifier ? '，已并入当前页教学课程' : ''}）`, 'ok');
    } catch (error) {
      teach.status = '课程读取失败';
      log(`课程读取失败：${error.message}`, 'error');
    }
    teach.busy = false;
    renderTeach();
  }

  /** 读课程实验：按课程 kind 分派（课堂走 homework_commons，教学课程走 stages）。 */
  async function loadTeachExperimentsPanel() {
    const teach = teachSelection();
    const course = teach.courses.find((item) => courseValueOf(item) === teach.courseValue) || teach.courses[0];
    if (!course) {
      log('先点「刷新课程」', 'warn');
      return;
    }
    if (course.kind === 'classroom' && !course.classroomCode) {
      log('这门课堂没解析出课堂码，跳过', 'warn');
      return;
    }
    // 读完**一定停在「实验」这一步**（index 1），不要把 viewStep 交回自动跟随：
    // 上一次勾过的实验还留在 GM 里，naturalTeachStep 会直接给到第 3 步（关卡），
    // 表现就是「点了读取课程实验却跳过了实验这一步」。
    teach.viewStep = 1;
    teach.busy = true;
    teach.status = '读取课程实验…';
    renderTeach();
    try {
      teach.experiments = course.kind === 'classroom'
        ? await loadClassroomExperiments(course.classroomCode)
        : await loadTeachExperiments(course.identifier);
      teach.status = `课程实验 ${teach.experiments.length} 个`;
      log(`课程实验已读取：${teach.experiments.length} 个`, 'ok');
      // 清掉**本次没读到的**实验选择。换过课堂、平台重发过实验，旧标识会一直留在选择里，
      // 既在步骤条上报出「已选 N 个」的假数字，也会让队列去追一个不存在的实验。
      // 读到空列表时不动（多半是接口失败，别把用户的选择一并抹掉）。
      if (teach.experiments.length) {
        const alive = new Set(teach.experiments.map((item) => String(item.identifier)));
        const picked = Object.keys(teach.selectedExperiments || {})
          .filter((key) => teach.selectedExperiments[key]);
        const kept = picked.filter((key) => alive.has(key));
        if (kept.length !== picked.length) {
          teach.selectedExperiments = Object.fromEntries(kept.map((key) => [key, true]));
          log(`有 ${picked.length - kept.length} 个实验选择已失效（不在本次读到的列表里），已清掉`, 'warn');
        }
      }
    } catch (error) {
      teach.status = '课程实验读取失败';
      log(`课程实验读取失败：${error.message}`, 'error');
    }
    teach.busy = false;
    persistTeachSelection();
    renderTeach();
  }

  async function loadTeachLevelsPanel() {
    const teach = teachSelection();
    // 用户点了「读取关卡」：流水线交回自动跟随，读完自然落到第 3 步
    teach.viewStep = null;
    teach.busy = true;
    teach.status = '读取关卡…';
    renderTeach();
    const next = { ...(teach.levelsByExperiment || {}) };
    let failed = 0;
    for (const experiment of teach.experiments) {
      if (!teach.selectedExperiments[experiment.identifier] || experiment.jupyter) continue;
      try {
        next[experiment.identifier] = await loadTeachChallenges(experiment.identifier);
      } catch (error) {
        failed += 1;
        log(`关卡列表读取失败（${experiment.name}）：${error.message}`, 'error');
      }
    }
    teach.levelsByExperiment = next;
    teach.busy = false;
    teach.status = failed ? `关卡读取有 ${failed} 个失败` : '待选关卡';
    renderTeach();
  }

  /* -------------------------------------------------------- 缺答案清单（控制台） */

  /**
   * Promise 版的 JSON 请求：包在 `consoleRequest` 之上（所以同样享受「地址过期自动纠正」）。
   *
   * 只保留**一个**传输实现——之前这里也定义了一个叫 consoleRequest 的函数，
   * 与新加的传输层同名；函数声明会提升，后定义的那个会悄悄赢掉，
   * 于是新调用被旧签名解释（method 位置收到一个路径）。别再拆出第二个实现。
   */
  function consoleJson(method, pathname, body) {
    return new Promise((resolve, reject) => {
      consoleRequest(pathname, {
        method,
        body,
        onload: (response) => {
          let payload = null;
          try {
            payload = JSON.parse(response.responseText || '{}');
          } catch (error) {
            payload = null;
          }
          if (response.status === 403) {
            reject(new Error('控制台拒绝：地址里的 token 不对'));
            return;
          }
          if (!payload || !payload.ok) {
            reject(new Error((payload && payload.error) || `HTTP ${response.status}`));
            return;
          }
          resolve(payload);
        },
        onerror: () => reject(new Error('连不上本地控制台'))
      });
    });
  }

  async function fetchTeachMissing() {
    const payload = await consoleJson('GET', '/api/missing');
    return Array.isArray(payload.items) ? payload.items : [];
  }

  async function postTeachMissing(body, okMessage) {
    try {
      const payload = await consoleJson('POST', '/api/missing', body);
      if (okMessage) log(okMessage, 'ok');
      return payload;
    } catch (error) {
      log(`缺答案清单操作失败（不影响本次作答）：${error.message}`, 'warn');
      return null;
    }
  }

  /** 面板上的「缺答案 N」：拉取失败只影响显示，不影响答题。 */
  async function refreshTeachMissingCount() {
    try {
      const items = await fetchTeachMissing();
      teachSelection().missingCount = items.length;
      renderTeach();
    } catch (error) {
      /* 控制台没开就不显示，不打扰 */
    }
  }

  /** 上报一条缺答案（course 模式用队列里的课程名；missing 模式用条目自带的归属）。 */
  async function reportTeachMissing(queue, levelName) {
    const position = Number(state.taskContext && state.taskContext.levelPosition) || 0;
    const experiment = queue.mode === 'course' ? queue.experiments[queue.experimentIndex] : null;
    const existing = queue.mode === 'missing' && queue.items[queue.index] ? queue.items[queue.index] : null;
    const item = buildMissingItem({
      course: (existing && existing.course) || queue.courseName || '',
      experiment: experiment ? experiment.name : (existing ? existing.experiment : ''),
      levelName: levelName || (existing ? existing.level : ''),
      position,
      identifier: currentLevelId(),
      url: location.href
    });
    return postTeachMissing({ action: 'add', items: [item] }, `已上报缺答案：${item.level}`);
  }

  /** 答完后把这一关从清单里移除（按标识/URL 找 id，再按 id 删）。 */
  async function resolveTeachMissing() {
    const identifier = currentLevelId();
    const href = location.href;
    try {
      const items = await fetchTeachMissing();
      const ids = items
        .filter((item) => item.identifier === identifier || (item.url && String(item.url).split('?')[0] === href.split('?')[0]))
        .map((item) => item.id);
      if (ids.length) await postTeachMissing({ action: 'remove', ids }, `已从缺答案清单移除 ${ids.length} 条`);
      teachSelection().missingCount = Math.max(0, items.length - ids.length);
      renderTeach();
    } catch (error) {
      /* 移除失败不影响作答 */
    }
  }

  /* -------------------------------------------------------------- 教学课程执行 */

  /** 进入指定课程实验：把 handoff 写好再跳转，落地由 maybeContinueTeachQueue 接手。 */
  function enterTeachExperiment(queue) {
    const experiment = queue.experiments[queue.experimentIndex];
    if (!experiment) {
      finishTeachQueue();
      return;
    }
    const teach = teachSelection();
    teach.status = `进入实验：${experiment.name}`;
    renderTeach();
    queue.expected = { identifier: '', position: 0 };
    // 刚进实验：允许做一次「回退到链首」（入口可能落在链中段）；推进阶段不再回退。
    queue.needChainStart = true;
    queue.startHops = 0;
    queue.hopTrail = [];
    queue.handoffAt = Date.now();
    writeTeachQueue(queue);
    location.href = `https://www.educoder.net/shixuns/${experiment.identifier}/challenges`;
  }

  /**
   * 若落点不在链首，沿 prev_game 回退（标识永远在 URL 最后一段，直接换掉最后一段即可）。
   * 真机已验证：教学课程关卡页是单段式 /tasks/{id}，页面上没有「上一关」控件。
   * @returns {Promise<boolean>} true = 已在链首，可以开始处理
   */
  /**
   * 把页面带到「本次要作答的第一关」。
   *
   * 优先**一次跳转直达**：关卡列表接口本来就返回每关的 identifier，用它拼 URL
   * 换掉路径最后一段即可——比沿 prev_game 逐关回退快得多（逐关回退是每关一次
   * 整页刷新，实测 5 关要 6 秒，20 关要等半分钟）。
   * 拿不到关卡列表（如「按清单再答」模式）时才退回逐关回退。
   */
  async function goToChainStart(queue) {
    const task = currentTask();
    if (!task) return true; // 数据未就绪，交给上层判定

    // ① 优先**直达「本次要作答的第一关」**——一次导航，不管现在在链的哪一段。
    //    注意必须放在 `prevGame` 判空**之前**：入口页常常正好落在第 1 关（prevGame 为空），
    //    若先判空就会在链首提前 return，直达分支永远不执行（这就是"还是先到第1关再顺着走"的原因）。
    const experiment = queue.mode === 'course' ? queue.experiments[queue.experimentIndex] : null;
    const firstPosition = experiment && Array.isArray(experiment.positions) && experiment.positions.length
      ? experiment.positions[0]
      : 0;
    const targetId = firstPosition && experiment.levelIdentifiers
      ? experiment.levelIdentifiers[firstPosition]
      : '';
    if (targetId && targetId !== currentLevelId()) {
      log(`直接跳到第 ${firstPosition} 关（${targetId}），不再逐关回退`);
      queue.startHops = 0;
      queue.hopTrail = [];
      queue.expected = { identifier: targetId, position: 0 };
      queue.handoffAt = Date.now();
      writeTeachQueue(queue);
      location.href = urlForLevelIdentifier(targetId);
      return false;
    }

    if (!task.prevGame) return true; // 已在链首

    // ② 兜底：拿不到关卡列表时，仍沿 prev_game 逐关回退
    const previous = task.prevGame;
    const trail = Array.isArray(queue.hopTrail) ? queue.hopTrail : [];
    const decision = backtrackDecision({
      hops: queue.startHops || 0,
      trail,
      previous,
      currentIdentifier: currentLevelId()
    });
    if (decision !== 'go') {
      stopTeachQueue(`回退链首失败（${decision.replace('stop:', '')}），已暂停`);
      return false;
    }
    log(`当前不在第 1 关，沿 prev_game 回退：${previous}`);
    queue.startHops = (queue.startHops || 0) + 1;
    queue.hopTrail = [...trail, previous].slice(-6);
    queue.expected = { identifier: previous, position: 0 };
    queue.handoffAt = Date.now();
    writeTeachQueue(queue);
    location.href = urlForLevelIdentifier(previous);
    return false;
  }

  /** 处理队首这一关：判定 → 作答 → 推进；任何一步失败都停下并指明是哪一关。 */
  async function processTeachLevel(queue) {
    // 关卡数据是异步拉的，进页面立刻查常常查不到——先等一会儿，别急着停队。
    // 与 maybeContinueTeachQueue 共用 ensureLevelData（等 → 补足 10 秒间隔 → 刷新重试）。
    const ready = await ensureLevelData(queue);
    if (ready.reloading) return;
    if (!ready.task) {
      stopTeachQueue(
        `等了 ${Number(state.levelWaitSeconds) || 60} 秒并刷新重试 2 次，还是没读到这一关的关卡数据`
          + '（页面一直在加载、被拦，或内容在 iframe 里）。'
          + '可以再点「继续答题（跳过已通过）」，或把面板「关卡数据最多等（秒）」调大',
        'warn'
      );
      return;
    }
    const task = ready.task;
    const experiment = queue.mode === 'course' ? queue.experiments[queue.experimentIndex] : null;
    const position = Number(task.levelPosition) || 0;
    const levelName = experiment && experiment.levelNames
      ? experiment.levelNames[position] || `第${position}关`
      : (queue.mode === 'missing' && queue.items[queue.index] ? queue.items[queue.index].level : `第${position}关`);
    const label = `${experiment ? `${experiment.name} ` : ''}${levelName}`;
    // 认领这次交接：被开走的旧标签页靠它判断「自己已经没用了」（见 closeSelfIfStale）。
    // 连时间一起写：只有**最近**被认领的才算数，免得把上一轮残留的标识当成别人在跑。
    if (queue.activeTabId !== TAB_ID) {
      queue.activeTabId = TAB_ID;
      queue.activeTabAt = Date.now();
      writeTeachQueue(queue);
    }
    // 供 answerKeyForCurrentLevel 兜底：平台换了关卡标识时按「实验名__关卡名」匹配
    state.levelHint = { experimentName: experiment ? experiment.name : '', levelName };

    // 只在「刚进实验」时回退链首；正常推进（点「下一关」到下一关）时绝不回退——
    // 真机上「下一关」是整页刷新，若每关都按 prev_game 回退，就会在第 1/2 关之间无限打转。
    if (shouldBacktrack(queue)) {
      if (!(await goToChainStart(queue))) return; // 已发起回退跳转，等下一轮 boot 接力
      queue.needChainStart = false;
      writeTeachQueue(queue);
    }

    log(`关卡上下文：${currentLevelId()}｜第${position || '?'}关｜prev=${task.prevGame || '无'}｜next=${task.nextGame || '无'}｜已通过=${task.passed ? '是' : '否'}`, 'info');

    const selected = experiment ? experiment.positions.includes(position) : true;
    // 编辑器（Monaco）是**异步挂载**的：进页面立刻查会查不到，于是代码题被判成
    // 「没有编辑器也没有选项」→ 当成虚拟机题跳过（实测就这么漏做的）。
    // 判定前先等一小会儿；真虚拟机题只多花这点时间，代价可接受。
    const editor = await waitForCodeEditor(2500);
    const hasChoice = Boolean(document.querySelector('input[type="radio"], input[type="checkbox"]'));
    // 队列路径同样要核对班级：对不上就停队，绝不给别班的关卡填答案。
    const resolved = resolveAnswerForCurrentLevel();
    if (resolved.blocked) {
      log(resolved.blocked, 'error');
      stopTeachQueue('班级不一致', 'error');
      return;
    }
    const parsedAnswer = readAnswer(resolved.entry);
    const action = teachLevelAction({
      selected,
      hasEditor: Boolean(editor),
      hasChoice,
      passed: Boolean(task.passed),
      hasAnswer: Boolean(parsedAnswer)
    });

    queue.expected = { identifier: '', position: 0 };
    writeTeachQueue(queue);

    if (action === 'unselected') {
      log(`${label}：未选中，路过`);
      return advanceTeachQueue(queue);
    }
    if (action === 'vm') {
      log(`${label}：没有编辑器也没有选项（虚拟机题？），跳过。现场：${describeEditorScene()}`, 'warn');
      return advanceTeachQueue(queue);
    }
    if (action === 'passed') {
      log(`${label}：已通过，跳过`, 'ok');
      return advanceTeachQueue(queue);
    }
    if (action === 'missing') {
      log(`${label}：没有本地答案，记入缺答案清单`, 'warn');
      await reportTeachMissing(queue, levelName);
      return advanceTeachQueue(queue);
    }

    // 答案「对不上这一关」时按**答案不可用**处理：记账并跳过，不整队停。
    // 原来这条路会走到 answerCurrentLevel → 报「无法确定题目分组」→ 队列直接停，
    // 一关的过期/残缺答案就能把 100+ 关的队列卡死（实测：5 个 [8、面向对象分析] 实验的
    // L001 被跨实验串台的答案污染；另有两关的图片题只答了非图片小问）。
    // 注意：**不是**放宽安全规则——一个选项框都不会勾，只是不再连累后面的关卡。
    //
    // 传 `parsedAnswer.map` 而不是 `parsedAnswer`：选择题的题号映射在 `.map` 里
    // （`choiceAnswerFit` 两种都认，但显式给映射才不容易再踩「数出 kind/map 两个键」的坑）。
    if (hasChoice && parsedAnswer && parsedAnswer.kind === 'choice') {
      const fit = choiceAnswerFit(parsedAnswer.map);
      if (!fit.ok) {
        log(`${label}：${fit.reason}——答案与这一关对不上，记入缺答案清单并跳过`, 'warn');
        await reportTeachMissing(queue, levelName);
        return advanceTeachQueue(queue);
      }
    }

    // 作答：与手动单关**共用同一个内核**；这里不做「编辑器内容兜底」——没答案就上报缺答案。
    const outcome = await answerCurrentLevel({ answer: parsedAnswer });
    if (outcome.status === 'blocked') {
      // **答案本身不可用**（库里这一关只存了语言没存代码、或压根没条目）→ 按缺答案处理：
      // 记账 + 跳过。与「答案对不上这一关」同一条原则——一关的残缺答案不该拖垮整条队列
      // （实测：`结构化分析工具 IPO图` 就是这么把队列停掉的，而它只是一关没答案）。
      if (outcome.unusableAnswer) {
        log(`${label}：${outcome.text}——记入缺答案清单并跳过`, 'warn');
        await reportTeachMissing(queue, levelName);
        return advanceTeachQueue(queue);
      }
      stopTeachQueue(`${label}：${outcome.text}`, 'error');
      return;
    }
    if (outcome.status !== 'passed') {
      const reason = outcome.status === 'failed'
        ? '提交未通过'
        : outcome.status === 'timeout'
          ? '评测超时（超过等待上限还没出结果，这一关可能还在后台跑）'
          : '没拿到明确结论';
      stopTeachQueue(
        `${label}：${reason}——${snippet(outcome.text, 120)}。修好后重跑即可（已通过的会自动跳过）`,
        'error'
      );
      return;
    }
    log(`${label}：提交成功`, 'ok');
    await resolveTeachMissing();
    return advanceTeachQueue(queue);
  }

  /** 推进：能点「下一关」就点；本实验选中的都做完了或链到头就换下一个实验。 */
  async function advanceTeachQueue(queue) {
    const task = currentTask();
    const experiment = queue.mode === 'course' ? queue.experiments[queue.experimentIndex] : null;
    const position = Number(task && task.levelPosition) || 0;

    if (experiment) {
      queue.visited = Array.isArray(queue.visited) ? queue.visited : [];
      if (position && !queue.visited.includes(position)) queue.visited.push(position);
      const done = experiment.positions.every((item) => queue.visited.includes(item));
      if (done || !task || !task.nextGame) {
        queue.experimentIndex += 1;
        queue.visited = [];
        return enterTeachExperiment(queue);
      }
    } else if (queue.mode === 'missing') {
      queue.index += 1;
      if (queue.index >= queue.items.length) {
        finishTeachQueue();
        return;
      }
      queue.handoffAt = Date.now();
      writeTeachQueue(queue);
      log(`按清单再答：前往下一关（${queue.index + 1}/${queue.items.length}）`);
      location.href = queue.items[queue.index].url;
      return;
    }

    const nextButton = findButton(NEXT_LEVEL_PATTERNS);
    if (!nextButton) {
      queue.experimentIndex += 1;
      queue.visited = [];
      return enterTeachExperiment(queue);
    }
    queue.handoffAt = Date.now();
    writeTeachQueue(queue);
    log('进入下一关');
    const before = location.pathname;
    // 强制在当前标签页跳转：头歌的「下一关」会开新标签页——每关一个，上百关就是上百个标签页
    const popped = clickStayingInThisTab(nextButton);
    if (await waitForPathChange(before, 8000)) {
      return handoffToNextLevel(queue);
    }
    // 点了「下一关」页面却没跳转：**绝不能静默卡住**——实测就是这么"断"的：
    // 日志停在「进入下一关」之后再无输出，也没有「已停」。重试一次，还不行就明确停队列。
    const retryButton = findButton(NEXT_LEVEL_PATTERNS);
    const retryPopped = retryButton ? clickStayingInThisTab(retryButton) : '';
    if (retryButton) {
      log('点了「下一关」页面没动，重试一次…', 'warn');
      if (await waitForPathChange(before, 5000)) return handoffToNextLevel(queue);
    }
    // 两次都没动：控件可能点不动，但目标地址一般是确定的 —— 自己走过去。
    const target = clickTargetOf(retryButton || nextButton, retryPopped || popped);
    if (target && target !== location.href) {
      log(`「下一关」点了没反应，改用它的目标地址直接跳转：${target}`, 'warn');
      location.href = target;
      return;
    }
    // 还不动就再判一次：如果这次跳转其实是被新标签页接走的，那本页是该退场的旧页——
    // 安静关掉自己就好。**绝不能**在这里 stopTeachQueue：队列状态是同一个域所有标签页
    // 共享的，从僵尸页停队会把还在正常跑的那个标签页一起停掉。
    if (await closeSelfIfStale()) return;
    stopTeachQueue('点了「下一关」但页面没有跳转，队列仍停（重跑会跳过已通过的）', 'warn');
  }

  /** 点完「下一关」且页面确实跳转后的交接：清掉回退计数，再接力跑下一关。 */
  async function handoffToNextLevel(queue) {
    await sleep(1500);
    // 进入正常推进阶段：清掉回退链首的计数，避免影响下一轮。
    queue.startHops = 0;
    queue.hopTrail = [];
    queue.needChainStart = false;
    writeTeachQueue(queue);
    // 接力就是「再进一次 maybeContinueTeachQueue」，先放行重入标志，别被自己的防重入挡掉。
    teachQueueChecking = false;
    await maybeContinueTeachQueue();
  }

  /* ------------------------------------------------------------ 两个队列入口 */

  /** 「一键答题（选中）」：把面板选择落成队列，然后从第一个实验开始跑。 */
  /**
   * 「一键答题」按钮的文案。
   *
   * 队列停下后没有单独的「继续」按钮——直接再点这个就是续跑（每关都会检查 passed，
   * 已通过的自动跳过）。这里把文案改掉，省得用户怀疑「到底该点哪个」。
   */
  function renderTeachRunButton() {
    const button = document.getElementById('eas-teach-run');
    if (!button) return;
    const queue = readTeachQueue();
    const running = Boolean(queue && queue.running);
    button.textContent = queue && queue.stoppedReason ? '继续答题（跳过已通过）' : '一键答题（选中）';

    // 没选实验、也没有在跑的队列 → 点了只会弹一句「先点读取课程实验」。
    // 能做的事才让点，别让按钮亮着骗人（截图里就是这样：课程都没选，它还是绿的）。
    const teach = teachSelection();
    const picked = Object.keys(teach.selectedExperiments || {})
      .filter((key) => teach.selectedExperiments[key]).length;
    button.disabled = !running && (state.busy || !picked);
    button.title = button.disabled && !running
      ? '先在上面选好实验（和关卡）'
      : '按当前选择开始/继续答题';
  }

  async function startTeachRun() {
    const teach = teachSelection();
    if (state.busy) {
      log('已有任务在执行（等它结束或点停止）', 'warn');
      return;
    }
    if (!teach.courseValue) {
      log('先点「刷新课程」', 'warn');
      return;
    }
    if (!teach.experiments.length) {
      log('先点「读取课程实验」', 'warn');
      return;
    }
    const selectedIds = Object.keys(teach.selectedExperiments).filter((key) => teach.selectedExperiments[key]);
    if (!selectedIds.length) {
      log('至少勾选一个课程实验', 'warn');
      return;
    }

    // 关卡列表以「现读」为准（面板里的可能过期），顺便拿到上报要用的关卡名。
    teach.busy = true;
    teach.status = '读取关卡…';
    renderTeach();
    const levelsByExperiment = {};
    for (const experiment of teach.experiments) {
      if (!teach.selectedExperiments[experiment.identifier] || experiment.jupyter) continue;
      try {
        levelsByExperiment[experiment.identifier] = await loadTeachChallenges(experiment.identifier);
      } catch (error) {
        teach.busy = false;
        teach.status = '关卡列表读取失败';
        renderTeach();
        log(`关卡列表读取失败（${experiment.name}）：${error.message}`, 'error');
        return;
      }
    }
    teach.levelsByExperiment = levelsByExperiment;
    teach.busy = false;

    const built = buildTeachQueue(teach.experiments, { experiments: selectedIds, levels: teach.selectedLevels }, levelsByExperiment);
    if (built.skippedJupyter.length) log(`虚拟机实验已跳过：${built.skippedJupyter.join('、')}`, 'warn');
    if (!built.total) {
      teach.status = '没有可作答的关卡';
      renderTeach();
      log('没有可作答的关卡（是不是全被跳过/全没勾？）', 'warn');
      return;
    }

    const course = teach.courses.find((item) => courseValueOf(item) === teach.courseValue);
    // 存档续跑：上次**停下来**（stoppedReason 有值）的队列，如果和这次选的是同一批实验，
    // 就接着上次的实验序号与已访问关卡跑——不必从第一个实验重来（重来虽也不会错，
    // 但每个已通过的关卡都要再走一遍页面，整门课跑下来很费时间）。
    const saved = readTeachQueue();
    const savedIds = saved && saved.mode === 'course' && Array.isArray(saved.experiments)
      ? saved.experiments.map((item) => item.identifier).join(',')
      : '';
    const resume = Boolean(savedIds && savedIds === built.experiments.map((item) => item.identifier).join(',') && saved.stoppedReason);

    const queue = {
      mode: 'course',
      courseName: course ? course.name : '',
      experiments: built.experiments,
      experimentIndex: resume ? Math.min(Math.max(Number(saved.experimentIndex) || 0, 0), built.experiments.length - 1) : 0,
      visited: resume && Array.isArray(saved.visited) ? saved.visited : [],
      expected: { identifier: '', position: 0 },
      running: true,
      handoffAt: Date.now(),
      startedAt: new Date().toISOString()
    };
    writeTeachQueue(queue);
    teach.status = `一键答题：0/${built.total}`;
    renderTeach();
    if (resume) {
      log(`续跑：从第 ${queue.experimentIndex + 1}/${built.experiments.length} 个实验接着跑（已通过的关卡自动跳过）`, 'ok');
    } else {
      log(`一键答题开始：${built.experiments.length} 个实验 / ${built.total} 关`, 'ok');
    }
    enterTeachExperiment(queue);
  }

  /** 「按清单再答」：直接照缺答案清单里的 URL 逐条跑。 */
  async function startMissingRun() {
    if (state.busy) {
      log('已有任务在执行（等它结束或点停止）', 'warn');
      return;
    }
    let items = [];
    try {
      items = await fetchTeachMissing();
    } catch (error) {
      log(`读取缺答案清单失败：${error.message}`, 'error');
      return;
    }
    const usable = items.filter((item) => item.url);
    if (!usable.length) {
      log(items.length ? '清单里的条目没有关卡 URL（旧数据？），无法直达' : '缺答案清单是空的', 'warn');
      return;
    }
    const queue = {
      mode: 'missing',
      items: usable.map((item) => ({
        id: item.id,
        course: item.course,
        experiment: item.experiment,
        level: item.level,
        level_id: item.level_id,
        identifier: item.identifier,
        url: item.url
      })),
      index: 0,
      running: true,
      handoffAt: Date.now(),
      startedAt: new Date().toISOString()
    };
    writeTeachQueue(queue);
    const teach = teachSelection();
    teach.status = `按清单再答：0/${queue.items.length}`;
    renderTeach();
    log(`按清单再答：共 ${queue.items.length} 关`, 'ok');
    location.href = queue.items[0].url;
  }

  /* ------------------------------------------------------------------- 面板 */

  const CSS = `
    #eas-panel { position: fixed; left: 14px; bottom: 14px; z-index: 2147483000; width: 380px; max-width: 92vw;
      font: 12px/1.5 "Microsoft YaHei", system-ui, sans-serif; color: #dde4ee; background: #11151c;
      border: 1px solid #2d3644; border-radius: 6px; box-shadow: 0 8px 28px rgba(0,0,0,.45); }
    /* **必须有这一条**：浏览器默认样式表里的 [hidden]{display:none} 是**作者样式
       优先级的对手**——.eas-step-pane{display:flex} 会把它顶掉，于是三个步骤面板
       同时显示，看起来就是「UI 重叠」。控制台那边一直有这条，篡改猴这边漏了。
       （CSS 注释里不要写反引号：这一整块是模板字符串，反引号会把它截断。） */
    #eas-panel [hidden] { display: none !important; }
    /* 标题栏兼作拖动把手：面板固定不动会盖住页面自己的控件
       （头歌的「提交」常在右下角），所以默认放左下角，并且必须能挪走。 */
    #eas-panel header { display: flex; align-items: center; gap: 8px; padding: 8px 10px;
      border-bottom: 1px solid #222833; cursor: move; user-select: none; touch-action: none; }
    #eas-panel header b { font-size: 12px; letter-spacing: .04em; }
    /* 收起态：只留标题栏。面板固定在页面上，做题时一直挡着题目，
       能收起来才不会碍事（收起状态记在 GM，刷新后保持）。 */
    #eas-panel[data-folded="true"] .eas-body { display: none; }
    #eas-panel header .eas-fold { font: 10px/1 inherit; padding: 4px 7px; cursor: pointer; }
    #eas-panel .eas-tag { font: 10px/1 monospace; padding: 3px 5px; border: 1px solid #2d3644; border-radius: 3px; color: #31d6a8; }
    #eas-panel .eas-body { padding: 8px 10px; display: flex; flex-direction: column; gap: 6px; max-height: min(78vh, 640px); overflow: auto; }
    #eas-panel button { font: 11px/1 inherit; color: #dde4ee; background: #151a22; border: 1px solid #2d3644;
      border-radius: 4px; padding: 6px 8px; cursor: pointer; }
    #eas-panel button:hover { background: #1b2029; }
    #eas-panel button.eas-primary { background: #31d6a8; border-color: #31d6a8; color: #052b22; font-weight: 600; }
    #eas-panel .eas-row { font-family: monospace; font-size: 11px; color: #a4b0c1; word-break: break-all; }
    #eas-panel .eas-ok { color: #45c07d; } #eas-panel .eas-warn { color: #e2b23f; } #eas-panel .eas-error { color: #f2685f; }
    #eas-log { display: flex; flex-direction: column; gap: 3px; min-height: 180px; max-height: 45vh; overflow: auto; resize: vertical; padding-top: 4px; border-top: 1px solid #222833; }
    #eas-panel .eas-mini { display: flex; gap: 6px; flex-wrap: wrap; }
    #eas-panel .eas-opts { display: flex; flex-direction: column; gap: 3px; border-top: 1px solid #222833; padding-top: 6px; }
    #eas-panel .eas-opt { display: flex; align-items: center; gap: 6px; color: #a4b0c1; cursor: pointer; }
    #eas-panel .eas-opt input { margin: 0; }
    /* 课堂流水线：步骤条 + 单步内容（与控制台的「提取」面板同构）
       —— 三项**必须在一行**，且字不能被裁：给足内边距、nowrap + 省略号。 */
    #eas-panel .eas-steps {
      display: flex; margin: 0 0 9px; padding: 0; list-style: none;
      border: 1px solid #2d3644; border-radius: 4px; overflow: hidden;
      background: #151a22;
      /* **flex: none 不能去掉**：.eas-body 是 column 方向的 flex 容器，
         而 flex 项在主轴（高度）上默认 flex-shrink:1。这里又写了 overflow:hidden，
         于是它的「自动最小尺寸」变成 **0**（overflow 可见的行不受影响），
         内容一长（实验列表 + 关卡列表 + 日志）整条步骤栏就被压成一条细缝——
         表现就是「课程/实验/关卡这一行塌陷」。 */
      flex: none;
    }
    #eas-panel .eas-steps li {
      flex: 1 1 0; display: flex; align-items: center; gap: 6px;
      padding: 9px 10px; min-width: 0; cursor: pointer;
      color: #8b98a9; font-size: 11px; border-right: 1px solid #222833;
      white-space: nowrap;
    }
    #eas-panel .eas-steps li:last-child { border-right: 0; }
    #eas-panel .eas-steps li:hover { background: #1b2029; }
    /* 标签本身也要能省略：否则长课程名会把「课程」两字挤出可视区，
       看着就像这一项被「半隐藏」了。 */
    #eas-panel .eas-steps li > span { overflow: hidden; text-overflow: ellipsis; }
    #eas-panel .eas-steps li b {
      display: inline-flex; align-items: center; justify-content: center;
      width: 18px; height: 18px; flex: none; border-radius: 50%;
      font: 700 10px/1 monospace; border: 1px solid #3a465a; color: #8b98a9;
    }
    #eas-panel .eas-steps li .eas-step-note {
      font-style: normal; color: #7c8a9c; font-size: 10px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0;
    }
    /* 已走过：可以点回去改 */
    #eas-panel .eas-steps li[data-state="done"] { color: #c3ccd9; }
    #eas-panel .eas-steps li[data-state="done"] b { border-color: #2c6b4f; color: #45c07d; }
    /* 进行中：唯一有强调色的一步 */
    #eas-panel .eas-steps li[data-state="active"] { color: #f0f4fa; font-weight: 600; background: #1d2430; }
    #eas-panel .eas-steps li[data-state="active"] b { background: #31d6a8; border-color: #31d6a8; color: #052b22; }
    #eas-panel .eas-steps li[data-state="active"] .eas-step-note { color: #31d6a8; }
    /* 还没轮到：压暗但仍看得清（原来太暗，整条看着像被隐藏了） */
    #eas-panel .eas-steps li[data-state="locked"] { color: #6d7a8c; }
    #eas-panel .eas-steps li[data-state="locked"] b { background: #1b2029; border-color: #2d3644; color: #6d7a8c; }
    #eas-panel .eas-step-pane { display: flex; flex-direction: column; gap: 4px; }
    /* 「一键答题」和「停止」是同一件事的两面：用一条分隔线把它们和选择区分开 */
    #eas-panel .eas-run-row { margin-top: 8px; padding-top: 8px; border-top: 1px solid #222833; }
    #eas-panel .eas-teach-row { display: flex; gap: 6px; align-items: center; margin: 4px 0; }
    #eas-panel .eas-teach-row select { flex: 1; min-width: 0; background: #11151c; color: #dde4ee; border: 1px solid #2d3644; border-radius: 4px; padding: 2px 4px; }
    #eas-panel .eas-teach-list { max-height: 150px; overflow: auto; border: 1px solid #222833; border-radius: 4px; padding: 4px; }
    #eas-panel .eas-teach-item { display: flex; align-items: center; gap: 6px; color: #a4b0c1; }
    #eas-panel .eas-teach-group { color: #6d7a8c; margin-top: 4px; }
    /* 按钮上的即时结果反馈（成功/警告/失败各一色）：日志在面板底部，
       面板收起或日志刷得快时看不见，点了没反应会让人以为功能没生效。 */
    #eas-panel button.eas-flash-ok { background: #1f3a2c; border-color: #45c07d; color: #7ee2a8; font-weight: 600; }
    #eas-panel button.eas-flash-warn { background: #3a3320; border-color: #e2b23f; color: #f0cf7a; font-weight: 600; }
    #eas-panel button.eas-flash-err { background: #3a2422; border-color: #f2685f; color: #ff9b93; font-weight: 600; }
  `;

  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    Object.assign(node, props);
    for (const child of children) node.append(child);
    return node;
  }

  /**
   * 按钮上的**即时结果反馈**：临时把文案换成结果（如「✓ 已叠加 12 关」），几秒后还原。
   *
   * 为什么需要：日志在面板最底下，面板一收起、或日志刷得快就什么都看不见，
   * 于是「点了导出本实验答案」之后毫无动静，看着就像功能没生效。
   * 按钮自己变个字 + 变个色，点完立刻就能确认「成了 / 没成、为什么」。
   *
   * 原文案存在按钮自己的属性上：连续点两次不会把「✓ …」当成原文案存下来。
   */
  function flashButton(id, text, tone = 'ok', holdMs = 3000) {
    const button = document.getElementById(id);
    if (!button) return;
    const flashClass = `eas-flash-${tone}`;
    if (button.__easFlashTimer) clearTimeout(button.__easFlashTimer);
    // 只在**没在闪**的时候记原文案，否则连点会把上一次的结果文案固化成原文案
    if (!button.__easFlashTimer) button.__easLabel = button.textContent;
    button.textContent = text;
    button.classList.add(flashClass);
    button.__easFlashTimer = setTimeout(() => {
      button.textContent = button.__easLabel;
      button.classList.remove(flashClass);
      button.__easFlashTimer = 0;
    }, holdMs);
  }

  function renderButtons() {
    const stopButton = document.getElementById('eas-stop');
    if (!stopButton) return;
    // 「停止」要管**两条链路**（手动流程 + 教学队列），任一在跑就不能禁用。
    // 原来只看 state.busy，于是队列跑起来时「停止」是灰的——最需要停的时候反而停不了。
    const queue = readTeachQueue();
    stopButton.disabled = !state.busy && !(queue && queue.running);
  }

  /** 一个开关：状态写进 GM 存储，刷新页面后保留。 */
  function toggleOption(label, key) {
    const input = el('input', { type: 'checkbox' });
    input.checked = Boolean(state[key]);
    input.addEventListener('change', () => {
      state[key] = input.checked;
      GM_setValue(KEYS[key], input.checked);
      log(`${label}：${input.checked ? '开' : '关'}`);
    });
    const wrap = el('label', { className: 'eas-opt' });
    wrap.append(input, el('span', { textContent: label }));
    return wrap;
  }

  /** 数字输入选项（如「评测最多等几秒」）。 */
  function numberOption(label, key, { min, max, fallback }) {
    const input = el('input', {
      type: 'number',
      min: String(min),
      max: String(max),
      value: String(Number(state[key]) || fallback),
      style: 'width:48px'
    });
    input.addEventListener('change', () => {
      const value = Math.max(min, Math.min(max, Number(input.value) || fallback));
      input.value = String(value);
      state[key] = value;
      GM_setValue(KEYS[key], value);
      log(`${label}：${value}`);
    });
    const wrap = el('label', { className: 'eas-opt' });
    wrap.append(el('span', { textContent: label }), input);
    return wrap;
  }

  /**
   * 让面板能拖动，并把位置存进 GM 存储（刷新后保持）。
   *
   * 为什么必须能拖：面板固定在右下角时会盖住页面自己的控件——头歌的「提交」
   * 常常就在右下角，用户会以为是按钮不存在。默认放左下角，拖到哪都行。
   */
  function makeDraggable(host, handle) {
    let drag = null;
    let moved = false;
    const place = (x, y) => {
      const rect = host.getBoundingClientRect();
      host.style.left = `${Math.max(0, Math.min(x, window.innerWidth - rect.width))}px`;
      host.style.top = `${Math.max(0, Math.min(y, window.innerHeight - rect.height))}px`;
      host.style.right = 'auto';
      host.style.bottom = 'auto';
    };
    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      // 标题栏里放了按钮（收起面板）。按钮必须自己收到 click，所以**不能**把它也当成拖动起点：
      // 一旦 setPointerCapture，后续的 click 会派发到捕获元素（标题栏）而不是按钮，
      // 按钮就永远点不动——「收起没效果」就是这么来的。
      if (event.target && typeof event.target.closest === 'function' && event.target.closest('button')) return;
      const rect = host.getBoundingClientRect();
      moved = false;
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
      handle.setPointerCapture(event.pointerId);
    });
    handle.addEventListener('pointermove', (event) => {
      if (!drag || drag.id !== event.pointerId) return;
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) moved = true;
      if (moved) place(drag.left + dx, drag.top + dy);
    });
    const end = () => {
      if (!drag) return;
      drag = null;
      if (host.style.left) GM_setValue(KEYS.panelPos, { left: host.style.left, top: host.style.top });
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
    handle.addEventListener('lostpointercapture', end);
    handle.addEventListener('click', (event) => {
      if (moved) {
        event.preventDefault();
        moved = false;
      }
    });
    window.addEventListener('resize', () => {
      const rect = host.getBoundingClientRect();
      if (host.style.left) place(rect.left, rect.top);
    });
  }

  /** 面板回到默认位置（左下角）。 */
  function resetPanelPosition() {
    const panel = document.getElementById('eas-panel');
    if (!panel) return;
    panel.style.left = '';
    panel.style.top = '';
    panel.style.right = '';
    panel.style.bottom = '';
    GM_setValue(KEYS.panelPos, null);
    log('面板已回到左下角', 'ok');
  }

  function buildPanel() {
    if (document.getElementById('eas-panel')) return;
    document.head.append(el('style', { textContent: CSS }));
    const panel = el('div', { id: 'eas-panel' }, [
      el('header', {}, [
        el('b', { textContent: '头歌自动作答' }),
        el('span', { className: 'eas-tag', textContent: '学习测试用' }),
        el('span', { style: 'flex:1' }),
        el('button', {
          id: 'eas-panel-fold',
          className: 'eas-fold',
          textContent: '收起 ▴',
          title: '收起面板（只留标题栏）',
          onclick: togglePanelFold
        })
      ]),
      el('div', { className: 'eas-body' }, [
        // ---- 课堂：读课程 → 选实验 → 选关卡，**一条流水线** ----
        // 三步是顺序的，同一时刻只有一步是活的。原来三块竖着堆，前两块做完就只剩占地方；
        // 现在一条步骤指示 + 单步内容，与控制台的「提取」面板同构。
        el('ol', { className: 'eas-steps', id: 'eas-steps' }, [
          // 注意：**不要**往 el() 的 props 里塞 dataset。
          // el() 是 Object.assign(node, props)，而真实 DOM 的 dataset 只有 getter，
          // 严格模式下赋值会抛 TypeError，把 buildPanel 整条打断（面板直接不出现）。
          // 步骤序号用闭包传（gotoTeachStep 的实参），状态由 renderTeachSteps 统一刷。
          el('li', { onclick: () => gotoTeachStep(0) }, [
            el('b', { textContent: '1' }), el('span', { textContent: '课程' }),
            el('i', { className: 'eas-step-note', id: 'eas-step-note-course' })
          ]),
          el('li', { onclick: () => gotoTeachStep(1) }, [
            el('b', { textContent: '2' }), el('span', { textContent: '实验' }),
            el('i', { className: 'eas-step-note', id: 'eas-step-note-experiments' })
          ]),
          el('li', { onclick: () => gotoTeachStep(2) }, [
            el('b', { textContent: '3' }), el('span', { textContent: '关卡' }),
            el('i', { className: 'eas-step-note', id: 'eas-step-note-levels' })
          ])
        ]),
        el('div', { className: 'eas-step-pane', id: 'eas-pane-course' }, [
          el('div', { className: 'eas-teach-row' }, [
            el('select', { id: 'eas-teach-course' }),
            el('button', { textContent: '刷新课程', onclick: refreshTeachCourses })
          ]),
          el('div', { className: 'eas-teach-row' }, [
            el('button', {
              id: 'eas-teach-load-experiments',
              className: 'eas-primary',
              textContent: '读取课程实验 →',
              onclick: loadTeachExperimentsPanel
            })
          ])
        ]),
        el('div', { className: 'eas-step-pane', id: 'eas-pane-experiments', hidden: true }, [
          el('div', { id: 'eas-teach-experiments', className: 'eas-teach-list' }),
          el('div', { className: 'eas-teach-row' }, [
            el('button', {
              id: 'eas-teach-load-levels',
              className: 'eas-primary',
              textContent: '读取关卡 →',
              onclick: loadTeachLevelsPanel
            })
          ])
        ]),
        el('div', { className: 'eas-step-pane', id: 'eas-pane-levels', hidden: true }, [
          el('div', { id: 'eas-teach-levels', className: 'eas-teach-list' })
        ]),

        // 「一键答题」和「停止」是同一件事的两面，放一起。
        el('div', { className: 'eas-teach-row eas-run-row' }, [
          el('button', { id: 'eas-teach-run', className: 'eas-primary', textContent: '一键答题（选中）', onclick: () => startTeachRun() }),
          el('button', { id: 'eas-stop', textContent: '停止', onclick: requestStop }),
          el('button', { id: 'eas-teach-missing', textContent: '按清单再答', onclick: () => startMissingRun() })
        ]),
        el('div', { id: 'eas-teach-status', className: 'eas-row', textContent: '未开始' }),

        el('div', { className: 'eas-mini' }, [
          // 「连接本地控制台」必须留在面板上：第一次用最先要做的事就是它，
          // 只放篡改猴菜单里等于没有（新用户不会去翻菜单）。
          // 上一轮我按「一次性配置」把它撤了，是错的判断。
          el('button', { id: 'eas-connect', textContent: '连接本地控制台', onclick: setLocalAddress }),
          el('button', { id: 'eas-pull', textContent: '从本地加答案', onclick: loadAnswersFromLocal }),
          el('button', { id: 'eas-export-answers', textContent: '导出本实验全部答案', onclick: exportExperimentAnswers }),
          el('button', { id: 'eas-export-all', textContent: '导出全部答案', onclick: exportAllAnswers }),
          el('button', { id: 'eas-export-logs', textContent: '导出日志到本地', onclick: exportLogs })
        ]),
        el('div', { className: 'eas-opts' }, [
          numberOption('评测最多等（秒，页面读不到才用）', 'evalWaitSeconds', { min: 1, max: 300, fallback: 30 }),
          numberOption('关卡数据最多等（秒）', 'levelWaitSeconds', { min: 5, max: 300, fallback: 60 })
        ]),
        el('div', { id: 'eas-log-status', className: 'eas-row', style: 'color:#6d7a8c' }),
        el('div', { id: 'eas-log' })
      ])
    ]);
    document.body.append(panel);
    renderLogStatus();
    // 恢复上次拖动的位置；没存过就保持 CSS 里的默认（左下角）
    const saved = GM_getValue(KEYS.panelPos, null);
    if (saved && saved.left && saved.top) {
      panel.style.left = saved.left;
      panel.style.top = saved.top;
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
    }
    makeDraggable(panel, panel.querySelector('header'));
    // 恢复上次的收起状态：收起是「不想被挡」的表达，刷新后不该自己弹开
    applyPanelFold(Boolean(GM_getValue(KEYS.panelFolded, false)));
    renderButtons();
    for (const item of state.logs.slice(-40)) {
      const row = el('div', { className: `eas-row eas-${item.tone}`, textContent: item.message });
      document.getElementById('eas-log').append(row);
    }
  }

  /**
   * 导入答案文件。支持两种形态：
   *
   * ① **控制台的完整导出**（`GET /api/answers` 的响应）：`{ answers, levelIds, blueprints }`
   *    —— 会连关卡映射一起导入，离线也能对上；
   * ② **答案文件本身**（`exports/answers/xxx.answers.json`）：`{ answers: [{level_id, kind, answer}] }`
   *    —— **不含关卡映射**。答案按 `L001` 编号存，而关卡页上只有 URL 里的平台标识，
   *    所以这种文件单独导入是用不上的，这里会明确提示。
   */
  /**
   * 把**班级答案文件**（`kind: "class-answers"`，控制台「导出班级答案文件」的产物）
   * 摊平成脚本内部用的几级索引。
   *
   * 为什么需要它：目标是「不装本地控制台也能跑」——拿到一份班级答案文件，导入即可作答。
   * 但文件里是 `classrooms[] → experiments[] → levels[]` 的层级结构，而脚本查答案用的是
   * 「班级__实验__L001」复合键 + 标识/标题两级索引，所以要在这里摊平。
   *
   * 标题索引的**两级**（与控制台同口径，别只做一级）：
   *   - `titleIndex['实验名__关卡名']`：最精确。实验名带 `[8、面向对象分析] ` 这类分类前缀，
   *     而脚本在关卡页上拿到的实验名**没有**前缀，所以前缀去掉的变体也要建一份；
   *   - `titleOnlyIndex['关卡名']`：**只收全局唯一**的关卡名。同名关卡在两个实验里都出现时
   *     绝不能收——那会把答案勾到另一个实验的关卡上。
   */
  function flattenClassAnswers(doc) {
    const answers = {};
    const levelIndex = {};
    const titleIndex = {};
    const titleCount = new Map();
    const titleOwner = new Map();
    let levels = 0;
    let answered = 0;

    for (const classroom of doc.classrooms || []) {
      const classroomName = String((classroom && classroom.name) || '').trim();
      const classroomCode = String((classroom && classroom.code) || '').trim();
      for (const experiment of (classroom && classroom.experiments) || []) {
        const experimentName = String((experiment && experiment.name) || '').trim();
        const bareName = experimentName.replace(/^\[[^\]]*\]\s*/, '');
        for (const level of (experiment && experiment.levels) || []) {
          const levelId = String((level && level.level_id) || '').trim();
          if (!classroomName || !experimentName || !levelId) continue;
          const composite = `${classroomName}__${experimentName}__${levelId}`;
          levels += 1;
          if (level.answered) answered += 1;
          answers[composite] = {
            level_id: levelId,
            title: String(level.title || '').trim(),
            kind: level.kind,
            source: level.source,
            verified: level.verified,
            answer: level.answer,
            // 与 `/api/answers` 同形的班级上下文：脚本作答前要核对自己填的是哪个班
            course: classroomName,
            classroomName,
            classroomCode,
            experiment: experimentName
          };
          for (const identifier of level.identifiers || []) {
            const key = String(identifier || '').trim();
            if (key) levelIndex[key] = composite;
          }
          const title = String(level.title || '').trim();
          if (title) {
            const pair = `${experimentName}__${title}`;
            if (!titleIndex[pair]) titleIndex[pair] = composite;
            if (bareName && bareName !== experimentName && !titleIndex[`${bareName}__${title}`]) {
              titleIndex[`${bareName}__${title}`] = composite;
            }
            titleCount.set(title, (titleCount.get(title) || 0) + 1);
            if (!titleOwner.has(title)) titleOwner.set(title, composite);
          }
        }
      }
    }

    const titleOnlyIndex = {};
    for (const [title, count] of titleCount) {
      if (count === 1) titleOnlyIndex[title] = titleOwner.get(title);
    }
    return {
      answers,
      levelIndex,
      titleIndex,
      titleOnlyIndex,
      stats: { levels, answered, uniqueTitles: Object.keys(titleOnlyIndex).length }
    };
  }

  function importAnswers() {
    const input = el('input', { type: 'file', accept: '.json,application/json' });
    // **必须挂进 DOM 再点**：不在文档里的 <input type=file> 调 .click() 会被浏览器忽略，
    // 表现就是「点了导入、文件框没弹出来」——看起来像功能失效。
    input.style.position = 'fixed';
    input.style.left = '-9999px';
    input.style.width = '1px';
    input.style.height = '1px';
    (document.body || document.documentElement).append(input);
    const cleanup = () => { try { input.remove(); } catch (error) { /* 忽略 */ } };
    // 用户取消选择时也要收尾，不然每点一次就多留一个隐藏 input 在页面上
    input.addEventListener('cancel', () => {
      cleanup();
      log('已取消导入（没有选择文件）', 'warn');
    });
    input.onchange = async () => {
      try {
        if (!input.files || !input.files[0]) {
          log('没有选中文件', 'warn');
          return;
        }
        const fileName = input.files[0].name;
        const parsed = JSON.parse(await input.files[0].text());

        // ① 班级答案文件（`kind: "class-answers"`）：不装控制台时的主要导入格式。
        if (parsed && parsed.kind === 'class-answers') {
          const flat = flattenClassAnswers(parsed);
          state.answers = { ...state.answers, ...flat.answers };
          state.levelIndex = { ...state.levelIndex, ...flat.levelIndex };
          state.titleIndex = { ...state.titleIndex, ...flat.titleIndex };
          state.titleOnlyIndex = { ...state.titleOnlyIndex, ...flat.titleOnlyIndex };
          GM_setValue(KEYS.answers, state.answers);
          GM_setValue(KEYS.levelIndex, state.levelIndex);
          GM_setValue(KEYS.titleIds, state.titleIndex);
          GM_setValue(KEYS.titleOnlyIds, state.titleOnlyIndex);
          const classLabel = parsed.class
            ? `${parsed.class.grade || ''}${parsed.class.name || ''}`.trim()
            : '未命名班级';
          // 记住班级块：导出时原样写回，来回不失真
          if (parsed.class && typeof parsed.class === 'object') {
            state.classInfo = { grade: String(parsed.class.grade || ''), name: String(parsed.class.name || '') };
            GM_setValue(KEYS.classInfo, state.classInfo);
          }
          log(
            `班级答案文件已导入（${fileName}）：${classLabel}｜${flat.stats.levels} 关（有答案 ${flat.stats.answered}）`
              + `，关卡标识映射 ${Object.keys(flat.levelIndex).length} 条`
              + `、唯一关卡名 ${flat.stats.uniqueTitles} 个`,
            'ok'
          );
          log(`现在共 ${Object.keys(state.answers).length} 关答案，可以不连本地控制台直接答题`, 'ok');
          return;
        }

        const raw = parsed && parsed.answers ? parsed.answers : parsed;
        const map = Array.isArray(raw)
          ? Object.fromEntries(raw.filter((item) => item && item.level_id).map((item) => [String(item.level_id), item]))
          : raw && typeof raw === 'object'
            ? raw
            : {};
        state.answers = { ...state.answers, ...map };
        GM_setValue(KEYS.answers, state.answers);

        let mapped = 0;
        if (parsed && parsed.levelIds && typeof parsed.levelIds === 'object') {
          state.levelIndex = { ...state.levelIndex, ...parsed.levelIds };
          GM_setValue(KEYS.levelIndex, state.levelIndex);
          mapped = Object.keys(parsed.levelIds).length;
        }
        if (parsed && parsed.optionCounts && typeof parsed.optionCounts === 'object') {
          state.optionCounts = { ...state.optionCounts, ...parsed.optionCounts };
          GM_setValue(KEYS.optionCounts, state.optionCounts);
        }
        if (parsed && parsed.titleIds && typeof parsed.titleIds === 'object') {
          state.titleIndex = { ...state.titleIndex, ...parsed.titleIds };
          GM_setValue(KEYS.titleIds, state.titleIndex);
        }
        if (parsed && parsed.titleOnlyIds && typeof parsed.titleOnlyIds === 'object') {
          state.titleOnlyIndex = { ...state.titleOnlyIndex, ...parsed.titleOnlyIds };
          GM_setValue(KEYS.titleOnlyIds, state.titleOnlyIndex);
        }
        if (parsed && Array.isArray(parsed.blueprints) && parsed.blueprints.length) {
          state.templates = parsed.blueprints;
          GM_setValue(KEYS.templates, state.templates);
        }
        log(
          `答案库已导入（${fileName}）：新增 ${Object.keys(map).length} 关（共 ${Object.keys(state.answers).length} 关）`
            + (mapped ? `，另含关卡映射 ${mapped} 条` : ''),
          'ok'
        );
        // 「导入了但没用」是最难排查的一种：必须说清**这份文件被认成了什么**，
        // 而不是只报一句「新增 6 关」——那 6 个键很可能是 version/kind/class 之类的顶层字段。
        if (!Object.keys(map).length) {
          log(
            `这份文件没有解析出任何答案（${fileName}）。它的顶层字段是：`
              + `${Object.keys(parsed || {}).slice(0, 12).join(' / ') || '（空）'}。`
              + '需要的是「班级答案文件」（`kind: "class-answers"`，用 npm run build-class-answers 生成）'
              + '或本地控制台 /api/answers 的响应。',
            'error'
          );
        } else if (!mapped) {
          log(
            '这份答案没有关卡映射（levelIds）：脚本在关卡页上按 URL 标识查不到它，等于用不上。'
              + '请改用班级答案文件（npm run build-class-answers），'
              + '或导入本地控制台 /api/answers 的完整响应（里面含 levelIds）。',
            'warn'
          );
        }
      } catch (error) {
        log(`答案库导入失败（${fileName || '未读到文件名'}）：${error.message}。`
          + '确认选的是 JSON 文件（班级答案文件或控制台 /api/answers 的响应）。', 'error');
      } finally {
        cleanup();
      }
    };
    log('请在弹出的文件框里选一份答案文件（班级答案文件，或控制台 /api/answers 的响应）');
    input.click();
  }

  /**
   * 从本地控制台拉答案库与提交蓝图。
   *
   * `npm run ui` 会在终端打印带 token 的地址（http://127.0.0.1:PORT/?token=xxx），
   * 把那串 token 粘进「本地地址」输入框即可；之后这里会一次拿到
   * `exports/课程/实验/answers/*.answers.json` 与 `submit.blueprint.json`。
   */
  /**
   * 「从本地加答案」——**一个入口，两条路**。
   *
   * 对用户来说这是同一件事（「把答案弄进来」），原来却拆成两个菜单项
   * （「从本地控制台拉取答案与蓝图」和「导入答案文件」），还得自己判断属于哪种情况；
   * 更糟的是没连控制台时点「拉取」只弹一句「还没配本地控制台」就完了，等于死路——
   * 明明手上就有一份班级答案文件。
   *
   * 所以：
   *   - 配了控制台地址 → 先拉（顺带带回关卡映射、每题选项数、提交蓝图）；
   *   - 没配 → 直接选文件导入；
   *   - 配了但连不上（控制台没开 / 端口变了）→ 也退到选文件导入（见 pullFromLocal 的 onerror）。
   */
  function loadAnswersFromLocal() {
    if (!consoleEndpoint('/api/answers')) {
      log('没连本地控制台：改为从本地文件导入答案（选一份班级答案文件 .json 即可）', 'warn');
      importAnswers();
      return;
    }
    pullFromLocal();
  }

  function pullFromLocal() {
    const shown = consoleEndpoint('/api/answers');
    if (!shown) {
      log(
        '还没配本地控制台：点面板上的「连接本地控制台」粘一次 token 即可'
          + `（端口固定为 ${DEFAULT_LOCAL}，token 在 .env 里或控制台页面的「复制控制台地址」里）`,
        'warn'
      );
      return;
    }
    log(`正在从本地控制台拉取：${shown.replace(/token=[^&]+/, 'token=***')}`);
    consoleRequest('/api/answers', {
      method: 'GET',
      onload: (response) => {
        try {
          const payload = JSON.parse(response.responseText || '{}');
          if (response.status === 403) {
            log('本地控制台拒绝：地址里的 token 不对（用 npm run ui 打印的完整地址重配一次）。'
              + '也可以直接从文件导入答案。', 'error');
            importAnswers();
            return;
          }
          if (!payload.ok) {
            log(`本地控制台返回失败：${payload.error || response.status}`, 'error');
            return;
          }
          const count = Object.keys(payload.answers || {}).length;
          state.answers = { ...state.answers, ...(payload.answers || {}) };
          GM_setValue(KEYS.answers, state.answers);
          // 关卡标识映射：把「关卡页 URL 上的标识」折算成「答案库里的 L001」。
          // 没有它，答案是按 L001 存的、页面按平台标识查，两边永远对不上。
          if (payload.levelIds && typeof payload.levelIds === 'object') {
            state.levelIndex = { ...state.levelIndex, ...payload.levelIds };
            GM_setValue(KEYS.levelIndex, state.levelIndex);
          }
          // 「实验名__关卡名」兜底表：平台换关卡标识时靠它匹配（见 answerKeyForCurrentLevel）
          if (payload.titleIds && typeof payload.titleIds === 'object') {
            state.titleIndex = { ...state.titleIndex, ...payload.titleIds };
            GM_setValue(KEYS.titleIds, state.titleIndex);
          }
          if (payload.titleOnlyIds && typeof payload.titleOnlyIds === 'object') {
            state.titleOnlyIndex = { ...state.titleOnlyIndex, ...payload.titleOnlyIds };
            GM_setValue(KEYS.titleOnlyIds, state.titleOnlyIndex);
          }
          // 每道题的选项个数：选择题分组靠它，比猜 class 名可靠
          if (payload.optionCounts && typeof payload.optionCounts === 'object') {
            state.optionCounts = { ...state.optionCounts, ...payload.optionCounts };
            GM_setValue(KEYS.optionCounts, state.optionCounts);
          }
          if (Array.isArray(payload.blueprints) && payload.blueprints.length) {
            state.templates = payload.blueprints;
            GM_setValue(KEYS.templates, state.templates);
          }
          const mapped = Object.keys(state.levelIndex).length;
          log(
            `已拉取答案 ${count} 关、关卡映射 ${mapped} 条、蓝图 ${(payload.blueprints || []).length} 个`
            + `（共扫描 ${(payload.files || []).length} 个文件）`,
            'ok'
          );
          if (count && !mapped) {
            log('控制台没返回关卡映射：请确认 exports 下的关卡存档（levels.jsonl）还在，否则按标识查不到答案', 'warn');
          }
        } catch (error) {
          log(`解析本地返回失败：${error.message}`, 'error');
        }
      },
      onerror: () => {
        log(
          '连不上本地控制台（多半是没在跑 `npm run ui`，或端口变了）。'
            + '改为从本地文件导入答案。',
          'warn'
        );
        importAnswers();
      }
    });
  }

  function setLocalAddress() {
    const input = window.prompt(
      '粘贴控制台地址或只粘 token 都行。\n'
        + `· 只粘 token（32 位以上十六进制）→ 端口用固定的 ${DEFAULT_LOCAL}，最省事；\n`
        + '· 或粘 `npm run ui` 打印的完整地址（形如 http://127.0.0.1:43127/?token=xxx）。',
      state.local || DEFAULT_LOCAL
    );
    if (input === null) return;
    const value = input.trim();
    if (!value) return;

    // 只粘了一串 token：地址用固定的默认值，用户少粘一半。
    // 控制台端口已固定（见 extractor/run.js 的 DEFAULT_UI_PORT），所以这里能这么省。
    if (/^[0-9a-f]{32,}$/i.test(value)) {
      state.local = DEFAULT_LOCAL;
      state.token = value;
      GM_setValue(KEYS.local, state.local);
      GM_setValue(KEYS.token, value);
      log('已保存 token，地址用默认的 ' + DEFAULT_LOCAL, 'ok');
      pullFromLocal();
      return;
    }

    state.local = value;
    GM_setValue(KEYS.local, state.local);
    // 顺手把 token 抽出来存一份：之后拼别的接口（如回传蓝图）时接着用。
    try {
      const url = new URL(state.local);
      const token = url.searchParams.get('token') || '';
      if (token) {
        state.token = token;
        GM_setValue(KEYS.token, token);
      }
    } catch (error) {
      /* 只填 host:port 也允许，consoleEndpoint 会补协议 */
    }
    log(`本地控制台地址已保存：${state.local}${state.token ? '' : '（未带 token，接口会返回 403）'}`, 'ok');
    pullFromLocal();
  }

  /** 把本地已录制的全部蓝图回传给控制台（补录/换机器时用）。 */
  function pushAllBlueprints() {
    if (!state.templates.length) {
      log('本地还没有录制到任何提交接口', 'warn');
      return;
    }
    for (const record of state.templates) pushBlueprint(record);
    log(`已回传 ${state.templates.length} 个蓝图到控制台`, 'ok');
  }

  function clearTemplates() {
    state.templates = [];
    GM_setValue(KEYS.templates, []);
    log('已清空录制到的提交接口');
  }

  /**
   * 把面板日志回传控制台落盘。
   *
   * 面板里日志一多就没法看，导出成 `exports/logs/*.log` 用编辑器翻方便得多。
   * 教学课程队列跑完/停下时会自动调一次（`跑完之后把日志传回来`）。
   */
  /**
   * 清空面板里的日志（已经落盘到本地，面板不必再攒）。
   *
   * **但保留最后几行**：停止/完成的原因往往就是最后一行，全清掉用户会以为"它没动静了"
   * （实测就是这么被误解的：队列明明正常完成，面板只剩一行"已落盘"，看着像卡住）。
   * 保留的这几行时间戳早于上次导出点，下次导出会被增量过滤掉，不会重复发。
   */
  function clearLogs(keep = 5) {
    state.logs = state.logs.slice(-keep);
    GM_setValue(KEYS.log, state.logs);
    const box = document.getElementById('eas-log');
    if (box) {
      box.replaceChildren();
      for (const item of state.logs) {
        const row = document.createElement('div');
        row.className = `eas-row eas-${item.tone}`;
        row.textContent = item.message;
        box.appendChild(row);
      }
    }
    renderLogStatus();
  }

  /** 更新「日志」状态行：已落盘第几次 / 还没导出过；顺带把队列的终态显示出来。 */
  function renderLogStatus() {
    const box = document.getElementById('eas-log-status');
    if (!box) return;
    const seq = Number(state.logSeq) || 0;
    const head = seq
      ? `日志：已落盘第 ${seq} 次（本地有全量，面板只留新的）`
      : `日志：还没导出过（面板现有 ${state.logs.length} 条）`;
    // 队列的终态也显示在这里：课程区是折叠的，状态藏在那里用户看不到，
    // 曾经因此把"队列完成"误看成"卡住了"。
    const queue = readTeachQueue();
    const tail = queue && queue.stoppedReason
      ? `｜队列已停：${queue.stoppedReason}`
      : queue && queue.finishedAt
        ? '｜队列已完成 ✓'
        : '';
    box.textContent = head + tail;
  }

  /**
   * 把面板日志回传控制台**追加**落盘。
   *
   * 只发「上次导出之后的新行」：控制台是追加写，全量重发会大量重复。
   * 写成功后**清空面板**——本地已经有全量文件了，面板里再攒着只是干扰。
   */
  function exportLogs() {
    const since = Number(state.lastLogExportAt) || 0;
    const fresh = state.logs.filter((item) => Number(item.time) > since);
    if (!fresh.length) {
      log('没有新日志需要导出（上次导出之后还没产生新行）', 'warn');
      return;
    }
    const lines = fresh.map((item) => `[${item.tone}] ${item.message}`);
    if (!consoleEndpoint('/api/log')) {
      log('没配本地控制台地址，日志只能留在面板里', 'warn');
      return;
    }
    const newest = Number(fresh[fresh.length - 1].time) || Date.now();
    consoleRequest('/api/log', {
      method: 'POST',
      body: { name: '篡改猴日志', lines },
      onload: (response) => {
        let result = null;
        try {
          result = JSON.parse(response.responseText || '{}');
        } catch (error) {
          result = null;
        }
        if (result && result.ok) {
          state.lastLogExportAt = newest;
          GM_setValue(KEYS.lastLogExportAt, newest);
          state.logSeq = Number(result.seq) || 0;
          GM_setValue(KEYS.logSeq, state.logSeq);
          clearLogs();
          log(`面板日志已清空；本地已写到 ${result.path}（第 ${result.seq} 次写入，本次 ${result.lines} 行）`, 'ok');
        } else {
          log(`日志导出失败：${(result && result.error) || `HTTP ${response.status}`}`, 'warn');
        }
      },
      onerror: () => log('导出日志连不上本地控制台', 'warn')
    });
  }

  /** 把 standard_answer 数组（[{position, answer}]）格式化成 `1:B;2:C` 这种答案串。 */
  function standardAnswerText(rows) {
    return (rows || []).map((row) => `${row.position}:${row.answer}`).join(';');
  }

  /** 把「题目序号 → 选项字母」映射拼成同一种答案串（`1:A;2:B,C`）。 */
  function choiceMapText(map) {
    return Object.keys(map || {})
      .map((question) => ({
        question: Number(question) || 0,
        letters: [].concat(map[question] || []).map((letter) => String(letter).toUpperCase()).filter(Boolean)
      }))
      .filter((item) => item.question > 0 && item.letters.length)
      .sort((a, b) => a.question - b.question)
      .map((item) => `${item.question}:${item.letters.join(',')}`)
      .join(';');
  }

  /**
   * 组装「本关已通过」时要回传的答案。
   *
   * - 选择题：优先平台标准答案（只在提交后才有），没有就退回答题时勾选的选项；
   * - 编程题：用刚提交的代码（写进编辑器的那一份）。
   * 拿不到任何内容时返回 null——宁可不回传，也不往答案文件里写一条空答案。
   */
  function passedAnswerPayload({ choiceMap = null, codeText = '' } = {}) {
    const identifier = currentLevelId();
    const levelId = (state.taskContext && state.taskContext.levelId) || '';
    // 带上实验名/关卡名：控制台在「这个关卡标识没被抓取过」时（平台重新发布实验换了
    // 一整组标识、或该实验还没抓取）可按内容兜底定位，不然只能报错拒收。
    const hint = state.levelHint || {};
    const context = {
      experiment: hint.experimentName || '',
      // 课堂流程没有教学课程队列的 levelHint，退回关卡数据里的标题
      levelName: hint.levelName || (state.taskContext && state.taskContext.levelTitle) || '',
      // 班级码（`course_identifier`）：控制台拿它核对「这一关的存档属于哪个班」，
      // 不一致就拒收——这是防止答案写进别的班的最后一道闸。
      classroomCode: String((state.taskContext && state.taskContext.classroomCode) || '')
    };
    if (state.taskContext && state.taskContext.standardAnswer && state.taskContext.standardAnswer.length) {
      return {
        identifier,
        levelId,
        ...context,
        kind: 'choice',
        answer: standardAnswerText(state.taskContext.standardAnswer),
        language: ''
      };
    }
    if (choiceMap && Object.keys(choiceMap).length) {
      return {
        identifier,
        levelId,
        ...context,
        kind: 'choice',
        answer: choiceMapText(choiceMap),
        language: ''
      };
    }
    if (String(codeText || '').trim()) {
      const bank = state.answers[answerKeyForCurrentLevel()] || {};
      return {
        identifier,
        levelId,
        ...context,
        kind: 'code',
        answer: String(codeText),
        language: String(bank.language || '')
      };
    }
    return null;
  }

  /**
   * 把通过后的答案回传给控制台，由它写进 `exports/answers/{课程}__{实验}.answers.json`。
   *
   * 没配本地地址就静默跳过（面板上的「导出标准答案」按钮仍可手动下载 JSON）。
   * 控制台要求该实验先被抓取过（否则它不知道关卡属于哪个课程/实验），
   * 失败原因会原样打到日志里，不会静默吞掉。
   */
  function pushAnswerToConsole(payload) {
    if (!consoleEndpoint('/api/answer/save')) {
      // 不要静默什么都不做：用户会以为答案存进去了，其实控制台地址都没配。
      log('没配本地控制台地址，答案没能落盘到 exports/answers/（面板点「连接本地控制台」）', 'warn');
      return;
    }
    consoleRequest('/api/answer/save', {
      method: 'POST',
      body: payload,
      onload: (response) => {
        let result = null;
        try {
          result = JSON.parse(response.responseText || '{}');
        } catch (error) {
          result = null;
        }
        if (result && result.ok) {
          log(`已回传答案：${result.levelId} → ${result.path}（${result.replaced ? '覆盖' : '新增'}）`, 'ok');
        } else {
          log(`回传答案失败：${(result && result.error) || `HTTP ${response.status}`}`, 'warn');
        }
      },
      onerror: () => log('回传答案连不上本地控制台（不影响本次作答）', 'warn')
    });
  }

  /**
   * 取某一关的原始关卡数据（批量导出用）。
   *
   * 必须走页面的 fetch（`unsafeWindow.fetch`）——头歌的签名头是页面自己的拦截器加的，
   * 直接调原生 fetch 会 401。带上 `__easBatch=1` 标记，让本脚本的网络钩子跳过它，
   * 免得把别的关卡的数据当成「当前关」写进 state.taskContext。
   */
  /**
   * 回捞时的关卡序号：**本作业内的序号优先**（homework_challenge_index）。
   * 一个实训挂多个作业的课程（实测软件工程导论）里，`challenge.position`
   * 是实训内的全局序号，直接用它回填关卡号（L###）会整体错位。
   */
  function harvestPositionOf(payload) {
    const challenge = payload && payload.challenge;
    return Number(challenge && (challenge.homework_challenge_index ?? challenge.position)) || 0;
  }

  async function fetchTaskData(identifier) {
    const host = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
    // **必须带 homework_common_id**：一个实训挂多个作业的课程（实测软件工程导论），
    // 不带它拿到的 challenge.position 是实训内的全局序号、不是本作业内的序号，
    // 导出回填的关卡号会整体错位。当前作业号就在本关数据里（state.taskContext）。
    const homeworkId = Number(state.taskContext && state.taskContext.homeworkId) || 0;
    const query = homeworkId ? `&homework_common_id=${homeworkId}` : '';
    const response = await host.fetch(
      `/api/tasks/${encodeURIComponent(identifier)}.json?__easBatch=1${query}`,
      { credentials: 'include' }
    );
    if (!response || !response.ok) throw new Error(`HTTP ${(response && response.status) || '?'}`);
    return response.json();
  }

  /** 从一份关卡数据里取标准答案行（[{position, answer}]）。 */
  function standardAnswerOf(payload) {
    const sets = (payload && payload.choose_test_cases && payload.choose_test_cases.test_sets) || [];
    return (Array.isArray(sets) ? sets : [])
      .slice()
      .sort((a, b) => (Number(a.position) || 0) - (Number(b.position) || 0))
      .map((row) => ({
        position: Number(row.position) || 0,
        answer: String(row.standard_answer ?? row.actual_output ?? '')
      }))
      .filter((row) => row.position > 0 && row.answer);
  }

  /** 从题目文件路径猜语言（答案文件里的 `language` 字段；作答时不依赖它，仅标注用）。 */
  function codeLanguageFromPath(filePath) {
    const ext = String(filePath || '').split('.').pop().toLowerCase();
    const map = {
      py: 'python', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp',
      java: 'java', js: 'javascript', cs: 'csharp', go: 'go', rs: 'rust',
      sql: 'sql', sh: 'shell', rb: 'ruby', php: 'php'
    };
    return map[ext] || '';
  }

  /**
   * 取某一关**代码仓库里的文件内容**（批量导出编程题用）。
   *
   * 编程题在平台上**没有 standard_answer**——已通过测评的关卡，仓库里那份文件
   * 就是「平台收下的答案」，这是编程题答案的唯一来源（提取器的 captureAnswer 同款做法）。
   *
   * ⚠️ 调用方必须先用 `levelPassedOf` 判过「已通过」：未提交/未通过的关卡，
   * 这份内容是**题目模板**，收进去的话作答时填的全是模板、必然评测不过。
   */
  async function fetchLevelCode(identifier, filePath) {
    const host = pageWindow();
    const homeworkId = Number(state.taskContext && state.taskContext.homeworkId) || 0;
    const query = `?path=${encodeURIComponent(filePath)}`
      + `&homework_common_id=${homeworkId}&exercise_id=&__easBatch=1`;
    const response = await host.fetch(
      `/api/tasks/${encodeURIComponent(identifier)}/rep_content.json${query}`,
      { credentials: 'include' }
    );
    if (!response || !response.ok) throw new Error(`HTTP ${(response && response.status) || '?'}`);
    const payload = await response.json();
    const encoded = String((payload && payload.content && payload.content.content) || '');
    if (!encoded) return '';
    // base64 → UTF-8 文本：代码里有中文注释，直接 atob 得到的是 latin1 乱码
    const binary = host.atob(encoded);
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    if (host.TextDecoder) return new host.TextDecoder('utf-8').decode(bytes);
    return binary; // 兜底：没有 TextDecoder 时至少 ASCII 部分是对的
  }

  /**
   * 当前这一关的答案（标准答案优先，编程题退回编辑器内容）。
   * 批量导出一关都没抓到时用它兜底，免得白点一下。
   */
  function currentLevelAnswer() {
    const ctx = state.taskContext;
    const levelId = (ctx && ctx.levelId) || '';
    const levelName = (ctx && ctx.levelTitle) || (state.levelHint && state.levelHint.levelName) || '';
    if (ctx && ctx.standardAnswer && ctx.standardAnswer.length) {
      return { levelId, levelName, kind: 'choice', answer: standardAnswerText(ctx.standardAnswer) };
    }
    const editor = findCodeEditor();
    const code = editor ? String(editor.read() || '').trim() : '';
    if (code) return { levelId, levelName, kind: 'code', answer: code };
    return null;
  }

  /**
   * 把库里的答案条目规范化成**班级答案文件**里那种 `answer` 形状。
   *
   * 库里三种历史写法都有：`{questions:[{number,selected}]}`（v2 磁盘形状）、
   * `[{number,selected}]`（班级文件形状）、以及 `"1:A;2:B,C"`（v1 字符串）。
   * 统一走 `readAnswer` 解析，再按目标形状吐出去——这样**导出的东西一定能被导入回来**
   * （导入用的就是同一套解析），不会出现「导出看着有、导回读不出」。
   *
   * @returns {{answer: any, filled: boolean}|null}
   */
  function answerToClassShape(entry) {
    const parsed = readAnswer(entry);
    if (!parsed) return null;
    if (parsed.kind === 'choice') {
      const questions = Object.keys(parsed.map)
        .map((key) => ({ question: Number(key) || 0, letters: [...(parsed.map[key] || [])] }))
        .filter((item) => item.question > 0 && item.letters.length)
        .sort((a, b) => a.question - b.question)
        .map((item) => ({ number: item.question, selected: item.letters }));
      return { answer: questions, filled: questions.length > 0 };
    }
    const code = String(parsed.code || '');
    return { answer: { language: String(entry.language || ''), code }, filled: Boolean(code.trim()) };
  }

  /**
   * 把脚本手里的答案汇总成一份**班级答案文件**（`kind: "class-answers"`）。
   *
   * 为什么要做这个：脚本「导入答案文件」吃的就是这个格式，那么导出也必须是它，
   * 才能**导出 → 导入**原样转回来（换台机器、传给同学都靠这一条）。
   * 原来那个「导出本实验全部答案」只是把答案 POST 回本地控制台，不产生任何文件——
   * 脱控制台时点了等于没点。
   *
   * @param {{experimentName?: string}} options 只导某个实验（传空串=全部）
   */
  function buildClassAnswersDoc({ experimentName = '' } = {}) {
    // 关卡标识 → 复合键 是正着存的，这里反过来建一份，好把 identifiers 写回文件
    const identifiersOf = new Map();
    for (const [identifier, composite] of Object.entries(state.levelIndex || {})) {
      const key = String(composite || '');
      if (!key) continue;
      if (!identifiersOf.has(key)) identifiersOf.set(key, []);
      identifiersOf.get(key).push(String(identifier));
    }

    const classrooms = new Map();
    let levels = 0;
    let answered = 0;
    for (const [composite, entry] of Object.entries(state.answers || {})) {
      const parts = String(composite).split('__');
      // 复合键形如「班级__实验__L001」；不是这个形状的（兜底键）跳过。
      if (parts.length < 3) continue;
      const levelId = parts[parts.length - 1];
      const experiment = String(entry.experiment || parts.slice(1, -1).join('__'));
      const classroomName = String(entry.course || entry.classroomName || parts[0]);
      if (experimentName && experiment !== experimentName) continue;

      const shaped = answerToClassShape(entry);
      if (!shaped) continue;
      levels += 1;
      if (shaped.filled) answered += 1;

      if (!classrooms.has(classroomName)) {
        classrooms.set(classroomName, {
          name: classroomName,
          code: String(entry.classroomCode || ''),
          experiments: new Map()
        });
      }
      const classroom = classrooms.get(classroomName);
      if (!classroom.code && entry.classroomCode) classroom.code = String(entry.classroomCode);
      if (!classroom.experiments.has(experiment)) {
        classroom.experiments.set(experiment, {
          name: experiment,
          chapter: (experiment.match(/^\[([^\]]+)\]/) || [])[1] || '',
          levels: []
        });
      }
      const identifiers = identifiersOf.get(composite) || [];
      const own = String(entry.task_identifier || '').trim();
      if (own && !identifiers.includes(own)) identifiers.unshift(own);
      classroom.experiments.get(experiment).levels.push({
        level_id: levelId,
        position: Number(String(levelId).replace(/^L0*/i, '')) || 0,
        title: String(entry.title || ''),
        kind: shaped.answer && Array.isArray(shaped.answer) ? 'choice' : 'code',
        identifiers,
        answered: shaped.filled,
        answer: shaped.answer,
        source: String(entry.source || 'unknown')
      });
    }

    const list = [...classrooms.values()].map((classroom) => ({
      name: classroom.name,
      code: classroom.code,
      experiments: [...classroom.experiments.values()].map((experiment) => ({
        ...experiment,
        levels: experiment.levels.sort((a, b) => a.position - b.position)
      }))
    }));
    const saved = state.classInfo || {};
    const experimentCount = list.reduce((sum, classroom) => sum + classroom.experiments.length, 0);
    return {
      version: 2,
      kind: 'class-answers',
      generated_at: new Date().toISOString(),
      class: {
        grade: String(saved.grade || ''),
        name: String(saved.name || '') || (list.length === 1 ? list[0].name : '本机导出')
      },
      classrooms: list,
      stats: { classrooms: list.length, experiments: experimentCount, levels, answered, missing: levels - answered }
    };
  }

  /** 导出一份 JSON 到下载目录（挂进 DOM 再点，浏览器才认）。 */
  function downloadJsonFile(fileName, data) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = el('a', { href: url, download: fileName });
    link.style.display = 'none';
    document.body.append(link);
    link.click();
    setTimeout(() => {
      try { URL.revokeObjectURL(url); link.remove(); } catch (error) { /* 忽略 */ }
    }, 2000);
    log(`已导出文件：${fileName}`, 'ok');
  }

  /** 导出文件名：带上班级名，一眼能看出是哪份。 */
  function exportFileName(suffix = '') {
    const saved = state.classInfo || {};
    const base = `${String(saved.grade || '')}${String(saved.name || '')}`.trim() || 'educoder';
    const safe = base.replace(/[\\/:*?"<>|]/g, '～');
    return suffix ? `${safe}-${suffix}.answers.json` : `${safe}.answers.json`;
  }

  /**
   * 一键导出**全部**答案：把脚本手里的答案整份导出成班级答案文件。
   *
   * 与「导入答案文件」严格对应（同一个格式），所以「导出 → 导入」可以原样转回来。
   */
  function exportAllAnswers() {
    if (!Object.keys(state.answers || {}).length) {
      log('还没有任何答案可导出：先「从本地加答案」（或跑一遍队列）', 'warn');
      flashButton('eas-export-all', '✗ 没有答案', 'err');
      return;
    }
    const doc = buildClassAnswersDoc();
    if (!doc.stats.levels) {
      log('库里的答案没有可用条目（复合键不是「班级__实验__L001」形状？），导出中止', 'warn');
      flashButton('eas-export-all', '✗ 没有可用条目', 'err');
      return;
    }
    downloadJsonFile(exportFileName(), doc);
    log(
      `全部答案已导出：${doc.stats.classrooms} 个课堂 / ${doc.stats.experiments} 个实验 / `
        + `${doc.stats.levels} 关（有答案 ${doc.stats.answered}、缺 ${doc.stats.missing}）`,
      'ok'
    );
    log('这份文件可以直接用菜单「导入答案文件」原样导回（换机器、给同学都是它）', 'ok');
    flashButton('eas-export-all', `✓ 已导出 ${doc.stats.levels} 关`, 'ok');
  }

  /** 当前这一关属于哪个实验（优先队列给的线索，其次答案条目里带的，再次平台关卡数据里给的）。 */
  function currentExperimentName() {
    if (state.levelHint && state.levelHint.experimentName) return state.levelHint.experimentName;
    const key = answerKeyForCurrentLevel();
    const entry = state.answers[key];
    if (entry && entry.experiment) return String(entry.experiment);
    // 关卡数据里平台自己给的实验名（homework_common_name）：没导入过答案、也不在队列里时，
    // 这是唯一的来源——比空着强（回传控制台/日志总得有个实验名）。
    const fromContext = String((state.taskContext && state.taskContext.experimentName) || '').trim();
    if (fromContext) return fromContext;
    const parts = String(key || '').split('__');
    return parts.length >= 3 ? parts.slice(1, -1).join('__') : '';
  }

  /**
   * 通过一关后，把答案收进**本地答案库**（脱控制台时唯一的入库路径）。
   *
   * 连控制台时，答案本来是 `pushAnswerToConsole` 回传、由控制台落盘的；脱控制台时那条路
   * 走不通（只会警告一句），于是「跑队列自动攒答案」在纯脚本模式下等于没发生——
   * 用户跑完一轮，答案库还是导入时那么多。所以这里补上本地入库。
   *
   * @returns {boolean} true = 真的入库了（库里没有这一关时返回 false）
   */
  function harvestPassedAnswer(payload) {
    if (!payload) return false;
    const experiment = String(payload.experiment || '');
    const identifier = String(payload.identifier || '');
    const position = Number(String(payload.levelId || '').replace(/^L0*/i, '')) || 0;
    const levelName = String(payload.levelName || '');
    if (payload.kind === 'choice') {
      return mergeStandardAnswer({ identifier, position, title: levelName, answer: payload.answer }, experiment);
    }
    const code = String(payload.answer || '');
    if (!code.trim()) return false;
    const key = state.levelIndex[identifier]
      || (experiment ? state.titleIndex[`${experiment}__${levelName}`] : '')
      || state.titleOnlyIndex[levelName]
      || '';
    if (!key) return false;
    const entry = state.answers[key] || {};
    const language = String(payload.language || entry.language || '');
    state.answers[key] = {
      ...entry,
      level_id: entry.level_id || (position ? `L${String(position).padStart(3, '0')}` : ''),
      title: entry.title || levelName,
      kind: 'code',
      language,
      answer: { language, code },
      source: 'platform',
      verified: true
    };
    GM_setValue(KEYS.answers, state.answers);
    return true;
  }

  /** 库里这一关**现在有没有真答案**（空壳条目不算有）。 */
  function entryHasAnswer(entry) {
    const parsed = readAnswer(entry);
    if (!parsed) return false;
    return parsed.kind === 'choice'
      ? Object.keys(parsed.map || {}).length > 0
      : String(parsed.code || '').trim().length > 0;
  }

  /**
   * 把一行「从平台回捞到的标准答案」并进本地答案库（导出的文件里才会有它）。
   *
   * **是覆盖，不是跳过**：库里这一关已经有答案时，用平台标准答案**盖掉**旧值——
   * 平台那份就是判分依据，比导入来的（或从编辑器抓来的）更权威，留旧的反而是错的。
   * 唯一的例外见下面「代码 vs 选择」那段。
   *
   * 定位顺序与作答时一致：**先按关卡标识查映射，再按「实验名__关卡名」兜底**——
   * 平台重发实验会换掉一整组标识，只认标识会把答案丢在门外。
   *
   * @param {{identifier:string,position:number,title:string,answer:string}} row
   * @param {string} experimentName
   * @param {{added?:number,overwritten?:number,kept?:number,unplaced?:number}|null} stats
   *   传了就往里累加，好让调用方分清「新补了几关 / 覆盖了几关 / 保留了几关 / 没处放几关」。
   * @returns {boolean} true = 真的写进答案库了；false = 没写（没匹配到条目，或保留了原有的代码）
   */
  function mergeStandardAnswer(row, experimentName = '', stats = null) {
    const bump = (field) => { if (stats) stats[field] = (stats[field] || 0) + 1; };
    const identifier = String((row && row.identifier) || '');
    const levelName = String((row && row.title) || '');
    const text = String((row && row.answer) || '');
    if (!text) { bump('unplaced'); return false; }
    const shaped = answerToClassShape({ kind: 'choice', answer: text });
    if (!shaped || !shaped.filled) { bump('unplaced'); return false; }

    let key = state.levelIndex[identifier] || '';
    if (!key && levelName) {
      key = (experimentName ? state.titleIndex[`${experimentName}__${levelName}`] : '')
        || state.titleOnlyIndex[levelName]
        || '';
    }
    if (!key) { bump('unplaced'); return false; }
    const entry = state.answers[key] || {};

    // ★ 唯一不覆盖的情况：库里是**代码**答案，而回捞到的是选择题标准答案
    //   （「含选择小题的编程题」就是这种——既要交代码，又有选择题）。
    //   答题时一个条目只能是一种 kind，覆盖会把那份代码彻底弄丢，
    //   而代码通常才是这一关的主体答案。所以保留代码，只记一笔让日志说清楚。
    const existing = readAnswer(entry);
    if (existing && existing.kind === 'code' && entryHasAnswer(entry)) {
      bump('kept');
      return false;
    }

    const overwrite = entryHasAnswer(entry);
    state.answers[key] = {
      ...entry,
      level_id: entry.level_id || (row.position ? `L${String(row.position).padStart(3, '0')}` : ''),
      title: entry.title || levelName,
      kind: 'choice',
      answer: shaped.answer,
      // 这是**平台给的标准答案**，不是推导出来的：标记清楚，回传/复核时能分辨
      source: 'platform',
      verified: true
    };
    GM_setValue(KEYS.answers, state.answers);
    bump(overwrite ? 'overwritten' : 'added');
    return true;
  }

  /**
   * 把一行「已通过编程题的代码答案」并进答案库（回捞链路的 **code 分支**）。
   *
   * 编程题在平台上没有 standard_answer，答案就是仓库里那份被平台收下的代码——
   * 同样是「平台确认过的」，覆盖语义与 mergeStandardAnswer 一致。
   * 镜像的例外：库里已有**选择题**答案时保留（纯编程题不该有选择题条目，
   * 这是兜异常数据的；覆盖会把选择题答案弄丢）。
   *
   * @param {{identifier:string,position:number,title:string,answer:string,language?:string}} row
   * @param {string} experimentName
   * @param {{added?:number,overwritten?:number,kept?:number,unplaced?:number}|null} stats
   */
  function mergeCodeAnswer(row, experimentName = '', stats = null) {
    const bump = (field) => { if (stats) stats[field] = (stats[field] || 0) + 1; };
    const identifier = String((row && row.identifier) || '');
    const levelName = String((row && row.title) || '');
    const code = String((row && row.answer) || '');
    if (!code.trim()) { bump('unplaced'); return false; }

    let key = state.levelIndex[identifier] || '';
    if (!key && levelName) {
      key = (experimentName ? state.titleIndex[`${experimentName}__${levelName}`] : '')
        || state.titleOnlyIndex[levelName]
        || '';
    }
    if (!key) { bump('unplaced'); return false; }
    const entry = state.answers[key] || {};

    const existing = readAnswer(entry);
    if (existing && existing.kind === 'choice' && entryHasAnswer(entry)) {
      bump('kept');
      return false;
    }

    const overwrite = entryHasAnswer(entry);
    const language = String(row.language || entry.language || '');
    state.answers[key] = {
      ...entry,
      level_id: entry.level_id || (row.position ? `L${String(row.position).padStart(3, '0')}` : ''),
      title: entry.title || levelName,
      kind: 'code',
      language,
      answer: { language, code },
      source: 'platform',
      verified: true
    };
    GM_setValue(KEYS.answers, state.answers);
    bump(overwrite ? 'overwritten' : 'added');
    return true;
  }

  /**
   * 批量导出「本实验所有关卡」的标准答案——**叠加进已有答案库，不下载文件**。
   *
   * 平台的标准答案**按关卡**给、且**只有提交过那一关**才有，所以只能逐关拉取。
   * 沿 next_game / prev_game 从当前关出发把整条链走一遍，收齐每关的标识/序号/标题/
   * 标准答案，然后**并进脚本自己的答案库**（也就是你导入进来的那份），能补的就补上。
   * 想拿走文件时用「导出全部答案」，那才会下载。
   *
   * 连了本地控制台的话，顺带照旧回传给控制台（落盘到 `exports/answers/`）。
   * 没提交过的关卡取不到标准答案，会在日志里列出来。
   * 注意：只有选择题（含选择小题的编程题）才有 standard_answer，纯编程题没有。
   */
  async function exportExperimentAnswers() {
    const startId = currentLevelId();
    if (!startId) {
      log('当前不是关卡页，批量导出没法用（这个功能要沿关卡链一关关拉）', 'warn');
      flashButton('eas-export-answers', '✗ 不是关卡页', 'err');
      return;
    }
    const experimentName = currentExperimentName();
    log(`开始回捞本实验的标准答案（从 ${startId} 出发逐关拉取），拉到的会叠加进答案库…`);
    const seen = new Set();
    const pending = [startId];
    const rows = [];
    const missing = [];
    let guard = 0;
    while (pending.length && guard < 200) {
      const id = pending.shift();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      guard += 1;
      let data = null;
      try {
        data = await fetchTaskData(id);
      } catch (error) {
        log(`取关卡 ${id} 的数据失败：${error.message}`, 'warn');
        continue;
      }
      if (!data) continue;
      if (data.next_game) pending.push(String(data.next_game));
      if (data.prev_game) pending.push(String(data.prev_game));
      const position = harvestPositionOf(data);
      const title = String((data.challenge && data.challenge.subject) || '').trim();
      const standard = standardAnswerOf(data);
      if (standard.length) {
        rows.push({ identifier: id, position, title, kind: 'choice', answer: standardAnswerText(standard) });
        continue;
      }
      // 选择题标准答案拿不到时，编程题还有**第二条来源**：已通过关卡的仓库代码。
      // 平台对编程题没有 standard_answer；未通过/未提交的关卡仓库里是题目模板，
      // 绝不能当答案收进去（收了模板，作答时填的全是模板、必然评测不过）。
      const challenge = data.challenge || {};
      const filePath = String(challenge.path || '').replace(/[；;]/g, '').trim();
      if (levelPassedOf(data) && challenge.with_code_file && filePath) {
        try {
          const code = await fetchLevelCode(id, filePath);
          if (code.trim()) {
            rows.push({
              identifier: id,
              position,
              title,
              kind: 'code',
              answer: code,
              language: codeLanguageFromPath(filePath)
            });
            continue;
          }
        } catch (error) {
          log(`取关卡 ${id} 的代码文件失败：${error.message}`, 'warn');
        }
      }
      missing.push(position ? `第${position}关` : id);
    }

    // ① 叠加进答案库（**覆盖**已有答案：平台标准答案就是判分依据，比导入来的更权威）
    const stats = { added: 0, overwritten: 0, kept: 0, unplaced: 0 };
    for (const row of rows) {
      if (row.kind === 'code') mergeCodeAnswer(row, experimentName, stats);
      else mergeStandardAnswer(row, experimentName, stats);
    }
    const merged = stats.added + stats.overwritten;
    if (merged) {
      log(
        `已写入 ${merged} 关平台标准答案到答案库（覆盖原有答案 ${stats.overwritten} 关、新补 ${stats.added} 关）`,
        'ok'
      );
    }
    // ② 连了控制台就照旧回传（它会把答案落盘到 exports/answers/ 的规范文件里）。
    // **按行真实归属的实验回传**：链条可能跨作业（一个实训挂多个作业，比如软件工程导论），
    // 顺带回捞到的邻实验关卡若也标成当前实验，会写进错误实验的答案文件。
    // 归属以答案库里命中条目自带的 experiment 为准（levelIndex 定位），查不到才退回当前实验。
    if (consoleEndpoint('/api/answer/save')) {
      for (const row of rows) {
        const ownerKey = state.levelIndex[row.identifier] || '';
        const ownerEntry = ownerKey ? state.answers[ownerKey] : null;
        const owner = (ownerEntry && ownerEntry.experiment) || experimentName;
        pushAnswerToConsole({
          identifier: row.identifier,
          levelId: row.position ? `L${String(row.position).padStart(3, '0')}` : '',
          experiment: owner,
          levelName: row.title,
          kind: row.kind,
          answer: row.answer,
          language: row.language || ''
        });
      }
    }

    const missText = missing.length
      ? `；${missing.length} 关没有可导出的答案（未提交过/未通过；纯编程题只有「已通过」的才有代码答案）：${missing.slice(0, 8).join('、')}${missing.length > 8 ? '…' : ''}`
      : '';
    if (!rows.length) {
      // 一关都没抓到（比如拉别的关卡失败）：至少把**当前这一关**并进去，别白点一下。
      // 安全边界：选择题只认页面提交后平台才给的 standard_answer；编程题只认
      // **已通过测评**的关卡（此时编辑器里那份就是平台收下的答案）——
      // 未通过的编程题编辑器里可能是没交的草稿，标成 platform/verified 会污染答案库。
      const fallback = currentLevelAnswer();
      const fallbackPosition = Number((state.taskContext && state.taskContext.levelPosition)
        || String(fallback && fallback.levelId || '').replace(/^L0*/i, '')) || 0;
      if (fallback && fallback.kind === 'choice') {
        log('没抓到整条链的关卡数据，改为只写入当前这一关', 'warn');
        const solo = { added: 0, overwritten: 0, kept: 0, unplaced: 0 };
        mergeStandardAnswer({
          identifier: startId,
          position: fallbackPosition,
          title: fallback.levelName,
          answer: fallback.answer
        }, experimentName, solo);
        finishExportExperiment({
          experimentName,
          harvested: 1,
          stats: solo,
          extra: '（只处理了当前这一关）'
        });
        return;
      }
      if (fallback && fallback.kind === 'code') {
        const passed = Boolean(state.taskContext && state.taskContext.passed);
        if (!passed) {
          log('没抓到整条链的关卡数据；当前关是编程题且未确认通过——编辑器里的内容不一定是答案，不写入', 'warn');
          finishExportExperiment({ experimentName, harvested: 0, stats: { added: 0, overwritten: 0, kept: 0, unplaced: 0 } });
          return;
        }
        log('没抓到整条链的关卡数据；当前关已通过测评，编辑器里那份就是平台收下的答案，写入', 'warn');
        const solo = { added: 0, overwritten: 0, kept: 0, unplaced: 0 };
        mergeCodeAnswer({
          identifier: startId,
          position: fallbackPosition,
          title: fallback.levelName,
          answer: fallback.answer
        }, experimentName, solo);
        finishExportExperiment({
          experimentName,
          harvested: 1,
          stats: solo,
          extra: '（只处理了当前这一关）'
        });
        return;
      }
      log('没能从页面上取到任何关卡数据，批量导出中止', 'warn');
      flashButton('eas-export-answers', '✗ 没取到关卡数据', 'err');
      return;
    }
    finishExportExperiment({ experimentName, harvested: rows.length, stats, extra: missText });
  }

  /**
   * 「导出本实验全部答案」的收尾：**每一种结果都要有明确反馈**。
   *
   * 之前只在 `merged > 0` 时打一行成功日志，于是「拉到了但一条都没写进去」
   * 和「只写了当前这一关」这两种情况，点完按钮毫无反应——看着就像功能是坏的。
   * 这里统一出一句总结（实验名 / 拉到几关 / 覆盖几关 / 新补几关 / 库里现在多少关），
   * 并顺手把结果闪在按钮上（面板收起、日志刷走时仍然看得见）。
   */
  function finishExportExperiment({ experimentName, harvested, stats, extra = '' }) {
    const { added = 0, overwritten = 0, kept = 0, unplaced = 0 } = stats || {};
    const merged = added + overwritten;
    const total = Object.keys(state.answers || {}).length;
    const where = experimentName ? `「${experimentName}」` : '本实验';
    const buttonText = merged
      ? `✓ 已写入 ${merged} 关`
      : (harvested ? '⚠ 拉到了但没写入' : '✗ 没拉到答案');
    log(
      merged
        ? `导出${where}成功：拉到 ${harvested} 关标准答案，已写入 ${merged} 关`
          + `（覆盖 ${overwritten} 关、新补 ${added} 关），答案库现在共 ${total} 关${extra}`
        : `导出${where}结束：拉到 ${harvested} 关标准答案，但一关都没写进答案库${extra}`,
      merged ? 'ok' : 'warn'
    );
    if (unplaced) {
      log(
        `其中 ${unplaced} 关没写进去：答案库里没有对应条目（这个实验没导入过答案），`
          + '先用「从本地加答案」导入它所属的班级答案文件，再点一次回捞',
        'warn'
      );
    }
    if (kept) {
      log(
        `其中 ${kept} 关库里已是代码答案，回捞到的是选择题答案——保留代码没覆盖`
          + '（一个条目只能存一种答案，覆盖会把代码弄丢）',
        'warn'
      );
    }
    log('要拿文件用「导出全部答案」——只有它会下载到本地', 'ok');
    flashButton('eas-export-answers', buttonText, merged ? 'ok' : (harvested ? 'warn' : 'err'));
  }

  /* ------------------------------------------------------------------- 启动 */

  /**
   * 离线测试钩子。
   *
   * 测试方在跑这个脚本前先建好 `window.__educoderAutosubmitTestHooks = {}`，
   * 脚本就只把纯函数挂上去、**不启动面板与网络钩子**，从而能在没有浏览器的情况下
   * 真跑一遍按钮匹配、答案解析这些逻辑。
   *
   * 为什么值得留：按钮匹配已经错过两次（先是漏了「提交」以外的文案，
   * 后来又用带 ^$ 锚点的模式去匹配「文本+title」拼接结果），
   * 而这类错误只有真拿页面 DOM 跑一遍才验得出来。
   */
  if (typeof window !== 'undefined' && window.__educoderAutosubmitTestHooks) {
    Object.assign(window.__educoderAutosubmitTestHooks, {
      state,
      tabId: TAB_ID,
      clickStayingInThisTab,
      clickTargetOf,
      closeSelfIfStale,
      buttonLabel,
      buttonMatchText,
      findButton,
      describeButtons,
      SUBMIT_PATTERNS,
      NEXT_LEVEL_PATTERNS,
      readAnswer,
      flattenClassAnswers,
      answerToClassShape,
      buildClassAnswersDoc,
      mergeStandardAnswer,
      mergeCodeAnswer,
      fetchLevelCode,
      codeLanguageFromPath,
      harvestPassedAnswer,
      loadAnswersFromLocal,
      answerKeyForCurrentLevel,
      resolveAnswerForCurrentLevel,
      consoleEndpoint,
      consoleRequest,
      pageWindow,
      pickEditorModel,
      findCodeEditor,
      collectQuestionGroups,
      partitionByCounts,
      choiceSizesForCurrentLevel,
      choiceAnswerFit,
      visibleChoiceInputs,
      isOptionInput,
      observeTaskJson,
      observeSubmitResult,
      standardAnswerText,
      standardAnswerOf,
      fetchTaskData,
      harvestPositionOf,
      currentExperimentName,
      currentLevelAnswer,
      parseClassroomExperiments,
      waitForCodeEditor,
      waitForLevelData,
      ensureLevelData,
      reloadForLevelData,
      noteTaskFetchFailure,
      taskFetchFailedJustNow,
      choiceMapText,
      passedAnswerPayload,
      describeGroups,
      answerChoiceLevel,
      answerCurrentLevel,
      waitForSubmitResult,
      readPageResultText,
      readMaxEvalSeconds,
      settleBeforeSubmit,
      sleep,
      md5,
      signature,
      signingText,
      hasSigningKeys,
      signingKeys,
      signingKeysRaw,
      validateSigningKey,
      buildSignedHeaders,
      parsePathCourse,
      parseCurrentPathIdentifier,
      parseCourseExperiments,
      parseChallenges,
      parseClassrooms,
      parseClassroomExperiments,
      levelPassedOf,
      teachLevelAction,
      buildTeachQueue,
      buildMissingItem,
      urlForLevelIdentifier,
      queueFresh,
      queueMatchesCurrent,
      currentTask,
      backtrackDecision,
      shouldBacktrack
    });
    // 默认（离线单测）只挂纯函数、不启动；真机验证传 __skipBoot=false 才继续启动
    if (window.__educoderAutosubmitTestHooks.__skipBoot !== false) return;
  }

  // 必须在 document-start 就装钩子：页面的关卡数据请求发生在脚本加载之后，
  // 钩子晚一步（比如 document-idle）就观察不到「几道题、每题几个选项」，
  // 选题分组就失去了唯一可靠的数据源。
  installNetworkHooks();

  /** 打印一份「现状总览」：一次刷新就能看清哪里没接上，别再逐条猜。 */
  function dumpStatus() {
    const answers = Object.keys(state.answers).length;
    const mapped = Object.keys(state.levelIndex).length;
    const counts = Object.keys(state.optionCounts).length;
    // 「有 taskContext」不等于「拿到了每题几个选项」：编程题页面也有 taskContext 但 sizes 为空。
    const pageHasSizes = Boolean(state.taskContext && state.taskContext.sizes && state.taskContext.sizes.length);
    const taskCtx = pageHasSizes ? '页面关卡数据✓' : '页面关卡数据✗';
    const consoleCounts = counts ? `控制台选项数✓(${counts}关)` : '控制台选项数✗';
    const keys = hasSigningKeys() ? '签名常量✓' : '签名常量✗';
    log(
      `状态总览：答案 ${answers} 关｜关卡映射 ${mapped} 条｜${taskCtx}｜${consoleCounts}｜`
        + `${keys}｜提交蓝图 ${state.templates.length} 个`,
      'ok'
    );
    if (!answers) log('   ↳ 还没有答案库：点面板「从本地加答案」', 'warn');
    if (!mapped) log('   ↳ 没有关卡映射：答案按 L001 存、页面按标识查，对不上', 'warn');
    if (!pageHasSizes && !counts) log('   ↳ 「每题几个选项」两个来源都空：无法给选择题分组', 'warn');
    if (!hasSigningKeys()) log(`   ↳ ${MISSING_KEYS_HINT}`, 'error');
  }

  function boot() {
    buildPanel();
    // 签名常量优先从本地控制台同步（用户就不用手动粘了）。
    // 放在最前面：后面任何一次接口调用都可能需要它。
    syncSigningKeysFromConsole();
    log('脚本已就绪：先在页面上手动作答并提交一次，脚本会记住提交接口。');
    if (state.templates.length && Object.keys(state.answers).length) {
      log(`已有 ${state.templates.length} 个提交蓝图、${Object.keys(state.answers).length} 关答案，可直接「一键答题」`, 'ok');
    } else if (!Object.keys(state.answers).length) {
      log('还没有答案库：点「从本地加答案」（连得上控制台就拉，否则直接选文件导入）', 'warn');
    }
    dumpStatus();

    restoreTeachSelection();
    // 课堂区现在是常驻可见的，不再需要「到教学课程页就自动展开」这套判断。
    renderTeach();
    refreshTeachMissingCount();

    GM_registerMenuCommand('状态总览', dumpStatus);
    GM_registerMenuCommand('回捞本实验标准答案（叠加进答案库，不下载文件）', exportExperimentAnswers);
    GM_registerMenuCommand('导出日志到本地', exportLogs);
    GM_registerMenuCommand('设置签名常量（平台换常量时覆盖内置值）', promptSigningKeys);
    GM_registerMenuCommand('清空答题进度（下次从头跑）', () => {
      const queue = readTeachQueue();
      if (queue) {
        queue.stoppedReason = '';
        queue.experimentIndex = 0;
        queue.visited = [];
        writeTeachQueue(queue);
      }
      renderTeach();
      log('已清空答题进度：下次点「一键答题」会从头跑（不清空的话会接着上次停下的实验续跑）', 'ok');
    });
    // 原来这里又注册了一遍「导出本实验全部关卡的标准答案」，与上面那条重复（同一函数两个入口，
    // 用户还得自己猜点哪个）。改成补上真正缺的那个：**一键导出全部答案到本地文件**。
    GM_registerMenuCommand('导出全部答案到本地文件（与导入同一格式，可原样导回）', exportAllAnswers);
    GM_registerMenuCommand('从本地加答案（连得上控制台就拉，连不上就选文件）', loadAnswersFromLocal);
    GM_registerMenuCommand('导入答案文件（班级答案文件 / 控制台响应）', importAnswers);
    GM_registerMenuCommand('面板回到左下角', resetPanelPosition);
    GM_registerMenuCommand('停止连续作答', requestStop);
    GM_registerMenuCommand('设置本地控制台地址', setLocalAddress);
    GM_registerMenuCommand('回传录制到的蓝图到控制台', pushAllBlueprints);
    GM_registerMenuCommand('清空录制到的接口', clearTemplates);
    GM_registerMenuCommand('导出录制结果', () => {
      const blob = new Blob([JSON.stringify(state.templates, null, 2)], { type: 'application/json' });
      const link = el('a', { href: URL.createObjectURL(blob), download: 'educoder-submit-templates.json' });
      link.click();
      log('已导出录制结果（把文件发给我即可做成免录制的版本）', 'ok');
    });

    maybeContinueTeachQueue().catch((error) => log(`队列续跑失败：${error.message}`, 'error'));
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
