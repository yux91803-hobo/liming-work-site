const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const { platformTimeout } = require('./helpers/timeout.cjs');
const runtime = () => import(pathToFileURL(path.join(__dirname, '../site/xin/vm-runtime.mjs')).href);
const protocol = () => import(pathToFileURL(path.join(__dirname, '../site/xin/vm-task-bridge.mjs')).href);
const run = 'rbridge001', attempt = 'a'.repeat(32), id = 'b'.repeat(24);
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-task-bridge-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const w = { io: path.join(root, 'io'), work: path.join(root, 'work'), home: path.join(root, 'home'), tmp: path.join(root, 'tmp') };
  for (const p of Object.values(w)) fs.mkdirSync(p, { mode: 0o700 });
  return { root, w };
}
const request = (w, name = id) => path.join(w.io, name + '.request');
const reply = (w, name = id) => path.join(w.io, name + '.reply');
const enqueue = (w, body = { op: 'ask', text: 'local marker' }) => fs.writeFileSync(request(w), JSON.stringify(body), { mode: 0o600 });

test('临时处理失败保留队列请求，重试继续使用原请求编号', async t => {
  const r = await runtime(), { w } = fixture(t), seen = [];
  enqueue(w);
  r.drainBridge(w, (a, context) => { seen.push(context?.id); throw Error('owner unavailable'); });
  assert.ok(fs.existsSync(request(w)));
  assert.equal(fs.existsSync(reply(w)), false);
  r.drainBridge(w, (a, context) => { seen.push(context.id); return 'saved'; });
  assert.deepEqual(seen, [id, id]);
  assert.equal(fs.existsSync(request(w)), false);
  assert.equal(fs.readFileSync(reply(w), 'utf8'), 'saved');
});

test('临时错误结果不能被当作成功回复，也不能消费原请求', async t => {
  const r = await runtime(), { w } = fixture(t); enqueue(w);
  r.drainBridge(w, () => ({ error: 'owner_unavailable' }));
  assert.ok(fs.existsSync(request(w)));
  assert.equal(fs.existsSync(reply(w)), false);
});

test('已处理但回复发布失败时，保留请求并以原编号取回执', async t => {
  const r = await runtime(), { w } = fixture(t); enqueue(w);
  const original = fs.linkSync, seen = [];
  fs.linkSync = () => { throw Object.assign(Error('local publication failure'), { code: 'ENOSPC' }); };
  try { r.drainBridge(w, (a, context) => { seen.push(context.id); return 'stored receipt'; }); }
  finally { fs.linkSync = original; }
  assert.ok(fs.existsSync(request(w)));
  assert.equal(fs.existsSync(reply(w)), false);
  r.drainBridge(w, (a, context) => { seen.push(context.id); return 'stored receipt'; });
  assert.deepEqual(seen, [id, id]);
  assert.equal(fs.readFileSync(reply(w), 'utf8'), 'stored receipt');
  assert.equal(fs.statSync(reply(w)).mode & 0o777, 0o600);
});

test('完整回复已存在时不再次执行，消费残留请求且保留回复', async t => {
  const r = await runtime(), { w } = fixture(t); enqueue(w); fs.writeFileSync(reply(w), 'previous receipt', { mode: 0o600 });
  let called = 0; r.drainBridge(w, () => { called++; return 'new'; });
  assert.equal(called, 0); assert.equal(fs.existsSync(request(w)), false);
  assert.equal(fs.readFileSync(reply(w), 'utf8'), 'previous receipt');
});

test('一条请求暂时不可处理时结束本次扫描，保留后续请求', async t => {
  const r = await runtime(), { w } = fixture(t); enqueue(w);
  fs.writeFileSync(request(w, 'c'.repeat(24)), JSON.stringify({ op: 'remember', text: 'next' }));
  let called = 0; r.drainBridge(w, () => { called++; throw Error('temporarily unavailable'); });
  assert.equal(called, 1); assert.equal(fs.readdirSync(w.io).filter(n => n.endsWith('.request')).length, 2);
});

test('旧协议工作区和旧无身份请求保持兼容，不自动升级', async t => {
  const p = await protocol(), r = await runtime(), { w } = fixture(t);
  assert.equal(p.scopedBridgeWorkspace(w, { run, attempt }), w);
  assert.equal(p.scopedBridgeWorkspace(w, { bridgeProtocol: 0 }), w);
  enqueue(w); let seen;
  r.drainBridge(w, a => { seen = a; return 'legacy'; });
  assert.deepEqual(seen, { op: 'ask', text: 'local marker' });
});

test('不同轮次和尝试使用不同挂载目录，规范工作区不会被覆盖', async t => {
  const p = await protocol(), { w } = fixture(t), original = { ...w };
  const a = p.scopedBridgeWorkspace(w, { run, attempt, bridgeProtocol: 1 });
  const b = p.scopedBridgeWorkspace(w, { run, attempt: 'c'.repeat(32), bridgeProtocol: 1 });
  const c = p.scopedBridgeWorkspace(w, { run: 'rbridge002', attempt, bridgeProtocol: 1 });
  assert.equal(new Set([a.io, b.io, c.io]).size, 3);
  assert.notEqual(a.io, w.io); assert.deepEqual(w, original);
  assert.deepEqual({ ...a, io: w.io }, w);
  for (const v of [a, b, c]) { assert.equal(path.dirname(v.io), path.dirname(w.io)); assert.equal(fs.statSync(v.io).mode & 0o777, 0o700); }
  fs.writeFileSync(path.join(a.io, 'marker'), 'retained');
  assert.deepEqual(p.scopedBridgeWorkspace(w, { run, attempt, bridgeProtocol: 1 }), a);
  assert.equal(fs.readFileSync(path.join(a.io, 'marker'), 'utf8'), 'retained');
});

test('新尝试不会消费旧队列或旧尝试目录里的请求', async t => {
  const p = await protocol(), r = await runtime(), { w } = fixture(t); enqueue(w);
  const old = p.scopedBridgeWorkspace(w, { run, attempt, bridgeProtocol: 1 }); enqueue(old);
  const current = p.scopedBridgeWorkspace(w, { run, attempt: 'c'.repeat(32), bridgeProtocol: 1 });
  let called = 0; r.drainBridge(current, () => { called++; return 'wrong source'; });
  assert.equal(called, 0); assert.ok(fs.existsSync(request(w))); assert.ok(fs.existsSync(request(old)));
  enqueue(current); r.drainBridge(current, (a, context) => { assert.equal(context.id, id); called++; return 'current'; });
  assert.equal(called, 1); assert.ok(fs.existsSync(request(w))); assert.ok(fs.existsSync(request(old)));
});

test('协议工作区拒绝缺失或畸形身份，错误不回显身份内容', async t => {
  const p = await protocol(), { w } = fixture(t);
  for (const q of [{}, { run, attempt: 'private-cookie-marker' }, { run: '../outside', attempt }, { run, attempt: attempt.toUpperCase() }]) {
    assert.throws(() => p.scopedBridgeWorkspace(w, { ...q, bridgeProtocol: 1 }), e => e.code === 'bad_bridge_scope' && !/private-cookie|outside/.test(e.message));
  }
  assert.equal(p.bridgeEnabled({ XIN_TASK_BRIDGE: '0' }), false);
  assert.equal(p.bridgeEnabled({ XIN_TASK_BRIDGE: '1' }), true);
  assert.equal(p.bridgeEnabled({}), true);
  for (const bridgeProtocol of [2, -1, '1', null]) {
    assert.throws(() => p.scopedBridgeWorkspace(w, { run, attempt, bridgeProtocol }), { code: 'bad_bridge_scope' });
  }
});

test('协议目录或其父目录被换成软链接时拒绝，外部目录不被改写', async t => {
  const p = await protocol(), { w, root } = fixture(t);
  const outside = path.join(root, 'outside'); fs.mkdirSync(outside, { mode: 0o700 });
  const target = path.join(root, 'io-' + run + '-' + attempt); fs.symlinkSync(outside, target);
  assert.throws(() => p.scopedBridgeWorkspace(w, { run, attempt, bridgeProtocol: 1 }), { code: 'bad_bridge_scope' });
  assert.deepEqual(fs.readdirSync(outside), []);
  const alias = path.join(root, 'alias'); fs.symlinkSync(root, alias);
  assert.throws(() => p.scopedBridgeWorkspace({ ...w, io: path.join(alias, 'io') }, { run, attempt: 'c'.repeat(32), bridgeProtocol: 1 }), { code: 'bad_bridge_scope' });
});

test('既有 shim 在新尝试挂载中可正常提问，请求0600且规范目录不被使用', async t => {
  const r = await runtime(), p = await protocol(), { root } = fixture(t);
  const project = path.join(root, 'project'); fs.mkdirSync(project); fs.writeFileSync(path.join(project, 'main.c'), 'int main(void){}');
  const task = { sid: 'sbridge001', dir: project };
  const canonical = r.prepareWorkspace(task, path.join(root, 'control'));
  const scoped = p.scopedBridgeWorkspace(canonical, { run, attempt, bridgeProtocol: 1 });
  const child = spawn(process.execPath, [path.join(canonical.home, 'bin/xin'), 'task', 'ask', '选择哪个引脚？'], {
    env: { PATH: '/usr/bin:/bin', XIN_TASK_IO: scoped.io }, stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(() => { try { child.kill('SIGKILL'); } catch {} });
  let output = '', error = ''; child.stdout.on('data', b => output += b); child.stderr.on('data', b => error += b);
  const ended = new Promise(resolve => child.once('exit', resolve));
  const until = performance.now() + platformTimeout(5000); let file;
  while (!(file = fs.readdirSync(scoped.io).find(n => n.endsWith('.request')))) {
    assert.ok(performance.now() < until, error || 'shim did not enqueue');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(fs.statSync(path.join(scoped.io, file)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(scoped.io, file), 'utf8')), { op: 'ask', text: '选择哪个引脚？' });
  r.drainBridge(scoped, (a, context) => { assert.equal(context.id + '.request', file); return '已记下问题'; });
  assert.equal(await ended, 0, error); assert.match(output, /已记下问题/);
  assert.deepEqual(fs.readdirSync(canonical.io), []);
  assert.deepEqual(fs.readdirSync(scoped.io), []);
});

test('权限和容器仅开放本尝试队列，不绑定规范io或其可写祖先', async t => {
  const r = await runtime(), p = await protocol(), { root, w } = fixture(t);
  const project = path.join(root, 'project'); fs.mkdirSync(project);
  const scoped = p.scopedBridgeWorkspace(w, { run, attempt, bridgeProtocol: 1 });
  const task = { dir: project, workspace: scoped };
  const flags = r.permissionArgs(task, path.join(root, 'control'));
  const filesystem = flags.find(x => x.startsWith('permissions.xin-task.filesystem='));
  const env = flags.find(x => x.startsWith('shell_environment_policy.set='));
  assert.ok(filesystem.includes(JSON.stringify(scoped.io) + '="write"'));
  assert.equal(filesystem.includes(JSON.stringify(w.io) + '='), false);
  assert.ok(env.includes('"XIN_TASK_IO"=' + JSON.stringify(scoped.io)));
  const args = r.containerCommand(task, '/usr/bin/true', []).args;
  const bindings = args.flatMap((x, i) => x === '--bind' ? [[args[i + 1], args[i + 2]]] : []);
  assert.ok(bindings.some(([source, target]) => source === scoped.io && target === scoped.io));
  assert.equal(bindings.some(([source]) => source === w.io || source === root), false);
  const i = args.findIndex((x, i) => x === 'XIN_TASK_IO' && args[i - 1] === '--setenv');
  assert.ok(i > 0); assert.equal(args[i + 1], scoped.io);
});
