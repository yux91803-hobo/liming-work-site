/* mascot.js — 小芯（像素风），首页和 STM32 学习台共用
   一块像素小芯片：两只引脚手、四只引脚脚、两个方块眼。整个页面都是它的地盘：
   首页能站在标题栏、每张卡片的上沿，也能跳进卡片里沿着底边走；学习台里在芯片图、标题区、代码框这些方块的上沿走来走去。
   平台之间先蹲一下再划弧线跳过去，落到方块上时那块被压得往下沉一下；页面滚走了，它会跳回你正在看的地方。
   学习台里只有被你从首页拖着扔进 STM32 卡片时才有小芯；关掉学习台，它跳回首页。
   会眨眼、眼睛跟着指针/手指，没人理就坐下睡觉；闲着会从背后摸出饼干吃、抛小球、玩 LED。
   点它会跳，连点会晕；拎起来乱蹬，半空松手就往下掉到最近的方块上；首页拖到卡片上松手就打开那个工具。
   画法：20×20 像素格，每一帧按「姿势」重新拼出所有方块（逐帧动画，不做缩放旋转插值）。
   坐标：小芯挂在 body 下的一层（.xin-layer），x / y 是它左上角在整个文档里的位置。 */
(function () {
  'use strict';
  if (!window.requestAnimationFrame || !document.body) return;
  var track = document.getElementById('xinTrack'), grid = document.getElementById('grid');
  var HOME = !!(track && grid), STM = !HOME && !!document.getElementById('main');
  if (!HOME && !STM) return;
  var body = document.body;
  var reduce = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
  var G = 20, W = 80, H = 80, SLEEP_AFTER = 30000;
  // 学习台里能站的方块（只站上沿）
  var STM_SEL = ['.chipv-stage', '.mtags', '.legend', '.pdetail', '.th', '.snav-i.on', '.points', '.dv-mode', 'figure.code', '.tnext-i', '.mrow', '.ptile', '.fcard',
    '.dv-fn', '.mtable', '.dv-task', '.trow', '.path-list', '.bgroup', '.pg-h', '.dv-hero', '.dv-w', '.dv-row', '.dv-map', '.dv-next', '.cd-step', '.cd-method', '.rgroup', '.chap'];

  /* ---------- 像素造型 ----------
     身子：x 4..15、y 7..16（外框一圈深色，顶边正中一个芯片缺口）；姿势里的 b 是身子往下蹲几格。
     脚：x = 5 / 7 / 12 / 14（都在身子里面，中间两条隔得开一点），3 格长，从身子下面到地面 y = 19；蹲下时脚尖往外撇。
     手：从身子两侧水平伸出来。
     下面 ARM / FACE / 饼干 / LED 的坐标都按身子在 y 6 写的，画的时候整体再往下挪 OY 格。 */
  var LEG_X = [5, 7, 12, 14], OY = 1;
  // 手是一根粗引脚（2 格粗、3 格长），不分节：平时水平伸出、垂直于身子侧边，做动作时整根换个朝向。
  // [x, y, 宽, 高]，左手；右手按 x → 20 - x - 宽 镜像
  var ARM = {
    out:    [[1, 10, 3, 2]],
    swingF: [[1, 9, 3, 2]],
    swingB: [[1, 11, 3, 2]],
    up:     [[2, 7, 2, 3]],
    wave:   [[3, 9, 1, 2], [2, 8, 1, 2], [1, 7, 1, 2]],
    hold:   [[2, 10, 2, 2]],
    back:   [[3, 10, 1, 2]],
    down:   [[2, 11, 2, 3]]
  };
  // 脸：[x, y, 宽, 高, 颜色]；eyes / blink 会跟着视线挪一格
  var FACE = {
    eyes:  function (lx, ly) { return [[6 + lx, 8 + ly, 2, 2], [12 + lx, 8 + ly, 2, 2]]; },
    blink: function (lx, ly) { return [[6 + lx, 9 + ly, 2, 1], [12 + lx, 9 + ly, 2, 1]]; },
    hap:   [[5, 9], [6, 8, 2, 1], [8, 9], [11, 9], [12, 8, 2, 1], [14, 9]],
    shut:  [[6, 9, 2, 1, 'g'], [12, 9, 2, 1, 'g']],
    dz:    [[5, 7], [7, 7], [6, 8], [5, 9], [7, 9], [12, 7], [14, 7], [13, 8], [12, 9], [14, 9]],
    wow:   [[6, 7, 2, 3], [12, 7, 2, 3]],
    sad:   [[6, 10, 2, 1], [12, 10, 2, 1]]
  };
  // 圆饼干 4×4（ck 饼干色、cc 巧克力豆），从上往下一口一口咬
  var COOKIE = [[1, 0, 'ck'], [2, 0, 'ck'], [0, 1, 'ck'], [1, 1, 'cc'], [2, 1, 'ck'], [3, 1, 'ck'], [0, 2, 'ck'], [1, 2, 'ck'], [2, 2, 'ck'], [3, 2, 'cc'], [1, 3, 'ck'], [2, 3, 'ck']];
  var BITE_ROWS = [-1, 0, 1, 3];   // 咬了 n 口以后，第几行（含）以上都没了

  function straight(x) { return [[x, 17], [x, 18], [x, 19]]; }
  // 蹲：脚变短，脚尖往外撇（b = 1 蹲一格，b = 2 蹲到底）
  function bent(x, s, b) { return b === 1 ? [[x, 18], [x + s, 19]] : [[x + s, 19]]; }

  function draw(p) {
    var o = [], lb = p.b | 0, b = lb + OY, sx = p.sx | 0, i;
    function R(x, y, w, h, c) { o.push('<rect class="c-' + c + '" x="' + x + '" y="' + y + '" width="' + (w || 1) + '" height="' + (h || 1) + '"/>'); }
    // 脚（画在身子后面）
    for (i = 0; i < 4; i++) {
      var lx = LEG_X[i], s = i < 2 ? -1 : 1, A = i % 2 === 0, q = p.lp | 0, pix;
      if (p.legs === 'walk') pix = ((q === 0 && A) || (q === 2 && !A)) ? [[lx, 17], [lx + (p.dir || 1), 18]] : (lb ? bent(lx, s, lb) : straight(lx));
      else if (p.legs === 'tuck') pix = [[lx, 17 + lb], [lx + s, 18 + lb]];
      else if (p.legs === 'dangle') pix = ((q === 0) === A) ? straight(lx) : [[lx, 17], [lx - s, 18]];
      else pix = lb ? bent(lx, s, lb) : straight(lx);
      pix.forEach(function (c) { R(c[0], c[1], 1, 1, 'p'); });
    }
    // 身子
    var X = 4 + sx, Y = 6 + b;
    R(X, Y, 5, 1, 'o'); R(X + 7, Y, 5, 1, 'o'); R(X, Y + 1, 1, 9, 'o'); R(X + 11, Y + 1, 1, 9, 'o'); R(X, Y + 9, 12, 1, 'o');
    R(X + 1, Y + 1, 10, 8, 'b'); R(X + 5, Y + 1, 2, 1, 'o');
    // 脸
    var f = FACE[p.face] || FACE.eyes, fl = typeof f === 'function' ? f(p.lx | 0, p.ly | 0) : f;
    fl.forEach(function (c) { R(c[0] + sx, c[1] + b, c[2] || 1, c[3] || 1, c[4] || 'w'); });
    // 手里的东西
    var it = p.item;
    if (it && it.k === 'cookie') {
      var gone = BITE_ROWS[Math.min(3, it.n | 0)];
      COOKIE.forEach(function (c) { if (c[1] > gone) R(8 + c[0] + sx, 12 + c[1] + b, 1, 1, c[2]); });
    }
    if (it && it.k === 'led') {
      var LX = 8 + sx, LY = 12 + b;
      R(LX + 1, LY, 2, 2, it.on ? 'lon' : 'led'); R(LX, LY + 2, 4, 1, 'lb'); R(LX + 1, LY + 3, 1, 1, 'p'); R(LX + 2, LY + 3, 1, 1, 'p');
      if (it.on) { R(LX, LY - 1, 1, 1, 'gl'); R(LX + 3, LY - 1, 1, 1, 'gl'); R(LX - 1, LY + 1, 1, 1, 'gl'); R(LX + 4, LY + 1, 1, 1, 'gl'); }
    }
    // 嘴：只有吃东西时才有（1 合上，2 张开咬下去）
    if (p.mouth) R(9 + sx, 11 + b, 2, p.mouth === 2 ? 2 : 1, 'o');
    // 手（在身子前面）
    [[p.armL || 'out', false], [p.armR || 'out', true]].forEach(function (a) {
      (ARM[a[0]] || ARM.out).forEach(function (c) { R((a[1] ? 20 - c[0] - c[2] : c[0]) + sx, c[1] + b, c[2], c[3], 'p'); });
    });
    if (it && it.k === 'ball') { R(it.x, it.y, 2, 2, 'ball'); R(it.x, it.y, 1, 1, 'bh'); }
    // 灰、饼干渣（绝对位置）
    (p.fx || []).forEach(function (c) { R(c[0], c[1], 1, 1, c[2]); });
    return o.join('');
  }

  var layer = document.createElement('div');
  layer.className = 'xin-layer' + (STM ? ' in-stm' : '');
  var el = document.createElement('div');
  el.className = 'xin';
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = '<div class="xin-r"><div class="xin-s"><svg viewBox="0 0 20 20" focusable="false" shape-rendering="crispEdges"></svg></div></div>';
  layer.appendChild(el); body.appendChild(layer);
  var rEl = el.querySelector('.xin-r'), sEl = el.querySelector('.xin-s'), svgEl = el.querySelector('svg');
  function dims() { W = el.offsetWidth || 80; H = el.offsetHeight || 80; }
  dims();

  /* ---------- 状态 ---------- */
  var x = -999, y = -999, sc = 1, ang = 0, av = 0, angT = 0;
  var mode = 'away';                   // idle walk drag fly plug away sleep play
  var tx = 0, dir = 1, raf = 0, lastT = 0, tw = null, drag = null, overCard = null, plat = null;
  var mood = '', moodTm = 0, lookTm = 0, look = { x: 0, y: 0 }, looking = false, blinking = false;
  var seq = null, lastSig = '', tick = 0, forced = null;
  var lastInput = Date.now(), idleTm = 0, blinkTm = 0, zTm = 0, taps = [];

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function mix(a, b) { var o = {}, k; for (k in a) o[k] = a[k]; for (k in b) o[k] = b[k]; return o; }
  function sX() { return window.pageXOffset || 0; }
  function sY() { return window.pageYOffset || 0; }
  // 学习台嵌在工具箱的面板里：面板收起时（不在看）就歇着
  var panel = null;
  try { panel = window.frameElement && window.frameElement.closest ? window.frameElement.closest('.panel') : null; } catch (e) { panel = null; }
  function hiddenFrame() { return !!panel && !panel.classList.contains('show'); }
  // 「小芯被扔进了哪个工具」：首页把它拖到卡片上松手时记下，学习台里的小芯只有看到这个才出来；回到首页时清掉
  var CARRY = 'lm.xin.in';
  function carried() { try { return sessionStorage.getItem(CARRY) || ''; } catch (e) { return ''; } }
  function carry(v) { try { if (v) sessionStorage.setItem(CARRY, v); else sessionStorage.removeItem(CARRY); } catch (e) {} }
  function paused() {
    if (document.hidden) return true;
    if (HOME) return body.classList.contains('tool-open');
    return !panel || hiddenFrame() || carried() !== 'stm32';   // 学习台：只有被扔进来才出来
  }
  function cls(c, on) { el.classList.toggle(c, !!on); }
  function place() {
    el.style.transform = 'translate3d(' + Math.round(x) + 'px,' + Math.round(y) + 'px,0)' + (sc !== 1 ? ' scale(' + sc.toFixed(3) + ')' : '');
    var q = Math.round(ang / 12) * 12;            // 像素风：摆动角度按 12° 一档跳
    rEl.style.transform = q ? 'rotate(' + q + 'deg)' : '';
  }
  function setMode(m) {
    if (mode === 'play' && m !== 'play') stopSeq();
    mode = m;
    cls('is-drag', m === 'drag'); cls('is-air', m === 'drag' || m === 'fly' || m === 'plug'); cls('is-away', m === 'away');
    render();
  }
  function setMood(m, ms) {
    clearTimeout(moodTm);
    mood = m || '';
    if (mood && ms) moodTm = setTimeout(function () { setMood(''); }, ms);
    render();
  }

  /* ---------- 平台：能站的地方 ----------
     { el, kind, x0, x1, fy }：x0..x1 是小芯左上角 x 的可走范围，fy 是脚踩的那条线（文档坐标）。
     kind：ground 首页标题栏；top 方块上沿；in 首页卡片里面，沿着底边走。 */
  function shown(e) { return !!e && document.documentElement.contains(e) && !(e.closest && e.closest('[hidden],.hide')) && e.getClientRects().length > 0; }
  function platOf(e, kind) {
    if (!shown(e)) return null;
    var r = e.getBoundingClientRect(), ox = sX(), oy = sY();
    if (r.width < 4) return null;
    if (kind === 'ground') return { el: e, kind: kind, x0: r.left + ox, x1: Math.max(r.left + ox, r.right + ox - W), fy: r.bottom + oy + 2 };
    if (kind === 'in') {
      if (r.height < H * 0.8 + 16 || r.width < W + 16) return null;
      return { el: e, kind: kind, x0: r.left + ox + 6, x1: r.right + ox - W - 6, fy: r.bottom + oy - 5 };
    }
    if (r.width < W * 0.8) return null;
    return { el: e, kind: 'top', x0: r.left + ox - W * 0.2, x1: Math.max(r.left + ox - W * 0.2, r.right + ox - W * 0.8), fy: r.top + oy + 1 };
  }
  function plats() {
    var out = [], add = function (p) { if (p) out.push(p); };
    if (HOME) {
      add(platOf(track, 'ground'));
      grid.querySelectorAll('.card[data-id]').forEach(function (c) { add(platOf(c, 'top')); add(platOf(c, 'in')); });
    } else {
      document.querySelectorAll(STM_SEL.join(',')).forEach(function (e) { add(platOf(e, 'top')); });
    }
    return out;
  }
  function same(a, b) { return !!a && !!b && a.el === b.el && a.kind === b.kind; }
  // 学习台顶上有一条吸顶的栏（手机上），小芯的身子不能钻到它底下
  function topPad() {
    if (HOME) return 0;
    var b = document.getElementById('bar'), r = b && b.getBoundingClientRect();
    return r && r.height && r.bottom > 0 ? r.bottom : 0;
  }
  function inView(p) {
    var top = sY() + topPad(), bot = sY() + innerHeight - 8;
    return p.fy - H * 0.62 > top && p.fy < bot;
  }
  function onScreen() { var feet = y + H; return feet > sY() + 20 && y < sY() + innerHeight - 20; }
  // 页面里最合适落脚的地方：看得见的平台里离屏幕中间最近的（首页优先标题栏）
  function bestPlat() {
    var ps = plats().filter(function (p) { return inView(p); });
    if (HOME) { var g = ps.filter(function (p) { return p.kind === 'ground'; })[0]; if (g) return g; }
    if (!ps.length) return null;
    var mid = sY() + innerHeight * 0.45;
    ps.sort(function (a, b) { return Math.abs(a.fy - mid) - Math.abs(b.fy - mid); });
    return ps[0];
  }
  // 站在平台上：每一拍跟着平台挪（布局变了、卡片按下去了）；平台没了就掉下去
  function follow() {
    if (!plat || !(mode === 'idle' || mode === 'walk' || mode === 'sleep' || mode === 'play')) return;
    var np = platOf(plat.el, plat.kind);
    if (!np) { plat = null; fall(); return; }
    plat = np;
    var nx = clamp(x, np.x0, np.x1), ny = np.fy - H;
    if (mode === 'walk') tx = clamp(tx, np.x0, np.x1);
    if (Math.abs(nx - x) > 0.5 || Math.abs(ny - y) > 0.5) { x = nx; y = ny; place(); }
  }

  /* ---------- 姿势：基础姿势（由状态决定）+ 正在播放的那一帧 ---------- */
  function base(t) {
    var p = { b: 0, sx: 0, legs: 'stand', lp: 0, dir: dir, armL: 'out', armR: 'out', face: 'eyes', lx: look.x, ly: look.y, mouth: 0, item: null, fx: null, dy: 0 };
    if (mode === 'walk') {
      var q = Math.floor(t / 90) % 4;
      p.legs = 'walk'; p.lp = q; p.b = q % 2;
      p.armL = q < 2 ? 'swingF' : 'swingB'; p.armR = q < 2 ? 'swingB' : 'swingF';
      if (!looking) { p.lx = dir; p.ly = 0; }
    } else if (mode === 'drag') {
      p.legs = 'dangle'; p.lp = Math.floor(t / 170) % 2; p.armL = p.armR = 'wave'; p.face = 'wow';
    } else if (mode === 'fly' || mode === 'plug') {
      p.legs = 'tuck'; p.armL = p.armR = 'up'; p.face = 'wow';
    } else if (mode === 'sleep') {
      p.b = Math.floor(t / 1700) % 2 ? 2 : 1; p.face = 'shut'; p.armL = p.armR = 'down';   // 坐着，手放下，一呼一吸
    }
    if (mood === 'happy') { var w = Math.floor(t / 170) % 2; p.face = 'hap'; p.armL = w ? 'up' : 'wave'; p.armR = w ? 'wave' : 'up'; }
    else if (mood === 'over') { p.face = 'hap'; p.armL = p.armR = Math.floor(t / 140) % 2 ? 'up' : 'wave'; }
    else if (mood === 'dizzy') { p.face = 'dz'; p.sx = Math.floor(t / 150) % 2; p.armL = 'wave'; p.armR = 'swingB'; }
    else if (mood === 'sad') { p.face = 'sad'; p.b = Math.max(p.b, 1); p.lx = 0; p.ly = 0; p.armL = p.armR = 'down'; }
    else if (mood === 'wow') { p.face = 'wow'; p.armL = p.armR = 'wave'; }
    return p;
  }
  function render() {
    var p = base(performance.now()), k;
    if (seq && seq.cur) for (k in seq.cur) if (k !== 't' && k !== 'fn') p[k] = seq.cur[k];
    if (forced) for (k in forced) p[k] = forced[k];
    if (blinking && p.face === 'eyes') p.face = 'blink';
    var sig = JSON.stringify(p);
    if (sig === lastSig) return;
    lastSig = sig;
    svgEl.innerHTML = draw(p);
    var S = W / G;
    sEl.style.transform = p.dy ? 'translateY(' + Math.round(p.dy * S) + 'px)' : '';
  }
  function ticker(on) {
    clearInterval(tick); tick = 0;
    if (on) tick = setInterval(render, 45);
  }

  /* ---------- 逐帧播放 ---------- */
  function playSeq(frames, done) {
    stopSeq();
    if (reduce || !frames.length) { if (done) done(); return; }
    seq = { frames: frames, i: -1, done: done, cur: null, tm: 0 };
    nextFrame();
  }
  function nextFrame() {
    if (!seq) return;
    seq.i++;
    if (seq.i >= seq.frames.length) { var d = seq.done; seq = null; render(); if (d) d(); return; }
    seq.cur = seq.frames[seq.i];
    if (seq.cur.fn) seq.cur.fn();
    render();
    var s = seq;
    s.tm = setTimeout(function () { if (seq === s) nextFrame(); }, seq.cur.t || 100);
  }
  function stopSeq() { if (seq) { clearTimeout(seq.tm); seq = null; render(); } }

  // 跳：先蹲两格蓄力 → 伸腿起跳 → 空中收腿、举手 → 伸腿下落 → 落地屈膝缓冲、扬灰
  function landFrames(drop) {
    return [
      { b: 2, armL: 'swingB', armR: 'swingB', fx: [[3, 19, 'd'], [16, 19, 'd']], t: 90, fn: function () { press(drop); } },
      { b: 1, armL: 'out', armR: 'out', fx: [[2, 19, 'd'], [1, 18, 'd'], [17, 19, 'd'], [18, 18, 'd']], t: 90 },
      { b: 0, fx: [[0, 18, 'd'], [19, 18, 'd']], t: 70 }
    ];
  }
  function jumpFrames(h) {
    var a = Math.max(1, Math.round(h * 0.4)), c = Math.max(1, Math.round(h * 0.8));
    return [
      { b: 1, t: 70 },
      { b: 2, armL: 'swingB', armR: 'swingB', t: 90 },
      { legs: 'stand', armL: 'up', armR: 'up', dy: -a, t: 60 },
      { legs: 'tuck', armL: 'up', armR: 'up', dy: -c, t: 70 },
      { legs: 'tuck', armL: 'wave', armR: 'wave', dy: -h, t: 110 },
      { legs: 'stand', armL: 'swingF', armR: 'swingF', dy: -c, t: 70 },
      { legs: 'stand', armL: 'out', armR: 'out', dy: -a, t: 60 }
    ].concat(landFrames(h * W / G));
  }
  function jump(h, done) { playSeq(jumpFrames(h), done); }

  /* ---------- 自己玩：从背后摸出东西 ---------- */
  function reach() { return [{ armR: 'back', lx: 1, t: 280 }, { armR: 'back', lx: 1, ly: 1, t: 220 }]; }
  function putAway() { return [{ armR: 'back', lx: 1, t: 240 }, { t: 120 }]; }
  var TOYS = {
    cookie: function () {
      var Hd = { armL: 'hold', armR: 'hold' }, f = reach();
      f.push(mix(Hd, { item: { k: 'cookie', n: 0 }, lx: 0, ly: 1, t: 650 }));
      f.push(mix(Hd, { item: { k: 'cookie', n: 0 }, face: 'hap', t: 320 }));
      for (var n = 1; n <= 3; n++) {
        f.push(mix(Hd, { item: { k: 'cookie', n: n - 1 }, mouth: 2, ly: 1, t: 220 }));
        f.push(mix(Hd, { item: { k: 'cookie', n: n }, mouth: 1, face: 'hap', fx: [[9 + n % 2, 16, 'ck']], t: 140 }));
        f.push(mix(Hd, { item: { k: 'cookie', n: n }, mouth: 1, face: 'hap', b: 1, fx: [[10 - n % 2, 17, 'ck']], t: 140 }));
        f.push(mix(Hd, { item: { k: 'cookie', n: n }, mouth: 1, face: 'hap', fx: [[9 + n % 2, 19, 'ck']], t: 180 }));
      }
      f.push({ face: 'hap', fx: [[9, 19, 'ck'], [11, 19, 'ck']], t: 260 });
      return { frames: f, after: function () { setMood('happy', 900); jump(2); } };
    },
    ball: function () {
      var U = { armR: 'up' }, f = reach(), ys = [4, 1, -1, -2, -1, 1, 4, 6], r;
      f.push(mix(U, { item: { k: 'ball', x: 16, y: 6 }, lx: 1, ly: -1, t: 420 }));
      function toss(yy, i) { f.push(mix(U, { armR: i === 0 || i === ys.length - 1 ? 'up' : 'wave', item: { k: 'ball', x: 16, y: yy }, lx: 1, ly: -1, t: 70 })); }
      for (r = 0; r < 2; r++) ys.forEach(toss);
      // 最后一下抛歪了，正好砸到自己头上
      [[16, 2], [14, -1], [12, -2], [10, 0], [9, 3]].forEach(function (c) { f.push(mix(U, { armR: 'wave', item: { k: 'ball', x: c[0], y: c[1] }, lx: 0, ly: -1, t: 70 })); });
      f.push({ armL: 'wave', armR: 'wave', item: { k: 'ball', x: 9, y: 5 }, face: 'dz', b: 1, t: 260 });
      [[11, 2], [13, 1], [15, 3], [17, 7], [18, 12], [19, 16], [21, 18], [24, 18], [27, 18]].forEach(function (c, i) {
        f.push({ item: { k: 'ball', x: c[0], y: c[1] }, face: i < 3 ? 'dz' : 'eyes', lx: 1, ly: c[1] < 8 ? -1 : 1, b: i < 2 ? 1 : 0, t: 70 });
      });
      f.push({ face: 'eyes', lx: 1, ly: 1, t: 600 });
      return { frames: f, after: function () { blink(true); } };
    },
    led: function () {
      var Hd = { armL: 'hold', armR: 'hold' }, f = reach(), i;
      f.push(mix(Hd, { item: { k: 'led', on: false }, ly: 1, t: 520 }));
      for (i = 0; i < 4; i++) {
        f.push(mix(Hd, { item: { k: 'led', on: true }, face: 'hap', t: 260 }));
        f.push(mix(Hd, { item: { k: 'led', on: false }, ly: 1, t: 230 }));
      }
      f.push(mix(Hd, { item: { k: 'led', on: true }, face: 'wow', t: 520 }));
      return { frames: f.concat(putAway()), after: null };
    }
  };
  function playToy(name) {
    if (reduce || paused() || mode === 'drag' || mode === 'away') return;
    var toy = TOYS[name](); stopWalk(); setMood('');
    setMode('play');
    playSeq(toy.frames, function () { if (mode === 'play') { mode = 'idle'; render(); } if (toy.after) toy.after(); schedule(); });
  }

  /* ---------- 眼睛 ---------- */
  // 视线按像素格挪：-1 / 0 / 1
  function pupils(px, py) { look = { x: clamp(Math.round(px / 1.6), -1, 1), y: clamp(Math.round(py / 1.6), -1, 1) }; render(); }
  function lookAt(cx, cy, hold) {
    var r = el.getBoundingClientRect();
    var dx = cx - (r.left + r.width / 2), dy = cy - (r.top + r.height * 0.45);
    var d = Math.sqrt(dx * dx + dy * dy) || 1, k = Math.min(1, d / 90);
    looking = true; clearTimeout(lookTm);
    pupils(dx / d * 2.2 * k, dy / d * 1.9 * k);
    lookTm = setTimeout(function () { looking = false; if (mode !== 'walk') pupils(0, 0); }, hold || 2200);
  }
  function lookEl(node, hold) {
    if (!node) return;
    var r = node.getBoundingClientRect();
    lookAt(r.left + r.width / 2, r.top + r.height / 2, hold);
  }
  function blink(twice) {
    blinking = true; render();
    setTimeout(function () {
      blinking = false; render();
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


  /* ---------- 小粒子：睡觉的 z、开心时蹦出的像素块（都挂在小芯那一层，用文档坐标） ---------- */
  function particle(c, ch, left, top, dx, dy) {
    var s = document.createElement('span');
    s.className = c; s.textContent = ch;
    s.style.left = left.toFixed(1) + 'px'; s.style.top = top.toFixed(1) + 'px';
    if (dx != null) { s.style.setProperty('--dx', dx.toFixed(1) + 'px'); s.style.setProperty('--dy', dy.toFixed(1) + 'px'); }
    s.addEventListener('animationend', function () { s.remove(); });
    layer.appendChild(s);
    setTimeout(function () { if (s.parentNode) s.remove(); }, 3000);
  }
  function headY() { return y + H * (6 + OY) / G; }
  function sparks(n) {
    if (reduce) return;
    for (var i = 0; i < n; i++) {
      var a = -Math.PI / 2 + (i - (n - 1) / 2) * 0.75 + (Math.random() - 0.5) * 0.3;
      particle('xin-p', '', x + W / 2 - 3, headY() - 6, Math.round(Math.cos(a) * 26 / 3) * 3, Math.round((Math.sin(a) * 24 - 6) / 3) * 3);
    }
  }
  function zz() {
    clearTimeout(zTm);
    if (mode !== 'sleep' || paused()) return;
    if (!reduce) particle('xin-z', Math.random() < 0.5 ? 'z' : 'Z', x + W * 0.72, headY() - 8);
    zTm = setTimeout(zz, 1800);
  }

  /* ---------- 动作 ---------- */
  function land(p) {
    if (p) plat = p;
    setMode('idle');
    var drop = 0;
    if (plat) { x = clamp(x, plat.x0, plat.x1); y = plat.fy - H; drop = y - airFrom; }
    sc = 1; angT = 0; place(); kick();
    playSeq(landFrames(drop));
    schedule();
  }
  /* 重力挤压：落到卡片 / 方块上时，被踩的那块往下沉一下再弹回来；落得越高压得越深。小芯跟着一起沉 */
  var pressing = 0;
  function press(drop) {
    var e = plat && plat.kind !== 'ground' ? plat.el : null;
    if (!e || !e.animate || reduce || !(drop > 6)) return;
    var d = Math.round(clamp(drop / 45, 2, 7));
    e.animate([{ transform: 'none' }, { transform: 'translateY(' + d + 'px)', offset: 0.25 }, { transform: 'translateY(' + Math.round(d / 2) + 'px)', offset: 0.5 },
      { transform: 'translateY(-1px)', offset: 0.75 }, { transform: 'none' }], { duration: 300, easing: 'steps(4, end)', composite: 'add' });
    pressing = performance.now() + 340;
    var step = function () { follow(); if (performance.now() < pressing) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  }
  function walkTo(target) {
    if (!plat) return;
    tx = clamp(target, plat.x0, plat.x1);
    if (Math.abs(tx - x) < 2) return;
    dir = tx > x ? 1 : -1;
    setMode('walk');
    kick();
  }
  function stopWalk() {
    if (mode !== 'walk') return;
    setMode('idle');
  }
  function sleep() {
    if (mode !== 'idle') return;
    setMood(''); look = { x: 0, y: 0 }; setMode('sleep'); zz();
  }
  function wake(startled) {
    if (mode !== 'sleep') return;
    clearTimeout(zTm); setMode('idle');
    if (startled) { setMood('wow', 700); jump(3); }
    else playSeq([{ armL: 'up', armR: 'up', face: 'shut', b: 0, t: 450 }, { armL: 'wave', armR: 'wave', face: 'shut', t: 200 }, { face: 'blink', t: 120 }]);   // 伸个懒腰
    schedule();
  }
  function tap() {
    var t = Date.now();
    taps = taps.filter(function (v) { return t - v < 1600; }); taps.push(t);
    lastInput = t;
    if (mode === 'sleep') { wake(true); return; }
    if (mode === 'play') setMode('idle');
    stopWalk();
    if (taps.length >= 5) {
      taps = [];
      stopSeq();
      rEl.style.transformOrigin = '50% 60%';
      if (!reduce && rEl.animate) rEl.animate([0, 90, 180, 270, 360, 450, 540, 630, 720].map(function (a) { return { transform: 'rotate(' + a + 'deg)' }; }), { duration: 720, easing: 'steps(8, end)' });
      setMood('dizzy', 1900);
      return;
    }
    setMood('happy', 1100); sparks(3); jump(6);
    schedule();
  }
  // 跳到另一个平台：先蹲两格蓄力，再划一道弧线过去，落地屈膝
  function hop(p2, xt) {
    if (!p2) return;
    var x2 = clamp(xt == null ? (p2.x0 + p2.x1) / 2 : xt, p2.x0, p2.x1), y2 = p2.fy - H;
    if (reduce) { x = x2; y = y2; place(); land(p2); return; }
    stopWalk(); dir = x2 > x ? 1 : -1;
    setMode('play');
    playSeq([{ b: 1, lx: dir, t: 80 }, { b: 2, lx: dir, armL: 'swingB', armR: 'swingB', t: 110 }], function () {
      plat = null; setMode('fly');
      var dx = Math.abs(x2 - x), up = Math.max(36, Math.min(160, 40 + dx * 0.25 + Math.max(0, y - y2) * 0.4));
      fly(x2, y2, 1, Math.min(y, y2) - up, clamp(380 + Math.sqrt(dx * dx + (y2 - y) * (y2 - y)) * 0.7, 420, 900), easeInOut, function () { land(p2); });
    });
  }
  // 脚下没东西了：往下掉到下面最近的平台上；下面也没有，就跳到看得见的地方
  function below(px, py) {
    var feet = py + H, best = null;
    plats().forEach(function (p) {
      if (px + W * 0.5 < p.x0 || px > p.x1 + W * 0.5) return;
      if (p.fy < feet - 12) return;
      if (!best || p.fy < best.fy) best = p;
    });
    return best;
  }
  function fall() {
    var p = below(x, y) || bestPlat();
    if (!p) { goAway(); return; }
    if (reduce) { x = clamp(x, p.x0, p.x1); y = p.fy - H; place(); land(p); return; }
    setMode('fly'); angT = 0;
    var x2 = clamp(x, p.x0, p.x1), y2 = p.fy - H, d = Math.abs(y2 - y) + Math.abs(x2 - x);
    fly(x2, y2, 1, Math.min(y, y2) - (y2 > y ? 16 : 50), clamp(300 + d * 0.6, 320, 900), y2 > y ? easeIn : easeInOut, function () { land(p); });
  }
  function goAway() { stopSeq(); tw = null; plat = null; setMode('away'); }
  // 从屏幕上方掉进来，落到 p（默认挑一个看得见的）
  function dropIn(delay, p) {
    p = p || bestPlat();
    if (!p) { setMode('away'); setTimeout(function () { if (mode === 'away' && !paused()) dropIn(0); }, 700); return; }
    setMood(''); stopSeq();
    var x2 = HOME && p.kind === 'ground' ? p.x0 + (p.x1 - p.x0) * 0.4 : p.x0 + (p.x1 - p.x0) * (0.2 + Math.random() * 0.6);
    x = x2; sc = 1; ang = 0; av = 0; angT = 0;
    if (reduce) { y = p.fy - H; setMode('idle'); place(); land(p); return; }
    y = Math.min(sY(), p.fy) - H - 40; setMode('fly'); place();
    setTimeout(function () {
      if (mode !== 'fly') return;
      fly(x2, p.fy - H, 1, y, 460, easeIn, function () { land(p); setMood('happy', 900); });
    }, delay || 0);
  }

  /* 闲着的时候自己找点事做 */
  var toyOrder = ['cookie', 'ball', 'led'], toyI = Math.floor(Math.random() * 3);
  function schedule(ms) { clearTimeout(idleTm); idleTm = setTimeout(think, ms || 2200 + Math.random() * 3800); }
  function think() {
    if (paused()) return;
    if (mode === 'away') { dropIn(0); return; }
    if (mode !== 'idle' || mood || seq) { schedule(); return; }
    if (!onScreen() || !plat) { dropIn(0); return; }      // 页面滚走了：跳回看得见的地方
    if (Date.now() - lastInput > SLEEP_AFTER) { sleep(); return; }
    var r = Math.random(), span = plat.x1 - plat.x0;
    if (!reduce && r < 0.3 && span > 30) {
      var t = plat.x0 + Math.random() * span;
      if (Math.abs(t - x) < 24) t = x - plat.x0 < span / 2 ? Math.min(plat.x1, x + 24 + Math.random() * (plat.x1 - x - 24)) : plat.x0 + Math.random() * Math.max(0, x - plat.x0 - 24);
      walkTo(t);
    } else if (!reduce && r < 0.58) {
      var cand = plats().filter(function (p) {
        if (same(p, plat) || !inView(p)) return false;
        var cx = clamp(x, p.x0, p.x1);
        return Math.abs(cx - x) + Math.abs(p.fy - plat.fy) < (STM ? 520 : 600);
      });
      if (cand.length) { var p2 = cand[Math.floor(Math.random() * cand.length)]; hop(p2, p2.x0 + Math.random() * (p2.x1 - p2.x0)); return; }
      walkTo(plat.x0 + Math.random() * span);
    } else if (!reduce && r < 0.74) {
      playToy(toyOrder[toyI++ % toyOrder.length]); return;
    } else if (r < 0.88) {
      if (!looking) { pupils((Math.random() < 0.5 ? -1 : 1) * 2, (Math.random() - 0.3) * 1.6); setTimeout(function () { if (!looking && mode === 'idle') pupils(0, 0); }, 1300); }
    } else if (!reduce && r < 0.94) jump(2);
    else blink(true);
    schedule();
  }

  /* ---------- 移动循环（只在走路/拖动/飞行/摆动时运行） ---------- */
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
  var airFrom = 0;   // 这次腾空是从多高开始的（算落地压多深）
  function fly(x1, y1, s1, cy, ms, ease, done) {
    airFrom = Math.min(y, cy);
    tw = { t0: performance.now(), dur: ms, x0: x, y0: y, s0: sc, cx: (x + x1) / 2, cy: cy, x1: x1, y1: y1, s1: s1, ease: ease, done: done };
    kick();
  }

  /* ---------- 拖：首页拖到卡片上打开工具；别的地方松手就往下掉 ---------- */
  function cardAt(cx, cy) {
    if (!HOME) return null;
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
    var r = card.getBoundingClientRect();
    var x1 = r.left + sX() + r.width / 2 - W / 2, y1 = r.top + sY() + r.height / 2 - H / 2;
    var go = function () {
      setMood('');
      card.classList.remove('xin-over');
      card.classList.add('xin-hit');
      setTimeout(function () { card.classList.remove('xin-hit'); }, 600);
      goAway(); sc = 1; ang = 0; av = 0; place();
      carry(card.dataset.id || 'tool');     // 小芯被扔进了这个工具
      card.click();
      // 没打开（例如工具不存在），就回来
      setTimeout(function () { if (mode === 'away' && !body.classList.contains('tool-open')) { carry(''); dropIn(0); } }, 400);
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
      gx: clamp(e.clientX - r.left, 6, W - 6), gy: clamp(e.clientY - r.top, H * 0.3, H - 10),
      lx: e.clientX, lt: performance.now(), vx: 0, on: false };
  });
  el.addEventListener('pointermove', function (e) {
    if (!drag || e.pointerId !== drag.id) return;
    if (!drag.on) {
      if (Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy) < 7) return;
      drag.on = true; tw = null; plat = null;
      if (mode === 'sleep') clearTimeout(zTm);
      drag.x0 = x; drag.y0 = y;
      rEl.style.transformOrigin = drag.gx.toFixed(1) + 'px ' + drag.gy.toFixed(1) + 'px';
      stopSeq(); setMood(''); look = { x: 0, y: -1 }; setMode('drag'); body.classList.add('xin-drag');
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
    var c = overCard; hover(null); look = { x: 0, y: 0 };
    if (c && e.type === 'pointerup') plug(c); else fall();
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
  var scrollTm = 0;
  window.addEventListener('scroll', function () {
    if (paused()) return;
    lastInput = Date.now();
    // 滚动停下来以后，如果小芯已经不在屏幕上，就跳回来
    clearTimeout(scrollTm);
    scrollTm = setTimeout(function () { if (!onScreen() && (mode === 'idle' || mode === 'walk' || mode === 'sleep' || mode === 'play')) { stopSeq(); clearTimeout(zTm); dropIn(0); } }, 700);
  }, { passive: true });

  if (HOME) {
    var q = document.getElementById('q'), empty = document.getElementById('empty'), themeBtn = document.getElementById('themeBtn');
    if (q) {
      q.addEventListener('input', function () { lookEl(q, 1600); });
      q.addEventListener('focus', function () { lookEl(q, 1600); });
    }
    if (empty && window.MutationObserver) new MutationObserver(function () {
      if (!empty.hidden) { if (mode === 'play') setMode('idle'); setMood('sad'); }
      else if (mood === 'sad') setMood('');
    }).observe(empty, { attributes: true, attributeFilter: ['hidden'] });
    if (themeBtn) themeBtn.addEventListener('click', function () { lookEl(themeBtn, 1200); blink(false); });
  }

  window.addEventListener('resize', function () {
    dims(); lastSig = ''; render();
    if (mode === 'drag' || mode === 'fly' || mode === 'plug') return;
    follow();
  });

  /* 首页：打开工具时小芯在面板后面歇着。正常点开工具再关掉，它还在原来的地方；
     要是它被扔进了工具（carried），关掉工具时它从工具里出来，掉回首页。
     学习台在面板里：被扔进来时掉进来，面板收起时歇着。 */
  var saved = null;
  function pause() {
    stopWalk(); stopSeq(); clearTimeout(idleTm); clearTimeout(zTm); ticker(false);
    if (mode === 'drag' || mode === 'fly' || mode === 'plug') { tw = null; drag = null; hover(null); body.classList.remove('xin-drag'); }
    saved = mode !== 'away' && plat ? { plat: plat, x: x } : null;
    goAway();
  }
  function resume(delay) {
    lastInput = Date.now(); ticker(true);
    if (HOME && carried()) { carry(''); saved = null; dropIn(delay); return; }
    var sv = saved, p = sv && platOf(sv.plat.el, sv.plat.kind); saved = null;
    if (p) { plat = p; x = clamp(sv.x, p.x0, p.x1); y = p.fy - H; setMode('idle'); place(); schedule(); return; }
    dropIn(delay);
  }
  var wasPaused = paused();
  function onState() {
    var p = paused();
    if (p === wasPaused) return;
    wasPaused = p;
    if (p) pause(); else resume(HOME ? 260 : 300);
  }
  if (window.MutationObserver) {
    if (HOME) new MutationObserver(onState).observe(body, { attributes: true, attributeFilter: ['class'] });
    if (panel) new MutationObserver(onState).observe(panel, { attributes: true, attributeFilter: ['class'] });
  }
  document.addEventListener('visibilitychange', onState);
  setInterval(function () { if (!paused()) follow(); }, 120);

  /* ---------- 出场 ---------- */
  place(); render();
  if (!wasPaused) {
    ticker(true);
    // 学习台的内容是脚本画出来的，等它画好再掉进来
    var tries = 0, start = function () {
      if (paused()) return;
      if (!bestPlat() && tries++ < 20) { setTimeout(start, 300); return; }
      dropIn(HOME ? 380 : 200);
    };
    start();
  }
  blinkLoop();

  window.LimingXin = {
    get mode() { return mode; },
    get mood() { return mood; },
    get plat() { return plat ? { kind: plat.kind, el: plat.el } : null; },
    el: el,
    sleep: function () { setMode('idle'); setMood(''); sleep(); },
    toy: playToy,
    jump: function () { tap(); },
    plats: plats,
    hop: function (i) { var ps = plats(); hop(ps[i]); },
    // 调试 / 截图：固定一个姿势（传 null 恢复）
    pose: function (p) { forced = p; lastSig = ''; render(); },
    frames: function (n) { return n === 'jump' ? jumpFrames(6) : TOYS[n]().frames; }
  };
})();
