/* 天启工作台 v4 的夜空和三栏（docs/superpowers/specs/2026-11-19-tianqi-harness-workbench-design.md）。
   chat.js 管对话、输入框、对话记录、文件、插件、终端；这里管：
   - 夜空：WebGL 点精灵画星（分层景深、软边、星芒、每颗星自己的闪烁频率；浅色「星图」画成墨点）、流星、星尘；
     天启在想时一颗星沿输入框的边走；发出去的字化成星尘；答完划过一颗流星。
     参考 React Bits 的 Galaxy、Particles、Star Border、Click Spark、Particle Text。
   - 三栏：照 DeepSeek Harness 的 dsh-client-ui-layout / sidebar / sidebar-right——左栏能收成窄条（Ctrl+B），
     右栏「文件、终端、预览」（Ctrl+J），中屏右栏浮在聊天上，窄屏左栏是 chat.js 的抽屉，手机右栏从底下升起、能往下拖。
   - 预览、设置（外观、流星、插件、电脑）。系统开了「减少动态」时动画都不放。 */
(function () {
  'use strict';
  var API = '/api/tq/', WORK = '/data/workspace', PREVIEW_RE = /\.(png|jpe?g|gif|webp|svg|html?|md)$/i;

  function find() { var r = document.getElementById('xinChat'); return r && r.querySelector('.tq-frame') ? r : null; }
  var found = find();
  if (found) boot(found);
  else {
    var mo = new MutationObserver(function () { var r = find(); if (r) { mo.disconnect(); boot(r); } });
    mo.observe(document.body, { childList: true, subtree: true });
  }

  function boot(root) {
    var REDUCE = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
    var $ = function (s, r) { return (r || root).querySelector(s); }, $$ = function (s, r) { return Array.prototype.slice.call((r || root).querySelectorAll(s)); };
    var html = document.documentElement, frame = $('.tq-frame'), msgs = $('.xc-msgs'), box = $('.tq-box'), say = $('.tq-entry textarea'), sendBtn = $('.xc-send');
    var store = {
      get: function (k) { try { return localStorage.getItem('lm.tq.' + k); } catch (e) { return null; } },
      set: function (k, v) { try { if (v == null) localStorage.removeItem('lm.tq.' + k); else localStorage.setItem('lm.tq.' + k, v); } catch (e) { /* 存不了就只在这一页有效 */ } }
    };
    var chat = function () { return window.LimingXinChat || null; }, state = function () { var c = chat(); return c ? c.state : {}; };
    var DPR = Math.min(2, window.devicePixelRatio || 1), W = innerWidth, H = innerHeight;

    /* ================= 夜空 ================= */
    function canvas(cls) { var c = document.createElement('canvas'); c.className = cls; c.setAttribute('aria-hidden', 'true'); return c; }
    var starCv = canvas('tq-sky'), back = canvas('tq-sky'), fx = canvas('tq-sky tq-fx');
    root.insertBefore(back, root.firstChild); root.insertBefore(starCv, root.firstChild); frame.parentNode.insertBefore(fx, frame.nextSibling);
    var INK = html.dataset.theme === 'light', PAL;
    function setPalette() {
      PAL = INK
        ? { trail: [168, 116, 30], head: [92, 60, 8], pTrail: [53, 88, 200], pHead: [24, 44, 120], meteor: [[30, 44, 78], [150, 104, 28]], op: 'source-over', glowA: .09, bloomA: .2 }
        : { trail: [243, 223, 174], head: [255, 250, 238], pTrail: [157, 184, 255], pHead: [232, 238, 255], meteor: [[255, 248, 232], [196, 255, 222]], op: 'lighter', glowA: .16, bloomA: .42 };
    }
    setPalette();
    var gl = null;
    try { gl = starCv.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false }); } catch (e) { gl = null; }
    var VS = 'attribute vec2 aPos;attribute vec4 aStar;attribute vec3 aCol;uniform vec2 uPar;uniform float uTime;uniform float uDpr;uniform float uTw;varying vec3 vCol;varying float vA;varying float vS;' +
      'void main(){vec2 p=fract(aPos+uPar*aStar.y);gl_Position=vec4(p.x*2.0-1.0,1.0-p.y*2.0,0.0,1.0);' +
      'float amp=uTw*(aStar.x>1.7?0.55:0.3);vA=1.0-amp*(0.5+0.5*sin(uTime*aStar.z+aStar.w));vCol=aCol;vS=aStar.x;gl_PointSize=aStar.x*uDpr*4.0;}';
    var FS = 'precision mediump float;varying vec3 vCol;varying float vA;varying float vS;uniform float uInk;' +
      'void main(){vec2 u=gl_PointCoord*2.0-1.0;float d=length(u);float edge=smoothstep(1.0,0.72,d);' +
      'if(uInk>0.5){float b=max(max(vCol.r,vCol.g),vCol.b);if(b<0.6)discard;float core=exp(-d*d*30.0);float rays=0.0;' +
      'if(vS>1.9){rays=(exp(-abs(u.y)*60.0)*exp(-abs(u.x)*3.0)+exp(-abs(u.x)*60.0)*exp(-abs(u.y)*3.0))*0.4;}' +
      'float a=(core+rays)*(0.6+0.4*vA)*b*0.78*edge;gl_FragColor=vec4(vec3(0.11,0.16,0.28)*a,a);return;}' +
      'float core=exp(-d*d*22.0);float halo=exp(-d*5.0)*0.28;float rays=0.0;' +
      'if(vS>1.9){rays=(exp(-abs(u.y)*46.0)*exp(-abs(u.x)*2.6)+exp(-abs(u.x)*46.0)*exp(-abs(u.y)*2.6))*0.5;}' +
      'float a=(core+halo+rays)*vA*edge;gl_FragColor=vec4(vCol*a,a);}';
    var uPar, uTime, uDpr, uTw, uInk, nStars = 0, buf;
    function rng(seed) { return function () { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; }; }
    function tint(r) { var v = r(); return v < .46 ? [.80, .87, 1] : v < .78 ? [1, 1, 1] : v < .94 ? [1, .92, .80] : [1, .80, .64]; }
    function buildStars() {
      var r = rng(19), n = Math.max(700, Math.min(3000, Math.round(W * H / 560))), data = new Float32Array(n * 9);
      for (var i = 0; i < n; i++) {
        var m = r(), size = m < .82 ? .55 + r() * .45 : m < .975 ? 1.0 + r() * .7 : 1.95 + r() * .8;
        var bright = m < .82 ? .32 + r() * .4 : m < .975 ? .6 + r() * .35 : .9 + r() * .1, c = tint(r), o = i * 9;
        data[o] = r(); data[o + 1] = r(); data[o + 2] = size; data[o + 3] = .25 + r() * .75; data[o + 4] = .6 + r() * 2.6; data[o + 5] = r() * 6.283;
        data[o + 6] = c[0] * bright; data[o + 7] = c[1] * bright; data[o + 8] = c[2] * bright;
      }
      nStars = n; gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    }
    function initGL() {
      function sh(type, src) { var s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; }
      var prog = gl.createProgram(); gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { gl = null; return; }
      gl.useProgram(prog); buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      var aPos = gl.getAttribLocation(prog, 'aPos'), aStar = gl.getAttribLocation(prog, 'aStar'), aCol = gl.getAttribLocation(prog, 'aCol');
      gl.enableVertexAttribArray(aPos); gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 36, 0);
      gl.enableVertexAttribArray(aStar); gl.vertexAttribPointer(aStar, 4, gl.FLOAT, false, 36, 8);
      gl.enableVertexAttribArray(aCol); gl.vertexAttribPointer(aCol, 3, gl.FLOAT, false, 36, 24);
      uPar = gl.getUniformLocation(prog, 'uPar'); uTime = gl.getUniformLocation(prog, 'uTime'); uDpr = gl.getUniformLocation(prog, 'uDpr'); uTw = gl.getUniformLocation(prog, 'uTw'); uInk = gl.getUniformLocation(prog, 'uInk');
      gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    }
    var par = { x: 0, y: 0, tx: 0, ty: 0 }, t0 = performance.now(), lastStar = 0;
    addEventListener('pointermove', function (e) { if (e.pointerType === 'mouse') { par.tx = (e.clientX / W - .5) * -.010; par.ty = (e.clientY / H - .5) * -.010; } });
    function drawStars(now) {
      if (!gl) return;
      par.x += (par.tx - par.x) * .04; par.y += (par.ty - par.y) * .04;
      gl.viewport(0, 0, starCv.width, starCv.height); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform2f(uPar, par.x, par.y); gl.uniform1f(uTime, (now - t0) / 1000); gl.uniform1f(uDpr, DPR); gl.uniform1f(uTw, REDUCE ? 0 : 1); gl.uniform1f(uInk, INK ? 1 : 0);
      gl.drawArrays(gl.POINTS, 0, nStars);
    }
    function fallbackStars() {
      var c = starCv.getContext('2d'); if (!c) return; var r = rng(19);
      c.setTransform(DPR, 0, 0, DPR, 0, 0); c.clearRect(0, 0, W, H);
      for (var i = 0; i < W * H / 900; i++) { var s = r() < .95 ? .4 + r() * .6 : 1.2 + r(); c.fillStyle = INK ? 'rgba(28,40,72,' + (.2 + r() * .45) + ')' : 'rgba(230,236,255,' + (.25 + r() * .6) + ')'; c.beginPath(); c.arc(r() * W, r() * H, s * .6, 0, 7); c.fill(); }
    }
    var ctx = fx.getContext('2d'), bctx = back.getContext('2d'), meteors = [], dust = [], skyDust = [], fxRaf = 0, meteorsOn = store.get('meteor') !== 'off';
    function size() {
      W = innerWidth; H = innerHeight; DPR = Math.min(2, window.devicePixelRatio || 1);
      [starCv, back, fx].forEach(function (c) { c.width = Math.round(W * DPR); c.height = Math.round(H * DPR); });
      if (gl) buildStars(); else fallbackStars();
    }
    function rgba(c, a) { return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')'; }
    function spawnMeteor(opt) {
      if (REDUCE || !meteorsOn || document.hidden) return;
      opt = opt || {};
      var fromLeft = Math.random() < .5, ang = (18 + Math.random() * 22) * Math.PI / 180, dir = fromLeft ? 1 : -1;
      var x = opt.x != null ? opt.x : (fromLeft ? W * (.05 + Math.random() * .5) : W * (.45 + Math.random() * .5));
      var y = opt.y != null ? opt.y : H * (.04 + Math.random() * .32), speed = (opt.big ? 900 : 620) + Math.random() * 380;
      meteors.push({ x: x, y: y, vx: Math.cos(ang) * speed * dir, vy: Math.sin(ang) * speed, age: 0, life: (opt.big ? 1.15 : .75) + Math.random() * .45, len: (opt.big ? 260 : 150) + Math.random() * 110, w: opt.big ? 1.6 : 1.1, k: Math.random() < .25 ? 1 : 0 });
      wake();
    }
    function drawMeteor(m, dt) {
      m.age += dt; m.x += m.vx * dt; m.y += m.vy * dt;
      var col = PAL.meteor[m.k], k = m.age / m.life, a = k < .15 ? k / .15 : 1 - Math.pow((k - .15) / .85, 1.6), sp = Math.hypot(m.vx, m.vy), ux = m.vx / sp, uy = m.vy / sp;
      var tx = m.x - ux * m.len * (.4 + .6 * Math.min(1, k * 3)), ty = m.y - uy * m.len * (.4 + .6 * Math.min(1, k * 3));
      var g = bctx.createLinearGradient(m.x, m.y, tx, ty); g.addColorStop(0, rgba(col, .9 * a)); g.addColorStop(.25, rgba(col, .35 * a)); g.addColorStop(1, rgba(col, 0));
      bctx.strokeStyle = g; bctx.lineCap = 'round'; bctx.lineWidth = m.w; bctx.beginPath(); bctx.moveTo(m.x, m.y); bctx.lineTo(tx, ty); bctx.stroke();
      var glow = bctx.createRadialGradient(m.x, m.y, 0, m.x, m.y, 10); glow.addColorStop(0, rgba(col, .55 * a)); glow.addColorStop(1, rgba(col, 0));
      bctx.fillStyle = glow; bctx.fillRect(m.x - 10, m.y - 10, 20, 20);
      if (Math.random() < .55) skyDust.push({ x: m.x - ux * Math.random() * 20, y: m.y - uy * Math.random() * 20, vx: ux * 20 + (Math.random() - .5) * 26, vy: uy * 20 + (Math.random() - .5) * 26 + 8, age: 0, life: .35 + Math.random() * .5, s: .5 + Math.random() * .8, c: col });
      return m.age < m.life;
    }
    function drawDust(dt, list, c) {
      for (var i = list.length - 1; i >= 0; i--) {
        var p = list[i]; p.age += dt; if (p.age >= p.life) { list.splice(i, 1); continue; }
        if (p.age < 0) continue;
        p.vx *= .985; p.vy = p.vy * .985 + (p.g || 0) * dt; p.x += p.vx * dt; p.y += p.vy * dt;
        var left = 1 - p.age / p.life, a = left * left * (p.a || 1);
        c.fillStyle = rgba(p.c, a); c.beginPath(); c.arc(p.x, p.y, p.s * (.5 + .5 * left), 0, 6.283); c.fill();
      }
    }
    /* 输入框边上走的星：天启在想、在做事的时候才有；计划模式下是蓝的 */
    var orbit = { on: false, d: 0, plan: false }, P = {}, Q = {};
    function rrPoint(x, y, w, h, r, dist, out) {
      var sw = w - 2 * r, sh = h - 2 * r, arc = Math.PI * r / 2, per = 2 * (sw + sh) + 4 * arc;
      dist = ((dist % per) + per) % per;
      var segs = [sw, arc, sh, arc, sw, arc, sh, arc], i = 0;
      while (i < 7 && dist > segs[i]) { dist -= segs[i]; i++; }
      var t = segs[i] ? dist / segs[i] : 0, a;
      switch (i) {
        case 0: out.x = x + r + t * sw; out.y = y; out.nx = 0; out.ny = -1; break;
        case 1: a = -Math.PI / 2 + t * Math.PI / 2; out.x = x + w - r + Math.cos(a) * r; out.y = y + r + Math.sin(a) * r; out.nx = Math.cos(a); out.ny = Math.sin(a); break;
        case 2: out.x = x + w; out.y = y + r + t * sh; out.nx = 1; out.ny = 0; break;
        case 3: a = t * Math.PI / 2; out.x = x + w - r + Math.cos(a) * r; out.y = y + h - r + Math.sin(a) * r; out.nx = Math.cos(a); out.ny = Math.sin(a); break;
        case 4: out.x = x + w - r - t * sw; out.y = y + h; out.nx = 0; out.ny = 1; break;
        case 5: a = Math.PI / 2 + t * Math.PI / 2; out.x = x + r + Math.cos(a) * r; out.y = y + h - r + Math.sin(a) * r; out.nx = Math.cos(a); out.ny = Math.sin(a); break;
        case 6: out.x = x; out.y = y + h - r - t * sh; out.nx = -1; out.ny = 0; break;
        default: a = Math.PI + t * Math.PI / 2; out.x = x + r + Math.cos(a) * r; out.y = y + r + Math.sin(a) * r; out.nx = Math.cos(a); out.ny = Math.sin(a);
      }
      return per;
    }
    function drawOrbit(dt) {
      var b = box.getBoundingClientRect(); if (!b.width || !b.height) return;
      var r = parseFloat(getComputedStyle(box).borderTopLeftRadius) || 22, trail = orbit.plan ? PAL.pTrail : PAL.trail, head = orbit.plan ? PAL.pHead : PAL.head;
      var per = rrPoint(b.left, b.top, b.width, b.height, r, 0, P), L = 170, steps = 44;
      orbit.d += per / 4.2 * dt;
      rrPoint(b.left, b.top, b.width, b.height, r, orbit.d, P);
      var px = P.x, py = P.y;
      ctx.lineCap = 'round';
      for (var i = 1; i <= steps; i++) {
        rrPoint(b.left, b.top, b.width, b.height, r, orbit.d - L * i / steps, Q);
        var u = 1 - (i - .5) / steps, f = u * u;
        ctx.strokeStyle = rgba(trail, f * PAL.glowA); ctx.lineWidth = 6; ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(Q.x, Q.y); ctx.stroke();
        ctx.strokeStyle = rgba(i < 4 ? head : trail, f * .95); ctx.lineWidth = 1.3; ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(Q.x, Q.y); ctx.stroke();
        px = Q.x; py = Q.y;
      }
      var bloom = ctx.createRadialGradient(P.x, P.y, 0, P.x, P.y, 26); bloom.addColorStop(0, rgba(trail, PAL.bloomA)); bloom.addColorStop(.25, rgba(trail, PAL.bloomA / 3)); bloom.addColorStop(1, rgba(trail, 0));
      ctx.fillStyle = bloom; ctx.fillRect(P.x - 26, P.y - 26, 52, 52);
      ctx.fillStyle = rgba(head, 1); ctx.beginPath(); ctx.arc(P.x, P.y, 1.7, 0, 6.283); ctx.fill();
      var sp = 5 + 2 * Math.sin(performance.now() / 160);
      [[1, 0], [0, 1]].forEach(function (dd) { var g = ctx.createLinearGradient(P.x - dd[0] * sp, P.y - dd[1] * sp, P.x + dd[0] * sp, P.y + dd[1] * sp); g.addColorStop(0, rgba(head, 0)); g.addColorStop(.5, rgba(head, .9)); g.addColorStop(1, rgba(head, 0)); ctx.strokeStyle = g; ctx.lineWidth = .9; ctx.beginPath(); ctx.moveTo(P.x - dd[0] * sp, P.y - dd[1] * sp); ctx.lineTo(P.x + dd[0] * sp, P.y + dd[1] * sp); ctx.stroke(); });
      if (Math.random() < .5) { var push = 8 + Math.random() * 18, drift = (Math.random() - .5) * 14; dust.push({ x: P.x, y: P.y, vx: P.nx * push - P.ny * drift, vy: P.ny * push + P.nx * drift, age: 0, life: .4 + Math.random() * .5, s: .45 + Math.random() * .7, c: trail, a: .9 }); }
    }
    var lastFx = performance.now();
    function loop(now) {
      var dt = Math.min(.05, (now - lastFx) / 1000); lastFx = now;
      if (now - lastStar > 33) { drawStars(now); lastStar = now; }
      [ctx, bctx].forEach(function (c) { c.setTransform(DPR, 0, 0, DPR, 0, 0); c.clearRect(0, 0, W, H); c.globalCompositeOperation = PAL.op; });
      for (var i = meteors.length - 1; i >= 0; i--) if (!drawMeteor(meteors[i], dt)) meteors.splice(i, 1);
      drawDust(dt, skyDust, bctx);
      if (orbit.on) drawOrbit(dt);
      drawDust(dt, dust, ctx);
      [ctx, bctx].forEach(function (c) { c.globalCompositeOperation = 'source-over'; });
      fxRaf = requestAnimationFrame(loop);
    }
    function wake() { if (!fxRaf && !document.hidden && !REDUCE) { lastFx = performance.now(); fxRaf = requestAnimationFrame(loop); } }
    document.addEventListener('visibilitychange', function () { if (document.hidden) { cancelAnimationFrame(fxRaf); fxRaf = 0; } else wake(); });
    if (gl) initGL();
    size();
    if (REDUCE) drawStars(performance.now());
    else { wake(); (function clock() { setTimeout(function () { spawnMeteor(); clock(); }, 18000 + Math.random() * 24000); })(); setTimeout(function () { spawnMeteor(); }, 2200); }
    new MutationObserver(function () { INK = html.dataset.theme === 'light'; setPalette(); if (!gl) fallbackStars(); if (REDUCE) drawStars(performance.now()); }).observe(html, { attributes: true, attributeFilter: ['data-theme'] });

    /* 发出去的字化成星尘：先把字画到离屏画布，再按像素取样成粒子 */
    function dissolve(text) {
      if (REDUCE || !text) return;
      var rect = say.getBoundingClientRect(), cs = getComputedStyle(say), padL = parseFloat(cs.paddingLeft), padT = parseFloat(cs.paddingTop), lh = parseFloat(cs.lineHeight) || 26;
      var maxW = rect.width - padL - parseFloat(cs.paddingRight), off = document.createElement('canvas'), oc = off.getContext('2d');
      if (!rect.width || !rect.height || !oc) return;
      off.width = Math.ceil(rect.width); off.height = Math.ceil(rect.height); oc.font = cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily; oc.textBaseline = 'middle'; oc.fillStyle = '#fff';
      var line = '', y = padT + lh / 2, lines = 0;
      for (var i = 0; i < text.length && lines < 6; i++) { var ch = text[i], t = line + ch; if (ch === '\n' || oc.measureText(t).width > maxW) { oc.fillText(line, padL, y); y += lh; lines++; line = ch === '\n' ? '' : ch; } else line = t; }
      if (lines < 6) oc.fillText(line, padL, y);
      var img = oc.getImageData(0, 0, off.width, off.height).data, count = 0;
      for (var yy = 0; yy < off.height; yy += 2) for (var xx = 0; xx < off.width; xx += 2) {
        if (img[(yy * off.width + xx) * 4 + 3] > 140 && count < 1600) {
          count++;
          dust.push({ x: rect.left + xx, y: rect.top + yy, vx: (Math.random() - .5) * 30, vy: -(30 + Math.random() * 90), g: -40, age: -((xx / off.width) * .35 + Math.random() * .12), life: .9 + Math.random() * .7, s: .55 + Math.random() * .55, c: Math.random() < .3 ? PAL.trail : PAL.head, a: .95 });
        }
      }
      wake();
    }
    var dockFrom = null;
    function sending() {
      var text = say.value.trim(); if (!text || sendBtn.dataset.k === 'stop' || sendBtn.disabled || say.disabled) return;
      dissolve(text);
      if (frame.hasAttribute('data-start')) dockFrom = $('.tq-dock').getBoundingClientRect().top;
    }
    document.addEventListener('keydown', function (e) { if (e.target === say && e.key === 'Enter' && !e.shiftKey && !e.isComposing && !(say.getAttribute('enterkeyhint') === 'enter')) sending(); }, true);
    document.addEventListener('submit', function (e) { if (e.target && e.target.classList && e.target.classList.contains('xc-ft')) sending(); }, true);

    /* ================= 三栏 ================= */
    var MQ = { wide: matchMedia('(min-width: 1200px)'), mid: matchMedia('(min-width: 900px)'), tab: matchMedia('(min-width: 600px)') };
    var L = { mode: '', rail: store.get('rail') === '1', right: store.get('right') !== '0', touched: false };
    var scrim2 = document.createElement('div'); scrim2.className = 'tq-scrim2'; root.appendChild(scrim2);
    var right = $('.tq-right'), drawer = $('.xc-drawer'), panelB = $('.tq-panel-b'), badge = $('.tq-badge');
    function modeNow() { return MQ.wide.matches ? 'wide' : MQ.mid.matches ? 'mid' : MQ.tab.matches ? 'narrow' : 'phone'; }
    // instant：第一次摆好、换了屏幕档位（转屏、拉窗口）时直接到位，不放滑开的过渡；只有站长自己开关才动
    function layout(instant) {
      if (instant === true) { frame.classList.add('tq-instant'); requestAnimationFrame(function () { requestAnimationFrame(function () { frame.classList.remove('tq-instant'); }); }); }
      var m = modeNow(), changed = m !== L.mode, docked = m === 'wide' || m === 'mid';
      if (changed && L.mode && (m === 'phone' || m === 'narrow' || m === 'mid')) L.right = false;
      if (changed && !L.mode && m !== 'wide') L.right = false;
      L.mode = m;
      var rail = m === 'wide' ? L.rail : m === 'mid' ? store.get('railMid') !== '0' : false;
      frame.dataset.mode = m;
      frame.dataset.left = docked ? (rail ? 'rail' : 'open') : 'drawer';
      frame.dataset.right = L.right ? 'open' : 'closed';
      // 常驻时是一栏导航，窄屏时是抽屉（chat.js 管开关、遮罩和焦点）
      if (docked) drawer.setAttribute('role', 'navigation'); else drawer.setAttribute('role', 'dialog');
      var lbl = rail ? '展开侧栏' : '收起侧栏';
      $$('.tq-fold, .tq-brand-key').forEach(function (b) { b.setAttribute('aria-label', lbl); b.title = lbl + '（Ctrl+B）'; });
      panelB.setAttribute('aria-expanded', String(L.right)); panelB.setAttribute('aria-label', L.right ? '收起面板' : '打开面板');
      right.inert = !L.right;
      scrim2.classList.toggle('on', m === 'phone' && L.right);
      if (L.right) { badge.hidden = true; if (tab === 'files') ensureFiles(); }
      requestAnimationFrame(moveInk);
    }
    function toggleLeft() {
      if (L.mode === 'wide') { L.rail = frame.dataset.left !== 'rail'; store.set('rail', L.rail ? '1' : null); }
      else if (L.mode === 'mid') store.set('railMid', frame.dataset.left === 'rail' ? '0' : null);
      else { var b = $('.xc-list-b'); if (b && !b.hidden) b.click(); return; }
      layout();
    }
    function toggleRight(v) {
      L.right = v === undefined ? !L.right : !!v;
      if (L.mode === 'wide') store.set('right', L.right ? null : '0');
      layout();
    }
    var relayout = function () { layout(true); };
    Object.keys(MQ).forEach(function (k) { var q = MQ[k]; (q.addEventListener ? q.addEventListener('change', relayout) : q.addListener(relayout)); });
    $('.tq-fold').addEventListener('click', toggleLeft);
    $('.tq-brand-key').addEventListener('click', function () { if (L.mode === 'wide' || L.mode === 'mid') toggleLeft(); });
    panelB.addEventListener('click', function () { L.touched = true; toggleRight(); });
    $('.tq-r-x').addEventListener('click', function () { L.touched = true; toggleRight(false); });
    scrim2.addEventListener('click', function () { toggleRight(false); });
    var rs = 0;
    addEventListener('resize', function () { clearTimeout(rs); rs = setTimeout(function () { size(); if (REDUCE) drawStars(performance.now()); moveInk(); }, 120); });
    /* 手机：按住标签那一行往下拖就收起（照 Vaul 的抽屉：拖过一段或甩得快就收） */
    (function () {
      var head = $('.tq-r-head'), y0 = 0, dy = 0, dragging = false, ts = 0;
      head.addEventListener('pointerdown', function (e) { if (L.mode !== 'phone' || e.target.closest('button')) return; dragging = true; y0 = e.clientY; dy = 0; ts = performance.now(); right.classList.add('tq-dragging'); try { head.setPointerCapture(e.pointerId); } catch (err) { /* 拿不到也能拖 */ } });
      head.addEventListener('pointermove', function (e) { if (!dragging) return; dy = Math.max(0, e.clientY - y0); right.style.setProperty('--drag', dy + 'px'); });
      function end() { if (!dragging) return; dragging = false; right.classList.remove('tq-dragging'); var fast = dy / Math.max(1, performance.now() - ts) > .6; right.style.removeProperty('--drag'); if (dy > 110 || (fast && dy > 30)) toggleRight(false); }
      head.addEventListener('pointerup', end); head.addEventListener('pointercancel', end);
    })();

    /* ================= 右栏：标签 ================= */
    var tabs = $$('.tq-tab'), ink = $('.tq-tab-ink'), tab = 'files', filesLoaded = false;
    function moveInk() { var t = tabs.filter(function (x) { return x.dataset.tab === tab; })[0]; if (t && t.offsetWidth) ink.style.transform = 'translateX(' + (t.offsetLeft + t.offsetWidth / 2 - 9) + 'px)'; }
    function select(name, focus) {
      tab = name;
      tabs.forEach(function (t) { var on = t.dataset.tab === name; t.setAttribute('aria-selected', String(on)); t.tabIndex = on ? 0 : -1; if (on) { t.classList.remove('has'); if (focus) t.focus(); } });
      $$('.tq-pane').forEach(function (p) {
        var on = p.dataset.tab === name;
        if (on && p.hidden && !REDUCE) { p.classList.remove('tq-in'); void p.offsetWidth; p.classList.add('tq-in'); }
        p.hidden = !on;
      });
      if (name === 'files') ensureFiles();
      moveInk();
    }
    tabs.forEach(function (t) { t.addEventListener('click', function () { L.touched = true; select(t.dataset.tab); }); });
    $('.tq-tabs').addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      // 藏着的标签（没计划时的「计划」）跳过
      var vis = tabs.filter(function (t) { return !t.hidden; }), i = vis.map(function (t) { return t.dataset.tab; }).indexOf(tab), n = vis[(i + (e.key === 'ArrowRight' ? 1 : -1) + vis.length) % vis.length];
      select(n.dataset.tab, true); e.preventDefault();
    });
    function notify(name) {
      if (!(L.right && tab === name)) tabs.filter(function (t) { return t.dataset.tab === name; })[0].classList.add('has');
      if (!L.right) badge.hidden = false;
    }
    function ensureFiles() {
      var s = state();
      if (filesLoaded || !L.right || tab !== 'files' || !s.authed || !s.enabled) return;
      filesLoaded = true; var c = chat(); if (c && c.tqFiles) c.tqFiles();
    }
    // chat.js 要开右栏：开文件（tq:panel files）、打开终端（tq:panel term）
    document.addEventListener('tq:panel', function (e) {
      var d = e.detail || {};
      if (d.tab === 'files' && d.loading) filesLoaded = true;
      if (!L.right) toggleRight(true);
      if (d.tab) select(d.tab);
    });

    /* ================= 预览 ================= */
    var prevBox = $('.tq-prev'), prevUrl = '';
    function abs(p) { return p.charAt(0) === '/' ? p : WORK + '/' + p.replace(/^\.\//, ''); }
    function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
    function prevShell(path, body) { prevBox.innerHTML = '<div class="tq-pv-bar"><span>' + esc(path.indexOf(WORK + '/') === 0 ? path.slice(WORK.length + 1) : path) + '</span></div>' + body; }
    function showPreview(path, text) {
      path = abs(path);
      if (prevUrl) { URL.revokeObjectURL(prevUrl); prevUrl = ''; }
      if (!L.right) toggleRight(true);
      select('prev');
      var ext = (path.match(PREVIEW_RE) || [])[1] || '';
      ext = ext.toLowerCase();
      var draw = REDUCE ? '' : ' tq-draw';
      var withText = function (t) {
        if (ext === 'svg') { prevShell(path, '<figure class="tq-pv-fig' + draw + '"><img alt="' + esc(path.split('/').pop()) + '"></figure>'); prevBox.querySelector('img').src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(t); }
        else if (ext === 'html' || ext === 'htm') { prevShell(path, '<figure class="tq-pv-fig"><iframe sandbox="allow-scripts" title="网页预览"></iframe></figure>'); prevBox.querySelector('iframe').srcdoc = t; }
        else { prevShell(path, '<figure class="tq-pv-fig"><pre></pre></figure>'); prevBox.querySelector('pre').textContent = t; }
      };
      if (text != null && ext !== 'png' && !/^(jpe?g|gif|webp)$/.test(ext)) { withText(text); return; }
      prevShell(path, '<p class="tq-note">正在读取…</p>');
      fetch(API + 'file?path=' + encodeURIComponent(path), { credentials: 'same-origin' }).then(function (r) {
        if (!r.ok || (r.headers.get('content-type') || '').indexOf('application/json') >= 0) throw new Error(r.ok ? 'asleep' : String(r.status));
        return /^(png|jpe?g|gif|webp)$/.test(ext) ? r.blob().then(function (b) {
          prevUrl = URL.createObjectURL(b);
          prevShell(path, '<figure class="tq-pv-fig' + draw + '"><img alt="' + esc(path.split('/').pop()) + '"></figure>'); prevBox.querySelector('img').src = prevUrl;
        }) : r.text().then(withText);
      }).catch(function (e) {
        prevShell(path, '<p class="tq-note">' + (e.message === 'asleep' ? 'li2 在睡，等它醒了再点一次。' : '读不到这个文件（' + esc(e.message) + '）。') + '</p>');
      });
    }
    document.addEventListener('tq:preview', function (e) { var d = e.detail || {}; if (d.path) showPreview(d.path, d.text); });
    // 回答里提到的图、网页、markdown 路径：能点开预览
    function linkRefs(scope) {
      $$('.xc-ai .xc-bub code', scope).forEach(function (c) {
        if (c.dataset.tqRef || c.closest('pre')) return;
        var t = (c.textContent || '').trim();
        c.dataset.tqRef = '1';
        if (!PREVIEW_RE.test(t) || !/^(?:\/data\/workspace\/|\.\/)?[\w\-.\/]+$/.test(t) || t.indexOf('..') >= 0) return;
        c.classList.add('tq-ref'); c.setAttribute('role', 'button'); c.tabIndex = 0; c.title = '在右栏预览';
      });
    }
    msgs.addEventListener('click', function (e) { var c = e.target.closest && e.target.closest('.tq-ref'); if (c) showPreview(c.textContent.trim()); });
    msgs.addEventListener('keydown', function (e) { var c = e.target; if ((e.key === 'Enter' || e.key === ' ') && c.classList && c.classList.contains('tq-ref')) { e.preventDefault(); showPreview(c.textContent.trim()); } });

    /* ================= 对话：开始、在做、做完 ================= */
    var title = $('.xc-conv-t'), lastTitle = title.textContent;
    new MutationObserver(function () {
      if (title.textContent === lastTitle) return; lastTitle = title.textContent;
      if (!REDUCE) { title.classList.remove('tq-swap'); void title.offsetWidth; title.classList.add('tq-swap'); }
    }).observe(title, { childList: true, characterData: true, subtree: true });
    function syncStart() {
      var start = msgs.children.length === 1 && !!msgs.querySelector(':scope > .tq-empty');
      var was = frame.hasAttribute('data-start');
      frame.toggleAttribute('data-start', start);
      if (was && !start && dockFrom != null && !REDUCE) {
        var dock = $('.tq-dock'), dy = dockFrom - dock.getBoundingClientRect().top;
        if (Math.abs(dy) > 2 && dock.animate) dock.animate([{ transform: 'translateY(' + dy + 'px)' }, { transform: 'none' }], { duration: 560, easing: 'cubic-bezier(.16,1,.3,1)' });
      }
      dockFrom = null;
    }
    new MutationObserver(function (list) {
      syncStart(); linkRefs(msgs);
      if (busy && list.some(function (m) { return m.addedNodes.length; })) notifyWork();
    }).observe(msgs, { childList: true, subtree: true });
    syncStart();
    // 对话记录：新出现的对话滑进来（第一次画列表不算）
    var seen = null;
    new MutationObserver(function () {
      var now = $$('.tq-side .xc-si-t').map(function (e) { return e.textContent; });
      if (seen && now.length) $$('.tq-side .xc-sli').forEach(function (li) { var t = li.querySelector('.xc-si-t'); if (t && seen.indexOf(t.textContent) < 0 && !REDUCE) li.classList.add('tq-new'); });
      if (now.length) seen = now;
    }).observe($('.xc-dr'), { childList: true, subtree: true });
    // 在做事：星绕输入框走；做完划过一颗流星。chat.js 的 S.run / S.sending 就是「在做」
    var busy = false, termShown = false, workTm = 0;
    function notifyWork() { clearTimeout(workTm); workTm = setTimeout(function () { if (!L.right) badge.hidden = false; }, 400); }
    function runHasTools(s) { var ev = s && s.run && s.runEv && s.runEv[s.run]; return !!(ev && ev.some(function (e) { return e && (e.t === 'tool' || e.t === 'tool_end'); })); }
    function tick() {
      var s = state(), now = !!(s && (s.run || s.sending));
      // 这一轮一开始跑命令：宽屏、右栏开着、这一轮没手动换过标签，就点「正在执行」那一条，右栏换到「终端」跟着看；不然只亮小点
      if (busy && !termShown && runHasTools(s)) {
        termShown = true;
        var a = msgs.querySelector('.xc-typing[data-term]');
        if (a && L.mode === 'wide' && L.right && !L.touched) a.click(); else notify('term');
      }
      if (now !== busy) {
        busy = now;
        orbit.on = busy && !REDUCE; if (busy) { orbit.d = 0; wake(); termShown = false; L.touched = false; }
        else {
          var last = $$('.xc-ai', msgs).pop();
          if (last) { var r = last.getBoundingClientRect(); spawnMeteor({ big: true, x: Math.min(W * .8, r.right + 40), y: Math.max(40, r.top - 60) }); }
        }
        hook();
      }
      // 「按计划执行」在做的时候不能点：按钮是按画的那一刻在不在做画的，和现在不一样就重画（一轮很快做完时上面的 busy 可能根本没变过）
      if (now !== actsBusy && latest) planActs();
      var chip = $('.tq-li2'), ok = !!(s.enabled && s.authed && !s.tqNoGw), warn = !!(s.enabled && s.authed && s.tqNoGw);
      chip.classList.toggle('ok', ok); chip.classList.toggle('warn', warn);
      chip.title = ok ? 'li2 在线' : warn ? 'li2 的网关还没配好' : 'li2 还没连上';
      if (L.right && tab === 'files') ensureFiles();
    }
    setInterval(tick, 300);

    /* ================= 设置 ================= */
    var modal = $('#tq-settings'), secEl = $('.tq-set-sec'), lastFocus = null;
    function themePref() { return html.dataset.pref || 'dark'; }
    var SEC = {
      look: function () {
        return '<h3>外观</h3><p>夜空的星会发光；星图像印在纸上的星表。</p><div class="tq-themes" role="radiogroup" aria-label="外观">' +
          [['dark', '夜空', 'tq-th-dark'], ['light', '星图', 'tq-th-light'], ['auto', '跟随系统', 'tq-th-auto']].map(function (t) { return '<button class="tq-theme" type="button" role="radio" aria-checked="' + (themePref() === t[0]) + '" data-theme-set="' + t[0] + '"><i class="' + t[2] + '"></i>' + t[1] + '</button>'; }).join('') +
          '</div><h3>动态</h3><p>系统开了「减少动态」时，星不闪、流星不出现。</p><div class="tq-set-row"><div><b>流星</b><p>偶尔划过一颗；天启答完时也会有一颗。</p></div><button class="tq-sw" type="button" role="switch" aria-checked="' + meteorsOn + '" data-sw="meteor" aria-label="流星"></button></div>';
      },
      pc: function () {
        var s = state(), st = !s.enabled ? '天启还没配好' : !s.authed ? '没登录' : s.tqNoGw ? '在线，但网关还没配好' : '在线';
        return '<h3>li2</h3><p>天启住在这台云电脑上。</p><dl class="tq-kv"><dt>状态</dt><dd>' + esc(st) + '</dd><dt>工作目录</dt><dd class="tq-mono">' + WORK + '</dd><dt>每天唤醒</dt><dd>北京时间 8:55</dd></dl>' +
          (s.authed ? '<h3>账号</h3><p>退出后要重新输密码。</p><button class="tq-btn" type="button" data-act="logout">退出登录</button>' : '');
      }
    };
    function showSec(name) {
      $$('.tq-set-tab', modal).forEach(function (b) { b.setAttribute('aria-current', String(b.dataset.sec === name)); });
      secEl.innerHTML = SEC[name]();
      if (!REDUCE) { secEl.classList.remove('tq-set-sec'); void secEl.offsetWidth; secEl.classList.add('tq-set-sec'); }
    }
    function openSettings(sec) {
      lastFocus = document.activeElement; showSec(sec || 'look');
      modal.hidden = false; modal.classList.remove('out');
      requestAnimationFrame(function () { modal.classList.add('on'); });
      setTimeout(function () { var f = $('.tq-set-tab[aria-current="true"]', modal); if (f) f.focus(); }, 30);
      if (L.mode === 'narrow' || L.mode === 'phone') { var lb = $('.xc-list-b'); if (root.classList.contains('dr-open') && lb) lb.click(); }
    }
    function closeSettings() {
      if (modal.hidden) return;
      modal.classList.add('out'); modal.classList.remove('on');
      setTimeout(function () { modal.hidden = true; modal.classList.remove('out'); }, REDUCE ? 0 : 220);
      if (lastFocus && lastFocus.focus && document.contains(lastFocus)) lastFocus.focus();
    }
    $('.tq-set-b').addEventListener('click', function () { openSettings('look'); });
    $('.tq-li2').addEventListener('click', function () { openSettings('pc'); });
    $('.tq-set-x').addEventListener('click', closeSettings);
    $('.tq-modal-bg').addEventListener('click', closeSettings);
    $$('.tq-set-tab', modal).forEach(function (b) { b.addEventListener('click', function () { showSec(b.dataset.sec); }); });
    secEl.addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      if (b.dataset.themeSet) {
        try { localStorage.setItem('lm.tq.theme', b.dataset.themeSet); } catch (err) { /* 存不了就只换这一次 */ }
        window.postMessage({ type: 'theme' }, location.origin);
        setTimeout(function () { showSec('look'); var f = $('.tq-theme[aria-checked="true"]', modal); if (f) f.focus(); }, 0);
      } else if (b.dataset.sw === 'meteor') {
        meteorsOn = !meteorsOn; store.set('meteor', meteorsOn ? null : 'off'); b.setAttribute('aria-checked', String(meteorsOn)); if (meteorsOn) spawnMeteor();
      } else if (b.dataset.act === 'logout') {
        closeSettings(); var o = $('.xc-dr-out'); if (o) o.click();   // chat.js 的退出登录（左栏里藏着）
      }
    });
    modal.addEventListener('keydown', function (e) {
      if (e.key !== 'Tab') return;
      var f = $$('button:not(:disabled)', modal).filter(function (x) { return x.offsetParent !== null; });
      if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) { f[f.length - 1].focus(); e.preventDefault(); }
      else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { f[0].focus(); e.preventDefault(); }
    });

    /* ================= 权限和计划（第 2 个 PR，设计 §3） =================
       三档权限是 Harness 自带的预设（vm-persona.mjs）：对话记住自己的权限，新对话用设置里的默认（lm.tq.perm，默认完全权限，和以前一样）。
       计划模式那一轮控制器固定只读、任务前面加计划要求；计划出来以后点「按计划执行」，再按对话的权限动手。
       照 Harness 的 dsh-client-ui-permission-presets（输入框里切这个对话的、设置里改以后的默认）和 dsh-client-ui-plan、dsh-plan-mode
       （计划在右栏打开，对话里留一张卡片；通过才动手，「继续改计划」接着改）。 */
    var PERMS = [
      ['read-only', '只读', '只读', '只看文件、跑只读命令，不改任何东西'],
      ['workspace-write', '工作区内修改', '工作区', '能改工作目录里的文件、运行命令'],
      ['danger-full-access', '完全权限', '完全', '还能改工作目录外的文件和 li2 的系统设置']
    ], RO = 'read-only', FULL = 'danger-full-access';
    function permOf(v) { return PERMS.filter(function (p) { return p[0] === v; })[0] || null; }
    function defPerm() { var v = store.get('perm'); return permOf(v) ? v : FULL; }
    var cfg = { perm: permOf(state().tqPerm) ? state().tqPerm : defPerm(), plan: false };
    var permBtn = $('#tq-perm'), planBtn = $('#tq-plan'), PH0 = say.getAttribute('placeholder') || '给天启发消息';
    // chat.js 发消息时来问这一句带什么权限、是不是计划（只在天启模式里问）
    function tqOpts() { return { perm: cfg.perm, plan: cfg.plan, work: fresh() && ws.pick ? ws.pick : undefined }; }
    function hook() { var c = chat(); if (c && c.tqOpts !== tqOpts) c.tqOpts = tqOpts; if (c && c.tqActions !== tqActions) c.tqActions = tqActions; }
    hook();
    function syncChips() {
      var p = permOf(cfg.perm);
      $('.tq-perm-n', permBtn).textContent = p[2];
      permBtn.setAttribute('aria-label', '权限：' + p[1]);
      permBtn.classList.toggle('full', cfg.perm === FULL); permBtn.classList.toggle('ro', cfg.perm === RO);
      planBtn.setAttribute('aria-pressed', String(cfg.plan));
      box.classList.toggle('plan', cfg.plan); orbit.plan = cfg.plan;
      // chat.js 每次重画会按 tqPh 写回提示，计划模式下就一直是这句
      var s = state(), ph = cfg.plan ? '说说要做什么，天启先出计划' : PH0;
      if (s) s.tqPh = cfg.plan ? ph : '';
      say.setAttribute('placeholder', ph);
      planActs();
    }
    // 弹层：这个对话的权限。完全权限要再确认一次（原型 v4；Harness 的 picker 也是先确认再切）
    var pop = document.createElement('div'); pop.className = 'tq-pop'; pop.id = 'tq-perm-pop'; pop.hidden = true; root.appendChild(pop);
    var CHECK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.2 4.2L19 7"/></svg>';
    function permMenu(confirm) {
      pop.setAttribute('role', confirm ? 'dialog' : 'menu'); pop.setAttribute('aria-label', '这个对话的权限');
      pop.innerHTML = confirm
        ? '<div class="tq-confirm" role="alert"><p>完全权限下，天启能改 li2 上的任何文件，包括系统设置。只在这个对话里生效。</p><div class="tq-acts"><button class="tq-btn" type="button" data-cancel="1">取消</button><button class="tq-btn go-risk" type="button" data-perm="' + FULL + '" data-sure="1">换成完全权限</button></div></div>'
        : '<p class="tq-pop-h">这个对话的权限</p>' + PERMS.map(function (p) { return '<button class="tq-opt' + (p[0] === FULL ? ' risk' : '') + '" type="button" role="menuitemradio" aria-checked="' + (p[0] === cfg.perm) + '" data-perm="' + p[0] + '"><span class="tq-opt-t"><span>' + p[1] + '</span><small>' + p[3] + '</small></span>' + CHECK + '</button>'; }).join('');
    }
    function placePop() {
      var b = permBtn.getBoundingClientRect(), w = pop.offsetWidth, hh = pop.offsetHeight;
      var x = Math.max(12, Math.min(innerWidth - w - 12, b.left)), y = b.top - hh - 8;
      if (y < 12) y = Math.max(12, Math.min(innerHeight - hh - 12, b.bottom + 8));
      pop.style.left = x + 'px'; pop.style.top = y + 'px';
    }
    function focusOpt() { var f = $('.tq-opt[aria-checked="true"]', pop) || $('.tq-opt', pop); if (f) f.focus(); }
    function openPop() {
      permMenu(false); pop.hidden = false; placePop(); permBtn.setAttribute('aria-expanded', 'true');
      if (!REDUCE) { pop.classList.remove('in'); void pop.offsetWidth; pop.classList.add('in'); }
      focusOpt();
    }
    function closePop(back) { if (pop.hidden) return false; pop.hidden = true; permBtn.setAttribute('aria-expanded', 'false'); if (back) permBtn.focus(); return true; }
    permBtn.addEventListener('click', function () { if (pop.hidden) openPop(); else closePop(true); });
    pop.addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      if (b.dataset.cancel) { permMenu(false); placePop(); focusOpt(); return; }
      var v = b.dataset.perm; if (!permOf(v)) return;
      if (v === FULL && cfg.perm !== FULL && !b.dataset.sure) { permMenu(true); placePop(); $('[data-cancel]', pop).focus(); return; }
      cfg.perm = v; syncChips(); closePop(true);
      if (fresh()) store.set('perm', v === FULL ? null : v);   // 新对话里选的，之后的新对话沿用（原来在设置里改默认，站长 11-20 说多余）
    });
    pop.addEventListener('keydown', function (e) {
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].indexOf(e.key) < 0) return;
      var o = $$('.tq-opt', pop); if (!o.length) return;
      var i = o.indexOf(document.activeElement), n = e.key === 'Home' ? 0 : e.key === 'End' ? o.length - 1 : (i + (e.key === 'ArrowDown' ? 1 : -1) + o.length) % o.length;
      o[n].focus(); e.preventDefault();
    });
    document.addEventListener('pointerdown', function (e) { if (!pop.hidden && !pop.contains(e.target) && !permBtn.contains(e.target)) closePop(false); }, true);
    addEventListener('resize', function () { if (!pop.hidden) placePop(); });
    planBtn.addEventListener('click', function () { cfg.plan = !cfg.plan; syncChips(); });

    // 计划：对话里一张卡片（标题、几步、按计划执行 / 继续改计划 / 看计划），右栏「计划」放全文
    var plans = {}, latest = '', shown = '', planBox = $('.tq-plan-box'), planTab = $('#tq-tab-plan');
    var PLAN_IC = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 6.5h10M10 12h10M10 17.5h10"/><path d="M3.8 6.4l1.3 1.3 2.3-2.4M3.8 11.9l1.3 1.3 2.3-2.4M3.8 17.4l1.3 1.3 2.3-2.4"/></svg>';
    function planTitle(text) { var m = /^\s*#{1,3}\s+(.+)$/m.exec(text || ''); return ((m ? m[1] : String(text || '').trim().split('\n')[0]) || '计划').replace(/[*_`#]/g, '').trim().slice(0, 80); }
    function planSteps(text) { return (String(text || '').match(/^\s*\d+[.)、]\s+\S/gm) || []).length; }
    function mdEl(text) { var c = chat(); if (c && c.md) { try { return c.md(text); } catch (e) { /* 画不了就放原文 */ } } var pre = document.createElement('pre'); pre.textContent = text; return pre; }
    // 最新的这份、而且后面还没再说过话，才能「按计划执行」；以前的只能看
    function isLive(run) {
      var p = plans[run]; if (!p || run !== latest || !p.card || !document.contains(p.card)) return false;
      var mine = $$('.xc-me', msgs), last = mine[mine.length - 1];
      return !(last && (p.card.compareDocumentPosition(last) & Node.DOCUMENT_POSITION_FOLLOWING));
    }
    function actsFor(run, inDoc) {
      var s = state(), live = isLive(run), ro = cfg.perm === RO, busyNow = !!(s && (s.run || s.sending));
      var sig = [run, live, ro, busyNow, inDoc].join('|'), w = document.createElement('div');
      w.className = 'tq-acts'; w.dataset.run = run; w.dataset.sig = sig;
      if (live) w.innerHTML = '<button class="tq-btn primary" type="button" data-plan-act="run"' + (ro || busyNow ? ' disabled' : '') + '>按计划执行</button><button class="tq-btn" type="button" data-plan-act="edit">继续改计划</button>' +
        (inDoc ? '' : '<button class="tq-btn" type="button" data-plan-act="open">看计划</button>') +
        (ro ? '<p class="tq-btn-note">现在是只读权限，改不了文件。先把权限换成「工作区内修改」或「完全权限」。</p>' : '');
      else if (!inDoc) w.innerHTML = '<button class="tq-btn" type="button" data-plan-act="open">看计划</button>';
      else return null;
      return w;
    }
    // 状态变了才换按钮（换了会丢焦点）
    function swapActs(host, run, inDoc) {
      if (!host) return;
      var old = $(':scope > .tq-acts', host), nu = actsFor(run, inDoc);
      if (old && nu && old.dataset.sig === nu.dataset.sig) return;
      if (old) old.remove(); if (nu) host.appendChild(nu);
    }
    var actsBusy = false;
    function planActs() {
      var s = state(); actsBusy = !!(s && (s.run || s.sending));
      Object.keys(plans).forEach(function (run) { swapActs(plans[run].card, run, false); });
      swapActs($('.tq-plan-doc', planBox), shown, true);
    }
    function renderPlanDoc() {
      planBox.innerHTML = '';
      var p = plans[shown]; if (!p) return;
      var doc = document.createElement('article'); doc.className = 'tq-plan-doc';
      doc.appendChild(mdEl(p.text)); planBox.appendChild(doc);
      swapActs(doc, shown, true);
    }
    function openPlan(run, focus) {
      if (!plans[run]) return;
      shown = run; renderPlanDoc(); planTab.hidden = false;
      L.touched = true; toggleRight(true); select('plan', focus);
    }
    function resetPlans() { plans = {}; latest = shown = ''; planBox.innerHTML = ''; planTab.hidden = true; planTab.classList.remove('has'); if (tab === 'plan') select('files'); }
    document.addEventListener('tq:plan', function (e) {
      var d = e.detail || {}; if (!d.run || !d.text || plans[d.run]) return;
      var card = document.createElement('div'); card.className = 'tq-plan-card' + (d.old || REDUCE ? '' : ' enter'); card.dataset.run = d.run;
      card.innerHTML = '<div class="tq-pc-top">' + PLAN_IC + '<span></span></div><p></p>';
      $('.tq-pc-top span', card).textContent = '计划：' + planTitle(d.text);
      var n = planSteps(d.text); $('p', card).textContent = (n ? n + ' 步。' : '') + '完整计划在右边「计划」里。';
      var el = d.el && document.contains(d.el) ? d.el : null;
      if (el) { el.classList.add('tq-planned'); el.insertBefore(card, $(':scope > .xc-acts', el)); } else msgs.appendChild(card);
      plans[d.run] = { text: d.text, card: card }; latest = d.run;
      planTab.hidden = false; moveInk();
      if (!shown || !d.old) { shown = d.run; renderPlanDoc(); }
      planActs();
      // 刚出的计划：宽屏、中屏直接在右栏打开（Harness 的计划也是交上来就打开），窄屏和手机亮个小点
      if (!d.old) { if (L.mode === 'wide' || L.mode === 'mid') openPlan(d.run, false); else notify('plan'); }
    });
    root.addEventListener('click', function (e) {
      var b = e.target.closest('[data-plan-act]'); if (!b || b.disabled) return;
      var act = b.dataset.planAct, run = b.closest('[data-run]').dataset.run;
      if (act === 'open') openPlan(run, true);
      else if (act === 'edit') { cfg.plan = true; syncChips(); if (L.mode === 'phone') toggleRight(false); say.focus(); }
      else if (act === 'run') { cfg.plan = false; syncChips(); if (L.mode === 'phone') toggleRight(false); var c = chat(); if (c && c.tqSend) c.tqSend('按计划执行'); }
    });
    // 换对话：权限换成这个对话记下的（新对话用默认），计划模式关掉，右栏的计划清掉（读历史时会再画回来）
    document.addEventListener('tq:session', function (e) {
      var d = e.detail || {};
      cfg.perm = permOf(d.perm) ? d.perm : defPerm(); cfg.plan = false; closePop(false);
      resetPlans(); syncChips();
    });
    new MutationObserver(function (list) { if (list.some(function (m) { return [].some.call(m.addedNodes, function (n) { return n.nodeType === 1 && (n.matches('.xc-me') || n.querySelector('.xc-me')); }); })) planActs(); }).observe(msgs, { childList: true, subtree: true });
    syncChips();

    /* ================= 工作区（第 3 个 PR） =================
       新对话时输入框上面选：/data/workspace 本身（「工作目录」）或它下面一层的文件夹，也能新建；对话开始后固定（控制器只认第一句带的 work）。
       标题旁一直显示这个对话的工作区。新对话选过的记在 lm.tq.work。规则和控制器的 WORK_NAME 一样 */
    var WORK_NAME = /^(?!\.)[\w.一-龥-]{1,64}$/, ROOT_W = '工作目录', WORK_DIR = '/data/workspace';
    var FOLDER = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2.2h7a2 2 0 0 1 2 2v7.8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/></svg>';
    var ws = { sid: '', work: '', pick: WORK_NAME.test(store.get('work') || '') ? store.get('work') : '' };
    var workHead = $('#tq-work'), workBtn = $('#tq-work-pick'), workRow = workBtn.parentNode;
    var wpop = document.createElement('div'); wpop.className = 'tq-pop tq-work-pop'; wpop.id = 'tq-work-pop'; wpop.hidden = true; root.appendChild(wpop);
    function fresh() { return !ws.sid && !msgs.querySelector('.xc-me'); }   // 还没发第一句
    function curWork() { return ws.sid ? ws.work : ws.pick; }
    function syncWork() {
      root.classList.toggle('tq-in-conv', !fresh());   // 进了对话夜空暗一点（照 Linear 的内容优先），新对话亮回来
      var w = curWork(), name = w || ROOT_W;
      workHead.innerHTML = FOLDER + '<span></span>'; workHead.lastChild.textContent = name;
      workHead.title = WORK_DIR + (w ? '/' + w : ''); workHead.setAttribute('aria-label', '工作区：' + name);
      workRow.hidden = !fresh();
      $('span', workBtn).textContent = name; workBtn.setAttribute('aria-label', '新对话的工作区：' + name);
    }
    function workOpt(w, label, sub) {
      var b = document.createElement('button'); b.type = 'button'; b.className = 'tq-opt'; b.setAttribute('role', 'menuitemradio');
      b.setAttribute('aria-checked', String(w === ws.pick)); b.dataset.work = w;
      b.innerHTML = '<span class="tq-opt-t"><span></span><small></small></span>' + CHECK;
      b.querySelector('.tq-opt-t > span').textContent = label; b.querySelector('small').textContent = sub;
      return b;
    }
    function workMenu(names, note) {
      wpop.setAttribute('role', 'menu'); wpop.setAttribute('aria-label', '新对话的工作区'); wpop.innerHTML = '<p class="tq-pop-h">新对话在哪个文件夹里跑</p>';
      wpop.appendChild(workOpt('', ROOT_W, WORK_DIR + '，不分文件夹'));
      (names || []).forEach(function (n) { wpop.appendChild(workOpt(n, n, WORK_DIR + '/' + n)); });
      if (note) { var p = document.createElement('p'); p.className = 'tq-pop-h'; p.textContent = note; wpop.appendChild(p); }
      var add = document.createElement('button'); add.type = 'button'; add.className = 'tq-opt tq-work-add'; add.setAttribute('role', 'menuitem'); add.dataset.add = '1';
      add.innerHTML = '<span class="tq-opt-t"><span>新建文件夹…</span><small>发第一句时建好</small></span>'; wpop.appendChild(add);
    }
    function newFolder() {
      wpop.setAttribute('role', 'dialog'); wpop.setAttribute('aria-label', '新建文件夹');
      wpop.innerHTML = '<form class="tq-work-new"><label class="tq-pop-h" for="tq-work-name">新文件夹的名字（在 ' + WORK_DIR + ' 下面）</label>' +
        '<input id="tq-work-name" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="64" placeholder="比如 led-fast">' +
        '<p class="tq-work-err" role="alert"></p><div class="tq-acts"><button class="tq-btn" type="button" data-cancel="1">取消</button><button class="tq-btn go" type="submit">建好</button></div></form>';
      placeWork(); $('input', wpop).focus();
    }
    function placeWork() {
      var b = workBtn.getBoundingClientRect(), w = wpop.offsetWidth, hh = wpop.offsetHeight;
      var x = Math.max(12, Math.min(innerWidth - w - 12, b.left)), y = b.top - hh - 8;
      if (y < 12) y = Math.max(12, Math.min(innerHeight - hh - 12, b.bottom + 8));
      wpop.style.left = x + 'px'; wpop.style.top = y + 'px';
    }
    function focusWork() { var f = $('.tq-opt[aria-checked="true"]', wpop) || $('.tq-opt', wpop); if (f) f.focus(); }
    function openWork() {
      workMenu(null, '读取文件夹…'); wpop.hidden = false; placeWork(); workBtn.setAttribute('aria-expanded', 'true');
      if (!REDUCE) { wpop.classList.remove('in'); void wpop.offsetWidth; wpop.classList.add('in'); }
      focusWork();
      var c = chat(), my = wpop.dataset.seq = String(+(wpop.dataset.seq || 0) + 1);
      var stale = function () { return wpop.hidden || wpop.dataset.seq !== my || wpop.getAttribute('role') !== 'menu'; };
      if (!c || typeof c.tqCall !== 'function') return;
      c.tqCall('files', { path: WORK_DIR }, 30000).then(function (d) {
        if (stale()) return;
        var names = (d && d.entries || []).filter(function (x) { return x.dir && x.name !== 'uploads' && WORK_NAME.test(x.name); }).map(function (x) { return x.name; });
        workMenu(names, names.length ? '' : '工作目录下面还没有文件夹'); placeWork(); focusWork();
      }, function (e) {
        if (stale()) return;
        workMenu(null, '读不到文件夹：' + (e && e.message || '出错了')); placeWork(); focusWork();
      });
    }
    function closeWork(back) { if (wpop.hidden) return false; wpop.hidden = true; workBtn.setAttribute('aria-expanded', 'false'); if (back) workBtn.focus(); return true; }
    function pickWork(w) { ws.pick = w; store.set('work', w || null); syncWork(); closeWork(true); }
    workBtn.addEventListener('click', function () { if (wpop.hidden) openWork(); else closeWork(true); });
    wpop.addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      if (b.dataset.cancel) { closeWork(true); return; }
      if (b.dataset.add) { newFolder(); return; }
      if (b.dataset.work != null && b.getAttribute('role') === 'menuitemradio') pickWork(b.dataset.work);
    });
    wpop.addEventListener('submit', function (e) {
      e.preventDefault();
      var v = ($('input', wpop).value || '').trim();
      if (!WORK_NAME.test(v) || v === 'uploads') { $('.tq-work-err', wpop).textContent = '只能用字母、数字、汉字、点、横线和下划线，不能以点开头，最多 64 个字（uploads 留给上传的文件）'; $('input', wpop).focus(); return; }
      pickWork(v);
    });
    wpop.addEventListener('keydown', function (e) {
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].indexOf(e.key) < 0 || wpop.getAttribute('role') !== 'menu') return;
      var o = $$('.tq-opt', wpop); if (!o.length) return;
      var i = o.indexOf(document.activeElement), n = e.key === 'Home' ? 0 : e.key === 'End' ? o.length - 1 : (i + (e.key === 'ArrowDown' ? 1 : -1) + o.length) % o.length;
      o[n].focus(); e.preventDefault();
    });
    document.addEventListener('pointerdown', function (e) { if (!wpop.hidden && !wpop.contains(e.target) && !workBtn.contains(e.target)) closeWork(false); });
    addEventListener('resize', function () { if (!wpop.hidden) placeWork(); });
    document.addEventListener('tq:session', function (e) { var d = e.detail || {}; ws.sid = d.sid || ''; ws.work = d.work || ''; closeWork(false); syncWork(); });
    new MutationObserver(syncWork).observe(msgs, { childList: true });
    syncWork();

    /* ================= 终端里自己输命令（第 3 个 PR） =================
       右栏「终端」底下一个输入框，在这个对话（新对话就是选的）工作区里跑，最多 60 秒、输出最多 64 KB。
       控制器把命令放后台跑（term_run 回编号），这里每 400 毫秒取一次新输出（term_poll），网页藏起来时停。输出当文字画，不当 HTML */
    var cli = document.createElement('div'); cli.className = 'tq-cli';
    cli.innerHTML = '<div class="tq-cli-log" aria-live="polite"></div>' +
      '<form class="tq-cli-form" id="tq-term-form"><span class="tq-cli-ps" aria-hidden="true">$</span>' +
      '<input aria-label="在工作区里运行命令" placeholder="在工作区里运行命令，最多 60 秒" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="go">' +
      '<button type="submit" class="tq-ib" aria-label="运行"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg></button></form>';
    $('#tq-p-term').appendChild(cli);
    var cliLog = $('.tq-cli-log', cli), cliForm = $('form', cli), cliIn = $('input', cliForm), cliBtn = $('button', cliForm), cliBusy = false;
    function cliDur(ms) { var s = (ms || 0) / 1000; return (s < 10 ? Math.round(s * 10) / 10 : Math.round(s)) + ' 秒'; }
    function cliBlock(cmd) {
      var b = document.createElement('div'); b.className = 'tq-cli-run';
      b.innerHTML = '<div class="tq-cli-cmd"><span aria-hidden="true">$ </span><span></span></div><pre class="tq-cli-out"></pre><div class="tq-cli-end"></div>';
      b.querySelector('.tq-cli-cmd span:last-child').textContent = cmd;
      cliLog.appendChild(b); cliLog.scrollTop = cliLog.scrollHeight;
      return b;
    }
    function cliEnd(b, p, err) {
      var t = err ? '没跑成：' + err : p.timedOut ? '超过 60 秒，停了' : '退出码 ' + p.code + ' · 用时 ' + cliDur(p.ms);
      if (!err && p.truncated) t += ' · 输出超过 64 KB，后面的没显示';
      $('.tq-cli-end', b).textContent = t; b.classList.toggle('bad', !!err || p.code !== 0);
      cliBusy = false; cliIn.disabled = cliBtn.disabled = false; cliIn.focus();
    }
    cliForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var cmd = cliIn.value.trim(), c = chat();
      if (!cmd || cliBusy || !c || typeof c.tqCall !== 'function') return;
      var b = cliBlock(cmd), out = $('.tq-cli-out', b), off = 0, fail = function (x) { cliEnd(b, null, x && (x.msg || x.message) || '出错了'); };
      cliIn.value = ''; cliBusy = true; cliIn.disabled = cliBtn.disabled = true;
      c.tqCall('term_run', { work: curWork(), cmd: cmd }, 30000).then(function (r) {
        if (!r || r.error || !r.id) { fail(r); return; }
        (function next() {
          if (document.hidden) { setTimeout(next, 1000); return; }
          c.tqCall('term_poll', { id: r.id, off: off }, 30000).then(function (p) {
            if (!p || p.error) { fail(p); return; }
            if (p.out) { out.textContent += p.out; cliLog.scrollTop = cliLog.scrollHeight; }
            off = p.off;
            if (p.done) cliEnd(b, p); else setTimeout(next, 400);
          }, fail);
        })();
      }, fail);
    });

    /* ================= 命令面板里天启的操作、单键快捷键 =================
       照 Linear 的 Cmd K（开源的同类是 pacocoursey/cmdk）：chat.js 画命令面板时来要（LimingXinChat.tqActions），每项右边写快捷键。
       单键 C / M / P / W 只在没在打字、没开着弹层或面板、没按 Ctrl / Alt / ⌘ 时算（同 Linear）。 */
    var PI = {
      model: '<path d="M12 3.5 19.5 7.5v9L12 20.5 4.5 16.5v-9z"/><path d="M4.5 7.5 12 11.5l7.5-4M12 11.5v9"/>',
      shield: '<path d="M12 3.5 19 6v5.5c0 4.2-3 7.6-7 9-4-1.4-7-4.8-7-9V6z"/>',
      plan: '<path d="M10 7h9.5M10 12h9.5M10 17h9.5"/><path d="M4.5 7l1.2 1.2L8 6M4.5 12l1.2 1.2L8 11M4.5 17l1.2 1.2L8 16"/>',
      term: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M7.5 9.5l3 2.5-3 2.5M12.5 15h4"/>',
      left: '<rect x="3.5" y="4.5" width="17" height="15" rx="3"/><path d="M9.5 4.5v15"/>',
      right: '<rect x="3.5" y="4.5" width="17" height="15" rx="3"/><path d="M14.5 4.5v15"/>',
      plug: '<path d="M9 3.5v4M15 3.5v4M6.5 7.5h11v3a5.5 5.5 0 0 1-11 0zM12 16v4.5"/>'
    };
    function pickWorkspace() {   // 对话开始后工作区就固定了，所以「换工作区」是开个新对话再选
      if (!fresh()) { var c = chat(); if (c && c.tqNew) c.tqNew(); }
      if (wpop.hidden) openWork();
    }
    function openModel() { var b = $('.tq-instruments .xc-mdl'); if (b && b.getAttribute('aria-expanded') !== 'true') b.click(); }
    function tqActions() {
      var lf = frame.dataset.left;
      return [
        { ic: PI.model, t: '换模型', k: '模型 model 思考强度', kbd: 'M', run: openModel },
        { ic: PI.shield, t: '换权限', k: '权限 只读 完全 permission', kbd: 'P', run: function () { if (pop.hidden) openPop(); } },
        { ic: PI.plan, t: cfg.plan ? '关掉计划模式' : '计划模式', k: '计划 plan 先出计划', run: function () { planBtn.click(); } },
        { ic: 'files', t: '切换工作区', k: '工作区 文件夹 workspace 目录', kbd: 'W', run: pickWorkspace },
        { ic: PI.term, t: '打开终端', k: '终端 命令行 terminal shell', run: function () { L.touched = true; toggleRight(true); select('term', true); } },
        { ic: PI.left, t: lf === 'open' ? '收起左栏' : lf === 'rail' ? '展开左栏' : '打开左栏', k: '左栏 侧栏 对话记录 sidebar', kbd: 'Ctrl B', run: toggleLeft },
        { ic: PI.right, t: L.right ? '收起右栏' : '打开右栏', k: '右栏 面板 文件 终端 预览', kbd: 'Ctrl J', run: function () { L.touched = true; toggleRight(); } },
        { ic: PI.plug, t: '插件', k: '插件 plugin purge rea', run: function () { var b = $('.tq-plug-b'); if (b) b.click(); } },
        { ic: 'gear', t: '设置', k: '设置 外观 主题 默认权限 电脑 退出', run: function () { openSettings(); } }
      ];
    }
    var KEY1 = { c: function () { var c = chat(); if (c && c.tqNew) c.tqNew(); }, m: openModel, p: function () { if (pop.hidden) openPop(); }, w: pickWorkspace };
    function typing(el) { return !!el && el.nodeType === 1 && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)); }
    // 能不能用单键：没在打字，焦点不在弹层、面板里，也没开着它们（chat.js 的根本身是 role=dialog，所以按具体的弹层查）
    function quietKeys(e) {
      var t = e.target && e.target.nodeType === 1 ? e.target : document.activeElement, a = document.activeElement;
      if (typing(t) || typing(a)) return false;
      var OVER = '.tq-pop, .xc-pick, .xc-menu, .xc-sheet, .xc-pal, .tq-modal, .xc-drawer[role="dialog"]';
      if ((t && t.closest && t.closest(OVER)) || (a && a.closest && a.closest(OVER))) return false;
      if (root.classList.contains('pal-open') || root.classList.contains('sheet-open')) return false;
      if (root.classList.contains('dr-open') && drawer.getAttribute('role') === 'dialog') return false;
      return pop.hidden && wpop.hidden && !$('.xc-pick:not([hidden])') && !$('.xc-menu:not([hidden])');
    }
    $('.tq-cmd-b').addEventListener('click', function () { var c = chat(); if (c && c.tqPal) c.tqPal(); });

    /* ================= 快捷键 =================
       在 window 的捕获阶段最先处理：chat.js 在没有弹层时按 Esc 会关掉整个天启，设置和手机上的面板要先把 Esc 接住 */
    window.addEventListener('keydown', function (e) {
      var mod = e.ctrlKey || e.metaKey, k = (e.key || '').toLowerCase(), stop = function () { e.preventDefault(); e.stopImmediatePropagation(); };
      if (e.key === 'Escape' && (closePop(true) || closeWork(true))) { stop(); return; }
      if (!modal.hidden) { if (e.key === 'Escape') { stop(); closeSettings(); } return; }
      if (root.classList.contains('locked')) return;
      if (mod && !e.shiftKey && !e.altKey && k === 'b') { e.preventDefault(); toggleLeft(); }
      else if (mod && !e.shiftKey && !e.altKey && k === 'j') { e.preventDefault(); L.touched = true; toggleRight(); }
      else if (!mod && !e.altKey && !e.shiftKey && !e.repeat && !e.isComposing && KEY1[k] && e.key.length === 1 && quietKeys(e)) { e.preventDefault(); KEY1[k](); }
      else if (e.key === 'Escape' && L.mode === 'phone' && L.right && !root.classList.contains('sheet-open') && !root.classList.contains('dr-open')) { stop(); toggleRight(false); }
    }, true);

    layout(true); select('files'); linkRefs(msgs);
  }
})();
