const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { DatabaseSync } = require('node:sqlite');
const { stopOwned } = require('./helpers/stop-owned.cjs');
const AGENT = path.join(__dirname, '../site/xin/vm-agent.mjs');
const BASE_MODULE = pathToFileURL(path.join(__dirname, '../site/xin/vm-base.mjs')).href;
const RUN = 'rbridgecontext01', SID = 'sbridgecontext01', ATTEMPT = '1'.repeat(32);

function fixture(t, { dispatched = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-bridge-context-'));
  const control = path.join(root, 'control'), profile = path.join(root, 'profile');
  const workspace = Object.fromEntries(['io', 'work', 'home', 'tmp'].map(n => [n, path.join(root, 'workspace', n)]));
  for (const dir of [control + '/runs', control + '/sessions', profile, ...Object.values(workspace)]) fs.mkdirSync(dir, { recursive: true });
  const marker = path.join(root, 'model-called'), stub = path.join(root, 'fake-agy');
  fs.writeFileSync(stub, '#!' + process.execPath + '\n' +
    `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'called\\n');process.exit(19);\n`, { mode: 0o755 });
  const meta = { run: RUN, sid: SID, task: true, sandbox: true, agent: 'codex', model: 'gemini-4-hydrogen',
    bridgeProtocol: 1, attemptProtocol: 1, started: Date.now(), pid: process.pid, ...(dispatched ? { attempt: ATTEMPT } : {}) };
  const task = { kind: 'task', sid: SID, no: 1, title: '临时身份测试', status: 'running', tkind: 'research',
    agent: 'codex', model: meta.model, dir: workspace.work, workspace, runs: [RUN] };
  fs.writeFileSync(control + '/runs/' + RUN + '.json', JSON.stringify(meta));
  fs.writeFileSync(control + '/sessions/' + SID + '.json', JSON.stringify(task));
  const env = { ...process.env, HOME: profile, XIN_HOME: control, XIN_WORK: root + '/work',
    CODEX_HOME: profile + '/codex', CLAUDE_CONFIG_DIR: profile + '/claude', XIN_AGY_HOME: profile,
    XIN_ANTIGRAVITY_BIN: stub, XIN_DSH: '/nonexistent/xin-test-dsh', XIN_FRONT_PROVIDER: 'deepseek' };
  delete env.XIN_RUN; delete env.XIN_ATTEMPT; delete env.XIN_LOCK;
  t.after(() => stopOwned(control, root));
  // Seed the journal so the long-lived CLI prelude only reads. The regression must
  // reach agy-run's preflight, not happen to fail during an unrelated first-open write.
  // 建库的脚本扮演主人；建好以后起真的常驻状态进程，执行进程和加锁命令都交给它（test/helpers/own-state.cjs、state-mode.cjs）
  const seeded = spawnSync(process.execPath, [...require('./helpers/own-state.cjs').OWN_IMPORT, '--input-type=module', '-e',
    `import {journal} from ${JSON.stringify(BASE_MODULE)};journal.recover();journal.close();`],
    { env, encoding: 'utf8', timeout: 10000 });
  assert.equal(seeded.status, 0, seeded.stderr);
  require('./helpers/state-mode.cjs').stateMode(t, env);
  return { root, control, workspace, marker, env,
    scope: path.join(path.dirname(workspace.io), 'io-' + RUN + '-' + ATTEMPT) };
}

for (const [name, source] of [
  ['旧尝试', { XIN_RUN: RUN, XIN_ATTEMPT: '2'.repeat(32) }],
  ['完全缺失', {}],
  ['缺少轮次', { XIN_ATTEMPT: ATTEMPT }],
  ['缺少尝试', { XIN_RUN: RUN }]
]) test('agy-run 拒绝' + name + '上下文，不创建当前队列或调用模型入口', t => {
  const f = fixture(t);
  const r = spawnSync(process.execPath, [AGENT, 'agy-run', RUN], {
    env: { ...f.env, ...source }, encoding: 'utf8', timeout: 10000 });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /stale_attempt/);
  assert.equal(fs.existsSync(f.scope), false);
  assert.equal(fs.existsSync(f.marker), false);
  assert.equal(fs.existsSync(f.control + '/antigravity-client'), false);
});

test('agy-run 当前上下文确实进入合成入口，并仅使用本尝试的队列副本', t => {
  const f = fixture(t), before = fs.readFileSync(f.control + '/sessions/' + SID + '.json', 'utf8');
  const r = spawnSync(process.execPath, [AGENT, 'agy-run', RUN], {
    env: { ...f.env, XIN_RUN: RUN, XIN_ATTEMPT: ATTEMPT }, encoding: 'utf8', timeout: 10000 });
  // The synthetic entry deliberately refuses quota. No model or network is used.
  assert.equal(r.status, 1, r.stderr); assert.match(r.stdout, /暂时无法核对/);
  assert.equal(fs.readFileSync(f.marker, 'utf8'), 'called\n');
  assert.equal(fs.statSync(f.scope).isDirectory(), true);
  assert.deepEqual(fs.readdirSync(f.workspace.io), []);
  assert.equal(fs.readFileSync(f.control + '/sessions/' + SID + '.json', 'utf8'), before);
});

for (const op of ['remember', 'ask']) test('新桥尚未派发编号时，缺失来源也不能' + (op === 'remember' ? '写入记忆' : '提出问题'), t => {
  const f = fixture(t, { dispatched: false });
  for (const source of [{}, { XIN_RUN: RUN }, { XIN_ATTEMPT: ATTEMPT }]) {
    const r = spawnSync(process.execPath, [AGENT, 'locked', 'task_bridge'], {
      env: { ...f.env, ...source, XIN_LOCK: 'tasks' }, encoding: 'utf8', timeout: 10000,
      input: JSON.stringify({ run: RUN, sid: SID, id: 'a'.repeat(24), op, text: '不可借用未来的执行身份' }) });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).error, 'stale_attempt');
  }
  const task = JSON.parse(fs.readFileSync(f.control + '/sessions/' + SID + '.json', 'utf8'));
  assert.equal(task.pendingQuestion, undefined);
  const db = new DatabaseSync(f.control + '/workflow.sqlite', { readOnly: true });
  try {
    const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_evidence'").get();
    if (exists) assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_evidence').get().n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM commands WHERE id LIKE 'task-bridge:%'").get().n, 0);
  } finally { db.close(); }
});
