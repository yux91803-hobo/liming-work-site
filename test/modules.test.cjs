/* 板载模块：每个脚接到的 MCU 引脚都存在，并和开发板资源表（assets/board.js）一致 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.join(__dirname, '../site/tools/stm32');
const sb = { window: {} }; sb.window.window = sb.window; vm.createContext(sb);
['pins.js', 'assets/board.js', 'modules.js', 'pindoc.js', 'topics.js'].forEach((f) => vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), sb, { filename: f }));
const W = sb.window, MODS = W.STM32_MODULES, PINS = {};
W.STM32_PINS.forEach((p) => { PINS[p[1]] = p; });
const BOARD = (W.STM32_BOARD || {}).resources.filter((r) => r && r.mcu);

test('每个模块：id 唯一、有标签、脚的键唯一、要么接 MCU 要么接电源网络', () => {
  const ids = new Set();
  MODS.forEach((m) => {
    assert.ok(!ids.has(m.id), m.id); ids.add(m.id);
    assert.match(m.id, /^[a-z][a-z0-9]{1,11}$/);
    assert.ok(m.tag && m.kind && m.pins.length >= 3, m.id);
    const ks = new Set();
    m.pins.forEach((p) => {
      assert.match(p.k, /^[a-z0-9]{1,8}$/, m.id + ' ' + p.k); assert.ok(!ks.has(p.k), m.id + ' ' + p.k); ks.add(p.k);
      if (p.mcu) assert.ok(PINS[p.mcu], m.id + ' ' + p.name + ' → ' + p.mcu + ' 不是芯片上的引脚');
    });
    if (m.topic) assert.ok(W.STM32_TOPICS.some((t) => t.id === m.topic), m.id + ' topic');
  });
});

test('和开发板资源表一致：EEPROM、Flash、LED、按键、蜂鸣器、电位器、串口、LCD', () => {
  const want = {
    eeprom: { SCL: 'PB10', SDA: 'PB11' }, flash: { CS: 'PC13', CLK: 'PA5', DO: 'PA6', DI: 'PA7' },
    led: { LED1: 'PA0', LED2: 'PA1', LED3: 'PA8', LED5: 'PG11' }, key: { KEY1: 'PF8', KEY2: 'PF9', KEY3: 'PF10', KEY4: 'PF11', RESET: 'NRST' },
    beep: { G: 'PB1' }, pot: { 2: 'PC0' }, stlink: { TX: 'PA9', RX: 'PA10', SWDIO: 'PA13', SWCLK: 'PA14' },
    lcd: { CS: 'PG12', RS: 'PG0', RST: 'PG15', BL: 'PB0', T_SCL: 'PB6', T_SDA: 'PB7', T_INT: 'PC1' }
  };
  Object.entries(want).forEach(([id, map]) => {
    const m = MODS.find((x) => x.id === id);
    Object.entries(map).forEach(([name, mcu]) => {
      const p = m.pins.find((x) => x.name === name);
      assert.equal(p && p.mcu, mcu, id + ' ' + name);
      assert.ok(BOARD.some((r) => r.mcu.split('/').includes(mcu) || r.mcu === mcu), mcu + ' 不在开发板资源表里');
    });
  });
});

test('LCD：16 根数据线接到芯片的 FSMC_D0~D15，控制线是 NE4 / A10 / NWE / NOE', () => {
  const lcd = MODS.find((x) => x.id === 'lcd');
  assert.equal(lcd.pins.length, 28);
  for (let i = 0; i < 16; i++) { const p = lcd.pins.find((x) => x.name === 'D' + i); assert.ok(PINS[p.mcu][4].split(' ').includes('FSMC_D' + i), 'D' + i + ' → ' + p.mcu); }
  [['CS', 'FSMC_NE4'], ['RS', 'FSMC_A10'], ['WR', 'FSMC_NWE'], ['RD', 'FSMC_NOE']].forEach(([n, sig]) => {
    const p = lcd.pins.find((x) => x.name === n); assert.ok(PINS[p.mcu][4].split(' ').includes(sig), n);
  });
});

test('SOP-8 芯片 8 个脚号齐全；M24C02 三个地址脚都接地（地址 0xA0）', () => {
  MODS.filter((m) => m.kind === 'sop8').forEach((m) => assert.deepEqual(JSON.parse(JSON.stringify(m.pins.map((p) => p.no))), [1, 2, 3, 4, 5, 6, 7, 8]));
  const e = MODS.find((x) => x.id === 'eeprom');
  ['E0', 'E1', 'E2', 'WC'].forEach((n) => assert.equal(e.pins.find((p) => p.name === n).net, 'GND'));
});

test('SRAM / NAND / LCD 的 FSMC 信号都接到芯片上对应功能的引脚', () => {
  let n = 0;
  MODS.forEach((m) => m.pins.forEach((p) => {
    if (!p.sig) return;
    n++;
    assert.ok(PINS[p.mcu] && PINS[p.mcu][4].split(' ').includes(p.sig), m.id + ' ' + p.name + ' ' + p.sig + ' → ' + p.mcu);
  }));
  assert.ok(n >= 40, n);
});

test('多脚封装：脚号不重复、不超过总脚数；QFP 是 4 的倍数', () => {
  MODS.forEach((m) => {
    if (m.kind !== 'dual' && m.kind !== 'qfp') return;
    const n = m.n || 8, seen = new Set();
    m.pins.forEach((p) => { assert.ok(p.no >= 1 && p.no <= n && !seen.has(p.no), m.id + ' ' + p.no); seen.add(p.no); });
    if (m.kind === 'qfp') assert.equal(n % 4, 0);
  });
});

test('串口外设：RS485 / RS232 经跳线复用 USART1，ESP32 接 USART2，CAN 在 PB8 / PB9', () => {
  const g = (id, name) => MODS.find((x) => x.id === id).pins.find((p) => p.name === name).mcu;
  assert.equal(g('rs485', 'RO'), 'PA10'); assert.equal(g('rs485', 'DI'), 'PA9'); assert.equal(g('rs485', 'DE'), 'PE3');
  assert.equal(g('rs232', 'T1IN'), 'PA9'); assert.equal(g('rs232', 'R1OUT'), 'PA10');
  assert.equal(g('esp32', 'GPIO6'), 'PA2'); assert.equal(g('esp32', 'GPIO7'), 'PA3'); assert.equal(g('esp32', 'CHIP_EN'), 'PE4');
  assert.equal(g('can', 'TXD'), 'PB9'); assert.equal(g('can', 'RXD'), 'PB8');
  assert.equal(g('w5500', 'SCSn'), 'PD3'); assert.equal(g('lora', 'NSS'), 'PG14'); assert.equal(g('sd', 'CMD'), 'PD2');
});

test('每个模块的每个脚都有「作用」说明（大白话，不写寄存器）', () => {
  const doc = W.STM32_PINDOC.doc, table = W.STM32_PINDOC.table, keys = new Set();
  MODS.forEach((m) => m.pins.forEach((p) => {
    keys.add(m.id + '.' + p.k); keys.add(m.id + '.' + p.name);
    const d = doc(m, p);
    assert.ok(d.role && d.role.length >= 12, m.id + '.' + p.name + ' 缺作用');
    assert.doesNotMatch(d.role, /GPIO[A-G]_|CR[LH]|MODE\d|->/, m.id + '.' + p.name + ' 不写寄存器');
    if (p.mcu) assert.ok(d.role.length >= 30, m.id + '.' + p.name + ' 接 MCU 的脚要讲细一点');
  }));
  Object.keys(table).forEach((k) => assert.ok(keys.has(k), '多余的说明：' + k));
});
