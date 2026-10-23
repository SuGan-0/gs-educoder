'use strict';

/**
 * 篡改猴内嵌签名实现的向量测试（离线）。
 * 判据直接抄 test/educoder-sign.test.js 的硬向量：AK/SK 常量或 base64/md5 顺序一旦改错，这里必然红。
 *
 * 运行：node --test test/userscript-sign.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'userscript', 'educoder-autosubmit.user.js'), 'utf8');

/**
 * 夹具常量：**不用真实的 AK/SK**（发布版脚本不携带它们，测试也不该依赖）。
 * GM 里存的是「双 base64」形态，与脚本约定一致。
 */
const FIX_AK = '0123456789abcdef0123456789abcdef';
const FIX_SK = 'fedcba98765432100123456789abcdef';
const FIX_AK_B64 = Buffer.from(Buffer.from(FIX_AK, 'utf8').toString('base64'), 'utf8').toString('base64');
const FIX_SK_B64 = Buffer.from(Buffer.from(FIX_SK, 'utf8').toString('base64'), 'utf8').toString('base64');

function loadHooks() {
  const hooks = {};
  const fakeDocument = {
    querySelectorAll: () => [],
    querySelector: () => null,
    getElementById: () => null,
    createElement: () => ({ style: {}, append() {}, addEventListener() {}, setAttribute() {} }),
    head: { append() {} },
    body: { append() {} }
  };
  const location = {
    pathname: '/tasks/x',
    search: '',
    origin: 'https://www.educoder.net',
    href: 'https://www.educoder.net/tasks/x'
  };
  const sandbox = {
    window: {
      __educoderAutosubmitTestHooks: hooks,
      btoa: (value) => Buffer.from(String(value), 'binary').toString('base64'),
      atob: (value) => Buffer.from(String(value), 'base64').toString('binary'),
      document: fakeDocument,
      location
    },
    document: fakeDocument,
    location,
    navigator: { userAgent: 'test' },
    URL,
    URLSearchParams,
    console,
    setTimeout,
    clearTimeout,
    // 签名常量从 GM 存储来（脚本已不硬编码）：这里注入夹具
    GM_getValue: (key, fallback) => {
      if (key === 'educoder-sign-ak') return FIX_AK_B64;
      if (key === 'educoder-sign-sk') return FIX_SK_B64;
      return fallback;
    },
    GM_setValue: () => {},
    GM_deleteValue: () => {},
    GM_registerMenuCommand: () => {},
    GM_xmlhttpRequest: () => {}
  };
  vm.createContext(sandbox);
  new vm.Script(SOURCE).runInContext(sandbox);
  return hooks;
}

test('篡改猴签名：与 extractor 同算法（同一输入产出同一签名）', () => {
  const hooks = loadHooks();
  assert.equal(typeof hooks.signature, 'function', '测试钩子应暴露 signature');
  assert.equal(hooks.md5('abc'), '900150983cd24fb0d6963f7d28e17f72');
  assert.equal(hooks.hasSigningKeys(), true, 'GM 里注入了夹具常量');

  // 签名串要用注入的常量拼出来（decodeKey 解出的就是夹具明文）
  const text = hooks.signingText('GET', 1758956400000);
  assert.equal(
    text,
    `method=GET&ak=${FIX_AK}&sk=${FIX_SK}&time=1758956400000`,
    '签名串的拼法与 extractor 一致'
  );

  // 算法等价性：脚本的 signature == node:crypto 的 md5(base64(签名串))
  const expected = createHash('md5').update(Buffer.from(text, 'ascii').toString('base64')).digest('hex');
  assert.equal(hooks.signature('GET', 1758956400000), expected);
  assert.equal(hooks.signature('POST', 1758956400000), createHash('md5').update(Buffer.from(hooks.signingText('POST', 1758956400000), 'ascii').toString('base64')).digest('hex'));
  assert.notEqual(hooks.signature('GET', 1758956400000), hooks.signature('POST', 1758956400000), '方法不同签名必须不同');
  assert.notEqual(hooks.signature('GET', 1758956400000), hooks.signature('GET', 1758956400001), '时间不同签名必须不同');
});

test('篡改猴签名：请求头三件套齐全，X-EDU-Type 必须精确是 pc', () => {
  const hooks = loadHooks();
  const headers = hooks.buildSignedHeaders('GET', 1758956400000);
  assert.equal(headers['X-EDU-Timestamp'], '1758956400000');
  const text = hooks.signingText('GET', 1758956400000);
  assert.equal(
    headers['X-EDU-Signature'],
    createHash('md5').update(Buffer.from(text, 'ascii').toString('base64')).digest('hex'),
    'Signature 与 signingText 的结果一致（算法等价于 extractor）'
  );
  assert.equal(headers['X-EDU-Type'], 'pc');
});

// 常量已**内置**进脚本（用户 10-14 要求「固定进篡改猴」）：GM 空的时候，
// signingKeysRaw 会用内置值补上并种回 GM——开箱即用，不再提示缺常量。
test('篡改猴签名：GM 空时内置常量生效（自动种回 GM，签名可用）', () => {
  // 用一个「没有常量」的沙箱（GM_getValue 只回 fallback），记录 GM_setValue 的写入
  const hooks = {};
  const seeded = {};
  const fakeDocument = {
    querySelectorAll: () => [],
    querySelector: () => null,
    getElementById: () => null,
    createElement: () => ({ style: {}, append() {}, addEventListener() {}, setAttribute() {} }),
    head: { append() {} },
    body: { append() {} }
  };
  const sandbox = {
    window: { __educoderAutosubmitTestHooks: hooks, btoa: (v) => Buffer.from(String(v), 'binary').toString('base64'), atob: (v) => Buffer.from(String(v), 'base64').toString('binary'), document: fakeDocument },
    document: fakeDocument,
    location: { pathname: '/tasks/x', search: '', origin: 'https://www.educoder.net', href: 'https://www.educoder.net/tasks/x' },
    navigator: { userAgent: 'test' },
    URL,
    URLSearchParams,
    console,
    setTimeout,
    clearTimeout,
    GM_getValue: (_key, fallback) => fallback,
    GM_setValue: (key, value) => { seeded[key] = value; },
    GM_deleteValue: () => {},
    GM_registerMenuCommand: () => {},
    GM_xmlhttpRequest: () => {}
  };
  sandbox.window.document = fakeDocument;
  sandbox.window.location = sandbox.location;
  vm.createContext(sandbox);
  new vm.Script(SOURCE).runInContext(sandbox);

  assert.equal(hooks.hasSigningKeys(), true, '内置常量要让 hasSigningKeys 通过');
  const keys = hooks.signingKeys();
  assert.ok(keys && keys.ak && keys.sk, '内置常量要能解码出 AK/SK');
  assert.match(keys.ak, /^[0-9a-f]{32}$/, '内置 AK 解出来是 32 位十六进制（与 .env 同一份）');
  assert.match(keys.sk, /^[0-9a-f]{32}$/, '内置 SK 解出来是 32 位十六进制');
  // 种回 GM：「设置签名常量」菜单的预填走同一条路
  assert.ok(seeded['educoder-sign-ak'] && seeded['educoder-sign-sk'], '内置值要种进 GM 存储');
  // 签名真的可用：拼出来的签名串用的是内置常量
  const text = hooks.signingText('GET', 1758956400000);
  assert.equal(
    text,
    `method=GET&ak=${keys.ak}&sk=${keys.sk}&time=1758956400000`,
    '签名串用内置常量拼装'
  );
  assert.doesNotThrow(() => hooks.signature('GET', 1758956400000), '内置常量下签名函数不该抛错');
});

// GM 里已经存了一**对**时（用户粘过）优先用存的那对——内置值只是缺省，不许悄悄顶掉用户的覆盖。
test('篡改猴签名：GM 已存的完整一对优先于内置值', () => {
  const hooks = loadHooks(); // 注入了夹具常量（不同于内置值）
  assert.equal(hooks.hasSigningKeys(), true);
  const text = hooks.signingText('GET', 1758956400000);
  assert.equal(
    text,
    `method=GET&ak=${FIX_AK}&sk=${FIX_SK}&time=1758956400000`,
    '用户粘的常量优先于内置值'
  );
});

// 内置不是免死金牌：GM 里存了**非法**的一对（比如只解了一次的串）时，
// 必须如实报「不可用」并把用户引到菜单，而不是悄悄退回内置值掩盖错误。
test('篡改猴签名：GM 里的非法常量要如实报不可用（不退回内置值掩盖）', () => {
  const hooks = {};
  const onceAk = Buffer.from('0123456789abcdef', 'utf8').toString('base64'); // 只解一次的形态
  const fakeDocument = {
    querySelectorAll: () => [],
    querySelector: () => null,
    getElementById: () => null,
    createElement: () => ({ style: {}, append() {}, addEventListener() {}, setAttribute() {} }),
    head: { append() {} },
    body: { append() {} }
  };
  const sandbox = {
    window: { __educoderAutosubmitTestHooks: hooks, btoa: (v) => Buffer.from(String(v), 'binary').toString('base64'), atob: (v) => Buffer.from(String(v), 'base64').toString('binary'), document: fakeDocument },
    document: fakeDocument,
    location: { pathname: '/tasks/x', search: '', origin: 'https://www.educoder.net', href: 'https://www.educoder.net/tasks/x' },
    navigator: { userAgent: 'test' },
    URL,
    URLSearchParams,
    console,
    setTimeout,
    clearTimeout,
    GM_getValue: (key, fallback) => (key === 'educoder-sign-ak' || key === 'educoder-sign-sk' ? onceAk : fallback),
    GM_setValue: () => {},
    GM_deleteValue: () => {},
    GM_registerMenuCommand: () => {},
    GM_xmlhttpRequest: () => {}
  };
  sandbox.window.document = fakeDocument;
  sandbox.window.location = sandbox.location;
  vm.createContext(sandbox);
  new vm.Script(SOURCE).runInContext(sandbox);
  assert.equal(hooks.hasSigningKeys(), false, '非法常量要如实报不可用');
  assert.throws(() => hooks.signature('GET', 0), /设置签名常量/, '报错要指向菜单（粘贴覆盖或更新脚本）');
});


// 常量是**双重 base64**。「只粘解过一次的那串」也能被解出结果（十六进制字符本身都是
// 合法 base64 字符），只是解出来是乱码；乱码一路走到请求里被拒，报的却是
// `-102 服务器时间不匹配`（跟时间完全无关），用户会顺着错方向查半天。
// 所以在粘贴那一刻就要拦住。
test('签名常量校验：双 base64 通过；「只粘解过一次」的那串要被拦住', () => {
  const hooks = loadHooks();
  assert.equal(typeof hooks.validateSigningKey, 'function', '测试钩子应暴露 validateSigningKey');

  const ok = hooks.validateSigningKey(FIX_AK_B64);
  assert.equal(ok.ok, true, '正确的双 base64 应通过');
  assert.equal(ok.reason, '');

  // 只解过一次的那串：44 字符、以 = 结尾
  const once = Buffer.from(FIX_AK, 'utf8').toString('base64');
  assert.match(once, /=$/, '夹具前提：解一次的结果以 = 结尾');
  const wrong = hooks.validateSigningKey(once);
  assert.equal(wrong.ok, false, '解过一次的那串不能算通过');
  assert.match(wrong.reason, /双 base64/, '要明确说要粘双 base64');

  assert.equal(hooks.validateSigningKey('').ok, false, '空值不通过');
  assert.equal(hooks.validateSigningKey('not base64!!').ok, false, '含非法字符不通过');
});