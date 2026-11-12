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
