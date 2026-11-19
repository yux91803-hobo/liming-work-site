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
        ? { trail: [168, 116, 30], head: [92, 60, 8], meteor: [[30, 44, 78], [150, 104, 28]], op: 'source-over', glowA: .09, bloomA: .2 }
        : { trail: [243, 223, 174], head: [255, 250, 238], meteor: [[255, 248, 232], [196, 255, 222]], op: 'lighter', glowA: .16, bloomA: .42 };
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
    /* 输入框边上走的星：天启在想、在做事的时候才有 */
    var orbit = { on: false, d: 0 }, P = {}, Q = {};
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
      var r = parseFloat(getComputedStyle(box).borderTopLeftRadius) || 22, trail = PAL.trail, head = PAL.head;
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
    else { wake(); (function clock() { setTimeout(function () { spawnMeteor(); clock(); }, 9000 + Math.random() * 13000); })(); setTimeout(function () { spawnMeteor(); }, 2200); }
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
    function layout() {
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
    Object.keys(MQ).forEach(function (k) { var q = MQ[k]; (q.addEventListener ? q.addEventListener('change', layout) : q.addListener(layout)); });
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
      var i = tabs.map(function (t) { return t.dataset.tab; }).indexOf(tab), n = tabs[(i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
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
      }
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
      plug: function () {
        return '<h3>插件</h3><p>装在 li2 上的 Harness 插件。开关存在 li2 上，下一轮就生效。</p><button class="tq-btn" type="button" data-act="plugins">打开插件开关</button>';
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
      } else if (b.dataset.act === 'plugins') {
        closeSettings(); var p = $('.tq-plug-b'); if (p && !p.hidden) setTimeout(function () { p.click(); }, REDUCE ? 0 : 230);
      }
    });
    modal.addEventListener('keydown', function (e) {
      if (e.key !== 'Tab') return;
      var f = $$('button:not(:disabled)', modal).filter(function (x) { return x.offsetParent !== null; });
      if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) { f[f.length - 1].focus(); e.preventDefault(); }
      else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { f[0].focus(); e.preventDefault(); }
    });

    /* ================= 快捷键 =================
       在 window 的捕获阶段最先处理：chat.js 在没有弹层时按 Esc 会关掉整个天启，设置和手机上的面板要先把 Esc 接住 */
    window.addEventListener('keydown', function (e) {
      var mod = e.ctrlKey || e.metaKey, k = (e.key || '').toLowerCase(), stop = function () { e.preventDefault(); e.stopImmediatePropagation(); };
      if (!modal.hidden) { if (e.key === 'Escape') { stop(); closeSettings(); } return; }
      if (root.classList.contains('locked')) return;
      if (mod && !e.shiftKey && !e.altKey && k === 'b') { e.preventDefault(); toggleLeft(); }
      else if (mod && !e.shiftKey && !e.altKey && k === 'j') { e.preventDefault(); L.touched = true; toggleRight(); }
      else if (e.key === 'Escape' && L.mode === 'phone' && L.right && !root.classList.contains('sheet-open') && !root.classList.contains('dr-open')) { stop(); toggleRight(false); }
    }, true);

    layout(); select('files'); linkRefs(msgs);
  }
})();
