// 待送达（Durable Object 实例 xin-inbox，src/xin-inbox.js）：存好了才说收到、按编号去重、租约加自续闹钟加退避、24 小时不丢、按顺序送。
// 设计见 docs/xin-kernel-design.md §14.1、§14.4。
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = rel => import(pathToFileURL(path.join(__dirname, rel)).href);
const T0 = 1794550000000, H = 3600e3, DAY = 24 * H;
const tick = () => new Promise(r => setImmediate(r));

function memStorage() {
  const values = new Map(), s = { values, alarm: null, alarmSets: [], putFails: false, log: [] };
  Object.assign(s, {
    get: async k => structuredClone(values.get(k)),
    put: async (k, v) => { if (s.putFails) throw new Error('storage down'); values.set(k, structuredClone(v)); },
    delete: async k => { for (const x of [].concat(k)) values.delete(x); },
    list: async ({ prefix } = {}) => new Map([...values].filter(([k]) => !prefix || k.startsWith(prefix)).map(([k, v]) => [k, structuredClone(v)])),
    setAlarm: async t => { s.alarm = t; s.alarmSets.push(t); s.log.push('setAlarm'); },
    getAlarm: async () => s.alarm,
    deleteAlarm: async () => { s.alarm = null; }
  });
  return s;
}
async function inbox(o = {}) {
  const { Inbox } = await load('../src/xin-inbox.js');
  const storage = o.storage || memStorage();
  const clock = { now: o.now || T0 };
  const calls = [];
  let deliver = o.deliver || (async () => ({ ok: true, data: { sid: 's1', run: 'r1' } }));
  const ib = new Inbox(storage, { deliver: row => { calls.push(row); storage.log.push('deliver'); return deliver(row); }, now: () => clock.now, budgetMs: o.budgetMs ?? 50 });
  return { ib, storage, clock, calls, setDeliver: f => { deliver = f; } };
}
const ARGS = { text: '你好', sid: 's1' };

test('存好了才回收到：存不上就抛错，也不去送', async () => {
  const x = await inbox(); x.storage.putFails = true;
  await assert.rejects(x.ib.accept({ id: 'cid-00000001', op: 'send', args: ARGS }));
  assert.strictEqual(x.calls.length, 0);
});

test('电脑醒着：当场送到，编号和 clientId 一样，记下轮次号', async () => {
  const x = await inbox();
  const { view } = await x.ib.accept({ id: 'cid-00000001', op: 'send', args: ARGS });
  assert.strictEqual(view.state, 'delivered');
  assert.strictEqual(view.id, 'cid-00000001');
  assert.deepStrictEqual(view.result, { sid: 's1', run: 'r1' });
  assert.deepStrictEqual([view.sid, view.text], ['s1', '你好']);
});

test('同一编号再发不重复送；内容不同算冲突', async () => {
  const x = await inbox();
  await x.ib.accept({ id: 'cid-00000001', op: 'send', args: ARGS });
  const again = await x.ib.accept({ id: 'cid-00000001', op: 'send', args: { sid: 's1', text: '你好' } });   // 键的顺序不同，内容一样
  assert.strictEqual(again.view.result.run, 'r1');
  assert.strictEqual(x.calls.length, 1);
  assert.deepStrictEqual(await x.ib.accept({ id: 'cid-00000001', op: 'send', args: { text: '别的' } }), { error: 'conflict' });
  assert.deepStrictEqual(await x.ib.accept({ id: 'bad id!', op: 'send', args: ARGS }), { error: 'bad_id' });
});

test('电脑在睡：预算到了先回等待，租约过期后闹钟接着送', async () => {
  const x = await inbox({ deliver: () => new Promise(() => {}) });   // 一直没回音
  const { view } = await x.ib.accept({ id: 'cid-00000002', op: 'send', args: ARGS });
  assert.strictEqual(view.state, 'pending');
  assert.strictEqual(view.attempts, 1);
  assert.ok(x.storage.alarm && x.storage.alarm <= T0 + 120000, '闹钟不晚于租约到期');
  x.setDeliver(async () => ({ ok: true, data: { sid: 's1', run: 'r9' } }));
  x.clock.now = T0 + 121000;
  await x.ib.alarm();
  const v = await x.ib.view('cid-00000002');
  assert.deepStrictEqual([v.state, v.result.run, v.attempts], ['delivered', 'r9', 2]);
});

test('冷却：等到冷却结束再送，等待原因写清楚', async () => {
  const x = await inbox({ deliver: async () => ({ ok: false, state: 'cooldown', retryAfter: 3600 }) });
  const { view } = await x.ib.accept({ id: 'cid-00000003', op: 'send', args: ARGS });
  assert.strictEqual(view.state, 'pending');
  assert.deepStrictEqual([view.wait.state, view.wait.until], ['cooldown', T0 + 3600e3]);
  assert.strictEqual((await x.storage.get('inbox:row:cid-00000003')).nextAt, T0 + 3600e3);
  assert.strictEqual(x.storage.alarm, T0 + 3600e3);
});

test('叫醒中：几秒后再试，记下等过叫醒', async () => {
  const x = await inbox({ deliver: async () => ({ ok: false, state: 'waking', retryAfter: 3 }) });
  const { view } = await x.ib.accept({ id: 'cid-00000004', op: 'send', args: ARGS });
  assert.strictEqual(view.wait.state, 'waking');
  assert.strictEqual((await x.storage.get('inbox:row:cid-00000004')).nextAt, T0 + 3000);
});

test('闹钟先给自己续上，再去送', async () => {
  const x = await inbox({ deliver: async () => ({ ok: false, state: 'waking', retryAfter: 3 }) });
  await x.ib.accept({ id: 'cid-00000005', op: 'send', args: ARGS });
  x.clock.now = T0 + 10000; x.storage.log.length = 0; x.storage.alarmSets.length = 0;
  await x.ib.alarm();
  assert.strictEqual(x.storage.log[0], 'setAlarm');
  assert.strictEqual(x.storage.alarmSets[0], T0 + 10000 + 120000);
  assert.ok(x.storage.log.includes('deliver'));
});

test('控制器的长久错误：标成没送到，不再重试', async () => {
  const x = await inbox({ deliver: async () => ({ ok: true, data: { error: 'no_session', msg: '找不到这个对话' } }) });
  const { view } = await x.ib.accept({ id: 'cid-00000006', op: 'send', args: ARGS });
  assert.strictEqual(view.state, 'failed');
  assert.deepStrictEqual(view.result, { error: 'no_session', msg: '找不到这个对话' });
  x.clock.now = T0 + H; await x.ib.alarm();
  assert.strictEqual(x.calls.length, 1);
});

test('临时错误按退避：5、15、30、60 秒', async () => {
  const x = await inbox({ deliver: async () => ({ ok: true, data: { error: 'busy', msg: '上一句还没做完' } }) });
  await x.ib.accept({ id: 'cid-00000007', op: 'send', args: ARGS });
  const gaps = [];
  for (let i = 0; i < 4; i++) {
    const row = await x.storage.get('inbox:row:cid-00000007');
    gaps.push((row.nextAt - x.clock.now) / 1000);
    x.clock.now = row.nextAt; await x.ib.alarm();
  }
  assert.deepStrictEqual(gaps, [5, 15, 30, 60]);
  assert.strictEqual((await x.ib.view('cid-00000007')).state, 'pending');
});

test('主人暂时不在（控制器转交不过去）：当作临时错误按退避重送，不标成没送到', async () => {
  let n = 0;
  const x = await inbox({ deliver: async () => ++n === 1 ? { ok: true, data: { error: 'owner_unavailable', msg: '小芯的状态进程暂时不可用，请稍后重试', executed: false } } : { ok: true, data: { sid: 's1', run: 'r9' } } });
  const { view } = await x.ib.accept({ id: 'cid-owner-0001', op: 'send', args: ARGS });
  assert.strictEqual(view.state, 'pending');
  const row = await x.storage.get('inbox:row:cid-owner-0001');
  assert.deepStrictEqual([(row.nextAt - x.clock.now) / 1000, row.wait.state, row.wait.scope], [5, 'busy', 'lane']);
  x.clock.now = row.nextAt; await x.ib.alarm();
  assert.strictEqual((await x.ib.view('cid-owner-0001')).state, 'delivered');
});

test('24 小时还没送到：标成没送到，写明原因，不悄悄丢', async () => {
  const x = await inbox({ deliver: async () => ({ ok: false, state: 'cooldown', retryAfter: 7200 }) });
  await x.ib.accept({ id: 'cid-00000008', op: 'send', args: ARGS });
  x.clock.now = T0 + DAY + 1000; await x.ib.alarm();
  const v = await x.ib.view('cid-00000008');
  assert.strictEqual(v.state, 'failed');
  assert.strictEqual(v.error.code, 'gave_up');
  assert.match(v.error.msg, /24 小时/);
});

test('冷却超过 24 小时也按放弃期限设闹钟，不一直等冷却结束', async () => {
  const x = await inbox({ deliver: async () => ({ ok: false, state: 'cooldown', retryAfter: 48 * 3600 }) });
  await x.ib.accept({ id: 'cid-deadline-001', op: 'send', args: ARGS });
  assert.strictEqual(x.storage.alarm, T0 + DAY + 1);
  x.clock.now = x.storage.alarm;
  await x.ib.alarm();
  assert.strictEqual((await x.ib.view('cid-deadline-001')).error.code, 'gave_up');
});

test('按先来后到：前面那句因为叫不醒卡住，这一轮就不送后面的', async () => {
  const x = await inbox({ deliver: async () => ({ ok: false, state: 'waking', retryAfter: 3 }) });
  await x.ib.accept({ id: 'cid-0000000a', op: 'send', args: ARGS });
  await x.ib.accept({ id: 'cid-0000000b', op: 'send', args: { text: '第二句' } });
  x.calls.length = 0; x.clock.now = T0 + 60000;
  await x.ib.alarm();
  assert.deepStrictEqual(x.calls.map(r => r.id), ['cid-0000000a']);
});

test('新消息、重发、闹钟都不能越过冷却中的队首；队首送达后才顺序放行', async () => {
  let ready = false;
  const x = await inbox({ deliver: async row => !ready && row.id === 'cid-fifo-0001'
    ? { ok: false, state: 'cooldown', retryAfter: 3600 } : { ok: true, data: { run: row.id } } });
  const first = { id: 'cid-fifo-0001', op: 'send', args: ARGS };
  const second = { id: 'cid-fifo-0002', op: 'send', args: { ...ARGS, text: '第二句' } };
  await x.ib.accept(first);
  assert.strictEqual((await x.ib.accept(second)).view.state, 'pending');
  assert.strictEqual((await x.ib.accept(second)).view.wait.state, 'cooldown');
  await x.ib.alarm();
  assert.deepStrictEqual(x.calls.map(r => r.id), [first.id]);
  assert.strictEqual(x.storage.alarm, T0 + H, '后面的到期行不导致冷却期间每秒空转');
  assert.strictEqual((await x.ib.list()).rows[1].wait.state, 'cooldown');
  ready = true; x.clock.now += H;
  await x.ib.alarm();
  assert.deepStrictEqual(x.calls.map(r => r.id), [first.id, first.id, second.id]);
  assert.strictEqual((await x.ib.view(second.id)).state, 'delivered');
});

test('并发接收同一个编号只占一行、只投递一次；别的编号有不同序号', async () => {
  let release;
  const x = await inbox({ budgetMs: 1, deliver: () => new Promise(r => { release = r; }) });
  const a = { id: 'cid-race-0001', op: 'send', args: ARGS };
  await Promise.all([x.ib.accept(a), x.ib.accept(a), x.ib.accept({ ...a, id: 'cid-race-0002' })]);
  assert.strictEqual(x.calls.length, 1);
  const rows = await x.ib.rows();
  assert.strictEqual(rows.length, 2);
  assert.notStrictEqual(rows[0].seq, rows[1].seq);
  release({ ok: true, data: { run: 'r1' } });
  for (let i = 0; i < 5; i++) await tick();
});

test('旧租约的迟到回应不能覆盖已经重试的行', async () => {
  const replies = [];
  const x = await inbox({ budgetMs: 1, deliver: () => new Promise(r => replies.push(r)) });
  const a = { id: 'cid-lease-0001', op: 'send', args: ARGS };
  await x.ib.accept(a);
  x.clock.now += 121000;
  await x.ib.accept(a);
  replies[0]({ ok: true, data: { error: 'no_session', msg: '旧回应' } });
  for (let i = 0; i < 5; i++) await tick();
  assert.strictEqual((await x.ib.view(a.id)).state, 'pending');
  replies[1]({ ok: true, data: { run: 'rnew' } });
  for (let i = 0; i < 5; i++) await tick();
  assert.strictEqual((await x.ib.view(a.id)).result.run, 'rnew');
});

// ── 按对话分道（docs/superpowers/specs/2026-11-14-xin-kernel-stage2-design.md §2.2）──
// 「这个对话在忙」只挡这一道；「电脑叫不醒、在冷却、连不上」才挡所有道。
const A = { text: '给 A', sid: 'sA' }, B = { text: '给 B', sid: 'sB' };
const BUSY = { ok: true, data: { error: 'busy', msg: '上一句还没做完，请稍后再试' } };

test('一个对话在忙：发给别的对话的照样马上送到', async () => {
  const x = await inbox({ deliver: async row => row.args.sid === 'sA' ? BUSY : { ok: true, data: { run: 'rB' } } });
  const a = await x.ib.accept({ id: 'cid-lane-a001', op: 'send', args: A });
  const b = await x.ib.accept({ id: 'cid-lane-b001', op: 'send', args: B });
  assert.deepStrictEqual([a.view.state, a.view.wait.state, a.view.wait.scope], ['pending', 'busy', 'lane']);
  assert.strictEqual(b.view.state, 'delivered');
  assert.deepStrictEqual(x.calls.map(r => r.id), ['cid-lane-a001', 'cid-lane-b001']);
});

test('闹钟那一轮：一个对话的队首还在忙，别的对话到期的照送', async () => {
  let awake = false;
  const x = await inbox({ deliver: async row => !awake ? { ok: false, state: 'waking', retryAfter: 3 } : row.args.sid === 'sA' ? BUSY : { ok: true, data: { run: 'rB' } } });
  await x.ib.accept({ id: 'cid-lane-a002', op: 'send', args: A });
  await x.ib.accept({ id: 'cid-lane-b002', op: 'send', args: B });
  awake = true; x.clock.now = T0 + 3000;
  await x.ib.alarm();
  assert.strictEqual((await x.ib.view('cid-lane-b002')).state, 'delivered');
  assert.strictEqual((await x.ib.view('cid-lane-a002')).wait.state, 'busy');
  assert.strictEqual(x.storage.alarm, T0 + 3000 + 5000, '闹钟定在 A 那一道下次重试的时候');
});

test('连发两个新对话，第一个临时失败：第二个照样送到', async () => {
  const x = await inbox({ deliver: async row => row.args.text === '第一个' ? { ok: true, data: { error: 'internal', msg: '出错了' } } : { ok: true, data: { run: 'r2' } } });
  await x.ib.accept({ id: 'cid-new-00001', op: 'send', args: { text: '第一个' } });
  assert.strictEqual((await x.ib.accept({ id: 'cid-new-00002', op: 'send', args: { text: '第二个' } })).view.state, 'delivered');
});

test('一道在长退避、另一道几秒后到期：闹钟定在最早的那一道', async () => {
  const x = await inbox({ deliver: async row => row.args.sid === 'sA' ? BUSY : { ok: true, data: { error: 'internal', msg: '出错了' } } });
  await x.ib.accept({ id: 'cid-lane-a003', op: 'send', args: A });
  for (const at of [5, 20, 50, 110, 230, 530]) { x.clock.now = T0 + at * 1000; await x.ib.alarm(); }   // A 退避到 10 分钟一次
  const t = x.clock.now;
  await x.ib.accept({ id: 'cid-lane-b003', op: 'send', args: B });
  assert.strictEqual(x.storage.alarm, t + 5000);
});

test('一句话因为不明原因一直送不进去：只挡它自己那个对话，别的对话照送', async () => {
  const x = await inbox({ deliver: async row => row.args.sid === 'sA' ? { ok: false, state: 'error', msg: '控制器出错了' } : { ok: true, data: { run: 'rB' } } });
  const a = await x.ib.accept({ id: 'cid-poison-a01', op: 'send', args: A });
  assert.deepStrictEqual([a.view.state, a.view.wait.state, a.view.wait.scope], ['pending', 'retrying', 'lane']);
  assert.strictEqual((await x.ib.accept({ id: 'cid-poison-b01', op: 'send', args: B })).view.state, 'delivered');
  x.clock.now = T0 + 5000; await x.ib.alarm();
  await x.ib.accept({ id: 'cid-poison-b02', op: 'send', args: { ...B, text: '第二句' } });
  assert.deepStrictEqual(x.calls.map(r => r.id), ['cid-poison-a01', 'cid-poison-b01', 'cid-poison-a01', 'cid-poison-b02']);
});

test('InstaBox 忙（限流）算电脑整体不可用：别的对话先不去撞', async () => {
  const x = await inbox({ deliver: async () => ({ ok: false, state: 'busy', msg: 'InstaBox 忙，稍等', retryAfter: 5 }) });
  const a = await x.ib.accept({ id: 'cid-limit-a01', op: 'send', args: A });
  assert.strictEqual(a.view.wait.scope, 'machine');
  assert.strictEqual((await x.ib.accept({ id: 'cid-limit-b01', op: 'send', args: B })).view.state, 'pending');
  assert.deepStrictEqual(x.calls.map(r => r.id), ['cid-limit-a01']);
});

test('laneOf：有编号按编号，主对话的第一句一道，其余新对话各自一道；编号不是字符串也不抛错', async () => {
  const { laneOf } = await load('../src/xin-inbox.js');
  assert.strictEqual(laneOf({ id: 'i1', args: { sid: 'sA' } }), 'c:sA');
  assert.strictEqual(laneOf({ id: 'i1', args: { main: true } }), 'main');
  assert.strictEqual(laneOf({ id: 'i1', args: { sid: 'sA', main: true } }), 'c:sA');
  assert.strictEqual(laneOf({ id: 'i1', args: {} }), 'n:i1');
  for (const sid of [42, {}, '', null]) assert.strictEqual(laneOf({ id: 'i2', args: { sid } }), 'n:i2');
  assert.strictEqual(laneOf({ id: 'i3' }), 'n:i3');
});

test('同一个对话里：前面那句还在路上，后面那句不越过去，显示「前面那句还没送到」', async () => {
  let release;
  const x = await inbox({ budgetMs: 1, deliver: () => new Promise(r => { release = r; }) });
  await x.ib.accept({ id: 'cid-same-0001', op: 'send', args: A });
  const second = await x.ib.accept({ id: 'cid-same-0002', op: 'send', args: { ...A, text: '第二句' } });
  assert.deepStrictEqual([second.view.state, second.view.wait.state, second.view.wait.msg], ['pending', 'retrying', '前面那句还没送到']);
  assert.strictEqual(x.calls.length, 1);
  release({ ok: true, data: { run: 'r1' } });
  for (let i = 0; i < 5; i++) await tick();
});

test('电脑在冷却：别的对话的新消息也不去试，显示冷却，闹钟定在冷却结束；结束后按先后都送到', async () => {
  let ready = false;
  const x = await inbox({ deliver: async () => ready ? { ok: true, data: { run: 'r' } } : { ok: false, state: 'cooldown', retryAfter: 3600 } });
  await x.ib.accept({ id: 'cid-cool-a001', op: 'send', args: A });
  const b = await x.ib.accept({ id: 'cid-cool-b001', op: 'send', args: B });
  assert.deepStrictEqual([b.view.state, b.view.wait.state], ['pending', 'cooldown']);
  assert.deepStrictEqual(x.calls.map(r => r.id), ['cid-cool-a001']);
  assert.strictEqual(x.storage.alarm, T0 + H);
  ready = true; x.clock.now = T0 + H;
  await x.ib.alarm();
  assert.deepStrictEqual(x.calls.map(r => r.id), ['cid-cool-a001', 'cid-cool-a001', 'cid-cool-b001']);
  assert.strictEqual((await x.ib.view('cid-cool-b001')).state, 'delivered');
});

test('叫不醒：这一轮只试最前面那一句，不挨个对话去撞', async () => {
  const x = await inbox({ deliver: async () => ({ ok: false, state: 'waking', retryAfter: 3 }) });
  await x.ib.accept({ id: 'cid-wake-a001', op: 'send', args: A });
  await x.ib.accept({ id: 'cid-wake-b001', op: 'send', args: B });
  x.clock.now = T0 + 3000; await x.ib.alarm();
  assert.deepStrictEqual(x.calls.map(r => r.id), ['cid-wake-a001', 'cid-wake-a001']);
});

test('上线前存着的旧行（wait 里没有 scope）：冷却、叫醒中的照样挡住所有对话；别的只挡自己那个对话；下一次重试后带上 scope', async () => {
  const oldRow = (id, args, wait, nextAt) => ({ id, op: 'send', args, digest: 'd', seq: 1, state: 'pending', attempts: 1, backoff: 1, nextAt, leaseUntil: 0, createdAt: T0 - 1000,
    firstAttemptAt: T0 - 1000, deliveredAt: 0, finishedAt: 0, result: null, wait, error: null, acked: false, woke: false });
  const seed = async (x, row) => { await x.storage.put('inbox:meta', { v: 1 }); await x.storage.put('inbox:seq', 1); await x.storage.put('inbox:row:' + row.id, row); };
  const busy = await inbox({ deliver: async row => row.args.sid === 'sA' ? BUSY : { ok: true, data: { run: 'rB' } } });
  await seed(busy, oldRow('cid-old-00001', A, { state: 'busy', until: T0 + 5000, msg: '上一句还没做完' }, T0 + 5000));
  assert.strictEqual((await busy.ib.accept({ id: 'cid-old-b0001', op: 'send', args: B })).view.state, 'delivered');
  busy.clock.now = T0 + 5000; await busy.ib.alarm();
  assert.strictEqual((await busy.storage.get('inbox:row:cid-old-00001')).wait.scope, 'lane');
  const cold = await inbox({ deliver: async () => ({ ok: true, data: { run: 'r' } }) });
  await seed(cold, oldRow('cid-old-00002', A, { state: 'cooldown', until: T0 + H, msg: '云电脑在冷却' }, T0 + H));
  const b = await cold.ib.accept({ id: 'cid-old-b0002', op: 'send', args: B });
  assert.deepStrictEqual([b.view.state, b.view.wait.state, cold.calls.length], ['pending', 'cooldown', 0]);
  cold.clock.now = T0 + H; await cold.ib.alarm();
  assert.deepStrictEqual(cold.calls.map(r => r.id), ['cid-old-00002', 'cid-old-b0002']);
});

test('一道的队首 24 小时放弃：同一道的下一句在同一轮接着送', async () => {
  let ok = false;
  const x = await inbox({ deliver: async () => ok ? { ok: true, data: { run: 'r' } } : BUSY });
  await x.ib.accept({ id: 'cid-give-0001', op: 'send', args: A });
  x.clock.now = T0 + DAY - 1000;
  await x.ib.accept({ id: 'cid-give-0002', op: 'send', args: { ...A, text: '第二句' } });
  ok = true; x.clock.now = T0 + DAY + 1;
  await x.ib.alarm();
  assert.strictEqual((await x.ib.view('cid-give-0001')).error.code, 'gave_up');
  assert.strictEqual((await x.ib.view('cid-give-0002')).state, 'delivered');
});

test('送达和确认同时发生：确认标记不丢', async () => {
  let release;
  const x = await inbox({ deliver: () => new Promise(r => { release = r; }) });
  await x.ib.accept({ id: 'cid-0000000c', op: 'send', args: ARGS });
  await x.ib.ack('cid-0000000c');
  release({ ok: true, data: { sid: 's1', run: 'r2' } });
  for (let i = 0; i < 5; i++) await tick();
  const row = await x.storage.get('inbox:row:cid-0000000c');
  assert.deepStrictEqual([row.state, row.acked], ['delivered', true]);
});

test('列表：没送完的、后来才失败的、刚送到还没确认的；读到终态（送到、失败）就算确认', async () => {
  let awake = false;
  const x = await inbox({ deliver: async row => row.args.text === '醒来后失败' ? (awake ? { ok: true, data: { error: 'no_session', msg: '找不到这个对话' } } : { ok: false, state: 'waking' })
    : row.args.text === '在睡' ? { ok: false, state: 'cooldown', retryAfter: 3600 } : { ok: true, data: { run: 'r1' } } });
  await x.ib.accept({ id: 'cid-0000000f', op: 'send', args: { text: '送到了' } });
  await x.ib.accept({ id: 'cid-0000000e', op: 'send', args: { text: '醒来后失败' } });
  await x.ib.accept({ id: 'cid-0000000d', op: 'send', args: { text: '在睡' } });
  awake = true; x.clock.now = T0 + 5000; await x.ib.alarm();   // 没有网页在等的时候才失败
  assert.deepStrictEqual((await x.ib.list()).rows.map(r => [r.id, r.state]), [['cid-0000000f', 'delivered'], ['cid-0000000e', 'failed'], ['cid-0000000d', 'pending']]);
  await x.ib.view('cid-0000000f');
  assert.deepStrictEqual((await x.ib.list()).rows.map(r => r.id), ['cid-0000000e', 'cid-0000000d']);
  assert.strictEqual((await x.ib.view('cid-0000000e')).error.code, 'no_session');   // 网页读到了「没送到」
  assert.deepStrictEqual((await x.ib.list()).rows.map(r => r.id), ['cid-0000000d'], '读到过的失败不再列出来');
});

test('当场就失败（控制器回了错误）：已经当面告诉发送方，不留在列表里等下次再报一遍', async () => {
  const x = await inbox({ deliver: async () => ({ ok: true, data: { error: 'too_long', msg: '消息太长了' } }) });
  const { view } = await x.ib.accept({ id: 'cid-00000020', op: 'send', args: ARGS });
  assert.deepStrictEqual([view.state, view.error.code], ['failed', 'too_long']);
  assert.deepStrictEqual((await x.ib.list()).rows, []);
});

test('一直叫不醒：前 20 次几秒一试，之后按退避放慢（5 秒、15 秒……）', async () => {
  const x = await inbox({ deliver: async () => ({ ok: false, state: 'waking', retryAfter: 3 }) });
  await x.ib.accept({ id: 'cid-00000021', op: 'send', args: ARGS });
  const row = () => x.storage.get('inbox:row:cid-00000021');
  for (let i = 0; i < 19; i++) { x.clock.now = (await row()).nextAt; await x.ib.alarm(); }
  assert.strictEqual((await row()).attempts, 20);
  assert.strictEqual((await row()).nextAt - x.clock.now, 3000);
  x.clock.now = (await row()).nextAt; await x.ib.alarm();
  assert.strictEqual((await row()).attempts, 21);
  assert.strictEqual((await row()).nextAt - x.clock.now, 5000);
  assert.strictEqual((await row()).wait.state, 'waking');
  x.clock.now = (await row()).nextAt; await x.ib.alarm();
  assert.strictEqual((await row()).nextAt - x.clock.now, 15000);
});

test('踢一下：退避中的那句提前到现在重试；冷却中的不动（冷却没结束叫不醒）', async () => {
  const x = await inbox({ deliver: async row => row.args.text === '冷却' ? { ok: false, state: 'cooldown', retryAfter: 3600 } : { ok: false, state: 'error', msg: '连不上' } });
  const cold = await inbox({ deliver: async () => ({ ok: false, state: 'cooldown', retryAfter: 3600 }) });
  await x.ib.accept({ id: 'cid-00000022', op: 'send', args: { text: '重试' } });
  await cold.ib.accept({ id: 'cid-00000023', op: 'send', args: { text: '冷却' } });
  assert.strictEqual((await x.storage.get('inbox:row:cid-00000022')).nextAt, T0 + 5000);
  x.clock.now = T0 + 1000;
  cold.clock.now = x.clock.now;
  await x.ib.kick(); await cold.ib.kick();
  assert.strictEqual((await x.storage.get('inbox:row:cid-00000022')).nextAt, T0 + 1000);
  assert.strictEqual((await cold.storage.get('inbox:row:cid-00000023')).nextAt, T0 + 3600e3);
  assert.strictEqual(x.storage.alarm, T0 + 2000);
});

test('先写「这里是待送达」的标记，再写这一行：有行就一定有标记，闹钟认得出来', async () => {
  const x = await inbox(), order = [], put = x.storage.put;
  x.storage.put = async (k, v) => { order.push(k); return put(k, v); };
  await x.ib.accept({ id: 'cid-00000024', op: 'send', args: ARGS });
  const meta = order.indexOf('inbox:meta'), row = order.indexOf('inbox:row:cid-00000024');
  assert.ok(meta >= 0 && meta < row, order.join(' → '));
});

test('清理：终态超过 7 天的删掉，还没送完的不删', async () => {
  const x = await inbox({ deliver: async row => row.args.text === '在睡' ? { ok: false, state: 'cooldown', retryAfter: 600 } : { ok: true, data: { run: 'r1' } } });
  await x.ib.accept({ id: 'cid-00000010', op: 'send', args: { text: '送到了' } });
  x.clock.now = T0 + 8 * DAY - 1000;
  await x.ib.accept({ id: 'cid-00000011', op: 'send', args: { text: '在睡' } });
  x.clock.now = T0 + 8 * DAY; await x.ib.alarm();
  assert.strictEqual(await x.storage.get('inbox:row:cid-00000010'), undefined);
  assert.ok(await x.storage.get('inbox:row:cid-00000011'));
});

test('踢一下：有没送完的就把闹钟提前到 1 秒后；都送完了就不定闹钟', async () => {
  const x = await inbox({ deliver: async () => ({ ok: false, state: 'cooldown', retryAfter: 3600 }) });
  await x.ib.accept({ id: 'cid-00000012', op: 'send', args: ARGS });
  await x.ib.kick();
  assert.strictEqual(x.storage.alarm, T0 + 1000);
  const y = await inbox();
  await y.ib.accept({ id: 'cid-00000013', op: 'send', args: ARGS });
  await y.storage.deleteAlarm(); await y.ib.kick();
  assert.strictEqual(y.storage.alarm, null);
});

test('叫醒统计：送达用了 40.7 秒', async () => {
  const x = await inbox({ budgetMs: 0 });
  x.setDeliver(async () => { x.clock.now += 40700; return { ok: true, data: { run: 'r1' } }; });
  await x.ib.accept({ id: 'cid-00000014', op: 'send', args: ARGS });
  assert.deepStrictEqual(await x.ib.stats(), { count: 1, p50: 40700, max: 40700, over45: 0 });
});

test('Durable Object：/inbox/* 交给待送达，闹钟也交给它；存不上回 500', async () => {
  const { XinTaskSupervisor } = await load('../src/xin.js');
  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { code: 'busy' } }), { status: 503 });   // InstaBox 一直忙
  try {
    const storage = memStorage();
    const o = new XinTaskSupervisor({ storage, waitUntil() {} }, { OWNER_PASSWORD: 'correct horse battery', INSTABOX_API_KEY: 'ibk_test_key_1234567890', XIN_MACHINE: 'li' });
    const post = (p, body) => o.fetch(new Request('https://xin.internal' + p, { method: 'POST', body: JSON.stringify(body) }));
    const r = await post('/inbox/accept', { id: 'cid-00000099', op: 'send', args: { text: '你好' } });
    assert.strictEqual(r.status, 200);
    const { view } = await r.json();
    assert.deepStrictEqual([view.state, view.wait.state], ['pending', 'busy']);
    assert.strictEqual((await (await post('/inbox/view', { id: 'cid-00000099' })).json()).view.id, 'cid-00000099');
    assert.strictEqual((await (await post('/inbox/list', {})).json()).rows.length, 1);
    storage.alarm = null; storage.alarmSets.length = 0;
    await o.alarm();
    assert.ok(storage.alarmSets.length >= 1, '闹钟交给了待送达');
    assert.strictEqual(storage.values.get('tasks'), undefined, '没去碰任务租约那一套');
    storage.putFails = true;
    const bad = await post('/inbox/accept', { id: 'cid-00000100', op: 'send', args: { text: '存不上' } });
    assert.strictEqual(bad.status, 500);
    assert.deepStrictEqual(await bad.json(), { error: 'store_failed' });
    const badId = await post('/inbox/accept', { id: 'x', op: 'send', args: {} });   // 编号不合法：碰存储之前就拒
    assert.deepStrictEqual([badId.status, await badId.json()], [400, { error: 'bad_id' }]);
  } finally { globalThis.fetch = real; }
});
