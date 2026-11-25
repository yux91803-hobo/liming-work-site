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
// 假的 dsh：记下权限环境变量、在哪个目录跑、参数（MODE、PWD 各一行，ARGS 一行；任务里有换行时 ARGS 会跨行），按真 dsh 的格式吐几条事件
function fakeDsh(dir) {
  const log = path.join(dir, 'calls.log'), dsh = path.join(dir, 'dsh');
  fs.writeFileSync(dsh, '#!/bin/sh\n{ echo "MODE=$DSH_PERMISSION_MODE"; echo "PWD=$(pwd -P)"; printf "ARGS"; for a in "$@"; do printf " [%s]" "$a"; done; echo; } >> "' + log + '"\n' +
    'echo \'{"type":"session","sessionId":"session-1de23629-51a4-47e9-8626-be15439b8b66","cwd":"/w"}\'\n' +
    'echo \'{"type":"text","text":"好"}\'\n' +
    'echo \'{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"completed"}}\'\n' +
    'echo \'{"type":"final","text":"好"}\'\n', { mode: 0o755 });
  return { dsh, log };
}
// 假的 dsh：会话号 sid，每一步按给的用量吐一条 step_end（真 dsh 的字段：inputTokens 是没命中缓存的输入，cacheReadTokens 是命中缓存的输入）
function fakeDshUsage(dir, sid, steps) {
  const dsh = path.join(dir, 'dsh-use');
  fs.writeFileSync(dsh, '#!/bin/sh\n' +
    'echo \'{"type":"session","sessionId":"' + sid + '","cwd":"/w"}\'\n' +
    'echo \'{"type":"text","text":"好"}\'\n' +
    steps.map((u, i) => 'echo \'{"type":"status","phase":"step_end","turn":1,"step":' + (i + 1) + ',"usage":' + JSON.stringify(u) + '}\'\n').join('') +
    'echo \'{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"completed"}}\'\n' +
    'echo \'{"type":"final","text":"好"}\'\n', { mode: 0o755 });
  return dsh;
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

test('天启给 Harness 声明每个网关模型的图片能力，并让支持看图的模型用 read_image 打开上传文件', async t => {
  const { dsh, log } = fakeDsh(fs.mkdtempSync(path.join(os.tmpdir(), 'xin-tq-dsh-')));
  const { home, xin, op } = agentEnv(t, { XIN_ROLE: 'tianqi', XIN_DSH: dsh });
  fs.writeFileSync(path.join(xin, 'harness.key'), 'gw-key-123\n', { mode: 0o600 });
  const upload = path.join(home, 'work', 'uploads', 'vision.png');
  fs.mkdirSync(path.dirname(upload), { recursive: true });
  fs.writeFileSync(upload, '仅用来核对附件路径');
  const send = async model => {
    const r = op('send', { model, perm: 'read-only', text: '读这张图', files: [{ path: upload }] });
    assert.ok(r.run, JSON.stringify(r));
    const p = await poll(op, r.run);
    assert.ok(p.done && p.events.at(-1).ok, JSON.stringify(p.events));
    return fs.readFileSync(log, 'utf8').split(/^MODE=/m).at(-1);
  };

  const vision = await send('deepseek-v4.1-flash');
  const patch = fs.readdirSync(xin).find(n => /^harness-persona\.deepseek-v4\.1-flash\..+\.yml$/.test(n));
  const yaml = fs.readFileSync(path.join(xin, patch), 'utf8');
  const models = Object.fromEntries([...yaml.matchAll(/^ {10}- id: "([^"]+)"\n +name: [^\n]+\n +contextWindow: \d+\n +input: (\[[^\n]+\])$/gm)]
    .map(([, id, input]) => [id, JSON.parse(input)]));
  assert.deepEqual(models, {
    'deepseek-v4.1-flash': ['text', 'image'], 'glm-5.3': ['text', 'image'],
    'glm-5.3-flash': ['text'], 'kimi-k3.1-pro': ['text', 'image'], 'glm-5.4': ['text', 'image']
  });
  assert.ok(vision.includes(upload));
  assert.match(vision, /用 read_image/);
  assert.match(vision, /^read-only\n/);

  const textOnly = await send('glm-5.3-flash');
  assert.ok(textOnly.includes(upload));
  assert.match(textOnly, /模型看不了图片内容/);
  assert.doesNotMatch(textOnly, /read_image/);

  const glm54 = await send('glm-5.4');
  assert.match(glm54, /harness-persona\.glm-5\.4\.high\.yml/);
  assert.match(glm54, /用 read_image/);
});

// 权限预设和计划模式（docs/superpowers/specs/2026-11-19-tianqi-harness-workbench-design.md §3、§4 第 2 个 PR）：
// Harness 基础配置自带 read-only / workspace-write / danger-full-access 三档；headless 每一轮用 --permission-mode 选，
// 续聊也要重复带（dsh-headless README）；--approval-policy never：没人当场批准，越过沙箱的直接拒。
test('天启的权限：每一轮带 --permission-mode 和 --approval-policy never；对话记住权限；计划那一轮只读、任务前面加计划要求；不认识的权限报错', async t => {
  const { dsh, log } = fakeDsh(fs.mkdtempSync(path.join(os.tmpdir(), 'xin-tq-dsh-')));
  const { xin, op } = agentEnv(t, { XIN_ROLE: 'tianqi', XIN_DSH: dsh });
  fs.writeFileSync(path.join(xin, 'harness.key'), 'gw-key-123\n', { mode: 0o600 });
  const calls = () => { try { return fs.readFileSync(log, 'utf8').split(/^MODE=/m).slice(1); } catch { return []; } };
  const last = () => { const c = calls().pop(), nl = c.indexOf('\n'); return { mode: c.slice(0, nl), args: c.slice(nl + 1).trim() }; };
  const turn = async a => {
    const r = op('send', a);
    assert.ok(r.run, JSON.stringify(r));
    const p = await poll(op, r.run);
    assert.ok(p.done && p.events.at(-1).ok, JSON.stringify(p.events));
    return { r, p, ...last() };
  };
  const flags = m => '[--permission-mode] [' + m + '] [--approval-policy] [never]';
  // 默认：完全权限，和以前一样
  const a = await turn({ text: '看看目录' });
  assert.ok(a.args.includes(flags('danger-full-access')), a.args);
  assert.equal(a.mode, 'danger-full-access');
  assert.match(a.args, /\[--json\] \[看看目录\]$/, '普通一轮发给 Harness 的还是原话');
  const sid = a.r.sid;
  assert.equal(op('history', { sid }).session.perm, 'danger-full-access');
  // 换成工作区内修改：这一轮起作用，对话记住；续聊（--session-id）每一轮都重复带
  const b = await turn({ sid, text: '改个文件', perm: 'workspace-write' });
  assert.ok(b.args.includes(flags('workspace-write')) && b.args.includes('[--session-id]'), b.args);
  assert.equal(b.mode, 'workspace-write');
  const c = await turn({ sid, text: '再看看' });
  assert.ok(c.args.includes(flags('workspace-write')), c.args);
  assert.equal(op('history', { sid }).session.perm, 'workspace-write');
  // 计划模式：这一轮只读，任务前面是计划要求；对话的权限不变；用户那句、这一轮的结束都标着计划
  const d = await turn({ sid, text: '把 LED 改快一点', plan: true });
  assert.ok(d.args.includes(flags('read-only')), d.args);
  assert.equal(d.mode, 'read-only');
  assert.ok(d.args.includes('【计划模式】') && d.args.includes('只出计划') && d.args.endsWith('把 LED 改快一点]'), d.args);
  const h = op('history', { sid }), pr = h.runs.find(x => x.run === d.r.run);
  assert.deepEqual([pr.events[0].t, pr.events[0].text, pr.events[0].plan], ['user', '把 LED 改快一点', true]);
  assert.equal(pr.events.at(-1).t, 'done');
  assert.equal(pr.events.at(-1).plan, true);
  assert.equal(h.session.perm, 'workspace-write');
  // 按计划执行：下一句不带 plan，回到对话的权限
  const e = await turn({ sid, text: '按上面的计划执行。' });
  assert.ok(e.args.includes(flags('workspace-write')) && !e.args.includes('【计划模式】'), e.args);
  assert.equal(op('history', { sid }).runs.find(x => x.run === e.r.run).events[0].plan, undefined);
  // 不认识的权限：直接报错，不起 Harness，也不改对话记下的权限
  const n = calls().length;
  assert.deepEqual(op('send', { sid, text: 'x', perm: 'root' }), { error: 'bad_perm', msg: '权限只能是只读、工作区内修改或完全权限' });
  assert.equal(calls().length, n);
  assert.equal(op('history', { sid }).session.perm, 'workspace-write');
  // 新对话第一句就选只读
  const f = await turn({ text: '只看看', perm: 'read-only' });
  assert.ok(f.args.includes(flags('read-only')), f.args);
  assert.equal(op('history', { sid: f.r.sid }).session.perm, 'read-only');
  // 同一个消息标识换了权限再发：当成不同内容，不拿上一次的回执顶替
  const g = op('send', { sid, text: '同一句', perm: 'read-only', clientId: 'tq-perm-same-1' });
  assert.ok(g.run, JSON.stringify(g));
  await poll(op, g.run);
  assert.equal(op('send', { sid, text: '同一句', perm: 'danger-full-access', clientId: 'tq-perm-same-1' }).error, 'message_conflict');
});

// 工作区（设计 §4 第 3 个 PR）：新对话时选、之后固定（Harness 的会话按目录存，换目录就续不上），Harness 在那个文件夹里跑。
// 工作区是 /data/workspace（WORK）本身，或它下面一层的文件夹（计划的 Rulings：不是 ~/work）
test('天启的工作区：新对话选了工作区就在那个文件夹里跑；续聊固定；旧对话在工作目录；不认识的名字报错', async t => {
  const { dsh, log } = fakeDsh(fs.mkdtempSync(path.join(os.tmpdir(), 'xin-tq-dsh-')));
  const { home, xin, op } = agentEnv(t, { XIN_ROLE: 'tianqi', XIN_DSH: dsh });
  fs.writeFileSync(path.join(xin, 'harness.key'), 'gw-key-123\n', { mode: 0o600 });
  const work = path.join(home, 'work'), real = p => fs.realpathSync(p);
  const pwds = () => { try { return fs.readFileSync(log, 'utf8').split('\n').filter(l => l.startsWith('PWD=')).map(l => l.slice(4)); } catch { return []; } };
  const turn = async a => {
    const r = op('send', a);
    assert.ok(r.run, JSON.stringify(r));
    const p = await poll(op, r.run);
    assert.ok(p.done && p.events.at(-1).ok, JSON.stringify(p.events));
    return r;
  };
  const summary = sid => op('sessions', {}).sessions.find(s => s.sid === sid);
  // 新对话选了 blink：Harness 在 work/blink 里跑，文件夹建好了，对话记下工作区
  const a = await turn({ text: '看看', work: 'blink' });
  assert.equal(pwds().pop(), real(path.join(work, 'blink')));
  assert.equal(summary(a.sid).work, 'blink');
  assert.equal(op('history', { sid: a.sid }).session.work, 'blink');
  // 续聊带了别的工作区：不理，还在 blink，也不建那个文件夹
  await turn({ sid: a.sid, text: '再看', work: 'other' });
  assert.equal(pwds().pop(), real(path.join(work, 'blink')));
  assert.ok(!fs.existsSync(path.join(work, 'other')));
  assert.equal(summary(a.sid).work, 'blink');
  // 不选工作区：在工作目录本身（旧对话也是这样）
  const b = await turn({ text: '随便看看' });
  assert.equal(pwds().pop(), real(work));
  assert.equal(summary(b.sid).work, '');
  // 不认识的名字：报错，不起 Harness，工作目录外面什么都不建
  const n = pwds().length;
  for (const w of ['../x', '/etc', '.ssh', 'a/b', ' blink', '..', 'x'.repeat(65)])
    assert.deepEqual(op('send', { text: 'x', work: w }), { error: 'bad_work', msg: '工作区只能是 /data/workspace 下面一层的文件夹' }, w);
  assert.equal(pwds().length, n);
  assert.ok(!fs.existsSync(path.join(home, 'x')));
  // 同一个消息标识换了工作区再发：当成不同内容，不拿上一次的回执顶替
  const g = op('send', { sid: a.sid, text: '同一句', work: 'blink', clientId: 'tq-work-same-1' });
  assert.ok(g.run, JSON.stringify(g));
  await poll(op, g.run);
  assert.equal(op('send', { sid: a.sid, text: '同一句', work: 'other', clientId: 'tq-work-same-1' }).error, 'message_conflict');
});

// 终端里自己输命令（设计 §4 第 3 个 PR）：只给天启，在工作区里跑，最多 60 秒、输出最多 64 KB。
// 外壳转一个操作最多等 40 秒，所以命令放后台跑：term_run 马上回编号，term_poll 按字节位置取输出（计划的 Rulings）
test('天启的终端：在工作区里跑命令，有输出和退出码；超时停掉；输出最多 64 KB；新文件夹先建好；小芯不能用', async t => {
  const { home, op } = agentEnv(t, { XIN_ROLE: 'tianqi', XIN_TERM_LIMIT_MS: '1500' });
  const work = path.join(home, 'work');
  const run = async a => {
    const r = op('term_run', a);
    assert.ok(r.id, JSON.stringify(r));
    let p = {}, all = '', off = 0;
    for (const end = performance.now() + platformTimeout(10000); performance.now() < end;) {
      p = op('term_poll', { id: r.id, off });
      assert.ok(!p.error, JSON.stringify(p));
      all += p.out; off = p.off;
      if (p.done) break;
      await new Promise(ok => setTimeout(ok, 100));
    }
    return { ...p, all };
  };
  const a = await run({ work: 'blink', cmd: 'pwd -P; echo 你好; exit 3' });
  assert.deepEqual([a.done, a.code, a.timedOut, a.truncated], [true, 3, false, false]);
  assert.equal(a.all, fs.realpathSync(path.join(work, 'blink')) + '\n你好\n');
  // 超时（测试里把 60 秒调成 1.5 秒）：停掉，说是超时
  const b = await run({ work: '', cmd: 'sleep 30' });
  assert.deepEqual([b.done, b.timedOut], [true, true]);
  // 输出截到 64 KB，命令照样跑完
  const c = await run({ work: '', cmd: 'yes | head -c 200000' });
  assert.deepEqual([c.done, c.code, c.truncated, Buffer.byteLength(c.all)], [true, 0, true, 65536]);
  // 新对话选了还不存在的新文件夹：先建好再跑
  const d = await run({ work: 'new-folder', cmd: 'pwd -P' });
  assert.equal(d.all.trim(), fs.realpathSync(path.join(work, 'new-folder')));
  assert.equal(op('term_run', { work: '../x', cmd: 'pwd' }).error, 'bad_work');
  assert.ok(!fs.existsSync(path.join(home, 'x')));
  for (const cmd of ['', 'a\0b', 'x'.repeat(4001), 42]) assert.equal(op('term_run', { cmd }).error, 'bad_cmd', String(cmd).slice(0, 9));
  assert.equal(op('term_poll', { id: '../../etc/passwd', off: 0 }).error, 'bad_id');
  // 小芯（不是天启）：这两个操作不给用
  assert.equal(agentEnv(t, {}).op('term_run', { cmd: 'pwd' }).error, 'tianqi_only');
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
  assert.match(applied, /- insert:\n    - id: mcp-rea\n      name: "@deepseek-ai\/dsh-mcp-client"/);
  assert.ok(applied.includes('command: ' + JSON.stringify(process.execPath)));
  const reaArgs = JSON.parse(applied.match(/^\s*args: (.+)$/m)[1]);
  assert.equal(reaArgs[0], '-e');
  assert.match(reaArgs[1], /tools\/list/);
  assert.equal(reaArgs[2], launcher);
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

// 站长 11-20：聊天框底下「上下文 1% · 消耗 50.7万 token」不准。li2 上那个对话的 Harness 记录里，每次请求的用量是
// { inputTokens: 没命中缓存的输入, cacheReadTokens: 命中缓存的输入, outputTokens, totalTokens: 三项之和 }，以前只算了 inputTokens：
// 上下文算成 5 千（实际 35 万），消耗也漏了缓存命中。照 claudeUsage、codexUsage：从 Harness 自己的会话记录算整个对话，读不到再用这一轮流里的数。
test('天启的用量：输入算上缓存命中、上下文取最后一次请求的 totalTokens；有 Harness 的会话记录时按记录算整个对话', async t => {
  const zlib = require('node:zlib');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-tq-use-'));
  // 没有会话记录：按流里每一步的用量
  const SID1 = 'session-2b6d1a40-7c11-4e2a-9f3e-0a1b2c3d4e5f';
  const dsh1 = fakeDshUsage(dir, SID1, [
    { inputTokens: 300, outputTokens: 50, totalTokens: 10050, cacheReadTokens: 9700 },
    { inputTokens: 200, outputTokens: 80, totalTokens: 10330, cacheReadTokens: 10050 }]);
  const a = agentEnv(t, { XIN_ROLE: 'tianqi', XIN_DSH: dsh1 });
  fs.writeFileSync(path.join(a.xin, 'harness.key'), 'gw-key-123\n', { mode: 0o600 });
  const r1 = a.op('send', { text: '看看' });
  const p1 = await poll(a.op, r1.run);
  assert.deepStrictEqual(p1.events.at(-1).usage, { ctx: 10330, win: 1000000, input: 20250, cached: 19750, output: 130, total: 20380 });
  // 有会话记录（zstd 压缩的 JSONL，每次请求一条 assistant/message）：整个对话按记录算，流里的数不用
  const SID2 = 'session-906b7cf0-69b5-43a2-a52e-9e647a57621b';
  const dsh2 = fakeDshUsage(dir, SID2, [{ inputTokens: 1, outputTokens: 1, totalTokens: 2 }]);
  const b = agentEnv(t, { XIN_ROLE: 'tianqi', XIN_DSH: dsh2 });
  fs.writeFileSync(path.join(b.xin, 'harness.key'), 'gw-key-123\n', { mode: 0o600 });
  const logDir = path.join(path.dirname(b.xin), 'dsh', 'sessions', '--data-workspace--', SID2);
  fs.mkdirSync(logDir, { recursive: true });
  const call = u => JSON.stringify({ type: 'assistant/message', seq: 1, time: 1, data: { turn: 1, step: 1, message: { role: 'assistant', content: [] }, usage: u } });
  const lines = [JSON.stringify({ type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } }),
    call({ inputTokens: 4733, outputTokens: 337, totalTokens: 350158, cacheReadTokens: 345088 }),
    JSON.stringify({ type: 'step/end', seq: 2, time: 2, data: { turn: 1, step: 1 } }),
    call({ inputTokens: 217, outputTokens: 796, totalTokens: 350965, cacheReadTokens: 349952 }),
    call({ inputTokens: 189, outputTokens: 380, totalTokens: 351417, cacheReadTokens: 350848 })];
  fs.writeFileSync(path.join(logDir, 'session.v4.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(lines.join('\n') + '\n')));
  const r2 = b.op('send', { text: '看看' });
  const p2 = await poll(b.op, r2.run);
  const want = { ctx: 351417, win: 1000000, input: 1051027, cached: 1045888, output: 1513, total: 1052540 };
  assert.deepStrictEqual(p2.events.at(-1).usage, want);
  assert.deepStrictEqual(b.op('history', { sid: r2.sid }).usage, want);
});
