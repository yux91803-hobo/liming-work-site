/* labview.js — 侧栏「编程思维」模块
   路由：v=lab（章节列表）；v=lab&t=gpio&st=need|hw|fn|h|c|self（某一章的某一步）；fn=…（.c / 自己写 里选哪个函数）
   .c 那一步的图：上半张按参考手册「系统结构」画，下半张每个引脚一张「端口位·输出配置」，右边是板子上的 LED。
   点一行代码 → 信号点从 Cortex-M3 出发，沿总线走到 GPIOA、走进端口位、走到引脚和 LED；读回来的时候反着走（蓝色）。
   动画只是把 lab-core.js 算好的「这一行前后的芯片状态」演出来。 */
(function () {
  'use strict';
  var STM = window.STM, ui = STM.ui, el = ui.el, L = window.STM32Lab;
  var NS = 'http://www.w3.org/2000/svg';
  var STAGES = [['need', '需求'], ['hw', '硬件'], ['fn', '拆函数'], ['h', '.h'], ['c', '.c'], ['self', '自己写']];
  var SKEY = 'lm.stm.lab.';
  function sv(tag, attrs, parent) { var e = document.createElementNS(NS, tag); for (var k in attrs) if (attrs[k] != null) e.setAttribute(k, attrs[k]); if (parent) parent.appendChild(e); return e; }
  function tx(g, x, y, s, cls, anchor, rot) { var t = sv('text', { x: x, y: y, class: cls || 't15', 'text-anchor': anchor || 'start', transform: rot ? 'rotate(' + rot + ' ' + x + ' ' + y + ')' : null }, g); t.textContent = s; return t; }
  function html(tag, cls, h) { var e = el(tag, cls); e.innerHTML = h; return e; }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function isOut(m) { return m === 'pp' || m === 'od' || m === 'afpp' || m === 'afod'; }
  function derive(p) { p.level = p.mode === 'pp' ? p.odr : p.mode === 'od' ? (p.odr ? 'z' : 0) : 'z'; return p; }
  function seen(ch) { var o = {}; try { o = JSON.parse(ui.lsGet(SKEY + ch + '.seen') || '{}') || {}; } catch (e) {} return o; }
  function markSeen(ch, st) { var o = seen(ch); if (o[st]) return; o[st] = 1; ui.lsSet(SKEY + ch + '.seen', JSON.stringify(o)); }

  /* =====================================================================
     图 + 动画
     ===================================================================== */
  function Lab(host, ch) {
    var reduce = ui.reduced();
    var N = ch.pins.length, OY0 = 640, STEP = 288, H = OY0 + N * STEP - 8;
    var PORT = {}; ch.pins.forEach(function (p, i) { PORT[p.key] = { ox: 15, oy: OY0 + i * STEP, label: p.label, color: p.color }; });
    var keys = ch.pins.map(function (p) { return p.key; });
    var GY = 544;   // APB2 列表里 GPIOA 那一行

    var root = el('div', 'lb'), chipsBox = el('div', 'lb-chips'), grid = el('div', 'lb-grid');
    var codep = el('section', 'lb-codep'), hwp = el('section', 'lb-hwp');
    var ctxBox = el('div', 'lb-ctx lb-term'), codeBox = el('div', 'lb-code lb-term'), exp = el('div', 'lb-exp');
    codeBox.setAttribute('role', 'list'); exp.setAttribute('aria-live', 'polite');
    codep.setAttribute('aria-label', '代码'); hwp.setAttribute('aria-label', '硬件');
    codep.appendChild(ctxBox); codep.appendChild(codeBox); codep.appendChild(exp);
    var hwh = el('div', 'lb-hwh'), views = el('div', 'lb-seg'); views.setAttribute('role', 'group'); views.setAttribute('aria-label', '看哪里');
    var vFollow = ui.btn('', '跟着信号'), vAll = ui.btn('', '全图');
    views.appendChild(vFollow); views.appendChild(vAll); hwh.appendChild(views);
    var stage = el('div', 'lb-stage'), svg = sv('svg', { class: 'lb-fig', viewBox: '0 0 1000 620', preserveAspectRatio: 'xMidYMid meet', role: 'img', 'aria-label': 'Cortex-M3 经总线到 GPIOA、引脚、LED 的信号路线' });
    stage.appendChild(svg);
    var wave = sv('svg', { class: 'lb-wave', viewBox: '0 0 1000 ' + (24 + N * 30), role: 'img', 'aria-label': '引脚电平随时间的变化' });
    hwp.appendChild(hwh); hwp.appendChild(stage); hwp.appendChild(wave);
    grid.appendChild(codep); grid.appendChild(hwp);
    var ctl = el('div', 'lb-ctl');
    var bReset = ui.btn('lb-b', '重置'), bPrev = ui.btn('lb-b', '‹ 上一行'), cnt = el('span', 'lb-cnt', '0 / 0'), bNext = ui.btn('lb-b lb-p', '下一行 ›'), bPlay = ui.btn('lb-b', '▶ 连着放');
    var spd = el('div', 'lb-seg'); spd.setAttribute('role', 'group'); spd.setAttribute('aria-label', '速度');
    [['慢', 1.8], ['正常', 1], ['快', 0.45]].forEach(function (s) { var b = ui.btn('', s[0]); b.dataset.k = s[1]; b.setAttribute('aria-pressed', String(s[1] === 1)); spd.appendChild(b); });
    var busSeg = el('div', 'lb-seg'), bBus = ui.btn('', '跳过总线那段'); bBus.setAttribute('aria-pressed', 'false'); busSeg.appendChild(bBus);
    [bReset, bPrev, cnt, bNext, bPlay, spd, busSeg].forEach(function (x) { ctl.appendChild(x); });
    root.appendChild(chipsBox); root.appendChild(grid); root.appendChild(ctl);
    host.appendChild(root);

    /* ---------- 画图 ---------- */
    var gFig = sv('g', {}, svg), gLv = sv('g', {}, svg), gTop = sv('g', {}, svg), fx = sv('g', {}, svg);
    function harrow(g, x1, x2, y, h, hd) {
      h = h || 13; hd = hd || 16; var s = h * 0.48;
      sv('polygon', { class: 'fb', points: [[x1, y], [x1 + hd, y - h], [x1 + hd, y - s], [x2 - hd, y - s], [x2 - hd, y - h], [x2, y], [x2 - hd, y + h], [x2 - hd, y + s], [x1 + hd, y + s], [x1 + hd, y + h]].join(' ') }, g);
    }
    function varrow(g, x, y1, y2, h, hd) {
      h = h || 10; hd = hd || 9; var s = h * 0.45;
      sv('polygon', { class: 'fb', points: [[x, y1], [x + h, y1 + hd], [x + s, y1 + hd], [x + s, y2 - hd], [x + h, y2 - hd], [x, y2], [x - h, y2 - hd], [x - s, y2 - hd], [x - s, y1 + hd], [x - h, y1 + hd]].join(' ') }, g);
    }
    function apb(g, x0, y1, y2, xr, ytip) {
      sv('path', { class: 'fl', d: 'M' + x0 + ' ' + y1 + ' H' + (xr + 6) + ' V' + (ytip - 18) + ' M' + x0 + ' ' + y2 + ' H' + (xr - 6) + ' V' + (ytip - 18) }, g);
      sv('polygon', { class: 'fb', points: [[xr - 6, ytip - 18], [xr - 16, ytip - 18], [xr, ytip], [xr + 16, ytip - 18], [xr + 6, ytip - 18]].join(' ') }, g);
    }
    // 系统结构（y 0..600）：照 RM0008 图 1 画，和这一章无关的部分淡掉
    (function () {
      var g = sv('g', {}, gFig);
      sv('rect', { x: 8, y: 8, width: 984, height: 590, class: 'fl', 'stroke-width': 1 }, g);
      tx(g, 22, 30, '系统结构', 'cap');
      sv('rect', { x: 30, y: 40, width: 200, height: 140, class: 'fb' }, g);
      tx(g, 130, 92, 'Cortex-M3', 't17', 'middle');
      var f = sv('g', { class: 'fade' }, g);
      harrow(f, 232, 505, 58); tx(f, 368, 40, 'ICode', 't14', 'middle');
      sv('rect', { x: 507, y: 32, width: 104, height: 56, class: 'fb' }, f); tx(f, 559, 66, 'FLITF', 't15', 'middle');
      harrow(f, 613, 718, 60, 11, 14);
      sv('rect', { x: 720, y: 32, width: 104, height: 56, class: 'fb' }, f); tx(f, 772, 66, '闪存', 't15', 'middle');
      sv('path', { class: 'fl', d: 'M397 136 H552 V96 M397 148 H566 V96' }, f);
      sv('polygon', { class: 'fb', points: '545,96 559,88 573,96' }, f);
      harrow(f, 397, 698, 172, 11, 14); sv('rect', { x: 700, y: 154, width: 100, height: 36, class: 'fb' }, f); tx(f, 750, 178, 'SRAM', 't15', 'middle');
      harrow(f, 397, 488, 214, 11, 14); sv('rect', { x: 490, y: 197, width: 100, height: 34, class: 'fb' }, f); tx(f, 540, 220, 'FSMC', 't15', 'middle');
      sv('rect', { x: 494, y: 240, width: 72, height: 30, class: 'fb' }, f); tx(f, 530, 261, 'SDIO', 't14', 'middle');
      varrow(f, 530, 271, 294, 8, 7);
      harrow(g, 232, 355, 108); tx(g, 293, 90, 'DCode', 't14', 'middle');
      harrow(g, 232, 355, 160); tx(g, 293, 142, '系统', 't14', 'middle');
      sv('polygon', { class: 'fb', points: '357,62 395,128 395,330 357,395' }, g);
      tx(g, 377, 228, '总线矩阵', 't15', 'middle', 90);
      sv('path', { class: 'fl', d: 'M395 296 H575 M395 312 H575' }, g);
      tx(g, 470, 309, 'AHB系统总线', 't13', 'middle');
      varrow(g, 480, 314, 345, 9, 8);
      sv('rect', { x: 410, y: 345, width: 136, height: 52, class: 'fb' }, g);
      tx(g, 478, 366, '复位和时钟', 't14', 'middle'); tx(g, 478, 387, '控制(RCC)', 't14', 'middle');
      sv('rect', { x: 575, y: 282, width: 104, height: 30, class: 'fb' }, g); tx(g, 627, 303, '桥接2', 't14', 'middle');
      sv('rect', { x: 575, y: 312, width: 104, height: 30, class: 'fb' }, g); tx(g, 627, 333, '桥接1', 't14', 'middle');
      apb(g, 679, 320, 334, 718, 392); tx(g, 742, 370, 'APB2', 't14');
      var a1 = sv('g', { class: 'fade' }, g); apb(a1, 679, 290, 304, 878, 392); tx(a1, 902, 360, 'APB1', 't14');
      sv('rect', { x: 640, y: 392, width: 156, height: 192, class: 'fb' }, g);
      var me = 'GPIO' + ch.port;
      ['ADC1', 'ADC2', 'ADC3', 'USART1', 'SPI1', 'TIM1', 'TIM8', 'GPIOA', 'GPIOB'].forEach(function (s, i) { var t = tx(g, 650, 412 + i * 19.6, s, 't13'); if (s === me) t.setAttribute('class', 't14 bold'); else t.setAttribute('fill', 'var(--fig-2)'); });
      ['GPIOC', 'GPIOD', 'GPIOE', 'GPIOF', 'GPIOG', 'EXTI', 'AFIO'].forEach(function (s, i) { tx(g, 786, 412 + i * 19.6, s, 't13', 'end').setAttribute('fill', 'var(--fig-2)'); });
      var a2 = sv('g', { class: 'fade' }, g);
      sv('rect', { x: 810, y: 392, width: 176, height: 192, class: 'fb' }, a2);
      ['DAC', 'PWR', 'BKP', 'bxCAN', 'USB', 'I2C2', 'I2C1', 'UART5', 'UART4'].forEach(function (s, i) { tx(a2, 818, 412 + i * 19.6, s, 't13'); });
      ['SPI3/I2S', 'SPI2/I2S', 'IWDG', 'WWDG', 'RTC', 'TIM7', 'TIM6', 'TIM5', 'TIM4'].forEach(function (s, i) { tx(a2, 978, 412 + i * 19.6, s, 't13', 'end'); });
    })();

    // 端口位：照「输出配置」画（局部 700 × 280，每个引脚一张）
    function T(p, d) { var o = PORT[p]; return d.replace(/([MLHV])\s*(-?[\d.]+)(?:\s+(-?[\d.]+))?/g, function (m, c, a, b) {
      if (c === 'H') return 'H' + (+a + o.ox); if (c === 'V') return 'V' + (+a + o.oy);
      return c + (+a + o.ox) + ' ' + (+b + o.oy); }); }
    function mos(g, x, top, bot, gateFrom, p) {
      var gy = (top + bot) / 2;
      sv('path', { class: 'fl', d: 'M' + x + ' ' + top + ' H' + (x - 9) + ' V' + bot + ' H' + x + ' M' + (x - 14) + ' ' + (top + 3) + ' V' + (bot - 3) }, g);
      sv('path', { class: 'fl', d: 'M' + gateFrom + ' ' + gy + ' H' + (p ? x - 21 : x - 14) }, g);
      if (p) sv('circle', { cx: x - 17.5, cy: gy, r: 3.5, class: 'fb' }, g);
    }
    function rail(g, x, y, lab, up) { sv('path', { class: 'fl', d: 'M' + (x - 8) + ' ' + y + ' H' + (x + 8) }, g); if (lab) tx(g, x, up ? y - 7 : y + 17, lab, 't12', 'middle'); }
    function drawPort(p) {
      var o = PORT[p], g = sv('g', { transform: 'translate(' + o.ox + ' ' + o.oy + ')' }, gFig);
      sv('rect', { x: 5, y: 4, width: 690, height: 272, class: 'fl', 'stroke-width': 1 }, g);
      tx(g, 16, 28, p, 't15 bold');
      sv('rect', { x: 159, y: 17, width: 28, height: 116, class: 'fb' }, g); tx(g, 173, 75, '输入数据寄存器', 't13', 'middle', -90).setAttribute('dominant-baseline', 'central');
      sv('rect', { x: 65, y: 60, width: 27, height: 139, class: 'fb' }, g); tx(g, 78.5, 130, '位设置/清除寄存器', 't13', 'middle', -90).setAttribute('dominant-baseline', 'central');
      sv('rect', { x: 120, y: 100, width: 27, height: 130, class: 'fb' }, g); tx(g, 133.5, 165, '输出数据寄存器', 't13', 'middle', -90).setAttribute('dominant-baseline', 'central');
      sv('path', { class: 'fl', d: 'M159 56 H20' }, g); sv('polygon', { class: 'ff', points: '12,56 22,51 22,61' }, g); tx(g, 28, 49, '读出', 't13');
      sv('path', { class: 'fl', d: 'M10 127 H57' }, g); sv('polygon', { class: 'ff', points: '65,127 55,122 55,132' }, g); tx(g, 14, 120, '写入', 't13');
      sv('path', { class: 'fl', d: 'M92 131 H106 V170 H112' }, g); sv('polygon', { class: 'ff', points: '120,170 110,165 110,175' }, g);
      sv('path', { class: 'fl', d: 'M22 219 H112' }, g); sv('polygon', { class: 'ff', points: '14,219 24,214 24,224' }, g); sv('polygon', { class: 'ff', points: '120,219 110,214 110,224' }, g); tx(g, 22, 212, '读/写', 't13');
      sv('rect', { x: 216, y: 17, width: 244, height: 118, class: 'fd' }, g); tx(g, 224, 128, '输入驱动器', 't13 bold');
      sv('path', { class: 'fl', d: 'M187 68 H332' }, g);
      sv('polygon', { class: 'fb', points: '332,68 376,51 376,85' }, g);
      sv('path', { class: 'fl', d: 'M346 74 H356 V62 H366 M352 74 V62', 'stroke-width': 1.2 }, g);
      sv('path', { class: 'fl', d: 'M357 42 V58' }, g); tx(g, 357, 37, '开', 't13', 'middle');
      tx(g, 354, 104, 'TTL肖特基触发器', 't12', 'middle');
      sv('path', { class: 'fl', d: 'M376 68 H563 V203 M563 134 H630' }, g);
      sv('rect', { x: 215, y: 150, width: 341, height: 106, class: 'fd' }, g); tx(g, 223, 169, '输出驱动器', 't13 bold');
      sv('path', { class: 'fl', d: 'M147 168 H162 V203 H307' }, g);
      sv('rect', { x: 307, y: 178, width: 71, height: 52, class: 'fb' }, g); tx(g, 342, 200, '输出', 't13', 'middle'); tx(g, 342, 219, '控制', 't13', 'middle');
      sv('path', { class: 'fl', d: 'M436 176 V166 M436 196 V211 M436 231 V242 M436 203 H563' }, g);
      mos(g, 436, 176, 196, 378, true); tx(g, 445, 190, 'P-MOS', 't12');
      mos(g, 436, 211, 231, 378, false); tx(g, 445, 226, 'N-MOS', 't12');
      rail(g, 436, 166, 'VDD', true); rail(g, 436, 242, 'VSS');
      sv('circle', { cx: 436, cy: 203, r: 3.5, class: 'ff' }, g);
      tx(g, 488, 246, '推挽或开漏', 't12', 'middle');
      sv('path', { class: 'fl', d: 'M595 76 V192' }, g);
      [[112, 98], [174, 160]].forEach(function (d) { sv('polygon', { class: 'fb', points: '588,' + d[0] + ' 602,' + d[0] + ' 595,' + d[1] }, g); sv('path', { class: 'fl', d: 'M588 ' + d[1] + ' H602' }, g); });
      rail(g, 595, 76, 'VDD', true); rail(g, 595, 192, 'VSS');
      tx(g, 606, 108, '保护二极管', 't12'); tx(g, 606, 170, '保护二极管', 't12');
      sv('circle', { cx: 563, cy: 134, r: 3.5, class: 'ff' }, g); sv('circle', { cx: 595, cy: 134, r: 3.5, class: 'ff' }, g);
      sv('rect', { x: 630, y: 127, width: 15, height: 15, class: 'fb' }, g); tx(g, 648, 122, 'I/O引脚', 't12 bold');
    }
    keys.forEach(drawPort);
    sv('rect', { x: 8, y: 608, width: 984, height: H - 614, class: 'fl', 'stroke-width': 1 }, gFig);
    tx(gFig, 22, 630, '端口位 · 输出配置', 'cap');
    var last = PORT[keys[N - 1]];
    var trunk = 'M724 584 V603 H16 V' + (last.oy + 219);
    keys.forEach(function (p) { var o = PORT[p]; trunk += ' M16 ' + (o.oy + 127) + ' H' + (o.ox + 10) + ' M16 ' + (o.oy + 56) + ' H' + (o.ox + 12) + ' M16 ' + (o.oy + 219) + ' H' + (o.ox + 14); });
    sv('path', { class: 'conn', d: trunk }, gFig);

    // 板子：3V3 → 2kΩ → LED → 引脚（低电平点亮）
    var LX = 880;
    function ledY(p) { var oy = PORT[p].oy; return { rail: oy + 26, rb: oy + 80, top: oy + 88, bot: oy + 110, pin: oy + 134 }; }
    (function () {
      var g = sv('g', {}, gFig);
      tx(g, 720, 630, '开发板', 'cap');
      function res(x, y1, y2) { var d = 'M' + x + ' ' + y1 + ' V' + (y1 + 10), y = y1 + 10, s = 1; for (var i = 0; i < 6; i++) { d += ' l' + (8 * s) + ' 5'; s = -s; y += 5; } d += ' L' + x + ' ' + (y + 2) + ' V' + y2; sv('path', { class: 'fl', d: d }, g); }
      keys.forEach(function (p) {
        var Y = ledY(p);
        rail(g, LX, Y.rail, '3V3', true); res(LX, Y.rail, Y.rb); tx(g, LX + 14, Y.rail + 34, '2kΩ', 't12');
        sv('path', { class: 'fl', d: 'M' + LX + ' ' + Y.rb + ' V' + Y.top }, g);
        sv('polygon', { class: 'fb', points: (LX - 11) + ',' + Y.top + ' ' + (LX + 11) + ',' + Y.top + ' ' + LX + ',' + (Y.bot - 2) }, g);
        sv('path', { class: 'fl', d: 'M' + (LX - 11) + ' ' + (Y.bot - 2) + ' H' + (LX + 11) + ' M' + LX + ' ' + (Y.bot - 2) + ' V' + Y.pin + ' H' + (PORT[p].ox + 645) }, g);
        sv('circle', { cx: LX, cy: Y.pin, r: 3, class: 'ff' }, g);
        tx(g, LX + 22, Y.top + 16, PORT[p].label, 't14 bold');
      });
    })();

    /* ---------- 状态叠加层 ---------- */
    var E = {};   // 每个引脚的叠加元素
    function lvPath(d) { return sv('path', { d: d, class: 'lv none' }, gLv); }
    function hlRect(x, y, w, h) { return sv('rect', { x: x, y: y, width: w, height: h, rx: 6, class: 'hlbox off' }, gTop); }
    function veil(x, y, w, h) { return sv('rect', { x: x, y: y, width: w, height: h, class: 'veil off' }, gTop); }
    function badge(x, y) { var g = sv('g', { class: 'badge zero' }, gTop); sv('circle', { cx: x, cy: y, r: 11 }, g); sv('text', { x: x, y: y + 1 }, g).textContent = '0'; return g; }
    keys.forEach(function (p) {
      var o = PORT[p], Y = ledY(p), x = o.ox, y = o.oy, e = E[p] = {};
      e.net = lvPath(T(p, 'M436 203 H563 V68 H376') + ' ' + T(p, 'M563 134 H645') + ' H' + LX + ' V' + (Y.bot - 2));
      e.in = lvPath(T(p, 'M332 68 H187'));
      e.o = lvPath(T(p, 'M147 168 H162 V203 H307'));
      e.gp = lvPath(T(p, 'M378 186 H414'));
      e.gn = lvPath(T(p, 'M378 221 H422'));
      e.cur = sv('path', { d: 'M' + LX + ' ' + Y.rail + ' V' + Y.pin + ' H' + (x + 645) + ' ' + T(p, 'M645 134 H563 V203 H436 V242'), class: 'curline off' }, gLv);
      e.hBsrr = hlRect(x + 60, y + 55, 37, 149); e.hOdr = hlRect(x + 115, y + 95, 37, 140); e.hIdr = hlRect(x + 154, y + 12, 38, 126);
      e.hOctl = hlRect(x + 302, y + 173, 81, 62); e.hP = hlRect(x + 414, y + 171, 28, 30); e.hN = hlRect(x + 414, y + 206, 28, 30);
      e.pveil = veil(x + 405, y + 160, 40, 40); e.oveil = veil(x + 213, y + 148, 345, 110); e.iveil = veil(x + 214, y + 15, 248, 122);
      e.dim = veil(x, y - 4, 700, 284);
      e.odrB = badge(x + 133.5, y + 86); e.idrB = badge(x + 197, y + 22);
      e.glow = sv('circle', { cx: LX, cy: Y.top + 9, r: 22, class: 'ledglow off c-' + o.color }, gTop);
      e.led = sv('polygon', { points: (LX - 11) + ',' + Y.top + ' ' + (LX + 11) + ',' + Y.top + ' ' + LX + ',' + (Y.bot - 2), class: 'ledbody c-' + o.color }, gTop);
    });
    var hCpu = hlRect(26, 36, 208, 148), hRcc = hlRect(406, 341, 144, 60), hGp = hlRect(644, GY - 11, 60, 24);
    var clk = sv('path', { d: 'M546 371 H614 V' + GY + ' H645', class: 'clkline off' }, gTop);

    function cls(e, c) { e.setAttribute('class', c); }
    function off(e, on) { e.classList.toggle('off', !on); }
    function setLv(e, v, show) { cls(e, 'lv ' + (show === false || v === 'z' || v == null ? 'none' : v ? 'hi' : 'lo')); }
    function setBadge(g, v, show) { g.setAttribute('class', 'badge ' + (v ? 'one' : 'zero')); g.style.opacity = show === false ? 0 : 1; g.querySelector('text').textContent = v; }
    function lit(pp) { return isOut(pp.mode) && pp.level === 0; }
    function render(s) {
      off(clk, !!s.clk);
      keys.forEach(function (p) {
        var e = E[p], q = s.pins[p], m = q.mode, out = isOut(m), lvl = q.level;
        off(e.dim, !s.clk);
        off(e.oveil, !out); off(e.pveil, m === 'od' || m === 'afod'); off(e.iveil, m === 'an');
        off(e.hP, m === 'pp' && q.odr === 1); off(e.hN, out && q.odr === 0);
        setBadge(e.odrB, q.odr, !!s.clk);
        var iv = m === 'an' ? 0 : lvl;
        setBadge(e.idrB, iv === 'z' ? 1 : iv, !!s.clk && iv !== 'z');
        setLv(e.net, lvl);
        setLv(e.in, iv, !!s.clk && m !== 'an');
        setLv(e.o, q.odr, out);
        setLv(e.gp, 1, m === 'pp' && q.odr === 1);
        setLv(e.gn, 1, out && q.odr === 0);
        var on = lit(q);
        off(e.glow, on); e.led.classList.toggle('on', on); off(e.cur, on);
      });
    }

    /* ---------- 波形：每个引脚一行，过去实线、将来虚线 ---------- */
    function wgt(ev) { var t = ev && ev.parts[0].t; return t === 'delay' ? 3 : t === 'cpu' ? 0.6 : 1; }
    function drawWave() {
      while (wave.firstChild) wave.removeChild(wave.firstChild);
      var tot = 0; evs.forEach(function (e) { tot += wgt(e); });
      var x0 = 64, k = tot ? Math.min(130, 916 / tot) : 0;
      keys.forEach(function (p, r) {
        var top = 14 + r * 30, bot = top + 18, mid = (top + bot) / 2;
        function yy(v) { return v === 'z' ? mid : v ? top : bot; }
        sv('text', { x: 10, y: bot - 3, class: 'wl' }, wave).textContent = p;
        var y = yy(st[0].pins[p].level), x = x0, dp = 'M' + x + ' ' + y, df = '';
        evs.forEach(function (e, i) {
          var ny = yy(st[i + 1].pins[p].level), w = wgt(e) * k;
          if (i === c) df = 'M' + x + ' ' + y;
          var seg = (ny !== y ? ' V' + ny : '') + ' H' + (x + w);
          if (i < c) dp += seg; else df += seg;
          y = ny; x += w;
        });
        sv('path', { d: dp, class: 'wp' }, wave);
        if (df) sv('path', { d: df, class: 'wf' }, wave);
      });
      var cx = x0; for (var i = 0; i < c; i++) cx += wgt(evs[i]) * k;
      sv('line', { x1: cx, y1: 6, x2: cx, y2: 18 + N * 30, class: 'wcur' }, wave);
    }

    /* ---------- 镜头：viewBox 在「系统结构」和某个引脚之间移动 ---------- */
    var view = 'follow', cam = { x: 0, y: 0, w: 1000, h: 620 }, camAnim = 0;
    function stacked() { return window.matchMedia('(max-width: 899px)').matches; }
    function rectOf(where) {
      if (view === 'all' || where === 'all') return { x: 0, w: 1000, y: 0, h: H };
      if (where === 'A') return { x: 0, w: 836, y: 0, h: 604 };   // 跟着信号时，淡掉的 APB1 那一列不用看全
      if (where === 'B') return { x: 0, w: 1000, y: 604, h: H - 604 };
      var o = PORT[where]; return o ? { x: 0, w: 1000, y: o.oy - 8, h: 292 } : rectOf('A');
    }
    function fit(where) {
      var R = rectOf(where), b = stage.getBoundingClientRect(), ar = b.width ? b.height / b.width : 0.62;
      var w = R.w, h = w * ar;
      if (R.h > h) { h = R.h; w = h / ar; return { x: R.x + R.w / 2 - w / 2, y: R.y, w: w, h: h }; }
      var y = where === 'A' || R.y === 0 ? R.y + R.h / 2 - h / 2 : R.y - 6; y = Math.max(0, Math.min(y, H - h)); if (h >= H) y = (H - h) / 2;
      return { x: R.x, y: y, w: w, h: h };
    }
    function setVB() { svg.setAttribute('viewBox', [cam.x, cam.y, cam.w, cam.h].map(function (v) { return v.toFixed(1); }).join(' ')); }
    function lerp(a, b, k) { return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, w: a.w + (b.w - a.w) * k, h: a.h + (b.h - a.h) * k }; }
    var camAt = 'A';
    function camTo(where, now) {
      camAt = where; var t = fit(where), a = clone(cam); cancelAnimationFrame(camAnim);
      if (now || reduce || (Math.abs(t.y - a.y) < 1 && Math.abs(t.h - a.h) < 1 && Math.abs(t.w - a.w) < 1)) { cam = t; setVB(); return Promise.resolve(); }
      var t0 = performance.now(), dur = 420 * Math.min(speed, 1.2);
      return new Promise(function (res) {
        (function f(n) { var k = Math.min(1, (n - t0) / dur), e = k < .5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2; cam = lerp(a, t, e); setVB(); if (k < 1) camAnim = requestAnimationFrame(f); else res(); })(t0);
      });
    }
    function onResize() { cam = fit(camAt); setVB(); }
    window.addEventListener('resize', onResize);

    /* ---------- 动画 ---------- */
    var A_OUT = 'M216 160 H376 V304 H562 V327 H718 V400 H724 V' + GY + ' H708';
    var A_IN = 'M708 ' + GY + ' H724 V400 H718 V327 H562 V304 H376 V160 H216';
    var A_RCC = 'M216 160 H376 V304 H480 V350';
    function CONN(p, ly, lx) { var o = PORT[p]; return 'M708 ' + GY + ' H724 V603 H16 V' + (o.oy + ly) + ' H' + (o.ox + lx); }
    function CONN_BACK(p, ly, lx) { var o = PORT[p]; return 'M' + (o.ox + lx) + ' ' + (o.oy + ly) + ' H16 V603 H724 V' + GY + ' H708'; }
    function CONN_C(p) { var o = PORT[p]; return 'M708 ' + GY + ' H724 V603 H16 V' + (o.oy + 262) + ' H' + (o.ox + 342) + ' V' + (o.oy + 230); }
    var R = {
      toOdr: function (p) { return T(p, 'M11 127 H78 V131 H106 V170 H133'); },
      gateP: function (p) { return T(p, 'M133 168 H162 V203 H342 V186 H414'); },
      gateN: function (p) { return T(p, 'M133 168 H162 V203 H342 V221 H422'); },
      rwIn: function (p) { return T(p, 'M14 219 H120'); },
      rwOut: function (p) { return T(p, 'M120 219 H14'); },
      vddToLed: function (p) { var Y = ledY(p); return T(p, 'M436 166 V203 H563 V134 H645') + ' H' + LX + ' V' + (Y.bot - 2); },
      ledToVss: function (p) { var Y = ledY(p); return 'M' + LX + ' ' + Y.rail + ' V' + Y.pin + ' H' + (PORT[p].ox + 645) + ' ' + T(p, 'M645 134 H563 V203 H436 V242'); }
    };
    var COL = { w: 'var(--hi)', r: 'var(--read)' };
    var token = 0, speed = 1, skipBus = false;
    function wait(ms) { var t = token; return new Promise(function (r) { setTimeout(function () { r(t === token); }, reduce ? 0 : ms * speed); }); }
    function fly(d, color, digit, ms, wire, camGo) {
      var t = token;
      return new Promise(function (resolve) {
        var p = sv('path', { d: d, fill: 'none', stroke: 'none' }, fx), Ln = p.getTotalLength(), ov = null, OL = 0;
        if (wire) { ov = sv('path', { d: wire.d || d, class: 'lv ' + wire.cls }, fx); OL = ov.getTotalLength(); ov.setAttribute('stroke-dasharray', OL + ' ' + OL); ov.setAttribute('stroke-dashoffset', OL); }
        var g = sv('g', { class: 'pt' }, fx);
        sv('circle', { r: 12, fill: color, stroke: 'var(--paper)', 'stroke-width': 2.5 }, g);
        if (digit !== '') sv('text', { y: 1 }, g).textContent = digit;
        var t0 = performance.now(), dur = reduce ? 1 : ms * speed, c0 = camGo ? clone(cam) : null, c1 = camGo ? fit(camGo) : null;
        if (camGo) { camAt = camGo; cancelAnimationFrame(camAnim); }
        function end() { g.remove(); p.remove(); if (ov) ov.remove(); resolve(t === token); }
        function f(now) {
          if (t !== token) { end(); return; }
          var k = Math.min(1, (now - t0) / dur), e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2, pt = p.getPointAtLength(e * Ln);
          g.setAttribute('transform', 'translate(' + pt.x.toFixed(1) + ',' + pt.y.toFixed(1) + ')');
          if (ov) ov.setAttribute('stroke-dashoffset', (OL * (1 - e)).toFixed(1));
          if (c0) { cam = lerp(c0, c1, e); setVB(); }
          if (k < 1) requestAnimationFrame(f); else end();
        }
        requestAnimationFrame(f);
      });
    }
    function all(list) { return Promise.all(list).then(function (r) { return r.every(Boolean); }); }
    function ring(x, y, color) { if (reduce) return; var c = sv('circle', { cx: x, cy: y, r: 14, class: 'ring', stroke: color }, fx); setTimeout(function () { c.remove(); }, 700); }
    function flash(e, ms) { if (!e || reduce) return; e.classList.remove('off'); setTimeout(function () { e.classList.add('off'); }, (ms || 500) * speed); }
    function pulse(e) { if (reduce || !e) return; e.classList.remove('pulse'); void e.getBoundingClientRect(); e.classList.add('pulse'); }
    function waitArc(x, y, ms) {
      if (reduce) return;
      var a = sv('circle', { cx: x, cy: y, r: 26, class: 'wait', 'stroke-dasharray': '164 164', 'stroke-dashoffset': 164, transform: 'rotate(-90 ' + x + ' ' + y + ')' }, fx);
      if (a.animate) a.animate([{ strokeDashoffset: 164 }, { strokeDashoffset: 0 }], { duration: ms * speed, fill: 'forwards' });
      setTimeout(function () { a.remove(); }, ms * speed + 60);
    }
    function focusOf(pins) { return pins.length === 1 ? pins[0] : 'B'; }
    // Cortex-M3 经总线到 GPIOA，再分到各个引脚的端口位（镜头一路跟下去）
    async function busTo(paths, color, digits, focus) {
      if (!skipBus) {
        await camTo('A'); flash(hCpu, 420);
        if (!(await fly(A_OUT, color, digits.length === 1 ? digits[0] : '', 760))) return false;
        flash(hGp, 500);
        return all(paths.map(function (d, i) { return fly(d, color, digits[i] != null ? digits[i] : '', 620, null, i === 0 ? focus : null); }));
      }
      await camTo(focus); return true;
    }
    async function busBack(paths, digits) {
      if (skipBus) return true;
      if (!(await all(paths.map(function (d, i) { return fly(d, COL.r, digits[i], 560, null, i === 0 ? 'A' : null); })))) return false;
      flash(hGp, 400);
      if (!(await fly(A_IN, COL.r, digits.length === 1 ? digits[0] : '', 700))) return false;
      flash(hCpu, 500); return true;
    }
    // 引脚电平变了：亮 = 电流从 3V3 流过 LED 进引脚、经 N-MOS 到地；灭 = P-MOS 把引脚拉到 VDD
    async function pinMove(pins, a, b) {
      var ch_ = pins.filter(function (p) { return a.pins[p].level !== b.pins[p].level || lit(a.pins[p]) !== lit(b.pins[p]); });
      if (!ch_.length) return true;
      var ok = await all(ch_.map(function (p) {
        var q = b.pins[p];
        if (lit(q)) return fly(R.ledToVss(p), COL.w, '', 900);
        if (q.level === 1) return fly(R.vddToLed(p), COL.w, '1', 700, { cls: 'hi', d: T(p, 'M436 203 H563 V134 H645') + ' H' + LX + ' V' + (ledY(p).bot - 2) });
        return wait(300);
      }));
      ch_.forEach(function (p) { var Y = ledY(p); ring(LX, Y.top + 9, lit(b.pins[p]) ? 'var(--hi)' : 'var(--lo)'); });
      return ok;
    }
    function mixLv(b, a) { var s = clone(b); keys.forEach(function (p) { s.pins[p].level = a.pins[p].level; }); return s; }
    var P = {
      clk: async function (part, a, b) {
        await camTo('A'); flash(hCpu, 400);
        if (!(await fly(A_RCC, COL.w, '', 760))) return false;
        flash(hRcc, 700); render(b); ring(614, GY, 'var(--clk)'); return wait(600);
      },
      w: async function (part, a, b) {
        var pins = part.pins, focus = focusOf(pins), dg = pins.map(function (p) { return String(b.pins[p].odr); });
        if (part.rmw) {
          // 先把 ODR 读回来
          if (!(await busTo(pins.map(function (p) { return CONN(p, 219, 14); }), COL.w, pins.map(function () { return ''; }), focus))) return false;
          if (!(await all(pins.map(function (p) { return fly(R.rwIn(p), COL.w, '', 320); })))) return false;
          pins.forEach(function (p) { flash(E[p].hOdr, 400); });
          var old = pins.map(function (p) { return String(a.pins[p].odr); });
          if (!(await all(pins.map(function (p, i) { return fly(R.rwOut(p), COL.r, old[i], 320); })))) return false;
          if (!(await busBack(pins.map(function (p) { return CONN_BACK(p, 219, 14); }), old))) return false;
          ring(130, 110, 'var(--hi)'); if (!(await wait(380))) return false;
          // 改完写回去
          if (!(await busTo(pins.map(function (p) { return CONN(p, 219, 14); }), COL.w, dg, focus))) return false;
          if (!(await all(pins.map(function (p, i) { return fly(R.rwIn(p), COL.w, dg[i], 320); })))) return false;
          pins.forEach(function (p) { flash(E[p].hOdr, 500); });
        } else {
          if (!(await busTo(pins.map(function (p) { return CONN(p, 127, 11); }), COL.w, dg, focus))) return false;
          if (!(await all(pins.map(function (p, i) { return fly(R.toOdr(p), COL.w, dg[i], 520); })))) return false;
          pins.forEach(function (p) { flash(E[p].hBsrr, 400); });
        }
        render(mixLv(b, a)); pins.forEach(function (p) { pulse(E[p].odrB); });
        var outs = pins.filter(function (p) { return isOut(b.pins[p].mode); });
        if (!outs.length) { pins.forEach(function (p) { flash(E[p].hOdr, 500); }); var w0 = await wait(450); render(b); return w0; }
        if (!(await all(outs.map(function (p, i) { return fly(b.pins[p].odr ? R.gateP(p) : R.gateN(p), COL.w, String(b.pins[p].odr), 480); })))) return false;
        outs.forEach(function (p) { flash(E[p].hOctl, 400); });
        if (!(await pinMove(outs, a, b))) return false;
        render(b); return true;
      },
      mode: async function (part, a, b) {
        var pins = part.pins, focus = focusOf(pins);
        if (!(await busTo(pins.map(CONN_C), COL.w, pins.map(function () { return ''; }), focus))) return false;
        pins.forEach(function (p) { flash(E[p].hOctl, 600); });
        render(mixLv(b, a)); if (!(await wait(260))) return false;
        if (!(await pinMove(pins, a, b))) return false;
        render(b); return wait(300);
      },
      delay: async function (part, a, b) {
        var on = keys.filter(function (p) { return lit(b.pins[p]); });
        if (on.length) on.forEach(function (p) { var Y = ledY(p); waitArc(LX, Y.top + 9, 800); });
        else waitArc(130, 110, 800);
        var ok = await wait(800); render(b); return ok;
      },
      cpu: async function (part, a, b) { if (!skipBus) await camTo('A'); render(b); flash(hCpu, 420); return wait(420); },
      same: async function (part, a, b) {
        await camTo('A'); flash(hCpu, 400);
        if (!(await fly(A_OUT, COL.w, '', 760))) return false;
        flash(hGp, 500); render(b); return wait(300);
      },
      lost: async function (part, a, b) {
        await camTo('A'); flash(hCpu, 400);
        if (!(await fly(A_OUT, COL.w, '', 760))) return false;
        ring(674, GY, 'var(--err)'); ring(674, GY, 'var(--err)'); render(b); return wait(600);
      }
    };
    // 一行可能干了好几件事（main 里的 LED_Init();）：按 开时钟 → 写输出 → 改模式 依次演
    async function animate(i) {
      var ev = evs[i], a = st[i], b = st[i + 1], s = clone(a);
      render(a);
      for (var k = 0; k < ev.parts.length; k++) {
        var part = ev.parts[k], n = clone(s);
        if (part.t === 'clk') n.clk = b.clk;
        if (part.t === 'w') part.pins.forEach(function (p) { n.pins[p].odr = b.pins[p].odr; derive(n.pins[p]); });
        if (part.t === 'mode') part.pins.forEach(function (p) { n.pins[p].mode = b.pins[p].mode; derive(n.pins[p]); });
        if (k === ev.parts.length - 1) n = b;
        var f = P[part.t] || P.cpu;
        if (!(await f(part, s, n))) return;
        s = n;
      }
      render(b);
    }

    /* ---------- 代码区 ---------- */
    var spec = null, evs = [], st = [], c = 0, playing = false;
    function line(n, t, run, d) {
      var b = el(run ? 'button' : 'div', 'lb-cl' + (run ? ' run' : ''));
      if (run) b.type = 'button';
      b.dataset.ln = n; b.setAttribute('role', 'listitem');
      b.appendChild(el('span', 'n', String(d != null ? d : n + 1)));
      var cc = el('span', 'c'); cc.appendChild(ui.hlC(t)); b.appendChild(cc);
      b.appendChild(el('span', 'tag'));
      if (run) b.addEventListener('click', function () { goLine(n); });
      return b;
    }
    function load(sp) {
      token++; playing = false; spec = sp;
      evs = sp.evs; st = sp.states; c = 0;
      ui.clear(ctxBox); ctxBox.hidden = !(sp.ctx && sp.ctx.length);
      (sp.ctx || []).forEach(function (t) { var d = el('div', 'lb-cx'); d.appendChild(ui.hlC(t)); ctxBox.appendChild(d); });
      ui.clear(codeBox);
      var runs = {}; evs.forEach(function (e) { runs[e.ln] = 1; });
      sp.lines.forEach(function (l) { codeBox.appendChild(line(l.n, l.t, !!runs[l.n], l.d)); });
      show(); cam = fit('A'); camAt = 'A'; setVB(); render(st[0]);
    }
    function show(animating) {
      var e = c > 0 ? evs[c - 1] : null, nx = evs[c];
      Array.prototype.forEach.call(codeBox.querySelectorAll('.lb-cl'), function (n) {
        var ln = +n.dataset.ln;
        n.classList.toggle('cur', !!e && e.ln === ln);
        n.classList.toggle('nxt', !!nx && nx.ln === ln && !(e && e.ln === ln));
        n.querySelector('.tag').textContent = e && e.ln === ln && e.tag ? e.tag : '';
      });
      exp.innerHTML = e ? spec.explain(c - 1, e, st[c - 1], st[c]) : spec.intro || '';
      cnt.textContent = c + ' / ' + evs.length;
      bPrev.disabled = c === 0; bNext.disabled = c >= evs.length;
      bPlay.textContent = playing ? '❚❚ 暂停' : '▶ 连着放';
      if (!animating) render(st[c]);
      drawWave();
      var cl = codeBox.querySelector('.lb-cl.cur');
      if (cl) { var r = cl.getBoundingClientRect(), pr = codep.getBoundingClientRect(); if (!stacked() && (r.top < pr.top || r.bottom > pr.bottom)) cl.scrollIntoView({ block: 'nearest' }); }
    }
    async function next() {
      if (c >= evs.length) return false;
      token++; var i = c; c++; show(true);
      await animate(i);
      return true;
    }
    function prev() { token++; playing = false; if (c > 0) c--; show(); }
    function goLine(ln) {
      token++; playing = false;
      var j = -1, i;
      for (i = c; i < evs.length; i++) if (evs[i].ln === ln) { j = i; break; }
      if (j < 0) for (i = 0; i < evs.length; i++) if (evs[i].ln === ln) { j = i; break; }
      if (j < 0) return;
      c = j; render(st[c]); next();
    }
    async function play() {
      if (playing) { playing = false; token++; show(); return; }
      if (c >= evs.length) c = 0;
      playing = true; show();
      while (playing && c < evs.length) {
        var t0 = token + 1;
        await next();
        if (token !== t0 || !playing) break;
        await new Promise(function (r) { setTimeout(r, reduce ? 0 : 140 * speed); });
      }
      playing = false; show(true);
    }
    bNext.addEventListener('click', function () { playing = false; next(); });
    bPrev.addEventListener('click', prev);
    bReset.addEventListener('click', function () { token++; playing = false; c = 0; show(); camTo('A'); });
    bPlay.addEventListener('click', play);
    Array.prototype.forEach.call(spd.children, function (b) {
      b.addEventListener('click', function () { speed = +b.dataset.k; Array.prototype.forEach.call(spd.children, function (x) { x.setAttribute('aria-pressed', String(x === b)); }); });
    });
    bBus.addEventListener('click', function () { skipBus = !skipBus; bBus.setAttribute('aria-pressed', String(skipBus)); });
    function setView(v) {
      view = v; vFollow.setAttribute('aria-pressed', String(v === 'follow')); vAll.setAttribute('aria-pressed', String(v === 'all'));
      root.classList.toggle('lb-allv', v === 'all');
      cam = fit(camAt); setVB();
    }
    vFollow.addEventListener('click', function () { setView('follow'); });
    vAll.addEventListener('click', function () { setView('all'); });
    setView('follow');
    function onKey(e) {
      if (!root.isConnected || (e.target.closest && e.target.closest('input,textarea,select'))) return;
      if (e.key === 'ArrowRight') { e.preventDefault(); playing = false; next(); }
      if (e.key === 'ArrowLeft') { e.preventDefault(); prev(); }
    }
    document.addEventListener('keydown', onKey);

    return {
      root: root, chips: chipsBox, load: load,
      destroy: function () { token++; playing = false; cancelAnimationFrame(camAnim); window.removeEventListener('resize', onResize); document.removeEventListener('keydown', onKey); root.remove(); }
    };
  }

  /* =====================================================================
     解释文字
     ===================================================================== */
  function autoText(ev, a, b) {
    var o = [];
    ev.parts.forEach(function (pt) {
      if (pt.t === 'clk') o.push('经 AHB 到 <b>RCC</b>，GPIOA 的时钟打开。');
      if (pt.t === 'w') pt.pins.forEach(function (p) {
        var q = b.pins[p], out = isOut(q.mode);
        o.push(p + ' 的输出数据寄存器 = ' + q.odr + (out ? (q.odr ? '：<b>P-MOS 导通</b>，引脚 3.3 V，灯灭。' : '：<b>N-MOS 导通</b>，电流流过 LED，灯亮。') : '。还不是输出，引脚不动。'));
      });
      if (pt.t === 'mode') pt.pins.forEach(function (p) {
        var q = b.pins[p], m = q.mode;
        o.push(p + ' 变成' + ({ pp: '<b>推挽输出</b>', od: '<b>开漏输出</b>', an: '模拟输入', in: '输入', afpp: '复用推挽输出', afod: '复用开漏输出' }[m] || m) + (lit(q) ? '：ODR 是 0，<b>灯一下就亮了</b>。' : '。'));
      });
      if (pt.t === 'delay') o.push('CPU 原地等 ' + pt.ms + ' ms，引脚保持不变。');
      if (pt.t === 'cpu') o.push('只在 Cortex-M3 里算，<b>不碰总线和引脚</b>。');
      if (pt.t === 'same') o.push('写进去了，但引脚没有变化。');
      if (pt.t === 'lost') o.push('<b>GPIOA 还没开时钟</b>：这一行写了也没用，寄存器保持原样。');
    });
    return o.join(' ');
  }
  function tagOf(ev, b) {
    var w = ev.parts.filter(function (p) { return p.t === 'w'; })[0];
    if (w && ev.parts.length === 1) return w.pins.map(function (p) { return p + ' = ' + b.pins[p].odr; }).join('  ');
    var d = ev.parts[0].t === 'delay' ? ev.parts[0].ms + ' ms' : '';
    return d;
  }
  // 从 lab-core 的 trace 结果组装给 Lab 的数据
  function specFromTrace(ch, t, o) {
    var srcLines = o.lines, comment = o.comment || {}, why = o.why || {};
    t.evs.forEach(function (e, i) { e.tag = tagOf(e, t.states[i + 1]); });
    return {
      lines: srcLines, ctx: o.ctx, evs: t.evs, states: t.states, intro: o.intro,
      explain: function (i, e, a, b) {
        var h = (o.text && o.text(i, e)) || ch.hw[e.code] || autoText(e, a, b), out = '';
        if (comment[e.ln]) out += '<p class="lb-cm">' + comment[e.ln] + '</p>';
        out += '<p>' + h + '</p>';
        if (why[e.ln]) out += '<details class="lb-why"><summary>为什么这样写</summary><p>' + why[e.ln] + '</p></details>';
        return out;
      }
    };
  }
  function chipSpec(ch, chip) {
    var t = L.trace(ch, chip), F = t.fn, src = L.file(ch, chip.file), lines = [], comment = {}, why = {};
    var from = chip.fn === 'main' ? F.head : F.head, to = F.close != null ? F.close : src.length - 1;
    for (var i = from; i <= to; i++) { lines.push({ n: i, t: src[i][0] }); if (src[i][1]) comment[i] = src[i][1]; if (src[i][2]) why[i] = src[i][2]; }
    var ctx = chip.file === 'led.c' ? src.slice(2, 4).map(function (l) { return l[0]; }) : [];
    return specFromTrace(ch, t, { lines: lines, ctx: ctx, comment: comment, why: why, intro: chip.intro });
  }
  function tourSpec(ch) {
    var t = L.trace(ch, { fn: 'main', main: ch.tour.map(function (x) { return x[0]; }) });
    return specFromTrace(ch, t, {
      lines: ch.tour.map(function (x, i) { return { n: i, t: x[0] }; }),
      intro: '五行代码，把信号会走的几条路都走一遍：开时钟、配引脚、写 1、写 0。点「下一行」，或者直接点一行。',
      text: function (i, e) { return ch.tour[e.ln][1]; }
    });
  }

  /* =====================================================================
     页面
     ===================================================================== */
  function home(root, app) {
    var wrap = el('div', 'labp'); root.appendChild(wrap);
    var head = el('header', 'pg-h lab-hero');
    head.appendChild(el('h1', null, '编程思维'));
    var ol = el('ol', 'lab-flow'); STAGES.forEach(function (s) { ol.appendChild(el('li', null, s[1])); }); head.appendChild(ol);
    wrap.appendChild(head);
    var grid = el('div', 'lab-chs');
    L.ORDER.forEach(function (id) {
      var ch = L.chapter(id), t = STM.model.topicById[ch.topic], sn = seen(id), n = STAGES.filter(function (s) { return sn[s[0]]; }).length;
      var a = app.link({ v: 'lab', t: id }, 'lab-ch'); a.style.setProperty('--h', app.hue(t));
      var top = el('div', 'lab-ch-h'); top.appendChild(el('b', 'mono', t ? t.code : id.toUpperCase())); top.appendChild(el('span', 'lab-ch-n', n + ' / ' + STAGES.length)); a.appendChild(top);
      a.appendChild(el('h2', null, ch.title));
      a.appendChild(el('p', null, ch.task));
      var bar = el('span', 'lab-ch-bar'); bar.style.setProperty('--k', String(n / STAGES.length)); a.appendChild(bar);
      grid.appendChild(a);
    });
    wrap.appendChild(grid);
    return { title: function () { return '编程思维'; } };
  }

  function chapterView(root, route, app) {
    var ch = L.chapter(route.t), wrap = el('div', 'labp lab-chp'), cur = null, lab = null;
    root.appendChild(wrap);
    var head = el('header', 'lab-head'), h1 = el('h1', null, ch.title);
    var tabs = el('nav', 'lab-tabs'); tabs.setAttribute('aria-label', '步骤');
    STAGES.forEach(function (s, i) {
      var a = app.link({ v: 'lab', t: ch.id, st: s[0] }, 'lab-tab'); a.dataset.st = s[0];
      a.appendChild(el('span', 'lab-tab-i', String(i + 1))); a.appendChild(el('span', null, s[1]));
      tabs.appendChild(a);
    });
    head.appendChild(h1); head.appendChild(tabs); wrap.appendChild(head);
    var body = el('div', 'lab-body'); wrap.appendChild(body);
    var foot = el('nav', 'lab-foot'); foot.setAttribute('aria-label', '上一步 / 下一步'); wrap.appendChild(foot);

    function stageOf(r) { return r.st || 'need'; }
    function paint(r) {
      var s = stageOf(r);
      if (s === cur && lab && lab.update) { lab.update(r); return; }
      if (lab && lab.destroy) lab.destroy();
      lab = null; ui.clear(body); cur = s;
      Array.prototype.forEach.call(tabs.children, function (a) { var on = a.dataset.st === s; a.classList.toggle('on', on); if (on) a.setAttribute('aria-current', 'step'); else a.removeAttribute('aria-current'); });
      wrap.classList.toggle('lab-wide', s === 'c' || s === 'hw' || s === 'self');
      lab = (STAGE[s] || STAGE.need)(body, ch, r, app) || {};
      markSeen(ch.id, s);
      ui.clear(foot);
      var i = STAGES.map(function (x) { return x[0]; }).indexOf(s);
      if (i > 0) { var p = app.link({ v: 'lab', t: ch.id, st: STAGES[i - 1][0] }, 'lab-nav lab-prev'); p.appendChild(ui.icon('back')); p.appendChild(el('span', null, STAGES[i - 1][1])); foot.appendChild(p); }
      else foot.appendChild(el('span'));
      if (i < STAGES.length - 1) { var nx = app.link({ v: 'lab', t: ch.id, st: STAGES[i + 1][0] }, 'lab-nav lab-next'); nx.appendChild(el('span', null, '下一步：' + STAGES[i + 1][1])); nx.appendChild(ui.icon('next')); foot.appendChild(nx); }
    }
    paint(route);
    return {
      title: function (r) { var s = STAGES.filter(function (x) { return x[0] === stageOf(r); })[0]; return ch.title + (s ? ' · ' + s[1] : ''); },
      update: function (r) { var was = cur; paint(r); if (was !== cur) window.scrollTo(0, 0); },
      destroy: function () { if (lab && lab.destroy) lab.destroy(); }
    };
  }

  /* ---------- 每一步 ---------- */
  function reveal(q, a) {
    var box = el('div', 'lab-q'), b = ui.btn('lab-q-h'), ans = html('div', 'lab-q-a', a);
    b.appendChild(el('span', 'lab-q-t', q)); b.appendChild(ui.icon('next', 'ic lab-q-i'));
    b.setAttribute('aria-expanded', 'false'); ans.hidden = true;
    b.addEventListener('click', function () { var on = ans.hidden; ans.hidden = !on; b.setAttribute('aria-expanded', String(on)); box.classList.toggle('open', on); });
    box.appendChild(b); box.appendChild(ans); return box;
  }
  var STAGE = {};
  STAGE.need = function (body, ch) {
    body.appendChild(html('p', 'lab-task', ch.task));
    var list = el('div', 'lab-qs'); ch.need.forEach(function (n) { list.appendChild(reveal(n.q, n.a)); }); body.appendChild(list);
  };
  STAGE.hw = function (body, ch) {
    var lab = Lab(body, ch); lab.chips.hidden = true;
    lab.load(tourSpec(ch));
    var f = el('section', 'lab-facts'); ch.facts.forEach(function (x) { f.appendChild(html('p', null, x)); }); body.appendChild(f);
    return { destroy: lab.destroy };
  };
  STAGE.fn = function (body, ch) {
    var g = el('div', 'lab-fns');
    ch.fns.forEach(function (f) {
      var c = el('article', 'lab-fn');
      var sig = el('code', 'lab-fn-sig'); sig.appendChild(ui.hlC(f.sig)); c.appendChild(sig);
      c.appendChild(el('p', 'lab-fn-job', f.job));
      var dl = el('dl', 'lab-fn-io');
      dl.appendChild(el('dt', null, '参数')); dl.appendChild(el('dd', null, f.args));
      dl.appendChild(el('dt', null, '返回')); dl.appendChild(el('dd', null, f.ret));
      c.appendChild(dl); g.appendChild(c);
    });
    body.appendChild(g);
    // 谁调用谁
    var tree = el('section', 'lab-sec'); tree.appendChild(el('h2', 'sec-h', '谁先谁后'));
    function tr(n) { var ul = el('ul', 'lab-tree'); n.forEach(function (x, i) { if (Array.isArray(x)) return; var li = el('li'); var cd = el('code'); cd.appendChild(ui.hlC(x)); li.appendChild(cd); if (Array.isArray(n[i + 1])) li.appendChild(tr(n[i + 1])); ul.appendChild(li); }); return ul; }
    tree.appendChild(tr(ch.calls)); body.appendChild(tree);
    // 放 .h 还是只在 .c 里
    var pl = el('section', 'lab-sec'); pl.appendChild(el('h2', 'sec-h', '放进 .h，还是只留在 .c？'));
    ch.place.forEach(function (it) {
      var row = el('div', 'lab-pl'), t = el('span', 'lab-pl-t'), bs = el('span', 'lab-pl-b'), fb = html('p', 'lab-pl-f', '');
      t.appendChild(ui.hlC(it.t)); fb.hidden = true;
      [['.h', true], ['只在 .c', false]].forEach(function (o) {
        var b = ui.btn('lab-pill', o[0]);
        b.addEventListener('click', function () {
          var ok = o[1] === it.h;
          Array.prototype.forEach.call(bs.children, function (x) { x.classList.remove('ok', 'no'); x.setAttribute('aria-pressed', 'false'); });
          b.classList.add(ok ? 'ok' : 'no'); b.setAttribute('aria-pressed', 'true');
          fb.hidden = false; fb.innerHTML = (ok ? '<b>对。</b>' : '<b>应该' + (it.h ? '放进 .h' : '只留在 .c') + '。</b>') + it.why;
        });
        bs.appendChild(b);
      });
      row.appendChild(t); row.appendChild(bs); row.appendChild(fb); pl.appendChild(row);
    });
    body.appendChild(pl);
  };
  STAGE.h = function (body, ch) {
    var src = L.file(ch, 'led.h'), k = 0, shown = {};
    var steps = el('ol', 'lab-hsteps'), code = el('figure', 'code lab-hcode'), hd = el('div', 'code-h'), pre = el('pre');
    hd.appendChild(el('span', 'code-t', 'led.h')); code.appendChild(hd); code.appendChild(pre);
    var grid = el('div', 'lab-hgrid'); grid.appendChild(steps); grid.appendChild(code); body.appendChild(grid);
    function drawCode(hot) {
      ui.clear(pre);
      src.forEach(function (l, i) {
        var row = el('span', 'lab-hl' + (shown[i] ? '' : ' ghost') + (hot && hot.indexOf(i) >= 0 ? ' hot' : ''));
        row.appendChild(ui.hlC(shown[i] ? l[0] : l[0].replace(/\S/g, ' '))); row.appendChild(document.createTextNode('\n'));
        pre.appendChild(row);
      });
    }
    function drawSteps() {
      ui.clear(steps);
      ch.hsteps.forEach(function (s, i) {
        var li = el('li', 'lab-hs' + (i < k ? ' done' : i === k ? ' on' : ''));
        li.appendChild(el('b', null, s.q));
        if (i < k) s.lines.forEach(function (n) { if (src[n][1]) { var p = el('p'); var cd = el('code'); cd.appendChild(ui.hlC(src[n][0])); p.appendChild(cd); p.appendChild(el('span', null, src[n][2] || src[n][1])); li.appendChild(p); } });
        if (i === k) { var b = ui.btn('lab-b lab-p', '写出这几行'); b.addEventListener('click', function () { s.lines.forEach(function (n) { shown[n] = 1; }); k++; if (k >= ch.hsteps.length) src.forEach(function (_, j) { shown[j] = 1; }); drawSteps(); drawCode(s.lines); }); li.appendChild(b); }
        steps.appendChild(li);
      });
      if (k >= ch.hsteps.length) {
        var li = el('li', 'lab-hs done end'); li.appendChild(el('b', null, '写完了'));
        var again = ui.btn('lab-b', '从头再来'); again.addEventListener('click', function () { k = 0; shown = {}; drawSteps(); drawCode(); }); li.appendChild(again);
        steps.appendChild(li);
      }
    }
    drawSteps(); drawCode();
  };
  STAGE.c = function (body, ch, route, app) {
    var lab = Lab(body, ch);
    function pick(id) {
      var chip = ch.chips.filter(function (x) { return x.id === id; })[0] || ch.chips[0];
      Array.prototype.forEach.call(lab.chips.children, function (b) { b.setAttribute('aria-pressed', String(b.dataset.k === chip.id)); });
      lab.load(chipSpec(ch, chip));
    }
    ch.chips.forEach(function (chip) {
      var b = ui.btn('lb-chip', chip.name); b.dataset.k = chip.id;
      b.addEventListener('click', function () { app.navigate({ fn: chip.id }, { replace: true }); });
      lab.chips.appendChild(b);
    });
    pick(route.fn);
    return { destroy: lab.destroy, update: function (r) { pick(r.fn); } };
  };

  /* ---------- 自己写 ---------- */
  var TOKENS = {
    init: ['RCC->APB2ENR', 'RCC_APB2ENR_IOPAEN', 'LED_PORT->', 'BSRR', 'CRL', 'CRH', '|=', '&= ~(', ' | ', ');', ';', 'GPIO_BSRR_BS', 'GPIO_CRL_CNF', 'GPIO_CRL_MODE', 'GPIO_CRH_CNF', 'GPIO_CRH_MODE'],
    onoff: ['LED_PORT->', 'BSRR', 'ODR', '=', 'led_pin[n]', '(uint32_t)', '<< 16', ';', 'if (', ')', 'return;', '||', '<', '>']
  };
  STAGE.self = function (body, ch, route, app) {
    var ex = ch.exercises.filter(function (x) { return x.id === route.fn; })[0] || ch.exercises[0], lab = null;
    var pick = el('div', 'lb-chips');
    ch.exercises.forEach(function (x) {
      var b = ui.btn('lb-chip', x.title); b.setAttribute('aria-pressed', String(x === ex));
      b.addEventListener('click', function () { app.navigate({ fn: x.id }, { replace: true }); });
      pick.appendChild(b);
    });
    body.appendChild(pick);
    body.appendChild(html('p', 'lab-task', ex.ask));
    var fnames = [].concat(ex.fn), ed = {}, src = L.file(ch, 'led.c'), parsed = L.parseFile(src).fns;
    var ctx = el('figure', 'code lab-ctx'), ch_ = el('div', 'code-h'); ch_.appendChild(el('span', 'code-t', 'led.c 里已经有的')); ctx.appendChild(ch_);
    var pre = el('pre'); pre.appendChild(ui.hlC(src.slice(0, 4).map(function (l) { return l[0]; }).join('\n'))); ctx.appendChild(pre); body.appendChild(ctx);
    var eds = el('div', 'lab-eds'); body.appendChild(eds);
    var lastFocus = null;
    fnames.forEach(function (name) {
      var box = el('figure', 'code lab-ed'), hh = el('div', 'code-h'); hh.appendChild(el('span', 'code-t', 'led.c')); box.appendChild(hh);
      var sig = el('pre', 'lab-ed-sig'); sig.appendChild(ui.hlC(parsed[name].sig + '\n{')); box.appendChild(sig);
      var ta = el('textarea', 'lab-ta'); ta.spellcheck = false; ta.setAttribute('autocapitalize', 'off'); ta.setAttribute('autocomplete', 'off'); ta.setAttribute('autocorrect', 'off');
      ta.setAttribute('aria-label', name + ' 的函数体'); ta.rows = name === 'LED_Init' ? 8 : 3;
      ta.value = ui.lsGet(SKEY + ch.id + '.' + name) || '    ';
      ta.addEventListener('input', function () { ui.lsSet(SKEY + ch.id + '.' + name, ta.value); });
      ta.addEventListener('focus', function () { lastFocus = ta; });
      ta.addEventListener('keydown', function (e) {
        if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); ins(ta, '    '); }
        if (e.key === 'Enter') { var s = ta.value.slice(0, ta.selectionStart), ind = /(^|\n)([ \t]*)[^\n]*$/.exec(s)[2]; e.preventDefault(); ins(ta, '\n' + ind); }
      });
      box.appendChild(ta);
      var end = el('pre', 'lab-ed-sig'); end.appendChild(ui.hlC('}')); box.appendChild(end);
      ed[name] = ta; eds.appendChild(box);
    });
    function ins(ta, s) { var a = ta.selectionStart, b = ta.selectionEnd; ta.setRangeText ? ta.setRangeText(s, a, b, 'end') : (ta.value = ta.value.slice(0, a) + s + ta.value.slice(b)); ta.dispatchEvent(new Event('input')); }
    var tk = el('div', 'lab-tokens'); tk.setAttribute('aria-label', '常用写法');
    (TOKENS[ex.id] || []).forEach(function (t) {
      var b = ui.btn('lab-tk', t.trim() || t); b.addEventListener('mousedown', function (e) { e.preventDefault(); });
      b.addEventListener('click', function () { var ta = lastFocus || ed[fnames[0]]; ta.focus(); ins(ta, t); });
      tk.appendChild(b);
    });
    body.appendChild(tk);
    var acts = el('div', 'lab-acts'), bCheck = ui.btn('lab-b lab-p', '检查'), bRef = ui.btn('lab-b', '课件写法'), bClear = ui.btn('lab-b', '清空');
    acts.appendChild(bCheck); acts.appendChild(bRef); acts.appendChild(bClear); body.appendChild(acts);
    var out = el('div', 'lab-res'); out.setAttribute('aria-live', 'polite'); body.appendChild(out);
    var refBox = el('div', 'lab-ref'); refBox.hidden = true; body.appendChild(refBox);
    var labHost = el('div', 'lab-mine'); body.appendChild(labHost);
    bRef.addEventListener('click', function () {
      refBox.hidden = !refBox.hidden; ui.clear(refBox);
      if (!refBox.hidden) fnames.forEach(function (n) { refBox.appendChild(ui.codeBlock(parsed[n].sig + '\n{\n' + L.body(ch, n) + '\n}', { title: 'led.c' })); });
    });
    bClear.addEventListener('click', function () { fnames.forEach(function (n) { ed[n].value = '    '; ui.lsSet(SKEY + ch.id + '.' + n, ed[n].value); }); ui.clear(out); if (lab) { lab.destroy(); lab = null; } });
    function bodyOf(n) { return ed[n].value; }
    bCheck.addEventListener('click', function () {
      var res = ex.id === 'init' ? L.checkInit(ch, bodyOf('LED_Init')) : L.checkOnOff(ch, bodyOf('LED_On'), bodyOf('LED_Off'));
      ui.clear(out);
      res.forEach(function (r) {
        var it = el('div', 'lab-r lab-r-' + r.k);
        it.appendChild(html('p', 'lab-r-m', r.msg));
        if (r.hints) {
          var lv = 0, hs = el('div', 'lab-hints'), hb = ui.btn('lab-b', '提示');
          hb.addEventListener('click', function () {
            var h = r.hints[lv];
            if (lv === r.hints.length - 1) hs.appendChild(ui.codeBlock(h, { title: '写法' }));
            else hs.appendChild(html('p', null, h));
            lv++; if (lv >= r.hints.length) hb.remove(); else hb.textContent = lv === r.hints.length - 1 ? '直接看写法' : '再提示一点';
          });
          it.appendChild(hs); it.appendChild(hb);
        }
        out.appendChild(it);
      });
      if (res[0] && res[0].id === 'syntax') return;
      showMine();
    });
    // 放进动画看：用自己写的代码跑一遍
    function showMine(which) {
      if (lab) lab.destroy();
      lab = Lab(labHost, ch);
      var opts = ex.id === 'init' ? [['LED_Init', ['LED_Init();']]] : [['LED_On', ['LED_Init();', 'LED_On(1);']], ['LED_Off', ['LED_Init();', 'LED_On(1);', 'LED_Off(1);']]];
      var sel = which || opts[0][0];
      opts.forEach(function (o) {
        var b = ui.btn('lb-chip', o[0] + '(' + (o[0] === 'LED_Init' ? '' : 'LED1') + ')'); b.setAttribute('aria-pressed', String(o[0] === sel));
        b.addEventListener('click', function () { showMine(o[0]); });
        lab.chips.appendChild(b);
      });
      var o = opts.filter(function (x) { return x[0] === sel; })[0], over = {};
      fnames.forEach(function (n) { over[n] = bodyOf(n); });
      var t = L.trace(ch, { fn: sel, main: o[1] }, over);
      var bl = String(over[sel]).split('\n').filter(function (x) { return x.trim(); });
      var lines = [{ n: -2, t: parsed[sel].sig, d: 1 }, { n: -1, t: '{', d: 2 }].concat(bl.map(function (x, i) { return { n: i, t: x, d: i + 3 }; })).concat([{ n: 999, t: '}', d: bl.length + 3 }]);
      lab.load(specFromTrace(ch, t, { lines: lines, intro: '这是你写的代码。点「下一行」，看每一行在硬件上做了什么。' }));
      if (which) return;
      try { lab.root.scrollIntoView({ behavior: ui.reduced() ? 'auto' : 'smooth', block: 'start' }); } catch (e) {}
    }
    return { destroy: function () { if (lab) lab.destroy(); } };
  };

  /* ---------- 入口 ---------- */
  STM.views.lab = function (root, route, app) {
    if (route.t && L.chapter(route.t)) return chapterView(root, route, app);
    return home(root, app);
  };
  STM.lab = { STAGES: STAGES, Lab: Lab };
})();
