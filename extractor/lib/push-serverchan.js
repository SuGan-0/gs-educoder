'use strict';

/**
 * Server 酱推送通道（Turbo / Server 酱³）。
 *
 * 与参考实现一致：按 SendKey 前缀自动选择接口——
 *
 *   `SCT...`          → Turbo：`https://sctapi.ftqq.com/{key}.send`
 *   `sctp{n}t...`     → Server 酱³：`https://{n}.push.ft07.com/send/{key}.send`
 *
 * ## 安全约束（务必保持）
 *
 * - **密钥不进日志、不进错误信息**：本模块抛出的错误一律不拼接 URL 与 key。
 * - 只有接收方标识（key 的 sha256）可以落库，用于去重与额度统计。
 * - 传输层可注入（`transport`），离线测试直接塞假实现，不联网、不读环境变量。
 */

const { createHash } = require('node:crypto');

const TITLE_MAX = 100;
const BODY_MAX_BYTES = 30000;
const DEFAULT_TIMEOUT = 20000;

class PushError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PushError';
  }
}

/** 识别 SendKey 并给出对应接口。密钥非法时抛错，且**不回显密钥**。 */
function endpoint(key) {
  const value = String(key || '').trim();
  if (!value) throw new PushError('缺少 Server 酱 SendKey。');
  if (/^SCT[A-Za-z0-9_-]+$/.test(value)) {
    return { provider: 'Turbo', url: `https://sctapi.ftqq.com/${value}.send` };
  }
  const match = /^sctp(\d+)t[A-Za-z0-9_-]+$/.exec(value);
  if (match) {
    return { provider: 'SC3', url: `https://${match[1]}.push.ft07.com/send/${value}.send` };
  }
  throw new PushError('SendKey 格式无效（应为 SCT… 或 sctp{n}t…），请检查配置。');
}

/** 接收方标识：只存哈希，用于去重与额度统计。 */
function receiverId(key) {
  endpoint(key);
  return createHash('sha256').update(String(key).trim(), 'utf8').digest('hex');
}

/** 校验服务端应答：`code === 0` 才代表「已被接受」（不代表手机已显示）。 */
function validateResponse(status, data) {
  if (status !== 200 || !data || typeof data !== 'object' || data.code !== 0) {
    throw new PushError('Server 酱未确认发送成功，请检查额度与推送日志。');
  }
}

/** 默认传输：全局 fetch（Node 18+ 内置），带超时。 */
async function defaultTransport(url, form, options = {}) {
  const controller = new AbortController();
  const timeout = Number(options.timeout) || DEFAULT_TIMEOUT;
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
      body: form,
      signal: controller.signal
    });
    const text = await response.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      throw new PushError('Server 酱响应无法解析，送达状态未知。');
    }
    return { status: response.status, data };
  } catch (error) {
    if (error instanceof PushError) throw error;
    // 网络异常/超时：**不拼接 URL**（URL 里含密钥）。
    throw new PushError('Server 酱网络请求失败，送达状态未知；将在限额内延迟重试。');
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 发送一条通知。
 *
 * @param {string} key SendKey
 * @param {string} title
 * @param {string} body Markdown 正文
 * @param {{transport?: Function, timeout?: number}} [options]
 * @returns {Promise<{ok: true, provider: string}>}
 */
async function send(key, title, body, options = {}) {
  const { provider, url } = endpoint(key);
  const text = String(title == null ? '' : title);
  const desp = String(body == null ? '' : body);
  // 纯空白也算空标题——否则推送会「成功」，但接收端只看到一条没有标题的空白消息。
  if (!text.trim() || text.includes('\n') || text.length > TITLE_MAX) {
    throw new PushError('通知标题为空、含换行或超过本地长度限制，未发送。');
  }
  if (Buffer.byteLength(desp, 'utf8') > BODY_MAX_BYTES) {
    throw new PushError('通知正文超过本地长度限制，未发送。');
  }
  const transport = options.transport || defaultTransport;
  const form = new URLSearchParams({ title: text, desp }).toString();
  let result;
  try {
    result = await transport(url, form, { timeout: options.timeout });
  } catch (error) {
    if (error instanceof PushError) throw error;
    // 自定义传输层抛出的原始错误可能带着 URL（也就带着密钥），一律换成本地文案。
    throw new PushError('推送请求失败，送达状态未知；将在限额内延迟重试。');
  }
  validateResponse(result && result.status, result && result.data);
  return { ok: true, provider };
}

module.exports = {
  TITLE_MAX,
  BODY_MAX_BYTES,
  PushError,
  endpoint,
  receiverId,
  validateResponse,
  defaultTransport,
  send
};
