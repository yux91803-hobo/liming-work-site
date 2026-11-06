/* ui.js — 通用界面工具：建节点、图标、提示、复制、C 语法高亮、缩放器
   DOM 全部用 createElement / createElementNS + textContent 构建，不拼 HTML。 */
(function () {
  'use strict';
  var STM = window.STM = window.STM || {};
  var SVGNS = 'http://www.w3.org/2000/svg';

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  }
  function sv(tag, attrs, text) {
    var n = document.createElementNS(SVGNS, tag);
    if (attrs) for (var k in attrs) if (Object.prototype.hasOwnProperty.call(attrs, k) && attrs[k] != null) n.setAttribute(k, String(attrs[k]));
    if (text != null) n.textContent = String(text);
    return n;
  }
  function clear(n) { while (n && n.firstChild) n.removeChild(n.firstChild); return n; }
  function btn(cls, text, label) { var b = el('button', cls, text); b.type = 'button'; if (label) b.setAttribute('aria-label', label); return b; }

  /* 24×24 线条图标；外设图标画的是这类外设最典型的东西（时钟、引脚、闪电、波形…） */
  var ICONS = {
    search: ['M10.5 4.5a6 6 0 1 1 0 12 6 6 0 0 1 0-12Z', 'M15 15l4.5 4.5'],
    back: ['M14.5 5.5 8 12l6.5 6.5'],
    menu: ['M4.5 7h15M4.5 12h15M4.5 17h15'],
    next: ['M9.5 5.5 16 12l-6.5 6.5'],
    close: ['M6.5 6.5l11 11M17.5 6.5l-11 11'],
    copy: ['M9 9h9.5a1.5 1.5 0 0 1 1.5 1.5V20a1.5 1.5 0 0 1-1.5 1.5H9A1.5 1.5 0 0 1 7.5 20v-9.5A1.5 1.5 0 0 1 9 9Z', 'M4 15V4.5A1.5 1.5 0 0 1 5.5 3H15'],
    check: ['M5 12.5l4.5 4.5L19 7.5'],
    map: ['M4 6.5 9 4.5l6 2 5-2v13l-5 2-6-2-5 2Z', 'M9 4.5v13M15 6.5v13'],
    chip: ['M7 7h10v10H7Z', 'M10 4v3M14 4v3M10 17v3M14 17v3M4 10h3M4 14h3M17 10h3M17 14h3'],
    board: ['M3.5 5.5h17v13h-17Z', 'M7 9h4v4H7Z', 'M14 9h3M14 12h3M7 15.5h10'],
    book: ['M5 4.5h9.5a2 2 0 0 1 2 2V19a1 1 0 0 0-1-1H5Z', 'M16.5 6.5H19v13H7.5a2.5 2.5 0 0 1-2.5-1.5'],
    reset: ['M5 12a7 7 0 1 0 2.1-5', 'M5 4.5V8h3.5'],
    plus: ['M12 5.5v13M5.5 12h13'],
    minus: ['M5.5 12h13'],
    warn: ['M12 4.5 20.5 19h-17Z', 'M12 10v4M12 16.5v.5'],
    info: ['M12 3.5a8.5 8.5 0 1 1 0 17 8.5 8.5 0 0 1 0-17Z', 'M12 11v5.5M12 7.5v.5'],
    code: ['M9 7.5 4.5 12 9 16.5M15 7.5l4.5 4.5-4.5 4.5'],
    image: ['M4.5 5.5h15v13h-15Z', 'M4.5 15l4-4 4 4 2.5-2.5 4.5 4.5', 'M15 8.5h.5'],
    retry: ['M19.5 12a7.5 7.5 0 1 1-2.2-5.3', 'M19.5 4.5v4h-4'],
    clock: ['M12 4a8 8 0 1 1 0 16 8 8 0 0 1 0-16Z', 'M12 7.5V12l3 2'],
    gpio: ['M5 12h5M14 12h5', 'M10 8.5h4v7h-4Z', 'M12 4.5v4M12 15.5v4'],
    bolt: ['M13 3.5 6.5 13h5l-1 7.5L17.5 11h-5Z'],
    serial: ['M3.5 9h3l2 6 2-6 2 6 2-6 2 6 2-6h2'],
    bus: ['M4 8h16M4 16h16', 'M8 8v8M16 8v8'],
    timer: ['M12 6.5a7 7 0 1 1 0 14 7 7 0 0 1 0-14Z', 'M10 3.5h4M12 10v3.5', 'M18.5 6.5l1.2-1.2'],
    dma: ['M4 7h11M12 4l3 3-3 3', 'M20 17H9M12 14l-3 3 3 3'],
    wave: ['M3.5 12c2-5 4-5 6 0s4 5 6 0 4-5 5-2', 'M3.5 19.5h17'],
    spi: ['M4 6.5h16M4 10.5h16M4 14.5h16M4 18.5h16', 'M8 4.5v4M16 12.5v4'],
    lcd: ['M3.5 5h17v11h-17Z', 'M9 19.5h6M12 16v3.5'],
    idea: ['M9 17.5h6M10 20.5h4', 'M12 3.5a6 6 0 0 0-3.6 10.8c.7.6 1.1 1.3 1.1 2.2h5c0-.9.4-1.6 1.1-2.2A6 6 0 0 0 12 3.5Z'],
    flag: ['M5.5 20.5v-16', 'M5.5 4.5h11l-2.5 4 2.5 4h-11'],
    undo: ['M9 7.5 4.5 12 9 16.5', 'M4.5 12h10a5 5 0 0 1 0 10h-3']
  };
  function icon(name, cls) {
    var s = sv('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false', 'class': cls || 'ic' });
    (ICONS[name] || ICONS.info).forEach(function (d) { s.appendChild(sv('path', { d: d })); });
    return s;
  }
  function reduced() { return !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches); }
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function debounce(fn, ms) { var t = 0; return function () { var a = arguments, s = this; clearTimeout(t); t = setTimeout(function () { fn.apply(s, a); }, ms); }; }

  // 搜索、寄存器、看图可以叠开；只有最上层可操作，最后一层关闭才恢复页面滚动。
  var modals = [];
  function modal(node, on) {
    var i = modals.indexOf(node);
    if (i >= 0) modals.splice(i, 1);
    if (on) modals.push(node); else node.inert = true;
    modals.forEach(function (n, j) { n.inert = j !== modals.length - 1; });
    var app = document.getElementById('app'); if (app) app.inert = !!modals.length;
    document.documentElement.classList.toggle('modal', !!modals.length);
  }

  var toastT = 0;
  function toast(msg) {
    var t = document.getElementById('toast');
    if (!t) return;
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toastT); toastT = setTimeout(function () { t.classList.remove('show'); }, 1600);
  }

  /* ================= C 语法高亮 =================
     单遍扫描，输出 DocumentFragment（span.hl-* + textContent）；类别：com str num pre kw type mac fn */
  function wordSet(str) { var o = Object.create(null); str.split(' ').forEach(function (w) { if (w) o[w] = 1; }); return o; }
  var HL_KW = wordSet('if else while for do return void static volatile const struct typedef sizeof extern switch case break default continue enum union goto register inline restrict auto NULL true false');
  var HL_TY = wordSet('int char float double long short unsigned signed bool _Bool size_t ptrdiff_t uintptr_t intptr_t ' +
    'uint8_t uint16_t uint32_t uint64_t int8_t int16_t int32_t int64_t u8 u16 u32 s8 s16 s32 FILE');
  var RX_ID = /[A-Za-z_][A-Za-z0-9_]*/y;
  var RX_NUM = /(?:0[xX][0-9a-fA-F]+|0[bB][01]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)[uUlLfF]*/y;
  var RX_DIR = /#[ \t]*[A-Za-z_]*/y;
  function isWs(c) { return c === ' ' || c === '\t' || c === '\u00a0' || c === '\r'; }
  function hlC(src) {
    var f = document.createDocumentFragment(), s = String(src == null ? '' : src), n = s.length;
    var i = 0, plain = '', bol = true, inc = false, m, j, c;
    function flush() { if (plain) { f.appendChild(document.createTextNode(plain)); plain = ''; } }
    function tok(cls, t) { flush(); var sp = document.createElement('span'); sp.className = 'hl-' + cls; sp.textContent = t; f.appendChild(sp); }
    function quoted(q) {                              // "…" / '…'：支持 \ 转义；到行尾仍未闭合就截止
      j = i + 1;
      while (j < n) { c = s.charAt(j); if (c === '\\') { j += 2; continue; } if (c === q) { j++; break; } if (c === '\n') break; j++; }
      if (j > n) j = n;
      return s.slice(i, j);
    }
    while (i < n) {
      c = s.charAt(i);
      if (c === '\n') { plain += c; i++; bol = true; inc = false; continue; }
      if (isWs(c)) { plain += c; i++; continue; }
      if (c === '/' && s.charAt(i + 1) === '*') {
        j = s.indexOf('*/', i + 2); j = j < 0 ? n : j + 2;
        tok('com', s.slice(i, j)); i = j; bol = false; continue;
      }
      if (c === '/' && s.charAt(i + 1) === '/') {
        j = s.indexOf('\n', i); if (j < 0) j = n;
        tok('com', s.slice(i, j)); i = j; continue;
      }
      if (c === '#' && bol) {
        RX_DIR.lastIndex = i; m = RX_DIR.exec(s);
        var d = m[0]; tok('pre', d); i += d.length; bol = false;
        inc = /include|import/.test(d);
        continue;
      }
      bol = false;
      if (c === '<' && inc) {                         // #include <stdio.h>
        j = s.indexOf('>', i); var e = s.indexOf('\n', i); if (e < 0) e = n;
        if (j > -1 && j < e) { tok('pre', s.slice(i, j + 1)); i = j + 1; continue; }
      }
      if (c === '"' || c === '\'') { var t = quoted(c); tok('str', t); i += t.length; continue; }
      if ((c >= '0' && c <= '9') || (c === '.' && /[0-9]/.test(s.charAt(i + 1)))) {
        RX_NUM.lastIndex = i; m = RX_NUM.exec(s);
        if (m && m[0]) { tok('num', m[0]); i += m[0].length; continue; }
      }
      if (/[A-Za-z_]/.test(c)) {
        RX_ID.lastIndex = i; m = RX_ID.exec(s);
        var w = m[0], next = s.charAt(i + w.length), cls = null;
        if (HL_KW[w]) cls = 'kw';
        else if (HL_TY[w] || /TypeDef$/.test(w)) cls = 'type';
        else if (w.length > 1 && /^_*[A-Z][A-Z0-9_]*$/.test(w)) cls = 'mac';
        else if (next === '(') cls = 'fn';
        if (cls) tok(cls, w); else plain += w;
        i += w.length; continue;
      }
      plain += c; i++;
    }
    flush();
    return f;
  }
  function plainCode(t) { return String(t == null ? '' : t).replace(/\u00a0/g, ' '); }

  // 选中代码区文字复制：只给纯文本，NBSP → 普通空格
  document.addEventListener('copy', function (e) {
    var sel = window.getSelection ? window.getSelection() : null;
    if (!sel || sel.isCollapsed || !e.clipboardData) return;
    function inCode(nd) { nd = nd && (nd.nodeType === 1 ? nd : nd.parentNode); return !!(nd && nd.closest && nd.closest('pre')); }
    if (!inCode(sel.anchorNode) && !inCode(sel.focusNode)) return;
    try { e.clipboardData.setData('text/plain', plainCode(sel.toString())); e.preventDefault(); } catch (err) {}
  });
  function copyText(text, btnEl) {
    text = plainCode(text);
    function done() {
      if (btnEl) { btnEl.classList.add('done'); clearTimeout(btnEl._t); btnEl._t = setTimeout(function () { btnEl.classList.remove('done'); }, 1400); }
      toast('已复制');
    }
    function fallback() {
      var ta = el('textarea'); ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      var ok = false; try { ok = document.execCommand('copy'); } catch (e) {}
      ta.remove(); if (ok) done(); else toast('复制失败：请长按选择文字');
    }
    if (navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext !== false) navigator.clipboard.writeText(text).then(done, fallback);
    else fallback();
  }
  function copyBtn(label, getText) {
    var b = btn('copy', null, label);
    b.appendChild(icon('copy', 'ic i-copy')); b.appendChild(icon('check', 'ic i-ok')); b.appendChild(el('span', null, '复制'));
    b.addEventListener('click', function (e) { e.stopPropagation(); copyText(getText(), b); });
    return b;
  }
  /* 代码块：标题行（可选）+ 复制按钮 + 高亮代码；text 可以是函数（每次复制时取最新） */
  function codeBlock(text, opts) {
    opts = opts || {};
    var box = el('figure', 'code' + (opts.cls ? ' ' + opts.cls : '')), head = el('figcaption', 'code-h');
    head.appendChild(el('span', 'code-t', opts.title || 'C'));
    var get = typeof text === 'function' ? text : function () { return text; };
    head.appendChild(copyBtn(opts.copyLabel || ('复制' + (opts.title || '代码')), function () { return box._text != null ? box._text : get(); }));
    var pre = el('pre'), code = el('code');
    pre.appendChild(code); box.appendChild(head); box.appendChild(pre);
    box.set = function (t) { box._text = String(t == null ? '' : t); clear(code); code.appendChild(hlC(box._text)); };
    box.set(get());
    return box;
  }

  /* ================= 缩放器（图片 / 原理图 / 封装图） =================
     手势中用 transform 缩放；停手后把缩放落实为元素真实宽高，矢量图按新尺寸重绘，放大后小字仍清晰。 */
  function Zoomer(view, content, opt) {
    opt = opt || {};
    var max = opt.max || 8, dbl = opt.dbl || 3;
    var nw = 0, nh = 0, bw = 0, bh = 0, s = 1, cs = 1, x = 0, y = 0;
    var pts = {}, np = 0, g = null, rect = null, moved = false, t0 = 0, sx = 0, sy = 0, downTarget = null;
    var lastTap = null, animT = 0, wheelT = 0, multi = false, s0 = 1;
    var ts = 1, wax = 0, way = 0, wRaf = 0, wLast = 0;      // 滚轮 / 键盘缩放：目标倍率 + 锚点，rAF 插值逼近
    view.classList.add('zoom-view');

    function W() { return view.clientWidth; }
    function H() { return view.clientHeight; }
    // .zoomed：放大后才独占单指拖动（CSS 里 touch-action: none）；原始比例下 .pkg 是 pan-y，竖滑交给页面滚动
    function apply() {
      content.style.transform = 'translate3d(' + x + 'px,' + y + 'px,0) scale(' + (s / cs) + ')';
      var z = s > 1.01;
      if (z !== view.classList.contains('zoomed')) view.classList.toggle('zoomed', z);
      if (opt.onZoom) opt.onZoom(s);
    }
    function commit() {
      cs = s;
      content.style.width = (bw * s) + 'px';
      content.style.height = (bh * s) + 'px';
      apply();
    }
    function clampS(v) { return Math.max(1, Math.min(max, v)); }
    function clampXY() {
      var w = bw * s, h = bh * s, vw = W(), vh = H();
      x = w <= vw ? (vw - w) / 2 : Math.min(0, Math.max(vw - w, x));
      y = h <= vh ? (vh - h) / 2 : Math.min(0, Math.max(vh - h, y));
    }
    function zoomAt(ns, cx, cy) {
      var px = (cx - x) / s, py = (cy - y) / s;
      s = ns; x = cx - px * s; y = cy - py * s;
    }
    // 停止滚轮插值；snap：直接跳到目标倍率（锚点不变）
    function wheelStop(snap) {
      if (wRaf) {
        cancelAnimationFrame(wRaf); wRaf = 0;
        if (snap) { zoomAt(ts, wax, way); clampXY(); apply(); }
      }
      ts = s;
    }
    function wheelStep(now) {
      wRaf = 0;
      var dt = Math.min(64, Math.max(1, now - wLast)); wLast = now;
      var ns = s + (ts - s) * (1 - Math.exp(-dt / 32));     // 时间常数 32ms：约 100–150ms 收敛
      if (Math.abs(ts - ns) <= ts * .002) ns = ts;
      zoomAt(ns, wax, way); clampXY(); apply();
      if (ns !== ts) { wRaf = requestAnimationFrame(wheelStep); return; }
      clearTimeout(wheelT);
      wheelT = setTimeout(commit, 120);
    }
    // 以视口坐标 (cx, cy) 为锚点把目标倍率乘 f；减弱动效下直接到位
    function zoomBy(f, cx, cy) {
      clearTimeout(animT);
      if (content.classList.contains('anim')) { content.classList.remove('anim'); commit(); }
      clearTimeout(wheelT);
      ts = clampS((wRaf ? ts : s) * f);
      wax = cx; way = cy;
      if (reduced()) {
        if (wRaf) { cancelAnimationFrame(wRaf); wRaf = 0; }
        zoomAt(ts, cx, cy); clampXY(); apply();
        wheelT = setTimeout(commit, 160);
        return;
      }
      if (!wRaf) {
        wLast = window.performance && performance.now ? performance.now() : Date.now();
        wRaf = requestAnimationFrame(wheelStep);
      }
    }
    function settle(animate) {
      wheelStop(false); clearTimeout(wheelT);
      s = clampS(s); clampXY();
      clearTimeout(animT);
      if (animate && !reduced()) {
        content.classList.add('anim'); apply();
        animT = setTimeout(function () { content.classList.remove('anim'); commit(); }, 250);
      } else {
        content.classList.remove('anim'); commit();
      }
    }
    function fit(w, h) {
      if (w && h) { nw = w; nh = h; }
      if (!nw || !nh) return;
      var vw = W(), vh = H();
      if (!vw || !vh) return;
      var f = Math.min(vw / nw, vh / nh);
      wheelStop(false); clearTimeout(wheelT);
      bw = nw * f; bh = nh * f; s = 1; ts = 1;
      x = (vw - bw) / 2; y = (vh - bh) / 2;
      clearTimeout(animT); content.classList.remove('anim');
      commit();
    }
    function local(e) { return { x: e.clientX - rect.left, y: e.clientY - rect.top }; }
    // onTap 处理过的轻点：约 400ms 内一次性在捕获阶段吞掉紧随其后的 click，防止它落到切换后页面的元素上
    var swallowH = null, swallowT = 0;
    function releaseSwallow() {
      if (swallowH) window.removeEventListener('click', swallowH, true);
      swallowH = null; clearTimeout(swallowT);
    }
    function swallowClick() {
      releaseSwallow();
      swallowH = function (ev) {
        ev.preventDefault(); ev.stopPropagation();
        if (ev.stopImmediatePropagation) ev.stopImmediatePropagation();
        releaseSwallow();
      };
      window.addEventListener('click', swallowH, true);
      swallowT = setTimeout(releaseSwallow, 400);
    }
    function two() {
      var a = [], k;
      for (k in pts) a.push(pts[k]);
      return a;
    }
    function begin() {
      var a = two();
      if (a.length >= 2) {
        var m = { x: (a[0].x + a[1].x) / 2, y: (a[0].y + a[1].y) / 2 };
        var d = Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y) || 1;
        g = { mode: 2, d0: d, s0: s, px: (m.x - x) / s, py: (m.y - y) / s };
      } else if (a.length === 1) {
        g = { mode: 1, lx: a[0].x, ly: a[0].y };
      }
    }

    view.addEventListener('pointerdown', function (e) {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (!bw) return;
      try { view.setPointerCapture(e.pointerId); } catch (err) {}
      rect = view.getBoundingClientRect();
      if (np === 0) { downTarget = e.target; t0 = Date.now(); moved = false; multi = false; s0 = s; sx = e.clientX; sy = e.clientY; }
      if (!pts[e.pointerId]) np++;
      pts[e.pointerId] = local(e);
      if (np > 1) { moved = true; multi = true; }
      clearTimeout(animT);
      wheelStop(false);
      if (content.classList.contains('anim')) { content.classList.remove('anim'); commit(); }
      view.classList.add('live');
      begin();
    });
    view.addEventListener('pointermove', function (e) {
      if (!pts[e.pointerId] || !g) return;
      pts[e.pointerId] = local(e);
      var a = two();
      if (g.mode === 2 && a.length >= 2) {
        var m = { x: (a[0].x + a[1].x) / 2, y: (a[0].y + a[1].y) / 2 };
        var d = Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y) || 1;
        var ns = g.s0 * d / g.d0;
        if (ns < 1) ns = 1 - (1 - ns) * .35;                 // 越界阻尼
        if (ns > max) ns = max + (ns - max) * .35;
        s = ns; x = m.x - g.px * s; y = m.y - g.py * s;
        apply();
      } else if (g.mode === 1) {
        var p = pts[e.pointerId];
        if (!moved && Math.abs(e.clientX - sx) + Math.abs(e.clientY - sy) > 6) moved = true;
        // 原始比例下的触屏单指：不拖内容（竖滑由浏览器滚动页面，横滑不动）
        var hold = opt.scrollAtFit && e.pointerType === 'touch' && s <= 1.01;
        if (moved && !hold) {
          var dx = p.x - g.lx, dy = p.y - g.ly;
          var w = bw * s, h = bh * s, vw = W(), vh = H();
          var minX = w <= vw ? (vw - w) / 2 : vw - w, maxX = w <= vw ? (vw - w) / 2 : 0;
          var minY = h <= vh ? (vh - h) / 2 : vh - h, maxY = h <= vh ? (vh - h) / 2 : 0;
          x += (x + dx > maxX || x + dx < minX) ? dx * .35 : dx;
          y += (y + dy > maxY || y + dy < minY) ? dy * .35 : dy;
          apply();
        }
        g.lx = p.x; g.ly = p.y;
      }
    });
    function end(e) {
      if (!pts[e.pointerId]) return;
      delete pts[e.pointerId]; np--;
      if (np > 0) { begin(); return; }
      np = 0; g = null;
      view.classList.remove('live');
      // 原始比例下单指快速横滑：翻页（水平位移 > 60px、明显大于竖直位移、速度够快或划过 40% 宽度）
      if (e.type === 'pointerup' && opt.onSwipe && moved && !multi && s0 <= 1.02 && s <= 1.05) {
        var sdx = e.clientX - sx, sdy = e.clientY - sy, sdt = Math.max(1, Date.now() - t0);
        if (Math.abs(sdx) > 60 && Math.abs(sdx) > Math.abs(sdy) * 1.5 && (Math.abs(sdx) / sdt >= 0.3 || Math.abs(sdx) > W() * 0.4)) {
          if (opt.onSwipe(sdx < 0 ? 1 : -1)) { lastTap = null; return; }
        }
      }
      if (e.type === 'pointerup' && !moved && Date.now() - t0 < 400) {
        var p = local(e);
        if (opt.onTap) {
          swallowClick();                                   // 先挂好：吞掉本次 pointerup 之后浏览器补发的 click
          if (opt.onTap(downTarget, e)) { lastTap = null; settle(false); return; }
          releaseSwallow();
        }
        var now = Date.now();
        if (lastTap && now - lastTap.t < 320 && Math.hypot(p.x - lastTap.x, p.y - lastTap.y) < 30) {
          lastTap = null;
          if (s > 1.02) { s = 1; } else { zoomAt(clampS(dbl), p.x, p.y); }
          settle(true);
          return;
        }
        lastTap = { t: now, x: p.x, y: p.y };
        settle(false);
        return;
      }
      settle(true);
    }
    view.addEventListener('pointerup', end);
    view.addEventListener('pointercancel', end);
    view.addEventListener('lostpointercapture', function (e) { if (pts[e.pointerId]) end(e); });
    // touch-action: pan-y 下双指捏合 / 放大后的拖动不让浏览器滚动页面
    if (opt.scrollAtFit) view.addEventListener('touchmove', function (e) {
      if ((e.touches.length > 1 || s > 1.01) && e.cancelable) e.preventDefault();
    }, { passive: false });
    // 键盘聚焦内部元素时浏览器可能滚动 overflow:hidden 的容器，坐标会错位：一律复位
    view.addEventListener('scroll', function () { if (view.scrollLeft || view.scrollTop) { view.scrollLeft = 0; view.scrollTop = 0; } });

    // deltaMode 归一化为像素：0 像素、1 行（约 33px）、2 页（视口高）
    function px(d, m) { return m === 1 ? d * 33 : m === 2 ? d * (H() || window.innerHeight || 800) : d; }
    view.addEventListener('wheel', function (e) {
      if (!bw) return;
      var cur = wRaf ? ts : s;
      if (opt.wheelNeedsCtrl && !e.ctrlKey && cur <= 1.001) return;   // 内嵌图：普通滚轮留给页面滚动
      e.preventDefault();
      rect = view.getBoundingClientRect();
      var cx = e.clientX - rect.left, cy = e.clientY - rect.top;
      var dy = px(e.deltaY, e.deltaMode);
      if (opt.wheelZoom || e.ctrlKey || !opt.wheelPans || cur <= 1.001) {
        // 触控板捏合（ctrl + 小 delta）用大系数跟手；鼠标滚轮一格（约 100px）≈ 10%
        var k = e.ctrlKey && Math.abs(dy) < 50 ? .01 : .00095;
        dy = Math.max(-100, Math.min(100, dy));
        if (dy) zoomBy(Math.exp(-dy * k), cx, cy);
        return;
      }
      wheelStop(true);
      x -= px(e.deltaX, e.deltaMode); y -= dy;
      clampXY(); apply();
      clearTimeout(wheelT);
      wheelT = setTimeout(commit, 160);
    }, { passive: false });

    return {
      fit: fit,
      refit: function () { fit(); },
      reset: function () { wheelStop(false); s = 1; settle(true); },
      // 键盘缩放：以视口中心把倍率乘 f（平滑，减弱动效下直接到位）
      zoomBy: function (f) { if (bw) zoomBy(f, W() / 2, H() / 2); },
      // 以内容坐标 (px, py)（与 fit 的 w/h 同一坐标系）为中心放大到 ns
      focus: function (px, py, ns) {
        if (!bw) return;
        var f = bw / nw;
        s = clampS(ns);
        x = W() / 2 - px * f * s; y = H() / 2 - py * f * s;
        settle(true);
      },
      // 已放大时，若内容坐标 (px, py) 不在可视区内，平移过去（键盘 Tab 到封装图上的引脚）
      reveal: function (px, py) {
        if (!bw || s <= 1.01) return;
        var f = bw / nw, vx = x + px * f * s, vy = y + py * f * s, m = 24;
        if (vx >= m && vx <= W() - m && vy >= m && vy <= H() - m) return;
        x = W() / 2 - px * f * s; y = H() / 2 - py * f * s;
        settle(true);
      },
      scale: function () { return s; },
      // 同一个查看器在不同模式下用不同的放大上限 / 双击倍数（课件位图 4x / 2.5x，原理图、架构图 8x / 3x）
      limits: function (m, d) { max = m || 8; dbl = d || 3; wheelStop(false); if (s > max) { s = max; settle(false); } },
      clear: function () { wheelStop(false); clearTimeout(wheelT); nw = nh = bw = bh = 0; s = cs = ts = 1; content.style.width = content.style.height = '0px'; content.style.transform = ''; view.classList.remove('zoomed'); if (opt.onZoom) opt.onZoom(1); },
      ready: function () { return bw > 0; }
    };
  }

  STM.ui = {
    el: el, sv: sv, clear: clear, btn: btn, icon: icon, reduced: reduced, lsGet: lsGet, lsSet: lsSet, debounce: debounce,
    toast: toast, hlC: hlC, plainCode: plainCode, copyText: copyText, copyBtn: copyBtn, codeBlock: codeBlock, Zoomer: Zoomer, modal: modal
  };
})();
