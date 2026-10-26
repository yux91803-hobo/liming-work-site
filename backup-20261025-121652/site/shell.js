(function () {
  'use strict';
  var TOOLS = window.TOOLS || [];
  var $ = function (s) { return document.querySelector(s); };
  var html = document.documentElement, body = document.body;
  var byId = {}, byPath = {};
  TOOLS.forEach(function (t) { byId[t.id] = t; byPath[t.path.replace(/\/+$/, '')] = t; });
  var standalone = window.navigator.standalone === true || (window.matchMedia && matchMedia('(display-mode: standalone)').matches);
  if (standalone) html.classList.add('standalone');
  var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  var isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
  if (isIOS) html.classList.add('ios');
  // 路由切换时不让浏览器自动恢复滚动位置（会与手势返回的快照错位）
  try { if ('scrollRestoration' in history) history.scrollRestoration = 'manual'; } catch (e) {}
  function ls(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  /* ---------- 主题 ---------- */
  var mq = matchMedia('(prefers-color-scheme: dark)');
  function applyTheme() {
    var pref = ls('lm.theme') || 'light';
    var dark = pref === 'dark' || (pref === 'auto' && mq.matches);
    html.dataset.theme = dark ? 'dark' : 'light'; html.dataset.pref = pref;
    $('#themeColor').setAttribute('content', dark ? '#0d1117' : '#f5f6f8');
  }
  applyTheme();
  if (mq.addEventListener) mq.addEventListener('change', applyTheme);
  $('#themeBtn').addEventListener('click', function () {
    var order = ['light', 'dark', 'auto'], cur = ls('lm.theme') || 'light';
    var next = order[(order.indexOf(cur) + 1) % 3]; ls('lm.theme', next); applyTheme();
    toast({ light: '浅色', dark: '深色', auto: '跟随系统' }[next]);
    stage.querySelectorAll('iframe').forEach(function (f) { try { f.contentWindow.postMessage({ type: 'theme' }, location.origin); } catch (e) {} });
  });

  /* ---------- 首页渲染 ---------- */
  var grid = $('#grid');
  var ARROW = '<svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>';
  function vars(t) { return '--c1:' + t.color[0] + ';--c2:' + t.color[1]; }
  TOOLS.forEach(function (t, i) {
    var a = document.createElement('a');
    a.className = 'card'; a.href = t.path; a.dataset.id = t.id;
    a.setAttribute('style', vars(t) + ';--i:' + i);
    a.innerHTML = '<span class="ic">' + t.icon + '</span><span class="go">' + ARROW + '</span><span class="nm">' + esc(t.name) + '</span><span class="ds">' + esc(t.desc || '') + '</span>';
    grid.appendChild(a);
  });
  var soon = document.createElement('div');
  soon.className = 'card soon'; soon.setAttribute('style', '--c1:#999;--c2:#999;--i:' + TOOLS.length);
  soon.innerHTML = '<span class="ic"><svg viewBox="0 0 24 24"><path d="M12 6v12M6 12h12"/></svg></span><span class="nm">更多工具</span><span class="ds">即将上线</span>';
  grid.appendChild(soon);

  var recentKey = null;
  function renderRecent() {
    var ids = (ls('lm.recent') || '').split(',').filter(function (id) { return byId[id]; }).slice(0, 6);
    var key = ids.join(','); if (key === recentKey) return;     // 没变就不重建（避免返回时入场动画重播造成跳动）
    var first = recentKey === null; recentKey = key;
    var box = $('#recent'); box.innerHTML = '';
    ids.forEach(function (id, i) {
      var t = byId[id], a = document.createElement('a');
      a.className = 'chip'; a.href = t.path; a.dataset.id = id; a.setAttribute('style', vars(t));
      if (first) a.style.animationDelay = (i * 50) + 'ms'; else a.style.animation = 'none';
      a.innerHTML = '<span class="ic">' + t.icon + '</span>' + esc(t.name);
      box.appendChild(a);
    });
    $('#recentWrap').hidden = !ids.length;
  }
  renderRecent();
  function pushRecent(id) {
    var ids = (ls('lm.recent') || '').split(',').filter(function (x) { return x && x !== id; });
    ids.unshift(id); ls('lm.recent', ids.slice(0, 8).join(','));
  }

  /* 交互：按压 / 倾斜 / 光斑 */
  grid.addEventListener('pointerdown', function (e) { var c = e.target.closest('.card:not(.soon)'); if (c) c.classList.add('press'); });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (ev) {
    grid.addEventListener(ev, function () { grid.querySelectorAll('.press').forEach(function (c) { c.classList.remove('press'); }); }, true);
  });
  if (matchMedia('(hover:hover)').matches && !reduce) {
    grid.addEventListener('pointermove', function (e) {
      var c = e.target.closest('.card'); if (!c) return;
      var r = c.getBoundingClientRect(), x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
      c.style.setProperty('--mx', x * 100 + '%'); c.style.setProperty('--my', y * 100 + '%');
      c.style.setProperty('--ry', ((x - .5) * 8).toFixed(2) + 'deg'); c.style.setProperty('--rx', ((.5 - y) * 8).toFixed(2) + 'deg');
    });
    grid.addEventListener('pointerout', function (e) { var c = e.target.closest('.card'); if (c && !c.contains(e.relatedTarget)) { c.style.setProperty('--rx', '0deg'); c.style.setProperty('--ry', '0deg'); } });
  }
  document.addEventListener('click', function (e) {
    var a = e.target.closest('a[data-id]'); if (!a || e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault(); open(a.dataset.id, { from: a.querySelector('.ic') ? a : a, push: true });
  });

  /* 命令栏搜索 */
  var q = $('#q');
  function match(t, s) { return (t.name + ' ' + (t.desc || '') + ' ' + (t.keywords || '') + ' ' + t.id).toLowerCase().indexOf(s) > -1; }
  q.addEventListener('input', function () {
    var s = q.value.trim().toLowerCase(), n = 0;
    grid.querySelectorAll('.card[data-id]').forEach(function (c) { var ok = !s || match(byId[c.dataset.id], s); c.classList.toggle('hide', !ok); if (ok) n++; });
    soon.classList.toggle('hide', !!s); $('#empty').hidden = n > 0; $('#allTitle').textContent = s ? '结果' : '全部';
  });
  q.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { var c = grid.querySelector('.card[data-id]:not(.hide)'); if (c) { q.blur(); open(c.dataset.id, { from: c, push: true }); } }
    if (e.key === 'Escape') { q.value = ''; q.dispatchEvent(new Event('input')); q.blur(); }
  });
  document.addEventListener('keydown', function (e) {
    if (current) { if (e.key === 'Escape') back(); return; }
    if ((e.key === '/' || (e.key === 'k' && (e.metaKey || e.ctrlKey))) && document.activeElement !== q) { e.preventDefault(); q.focus(); }
  });

  /* ---------- 提示 ---------- */
  var tt;
  function toast(m) { var t = $('#toast'); t.textContent = m; t.classList.add('show'); clearTimeout(tt); tt = setTimeout(function () { t.classList.remove('show'); }, 1400); }

  /* ---------- 工具面板 & 路由 ---------- */
  var stage = $('#stage'), panels = {}, current = null;
  var BACK = '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>';
  function clip(r) {
    if (!r) return 'inset(0px 0px 0px 0px round 0px)';
    return 'inset(' + r.top + 'px ' + (innerWidth - r.right) + 'px ' + (innerHeight - r.bottom) + 'px ' + r.left + 'px round 24px)';
  }
  function setClip(p, v) { p.style.clipPath = v; p.style.webkitClipPath = v; }
  function getPanel(t) {
    if (panels[t.id]) return panels[t.id];
    var p = document.createElement('section');
    p.className = 'panel'; p.setAttribute('style', vars(t)); p.setAttribute('aria-label', t.name);
    p.innerHTML = '<div class="splash"><span class="ic">' + t.icon + '</span></div><button class="back" aria-label="返回">' + BACK + '</button><div class="edge"></div>';
    var f = document.createElement('iframe');
    f.title = t.name; f.allow = 'geolocation; fullscreen; clipboard-write'; f.src = t.src + (t.src.indexOf('?') > -1 ? '&' : '?') + 'embed=1';
    p.insertBefore(f, p.firstChild);
    p.querySelector('.back').addEventListener('click', back);
    var readyTimer = setTimeout(function () { p.classList.add('ready'); }, 6000);
    f.addEventListener('load', function () { setTimeout(function () { p.classList.add('ready'); clearTimeout(readyTimer); }, 2500); });
    p._frame = f; p._ready = function () { clearTimeout(readyTimer); p.classList.add('ready'); };
    edgeSwipe(p);
    stage.appendChild(p); panels[t.id] = p;
    return p;
  }
  window.addEventListener('message', function (e) {
    if (e.origin !== location.origin || !e.data) return;
    for (var id in panels) if (panels[id]._frame.contentWindow === e.source) {
      if (e.data.type === 'ready') panels[id]._ready();
      if (e.data.type === 'back') back();
    }
  });

  /* 卡片的「真实」位置：关闭时首页还处在 scale(.94) 的过渡起点，直接量出来的是缩小后的矩形。
     这里读出 #home 当前的实际变换矩阵，反算出复原后（scale 1）的卡片位置，面板收拢到卡片最终所在处。 */
  var home = $('#home');
  function unscale(r) {
    var m = getComputedStyle(home).transform;
    if (!m || m === 'none') return r;
    var v = m.match(/matrix\(([^)]+)\)/); if (!v) return r;
    v = v[1].split(',').map(parseFloat);
    var a = v[0], d = v[3]; if (!a || !d) return r;
    // 变换原点 50% 30%（与 CSS 一致），按未变换的盒子计算
    var ox = home.offsetLeft - window.scrollX + home.offsetWidth * 0.5;
    var oy = home.offsetTop - window.scrollY + home.offsetHeight * 0.3;
    var tx = v[4], ty = v[5];                     // computed transform 不含 transform-origin，e/f 就是额外位移（通常为 0）
    function X(x) { return ox + (x - ox - tx) / a; }
    function Y(y) { return oy + (y - oy - ty) / d; }
    var L = X(r.left), R = X(r.right), T = Y(r.top), B = Y(r.bottom);
    return { left: L, right: R, top: T, bottom: B, width: R - L, height: B - T };
  }
  function cardFor(id) {
    var el = document.querySelector('#grid .card[data-id="' + id + '"]:not(.hide)') || document.querySelector('#recent .chip[data-id="' + id + '"]');
    if (!el) return null; var r = unscale(el.getBoundingClientRect());
    return (r.bottom > 0 && r.top < innerHeight) ? r : null;
  }

  // 每个面板自己的定时器，快速连续开关时先清掉旧的
  function clearTimers(p) { (p._t || []).forEach(clearTimeout); p._t = []; }
  function later(p, fn, ms) { (p._t = p._t || []).push(setTimeout(fn, ms)); }
  // 系统手势（Safari 右滑返回/前进）后直接落到终态：两帧内禁用过渡，画面与 Safari 的快照一致，不再「补播」缩放动画
  function snap() {
    body.classList.add('snap'); void body.offsetWidth;
    requestAnimationFrame(function () { requestAnimationFrame(function () { body.classList.remove('snap'); }); });
  }

  /* 面板彻底复位（幂等，可重复调用）：去掉所有状态类和内联样式；CSS 里未 .show 的面板是 display:none，
     整个合成层被销毁，不可能再残留半截动画画面。transitionend、定时器、popstate、pageshow、回到前台都会触发，谁先到谁生效。 */
  function park(p) {
    if (!p) return;
    clearTimers(p); p._closing = false;
    if (p._te) { p.removeEventListener('transitionend', p._te); p._te = null; }
    p.classList.remove('show', 'anim', 'opened', 'cover');
    p.style.transform = ''; p.style.opacity = ''; setClip(p, clip());
  }
  // 首页复位：去掉打开工具时加的类、卡片按压/倾斜残留
  function resetHome() {
    body.classList.remove('tool-open', 'locked', 'covered');
    grid.querySelectorAll('.card').forEach(function (c) {
      c.classList.remove('press');
      c.style.removeProperty('--rx'); c.style.removeProperty('--ry'); c.style.removeProperty('--mx'); c.style.removeProperty('--my');
    });
  }
  // 把所有「非当前、且不在收拢动画中」的面板复位；没有当前工具时同时复位首页
  function settle() {
    for (var k in panels) if (k !== current && !panels[k]._closing) park(panels[k]);
    if (!current) resetHome();
  }

  function open(id, o) {
    var t = byId[id]; if (!t) return;
    o = o || {};
    if (current === id) return;
    if (current) close({ instant: true });
    var p = getPanel(t); park(p);                    // 先彻底复位（可能还在上一次收拢动画中）
    current = id; pushRecent(id);
    document.title = t.name + ' · Liming 工具箱';
    if (o.push) history.pushState({ tool: id }, '', t.path);
    var r = o.from ? o.from.getBoundingClientRect() : null;
    grid.querySelectorAll('.press').forEach(function (c) { c.classList.remove('press'); });
    if (o.instant || reduce || !r) {
      if (o.instant) snap();
      body.classList.add('tool-open', 'locked');
      setClip(p, clip());
      p.classList.add('show', 'opened');
      body.classList.add('covered'); renderRecent();
    } else {
      body.classList.add('tool-open', 'locked');
      if (isIOS) p.classList.add('cover');          // 动画期间盖住 iframe，只对纯色启动页做 clip-path 动画
      setClip(p, clip(r));
      p.classList.add('show');
      void p.offsetWidth;                           // 以 clip(r) 作为过渡起点
      requestAnimationFrame(function () { if (current !== id) return; p.classList.add('anim'); setClip(p, clip()); });
      later(p, function () { p.classList.add('opened'); }, 300);
      later(p, function () {
        if (current !== id) return;
        p.classList.remove('anim', 'cover');        // 揭开 iframe（启动页 0.5s 淡出），去掉 will-change
        body.classList.add('covered');              // 首页完全被盖住：不再参与合成
        renderRecent();                             // 首页不可见时更新「最近」，返回时不再重建
      }, 620);
    }
  }

  function close(o) {
    if (!current) return;
    o = o || {};
    var id = current, p = panels[id]; current = null; clearTimers(p);
    document.title = 'Liming 工具箱';
    if (o.instant || reduce) {
      if (o.instant) snap();
      resetHome(); park(p); return;
    }
    body.classList.remove('covered');
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
    setTimeout(function () { if (!current) { for (var k in panels) panels[k]._closing = false; settle(); } }, 1200);   // 再兜一层：不受 clearTimers 影响
  }

  function back() {
    if (!current) return;
    var viaHistory = !!(history.state && history.state.tool);
    close();
    if (viaHistory) history.back(); else history.replaceState({}, '', '/');
  }

  // 只按历史状态同步，不再用计数器忽略 popstate（计数一旦错位，后面的返回会被吞掉）。
  // 自己调用 history.back() 时 current 已是 null，这里不会打断正在进行的收拢动画。
  window.addEventListener('popstate', function (e) {
    var id = e.state && e.state.tool;
    if (id && byId[id]) { if (id !== current) open(id, { instant: true }); }
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

  /* PWA 全屏模式下没有浏览器返回手势，自己实现左缘滑动返回 */
  function edgeSwipe(p) {
    var edge = p.querySelector('.edge'), x0 = 0, dx = 0, on = false;
    edge.addEventListener('touchstart', function (e) {
      on = true; x0 = e.touches[0].clientX; dx = 0; clearTimers(p);
      p.classList.remove('anim', 'cover'); body.classList.remove('covered');   // 首页要在面板下方露出来
    }, { passive: true });
    edge.addEventListener('touchmove', function (e) {
      if (!on) return; dx = Math.max(0, e.touches[0].clientX - x0);
      p.style.transform = 'translateX(' + dx + 'px)'; body.classList.toggle('tool-open', dx < innerWidth * 0.35);
    }, { passive: true });
    var end = function () {
      if (!on) return; on = false; p.classList.add('anim');
      if (dx > innerWidth * 0.3) {
        p.style.transform = 'translateX(100%)'; var id = current; current = null; p._closing = true;
        body.classList.remove('tool-open', 'locked', 'covered');
        document.title = 'Liming 工具箱'; history.back();
        later(p, function () { if (current !== id) { park(p); settle(); } }, 480);
        setTimeout(function () { if (!current) { for (var k in panels) panels[k]._closing = false; settle(); } }, 1200);
      } else {
        var cur = current; p.style.transform = ''; body.classList.add('tool-open');
        later(p, function () { if (current === cur) { p.classList.remove('anim'); body.classList.add('covered'); } }, 480);
      }
    };
    edge.addEventListener('touchend', end);
    edge.addEventListener('touchcancel', end);
  }

  /* 初始路由 */
  var path = location.pathname.replace(/\/+$/, '');
  var initial = byPath[path];
  if (initial) {
    history.replaceState({}, '', '/');
    history.pushState({ tool: initial.id }, '', initial.path + location.search + location.hash);
    open(initial.id, { instant: true });
  } else if (path && path !== '/' && path !== '/index.html') {
    history.replaceState({}, '', '/');
  }
  window.LimingShell = { open: open, back: back, tools: TOOLS };
})();

