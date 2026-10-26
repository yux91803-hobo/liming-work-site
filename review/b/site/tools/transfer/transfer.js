(function () {
  'use strict';
  var API = '/api/transfer';
  var $ = function (s) { return document.querySelector(s); };
  var html = document.documentElement, embedded = html.classList.contains('embed');
  function ls(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } }
  // 未完成上传的本地记录（刷新/被 iOS 回收后可续传）：{ id: { name, size, lm, cs, n, fp, t } }
  var PK = 'lm.tx.pending';
  function pend() { try { return JSON.parse(ls(PK) || '{}') || {}; } catch (e) { return {}; } }
  function setPend(id, v) { var p = pend(); if (v) p[id] = v; else if (p[id]) delete p[id]; else return; ls(PK, JSON.stringify(p)); }
  // 文件指纹：首尾各 64KB 的 SHA-256（iOS 相册重新选择时 lastModified 可能变化，用它兜底）
  function fingerprint(f) {
    try {
      var k = 65536, parts = f.size <= 2 * k ? [f] : [f.slice(0, k), f.slice(f.size - k)];
      return new Blob(parts).arrayBuffer().then(function (b) { return crypto.subtle.digest('SHA-256', b); })
        .then(function (h) { return Array.prototype.map.call(new Uint8Array(h), function (x) { return ('0' + x.toString(16)).slice(-2); }).join(''); })
        .catch(function () { return ''; });
    } catch (e) { return Promise.resolve(''); }
  }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  /* 主题（与工具箱同步） */
  var mq = matchMedia('(prefers-color-scheme: dark)');
  function onTheme() { var t = ls('lm.theme') || 'light'; var d = t === 'dark' || (t === 'auto' && mq.matches); html.dataset.theme = d ? 'dark' : 'light'; if (!embedded) document.querySelector('meta[name=theme-color]').content = d ? '#0d1117' : '#f5f6f8'; }
  onTheme(); mq.addEventListener && mq.addEventListener('change', onTheme);
  window.addEventListener('storage', function (e) { if (e.key === 'lm.theme') onTheme(); });
  window.addEventListener('message', function (e) {
    if (e.origin !== location.origin || !e.data) return;
    if (e.data.type === 'theme') onTheme();
    else if (e.data.type === 'moving') html.classList.toggle('moving', !!e.data.on); // 外壳转场期间：关掉动画/模糊
  });
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
  var skew = 0; // 服务器时间 - 本机时间（手机时间不准时倒计时也正确）
  function now() { return Date.now() + skew; }
  function ago(t) { var s = (now() - t) / 1000; if (s < 60) return '刚刚'; if (s < 3600) return Math.floor(s / 60) + ' 分钟前'; if (s < 86400) return Math.floor(s / 3600) + ' 小时前'; var d = new Date(t); return (d.getMonth() + 1) + '月' + d.getDate() + '日'; }
  function left(e) { var s = (e - now()) / 1000; if (s <= 0) return '即将删除'; if (s < 3600) return Math.ceil(s / 60) + ' 分钟后删除'; return Math.ceil(s / 3600) + ' 小时后删除'; }
  var ERR = { file_too_large: '文件超过上限', space_full: '空间已满，请先删除一些', text_too_large: '文字太长', too_many: '条目太多，请先清理', rate_limited: '尝试过多，请稍后再试', bad_password: '密码不对', not_configured: '服务未配置' };

  /* ---------- 登录 ---------- */
  var LIMITS = null;
  function showLogin() { ls('lm.tx.authed', ''); try { sessionStorage.removeItem('lm.tx.cache'); } catch (e) {} $('#app').hidden = true; $('#login').hidden = false; stopLive(); setTimeout(function () { $('#pw').focus(); }, 300); ready(); }
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
      th = '<div class="th"' + (!it.thumb && it.done && isImg(it) ? ' data-a="view"' : '') + '>' + (it.thumb ? '<img src="' + it.thumb + '" alt="" data-a="view">' : esc(ext(it.name))) + '</div>';
      body = '<div class="nm">' + esc(it.name) + '</div>';
      if (it.done) acts = '<button class="ab main" data-a="save" aria-label="保存">' + (isIOS && canShareFiles && it.size <= 50 * 1048576 ? IC.share : IC.dl) + '</button>';
    }
    var pct = up ? up.pct : (it.chunks ? it.got / it.chunks : 1);
    var meta = [];
    if (it.kind === 'file') meta.push(fmtSize(it.size));
    meta.push(esc(it.dev || '') + (it.dev ? ' · ' : '') + ago(it.created));
    meta.push(it.expires ? '<span>' + left(it.expires) + '</span>' : '<span class="keep">永久保留</span>');
    if (it.kind === 'file' && !it.done) {
      var paused = !up && pend()[it.id];
      meta = [fmtSize(it.size), up ? (up.failed ? '<span class="bad">已中断</span>' : '<span class="speed">' + Math.floor(pct * 100) + '%</span>')
        : paused ? '<span class="bad">已暂停，重新选择文件继续</span>' + (LIMITS && it.updated ? '<span>' + left(it.updated + LIMITS.stale).replace('删除', '清理') + '</span>' : '')
        : '<span>' + esc(it.dev || '') + ' 上传中 ' + Math.floor(pct * 100) + '%</span>'];
      var ctl = up ? (up.failed ? '<button class="ab main" data-a="retry" aria-label="重试">' + IC.retry + '</button>' : '') + '<button class="ab" data-a="cancel" aria-label="取消">' + IC.x + '</button>'
                   : (paused ? '<button class="ab main" data-a="resume" aria-label="选择文件继续">' + IC.retry + '</button>' : '') + '<button class="ab" data-a="del" aria-label="删除">' + IC.del + '</button>';
      li.innerHTML = th + '<div class="bd">' + body + '<div class="mt">' + meta.join('<span>·</span>') + '</div><div class="prog' + ((up && up.failed) || paused ? ' bad' : '') + '"><i style="width:' + (pct * 100).toFixed(1) + '%"></i></div></div><div class="acts">' + ctl + '</div>';
      return;
    }
    li.innerHTML = th + '<div class="bd">' + body + '<div class="mt">' + meta.join('<span>·</span>') + '</div></div>' +
      '<div class="acts">' + acts +
      '<button class="ab' + (it.expires ? '' : ' on') + '" data-a="keep" aria-label="' + (it.expires ? '永久保留' : '取消永久') + '">' + (it.expires ? IC.pin : IC.pinOn) + '</button>' +
      '<button class="ab" data-a="del" aria-label="删除">' + IC.del + '</button></div>';
  }
  var sigs = {};
  function upsert(it, isNew) {
    var had = !!items[it.id]; items[it.id] = it;
    var li = list.querySelector('[data-id="' + it.id + '"]');
    var old = sigs[it.id], sig = JSON.stringify(it); sigs[it.id] = sig;
    if (li && uploads[it.id]) { /* 本机正在上传：由 refill()/upBar() 负责，不覆盖速度显示 */ }
    else if (li && old === sig) { /* 未变化：不重绘，保留选区/按钮状态/缩略图 */ }
    else if (li) { var full = li.querySelector('.tx.full'); fill(li, it); if (full) li.querySelector('.tx').classList.add('full'); }
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
      delete items[id]; setPend(id, null); var li = list.querySelector('[data-id="' + id + '"]'); if (!li) return;
      li.style.height = li.offsetHeight + 'px'; li.classList.add('out');
      li.dataset.id = ''; // 让 300ms 内重新 upsert 的同 id 条目新建节点，而不是被这里删掉
      setTimeout(function () { li.remove(); checkEmpty(); }, 300);
    });
  }
  function checkEmpty() { $('#empty').hidden = list.children.length > 0; }
  function render(data) {
    LIMITS = data.limits; used = data.used; if (data.now) skew = data.now - Date.now(); usage();
    if (!data.cached) { ls('lm.tx.authed', '1'); cacheList(data); }
    var ids = {}; data.items.forEach(function (it) { ids[it.id] = 1; });
    var pd = pend(); Object.keys(pd).forEach(function (id) { var s0 = data.items.filter(function (x) { return x.id === id; })[0]; if (!s0 || s0.done) setPend(id, null); });
    removeIds(Object.keys(items).filter(function (id) { return !ids[id] && !uploads[id]; }));
    data.items.slice().reverse().forEach(function (it, i) {
      var li = list.querySelector('[data-id="' + it.id + '"]');
      if (!li && firstRender) { items[it.id] = it; li = itemEl(it); li.style.animationDelay = Math.min(i, 8) * 35 + 'ms'; insertSorted(li, it); }
      else upsert(it, !firstRender);
    });
    firstRender = false; checkEmpty();
  }
  // 乐观渲染：上次已登录 → 先用本标签页缓存的列表画出界面，再后台校验
  function cacheList(data) {
    try {
      var j = JSON.stringify({ items: data.items, used: data.used, limits: data.limits, now: data.now, cached: 1 });
      if (j.length > 1500000) j = JSON.stringify({ items: data.items.map(function (x) { var y = Object.assign({}, x); y.thumb = null; return y; }), used: data.used, limits: data.limits, now: data.now, cached: 1 });
      sessionStorage.setItem('lm.tx.cache', j);
    } catch (e) {}
  }
  function usage() {
    if (!LIMITS) return;
    $('#usedBar').style.width = Math.min(100, used / LIMITS.spaceMax * 100) + '%';
    $('#usedTxt').textContent = fmtSize(used) + ' / ' + fmtSize(LIMITS.spaceMax) + ' · 单文件 ' + fmtSize(LIMITS.fileMax);
    $('#limitsTxt').textContent = '单文件上限 ' + fmtSize(LIMITS.fileMax) + '，总空间 ' + fmtSize(LIMITS.spaceMax) + '。上传中断可续传。内容默认 24 小时后自动删除，点 ☆ 可永久保留。';
  }
  function refresh() { return req('/items').then(render).catch(function () {}); }
  setInterval(function () { var gone = Object.keys(items).filter(function (k) { return items[k].expires && items[k].expires <= now() && !uploads[k]; }); if (gone.length) { removeIds(gone); recalcUsed(); } list.querySelectorAll('.it').forEach(function (li) { var it = items[li.dataset.id]; if (it && !uploads[it.id]) { var mt = li.querySelector('.mt'); if (mt) { var tmp = document.createElement('li'); fill(tmp, it); mt.innerHTML = tmp.querySelector('.mt').innerHTML; } } }); }, 60000);

  /* ---------- 实时：WebSocket，失败则轮询 ---------- */
  var ws = null, wsFails = 0, pollT = null, pingT = null, live = $('#live'), running = false, reT = null, pongT = null, lastMsg = 0;
  function connect() {
    clearTimeout(reT); reT = null;
    if (!running || (ws && ws.readyState <= 1)) return;
    try { ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + API + '/ws'); } catch (e) { return poll(); }
    var me = ws;
    ws.onopen = function () { lastMsg = Date.now(); wsFails = 0; live.className = 'live on'; clearInterval(pollT); pollT = null; refresh(); clearInterval(pingT); pingT = setInterval(function () { ping(10000); }, 25000); };
    ws.onmessage = function (e) {
      lastMsg = Date.now(); clearTimeout(pongT); pongT = null;
      var m; try { m = JSON.parse(e.data); } catch (x) { return; }
      if (m.type === 'item') { if (!uploads[m.item.id]) { var had = upsert(m.item, true); if (!had && m.item.kind === 'text' && m.item.dev !== DEV) navigator.vibrate && navigator.vibrate(10); } else items[m.item.id] = m.item; recalcUsed(); }
      else if (m.type === 'progress') { var it = items[m.id]; if (it && !uploads[m.id]) { it.got = m.got; it.chunks = m.chunks; var li2 = list.querySelector('[data-id="' + m.id + '"]'); if (li2) fill(li2, it); } }
      else if (m.type === 'removed') { removeIds(m.ids); recalcUsed(); }
      else if (m.type === 'cleared') { removeIds(Object.keys(items)); used = 0; usage(); }
    };
    ws.onclose = function () { if (me !== ws) return; clearInterval(pingT); clearTimeout(pongT); ws = null; if (!running) return; wsFails++; live.className = 'live poll'; poll(); clearTimeout(reT); reT = setTimeout(connect, Math.min(30000, 1000 * Math.pow(2, wsFails))); };
  }
  // 心跳：ping 后 wait 毫秒内没有任何消息 → 认定「假在线」，关掉重连（服务端 DO 用 setWebSocketAutoResponse 应答，不会被唤醒）
  function ping(wait) {
    if (!ws || ws.readyState !== 1) return;
    try { ws.send('ping'); } catch (e) {}
    if (pongT) return; var s0 = ws;
    pongT = setTimeout(function () { pongT = null; if (s0 === ws) kick(); }, wait);
  }
  function kick() { var s0 = ws; ws = null; clearInterval(pingT); clearTimeout(pongT); pongT = null; if (s0) { s0.onclose = null; try { s0.close(); } catch (e) {} } connect(); }
  function dropWs() { var s0 = ws; ws = null; clearInterval(pingT); clearTimeout(pongT); pongT = null; clearTimeout(reT); if (s0) { s0.onclose = null; try { s0.close(); } catch (e) {} } }
  function recalcUsed() { used = 0; for (var id in items) if (items[id].kind === 'file') used += items[id].size; usage(); }
  function poll() { if (pollT || !running) return; pollT = setInterval(function () { if (!document.hidden) refresh(); }, 4000); }
  function stopLive() { running = false; clearInterval(pollT); pollT = null; clearInterval(pingT); clearTimeout(reT); clearTimeout(pongT); if (ws) try { ws.close(); } catch (e) {} ws = null; }
  // 回到前台 / bfcache 恢复 / 网络恢复：刷新列表，自动续传中断的分块，检查 socket 是否「假在线」
  function wake() {
    if (document.hidden || !running) return;
    refresh();
    Object.keys(uploads).forEach(function (k) { if (uploads[k].failed && !uploads[k].cancel) resume(k); });
    if (!ws) return connect();
    if (ws.readyState === 1) ping(Date.now() - lastMsg > 30000 ? 4000 : 10000);
  }
  document.addEventListener('visibilitychange', wake);
  window.addEventListener('online', function () { if (ws && ws.readyState !== 1) kick(); else wake(); });
  // pagehide 时主动关闭 socket，页面才能进 bfcache；恢复时重新连接
  window.addEventListener('pagehide', function () { if (running) { dropWs(); clearInterval(pollT); pollT = null; } });
  window.addEventListener('pageshow', function (e) { if (e.persisted) { document.documentElement.classList.add('vt'); setTimeout(function () { document.documentElement.classList.remove('vt'); }, 800); wake(); } });

  function start() {
    $('#login').hidden = true; $('#app').hidden = false; running = true;
    requestAnimationFrame(ready); refresh(); connect(); // 界面骨架已画好就通知外壳，不等网络
  }

  /* ---------- 发送文字 ---------- */
  var ta = $('#text'), sendBtn = $('#send');
  function grow() { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, innerHeight * 0.4) + 'px'; sendBtn.disabled = !ta.value.trim(); }
  ta.addEventListener('input', grow);
  ta.addEventListener('keydown', function (e) { if (e.isComposing || e.keyCode === 229) return; if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || (!e.shiftKey && !isIOS && matchMedia('(hover:hover)').matches))) { e.preventDefault(); sendText(); } });
  sendBtn.addEventListener('click', sendText);
  var sending = false;
  function sendText() {
    var t = ta.value; if (!t.trim() || sending) return; // 防止 Enter / ⌘Enter / 按钮连发
    sending = true; sendBtn.disabled = true;
    req('/items/text', { method: 'POST', json: { text: t } }).then(function (j) { if (ta.value === t) ta.value = ''; grow(); upsert(j.item, true); toast('已发送'); })
      .catch(function (e) { if (e.message !== 'auth') toast(ERR[e.message] || '发送失败'); grow(); })
      .finally(function () { sending = false; grow(); });
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
        // 长边 ≤ 240：保证 dataURL 不超过服务端 thumbMax（原先按短边 200 缩放，长图的长边会很大，超限后预览图被丢弃）
        var s = Math.min(1, 240 / Math.max(img.naturalWidth, img.naturalHeight)), c = document.createElement('canvas');
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
      x.onload = function () { if (x.status === 401) { showLogin(); rej(new Error('auth')); } else if (x.status >= 200 && x.status < 300) res(); else { var e = new Error('http' + x.status); e.status = x.status; try { e.code = JSON.parse(x.responseText).error; } catch (z) {} rej(e); } };
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
      var rec = { name: f.name, size: f.size, lm: f.lastModified, cs: j.chunk, n: it.chunks, t: Date.now() };
      setPend(it.id, rec); fingerprint(f).then(function (fp) { if (fp && pend()[it.id]) { rec.fp = fp; setPend(it.id, rec); } });
      upsert(it, true);
      return run(it.id);
    }).catch(function (e) { if (e.message !== 'auth') toast(ERR[e.message] || '上传失败'); });
  }
  function upBar(id) {
    var U = uploads[id]; if (!U) return;
    var sum = U.loaded.reduce(function (a, b) { return a + b; }, 0); U.pct = sum / U.f.size;
    var li = list.querySelector('[data-id="' + id + '"]'); if (!li) return;
    var b = li.querySelector('.prog i'); if (b) b.style.width = (U.pct * 100).toFixed(1) + '%';
    // 速度取最近 4 秒的滑动窗口（之前是自开始以来的平均值，网络变化时很久才反映出来）
    var t = Date.now(), S = U.samples || (U.samples = []); S.push([t, sum]); while (S.length > 2 && t - S[1][0] > 4000) S.shift();
    var sp = li.querySelector('.speed'); if (sp) { var dt = (t - S[0][0]) / 1000, v = dt > 0.8 ? Math.max(0, sum - S[0][1]) / dt : 0;
      sp.textContent = Math.floor(U.pct * 100) + '%' + (v ? ' · ' + fmtSize(v) + '/s' : '') + (v && U.pct < 1 ? ' · 剩 ' + eta((U.f.size - sum) / v) : ''); }
  }
  function eta(s) { return s < 60 ? Math.ceil(s) + ' 秒' : s < 3600 ? Math.ceil(s / 60) + ' 分钟' : (s / 3600).toFixed(1) + ' 小时'; }
  // 分块并发上传（3 路），失败分块自动重试 4 次；仍失败则可手动「重试」续传
  // 全局并发上限：所有文件加起来最多 3 个分块请求同时在传
  var slots = 3, waiters = [];
  function acquire() { return new Promise(function (r) { if (slots > 0) { slots--; r(); } else waiters.push(r); }); }
  function release() { var w = waiters.shift(); if (w) w(); else slots++; }
  function run(id) {
    var U = uploads[id], it = items[id]; if (!U || U.running) return Promise.resolve(); // 防止「重试」和自动续传同时触发两轮
    var gen = U.gen = (U.gen || 0) + 1; U.running = true;
    U.failed = false; U.cancel = false;
    for (var k = 0; k < U.n; k++) if (!U.doneSet[k]) U.loaded[k] = 0; // 未完成分块的进度清零，避免进度条虚高
    U.samples = []; refill(id); guard();
    // 本轮已过时（取消/失败/又开了新一轮）：旧的 worker、退避定时器都直接退出
    var stale = function () { return U.cancel || U.failed || U.gen !== gen || uploads[id] !== U; };
    var queue = []; for (var i = 0; i < U.n; i++) if (!U.doneSet[i]) queue.push(i);
    function worker() {
      if (stale() || !queue.length) return Promise.resolve();
      var i = queue.shift(), blob = U.f.slice(i * U.cs, Math.min(U.f.size, (i + 1) * U.cs)), tries = 0;
      var go = function () {
        if (stale()) return Promise.reject(new Error('cancel'));
        return acquire().then(function () {
          if (stale()) { release(); throw new Error('cancel'); }
          return put(API + '/items/' + id + '/chunk/' + i, blob, function (l) { U.loaded[i] = l; upBar(id); }, U).then(function () { release(); }, function (e) { release(); throw e; });
        }).catch(function (e) {
          if (e.message === 'auth' || e.message === 'cancel' || e.status === 404 || (e.status === 400 && e.code !== 'bad_length')) throw e;
          // iOS 切到后台时请求会被挂起/中断：不计重试次数，等回到前台再继续
          if (document.hidden) { U.loaded[i] = 0; return whenVisible().then(go); }
          if (++tries > 4) throw e;
          U.loaded[i] = 0; return new Promise(function (r) { setTimeout(r, 1000 * tries); }).then(go);
        });
      };
      return go().then(function () { U.doneSet[i] = 1; U.loaded[i] = blob.size; upBar(id); return worker(); });
    }
    return Promise.all([worker(), worker(), worker()]).then(function () {
      if (U.gen === gen) U.running = false;
      if (stale()) return;
      delete uploads[id]; guard(); setPend(id, null); it = items[id] || it; it.done = true; it.got = U.n; upsert(it); recalcUsed(); toast('已上传');
    }).catch(function (e) {
      if (U.gen !== gen) return; U.running = false;
      if (U.cancel || e.message === 'cancel') return;
      if (e.message === 'auth') { U.failed = true; U.xhrs.forEach(function (x) { x.abort(); }); refill(id); guard(); return; } // 显示「重试」，并解除 beforeunload 拦截
      if (e.status === 404) { delete uploads[id]; setPend(id, null); removeIds([id]); guard(); toast('上传已被取消'); return; }
      U.failed = true; U.xhrs.forEach(function (x) { x.abort(); }); refill(id); guard(); toast(document.hidden ? '上传已暂停' : '上传中断，可点重试续传');
    });
  }
  function whenVisible() { return new Promise(function (r) { if (!document.hidden) return r(); var h = function () { if (!document.hidden) { document.removeEventListener('visibilitychange', h); r(); } }; document.addEventListener('visibilitychange', h); }); }
  // 向服务器确认哪些分块已收到，只补传缺的
  function syncChunks(id) {
    var U = uploads[id]; if (!U) return Promise.resolve(false);
    return req('/items/' + id + '/chunks').then(function (j) {
      if (j.chunk !== U.cs || j.chunks !== U.n) throw new Error('mismatch');
      U.doneSet = {}; U.loaded = new Array(U.n).fill(0);
      j.have.forEach(function (i) { U.doneSet[i] = 1; U.loaded[i] = Math.min(U.cs, U.f.size - i * U.cs); });
      return true;
    }).catch(function (e) {
      if (e.status === 404) { delete uploads[id]; setPend(id, null); removeIds([id]); toast('上传已过期被清理，请重新上传'); return false; }
      if (e.message === 'mismatch') { delete uploads[id]; setPend(id, null); refill(id); toast('无法续传，请删除后重新上传'); return false; }
      return true; // 网络问题：照常 run，失败分块会重试
    });
  }
  function resume(id) { return syncChunks(id).then(function (ok) { if (ok && uploads[id]) return run(id); }); }
  // 刷新后续传：用户重新选择同一个文件（名称+大小+修改时间，或首尾指纹一致）
  function pickToResume(id) {
    var P = pend()[id]; if (!P) return;
    var inp = document.createElement('input'); inp.type = 'file'; inp.style.display = 'none'; document.body.appendChild(inp);
    inp.addEventListener('change', function () {
      var f = inp.files && inp.files[0]; inp.remove(); if (!f) return;
      if (f.name !== P.name || f.size !== P.size) { toast('不是同一个文件（需「' + P.name + '」）'); return; }
      (f.lastModified === P.lm || !P.fp ? Promise.resolve(f.lastModified === P.lm) : fingerprint(f).then(function (fp) { return fp === P.fp; })).then(function (same) {
        if (!same) { toast('文件内容不一致，无法续传'); return; }
        uploads[id] = { pct: 0, f: f, cs: P.cs, n: P.n, loaded: new Array(P.n).fill(0), doneSet: {}, xhrs: new Set(), t0: Date.now(), b0: 0 };
        refill(id); resume(id);
      });
    });
    inp.click();
  }
  function cancelUpload(id) {
    var U = uploads[id]; if (U) { U.cancel = true; U.xhrs.forEach(function (x) { x.abort(); }); delete uploads[id]; } setPend(id, null); guard();
    req('/items/' + id, { method: 'DELETE' }).catch(function () {}); removeIds([id]); recalcUsed(); toast('已取消');
  }
  function refill(id) { var li = list.querySelector('[data-id="' + id + '"]'), it = items[id]; if (li && it) { fill(li, it); upBar(id); } }
  // 只在确有上传进行中时才挂 beforeunload（常驻的 beforeunload 会让页面无法进入 bfcache，返回时整页重载/闪白）
  var guarded = false;
  function onBU(e) { e.preventDefault(); e.returnValue = ''; }
  function guard() { var on = Object.keys(uploads).some(function (k) { return !uploads[k].failed; }); if (on !== guarded) { guarded = on; window[on ? 'addEventListener' : 'removeEventListener']('beforeunload', onBU); } }

  // 拖拽 & 粘贴
  var dragN = 0, dragT = null;
  function hasFiles(e) { return e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') > -1; }
  function dragOff() { dragN = 0; clearTimeout(dragT); document.body.classList.remove('dragging'); }
  function appOn() { return !$('#app').hidden; }
  document.addEventListener('dragenter', function (e) { if (!hasFiles(e) || !appOn()) return; e.preventDefault(); dragN++; document.body.classList.add('dragging'); });
  // dragover 会持续触发；300ms 没有 dragover（拖出窗口、Esc 取消）就收起遮罩
  document.addEventListener('dragover', function (e) { if (!appOn()) return; e.preventDefault(); if (hasFiles(e)) { clearTimeout(dragT); dragT = setTimeout(dragOff, 300); } });
  document.addEventListener('dragleave', function (e) { if (!e.relatedTarget || --dragN <= 0) dragOff(); });
  document.addEventListener('drop', function (e) {
    if (!appOn()) return; e.preventDefault(); dragOff(); // 应用可见时拦截所有 drop，避免浏览器跳转打开文件
    var dt = e.dataTransfer; if (!dt) return;
    var its = Array.prototype.slice.call(dt.items || []), files = [], dirs = 0;
    if (its.length && its[0].webkitGetAsEntry) {
      its.forEach(function (x) { if (x.kind !== 'file') return; var en = x.webkitGetAsEntry && x.webkitGetAsEntry(); if (en && en.isDirectory) { dirs++; return; } var f = x.getAsFile(); if (f) files.push(f); });
    } else files = Array.prototype.slice.call(dt.files || []);
    if (dirs) toast('暂不支持文件夹，请拖入文件（或先压缩）');
    if (files.length) return addFiles(files.map(renamePasted));
    var t = dt.getData('text/uri-list') || dt.getData('text/plain'); if (t && !dirs) insertText(t.replace(/^#.*$/gm, '').trim() || t);
  });
  function stamp() { var d = new Date(), p = function (n) { return ('0' + n).slice(-2); }; return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()); }
  // iOS 粘贴/拖入的图片统一叫 image.png / image.jpeg：改成本地时间命名，避免同名
  function renamePasted(f, i) {
    if (f.name && !/^image\.\w+$/i.test(f.name)) return f;
    var e = (f.name && /\.(\w+)$/.exec(f.name) || [])[1] || (f.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
    return new File([f], '粘贴图片-' + stamp() + (i ? '-' + i : '') + '.' + e.toLowerCase(), { type: f.type, lastModified: f.lastModified });
  }
  function insertText(t) { ta.value = ta.value.trim() ? ta.value.replace(/\s+$/, '') + '\n' + t : t; grow(); ta.focus(); }
  document.addEventListener('paste', function (e) {
    if (!appOn() || !e.clipboardData) return;
    var files = Array.prototype.slice.call(e.clipboardData.files || []), t = e.clipboardData.getData('text');
    if (files.length) { e.preventDefault(); addFiles(files.map(renamePasted)); if (t && t.trim()) insertText(t); return; } // 图文同时存在时，文字也保留
    if (document.activeElement !== ta && t) { e.preventDefault(); insertText(t); } // 输入框未聚焦：追加而不是覆盖草稿
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
    else if (a === 'view' && !it.done) return;
    else if (a === 'view') { $('#vimg').src = raw(it); $('#vhint').hidden = !isIOS; $('#viewer').hidden = false; document.body.classList.add('noscroll'); }
    else if (a === 'save') save(it, b);
    else if (a === 'cancel') cancelUpload(it.id);
    else if (a === 'retry') resume(it.id);
    else if (a === 'resume') pickToResume(it.id);
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
  var freeT = null;
  function freeFetched() { clearTimeout(freeT); fetched = {}; list.querySelectorAll('.ab.ready').forEach(function (x) { x.classList.remove('ready'); x.innerHTML = IC.share; }); }
  function shareFile(f) { return navigator.share({ files: [f] }).then(freeFetched, function (e) { if (e && e.name === 'AbortError') return; throw e; }); }
  function save(it, b) {
    // iPhone：先取回文件，再用系统分享面板（可「存储图像」/「存储到文件」）；50MB 以上直接走下载，避免占满内存
    if (isIOS && canShareFiles && it.size <= 50 * 1048576) {
      var f = fetched[it.id];
      if (f) { return shareFile(f).catch(function () { freeFetched(); location.href = raw(it, true); }); }
      b.classList.add('busy'); b.innerHTML = IC.spin;
      fetch(raw(it), { credentials: 'same-origin' }).then(function (r) {
        if (r.status === 404) { var e = new Error('gone'); throw e; }
        if (!r.ok) throw new Error('http'); return r.blob();
      }).then(function (bl) {
        freeFetched(); // 只缓存一个；分享完成或 60 秒后释放
        f = fetched[it.id] = new File([bl], it.name, { type: it.mime }); freeT = setTimeout(freeFetched, 60000);
        b.classList.remove('busy'); b.innerHTML = IC.share;
        shareFile(f).catch(function (e) {
          // 异步取回后用户手势已失效：把按钮变成明确的「点此保存」，而不是只弹一个 toast
          if (e && e.name === 'NotAllowedError') { b.classList.add('ready'); b.innerHTML = '点此保存'; }
          else { freeFetched(); location.href = raw(it, true); }
        });
      }).catch(function (e) {
        b.classList.remove('busy'); b.innerHTML = IC.share;
        if (e.message === 'gone') { toast('文件已删除'); removeIds([it.id]); recalcUsed(); return; } // 不跳到 JSON 错误页
        location.href = raw(it, true);
      });
      return;
    }
    if (!it.done) return;
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
    sheet(false);
    var act = Object.keys(uploads); act.forEach(function (id) { var U = uploads[id]; U.cancel = true; U.xhrs.forEach(function (x) { x.abort(); }); delete uploads[id]; setPend(id, null); }); guard();
    Promise.all(act.map(function (id) { return req('/items/' + id, { method: 'DELETE' }).catch(function () {}); }))
      .then(function () { return req('/logout', { method: 'POST' }); }).finally(function () { list.innerHTML = ''; items = {}; firstRender = true; showLogin(); toast('已退出'); });
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { sheet(false); if (!$('#viewer').hidden) $('#viewer').click(); } });

  /* ---------- 启动 ---------- */
  var cached = null;
  if (ls('lm.tx.authed') === '1') { try { cached = JSON.parse(sessionStorage.getItem('lm.tx.cache') || 'null'); } catch (e) {} }
  if (ls('lm.tx.authed') === '1') {
    // 上次是登录状态：立即画出界面（有缓存就用缓存列表），马上通知外壳 ready，然后后台校验 /me
    $('#login').hidden = true; $('#app').hidden = false; if (cached) { firstRender = false; html.classList.add('vt'); render(cached); setTimeout(function () { html.classList.remove('vt'); }, 800); }
    requestAnimationFrame(ready);
  }
  req('/me').then(function (j) { LIMITS = j.limits; if (j.now) skew = j.now - Date.now(); if (j.authed) start(); else showLogin(); }).catch(function () { if (cached) start(); else showLogin(); });
  window.__transfer = { refresh: refresh, items: items };
})();
