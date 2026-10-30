/* 编程思维模块（lab-core.js）：课件代码真的跑一遍，每一行在硬件上造成的变化对得上；自己写的检查能找出常见错误 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const core = require('../site/tools/stm32/study-core.js');
const root = path.join(__dirname, '../site/tools/stm32');
const sb = { window: {} }; sb.window.window = sb.window; vm.createContext(sb);
['assets/registers.js', 'mcusim.js', 'codederive.js', 'lab-core.js'].forEach((f) => vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), sb, { filename: f }));
const L = sb.window.STM32Lab, ch = L.chapter('gpio');
const J = (x) => JSON.parse(JSON.stringify(x));   // vm 里来的数组原型不同，比之前先转一下
const eq = (a, b, m) => assert.deepEqual(J(a), b, m);
const kinds = (ev) => ev.parts.map((p) => p.t).join('+');

test('McuSim：数组常量 static const uint16_t t[] = {…} 能跑，onLine 每行回调一次', () => {
  const S = sb.window.STM32McuSim, lines = [];
  const r = S.run({ fns: { main: { sig: 'int main(void)', lines: [{ c: 'x = t[2];' }] } }, globals: ['static const uint16_t t[] = { 0, 5, 9 };', 'uint32_t x;'] }, { ms: 1, onLine: (f, i) => lines.push(f + i) });
  assert.equal(r.stop.kind === 'error', false, r.stop.text);
  assert.ok(lines.includes('main0'));
  assert.ok(r.machine && r.machine.gpio && r.machine.gpio.A);
});

test('LED_Init：开时钟 → 先写 1 → 配推挽，切成输出时灯是灭的', () => {
  const t = L.trace(ch, ch.chips.find((c) => c.id === 'init'));
  assert.equal(t.err, null);
  eq(t.evs.map(kinds), ['clk', 'w', 'mode', 'mode', 'mode', 'mode']);
  eq(t.evs[1].parts[0].pins, ['PA0', 'PA1', 'PA8']);
  const end = t.states[t.states.length - 1];
  for (const k of ['PA0', 'PA1', 'PA8']) { assert.equal(end.pins[k].mode, 'pp'); assert.equal(end.pins[k].level, 1); }
  assert.ok(t.states.every((s) => ['PA0', 'PA1', 'PA8'].every((k) => s.pins[k].level !== 0)), '中途不能亮');
  t.evs.forEach((e) => assert.ok(ch.hw[e.code], '每一行都有硬件说明：' + e.code));
});

test('LED_On / LED_Off 走 BSRR，LED_Toggle 是读-改-写', () => {
  const on = L.trace(ch, ch.chips.find((c) => c.id === 'on'));
  eq(on.evs.map(kinds), ['cpu', 'w']);
  assert.equal(on.evs[1].parts[0].reg, 'BSRR');
  assert.equal(on.states[2].pins.PA0.level, 0);
  const off = L.trace(ch, ch.chips.find((c) => c.id === 'off'));
  assert.equal(off.states[0].pins.PA0.level, 0); assert.equal(off.states[2].pins.PA0.level, 1);
  const tg = L.trace(ch, ch.chips.find((c) => c.id === 'toggle'));
  assert.equal(tg.evs[1].parts[0].rmw, true);
  eq(tg.evs[1].parts[0].pins, ['PA1']);
});

test('main.c 流水灯：一圈里三个灯轮流亮，延时 500 ms', () => {
  const t = L.trace(ch, ch.chips.find((c) => c.id === 'main'));
  assert.equal(t.err, null);
  eq(t.evs[0].parts.map((p) => p.t), ['clk', 'w', 'mode']);
  const lit = t.evs.map((e, i) => e.code === 'LED_On(n);' ? ['PA0', 'PA1', 'PA8'].filter((k) => t.states[i + 1].pins[k].level === 0) : null).filter(Boolean);
  eq(lit, [['PA0'], ['PA1'], ['PA8']]);
  assert.ok(t.evs.filter((e) => e.parts[0].t === 'delay').every((e) => e.parts[0].ms === 500));
});

test('硬件那一步的五行：配成输出那一下灯亮、写 1 灭、写 0 亮', () => {
  const t = L.trace(ch, { fn: 'main', main: ch.tour.map((x) => x[0]) });
  assert.equal(t.evs.length, 5);
  eq(t.states.slice(1).map((s) => s.pins.PA0.level), ['z', 'z', 0, 1, 0]);
});

test('自己写 LED_Init：课件写法全对，常见错误都能指出来', () => {
  assert.equal(L.checkInit(ch, L.body(ch, 'LED_Init'))[0].k, 'ok');
  const ids = (src) => L.checkInit(ch, src).map((r) => r.id);
  eq(ids('LED_PORT->CRL &= ~(GPIO_CRL_CNF0 | GPIO_CRL_MODE0);'), ['clk']);
  assert.ok(ids('RCC->APB2ENR |= RCC_APB2ENR_IOPAEN;\nLED_PORT->CRL = GPIO_CRL_MODE0 | GPIO_CRL_MODE1;\nLED_PORT->CRH &= ~(GPIO_CRH_CNF8 | GPIO_CRH_MODE8);\nLED_PORT->CRH |= GPIO_CRH_MODE8;\nLED_PORT->BSRR = GPIO_BSRR_BS0 | GPIO_BSRR_BS1 | GPIO_BSRR_BS8;').includes('others'));
  const noClear = 'RCC->APB2ENR |= RCC_APB2ENR_IOPAEN;\nLED_PORT->BSRR = GPIO_BSRR_BS0 | GPIO_BSRR_BS1 | GPIO_BSRR_BS8;\nLED_PORT->CRL |= (GPIO_CRL_MODE0 | GPIO_CRL_MODE1);\nLED_PORT->CRH |= (GPIO_CRH_MODE8);';
  eq(ids(noClear), ['mode']);
  const body = L.body(ch, 'LED_Init').split('\n'), late = [body[0]].concat(body.slice(2), [body[1]]).join('\n');
  eq(ids(late), ['flash']);
  eq(ids([body[0]].concat(body.slice(2)).join('\n')), ['lit']);
  eq(ids('RCC->APB2ENR |= ;'), ['syntax']);
  L.checkInit(ch, noClear).forEach((r) => assert.equal(r.hints.length, 3));
});

test('自己写 LED_On / LED_Off：只动一位、编号不对不动', () => {
  assert.equal(L.checkOnOff(ch, L.body(ch, 'LED_On'), L.body(ch, 'LED_Off'))[0].k, 'ok');
  const ids = (a, b) => L.checkOnOff(ch, a, b).map((r) => r.id);
  eq(ids('LED_PORT->BSRR = (uint32_t)led_pin[n] << 16;', 'LED_PORT->BSRR = led_pin[n];'), ['range']);
  assert.ok(ids('LED_PORT->ODR = 0;', L.body(ch, 'LED_Off')).includes('onOthers'));
  assert.ok(ids('LED_PORT->BSRR = led_pin[n];', L.body(ch, 'LED_Off')).includes('on'));
  assert.ok(ids(L.body(ch, 'LED_On'), 'LED_PORT->BSRR = (uint32_t)led_pin[n] << 16;').includes('off'));
});

test('路由：v=lab 带章节、步骤、函数；乱写的值丢掉', () => {
  assert.deepEqual(core.fromParams('v=lab&t=gpio&st=self&fn=onoff'), { v: 'lab', t: 'gpio', st: 'self', fn: 'onoff' });
  assert.deepEqual(core.fromParams('v=lab&t=gpio&st=evil&fn=<x>'), { v: 'lab', t: 'gpio' });
  assert.deepEqual(core.fromParams('v=lab&st=c'), { v: 'lab' });
  assert.equal(core.params({ v: 'lab', t: 'gpio', st: 'c', fn: 'main' }), 'v=lab&t=gpio&st=c&fn=main');
});

test('路由：编程思维的新五步、硬件原理的 hv / fn / ln', () => {
  assert.deepEqual(core.fromParams('v=lab&t=gpio&st=look'), { v: 'lab', t: 'gpio', st: 'look' });
  assert.deepEqual(core.fromParams('v=think&t=gpio&hv=run&fn=mine-init&ln=010'), { v: 'think', t: 'gpio', fn: 'mine-init', hv: 'run', ln: '10' });
  assert.deepEqual(core.fromParams('v=think&t=gpio&hv=x&ln=abc'), { v: 'think', t: 'gpio' });
  assert.deepEqual(core.fromParams('v=home&hv=run&ln=3'), { v: 'home' });
});

test('第一版（单文件 main.c）能跑：开时钟 → 先写 1 → 切推挽 → 亮 → 等 → 灭', () => {
  const t = L.trace(ch, ch.chips.find((c) => c.id === 'single'));
  assert.equal(t.err, null);
  eq(t.evs.map(kinds), ['clk', 'w', 'mode', 'mode', 'cpu', 'w', 'delay', 'w', 'delay']);
  assert.equal(t.states[6].pins.PA0.level, 0);
  assert.equal(t.states[8].pins.PA0.level, 1);
  Object.keys(ch.groups.single).forEach((k) => assert.ok(ch.single[k], '小标题对着有代码的行'));
});

test('一行代码 → 右边的资料：寄存器、字段、执行完的值', () => {
  eq(L.docFor(ch, 'RCC->APB2ENR |= RCC_APB2ENR_IOPAEN;', { apb2: 4 }), { kind: 'reg', id: 'RCC_APB2ENR', f: ['IOPAEN'], val: 4 });
  const crl = L.docFor(ch, 'LED_PORT->CRL |= (GPIO_CRL_MODE0 | GPIO_CRL_MODE1);', { crl: 0x44444433 });
  eq([crl.id, crl.f, crl.val], ['GPIO_CRL', ['MODE0', 'CNF0', 'MODE1', 'CNF1'], 0x44444433]);
  eq(L.docFor(ch, 'GPIOF->CRH |= GPIO_CRH_CNF8_1;').f, ['MODE8', 'CNF8']);
  const b = L.docFor(ch, 'GPIOA->BSRR = GPIO_BSRR_BR0;');
  eq([b.id, b.f, b.val], ['GPIO_BSRR', ['BR0'], 0x10000]);
  eq(L.docFor(ch, 'LED_PORT->BSRR = (uint32_t)led_pin[n] << 16;').f, ['BR0', 'BR1', 'BR8']);
  assert.equal(L.docFor(ch, 'Delay_ms(500);'), null);
  // 每个资料都指向真有的东西
  const figs = fs.readFileSync(path.join(root, 'assets/manual.js'), 'utf8');
  Object.values(ch.docs).forEach((d) => {
    if (d.kind === 'fig') assert.ok(figs.includes('"id": "' + d.fig + '"'), d.fig);
    if (d.kind === 'sch') assert.ok(fs.existsSync(path.join(root, 'assets', d.page + '.svg')), d.page);
  });
  ch.look.forEach((x) => assert.ok(ch.docs[x.doc], x.q));
  ch.transfer.look.forEach((x) => assert.ok(ch.docs[x.doc], x.q));
});

test('换题（按键控制 LED）：参考写法全对；常见错误都能指出来，else 换行也能跑', () => {
  const init = 'RCC->APB2ENR |= RCC_APB2ENR_IOPFEN;\nGPIOF->CRH &= ~(GPIO_CRH_CNF8 | GPIO_CRH_MODE8);\nGPIOF->CRH |= GPIO_CRH_CNF8_1;\nGPIOF->BSRR = GPIO_BSRR_BS8;';
  const loop = 'if ((GPIOF->IDR & GPIO_IDR_IDR8) == 0) LED_On(LED1);\nelse LED_Off(LED1);';
  assert.equal(L.checkKey(ch, init, loop)[0].k, 'ok');
  const ids = (a, b) => L.checkKey(ch, a, b).map((r) => r.id);
  eq(ids(init.replace('IOPFEN', 'IOPAEN'), loop), ['clk']);
  eq(ids(init.replace(/\nGPIOF->BSRR.*$/, ''), loop), ['pulldown']);
  eq(ids(init.replace('GPIO_CRH_CNF8_1', 'GPIO_CRH_CNF8_0').replace(/\nGPIOF->BSRR.*$/, ''), loop), ['float']);
  eq(ids(init, loop.replace('== 0', '!= 0')), ['inverted']);
  eq(ids(init, 'if ((GPIOF->IDR & GPIO_IDR_IDR8) == 0) LED_On(LED1);'), ['follow']);
  eq(ids(init, ''), ['stuck']);
  L.checkKey(ch, init, '').forEach((r) => assert.equal(r.hints.length, 3));
});
