'use strict';

/**
 * AI 作答配置（接口 / 模型 / Key）——**唯一来源是 `.env` 或环境变量**。
 *
 * ## 为什么不放在控制台界面上填
 *
 * 界面上填的东西只活在进程内存里：关掉控制台就没了，下次还得重填。
 * 而它本来就是「配一次、长期用」的东西，和签名常量、端口、token 一个性质，
 * 所以统一放 `.env`（见 `.env.example` 的 AI 作答一节）。
 *
 * ## 为什么单独成模块
 *
 * 抓取外壳（`run.js`）要用它去调模型，控制台服务（`ui/server.js`）要用它
 * 判断「配没配」并把模型名显示给用户。放 `run.js` 里会让 server.js 反向依赖外壳，
 * 所以抽出来。
 *
 * ## 一条硬规则
 *
 * **任何给界面/日志用的出口都不得包含 Key**（见 `describeAiConfig`）。
 * 页面上出现过的东西会进截图、进剪贴板、进别人的屏幕。
 */

const DEFAULT_BASE_URL = 'https://api.deepseek.com/v1';
const DEFAULT_MODEL = 'deepseek-chat';

const MISSING_KEY_HINT =
  '还没配 AI 的 API Key：在仓库根的 .env 里加一行 EDUCODER_AI_KEY=sk-...（模板见 .env.example）。'
  + '控制台界面不再收 Key——它只显示当前用的是哪个模型。';

/** 完整配置（含 Key），只给真正要发请求的地方用。 */
function resolveAiConfig() {
  return {
    baseUrl: String(process.env.EDUCODER_AI_BASE_URL || '').trim() || DEFAULT_BASE_URL,
    model: String(process.env.EDUCODER_AI_MODEL || '').trim() || DEFAULT_MODEL,
    apiKey: String(process.env.EDUCODER_AI_KEY || '').trim()
  };
}

/**
 * 给界面显示的配置：**只到「用什么模型」，绝不带 Key**。
 *
 * 界面要能回答「现在用的是哪个模型」，但没有任何理由把凭据回显到页面上。
 */
function describeAiConfig() {
  const config = resolveAiConfig();
  return { model: config.model, baseUrl: config.baseUrl, configured: Boolean(config.apiKey) };
}

module.exports = {
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  MISSING_KEY_HINT,
  resolveAiConfig,
  describeAiConfig
};
