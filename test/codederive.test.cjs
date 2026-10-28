/* 代码推导：每一步都有代码或示意、文件行都标了属于哪一步、有内容的行都有注释 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.join(__dirname, '../site/tools/stm32');
const sb = { window: {} }; sb.window.window = sb.window; vm.createContext(sb);
['topics.js', 'pins.js', 'codederive.js', 'codederive-more.js'].forEach((f) => vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), sb, { filename: f }));
const W = sb.window, D = W.STM32_CODEDERIVE, PINS = {};
W.STM32_PINS.forEach((p) => { PINS[p[1]] = p; });
const STRUCT = /^\s*(\{|\}|\}\s*;?|)$/;

test('通用写法有 8 步', () => { assert.equal(D.METHOD.length, 8); });

for (const [tid, cd] of Object.entries(D.CD)) {
  test(tid + '：外设存在；有 .h、.c、main.c', () => {
    assert.ok(W.STM32_TOPICS.some((t) => t.id === tid), tid);
    const names = cd.files.map((f) => f.name);
    assert.ok(names.some((n) => /\.h$/.test(n)) && names.some((n) => /\.c$/.test(n) && n !== 'main.c') && names.includes('main.c'), names.join(','));
  });
  test(tid + '：每一步都有讲解和代码；每行代码都属于某一步', () => {
    const ids = new Set(cd.steps.map((s) => s.id));
    cd.files.forEach((f) => f.lines.forEach((l) => assert.ok(ids.has(l[3]), f.name + ' 「' + l[0] + '」 的步骤 ' + l[3])));
    cd.steps.forEach((s) => {
      assert.ok(s.q && s.say.length >= 1, s.id);
      const n = cd.files.reduce((a, f) => a + f.lines.filter((l) => l[3] === s.id && l[0]).length, 0);
      assert.ok(n > 0 || s.extra, s.id + ' 没有代码');
    });
  });
  test(tid + '：有内容的代码行都有注释，函数签名和宏除外', () => {
    cd.files.forEach((f) => f.lines.forEach((l) => {
      if (STRUCT.test(l[0]) || /^\s*\/\*.*\*\/$/.test(l[0]) || /^\s*(void|int|uint\d+_t)\s+\w+\(.*\)$/.test(l[0]) || /^#define \w+\s+\d+$/.test(l[0]) || /^#define __\w+_H$/.test(l[0])) return;
      assert.ok(l[1], f.name + ' 缺注释：' + l[0]);
    }));
  });
  test(tid + '：头文件有保护，main.c 包含模块头文件', () => {
    const h = cd.files.find((f) => /\.h$/.test(f.name)), m = cd.files.find((f) => f.name === 'main.c');
    assert.match(h.lines[0][0], /^#ifndef __\w+_H$/); assert.match(h.lines[h.lines.length - 1][0], /^#endif/);
    assert.ok(m.lines.some((l) => l[0] === '#include "' + h.name + '"'));
  });
}

test('GPIO：LED1~3 是 PA0 / PA1 / PA8（用 ODR 位的宏查表）', () => {
  const c = D.CD.gpio.files.find((f) => f.name === 'led.c').lines.map((l) => l[0]).join('\n');
  assert.match(c, /led_pin\[\] = \{ 0, GPIO_ODR_ODR0, GPIO_ODR_ODR1, GPIO_ODR_ODR8 \}/);
});

test('十个外设都有代码推导', () => {
  W.STM32_TOPICS.forEach((t) => assert.ok(D.CD[t.id], t.id));
});
// 按宏名把 CRL / CRH 的配置语句「执行」一遍（复位值 0x44444444），得到每个脚最后的 4 位
function gpioMacro(name) {
  const m = /^GPIO_CR([LH])_(MODE|CNF)(\d+)(_0|_1)?$/.exec(name); if (!m) return null;
  const y = Number(m[3]) - (m[1] === 'H' ? 8 : 0), sh = 4 * y + (m[2] === 'CNF' ? 2 : 0);
  return { reg: 'CR' + m[1], v: (m[4] === '_0' ? 1 : m[4] === '_1' ? 2 : 3) << sh };
}
function runGpio(lines) {
  const st = {};
  lines.forEach((c) => {
    const m = /(GPIO[A-G]|LED_PORT)->(CR[LH])\s*(&=\s*~|\|=)\s*\(([^;]*)\);/.exec(c); if (!m) return;
    const port = m[1] === 'LED_PORT' ? 'GPIOA' : m[1], key = port + m[2];
    let v = 0; m[4].split('|').map((x) => x.trim()).forEach((n) => { const g = gpioMacro(n); assert.ok(g && g.reg === m[2], '不认识的宏 ' + n + '（' + c + '）'); v |= g.v; });
    if (st[key] == null) st[key] = 0x44444444;
    st[key] = (m[3].startsWith('&') ? st[key] & ~v : st[key] | v) >>> 0;
  });
  return st;
}
function nib(st, port, y) { const r = st[port + (y < 8 ? 'CRL' : 'CRH')]; return r == null ? null : (r >>> (4 * (y % 8))) & 0xF; }
test('代码推导：GPIO 配置用宏名写，按宏执行后每个脚的配置正确', () => {
  const all = (id) => D.CD[id].files.flatMap((f) => f.lines.map((l) => l[0]));
  Object.keys(D.CD).forEach((id) => all(id).forEach((c) => assert.ok(!/->CR[LH].*0x[0-9A-F]{4,}/i.test(c), id + ' 还有数字写法：' + c)));
  const want = {
    gpio: [['GPIOA', 0, 3], ['GPIOA', 1, 3], ['GPIOA', 8, 3]],
    usart: [['GPIOA', 9, 0xB], ['GPIOA', 10, 4]],
    i2c: [['GPIOB', 10, 7], ['GPIOB', 11, 7]],
    tim: [['GPIOA', 1, 0xB]],
    adc: [['GPIOC', 0, 0]],
    spi: [['GPIOC', 13, 2], ['GPIOA', 5, 0xB], ['GPIOA', 6, 4], ['GPIOA', 7, 0xB]],
    exti: [['GPIOF', 8, 8]],
    fsmc: [['GPIOD', 0, 0xB], ['GPIOD', 5, 0xB], ['GPIOD', 14, 0xB], ['GPIOE', 7, 0xB], ['GPIOE', 15, 0xB], ['GPIOG', 0, 0xB], ['GPIOG', 12, 0xB], ['GPIOG', 15, 3], ['GPIOB', 0, 3], ['GPIOD', 2, 4], ['GPIOD', 6, 4]]
  };
  Object.entries(want).forEach(([id, pins]) => {
    const st = runGpio(all(id));
    pins.forEach(([port, y, v]) => assert.equal(nib(st, port, y), v, id + ' P' + port.slice(-1) + y));
  });
  const txt = (id) => all(id).join('\n');
  assert.match(txt('i2c'), /EEPROM_ADDR  0xA0/);
  assert.match(txt('exti'), /EXTI9_5_IRQn/);
  assert.match(txt('dma'), /DMA1_Channel4/);
  assert.match(txt('fsmc'), /0x6C000800u/);
  assert.match(txt('sys'), /PLLMULL9/);
});
test('步骤标题不用问号', () => {
  Object.values(D.CD).forEach((cd) => cd.steps.forEach((s) => assert.ok(!/[？?]/.test(s.q), s.q)));
});
