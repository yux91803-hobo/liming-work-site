/* 编程思维 / 硬件原理（lab-core.js）：课件代码真的跑一遍，每一行在硬件上造成的变化对得上；自己写的检查能找出常见错误；
   结构图上标的寄存器和初始化步骤，和课件代码一行一行对得上 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const core = require('../site/tools/stm32/study-core.js');
const root = path.join(__dirname, '../site/tools/stm32');
const sb = { window: {} }; sb.window.window = sb.window; vm.createContext(sb);
['assets/registers.js', 'mcusim.js', 'codederive.js', 'codederive-more.js', 'codederive-extra.js', 'lab-core.js'].forEach((f) => vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), sb, { filename: f }));
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

test('五行代码：配成输出那一下灯亮、写 1 灭、写 0 亮', () => {
  const t = L.trace(ch, { fn: 'main', main: ['RCC->APB2ENR |= RCC_APB2ENR_IOPAEN;', 'GPIOA->CRL &= ~(GPIO_CRL_CNF0 | GPIO_CRL_MODE0);', 'GPIOA->CRL |= GPIO_CRL_MODE0;', 'GPIOA->BSRR = GPIO_BSRR_BS0;', 'GPIOA->BSRR = GPIO_BSRR_BR0;'] });
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

test('路由：编程思维的新五步、硬件原理的 hv / z / fn（旧的 hv=run 归到结构图，ln 不要了）', () => {
  assert.deepEqual(core.fromParams('v=lab&t=gpio&st=look'), { v: 'lab', t: 'gpio', st: 'look' });
  assert.deepEqual(core.fromParams('v=think&t=tim&hv=map&z=tb&fn=tick'), { v: 'think', t: 'tim', fn: 'tick', hv: 'map', z: 'tb' });
  assert.deepEqual(core.fromParams('v=think&t=gpio&hv=run&fn=mine-init&ln=010'), { v: 'think', t: 'gpio', fn: 'mine-init', hv: 'map' });
  assert.deepEqual(core.fromParams('v=think&t=gpio&hv=x&z=<b>'), { v: 'think', t: 'gpio' });
  assert.deepEqual(core.fromParams('v=home&hv=map&z=tb'), { v: 'home' });
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

/* ---------- 定时器一章 ---------- */
const tc = L.chapter('tim');
test('定时器：PWM_Init 逐行 → 开时钟、配引脚、写定时器寄存器；跑起来 PA1 是 1 kHz', () => {
  const t = L.trace(tc, tc.chips.find((c) => c.id === 'pwm'));
  assert.equal(t.err, null);
  eq(t.evs.map(kinds), ['clk', 'clk', 'mode', 'mode', 'treg', 'treg', 'treg', 'treg', 'treg', 'treg', 'treg', 'treg']);
  eq(t.evs.slice(4).map((e) => e.parts[0].reg), ['PSC', 'ARR', 'CCR2', 'CCMR1', 'CCER', 'CR1', 'EGR', 'CR1']);
  const end = t.states[t.states.length - 1];
  assert.equal(end.pins.PA1.mode, 'afpp');
  eq([end.tim[5].PSC, end.tim[5].ARR, end.tim[5].CR1 & 1], [71, 999, 1]);
});
test('定时器：Tick_Init 打开中断；中断函数一行行：读 SR、清 UIF、ms++', () => {
  const t = L.trace(tc, tc.chips.find((c) => c.id === 'tick'));
  eq(t.evs.map(kinds), ['clk', 'treg', 'treg', 'treg', 'treg', 'treg', 'nvic', 'treg']);
  const i = L.trace(tc, tc.chips.find((c) => c.id === 'isr'));
  eq(i.evs.map(kinds), ['tread', 'treg', 'cpu']);
  assert.equal(i.states[0].irqs, 1);
  const s = L.trace(tc, tc.chips.find((c) => c.id === 'single'));
  assert.equal(s.err, null);
  assert.ok(s.evs.some((e) => e.parts[0].t === 'delay'));
});
test('定时器检查：课件写法全对；常见错误都能指出来', () => {
  assert.equal(L.checkPwm(tc, L.body(tc, 'PWM_Init'))[0].k, 'ok');
  assert.equal(L.checkTick(tc, L.body(tc, 'Tick_Init'))[0].k, 'ok');
  const pw = (f) => L.checkPwm(tc, f(L.body(tc, 'PWM_Init'))).map((r) => r.id);
  eq(pw((x) => x.replace('RCC->APB1ENR |= RCC_APB1ENR_TIM5EN;', '')), ['clkT']);
  eq(pw((x) => x.replace('GPIO_CRL_CNF1_1', '0')), ['pin']);
  eq(pw((x) => x.replace(' | TIM_CCER_CC2P', '')), ['pol']);
  eq(pw((x) => x.replace('1000 - 1', '500 - 1')), ['freq']);
  eq(pw((x) => x.replace('TIM5->CR1 |= TIM_CR1_CEN;', '')), ['cen']);
  eq(pw((x) => x.replace('TIM_CCER_CC2E | ', '')), ['cce']);
  const tk = (f) => L.checkTick(tc, f(L.body(tc, 'Tick_Init'))).map((r) => r.id);
  eq(tk((x) => x.replace('TIM6->DIER |= TIM_DIER_UIE;', '')), ['uie']);
  eq(tk((x) => x.replace('NVIC_EnableIRQ(TIM6_IRQn);', '')), ['nvic']);
  eq(tk((x) => x.replace('72 - 1', '36 - 1')), ['rate']);
  const ref = tc.transfer.ref.replace(/^void PWM1_Init\(void\)\n\{\n/, '').replace(/\n\}$/, '');
  assert.equal(L.checkTransferPwm(tc, ref)[0].k, 'ok');
  eq(L.checkTransferPwm(tc, ref.replace('125', '250')).map((r) => r.id), ['duty']);
  L.checkPwm(tc, L.body(tc, 'PWM_Init').replace(' | TIM_CCER_CC2P', '')).forEach((r) => { assert.equal(r.hints.length, 3); assert.ok(tc.docs[r.doc] || L.chapter('gpio').docs[r.doc], r.doc); });
});
test('定时器：资料都指向真有的图、引脚和寄存器；寄存器行能换出资料', () => {
  const figs = fs.readFileSync(path.join(root, 'assets/manual.js'), 'utf8'), pins = fs.readFileSync(path.join(root, 'pins.js'), 'utf8');
  Object.values(tc.docs).forEach((d) => {
    if (d.kind === 'fig') assert.ok(figs.includes('"id": "' + d.fig + '"'), d.fig);
    if (d.kind === 'pin') { assert.ok(pins.includes("'" + d.pin + "'"), d.pin); d.hl.forEach((a) => assert.ok(pins.includes(a), a)); }
  });
  tc.look.concat(tc.transfer.look).forEach((x) => assert.ok(tc.docs[x.doc], x.q));
  eq(L.docFor(tc, 'TIM5->CCER = TIM_CCER_CC2E | TIM_CCER_CC2P;').f, ['CC2E', 'CC2P']);
  eq(L.docFor(tc, 'TIM5->CCMR1 = TIM_CCMR1_OC2M_2 | TIM_CCMR1_OC2M_1 | TIM_CCMR1_OC2PE;').f, ['OC2M', 'OC2PE']);
  eq(L.docFor(tc, 'RCC->APB1ENR |= RCC_APB1ENR_TIM6EN;', { apb1: 16 }), { kind: 'reg', id: 'RCC_APB1ENR', f: ['TIM6EN'], val: 16 });
  assert.equal(L.docFor(tc, 'NVIC_EnableIRQ(TIM6_IRQn);').id, 'NVIC_ISER');
  Object.keys(tc.groups.single).forEach((k) => assert.ok(tc.single[k][0].trim(), '小标题对着有代码的行'));
  assert.equal(L.FRAME.length, tc.frame.length);
});
test('标题不用问句：查资料、任务分解、框架提示都是名词短语', () => {
  [L.chapter('gpio'), tc].forEach((c) => {
    c.ask.concat(c.look, c.transfer.look).forEach((x) => assert.ok(!/[？?]|什么|怎么|哪/.test(x.q), x.q));
    assert.ok(!/[？?]/.test(c.split.q));
  });
  L.FRAME.forEach((x) => assert.ok(!/[？?]|什么|怎么|哪/.test(x[1]), x[1]));
});

/* ---------- 结构图（硬件原理） ---------- */
const STEPOF = (h) => ({ '①': 1, '②': 2, '③': 3, '④': 4 })[String(h || '').trim()[0]] || 0;   // 「用：……」「中断：……」都算用的时候
// 课件代码里每一行寄存器操作 → 结构图上的哪一块、标的是第几步；和代码上方的小标题（① 开时钟 ……）一致
function walk(c, file, fnNames) {
  const src = L.file(c, file), fns = L.parseFile(src).fns, groups = c.groups[file], out = [];
  fnNames.forEach((n) => fns[n].src.forEach((i) => {
    let g = null; Object.keys(groups).map(Number).filter((k) => k <= i).forEach((k) => { g = groups[k]; });
    const d = L.docFor(c, src[i][0], null); if (d && d.kind === 'reg') out.push({ code: src[i][0].trim(), d, step: STEPOF(g) });
  }));
  return out;
}
function regsAt(c, z, vr) { return ((c.map.zones.find((q) => q.id === z).regs || {})[vr]) || []; }
test('结构图：课件初始化代码的每个寄存器都画在图上，圆圈数字和代码的小标题一致', () => {
  assert.ok(walk(tc, 'tim.c', ['Tick_Init', 'PWM_Init']).length === 20 && walk(ch, 'led.c', ['LED_Init']).length === 6);
  const check = (c, list) => list.forEach(({ code, d, step }) => {
    const z = L.zoneOf(c, d); assert.ok(z, '图上找不到：' + code);
    const hits = regsAt(c, z.z, z.vr).filter((r) => r.id === d.id && (!d.f.length || d.f.some((f) => String(r.f).split(',').includes(f))));
    if (/CRH/.test(code) && c.id === 'gpio') return;   // PA8 的 CRH：图上只画 PA0 这一位，归在「端口配置」
    if (/ODR \^=/.test(code)) return;   // 翻转：图上只画 BSRR
    assert.ok(hits.length, '这一块没标这个寄存器：' + code + ' → ' + z.z + '/' + z.vr);
    assert.ok(hits.some((r) => r.s === step), '步骤不一致：' + code + ' 代码里是 ' + step + '，图上是 ' + hits.map((r) => r.s));
  });
  check(tc, walk(tc, 'tim.c', ['Tick_Init', 'PWM_Init', 'PWM_SetDuty', 'TIM6_IRQHandler']));
  check(ch, walk(ch, 'led.c', ['LED_Init', 'LED_On', 'LED_Off', 'LED_Toggle']));
  // 换题的参考写法（按键）：每一行都落在「按键」那种用法上
  ch.transfer.ref.split('\n').filter((l) => /->/.test(l)).forEach((l) => {
    const d = L.docFor(ch, l.replace(/\/\/.*$/, ''), null), z = L.zoneOf(ch, Object.assign({ port: 'F' }, d));
    assert.ok(z && z.vr === 'key', l);
    assert.ok(regsAt(ch, z.z, 'key').some((r) => r.id === d.id), l);
  });
});
test('结构图：用法、块、寄存器的资料都对得上', () => {
  const regs = fs.readFileSync(path.join(root, 'assets/registers.js'), 'utf8');
  [ch, tc].forEach((c) => {
    const ids = c.map.zones.map((z) => z.id), vrs = c.map.variants.map((v) => v.id);
    c.map.variants.forEach((v) => (v.none || []).concat(v.idle || []).forEach((z) => assert.ok(ids.includes(z), z)));
    c.map.zones.forEach((z) => {
      assert.ok(!/[？?]|什么|怎么/.test(z.name), z.name);
      assert.ok(z.lead && z.points.length >= 2, z.id);
      Object.keys(z.regs).forEach((k) => assert.ok(vrs.includes(k), k));
      vrs.forEach((v) => (z.regs[v] || []).forEach((r) => {
        assert.ok([0, 1, 2, 3, 4].includes(r.s), r.n);
        assert.ok(regs.includes('"id":"' + r.id + '"'), r.id);
        if (r.doc) { assert.ok(c.docs[r.doc], r.doc); assert.equal(c.docs[r.doc].id, r.id, r.doc); }
      }));
      if (z.mini) assert.ok(['saw', 'pwm', 'modes', 'drive'].includes(z.mini), z.mini);
    });
  });
  eq(L.zoneOf(tc, tc.docs['reg-dier']), { z: 'irq', vr: 'tick' });
  eq(L.zoneOf(tc, tc.docs['reg-crl-pa1']), { z: 'pin', vr: 'pwm' });
  eq(L.zoneOf(tc, L.docFor(tc, 'RCC->APB1ENR |= RCC_APB1ENR_TIM6EN;')), { z: 'clk', vr: 'tick' });
  eq(L.zoneOf(ch, ch.docs['reg-idr']), { z: 'in', vr: 'key' });
  eq(L.zoneOf(ch, ch.docs['reg-crh']), { z: 'cfg', vr: 'led' });
  assert.equal(L.zoneOf(ch, ch.docs['sch-led']), null);
});
