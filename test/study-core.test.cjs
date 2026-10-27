const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../site/tools/stm32/study-core.js');
test('register links round-trip the instance, pin, field and calculator value', () => {
  const x = { tab: 'regs', reg: 'GPIO_CRH', f: 'MODE9', i: 'GPIOA', y: 9, v: '0x444444B4', m: '0x00000FF0' };
  assert.deepEqual(core.fromParams(core.params(x)), { ...x, y: '9' });
});
test('route whitelist discards injected URLs, unknown keys and invalid values', () => {
  const x = core.fromParams('tab=regs&reg=javascript:alert(1)&next=https://example.com&embed=1&v=NaN&y=-1');
  assert.deepEqual(x, { tab: 'regs' });
  assert.deepEqual(core.target({ cw: '../bad-16', fig: 'https://example.com/x' }), { tab: 'pins' });
});
test('course and code routes preserve Chinese text and page numbers', () => {
  assert.deepEqual(core.fromParams(core.params({ cw: 'v20-134' })), { tab: 'course', cw: 'v20-134' });
  const x = { tab: 'code', cat: '串口', snip: 'USART1 中断收发' };
  assert.deepEqual(core.fromParams(core.params(x)), x);
});
test('one note remains attached to the register after its calculator value changes', () => {
  assert.equal(core.key({ reg: 'GPIO_CRH', f: 'MODE9', v: '0x44444444' }), core.key({ reg: 'GPIO_CRH', f: 'MODE9', v: '0x444444B4' }));
});
test('backup import validates and deduplicates records without interpreting notes as HTML', () => {
  const note = '<img src=x onerror=alert(1)>';
  const x = { title: 'PA9', target: { q: 'PA9' }, note, starred: true, status: 'done', updatedAt: 1 };
  const records = core.records([null, x, x, { title: '', target: {} }]);
  assert.equal(records.length, 1); assert.equal(records[0].note, note); assert.equal(records[0].status, 'done');
});
test('search ranks exact pin names first and supports Chinese peripheral aliases', () => {
  const index = [{ title: 'PA10', words: 'USART1_RX' }, { title: 'PA1', words: 'ADC' }, { title: 'PA9', words: 'USART1_TX' }];
  assert.equal(core.search(index, 'PA 1')[0].title, 'PA1');
  assert.equal(core.search(index, '串口').length, 2);
  assert.equal(core.search(index, 'USART1 TX').length, 1);
});
