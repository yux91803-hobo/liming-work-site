/* reg-core.js — 寄存器计算的纯逻辑（不碰 DOM，可在 Node 里测试）
   字段编码、取值解释、实例 / 通道 / 地址、代码生成（读-改-写、写 1 生效、写 0 清除、带钥匙、按字节）。
   规则沿用旧版 regs.js（已有回归测试覆盖），界面在 regview.js。

   用法：var R = STM32RegCore.create(window.STM32_REGS)
   计算上下文 c = { r, inst, n, st: { v, touched: {字段名: true}, quick }, lay, peer(reg, inst) → 那个寄存器当前值 } */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.STM32RegCore = api;
})(typeof window === 'object' ? window : this, function () {
  'use strict';
  var BIT01 = [{ v: '0', t: '' }, { v: '1', t: '' }];
  var ORDER = ['rcc', 'flash', 'gpio', 'afio', 'exti', 'nvic', 'systick', 'tim', 'usart', 'adc', 'dma', 'spi', 'i2c', 'fsmc'];

  function own(o, k) { return o != null && Object.prototype.hasOwnProperty.call(o, k); }
  function fw(f) { return f.bits[0] - f.bits[1] + 1; }
  function p2(n) { return Math.pow(2, n); }
  function fmask(f) { return ((p2(fw(f)) - 1) * p2(f.bits[1])) >>> 0; }
  function fget(v, f) { return ((v & fmask(f)) >>> 0) / p2(f.bits[1]); }
  function fset(v, f, x) { var m = fmask(f); return ((v & ~m) | ((x * p2(f.bits[1])) & m)) >>> 0; }
  function bin(x, w) { var s = Number(x).toString(2); while (s.length < w) s = '0' + s; return s.slice(-w); }
  function hexd(x, digits) { var s = (Number(x) >>> 0).toString(16).toUpperCase(); while (s.length < digits) s = '0' + s; return s; }
  function hexC(x, w) { return '0x' + hexd(x, w / 4); }
  function hexS(x, w) { var s = hexd(x, w / 4); return '0x' + (w === 32 ? s.slice(0, 4) + ' ' + s.slice(4) : s); }
  function wild(pat, b) {
    pat = String(pat);
    if (pat.length !== b.length) return false;
    for (var i = 0; i < pat.length; i++) { var c = pat.charAt(i); if (c !== 'x' && c !== 'X' && c !== b.charAt(i)) return false; }
    return true;
  }
  function parseHexStr(s) { var t = String(s || '').replace(/[\s_]/g, '').replace(/^0x/i, ''); return /^[0-9a-f]{1,8}$/i.test(t) ? parseInt(t, 16) >>> 0 : null; }
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
  // quick.set 的取值：与位宽等长的 0/1/x 串按二进制；0x 开头按十六进制；纯数字按十进制
  function parseSet(s, f) {
    var w = fw(f), t = String(s == null ? '' : s).trim(), x = null;
    if (/^[01x]+$/i.test(t) && t.length === w) x = parseInt(t.replace(/x/gi, '0'), 2);
    else if (/^0x[0-9a-f]+$/i.test(t)) x = parseInt(t.slice(2), 16);
    else if (/^\d+$/.test(t)) x = parseInt(t, 10);
    return x != null && isFinite(x) && x >= 0 && x <= p2(w) - 1 ? x : null;
  }
  // 手动输入的数：十进制 / 0x / 0b
  function parseNum(s, w) {
    var t = String(s == null ? '' : s).trim().replace(/[\s_]/g, ''), x = null;
    if (/^0x[0-9a-f]+$/i.test(t)) x = parseInt(t.slice(2), 16);
    else if (/^0b[01]+$/i.test(t)) x = parseInt(t.slice(2), 2);
    else if (/^\d+$/.test(t)) x = parseInt(t, 10);
    if (x == null || !isFinite(x)) return { err: '格式不对：用十进制、0x 或 0b' };
    if (x > p2(w) - 1) return { err: '超出范围：最大 ' + (p2(w) - 1) };
    return { x: x };
  }
  function yOf(f) {
    if (f.pin != null && isFinite(Number(f.pin))) return Number(f.pin);
    var m = /(\d+)$/.exec(String(f.name));
    return m ? Number(m[1]) : null;
  }
  function repLabel(rep) {
    rep = String(rep || '');
    if (/^(CNF|MODE|IDR|ODR|BR|BS|LCK)/.test(rep)) return '引脚';
    if (/^(MR|TR|SWIER|PR|EXTI)/.test(rep)) return '线';
    if (/IF/.test(rep) || /^SMP/.test(rep)) return '通道';
    if (/^SQ/.test(rep)) return '序号';
    return '组';
  }

  function create(DATA) {
    var GROUPS = [], GBY = {}, REG = {}, GOF = {}, BYNAME = {}, PRE = {};
    (DATA && Array.isArray(DATA.groups) ? DATA.groups : []).forEach(function (g) { if (g && typeof g.id === 'string' && Array.isArray(g.regs)) GBY[g.id] = g; });
    ORDER.forEach(function (id) { if (GBY[id]) GROUPS.push(GBY[id]); });
    Object.keys(GBY).forEach(function (id) { if (GROUPS.indexOf(GBY[id]) < 0) GROUPS.push(GBY[id]); });
    GROUPS.forEach(function (g) {
      BYNAME[g.id] = {};
      g.regs = g.regs.filter(function (r) { return r && typeof r.id === 'string' && Array.isArray(r.fields); });
      g.regs.forEach(function (r) { REG[r.id] = r; GOF[r.id] = g; BYNAME[g.id][r.name] = r; });
    });

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
    // 写入方式：ro 只读 / direct 只写·写 1 生效 / flag0 写 0 清除 / key 带钥匙 / swj 含只写位 / bytes 按字节 / rmw 读-改-写
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
    function naOnly(only, inst) {
      if (!only) return false;
      if (only === 'TIM1/8') return !(inst && (inst.name === 'TIM1' || inst.name === 'TIM8'));
      return true;
    }
    function naWhy(only) { return only === 'TIM1/8' ? '只有 TIM1 / TIM8 有' : 'ZET6 没有（仅 ' + only + '）'; }
    function writable(f, inst) { return !f.reserved && f.rw !== 'r' && f.rw !== 'res' && !naOnly(f.only, inst); }

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
    function findInst(r, name) {
      var l = instList(r);
      for (var i = 0; i < l.length; i++) if (l[i].name === name) return l[i];
      return defInst(r);
    }
    function nRange(r, inst) {
      if (!r.stride) return null;
      var lo = /^NVIC_/.test(r.id) ? 0 : 1, cnt = Number(r.count) || 1;
      if (GOF[r.id].id === 'dma' && inst && inst.channels) cnt = Number(inst.channels) || cnt;
      return { lo: lo, hi: lo + cnt - 1 };
    }
    function member(r) { return String(r.name).slice(String(r.name).indexOf('_') + 1).replace(/x$/, ''); }
    function addrOf(r, inst, n) {
      if (!inst) return null;
      var b = parseHexStr(inst.base), o = parseHexStr(r.offset);
      if (b == null || o == null) return null;
      var rg = nRange(r, inst);
      return (b + o + (rg ? Number(r.stride) * (n - rg.lo) : 0)) >>> 0;
    }
    // C 表达式：GPIOA->CRL、DMA1_Channel3->CCR、NVIC->ISER[0]、AFIO->EXTICR[2]、FSMC_Bank1->BTCR[6]、SysTick->CTRL
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

    function initVal(r, n) { var p = P(r); return ((n === 1 && p.reset1 != null ? p.reset1 : p.reset) | p.m1) >>> 0; }
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
    // 条件可能引用同组另一寄存器的字段（TIM_CCER 的 CCxP 看 CCMRx 的 CCxS）：由调用方 peer() 提供那个寄存器的当前值
    function condVal(cond, c, v) {
      var src = c.r, sv = v;
      if (cond.reg) {
        src = BYNAME[GOF[c.r.id].id][cond.reg];
        if (!src) return null;
        sv = c.peer ? c.peer(src, c.inst) : initVal(src, null);
      }
      var f = P(src).byName[cond.field];
      if (!f) return null;
      return { b: bin(fget(sv, f), fw(f)), src: src };
    }
    function condTrue(cond, c, v) {
      var x = cond ? condVal(cond, c, v) : null;
      if (!x) return null;
      if (cond.eq != null) return wild(cond.eq, x.b);
      if (cond.ne != null) return !wild(cond.ne, x.b);
      return null;
    }
    function altOn(r, a, v) { return condTrue(a.if, { r: r }, v) === true; }
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
    // 字段当前的取值表 + 解释依据（cases 按实例或另一字段的值选）
    function info(c, f, v) {
      var inst = c.inst;
      if (Array.isArray(f.values) && f.values.length) return { vals: f.values };
      if (Array.isArray(f.cases) && f.cases.length) {
        var hit = null, why = '';
        for (var i = 0; i < f.cases.length && !hit; i++) {
          var cs = f.cases[i];
          if (Array.isArray(cs.inst)) {
            if (inst && cs.inst.indexOf(inst.name) > -1) { hit = cs; why = '按 ' + inst.name + ' 解释'; }
          } else if (cs.if && condTrue(cs.if, c, v) === true) {
            hit = cs;
            var cv = condVal(cs.if, c, v), lab = paren(cs.when);
            why = '按 ' + cs.if.field + '=' + cv.b + (lab ? '（' + lab + '）' : '') + ' 解释';
            if (cs.if.reg) why += '，取自 ' + (inst ? inst.name + '_' : '') + member(cv.src);
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

    /* ---------- 代码生成 ---------- */
    function fieldsTouched(c) {
      var st = c.st;
      return c.lay.filter(function (f) { return st.touched[f.name] && writable(f, c.inst); });
    }
    function valComment(c, fs) {
      return fs.map(function (f) {
        var x = fget(c.st.v, f), b = bin(x, fw(f)), inf = info(c, f, c.st.v), t = meaning(inf, b);
        var num = fw(f) >= 16 ? '0x' + hexd(x, fw(f) / 4) + (x > 9 ? '（' + x + '）' : '') : String(x);
        return f.name + '=' + (inf.numeric ? num : b) + (t ? ' ' + t.replace(/\*\//g, '* /') : '');
      }).join('；');
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
        L.push(Ex + ' = ' + (macOK ? setFs.map(function (f) { return f.cmsis; }).join(' | ') : hx(enc)) + ';');
        if (ts.length) L.push('/* ' + valComment(c, ts) + ' */');
        L.push(p.kind === 'key' ? '/* 带 VECTKEY 的寄存器：整体直接赋值，不读-改-写 */' : '/* 只写 / 写 1 生效：直接赋值，不读-改-写 */');
        return L.join('\n');
      }
      if (p.kind === 'flag0') {
        var clr = ts.filter(function (f) { return fget(st.v, f) === 0; });
        if (!clr.length) { L.push('/* 把要清除的标志位设成 0（rc_w0：写 0 清除） */'); return L.join('\n'); }
        var cm = clr.reduce(function (a, f) { return (a | fmask(f)) >>> 0; }, 0);
        L.push(Ex + ' = ' + (clr.every(function (f) { return f.cmsis; }) ? '~' + joinMac(clr) : hx((~cm & (p2(w) - 1)) >>> 0)) + ';   /* 写 0 清除，其余位写 1 无影响 */');
        L.push('/* 清 ' + clr.map(function (f) { return f.name; }).join('、') + '；不要用 &=（读-改-写可能清掉刚置位的其他标志） */');
        return L.join('\n');
      }
      var fs = ts.slice();
      if (p.kind === 'swj' && fs.length) r.fields.forEach(function (f) { if (f.rw === 'w' && !f.reserved && fs.indexOf(f) < 0) fs.push(f); });
      fs.sort(function (a, b) { return b.bits[0] - a.bits[0]; });
      if (!fs.length) L.push('/* 还没改字段：在上面改一个字段，或点「常用配置」 */');
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
      return L.join('\n');
    }
    // 当前值正好等于某条常用配置：返回它的下标（用来显示对应的 HAL 写法）
    function quickMatch(c) {
      var r = c.r, st = c.st, qs = r.quick;
      if (!Array.isArray(qs) || !qs.length) return -1;
      var enc = encode(r, st.v);
      if (st.quick > -1 && qs[st.quick] && quickVal(r, qs[st.quick]).v === enc) return st.quick;
      if (!Object.keys(st.touched).length) return -1;
      for (var i = 0; i < qs.length; i++) if (qs[i].set && Object.keys(qs[i].set).length && quickVal(r, qs[i]).v === enc) return i;
      return -1;
    }
    function halCode(c) {
      var i = quickMatch(c), q = i > -1 ? c.r.quick[i] : null;
      if (!q || !q.hal) return null;
      var code = String(q.hal), port = c.inst && /^GPIO[A-G]$/.test(c.inst.name) ? c.inst.name : null;
      if (port && !/GPIO_InitTypeDef/.test(code)) code = '/* main.c：USER CODE 2，HAL_Init / SystemClock_Config 之后 */\nGPIO_InitTypeDef GPIO_InitStruct = {0};\n__HAL_RCC_' + port + '_CLK_ENABLE();\n\n' + code;
      return { title: q.title, code: code };
    }
    function wholeCode(c) {
      var k = P(c.r).kind;
      if (k !== 'rmw' && k !== 'swj') return null;
      return '/* 整体赋值：会覆盖这个寄存器的其他字段，先确认它们 */\n' + regExpr(c.r, c.inst, c.n) + ' = ' + hexC(encode(c.r, c.st.v), P(c.r).w) + ';';
    }
    function warnings(c) {
      var r = c.r, p = P(r), st = c.st, list = [];
      if (p.m1) list.push(['note', '位 14 是保留位，但必须由软件保持为 1：计算器始终把它置 1。']);
      if (p.kind === 'swj' && r.fields.some(function (f) { return f.rw === 'w' && st.touched[f.name]; }))
        list.push(['warn', 'SWJ_CFG 只写，读回无意义：读-改-写会把它读成 000 再写回（重新打开 JTAG）。下面的代码每次都显式写入你要的 SWJ_CFG。']);
      if (p.kind === 'key') { var vk = p.byName.VECTKEY; if (vk && fget(st.v, vk) !== 0x05FA) list.push(['warn', 'VECTKEY 必须写 0x05FA，否则这次写入被忽略（读出是 0xFA05）。']); }
      if (p.kind === 'direct') list.push(['note', '只写 / 写 1 生效：直接赋值，不做读-改-写（读回的 1 会被再次写入，误触发其他位）。']);
      if (p.kind === 'flag0') list.push(['note', '标志位写 0 清除、写 1 无影响：直接赋值清标志，不要用 &=。']);
      if (p.kind === 'ro') list.push(['note', '只读寄存器：在上面填读到的值，可以逐位解码。']);
      if (p.x) list.push(['note', '复位值含 X（不确定）：计算时按 0。']);
      return list;
    }
    function notes(r) {
      var out = [];
      if (r.offsetText) out.push('偏移 = ' + r.offsetText);
      if (r.resetText) out.push('复位值：' + r.resetText);
      if (r.resetNote) out.push(r.resetNote);
      if (r.instancesNote) out.push(r.instancesNote);
      (Array.isArray(r.notes) ? r.notes : []).forEach(function (n) { out.push(n); });
      if (r.modeNote) out.push(r.modeNote);
      if (r.repeat && r.repeat.note) out.push(r.repeat.note);
      (Array.isArray(r.doubt) ? r.doubt : []).forEach(function (n) { out.push(n); });
      return out;
    }
    function manualPages(r, inst) {
      var pg = r.page || {}, adv = inst && (inst.name === 'TIM1' || inst.name === 'TIM8') && pg.en_adv != null;
      return { en: adv ? pg.en_adv : pg.en, cn: adv ? pg.cn_adv : pg.cn, pm: pg.pm0056 || null, adv: !!adv };
    }

    /* ---------- 公式助手 ---------- */
    function baud(fpclkMHz, rate) {
      var f = Number(fpclkMHz) * 1e6, b = Number(rate);
      if (!(f > 0 && b > 0)) return null;
      var div = f / (16 * b), m = Math.floor(div), fr = Math.round((div - m) * 16);
      if (fr >= 16) { m += 1; fr = 0; }
      if (m < 1 || m > 4095) return { err: true, div: div };
      var real = f / (16 * (m + fr / 16));
      return { m: m, fr: fr, div: div, real: real, e: (real - b) / b * 100 };
    }
    function i2cCcr(pclkMHz, sclKHz, duty) {
      var f = Number(pclkMHz) * 1e6, s = Number(sclKHz) * 1e3;
      if (!(f > 0 && s > 0)) return null;
      var fast = s > 100e3, k = fast ? (duty ? 25 : 3) : 2, ccr = Math.round(f / (k * s));
      return { fast: fast, duty: fast ? (duty ? 1 : 0) : 0, k: k, ccr: ccr, ok: ccr >= (fast ? 1 : 4) && ccr <= 4095 };
    }

    // 数据自检：常用配置里写死的 hex 与按规则算出的值不一致时列出来（以计算值为准）
    function verifyQuicks() {
      var bad = [];
      GROUPS.forEach(function (g) {
        g.regs.forEach(function (r) {
          (r.quick || []).forEach(function (q, i) {
            var qv = quickVal(r, q);
            if (qv.miss.length) bad.push(r.id + ' #' + i + ' set 未识别 ' + qv.miss.join(','));
            if (q.hex != null) { var h = parseHexStr(q.hex); if (h !== qv.v) bad.push(r.id + ' #' + i + ' ' + q.hex + ' ≠ ' + hexC(qv.v, P(r).w)); }
          });
        });
      });
      return bad;
    }

    return {
      meta: DATA && DATA.meta || {}, groups: GROUPS, group: function (id) { return GBY[id] || null; },
      reg: function (id) { return REG[id] || null; }, groupOf: function (r) { return r ? GOF[r.id] : null; },
      byName: function (gid, name) { return (BYNAME[gid] || {})[name] || null; },
      P: P, isRep: isRep, naOnly: naOnly, naWhy: naWhy, writable: writable,
      instList: instList, defInst: defInst, findInst: findInst, nRange: nRange, member: member, addrOf: addrOf, regExpr: regExpr,
      initVal: initVal, encode: encode, quickVal: quickVal, condTrue: condTrue, altOn: altOn, layout: layout, info: info, meaning: meaning,
      fieldsTouched: fieldsTouched, genCode: genCode, quickMatch: quickMatch, halCode: halCode, wholeCode: wholeCode,
      warnings: warnings, notes: notes, manualPages: manualPages, baud: baud, i2cCcr: i2cCcr, verifyQuicks: verifyQuicks
    };
  }

  return Object.freeze({
    create: create, fw: fw, fmask: fmask, fget: fget, fset: fset, bin: bin, hexd: hexd, hexC: hexC, hexS: hexS,
    wild: wild, parseHexStr: parseHexStr, parseSet: parseSet, parseNum: parseNum, yOf: yOf, repLabel: repLabel
  });
});
