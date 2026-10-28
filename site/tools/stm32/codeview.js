/* codeview.js — 外设页「代码」里的寄存器代码：完整文件（寄存器）和一步步推出来的代码（代码推导）
   数据在 codederive.js / codederive-more.js。注释在代码上一行，点一行展开「为什么这样写」。 */
/* ---------- 代码推导：按通用写法一步步推出 .h / .c / main.c ---------- */
(function () {
  'use strict';
  var STM = window.STM, ui = STM.ui, el = ui.el, DATA = window.STM32_CODEDERIVE || { METHOD: [], CD: {} };
  function indentOf(c) { return (/^\s*/.exec(c) || [''])[0]; }
  function lineRow(l) {
    var row = el('div', 'rc-l' + (l.why ? ' has' : '')), b = el(l.why ? 'button' : 'div', 'rc-lb');
    if (l.why) { b.type = 'button'; b.setAttribute('aria-expanded', 'false'); }
    b.style.setProperty('--i', indentOf(l.c).length);
    if (l.cm) { var cm = el('span', 'rc-cm'); cm.textContent = indentOf(l.c) + '// ' + l.cm; b.appendChild(cm); }
    var code = el('code', 'rc-c'); if (l.c) code.appendChild(ui.hlC(l.c)); else code.textContent = ' '; b.appendChild(code);
    row.appendChild(b);
    if (l.why) {
      var why = el('div', 'rc-why'); why.hidden = true;
      why.appendChild(el('b', 'rc-why-h', '原因'));
      var t = el('div', 'rc-why-t'); t.appendChild(el('p', null, l.why)); why.appendChild(t);
      row.appendChild(why);
      b.addEventListener('click', function () { var on = why.hidden; why.hidden = !on; row.classList.toggle('open', on); b.setAttribute('aria-expanded', on ? 'true' : 'false'); });
    }
    return row;
  }
  function norm(x) { return { c: x[0], cm: x[1] || '', why: x[2] || '', s: x[3] }; }
  function fileText(f) {
    var out = [];
    f.lines.forEach(function (x) { var l = norm(x); if (l.cm) out.push(indentOf(l.c) + '// ' + l.cm); out.push(l.c); });
    return out.join('\n').replace(/\n+$/, '') + '\n';
  }
  function codeBox(name, rows, copy) {
    var fig = el('figure', 'code rc-code cd-file'), h = el('figcaption', 'code-h');
    h.appendChild(el('span', 'code-t mono', name));
    if (copy) h.appendChild(ui.copyBtn('复制 ' + name, copy));
    fig.appendChild(h);
    var body = el('div', 'rc-fn'); rows.forEach(function (r) { body.appendChild(r); }); fig.appendChild(body);
    return fig;
  }
  // 某一步在各个文件里的那几行；不连续的地方用「…」隔开。mk(l, key) 决定每一行怎么画（看推导 / 自己写）
  function stepFiles(cd, sid, mk) {
    var out = [];
    cd.files.forEach(function (f) {
      var rows = [], last = -2;
      f.lines.forEach(function (x, i) {
        var l = norm(x); if (l.s !== sid) return;
        if (!l.c && (last !== i - 1)) return;          // 开头的空行不要
        if (last >= 0 && last !== i - 1) rows.push(el('div', 'cd-gap', '…'));
        rows.push(mk(l, f.name + ':' + i)); last = i;
      });
      while (rows.length && rows[rows.length - 1].querySelector('.rc-c') && !rows[rows.length - 1].querySelector('.rc-c').textContent.trim()) rows.pop();
      if (rows.length) out.push(codeBox(f.name, rows));
    });
    return out;
  }

  /* ---------- 「自己写」：挡住代码行，看着注释自己写，写对了才露出来 ---------- */
  var MODE_KEY = 'lm.stm32.cdmode', SELF_KEY = 'lm.stm32.cdself';
  function loadSelf() { try { return JSON.parse(ui.lsGet(SELF_KEY)) || {}; } catch (e) { return {}; } }
  function saveSelf(o) { ui.lsSet(SELF_KEY, JSON.stringify(o)); }
  // 提示：只给到第一个运算符 / 括号为止，后面的自己写
  function hintOf(c) { var t = c.trim(), d = /^#define\s+\w+\s/.exec(t); if (d) return d[0].replace(/\s+$/, ' '); var m = /^.*?(\|=|&=|[^=!<>]=(?!=)|\()/.exec(t); return m ? m[0].replace(/\s*$/, ' ').replace(/\( $/, '(') : t.split(/\s+/)[0] + ' '; }
  function selfRow(l, key, done) {
    var ind = indentOf(l.c), row = el('div', 'rc-l cd-blank'), b = el('div', 'rc-lb');
    b.style.setProperty('--i', ind.length);
    if (l.cm) { var cm = el('span', 'rc-cm'); cm.textContent = ind + '// ' + l.cm; b.appendChild(cm); }
    var box = el('div', 'cd-in'); box.style.setProperty('--i', ind.length);
    var inp = el('input', 'cd-inp'); inp.type = 'text'; inp.placeholder = '写这一行';
    ['autocomplete', 'autocorrect', 'autocapitalize'].forEach(function (k) { inp.setAttribute(k, 'off'); });
    inp.spellcheck = false; inp.setAttribute('enterkeyhint', 'done'); inp.setAttribute('aria-label', '写出这一行' + (l.cm ? '：' + l.cm : ''));
    var chk = ui.btn('cd-ib cd-chk', '检查'), hint = ui.btn('cd-ib', '提示'), ans = ui.btn('cd-ib', '答案');
    var msg = el('span', 'cd-msg'); msg.setAttribute('role', 'status');
    box.appendChild(inp); box.appendChild(chk); box.appendChild(hint); box.appendChild(ans); box.appendChild(msg);
    b.appendChild(box); row.appendChild(b);
    function finish(how, viaKey) {
      var r = lineRow(l); r.classList.add(how === 1 ? 'cd-ok' : 'cd-shown');
      row.parentNode.replaceChild(r, row);
      done(key, how, r, viaKey);
    }
    function check(viaKey) {
      if (!inp.value.trim()) { inp.focus(); return; }
      if (DATA.same(l.c, inp.value)) { finish(1, viaKey); return; }
      row.classList.remove('cd-bad'); void row.offsetWidth; row.classList.add('cd-bad');
      msg.textContent = '不对，再想想';
    }
    chk.addEventListener('click', function () { check(false); });
    inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); check(true); } });
    inp.addEventListener('input', function () { msg.textContent = ''; row.classList.remove('cd-bad'); });
    inp.addEventListener('focus', function () {   // 只有正在写的那一行露出按钮
      Array.prototype.forEach.call(document.querySelectorAll('.cd-blank.act'), function (r) { if (r !== row) r.classList.remove('act'); });
      row.classList.add('act');
    });
    hint.addEventListener('click', function () { var h = hintOf(l.c); if (inp.value.indexOf(h.trim()) !== 0) inp.value = h; inp.focus(); try { inp.setSelectionRange(inp.value.length, inp.value.length); } catch (e) {} });
    ans.addEventListener('click', function () { finish(2, false); });
    return row;
  }

  // 外设页「代码推导」：按通用写法一步步推出各个文件；上面可以切「看推导 / 自己写」
  function render(root, tid) {
    var cd = DATA.CD[tid]; if (!cd) return;
    var task = el('div', 'dv-task'); task.appendChild(ui.icon('flag'));
    var tt = el('div'); tt.appendChild(el('span', 'dv-task-l', cd.title + '：' + cd.files.map(function (f) { return f.name; }).join(' / ')));
    tt.appendChild(el('b', null, cd.goal)); task.appendChild(tt); root.appendChild(task);
    var how = el('section', 'cd-method'); how.appendChild(el('h3', 'cd-mh', '通用写法'));
    var ol = el('ol', 'cd-flow'); DATA.METHOD.forEach(function (m) { ol.appendChild(el('li', null, m)); }); how.appendChild(ol);
    root.appendChild(how);

    var total = 0;
    cd.files.forEach(function (f) { f.lines.forEach(function (x) { if (DATA.blankable(x[0])) total++; }); });
    var mode = ui.lsGet(MODE_KEY) === 'self' ? 'self' : 'read';
    var bar = el('div', 'cd-modebar'), sw = el('div', 'cd-modes'); sw.setAttribute('role', 'radiogroup'); sw.setAttribute('aria-label', '学法');
    [['read', '看推导'], ['self', '自己写']].forEach(function (x) {
      var b = ui.btn('cd-mb', x[1]); b.dataset.k = x[0]; b.setAttribute('role', 'radio');
      b.addEventListener('click', function () { if (mode === x[0]) return; mode = x[0]; ui.lsSet(MODE_KEY, mode); draw(); });
      sw.appendChild(b);
    });
    var prog = el('span', 'cd-prog'), reset = ui.btn('cd-ib cd-reset', '重来');
    reset.addEventListener('click', function () { var o = loadSelf(); delete o[tid]; saveSelf(o); draw(); });
    bar.appendChild(sw); bar.appendChild(prog); bar.appendChild(reset); root.appendChild(bar);
    var body = el('div', 'cd-steps'); root.appendChild(body);

    function count() { var st = loadSelf()[tid] || {}, n = 0; Object.keys(st).forEach(function (k) { if (st[k]) n++; }); return n; }
    function syncBar() {
      Array.prototype.forEach.call(sw.children, function (b) { var on = b.dataset.k === mode; b.classList.toggle('on', on); b.setAttribute('aria-checked', on ? 'true' : 'false'); });
      var n = count(); prog.hidden = reset.hidden = mode !== 'self'; prog.textContent = n + ' / ' + total; reset.disabled = !n;
      root.classList.toggle('cd-self', mode === 'self');
    }
    function done(key, how, rowEl, viaKey) {
      var o = loadSelf(); o[tid] = o[tid] || {}; o[tid][key] = how; saveSelf(o); syncBar();
      if (viaKey) {   // 回车写对了：跳到下一行接着写
        var all = Array.prototype.slice.call(body.querySelectorAll('.cd-inp')), next = null;
        for (var i = 0; i < all.length; i++) if (rowEl.compareDocumentPosition(all[i]) & Node.DOCUMENT_POSITION_FOLLOWING) { next = all[i]; break; }
        if (next) next.focus();
      }
    }
    function draw() {
      ui.clear(body);
      var st = loadSelf()[tid] || {};
      var mk = mode === 'self' ? function (l, key) { if (!DATA.blankable(l.c) || st[key]) { var r = lineRow(l); if (st[key]) r.classList.add(st[key] === 1 ? 'cd-ok' : 'cd-shown'); return r; } return selfRow(l, key, done); } : function (l) { return lineRow(l); };
      cd.steps.forEach(function (stp, i) {
        var sec = el('section', 'cd-step'); sec.id = 'cd-' + stp.id;
        var h = el('h3', 'cd-q'); h.appendChild(el('span', 'cd-n', String(i + 1))); h.appendChild(el('span', null, stp.q)); sec.appendChild(h);
        stp.say.forEach(function (p) { sec.appendChild(el('p', 'cd-p', p)); });
        stepFiles(cd, stp.id, mk).forEach(function (f) { sec.appendChild(f); });
        if (stp.extra) sec.appendChild(codeBox(stp.extra.name, stp.extra.lines.map(function (x) { return lineRow(norm(x)); })));
        body.appendChild(sec);
      });
      syncBar();
    }
    draw();
  }
  // 外设页「寄存器」：完整的 .h / .c / main.c，上面一排文件名切换
  function files(tid, opt) {
    var cd = DATA.CD[tid]; if (!cd) return null; opt = opt || {};
    var fig = el('figure', 'code rc-code cd-file cd-files'), h = el('figcaption', 'code-h');
    var tabs = el('div', 'ftabs'); tabs.setAttribute('role', 'tablist'); h.appendChild(tabs);
    var cur = 0, bodies = [];
    h.appendChild(ui.copyBtn('复制当前文件', function () { return fileText(cd.files[cur]); }));
    fig.appendChild(h);
    cd.files.forEach(function (f, i) {
      var b = ui.btn('ftab', f.name); b.setAttribute('role', 'tab'); tabs.appendChild(b);
      var body = el('div', 'rc-fn');
      f.lines.forEach(function (x) { var l = norm(x); l.why = ''; body.appendChild(lineRow(l)); });
      bodies.push(body); fig.appendChild(body);
      b.addEventListener('click', function () { cur = i; sync(); });
    });
    function sync() {
      bodies.forEach(function (x, j) { x.hidden = j !== cur; });
      Array.prototype.forEach.call(tabs.children, function (y, j) { y.classList.toggle('on', j === cur); y.setAttribute('aria-selected', j === cur ? 'true' : 'false'); });
    }
    fig.pick = function (name) { var i = cd.files.map(function (f) { return f.name; }).indexOf(name); if (i >= 0 && i !== cur) { cur = i; sync(); } };
    if (opt.file) fig.pick(opt.file);
    sync();
    return fig;
  }
  // 一个外设可以有好几个驱动：CD[外设 id] 是主的，CD[别的 id].topic = 外设 id 的是另外几个（比如硬件 I2C）
  function variants(tid) {
    var out = DATA.CD[tid] && !DATA.CD[tid].topic ? [tid] : [];
    Object.keys(DATA.CD).forEach(function (k) { if (DATA.CD[k].topic === tid) out.push(k); });
    return out;
  }
  STM.codederive = { has: function (tid) { return variants(tid).length > 0; }, variants: variants, title: function (id) { return DATA.CD[id] ? DATA.CD[id].title : ''; }, tag: function (id) { var cd = DATA.CD[id]; return cd ? cd.tag || cd.title : ''; },
    forBoard: function (mid) {   // 驱动这个板载模块的代码：[{ id, topic, file, title }]
      return Object.keys(DATA.CD).filter(function (k) { return (DATA.CD[k].boards || []).indexOf(mid) >= 0; }).map(function (k) {
        var cd = DATA.CD[k], f = cd.files.filter(function (x) { return x.name === cd.module + '.c'; })[0] || cd.files[1] || cd.files[0];
        return { id: k, topic: cd.topic || k, file: f.name, title: cd.title };
      });
    },
    topicOf: function (id) { return DATA.CD[id] ? DATA.CD[id].topic || id : null; }, render: render, files: files, fileText: fileText, data: DATA };
})();
