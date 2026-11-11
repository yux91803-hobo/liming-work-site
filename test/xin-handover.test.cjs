// 新旧控制器交班（审查问题 20）：网站直接调用时记下当前用的是哪一份脚本；还在跑的旧 watchdog 发现有更新的一份，就让新版接班、自己退出。
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
  return { dir, agentDir, xin, env, old, run };
}
const current = xin => JSON.parse(fs.readFileSync(path.join(xin, 'controller-current.json'), 'utf8'));
// 让 watchdog 有活可干（一条还没送出的推送），否则它第一轮就自己退出了
const pending = xin => fs.writeFileSync(path.join(xin, 'outbox', 'a'.repeat(32) + '.json'), JSON.stringify({ id: 'a'.repeat(32), state: 'pending', nextAt: Date.now() + 3600e3, attempts: 0, delivered: [], created: Date.now(), msg: { sid: 'sx', title: 't', body: 'b' } }));

test('网站直接调用控制器：记下这次用的是哪一份脚本；内部的加锁调用不记', t => {
  const { xin, old, run } = setup(t);
  assert.equal(run(['sessions']).status, 0);
  assert.equal(current(xin).self, old);
  fs.writeFileSync(path.join(xin, 'controller-current.json'), JSON.stringify({ self: '/somewhere/vm-agent-aaaaaaaaaaaa.mjs' }));
  run(['locked', 'task_index']);
  assert.equal(current(xin).self, '/somewhere/vm-agent-aaaaaaaaaaaa.mjs');
});

test('旧 watchdog 发现网站已经在用新的一份：让新版接班，自己马上退出', t => {
  const { agentDir, xin, run } = setup(t);
  pending(xin);
  // 新版入口：这里用一个只留记号的小脚本代替，看它是不是被叫起来接班
  const marker = path.join(xin, 'handed-over');
  const next = path.join(agentDir, 'vm-agent-0123456789ab.mjs');
  fs.writeFileSync(next, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, process.argv[2] || '');\n`);
  fs.writeFileSync(path.join(xin, 'controller-current.json'), JSON.stringify({ self: next }));
  const t0 = Date.now(), r = run(['watchdog']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(Date.now() - t0 < 8000, '没有接着循环');
  for (const end = Date.now() + platformTimeout(15000); Date.now() < end && !fs.existsSync(marker);) spawnSync('sleep', ['0.1']);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'watchdog');
});

test('记录里的路径不像控制器入口（别的目录、别的名字）：不跟着执行，照常干活', t => {
  const { dir, agentDir, xin, run } = setup(t);
  pending(xin);
  const marker = path.join(xin, 'ran');
  for (const evil of [path.join(dir, 'vm-agent-0123456789ab.mjs'), path.join(agentDir, 'evil.mjs')]) {
    fs.writeFileSync(evil, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, '1');\n`);
    fs.writeFileSync(path.join(xin, 'controller-current.json'), JSON.stringify({ self: evil }));
    const r = run(['watchdog'], '{}', 7000);
    assert.equal(r.signal, 'SIGTERM', '还在照常循环，被测试的时限停下');
    assert.ok(!fs.existsSync(marker));
  }
});

// 审查问题 16：任务的项目副本和会话在系统临时目录里，电脑重启后可能没了。接着做时不再续接已经不存在的旧会话。
test('接着做一个中途断了的任务、副本已经不在了：重新拷贝原项目，开新会话，并说明原要求和现状', t => {
  const { dir, xin, env } = setup(t);
  const project = path.join(dir, 'work', 'blink'); fs.mkdirSync(project, { recursive: true }); fs.writeFileSync(path.join(project, 'main.c'), 'int main(){}');
  fs.mkdirSync(path.join(xin, 'sessions'), { recursive: true }); fs.mkdirSync(path.join(xin, 'runs'), { recursive: true });
  const old = 'roldturn0001', gone = path.join(dir, 'tmp-wiped', 'xin-task-staskreboot1');
  fs.writeFileSync(path.join(xin, 'runs', old + '.json'), JSON.stringify({ run: old, sid: 'staskreboot1', agent: 'codex', task: true, started: 1, ended: 2, code: 1 }));
  fs.writeFileSync(path.join(xin, 'runs', old + '.jsonl'), JSON.stringify({ t: 'done', ok: false }) + '\n');
  fs.writeFileSync(path.join(xin, 'sessions', 'staskreboot1.json'), JSON.stringify({ sid: 'staskreboot1', kind: 'task', agent: 'codex', parent: 'sparent0001', no: 1, title: '点灯', tkind: 'code',
    goal: '把 PA0 的灯点亮', dir: project, status: 'queued', runs: [old], created: 1, model: 'glm-5.3', why: 'code', fallbacks: [], after: [],
    next: '刚才电脑暂停或重启，这一轮中途断了', agentSid: '019a0000-0000-7000-8000-000000000000', started: true,
    workspace: { work: path.join(gone, 'work'), io: path.join(gone, 'io'), home: path.join(gone, 'home'), tmp: path.join(gone, 'tmp'), manifest: path.join(xin, 'workspaces', 'staskreboot1.json') } }));
  const r = spawnSync(process.execPath, [path.join(dir, 'agent', 'vm-agent.mjs'), 'tasks'], { env: { ...env, XIN_TASK_SANDBOX: '0' }, input: JSON.stringify({ all: true }), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const task = JSON.parse(fs.readFileSync(path.join(xin, 'sessions', 'staskreboot1.json'), 'utf8'));
  assert.equal(task.runs.length, 2, JSON.stringify(task.status));
  const meta = JSON.parse(fs.readFileSync(path.join(xin, 'runs', task.runs[1] + '.json'), 'utf8'));
  assert.match(meta.text, /电脑重启过/); assert.match(meta.text, /把 PA0 的灯点亮/); assert.match(meta.text, /这一轮中途断了/);
  assert.equal(task.agentSid ?? null, null, '不再续接旧会话');
  assert.ok(fs.existsSync(path.join(task.workspace.work, 'main.c')), '按原项目重新拷了副本');
});
