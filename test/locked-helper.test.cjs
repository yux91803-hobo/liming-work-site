const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { lockedSpawn } = require('./helpers/locked.cjs');
const { stateMode } = require('./helpers/state-mode.cjs');
const AGENT = path.join(__dirname, '../site/xin/vm-agent.mjs');

test('内部命令等待常驻写者，任务事务不再依赖旧锁文件', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-locked-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const obsoleteLock = path.join(home, 'locks', 'tasks.lock');
  fs.mkdirSync(obsoleteLock, { recursive: true });
  const env = { ...process.env, XIN_HOME: home, XIN_WORK: path.join(home, 'work') };
  const tick = () => {
    const r = lockedSpawn(AGENT, 'task_tick', {}, { env, encoding: 'utf8', timeout: 15000 });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };

  const absent = tick();
  assert.equal(absent.error, 'owner_unavailable');
  assert.equal(absent.executed, false);
  for (const file of ['owner.sqlite', 'workflow.sqlite']) assert.equal(fs.existsSync(path.join(home, file)), false);

  stateMode(t, env);
  assert.deepEqual(tick(), { notify: [] });
  assert.ok(fs.statSync(obsoleteLock).isDirectory());
});
