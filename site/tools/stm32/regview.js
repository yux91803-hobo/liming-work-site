/* regview.js — 寄存器计算器面板（宽屏从右侧滑出，窄屏全屏）
   路由 reg / i / n / val 决定显示哪个寄存器、哪个实例、第几通道、当前值；改值时原地更新路由（可分享）。
   计算规则全在 reg-core.js，这里只管界面。 */
(function () {
  'use strict';
  var STM = window.STM, ui = STM.ui, M = STM.model, R = M.R, C = window.STM32RegCore, el = ui.el;
  var app = null, root = null, panel = null, body = null, open = false, lastFocus = null;
  var ST = {};                       // 每个 寄存器|实例|通道 的计算状态 { v, touched, quick }
  var c = null, renderedV = null;    // 当前上下文、最后一次画出来的值
  var RWN = { rw: '读写', r: '只读', w: '只写', rc_w0: '写 0 清除', rc_w1: '写 1 清除', rs: '写 1 置位', rc_w: '读后清除', res: '保留' };

  function stKey(r, inst, n) { return r.id + '|' + (inst ? inst.name : '') + '|' + (n == null ? '' : n); }
  function stOf(r, inst, n) {
    var k = stKey(r, inst, n);
    if (!ST[k]) ST[k] = { v: R.initVal(r, n), touched: {}, quick: -1 };
    return ST[k];
  }
  function peer(src, inst) {
    var i = inst && R.instList(src).indexOf(inst) > -1 ? inst : R.defInst(src);
    var rg = R.nRange(src, i);
    return stOf(src, i, rg ? rg.lo : null).v;
  }
  function decodeInto(st, r, n, v, inst) {
    var p = R.P(r), base = R.initVal(r, n);
    st.v = (v & (Math.pow(2, p.w) - 1)) >>> 0; st.touched = {}; st.quick = -1;
    R.layout(r, st.v).forEach(function (f) { if (R.writable(f, inst) && C.fget(st.v, f) !== C.fget(base, f)) st.touched[f.name] = true; });
  }

  /* ---------- 骨架 ---------- */
  var nodes = {};
  function build() {
    root = el('div', 'sheet'); root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-labelledby', 'sh-title');
    var scrim = el('div', 'sheet-scrim'); scrim.addEventListener('click', function () { app.back(); });
    panel = el('section', 'sheet-p');
    var head = el('header', 'sh-h');
    var x = ui.btn('icon-btn sh-x', null, '关闭寄存器'); x.appendChild(ui.icon('close')); x.addEventListener('click', function () { app.back(); });
    var tt = el('div', 'sh-tt'), h = el('h2', 'mono'); h.id = 'sh-title';
    var sub = el('p'); tt.appendChild(h); tt.appendChild(sub);
    var tp = el('a', 'ttag sh-topic');
    head.appendChild(x); head.appendChild(tt); head.appendChild(tp);
    body = el('div', 'sh-body');
    var L = el('div', 'sh-l'), Rr = el('div', 'sh-r');
    nodes = { h: h, sub: sub, tp: tp, sel: el('div', 'sh-sel'), na: el('p', 'banner warn'), addr: el('div', 'sh-addr'), val: el('div', 'sh-val'), bits: el('div', 'bits'),
      quick: el('div', 'sh-quick'), fx: el('div', 'sh-fx'), fields: el('div', 'fields'), warn: el('div', 'sh-warn'), code: el('div', 'sh-code'), meta: el('div', 'sh-meta') };
    [nodes.sel, nodes.na, nodes.quick, nodes.fx, nodes.fields].forEach(function (n) { L.appendChild(n); });
    var sticky = el('div', 'sh-stick');
    [nodes.addr, nodes.val, nodes.bits, nodes.warn, nodes.code, nodes.meta].forEach(function (n) { sticky.appendChild(n); });
    Rr.appendChild(sticky);
    body.appendChild(L); body.appendChild(Rr);
    panel.appendChild(head); panel.appendChild(body);
    root.appendChild(scrim); root.appendChild(panel);
    root.addEventListener('keydown', function (e) {
      if (e.key !== 'Tab') return;
      var f = Array.prototype.filter.call(panel.querySelectorAll('button, a[href], input, select, [tabindex="0"]'), function (n) { return !n.disabled && n.offsetParent !== null; });
      if (!f.length) return;
      var i = f.indexOf(document.activeElement);
      if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
    });
    // 值输入框
    var lab = el('label', 'hexin'); lab.appendChild(el('span', null, '值'));
    var inp = el('input', 'mono'); inp.setAttribute('aria-label', '寄存器值（十六进制）'); inp.setAttribute('autocomplete', 'off'); inp.setAttribute('spellcheck', 'false'); inp.setAttribute('inputmode', 'text');
    lab.appendChild(inp); nodes.hex = inp;
    var err = el('span', 'hexin-err'); nodes.hexErr = err;
    var rst = ui.btn('pill', '复位值'); rst.addEventListener('click', function () { var st = c.st; st.v = R.initVal(c.r, c.n); st.touched = {}; st.quick = -1; changed(); ui.toast('已恢复复位值'); });
    var vrow = el('div', 'sh-valrow'); vrow.appendChild(lab); vrow.appendChild(rst);
    nodes.val.appendChild(vrow); nodes.val.appendChild(err);
    nodes.dec = el('p', 'sh-dec'); nodes.val.appendChild(nodes.dec);
    inp.addEventListener('input', function () {
      var v = C.parseHexStr(inp.value), w = R.P(c.r).w;
      if (v == null || v > Math.pow(2, w) - 1) { err.textContent = '输入 ' + (w / 4) + ' 位以内的十六进制，比如 0x' + C.hexd(R.initVal(c.r, c.n), w / 4); return; }
      err.textContent = '';
      decodeInto(c.st, c.r, c.n, v, c.inst); changed({ fromHex: true });
    });
    inp.addEventListener('blur', function () { if (c) { inp.value = C.hexS(c.st.v, R.P(c.r).w); err.textContent = ''; } });
  }

  /* ---------- 打开 / 关闭（由路由驱动） ---------- */
  function sync(route) {
    if (!route.reg) { if (open) close(); return; }
    var r = R.reg(route.reg); if (!r) return;
    var inst = route.i ? R.findInst(r, route.i) : (c && c.r === r ? c.inst : R.defInst(r));
    var rg = R.nRange(r, inst), n = rg ? Math.min(rg.hi, Math.max(rg.lo, route.n != null ? Number(route.n) : rg.lo)) : null;
    var st = stOf(r, inst, n);
    if (route.val != null) { var v = C.parseHexStr(route.val); if (v != null && v !== st.v) decodeInto(st, r, n, v, inst); }
    var same = open && c && c.r === r && c.inst === inst && c.n === n;
    c = { r: r, inst: inst, n: n, st: st, peer: peer, lay: R.layout(r, st.v) };
    if (!open) show();
    if (!same) renderAll(); else if (st.v !== renderedV) renderValue({});   // 自己改值触发的路由更新不用再画一遍
  }
  function show() {
    open = true; lastFocus = document.activeElement;
    document.getElementById('layers').appendChild(root);
    document.getElementById('app').inert = true;
    document.documentElement.classList.add('modal');
    requestAnimationFrame(function () { root.classList.add('on'); try { panel.querySelector('.sh-x').focus({ preventScroll: true }); } catch (e) {} });
  }
  function close() {
    open = false; c = null;
    root.classList.remove('on');
    document.getElementById('app').inert = false;
    document.documentElement.classList.remove('modal');
    var r = root;
    setTimeout(function () { if (!open && r.parentNode) r.remove(); }, ui.reduced() ? 0 : 260);
    var back = lastFocus; lastFocus = null;
    if (back && back.isConnected) try { back.focus({ preventScroll: true }); } catch (e) {}
    else { var row = document.querySelector('.rrow:focus'); if (row) row.blur(); }
  }

  /* ---------- 渲染 ---------- */
  function renderAll() {
    var r = c.r, g = R.groupOf(r), t = M.topicOfReg(r.id);
    nodes.h.textContent = r.name;
    nodes.sub.textContent = (r.title || '') + (r.title_en ? '　' + r.title_en : '');
    if (t) {
      nodes.tp.hidden = false; nodes.tp.textContent = t.code; nodes.tp.style.setProperty('--h', app.hue(t));
      nodes.tp.href = app.urlOf({ v: 'topic', t: t.id }); nodes.tp.setAttribute('aria-label', '外设：' + t.name);
      nodes.tp.onclick = function (e) { e.preventDefault(); app.navigate({ v: 'topic', t: t.id }); };
    } else nodes.tp.hidden = true;
    panel.style.setProperty('--h', t ? app.hue(t) : '');
    renderSel(g);
    var na = R.naOnly(r.only, c.inst);
    nodes.na.hidden = !na; nodes.na.textContent = na ? (c.inst ? c.inst.name + ' 没有这个寄存器：' : '') + R.naWhy(r.only) : '';
    renderFx();
    renderMeta();
    renderValue({ full: true });
    body.scrollTop = 0;
  }
  function seg(label, items, cur, onPick) {
    var w = el('div', 'segctl'), l = el('span', 'segctl-l', label), box = el('div', 'segctl-b');
    box.setAttribute('role', 'radiogroup'); box.setAttribute('aria-label', label);
    items.forEach(function (it) {
      var b = ui.btn('segctl-i', it.text); b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', String(it.key === cur));
      if (it.title) b.title = it.title;
      b.addEventListener('click', function () { if (it.key !== cur) onPick(it.key); });
      box.appendChild(b);
    });
    w.appendChild(l); w.appendChild(box); return w;
  }
  function renderSel(g) {
    var s = nodes.sel, r = c.r; ui.clear(s);
    var il = R.instList(r);
    if (il.length > 1) s.appendChild(seg('实例', il.map(function (i) { return { key: i.name, text: i.name, title: i.kind ? i.kind + '定时器' : '' }; }), c.inst ? c.inst.name : '', function (k) { app.update({ i: k, val: null, n: null }); }));
    var rg = R.nRange(r, c.inst);
    if (rg) {
      var its = []; for (var n = rg.lo; n <= rg.hi; n++) its.push({ key: n, text: g.id === 'dma' ? '通道 ' + n : R.member(r) + n });
      var sel = el('select', 'selctl'); sel.setAttribute('aria-label', g.id === 'dma' ? '通道' : '编号');
      its.forEach(function (it) { var o = el('option', null, it.text); o.value = String(it.key); if (it.key === c.n) o.selected = true; sel.appendChild(o); });
      sel.addEventListener('change', function () { app.update({ n: sel.value, val: null }); });
      var w = el('label', 'segctl'); w.appendChild(el('span', 'segctl-l', g.id === 'dma' ? '通道' : '编号')); w.appendChild(sel); s.appendChild(w);
    }
    if (Array.isArray(r.alt) && r.alt.length) {
      r.alt.slice().sort(function (a, b) { return a.bits[1] - b.bits[1]; }).forEach(function (a) {
        var m = /CC(\d)S/.exec(String(a.if && a.if.field)), ch = m ? m[1] : '?', on = R.altOn(r, a, c.st.v);
        s.appendChild(seg('通道 ' + ch, [{ key: 'oc', text: '输出比较' }, { key: 'ic', text: '输入捕获' }], on ? 'ic' : 'oc', function (k) {
          var f = R.P(r).byName[a.if.field]; if (!f) return;
          var cur = C.fget(c.st.v, f), x = k === 'ic' ? (cur === 0 ? 1 : cur) : 0;
          c.st.v = C.fset(c.st.v, f, x); c.st.touched[f.name] = true; c.st.quick = -1;
          changed({ relayout: true });
        }));
      });
    }
    s.hidden = !s.firstChild;
  }

  // 改了值之后：更新路由（可分享）+ 重画受影响的部分
  function changed(o) {
    o = o || {};
    c.lay = R.layout(c.r, c.st.v);
    renderValue({ fromHex: o.fromHex, full: o.relayout });
    if (o.relayout) renderSel(R.groupOf(c.r));
    app.update({ val: C.hexC(c.st.v, R.P(c.r).w) });
  }
  function renderValue(o) {
    var r = c.r, p = R.P(r), w = p.w, v = c.st.v;
    if (!(o.fromHex && document.activeElement === nodes.hex)) nodes.hex.value = C.hexS(v, w);
    nodes.dec.textContent = '十进制 ' + v + '　二进制 ' + C.bin(v, w).replace(/(\d{4})(?=\d)/g, '$1 ');
    // 地址
    ui.clear(nodes.addr);
    var ex = R.regExpr(r, c.inst, c.n), a = R.addrOf(r, c.inst, c.n);
    nodes.addr.appendChild(el('code', 'sh-expr', ex));
    if (a != null) {
      var rg = R.nRange(r, c.inst);
      var ad = el('span', 'sh-ad'); ad.appendChild(el('b', 'mono', C.hexS(a, 32)));
      ad.appendChild(el('span', null, '= ' + c.inst.base + ' + ' + r.offset + (rg ? ' + ' + r.stride + ' × ' + (c.n - rg.lo) : '')));
      nodes.addr.appendChild(ad);
    }
    renderBits();
    renderFields(o.full || !nodes.fields.firstChild);
    renderQuick();
    renderWarn();
    renderCode();
    renderedV = v;
  }

  /* 位段条：每格一位，点一下翻转这一位（只读 / 保留位不能点）；字段名标在上方 */
  function renderBits() {
    var r = c.r, p = R.P(r), w = p.w, v = c.st.v, box = nodes.bits;
    ui.clear(box);
    box.style.setProperty('--w', w);
    var rows = w === 32 ? [[31, 16], [15, 0]] : [[15, 0]];
    rows.forEach(function (rr) {
      var row = el('div', 'bits-row'), names = el('div', 'bits-names'), cells = el('div', 'bits-cells');
      for (var b = rr[0]; b >= rr[1]; b--) {
        var f = fieldAt(b), on = (v >>> b) & 1, can = f && R.writable(f, c.inst) && p.kind !== 'ro';
        var cell = el(can ? 'button' : 'span', 'bit' + (on ? ' one' : '') + (!f || f.reserved ? ' res' : '') + (f && !can && !f.reserved ? ' ro' : ''));
        cell.textContent = on;
        if (can) {
          cell.type = 'button';
          cell.setAttribute('aria-label', '位 ' + b + ' = ' + on + '，' + f.name + '，点一下改成 ' + (on ? 0 : 1));
          (function (bit, fld) { cell.addEventListener('click', function () { c.st.v = (c.st.v ^ (1 << bit)) >>> 0; c.st.touched[fld.name] = true; c.st.quick = -1; changed({ relayout: !!(r.alt && r.alt.length) }); }); })(b, f);
        } else cell.setAttribute('aria-hidden', 'true');
        if (f && b === f.bits[1]) cell.classList.add('f-end');
        if (f && b === f.bits[0]) cell.classList.add('f-start');
        if (b % 4 === 0) cell.classList.add('nib');
        cells.appendChild(cell);
      }
      // 字段名：按字段在本行内的跨度放置
      var seen = {};
      for (var bb = rr[0]; bb >= rr[1]; bb--) {
        var ff = fieldAt(bb); if (!ff || seen[ff.name]) continue; seen[ff.name] = 1;
        var hi = Math.min(ff.bits[0], rr[0]), lo = Math.max(ff.bits[1], rr[1]);
        var nm = el('span', 'bits-n' + (ff.reserved ? ' res' : ''), ff.reserved ? '' : ff.name);
        nm.style.gridColumn = (rr[0] - hi + 1) + ' / span ' + (hi - lo + 1);
        if (!ff.reserved) nm.title = ff.name + ' [' + ff.bits[0] + (ff.bits[0] !== ff.bits[1] ? ':' + ff.bits[1] : '') + ']';
        names.appendChild(nm);
      }
      var idx = el('div', 'bits-idx');
      for (var k = rr[0]; k >= rr[1]; k--) idx.appendChild(el('span', null, k % 4 === 0 || k === rr[0] ? k : ''));
      row.appendChild(names); row.appendChild(cells); row.appendChild(idx);
      box.appendChild(row);
    });
  }
  function fieldAt(b) {
    for (var i = 0; i < c.lay.length; i++) { var f = c.lay[i]; if (b <= f.bits[0] && b >= f.bits[1]) return f; }
    return null;
  }

  /* 字段列表：重复字段（GPIO 每脚一组、EXTI 每线一位…）按组加小标题；GPIO 的组标题直接写成 PA9 并带上板上用途 */
  function renderFields(rebuild) {
    var box = nodes.fields, r = c.r, p = R.P(r), v = c.st.v;
    if (rebuild) {
      ui.clear(box);
      box.appendChild(el('h3', 'sh-h3', '字段'));
      var lastY = null, gpio = c.inst && /^GPIO([A-G])$/.exec(c.inst.name);
      c.lay.forEach(function (f) {
        if (f.reserved) return;
        if (R.isRep(r, f)) {
          var y = C.yOf(f);
          if (y !== lastY) {
            lastY = y;
            var lab = C.repLabel(f.rep) + ' ' + y, extra = '';
            if (gpio && C.repLabel(f.rep) === '引脚') {
              var pin = M.pinByName['P' + gpio[1] + y];
              lab = 'P' + gpio[1] + y;
              if (pin && pin.board.length) extra = pin.board.map(function (x) { return x.name; }).join('、');
            }
            var gh = el('div', 'fgroup-h'); gh.appendChild(el('b', 'mono', lab)); if (extra) gh.appendChild(el('span', null, extra));
            box.appendChild(gh);
          }
        }
        box.appendChild(fieldRow(f));
      });
    } else {
      Array.prototype.forEach.call(box.querySelectorAll('.frow'), function (row) { updateRow(row); });
    }
  }
  function fieldRow(f) {
    var row = el('div', 'frow'); row._f = f;
    var top = el('div', 'frow-h');
    top.appendChild(el('b', 'mono', f.name));
    top.appendChild(el('span', 'frow-bits mono', '[' + f.bits[0] + (f.bits[0] !== f.bits[1] ? ':' + f.bits[1] : '') + ']'));
    var rw = el('span', 'rw rw-' + f.rw, RWN[f.rw] || f.rw); top.appendChild(rw);
    row.appendChild(top);
    var ctl = el('div', 'frow-c'); row.appendChild(ctl); row._ctl = ctl;
    var mean = el('p', 'frow-m'); row.appendChild(mean); row._m = mean;
    if (f.desc) row.appendChild(el('p', 'frow-d', f.desc));
    updateRow(row);
    return row;
  }
  function updateRow(row) {
    var f = row._f, v = c.st.v, x = C.fget(v, f), w = C.fw(f), b = C.bin(x, w), inf = R.info(c, f, v);
    var can = R.writable(f, c.inst) && R.P(c.r).kind !== 'ro';
    row.classList.toggle('touched', !!c.st.touched[f.name]);
    row.classList.toggle('na', R.naOnly(f.only, c.inst));
    var ctl = row._ctl, key = (inf.vals ? 'v' + inf.vals.length + (inf.basis || '') : 'n') + (can ? 1 : 0);
    if (ctl._key !== key) {
      ctl._key = key; ui.clear(ctl);
      if (!can) ctl.appendChild(el('span', 'frow-ro mono', inf.numeric ? String(x) : b));
      else if (w === 1 && inf.vals && inf.vals.length === 2 && !inf.vals[0].t && !inf.vals[1].t) {
        var sw = el('button', 'switch'); sw.type = 'button'; sw.setAttribute('role', 'switch'); sw.setAttribute('aria-label', f.name);
        sw.appendChild(el('i'));
        sw.addEventListener('click', function () { setField(f, C.fget(c.st.v, f) ? 0 : 1); });
        ctl.appendChild(sw); ctl._sw = sw;
      } else if (inf.vals && inf.vals.length) {
        var sel = el('select', 'selctl'); sel.setAttribute('aria-label', f.name);
        inf.vals.forEach(function (it) { var o = el('option', null, it.v + (it.t ? '　' + it.t : '')); o.value = it.v; sel.appendChild(o); });
        sel.addEventListener('change', function () { var y = C.parseSet(sel.value, f); if (y != null) setField(f, y); });
        ctl.appendChild(sel); ctl._sel = sel; ctl._vals = inf.vals;
      } else {
        var ni = el('input', 'numin mono'); ni.setAttribute('aria-label', f.name + '（十进制、0x 或 0b）'); ni.setAttribute('inputmode', 'numeric'); ni.setAttribute('autocomplete', 'off');
        var ne = el('span', 'numin-e');
        ni.addEventListener('input', function () { var res = C.parseNum(ni.value, w); if (res.err) { ne.textContent = res.err; return; } ne.textContent = ''; setField(f, res.x, true); });
        ni.addEventListener('blur', function () { ni.value = String(C.fget(c.st.v, f)); ne.textContent = ''; });
        ctl.appendChild(ni); ctl.appendChild(ne); ctl._num = ni;
        ctl.appendChild(el('span', 'numin-r', '0~' + (Math.pow(2, w) - 1)));
      }
    }
    if (ctl._sw) { ctl._sw.setAttribute('aria-checked', String(!!x)); ctl._sw.classList.toggle('on', !!x); }
    if (ctl._sel) {
      var hit = -1; ctl._vals.forEach(function (it, i) { if (hit < 0 && C.wild(it.v, b)) hit = i; });
      ctl._sel.selectedIndex = hit;
      if (hit < 0) { ctl._sel.selectedIndex = -1; }
    }
    if (ctl._num && document.activeElement !== ctl._num) ctl._num.value = String(x);
    var t = R.meaning(inf, b);
    row._m.textContent = (inf.numeric ? '= ' + x + (w > 4 ? '（0x' + C.hexd(x, Math.ceil(w / 4)) + '）' : '') : '= ' + b) + (t ? '　' + t : '') + (inf.basis ? '　' + inf.basis : '');
  }
  function setField(f, x, typing) {
    c.st.v = (C.fset(c.st.v, f, x) | R.P(c.r).m1) >>> 0;
    c.st.touched[f.name] = true; c.st.quick = -1;
    var relayout = Array.isArray(c.r.alt) && c.r.alt.length;
    changed({ relayout: relayout });
  }

  /* 常用配置 */
  function renderQuick() {
    var box = nodes.quick, qs = c.r.quick;
    ui.clear(box);
    if (!Array.isArray(qs) || !qs.length) { box.hidden = true; return; }
    box.hidden = false;
    box.appendChild(el('h3', 'sh-h3', '常用配置'));
    var act = R.quickMatch(c), list = el('div', 'qlist');
    qs.forEach(function (q, i) {
      var b = ui.btn('qchip' + (i === act ? ' on' : ''), q.title); b.setAttribute('aria-pressed', String(i === act));
      b.addEventListener('click', function () {
        if (q.port && q.port !== (c.inst && c.inst.name) && R.instList(c.r).some(function (x) { return x.name === q.port; })) {
          var r = c.r, inst = R.findInst(r, q.port), rg = R.nRange(r, inst), st = stOf(r, inst, rg ? rg.lo : null), qv = R.quickVal(r, q);
          st.v = qv.v; st.touched = {}; qv.keys.forEach(function (k) { st.touched[k] = true; }); st.quick = i;
          app.update({ i: q.port, val: C.hexC(qv.v, R.P(r).w) });
          return;
        }
        var qv2 = R.quickVal(c.r, q); c.st.v = qv2.v; c.st.touched = {}; qv2.keys.forEach(function (k) { c.st.touched[k] = true; }); c.st.quick = i;
        changed({ relayout: true });
        ui.toast('已套用：' + q.title);
      });
      list.appendChild(b);
    });
    box.appendChild(list);
    if (act > -1) {
      var q = qs[act], d = el('div', 'qdetail');
      if (q.note) d.appendChild(el('p', null, q.note));
      if (q.odr != null && q.pin != null) d.appendChild(el('p', null, '另需把 ODR' + q.pin + ' 写成 ' + q.odr + (Number(q.odr) ? '（上拉）' : '（下拉）') + '。'));
      var links = el('div', 'qlinks');
      if (q.snippet && M.snipBy(q.snippet.cat, q.snippet.title)) { var sb = ui.btn('linkbtn', '代码：' + q.snippet.title); sb.addEventListener('click', function () { app.navigate({ v: 'topic', snip: String(q.snippet.title) }); }); links.appendChild(sb); }
      if (q.teach && M.figById[q.teach]) { var tb = ui.btn('linkbtn', '教学图：' + M.figById[q.teach].title); tb.addEventListener('click', function () { app.navigate({ fig: String(q.teach) }); }); links.appendChild(tb); }
      if (q.port && q.pin != null && /^GPIO[A-G]$/.test(q.port)) { var pn = M.pinByName['P' + q.port.charAt(4) + q.pin]; if (pn) { var pb = ui.btn('linkbtn', '引脚：' + pn.name); pb.addEventListener('click', function () { app.navigate({ v: 'home', pin: String(pn.n) }); }); links.appendChild(pb); } }
      if (links.firstChild) d.appendChild(links);
      if (d.firstChild) box.appendChild(d);
    }
  }

  /* 公式助手：波特率（USART_BRR）、I2C 时钟（I2C_CCR） */
  function renderFx() {
    var box = nodes.fx, r = c.r; ui.clear(box);
    if (r.formula !== 'baud' && r.formula !== 'i2c_ccr') { box.hidden = true; return; }
    box.hidden = false;
    box.appendChild(el('h3', 'sh-h3', r.formula === 'baud' ? '算波特率' : '算 I2C 时钟'));
    if (r.formulaText) box.appendChild(el('p', 'sec-note', r.formulaText));
    var row = el('div', 'fxrow'), out = el('p', 'fxout');
    function num(label, val, unit) {
      var l = el('label', 'fxin'); l.appendChild(el('span', null, label));
      var i = el('input', 'mono'); i.value = String(val); i.setAttribute('inputmode', 'decimal'); i.setAttribute('autocomplete', 'off'); l.appendChild(i);
      if (unit) l.appendChild(el('span', 'fxu', unit));
      row.appendChild(l); return i;
    }
    var go = ui.btn('pill solid', '写入寄存器');
    if (r.formula === 'baud') {
      var fp = num('fPCLK', c.inst && c.inst.name === 'USART1' ? 72 : 36, 'MHz'), bd = num('波特率', 115200, '');
      var calc = function () { return R.baud(fp.value, bd.value); };
      var showB = function () { var k = calc(); out.textContent = !k ? '' : k.err ? 'USARTDIV = ' + k.div.toFixed(4) + '，超出范围' : 'USARTDIV = ' + k.div.toFixed(4) + '，整数部分 ' + k.m + '，小数部分 ' + k.fr + '/16；实际波特率 ' + Math.round(k.real) + '，误差 ' + (k.e >= 0 ? '+' : '') + k.e.toFixed(2) + '%'; go.disabled = !k || !!k.err; };
      fp.addEventListener('input', showB); bd.addEventListener('input', showB);
      go.addEventListener('click', function () {
        var k = calc(), p = R.P(r); if (!k || k.err) return;
        var fm = p.byName.DIV_Mantissa, ff = p.byName.DIV_Fraction; if (!fm || !ff) return;
        c.st.v = C.fset(C.fset(c.st.v, fm, k.m), ff, k.fr); c.st.touched.DIV_Mantissa = c.st.touched.DIV_Fraction = true; c.st.quick = -1;
        changed(); ui.toast('已写入 BRR');
      });
      showB();
    } else {
      var pc = num('PCLK1', 36, 'MHz'), scl = num('SCL', 100, 'kHz');
      var calcC = function () { var du = R.P(r).byName.DUTY; return R.i2cCcr(pc.value, scl.value, du ? C.fget(c.st.v, du) : 0); };
      var showC = function () { var k = calcC(); out.textContent = !k ? '' : (k.fast ? '快速模式（F/S = 1，DUTY = ' + k.duty + '）' : '标准模式（F/S = 0）') + '：CCR = PCLK1 ÷ (' + k.k + ' × fSCL) = ' + k.ccr + (k.ok ? '' : '，超出范围'); go.disabled = !k || !k.ok; };
      pc.addEventListener('input', showC); scl.addEventListener('input', showC);
      go.addEventListener('click', function () {
        var k = calcC(), p = R.P(r); if (!k || !k.ok) return;
        c.st.v = C.fset(c.st.v, p.byName.CCR, k.ccr); c.st.touched.CCR = true;
        if (p.byName['F/S']) { c.st.v = C.fset(c.st.v, p.byName['F/S'], k.fast ? 1 : 0); c.st.touched['F/S'] = true; }
        c.st.quick = -1; changed(); ui.toast('已写入 CCR');
      });
      showC();
    }
    row.appendChild(go); box.appendChild(row); box.appendChild(out);
  }

  function renderWarn() {
    var box = nodes.warn; ui.clear(box);
    R.warnings(c).forEach(function (w) { var p = el('p', 'banner ' + w[0]); p.appendChild(ui.icon(w[0] === 'warn' ? 'warn' : 'info')); p.appendChild(el('span', null, w[1])); box.appendChild(p); });
  }
  var codeBox = null, halBox = null, wholeBox = null;
  function renderCode() {
    var box = nodes.code;
    if (!codeBox) {
      codeBox = ui.codeBlock('', { title: '寄存器写法', copyLabel: '复制寄存器写法' });
      halBox = ui.codeBlock('', { title: 'HAL 写法', copyLabel: '复制 HAL 写法' });
      wholeBox = el('details', 'whole'); wholeBox.appendChild(el('summary', null, '整体赋值写法'));
      var wc = ui.codeBlock('', { title: '整体赋值', copyLabel: '复制整体赋值写法' }); wholeBox.appendChild(wc); wholeBox._c = wc;
    }
    if (!codeBox.parentNode) { box.appendChild(el('h3', 'sh-h3', '代码')); box.appendChild(codeBox); box.appendChild(halBox); box.appendChild(wholeBox); }
    codeBox.set(R.genCode(c));
    var hal = R.halCode(c);
    halBox.hidden = !hal; if (hal) { halBox.querySelector('.code-t').textContent = 'HAL 写法：' + hal.title; halBox.set(hal.code); }
    var wh = R.wholeCode(c);
    wholeBox.hidden = !wh; if (wh) wholeBox._c.set(wh);
  }
  function renderMeta() {
    var box = nodes.meta, r = c.r; ui.clear(box);
    var pg = R.manualPages(r, c.inst), bits = [];
    if (pg.en != null) bits.push('英文 RM0008 第 ' + pg.en + ' 页');
    if (pg.cn != null) bits.push('中文手册第 ' + pg.cn + ' 页');
    if (!bits.length && pg.pm) bits.push('PM0056 第 ' + pg.pm + ' 节');
    if (bits.length) { var p = el('p', 'sh-pg'); p.appendChild(ui.icon('book')); p.appendChild(el('span', null, '手册：' + bits.join('，') + (pg.adv ? '（高级定时器章节）' : ''))); box.appendChild(p); }
    (Array.isArray(r.cw) ? r.cw : []).forEach(function (w) {
      var pt = w && M.partById[w.part]; if (!pt || !Array.isArray(w.pages)) return;
      var ok = w.pages.filter(function (n) { return n >= 1 && n <= pt.n; }); if (!ok.length) return;
      var row = el('div', 'cwrow'); row.appendChild(el('span', null, '课件' + pt.short));
      ok.forEach(function (n) { var b = ui.btn('pgchip', '第 ' + n + ' 页'); b.addEventListener('click', function () { app.navigate({ cw: pt.id + '-' + n }); }); row.appendChild(b); });
      if (w.more) row.appendChild(el('span', 'muted', '还有 ' + w.more + ' 处'));
      box.appendChild(row);
    });
    var ns = R.notes(r);
    if (ns.length) { var ul = el('ul', 'sh-notes'); ns.forEach(function (n) { ul.appendChild(el('li', null, n)); }); box.appendChild(ul); }
    box.hidden = !box.firstChild;
  }

  STM.regview = {
    init: function (a) { app = a; build(); },
    sync: sync,
    isOpen: function () { return open; }
  };
})();
