// 后台可靠性第一批（docs/xin-reliability-usage-design.md 的 A 部分）：每日任务目录、临时错误重试、等回答时限、轮询按字节读。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const { platformTimeout } = require('./helpers/timeout.cjs');
const { stopOwned } = require('./helpers/stop-owned.cjs');
const AGENT = path.join(__dirname, '../site/xin/vm-agent.mjs');

// 假 codex（exec 传输）：每次调用记下参数和工作目录。
// - 每日任务（输入里有「到点做每日任务了」）：$L/hold-daily 存在时一直等。
// - 后台任务（设定里有【你现在在后台】）：$L/hold-bg 存在时一直等；$L/script 里一行一个动作，按调用顺序取：
//   ok（正常做完）、fail:<信息>（先执行一条命令再 turn.failed）。没写就是 ok。
function fakeCodex(dir) {
  const bin = path.join(dir, 'bin'), log = path.join(dir, 'log');
  fs.mkdirSync(bin, { recursive: true }); fs.mkdirSync(log, { recursive: true });
  fs.writeFileSync(path.join(bin, 'codex'), [
    '#!/bin/sh',
    'case "$*" in *--ephemeral*) exit 0;; esac',
    'L="' + log + '"',
    'exec 9>"$L/seq.lock"; flock 9',
    'n=$(cat "$L/n" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$L/n"',
    'for a in "$@"; do printf "%s\\n" "$a"; done > "$L/args.$n"; pwd > "$L/cwd.$n"',
    'flock -u 9; exec 9>&-',
    'printf \'{"type":"thread.started","thread_id":"0199a213-81c0-7800-8aa1-%012d"}\\n\' $n',
    'echo \'{"type":"turn.started"}\'',
    'case "$*" in',
    '  *到点做每日任务了*) while [ -f "$L/hold-daily" ]; do sleep 0.1; done;;',
    '  *【你现在在后台】*)',
    '    while [ -f "$L/hold-bg" ]; do sleep 0.1; done',
    '    exec 9>"$L/script.lock"; flock 9',
    '    k=$(cat "$L/k" 2>/dev/null || echo 0); k=$((k+1)); echo $k > "$L/k"',
    '    act=$(sed -n "${k}p" "$L/script" 2>/dev/null)',
    '    flock -u 9; exec 9>&-',
    '    case "$act" in fail:*)',
    '      echo \'{"type":"item.completed","item":{"id":"c1","type":"command_execution","command":"make","aggregated_output":"ok","exit_code":0,"status":"completed"}}\'',
    '      printf \'{"type":"turn.failed","error":{"message":"%s"}}\\n\' "${act#fail:}"; exit 1;;',
    '    esac;;',
    'esac',
    'echo \'{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"做好了"}}\'',
    'echo \'{"type":"turn.completed","usage":{}}\''
  ].join('\n'), { mode: 0o755 });
  const calls = () => fs.readdirSync(log).filter(f => /^args\.\d+$/.test(f)).sort((a, b) => a.split('.')[1] - b.split('.')[1])
    .map(f => ({ args: fs.readFileSync(path.join(log, f), 'utf8'), cwd: fs.readFileSync(path.join(log, 'cwd.' + f.split('.')[1]), 'utf8').trim() }));
  return { bin, log, calls };
}

function home(t, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-batch1-')), xin = path.join(dir, 'xin'), work = path.join(dir, 'work');
  fs.mkdirSync(xin, { recursive: true }); fs.mkdirSync(work, { recursive: true }); fs.mkdirSync(path.join(dir, 'tmp'));
  const fc = fakeCodex(dir);
  const env = { ...process.env, TMPDIR: path.join(dir, 'tmp'), XIN_HOME: xin, XIN_WORK: work, XIN_CODEX_TRANSPORT: 'exec', XIN_FRONT_PROVIDER: 'deepseek',
    XIN_DSH: path.join(dir, 'no-dsh'), XIN_AGY_HOME: dir, XIN_ANTIGRAVITY_BIN: '', CODEX_HOME: path.join(dir, 'codex'), PATH: fc.bin + ':' + process.env.PATH, ...extra };
  const run = (argv, args) => { const r = spawnSync(process.execPath, [AGENT, ...argv], { env, input: JSON.stringify(args || {}), encoding: 'utf8', timeout: platformTimeout(20000) }); assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); };
  const op = (name, args) => run([name], args), locked = (name, args) => run(['locked', name], args);
  const hold = (name, on) => { const f = path.join(fc.log, 'hold-' + name); if (on) fs.writeFileSync(f, ''); else fs.rmSync(f, { force: true }); };
  const script = lines => fs.writeFileSync(path.join(fc.log, 'script'), lines.join('\n') + '\n');
  const task = sid => JSON.parse(fs.readFileSync(path.join(xin, 'sessions', sid + '.json'), 'utf8'));
  t.after(() => stopOwned(xin, dir));
  return { dir, xin, work, env, op, locked, hold, script, task, fc };
}
async function until(fn, ms = 15000, what = '') {
  const end = Date.now() + platformTimeout(ms); let v;
  while (Date.now() < end) { v = fn(); if (v) return v; await new Promise(ok => setTimeout(ok, 120)); }
  throw new Error('等不到：' + what + ' ' + JSON.stringify(v));
}

test('每日任务在跑时普通任务照样开始：每日任务用自己的目录 WORK/daily', async t => {
  const h = home(t);
  h.op('daily_set', { text: '- 网关签到' });
  h.hold('daily', true);
  const d = h.op('daily', {});
  assert.ok(d.sid, JSON.stringify(d));
  await until(() => h.fc.calls().some(c => c.args.includes('到点做每日任务了')), 15000, '每日任务开始');
  const n = h.locked('task_new', { kind: 'code', title: '普通任务', goal: '做点事' });
  assert.ok(n.task, JSON.stringify(n));
  await until(() => h.task(n.task.sid).status !== 'queued', 15000, '普通任务不再排队');
  assert.equal(h.task(d.sid).status, 'running', '每日任务还在跑');
  assert.equal(h.task(d.sid).dir, path.join(h.work, 'daily'));
  assert.equal(h.fc.calls().find(c => c.args.includes('到点做每日任务了')).cwd, fs.realpathSync(path.join(h.work, 'daily')));
  h.hold('daily', false);
});

test('同一个项目目录的两个任务仍然排队', async t => {
  const h = home(t);
  fs.mkdirSync(path.join(h.work, 'proj'));
  h.hold('bg', true);
  const a = h.locked('task_new', { kind: 'code', title: '甲', goal: '改 proj', dir: 'proj' });
  await until(() => h.task(a.task.sid).status === 'running', 15000, '甲开始');
  const b = h.locked('task_new', { kind: 'code', title: '乙', goal: '也改 proj', dir: 'proj' });
  await new Promise(ok => setTimeout(ok, platformTimeout(800)));
  assert.equal(h.task(b.task.sid).status, 'queued');
  h.hold('bg', false);
  await until(() => h.task(b.task.sid).status === 'done', 20000, '乙最后也做完');
});
