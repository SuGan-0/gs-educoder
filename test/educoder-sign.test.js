'use strict';

/**
 * 签名模块的离线测试。
 *
 * 这些向量是用固定时间戳算出来的**硬编码期望值**——它们的作用是锁死算法：
 * 一旦 AK/SK 常量被换掉、或 base64/md5 的顺序被改错，这里必然红。
 * 不要因为"跑不过就改期望值"，那等于把唯一的安全网拆了。
 *
 * 运行：node --test test/educoder-sign.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SIGNING_VERSION,
  EDU_TYPE,
  decodeKey,
  signingText,
  sign,
  signature,
  signingHeaders,
  requestHeaders
} = require('../extractor/lib/educoder-sign');

/** 固定时间戳：2025-09-27T07:00:00Z，避免测试依赖真实时钟。 */
const FIXED = 1758956400000;

test('decodeKey：双重 base64 解出 32 位十六进制常量', () => {
  // 夹具：双重 base64 的 32 位十六进制串（不再用真实的 AK 常量做测试输入）
  const encoded = 'TURFeU16UTFOamM0T1dGaVkyUmxaakF4TWpNME5UWTNPRGxoWW1Oa1pXWT0=';
  const decoded = decodeKey(encoded);
  assert.match(decoded, /^[0-9a-f]{32}$/, '解出来应是 32 位小写十六进制');
  // 只解一层会得到另一个 base64 串（长度与字符集都不同），这里顺带锁住"必须解两层"。
  const once = Buffer.from(encoded, 'base64').toString('utf8');
  assert.notEqual(decoded, once, '只解一层不算解码成功');
});

test('decodeKey：非法入参抛错，不静默返回空串', () => {
  assert.throws(() => decodeKey(''), TypeError);
  assert.throws(() => decodeKey(null), TypeError);
  assert.throws(() => decodeKey(123), TypeError);
});

test('测试向量：GET @ 固定时间戳', () => {
  assert.equal(signature('GET', FIXED), '5b853aab244a2be19154aaabc0a65fdb');
});

test('测试向量：POST @ 固定时间戳（方法参与签名）', () => {
  assert.equal(signature('POST', FIXED), 'ba80d114b7b1b5863e7bd2527cce1281');
});

test('测试向量：time=0 是合法入参，不能被当成"未传时间"', () => {
  assert.equal(signature('GET', 0), 'b9a70328b377bb453efca5ace76f4776');
  assert.equal(signingHeaders({ method: 'GET', now: 0 })['X-EDU-Timestamp'], '0');
});

test('method 不区分大小写，但换方法必然换签名', () => {
  assert.equal(signature('get', FIXED), signature('GET', FIXED));
  assert.equal(signature('Get', FIXED), signature('GET', FIXED));
  assert.notEqual(signature('GET', FIXED), signature('POST', FIXED));
});

test('时间变化必然换签名', () => {
  assert.notEqual(signature('GET', FIXED), signature('GET', FIXED + 1));
});

test('signingText / sign 的组合与 signature 等价', () => {
  const text = signingText('GET', FIXED);
  assert.match(text, /^method=GET&ak=[0-9a-f]{32}&sk=[0-9a-f]{32}&time=1758956400000$/);
  assert.equal(sign(text), signature('GET', FIXED));
});

test('signingHeaders：Timestamp 与传入时间一致，Signature 与 signature 一致', () => {
  const headers = signingHeaders({ method: 'GET', now: FIXED });
  assert.equal(headers['X-EDU-Timestamp'], String(FIXED));
  assert.equal(headers['X-EDU-Signature'], signature('GET', FIXED));
  assert.ok(headers['X-Request-Id'], 'X-Request-Id 保留（排查用，实测非必需）');
});

test('signingHeaders：不传 now 时取当前时间，且仍是毫秒数字串', () => {
  const headers = signingHeaders();
  assert.match(headers['X-EDU-Timestamp'], /^\d{13}$/);
  assert.equal(headers['X-EDU-Signature'], signature('GET', Number(headers['X-EDU-Timestamp'])));
});

test('requestHeaders：缺 Cookie 直接抛错，不发出必然被拒的请求', () => {
  assert.throws(() => requestHeaders({ cookie: '' }), /Cookie/);
  assert.throws(() => requestHeaders({ cookie: '   ' }), /Cookie/);
  assert.throws(() => requestHeaders({}), /Cookie/);
});

test('requestHeaders：包含实测得出的全部必需头', () => {
  const headers = requestHeaders({ cookie: '_educoder_session=abc', method: 'GET', now: FIXED });
  assert.equal(headers.Cookie, '_educoder_session=abc');
  assert.equal(headers['X-EDU-Type'], 'pc', '必须精确为 pc，写成 web 会被服务端拒绝');
  assert.equal(headers['X-EDU-Timestamp'], String(FIXED));
  assert.equal(headers['X-EDU-Signature'], signature('GET', FIXED));
});

test('requestHeaders：签名方法跟随入参', () => {
  const headers = requestHeaders({ cookie: 'c=1', method: 'POST', now: FIXED });
  assert.equal(headers['X-EDU-Signature'], signature('POST', FIXED));
  assert.notEqual(headers['X-EDU-Signature'], signature('GET', FIXED));
});

test('常量自检：EDU_TYPE 与 SIGNING_VERSION 已定义', () => {
  assert.equal(EDU_TYPE, 'pc');
  assert.match(SIGNING_VERSION, /^\d{4}-\d{2}-\d{2}$/, '失效时靠它判断是算法变了还是会话掉了');
});
