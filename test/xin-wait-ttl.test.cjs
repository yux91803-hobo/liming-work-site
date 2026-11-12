// 站长 2026-11-12：工作台里「查网关签到积分」挂着「待确认」6 个小时，「这种东西有什么意义吗？」；选了「取消待确认」。
// 参考：Grok Bot 的后台子任务只有 running / done / error / aborted 四种状态（frontend conversation-outline-view.tsx），没有「等用户」；
// Codex 云端任务一跑到底，有疑问写进结果；OpenMuse 的批准请求带 expiresAt，30 分钟没处理就作废（apps/server/src/actions.ts）。
// 改成：能自己定的不问；只剩「要批准的事、登录、写回确认」会停下等，30 分钟没回就停下（不再提醒），回一句照样接着做；
// 中途断了两次、复核找不到模型这类不是问题的，直接算没做成。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { platformTimeout } = require('./helpers/timeout.cjs');
const agent = path.join(__dirname, '../site/xin/vm-agent.mjs');

// 同 xin-runtime.test.cjs 的 fixture：直接写任务记录，再调 locked 操作
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-wait-ttl-'));
  for (const d of ['control/sessions', 'control/runs', 'project', 'profile', 'codex']) fs.mkdirSync(path.join(root, d), { recursive: true });
  const env = { ...process.env, XIN_HOME: path.join(root, 'control'), XIN_WORK: root, CODEX_HOME: path.join(root, 'codex'), XIN_TASK_MAX: '1' };
  const preload = path.join(root, 'preload.cjs');
  fs.writeFileSync(preload, `require('node:os').homedir=()=>${JSON.stringify(path.join(root, 'profile'))};require('node:module').syncBuiltinESMExports();`);
  env.NODE_OPTIONS = '--require=' + preload;
  t.after(async () => {
    // 回一句会让调度器真的起一轮（runner），收尾前先把这个 XIN_HOME 起的进程都停掉（同 xin-runtime.test.cjs）
    const r = await import(pathToFileURL(agent).href);
    const owned = () => fs.readdirSync('/proc').filter(n => /^\d+$/.test(n) && Number(n) !== process.pid).flatMap(n => {
      try {
        if (!fs.readFileSync('/proc/' + n + '/environ', 'utf8').split('\0').includes('XIN_HOME=' + env.XIN_HOME)) return [];
        const identity = r.processIdentity(Number(n));
        return identity && !['Z', 'X'].includes(identity.state) ? [{ pid: Number(n), identity }] : [];
      } catch { return []; }
    });
    const deadline = Date.now() + platformTimeout(5000);
    while (owned().length && Date.now() < deadline) {
      for (const p of owned()) r.signalProcessGroup(p.pid, p.identity, 'SIGKILL');
      await new Promise(ok => setTimeout(ok, 30));
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const call = (op, args) => {
    const r = spawnSync(process.execPath, [agent, 'locked', op], { env, input: JSON.stringify(args || {}), encoding: 'utf8', timeout: platformTimeout(15000) });
    assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout);
  };
  const task = { sid: 'swaitttl001', no: 1, kind: 'task', tkind: 'code', title: '查网关签到积分', dir: path.join(root, 'project'), goal: '现在有多少积分',
    status: 'running', model: 'glm-5.3', runs: ['rwaitttl001'], created: Date.now(), inbox: [] };
  const save = () => fs.writeFileSync(path.join(env.XIN_HOME, 'sessions', task.sid + '.json'), JSON.stringify(task));
  const read = () => JSON.parse(fs.readFileSync(path.join(env.XIN_HOME, 'sessions', task.sid + '.json')));
  save();
  fs.writeFileSync(path.join(env.XIN_HOME, 'runs/rwaitttl001.json'), JSON.stringify({ sid: task.sid, started: Date.now(), pid: process.pid, ended: Date.now() }));
  fs.writeFileSync(path.join(env.XIN_HOME, 'runs/rwaitttl001.jsonl'), JSON.stringify({ t: 'text', text: '面板连不上。' }) + '\n');
  return { root, env, task, save, read, call };
}
const MIN = 60e3;
const waiting = (f, extra) => { Object.assign(f.task, { status: 'waiting', question: '请启动面板或提供地址', finishedRun: 'rwaitttl001', frontSeen: true,
  result: { ok: false, text: '面板连不上。', at: Date.now() - 31 * MIN } }, extra); f.save(); };

test('等确认 30 分钟没回：任务停下，不再挂着；结果里写明当时问的是什么；不再提醒前台', t => {
  const f = fixture(t);
  waiting(f, { endedAt: Date.now() - 31 * MIN });
  f.call('task_tick', {});
  const x = f.read();
  assert.equal(x.status, 'stopped');
  assert.equal(x.question, '');
  assert.equal(x.expired.question, '请启动面板或提供地址');
  assert.match(x.result.text, /30 分钟/); assert.match(x.result.text, /请启动面板或提供地址/); assert.match(x.result.text, /回复一句/);
  assert.equal(x.frontSeen, true, '过期不再当新消息告诉站长（Grok Bot：过时的、站长没在等的不说）');
});

test('还没到 30 分钟的照样等着；任务列表给出到期时间', t => {
  const f = fixture(t);
  const ended = Date.now() - 5 * MIN;
  waiting(f, { endedAt: ended });
  const r = f.call('task_tick', {});
  assert.ok(r);
  assert.equal(f.read().status, 'waiting');
  const s = spawnSync(process.execPath, [agent, 'tasks'], { env: f.env, input: JSON.stringify({ all: true }), encoding: 'utf8', timeout: platformTimeout(15000) });
  assert.equal(s.status, 0, s.stderr);
  const row = JSON.parse(s.stdout).tasks.find(x => x.sid === f.task.sid);
  assert.equal(row.waitUntil, ended + 30 * MIN);
});

test('写回确认过期：当作不写回，原项目不动、副本保留；登录等待过期一样停下', t => {
  const f = fixture(t);
  waiting(f, { endedAt: Date.now() - 40 * MIN, question: '允许这次写回吗？', publication: { pending: true, deleted: [], conflicts: ['main.c'] }, result: { ok: false, text: '改好了。', at: Date.now() - 40 * MIN } });
  f.call('task_tick', {});
  let x = f.read();
  assert.equal(x.status, 'stopped'); assert.equal(x.publication, undefined); assert.match(x.result.text, /原项目未更改/);
  const g = fixture(t);
  waiting(g, { endedAt: Date.now() - 31 * MIN, question: '要你登录 bilibili.com', browserStep: { kind: 'login', site: 'bilibili.com', url: 'https://bilibili.com/', at: Date.now() - 31 * MIN } });
  g.call('task_tick', {});
  x = g.read();
  assert.equal(x.status, 'stopped'); assert.equal(x.browserStep, undefined);
});

test('过期停下的任务，站长回一句照样接着做', t => {
  const f = fixture(t);
  waiting(f, { endedAt: Date.now() - 31 * MIN });
  f.call('task_tick', {});
  const r = f.call('task_tell', { sid: f.task.sid, text: '面板地址是 127.0.0.1:8788' });
  assert.ok(!r.error, JSON.stringify(r));
  const x = f.read();
  assert.ok(['queued', 'running'].includes(x.status), x.status);
  assert.equal(x.expired, undefined);
  // 排队时在 next 里；调度器已经开工的，在这一轮的启动记录里
  const last = (x.runs || []).slice(-1)[0], meta = last && last !== 'rwaitttl001' ? JSON.parse(fs.readFileSync(path.join(f.env.XIN_HOME, 'runs', last + '.json'), 'utf8')) : {};
  const handed = (x.next || '') + (meta.text || '');
  assert.match(handed, /127\.0\.0\.1:8788/);
  assert.match(handed, /你之前问的是：请启动面板或提供地址/);
});

test('中途断了两次：直接算没做成，不停在待确认；回一句照样接着做', t => {
  const f = fixture(t);
  f.task.resumes = 1; f.save();
  f.call('task_finish', { sid: f.task.sid, run: 'rwaitttl001', died: true });
  const x = f.read();
  assert.equal(x.status, 'failed');
  assert.equal(x.question || '', '');
  assert.match(x.result.text, /中途断了两次/);
  f.call('task_tell', { sid: f.task.sid, text: '继续' });
  assert.ok(['queued', 'running'].includes(f.read().status));
});

test('提示词：xin task ask 只用于要批准的事，问了 30 分钟没回就停下；做不了直接结束说原因', async () => {
  process.env.XIN_HOME ||= fs.mkdtempSync(path.join(os.tmpdir(), 'xin-wait-ttl-p-'));
  const { taskSystemPrompt } = await import(pathToFileURL(path.join(__dirname, '../site/xin/vm-persona.mjs')).href);
  const boxed = taskSystemPrompt({ no: 1, title: 'x', tkind: 'code', dir: '/d/p', workspace: { work: '/w/work', home: '/w/home', tmp: '/w/tmp' }, goal: 'g' });
  assert.match(boxed, /ask 只用于/); assert.match(boxed, /30 分钟/); assert.match(boxed, /不要用它问/);
  const host = taskSystemPrompt({ no: 2, title: 'y', tkind: 'system', dir: '/d/system', goal: 'g' });
  assert.match(host, /30 分钟/);
});

test('前台转述在等确认的任务时说明还能等多久；清理定时器也会把过期的停下', async t => {
  const f = fixture(t);
  waiting(f, { endedAt: Date.now() - 10 * MIN, parent: 'sconvttl0001' });
  f.call('task_tick', {});
  const s = spawnSync(process.execPath, ['-e', `import(${JSON.stringify(pathToFileURL(agent).href)}).then(m=>{const all=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).tasks;console.log(JSON.stringify(m.taskNotes('sconvttl0001',all)))})`, path.join(f.env.XIN_HOME, 'tasks-index.json')],
    { env: f.env, encoding: 'utf8', timeout: platformTimeout(15000) });
  assert.equal(s.status, 0, s.stderr);
  assert.match(s.stdout, /2[01] 分钟内没回复就先停下/);
  // 清理定时器跑 reap：没有别的东西碰任务，过期的照样停下
  Object.assign(f.task, f.read(), { endedAt: Date.now() - 31 * MIN }); f.save();
  fs.rmSync(path.join(f.env.XIN_HOME, 'tasks-index.json'), { force: true });
  const r = spawnSync(process.execPath, [agent, 'reap'], { env: { ...f.env, XIN_PROC_ROOT: path.join(f.root, 'noproc') }, encoding: 'utf8', timeout: platformTimeout(15000) });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(f.read().status, 'stopped');
});
