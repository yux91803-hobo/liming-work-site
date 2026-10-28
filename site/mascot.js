/* mascot.js — 首页小芯（像素风）
   标题栏里的一颗像素小芯片：走来走去、眼睛跟着指针/手指、会眨眼，没人理它就睡觉。
   点它会跳，连点会晕；按住拖到某张卡片上松手，就打开那个工具。 */
(function () {
  'use strict';
  var track = document.getElementById('xinTrack'), grid = document.getElementById('grid');
  if (!track || !grid || !window.requestAnimationFrame) return;
  var body = document.body;
  var reduce = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
  var W = 48, H = 48, SLEEP_AFTER = 30000;   // W/H 在元素挂上后按实际尺寸更新（大屏会放大一点）

  /* 16×16 像素网格：俯视的 QFP 小芯片，四边各 4 根引脚，底边那排当脚；脸上只有两个方块眼 */
  function R(x, y, w, h, c) { return '<rect' + (c ? ' class="' + c + '"' : '') + ' x="' + x + '" y="' + y + '" width="' + (w || 1) + '" height="' + (h || 1) + '"/>'; }
  function pins(side) {
    var o = '', P = [4, 6, 9, 11];
    P.forEach(function (k, i) {
      var c = 'x-pin p' + (i % 2);
      if (side === 't') o += R(k, 1, 1, 2, c);
      if (side === 'b') o += R(k, 13, 1, 2, c);
      if (side === 'l') o += R(1, k, 2, 1, c);
      if (side === 'r') o += R(13, k, 2, 1, c);
    });
    return '<g class="x-side x-' + side + '">' + o + '</g>';
  }
  var SVG = '<svg viewBox="0 0 16 16" width="48" height="48" focusable="false" shape-rendering="crispEdges">' +
    pins('t') + pins('l') + pins('r') + pins('b') +
    R(3, 3, 10, 10, 'x-ol') + R(4, 4, 8, 8, 'x-bd') + R(4, 4, 8, 1, 'x-hi') +
    R(5, 5, 1, 1, 'x-dm') + R(10, 5, 1, 1, 'x-led') +
    R(4, 10, 1, 1, 'x-bl') + R(11, 10, 1, 1, 'x-bl') +
    '<g class="x-face">' +
      '<g class="x-f x-eyes">' + R(5, 7, 2, 2) + R(9, 7, 2, 2) + '</g>' +
      '<g class="x-f x-blk">' + R(5, 8, 2, 1) + R(9, 8, 2, 1) + '</g>' +
      '<g class="x-f x-hap">' + R(4, 8) + R(5, 7) + R(6, 8) + R(9, 8) + R(10, 7) + R(11, 8) + '</g>' +
      '<g class="x-f x-shut">' + R(5, 8, 2, 1) + R(9, 8, 2, 1) + '</g>' +
      '<g class="x-f x-dz">' + R(4, 6) + R(6, 6) + R(5, 7) + R(4, 8) + R(6, 8) + R(9, 6) + R(11, 6) + R(10, 7) + R(9, 8) + R(11, 8) + '</g>' +
      '<g class="x-f x-wow">' + R(5, 6, 2, 3) + R(9, 6, 2, 3) + '</g>' +
      '<g class="x-f x-sad">' + R(5, 8, 2, 2) + R(9, 8, 2, 2) + R(5, 6) + R(6, 5) + R(10, 6) + R(9, 5) + '</g>' +
    '</g>' +
    '</svg>';

  var el = document.createElement('div');
  el.className = 'xin';
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = '<div class="xin-sh"></div><div class="xin-r"><div class="xin-s">' + SVG + '</div></div>';
  track.appendChild(el);
  var rEl = el.querySelector('.xin-r'), sEl = el.querySelector('.xin-s'), shEl = el.querySelector('.xin-sh');
  function dims() { W = el.offsetWidth || 48; H = el.offsetHeight || 48; }
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
    el.style.transform = 'translate3d(' + Math.round(x) + 'px,' + Math.round(y) + 'px,0)' + (sc !== 1 ? ' scale(' + sc.toFixed(3) + ')' : '');
    var q = Math.round(ang / 12) * 12;            // 像素风：摆动角度按 12° 一档跳
    rEl.style.transform = q ? 'rotate(' + q + 'deg)' : '';
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
  // 眼睛整体按像素格挪：-1 / 0 / 1
  function pupils(px, py) {
    el.style.setProperty('--px', clamp(Math.round(px / 1.6), -1, 1) + 'px');
    el.style.setProperty('--py', clamp(Math.round(py / 1.6), -1, 1) + 'px');
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

  /* ---------- 小粒子：睡觉的 z、开心时蹦出的像素块 ---------- */
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
      particle('xin-p', '', x + W / 2 - 3, topY() + 4, Math.round(Math.cos(a) * 26 / 3) * 3, Math.round((Math.sin(a) * 24 - 6) / 3) * 3);
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
    play(sEl, [{ transform: 'translateY(3px)' }, { transform: 'translateY(-3px)', offset: 0.5 }, { transform: 'none' }], 240, 'steps(3, end)');
    schedule();
  }
  // 跳：一格一格地上去再下来（每格 3px），不做压扁拉伸，像素不会糊
  function jump(h) {
    var n = Math.max(2, Math.round(h / 3)), fr = [];
    for (var i = 0; i <= n * 2; i++) { var k = i <= n ? i : n * 2 - i; fr.push({ transform: k ? 'translateY(-' + Math.round(k * h / n / 3) * 3 + 'px)' : 'none' }); }
    play(sEl, fr, 70 * n * 2, 'linear');
    play(shEl, [{ opacity: 1 }, { opacity: 0.3, offset: 0.5 }, { opacity: 1 }], 70 * n * 2, 'steps(3, end)');
  }
  function stretch() {
    play(sEl, [{ transform: 'none' }, { transform: 'translateY(-3px)', offset: 0.3 }, { transform: 'translateY(-3px)', offset: 0.7 }, { transform: 'none' }], 500, 'steps(4, end)');
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
      rEl.style.transformOrigin = '50% 50%';
      play(rEl, [0, 90, 180, 270, 360, 450, 540, 630, 720].map(function (a) { return { transform: 'rotate(' + a + 'deg)' }; }), 720, 'steps(8, end)');
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
