/* regs.js — LIMING 工具箱 · STM32 学习工具 ·「寄存器」tab（HUB-T7）
   数据：window.STM32_REGS（assets/registers.js，首次进入 tab 时由 stm32.js 钩子懒加载，先数据后本文件）。
   接口：mount(pane, app, target) / show(target, opts) / leave() / onKey(e)；app = window.STM32_APP。
   DOM 全部 createElement + textContent（不拼 HTML、不用 eval）；URL 参数只当查表 key，白名单校验后才用。 */
(function () {
  'use strict';

  var DATA = window.STM32_REGS;
  if (!DATA || !Array.isArray(DATA.groups) || window.STM32_REGS_UI) return;

  var SVGNS = 'http://www.w3.org/2000/svg';
  var GORDER = ['rcc', 'gpio', 'afio', 'exti', 'nvic', 'systick', 'tim', 'usart', 'adc', 'dma', 'spi', 'i2c', 'fsmc', 'flash'];
  var RW = (DATA.meta && DATA.meta.rw) || {};
  var LS_KEY = 'lm.stm32.regs';
  var BIT01 = [{ v: '0', t: '' }, { v: '1', t: '' }];

  /* ================= 数据预处理 ================= */

  var GROUPS = [], GBY = {}, REG = {}, GOF = {}, BYNAME = {}, PRE = {};
  DATA.groups.forEach(function (g) { if (g && typeof g.id === 'string' && Array.isArray(g.regs)) GBY[g.id] = g; });
  GORDER.forEach(function (id) { if (GBY[id]) GROUPS.push(GBY[id]); });
  Object.keys(GBY).forEach(function (id) { if (GROUPS.indexOf(GBY[id]) < 0) GROUPS.push(GBY[id]); });
  GROUPS.forEach(function (g) {
    BYNAME[g.id] = {};
    g.regs = g.regs.filter(function (r) { return r && typeof r.id === 'string' && Array.isArray(r.fields); });
    g.regs.forEach(function (r) { REG[r.id] = r; GOF[r.id] = g; BYNAME[g.id][r.name] = r; });
  });

  function own(o, k) { return o != null && Object.prototype.hasOwnProperty.call(o, k); }
  function fw(f) { return f.bits[0] - f.bits[1] + 1; }
  function p2(n) { return Math.pow(2, n); }
  function fmask(f) { return ((p2(fw(f)) - 1) * p2(f.bits[1])) >>> 0; }
  function fget(v, f) { return ((v & fmask(f)) >>> 0) / p2(f.bits[1]); }
  function fset(v, f, x) { var m = fmask(f); return ((v & ~m) | ((x * p2(f.bits[1])) & m)) >>> 0; }
  function bin(x, w) { var s = Number(x).toString(2); while (s.length < w) s = '0' + s; return s.slice(-w); }
  function hexd(x, digits) { var s = (Number(x) >>> 0).toString(16).toUpperCase(); while (s.length < digits) s = '0' + s; return s; }
  function hexC(x, w) { return '0x' + hexd(x, w / 4); }                       // 代码里：0x44444443
  function hexS(x, w) { var s = hexd(x, w / 4); return '0x' + (w === 32 ? s.slice(0, 4) + ' ' + s.slice(4) : s); }   // 显示：0x4444 4443
  function wild(pat, b) {
    pat = String(pat);
    if (pat.length !== b.length) return false;
    for (var i = 0; i < pat.length; i++) { var c = pat.charAt(i); if (c !== 'x' && c !== 'X' && c !== b.charAt(i)) return false; }
    return true;
  }
  function parseHexStr(s) { var t = String(s || '').replace(/[\s_]/g, '').replace(/^0x/i, ''); return /^[0-9a-f]{1,8}$/i.test(t) ? parseInt(t, 16) >>> 0 : null; }
  // 复位值：'0x0000 XX83' → v（X 当 0）+ x 掩码
  function parseReset(s) {
    var t = String(s || '').replace(/[\s_]/g, '').replace(/^0x/i, ''), v = 0, x = 0;
    if (!/^[0-9a-fx]{1,8}$/i.test(t)) return { v: 0, x: 0 };
    for (var i = 0; i < t.length; i++) {
      var c = t.charAt(i), isX = c === 'x' || c === 'X';
      v = v * 16 + (isX ? 0 : parseInt(c, 16));
      x = x * 16 + (isX ? 15 : 0);
    }
    return { v: v >>> 0, x: x >>> 0 };
  }
  // quick.set / 数值输入的取值：位宽相同的 0/1/x 串按二进制；0x 开头按十六进制；纯数字按十进制
  function parseSet(s, f) {
    var w = fw(f), t = String(s == null ? '' : s).trim(), x = null;
    if (/^[01x]+$/i.test(t) && t.length === w) x = parseInt(t.replace(/x/gi, '0'), 2);
    else if (/^0x[0-9a-f]+$/i.test(t)) x = parseInt(t.slice(2), 16);
    else if (/^\d+$/.test(t)) x = parseInt(t, 10);
    return x != null && isFinite(x) && x >= 0 && x <= p2(w) - 1 ? x : null;
  }
  function parseNum(s, w) {
    var t = String(s == null ? '' : s).trim().replace(/[\s_]/g, ''), x = null;
    if (/^0x[0-9a-f]+$/i.test(t)) x = parseInt(t.slice(2), 16);
    else if (/^0b[01]+$/i.test(t)) x = parseInt(t.slice(2), 2);
    else if (/^\d+$/.test(t)) x = parseInt(t, 10);
    if (x == null || !isFinite(x)) return { err: '格式' };
    if (x > p2(w) - 1) return { err: '越界' };
    return { x: x };
  }
  function yOf(f) {
    if (f.pin != null && isFinite(Number(f.pin))) return Number(f.pin);
    var m = /(\d+)$/.exec(String(f.name));
    return m ? Number(m[1]) : null;
  }
  function P(r) {
    if (PRE[r.id]) return PRE[r.id];
    var w = Number(r.width) === 16 ? 16 : 32, rs = parseReset(r.reset), p = { w: w, reset: rs.v, x: rs.x, ro: 0, m1: 0, byName: {}, all: [], ys: [], reps: [], reset1: null };
    r.fields.forEach(function (f) {
      p.all.push(f);
      if (!own(p.byName, f.name)) p.byName[f.name] = f;
      if (f.rw === 'r' && !f.reserved) p.ro = (p.ro | fmask(f)) >>> 0;
      if (f.reserved && /保持为\s*1/.test(String(f.desc || ''))) p.m1 = (p.m1 | fmask(f)) >>> 0;   // I2C_OAR1 bit14
    });
    (Array.isArray(r.alt) ? r.alt : []).forEach(function (a) {
      (a.fields || []).forEach(function (f) { p.all.push(f); if (!own(p.byName, f.name)) p.byName[f.name] = f; });
    });
    if (r.repeat && Array.isArray(r.repeat.pattern)) {
      p.reps = r.repeat.pattern.slice();
      r.fields.forEach(function (f) {
        if (f.rep && p.reps.indexOf(f.rep) > -1) { var y = yOf(f); if (y != null && p.ys.indexOf(y) < 0) p.ys.push(y); }
      });
      p.ys.sort(function (a, b) { return a - b; });
    }
    var m = /BCR1\s*为\s*(0x[0-9A-Fa-f]{4}\s?[0-9A-Fa-f]{4})/.exec(String(r.resetText || ''));
    if (m) p.reset1 = parseReset(m[1]).v;
    p.kind = regKind(r, p);
    PRE[r.id] = p;
    return p;
  }
  function isRep(r, f) { var p = P(r); return !!(f.rep && p.reps.indexOf(f.rep) > -1 && p.ys.length > 1); }
  // 写入方式：ro 只读 / direct 只写·写 1 生效 / flag0 写 0 清除 / key 带钥匙（AIRCR）/ swj 含只写位（AFIO_MAPR）/ bytes 按字节（NVIC_IPR）/ rmw
  function regKind(r, p) {
    var ws = r.fields.filter(function (f) { return !f.reserved && f.rw !== 'r' && f.rw !== 'res'; });
    if (!ws.length) return 'ro';
    if (own(p.byName, 'VECTKEY')) return 'key';
    if (/IP\[/.test(String(r.cmsisStruct || ''))) return 'bytes';
    if (ws.every(function (f) { return /^(w|rs|rc_w1|rc_w)$/.test(f.rw); })) return 'direct';
    if (ws.every(function (f) { return f.rw === 'rc_w0'; })) return 'flag0';
    if (ws.some(function (f) { return f.rw === 'w'; })) return 'swj';
    return 'rmw';
  }
  function writable(f, inst) { return !f.reserved && f.rw !== 'r' && f.rw !== 'res' && !naOnly(f.only, inst); }
  // only：TIM1/8 看实例；XL / 互联型在 ZET6（大容量）上都没有
  function naOnly(only, inst) {
    if (!only) return false;
    if (only === 'TIM1/8') return !(inst && (inst.name === 'TIM1' || inst.name === 'TIM8'));
    return true;
  }
  function naWhy(only) { return only === 'TIM1/8' ? '仅 TIM1/8' : 'ZET6 无（仅 ' + only + '）'; }

  /* ---- 实例 / 通道 ---- */
  function instList(r) {
    var g = GOF[r.id], all = (g.instances || []).filter(function (i) { return i && i.name; });
    if (r.base) { var b = all.filter(function (i) { return i.name === r.base; }); return b.length ? b : all.slice(0, 1); }
    var bases = g.regs.filter(function (x) { return x.base; }).map(function (x) { return x.base; });
    var l = all.filter(function (i) { return bases.indexOf(i.name) < 0; });
    return l.length ? l : all;
  }
  function defInst(r) {
    var l = instList(r);
    for (var i = 0; i < l.length; i++) if (l[i].kind === '通用') return l[i];
    return l[0] || null;
  }
  function nRange(r, inst) {
    if (!r.stride) return null;
    var lo = /^NVIC_/.test(r.id) ? 0 : 1, cnt = Number(r.count) || 1;
    if (GOF[r.id].id === 'dma' && inst && inst.channels) cnt = Number(inst.channels) || cnt;
    return { lo: lo, hi: lo + cnt - 1 };
  }
  function nKey(r) { return GOF[r.id].id === 'dma' ? 'dma' : r.id; }
  function member(r) { return String(r.name).slice(String(r.name).indexOf('_') + 1).replace(/x$/, ''); }
  function addrOf(r, inst, n) {
    if (!inst) return null;
    var b = parseHexStr(inst.base), o = parseHexStr(r.offset);
    if (b == null || o == null) return null;
    var rg = nRange(r, inst);
    return (b + o + (rg ? Number(r.stride) * (n - rg.lo) : 0)) >>> 0;
  }
  // C 里的寄存器表达式：GPIOA->CRL、DMA1_Channel3->CCR、NVIC->ISER[0]、AFIO->EXTICR[2]、FSMC_Bank1->BTCR[6]、SysTick->CTRL
  function regExpr(r, inst, n) {
    var cs = String(r.cmsisStruct || ''), m = /^([A-Za-z_][A-Za-z0-9_]*->[A-Za-z_][A-Za-z0-9_]*)\[/.exec(cs);
    if (m) return m[1] + '[' + n + ']';
    if (r.id === 'FSMC_BCR') return 'FSMC_Bank1->BTCR[' + (2 * (n - 1)) + ']';
    if (r.id === 'FSMC_BTR') return 'FSMC_Bank1->BTCR[' + (2 * (n - 1) + 1) + ']';
    var mem = member(r), me = /^EXTICR(\d)$/.exec(mem);
    if (me) mem = 'EXTICR[' + (Number(me[1]) - 1) + ']';
    var base = inst ? inst.name : GOF[r.id].name;
    if (r.stride && GOF[r.id].id === 'dma') base = base + '_Channel' + n;
    return base + '->' + mem;
  }

  /* ---- 取值 / cases / alt ---- */
  var ST = {};
  function initVal(r, n) { var p = P(r); return ((n === 1 && p.reset1 != null ? p.reset1 : p.reset) | p.m1) >>> 0; }
  function stOf(r, inst, n) {
    var k = r.id + '|' + (inst ? inst.name : '') + '|' + (n == null ? '' : n);
    if (!ST[k]) ST[k] = { v: initVal(r, n), touched: {}, quick: -1 };
    return ST[k];
  }
  function encode(r, v) { var p = P(r); return ((v & ~p.ro) | p.m1) >>> 0; }
  function quickVal(r, q) {
    var p = P(r), v = ((p.reset & ~p.ro) | p.m1) >>> 0, miss = [], keys = [];
    Object.keys(q.set || {}).forEach(function (k) {
      var f = p.byName[k], x = f ? parseSet(q.set[k], f) : null;
      if (!f || x == null) { miss.push(k); return; }
      v = fset(v, f, x); keys.push(k);
    });
    return { v: v >>> 0, miss: miss, keys: keys };
  }
  function condVal(cond, r, v, inst) {
    var src = r, sv = v;
    if (cond.reg) {
      src = BYNAME[GOF[r.id].id][cond.reg];
      if (!src) return null;
      var oi = inst && instList(src).indexOf(inst) > -1 ? inst : curInst(src);
      sv = stOf(src, oi, curN(src, oi)).v;
    }
    var f = P(src).byName[cond.field];
    if (!f) return null;
    return { b: bin(fget(sv, f), fw(f)), src: src };
  }
  function condTrue(cond, r, v, inst) {
    var c = cond ? condVal(cond, r, v, inst) : null;
    if (!c) return null;
    if (cond.eq != null) return wild(cond.eq, c.b);
    if (cond.ne != null) return !wild(cond.ne, c.b);
    return null;
  }
  function altOn(r, a, v) { return condTrue(a.if, r, v, null) === true; }
  function layout(r, v) {
    if (!Array.isArray(r.alt) || !r.alt.length) return r.fields;
    var act = r.alt.filter(function (a) { return a && Array.isArray(a.bits) && altOn(r, a, v); });
    if (!act.length) return r.fields;
    var out = [], done = [];
    r.fields.forEach(function (f) {
      var a = null;
      act.forEach(function (x) { if (f.bits[0] <= x.bits[0] && f.bits[1] >= x.bits[1]) a = x; });
      if (!a) { out.push(f); return; }
      if (done.indexOf(a) < 0) { done.push(a); a.fields.forEach(function (af) { out.push(af); }); }
    });
    return out;
  }
  function paren(s) { var m = /[（(]([^）)]+)[）)]/.exec(String(s || '')); return m ? m[1] : ''; }
  // 字段当前的取值表 + 解释依据
  function info(r, f, v, inst) {
    if (Array.isArray(f.values) && f.values.length) return { vals: f.values };
    if (Array.isArray(f.cases) && f.cases.length) {
      var hit = null, why = '';
      for (var i = 0; i < f.cases.length && !hit; i++) {
        var c = f.cases[i];
        if (Array.isArray(c.inst)) {
          if (inst && c.inst.indexOf(inst.name) > -1) { hit = c; why = '按 ' + inst.name + ' 解释'; }
        } else if (c.if && condTrue(c.if, r, v, inst) === true) {
          hit = c;
          var cv = condVal(c.if, r, v, inst), lab = paren(c.when);
          why = '按 ' + c.if.field + '=' + cv.b + (lab ? '（' + lab + '）解释' : ' 解释');
          if (c.if.reg) why += ' · 取自 ' + (inst ? inst.name + '_' : '') + member(cv.src);
        }
      }
      if (!hit) { hit = f.cases[0]; why = '按 ' + (hit.when || '默认') + ' 解释'; }
      return { vals: Array.isArray(hit.values) ? hit.values : [], basis: why };
    }
    if (fw(f) === 1 && !f.reserved) return { vals: BIT01 };
    return { vals: null, numeric: !f.reserved };
  }
  function meaning(inf, b) {
    if (!inf.vals) return '';
    for (var i = 0; i < inf.vals.length; i++) if (wild(inf.vals[i].v, b)) return String(inf.vals[i].t || '');
    return '';
  }
  function curInst(r) {
    var l = instList(r);
    if (l.length <= 1) return l[0] || null;
    var name = U.inst[GOF[r.id].id];
    for (var i = 0; i < l.length; i++) if (l[i].name === name) return l[i];
    return defInst(r);
  }
  function curN(r, inst) {
    var rg = nRange(r, inst);
    if (!rg) return null;
    var n = U.n[nKey(r)];
    return n != null && n >= rg.lo && n <= rg.hi ? n : rg.lo;
  }
  function curY(r) {
    var ys = P(r).ys;
    if (ys.length < 2) return null;
    var y = U.y[r.id];
    return ys.indexOf(y) > -1 ? y : ys[0];
  }

  // 有 hex 的速查按同规则核算一遍，不一致只在控制台提示（以计算值为准）
  function verifyQuicks() {
    var bad = [];
    GROUPS.forEach(function (g) {
      g.regs.forEach(function (r) {
        (r.quick || []).forEach(function (q, i) {
          var qv = quickVal(r, q);
          if (qv.miss.length) bad.push(r.id + ' #' + i + ' set 未识别 ' + qv.miss.join(','));
          if (q.hex != null) { var h = parseHexStr(q.hex); if (h !== qv.v) bad.push(r.id + ' #' + i + '「' + q.title + '」 数据 ' + q.hex + ' ≠ 计算 ' + hexC(qv.v, P(r).w)); }
        });
      });
    });
    if (bad.length && window.console && console.warn) console.warn('[regs] 速查 hex 核对：\n' + bad.join('\n'));
  }

  /* ================= 界面 ================= */

  var app = null, pane = null, mounted = false;
  var U = { g: null, open: null, sel: null, filter: null, inst: {}, n: {}, y: {}, q: '' };
  var X = {};          // 顶层节点
  var cards = {};      // reg id -> card
  var uidN = 0;
  function uid(p) { return 'rg-' + (p || 'u') + (++uidN); }
  function E(tag, cls, text) { return app.el(tag, cls, text); }
  function clear(n) { while (n && n.firstChild) n.removeChild(n.firstChild); }
  function btn(cls, text, label) { var b = E('button', cls, text); b.type = 'button'; if (label) b.setAttribute('aria-label', label); return b; }
  function svgIcon(paths, cls) {
    var s = document.createElementNS(SVGNS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true'); s.setAttribute('focusable', 'false');
    if (cls) s.setAttribute('class', cls);
    paths.forEach(function (d) { var p = document.createElementNS(SVGNS, 'path'); p.setAttribute('d', d); s.appendChild(p); });
    return s;
  }
  var IC_LOCK = ['M8 11V8.5a4 4 0 0 1 8 0V11', 'M6.5 11h11v8.5h-11Z'];
  var IC_X = ['M7 7l10 10M17 7 7 17'];
  var IC_CHEV = ['M6.5 9.5 12 15l5.5-5.5'];
  function focusEl(n) { if (!n) return; try { n.focus({ preventScroll: true }); } catch (e) { try { n.focus(); } catch (e2) {} } }
  // 可靠聚焦：focus 失败（如减弱动效下 visibility 仍在过渡、刚取消 inert）时逐帧重试，最多约 500ms；
  // 用户已把焦点移走、离开 regs tab、目标断开 / alive() 为假、或又发起新一次聚焦（含新的 goReg）即停止，超时不降级
  var focusTok = 0;
  function canFocus(n) {
    if (!n || !n.isConnected || (n.closest && n.closest('[inert]'))) return false;
    if (typeof n.checkVisibility === 'function' && !n.checkVisibility()) return false;
    return getComputedStyle(n).visibility === 'visible' && n.getClientRects().length > 0;
  }
  function focusSoon(n, alive) {
    var tok = ++focusTok;
    if (!n) return;
    var a0 = document.activeElement;
    focusEl(n);
    if (document.activeElement === n) return;
    var t0 = Date.now();
    (function wait() {
      requestAnimationFrame(function () {
        if (tok !== focusTok) return;
        var a = document.activeElement;
        if (a === n) return;
        if (a && a !== a0 && a !== document.body && a !== document.documentElement) return;
        if (!n.isConnected || !mounted || app.curTab() !== 'regs' || (alive && !alive())) return;
        if (Date.now() - t0 > 500) return;
        if (canFocus(n)) { focusEl(n); if (document.activeElement === n) return; }
        wait();
      });
    })();
  }
  function isTyping(n) { return !!(n && (n.tagName === 'INPUT' || n.tagName === 'TEXTAREA' || n.isContentEditable)); }
  function smooth() { return app.reduced() ? 'auto' : 'smooth'; }
  function cssEsc(s) { return window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&'); }
  // 重建一块 DOM 时保住焦点：按 data-fk 找回同一个控件
  function keepFocus(root, fn) {
    var a = document.activeElement, key = a && root.contains(a) && a.getAttribute ? a.getAttribute('data-fk') : null;
    fn();
    if (key && !root.contains(document.activeElement)) focusEl(root.querySelector('[data-fk="' + cssEsc(key) + '"]'));
  }
  // 等滚动停下（scrollend 或连续 8 帧不动，最长 1.5s）
  function afterScroll(box, cb) {
    var done = false, last = box.scrollTop, still = 0, raf = 0, tmo = 0;
    function fin() { if (done) return; done = true; box.removeEventListener('scrollend', fin); cancelAnimationFrame(raf); clearTimeout(tmo); cb(); }
    if ('onscrollend' in window) box.addEventListener('scrollend', fin);
    (function tick() {
      var v = box.scrollTop;
      if (Math.abs(v - last) < 0.5) still++; else { still = 0; last = v; }
      if (still >= 8) { fin(); return; }
      raf = requestAnimationFrame(tick);
    })();
    tmo = setTimeout(fin, 1500);
  }

  /* ---- 单选条（实例 / 通道 / y / 输出·输入）：roving tabindex + 方向键 ---- */
  function radios(label, items, cur, onPick, cls) {
    var wrap = E('div', 'rg-rad' + (cls ? ' ' + cls : ''));
    var lab = E('span', 'rg-radl', label); lab.id = uid('l');
    var grp = E('div', 'rg-radg');
    grp.setAttribute('role', 'radiogroup'); grp.setAttribute('aria-labelledby', lab.id);
    var btns = items.map(function (it) {
      var b = btn('rg-r', it.text);
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(it.key) === String(cur) ? 'true' : 'false');
      b.tabIndex = String(it.key) === String(cur) ? 0 : -1;
      b.setAttribute('data-k', String(it.key));
      b.setAttribute('data-fk', 'r:' + label + ':' + it.key);
      if (it.title) b.title = it.title;
      if (it.aria) b.setAttribute('aria-label', it.aria);
      grp.appendChild(b);
      return b;
    });
    if (btns.length && !btns.some(function (b) { return b.tabIndex === 0; })) btns[0].tabIndex = 0;
    grp.addEventListener('click', function (e) {
      var b = e.target.closest('.rg-r');
      if (b && grp.contains(b) && b.getAttribute('aria-checked') !== 'true') onPick(b.getAttribute('data-k'));
    });
    grp.addEventListener('keydown', function (e) {
      var k = e.key, i = btns.indexOf(document.activeElement);
      if (i < 0 || e.altKey || e.ctrlKey || e.metaKey) return;
      var j = -1, n = btns.length;
      if (k === 'ArrowRight' || k === 'ArrowDown') j = (i + 1) % n;
      else if (k === 'ArrowLeft' || k === 'ArrowUp') j = (i + n - 1) % n;
      else if (k === 'Home') j = 0; else if (k === 'End') j = n - 1;
      if (j < 0) return;
      e.preventDefault();
      focusEl(btns[j]);
      onPick(btns[j].getAttribute('data-k'));
    });
    app.pressable(grp, '.rg-r');
    wrap.appendChild(lab); wrap.appendChild(grp);
    return wrap;
  }

  /* ================= 骨架 ================= */

  function buildSkeleton() {
    // 搜索框（沿用 .cmd 终端 prompt 样式）
    var box = E('label', 'cmd rg-cmd');
    box.appendChild(E('span', 'caret', '>'));
    var q = E('input', 'rg-q');
    q.type = 'search'; q.placeholder = 'CRL / MODE / 推挽 / 0x…';
    q.setAttribute('autocomplete', 'off'); q.setAttribute('autocorrect', 'off'); q.setAttribute('autocapitalize', 'off');
    q.spellcheck = false; q.setAttribute('enterkeyhint', 'search');
    q.setAttribute('aria-label', '搜索寄存器、位名、宏或中文；展开寄存器后输入 0x… 解码');
    var qn = E('span', 'qn'); qn.setAttribute('aria-hidden', 'true');
    var qx = btn('qx', null, '清除'); qx.hidden = true; qx.appendChild(svgIcon(IC_X));
    box.appendChild(q); box.appendChild(qn); box.appendChild(qx);
    app.pressable(qx);
    X.q = q; X.qn = qn; X.qx = qx; X.cmd = box;

    var filter = E('div', 'rg-filter'); filter.hidden = true;
    var fl = E('span', 'rg-filter-t'), fx = btn('rg-filter-x', null, '清除筛选');
    fx.appendChild(E('span', null, '✕'));
    filter.appendChild(fl); filter.appendChild(fx);
    X.filter = filter; X.filterT = fl;

    var gbar = E('div', 'rg-gbar');
    gbar.setAttribute('role', 'tablist'); gbar.setAttribute('aria-label', '外设分组');
    var ink = E('span', 'rg-gink'); ink.setAttribute('aria-hidden', 'true');
    gbar.appendChild(ink);
    X.gbtns = GROUPS.map(function (g) {
      var b = btn('rg-g', g.name);
      b.setAttribute('role', 'tab'); b.setAttribute('aria-controls', 'rg-main'); b.setAttribute('data-g', g.id);
      b.title = g.title || g.name;
      gbar.appendChild(b);
      return b;
    });
    X.gbar = gbar; X.gink = ink;

    var results = E('div', 'rg-results'); results.hidden = true; results.id = 'rg-results';
    results.setAttribute('aria-label', '搜索结果');
    var main = E('div', 'rg-main'); main.id = 'rg-main'; main.setAttribute('role', 'tabpanel');
    X.results = results; X.main = main;

    var live = E('div', 'rg-live'); live.setAttribute('role', 'status'); live.setAttribute('aria-live', 'polite');
    X.live = live;

    [box, filter, gbar, results, main, live].forEach(function (n) { pane.appendChild(n); });

    // 事件
    var qT = 0;
    q.addEventListener('input', function () { clearTimeout(qT); X.qx.hidden = !q.value; qT = setTimeout(runSearch, 120); });
    q.addEventListener('keydown', function (e) {
      if (e.isComposing) return;
      if (e.key === 'Enter') { e.preventDefault(); clearTimeout(qT); runSearch(); var f = X.results.querySelector('.rg-hit'); if (f && !X.results.hidden) f.click(); }
      else if (e.key === 'ArrowDown') { var h = X.results.querySelector('.rg-hit'); if (h && !X.results.hidden) { e.preventDefault(); focusEl(h); } }
    });
    qx.addEventListener('click', function (e) { e.preventDefault(); clearSearch(); focusEl(q); });
    fx.addEventListener('click', function () { setFilter(null); var b = X.gbtns[0]; focusEl(X.gbar.querySelector('.rg-g[tabindex="0"]') || b); });
    app.pressable(fx);
    gbar.addEventListener('click', function (e) {
      var b = e.target.closest('.rg-g');
      if (b && gbar.contains(b)) pickGroup(b.getAttribute('data-g'));
    });
    gbar.addEventListener('keydown', function (e) {
      app.rovingKeys(X.gbtns, e, function (b) { pickGroup(b.getAttribute('data-g')); });
    });
    app.pressable(gbar, '.rg-g');
    gbar.addEventListener('scroll', gfade, { passive: true });
    if (window.ResizeObserver) new ResizeObserver(function () { gfade(); placeInk(); }).observe(gbar);
    else window.addEventListener('resize', function () { gfade(); placeInk(); });
    results.addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      var hs = Array.prototype.slice.call(results.querySelectorAll('.rg-hit')), i = hs.indexOf(document.activeElement);
      if (i < 0) return;
      e.preventDefault();
      if (e.key === 'ArrowUp' && i === 0) { focusEl(q); return; }
      focusEl(hs[Math.max(0, Math.min(hs.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]);
    });
    app.pressable(results, '.rg-hit', true);
    app.pressable(main, '.rg-hbtn, .rg-q, .rg-lk, .rg-cw, .rg-reset, .copy, .rg-x, .rg-doubt, .rg-mtb, .rg-fxgo', true);
  }

  /* ---- 分组 chip 条：选中下划线（transform 平移 + scaleX） ---- */
  function gfade() {
    var b = X.gbar, max = b.scrollWidth - b.clientWidth;
    b.classList.toggle('fade-l', b.scrollLeft > 2);
    b.classList.toggle('fade-r', max > 2 && b.scrollLeft < max - 2);
  }
  function placeInk() {
    var b = X.gbar.querySelector('.rg-g[aria-selected="true"]');
    X.gink.style.opacity = b ? '1' : '0';
    if (!b || !b.offsetWidth) return;
    X.gink.style.transform = 'translateX(' + b.offsetLeft + 'px) scaleX(' + (b.offsetWidth / 100) + ')';
    if (!X.gbar.classList.contains('ready')) requestAnimationFrame(function () { X.gbar.classList.add('ready'); });
  }
  function revealG(b) {
    var bar = X.gbar, x0 = b.offsetLeft, l = x0 - 16, r = x0 + b.offsetWidth + 32 - bar.clientWidth, to = null;
    if (l < bar.scrollLeft) to = Math.max(0, l); else if (r > bar.scrollLeft) to = r;
    if (to == null) return;
    if (bar.scrollTo) bar.scrollTo({ left: to, behavior: smooth() }); else bar.scrollLeft = to;
  }
  function syncGbar() {
    var cur = U.filter ? null : U.g;
    X.gbtns.forEach(function (b) {
      var on = b.getAttribute('data-g') === cur;
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
      if (on) revealG(b);
    });
    if (!cur && X.gbtns[0]) X.gbtns[0].tabIndex = 0;
    placeInk(); gfade();
  }
  function pickGroup(id, keepOpen) {
    if (!GBY[id]) return;
    var same = U.g === id && !U.filter;
    U.filter = null; X.filter.hidden = true;
    U.g = id;
    if (!keepOpen && !same) { U.open = null; U.sel = null; }
    syncGbar();
    if (!same) { renderMain(); pane.scrollTop = 0; app.syncScrolled(); }
    save(); syncUrl();
  }
  function setFilter(f) {
    U.filter = f;
    X.filter.hidden = !f;
    if (f) X.filterT.textContent = f.label;
    U.open = null; U.sel = null;
    syncGbar(); renderMain();
    pane.scrollTop = 0; app.syncScrolled();
    syncUrl();
  }

  /* ================= 列表 ================= */

  function renderMain() {
    var m = X.main;
    clear(m); cards = {};
    if (U.filter) {
      GROUPS.forEach(function (g) {
        var rs = g.regs.filter(function (r) { return U.filter.ids.indexOf(r.id) > -1; });
        if (!rs.length) return;
        m.appendChild(E('h3', 'rg-fgh', g.name + ' · ' + (g.title || '')));
        rs.forEach(function (r) { m.appendChild(buildCard(r).root); });
      });
      if (!m.firstChild) m.appendChild(app.emptyState(E('div', 'vstate'), '无结果', 'search'));
      return;
    }
    var g = GBY[U.g];
    if (!g) return;
    m.appendChild(buildGroupHead(g));
    var list = E('div', 'rg-list');
    g.regs.forEach(function (r) { list.appendChild(buildCard(r).root); });
    m.appendChild(list);
  }

  function linkRow(label, items) {
    if (!items.length) return null;
    var row = E('div', 'rg-lrow');
    row.appendChild(E('span', 'rg-lrl', label));
    var sc = E('div', 'rg-lsc');
    items.forEach(function (it) { sc.appendChild(it); });
    row.appendChild(sc);
    return row;
  }
  function figBtn(id) {
    var t = app.figTitle ? app.figTitle(id) : (app.hasFig(id) ? id : null);
    if (t == null) return null;
    var b = btn('rg-lk', t, '图 ' + t);
    b.addEventListener('click', function () { app.gotoFig([id], b); });
    return b;
  }
  function snipBtn(s) {
    if (!s || !app.hasSnippet(String(s.cat), String(s.title))) return null;
    var b = btn('rg-lk', String(s.title), '代码片段 ' + s.title);
    b.addEventListener('click', function () { app.gotoCode(String(s.cat), String(s.title)); });
    return b;
  }
  function buildGroupHead(g) {
    var h = E('section', 'rg-gh');
    var t = E('h2', 'rg-gt');
    t.appendChild(E('span', 'rg-gtn', g.name));
    t.appendChild(E('span', 'rg-gtt', g.title || ''));
    h.appendChild(t);
    var inst = (g.instances || []).map(function (i) { return i.name; });
    if (inst.length > 1) h.appendChild(E('p', 'rg-gi', inst.join(' · ')));
    var figs = (g.figs || []).map(figBtn).filter(Boolean);
    var teach = (g.teach || []).map(figBtn).filter(Boolean);
    var snips = (g.snippets || []).map(snipBtn).filter(Boolean);
    [linkRow('手册图', figs), linkRow('教学图', teach), linkRow('代码', snips)].forEach(function (r) { if (r) h.appendChild(r); });
    if (g.note) h.appendChild(E('p', 'rg-note', g.note));
    if (g.source) h.appendChild(E('p', 'rg-note', '来源：' + g.source));
    if (Array.isArray(g.modeTable) && g.modeTable.length) {
      var tb = btn('rg-mtb', null);
      tb.setAttribute('aria-expanded', 'false');
      tb.appendChild(E('span', null, g.id === 'gpio' ? '16 种模式表' : '模式表'));
      tb.appendChild(svgIcon(IC_CHEV, 'rg-chev'));
      var wrap = E('div', 'rg-mtw'); wrap.hidden = true; wrap.id = uid('mt');
      tb.setAttribute('aria-controls', wrap.id);
      wrap.appendChild(modeTable(g));
      if (g.modeTableNote) wrap.appendChild(E('p', 'rg-note', g.modeTableNote));
      tb.addEventListener('click', function () {
        var on = wrap.hidden;
        wrap.hidden = !on; tb.setAttribute('aria-expanded', on ? 'true' : 'false');
      });
      h.appendChild(tb); h.appendChild(wrap);
    }
    return h;
  }
  function modeTable(g) {
    var rows = g.modeTable, cols;
    if (own(rows[0], 'cnf')) cols = [['title', '模式'], ['cnf', 'CNF'], ['mode', 'MODE'], ['nibble', '4 位'], ['odr', 'ODR']];
    else if (own(rows[0], 'cpol')) cols = [['mode', '模式'], ['cpol', 'CPOL'], ['cpha', 'CPHA'], ['text', '说明']];
    else cols = Object.keys(rows[0]).filter(function (k) { return k !== 'hal'; }).map(function (k) { return [k, k]; });
    var sc = E('div', 'rg-mts'), t = E('table', 'rg-mt'), th = E('thead'), tr = E('tr');
    cols.forEach(function (c) { tr.appendChild(E('th', null, c[1])); });
    th.appendChild(tr); t.appendChild(th);
    var tb = E('tbody');
    rows.forEach(function (r) {
      var row = E('tr');
      cols.forEach(function (c) { var v = r[c[0]]; row.appendChild(E('td', c[0] === 'title' || c[0] === 'text' ? 'rg-mtt' : null, v == null ? '–' : String(v))); });
      tb.appendChild(row);
    });
    t.appendChild(tb); sc.appendChild(t);
    return sc;
  }

  /* ---- 寄存器卡片（只建头；展开时才建主体） ---- */
  function resetShown(r) { return r.resetText ? String(r.resetText) : String(r.reset || ''); }
  function buildCard(r) {
    var c = { r: r, built: false, p: {}, lastBits: null };
    var root = E('article', 'rg-card'); root.id = 'rg-c-' + r.id; root.setAttribute('data-reg', r.id);
    var ch = E('div', 'rg-ch');
    var hb = btn('rg-hbtn'); hb.id = uid('h');
    var bodyId = uid('b');
    hb.setAttribute('aria-expanded', 'false'); hb.setAttribute('aria-controls', bodyId);
    hb.setAttribute('data-fk', 'hdr');
    var l1 = E('span', 'rg-hl1');
    l1.appendChild(E('span', 'rg-hn', r.name));
    if (r.only) l1.appendChild(E('span', 'rg-only', r.only));
    l1.appendChild(E('span', 'rg-ht', r.title || ''));
    hb.appendChild(l1);
    hb.appendChild(E('span', 'rg-hm', '偏移 ' + r.offset + (r.stride ? ' + ' + r.stride + '×n' : '') + ' · 复位 ' + resetShown(r)));
    hb.appendChild(svgIcon(IC_CHEV, 'rg-chev'));
    ch.appendChild(hb);
    var tip = null;
    if (Array.isArray(r.doubt) && r.doubt.length) {
      var db = btn('rg-doubt', null, '存疑：查看原因');
      db.appendChild(E('span', 'rg-ddot'));
      db.appendChild(E('span', null, '存疑'));
      tip = E('p', 'rg-dtip', r.doubt.join(' '));
      tip.id = uid('d'); tip.hidden = true;
      db.title = r.doubt.join(' ');
      db.setAttribute('aria-expanded', 'false'); db.setAttribute('aria-controls', tip.id);
      db.addEventListener('click', function () {
        var on = tip.hidden;
        tip.hidden = !on; db.setAttribute('aria-expanded', on ? 'true' : 'false');
      });
      ch.appendChild(db);
    }
    root.appendChild(ch);
    if (tip) root.appendChild(tip);
    var bw = E('div', 'rg-bw'); bw.id = bodyId;
    bw.setAttribute('role', 'region'); bw.setAttribute('aria-labelledby', hb.id);
    bw.inert = true;
    var bi = E('div', 'rg-bi');
    bw.appendChild(bi);
    root.appendChild(bw);
    hb.addEventListener('click', function () { if (U.open === r.id) collapse(true); else expand(r.id, { scroll: 'nearest' }); });
    c.root = root; c.hb = hb; c.bw = bw; c.bi = bi;
    cards[r.id] = c;
    updateHeader(c);
    return c;
  }
  function updateHeader(c) {
    var inst = curInst(c.r);
    c.root.classList.toggle('rg-na-reg', naOnly(c.r.only, inst));
  }

  /* ---- 展开 / 收起（grid-template-rows 0fr → 1fr，约 200ms；上方卡片瞬时收起并补偿滚动，不跳动） ---- */
  var settleT = 0;
  function collapseCard(c, instant) {
    c.root.classList.remove('settled');
    if (instant) c.root.classList.add('rg-instant');
    c.root.classList.remove('open');
    c.hb.setAttribute('aria-expanded', 'false');
    c.bw.inert = true;
    if (instant) { void c.root.offsetHeight; requestAnimationFrame(function () { c.root.classList.remove('rg-instant'); }); }
  }
  function collapse(focusHdr) {
    var c = U.open && cards[U.open];
    U.open = null; U.sel = null;
    if (c) { collapseCard(c, app.reduced()); if (focusHdr) focusEl(c.hb); }
    save(); syncUrl();
  }
  function expand(id, o) {
    o = o || {};
    var c = cards[id];
    if (!c) return null;
    var prev = U.open && U.open !== id ? cards[U.open] : null;
    if (prev) {
      var above = prev.root.compareDocumentPosition(c.root) & Node.DOCUMENT_POSITION_FOLLOWING;
      var t0 = c.root.getBoundingClientRect().top;
      collapseCard(prev, above || app.reduced());
      if (above) { var d = c.root.getBoundingClientRect().top - t0; if (d) pane.scrollTop += d; }
    }
    if (U.open !== id) U.sel = o.field || null;
    else if (o.field) U.sel = o.field;
    U.open = id;
    if (!c.built) buildBody(c);
    refresh(c, {});
    var instant = app.reduced() || o.instant;
    if (instant) c.root.classList.add('rg-instant');
    c.root.classList.add('open');
    c.hb.setAttribute('aria-expanded', 'true');
    c.bw.inert = false;
    clearTimeout(settleT);
    if (instant) { void c.root.offsetHeight; c.root.classList.remove('rg-instant'); c.root.classList.add('settled'); }
    else settleT = setTimeout(function () { if (U.open === id) c.root.classList.add('settled'); }, 230);
    save(); syncUrl();
    if (o.scroll === 'nearest') requestAnimationFrame(function () {
      var pr = pane.getBoundingClientRect(), hr = c.hb.getBoundingClientRect();
      var topLim = pr.top + topOffset();
      if (hr.top < topLim || hr.top > pr.bottom - 160) pane.scrollTo({ top: pane.scrollTop + hr.top - topLim, behavior: smooth() });
    });
    return c;
  }
  function topOffset() {
    var app0 = document.getElementById('app'), th = app0 ? parseFloat(getComputedStyle(app0).getPropertyValue('--top-h')) || 104 : 104;
    return th + 6 + (X.cmd ? X.cmd.offsetHeight + 12 : 60);
  }

  /* ---- 卡片主体（第一次展开才建） ---- */
  function buildBody(c) {
    var r = c.r, bi = c.bi, p = c.p;
    p.meta = E('div', 'rg-meta');
    p.sels = E('div', 'rg-sels');
    p.na = E('p', 'rg-warn rg-nanote'); p.na.hidden = true;
    p.barw = E('div', 'rg-barw');
    p.vt = E('div', 'rg-vt'); p.vt.hidden = true; p.vt.id = uid('vt');
    // 计算条
    var calc = E('div', 'rg-calc');
    var row = E('div', 'rg-hexrow');
    var hex = E('input', 'rg-hex');
    hex.type = 'text'; hex.spellcheck = false;
    hex.setAttribute('autocomplete', 'off'); hex.setAttribute('autocorrect', 'off'); hex.setAttribute('autocapitalize', 'off');
    hex.setAttribute('inputmode', 'text'); hex.setAttribute('enterkeyhint', 'done');
    hex.setAttribute('aria-label', r.name + ' 的值（可粘贴十六进制反向解码）');
    var plain = E('span', 'rg-sr');
    var cp = app.copyBtn('复制十六进制值'); cp.classList.add('rg-cp');
    var rs = btn('rg-reset', null, '复位到复位值'); rs.appendChild(app.icon('retry')); rs.appendChild(E('span', null, '复位'));
    row.appendChild(hex); row.appendChild(cp); row.appendChild(rs);
    var hint = E('p', 'rg-hexhint'); hint.hidden = true;
    var addr = E('div', 'rg-addr');
    calc.appendChild(row); calc.appendChild(plain); calc.appendChild(hint); calc.appendChild(addr);
    p.calc = calc; p.hex = hex; p.hexPlain = plain; p.hint = hint; p.addr = addr;
    p.fx = r.formula ? E('div', 'rg-fx') : null;
    p.warns = E('div', 'rg-warns');
    p.codes = E('div', 'rg-codes');
    p.cReg = codeBlock('寄存器写法');
    p.cHal = codeBlock('HAL 写法'); p.cHal.hidden = true;
    p.codes.appendChild(p.cReg); p.codes.appendChild(p.cHal);
    p.quick = null;
    if (Array.isArray(r.quick) && r.quick.length) {
      p.quick = E('div', 'rg-qs');
      p.quick.appendChild(E('h4', 'rg-sh', '常用配置'));
      var chips = E('div', 'rg-qchips');
      p.qbtns = r.quick.map(function (q, i) {
        var b = btn('rg-q', q.title);
        b.setAttribute('aria-pressed', 'false'); b.setAttribute('data-i', String(i)); b.setAttribute('data-fk', 'q:' + i);
        chips.appendChild(b);
        return b;
      });
      chips.addEventListener('click', function (e) {
        var b = e.target.closest('.rg-q');
        if (b && chips.contains(b)) applyQuick(c, Number(b.getAttribute('data-i')));
      });
      p.qd = E('div', 'rg-qd'); p.qd.hidden = true;
      p.quick.appendChild(chips); p.quick.appendChild(p.qd);
    }
    [p.meta, p.sels, p.na, p.barw, p.vt, p.fx, calc, p.warns, p.codes, p.quick].forEach(function (n) { if (n) bi.appendChild(n); });

    hex.addEventListener('input', function () {
      var t = hex.value.replace(/[\s_]/g, ''), w = P(r).w;
      var ok = /^(0x)?[0-9a-f]+$/i.test(t) && t.replace(/^0x/i, '').length <= w / 4;
      hex.setAttribute('aria-invalid', ok || !t ? 'false' : 'true');
      hint.hidden = ok || !t;
      hint.textContent = ok || !t ? '' : '需要 ' + (w / 4) + ' 位以内的十六进制';
      if (ok) decode(c, parseInt(t.replace(/^0x/i, ''), 16) >>> 0, true);
    });
    hex.addEventListener('focus', function () { try { hex.select(); } catch (e) {} });
    hex.addEventListener('blur', function () { hex.setAttribute('aria-invalid', 'false'); hint.hidden = true; renderCalc(c); });
    hex.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); renderCalc(c); try { hex.select(); } catch (err) {} } });
    cp.addEventListener('click', function () { app.copyText(hexC(c.st.v, P(r).w), cp, plain); });
    rs.addEventListener('click', function () { resetReg(c); });
    // 位段条：点击 / 键盘（左右方向键在字段间移动，Enter / 空格打开取值表）
    p.barw.addEventListener('click', function (e) {
      var b = e.target.closest('.rg-f');
      if (!b || !p.barw.contains(b)) return;
      pickField(c, b.getAttribute('data-fn'), e.detail === 0);
    });
    p.barw.addEventListener('keydown', function (e) {
      var k = e.key;
      if (k !== 'ArrowLeft' && k !== 'ArrowRight' && k !== 'Home' && k !== 'End') return;
      var bs = Array.prototype.slice.call(p.barw.querySelectorAll('.rg-f[data-prim="1"]')), i = bs.indexOf(document.activeElement);
      if (i < 0) return;
      e.preventDefault();
      var j = k === 'Home' ? 0 : k === 'End' ? bs.length - 1 : Math.max(0, Math.min(bs.length - 1, i + (k === 'ArrowRight' ? 1 : -1)));
      bs.forEach(function (b, n) { b.tabIndex = n === j ? 0 : -1; });
      focusEl(bs[j]);
    });
    c.built = true;
  }
  function codeBlock(label) {
    var w = E('div', 'rg-cb'), h = E('div', 'rg-cbh');
    var t = E('span', 'rg-cbt', label);
    var b = app.copyBtn('复制' + label);
    h.appendChild(t); h.appendChild(b);
    var pre = E('pre', 'code'), code = E('code');
    pre.appendChild(code);
    w.appendChild(h); w.appendChild(pre);
    w._t = t; w._code = code; w._text = ''; w._label = label;
    b.addEventListener('click', function () { app.copyText(app.plainCode(w._text), b, code); });
    return w;
  }
  function setCode(w, text, title) {
    if (title != null) w._t.textContent = title;
    if (w._text === text) return;
    w._text = text;
    clear(w._code);
    w._code.appendChild(app.hlC(text));
  }

  /* ================= 刷新 ================= */

  function ctx(c) {
    c.inst = curInst(c.r);
    c.n = curN(c.r, c.inst);
    c.st = stOf(c.r, c.inst, c.n);
    c.lay = layout(c.r, c.st.v);
  }
  function refresh(c, o) {
    o = o || {};
    ctx(c);
    keepFocus(c.bi, function () {
      renderMeta(c);
      renderSels(c);
      renderNa(c);
      renderBar(c, !!o.anim && !app.reduced(), o.morph);
      if (o.numFrom) updateNum(c); else renderVT(c);
      renderFx(c);
      renderCalc(c, o.fromHex);
      renderWarns(c);
      renderCodes(c);
      renderQuick(c);
    });
    updateHeader(c);
  }

  function renderMeta(c) {
    var r = c.r, m = c.p.meta, inst = c.inst;
    clear(m);
    var pg = r.page || {}, adv = inst && (inst.name === 'TIM1' || inst.name === 'TIM8') && pg.en_adv != null;
    var en = adv ? pg.en_adv : pg.en, cn = adv ? pg.cn_adv : pg.cn, parts = [];
    if (en != null) parts.push('EN p' + en);
    if (cn != null) parts.push('中 p' + cn);
    if (!parts.length && pg.pm0056) parts.push('PM0056 §' + pg.pm0056);
    var top = E('div', 'rg-mrow');
    if (parts.length) { var pgs = E('span', 'rg-pg', parts.join(' · ')); pgs.title = '手册 PDF 页码' + (adv ? '（高级定时器章节）' : ''); top.appendChild(pgs); }
    (Array.isArray(r.cw) ? r.cw : []).forEach(function (w) {
      if (!w || !Array.isArray(w.pages)) return;
      var ok = w.pages.filter(function (n) { return app.hasCw(w.part, n); });
      if (!ok.length) return;
      var cwr = E('span', 'rg-cwr');
      cwr.appendChild(E('span', 'rg-cwl', '课件 ' + w.part));
      ok.forEach(function (n) {
        var b = btn('rg-cw', String(n), '课件 ' + w.part + ' 第 ' + n + ' 页');
        b.addEventListener('click', function () { app.openCw(w.part, n, b); });
        cwr.appendChild(b);
      });
      if (w.more) cwr.appendChild(E('span', 'rg-cwm', '+' + w.more));
      top.appendChild(cwr);
    });
    if (top.firstChild) m.appendChild(top);
    var notes = [];
    if (r.offsetText) notes.push('偏移 = ' + r.offsetText);
    if (r.resetText) notes.push('复位值：' + r.resetText);
    if (r.resetNote) notes.push(r.resetNote);
    if (r.instancesNote) notes.push(r.instancesNote);
    (Array.isArray(r.notes) ? r.notes : []).forEach(function (n) { notes.push(n); });
    if (r.modeNote) notes.push(r.modeNote);
    if (r.repeat && r.repeat.note) notes.push(r.repeat.note);
    notes.forEach(function (n) { m.appendChild(E('p', 'rg-note', n)); });
  }

  function renderSels(c) {
    var r = c.r, s = c.p.sels, g = GOF[r.id], p = P(r);
    clear(s);
    var il = instList(r);
    if (il.length > 1) {
      s.appendChild(radios('实例', il.map(function (i) { return { key: i.name, text: i.name, title: i.kind ? i.kind + '定时器' : '' }; }), c.inst ? c.inst.name : '', function (k) {
        U.inst[g.id] = k; refresh(c, { anim: true }); syncUrl();
      }, 'rg-rad-inst'));
    }
    var rg = nRange(r, c.inst);
    if (rg) {
      var its = [];
      for (var n = rg.lo; n <= rg.hi; n++) its.push({ key: n, text: g.id === 'dma' ? String(n) : member(r) + n });
      s.appendChild(radios(g.id === 'dma' ? '通道' : '编号', its, c.n, function (k) { U.n[nKey(r)] = Number(k); refresh(c, { anim: true }); }, 'rg-rad-n'));
    }
    if (Array.isArray(r.alt) && r.alt.length) {
      r.alt.slice().sort(function (a, b) { return a.bits[1] - b.bits[1]; }).forEach(function (a) {
        var m = /CC(\d)S/.exec(String(a.if && a.if.field)), ch = m ? m[1] : '?';
        var on = altOn(r, a, c.st.v);
        s.appendChild(radios('CH' + ch, [{ key: 'oc', text: '输出比较' }, { key: 'ic', text: '输入捕获' }], on ? 'ic' : 'oc', function (k) {
          altSwitch(c, a, k === 'ic');
        }, 'rg-rad-alt'));
      });
    }
    if (p.ys.length > 1) {
      var lab = repLabel(p.reps[0]);
      var yw = radios(lab, p.ys.map(function (y) { return { key: y, text: String(y) }; }), curY(r), function (k) {
        var y = Number(k), f = selField(c);
        U.y[r.id] = y;
        if (f && isRep(r, f)) { var nf = repSibling(r, f, y); U.sel = nf ? nf.name : null; }
        refresh(c, {}); syncUrl();
      }, 'rg-rad-y');
      yw.appendChild(E('span', 'rg-xn', '×' + p.ys.length));
      s.appendChild(yw);
    }
    s.hidden = !s.firstChild;
  }
  function repLabel(rep) {
    rep = String(rep || '');
    if (/^(CNF|MODE|IDR|ODR|BR|BS|LCK)/.test(rep)) return '引脚';
    if (/^(MR|TR|SWIER|PR|EXTI)/.test(rep)) return '线';
    if (/IF/.test(rep) || /^SMP/.test(rep)) return '通道';
    if (/^SQ/.test(rep)) return '序号';
    return 'y';
  }
  function repSibling(r, f, y) {
    var out = null;
    r.fields.forEach(function (x) { if (!out && x.rep === f.rep && yOf(x) === y) out = x; });
    return out;
  }
  function renderNa(c) {
    var na = naOnly(c.r.only, c.inst);
    c.p.na.hidden = !na;
    c.p.na.textContent = na ? (c.inst ? c.inst.name + ' 没有这个寄存器（' + naWhy(c.r.only) + '）' : naWhy(c.r.only)) : '';
  }

  /* ---- 位段条 ---- */
  function selField(c) {
    if (!U.sel || U.open !== c.r.id) return null;
    for (var i = 0; i < c.lay.length; i++) if (c.lay[i].name === U.sel) return c.lay[i];
    return null;
  }
  function fieldLabel(c, f) {
    var b = bin(fget(c.st.v, f), fw(f)), bits = f.bits[0] === f.bits[1] ? '位 ' + f.bits[0] : '位 ' + f.bits[0] + ':' + f.bits[1];
    if (f.reserved) return '保留 ' + bits + ' = ' + b + (P(c.r).m1 & fmask(f) ? '，必须保持为 1' : '');
    var inf = info(c.r, f, c.st.v, c.inst), t = meaning(inf, b);
    var s = f.name + ' ' + bits + ' = ' + b + (inf.numeric ? '（' + fget(c.st.v, f) + '）' : '') + (t ? ' ' + t : '');
    if (f.rw === 'r') s += '，只读';
    if (naOnly(f.only, c.inst)) s += '，' + naWhy(f.only);
    return s;
  }
  function renderBar(c, anim, morph) {
    var r = c.r, p = P(r), w = p.w, v = c.st.v, lay = c.lay, y = curY(r), sel = selField(c);
    var bits = bin(v, w), prev = c.lastBits;
    c.lastBits = bits;
    var bar = E('div', 'rg-bar' + (w === 32 ? ' w32' : ''));
    bar.setAttribute('role', 'group');
    bar.setAttribute('aria-label', r.name + ' 位段，左右方向键切换字段，回车打开取值表');
    var colors = {}, ci = 0;
    lay.forEach(function (f) { if (f.reserved) return; var k = f.rep || f.name; if (!own(colors, k)) colors[k] = ci++ % 6; });
    var lines = w === 32 ? [[31, 16], [15, 0]] : [[15, 0]], first = null, tab = null;
    lines.forEach(function (ln) {
      var hi = ln[0], lo = ln[1], line = E('div', 'rg-line'), ruler = E('div', 'rg-ruler'), cells = E('div', 'rg-cells');
      ruler.setAttribute('aria-hidden', 'true');
      for (var k = hi; k >= lo; k--) ruler.appendChild(E('span', null, String(k)));
      lay.forEach(function (f) {
        var fh = f.bits[0], fl = f.bits[1];
        if (fh < lo || fl > hi) return;
        var sh = Math.min(fh, hi), sl = Math.max(fl, lo), prim = sh === fh, span = sh - sl + 1;
        var dim = isRep(r, f) && yOf(f) !== y, na = naOnly(f.only, c.inst);
        var cls = 'rg-f';
        if (f.reserved) cls += ' rg-res'; else cls += ' rg-c' + colors[f.rep || f.name];
        if (f.rw === 'r' && !f.reserved) cls += ' rg-ro';
        if (na) cls += ' rg-na';
        if (dim) cls += ' rg-dim';
        if (span === 1) cls += ' rg-n1';
        if (sel === f) cls += ' rg-on';
        if (morph && fh <= morph[0] && fl >= morph[1] && anim) cls += ' rg-morph';
        var b = btn(cls);
        b.style.gridColumn = (hi - sh + 1) + ' / span ' + span;
        b.setAttribute('data-fn', f.name);
        b.setAttribute('data-prim', prim ? '1' : '0');
        b.setAttribute('data-fk', 'f:' + f.name + (prim ? '' : ':2'));
        b.tabIndex = -1;
        if (prim) {
          b.setAttribute('aria-label', fieldLabel(c, f));
          b.setAttribute('aria-expanded', sel === f ? 'true' : 'false');
          b.setAttribute('aria-controls', c.p.vt.id);
          if (!first && !dim) first = b;
          if (sel === f) tab = b;
        } else b.setAttribute('aria-hidden', 'true');
        b.title = f.reserved ? '保留' : f.name;
        var nm = E('span', 'rg-fn', f.reserved ? '' : (dim ? '' : f.name));
        if (f.rw === 'r' && !f.reserved) nm.appendChild(svgIcon(IC_LOCK, 'rg-lock'));
        b.appendChild(nm);
        var ds = E('span', 'rg-bits');
        for (var bit = sh; bit >= sl; bit--) {
          var d = bits.charAt(w - 1 - bit), dc = 'rg-d';
          if (anim && prev && prev.charAt(w - 1 - bit) !== d) dc += ' rg-flip';
          ds.appendChild(E('span', dc, d));
        }
        b.appendChild(ds);
        cells.appendChild(b);
      });
      line.appendChild(ruler); line.appendChild(cells);
      bar.appendChild(line);
    });
    (tab || first || bar.querySelector('.rg-f[data-prim="1"]') || E('i')).tabIndex = 0;
    clear(c.p.barw);
    c.p.barw.appendChild(bar);
  }
  function pickField(c, name, kb) {
    var f = null;
    c.lay.forEach(function (x) { if (x.name === name) f = x; });
    if (!f) return;
    if (U.sel === name && !c.p.vt.hidden) { U.sel = null; refresh(c, {}); syncUrl(); focusBlock(c, name); return; }
    if (isRep(c.r, f) && yOf(f) !== curY(c.r)) U.y[c.r.id] = yOf(f);
    U.sel = name;
    refresh(c, {});
    syncUrl();
    if (kb) { var row = c.p.vt.querySelector('[role="option"][tabindex="0"], .rg-num input'); if (row) focusEl(row); else focusBlock(c, name); }
    else focusBlock(c, name);
  }
  function focusBlock(c, name) {
    var b = c.p.barw.querySelector('.rg-f[data-prim="1"][data-fn="' + cssEsc(name) + '"]');
    if (!b) return;
    Array.prototype.forEach.call(c.p.barw.querySelectorAll('.rg-f'), function (x) { x.tabIndex = x === b ? 0 : -1; });
    focusSoon(b, function () { return cards[c.r.id] === c && U.open === c.r.id && c.p.barw.contains(b); });
  }
  function flashField(c, name) {
    var bs = c.p.barw.querySelectorAll('.rg-f[data-fn="' + cssEsc(name) + '"]');
    if (!bs.length) return;
    var b0 = bs[0];
    b0.scrollIntoView({ block: 'center', behavior: smooth() });
    afterScroll(pane, function () {
      app.syncScrolled();
      var cls = app.reduced() ? 'rg-flash-s' : 'rg-flash';
      Array.prototype.forEach.call(bs, function (b) { b.classList.remove('rg-flash', 'rg-flash-s'); void b.offsetWidth; b.classList.add(cls); });
      setTimeout(function () { Array.prototype.forEach.call(bs, function (b) { b.classList.remove(cls); }); }, 1300);
    });
  }

  /* ---- 取值表（内联，不是弹窗、不加历史层） ---- */
  function renderVT(c) {
    var vt = c.p.vt, f = selField(c), r = c.r;
    clear(vt);
    if (!f) { vt.hidden = true; return; }
    vt.hidden = false;
    var w = fw(f), cur = fget(c.st.v, f), b = bin(cur, w), inf = info(r, f, c.st.v, c.inst), can = writable(f, c.inst);
    var h = E('div', 'rg-vth');
    h.appendChild(E('b', 'rg-vtn', f.reserved ? '保留' : f.name));
    h.appendChild(E('span', 'rg-tag', f.bits[0] === f.bits[1] ? '位 ' + f.bits[0] : '位 ' + f.bits[0] + ':' + f.bits[1]));
    h.appendChild(E('span', 'rg-tag', RW[f.rw] || f.rw));
    if (f.only) h.appendChild(E('span', 'rg-only', f.only));
    var x = btn('rg-x', null, '收起取值表'); x.appendChild(svgIcon(IC_X));
    x.addEventListener('click', function () { var n = f.name; U.sel = null; refresh(c, {}); syncUrl(); focusBlock(c, n); });
    h.appendChild(x);
    vt.appendChild(h);
    if (f.cmsis) vt.appendChild(E('p', 'rg-mac', f.cmsis));
    if (f.desc) vt.appendChild(E('p', 'rg-desc', f.desc));
    if (inf.basis) vt.appendChild(E('p', 'rg-basis', inf.basis));
    if (f.reserved && (P(r).m1 & fmask(f))) vt.appendChild(E('p', 'rg-warn', '此位必须由软件保持为 1：计算器写值时始终置 1。'));
    if (naOnly(f.only, c.inst)) vt.appendChild(E('p', 'rg-warn', (c.inst ? c.inst.name + ' ' : '') + '没有这一位（' + naWhy(f.only) + '）'));
    else if (f.rw === 'r' && !f.reserved) vt.appendChild(E('p', 'rg-note', '只读：不参与写入编码。'));
    if (f.reserved) return;
    if (inf.vals) {
      var list = E('div', 'rg-opts');
      list.setAttribute('role', 'listbox');
      list.setAttribute('aria-label', f.name + ' 取值');
      var rows = [], hit = -1;
      inf.vals.forEach(function (it, i) {
        var on = wild(it.v, b);
        if (on && hit < 0) hit = i;
        var o = E('div', 'rg-opt' + (on ? ' on' : ''));
        o.setAttribute('role', 'option');
        o.setAttribute('aria-selected', on ? 'true' : 'false');
        if (!can) o.setAttribute('aria-disabled', 'true');
        o.setAttribute('data-v', String(it.v));
        o.setAttribute('data-fk', 'v:' + it.v);
        o.tabIndex = -1;
        o.appendChild(E('span', 'rg-ov', String(it.v)));
        o.appendChild(E('span', 'rg-ot', it.t ? String(it.t) : (w === 1 ? (it.v === '1' ? '置 1' : '清 0') : '')));
        list.appendChild(o);
        rows.push(o);
      });
      (rows[hit] || rows[0]).tabIndex = 0;
      if (hit < 0) vt.appendChild(E('p', 'rg-note', '当前值 ' + b + ' 不在表中（保留 / 未定义组合）'));
      list.addEventListener('click', function (e) {
        var o = e.target.closest('.rg-opt');
        if (!o || !can) return;
        var v = parseSet(o.getAttribute('data-v'), f);
        if (v != null) setField(c, f, v);
      });
      list.addEventListener('keydown', function (e) {
        var i = rows.indexOf(document.activeElement);
        if (i < 0) return;
        var k = e.key, j = -1;
        if (k === 'ArrowDown') j = Math.min(rows.length - 1, i + 1);
        else if (k === 'ArrowUp') j = Math.max(0, i - 1);
        else if (k === 'Home') j = 0; else if (k === 'End') j = rows.length - 1;
        else if (k === 'Enter' || k === ' ') { e.preventDefault(); rows[i].click(); return; }
        if (j < 0) return;
        e.preventDefault();
        rows.forEach(function (o, n) { o.tabIndex = n === j ? 0 : -1; });
        focusEl(rows[j]);
      });
      vt.appendChild(list);
    } else if (inf.numeric) {
      var nb = E('div', 'rg-num'), id = uid('n');
      var lab = E('label', 'rg-numl', '数值'); lab.htmlFor = id;
      var inp = E('input', 'rg-numi'); inp.id = id; inp.type = 'text';
      inp.setAttribute('inputmode', 'text'); inp.setAttribute('autocomplete', 'off'); inp.spellcheck = false;
      inp.setAttribute('data-fk', 'num');
      inp.setAttribute('aria-describedby', id + 'h');
      inp.value = String(cur);
      inp.disabled = !can;
      var hint = E('span', 'rg-numh'); hint.id = id + 'h';
      nb.appendChild(lab); nb.appendChild(inp); nb.appendChild(hint);
      vt.appendChild(nb);
      c.p.num = { inp: inp, hint: hint, f: f };
      numHint(c);
      inp.addEventListener('input', function () {
        var res = parseNum(inp.value, w);
        inp.setAttribute('aria-invalid', res.err && inp.value.trim() ? 'true' : 'false');
        if (res.err) { hint.textContent = (inp.value.trim() ? (res.err === '越界' ? '超出范围 · ' : '格式不对 · ') : '') + rangeText(w); hint.classList.toggle('bad', !!inp.value.trim()); return; }
        hint.classList.remove('bad');
        setField(c, f, res.x, { numFrom: true });
      });
      inp.addEventListener('blur', function () { if (c.p.num && c.p.num.inp === inp) { inp.setAttribute('aria-invalid', 'false'); inp.value = String(fget(c.st.v, f)); numHint(c); } });
    }
  }
  function rangeText(w) { return '0 ~ ' + (p2(w) - 1) + '，十进制或 0x'; }
  function numHint(c) {
    var n = c.p.num;
    if (!n) return;
    var x = fget(c.st.v, n.f);
    n.hint.classList.remove('bad');
    n.hint.textContent = rangeText(fw(n.f)) + ' · 当前 ' + x + ' = 0x' + x.toString(16).toUpperCase();
  }
  function updateNum(c) { numHint(c); }

  /* ---- 换算（USART_BRR 波特率 / I2C_CCR） ---- */
  function renderFx(c) {
    var fx = c.p.fx, r = c.r;
    if (!fx) return;
    if (fx._built && fx._inst === (c.inst && c.inst.name)) return;
    fx._built = true; fx._inst = c.inst && c.inst.name;
    clear(fx);
    if (r.formulaText) fx.appendChild(E('p', 'rg-note', r.formulaText));
    var row = E('div', 'rg-fxr'), out = E('p', 'rg-fxo');
    function num(label, val, unit) {
      var id = uid('fx'), l = E('label', 'rg-fxl'), i = E('input', 'rg-fxi');
      l.htmlFor = id; i.id = id; i.type = 'text'; i.value = String(val); i.setAttribute('inputmode', 'decimal'); i.setAttribute('autocomplete', 'off');
      l.appendChild(E('span', null, label)); l.appendChild(i); if (unit) l.appendChild(E('span', 'rg-fxu', unit));
      row.appendChild(l);
      return i;
    }
    var go = btn('rg-fxgo', '填入');
    if (r.formula === 'baud') {
      var fpc = num('fPCLK', c.inst && c.inst.name === 'USART1' ? 72 : 36, 'MHz'), bd = num('波特率', 115200, '');
      row.appendChild(go);
      var calcB = function () {
        var f = Number(fpc.value) * 1e6, b = Number(bd.value);
        if (!(f > 0 && b > 0)) return null;
        var div = f / (16 * b), m = Math.floor(div), fr = Math.round((div - m) * 16);
        if (fr >= 16) { m += 1; fr = 0; }
        if (m < 1 || m > 4095) return { err: true, div: div };
        var real = f / (16 * (m + fr / 16));
        return { m: m, fr: fr, div: div, real: real, e: (real - b) / b * 100 };
      };
      var showB = function () {
        var k = calcB();
        out.textContent = !k ? '' : k.err ? 'USARTDIV = ' + k.div.toFixed(4) + '，超出范围' : 'USARTDIV = ' + k.div.toFixed(4) + ' → Mantissa ' + k.m + '，Fraction ' + k.fr + ' · 实际 ' + Math.round(k.real) + '（' + (k.e >= 0 ? '+' : '') + k.e.toFixed(2) + '%）';
      };
      fpc.addEventListener('input', showB); bd.addEventListener('input', showB);
      go.addEventListener('click', function () {
        var k = calcB(), p = P(r);
        if (!k || k.err) return;
        var st = c.st, fm = p.byName.DIV_Mantissa, ff = p.byName.DIV_Fraction;
        if (!fm || !ff) return;
        st.v = fset(fset(st.v, fm, k.m), ff, k.fr);
        st.touched.DIV_Mantissa = st.touched.DIV_Fraction = true; st.quick = -1;
        refresh(c, { anim: true });
      });
      showB();
    } else if (r.formula === 'i2c_ccr') {
      var pc = num('PCLK1', 36, 'MHz'), scl = num('SCL', 100, 'kHz');
      row.appendChild(go);
      var calcC = function () {
        var p = P(r), fs = p.byName['F/S'], du = p.byName.DUTY, f = Number(pc.value) * 1e6, s = Number(scl.value) * 1e3;
        if (!(f > 0 && s > 0)) return null;
        var fast = s > 100e3, duty = fast && du ? fget(c.st.v, du) : 0;
        var k = fast ? (duty ? 25 : 3) : 2, ccr = Math.round(f / (k * s));
        return { fast: fast, duty: duty, k: k, ccr: ccr, ok: ccr >= (fast ? 1 : 4) && ccr <= 4095, fs: fs };
      };
      var showC = function () {
        var k = calcC();
        out.textContent = !k ? '' : (k.fast ? '快速模式（F/S=1，DUTY=' + k.duty + '）' : '标准模式（F/S=0）') + '：CCR = PCLK1 / (' + k.k + ' × fSCL) = ' + k.ccr + (k.ok ? '' : '，超出范围');
      };
      pc.addEventListener('input', showC); scl.addEventListener('input', showC);
      go.addEventListener('click', function () {
        var k = calcC(), p = P(r);
        if (!k || !k.ok) return;
        var st = c.st;
        st.v = fset(st.v, p.byName.CCR, k.ccr); st.touched.CCR = true;
        if (k.fs) { st.v = fset(st.v, k.fs, k.fast ? 1 : 0); st.touched['F/S'] = true; }
        st.quick = -1;
        refresh(c, { anim: true });
      });
      showC();
    } else { fx.hidden = !fx.firstChild; return; }
    fx.appendChild(row); fx.appendChild(out);
  }

  /* ---- 计算条 ---- */
  function renderCalc(c, typing) {
    var r = c.r, p = P(r), v = c.st.v, w = p.w;
    if (!(typing && document.activeElement === c.p.hex)) c.p.hex.value = hexS(v, w);
    c.p.hexPlain.textContent = hexC(v, w);
    var a = addrOf(r, c.inst, c.n), ad = c.p.addr;
    clear(ad);
    if (a != null) {
      var lab = regExpr(r, c.inst, c.n).replace(/->/, ' → ');
      ad.appendChild(E('span', 'rg-addrn', lab));
      ad.appendChild(E('b', 'rg-addrv', hexS(a, 32)));
      var rg = nRange(r, c.inst);
      ad.appendChild(E('span', 'rg-addrf', '= ' + c.inst.base + ' + ' + r.offset + (rg ? ' + ' + r.stride + '×' + (c.n - rg.lo) : '')));
    }
  }

  /* ---- 提示 ---- */
  function renderWarns(c) {
    var r = c.r, p = P(r), st = c.st, ws = c.p.warns, list = [];
    clear(ws);
    if (p.m1 && (st.v & p.m1) !== p.m1) list.push(['warn', '位 14 必须为 1：这个值里它是 0，写入时会置 1。']);
    else if (p.m1) list.push(['note', '位 14 是保留位但必须由软件保持为 1：计算器始终把它置 1。']);
    if (p.kind === 'swj' && r.fields.some(function (f) { return f.rw === 'w' && st.touched[f.name]; }))
      list.push(['warn', 'SWJ_CFG 只写，读回无意义：读-改-写会把它读成 000 再写回（重新打开 JTAG）。下面的代码每次都显式写入你要的 SWJ_CFG。']);
    if (p.kind === 'key') { var vk = p.byName.VECTKEY; if (vk && fget(st.v, vk) !== 0x05FA) list.push(['warn', 'VECTKEY 必须写 0x05FA，否则这次写入被忽略（读出是 0xFA05）。']); }
    if (p.kind === 'direct') list.push(['note', '只写 / 写 1 生效：直接赋值，不做读-改-写（读回的 1 会被再次写入，误触发其他位）。']);
    if (p.kind === 'flag0') list.push(['note', '标志位写 0 清除、写 1 无影响：直接赋值清标志，不要用 &=（可能清掉刚置位的其他标志）。']);
    if (p.kind === 'ro') list.push(['note', '只读寄存器：只能读，下面的值用于解码。']);
    if (p.x) list.push(['note', '复位值含 X（不定）：计算时按 0。']);
    list.forEach(function (it) { ws.appendChild(E('p', it[0] === 'warn' ? 'rg-warn' : 'rg-note', it[1])); });
    ws.hidden = !list.length;
  }

  /* ---- 代码生成 ---- */
  function fieldsTouched(c) {
    var st = c.st;
    return c.lay.filter(function (f) { return st.touched[f.name] && writable(f, c.inst); });
  }
  function valComment(c, fs) {
    return fs.map(function (f) {
      var x = fget(c.st.v, f), b = bin(x, fw(f)), inf = info(c.r, f, c.st.v, c.inst), t = meaning(inf, b);
      var num = fw(f) >= 16 ? '0x' + hexd(x, fw(f) / 4) + (x > 9 ? '（' + x + '）' : '') : String(x);
      return f.name + '=' + (inf.numeric ? num : b) + (t ? ' ' + t.replace(/\*\//g, '* /') : '');
    }).join(' · ');
  }
  function joinMac(fs) { var ns = fs.map(function (f) { return f.cmsis; }); return ns.length > 1 ? '(' + ns.join(' | ') + ')' : ns[0]; }
  function genCode(c) {
    var r = c.r, p = P(r), w = p.w, st = c.st, Ex = regExpr(r, c.inst, c.n), enc = encode(r, st.v), L = [];
    var ts = fieldsTouched(c), hx = function (x) { return hexC(x, w); };
    if (naOnly(r.only, c.inst)) return '/* ' + (c.inst ? c.inst.name : '') + ' 没有 ' + r.name + '（' + naWhy(r.only) + '） */';
    if (p.kind === 'ro') {
      L.push((w === 16 ? 'uint16_t' : 'uint32_t') + ' v = ' + Ex + ';   /* 只读 */');
      return L.join('\n');
    }
    if (p.kind === 'bytes') {
      var base = Ex.replace(/\[\d+\]$/, '');
      if (!ts.length) L.push('/* 选一个 PRI_x 设优先级（只用高 4 位） */');
      ts.forEach(function (f) {
        var k = Number((/(\d+)$/.exec(f.name) || [0, 0])[1]), idx = 4 * c.n + k, x = fget(st.v, f);
        L.push(base + '[' + idx + '] = 0x' + hexd(x * 16, 2) + ';   /* ' + f.name + ' = ' + x + '，按字节写 */');
      });
      return L.join('\n');
    }
    if (p.kind === 'direct' || p.kind === 'key') {
      var setFs = ts.filter(function (f) { return fget(st.v, f) !== 0; });
      var macOK = p.kind === 'direct' && setFs.length && setFs.every(function (f) { return f.cmsis && fget(st.v, f) === p2(fw(f)) - 1; }) &&
        setFs.reduce(function (a, f) { return (a | fmask(f)) >>> 0; }, 0) === enc;
      if (p.kind === 'direct' && !enc) L.push('/* 把要写 1 的位设成 1（写 0 无作用） */');
      if (macOK) L.push(Ex + ' = ' + setFs.map(function (f) { return f.cmsis; }).join(' | ') + ';');
      L.push(Ex + ' = ' + hx(enc) + ';' + (macOK ? '   /* 同上 */' : ''));
      if (ts.length) L.push('/* ' + valComment(c, ts) + ' */');
      L.push(p.kind === 'key' ? '/* 带 VECTKEY 的寄存器：整体直接赋值，不读-改-写 */' : '/* 只写 / 写 1 生效：直接赋值，不读-改-写 */');
      return L.join('\n');
    }
    if (p.kind === 'flag0') {
      var clr = ts.filter(function (f) { return fget(st.v, f) === 0; });
      if (!clr.length) { L.push('/* 把要清除的标志位设成 0（rc_w0：写 0 清除） */'); return L.join('\n'); }
      var cm = clr.reduce(function (a, f) { return (a | fmask(f)) >>> 0; }, 0);
      if (clr.every(function (f) { return f.cmsis; })) L.push(Ex + ' = ~' + joinMac(clr) + ';   /* 写 0 清除，其余位写 1 无影响 */');
      L.push(Ex + ' = ' + hx((~cm & (p2(w) - 1)) >>> 0) + ';' + (clr.every(function (f) { return f.cmsis; }) ? '   /* 同上 */' : '   /* 写 0 清除，其余位写 1 无影响 */'));
      L.push('/* 清 ' + clr.map(function (f) { return f.name; }).join(' · ') + '；不要用 &=（读-改-写可能清掉刚置位的其他标志） */');
      return L.join('\n');
    }
    // rmw / swj
    var fs = ts.slice();
    if (p.kind === 'swj' && fs.length) r.fields.forEach(function (f) { if (f.rw === 'w' && !f.reserved && fs.indexOf(f) < 0) fs.push(f); });
    fs.sort(function (a, b) { return b.bits[0] - a.bits[0]; });
    if (!fs.length) L.push('/* 还没改字段：点位段选取值，或点下面的常用配置 */');
    else {
      var mask = fs.reduce(function (a, f) { return (a | fmask(f)) >>> 0; }, 0);
      var set = fs.reduce(function (a, f) { return (a | (fget(st.v, f) * p2(f.bits[1]))) >>> 0; }, 0);
      var mac = fs.every(function (f) { return f.cmsis; });
      var clrS = mac ? joinMac(fs) : hx(mask);
      var full = fs.filter(function (f) { return fget(st.v, f) !== 0; });
      var setS = mac && full.every(function (f) { return fget(st.v, f) === p2(fw(f)) - 1; }) ? full.map(function (f) { return f.cmsis; }).join(' | ') : hx(set);
      if (!set) L.push(Ex + ' &= ~' + clrS + ';');
      else if (set === mask) L.push(Ex + ' |= ' + setS + ';');
      else L.push(Ex + ' = (' + Ex + ' & ~' + clrS + ') | ' + setS + ';');
      L.push('/* ' + valComment(c, fs) + ' */');
      if (p.kind === 'swj') L.push('/* SWJ_CFG 只写、读回无意义：每次写 MAPR 都把想要的 SWJ_CFG 一起写进去 */');
    }
    L.push(Ex + ' = ' + hx(enc) + ';   /* 整体赋值 */');
    return L.join('\n');
  }
  function halMatch(c) {
    var r = c.r, st = c.st, qs = r.quick;
    if (!Array.isArray(qs) || !qs.length) return -1;
    var enc = encode(r, st.v);
    if (st.quick > -1 && qs[st.quick] && quickVal(r, qs[st.quick]).v === enc) return st.quick;
    if (!Object.keys(st.touched).length) return -1;
    for (var i = 0; i < qs.length; i++) if (qs[i].set && Object.keys(qs[i].set).length && quickVal(r, qs[i]).v === enc) return i;
    return -1;
  }
  function renderCodes(c) {
    setCode(c.p.cReg, genCode(c));
    var i = halMatch(c), q = i > -1 ? c.r.quick[i] : null;
    c.p.cHal.hidden = !(q && q.hal);
    if (q && q.hal) setCode(c.p.cHal, String(q.hal), 'HAL 写法 · ' + q.title);
  }

  /* ---- 常用配置 ---- */
  function renderQuick(c) {
    var p = c.p;
    if (!p.quick) return;
    var act = c.st.quick, enc = encode(c.r, c.st.v);
    if (act > -1 && quickVal(c.r, c.r.quick[act]).v !== enc) act = -1;
    p.qbtns.forEach(function (b, i) { var on = i === act; b.setAttribute('aria-pressed', on ? 'true' : 'false'); b.classList.toggle('on', on); });
    var qd = p.qd;
    if (qd._i === act) return;
    qd._i = act;
    clear(qd);
    if (act < 0) { qd.hidden = true; return; }
    var q = c.r.quick[act];
    qd.hidden = false;
    if (q.note) qd.appendChild(E('p', 'rg-note', q.note));
    if (q.odr != null && q.pin != null) qd.appendChild(E('p', 'rg-note', '另需 ODR' + q.pin + '=' + q.odr + (Number(q.odr) ? '（上拉）' : '（下拉）')));
    var links = [];
    if (q.snippet && app.hasSnippet(String(q.snippet.cat), String(q.snippet.title))) {
      var sb = btn('rg-lk', '代码 · ' + q.snippet.title);
      sb.addEventListener('click', function () { app.gotoCode(String(q.snippet.cat), String(q.snippet.title)); });
      links.push(sb);
    }
    if (q.teach && app.hasFig(String(q.teach))) {
      var tb = btn('rg-lk', '教学图 · ' + (app.figTitle ? app.figTitle(String(q.teach)) : q.teach));
      tb.addEventListener('click', function () { app.gotoFig([String(q.teach)], tb); });
      links.push(tb);
    }
    if (q.port && /^GPIO[A-G]$/.test(String(q.port))) {
      var pq = q.pin != null && /^\d{1,2}$/.test(String(q.pin)) ? 'P' + String(q.port).charAt(4) + q.pin : String(q.port);
      var pb = btn('rg-lk', '引脚 · ' + pq);
      pb.addEventListener('click', function () { app.gotoPins(pq); });
      links.push(pb);
    }
    if (links.length) { var lr = E('div', 'rg-qlinks'); links.forEach(function (b) { lr.appendChild(b); }); qd.appendChild(lr); }
    if (q.reg) { var ex = codeBlock('示例写法'); setCode(ex, String(q.reg)); qd.appendChild(ex); }
  }

  /* ================= 计算器操作 ================= */

  function setField(c, f, x, o) {
    var st = c.st;
    st.v = (fset(st.v, f, x) | P(c.r).m1) >>> 0;
    st.touched[f.name] = true;
    refresh(c, { anim: true, numFrom: o && o.numFrom });
    if (!(o && o.numFrom)) syncUrl();
  }
  function altSwitch(c, a, toInput) {
    var r = c.r, f = P(r).byName[a.if.field];
    if (!f) return;
    var cur = fget(c.st.v, f), x = toInput ? (cur === 0 ? 1 : cur) : 0;
    if (x === cur) return;
    c.st.v = fset(c.st.v, f, x);
    c.st.touched[f.name] = true;
    var lay = layout(r, c.st.v);
    if (U.sel && !lay.some(function (y) { return y.name === U.sel; })) U.sel = f.name;
    refresh(c, { anim: true, morph: a.bits });
    syncUrl();
  }
  function decode(c, x, typing) {
    var r = c.r, p = P(r), st = c.st;
    st.v = (x & (p2(p.w) - 1)) >>> 0;
    st.touched = {};
    var base = initVal(r, c.n);
    layout(r, st.v).forEach(function (f) { if (writable(f, c.inst) && fget(st.v, f) !== fget(base, f)) st.touched[f.name] = true; });
    st.quick = -1;
    refresh(c, { anim: true, fromHex: typing });
  }
  function resetReg(c) {
    var st = c.st;
    st.v = initVal(c.r, c.n); st.touched = {}; st.quick = -1;
    refresh(c, { anim: true });
    say('已复位 ' + hexS(st.v, P(c.r).w));
  }
  function applyQuick(c, i) {
    var r = c.r, q = r.quick && r.quick[i];
    if (!q) return;
    var qv = quickVal(r, q), st = c.st, ys = [];
    st.v = qv.v; st.touched = {}; st.quick = i;
    qv.keys.forEach(function (k) {
      st.touched[k] = true;
      var f = P(r).byName[k];
      if (f && isRep(r, f)) ys.push(yOf(f));
    });
    if (ys.length) U.y[r.id] = Math.min.apply(null, ys);
    var lay = layout(r, st.v);
    if (U.sel && !lay.some(function (f) { return f.name === U.sel; })) U.sel = null;
    refresh(c, { anim: true });
    syncUrl();
    say(q.title + ' → ' + hexS(st.v, P(r).w));
  }
  function say(t) { X.live.textContent = ''; X.live.textContent = t; }

  /* ================= 搜索 ================= */

  var IDX = null;
  function low(s) { return String(s == null ? '' : s).toLowerCase(); }
  function buildIdx() {
    IDX = { regs: [], fields: [], quick: [] };
    GROUPS.forEach(function (g) {
      g.regs.forEach(function (r) {
        IDX.regs.push({ r: r, k: [low(r.id), low(r.name)], hay: low([r.id, r.name, r.title, r.title_en, g.name, g.title, r.formulaText, (r.notes || []).join(' ')].join(' ')) });
        var seen = {};
        P(r).all.forEach(function (f) {
          if (f.reserved || seen[f.name]) return;
          seen[f.name] = 1;
          var t = [f.name, f.cmsis, f.desc];
          (f.values || []).forEach(function (v) { t.push(v.t); });
          (f.cases || []).forEach(function (cs) { (cs.values || []).forEach(function (v) { t.push(v.t); }); });
          IDX.fields.push({ r: r, f: f, k: [low(f.name), low(f.cmsis)], hay: low(t.join(' ')) });
        });
        (r.quick || []).forEach(function (q, i) { IDX.quick.push({ r: r, i: i, q: q, hay: low([q.title, q.note, r.id, r.name].join(' ')) }); });
      });
    });
  }
  function rank(e, toks) {
    var q = toks.join(' ');
    if (e.k.indexOf(q) > -1) return 0;
    for (var i = 0; i < e.k.length; i++) if (e.k[i] && e.k[i].indexOf(q) === 0) return 1;
    return 2;
  }
  function clearSearch() { X.q.value = ''; X.qx.hidden = true; runSearch(); }
  function showMain(on) { X.results.hidden = on; X.main.hidden = !on; X.gbar.hidden = !on; X.filter.hidden = !on || !U.filter; if (on) requestAnimationFrame(function () { placeInk(); gfade(); }); }
  function runSearch() {
    var raw = X.q.value.trim(), res = X.results;
    U.q = raw;
    clear(res);
    if (!raw) { X.qn.textContent = ''; showMain(true); return; }
    showMain(false);
    var oc = U.open && cards[U.open];
    if (/^0x[0-9a-f_\s]{1,11}$/i.test(raw) && oc) {
      var hv = parseHexStr(raw), w = P(oc.r).w;
      if (hv != null && hv <= p2(w) - 1) {
        var hb = btn('rg-hit rg-hit-hex');
        hb.appendChild(E('span', 'rg-hit1', '解码 ' + hexS(hv, w)));
        hb.appendChild(E('span', 'rg-hit2', '→ ' + regExpr(oc.r, oc.inst, oc.n)));
        hb.addEventListener('click', function () {
          var c = cards[oc.r.id];
          clearSearch();
          if (c && U.open === c.r.id) { decode(c, hv); focusEl(c.p.hex); flashCalc(c); }
        });
        res.appendChild(hb);
        X.qn.textContent = '';
        return;
      }
    }
    if (!IDX) buildIdx();
    var toks = low(raw).split(/\s+/).filter(Boolean);
    var hit = function (e) { return toks.every(function (t) { return e.hay.indexOf(t) > -1; }); };
    var rr = IDX.regs.filter(hit).map(function (e) { return { e: e, s: rank(e, toks) }; }).sort(function (a, b) { return a.s - b.s; });
    var fr = IDX.fields.filter(hit).map(function (e) { return { e: e, s: rank(e, toks) }; }).sort(function (a, b) { return a.s - b.s; });
    var qr = IDX.quick.filter(hit);
    // 重复字段（MODE0~7 …）按寄存器 + 重复组合并成一条「MODEy ×8」，精确命中的单列
    var grp = [], gk = {};
    fr.forEach(function (x) {
      var f = x.e.f, k = x.e.r.id + '|' + (x.s > 0 && isRep(x.e.r, f) ? f.rep : f.name);
      if (gk[k]) { gk[k].n++; if (yOf(f) < yOf(gk[k].e.f)) gk[k].e = x.e; return; }
      gk[k] = { e: x.e, n: 1, s: x.s, rep: x.s > 0 && isRep(x.e.r, f) };
      grp.push(gk[k]);
    });
    var total = rr.length + grp.length + qr.length;
    X.qn.textContent = String(total);
    if (!total) { res.appendChild(app.emptyState(E('div', 'vstate'), '无结果', 'search')); return; }
    section(res, '寄存器', rr.slice(0, 12).map(function (x) {
      var r = x.e.r, b = btn('rg-hit');
      b.appendChild(E('span', 'rg-hit1', r.name));
      b.appendChild(E('span', 'rg-hit2', GOF[r.id].name + ' · ' + (r.title || '')));
      b.addEventListener('click', function () { clearSearch(); goReg(r.id, { focus: 'hdr' }); });
      return b;
    }), rr.length);
    section(res, '字段', grp.slice(0, 30).map(function (x) {
      var r = x.e.r, f = x.e.f, b = btn('rg-hit');
      var t1 = E('span', 'rg-hit1', x.rep ? f.rep : f.name);
      if (x.n > 1) t1.appendChild(E('span', 'rg-xn', '×' + x.n));
      b.appendChild(t1);
      b.appendChild(E('span', 'rg-hit2', r.name + ' · ' + (f.desc || '')));
      b.addEventListener('click', function () { clearSearch(); goReg(r.id, { field: f.name, y: isRep(r, f) ? yOf(f) : null, flash: true, focus: 'field' }); });
      return b;
    }), grp.length);
    section(res, '速查', qr.slice(0, 12).map(function (x) {
      var b = btn('rg-hit');
      b.appendChild(E('span', 'rg-hit1', x.q.title));
      b.appendChild(E('span', 'rg-hit2', x.r.name));
      b.addEventListener('click', function () { clearSearch(); goReg(x.r.id, { quick: x.i, focus: 'hdr' }); });
      return b;
    }), qr.length);
  }
  function section(res, label, items, n) {
    if (!items.length) return;
    var h = E('h3', 'rg-rh', label + ' · ' + n + (n > items.length ? '（前 ' + items.length + ' 条）' : ''));
    res.appendChild(h);
    var box = E('div', 'rg-rlist');
    items.forEach(function (b) { box.appendChild(b); });
    res.appendChild(box);
  }
  function flashCalc(c) {
    var n = c.p.calc, cls = app.reduced() ? 'rg-flash-s' : 'rg-flash';
    n.classList.remove('rg-flash', 'rg-flash-s'); void n.offsetWidth; n.classList.add(cls);
    setTimeout(function () { n.classList.remove(cls); }, 1300);
  }

  /* ================= 导航 / 目标 ================= */

  function findReg(s) {
    s = String(s || '');
    if (own(REG, s)) return REG[s];
    var u = s.toUpperCase();
    if (own(REG, u)) return REG[u];
    for (var i = 0; i < GROUPS.length; i++) {
      var m = BYNAME[GROUPS[i].id];
      for (var k in m) if (own(m, k) && (k === s || k.toUpperCase() === u)) return m[k];
    }
    return null;
  }
  function goReg(id, o) {
    o = o || {};
    var r = REG[id];
    if (!r) return false;
    focusTok++;
    var g = GOF[id];
    if (X.q.value) clearSearch();
    if (U.filter && U.filter.ids.indexOf(id) < 0) { U.filter = null; X.filter.hidden = true; }
    if (!U.filter && U.g !== g.id) { U.g = g.id; U.open = null; syncGbar(); renderMain(); }
    else if (!cards[id]) renderMain();
    if (o.inst) { var il = instList(r); for (var i = 0; i < il.length; i++) if (il[i].name === o.inst) U.inst[g.id] = o.inst; }
    if (o.y != null && P(r).ys.indexOf(Number(o.y)) > -1) U.y[id] = Number(o.y);
    var field = null;
    if (o.field) {
      var f = P(r).byName[o.field];
      if (f && !f.reserved) {
        field = f.name;
        if (isRep(r, f) && o.y == null) U.y[id] = yOf(f);
        // alt 字段（IC1F 等）：需要该通道处于输入捕获，否则退回同通道 CCxS
        var inst = curInst(r), st = stOf(r, inst, curN(r, inst));
        if (!layout(r, st.v).some(function (x) { return x === f; })) field = null;
      }
    }
    var c = expand(id, { field: field, instant: !!o.instant });
    if (!c) return false;
    if (field) { U.sel = field; refresh(c, {}); syncUrl(); }
    if (o.quick != null) applyQuick(c, o.quick);
    requestAnimationFrame(function () {
      if (field && o.flash) flashField(c, field);
      else {
        var pr = pane.getBoundingClientRect(), hr = c.root.getBoundingClientRect();
        pane.scrollTo({ top: pane.scrollTop + hr.top - pr.top - topOffset(), behavior: o.instant ? 'auto' : smooth() });
      }
      if (o.focus === 'field' && field) focusBlock(c, field);
      else if (o.focus) focusSoon(c.hb, function () { return cards[id] === c && c.root.isConnected; });
    });
    return true;
  }
  function applyTarget(t) {
    if (!t || typeof t !== 'object') return false;
    if (Array.isArray(t.ids)) {
      var ids = t.ids.filter(function (id) { return typeof id === 'string' && own(REG, id); });
      if (!ids.length) return false;
      if (X.q.value) clearSearch();
      setFilter({ ids: ids, label: String(t.label || '课件').slice(0, 80) });
      requestAnimationFrame(function () { focusSoon(X.filter.querySelector('.rg-filter-x'), function () { return !!U.filter && !X.filter.hidden; }); });
      return true;
    }
    if (t.snippet && typeof t.snippet === 'object') {
      var cat = String(t.snippet.cat), title = String(t.snippet.title), gi, ri, qi;
      for (gi = 0; gi < GROUPS.length; gi++) for (ri = 0; ri < GROUPS[gi].regs.length; ri++) {
        var r = GROUPS[gi].regs[ri], qs = r.quick || [];
        for (qi = 0; qi < qs.length; qi++) if (qs[qi].snippet && qs[qi].snippet.cat === cat && qs[qi].snippet.title === title) return goReg(r.id, { quick: qi, focus: 'hdr' });
      }
      for (gi = 0; gi < GROUPS.length; gi++) {
        var g = GROUPS[gi];
        if ((g.snippets || []).some(function (s) { return s && s.cat === cat && s.title === title; }) && g.regs.length) return goReg(g.regs[0].id, { focus: 'hdr' });
      }
      return false;
    }
    if (t.reg) {
      var s = String(t.reg), fld = t.f != null ? String(t.f) : null, dot = s.indexOf('.');
      if (dot > 0) { if (!fld) fld = s.slice(dot + 1); s = s.slice(0, dot); }
      var reg = findReg(s);
      if (!reg) return false;
      var y = t.y != null && /^\d{1,2}$/.test(String(t.y)) ? Number(t.y) : null;
      if (fld && !P(reg).byName[fld]) {
        // 兼容 CRH 用 0~7 的写法：MODE1 → MODE9
        var m = /^([A-Z]+)(\d+)$/.exec(fld);
        if (m && reg.id === 'GPIO_CRH' && Number(m[2]) < 8 && P(reg).byName[m[1] + (Number(m[2]) + 8)]) fld = m[1] + (Number(m[2]) + 8);
        else fld = null;
      }
      if (y != null && reg.id === 'GPIO_CRH' && y < 8) y += 8;
      var url = t.from === 'url';
      return goReg(reg.id, { field: fld, inst: t.i != null ? String(t.i) : null, y: y, flash: !!fld, focus: url ? null : (fld ? 'field' : 'hdr'), instant: url });
    }
    return false;
  }

  /* ================= URL（只 replaceState，不 push，不动 history.state 和 page / cw） ================= */

  var urlT = 0, urlTry = 0;
  function urlWant() {
    if (!U.open || !REG[U.open]) return null;
    var r = REG[U.open], o = { reg: r.id }, c = cards[r.id];
    if (U.sel && /^[A-Za-z0-9_\/]{1,32}$/.test(U.sel)) o.f = U.sel;
    if (instList(r).length > 1 && c && c.inst) o.i = c.inst.name;
    var y = curY(r);
    if (y != null) o.y = y;
    return o;
  }
  function writeUrl(o, leaving) {
    clearTimeout(urlT);
    try {
      if (app.viewerOpen() || (history.state && history.state.stm32v)) {
        // 查看器开着 / 它的返回还在途：等落地再写（最多约 4s）
        if (urlTry++ < 10) urlT = setTimeout(function () { writeUrl(leaving ? null : urlWant(), leaving); }, 400);
        return;
      }
      urlTry = 0;
      if (!leaving && app.curTab() !== 'regs') return;
      var sp = new URLSearchParams(location.search), before = sp.toString();
      ['reg', 'f', 'i', 'y'].forEach(function (k) { sp.delete(k); });
      if (o) Object.keys(o).forEach(function (k) { sp.set(k, String(o[k])); });
      if (leaving && sp.get('tab') === 'regs') sp.delete('tab');
      var qs = sp.toString();
      if (qs === before) return;
      history.replaceState(history.state, '', location.pathname + (qs ? '?' + qs : '') + location.hash);
    } catch (e) {}
  }
  function syncUrl() { if (mounted && app.curTab() === 'regs') { urlTry = 0; writeUrl(urlWant(), false); } }

  function save() {
    try { app.lsSet(LS_KEY, JSON.stringify({ g: U.g, r: U.open })); } catch (e) {}
  }
  function restore() {
    var o = null;
    try { o = JSON.parse(app.lsGet(LS_KEY) || 'null'); } catch (e) { o = null; }
    if (o && typeof o === 'object') {
      if (typeof o.g === 'string' && GBY[o.g]) U.g = o.g;
      if (typeof o.r === 'string' && REG[o.r] && GOF[o.r].id === U.g) return o.r;
    }
    return null;
  }

  /* ================= 接口 ================= */

  function mount(paneEl, appObj, target) {
    if (mounted) { show(target); return; }
    app = appObj; pane = paneEl; mounted = true;
    verifyQuicks();
    U.g = GBY.gpio ? 'gpio' : GROUPS[0].id;
    var last = restore();
    buildSkeleton();
    syncGbar();
    renderMain();
    var done = target ? applyTarget(target) : false;
    if (!done && last) expand(last, { instant: true });
    if (!done) syncUrl();
    requestAnimationFrame(function () { placeInk(); gfade(); });
  }
  function show(target) {
    if (!mounted) return;
    if (target && applyTarget(target)) return;
    requestAnimationFrame(function () { placeInk(); gfade(); });
    syncUrl();
  }
  function leave() {
    if (!mounted) return;
    urlTry = 0;
    writeUrl(null, true);
  }
  // 捕获阶段（stm32.js 钩子）：Escape 先清搜索 / 收起取值表 / 收起卡片，什么都没有时不拦截；「/」聚焦搜索
  function onKey(e) {
    if (!mounted || e.isComposing || e.defaultPrevented) return;
    if (e.key === 'Escape') {
      if (collapseOne()) { e.preventDefault(); e.stopPropagation(); }
      return;
    }
    if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey && !isTyping(document.activeElement)) { e.preventDefault(); focusEl(X.q); }
  }
  function collapseOne() {
    var a = document.activeElement;
    if (X.q.value) { clearSearch(); if (a === X.q || X.results.contains(a) || !a || a === document.body) focusEl(X.q); return true; }
    var c = U.open && cards[U.open];
    if (c && c.p.num && a === c.p.num.inp && parseNum(a.value, fw(c.p.num.f)).err) { a.value = String(fget(c.st.v, c.p.num.f)); numHint(c); return true; }
    if (c && U.sel) { var n = U.sel; U.sel = null; refresh(c, {}); syncUrl(); focusBlock(c, n); return true; }
    if (c) { collapse(true); return true; }
    return false;
  }

  window.STM32_REGS_UI = { mount: mount, show: show, leave: leave, onKey: onKey };
})();
