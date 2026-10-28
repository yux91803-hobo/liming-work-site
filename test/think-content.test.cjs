/* 「编程思维」内容校验：结构完整、宏名真实存在、寄存器代码真跑一遍得到正确的值、链接都指向存在的资料 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.join(__dirname, '../site/tools/stm32');
const sb = { window: {} };
vm.createContext(sb);
['assets/registers.js', 'snippets.js', 'pins.js', 'assets/manual.js', 'assets/teach-arch/teach-arch.js', 'think.js'].forEach((f) => vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), sb));
const W = sb.window, T = W.STM32_THINK;

// 宏名 → 掩码（来自寄存器数据）；CNF9_1 这类取对应位
const MAC = {};
W.STM32_REGS.groups.forEach((g) => g.regs.forEach((r) => [r.fields, ...(r.alt || []).map((a) => a.fields)].forEach((fs2) => fs2.forEach((f) => {
  if (!f.cmsis) return;
  const w = f.bits[0] - f.bits[1] + 1, m = ((2 ** w - 1) * 2 ** f.bits[1]) >>> 0;
  MAC[f.cmsis] = m;
  for (let k = 0; k < w; k++) MAC[f.cmsis + '_' + k] = (2 ** (f.bits[1] + k)) >>> 0;
}))));
const HAL_OK_NAMES = /^(GPIO_PIN_\d+|GPIO_PIN_SET|GPIO_PIN_RESET|GPIO_MODE_\w+|GPIO_NOPULL|GPIO_PULLUP|GPIO_SPEED_FREQ_\w+|I2C_MEMADD_SIZE_8BIT|HAL_\w+)$/;

function codesOf(ch) {
  const out = [];
  ch.skel.steps.forEach((s) => { out.push(s.reg, s.hal); });
  ch.skel.program.forEach((p) => out.push(p.code));
  ch.tasks.forEach((t) => t.qs.forEach((q) => { if (q.type === 'parsons') out.push(...q.lines, ...q.extra.map((e) => e.t)); }));
  return out.filter(Boolean).map((s) => s.replace(/\/\*[\s\S]*?\*\//g, ''));
}

test('four-part chapters (GPIO, USART) with all four parts filled in; I2C moved to the derivation format', () => {
  assert.deepEqual([...T.chapters.map((c) => c.id)], ['gpio', 'usart']);
  const sk = T.SK.map((s) => s.id);
  T.chapters.forEach((c) => {
    assert.ok(c.why.length >= 4, c.id + ' why');
    assert.ok(c.skel.steps.length >= 4, c.id + ' skel');
    c.skel.steps.forEach((s) => { assert.ok(sk.includes(s.sk), c.id + ' sk ' + s.sk); assert.ok(s.why && s.skip && (s.reg || s.hal), c.id + ' step ' + s.title); });
    c.skel.program.forEach((p) => assert.ok(p.s === -1 || c.skel.steps[p.s], c.id + ' program maps to a step'));
    assert.ok(c.tasks.some((t) => t.kind === 'guided') && c.tasks.some((t) => t.kind === 'transfer'), c.id + ' tasks');
  });
});

test('every question is well-formed and every wrong answer explains itself', () => {
  const qs = [];
  T.chapters.forEach((c) => { c.why.forEach((w) => { if (w.q) qs.push([c.id, w.q]); }); c.tasks.forEach((t) => t.qs.forEach((q) => qs.push([c.id + '/' + t.id, q]))); });
  assert.ok(qs.length >= 25, 'question count ' + qs.length);
  qs.forEach(([where, q]) => {
    const tag = where + ': ' + q.q;
    if (q.type === 'choice') {
      assert.equal(q.opts.filter((o) => o.ok).length, 1, tag);
      q.opts.filter((o) => !o.ok).forEach((o) => assert.ok(o.why && o.why.length > 8, tag + ' / ' + o.t));
    } else if (q.type === 'order') {
      assert.ok(q.items.length >= 3, tag);
      q.items.forEach((it, i) => { assert.ok(it.hint, tag); if (i) assert.ok(it.rank >= q.items[i - 1].rank, tag + ' ranks ascending'); });
    } else if (q.type === 'fill') {
      assert.ok(q.answers.length && q.hints.length, tag);
    } else if (q.type === 'parsons') {
      assert.ok(q.lines.length >= 3, tag);
      q.extra.forEach((e) => { assert.ok(e.why, tag); assert.ok(!q.lines.includes(e.t), tag + ' distractor differs'); });
    } else assert.fail('unknown type ' + q.type + ' at ' + tag);
    assert.ok(q.explain, tag + ' explain');
  });
});

test('every register macro used in the code exists in the register data', () => {
  T.chapters.forEach((c) => codesOf(c).forEach((code) => {
    (code.match(/\b(?:RCC|GPIO|USART|I2C)_[A-Z0-9_]+\b/g) || []).forEach((m) => {
      if (HAL_OK_NAMES.test(m)) return;
      assert.ok(MAC[m] !== undefined, c.id + ': unknown macro ' + m + ' in ' + code);
    });
  }));
});

// 简易寄存器模拟：从复位值开始执行寄存器写法，检查结果
function machine() {
  const port = () => {
    const p = { CRL: 0x44444444, CRH: 0x44444444, ODR: 0, IDR: 0 };
    Object.defineProperty(p, 'BSRR', { set(v) { p.ODR = ((p.ODR | (v & 0xFFFF)) & ~(v >>> 16)) >>> 0; } });
    return p;
  };
  return { RCC: { APB2ENR: 0, APB1ENR: 0 }, GPIOA: port(), GPIOB: port(), GPIOF: port(), USART1: { SR: 0x80, DR: 0, BRR: 0, CR1: 0 }, I2C2: { CR1: 0, CR2: 0, CCR: 0, TRISE: 2 }, ...MAC };
}
function run(ctx, code) { vm.runInNewContext(code.replace(/->/g, '.'), ctx); return ctx; }
function regPart(ch, upto) { return ch.skel.steps.slice(0, upto).map((s) => s.reg).join('\n'); }

test('GPIO steps produce PA0 push-pull output, LED off, other pins untouched', () => {
  const c = T.chapters.find((x) => x.id === 'gpio'), m = run(machine(), regPart(c, 3));
  assert.ok(m.RCC.APB2ENR & MAC.RCC_APB2ENR_IOPAEN);
  assert.equal(m.GPIOA.CRL >>> 0, 0x44444443);
  assert.equal(m.GPIOA.ODR & 1, 1);
  run(m, 'GPIOA->ODR ^= GPIO_ODR_ODR0;'); assert.equal(m.GPIOA.ODR & 1, 0);
});

test('GPIO key task configures PF8 as pull-up input', () => {
  const q = T.chapters[0].tasks.find((t) => t.id === 'key').qs.find((x) => x.type === 'parsons');
  const setup = q.lines.filter((l) => !/while|^\s|^\}/.test(l)).join('\n');
  const m = run(machine(), setup);
  assert.equal(m.GPIOF.CRH & 0xF, 0x8);
  assert.equal((m.GPIOF.ODR >> 8) & 1, 1);
  assert.equal(m.GPIOA.CRL >>> 0, 0x44444443);
  assert.ok(m.RCC.APB2ENR & MAC.RCC_APB2ENR_IOPFEN);
});

test('USART steps give PA9 alternate push-pull, BRR 0x271 and an enabled transmitter', () => {
  const c = T.chapters.find((x) => x.id === 'usart'), m = run(machine(), regPart(c, 4));
  assert.equal((m.GPIOA.CRH >>> 4) & 0xF, 0xB);
  assert.equal(m.GPIOA.CRH >>> 0, 0x444444B4);
  assert.equal(m.USART1.BRR, 0x271);
  assert.equal(m.USART1.CR1 & (MAC.USART_CR1_UE | MAC.USART_CR1_TE), MAC.USART_CR1_UE | MAC.USART_CR1_TE);
  assert.ok(m.RCC.APB2ENR & MAC.RCC_APB2ENR_USART1EN);
  const div = 72e6 / (16 * 115200); assert.equal((Math.floor(div) << 4) | Math.round((div % 1) * 16), 0x271);
});

test('fill-in answers match the computed values', () => {
  const fills = {}; T.chapters.forEach((c) => c.tasks.forEach((t) => t.qs.forEach((q) => { if (q.type === 'fill') fills[c.id + '/' + t.id + '/' + q.answers[0]] = q; })));
  assert.ok(fills['gpio/blink/0011'] && fills['gpio/key/1000'] && fills['usart/hello/0x271']);
});

test('every link points at something that exists', () => {
  const regs = new Set(); W.STM32_REGS.groups.forEach((g) => g.regs.forEach((r) => regs.add(r.id)));
  const snips = new Set(W.STM32_SNIPPETS.map((s) => s.title));
  const figs = new Set([...W.STM32_MANUAL_FIGS, ...(W.STM32_TEACH_FIGS || [])].map((f) => f.id));
  const pins = new Set(W.STM32_PINS.map((p) => p[1])), nums = new Set(W.STM32_PINS.map((p) => p[0]));
  const links = [];
  T.chapters.forEach((c) => {
    c.why.forEach((w) => { if (w.fig) links.push({ fig: w.fig }); if (w.q && w.q.link) links.push(w.q.link); });
    c.skel.steps.forEach((s) => { if (s.link) links.push(s.link); });
    c.tasks.forEach((t) => t.qs.forEach((q) => { if (q.link) links.push(q.link); }));
  });
  links.forEach((l) => {
    if (l.reg) assert.ok(regs.has(l.reg), 'reg ' + l.reg);
    if (l.snip) assert.ok(snips.has(l.snip), 'snip ' + l.snip);
    if (l.fig) assert.ok(figs.has(l.fig), 'fig ' + l.fig);
    if (l.pin != null) assert.ok(typeof l.pin === 'number' ? nums.has(l.pin) : pins.has(l.pin), 'pin ' + l.pin);
  });
});
test('every question leaves a one-line conclusion for the reasoning chain', () => {
  T.chapters.forEach((c) => c.tasks.forEach((t) => {
    assert.ok(Array.isArray(t.gists) && t.gists.length === t.qs.length, c.id + '/' + t.id + ' gists ' + (t.gists || []).length + ' vs ' + t.qs.length);
    t.gists.forEach((g) => assert.ok(g.length >= 6 && /[。]$/.test(g), c.id + '/' + t.id + ': ' + g));
  }));
});
