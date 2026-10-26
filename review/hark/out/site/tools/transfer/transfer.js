(function () {
  'use strict';
  var API = '/api/transfer';
  var $ = function (s) { return document.querySelector(s); };
  var html = document.documentElement, embedded = html.classList.contains('embed');
  function ls(k, v) { try { if (v === undefined) return localStorage.getItem(k); if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { return null; } }
  function ss(k, v) { try { if (v === undefined) return sessionStorage.getItem(k); if (v === null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, v); } catch (e) { return null; } }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  /* 主题（与工具箱同步） */
  var mq = matchMedia('(prefers-color-scheme: dark)');
  function onTheme() { var t = ls('lm.theme') || 'light'; var d = t === 'dark' || (t === 'auto' && mq.matches); html.dataset.theme = d ? 'dark' : 'light'; document.querySelector('meta[name=theme-color]').content = d ? '#0d1117' : '#f5f6f8'; }
  onTheme(); mq.addEventListener && mq.addEventListener('change', onTheme);
  window.addEventListener('storage', function (e) { if (e.key === 'lm.theme') onTheme(); });
  window.addEventListener('message', function (e) { if (e.origin === location.origin && e.data && e.data.type === 'theme') onTheme(); });
  var readySent = false;
  function ready() { if (readySent) return; readySent = true; if (embedded) try { parent.postMessage({ type: 'ready' }, location.origin); } catch (e) {} }

  var ua = navigator.userAgent;
  var isIOS = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  var DEV = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) || (isIOS && /Macintosh/.test(ua)) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : '电脑';
  var SHARE_MAX = 50 * 1048576;   // iPhone 走系统分享面板的上限（整份文件要读进内存）

  /* 服务器时间偏差：倒计时/过期按服务器时间算，手机时钟不准也不会显示错 */
  var skew = 0;
  function now() { return Date.now() + skew; }
  function setSkew(t) { if (t) skew = t - Date.now(); }

  var tt;
  function toast(m) { var t = $('#toast'); t.textContent = m; t.classList.add('show'); clearTimeout(tt); tt = setTimeout(function () { t.classList.remove('show'); }, 1800); }
  function req(path, o) {
    o = o || {}; o.headers = Object.assign({ 'X-Device': encodeURIComponent(DEV) }, o.headers || {});
    if (o.json !== undefined) { o.body = JSON.stringify(o.json); o.headers['Content-Type'] = 'application/json'; delete o.json; }
    o.credentials = 'same-origin';
    return fetch(API + path, o).then(function (r) {
      if (r.status === 401 && path !== '/login') { showLogin(); throw new Error('auth'); }
      return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) { var e = new Error(j.error || 'http'); e.status = r.status; e.data = j; throw e; } return j; });
    });
  }
  function fmtSize(n) { if (n < 1024) return Math.round(n) + ' B'; if (n < 1048576) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB'; if (n < 1073741824) return (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + ' MB'; return parseFloat((n / 1073741824).toFixed(1)) + ' GB'; }
  function ago(t) { var s = (now() - t) / 1000; if (s < 60) return '刚刚'; if (s < 3600) return Math.floor(s / 60) + ' 分钟前'; if (s < 86400) return Math.floor(s / 3600) + ' 小时前'; var d = new Date(t); return (d.getMonth() + 1) + '月' + d.getDate() + '日'; }
  function left(e) { var s = (e - now()) / 1000; if (s <= 0) return '即将删除'; if (s < 3600) return Math.ceil(s / 60) + ' 分钟后删除'; return Math.ceil(s / 3600) + ' 小时后删除'; }
  var ERR = { file_too_large: '文件超过上限', space_full: '空间已满，请先删除一些', text_too_large: '文字太长', too_many: '条目太多，请先清理', rate_limited: '尝试过多，请稍后再试', bad_password: '密码不对', not_configured: '服务未配置' };

  /* ---------- 登录 ---------- */
  var LIMITS = null;
  function showLogin() {
    ls('lm.tx.authed', null); ss('lm.tx.cache', null);
    $('#app').hidden = true; $('#login').hidden = false; stopLive();
    if (!isIOS) setTimeout(function () { $('#pw').focus(); }, 300);   // iOS 无手势时不会弹键盘，反而触发视口滚动
    ready();
  }
  $('#loginForm').addEventListener('submit', function (e) {
    e.preventDefault(); var pw = $('#pw').value; if (!pw) return;
    $('#go').classList.add('wait'); $('#lerr').textContent = '';
    req('/login', { method: 'POST', json: { password: pw } }).then(function () {
      $('#pw').value = ''; $('#pw').blur(); start();
      resumeFailed(true);   // 登录过期中断的上传，重新登录后自动续传
    }).catch(function (er) {
      var m = ERR[er.message] || '登录失败';
      if (er.message === 'rate_limited' && er.data && er.data.retry) m += '（' + Math.ceil(er.data.retry / 60) + ' 分钟）';
      $('#lerr').textContent = m; var c = $('.lcard'); c.classList.remove('shake'); void c.offsetWidth; c.classList.add('shake'); $('#pw').select();
    }).finally(function () { $('#go').classList.remove('wait'); });
  });

  /* ---------- 列表 ---------- */
  var items = {}, uploads = {}, list = $('#list'), used = 0, firstRender = true;
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
    resume: '<svg viewBox="0 0 24 24"><path d="M12 16V4M7 9l5-5 5 5"/><path d="M5 15v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3"/></svg>',
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
  function canShare(it) { return isIOS && canShareFiles && it.size <= SHARE_MAX; }
  // 别处（或本页重载前）开始、已 2 分钟没进展的未完成上传，可以在这台设备上续传
  function resumable(it) { return it.kind === 'file' && !it.done && !uploads[it.id] && now() - (it.updated || it.created) > 120000; }

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
      var viewable = it.done && isImg(it);
      th = '<div class="th"' + (viewable && !it.thumb ? ' data-a="view"' : '') + '>' + (it.thumb ? '<img src="' + it.thumb + '" alt="" data-a="view">' : esc(ext(it.name))) + '</div>';
      body = '<div class="nm">' + esc(it.name) + '</div>';
      if (it.done) {
        var rdy = shareCache && shareCache.id === it.id;
        acts = '<button class="ab main' + (rdy ? ' rdy' : '') + '" data-a="save" aria-label="' + (rdy ? '已就绪，点此保存' : '保存') + '">' + (canShare(it) ? IC.share : IC.dl) + '</button>';
      }
    }
    var pct = up ? up.pct : (it.chunks ? it.got / it.chunks : 1);
    var meta = [];
    if (it.kind === 'file') meta.push(fmtSize(it.size));
    meta.push(esc(it.dev || '') + (it.dev ? ' · ' : '') + ago(it.created));
    meta.push(it.expires ? '<span>' + left(it.expires) + '</span>' : '<span class="keep">永久保留</span>');
    if (it.kind === 'file' && !it.done) {
      var st;
      if (up) st = up.failed ? '<span class="bad">' + (up.authFail ? '登录已过期' : '已中断') + '</span>' : '<span class="speed">' + Math.floor(pct * 100) + '%</span>';
      else st = resumable(it) ? '<span class="bad">已中断 ' + Math.floor(pct * 100) + '%</span>' : '<span>' + esc(it.dev || '') + ' 上传中 ' + Math.floor(pct * 100) + '%</span>';
      meta = [fmtSize(it.size), st];
      var ctl = up ? (up.failed ? '<button class="ab main" data-a="retry" aria-label="重试">' + IC.retry + '</button>' : '') + '<button class="ab" data-a="cancel" aria-label="取消">' + IC.x + '</button>'
                   : (resumable(it) ? '<button class="ab main" data-a="resume" aria-label="选择同一文件继续上传">' + IC.resume + '</button>' : '') + '<button class="ab" data-a="del" aria-label="删除">' + IC.del + '</button>';
      li.innerHTML = th + '<div class="bd">' + body + '<div class="mt">' + meta.join('<span>·</span>') + '</div><div class="prog' + ((up && up.failed) || (!up && resumable(it)) ? ' bad' : '') + '"><i style="width:' + (pct * 100).toFixed(1) + '%"></i></div></div><div class="acts">' + ctl + '</div>';
      return;
    }
    li.innerHTML = th + '<div class="bd">' + body + '<div class="mt">' + meta.join('<span>·</span>') + '</div></div>' +
      '<div class="acts">' + acts +
      '<button class="ab' + (it.expires ? '' : ' on') + '" data-a="keep" aria-label="' + (it.expires ? '永久保留' : '取消永久') + '">' + (it.expires ? IC.pin : IC.pinOn) + '</button>' +
      '<button class="ab" data-a="del" aria-label="删除">' + IC.del + '</button></div>';
  }
  function liOf(id) { return list.querySelector('[data-id="' + id + '"]'); }
  function upsert(it, isNew) {
    var had = !!items[it.id]; items[it.id] = it;
    var li = liOf(it.id);
    if (li) { var full = li.querySelector('.tx.full'); fill(li, it); if (full) { var tx = li.querySelector('.tx'); if (tx) tx.classList.add('full'); } if (uploads[it.id]) upBar(it.id); }
    else { li = itemEl(it); if (isNew) li.classList.add('new'); insertSorted(li, it); if (uploads[it.id]) upBar(it.id); }
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
      delete items[id]; if (shareCache && shareCache.id === id) clearShare();
      var li = liOf(id); if (!li || li.classList.contains('out')) return;
      li.style.height = li.offsetHeight + 'px'; li.classList.add('out');
      var gone = false, fin = function () { if (gone) return; gone = true; li.remove(); checkEmpty(); };
      li.addEventListener('transitionend', fin); setTimeout(fin, 400);   // transitionend 兜底（页面冻结/减少动态时）
    });
  }
  function checkEmpty() { $('#empty').hidden = list.querySelectorAll('.it:not(.out)').length > 0; }
  function render(data, fromCache) {
    LIMITS = data.limits || LIMITS; used = data.used || 0; if (!fromCache) setSkew(data.now); usage();
    var ids = {}; data.items.forEach(function (it) { ids[it.id] = 1; });
    removeIds(Object.keys(items).filter(function (id) { return !ids[id] && !uploads[id]; }));
    // data.items 按时间倒序（最新在前）；只给最上面 8 条加错开的入场动画，其余直接出现
    data.items.slice().reverse().forEach(function (it, ri) {
      var pos = data.items.length - 1 - ri;
      if (uploads[it.id]) { items[it.id] = it; return; }   // 本机正在上传的条目由本地进度驱动，不重建 DOM（避免速度文字闪烁）
      var li = liOf(it.id);
      if (!li && firstRender) {
        items[it.id] = it; li = itemEl(it);
        if (pos < 8 && !html.classList.contains('vt')) li.style.animationDelay = pos * 35 + 'ms'; else li.classList.add('noanim');
        insertSorted(li, it);
      } else upsert(it, !firstRender);
    });
    if (!fromCache) { firstRender = false; saveCache(data); }
    checkEmpty();
  }
  // 上次列表缓存到 sessionStorage：再次打开时第一帧就有内容（避免转场时的空白首帧）
  function saveCache(data) {
    var out = [], size = 0;
    for (var i = 0; i < data.items.length && out.length < 60; i++) { var s = JSON.stringify(data.items[i]); if (size + s.length > 1500000) break; size += s.length; out.push(data.items[i]); }
    ss('lm.tx.cache', JSON.stringify({ items: out, used: data.used, limits: data.limits, now: data.now }));
  }
  function usage() {
    if (!LIMITS) return;
    $('#usedBar').style.width = Math.min(100, used / LIMITS.spaceMax * 100) + '%';
    $('#usedTxt').textContent = fmtSize(used) + ' / ' + fmtSize(LIMITS.spaceMax) + ' · 单文件 ' + fmtSize(LIMITS.fileMax);
    $('#limitsTxt').textContent = '单文件 ' + fmtSize(LIMITS.fileMax) + '，总空间 ' + fmtSize(LIMITS.spaceMax) + '。上传中断可续传（iPhone 上传时请保持本页在前台）。内容默认 24 小时后自动删除，点 ☆ 可永久保留。';
  }
  function refresh() { return req('/items').then(function (d) { render(d); }).catch(function () {}); }
  // 每分钟刷新相对时间，并移除已过期条目（WebSocket 不在线时也不会一直显示「即将删除」）
  function tick() {
    var expired = [];
    Object.keys(items).forEach(function (id) { var it = items[id]; if (it.expires && it.expires <= now() && !uploads[id]) expired.push(id); });
    if (expired.length) { removeIds(expired); recalcUsed(); }
    list.querySelectorAll('.it').forEach(function (li) {
      var it = items[li.dataset.id]; if (!it || uploads[it.id]) return;
      if (it.kind === 'file' && !it.done) { fill(li, it); return; }   // 「上传中 → 已中断/续传」状态也要随时间更新
      var mt = li.querySelector('.mt'); if (mt) { var tmp = document.createElement('li'); fill(tmp, it); mt.innerHTML = tmp.querySelector('.mt').innerHTML; }
    });
  }
  setInterval(function () { if (!document.hidden) tick(); }, 60000);

  /* ---------- 实时：WebSocket，失败则轮询 ---------- */
  // 只允许存在一条 socket、一个重连定时器；所有回调先确认自己仍是当前 socket
  var ws = null, wsFails = 0, pollT = null, pingT = null, pongT = null, reT = null, lastMsg = 0, live = $('#live'), running = false, suspended = false;
  function scheduleReconnect(delay) { clearTimeout(reT); reT = setTimeout(connect, delay != null ? delay : Math.min(30000, 1000 * Math.pow(2, wsFails))); }
  function dropSocket(s) {
    if (!s) return;
    s.onopen = s.onmessage = s.onclose = s.onerror = null;
    try { s.close(); } catch (e) {}
    if (ws === s) { ws = null; clearInterval(pingT); clearTimeout(pongT); }
  }
  function connect() {
    clearTimeout(reT);
    if (!running || suspended) return;
    if (ws && ws.readyState <= 1) return;
    var s;
    try { s = ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + API + '/ws'); } catch (e) { ws = null; poll(); wsFails++; scheduleReconnect(); return; }
    s.onopen = function () {
      if (ws !== s) return;
      wsFails = 0; lastMsg = Date.now(); live.className = 'live on'; clearInterval(pollT); pollT = null; refresh();
      clearInterval(pingT); pingT = setInterval(function () { heartbeat(10000); }, 25000);
    };
    s.onmessage = function (e) {
      if (ws !== s) return;
      lastMsg = Date.now(); clearTimeout(pongT);
      var m; try { m = JSON.parse(e.data); } catch (x) { return; }
      if (m.type === 'item') {
        if (!uploads[m.item.id]) { var had = upsert(m.item, true); if (!had && m.item.kind === 'text' && !sendingText && navigator.vibrate) navigator.vibrate(10); }
        else items[m.item.id] = m.item;
        recalcUsed();
      }
      else if (m.type === 'progress') { var it = items[m.id]; if (it && !uploads[m.id]) { it.got = m.got; it.chunks = m.chunks; if (m.updated) it.updated = m.updated; var li2 = liOf(m.id); if (li2) fill(li2, it); } }
      else if (m.type === 'removed') { removeIds(m.ids); recalcUsed(); }
      else if (m.type === 'cleared') { removeIds(Object.keys(items).filter(function (id) { return !uploads[id]; })); recalcUsed(); }
    };
    s.onclose = function () {
      if (ws !== s) return;
      ws = null; clearInterval(pingT); clearTimeout(pongT);
      if (!running || suspended) return;
      wsFails++; live.className = 'live poll'; poll(); scheduleReconnect();
    };
  }
  // 发 ping，限定时间内没有任何消息就判定为「假在线」（iOS 后台回来常见），立即重连
  function heartbeat(timeout) {
    var s = ws; if (!s || s.readyState !== 1) return;
    try { s.send('ping'); } catch (e) {}
    clearTimeout(pongT);
    pongT = setTimeout(function () { if (ws === s) { dropSocket(s); live.className = 'live poll'; poll(); refresh(); scheduleReconnect(0); } }, timeout);
  }
  function recalcUsed() { used = 0; for (var id in items) if (items[id].kind === 'file') used += items[id].size; usage(); }
  function poll() { if (pollT || !running) return; pollT = setInterval(function () { if (!document.hidden) refresh(); }, 4000); }
  function stopLive() { running = false; clearInterval(pollT); pollT = null; clearTimeout(reT); dropSocket(ws); ws = null; }
  function wake() {
    if (!running) return;
    refresh(); tick();
    if (!ws) connect();
    else if (Date.now() - lastMsg > 20000) heartbeat(4000);
    resumeFailed(false);
  }
  document.addEventListener('visibilitychange', function () { if (!document.hidden) wake(); });
  window.addEventListener('online', wake);
  // bfcache：离开时主动关闭 socket（提高命中率），恢复时补刷新/重连；恢复时不再播放入场动画
  window.addEventListener('pagehide', function (e) { if (!e.persisted) return; suspended = true; clearTimeout(reT); dropSocket(ws); ws = null; clearInterval(pollT); pollT = null; });
  window.addEventListener('pageshow', function (e) {
    if (!e.persisted) return;
    html.classList.add('vt'); suspended = false;
    // 等系统返回动画结束后再改 DOM
    requestAnimationFrame(function () { requestAnimationFrame(function () { if (running) { refresh(); connect(); } }); });
  });
  window.addEventListener('pagereveal', function (e) { if (e.viewTransition) html.classList.add('vt'); });

  function start() {
    ls('lm.tx.authed', '1');
    $('#login').hidden = true; $('#app').hidden = false; running = true; suspended = false;
    refresh().then(ready); connect();
  }

  /* ---------- 发送文字 ---------- */
  var ta = $('#text'), sendBtn = $('#send'), sendingText = false;
  function grow() { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, innerHeight * 0.4) + 'px'; sendBtn.disabled = sendingText || !ta.value.trim(); }
  ta.addEventListener('input', grow);
  ta.addEventListener('keydown', function (e) {
    if (e.isComposing || e.keyCode === 229) return;   // 中文输入法回车选字（Safari 的 isComposing 为 false，但 keyCode 为 229）
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || (!e.shiftKey && !isIOS && matchMedia('(hover:hover)').matches))) { e.preventDefault(); sendText(); }
  });
  sendBtn.addEventListener('click', sendText);
  function sendText() {
    var t = ta.value; if (!t.trim() || sendingText) return;
    sendingText = true; sendBtn.disabled = true;
    req('/items/text', { method: 'POST', json: { text: t } }).then(function (j) { if (ta.value === t) ta.value = ''; upsert(j.item, true); toast('已发送'); })
      .catch(function (e) { if (e.message !== 'auth') toast(ERR[e.message] || '发送失败'); })
      .finally(function () { sendingText = false; grow(); });
  }
  function insertText(t) {
    var v = ta.value;
    if (document.activeElement === ta && typeof ta.selectionStart === 'number') { var a = ta.selectionStart, b = ta.selectionEnd; ta.value = v.slice(0, a) + t + v.slice(b); ta.selectionStart = ta.selectionEnd = a + t.length; }
    else ta.value = v ? v.replace(/\s*$/, '') + '\n' + t : t;   // 追加，不覆盖已有草稿
    grow(); ta.focus();
  }

  /* ---------- 上传文件 ---------- */
  $('#file').addEventListener('change', function () { addFiles(this.files); this.value = ''; });
  var fileChain = Promise.resolve();   // 所有文件排成一个队列，逐个上传
  function addFiles(fl) {
    var arr = Array.prototype.slice.call(fl || []); if (!arr.length) return;
    arr.forEach(function (f) { fileChain = fileChain.then(function () { return upload(f); }); });
  }
  // 预览图：居中裁成正方形，保证在 thumbMax 以内
  function thumb(f) {
    if (!/^image\//.test(f.type)) return Promise.resolve(null);
    return new Promise(function (res) {
      var url = URL.createObjectURL(f), img = new Image();
      img.onload = function () {
        var w = img.naturalWidth, h = img.naturalHeight, s = Math.min(w, h), S = Math.min(192, s), c = document.createElement('canvas');
        c.width = S; c.height = S;
        try { c.getContext('2d').drawImage(img, (w - s) / 2, (h - s) / 2, s, s, 0, 0, S, S); } catch (e) { URL.revokeObjectURL(url); return res(null); }
        URL.revokeObjectURL(url);
        var max = LIMITS ? LIMITS.thumbMax : 96 * 1024, q = [0.72, 0.5, 0.35], d = null;
        for (var i = 0; i < q.length; i++) { d = c.toDataURL('image/jpeg', q[i]); if (d.length <= max) break; d = null; }
        c.width = c.height = 0; res(d);
      };
      img.onerror = function () { URL.revokeObjectURL(url); res(null); };
      img.src = url;
    });
  }
  // 全局并发闸门：所有文件合计最多 3 个分块请求同时进行
  var lanes = 0, laneQ = [];
  function lane() { return new Promise(function (r) { if (lanes < 3) { lanes++; r(); } else laneQ.push(r); }); }
  function release() { var w = laneQ.shift(); if (w) w(); else lanes--; }
  function put(url, blob, onp, U, gen) {
    return new Promise(function (res, rej) {
      if (U.cancel || U.gen !== gen) return rej(new Error('cancel'));
      var x = new XMLHttpRequest(); x.open('PUT', url); x.setRequestHeader('X-Device', encodeURIComponent(DEV));
      U.xhrs.add(x); x.onloadend = function () { U.xhrs.delete(x); }; x.onabort = function () { rej(new Error('cancel')); };
      x.upload.onprogress = function (e) { if (U.gen === gen && !U.cancel) onp(e.loaded); };
      x.onload = function () {
        if (x.status === 401) { rej(new Error('auth')); }
        else if (x.status >= 200 && x.status < 300) res();
        else { var code = ''; try { code = JSON.parse(x.responseText).error || ''; } catch (_) {} var e = new Error(code || 'http' + x.status); e.status = x.status; e.code = code; rej(e); }
      };
      x.onerror = function () { rej(new Error('net')); }; x.send(blob);
    });
  }
  function newU(f, it, chunk) { return { pct: 0, f: f, cs: chunk, n: it.chunks, loaded: new Array(it.chunks).fill(0), doneSet: {}, xhrs: new Set(), gen: 0, samples: [] }; }
  function upload(f) {
    if (LIMITS && f.size > LIMITS.fileMax) { toast('「' + f.name + '」超过 ' + fmtSize(LIMITS.fileMax)); return Promise.resolve(); }
    if (!f.size) { toast('空文件或文件夹已跳过'); return Promise.resolve(); }
    return thumb(f).then(function (tb) {
      return req('/items/file', { method: 'POST', json: { name: f.name || 'file', size: f.size, mime: f.type || 'application/octet-stream', thumb: tb } });
    }).then(function (j) {
      var it = j.item; uploads[it.id] = newU(f, it, j.chunk);
      upsert(it, true); guardUnload();
      return run(it.id);
    }).catch(function (e) { if (e.message !== 'auth') toast(ERR[e.message] || '上传失败'); });
  }
  function upBar(id) {
    var U = uploads[id]; if (!U) return;
    var sum = U.loaded.reduce(function (a, b) { return a + b; }, 0); U.pct = Math.min(1, sum / U.f.size);
    var t = Date.now(); U.samples.push([t, sum]); while (U.samples.length > 2 && t - U.samples[0][0] > 5000) U.samples.shift();   // 最近 5 秒滑动窗口
    var li = liOf(id); if (!li) return;
    var b = li.querySelector('.prog i'); if (b) b.style.width = (U.pct * 100).toFixed(1) + '%';
    var sp = li.querySelector('.speed'); if (sp) {
      var s0 = U.samples[0], dt = (t - s0[0]) / 1000, v = dt > 0.8 ? Math.max(0, (sum - s0[1]) / dt) : 0;
      sp.textContent = Math.floor(U.pct * 100) + '%' + (v ? ' · ' + fmtSize(v) + '/s' : '') + (v && U.pct < 1 ? ' · 剩 ' + eta((U.f.size - sum) / v) : '');
    }
  }
  function eta(s) { return s < 60 ? Math.ceil(s) + ' 秒' : s < 3600 ? Math.ceil(s / 60) + ' 分钟' : (s / 3600).toFixed(1) + ' 小时'; }
  function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function retryable(e) {
    if (e.message === 'auth' || e.message === 'cancel' || e.status === 404) return false;
    if (e.status === 400) return e.code === 'bad_length';           // bad_index 等是致命错误
    if (e.status === 413 || e.status === 409 || e.status === 507) return false;
    return true;                                                      // 网络错误、5xx、429
  }
  // 分块并发上传，失败分块自动重试 5 次（指数退避）；仍失败则可手动「重试」或回到前台自动续传
  function run(id) {
    var U = uploads[id]; if (!U) return Promise.resolve();
    if (U.running) return U.promise;                                 // 连点「重试」不会开第二套 worker
    U.running = true; U.failed = false; U.authFail = false; U.cancel = false;
    var gen = ++U.gen, stopErr = null;
    for (var k = 0; k < U.n; k++) if (!U.doneSet[k]) U.loaded[k] = 0;   // 未完成块的残余进度清零
    U.samples = []; refill(id);
    var queue = []; for (var i = 0; i < U.n; i++) if (!U.doneSet[i]) queue.push(i);
    function alive() { return !U.cancel && U.gen === gen && !stopErr; }
    function stop(e) { if (!stopErr) stopErr = e; U.xhrs.forEach(function (x) { x.abort(); }); }
    function worker() {
      if (!alive() || !queue.length) return Promise.resolve();
      var i = queue.shift(), tries = 0;
      return lane().then(function () {
        if (!alive()) { release(); return; }
        var blob = U.f.slice(i * U.cs, Math.min(U.f.size, (i + 1) * U.cs));
        var go = function () {
          if (!alive()) return Promise.reject(new Error('cancel'));
          return put(API + '/items/' + id + '/chunk/' + i, blob, function (l) { U.loaded[i] = l; upBar(id); }, U, gen).catch(function (e) {
            if (!alive() || !retryable(e) || ++tries > 5) throw e;
            U.loaded[i] = 0; upBar(id);
            return delay(Math.min(8000, 1000 * Math.pow(2, tries - 1))).then(go);
          });
        };
        return go().then(function () { release(); if (U.gen !== gen) return; U.doneSet[i] = 1; U.loaded[i] = blob.size; upBar(id); },
                         function (e) { release(); throw e; });
      }).then(worker);
    }
    var w = function () { return worker().catch(stop); };
    U.promise = Promise.all([w(), w(), w()]).then(function () {    // 等所有 worker 真正停下，才更新状态（不会有「漏网」请求）
      U.running = false;
      if (U.cancel || U.gen !== gen || uploads[id] !== U) return;
      if (!stopErr) {
        var it = items[id]; delete uploads[id]; guardUnload();
        if (it) { it.done = true; it.got = U.n; upsert(it); }
        recalcUsed(); toast('已上传'); return;
      }
      if (stopErr.status === 404) { delete uploads[id]; guardUnload(); removeIds([id]); recalcUsed(); toast('上传已被取消或已过期'); return; }
      U.failed = true; U.authFail = stopErr.message === 'auth'; refill(id); guardUnload();
      if (U.authFail) { showLogin(); toast('登录已过期，重新登录后自动续传'); }
      else if (stopErr.message !== 'cancel') toast(ERR[stopErr.message] || '上传中断，可点重试续传');
    });
    return U.promise;
  }
  // 回到前台 / 网络恢复 / 重新登录后，自动续传中断的上传
  function resumeFailed(includeAuth) {
    Object.keys(uploads).forEach(function (id) { var U = uploads[id]; if (U.failed && !U.running && (includeAuth || !U.authFail)) run(id); });
  }
  function cancelUpload(id) {
    var U = uploads[id]; if (U) { U.cancel = true; U.gen++; U.xhrs.forEach(function (x) { x.abort(); }); delete uploads[id]; guardUnload(); }
    req('/items/' + id, { method: 'DELETE' }).catch(function () {}); removeIds([id]); recalcUsed(); toast('已取消');
  }
  function refill(id) { var li = liOf(id), it = items[id]; if (li && it) { fill(li, it); upBar(id); } }
  // beforeunload 只在确有上传进行时挂上（iOS 不触发它，但桌面有用；平时不挂，避免影响 bfcache）
  var unloadOn = false;
  function onBeforeUnload(e) { e.preventDefault(); e.returnValue = ''; }
  function guardUnload() {
    var busy = Object.keys(uploads).some(function (k) { return !uploads[k].failed; });
    if (busy && !unloadOn) { window.addEventListener('beforeunload', onBeforeUnload); unloadOn = true; }
    else if (!busy && unloadOn) { window.removeEventListener('beforeunload', onBeforeUnload); unloadOn = false; }
  }

  /* 跨页面重载的续传：重新选择同一个文件，只补传缺失的分块 */
  var resumeId = null, resumeInput = document.createElement('input');
  resumeInput.type = 'file'; resumeInput.hidden = true; document.body.appendChild(resumeInput);
  resumeInput.addEventListener('change', function () {
    var f = this.files && this.files[0], id = resumeId; this.value = ''; resumeId = null;
    var it = items[id]; if (!f || !it) return;
    if (f.size !== it.size) { toast('不是同一个文件（大小不同）'); return; }
    (f.name === it.name ? Promise.resolve(true) : confirmBox('文件名不同（' + f.name + '），确定是同一个文件？')).then(function (ok) {
      if (!ok) return;
      req('/items/' + id + '/missing').then(function (j) {
        if (uploads[id]) return;
        var U = uploads[id] = newU(f, j.item, j.chunk), miss = {};
        j.missing.forEach(function (i) { miss[i] = 1; });
        for (var i = 0; i < U.n; i++) if (!miss[i]) { U.doneSet[i] = 1; U.loaded[i] = Math.min(U.cs, f.size - i * U.cs); }
        items[id] = j.item; guardUnload(); upsert(j.item);
        fileChain = fileChain.then(function () { return run(id); });
      }).catch(function (e) { if (e.message === 'auth') return; if (e.status === 404) { removeIds([id]); toast('该上传已过期'); } else toast('续传失败'); });
    });
  });

  // 拖拽 & 粘贴
  var dragN = 0, dragT = null;
  function hasFiles(e) { return e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') > -1; }
  function appOn() { return !$('#app').hidden; }
  function dragOff() { dragN = 0; clearTimeout(dragT); document.body.classList.remove('dragging'); }
  document.addEventListener('dragenter', function (e) { if (!hasFiles(e) || !appOn()) return; e.preventDefault(); dragN++; document.body.classList.add('dragging'); });
  document.addEventListener('dragover', function (e) {
    if (!appOn()) return;
    if (hasFiles(e)) { e.preventDefault(); document.body.classList.add('dragging'); clearTimeout(dragT); dragT = setTimeout(dragOff, 400); }   // Safari 拖出窗口时常不发最后一次 dragleave
    else if (e.target !== ta) e.preventDefault();
  });
  document.addEventListener('dragleave', function (e) { if (!e.relatedTarget || --dragN <= 0) dragOff(); });
  document.addEventListener('dragend', dragOff);
  document.addEventListener('drop', function (e) {
    if (!appOn()) return;
    dragOff();
    if (hasFiles(e)) {
      e.preventDefault();
      var dirs = 0, its = e.dataTransfer.items, files = [];
      if (its && its.length && its[0].webkitGetAsEntry) {
        for (var i = 0; i < its.length; i++) { if (its[i].kind !== 'file') continue; var en = its[i].webkitGetAsEntry(); if (en && en.isDirectory) { dirs++; continue; } var f = its[i].getAsFile(); if (f) files.push(f); }
      } else files = Array.prototype.slice.call(e.dataTransfer.files);
      if (dirs) toast('暂不支持文件夹，请先压缩');
      addFiles(files); return;
    }
    if (e.target === ta) return;                                   // 拖到输入框：浏览器默认插入文字
    e.preventDefault();                                            // 拖入链接/文字：不跳走，放进输入框
    var t = e.dataTransfer && (e.dataTransfer.getData('text/plain') || e.dataTransfer.getData('text/uri-list'));
    if (t) insertText(t);
  });
  function stamp(d) { function p(n) { return (n < 10 ? '0' : '') + n; } return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()); }
  document.addEventListener('paste', function (e) {
    if (!appOn() || !e.clipboardData) return;
    var files = Array.prototype.slice.call(e.clipboardData.files || []);
    var t = e.clipboardData.getData('text/plain') || e.clipboardData.getData('text') || '';
    if (files.length) {
      var ts = stamp(new Date());
      addFiles(files.map(function (f, i) {
        return f.name && !/^image\.\w+$/i.test(f.name) ? f : new File([f], '粘贴图片-' + ts + (i ? '-' + i : '') + '.' + ((f.type.split('/')[1] || 'png').replace('jpeg', 'jpg')), { type: f.type });
      }));
      // 网页里复制的图文混合：文字也保留（纯链接不保留，多半是图片地址）
      if (t && !/^\s*https?:\/\/\S+\s*$/.test(t)) { if (document.activeElement === ta) return; e.preventDefault(); insertText(t); return; }
      e.preventDefault(); return;
    }
    if (document.activeElement !== ta && t) { e.preventDefault(); insertText(t); }
  });

  /* ---------- 条目操作 ---------- */
  var canShareFiles = false;
  try { canShareFiles = !!(navigator.canShare && navigator.canShare({ files: [new File(['x'], 'x.txt', { type: 'text/plain' })] })); } catch (e) {}
  list.addEventListener('click', function (e) {
    var tx = e.target.closest('.tx'); if (tx && !e.target.closest('a')) { tx.classList.toggle('full'); return; }
    var b = e.target.closest('[data-a]'); if (!b) return;
    var li = b.closest('.it'), it = items[li.dataset.id]; if (!it) return;
    var a = b.dataset.a;
    if (a === 'copy') copy(it.text).then(function () { flash(b); toast('已复制'); }, function () { toast('复制失败'); });
    else if (a === 'view') openViewer(it);
    else if (a === 'save') save(it, b);
    else if (a === 'cancel') cancelUpload(it.id);
    else if (a === 'retry') run(it.id);
    else if (a === 'resume') { resumeId = it.id; toast('请选择同一个文件'); resumeInput.click(); }
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
  function gone(it) { toast('文件已被删除或已过期'); removeIds([it.id]); recalcUsed(); }

  /* 查看大图：iPhone 长按图片即可「添加到照片」 */
  function openViewer(it) {
    var img = $('#vimg');
    img.onerror = function () { closeViewer(); fetch(raw(it), { method: 'HEAD', credentials: 'same-origin' }).then(function (r) { if (r.status === 404) gone(it); else toast('图片无法预览，请用保存'); }, function () { toast('加载失败'); }); };
    img.src = raw(it); $('#vhint').hidden = !isIOS; $('#viewer').hidden = false; document.body.classList.add('noscroll');
  }
  function closeViewer() { $('#viewer').hidden = true; $('#vimg').onerror = null; $('#vimg').removeAttribute('src'); document.body.classList.remove('noscroll'); }

  // iPhone 分享缓存：只留最近一个，60 秒或分享完成后释放（避免多个大文件常驻内存导致标签页被系统杀掉）
  var shareCache = null;
  function clearShare() { if (!shareCache) return; clearTimeout(shareCache.t); var id = shareCache.id; shareCache = null; var li = liOf(id); if (li && items[id]) fill(li, items[id]); }
  function setShare(it, f) { clearShare(); shareCache = { id: it.id, f: f, t: setTimeout(clearShare, 60000) }; var li = liOf(it.id); if (li) fill(li, it); }
  function share(it, f) {
    return navigator.share({ files: [f] }).then(clearShare, function (e) {
      if (e && e.name === 'NotAllowedError') { setShare(it, f); toast('已就绪，再点一次保存'); }   // 下载耗时导致用户手势过期：按钮变为「已就绪」
      else if (e && e.name === 'AbortError') setShare(it, f);                                     // 用户关了分享面板，保留以便马上再试
      else { clearShare(); location.href = raw(it, true); }
    });
  }
  function save(it, b) {
    // iPhone：先取回文件，再用系统分享面板（可「存储图像」/「存储到文件」）
    if (canShare(it)) {
      if (shareCache && shareCache.id === it.id) { share(it, shareCache.f); return; }
      if (b.classList.contains('busy')) return;
      b.classList.add('busy'); b.innerHTML = IC.spin;
      fetch(raw(it), { credentials: 'same-origin' }).then(function (r) {
        if (r.status === 404) { var e = new Error('gone'); e.gone = true; throw e; }
        if (r.status === 401) { showLogin(); throw new Error('auth'); }
        if (!r.ok) { var e2 = new Error('http'); e2.http = true; throw e2; }
        return r.blob();
      }).then(function (bl) {
        b.classList.remove('busy'); b.innerHTML = IC.share;
        share(it, new File([bl], it.name, { type: it.mime }));
      }).catch(function (e) {
        b.classList.remove('busy'); b.innerHTML = IC.share;
        if (e && e.gone) return gone(it);
        if (e && (e.message === 'auth' || e.http)) { if (e.http) toast('下载失败'); return; }
        location.href = raw(it, true);                                 // 仅网络类错误时降级为浏览器下载
      });
      return;
    }
    var go = function () { var a = document.createElement('a'); a.href = raw(it, true); a.download = it.name; document.body.appendChild(a); a.click(); a.remove(); flash(b); };
    if (isIOS) { go(); if (it.size > SHARE_MAX) toast('大文件会存到「文件」App 的下载项'); return; }   // iOS 保持在手势内直接下载
    fetch(raw(it), { method: 'HEAD', credentials: 'same-origin' }).then(function (r) {   // 桌面先确认还在，避免下载到一个 JSON 错误文件
      if (r.status === 404) gone(it); else if (r.status === 401) showLogin(); else go();
    }, go);
  }
  $('#viewer').addEventListener('click', closeViewer);

  /* ---------- 菜单 ---------- */
  function sheet(on) { document.body.classList.toggle('sheet', on); }
  $('#menuBtn').addEventListener('click', function () { sheet(true); });
  $('#scrim').addEventListener('click', function () { sheet(false); });
  $('#refresh').addEventListener('click', function () { sheet(false); refresh().then(function () { toast('已刷新'); }); });
  function confirmBox(t) { return new Promise(function (res) { $('#ctext').textContent = t; $('#confirm').hidden = false; $('#cyes').onclick = function () { $('#confirm').hidden = true; res(true); }; $('#cno').onclick = function () { $('#confirm').hidden = true; res(false); }; }); }
  function cancelAllUploads() { Object.keys(uploads).forEach(function (id) { var U = uploads[id]; U.cancel = true; U.gen++; U.xhrs.forEach(function (x) { x.abort(); }); delete uploads[id]; }); guardUnload(); }
  $('#clearAll').addEventListener('click', function () {
    sheet(false); confirmBox('清空全部内容（含永久保留）？').then(function (ok) { if (!ok) return;
      req('/items', { method: 'DELETE' }).then(function () { cancelAllUploads(); removeIds(Object.keys(items)); used = 0; usage(); toast('已清空'); }).catch(function () {}); });
  });
  $('#logout').addEventListener('click', function () {
    sheet(false); cancelAllUploads(); clearShare();
    req('/logout', { method: 'POST' }).finally(function () { list.innerHTML = ''; Object.keys(items).forEach(function (k) { delete items[k]; }); firstRender = true; showLogin(); toast('已退出'); });
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { sheet(false); if (!$('#viewer').hidden) closeViewer(); } });

  /* ---------- 启动 ---------- */
  // 上次已登录：立即显示主界面和缓存的列表（首帧不再是空白），再用 /me 校验
  var optimistic = ls('lm.tx.authed') === '1';
  if (optimistic) {
    $('#login').hidden = true; $('#app').hidden = false;
    try { var c = JSON.parse(ss('lm.tx.cache') || 'null'); if (c && c.items) { render(c, true); } } catch (e) {}
    ready();
  }
  req('/me').then(function (j) { LIMITS = j.limits; setSkew(j.now); usage(); if (j.authed) start(); else showLogin(); }).catch(function (e) {
    if (e && e.message === 'auth') return;
    if (optimistic) { running = true; poll(); scheduleReconnect(2000); } else showLogin();   // 离线时保持缓存界面，稍后重试
  });
  window.__transfer = { refresh: refresh, items: items };
})();
