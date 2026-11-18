// 新旧控制器交班（审查问题 20）：网站直接调用时记下当前用的是哪一份脚本。（旧 watchdog 接班那两条随删旧模式第 2 步删掉，见下面的说明）
const test = require('node:test');
const { platformTimeout } = require('./helpers/timeout.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const { stopOwned } = require('./helpers/stop-owned.cjs');
const SRC = path.join(__dirname, '../site/xin');

// 整套控制器模块复制到临时目录（云电脑上它们也是放在同一个目录里）
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-handover-')), agentDir = path.join(dir, 'agent'), xin = path.join(dir, 'xin');
  fs.mkdirSync(agentDir); fs.mkdirSync(path.join(xin, 'outbox'), { recursive: true });
  for (const f of fs.readdirSync(SRC).filter(f => /^vm-.*\.mjs$/.test(f))) fs.copyFileSync(path.join(SRC, f), path.join(agentDir, f));
  const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  for (const cmd of ['claude', 'codex', 'agy']) fs.writeFileSync(path.join(bin, cmd), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const env = { ...process.env, XIN_HOME: xin, XIN_WORK: path.join(dir, 'work'), XIN_DSH: path.join(dir, 'no-dsh'), XIN_FRONT_PROVIDER: 'deepseek',
    XIN_AGY_HOME: dir, XIN_ANTIGRAVITY_BIN: '', CODEX_HOME: path.join(dir, 'codex'), CLAUDE_CONFIG_DIR: path.join(dir, 'claude'), PATH: bin + ':' + process.env.PATH };
  t.after(() => stopOwned(xin, dir));
  const old = path.join(agentDir, 'vm-agent.mjs');
  const run = (args, input = '{}', timeout = 20000) => spawnSync(process.execPath, [old, ...args], { env, input, encoding: 'utf8', timeout });
  // 网站的调用交给真的常驻状态进程，它用的也是复制出来的这一份控制器（test/helpers/state-mode.cjs）
  const ensureState = (extra = {}) => require('./helpers/state-mode.cjs').stateMode(t, { ...env, ...extra }, { agent: old });
  return { dir, agentDir, xin, env, old, run, ensureState };
}
const current = xin => JSON.parse(fs.readFileSync(path.join(xin, 'controller-current.json'), 'utf8'));

test('网站直接调用控制器：记下这次用的是哪一份脚本；内部的加锁调用不记', t => {
  const { xin, old, run, ensureState } = setup(t);
  ensureState();
  assert.equal(run(['sessions']).status, 0);
  assert.equal(current(xin).self, old);
  fs.writeFileSync(path.join(xin, 'controller-current.json'), JSON.stringify({ self: '/somewhere/vm-agent-aaaaaaaaaaaa.mjs' }));
  run(['locked', 'task_index']);
  assert.equal(current(xin).self, '/somewhere/vm-agent-aaaaaaaaaaaa.mjs');
});

// 删旧模式第 2 步删掉两条：「旧 watchdog 发现有新的一份就让新版接班」「记录里的路径不像控制器入口就不跟着执行」。
// 看门狗不会再起（不是主人的进程一律不写，ensureWatchdog 走不到），它的循环第 2 批起就在常驻状态进程里跑；
// 换版本由外壳停旧状态进程、起新的（xin-kernel「换版本」）。看门狗的代码第 3 步删。

// 审查问题 16：任务的项目副本和会话在系统临时目录里，电脑重启后可能没了。接着做时不再续接已经不存在的旧会话。
test('接着做一个中途断了的任务、副本已经不在了：重新拷贝原项目，开新会话，并说明原要求和现状', t => {
  const { dir, xin, env, ensureState } = setup(t);
  const project = path.join(dir, 'work', 'blink'); fs.mkdirSync(project, { recursive: true }); fs.writeFileSync(path.join(project, 'main.c'), 'int main(){}');
  fs.mkdirSync(path.join(xin, 'sessions'), { recursive: true }); fs.mkdirSync(path.join(xin, 'runs'), { recursive: true });
  const old = 'roldturn0001', gone = path.join(dir, 'tmp-wiped', 'xin-task-staskreboot1');
  fs.writeFileSync(path.join(xin, 'runs', old + '.json'), JSON.stringify({ run: old, sid: 'staskreboot1', agent: 'codex', task: true, started: 1, ended: 2, code: 1 }));
  fs.writeFileSync(path.join(xin, 'runs', old + '.jsonl'), JSON.stringify({ t: 'done', ok: false }) + '\n');
  fs.writeFileSync(path.join(xin, 'sessions', 'staskreboot1.json'), JSON.stringify({ sid: 'staskreboot1', kind: 'task', agent: 'codex', parent: 'sparent0001', no: 1, title: '点灯', tkind: 'code',
    goal: '把 PA0 的灯点亮', dir: project, status: 'queued', runs: [old], created: 1, model: 'glm-5.3', why: 'code', fallbacks: [], after: [],
    next: '刚才电脑暂停或重启，这一轮中途断了', agentSid: '019a0000-0000-7000-8000-000000000000', started: true,
    workspace: { work: path.join(gone, 'work'), io: path.join(gone, 'io'), home: path.join(gone, 'home'), tmp: path.join(gone, 'tmp'), manifest: path.join(xin, 'workspaces', 'staskreboot1.json') } }));
  ensureState({ XIN_TASK_SANDBOX: '0' });   // 接着做的那一轮由状态进程派，沙盒开关跟着它的环境
  const r = spawnSync(process.execPath, [path.join(dir, 'agent', 'vm-agent.mjs'), 'tasks'], { env: { ...env, XIN_TASK_SANDBOX: '0' }, input: JSON.stringify({ all: true }), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const task = JSON.parse(fs.readFileSync(path.join(xin, 'sessions', 'staskreboot1.json'), 'utf8'));
  assert.equal(task.runs.length, 2, JSON.stringify(task.status));
  const meta = JSON.parse(fs.readFileSync(path.join(xin, 'runs', task.runs[1] + '.json'), 'utf8'));
  assert.match(meta.text, /电脑重启过/); assert.match(meta.text, /把 PA0 的灯点亮/); assert.match(meta.text, /这一轮中途断了/);
  assert.equal(task.agentSid ?? null, null, '不再续接旧会话');
  assert.ok(fs.existsSync(path.join(task.workspace.work, 'main.c')), '按原项目重新拷了副本');
});
