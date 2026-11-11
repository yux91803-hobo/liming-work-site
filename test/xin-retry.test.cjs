// 临时错误和终止错误（vm-retry.mjs）：临时的由控制器等一会儿接着做，终止的照旧算没做成。参考 Grok Bot transient-stream-error.ts。
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const load = () => import(pathToFileURL(path.join(__dirname, '../site/xin/vm-retry.mjs')).href);

test('临时错误和终止错误分得开', async () => {
  const { transientFailure } = await load();
  for (const s of ['stream disconnected before completion', 'Error: read ECONNRESET', 'socket hang up', 'TypeError: fetch failed', 'HTTP 502 Bad Gateway',
    'unexpected status 503 Service Unavailable', '429 Too Many Requests', 'The server is overloaded', 'rate limit exceeded', '前台连接失败（HTTP 504）'])
    assert.equal(transientFailure(s), true, s);
  for (const s of ['task inference budget exhausted; partial work is retained', '本项工作的推理预算已用完', 'context_length_exceeded', 'HTTP 401 Unauthorized',
    '403 forbidden', '超过 60 分钟还没做完，停下了', '独立复核模型与实际作者相同，已拒绝启动。', '', null, undefined])
    assert.equal(transientFailure(s), false, String(s));
});

test('终止关键字优先：同时出现时不重试', async () => {
  const { transientFailure } = await load();
  assert.equal(transientFailure('503 Service Unavailable: task inference budget exhausted'), false);
  assert.equal(transientFailure('ECONNRESET while reading; context window exceeded'), false);
});

test('重试等待时间默认 1、4、15 分钟，可用环境变量调短', async () => {
  const { retryDelays } = await load();
  assert.deepEqual(retryDelays({}), [60000, 240000, 900000]);
  assert.deepEqual(retryDelays({ XIN_RETRY_DELAYS_MS: '100,200' }), [100, 200]);
  assert.deepEqual(retryDelays({ XIN_RETRY_DELAYS_MS: 'x' }), [60000, 240000, 900000]);
});
