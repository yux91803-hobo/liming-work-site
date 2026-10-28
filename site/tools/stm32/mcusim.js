/* mcusim.js — 教学用 STM32F103 + 开发板模拟器（不碰 DOM，可在 Node 里测试）
   目的：让「编程思维」里一行行推出来的 C 代码真的跑起来，交换两行以后能看到线上 / 灯上 / 串口里发生了什么。
   · 代码：把课程里用到的 C 子集转成 JS 执行（寄存器读写、位运算、if / for / while、函数、#define、字符串、printf）。
   · 时间：离散事件。每次访问寄存器花一点点时间；Delay_us / Delay_ms 推进时间；while 轮询时直接跳到下一个外设事件。
   · 外设：RCC 门控、GPIO（8 种模式与引脚电平）、USART1、TIM2 / 5 / 6、ADC1、SPI1、NVIC。
   · 板子：LED1~3（低电平亮）、KEY1~4、电位器 PC0、W25Q32（SPI1，片选 PC13）、经 STLink 虚拟串口相连的电脑。
   这是教学模型：行为按 RM0008 / 数据手册取主干，细节有简化，界面上会说明。 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.STM32McuSim = api;
})(typeof window === 'object' ? window : this, function () {
  'use strict';

  /* ===================== 常量：寄存器字段宏（来自 registers.js） ===================== */
  var CONST_CACHE = null;
  function consts(regs) {
    if (CONST_CACHE && !regs) return CONST_CACHE;
    regs = regs || (typeof window === 'object' && window.STM32_REGS) || (typeof globalThis === 'object' && globalThis.STM32_REGS);
    var o = {};
    if (regs) regs.groups.forEach(function (g) {
      g.regs.forEach(function (r) {
        [r.fields].concat((r.alt || []).map(function (a) { return a.fields; })).forEach(function (fs) {
          fs.forEach(function (f) {
            if (!f.cmsis) return;
            var w = f.bits[0] - f.bits[1] + 1, m = ((Math.pow(2, w) - 1) * Math.pow(2, f.bits[1])) >>> 0;
            o[f.cmsis] = m;
            if (w > 1) for (var k = 0; k < w; k++) o[f.cmsis + '_' + k] = Math.pow(2, f.bits[1] + k) >>> 0;
          });
        });
      });
    });
    // 中断号（大容量 F103）
    o.TIM2_IRQn = 28; o.TIM5_IRQn = 50; o.TIM6_IRQn = 54; o.TIM7_IRQn = 55; o.USART1_IRQn = 37; o.SPI1_IRQn = 35; o.ADC1_2_IRQn = 18; o.EXTI9_5_IRQn = 23;
    if (!regs) return o;
    CONST_CACHE = o; return o;
  }
  var IRQ_NAME = { 28: 'TIM2_IRQHandler', 50: 'TIM5_IRQHandler', 54: 'TIM6_IRQHandler', 55: 'TIM7_IRQHandler', 37: 'USART1_IRQHandler', 35: 'SPI1_IRQHandler', 18: 'ADC1_2_IRQHandler' };

  /* ===================== C 子集 → JS ===================== */
  function stripComments(s) { return s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ''); }
  function matchParen(s, i) { var d = 0; for (var k = i; k < s.length; k++) { if (s[k] === '(') d++; else if (s[k] === ')') { d--; if (!d) return k; } } return -1; }
  var TYPES = '(?:u?int(?:8|16|32)_t|int|unsigned|char|double|float|long|short)', LOOP_ID = 0;
  function body(src) {
    var s = stripComments(src);
    s = s.replace(/'(\\.|[^'\\])'/g, function (_, c) { var m = { '\\0': 0, '\\n': 10, '\\r': 13, '\\t': 9, "\\'": 39, '\\\\': 92 }; return String(c.length > 1 ? m[c] : c.charCodeAt(0)); });
    s = s.replace(/"((?:\\.|[^"\\])*)"/g, function (_, c) { return '__s(' + JSON.stringify(JSON.parse('"' + c + '"')) + ')'; });
    s = s.replace(/->/g, '.');
    s = s.replace(new RegExp('\\(\\s*(?:const\\s+)?(?:volatile\\s+)?' + TYPES + '\\s*\\*?\\s*\\)', 'g'), '');
    s = s.replace(new RegExp('\\b(?:static\\s+)?(?:volatile\\s+)?(?:const\\s+)?' + TYPES + '\\s+(?=[A-Za-z_])', 'g'), 'var ');
    s = s.replace(/\b(0x[0-9A-Fa-f]+|\d+)[uUlL]+\b/g, '$1');
    // 循环里插入「时间流逝」检查：while 可以在空转时跳到下一个外设事件；for 每圈固定花一点时间
    var out = '', i = 0, re = /\b(while|for)\s*\(/g, m;
    while ((m = re.exec(s))) {
      var open = s.indexOf('(', m.index), close = matchParen(s, open);
      if (close < 0) throw new Error('括号不配对');
      var inner = s.slice(open + 1, close), repl;
      if (m[1] === 'while') repl = 'while ((' + inner + ') && __tw(' + (++LOOP_ID) + '))';
      else {
        var parts = [], dep = 0, last = 0;
        for (var k = 0; k < inner.length; k++) { var ch = inner[k]; if (ch === '(') dep++; else if (ch === ')') dep--; else if (ch === ';' && !dep) { parts.push(inner.slice(last, k)); last = k + 1; } }
        parts.push(inner.slice(last));
        repl = 'for (' + parts[0] + '; (' + (parts[1].trim() || '1') + ') && __tf(); ' + parts[2] + ')';
      }
      out += s.slice(i, m.index) + repl; i = close + 1; re.lastIndex = close + 1;
    }
    return out + s.slice(i);
  }
  function sigToJs(sig) {
    var m = /^\s*(?:static\s+)?(?:void|[A-Za-z_][A-Za-z0-9_]*)\s*\*?\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)/.exec(sig);
    if (!m) throw new Error('看不懂的函数头：' + sig);
    var ps = m[2].trim() === 'void' || !m[2].trim() ? [] : m[2].split(',').map(function (p) { var x = /([A-Za-z_][A-Za-z0-9_]*)\s*(?:\[\s*\])?\s*$/.exec(p.trim()); return x ? x[1] : 'p'; });
    return { name: m[1], params: ps };
  }
  function macro(line) {
    var s = stripComments(line).trim();
    var m = /^#define\s+([A-Za-z_][A-Za-z0-9_]*)\(([^)]*)\)\s+(.*)$/.exec(s);
    if (m) return 'var ' + m[1] + ' = function (' + m[2] + ') { return (' + body(m[3]) + '); };';
    m = /^#define\s+([A-Za-z_][A-Za-z0-9_]*)\s+(.*)$/.exec(s);
    if (m) return 'var ' + m[1] + ' = (' + body(m[2]) + ');';
    if (!s || /^#include/.test(s)) return '';
    return body(s);
  }
  // fns：{ 名字: { sig, pre[], lines[] } }；globals：全局变量 / 宏的行
  function compile(fns, globals) {
    var src = ['"use strict";'], names = [];
    (globals || []).forEach(function (l) { src.push(macro(typeof l === 'string' ? l : l.c)); });
    Object.keys(fns).forEach(function (k) { (fns[k].pre || []).forEach(function (l) { src.push(macro(l.c)); }); });
    Object.keys(fns).forEach(function (k) {
      var f = fns[k], sg = sigToJs(f.sig);
      src.push('var ' + k + ' = function (' + sg.params.join(', ') + ') {');   // 用表里的名字（两个版本的 main 可以并存）
      var prev = '{';
      f.lines.forEach(function (l, i) {
        if (!l) return;
        var js = body(l.c), t = stripComments(l.c).trim();
        // 上一行是不带花括号的 if / for / while / else 头：这一行是它的循环体，不能在前面再插语句
        var boundary = /[;{}]$/.test(prev) || !prev;
        src.push((boundary && t ? '__ln(' + JSON.stringify(k) + ',' + i + '); ' : '') + js);
        if (t) prev = t;
      });
      src.push('};');
      names.push(k);
    });
    src.push('return {' + names.map(function (n) { return JSON.stringify(n) + ': ' + n; }).join(', ') + '};');
    return src.join('\n');
  }

  /* ===================== 机器 ===================== */
  function Stop(kind, text) { this.kind = kind; this.text = text; }
  var F_PCLK2 = 72, F_TIM = 72;     // MHz

  function Machine(opt) {
    opt = opt || {};
    var M = this;
    M.t = 0; M.budget = (opt.ms || 1000) * 1000; M.log = []; M.warned = {}; M.printf = ''; M.line = null;
    M.writes = 0; M.reads = 0; M.delays = 0; M.lastRead = ''; M.tickW = 0; M.tickR = 0; M.loops = {};
    M.inIrq = false; M.irqEnabled = {}; M.irqStorm = 0; M.irqStormT = -1;
    M.board = opt.board || {};
    M.trace = {}; M.levels = {};
    M.rcc = { APB2ENR: 0, APB1ENR: 0, AHBENR: 0x14, CFGR: 0x001D040A >>> 0 };   // 系统时钟已由启动文件配成 72 MHz（PLL），APB1 ÷2
    M.gpio = {}; 'ABCDEFG'.split('').forEach(function (p, k) { M.gpio[p] = new Gpio(M, p, k + 2); });
    M.usart1 = new Usart(M); M.tim = { 2: new Tim(M, 2), 5: new Tim(M, 5), 6: new Tim(M, 6) };
    M.adc1 = new Adc(M); M.spi1 = new Spi(M); M.flash = new W25Q(M, opt.flash || {}); M.pc = new Pc(M, opt.board && opt.board.rx);
    M.periphs = [M.usart1, M.tim[2], M.tim[5], M.tim[6], M.adc1, M.spi1, M.flash, M.pc];
    M.watch = ['PA0', 'PA1', 'PA8', 'PA9', 'PA10', 'PA5', 'PA6', 'PA7', 'PC13', 'PF8', 'PF10', 'PC0'];
    M.watch.forEach(function (p) { M.trace[p] = []; });
    M.keys = (M.board.keys || []).map(function (k) { return { pin: k.pin, level: k.level != null ? k.level : (/PF(8|9)$/.test(k.pin) ? 0 : 1), down: expandBounce(k) }; });
    M.updatePins();
  }
  function expandBounce(k) {
    var out = [];
    (k.down || []).forEach(function (d) {
      var t0 = d[0] * 1000, t1 = d[1] * 1000;
      if (k.bounce) { [0, 300, 700, 1300].forEach(function (o, i) { if (i % 2 === 0) out.push([t0 + o, t0 + o + 200]); }); out.push([t0 + 1600, t1]); out.push([t1 + 400, t1 + 900]); }
      else out.push([t0, t1]);
    });
    return out;
  }
  Machine.prototype.note = function (k, text) { this.log.push({ t: this.t, k: k, text: text }); };
  Machine.prototype.warnOnce = function (key, text) { if (this.warned[key]) return; this.warned[key] = 1; this.note('warn', text); };
  Machine.prototype.clockOn = function (bus, bit) { return !!(this.rcc[bus] & (1 << bit)); };
  // 引脚：'PA9' → { port, n }
  Machine.prototype.pinCfg = function (name) {
    var g = this.gpio[name[1]], n = Number(name.slice(2)), reg = n < 8 ? g.CRLv : g.CRHv, nib = (reg >>> ((n & 7) * 4)) & 0xF;
    return { g: g, n: n, mode: nib & 3, cnf: nib >> 2, odr: (g.ODRv >> n) & 1 };
  };
  // 外部电路对引脚的驱动（没有就 undefined）
  Machine.prototype.ext = function (name, t) {
    var M = this, b = M.board;
    for (var i = 0; i < M.keys.length; i++) { var k = M.keys[i]; if (k.pin === name && k.down.some(function (d) { return t >= d[0] && t < d[1]; })) return k.level; }
    if (name === 'PA10') return M.pc.txLevel(t);
    if (name === 'PA6') return M.flash.doLevel();
    return undefined;
  };
  // 外设复用输出
  Machine.prototype.af = function (name) {
    var M = this;
    if (name === 'PA9') return M.usart1.txLevel();
    if (name === 'PA0') { var v = M.tim[2].ocLevel(1); if (v === undefined) v = M.tim[5].ocLevel(1); return v; }
    if (name === 'PA1') { var w = M.tim[5].ocLevel(2); if (w === undefined) w = M.tim[2].ocLevel(2); return w; }
    if (name === 'PA5') return M.spi1.sckLevel();
    if (name === 'PA7') return M.spi1.mosiLevel();
    return undefined;
  };
  Machine.prototype.level = function (name) {
    var c = this.pinCfg(name), e = this.ext(name, this.t);
    if (c.mode === 0) {
      if (c.cnf === 0) return e !== undefined ? e : 'Z';            // 模拟输入：数字部分断开
      if (c.cnf === 2) return e !== undefined ? e : c.odr;           // 上拉 / 下拉
      return e !== undefined ? e : 'Z';                              // 浮空
    }
    var drv;
    if (c.cnf === 0) drv = c.odr;
    else if (c.cnf === 1) drv = c.odr ? undefined : 0;
    else if (c.cnf === 2) { drv = this.af(name); if (drv === undefined) drv = 'Z'; }
    else { var a = this.af(name); drv = a === 0 ? 0 : undefined; }
    if (drv === undefined) return e !== undefined ? e : 'Z';
    if (e !== undefined && e !== drv && drv !== 'Z') this.warnOnce('fight' + name, name + '：引脚在输出 ' + drv + '，外面的电路却在把它拉向 ' + e + '——两边在「打架」。');
    return drv;
  };
  Machine.prototype.updatePins = function () {
    var M = this;
    M.watch.forEach(function (p) {
      var v = M.level(p), tr = M.trace[p];
      if (!tr.length || tr[tr.length - 1][1] !== v) {
        if (tr.length && tr[tr.length - 1][0] === M.t) tr[tr.length - 1][1] = v; else tr.push([M.t, v]);
        if (p === 'PC13' && M.flash) M.flash.checkCs();
      }
      M.levels[p] = v;
    });
  };
  Machine.prototype.read = function (name) {   // IDR 位
    var c = this.pinCfg(name);
    if (c.mode === 0 && c.cnf === 0) return 0;   // 模拟模式下 IDR 读 0
    var v = this.level(name);
    if (v === 'Z') { this.warnOnce('float' + name, name + ' 是浮空的：没有任何东西决定它的电平，读到的值不可靠（模拟器里当作 0）。'); return 0; }
    return v;
  };
  // ---- 时间 ----
  Machine.prototype.nextEvent = function () {
    var M = this, best = Infinity;
    M.periphs.forEach(function (p) { var x = p.next(); if (x < best) best = x; });
    M.keys.forEach(function (k) { k.down.forEach(function (d) { if (d[0] > M.t && d[0] < best) best = d[0]; if (d[1] > M.t && d[1] < best) best = d[1]; }); });
    return best;
  };
  Machine.prototype.advanceTo = function (T) {
    var M = this, guard = 0;
    while (true) {
      var e = M.nextEvent();
      if (e > T) break;
      if (e > M.budget) { M.t = M.budget; M.updatePins(); throw new Stop('end', '到达模拟时长'); }
      if (++guard > 400000) throw new Stop('error', '事件太多，模拟中止');
      M.t = Math.max(M.t, e);
      M.periphs.forEach(function (p) { p.fire(M.t); });
      M.updatePins();
      M.irq();
    }
    if (T > M.budget) { M.t = M.budget; M.updatePins(); throw new Stop('end', '到达模拟时长'); }
    M.t = Math.max(M.t, T);
    M.updatePins();
    M.irq();
  };
  Machine.prototype.spend = function (us) { this.advanceTo(this.t + us); };
  Machine.prototype.access = function (write, what) {
    if (write) this.writes++; else { this.reads++; this.lastRead = what; }
    this.spend(0.03);
  };
  Machine.prototype.after = function () { this.updatePins(); this.irq(); };
  // while 每转一圈：这一圈什么都没写（只在读标志或空转）→ 直接跳到下一个外设事件
  Machine.prototype.tickWhile = function (id) {
    var M = this, last = M.loops[id] || (M.loops[id] = { w: -1, d: -1, r: -1 });
    M.tickW = last.w; M.tickR = last.r;
    if (M.writes === last.w && M.delays === last.d) {
      var e = M.nextEvent();
      if (e === Infinity) {
        // 空的 while(1)，或者在等按键 / 串口这类外部输入：后面再也不会发生什么，正常结束
        if (M.reads === M.tickR || /IDR|USART1->SR/.test(M.lastRead)) { M.t = M.budget; M.updatePins(); throw new Stop('end', '到达模拟时长'); }
        throw new Stop('stuck', '程序卡在 while 循环里：一直在读 ' + (M.lastRead || '某个寄存器') + '，等的标志永远不会出现。');
      }
      M.advanceTo(Math.max(e, M.t + 0.01));
    } else M.spend(0.05);
    last.w = M.writes; last.d = M.delays; last.r = M.reads;
    return true;
  };
  Machine.prototype.tickFor = function () { this.spend(0.14); return true; };   // 约 10 个时钟周期（不优化编译时的空循环）
  // ---- 中断 ----
  Machine.prototype.irq = function () {
    var M = this;
    if (M.inIrq || !M.handlers) return;
    for (var guard = 0; guard < 50; guard++) {
      var fired = false;
      for (var n in M.irqEnabled) {
        if (!M.irqEnabled[n]) continue;
        var src = n == 54 ? M.tim[6] : n == 50 ? M.tim[5] : n == 28 ? M.tim[2] : n == 37 ? M.usart1 : n == 18 ? M.adc1 : null;
        if (!src || !src.irqPending()) continue;
        var h = M.handlers[IRQ_NAME[n]];
        if (!h) throw new Stop('nohandler', '中断 ' + IRQ_NAME[n].replace('Handler', '') + ' 被触发了，但程序里没有 ' + IRQ_NAME[n] + ' 这个函数：CPU 跳进了默认处理函数（一个死循环）。');
        M.inIrq = true; M.t += 0.17;
        try { h(); } finally { M.inIrq = false; }
        // 处理函数返回时标志还在：CPU 会立刻再进来
        if (src.irqPending()) { if (++M.irqStorm > 60) throw new Stop('irq', '中断一结束又立刻进入：' + IRQ_NAME[n] + ' 里没有清掉中断标志，CPU 永远出不来，主程序停住了。'); }
        else M.irqStorm = 0;
        fired = true;
      }
      if (!fired) return;
    }
  };

  /* ===================== GPIO ===================== */
  function Gpio(M, port, bit) { this.M = M; this.p = port; this.bit = bit; this.CRLv = 0x44444444; this.CRHv = 0x44444444; this.ODRv = 0; }
  Gpio.prototype.on = function (what, write) {
    if (this.M.clockOn('APB2ENR', this.bit)) return true;
    this.M.warnOnce('clk' + this.p + (write ? 'w' : 'r'), (write ? '写' : '读') + ' GPIO' + this.p + '_' + what + ' 时 GPIO' + this.p + ' 的时钟还没开：' + (write ? '这次写入不起作用。' : '读出来是 0。'));
    return false;
  };
  function reg(obj, name, get, set) { Object.defineProperty(obj, name, { get: get, set: set, enumerable: true }); }
  function gpioRegs(M, g) {
    var o = {};
    reg(o, 'CRL', function () { M.access(false, 'GPIO' + g.p + '->CRL'); return g.on('CRL') ? g.CRLv : 0; }, function (v) { M.access(true); if (g.on('CRL', 1)) { g.CRLv = v >>> 0; M.after(); } });
    reg(o, 'CRH', function () { M.access(false, 'GPIO' + g.p + '->CRH'); return g.on('CRH') ? g.CRHv : 0; }, function (v) { M.access(true); if (g.on('CRH', 1)) { g.CRHv = v >>> 0; M.after(); } });
    reg(o, 'ODR', function () { M.access(false, 'GPIO' + g.p + '->ODR'); return g.on('ODR') ? g.ODRv : 0; }, function (v) { M.access(true); if (g.on('ODR', 1)) { g.ODRv = v & 0xFFFF; M.after(); } });
    reg(o, 'IDR', function () {
      M.access(false, 'GPIO' + g.p + '->IDR'); if (!g.on('IDR')) return 0;
      var v = 0;
      for (var n = 0; n < 16; n++) {
        var name = 'P' + g.p + n, wired = (M.board.keys || []).some(function (k) { return k.pin === name; });
        if (wired) v |= M.read(name) << n;                                  // 接了按键的脚：浮空时给出警告
        else { var lv = M.level(name); v |= (lv === 1 ? 1 : 0) << n; }     // 其它脚：安静地按电平算
      }
      return v;
    }, function () { M.access(true); });
    reg(o, 'BSRR', function () { M.access(false); return 0; }, function (v) { M.access(true); if (g.on('BSRR', 1)) { v = v >>> 0; g.ODRv = (g.ODRv | (v & 0xFFFF)) & ~(v >>> 16) & 0xFFFF; M.after(); } });
    reg(o, 'BRR', function () { M.access(false); return 0; }, function (v) { M.access(true); if (g.on('BRR', 1)) { g.ODRv = g.ODRv & ~(v & 0xFFFF) & 0xFFFF; M.after(); } });
    return o;
  }

  /* ===================== USART1 ===================== */
  function Usart(M) { this.M = M; this.SR = 0xC0; this.BRR = 0; this.CR1 = 0; this.CR2 = 0; this.CR3 = 0; this.tdr = null; this.rdr = 0; this.shift = null; this.out = 1; this.rxq = []; this.edges = []; }
  Usart.prototype.en = function () { return this.M.clockOn('APB2ENR', 14); };
  Usart.prototype.on = function () { return (this.CR1 & 0x2000) && (this.CR1 & 0x8); };
  Usart.prototype.bitUs = function () { return this.BRR ? this.BRR / F_PCLK2 : Infinity; };
  Usart.prototype.txLevel = function () { if (!(this.CR1 & 0x2000)) return undefined; return this.out; };
  Usart.prototype.frameBits = function (b) {
    var nb = this.CR1 & 0x1000 ? 9 : 8, pce = this.CR1 & 0x400, bits = [0];
    var data = pce ? nb - 1 : nb;
    for (var i = 0; i < data; i++) bits.push((b >> i) & 1);
    if (pce) { var p = 0; for (i = 0; i < data; i++) p ^= (b >> i) & 1; if (this.CR1 & 0x200) p ^= 1; bits.push(p); }
    var st = (this.CR2 >> 12) & 3; bits.push(1); if (st === 2) bits.push(1);
    return bits;
  };
  Usart.prototype.startNext = function (t) {
    if (this.shift || this.tdr === null || !this.on()) return;
    var b = this.tdr; this.tdr = null; this.SR |= 0x80;    // TXE：数据搬进移位寄存器，发送缓冲又空了
    var bits = b === 'idle' ? [1, 1, 1, 1, 1, 1, 1, 1, 1, 1] : this.frameBits(b), T = this.bitUs();
    this.shift = { bits: bits, t0: t, i: 0, T: T };
    this.out = bits[0];
  };
  Usart.prototype.next = function () { var a = this.shift ? this.shift.t0 + (this.shift.i + 1) * this.shift.T : Infinity, b = this.rxq.length ? this.rxq[0].done : Infinity; return Math.min(a, b); };
  Usart.prototype.fire = function (t) {
    var s = this.shift;
    while (s && t >= s.t0 + (s.i + 1) * s.T - 1e-9) {
      s.i++;
      if (s.i >= s.bits.length) { this.shift = null; this.out = 1; if (this.tdr !== null) this.startNext(t); else this.SR |= 0x40; s = this.shift; }
      else this.out = s.bits[s.i];
    }
    // 接收：电脑发来的帧
    var q = this.rxq;
    while (q.length && q[0].done <= t + 1e-9) {
      var f = q.shift();
      if (this.SR & 0x20) { this.SR |= 0x08; this.M.note('warn', 'USART1 溢出（ORE）：上一个字节还没读走，新的字节 0x' + hex2(f.b) + ' 丢了。'); }
      else { this.rdr = f.b; this.SR |= 0x20; }
    }
  };
  Usart.prototype.irqPending = function () { return ((this.CR1 & 0x20) && (this.SR & 0x28)) || ((this.CR1 & 0x80) && (this.SR & 0x80)) || ((this.CR1 & 0x40) && (this.SR & 0x40)); };
  function usartRegs(M, u) {
    var o = {};
    function chk(w, nm) { if (u.en()) return true; M.warnOnce('clkU' + w, (w ? '写' : '读') + ' USART1_' + nm + ' 时 USART1 的时钟还没开：' + (w ? '写入不起作用。' : '读出来是 0。')); return false; }
    reg(o, 'SR', function () { M.access(false, 'USART1->SR'); if (!chk(0, 'SR')) return 0; u.srRead = true; return u.SR; }, function (v) { M.access(true); if (chk(1, 'SR')) { u.SR &= (v | ~0x60); } });
    reg(o, 'DR', function () { M.access(false, 'USART1->DR'); if (!chk(0, 'DR')) return 0; if (u.srRead) u.SR &= ~0x08; u.srRead = false; u.SR &= ~0x20; return u.rdr; },
      function (v) {
        M.access(true); if (!chk(1, 'DR')) return;
        if (!u.on()) { M.warnOnce('txoff', '往 USART1->DR 写数据时 UE / TE 还没打开：这个字节没有发出去。'); return; }
        if (!(u.SR & 0x80)) M.note('warn', '发送缓冲还没空（TXE = 0）就写了 DR：上一个还没搬走的字节 0x' + hex2(u.tdr) + ' 被覆盖，丢了。');
        u.tdr = v & 0x1FF; u.SR &= ~0xC0; u.startNext(M.t); M.after();
      });
    reg(o, 'BRR', function () { M.access(false); return chk(0, 'BRR') ? u.BRR : 0; }, function (v) { M.access(true); if (chk(1, 'BRR')) { u.BRR = v & 0xFFFF; if (u.BRR) M.note('info', 'USART1 波特率 = 72 MHz ÷ ' + u.BRR + ' ≈ ' + Math.round(72e6 / u.BRR) + ' bit/s'); } });
    function cr1set(v) {
      var old = u.CR1; u.CR1 = v & 0x3FFF;
      var wasOn = (old & 0x2008) === 0x2008, isOn = (u.CR1 & 0x2008) === 0x2008;
      if (!wasOn && isOn) { u.tdr = u.tdr === null ? 'idle' : u.tdr; u.SR &= ~0x40; u.startNext(M.t); }   // 打开发送：先发一个空闲帧
      M.after();
    }
    reg(o, 'CR1', function () { M.access(false); return chk(0, 'CR1') ? u.CR1 : 0; }, function (v) { M.access(true); if (chk(1, 'CR1')) cr1set(v >>> 0); });
    reg(o, 'CR2', function () { M.access(false); return chk(0, 'CR2') ? u.CR2 : 0; }, function (v) { M.access(true); if (chk(1, 'CR2')) u.CR2 = v & 0x7FFF; });
    reg(o, 'CR3', function () { M.access(false); return chk(0, 'CR3') ? u.CR3 : 0; }, function (v) { M.access(true); if (chk(1, 'CR3')) u.CR3 = v & 0x7FF; });
    return o;
  }
  // 电脑这一端（STLink 虚拟串口，115200 8N1）：发送由场景给出，接收在结束后从 PA9 的波形解码
  function Pc(M, rx) {
    this.M = M; this.baud = (M.board.pcBaud || 115200); this.T = 1e6 / this.baud; this.edges = [[0, 1]];
    var self = this, t = 0;
    (rx || []).forEach(function (r) {
      t = Math.max(t, r.t * 1000);
      var bytes = typeof r.s === 'string' ? r.s.split('').map(function (c) { return c.charCodeAt(0); }) : r.s;
      bytes.forEach(function (b) {
        var bits = [0]; for (var i = 0; i < 8; i++) bits.push((b >> i) & 1); bits.push(1);
        bits.forEach(function (v, i) { self.edges.push([t + i * self.T, v]); });
        self.frames = self.frames || []; self.frames.push({ t: t, b: b });
        t += 10 * self.T + (r.gap || 0) * 1000;
      });
    });
    this.frames = this.frames || []; this.fi = 0;
  }
  Pc.prototype.txLevel = function (t) { var e = this.edges, lo = 0, hi = e.length - 1; while (lo < hi) { var m = (lo + hi + 1) >> 1; if (e[m][0] <= t + 1e-9) lo = m; else hi = m - 1; } return e[lo][1]; };
  Pc.prototype.next = function () { var f = this.frames[this.fi]; return f ? f.t : Infinity; };
  Pc.prototype.fire = function (t) {
    var M = this.M, u = M.usart1;
    while (this.fi < this.frames.length && this.frames[this.fi].t <= t + 1e-9) {
      var f = this.frames[this.fi++];
      var c = M.pinCfg('PA10'), inputOk = c.mode === 0 && c.cnf !== 0;
      if (!(u.en() && (u.CR1 & 0x2004) === 0x2004)) { M.warnOnce('rxoff', '电脑发来了数据，但 USART1 的接收（UE / RE）没开，没人收。'); continue; }
      if (!inputOk) { M.warnOnce('rxpin', 'PA10 没有配成输入，USART1 的接收端看不到电脑发来的数据。'); continue; }
      // 用 USART 自己的位时间在电脑的波形上采样（波特率不一致时会采错）
      var T = u.bitUs(), b = 0;
      for (var i = 0; i < 8; i++) b |= this.txLevel(f.t + (1.5 + i) * T) << i;
      u.rxq.push({ b: b, done: f.t + 9.5 * T });
    }
  };
  function hex2(v) { return v === 'idle' || v == null ? '--' : ('0' + (v & 0xFF).toString(16).toUpperCase()).slice(-2); }
  // 从波形解码 8N1（电脑的串口助手）
  function decodeUart(trace, baud, t0, t1) {
    var T = 1e6 / baud, out = [], i = 1, idleFrom = 0;
    function lv(t) { var lo = 0, hi = trace.length - 1; while (lo < hi) { var m = (lo + hi + 1) >> 1; if (trace[m][0] <= t + 1e-9) lo = m; else hi = m - 1; } var v = trace[lo][1]; return v === 'Z' ? 1 : v; }
    if (!trace.length) return out;
    var t = trace[0][0];
    for (i = 1; i < trace.length; i++) {
      if (trace[i][0] < t) continue;
      if (trace[i][1] === 0 && (trace[i - 1][1] === 1 || trace[i - 1][1] === 'Z')) {
        var ts = trace[i][0];
        if (lv(ts + T / 2) !== 0) continue;
        var b = 0; for (var k = 0; k < 8; k++) b |= lv(ts + (1.5 + k) * T) << k;
        var stop = lv(ts + 9.5 * T);
        out.push({ t: ts, b: b, ok: stop === 1 });
        t = ts + 9.5 * T;
      }
    }
    return out;
  }

  /* ===================== 定时器 TIM2 / TIM5 / TIM6 ===================== */
  function Tim(M, n) {
    this.M = M; this.n = n; this.basic = n === 6 || n === 7;
    this.CR1 = 0; this.DIER = 0; this.SR = 0; this.PSC = 0; this.ARR = 0xFFFF; this.CCR = [0, 0, 0, 0, 0]; this.CCMR1 = 0; this.CCMR2 = 0; this.CCER = 0;
    this.psc = 0; this.arr = 0xFFFF; this.ccr = [0, 0, 0, 0, 0];   // 影子寄存器（真正起作用的值）
    this.cnt = 0; this.tRef = 0; this.updates = 0;
  }
  Tim.prototype.bus = function () { return this.n === 6 ? 4 : this.n === 5 ? 3 : this.n === 2 ? 0 : 5; };
  Tim.prototype.en = function () { return this.M.clockOn('APB1ENR', this.bus()); };
  Tim.prototype.f = function () { return F_TIM / (this.psc + 1); };     // 每微秒计多少个数
  Tim.prototype.running = function () { return !!(this.CR1 & 1) && this.en(); };
  Tim.prototype.sync = function (t) { if (this.running()) { this.cnt += (t - this.tRef) * this.f(); } this.tRef = t; };
  Tim.prototype.cntNow = function () { this.sync(this.M.t); return Math.floor(this.cnt + 1e-9); };
  Tim.prototype.update = function (fromUG) {
    this.psc = this.PSC; this.arr = this.ARR; for (var k = 1; k <= 4; k++) this.ccr[k] = this.CCR[k];
    this.cnt = 0; this.tRef = this.M.t; this.updates++;
    if (!fromUG || !(this.CR1 & 4)) this.SR |= 1;
  };
  Tim.prototype.next = function () {
    if (!this.running()) return Infinity;
    var c = this.cnt + (this.M.t - this.tRef) * this.f(), f = this.f(), best = this.tRef + (this.arr + 1 - this.cnt) / f;
    for (var k = 1; k <= 4; k++) if (this.pwm(k)) { var cc = this.ccr[k]; if (cc > c + 1e-9 && cc <= this.arr) best = Math.min(best, this.tRef + (cc - this.cnt) / f); }
    return best;
  };
  Tim.prototype.fire = function (t) {
    if (!this.running()) return;
    this.sync(t);
    if (this.cnt >= this.arr + 1 - 1e-6) { this.update(false); if (this.arr === 0) this.cnt = 0; }
  };
  Tim.prototype.pwm = function (k) { if (this.basic) return false; var m = k <= 2 ? this.CCMR1 >> ((k - 1) * 8) : this.CCMR2 >> ((k - 3) * 8); return (this.CCER >> ((k - 1) * 4)) & 1 && ((m >> 4) & 7) >= 6 && !(m & 3); };
  Tim.prototype.ocLevel = function (k) {
    if (this.basic || !this.en()) return undefined;
    if (!((this.CCER >> ((k - 1) * 4)) & 1)) return undefined;
    var m = k <= 2 ? this.CCMR1 >> ((k - 1) * 8) : this.CCMR2 >> ((k - 3) * 8), mode = (m >> 4) & 7, pol = (this.CCER >> ((k - 1) * 4 + 1)) & 1, act;
    var c = this.running() ? this.cnt + (this.M.t - this.tRef) * this.f() : this.cnt;
    if (mode === 6) act = c < this.ccr[k] - 1e-9; else if (mode === 7) act = !(c < this.ccr[k] - 1e-9); else if (mode === 5) act = true; else if (mode === 4) act = false; else act = false;
    return (act ? 1 : 0) ^ pol;
  };
  Tim.prototype.irqPending = function () { return (this.DIER & 1) && (this.SR & 1); };
  function timRegs(M, tm) {
    var o = {}, nm = 'TIM' + tm.n;
    function chk(w, r) { if (tm.en()) return true; M.warnOnce('clkT' + tm.n + w, (w ? '写' : '读') + ' ' + nm + '_' + r + ' 时 ' + nm + ' 的时钟还没开：' + (w ? '写入不起作用。' : '读出来是 0。')); return false; }
    function rw(r, get, set) { reg(o, r, function () { M.access(false, nm + '->' + r); return chk(0, r) ? get() : 0; }, function (v) { M.access(true); if (chk(1, r)) { tm.sync(M.t); set(v >>> 0); M.after(); } }); }
    rw('CR1', function () { return tm.CR1; }, function (v) {
      var was = tm.CR1 & 1; tm.CR1 = v & 0x3FF; tm.tRef = M.t;
      if (!was && (v & 1)) M.note('info', nm + ' 开始计数：计数时钟 72 MHz ÷ ' + (tm.psc + 1) + (tm.PSC !== tm.psc ? '（PSC 写成了 ' + tm.PSC + '，要等下一次更新事件才生效）' : '') + '，数到 ' + tm.arr + ' 溢出');
      if (v & 0x10) M.warnOnce('dir', nm + '：模拟器只模拟向上计数。');
    });
    rw('DIER', function () { return tm.DIER; }, function (v) { tm.DIER = v & 0x5F; });
    rw('SR', function () { return tm.SR; }, function (v) { tm.SR &= v; });    // 写 0 清除，写 1 无影响
    rw('EGR', function () { return 0; }, function (v) { if (v & 1) tm.update(true); });
    rw('CNT', function () { return tm.cntNow(); }, function (v) { tm.cnt = v & 0xFFFF; tm.tRef = M.t; });
    rw('PSC', function () { return tm.PSC; }, function (v) { tm.PSC = v & 0xFFFF; });
    rw('ARR', function () { return tm.ARR; }, function (v) { tm.ARR = v & 0xFFFF; if (!(tm.CR1 & 0x80)) tm.arr = tm.ARR; });
    [1, 2, 3, 4].forEach(function (k) {
      rw('CCR' + k, function () { return tm.CCR[k]; }, function (v) {
        tm.CCR[k] = v & 0xFFFF;
        var m = k <= 2 ? tm.CCMR1 >> ((k - 1) * 8) : tm.CCMR2 >> ((k - 3) * 8);
        if (!(m & 8)) tm.ccr[k] = tm.CCR[k];        // 没开预装载：立刻生效
      });
    });
    rw('CCMR1', function () { return tm.CCMR1; }, function (v) { tm.CCMR1 = v & 0xFFFF; });
    rw('CCMR2', function () { return tm.CCMR2; }, function (v) { tm.CCMR2 = v & 0xFFFF; });
    rw('CCER', function () { return tm.CCER; }, function (v) { tm.CCER = v & 0x3333; });
    return o;
  }

  /* ===================== ADC1 ===================== */
  var SMP = [1.5, 7.5, 13.5, 28.5, 41.5, 55.5, 71.5, 239.5];
  function Adc(M) { this.M = M; this.SR = 0; this.CR1 = 0; this.CR2 = 0; this.SMPR1 = 0; this.SMPR2 = 0; this.SQR1 = 0; this.SQR3 = 0; this.DR = 0; this.ready = Infinity; this.calEnd = Infinity; this.convEnd = Infinity; this.nconv = 0; this.seed = 12345; this.calibrated = false; }
  Adc.prototype.en = function () { return this.M.clockOn('APB2ENR', 9); };
  Adc.prototype.fadc = function () { var pre = (this.M.rcc.CFGR >> 14) & 3; return F_PCLK2 / [2, 4, 6, 8][pre]; };
  Adc.prototype.next = function () { return Math.min(this.calEnd, this.convEnd); };
  Adc.prototype.chan = function () { return this.SQR3 & 0x1F; };
  Adc.prototype.smp = function (ch) { var r = ch >= 10 ? this.SMPR1 >> ((ch - 10) * 3) : this.SMPR2 >> (ch * 3); return SMP[r & 7]; };
  Adc.prototype.start = function () {
    var M = this.M;
    if (M.t < this.ready) { M.note('warn', 'ADC 刚上电还没稳定（tSTAB）就启动了转换，模拟器按启动失败处理。'); return; }
    if (this.convEnd < Infinity) return;
    if (this.calEnd < Infinity) { M.note('warn', 'ADC 还在校准就启动了转换：这次启动被忽略。'); return; }
    var f = this.fadc();
    if (f > 14) M.warnOnce('adcclk', 'ADC 时钟 ' + f + ' MHz 超过了 14 MHz 的上限：手册不保证转换结果。');
    this.SR |= 0x10;
    this.convEnd = M.t + (this.smp(this.chan()) + 12.5) / f;
  };
  Adc.prototype.input = function (ch) {
    var M = this.M;
    if (ch !== 10) { M.warnOnce('adcch', '选的是通道 ' + ch + '：板子上电位器接在通道 10（PC0），这个通道上没接东西。'); return 0; }
    var c = M.pinCfg('PC0'), v = M.board.pot != null ? M.board.pot : 1.65;
    if (!M.gpio.C || !M.clockOn('APB2ENR', 4)) {}
    if (c.mode !== 0) { M.warnOnce('pc0out', 'PC0 被配成了输出：引脚自己在输出 ' + c.odr + '，读到的不是电位器的电压。'); return c.odr ? 3.3 : 0; }
    if (c.cnf !== 0) M.warnOnce('pc0dig', 'PC0 不是模拟输入模式：转换还能进行，但数字输入电路一直接着，会增加功耗和噪声（手册要求配成模拟输入）。');
    return v;
  };
  Adc.prototype.fire = function (t) {
    var M = this.M;
    if (t >= this.calEnd - 1e-9) { this.calEnd = Infinity; this.CR2 &= ~4; this.calibrated = true; M.note('info', 'ADC 校准完成'); }
    if (t >= this.convEnd - 1e-9) {
      this.convEnd = Infinity;
      var v = this.input(this.chan()), r = Math.floor(v / 3.3 * 4096);
      this.seed = (this.seed * 1103515245 + 12345) & 0x7FFFFFFF;
      r += (this.seed >> 16) % 5 - 2;                                  // ±2 LSB 的噪声（示意）
      if (!this.calibrated) r += 7;                                    // 没校准时的固定偏差（示意）
      r = Math.max(0, Math.min(4095, r));
      if ((this.SR & 2) && !M.warned.adcovr) { M.warned.adcovr = 1; M.note('info', 'ADC：上一次的结果还没读，新的结果直接覆盖了 DR（F1 的规则组没有溢出标志）。'); }
      this.DR = this.CR2 & 0x800 ? (r << 4) & 0xFFFF : r; this.SR |= 2; this.nconv++;
      if (this.CR2 & 2) this.start();
    }
  };
  Adc.prototype.irqPending = function () { return (this.CR1 & 0x20) && (this.SR & 2); };
  function adcRegs(M, a) {
    var o = {};
    function chk(w, r) { if (a.en()) return true; M.warnOnce('clkA' + w, (w ? '写' : '读') + ' ADC1_' + r + ' 时 ADC1 的时钟还没开：' + (w ? '写入不起作用。' : '读出来是 0。')); return false; }
    function rw(r, get, set) { reg(o, r, function () { M.access(false, 'ADC1->' + r); return chk(0, r) ? get() : 0; }, function (v) { M.access(true); if (chk(1, r)) { set(v >>> 0); M.after(); } }); }
    rw('SR', function () { return a.SR; }, function (v) { a.SR &= v; });
    rw('DR', function () { a.SR &= ~2; return a.DR; }, function () {});
    rw('CR1', function () { return a.CR1; }, function (v) { a.CR1 = v; });
    rw('CR2', function () { return a.CR2; }, function (v) {
      var old = a.CR2; a.CR2 = v & 0x00FFF90F;
      if (!(old & 1) && (v & 1)) { a.ready = M.t + 1; a.onT = M.t; M.note('info', 'ADC 从断电模式唤醒（ADON 0→1），约 1 µs 后才稳定'); }
      else if ((old & 1) && (v & 1) && ((old ^ v) & ~(0x400000 | 0x200000)) === 0 && !(v & 0x400000) && !(v & 0xC)) a.start();      // ADON 已经是 1 时再写 1（其它位没变）= 启动转换
      if (!(v & 1)) { a.ready = Infinity; a.convEnd = Infinity; }
      if ((v & 4) && !(old & 4)) {
        if (!(v & 1)) M.note('warn', 'ADC 还没上电（ADON = 0）就开始校准：校准不会进行，CAL 位一直是 1。');
        else { if (M.t - a.onT < 2 / a.fadc()) M.warnOnce('calearly', 'ADON 刚置 1 就开始校准：手册要求先上电至少 2 个 ADC 时钟周期。'); a.calEnd = M.t + 83 / a.fadc(); }
      }
      if (v & 8) a.CR2 &= ~8;        // 复位校准寄存器：立即完成（简化）
      if (v & 0x400000) {
        a.CR2 &= ~0x400000;
        if ((a.CR2 & 0x100000) && ((a.CR2 >> 17) & 7) === 7) a.start();
        else M.warnOnce('swstart', 'SWSTART 没有效果：F1 上只有 EXTTRIG = 1 且 EXTSEL = 111 时，软件触发才起作用。');
      }
    });
    rw('SMPR1', function () { return a.SMPR1; }, function (v) { a.SMPR1 = v; });
    rw('SMPR2', function () { return a.SMPR2; }, function (v) { a.SMPR2 = v; });
    rw('SQR1', function () { return a.SQR1; }, function (v) { a.SQR1 = v; });
    rw('SQR2', function () { return 0; }, function () {});
    rw('SQR3', function () { return a.SQR3; }, function (v) { a.SQR3 = v; });
    return o;
  }

  /* ===================== SPI1 + W25Q32 ===================== */
  function Spi(M) { this.M = M; this.CR1 = 0; this.CR2 = 0; this.SR = 2; this.rx = 0; this.txb = null; this.xfer = null; this.sck = undefined; this.mosi = undefined; }
  Spi.prototype.en = function () { return this.M.clockOn('APB2ENR', 12); };
  Spi.prototype.master = function () { return (this.CR1 & 0x44) === 0x44; };
  Spi.prototype.nss = function () { if (this.CR1 & 0x200) return (this.CR1 >> 8) & 1; var v = this.M.level('PA4'); return v === 'Z' ? 0 : v; };
  Spi.prototype.checkModf = function () {
    if ((this.CR1 & 0x4) && (this.CR1 & 0x40) && !this.nss() && !(this.CR2 & 4)) {
      this.SR |= 0x20; this.CR1 &= ~0x44;
      this.M.note('warn', 'SPI1 主模式错误（MODF）：NSS 是低电平，芯片以为有别的主机在用总线，自动退回从模式并关掉了 SPI（MSTR、SPE 被清 0）。');
    }
  };
  Spi.prototype.halfUs = function () { return Math.pow(2, ((this.CR1 >> 3) & 7) + 1) / F_PCLK2 / 2; };
  Spi.prototype.sckLevel = function () { if (!this.en() || !(this.CR1 & 0x40)) return undefined; return this.sck === undefined ? (this.CR1 >> 1) & 1 : this.sck; };
  Spi.prototype.mosiLevel = function () { if (!this.en() || !(this.CR1 & 0x40)) return undefined; return this.mosi === undefined ? 1 : this.mosi; };
  Spi.prototype.begin = function () {
    if (this.xfer || this.txb === null) return;
    var M = this.M, b = this.txb, cpol = (this.CR1 >> 1) & 1, cpha = this.CR1 & 1, lsb = this.CR1 & 0x80, n = this.CR1 & 0x800 ? 16 : 8;
    this.txb = null; this.SR |= 2; this.SR |= 0x80;
    var bits = []; for (var i = 0; i < n; i++) bits.push(lsb ? (b >> i) & 1 : (b >> (n - 1 - i)) & 1);
    var h = this.halfUs(), t0 = M.t, ev = [];
    // 每一位：前半个周期、后半个周期；CPHA=0 时数据在第一个边沿前就放好
    for (i = 0; i < n; i++) {
      var a = t0 + i * 2 * h;
      if (!cpha) ev.push({ t: a, mosi: bits[i], i: i });          // CPHA = 0：第一个边沿之前就把这一位放好
      ev.push({ t: a + h, sck: cpol ^ 1, edge: 1, i: i });
      ev.push({ t: a + 2 * h, sck: cpol, edge: 2, i: i });
    }
    this.xfer = { ev: ev, k: 0, bits: bits, n: n, rxbits: [], cpol: cpol, cpha: cpha, t0: t0, lsb: lsb };
    // 从机这一端：按 W25Q32 的规矩（模式 0 / 3：上升沿采样，下降沿换数据）
    M.flash.beginByte(this.xfer);
  };
  Spi.prototype.next = function () { return this.xfer ? this.xfer.ev[this.xfer.k].t : Infinity; };
  Spi.prototype.fire = function (t) {
    var x = this.xfer, M = this.M;
    while (x && x.k < x.ev.length && x.ev[x.k].t <= t + 1e-9) {
      var e = x.ev[x.k++];
      if (e.mosi !== undefined) this.mosi = e.mosi;
      if (e.sck !== undefined) {
        // 同一个边沿上：主机先采样，从机再动作；CPHA = 1 时主机在第一个边沿才放出这一位
        this.sck = e.sck; M.updatePins();
        if (e.edge === (x.cpha ? 2 : 1)) { var mi = M.level('PA6'); x.rxbits.push(mi === 'Z' ? 1 : mi); }
        M.flash.edge(e.sck, e.i);
        if (x.cpha && e.edge === 1) this.mosi = x.bits[e.i];
      }
      M.updatePins();
      if (x.k >= x.ev.length) {
        var v = 0; for (var i = 0; i < x.n; i++) { var bit = x.rxbits[i] | 0; v |= x.lsb ? bit << i : bit << (x.n - 1 - i); }
        this.xfer = null; this.SR &= ~0x80;
        if (this.SR & 1) { this.SR |= 0x40; M.note('warn', 'SPI1 溢出（OVR）：上一个收到的字节还没读走，又收到了新的。'); }
        else { this.rx = v; this.SR |= 1; }
        M.flash.endByte();
        if (this.txb !== null) this.begin();
        x = this.xfer;
      }
    }
  };
  Spi.prototype.irqPending = function () { return false; };
  function spiRegs(M, s) {
    var o = {};
    function chk(w, r) { if (s.en()) return true; M.warnOnce('clkS' + w, (w ? '写' : '读') + ' SPI1_' + r + ' 时 SPI1 的时钟还没开：' + (w ? '写入不起作用。' : '读出来是 0。')); return false; }
    function rw(r, get, set) { reg(o, r, function () { M.access(false, 'SPI1->' + r); return chk(0, r) ? get() : 0; }, function (v) { M.access(true); if (chk(1, r)) { set(v >>> 0); M.after(); } }); }
    rw('CR1', function () { return s.CR1; }, function (v) {
      var old = s.CR1; s.CR1 = v & 0xFFFF;
      if ((v & 0x40) && !(old & 0x40)) { var br = (v >> 3) & 7, f = F_PCLK2 / Math.pow(2, br + 1); M.note('info', 'SPI1 打开：SCK = 72 MHz ÷ ' + Math.pow(2, br + 1) + ' = ' + f + ' MHz，模式 ' + (((v >> 1) & 1) * 2 + (v & 1))); if (f > 18) M.warnOnce('spifast', 'SCK ' + f + ' MHz 超过了 STM32F103 数据手册给 SPI 的上限 18 MHz。'); }
      s.checkModf();
    });
    rw('CR2', function () { return s.CR2; }, function (v) { s.CR2 = v & 0xFF; });
    rw('SR', function () { if (!(s.CR1 & 0x40) && (s.SR & 0x20)) {} return s.SR; }, function (v) { s.SR &= (v | ~0x10); });
    rw('DR', function () { s.SR &= ~1; return s.rx; }, function (v) {
      if (!(s.CR1 & 0x40)) { M.warnOnce('spioff', '往 SPI1->DR 写数据时 SPI 没有打开（SPE = 0' + (s.SR & 0x20 ? '，因为发生过 MODF' : '') + '）：什么也不会发生。'); return; }
      if (!(s.SR & 2)) M.note('warn', 'SPI1 发送缓冲还没空（TXE = 0）就写了 DR，前一个字节被覆盖。');
      s.txb = v & 0xFFFF; s.SR &= ~2; s.begin();
    });
    return o;
  }
  // W25Q32JV 的一个简化模型：JEDEC ID、读状态、写使能、读数据、页编程、扇区擦除
  function W25Q(M, opt) {
    this.M = M; this.mem = {}; var self = this;
    Object.keys(opt.data || {}).forEach(function (a) { var v = opt.data[a]; (Array.isArray(v) ? v : [v]).forEach(function (b, k) { self.mem[Number(a) + k] = b; }); });
    this.sel = false; this.cmd = null; this.n = 0; this.addr = 0; this.out = null; this.outBits = []; this.busyUntil = -1; this.wel = false; this.pp = null; this.rx = 0; this.rxN = 0; this.do = undefined; this.mode = 0;
  }
  W25Q.prototype.get = function (a) { var v = this.mem[a & 0x3FFFFF]; return v === undefined ? 0xFF : v; };
  W25Q.prototype.busy = function () { return this.M.t < this.busyUntil; };
  W25Q.prototype.csLevel = function () { var v = this.M.level('PC13'); return v; };
  W25Q.prototype.next = function () { return Infinity; };
  W25Q.prototype.fire = function () {};
  W25Q.prototype.doLevel = function () { return this.sel ? (this.do === undefined ? 'Z' : this.do) : 'Z'; };
  W25Q.prototype.checkCs = function (fromXfer) {
    var cs = this.csLevel(), M = this.M;
    if (cs === 'Z') { if (fromXfer && !this.warnZ) { this.warnZ = 1; M.note('warn', 'PC13（W25Q32 的片选）是浮空的：Flash 选没选中说不准（模拟器按没选中处理）。'); } cs = 1; }
    var nowSel = cs === 0;
    if (nowSel && !this.sel) { this.sel = true; this.cmd = null; this.n = 0; this.rxN = 0; this.rx = 0; this.loadOut(); }
    else if (!nowSel && this.sel) { this.sel = false; this.finish(); }
  };
  W25Q.prototype.loadOut = function () {
    // 准备下一个要送出的字节
    var b = 0xFF, st = (this.busy() ? 1 : 0) | (this.wel ? 2 : 0);
    if (this.cmd === 0x9F) b = [0xEF, 0x40, 0x16][this.n - 1] !== undefined ? [0xEF, 0x40, 0x16][this.n - 1] : 0xFF;
    else if (this.cmd === 0x05) b = st;
    else if (this.cmd === 0x03 && this.n >= 4) b = this.get(this.addr + this.n - 4);
    else if (this.cmd === 0x90 && this.n >= 4) b = (this.n - 4) % 2 ? 0x15 : 0xEF;
    this.outByte = this.cmd === null || ([0x9F, 0x05].indexOf(this.cmd) < 0 && !((this.cmd === 0x03 || this.cmd === 0x90) && this.n >= 4)) ? null : b;
  };
  W25Q.prototype.beginByte = function (x) {
    this.checkCs(true);
    var cpol = x.cpol, cpha = x.cpha;
    this.mode = cpol * 2 + cpha;
    this.bitI = 0; this.rx = 0;
    // 模式 0：第一个上升沿前就要把最高位放好
    this.do = this.sel && this.outByte !== null && this.outByte !== undefined ? (this.outByte >> 7) & 1 : undefined;
    this.ok = this.M.pinCfg('PA5').cnf >= 2 && this.M.pinCfg('PA5').mode !== 0;
    if (!this.ok && this.sel && !this.warnSck) { this.warnSck = 1; this.M.note('warn', 'PA5（SCK）没有配成复用输出：SPI 外设的时钟送不到引脚上，Flash 收不到任何时钟。'); }
  };
  W25Q.prototype.edge = function (level, i) {
    if (!this.sel || !this.ok) return;
    var rising = level === 1;
    // W25Q32 只支持模式 0 和 3：在上升沿采样 MOSI，在下降沿送出下一位
    if (rising) { var mo = this.M.level('PA7'); this.rx = ((this.rx << 1) | (mo === 'Z' ? 1 : mo)) & 0xFF; this.bitI++; }
    else if (this.outByte !== null && this.outByte !== undefined && this.bitI < 8) this.do = (this.outByte >> (7 - this.bitI)) & 1;
  };
  W25Q.prototype.endByte = function () {
    this.checkCs();
    if (!this.sel || !this.ok) return;
    var b = this.rx, M = this.M;
    if (this.mode === 1 || this.mode === 2) { if (!this.warnMode) { this.warnMode = 1; M.note('warn', 'SPI 模式 ' + this.mode + '：W25Q32 只支持模式 0 和 3，两边对「在哪个边沿采样」理解不一样，收发的位会错开。'); } }
    this.n++;
    if (this.n === 1) {
      this.cmd = b;
      if (this.busy() && b !== 0x05) { M.note('warn', 'W25Q32 正忙（上一次写入 / 擦除还没完成），忽略了指令 0x' + hex2(b) + '。'); this.cmd = 0xFE; }
      else if (b === 0x06) this.wel = true;
      else if (b === 0x04) this.wel = false;
      M.note('flash', 'W25Q32 收到指令 0x' + hex2(b) + ({ 0x9F: '（读 JEDEC ID）', 0x05: '（读状态寄存器）', 0x06: '（写使能）', 0x04: '（写禁止）', 0x03: '（读数据）', 0x02: '（页编程）', 0x20: '（扇区擦除）', 0x90: '（读制造商 / 器件 ID）' }[b] || ''));
    } else if ((this.cmd === 0x03 || this.cmd === 0x02 || this.cmd === 0x20 || this.cmd === 0x90) && this.n <= 4) {
      this.addr = ((this.addr << 8) | b) & 0xFFFFFF;
      if (this.n === 2) this.addr = b;
      if (this.n === 4 && this.cmd === 0x02) this.pp = [];
    } else if (this.cmd === 0x02 && this.n > 4) this.pp.push(b);
    this.loadOut();
  };
  W25Q.prototype.finish = function () {
    var M = this.M, self = this;
    if (this.cmd === 0x02 && this.pp) {
      if (!this.wel) M.note('warn', 'W25Q32：页编程前没有写使能（0x06），这次写入被忽略。');
      else {
        this.pp.forEach(function (b, k) { var a = (self.addr & 0xFFFF00) | ((self.addr + k) & 0xFF); self.mem[a] = self.get(a) & b; });
        this.busyUntil = M.t + 400; this.wel = false; M.note('flash', 'W25Q32 开始页编程 ' + this.pp.length + ' 个字节（典型 0.4 ms，期间 BUSY = 1）。编程只能把 1 变成 0。');
      }
    }
    if (this.cmd === 0x20 && this.n >= 4) {
      if (!this.wel) M.note('warn', 'W25Q32：擦除前没有写使能（0x06），这次擦除被忽略。');
      else { var base = this.addr & 0xFFF000; for (var a = base; a < base + 4096; a++) delete this.mem[a]; this.busyUntil = M.t + 45000; this.wel = false; M.note('flash', 'W25Q32 开始擦除扇区 0x' + base.toString(16).toUpperCase() + '（约 45 ms）'); }
    }
    this.cmd = null; this.pp = null; this.do = undefined;
  };

  /* ===================== 运行 ===================== */
  function run(prog, opt) {
    opt = opt || {};
    var C = opt.consts || consts(), M = new Machine(opt), env = Object.create(null);
    Object.keys(C).forEach(function (k) { env[k] = C[k]; });
    env.RCC = (function () {
      var o = {};
      ['APB2ENR', 'APB1ENR', 'AHBENR', 'CFGR'].forEach(function (r) { reg(o, r, function () { M.access(false, 'RCC->' + r); return M.rcc[r] >>> 0; }, function (v) { M.access(true); M.rcc[r] = v >>> 0; M.after(); }); });
      return o;
    })();
    'ABCDEFG'.split('').forEach(function (p) { env['GPIO' + p] = gpioRegs(M, M.gpio[p]); });
    env.USART1 = usartRegs(M, M.usart1); env.TIM2 = timRegs(M, M.tim[2]); env.TIM5 = timRegs(M, M.tim[5]); env.TIM6 = timRegs(M, M.tim[6]);
    env.ADC1 = adcRegs(M, M.adc1); env.SPI1 = spiRegs(M, M.spi1);
    env.__s = function (s) { var a = []; for (var i = 0; i < s.length; i++) a.push(s.charCodeAt(i)); a.push(0); a.isStr = true; return a; };
    env.__tw = function (id) { return M.tickWhile(id); };
    env.__tf = function () { return M.tickFor(); };
    env.__ln = function (f, i) { M.line = [f, i]; };
    env.Delay_us = function (n) { M.delays++; M.spend(Number(n)); };
    env.Delay_ms = function (n) { M.delays++; M.spend(Number(n) * 1000); };
    env.Delay_s = function (n) { M.delays++; M.spend(Number(n) * 1e6); };
    env.NVIC_EnableIRQ = function (n) { M.irqEnabled[n] = true; M.note('info', 'NVIC 打开中断 ' + (IRQ_NAME[n] || n).replace('_IRQHandler', '')); M.after(); };
    env.NVIC_DisableIRQ = function (n) { M.irqEnabled[n] = false; };
    env.NVIC_SetPriority = function () {}; env.NVIC_SetPriorityGrouping = function () {};
    env.__disable_irq = function () {}; env.__enable_irq = function () {};
    env.strlen = function (s) { var n = 0; while (s[n]) n++; return n; };
    env.printf = function (fmt) {
      var args = Array.prototype.slice.call(arguments, 1), f = toStr(fmt), k = 0;
      var s = f.replace(/%(0?)(\d*)(?:\.(\d+))?(l?)([dduxXfcs%])/g, function (_, z, w, p, l, c) {
        if (c === '%') return '%';
        var v = args[k++], r;
        if (c === 'd' || c === 'u') r = String(Math.trunc(Number(v)));
        else if (c === 'x' || c === 'X') { r = (Number(v) >>> 0).toString(16); if (c === 'X') r = r.toUpperCase(); }
        else if (c === 'f') r = Number(v).toFixed(p != null ? Number(p) : 6);
        else if (c === 'c') r = String.fromCharCode(v);
        else r = toStr(v);
        while (w && r.length < Number(w)) r = (z ? '0' : ' ') + r;
        return r;
      });
      M.printf += s; M.delays++; M.spend(s.length * 87);     // 重定向到 115200 的串口，每个字符约 87 µs
      M.prints = M.prints || []; M.prints.push({ t: M.t, s: s });
    };
    function toStr(a) { if (typeof a === 'string') return a; if (!a) return ''; var s = ''; for (var i = 0; i < a.length && a[i]; i++) s += String.fromCharCode(a[i]); return s; }
    var stop = { kind: 'end', text: '' }, fns = null, src = '';
    try {
      src = compile(prog.fns, prog.globals);
      var factory = new Function('env', 'with (env) { return (function () { ' + src + ' })(); }');
      fns = factory(env);
      M.handlers = fns;
      (prog.entry || ['main']).forEach(function (e) { if (!fns[e]) throw new Error('没有函数 ' + e); });
      (prog.entry || ['main']).forEach(function (e) { fns[e](); });
      // 主函数返回了：把剩下的时间跑完（中断还会继续）
      M.advanceTo(M.budget + 1);
    } catch (e) {
      if (e instanceof Stop) stop = { kind: e.kind, text: e.text };
      else stop = { kind: 'error', text: (e && e.message) || String(e) };
    }
    if (stop.kind === 'end') stop.text = '';
    M.updatePins();
    var where = M.line;
    return finish(M, stop, where, opt);
  }
  /* ---- 结果整理 ---- */
  var LEDS = [['PA0', 'LED1'], ['PA1', 'LED2'], ['PA8', 'LED3']];
  function ledEvents(tr, T) {
    var ev = [], on = null;
    tr.forEach(function (p) { var v = p[1] === 0; if (v !== on) { ev.push([p[0], v]); on = v; } });
    return ev;
  }
  function ledSummary(name, ev, T) {
    if (ev.length && !ev[0][1] && ev[0][0] === 0) ev = ev.slice(1);
    if (!ev.length) return null;
    var tOn = 0; for (var i = 0; i < ev.length; i++) if (ev[i][1]) tOn += (i + 1 < ev.length ? ev[i + 1][0] : T) - ev[i][0];
    if (ev.length <= 12) return name + '：' + ev.map(function (e) { return (e[1] ? '亮' : '灭') + ' @' + fmtT(e[0]); }).join(' → ');
    var ons = ev.filter(function (e) { return e[1]; }).map(function (e) { return e[0]; }), per = [];
    for (i = 1; i < ons.length; i++) per.push(ons[i] - ons[i - 1]);
    per.sort(function (a, b) { return a - b; });
    var p = per[per.length >> 1] || 0;
    // 分段看占空比有没有在变（呼吸灯）
    var segs = 5, duties = [];
    for (var s = 0; s < segs; s++) {
      var a = T * s / segs, b = T * (s + 1) / segs, on = 0;
      for (i = 0; i < ev.length; i++) { var x0 = Math.max(a, ev[i][0]), x1 = Math.min(b, i + 1 < ev.length ? ev[i + 1][0] : T); if (ev[i][1] && x1 > x0) on += x1 - x0; }
      duties.push(Math.round(on / (b - a) * 100));
    }
    var spread = Math.max.apply(null, duties) - Math.min.apply(null, duties);
    return name + '：快速亮灭，周期约 ' + fmtT(p) + '（' + (p ? Math.round(1e6 / p) : 0) + ' Hz），' + (spread > 12 ? '亮的时间占比在变化：' + duties.join('% → ') + '%' : '亮的时间约占 ' + Math.round(tOn / T * 100) + '%');
  }
  function fmtT(us) { return us >= 1e6 ? (us / 1e6).toFixed(us % 1e6 ? 3 : 0).replace(/\.?0+$/, '') + ' s' : us >= 1000 ? (Math.round(us / 100) / 10) + ' ms' : (Math.round(us * 100) / 100) + ' µs'; }
  function finish(M, stop, where, opt) {
    var T = M.t, leds = {}, desc = [];
    LEDS.forEach(function (l) { var ev = ledEvents(M.trace[l[0]], T); leds[l[1]] = { pin: l[0], ev: ev, summary: ledSummary(l[1], ev, T) }; if (leds[l[1]].summary) desc.push(leds[l[1]].summary); });
    var rx = decodeUart(M.trace.PA9, M.pc.baud);
    var term = rx.map(function (x) { return x.ok ? x.b : -1; });
    var text = rx.map(function (x) { return !x.ok ? '\uFFFD' : x.b === 13 ? '' : x.b === 10 ? '\n' : x.b >= 32 && x.b < 127 ? String.fromCharCode(x.b) : '\u00B7'; }).join('');
    if (rx.length) desc.push('电脑收到：' + JSON.stringify(text).slice(1, -1).slice(0, 120) + (rx.some(function (x) { return !x.ok; }) ? '（有帧错误）' : ''));
    if (M.printf) desc.push('printf 输出：' + JSON.stringify(M.printf).slice(1, -1).slice(0, 160));
    if (stop.kind !== 'end') desc.push('程序停在：' + stop.text);
    var warns = M.log.filter(function (x) { return x.k === 'warn'; }).map(function (x) { return x.text; });
    warns.forEach(function (w) { if (desc.indexOf('⚠ ' + w) < 0) desc.push('⚠ ' + w); });
    return {
      engine: 'mcu', t: T, stop: stop, where: where, trace: M.trace, leds: leds, uart: rx, terminal: text, printf: M.printf, prints: M.prints || [],
      log: M.log, desc: desc, flash: M.flash, adc: { n: M.adc1.nconv, dr: M.adc1.DR }, results: [], watch: [], timing: [], device: true
    };
  }
  return { consts: consts, transpile: body, compile: compile, run: run, decodeUart: decodeUart, fmtT: fmtT, Machine: Machine };
});
