/* views.js — 基础视图：首页（芯片 + 板载模块）/ 外设主题 / 开发板
   每个视图 = function (root, route, app) → { title(route), update(route), destroy() } */
(function () {
  'use strict';
  var STM = window.STM, ui = STM.ui, M = STM.model, el = ui.el;
  var CW_KEY = 'lm.stm32.cw';

  function h2(text, id) { var h = el('h2', 'sec-h', text); if (id) h.id = id; return h; }
  function sec(id, title, cls) { var s = el('section', 'sec' + (cls ? ' ' + cls : '')); s.id = 's-' + id; s.appendChild(h2(title)); return s; }
  function pagesText(x) { return x.end > x.start ? '第 ' + (x.start + 1) + '–' + (x.end + 1) + ' 页' : '第 ' + (x.start + 1) + ' 页'; }
  function readPos() { try { var o = JSON.parse(ui.lsGet(CW_KEY) || '{}'); return o && typeof o === 'object' ? o : {}; } catch (e) { return {}; } }
  function erBadge(pid, from1, to1) {
    var c = M.erCount(pid, from1, to1);
    if (!c.n) return null;
    var b = el('span', 'er-tag sev-' + c.sev, '勘误 ' + c.n);
    b.title = '这一段有 ' + c.n + ' 条勘误（课件里的错误或可疑之处），翻到对应页时会提示';
    return b;
  }
  function topicTag(t, app) {
    var a = app.link({ v: 'topic', t: t.id }, 'ttag'); a.style.setProperty('--h', app.hue(t)); a.textContent = t.code;
    a.setAttribute('aria-label', '外设：' + t.name);
    return a;
  }
  function thumb(src) {
    var f = el('span', 'thumb'), img = el('img');
    img.alt = ''; img.loading = 'lazy'; img.decoding = 'async'; img.src = src;
    img.addEventListener('error', function () { f.classList.add('missing'); img.remove(); f.appendChild(ui.icon('image')); });
    f.appendChild(img); return f;
  }
  function figGrid(list, app) {
    var grid = el('div', 'fgrid');
    list.forEach(function (f) {
      var b = ui.btn('fcard'); b.appendChild(thumb(f.thumb));
      var t = el('span', 'fcard-t'); t.appendChild(el('b', null, f.title));
      t.appendChild(el('span', null, f.kind === 'teach' ? '教学图' : (f.label || '手册') + (f.page != null ? '，手册第 ' + f.page + ' 页' : '')));
      b.appendChild(t);
      b.addEventListener('click', function () { app.navigate({ fig: f.id }); });
      grid.appendChild(b);
    });
    return grid;
  }

  /* ====================== 外设主题 ====================== */
  function topic(root, route, app) {
    var t = M.topicById[route.t], art = el('article', 'topic');
    art.style.setProperty('--h', app.hue(t));
    var head = el('header', 'th'), tx = el('div', 'th-tx');
    var h1 = el('h1', 'th-code', t.code); tx.appendChild(h1);
    head.appendChild(tx);
    var mini = STM.chip.create({ labels: false }), mc = el('div', 'th-chip');
    mini.light(t.pins.map(function (h) { return h.p.n; }), app.hue(t));
    mc.appendChild(mini.svg);
    head.appendChild(mc);
    art.appendChild(head);

    var ch = STM.think && STM.think.chapter(t.id);
    if (ch) {
      var d = STM.think.progress(t.id), isD = !Array.isArray(d);
      var nDone = isD ? d.done : d.filter(Boolean).length, nAll = isD ? d.total : 4;
      var en = app.link({ v: 'think', t: t.id }, 'thinkin');
      en.appendChild(ui.icon('idea'));
      var et = el('span', 'thinkin-t'); et.appendChild(el('b', null, '设计原理'));
      if (nDone) et.appendChild(el('span', null, nDone + ' / ' + nAll)); en.appendChild(et);
      en.appendChild(el('span', 'thinkin-go', nDone === nAll ? '复习' : nDone ? '继续' : '开始'));
      art.appendChild(en);
    }
    var parts = [];
    var snav = el('nav', 'snav'); snav.setAttribute('aria-label', '本页内容');
    art.appendChild(snav);

    // 要点
    var s1 = sec('points', '要点'), ul = el('ul', 'points');
    t.points.forEach(function (p) { ul.appendChild(el('li', null, p)); });
    s1.appendChild(ul); parts.push([s1, '要点']);


    // 引脚
    if (t.pins.length) {
      var s3 = sec('pins', '引脚'), LIMIT = 18;
      var grid = el('div', 'pgrid');
      t.pins.forEach(function (h, k) {
        var p = h.p, a = app.link({ v: 'home', pin: String(p.n) }, 'ptile' + (k >= LIMIT ? ' extra' : ''));
        var top = el('span', 'ptile-h'); top.appendChild(el('b', null, p.name)); top.appendChild(el('span', null, p.n + ' 脚')); a.appendChild(top);
        a.appendChild(el('span', 'ptile-sig', h.why.join('  ')));
        if (p.board.length) a.appendChild(el('span', 'ptile-b', p.board.map(function (r) { return r.name; }).join('、')));
        grid.appendChild(a);
      });
      s3.appendChild(grid);
      if (t.pins.length > LIMIT) {
        var mb = ui.btn('more-btn', '再显示 ' + (t.pins.length - LIMIT) + ' 个');
        mb.addEventListener('click', function () { grid.classList.add('all'); mb.remove(); });
        s3.appendChild(mb);
      }
      parts.push([s3, '引脚']);
    }

    // 寄存器
    if (t.regCount) {
      var s4 = sec('regs', '寄存器');
      t.regGroups.forEach(function (x) {
        var gb = el('div', 'rgroup'), gh = el('div', 'rgroup-h');
        gh.appendChild(el('b', null, x.g.name)); gh.appendChild(el('span', null, x.g.title));
        var inst = (x.g.instances || []).map(function (i) { return i.name; });
        if (inst.length > 1) gh.appendChild(el('span', 'rgroup-i', inst.join(' ')));
        gb.appendChild(gh);
        if (x.g.note) gb.appendChild(el('p', 'sec-note', x.g.note));
        x.regs.forEach(function (r) {
          var b = ui.btn('rrow'); b.dataset.reg = r.id;
          b.appendChild(el('b', 'rrow-n', r.name));
          b.appendChild(el('span', 'rrow-t', r.title || ''));
          b.appendChild(el('span', 'rrow-o', r.offsetText ? '' : '+' + String(r.offset || '').replace(/^0x/i, '0x')));
          b.addEventListener('click', function () { app.navigate({ reg: r.id }); });
          gb.appendChild(b);
        });
        if (Array.isArray(x.g.modeTable) && x.g.modeTable.length) gb.appendChild(modeTable(x.g));
        s4.appendChild(gb);
      });
      parts.push([s4, '寄存器']);
    }

    // 代码：寄存器（完整文件）/ HAL 库 / 代码推导（按通用写法一步步推出这些文件）
    var snipEls = {}, CD = STM.codederive, hasCd = !!(CD && CD.has(t.id));
    if (t.snips.length || hasCd) {
      var s5 = sec('code', '代码');
      var CODE_KEY = 'lm.stm32.codestyle', have = { reg: hasCd, hal: t.snips.length > 0, cd: hasCd };
      function pick(k) { return have[k] ? k : have.reg ? 'reg' : have.hal ? 'hal' : 'cd'; }
      var style = pick(route.snip ? 'hal' : route.cv || ui.lsGet(CODE_KEY) || 'reg');
      var seg = el('div', 'cseg'); seg.setAttribute('role', 'tablist');
      var regBox = el('div', 'code-reg'), halBox = el('div', 'code-hal'), cdBox = el('div', 'code-cd');
      [['reg', '寄存器'], ['hal', 'HAL 库'], ['cd', '代码推导']].forEach(function (x) {
        if (!have[x[0]]) return;
        var b = ui.btn('cseg-b', x[1]); b.dataset.k = x[0]; b.setAttribute('role', 'tab');
        b.addEventListener('click', function () { if (style === x[0]) return; ui.lsSet(CODE_KEY, x[0]); app.update({ sec: 'code', cv: x[0], snip: null }); });
        seg.appendChild(b);
      });
      var syncSeg = function (r) {
        if (r) style = pick(r.snip ? 'hal' : r.cv || style);
        Array.prototype.forEach.call(seg.children, function (b) { var on = b.dataset.k === style; b.classList.toggle('on', on); b.setAttribute('aria-selected', on ? 'true' : 'false'); });
        regBox.hidden = style !== 'reg'; halBox.hidden = style !== 'hal'; cdBox.hidden = style !== 'cd'; varBar.hidden = style === 'hal';
        if (r && hasCd) drawVar(r);
      };
      if (seg.children.length > 1) s5.appendChild(seg);
      // 同一个外设有好几个驱动时（软件 / 硬件 I2C），上面一排切换
      var vs = hasCd ? CD.variants(t.id) : [], cx = null, filesFig = null, varBar = el('div', 'cd-vars');
      vs.forEach(function (id, k) {
        var b = ui.btn('cd-var', CD.tag(id)); b.dataset.k = id; b.title = CD.title(id);
        b.addEventListener('click', function () { if (cx !== id) app.update({ sec: 'code', cx: k ? id : null, cf: null }); });
        varBar.appendChild(b);
      });
      var drawVar = function (r) {
        var want = r.cx && vs.indexOf(r.cx) > 0 ? r.cx : vs[0];
        if (want !== cx) {
          cx = want; ui.clear(regBox); ui.clear(cdBox);
          filesFig = CD.files(cx, { file: r.cf }); regBox.appendChild(filesFig); CD.render(cdBox, cx);
          Array.prototype.forEach.call(varBar.children, function (b) { b.classList.toggle('on', b.dataset.k === cx); });
        } else if (r.cf && filesFig) filesFig.pick(r.cf);
      };
      if (vs.length > 1) s5.appendChild(varBar);
      s5.appendChild(regBox); s5.appendChild(halBox); s5.appendChild(cdBox);
      if (hasCd) drawVar(route);
      syncSeg();
      t.snips.forEach(function (s) {
        var card = el('div', 'snip'); card.id = 'snip-' + s.i;
        var hh = el('div', 'snip-h'); hh.appendChild(el('h3', null, s.title)); card.appendChild(hh);
        var cb = ui.codeBlock(s.code, { title: s.cat, copyLabel: '复制「' + s.title + '」' });
        var lines = s.code.split('\n').length;
        if (lines > 22) {
          cb.classList.add('folded');
          var ex = ui.btn('unfold', '展开全部 ' + lines + ' 行');
          ex.addEventListener('click', function () { cb.classList.remove('folded'); ex.remove(); });
          cb.appendChild(ex);
        }
        card.appendChild(cb);
        snipEls[s.title] = card;
        halBox.appendChild(card);
      });
      parts.push([s5, '代码']);
    }

    // 图
    if (t.figs.length) {
      var s6 = sec('figs', '架构图');
      s6.appendChild(figGrid(t.figs, app));
      parts.push([s6, '图']);
    }

    // 分页：上面一排标签，一次只显示一页
    var tabs = {};
    art.classList.add('tabbed');
    parts.forEach(function (x) {
      var id = x[0].id.replace(/^s-/, '');
      art.appendChild(x[0]); x[0].hidden = true; x[0].setAttribute('role', 'tabpanel');
      var a = el('a', 'snav-i', x[1]); a.href = app.urlOf({ v: 'topic', t: t.id, sec: id }); a.setAttribute('role', 'tab');
      a.addEventListener('click', function (e) { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button > 0) return; e.preventDefault(); app.update({ sec: id, snip: null }); });
      snav.appendChild(a); tabs[id] = [x[0], a];
    });
    snav.setAttribute('role', 'tablist');
    var curTab = null;
    function showTab(r) {
      var id = r.snip ? 'code' : r.sec && tabs[r.sec] ? r.sec : r.reg && tabs.regs ? 'regs' : parts.length ? parts[0][0].id.replace(/^s-/, '') : null;
      if (!id || id === curTab) return;
      var first = curTab === null; curTab = id;
      Object.keys(tabs).forEach(function (k) { var on = k === id; tabs[k][0].hidden = !on; tabs[k][1].classList.toggle('on', on); tabs[k][1].setAttribute('aria-selected', on ? 'true' : 'false'); });
      // 切页时如果已经往下翻过了，回到标签那一行
      if (!first) { var top = snav.getBoundingClientRect().top + window.scrollY - (parseFloat(getComputedStyle(snav).top) || 0); if (window.scrollY > top) window.scrollTo(0, top); }
      var on = tabs[id][1]; if (on.scrollIntoView && snav.scrollWidth > snav.clientWidth) snav.scrollLeft = on.offsetLeft - 16;
    }

    // 上一个 / 下一个外设：箭头 + 外设缩写，不写文字说明
    var foot = el('nav', 'tnext'); foot.setAttribute('aria-label', '外设');
    var prev = M.topics[t.order - 2], next = M.topics[t.order];
    [[prev, 'l', '上一个'], [next, 'r', '下一个']].forEach(function (x) {
      if (!x[0]) { foot.appendChild(el('span')); return; }
      var a = app.link({ v: 'topic', t: x[0].id }, 'tnext-i'); a.style.setProperty('--h', app.hue(x[0]));
      a.setAttribute('aria-label', x[2] + ' ' + x[0].code);
      if (x[1] === 'l') a.appendChild(ui.icon('back', 'ic tnext-a'));
      a.appendChild(el('b', null, x[0].code));
      if (x[1] === 'r') a.appendChild(ui.icon('next', 'ic tnext-a'));
      foot.appendChild(a);
    });
    art.appendChild(foot);
    root.appendChild(art);
    showTab(route);
    var lastSnip = null;
    function focusSnip(r) {
      if (!r.snip || r.snip === lastSnip) return;
      lastSnip = r.snip;
      var c = snipEls[r.snip]; if (!c) return;
      requestAnimationFrame(function () {
        c.scrollIntoView({ block: 'start', behavior: ui.reduced() ? 'auto' : 'smooth' });
        c.classList.remove('hit'); void c.offsetWidth; c.classList.add('hit');
      });
    }
    focusSnip(route);
    return {
      title: function () { return t.code; },
      update: function (r) { showTab(r); if (syncSeg) syncSeg(r); focusSnip(r); }
    };
  }
  // GPIO 8 种模式速查表（CNF / MODE / 半字节 / HAL 写法）
  function modeTable(g) {
    var box = el('div', 'mtable'), cap = el('h3', null, '8 种模式速查');
    box.appendChild(cap);
    var tb = el('table'), thead = el('thead'), tr = el('tr');
    ['模式', 'CNF', 'MODE', '4 位', 'ODR'].forEach(function (c) { tr.appendChild(el('th', null, c)); });
    thead.appendChild(tr); tb.appendChild(thead);
    var body = el('tbody');
    g.modeTable.forEach(function (m) {
      var r = el('tr');
      r.appendChild(el('td', null, m.title));
      r.appendChild(el('td', 'mono', m.cnf)); r.appendChild(el('td', 'mono', m.mode));
      r.appendChild(el('td', 'mono', m.nibble + ' (' + m.bits + ')'));
      r.appendChild(el('td', 'mono', m.odr == null ? '' : String(m.odr)));
      body.appendChild(r);
    });
    tb.appendChild(body);
    var scroller = el('div', 'tscroll'); scroller.appendChild(tb); box.appendChild(scroller);
    if (g.modeTableNote) box.appendChild(el('p', 'sec-note', g.modeTableNote));
    return box;
  }

  /* ====================== 首页：芯片 + 板载模块 ====================== */
  function sigTopic(sig) {
    for (var i = 0; i < M.topics.length; i++) if (M.topics[i].sig && M.topics[i].sig.test(sig)) return M.topics[i];
    return null;
  }
  // 这个 MCU 引脚接了哪些模块的哪个脚
  function modsOfPin(name) {
    var out = [];
    STM.modules.list.forEach(function (m) { m.pins.forEach(function (p) { if (p.mcu === name) out.push({ m: m, p: p }); }); });
    return out;
  }
  function home(root, route, app) {
    var MODS = STM.modules;
    var wrap = el('div', 'boardh');
    wrap.appendChild(el('h1', 'sr-only', 'STM32F103ZET6 开发板'));
    var grid = el('div', 'chipv-g');
    var left = el('div', 'chipv-l');
    var stage = el('div', 'chipv-stage zoom-view'), content = el('div', 'zoom-content');
    stage.appendChild(content); left.appendChild(stage);
    var legend = el('div', 'legend');
    [['t-I', 'I/O'], ['t-P', '电源'], ['t-G', '地'], ['t-S', '系统'], ['used', '板上已接']].forEach(function (x) { var s = el('span', 'lg ' + x[0]); s.appendChild(el('i')); s.appendChild(el('span', null, x[1])); legend.appendChild(s); });
    left.appendChild(legend);

    // 模块标签：第一个是芯片本身，其余按类收成几组；点一组才展开这组的模块（只有一个模块的组直接打开）
    var GROUPS = [
      { id: 'base', name: '基础', ids: ['xtal', 'boot', 'usb', 'led', 'key', 'beep'] },
      { id: 'mem', name: '存储', ids: ['eeprom', 'flash', 'sd', 'sram', 'nand'] },
      { id: 'com', name: '通信', ids: ['stlink', 'rs232', 'rs485', 'can', 'w5500', 'esp32', 'lora'] },
      { id: 'sense', name: '传感', ids: ['ma420', 'ds18b20', 'pot'] },
      { id: 'disp', name: '显示', ids: ['lcd'] }
    ];
    var grouped = {};
    GROUPS.forEach(function (g) { g.ids = g.ids.filter(function (id) { return MODS.byId[id]; }); g.ids.forEach(function (id) { grouped[id] = g.id; }); });
    var rest = MODS.list.filter(function (m) { return !grouped[m.id]; }).map(function (m) { return m.id; });
    if (rest.length) { GROUPS.push({ id: 'etc', name: '其他', ids: rest }); rest.forEach(function (id) { grouped[id] = 'etc'; }); }
    GROUPS = GROUPS.filter(function (g) { return g.ids.length; });

    var tags = el('div', 'mtags'), sub = el('div', 'mtags msub');
    tags.setAttribute('aria-label', '板上的芯片和模块');
    var chipBtn = ui.btn('mtag', 'STM32'), grpBtn = {}, modBtn = {}, openG = null;
    chipBtn.addEventListener('click', function () { openG = null; app.update({ m: null, mp: null, pin: null, q: null }); renderSub(); mark(); });
    tags.appendChild(chipBtn);
    GROUPS.forEach(function (g) {
      var b = ui.btn('mtag mgrp', g.name); grpBtn[g.id] = b;
      if (g.ids.length > 1) b.setAttribute('aria-expanded', 'false');
      b.addEventListener('click', function () {
        if (g.ids.length === 1) { app.update({ m: g.ids[0], mp: null, pin: null, q: null }); return; }
        openG = openG === g.id ? null : g.id; renderSub(); mark();
      });
      tags.appendChild(b);
    });
    function modButton(m) {
      var b = ui.btn('mtag', m.tag); modBtn[m.id] = b;
      var tp = m.topic && M.topicById[m.topic]; if (tp) b.style.setProperty('--h', app.hue(tp));
      b.addEventListener('click', function () { app.update({ m: m.id, mp: null, pin: null, q: null }); });
      var pins = m.pins.filter(function (p) { return p.mcu && M.pinByName[p.mcu]; }).map(function (p) { return M.pinByName[p.mcu].n; });
      b.addEventListener('mouseenter', function () { if (!curM) chip.light(pins, tp ? app.hue(tp) : null); });
      b.addEventListener('mouseleave', function () { if (!curM) chip.light(matches(lastQ), null); });
      return b;
    }
    function renderSub() {
      ui.clear(sub); modBtn = {};
      var g = null; GROUPS.forEach(function (x) { if (x.id === openG && x.ids.length > 1) g = x; });
      sub.hidden = !g;
      if (g) g.ids.forEach(function (id) { sub.appendChild(modButton(MODS.byId[id])); });
    }
    function mark() {
      chipBtn.classList.toggle('on', !curM); chipBtn.setAttribute('aria-pressed', !curM ? 'true' : 'false');
      GROUPS.forEach(function (g) {
        var b = grpBtn[g.id], has = !!curM && grouped[curM] === g.id;
        b.classList.toggle('on', has); b.classList.toggle('open', openG === g.id && g.ids.length > 1);
        if (g.ids.length > 1) b.setAttribute('aria-expanded', openG === g.id ? 'true' : 'false');
        if (g.ids.length === 1) b.setAttribute('aria-pressed', has ? 'true' : 'false');
      });
      Object.keys(modBtn).forEach(function (k) { var on = k === curM; modBtn[k].classList.toggle('on', on); modBtn[k].setAttribute('aria-pressed', on ? 'true' : 'false'); });
    }
    renderSub();
    // 右栏：模块分组 + 详情（手机上接在芯片图下面，电脑上在右边）
    var right = el('div', 'chipv-r');
    right.appendChild(tags); right.appendChild(sub);
    var detail = el('div', 'pdetail'); detail.setAttribute('aria-live', 'polite');
    right.appendChild(detail);
    grid.appendChild(left); grid.appendChild(right);
    wrap.appendChild(grid);
    root.appendChild(wrap);

    var chip = STM.chip.create({ labels: true, interactive: true, onPick: function (n) { app.update({ pin: String(n) }); } });
    var mod = null, curM = null, S = chip.S, dims = [S, S];
    var zoom = ui.Zoomer(stage, content, {
      max: 8, dbl: 3, wheelNeedsCtrl: true, wheelPans: true, scrollAtFit: true,
      onTap: function (target) {
        if (!target || !target.closest) return false;
        var g = target.closest('[data-pin]'); if (g) { app.update({ pin: g.getAttribute('data-pin') }); return true; }
        var mpn = target.closest('[data-mp]'); if (mpn && curM) { app.update({ mp: mpn.getAttribute('data-mp') }); return true; }
        return false;
      }
    });
    var lastW = 0;
    function fit(force) { var w = stage.clientWidth; if (w && (force || w !== lastW)) { lastW = w; zoom.fit(dims[0], dims[1]); } }
    var ro = window.ResizeObserver ? new ResizeObserver(function () { fit(); }) : null;
    if (ro) ro.observe(stage); else window.addEventListener('resize', function () { fit(); });

    function showStage(mid) {
      ui.clear(content);
      if (mid) {
        mod = MODS.draw(mid, { onPick: function (k) { app.update({ mp: k }); } });
        content.appendChild(mod.svg); dims = [mod.w, mod.h];
        var tp = M.topicById[MODS.byId[mid].topic]; if (tp) stage.style.setProperty('--h', app.hue(tp));
      } else { mod = null; content.appendChild(chip.svg); dims = [S, S]; stage.style.removeProperty('--h'); }
      stage.style.aspectRatio = dims[0] + ' / ' + dims[1];
      stage.classList.toggle('is-mod', !!mid);
      legend.hidden = !!mid;
      if (mid) openG = grouped[mid] || null;
      renderSub(); mark();
      requestAnimationFrame(function () { fit(true); });
    }

    function matches(q) {
      var Q = String(q || '').toUpperCase().replace(/\s+/g, ''), out = [];
      if (!Q) return out;
      M.pins.forEach(function (p) {
        var hay = [p.name].concat(p.sigs, p.board.map(function (r) { return r.name.toUpperCase(); }));
        if (String(p.n) === Q || hay.some(function (s) { return String(s).toUpperCase().replace(/\s+/g, '').indexOf(Q) > -1; })) out.push(p.n);
      });
      return out;
    }
    function pinBtn(name, cls) {
      var q = M.pinByName[name];
      var b = ui.btn(cls || 'chipbtn', name); if (!q) return b;
      b.title = '在芯片图上看 ' + name + '（' + q.n + ' 脚）';
      b.addEventListener('click', function () { app.update({ m: null, mp: null, pin: String(q.n) }); });
      return b;
    }

    function renderChipDetail(n) {
      ui.clear(detail);
      var p = M.pinByN[n];
      detail.classList.toggle('empty', !p);
      if (!p) { detail.appendChild(el('h2', 'pd-empty-h', '选一个引脚')); return; }
      var hh = el('div', 'pd-h'); hh.appendChild(el('h2', 'mono', p.name)); hh.appendChild(el('span', null, p.n + ' 脚，' + M.TYPE_NAME[p.type])); detail.appendChild(hh);
      function sigRow(label, list, fmt) {
        if (!list.length) return;
        var r = el('div', 'pd-row'); r.appendChild(el('h3', null, label));
        var w = el('div', 'pd-sigs');
        list.forEach(function (x) {
          var name = fmt ? fmt(x).sig : x, extra = fmt ? fmt(x).extra : '', tp = sigTopic(name);
          var s = tp ? app.link({ v: 'topic', t: tp.id }, 'sig') : el('span', 'sig');
          if (tp) { s.style.setProperty('--h', app.hue(tp)); s.title = tp.code; }
          s.appendChild(el('b', null, name)); if (extra) s.appendChild(el('span', null, extra));
          w.appendChild(s);
        });
        r.appendChild(w); detail.appendChild(r);
      }
      var mods = modsOfPin(p.name);
      if (mods.length) {
        var mr = el('div', 'pd-row'); mr.appendChild(el('h3', null, '接到'));
        var mw = el('div', 'pd-sigs');
        mods.forEach(function (x) {
          var b = ui.btn('mlink'); b.appendChild(el('b', null, x.m.tag)); b.appendChild(el('span', null, x.p.name));
          var tp = M.topicById[x.m.topic]; if (tp) b.style.setProperty('--h', app.hue(tp));
          b.addEventListener('click', function () { app.update({ m: x.m.id, mp: x.p.k, pin: null }); });
          mw.appendChild(b);
        });
        mr.appendChild(mw); detail.appendChild(mr);
      }
      if (p.main && p.main !== p.name) sigRow('复位后', [p.main]);
      sigRow('复用功能', p.af);
      sigRow('重映射', p.rm.filter(function (x) { return x.sig !== 'GPIO'; }), function (x) { return { sig: x.sig, extra: x.bit ? x.bit : '' }; });
      var other = p.board.filter(function (r) { return !mods.length; });
      if (other.length) {
        var br = el('div', 'pd-row'); br.appendChild(el('h3', null, '板上'));
        other.forEach(function (r) {
          var b = el('div', 'pd-board'); b.appendChild(el('b', null, r.name));
          if (r.note) b.appendChild(el('span', null, r.note));
          if (r.page && M.schById[r.page]) { var a = ui.btn('linkbtn', '原理图'); a.addEventListener('click', function () { app.navigate({ sch: r.page }); }); b.appendChild(a); }
          br.appendChild(b);
        });
        detail.appendChild(br);
      }
      if (p.type === 'I' && /^P[A-G]\d+$/.test(p.name)) {
        var y = Number(p.name.slice(2)), port = 'GPIO' + p.name.charAt(1);
        var rb = ui.btn('linkbtn', port + (y < 8 ? '_CRL' : '_CRH'));
        rb.title = '配置这个脚';
        rb.addEventListener('click', function () { app.navigate({ v: 'topic', t: 'gpio', reg: y < 8 ? 'GPIO_CRL' : 'GPIO_CRH', i: port }); });
        var rr = el('div', 'pd-row'); rr.appendChild(rb); detail.appendChild(rr);
      }
    }

    function renderModDetail(mid, k) {
      ui.clear(detail); detail.classList.remove('empty');
      var m = MODS.byId[mid], tp = M.topicById[m.topic], p = null;
      m.pins.forEach(function (x) { if (x.k === k) p = x; });
      var hh = el('div', 'pd-h');
      if (p) {
        hh.appendChild(el('h2', 'mono', p.name));
        hh.appendChild(el('span', null, m.tag + (p.no ? ' · ' + p.no + ' 脚' : '')));
      } else {
        hh.appendChild(el('h2', null, m.tag));
        if (m.part) hh.appendChild(el('span', 'mono', m.part));
      }
      detail.appendChild(hh);
      if (p) {
        var cr = el('div', 'pd-row pd-conn'); cr.appendChild(el('h3', null, '接到'));
        if (p.mcu) {
          var q = M.pinByName[p.mcu];
          var b = pinBtn(p.mcu, 'mcubtn'); if (q) b.appendChild(el('span', null, q.n + ' 脚'));
          cr.appendChild(b);
        } else cr.appendChild(el('b', 'mono pd-net', p.net || '—'));
        detail.appendChild(cr);
        // 这个脚是干什么的（pindoc.js，大白话讲清楚，板上的接法也讲在里面）
        var role = STM.pindoc ? STM.pindoc(m, p).role : (p.note || '');
        if (role) { var dr = el('div', 'pd-row pd-doc'); dr.appendChild(el('h3', null, '作用')); dr.appendChild(el('p', null, role)); detail.appendChild(dr); }
      }
      // 全部脚：一行一个，点了选中
      var list = el('div', 'pd-mps');
      m.pins.forEach(function (x) {
        var b = ui.btn('pd-mp' + (p && x.k === p.k ? ' on' : ''));
        var to = x.mcu || x.net || ''; b.appendChild(el('span', 'mono', x.name)); b.appendChild(el('span', 'mono ' + (x.mcu ? 'to-mcu' : 'to-net'), to === x.name ? '' : to));
        b.addEventListener('click', function () { app.update({ mp: x.k }); });
        list.appendChild(b);
      });
      detail.appendChild(list);
      var links = el('div', 'pd-row pd-links');
      if (tp) links.appendChild(topicTag(tp, app));
      var drv = STM.codederive ? STM.codederive.forBoard(m.id) : [], seen = {};
      drv.forEach(function (d) { seen[d.file] = (seen[d.file] || 0) + 1; });
      drv.forEach(function (d) {
        var tt = M.topicById[d.topic]; if (!tt) return;
        var r = { v: 'topic', t: d.topic, sec: 'code', cv: 'reg', cf: d.file }; if (d.id !== d.topic) r.cx = d.id;
        // 同名文件（比如软件 / 硬件 I2C 都叫 eeprom.c）：另一个版本在后面注明
        var tag = seen[d.file] > 1 && d.id !== d.topic ? STM.codederive.tag(d.id) : '';
        var cb = app.link(r, 'linkbtn mono'); cb.textContent = d.file + (tag ? '（' + tag + '）' : ''); cb.title = d.title + '：' + d.file; links.appendChild(cb);
      });
      if (m.sch && M.schById[m.sch]) { var a = ui.btn('linkbtn', '原理图'); a.addEventListener('click', function () { app.navigate({ sch: m.sch }); }); links.appendChild(a); }
      detail.appendChild(links);
    }

    var lastPin, lastQ = null, lastMP;
    function apply(r) {
      var mid = r.m && MODS.byId[r.m] ? r.m : null;
      if (mid !== curM || (!content.firstChild)) { curM = mid; lastPin = undefined; lastMP = undefined; lastQ = null; showStage(mid); }
      if (curM) {
        var k = r.mp || null;
        if (k !== lastMP) {
          lastMP = k; mod.select(k); renderModDetail(curM, k);
          if (k && mod.pos[k] && zoom.scale() > 1.01) zoom.reveal(mod.pos[k].x, mod.pos[k].y);
        }
        return;
      }
      var q = r.q || '';
      if (q !== lastQ) {
        lastQ = q;
        chip.light(matches(q), null);      // 旧链接里的 q=… 只用来点亮引脚
      }
      var n = r.pin ? Number(r.pin) : null;
      if (n !== lastPin) {
        lastPin = n; chip.select(n); renderChipDetail(n);
        if (n) requestAnimationFrame(function () { var pos = chip.pos(n); zoom.focus(pos.x, pos.y, Math.max(2.2, 1)); });
      }
    }
    apply(route);
    return { title: function () { return 'STM32 学习台'; }, update: apply, destroy: function () { if (ro) ro.disconnect(); } };
  }

  /* ====================== 开发板 ====================== */
  var ACT = { low: '低电平有效', high: '高电平有效', data: '数据线' };
  function boardView(root, route, app) {
    var wrap = el('div', 'boardv');
    var head = el('header', 'pg-h'); head.appendChild(el('h1', null, '开发板'));
    wrap.appendChild(head);
    if (M.photo) {
      var ph = ui.btn('photo'); ph.appendChild(thumb(M.photo)); ph.appendChild(el('span', null, '实物图，点开放大'));
      ph.addEventListener('click', function () { app.navigate({ sch: 'photo' }); });
      wrap.appendChild(ph);
    }
    var res = el('section', 'sec'); res.appendChild(h2('板载资源'));
    M.boardGroups.forEach(function (gname) {
      var g = el('div', 'bgroup'); g.appendChild(el('h3', null, gname));
      M.board.filter(function (r) { return r.group === gname; }).forEach(function (r) {
        var row = el('div', 'brow');
        var nm = el('div', 'brow-n'); nm.appendChild(el('b', null, r.name)); if (r.note) nm.appendChild(el('span', null, r.note)); row.appendChild(nm);
        var pin = el('div', 'brow-p');
        if (r.pins.length === 1) { var a = app.link({ v: 'home', pin: String(r.pins[0]) }, 'mono'); a.textContent = r.mcu || String(r.pins[0]); pin.appendChild(a); }
        else pin.appendChild(el('span', 'mono', r.mcu || ''));
        if (ACT[r.active]) pin.appendChild(el('span', 'act a-' + r.active, ACT[r.active]));
        row.appendChild(pin);
        if (r.page && M.schById[r.page]) { var b = ui.btn('linkbtn', '原理图'); b.setAttribute('aria-label', r.name + ' 的原理图'); b.addEventListener('click', function () { app.navigate({ sch: r.page }); }); row.appendChild(b); }
        else row.appendChild(el('span'));
        g.appendChild(row);
      });
      res.appendChild(g);
    });
    wrap.appendChild(res);
    var sc = el('section', 'sec'); sc.appendChild(h2('原理图'));
    M.schGroups.forEach(function (gname) {
      var g = el('div', 'bgroup'); g.appendChild(el('h3', null, gname || '原理图'));
      var list = el('div', 'schlist');
      M.sch.filter(function (s) { return s.group === gname; }).forEach(function (s) {
        var b = ui.btn('schrow'); b.appendChild(el('span', null, s.title)); b.appendChild(ui.icon('next'));
        b.addEventListener('click', function () { app.navigate({ sch: s.id }); });
        list.appendChild(b);
      });
      g.appendChild(list); sc.appendChild(g);
    });
    wrap.appendChild(sc);
    root.appendChild(wrap);
    return { title: function () { return '开发板'; } };
  }

  STM.views = { home: home, topic: topic, board: boardView };
  STM.viewsUtil = { figGrid: figGrid, thumb: thumb, CW_KEY: CW_KEY };
})();
