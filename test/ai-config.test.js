'use strict';

/**
 * AI 作答配置：来源是 .env，界面只显示模型。
 *
 * 这里最要紧的一条是**凭据不得回显**：界面/接口给出的那份配置里
 * 绝不能出现 Key。页面上出现过的东西会进截图、进剪贴板、进别人的屏幕。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveAiConfig, describeAiConfig, DEFAULT_BASE_URL, DEFAULT_MODEL } = require('../extractor/lib/ai-config');

/** 临时改环境变量跑一段代码，结束后恢复。 */
function withEnv(patch, run) {
  const saved = {};
  for (const key of Object.keys(patch)) {
    saved[key] = process.env[key];
    if (patch[key] === undefined) delete process.env[key];
    else process.env[key] = patch[key];
  }
  try {
    return run();
  } finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

const CLEAR = {
  EDUCODER_AI_BASE_URL: undefined,
  EDUCODER_AI_MODEL: undefined,
  EDUCODER_AI_KEY: undefined
};

test('AI 配置：什么都不设时用默认接口与模型，且视为未配置', () => {
  withEnv(CLEAR, () => {
    const config = resolveAiConfig();
    assert.equal(config.baseUrl, DEFAULT_BASE_URL);
    assert.equal(config.model, DEFAULT_MODEL);
    assert.equal(config.apiKey, '', '没设就是空串，不是 undefined');

    const shown = describeAiConfig();
    assert.equal(shown.configured, false, '没有 Key 就是未配置');
    assert.equal(shown.model, DEFAULT_MODEL);
  });
});

test('AI 配置：全部从环境变量读', () => {
  withEnv({
    EDUCODER_AI_BASE_URL: 'https://example.com/v1',
    EDUCODER_AI_MODEL: 'my-model',
    EDUCODER_AI_KEY: 'sk-test-key'
  }, () => {
    const config = resolveAiConfig();
    assert.equal(config.baseUrl, 'https://example.com/v1');
    assert.equal(config.model, 'my-model');
    assert.equal(config.apiKey, 'sk-test-key');
    assert.equal(describeAiConfig().configured, true);
  });
});

test('AI 配置：空白值当作没设（.env 里留空不该变成「已配置」）', () => {
  withEnv({ EDUCODER_AI_BASE_URL: '   ', EDUCODER_AI_MODEL: '', EDUCODER_AI_KEY: '  ' }, () => {
    const config = resolveAiConfig();
    assert.equal(config.baseUrl, DEFAULT_BASE_URL, '空白要退回默认接口');
    assert.equal(config.model, DEFAULT_MODEL, '空白要退回默认模型');
    assert.equal(config.apiKey, '', '空白 Key 等于没配');
    assert.equal(describeAiConfig().configured, false);
  });
});

test('给界面看的那份配置**绝不能带 Key**（含序列化后的整体）', () => {
  withEnv({ EDUCODER_AI_KEY: 'sk-super-secret-value' }, () => {
    const shown = describeAiConfig();
    assert.equal(shown.apiKey, undefined, '不该有这个字段');
    assert.ok(!Object.keys(shown).includes('apiKey'), '连字段名都不该出现');

    // 整份序列化后也不能漏：万一以后有人顺手把整个 config 塞进去，这条会拦住
    const text = JSON.stringify(shown);
    assert.ok(!text.includes('sk-super-secret-value'), '序列化后不得包含 Key');
    assert.ok(!/sk-/.test(text), '连 sk- 前缀都不该出现');
  });
});
