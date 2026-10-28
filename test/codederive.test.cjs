/* 代码推导：每一步都有代码或示意、文件行都标了属于哪一步、有内容的行都有注释 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.join(__dirname, '../site/tools/stm32');
const sb = { window: {} }; sb.window.window = sb.window; vm.createContext(sb);
['topics.js', 'pins.js', 'codederive.js'].forEach((f) => vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), sb, { filename: f }));
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
      if (STRUCT.test(l[0]) || /^\s*(void|int|uint\d+_t)\s+\w+\(.*\)$/.test(l[0]) || /^#define \w+\s+\d+$/.test(l[0])) return;
      assert.ok(l[1], f.name + ' 缺注释：' + l[0]);
    }));
  });
  test(tid + '：头文件有保护，main.c 包含模块头文件', () => {
    const h = cd.files.find((f) => /\.h$/.test(f.name)), m = cd.files.find((f) => f.name === 'main.c');
    assert.match(h.lines[0][0], /^#ifndef __\w+_H$/); assert.match(h.lines[h.lines.length - 1][0], /^#endif/);
    assert.ok(m.lines.some((l) => l[0] === '#include "' + h.name + '"'));
  });
}

test('GPIO：LED1~3 的脚号和开发板一致（PA0 / PA1 / PA8），CRL / CRH 掩码只动这三个脚', () => {
  const c = D.CD.gpio.files.find((f) => f.name === 'led.c').lines.map((l) => l[0]).join('\n');
  assert.match(c, /led_pin\[\] = \{ 0, 0, 1, 8 \}/);
  assert.match(c, /CRL & ~0x000000FFu\) \| 0x00000033u/);
  assert.match(c, /CRH & ~0x0000000Fu\) \| 0x00000003u/);
});
