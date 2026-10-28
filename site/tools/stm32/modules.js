/* modules.js — 开发板上的模块：数据（每个脚接到哪里）+ 模拟图（SVG，可点）
   数据按原理图（assets/board-*.svg）整理；接到 MCU 的脚写 mcu（引脚名），接电源 / 地的写 net。
   数据部分不碰 DOM（Node 里测试用）；画图部分要 STM.ui，在页面里才有。 */
(function () {
  'use strict';
  var W = typeof window === 'object' ? window : this;

  /* ---------- 数据 ---------- */
  // pin: { k 唯一键, name 脚名, no 物理脚号, mcu 接到的 MCU 引脚, net 接到的电源网络, note 一句话 }
  function sop(list) { return list.map(function (x, i) { return Object.assign({ k: 'p' + (i + 1), no: i + 1 }, x); }); }
  var MODULES = [
    { id: 'led', tag: 'LED', topic: 'gpio', sch: 'board-08', kind: 'leds',
      pins: [
        { k: 'led1', name: 'LED1', color: 'y', mcu: 'PA0', note: '黄灯，3V3 → 2kΩ → LED → PA0，输出 0 亮' },
        { k: 'led2', name: 'LED2', color: 'b', mcu: 'PA1', note: '蓝灯，输出 0 亮' },
        { k: 'led3', name: 'LED3', color: 'g', mcu: 'PA8', note: '绿灯，输出 0 亮' },
        { k: 'led5', name: 'LED5', color: 'rgb', mcu: 'PG11', part: 'WS2812', note: 'WS2812 全彩灯，单线串行数据，5V 供电' },
        { k: 'pwr', name: 'PWR', color: 'r', net: '3V3', note: '电源指示灯，上电常亮，不受 MCU 控制' }
      ] },
    { id: 'key', tag: '按键', topic: 'gpio', sch: 'board-08', kind: 'keys',
      pins: [
        { k: 'key1', name: 'KEY1', mcu: 'PF8', note: '按下接 GND，没有外部上拉 → 配上拉输入' },
        { k: 'key2', name: 'KEY2', mcu: 'PF9', note: '按下接 GND，没有外部上拉 → 配上拉输入' },
        { k: 'key3', name: 'KEY3', mcu: 'PF10', note: '按下接 3V3，没有外部下拉 → 配下拉输入' },
        { k: 'key4', name: 'KEY4', mcu: 'PF11', note: '按下接 3V3，没有外部下拉 → 配下拉输入' },
        { k: 'rst', name: 'RESET', mcu: 'NRST', note: '按下拉低 NRST，芯片复位；10kΩ 上拉 + 100nF' }
      ] },
    { id: 'beep', tag: '蜂鸣器', topic: 'gpio', sch: 'board-08', kind: 'beep', part: 'AO3400A',
      pins: [
        { k: 'g', name: 'G', mcu: 'PB1', note: 'MOS 管栅极：PB1 经 1kΩ 接到这里，10kΩ 下拉。PB1 输出 1 → 管子导通 → 蜂鸣器响' },
        { k: 'd', name: 'D', note: 'MOS 管漏极，接蜂鸣器负极' },
        { k: 's', name: 'S', net: 'GND', note: 'MOS 管源极，接地' },
        { k: 'bp', name: '+', net: '5V', note: '蜂鸣器正极，接 5V（并联续流二极管 D4）' },
        { k: 'bn', name: '−', note: '蜂鸣器负极，接 MOS 管漏极' }
      ] },
    { id: 'eeprom', tag: 'M24C02', topic: 'i2c', sch: 'board-04', kind: 'sop8', part: 'M24C02-WMN6TP', mark: '24C02', bus: 'I2C2',
      pins: sop([
        { name: 'E0', net: 'GND', note: '地址位，接地（原理图上标作 E1）' },
        { name: 'E1', net: 'GND', note: '地址位，接地（原理图上标作 E2）' },
        { name: 'E2', net: 'GND', note: '地址位，接地（原理图上标作 E3）；三个都接地 → 地址 0xA0' },
        { name: 'VSS', net: 'GND' },
        { name: 'SDA', mcu: 'PB11', note: '数据线，10kΩ 上拉到 3V3' },
        { name: 'SCL', mcu: 'PB10', note: '时钟线，10kΩ 上拉到 3V3' },
        { name: 'WC', net: 'GND', note: '写保护，接地 = 允许写' },
        { name: 'VCC', net: '3V3', note: '旁边 100nF 去耦电容' }
      ]) },
    { id: 'flash', tag: 'W25Q32', topic: 'spi', sch: 'board-05', kind: 'sop8', part: 'W25Q32JVSSIQ', mark: '25Q32', bus: 'SPI1',
      pins: sop([
        { name: 'CS', mcu: 'PC13', note: '片选，低电平选中' },
        { name: 'DO', mcu: 'PA6', note: 'Flash 输出 → MCU 的 MISO；SPI1 和 LoRa 共用' },
        { name: 'WP', net: '3V3', note: '写保护，接 3V3 = 不保护' },
        { name: 'GND', net: 'GND' },
        { name: 'DI', mcu: 'PA7', note: 'MCU 的 MOSI → Flash 输入；SPI1 和 LoRa 共用' },
        { name: 'CLK', mcu: 'PA5', note: 'SPI1 时钟；和 LoRa 共用' },
        { name: 'HOLD', net: '3V3', note: '接 3V3 = 不暂停' },
        { name: 'VCC', net: '3V3', note: '旁边 100nF 去耦电容' }
      ]) },
    { id: 'pot', tag: '电位器', topic: 'adc', sch: 'board-14', kind: 'pot', part: '100kΩ',
      pins: [
        { k: 'p1', no: 1, name: '1', net: '3V3', note: '一端接 3V3' },
        { k: 'p2', no: 2, name: '2', mcu: 'PC0', note: '滑动端，经 0Ω 电阻到 PC0（ADC 通道 10），0 ~ 3.3 V' },
        { k: 'p3', no: 3, name: '3', net: 'GND', note: '另一端接地' }
      ] },
    { id: 'stlink', tag: 'ST-Link', topic: 'usart', sch: 'board-02', kind: 'header', label: 'CN1',
      pins: [
        { k: 'p1', no: 1, name: 'NC', net: 'NC' },
        { k: 'p2', no: 2, name: 'NRST', mcu: 'NRST' },
        { k: 'p3', no: 3, name: 'SWDIO', mcu: 'PA13', note: '下载调试：数据' },
        { k: 'p4', no: 4, name: 'RX', mcu: 'PA10', note: 'USART1 RX：电脑 → 板子（STLink 虚拟串口）' },
        { k: 'p5', no: 5, name: 'SWCLK', mcu: 'PA14', note: '下载调试：时钟' },
        { k: 'p6', no: 6, name: 'TX', mcu: 'PA9', note: 'USART1 TX：板子 → 电脑（STLink 虚拟串口）；跳线 H11 可切到 RS485 / RS232' },
        { k: 'p7', no: 7, name: 'GND', net: 'GND' },
        { k: 'p8', no: 8, name: '5V', net: '5V' }
      ] },
    { id: 'lcd', tag: 'LCD', topic: 'fsmc', sch: 'board-15', kind: 'header', label: 'TFT-LCD', screen: true,
      pins: (function () {
        // U13 2×14 排母：奇数脚在左，偶数脚在右
        var L = [['GND', null, 'GND'], ['GND', null, 'GND'], ['T_SDA', 'PB7', null, '触摸芯片 I2C1 数据'], ['T_SCL', 'PB6', null, '触摸芯片 I2C1 时钟'], ['T_INT', 'PC1', null, '触摸中断'],
          ['BL', 'PB0', null, '背光'], ['RST', 'PG15', null, '屏复位'], ['CS', 'PG12', null, 'FSMC_NE4：Bank1 第 4 区，地址 0x6C00 0000 起'], ['RS', 'PG0', null, 'FSMC_A10：0 = 命令，1 = 数据'],
          ['WR', 'PD5', null, 'FSMC_NWE 写'], ['RD', 'PD4', null, 'FSMC_NOE 读'], ['D15', 'PD10'], ['D14', 'PD9'], ['D13', 'PD8']];
        var R = [['3V3', null, '3V3'], ['D0', 'PD14'], ['D1', 'PD15'], ['D2', 'PD0'], ['D3', 'PD1'], ['D4', 'PE7'], ['D5', 'PE8'], ['D6', 'PE9'],
          ['D7', 'PE10'], ['D8', 'PE11'], ['D9', 'PE12'], ['D10', 'PE13'], ['D11', 'PE14'], ['D12', 'PE15']];
        var out = [];
        for (var i = 0; i < 14; i++) [L[i], R[i]].forEach(function (x, j) {
          var no = i * 2 + 1 + j, o = { k: 'p' + no, no: no, name: x[0] };
          if (x[1]) o.mcu = x[1]; if (x[2]) o.net = x[2];
          o.note = x[3] || (/^D\d+$/.test(x[0]) ? 'FSMC 数据线 ' + x[0] : '');
          out.push(o);
        });
        return out;
      })() }
  ];
  MODULES.forEach(function (m) { m.pins.forEach(function (p) { if (!p.note) delete p.note; }); });
  W.STM32_MODULES = MODULES;

  /* ---------- 画图 ---------- */
  var STM = W.STM;
  if (!STM || !STM.ui) return;
  var sv = STM.ui.sv;

  function txt(g, x, y, s, cls, anchor) { var t = sv('text', { x: x, y: y, 'class': cls, 'text-anchor': anchor || 'middle', 'dominant-baseline': 'central' }, s); g.appendChild(t); return t; }
  function conn(p) { var c = p.mcu || p.net || ''; return c === p.name ? '' : c; }
  function connCls(p) { return 'mc ' + (p.mcu ? 'to-mcu' : 'to-net'); }
  // 一个可点的脚：g.mp[data-mp]，带一个透明的点击区
  function mpGroup(p, hit) {
    var g = sv('g', { 'class': 'mp', 'data-mp': p.k, tabindex: '-1', role: 'button', 'aria-label': p.name + (conn(p) ? '，接 ' + conn(p) : '') });
    hit['class'] = 'hit'; g.appendChild(sv('rect', hit));
    return g;
  }

  // SOP-8：1~4 在左边自上而下，5~8 在右边自下而上
  function sop8(m) {
    var Wd = 440, H = 250, bx = 170, by = 46, bw = 100, bh = 158, pitch = 36, LD = 18, lw = 10;
    var s = sv('svg', { viewBox: '0 0 ' + Wd + ' ' + H }), pos = {};
    var body = sv('g', { 'class': 'mod-body' });
    body.appendChild(sv('rect', { x: bx, y: by, width: bw, height: bh, rx: 6, 'class': 'pkg' }));
    body.appendChild(sv('circle', { cx: bx + 16, cy: by + 16, r: 5, 'class': 'dot' }));
    txt(body, bx + bw / 2, by + bh / 2 - 8, m.mark || m.tag, 'mark');
    txt(body, bx + bw / 2, by + bh / 2 + 14, m.bus || '', 'mark2');
    s.appendChild(body);
    m.pins.forEach(function (p) {
      var left = p.no <= 4, k = left ? p.no - 1 : 8 - p.no, cy = by + bh / 2 + (k - 1.5) * pitch;
      var g = mpGroup(p, left ? { x: 0, y: cy - pitch / 2, width: bx + 12, height: pitch } : { x: bx + bw - 12, y: cy - pitch / 2, width: Wd - bx - bw + 12, height: pitch });
      g.appendChild(sv('rect', { x: left ? bx - LD : bx + bw, y: cy - lw / 2, width: LD, height: lw, rx: 1.5, 'class': 'ld' }));
      txt(g, left ? bx + 9 : bx + bw - 9, cy, p.no, 'no');
      txt(g, left ? bx - LD - 8 : bx + bw + LD + 8, cy, p.name, 'nm', left ? 'end' : 'start');
      txt(g, left ? bx - LD - 70 : bx + bw + LD + 70, cy, conn(p), connCls(p), left ? 'end' : 'start');
      s.appendChild(g); pos[p.k] = { x: left ? bx - LD : bx + bw + LD, y: cy };
    });
    return { svg: s, w: Wd, h: H, pos: pos };
  }

  // 2×N 排针 / 排母：奇数脚左列，偶数脚右列，自上而下
  function header(m) {
    var rows = Math.ceil(m.pins.length / 2), pitch = 26, top = m.screen ? 128 : 52, cx = 230, hw = 30;
    var Wd = 460, H = top + rows * pitch + 26, s = sv('svg', { viewBox: '0 0 ' + Wd + ' ' + H }), pos = {};
    var body = sv('g', { 'class': 'mod-body' });
    if (m.screen) {
      body.appendChild(sv('rect', { x: cx - 120, y: 14, width: 240, height: 84, rx: 8, 'class': 'glass' }));
      body.appendChild(sv('rect', { x: cx - 108, y: 24, width: 216, height: 64, rx: 3, 'class': 'glass-in' }));
      txt(body, cx, 56, m.label, 'mark');
      body.appendChild(sv('path', { d: 'M' + (cx - 40) + ' 98V' + (top - 14) + 'M' + (cx + 40) + ' 98V' + (top - 14), 'class': 'fpc' }));
    } else txt(body, cx, 24, m.label || m.tag, 'mark-o');
    body.appendChild(sv('rect', { x: cx - hw, y: top - 12, width: hw * 2, height: rows * pitch + 4, rx: 4, 'class': 'hdr' }));
    s.appendChild(body);
    m.pins.forEach(function (p) {
      var left = p.no % 2 === 1, r = Math.floor((p.no - 1) / 2), cy = top + r * pitch, px = cx + (left ? -13 : 13);
      var g = mpGroup(p, left ? { x: 0, y: cy - pitch / 2, width: cx, height: pitch } : { x: cx, y: cy - pitch / 2, width: Wd - cx, height: pitch });
      g.appendChild(sv('rect', { x: px - 5, y: cy - 5, width: 10, height: 10, rx: p.no === 1 ? 1 : 5, 'class': 'ld pinhd' }));
      txt(g, left ? cx - hw - 10 : cx + hw + 10, cy, p.name, 'nm', left ? 'end' : 'start');
      txt(g, left ? cx - hw - 82 : cx + hw + 82, cy, conn(p), connCls(p), left ? 'end' : 'start');
      txt(g, left ? cx - hw - 160 : cx + hw + 160, cy, p.no, 'no2', left ? 'end' : 'start');
      s.appendChild(g); pos[p.k] = { x: px, y: cy };
    });
    return { svg: s, w: Wd, h: H, pos: pos };
  }

  // 一排器件（LED / 按键）：每个一格，下面写名字和接的脚
  function row(m, draw) {
    var n = m.pins.length, cw = 92, Wd = n * cw + 20, H = 190, s = sv('svg', { viewBox: '0 0 ' + Wd + ' ' + H }), pos = {};
    m.pins.forEach(function (p, i) {
      var cx = 10 + cw * i + cw / 2, g = mpGroup(p, { x: cx - cw / 2, y: 0, width: cw, height: H });
      draw(g, p, cx, 70);
      txt(g, cx, 138, p.name, 'nm');
      txt(g, cx, 162, conn(p), connCls(p));
      s.appendChild(g); pos[p.k] = { x: cx, y: 70 };
    });
    return { svg: s, w: Wd, h: H, pos: pos };
  }
  function ledPart(g, p, cx, cy) {
    g.appendChild(sv('rect', { x: cx - 24, y: cy - 9, width: 10, height: 18, rx: 2, 'class': 'ld' }));
    g.appendChild(sv('rect', { x: cx + 14, y: cy - 9, width: 10, height: 18, rx: 2, 'class': 'ld' }));
    if (p.color === 'rgb') {
      g.appendChild(sv('rect', { x: cx - 20, y: cy - 20, width: 40, height: 40, rx: 4, 'class': 'ledbody' }));
      g.appendChild(sv('circle', { cx: cx, cy: cy, r: 14, 'class': 'lens lens-rgb' }));
      [['r', -6, -4], ['g', 6, -4], ['b', 0, 6]].forEach(function (d) { g.appendChild(sv('circle', { cx: cx + d[1], cy: cy + d[2], r: 4, 'class': 'lens rgb-' + d[0] })); });
    } else {
      g.appendChild(sv('rect', { x: cx - 16, y: cy - 12, width: 32, height: 24, rx: 3, 'class': 'ledbody' }));
      g.appendChild(sv('rect', { x: cx - 10, y: cy - 8, width: 20, height: 16, rx: 3, 'class': 'lens lens-' + p.color }));
    }
  }
  function keyPart(g, p, cx, cy) {
    [[-26, -22], [26, -22], [-26, 22], [26, 22]].forEach(function (d) { g.appendChild(sv('rect', { x: cx + d[0] - (d[0] < 0 ? 8 : 0), y: cy + d[1] - 3, width: 8, height: 6, rx: 1, 'class': 'ld' })); });
    g.appendChild(sv('rect', { x: cx - 26, y: cy - 26, width: 52, height: 52, rx: 4, 'class': 'keybody' }));
    g.appendChild(sv('circle', { cx: cx, cy: cy, r: 15, 'class': 'keycap' + (p.k === 'rst' ? ' rst' : '') }));
  }

  function beep(m) {
    var Wd = 470, H = 260, s = sv('svg', { viewBox: '0 0 ' + Wd + ' ' + H }), pos = {}, P = {};
    m.pins.forEach(function (p) { P[p.k] = p; });
    var bx = 130, by = 96, mx = 320, my = 186;
    var body = sv('g', { 'class': 'mod-body' });
    // 走线：蜂鸣器负极 → MOS 管 D
    body.appendChild(sv('path', { d: 'M' + (bx + 22) + ' ' + (by + 82) + 'V' + my + 'H' + (mx - 32), 'class': 'trace' }));
    body.appendChild(sv('circle', { cx: bx, cy: by, r: 62, 'class': 'pkg' }));
    body.appendChild(sv('circle', { cx: bx, cy: by, r: 46, 'class': 'ring' }));
    body.appendChild(sv('circle', { cx: bx, cy: by, r: 7, 'class': 'hole' }));
    txt(body, bx - 34, by - 30, '+', 'mark');
    body.appendChild(sv('rect', { x: mx - 18, y: my - 24, width: 36, height: 48, rx: 3, 'class': 'pkg' }));
    txt(body, mx, my, 'Q', 'mark2');
    txt(body, mx, my - 40, m.part, 'mark-o');
    s.appendChild(body);
    function leg(p, rect, lx, ly, anchor, hit, cx2, horiz) {
      var g = mpGroup(p, hit);
      rect.rx = 2; rect['class'] = 'ld'; g.appendChild(sv('rect', rect));
      txt(g, lx, ly, p.name, 'nm', anchor);
      if (conn(p)) txt(g, horiz ? lx + 26 : lx, horiz ? ly : ly + 22, conn(p), connCls(p), anchor);
      s.appendChild(g); pos[p.k] = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    }
    leg(P.bp, { x: bx - 26, y: by + 58, width: 8, height: 24 }, bx - 22, by + 104, 'middle', { x: bx - 60, y: by + 40, width: 60, height: 110 });
    leg(P.bn, { x: bx + 18, y: by + 58, width: 8, height: 24 }, bx + 22, by + 104, 'middle', { x: bx, y: by + 40, width: 60, height: 110 });
    leg(P.d, { x: mx - 32, y: my - 4, width: 14, height: 8 }, mx - 26, my - 20, 'middle', { x: mx - 60, y: my - 40, width: 42, height: 70 });
    leg(P.g, { x: mx + 18, y: my - 16, width: 14, height: 8 }, mx + 42, my - 12, 'start', { x: mx + 18, y: my - 34, width: Wd - mx - 18, height: 34 }, 0, true);
    leg(P.s, { x: mx + 18, y: my + 8, width: 14, height: 8 }, mx + 42, my + 12, 'start', { x: mx + 18, y: my, width: Wd - mx - 18, height: 34 }, 0, true);
    return { svg: s, w: Wd, h: H, pos: pos };
  }

  function pot(m) {
    var Wd = 360, H = 260, cx = 180, cy = 92, s = sv('svg', { viewBox: '0 0 ' + Wd + ' ' + H }), pos = {};
    var body = sv('g', { 'class': 'mod-body' });
    body.appendChild(sv('rect', { x: cx - 48, y: cy - 48, width: 96, height: 96, rx: 8, 'class': 'potbody' }));
    body.appendChild(sv('circle', { cx: cx, cy: cy, r: 32, 'class': 'rotor' }));
    body.appendChild(sv('path', { d: 'M' + (cx - 18) + ' ' + cy + 'H' + (cx + 18) + 'M' + cx + ' ' + (cy - 18) + 'V' + (cy + 18), 'class': 'slot' }));
    txt(body, cx, cy - 64, m.part, 'mark-o');
    s.appendChild(body);
    m.pins.forEach(function (p, i) {
      var x = cx + (i - 1) * 40, g = mpGroup(p, { x: x - 20, y: cy + 40, width: 40, height: H - cy - 40 });
      g.appendChild(sv('rect', { x: x - 4, y: cy + 48, width: 8, height: 40, rx: 2, 'class': 'ld' }));
      txt(g, x, cy + 106, p.name, 'nm');
      txt(g, x, cy + 130, conn(p), connCls(p));
      s.appendChild(g); pos[p.k] = { x: x, y: cy + 88 };
    });
    return { svg: s, w: Wd, h: H, pos: pos };
  }

  var DRAW = { sop8: sop8, header: header, beep: beep, pot: pot,
    leds: function (m) { return row(m, ledPart); }, keys: function (m) { return row(m, keyPart); } };

  /* draw(id, {onPick}) → { svg, w, h, pos, select(k) } */
  function draw(id, opt) {
    opt = opt || {};
    var m = byId[id]; if (!m) return null;
    var d = DRAW[m.kind](m), g = {};
    d.svg.setAttribute('class', 'mod mod-' + m.kind);
    d.svg.setAttribute('role', 'group'); d.svg.setAttribute('aria-label', m.tag);
    Array.prototype.forEach.call(d.svg.querySelectorAll('[data-mp]'), function (n) { g[n.getAttribute('data-mp')] = n; });
    var first = m.pins[0] && g[m.pins[0].k]; if (first) first.setAttribute('tabindex', '0');
    d.select = function (k) {
      Object.keys(g).forEach(function (x) { g[x].classList.toggle('sel', x === k); g[x].setAttribute('tabindex', x === k ? '0' : '-1'); });
      if (!k && first) first.setAttribute('tabindex', '0');
    };
    var pick = opt.onPick || function () {};
    d.svg.addEventListener('click', function (e) { var t = e.target.closest && e.target.closest('[data-mp]'); if (t) pick(t.getAttribute('data-mp')); });
    d.svg.addEventListener('keydown', function (e) {
      var t = e.target.closest && e.target.closest('[data-mp]'); if (!t) return;
      var keys = m.pins.map(function (p) { return p.k; }), i = keys.indexOf(t.getAttribute('data-mp'));
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(keys[i]); return; }
      var dd = (e.key === 'ArrowRight' || e.key === 'ArrowDown') ? 1 : (e.key === 'ArrowLeft' || e.key === 'ArrowUp') ? -1 : 0;
      if (!dd) return;
      e.preventDefault();
      var nx = g[keys[(i + dd + keys.length) % keys.length]];
      t.setAttribute('tabindex', '-1'); nx.setAttribute('tabindex', '0'); try { nx.focus({ preventScroll: true }); } catch (err) { nx.focus(); }
    });
    return d;
  }
  var byId = {}; MODULES.forEach(function (m) { byId[m.id] = m; });
  STM.modules = { list: MODULES, byId: byId, draw: draw };
})();
