const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.join(__dirname, '../site/tools/stm32');
const sandbox = { window: {} };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(root, 'assets/registers.js'), 'utf8'), sandbox);
const core = require('../site/tools/stm32/reg-core.js');
const R = core.create(sandbox.window.STM32_REGS);
const api = { genCode: R.genCode, P: R.P, layout: R.layout, quickVal: R.quickVal, fmask: core.fmask };
const groups = R.groups;
function context(id, values, touched) {
  const g = groups.find(g => g.regs.some(r => r.id === id));
  const r = g.regs.find(r => r.id === id), inst = g.instances[0];
  const c = { r, inst, n: null, st: { v: values >>> 0, touched: Object.fromEntries(touched.map(k => [k, true])) } };
  c.lay = api.layout(r, values); return c;
}
function macros(c) { return Object.fromEntries(c.r.fields.filter(f => f.cmsis).map(f => [f.cmsis, api.fmask(f)])); }
test('USART pin update preserves previously configured PA8 and PA12', () => {
  const r = groups.find(g => g.id === 'gpio').regs.find(r => r.id === 'GPIO_CRH');
  const q = r.quick.find(q => q.title.startsWith('USART1'));
  const desired = api.quickVal(r, q).v;
  const c = context('GPIO_CRH', desired, Object.keys(q.set));
  const code = api.genCode(c);
  assert.equal((code.match(/->CRH\s*=/g) || []).length, 1, 'copy must contain exactly one write');
  const GPIOA = { CRH: 0x44434443 };
  vm.runInNewContext(code.replace(/->/g, '.'), { GPIOA, ...macros(c) });
  assert.equal(GPIOA.CRH >>> 0, 0x444344B3);
  assert.equal(GPIOA.CRH & 15, 3, 'PA8 remains a push-pull output');
  assert.equal((GPIOA.CRH >>> 16) & 15, 3, 'PA12 remains a push-pull output');
});
test('an untouched calculator generates no implicit reset write', () => {
  const c = context('GPIO_CRH', 0x44444444, []);
  assert.doesNotMatch(api.genCode(c), /->CRH\s*=/);
});
test('write-one actions are emitted once and without read-modify-write', () => {
  const r = groups.find(g => g.id === 'gpio').regs.find(r => r.id === 'GPIO_BSRR');
  const f = r.fields.find(f => !f.reserved && f.bits[1] === 0);
  const code = api.genCode(context(r.id, 1, [f.name]));
  assert.equal((code.match(/->BSRR\s*=/g) || []).length, 1);
  assert.doesNotMatch(code, /[&|]=|=\s*\(.*BSRR/);
});
test('write-zero flags clear only the chosen flag with a single direct write', () => {
  const g = groups.find(g => g.id === 'tim'), r = g.regs.find(r => r.id === 'TIM_SR');
  const f = r.fields.find(f => f.name === 'UIF');
  assert.ok(f);
  const code = api.genCode(context(r.id, 0, ['UIF']));
  assert.equal((code.match(/->SR\s*=/g) || []).length, 1);
  assert.doesNotMatch(code.replace(/\/\*[\s\S]*?\*\//g, ''), /&=/);
  let writes = 0, written;
  const TIM1 = { set SR(v) { writes++; written = v >>> 0; } };
  const instance = g.instances[0].name;
  vm.runInNewContext(code.replace(/->/g, '.'), { [instance]: TIM1, ...macros(context(r.id, 0, ['UIF'])) });
  assert.equal(writes, 1); assert.equal(written & 1, 0); assert.equal(written & 2, 2);
});
test('every quick configuration in the data matches the computed register value', () => {
  assert.deepEqual(R.verifyQuicks(), []);
});
test('addresses and C expressions resolve per instance and channel', () => {
  const crl = R.reg('GPIO_CRL'), ccr = R.reg('DMA_CCR'), brr = R.reg('USART_BRR');
  assert.equal(R.regExpr(crl, R.findInst(crl, 'GPIOB'), null), 'GPIOB->CRL');
  assert.equal(core.hexC(R.addrOf(crl, R.findInst(crl, 'GPIOB'), null), 32), '0x40010C00');
  assert.equal(R.regExpr(ccr, R.findInst(ccr, 'DMA1'), 3), 'DMA1_Channel3->CCR');
  assert.equal(core.hexC(R.addrOf(brr, R.findInst(brr, 'USART1'), null), 32), '0x40013808');
});
test('baud and I2C helpers give the textbook values at 72 MHz / 36 MHz', () => {
  const b = R.baud(72, 115200); assert.equal(b.m, 39); assert.equal(b.fr, 1);
  const c = R.i2cCcr(36, 100, 0); assert.equal(c.ccr, 180); assert.equal(c.fast, false);
});
test('TIM_CCER cases follow the peer CCMR register (output vs input capture)', () => {
  const ccer = R.reg('TIM_CCER'), f = R.P(ccer).byName.CC1P, inst = R.findInst(ccer, 'TIM2');
  const out = R.info({ r: ccer, inst, peer: () => 0 }, f, 0);
  const inp = R.info({ r: ccer, inst, peer: () => 1 }, f, 0);   // CC1S=01 → 输入
  assert.notDeepEqual(out.vals, inp.vals);
});

test('unknown register and group names never resolve inherited object properties', () => {
  for (const id of ['constructor', 'toString', 'hasOwnProperty', '__proto__', 'unknown']) {
    assert.equal(R.reg(id), null);
    assert.equal(R.group(id), null);
    assert.equal(R.byName(id, 'constructor'), null);
    assert.equal(R.byName('gpio', id), null);
  }
  assert.equal(R.byName('gpio', 'GPIOx_CRL'), R.reg('GPIO_CRL'));
});

test('I2C CCR rounds up instead of exceeding the requested bus speed', () => {
  const c = R.i2cCcr(36, 350, 0);
  assert.equal(c.ccr, 35);
  assert.equal(c.ok, true);
  assert.ok(Math.abs(c.real - 342.857142857) < 1e-6);
  for (const clock of [2, 4, 8, 24, 36]) for (const duty of [0, 1]) {
    for (let speed = 1; speed <= 400; speed++) {
      const k = R.i2cCcr(clock, speed, duty);
      if (!k.ok) continue;
      assert.ok(Number.isInteger(k.ccr) && k.ccr <= 4095 && k.ccr >= (k.fast ? 1 : 4));
      assert.ok(k.real <= speed + 1e-9, `${clock} MHz / ${speed} kHz / DUTY=${duty}`);
    }
  }
});

test('I2C frequency limits match STM32F103 standard and fast modes', () => {
  assert.equal(R.i2cCcr(2, 100, 0).ok, true);
  assert.equal(R.i2cCcr(4, 400, 1).ok, true);
  for (const [clock, speed] of [[1, 100], [3, 400], [37, 100], [36, 401], [36, 800], [36, 0.01]]) {
    const k = R.i2cCcr(clock, speed, 0);
    assert.equal(k.ok, false, `${clock} MHz / ${speed} kHz`);
    assert.ok(k.err);
  }
  for (const value of ['', 'NaN', 'Infinity', -1, 0]) {
    assert.equal(R.i2cCcr(value, 100, 0), null);
    assert.equal(R.i2cCcr(36, value, 0), null);
  }
});
