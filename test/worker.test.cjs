// Worker：资源缺失 404、/api 404、图片加缓存
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

async function loadWorker() {
  const src = fs.readFileSync(path.join(__dirname, '../src/worker.js'), 'utf8');
  return (await import('data:text/javascript,' + encodeURIComponent(src))).default;
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
