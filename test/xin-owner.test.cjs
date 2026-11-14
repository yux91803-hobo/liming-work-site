// 所有权锁和记录（site/xin/vm-kernel-owner.mjs）：谁能写状态库。
// 设计见 docs/superpowers/specs/2026-11-14-xin-kernel-stage2-design.md §6.2：以后的状态进程拿独占锁一直不放，旧模式的写者每次写之前拿共享锁。
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn, spawnSync } = require('node:child_process'); const { pathToFileURL } = require('node:url');
const url = pathToFileURL(path.join(__dirname, '../site/xin/vm-kernel-owner.mjs')).href;
const home = t => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-owner-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
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
const OWNER = "const h = o.take(); console.log('held ' + h.epoch); process.stdin.on('end', () => { h.release('legacy'); process.exit(0); }); process.stdin.resume();";
const TRY_TAKE = "try { o.take({ waitMs: 200 }); console.log('took'); } catch (e) { console.log(e.code); }";
const pause = ms => new Promise(r => setTimeout(r, ms));

test('新目录：没有记录就是旧模式；写入口放行；库文件权限 0600', async t => {
  const dir = home(t), { Ownership } = await import(url), o = new Ownership(dir);
  t.after(() => o.close());
  assert.deepEqual(o.record(), { mode: 'legacy', epoch: 0, protocol: 0, since: 0 });
  const release = o.enter(); release();
  assert.equal(fs.statSync(path.join(dir, 'owner.sqlite')).mode & 0o777, 0o600);
});

test('主人活着：写入口被拒（alive），记录读出来是 busy', async t => {
  const dir = home(t), { Ownership } = await import(url), o = new Ownership(dir, { waitMs: 50 });
  t.after(() => o.close());
  assert.equal(await proc(t, dir, OWNER).line(), 'held 1');
  assert.throws(() => o.enter(), e => e.code === 'owner_unavailable' && e.status === 'alive');
  assert.deepEqual(o.record(), { busy: true });
});

test('主人被 kill -9：锁放掉，记录仍归内核，写入口照样拒（missing）；set(legacy) 之后放行', async t => {
  const dir = home(t), { Ownership } = await import(url), o = new Ownership(dir, { waitMs: 50 });
  t.after(() => o.close());
  const p = proc(t, dir, OWNER); await p.line(); p.child.kill('SIGKILL'); await p.exit();
  assert.throws(() => o.enter(), e => e.code === 'owner_unavailable' && e.status === 'missing');
  const r = o.record(); assert.deepEqual([r.mode, r.epoch, r.protocol], ['kernel', 1, 1]);
  assert.deepEqual(o.set('legacy'), { epoch: 2 });
  o.enter()();
});

test('主人正常交回：release(legacy) 之后写入口放行，切换次数再加一', async t => {
  const dir = home(t), { Ownership } = await import(url), o = new Ownership(dir, { waitMs: 50 });
  t.after(() => o.close());
  const p = proc(t, dir, OWNER); await p.line(); p.child.stdin.end(); assert.equal(await p.exit(), 0);
  const r = o.record(); assert.deepEqual([r.mode, r.epoch], ['legacy', 2]);
  o.enter()();
});

test('旧模式的写者还在写：主人等它写完才拿到', async t => {
  const dir = home(t), { Ownership } = await import(url), o = new Ownership(dir);
  t.after(() => o.close());
  const release = o.enter();
  const p = proc(t, dir, OWNER); let held = false; p.line().then(() => { held = true; }, () => {});
  await pause(400); assert.equal(held, false);
  release();
  await pause(400); assert.equal(held, true);
});

test('可重入：外层还拿着时里层放了不算放', async t => {
  const dir = home(t), { Ownership } = await import(url), o = new Ownership(dir);
  t.after(() => o.close());
  const outer = o.enter(), inner = o.enter(); inner();
  assert.equal(await proc(t, dir, TRY_TAKE).line(), 'owner_busy');
  outer();
  assert.equal(await proc(t, dir, TRY_TAKE + ' setInterval(() => {}, 1000);').line(), 'took');
});

test('两个进程同时想当主人：只有一个拿到', async t => {
  const dir = home(t);
  assert.equal(await proc(t, dir, OWNER).line(), 'held 1');
  assert.equal(await proc(t, dir, TRY_TAKE).line(), 'owner_busy');
});

test('八个进程同时第一次用：都拿得到共享锁', async t => {
  const dir = home(t);
  const codes = await Promise.all(Array.from({ length: 8 }, () => proc(t, dir, 'o.enter()(); process.exit(0);').exit()));
  assert.deepEqual(codes, Array(8).fill(0));
});

test('owner.sqlite 是软链接：拒绝', async t => {
  const { Ownership } = await import(url);
  for (const exists of [false, true]) {
    const dir = home(t), target = path.join(dir, 'elsewhere');
    if (exists) fs.writeFileSync(target, '');
    fs.symlinkSync(target, path.join(dir, 'owner.sqlite'));
    assert.throws(() => new Ownership(dir).enter(), /软链接/);
    assert.equal(fs.existsSync(target), exists);
  }
});

test('owner.sqlite 打不开（被建成了目录）：写入口抛错，不当成旧模式', async t => {
  const dir = home(t), { Ownership } = await import(url);
  fs.mkdirSync(path.join(dir, 'owner.sqlite'));
  assert.throws(() => new Ownership(dir).enter(), e => e.code !== 'owner_unavailable');
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
    assert.throws(() => o.enter(), e => e.code === 'owner_invalid');
    assert.equal(o.depth, 0);
    assert.throws(() => o.record(), e => e.code === 'owner_invalid');
  }
});

test('改记录改到一半被 kill -9：读到的还是上一次提交的，写入口照常', async t => {
  const dir = home(t), { Ownership } = await import(url), o = new Ownership(dir, { waitMs: 2000 });
  t.after(() => o.close());
  o.enter()();
  const p = proc(t, dir, "o.db.exec('BEGIN EXCLUSIVE'); o.db.prepare(\"INSERT OR REPLACE INTO owner VALUES('mode','kernel')\").run(); console.log('dirty'); setInterval(() => {}, 1000);");
  await p.line(); p.child.kill('SIGKILL'); await p.exit();
  assert.equal(o.record().mode, 'legacy');
  o.enter()();
});

test('拿着共享锁时起了脱离的子进程然后自己退出：锁不被子进程带走', async t => {
  const dir = home(t);
  const p = proc(t, dir, "import('node:child_process').then(c => { o.hold(); const k = c.spawn('sleep', ['20'], { detached: true, stdio: 'ignore' }); console.log(k.pid); k.unref(); setTimeout(() => process.exit(0), 50); });");
  const pid = Number(await p.line()); t.after(() => { try { process.kill(pid, 'SIGKILL'); } catch { /* 已经没了 */ } });
  await p.exit();
  assert.equal(await proc(t, dir, TRY_TAKE + ' setInterval(() => {}, 1000);').line(), 'took');
});

test('源源不断的旧写者：等独占锁的主人不会被饿死', async t => {
  const dir = home(t), { Ownership } = await import(url);
  new Ownership(dir).enter()();   // 先把库建好
  const writers = Array.from({ length: 4 }, () => proc(t, dir, 'setInterval(() => { try { const r = o.enter(); const end = Date.now() + 15; while (Date.now() < end); r(); } catch { /* 主人来了 */ } }, 20);'));
  await pause(400);
  const t0 = Date.now();
  assert.equal(await proc(t, dir, "o.take({ waitMs: 3000 }); console.log('took'); setInterval(() => {}, 1000);").line(), 'took');
  assert.ok(Date.now() - t0 < 3000, '用了 ' + (Date.now() - t0) + ' 毫秒');
  for (const w of writers) w.child.kill('SIGKILL');
});

// ── 控制器：一次性进程从头到尾拿着共享锁；主人活着或该内核当主人时，旧入口一个字节都不写 ──
const AGENT = path.join(__dirname, '../site/xin/vm-agent.mjs');
const cli = (dir, op, args = {}) => spawnSync(process.execPath, [AGENT, op], { env: { ...process.env, XIN_HOME: dir }, input: JSON.stringify(args), encoding: 'utf8' });

test('旧模式：控制器照常工作，并建好 owner.sqlite', async t => {
  const dir = home(t), r = cli(dir, 'sessions');
  assert.deepEqual(JSON.parse(r.stdout), { sessions: [] });
  assert.equal(fs.statSync(path.join(dir, 'owner.sqlite')).mode & 0o777, 0o600);
});

test('主人活着：控制器回 owner_unavailable，状态库没有被建出来', async t => {
  const dir = home(t);
  await proc(t, dir, OWNER).line();
  assert.equal(JSON.parse(cli(dir, 'sessions').stdout).error, 'owner_unavailable');
  assert.equal(fs.existsSync(path.join(dir, 'workflow.sqlite')), false);
});

test('主人活着时长进程的启动恢复也不能创建状态库', async t => {
  for (const op of ['run', 'callback', 'memory-idle']) {
    const dir = home(t); await proc(t, dir, OWNER).line();
    const r = cli(dir, op);
    assert.notEqual(r.status, 0, op + ' 不能越过恢复入口');
    assert.match(r.stderr, /owner_alive/);
    assert.equal(fs.existsSync(path.join(dir, 'workflow.sqlite')), false);
  }
});

test('该内核当主人但它不在：控制器同样不写，不悄悄退回旧模式', async t => {
  const dir = home(t);
  const p = proc(t, dir, OWNER); await p.line(); p.child.kill('SIGKILL'); await p.exit();
  assert.equal(JSON.parse(cli(dir, 'sessions').stdout).error, 'owner_unavailable');
  assert.equal(fs.existsSync(path.join(dir, 'workflow.sqlite')), false);
});

test('owner.sqlite 打不开：控制器非零退出，状态库没有被建出来', async t => {
  const dir = home(t); fs.mkdirSync(path.join(dir, 'owner.sqlite'));
  const r = cli(dir, 'sessions');
  assert.notEqual(r.status, 0);
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
