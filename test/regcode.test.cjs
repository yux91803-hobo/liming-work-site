/* 寄存器版代码：每一行都有注释、每个推导章函数都存在、注释条数和代码行数一一对应 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.join(__dirname, '../site/tools/stm32');
const sb = { window: {} }; sb.window.window = sb.window; sb.globalThis = sb.window; vm.createContext(sb);
['assets/registers.js', 'pins.js', 'i2csim.js', 'mcusim.js', 'derive-core.js', 'derive-gpio.js', 'derive-usart.js', 'derive-i2c.js', 'derive-tim.js', 'derive-adc.js', 'derive-spi.js', 'topics.js', 'regcode.js']
  .forEach((f) => vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), sb, { filename: f }));
const W = sb.window, RC = W.STM32_REGCODE, D = W.STM32_DERIVE;
const STRUCT = /^\s*(\}|\{|\}\s*else.*|while \(1\) \{|)$/;

test('十个外设都有寄存器版程序', () => {
  W.STM32_TOPICS.forEach((t) => assert.ok((RC.PROGS[t.id] || []).length >= 1, t.id));
});

test('推导章的程序：函数都在章里，注释条数和代码行数一样，非结构行都有注释', () => {
  Object.entries(RC.PROGS).forEach(([tid, list]) => list.forEach((p) => {
    if (!p.chapter) return;
    const ch = D[p.chapter]; assert.ok(ch, p.chapter);
    p.fns.forEach((fn) => {
      const src = ch.fns[fn]; assert.ok(src, p.chapter + '.' + fn);
      const cm = RC.CM[p.chapter][fn]; assert.ok(cm, '缺注释 ' + p.chapter + '.' + fn);
      assert.equal(cm.length, src.lines.length, p.chapter + '.' + fn + ' 注释 ' + cm.length + ' 条，代码 ' + src.lines.length + ' 行');
      src.lines.forEach((l, i) => { if (!STRUCT.test(l.c.trim()) && !/^\s*uint8_t (err|nack|v = 0);$/.test(l.c) && !/^\s*uint32_t id;$/.test(l.c)) assert.ok(cm[i], p.chapter + '.' + fn + ' 第 ' + (i + 1) + ' 行没有注释：' + l.c); });
      if (src.pre) assert.equal(RC.CM[p.chapter]._pre.length, src.pre.length, '宏定义注释');
    });
    assert.ok(p.plan.length >= 2, tid + '/' + p.id + ' 缺思路');
  }));
});

test('自己写的程序（RCC / EXTI / DMA / FSMC）：每行都有代码、注释和理由', () => {
  ['sys', 'exti', 'dma', 'fsmc'].forEach((tid) => RC.PROGS[tid].forEach((p) => {
    assert.ok(!p.chapter && p.plan.length >= 3, tid);
    p.fns.forEach((f) => f.lines.forEach((l) => {
      assert.ok(l[0], tid + ' 空行');
      if (!STRUCT.test(l[0].trim()) && !/^\s*(led_init|key1_exti_init)\(\);$/.test(l[0])) { assert.ok(l[1], tid + ' 缺注释：' + l[0]); }
      if (/->|NVIC_|#define/.test(l[0])) assert.ok(l[2] && l[2].length > 6, tid + ' 缺理由：' + l[0]);
    }));
  }));
});

test('几个容易写错的寄存器值', () => {
  const lines = (tid) => RC.PROGS[tid].flatMap((p) => p.fns.flatMap((f) => f.lines.map((l) => l[0])));
  const fs_ = lines('fsmc').join('\n');
  assert.match(fs_, /0x6C000000/); assert.match(fs_, /0x6C000800/);          // NE4 起始；A10 → HADDR bit11
  assert.match(fs_, /BTCR\[6\] = \(1 << 12\) \| \(1 << 4\) \| \(1 << 0\)/);   // BCR4：WREN | MWID=16 位 | MBKEN
  const dma = lines('dma').join('\n');
  assert.match(dma, /DMA1_Channel4/); assert.match(dma, /TCIF4/);              // USART1_TX 在 DMA1 通道 4
  const rcc = lines('sys').join('\n');
  assert.match(rcc, /2 << FLASH_ACR_LATENCY_Pos/); assert.match(rcc, /PLLMULL9/); assert.match(rcc, /PPRE1_DIV2/);
  const ex = lines('exti').join('\n');
  assert.match(ex, /EXTICR\[2\]/); assert.match(ex, /AFIOEN/); assert.match(ex, /EXTI9_5_IRQn/);
});
