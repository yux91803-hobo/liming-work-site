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

// 告诉网页的那句 2026-11-16 按文案标准改成「电脑刚唤醒，正在连接网络」（原来「电脑刚醒，网络在热身，稍等一下」），下面按「刚唤醒」认
test('云电脑刚醒、网关在预热：前台先等预热做完再发请求，不再 25 秒就放弃；等的时候告诉网页「刚唤醒」', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-b2-cold-')), cold = path.join(tmp, 'cold'), log = path.join(tmp, 'front.log');
  const { xin, op } = agentEnv({ XIN_FRONT_TEST_COLD: cold, XIN_FRONT_TEST_LOG: log });
  fs.mkdirSync(xin, { recursive: true });
  // 预热刚开始（greet 叫醒电脑时起的）：网关这时收到的请求会卡很久
  fs.writeFileSync(path.join(xin, 'warm.json'), JSON.stringify({ at: Date.now(), running: true }));
  fs.writeFileSync(cold, '');
  const r = op('send', { agent: 'codex', text: '早上好' });
  assert.ok(r.run, JSON.stringify(r));
  // 预热一直卡着，直到前台真的进了「等预热」、告诉了网页「刚醒」：按事件等，不按固定时间。
  // 以前固定只给 1.5 秒：笔记本上的 CI 起后台进程慢，进到「等预热」时预热已经结束，就不会说「刚醒」（#146）。
  // 参考 Node.js doc/contributing/writing-tests.md 的 Timers 一节：除非测的就是计时，别用定时器，它是不稳定的主要来源。
  let told = false;
  for (const end = performance.now() + platformTimeout(20000); performance.now() < end;) {
    if (op('poll', { run: r.run, off: 0 }).events.some(e => e.t === 'status' && /刚唤醒/.test(e.text))) { told = true; break; }
    await sleep(200);
  }
  assert.ok(told, '等预热时告诉网页');
  assert.ok(!fs.existsSync(log), '预热还没做完，前台没发请求');
  // 预热的那个请求终于回来了：网关热了
  fs.rmSync(cold);
  fs.writeFileSync(path.join(xin, 'warm.json'), JSON.stringify({ at: Date.now(), ms: 1500, ok: true }));
  let p = null;
  for (const end = performance.now() + platformTimeout(40000); performance.now() < end;) { p = op('poll', { run: r.run, off: 0 }); if (p.done) break; await sleep(200); }
  assert.ok(p && p.done, '这一轮没有结束');
  const done = p.events.find(e => e.t === 'done');
  assert.equal(done.ok, true, JSON.stringify(p.events.slice(-3)));
  assert.ok(p.events.some(e => e.t === 'text' && e.text === '好的'), '有回答');
  assert.ok(p.events.some(e => e.t === 'status' && /刚唤醒/.test(e.text)), '等预热时告诉网页');
  assert.equal(fs.readFileSync(log, 'utf8').trim().split('\n').length, 1, '只发了一次请求，而且是在预热之后');
});

test('预热记录坏了或卡死（超过 200 秒还标着在跑）：前台不等，照常发', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-b2-stale-')), log = path.join(tmp, 'front.log');
  const { xin, op } = agentEnv({ XIN_FRONT_TEST_LOG: log });
  fs.mkdirSync(xin, { recursive: true });
  fs.writeFileSync(path.join(xin, 'warm.json'), JSON.stringify({ at: Date.now() - 300e3, running: true }));
  const t0 = performance.now(), r = op('send', { agent: 'codex', text: '在吗' });
  let p = null;
  for (const end = performance.now() + platformTimeout(15000); performance.now() < end;) { p = op('poll', { run: r.run, off: 0 }); if (p.done) break; await sleep(150); }
  assert.ok(p && p.done && p.events.find(e => e.t === 'done').ok);
  assert.ok(!p.events.some(e => e.t === 'status' && /刚唤醒/.test(e.text)), '没有等');
  assert.ok(performance.now() - t0 < platformTimeout(10000));
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

test('每日任务关掉云电脑管理插件（instabox：开关机、快照、删机器），桌面操作插件留着（补签可能要用）；普通后台任务照旧全关', async () => {
  const { agentArgs } = await loadAgent();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-b2-mcp-')), sys = path.join(tmp, 'config.toml');
  fs.writeFileSync(sys, '[mcp_servers.open-computer-use]\ncommand = "x"\n\n[mcp_servers.instabox]\ncommand = "y"\n');
  const saved = process.env.XIN_CODEX_SYS; process.env.XIN_CODEX_SYS = sys;
  try {
    const flags = a => a[1].filter((x, i) => a[1][i - 1] === '-c' && /^mcp_servers\./.test(x));
    const daily = agentArgs('codex', { sid: 'sdaily0001', dailyDate: '2026-11-12', started: false }, '每日任务', 'max', { role: 'task', sandbox: false });
    assert.ok(flags(daily).includes('mcp_servers.instabox.enabled=false'), JSON.stringify(flags(daily)));
    assert.ok(!flags(daily).some(x => x.startsWith('mcp_servers.open-computer-use.enabled=false')));
  } finally { if (saved === undefined) delete process.env.XIN_CODEX_SYS; else process.env.XIN_CODEX_SYS = saved; }
});
