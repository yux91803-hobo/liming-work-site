// Worker：资源缺失 404、/api 404、图片加缓存
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { pathToFileURL } = require('node:url');
async function loadWorker() {
  return (await import(pathToFileURL(path.join(__dirname, '../src/worker.js')).href)).default;
}
const env = (status, type) => ({ ASSETS: { fetch: async () => new Response('x', { status, headers: { 'content-type': type } }) } });
const get = (w, p, e) => w.fetch(new Request('https://liming-work.com' + p), e);

test('图片缓存一天', async () => {
  const w = await loadWorker();
  const r = await get(w, '/tools/stm32/assets/teach-arch/teach-tim-23.webp', env(200, 'image/webp'));
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers.get('cache-control'), 'public, max-age=86400');
});

test('assets 下的 JS 不加缓存', async () => {
  const w = await loadWorker();
  const r = await get(w, '/tools/stm32/assets/registers.js', env(200, 'text/javascript'));
  assert.strictEqual(r.headers.get('cache-control'), null);
});

test('assets 缺失（SPA 回退成 HTML）→ 404', async () => {
  const w = await loadWorker();
  const r = await get(w, '/tools/stm32/assets/nope.webp', env(200, 'text/html'));
  assert.strictEqual(r.status, 404);
});

test('/api/* → 404', async () => {
  const w = await loadWorker();
  const r = await get(w, '/api/x', env(200, 'text/html'));
  assert.strictEqual(r.status, 404);
});

test('/api/xin/*、/api/tq/* 和别的 /api/* 一样回 404：小芯、天启 2026-11-26 删掉了，Worker 不再去读静态资源', async () => {
  const w = await loadWorker();
  let asked = 0;
  const e = { ASSETS: { fetch: async () => { asked++; return new Response('x', { status: 200, headers: { 'content-type': 'text/html' } }); } } };
  for (const p of ['/api/xin/me', '/api/xin/call', '/api/tq/me', '/api/tq/call']) {
    const r = await get(w, p, e);
    assert.strictEqual(r.status, 404, p);
    assert.deepStrictEqual(await r.json(), { error: 'not_found' });
  }
  assert.strictEqual(asked, 0);
});

test('Worker 不再导出小芯的 Durable Object，也没有定时任务处理', async () => {
  const mod = await import(pathToFileURL(path.join(__dirname, '../src/worker.js')).href);
  assert.deepStrictEqual(Object.keys(mod), ['default']);
  assert.deepStrictEqual(Object.keys(mod.default), ['fetch']);
});

test('wrangler：去掉 DO 绑定、登录限流、小芯的变量；v4 迁移删掉 XinTaskSupervisor（站长同意连同存的数据一起删）', () => {
  const text = require('node:fs').readFileSync(path.join(__dirname, '../wrangler.jsonc'), 'utf8');
  for (const gone of ['durable_objects', 'ratelimits', 'XIN_', 'version_metadata']) assert.ok(!text.includes(gone), gone);
  assert.match(text, /\{ "tag": "v4", "deleted_classes": \["XinTaskSupervisor"\] \}/);
  const lists = [...text.matchAll(/"run_worker_first":\s*(\[[^\]]*\])/g)].map(m => JSON.parse(m[1]));
  assert.strictEqual(lists.length, 2);
  for (const l of lists) assert.deepStrictEqual(l, ['/api/*', '/tools/*/assets/*']);
});
