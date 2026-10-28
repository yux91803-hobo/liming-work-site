/* 「编程思维」全部推导章节的通用检查 + 通用单片机模拟器（mcusim.js）的关键行为 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.join(__dirname, '../site/tools/stm32');
const sb = { window: {} }; sb.window.window = sb.window; sb.globalThis = sb.window;
vm.createContext(sb);
const IDS = ['gpio', 'usart', 'i2c', 'tim', 'adc', 'spi'];
['assets/registers.js', 'pins.js', 'i2csim.js', 'mcusim.js', 'derive-core.js'].concat(IDS.map((id) => 'derive-' + id + '.js'))
  .forEach((f) => vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), sb, { filename: f }));
const W = sb.window, C = W.STM32DeriveCore, S = W.STM32McuSim, D = W.STM32_DERIVE;
const plain = (x) => JSON.parse(JSON.stringify(x));

test('六章都在，而且顺序和课件一致', () => {
  assert.deepEqual(plain(Object.keys(D).sort()), IDS.slice().sort());
});

for (const id of IDS) {
  const ch = D[id];
  test(id + '：内容自检（引用、题目、规则、场景）', () => { assert.deepEqual(plain(C.validate(ch)), []); });

  test(id + '：推导链完整，每一环都停下来问至少一次', () => {
    const per = {};
    Object.values(C.allAsks(ch)).forEach((a) => { per[a.stepId] = (per[a.stepId] || 0) + 1; });
    ch.steps.forEach((s, i) => {
      assert.ok(s.q && s.gist && s.beats.length >= 3, s.id);
      if (i < ch.steps.length - 1) assert.ok(s.next, s.id + ' next');
      if (i > 0) assert.ok(s.from, s.id + ' from');
      assert.ok(per[s.id] >= 1, id + ' ' + s.id + ' 没有提问');
    });
    assert.ok(ch.steps.length >= 12, id + ' 只有 ' + ch.steps.length + ' 环');
    assert.ok(ch.steps[ch.steps.length - 1].transfer, id + ' 最后一环应是迁移练习');
  });

  test(id + '：每个主干结论都被推出来、又被用到', () => {
    const used = new Set();
    ch.steps.forEach((s) => (s.uses || []).forEach((f) => used.add(f)));
    Object.values(ch.fns).forEach((fn) => fn.lines.forEach((l) => (l.from || []).forEach((f) => used.add(f))));
    Object.keys(ch.facts).forEach((f) => {
      assert.ok((ch.steps.find((s) => s.id === ch.facts[f].from).makes || []).includes(f), id + ' ' + f + ' 出处没写 makes');
      assert.ok(used.has(f), id + ' ' + f + ' 推出来以后没人用');
    });
  });

  test(id + '：错误选项都指出「默认了什么 + 反例 + 回看哪一环」', () => {
    Object.values(C.allAsks(ch)).filter((a) => a.type === 'choice').forEach((a) => {
      assert.equal(a.opts.filter((o) => o.ok).length, 1, a.id);
      a.opts.filter((o) => !o.ok).forEach((o) => assert.ok(o.assume && o.counter && o.back, a.id + ' / ' + o.t));
    });
  });

  test(id + '：交换规则两端的代码行，要么跑出差别，要么写明为什么看不出来', () => {
    Object.entries(ch.fns).forEach(([name, fn]) => (fn.rules || []).forEach((r) => {
      const x = C.swapCheck(ch, name, r.a, r.b);
      if (x.same || x.nosim || x.structural) return;
      assert.ok(x.diff.length || r.simNote, id + ' ' + name + ' ' + r.a + '<' + r.b + ' 看不出区别也没有 simNote');
    }));
  });

  test(id + '：排序题的标准答案满足自己的规则', () => {
    Object.values(C.allAsks(ch)).filter((a) => a.type === 'order').forEach((a) => {
      const it = C.orderItems(ch, a);
      assert.ok(C.checkOrder(it.texts, [...Array(it.texts.length).keys()], it.rules).ok, a.id);
      assert.ok(it.texts.length >= 3, a.id);
    });
  });

  if (ch.engine === 'mcu') test(id + '：每个场景都能跑完（不出模拟错误）', () => {
    Object.entries(ch.scenarios).forEach(([k, sc]) => { if (sc.compare) return; const r = C.runScenario(ch, k); assert.notEqual(r.stop.kind, 'error', id + '/' + k + '：' + r.stop.text); });
  });
}

test('GPIO：LED1 每 500 ms 翻转；没开时钟灯不亮；按键带消抖只翻转两次', () => {
  const ch = D.gpio;
  const b = C.runScenario(ch, 'blink'), on = b.leds.LED1.ev.filter((e) => e[1]).map((e) => Math.round(e[0] / 1000));
  assert.deepEqual(plain(on), [0, 1000, 2000]);
  assert.equal(C.runScenario(ch, 'clockOff').leds.LED1.summary, null);
  assert.equal(C.runScenario(ch, 'key').leds.LED1.ev.length, 3);
  assert.ok(C.runScenario(ch, 'keynaive').leds.LED1.ev.length > 5, '不消抖时会多次翻转');
});

test('USART：电脑收到 hello；BRR 错了收到乱码；不等 TXE 丢字节；回显；处理太慢溢出', () => {
  const ch = D.usart;
  assert.equal(C.runScenario(ch, 'hello').terminal, 'hello\nhello\nhello\n');
  assert.notEqual(C.runScenario(ch, 'baudBad').terminal.slice(0, 5), 'hello');
  assert.ok(C.runScenario(ch, 'txeBad').terminal.length < 6);
  assert.equal(C.runScenario(ch, 'echo').terminal, 'hi!');
  const slow = C.runScenario(ch, 'echoslow');
  assert.ok(slow.terminal.length < 6 && slow.log.some((x) => /ORE/.test(x.text)));
});

test('定时器：每秒翻转；不清 UIF 卡在中断；没 UG 第一次 0.14 ms 就来；PWM 极性', () => {
  const ch = D.tim;
  assert.deepEqual(plain(C.runScenario(ch, 'tim').leds.LED2.ev.filter((e) => e[0] > 0).map((e) => Math.round(e[0] / 1e5) / 10)), [1, 2, 3]);
  assert.equal(C.runScenario(ch, 'timNoClear').stop.kind, 'irq');
  assert.ok(C.runScenario(ch, 'ugNo').leds.LED2.ev.filter((e) => e[0] > 0)[0][0] < 200);
  assert.equal(C.runScenario(ch, 'nvic').leds.LED2.summary, null);
  const duty = (r) => { const ev = r.leds.LED2.ev; let on = 0; for (let i = 0; i < ev.length; i++) if (ev[i][1]) on += (i + 1 < ev.length ? ev[i + 1][0] : r.t) - ev[i][0]; return on / r.t; };
  assert.ok(Math.abs(duty(C.runScenario(ch, 'pwm')) - 0.2) < 0.03);
  assert.ok(Math.abs(duty(C.runScenario(ch, 'pwmHigh')) - 0.8) < 0.03);
});

test('ADC：2.0 V 读到约 2482；关掉 EXTTRIG 后 SWSTART 无效；先校准后上电卡死；忘了分频有警告', () => {
  const ch = D.adc, r = C.runScenario(ch, 'adc');
  const v = Number(/ADC =\s+(\d+)/.exec(r.printf)[1]);
  assert.ok(Math.abs(v - 2482) <= 3, v);
  assert.equal(C.runScenario(ch, 'trigBad').stop.kind, 'stuck');
  assert.equal(C.runScenario(ch, 'calfirst').stop.kind, 'stuck');
  assert.ok(C.runScenario(ch, 'adcSlow').log.some((x) => /14 MHz/.test(x.text)));
  assert.ok(/平均 = 248[0-4]/.test(C.runScenario(ch, 'avg').printf));
});

test('SPI：读到 EF4016；模式 1 读错；没设 SSM/SSI 触发 MODF；读数据', () => {
  const ch = D.spi;
  assert.ok(/EF4016/.test(C.runScenario(ch, 'id').printf));
  assert.ok(!/EF4016/.test(C.runScenario(ch, 'mode1').printf));
  const m = C.runScenario(ch, 'modf');
  assert.ok(m.log.some((x) => /MODF/.test(x.text)));
  assert.ok(/48 65 6C 6C/.test(C.runScenario(ch, 'read').printf));
});

test('模拟器：C 子集转 JS——字符、字符串、类型转换、无括号的 for 循环体', () => {
  const js = S.compile({ f: { sig: 'void f(const char *s)', lines: [{ c: "for (uint16_t i = 0; s[i] != '\\0'; i++)" }, { c: '    g((uint8_t)s[i]);' }, { c: 'x = 0x10u;' }] } });
  assert.ok(/for \(var i = 0; \(s\[i\] != 0\) && __tf\(\);/.test(js), js);
  assert.ok(/\n {4}g\(s\[i\]\);/.test(js), '循环体前不能插语句：' + js);
  assert.ok(/x = 0x10;/.test(js));
});

test('模拟器：外设没开时钟时写入无效并给出提示；空的 while(1) 正常结束', () => {
  const r = S.run({ fns: { main: { sig: 'int main(void)', lines: [{ c: 'GPIOA->ODR = 0;' }, { c: 'while (1) {' }, { c: '}' }] } } }, { ms: 10 });
  assert.equal(r.stop.kind, 'end');
  assert.ok(r.log.some((x) => /时钟还没开/.test(x.text)));
});
