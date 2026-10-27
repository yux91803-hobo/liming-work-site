/* stm32.js — LIMING 工具箱 · STM32 学习工具
   引脚速查 / 代码片段 / 芯片·板子 / 架构图 / 课件
   DOM 全部用 createElement / createElementNS + textContent / setAttribute 构建，不拼 HTML，不用 eval。 */
(function () {
  'use strict';

  var SVGNS = 'http://www.w3.org/2000/svg';
  var html = document.documentElement;
  var $ = function (id) { return document.getElementById(id); };
  var embedded = html.classList.contains('embed');
  var PINS = Array.isArray(window.STM32_PINS) ? window.STM32_PINS : [];
  var SNIPS = Array.isArray(window.STM32_SNIPPETS) ? window.STM32_SNIPPETS : [];
  var BOARD = window.STM32_BOARD && Array.isArray(window.STM32_BOARD.resources) ? window.STM32_BOARD : null;
  var ASSETS = window.STM32_ASSETS || { board: '', schematic: [] };
  var FIGS = Array.isArray(window.STM32_MANUAL_FIGS) ? window.STM32_MANUAL_FIGS : [];
  var TEACH = Array.isArray(window.STM32_TEACH_FIGS) ? window.STM32_TEACH_FIGS : [];
  var CW = window.STM32_COURSEWARE && Array.isArray(window.STM32_COURSEWARE.parts) ? window.STM32_COURSEWARE : null;
  var ERR = window.STM32_CW_ERRATA && Array.isArray(window.STM32_CW_ERRATA.items) ? window.STM32_CW_ERRATA : null;
  var TYPE_NAME = { P: '电源', G: '地', S: '系统', N: 'NC' };

  /* ================= 小工具 ================= */

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  }
  function sv(tag, attrs, text) {
    var n = document.createElementNS(SVGNS, tag);
    if (attrs) for (var k in attrs) if (Object.prototype.hasOwnProperty.call(attrs, k)) n.setAttribute(k, String(attrs[k]));
    if (text != null) n.textContent = String(text);
    return n;
  }
  function icon(paths) {
    var s = sv('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false' });
    paths.forEach(function (d) { s.appendChild(sv('path', { d: d })); });
    return s;
  }
  var IC = {
    copy: ['M9 9h9.5a1.5 1.5 0 0 1 1.5 1.5V20a1.5 1.5 0 0 1-1.5 1.5H9A1.5 1.5 0 0 1 7.5 20v-9.5A1.5 1.5 0 0 1 9 9Z', 'M4 15V4.5A1.5 1.5 0 0 1 5.5 3H15'],
    ok: ['M5 12.5l4.5 4.5L19 7.5'],
    doc: ['M7 3.5h7l4 4V20a.5.5 0 0 1-.5.5h-10.5a.5.5 0 0 1-.5-.5V4a.5.5 0 0 1 .5-.5Z', 'M14 3.5V8h4', 'M9.5 12.5h5M9.5 16h5'],
    chev: ['M9.5 5.5 16 12l-6.5 6.5'],
    empty: ['M4.5 6.5a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2Z', 'M4.5 15.5l4-4 3.5 3.5 2.5-2.5 5 5', 'M4 4l16 16'],
    search: ['M10.5 4.5a6 6 0 1 1 0 12 6 6 0 0 1 0-12Z', 'M15 15l4.5 4.5'],
    retry: ['M19.5 12a7.5 7.5 0 1 1-2.2-5.3', 'M19.5 4.5v4h-4']
  };
  function emptyState(node, word, ic) {
    while (node.firstChild) node.removeChild(node.firstChild);
    node.appendChild(icon(ic || IC.empty));
    node.appendChild(el('span', null, word));
    node.hidden = false;
    return node;
  }
  function reduced() { return !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches); }
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

  var toastTimer = 0;
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 1600);
  }

  /* 按压反馈：pointerdown 加 .press（CSS 里 .1s 快速收缩），松开/取消/移出撤销（CSS 里较长 ease-out 回位）；
     极快的轻点至少保持 90ms；触屏列表行延迟 70ms 再按下，滚动开始时浏览器发 pointercancel，避免滑动时闪一下 */
  function pressable(root, sel, delayTouch) {
    var cur = null, t0 = 0, tm = 0, dm = 0;
    function release() {
      clearTimeout(dm);
      if (!cur) return;
      var e = cur, left = 90 - (Date.now() - t0); cur = null; clearTimeout(tm);
      if (!e.classList.contains('press')) return;
      if (left > 0) tm = setTimeout(function () { e.classList.remove('press'); }, left); else e.classList.remove('press');
    }
    root.addEventListener('pointerdown', function (ev) {
      if (ev.button > 0) return;
      var t = sel ? ev.target.closest(sel) : root;
      if (!t || !root.contains(t) || t.disabled) return;
      clearTimeout(tm); clearTimeout(dm);
      if (cur && cur !== t) cur.classList.remove('press');
      cur = t;
      var go = function () { if (cur === t) { t0 = Date.now(); t.classList.add('press'); } };
      if (delayTouch && ev.pointerType === 'touch') dm = setTimeout(go, 70); else go();
    });
    root.addEventListener('pointerup', function () {
      if (cur && !cur.classList.contains('press')) { clearTimeout(dm); var t = cur; t0 = Date.now(); t.classList.add('press'); }
      release();
    });
    root.addEventListener('pointercancel', release);
    root.addEventListener('pointerout', function (ev) { if (cur && !cur.contains(ev.relatedTarget)) release(); });
  }

  /* ================= 主题（lm.theme：light / dark / auto，默认 light） ================= */

  var mq = window.matchMedia ? matchMedia('(prefers-color-scheme: dark)') : null;
  function applyTheme() {
    var t = lsGet('lm.theme') || 'light';
    var dark = t === 'dark' || (t === 'auto' && mq && mq.matches);
    html.setAttribute('data-theme', dark ? 'dark' : 'light');
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', dark ? '#1f1e1d' : '#faf9f5');
  }
  applyTheme();
  if (mq) (mq.addEventListener ? mq.addEventListener('change', applyTheme) : mq.addListener(applyTheme));
  window.addEventListener('storage', function (e) { if (e.key === 'lm.theme') applyTheme(); });

  // 工具箱外壳：{type:'theme'} 切主题；{type:'back'} 关查看器（返回一层）；{type:'reset'} 工具被关掉，收起查看器、不抢焦点
  window.addEventListener('message', function (e) {
    if (e.origin !== location.origin || !e.data) return;
    if (e.data.type === 'theme') applyTheme();
    if (e.source !== window.parent) return;
    if (e.data.type === 'back' && document.querySelector('.lm-dialog[open]')) return;
    if (e.data.type === 'back' && viewer.isOpen()) viewer.back();
    if (e.data.type === 'reset' && viewer.isOpen()) viewer.close(true, true);
  });
  function toShell(msg) { if (!embedded) return; try { parent.postMessage(msg, location.origin); } catch (e) {} }
  function notifyDepth(d) { toShell({ type: 'depth', depth: d }); }
  var readySent = false;
  function notifyReady() { if (readySent) return; readySent = true; try { if (window.self !== window.top) parent.postMessage({ type: 'ready' }, location.origin); } catch (e) {} }

  // 仅图片/封装查看器处理缩放；正文保留 Safari 原生双指放大。
  ['gesturestart', 'gesturechange', 'gestureend'].forEach(function (n) {
    document.addEventListener(n, function (e) {
      if (e.target && e.target.closest && e.target.closest('.zoom-view')) e.preventDefault();
    }, { passive: false });
  });

  /* ================= 顶栏高度 / 分隔线 ================= */

  var top = $('top');
  function syncTop() { $('app').style.setProperty('--top-h', top.offsetHeight + 'px'); }
  syncTop();
  if (window.ResizeObserver) new ResizeObserver(syncTop).observe(top);
  window.addEventListener('resize', syncTop);

  /* ================= 缩放器（封装图 / 原理图 / 架构图共用） =================
     手势中用 transform 缩放（流畅）；停手后把缩放「落实」为元素真实宽高，矢量图按新尺寸重新绘制，8x 小字依然清晰 */

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

  /* ================= 分段切换 ================= */

  var seg = $('seg'), segInk = seg.querySelector('.seg-ink');
  var segBtns = Array.prototype.slice.call(seg.querySelectorAll('.seg-btn'));
  var curTab = 'pins', activeSnippet = '', packagePin = null;
  /* 节流：单次操作照旧在下一帧同步；连续触发（打字、按住方向键翻课件）最多每 300ms 同步一次。
     Safari / Chrome 对 replaceState / pushState 有频率上限（约 100 次 / 10s），超出会抛 SecurityError，
     外壳同一时间压的子视图历史记录也会失败，返回键就错乱了 */
  var routeRAF = 0, routeT = 0, routeLast = 0, ROUTE_GAP = 300;
  function contextChanged() {
    if (routeRAF || routeT) return;
    var wait = ROUTE_GAP - (Date.now() - routeLast);
    if (wait > 0) routeT = setTimeout(function () { routeT = 0; routeRAF = requestAnimationFrame(runRoute); }, wait);
    else routeRAF = requestAnimationFrame(runRoute);
  }
  function runRoute() { routeRAF = 0; routeLast = Date.now(); syncContext(); }
  function context() {
    var t = { tab: curTab }, title = { pins: '引脚速查', regs: '寄存器', code: '代码片段', chip: '芯片 / 板子', arch: '架构图', course: '课件' }[curTab];
    if (viewer && viewer.isOpen()) { var vc = viewer.context(); if (vc) return vc; }
    if (curTab === 'pins' && q && q.value.trim()) { t.q = q.value.trim(); title = '引脚 · ' + t.q; }
    if (curTab === 'regs' && regsReady && regsUI() && regsUI().context) { var rc = regsUI().context(); if (rc) return rc; }
    if (curTab === 'code') { t.cat = codeCat; if (activeSnippet) t.snip = activeSnippet; title = activeSnippet || ('代码 · ' + codeCat); }
    if (curTab === 'chip' && packagePin) { t.pin = String(packagePin); title = '封装引脚 · ' + packagePin; }
    return { target: t, title: title };
  }
  function syncContext() {
    if (!window.STM32StudyCore) return;
    var c = context(), qs = window.STM32StudyCore.params(c.target);
    if (embedded) qs = 'embed=1&' + qs;
    var href = location.pathname + '?' + qs;
    if (location.pathname + location.search !== href) try { history.replaceState(history.state, '', href); } catch (e) {}
    toShell({ type: 'route', params: window.STM32StudyCore.params(c.target) });
    window.dispatchEvent(new CustomEvent('stm32:context', { detail: c }));
  }
  function navigateTarget(raw) {
    var t = window.STM32StudyCore.target(raw);
    if (viewer.isOpen()) viewer.close(true, true);
    if (t.cw) { var m = /^(.*)-(\d+)$/.exec(t.cw); switchTab('course'); window.STM32_APP.openCw(m[1], Number(m[2])); }
    else if (t.page) { switchTab('chip'); openSchematicPage(t.page); }
    else if (t.fig) gotoFig([t.fig]);
    else if (t.reg) regsOpen(t);
    else if (t.tab === 'pins') gotoPins(t.q || '');
    else if (t.tab === 'code') gotoCode(t.cat || '全部', t.snip || '');
    else if (t.pin) showOnPackage(Number(t.pin));
    else switchTab(t.tab);
    contextChanged();
  }
  function moveInk() {
    var b = seg.querySelector('.seg-btn[aria-selected="true"]');
    if (!b) return;
    if (b.scrollIntoView) b.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    segInk.style.width = b.offsetWidth + 'px';
    segInk.style.transform = 'translateX(' + b.offsetLeft + 'px)';
  }
  function switchTab(name, keepScroll) {
    if (!$('pane-' + name)) name = 'pins';
    var regsWas = curTab;                                  // HUB-T7
    curTab = name;
    // roving tabindex：只有选中的 tab 可 Tab 到（tab 栏只停一次），其余用方向键 / Home / End
    segBtns.forEach(function (b) {
      var on = b.dataset.tab === name;
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
    });
    Array.prototype.forEach.call(document.querySelectorAll('.pane'), function (p) { p.classList.toggle('active', p.dataset.pane === name); });
    moveInk();
    lsSet('lm.stm32.tab', name);
    if (name !== 'chip') packagePin = null;
    contextChanged();
    syncScrolled();
    regsTabHook(name, regsWas);                            // HUB-T7：进入 regs 懒加载 / 离开时 leave()
    if (name === 'chip') requestAnimationFrame(function () { if (pkgZoom && !pkgZoom.ready()) pkgZoom.fit(PK.S, PK.S); });
  }
  pressable(seg, '.seg-btn');
  seg.addEventListener('click', function (e) {
    var b = e.target.closest('.seg-btn');
    if (b && b.dataset.tab !== curTab) switchTab(b.dataset.tab);
  });
  /* 方向键 / Home / End（tablist 通用）：以焦点所在的那个 tab 为起点（B1），不是当前选中项 */
  function rovingKeys(btns, e, pick) {
    var k = e.key;
    if (k !== 'ArrowLeft' && k !== 'ArrowRight' && k !== 'Home' && k !== 'End') return;
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    var cur = e.target && e.target.closest ? e.target.closest('[role="tab"]') : null;
    var i = btns.indexOf(cur);
    if (i < 0) return;
    e.preventDefault();
    var n = btns.length;
    var j = k === 'Home' ? 0 : k === 'End' ? n - 1 : (i + (k === 'ArrowRight' ? 1 : n - 1)) % n;
    pick(btns[j]);
    try { btns[j].focus({ preventScroll: true }); } catch (err) { btns[j].focus(); }
  }
  segBtns.forEach(function (b) { b.tabIndex = b.getAttribute('aria-selected') === 'true' ? 0 : -1; });
  seg.addEventListener('keydown', function (e) {
    rovingKeys(segBtns, e, function (b) { if (b.dataset.tab !== curTab) switchTab(b.dataset.tab); });
  });
  window.addEventListener('resize', moveInk);
  if (window.ResizeObserver) new ResizeObserver(moveInk).observe(seg);

  function syncScrolled() {
    var p = $('pane-' + curTab);
    top.classList.toggle('scrolled', !!p && p.scrollTop > 2);
  }
  Array.prototype.forEach.call(document.querySelectorAll('.pane'), function (p) {
    p.addEventListener('scroll', function () { if (p.dataset.pane === curTab) syncScrolled(); }, { passive: true });
  });

  /* ================= 板载资源索引（来自 board.js） ================= */

  var usedBy = {};          // 脚位号 -> [资源名]
  var usedKeys = {};        // 脚位号 -> [[该资源的检索词]]（与 usedBy 一一对应）
  function pinList(r) {
    if (Array.isArray(r.pin)) return r.pin.filter(function (n) { return typeof n === 'number'; });
    return typeof r.pin === 'number' ? [r.pin] : [];
  }
  // 板载资源的检索词：整名 + 按空格/括号/斜杠等拆开的各段 + 所属分组（LED / KEY / 串口 …）
  function resKeys(r) {
    var u = String(r.name || '').toUpperCase().trim(), out = [];
    if (u) out.push(u);
    u.split(/[\s,，、\/()（）\[\]【】·:：=+]+/).forEach(function (p) { if (p && out.indexOf(p) < 0) out.push(p); });
    if (r.group) out.push(String(r.group).toUpperCase());
    return out;
  }
  if (BOARD) BOARD.resources.forEach(function (r) {
    if (!r || !r.mcu) return;
    var k = resKeys(r);
    pinList(r).forEach(function (n) {
      (usedBy[n] = usedBy[n] || []).push(String(r.name || ''));
      (usedKeys[n] = usedKeys[n] || []).push(k);
    });
  });

  /* ================= 1. 引脚速查 ================= */

  var pinRows = [];         // { n, name, row, tokens, chips:[{node, keys}] }
  var rowByPin = {};

  function splitList(s) { return s ? String(s).split(/\s+/).filter(Boolean) : []; }
  // 一个功能名展开成可检索的关键词：ADC123_IN0 → ADC1_IN0/ADC2_IN0/ADC3_IN0；JTMS-SWDIO → JTMS, SWDIO …
  function keysOf(f) {
    var u = String(f).toUpperCase(), out = [u];
    u.split(/[-\/]/).forEach(function (p) { if (p && p !== u) out.push(p); });
    var m = /^ADC(\d+)_(IN\d+)$/.exec(u);
    if (m) m[1].split('').forEach(function (d) { out.push('ADC' + d + '_' + m[2]); });
    if (/^TIM\d+_CH\d+_ETR$/.test(u)) out.push(u.replace(/_CH\d+_ETR$/, '_ETR'));
    if (/^USBD[MP]$/.test(u)) out.push('USB_' + u.slice(4));
    if (/^(JTMS|JTCK|JTDI|JTDO|NJTRST|TRACE)/.test(u) || /^J(TMS|TCK)-SW/.test(u)) out.push('JTAG');
    if (/SWDIO|SWCLK/.test(u)) out.push('SWD');
    if (/^I2S\d/.test(u)) out.push(u.replace(/^I2S(\d).*/, 'SPI$1_I2S'));
    return out;
  }

  function buildPins() {
    var list = $('pinList');
    var frag = document.createDocumentFragment();
    PINS.forEach(function (p) {
      var n = p[0], name = p[1], t = p[2], main = p[3] || name;
      var af = splitList(p[4]), rm = splitList(p[5]);
      var row = el('div', 'prow t-' + t);
      row.setAttribute('role', 'button'); row.tabIndex = 0;
      row.dataset.pin = n;
      row.setAttribute('aria-label', n + ' ' + name);
      row.appendChild(el('span', 'pnum', n));
      var body = el('div', 'pbody');
      var head = el('div', 'phead');
      head.appendChild(el('span', 'pname', name));
      if (TYPE_NAME[t]) head.appendChild(el('span', 'ptype', TYPE_NAME[t]));
      if (main !== name) head.appendChild(el('span', 'pmain', main));
      body.appendChild(head);
      var chips = [], tokens = keysOf(name).concat(keysOf(main));
      if (t === 'I') {
        tokens.push('GPIO', 'GPIO' + name.charAt(1));
        var ln = /^P[A-G](\d+)$/.exec(name.toUpperCase());
        if (ln) tokens.push('EXTI' + ln[1], 'EXTI');
      }
      if (af.length) {
        var kv = el('div', 'kv'), v = el('div', 'kv-v');
        kv.appendChild(el('span', 'kv-k', '复用'));
        af.forEach(function (f) {
          var c = el('span', 'chip', f), k = keysOf(f);
          v.appendChild(c); chips.push({ node: c, keys: k }); tokens = tokens.concat(k);
        });
        kv.appendChild(v); body.appendChild(kv);
      }
      if (rm.length) {
        var kv2 = el('div', 'kv'), v2 = el('div', 'kv-v');
        kv2.appendChild(el('span', 'kv-k', '重映射'));
        rm.forEach(function (r) {
          var i = r.indexOf('@'), sig = i > 0 ? r.slice(0, i) : r, bit = i > 0 ? r.slice(i + 1) : '';
          var c = el('span', 'chip rm');
          c.appendChild(el('span', null, sig === name ? 'GPIO' : sig));
          if (bit) c.appendChild(el('span', 'bit', bit));
          var k = keysOf(sig).concat(bit ? keysOf(bit.split('=')[0]) : []);
          if (sig === name) k.push('GPIO');
          v2.appendChild(c); chips.push({ node: c, keys: k }); tokens = tokens.concat(k);
        });
        kv2.appendChild(v2); body.appendChild(kv2);
      }
      if (usedBy[n]) {
        var use = el('div', 'puse');
        usedBy[n].forEach(function (u, j) {
          var sp = el('span', null, u), k = usedKeys[n][j] || [];
          use.appendChild(sp); chips.push({ node: sp, keys: k }); tokens = tokens.concat(k);
        });
        body.appendChild(use);
      }
      row.appendChild(body);
      regsPinBtn(row, name, t);                            // HUB-T7
      frag.appendChild(row);
      var rec = { n: n, name: name.toUpperCase(), row: row, tokens: tokens, chips: chips };
      pinRows.push(rec); rowByPin[n] = rec;
    });
    list.appendChild(frag);
    pressable(list, '.prow', true);
    list.addEventListener('click', function (e) {
      var r = e.target.closest('.prow');
      if (e.target.closest('.rg-pinreg')) return;          // HUB-T7：「寄存器」按钮不触发看封装
      if (r) showOnPackage(Number(r.dataset.pin));
    });
    list.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      if (e.target.closest('.rg-pinreg')) return;          // HUB-T7
      var r = e.target.closest('.prow');
      if (r) { e.preventDefault(); showOnPackage(Number(r.dataset.pin)); }
    });
  }

  /* 检索语法：逗号（, ，、 ; ；|）分隔为「或」，组内空格为「且」；
     「PA 9」「UART 1」这类字母+空格+数字先合并；每个词再展开别名（UART↔USART、串口→USART/UART、蜂鸣器→BEEP …），任一别名命中即可；
     英文按前缀匹配，含中文的词按包含匹配，纯数字（可带 #）匹配脚位号 */
  var ALIAS = {
    '串口': ['USART', 'UART'], '蜂鸣器': ['BEEP', 'BUZZER'], '蜂鸣': ['BEEP', 'BUZZER'], 'BUZZER': ['BEEP'], 'BEEP': ['BUZZER'],
    '按键': ['KEY'], '按钮': ['KEY'], '指示灯': ['LED'], '灯': ['LED'], '晶振': ['OSC'], '复位': ['NRST'],
    '调试': ['SWD', 'JTAG'], '下载': ['SWD', 'JTAG'], '电源': ['VDD', 'VBAT', 'VREF'], '地': ['VSS'],
    '定时器': ['TIM'], '模数': ['ADC'], '数模': ['DAC'], '外部中断': ['EXTI'], '中断': ['EXTI'], 'IIC': ['I2C']
  };
  var ALIAS_KEYS = Object.keys(ALIAS).sort(function (a, b) { return b.length - a.length; });
  function isNum(t) { return /^#?\d+$/.test(t); }
  function hasCJK(t) { return /[^\x00-\x7f]/.test(t); }
  function expandTerm(t) {
    var out = [t];
    function add(v) { if (v && out.indexOf(v) < 0) out.push(v); }
    if (/^UART/.test(t)) add('USART' + t.slice(4));
    if (/^USART/.test(t)) add('UART' + t.slice(5));
    ALIAS_KEYS.forEach(function (k) {
      if (t.indexOf(k) === 0) ALIAS[k].forEach(function (v) { add(v + t.slice(k.length)); });
    });
    return out;
  }
  function parseQuery(raw) {
    var s = String(raw || '').toUpperCase().replace(/\u3000/g, ' ');
    s = s.replace(/(^|[^A-Z0-9_])([A-Z]{1,6})\s+(\d{1,3})(?![A-Z0-9_])/g, '$1$2$3');
    var groups = [];
    s.split(/[,，、;；|]+/).forEach(function (part) {
      var ws = part.trim() ? part.trim().split(/\s+/) : [];
      if (ws.length) groups.push(ws.map(expandTerm));
    });
    return groups;
  }
  function keyHit(k, a) { return hasCJK(a) ? k.indexOf(a) > -1 : k.indexOf(a) === 0; }
  function matchAlt(rec, a) {
    if (isNum(a)) return rec.n === Number(a.replace('#', ''));
    for (var i = 0; i < rec.tokens.length; i++) if (keyHit(rec.tokens[i], a)) return true;
    return false;
  }
  function matchTerm(rec, alts) { return alts.some(function (a) { return matchAlt(rec, a); }); }
  function matchQuery(rec, groups) {
    return !groups.length || groups.some(function (g) { return g.every(function (alts) { return matchTerm(rec, alts); }); });
  }
  var lastQ = null;
  function filterPins(raw) {
    var groups = parseQuery(raw);
    var q = JSON.stringify(groups);
    $('qx').hidden = !String(raw || '').trim();
    contextChanged();
    if (q === lastQ) return;
    lastQ = q;
    var flat = [];
    groups.forEach(function (g) { g.forEach(function (alts) { alts.forEach(function (a) { if (!isNum(a)) flat.push(a); }); }); });
    var shown = 0;
    pinRows.forEach(function (rec) {
      var ok = matchQuery(rec, groups);
      rec.row.hidden = !ok;
      rec.row.style.order = ok && groups.some(function (g) { return g.length === 1 && g[0][0] === rec.name; }) ? '-1' : '';
      rec.chips.forEach(function (c) {
        var hit = ok && flat.length > 0 && flat.some(function (a) {
          return c.keys.some(function (k) { return keyHit(k, a); });
        });
        c.node.classList.toggle('hit', hit);
      });
      if (ok) shown++;
    });
    $('qn').textContent = groups.length ? String(shown) : '';
    var em = $('pinEmpty');
    if (!shown) emptyState(em, PINS.length ? '无结果' : '暂无', PINS.length ? IC.search : IC.empty); else em.hidden = true;
  }

  var q = $('q');
  q.addEventListener('input', function () { filterPins(q.value); $('pane-pins').scrollTop = 0; syncScrolled(); });
  q.addEventListener('keydown', function (e) {
    // 有内容时 Escape 只清空（preventDefault 让后面的「Escape 关闭工具」跳过）；空框时 Escape 照常冒泡
    if (e.key === 'Escape' && q.value) { e.preventDefault(); q.value = ''; filterPins(''); }
    if (e.key === 'Enter') q.blur();
  });
  $('qx').addEventListener('click', function (e) { e.preventDefault(); q.value = ''; filterPins(''); q.focus(); });
  pressable($('cmd'));
  pressable($('qx'));
  document.addEventListener('keydown', function (e) {
    if (document.querySelector('.lm-dialog[open]')) return;
    if (e.key === '/' && curTab === 'pins' && document.activeElement !== q && !viewer.isOpen()) { e.preventDefault(); q.focus(); }
  });

  /* 等滚动容器停下：支持 scrollend 时用它；同时每帧检查 scrollTop，连续 8 帧不变也算停下（不需要滚动时 scrollend 不会触发）；
     最长 3s 兜底。cb 只执行一次 */
  function afterScroll(box, cb) {
    var done = false, last = box.scrollTop, still = 0, raf = 0, tmo = 0;
    function fin() {
      if (done) return; done = true;
      box.removeEventListener('scrollend', fin);
      cancelAnimationFrame(raf); clearTimeout(tmo);
      cb();
    }
    if ('onscrollend' in window) box.addEventListener('scrollend', fin);
    (function tick() {
      var v = box.scrollTop;
      if (Math.abs(v - last) < 0.5) still++; else { still = 0; last = v; }
      if (still >= 8) { fin(); return; }
      raf = requestAnimationFrame(tick);
    })();
    tmo = setTimeout(fin, 3000);
    return function cancel() { done = true; box.removeEventListener('scrollend', fin); cancelAnimationFrame(raf); clearTimeout(tmo); };
  }

  // 从板载资源 / 封装图跳过来：清空搜索，滚到位后再高亮（高亮从滚动结束开始计时，约 1.2s）
  var hitTimer = 0, hitWait = null;
  function locatePins(nums) {
    nums = (nums || []).filter(function (n) { return rowByPin[n]; });
    if (!nums.length) return;
    if (viewer.isOpen()) viewer.close(true);
    switchTab('pins');
    q.value = ''; filterPins('');
    pinRows.forEach(function (r) { r.row.classList.remove('hit'); });
    clearTimeout(hitTimer);
    if (hitWait) { hitWait(); hitWait = null; }
    requestAnimationFrame(function () {
      var first = rowByPin[nums[0]].row, pane = $('pane-pins');
      first.scrollIntoView({ block: 'center', behavior: reduced() ? 'auto' : 'smooth' });
      hitWait = afterScroll(pane, function () {
        hitWait = null;
        syncScrolled();
        nums.forEach(function (n) { rowByPin[n].row.classList.add('hit'); });
        hitTimer = setTimeout(function () { nums.forEach(function (n) { rowByPin[n].row.classList.remove('hit'); }); }, 1200);
      });
    });
  }

  /* 分类 chip 行：还能往右/往左横滑时，对应边缘加渐隐遮罩（.fade-r / .fade-l） */
  function chipFade(bar) {
    function upd() {
      var max = bar.scrollWidth - bar.clientWidth;
      bar.classList.toggle('fade-l', bar.scrollLeft > 2);
      bar.classList.toggle('fade-r', max > 2 && bar.scrollLeft < max - 2);
    }
    bar.addEventListener('scroll', upd, { passive: true });
    if (window.ResizeObserver) new ResizeObserver(upd).observe(bar); else window.addEventListener('resize', upd);
    requestAnimationFrame(upd);
    return upd;
  }

  // 点到半露在边缘的 chip：只在 chip 行内横向滚到完整可见（不动页面竖向滚动）
  function revealChip(bar, b) {
    var br = b.getBoundingClientRect(), pr = bar.getBoundingClientRect();
    var x0 = br.left - pr.left + bar.scrollLeft;
    var l = x0 - 16, r = x0 + br.width + 32 - bar.clientWidth, to = null;
    if (l < bar.scrollLeft) to = Math.max(0, l); else if (r > bar.scrollLeft) to = r;
    if (to == null) return;
    if (bar.scrollTo) bar.scrollTo({ left: to, behavior: reduced() ? 'auto' : 'smooth' }); else bar.scrollLeft = to;
  }

  /* ================= C 语法高亮（代码片段 / 勘误「正确写法」共用） =================
     单遍扫描，输出 DocumentFragment（span.hl-* + textContent，不拼 HTML）；颜色全在 CSS 变量里，切主题不用重绘。
     类别：com 注释 / str 字符串·字符 / num 数字 / pre 预处理 / kw 关键字 / type 类型 / mac 宏·常量 / fn 函数调用 */
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
  // 选中代码区文字复制：只给纯文本（不带高亮样式），NBSP → 普通空格
  document.addEventListener('copy', function (e) {
    var sel = window.getSelection ? window.getSelection() : null;
    if (!sel || sel.isCollapsed || !e.clipboardData) return;
    function inCode(nd) { nd = nd && (nd.nodeType === 1 ? nd : nd.parentNode); return !!(nd && nd.closest && nd.closest('.code')); }
    if (!inCode(sel.anchorNode) && !inCode(sel.focusNode)) return;
    try { e.clipboardData.setData('text/plain', plainCode(sel.toString())); e.preventDefault(); } catch (err) {}
  });
  // 复制按钮：写剪贴板（失败时选中 codeNode 走 execCommand，copy 事件里同样只给纯文本）
  function copyText(text, btn, codeNode) {
    var done = function () {
      btn.classList.add('done');
      clearTimeout(btn._t);
      btn._t = setTimeout(function () { btn.classList.remove('done'); }, 1400);
      toast('已复制');
    };
    var fallback = function () {
      var ok = false;
      try {
        var r = document.createRange(); r.selectNodeContents(codeNode);
        var sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
        ok = document.execCommand && document.execCommand('copy');
      } catch (e) { ok = false; }
      if (ok) done(); else toast('已选中');
    };
    if (navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext !== false) {
      navigator.clipboard.writeText(text).then(done, fallback);
    } else fallback();
  }
  function copyBtn(label) {
    var b = el('button', 'copy');
    b.type = 'button'; b.setAttribute('aria-label', label);
    var cp = icon(IC.copy); cp.setAttribute('class', 'cp');
    var ok = icon(IC.ok); ok.setAttribute('class', 'ok');
    b.appendChild(cp); b.appendChild(ok); b.appendChild(el('span', null, '复制'));
    return b;
  }

  /* ================= 2. 代码片段 ================= */

  var codeCat = '全部';
  function buildCode() {
    var cats = ['全部'];
    SNIPS.forEach(function (s) { if (cats.indexOf(s.cat) < 0) cats.push(s.cat); });
    var bar = $('codeCats'), list = $('codeList');
    cats.forEach(function (c) {
      var b = el('button', 'cat', c);
      b.type = 'button'; b.setAttribute('role', 'tab'); b.dataset.cat = c;
      b.setAttribute('aria-selected', c === codeCat ? 'true' : 'false');
      bar.appendChild(b);
    });
    pressable(bar, '.cat');
    chipFade(bar);
    bar.addEventListener('click', function (e) {
      var b = e.target.closest('.cat');
      if (!b || b.dataset.cat === codeCat) return;
      selectCat(b);
    });
    pressable(list, '.copy');
    list.addEventListener('click', function (e) {
      var b = e.target.closest('.copy');
      if (b) copySnippet(b);
    });
    renderCode();
  }
  // 选中分类 chip（手点与课件「代码」跳转共用）
  function selectCat(b) {
    var bar = $('codeCats');
    codeCat = b.dataset.cat;
    activeSnippet = ''; contextChanged();
    revealChip(bar, b);
    Array.prototype.forEach.call(bar.children, function (x) { x.setAttribute('aria-selected', x === b ? 'true' : 'false'); });
    renderCode();
    $('pane-code').scrollTop = 0; syncScrolled();
  }
  // 高亮结果按片段缓存：切分类 / 从课件跳过来都会整表重建，同一段代码不必每次重新扫描，克隆一份即可
  var snipHLCache = [];
  function snipHL(i) {
    if (!snipHLCache[i]) snipHLCache[i] = hlC(SNIPS[i].code);
    return snipHLCache[i].cloneNode(true);
  }
  function renderCode() {
    var list = $('codeList');
    while (list.firstChild) list.removeChild(list.firstChild);
    if (!SNIPS.length) { list.appendChild(emptyState(el('div', 'vstate'), '暂无')); return; }
    var lastCat = null;
    SNIPS.forEach(function (s, i) {
      if (codeCat !== '全部' && s.cat !== codeCat) return;
      if (codeCat === '全部' && s.cat !== lastCat) { list.appendChild(el('h3', 'cgroup-h', s.cat)); lastCat = s.cat; }
      var card = el('article', 'snip');
      var h = el('div', 'snip-h');
      h.appendChild(el('span', 'snip-t', s.title));
      var b = copyBtn('复制 ' + s.title);
      b.dataset.i = i;
      regsSnipBtn(h, s);                                   // HUB-T7
      h.appendChild(b);
      card.appendChild(h);
      card.appendChild(el('p', 'snip-scope', 'HAL · STM32F103ZET6 · 需合并到已初始化工程'));
      var usage = el('details', 'snip-usage');
      usage.appendChild(el('summary', null, '使用前先检查'));
      usage.appendChild(el('p', null, '按片段顶部注释完成 CubeMX 外设、引脚、时钟及 NVIC 配置，并生成工程。先执行 HAL_Init、SystemClock_Config 和对应 MX_*_Init，再调用示例。'));
      usage.appendChild(el('p', null, '头文件放 USER CODE Includes；函数和回调放 USER CODE 0；启动代码放初始化后的 USER CODE 2；循环逻辑合入 while (1)。同名回调应合并，每个函数只保留一个定义。'));
      card.appendChild(usage);
      var pre = el('pre', 'code'), code = el('code');
      code.appendChild(snipHL(i));
      pre.appendChild(code);
      card.appendChild(pre);
      list.appendChild(card);
    });
  }
  function copySnippet(btn) {
    var s = SNIPS[Number(btn.dataset.i)];
    if (!s) return;
    copyText(plainCode(s.code), btn, btn.closest('.snip').querySelector('code'));
  }

  /* ================= 3. 芯片 / 板子 ================= */

  // (0) 板载资源
  var GROUP_ORDER = ['LED', 'KEY', 'BEEP', '系统', '调试', '串口', 'USB', '存储', '显示', '通信', '传感', '模拟'];
  var ACT = { low: '低有效', high: '高有效', data: '数据线' };
  function buildBoard() {
    var box = $('boardRes');
    var res = BOARD ? BOARD.resources.filter(function (r) { return r && r.name; }) : [];
    if (!res.length) { box.appendChild(emptyState(el('div', 'vstate'), '暂无')); return; }
    var groups = GROUP_ORDER.slice();
    res.forEach(function (r) { if (groups.indexOf(r.group) < 0) groups.push(r.group); });
    groups.forEach(function (gname) {
      var items = res.filter(function (r) { return r.group === gname; });
      if (!items.length) return;
      box.appendChild(el('h4', 'bgroup-h', gname));
      items.forEach(function (r) {
        var nums = r.mcu ? pinList(r) : [];
        var row = el('div', 'brow');
        var main = el('button', 'bmain');
        main.type = 'button';
        main.appendChild(el('span', 'bname', r.name));
        if (r.mcu || nums.length) {
          var pin = el('span', 'bpin');
          if (r.mcu) pin.appendChild(el('b', null, r.mcu));
          if (nums.length) pin.appendChild(document.createTextNode((r.mcu ? ' · ' : '') + nums.join(',')));
          main.appendChild(pin);
        }
        if (ACT[r.active]) main.appendChild(el('span', 'bact a-' + r.active, ACT[r.active]));
        if (nums.length) { main.dataset.pins = nums.join(','); main.setAttribute('aria-label', r.name + ' ' + (r.mcu || '')); }
        else if (r.page) main.dataset.page = r.page;
        else main.disabled = true;
        row.appendChild(main);
        if (r.page) {
          var pg = el('button', 'bpage');
          pg.type = 'button'; pg.dataset.page = r.page; pg.setAttribute('aria-label', '原理图 ' + r.page);
          pg.appendChild(icon(IC.doc));
          row.appendChild(pg);
        }
        box.appendChild(row);
      });
    });
    pressable(box, '.bmain, .bpage', true);
    box.addEventListener('click', function (e) {
      var b = e.target.closest('.bmain, .bpage');
      if (!b || b.disabled) return;
      if (b.dataset.pins) locatePins(b.dataset.pins.split(',').map(Number));
      else if (b.dataset.page) openSchematicPage(b.dataset.page, b);
    });
  }

  // (a) LQFP144 封装图：按 pins.js 生成；1 脚左上角，逆时针（左边自上而下 → 底边自左向右 → 右边自下而上 → 顶边自右向左）
  var PK = { P: 10, B: 380, LEAD: 12, M: 72 };
  PK.S = PK.B + 2 * PK.M;
  var pkgZoom = null, pinPos = {}, pinG = {};
  var pkHl = null, pinMark = {}, markN = 0, markT = 0;   // [HUB-T10] 跳转定位高亮：焊盘下层的光晕 + 单圈扩散，见 markPin
  function buildPackage() {
    var view = $('pkg'), content = $('pkgContent');
    if (!PINS.length) { view.appendChild(emptyState(el('div', 'vstate vw-empty'), '暂无')); return; }
    var L = PK.M, B = PK.B, P = PK.P, LD = PK.LEAD, pad = (B - 36 * P) / 2;
    var s = sv('svg', { 'class': 'pk', viewBox: '0 0 ' + PK.S + ' ' + PK.S, role: 'img', 'aria-label': 'STM32F103ZET6 LQFP144' });
    s.appendChild(sv('rect', { 'class': 'pk-body', x: L, y: L, width: B, height: B, rx: 6 }));
    s.appendChild(sv('circle', { 'class': 'pk-dot', cx: L + 16, cy: L + 16, r: 4.5 }));
    s.appendChild(sv('text', { 'class': 'pk-name', x: L + B / 2, y: L + B / 2 - 4, 'text-anchor': 'middle' }, 'STM32F103ZET6'));
    s.appendChild(sv('text', { 'class': 'pk-sub', x: L + B / 2, y: L + B / 2 + 14, 'text-anchor': 'middle' }, 'LQFP144'));
    // 光晕用 SVG 滤镜（feGaussianBlur）：WebKit 不支持 SVG 子元素上的 CSS filter 函数
    var defs = s.appendChild(sv('defs'));
    var flt = defs.appendChild(sv('filter', { id: 'pk-glow-f', x: '-150%', y: '-150%', width: '400%', height: '400%' }));
    flt.appendChild(sv('feGaussianBlur', { stdDeviation: 2 }));
    pkHl = s.appendChild(sv('g', { 'class': 'pk-hl', 'aria-hidden': 'true' }));
    PINS.forEach(function (p) {
      var n = p[0], name = p[1], t = p[2], side, k, cx, cy;
      if (n <= 36) { side = 'L'; k = n - 1; cx = L; cy = L + pad + k * P + P / 2; }
      else if (n <= 72) { side = 'B'; k = n - 37; cx = L + pad + k * P + P / 2; cy = L + B; }
      else if (n <= 108) { side = 'R'; k = n - 73; cx = L + B; cy = L + B - pad - k * P - P / 2; }
      else { side = 'T'; k = n - 109; cx = L + B - pad - k * P - P / 2; cy = L; }
      var g = sv('g', { 'class': 'pk-pin t-' + t + (usedBy[n] ? ' used' : ''), 'data-pin': n, tabindex: 0, role: 'button', 'aria-label': n + ' ' + name + (usedBy[n] ? ' ' + usedBy[n].join(' ') : '') });
      var hw = 2.3, ld, hit, nm, no;
      if (side === 'L') {
        ld = { x: cx - LD, y: cy - hw, width: LD, height: hw * 2 };
        hit = { x: 0, y: cy - P / 2, width: L + 18, height: P };
        nm = { x: cx - LD - 2.5, y: cy, 'text-anchor': 'end' };
        no = { x: cx + 3, y: cy, 'text-anchor': 'start' };
      } else if (side === 'R') {
        ld = { x: cx, y: cy - hw, width: LD, height: hw * 2 };
        hit = { x: cx - 18, y: cy - P / 2, width: L + 18, height: P };
        nm = { x: cx + LD + 2.5, y: cy, 'text-anchor': 'start' };
        no = { x: cx - 3, y: cy, 'text-anchor': 'end' };
      } else if (side === 'B') {
        ld = { x: cx - hw, y: cy, width: hw * 2, height: LD };
        hit = { x: cx - P / 2, y: cy - 18, width: P, height: L + 18 };
        nm = { x: cx, y: cy + LD + 2.5, 'text-anchor': 'end', transform: 'rotate(-90 ' + cx + ' ' + (cy + LD + 2.5) + ')' };
        no = { x: cx, y: cy - 3, 'text-anchor': 'start', transform: 'rotate(-90 ' + cx + ' ' + (cy - 3) + ')' };
      } else {
        ld = { x: cx - hw, y: cy - LD, width: hw * 2, height: LD };
        hit = { x: cx - P / 2, y: 0, width: P, height: L + 18 };
        nm = { x: cx, y: cy - LD - 2.5, 'text-anchor': 'start', transform: 'rotate(-90 ' + cx + ' ' + (cy - LD - 2.5) + ')' };
        no = { x: cx, y: cy + 3, 'text-anchor': 'end', transform: 'rotate(-90 ' + cx + ' ' + (cy + 3) + ')' };
      }
      nm['dominant-baseline'] = 'central'; no['dominant-baseline'] = 'central';
      nm['class'] = 'nm'; no['class'] = 'no'; ld['class'] = 'ld'; hit['class'] = 'hit';
      g.appendChild(sv('rect', hit));
      g.appendChild(sv('rect', ld));
      g.appendChild(sv('text', nm, name));
      g.appendChild(sv('text', no, n));
      g.appendChild(sv('title', null, n + ' ' + name));
      s.appendChild(g);
      pinPos[n] = { x: cx, y: cy }; pinG[n] = g;
      pinMark[n] = {
        b: hit, ld: { x: ld.x, y: ld.y, w: ld.width, h: ld.height },
        px: side === 'L' ? cx - LD / 2 : side === 'R' ? cx + LD / 2 : cx,
        py: side === 'T' ? cy - LD / 2 : side === 'B' ? cy + LD / 2 : cy
      };
    });
    content.appendChild(s);
    pkgZoom = Zoomer(view, content, {
      max: 8, dbl: 3, wheelNeedsCtrl: true, wheelPans: true, scrollAtFit: true,
      onTap: function (target) {
        var g = target && target.closest ? target.closest('[data-pin]') : null;
        if (!g) return false;
        locatePins([Number(g.getAttribute('data-pin'))]);
        return true;
      }
    });
    pkgZoom.fit(PK.S, PK.S);
    // 键盘：Tab 逐脚聚焦，Enter / Space 跳到引脚速查；方向键在相邻脚位间移动（1→144 循环）
    s.addEventListener('keydown', function (e) {
      var g = e.target && e.target.closest ? e.target.closest('[data-pin]') : null;
      if (!g) return;
      var n = Number(g.getAttribute('data-pin'));
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') { e.preventDefault(); locatePins([n]); return; }
      var d = (e.key === 'ArrowRight' || e.key === 'ArrowDown') ? 1 : (e.key === 'ArrowLeft' || e.key === 'ArrowUp') ? -1 : 0;
      if (!d) return;
      e.preventDefault();
      var m = ((n - 1 + d + PINS.length) % PINS.length) + 1;
      if (pinG[m]) try { pinG[m].focus({ preventScroll: true }); } catch (err) { pinG[m].focus(); }
    });
    s.addEventListener('focusin', function (e) {
      var g = e.target && e.target.closest ? e.target.closest('[data-pin]') : null;
      if (g) { var n = Number(g.getAttribute('data-pin')); if (pinPos[n]) pkgZoom.reveal(pinPos[n].x, pinPos[n].y); }
    });
    var refit = function () { pkgZoom.fit(PK.S, PK.S); };
    if (window.ResizeObserver) new ResizeObserver(refit).observe(view); else window.addEventListener('resize', refit);
  }
  // 定位高亮：清掉上一次（计时器、类名、叠加图形）
  function clearPinMark() {
    clearTimeout(markT); markT = 0;
    if (markN && pinG[markN]) pinG[markN].classList.remove('mark');
    markN = 0;
    var svg = pkHl && pkHl.ownerSVGElement;
    if (svg) svg.classList.remove('spot');
    if (pkHl) while (pkHl.firstChild) pkHl.removeChild(pkHl.firstChild);
  }
  // [HUB-T10] 目标脚：焊盘填强调色 + 柔光 + 放大 1.15，信号名/脚号同色加粗；焊盘下方放一次单圈扩散；其余脚变淡。
  // 时间线全在 CSS 关键帧里（0–150ms 渐入、保持到 750ms、750–1000ms 淡出）；JS 只加类 + 1 个计时器在 1s 时清理。
  // 叠加图形都在 pk-hl（引脚层之下），不遮挡文字。减弱动效：CSS 去掉扩散与缩放，只留静态高亮再淡出。
  var MARK_MS = 1000;
  function markPin(n) {
    clearPinMark();
    var m = pinMark[n], g = pinG[n], svg = pkHl && pkHl.ownerSVGElement;
    if (!m || !g || !svg) return;
    void svg.getBoundingClientRect();   // 先让“去类”生效，同一帧重加时关键帧才会从头播放
    var d = m.ld, k = 1.2;
    pkHl.appendChild(sv('rect', { 'class': 'pk-glow', x: d.x - k, y: d.y - k, width: d.w + 2 * k, height: d.h + 2 * k, rx: 2, filter: 'url(#pk-glow-f)' }));
    pkHl.appendChild(sv('circle', { 'class': 'pk-wave', cx: m.px, cy: m.py, r: 4 }));
    g.classList.add('mark'); svg.classList.add('spot'); markN = n;
    markT = setTimeout(clearPinMark, MARK_MS);
  }
  // 引脚速查行 → 封装图上放大并高亮该脚（对准整行中心：焊盘、信号名、脚号都在视野内）
  // [HUB-T10] 高亮只有 1s，要等页面滚到封装图停下再开始（同 locatePins 的 afterScroll），否则大半被滚动吃掉
  var markWait = null;
  function showOnPackage(n) {
    if (!pinPos[n] || !pkgZoom) return;
    if (markWait) { markWait(); markWait = null; }
    clearPinMark();
    switchTab('chip'); packagePin = n; contextChanged();
    var view = $('pkg');
    requestAnimationFrame(function () {
      if (!pkgZoom.ready()) pkgZoom.fit(PK.S, PK.S);
      view.scrollIntoView({ block: 'center', behavior: reduced() ? 'auto' : 'smooth' });
      var b = pinMark[n] && pinMark[n].b;
      if (b) pkgZoom.focus(b.x + b.width / 2, b.y + b.height / 2, 3.2);
      else pkgZoom.focus(pinPos[n].x, pinPos[n].y, 3.2);
      if (markWait) markWait();
      markWait = afterScroll($('pane-chip'), function () { markWait = null; markPin(n); });
    });
  }

  // (b) 实物图 + 原理图
  function safePath(p) {
    p = String(p || '');
    if (!p || /^[a-z][a-z0-9+.-]*:/i.test(p) || p.charAt(0) === '/' || p.indexOf('..') > -1 || p.indexOf('\\') > -1) return '';
    return 'assets/' + p;
  }
  function pageIdOf(src) { return String(src || '').replace(/^.*\//, '').replace(/\.svg$/i, ''); }
  var SCH = (Array.isArray(ASSETS.schematic) ? ASSETS.schematic : []).filter(function (it) { return it && it.src; });
  var schGroup = null;
  function schGroups() {
    var gs = [];
    SCH.forEach(function (it) { var gname = it.group || ''; if (gs.indexOf(gname) < 0) gs.push(gname); });
    return gs;
  }
  function buildSchematic() {
    if (ASSETS.board && safePath(ASSETS.board)) {
      $('photoBlk').hidden = false;
      var img = el('img');
      img.alt = ''; img.loading = 'lazy'; img.decoding = 'async';
      img.addEventListener('error', function () { $('photoBlk').hidden = true; });
      img.src = safePath(ASSETS.board);
      $('photoBtn').appendChild(img);
      pressable($('photoBtn'));
      $('photoBtn').addEventListener('click', function () { viewer.open('board', 0, null, $('photoBtn')); });
    }
    var gs = schGroups(), bar = $('schGroups');
    schGroup = gs[0] || null;
    if (gs.length > 1) {
      gs.forEach(function (gname) {
        var b = el('button', 'cat', gname || '—');
        b.type = 'button'; b.setAttribute('role', 'tab'); b.dataset.g = gname;
        b.setAttribute('aria-selected', gname === schGroup ? 'true' : 'false');
        bar.appendChild(b);
      });
      pressable(bar, '.cat');
      chipFade(bar);
      bar.addEventListener('click', function (e) {
        var b = e.target.closest('.cat');
        if (!b || b.dataset.g === schGroup) return;
        schGroup = b.dataset.g;
        revealChip(bar, b);
        Array.prototype.forEach.call(bar.children, function (x) { x.setAttribute('aria-selected', x === b ? 'true' : 'false'); });
        renderSchList();
      });
    }
    var list = $('schList');
    pressable(list, '.drow', true);
    list.addEventListener('click', function (e) {
      var r = e.target.closest('.drow');
      if (r) viewer.open('sch', Number(r.dataset.i), null, r);
    });
    renderSchList();
  }
  function renderSchList() {
    var list = $('schList');
    while (list.firstChild) list.removeChild(list.firstChild);
    if (!SCH.length) { list.appendChild(emptyState(el('div', 'vstate'), '暂无')); return; }
    SCH.forEach(function (it, i) {
      if ((it.group || '') !== (schGroup || '')) return;
      list.appendChild(docRow(i, '', it.title || pageIdOf(it.src), ''));
    });
  }
  function docRow(i, label, title, page) {
    var r = el('button', 'drow');
    r.type = 'button'; r.dataset.i = i;
    if (label) r.appendChild(el('span', 'dlabel', label));
    r.appendChild(el('span', 'dtitle', title));
    if (page) r.appendChild(el('span', 'dpage', page));
    var c = icon(IC.chev); c.setAttribute('class', 'chev'); r.appendChild(c);
    return r;
  }
  function openSchematicPage(id, trigger) {
    var idx = -1;
    SCH.forEach(function (it, i) { if (idx < 0 && pageIdOf(it.src) === id) idx = i; });
    viewer.open('sch', idx, id, trigger);
  }

  /* ================= 4. 架构图 ================= */

  /* 两个分区：手册（RM0008 矢量图，manual.js）/ 教学（课件 PPT 框图位图，teach-arch.js，可缺省）。
     各分区按 FIG_GROUPS 顺序分组列出；查看器里的翻页顺序 = 列表顺序，只在当前分区内翻 */
  var FIG_GROUPS = ['系统架构', '电源复位时钟', 'GPIO', '中断', '定时器', '通信', 'SPI', 'I2C', 'DMA', '模拟', '其他'];
  var FIGK_KEY = 'lm.stm32.figkind';
  function figOk(f) { return !!(f && (f.src || f.fallback || f.hd)); }
  function byGroups(list) {
    var groups = FIG_GROUPS.slice(), out = [];
    list.forEach(function (f) { var g = f.group || '其他'; if (groups.indexOf(g) < 0) groups.push(g); });
    groups.forEach(function (g) { list.forEach(function (f) { if ((f.group || '其他') === g) out.push(f); }); });
    return out;
  }
  var FIGL = byGroups(FIGS.filter(figOk));
  var TEACHL = byGroups(TEACH.filter(figOk));
  var figKind = lsGet(FIGK_KEY) === 'teach' && TEACHL.length ? 'teach' : 'manual';
  var figKindBtns = [];
  function figIndex(list, id) {
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return i;
    return -1;
  }
  function fillFigList(box, list, teach) {
    if (!list.length) { box.appendChild(emptyState(el('div', 'vstate'), '暂无')); return; }
    var last = null;
    list.forEach(function (f, i) {
      var g = f.group || '其他';
      if (g !== last) { box.appendChild(el('h3', 'dgroup-h', g)); last = g; }
      box.appendChild(docRow(i, f.label || '', f.title || f.id || '', !teach && f.page != null ? 'p.' + f.page : ''));
    });
    pressable(box, '.drow', true);
    box.addEventListener('click', function (e) {
      var r = e.target.closest('.drow');
      if (r) viewer.open(teach ? 'teach' : 'fig', Number(r.dataset.i), null, r);
    });
  }
  // 切分区：指示条滑过去（CSS transform），列表淡入；记住选择
  function setFigKind(k, save) {
    if (k === 'teach' && !TEACHL.length) k = 'manual';
    var changed = k !== figKind;
    figKind = k;
    var bar = $('figKind'), man = $('figList'), tea = $('teachList');
    if (bar) bar.setAttribute('data-k', k);
    figKindBtns.forEach(function (b) {
      var on = b.dataset.kind === k;
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
    });
    if (man) man.hidden = k !== 'manual';
    if (tea) tea.hidden = k !== 'teach';
    if (changed) {
      var shown = k === 'teach' ? tea : man;
      if (shown) { shown.classList.remove('swap'); void shown.offsetWidth; shown.classList.add('swap'); }
      var pane = $('pane-arch');
      if (pane) { pane.scrollTop = 0; if (curTab === 'arch') syncScrolled(); }
    }
    if (save) lsSet(FIGK_KEY, k);
  }
  function buildFigs() {
    var man = $('figList'), tea = $('teachList'), bar = $('figKind');
    fillFigList(man, FIGL, false);
    if (tea && TEACHL.length) fillFigList(tea, TEACHL, true);
    if (bar && TEACHL.length) {
      bar.hidden = false;
      figKindBtns = Array.prototype.slice.call(bar.querySelectorAll('[data-kind]'));
      pressable(bar, '[data-kind]');
      bar.addEventListener('click', function (e) {
        var b = e.target.closest('[data-kind]');
        if (b && b.dataset.kind !== figKind) setFigKind(b.dataset.kind, true);
      });
      bar.addEventListener('keydown', function (e) {
        rovingKeys(figKindBtns, e, function (b) { if (b.dataset.kind !== figKind) setFigKind(b.dataset.kind, true); });
      });
      requestAnimationFrame(function () { bar.classList.add('ready'); });
    }
    setFigKind(figKind, false);
  }

  /* ================= 5. 课件（courseware.js：分页 WebP + 章节目录） ================= */

  var CW_W = 1191, CW_H = 1684, CW_KEY = 'lm.stm32.cw';
  // 相对 /tools/stm32/ 的课件图路径：只接受 assets/courseware/ 下的相对路径
  function cwSafe(p) {
    p = String(p || '');
    if (!/^assets\/courseware\//.test(p) || /^[a-z][a-z0-9+.-]*:/i.test(p) || p.indexOf('..') > -1 || p.indexOf('\\') > -1) return '';
    return p;
  }
  function cwShort(part, i) {
    var t = String(part.title || '');
    if (/[（(]上[）)]/.test(t)) return '上册';
    if (/[（(]下[）)]/.test(t)) return '下册';
    return i === 0 ? '上册' : i === 1 ? '下册' : String(part.id || '');
  }
  // 每册：页数、目录（含页范围 start/end，0 起）、每页所属最深一级目录标题
  var CWP = (CW ? CW.parts : []).filter(function (pt) {
    return pt && pt.id != null && Array.isArray(pt.pages) && pt.pages.length;
  }).map(function (pt, pi) {
    var n = pt.pages.length;
    var chs = (Array.isArray(pt.chapters) ? pt.chapters : []).filter(function (c) {
      return c && c.title != null && Number.isInteger(c.pageIndex) && c.pageIndex >= 0 && c.pageIndex < n;
    }).map(function (c) {
      return { c: c, title: String(c.title), level: Number(c.level) === 2 ? 2 : (Number(c.level) || 1), start: c.pageIndex, end: n - 1 };
    });
    chs.forEach(function (x, k) {
      for (var m = k + 1; m < chs.length; m++) if (chs[m].level <= x.level) { x.end = Math.max(x.start, chs[m].start - 1); break; }
    });
    var titles = [];
    for (var j = 0; j < n; j++) {
      var best = null;
      chs.forEach(function (x) { if (x.start <= j && j <= x.end && (!best || x.level >= best.level)) best = x; });
      titles.push(best ? best.title : String(pt.title || ''));
    }
    return { id: String(pt.id), short: cwShort(pt, pi), title: String(pt.title || ''), pages: pt.pages, n: n, chs: chs, titles: titles };
  });
  /* 勘误（errata.js，可缺省）：按 册 id → 页号（从 1 起）建索引；also 里另一册的页也挂上；all:true 的全书条目单列 */
  var SEV_RANK = { err: 3, warn: 2, fmt: 1 };
  var SEV_WORD = { err: '错误', warn: '可疑', fmt: '排版' };
  var erIdx = {}, erAll = [];
  if (ERR) ERR.items.forEach(function (it, order) {
    if (!it || typeof it !== 'object') return;
    var rec = {
      sev: SEV_RANK[it.sev] ? String(it.sev) : 'fmt', order: order,
      pageText: it.pageText != null ? String(it.pageText) : '', issue: it.issue != null ? String(it.issue) : '',
      original: it.original != null ? String(it.original) : '', fix: it.fix != null ? String(it.fix) : ''
    };
    if (it.all) { erAll.push(rec); return; }
    function hang(part, pages) {
      if (part == null || !Array.isArray(pages)) return;
      var m = erIdx[String(part)] || (erIdx[String(part)] = {});
      pages.forEach(function (n) {
        n = Number(n);
        if (!Number.isInteger(n) || n < 1) return;
        var l = m[n] || (m[n] = []);
        if (l.indexOf(rec) < 0) l.push(rec);
      });
    }
    hang(it.part, it.pages);
    if (Array.isArray(it.also)) it.also.forEach(function (a) { if (a) hang(a.part, a.pages); });
  });
  Object.keys(erIdx).forEach(function (pid) {
    Object.keys(erIdx[pid]).forEach(function (n) {
      erIdx[pid][n].sort(function (a, b) { return (SEV_RANK[b.sev] - SEV_RANK[a.sev]) || (a.order - b.order); });
    });
  });
  function erFor(pid, num) { var m = erIdx[pid]; return (m && m[num]) || []; }
  // 某册 [from, to]（页号从 1 起）范围内最高档：'err' | 'warn' | 'fmt' | ''
  function erTop(pid, from, to) {
    var m = erIdx[pid], best = 0;
    if (!m) return '';
    for (var n = from; n <= to; n++) if (m[n]) m[n].forEach(function (r) { if (SEV_RANK[r.sev] > best) best = SEV_RANK[r.sev]; });
    return best === 3 ? 'err' : best === 2 ? 'warn' : best === 1 ? 'fmt' : '';
  }

  function cwPartIdx(id) {
    for (var i = 0; i < CWP.length; i++) if (CWP[i].id === id) return i;
    return -1;
  }
  function cwLoad() {
    try { var o = JSON.parse(lsGet(CW_KEY) || '{}'); return o && typeof o === 'object' && !Array.isArray(o) ? o : {}; } catch (e) { return {}; }
  }
  // 记住阅读位置：{"v20":页号,"v21":页号}（页号从 1 起，与 ?cw=v20-16 一致）
  function cwSave(id, num) {
    var o = cwLoad();
    if (o[id] === num) return;
    o[id] = num;
    lsSet(CW_KEY, JSON.stringify(o));
    cwSync();
  }
  var cwConts = {};         // 册 id -> 「继续 p.N」按钮
  function cwSync() {
    var o = cwLoad();
    CWP.forEach(function (pt) {
      var b = cwConts[pt.id];
      if (!b) return;
      var num = Number(o[pt.id]);
      var ok = Number.isInteger(num) && num >= 1 && num <= pt.n;
      b.hidden = !ok;
      if (ok) {
        b.dataset.n = String(num);
        b.firstChild.textContent = '继续 p.' + num;
        b.setAttribute('aria-label', pt.short + ' 继续 p.' + num);
      }
    });
  }
  function cwTag(cls, word, label) {
    var b = el('button', 'cw-act ' + cls);
    b.type = 'button';
    if (label) b.setAttribute('aria-label', label);
    b.appendChild(el('span', 'cw-tag', word));
    return b;
  }
  function buildCourse() {
    var box = $('cwList');
    if (!box) return;
    if (!CWP.length) { box.appendChild(emptyState(el('div', 'vstate'), '暂无')); return; }
    CWP.forEach(function (pt, pi) {
      var gh = el('div', 'cw-gh');
      gh.appendChild(el('h3', 'dgroup-h', pt.short));
      var cont = el('button', 'cw-cont');
      cont.type = 'button'; cont.dataset.p = pi; cont.hidden = true;
      cont.appendChild(el('span', 'cw-tag', ''));
      gh.appendChild(cont);
      cwConts[pt.id] = cont;
      box.appendChild(gh);
      pt.chs.forEach(function (x, k) {
        var row = el('div', 'cw-row lv-' + (x.level >= 2 ? 2 : 1));
        var main = el('button', 'drow cw-main');
        main.type = 'button'; main.dataset.p = pi; main.dataset.k = k;
        main.appendChild(el('span', 'dtitle', x.title));
        main.appendChild(el('span', 'dpage', 'p.' + (x.start + 1) + (x.end > x.start ? '–' + (x.end + 1) : '')));
        var erS = erTop(pt.id, x.start + 1, x.end + 1);
        if (erS) {
          var dot = el('span', 'cw-dot sev-' + erS);
          dot.setAttribute('role', 'img'); dot.setAttribute('aria-label', '含勘误');
          main.appendChild(dot);
        }
        row.appendChild(main);
        var c = x.c;
        if (c.snippetCat) { var bc = cwTag('cw-code', '代码', '代码 ' + x.title); bc.dataset.p = pi; bc.dataset.k = k; row.appendChild(bc); }
        if (c.pinQuery) { var bp = cwTag('cw-pin', '引脚', '引脚 ' + x.title); bp.dataset.p = pi; bp.dataset.k = k; row.appendChild(bp); }
        if (figTargets(c).length) { var bf = cwTag('cw-fig', '架构图', '架构图 ' + x.title); bf.dataset.p = pi; bf.dataset.k = k; row.appendChild(bf); }
        regsCwTag(row, x);                                 // HUB-T7
        box.appendChild(row);
      });
    });
    cwSync();
    pressable(box, '.cw-main, .cw-act, .cw-cont', true);
    box.addEventListener('click', function (e) {
      var b = e.target.closest('.cw-main, .cw-act, .cw-cont');
      if (!b || !box.contains(b)) return;
      var pt = CWP[Number(b.dataset.p)];
      if (!pt) return;
      if (b.classList.contains('cw-cont')) { viewer.openCourse(Number(b.dataset.p), Number(b.dataset.n) - 1, b); return; }
      var x = pt.chs[Number(b.dataset.k)];
      if (!x) return;
      if (b.classList.contains('cw-main')) viewer.openCourse(Number(b.dataset.p), x.start, b);
      else if (b.classList.contains('cw-code')) gotoCode(String(x.c.snippetCat), x.c.snippetTitle != null ? String(x.c.snippetTitle) : '');
      else if (b.classList.contains('cw-pin')) gotoPins(String(x.c.pinQuery));
      else if (b.classList.contains('cw-fig')) gotoFig(figTargets(x.c), b);
    });
  }

  // 课件 →「代码」：切到代码片段、选中分类（与手点 chip 一致），有标题时滚到那张卡片并短暂高亮（滚动停下后计时）
  var snipTimer = 0, snipWait = null, snipHit = null;
  function gotoCode(cat, title) {
    if (viewer.isOpen()) viewer.close(true);
    clearTimeout(snipTimer);
    if (snipWait) { snipWait(); snipWait = null; }
    if (snipHit) { snipHit.classList.remove('hit'); snipHit = null; }
    switchTab('code');
    var bar = $('codeCats'), b = null;
    Array.prototype.forEach.call(bar.children, function (x) { if (!b && x.dataset.cat === cat) b = x; });
    requestAnimationFrame(function () {
      if (b) { if (b.dataset.cat !== codeCat) selectCat(b); else revealChip(bar, b); }
      activeSnippet = title || ''; contextChanged();
      if (!title) return;
      var card = null;
      Array.prototype.forEach.call($('codeList').querySelectorAll('.copy'), function (c) {
        var s = SNIPS[Number(c.dataset.i)];
        if (!card && s && s.title === title && (!b || s.cat === cat)) card = c.closest('.snip');
      });
      if (!card) return;
      var pane = $('pane-code');
      card.scrollIntoView({ block: 'start', behavior: reduced() ? 'auto' : 'smooth' });
      snipWait = afterScroll(pane, function () {
        snipWait = null;
        syncScrolled();
        snipHit = card;
        card.classList.add('hit');
        snipTimer = setTimeout(function () { card.classList.remove('hit'); if (snipHit === card) snipHit = null; }, 1200);
      });
    });
  }
  // 课件 →「引脚」：检索串直接写进搜索框
  function gotoPins(query) {
    if (viewer.isOpen()) viewer.close(true);
    clearTimeout(hitTimer);
    if (hitWait) { hitWait(); hitWait = null; }
    pinRows.forEach(function (r) { r.row.classList.remove('hit'); });
    switchTab('pins');
    q.value = query;
    filterPins(query);
    $('pane-pins').scrollTop = 0; syncScrolled();
  }
  // 章节「架构图」的候选：teach[0] 优先（教学图已加载且存在），其次 figs[0]
  function figTargets(c) {
    var out = [];
    if (Array.isArray(c.teach) && c.teach.length && figIndex(TEACHL, String(c.teach[0])) > -1) out.push(String(c.teach[0]));
    if (Array.isArray(c.figs) && c.figs.length && figIndex(FIGL, String(c.figs[0])) > -1) out.push(String(c.figs[0]));
    return out;
  }
  // 课件 →「架构图」：按 id 同时查教学 / 手册，先把架构图分区切到那张所在的分区再打开；都找不到就切到架构图 tab
  function gotoFig(ids, trigger) {
    ids = Array.isArray(ids) ? ids : [ids];
    for (var k = 0; k < ids.length; k++) {
      var id = String(ids[k]), ti = figIndex(TEACHL, id), mi = ti < 0 ? figIndex(FIGL, id) : -1;
      if (ti > -1) { setFigKind('teach', true); viewer.open('teach', ti, null, trigger); return; }
      if (mi > -1) { setFigKind('manual', true); viewer.open('fig', mi, null, trigger); return; }
    }
    switchTab('arch');
  }

  /* ================= 查看器（原理图 / 实物图 / 架构图 / 课件共用一套） ================= */

  var viewer = (function () {
    var root = $('viewer'), stage = $('vwStage'), content = $('vwContent');
    var load = $('vwLoad'), empty = $('vwEmpty'), app = $('app'), vtop = root.querySelector('.vw-top');
    var zoom = Zoomer(stage, content, {
      max: 8, dbl: 2, wheelPans: true, wheelZoom: true,     // 查看器：滚轮（含放大后）始终缩放，平移靠拖动
      onZoom: function (v) { setZoomPct(v); },
      // 原始比例下左右快速滑动翻页
      onSwipe: function (dir) {
        if (!open || dOpen) return false;
        var j = idx + dir;
        if (j < 0 || j >= items.length) return false;
        show(j);
        return true;
      }
    });
    var mode = null, items = [], idx = 0, token = 0, open = false, pushed = false, lastFocus = null, failed = false;
    var cwPart = null;                  // 课件模式：当前这一册（CWP 里的一项）

    // 对话框语义（index.html 里没有也补上）
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    if ($('vwTitle')) root.setAttribute('aria-labelledby', 'vwTitle');
    if (!root.hasAttribute('tabindex')) root.setAttribute('tabindex', '-1');
    var useInert = !!app && !app.contains(root) && 'inert' in app;

    // 缩放百分比提示：顶栏 vwCount 旁的小按钮，点击回 100%
    var zBtn = el('button', 'vw-zoom fit', '100%'), zPct = 100;
    zBtn.type = 'button';
    zBtn.setAttribute('aria-label', '缩放 100%，点击重置');
    (function () {
      var c = $('vwCount');
      if (c && c.parentNode) c.parentNode.insertBefore(zBtn, c.nextSibling);
      else if (vtop) vtop.appendChild(zBtn);
    })();
    zBtn.addEventListener('click', function () { if (zoom.ready()) zoom.reset(); });
    function setZoomPct(v) {
      if (!zBtn) return;
      var p = Math.round(v * 100);
      if (p === zPct) return;
      zPct = p;
      zBtn.textContent = p + '%';
      zBtn.setAttribute('aria-label', '缩放 ' + p + '%，点击重置');
      zBtn.classList.toggle('fit', p === 100);
    }

    /* ---- 勘误角标 + 抽屉（查看器之上的一层；errata.js 缺失时不建） ---- */
    var badge = null, mask = null, sheet = null, erList = null, erHead = null, erClose = null;
    var dOpen = false, dPushed = false, erCur = [];
    if (ERR) {
      badge = el('button', 'er-badge');
      badge.type = 'button'; badge.tabIndex = -1;
      badge.appendChild(el('span', 'er-dot'));
      badge.appendChild(el('span', 'er-bt', ''));
      root.appendChild(badge);
      mask = el('div', 'er-mask');
      mask.setAttribute('aria-hidden', 'true');
      root.appendChild(mask);
      sheet = el('div', 'er-sheet');
      sheet.setAttribute('role', 'dialog'); sheet.setAttribute('aria-modal', 'true');
      sheet.setAttribute('aria-labelledby', 'erTitle'); sheet.setAttribute('aria-hidden', 'true');
      sheet.tabIndex = -1;
      var hd = el('div', 'er-h');
      erHead = el('h2', 'er-title'); erHead.id = 'erTitle';
      hd.appendChild(erHead);
      erClose = el('button', 'icon-btn er-x');
      erClose.type = 'button'; erClose.setAttribute('aria-label', '关闭');
      erClose.appendChild(icon(['M6.5 6.5l11 11M17.5 6.5l-11 11']));
      hd.appendChild(erClose);
      sheet.appendChild(hd);
      erList = el('div', 'er-body');
      sheet.appendChild(erList);
      root.appendChild(sheet);
      pressable(badge);
      pressable(hd, '.icon-btn');
      pressable(erList, '.copy');
      badge.addEventListener('click', function () { if (open && mode === 'course' && erCur.length) openDrawer(); });
      mask.addEventListener('click', function () { closeDrawer(false); });
      erClose.addEventListener('click', function () { closeDrawer(false); });
      erList.addEventListener('click', function (e) {
        var b = e.target.closest('.copy');
        if (!b) return;
        var r = b._rec;
        if (r) copyText(plainCode(r.fix), b, b.closest('.er-fix').querySelector('code'));
      });
    }
    function setBadge(list) {
      if (!badge) return;
      erCur = list || [];
      var on = erCur.length > 0;
      if (on) {
        var top = erCur[0].sev;                       // 已按档位排序：第一条就是最高档
        badge.className = 'er-badge on sev-' + top;
        badge.lastChild.textContent = '勘误 ' + erCur.length;
        badge.setAttribute('aria-label', '勘误 ' + erCur.length);
        badge.tabIndex = 0;
      } else {
        badge.classList.remove('on');
        badge.tabIndex = -1;
      }
    }
    function erItem(r) {
      var a = el('article', 'er-item');
      var h = el('div', 'er-ih');
      h.appendChild(el('span', 'er-sev sev-' + r.sev, SEV_WORD[r.sev]));
      if (r.pageText) h.appendChild(el('span', 'er-pg', /^[0-9]/.test(r.pageText) ? 'p.' + r.pageText : r.pageText));
      a.appendChild(h);
      if (r.issue) a.appendChild(el('p', 'er-issue', r.issue));
      if (r.original) {
        a.appendChild(el('div', 'er-k', '原文'));
        var po = el('pre', 'code er-orig');
        po.appendChild(el('code', null, r.original));
        a.appendChild(po);
      }
      if (r.fix) {
        var box = el('div', 'er-fix');
        var fh = el('div', 'er-fh');
        fh.appendChild(el('span', 'er-k', '正确写法'));
        var cb = copyBtn('复制 正确写法');
        cb._rec = r;
        fh.appendChild(cb);
        box.appendChild(fh);
        var pf = el('pre', 'code'), cf = el('code');
        cf.appendChild(hlC(r.fix));
        pf.appendChild(cf);
        box.appendChild(pf);
        a.appendChild(box);
      }
      return a;
    }
    function fillDrawer() {
      while (erList.firstChild) erList.removeChild(erList.firstChild);
      while (erHead.firstChild) erHead.removeChild(erHead.firstChild);
      erHead.appendChild(el('span', null, '勘误 ' + erCur.length));
      erHead.appendChild(el('span', 'er-at', (cwPart ? cwPart.short + ' ' : '') + 'p.' + (idx + 1)));
      if (ERR.notice) erList.appendChild(el('p', 'er-note', '复制课件代码：缩进里的不间断空格（U+00A0）会让编译报 stray \'\\302\'，粘贴后替换成普通空格。'));
      erCur.forEach(function (r) { erList.appendChild(erItem(r)); });
      if (erAll.length) {
        erList.appendChild(el('h3', 'dgroup-h er-gh', '全书'));
        erAll.forEach(function (r) { erList.appendChild(erItem(r)); });
      }
      erList.scrollTop = 0;
    }
    function setLayerInert(on) {
      [vtop, stage, badge].forEach(function (n) {
        if (!n) return;
        if ('inert' in n) n.inert = on;
        if (on) n.setAttribute('aria-hidden', 'true'); else n.removeAttribute('aria-hidden');
      });
    }
    function openDrawer() {
      if (!sheet || dOpen || !open) return;
      dOpen = true;
      fillDrawer();
      root.classList.add('er-open');
      sheet.setAttribute('aria-hidden', 'false');
      setLayerInert(true);
      notifyDepth(2);
      if (!embedded && pushed && !hInFlight) pushH(2);
      focusIn();                                        // 轮询到 erClose 真正可聚焦为止（见 focusIn）
    }
    // silent：查看器整体关闭时顺带收起（历史 / depth / 焦点交给 closeV）
    function closeDrawer(fromHistory, silent, noFocus) {
      if (!dOpen) return;
      dOpen = false;
      focusStop();
      root.classList.remove('er-open');
      sheet.setAttribute('aria-hidden', 'true');
      setLayerInert(false);
      if (silent) { dPushed = false; return; }
      notifyDepth(1);
      if (dPushed && !fromHistory) { dPushed = false; goBack(1); }
      dPushed = false;
      if (noFocus) return;
      var t = badge && badge.classList.contains('on') ? badge : null;
      if (t) try { t.focus({ preventScroll: true }); } catch (e) { t.focus(); }
      else focusIn();
    }

    function itemsFor(m) {
      if (m === 'board') return [{ title: '实物图', cands: [safePath(ASSETS.board)] }];
      if (m === 'sch') return SCH.map(function (it) {
        return { title: it.title || pageIdOf(it.src), label: '', cands: [safePath(it.src), safePath(it.fallback)], w: it.width, h: it.height };
      });
      if (m === 'fig') return FIGL.map(function (f) {
        return { title: f.title || f.id || '', label: f.label || '', page: f.page, cands: [safePath(f.src), safePath(f.fallback), safePath(f.hd)], w: f.width, h: f.height };
      });
      // 教学框图：大位图，src → fallback（.sm.png）；不显示页码
      if (m === 'teach') return TEACHL.map(function (f) {
        return { title: f.title || f.id || '', label: f.label || '', cands: [safePath(f.src), safePath(f.fallback)], w: f.width, h: f.height };
      });
      if (m === 'course' && cwPart) return cwPart.pages.map(function (pg, j) {
        return { title: cwPart.titles[j] || '', label: cwPart.short, cands: [cwSafe(pg && pg.src)], w: CW_W, h: CW_H };
      });
      return [];
    }
    function clearStage() {
      dropPool();
      dropImgs();
      content.classList.remove('shown', 'wait');
      zoom.clear();
      load.hidden = true;
      root.classList.add('zero');
    }
    // 移除舞台上的图；还在下载的大图顺手取消请求
    function dropImgs() {
      Array.prototype.forEach.call(content.querySelectorAll('img'), function (im) {
        if (!im.complete && !im._st) try { im.removeAttribute('src'); } catch (e) {}
      });
      while (content.firstChild) content.removeChild(content.firstChild);
    }
    // 没有这张图（数据里没配 / 深链页号不存在）
    function setEmpty() {
      failed = false;
      clearStage();
      emptyState(empty, '无图');
    }
    // 配了图但全部候选都加载失败（离线 / 404）：可点击重试
    function setFailed() {
      failed = true;
      clearStage();
      while (empty.firstChild) empty.removeChild(empty.firstChild);
      var b = el('button', 'vw-retry');
      b.type = 'button';
      b.appendChild(icon(IC.retry));
      b.appendChild(el('span', null, '加载失败，点此重试'));
      b.addEventListener('click', function () { show(idx, null, true); });
      pressable(b);
      empty.appendChild(b);
      empty.hidden = false;
      // 焦点停在对话框本身（没有可聚焦的按钮）时，移到重试按钮上，键盘 Enter 即可重试
      if (open && !dOpen && document.activeElement === root) try { b.focus({ preventScroll: true }); } catch (e) {}
    }
    function bust(u, on) { return on ? u + (u.indexOf('?') > -1 ? '&' : '?') + 'r=' + Date.now() : u; }
    function show(i, missingTitle, retry) {
      if (dOpen && i !== idx) closeDrawer(false);      // 翻页时抽屉开着：先关
      var my = ++token;
      var hadImg = !!content.querySelector('img');
      var dir = hadImg && i !== idx ? (i > idx ? 1 : -1) : 0;
      failed = false;
      empty.hidden = true; root.classList.remove('zero');
      var it = items[i];
      $('vwPrev').disabled = !it || i <= 0;
      $('vwNext').disabled = !it || i >= items.length - 1;
      if (!it) {
        $('vwLabel').textContent = '';
        $('vwTitle').textContent = missingTitle || '';
        $('vwTitle').title = missingTitle || '';
        $('vwCount').textContent = '';
        setBadge(null);
        setEmpty();
        return;
      }
      idx = i; contextChanged();
      var full = (it.title || '') + (it.page != null ? '  p.' + it.page : '');
      $('vwLabel').textContent = it.label || '';
      $('vwTitle').textContent = full;
      $('vwTitle').title = full;
      $('vwCount').textContent = items.length > 1 ? (i + 1) + '/' + items.length : '';
      setBadge(mode === 'course' && cwPart ? erFor(cwPart.id, i + 1) : null);
      if (mode === 'course') { showPage(i, my, retry, dir); return; }
      // 只保留当前页：移除上一张图（释放内存），再加载这一张
      dropImgs();
      content.classList.remove('shown');
      var w = Number(it.w) || 0, h = Number(it.h) || 0;
      if (w && h) zoom.fit(w, h); else zoom.clear();
      load.hidden = false;
      var cands = it.cands.filter(Boolean), c = 0;
      if (!cands.length) { setEmpty(); return; }
      var img = el('img');
      img.alt = it.title || ''; img.decoding = 'async'; img.draggable = false;
      img.addEventListener('load', function () {
        if (my !== token) return;
        var nw = w || img.naturalWidth || 1414, nh = h || img.naturalHeight || 1000;
        load.hidden = true;
        zoom.fit(nw, nh);
        content.classList.add('shown');
      });
      img.addEventListener('error', function () {
        if (my !== token) return;
        c++;
        if (c < cands.length) img.src = bust(cands[c], retry); else setFailed();
      });
      content.appendChild(img);
      img.src = bust(cands[0], retry);
    }

    /* ---- 课件页：池里最多 3 张（当前 ±1，new Image() 加载）；DOM 里只放当前一张 ----
       新页加载 + decode 完成前，上一页留在原处（缩放已复位），稍慢时调暗 + spinner；就绪后整张替换，淡入 + 轻微横移；
       翻页 token 变了的回调一律忽略，离开 ±1 范围的未完成请求直接取消 */
    var pool = {}, dimT = 0;
    function abortImg(im) {
      im._cb = null; im.onload = im.onerror = null;
      if (im._st === 'loading') try { im.removeAttribute('src'); } catch (e) {}
    }
    function dropPool(keep) {
      for (var k in pool) if (Object.prototype.hasOwnProperty.call(pool, k) && !(keep && keep[k])) { abortImg(pool[k]); delete pool[k]; }
    }
    function poolImg(i, retry) {
      var it = items[i], src = it && it.cands[0];
      if (!src) return null;
      var im = pool[i];
      if (im && (im._st === 'err' || retry)) { abortImg(im); delete pool[i]; im = null; }
      if (!im) {
        im = new Image();
        im.decoding = 'async'; im.draggable = false; im.alt = it.title || '';
        im._st = 'loading'; im._cb = null;
        im.onload = function () { im._st = 'ok'; if (im._cb) im._cb(true); };
        im.onerror = function () { im._st = 'err'; if (im._cb) im._cb(false); };
        pool[i] = im;
        im.src = bust(src, retry);
      }
      return im;
    }
    function prefetch(i) {
      if (i - 1 >= 0) poolImg(i - 1);
      if (i + 1 < items.length) poolImg(i + 1);
    }
    function showPage(i, my, retry, dir) {
      var keep = {}; keep[i - 1] = keep[i] = keep[i + 1] = true;
      dropPool(keep);
      if (cwPart) cwSave(cwPart.id, i + 1);
      clearTimeout(dimT);
      var old = content.querySelector('img');
      zoom.fit(CW_W, CW_H);                         // 翻页即复位到适配（上一页暂留时也一样）
      if (!old) content.classList.remove('shown', 'wait');
      load.hidden = false;
      var im = poolImg(i, retry);
      if (!im) { setEmpty(); return; }
      if (old) dimT = setTimeout(function () { if (my === token) content.classList.add('wait'); }, 140);
      var done = function (ok) {
        if (my !== token) return;
        im._cb = null;
        if (!ok) { clearTimeout(dimT); setFailed(); return; }
        var dec = null;
        try { dec = im.decode ? im.decode() : null; } catch (e) { dec = null; }
        (dec ? dec.catch(function () {}) : Promise.resolve()).then(function () {
          if (my !== token || !open) return;
          clearTimeout(dimT);
          while (content.firstChild) content.removeChild(content.firstChild);
          im.className = '';
          var nw = im.naturalWidth || CW_W, nh = im.naturalHeight || CW_H;
          if (nw !== CW_W || nh !== CW_H || !zoom.ready()) zoom.fit(nw, nh);
          if (dir && content.classList.contains('shown') && !reduced()) im.className = dir > 0 ? 'cw-in-r' : 'cw-in-l';
          content.appendChild(im);
          content.classList.remove('wait');
          content.classList.add('shown');
          load.hidden = true;
          prefetch(i);
        });
      };
      if (im._st === 'ok') done(true);
      else if (im._st === 'err') done(false);
      else im._cb = done;
    }

    /* ---- 焦点：打开时进对话框（关闭按钮优先），Tab 在当前最上层（抽屉 / 查看器）内循环，关闭后还给触发者 ---- */
    function scope() { return dOpen && sheet ? sheet : root; }
    function visible(n) { return n.getClientRects().length > 0 && getComputedStyle(n).visibility !== 'hidden'; }
    function focusables() {
      var sc = scope();
      return Array.prototype.filter.call(
        sc.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'),
        function (n) { return n !== sc && !n.disabled && !n.closest('[inert]') && visible(n); }
      );
    }
    /* 打开时的聚焦：WebKit 下 visibility 可能要过几帧才变 visible，focus() 会落空。
       rAF 轮询（最多约 500ms，transitionend 补充触发）：目标真正可聚焦才 focus()，直到 activeElement === 目标；
       超时才降级到 list[0] / 容器。期间关闭、层级（dOpen）变化、重新打开或用户自己把焦点移到层内别处：停止，不抢焦点 */
    var fq = { gen: 0, raf: 0, off: null };
    function ready(n) {
      if (!n || n.disabled || (n.closest && n.closest('[inert]')) || !n.getClientRects().length) return false;
      return getComputedStyle(n).visibility === 'visible';
    }
    function focusTo(n) { try { n.focus({ preventScroll: true }); } catch (e) { n.focus(); } return document.activeElement === n; }
    function focusStop() {
      fq.gen++;
      if (fq.raf) cancelAnimationFrame(fq.raf);
      fq.raf = 0;
      if (fq.off) { fq.off(); fq.off = null; }
    }
    function firstFocusable() { var l = focusables().filter(function (n) { return n !== zBtn; }); return l[0] || null; }
    function focusIn() {
      focusStop();
      var gen = fq.gen, d0 = dOpen, sc = scope(), close = dOpen ? erClose : $('vwClose');
      // 嵌入模式 vwClose 按设计隐藏（display:none）：沿用原有目标（层内第一个可聚焦元素，没有则容器）
      var useClose = !!close && !close.disabled && (dOpen || !embedded || close.getClientRects().length > 0);
      var t0 = Date.now();
      function target() {
        if (useClose) return ready(close) ? close : null;
        var gate = dOpen ? sheet : vtop;                 // 层内子元素 visibility 已切过来
        if (gate && !ready(gate)) return null;
        return firstFocusable() || sc;
      }
      function step() {
        if (gen !== fq.gen) return;
        fq.raf = 0;
        if (!open || dOpen !== d0 || scope() !== sc) { focusStop(); return; }
        var a = document.activeElement;
        if (useClose && a === close) { focusStop(); return; }
        if (a && a !== sc && a !== document.body && sc.contains(a) && a !== close && fq.moved) { focusStop(); return; }
        var t = target();
        if (t && focusTo(t)) { focusStop(); return; }
        if (Date.now() - t0 >= 500) {
          focusStop();
          var f = firstFocusable() || sc;
          if (document.activeElement !== f) focusTo(f);
          return;
        }
        fq.raf = requestAnimationFrame(step);
      }
      // 用户在轮询期间自己把焦点移到层内其他元素（点击 / Tab）：不再抢
      fq.moved = false;
      var onFocus = function (e) { if (gen === fq.gen && e.target !== close && e.target !== sc && sc.contains(e.target)) fq.moved = true; };
      var onEnd = function () { if (gen !== fq.gen) return; if (fq.raf) cancelAnimationFrame(fq.raf); fq.raf = 0; step(); };
      root.addEventListener('transitionend', onEnd, true);
      sc.addEventListener('focusin', onFocus);
      fq.off = function () { root.removeEventListener('transitionend', onEnd, true); sc.removeEventListener('focusin', onFocus); };
      step();
    }
    function trapTab(e) {
      var list = focusables(), a = document.activeElement;
      e.preventDefault();
      if (!list.length) { scope().focus(); return; }
      var i = list.indexOf(a), n;
      if (i < 0) n = e.shiftKey ? list[list.length - 1] : list[0];
      else n = list[(i + (e.shiftKey ? list.length - 1 : 1)) % list.length];
      try { n.focus({ preventScroll: true }); } catch (err) { n.focus(); }
    }
    document.addEventListener('focusin', function (e) {
      if (open && !document.querySelector('.lm-dialog[open]') && !scope().contains(e.target)) focusIn();
    });

    /* N3：查看器关闭后去掉深链参数 page / cw（保留 tab、embed 等其他参数和当前 state），刷新不会再自动打开 */
    function stripParams() {
      try {
        var sp = new URLSearchParams(location.search);
        if (!sp.has('page') && !sp.has('cw')) return;
        sp.delete('page'); sp.delete('cw');
        var qs = sp.toString();
        history.replaceState(history.state, '', location.pathname + (qs ? '?' + qs : '') + location.hash);
      } catch (e) {}
    }

    /* ---- 独立打开时的历史：查看器 {stm32v:1}，抽屉 {stm32v:2}，各占一条 ----
       自己发出的返回（history.go(-n)）是异步的：在途时不再叠发，攒到 hQueued，落地后补发；
       全部落地后按「当前应有几层」补压缺的记录（N2：关了又立刻开）；落在最底下那条时清深链参数（N3）。
       约 1s 内 popstate 没来也按当前 state 兜底。 */
    var hInFlight = false, hQueued = 0, hT = 0;
    function stDepth() { var st = history.state; return st && st.stm32v ? (Number(st.stm32v) || 0) : 0; }
    function want() { return open ? (dOpen ? 2 : 1) : 0; }
    function pushH(d) {
      try {
        history.pushState({ stm32v: d }, '');
        if (d === 1) pushed = true; else dPushed = true;
      } catch (e) {}
    }
    function goBack(n) {
      if (n <= 0) return;
      if (hInFlight) { hQueued += n; return; }
      hInFlight = true;
      clearTimeout(hT);
      hT = setTimeout(function () { if (hInFlight) landed(); }, 1000);
      try { history.go(-n); } catch (e) { hInFlight = false; clearTimeout(hT); }
    }
    function landed(pop) {
      hInFlight = false; clearTimeout(hT);
      if (hQueued > 0) { var k = hQueued; hQueued = 0; goBack(k); return; }
      var cur = stDepth(), w = want();
      // 刷新后残留的旧记录（如 ?cw 刷新后落回旧 {stm32v:1}）：只在 popstate 真正落地时，比应有层数多就继续退到应有层，不留死记录
      if (pop === true && !embedded && cur > w) { goBack(cur - w); return; }
      if (cur === 0) stripParams();
      if (embedded) return;
      pushed = cur >= 1 && w >= 1; dPushed = cur >= 2 && w >= 2;
      for (var d = cur + 1; d <= w; d++) pushH(d);
    }

    function openV(m, i, missingTitle, trigger) {
      if (open && dOpen) closeDrawer(false, false, true);
      mode = m; items = itemsFor(m);
      var big = m === 'course' || m === 'teach';       // 位图：4x / 双击 2.5x；矢量图：8x / 3x
      zoom.limits(big ? 4 : 8, 2);                      // 双击 / 双点：1x ↔ 2x
      if (!open) {
        var a = document.activeElement;
        lastFocus = trigger || (a && a !== document.body && a !== root ? a : null);
        open = true;
        // 上一次关闭后 360ms 内又打开：先清掉残留的旧图，不让它冒充新内容
        dropPool(); clearTimeout(dimT);
        dropImgs();
        content.classList.remove('shown', 'wait');
        setBadge(null);
        root.classList.add('open'); root.setAttribute('aria-hidden', 'false');
        if (useInert) app.inert = true;
        notifyDepth(1);
        // 独立打开：上一次关闭的返回还没落地时先不压，等 popstate 到了再补（N2 同类竞态）
        if (!embedded && !hInFlight) pushH(1);
      }
      requestAnimationFrame(function () { show(i, missingTitle); if (open) focusIn(); });
    }
    function closeV(fromHistory, noFocus) {
      if (!open) return;
      var steps = (pushed ? 1 : 0) + (dPushed ? 1 : 0);
      closeDrawer(true, true);
      open = false; token++; failed = false;
      focusStop();
      dropPool(); clearTimeout(dimT);
      setBadge(null);
      root.classList.remove('open'); root.setAttribute('aria-hidden', 'true');
      if (useInert) app.inert = false;
      notifyDepth(0);
      pushed = false; dPushed = false;
      if (steps && !fromHistory) goBack(steps);
      else if (fromHistory && !embedded && !hInFlight && stDepth() > 0) goBack(stDepth());   // 系统返回落在刷新残留的旧记录上：退到底层
      if (!hInFlight) stripParams();
      contextChanged();
      setTimeout(function () { if (!open) { dropImgs(); content.classList.remove('shown', 'wait'); zoom.clear(); } }, 360);
      var lf = lastFocus; lastFocus = null;
      if (!noFocus && lf && lf.focus && document.contains(lf)) try { lf.focus({ preventScroll: true }); } catch (e) {}
      else if (root.contains(document.activeElement) && document.activeElement.blur) document.activeElement.blur();
    }
    window.addEventListener('popstate', function () {
      // 自己发出的返回落地
      if (hInFlight) { landed(true); return; }
      // 系统 / 浏览器返回：一次只退一层（抽屉 → 查看器）
      if (dOpen) {
        dPushed = false;
        closeDrawer(true);
        if (open && stDepth() >= 1) return;
      }
      if (open) closeV(true);
    });
    // 恢复联网时自动重试加载失败的那一页
    window.addEventListener('online', function () { if (open && failed) show(idx, null, true); });
    $('vwClose').addEventListener('click', function () { closeV(false); });
    $('vwPrev').addEventListener('click', function () { if (idx > 0) show(idx - 1); });
    $('vwNext').addEventListener('click', function () { if (idx < items.length - 1) show(idx + 1); });
    pressable(vtop, '.icon-btn');
    document.addEventListener('keydown', function (e) {
    if (document.querySelector('.lm-dialog[open]')) return;
      if (e.isComposing) return;
      if (!open) {
        // 嵌入模式、查看器未开：Escape 交给外壳关闭整个工具（搜索框里有字时已被清空并 preventDefault）
        if (e.key === 'Escape' && embedded && !e.defaultPrevented) { e.preventDefault(); toShell({ type: 'close' }); }
        return;
      }
      if (e.key === 'Tab') { trapTab(e); return; }
      if (dOpen) {
        // 抽屉开着：Escape 只关抽屉；方向键留给抽屉内滚动，不翻页
        if (e.key === 'Escape') { e.preventDefault(); closeDrawer(false); }
        return;
      }
      if (e.key === 'Escape') { e.preventDefault(); closeV(false); }
      else if ((e.key === '+' || e.key === '=' || e.key === '-' || e.key === '0') && !e.ctrlKey && !e.metaKey && !e.altKey && !isField(e.target)) {
        if (!zoom.ready()) return;
        e.preventDefault();
        if (e.key === '0') zoom.reset(); else zoom.zoomBy(e.key === '-' ? 1 / 1.25 : 1.25);
      }
      else if (e.key === 'ArrowLeft' && idx > 0) show(idx - 1);
      else if (e.key === 'ArrowRight' && idx < items.length - 1) show(idx + 1);
    });
    function isField(n) { return !!n && (n.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(n.tagName || '')); }
    var refit = function () { if (open && zoom.ready()) zoom.refit(); };
    if (window.ResizeObserver) new ResizeObserver(refit).observe(stage); else window.addEventListener('resize', refit);
    return {
      open: openV,
      // 课件：第 pi 册，第 page 页（0 起，越界夹到首末页）
      openCourse: function (pi, page, trigger) {
        var pt = CWP[pi];
        if (!pt) return;
        cwPart = pt;
        var j = Math.max(0, Math.min(pt.n - 1, Math.floor(Number(page)) || 0));
        openV('course', j, null, trigger);
      },
      close: function (fromShell, noFocus) { closeV(!!fromShell && embedded, !!noFocus); },
      // 外壳的「返回」（嵌入）：一次只退一层；外壳已把 depth 记成 0，关抽屉后报 depth 1 让它补回 sub 记录
      back: function () { if (dOpen) closeDrawer(true); else closeV(embedded); },
      depth: function () { return open ? (dOpen ? 2 : 1) : 0; },
      isOpen: function () { return open; },
      context: function () {
        if (!open || !items[idx]) return null;
        var it = items[idx], t = { tab: curTab };
        if (mode === 'course' && cwPart) { t.tab = 'course'; t.cw = cwPart.id + '-' + (idx + 1); }
        else if (mode === 'sch' && SCH[idx]) { t.tab = 'chip'; t.page = pageIdOf(SCH[idx].src); }
        else if (mode === 'fig' && FIGL[idx]) { t.tab = 'arch'; t.fig = String(FIGL[idx].id); }
        else if (mode === 'teach' && TEACHL[idx]) { t.tab = 'arch'; t.fig = String(TEACHL[idx].id); }
        return { target: t, title: (mode === 'course' && cwPart ? cwPart.short + ' p.' + (idx + 1) + ' · ' : '') + (it.title || '资料') };
      },
      // 启动时查看器没打开、当前条目却带 stm32v（刷新时查看器 / 抽屉开着）：退回底层那条，避免死记录
      settle: function () { if (!embedded && !open && !hInFlight && stDepth() > 0) goBack(stDepth()); }
    };
  })();

  /* ===== HUB-T7 寄存器钩子 ===== */
  /* 「寄存器」tab 的全部界面在 regs.js / regs.css；这里只做：懒加载（先 assets/registers.js 再 regs.js，只加载一次）、
     加载态 / 失败重试、给 regs.js 的小接口 STM32_APP、引脚 / 片段 / 课件三处反向入口、深链参数。不碰查看器 / 焦点 / 历史。 */
  var REGS_SRC = ['assets/registers.js', 'regs.js'];
  // 能对上寄存器的代码片段（= registers.js 里 group.snippets ∪ quick.snippet 的「分类|标题」）；按钮点了才懒加载、由 regs.js 解析
  var REGS_SNIPS = ['GPIO|LED 亮灭 / 翻转', 'GPIO|蜂鸣器', '输入|按键输入（消抖）', '输入|EXTI 外部中断（KEY1 下降沿）',
    '串口|USART1 中断收发', '串口|printf 重定向到 USART1', '定时器|定时器中断（TIM6 1s）', '定时器|PWM 呼吸灯（LED1 · TIM2_CH1）',
    '模拟|ADC 读电位器（ADC1 · IN10 · PC0）', '总线|I2C 读写 EEPROM（M24C02 · I2C2）', '总线|SPI 读 Flash ID（W25Q32 · SPI1）', '系统|延时 / SysTick'];
  var regsP = null, regsReady = false, regsFail = false, regsTries = 0, regsWant = null;
  function regsUI() { var u = window.STM32_REGS_UI; return u && typeof u.mount === 'function' ? u : null; }
  function regsScript(src) {
    return new Promise(function (ok, bad) {
      var s = document.createElement('script');
      s.src = src + (regsTries > 0 ? '?r=' + Date.now() : '');
      s.async = false;
      s.onload = function () { ok(); };
      s.onerror = function () { if (s.parentNode) s.parentNode.removeChild(s); bad(new Error(src)); };
      document.head.appendChild(s);
    });
  }
  // Promise 化、只加载一次；并发调用复用同一个 Promise；失败后清空，下次重试（带 ?r= 绕过缓存）
  function regsLoad() {
    if (regsP) return regsP;
    regsP = (window.STM32_REGS ? Promise.resolve() : regsScript(REGS_SRC[0]))
      .then(function () {
        if (!window.STM32_REGS) throw new Error('STM32_REGS');
        return regsUI() ? null : regsScript(REGS_SRC[1]);
      })
      .then(function () { if (!regsUI()) throw new Error('STM32_REGS_UI'); });
    regsP.catch(function () { regsP = null; regsTries++; });
    return regsP;
  }
  function regsClear(pane) { while (pane.firstChild) pane.removeChild(pane.firstChild); }
  function regsLoading(pane) {
    if (pane.querySelector('.rg-load')) return;
    regsClear(pane);
    var box = el('div', 'vstate rg-load');
    box.setAttribute('role', 'status');
    box.appendChild(el('span', 'rg-spark', '✻'));
    box.appendChild(el('span', null, '加载中'));
    pane.appendChild(box);
  }
  function regsFailed(pane) {
    regsClear(pane);
    var box = el('div', 'vstate rg-fail'), b = el('button', 'vw-retry rg-retry');
    b.type = 'button';
    b.appendChild(icon(IC.retry));
    b.appendChild(el('span', null, '加载失败 · 重试'));
    b.addEventListener('click', function () { regsEnter(true); });
    pressable(b);
    box.appendChild(b);
    pane.appendChild(box);
    if (curTab === 'regs' && (!document.activeElement || document.activeElement === document.body)) try { b.focus({ preventScroll: true }); } catch (e) {}
  }
  function regsEnter(retry) {
    var pane = $('pane-regs');
    if (!pane) return;
    var ui = regsReady ? regsUI() : null;
    if (ui) { var t = regsWant; regsWant = null; try { ui.show(t, { enter: true }); } catch (e) { if (window.console) console.error(e); } return; }
    regsFail = false;
    regsLoading(pane);
    var hadFocus = retry === true;
    regsLoad().then(function () {
      if (regsReady) return;
      regsReady = true;
      regsClear(pane);
      var t = regsWant; regsWant = null;
      try { regsUI().mount(pane, window.STM32_APP, t); } catch (e) { if (window.console) console.error(e); }
      if (hadFocus && curTab === 'regs' && document.activeElement === document.body) { var f = pane.querySelector('input'); if (f) try { f.focus({ preventScroll: true }); } catch (e) {} }
    }, function () {
      regsFail = true;
      regsFailed(pane);
    });
  }
  // switchTab 里调用：进入 regs → 懒加载 / show；离开 regs → leave()（清 URL 里的 reg/f/i/y）
  function regsTabHook(name, was) {
    if (name === 'regs') regsEnter();
    else if (was === 'regs' && regsReady) { var ui = regsUI(); if (ui) try { ui.leave(); } catch (e) {} }
  }
  // 反向入口：切到 regs 并定位（target 由 regs.js 白名单校验）
  function regsOpen(target) {
    regsWant = target;
    if (curTab === 'regs') regsEnter(); else switchTab('regs');
  }
  // 深链参数：只做格式白名单，是否存在由 regs.js 查表判断
  function regsParams(sp) {
    if (!sp) return null;
    var reg = sp.get('reg');
    if (!reg || !/^[A-Za-z0-9_]{2,32}(\.[A-Za-z0-9_\/]{1,32})?$/.test(reg)) return null;
    var t = { reg: reg, from: 'url' }, f = sp.get('f'), i = sp.get('i'), y = sp.get('y');
    if (f && /^[A-Za-z0-9_\/]{1,32}$/.test(f)) t.f = f;
    if (i && /^[A-Za-z0-9_]{1,16}$/.test(i)) t.i = i;
    if (y && /^\d{1,2}$/.test(y)) t.y = Number(y);
    var value = sp.get('v'); if (value && /^0x[0-9a-f]{1,8}$/i.test(value)) t.v = value;
    var mask = sp.get('m'); if (mask && /^0x[0-9a-f]{1,8}$/i.test(mask)) t.m = mask;
    return t;
  }
  // 引脚行（PA0~PG15）右侧小「寄存器」按钮；自己的 click / Enter / 空格 / pointerdown 不冒泡到 .prow
  function regsPinBtn(row, name, t) {
    var m = t === 'I' ? /^P([A-G])(\d{1,2})$/.exec(String(name).toUpperCase()) : null;
    if (!m || Number(m[2]) > 15) return;
    var y = Number(m[2]), b = el('button', 'rg-pinreg');
    b.type = 'button';
    b.setAttribute('aria-label', name + ' 配置寄存器');
    b.appendChild(el('span', 'cw-tag', '寄存器'));
    b.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
    b.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') e.stopPropagation(); });
    b.addEventListener('click', function (e) {
      e.stopPropagation();
      regsOpen({ reg: y < 8 ? 'GPIO_CRL' : 'GPIO_CRH', f: 'MODE' + y, i: 'GPIO' + m[1], y: y, from: 'pin' });
    });
    row.appendChild(b);
  }
  // 片段卡标题行「寄存器」：先显示按钮，点了再懒加载并由 regs.js 解析到寄存器（有 quick 时预填）
  function regsSnipBtn(h, s) {
    if (!s || REGS_SNIPS.indexOf(s.cat + '|' + s.title) < 0) return;
    var b = el('button', 'rg-snipreg');
    b.type = 'button';
    b.setAttribute('aria-label', s.title + ' 对应寄存器');
    b.appendChild(el('span', null, '寄存器'));
    b.addEventListener('click', function () { regsOpen({ snippet: { cat: String(s.cat), title: String(s.title) }, from: 'snippet' }); });
    pressable(b);
    h.appendChild(b);
  }
  // 课件目录行「寄存器」标签（与 cw-code / cw-pin / cw-fig 同款）→ regs tab + 临时筛选
  function regsCwTag(row, x) {
    var map = window.STM32_CW_REGS, ids = map && x && x.c && Object.prototype.hasOwnProperty.call(map, x.c.id) ? map[x.c.id] : null;
    if (!Array.isArray(ids) || !ids.length) return;
    ids = ids.filter(function (id) { return typeof id === 'string'; });
    if (!ids.length) return;
    var b = cwTag('cw-regs', '寄存器', '寄存器 ' + x.title);
    b.addEventListener('click', function () { regsOpen({ ids: ids.slice(), label: '课件 · ' + x.title, from: 'course' }); });
    row.appendChild(b);
  }
  function regsFigTitle(id) {
    id = String(id);
    var i = figIndex(TEACHL, id);
    if (i > -1) return String(TEACHL[i].title || id);
    i = figIndex(FIGL, id);
    return i > -1 ? String(FIGL[i].title || id) : null;
  }
  // 给 regs.js 的接口：只放已有函数的引用 / 薄封装
  window.STM32_APP = Object.freeze({
    el: el, hlC: hlC, plainCode: plainCode, copyText: copyText, copyBtn: copyBtn, toast: toast, reduced: reduced,
    context: context, contextChanged: contextChanged, navigate: navigateTarget, loadRegisters: regsLoad,
    overlayDepth: notifyDepth, viewerDepth: function () { return viewer.depth(); },
    lsGet: lsGet, lsSet: lsSet, pressable: pressable, rovingKeys: rovingKeys, syncScrolled: syncScrolled,
    emptyState: function (node, word, ic) { return emptyState(node, word, ic && IC[ic] ? IC[ic] : null); },
    icon: function (name) { return icon(IC[name] || IC.empty); },
    switchTab: switchTab, curTab: function () { return curTab; }, isEmbed: embedded,
    viewerOpen: function () { return viewer.isOpen(); },
    gotoCode: gotoCode, gotoPins: gotoPins, locatePins: locatePins, gotoFig: gotoFig,
    openCw: function (partId, page1, trigger) {
      var pi = cwPartIdx(String(partId)), n = Number(page1);
      if (pi < 0 || !Number.isInteger(n) || n < 1 || n > CWP[pi].n) return false;
      viewer.openCourse(pi, n - 1, trigger || null);
      return true;
    },
    hasFig: function (id) { return regsFigTitle(id) != null; },
    figTitle: regsFigTitle,
    hasSnippet: function (cat, title) { return SNIPS.some(function (s) { return s.cat === cat && (title == null || title === '' || s.title === title); }); },
    hasCw: function (partId, page1) { var pi = cwPartIdx(String(partId)), n = Number(page1); return pi > -1 && Number.isInteger(n) && n >= 1 && n <= CWP[pi].n; }
  });
  // Escape 等按键：regs tab 可见、查看器没开时先交给 regs.js（捕获阶段，早于「Escape 关闭工具」）
  document.addEventListener('keydown', function (e) {
    if (document.querySelector('.lm-dialog[open]')) return;
    if (curTab !== 'regs' || !regsReady || viewer.isOpen()) return;
    var ui = regsUI();
    if (ui && ui.onKey) ui.onKey(e);
  }, true);
  window.addEventListener('online', function () { if (regsFail && curTab === 'regs') regsEnter(true); });

  /* ================= 启动 ================= */

  buildPins();
  filterPins('');
  buildCode();
  buildBoard();
  buildPackage();
  buildSchematic();
  buildFigs();
  buildCourse();

  var params;
  try { params = new URLSearchParams(location.search); } catch (e) { params = null; }
  var startTab = (params && params.get('tab')) || lsGet('lm.stm32.tab') || 'pins';
  var startPage = params && params.get('page');
  if (startPage) startTab = 'chip';
  // 课件深链 ?cw=v20-16（册 id - 页号，页号从 1 起）；无效时只切到课件 tab
  var startCw = !startPage && params ? params.get('cw') : null, cwTarget = null;
  if (startCw != null) {
    startTab = 'course';
    var mcw = /^(.+)-(\d{1,4})$/.exec(String(startCw).trim());
    var cpi = mcw ? cwPartIdx(mcw[1]) : -1, cnum = mcw ? Number(mcw[2]) : 0;
    if (cpi >= 0 && cnum >= 1 && cnum <= CWP[cpi].n) cwTarget = { p: cpi, i: cnum - 1 };
  }
  var routeTarget = window.STM32StudyCore ? window.STM32StudyCore.fromParams(params ? params.toString() : '') : null;
  var regsQ = regsParams(params);                         // HUB-T7：?reg=…&f=…&i=…&y=…（page / cw 优先）
  if (regsQ && !startPage && startCw == null) { startTab = 'regs'; regsWant = regsQ; }
  switchTab(startTab);
  requestAnimationFrame(function () {
    moveInk();
    requestAnimationFrame(function () { seg.classList.add('ready'); });
    if (startPage) openSchematicPage(startPage);
    else if (cwTarget) viewer.openCourse(cwTarget.p, cwTarget.i);
    else if (routeTarget && (routeTarget.fig || routeTarget.pin || routeTarget.q || routeTarget.cat || routeTarget.snip)) navigateTarget(routeTarget);
    if (!viewer.isOpen()) viewer.settle();
    notifyReady();
  });
  window.addEventListener('load', function () { syncTop(); moveInk(); });
  window.addEventListener('popstate', contextChanged);
  document.addEventListener('click', function (e) {
    var card = e.target.closest && e.target.closest('.snip');
    if (card) { var cp = card.querySelector('.copy[data-i]'); var sn = cp && SNIPS[Number(cp.dataset.i)]; if (sn) { activeSnippet = sn.title; contextChanged(); } }
  });
})();
