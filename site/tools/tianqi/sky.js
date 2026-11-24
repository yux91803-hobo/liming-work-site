/* 天启工作台 · 天枢星象舱交互引擎（Cosmos Rework 2026-11-24）：
   chat.js 管会话请求、输入框与历史状态；本文件在不改动任何小芯共用脚本的前提下接管天启专属交互：
   1. 深空星象台背景：WebGL 双通道（6 阶 FBM 分形银河星云离屏纹理 + 多光谱恒星与十字衍射星芒）、离屏黄道/赤道星盘与五组星座、许愿流星、双彗星流光与文字化星尘。
      参考 xemantic/shader-web-background、Stellarium Web、Magic UI BorderBeam、React Bits（Particles / StarBorder / ClickSpark）。
   2. 天枢星象舱空间布局：顶栏星象遥测桥 + 全景深空对话舱 + 右翼 Claude Code 终端观测台 + 按需展开/停靠对话星轨舱（Ctrl+B / Ctrl+J）。
   3. 宇宙星表模型选择器 + 借鉴 OpenAI Codex 桌面端（openai/codex ComposerReasoningSelector）的独立思考强度星等控制台（#tq-eff / #tq-eff-pop，单键 E）。
   4. 实时思考星链（.tq-chain）：流式展示模型每一步推理与工具执行，支持展开/收起与一键定位终端记录。参考 sst/opencode、cline/cline、assistant-ui Reasoning 组件。
   5. 1:1 复刻 Claude Code CLI 终端（.tq-cc，参考 anthropics/claude-code Ink TUI）：天启深空星徽欢迎框、❯ 提示符输入行、⏺ 动作块与 ✻ 思考行、
      ⎿ 折角缩进层级（含 +N lines 展开/折叠）、Unified Diff 红绿增删带行号与语法着色、运行态旋转星（✢✳✶✻✽）及底部权限与 ? 快捷键提示栏。 */
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
    var $ = function (s, r) { return (r || root).querySelector(s); };
    var $$ = function (s, r) { return Array.prototype.slice.call((r || root).querySelectorAll(s)); };
    var h = function (tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
    var html = document.documentElement, frame = $('.tq-frame'), msgs = $('.xc-msgs'), box = $('.tq-box'), say = $('.tq-entry textarea'), sendBtn = $('.xc-send');
    var store = {
      get: function (k) { try { return localStorage.getItem('lm.tq.' + k); } catch (e) { return null; } },
      set: function (k, v) { try { if (v == null) localStorage.removeItem('lm.tq.' + k); else localStorage.setItem('lm.tq.' + k, v); } catch (e) { /* 隐私模式下仅当页有效 */ } }
    };
    var chat = function () { return window.LimingXinChat || null; };
    var state = function () { var c = chat(); return c ? c.state : {}; };
    var DPR = Math.min(COARSE ? 1.25 : 2, window.devicePixelRatio || 1), W = innerWidth, H = innerHeight;
    var COARSE = !!(window.matchMedia && matchMedia('(pointer: coarse)').matches);

    function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
    function bareCmd(d) {
      var s = String(d || '').trim(), m = /^\/(?:usr\/)?bin\/(?:ba)?sh -l?c (['"])([\s\S]*)\1$/.exec(s);
      return (m ? m[2] : s).replace(/^\s*(?:cd\s+\S+\s*(?:&&|;)\s*)+/, '');
    }
    function shortPath(p) {
      var s = String(p || '').replace(/^\/data\/workspace\//, '');
      var a = s.split('/').filter(Boolean);
      return a.length > 3 ? a.slice(-3).join('/') : (a.join('/') || String(p || ''));
    }
    function homePath(w) { return '~/workspace' + (w ? '/' + w : ''); }

    /* ================= 1. 深空星象台背景（WebGL 银河星云 + 恒星 + 星座星盘） ================= */
    function canvas(cls) { var c = document.createElement('canvas'); c.className = cls; c.setAttribute('aria-hidden', 'true'); return c; }
    var starCv = canvas('tq-sky'), back = canvas('tq-sky'), fx = canvas('tq-sky tq-fx'), chartCv = document.createElement('canvas');
    root.insertBefore(back, root.firstChild); root.insertBefore(starCv, root.firstChild); frame.parentNode.insertBefore(fx, frame.nextSibling);
    var INK = html.dataset.theme === 'light', PAL;
    function setPalette() {
      PAL = INK
        ? { trail: [168, 116, 30], head: [92, 60, 8], pTrail: [53, 88, 200], pHead: [24, 44, 120], meteor: [[30, 44, 78], [150, 104, 28]], link: [44, 66, 118], op: 'source-over', glowA: .09, bloomA: .2 }
        : { trail: [243, 223, 174], head: [255, 250, 238], pTrail: [157, 184, 255], pHead: [232, 238, 255], meteor: [[255, 248, 232], [184, 238, 248]], link: [240, 215, 156], op: 'lighter', glowA: .16, bloomA: .42 };
    }
    setPalette();
    var CONSTELLATIONS = [
      { code: 'UMa · 北斗', pts: [[.13, .17, 2.5], [.18, .15, 2.3], [.22, .18, 2.3], [.26, .21, 2.1], [.27, .27, 2.3], [.33, .28, 2.4], [.34, .22, 2.6]], edges: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 3]], alpha: 0 },
      { code: 'Cas · 仙后', pts: [[.75, .13, 2.3], [.78, .18, 2.5], [.82, .15, 2.6], [.85, .20, 2.3], [.89, .16, 2.2]], edges: [[0, 1], [1, 2], [2, 3], [3, 4]], alpha: 2 },
      { code: 'Ori · 猎户', pts: [[.15, .61, 2.8], [.22, .59, 2.4], [.17, .69, 2.3], [.19, .68, 2.4], [.21, .67, 2.3], [.15, .77, 2.2], [.23, .76, 2.85]], edges: [[0, 2], [1, 4], [0, 1], [2, 3], [3, 4], [2, 5], [4, 6], [5, 6]], alpha: 6 },
      { code: 'Cyg · 天鹅', pts: [[.74, .41, 2.75], [.69, .47, 2.4], [.63, .54, 2.2], [.65, .42, 2.2], [.73, .52, 2.2]], edges: [[0, 1], [1, 2], [3, 1], [1, 4]], alpha: 0 },
      { code: 'Lyr · 天琴', pts: [[.60, .14, 2.9], [.57, .18, 2.0], [.59, .22, 2.1], [.63, .21, 2.1], [.62, .17, 2.0]], edges: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 1], [0, 4]], alpha: 0 }
    ];
    var gl = null;
    try { gl = starCv.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false }); } catch (e) { gl = null; }
    var PREC = '#ifdef GL_FRAGMENT_PRECISION_HIGH\nprecision highp float;\n#else\nprecision mediump float;\n#endif\n';
    var NEB_VS = 'attribute vec2 aQuad;varying vec2 vUv;void main(){vUv=vec2(aQuad.x*0.5+0.5,0.5-aQuad.y*0.5);gl_Position=vec4(aQuad,0.0,1.0);}';
    var NEB_FS = PREC +
      'varying vec2 vUv;uniform vec2 uRes;uniform vec2 uPar;uniform float uTime;uniform float uInk;' +
      'float h21(vec2 p){p=mod(p,289.0);return fract(sin(dot(p,vec2(12.9898,78.233)))*437.5453);}' +
      'float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);' +
      'return mix(mix(h21(i),h21(i+vec2(1.0,0.0)),f.x),mix(h21(i+vec2(0.0,1.0)),h21(i+vec2(1.0,1.0)),f.x),f.y);}' +
      'float fbm(vec2 p){float v=0.0,a=0.5;mat2 m=mat2(1.62,1.22,-1.22,1.62);' +
      'for(int i=0;i<6;i++){v+=a*noise(p);p=m*p;a*=0.5;}return v;}' +
      'float ridge(vec2 p){float v=0.0,a=0.52;mat2 m=mat2(1.68,-1.18,1.18,1.68);' +
      'for(int i=0;i<4;i++){float n=1.0-abs(noise(p)*2.0-1.0);v+=a*n*n;p=m*p;a*=0.48;}return v;}' +
      'void main(){' +
      'vec2 uv=vUv+uPar*0.42;float asp=uRes.x/max(uRes.y,1.0);' +
      'vec2 c=vec2((uv.x-0.5)*asp,uv.y-0.48);' +
      'vec2 g=mat2(0.848,-0.530,0.530,0.848)*c;' +
      'float gy=g.y+0.042*sin(g.x*3.1+0.4);' +
      'float t=uTime*0.014;' +
      'vec2 q=vec2(fbm(vec2(g.x,gy)*2.55+vec2(t,-t*0.6)),fbm(vec2(g.x,gy)*2.55+vec2(5.2,1.3)+vec2(-t*0.7,t*0.5)));' +
      'float f=fbm(vec2(g.x,gy)*4.1+1.35*q);' +
      'float fil=ridge(vec2(g.x,gy)*5.4-0.9*q+vec2(1.9,t*0.4));' +
      'float dustN=fbm(vec2(g.x*4.6,gy*8.4)-q*0.95+vec2(2.7,t*0.4));' +
      'float band=exp(-gy*gy*9.8);' +
      'float halo=exp(-gy*gy*3.4);' +
      'float core=exp(-gy*gy*26.0)*exp(-pow(g.x-0.14,2.0)*1.55);' +
      'float rift=smoothstep(0.41,0.69,dustN)*exp(-pow(gy-0.012,2.0)*96.0)*0.78;' +
      'float calm=1.0-0.32*exp(-dot(c*vec2(1.15,1.65),c*vec2(1.15,1.65))*5.2);' +
      'if(uInk>0.5){' +
      'float wash=(band*(0.035+f*0.055+fil*0.03)+core*0.045)*(1.0-rift*0.55)*calm;' +
      'vec3 inkCol=mix(vec3(0.15,0.27,0.52),vec3(0.60,0.44,0.17),smoothstep(0.35,0.75,q.x));' +
      'gl_FragColor=vec4(inkCol*wash,wash);return;}' +
      'vec3 col=vec3(0.0);float a=0.0;' +
      'float cloud=pow(smoothstep(0.22,0.86,f),1.25);' +
      'float vein=pow(clamp(fil,0.0,1.0),2.4)*band;' +
      'vec3 sap=mix(vec3(0.032,0.095,0.24),vec3(0.095,0.255,0.52),cloud);' +
      'vec3 teal=vec3(0.07,0.34,0.46)*(vein*0.75+halo*0.18*smoothstep(0.48,0.86,q.y));' +
      'vec3 gold=vec3(0.66,0.50,0.26)*(pow(cloud,1.7)*core*0.92+vein*0.42*smoothstep(0.42,0.82,q.x));' +
      'float neb=(band*(0.16+0.68*cloud)+halo*0.10*cloud+core*0.34)*(1.0-rift)*calm;' +
      'col+=(sap*neb+teal*0.62*(1.0-rift*0.6)+gold*(1.0-rift*0.75)*calm);' +
      'a+=clamp(neb*0.68+vein*0.18,0.0,0.62);' +
      'float kn1=exp(-dot(c-vec2(0.34,-0.14),c-vec2(0.34,-0.14))*11.0)*fil;' +
      'float kn2=exp(-dot(c-vec2(-0.36,0.18),c-vec2(-0.36,0.18))*9.5)*cloud;' +
      'col+=vec3(0.48,0.36,0.19)*kn1*0.26+vec3(0.07,0.24,0.45)*kn2*0.28;' +
      'a+=kn1*0.14+kn2*0.15;' +
      'float limbR=length(vec2(c.x*0.50,uv.y-1.64))-0.66;' +
      'float limb=exp(-abs(limbR)*24.0)*smoothstep(0.62,1.01,uv.y);' +
      'float atm=smoothstep(0.72,1.03,uv.y)*0.18;' +
      'col+=vec3(0.07,0.22,0.46)*(limb*0.68+atm)+vec3(0.44,0.34,0.19)*limb*0.26;' +
      'a=clamp(a+limb*0.44+atm*0.44,0.0,0.86);' +
      'float dither=(h21(gl_FragCoord.xy)-0.5)/255.0;' +
      'gl_FragColor=vec4(max(col+dither,0.0),a);}';
    var VS = 'attribute vec2 aPos;attribute vec4 aStar;attribute vec3 aCol;uniform vec2 uPar;uniform float uTime;uniform float uDpr;uniform float uTw;varying vec3 vCol;varying float vA;varying float vS;' +
      'void main(){vec2 p=fract(aPos+uPar*aStar.y);gl_Position=vec4(p.x*2.0-1.0,1.0-p.y*2.0,0.0,1.0);' +
      'float amp=uTw*(aStar.x>1.7?0.48:0.28);vA=1.0-amp*(0.5+0.5*sin(uTime*aStar.z+aStar.w));vCol=aCol;vS=aStar.x;gl_PointSize=aStar.x*uDpr*5.8;}';
    var FS = PREC + 'varying vec3 vCol;varying float vA;varying float vS;uniform float uInk;' +
      'void main(){vec2 u=gl_PointCoord*2.0-1.0;float d=length(u);float edge=smoothstep(1.0,0.70,d);' +
      'if(uInk>0.5){float b=max(max(vCol.r,vCol.g),vCol.b);if(b<0.56)discard;float core=exp(-d*d*28.0);float rays=0.0;' +
      'if(vS>1.85){rays=(exp(-abs(u.y)*56.0)*exp(-abs(u.x)*2.8)+exp(-abs(u.x)*56.0)*exp(-abs(u.y)*2.8))*0.46;}' +
      'float a=(core+rays)*(0.62+0.38*vA)*b*0.82*edge;gl_FragColor=vec4(vec3(0.11,0.17,0.31)*a,a);return;}' +
      'float core=exp(-d*d*15.0);float halo=exp(-d*4.1)*0.34;float rays=0.0;' +
      'if(vS>1.85){rays=(exp(-abs(u.y)*42.0)*exp(-abs(u.x)*2.3)+exp(-abs(u.x)*42.0)*exp(-abs(u.y)*2.3))*0.58;}' +
      'float a=(core+halo+rays)*vA*edge;gl_FragColor=vec4(vCol*a,a);}';
    var BLIT_FS = PREC + 'varying vec2 vUv;uniform sampler2D uTex;uniform vec2 uPar;void main(){gl_FragColor=texture2D(uTex,clamp(vec2(vUv.x,1.0-vUv.y)+vec2(uPar.x,-uPar.y)*0.42,0.0,1.0));}';
    var prog = null, nebProg = null, blitProg = null, quadBuf = null, nebFbo = null, nebTex = null, nebW = 0, nebH = 0;
    var aPosLoc = -1, aStarLoc = -1, aColLoc = -1, aQuadLoc = -1, aBlitLoc = -1;
    var uPar, uTime, uDpr, uTw, uInk, uNebRes, uNebPar, uNebTime, uNebInk, uBlitTex, uBlitPar, nStars = 0, buf, anchors = [];
    function rng(seed) { return function () { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; }; }
    function tint(r) { var v = r(); return v < .38 ? [.74, .86, 1] : v < .70 ? [.96, .98, 1] : v < .90 ? [1, .92, .77] : [1, .78, .56]; }
    function buildStars() {
      var r = rng(19), baseN = Math.max(850, Math.min(3200, Math.round(W * H / 500)));
      var cCount = 0;
      CONSTELLATIONS.forEach(function (cs) { cCount += cs.pts.length; });
      var total = baseN + cCount, data = new Float32Array(total * 9), idx = 0;
      anchors = [];
      var asp = W / Math.max(H, 1);
      CONSTELLATIONS.forEach(function (cs, ci) {
        cs.pts.forEach(function (pt, pi) {
          var o = idx++ * 9, isA = pi === cs.alpha, col = isA ? [1, .91, .72] : [.86, .92, 1];
          data[o] = pt[0]; data[o + 1] = pt[1]; data[o + 2] = pt[2]; data[o + 3] = .42;
          data[o + 4] = .8 + ((ci * 7 + pi) % 5) * .28; data[o + 5] = (ci * 1.7 + pi * .9);
          data[o + 6] = col[0]; data[o + 7] = col[1]; data[o + 8] = col[2];
          anchors.push({ x: pt[0], y: pt[1], d: .42, s: pt[2] });
        });
      });
      for (var i = 0; i < baseN; i++) {
        var x, y, inGal = i < baseN * .45;
        if (inGal) {
          var u = (r() - .5) * 1.45 * Math.max(1, asp * .82), v = ((r() + r() + r()) / 3 - .5) * .34 - .042 * Math.sin(u * 3.1 + .4);
          var cx = .848 * u + .530 * v, cy = -.530 * u + .848 * v;
          x = ((cx / asp + .5) % 1 + 1) % 1;
          y = ((cy + .48) % 1 + 1) % 1;
        } else {
          x = r(); y = r();
        }
        var m = r(), size = m < .80 ? .52 + r() * .46 : m < .968 ? 1.0 + r() * .74 : 1.92 + r() * .88;
        var bright = m < .80 ? (inGal ? .46 : .36) + r() * .42 : m < .968 ? .62 + r() * .34 : .92 + r() * .08;
        var depth = .22 + r() * .78, c = tint(r), o2 = idx++ * 9;
        data[o2] = x; data[o2 + 1] = y; data[o2 + 2] = size; data[o2 + 3] = depth;
        data[o2 + 4] = .6 + r() * 2.5; data[o2 + 5] = r() * 6.283;
        data[o2 + 6] = c[0] * bright; data[o2 + 7] = c[1] * bright; data[o2 + 8] = c[2] * bright;
        if (size > 1.42 && anchors.length < 76) anchors.push({ x: x, y: y, d: depth, s: size });
      }
      nStars = total; gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    }
    function initGL() {
      function sh(type, src) { var s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null; }
      function link(vs, fs) {
        var v = sh(gl.VERTEX_SHADER, vs), f = sh(gl.FRAGMENT_SHADER, fs);
        if (!v || !f) return null;
        var p = gl.createProgram(); gl.attachShader(p, v); gl.attachShader(p, f); gl.linkProgram(p);
        return gl.getProgramParameter(p, gl.LINK_STATUS) ? p : null;
      }
      prog = link(VS, FS);
      if (!prog) { gl = null; return; }
      nebProg = link(NEB_VS, NEB_FS);
      blitProg = link(NEB_VS, BLIT_FS);
      buf = gl.createBuffer();
      aPosLoc = gl.getAttribLocation(prog, 'aPos'); aStarLoc = gl.getAttribLocation(prog, 'aStar'); aColLoc = gl.getAttribLocation(prog, 'aCol');
      uPar = gl.getUniformLocation(prog, 'uPar'); uTime = gl.getUniformLocation(prog, 'uTime'); uDpr = gl.getUniformLocation(prog, 'uDpr'); uTw = gl.getUniformLocation(prog, 'uTw'); uInk = gl.getUniformLocation(prog, 'uInk');
      if (nebProg && blitProg) {
        quadBuf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
        aQuadLoc = gl.getAttribLocation(nebProg, 'aQuad');
        uNebRes = gl.getUniformLocation(nebProg, 'uRes'); uNebPar = gl.getUniformLocation(nebProg, 'uPar');
        uNebTime = gl.getUniformLocation(nebProg, 'uTime'); uNebInk = gl.getUniformLocation(nebProg, 'uInk');
        aBlitLoc = gl.getAttribLocation(blitProg, 'aQuad');
        uBlitTex = gl.getUniformLocation(blitProg, 'uTex'); uBlitPar = gl.getUniformLocation(blitProg, 'uPar');
        nebTex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, nebTex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        nebFbo = gl.createFramebuffer();
      }
      gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    }
    function renderNebula() {
      if (!gl || !nebProg || !nebFbo || !nebTex || !quadBuf) return;
      var tw = Math.max(2, Math.round(W * .65)), th = Math.max(2, Math.round(H * .65));
      gl.bindTexture(gl.TEXTURE_2D, nebTex);
      if (tw !== nebW || th !== nebH) {
        nebW = tw; nebH = th;
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, nebW, nebH, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, nebFbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, nebTex, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE) {
        gl.viewport(0, 0, nebW, nebH);
        gl.disable(gl.BLEND);
        gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
        gl.useProgram(nebProg);
        gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
        if (aQuadLoc >= 0) { gl.enableVertexAttribArray(aQuadLoc); gl.vertexAttribPointer(aQuadLoc, 2, gl.FLOAT, false, 0, 0); }
        gl.uniform2f(uNebRes, W, H); gl.uniform2f(uNebPar, 0, 0); gl.uniform1f(uNebTime, 12.0); gl.uniform1f(uNebInk, INK ? 1 : 0);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        if (aQuadLoc >= 0) gl.disableVertexAttribArray(aQuadLoc);
        gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      } else {
        nebW = 0;
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
    var par = { x: 0, y: 0, tx: 0, ty: 0 }, mouse = { x: -999, y: -999, on: false, a: 0 }, t0 = performance.now(), lastStar = 0;
    addEventListener('pointermove', function (e) {
      if (e.pointerType === 'mouse') {
        par.tx = (e.clientX / W - .5) * -.010; par.ty = (e.clientY / H - .5) * -.010;
        mouse.x = e.clientX; mouse.y = e.clientY; mouse.on = true;
      }
    });
    document.addEventListener('pointerleave', function () { mouse.on = false; });
    window.addEventListener('blur', function () { mouse.on = false; });
    function drawStars(now) {
      if (!gl) return;
      par.x += (par.tx - par.x) * .04; par.y += (par.ty - par.y) * .04;
      var sec = REDUCE ? 0 : (now - t0) / 1000;
      gl.viewport(0, 0, starCv.width, starCv.height); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      if (nebW > 0 && blitProg && quadBuf) {
        gl.useProgram(blitProg);
        gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
        if (aBlitLoc >= 0) { gl.enableVertexAttribArray(aBlitLoc); gl.vertexAttribPointer(aBlitLoc, 2, gl.FLOAT, false, 0, 0); }
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, nebTex);
        gl.uniform1i(uBlitTex, 0); gl.uniform2f(uBlitPar, par.x, par.y);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        if (aBlitLoc >= 0) gl.disableVertexAttribArray(aBlitLoc);
      } else if (nebProg && quadBuf) {
        gl.useProgram(nebProg);
        gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
        if (aQuadLoc >= 0) { gl.enableVertexAttribArray(aQuadLoc); gl.vertexAttribPointer(aQuadLoc, 2, gl.FLOAT, false, 0, 0); }
        gl.uniform2f(uNebRes, W, H); gl.uniform2f(uNebPar, par.x, par.y); gl.uniform1f(uNebTime, sec); gl.uniform1f(uNebInk, INK ? 1 : 0);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        if (aQuadLoc >= 0) gl.disableVertexAttribArray(aQuadLoc);
      }
      gl.useProgram(prog);
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.enableVertexAttribArray(aPosLoc); gl.vertexAttribPointer(aPosLoc, 2, gl.FLOAT, false, 36, 0);
      gl.enableVertexAttribArray(aStarLoc); gl.vertexAttribPointer(aStarLoc, 4, gl.FLOAT, false, 36, 8);
      gl.enableVertexAttribArray(aColLoc); gl.vertexAttribPointer(aColLoc, 3, gl.FLOAT, false, 36, 24);
      gl.uniform2f(uPar, par.x, par.y); gl.uniform1f(uTime, sec); gl.uniform1f(uDpr, DPR); gl.uniform1f(uTw, REDUCE ? 0 : 1); gl.uniform1f(uInk, INK ? 1 : 0);
      gl.drawArrays(gl.POINTS, 0, nStars);
    }
    function fallbackStars() {
      var c = starCv.getContext('2d'); if (!c) return; var r = rng(19);
      c.setTransform(DPR, 0, 0, DPR, 0, 0); c.clearRect(0, 0, W, H);
      if (!INK) {
        var mw = c.createLinearGradient(0, H * .88, W, H * .08);
        mw.addColorStop(0, 'rgba(18,46,98,0)'); mw.addColorStop(.35, 'rgba(24,62,126,.22)');
        mw.addColorStop(.58, 'rgba(92,72,40,.16)'); mw.addColorStop(.82, 'rgba(22,74,108,.18)'); mw.addColorStop(1, 'rgba(14,34,76,0)');
        c.fillStyle = mw; c.fillRect(0, 0, W, H);
        var hz = c.createRadialGradient(W * .5, H * 1.35, H * .2, W * .5, H * 1.35, H * .68);
        hz.addColorStop(0, 'rgba(34,88,168,.26)'); hz.addColorStop(.6, 'rgba(20,52,110,.1)'); hz.addColorStop(1, 'rgba(0,0,0,0)');
        c.fillStyle = hz; c.fillRect(0, 0, W, H);
      }
      for (var i = 0; i < W * H / 720; i++) { var s = r() < .93 ? .45 + r() * .6 : 1.25 + r(); c.fillStyle = INK ? 'rgba(28,40,72,' + (.2 + r() * .45) + ')' : 'rgba(232,238,255,' + (.25 + r() * .65) + ')'; c.beginPath(); c.arc(r() * W, r() * H, s * .85, 0, 7); c.fill(); }
    }
    var ctx = fx.getContext('2d'), bctx = back.getContext('2d'), meteors = [], dust = [], skyDust = [], sparks = [], rings = [], fxRaf = 0, meteorsOn = store.get('meteor') !== 'off';
    var bctxDirty = false, ctxDirty = false;
    function buildChart() {
      chartCv.width = Math.round(W * DPR); chartCv.height = Math.round(H * DPR);
      var cc = chartCv.getContext('2d'); if (!cc) return;
      cc.setTransform(DPR, 0, 0, DPR, 0, 0); cc.clearRect(0, 0, W, H);
      var gold = INK ? 'rgba(138,98,28,' : 'rgba(240,215,156,', blue = INK ? 'rgba(42,72,136,' : 'rgba(132,178,246,';
      var R1 = Math.max(W, H) * 1.18, cx1 = W * .52, cy1 = H * .21 + R1;
      cc.strokeStyle = gold + (INK ? '.15)' : '.095)'); cc.lineWidth = .75;
      cc.beginPath(); cc.arc(cx1, cy1, R1, -Math.PI * .78, -Math.PI * .22); cc.stroke();
      for (var d = -126; d <= -54; d += 2) {
        var rad = d * Math.PI / 180, major = d % 8 === 0, len = major ? 5.5 : 2.5;
        var x0 = cx1 + Math.cos(rad) * R1, y0 = cy1 + Math.sin(rad) * R1;
        if (x0 < 24 || x0 > W - 24 || y0 < 18 || y0 > H - 18) continue;
        cc.strokeStyle = gold + (major ? (INK ? '.24)' : '.17)') : (INK ? '.12)' : '.08)'));
        cc.beginPath(); cc.moveTo(x0, y0); cc.lineTo(x0 + Math.cos(rad) * len, y0 + Math.sin(rad) * len); cc.stroke();
        if (d % 16 === 0 && W >= 640 && x0 > 95 && x0 < W - 120) {
          cc.fillStyle = gold + (INK ? '.28)' : '.17)');
          cc.font = '500 9.5px ui-monospace, "SF Mono", Menlo, monospace';
          var raH = 18 + Math.round((d + 112) / 16);
          cc.fillText('RA ' + raH + 'h · +23°', x0 + 6, y0 - 7);
        }
      }
      var R2 = Math.max(W, H) * 1.24, cx2 = W * .48, cy2 = H * .79 - R2;
      cc.save(); cc.setLineDash([4, 7]); cc.strokeStyle = blue + (INK ? '.13)' : '.085)'); cc.lineWidth = .7;
      cc.beginPath(); cc.arc(cx2, cy2, R2, Math.PI * .22, Math.PI * .78); cc.stroke(); cc.restore();
      var showLabel = W >= 700;
      CONSTELLATIONS.forEach(function (cs) {
        cc.strokeStyle = gold + (INK ? '.18)' : '.14)'); cc.lineWidth = .8;
        cs.edges.forEach(function (e) {
          var a = cs.pts[e[0]], b = cs.pts[e[1]];
          cc.beginPath(); cc.moveTo(a[0] * W, a[1] * H); cc.lineTo(b[0] * W, b[1] * H); cc.stroke();
        });
        var ap = cs.pts[cs.alpha || 0], ax = ap[0] * W, ay = ap[1] * H;
        cc.strokeStyle = gold + (INK ? '.30)' : '.23)'); cc.lineWidth = .75;
        cc.beginPath(); cc.arc(ax, ay, 5.2, 0, 6.283); cc.stroke();
        if (showLabel) {
          cc.fillStyle = gold + (INK ? '.34)' : '.21)');
          cc.font = '500 10px Inter, -apple-system, "PingFang SC", system-ui, sans-serif';
          cc.fillText(cs.code, ax + 9, ay + 3);
        }
      });
    }
    function blitChart() {
      bctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      bctx.clearRect(0, 0, W, H);
      if (chartCv.width && chartCv.height) bctx.drawImage(chartCv, 0, 0, W, H);
    }
    function size() {
      W = innerWidth; H = innerHeight; DPR = Math.min(COARSE ? 1.25 : 2, window.devicePixelRatio || 1);
      [starCv, back, fx].forEach(function (c) { c.width = Math.round(W * DPR); c.height = Math.round(H * DPR); c.style.height = H + 'px'; });
      bctxDirty = ctxDirty = false;
      buildChart(); blitChart();
      if (gl) { renderNebula(); buildStars(); drawStars(performance.now()); } else fallbackStars();
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
    function spawnSpark(x, y, col, n) {
      if (REDUCE || document.hidden) return;
      var count = n || 8, base = Math.random() * Math.PI * 2;
      for (var i = 0; i < count; i++) {
        var ang = base + (Math.PI * 2 * i) / count + (Math.random() - .5) * .22;
        sparks.push({ x: x, y: y, ang: ang, r0: 6, r1: 20 + Math.random() * 14, age: 0, life: .34 + Math.random() * .08, c: col || PAL.trail });
      }
      wake();
    }
    function spawnRing(x, y, col, maxR) {
      if (REDUCE || document.hidden) return;
      rings.push({ x: x, y: y, r0: 8, r1: maxR || 46, age: 0, life: .48, c: col || PAL.pTrail });
      wake();
    }
    function sparkFrom(el, col, n) {
      if (!el || REDUCE) return;
      var r = el.getBoundingClientRect();
      if (r.width && r.height) spawnSpark(r.left + r.width / 2, r.top + r.height / 2, col, n);
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
    var nearPts = [];
    function drawConstellation(dt) {
      var target = mouse.on && W >= 760 ? 1 : 0;
      mouse.a += (target - mouse.a) * Math.min(1, dt * 6);
      if (mouse.a < .01 || !anchors.length) return false;
      nearPts.length = 0;
      var R = 175, R2 = R * R;
      for (var i = 0; i < anchors.length; i++) {
        var s = anchors[i];
        var sx = (((s.x + par.x * s.d) % 1) + 1) % 1 * W, sy = (((s.y + par.y * s.d) % 1) + 1) % 1 * H;
        var dx = sx - mouse.x, dy = sy - mouse.y, d2 = dx * dx + dy * dy;
        if (d2 < R2) nearPts.push({ x: sx, y: sy, w: 1 - Math.sqrt(d2) / R });
      }
      if (!nearPts.length) return false;
      var col = PAL.link, baseA = (INK ? .22 : .26) * mouse.a;
      bctx.lineWidth = .75;
      for (var a = 0; a < nearPts.length; a++) {
        var p = nearPts[a];
        bctx.fillStyle = rgba(col, baseA * 1.4 * p.w);
        bctx.beginPath(); bctx.arc(p.x, p.y, 1.3 + p.w * 1.1, 0, 6.283); bctx.fill();
        for (var b = a + 1; b < nearPts.length; b++) {
          var q = nearPts[b], dist = Math.hypot(p.x - q.x, p.y - q.y);
          if (dist < 135) {
            bctx.strokeStyle = rgba(col, baseA * (1 - dist / 135) * Math.min(p.w, q.w));
            bctx.beginPath(); bctx.moveTo(p.x, p.y); bctx.lineTo(q.x, q.y); bctx.stroke();
          }
        }
      }
      return true;
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
    function drawSparks(dt) {
      for (var i = sparks.length - 1; i >= 0; i--) {
        var s = sparks[i]; s.age += dt; if (s.age >= s.life) { sparks.splice(i, 1); continue; }
        var k = s.age / s.life, e = 1 - Math.pow(1 - k, 3), tail = 1 - Math.pow(1 - Math.max(0, k - .22) / .78, 2);
        var rA = s.r0 + (s.r1 - s.r0) * tail, rB = s.r0 + (s.r1 - s.r0) * e, alpha = (1 - k) * (INK ? .78 : .92);
        var cx = Math.cos(s.ang), sy = Math.sin(s.ang);
        ctx.strokeStyle = rgba(s.c, alpha); ctx.lineCap = 'round'; ctx.lineWidth = 1.4 * (1 - k * .5);
        ctx.beginPath(); ctx.moveTo(s.x + cx * rA, s.y + sy * rA); ctx.lineTo(s.x + cx * rB, s.y + sy * rB); ctx.stroke();
      }
      for (var j = rings.length - 1; j >= 0; j--) {
        var g = rings[j]; g.age += dt; if (g.age >= g.life) { rings.splice(j, 1); continue; }
        var rk = g.age / g.life, re = 1 - Math.pow(1 - rk, 3), rad = g.r0 + (g.r1 - g.r0) * re;
        ctx.strokeStyle = rgba(g.c, (1 - rk) * (1 - rk) * (INK ? .42 : .55)); ctx.lineWidth = 1.3 * (1 - rk * .5);
        ctx.beginPath(); ctx.arc(g.x, g.y, rad, 0, 6.283); ctx.stroke();
      }
    }
    var orbit = { on: false, alpha: 0, d: 0, plan: false }, P = {}, Q = {};
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
      orbit.alpha += ((orbit.on ? 1 : 0) - orbit.alpha) * Math.min(1, dt * (orbit.on ? 7 : 5));
      if (orbit.alpha < .01) { orbit.alpha = 0; return false; }
      var b = box.getBoundingClientRect(); if (!b.width || !b.height) return false;
      var r = parseFloat(getComputedStyle(box).borderTopLeftRadius) || 12, trail = orbit.plan ? PAL.pTrail : PAL.trail, head = orbit.plan ? PAL.pHead : PAL.head, oa = orbit.alpha;
      var per = rrPoint(b.left, b.top, b.width, b.height, r, 0, P), Lc = 175, steps = 40;
      orbit.d += per / 4.2 * dt;
      rrPoint(b.left, b.top, b.width, b.height, r, orbit.d, P);
      var px = P.x, py = P.y;
      ctx.lineCap = 'round';
      for (var i = 1; i <= steps; i++) {
        rrPoint(b.left, b.top, b.width, b.height, r, orbit.d - Lc * i / steps, Q);
        var u = 1 - (i - .5) / steps, f = u * u * oa;
        ctx.strokeStyle = rgba(trail, f * PAL.glowA); ctx.lineWidth = 5.5; ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(Q.x, Q.y); ctx.stroke();
        ctx.strokeStyle = rgba(i < 4 ? head : trail, f * .95); ctx.lineWidth = 1.3; ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(Q.x, Q.y); ctx.stroke();
        px = Q.x; py = Q.y;
      }
      var bloom = ctx.createRadialGradient(P.x, P.y, 0, P.x, P.y, 24); bloom.addColorStop(0, rgba(trail, PAL.bloomA * oa)); bloom.addColorStop(.28, rgba(trail, PAL.bloomA * oa / 3)); bloom.addColorStop(1, rgba(trail, 0));
      ctx.fillStyle = bloom; ctx.fillRect(P.x - 24, P.y - 24, 48, 48);
      ctx.fillStyle = rgba(head, oa); ctx.beginPath(); ctx.arc(P.x, P.y, 1.7, 0, 6.283); ctx.fill();
      var sp = 5 + 2 * Math.sin(performance.now() / 160);
      [[1, 0], [0, 1]].forEach(function (dd) { var g = ctx.createLinearGradient(P.x - dd[0] * sp, P.y - dd[1] * sp, P.x + dd[0] * sp, P.y + dd[1] * sp); g.addColorStop(0, rgba(head, 0)); g.addColorStop(.5, rgba(head, .9 * oa)); g.addColorStop(1, rgba(head, 0)); ctx.strokeStyle = g; ctx.lineWidth = .9; ctx.beginPath(); ctx.moveTo(P.x - dd[0] * sp, P.y - dd[1] * sp); ctx.lineTo(P.x + dd[0] * sp, P.y + dd[1] * sp); ctx.stroke(); });
      if (orbit.on && Math.random() < .45) { var push = 8 + Math.random() * 18, drift = (Math.random() - .5) * 14; dust.push({ x: P.x, y: P.y, vx: P.nx * push - P.ny * drift, vy: P.ny * push + P.nx * drift, age: 0, life: .4 + Math.random() * .5, s: .45 + Math.random() * .7, c: trail, a: .85 }); }
      var d2 = orbit.d + per * .5;
      rrPoint(b.left, b.top, b.width, b.height, r, d2, P);
      px = P.x; py = P.y;
      for (var j = 1; j <= 16; j++) {
        rrPoint(b.left, b.top, b.width, b.height, r, d2 - 72 * j / 16, Q);
        var u2 = 1 - (j - .5) / 16;
        ctx.strokeStyle = rgba(trail, u2 * u2 * .42 * oa); ctx.lineWidth = 1.05; ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(Q.x, Q.y); ctx.stroke();
        px = Q.x; py = Q.y;
      }
      ctx.fillStyle = rgba(head, .65 * oa); ctx.beginPath(); ctx.arc(P.x, P.y, 1.15, 0, 6.283); ctx.fill();
      return true;
    }
    var lastFx = performance.now(), kbAt = 0, touchAt = 0;
    document.addEventListener('touchstart', function () { touchAt = performance.now(); }, { capture: true, passive: true });
    document.addEventListener('focusout', function (e) { if (e.target && /^(TEXTAREA|INPUT)$/.test(e.target.tagName)) touchAt = performance.now(); }, true);
    function loop(now) {
      var dt = Math.min(.05, (now - lastFx) / 1000); lastFx = now;
      var kbBusy = html.classList.contains('kb-anim') || (kbAt && now - kbAt < 120) || (COARSE && touchAt && now - touchAt < 480);
      var kbIdle = COARSE && (html.classList.contains('kb-up') || document.activeElement === say) && !orbit.on && orbit.alpha <= 0 && !dust.length && !sparks.length && !rings.length;
      if (!kbBusy && !kbIdle) {
        if (now - lastStar > (COARSE ? 110 : 42)) { drawStars(now); lastStar = now; }
        var needBack = meteors.length || skyDust.length || mouse.on || mouse.a > .01;
        if (needBack || bctxDirty) {
          blitChart();
          if (needBack) {
            bctx.globalCompositeOperation = PAL.op;
            var drewLink = drawConstellation(dt);
            for (var i = meteors.length - 1; i >= 0; i--) if (!drawMeteor(meteors[i], dt)) meteors.splice(i, 1);
            drawDust(dt, skyDust, bctx);
            bctx.globalCompositeOperation = 'source-over';
            bctxDirty = !!(meteors.length || skyDust.length || drewLink);
          } else bctxDirty = false;
        }
        var needFx = orbit.on || orbit.alpha > 0 || dust.length || sparks.length || rings.length;
        if (needFx || ctxDirty) {
          ctx.setTransform(DPR, 0, 0, DPR, 0, 0); ctx.clearRect(0, 0, W, H);
          if (needFx) {
            ctx.globalCompositeOperation = PAL.op;
            var drewOrbit = drawOrbit(dt);
            drawDust(dt, dust, ctx);
            drawSparks(dt);
            ctx.globalCompositeOperation = 'source-over';
            ctxDirty = !!(drewOrbit || dust.length || sparks.length || rings.length);
          } else ctxDirty = false;
        }
      }
      fxRaf = requestAnimationFrame(loop);
    }
    function wake() { if (!fxRaf && !document.hidden && !REDUCE) { lastFx = performance.now(); fxRaf = requestAnimationFrame(loop); } }
    document.addEventListener('visibilitychange', function () { if (document.hidden) { cancelAnimationFrame(fxRaf); fxRaf = 0; } else wake(); });
    if (gl) initGL();
    size();
    if (REDUCE) drawStars(performance.now());
    else { wake(); (function clock() { setTimeout(function () { spawnMeteor(); clock(); }, 18000 + Math.random() * 24000); })(); setTimeout(function () { spawnMeteor(); }, 2200); }
    new MutationObserver(function () { INK = html.dataset.theme === 'light'; setPalette(); buildChart(); blitChart(); if (!gl) fallbackStars(); else { renderNebula(); drawStars(performance.now()); } }).observe(html, { attributes: true, attributeFilter: ['data-theme'] });

    var spotRaf = 0, spotEv = null;
    document.addEventListener('pointermove', function (e) {
      if (REDUCE || e.pointerType !== 'mouse') return;
      spotEv = e;
      if (spotRaf) return;
      spotRaf = requestAnimationFrame(function () {
        spotRaf = 0;
        if (!spotEv) return;
        if (box.contains(spotEv.target)) {
          var r = box.getBoundingClientRect();
          box.style.setProperty('--mx', Math.round(spotEv.clientX - r.left) + 'px');
          box.style.setProperty('--my', Math.round(spotEv.clientY - r.top) + 'px');
        }
        var eo = frame.hasAttribute('data-start') ? $('.tq-empty-orbit') : null;
        if (eo) {
          var er = eo.getBoundingClientRect(), ecx = er.left + er.width / 2, ecy = er.top + er.height / 2;
          var enx = Math.max(-1, Math.min(1, (spotEv.clientX - ecx) / 260)), eny = Math.max(-1, Math.min(1, (spotEv.clientY - ecy) / 220));
          eo.style.setProperty('--ax', (-eny * 14).toFixed(2) + 'deg');
          eo.style.setProperty('--ay', (enx * 14).toFixed(2) + 'deg');
        }
      });
    }, { passive: true });
    document.addEventListener('pointerleave', function () {
      var eo = $('.tq-empty-orbit');
      if (eo) { eo.style.removeProperty('--ax'); eo.style.removeProperty('--ay'); }
    });
    $('.tq-mid').addEventListener('click', function (e) {
      if (REDUCE || html.classList.contains('kb-up') || html.classList.contains('kb-anim')) return;
      var eo = e.target.closest && e.target.closest('.tq-empty-orbit');
      if (eo) {
        var r = eo.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        spawnRing(cx, cy, PAL.trail, 56);
        spawnSpark(cx, cy, PAL.trail, 12);
        eo.classList.remove('surge'); void eo.offsetWidth; eo.classList.add('surge');
        clearTimeout(eo._st); eo._st = setTimeout(function () { eo.classList.remove('surge'); }, 900);
        return;
      }
      if (e.target.closest && e.target.closest('button, a, input, textarea, select, label, .xc-bub, .tq-box, .tq-plan-card, .tq-chain, .xc-pick, .xc-menu, .tq-mid-head')) return;
      var sel = window.getSelection && window.getSelection();
      if (sel && String(sel).trim()) return;
      if (e.target.closest && e.target.closest('.xc-body')) {
        spawnSpark(e.clientX, e.clientY, PAL.trail, 7);
        spawnMeteor({ x: Math.max(24, Math.min(W - 24, e.clientX - 70)), y: Math.max(16, e.clientY - 42) });
      }
    });

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
      sparkFrom(sendBtn, orbit.plan ? PAL.pTrail : PAL.trail, 10);
      if (frame.hasAttribute('data-start')) dockFrom = $('.tq-dock').getBoundingClientRect().top;
    }
    document.addEventListener('keydown', function (e) { if (e.target === say && e.key === 'Enter' && !e.shiftKey && !e.isComposing && !(say.getAttribute('enterkeyhint') === 'enter')) sending(); }, true);
    document.addEventListener('submit', function (e) { if (e.target && e.target.classList && e.target.classList.contains('xc-ft')) sending(); }, true);

    /* ================= 2. 天枢星象舱空间布局（遥测顶栏 + 星轨侧舱 + 终端观测右翼） ================= */
    var MQ = { wide: matchMedia('(min-width: 1200px)'), mid: matchMedia('(min-width: 900px)'), tab: matchMedia('(min-width: 600px)') };
    var L = { mode: '', left: store.get('left') === '1', leftMid: false, right: store.get('right') !== '0', touched: false };
    var scrim2 = h('div', 'tq-scrim2'); root.appendChild(scrim2);
    var side = $('.tq-side'), right = $('.tq-right'), drawer = $('.xc-drawer'), histB = $('.tq-hist-b'), histCnt = $('.tq-hist-cnt');
    var panelB = $('.tq-panel-b'), badge = $('.tq-badge'), topTools = $('#tq-top-tools'), sideFoot = $('#tq-side-foot');
    var setBtn = $('.tq-set-b'), plugBtn = $('.tq-plug-b'), li2Btn = $('.tq-li2');
    function modeNow() { return MQ.wide.matches ? 'wide' : MQ.mid.matches ? 'mid' : MQ.tab.matches ? 'narrow' : 'phone'; }
    function syncToolSlot(docked) {
      var host = docked ? topTools : sideFoot;
      [setBtn, plugBtn, li2Btn].forEach(function (el) { if (el && host && el.parentNode !== host) host.appendChild(el); });
    }
    function syncHistBadge() {
      var s = state(), list = (s && s.sessList || []).filter(function (x) { return !x.main && !x.archived; });
      if (!histCnt) return;
      histCnt.hidden = !list.length;
      if (list.length) histCnt.textContent = String(list.length);
    }
    function layout(instant) {
      if (instant === true) { frame.classList.add('tq-instant'); requestAnimationFrame(function () { requestAnimationFrame(function () { frame.classList.remove('tq-instant'); }); }); }
      var m = modeNow(), changed = m !== L.mode, docked = m === 'wide' || m === 'mid';
      if (changed && L.mode && m !== 'wide') { L.right = false; L.leftMid = false; }
      if (changed && !L.mode && m !== 'wide') { L.right = false; L.leftMid = false; }
      L.mode = m;
      syncToolSlot(docked);
      var leftOpen = m === 'wide' ? L.left : m === 'mid' ? L.leftMid : false;
      frame.dataset.mode = m;
      frame.dataset.left = docked ? (leftOpen ? 'open' : 'closed') : 'drawer';
      frame.dataset.right = L.right ? 'open' : 'closed';
      if (docked) drawer.setAttribute('role', 'navigation'); else drawer.setAttribute('role', 'dialog');
      var histLbl = leftOpen ? '收起对话星轨' : '展开对话星轨';
      if (histB) { histB.setAttribute('aria-expanded', String(leftOpen)); histB.setAttribute('aria-label', histLbl); histB.title = histLbl + '（Ctrl+B）'; }
      var foldBtn = $('.tq-fold');
      if (foldBtn) { foldBtn.setAttribute('aria-label', docked ? '收起对话星轨' : '关闭对话记录'); }
      side.inert = docked ? !leftOpen : !root.classList.contains('dr-open');
      panelB.setAttribute('aria-expanded', String(L.right));
      panelB.setAttribute('aria-label', L.right ? '收起面板' : '打开面板');
      right.inert = !L.right;
      scrim2.classList.toggle('on', (m === 'phone' || m === 'narrow') && L.right);
      if (L.right) { badge.hidden = true; if (tab === 'files') ensureFiles(); }
      requestAnimationFrame(moveInk);
    }
    new MutationObserver(function () {
      if (L.mode === 'narrow' || L.mode === 'phone') side.inert = !root.classList.contains('dr-open');
    }).observe(root, { attributes: true, attributeFilter: ['class'] });
    function toggleLeft(v) {
      if (L.mode === 'wide') {
        L.left = v === undefined ? !L.left : !!v;
        store.set('left', L.left ? '1' : null);
      } else if (L.mode === 'mid') {
        L.leftMid = v === undefined ? !L.leftMid : !!v;
        if (L.leftMid && L.right) L.right = false;
      } else {
        var b = $('.xc-list-b'); if (b && !b.hidden) b.click();
        return;
      }
      layout();
    }
    function toggleRight(v) {
      L.right = v === undefined ? !L.right : !!v;
      if (L.right && L.mode === 'mid' && L.leftMid) L.leftMid = false;
      if (L.mode === 'wide') store.set('right', L.right ? null : '0');
      layout();
    }
    var relayout = function () { layout(true); };
    Object.keys(MQ).forEach(function (k) { var q = MQ[k]; (q.addEventListener ? q.addEventListener('change', relayout) : q.addListener(relayout)); });
    if (histB) histB.addEventListener('click', function () { toggleLeft(); });
    $('.tq-fold').addEventListener('click', function () {
      if (L.mode === 'narrow' || L.mode === 'phone') { var b = $('.xc-list-b'); if (root.classList.contains('dr-open') && b) b.click(); }
      else toggleLeft(false);
    });
    side.addEventListener('click', function (e) {
      if (L.mode === 'mid' && L.leftMid && e.target.closest && e.target.closest('.xc-si, .xc-dr-new')) setTimeout(function () { toggleLeft(false); }, 40);
    });
    document.addEventListener('pointerdown', function (e) {
      if (L.mode === 'mid' && L.leftMid && !side.contains(e.target) && !(histB && histB.contains(e.target))) toggleLeft(false);
    }, true);
    var bridgeCmd = $('.tq-bridge-cmd');
    if (bridgeCmd) bridgeCmd.addEventListener('click', function () { var c = chat(); if (c && c.tqPal) c.tqPal(); });
    $('.tq-cmd-b').addEventListener('click', function () { var c = chat(); if (c && c.tqPal) c.tqPal(); });
    panelB.addEventListener('click', function () { L.touched = true; toggleRight(); });
    $('.tq-r-x').addEventListener('click', function () { L.touched = true; toggleRight(false); });
    scrim2.addEventListener('click', function () { toggleRight(false); });

    var rs = 0;
    addEventListener('resize', function () {
      var curDpr = Math.min(COARSE ? 1.25 : 2, window.devicePixelRatio || 1);
      if (innerWidth === W && innerHeight <= H && curDpr === DPR) return;
      clearTimeout(rs);
      rs = setTimeout(function () {
        var nextDpr = Math.min(COARSE ? 1.25 : 2, window.devicePixelRatio || 1);
        if (innerWidth !== W || innerHeight > H || nextDpr !== DPR) { size(); if (REDUCE) drawStars(performance.now()); }
        if (L.right) moveInk();
      }, 120);
    });
    if (window.top === window && window.visualViewport && (/iP(hone|ad|od)/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1))) {
      (function () {
        var vv = window.visualViewport, restH = vv.height, closing = false, tap0 = null;
        document.addEventListener('touchstart', function (e) { var t = e.touches[0]; tap0 = e.touches.length === 1 ? [t.clientX, t.clientY] : null; }, { capture: true, passive: true });
        document.addEventListener('touchmove', function (e) { var t = e.touches[0]; if (tap0 && t && (Math.abs(t.clientX - tap0[0]) > 10 || Math.abs(t.clientY - tap0[1]) > 10)) tap0 = null; }, { capture: true, passive: true });
        document.addEventListener('touchend', function (e) {
          var pt = tap0; tap0 = null;
          if (!pt || e.touches.length) return;
          var t = e.target, el = t && t.tagName === 'TEXTAREA' ? t : (t && t.closest && !t.closest('button,a,select,input,label,[role=button]') && t.closest('.tq-entry,.tq-box') ? say : null);
          if (!el || el.disabled || el.readOnly || el === document.activeElement) return;
          e.preventDefault();
          var pf = el.style.transform; el.style.transform = 'translateY(-8000px)'; el.focus({ preventScroll: true });
          setTimeout(function () { if (pf) el.style.transform = pf; else el.style.removeProperty('transform'); }, 0);
          try { var n = el.value.length; el.setSelectionRange(n, n); } catch (err) {}
        }, { capture: true, passive: false });
        function syncVV() {
          if (Math.abs((vv.scale || 1) - 1) > 0.01) return;
          if (closing && vv.height < restH - 2) return;
          if (!document.activeElement || !/^(TEXTAREA|INPUT)$/.test(document.activeElement.tagName)) restH = Math.max(restH, vv.height);
          var up = vv.height < restH - 60;
          html.classList.toggle('kb-up', up);
          document.body.style.height = up ? Math.round(vv.height) + 'px' : '';
        }
        document.addEventListener('focusin', function (e) { if (e.target && /^(TEXTAREA|INPUT)$/.test(e.target.tagName)) closing = false; }, true);
        document.addEventListener('focusout', function (e) {
          if (!e.target || !/^(TEXTAREA|INPUT)$/.test(e.target.tagName)) return;
          closing = true; html.classList.remove('kb-up'); document.body.style.height = '';
        }, true);
        vv.addEventListener('resize', syncVV);
        addEventListener('orientationchange', function () { closing = false; restH = vv.height; syncVV(); });
      })();
    }

    var dock = $('.tq-dock'), kbW = 0, kbH = 0, kbGap = 0, kbSet = false;
    function kbBody() { return frame.hasAttribute('data-start') ? null : $('.tq-mid > .xc-body'); }
    function gapOf(b) { return Math.max(0, b.scrollHeight - b.scrollTop - b.clientHeight); }
    function keepGap(b) { b.scrollTop = b.scrollHeight - b.clientHeight - kbGap; }
    function kbMark() { var b = kbBody(); kbW = frame.clientWidth; kbH = frame.clientHeight; kbSet = true; if (b) kbGap = gapOf(b); }
    function onKbResize() {
      var w = frame.clientWidth, h_ = frame.clientHeight, b = kbBody();
      if (!kbSet || w !== kbW || h_ === kbH) { kbMark(); return; }
      kbW = w; kbH = h_; kbSet = true; kbAt = performance.now();
      if (b) keepGap(b);
    }
    if (window.ResizeObserver) new ResizeObserver(onKbResize).observe(frame); else addEventListener('resize', onKbResize);
    requestAnimationFrame(kbMark);
    ['pointerdown', 'focusin'].forEach(function (t) { document.addEventListener(t, function () { if (!html.classList.contains('kb-up')) kbMark(); }, true); });
    if (window.ResizeObserver) new ResizeObserver(function () {
      if (frame.clientHeight !== kbH || frame.clientWidth !== kbW) return;
      var b = kbBody(); if (b && kbGap <= 4) keepGap(b);
      kbMark();
    }).observe(dock);
    new MutationObserver(function () { requestAnimationFrame(kbMark); }).observe(frame, { attributes: true, attributeFilter: ['data-start', 'data-mode'] });
    document.addEventListener('scroll', function (e) { var b = kbBody(); if (b && e.target === b && performance.now() > kbAt + 100 && frame.clientHeight === kbH) kbGap = gapOf(b); }, true);

    (function () {
      var head = $('.tq-r-head'), y0 = 0, dy = 0, dragging = false, ts = 0;
      head.addEventListener('pointerdown', function (e) { if (L.mode !== 'phone' || e.target.closest('button')) return; dragging = true; y0 = e.clientY; dy = 0; ts = performance.now(); right.classList.add('tq-dragging'); try { head.setPointerCapture(e.pointerId); } catch (err) {} });
      head.addEventListener('pointermove', function (e) { if (!dragging) return; dy = Math.max(0, e.clientY - y0); right.style.setProperty('--drag', dy + 'px'); });
      function end() { if (!dragging) return; dragging = false; right.classList.remove('tq-dragging'); var fast = dy / Math.max(1, performance.now() - ts) > .6; right.style.removeProperty('--drag'); if (dy > 110 || (fast && dy > 30)) toggleRight(false); }
      head.addEventListener('pointerup', end); head.addEventListener('pointercancel', end);
    })();

    /* ================= 右翼观测面板标签（终端 · 文件 · 预览 · 计划） ================= */
    var tabs = $$('.tq-tab'), ink = $('.tq-tab-ink'), tab = 'term', filesLoaded = false, preloadingFiles = false;
    function moveInk() { var t = tabs.filter(function (x) { return x.dataset.tab === tab; })[0]; if (t && t.offsetWidth) ink.style.transform = 'translateX(' + (t.offsetLeft + t.offsetWidth / 2 - 9) + 'px)'; }
    function select(name, focus) {
      tab = name;
      tabs.forEach(function (t) { var on = t.dataset.tab === name; t.setAttribute('aria-selected', String(on)); t.tabIndex = on ? 0 : -1; if (on) { t.classList.remove('has'); if (focus) t.focus(); } });
      $$('.tq-pane').forEach(function (p) {
        var on = p.dataset.tab === name;
        if (on && p.hidden && !REDUCE) { p.classList.remove('tq-in'); void p.offsetWidth; p.classList.add('tq-in'); }
        p.hidden = !on;
      });
      if (name === 'files') ensureFiles(false);
      if (name === 'term') requestAnimationFrame(ccStickBottom);
      moveInk();
    }
    tabs.forEach(function (t) { t.addEventListener('click', function () { L.touched = true; select(t.dataset.tab); }); });
    $('.tq-tabs').addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      var vis = tabs.filter(function (t) { return !t.hidden; }), i = vis.map(function (t) { return t.dataset.tab; }).indexOf(tab), n = vis[(i + (e.key === 'ArrowRight' ? 1 : -1) + vis.length) % vis.length];
      select(n.dataset.tab, true); e.preventDefault();
    });
    function notify(name) {
      var t = tabs.filter(function (x) { return x.dataset.tab === name; })[0];
      if (t && !(L.right && tab === name)) t.classList.add('has');
      if (!L.right) badge.hidden = false;
    }
    function ensureFiles(quiet) {
      var s = state();
      if (filesLoaded || !s.authed || !s.enabled) return;
      if (!quiet && (!L.right || tab !== 'files')) return;
      filesLoaded = true;
      var c = chat();
      if (c && c.tqFiles) {
        preloadingFiles = !!quiet;
        try { c.tqFiles(); } finally { preloadingFiles = false; }
      }
    }
    document.addEventListener('tq:panel', function (e) {
      var d = e.detail || {};
      if (d.tab === 'files' && d.loading) filesLoaded = true;
      if (preloadingFiles) return;
      if (!L.right) toggleRight(true);
      if (d.tab) select(d.tab);
    });

    /* ================= 预览 ================= */
    var prevBox = $('.tq-prev'), prevUrl = '';
    function abs(p) { return p.charAt(0) === '/' ? p : WORK + '/' + p.replace(/^\.\//, ''); }
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

    /* ================= 3. 宇宙星表模型选择器 + Codex 桌面端风格思考强度控制台 ================= */
    var COSMOS_MODELS = {
      'deepseek-v4.1-flash': {
        name: 'DeepSeek V4.1 Flash',
        spec: 'PSR · 1M · 视觉',
        desc: '脉冲星双核推理 · 支持开关思考链与图文观测',
        efforts: ['off', 'low', 'high', 'max'],
        svg: '<svg viewBox="0 0 24 24" aria-hidden="true"><ellipse cx="12" cy="12" rx="9" ry="3.8" transform="rotate(-28 12 12)"/><path d="M5.5 5.5l3.2 3.2M15.3 15.3l3.2 3.2"/><circle cx="12" cy="12" r="2.3" fill="currentColor" stroke="none"/></svg>'
      },
      'glm-5.3': {
        name: 'GLM-5.3',
        spec: 'G2V · 1M · 视觉',
        desc: '主序恒星旗舰 · 代码工程、终端工具与长上下文稳健执行',
        efforts: ['low', 'high', 'max'],
        svg: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.2"/><circle cx="12" cy="12" r="8.2" stroke-dasharray="2.4 2.4"/><path d="M12 2.4v2.1M12 19.5v2.1M2.4 12h2.1M19.5 12h2.1"/></svg>'
      },
      'glm-5.3-flash': {
        name: 'GLM-5.3 Flash',
        spec: 'DA2 · 1M · 文本',
        desc: '白矮星高速跃迁 · 低延迟纯文本巡天与快速检索',
        efforts: ['low', 'high', 'max'],
        svg: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 17.5c3.5-1.2 7.2-4.2 10.6-8.4"/><path d="M6.5 19.5c3.2-1 6.3-3.2 9.2-6.4" opacity=".65"/><path d="M16.5 4.5l1.1 2.5 2.5 1.1-2.5 1.1-1.1 2.5-1.1-2.5-2.5-1.1 2.5-1.1z" fill="currentColor" stroke="none"/></svg>'
      },
      'kimi-k3.1-pro': {
        name: 'Kimi K3.1 Pro',
        spec: 'B0Ia · 1M · 视觉',
        desc: '蓝超巨星深空 · 百万级上下文精读与跨文件长链推演',
        efforts: ['low', 'high', 'max'],
        svg: '<svg viewBox="0 0 24 24" aria-hidden="true"><ellipse cx="12" cy="12" rx="8.8" ry="3.8" transform="rotate(32 12 12)"/><ellipse cx="12" cy="12" rx="8.8" ry="3.8" transform="rotate(-32 12 12)"/><circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none"/></svg>'
      }
    };
    var EFF_META = {
      off: { label: '关', sub: '0 星等', desc: '跳过推理星链，瞬时直出回复', ic: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="6.5" stroke-dasharray="2.5 2.5"/><path d="M7.5 16.5l9-9"/></svg>' },
      low: { label: '低', sub: 'I 星等', desc: '轻量单轨推演，兼顾响应速度', ic: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15.5 4.8a7.2 7.2 0 1 0 3.7 13.3A6.2 6.2 0 0 1 15.5 4.8z"/></svg>' },
      high: { label: '高', sub: 'II 星等', def: true, desc: '多步星链推演，适合代码修改与调试', ic: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="7.5"/><path d="M12 7l1.4 3.6L17 12l-3.6 1.4L12 17l-1.4-3.6L7 12l3.6-1.4z" fill="currentColor" stroke="none"/></svg>' },
      max: { label: '最高', sub: 'III 星等', desc: '全天球深度穷举，攻坚复杂架构与逆向', ic: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.2"/><ellipse cx="12" cy="12" rx="8.2" ry="3.2" transform="rotate(-30 12 12)"/><path d="M12 6.2l1.5 4.3 4.3 1.5-4.3 1.5L12 17.8l-1.5-4.3L6.2 12l4.3-1.5z" fill="currentColor" stroke="none"/></svg>' }
    };
    var CHECK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.2 4.2L19 7"/></svg>';
    var CHEV_DOWN = '<svg class="tq-mdl-caret" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 10l5 5 5-5" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/></svg>';

    var mdlBtn = $('.tq-instruments .xc-mdl'), pickEl = $('#xin-model-picker'), effBtn = $('#tq-eff'), effStars = $('.tq-eff-stars', effBtn), effLbl = $('.tq-eff-lbl', effBtn);
    var epop = h('div', 'tq-pop tq-eff-pop'); epop.id = 'tq-eff-pop'; epop.hidden = true; root.appendChild(epop);
    var enhancingPick = false, mdlMo = null, pickMo = null, msgsMo = null;
    function setText(el, v) { v = String(v == null ? '' : v); if (el && el.textContent !== v) el.textContent = v; }

    function curModelId() { var s = state(), m = s && s.hModel || 'deepseek-v4.1-flash'; return COSMOS_MODELS[m] ? m : 'deepseek-v4.1-flash'; }
    function curModelInfo() { return COSMOS_MODELS[curModelId()]; }
    function curEffId() {
      var s = state(), info = curModelInfo(), raw = s && s.effort || 'high';
      return info.efforts.indexOf(raw) >= 0 ? raw : 'high';
    }
    function effGaugeSvg(eff, total) {
      var rank = eff === 'off' ? 0 : eff === 'low' ? 1 : eff === 'high' ? 2 : 3;
      return '<svg viewBox="0 0 32 32" aria-hidden="true">' +
        '<circle cx="16" cy="16" r="12.5" stroke-opacity=".22"/>' +
        (rank >= 1 ? '<path d="M16 3.5A12.5 12.5 0 0 1 28.5 16" stroke-width="1.8"/>' : '') +
        (rank >= 2 ? '<path d="M28.5 16A12.5 12.5 0 0 1 7.2 24.8" stroke-width="1.8"/>' : '') +
        (rank >= 3 ? '<circle cx="16" cy="16" r="12.5" stroke-width="1.8"/>' : '') +
        '<circle cx="16" cy="16" r="7.5" stroke-dasharray="2 2" stroke-opacity="' + (rank >= 2 ? '.65' : '.25') + '"/>' +
        (rank === 0 ? '<circle cx="16" cy="16" r="2.2" stroke-opacity=".45"/>' : '<path d="M16 10.6l1.5 3.9 3.9 1.5-3.9 1.5-1.5 3.9-1.5-3.9-3.9-1.5 3.9-1.5z" fill="currentColor" stroke="none"/>') +
        '</svg>';
    }
    function syncEffPill() {
      if (!effBtn) return;
      var info = curModelInfo(), lv = info.efforts.filter(function (x) { return x !== 'off'; }), cur = curEffId(), k = lv.indexOf(cur) + 1;
      if (effStars.querySelectorAll('b').length !== lv.length) {
        effStars.innerHTML = '';
        lv.forEach(function () { effStars.appendChild(document.createElement('b')); });
      }
      $$('b', effStars).forEach(function (b, i) { b.classList.toggle('on', i < k); });
      var meta = EFF_META[cur] || EFF_META.high;
      setText(effLbl, meta.label);
      var al = '思考强度：' + meta.label;
      if (effBtn.getAttribute('aria-label') !== al) effBtn.setAttribute('aria-label', al);
    }
    function decorateModelBtn() {
      if (!mdlBtn || enhancingPick) return;
      enhancingPick = true;
      try {
        var info = curModelInfo(), sp = mdlBtn.querySelector(':scope > span');
        if (sp && (!sp.querySelector('.tq-mdl-orb') || sp.dataset.mid !== curModelId())) {
          sp.textContent = '';
          sp.dataset.mid = curModelId();
          var orb = h('i', 'tq-mdl-orb'); orb.setAttribute('aria-hidden', 'true'); orb.innerHTML = info.svg;
          var txt = h('span', 'tq-mdl-txt', info.name);
          sp.appendChild(orb); sp.appendChild(txt);
        }
        if (!mdlBtn.querySelector('.tq-mdl-caret')) mdlBtn.insertAdjacentHTML('beforeend', CHEV_DOWN);
        syncEffPill();
        if (!epop.hidden) buildEffMenu();
        syncCcWelcome();
      } finally {
        if (mdlMo) mdlMo.takeRecords();
        enhancingPick = false;
      }
    }
    function decorateModelPicker() {
      if (!pickEl || pickEl.hidden || enhancingPick) return;
      enhancingPick = true;
      try {
        var hb = pickEl.querySelector('.xc-pk-heading b');
        if (hb && !hb.querySelector('.tq-pk-sub')) {
          hb.textContent = '天体模型星表';
          hb.appendChild(h('span', 'tq-pk-sub', 'STAR CATALOG'));
        }
        $$('.xc-pk-o[data-v]', pickEl).forEach(function (btn) {
          if (btn.querySelector('.tq-mdl-info')) return;
          var id = btn.dataset.v, m = COSMOS_MODELS[id];
          if (!m) return;
          var chk = btn.querySelector(':scope > svg');
          btn.textContent = '';
          var ic = h('span', 'tq-mdl-badge-ic'); ic.setAttribute('aria-hidden', 'true'); ic.innerHTML = m.svg;
          var info = h('span', 'tq-mdl-info'), r1 = h('span', 'tq-mdl-row1');
          r1.appendChild(h('span', 'tq-mdl-nm', m.name));
          r1.appendChild(h('span', 'tq-mdl-spec', m.spec));
          info.appendChild(r1);
          info.appendChild(h('span', 'tq-mdl-row2', m.desc));
          btn.appendChild(ic); btn.appendChild(info);
          if (chk) btn.appendChild(chk);
        });
        syncEffPill();
        fitPickUp();
      } finally {
        if (pickMo) pickMo.takeRecords();
        enhancingPick = false;
      }
    }
    // 天启的星表面板始终从输入区上方弹出（workbench.css），chat.js 的 fitPick 在空状态输入区居中时按下方空间算高度，
    // 这里按上方到顶栏的实际空间重算，与 chat.js 一样封顶 360px；值不变时不写，避免触发观察者循环
    function fitPickUp() {
      var foot = pickEl.offsetParent, bar = $('.tq-topbar');
      if (!foot || !bar) return;
      var above = foot.getBoundingClientRect().top - bar.getBoundingClientRect().bottom - 18;
      var v = Math.min(360, Math.max(96, Math.floor(above))) + 'px';
      if (pickEl.style.maxHeight !== v) pickEl.style.maxHeight = v;
    }
    if (mdlBtn) { mdlMo = new MutationObserver(decorateModelBtn); mdlMo.observe(mdlBtn, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-label'] }); }
    if (pickEl) { pickMo = new MutationObserver(decorateModelPicker); pickMo.observe(pickEl, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'style'] }); }

    function applyEffort(lv) {
      var info = curModelInfo();
      if (info.efforts.indexOf(lv) < 0) return;
      var s = state();
      if (s) s.effort = lv;
      store.set('effort', lv);
      // 若模型面板已渲染出档位按钮，同步其内部状态；否则同步更新按钮读屏文案与星等胶囊
      var pickBtn = pickEl && !pickEl.hidden ? pickEl.querySelector('.xc-eff-d[data-v="' + lv + '"]') : null;
      if (pickBtn) pickBtn.click();
      else if (mdlBtn) {
        var meta = EFF_META[lv] || EFF_META.high;
        mdlBtn.setAttribute('aria-label', '模型和思考强度：' + info.name + ' ' + meta.label);
        var em = mdlBtn.querySelector('.xc-em');
        if (em) {
          var nonOff = info.efforts.filter(function (x) { return x !== 'off'; }), idx = nonOff.indexOf(lv) + 1;
          $$('b', em).forEach(function (b, i) { b.classList.toggle('on', i < idx); });
        }
      }
      syncEffPill();
      syncCcWelcome();
      sparkFrom(effBtn, PAL.trail, 6);
    }
    function buildEffMenu() {
      var info = curModelInfo(), cur = curEffId();
      epop.setAttribute('role', 'menu');
      epop.setAttribute('aria-label', '思考强度');
      epop.innerHTML =
        '<div class="tq-eff-head">' +
          '<div class="tq-eff-htxt"><b>思考强度 · 星等算力</b><small>' + esc(info.name) + ' · ' + info.efforts.length + ' 档可调</small></div>' +
          '<span class="tq-eff-gauge">' + effGaugeSvg(cur, info.efforts.length) + '</span>' +
        '</div>' +
        info.efforts.map(function (lv) {
          var m = EFF_META[lv] || EFF_META.high, on = lv === cur;
          return '<button class="tq-eff-item" type="button" role="menuitemradio" aria-checked="' + on + '" data-eff="' + lv + '">' +
            '<span class="tq-eff-ic">' + m.ic + '</span>' +
            '<span class="tq-eff-main">' +
              '<span class="tq-eff-top"><span>' + m.label + '</span><span class="tq-eff-subtag">' + m.sub + '</span>' + (m.def ? '<span class="tq-eff-def">默认</span>' : '') + '</span>' +
              '<span class="tq-eff-desc">' + m.desc + '</span>' +
            '</span>' +
            '<svg class="tq-eff-chk" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.2 4.2L19 7"/></svg>' +
          '</button>';
        }).join('');
    }
    function placeOver(btn, el) {
      var b = btn.getBoundingClientRect(), w = el.offsetWidth, hh = el.offsetHeight;
      var x = Math.max(12, Math.min(innerWidth - w - 12, b.left)), y = b.top - hh - 8;
      if (y < 12) y = Math.max(12, Math.min(innerHeight - hh - 12, b.bottom + 8));
      el.style.left = x + 'px'; el.style.top = y + 'px';
    }
    function focusEff() { var f = $('.tq-eff-item[aria-checked="true"]', epop) || $('.tq-eff-item', epop); if (f) f.focus(); }
    function openEff() {
      closePop(false); closeWork(false);
      if (pickEl && !pickEl.hidden && mdlBtn) mdlBtn.click();
      buildEffMenu(); epop.hidden = false; placeOver(effBtn, epop);
      effBtn.setAttribute('aria-expanded', 'true');
      if (!REDUCE) { epop.classList.remove('in'); void epop.offsetWidth; epop.classList.add('in'); }
      focusEff();
    }
    function closeEff(backFocus) {
      if (epop.hidden) return false;
      epop.hidden = true;
      effBtn.setAttribute('aria-expanded', 'false');
      if (backFocus && effBtn) effBtn.focus();
      return true;
    }
    if (effBtn) effBtn.addEventListener('click', function () { if (epop.hidden) openEff(); else closeEff(true); });
    epop.addEventListener('click', function (e) {
      var b = e.target.closest('[data-eff]'); if (!b) return;
      applyEffort(b.dataset.eff);
      closeEff(true);
    });
    epop.addEventListener('keydown', function (e) {
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].indexOf(e.key) < 0) return;
      var o = $$('.tq-eff-item', epop); if (!o.length) return;
      var i = o.indexOf(document.activeElement), n = e.key === 'Home' ? 0 : e.key === 'End' ? o.length - 1 : (i + (e.key === 'ArrowDown' ? 1 : -1) + o.length) % o.length;
      o[n].focus(); e.preventDefault();
    });
    document.addEventListener('pointerdown', function (e) { if (!epop.hidden && !epop.contains(e.target) && !(effBtn && effBtn.contains(e.target))) closeEff(false); }, true);
    addEventListener('resize', function () { if (!epop.hidden && effBtn) placeOver(effBtn, epop); });

    /* ================= 4. Claude Code 工具调用规范化与 Diff 解析器（供思考链与终端共用） ================= */
    function ccSpec(ev) {
      var n = String(ev && ev.name || ''), raw = String(ev && ev.detail || ''), d = bareCmd(raw), m;
      if (n === 'Bash') {
        if ((m = /^\s*xin\s+browser\s+([a-z]+)\s*([\s\S]*)$/.exec(d))) {
          var sub = m[1], arg = m[2].replace(/^['"]|['"]$/g, '').trim();
          return { kind: 'web', verb: sub === 'open' ? 'Fetch' : 'Browser', arg: arg || sub };
        }
        if (/^\s*xin(?:\s|$)/.test(d)) return null;
        return { kind: 'cmd', verb: 'Bash', arg: d };
      }
      if (/^(?:Edit|Write|MultiEdit|NotebookEdit)$/.test(n)) {
        var files = raw.split('\n').filter(Boolean), k0 = (/^(add|create|delete|update)\s/i.exec(files[0] || '') || [])[1];
        var v = n === 'Write' || /^(add|create)$/i.test(k0 || '') ? 'Write' : /^delete$/i.test(k0 || '') ? 'Delete' : 'Update';
        var paths = files.map(function (l) { return shortPath(l.replace(/^(?:add|update|delete|create)\s+/i, '')); }).join(', ');
        return { kind: 'edit', verb: v, arg: paths || shortPath(raw) };
      }
      if (n === 'Read') return { kind: 'read', verb: 'Read', arg: shortPath(raw) };
      if (/^(?:Grep|Glob|Search)$/.test(n)) return { kind: 'search', verb: 'Search', arg: raw };
      if (n === 'LS') return { kind: 'read', verb: 'List', arg: shortPath(raw || '.') };
      if (n === 'WebSearch') return { kind: 'search', verb: 'WebSearch', arg: raw };
      if (n === 'WebFetch') return { kind: 'web', verb: 'Fetch', arg: raw };
      if (n === 'MCP') return { kind: 'mcp', verb: 'MCP', arg: raw };
      var p = '';
      try { var o = JSON.parse(raw); p = o && (o.file_path || o.path || o.file || o.command || o.pattern || o.query || o.url) || ''; } catch (e) {}
      if (/^(?:read|view)/i.test(n)) return { kind: 'read', verb: 'Read', arg: shortPath(p || d) };
      if (/^(?:edit|patch|replace|str_replace)/i.test(n)) return { kind: 'edit', verb: 'Update', arg: shortPath(p || d) };
      if (/^(?:write|create)/i.test(n)) return { kind: 'edit', verb: 'Write', arg: shortPath(p || d) };
      return { kind: 'tool', verb: n || 'Tool', arg: p ? String(p) : d };
    }
    function parseDiffBlocks(text, fallbackPath) {
      var files = [], cur = null, on = 1, nn = 1;
      var lines = String(text || '').replace(/\r/g, '').replace(/\s+$/, '').split('\n');
      for (var i = 0; i < lines.length; i++) {
        var l = lines[i], m, hm;
        if ((m = /^--- (add|update|delete|create) (.+)$/.exec(l))) {
          cur = { kind: m[1], path: m[2].trim(), lines: [], add: 0, del: 0 };
          files.push(cur); on = nn = 1; continue;
        }
        if (/^diff --git a\/(.+?) b\/(.+)$/.test(l)) {
          var dm = /^diff --git a\/(.+?) b\/(.+)$/.exec(l);
          cur = { kind: 'update', path: dm[2].trim(), lines: [], add: 0, del: 0 };
          files.push(cur); on = nn = 1; continue;
        }
        if (/^(?:index [0-9a-f]+|\-\-\- a\/|\+\+\+ b\/)/.test(l)) {
          if (/^\+\+\+ b\/(.+)$/.test(l) && !cur) {
            cur = { kind: 'update', path: RegExp.$1.trim(), lines: [], add: 0, del: 0 };
            files.push(cur);
          }
          continue;
        }
        if (/^@@/.test(l)) {
          if (!cur) { cur = { kind: 'update', path: fallbackPath || 'file', lines: [], add: 0, del: 0 }; files.push(cur); }
          if ((hm = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(l))) { on = +hm[1]; nn = +hm[2]; }
          cur.lines.push({ k: 'hunk', s: l, n: '' });
          continue;
        }
        if (!cur) continue;
        var k = /^\+/.test(l) ? 'add' : /^-/.test(l) ? 'del' : (cur.kind === 'add' || cur.kind === 'create') ? 'add' : 'ctx';
        if (k === 'add') cur.add++; else if (k === 'del') cur.del++;
        cur.lines.push({
          k: k,
          s: k === 'ctx' ? l.replace(/^ /, '') : l.replace(/^[+-]/, ''),
          n: k === 'del' ? on++ : k === 'add' ? nn++ : (on++, nn++)
        });
      }
      return files.filter(function (f) { return f.lines.length > 0; });
    }
    var KW_RE = /^(?:if|else|for|while|do|switch|case|default|break|continue|return|struct|typedef|static|const|volatile|extern|void|char|short|int|long|float|double|unsigned|bool|true|false|NULL|function|var|let|new|class|import|from|export|def|self|None|True|False|async|await)$/;
    function hlDiffCode(src) {
      var re = /(\/\/.*$|\/\*.*?\*\/|#\s*[A-Za-z_]\w*)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|(\b0[xX][0-9a-fA-F]+[uUlL]*\b|\b\d+(?:\.\d+)?\b)|([A-Za-z_]\w*)/g;
      var out = '', last = 0, m;
      while ((m = re.exec(src))) {
        out += esc(src.slice(last, m.index)); last = re.lastIndex;
        if (m[1]) out += '<span style="opacity:.68">' + esc(m[0]) + '</span>';
        else if (m[2]) out += '<span style="color:var(--star)">' + esc(m[0]) + '</span>';
        else if (m[3]) out += '<span style="color:var(--plan)">' + esc(m[0]) + '</span>';
        else if (KW_RE.test(m[4])) out += '<span style="font-weight:600">' + esc(m[0]) + '</span>';
        else out += esc(m[0]);
      }
      return out + esc(src.slice(last));
    }
    function extractChainSteps(evs) {
      var steps = [], byId = {};
      (evs || []).forEach(function (ev) {
        if (!ev) return;
        if (ev.t === 'think' && ev.text) {
          var tx = String(ev.text).trim();
          if (!tx || (steps.length && steps[steps.length - 1].kind === 'think' && steps[steps.length - 1].text === tx)) return;
          steps.push({ kind: 'think', text: tx });
          return;
        }
        if (ev.t === 'tool' || ev.t === 'tool_end') {
          var sp = ccSpec(ev);
          if (!sp) return;
          var item = ev.id != null ? byId[ev.id] : null;
          if (!item) {
            item = { kind: 'tool', id: ev.id, verb: sp.verb, arg: sp.arg, state: ev.t === 'tool_end' ? (ev.ok === false ? 'bad' : 'ok') : 'live', sub: '' };
            if (ev.id != null) byId[ev.id] = item;
            steps.push(item);
          }
          if (ev.t === 'tool_end') {
            item.state = ev.ok === false ? 'bad' : 'ok';
            var diffs = sp.kind === 'edit' || /^---\s+(?:add|update|delete|create)\s|^@@\s/m.test(ev.out || '') ? parseDiffBlocks(ev.out, sp.arg) : [];
            if (diffs.length) {
              var add = 0, del = 0;
              diffs.forEach(function (f) { add += f.add; del += f.del; });
              item.sub = 'Updated ' + shortPath(diffs[0].path) + ' (+' + add + ' -' + del + ')';
            } else if (ev.out) {
              var first = String(ev.out).trim().split('\n')[0] || '';
              if (first) item.sub = first.slice(0, 96);
            }
          }
        }
      });
      return steps;
    }

    /* ================= 5. 实时思考星链（.tq-chain，流式步骤呈现） ================= */
    var CHAIN_STAR = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.2l2.3 7.5 7.5 2.3-7.5 2.3L12 21.8l-2.3-7.5-7.5-2.3 7.5-2.3z"/></svg>';
    var CHAIN_CHEV = '<svg class="tq-chain-chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 10l5 5 5-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    var chains = {}, liveSeenRuns = {}, syncingChain = false;

    function fmtSec(ms) {
      var s = Math.max(0, ms / 1000);
      return s < 10 ? s.toFixed(1).replace(/\.0$/, '') + 's' : Math.round(s) + 's';
    }
    function ensureChainEl(run, isLive) {
      var rec = chains[run];
      if (!rec || !rec.el) {
        var el = h('section', 'tq-chain');
        el.dataset.chainRun = run;
        var openInit = isLive || !!liveSeenRuns[run];
        el.dataset.open = openInit ? 'true' : 'false';
        el.innerHTML =
          '<div class="tq-chain-bar">' +
            '<button type="button" class="tq-chain-tog" aria-expanded="' + openInit + '">' +
              '<i class="tq-chain-star" aria-hidden="true">' + CHAIN_STAR + '</i>' +
              '<span class="tq-chain-title"></span>' +
              '<span class="tq-chain-meta"></span>' +
              CHAIN_CHEV +
            '</button>' +
            '<button type="button" class="tq-chain-term" title="在右侧 Claude Code 终端查看完整执行记录">终端 ❯</button>' +
          '</div>' +
          '<div class="tq-chain-body"><ol class="tq-chain-list"></ol></div>';
        rec = chains[run] = { el: el, sig: '', userToggled: false };
        var tog = $('.tq-chain-tog', el);
        tog.addEventListener('click', function () {
          rec.userToggled = true;
          var next = el.dataset.open !== 'true';
          el.dataset.open = String(next);
          tog.setAttribute('aria-expanded', String(next));
        });
        $('.tq-chain-term', el).addEventListener('click', function () { focusCcRun(run); });
      }
      return rec;
    }
    function syncChains() {
      if (syncingChain) return;
      syncingChain = true;
      try {
        var s = state(), activeRun = s && s.run || '';
        var typ = msgs.querySelector(':scope > .xc-typing');
        if (typ) typ.classList.toggle('tq-waking', !!(s && s.sending));
        if (activeRun) liveSeenRuns[activeRun] = true;

        var runIds = Object.keys(s && s.runEv || {});
        if (activeRun && runIds.indexOf(activeRun) < 0) runIds.push(activeRun);

        // 清理已不在当前会话中的旧星链
        Object.keys(chains).forEach(function (r) {
          if (runIds.indexOf(r) < 0) {
            if (chains[r].el && chains[r].el.parentNode) chains[r].el.remove();
            delete chains[r];
          }
        });

        runIds.forEach(function (run) {
          var isLive = run === activeRun && !(s && s.sending);
          var evs = (s && s.runEv && s.runEv[run]) || [];
          var steps = extractChainSteps(evs);
          if (!isLive && !steps.length) {
            if (chains[run]) {
              if (chains[run].el && chains[run].el.parentNode) chains[run].el.remove();
              delete chains[run];
            }
            return;
          }
          var rec = ensureChainEl(run, isLive), el = rec.el;
          el.classList.toggle('live', isLive);
          if (isLive && !rec.userToggled) {
            el.dataset.open = 'true';
            $('.tq-chain-tog', el).setAttribute('aria-expanded', 'true');
          }

          var renderSteps = steps.slice();
          if (isLive && !renderSteps.length) {
            var hint = (s && s.note && Date.now() - s.note.at < 6000 && s.note.text) || (s && s.thinkS) || '正在建立推理星链与解析上下文…';
            renderSteps.push({ kind: 'think', text: hint, livePlaceholder: true });
          }

          var hostAi = msgs.querySelector('.xc-ai[data-run="' + String(run).replace(/["\\]/g, '') + '"]:not(.xc-typing):not(.xc-tbw)');
          if (hostAi) {
            el.classList.remove('tq-chain-float');
            var beforeNode = hostAi.querySelector(':scope > .xc-bub') || hostAi.querySelector(':scope > .tq-plan-card') || hostAi.querySelector(':scope > .xc-acts');
            if (el.parentNode !== hostAi || el.nextElementSibling !== beforeNode) hostAi.insertBefore(el, beforeNode);
          } else if (isLive) {
            el.classList.add('tq-chain-float');
            var anchor = typ || msgs.querySelector(':scope > .xc-tbw.dock');
            if (anchor) { if (el.parentNode !== msgs || el.nextElementSibling !== anchor) msgs.insertBefore(el, anchor); }
            else if (el.parentNode !== msgs) msgs.appendChild(el);
          } else if (el.parentNode) {
            el.remove();
            return;
          }

          var nThink = steps.filter(function (x) { return x.kind === 'think'; }).length;
          var nTool = steps.filter(function (x) { return x.kind === 'tool'; }).length;
          var meta = s && s.runMeta && s.runMeta[run] || {};
          var durStr = isLive ? fmtSec(Date.now() - (s.t0 || Date.now())) : (meta.ms != null ? fmtSec(meta.ms) : '');
          var parts = [];
          if (nThink) parts.push(nThink + ' 步推理');
          if (nTool) parts.push(nTool + ' 次工具');
          if (!parts.length && isLive) parts.push('连接星轨');
          if (durStr) parts.push(durStr);

          setText($('.tq-chain-title', el), isLive ? '思考星链 · 推演中' : '思考星链');
          setText($('.tq-chain-meta', el), parts.join(' · '));

          var sig = renderSteps.map(function (st) { return st.kind + ':' + (st.state || '') + ':' + (st.verb || '') + ':' + (st.arg || st.text || '') + ':' + (st.sub || ''); }).join('|') + '|' + isLive;
          if (rec.sig !== sig) {
            rec.sig = sig;
            var ol = $('.tq-chain-list', el), body = $('.tq-chain-body', el);
            ol.innerHTML = '';
            renderSteps.forEach(function (st, idx) {
              var li = h('li', 'tq-cstep ' + (st.kind === 'think' ? 'is-think' + (st.livePlaceholder || (isLive && idx === renderSteps.length - 1) ? ' is-live' : '') : 'is-tool is-' + (st.state || 'ok')));
              li.appendChild(h('i', 'tq-cstep-dot'));
              li.appendChild(h('span', 'tq-cstep-idx', (idx + 1 < 10 ? '0' : '') + (idx + 1)));
              var tx = h('span', 'tq-cstep-txt');
              if (st.kind === 'think') {
                tx.textContent = st.text;
              } else {
                var v = h('span', 'tq-cstep-tool-v', st.verb);
                var a = h('span', 'tq-cstep-tool-a', st.arg);
                tx.appendChild(v); tx.appendChild(document.createTextNode('(')); tx.appendChild(a); tx.appendChild(document.createTextNode(')'));
              }
              li.appendChild(tx);
              if (st.sub) li.appendChild(h('div', 'tq-cstep-sub', '⎿ ' + st.sub));
              ol.appendChild(li);
            });
            if (isLive && body) body.scrollTop = body.scrollHeight;
          }
        });
      } finally {
        if (msgsMo) msgsMo.takeRecords();
        syncingChain = false;
      }
    }

    /* ================= 6. 1:1 复刻 Claude Code CLI 终端（#tq-p-term 内的 .tq-cc） ================= */
    var CC_SPIN = ['·', '✢', '✳', '✶', '✻', '✽'];
    var CC_SEQ = [0, 1, 2, 3, 4, 5, 4, 3, 2, 1];
    var ccSpinIdx = 0;
    var TQ_ASTRO_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" stroke-dasharray="2.5 2"/><ellipse cx="12" cy="12" rx="9" ry="3.8" transform="rotate(-28 12 12)"/><path d="M12 5.2l1.6 5.2 5.2 1.6-5.2 1.6L12 18.8l-1.6-5.2-5.2-1.6 5.2-1.6z" fill="currentColor" stroke="none"/></svg>';

    var cc = h('div', 'tq-cc');
    cc.innerHTML =
      '<div class="cc-scr">' +
        '<div class="cc-welcome">' +
          '<span class="cc-w-legend">✦ 天启 · Tianqi CLI</span>' +
          '<div class="cc-w-left">' +
            '<div class="cc-w-greet">Welcome to 天启!</div>' +
            '<div class="cc-w-emblem">' +
              '<span class="cc-w-star" aria-hidden="true">' + TQ_ASTRO_SVG + '</span>' +
              '<div class="cc-w-meta"><span class="cc-w-mdl"></span><span class="cc-w-dir"></span></div>' +
            '</div>' +
          '</div>' +
          '<div class="cc-w-right">' +
            '<b>Tips for getting started</b>' +
            '<span>1. 对话推理与工具执行实时同步至此</span>' +
            '<span>2. 底部 ❯ 直接在工作区运行命令</span>' +
            '<span>3. 按 M 换星体模型 · E 调思考星等</span>' +
          '</div>' +
        '</div>' +
        '<div class="cc-feed" aria-live="polite"></div>' +
        '<div class="tq-cli-log" aria-live="polite"></div>' +
      '</div>' +
      '<div class="cc-live" hidden>' +
        '<i class="cc-spin" aria-hidden="true">✻</i>' +
        '<span class="cc-live-v">Thinking…</span>' +
        '<span class="cc-live-m"></span>' +
      '</div>' +
      '<div class="cc-keys" hidden>' +
        '<span><kbd>Enter</kbd> 运行工作区命令</span>' +
        '<span><kbd>Esc</kbd> 中断生成 / 关闭弹层</span>' +
        '<span><kbd>Ctrl+K</kbd> 搜索与命令面板</span>' +
        '<span><kbd>Ctrl+J</kbd> 展开 / 收起终端翼</span>' +
        '<span><kbd>M / E</kbd> 星体模型 / 思考强度</span>' +
        '<span><kbd>P / W</kbd> 会话权限 / 切换工作区</span>' +
      '</div>' +
      '<form class="tq-cli-form" id="tq-term-form">' +
        '<span class="tq-cli-ps" aria-hidden="true">❯</span>' +
        '<input aria-label="在工作区里运行命令" placeholder="在工作区里运行命令，最多 60 秒" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="go">' +
        '<button type="submit" class="tq-ib" aria-label="运行"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg></button>' +
      '</form>' +
      '<div class="cc-foot">' +
        '<button type="button" class="cc-perm-b" title="切换会话权限（P）"></button>' +
        '<div class="cc-foot-r">' +
          '<span class="cc-cwd">~/workspace</span>' +
          '<button type="button" class="cc-help-b" aria-expanded="false">? for shortcuts</button>' +
        '</div>' +
      '</div>';
    $('#tq-p-term').appendChild(cc);

    var ccScr = $('.cc-scr', cc), ccFeed = $('.cc-feed', cc), cliLog = $('.tq-cli-log', cc);
    var ccLive = $('.cc-live', cc), ccSpin = $('.cc-spin', cc), ccLiveV = $('.cc-live-v', cc), ccLiveM = $('.cc-live-m', cc);
    var ccKeys = $('.cc-keys', cc), ccPermB = $('.cc-perm-b', cc), ccCwd = $('.cc-cwd', cc), ccHelpB = $('.cc-help-b', cc);
    var ccWMdl = $('.cc-w-mdl', cc), ccWDir = $('.cc-w-dir', cc);
    var cliForm = $('#tq-term-form', cc), cliIn = $('input', cliForm), cliBtn = $('button', cliForm), cliBusy = false, cliCmdNow = '', cliT0 = 0;
    var ccStick = true, ccTurns = {};

    ccScr.addEventListener('scroll', function () {
      ccStick = ccScr.scrollHeight - ccScr.scrollTop - ccScr.clientHeight < 48;
    }, { passive: true });
    function ccStickBottom() { if (ccStick) ccScr.scrollTop = ccScr.scrollHeight; }

    ccHelpB.addEventListener('click', function () {
      var next = ccKeys.hidden;
      ccKeys.hidden = !next;
      ccHelpB.setAttribute('aria-expanded', String(next));
    });

    function syncCcWelcome() {
      var info = curModelInfo(), eff = EFF_META[curEffId()] || EFF_META.high;
      if (ccWMdl) ccWMdl.textContent = info.name + ' · 思考:' + eff.label;
      var hp = homePath(typeof curWork === 'function' ? curWork() : '');
      if (ccWDir) ccWDir.textContent = hp;
      if (ccCwd) ccCwd.textContent = hp;
    }
    function syncCcFoot() {
      if (!ccPermB || typeof cfg === 'undefined') return;
      ccPermB.className = 'cc-perm-b ' + (cfg.plan ? 'is-plan' : cfg.perm === 'danger-full-access' ? 'is-full' : cfg.perm === 'workspace-write' ? 'is-ws' : 'is-ro');
      ccPermB.textContent = cfg.plan
        ? '⏸ plan mode on (read-only)'
        : cfg.perm === 'danger-full-access'
          ? '⏵⏵ bypass permissions on'
          : cfg.perm === 'workspace-write'
            ? '⏵ accept edits on (workspace)'
            : '🔒 read-only mode';
      syncCcWelcome();
    }
    ccPermB.addEventListener('click', function () {
      if (cfg.plan) planBtn.click();
      else if (pop.hidden) openPop(); else closePop(true);
    });

    // 展开/收起长输出与长 Diff（+N lines 折叠交互）
    cc.addEventListener('click', function (e) {
      var m = e.target.closest('.cc-more');
      if (!m) return;
      var boxEl = m.closest('.cc-out-body');
      if (!boxEl) return;
      var expanded = m.dataset.exp === '1';
      if (m.dataset.full != null) {
        var pre = $('.cc-pre', boxEl);
        if (pre) pre.textContent = expanded ? m.dataset.short : m.dataset.full;
        m.dataset.exp = expanded ? '0' : '1';
        m.textContent = expanded ? '… +' + m.dataset.more + ' lines (click to expand)' : '▴ Collapse output';
      } else if (m.dataset.diffMore) {
        $$('.cc-dl[data-extra="1"]', boxEl).forEach(function (dl) { dl.hidden = expanded; });
        m.dataset.exp = expanded ? '0' : '1';
        m.textContent = expanded ? '… +' + m.dataset.diffMore + ' lines (click to expand)' : '▴ Collapse diff';
      }
    });

    function buildCcOutput(outStr, ok, spec) {
      var wrap = h('div', 'cc-out');
      wrap.appendChild(h('i', 'cc-elbow'));
      var body = h('div', 'cc-out-body');
      wrap.appendChild(body);

      var diffs = (spec.kind === 'edit' || /^---\s+(?:add|update|delete|create)\s|^@@\s/m.test(outStr || '')) ? parseDiffBlocks(outStr, spec.arg) : [];
      if (diffs.length) {
        diffs.forEach(function (f) {
          var dw = h('div', 'cc-diff-wrap');
          var sum = h('div', 'cc-diff-sum');
          var actWord = f.kind === 'add' || f.kind === 'create' ? 'Added' : f.kind === 'delete' ? 'Removed' : 'Updated';
          sum.innerHTML = actWord + ' <b>' + esc(shortPath(f.path)) + '</b> with <span class="cc-stat-add">' + f.add + ' addition' + (f.add === 1 ? '' : 's') + '</span> and <span class="cc-stat-del">' + f.del + ' removal' + (f.del === 1 ? '' : 's') + '</span>';
          dw.appendChild(sum);
          var df = h('div', 'cc-diff'), limit = 16, hiddenCount = 0;
          f.lines.forEach(function (ln, li) {
            if (ln.k === 'hunk' && li === 0) return;
            var dl = h('div', 'cc-dl ' + (ln.k === 'hunk' ? 'cc-hunk' : 'cc-' + ln.k));
            if (ln.k === 'hunk') {
              dl.textContent = ln.s || '⋯';
            } else {
              dl.appendChild(h('i', 'cc-ln', String(ln.n)));
              dl.appendChild(h('i', 'cc-sg', ln.k === 'add' ? '+' : ln.k === 'del' ? '-' : ' '));
              var code = h('span', 'cc-code');
              code.innerHTML = hlDiffCode(ln.s || ' ');
              dl.appendChild(code);
            }
            if (li >= limit) { dl.dataset.extra = '1'; dl.hidden = true; hiddenCount++; }
            df.appendChild(dl);
          });
          dw.appendChild(df);
          if (hiddenCount > 0) {
            var mb = h('button', 'cc-more', '… +' + hiddenCount + ' lines (click to expand)');
            mb.type = 'button'; mb.dataset.diffMore = String(hiddenCount); mb.dataset.exp = '0';
            dw.appendChild(mb);
          }
          body.appendChild(dw);
        });
        return wrap;
      }

      var raw = String(outStr || '').replace(/\s+$/, '');
      if (!raw) return null;
      var arr = raw.split('\n'), keep = 8;
      var shown = ok === false ? arr.slice(-keep) : arr.slice(0, keep);
      var pre = h('pre', 'cc-pre', shown.join('\n'));
      body.appendChild(pre);
      if (arr.length > keep) {
        var moreN = arr.length - keep;
        var moreBtn = h('button', 'cc-more', '… +' + moreN + ' lines (click to expand)');
        moreBtn.type = 'button';
        moreBtn.dataset.short = shown.join('\n');
        moreBtn.dataset.full = raw;
        moreBtn.dataset.more = String(moreN);
        moreBtn.dataset.exp = '0';
        body.appendChild(moreBtn);
      }
      return wrap;
    }

    function renderCcTurn(run, evs, meta, isLive) {
      var rec = ccTurns[run];
      if (!rec) {
        var el = h('div', 'cc-turn');
        el.dataset.run = run;
        ccFeed.appendChild(el);
        rec = ccTurns[run] = { el: el, sig: '' };
      }
      var sig = (meta.prompt || '') + '|' + isLive + '|' + (meta.ms || '') + '|' + (evs || []).map(function (e) {
        return e.t + ':' + (e.id || '') + ':' + (e.ok === false ? '0' : '1') + ':' + (e.name || '') + ':' + (e.detail || e.text || '').slice(0, 80) + ':' + (e.out ? e.out.length : 0);
      }).join(';');
      if (rec.sig === sig) return;
      rec.sig = sig;

      var el2 = rec.el;
      el2.innerHTML = '';
      if (meta.prompt) {
        var pr = h('div', 'cc-prompt');
        var ps = h('span', 'cc-ps', '❯ '); ps.setAttribute('aria-hidden', 'true');
        pr.appendChild(ps);
        pr.appendChild(h('span', 'cc-ptxt', meta.prompt));
        el2.appendChild(pr);
      }

      var toolRows = {}, skipIds = {};
      (evs || []).forEach(function (ev) {
        if (!ev) return;
        if (ev.t === 'think' && ev.text) {
          var tr = h('div', 'cc-row is-think');
          var tb = h('i', 'cc-b', '✻'); tb.setAttribute('aria-hidden', 'true');
          tr.appendChild(tb);
          tr.appendChild(h('div', 'cc-main', ev.text));
          el2.appendChild(tr);
          return;
        }
        if (ev.t === 'tool') {
          var sp = ccSpec(ev);
          if (!sp) { if (ev.id != null) skipIds[ev.id] = true; return; }
          var r = h('div', 'cc-row is-run');
          var b = h('i', 'cc-b'); b.setAttribute('aria-hidden', 'true');
          var m = h('div', 'cc-main');
          m.appendChild(h('span', 'cc-verb', sp.verb));
          m.appendChild(document.createTextNode('('));
          m.appendChild(h('span', 'cc-arg', sp.arg));
          m.appendChild(document.createTextNode(')'));
          r.appendChild(b); r.appendChild(m);
          r._spec = sp;
          el2.appendChild(r);
          if (ev.id != null) toolRows[ev.id] = r;
          return;
        }
        if (ev.t === 'tool_end') {
          if (ev.id != null && skipIds[ev.id]) return;
          var sp2 = ccSpec(ev);
          if (!sp2) return;
          var rowEl = ev.id != null ? toolRows[ev.id] : null;
          if (!rowEl) {
            rowEl = h('div', 'cc-row');
            var b2 = h('i', 'cc-b'); b2.setAttribute('aria-hidden', 'true');
            var m2 = h('div', 'cc-main');
            m2.appendChild(h('span', 'cc-verb', sp2.verb));
            m2.appendChild(document.createTextNode('('));
            m2.appendChild(h('span', 'cc-arg', sp2.arg));
            m2.appendChild(document.createTextNode(')'));
            rowEl.appendChild(b2); rowEl.appendChild(m2);
            el2.appendChild(rowEl);
          }
          rowEl.classList.remove('is-run');
          rowEl.classList.add(ev.ok === false ? 'is-bad' : 'is-ok');
          var outNode = buildCcOutput(ev.out, ev.ok, sp2);
          if (outNode) rowEl.appendChild(outNode);
          return;
        }
        if (ev.t === 'text' && ev.text) {
          var sr = h('div', 'cc-row is-say');
          var sb = h('i', 'cc-b'); sb.setAttribute('aria-hidden', 'true');
          var txt = String(ev.text).replace(/^#{1,6}\s+/gm, '').trim();
          sr.appendChild(sb);
          sr.appendChild(h('div', 'cc-main', txt.length > 600 ? txt.slice(0, 600) + '…' : txt));
          el2.appendChild(sr);
          return;
        }
        if (ev.t === 'err' && ev.text) {
          var er = h('div', 'cc-row is-bad');
          var eb = h('i', 'cc-b'); eb.setAttribute('aria-hidden', 'true');
          er.appendChild(eb);
          er.appendChild(h('div', 'cc-main', ev.text));
          el2.appendChild(er);
        }
      });

      if (!isLive && meta.ms != null && (evs || []).some(function (e) { return e.t === 'tool' || e.t === 'tool_end'; })) {
        var sumRow = h('div', 'cc-sum', '✻ Completed in ' + fmtSec(meta.ms));
        el2.appendChild(sumRow);
      }
      ccStickBottom();
    }

    function syncCcFeed() {
      var s = state(), activeRun = s && s.run || '';
      var metaMap = s && s.runMeta || {}, evMap = s && s.runEv || {};
      var keys = Object.keys(metaMap);
      Object.keys(evMap).forEach(function (k) { if (keys.indexOf(k) < 0) keys.push(k); });
      if (activeRun && keys.indexOf(activeRun) < 0) keys.push(activeRun);

      Object.keys(ccTurns).forEach(function (k) {
        if (keys.indexOf(k) < 0) {
          if (ccTurns[k].el && ccTurns[k].el.parentNode) ccTurns[k].el.remove();
          delete ccTurns[k];
        }
      });

      keys.forEach(function (run) {
        var evs = evMap[run] || [], meta = metaMap[run] || {};
        var hasCli = run === activeRun || !!liveSeenRuns[run] || evs.some(function (e) { return e && (e.t === 'tool' || e.t === 'tool_end' || e.t === 'think' || e.t === 'err'); });
        if (!hasCli || (!evs.length && !meta.prompt && run !== activeRun)) {
          if (ccTurns[run]) { if (ccTurns[run].el && ccTurns[run].el.parentNode) ccTurns[run].el.remove(); delete ccTurns[run]; }
          return;
        }
        renderCcTurn(run, evs, meta, run === activeRun);
      });

      var isBusy = !!(activeRun || (s && s.sending) || cliBusy);
      ccLive.hidden = !isBusy;
      if (isBusy) {
        if (!REDUCE) { ccSpinIdx = (ccSpinIdx + 1) % CC_SEQ.length; ccSpin.textContent = CC_SPIN[CC_SEQ[ccSpinIdx]]; }
        else ccSpin.textContent = '✻';
        if (cliBusy) {
          ccLiveV.textContent = 'Bash(' + cliCmdNow.slice(0, 42) + ')…';
          ccLiveM.textContent = '(' + fmtSec(Date.now() - cliT0) + ')';
        } else if (s && s.sending) {
          ccLiveV.textContent = s.waitSend ? 'Waking li2…' : 'Sending…';
          ccLiveM.textContent = '';
        } else {
          var vText = (s && s.doing === 'work' && s.act) ? s.act : (s && s.thinkS) || 'Thinking…';
          ccLiveV.textContent = vText;
          ccLiveM.textContent = '(esc to interrupt · ' + fmtSec(Date.now() - (s.t0 || Date.now())) + ')';
        }
      }
    }

    function focusCcRun(run) {
      L.touched = true;
      toggleRight(true);
      select('term');
      syncCcFeed();
      var target = run && ccTurns[run] && ccTurns[run].el;
      if (target) {
        target.scrollIntoView({ block: 'nearest' });
        target.classList.remove('cc-focus'); void target.offsetWidth; target.classList.add('cc-focus');
        clearTimeout(target._ft); target._ft = setTimeout(function () { target.classList.remove('cc-focus'); }, 1500);
      } else ccStickBottom();
    }

    // 拦截对话区里 [data-term] 点击，统一在右侧 Claude Code 终端打开并定位对应轮次（不弹小芯的像素终端窗口）
    msgs.addEventListener('click', function (e) {
      var a = e.target.closest && e.target.closest('[data-term]');
      if (!a || !msgs.contains(a)) return;
      e.stopImmediatePropagation(); e.preventDefault();
      var ctxStr = a.dataset.term || '';
      var run = ctxStr === 'live' ? (state().run || '') : ctxStr.indexOf('run:') === 0 ? ctxStr.slice(4) : '';
      focusCcRun(run);
    }, true);
    msgs.addEventListener('keydown', function (e) {
      var a = e.target;
      if ((e.key === 'Enter' || e.key === ' ') && a && a.dataset && a.dataset.term) {
        e.stopImmediatePropagation(); e.preventDefault();
        var ctxStr = a.dataset.term || '';
        var run = ctxStr === 'live' ? (state().run || '') : ctxStr.indexOf('run:') === 0 ? ctxStr.slice(4) : '';
        focusCcRun(run);
      }
    }, true);

    /* ================= 对话生命周期、空状态赤道星标与实时轮询同步 ================= */
    var title = $('.xc-conv-t'), lastTitle = title.textContent;
    new MutationObserver(function () {
      if (title.textContent === lastTitle) return; lastTitle = title.textContent;
      if (!REDUCE) { title.classList.remove('tq-swap'); void title.offsetWidth; title.classList.add('tq-swap'); }
    }).observe(title, { childList: true, characterData: true, subtree: true });

    function syncStart() {
      var empty = msgs.querySelector(':scope > .tq-empty');
      if (empty && !empty.querySelector('.tq-empty-coord')) {
        var coord = h('p', 'tq-empty-coord', 'RA 19h 24m · DEC +23° 26′ · DEEP SPACE OBSERVATORY');
        coord.setAttribute('aria-hidden', 'true');
        empty.appendChild(coord);
      }
      var start = msgs.children.length === 1 && !!empty;
      var was = frame.hasAttribute('data-start');
      frame.toggleAttribute('data-start', start);
      if (was && !start && dockFrom != null && !REDUCE) {
        var dy = dockFrom - dock.getBoundingClientRect().top;
        if (Math.abs(dy) > 2 && dock.animate) dock.animate([{ transform: 'translateY(' + dy + 'px)' }, { transform: 'none' }], { duration: 560, easing: 'cubic-bezier(.16,1,.3,1)' });
      }
      dockFrom = null;
    }
    msgsMo = new MutationObserver(function (list) {
      if (syncingChain) return;
      syncStart(); linkRefs(msgs); syncChains(); syncCcFeed();
      if (msgsMo) msgsMo.takeRecords();
      if (busy && list.some(function (m) { return m.addedNodes.length; })) notifyWork();
    });
    msgsMo.observe(msgs, { childList: true, subtree: true });
    syncStart();

    var seen = null;
    new MutationObserver(function () {
      var now = $$('.tq-side .xc-si-t').map(function (e) { return e.textContent; });
      if (seen && now.length) $$('.tq-side .xc-sli').forEach(function (li) { var t = li.querySelector('.xc-si-t'); if (t && seen.indexOf(t.textContent) < 0 && !REDUCE) li.classList.add('tq-new'); });
      if (now.length) seen = now;
      syncHistBadge();
    }).observe($('.xc-dr'), { childList: true, subtree: true });

    var busy = false, termNotified = false, workTm = 0;
    function notifyWork() { clearTimeout(workTm); workTm = setTimeout(function () { if (!L.right) badge.hidden = false; }, 400); }
    function runHasTools(s) { var ev = s && s.run && s.runEv && s.runEv[s.run]; return !!(ev && ev.some(function (e) { return e && (e.t === 'tool' || e.t === 'tool_end') && ccSpec(e); })); }
    function tick() {
      if (html.classList.contains('kb-anim')) return;
      var s = state(), now = !!(s && (s.run || s.sending));
      if (busy && !termNotified && runHasTools(s)) {
        termNotified = true;
        if (L.mode === 'wide' && L.right && !L.touched) select('term'); else notify('term');
      }
      if (now !== busy) {
        busy = now;
        orbit.on = busy && !REDUCE;
        if (busy) { orbit.d = 0; wake(); termNotified = false; L.touched = false; }
        else {
          var last = $$('.xc-ai:not(.xc-typing)', msgs).pop();
          if (last) { var r = last.getBoundingClientRect(); spawnMeteor({ big: true, x: Math.min(W * .8, r.right + 40), y: Math.max(40, r.top - 60) }); }
        }
        hook();
      }
      syncChains();
      syncCcFeed();
      syncHistBadge();
      if (now !== actsBusy && latest) planActs();
      var ok = !!(s.enabled && s.authed && !s.tqNoGw), warn = !!(s.enabled && s.authed && s.tqNoGw);
      li2Btn.classList.toggle('ok', ok); li2Btn.classList.toggle('warn', warn);
      li2Btn.title = ok ? 'li2 在线' : warn ? 'li2 的网关还没配好' : 'li2 还没连上';
      if (!filesLoaded && s.authed && s.enabled) ensureFiles(tab !== 'files');
    }
    setInterval(tick, 180);

    /* ================= 设置弹窗（外观 / 电脑） ================= */
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
    setBtn.addEventListener('click', function () { openSettings('look'); });
    li2Btn.addEventListener('click', function () { openSettings('pc'); });
    $('.tq-set-x').addEventListener('click', closeSettings);
    $('.tq-modal-bg').addEventListener('click', closeSettings);
    $$('.tq-set-tab', modal).forEach(function (b) { b.addEventListener('click', function () { showSec(b.dataset.sec); }); });
    secEl.addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      if (b.dataset.themeSet) {
        try { localStorage.setItem('lm.tq.theme', b.dataset.themeSet); } catch (err) {}
        window.postMessage({ type: 'theme' }, location.origin);
        setTimeout(function () { showSec('look'); var f = $('.tq-theme[aria-checked="true"]', modal); if (f) f.focus(); }, 0);
      } else if (b.dataset.sw === 'meteor') {
        meteorsOn = !meteorsOn; store.set('meteor', meteorsOn ? null : 'off'); b.setAttribute('aria-checked', String(meteorsOn)); if (meteorsOn) spawnMeteor();
      } else if (b.dataset.act === 'logout') {
        closeSettings(); var o = $('.xc-dr-out'); if (o) o.click();
      }
    });
    modal.addEventListener('keydown', function (e) {
      if (e.key !== 'Tab') return;
      var f = $$('button:not(:disabled)', modal).filter(function (x) { return x.offsetParent !== null; });
      if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) { f[f.length - 1].focus(); e.preventDefault(); }
      else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { f[0].focus(); e.preventDefault(); }
    });

    /* ================= 权限预设与计划模式 ================= */
    var PERMS = [
      ['read-only', '只读', '只读', '只看文件、跑只读命令，不改任何东西'],
      ['workspace-write', '工作区内修改', '工作区', '能改工作目录里的文件、运行命令'],
      ['danger-full-access', '完全权限', '完全', '还能改工作目录外的文件和 li2 的系统设置']
    ], RO = 'read-only', FULL = 'danger-full-access';
    function permOf(v) { return PERMS.filter(function (p) { return p[0] === v; })[0] || null; }
    function defPerm() { var v = store.get('perm'); return permOf(v) ? v : FULL; }
    var cfg = { perm: permOf(state().tqPerm) ? state().tqPerm : defPerm(), plan: false };
    var permBtn = $('#tq-perm'), planBtn = $('#tq-plan'), PH0 = say.getAttribute('placeholder') || '给天启发消息';
    function tqOpts() { return { perm: cfg.perm, plan: cfg.plan, work: fresh() && ws.pick ? ws.pick : undefined }; }
    function hook() { var c = chat(); if (c && c.tqOpts !== tqOpts) c.tqOpts = tqOpts; if (c && c.tqActions !== tqActions) c.tqActions = tqActions; }
    hook();

    var pop = h('div', 'tq-pop'); pop.id = 'tq-perm-pop'; pop.hidden = true; root.appendChild(pop);
    function syncChips() {
      var p = permOf(cfg.perm);
      $('.tq-perm-n', permBtn).textContent = p[2];
      permBtn.setAttribute('aria-label', '权限：' + p[1]);
      permBtn.classList.toggle('full', cfg.perm === FULL); permBtn.classList.toggle('ro', cfg.perm === RO);
      planBtn.setAttribute('aria-pressed', String(cfg.plan));
      box.classList.toggle('plan', cfg.plan); orbit.plan = cfg.plan;
      var s = state(), ph = cfg.plan ? '说说要做什么，天启先出计划' : PH0;
      if (s) s.tqPh = cfg.plan ? ph : '';
      say.setAttribute('placeholder', ph);
      syncCcFoot();
      planActs();
    }
    function permMenu(confirm) {
      pop.setAttribute('role', confirm ? 'dialog' : 'menu'); pop.setAttribute('aria-label', '这个对话的权限');
      pop.innerHTML = confirm
        ? '<div class="tq-confirm" role="alert"><p>完全权限下，天启能改 li2 上的任何文件，包括系统设置。只在这个对话里生效。</p><div class="tq-acts"><button class="tq-btn" type="button" data-cancel="1">取消</button><button class="tq-btn go-risk" type="button" data-perm="' + FULL + '" data-sure="1">换成完全权限</button></div></div>'
        : '<p class="tq-pop-h">这个对话的权限</p>' + PERMS.map(function (p) { return '<button class="tq-opt' + (p[0] === FULL ? ' risk' : '') + '" type="button" role="menuitemradio" aria-checked="' + (p[0] === cfg.perm) + '" data-perm="' + p[0] + '"><span class="tq-opt-t"><span>' + p[1] + '</span><small>' + p[3] + '</small></span>' + CHECK + '</button>'; }).join('');
    }
    function focusOpt() { var f = $('.tq-opt[aria-checked="true"]', pop) || $('.tq-opt', pop); if (f) f.focus(); }
    function openPop() {
      closeEff(false); closeWork(false);
      permMenu(false); pop.hidden = false; placeOver(permBtn, pop); permBtn.setAttribute('aria-expanded', 'true');
      if (!REDUCE) { pop.classList.remove('in'); void pop.offsetWidth; pop.classList.add('in'); }
      focusOpt();
    }
    function closePop(backFocus) { if (pop.hidden) return false; pop.hidden = true; permBtn.setAttribute('aria-expanded', 'false'); if (backFocus) permBtn.focus(); return true; }
    permBtn.addEventListener('click', function () { if (pop.hidden) openPop(); else closePop(true); });
    pop.addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      if (b.dataset.cancel) { permMenu(false); placeOver(permBtn, pop); focusOpt(); return; }
      var v = b.dataset.perm; if (!permOf(v)) return;
      if (v === FULL && cfg.perm !== FULL && !b.dataset.sure) { permMenu(true); placeOver(permBtn, pop); $('[data-cancel]', pop).focus(); return; }
      cfg.perm = v; syncChips(); closePop(true);
      if (fresh()) store.set('perm', v === FULL ? null : v);
    });
    pop.addEventListener('keydown', function (e) {
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].indexOf(e.key) < 0) return;
      var o = $$('.tq-opt', pop); if (!o.length) return;
      var i = o.indexOf(document.activeElement), n = e.key === 'Home' ? 0 : e.key === 'End' ? o.length - 1 : (i + (e.key === 'ArrowDown' ? 1 : -1) + o.length) % o.length;
      o[n].focus(); e.preventDefault();
    });
    document.addEventListener('pointerdown', function (e) { if (!pop.hidden && !pop.contains(e.target) && !permBtn.contains(e.target) && !ccPermB.contains(e.target)) closePop(false); }, true);
    addEventListener('resize', function () { if (!pop.hidden) placeOver(permBtn, pop); });
    planBtn.addEventListener('click', function () {
      cfg.plan = !cfg.plan; syncChips();
      if (cfg.plan && !REDUCE) {
        var r = planBtn.getBoundingClientRect();
        if (r.width && r.height) { spawnRing(r.left + r.width / 2, r.top + r.height / 2, PAL.pTrail, 42); spawnSpark(r.left + r.width / 2, r.top + r.height / 2, PAL.pTrail, 6); }
      }
    });

    var plans = {}, latest = '', shown = '', planBox = $('.tq-plan-box'), planTab = $('#tq-tab-plan');
    var PLAN_IC = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 6.5h10M10 12h10M10 17.5h10"/><path d="M3.8 6.4l1.3 1.3 2.3-2.4M3.8 11.9l1.3 1.3 2.3-2.4M3.8 17.4l1.3 1.3 2.3-2.4"/></svg>';
    function planTitle(text) { var m = /^\s*#{1,3}\s+(.+)$/m.exec(text || ''); return ((m ? m[1] : String(text || '').trim().split('\n')[0]) || '计划').replace(/[*_`#]/g, '').trim().slice(0, 80); }
    function planSteps(text) { return (String(text || '').match(/^\s*\d+[.)、]\s+\S/gm) || []).length; }
    function mdEl(text) { var c = chat(); if (c && c.md) { try { return c.md(text); } catch (e) {} } return h('pre', '', text); }
    function isLive(run) {
      var p = plans[run]; if (!p || run !== latest || !p.card || !document.contains(p.card)) return false;
      var mine = $$('.xc-me', msgs), last = mine[mine.length - 1];
      return !(last && (p.card.compareDocumentPosition(last) & Node.DOCUMENT_POSITION_FOLLOWING));
    }
    function actsFor(run, inDoc) {
      var s = state(), live = isLive(run), ro = cfg.perm === RO, busyNow = !!(s && (s.run || s.sending));
      var sig = [run, live, ro, busyNow, inDoc].join('|'), w = h('div', 'tq-acts');
      w.dataset.run = run; w.dataset.sig = sig;
      if (live) w.innerHTML = '<button class="tq-btn primary" type="button" data-plan-act="run"' + (ro || busyNow ? ' disabled' : '') + '>按计划执行</button><button class="tq-btn" type="button" data-plan-act="edit">继续改计划</button>' +
        (inDoc ? '' : '<button class="tq-btn" type="button" data-plan-act="open">看计划</button>') +
        (ro ? '<p class="tq-btn-note">现在是只读权限，改不了文件。先把权限换成「工作区内修改」或「完全权限」。</p>' : '');
      else if (!inDoc) w.innerHTML = '<button class="tq-btn" type="button" data-plan-act="open">看计划</button>';
      else return null;
      return w;
    }
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
      var doc = h('article', 'tq-plan-doc');
      doc.appendChild(mdEl(p.text)); planBox.appendChild(doc);
      swapActs(doc, shown, true);
    }
    function openPlan(run, focus) {
      if (!plans[run]) return;
      shown = run; renderPlanDoc(); planTab.hidden = false;
      L.touched = true; toggleRight(true); select('plan', focus);
    }
    function resetPlans() { plans = {}; latest = shown = ''; planBox.innerHTML = ''; planTab.hidden = true; planTab.classList.remove('has'); if (tab === 'plan') select('term'); }
    document.addEventListener('tq:plan', function (e) {
      var d = e.detail || {}; if (!d.run || !d.text || plans[d.run]) return;
      var card = h('div', 'tq-plan-card' + (d.old || REDUCE ? '' : ' enter')); card.dataset.run = d.run;
      card.innerHTML = '<div class="tq-pc-top">' + PLAN_IC + '<span></span></div><p></p>';
      $('.tq-pc-top span', card).textContent = '计划：' + planTitle(d.text);
      var n = planSteps(d.text); $('p', card).textContent = (n ? n + ' 步。' : '') + '完整计划在右边「计划」里。';
      var el = d.el && document.contains(d.el) ? d.el : null;
      if (el) { el.classList.add('tq-planned'); el.insertBefore(card, $(':scope > .xc-acts', el)); } else msgs.appendChild(card);
      plans[d.run] = { text: d.text, card: card }; latest = d.run;
      planTab.hidden = false; moveInk();
      if (!shown || !d.old) { shown = d.run; renderPlanDoc(); }
      planActs();
      if (!d.old) { if (L.mode === 'wide' || L.mode === 'mid') openPlan(d.run, false); else notify('plan'); }
    });
    root.addEventListener('click', function (e) {
      var b = e.target.closest('[data-plan-act]'); if (!b || b.disabled) return;
      var act = b.dataset.planAct, run = b.closest('[data-run]').dataset.run;
      if (act === 'open') openPlan(run, true);
      else if (act === 'edit') { cfg.plan = true; syncChips(); if (L.mode === 'phone') toggleRight(false); say.focus({ preventScroll: true }); }
      else if (act === 'run') { cfg.plan = false; syncChips(); if (L.mode === 'phone') toggleRight(false); var c = chat(); if (c && c.tqSend) c.tqSend('按计划执行'); }
    });

    /* ================= 工作区选择与新建 ================= */
    var WORK_NAME = /^(?!\.)[\w.一-龥-]{1,64}$/, ROOT_W = '工作目录', WORK_DIR = '/data/workspace';
    var FOLDER = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2.2h7a2 2 0 0 1 2 2v7.8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/></svg>';
    var ws = { sid: '', work: '', pick: WORK_NAME.test(store.get('work') || '') ? store.get('work') : '' };
    var workHead = $('#tq-work'), workBtn = $('#tq-work-pick'), workRow = workBtn.parentNode;
    var wpop = h('div', 'tq-pop tq-work-pop'); wpop.id = 'tq-work-pop'; wpop.hidden = true; root.appendChild(wpop);
    function fresh() { return !ws.sid && !msgs.querySelector('.xc-me'); }
    function curWork() { return ws.sid ? ws.work : ws.pick; }
    function syncWork() {
      var w = curWork(), name = w || ROOT_W;
      workHead.innerHTML = FOLDER + '<span></span>'; workHead.lastChild.textContent = name;
      workHead.title = WORK_DIR + (w ? '/' + w : ''); workHead.setAttribute('aria-label', '工作区：' + name);
      workRow.hidden = !fresh();
      $('span', workBtn).textContent = name; workBtn.setAttribute('aria-label', '新对话的工作区：' + name);
      syncCcWelcome();
    }
    function workOpt(w, label, sub) {
      var b = h('button', 'tq-opt'); b.type = 'button'; b.setAttribute('role', 'menuitemradio');
      b.setAttribute('aria-checked', String(w === ws.pick)); b.dataset.work = w;
      b.innerHTML = '<span class="tq-opt-t"><span></span><small></small></span>' + CHECK;
      b.querySelector('.tq-opt-t > span').textContent = label; b.querySelector('small').textContent = sub;
      return b;
    }
    function workMenu(names, note) {
      wpop.setAttribute('role', 'menu'); wpop.setAttribute('aria-label', '新对话的工作区'); wpop.innerHTML = '<p class="tq-pop-h">新对话在哪个文件夹里跑</p>';
      wpop.appendChild(workOpt('', ROOT_W, WORK_DIR + '，不分文件夹'));
      (names || []).forEach(function (n) { wpop.appendChild(workOpt(n, n, WORK_DIR + '/' + n)); });
      if (note) wpop.appendChild(h('p', 'tq-pop-h', note));
      var add = h('button', 'tq-opt tq-work-add'); add.type = 'button'; add.setAttribute('role', 'menuitem'); add.dataset.add = '1';
      add.innerHTML = '<span class="tq-opt-t"><span>新建文件夹…</span><small>发第一句时建好</small></span>'; wpop.appendChild(add);
    }
    function newFolder() {
      wpop.setAttribute('role', 'dialog'); wpop.setAttribute('aria-label', '新建文件夹');
      wpop.innerHTML = '<form class="tq-work-new"><label class="tq-pop-h" for="tq-work-name">新文件夹的名字（在 ' + WORK_DIR + ' 下面）</label>' +
        '<input id="tq-work-name" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="64" placeholder="比如 led-fast">' +
        '<p class="tq-work-err" role="alert"></p><div class="tq-acts"><button class="tq-btn" type="button" data-cancel="1">取消</button><button class="tq-btn go" type="submit">建好</button></div></form>';
      placeOver(workBtn, wpop); $('input', wpop).focus();
    }
    function focusWork() { var f = $('.tq-opt[aria-checked="true"]', wpop) || $('.tq-opt', wpop); if (f) f.focus(); }
    function openWork() {
      closePop(false); closeEff(false);
      workMenu(null, '读取文件夹…'); wpop.hidden = false; placeOver(workBtn, wpop); workBtn.setAttribute('aria-expanded', 'true');
      if (!REDUCE) { wpop.classList.remove('in'); void wpop.offsetWidth; wpop.classList.add('in'); }
      focusWork();
      var c = chat(), my = wpop.dataset.seq = String(+(wpop.dataset.seq || 0) + 1);
      var stale = function () { return wpop.hidden || wpop.dataset.seq !== my || wpop.getAttribute('role') !== 'menu'; };
      if (!c || typeof c.tqCall !== 'function') return;
      c.tqCall('files', { path: WORK_DIR }, 30000).then(function (d) {
        if (stale()) return;
        var names = (d && d.entries || []).filter(function (x) { return x.dir && x.name !== 'uploads' && WORK_NAME.test(x.name); }).map(function (x) { return x.name; });
        workMenu(names, names.length ? '' : '工作目录下面还没有文件夹'); placeOver(workBtn, wpop); focusWork();
      }, function (e) {
        if (stale()) return;
        workMenu(null, '读不到文件夹：' + (e && e.message || '出错了')); placeOver(workBtn, wpop); focusWork();
      });
    }
    function closeWork(backFocus) { if (wpop.hidden) return false; wpop.hidden = true; workBtn.setAttribute('aria-expanded', 'false'); if (backFocus) workBtn.focus(); return true; }
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
    addEventListener('resize', function () { if (!wpop.hidden) placeOver(workBtn, wpop); });

    document.addEventListener('tq:session', function (e) {
      var d = e.detail || {};
      cfg.perm = permOf(d.perm) ? d.perm : defPerm();
      cfg.plan = false;
      ws.sid = d.sid || '';
      ws.work = d.work || '';
      liveSeenRuns = {};
      closePop(false); closeWork(false); closeEff(false);
      resetPlans(); syncChips(); syncWork(); syncChains(); syncCcFeed();
    });
    new MutationObserver(function (list) {
      syncWork();
      if (list.some(function (m) { return [].some.call(m.addedNodes, function (n) { return n.nodeType === 1 && (n.matches('.xc-me') || n.querySelector('.xc-me')); }); })) planActs();
    }).observe(msgs, { childList: true, subtree: true });
    syncChips();
    syncWork();
    decorateModelBtn();

    /* ================= 终端底部手动运行命令（❯ 提示符 + ⎿ 缩进输出） ================= */
    function cliDur(ms) { var s = (ms || 0) / 1000; return (s < 10 ? Math.round(s * 10) / 10 : Math.round(s)) + ' 秒'; }
    function cliBlock(cmd) {
      var b = h('div', 'tq-cli-run');
      b.innerHTML =
        '<div class="tq-cli-cmd"><span aria-hidden="true">❯ </span><span></span></div>' +
        '<div class="tq-cli-res"><i class="cc-elbow" aria-hidden="true"></i><div class="cc-out-body"><pre class="tq-cli-out"></pre><div class="tq-cli-end"></div></div></div>';
      b.querySelector('.tq-cli-cmd span:last-child').textContent = cmd;
      cliLog.appendChild(b);
      ccStick = true; ccStickBottom();
      return b;
    }
    function cliEnd(b, p, err) {
      var t = err ? '没跑成：' + err : p.timedOut ? '超过 60 秒，停了' : '退出码 ' + p.code + ' · 用时 ' + cliDur(p.ms);
      if (!err && p.truncated) t += ' · 输出超过 64 KB，后面的没显示';
      $('.tq-cli-end', b).textContent = t;
      b.classList.toggle('bad', !!err || p.code !== 0);
      cliBusy = false; cliCmdNow = '';
      cliIn.disabled = cliBtn.disabled = false;
      syncCcFeed();
      cliIn.focus();
    }
    cliForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var cmd = cliIn.value.trim(), c = chat();
      if (!cmd || cliBusy || !c || typeof c.tqCall !== 'function') return;
      var b = cliBlock(cmd), out = $('.tq-cli-out', b), off = 0, fail = function (x) { cliEnd(b, null, x && (x.msg || x.message) || '出错了'); };
      cliIn.value = ''; cliBusy = true; cliCmdNow = cmd; cliT0 = Date.now();
      cliIn.disabled = cliBtn.disabled = true;
      syncCcFeed();
      c.tqCall('term_run', { work: curWork(), cmd: cmd }, 30000).then(function (r) {
        if (!r || r.error || !r.id) { fail(r); return; }
        (function next() {
          if (document.hidden) { setTimeout(next, 1000); return; }
          c.tqCall('term_poll', { id: r.id, off: off }, 30000).then(function (p) {
            if (!p || p.error) { fail(p); return; }
            if (p.out) { out.textContent += p.out; ccStickBottom(); }
            off = p.off;
            if (p.done) cliEnd(b, p); else setTimeout(next, 400);
          }, fail);
        })();
      }, fail);
    });

    /* ================= 命令面板操作与全局单键快捷键 ================= */
    var PI = {
      model: '<circle cx="12" cy="12" r="4"/><ellipse cx="12" cy="12" rx="9" ry="3.8" transform="rotate(-28 12 12)"/>',
      effort: '<circle cx="12" cy="12" r="8"/><path d="M12 6.8l1.4 3.8 3.8 1.4-3.8 1.4L12 17.2l-1.4-3.8L6.8 12l3.8-1.4z"/>',
      shield: '<path d="M12 3.5 19 6v5.5c0 4.2-3 7.6-7 9-4-1.4-7-4.8-7-9V6z"/>',
      plan: '<path d="M10 7h9.5M10 12h9.5M10 17h9.5"/><path d="M4.5 7l1.2 1.2L8 6M4.5 12l1.2 1.2L8 11M4.5 17l1.2 1.2L8 16"/>',
      term: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M7.5 9.5l3 2.5-3 2.5M12.5 15h4"/>',
      left: '<circle cx="6.5" cy="7" r="1.6"/><circle cx="6.5" cy="12" r="1.6"/><circle cx="6.5" cy="17" r="1.6"/><path d="M11 7h8.5M11 12h6.5M11 17h8.5"/>',
      right: '<rect x="3.5" y="4.5" width="17" height="15" rx="3"/><path d="M14.5 4.5v15"/>',
      plug: '<path d="M9 3.5v4M15 3.5v4M6.5 7.5h11v3a5.5 5.5 0 0 1-11 0zM12 16v4.5"/>'
    };
    function pickWorkspace() {
      if (!fresh()) { var c = chat(); if (c && c.tqNew) c.tqNew(); }
      if (wpop.hidden) openWork();
    }
    function openModel() {
      closeEff(false); closePop(false); closeWork(false);
      var b = $('.tq-instruments .xc-mdl');
      if (b && b.getAttribute('aria-expanded') !== 'true') b.click();
    }
    function tqActions() {
      var lf = frame.dataset.left;
      return [
        { ic: PI.model, t: '换模型', k: '模型 星表 model deepseek glm kimi', kbd: 'M', run: openModel },
        { ic: PI.effort, t: '换思考强度', k: '思考强度 星等 算力 effort codex 最高', kbd: 'E', run: function () { if (epop.hidden) openEff(); } },
        { ic: PI.shield, t: '换权限', k: '权限 只读 完全 permission', kbd: 'P', run: function () { if (pop.hidden) openPop(); } },
        { ic: PI.plan, t: cfg.plan ? '关掉计划模式' : '计划模式', k: '计划 plan 先出计划', run: function () { planBtn.click(); } },
        { ic: 'files', t: '切换工作区', k: '工作区 文件夹 workspace 目录', kbd: 'W', run: pickWorkspace },
        { ic: PI.term, t: '打开终端', k: '终端 命令行 claude code terminal shell', run: function () { L.touched = true; toggleRight(true); select('term', true); } },
        { ic: PI.left, t: lf === 'open' ? '收起左栏' : '展开左栏', k: '左栏 星轨 侧栏 对话记录 sidebar', kbd: 'Ctrl B', run: function () { toggleLeft(); } },
        { ic: PI.right, t: L.right ? '收起右栏' : '打开右栏', k: '右栏 面板 文件 终端 预览', kbd: 'Ctrl J', run: function () { L.touched = true; toggleRight(); } },
        { ic: PI.plug, t: '插件', k: '插件 plugin purge rea', run: function () { if (plugBtn) plugBtn.click(); } },
        { ic: 'gear', t: '设置', k: '设置 外观 主题 电脑 退出', run: function () { openSettings(); } }
      ];
    }
    var KEY1 = {
      c: function () { var c = chat(); if (c && c.tqNew) c.tqNew(); },
      m: openModel,
      e: function () { if (epop.hidden) openEff(); },
      p: function () { if (pop.hidden) openPop(); },
      w: pickWorkspace,
      '?': function () { if (L.right && tab === 'term') ccHelpB.click(); }
    };
    function typing(el) { return !!el && el.nodeType === 1 && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)); }
    function quietKeys(ev) {
      var t = ev.target && ev.target.nodeType === 1 ? ev.target : document.activeElement, a = document.activeElement;
      if (typing(t) || typing(a)) return false;
      var OVER = '.tq-pop, .xc-pick, .xc-menu, .xc-sheet, .xc-pal, .tq-modal, .xc-drawer[role="dialog"]';
      if ((t && t.closest && t.closest(OVER)) || (a && a.closest && a.closest(OVER))) return false;
      if (root.classList.contains('pal-open') || root.classList.contains('sheet-open')) return false;
      if (root.classList.contains('dr-open') && drawer.getAttribute('role') === 'dialog') return false;
      return pop.hidden && wpop.hidden && epop.hidden && !$('.xc-pick:not([hidden])') && !$('.xc-menu:not([hidden])');
    }

    window.addEventListener('keydown', function (e) {
      var mod = e.ctrlKey || e.metaKey, k = (e.key || '').toLowerCase(), stop = function () { e.preventDefault(); e.stopImmediatePropagation(); };
      if (e.key === 'Escape' && (closePop(true) || closeWork(true) || closeEff(true))) { stop(); return; }
      if (e.key === 'Escape' && !ccKeys.hidden) { stop(); ccKeys.hidden = true; ccHelpB.setAttribute('aria-expanded', 'false'); ccHelpB.focus(); return; }
      if (!modal.hidden) { if (e.key === 'Escape') { stop(); closeSettings(); } return; }
      if (root.classList.contains('locked')) return;
      if (mod && !e.shiftKey && !e.altKey && k === 'b') { e.preventDefault(); toggleLeft(); }
      else if (mod && !e.shiftKey && !e.altKey && k === 'j') { e.preventDefault(); L.touched = true; toggleRight(); }
      else if (!mod && !e.altKey && (!e.shiftKey || e.key === '?') && !e.repeat && !e.isComposing && KEY1[e.key === '?' ? '?' : k] && e.key.length === 1 && quietKeys(e)) {
        e.preventDefault();
        KEY1[e.key === '?' ? '?' : k]();
      } else if (e.key === 'Escape' && L.mode === 'mid' && L.leftMid) {
        stop(); toggleLeft(false);
      } else if (e.key === 'Escape' && L.mode !== 'wide' && L.right && !root.classList.contains('sheet-open') && !root.classList.contains('dr-open') && !root.classList.contains('pal-open')) {
        stop(); toggleRight(false);
      } else if (e.key === 'Escape' && state().run && sendBtn && sendBtn.dataset.k === 'stop' && quietKeys(e)) {
        stop(); sendBtn.click();
      }
    }, true);

    layout(true);
    select('term');
    linkRefs(msgs);
    syncChains();
    syncCcFeed();
  }
})();
