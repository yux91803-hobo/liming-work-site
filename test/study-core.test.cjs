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

test('外设页分页 sec 只认五种，和旧版 tab 参数不冲突', () => {
  assert.deepEqual(core.fromParams('v=topic&t=gpio&sec=code'), { v: 'topic', t: 'gpio', sec: 'code' });
  assert.deepEqual(core.fromParams('v=topic&t=spi&cv=cd'), { v: 'topic', t: 'spi', sec: 'code', cv: 'cd' });
  assert.deepEqual(core.fromParams('v=topic&t=spi&sec=code&cv=xx'), { v: 'topic', t: 'spi', sec: 'code' });
  assert.deepEqual(core.fromParams('v=topic&t=i2c&cf=eeprom.c&cx=i2chw'), { v: 'topic', t: 'i2c', cx: 'i2chw', sec: 'code', cf: 'eeprom.c', cv: 'reg' });
  assert.deepEqual(core.fromParams('v=topic&t=i2c&cf=../x.c'), { v: 'topic', t: 'i2c' });
  assert.deepEqual(core.fromParams('v=topic&t=gpio&sec=evil'), { v: 'topic', t: 'gpio' });
});
test('back stack: going to a page already on the way back returns there instead of stacking another copy', () => {
  const home = { v: 'home' }, gpio = { v: 'topic', t: 'gpio' }, usart = { v: 'topic', t: 'usart' };
  const st = [home, gpio, usart];
  assert.equal(core.backTo(st, 2, { v: 'topic', t: 'gpio', sec: 'regs' }), 1);                     // GPIO 就在返回路径上：退回去
  assert.equal(core.backTo(st, 2, { v: 'topic', t: 'usart', sec: 'code', cv: 'hal' }), 2);       // 同一页换分页：原地替换
  assert.equal(core.backTo(st, 2, { v: 'topic', t: 'i2c' }), -1);                                  // 新的一页
  assert.equal(core.backTo(st, 2, { v: 'topic', t: 'usart', reg: 'USART_BRR' }), -1);              // 寄存器面板是新的一层
  const sheet = { v: 'topic', t: 'gpio', reg: 'GPIO_CRL', i: 'GPIOA' };
  assert.equal(core.backTo([home, gpio, sheet], 2, { v: 'topic', t: 'gpio', reg: 'GPIO_CRL', i: 'GPIOB', val: '0x1' }), 2);   // 换实例 / 计算值：同一层
  assert.equal(core.backTo([home, gpio, sheet, { ...sheet, sch: 'board-04' }], 3, gpio), 1);      // 从查看器点回 GPIO：面板和查看器都退掉
  assert.equal(core.backTo(st, 2, { v: 'home' }), 0);
});

test('explicit topic tabs take priority while retaining the code mode, driver and file', () => {
  for (const sec of ['points', 'pins', 'regs', 'figs', 'code']) {
    for (const cv of ['reg', 'hal', 'cd']) {
      const route = { v: 'topic', t: 'i2c', sec, cv, cx: 'i2chw', cf: 'main.c' };
      assert.deepEqual(core.target(route), route);
      assert.deepEqual(core.fromParams(core.params(route)), route);
    }
  }
});

test('code deep links still infer the code tab when no valid tab is specified', () => {
  for (const input of [{ cv: 'hal' }, { cx: 'i2chw' }, { cf: 'main.c' }]) {
    assert.equal(core.target({ v: 'topic', t: 'i2c', ...input }).sec, 'code');
    assert.equal(core.target({ v: 'topic', t: 'i2c', sec: 'unknown', ...input }).sec, 'code');
  }
  const route = core.target({ v: 'topic', t: 'i2c', sec: 'pins', cf: '../main.c', cx: 'https://evil.test', cv: 'evil' });
  assert.deepEqual(route, { v: 'topic', t: 'i2c', sec: 'pins' });
});
test('back stack: a pin looked up on the chip from a topic is its own page; going home always clears the stack', () => {
  const home = { v: 'home' }, gpio = { v: 'topic', t: 'gpio' };
  assert.equal(core.backTo([home, gpio], 1, { v: 'home', pin: '68' }), -1);                        // 返回还能回到 GPIO
  assert.equal(core.backTo([home, gpio, { v: 'home', pin: '68' }], 2, gpio), 1);
  assert.equal(core.backTo([{ v: 'home', pin: '5' }], 0, home), 0);                                // 首页上点过引脚，再点「首页」：原地
  assert.equal(core.backTo([home, gpio, { v: 'home', pin: '68' }], 2, home), 0);
  assert.equal(core.backTo([gpio, { v: 'topic', t: 'usart' }], 1, home), 0);                       // 从深链打开的：回首页也清空
});
test('back stack: lab steps and derivation steps are pages; hardware tabs and map zones are not', () => {
  const lab = (st) => ({ v: 'lab', t: 'gpio', st });
  assert.equal(core.backTo([lab('task'), lab('look'), lab('plan')], 2, lab('look')), 1);
  assert.equal(core.backTo([lab('task')], 0, lab('plan')), -1);
  assert.equal(core.backTo([lab('task'), lab('code')], 1, { ...lab('code'), fn: 'v2' }), 1);
  const hw = { v: 'think', t: 'gpio', hv: 'map', z: 'odr' };
  assert.equal(core.backTo([{ v: 'home' }, hw], 1, { v: 'think', t: 'gpio', hv: 'why' }), 1);
  assert.equal(core.backTo([{ v: 'home' }, hw], 1, { v: 'think', t: 'gpio', s: 's2' }), -1);
  assert.equal(core.pageKey({ v: 'think', t: 'gpio', s: 's2' }) === core.pageKey({ v: 'think', t: 'gpio', s: 's3' }), false);
});
