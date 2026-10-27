const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.join(__dirname, '../site/tools/stm32');
const sandbox = { window: {}, document: {} };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(root, 'assets/registers.js'), 'utf8'), sandbox);
const source = fs.readFileSync(path.join(root, 'regs.js'), 'utf8');
vm.runInContext(source.replace(/\}\)\(\);\s*$/, 'window.__generator = { genCode, P, layout, quickVal, fmask }; })();'), sandbox);
const api = sandbox.window.__generator, groups = sandbox.window.STM32_REGS.groups;
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
