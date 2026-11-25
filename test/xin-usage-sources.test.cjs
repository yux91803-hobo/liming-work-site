// 用量页按来源分（站长 2026-11-16：「把网关和谷歌的分开」）：控制器给每个模型标上来源
const test = require('node:test'), assert = require('node:assert/strict'), path = require('node:path');
const { pathToFileURL } = require('node:url');
test('模型来源：Gemini 是 Google，DeepSeek / GLM / Kimi 走网关，别的算其他', async () => {
  const { modelSource } = await import(pathToFileURL(path.join(__dirname, '../site/xin/vm-models.mjs')).href);
  assert.equal(modelSource('gemini-4-hydrogen'), 'google');
  for (const id of ['deepseek-v4.1-flash', 'glm-5.3', 'glm-5.3-flash', 'glm-5.4', 'kimi-k3.1-pro']) assert.equal(modelSource(id), 'gateway', id);
  assert.equal(modelSource('claude-opus-4-1'), 'other');
  assert.equal(modelSource(''), 'other');
});
