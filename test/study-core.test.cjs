const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../site/tools/stm32/study-core.js');

test('register routes round-trip instance, channel and calculator value', () => {
  const x = { v: 'topic', t: 'gpio', reg: 'GPIO_CRH', i: 'GPIOA', val: '0x444444b4' };
  assert.deepEqual(core.fromParams(core.params(x)), { ...x, val: '0x444444B4' });
  assert.deepEqual(core.fromParams('v=topic&t=dma&reg=DMA_CCR&i=DMA1&n=03'), { v: 'topic', t: 'dma', reg: 'DMA_CCR', i: 'DMA1', n: '3' });
});
test('route whitelist discards injected URLs, unknown keys and invalid values', () => {
  const x = core.fromParams('v=topic&t=usart&reg=javascript:alert(1)&next=https://example.com&embed=1&val=NaN&pin=999');
  assert.deepEqual(x, { v: 'topic', t: 'usart' });
  assert.deepEqual(core.target({ v: 'evil', cw: '../bad-16', fig: 'https://example.com/x' }), { v: 'home' });
  assert.deepEqual(core.target({ v: 'chip', pin: '0' }), { v: 'home' });
  assert.deepEqual(core.target({ v: 'home', m: 'Evil!', mp: 'x' }), { v: 'home' });
});
test('home is the default and is left out of the address', () => {
  assert.equal(core.params({}), '');
  assert.equal(core.params({ v: 'home', fig: 'sys-arch' }), 'fig=sys-arch');
  assert.deepEqual(core.fromParams(''), { v: 'home' });
});
test('only one viewer layer survives (figure wins over schematic); courseware links are gone and land on home', () => {
  assert.deepEqual(core.target({ v: 'board', fig: 'usart', sch: 'board-05' }), { v: 'board', fig: 'usart' });
  assert.deepEqual(core.target({ v: 'course', cw: 'v20-16' }), { v: 'home' });
});
test('chip filter keeps Chinese text and trims control characters', () => {
  assert.deepEqual(core.fromParams(core.params({ v: 'home', q: ' 串口\u0007 ' })), { v: 'home', q: '串口' });
});
test('home: old chip links land on home; a module and one of its pins round-trip', () => {
  assert.deepEqual(core.fromParams('v=chip&pin=101'), { v: 'home', pin: '101' });
  assert.equal(core.params({ v: 'home', m: 'eeprom', mp: 'p6' }), 'm=eeprom&mp=p6');
  assert.deepEqual(core.fromParams('m=eeprom&mp=p6&pin=5'), { v: 'home', m: 'eeprom', mp: 'p6' });
  assert.deepEqual(core.target({ v: 'topic', t: 'gpio', m: 'led' }), { v: 'topic', t: 'gpio' });
});
test('old links from the previous layout still open the right place', () => {
  assert.deepEqual(core.fromParams('tab=pins&q=PA9'), { v: 'home', q: 'PA9' });
  assert.deepEqual(core.fromParams('tab=chip&pin=101'), { v: 'home', pin: '101' });
  assert.deepEqual(core.fromParams('tab=chip&page=board-05'), { v: 'board', sch: 'board-05' });
  assert.deepEqual(core.fromParams('tab=course&cw=v20-16'), { v: 'home' });
  assert.deepEqual(core.fromParams('tab=regs&reg=GPIO_CRH.MODE9&i=GPIOA&y=9&v=0x444444B4'), { v: 'topic', reg: 'GPIO_CRH', i: 'GPIOA', val: '0x444444B4' });
  assert.deepEqual(core.fromParams('tab=code&cat=串口&snip=USART1 中断收发'), { v: 'topic', snip: 'USART1 中断收发' });
  assert.deepEqual(core.fromParams('tab=arch&fig=sys-arch'), { v: 'home', fig: 'sys-arch' });
});
test('search ranks exact pin names first and supports Chinese peripheral aliases', () => {
  const index = [{ title: 'PA10', words: 'USART1_RX' }, { title: 'PA1', words: 'ADC' }, { title: 'PA9', words: 'USART1_TX' }];
  assert.equal(core.search(index, 'PA 1')[0].title, 'PA1');
  assert.equal(core.search(index, '串口').length, 2);
  assert.equal(core.search(index, 'USART1 TX').length, 1);
});
test('search expands UART/USART and IIC/I2C by prefix and ranks title hits above detail-only hits', () => {
  const index = [{ title: 'PA9', words: 'USART1_TX' }, { title: 'IIC 通信协议' }, { title: 'GPIOx_CRL', detail: 'GPIO', words: 'GPIO_CRL GPIOA_CRL' }, { title: 'USART1 中断收发', words: 'HAL' }];
  assert.deepEqual(core.search(index, 'UART1').map((x) => x.title), ['USART1 中断收发', 'PA9']);
  assert.equal(core.search(index, 'I2C')[0].title, 'IIC 通信协议');
  assert.equal(core.search(index, 'gpioa_crl')[0].title, 'GPIOx_CRL');
  assert.equal(core.search(index, 'GPIO_CRL 8').length, 0);   // 词边界：GPIO_CRL 8 不会被粘成 GPIO_CRL8
});
test('every topic id defined in topics.js survives the route whitelist', () => {
  const sandbox = { window: {} }; require('node:vm').runInNewContext(require('node:fs').readFileSync(require('node:path').join(__dirname, '../site/tools/stm32/topics.js'), 'utf8'), sandbox);
  sandbox.window.STM32_TOPICS.forEach((t) => assert.deepEqual(core.fromParams(core.params({ v: 'topic', t: t.id })), { v: 'topic', t: t.id }, t.id));
});
