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
    var COARSE = !!(window.matchMedia && matchMedia('(pointer: coarse)').matches);

    /* ================= 深空星象台背景（WebGL 星云银河 + 多光谱星群 + 天球星盘坐标与星座图） =================
       参考 xemantic/shader-web-background、Inigo Quilez Domain Warping FBM、Shadcn NebulaShader 与 Stellarium Web：
       1. starCv 第 1 遍：全屏片段着色器实时合成 ~32° 倾斜银河亮带、大裂谷暗尘埃带、蓝宝石/青极光反射星云、香槟金恒星孕育区与底部行星大气弧光（星图浅色模式切换为古铜星表水彩底纹）。
       2. starCv 第 2 遍：45% 沿银道面高斯富集的银河碎钻星 + 55% 全天球多光谱恒星 + 5 组真实星座主星（带十字艾里衍射星芒）。
       3. back 画布：离屏缓存 chartCv 预绘黄道/赤道大圆刻度弧、天顶罗盘与北斗/仙后/猎户/天鹅/天琴五组星座连线，平时 0ms 开销，流星或指针连线时单次 drawImage 极速复原。 */
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
          // 沿 32° 银道面高斯分布，形成真实的银河繁星带
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
    /* 将 6 阶分形 FBM + 脊状星云烘焙至离屏 LINEAR 纹理：尺寸或外观变化时重算一次，每帧闪烁仅做单次纹理采样（省去 99.8% 像素运算） */
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
    /* 预绘天球黄道/赤道大圆弧、刻度与五组真实星座线到离屏 chartCv：平时零帧开销，让夜空与星图拥有天文台星盘层次 */
    function buildChart() {
      chartCv.width = Math.round(W * DPR); chartCv.height = Math.round(H * DPR);
      var cc = chartCv.getContext('2d'); if (!cc) return;
      cc.setTransform(DPR, 0, 0, DPR, 0, 0); cc.clearRect(0, 0, W, H);
      var gold = INK ? 'rgba(138,98,28,' : 'rgba(240,215,156,', blue = INK ? 'rgba(42,72,136,' : 'rgba(132,178,246,';
      // 锁定顶点 y = H * .21 与 y = H * .79，保证横屏宽屏与竖屏手机都能看到完整的黄道/赤道大圆弧与赤经刻度
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
      // 天赤道细虚线副弧
      var R2 = Math.max(W, H) * 1.24, cx2 = W * .48, cy2 = H * .79 - R2;
      cc.save(); cc.setLineDash([4, 7]); cc.strokeStyle = blue + (INK ? '.13)' : '.085)'); cc.lineWidth = .7;
      cc.beginPath(); cc.arc(cx2, cy2, R2, Math.PI * .22, Math.PI * .78); cc.stroke(); cc.restore();
      // 五组真实星座连线、主星寻星环与微标（窄屏自动弱化防拥挤）
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
      W = innerWidth; H = innerHeight; DPR = Math.min(2, window.devicePixelRatio || 1);
      // 高度写成固定像素、从顶上量：页面变矮（键盘）时夜空不跟着压扁
      [starCv, back, fx].forEach(function (c) { c.width = Math.round(W * DPR); c.height = Math.round(H * DPR); c.style.height = H + 'px'; });
      bctxDirty = ctxDirty = false;
      buildChart(); blitChart();
      if (gl) { renderNebula(); buildStars(); drawStars(performance.now()); } else fallbackStars();   // 改了画布尺寸画面会被清空，当场重画，不留一帧黑
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
    /* 参考 React Bits ClickSpark：发送、新建、切计划等轻触反馈，8 根细金芒放射消散 */
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
    /* 参考 React Bits Particles 星座连线：桌面鼠标划过中栏夜空时，附近亮星之间浮现纤细星图连线 */
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
    /* 输入框边上走的星（参考 Magic UI BorderBeam / React Bits StarBorder）：主彗星 + 对向伴星，起止平滑淡入淡出 */
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
      var per = rrPoint(b.left, b.top, b.width, b.height, r, 0, P), L = 175, steps = 40;
      orbit.d += per / 4.2 * dt;
      // 主彗星
      rrPoint(b.left, b.top, b.width, b.height, r, orbit.d, P);
      var px = P.x, py = P.y;
      ctx.lineCap = 'round';
      for (var i = 1; i <= steps; i++) {
        rrPoint(b.left, b.top, b.width, b.height, r, orbit.d - L * i / steps, Q);
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
      // 对向伴星（180° 处的轻盈流光，增强轨道动感）
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
    var lastFx = performance.now(), kbAt = 0;
    function loop(now) {
      var dt = Math.min(.05, (now - lastFx) / 1000); lastFx = now;
      // 手机键盘弹起/收起动画期间暂停夜空与 2D 重绘；触屏键盘已弹起且无前台特效时保持静帧，把主线程与 GPU 预算 100% 让给打字与键盘合成
      var kbBusy = html.classList.contains('kb-anim') || (kbAt && now - kbAt < 85);
      var kbIdle = COARSE && html.classList.contains('kb-up') && !orbit.on && orbit.alpha <= 0 && !dust.length && !sparks.length && !rings.length;
      if (!kbBusy && !kbIdle) {
        if (now - lastStar > (COARSE ? 50 : 33)) { drawStars(now); lastStar = now; }
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

    /* 输入框边框微光跟随（SpotlightCard）+ 空状态星盘 3D 陀螺仪倾角（Tilt）+ 点夜空许愿流星（Meteors + ClickSpark） */
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
      if (e.target.closest && e.target.closest('button, a, input, textarea, select, label, .xc-bub, .tq-box, .tq-plan-card, .xc-pick, .xc-menu, .tq-mid-head')) return;
      var sel = window.getSelection && window.getSelection();
      if (sel && String(sel).trim()) return;
      if (e.target.closest && e.target.closest('.xc-body')) {
        spawnSpark(e.clientX, e.clientY, PAL.trail, 7);
        spawnMeteor({ x: Math.max(24, Math.min(W - 24, e.clientX - 70)), y: Math.max(16, e.clientY - 42) });
      }
    });

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
      sparkFrom(sendBtn, orbit.plan ? PAL.pTrail : PAL.trail, 10);
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
    $('.tq-brand-key').addEventListener('click', function () { sparkFrom($('.tq-brand-mark'), PAL.trail, 8); if (L.mode === 'wide' || L.mode === 'mid') toggleLeft(); });
    var railCmd = $('.tq-rail-cmd');
    if (railCmd) railCmd.addEventListener('click', function () { var c = chat(); if (c && c.tqPal) c.tqPal(); });
    panelB.addEventListener('click', function () { L.touched = true; toggleRight(); });
    $('.tq-r-x').addEventListener('click', function () { L.touched = true; toggleRight(false); });
    scrim2.addEventListener('click', function () { toggleRight(false); });
    var rs = 0;
    /* 站长 11-20 iPad 截图：每次点输入框屏幕闪一下。键盘弹出时外壳把 iframe 缩到可见区域（shell.js 的 fitStage），这里跟着 resize
       重设画布尺寸——画布被清空、星星按新高度重排，就是那一闪。照 Element / Discord 网页版的做法：只变矮、宽度没变（键盘）时夜空不动，
       画布按原来的高度留着，被键盘盖住的部分本来就看不见；宽度变了（转屏、拉窗口）或变高了才重画。 */
    addEventListener('resize', function () {
      if (innerWidth === W && innerHeight <= H && Math.min(2, window.devicePixelRatio || 1) === DPR) return;
      clearTimeout(rs);
      rs = setTimeout(function () {
        if (innerWidth !== W || innerHeight > H || Math.min(2, window.devicePixelRatio || 1) !== DPR) { size(); if (REDUCE) drawStars(performance.now()); }
        if (L.right) moveInk();
      }, 120);
    });
    // 独立打开 /tools/tianqi/（未嵌在工具箱外壳里）时，给真 iOS 补齐 preventScroll 屏外聚焦与 visualViewport 高度同步
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
    /* 键盘弹起、收起时面板只变高度，只保留「列表离底距离不变」（参考 element-web ScrollPanel.tsx 的 stuckAtBottom / bottomOffset）。
       每帧只做一次读+写，不在回调里重复读 scrollHeight/clientHeight。 */
    var dock = $('.tq-dock'), kbW = 0, kbH = 0, kbGap = 0, kbSet = false;
    function kbBody() { return frame.hasAttribute('data-start') ? null : $('.tq-mid > .xc-body'); }   // 空对话：整段靠排版跟着输入框，不用管滚动
    function gapOf(b) { return Math.max(0, b.scrollHeight - b.scrollTop - b.clientHeight); }
    function keepGap(b) { b.scrollTop = b.scrollHeight - b.clientHeight - kbGap; }
    function kbMark() { var b = kbBody(); kbW = frame.clientWidth; kbH = frame.clientHeight; kbSet = true; if (b) kbGap = gapOf(b); }
    function onKbResize() {
      var w = frame.clientWidth, h = frame.clientHeight, b = kbBody();
      if (!kbSet || w !== kbW || h === kbH) { kbMark(); return; }
      kbW = w; kbH = h; kbSet = true; kbAt = performance.now();
      if (b) keepGap(b);   // 排版已经按新高度走过，直接按变之前记下的离底距离摆好，不再多做一次同步布局读
    }
    if (window.ResizeObserver) new ResizeObserver(onKbResize).observe(frame); else addEventListener('resize', onKbResize);
    requestAnimationFrame(kbMark);
    // 输入框位置也会因为别的事变（打字长高、用量那行、空对话变成有字），键盘出来之前、面板没变时都重新记一下
    ['pointerdown', 'focusin'].forEach(function (t) { document.addEventListener(t, function () { if (!html.classList.contains('kb-up')) kbMark(); }, true); });
    // 输入框变高（打字换行、用量那行出来）列表跟着变矮：原来贴着底的继续贴着底；往上翻着看的不动
    if (window.ResizeObserver) new ResizeObserver(function () {
      if (frame.clientHeight !== kbH || frame.clientWidth !== kbW) return;
      var b = kbBody(); if (b && kbGap <= 4) keepGap(b);
      kbMark();
    }).observe(dock);
    new MutationObserver(function () { requestAnimationFrame(kbMark); }).observe(frame, { attributes: true, attributeFilter: ['data-start', 'data-mode'] });
    // 自己滚了：重新记离底多远（面板刚变完高度那一下浏览器发的 scroll 不算）
    document.addEventListener('scroll', function (e) { var b = kbBody(); if (b && e.target === b && performance.now() > kbAt + 100 && frame.clientHeight === kbH) kbGap = gapOf(b); }, true);

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
    planBtn.addEventListener('click', function () {
      cfg.plan = !cfg.plan; syncChips();
      if (cfg.plan && !REDUCE) {
        var r = planBtn.getBoundingClientRect();
        if (r.width && r.height) { spawnRing(r.left + r.width / 2, r.top + r.height / 2, PAL.pTrail, 42); spawnSpark(r.left + r.width / 2, r.top + r.height / 2, PAL.pTrail, 6); }
      }
    });

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
      else if (act === 'edit') { cfg.plan = true; syncChips(); if (L.mode === 'phone') toggleRight(false); say.focus({ preventScroll: true }); }
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
