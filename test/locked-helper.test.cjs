// 测试辅助 lockedSpawn 要和正式环境一样拿锁（见 test/helpers/locked.cjs 开头的说明，#133 CI 偶尔丢回答）
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const { lockedSpawn, lockKey, internalOps } = require('./helpers/locked.cjs');
const AGENT = path.join(__dirname, '../site/xin/vm-agent.mjs');

test('内部操作先拿锁、公开操作照原样调；任务记录用 tasks 锁，对话自己的操作用对话那把锁', () => {
  const ops = internalOps(AGENT);
  for (const op of ['task_tell', 'task_new', 'task_approval', 'task_approval_expire', 'task_finish', 'task_tick', 'session_patch', 'front_quota']) assert.ok(ops.has(op), op);
  for (const op of ['tasks', 'history', 'poll', 'send', 'sessions']) assert.ok(!ops.has(op), op);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-locked-'));
  try {
    fs.mkdirSync(path.join(home, 'sessions'));
    fs.writeFileSync(path.join(home, 'sessions', 'stask00001.json'), JSON.stringify({ sid: 'stask00001', kind: 'task' }));
    fs.writeFileSync(path.join(home, 'sessions', 'schat00001.json'), JSON.stringify({ sid: 'schat00001', agent: 'codex' }));
    assert.equal(lockKey(home, 'task_tell', { sid: 'stask00001' }), 'tasks');
    assert.equal(lockKey(home, 'session_patch', { sid: 'stask00001' }), 'tasks');
    assert.equal(lockKey(home, 'session_patch', { sid: 'schat00001' }), 'schat00001');
    assert.equal(lockKey(home, 'task_tick', {}), 'tasks');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('别人拿着 tasks 锁时，内部操作会等它放开再做（不是绕过锁直接改）', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-locked-'));
  fs.mkdirSync(path.join(home, 'locks'), { recursive: true });
  // 单独一个进程组：结束时连 sleep 一起结束（锁在 sleep 手里）
  const holder = spawn('flock', ['--exclusive', path.join(home, 'locks', 'tasks.lock'), 'sleep', '30'], { stdio: 'ignore', detached: true });
  const release = () => { try { process.kill(-holder.pid, 'SIGKILL'); } catch { /* 已经结束 */ } };
  try {
    await new Promise(r => setTimeout(r, 300));
    const env = { ...process.env, XIN_HOME: home, XIN_WORK: path.join(home, 'work') };
    const t0 = Date.now(), r = lockedSpawn(AGENT, 'task_tick', {}, { env, encoding: 'utf8', timeout: 1500 });
    assert.notEqual(r.status, 0, '锁被占着，不该直接做完');
    assert.ok(Date.now() - t0 >= 1400, '一直在等锁');
    release();
    await new Promise(r => holder.exitCode !== null || holder.signalCode ? r() : holder.on('exit', r));
    const ok = lockedSpawn(AGENT, 'task_tick', {}, { env, encoding: 'utf8', timeout: 20000 });
    assert.equal(ok.status, 0, ok.stderr);
  } finally { release(); fs.rmSync(home, { recursive: true, force: true }); }
});
