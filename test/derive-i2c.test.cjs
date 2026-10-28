/* 「编程思维」I2C 推导章节：内容自洽、每一行代码可追溯、寄存器值和模拟结果都对 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.join(__dirname, '../site/tools/stm32');
const sb = { window: {} };
vm.createContext(sb);
['assets/registers.js', 'pins.js', 'assets/manual.js', 'assets/teach-arch/teach-arch.js', 'assets/assets.js', 'i2csim.js', 'derive-core.js', 'derive-i2c.js']
  .forEach((f) => vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), sb, { filename: f }));
const plain = (x) => JSON.parse(JSON.stringify(x));
const W = sb.window, C = W.STM32DeriveCore, ch = W.STM32_DERIVE.i2c, Sim = W.STM32I2CSim;

const MAC = {};
W.STM32_REGS.groups.forEach((g) => g.regs.forEach((r) => r.fields.forEach((f) => {
  if (!f.cmsis) return;
  const w = f.bits[0] - f.bits[1] + 1, m = ((2 ** w - 1) * 2 ** f.bits[1]) >>> 0;
  MAC[f.cmsis] = m;
  for (let k = 0; k < w; k++) MAC[f.cmsis + '_' + k] = (2 ** (f.bits[1] + k)) >>> 0;
})));

test('内容自检通过：引用、结论、题目、规则、场景都存在且合法', () => {
  assert.deepEqual(plain(C.validate(ch)), []);
});

test('推导链完整：每一环都有问题、正文、结论和下一个问题，每一环至少停下来问一次', () => {
  const asks = C.allAsks(ch), per = {};
  Object.values(asks).forEach((a) => { per[a.stepId] = (per[a.stepId] || 0) + 1; });
  ch.steps.forEach((s, i) => {
    assert.ok(s.q && s.gist && s.beats.length >= 4, s.id);
    if (i < ch.steps.length - 1) assert.ok(s.next, s.id + ' next');
    if (i > 0) assert.ok(s.from, s.id + ' 没写这个问题从哪来');
    assert.ok(per[s.id] >= 1, s.id + ' 没有提问');
  });
  assert.ok(ch.steps.length >= 20);
  assert.ok(Object.keys(asks).length >= 30, 'asks ' + Object.keys(asks).length);
});

test('用户列出的开漏十个疑问都在推导里有落点', () => {
  const text = (id) => JSON.stringify(ch.steps.find((s) => s.id === id));
  const all = ['s3', 's4', 's5', 's6'].map(text).join('');
  ['推挽', '短路', 'P-MOS', 'N-MOS', '高阻', '1 从哪里来', '上拉', '直接', '阻值', '松手'].forEach((k) => assert.ok(all.includes(k) || all.includes(k.replace(' ', '')), '缺：' + k));
});

test('每个结论都在某一环被推出来，而且被后面的环或代码用到', () => {
  const used = new Set();
  ch.steps.forEach((s) => (s.uses || []).forEach((f) => used.add(f)));
  Object.values(ch.fns).forEach((fn) => fn.lines.forEach((l) => (l.from || []).forEach((f) => used.add(f))));
  Object.keys(ch.facts).forEach((f) => {
    assert.ok(ch.steps.find((s) => s.id === ch.facts[f].from).makes.includes(f), f + ' 没在出处里 makes');
    assert.ok(used.has(f), f + ' 推出来以后没人用');
  });
});

test('每一行会动引脚的代码都写了理由和出处', () => {
  Object.entries(ch.fns).forEach(([name, fn]) => fn.lines.forEach((l, i) => {
    const acts = l.op && l.op.some((o) => o[0] !== 'ret');
    if (acts || l.loop) { assert.ok(l.why && l.why.length > 6, name + ':' + i + ' why'); assert.ok(l.from && l.from.length, name + ':' + i + ' from'); }
  }));
});

test('代码里的寄存器宏都真实存在；i2c_init 得到 CRH = 0x44447744，并且先置 1 再切换成输出', () => {
  const fn = ch.fns.i2c_init, src = fn.pre.concat(fn.lines).map((l) => l.c).join('\n');
  (src.match(/\b(?:RCC|GPIO)_[A-Z0-9_]+\b/g) || []).forEach((m) => assert.ok(MAC[m] !== undefined, '未知宏 ' + m));
  const port = { CRL: 0x44444444, CRH: 0x44444444, ODR: 0, IDR: 0 }, log = [];
  Object.defineProperty(port, 'BSRR', { set(v) { port.ODR = ((port.ODR | (v & 0xFFFF)) & ~(v >>> 16)) >>> 0; } });
  let crh = 0x44444444;
  Object.defineProperty(port, 'CRH', { get() { return crh; }, set(v) { log.push(port.ODR); crh = v >>> 0; } });
  const ctx = { RCC: { APB2ENR: 0 }, GPIOB: port, ...MAC };
  const macros = fn.pre.map((l) => l.c.replace(/\/\*.*?\*\//, '').replace(/^#define (\w+)\(\)\s+(.*)$/, 'function $1(){ return $2; }')).filter((l) => /^function/.test(l)).join('\n');
  vm.runInNewContext((macros + '\n' + fn.lines.map((l) => l.c).join('\n')).replace(/->/g, '.').replace(/Delay_us\(\d+\)/, '0'), ctx);
  assert.ok(ctx.RCC.APB2ENR & MAC.RCC_APB2ENR_IOPBEN);
  assert.equal(crh, 0x44447744);
  assert.equal(log[0] & 0x0C00, 0x0C00, '切换成输出时 ODR10/11 应该已经是 1');
  // 题目里的答案和计算一致
  assert.ok(C.allAsks(ch)['s18-c'].answers.includes('0x44447744'));
});

test('参考程序在模拟器里：写入成功、时序满足标准模式、读得回来', () => {
  const w = C.runScenario(ch, 'write');
  assert.equal(w.results[0].ret, 0);
  assert.equal(w.watch[0].v, 0x5A);
  assert.deepEqual(plain(w.desc), ['起始', '地址 0xA0（7 位地址 0x50，写）', '应答', '写 0x12', '应答', '写 0x5A', '应答', '停止']);
  w.timing.forEach((t) => assert.ok(t.ok, t.k + ' ' + t.min));
  const r = C.runScenario(ch, 'writeread');
  assert.equal(r.results[1].out, 0x5A);
  r.timing.forEach((t) => assert.ok(t.ok, t.k + ' ' + t.min));
  assert.ok(r.desc.includes('重复起始'));
});

test('反例场景都能演示出问题', () => {
  assert.equal(C.runScenario(ch, 'nodev').results[0].ret, 1);
  const fake = C.runScenario(ch, 'fakeack');
  assert.equal(fake.results[0].ret, 0, '忘了松手：没有 EEPROM 也以为成功');
  assert.ok(fake.ev.filter((e) => e.k === 'A').every((e) => e.by === 'm'));
  const busy = C.runScenario(ch, 'busyNow');
  assert.equal(busy.results[1].ret, 1, '写完立刻读应收到非应答');
  assert.ok(!C.runScenario(ch, 'readack').desc.includes('停止'), '最后回 ACK 时停止发不出去');
  const bad = C.runScenario(ch, 'validBad');
  assert.ok(bad.ev.some((e) => e.k === 'P'), 'SCL 高时改 SDA 被当成停止');
});

test('交换任意一条规则两端的代码行：要么在模拟器里出现可见的差别，要么给出了说明', () => {
  Object.entries(ch.fns).forEach(([name, fn]) => (fn.rules || []).forEach((r) => {
    const x = C.swapCheck(ch, name, r.a, r.b);
    if (x.same || x.nosim) return;
    assert.ok(x.broken.includes(r) || x.broken.some((b) => b.a === r.a && b.b === r.b), name + ' 规则没被识别为破坏');
    assert.ok(x.diff.length || r.simNote, name + ' ' + r.a + '<' + r.b + ' 交换后看不出区别也没有说明');
  }));
  // 课件的停止顺序：空报文
  const s = C.swapCheck(ch, 'i2c_stop', 0, 2);
  assert.ok(s.got.desc.some((d) => /空报文/.test(d)));
  // 停止里先松 SDA 再抬 SCL：EEPROM 没写进去
  const s2 = C.swapCheck(ch, 'i2c_stop', 2, 4);
  assert.equal(s2.got.watch[0].v, 0xFF);
});

test('排序题：标准顺序通过，相同的行可以互换，违反因果关系会指出是哪条规则', () => {
  const asks = C.allAsks(ch);
  Object.values(asks).filter((a) => a.type === 'order').forEach((a) => {
    const it = C.orderItems(ch, a), n = it.texts.length;
    assert.ok(C.checkOrder(it.texts, [...Array(n).keys()], it.rules).ok, a.id);
  });
  const st = C.orderItems(ch, asks['s19-so']);
  // 两个 I2C_DELAY 互换仍然算对
  const d = it2 => it2.map((t, i) => i);
  const ord = d(st.texts); const i1 = st.texts.indexOf('I2C_DELAY();'), i2 = st.texts.indexOf('I2C_DELAY();', i1 + 1);
  [ord[i1], ord[i2]] = [ord[i2], ord[i1]];
  assert.ok(C.checkOrder(st.texts, ord, st.rules).ok);
  // 先抬 SCL 再抬 SDA：违反规则 0<2
  const bad = d(st.texts); [bad[0], bad[2]] = [bad[2], bad[0]];
  const r = C.checkOrder(st.texts, bad, st.rules);
  assert.equal(r.ok, false);
  assert.equal(r.rule.back, 's8');
  // 写一个字节的事件顺序：存储地址和数据对调
  const ev = C.orderItems(ch, asks['s16-o']), o2 = d(ev.texts); [o2[3], o2[5]] = [o2[5], o2[3]];
  assert.equal(C.checkOrder(ev.texts, o2, ev.rules).ok, false);
});

test('排序题（代码）：子序列换回整个函数后能跑', () => {
  const a = C.allAsks(ch)['s20-ao'], it = C.orderItems(ch, a);
  const order = [...it.sub.keys()]; [order[0], order[4]] = [order[4], order[0]];   // 先读再松手
  const patch = { i2c_wait_ack: C.orderToPatch(it.fn, it.sub, order) };
  const got = C.runScenario(ch, 'nodev', { patch });
  assert.equal(got.results[0].ret, 0, '先读后松手：没有器件也读到应答');
});

test('常卡的地方：按推理出错的那一环归类，复习答对两次后移走', () => {
  const st = {}, t0 = Date.UTC(2026, 9, 28);
  C.recordMiss(st, 's10-a', 's5', '0 和 1 是对称的', t0);
  C.recordMiss(st, 's10-a', 's5', '0 和 1 是对称的', t0);
  C.recordMiss(st, 's4-a', 's4', '写 1 就等于输出高电平', t0);
  const list = C.stuckList(ch, st, t0);
  assert.equal(list[0].step, 's10');
  assert.equal(C.rootCauses(ch, st)[0].step, 's5');
  assert.deepEqual(plain(st.wrong['s10-a']), ['0 和 1 是对称的']);
  C.recordReview(st, 's10-a', true, t0);
  assert.ok(st.miss['s10-a'] && st.due['s10-a'] > t0, '答对一次：隔一天再问');
  assert.equal(C.dueCount(ch, st, t0), 1);
  C.recordReview(st, 's10-a', true, t0 + 864e5);
  assert.equal(st.miss['s10-a'], undefined);
  C.recordReview(st, 's4-a', false, t0);
  assert.equal(st.miss['s4-a'], 2);
});

test('行内标记解析', () => {
  assert.deepEqual(plain(C.inline('看 [[s5]] 和 {F1}：**线与**，`SDA_H()`')), [
    { t: '看 ' }, { step: 's5' }, { t: ' 和 ' }, { fact: 'F1' }, { t: '：' }, { b: '线与' }, { t: '，' }, { code: 'SDA_H()' }]);
});

test('笔记里需要更正的地方都在正文里讲到了', () => {
  const all = JSON.stringify(ch.steps);
  assert.ok(all.includes('3.4 Mbit/s') && all.includes('5.4 Mbit/s'), '速率档位的更正');
  assert.ok(all.includes('写 1 = 松手'), '开漏写 1 的含义');
  assert.ok(all.includes('E2 E1 E0'), 'E 引脚的位顺序');
  assert.ok(all.includes('112'), '7 位地址可用数量');
  assert.ok(all.includes('**不等于**回到空闲状态'), '释放 SDA ≠ 回到空闲');
});

test('模拟器解码与描述在推导用到的地址上一致', () => {
  assert.equal(Sim.hx(0x50 << 1), 'A0');
  const e = C.runScenario(ch, 'read');
  assert.ok(e.desc.includes('地址 0xA1（7 位地址 0x50，读）'));
});
