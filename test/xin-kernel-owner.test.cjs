// 第 2 批（docs/superpowers/plans/2026-11-15-xin-state-owner-switch.md Task 3）：真的内核外壳 + 真的状态进程。
// 只用临时目录和合成数据（假的 codex），不碰正式电脑。控制器整套拷进 home/agent/，入口叫 vm-agent-0123456789ab.mjs，和正式电脑上一样
// （软链接不行：Node 按真实路径认自己，main() 不会跑）。
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn, spawnSync } = require('node:child_process'), { pathToFileURL } = require('node:url');
const { stopOwned } = require('./helpers/stop-owned.cjs'), { platformTimeout } = require('./helpers/timeout.cjs');
const SRC = path.join(__dirname, '../site/xin/vm-agent.mjs'), JUMP = path.join(__dirname, 'helpers/clock-jump.cjs'), FRONT = path.join(__dirname, 'helpers/front-responses.cjs');
const url = name => pathToFileURL(path.join(__dirname, '../site/xin/' + name + '.mjs')).href;
const KEY = Buffer.alloc(32, 7).toString('base64url');
const KERNEL = gen => ({ mode: 'kernel', gen });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, ms = platformTimeout(10000)) {
  const end = performance.now() + ms;
  for (;;) { const v = await check(); if (v || performance.now() > end) return v; await sleep(25); }
}

async function fixture(t, { env: extra = {}, keeper = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-owner-')), home = path.join(dir, 'xin'), bin = path.join(dir, 'bin');
  for (const d of [bin, path.join(home, 'agent'), path.join(home, 'sessions'), path.join(home, 'runs'), path.join(dir, 'work')]) fs.mkdirSync(d, { recursive: true });
  for (const name of ['codex', 'claude', 'agy', 'dsh']) fs.writeFileSync(path.join(bin, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  // 前台模型用测试替身（test/helpers/front-responses.cjs）：不联网，回「做好了」；XIN_FRONT_TEST_DELAY 让这一轮做得久一点
  const preload = ['--require=' + FRONT, ...(extra.preload || [])].join(' ');
  delete extra.preload;
  const env = { ...process.env, XIN_HOME: home, XIN_WORK: path.join(dir, 'work'), XIN_DSH: path.join(bin, 'dsh'), XIN_AGY_HOME: dir, XIN_ANTIGRAVITY_BIN: '',
    XIN_FRONT_PROVIDER: 'deepseek', XIN_FRONT_TEST_TEXT: '做好了', XIN_FRONT_TEST_LOG: path.join(dir, 'front.jsonl'), NODE_OPTIONS: ((process.env.NODE_OPTIONS || '') + ' ' + preload).trim(),
    CODEX_HOME: path.join(dir, 'codex'), CLAUDE_CONFIG_DIR: path.join(dir, 'claude'), PATH: bin + ':' + process.env.PATH, ...extra };
  fs.writeFileSync(path.join(home, 'kernel-keys.json'), JSON.stringify({ v: 1, keys: { ka: KEY } }), { mode: 0o600 });
  for (const name of fs.readdirSync(path.dirname(SRC)).filter(n => /^vm-.*\.mjs$/.test(n))) fs.copyFileSync(path.join(path.dirname(SRC), name), path.join(home, 'agent', name));
  const agent = path.join(home, 'agent', 'vm-agent-0123456789ab.mjs'); fs.copyFileSync(SRC, agent);
  const K = await import(url('vm-kernel')), W = await import(pathToFileURL(path.join(__dirname, '../src/xin-kernel.js')).href);
  const kernels = [];
  const start = async (o = {}) => { const k = await K.createKernel({ home, env, keeper: { backoffMs: [50, 100], ...keeper }, ...o }); kernels.push(k); return k; };
  const f = { dir, home, env, agent, k: await start() };
  t.after(async () => { for (const k of kernels) await k.close().catch(() => {}); await stopOwned(home, dir, platformTimeout(10000)); });
  const request = async (method, target, body) => {
    const text = body === undefined ? '' : JSON.stringify(body);
    const headers = { 'x-xin-auth': await W.signKernelRequest({ key: KEY, kid: 'ka', method, target, body: text }) };
    if (text) headers['content-type'] = 'application/json';
    return fetch('http://127.0.0.1:' + f.k.port + target, { method, headers, body: text || undefined });
  };
  f.op = async (op, args = {}, owner) => { const r = await request('POST', '/xin/op', { agent, op, args, ...(owner ? { owner } : {}) }); return { status: r.status, body: await r.json() }; };
  f.health = async () => (await request('GET', '/xin/health')).json();
  f.running = (not = null) => until(async () => { const h = await f.health(); return h.owner.phase === 'running' && h.owner.pid !== not && h; });
  f.record = async () => { const { Ownership } = await import(url('vm-kernel-owner')); const o = new Ownership(home); try { return o.record({ waitMs: 0 }); } finally { o.close(); } };
  f.settle = async (run, owner) => {
    for (const end = performance.now() + platformTimeout(20000); performance.now() < end; await sleep(50)) {
      const r = await f.op('poll', { run }, owner);
      if (r.body.ok && r.body.data.done) return r.body.data;
    }
    assert.fail('这一轮没收尾：' + run);
  };
  // 第 1 批的外壳：每个操作起一个控制器，请求不带期望
  f.cli = (op, args = {}) => { const r = spawnSync(process.execPath, [agent, op], { env, input: JSON.stringify(args), encoding: 'utf8', timeout: platformTimeout(20000) }); assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); };
  return f;
}
const runFiles = f => fs.readdirSync(path.join(f.home, 'runs')).filter(n => /^r[0-9a-z]{6,24}\.json$/.test(n)).length;
const broke = data => data.events.some(e => e.t === 'err' && /中途断了/.test(e.text || ''));

test('内核模式：send、poll、sessions、tasks 都不起控制器；结果和旧模式一样', async t => {
  const seen = {};
  for (const mode of ['legacy', 'kernel']) {
    const f = await fixture(t), owner = mode === 'kernel' ? KERNEL(1) : undefined;
    if (owner) { await f.op('sessions', {}, owner); assert.ok(await f.running(), '状态进程起来了'); }
    const before = (await f.health()).spawns;
    const sent = await f.op('send', { main: true, text: '第一句', clientId: 'owner-mode-00001' }, owner);
    assert.equal(sent.body.ok, true, JSON.stringify(sent.body));
    const done = await f.settle(sent.body.data.run, owner);
    const sessions = await f.op('sessions', {}, owner), tasks = await f.op('tasks', {}, owner);
    seen[mode] = { send: Object.keys(sent.body.data).sort(), done: done.events.filter(e => e.t === 'done').length, sessions: sessions.body.data.sessions.length,
      tasks: Object.keys(tasks.body.data).sort(), texts: done.events.filter(e => e.t === 'text').map(e => e.text) };
    const spawned = (await f.health()).spawns - before;
    if (owner) assert.equal(spawned, 0, '内核模式：一次都没起控制器'); else assert.ok(spawned > 3, '旧模式：每次操作起一个控制器');
  }
  assert.deepEqual(seen.kernel, seen.legacy);
});

test('带编号的 send：执行前被杀重送只成一轮；执行后被杀重送拿到同一回执；同编号不同内容报冲突', async t => {
  const f = await fixture(t), owner = KERNEL(1), args = { main: true, text: '第一句', clientId: 'owner-kill-00001' };
  await f.op('sessions', {}, owner); const h1 = await f.running(); assert.ok(h1);
  process.kill(h1.owner.pid, 'SIGSTOP');   // 请求进了套接字还没处理，状态进程就被杀
  const pending = f.op('send', args, owner);
  await sleep(300); process.kill(h1.owner.pid, 'SIGKILL');
  const lost = await pending;
  assert.equal(lost.body.ok, false); assert.notEqual(lost.body.executed, true, JSON.stringify(lost.body));
  const h2 = await f.running(h1.owner.pid); assert.ok(h2, '重起了');
  const a = await f.op('send', args, owner); assert.equal(a.body.ok, true, JSON.stringify(a.body));
  await f.settle(a.body.data.run, owner);
  process.kill(h2.owner.pid, 'SIGKILL');   // 回了以后被杀
  assert.ok(await f.running(h2.owner.pid));
  assert.deepEqual((await f.op('send', args, owner)).body.data, a.body.data, '同一编号拿到同一回执');
  assert.equal((await f.op('send', { ...args, text: '不同内容' }, owner)).body.data.error, 'message_conflict');
  assert.equal(runFiles(f), 1, '只成了一轮');
});

test('状态进程被 kill -9：外壳重起它，空档里来报告的执行进程稍等后交给新主人；切换次数变大', async t => {
  // 这一轮做 1.5 秒（实测约第 1.9 秒收尾）；状态进程在第 0.6 秒被杀、外壳等 3 秒才重起（约第 3.7 秒就绪）：执行进程报告的时候主人一定不在
  const f = await fixture(t, { env: { XIN_FRONT_TEST_DELAY: '1500' }, keeper: { backoffMs: [3000] } }), owner = KERNEL(1);
  await f.op('sessions', {}, owner); const h1 = await f.running(); assert.ok(h1);
  const sent = await f.op('send', { main: true, text: '慢慢做', clientId: 'owner-runner-0001' }, owner);
  assert.equal(sent.body.ok, true, JSON.stringify(sent.body));
  await sleep(600);
  const killAt = Date.now(); process.kill(h1.owner.pid, 'SIGKILL');
  const t0 = performance.now(), done = await f.settle(sent.body.data.run, owner);
  // 报告没送到就崩了的话，主人 15 秒后会把这一轮重派一遍（模型被调两次）：这里要求一次、而且很快收尾
  assert.ok(performance.now() - t0 < platformTimeout(8000), '收尾太慢：' + Math.round(performance.now() - t0) + ' 毫秒');
  assert.equal(fs.readFileSync(path.join(f.dir, 'front.jsonl'), 'utf8').split('\n').filter(l => l.includes('慢慢做')).length, 1, '这一轮只做了一遍');
  assert.equal(done.events.filter(e => e.t === 'done').length, 1);
  assert.ok(!broke(done), JSON.stringify(done.events));
  assert.ok(done.events.some(e => e.t === 'text' && /做好了/.test(e.text)), JSON.stringify(done.events));
  const h2 = await f.health(); assert.ok(h2.owner.epoch > h1.owner.epoch); assert.notEqual(h2.owner.pid, h1.owner.pid);
  const ready = fs.readFileSync(path.join(f.home, 'logs', 'kernel.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(e => e.route === 'state' && e.event === 'ready' && e.at > killAt);
  const tail = fs.readFileSync(path.join(f.home, 'runs', sent.body.data.run + '.jsonl'), 'utf8');
  assert.ok(ready.length && JSON.parse(fs.readFileSync(path.join(f.home, 'runs', sent.body.data.run + '.json'), 'utf8')).started < ready[0].at, '新主人就绪前这一轮已经在跑');
  assert.ok(tail.includes('做好了'));
});

test('外壳正常停止：状态进程排空、记录回 legacy；不发期望的旧外壳照常起控制器写（模拟回滚到第 1 批）', async t => {
  const f = await fixture(t), owner = KERNEL(1);
  await f.op('sessions', {}, owner); assert.ok(await f.running());
  assert.equal((await f.record()).busy, true);
  await f.k.close({ release: true });
  assert.equal((await f.record()).mode, 'legacy');
  const sent = f.cli('send', { main: true, text: '回滚以后', clientId: 'owner-rollback-01' });
  assert.ok(sent.run, JSON.stringify(sent));
  let done = null;
  for (const end = performance.now() + platformTimeout(20000); !done && performance.now() < end; await sleep(50)) { const p = f.cli('poll', { run: sent.run }); if (p.done) done = p; }
  assert.ok(done, '旧路径做完了这一轮'); assert.ok(!broke(done));
});

test('墙上时钟在状态进程里往前跳 2 小时：之后的请求照常回答，状态进程不退出', async t => {
  const f = await fixture(t, { env: { preload: ['--require=' + JUMP] } }), owner = KERNEL(1);
  await f.op('sessions', {}, owner); const h = await f.running(); assert.ok(h);
  fs.writeFileSync(path.join(f.home, 'clock-jump'), String(2 * 3600e3)); await sleep(300);
  for (let i = 0; i < 20; i++) {
    const t0 = performance.now(), r = await f.op('sessions', {}, owner);
    assert.equal(r.body.ok, true, JSON.stringify(r.body)); assert.ok(performance.now() - t0 < platformTimeout(2000), '第 ' + i + ' 次太慢');
  }
  const sent = await f.op('send', { main: true, text: '跳了以后', clientId: 'owner-jump-00001' }, owner);
  assert.equal(sent.body.ok, true, JSON.stringify(sent.body));
  assert.ok(!broke(await f.settle(sent.body.data.run, owner)));
  const after = await f.health(); assert.equal(after.owner.pid, h.owner.pid); assert.equal(after.owner.phase, 'running');
});

test('控制器不停起退时拉起状态进程：20 轮都能起来，没有 state_compat', async t => {
  const f = await fixture(t);
  let stop = false;
  const churn = (async () => {
    while (!stop) await new Promise(resolve => { const c = spawn(process.execPath, [f.agent, 'sessions'], { env: f.env, stdio: ['pipe', 'ignore', 'ignore'] }); c.stdin.end('{}'); c.on('exit', resolve); });
  })();
  t.after(async () => { stop = true; await churn; });
  for (let gen = 1; gen < 40; gen += 2) {
    await f.op('sessions', {}, KERNEL(gen));
    const h = await f.running(); assert.ok(h, '第 ' + ((gen + 1) / 2) + ' 轮没起来：' + JSON.stringify((await f.health()).owner));
    await f.op('sessions', {}, { mode: 'legacy', gen: gen + 1 });
    assert.ok(await until(async () => (await f.health()).owner.phase === 'off'), '第 ' + ((gen + 1) / 2) + ' 轮没停下');
  }
  stop = true; await churn;
  assert.notEqual((await f.health()).owner.lastError, 'state_compat');
});

test('反复调用 2000 次：状态进程的内存和打开的文件不一直涨', async t => {
  const f = await fixture(t), owner = KERNEL(1);
  await f.op('sessions', {}, owner); const h = await f.running(); assert.ok(h);
  const rss = () => Number(/VmRSS:\s+(\d+)/.exec(fs.readFileSync('/proc/' + h.owner.pid + '/status', 'utf8'))[1]) * 1024;
  const fds = () => fs.readdirSync('/proc/' + h.owner.pid + '/fd').length;
  for (let i = 0; i < 200; i++) await f.op('sessions', {}, owner);
  const r0 = rss(), f0 = fds();
  for (let i = 0; i < 1800; i++) await f.op('sessions', {}, owner);
  assert.ok(rss() - r0 < 30 * 1048576, 'rss 多了 ' + Math.round((rss() - r0) / 1048576) + ' MB');
  assert.ok(fds() <= f0 + 2, 'fd ' + f0 + ' → ' + fds());
  const after = await f.health(); assert.equal(after.owner.pid, h.owner.pid); assert.equal(after.spawns, 0);
});
