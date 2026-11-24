(function () {
  'use strict';
  var TOOLS = window.TOOLS || [];
  var home = document.getElementById('home');
  var $ = function (s) { return document.querySelector(s); };
  var html = document.documentElement, body = document.body;
  var SVGNS = 'http://www.w3.org/2000/svg';
  var byId = {}, byPath = {};
  TOOLS.forEach(function (t) { byId[t.id] = t; byPath[t.path.replace(/\/+$/, '')] = t; });
  var standalone = window.navigator.standalone === true || (window.matchMedia && matchMedia('(display-mode: standalone)').matches);
  if (standalone) html.classList.add('standalone');
  var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  var isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
  if (isIOS) html.classList.add('ios');
  // iOS / 触屏设备：面板开关完全不用 clip-path（真机 WebKit 对带 clip-path 的合成层在隐藏时不重绘，会留下残影），
  // 改为整块 opacity + transform；桌面端保留从卡片展开/收回的 clip-path 动画
  var lite = isIOS || !!(window.matchMedia && matchMedia('(hover: none) and (pointer: coarse)').matches);
  if (lite) html.classList.add('lite');
  // iOS 主屏幕 App 默认当作有原生左缘返回，一开始就关掉自定义 edgeSwipe，不让第一次滑动叠两层
  if (standalone && (isIOS || ls('lm.nativeBack') === '1')) html.classList.add('native-back');
  // 路由切换时不让浏览器自动恢复滚动位置（会与手势返回的快照错位）
  try { if ('scrollRestoration' in history) history.scrollRestoration = 'manual'; } catch (e) {}
  function ls(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } }

  /* ---------- SVG：只用 createElementNS + setAttribute 构建 ---------- */
  function svg(spec) {
    var s = document.createElementNS(SVGNS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true'); s.setAttribute('focusable', 'false');
    (spec || []).forEach(function (n) {
      var el = document.createElementNS(SVGNS, n[0]), at = n[1] || {};
      for (var k in at) if (Object.prototype.hasOwnProperty.call(at, k)) el.setAttribute(k, String(at[k]));
      s.appendChild(el);
    });
    return s;
  }
  var BACK = [['path', { d: 'M14.5 5.5 8 12l6.5 6.5' }]];
  var HOUSE = [['path', { d: 'M4.5 11.5 12 5l7.5 6.5' }], ['path', { d: 'M6.5 10v9h11v-9' }], ['path', { d: 'M10.5 19v-5h3v5' }]];
  function iconBox(t, cls) {
    var b = document.createElement('span'); b.className = cls || 'ic';
    b.appendChild(svg(t.icon)); return b;
  }

  /* ---------- 按压反馈 ----------
     pointerdown 立即加 .press（CSS 里按下 .1s 快速收缩），松开/取消/移出时去掉（CSS 里 .3s ease-out 平稳回位）。
     极快的轻点也至少保持 90ms 按下态，保证肉眼能看到一次完整的「按下-松开」；滚动开始时浏览器发 pointercancel，按下态随即撤销。 */
  function pressable(root, sel) {
    var cur = null, t0 = 0, tm = 0;
    function release() {
      if (!cur) return;
      var el = cur, left = 90 - (Date.now() - t0); cur = null; clearTimeout(tm);
      if (left > 0) tm = setTimeout(function () { el.classList.remove('press'); }, left); else el.classList.remove('press');
    }
    root.addEventListener('pointerdown', function (e) {
      if (e.button > 0) return;
      var el = sel ? e.target.closest(sel) : root;
      if (!el || !root.contains(el)) return;
      clearTimeout(tm); if (cur && cur !== el) cur.classList.remove('press');
      cur = el; t0 = Date.now(); el.classList.add('press');
    });
    root.addEventListener('pointerup', release);
    root.addEventListener('pointercancel', release);
    root.addEventListener('pointerout', function (e) { if (cur && !cur.contains(e.relatedTarget)) release(); });
    window.addEventListener('blur', release);
  }

  /* ---------- 主题 ---------- */
  var mq = matchMedia('(prefers-color-scheme: dark)');
  function applyTheme() {
    var pref = ls('lm.theme') || 'light';
    var dark = pref === 'dark' || (pref === 'auto' && mq.matches);
    html.dataset.theme = dark ? 'dark' : 'light'; html.dataset.pref = pref;
    $('#themeColor').setAttribute('content', dark ? '#1f1e1d' : '#faf9f5');
  }
  applyTheme();
  if (mq.addEventListener) mq.addEventListener('change', applyTheme);
  var themeBtn = $('#themeBtn');
  pressable(themeBtn);
  themeBtn.addEventListener('click', function (ev) {
    var order = ['light', 'dark', 'auto'], cur = ls('lm.theme') || 'light';
    var next = order[(order.indexOf(cur) + 1) % 3]; ls('lm.theme', next);
    // 站长 2026-11-19：从点的地方一圈圈扩散着换颜色（View Transitions；不支持或减少动态时直接换）
    var de = document.documentElement, still = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (document.startViewTransition && !still) {
      var r = themeBtn.getBoundingClientRect(), done = function () { de.classList.remove('vt-theme'); };
      de.style.setProperty('--vt-x', (ev && ev.clientX || r.left + r.width / 2) + 'px'); de.style.setProperty('--vt-y', (ev && ev.clientY || r.top + r.height / 2) + 'px'); de.classList.add('vt-theme');
      document.startViewTransition(applyTheme).finished.then(done, done);
    } else applyTheme();
    toast({ light: '浅色', dark: '深色', auto: '跟随系统' }[next]);
    stage.querySelectorAll('iframe').forEach(function (f) { try { f.contentWindow.postMessage({ type: 'theme' }, location.origin); } catch (e) {} });
  });

  /* ---------- 首页：按分类分区，每类第一个（最近打开的）占一整行 ---------- */
  var CATS = window.TOOL_CATS || [{ id: 'tool', name: '工具' }];
  function recent() { try { var r = JSON.parse(ls('lm.shell.recent') || '[]'); return Array.isArray(r) ? r : []; } catch (e) { return []; } }
  function touchRecent(id) { var r = recent().filter(function (x) { return x !== id && byId[x]; }); r.unshift(id); ls('lm.shell.recent', JSON.stringify(r.slice(0, 20))); }
  function rank(id) { var i = recent().indexOf(id); return i < 0 ? 999 : i; }
  function sv(tag, at) { var e = document.createElementNS(SVGNS, tag); for (var k in at) if (Object.prototype.hasOwnProperty.call(at, k)) e.setAttribute(k, String(at[k])); return e; }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

  /* STM32 学到哪了：学习台每次换页都会发 route 过来，存一份，首页用它写「继续」那一行、点亮对应外设的引脚 */
  var TOPIC = { gpio: 'GPIO', exti: 'EXTI', usart: 'USART', i2c: 'I2C', tim: 'TIM', dma: 'DMA', adc: 'ADC', spi: 'SPI', sys: 'RCC', fsmc: 'FSMC' };
  var TOPIC_PINS = { gpio: [34, 35, 100], exti: [20, 21, 22, 49], usart: [101, 102], i2c: [69, 70], tim: [35, 136, 100], dma: [101, 102], adc: [26, 28], spi: [41, 42, 43, 7], sys: [23, 24, 25], fsmc: [118, 119, 127, 56, 85, 86, 114, 115, 58, 59, 60, 63] };
  var SEC = { points: '要点', pins: '引脚', regs: '寄存器', code: '代码', figs: '图' }, CV = { reg: '寄存器代码', hal: 'HAL 代码', cd: '代码推导' };
  function stmWhere(route) {
    var sp; try { sp = new URLSearchParams(route || ''); } catch (e) { return null; }
    var v = sp.get('v') || 'home', t = sp.get('t'), name = TOPIC[t];
    if (v === 'topic' && name) { var cv = sp.get('cv'), sec = sp.get('sec'); return { t: t, text: name + ' ' + (sec && sec !== 'code' && SEC[sec] ? SEC[sec] : cv && CV[cv] ? CV[cv] : sec && SEC[sec] ? SEC[sec] : '') }; }
    if (v === 'think') {
      if (!name) return { text: '设计原理' };
      var st = sp.get('s'), m = /^s(\d+)$/.exec(st || '');
      return { t: t, text: name + ' 设计原理' + (m ? ' 第 ' + m[1] + ' 环' : st === 'review' ? ' 复习' : '') };
    }
    if (v === 'board') return { text: '开发板' };
    return null;
  }

  /* 插画（参考 DavidHDev/react-bits PixelCard/GlareHover/ClickSpark、magicuidesign/magicui OrbitingCircles/InteractiveGridPattern、ibelick/motion-primitives Spotlight/AnimatedGroup） */
  // LQFP144：每边 36 个脚，1 脚在左上，逆时针编号；on 里的脚号点亮，外圈附 45° PCB 走线与脉冲信号包
  var CHIP_TRACES = [
    'M4 78h20l11 11h10', 'M0 108h18l10 10h17', 'M6 146h22l9-9h8', 'M2 178h19l12-12h12',
    'M92 6v16l10 10v13', 'M156 4v18l-10 10v13', 'M96 254v-16l11-11v-12', 'M166 256v-18l-11-11v-12'
  ];
  function artChip(on) {
    var s = sv('svg', { viewBox: '0 0 260 260', 'class': 'art art-chip', 'aria-hidden': 'true' });
    var tr = sv('g', { 'class': 'traces' });
    CHIP_TRACES.forEach(function (d, i) {
      tr.appendChild(sv('path', { d: d, 'class': 'tr' }));
      var sig = sv('path', { d: d, 'class': 'tr-sig' });
      sig.style.setProperty('--d', (i * 0.16).toFixed(2) + 's');
      tr.appendChild(sig);
    });
    s.appendChild(tr);
    var g = sv('g', { 'class': 'pins' });
    var B = 50, W = 160, step = W / 36, L = 15, lit = {};
    var active = (on && on.length) ? on : [8, 9, 23, 24, 69, 70, 101, 102];
    active.forEach(function (n, k) { lit[n] = k + 1; });
    for (var n = 1; n <= 144; n++) {
      var side = Math.floor((n - 1) / 36), k = (n - 1) % 36, x, y, w, h, c = B + step * (k + 0.5);
      if (side === 0) { x = B - L; y = c - 1.1; w = L; h = 2.2; }
      else if (side === 1) { x = c - 1.1; y = B + W; w = 2.2; h = L; }
      else if (side === 2) { x = B + W; y = B + W - step * (k + 0.5) - 1.1; w = L; h = 2.2; }
      else { x = B + W - step * (k + 0.5) - 1.1; y = B - L; w = 2.2; h = L; }
      var r = sv('rect', { x: x.toFixed(2), y: y.toFixed(2), width: w, height: h, rx: 0.6 });
      if (lit[n]) { r.setAttribute('class', 'on'); r.style.setProperty('--k', String(lit[n])); }
      g.appendChild(r);
    }
    s.appendChild(g);
    s.appendChild(sv('rect', { x: B, y: B, width: W, height: W, rx: 7, 'class': 'body' }));
    s.appendChild(sv('rect', { x: B + 9, y: B + 9, width: W - 18, height: W - 18, rx: 4, 'class': 'bevel' }));
    s.appendChild(sv('rect', { x: B + 15, y: B + 15, width: 10, height: 10, 'class': 'dimple' }));
    var t1 = sv('text', { x: B + W / 2, y: B + W / 2 - 2, 'class': 'mark' }); t1.textContent = 'STM32F103';
    var t2 = sv('text', { x: B + W / 2, y: B + W / 2 + 16, 'class': 'mark sub' }); t2.textContent = 'ZET6';
    s.appendChild(t1); s.appendChild(t2);
    return s;
  }
  // 点阵世界地图：64 × 28，由 data/countries.json 预先算好（每行 16 位十六进制），附坐标信标脉冲与经度扫描带
  var WORLD = ["001343f00020f0c0", "081de3f0080ffff0", "ffff9bc83dffffff", "1ffe21006ffffffe", "00ff38016fffff88", "007ffc017fffff80", "003ff200ffffffc0", "003fe003b9fffe00", "003fe00327bffe00", "001fc003e3fffc00", "000e4003fffff800", "000e4007fdeffc00", "00030007ffc66400", "00008007ff046400", "00007803ff804000", "00003e003f004800", "00003f003e001900", "00003fc03e000070", "00003fc03e000000", "00001f803e800340", "00000f803c8007c0", "00001f001c000fe0", "00001e001c000fe0", "00001c00100000e0", "0000180000000000", "0000100000000002", "0000100000000000", "0000100000000000"];
  var WORLD_BEACONS = [[51, 9], [33, 6], [14, 8], [55, 20]];
  function artWorld() {
    var s = sv('svg', { viewBox: '0 0 384 168', 'class': 'art art-world', 'aria-hidden': 'true' });
    var dots = sv('g', { 'class': 'w-dots' });
    WORLD.forEach(function (row, r) {
      for (var c = 0; c < 64; c++) {
        if ((parseInt(row[c >> 2], 16) >> (3 - (c & 3))) & 1) dots.appendChild(sv('rect', { x: c * 6 + 1, y: r * 6 + 1, width: 4, height: 4 }));
      }
    });
    s.appendChild(dots);
    s.appendChild(sv('rect', { x: -36, y: 0, width: 32, height: 168, 'class': 'w-scan' }));
    var bc = sv('g', { 'class': 'w-beacons' });
    WORLD_BEACONS.forEach(function (pt, i) {
      var bx = pt[0] * 6 + 1, by = pt[1] * 6 + 1;
      var ring = sv('rect', { x: bx - 4, y: by - 4, width: 12, height: 12, 'class': 'b-ring' });
      ring.style.setProperty('--d', (i * 0.65).toFixed(2) + 's');
      bc.appendChild(ring);
      bc.appendChild(sv('rect', { x: bx, y: by, width: 4, height: 4, 'class': 'b-dot' }));
    });
    s.appendChild(bc);
    return s;
  }
  // 天启夜空星盘：错峰闪烁像素星、悬停连亮的北斗星群、正反双轨星盘与划空流星
  var SKY_STARS = [
    [18, 22, 2], [44, 14, 2], [72, 34, 3], [98, 18, 2], [134, 28, 2], [166, 16, 3], [202, 24, 2], [308, 20, 2], [326, 44, 3],
    [28, 74, 2], [62, 96, 2], [92, 126, 3], [128, 114, 2], [160, 142, 2], [194, 132, 3], [216, 56, 2], [318, 118, 2], [298, 146, 3]
  ];
  var SKY_NODES = [[38, 52], [68, 44], [98, 58], [124, 78], [132, 108], [168, 114], [182, 84]];
  function artSky() {
    var s = sv('svg', { viewBox: '0 0 340 168', 'class': 'art art-sky', 'aria-hidden': 'true' });
    var st = sv('g', { 'class': 'sky-stars' });
    SKY_STARS.forEach(function (p, i) {
      var r = sv('rect', { x: p[0], y: p[1], width: p[2], height: p[2], 'class': 'st' });
      r.style.setProperty('--d', ((i % 7) * 0.37).toFixed(2) + 's');
      st.appendChild(r);
    });
    s.appendChild(st);
    var cs = sv('g', { 'class': 'sky-const' });
    cs.appendChild(sv('path', { d: 'M38 52L68 44L98 58L124 78L132 108L168 114L182 84L124 78', 'class': 'c-line' }));
    SKY_NODES.forEach(function (p, i) {
      var nd = sv('rect', { x: p[0] - 2, y: p[1] - 2, width: 4, height: 4, 'class': 'c-node' });
      nd.style.setProperty('--d', (i * 0.08).toFixed(2) + 's');
      cs.appendChild(nd);
    });
    s.appendChild(cs);
    var mt = sv('g', { 'class': 'sky-meteor' });
    mt.appendChild(sv('path', { d: 'M176 22L134 46', 'class': 'm-tail' }));
    mt.appendChild(sv('rect', { x: 132, y: 45, width: 3, height: 3, 'class': 'm-head' }));
    s.appendChild(mt);
    var ob = sv('g', { 'class': 'sky-orb' });
    ob.appendChild(sv('circle', { cx: 254, cy: 84, r: 54, 'class': 'orb-outer' }));
    ob.appendChild(sv('circle', { cx: 254, cy: 84, r: 36, 'class': 'orb-inner' }));
    ob.appendChild(sv('path', { d: 'M254 18v12M254 138v12M188 84h12M308 84h12', 'class': 'orb-ticks' }));
    var sat = sv('g', { 'class': 'orb-sat' });
    sat.appendChild(sv('rect', { x: 251, y: 27, width: 6, height: 6, 'class': 'orb-planet' }));
    sat.appendChild(sv('rect', { x: 288, y: 82, width: 4, height: 4, 'class': 'orb-moon' }));
    ob.appendChild(sat);
    ob.appendChild(sv('path', { d: 'M254 66l4 14 14 4-14 4-4 14-4-14-14-4 14-4Z', 'class': 'orb-core' }));
    ob.appendChild(sv('rect', { x: 252.5, y: 82.5, width: 3, height: 3, 'class': 'orb-heart' }));
    s.appendChild(ob);
    return s;
  }
  function artIcon(t) { var s = svg(t.icon); s.setAttribute('class', 'art art-icon'); return s; }

  function card(t, wide, hero) {
    var a = el('a', 'card' + (wide ? ' wide' : '') + (hero ? ' hero' : '') + (t.art ? ' art-' + t.art : ''));
    a.href = t.path; a.dataset.id = t.id; a.setAttribute('aria-label', t.name);
    var where = t.id === 'stm32' ? stmWhere(ls('lm.shell.stm32')) : null;
    if (t.art === 'chip') a.appendChild(artChip(where && where.t ? TOPIC_PINS[where.t] : []));
    else if (t.art === 'world') a.appendChild(artWorld());
    else if (t.art === 'sky') a.appendChild(artSky());
    else a.appendChild(artIcon(t));
    var tx = el('span', 'tx');
    tx.appendChild(iconBox(t));
    tx.appendChild(el('span', 'nm', t.name));
    if (hero && where && where.text) {
      var go = el('span', 'go');
      go.appendChild(svg([['path', { d: 'M9.5 7.5 14 12l-4.5 4.5' }]]));
      go.appendChild(el('span', null, where.text.trim()));
      tx.appendChild(go);
      a.dataset.route = ls('lm.shell.stm32') || '';
      a.setAttribute('aria-label', t.name + '，继续 ' + where.text.trim());
    }
    a.appendChild(tx);
    return a;
  }

  var grid = $('#grid');
  function renderHome() {
    grid.textContent = '';
    var heroId = recent().filter(function (x) { return byId[x]; })[0];
    CATS.concat(TOOLS.some(function (t) { return !CATS.some(function (c) { return c.id === t.cat; }); }) ? [{ id: '', name: '其他' }] : []).forEach(function (c) {
      var list = TOOLS.filter(function (t) { return c.id ? t.cat === c.id : !CATS.some(function (x) { return x.id === t.cat; }); });
      if (!list.length) return;
      list.sort(function (x, y) { return rank(x.id) - rank(y.id); });
      var sec = el('section', 'cat'); sec.dataset.cat = c.id;
      sec.appendChild(el('h2', 'cat-h', c.name));
      var g = el('div', 'cat-g');
      list.forEach(function (t, i) { g.appendChild(card(t, i === 0, t.id === heroId)); });
      sec.appendChild(g); grid.appendChild(sec);
    });
  }
  renderHome();
  // 关掉工具回到首页后，按最新的「最近打开」和学习位置重画（只在没有收拢动画进行时）
  var homeSig = '';
  function sig() { return recent().join() + '|' + (ls('lm.shell.stm32') || ''); }
  homeSig = sig();
  function refreshHome() { var s2 = sig(); if (s2 === homeSig) return; homeSig = s2; renderHome(); html.classList.add('settled'); }

  pressable(grid, '.card');
  pressable($('#cmd'));

  /* 桌面指针追光（Spotlight）与标题栏像素迸发火花（ClickSpark） */
  var spotRaf = 0, spotEl = null, spotX = 0, spotY = 0;
  home.addEventListener('pointermove', function (e) {
    if (e.pointerType === 'touch') return;
    var t = e.target && e.target.closest ? e.target.closest('.card, .xw-card') : null;
    if (!t) return;
    spotEl = t; spotX = e.clientX; spotY = e.clientY;
    if (spotRaf) return;
    spotRaf = requestAnimationFrame(function () {
      spotRaf = 0;
      if (!spotEl) return;
      var r = spotEl.getBoundingClientRect();
      spotEl.style.setProperty('--mx', (spotX - r.left).toFixed(1) + 'px');
      spotEl.style.setProperty('--my', (spotY - r.top).toFixed(1) + 'px');
    });
  }, { passive: true });
  function spawnHomeSpark(x, y) {
    if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    for (var i = 0; i < 8; i++) {
      var a = (Math.PI * 2 * i) / 8 + (i % 2 ? 0.18 : -0.12), dist = 16 + (i % 3) * 7;
      var sp = el('span', 'hm-spark');
      sp.style.left = x + 'px'; sp.style.top = y + 'px';
      sp.style.setProperty('--dx', Math.round(Math.cos(a) * dist) + 'px');
      sp.style.setProperty('--dy', Math.round(Math.sin(a) * dist) + 'px');
      body.appendChild(sp);
      setTimeout(function (n) { if (n.parentNode) n.parentNode.removeChild(n); }, 520, sp);
    }
  }
  var brandSpark = home.querySelector('.hd .spark');
  if (brandSpark) brandSpark.addEventListener('click', function (e) {
    var r = brandSpark.getBoundingClientRect();
    brandSpark.classList.remove('spin'); void brandSpark.offsetWidth; brandSpark.classList.add('spin');
    spawnHomeSpark(e.clientX || (r.left + r.width / 2), e.clientY || (r.top + r.height / 2));
  });

  document.addEventListener('click', function (e) {
    var a = e.target.closest('a[data-id]'); if (!a || e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault(); open(a.dataset.id, { from: a, push: true, route: a.dataset.route });
  });

  /* 搜索：标题栏的放大镜打开搜索框，找不到的卡片和空了的分类藏起来；剩余卡片做 FLIP 平滑补位 */
  var q = $('#q'), searchBtn = $('#searchBtn');
  function match(t, s) { return (t.name + ' ' + (t.keywords || '') + ' ' + t.id).toLowerCase().indexOf(s) > -1; }
  function filter() {
    var s = q.value.trim().toLowerCase(), n = 0;
    var still = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
    var before = new Map();
    if (!still) grid.querySelectorAll('.card[data-id]:not(.hide)').forEach(function (c) { before.set(c, c.getBoundingClientRect()); });
    grid.querySelectorAll('.card[data-id]').forEach(function (c) { var ok = !s || match(byId[c.dataset.id], s); c.classList.toggle('hide', !ok); if (ok) n++; });
    grid.querySelectorAll('.cat').forEach(function (sec) { sec.hidden = !sec.querySelector('.card:not(.hide)'); });
    $('#empty').hidden = n > 0;
    if (!still && before.size) {
      grid.querySelectorAll('.card[data-id]:not(.hide)').forEach(function (c) {
        var r0 = before.get(c); if (!r0 || !c.animate) return;
        var r1 = c.getBoundingClientRect(), dx = r0.left - r1.left, dy = r0.top - r1.top;
        if (Math.abs(dx) > 1 || Math.abs(dy) > 1) c.animate([{ transform: 'translate(' + dx + 'px,' + dy + 'px)' }, { transform: 'none' }], { duration: 220, easing: 'cubic-bezier(.22,1,.36,1)' });
      });
    }
  }
  function searching(on) {
    home.classList.toggle('searching', on);
    searchBtn.setAttribute('aria-expanded', on ? 'true' : 'false');
    if (on) { q.focus(); return; }
    q.value = ''; filter(); q.blur();
  }
  pressable(searchBtn);
  searchBtn.addEventListener('click', function (ev) {
    var r = searchBtn.getBoundingClientRect();
    spawnHomeSpark(ev.clientX || (r.left + r.width / 2), ev.clientY || (r.top + r.height / 2));
    searching(!home.classList.contains('searching'));
  });
  q.addEventListener('input', filter);
  q.addEventListener('blur', function () { if (!q.value.trim()) setTimeout(function () { if (document.activeElement !== q && !q.value.trim()) home.classList.remove('searching'), searchBtn.setAttribute('aria-expanded', 'false'); }, 120); });
  q.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { var c = grid.querySelector('.card[data-id]:not(.hide)'); if (c) { q.blur(); open(c.dataset.id, { from: c, push: true, route: c.dataset.route }); } }
    if (e.key === 'Escape') searching(false);
  });
  document.addEventListener('keydown', function (e) {
    // 小芯聊天已经处理过的键不再处理：在聊天里按 Esc 只收聊天那一层，不顺带关掉工具
    if (e.defaultPrevented) return;
    if (current) { if (e.key === 'Escape') back(); return; }
    // 小芯聊天开着时 Ctrl/⌘ K 归它的命令面板；在输入框里打「/」就是在打字（比如路径）
    var t = e.target, typing = !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
    if (document.body.classList.contains('xc-open') || (e.key === '/' && typing)) return;
    if ((e.key === '/' || (e.key === 'k' && (e.metaKey || e.ctrlKey))) && document.activeElement !== q) { e.preventDefault(); searching(true); }
  });

  /* ---------- 提示 ---------- */
  var tt;
  function toast(m) { var t = $('#toast'); t.textContent = m; t.classList.add('show'); clearTimeout(tt); tt = setTimeout(function () { t.classList.remove('show'); }, 1400); }

  /* ---------- 工具面板 & 路由 ---------- */
  var stage = $('#stage'), panels = {}, current = null;
  /* 工具开着（body.locked）时：首页钉在原处、页面没得滚；触屏上面板跟着可见区域走。
     站长 11-20：手机上从首页打开天启，打字时键盘把面板推上去，下面露出首页的卡片。
     照 Vaul / React Aria 的 usePreventScroll（iOS：记住滚动位置、页面滚回顶、被滚了就滚回去，关掉时滚回原处），
     和 Vaul 的 repositionInputs（键盘弹出、visualViewport 变小时，浮层的高度和位置跟着它）。
     首页不藏：触屏从左缘滑动返回时要露出它，所以按原来的位置固定住，看起来一点没动，页面却没有能滚的高度。 */
  var pinY = 0;
  function pinHome(on) {
    if (on === html.classList.contains('home-pin')) return;
    if (on) { pinY = window.scrollY || 0; home.style.top = -pinY + 'px'; html.classList.add('home-pin'); window.scrollTo(0, 0); }
    else { html.classList.remove('home-pin'); home.style.top = ''; window.scrollTo(0, pinY); }
  }
  /* iOS 的键盘和状态栏是半透明的，后面透出来的是整页的底（站长 11-20 第二次截图：面板缩到键盘上面了，键盘后面还是白的首页）。
     照 Vaul 抽屉下面那层同色遮罩：跟着键盘的这段时间，整页底色换成工具自己的 theme-color、首页藏起来；键盘收起就复原
     （平时首页不藏：左缘滑动返回时要露出它）。 */
  function frameColor(p) {
    var c = '';
    try { var m = p && p._frame.contentDocument.querySelector('meta[name="theme-color"]'); c = m ? (m.getAttribute('content') || '').trim() : ''; } catch (e) { /* 别的源 */ }
    return /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\))$/i.test(c) ? c : '';
  }
  function toolColor() { return frameColor(current && panels[current]); }
  /* 站长 11-21：手机上点天启的输入框还是闪一下。天启是深色（#02040a），可面板和 iframe 自己的底、整页的底都是首页的浅色（#faf9f5）。
     iOS 弹键盘时会先挪可见区域、再改 iframe 的高度，iframe 还没按新尺寸画好的那一下露出来的就是这层浅色底——深色页面上一道白闪。
     做法同 kbCover 照的 Vaul：面板和 iframe 的底一开始就换成工具自己的 theme-color；输入框一获得焦点（键盘还没出来）整页底色就先换好。 */
  function paintFrameBg(p) {
    var c = frameColor(p);
    p.style.background = c; p._frame.style.background = c;
  }
  function kbPre(on) {
    var c = on ? toolColor() : '';
    html.classList.toggle('kb-pre', !!c);
    if (c) html.style.setProperty('--kb-bg', c); else if (!html.classList.contains('kb-up')) html.style.removeProperty('--kb-bg');
  }
  var tqSafeBottom = 0, kbToolCol = '', kbLast = { top: null, h: null, up: false, bg: '', overlap: null, anim: false };
  function kbRoot() {
    try { var p = current && panels[current]; return p ? p._frame.contentDocument.documentElement : null; } catch (e) { return null; }
  }
  function kbSyncAnim(on) {
    on = !!on;
    if (kbLast.anim === on) return;
    kbLast.anim = on;
    var root = kbRoot();
    if (root) root.classList.toggle('kb-anim', on);
  }
  function kbCover(on, overlap) {
    on = !!on;
    var c = on ? (kbToolCol || (kbToolCol = toolColor())) : '';
    if (kbLast.up !== on) {
      kbLast.up = on;
      html.classList.toggle('kb-up', on);
    }
    if (c) {
      if (kbLast.bg !== c) { kbLast.bg = c; html.style.setProperty('--kb-bg', c); }
    } else if (!html.classList.contains('kb-pre') && kbLast.bg) {
      kbLast.bg = ''; html.style.removeProperty('--kb-bg');
    }
    if (!on) kbToolCol = '';
    // 工具里也知道键盘在不在：键盘盖住了 iPhone 底下那条横条，工具不用再给它留白（天启的 --sb）
    var root = kbRoot();
    if (!root) return;
    if (tqIOSKeyboard()) {
      if (on && !root.classList.contains('kb-up')) tqSafeBottom = parseFloat(getComputedStyle(root).getPropertyValue('--tq-safe-bottom')) || 0;
      var ov = on && overlap < tqSafeBottom ? Math.round(overlap * 2) / 2 : null;
      if (kbLast.overlap !== ov) {
        kbLast.overlap = ov;
        // 覆盖整个安全区以后保持 0px 留白，免得每帧改 iframe 里的 CSS 变量。
        if (ov != null) root.style.setProperty('--tq-kb-overlap', ov + 'px');
        else root.style.removeProperty('--tq-kb-overlap');
      }
    }
    if (root.classList.contains('kb-up') !== on) root.classList.toggle('kb-up', on);
  }
  /* 站长 11-21 15:08 真 iPhone 录屏（#203 上线后复测）及 11-23 卡顿排查：
     1. 外壳从焦点起照真机录屏曲线（KB_OPEN / KB_CLOSE，Fritsch-Carlson 单调三次插值，消除 60/120Hz 折点速度突变）逐帧推进面板高度。
     2. 记住相对键盘高度 kbHeight（full - target，同步到 sessionStorage），地址栏显隐变化时仍对准键盘顶，且同会话后续打开首次即跟随。
     3. 只有系统连续报出 2 个以上中间高度才算跟手拖拽收起；键盘变矮（如收起预测栏）的单步 resize 走平滑改目标，不再一帧跳变。
     4. 收起后加单调保护窗口（参考 caelinsutch/keyboard-playground.html）：若 Safari 晚于 210ms 才把 visualViewport 恢复满屏，不再把输入框拽回半空。
     5. 缓存内联样式避免每帧重复写 DOM/CSS 变量，并通过 html.kb-anim 通知天启在动画的 210–382ms 内暂停夜空重绘，把帧预算全让给键盘跟随。 */
  var KB_OPEN = [[0, 0], [15, .116], [32, .244], [48, .391], [65, .513], [82, .619], [98, .712], [115, .783], [132, .842], [148, .882], [165, .914],
    [182, .937], [198, .954], [215, .967], [232, .977], [248, .983], [265, .988], [282, .992], [298, .994], [332, .997], [382, 1]];
  var KB_CLOSE = [[0, 0], [3, .017], [20, .115], [36, .265], [53, .404], [70, .534], [86, .637], [103, .722], [120, .793], [136, .847], [153, .889],
    [170, .916], [186, .94], [210, 1]];
  // Fritsch-Carlson 单调三次样条切线：经过所有实测节点、严格单调无回弹、120Hz 高刷屏下无速度折点
  function kbTangents(tab) {
    var n = tab.length, d = [], m = new Array(n);
    for (var i = 0; i < n - 1; i++) d[i] = (tab[i + 1][1] - tab[i][1]) / (tab[i + 1][0] - tab[i][0]);
    m[0] = d[0]; m[n - 1] = d[n - 2];
    for (var j = 1; j < n - 1; j++) m[j] = (d[j - 1] * d[j] <= 0) ? 0 : (d[j - 1] + d[j]) * .5;
    for (var k = 0; k < n - 1; k++) {
      if (!d[k]) { m[k] = m[k + 1] = 0; continue; }
      var a = m[k] / d[k], b = m[k + 1] / d[k], s = a * a + b * b;
      if (s > 9) { var t = 3 / Math.sqrt(s); m[k] = t * a * d[k]; m[k + 1] = t * b * d[k]; }
    }
    return m;
  }
  var KB_OPEN_M = kbTangents(KB_OPEN), KB_CLOSE_M = kbTangents(KB_CLOSE);
  var KB_LATE_OPEN = 48, KB_LATE_CLOSE = 55;   // visualViewport 比键盘晚到多少 ms（11:56 与 15:08 两段录屏量到 40~104ms，取模型值）
  var kbAnim = null, kbHeight = 0, kbSession = false, kbPending = false, kbClosingUntil = 0;
  function kbHeightKey() { return 'lm.kb.h:' + screen.width + 'x' + screen.height + ':' + innerWidth; }
  function loadKbHeight() {
    if (kbHeight > 0) return kbHeight;
    var k = kbHeightKey();
    try {
      var v = parseFloat(sessionStorage.getItem(k) || localStorage.getItem(k) || '');
      if (v >= 120 && v < innerHeight - 120) kbHeight = v;
    } catch (e) {}
    return kbHeight;
  }
  function saveKbHeight(h) {
    if (!(h >= 120 && h < innerHeight - 120)) return;
    kbHeight = h;
    var k = kbHeightKey(), s = String(Math.round(h));
    try { sessionStorage.setItem(k, s); } catch (e) {}
    try { localStorage.setItem(k, s); } catch (e) {}
  }
  function kbOpenTarget(full) { var kh = loadKbHeight(); return kh ? Math.max(180, full - kh) : 0; }
  function kbCurve(tab, tan, ms) {
    if (ms <= 0) return 0;
    var last = tab.length - 1;
    if (ms >= tab[last][0]) return 1;
    for (var i = 1; i <= last; i++) if (ms <= tab[i][0]) {
      var x0 = tab[i - 1][0], x1 = tab[i][0], h = x1 - x0, u = (ms - x0) / h, u2 = u * u, u3 = u2 * u;
      return (2 * u3 - 3 * u2 + 1) * tab[i - 1][1] + (u3 - 2 * u2 + u) * h * tan[i - 1] + (-2 * u3 + 3 * u2) * tab[i][1] + (u3 - u2) * h * tan[i];
    }
    return 1;
  }
  function kbAnimAt(a, now) {
    var open = a.dir === 'open', tab = open ? KB_OPEN : KB_CLOSE, tan = open ? KB_OPEN_M : KB_CLOSE_M;
    var elapsed = now - a.t0 + a.phase, start = a.phase ? kbCurve(tab, tan, a.phase) : 0;
    var progress = Math.max(0, Math.min(1, (kbCurve(tab, tan, elapsed) - start) / (1 - start)));
    return { h: a.fromH + (a.toH - a.fromH) * progress, progress: progress, done: elapsed >= tab[tab.length - 1][0] };
  }
  function stageH() { var sh = parseFloat(stage.style.height); return sh > 0 ? sh : stage.getBoundingClientRect().height; }
  function kbStart(dir, fromH, toH, t0, phase) {
    kbAnim = { dir: dir, fromH: fromH, toH: toH, t0: t0, phase: phase || 0, vvPrev: -1, vvSteps: 0 };
    if (dir === 'open') kbClosingUntil = 0;
    else kbClosingUntil = t0 + 480;
    kbSyncAnim(true);
    settleStage();
  }
  function tqIOSKeyboard() { return isIOS && current === 'tianqi'; }
  function kbStartLate(dir, fromH, toH, now, delay) {
    // Safari 可能只在键盘移动后报告一次高度。从此刻画出来的高度走完剩下的曲线，避免把已过去的那段位移补成一跳。
    if (tqIOSKeyboard()) kbStart(dir, fromH, toH, now, delay);
    else kbStart(dir, fromH, toH, now - delay);
  }
  function kbPlace(vv, h, full) {
    var s = stage.style, top = Math.max(0, Math.round(vv.offsetTop)), rh = Math.round(h);
    if (kbLast.top !== top) { kbLast.top = top; s.top = top + 'px'; }
    if (kbLast.h !== rh) { kbLast.h = rh; s.height = rh + 'px'; s.bottom = 'auto'; }
    kbCover(true, Math.max(0, full - rh));
  }
  function kbRestore() {
    var s = stage.style;
    if (kbLast.top !== null || kbLast.h !== null || s.height || s.top || s.bottom) {
      kbLast.top = kbLast.h = null;
      s.top = s.height = s.bottom = '';
    }
    kbCover(false);
    kbSyncAnim(false);
  }
  function kbFocus(opening, e) {
    if (!lite) return;
    var now = performance.now(), openTo = kbOpenTarget(innerHeight);
    if (opening) {
      kbSession = true; kbClosingUntil = 0;
      if (kbAnim && kbAnim.dir === 'open') return;
      if (kbAnim && kbAnim.dir === 'close') {   // 收起一半又点回来：从眼下的高度转头往上走
        if (openTo) kbStart('open', tqIOSKeyboard() ? stageH() : kbAnimAt(kbAnim, now).h, openTo, now); else kbPending = true;
        return;
      }
      if (html.classList.contains('kb-up')) return;   // 键盘已经升着（只是换了个输入框），不用重走一遍
      if (openTo) kbStart('open', stageH(), openTo, now);
      else kbPending = true;   // 还不知道这台机器的键盘多高，等 visualViewport 给值
    } else {
      kbPending = false;
      if (e && e.relatedTarget && typingEl(e.relatedTarget)) return;   // 只是换了个输入框，键盘不收
      kbSession = false;
      var h = kbAnim && !tqIOSKeyboard() ? kbAnimAt(kbAnim, now).h : stageH();
      if (h < innerHeight - 2) kbStart('close', h, innerHeight, now);
      else { kbAnim = null; kbSyncAnim(false); }
    }
  }
  function fitStage(ts) {
    var vv = window.visualViewport;
    if (!vv || !lite || !current || Math.abs((vv.scale || 1) - 1) > 0.01) { kbAnim = null; kbClosingUntil = 0; kbRestore(); return; }
    var full = innerHeight, target = vv.height, now = typeof ts === 'number' ? ts : performance.now();
    if (kbAnim) {
      var lo = Math.min(kbAnim.fromH, kbAnim.toH), hi = Math.max(kbAnim.fromH, kbAnim.toH);
      // 只有系统连续报出 2 个以上不同的中间高度（真正的跟手拖拽收起）才让位；单步变化（如键盘高度改变 360→310）走下面的平滑改目标
      var inMid = target > lo + 2 && target < hi - 2;
      if (inMid) {
        if (kbAnim.vvPrev >= 0 && Math.abs(target - kbAnim.vvPrev) > 2) kbAnim.vvSteps++;
        kbAnim.vvPrev = target;
      }
      if (inMid && (kbAnim.dir === 'close' || kbAnim.vvSteps >= 2)) { kbAnim = null; kbSyncAnim(false); }
      else if (kbAnim.dir === 'open' && target < full - 1 && Math.abs(target - kbAnim.toH) > 1) {
        // visualViewport 报出的键盘高度和记下的不一样：从画面当前高度无缝改奔新终点，resize 当刻 0px 跳变且不插队重排
        saveKbHeight(full - target);
        var curH = stageH(), at = kbAnimAt(kbAnim, now), p = at.progress;
        if (p < .95) { kbAnim.fromH = (curH - target * p) / (1 - p); kbAnim.toH = target; at = kbAnimAt(kbAnim, now); }
        else { kbAnim = null; kbSyncAnim(false); }
        if (kbAnim) {
          if (at.done) { kbAnim = null; kbSyncAnim(false); }
          else { kbPlace(vv, at.h, full); return; }
        }
      } else {
        var at2 = kbAnimAt(kbAnim, now);
        if (!at2.done && !(kbAnim.dir === 'close' && full - at2.h < 0.5)) { kbPlace(vv, at2.h, full); return; }
        var finishedClose = kbAnim.dir === 'close';
        kbAnim = null; kbSyncAnim(false);   // 跟随走完了，下面按 visualViewport 的现值对齐
        // 收起动画走完但 Safari 还没更新 visualViewport.height：保持满屏，不被旧高度拽回半空
        if (finishedClose && target < full - 1 && !kbSession && !typingNow()) {
          kbClosingUntil = now + 450;
          kbRestore();
          return;
        }
      }
    }
    // 只在触屏、工具开着、没在放大、可见区域确实比窗口矮（键盘）的时候跟；别的时候回到铺满
    if (target >= full - 1) {
      kbClosingUntil = 0;
      if (kbSession) {
        var h0 = stageH();
        if (h0 < full - 2) {
          // 系统可以收起键盘而让 textarea 保留焦点。用视口恢复作为收起信号，并结束这次键盘会话。
          kbSession = false; kbStartLate('close', h0, full, now, KB_LATE_CLOSE); fitStage(now); return;
        }
      }
      kbRestore();
      if (!typingNow()) kbSession = false;
      return;
    }
    // 刚收起完等待 Safari 迟到的 visualViewport 恢复：单调保持满屏，不回弹
    if (!kbSession && !typingNow() && now < kbClosingUntil) { kbRestore(); return; }
    saveKbHeight(full - target);
    if (typingNow()) kbSession = true;
    if (kbPending) {
      kbPending = false; kbStartLate('open', tqIOSKeyboard() ? stageH() : full, target, now, KB_LATE_OPEN); fitStage(now); return;
    }
    kbPlace(vv, target, full);
  }
  /* iOS 键盘弹出、收起时 visualViewport 不一定发事件（WebKit 198347、WICG visual-viewport #79；iOS 26 收起后 offsetTop 不归零，WebKit 297779）。
     站长 11-20 第三次截图：点天启的输入框，键盘出来了输入框却被挡住，打一个字（iOS 为了露出光标挪了一下可见区域）才跳上来。
     照 Element（hydrogen-web #181）按 visualViewport 的值自己定高度：工具里的输入框获得、失去焦点后，逐帧跟 1 秒，键盘动画在这段时间里走完。 */
  var settleUntil = 0, settleRaf = 0;
  function settleStage() {
    settleUntil = Math.max(settleUntil, performance.now() + 1000);
    if (settleRaf) return;
    (function tick(ts) {
      var now = typeof ts === 'number' ? ts : performance.now();
      fitStage(now);
      if (kbAnim && now + 500 > settleUntil) settleUntil = now + 500;
      settleRaf = now < settleUntil ? requestAnimationFrame(tick) : 0;
      // 键盘收起、动画走完、焦点也不在输入框上了，才把预先换好的整页底色还回去
      if (!settleRaf) {
        kbSyncAnim(false);
        if (!html.classList.contains('kb-up') && !typingNow()) kbPre(false);
      }
    })();
  }
  function typingNow() { try { var p = current && panels[current]; return !!p && typingEl(p._frame.contentDocument.activeElement); } catch (e) { return false; } }
  function typingEl(el) { return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)); }
  function watchFrame(f) {
    try {
      var d = f.contentDocument; if (!d || d.__kbWatch) return; d.__kbWatch = true;
      var on = function (e) { if (!typingEl(e.target)) return; if (e.type === 'focusin') { if (lite) kbPre(true); kbFocus(true, e); } else kbFocus(false, e); settleStage(); };
      d.addEventListener('focusin', on, true); d.addEventListener('focusout', on, true);
      if (isIOS) focusInPlace(d);
    } catch (e) { /* 别的源：没法跟，只靠 visualViewport 的事件 */ }
  }
  /* 站长 11-21 10:07 iPhone（4G）：有字的对话点输入框，「一点也不丝滑，上去的时候会弹一下」。
     做法照 frizynn/nenu #173（useFocusInPlace）和 React Aria #8888：WebKit 对带 preventScroll 的 focus 不做整页挪动。
     手指点没获得焦点的输入框（或输入框外框 .tq-entry 的空白处），由我们自己 focus({ preventScroll: true })，页面一点不挪。 */
  function focusInPlace(d) {
    var start = null;
    function editable(el) { return !!el && !el.disabled && !el.readOnly && (el.isContentEditable || el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && /^(text|search|email|url|tel|password|number|)$/.test(el.type || ''))); }
    function resolveTarget(t) {
      if (editable(t)) return t;
      if (!t || !t.closest || t.closest('button, a, select, input, label, [role=button]')) return null;
      var entry = t.closest('.tq-entry, .tq-box');
      if (!entry) return null;
      var ta = entry.querySelector('textarea');
      return editable(ta) ? ta : null;
    }
    d.addEventListener('touchstart', function (e) { var t = e.touches[0]; start = e.touches.length === 1 ? [t.clientX, t.clientY] : null; }, { capture: true, passive: true });
    d.addEventListener('touchmove', function (e) {
      var t = e.touches[0];
      if (start && t && (Math.abs(t.clientX - start[0]) > 10 || Math.abs(t.clientY - start[1]) > 10)) start = null;
      // 键盘打开期间只让内部滚动容器自己滚，阻止 Safari 把外层页面/iframe 橡皮筋拖动（参考 caelinsutch/keyboard-playground.html）
      if (e.touches.length !== 1 || !html.classList.contains('kb-up')) return;
      var vv = window.visualViewport;
      if (vv && Math.abs((vv.scale || 1) - 1) > 0.01) return;
      var sc = e.target && e.target.closest ? e.target.closest('.xc-body, .xc-dr-sc, .tq-pane, .tq-set-body, .xc-pal-l, .xc-sh-list, .tq-r-head, .xc-sh-hd, pre, .xc-tbl, textarea, input') : null;
      if (!sc || (sc.tagName === 'TEXTAREA' && sc.scrollHeight <= sc.clientHeight + 1)) e.preventDefault();
    }, { capture: true, passive: false });
    d.addEventListener('touchend', function (e) {
      var tap = start; start = null;
      if (!tap || e.touches.length) return;
      var el = resolveTarget(e.target);
      if (!el) return;
      if (el === d.activeElement) {
        // 系统收键盘后，原输入框可能仍有焦点；再点它时不会收到 focusin。
        if (tqIOSKeyboard() && (!html.classList.contains('kb-up') || (kbAnim && kbAnim.dir === 'close'))) {
          kbFocus(true, e); settleStage();
        }
        return;
      }
      e.preventDefault();   // 不让系统自己 focus（它会挪整页）；配合 Searls 屏外位移护栏彻底阻止 iframe 内 WebKit 异步滚屏
      var prevTf = el.style.transform;
      el.style.transform = 'translateY(-8000px)';
      el.focus({ preventScroll: true });
      setTimeout(function () { if (prevTf) el.style.transform = prevTf; else el.style.removeProperty('transform'); }, 0);
      if (!el.isContentEditable) try { var n = el.value.length; el.setSelectionRange(n, n); } catch (err) { /* number 之类不支持 */ }
    }, { capture: true, passive: false });
  }
  addEventListener('orientationchange', function () { kbAnim = null; kbClosingUntil = 0; kbHeight = 0; kbSyncAnim(false); });
  new MutationObserver(function () { pinHome(body.classList.contains('locked')); fitStage(); }).observe(body, { attributes: true, attributeFilter: ['class'] });
  addEventListener('scroll', function () { if (html.classList.contains('home-pin') && window.scrollY) window.scrollTo(0, 0); }, { passive: true });
  if (window.visualViewport) { visualViewport.addEventListener('resize', function () { fitStage(); }); visualViewport.addEventListener('scroll', function () { fitStage(); }); }
  function clip(r) {
    if (!r) return 'inset(0px 0px 0px 0px round 0px)';
    return 'inset(' + r.top + 'px ' + (innerWidth - r.right) + 'px ' + (innerHeight - r.bottom) + 'px ' + r.left + 'px round 12px)';
  }
  function setClip(p, v) { if (lite) v = ''; p.style.clipPath = v; p.style.webkitClipPath = v; }
  /* iframe 地址：embed=1 放最前；当前地址栏就是这个工具的路由时（深链 /stm32?tab=code），把 location.search 透传进去 */
  function frameSrc(t, route) {
    var extra = route || '';
    if (!extra && location.pathname.replace(/\/+$/, '') === t.path.replace(/\/+$/, '') && location.search.length > 1) {
      try { var sp = new URLSearchParams(location.search); sp.delete('embed'); extra = sp.toString(); } catch (e) { extra = ''; }
    }
    return t.src + (t.src.indexOf('?') > -1 ? '&' : '?') + 'embed=1' + (extra ? '&' + extra : '');
  }
  function post(p, msg) { try { p._frame.contentWindow.postMessage(msg, location.origin); } catch (e) {} }
  // 工具被关掉时：让 iframe 收起所有子视图（查看器等），下次打开从干净状态开始
  function resetFrame(p) { if (!p) return; p._depth = 0; p.classList.remove('deep'); p._pendingBack = false; clearTimeout(p._pbT); post(p, { type: 'reset' }); }
  function getPanel(t, route) {
    if (panels[t.id]) return panels[t.id];
    var p = document.createElement('section');
    p.className = 'panel'; p.setAttribute('aria-label', t.name); p.dataset.id = t.id;
    var f = document.createElement('iframe');
    f.title = t.name; f.allow = 'geolocation; fullscreen; clipboard-write'; f.src = frameSrc(t, route);
    var splash = document.createElement('div'); splash.className = 'splash';
    splash.appendChild(iconBox(t));
    var bk = document.createElement('button'); bk.className = 'back'; bk.type = 'button'; bk.setAttribute('aria-label', '返回');
    bk.appendChild(svg(BACK));
    // 回工具箱：工具里点进了好几层时，不用一层层退，一下回到首页（宽屏上学习台开着就一直显示在返回键旁边）
    var hb = document.createElement('button'); hb.className = 'home-b'; hb.type = 'button'; hb.setAttribute('aria-label', '回到工具箱'); hb.title = '回到工具箱';
    hb.appendChild(svg(HOUSE));
    var edge = document.createElement('div'); edge.className = 'edge';
    p.appendChild(f); p.appendChild(splash); p.appendChild(bk); p.appendChild(hb); p.appendChild(edge);
    pressable(bk); pressable(hb);
    bk.addEventListener('click', back);
    hb.addEventListener('click', goHome);
    var readyTimer = setTimeout(function () { p.classList.add('ready'); }, 6000);
    f.addEventListener('load', function () {
      p._depth = 0; p.classList.remove('deep'); watchFrame(f); paintFrameBg(p);
      try {
        var de = f.contentDocument && f.contentDocument.documentElement;
        if (de) {
          p.dataset.frameTheme = de.dataset.theme || '';
          new MutationObserver(function () { p.dataset.frameTheme = de.dataset.theme || ''; paintFrameBg(p); }).observe(de, { attributes: true, attributeFilter: ['data-theme'] });
        }
      } catch (e) {}
      setTimeout(function () { p.classList.add('ready'); clearTimeout(readyTimer); }, 2500);
    });
    p._frame = f; p._ready = function () { clearTimeout(readyTimer); p.classList.add('ready'); };
    edgeSwipe(p);
    stage.appendChild(p); panels[t.id] = p;
    return p;
  }
  window.addEventListener('message', function (e) {
    if (e.origin !== location.origin || !e.data) return;
    for (var id in panels) if (panels[id]._frame.contentWindow === e.source) {
      var p = panels[id], ty = e.data.type;
      if (ty === 'ready') p._ready();
      if (ty === 'route' && id === 'stm32' && window.STM32StudyCore && typeof e.data.params === 'string' && e.data.params.length < 1600) {
        p._route = window.STM32StudyCore.params(window.STM32StudyCore.fromParams(e.data.params));
        ls('lm.shell.stm32', p._route);
        if (current === id) try { history.replaceState(history.state, '', byId[id].path + (p._route ? '?' + p._route : '')); } catch (err) {}   // 浏览器限流时只是地址没更新，不影响后面的消息处理
      }
      if (ty === 'back' && current === id) back();
      // 工具要求整体关闭（如查看器未开时在 iframe 内按 Escape）
      if (ty === 'close' && current === id) { p._depth = 0; back(); }
      // 工具内部有下一层页面（查看器、任务详情）时报告 depth>0，返回键先交给工具自己退一层
      if (ty === 'depth') onDepth(id, p, Math.max(0, Number(e.data.depth) || 0));
    }
  });
  /* depth 变化同步到历史：0→N 时压一条 {tool,sub:1}，系统/浏览器返回先落在它上面（popstate 里转发 back 给工具）；
     工具自己关掉子视图（N→0）时，把这条 sub 记录退掉，保证再按一次返回就是关闭工具 */
  /* N2：history.back() 是异步的。同一事件循环里「关子视图 → 立即开新的」时，depth 1 到达时 history.state 仍是 sub，
     不能据此跳过 pushState，更不能让随后落到 {tool} 的 popstate 把 back 转发给工具。
     所以 back() 前记 _pendingBack；popstate 落到 {tool} 时先消费它（不转发 back），若此时又有子视图（_depth>0）就补压一条 sub。
     兜底：约 1s 内 popstate 没来也自动解除，按当前 state 补救。 */
  function clearPending(p) { p._pendingBack = false; clearTimeout(p._pbT); }
  function pendBack(id, p) {
    p._pendingBack = true; clearTimeout(p._pbT);
    p._pbT = setTimeout(function () {
      if (!p._pendingBack) return;
      p._pendingBack = false;
      var st = history.state || {};
      if (current !== id || st.tool !== id) return;
      if (st.sub) return;                             // back 根本没发生：sub 还在，与 depth>0 一致；depth 0 时下次返回会被 popstate 清掉
      stripTop();
      if (p._depth > 0) history.pushState({ tool: id, sub: 1 }, '');
    }, 1000);
    history.back();
  }
  /* N3：子视图关闭后去掉顶层地址里的深链参数 page / cw（保留路径、其他参数、hash 和当前 state 对象），刷新不会自动重开 */
  function stripTop() {
    try {
      var sp = new URLSearchParams(location.search);
      if (!sp.has('page') && !sp.has('cw')) return;
      sp.delete('page'); sp.delete('cw');
      var qs = sp.toString();
      history.replaceState(history.state, '', location.pathname + (qs ? '?' + qs : '') + location.hash);
    } catch (e) {}
  }
  function onDepth(id, p, d) {
    var prev = p._depth || 0; p._depth = d; p.classList.toggle('deep', d > 0);
    if (current !== id) return;
    var st = history.state || {};
    if (p._pendingBack) return;                       // 返回进行中：等 popstate 落地后统一处理
    if (d > 0 && prev === 0 && st.tool === id && !st.sub) history.pushState({ tool: id, sub: 1 }, '');
    else if (d === 0 && prev > 0) {
      if (st.tool === id && st.sub) pendBack(id, p);  // 地址在 popstate 落到 {tool} 后再清
      else stripTop();
    }
  }

  /* 卡片的「真实」位置：关闭时首页还处在 scale(.94) 的过渡起点，直接量出来的是缩小后的矩形。
     这里读出 #home 当前的实际变换矩阵，反算出复原后（scale 1）的卡片位置，面板收拢到卡片最终所在处。 */
  function unscale(r) {
    var m = getComputedStyle(home).transform;
    if (!m || m === 'none') return r;
    var v = m.match(/matrix\(([^)]+)\)/); if (!v) return r;
    v = v[1].split(',').map(parseFloat);
    var a = v[0], d = v[3]; if (!a || !d) return r;
    // 变换原点 50% 30%（与 CSS 一致），按未变换的盒子计算
    var ox = home.offsetLeft - window.scrollX + home.offsetWidth * 0.5;
    var oy = home.offsetTop - window.scrollY + home.offsetHeight * 0.3;
    var tx = v[4], ty = v[5];
    function X(x) { return ox + (x - ox - tx) / a; }
    function Y(y) { return oy + (y - oy - ty) / d; }
    var L = X(r.left), R = X(r.right), T = Y(r.top), B = Y(r.bottom);
    return { left: L, right: R, top: T, bottom: B, width: R - L, height: B - T };
  }
  function cardFor(id) {
    var el = null;
    grid.querySelectorAll('.card[data-id]:not(.hide)').forEach(function (c) { if (c.dataset.id === id) el = c; });
    if (!el) return null; var r = unscale(el.getBoundingClientRect());
    return (r.bottom > 0 && r.top < innerHeight) ? r : null;
  }

  // 每个面板自己的定时器，快速连续开关时先清掉旧的
  function clearTimers(p) { (p._t || []).forEach(clearTimeout); p._t = []; }
  function later(p, fn, ms) { (p._t = p._t || []).push(setTimeout(fn, ms)); }
  // 系统手势（Safari 右滑返回/前进）后直接落到终态：两帧内禁用过渡，画面与 Safari 的快照一致
  function snap() {
    body.classList.add('snap'); void body.offsetWidth;
    requestAnimationFrame(function () { requestAnimationFrame(function () { body.classList.remove('snap'); }); });
  }

  /* 面板彻底复位（幂等）：去掉所有状态类和内联样式；未 .show 的面板是 display:none，合成层被销毁。 */
  // 首页被面板完全盖住后隐藏首页（只在桌面端）；触屏端首页常驻可见，避免 iOS 重新合成整页
  function coverHome() { if (!lite) body.classList.add('covered'); }
  function park(p) {
    if (!p) return;
    clearTimers(p); p._closing = false;
    if (p._te) { p.removeEventListener('transitionend', p._te); p._te = null; }
    p.classList.remove('show', 'anim', 'opened', 'cover', 'fade', 'l-in', 'l-out', 'closing');
    p.style.transform = ''; p.style.opacity = ''; setClip(p, clip());
  }
  // 首页复位：去掉打开工具时加的类、所有按压残留
  function clearPress() { document.querySelectorAll('.press').forEach(function (c) { c.classList.remove('press'); }); }
  function resetHome() {
    body.classList.remove('tool-open', 'locked', 'covered');
    clearPress();
  }
  // 把所有「非当前、且不在收拢动画中」的面板复位；没有当前工具时同时复位首页
  function settle() {
    for (var k in panels) if (k !== current && !panels[k]._closing) park(panels[k]);
    if (!current) {
      resetHome();
      if (!q.value && !home.classList.contains('searching')) refreshHome();
      // 触屏：所有面板都已收起时，让 #stage 重建一次渲染树，确保 WebKit 丢掉任何旧的合成层
      if (lite && !stage.querySelector('.panel.show')) { stage.style.display = 'none'; void stage.offsetHeight; stage.style.display = ''; }
    }
  }

  // 首页「定格」：去掉所有按压态，并在定格期间禁用首页过渡，让被点击的卡片立即回到终态
  function freezeHome() {
    body.classList.add('freeze');
    clearPress();
    if (document.activeElement && document.activeElement.blur && document.activeElement !== q) document.activeElement.blur();
    void body.offsetWidth;                         // 强制 reflow，终态立即生效
  }

  function open(id, o) {
    var t = byId[id]; if (!t) return;
    o = o || {};
    if (current === id) return;
    if (current) close({ instant: true });
    var fresh = !panels[id], p = getPanel(t, o.route); park(p);   // 先彻底复位（可能还在上一次收拢动画中）
    if (fresh && o.route) p._route = o.route;          // 从「继续」进来：地址栏直接带上上次的位置
    current = id; touchRecent(id);
    document.title = t.name + ' · Liming 工具箱';
    var r = o.from ? o.from.getBoundingClientRect() : null;
    freezeHome();
    if (o.push && lite && !o.instant) {
      /* iOS 系统返回手势用的是 pushState 时「屏幕上最后一帧」的快照。
         先让定格后的首页真正画出来（两帧），再 pushState，然后才开始面板动画：
         快照里的首页 = 返回后的真实首页（无按压缩放），逐像素一致。延迟约 30ms，肉眼不可察觉。 */
      requestAnimationFrame(function () { requestAnimationFrame(function () {
        if (current !== id) { body.classList.remove('freeze'); return; }
        history.pushState({ tool: id }, '', t.path);
        body.classList.remove('freeze');
        run();
      }); });
      return;
    }
    if (o.push) history.pushState({ tool: id }, '', t.path);
    body.classList.remove('freeze');
    run();

    function run() {
      if (id === 'stm32' && p._route) history.replaceState(history.state, '', t.path + '?' + p._route);
      if (o.instant || reduce || !r) {
        if (o.instant) snap();
        body.classList.add('tool-open', 'locked');
        setClip(p, clip());
        p.classList.add('show', 'opened');
        coverHome();
      } else if (lite) {
        // 触屏：面板整块从下方轻微上浮 + 淡入，不用 clip-path，也不加 .cover
        body.classList.add('tool-open', 'locked');
        p.classList.add('show', 'l-in');
        void p.offsetWidth;                         // 以 l-in（透明、下移）作为过渡起点
        requestAnimationFrame(function () { if (current !== id) return; p.classList.add('fade'); p.classList.remove('l-in'); });
        later(p, function () { p.classList.add('opened'); }, 200);
        later(p, function () {
          if (current !== id) return;
          p.classList.remove('fade');
          coverHome();
        }, 460);
      } else {
        body.classList.add('tool-open', 'locked');
        if (isIOS) p.classList.add('cover');        // 动画期间盖住 iframe，只对纯色启动页做 clip-path 动画
        setClip(p, clip(r));
        p.classList.add('show');
        void p.offsetWidth;                         // 以 clip(r) 作为过渡起点
        requestAnimationFrame(function () { if (current !== id) return; p.classList.add('anim'); setClip(p, clip()); });
        later(p, function () { p.classList.add('opened'); }, 300);
        later(p, function () {
          if (current !== id) return;
          p.classList.remove('anim', 'cover');      // 揭开 iframe（启动页 0.5s 淡出），去掉 will-change
          coverHome();                              // 首页完全被盖住：桌面端不再参与合成
        }, 620);
      }
    }
  }

  function close(o) {
    if (!current) return;
    o = o || {};
    var id = current, p = panels[id]; current = null; clearTimers(p);
    resetFrame(p);
    document.title = 'Liming 工具箱';
    if (o.instant || reduce) {
      if (o.instant) snap();
      resetHome(); park(p); return;
    }
    body.classList.remove('covered');
    if (lite) {
      // 触屏：关闭开始前先把启动页 display:none、去掉 .cover；然后整块淡出 + 轻微下移缩小，结束后 park() → display:none
      p._closing = true;
      p.classList.remove('cover', 'anim', 'l-in');
      p.classList.add('closing');
      body.classList.remove('tool-open', 'locked');
      void p.offsetWidth;
      p.classList.add('fade', 'l-out');
      var lfin = function () { if (current === id) return; park(p); settle(); };
      p._te = function (e) { if (e.target === p && e.propertyName === 'opacity') lfin(); };
      p.addEventListener('transitionend', p._te);
      later(p, lfin, 380);                           // 兜底：transitionend 没触发也一定复位
      setTimeout(function () { if (!current) { for (var k in panels) panels[k]._closing = false; settle(); } }, 1000);
      return;
    }
    var r = cardFor(id);                            // 在去掉 tool-open 之前量，再按实际变换反算
    body.classList.remove('tool-open', 'locked');
    p._closing = true;
    if (isIOS) p.classList.add('cover');
    p.classList.add('anim');
    if (r) setClip(p, clip(r)); else { p.style.transform = 'translateX(30%)'; p.style.opacity = '0'; }
    var fin = function () { if (current === id) return; park(p); settle(); };
    p._te = function (e) { if (e.target === p) fin(); };
    p.addEventListener('transitionend', p._te);     // 正常情况：动画结束即复位
    later(p, fin, 650);                             // 兜底：transitionend 没触发（iOS 常见）也一定复位
    setTimeout(function () { if (!current) { for (var k in panels) panels[k]._closing = false; settle(); } }, 1200);
  }

  function back() {
    if (!current) return;
    var cp = panels[current], st = history.state || {};
    if (cp && cp._depth > 0) {
      // 有 sub 记录：走历史返回，popstate 里再把 back 转给工具（历史与界面保持一致）
      if (st.tool === current && st.sub && !cp._pendingBack) { history.back(); return; }
      // 返回进行中（sub 已在退）或没有 sub：直接让工具退一层，popstate 落地时不会再补压
      cp._depth = 0; post(cp, { type: 'back' }); if (!cp._pendingBack) stripTop(); return;
    }
    var viaHistory = st.tool === current;
    var steps = st.sub && !(cp && cp._pendingBack) ? -2 : -1;   // 已在退 sub 时只再退一步
    if (cp) clearPending(cp);
    close();
    if (viaHistory) history.go(steps); else history.replaceState({}, '', '/');
  }

  // 直接关掉工具回首页：不管工具里点进了几层，历史退回到打开工具之前
  function goHome() {
    if (!current) return;
    var cp = panels[current], st = history.state || {};
    var viaHistory = st.tool === current, steps = st.sub && !(cp && cp._pendingBack) ? -2 : -1;
    if (cp) { clearPending(cp); cp._depth = 0; }
    close();
    if (viaHistory) history.go(steps); else history.replaceState({}, '', '/');
  }

  // 只按历史状态同步；自己调用 history.back() 时 current 已是 null，这里不会打断正在进行的收拢动画
  window.addEventListener('popstate', function (e) {
    if (edgeDrag) { ls('lm.nativeBack', '1'); html.classList.add('native-back'); edgeDrag = null; }
    var st = e.state || {}, id = st.tool;
    if (id && byId[id] && id === current) {
      var cp = panels[id];
      // 自己（onDepth）发出的 back 落地：消费标记、不转发；期间工具又开了子视图就补压一条 sub
      if (!st.sub && cp && cp._pendingBack) {
        clearPending(cp);
        stripTop();
        if (cp._depth > 0) history.pushState({ tool: id, sub: 1 }, '');
        return;
      }
      // 从 {tool,sub} 退回 {tool}：只关工具里的子视图（查看器），不关工具
      if (!st.sub && cp && cp._depth > 0) { cp._depth = 0; post(cp, { type: 'back' }); stripTop(); }
      // 前进到一条已失效的 sub 记录（子视图早已关闭）：退回去，不留空记录
      else if (st.sub && cp && !(cp._depth > 0)) history.back();
      else if (!st.sub) stripTop();
      return;
    }
    for (var pk in panels) clearPending(panels[pk]);
    if (id && byId[id]) open(id, { instant: true });
    else if (current) close({ instant: true });     // Safari 手势已经播过动画：直接到终态
    else settle();
  });

  // bfcache 恢复：按历史状态把一切摆到终态
  window.addEventListener('pageshow', function (e) {
    if (!e.persisted) return;
    var id = history.state && history.state.tool;
    if (id && id !== current) open(id, { instant: true });
    else if (!id && current) close({ instant: true });
    snap(); for (var k in panels) panels[k]._closing = false; settle();
  });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) settle(); });

  /* PWA 全屏模式下自己实现左缘滑动返回。
     - 只有面板在动：触屏端首页本来就是终态，面板下方直接露出
     - 先判定方向（横向 > 8px 且大于纵向）才开始拖，避免误触
     - touchcancel = 系统手势接管：立即无动画复位，不自己再做返回
     - 拖动期间如果收到 popstate，说明系统也有原生返回手势：记住，此后不再启用自定义手势 */
  var edgeDrag = null;
  function edgeSwipe(p) {
    var edge = p.querySelector('.edge'), x0 = 0, y0 = 0, dx = 0, on = false, moving = false;
    function rest(animated) {
      on = false; moving = false; if (edgeDrag === p) edgeDrag = null;
      if (!animated) { p.classList.remove('anim'); p.style.transform = ''; return; }
      var cur = current; p.classList.add('anim'); p.style.transform = '';
      later(p, function () { if (current === cur) { p.classList.remove('anim'); coverHome(); } }, 480);
    }
    edge.addEventListener('touchstart', function (e) {
      if (html.classList.contains('native-back') || !current) return;
      on = true; moving = false; dx = 0; x0 = e.touches[0].clientX; y0 = e.touches[0].clientY;
    }, { passive: true });
    edge.addEventListener('touchmove', function (e) {
      if (!on) return;
      var mx = e.touches[0].clientX - x0, my = e.touches[0].clientY - y0;
      if (!moving) {
        if (Math.abs(mx) < 8 && Math.abs(my) < 8) return;
        if (mx <= 0 || Math.abs(my) > Math.abs(mx)) { on = false; return; }     // 不是向右的横滑：放弃
        moving = true; edgeDrag = p; clearTimers(p);
        p.classList.remove('anim', 'cover', 'fade', 'l-in'); body.classList.remove('covered');
        if (!lite) body.classList.remove('tool-open');                           // 桌面端也让首页直接以终态露出
      }
      if (e.cancelable) e.preventDefault();                                     // 拖动开始后独占这次触摸
      dx = Math.max(0, mx);
      p.style.transform = 'translate3d(' + dx + 'px,0,0)';
    }, { passive: false });
    edge.addEventListener('touchend', function () {
      if (!on) return;
      if (!moving) { on = false; return; }
      on = false; moving = false; if (edgeDrag === p) edgeDrag = null;
      if (dx > innerWidth * 0.3 && current) {
        var id = current, pend = p._pendingBack; current = null; p._closing = true;
        resetFrame(p);
        p.classList.add('anim'); p.style.transform = 'translate3d(100%,0,0)';
        body.classList.remove('tool-open', 'locked', 'covered');
        document.title = 'Liming 工具箱';
        var hs = history.state || {};
        if (hs.tool === id) history.go(hs.sub && !pend ? -2 : -1);                       // 系统手势已经返回过就不再返回一次
        later(p, function () { if (current !== id) { park(p); settle(); } }, 480);
        setTimeout(function () { if (!current) { for (var k in panels) panels[k]._closing = false; settle(); } }, 1200);
      } else {
        if (!lite) body.classList.add('tool-open');
        rest(true);
      }
    });
    edge.addEventListener('touchcancel', function () { if (on || moving) rest(false); });
  }

  /* 初始路由 */
  var path = location.pathname.replace(/\/+$/, '');
  var initial = byPath[path];
  if (initial) {
    // 先记下 search/hash：replaceState('/') 之后 location.search 就没了（深链 ?tab= / ?page= 靠它透传进 iframe）
    var qs0 = location.search, hash0 = location.hash;
    history.replaceState({}, '', '/');
    history.pushState({ tool: initial.id }, '', initial.path + qs0 + hash0);
    open(initial.id, { instant: true });
  } else if (path && path !== '/' && path !== '/index.html') {
    history.replaceState({}, '', '/');
  }
  // 首屏入场动画播完后彻底关掉 card 的 animation，之后任何重新合成、显示切换都不会再补播
  setTimeout(function () { html.classList.add('settled'); }, 1600);
  window.LimingShell = { open: open, back: back, tools: TOOLS };
})();
