'use strict';

/**
 * Educoder data API 请求签名。
 *
 * ## 为什么需要它（这段是给未来的人看的，别删）
 *
 * 直连 `data.educoder.net/api/` 的请求若**不带签名头**，会被服务端拒绝并返回：
 *
 * ```json
 * HTTP 200  {"status":-102,"message":"服务器时间与您的设备时间不匹配，请检查您的设备时间设置并重新加载页面。"}
 * ```
 *
 * **这条错误信息是误导性的。它跟系统时间、时区、cookie、`zzud`、Referer 都无关，
 * 缺的是签名头。** 本项目早期把它当成「环境限制」，于是改用「页面自身请求优先」
 * 的截获方案——那是不必要的。实测见 docs/FIX-102-SIGNATURE.md：
 * 同一账号、同一台机器、同一个会话，补上签名头后所有接口都能直接调用，
 * 而且**不需要浏览器上下文**（`request.newContext()` 即可）。
 *
 * ## 算法
 *
 * 来自官网公开前端 `https://www-cdn.educoder.net/umi.<hash>.js` 的
 * `setHeader` / `getKey`：
 *
 * ```text
 * message   = `method=${METHOD}&ak=${AK}&sk=${SK}&time=${毫秒时间戳}`
 * signature = md5( base64(message) )        // 32 位十六进制小写
 * ```
 *
 * ## 实测得出的最小必需头
 *
 * | 头 | 必需 | 说明 |
 * |---|---|---|
 * | `X-EDU-Timestamp` | 是 | 毫秒时间戳，必须与签名里的一致 |
 * | `X-EDU-Signature` | 是 | 上面的 md5；`method` 必须与实际 HTTP 方法一致 |
 * | `Cookie` | 是 | 会话（如 `_educoder_session=...`） |
 * | `X-EDU-Type` | 是 | **必须精确为 `pc`**，写成 `web` 会失败 |
 * | `X-Request-Id` / `Referer` / `Origin` / `X-Original-*` | 否 | 保留仅为排查方便 |
 *
 * ## 硬约束
 *
 * 本模块必须保持**纯函数**：无 fs、无网络、无 playwright、无随机时钟依赖
 * （`now` 可注入）。否则无法离线测试——与 docs/ARCHITECTURE.md 对
 * `lib/task-parser.js` 的约定一致。
 *
 * ## AK/SK 从哪来（**不进仓库**）
 *
 * 它们是平台前端的**公开客户端常量**（不是用户凭据），但公开仓库不携带平台常量，
 * 所以按以下顺序在**运行时**取：
 *   ① 环境变量 `EDUCODER_AK` / `EDUCODER_SK`（填双 base64 那串）；
 *   ② 仓库根下的 `.educoder-keys.json`（`{"ak": "<双base64>", "sk": "<双base64>"}`，已 gitignore）。
 * 都没有时 `signingText()` 会抛一个**带获取方法**的错误，而不是静默发出必被拒的请求。
 *
 * ## 失效时怎么办
 *
 * 网站改版会换掉这对常量。届时请求会报签名失败（`-102`），
 * 本地工具 `tools/probe-signature.js`（未随仓库发布）会提示「签名算法可能已变更」并打印 `SIGNING_VERSION`。
 * 更新方式：抓 `www-cdn.educoder.net/umi.<hash>.js`，搜 `setHeader` / `getKey`，
 * 把新的双 base64 常量写进 `.educoder-keys.json`（或环境变量）。
 */

const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

/** 常量来源日期。接口报签名失效时把它一起打印出来，便于判断是"算法变了"还是"会话掉了"。 */
const SIGNING_VERSION = '2026-09-24';

/** 本地密钥文件（已 .gitignore）：仓库里不含 AK/SK。 */
const KEYS_FILE = path.join(__dirname, '..', '..', '.educoder-keys.json');

/** 已解码的常量缓存。 */
let cachedKeys = null;

/**
 * 取**未解码**的常量（双 base64 原样）：env 优先，其次本地密钥文件；都没有返回 null。
 *
 * 单独留一个编码态的出口，是因为篡改猴存的就是编码态（手动粘贴那串）。
 * 控制台把这份原样给它，脚本就不用为「来自控制台」和「手动粘贴」维护两种格式。
 */
function signingKeysEncoded() {
  let ak = String(process.env.EDUCODER_AK || '').trim();
  let sk = String(process.env.EDUCODER_SK || '').trim();
  if (!ak || !sk) {
    try {
      const parsed = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8'));
      ak = String((parsed && parsed.ak) || '').trim();
      sk = String((parsed && parsed.sk) || '').trim();
    } catch (error) {
      /* 文件不存在/坏了：下面统一按"缺失"处理 */
    }
  }
  return ak && sk ? { ak, sk } : null;
}

/**
 * 取签名常量（懒加载，已解码）：env 优先，其次本地密钥文件；都没有返回 null。
 * 懒加载是为了让测试/调用方有机会先设环境变量。
 */
function signingKeys() {
  if (cachedKeys) return cachedKeys;
  const encoded = signingKeysEncoded();
  if (!encoded) return null;
  try {
    cachedKeys = { ak: decodeKey(encoded.ak), sk: decodeKey(encoded.sk) };
  } catch (error) {
    return null;
  }
  return cachedKeys;
}

/** 有没有可用的签名常量（测试据此跳过需要真常量的用例）。 */
function hasSigningKeys() {
  return Boolean(signingKeys());
}

const MISSING_KEYS_HINT =
  '缺少签名常量 AK/SK：请设置环境变量 EDUCODER_AK / EDUCODER_SK（填双 base64 那串），'
  + `或在仓库根写 .educoder-keys.json（形如 {"ak":"<双base64>","sk":"<双base64>"}）。`
  + '获取方式：抓 www-cdn.educoder.net/umi.<hash>.js，搜 setHeader / getKey。';

/** 实测：服务端按这个值分流，写成 `web` 会被拒。不要"顺手"改成别的。 */
const EDU_TYPE = 'pc';

/**
 * 解码双重 base64 的常量。
 * @param {string} encoded
 * @returns {string}
 */
function decodeKey(encoded) {
  if (typeof encoded !== 'string' || !encoded) {
    throw new TypeError('签名常量必须是非空字符串。');
  }
  const once = Buffer.from(encoded, 'base64').toString('utf8');
  const twice = Buffer.from(once, 'base64').toString('ascii');
  if (!twice) throw new Error('签名常量解码为空，算法可能已变更。');
  return twice;
}


/**
 * 拼出待签名的明文。
 * @param {string} method 必须与实际 HTTP 方法一致
 * @param {number|string} time 毫秒时间戳
 */
function signingText(method, time) {
  const keys = signingKeys();
  if (!keys) throw new Error(MISSING_KEYS_HINT);
  return `method=${String(method || 'GET').toUpperCase()}&ak=${keys.ak}&sk=${keys.sk}&time=${time}`;
}

/**
 * 先 base64 再取 md5 的十六进制摘要。
 * @param {string} text
 */
function sign(text) {
  return createHash('md5').update(Buffer.from(text, 'ascii').toString('base64')).digest('hex');
}

/**
 * 算出某个方法/时刻的签名。
 * @param {string} [method]
 * @param {number} time
 */
function signature(method, time) {
  return sign(signingText(method, time));
}

/**
 * 生成三个签名头。
 * @param {{method?: string, now?: number}} [options]
 * @returns {{'X-EDU-Timestamp': string, 'X-EDU-Signature': string, 'X-Request-Id': string}}
 */
function signingHeaders(options = {}) {
  const method = options.method || 'GET';
  // 注意用 === undefined 判断：now=0 是合法入参（测试向量会用到），不能用真值判断。
  const time = options.now === undefined || options.now === null ? Date.now() : options.now;
  return {
    'X-EDU-Timestamp': String(time),
    'X-EDU-Signature': signature(method, time),
    'X-Request-Id': randomUUID()
  };
}

/**
 * 一次请求所需的**完整必需头集合**。
 *
 * 统一从这里取头，避免调用方各拼一半——历史上正是因为缺了 `X-EDU-Type`
 * 或签名，才把 `-102` 误判成设备时间问题。
 *
 * @param {{cookie: string, method?: string, now?: number}} options
 */
function requestHeaders(options = {}) {
  const cookie = options.cookie;
  if (typeof cookie !== 'string' || !cookie.trim()) {
    throw new Error('缺少会话 Cookie，无法发起 Educoder 请求（请先登录一次）。');
  }
  return {
    Accept: 'application/json',
    Cookie: cookie,
    'X-EDU-Type': EDU_TYPE,
    ...signingHeaders(options)
  };
}

module.exports = {
  SIGNING_VERSION,
  EDU_TYPE,
  MISSING_KEYS_HINT,
  hasSigningKeys,
  signingKeys,
  signingKeysEncoded,
  decodeKey,
  signingText,
  sign,
  signature,
  signingHeaders,
  requestHeaders
};
