// 后台可靠性第二批（2026-11-12）：云电脑刚醒时前台先等网关预热；用量口径；第一批留下的三个小问题。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const { platformTimeout } = require('./helpers/timeout.cjs');

function agentEnv(extraEnv = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-b2-')), work = path.join(home, 'work');
  const env = Object.assign({}, process.env, { XIN_HOME: path.join(home, 'xin'), XIN_WORK: work }, extraEnv);
  env.NODE_OPTIONS = (env.NODE_OPTIONS || '') + ' --require=' + path.join(__dirname, 'helpers/front-responses.cjs');
  const agent = path.join(__dirname, '../site/xin/vm-agent.mjs');
  const op = (name, args) => JSON.parse(execFileSync(process.execPath, [agent, name], { env, input: JSON.stringify(args || {}) }).toString());
  return { home, work, xin: env.XIN_HOME, op };
}
const sleep = ms => new Promise(ok => setTimeout(ok, ms));

test('云电脑刚醒、网关在预热：前台先等预热做完再发请求，不再 25 秒就放弃；等的时候告诉网页「刚醒」', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-b2-cold-')), cold = path.join(tmp, 'cold'), log = path.join(tmp, 'front.log');
  const { xin, op } = agentEnv({ XIN_FRONT_TEST_COLD: cold, XIN_FRONT_TEST_LOG: log });
  fs.mkdirSync(xin, { recursive: true });
  // 预热刚开始（greet 叫醒电脑时起的）：网关这时收到的请求会卡很久
  fs.writeFileSync(path.join(xin, 'warm.json'), JSON.stringify({ at: Date.now(), running: true }));
  fs.writeFileSync(cold, '');
  const r = op('send', { agent: 'codex', text: '早上好' });
  assert.ok(r.run, JSON.stringify(r));
  await sleep(1500);
  // 预热的那个请求终于回来了：网关热了
  fs.rmSync(cold);
  fs.writeFileSync(path.join(xin, 'warm.json'), JSON.stringify({ at: Date.now(), ms: 1500, ok: true }));
  let p = null;
  for (const end = Date.now() + platformTimeout(40000); Date.now() < end;) { p = op('poll', { run: r.run, off: 0 }); if (p.done) break; await sleep(200); }
  assert.ok(p && p.done, '这一轮没有结束');
  const done = p.events.find(e => e.t === 'done');
  assert.equal(done.ok, true, JSON.stringify(p.events.slice(-3)));
  assert.ok(p.events.some(e => e.t === 'text' && e.text === '好的'), '有回答');
  assert.ok(p.events.some(e => e.t === 'status' && /刚醒/.test(e.text)), '等预热时告诉网页');
  assert.equal(fs.readFileSync(log, 'utf8').trim().split('\n').length, 1, '只发了一次请求，而且是在预热之后');
});

test('预热记录坏了或卡死（超过 200 秒还标着在跑）：前台不等，照常发', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-b2-stale-')), log = path.join(tmp, 'front.log');
  const { xin, op } = agentEnv({ XIN_FRONT_TEST_LOG: log });
  fs.mkdirSync(xin, { recursive: true });
  fs.writeFileSync(path.join(xin, 'warm.json'), JSON.stringify({ at: Date.now() - 300e3, running: true }));
  const t0 = Date.now(), r = op('send', { agent: 'codex', text: '在吗' });
  let p = null;
  for (const end = Date.now() + platformTimeout(15000); Date.now() < end;) { p = op('poll', { run: r.run, off: 0 }); if (p.done) break; await sleep(150); }
  assert.ok(p && p.done && p.events.find(e => e.t === 'done').ok);
  assert.ok(!p.events.some(e => e.t === 'status' && /刚醒/.test(e.text)), '没有等');
  assert.ok(Date.now() - t0 < platformTimeout(10000));
});

/* ---------- 第一批留下的小问题 ---------- */
const AGENT = path.join(__dirname, '../site/xin/vm-agent.mjs');
const loadAgent = () => { process.env.XIN_HOME ||= fs.mkdtempSync(path.join(os.tmpdir(), 'xin-b2-import-')); return import(require('node:url').pathToFileURL(AGENT).href); };

test('等回答到点时「记下问题」抢不到锁：隔几秒再试，记下了才交还；重试期间来了回答就用回答', async () => {
  const { awaitTaskInput } = await loadAgent();
  let t = 0, tries = 0;
  const now = () => t, sleep = ms => { t += ms; return Promise.resolve(); };
  // 前两次锁忙（lockedCall 返回 error），第三次记下
  const r = await awaitTaskInput({ id: 'a1', holdMs: 1000, read: () => ({}), now, sleep, expire: () => (++tries < 3 ? { error: 'busy', msg: '锁忙' } : { ok: true }) });
  assert.deepEqual(r, { expired: true });
  assert.equal(tries, 3, '失败的要重试');
  assert.ok(t >= 1000 + 2 * 5000, '两次重试之间至少隔 5 秒');
  // 重试期间站长回答了：用回答，不再记问题
  t = 0; tries = 0; let answered = false;
  const r2 = await awaitTaskInput({ id: 'a1', holdMs: 1000, read: () => (answered ? { approvalReplies: { a1: '好' } } : {}), now, sleep,
    expire: () => { tries++; answered = true; return { error: 'busy' }; } });
  assert.deepEqual(r2, { reply: '好' });
  assert.equal(tries, 1);
  // 一直记不下（比如状态库坏了）：最多试 2 分钟，然后照样交还，不卡住这一轮
  t = 0; tries = 0;
  const r3 = await awaitTaskInput({ id: 'a1', holdMs: 1000, read: () => ({}), now, sleep, expire: () => { tries++; return { error: 'busy' }; } });
  assert.deepEqual(r3, { expired: true, unsaved: true });
  assert.ok(t <= 1000 + 125e3 && tries >= 20, JSON.stringify({ t, tries }));
});

test('删 7 天前做完的任务副本改由任务锁里的操作来做（和重新打开任务互斥）；每日清理照常', () => {
  const { op, xin } = agentEnv();
  fs.mkdirSync(xin, { recursive: true });
  const r = JSON.parse(execFileSync(process.execPath, [AGENT, 'locked', 'task_copies_prune'], { env: { ...process.env, XIN_HOME: xin }, input: '{}' }).toString());
  assert.deepEqual(r, { removed: 0, bytes: 0 });
  assert.equal(typeof op('prune').bytes, 'number');
});
