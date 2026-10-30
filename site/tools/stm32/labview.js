/* labview.js — 侧栏「硬件原理」：一个外设在芯片里怎么工作（动画），以及为什么这样设计（原来的「设计原理」推导链）
   路由：v=think&t=gpio&hv=run|why&fn=…&ln=…（编程思维里每行寄存器代码的「看硬件」跳到这里的同一行）
   图：上半张按参考手册「系统结构」重画，下半张每个引脚一张「端口位·输出配置」，右边是板子上的 LED（教学简化，图下注明）。
   点一行代码 → 信号点从 Cortex-M3 出发，沿总线走到 GPIOA、走进端口位、走到引脚和 LED；读回来的时候反着走（蓝色）。
   动画只是把 lab-core.js 算好的「这一行前后的芯片状态」演出来。 */
(function () {
  'use strict';
  var STM = window.STM, ui = STM.ui, el = ui.el, L = window.STM32Lab;
  var NS = 'http://www.w3.org/2000/svg';
  var SKEY = 'lm.stm.lab.';
  function sv(tag, attrs, parent) { var e = document.createElementNS(NS, tag); for (var k in attrs) if (attrs[k] != null) e.setAttribute(k, attrs[k]); if (parent) parent.appendChild(e); return e; }
  function tx(g, x, y, s, cls, anchor, rot) { var t = sv('text', { x: x, y: y, class: cls || 't15', 'text-anchor': anchor || 'start', transform: rot ? 'rotate(' + rot + ' ' + x + ' ' + y + ')' : null }, g); t.textContent = s; return t; }
  function html(tag, cls, h) { var e = el(tag, cls); e.innerHTML = h; return e; }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function isOut(m) { return m === 'pp' || m === 'od' || m === 'afpp' || m === 'afod'; }
  function litOf(q) { return isOut(q.mode) && q.level === 0; }   // 低电平点亮
  function derive(p) { p.level = p.mode === 'pp' ? p.odr : p.mode === 'od' ? (p.odr ? 'z' : 0) : 'z'; return p; }

  /* =====================================================================
     图 + 动画
     ===================================================================== */
  function Lab(host, ch, opt) {
    opt = opt || {};
    var reduce = ui.reduced(), phase = opt.phase || function () {};
    var TIMS = ch.tims || [], TB = {}, yb = 640;
    TIMS.forEach(function (d) { var h = d.basic ? 150 : 236; TB[d.n] = { ox: 15, oy: yb, h: h, d: d }; yb += h + 12; });
    var N = ch.pins.length, OY0 = TIMS.length ? yb + 8 : 640, STEP = 288, H = OY0 + N * STEP - 8;
    var PORT = {}; ch.pins.forEach(function (p, i) { PORT[p.key] = { ox: 15, oy: OY0 + i * STEP, label: p.label, color: p.color }; });
    var keys = ch.pins.map(function (p) { return p.key; });
    var GY = 544;   // APB2 列表里 GPIOA 那一行
    var A1R = ['SPI3/I2S', 'SPI2/I2S', 'IWDG', 'WWDG', 'RTC', 'TIM7', 'TIM6', 'TIM5', 'TIM4', 'TIM3', 'TIM2'];   // APB1 右边一列（照手册图 1）
    function A1Y(i) { return 410 + i * 16.6; }
    function TY(n) { return A1Y(A1R.indexOf('TIM' + n)) - 5; }   // APB1 列表里 TIMn 那一行的中线

    var root = el('div', 'lb'), chipsBox = el('div', 'lb-chips'), grid = el('div', 'lb-grid');
    var codep = el('section', 'lb-codep'), hwp = el('section', 'lb-hwp');
    var ctxBox = el('div', 'lb-ctx lb-term'), codeBox = el('div', 'lb-code lb-term'), exp = el('div', 'lb-exp');
    codeBox.setAttribute('role', 'list'); exp.setAttribute('aria-live', 'polite');
    codep.setAttribute('aria-label', '代码'); hwp.setAttribute('aria-label', '硬件');
    codep.appendChild(ctxBox); codep.appendChild(codeBox); codep.appendChild(exp);
    var hwh = el('div', 'lb-hwh'), views = el('div', 'lb-seg'); views.setAttribute('role', 'group'); views.setAttribute('aria-label', '看哪里');
    var vFollow = ui.btn('', '跟随信号'), vAll = ui.btn('', '全图');
    views.appendChild(vFollow); views.appendChild(vAll); hwh.appendChild(views);
    var stage = el('div', 'lb-stage'), svg = sv('svg', { class: 'lb-fig', viewBox: '0 0 1000 620', preserveAspectRatio: 'xMidYMid meet', role: 'img', 'aria-label': 'Cortex-M3 经总线到 GPIOA、引脚、LED 的信号路线' });
    stage.appendChild(svg);
    var wave = sv('svg', { class: 'lb-wave', viewBox: '0 0 1000 ' + (TIMS.length ? 36 + TIMS.length * 46 + (TIMS.some(function (d) { return d.pin; }) ? 34 : 0) : 24 + N * 30), role: 'img', 'aria-label': '引脚电平随时间的变化' });
    hwp.appendChild(hwh); hwp.appendChild(stage); hwp.appendChild(wave);
    grid.appendChild(codep); grid.appendChild(hwp);
    var ctl = el('div', 'lb-ctl');
    var bReset = ui.btn('lb-b', '重置'), bPrev = ui.btn('lb-b', '‹ 上一行'), cnt = el('span', 'lb-cnt', '0 / 0'), bNext = ui.btn('lb-b lb-p', '下一行 ›'), bPlay = ui.btn('lb-b', '▶ 连续播放');
    var spd = el('div', 'lb-seg'); spd.setAttribute('role', 'group'); spd.setAttribute('aria-label', '速度');
    [['慢', 3.2], ['正常', 1], ['快', 0.45]].forEach(function (s) { var b = ui.btn('', s[0]); b.dataset.k = s[1]; b.setAttribute('aria-pressed', String(s[1] === 1)); spd.appendChild(b); });
    var busSeg = el('div', 'lb-seg'), bBus = ui.btn('', '跳过总线'); bBus.setAttribute('aria-pressed', 'false'); busSeg.appendChild(bBus);
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
      var a1 = sv('g', { class: TIMS.length ? '' : 'fade' }, g); apb(a1, 679, 290, 304, 878, 392); tx(a1, 902, 360, 'APB1', 't14');
      sv('rect', { x: 640, y: 392, width: 156, height: 192, class: 'fb' }, g);
      var me = 'GPIO' + ch.port;
      ['ADC1', 'ADC2', 'ADC3', 'USART1', 'SPI1', 'TIM1', 'TIM8', 'GPIOA', 'GPIOB'].forEach(function (s, i) { var t = tx(g, 650, 412 + i * 19.6, s, 't13'); if (s === me) t.setAttribute('class', 't14 bold'); else t.setAttribute('fill', 'var(--fig-2)'); });
      ['GPIOC', 'GPIOD', 'GPIOE', 'GPIOF', 'GPIOG', 'EXTI', 'AFIO'].forEach(function (s, i) { tx(g, 786, 412 + i * 19.6, s, 't13', 'end').setAttribute('fill', 'var(--fig-2)'); });
      var a2 = sv('g', { class: TIMS.length ? '' : 'fade' }, g), mine = TIMS.map(function (d) { return 'TIM' + d.n; });
      sv('rect', { x: 810, y: 392, width: 176, height: 192, class: 'fb' }, a2);
      ['DAC', 'PWR', 'BKP', 'bxCAN', 'USB', 'I2C2', 'I2C1', 'UART5', 'UART4', 'USART3', 'USART2'].forEach(function (s, i) { var t = tx(a2, 818, A1Y(i), s, 't13'); if (TIMS.length) t.setAttribute('fill', 'var(--fig-2)'); });
      A1R.forEach(function (s, i) { var t = tx(a2, 978, A1Y(i), s, 't13', 'end'); if (mine.indexOf(s) >= 0) t.setAttribute('class', 't14 bold'); else if (TIMS.length) t.setAttribute('fill', 'var(--fig-2)'); });
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
    tx(gFig, 22, 630, TIMS.length ? '定时器 · 端口位' : '端口位 · 输出配置', 'cap');

    /* ---------- 定时器：照参考手册「通用定时器框图」简化（局部 700 宽） ----------
       寄存器框：PSC → CNT（数到 ARR 产生 UEV）→ UIF → UIE → 中断；通道：CNT 与 CCRx 比较 → 输出控制 → CCxE → 引脚 */
    var TE = {}, TBOX = { PSC: [40, 66, 100, 52], CNT: [186, 66, 120, 52], ARR: [352, 66, 100, 52], CCR: [186, 156, 120, 52] };
    function TT(n, d) { var o = TB[n]; return d.replace(/([MLHV])\s*(-?[\d.]+)(?:\s+(-?[\d.]+))?/g, function (m, c, a, b) {
      if (c === 'H') return 'H' + (+a + o.ox); if (c === 'V') return 'V' + (+a + o.oy);
      return c + (+a + o.ox) + ' ' + (+b + o.oy); }); }
    function drawTim(d) {
      var o = TB[d.n], g = sv('g', { transform: 'translate(' + o.ox + ' ' + o.oy + ')' }, gFig), e = TE[d.n] = { box: {} };
      sv('rect', { x: 5, y: 4, width: 690, height: o.h - 8, class: 'fl', 'stroke-width': 1 }, g);
      tx(g, 16, 28, 'TIM' + d.n, 't15 bold');
      sv('path', { class: 'fl', d: 'M88 44 H700 M90 44 V66 M246 44 V66 M402 44 V66' + (d.basic ? '' : ' M322 44 V146 H290 V156'), 'stroke-width': 1, opacity: 0.55 }, g);
      // 时钟输入
      sv('path', { class: 'fl', d: 'M8 92 H32' }, g); sv('polygon', { class: 'ff', points: '40,92 30,87 30,97' }, g); tx(g, 8, 60, 'CK_INT', 't11');
      function box(k, x, y, w, h, lab) {
        sv('rect', { x: x, y: y, width: w, height: h, class: 'fb' }, g); tx(g, x + 8, y + 16, lab, 't12 bold');
        e.box[k] = { x: x, y: y, w: w, h: h, val: tx(g, x + w / 2, y + h - 12, '0', 'tv', 'middle') };
      }
      box('PSC', 40, 66, 100, 52, 'PSC');
      sv('path', { class: 'fl', d: 'M140 92 H178' }, g); sv('polygon', { class: 'ff', points: '186,92 176,87 176,97' }, g); tx(g, 163, 84, 'CK_CNT', 't11', 'middle');
      box('CNT', 186, 66, 120, 52, 'CNT');
      e.bar = sv('rect', { x: 190, y: 110, width: 0, height: 4, class: 'tbar' }, g);
      sv('path', { class: 'fl', d: 'M306 92 H344' }, g); sv('polygon', { class: 'ff', points: '352,92 342,87 342,97' }, g);
      box('ARR', 352, 66, 100, 52, 'ARR');
      // 更新事件 → UIF →（UIE）→ 中断
      var ig = sv('g', { class: d.basic ? '' : 'fade' }, g);
      sv('path', { class: 'fl', d: 'M452 92 H482' }, ig); sv('polygon', { class: 'ff', points: '490,92 480,87 480,97' }, ig); tx(ig, 470, 84, 'UEV', 't12', 'middle');
      sv('rect', { x: 490, y: 72, width: 54, height: 40, class: 'fb' }, ig); tx(ig, 517, 97, 'UIF', 't13 bold', 'middle');
      sv('path', { class: 'fl', d: 'M544 92 H576' }, ig);
      sv('path', { class: 'fb', d: 'M576 72 H596 A20 20 0 0 1 596 112 H576 Z' }, ig); tx(ig, 594, 97, 'UIE', 't12', 'middle');
      sv('path', { class: 'fl', d: 'M616 92 H700' }, ig); tx(ig, 640, 84, '中断', 't12');
      e.uif = sv('rect', { x: 492, y: 74, width: 50, height: 36, class: 'tflag off' }, g);
      e.gate = sv('path', { d: 'M577 73 H596 A19 19 0 0 1 596 111 H577 Z', class: 'tflag off' }, g);
      e.irq = sv('path', { d: 'M616 92 H700', class: 'lv none' }, g);
      if (!d.basic) {
        box('CCR', 186, 156, 120, 52, 'CCR' + d.ch);
        sv('path', { class: 'fl', d: 'M306 182 H340' }, g);
        sv('path', { class: 'fl', d: 'M246 118 V136 H360 V160' }, g);
        sv('rect', { x: 340, y: 160, width: 44, height: 44, class: 'fb' }, g); tx(g, 362, 189, '<', 't17', 'middle');
        sv('path', { class: 'fl', d: 'M384 182 H420' }, g); sv('polygon', { class: 'ff', points: '428,182 418,177 418,187' }, g); tx(g, 404, 174, 'OC' + d.ch + 'REF', 't12', 'middle');
        sv('rect', { x: 428, y: 156, width: 100, height: 52, class: 'fb' }, g); tx(g, 436, 172, '输出控制', 't12 bold');
        e.ocm = tx(g, 478, 197, '', 'tv', 'middle');
        e.pol = sv('circle', { cx: 533, cy: 182, r: 5, class: 'fb' }, g);
        sv('path', { class: 'fl', d: 'M538 182 H566 M590 182 H700' }, g);
        e.sw = sv('path', { class: 'fl', d: 'M566 182 L588 170' }, g);
        tx(g, 578, 160, 'CC' + d.ch + 'E', 't12', 'middle');
        tx(g, 640, 174, 'TIM' + d.n + '_CH' + d.ch, 't12 bold', 'middle');
        e.ocLv = sv('path', { d: 'M384 182 H428', class: 'lv none' }, g);
        e.outLv = sv('path', { d: 'M538 182 H566 M590 182 H700', class: 'lv none' }, g);
      }
      e.dim = sv('rect', { x: 0, y: 0, width: 700, height: o.h - 4, class: 'veil off' }, g);
      e.clkIn = sv('path', { d: 'M8 92 H32', class: 'clkline off' }, g);
      e.hl = {}; ['PSC', 'CNT', 'ARR', 'CCR'].forEach(function (k) { var b = TBOX[k]; e.hl[k] = sv('rect', { x: b[0] - 4, y: b[1] - 4, width: b[2] + 8, height: b[3] + 8, rx: 6, class: 'hlbox off' }, g); });
      e.hl.UIF = sv('rect', { x: 486, y: 68, width: 62, height: 48, rx: 6, class: 'hlbox off' }, g);
      e.hl.UIE = sv('rect', { x: 572, y: 68, width: 50, height: 48, rx: 6, class: 'hlbox off' }, g);
      e.hl.OCTL = sv('rect', { x: 424, y: 152, width: 108, height: 60, rx: 6, class: 'hlbox off' }, g);
      e.hl.CCE = sv('rect', { x: 558, y: 158, width: 40, height: 34, rx: 6, class: 'hlbox off' }, g);
    }
    TIMS.forEach(drawTim);
    // APB1 到各个定时器的连线；TIM5 通道 → PA1 的复用功能输入
    if (TIMS.length) {
      var lastT = TB[TIMS[TIMS.length - 1].n], tl = 'M892 584 V' + (lastT.oy + 44);
      TIMS.forEach(function (d) { tl += ' M892 ' + (TB[d.n].oy + 44) + ' H' + (TB[d.n].ox + 700); });
      sv('path', { class: 'conn', d: tl }, gFig);
    }
    function afPath(d) { var o = TB[d.n], po = PORT[d.pin]; return 'M' + (o.ox + 700) + ' ' + (o.oy + 182) + ' H744 V' + (po.oy + 266) + ' H' + (po.ox + 360) + ' V' + (po.oy + 230); }
    TIMS.forEach(function (d) { if (d.pin && PORT[d.pin]) sv('path', { class: 'fl', d: afPath(d), 'stroke-width': 1.3 }, gFig); });
    // NVIC：画在 Cortex-M3 里面（手册的系统结构图里没有，教学简化）；中断请求线从定时器绕回来
    var nvicBox = null, msTx = null, irqLine = '';
    if (TIMS.some(function (d) { return d.irq; })) {
      sv('rect', { x: 150, y: 140, width: 70, height: 32, class: 'fb' }, gFig); tx(gFig, 185, 161, 'NVIC', 't13 bold', 'middle');
      var dI = TIMS.filter(function (d) { return d.irq; })[0], oI = TB[dI.n];
      irqLine = 'M' + (oI.ox + 700) + ' ' + (oI.oy + 92) + ' H996 V20 H185 V140';
      sv('path', { class: 'fl', d: irqLine, 'stroke-dasharray': '6 5', 'stroke-width': 1.2, opacity: 0.6 }, gFig);
      nvicBox = sv('rect', { x: 150, y: 140, width: 70, height: 32, class: 'tflag off' }, gTop);
      msTx = tx(gTop, 130, 128, '', 'tms', 'middle');
    }
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
    TIMS.forEach(function (d) { if (d.pin && E[d.pin]) E[d.pin].af = sv('path', { d: afPath(d), class: 'lv none' }, gLv); });
    var hCpu = hlRect(26, 36, 208, 148), hRcc = hlRect(406, 341, 144, 60), hGp = hlRect(644, GY - 11, 60, 24);
    var clk = sv('path', { d: 'M546 371 H614 V' + GY + ' H645', class: 'clkline off' }, gTop);
    var tclk = {}, hT = {};
    TIMS.forEach(function (d, k) {
      tclk[d.n] = sv('path', { d: 'M546 ' + (380 + k * 6) + ' H' + (906 - k * 5) + ' V' + TY(d.n) + ' H930', class: 'clkline off' }, gTop);
      hT[d.n] = hlRect(928, TY(d.n) - 11, 56, 22);
    });
    var hNvic = nvicBox ? hlRect(146, 136, 78, 40) : null;

    function cls(e, c) { e.setAttribute('class', c); }
    function off(e, on) { e.classList.toggle('off', !on); }
    function setLv(e, v, show) { cls(e, 'lv ' + (show === false || v === 'z' || v == null ? 'none' : v ? 'hi' : 'lo')); }
    function setBadge(g, v, show) { g.setAttribute('class', 'badge ' + (v ? 'one' : 'zero')); g.style.opacity = show === false ? 0 : 1; g.querySelector('text').textContent = v; }
    function lit(pp) { return isOut(pp.mode) && pp.level === 0; }
    function fmtV(v) { return v == null ? '' : String(v); }
    function ocMode(t, k) { var m = ((k <= 2 ? t.CCMR1 : t.CCMR2) >> (((k - 1) & 1) * 8 + 4)) & 7; return m === 6 ? 'PWM1' : m === 7 ? 'PWM2' : m ? 'OCM ' + m.toString(2) : ''; }
    var shown = null;
    function renderTim(s) {
      shown = s;
      TIMS.forEach(function (d) {
        var e = TE[d.n], t = s.tim[d.n];
        off(tclk[d.n], t.clk); off(e.clkIn, t.clk); off(e.dim, !t.clk);
        e.box.PSC.val.textContent = fmtV(t.PSC); e.box.ARR.val.textContent = fmtV(t.ARR);
        if (!live[d.n] || !(t.CR1 & 1)) { e.box.CNT.val.textContent = '0'; e.bar.setAttribute('width', 0); }
        off(e.uif, !!(t.SR & 1)); off(e.gate, !!(t.DIER & 1));
        setLv(e.irq, 1, !!(t.DIER & 1) && !!(t.SR & 1));
        if (!d.basic) {
          e.box.CCR.val.textContent = fmtV(t.CCR[d.ch]);
          e.ocm.textContent = ocMode(t, d.ch);
          var pol = (t.CCER >> ((d.ch - 1) * 4 + 1)) & 1, en = (t.CCER >> ((d.ch - 1) * 4)) & 1;
          e.pol.style.opacity = pol ? 1 : 0;
          e.sw.setAttribute('d', en ? 'M566 182 H590' : 'M566 182 L588 170');
        }
      });
      if (nvicBox) { var on = TIMS.some(function (d) { return d.irq && s.nvic[d.irq]; }); off(nvicBox, on); }
      if (msTx) msTx.textContent = irqN ? 'ms ' + irqN : '';
      drawScope(s);
      liveFrame(performance.now(), true);
    }
    function render(s) {
      off(clk, !!s.clk);
      keys.forEach(function (p) { pinVisual(p, s.pins[p], s.clk); });
      if (TIMS.length) renderTim(s);
    }
    function pinVisual(p, q, sclk) {
        var e = E[p], m = q.mode, out = isOut(m), lvl = q.level, af = m === 'afpp' || m === 'afod', s = { clk: sclk };
        off(e.dim, !s.clk);
        off(e.oveil, !out); off(e.pveil, m === 'od' || m === 'afod'); off(e.iveil, m === 'an');
        off(e.hP, m === 'pp' && q.odr === 1); off(e.hN, out && q.odr === 0);
        setBadge(e.odrB, q.odr, !!s.clk);
        var iv = m === 'an' ? 0 : lvl;
        setBadge(e.idrB, iv === 'z' ? 1 : iv, !!s.clk && iv !== 'z');
        setLv(e.net, lvl);
        setLv(e.in, iv, !!s.clk && m !== 'an');
        setLv(e.o, q.odr, out && !af);
        var drv = af ? lvl : q.odr;   // 复用输出：驱动 MOS 管的是外设的输出，不是 ODR
        if (af) { off(e.hP, m === 'afpp' && lvl === 1); off(e.hN, lvl === 0); if (e.af) setLv(e.af, lvl, lvl !== 'z'); }
        setLv(e.gp, 1, (m === 'pp' || m === 'afpp') && drv === 1);
        setLv(e.gn, 1, out && drv === 0);
        var on = lit(q);
        off(e.glow, on); e.led.classList.toggle('on', on); off(e.cur, on);
    }

    /* ---------- 定时器在跑：慢动作计数（一圈约 2.6 秒 × 速度），溢出、比较、中断都按这个节奏演 ---------- */
    var live = {}, irqN = 0, liveRaf = 0, lastT = 0, PERIOD = 2600, quiet = false;
    function timLevel(d, t, cnt) {
      var m = ocMode(t, d.ch), ccr = t.CCR[d.ch], pol = (t.CCER >> ((d.ch - 1) * 4 + 1)) & 1, en = (t.CCER >> ((d.ch - 1) * 4)) & 1;
      var act = m === 'PWM1' ? cnt < ccr : m === 'PWM2' ? cnt >= ccr : false;
      return { act: act ? 1 : 0, level: en ? ((act ? 1 : 0) ^ pol) : 'z', en: en };
    }
    function overflow(d, t, L0) {
      var e = TE[d.n];
      if (d.basic) {
        off(e.uif, true); flash(e.hl.UIF, 300);
        if ((t.DIER & 1) && shown.nvic[d.irq] && !quiet && irqLine) {
          setLv(e.irq, 1, true);
          var tk = token;
          fly(irqLine, COL.r, '', 900).then(function () {
            if (tk !== token && !playing) return;
            irqN++; if (msTx) msTx.textContent = 'ms ' + irqN; flash(hNvic, 300); ring(130, 110, 'var(--read)');
            off(e.uif, false); setLv(e.irq, 1, false);
          });
        }
      }
      void L0;
    }
    function liveFrame(now, once) {
      var s = shown; if (!s || !s.tim) return;
      var dt = once || !lastT ? 0 : Math.max(0, Math.min(120, now - lastT)); if (!once || !lastT) lastT = now;
      TIMS.forEach(function (d) {
        var t = s.tim[d.n], e = TE[d.n], L0 = live[d.n] || (live[d.n] = { cnt: 0, k: 0, lv: null });
        var run = t.clk && (t.CR1 & 1) && !quiet, top = (t.ARR || 0) + 1;
        if (run && !reduce) {
          L0.cnt += dt * top / (PERIOD * speed);
          if (L0.cnt >= top) { L0.k += Math.floor(L0.cnt / top); L0.cnt = L0.cnt % top; overflow(d, t, L0); }
        } else if (!run) { L0.cnt = 0; L0.k = 0; }
        if (run) { e.box.CNT.val.textContent = String(Math.floor(L0.cnt)); e.bar.setAttribute('width', (112 * L0.cnt / top).toFixed(1)); }
        if (!d.basic) {
          var r = run ? timLevel(d, t, L0.cnt) : { act: 0, level: s.pins[d.pin] ? s.pins[d.pin].level : 'z', en: 0 };
          setLv(e.ocLv, r.act, run); setLv(e.outLv, r.level, run && r.en);
          var key = String(r.level) + (run ? 'r' : 's');
          if (L0.lv !== key || once) {
            L0.lv = key;
            if (d.pin && s.pins[d.pin]) { var q = clone(s.pins[d.pin]); if ((q.mode === 'afpp' || q.mode === 'afod') && run) q.level = r.level; pinVisual(d.pin, q, s.clk); }
          }
        }
      });
      scopeCursor();
    }
    function loop(now) { liveFrame(now); liveRaf = requestAnimationFrame(loop); }
    if (TIMS.length) liveRaf = requestAnimationFrame(loop);
    // 示波器：每个定时器一行（CNT 锯齿 + CCR 那条线），有通道的再加一行引脚波形；光标跟着慢动作走
    var scopeCur = null;
    function drawScope(s) {
      while (wave.firstChild) wave.removeChild(wave.firstChild);
      var x0 = 86, W = 880, y = 10;
      TIMS.forEach(function (d) {
        var t = s.tim[d.n], run = t.clk && (t.CR1 & 1), top = (t.ARR || 0) + 1, h = 34;
        sv('text', { x: 8, y: y + 22, class: 'wl' }, wave).textContent = 'TIM' + d.n;
        var dp = 'M' + x0 + ' ' + (y + h);
        if (run) for (var k = 0; k < 2; k++) dp += ' L' + (x0 + W * (k + 1) / 2) + ' ' + y + ' V' + (y + h);
        else dp += ' H' + (x0 + W);
        sv('path', { d: dp, class: 'wp' }, wave);
        if (!d.basic && run) {
          var cy = y + h - h * Math.min(1, t.CCR[d.ch] / top);
          sv('path', { d: 'M' + x0 + ' ' + cy + ' H' + (x0 + W), class: 'wccr' }, wave);
          y += h + 12;
          sv('text', { x: 8, y: y + 16, class: 'wl' }, wave).textContent = d.pin;
          var op = '', lv0 = null;
          for (var i = 0; i <= 400; i++) {
            var f = i / 400, cnt = (f * 2 % 1) * top, r = timLevel(d, t, cnt), yy = r.level === 'z' ? y + 10 : r.level ? y : y + 20, xx = x0 + W * f;
            op += (i ? (yy !== lv0 ? ' V' + yy : '') + ' H' + xx.toFixed(1) : 'M' + xx + ' ' + yy); lv0 = yy;
          }
          sv('path', { d: op, class: 'wp' }, wave);
          y += 24;
        } else y += h + 12;
      });
      scopeCur = sv('line', { x1: x0, y1: 4, x2: x0, y2: y, class: 'wcur' }, wave);
    }
    function scopeCursor() {
      if (!scopeCur || !shown) return;
      var run = function (x) { var t0 = shown.tim[x.n]; return t0 && t0.clk && (t0.CR1 & 1); };
      var d = TIMS.filter(function (x) { return !x.basic && run(x); })[0] || TIMS.filter(run)[0] || TIMS[0], L0 = live[d.n], t = shown.tim[d.n];
      if (!L0 || !t) { scopeCur.setAttribute('x1', 86); scopeCur.setAttribute('x2', 86); return; }
      var x = 86 + 880 * (((L0.k % 2) + L0.cnt / ((t.ARR || 0) + 1)) / 2);
      scopeCur.setAttribute('x1', x.toFixed(1)); scopeCur.setAttribute('x2', x.toFixed(1));
    }

    /* ---------- 波形：每个引脚一行，过去实线、将来虚线 ---------- */
    function wgt(ev) { var t = ev && ev.parts[0].t; return t === 'delay' ? 3 : t === 'cpu' ? 0.6 : 1; }
    function drawWave() {
      if (TIMS.length) { drawScope(st[c] || st[0]); return; }
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
      if (where === 'A') return { x: 0, w: TIMS.length ? 1000 : 836, y: 0, h: 604 };   // GPIO 那几章：淡掉的 APB1 那一列不用看全
      if (/^T\d+$/.test(where) && TB[where.slice(1)]) { var tb = TB[where.slice(1)]; return { x: 0, w: 1000, y: tb.oy - 8, h: tb.h + 4 }; }
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
      var t0 = performance.now(), dur = 420 * Math.min(speed, 2.4);
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
      phase('cpu');
      if (!skipBus) {
        await camTo('A'); flash(hCpu, 420); phase('bus');
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
      phase('pin');
      var ok = await all(ch_.map(function (p) {
        var q = b.pins[p];
        if (lit(q)) return fly(R.ledToVss(p), COL.w, '', 900);
        if (q.level === 1) return fly(R.vddToLed(p), COL.w, '1', 700, { cls: 'hi', d: T(p, 'M436 203 H563 V134 H645') + ' H' + LX + ' V' + (ledY(p).bot - 2) });
        return wait(300);
      }));
      ch_.forEach(function (p) { var Y = ledY(p); ring(LX, Y.top + 9, lit(b.pins[p]) ? 'var(--hi)' : 'var(--lo)'); });
      phase('led');
      return ok;
    }
    function mixLv(b, a) { var s = clone(b); keys.forEach(function (p) { s.pins[p].level = a.pins[p].level; }); return s; }
    var P = {
      clk: async function (part, a, b) {
        phase('cpu'); await camTo('A'); flash(hCpu, 400); phase('bus');
        if (!(await fly(A_RCC, COL.w, '', 760))) return false;
        phase('reg'); flash(hRcc, 700); render(b);
        var tn = /^TIM(\d+)$/.exec(part.what || '');
        if (tn && hT[tn[1]]) { ring(940, TY(tn[1]), 'var(--clk)'); flash(hT[tn[1]], 600); } else ring(614, GY, 'var(--clk)');
        return wait(600);
      },
      w: async function (part, a, b) {
        var pins = part.pins, focus = focusOf(pins), dg = pins.map(function (p) { return String(b.pins[p].odr); });
        if (part.rmw) {
          // 先把 ODR 读回来
          if (!(await busTo(pins.map(function (p) { return CONN(p, 219, 14); }), COL.w, pins.map(function () { return ''; }), focus))) return false;
          phase('reg');
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
          phase('reg');
          if (!(await all(pins.map(function (p, i) { return fly(R.toOdr(p), COL.w, dg[i], 520); })))) return false;
          pins.forEach(function (p) { flash(E[p].hBsrr, 400); });
        }
        render(mixLv(b, a)); pins.forEach(function (p) { pulse(E[p].odrB); });
        var outs = pins.filter(function (p) { return isOut(b.pins[p].mode); });
        if (!outs.length) { pins.forEach(function (p) { flash(E[p].hOdr, 500); }); var w0 = await wait(450); render(b); return w0; }
        phase('drv');
        if (!(await all(outs.map(function (p, i) { return fly(b.pins[p].odr ? R.gateP(p) : R.gateN(p), COL.w, String(b.pins[p].odr), 480); })))) return false;
        outs.forEach(function (p) { flash(E[p].hOctl, 400); });
        if (!(await pinMove(outs, a, b))) return false;
        render(b); return true;
      },
      mode: async function (part, a, b) {
        var pins = part.pins, focus = focusOf(pins);
        if (!(await busTo(pins.map(CONN_C), COL.w, pins.map(function () { return ''; }), focus))) return false;
        phase('drv'); pins.forEach(function (p) { flash(E[p].hOctl, 600); });
        render(mixLv(b, a)); if (!(await wait(260))) return false;
        if (!(await pinMove(pins, a, b))) return false;
        render(b); return wait(300);
      },
      delay: async function (part, a, b) {
        var on = keys.filter(function (p) { return lit(b.pins[p]); }); phase(on.length ? 'led' : 'cpu');
        if (on.length) on.forEach(function (p) { var Y = ledY(p); waitArc(LX, Y.top + 9, 800); });
        else waitArc(130, 110, 800);
        var ok = await wait(800); render(b); return ok;
      },
      cpu: async function (part, a, b) { phase('cpu'); if (!skipBus) await camTo('A'); render(b); flash(hCpu, 420); return wait(420); },
      same: async function (part, a, b) {
        await camTo('A'); flash(hCpu, 400);
        if (!(await fly(A_OUT, COL.w, '', 760))) return false;
        flash(hGp, 500); render(b); return wait(300);
      },
      treg: async function (part, a, b) {
        var n = part.tim, o = TB[n], e = TE[n], R = part.reg, t = b.tim[n], v = '';
        if (!o) { render(b); return wait(200); }
        if (R === 'PSC' || R === 'ARR') v = String(t[R]); else if (/^CCR\d$/.test(R)) v = String(t.CCR[+R.slice(3)]);
        var tgt = R === 'PSC' ? [90, 66] : R === 'ARR' ? [402, 66] : /^CCR/.test(R) ? null : R === 'SR' ? [517, 72] : R === 'DIER' ? [596, 72] : /^CC(MR|ER)/.test(R) ? [470, 156] : [246, 66];
        phase('cpu');
        if (!skipBus) {
          await camTo('A'); flash(hCpu, 360); phase('bus');
          if (!(await fly('M216 160 H376 V297 H884 V400 H892 V' + TY(n) + ' H926', COL.w, v, 760))) return false;
          flash(hT[n], 400);
          if (part.lost) { ring(950, TY(n), 'var(--err)'); ring(950, TY(n), 'var(--err)'); render(b); return wait(600); }
        } else await camTo('T' + n);
        phase('reg');
        var tail = tgt ? ' H' + (o.ox + tgt[0]) + ' V' + (o.oy + tgt[1]) : ' H' + (o.ox + 322) + ' V' + (o.oy + 146) + ' H' + (o.ox + 290) + ' V' + (o.oy + 156);
        if (!(await fly('M926 ' + TY(n) + ' H892 V' + (o.oy + 44) + ' H' + (o.ox + 700) + tail, COL.w, v, 760, null, skipBus ? null : 'T' + n))) return false;
        var hk = R === 'PSC' || R === 'ARR' ? R : /^CCR/.test(R) ? 'CCR' : R === 'SR' ? 'UIF' : R === 'DIER' ? 'UIE' : /^CCMR/.test(R) ? 'OCTL' : R === 'CCER' ? 'CCE' : 'CNT';
        flash(e.hl[hk], 600);
        if (R === 'EGR') { ['PSC', 'ARR', 'CCR', 'CNT'].forEach(function (k) { if (e.box[k]) { flash(e.hl[k], 600); pulse(e.box[k].val); } }); live[n] = { cnt: 0, k: 0, lv: null }; }
        if (R === 'CCER' && e.hl.OCTL) flash(e.hl.OCTL, 600);
        render(b);
        if (e.box[hk]) pulse(e.box[hk].val);
        if (R === 'CR1' && (t.CR1 & 1) && !(a.tim[n].CR1 & 1)) { ring(o.ox + 246, o.oy + 92, 'var(--hi)'); phase(TIMS.filter(function (d) { return d.n === n; })[0].pin ? 'pin' : 'reg'); }
        return wait(380);
      },
      tread: async function (part, a, b) {
        var n = part.tim, o = TB[n], e = TE[n], v = String(a.tim[n].SR & 1);
        phase('cpu');
        if (!skipBus) { await camTo('A'); flash(hCpu, 360); phase('bus'); if (!(await fly('M216 160 H376 V297 H884 V400 H892 V' + TY(n) + ' H926', COL.w, '', 700))) return false; }
        var go = 'M926 ' + TY(n) + ' H892 V' + (o.oy + 44) + ' H' + (o.ox + 700) + ' H' + (o.ox + 517) + ' V' + (o.oy + 72);
        if (!(await fly(go, COL.w, '', 640, null, skipBus ? null : 'T' + n))) return false;
        phase('reg'); flash(e.hl.UIF, 500);
        var back = 'M' + (o.ox + 517) + ' ' + (o.oy + 72) + ' V' + (o.oy + 44) + ' H' + (o.ox + 700) + ' H892 V' + TY(n) + ' H926';
        if (!(await fly(back, COL.r, v, 640, null, skipBus ? null : 'A'))) return false;
        if (!skipBus && !(await fly('M926 ' + TY(n) + ' H892 V400 H884 V297 H376 V160 H216', COL.r, v, 700))) return false;
        flash(hCpu, 400); render(b); return wait(200);
      },
      nvic: async function (part, a, b) {
        phase('cpu'); await camTo('A'); flash(hCpu, 360); flash(hNvic, 700); render(b); if (nvicBox) pulse(nvicBox); return wait(600);
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
        if (part.t === 'clk') { if (part.bus === 'APB1') { n.apb1 = b.apb1; n.tim[part.what.slice(3)].clk = true; } else { n.clk = b.clk; n.apb2 = b.apb2; } }
        if (part.t === 'treg' || part.t === 'tread' || part.t === 'nvic') { n.tim = clone(b.tim); n.nvic = clone(b.nvic); }
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
      quiet = !!sp.quiet; live = {}; irqN = 0; if (msTx) msTx.textContent = '';
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
      bPlay.textContent = playing ? '❚❚ 暂停' : '▶ 连续播放';
      if (!animating) render(st[c]);
      drawWave();
      var cl = codeBox.querySelector('.lb-cl.cur');
      if (cl) { var r = cl.getBoundingClientRect(), pr = codep.getBoundingClientRect(); if (!stacked() && (r.top < pr.top || r.bottom > pr.bottom)) cl.scrollIntoView({ block: 'nearest' }); }
    }
    async function next() {
      if (c >= evs.length) return false;
      phase(null);
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
      root: root, chips: chipsBox, load: load, go: function (ln) { if (evs.some(function (e) { return e.ln === ln; })) { try { root.scrollIntoView({ block: 'start' }); } catch (e) {} goLine(ln); } },
      destroy: function () { token++; playing = false; cancelAnimationFrame(camAnim); cancelAnimationFrame(liveRaf); window.removeEventListener('resize', onResize); document.removeEventListener('keydown', onKey); root.remove(); }
    };
  }

  /* =====================================================================
     解释文字
     ===================================================================== */
  function autoText(ev, a, b) {
    var o = [];
    ev.parts.forEach(function (pt) {
      if (pt.t === 'clk') o.push('经 AHB 到 <b>RCC</b>，' + (pt.what || 'GPIOA') + ' 的时钟打开。');
      if (pt.t === 'treg') o.push(pt.lost ? '<b>TIM' + pt.tim + ' 还没开时钟</b>：这一行写了也没用。' : '经 APB1 写 TIM' + pt.tim + ' 的 <b>' + pt.reg + '</b>。');
      if (pt.t === 'tread') o.push('经 APB1 把 TIM' + pt.tim + ' 的 <b>' + pt.reg + '</b> 读回 Cortex-M3。');
      if (pt.t === 'nvic') o.push('<b>NVIC</b> 打开这一路中断。');
      if (pt.t === 'w') pt.pins.forEach(function (p) {
        var q = b.pins[p], out = isOut(q.mode);
        o.push(p + ' 的输出数据寄存器 = ' + q.odr + (out ? (q.odr ? '：<b>P-MOS 导通</b>，引脚 3.3 V，灯灭。' : '：<b>N-MOS 导通</b>，电流流过 LED，灯亮。') : '。还不是输出，引脚不动。'));
      });
      if (pt.t === 'mode') pt.pins.forEach(function (p) {
        var q = b.pins[p], m = q.mode;
        o.push(p + ' 变成' + ({ pp: '<b>推挽输出</b>', od: '<b>开漏输出</b>', an: '模拟输入', in: '输入', afpp: '复用推挽输出', afod: '复用开漏输出' }[m] || m) + (litOf(q) ? '：ODR 是 0，<b>灯一下就亮了</b>。' : '。'));
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
    var tr = ev.parts.filter(function (p) { return p.t === 'treg'; })[0];
    if (tr && b.tim && b.tim[tr.tim]) { var tv = b.tim[tr.tim], R = tr.reg; if (R === 'PSC' || R === 'ARR') return R + ' = ' + tv[R]; if (/^CCR\d$/.test(R)) return R + ' = ' + tv.CCR[+R.slice(3)]; }
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
    var ctx = chip.file === ch.cfile && ch.ctx ? src.slice(ch.ctx[0], ch.ctx[1] + 1).map(function (l) { return l[0]; }).filter(function (x) { return x.trim() && !/^#include/.test(x.trim()); }) : [];
    var sp = specFromTrace(ch, t, { lines: lines, ctx: ctx, comment: comment, why: why, intro: chip.intro });
    sp.quiet = chip.id === 'isr';   // 一行行看中断函数的时候，慢动作里的定时器先停住
    return sp;
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
     硬件原理：怎么工作（动画）/ 为什么这样设计（原来的「设计原理」推导链）
     路由：v=think&t=gpio&hv=run|why&fn=芯片函数&ln=行号（从编程思维的「看硬件」跳过来）
     ===================================================================== */
  function chainOf(ch) { return [['cpu', 'CPU 访问寄存器'], ['bus', '总线'], ['reg', ch.tims ? '定时器寄存器' : 'GPIO 寄存器'], ['drv', '输出驱动'], ['pin', '引脚电平'], ['led', 'LED']]; }
  function mineSpec(ch, which) {
    var names = (ch.mine || {})[which];
    if (!names) return null;
    var srcOf = function (n) { return ui.lsGet(SKEY + ch.id + '.' + n); }, over = {};
    Object.keys(ch.mine).forEach(function (k) { var n = ch.mine[k][0], v = srcOf(n); if (v && v.trim()) over[n] = v; });
    if (!over[names[0]]) return null;
    var t = L.trace(ch, { fn: names[0], main: names[1] }, over);
    var bl = L.joinElse(String(over[names[0]]).split('\n').filter(function (x) { return x.trim(); }));
    var sig = L.parseFile(L.file(ch, ch.cfile)).fns[names[0]].sig;
    var lines = [{ n: -2, t: sig, d: 1 }, { n: -1, t: '{', d: 2 }].concat(bl.map(function (x, i) { return { n: i, t: x, d: i + 3 }; })).concat([{ n: 999, t: '}', d: bl.length + 3 }]);
    return specFromTrace(ch, t, { lines: lines, intro: '这是你在「编程思维 · 验证」里检查过的 ' + names[0] + '。点「下一行」，看每一行在芯片里做了什么。' });
  }
  function hwChapter(root, route, app) {
    var ch = L.chapter(route.t), t = STM.model.topicById[ch.topic], wrap = el('div', 'labp hwp lab-wide'), mode = null, inner = null, lab = null;
    root.appendChild(wrap);
    var head = el('header', 'lab-head'), h1 = el('h1', null, (t ? t.code : ch.id.toUpperCase()) + '：硬件原理');
    var tabs = el('nav', 'lab-tabs'); tabs.setAttribute('aria-label', '看哪一部分');
    [['run', '工作过程'], ['why', '设计原理']].forEach(function (x) {
      var a = app.link({ v: 'think', t: ch.id, hv: x[0] }, 'lab-tab'); a.dataset.hv = x[0]; a.appendChild(el('span', null, x[1])); tabs.appendChild(a);
    });
    var toProg = app.link({ v: 'lab', t: ch.id, st: 'code' }, 'hw-prog'); toProg.appendChild(el('span', null, '编程思维')); toProg.appendChild(ui.icon('next'));
    head.appendChild(h1); head.appendChild(tabs); head.appendChild(toProg); wrap.appendChild(head);
    var body = el('div', 'hw-body'); wrap.appendChild(body);
    function modeOf(r) { return r.hv === 'why' || r.hv === 'run' ? r.hv : r.s ? 'why' : 'run'; }
    function pickChip(r) {
      var mine = /^mine-/.test(r.fn || '') ? mineSpec(ch, r.fn) : null;
      var chip = ch.chips.filter(function (x) { return x.id === r.fn; })[0] || (ch.tour ? null : ch.chips[0]);
      var id = mine ? r.fn : chip ? chip.id : 'tour';
      Array.prototype.forEach.call(lab.chips.children, function (b) { b.setAttribute('aria-pressed', String(b.dataset.k === id)); });
      lab.load(mine || (chip ? chipSpec(ch, chip) : tourSpec(ch)));
      if (r.ln != null && r.ln !== '') lab.go(Number(r.ln));
    }
    function paint(r) {
      var m = modeOf(r);
      Array.prototype.forEach.call(tabs.children, function (a) { var on = a.dataset.hv === m; a.classList.toggle('on', on); if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
      if (m === mode) { if (m === 'why' && inner && inner.update) inner.update(r); if (m === 'run' && lab) pickChip(r); return; }
      if (inner && inner.destroy) inner.destroy(); if (lab) lab.destroy();
      inner = null; lab = null; ui.clear(body); mode = m;
      wrap.classList.toggle('lab-wide', m === 'run');
      if (m === 'why') { inner = STM.derive.view(body, r, app); return; }
      var chain = el('ol', 'hw-chain'); chain.setAttribute('aria-label', '一次访问经过哪些地方');
      chainOf(ch).forEach(function (c) { var li = el('li', null, c[1]); li.dataset.k = c[0]; chain.appendChild(li); });
      body.appendChild(chain);
      lab = Lab(body, ch, { phase: function (k) { Array.prototype.forEach.call(chain.children, function (li) { li.classList.toggle('on', li.dataset.k === k); }); } });
      var list = (ch.tour ? [['tour', '路径总览']] : []).concat(ch.chips.map(function (c) { return [c.id, c.name]; }));
      Object.keys(ch.mine || {}).forEach(function (k) { if (mineSpec(ch, k)) list.push([k, ch.mine[k][2]]); });
      list.forEach(function (c) {
        var b = ui.btn('lb-chip' + (/^mine-/.test(c[0]) ? ' mine' : ''), c[1]); b.dataset.k = c[0];
        b.addEventListener('click', function () { app.navigate({ fn: c[0], ln: null }, { replace: true }); });
        lab.chips.appendChild(b);
      });
      lab.root.appendChild(el('p', 'hw-note', ch.tims ? '图按参考手册 RM0008 图1「系统结构」、图98「通用定时器框图」、图16「输出配置」重画，只留下这一章用到的部分；Cortex-M3 里的 NVIC 和中断请求线是补画的。教学简化，不是芯片内部的完整电路。计数是慢动作。' : '图按参考手册 RM0008 图1「系统结构」、图16「输出配置」重画，只留下这一章用到的连线，是教学简化，不是芯片内部的完整电路。右边的 LED 电路按开发板原理图第 8 页画。'));
      var f = el('section', 'lab-facts'); ch.facts.forEach(function (x) { f.appendChild(html('p', null, x)); }); body.appendChild(f);
      pickChip(r);
    }
    paint(route);
    return {
      title: function (r) { return (t ? t.code : '') + ' · 硬件原理' + (modeOf(r) === 'why' ? ' · 设计原理' : ''); },
      update: function (r) { var was = mode; paint(r); if (was !== mode) window.scrollTo(0, 0); },
      destroy: function () { if (inner && inner.destroy) inner.destroy(); if (lab) lab.destroy(); }
    };
  }

  STM.lab = { Lab: Lab, hasHw: function (id) { return !!L.chapter(id); }, hwView: hwChapter };
})();
