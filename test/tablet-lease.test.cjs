// 云端插件 liming-lease（装在 li、li2 的 web 配置里，设计 §5.8）：平板的对话在忙或有后台命令在跑时，
// 持有 InstaBox 活动租约 tablet-cloud（ttl 3600 秒、每 20 分钟续一次），全部空闲 2 分钟后释放；任何失败只记日志、不影响任务。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.join(__dirname, '../site/tablet/liming-lease');
const lib = file => import(pathToFileURL(path.join(root, 'lib', file)).href);
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 2000) { const t0 = performance.now(); for (;;) { const v = await fn(); if (v) return v; if (performance.now() - t0 > ms) return null; await sleep(5); } }

const KEY = 'ibk_write_SECRET_lease_9876';
function fakeInstabox({ machines = [{ id: 'm_li2', name: 'li2' }], fail = null } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ method: init.method || 'GET', path: u.pathname, body: init.body ? JSON.parse(init.body) : null, key: (init.headers || {})['X-API-Key'] });
    if (fail) { const f = fail(init.method || 'GET', u.pathname); if (f instanceof Error) throw f; if (f) return new Response(JSON.stringify({ error: { code: 'x', message: `bad ${KEY}` } }), { status: f }); }
    if ((init.method || 'GET') === 'GET' && u.pathname === '/v1/machines') return new Response(JSON.stringify({ machines }), { status: 200 });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  return { calls, fetchImpl, leaseCalls: () => calls.filter(c => c.path.includes('/activity-leases/')) };
}

async function keeper(t, opts = {}) {
  const { createLeaseKeeper } = await lib('lease.js');
  const logs = [];
  const ib = opts.ib || fakeInstabox();
  const k = createLeaseKeeper({
    readKey: () => (opts.key === undefined ? KEY : opts.key),
    machineName: () => (opts.name === undefined ? 'li2' : opts.name),
    fetchImpl: ib.fetchImpl,
    logger: { info: m => logs.push(m), warn: m => logs.push(m) },
    renewMs: opts.renewMs ?? 40,
    releaseAfterMs: opts.releaseAfterMs ?? 60,
    retryMs: 20,
  });
  t.after(() => k.dispose());
  return { k, ib, logs };
}

test('忙起来立刻拿租约 tablet-cloud（ttl 3600 秒），一直忙就按间隔续', async (t) => {
  const { k, ib } = await keeper(t);
  k.setBusy('agent:s1', true);
  assert.ok(await until(() => ib.leaseCalls().length >= 1));
  const first = ib.leaseCalls()[0];
  assert.equal(first.method, 'PUT');
  assert.equal(first.path, '/v1/machines/m_li2/activity-leases/tablet-cloud');
  assert.deepEqual(first.body, { ttlSeconds: 3600 });
  assert.equal(first.key, KEY);
  assert.ok(await until(() => ib.leaseCalls().filter(c => c.method === 'PUT').length >= 3, 1000), '续了两次以上');
  assert.equal(ib.leaseCalls().some(c => c.method === 'DELETE'), false);
  const { DEFAULTS } = await lib('lease.js');
  assert.deepEqual({ ttl: DEFAULTS.ttlSeconds, renew: DEFAULTS.renewMs, release: DEFAULTS.releaseAfterMs }, { ttl: 3600, renew: 20 * 60e3, release: 2 * 60e3 });
});

test('对话闲了但后台命令还在跑：不放；全部空闲满 2 分钟（测试里缩短）才释放；中途又忙就不放', async (t) => {
  const { k, ib } = await keeper(t, { renewMs: 10_000, releaseAfterMs: 60 });
  k.setBusy('agent:s1', true);
  k.setBusy('job:bash-1', true);
  assert.ok(await until(() => ib.leaseCalls().length === 1));
  k.setBusy('agent:s1', false);
  await sleep(120);
  assert.equal(ib.leaseCalls().filter(c => c.method === 'DELETE').length, 0, '后台命令还在跑');
  k.setBusy('job:bash-1', false);
  await sleep(30);
  k.setBusy('agent:s2', true);
  await sleep(100);
  assert.equal(ib.leaseCalls().filter(c => c.method === 'DELETE').length, 0, '2 分钟内又忙了，不放');
  k.setBusy('agent:s2', false);
  assert.ok(await until(() => ib.leaseCalls().some(c => c.method === 'DELETE'), 1000));
  assert.equal(ib.leaseCalls().at(-1).path, '/v1/machines/m_li2/activity-leases/tablet-cloud');
  assert.equal(k.state().held, false);
});

test('按名字找机器：唯一才拿租约；找不到、同名两台都不拿，只记日志', async (t) => {
  for (const [machines, why] of [[[{ id: 'm_x', name: 'other' }], /找不到/], [[{ id: 'm_a', name: 'li2' }, { id: 'm_b', name: 'li2' }], /2 台/]]) {
    const { k, ib, logs } = await keeper(t, { ib: fakeInstabox({ machines }) });
    k.setBusy('agent:s1', true);
    await sleep(80);
    assert.equal(ib.leaseCalls().length, 0);
    assert.ok(logs.some(l => why.test(l)), logs.join('\n'));
  }
  const { k, ib } = await keeper(t, { ib: fakeInstabox({ machines: [{ id: 'm_x', name: 'other' }, { id: 'm_li2', name: 'li2' }] }) });
  k.setBusy('agent:s1', true);
  assert.ok(await until(() => ib.leaseCalls().length >= 1));
});

test('没有 key、401/403/500、断网：只记日志、不抛错，忙的时候过一会儿再试；日志里从不出现 key', async (t) => {
  const none = await keeper(t, { key: null });
  assert.doesNotThrow(() => none.k.setBusy('agent:s1', true));
  await sleep(50);
  assert.equal(none.ib.calls.length, 0);
  assert.ok(none.logs.some(l => /lease\.key/.test(l)));
  for (const fail of [() => 401, () => 403, () => 500, () => new Error(`ECONNRESET ${KEY}`)]) {
    let first = true;
    const ib = fakeInstabox({ fail: (m, p) => { if (m === 'PUT' && first) { first = false; return fail(); } return null; } });
    const { k, logs } = await keeper(t, { ib });
    assert.doesNotThrow(() => k.setBusy('agent:s1', true));
    assert.ok(await until(() => ib.leaseCalls().filter(c => c.method === 'PUT').length >= 2, 1000), '失败后重试');
    assert.ok(logs.length > 0);
    for (const l of logs) assert.ok(!l.includes('SECRET_lease'), l);
  }
});

test('卸载时清掉定时器，拿着租约就尽量放掉', async (t) => {
  const { k, ib } = await keeper(t, { renewMs: 30 });
  k.setBusy('agent:s1', true);
  assert.ok(await until(() => k.state().held));
  await k.dispose();
  const n = ib.leaseCalls().length;
  assert.equal(ib.leaseCalls().at(-1).method, 'DELETE');
  await sleep(100);
  assert.equal(ib.leaseCalls().length, n, '卸载后不再续');
});

test('续约时刻落在空闲缓冲期，再次忙起来会恢复续约', async (t) => {
  const { k, ib } = await keeper(t, { renewMs: 40, releaseAfterMs: 1000 });
  k.setBusy('agent:s1', true);
  assert.ok(await until(() => k.state().held));
  k.setBusy('agent:s1', false);
  await sleep(100);
  assert.equal(ib.leaseCalls().length, 1);
  k.setBusy('agent:s1', true);
  assert.ok(await until(() => ib.leaseCalls().some((call, index) => index > 0 && call.method === 'PUT'), 300));
  assert.ok(!ib.leaseCalls().some(call => call.method === 'DELETE'));
});

test('首次 PUT 已发出但回执丢失，卸载时仍尝试释放', async (t) => {
  const ib = fakeInstabox({ fail: method => method === 'PUT' ? new Error('connection closed') : null });
  const { k } = await keeper(t, { ib });
  k.setBusy('agent:s1', true);
  assert.ok(await until(() => k.state().lastError));
  await k.dispose();
  assert.equal(ib.leaseCalls().at(-1).method, 'DELETE');
});

test('读 ~/.liming-cloud 下的 lease.key 和 machine-name；权限太宽会提醒', async (t) => {
  const { readLeaseFiles } = await lib('lease.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tablet-lease-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(readLeaseFiles(dir), { key: null, name: null, warnings: [] });
  fs.writeFileSync(path.join(dir, 'lease.key'), `${KEY}\n`, { mode: 0o600 });
  fs.chmodSync(path.join(dir, 'lease.key'), 0o644);
  fs.writeFileSync(path.join(dir, 'machine-name'), 'li2\n');
  const r = readLeaseFiles(dir);
  assert.equal(r.key, KEY);
  assert.equal(r.name, 'li2');
  assert.ok(r.warnings.some(w => /600/.test(w)));
  fs.chmodSync(path.join(dir, 'lease.key'), 0o600);
  assert.deepEqual(readLeaseFiles(dir).warnings, []);
});

test('插件入口：零依赖，听 agent/status 和对话里的后台命令登记、结束；没有 lease.key 也照常加载', async (t) => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'liming-lease');
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.engines.dsh, '>=0.2.1-rc.2 <0.3.0-0');
  const plugin = await lib('index.js');
  assert.equal(plugin.name, 'liming-lease');
  const handlers = {};
  const effects = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tablet-lease-entry-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  plugin.apply({ on: (n, f) => { handlers[n] = f; return () => {}; }, effect: f => effects.push(f) }, { dir });
  assert.equal(typeof handlers['agent/status'], 'function');
  assert.equal(typeof handlers['session/event'], 'function');
  const dispose = effects[0]();
  handlers['agent/status']({ agent: { id: 's1' }, status: 'running' });
  handlers['session/event']({ id: 's1' }, { type: 'job/registered', data: { jobId: 'bash-1' } });
  handlers['session/event']({ id: 's1' }, { type: 'job/settled', data: { jobId: 'bash-1' } });
  handlers['agent/status']({ agent: { id: 's1' }, status: 'idle' });
  await dispose();
});
