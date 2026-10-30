/* labmap.js — 侧栏「硬件原理」：自绘的外设结构图，按块拆开讲
   路由：v=think&t=gpio|tim&hv=map&z=块&fn=用法（hv=why 是原来的「设计原理」推导链）
   一张图 = 一个外设。图分成几块（时钟、时基单元、输出比较……），一块讲一个知识点；
   图上的开关是使能位（置 1），方框是寄存器（写一个值），旁边的圆圈数字是初始化框架里的哪一步（① 开时钟 ② 配引脚 ③ 配外设 ④ 使能），「用」是用的时候才写。
   所以「初始化要写哪些寄存器」= 从时钟走到引脚，把图上带圆圈的都写一遍。
   图是自绘的，依据参考手册的框图，只保留讲解用到的部分；文字和寄存器列表在 lab-core.js 的 ch.map 里。
   编程思维「规划」也用这张图（不带讲解卡片，点框架里的一步，图上这一步的寄存器亮起来）。 */
(function () {
  'use strict';
  var STM = window.STM, ui = STM.ui, el = ui.el, L = window.STM32Lab;
  var NS = 'http://www.w3.org/2000/svg';
  var W = 1240, H = 560;
  var STEP = { 1: '①', 2: '②', 3: '③', 4: '④', 0: '用' };
  var STEPN = { 1: '开时钟', 2: '配引脚', 3: '配外设', 4: '使能', 0: '用的时候' };

  function sv(tag, a, p) { var e = document.createElementNS(NS, tag); for (var k in a) if (a[k] != null) e.setAttribute(k, a[k]); if (p) p.appendChild(e); return e; }
  function tx(g, x, y, s, cls, anchor) { var t = sv('text', { x: x, y: y, class: cls || 'm13', 'text-anchor': anchor || null }, g); t.textContent = s; return t; }
  function html(tag, cls, h) { var e = el(tag, cls); e.innerHTML = h; return e; }
  function stepsAttr(s) { return s == null ? null : [].concat(s).join(' '); }

  /* ---------- 画图的小零件 ---------- */
  function badge(g, cx, cy, s) {
    var b = sv('g', { class: 'mbg s' + s }, g);
    if (s === 0) { sv('rect', { x: cx - 11, y: cy - 9, width: 22, height: 18, rx: 5 }, b); tx(b, cx, cy + 4.5, '用', 'mbt', 'middle'); }
    else { sv('circle', { cx: cx, cy: cy, r: 9 }, b); tx(b, cx, cy + 4.5, String(s), 'mbt', 'middle'); }
    return b;
  }
  // 寄存器标签：圆圈（第几步）+ 文字；返回的 g 带 data-s，规划里按步高亮
  function lab(g, x, y, text, steps, o) {
    o = o || {};
    var k = sv('g', { class: 'mlab' + (o.cls ? ' ' + o.cls : ''), 'data-s': stepsAttr(steps) }, g), dx = 0;
    sv('rect', { class: 'mhl', x: x - 4, y: y - 16, width: 10, height: 22, rx: 5 }, k);
    [].concat(steps == null ? [] : steps).forEach(function (s) { badge(k, x + dx + (s === 0 ? 11 : 9), y - 4.5, s); dx += s === 0 ? 26 : 22; });
    var t = tx(k, x + dx, y, text, o.tcls || 'mreg');
    if (o.sub) tx(k, x + dx, y + 17, o.sub, 'msub');
    return k;
  }
  function box(g, x, y, w, h, t1, t2, t3, steps) {
    var k = sv('g', { class: 'mbox', 'data-s': stepsAttr(steps) }, g);
    sv('rect', { class: 'mb', x: x, y: y, width: w, height: h, rx: 6 }, k);
    var cx = x + w / 2, n = [t1, t2, t3].filter(function (s) { return s != null && s !== ''; }).length, y0 = y + h / 2 - (n - 1) * 9.5 + 5;
    [[t1, 'mt1'], [t2, 'mt2'], [t3, 'mval']].forEach(function (p) { if (p[0] == null || p[0] === '') return; tx(k, cx, y0, p[0], p[1], 'middle'); y0 += 19; });
    var bx = x + 9; [].concat(steps == null ? [] : steps).forEach(function (s) { badge(k, bx + (s === 0 ? 2 : 0), y - 13, s); bx += s === 0 ? 26 : 22; });
    return k;
  }
  function sw(g, x, y) {   // 开关：(x, y) 到 (x + 32, y)
    var k = sv('g', { class: 'msw' }, g);
    sv('path', { class: 'mswl', d: 'M' + x + ' ' + y + ' L' + (x + 25) + ' ' + (y - 14) }, k);
    sv('circle', { cx: x, cy: y, r: 3.5 }, k); sv('circle', { cx: x + 32, cy: y, r: 3.5 }, k);
    return k;
  }
  function line(g, d, cls, end) { return sv('path', { class: cls || 'ml', d: d, 'marker-end': end ? 'url(#' + end + ')' : null }, g); }
  function bolt(g, x, y) { sv('path', { class: 'mbolt', d: 'M' + (x + 6) + ' ' + y + ' L' + x + ' ' + (y + 12) + ' H' + (x + 5) + ' L' + (x + 2) + ' ' + (y + 22) + ' L' + (x + 12) + ' ' + (y + 8) + ' H' + (x + 7) + ' L' + (x + 10) + ' ' + y + ' Z' }, g); }
  function flag(g, x, y, w, h, s) { var k = sv('g', { class: 'mflag' }, g); sv('rect', { x: x, y: y, width: w, height: h, rx: 5 }, k); tx(k, x + w / 2, y + h / 2 + 5, s, 'mft', 'middle'); return k; }
  function zone(svg, M, id, r) {
    var z = M.zones.filter(function (q) { return q.id === id; })[0];
    var g = sv('g', { class: 'mz c-' + z.color, 'data-z': id }, svg);
    sv('rect', { class: 'mzr', x: r[0], y: r[1], width: r[2], height: r[3], rx: 14 }, g);
    tx(g, r[0] + 16, r[1] + 28, z.name, 'mzt');
    var note = tx(g, r[0] + 16 + z.name.length * 17 + 12, r[1] + 27, '', 'mzn');
    var inner = sv('g', { class: 'mzi' }, g);
    return { g: inner, root: g, note: note, r: r };
  }
  function defs(svg) {
    var d = sv('defs', {}, svg);
    [['ma', 'mar'], ['mo', 'maro']].forEach(function (m) {
      var k = sv('marker', { id: m[0], viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' }, d);
      sv('path', { d: 'M0 0 L10 5 L0 10 z', class: m[1] }, k);
    });
  }

  /* ---------- 定时器 ---------- */
  var TIMV = {
    pwm: { tim: 'TIM5', en: 'TIM5EN', psc: '71', arr: '999', irq: 'TIM5_IRQHandler' },
    tick: { tim: 'TIM6', en: 'TIM6EN', psc: '71', arr: '999', irq: 'TIM6_IRQHandler' }
  };
  function drawTim(svg, M, vr) {
    var V = TIMV[vr], pwm = vr === 'pwm', Z = {};
    // 时钟
    var c = Z.clk = zone(svg, M, 'clk', [12, 12, 214, 288]), g = c.g;
    box(g, 30, 50, 150, 46, 'RCC', 'AHB 72 MHz');
    line(g, 'M105 96 V114', 'ml', 'ma');
    box(g, 30, 116, 150, 46, 'APB1 预分频', '÷2 → 36 MHz');
    line(g, 'M78 162 V176', 'ml', 'ma');
    box(g, 30, 178, 96, 44, '×2', '72 MHz');
    line(g, 'M126 200 H138');
    sw(g, 138, 200);
    lab(g, 128, 248, 'APB1ENR', [1]); tx(g, 150, 265, '.' + V.en, 'mreg');
    line(g, 'M170 200 H232');
    // 时基单元（跨块的线两边各画一段，放大看某一块时也是连着的）
    var t = Z.tb = zone(svg, M, 'tb', [238, 12, 572, 288]); g = t.g;
    line(g, 'M228 200 H252', 'ml', 'ma');
    box(g, 254, 166, 132, 68, '预分频器', 'PSC', V.psc + ' → 1 MHz', [3]);
    line(g, 'M386 200 H402');
    sw(g, 402, 200);
    lab(g, 392, 178, 'CR1.CEN', [4]);
    line(g, 'M434 200 H488', 'mdat', 'mo');
    box(g, 490, 166, 130, 68, '计数器', 'CNT', '0 → ' + V.arr);
    box(g, 490, 52, 130, 68, '自动重装载', 'ARR', V.arr, [3]);
    line(g, 'M555 120 V164', 'ml', 'ma');
    bolt(g, 270, 82); lab(g, 290, 98, 'EGR.UG', [3], { sub: '立刻装载' });
    if (pwm) lab(g, 634, 80, 'CR1.ARPE', [3], { sub: 'ARR 预装载' });
    line(g, 'M620 200 H700');
    line(g, 'M555 234 V308', 'mdat');
    bolt(g, 700, 188); tx(g, 690, 176, '更新事件', 'm13', 'middle');
    line(g, 'M714 200 H818');
    // 中断
    var q = Z.irq = zone(svg, M, 'irq', [822, 12, 406, 288]); g = q.g;
    line(g, 'M814 200 H846', 'ml', 'ma');
    var cc = sv('g', { class: 'mghost' + (pwm ? '' : ' mnone') }, g);
    flag(cc, 846, 104, 60, 32, 'CCxIF'); line(cc, 'M906 120 H924'); sw(cc, 924, 120); tx(cc, 916, 96, 'DIER.CCxIE', 'mreg');
    line(cc, 'M956 120 H990 V164 H1004');
    flag(g, 846, 182, 60, 36, 'UIF');
    lab(g, 836, 172, 'SR.UIF', vr === 'tick' ? [3] : null);
    line(g, 'M906 200 H924'); sw(g, 924, 200);
    lab(g, 924, 180, 'DIER.UIE', vr === 'tick' ? [4] : null);
    line(g, 'M956 200 H1004');
    sv('path', { class: 'mb', d: 'M998 150 Q1020 182 998 214 Q1046 214 1062 182 Q1046 150 998 150 Z' }, g); tx(g, 1024, 187, '或', 'm13', 'middle');
    line(g, 'M1062 182 H1074'); sw(g, 1074, 182);
    lab(g, 1048, 150, 'NVIC 使能', vr === 'tick' ? [4] : null);
    line(g, 'M1106 182 H1140', 'ml', 'ma');
    box(g, 1142, 158, 70, 48, 'CPU');
    tx(g, 1214, 232, V.irq, 'mreg', 'end');
    line(g, 'M1177 240 V266 H876 V222', 'mloop', 'ma');
    lab(g, 940, 260, '中断函数里写 0 清 UIF', vr === 'tick' ? [0] : null, { tcls: 'm13' });
    // 输出比较
    var o = Z.oc = zone(svg, M, 'oc', [238, 312, 572, 236]); g = o.g;
    line(g, 'M555 304 V404', 'mdat', 'mo');
    box(g, 254, 396, 132, 68, '比较值', 'CCR2', pwm ? '0' : '', [3, 0]);
    lab(g, 254, 494, 'CCMR1.OC2PE', [3], { sub: 'CCR2 预装载' });
    line(g, 'M386 430 H531');
    sv('circle', { class: 'mb', cx: 555, cy: 430, r: 24 }, g); tx(g, 555, 436, '<', 'mt1', 'middle');
    tx(g, 555, 478, 'CNT < CCR2 ?', 'mreg', 'middle');
    line(g, 'M579 430 H594', 'ml', 'ma');
    box(g, 596, 396, 118, 68, '输出模式', 'CCMR1.OC2M', '110', [3]);
    line(g, 'M714 430 H726');
    sv('path', { class: 'mb', d: 'M726 418 L748 430 L726 442 Z' }, g); sv('circle', { class: 'mb', cx: 753, cy: 430, r: 5 }, g);
    lab(g, 690, 494, 'CCER.CC2P', [3], { sub: '1 = 低电平有效' });
    line(g, 'M758 430 H766'); sw(g, 766, 430);
    lab(g, 712, 404, 'CCER.CC2E', [3]);
    line(g, 'M798 430 H818');
    // 引脚
    var p = Z.pin = zone(svg, M, 'pin', [822, 312, 406, 236]); g = p.g;
    line(g, 'M814 430 H898', 'ml', 'ma');
    tx(g, 830, 422, 'TIM5_CH2', 'mreg');
    tx(g, 852, 396, 'ODR', 'mghostt'); line(g, 'M884 392 H898', 'mghostl');
    box(g, 900, 374, 122, 80, '复用推挽', 'CNF1 / MODE1', '10 / 11', [2]);
    line(g, 'M1022 414 H1040'); sv('rect', { class: 'mb', x: 1040, y: 406, width: 16, height: 16 }, g); tx(g, 1048, 444, 'PA1', 'mreg', 'middle');
    line(g, 'M1056 414 H1076');
    sv('path', { class: 'mb', d: 'M1100 402 L1076 414 L1100 426 Z' }, g); line(g, 'M1076 402 V426');
    line(g, 'M1100 414 H1112'); sv('rect', { class: 'mb', x: 1112, y: 407, width: 30, height: 14 }, g); line(g, 'M1142 414 H1158'); tx(g, 1162, 419, '3V3', 'm13');
    tx(g, 1088, 390, 'LED2', 'mt1', 'middle');
    sw(g, 846, 516); lab(g, 886, 521, 'APB2ENR.IOPAEN', [1], { sub: null });
    return Z;
  }

  /* ---------- GPIO ---------- */
  var GPV = {
    led: { port: 'GPIOA', en: 'IOPAEN', reg: 'CRL', bit: 0, cnf: '00', mode: '11', pin: 'PA0' },
    key: { port: 'GPIOF', en: 'IOPFEN', reg: 'CRH', bit: 8, cnf: '10', mode: '00', pin: 'PF8' }
  };
  function mos(g, x, top, bot, gy, p) {   // 竖着的 MOS 管：漏、源在 x，栅极从左边进
    line(g, 'M' + x + ' ' + top + ' V' + (gy - 14) + ' H' + (x - 12) + ' V' + (gy + 14) + ' H' + x + ' V' + bot);
    line(g, 'M' + (x - 18) + ' ' + (gy - 12) + ' V' + (gy + 12));
    if (p) sv('circle', { class: 'mb', cx: x - 23, cy: gy, r: 4 }, g);
  }
  function drawGpio(svg, M, vr) {
    var V = GPV[vr], key = vr === 'key', Z = {}, b = V.bit;
    // 时钟
    var c = Z.clk = zone(svg, M, 'clk', [12, 12, 222, 200]), g = c.g;
    box(g, 30, 52, 112, 46, 'RCC', 'APB2 72 MHz');
    line(g, 'M142 75 H156'); sw(g, 156, 75);
    lab(g, 30, 126, 'APB2ENR.' + V.en, [1]);
    line(g, 'M188 75 H204 V146', 'ml', 'ma');
    box(g, 30, 148, 190, 40, V.port + ' 的全部寄存器');
    // 端口配置
    var f = Z.cfg = zone(svg, M, 'cfg', [12, 224, 222, 324]); g = f.g;
    var k = sv('g', { class: 'mbox', 'data-s': '2' }, g);
    sv('rect', { class: 'mb', x: 30, y: 270, width: 186, height: 112, rx: 6 }, k);
    tx(k, 123, 294, V.reg + '（' + V.pin + ' 的 4 位）', 'mt2', 'middle');
    [['CNF' + b, V.cnf, 46], ['MODE' + b, V.mode, 126]].forEach(function (q) {
      sv('rect', { class: 'mcell', x: q[2], y: 308, width: 74, height: 56, rx: 4 }, k);
      tx(k, q[2] + 37, 328, q[0], 'mreg', 'middle'); tx(k, q[2] + 37, 352, q[1], 'mval', 'middle');
    });
    badge(k, 202, 288, 2);
    line(g, 'M216 300 H232 V230', 'mctl');
    tx(g, 30, 412, 'MODE：输入 / 输出、速度', 'm13'); tx(g, 30, 434, 'CNF：接哪种电路', 'm13');
    tx(g, 30, 470, key ? '上拉 / 下拉输入' : '通用推挽输出 50 MHz', 'mval');
    // 输出驱动
    var o = Z.out = zone(svg, M, 'out', [246, 12, 640, 260]); g = o.g;
    box(g, 266, 80, 120, 68, '位设置/清除', 'BSRR', key ? '' : 'BS' + b + ' / BR' + b, key ? null : [2, 0]);
    line(g, 'M386 114 H414', 'ml', 'ma');
    box(g, 416, 80, 110, 68, '输出数据', 'ODR', key ? '' : '第 ' + b + ' 位');
    line(g, 'M526 114 H566', 'ml', 'ma');
    box(g, 568, 60, 112, 168, '输出控制', key ? '' : '推挽');
    tx(g, 624, 42, '复用功能输出', 'mghostt', 'middle'); line(g, 'M624 46 V58', 'mghostl', 'ma');
    line(g, 'M232 230 H600 V228', 'mctl');
    tx(g, 252, 252, 'CNF、MODE 选：断开 / 推挽 / 开漏 / 复用', 'm13');
    tx(g, 776, 40, 'VDD', 'm13', 'middle'); line(g, 'M760 44 V58');
    mos(g, 760, 58, 140, 96, true); tx(g, 776, 100, 'P-MOS', 'mreg');
    mos(g, 760, 140, 222, 184, false); tx(g, 776, 188, 'N-MOS', 'mreg');
    line(g, 'M760 222 V236'); tx(g, 760, 252, 'VSS', 'm13', 'middle');
    line(g, 'M680 96 H736'); line(g, 'M680 184 H742');
    sv('circle', { cx: 760, cy: 140, r: 3.5, class: 'mdot' }, g);
    line(g, 'M760 140 H894');
    // 输入
    var n = Z.in = zone(svg, M, 'in', [246, 284, 640, 264]); g = n.g;
    line(g, 'M890 420 H846');
    sv('circle', { cx: 846, cy: 420, r: 3.5, class: 'mdot' }, g);
    // 上拉 / 下拉（各约 40 kΩ，CNF = 10 时接上，ODR 这一位选哪一个）
    line(g, 'M846 420 V396'); sv('rect', { class: 'mb', x: 839, y: 368, width: 14, height: 28 }, g); line(g, 'M846 368 V362'); sw(g, 846, 362).setAttribute('transform', 'rotate(-90 846 362)'); line(g, 'M846 330 V326'); tx(g, 846, 320, 'VDD', 'm13', 'middle');
    line(g, 'M846 420 V444'); sv('rect', { class: 'mb', x: 839, y: 444, width: 14, height: 28 }, g); line(g, 'M846 472 V478'); sw(g, 846, 478).setAttribute('transform', 'rotate(90 846 478)'); line(g, 'M846 510 V514'); tx(g, 846, 530, 'VSS', 'm13', 'middle');
    tx(g, 832, 388, '上拉', 'm13', 'end'); tx(g, 832, 466, '下拉', 'm13', 'end'); tx(g, 832, 484, '各约 40 kΩ', 'msub', 'end');
    lab(g, key ? 664 : 700, 344, key ? 'ODR' + b + ' = 1 选上拉' : 'ODR 选上拉 / 下拉', key ? [2] : null, { tcls: 'm13' });
    // 施密特触发器 → IDR
    line(g, 'M846 420 H758');
    sv('path', { class: 'mb', d: 'M758 398 L716 420 L758 442 Z' }, g);
    sv('path', { class: 'ml', d: 'M732 426 H740 V414 H748', 'stroke-width': 1.4 }, g);
    tx(g, 737, 466, '施密特触发器', 'm13', 'middle');
    line(g, 'M716 420 H642', 'ml', 'ma');
    box(g, 520, 386, 120, 68, '输入数据', 'IDR', key ? '第 ' + b + ' 位' : '', key ? [0] : null);
    line(g, 'M520 420 H452', 'ml', 'ma'); tx(g, 404, 425, 'CPU 读', 'm13', 'middle');
    tx(g, 600, 510, '复用功能输入', 'mghostt', 'middle'); line(g, 'M680 420 V496', 'mghostl', 'ma');
    tx(g, 776, 532, '模拟输入 → ADC', 'mghostt', 'end'); line(g, 'M796 420 V528 H780', 'mghostl', 'ma');
    // 引脚与外部电路
    var p = Z.pin = zone(svg, M, 'pin', [898, 12, 330, 536]); g = p.g;
    line(g, 'M890 140 H938 V266'); line(g, 'M938 294 V420 H886');
    sv('rect', { class: 'mb', x: 928, y: 266, width: 20, height: 28 }, g); tx(g, 938, 314, V.pin, 'mt1', 'middle');
    line(g, 'M948 280 H1080');
    // 保护二极管
    sv('circle', { cx: 990, cy: 280, r: 3.5, class: 'mdot' }, g);
    line(g, 'M990 280 V262'); sv('path', { class: 'mb', d: 'M980 262 L1000 262 L990 246 Z' }, g); line(g, 'M980 246 H1000'); line(g, 'M990 246 V232'); tx(g, 990, 226, 'VDD', 'm13', 'middle');
    line(g, 'M990 280 V298'); sv('path', { class: 'mb', d: 'M980 314 L1000 314 L990 298 Z' }, g); line(g, 'M980 298 H1000'); line(g, 'M990 314 V328'); tx(g, 990, 344, 'VSS', 'm13', 'middle');
    tx(g, 1004, 210, '保护二极管', 'msub');
    if (!key) {
      sv('path', { class: 'mb mled', d: 'M1104 268 L1080 280 L1104 292 Z' }, g); line(g, 'M1080 268 V292');
      line(g, 'M1104 280 H1120'); sv('rect', { class: 'mb', x: 1120, y: 273, width: 36, height: 14 }, g); line(g, 'M1156 280 H1172'); tx(g, 1176, 285, '3V3', 'm13');
      tx(g, 1092, 258, 'LED1', 'mt1', 'middle'); tx(g, 1138, 262, '2 kΩ', 'msub', 'middle');
      tx(g, 960, 470, '输出 0：电流流进引脚，亮', 'm13'); tx(g, 960, 494, '输出 1：两端都是 3.3 V，灭', 'm13');
    } else {
      line(g, 'M1080 280 H1096'); sv('circle', { class: 'mb', cx: 1096, cy: 280, r: 3 }, g);
      line(g, 'M1098 278 L1126 264'); sv('circle', { class: 'mb', cx: 1132, cy: 280, r: 3 }, g); line(g, 'M1110 260 V252 M1102 252 H1118');
      line(g, 'M1135 280 H1160 V300'); line(g, 'M1148 300 H1172 M1152 306 H1168 M1157 312 H1163');
      tx(g, 1114, 240, 'KEY1', 'mt1', 'middle');
      tx(g, 960, 470, '按下：引脚接地，读到 0', 'm13'); tx(g, 960, 494, '松开：没有外部上拉，', 'm13'); tx(g, 960, 516, '靠内部上拉读到 1', 'm13');
    }
    return Z;
  }
  var DRAW = { tim: drawTim, gpio: drawGpio };

  /* ---------- 小图：时基锯齿波、PWM、模式表、驱动表 ---------- */
  var MINI = {
    saw: function () {
      var s = sv('svg', { class: 'lm-wave', viewBox: '0 0 320 184', role: 'img', 'aria-label': 'CNT 从 0 数到 ARR 再回到 0，每次回 0 产生一次更新事件' });
      tx(s, 8, 18, 'CNT', 'w-l');
      line(s, 'M20 34 H312', 'w-arr'); tx(s, 312, 28, 'ARR', 'w-l w-c', 'end');
      line(s, 'M20 126 L90 34 V126 L160 34 V126 L230 34 V126 L300 34', 'w-saw');
      line(s, 'M20 132 H312', 'w-axis');
      [90, 160, 230].forEach(function (x) { bolt(s, x - 6, 138); });
      tx(s, 20, 180, '每回到 0 一次 = 一次更新事件', 'w-l');
      return s;
    },
    pwm: function () {
      var s = sv('svg', { class: 'lm-wave', viewBox: '0 0 320 236', role: 'img', 'aria-label': 'PWM 模式 1：CNT 小于 CCR2 时 OC2REF 有效；CC2P = 1 时 PA1 输出低电平，LED2 亮' });
      tx(s, 8, 16, 'CNT', 'w-l');
      line(s, 'M20 30 H312', 'w-arr'); tx(s, 312, 25, 'ARR', 'w-l', 'end');
      line(s, 'M20 76 H312', 'w-ccr'); tx(s, 312, 71, 'CCR2', 'w-l w-c', 'end');
      line(s, 'M20 110 L110 30 V110 L200 30 V110 L290 30 V110', 'w-saw');
      var cut = 90 * (34 / 80);   // CCR2 那条线和斜坡的交点
      tx(s, 8, 140, 'OC2REF', 'w-l');
      line(s, 'M20 152 H' + (20 + cut) + ' V176 H110 V152 H' + (110 + cut) + ' V176 H200 V152 H' + (200 + cut) + ' V176 H290 V152 H312', 'w-pin');
      tx(s, 8, 198, 'PA1（CC2P = 1）', 'w-l');
      line(s, 'M20 230 H' + (20 + cut) + ' V206 H110 V230 H' + (110 + cut) + ' V206 H200 V230 H' + (200 + cut) + ' V206 H290 V230 H312', 'w-pin');
      [20, 110, 200].forEach(function (x) { sv('rect', { class: 'w-lit', x: x, y: 206, width: cut, height: 24 }, s); tx(s, x + cut / 2, 223, '亮', 'w-l w-c', 'middle'); });
      return s;
    },
    modes: function (vr) {
      var t = el('table', 'lm-tbl'), on = vr === 'key' ? [0, 2] : [1, 0];
      t.innerHTML = '<caption>CNF × MODE（每个脚 4 位）</caption><thead><tr><th></th><th>CNF 00</th><th>01</th><th>10</th><th>11</th></tr></thead>';
      var tb = el('tbody');
      [['输入 MODE 00', ['模拟', '浮空', '上拉 / 下拉', '保留']], ['输出 MODE 01 / 10 / 11', ['推挽', '开漏', '复用推挽', '复用开漏']]].forEach(function (r, i) {
        var tr = el('tr'); tr.appendChild(el('th', null, r[0]));
        r[1].forEach(function (c, j) { var td = el('td', on[0] === i && on[1] === j ? 'on' : null, c); tr.appendChild(td); });
        tb.appendChild(tr);
      });
      t.appendChild(tb);
      var f = el('p', 'lm-tbl-n', '输出时 MODE 还是速度：01 = 10 MHz，10 = 2 MHz，11 = 50 MHz。');
      var w = el('div'); w.appendChild(t); w.appendChild(f); return w;
    },
    drive: function () {
      var t = el('table', 'lm-tbl');
      t.innerHTML = '<caption>输出 1 和 0 时两个管子</caption><thead><tr><th>ODR</th><th>推挽</th><th>开漏</th></tr></thead>' +
        '<tbody><tr><th>1</th><td class="on">P-MOS 导通 → 高</td><td>都不导通 → 悬空，靠外部上拉</td></tr>' +
        '<tr><th>0</th><td class="on">N-MOS 导通 → 低</td><td>N-MOS 导通 → 低</td></tr></tbody>';
      return t;
    }
  };

  /* =====================================================================
     结构图组件：opt.card = true 时下面带讲解卡片（硬件原理）；false 时只有图（编程思维 · 规划）
     ===================================================================== */
  function MapView(host, ch, opt) {
    opt = opt || {};
    var M = ch.map, app = opt.app, step = null, Z = {};
    var vr = M.variants.some(function (v) { return v.id === opt.vr; }) ? opt.vr : M.variants[0].id;
    var z = M.zones.some(function (q) { return q.id === opt.z; }) ? opt.z : null;
    var root = el('div', 'lm' + (opt.card ? '' : ' lm-plain')); host.appendChild(root);
    var bar = el('div', 'lm-bar');
    var vseg = el('div', 'lb-seg lm-vr'); vseg.setAttribute('role', 'group'); vseg.setAttribute('aria-label', '哪一种用法');
    M.variants.forEach(function (v) { var b = ui.btn('', v.label); b.dataset.k = v.id; b.addEventListener('click', function () { if (opt.onVariant) opt.onVariant(v.id); else set({ vr: v.id }); }); vseg.appendChild(b); });
    bar.appendChild(vseg); root.appendChild(bar);
    var sseg = null;
    if (opt.steps) {   // 规划：按初始化的步骤看，图上这一步要写的寄存器亮起来
      sseg = el('div', 'lm-steps'); sseg.setAttribute('role', 'group'); sseg.setAttribute('aria-label', '初始化的第几步');
      [1, 2, 3, 4, 0].forEach(function (k) {
        var b = ui.btn('lm-step'); b.dataset.s = k; b.appendChild(stepBadge(k)); b.appendChild(el('span', null, k === 0 ? '用' : STEPN[k]));
        b.addEventListener('click', function () { set({ step: step === k ? null : k }); });
        sseg.appendChild(b);
      });
      bar.appendChild(sseg);
    }
    var tabs = null;
    if (opt.card) {
      tabs = el('div', 'lm-tabs'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', '分块');
      [[null, '全图']].concat(M.zones.map(function (q) { return [q.id, q.name, q.color]; })).forEach(function (q) {
        var b = ui.btn('lm-tab' + (q[2] ? ' c-' + q[2] : ''), q[1]); b.setAttribute('role', 'tab'); b.dataset.z = q[0] || '';
        b.addEventListener('click', function () { pick(q[0]); });
        tabs.appendChild(b);
      });
      root.appendChild(tabs);
    }
    var body = el('div', 'lm-body'), figcol = el('div', 'lm-figcol');
    var scroller = el('div', 'lm-scroll'), svg = sv('svg', { class: 'lm-fig', viewBox: '0 0 ' + W + ' ' + H, role: 'img', 'aria-label': M.title }, null);
    scroller.appendChild(svg); figcol.appendChild(scroller);
    var miniBox = el('div', 'lm-minibox'); figcol.appendChild(miniBox);
    var src = el('p', 'lm-src', '自绘，不是手册原图。' + M.basis); figcol.appendChild(src);
    body.appendChild(figcol); root.appendChild(body);
    var card = opt.card ? el('div', 'lm-card') : null; if (card) { card.setAttribute('aria-live', 'polite'); body.appendChild(card); }
    var overview = null;
    if (tabs) {   // 放大看一块时，右上角一张小图：现在在哪一块
      overview = sv('svg', { class: 'lm-ov', viewBox: '0 0 ' + W + ' ' + H, 'aria-hidden': 'true' }, null);
      tabs.appendChild(overview);
    }

    function pick(id) { if (opt.onZone) opt.onZone(id); else set({ z: id }); }
    function variant() { return M.variants.filter(function (v) { return v.id === vr; })[0]; }
    function stateOf(id) { var v = variant(); return (v.none || []).indexOf(id) >= 0 ? 'none' : (v.idle || []).indexOf(id) >= 0 ? 'idle' : ''; }
    function draw() {
      ui.clear(svg); defs(svg);
      Z = DRAW[ch.id](svg, M, vr);
      Object.keys(Z).forEach(function (id) {
        var q = Z[id], st = stateOf(id);
        q.root.classList.toggle('mnone', st === 'none'); q.root.classList.toggle('midle', st === 'idle');
        q.note.textContent = st === 'none' ? (ch.id === 'tim' ? '基本定时器没有' : '') : st === 'idle' ? '这个任务不用' : '';
        q.root.addEventListener('click', function () { pick(id); });
      });
      fitLabels();
    }
    function fitLabels() {   // 标签后面的高亮底：等图挂到页面上量一下宽度
      var done = function () { Array.prototype.forEach.call(svg.querySelectorAll('.mlab'), function (k) { try { var r = k.querySelector('.mhl'), bb = k.getBBox(); r.setAttribute('x', bb.x - 5); r.setAttribute('y', bb.y - 3); r.setAttribute('width', bb.width + 10); r.setAttribute('height', bb.height + 6); } catch (e) {} }); };
      if (svg.isConnected) done(); else requestAnimationFrame(done);
    }
    function paint() {
      Array.prototype.forEach.call(vseg.children, function (b) { b.setAttribute('aria-pressed', String(b.dataset.k === vr)); });
      vseg.hidden = M.variants.length < 2;
      Object.keys(Z).forEach(function (id) { Z[id].root.classList.toggle('on', z === id); });
      svg.classList.toggle('focus', !!z);
      if (tabs) Array.prototype.forEach.call(tabs.children, function (b) { var on = (b.dataset.z || null) === z; b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1; });
      svg.classList.toggle('stepping', step != null);
      if (sseg) Array.prototype.forEach.call(sseg.children, function (b) { b.setAttribute('aria-pressed', String(step != null && Number(b.dataset.s) === step)); });
      Array.prototype.forEach.call(svg.querySelectorAll('[data-s]'), function (k) { k.classList.toggle('hot', step != null && (' ' + k.getAttribute('data-s') + ' ').indexOf(' ' + step + ' ') >= 0); });
      if (card) { paintCard(); paintMini(); paintOverview(); }
      fit();
    }
    function fit() {   // 选了一块：图放大到这一块（宽屏时讲解在右边）；没选：全图，窄屏横着滚
      var r = opt.card && z && Z[z] ? Z[z].r : null;
      root.classList.toggle('lm-zoom', !!r);
      if (r) {
        var vw = r[2] + 12, vh = r[3] + 12;
        svg.setAttribute('viewBox', (r[0] - 6) + ' ' + (r[1] - 6) + ' ' + vw + ' ' + vh);
        var w = figcol.clientWidth || 600;
        if (root.clientWidth < 720 && w < vw * 0.9) {   // 手机：按原大小的九成画，横着滑看
          svg.style.width = Math.round(vw * 0.9) + 'px'; svg.style.height = Math.round(vh * 0.9) + 'px';
        } else { svg.style.width = ''; svg.style.height = Math.round(Math.min(470, w * vh / vw)) + 'px'; }
      } else { svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H); svg.style.height = ''; svg.style.width = ''; }
    }
    function paintOverview() {
      if (!overview) return;
      ui.clear(overview);
      Object.keys(Z).forEach(function (id) {
        var r = Z[id].r, q = M.zones.filter(function (x) { return x.id === id; })[0];
        var g = sv('g', { class: 'c-' + q.color + (z === id ? ' on' : '') }, overview);
        sv('rect', { x: r[0] + 6, y: r[1] + 6, width: r[2] - 12, height: r[3] - 12, rx: 18 }, g);
        g.addEventListener('click', function () { pick(id); });
      });
      overview.style.display = z ? '' : 'none';
    }
    function paintMini() {
      ui.clear(miniBox);
      var q = z ? M.zones.filter(function (x) { return x.id === z; })[0] : null;
      if (opt.card && q && q.mini && MINI[q.mini] && stateOf(q.id) !== 'none') miniBox.appendChild(MINI[q.mini](vr));
    }
    function regsOf(q) { return ((q.regs || {})[vr]) || []; }
    function regLi(r, q) {
      var li = el('li'), b = ui.btn('lm-reg');
      b.appendChild(stepBadge(r.s)); b.appendChild(el('code', 'lm-rn', r.n));
      if (r.v !== '') b.appendChild(el('code', 'lm-rv', r.v === '读' ? '读' : '= ' + r.v));
      b.appendChild(el('span', 'lm-rw', r.why));
      li.appendChild(b);
      if (r.id && STM.labprog) {
        b.setAttribute('aria-expanded', 'false');
        b.addEventListener('click', function () {
          var open = li.querySelector('.lp-doc');
          if (open) { open.remove(); b.setAttribute('aria-expanded', 'false'); return; }
          var pane = STM.labprog.DocPane(li, app, ch), d = r.doc && ch.docs[r.doc] ? r.doc : { kind: 'reg', id: r.id, f: String(r.f).split(',') };
          pane.show(d, { noMap: true }); b.setAttribute('aria-expanded', 'true');
        });
      }
      return li;
    }
    function stepBadge(s) { var b = el('span', 'lm-b s' + s, s === 0 ? '用' : String(s)); b.title = s === 0 ? '用的时候才写' : '初始化第 ' + s + ' 步：' + STEPN[s]; return b; }
    function paintCard() {
      ui.clear(card);
      var q = z ? M.zones.filter(function (x) { return x.id === z; })[0] : null;
      card.className = 'lm-card' + (q ? ' c-' + q.color : ' lm-all');
      if (!q) { paintAll(); return; }
      var st = stateOf(q.id), main = el('div', 'lm-cm');
      main.appendChild(el('h2', 'lm-ch', q.name));
      if (st === 'none') { main.appendChild(el('p', 'lm-lead', q.noneText || '')); card.appendChild(main); nav(q); return; }
      var lead = typeof q.lead === 'object' ? q.lead[vr] : q.lead;
      main.appendChild(html('p', 'lm-lead', lead));
      if (q.formula) { var fx = el('div', 'lm-fx'); q.formula.forEach(function (f) { fx.appendChild(el('span', null, f)); }); main.appendChild(fx); }
      var rs = regsOf(q);
      main.appendChild(el('h3', 'lm-h3', '要写的寄存器'));
      if (st === 'idle') main.appendChild(el('p', 'lm-none', q.idleText || '这个任务不写这一块的寄存器。'));
      else if (!rs.length) main.appendChild(el('p', 'lm-none', '这一块不用写寄存器。'));
      else { var ul = el('ul', 'lm-regs'); rs.forEach(function (r) { ul.appendChild(regLi(r, q)); }); main.appendChild(ul); }
      main.appendChild(el('h3', 'lm-h3', '要点'));
      var pts = el('ul', 'lm-pts'); q.points.forEach(function (p) { pts.appendChild(html('li', null, p)); }); main.appendChild(pts);
      card.appendChild(main);
      nav(q);
    }
    function nav(q) {
      var i = M.zones.indexOf(q), n = el('div', 'lm-nav');
      if (i > 0) { var a = ui.btn('lab-nav'); a.appendChild(ui.icon('back')); a.appendChild(el('span', null, M.zones[i - 1].name)); a.addEventListener('click', function () { pick(M.zones[i - 1].id); }); n.appendChild(a); }
      else { var all = ui.btn('lab-nav'); all.appendChild(ui.icon('back')); all.appendChild(el('span', null, '全图')); all.addEventListener('click', function () { pick(null); }); n.appendChild(all); }
      if (i < M.zones.length - 1) { var b = ui.btn('lab-nav lab-next'); b.appendChild(el('span', null, M.zones[i + 1].name)); b.appendChild(ui.icon('next')); b.addEventListener('click', function () { pick(M.zones[i + 1].id); }); n.appendChild(b); }
      card.appendChild(n);
    }
    function paintAll() {
      var lg = el('ul', 'lm-legend');
      [['sw', '开关 = 使能位，写 1 打开'], ['bx', '方框 = 寄存器，写一个值'], ['bo', '闪电 = 事件'], ['fl', '红框 = 标志位：硬件置 1，软件清 0'], ['st', '圆圈数字 = 初始化的第几步；「用」= 用的时候才写']].forEach(function (x) {
        var li = el('li'), ic = sv('svg', { class: 'lm-lg', viewBox: '0 0 48 24', 'aria-hidden': 'true' });
        if (x[0] === 'sw') sw(ic, 8, 17);
        if (x[0] === 'bx') { sv('rect', { class: 'mb', x: 4, y: 2, width: 40, height: 20, rx: 4 }, ic); tx(ic, 24, 17, '71', 'mval', 'middle'); }
        if (x[0] === 'bo') bolt(ic, 18, 1);
        if (x[0] === 'fl') flag(ic, 4, 2, 40, 20, 'UIF');
        if (x[0] === 'st') { badge(ic, 12, 12, 3); badge(ic, 35, 12, 0); }
        li.appendChild(ic); li.appendChild(el('span', null, x[1])); lg.appendChild(li);
      });
      var left = el('div', 'lm-cm'); left.appendChild(el('h2', 'lm-ch', '图例')); left.appendChild(lg);
      var right = el('div', 'lm-cm'); right.appendChild(el('h2', 'lm-ch', '初始化顺序'));
      right.appendChild(initList(true));
      card.appendChild(left); card.appendChild(right);
    }
    function initList(click) {
      var ol = el('ol', 'lm-init');
      [1, 2, 3, 4, 0].forEach(function (s) {
        var items = [];
        M.zones.forEach(function (q) { if (stateOf(q.id)) return; regsOf(q).forEach(function (r) { if (r.s === s) items.push([r, q]); }); });
        var li = el('li'); li.appendChild(stepBadge(s)); li.appendChild(el('b', 'lm-in', s === 0 ? '用' : STEPN[s]));
        var box = el('span', 'lm-irs');
        if (!items.length) box.appendChild(el('span', 'lm-none', ch.id === 'gpio' && s >= 3 ? 'GPIO 没有这一步' : '—'));
        items.forEach(function (it) {
          var t = click ? ui.btn('lm-chip c-' + it[1].color, it[0].n) : el('span', 'lm-chip c-' + it[1].color, it[0].n);
          if (click) t.addEventListener('click', function () { pick(it[1].id); });
          box.appendChild(t);
        });
        li.appendChild(box); ol.appendChild(li);
      });
      return ol;
    }
    function set(o) {
      var redraw = false;
      if (o.vr && o.vr !== vr && M.variants.some(function (v) { return v.id === o.vr; })) { vr = o.vr; redraw = true; }
      if ('z' in o) z = o.z && M.zones.some(function (q) { return q.id === o.z; }) ? o.z : null;
      if ('step' in o) step = o.step;
      if (redraw) draw();
      paint();
    }
    var onResize = ui.debounce ? ui.debounce(fit, 120) : fit;
    window.addEventListener('resize', onResize);
    draw(); paint();
    return {
      el: root, set: set, initList: initList,
      vr: function () { return vr; },
      destroy: function () { window.removeEventListener('resize', onResize); root.remove(); }
    };
  }

  /* =====================================================================
     硬件原理：结构图（按块讲）/ 设计原理（原来的推导链）
     ===================================================================== */
  function hwChapter(root, route, app) {
    var ch = L.chapter(route.t), t = STM.model.topicById[ch.topic], wrap = el('div', 'labp hwp lab-wide'), mode = null, inner = null, map = null;
    root.appendChild(wrap);
    var head = el('header', 'lab-head'), h1 = el('h1', null, (t ? t.code : ch.id.toUpperCase()) + '：硬件原理');
    var tabs = el('nav', 'lab-tabs'); tabs.setAttribute('aria-label', '看哪一部分');
    [['map', '结构图'], ['why', '设计原理']].forEach(function (x) {
      var a = app.link({ v: 'think', t: ch.id, hv: x[0] }, 'lab-tab'); a.dataset.hv = x[0]; a.appendChild(el('span', null, x[1])); tabs.appendChild(a);
    });
    var toProg = app.link({ v: 'lab', t: ch.id, st: 'plan' }, 'hw-prog'); toProg.appendChild(el('span', null, '编程思维')); toProg.appendChild(ui.icon('next'));
    head.appendChild(h1); head.appendChild(tabs); head.appendChild(toProg); wrap.appendChild(head);
    var body = el('div', 'hw-body'); wrap.appendChild(body);
    function modeOf(r) { return r.hv === 'why' ? 'why' : r.hv === 'map' || r.hv === 'run' ? 'map' : r.s ? 'why' : 'map'; }
    function paint(r) {
      var m = modeOf(r);
      Array.prototype.forEach.call(tabs.children, function (a) { var on = a.dataset.hv === m; a.classList.toggle('on', on); if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
      if (m === mode) { if (m === 'why' && inner && inner.update) inner.update(r); if (m === 'map' && map) map.set({ vr: r.fn, z: r.z || null }); return; }
      if (inner && inner.destroy) inner.destroy(); if (map) map.destroy();
      inner = null; map = null; ui.clear(body); mode = m;
      wrap.classList.toggle('lab-wide', m === 'map');
      if (m === 'why') { inner = STM.derive.view(body, r, app); return; }
      map = MapView(body, ch, {
        app: app, card: true, vr: r.fn, z: r.z || null,
        onZone: function (id) { app.update({ z: id || null }); },
        onVariant: function (v) { app.update({ fn: v }); }
      });
    }
    paint(route);
    return {
      title: function (r) { return (t ? t.code : '') + ' · 硬件原理' + (modeOf(r) === 'why' ? ' · 设计原理' : ''); },
      update: function (r) { var was = mode; paint(r); if (was !== mode) window.scrollTo(0, 0); },
      destroy: function () { if (inner && inner.destroy) inner.destroy(); if (map) map.destroy(); }
    };
  }

  STM.lab = { hasHw: function (id) { var c = L.chapter(id); return !!(c && c.map); }, hwView: hwChapter, MapView: MapView, STEP: STEP, STEPN: STEPN };
})();
