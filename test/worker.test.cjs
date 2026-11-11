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

test('云电脑上的控制器脚本不对外：/xin/vm-*.mjs 一律 404，不去读静态资源', async () => {
  const w = await loadWorker();
  let asked = 0;
  const e = { ASSETS: { fetch: async () => { asked++; return new Response('// controller source', { status: 200, headers: { 'content-type': 'text/javascript' } }); } } };
  for (const p of ['/xin/vm-agent.mjs', '/xin/vm-memory.mjs', '/xin/vm-agent-0123456789ab.mjs']) {
    const r = await get(w, p, e);
    assert.strictEqual(r.status, 404);
    assert.doesNotMatch(await r.text(), /controller/);
  }
  assert.strictEqual(asked, 0);
  // 聊天页自己的脚本照常
  assert.strictEqual((await get(w, '/xin/chat.js', e)).status, 200);
  assert.strictEqual(asked, 1);
});

test('wrangler：正式站和测试站都让 Worker 先接住 /xin/vm-*', () => {
  const text = require('node:fs').readFileSync(path.join(__dirname, '../wrangler.jsonc'), 'utf8');
  const lists = [...text.matchAll(/"run_worker_first":\s*(\[[^\]]*\])/g)].map(m => JSON.parse(m[1]));
  assert.strictEqual(lists.length, 2);
  for (const l of lists) assert.ok(l.includes('/xin/vm-*'), JSON.stringify(l));
});
