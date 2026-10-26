(function () {
  'use strict';
  var API = '/api/transfer';
  var $ = function (s) { return document.querySelector(s); };
  var html = document.documentElement, embedded = html.classList.contains('embed');
  function ls(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  /* 主题（与工具箱同步） */
  var mq = matchMedia('(prefers-color-scheme: dark)');
  function onTheme() { var t = ls('lm.theme') || 'light'; var d = t === 'dark' || (t === 'auto' && mq.matches); html.dataset.theme = d ? 'dark' : 'light'; document.querySelector('meta[name=theme-color]').content = d ? '#0d1117' : '#f5f6f8'; }
  onTheme(); mq.addEventListener && mq.addEventListener('change', onTheme);
  window.addEventListener('storage', function (e) { if (e.key === 'lm.theme') onTheme(); });
  window.addEventListener('message', function (e) { if (e.origin === location.origin && e.data && e.data.type === 'theme') onTheme(); });
  function ready() { if (embedded) try { parent.postMessage({ type: 'ready' }, location.origin); } catch (e) {} }

  var ua = navigator.userAgent;
  var isIOS = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  var DEV = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) || (isIOS && /Macintosh/.test(ua)) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : '电脑';

  var tt;
  function toast(m) { var t = $('#toast'); t.textContent = m; t.classList.add('show'); clearTimeout(tt); tt = setTimeout(function () { t.classList.remove('show'); }, 1600); }
  function req(path, o) {
    o = o || {}; o.headers = Object.assign({ 'X-Device': encodeURIComponent(DEV) }, o.headers || {});
    if (o.json !== undefined) { o.body = JSON.stringify(o.json); o.headers['Content-Type'] = 'application/json'; delete o.json; }
    o.credentials = 'same-origin';
    return fetch(API + path, o).then(function (r) {
      if (r.status === 401 && path !== '/login') { showLogin(); throw new Error('auth'); }
      return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) { var e = new Error(j.error || 'http'); e.status = r.status; e.data = j; throw e; } return j; });
    });
  }
  function fmtSize(n) { if (n < 1024) return n + ' B'; if (n < 1048576) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB'; if (n < 1073741824) return (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + ' MB'; return parseFloat((n / 1073741824).toFixed(1)) + ' GB'; }
  function ago(t) { var s = (Date.now() - t) / 1000; if (s < 60) return '刚刚'; if (s < 3600) return Math.floor(s / 60) + ' 分钟前'; if (s < 86400) return Math.floor(s / 3600) + ' 小时前'; var d = new Date(t); return (d.getMonth() + 1) + '月' + d.getDate() + '日'; }
  function left(e) { var s = (e - Date.now()) / 1000; if (s <= 0) return '即将删除'; if (s < 3600) return Math.ceil(s / 60) + ' 分钟后删除'; return Math.ceil(s / 3600) + ' 小时后删除'; }
  var ERR = { file_too_large: '文件超过上限', space_full: '空间已满，请先删除一些', text_too_large: '文字太长', too_many: '条目太多，请先清理', rate_limited: '尝试过多，请稍后再试', bad_password: '密码不对', not_configured: '服务未配置' };

  /* ---------- 登录 ---------- */
  var LIMITS = null;
  function showLogin() { $('#app').hidden = true; $('#login').hidden = false; stopLive(); setTimeout(function () { $('#pw').focus(); }, 300); ready(); }
  $('#loginForm').addEventListener('submit', function (e) {
    e.preventDefault(); var pw = $('#pw').value; if (!pw) return;
    $('#go').classList.add('wait'); $('#lerr').textContent = '';
    req('/login', { method: 'POST', json: { password: pw } }).then(function () {
      $('#pw').value = ''; $('#pw').blur(); start();
    }).catch(function (er) {
      var m = ERR[er.message] || '登录失败';
      if (er.message === 'rate_limited' && er.data && er.data.retry) m += '（' + Math.ceil(er.data.retry / 60) + ' 分钟）';
      $('#lerr').textContent = m; var c = $('.lcard'); c.classList.remove('shake'); void c.offsetWidth; c.classList.add('shake'); $('#pw').select();
    }).finally(function () { $('#go').classList.remove('wait'); });
  });

  /* ---------- 列表 ---------- */
  var items = {}, order = [], uploads = {}, list = $('#list'), used = 0, firstRender = true;
  var IC = {
    copy: '<svg viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="3"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>',
    ok: '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    dl: '<svg viewBox="0 0 24 24"><path d="M12 4v12M7 11l5 5 5-5"/><path d="M5 20h14"/></svg>',
    share: '<svg viewBox="0 0 24 24"><path d="M12 15V3M7.5 7.5 12 3l4.5 4.5"/><path d="M8 11H6a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2h-2"/></svg>',
    pin: '<svg viewBox="0 0 24 24"><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9Z"/></svg>',
    pinOn: '<svg viewBox="0 0 24 24"><path class="fill" d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9Z"/></svg>',
    del: '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>',
    text: '<svg viewBox="0 0 24 24"><path d="M5 6h14M5 11h14M5 16h9"/></svg>',
    x: '<svg viewBox="0 0 24 24"><path d="M7 7l10 10M17 7 7 17"/></svg>',
    retry: '<svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 5v6h-6"/></svg>',
    spin: '<svg viewBox="0 0 24 24"><path d="M12 3a9 9 0 1 0 9 9"/></svg>'
  };
  function linkify(t) {
    return esc(t).replace(/\b((?:https?:\/\/|www\.)[^\s<>"'，。；、）)]+)/gi, function (u) {
      var h = /^www\./i.test(u) ? 'https://' + u : u; return '<a href="' + h + '" target="_blank" rel="noopener noreferrer">' + u + '</a>';
    });
  }
  function ext(n) { var m = /\.([a-z0-9]{1,5})$/i.exec(n || ''); return m ? m[1] : 'file'; }
  function isImg(it) { return /^image\/(jpeg|png|gif|webp|heic|heif|avif|bmp)/.test(it.mime || ''); }
  function raw(it, dl) { return API + '/items/' + it.id + '/raw' + (dl ? '?dl=1' : ''); }

  function itemEl(it) {
    var li = document.createElement('li'); li.className = 'it'; li.dataset.id = it.id;
    fill(li, it); return li;
  }
  function fill(li, it) {
    var up = uploads[it.id], th, body, acts = '';
    if (it.kind === 'text') {
      th = '<div class="th txt">' + IC.text + '</div>';
      body = '<div class="tx">' + linkify(it.text) + '</div>';
      acts = '<button class="ab main" data-a="copy" aria-label="复制">' + IC.copy + '</button>';
    } else {
      th = '<div class="th">' + (it.thumb ? '<img src="' + it.thumb + '" alt="" data-a="view">' : esc(ext(it.name))) + '</div>';
      body = '<div class="nm">' + esc(it.name) + '</div>';
      if (it.done) acts = '<button class="ab main" data-a="save" aria-label="保存">' + (isIOS && canShareFiles && it.size <= 100 * 1048576 ? IC.share : IC.dl) + '</button>';
    }
    var pct = up ? up.pct : (it.chunks ? it.got / it.chunks : 1);
    var meta = [];
    if (it.kind === 'file') meta.push(fmtSize(it.size));
    meta.push(esc(it.dev || '') + (it.dev ? ' · ' : '') + ago(it.created));
    meta.push(it.expires ? '<span>' + left(it.expires) + '</span>' : '<span class="keep">永久保留</span>');
    if (it.kind === 'file' && !it.done) {
      meta = [fmtSize(it.size), up ? (up.failed ? '<span class="bad">已中断</span>' : '<span class="speed">' + Math.floor(pct * 100) + '%</span>') : '<span>' + esc(it.dev || '') + ' 上传中 ' + Math.floor(pct * 100) + '%</span>'];
      var ctl = up ? (up.failed ? '<button class="ab main" data-a="retry" aria-label="重试">' + IC.retry + '</button>' : '') + '<button class="ab" data-a="cancel" aria-label="取消">' + IC.x + '</button>'
                   : '<button class="ab" data-a="del" aria-label="删除">' + IC.del + '</button>';
      li.innerHTML = th + '<div class="bd">' + body + '<div class="mt">' + meta.join('<span>·</span>') + '</div><div class="prog' + (up && up.failed ? ' bad' : '') + '"><i style="width:' + (pct * 100).toFixed(1) + '%"></i></div></div><div class="acts">' + ctl + '</div>';
      return;
    }
    li.innerHTML = th + '<div class="bd">' + body + '<div class="mt">' + meta.join('<span>·</span>') + '</div></div>' +
      '<div class="acts">' + acts +
      '<button class="ab' + (it.expires ? '' : ' on') + '" data-a="keep" aria-label="' + (it.expires ? '永久保留' : '取消永久') + '">' + (it.expires ? IC.pin : IC.pinOn) + '</button>' +
      '<button class="ab" data-a="del" aria-label="删除">' + IC.del + '</button></div>';
  }
  function upsert(it, isNew) {
    var had = !!items[it.id]; items[it.id] = it;
    var li = list.querySelector('[data-id="' + it.id + '"]');
    if (li) { var full = li.querySelector('.tx.full'); fill(li, it); if (full) li.querySelector('.tx').classList.add('full'); }
    else { li = itemEl(it); if (isNew) li.classList.add('new'); insertSorted(li, it); }
    $('#empty').hidden = true;
    return had;
  }
  function insertSorted(li, it) {
    var kids = list.children;
    for (var i = 0; i < kids.length; i++) { var o = items[kids[i].dataset.id]; if (o && o.created < it.created) { list.insertBefore(li, kids[i]); return; } }
    list.appendChild(li);
  }
  function removeIds(ids) {
    ids.forEach(function (id) {
      delete items[id]; var li = list.querySelector('[data-id="' + id + '"]'); if (!li) return;
      li.style.height = li.offsetHeight + 'px'; li.classList.add('out');
      setTimeout(function () { li.remove(); checkEmpty(); }, 300);
    });
  }
  function checkEmpty() { $('#empty').hidden = list.children.length > 0; }
  function render(data) {
    LIMITS = data.limits; used = data.used; usage();
    var ids = {}; data.items.forEach(function (it) { ids[it.id] = 1; });
    removeIds(Object.keys(items).filter(function (id) { return !ids[id] && !uploads[id]; }));
    data.items.slice().reverse().forEach(function (it, i) {
      var li = list.querySelector('[data-id="' + it.id + '"]');
      if (!li && firstRender) { items[it.id] = it; li = itemEl(it); li.style.animationDelay = Math.min(i, 8) * 35 + 'ms'; insertSorted(li, it); }
      else upsert(it, !firstRender);
    });
    firstRender = false; checkEmpty();
  }
  function usage() {
    if (!LIMITS) return;
    $('#usedBar').style.width = Math.min(100, used / LIMITS.spaceMax * 100) + '%';
    $('#usedTxt').textContent = fmtSize(used) + ' / ' + fmtSize(LIMITS.spaceMax) + ' · 单文件/总空间 ' + fmtSize(LIMITS.spaceMax);
    $('#limitsTxt').textContent = '单文件/总空间 ' + fmtSize(LIMITS.spaceMax) + '（单个文件可占满全部空间）。上传中断可续传。内容默认 24 小时后自动删除，点 ☆ 可永久保留。';
  }
  function refresh() { return req('/items').then(render).catch(function () {}); }
  setInterval(function () { list.querySelectorAll('.it').forEach(function (li) { var it = items[li.dataset.id]; if (it && !uploads[it.id]) { var mt = li.querySelector('.mt'); if (mt) { var tmp = document.createElement('li'); fill(tmp, it); mt.innerHTML = tmp.querySelector('.mt').innerHTML; } } }); }, 60000);

  /* ---------- 实时：WebSocket，失败则轮询 ---------- */
  var ws = null, wsFails = 0, pollT = null, pingT = null, live = $('#live'), running = false;
  function connect() {
    if (!running) return;
    try { ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + API + '/ws'); } catch (e) { return poll(); }
    ws.onopen = function () { wsFails = 0; live.className = 'live on'; clearInterval(pollT); pollT = null; refresh(); clearInterval(pingT); pingT = setInterval(function () { try { ws.send('ping'); } catch (e) {} }, 25000); };
    ws.onmessage = function (e) {
      var m; try { m = JSON.parse(e.data); } catch (x) { return; }
      if (m.type === 'item') { if (!uploads[m.item.id]) { var had = upsert(m.item, true); if (!had && m.item.kind === 'text' && m.item.dev !== DEV) navigator.vibrate && navigator.vibrate(10); } else items[m.item.id] = m.item; recalcUsed(); }
      else if (m.type === 'progress') { var it = items[m.id]; if (it && !uploads[m.id]) { it.got = m.got; it.chunks = m.chunks; var li2 = list.querySelector('[data-id="' + m.id + '"]'); if (li2) fill(li2, it); } }
      else if (m.type === 'removed') { removeIds(m.ids); recalcUsed(); }
      else if (m.type === 'cleared') { removeIds(Object.keys(items)); used = 0; usage(); }
    };
    ws.onclose = function () { clearInterval(pingT); ws = null; if (!running) return; wsFails++; live.className = 'live poll'; poll(); setTimeout(connect, Math.min(30000, 1000 * Math.pow(2, wsFails))); };
  }
  function recalcUsed() { used = 0; for (var id in items) if (items[id].kind === 'file') used += items[id].size; usage(); }
  function poll() { if (pollT || !running) return; pollT = setInterval(function () { if (!document.hidden) refresh(); }, 4000); }
  function stopLive() { running = false; clearInterval(pollT); pollT = null; clearInterval(pingT); if (ws) try { ws.close(); } catch (e) {} ws = null; }
  document.addEventListener('visibilitychange', function () { if (!document.hidden && running) { refresh(); if (!ws) connect(); } });

  function start() {
    $('#login').hidden = true; $('#app').hidden = false; running = true;
    refresh().then(ready); connect();
  }

  /* ---------- 发送文字 ---------- */
  var ta = $('#text'), sendBtn = $('#send');
  function grow() { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, innerHeight * 0.4) + 'px'; sendBtn.disabled = !ta.value.trim(); }
  ta.addEventListener('input', grow);
  ta.addEventListener('keydown', function (e) { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || (!e.shiftKey && !isIOS && matchMedia('(hover:hover)').matches))) { e.preventDefault(); sendText(); } });
  sendBtn.addEventListener('click', sendText);
  function sendText() {
    var t = ta.value; if (!t.trim()) return;
    sendBtn.disabled = true;
    req('/items/text', { method: 'POST', json: { text: t } }).then(function (j) { ta.value = ''; grow(); upsert(j.item, true); toast('已发送'); })
      .catch(function (e) { if (e.message !== 'auth') toast(ERR[e.message] || '发送失败'); grow(); });
  }

  /* ---------- 上传文件 ---------- */
  $('#file').addEventListener('change', function () { addFiles(this.files); this.value = ''; });
  function addFiles(fl) {
    var arr = Array.prototype.slice.call(fl || []); if (!arr.length) return;
    var chain = Promise.resolve();
    arr.forEach(function (f) { chain = chain.then(function () { return upload(f); }); });
  }
  function thumb(f) {
    if (!/^image\//.test(f.type)) return Promise.resolve(null);
    return new Promise(function (res) {
      var url = URL.createObjectURL(f), img = new Image();
      img.onload = function () {
        var s = 200 / Math.max(img.naturalWidth, img.naturalHeight), c = document.createElement('canvas');
        s = Math.min(1, s * (img.naturalWidth > img.naturalHeight ? img.naturalWidth / img.naturalHeight : img.naturalHeight / img.naturalWidth)); // 方形裁剪更清晰
        var w = Math.max(1, Math.round(img.naturalWidth * s)), h = Math.max(1, Math.round(img.naturalHeight * s));
        c.width = w; c.height = h; c.getContext('2d').drawImage(img, 0, 0, w, h);
        var d = c.toDataURL('image/jpeg', 0.72); URL.revokeObjectURL(url);
        res(d.length < 90000 ? d : c.toDataURL('image/jpeg', 0.45));
      };
      img.onerror = function () { URL.revokeObjectURL(url); res(null); };
      img.src = url;
    });
  }
  function put(url, blob, onp, U) {
    return new Promise(function (res, rej) {
      if (U.cancel) return rej(new Error('cancel'));
      var x = new XMLHttpRequest(); x.open('PUT', url); x.setRequestHeader('X-Device', encodeURIComponent(DEV));
      U.xhrs.add(x); x.onloadend = function () { U.xhrs.delete(x); }; x.onabort = function () { rej(new Error('cancel')); };
      x.upload.onprogress = function (e) { onp(e.loaded); };
      x.onload = function () { if (x.status === 401) { showLogin(); rej(new Error('auth')); } else if (x.status >= 200 && x.status < 300) res(); else { var e = new Error('http' + x.status); e.status = x.status; rej(e); } };
      x.onerror = function () { rej(new Error('net')); }; x.send(blob);
    });
  }
  function upload(f) {
    if (LIMITS && f.size > LIMITS.fileMax) { toast('「' + f.name + '」超过 ' + fmtSize(LIMITS.fileMax)); return Promise.resolve(); }
    if (!f.size) { toast('空文件已跳过'); return Promise.resolve(); }
    return thumb(f).then(function (tb) {
      return req('/items/file', { method: 'POST', json: { name: f.name || 'file', size: f.size, mime: f.type || 'application/octet-stream', thumb: tb } });
    }).then(function (j) {
      var it = j.item, U = uploads[it.id] = { pct: 0, f: f, cs: j.chunk, n: it.chunks, loaded: new Array(it.chunks).fill(0), doneSet: {}, xhrs: new Set(), t0: Date.now(), b0: 0 };
      upsert(it, true);
      return run(it.id);
    }).catch(function (e) { if (e.message !== 'auth') toast(ERR[e.message] || '上传失败'); });
  }
  function upBar(id) {
    var U = uploads[id]; if (!U) return;
    var sum = U.loaded.reduce(function (a, b) { return a + b; }, 0); U.pct = sum / U.f.size;
    var li = list.querySelector('[data-id="' + id + '"]'); if (!li) return;
    var b = li.querySelector('.prog i'); if (b) b.style.width = (U.pct * 100).toFixed(1) + '%';
    var sp = li.querySelector('.speed'); if (sp) { var dt = (Date.now() - U.t0) / 1000, v = dt > 0.5 ? (sum - U.b0) / dt : 0;
      sp.textContent = Math.floor(U.pct * 100) + '%' + (v ? ' · ' + fmtSize(v) + '/s' : '') + (v && U.pct < 1 ? ' · 剩 ' + eta((U.f.size - sum) / v) : ''); }
  }
  function eta(s) { return s < 60 ? Math.ceil(s) + ' 秒' : s < 3600 ? Math.ceil(s / 60) + ' 分钟' : (s / 3600).toFixed(1) + ' 小时'; }
  // 分块并发上传（3 路），失败分块自动重试 4 次；仍失败则可手动「重试」续传
  function run(id) {
    var U = uploads[id], it = items[id]; if (!U) return Promise.resolve();
    U.failed = false; U.cancel = false; U.t0 = Date.now(); U.b0 = U.loaded.reduce(function (a, b) { return a + b; }, 0); refill(id);
    var queue = []; for (var i = 0; i < U.n; i++) if (!U.doneSet[i]) queue.push(i);
    function worker() {
      if (U.cancel || U.failed || !queue.length) return Promise.resolve();
      var i = queue.shift(), blob = U.f.slice(i * U.cs, Math.min(U.f.size, (i + 1) * U.cs)), tries = 0;
      var go = function () {
        return put(API + '/items/' + id + '/chunk/' + i, blob, function (l) { U.loaded[i] = l; upBar(id); }, U).catch(function (e) {
          if (e.message === 'auth' || e.message === 'cancel' || e.status === 404 || e.status === 400 || ++tries > 4) throw e;
          U.loaded[i] = 0; return new Promise(function (r) { setTimeout(r, 1000 * tries); }).then(go);
        });
      };
      return go().then(function () { U.doneSet[i] = 1; U.loaded[i] = blob.size; upBar(id); return worker(); });
    }
    return Promise.all([worker(), worker(), worker()]).then(function () {
      if (U.cancel) return;
      delete uploads[id]; it.done = true; it.got = U.n; upsert(it); recalcUsed(); toast('已上传');
    }).catch(function (e) {
      if (U.cancel || e.message === 'cancel') return;
      if (e.message === 'auth') return;
      if (e.status === 404) { delete uploads[id]; removeIds([id]); toast('上传已被取消'); return; }
      U.failed = true; U.xhrs.forEach(function (x) { x.abort(); }); refill(id); toast('上传中断，可点重试续传');
    });
  }
  function cancelUpload(id) {
    var U = uploads[id]; if (U) { U.cancel = true; U.xhrs.forEach(function (x) { x.abort(); }); delete uploads[id]; }
    req('/items/' + id, { method: 'DELETE' }).catch(function () {}); removeIds([id]); recalcUsed(); toast('已取消');
  }
  function refill(id) { var li = list.querySelector('[data-id="' + id + '"]'), it = items[id]; if (li && it) { fill(li, it); upBar(id); } }
  window.addEventListener('beforeunload', function (e) { if (Object.keys(uploads).some(function (k) { return !uploads[k].failed; })) { e.preventDefault(); e.returnValue = ''; } });

  // 拖拽 & 粘贴
  var dragN = 0;
  function hasFiles(e) { return e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') > -1; }
  document.addEventListener('dragenter', function (e) { if (!hasFiles(e) || $('#app').hidden) return; e.preventDefault(); dragN++; document.body.classList.add('dragging'); });
  document.addEventListener('dragover', function (e) { if (hasFiles(e)) e.preventDefault(); });
  document.addEventListener('dragleave', function () { if (--dragN <= 0) { dragN = 0; document.body.classList.remove('dragging'); } });
  document.addEventListener('drop', function (e) { if (!hasFiles(e)) return; e.preventDefault(); dragN = 0; document.body.classList.remove('dragging'); if (!$('#app').hidden) addFiles(e.dataTransfer.files); });
  document.addEventListener('paste', function (e) {
    if ($('#app').hidden || !e.clipboardData) return;
    var files = Array.prototype.slice.call(e.clipboardData.files || []);
    if (files.length) { e.preventDefault(); addFiles(files.map(function (f, i) { return f.name && f.name !== 'image.png' ? f : new File([f], '粘贴图片-' + new Date().toISOString().slice(0, 19).replace(/[T:]/g, '') + (i ? '-' + i : '') + '.' + ((f.type.split('/')[1] || 'png').replace('jpeg', 'jpg')), { type: f.type }); })); return; }
    if (document.activeElement !== ta) { var t = e.clipboardData.getData('text'); if (t) { e.preventDefault(); ta.value = t; grow(); ta.focus(); } }
  });

  /* ---------- 条目操作 ---------- */
  var canShareFiles = false;
  try { canShareFiles = !!(navigator.canShare && navigator.canShare({ files: [new File(['x'], 'x.txt', { type: 'text/plain' })] })); } catch (e) {}
  var fetched = {};
  list.addEventListener('click', function (e) {
    var tx = e.target.closest('.tx'); if (tx && !e.target.closest('a')) { tx.classList.toggle('full'); return; }
    var b = e.target.closest('[data-a]'); if (!b) return;
    var li = b.closest('.it'), it = items[li.dataset.id]; if (!it) return;
    var a = b.dataset.a;
    if (a === 'copy') copy(it.text).then(function () { flash(b); toast('已复制'); }, function () { toast('复制失败'); });
    else if (a === 'view') { $('#vimg').src = raw(it); $('#viewer').hidden = false; document.body.classList.add('noscroll'); }
    else if (a === 'save') save(it, b);
    else if (a === 'cancel') cancelUpload(it.id);
    else if (a === 'retry') run(it.id);
    else if (a === 'keep') {
      var keep = !!it.expires;
      req('/items/' + it.id, { method: 'PATCH', json: { keep: keep } }).then(function (j) { upsert(j.item); toast(keep ? '已设为永久保留' : '将在 24 小时后删除'); }).catch(function (e) { if (e.message !== 'auth') toast('操作失败'); });
    } else if (a === 'del') {
      req('/items/' + it.id, { method: 'DELETE' }).then(function () { removeIds([it.id]); recalcUsed(); }).catch(function (e) { if (e.message !== 'auth') toast('删除失败'); });
    }
  });
  function flash(b) { var o = b.innerHTML; b.innerHTML = IC.ok; b.classList.add('ok'); setTimeout(function () { b.innerHTML = o; b.classList.remove('ok'); }, 1200); }
  function copy(t) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(t);
    return new Promise(function (res, rej) { var x = document.createElement('textarea'); x.value = t; x.style.cssText = 'position:fixed;opacity:0'; document.body.appendChild(x); x.select(); try { document.execCommand('copy') ? res() : rej(); } catch (e) { rej(e); } x.remove(); });
  }
  function save(it, b) {
    // iPhone：先取回文件，再用系统分享面板（可「存储图像」/「存储到文件」）
    if (isIOS && canShareFiles && it.size <= 100 * 1048576) {
      var f = fetched[it.id];
      if (f) { return navigator.share({ files: [f] }).catch(function (e) { if (e && e.name === 'NotAllowedError') location.href = raw(it, true); }); }
      b.classList.add('busy'); b.innerHTML = IC.spin;
      fetch(raw(it), { credentials: 'same-origin' }).then(function (r) { if (!r.ok) throw 0; return r.blob(); }).then(function (bl) {
        f = fetched[it.id] = new File([bl], it.name, { type: it.mime });
        b.classList.remove('busy'); b.innerHTML = IC.share;
        navigator.share({ files: [f] }).catch(function (e) { if (e && e.name === 'NotAllowedError') toast('已就绪，再点一次保存'); });
      }).catch(function () { b.classList.remove('busy'); b.innerHTML = IC.share; location.href = raw(it, true); });
      return;
    }
    var a = document.createElement('a'); a.href = raw(it, true); a.download = it.name; document.body.appendChild(a); a.click(); a.remove(); flash(b);
  }
  $('#viewer').addEventListener('click', function () { $('#viewer').hidden = true; $('#vimg').src = ''; document.body.classList.remove('noscroll'); });

  /* ---------- 菜单 ---------- */
  function sheet(on) { document.body.classList.toggle('sheet', on); }
  $('#menuBtn').addEventListener('click', function () { sheet(true); });
  $('#scrim').addEventListener('click', function () { sheet(false); });
  $('#refresh').addEventListener('click', function () { sheet(false); refresh().then(function () { toast('已刷新'); }); });
  function confirmBox(t) { return new Promise(function (res) { $('#ctext').textContent = t; $('#confirm').hidden = false; $('#cyes').onclick = function () { $('#confirm').hidden = true; res(true); }; $('#cno').onclick = function () { $('#confirm').hidden = true; res(false); }; }); }
  $('#clearAll').addEventListener('click', function () {
    sheet(false); confirmBox('清空全部内容（含永久保留）？').then(function (ok) { if (!ok) return;
      req('/items', { method: 'DELETE' }).then(function () { removeIds(Object.keys(items)); used = 0; usage(); toast('已清空'); }).catch(function () {}); });
  });
  $('#logout').addEventListener('click', function () {
    sheet(false); req('/logout', { method: 'POST' }).finally(function () { list.innerHTML = ''; items = {}; firstRender = true; showLogin(); toast('已退出'); });
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { sheet(false); if (!$('#viewer').hidden) $('#viewer').click(); } });

  /* ---------- 启动 ---------- */
  req('/me').then(function (j) { LIMITS = j.limits; if (j.authed) start(); else showLogin(); }).catch(function () { showLogin(); });
  window.__transfer = { refresh: refresh, items: items };
})();
