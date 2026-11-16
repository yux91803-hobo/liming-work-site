const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const crypto = require('node:crypto');
const { platformTimeout } = require('./helpers/timeout.cjs');
const runtime = () => import(pathToFileURL(path.join(__dirname, '../site/xin/vm-runtime.mjs')).href);
const reports = () => import(pathToFileURL(path.join(__dirname, '../site/xin/vm-task-reports.mjs')).href);
const meta = { run: 'rshimtest001', attempt: 'b'.repeat(32), bridgeProtocol: 1 };

async function fixture(t) {
  const r = await runtime(), q = await reports(), root = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-task-shim-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'project'), control = path.join(root, 'control'); fs.mkdirSync(project); fs.writeFileSync(path.join(project, 'main.c'), 'int main(void){}');
  const task = { sid: 'sshimtest001', dir: project }; task.workspace = r.prepareWorkspace(task, control);
  const shim = path.join(task.workspace.home, 'bin/xin');
  return { r, q, root, task, control, shim };
}

test('复用旧工作区时仅新协议迁移旧shim，规范元数据和shell环境保持原样', async t => {
  const f = await fixture(t), old = '#!/usr/bin/env node\n// legacy shim marker\n'; fs.writeFileSync(f.shim, old, { mode: 0o755 });
  const before = JSON.parse(JSON.stringify(f.task)), env = fs.readFileSync(path.join(f.task.workspace.home, 'shell-env.sh'), 'utf8');
  assert.equal(f.r.prepareWorkspace(f.task, f.control), f.task.workspace); assert.equal(fs.readFileSync(f.shim, 'utf8'), old);
  assert.equal(f.q.taskBridgeSession(f.task, { run: meta.run }), f.task); assert.equal(fs.readFileSync(f.shim, 'utf8'), old);
  const oldFd = fs.openSync(f.shim, 'r'); t.after(() => fs.closeSync(oldFd));
  const current = f.q.taskBridgeSession(f.task, meta);
  assert.deepEqual(f.task, before); assert.notEqual(current.workspace.io, f.task.workspace.io);
  assert.equal(current.workspace.home, f.task.workspace.home);
  assert.equal(fs.readFileSync(f.shim, 'utf8'), f.r.taskBridgeScript());
  assert.equal(fs.readFileSync(oldFd, 'utf8'), old, 'old open inode must not be truncated');
  assert.equal(fs.statSync(f.shim).mode & 0o777, 0o755);
  assert.equal(fs.readFileSync(path.join(f.task.workspace.home, 'shell-env.sh'), 'utf8'), env);
});

test('新旧进程各持原IO环境，刷新共享shim不会把旧请求换成新身份', async t => {
  const f = await fixture(t);
  const old = `#!/usr/bin/env node\nconst fs=require('node:fs'),path=require('node:path');const dir=process.env.XIN_TASK_IO,id='a'.repeat(24);fs.writeFileSync(path.join(dir,id+'.request'),JSON.stringify({op:'ask',text:'old question'}));const reply=path.join(dir,id+'.reply'),until=Date.now()+15000;while(!fs.existsSync(reply)&&Date.now()<until)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);if(!fs.existsSync(reply))process.exit(1);console.log('OLD '+fs.readFileSync(reply,'utf8'));fs.unlinkSync(reply);\n`;
  fs.writeFileSync(f.shim, old, { mode: 0o755 });
  const launch = io => {
    const child = spawn(process.execPath, [f.shim, 'task', 'ask', 'new question'], { env: { PATH: '/usr/bin:/bin', XIN_TASK_IO: io }, stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(() => { try { child.kill('SIGKILL'); } catch {} }); let output = '', error = '';
    child.stdout.on('data', b => output += b); child.stderr.on('data', b => error += b);
    return { ended: new Promise(resolve => child.once('exit', resolve)), result: () => ({ output, error }) };
  };
  const waitForRequest = async io => {
    const deadline = performance.now() + platformTimeout(5000);
    while (!fs.readdirSync(io).some(n => n.endsWith('.request'))) { assert.ok(performance.now() < deadline, 'shim did not enqueue'); await new Promise(resolve => setTimeout(resolve, 10)); }
  };
  const previous = launch(f.task.workspace.io); await waitForRequest(f.task.workspace.io);
  const current = f.q.taskBridgeSession(f.task, meta), fresh = launch(current.workspace.io); await waitForRequest(current.workspace.io);
  const seen = []; f.r.drainBridge(current.workspace, a => { seen.push(a.text); return 'new reply'; });
  assert.deepEqual(seen, ['new question']);
  assert.ok(fs.readdirSync(f.task.workspace.io).some(n => n.endsWith('.request')));
  f.r.drainBridge(f.task.workspace, a => { seen.push(a.text); return 'old reply'; });
  assert.deepEqual(seen, ['new question', 'old question']);
  assert.equal(await previous.ended, 0, previous.result().error); assert.equal(await fresh.ended, 0, fresh.result().error);
  assert.match(previous.result().output, /^OLD old reply/); assert.match(fresh.result().output, /^new reply/);
});

for (const entry of ['home', 'bin']) test('迁移拒绝被换成软链接的 ' + entry + '，不向外写shim', async t => {
  const f = await fixture(t), home = f.task.workspace.home;
  const source = entry === 'home' ? home : path.join(home, 'bin'), outside = path.join(f.root, 'external-' + entry);
  fs.renameSync(source, outside); fs.symlinkSync(outside, source);
  const target = entry === 'home' ? path.join(outside, 'bin/xin') : path.join(outside, 'xin'); fs.writeFileSync(target, 'outside marker');
  assert.throws(() => f.q.taskBridgeSession(f.task, meta), e => e.code === 'bad_bridge_shim' && !e.message.includes(outside));
  assert.equal(fs.readFileSync(target, 'utf8'), 'outside marker');
  assert.equal(fs.readdirSync(entry === 'home' ? path.join(outside, 'bin') : outside).some(n => n.startsWith('.xin-')), false);
});

test('新建工作区的home是软链接时拒绝，外部目录连bin也不创建', async t => {
  const f = await fixture(t), home = f.task.workspace.home, outside = path.join(f.root, 'external-empty');
  fs.renameSync(home, home + '-old'); fs.mkdirSync(outside); fs.symlinkSync(outside, home);
  const fresh = { sid: f.task.sid, dir: f.task.dir };
  assert.throws(() => f.r.prepareWorkspace(fresh, f.control), { code: 'bad_bridge_shim' });
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('xin自身是软链接时只替换目录项，不跟随链接修改外部文件', async t => {
  const f = await fixture(t), outside = path.join(f.root, 'external-file'); fs.writeFileSync(outside, 'outside marker');
  fs.unlinkSync(f.shim); fs.symlinkSync(outside, f.shim); f.q.taskBridgeSession(f.task, meta);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'outside marker'); assert.equal(fs.lstatSync(f.shim).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(f.shim, 'utf8'), f.r.taskBridgeScript());
});

test('安装期间bin被换走，写入仍留在固定inode且迁移失败关闭', async t => {
  const f = await fixture(t), bin = path.dirname(f.shim), moved = bin + '-moved', outside = path.join(f.root, 'external-bin');
  fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'xin'), 'outside marker');
  const rename = fs.renameSync; let swapped = false;
  fs.renameSync = (source, target) => {
    if (path.basename(String(source)).startsWith('.xin-')) { swapped = true; rename(bin, moved); fs.symlinkSync(outside, bin); }
    return rename(source, target);
  };
  try { assert.throws(() => f.q.taskBridgeSession(f.task, meta), { code: 'bad_bridge_shim' }); }
  finally { fs.renameSync = rename; }
  assert.equal(swapped, true); assert.equal(fs.readFileSync(path.join(outside, 'xin'), 'utf8'), 'outside marker');
  assert.equal(fs.readFileSync(path.join(moved, 'xin'), 'utf8'), f.r.taskBridgeScript());
});

test('新shim落盘失败不覆盖旧版本，也不留下临时文件', async t => {
  const f = await fixture(t); fs.writeFileSync(f.shim, 'old marker');
  const sync = fs.fsyncSync; fs.fsyncSync = () => { throw Error('synthetic disk failure'); };
  try { assert.throws(() => f.r.installTaskBridge(f.task.workspace), { code: 'bad_bridge_shim' }); }
  finally { fs.fsyncSync = sync; }
  assert.equal(fs.readFileSync(f.shim, 'utf8'), 'old marker');
  assert.deepEqual(fs.readdirSync(path.dirname(f.shim)), ['xin']);
});

test('迁移不重写已有shell-env文件，不跟随它的软链接', async t => {
  const f = await fixture(t), file = path.join(f.task.workspace.home, 'shell-env.sh'), outside = path.join(f.root, 'external-env');
  fs.writeFileSync(outside, 'outside marker'); fs.unlinkSync(file); fs.symlinkSync(outside, file);
  f.q.taskBridgeSession(f.task, meta);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'outside marker'); assert.equal(fs.lstatSync(file).isSymbolicLink(), true);
});

test('重建工作区时原子替换shell-env软链接，外部文件不变', async t => {
  const f = await fixture(t), file = path.join(f.task.workspace.home, 'shell-env.sh'), outside = path.join(f.root, 'external-env');
  const expected = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(outside, 'outside marker'); fs.unlinkSync(file); fs.symlinkSync(outside, file);
  f.r.prepareWorkspace({ sid: f.task.sid, dir: f.task.dir }, f.control);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'outside marker');
  assert.equal(fs.lstatSync(file).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(file, 'utf8'), expected);
  assert.equal(fs.statSync(file).mode & 0o777, 0o644);
});

test('安装shell-env期间home被换走，固定inode写入且不修改外部目录', async t => {
  const f = await fixture(t), home = f.task.workspace.home, moved = home + '-moved', outside = path.join(f.root, 'external-home');
  fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'shell-env.sh'), 'outside marker');
  const rename = fs.renameSync; let swapped = false;
  fs.renameSync = (source, target) => {
    if (path.basename(String(target)) === 'shell-env.sh') { swapped = true; rename(home, moved); fs.symlinkSync(outside, home); }
    return rename(source, target);
  };
  try { assert.throws(() => f.r.installTaskBridge(f.task.workspace, { shellEnvironment: true }), { code: 'bad_bridge_shim' }); }
  finally { fs.renameSync = rename; }
  assert.equal(swapped, true);
  assert.equal(fs.readFileSync(path.join(outside, 'shell-env.sh'), 'utf8'), 'outside marker');
  assert.equal(fs.readFileSync(path.join(moved, 'shell-env.sh'), 'utf8'), 'export PATH=' + JSON.stringify(path.join(home, 'bin')) + ':"$PATH"\n');
});

test('shell-env写入失败保留旧环境并清理本次临时文件', async t => {
  const f = await fixture(t), home = f.task.workspace.home, file = path.join(home, 'shell-env.sh');
  fs.writeFileSync(file, 'old env marker');
  const write = fs.writeFileSync;
  fs.writeFileSync = (target, value, ...args) => {
    if (typeof value === 'string' && value.startsWith('export PATH=')) throw Error('synthetic environment write failure');
    return write(target, value, ...args);
  };
  try { assert.throws(() => f.r.installTaskBridge(f.task.workspace, { shellEnvironment: true }), { code: 'bad_bridge_shim' }); }
  finally { fs.writeFileSync = write; }
  assert.equal(fs.readFileSync(file, 'utf8'), 'old env marker');
  assert.equal(fs.readdirSync(home).some(n => n.startsWith('.xin-')), false);
  assert.equal(fs.readdirSync(path.join(home, 'bin')).some(n => n.startsWith('.xin-')), false);
});

test('排他临时文件创建失败时不删除已有目录项', async t => {
  const f = await fixture(t), file = path.join(path.dirname(f.shim), '.xin-' + '0'.repeat(32) + '.tmp');
  fs.writeFileSync(file, 'existing marker');
  const random = crypto.randomBytes; crypto.randomBytes = n => Buffer.alloc(n);
  try { assert.throws(() => f.r.installTaskBridge(f.task.workspace), { code: 'bad_bridge_shim' }); }
  finally { crypto.randomBytes = random; }
  assert.equal(fs.readFileSync(file, 'utf8'), 'existing marker');
});
