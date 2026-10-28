/* mascot.js — 首页小芯
   标题栏里的一颗小芯片：走来走去、眼睛跟着指针/手指、会眨眼，没人理它就睡觉。
   点它会跳，连点会晕；按住拖到某张卡片上松手，就打开那个工具。 */
(function () {
  'use strict';
  var track = document.getElementById('xinTrack'), grid = document.getElementById('grid');
  if (!track || !grid || !window.requestAnimationFrame) return;
  var body = document.body;
  var reduce = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
  var W = 48, H = 50, SLEEP_AFTER = 30000;   // W/H 在元素挂上后按实际尺寸更新（大屏会放大一点）

  function eye(cx) {
    return '<g class="x-eye"><circle class="x-sc" cx="' + cx + '" cy="24" r="4.9"/>' +
      '<g class="x-pu"><circle class="x-pp" cx="' + cx + '" cy="24" r="2.5"/><circle class="x-hl" cx="' + (cx - 0.9) + '" cy="23" r=".9"/></g></g>';
  }
  var SVG = '<svg viewBox="0 0 48 50" width="48" height="50" focusable="false">' +
    '<g class="x-arm x-al"><rect x="2.4" y="19.2" width="5.8" height="2.6" rx="1.1"/><rect x="2.4" y="26.2" width="5.8" height="2.6" rx="1.1"/></g>' +
    '<g class="x-arm x-ar"><rect x="39.8" y="19.2" width="5.8" height="2.6" rx="1.1"/><rect x="39.8" y="26.2" width="5.8" height="2.6" rx="1.1"/></g>' +
    '<g class="x-leg x-ll"><rect x="15.4" y="38" width="3.4" height="8.2" rx="1"/><rect x="12.6" y="44.6" width="6.6" height="2.6" rx="1.3"/></g>' +
    '<g class="x-leg x-lr"><rect x="29.2" y="38" width="3.4" height="8.2" rx="1"/><rect x="28.8" y="44.6" width="6.6" height="2.6" rx="1.3"/></g>' +
    '<rect class="x-bd" x="7" y="8.6" width="34" height="31.4" rx="6.6"/>' +
    '<rect class="x-fc" x="9.6" y="11.2" width="28.8" height="26.2" rx="4.6"/>' +
    '<path class="x-nt" d="M20.6 8.6A3.4 3.4 0 0 0 27.4 8.6Z"/>' +
    '<circle class="x-dm" cx="13.4" cy="15.2" r="1.35"/>' +
    '<circle class="x-led" cx="34.6" cy="15.2" r="1.4"/>' +
    '<ellipse class="x-bl" cx="13.2" cy="29.8" rx="2.2" ry="1.25"/><ellipse class="x-bl" cx="34.8" cy="29.8" rx="2.2" ry="1.25"/>' +
    '<g class="x-eyes">' + eye(18) + eye(30) + '</g>' +
    '<g class="x-alt x-hap"><path d="M14.2 25.4q3.8-4.6 7.6 0"/><path d="M26.2 25.4q3.8-4.6 7.6 0"/></g>' +
    '<g class="x-alt x-shut"><path d="M14.4 24.2q3.6 2.8 7.2 0"/><path d="M26.4 24.2q3.6 2.8 7.2 0"/></g>' +
    '<g class="x-alt x-dz"><path d="M15.6 21.8l4.8 4.8M20.4 21.8l-4.8 4.8"/><path d="M27.6 21.8l4.8 4.8M32.4 21.8l-4.8 4.8"/></g>' +
    '<path class="x-mo x-m0" d="M21.8 31.4q2.2 1.9 4.4 0"/>' +
    '<path class="x-mo x-m1" d="M21.2 30.8h5.6q-.3 3.2-2.8 3.2t-2.8-3.2z"/>' +
    '<circle class="x-mo x-m2" cx="24" cy="32" r="1.6"/>' +
    '<path class="x-mo x-m3" d="M21.8 33.2q2.2-1.9 4.4 0"/>' +
    '</svg>';

  var el = document.createElement('div');
  el.className = 'xin';
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = '<div class="xin-sh"></div><div class="xin-r"><div class="xin-s">' + SVG + '</div></div>';
  track.appendChild(el);
  var rEl = el.querySelector('.xin-r'), sEl = el.querySelector('.xin-s'), shEl = el.querySelector('.xin-sh');
  function dims() { W = el.offsetWidth || 48; H = el.offsetHeight || 50; }
  dims();

  /* ---------- 状态 ---------- */
  var x = 0, y = 0, sc = 1, ang = 0, av = 0, angT = 0;
  var mode = 'idle';                   // idle walk drag fly plug away sleep
  var tx = 0, raf = 0, lastT = 0, tw = null, drag = null, overCard = null;
  var mood = '', moodTm = 0, lookTm = 0, looking = false;
  var lastInput = Date.now(), idleTm = 0, blinkTm = 0, zTm = 0, taps = [];

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function maxX() { return Math.max(0, track.clientWidth - W); }
  function paused() { return document.hidden || body.classList.contains('tool-open'); }
  function cls(c, on) { el.classList.toggle(c, !!on); }
  function place() {
    el.style.transform = 'translate3d(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px,0)' + (sc !== 1 ? ' scale(' + sc.toFixed(3) + ')' : '');
    rEl.style.transform = Math.abs(ang) > 0.05 ? 'rotate(' + ang.toFixed(2) + 'deg)' : '';
  }
  function setMode(m) {
    mode = m;
    cls('is-walk', m === 'walk'); cls('is-drag', m === 'drag'); cls('is-sleep', m === 'sleep');
    cls('is-air', m === 'drag' || m === 'fly' || m === 'plug'); cls('is-away', m === 'away');
  }
  function setMood(m, ms) {
    clearTimeout(moodTm);
    if (mood) el.classList.remove('is-' + mood);
    mood = m || '';
    if (mood) el.classList.add('is-' + mood);
    if (mood && ms) moodTm = setTimeout(function () { setMood(''); }, ms);
  }
  function play(node, frames, ms, easing) {
    if (reduce || !node.animate) return null;
    return node.animate(frames, { duration: ms, easing: easing || 'ease-out' });
  }

  /* ---------- 眼睛 ---------- */
  function pupils(px, py) {
    el.style.setProperty('--px', px.toFixed(2) + 'px');
    el.style.setProperty('--py', py.toFixed(2) + 'px');
  }
  function lookAt(cx, cy, hold) {
    var r = el.getBoundingClientRect();
    var dx = cx - (r.left + r.width / 2), dy = cy - (r.top + r.height * 0.48);
    var d = Math.sqrt(dx * dx + dy * dy) || 1, k = Math.min(1, d / 90);
    pupils(dx / d * 2.2 * k, dy / d * 1.9 * k);
    looking = true; clearTimeout(lookTm);
    lookTm = setTimeout(function () { looking = false; if (mode !== 'walk') pupils(0, 0); }, hold || 2200);
  }
  function lookEl(node, hold) {
    if (!node) return;
    var r = node.getBoundingClientRect();
    lookAt(r.left + r.width / 2, r.top + r.height / 2, hold);
  }
  function blink(twice) {
    cls('is-blink', true);
    setTimeout(function () {
      cls('is-blink', false);
      if (twice) setTimeout(function () { blink(false); }, 150);
    }, 120);
  }
  function blinkLoop() {
    clearTimeout(blinkTm);
    blinkTm = setTimeout(function () {
      if (!paused() && mode !== 'sleep' && !mood) blink(Math.random() < 0.22);
      blinkLoop();
    }, 2400 + Math.random() * 3600);
  }

  /* ---------- 小粒子：睡觉的 z、开心的 ✻ ---------- */
  function particle(c, ch, left, top, dx, dy) {
    var s = document.createElement('span');
    s.className = c; s.textContent = ch;
    s.style.left = left.toFixed(1) + 'px'; s.style.top = top.toFixed(1) + 'px';
    if (dx != null) { s.style.setProperty('--dx', dx.toFixed(1) + 'px'); s.style.setProperty('--dy', dy.toFixed(1) + 'px'); }
    s.addEventListener('animationend', function () { s.remove(); });
    track.appendChild(s);
    setTimeout(function () { if (s.parentNode) s.remove(); }, 3000);
  }
  function topY() { return track.clientHeight - H + y; }
  function sparks(n) {
    if (reduce) return;
    for (var i = 0; i < n; i++) {
      var a = -Math.PI / 2 + (i - (n - 1) / 2) * 0.75 + (Math.random() - 0.5) * 0.3;
      particle('xin-p', '✻', x + W / 2 - 5, topY() + 4, Math.cos(a) * 26, Math.sin(a) * 24 - 6);
    }
  }
  function zz() {
    clearTimeout(zTm);
    if (mode !== 'sleep' || paused()) return;
    if (!reduce) particle('xin-z', Math.random() < 0.5 ? 'z' : 'Z', x + W - 12, topY() + 2);
    zTm = setTimeout(zz, 1800);
  }

  /* ---------- 动作 ---------- */
  function land() {
    setMode('idle');
    y = 0; sc = 1; angT = 0; place(); kick();
    play(sEl, [{ transform: 'scale(1.18,.8)' }, { transform: 'scale(.95,1.05)', offset: 0.55 }, { transform: 'none' }], 380);
    play(shEl, [{ transform: 'scaleX(1.3)', opacity: 1 }, { transform: 'none', opacity: 1 }], 380);
    schedule();
  }
  function jump(h) {
    play(sEl, [
      { transform: 'none' },
      { transform: 'scale(1.12,.86)', offset: 0.14 },
      { transform: 'translateY(-' + h + 'px) scale(.94,1.07)', offset: 0.5 },
      { transform: 'scale(1.1,.9)', offset: 0.86 },
      { transform: 'none' }
    ], 520 + h * 4, 'ease-in-out');
    play(shEl, [{ transform: 'none' }, { transform: 'scale(.5)', opacity: 0.35, offset: 0.5 }, { transform: 'none' }], 520 + h * 4, 'ease-in-out');
  }
  function stretch() {
    play(sEl, [{ transform: 'none' }, { transform: 'scale(.94,1.1)', offset: 0.45 }, { transform: 'none' }], 600, 'ease-in-out');
  }
  function walkTo(target) {
    tx = clamp(target, 0, maxX());
    if (Math.abs(tx - x) < 2) return;
    setMode('walk');
    if (!looking) pupils(tx > x ? 1.9 : -1.9, 0.3);
    kick();
  }
  function stopWalk() {
    if (mode !== 'walk') return;
    setMode('idle');
    if (!looking) pupils(0, 0);
  }
  function sleep() {
    if (mode !== 'idle') return;
    setMood(''); pupils(0, 0); setMode('sleep'); zz();
  }
  function wake(startled) {
    if (mode !== 'sleep') return;
    clearTimeout(zTm); setMode('idle');
    if (startled) { setMood('wow', 700); jump(10); } else stretch();
    schedule();
  }
  function tap() {
    var t = Date.now();
    taps = taps.filter(function (v) { return t - v < 1600; }); taps.push(t);
    lastInput = t;
    if (mode === 'sleep') { wake(true); return; }
    stopWalk();
    if (taps.length >= 5) {
      taps = [];
      rEl.style.transformOrigin = '50% 60%';
      play(rEl, [{ transform: 'rotate(0)' }, { transform: 'rotate(720deg)' }], 760, 'cubic-bezier(.2,.8,.2,1)');
      setMood('dizzy', 1900);
      return;
    }
    jump(22); setMood('happy', 1000); sparks(3);
    schedule();
  }

  /* 闲着的时候自己找点事做 */
  function schedule(ms) { clearTimeout(idleTm); idleTm = setTimeout(think, ms || 2200 + Math.random() * 3800); }
  function think() {
    if (paused()) return;
    if (mode !== 'idle' || mood) { schedule(); return; }
    if (Date.now() - lastInput > SLEEP_AFTER) { sleep(); return; }
    var r = Math.random(), m = maxX();
    if (!reduce && r < 0.5 && m > 30) {
      var t = Math.random() * m;
      if (Math.abs(t - x) < 24) t = x < m / 2 ? x + 24 + Math.random() * (m - x - 24) : Math.random() * (x - 24);
      walkTo(t);
    } else if (r < 0.78) {
      if (!looking) { pupils((Math.random() < 0.5 ? -1 : 1) * 2, (Math.random() - 0.3) * 1.6); setTimeout(function () { if (!looking && mode === 'idle') pupils(0, 0); }, 1300); }
    } else if (!reduce && r < 0.88) jump(8);
    else blink(true);
    schedule();
  }

  /* ---------- 动画循环（只在走路/拖动/飞行/摆动时运行） ---------- */
  function kick() { if (!raf) { lastT = 0; raf = requestAnimationFrame(loop); } }
  function bez(a, c, b, t) { var u = 1 - t; return u * u * a + 2 * u * t * c + t * t * b; }
  function loop(t) {
    raf = 0;
    var dt = lastT ? Math.min(0.05, (t - lastT) / 1000) : 0.016, busy = false;
    lastT = t;
    if (mode === 'walk') {
      var d = tx - x, st = 30 * dt;
      if (Math.abs(d) <= st) { x = tx; stopWalk(); } else { x += d > 0 ? st : -st; busy = true; }
    }
    if (mode === 'drag' && drag) {
      drag.vx *= Math.pow(0.02, dt);
      angT = clamp(drag.vx * 0.035, -36, 36);
    }
    if (tw) {
      var p = clamp((t - tw.t0) / tw.dur, 0, 1), e = tw.ease(p);
      x = bez(tw.x0, tw.cx, tw.x1, e); y = bez(tw.y0, tw.cy, tw.y1, e); sc = tw.s0 + (tw.s1 - tw.s0) * e;
      if (p >= 1) { var done = tw.done; tw = null; if (done) done(); } else busy = true;
    }
    // 摆动：阻尼弹簧
    av += (-140 * (ang - angT) - 13 * av) * dt; ang += av * dt;
    if (Math.abs(ang - angT) > 0.05 || Math.abs(av) > 0.05) busy = true; else { ang = angT; av = 0; }
    place();
    if (busy || mode === 'drag' || tw) raf = requestAnimationFrame(loop);
  }
  function easeIn(p) { return p * p; }
  function easeInOut(p) { return p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2; }
  function easeOut(p) { return 1 - (1 - p) * (1 - p); }
  function fly(x1, y1, s1, cy, ms, ease, done) {
    tw = { t0: performance.now(), dur: ms, x0: x, y0: y, s0: sc, cx: (x + x1) / 2, cy: cy, x1: x1, y1: y1, s1: s1, ease: ease, done: done };
    kick();
  }
  function flyHome() {
    var x1 = clamp(x, 0, maxX());
    if (reduce) { x = x1; land(); return; }
    setMode('fly'); angT = 0;
    var dist = Math.sqrt((x1 - x) * (x1 - x) + y * y);
    fly(x1, 0, 1, Math.min(y, 0) - 40 - Math.min(90, Math.abs(y) * 0.18), clamp(360 + dist * 0.5, 420, 880), easeInOut, land);
  }
  function dropIn(delay) {
    setMode('fly'); setMood('');
    x = clamp(x, 0, maxX()); sc = 1; ang = 0; av = 0; angT = 0;
    if (reduce) { y = 0; place(); land(); return; }
    y = -96; place();
    setTimeout(function () {
      fly(x, 0, 1, -96, 440, easeIn, function () { land(); setMood('happy', 900); });
    }, delay || 0);
  }

  /* ---------- 拖到卡片上打开工具 ---------- */
  function cardAt(cx, cy) {
    var cs = grid.querySelectorAll('.card[data-id]:not(.hide)');
    for (var i = 0; i < cs.length; i++) {
      var r = cs[i].getBoundingClientRect();
      if (cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom) return cs[i];
    }
    return null;
  }
  function hover(c) {
    if (overCard === c) return;
    if (overCard) overCard.classList.remove('xin-over');
    overCard = c;
    if (c) c.classList.add('xin-over');
    setMood(c ? 'over' : '');
  }
  function plug(card) {
    setMode('plug'); angT = 0;
    var r = card.getBoundingClientRect(), tr = track.getBoundingClientRect();
    var x1 = r.left + r.width / 2 - tr.left - W / 2, y1 = r.top + r.height / 2 - tr.bottom + H / 2;
    var go = function () {
      setMood('');
      card.classList.remove('xin-over');
      card.classList.add('xin-hit');
      setTimeout(function () { card.classList.remove('xin-hit'); }, 600);
      setMode('away');
      x = clamp(x, 0, maxX()); y = 0; sc = 1; ang = 0; av = 0; place();
      card.click();
      // 没打开（例如工具不存在），就回来
      setTimeout(function () { if (mode === 'away' && !body.classList.contains('tool-open')) dropIn(0); }, 400);
    };
    if (reduce) { go(); return; }
    fly(x1, y1, 0.3, Math.min(y, y1) - 24, 300, easeOut, go);
  }

  el.addEventListener('pointerdown', function (e) {
    if (e.button > 0 || mode === 'plug' || mode === 'away' || drag) return;
    e.preventDefault(); e.stopPropagation();
    lastInput = Date.now();
    try { el.setPointerCapture(e.pointerId); } catch (er) {}
    var r = el.getBoundingClientRect();
    drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, px: e.pageX, py: e.pageY,
      gx: clamp(e.clientX - r.left, 6, W - 6), gy: clamp(e.clientY - r.top, 6, H - 10),
      lx: e.clientX, lt: performance.now(), vx: 0, on: false };
  });
  el.addEventListener('pointermove', function (e) {
    if (!drag || e.pointerId !== drag.id) return;
    if (!drag.on) {
      if (Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy) < 7) return;
      drag.on = true; tw = null;
      if (mode === 'sleep') { clearTimeout(zTm); }
      drag.x0 = x; drag.y0 = y;
      rEl.style.transformOrigin = drag.gx.toFixed(1) + 'px ' + drag.gy.toFixed(1) + 'px';
      setMood(''); setMode('drag'); body.classList.add('xin-drag');
      pupils(0, -0.6);
    }
    var t = performance.now(), dt = Math.max(8, t - drag.lt);
    drag.vx = drag.vx * 0.6 + (e.clientX - drag.lx) / dt * 1000 * 0.4;
    drag.lx = e.clientX; drag.lt = t;
    x = drag.x0 + (e.pageX - drag.px); y = drag.y0 + (e.pageY - drag.py); sc = 1;
    hover(cardAt(e.clientX, e.clientY));
    kick();
  });
  function up(e) {
    if (!drag || e.pointerId !== drag.id) return;
    var d = drag; drag = null;
    if (!d.on) { if (e.type === 'pointerup') tap(); return; }
    body.classList.remove('xin-drag');
    var c = overCard; hover(null);
    if (c && e.type === 'pointerup') plug(c); else flyHome();
  }
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  el.addEventListener('lostpointercapture', up);
  el.addEventListener('contextmenu', function (e) { e.preventDefault(); });

  /* ---------- 对外界的反应 ---------- */
  function poke() { lastInput = Date.now(); if (mode === 'sleep') wake(false); }
  document.addEventListener('pointermove', function (e) {
    if (e.pointerType !== 'mouse' || drag || paused()) return;
    poke(); lookAt(e.clientX, e.clientY, 2600);
  }, { passive: true });
  document.addEventListener('pointerdown', function (e) {
    if (paused() || el.contains(e.target)) return;
    poke(); if (e.pointerType !== 'mouse') lookAt(e.clientX, e.clientY, 1800);
  }, { passive: true, capture: true });
  document.addEventListener('keydown', function () { if (!paused()) poke(); });
  window.addEventListener('scroll', function () { if (!paused()) lastInput = Date.now(); }, { passive: true });

  var q = document.getElementById('q'), empty = document.getElementById('empty'), themeBtn = document.getElementById('themeBtn');
  if (q) {
    q.addEventListener('input', function () { lookEl(q, 1600); });
    q.addEventListener('focus', function () { lookEl(q, 1600); });
  }
  if (empty && window.MutationObserver) new MutationObserver(function () {
    if (!empty.hidden) setMood('sad');
    else if (mood === 'sad') setMood('');
  }).observe(empty, { attributes: true, attributeFilter: ['hidden'] });
  if (themeBtn) themeBtn.addEventListener('click', function () { lookEl(themeBtn, 1200); blink(false); });

  window.addEventListener('resize', function () {
    dims();
    if (mode === 'drag' || mode === 'fly' || mode === 'plug') return;
    x = clamp(x, 0, maxX()); if (mode === 'walk') tx = clamp(tx, 0, maxX()); place();
  });

  /* 打开工具时停下；回到首页时从上面掉回来（或者挥挥手） */
  var wasOpen = body.classList.contains('tool-open');
  function onShell() {
    var open = body.classList.contains('tool-open');
    if (open === wasOpen) return;
    wasOpen = open;
    if (open) {
      stopWalk(); clearTimeout(idleTm); clearTimeout(zTm);
      if (mode === 'sleep') setMode('idle');
      if (mode === 'drag' || mode === 'fly') { tw = null; drag = null; hover(null); body.classList.remove('xin-drag'); }
      if (mode !== 'away' && mode !== 'plug') setMode('away');
      return;
    }
    lastInput = Date.now();
    if (mode === 'away') dropIn(260); else schedule();
  }
  if (window.MutationObserver) new MutationObserver(onShell).observe(body, { attributes: true, attributeFilter: ['class'] });
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { stopWalk(); clearTimeout(idleTm); clearTimeout(zTm); return; }
    lastInput = Date.now();
    if (mode === 'sleep') zz(); else if (!paused()) schedule();
  });

  /* ---------- 出场 ---------- */
  x = Math.round(maxX() * 0.4);
  place();
  if (wasOpen) setMode('away');
  else if (reduce) schedule();
  else dropIn(380);
  blinkLoop();

  window.LimingXin = {
    get mode() { return mode; },
    get mood() { return mood; },
    el: el,
    sleep: function () { setMode('idle'); setMood(''); sleep(); }
  };
})();
