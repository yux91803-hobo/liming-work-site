// 平板 liming-cloud 阶段 3：选机器规则（设计 §5.3）和 InstaBox 只读状态（不唤醒机器）。
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const lib = file => import(pathToFileURL(path.join(__dirname, '../site/tablet/liming-cloud/lib', file)).href);

const NOW = Date.parse('2026-11-26T06:00:00Z');   // 北京时间 14:00
const awake = (remainingMin = 200) => ({ known: true, awake: true, cooldownUntil: null, remainingMin });
const asleep = () => ({ known: true, awake: false, cooldownUntil: null, remainingMin: null });
const cooling = (untilIso) => ({ known: true, awake: false, cooldownUntil: Date.parse(untilIso), remainingMin: null });
const unknown = () => ({ known: false, reason: '没有只读 key' });
const two = (li, li2) => [{ name: 'li', status: li }, { name: 'li2', status: li2 }];
const task = (o) => ({ taskId: 't_' + Math.random().toString(36).slice(2, 8), status: 'running', createdAt: NOW - 3600e3, updatedAt: NOW - 3600e3, project: 'p', ...o });

test('正在冷却的排除；两台都冷却时不派，给出最早能用的北京时间', async () => {
  const { chooseMachine } = await lib('selector.js');
  const one = chooseMachine({ machines: two(cooling('2026-11-26T06:20:00Z'), asleep()), now: NOW });
  assert.equal(one.ok, true);
  assert.equal(one.machine, 'li2');
  assert.match(one.reason, /li 在冷却（到 14:20）/);
  const none = chooseMachine({ machines: two(cooling('2026-11-26T06:20:00Z'), cooling('2026-11-26T06:05:00Z')), now: NOW });
  assert.equal(none.ok, false);
  assert.match(none.reason, /都在冷却/);
  assert.match(none.reason, /14:05/);
  assert.equal(none.earliestAt, Date.parse('2026-11-26T06:05:00Z'));
  // 早就过期的冷却时间（InstaBox 会留着旧值）不算冷却
  assert.equal(chooseMachine({ machines: two(cooling('2026-11-21T11:05:34Z'), asleep()), task: 'stm32 blink', now: NOW }).machine, 'li');
});

test('本轮剩余不到 45 分钟的靠后；只剩它能用时照派并带上冻结提醒', async () => {
  const { chooseMachine } = await lib('selector.js');
  const r = chooseMachine({ machines: two(awake(30), asleep()), now: NOW });
  assert.equal(r.machine, 'li2', '有别的选择就用别的，哪怕要唤醒');
  assert.equal(r.warning, undefined);
  const only = chooseMachine({ machines: two(awake(30), cooling('2026-11-26T07:00:00Z')), now: NOW });
  assert.equal(only.ok, true);
  assert.equal(only.machine, 'li');
  assert.match(only.warning, /li 大约 30 分钟后会暂停，到时任务冻结，冷却结束后接着跑/);
});

test('接着做原来的任务回原来那台，同名项目也回原来那台，STM32 去 li', async () => {
  const { chooseMachine } = await lib('selector.js');
  const old = task({ taskId: 't_old1', machine: 'li', project: 'blinky', status: 'completed' });
  const cont = chooseMachine({ machines: two(asleep(), awake()), tasks: [old], continueOf: 't_old1', now: NOW });
  assert.equal(cont.machine, 'li');
  assert.match(cont.reason, /接着 t_old1/);
  assert.equal(chooseMachine({ machines: two(asleep(), awake()), tasks: [old], project: 'blinky', now: NOW }).machine, 'li');
  const stm = chooseMachine({ machines: two(asleep(), awake()), task: '给 STM32F103 写个串口回显，用 arm-none-eabi-gcc 编译', now: NOW });
  assert.equal(stm.machine, 'li');
  assert.match(stm.reason, /STM32/);
  // li 冷却时 STM32 任务退到 li2，并说明那台没有 STM32 工具链
  const fallback = chooseMachine({ machines: two(cooling('2026-11-26T06:30:00Z'), awake()), task: 'stm32 点灯', now: NOW });
  assert.equal(fallback.machine, 'li2');
  assert.match(fallback.warning, /li2 没有 STM32 工具链/);
  // 要接着做的那台在冷却：对话在那台上，换不了机器，不派
  const blocked = chooseMachine({ machines: two(cooling('2026-11-26T06:30:00Z'), awake()), tasks: [old], continueOf: 't_old1', now: NOW });
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason, /li 在冷却（到 14:30）/);
  assert.equal(chooseMachine({ machines: two(asleep(), awake()), tasks: [], continueOf: 't_nope', now: NOW }).ok, false);
});

test('醒着的优先于睡着的', async () => {
  const { chooseMachine } = await lib('selector.js');
  const r = chooseMachine({ machines: two(asleep(), awake()), now: NOW });
  assert.equal(r.machine, 'li2');
  assert.match(r.reason, /醒着/);
});

test('都醒着时闲的优先：先比平板任务数，再比最久没用', async () => {
  const { chooseMachine } = await lib('selector.js');
  const busy = [task({ machine: 'li2' })];
  assert.equal(chooseMachine({ machines: two(awake(), awake()), tasks: busy, now: NOW }).machine, 'li');
  const history = [task({ machine: 'li', status: 'completed', updatedAt: NOW - 60e3 }), task({ machine: 'li2', status: 'completed', updatedAt: NOW - 7200e3 })];
  const r = chooseMachine({ machines: two(awake(), awake()), tasks: history, now: NOW });
  assert.equal(r.machine, 'li2', '最久没用的那台');
});

test('每台同时跑的平板任务上限默认 2、可以改；两台都满时不派并说明现状', async () => {
  const { chooseMachine, DEFAULT_MAX_PER_MACHINE } = await lib('selector.js');
  assert.equal(DEFAULT_MAX_PER_MACHINE, 2);
  const tasks = [task({ machine: 'li2' }), task({ machine: 'li2', status: 'stopping' })];
  assert.equal(chooseMachine({ machines: two(asleep(), awake()), tasks, now: NOW }).machine, 'li', 'li2 满了先用另一台');
  assert.equal(chooseMachine({ machines: two(asleep(), awake()), tasks, maxPerMachine: 3, now: NOW }).machine, 'li2', '上限改成 3');
  const full = chooseMachine({ machines: two(awake(), awake()), tasks: [...tasks, task({ machine: 'li' }), task({ machine: 'li', status: 'dispatching' })], now: NOW });
  assert.equal(full.ok, false);
  assert.match(full.reason, /li 已有 2 个平板任务/);
  assert.match(full.reason, /li2 已有 2 个平板任务/);
  // 点名的机器满了也不派
  assert.equal(chooseMachine({ machines: two(asleep(), awake()), tasks, machine: 'li2', now: NOW }).ok, false);
});

test('点名机器：没配置的不派，冷却中的不派，其余照派', async () => {
  const { chooseMachine } = await lib('selector.js');
  assert.equal(chooseMachine({ machines: two(asleep(), awake()), machine: 'li', now: NOW }).machine, 'li');
  assert.equal(chooseMachine({ machines: two(asleep(), awake()), machine: 'li3', now: NOW }).ok, false);
  assert.equal(chooseMachine({ machines: two(cooling('2026-11-26T06:30:00Z'), awake()), machine: 'li', now: NOW }).ok, false);
});

test('某台状态未知时退回精简版判断，并标「状态未知」', async () => {
  const { chooseMachine } = await lib('selector.js');
  const r = chooseMachine({ machines: two(unknown(), asleep()), tasks: [task({ machine: 'li2', status: 'completed', updatedAt: NOW - 60e3 })], now: NOW });
  assert.equal(r.machine, 'li', '不知道醒没醒，按最久没用挑');
  assert.match(r.reason, /li 状态未知/);
  assert.equal(chooseMachine({ machines: two(unknown(), awake()), now: NOW }).machine, 'li2', '确定醒着的胜过不知道的');
  assert.equal(chooseMachine({ machines: [{ name: 'li', status: unknown() }], now: NOW }).ok, true, '只有一台且状态未知也照派');
  assert.equal(chooseMachine({ machines: [], now: NOW }).ok, false);
});

// ---- InstaBox 只读状态 ----

function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET', headers: init.headers || {} });
    const { status = 200, body } = await handler(String(url), init);
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  fn.calls = calls;
  return fn;
}
const machine = (o) => ({ id: 'm_1', name: 'li2', state: 'running', runStartedAt: '2026-11-26T05:00:00Z', maxRunMinutes: 120, cooldownUntil: null, autoSuspendedAt: null, ...o });

test('只读状态：只调 GET /v1/machines，算出醒没醒、本轮还剩几分钟、冷却到几点', async () => {
  const { readMachine } = await lib('instabox-read.js');
  const f = fakeFetch(() => ({ body: { machines: [machine()], nextCursor: null } }));
  const r = await readMachine({ readKey: 'ibk_readonly_TESTKEY123', fetchImpl: f, now: NOW });
  assert.deepEqual({ known: r.known, awake: r.awake, remainingMin: r.remainingMin, cooldownUntil: r.cooldownUntil, name: r.name }, { known: true, awake: true, remainingMin: 60, cooldownUntil: null, name: 'li2' });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].method, 'GET');
  assert.equal(f.calls[0].url, 'https://api.instabox.sh/v1/machines');
  assert.equal(f.calls[0].headers['X-API-Key'], 'ibk_readonly_TESTKEY123');
  const susp = await readMachine({ readKey: 'k_12345678', fetchImpl: fakeFetch(() => ({ body: { machines: [machine({ state: 'suspended', runStartedAt: null, maxRunMinutes: 480, cooldownUntil: '2026-11-21T11:05:34Z' })] } })), now: NOW });
  assert.deepEqual({ awake: susp.awake, remainingMin: susp.remainingMin, cooldownUntil: susp.cooldownUntil }, { awake: false, remainingMin: null, cooldownUntil: null }, '过期的冷却时间不算');
  const cool = await readMachine({ readKey: 'k_12345678', fetchImpl: fakeFetch(() => ({ body: { machines: [machine({ state: 'suspended', cooldownUntil: '2026-11-26T06:20:00Z' })] } })), now: NOW });
  assert.equal(cool.cooldownUntil, Date.parse('2026-11-26T06:20:00Z'));
});

test('只读状态：账号里有几台时按名字找；没有 key、401、断网、找不到都退回「状态未知」，报错里不带 key', async () => {
  const { readMachine } = await lib('instabox-read.js');
  const many = fakeFetch(() => ({ body: { machines: [machine({ id: 'm_a', name: 'other' }), machine({ id: 'm_b', name: 'li' })] } }));
  assert.equal((await readMachine({ readKey: 'k_12345678', name: 'li', fetchImpl: many, now: NOW })).id, 'm_b');
  assert.equal((await readMachine({ readKey: 'k_12345678', fetchImpl: many, now: NOW })).known, false, '多台又没给名字，不猜');
  assert.equal((await readMachine({ readKey: 'k_12345678', name: 'li3', fetchImpl: many, now: NOW })).known, false);
  assert.equal((await readMachine({ readKey: '', fetchImpl: many, now: NOW })).known, false);
  const secret = 'ibk_SECRET_should_not_leak_42';
  for (const handler of [() => ({ status: 401, body: { error: { code: 'invalid_key', message: `bad key ${secret}` } } }), () => { throw new Error(`network down ${secret}`); }, () => ({ body: 'not json' })]) {
    const r = await readMachine({ readKey: secret, fetchImpl: fakeFetch(handler), now: NOW });
    assert.equal(r.known, false);
    assert.ok(!JSON.stringify(r).includes('SECRET_should_not_leak'), JSON.stringify(r));
  }
  assert.match((await readMachine({ readKey: secret, fetchImpl: fakeFetch(() => ({ status: 401, body: { error: { code: 'invalid_key' } } })), now: NOW })).reason, /401/);
});
