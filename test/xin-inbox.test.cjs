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

test('24 小时还没送到：标成没送到，写明原因，不悄悄丢', async () => {
  const x = await inbox({ deliver: async () => ({ ok: false, state: 'cooldown', retryAfter: 7200 }) });
  await x.ib.accept({ id: 'cid-00000008', op: 'send', args: ARGS });
  x.clock.now = T0 + DAY + 1000; await x.ib.alarm();
  const v = await x.ib.view('cid-00000008');
  assert.strictEqual(v.state, 'failed');
  assert.strictEqual(v.error.code, 'gave_up');
  assert.match(v.error.msg, /24 小时/);
});

test('按先来后到：前面那句因为叫不醒卡住，这一轮就不送后面的', async () => {
  const x = await inbox({ deliver: async () => ({ ok: false, state: 'waking', retryAfter: 3 }) });
  await x.ib.accept({ id: 'cid-0000000a', op: 'send', args: ARGS });
  await x.ib.accept({ id: 'cid-0000000b', op: 'send', args: { text: '第二句' } });
  x.calls.length = 0; x.clock.now = T0 + 60000;
  await x.ib.alarm();
  assert.deepStrictEqual(x.calls.map(r => r.id), ['cid-0000000a']);
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
  await x.ib.accept({ id: 'cid-0000000d', op: 'send', args: { text: '在睡' } });
  await x.ib.accept({ id: 'cid-0000000e', op: 'send', args: { text: '醒来后失败' } });
  await x.ib.accept({ id: 'cid-0000000f', op: 'send', args: { text: '送到了' } });
  awake = true; x.clock.now = T0 + 5000; await x.ib.alarm();   // 没有网页在等的时候才失败
  assert.deepStrictEqual((await x.ib.list()).rows.map(r => [r.id, r.state]), [['cid-0000000d', 'pending'], ['cid-0000000e', 'failed'], ['cid-0000000f', 'delivered']]);
  await x.ib.view('cid-0000000f');
  assert.deepStrictEqual((await x.ib.list()).rows.map(r => r.id), ['cid-0000000d', 'cid-0000000e']);
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
  await x.ib.accept({ id: 'cid-00000022', op: 'send', args: { text: '重试' } });
  await x.ib.accept({ id: 'cid-00000023', op: 'send', args: { text: '冷却' } });
  assert.strictEqual((await x.storage.get('inbox:row:cid-00000022')).nextAt, T0 + 5000);
  x.clock.now = T0 + 1000;
  await x.ib.kick();
  assert.strictEqual((await x.storage.get('inbox:row:cid-00000022')).nextAt, T0 + 1000);
  assert.strictEqual((await x.storage.get('inbox:row:cid-00000023')).nextAt, T0 + 3600e3);
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
