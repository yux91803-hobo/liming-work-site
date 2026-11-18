// li2 上的天启身份（docs/superpowers/specs/2026-11-18-tianqi-li2-design.md §4.2）：Worker 发给 li2 的 exec 带 XIN_ROLE=tianqi，
// 外壳存下来传给状态进程和每一轮。天启身份下只用 Harness、提示词只有「你叫天启。」、小芯专属的操作回「天启没有这个功能」。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const { platformTimeout } = require('./helpers/timeout.cjs');
const { stateClient } = require('./helpers/state-mode.cjs');

const AGENT = path.join(__dirname, '../site/xin/vm-agent.mjs');
const NOT_TQ = { error: 'not_in_tianqi', msg: '天启没有这个功能' };
const ONLY = { error: 'tianqi_only', msg: '天启只用 Harness' };

// 一个临时的状态目录和它自己的状态进程；Harness 默认指到一个不存在的命令
function agentEnv(t, extra = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-tq-'));
  const env = Object.assign({}, process.env, {
    XIN_HOME: path.join(home, 'xin'), XIN_WORK: path.join(home, 'work'), XIN_DSH: path.join(home, 'no-dsh'), XIN_DSH_HOME: path.join(home, 'dsh'),
    HOME: home, CODEX_HOME: path.join(home, 'codex'), CLAUDE_CONFIG_DIR: path.join(home, 'claude'), XIN_FRONT_PROVIDER: 'deepseek'
  }, extra);
  delete env.XIN_ROLE; if (extra.XIN_ROLE) env.XIN_ROLE = extra.XIN_ROLE;
  fs.mkdirSync(path.join(env.XIN_HOME, 'sessions'), { recursive: true });
  const ensureState = stateClient(t, env);
  const op = (name, args) => { ensureState(); return JSON.parse(execFileSync(process.execPath, [AGENT, name], { env, input: JSON.stringify(args || {}) }).toString()); };
  return { home, xin: env.XIN_HOME, op };
}
// 假的 dsh：记下参数（一行一次），按真 dsh 的格式吐几条事件
function fakeDsh(dir) {
  const log = path.join(dir, 'calls.log'), dsh = path.join(dir, 'dsh');
  fs.writeFileSync(dsh, '#!/bin/sh\n{ printf "ARGS"; for a in "$@"; do printf " [%s]" "$a"; done; echo; } >> "' + log + '"\n' +
    'echo \'{"type":"session","sessionId":"session-1de23629-51a4-47e9-8626-be15439b8b66","cwd":"/w"}\'\n' +
    'echo \'{"type":"text","text":"好"}\'\n' +
    'echo \'{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"completed"}}\'\n' +
    'echo \'{"type":"final","text":"好"}\'\n', { mode: 0o755 });
  return { dsh, log };
}
async function poll(op, run) {
  let p;
  for (const end = performance.now() + platformTimeout(15000); performance.now() < end;) {
    p = op('poll', { run, off: 0 });
    if (p.done) return p;
    await new Promise(ok => setTimeout(ok, 150));
  }
  return p;
}

test('天启身份：不写 agent 也是 Harness；补丁里的提示词只有「你叫天启。」；发给 Harness 的就是原话', async t => {
  const { dsh, log } = fakeDsh(fs.mkdtempSync(path.join(os.tmpdir(), 'xin-tq-dsh-')));
  const { xin, op } = agentEnv(t, { XIN_ROLE: 'tianqi', XIN_DSH: dsh });
  fs.writeFileSync(path.join(xin, 'harness.key'), 'gw-key-123\n', { mode: 0o600 });
  const r = op('send', { text: '看看目录', context: '【用户正在看】GPIO', ctxLabel: 'GPIO' });
  assert.equal(r.agent, 'harness', JSON.stringify(r));
  const p = await poll(op, r.run);
  assert.ok(p.done && p.events.at(-1).ok, JSON.stringify(p.events));
  const patches = fs.readdirSync(xin).filter(n => /^harness-persona\..+\.yml$/.test(n)).map(n => fs.readFileSync(path.join(xin, n), 'utf8'));
  assert.equal(patches.length, 1);
  assert.ok(patches[0].includes('    personaPrefix: "你叫天启。"\n'), patches[0]);
  assert.ok(!patches[0].includes('小芯') && !patches[0].includes('独立高级模式'), patches[0]);
  const args = fs.readFileSync(log, 'utf8').trim().split('\n').filter(l => l.startsWith('ARGS')).pop();
  assert.match(args, /\[--json\] \[看看目录\]$/, '没有提醒、没有附带的页面');
});

test('天启身份：要 Codex、Claude 的被拒，接着聊别的 agent 的对话也被拒；网关 key 没放好时说网关还没配好', t => {
  const { dsh } = fakeDsh(fs.mkdtempSync(path.join(os.tmpdir(), 'xin-tq-dsh-')));
  const { xin, op } = agentEnv(t, { XIN_ROLE: 'tianqi', XIN_DSH: dsh });
  fs.writeFileSync(path.join(xin, 'harness.key'), 'gw-key-123\n', { mode: 0o600 });
  fs.writeFileSync(path.join(xin, 'sessions', 'scodex00001.json'), JSON.stringify({ sid: 'scodex00001', agent: 'codex', title: 'x', runs: [], created: 1, updated: 1 }));
  assert.deepEqual(op('send', { agent: 'codex', text: 'x' }), ONLY);
  assert.deepEqual(op('send', { agent: 'claude', text: 'x' }), ONLY);
  assert.deepEqual(op('send', { sid: 'scodex00001', text: 'x' }), ONLY);
  fs.unlinkSync(path.join(xin, 'harness.key'));
  assert.deepEqual(op('send', { text: 'x' }), { error: 'not_ready', msg: '天启的网关还没配好' });
});

test('天启身份：小芯专属的操作回「天启没有这个功能」；ping 说自己是天启、准备好没有', t => {
  const { dsh } = fakeDsh(fs.mkdtempSync(path.join(os.tmpdir(), 'xin-tq-dsh-')));
  const { xin, op } = agentEnv(t, { XIN_ROLE: 'tianqi', XIN_DSH: dsh });
  fs.writeFileSync(path.join(xin, 'harness.key'), 'gw-key-123\n', { mode: 0o600 });
  for (const name of ['greet', 'daily', 'daily_get', 'memory_list', 'tasks', 'push_key', 'push_sub', 'bond', 'moves', 'screen', 'logins', 'backup_export'])
    assert.deepEqual(op(name, {}), NOT_TQ, name);
  const p = op('ping');
  assert.deepEqual([p.role, p.ready], ['tianqi', true], JSON.stringify(p));
  fs.unlinkSync(path.join(xin, 'harness.key'));
  assert.equal(op('ping').ready, false);
});

test('天启的 Purge 和 REA 开关只影响后续的 Harness 执行，REA 初始关闭', async t => {
  const { dsh, log } = fakeDsh(fs.mkdtempSync(path.join(os.tmpdir(), 'xin-tq-dsh-')));
  const { home, xin, op } = agentEnv(t, { XIN_ROLE: 'tianqi', XIN_DSH: dsh });
  assert.deepEqual(op('plugins').plugins, []);
  assert.equal(op('plugin_set', { name: 'rea', on: true }).error, 'no_plugin');

  const profile = path.join(home, 'dsh', 'profiles', 'headless');
  const launcher = path.join(home, '.local', 'bin', 'tianqi-rea-mcp');
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({ dependencies: { 'dsh-purge-community': '1.6.98' } }));
  fs.mkdirSync(path.dirname(launcher), { recursive: true });
  fs.writeFileSync(launcher, '#!/bin/sh\n', { mode: 0o755 });
  fs.writeFileSync(path.join(xin, 'harness.key'), 'gw-key-123\n', { mode: 0o600 });
  assert.deepEqual(op('plugins').plugins.map(({ name, on }) => [name, on]), [['purge', true], ['rea', false]]);
  assert.deepEqual(op('plugins', { agent: 'codex' }), ONLY);
  assert.deepEqual(op('plugin_set', { agent: 'codex', name: 'rea', on: true }), ONLY);
  assert.equal(op('plugin_set', { name: 'instabox', on: true }).error, 'no_plugin');
  assert.equal(op('plugin_set', { name: 'rea', on: 'false' }).error, 'bad_value');

  assert.equal(op('plugin_set', { name: 'purge', on: false }).on, false);
  assert.equal(op('plugin_set', { name: 'rea', on: true, command: '/foreign/command' }).on, true);
  const enabled = op('send', { text: '插件已打开' });
  assert.ok((await poll(op, enabled.run))?.done);
  assert.equal(op('plugin_set', { name: 'rea', on: false }).on, false);
  const disabled = op('send', { text: '插件已关闭' });
  assert.ok((await poll(op, disabled.run))?.done);

  const invocations = fs.readFileSync(log, 'utf8').split('\n').filter(line => line.startsWith('ARGS'));
  const patches = invocations.map(line => line.match(/\[--patch\] \[([^\]]+)\]/)[1]);
  assert.equal(patches.length, 2);
  assert.notEqual(patches[0], patches[1]);
  const applied = fs.readFileSync(patches[0], 'utf8'), off = fs.readFileSync(patches[1], 'utf8');
  assert.match(applied, /id: mcp-rea\n  name: "@deepseek-ai\/dsh-mcp-client"/);
  assert.ok(applied.includes('command: ' + JSON.stringify(launcher)));
  assert.doesNotMatch(applied, /\/foreign\/command/);
  assert.match(off, /id: dsh-purge\n  config:\n    enabled: false/);
  assert.doesNotMatch(off, /id: mcp-rea/);
});

test('小芯身份：ping 说自己是小芯，greet 照常', t => {
  const { op } = agentEnv(t);
  const p = op('ping');
  assert.equal(p.role, 'xin', JSON.stringify(p));
  assert.equal('ready' in p, false);
  const g = op('greet', {});
  assert.equal(g.error, undefined, JSON.stringify(g));
});
