// A committed controller report can lose its reply while Gemini is still between actions.
// Use a copied real owner and fake executors; never call a model or the production VM.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { lockedSpawn } = require('./helpers/locked.cjs');
const { stateMode } = require('./helpers/state-mode.cjs');
const { stopOwned } = require('./helpers/stop-owned.cjs');
const { platformTimeout } = require('./helpers/timeout.cjs');
const { fakeAgy, fakeCodex } = require('./helpers/fake-agy.cjs');
const { installStateSocketFault, stateSocketFault } = require('./helpers/state-socket-fault.cjs');

const SOURCE = path.join(__dirname, '../site/xin');
const CONVERSATION = '12345678-1234-1234-1234-123456789abc';
const NOTES = ['两份配置写的默认模型不一样，我再核一下实际启动的是哪个', '实际启动的是 config.toml 里的那个'];

function fixture(t, reportOp) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-agy-report-'));
  const home = path.join(root, 'xin'), bin = path.join(root, 'bin'), profile = path.join(root, 'profile');
  const agentDir = path.join(root, 'agent'), agent = path.join(agentDir, 'vm-agent.mjs');
  for (const dir of [home + '/sessions', home + '/runs', bin, profile, agentDir]) fs.mkdirSync(dir, { recursive: true });
  for (const name of fs.readdirSync(SOURCE).filter(n => /^vm-.*\.mjs$/.test(n))) fs.copyFileSync(path.join(SOURCE, name), path.join(agentDir, name));
  installStateSocketFault(agentDir);
  const preload = path.join(root, 'preload.cjs');
  fs.writeFileSync(preload, 'require("node:os").homedir=()=>'+JSON.stringify(profile)+';require("node:module").syncBuiltinESMExports();');
  fs.writeFileSync(path.join(root, 'script.json'), JSON.stringify([
    { action: 'note', text: NOTES[0] }, { action: 'note', text: NOTES[1] },
    { action: 'final', text: '实际启用的只有一个', gate: true }
  ]));
  fs.writeFileSync(path.join(bin, 'agy'), fakeAgy(root), { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'codex'), fakeCodex(root), { mode: 0o755 });
  const env = { ...process.env, PATH: bin + ':' + process.env.PATH, NODE_OPTIONS: '--require=' + preload,
    XIN_HOME: home, XIN_WORK: path.join(root, 'work'), CODEX_HOME: path.join(profile, '.codex'),
    CLAUDE_CONFIG_DIR: path.join(profile, '.claude'), XIN_AGY_HOME: profile,
    XIN_ANTIGRAVITY_BIN: path.join(bin, 'agy'), XIN_CODEX_TRANSPORT: 'exec', XIN_TASK_SANDBOX: '0',
    XIN_SYSTEMD_BUS: path.join(root, 'no-systemd-bus'), XIN_AGY_IDLE_MS: '60000',
    XIN_NOTE_WAIT_MS: '600000', XIN_STATE_TEST_FAULT: 'after:' + reportOp };
  t.after(() => stopOwned(home, root));
  const startOwner = () => stateMode(t, env, { force: true, agent });
  const owner = startOwner();
  const call = (name, args = {}) => {
    const r = lockedSpawn(agent, name, args, { env, encoding: 'utf8', timeout: platformTimeout(20000) });
    assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout);
  };
  const read = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
  const lines = file => { try { return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); } catch { return []; } };
  const until = async (fn, what) => {
    for (const end = performance.now() + platformTimeout(15000); performance.now() < end;) {
      const value = fn(); if (value) return value;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.fail('等不到：' + what);
  };
  const diagnostics = () => ({
    fault: stateSocketFault(home),
    calls: lines(path.join(root, 'calls.jsonl')).map(c => ({ ...c, prompt: c.prompt.slice(0, 180) })),
    sessions: fs.readdirSync(path.join(home, 'sessions')).filter(n => n.endsWith('.json')).map(n => read(path.join(home, 'sessions', n))),
    runs: fs.readdirSync(path.join(home, 'runs')).filter(n => /\.jsonl?$/.test(n)).map(n => ({ name: n,
      value: n.endsWith('.jsonl') ? lines(path.join(home, 'runs', n)) : read(path.join(home, 'runs', n)) })),
    modelStats: lines(path.join(home, 'model-stats.jsonl')),
    ownerError: (() => { try { return fs.readFileSync(path.join(home, 'test-state-error.log'), 'utf8'); } catch { return ''; } })()
  });
  return { root, home, owner, startOwner, call, read, lines, until, diagnostics };
}

for (const reportOp of ['agy_conversation', 'agy_quota']) test(reportOp + ' 已提交但回包前主人被杀：同一个 Gemini 接着 note、note、final，不换模型或重做动作', async t => {
    const f = fixture(t, reportOp);
    try {
      const task = f.call('task_new', { kind: 'research', goal: '查电脑上有哪些 Agent 模型' }).task;
      const fault = await f.until(() => stateSocketFault(f.home), '报告提交后的故障门');
      assert.deepEqual({ phase: fault.phase, op: fault.op, result: fault.result }, { phase: 'after', op: reportOp, result: { ok: true } });
      assert.equal(fault.pid, f.owner.child.pid);
      if (reportOp === 'agy_conversation') assert.equal(f.read(path.join(f.home, 'sessions', task.sid + '.json')).antigravityConversation, CONVERSATION, '先保存了会话编号，再丢回包');
      else {
        assert.equal(f.read(path.join(f.home, 'antigravity-quota.json')).blocked, false, '先确认了真实额度，再丢报告回包');
        assert.equal(f.lines(path.join(f.home, 'quota-history.jsonl')).length, 2, '首次额度采样的两个窗口已经提交');
      }
      f.owner.child.kill('SIGKILL'); await f.owner.exited;
      f.startOwner();
      await f.until(() => fs.existsSync(path.join(f.root, 'at-3')) || fs.existsSync(path.join(f.root, 'codex.args')), '同一模型到第三个动作');
      // A fallback may finish successfully and hide the original transport error in task.result.
      // Let it record model-stats before reporting a failing regression.
      if (fs.existsSync(path.join(f.root, 'codex.args'))) await f.until(() => f.lines(path.join(f.home, 'model-stats.jsonl')).length, '保留换模型前的错误诊断');
      assert.equal(fs.existsSync(path.join(f.root, 'codex.args')), false, '报告回包丢失不应换执行器');
      const calls = f.lines(path.join(f.root, 'calls.jsonl'));
      assert.equal(calls.length, 3, '只调用原来的三个模型动作');
      assert.ok(calls.every(c => c.prompt !== 'acp'), '主动报告不启动前台 ACP');
      assert.deepEqual(calls.map(c => c.conversation), [false, true, true]);
      assert.match(calls[1].prompt, /^这件事不是从聊天里派的，记在过程里了/);
      assert.match(calls[2].prompt, /^这件事不是从聊天里派的，记在过程里了/);
      fs.writeFileSync(path.join(f.root, 'go-3'), '');
      const history = await f.until(() => {
        const h = f.call('history', { sid: task.sid });
        return ['done', 'failed'].includes(h.task.status) && h;
      }, '任务正常收尾');
      assert.equal(history.task.status, 'done', JSON.stringify(history.task));
      assert.equal(history.task.result.text, '实际启用的只有一个');
      assert.equal(history.task.model, 'gemini-4-hydrogen');
      assert.equal(history.runs.length, 1);
      assert.deepEqual(history.runs[0].events.filter(e => e.t === 'note').map(e => e.text), NOTES);
      const saved = f.read(path.join(f.home, 'sessions', task.sid + '.json'));
      assert.equal(saved.antigravityConversation, CONVERSATION);
      assert.equal(saved.noteIds.length, 2, '每个 note 只记一次');
      assert.equal(f.read(path.join(f.home, 'runs', history.runs[0].run + '.json')).attempt, fault.attempt, '只恢复报告，不重新分配执行尝试');
      const stats = f.lines(path.join(f.home, 'model-stats.jsonl'));
      assert.equal(stats.length, 1);
      assert.equal(stats[0].model, 'gemini-4-hydrogen');
      assert.equal(stats[0].from, undefined, '实际用量记录也没有换执行器');
      assert.equal(fs.existsSync(path.join(f.root, 'codex.args')), false);
      assert.equal(f.lines(path.join(f.root, 'calls.jsonl')).length, 3, '收尾后仍无额外模型调用');
      if (reportOp === 'agy_quota') assert.equal(f.lines(path.join(f.home, 'quota-history.jsonl')).length, 4, '只保留首次与收尾各两个窗口的真实采样，不重放丢 ACK 的采样');
    } catch (error) {
      t.diagnostic(JSON.stringify(f.diagnostics()));
      throw error;
    }
});
