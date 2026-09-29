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

test('篡改猴签名：GM 里没有常量时，签名单函数要抛带获取方法的错误', () => {
  // 用一个「没有常量」的沙箱（GM_getValue 只回 fallback）
  const hooks = {};
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
    GM_setValue: () => {},
    GM_deleteValue: () => {},
    GM_registerMenuCommand: () => {},
    GM_xmlhttpRequest: () => {}
  };
  sandbox.window.document = fakeDocument;
  sandbox.window.location = sandbox.location;
  vm.createContext(sandbox);
  new vm.Script(SOURCE).runInContext(sandbox);
  assert.equal(hooks.hasSigningKeys(), false, '没注入常量时要能探测出来');
  assert.throws(() => hooks.signature('GET', 0), /设置签名常量/, '报错要告诉用户怎么设置');
});