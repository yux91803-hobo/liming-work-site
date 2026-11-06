/* viewer.js — 查看器：课件页（cw）、架构图（fig）、原理图 / 实物图（sch）
   路由驱动：cw / fig / sch 出现就打开；翻页只原地更新路由，不新增返回记录。
   课件：只放当前页，前后各预载一页；新页解码好再换上，慢时把旧页调暗。勘误按页显示在侧栏（窄屏为底部抽屉）。 */
(function () {
  'use strict';
  var STM = window.STM, ui = STM.ui, M = STM.model, el = ui.el;
  var app, root, stage, content, spin, empty, nodes = {}, zoom, open = false, lastFocus = null;
  var mode = null, items = [], idx = 0, part = null, token = 0, erOpen = null, pool = {};

  function build() {
    root = el('div', 'viewer'); root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-labelledby', 'vw-title');
    var head = el('header', 'vw-h');
    var x = ui.btn('icon-btn vw-x', null, '关闭'); x.appendChild(ui.icon('close')); x.addEventListener('click', function () { app.back(); });
    var tt = el('div', 'vw-tt'), lab = el('span', 'vw-lab'), title = el('h2', null); title.id = 'vw-title';
    tt.appendChild(lab); tt.appendChild(title);
    var count = el('span', 'vw-n mono');
    var prev = ui.btn('icon-btn', null, '上一页'); prev.appendChild(ui.icon('back')); prev.addEventListener('click', function () { go(idx - 1); });
    var next = ui.btn('icon-btn', null, '下一页'); next.appendChild(ui.icon('next')); next.addEventListener('click', function () { go(idx + 1); });
    var zb = ui.btn('vw-zoom mono', '100%', '缩放 100%，点击复原'); zb.addEventListener('click', function () { if (zoom.ready()) zoom.reset(); });
    var er = ui.btn('vw-er-b'); er.addEventListener('click', function () { setEr(!erOpen); });
    var topic = el('a', 'ttag vw-topic');
    head.appendChild(x); head.appendChild(tt); head.appendChild(topic); head.appendChild(er); head.appendChild(zb); head.appendChild(count); head.appendChild(prev); head.appendChild(next);
    var mainRow = el('div', 'vw-main');
    stage = el('div', 'vw-stage zoom-view'); content = el('div', 'zoom-content');
    spin = el('span', 'vw-spin'); spin.setAttribute('aria-hidden', 'true');
    empty = el('div', 'vw-empty'); empty.hidden = true;
    stage.appendChild(content); stage.appendChild(spin); stage.appendChild(empty);
    var side = el('aside', 'vw-er'); side.setAttribute('aria-label', '本页勘误');
    mainRow.appendChild(stage); mainRow.appendChild(side);
    root.appendChild(head); root.appendChild(mainRow);
    nodes = { lab: lab, title: title, count: count, prev: prev, next: next, zb: zb, er: er, side: side, topic: topic };
    zoom = ui.Zoomer(stage, content, {
      max: 8, dbl: 2, wheelPans: true, wheelZoom: true,
      onZoom: function (v) { var p = Math.round(v * 100); zb.textContent = p + '%'; zb.classList.toggle('fit', p === 100); zb.setAttribute('aria-label', '缩放 ' + p + '%，点击复原'); },
      onSwipe: function (dir) { var j = idx + dir; if (j < 0 || j >= items.length) return false; go(j); return true; }
    });
    var ro = window.ResizeObserver ? new ResizeObserver(function () { if (open && zoom.ready()) zoom.refit(); }) : null;
    if (ro) ro.observe(stage);
    root.addEventListener('keydown', function (e) {
      if (e.key === 'Tab') {
        var f = Array.prototype.filter.call(root.querySelectorAll('button, a[href], [tabindex="0"]'), function (n) { return !n.disabled && n.offsetParent !== null; });
        if (!f.length) return;
        var i = f.indexOf(document.activeElement);
        if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
        else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
        return;
      }
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); go(idx - 1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); go(idx + 1); }
      else if (e.key === '+' || e.key === '=') { e.preventDefault(); zoom.zoomBy(1.25); }
      else if (e.key === '-') { e.preventDefault(); zoom.zoomBy(0.8); }
      else if (e.key === '0') { e.preventDefault(); zoom.reset(); }
    });
    window.addEventListener('online', function () { if (open && root.classList.contains('failed')) showItem(true); });
  }

  /* ---------- 条目 ---------- */
  function figList(route) {
    var t = route.v === 'topic' ? M.topicById[route.t] : null, f = M.figById[route.fig];
    if (t && t.figs.indexOf(f) > -1) return t.figs;
    return M.figs.filter(function (x) { return x.kind === (f ? f.kind : 'manual'); });
  }
  function itemsFor(route) {
    if (route.cw) {
      var m = /^(.*)-(\d+)$/.exec(route.cw), pt = m && M.partById[m[1]];
      if (!pt) return null;
      return { mode: 'cw', part: pt, idx: Math.max(0, Math.min(pt.n - 1, Number(m[2]) - 1)),
        items: pt.pages.map(function (src, j) { var ch = pt.at[j]; return { src: [src], w: M.CW_W, h: M.CW_H, title: ch ? ch.title : pt.title, label: pt.short + ' 第 ' + (j + 1) + ' 页', key: pt.id + '-' + (j + 1) }; }) };
    }
    if (route.fig) {
      var list = figList(route), i = list.indexOf(M.figById[route.fig]);
      if (i < 0) return { mode: 'fig', idx: 0, items: [], missing: '没有这张图：' + route.fig };
      return { mode: 'fig', idx: i, items: list.map(function (f) { return { src: f.cands, w: f.w, h: f.h, title: f.title, label: f.kind === 'teach' ? '教学图' : (f.label || '手册') + (f.page != null ? '，第 ' + f.page + ' 页' : ''), key: f.id }; }) };
    }
    if (route.sch) {
      if (route.sch === 'photo') return { mode: 'sch', idx: 0, items: [{ src: [M.photo], w: 0, h: 0, title: '开发板实物图', label: '开发板', key: 'photo' }] };
      var k = -1; M.sch.forEach(function (s, j) { if (s.id === route.sch) k = j; });
      if (k < 0) return { mode: 'sch', idx: 0, items: [], missing: '没有这页原理图：' + route.sch };
      return { mode: 'sch', idx: k, items: M.sch.map(function (s) { return { src: s.cands, w: s.w, h: s.h, title: s.title, label: s.group, key: s.id }; }) };
    }
    return null;
  }

  function sync(route) {
    var it = itemsFor(route);
    if (!it) { if (open) close(); return; }
    var sameSet = open && mode === it.mode && (it.mode !== 'cw' || part === it.part) && items.length === it.items.length && (it.mode !== 'fig' || (items[0] && items[0].key === it.items[0].key));
    mode = it.mode; part = it.part || null; items = it.items;
    var bitmap = mode === 'cw' || (items[it.idx] && /\.(png|webp|jpe?g)$/i.test(items[it.idx].src[0] || ''));
    zoom.limits(bitmap ? 4 : 8, 2);              // 位图放到 4 倍就糊了；矢量图可以到 8 倍
    if (!open) show();
    if (!sameSet || it.idx !== idx || !content.firstChild) { idx = it.idx; showItem(false, it.missing); }
  }
  function show() {
    open = true; lastFocus = document.activeElement;
    document.getElementById('layers').appendChild(root);
    ui.modal(root, true);
    ui.clear(content); token++;
    requestAnimationFrame(function () { if (!open) return; root.classList.add('on'); try { root.querySelector('.vw-x').focus({ preventScroll: true }); } catch (e) {} });
  }
  function close() {
    open = false; token++;
    Object.keys(pool).forEach(function (k) { var im = pool[k]; im.onload = im.onerror = null; if (!im.complete) im.removeAttribute('src'); delete pool[k]; });
    root.classList.remove('on');
    ui.modal(root, false);
    var r = root; setTimeout(function () { if (!open) { r.remove(); ui.clear(content); zoom.clear(); } }, ui.reduced() ? 0 : 220);
    var back = lastFocus; lastFocus = null;
    if (back && back.isConnected) try { back.focus({ preventScroll: true }); } catch (e) {}
  }
  function go(j) {
    if (j < 0 || j >= items.length || j === idx) return;
    var it = items[j], patch = {};
    patch[mode] = it.key;
    idx = j; showItem(false);
    app.update(patch);
  }

  /* ---------- 显示一项 ---------- */
  function loadImg(src, retry) {
    var key = src + (retry ? '#r' : '');
    if (pool[key] && !retry) return pool[key];
    var im = new Image(); im.decoding = 'async'; im.alt = '';
    im._st = 'loading';
    im.onload = function () { im._st = 'ok'; if (im._cb) im._cb(true); };
    im.onerror = function () { im._st = 'err'; if (im._cb) im._cb(false); };
    im.src = retry ? src + (src.indexOf('?') > -1 ? '&' : '?') + 'r=' + Date.now() : src;
    pool[key] = im;
    return im;
  }
  function trimPool(keep) { Object.keys(pool).forEach(function (k) { if (keep.indexOf(k) < 0) { var im = pool[k]; im._cb = null; im.onload = im.onerror = null; if (im._st === 'loading') im.removeAttribute('src'); delete pool[k]; } }); }
  function showItem(retry, missing) {
    var it = items[idx], my = ++token;
    root.classList.remove('failed'); empty.hidden = true;
    nodes.prev.disabled = idx <= 0; nodes.next.disabled = idx >= items.length - 1;
    nodes.count.textContent = items.length > 1 ? (idx + 1) + ' / ' + items.length : '';
    if (!it) { nodes.title.textContent = ''; nodes.lab.textContent = ''; ui.clear(content); spin.hidden = true; setEmpty(missing || '这一项不存在'); renderEr(); return; }
    nodes.lab.textContent = it.label || ''; nodes.title.textContent = it.title || ''; nodes.title.title = it.title || '';
    var tp = mode === 'cw' ? M.topicOfChapter(part.at[idx]) : null;
    nodes.topic.hidden = !tp;
    if (tp) { nodes.topic.textContent = tp.code; nodes.topic.style.setProperty('--h', app.hue(tp)); nodes.topic.href = app.urlOf({ v: 'topic', t: tp.id }); nodes.topic.onclick = function (e) { e.preventDefault(); app.navigate({ v: 'topic', t: tp.id }); }; nodes.topic.setAttribute('aria-label', '外设：' + tp.name); }
    if (mode === 'cw') { try { var o = JSON.parse(ui.lsGet(STM.viewsUtil.CW_KEY) || '{}') || {}; o[part.id] = idx + 1; ui.lsSet(STM.viewsUtil.CW_KEY, JSON.stringify(o)); } catch (e) {} }
    renderEr();
    var srcs = (it.src || []).filter(Boolean);
    if (!srcs.length) { ui.clear(content); spin.hidden = true; setEmpty('这一项没有图片文件'); return; }
    var old = content.querySelector('img');
    if (it.w && it.h) zoom.fit(it.w, it.h);
    spin.hidden = false;
    if (old) old.classList.add('dim');
    var k = 0;
    function attempt() {
      var im = loadImg(srcs[k], retry);
      function done(ok) {
        if (my !== token) return;
        im._cb = null;
        if (!ok) { k++; if (k < srcs.length) attempt(); else fail(); return; }
        var dec = null; try { dec = im.decode ? im.decode() : null; } catch (e) {}
        (dec ? dec.catch(function () {}) : Promise.resolve()).then(function () {
          if (my !== token || !open) return;
          ui.clear(content); im.className = ''; im.draggable = false; im.alt = it.title || '';
          var nw = it.w || im.naturalWidth || 1000, nh = it.h || im.naturalHeight || 750;
          zoom.fit(nw, nh);
          content.appendChild(im); spin.hidden = true;
          // 课件：预载前后各一页
          if (mode === 'cw') {
            var keep = [srcs[k]];
            [idx - 1, idx + 1].forEach(function (j) { if (items[j] && items[j].src[0]) { keep.push(items[j].src[0]); loadImg(items[j].src[0]); } });
            trimPool(keep);
          }
        });
      }
      if (im._st === 'ok') done(true); else if (im._st === 'err') done(false); else im._cb = done;
    }
    function fail() {
      ui.clear(content); spin.hidden = true; root.classList.add('failed');
      ui.clear(empty);
      empty.appendChild(el('p', null, '图片没加载出来，可能是网络断了。'));
      var b = ui.btn('pill solid', '重新加载'); b.addEventListener('click', function () { showItem(true); }); empty.appendChild(b);
      empty.hidden = false;
    }
    attempt();
  }
  function setEmpty(msg) { ui.clear(empty); empty.appendChild(el('p', null, msg)); empty.hidden = false; }

  /* ---------- 勘误 ---------- */
  function renderEr() {
    var list = mode === 'cw' && part ? M.erFor(part.id, idx + 1) : [];
    var side = nodes.side, b = nodes.er;
    b.hidden = !list.length;
    root.classList.toggle('has-er', !!list.length);
    if (!list.length) { root.classList.remove('er-open'); ui.clear(side); return; }
    if (erOpen == null) erOpen = window.innerWidth >= 1100;
    b.className = 'vw-er-b sev-' + list[0].sev; b.textContent = '勘误 ' + list.length; b.setAttribute('aria-expanded', String(!!erOpen));
    ui.clear(side);
    var hh = el('div', 'er-h'); hh.appendChild(el('h3', null, '这一页的勘误'));
    var cx = ui.btn('icon-btn', null, '收起勘误'); cx.appendChild(ui.icon('close')); cx.addEventListener('click', function () { setEr(false); }); hh.appendChild(cx);
    side.appendChild(hh);
    if (M.errataNotice) side.appendChild(el('p', 'er-note', '从课件复制代码时，缩进里可能夹着不间断空格（U+00A0），编译会报 stray \'\\302\'，粘贴后换成普通空格。'));
    list.forEach(function (r) {
      var a = el('article', 'er-it');
      var top = el('div', 'er-it-h'); top.appendChild(el('span', 'er-sev sev-' + r.sev, M.SEV_WORD[r.sev])); if (r.pageText) top.appendChild(el('span', null, /^\d/.test(r.pageText) ? '第 ' + r.pageText + ' 页' : r.pageText)); a.appendChild(top);
      if (r.issue) a.appendChild(el('p', null, r.issue));
      if (r.original) { var o = el('pre', 'er-orig'); o.appendChild(el('code', null, r.original)); a.appendChild(el('h4', null, '课件原文')); a.appendChild(o); }
      if (r.fix) a.appendChild(ui.codeBlock(r.fix, { title: '正确写法', copyLabel: '复制正确写法' }));
      side.appendChild(a);
    });
    root.classList.toggle('er-open', !!erOpen);
  }
  function setEr(on) { erOpen = !!on; root.classList.toggle('er-open', erOpen); nodes.er.setAttribute('aria-expanded', String(erOpen)); if (zoom.ready()) requestAnimationFrame(function () { zoom.refit(); }); }

  STM.viewer = { init: function (a) { app = a; build(); }, sync: sync, isOpen: function () { return open; } };
})();
