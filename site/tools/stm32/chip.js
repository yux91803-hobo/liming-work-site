/* chip.js — LQFP144 封装图（SVG）
   1 脚在左上，逆时针：左边自上而下 1~36 → 底边自左向右 37~72 → 右边自下而上 73~108 → 顶边自右向左 109~144。
   用在三处：首页（指到外设时点亮它用的脚）、主题页页头（点亮本外设的脚）、芯片页（可点选、可键盘逐脚移动）。 */
(function () {
  'use strict';
  var STM = window.STM, ui = STM.ui, sv = ui.sv;
  var PK = { P: 10, B: 380, LEAD: 12, M: 76 }, uid = 0;
  PK.S = PK.B + 2 * PK.M;

  function geom(n) {
    var L = PK.M, B = PK.B, P = PK.P, pad = (B - 36 * P) / 2, side, k, cx, cy;
    if (n <= 36) { side = 'L'; k = n - 1; cx = L; cy = L + pad + k * P + P / 2; }
    else if (n <= 72) { side = 'B'; k = n - 37; cx = L + pad + k * P + P / 2; cy = L + B; }
    else if (n <= 108) { side = 'R'; k = n - 73; cx = L + B; cy = L + B - pad - k * P - P / 2; }
    else { side = 'T'; k = n - 109; cx = L + B - pad - k * P - P / 2; cy = L; }
    return { side: side, cx: cx, cy: cy };
  }

  /* opts: { labels: 显示信号名, interactive: 可点选, title } */
  function create(opts) {
    opts = opts || {};
    var pins = STM.model.pins, L = PK.M, B = PK.B, LD = PK.LEAD, P = PK.P, crop = opts.labels ? 0 : PK.M - LD - 4;
    var vb = crop + ' ' + crop + ' ' + (PK.S - 2 * crop) + ' ' + (PK.S - 2 * crop);
    var s = sv('svg', { 'class': 'chip' + (opts.labels ? ' chip-labels' : '') + (opts.interactive ? ' chip-live' : ''), viewBox: vb });
    if (opts.interactive) { s.setAttribute('role', 'group'); s.setAttribute('aria-label', opts.title || 'STM32F103ZET6 LQFP144 引脚图'); }
    else s.setAttribute('aria-hidden', 'true');
    var body = sv('g', { 'class': 'chip-body' });
    body.appendChild(sv('rect', { x: L, y: L, width: B, height: B, rx: 7 }));
    var gid = 'chip-sheen' + (++uid), defs = sv('defs'), lg = sv('linearGradient', { id: gid, x1: '0', y1: '0', x2: '1', y2: '1' });
    lg.appendChild(sv('stop', { offset: '0', 'class': 'chip-sheen-a' })); lg.appendChild(sv('stop', { offset: '.55', 'class': 'chip-sheen-b' }));
    defs.appendChild(lg); s.appendChild(defs);
    body.appendChild(sv('rect', { x: L, y: L, width: B, height: B, rx: 7, fill: 'url(#' + gid + ')', 'class': 'chip-sheen-r' }));
    body.appendChild(sv('rect', { 'class': 'chip-bevel', x: L + 7, y: L + 7, width: B - 14, height: B - 14, rx: 4 }));
    body.appendChild(sv('circle', { 'class': 'chip-dot', cx: L + 22, cy: L + 22, r: 6 }));
    body.appendChild(sv('text', { 'class': 'chip-name', x: L + B / 2, y: L + B / 2 - 6, 'text-anchor': 'middle' }, 'STM32F103ZET6'));
    body.appendChild(sv('text', { 'class': 'chip-sub', x: L + B / 2, y: L + B / 2 + 20, 'text-anchor': 'middle' }, 'ARM Cortex-M3 · LQFP144'));
    s.appendChild(body);
    var g = {}, hw = 2.3;
    pins.forEach(function (p) {
      var o = geom(p.n), cx = o.cx, cy = o.cy, ld, hit, nm, no;
      if (o.side === 'L') { ld = { x: cx - LD, y: cy - hw, width: LD, height: hw * 2 }; hit = { x: 0, y: cy - P / 2, width: L + 16, height: P }; nm = { x: cx - LD - 3, y: cy, 'text-anchor': 'end' }; no = { x: cx + 4, y: cy, 'text-anchor': 'start' }; }
      else if (o.side === 'R') { ld = { x: cx, y: cy - hw, width: LD, height: hw * 2 }; hit = { x: cx - 16, y: cy - P / 2, width: L + 16, height: P }; nm = { x: cx + LD + 3, y: cy, 'text-anchor': 'start' }; no = { x: cx - 4, y: cy, 'text-anchor': 'end' }; }
      else if (o.side === 'B') { ld = { x: cx - hw, y: cy, width: hw * 2, height: LD }; hit = { x: cx - P / 2, y: cy - 16, width: P, height: L + 16 }; nm = { x: cx, y: cy + LD + 3, 'text-anchor': 'end', transform: 'rotate(-90 ' + cx + ' ' + (cy + LD + 3) + ')' }; no = { x: cx, y: cy - 4, 'text-anchor': 'start', transform: 'rotate(-90 ' + cx + ' ' + (cy - 4) + ')' }; }
      else { ld = { x: cx - hw, y: cy - LD, width: hw * 2, height: LD }; hit = { x: cx - P / 2, y: 0, width: P, height: L + 16 }; nm = { x: cx, y: cy - LD - 3, 'text-anchor': 'start', transform: 'rotate(-90 ' + cx + ' ' + (cy - LD - 3) + ')' }; no = { x: cx, y: cy + 4, 'text-anchor': 'end', transform: 'rotate(-90 ' + cx + ' ' + (cy + 4) + ')' }; }
      var pg = sv('g', { 'class': 'pin t-' + p.type + (p.board.length ? ' used' : ''), 'data-pin': p.n });
      if (opts.interactive) {
        pg.setAttribute('tabindex', p.n === 1 ? '0' : '-1'); pg.setAttribute('role', 'button');
        pg.setAttribute('aria-label', p.n + ' 脚 ' + p.name + (p.board.length ? '，板上 ' + p.board.map(function (r) { return r.name; }).join('、') : ''));
        hit['class'] = 'hit'; pg.appendChild(sv('rect', hit));
      }
      ld['class'] = 'ld'; pg.appendChild(sv('rect', ld));
      if (opts.labels) {
        nm['class'] = 'nm'; nm['dominant-baseline'] = 'central'; pg.appendChild(sv('text', nm, p.name));
        no['class'] = 'no'; no['dominant-baseline'] = 'central'; pg.appendChild(sv('text', no, p.n));
      }
      s.appendChild(pg); g[p.n] = pg;
    });

    var api = { svg: s, g: g, sel: null, pos: function (n) { var o = geom(n); return { x: o.cx, y: o.cy, side: o.side }; }, S: PK.S };
    // 点亮一组脚（同一时间只有一组；color 为主题色）
    api.light = function (list, color) {
      s.classList.toggle('lit-on', !!(list && list.length));
      if (color) s.style.setProperty('--lit', color); else s.style.removeProperty('--lit');
      Object.keys(g).forEach(function (n) { g[n].classList.remove('lit'); });
      (list || []).forEach(function (n) { if (g[n]) g[n].classList.add('lit'); });
    };
    api.select = function (n) {
      if (api.sel && g[api.sel]) { g[api.sel].classList.remove('sel'); if (opts.interactive) g[api.sel].setAttribute('tabindex', '-1'); }
      api.sel = g[n] ? n : null;
      if (api.sel) { g[n].classList.add('sel'); if (opts.interactive) g[n].setAttribute('tabindex', '0'); }
      else if (opts.interactive && g[1]) g[1].setAttribute('tabindex', '0');
    };
    if (opts.interactive) {
      var pick = opts.onPick || function () {};
      s.addEventListener('click', function (e) { var t = e.target.closest && e.target.closest('[data-pin]'); if (t) pick(Number(t.getAttribute('data-pin')), 'click'); });
      s.addEventListener('keydown', function (e) {
        var t = e.target.closest && e.target.closest('[data-pin]'); if (!t) return;
        var n = Number(t.getAttribute('data-pin'));
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(n, 'key'); return; }
        var d = (e.key === 'ArrowRight' || e.key === 'ArrowDown') ? 1 : (e.key === 'ArrowLeft' || e.key === 'ArrowUp') ? -1 : 0;
        if (!d) return;
        e.preventDefault();
        var m = ((n - 1 + d + 144) % 144) + 1;
        if (g[m]) { t.setAttribute('tabindex', '-1'); g[m].setAttribute('tabindex', '0'); try { g[m].focus({ preventScroll: true }); } catch (err) { g[m].focus(); } if (opts.onFocusPin) opts.onFocusPin(m); }
      });
    }
    return api;
  }
  STM.chip = { create: create, PK: PK };
})();
