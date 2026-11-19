// 所有权锁和记录（site/xin/vm-kernel-owner.mjs）：谁能写状态库。
// 设计见 docs/superpowers/specs/2026-11-14-xin-kernel-stage2-design.md §6.2：状态进程拿独占锁一直不放。
// 删旧模式第 2 步（docs/superpowers/specs/2026-11-17-xin-remove-legacy-design.md §4.1）：不是主人的进程一律不写，旧模式的共享锁写者没有了。
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const net = require('node:net');
const { execFile, spawn, spawnSync } = require('node:child_process'); const { pathToFileURL } = require('node:url');
const url = pathToFileURL(path.join(__dirname, '../site/xin/vm-kernel-owner.mjs')).href;
// 临时目录在进程退出时删（test/helpers/tmp.cjs）：在 t.after 里删会抢在停状态进程之前，撞上 ENOTEMPTY 时停进程的钩子被跳过，文件就退不出去
const { tmpDir } = require('./helpers/tmp.cjs'), home = () => tmpDir('xin-owner-');
// 另起一个进程执行一段脚本（脚本里有 o = new Ownership(dir, opts)）。line() 等下一行输出，exit() 等退出码
function proc(t, dir, body, opts = {}) {
  const child = spawn(process.execPath, ['--input-type=module', '-e',
    `import { Ownership } from ${JSON.stringify(url)}; const o = new Ownership(${JSON.stringify(dir)}, ${JSON.stringify(opts)}); ${body}`], { stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '', err = ''; const lines = [], waiters = [];
  const push = l => { const w = waiters.shift(); if (w) w.resolve(l); else lines.push(l); };
  child.stdout.on('data', d => { buf += d; for (let i; (i = buf.indexOf('\n')) >= 0;) { push(buf.slice(0, i)); buf = buf.slice(i + 1); } });
  child.stderr.on('data', d => { err += d; });
  const done = new Promise(r => child.on('exit', code => { for (const w of waiters.splice(0)) w.reject(new Error('进程没有输出就退出了（' + code + '）：' + err.split('\n').filter(l => !/ExperimentalWarning|trace-warnings/.test(l)).join(' ').slice(0, 300))); r(code); }));
  t.after(() => { try { child.kill('SIGKILL'); } catch { /* 已经退出 */ } });
  return { child, line: () => lines.length ? Promise.resolve(lines.shift()) : new Promise((resolve, reject) => waiters.push({ resolve, reject })), exit: () => done };
}
const OWNER = "const h = o.take(); console.log('held ' + h.epoch); process.stdin.on('end', () => { h.release(); process.exit(0); }); process.stdin.resume();";
const TRY_TAKE = "try { o.take({ waitMs: 200 }); console.log('took'); } catch (e) { console.log(e.code); }";
const pause = ms => new Promise(r => setTimeout(r, ms));

test('只有状态进程接管才提交第一笔所有权记录，库文件权限 0600', async t => {
  const dir = home(t), { Ownership } = await import(url), o = new Ownership(dir);
  t.after(() => o.close());
  assert.deepEqual(o.record(), { mode: 'legacy', epoch: 0, protocol: 0, since: 0 });
  assert.equal(o.owning, false);
  const lease = o.take();
  assert.equal(lease.epoch, 1);
  lease.release();
  assert.equal(fs.statSync(path.join(dir, 'owner.sqlite')).mode & 0o777, 0o600);
});

test('主人活着：独占锁挡住第二个所有权连接', async t => {
  const dir = home(t), { Ownership } = await import(url), o = new Ownership(dir, { waitMs: 50 });
  t.after(() => o.close());
  assert.equal(await proc(t, dir, OWNER).line(), 'held 1');
  assert.deepEqual(o.record(), { busy: true });
});

test('主人被 kill -9 后保留已提交记录，新主人接管次数只加一', async t => {
  const dir = home(t), { Ownership } = await import(url), o = new Ownership(dir, { waitMs: 50 });
  t.after(() => o.close());
  const p = proc(t, dir, OWNER); await p.line(); p.child.kill('SIGKILL'); await p.exit();
  const r = o.record(); assert.deepEqual([r.mode, r.epoch, r.protocol], ['kernel', 1, 1]);
  const next = o.take();
  assert.equal(next.epoch, 2);
  next.release();
});

test('主人正常退出保留模式和切换次数，下一个主人可以接手', async t => {
  const dir = home(t), { Ownership } = await import(url), o = new Ownership(dir, { waitMs: 50 });
  t.after(() => o.close());
  const p = proc(t, dir, OWNER); await p.line(); p.child.stdin.end(); assert.equal(await p.exit(), 0);
  const r = o.record(); assert.deepEqual([r.mode, r.epoch], ['kernel', 1]);
  assert.equal(await proc(t, dir, TRY_TAKE + ' setInterval(() => {}, 1000);').line(), 'took');
});

test('两个进程同时想当主人：只有一个拿到', async t => {
  const dir = home(t);
  assert.equal(await proc(t, dir, OWNER).line(), 'held 1');
  assert.equal(await proc(t, dir, TRY_TAKE).line(), 'owner_busy');
});

test('八个 CLI 并发遇到未启动的写者，只回未执行，随后可以接管', async t => {
  const dir = home(t);
  const call = () => new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [AGENT, 'sessions'],
      { env: { ...process.env, XIN_HOME: dir }, timeout: 10000 },
      (err, output) => err ? reject(err) : resolve(JSON.parse(output)));
    child.stdin.end('{}');
  });
  const results = await Promise.all(Array.from({ length: 8 }, call));
  for (const r of results) assert.deepEqual([r.error, r.executed], ['owner_unavailable', false]);
  for (const file of ['owner.sqlite', 'workflow.sqlite']) assert.equal(fs.existsSync(path.join(dir, file)), false);
  assert.equal(await proc(t, dir, OWNER).line(), 'held 1');
});

test('owner.sqlite 是软链接：拒绝', async t => {
  const { Ownership } = await import(url);
  for (const exists of [false, true]) {
    const dir = home(t), target = path.join(dir, 'elsewhere');
    if (exists) fs.writeFileSync(target, '');
    fs.symlinkSync(target, path.join(dir, 'owner.sqlite'));
    assert.throws(() => new Ownership(dir).take({ waitMs: 0 }), /软链接/);
    assert.equal(fs.existsSync(target), exists);
  }
});

test('owner.sqlite 是目录时拒绝接管', async t => {
  const dir = home(t), { Ownership } = await import(url);
  fs.mkdirSync(path.join(dir, 'owner.sqlite'));
  assert.throws(() => new Ownership(dir).take({ waitMs: 0 }), e => e.code !== 'owner_unavailable');
});

test('所有权记录损坏或协议不认识时拒绝，不把它猜成旧模式', async t => {
  const { Ownership, BRIDGE_PROTOCOL } = await import(url);
  for (const values of [
    { mode: 'unknown', epoch: '1', protocol: String(BRIDGE_PROTOCOL), since: '1' },
    { epoch: '1' },
    { mode: 'legacy', epoch: '1', protocol: String(BRIDGE_PROTOCOL + 1), since: '1' },
    { mode: 'legacy', epoch: 'broken', protocol: String(BRIDGE_PROTOCOL), since: '1' },
  ]) {
    const o = new Ownership(home(t)); t.after(() => o.close());
    const put = o.db.prepare('INSERT INTO owner(k,v) VALUES(?,?)');
    for (const [k, v] of Object.entries(values)) put.run(k, v);
    assert.throws(() => o.take({ waitMs: 0 }), e => e.code === 'owner_invalid');
    assert.equal(o.owning, false);
    assert.throws(() => o.record(), e => e.code === 'owner_invalid');
  }
});

test('改记录改到一半被 kill -9：读到的还是上一次提交的', async t => {
  const dir = home(t), { Ownership } = await import(url), o = new Ownership(dir, { waitMs: 2000 });
  t.after(() => o.close());
  o.record();   // 先把库建好
  const p = proc(t, dir, "o.db.exec('BEGIN EXCLUSIVE'); o.db.prepare(\"INSERT OR REPLACE INTO owner VALUES('mode','kernel')\").run(); console.log('dirty'); setInterval(() => {}, 1000);");
  await p.line(); p.child.kill('SIGKILL'); await p.exit();
  assert.equal(o.record().mode, 'legacy');
});

test('主人起了脱离的子进程（执行进程）然后自己退出：独占锁不被子进程带走，下一个主人拿得到', async t => {
  const dir = home(t);
  const p = proc(t, dir, "import('node:child_process').then(c => { o.take(); const k = c.spawn('sleep', ['20'], { detached: true, stdio: 'ignore' }); console.log(k.pid); k.unref(); setTimeout(() => process.exit(0), 50); });");
  const pid = Number(await p.line()); t.after(() => { try { process.kill(pid, 'SIGKILL'); } catch { /* 已经没了 */ } });
  await p.exit();
  assert.equal(await proc(t, dir, TRY_TAKE + ' setInterval(() => {}, 1000);').line(), 'took');
});

test('不停来问的非主人进程：等独占锁的主人不会被饿死', async t => {
  const dir = home(t), { Ownership } = await import(url);
  const monitor = new Ownership(dir); monitor.record(); monitor.close();
  const monitors = Array.from({ length: 4 }, () => proc(t, dir, 'setInterval(() => o.record({ waitMs: 0 }), 5);'));
  await pause(400);
  const t0 = performance.now();
  assert.equal(await proc(t, dir, "o.take({ waitMs: 3000 }); console.log('took'); setInterval(() => {}, 1000);").line(), 'took');
  assert.ok(performance.now() - t0 < 3000, '用了 ' + Math.round(performance.now() - t0) + ' 毫秒');
  for (const m of monitors) m.child.kill('SIGKILL');
});

// 控制器 CLI 只走套接字。长进程在启动前先确认状态进程已就绪。
const AGENT = path.join(__dirname, '../site/xin/vm-agent.mjs');
const cli = (dir, op, args = {}) => spawnSync(process.execPath, [AGENT, op], { env: { ...process.env, XIN_HOME: dir }, input: JSON.stringify(args), encoding: 'utf8' });

// 设计 §5「只有一个写者」：状态进程不在时，别的进程不写库、回「主人不在」；状态进程回来以后同一个请求重试成功、只执行一次
test('没有主人：控制器回 owner_unavailable（没执行），状态库没被建出来；状态进程起来以后同一句重试成功，只成一轮', async t => {
  const dir = home(t), bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  for (const cmd of ['claude', 'codex', 'agy']) fs.writeFileSync(path.join(bin, cmd), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const env = { ...process.env, XIN_HOME: dir, XIN_WORK: path.join(dir, 'work'), XIN_DSH: path.join(dir, 'no-dsh'), XIN_FRONT_PROVIDER: 'deepseek',
    XIN_AGY_HOME: dir, XIN_ANTIGRAVITY_BIN: '', CODEX_HOME: path.join(dir, 'codex'), CLAUDE_CONFIG_DIR: path.join(dir, 'claude'), PATH: bin + ':' + process.env.PATH };
  const send = () => JSON.parse(spawnSync(process.execPath, [AGENT, 'send'], { env, input: JSON.stringify({ main: true, text: '你好', clientId: 'owner-retry-0001' }), encoding: 'utf8' }).stdout);
  const first = send();
  assert.equal(first.error, 'owner_unavailable', JSON.stringify(first)); assert.equal(first.executed, false);
  assert.equal(fs.existsSync(path.join(dir, 'workflow.sqlite')), false, '没有主人：一个字节都不写');
  assert.equal(fs.existsSync(path.join(dir, 'owner.sqlite')), false, '一次性客户端连所有权库也不创建');
  require('./helpers/state-mode.cjs').stateMode(t, env);
  assert.equal(fs.statSync(path.join(dir, 'owner.sqlite')).mode & 0o777, 0o600);
  const ok = send(); assert.ok(ok.sid && ok.run, JSON.stringify(ok));
  assert.deepEqual(send(), ok, '同一句再送一次拿到同一个回执');
  assert.equal(JSON.parse(spawnSync(process.execPath, [AGENT, 'sessions'], { env, input: '{}', encoding: 'utf8' }).stdout).sessions.length, 1, '只开了一个对话');
  assert.deepEqual(fs.readdirSync(path.join(dir, 'runs')).filter(n => /^r[0-9a-z]+\.json$/.test(n)), [ok.run + '.json'], '只成一轮');
});

test('主人活着：控制器回 owner_unavailable，状态库没有被建出来', async t => {
  const dir = home(t);
  await proc(t, dir, OWNER).line();
  assert.equal(JSON.parse(cli(dir, 'sessions').stdout).error, 'owner_unavailable');
  assert.equal(fs.existsSync(path.join(dir, 'workflow.sqlite')), false);
});

test('状态健康检查未通过时长进程退出，不初始化数据库', async t => {
  const dir = home(t);
  fs.mkdirSync(path.join(dir, 'run'));
  const server = net.createServer({ allowHalfOpen: true }, socket => {
    socket.on('data', () => socket.end('{"v":0}\n'));
  });
  await new Promise(resolve => server.listen(path.join(dir, 'run', 'state.sock'), resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  for (const op of ['run', 'callback', 'memory-idle']) {
    const result = await new Promise(resolve => {
      execFile(process.execPath, [AGENT, op],
        { env: { ...process.env, XIN_HOME: dir }, timeout: 10000 }, (error, stdout, stderr) => resolve({ error, stderr }));
    });
    assert.equal(result.error?.code, 1, op);
    assert.match(result.stderr, /state_response/);
    assert.equal(fs.existsSync(path.join(dir, 'workflow.sqlite')), false);
    assert.equal(fs.existsSync(path.join(dir, 'owner.sqlite')), false);
  }
});

test('该内核当主人但它不在：控制器同样不写，不悄悄退回旧模式', async t => {
  const dir = home(t);
  const p = proc(t, dir, OWNER); await p.line(); p.child.kill('SIGKILL'); await p.exit();
  assert.equal(JSON.parse(cli(dir, 'sessions').stdout).error, 'owner_unavailable');
  assert.equal(fs.existsSync(path.join(dir, 'workflow.sqlite')), false);
});

test('owner.sqlite 打不开时状态进程退出，状态库尚未创建', async t => {
  const dir = home(t); fs.mkdirSync(path.join(dir, 'owner.sqlite'));
  const r = cli(dir, 'serve');
  assert.equal(r.status, 1);
  assert.equal(fs.existsSync(path.join(dir, 'workflow.sqlite')), false);
});

test('前台模型用的 xin 命令：主人活着时在标准错误里说明，退出码 1', async t => {
  const dir = home(t);
  await proc(t, dir, OWNER).line();
  const r = spawnSync(process.execPath, [AGENT, 'xin', 'task', 'list'], { env: { ...process.env, XIN_HOME: dir }, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /状态进程暂时不可用/);
  assert.equal(fs.existsSync(path.join(dir, 'workflow.sqlite')), false);
});
