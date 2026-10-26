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

  function renderRecent() {
    var ids = (ls('lm.recent') || '').split(',').filter(function (id) { return byId[id]; }).slice(0, 6);
    var box = $('#recent'); box.innerHTML = '';
    ids.forEach(function (id, i) {
      var t = byId[id], a = document.createElement('a');
      a.className = 'chip'; a.href = t.path; a.dataset.id = id; a.setAttribute('style', vars(t)); a.style.animationDelay = (i * 50) + 'ms';
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
  var stage = $('#stage'), panels = {}, current = null, ignorePop = 0;
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

  function cardFor(id) {
    var el = document.querySelector('#grid .card[data-id="' + id + '"]:not(.hide)') || document.querySelector('#recent .chip[data-id="' + id + '"]');
    if (!el) return null; var r = el.getBoundingClientRect();
    return (r.bottom > 0 && r.top < innerHeight) ? r : null;
  }

  function open(id, o) {
    var t = byId[id]; if (!t) return;
    o = o || {};
    if (current === id) return;
    if (current) close({ instant: true });
    var p = getPanel(t);
    current = id; pushRecent(id);
    document.title = t.name + ' · Liming 工具箱';
    if (o.push) history.pushState({ tool: id }, '', t.path);
    body.classList.add('tool-open', 'locked');
    var r = o.from ? o.from.getBoundingClientRect() : null;
    if (o.instant || reduce || !r) {
      p.classList.remove('anim'); setClip(p, clip()); p.style.transform = ''; p.style.opacity = '';
      p.classList.add('show', 'opened');
    } else {
      p.classList.remove('anim', 'opened'); setClip(p, clip(r)); p.style.transform = ''; p.style.opacity = '';
      p.classList.add('show');
      void p.offsetWidth;
      requestAnimationFrame(function () { p.classList.add('anim'); setClip(p, clip()); });
      setTimeout(function () { p.classList.add('opened'); }, 300);
    }
  }

  function close(o) {
    if (!current) return;
    o = o || {};
    var id = current, p = panels[id]; current = null;
    document.title = 'Liming 工具箱';
    body.classList.remove('tool-open', 'locked');
    renderRecent();
    var done = function () { p.classList.remove('show', 'anim', 'opened'); p.style.transform = ''; p.style.opacity = ''; setClip(p, clip()); };
    if (o.instant || reduce) { p.classList.remove('anim'); done(); return; }
    var r = cardFor(id);
    p.classList.add('anim');
    if (r) setClip(p, clip(r)); else { p.style.transform = 'translateX(30%)'; p.style.opacity = '0'; }
    setTimeout(function () { if (current !== id) done(); }, 600);
  }

  function back() {
    if (!current) return;
    if (history.state && history.state.tool) { ignorePop++; close(); history.back(); }
    else { close(); history.replaceState({}, '', '/'); }
  }

  window.addEventListener('popstate', function (e) {
    if (ignorePop) { ignorePop--; return; }
    var id = e.state && e.state.tool;
    // 浏览器手势/按钮触发：Safari 已经做了滑动动画，这里直接切换避免闪烁
    if (id) open(id, { instant: true }); else close({ instant: true });
  });

  /* PWA 全屏模式下没有浏览器返回手势，自己实现左缘滑动返回 */
  function edgeSwipe(p) {
    var edge = p.querySelector('.edge'), x0 = 0, dx = 0, on = false;
    edge.addEventListener('touchstart', function (e) { on = true; x0 = e.touches[0].clientX; dx = 0; p.classList.remove('anim'); }, { passive: true });
    edge.addEventListener('touchmove', function (e) {
      if (!on) return; dx = Math.max(0, e.touches[0].clientX - x0);
      p.style.transform = 'translateX(' + dx + 'px)'; body.classList.toggle('tool-open', dx < innerWidth * 0.35);
    }, { passive: true });
    edge.addEventListener('touchend', function () {
      if (!on) return; on = false; p.classList.add('anim');
      if (dx > innerWidth * 0.3) { p.style.transform = 'translateX(100%)'; ignorePop++; var id = current; current = null; body.classList.remove('tool-open', 'locked');
        document.title = 'Liming 工具箱'; renderRecent(); history.back();
        setTimeout(function () { if (current !== id) { p.classList.remove('show', 'anim', 'opened'); p.style.transform = ''; } }, 460); }
      else { p.style.transform = ''; body.classList.add('tool-open'); }
    });
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
