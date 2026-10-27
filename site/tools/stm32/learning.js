/* Learning tools: cross-reference search, precise links and browser-local notes. */
(function () {
  'use strict';
  var app = window.STM32_APP, core = window.STM32StudyCore;
  if (!app || !core) return;
  var KEY = 'lm.stm32.learning.v1', PREF = 'lm.stm32.reading.v1';
  var names = { pins: '引脚', regs: '寄存器', code: '代码片段', course: '课件', arch: '架构图', chip: '板卡 / 原理图' };
  function el(tag, cls, text) { return app.el(tag, cls, text); }
  function button(label, fn, cls) { var b = el('button', cls || 'lm-btn', label); b.type = 'button'; if (fn) b.addEventListener('click', fn); return b; }
  function clear(n) { n.replaceChildren(); }
  function read(key, fallback) { try { var s = localStorage.getItem(key); return s ? JSON.parse(s) : fallback; } catch (e) { return fallback; } }
  function write(key, data) { try { localStorage.setItem(key, JSON.stringify(data)); return true; } catch (e) { app.toast('保存失败：浏览器存储不可用，请先导出备份'); return false; } }
  var records = core.records(read(KEY, [])), prefs = read(PREF, {});
  if (!prefs || typeof prefs !== 'object') prefs = {};
  function applyPrefs() {
    var size = [14, 16, 18].indexOf(Number(prefs.font)) >= 0 ? Number(prefs.font) : 16;
    document.documentElement.style.setProperty('--lm-font', size + 'px');
    document.documentElement.style.setProperty('--lm-scale', String(size / 14));
    document.documentElement.classList.toggle('lm-wrap', prefs.wrap !== false);
  }
  applyPrefs();
  function persist(next) { if (!write(KEY, next)) return false; records = next; updateStars(); return true; }
  function upsert(data) {
    var r = core.record(data); if (!r) return false;
    var old = records.findIndex(function (x) { return x.id === r.id; });
    if (old < 0 && records.length >= 500) { app.toast('已达到 500 条，请先导出并整理记录'); return false; }
    var next = records.slice(); if (old < 0) next.unshift(r); else next[old] = r;
    return persist(next);
  }
  function find(c) { var id = core.key(c.target); return records.find(function (r) { return r.id === id; }); }
  var starButtons = [];
  function updateStars() {
    var on = !!(find(app.context()) || {}).starred;
    starButtons.forEach(function (b) { b.setAttribute('aria-pressed', String(on)); b.classList.toggle('is-saved', on); b.textContent = on ? '已收藏' : '收藏'; });
  }
  function toggleStar() {
    var c = app.context(), before = find(c), r = Object.assign({}, before || {}, c, { starred: !(before && before.starred), updatedAt: Date.now() });
    if (upsert(r)) app.toast(r.starred ? '已收藏当前位置' : '已取消收藏');
  }
  function share() {
    var qs = core.params(app.context().target), url = new URL('/stm32?' + qs, location.origin).href;
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(function () { app.toast('已复制当前位置链接'); }, function () { showLink(url); });
    else showLink(url);
  }
  var activeDialog = null, restoreFocus = null, dialogId = 0;
  function dialog(title, wide) {
    var d = el('dialog', 'lm-dialog' + (wide ? ' lm-wide' : ''));
    var h = el('header', 'lm-dialog-head'), t = el('h2', null, title); t.id = 'lm-heading-' + (++dialogId);
    d.setAttribute('aria-labelledby', t.id); h.appendChild(t); h.appendChild(button('关闭', closeDialog, 'lm-btn lm-close'));
    d.appendChild(h); document.body.appendChild(d);
    d.addEventListener('cancel', function (e) { e.preventDefault(); closeDialog(); });
    d.addEventListener('keydown', function (e) { e.stopPropagation(); });
    d.addEventListener('click', function (e) { if (e.target !== d) return; var r = d.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) closeDialog(); });
    return d;
  }
  function openDialog(d, focus) {
    if (activeDialog) { activeDialog.close(); activeDialog = null; }
    restoreFocus = document.activeElement; activeDialog = d; d.showModal(); app.overlayDepth(app.viewerDepth() + 1);
    if (focus) focus.focus();
  }
  function closeDialog() {
    if (!activeDialog) return;
    activeDialog.close(); activeDialog = null; app.overlayDepth(app.viewerDepth());
    var back = restoreFocus; restoreFocus = null;
    if (back && back.isConnected && !back.closest('[inert]')) try { back.focus({ preventScroll: true }); } catch (e) {}
  }
  var linkDialog = dialog('当前位置链接'), linkInput = el('input', 'lm-input');
  linkInput.readOnly = true; linkInput.setAttribute('aria-label', '当前位置链接');
  linkDialog.appendChild(el('p', 'lm-muted', '复制下面的地址，可直接打开这个引脚、寄存器或课件页。'));
  linkDialog.appendChild(linkInput);
  function showLink(url) { linkInput.value = url; openDialog(linkDialog, linkInput); linkInput.select(); }

  /* Search indexes metadata and code; course page images are not OCR indexed. */
  var searchDialog = dialog('搜索全部 STM32 资料', true), sq = el('input', 'lm-input lm-search-input');
  sq.type = 'search'; sq.placeholder = 'PA9 / USART1 / 推挽 / 中断 / 课件章节'; sq.setAttribute('aria-label', '搜索全部 STM32 资料');
  var searchHint = el('p', 'lm-muted', '检索引脚、寄存器、代码、架构图和课件目录；按 Esc 关闭。'), results = el('div', 'lm-search-results');
  searchHint.setAttribute('role', 'status'); results.id = 'lm-search-results'; sq.setAttribute('aria-controls', results.id);
  searchDialog.appendChild(sq); searchDialog.appendChild(searchHint); searchDialog.appendChild(results);
  var index = [], indexedRegs = false, searchTimer = 0, searchToken = 0, regsPromise = null;
  function add(kind, title, detail, words, target) { index.push({ kind: kind, title: String(title || ''), detail: String(detail || ''), words: String(words || ''), target: core.target(target) }); }
  (window.STM32_PINS || []).forEach(function (p) {
    var resources = ((window.STM32_BOARD || {}).resources || []).filter(function (r) { return r.mcu === p[1]; });
    add('pins', p[1], '#' + p[0] + ' · ' + resources.map(function (r) { return r.name; }).join(' / '), p.slice(2).join(' ') + ' ' + resources.map(function (r) { return r.name + ' ' + (r.note || ''); }).join(' '), { tab: 'pins', q: p[1] });
  });
  (window.STM32_SNIPPETS || []).forEach(function (s) { add('code', s.title, s.cat + ' · HAL 片段', s.code, { tab: 'code', cat: s.cat, snip: s.title }); });
  (((window.STM32_COURSEWARE || {}).parts) || []).forEach(function (p) {
    (p.chapters || []).forEach(function (c) { add('course', c.title, p.title + ' · p.' + (c.pageIndex + 1), [c.snippetCat, c.snippetTitle, c.pinQuery].filter(Boolean).join(' '), { cw: p.id + '-' + (c.pageIndex + 1) }); });
  });
  (window.STM32_MANUAL_FIGS || []).concat(window.STM32_TEACH_FIGS || []).forEach(function (f) { add('arch', f.title, (f.label || '') + ' · ' + (f.group || '架构图'), f.title_en || '', { fig: f.id }); });
  (((window.STM32_ASSETS || {}).schematic) || []).forEach(function (s) { add('chip', s.title, s.group, '', { page: String(s.src).replace(/^.*\//, '').replace(/\.svg$/i, '') }); });
  function indexRegisters() {
    if (indexedRegs || !window.STM32_REGS) return;
    indexedRegs = true;
    window.STM32_REGS.groups.forEach(function (g) { g.regs.forEach(function (r) {
      var addresses = (g.instances || []).map(function (i) { return '0x' + ((parseInt(i.base, 16) + parseInt(r.offset, 16)) >>> 0).toString(16); }).join(' ');
      add('regs', r.name, g.title + ' · ' + (r.title || ''), addresses + ' ' + (g.instances || []).map(function (i) { return i.name; }).join(' ') + ' ' + (r.fields || []).map(function (f) { return f.name + ' ' + (f.desc || ''); }).join(' ') + ' ' + (r.quick || []).map(function (q) { return q.title; }).join(' '), { reg: r.id });
    }); });
  }
  function renderSearch() {
    clear(results); indexRegisters();
    var query = sq.value.trim(), found = core.search(index, query);
    if (!query) { searchHint.textContent = '输入关键词。课件搜索覆盖章节目录，图片正文未做文字识别。'; return; }
    searchHint.textContent = found.length ? '找到 ' + found.length + ' 项；每类最多显示 10 项。' : '没有找到，试试引脚名、外设名或更短的关键词。';
    ['pins', 'regs', 'code', 'course', 'arch', 'chip'].forEach(function (kind) {
      var items = found.filter(function (r) { return r.kind === kind; }); if (!items.length) return;
      var group = el('section', 'lm-result-group'); group.appendChild(el('h3', null, names[kind] + ' · ' + items.length));
      items.slice(0, 10).forEach(function (r) {
        var b = button('', function () { closeDialog(); app.navigate(r.target); }, 'lm-result');
        b.appendChild(el('strong', null, r.title)); b.appendChild(el('span', 'lm-muted', r.detail)); group.appendChild(b);
      }); results.appendChild(group);
    });
  }
  function openSearch() {
    openDialog(searchDialog, sq); sq.select(); renderSearch(); var token = ++searchToken;
    if (!indexedRegs) {
      searchHint.textContent = '正在载入寄存器索引，其余资料可先搜索…';
      regsPromise = app.loadRegisters();
      regsPromise.then(function () { if (token === searchToken) renderSearch(); }, function () {
        if (token !== searchToken) return;
        renderSearch(); searchHint.textContent += ' 寄存器索引加载失败；重新打开搜索可重试。';
      });
    }
  }
  sq.addEventListener('input', function () { clearTimeout(searchTimer); searchTimer = setTimeout(renderSearch, 100); });
  sq.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowDown' || e.key === 'Enter') { var first = results.querySelector('button'); if (first) { e.preventDefault(); first.focus(); if (e.key === 'Enter') first.click(); } }
  });
  results.addEventListener('keydown', function (e) {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    var bs = Array.from(results.querySelectorAll('button')), i = bs.indexOf(document.activeElement), j = i + (e.key === 'ArrowDown' ? 1 : -1); e.preventDefault();
    if (j < 0) sq.focus(); else if (bs[j]) bs[j].focus();
  });

  /* Notebook: explicit saves, contextual bookmarks, export and merge-only import. */
  var noteDialog = dialog('学习记录', true), intro = el('p', 'lm-muted', '记录仅保存在当前浏览器。换设备或清理浏览器前，请先导出备份。');
  noteDialog.appendChild(intro);
  var editBox = el('section', 'lm-editor'), editing = null, editTitle = el('h3'), form = el('form', 'lm-note-form');
  var starred = el('input'), starLabel = el('label', 'lm-check', '收藏这个位置 '); starred.type = 'checkbox'; starLabel.appendChild(starred);
  var statusLabel = el('label', 'lm-field', '学习状态'), status = el('select', 'lm-input'); status.setAttribute('aria-label', '学习状态');
  [['', '未标记'], ['todo', '还没弄懂'], ['practice', '待练习'], ['done', '已掌握']].forEach(function (x) { var o = el('option', null, x[1]); o.value = x[0]; status.appendChild(o); }); statusLabel.appendChild(status);
  var noteLabel = el('label', 'lm-field', '我的理解 / 卡住的地方'), note = el('textarea', 'lm-input'); note.rows = 4; note.maxLength = 3000; note.placeholder = '例如：CRH 控制 8～15 号引脚，每个引脚占 4 位。'; note.setAttribute('aria-label', '学习笔记'); noteLabel.appendChild(note);
  var save = button('保存记录', null, 'lm-btn lm-primary'); save.type = 'submit';
  form.appendChild(starLabel); form.appendChild(statusLabel); form.appendChild(noteLabel); form.appendChild(save); editBox.appendChild(editTitle); editBox.appendChild(form); noteDialog.appendChild(editBox);
  function editContext(c) {
    editing = { target: core.target(c.target), title: c.title }; var old = find(c);
    editTitle.textContent = c.title; starred.checked = !!(old && old.starred); status.value = old ? old.status : ''; note.value = old ? old.note : '';
  }
  var recordBar = el('div', 'lm-record-bar'), recordFilter = el('select', 'lm-input'), recordQuery = el('input', 'lm-input');
  recordFilter.setAttribute('aria-label', '筛选学习记录');
  [['all', '全部记录'], ['star', '我的收藏'], ['todo', '还没弄懂'], ['practice', '待练习'], ['done', '已掌握']].forEach(function (x) { var o = el('option', null, x[1]); o.value = x[0]; recordFilter.appendChild(o); });
  recordQuery.type = 'search'; recordQuery.placeholder = '搜索记录和笔记'; recordQuery.setAttribute('aria-label', '搜索学习记录'); recordBar.appendChild(recordFilter); recordBar.appendChild(recordQuery); noteDialog.appendChild(recordBar);
  var recordList = el('div', 'lm-records'), recordLive = el('p', 'lm-muted'); recordLive.setAttribute('role', 'status'); noteDialog.appendChild(recordLive); noteDialog.appendChild(recordList);
  function renderRecords() {
    clear(recordList);
    var filter = recordFilter.value, query = recordQuery.value.trim().toLowerCase();
    var items = records.filter(function (r) { return (filter === 'all' || (filter === 'star' ? r.starred : r.status === filter)) && (!query || (r.title + ' ' + r.note).toLowerCase().indexOf(query) >= 0); }).sort(function (a, b) { return b.updatedAt - a.updatedAt; });
    recordLive.textContent = items.length ? items.length + ' 条记录' : '暂无记录。在引脚、寄存器或课件页点“收藏”，或在上方写下理解。';
    items.forEach(function (r) {
      var row = el('article', 'lm-record'), main = button('', function () { closeDialog(); app.navigate(r.target); }, 'lm-record-main');
      main.appendChild(el('strong', null, (r.starred ? '★ ' : '') + r.title));
      main.appendChild(el('span', 'lm-muted', (names[r.target.tab] || '') + (r.status ? ' · ' + { todo: '还没弄懂', practice: '待练习', done: '已掌握' }[r.status] : '')));
      if (r.note) main.appendChild(el('p', 'lm-note-preview', r.note));
      row.appendChild(main); row.appendChild(button('编辑', function () { editContext(r); note.focus(); }, 'lm-btn'));
      row.appendChild(button('移除', function () {
        if (persist(records.filter(function (x) { return x.id !== r.id; }))) {
          renderRecords(); recordLive.textContent = '已移除：' + r.title + ' ';
          recordLive.appendChild(button('撤销', function () { if (upsert(r)) renderRecords(); }, 'lm-btn'));
        }
      }, 'lm-btn'));
      recordList.appendChild(row);
    });
  }
  form.addEventListener('submit', function (e) {
    e.preventDefault(); if (!editing) return;
    if (upsert(Object.assign({}, editing, { starred: starred.checked, status: status.value, note: note.value, updatedAt: Date.now() }))) { renderRecords(); app.toast('学习记录已保存'); }
  });
  recordFilter.addEventListener('change', renderRecords); recordQuery.addEventListener('input', renderRecords);
  function openNotes() { editContext(app.context()); renderRecords(); openDialog(noteDialog, note); }
  var transfer = el('footer', 'lm-record-transfer'), importInput = el('input'); importInput.type = 'file'; importInput.accept = '.json,application/json'; importInput.hidden = true;
  transfer.appendChild(button('导出备份', function () {
    var blob = new Blob([JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), records: records, reading: prefs }, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob), a = el('a'); a.href = url; a.download = 'stm32-learning-' + new Date().toISOString().slice(0, 10) + '.json'; document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }));
  transfer.appendChild(button('导入备份', function () { importInput.click(); })); transfer.appendChild(el('span', 'lm-muted', '导入会合并记录，不清空现有内容。')); transfer.appendChild(importInput); noteDialog.appendChild(transfer);
  importInput.addEventListener('change', function () {
    var file = importInput.files[0]; if (!file) return;
    if (file.size > 2 * 1024 * 1024) { app.toast('备份文件超过 2 MB'); importInput.value = ''; return; }
    file.text().then(function (body) {
      var data = JSON.parse(body); if (!data || data.version !== 1 || !Array.isArray(data.records)) throw new Error('format');
      var incoming = core.records(data.records), next = records.slice();
      incoming.forEach(function (r) { var i = next.findIndex(function (x) { return x.id === r.id; }); if (i < 0) next.push(r); else if (r.updatedAt > next[i].updatedAt) next[i] = r; });
      if (next.length > 500) { app.toast('合并后超过 500 条，请先整理备份'); return; }
      if (persist(next)) {
        var rd = data.reading, restored = false;
        if (rd && typeof rd === 'object' && !Array.isArray(rd)) {
          var np = { font: [14, 16, 18].indexOf(Number(rd.font)) >= 0 ? Number(rd.font) : (prefs.font || 16), wrap: typeof rd.wrap === 'boolean' ? rd.wrap : prefs.wrap !== false };
          if (write(PREF, np)) { prefs = np; applyPrefs(); restored = true; }
        }
        renderRecords(); recordLive.textContent = '已合并 ' + incoming.length + ' 条有效记录' + (restored ? '，并恢复阅读设置。' : '。');
      }
    }).catch(function () { app.toast('导入失败：请选择本工具导出的 JSON 备份'); }).finally(function () { importInput.value = ''; });
  });

  var settings = dialog('阅读设置'), fontLabel = el('label', 'lm-field', '正文与代码字号'), font = el('select', 'lm-input'); font.setAttribute('aria-label', '阅读字号');
  [14, 16, 18].forEach(function (n) { var o = el('option', null, n + ' px' + (n === 16 ? ' · 默认' : '')); o.value = String(n); font.appendChild(o); });
  fontLabel.appendChild(font); settings.appendChild(fontLabel);
  var wrapLabel = el('label', 'lm-check', '代码自动换行 '), wrap = el('input'); wrap.type = 'checkbox'; wrapLabel.appendChild(wrap); settings.appendChild(wrapLabel);
  settings.appendChild(el('p', 'lm-muted', '仅调整阅读显示；复制得到的代码保持原始换行。图片仍支持独立缩放。'));
  function updatePrefs() { var next = { font: Number(font.value), wrap: wrap.checked }; if (write(PREF, next)) { prefs = next; applyPrefs(); } }
  font.addEventListener('change', updatePrefs); wrap.addEventListener('change', updatePrefs);
  function openSettings() { font.value = String([14, 16, 18].indexOf(Number(prefs.font)) >= 0 ? prefs.font : 16); wrap.checked = prefs.wrap !== false; openDialog(settings, font); }
  var actions = el('div', 'lm-actions'); actions.setAttribute('aria-label', '学习工具');
  actions.appendChild(button('搜索', openSearch, 'lm-btn lm-search')); actions.appendChild(button('记录', openNotes));
  var star = button('收藏', toggleStar); starButtons.push(star); actions.appendChild(star);
  actions.appendChild(button('分享', share)); var aa = button('Aa', openSettings); aa.setAttribute('aria-label', '阅读设置'); actions.appendChild(aa); document.querySelector('.top-row').appendChild(actions);
  // 窄屏（<360px）：记录/收藏/分享/Aa 收进「⋯」菜单，顶栏保持一行
  var more = button('⋯', null, 'lm-btn lm-more'), menu = el('div', 'lm-menu');
  more.setAttribute('aria-label', '更多学习工具'); more.setAttribute('aria-haspopup', 'true'); more.setAttribute('aria-expanded', 'false'); menu.setAttribute('role', 'menu'); menu.id = 'lm-more-menu'; more.setAttribute('aria-controls', menu.id);
  function closeMenu(focusBack) { if (!menu.classList.contains('open')) return; menu.classList.remove('open'); more.setAttribute('aria-expanded', 'false'); if (focusBack) more.focus(); }
  function openMenu() {
    menu.textContent = '';
    [['记录', openNotes], [star.textContent, toggleStar], ['分享', share], ['阅读设置', openSettings]].forEach(function (it) {
      var b = button(it[0], function () { closeMenu(false); it[1](); }, 'lm-btn lm-menu-item'); b.setAttribute('role', 'menuitem'); menu.appendChild(b);
    });
    menu.classList.add('open'); more.setAttribute('aria-expanded', 'true'); var f = menu.querySelector('button'); if (f) f.focus();
  }
  more.addEventListener('click', function (e) { e.stopPropagation(); if (menu.classList.contains('open')) closeMenu(true); else openMenu(); });
  document.addEventListener('click', function (e) { if (!menu.contains(e.target) && e.target !== more) closeMenu(false); });
  menu.addEventListener('keydown', function (e) {
    var items = Array.prototype.slice.call(menu.querySelectorAll('button')), i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); var n = items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]; if (n) n.focus(); }
    else if (e.key === 'Tab') closeMenu(false);
  });
  window.addEventListener('keydown', function (e) { if (e.key === 'Escape' && menu.classList.contains('open')) { e.preventDefault(); e.stopImmediatePropagation(); closeMenu(true); } }, true);
  actions.appendChild(more); actions.appendChild(menu);
  // tab 栏：放不下时才横向滚动，并给出边缘渐隐提示；选中项由 stm32.js 滚入视野
  var segEl = document.querySelector('.seg');
  function segFit() {
    if (!segEl) return; var over = segEl.scrollWidth > segEl.clientWidth + 1;
    segEl.classList.toggle('lm-seg-over', over);
    segEl.classList.toggle('lm-seg-l', over && segEl.scrollLeft > 1);
    segEl.classList.toggle('lm-seg-r', over && segEl.scrollLeft + segEl.clientWidth < segEl.scrollWidth - 1);
  }
  if (segEl) { segEl.addEventListener('scroll', segFit, { passive: true }); window.addEventListener('resize', segFit); setTimeout(segFit, 0); if (document.fonts && document.fonts.ready) document.fonts.ready.then(segFit); }
  var viewerBar = document.querySelector('.vw-top'), viewerActions = el('div', 'lm-viewer-actions');
  var vs = button('收藏', toggleStar); starButtons.push(vs); viewerActions.appendChild(vs); viewerActions.appendChild(button('笔记', openNotes)); viewerActions.appendChild(button('分享', share)); viewerBar.appendChild(viewerActions);
  window.addEventListener('stm32:context', updateStars);
  window.addEventListener('storage', function (e) { if (e.key === KEY) { records = core.records(read(KEY, [])); updateStars(); if (activeDialog === noteDialog) renderRecords(); } if (e.key === PREF) { prefs = read(PREF, {}) || {}; applyPrefs(); } });
  document.addEventListener('keydown', function (e) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); e.stopPropagation(); if (!activeDialog) openSearch(); }
  }, true);
  window.addEventListener('message', function (e) {
    if (e.origin !== location.origin || e.source !== window.parent || !e.data) return;
    if ((e.data.type === 'reset' || e.data.type === 'back') && activeDialog) closeDialog();
  });
  updateStars();
  app.contextChanged();
})();
