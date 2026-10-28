/* codeview.js — 寄存器版代码的显示：注释在上一行，点一行展开「为什么这样写」和它来自推导里的哪一步
   数据在 regcode.js；推导章的程序直接取 STM32_DERIVE[章].fns 里的代码和理由。
   用在两处：外设页「代码」一栏（寄存器写法）、Code 每章的「完整代码」页（v=think&t=gpio&s=code）。 */
(function () {
  'use strict';
  var STM = window.STM, ui = STM.ui, el = ui.el;
  var RC = window.STM32_REGCODE || { CM: {}, PROGS: {} };

  // 统一成 { title, plan, chapter, fns: [{ sig, pre: [{c, cm}], lines: [{c, cm, why, from}] }] }
  function normalize(tid, p) {
    var D = window.STM32_DERIVE || {}, ch = p.chapter && D[p.chapter], CM = RC.CM[p.chapter] || {};
    var fns = (p.fns || []).map(function (f) {
      if (typeof f === 'string') {
        var src = ch && ch.fns[f]; if (!src) return null;
        var cm = CM[f] || [];
        return {
          name: f, sig: src.sig,
          pre: (src.pre || []).map(function (x, i) { return { c: typeof x === 'string' ? x : x.c, cm: (CM._pre || [])[i] || '', why: typeof x === 'string' ? '' : x.why || '' }; }),
          lines: src.lines.map(function (l, i) { return { c: l.c, cm: cm[i] || '', why: l.why || '', from: l.from || [] }; })
        };
      }
      return { sig: f.sig, pre: [], lines: f.lines.map(function (l) { return { c: l[0], cm: l[1] || '', why: l[2] || '' }; }) };
    }).filter(Boolean);
    return { id: p.id, title: p.title, plan: p.plan || [], chapter: ch ? p.chapter : null, ch: ch, fns: fns, topic: tid };
  }
  function progsOf(tid) { return (RC.PROGS[tid] || []).map(function (p) { return normalize(tid, p); }); }
  function progsOfChapter(cid) {
    var out = [];
    Object.keys(RC.PROGS).forEach(function (tid) { RC.PROGS[tid].forEach(function (p) { if (p.chapter === cid) out.push(normalize(tid, p)); }); });
    return out;
  }

  // 程序的纯文本（复制用）：注释写在代码上一行
  function indentOf(c) { return (/^\s*/.exec(c) || [''])[0]; }
  function textOf(prog) {
    var out = ['/* ' + prog.title + ' */', ''];
    prog.fns.forEach(function (f) {
      f.pre.forEach(function (x) { if (x.cm) out.push('// ' + x.cm); out.push(x.c); });
      if (f.pre.length) out.push('');
      var body = f.sig !== '#define';
      if (body) { out.push(f.sig); out.push('{'); }
      f.lines.forEach(function (l) {
        var ind = (body ? '    ' : '') + indentOf(l.c);
        if (l.cm) out.push(ind + '// ' + l.cm);
        out.push((body ? '    ' : '') + l.c);
      });
      if (body) out.push('}');
      out.push('');
    });
    return out.join('\n').replace(/\n+$/, '\n');
  }

  // 理由里的标记：**粗体**、`代码`、[[s3]] 推导第几环、{F2} 主干结论
  function rich(text, prog, app) {
    var box = el('div', 'rc-why-t'), ch = prog.ch, S = {};
    if (ch) ch.steps.forEach(function (s, i) { S[s.id] = i; });
    String(text || '').split(/\n\n+/).forEach(function (para) {
      var p = el('p'), re = /\*\*([^*]+)\*\*|`([^`]+)`|\[\[(s\d+)\]\]|\{(F\d+)\}/g, last = 0, m;
      while ((m = re.exec(para))) {
        if (m.index > last) p.appendChild(document.createTextNode(para.slice(last, m.index)));
        if (m[1]) p.appendChild(el('b', null, m[1]));
        else if (m[2]) p.appendChild(el('code', null, m[2]));
        else if (m[3]) { if (ch && S[m[3]] != null) { var a = app.link({ v: 'think', t: ch.id, s: m[3] }, 'rc-sl'); a.textContent = '问题 ' + (S[m[3]] + 1); p.appendChild(a); } }
        else if (m[4]) p.appendChild(el('b', null, ch && ch.facts[m[4]] ? '「' + ch.facts[m[4]].t + '」' : m[4]));
        last = re.lastIndex;
      }
      if (last < para.length) p.appendChild(document.createTextNode(para.slice(last)));
      box.appendChild(p);
    });
    return box;
  }
  // 这一行是从推导的哪一步、哪条结论来的
  function fromList(l, prog, app) {
    var ch = prog.ch; if (!ch || !l.from || !l.from.length) return null;
    var S = {}; ch.steps.forEach(function (s, i) { S[s.id] = [i, s]; });
    var ul = el('ul', 'rc-from');
    l.from.forEach(function (f) {
      var li = el('li');
      if (ch.facts[f]) {
        var src = S[ch.facts[f].from]; li.appendChild(el('span', 'rc-fk', '结论'));
        var a = app.link({ v: 'think', t: ch.id, s: ch.facts[f].from }, 'rc-sl'); a.textContent = ch.facts[f].t; li.appendChild(a);
        if (src) li.appendChild(el('span', 'rc-fs', '问题 ' + (src[0] + 1)));
      } else if (S[f]) {
        li.appendChild(el('span', 'rc-fk', '问题 ' + (S[f][0] + 1)));
        var b = app.link({ v: 'think', t: ch.id, s: f }, 'rc-sl'); b.textContent = S[f][1].q; li.appendChild(b);
      } else return;
      ul.appendChild(li);
    });
    return ul.firstChild ? ul : null;
  }

  function lineEl(l, prog, app, indent) {
    var row = el('div', 'rc-l' + (l.why ? ' has' : '')), ind = indent + indentOf(l.c);
    var b = el(l.why ? 'button' : 'div', 'rc-lb'); if (l.why) { b.type = 'button'; b.setAttribute('aria-expanded', 'false'); }
    if (l.cm) { var cm = el('span', 'rc-cm'); cm.textContent = ind + '// ' + l.cm; b.appendChild(cm); }
    var code = el('code', 'rc-c'); code.appendChild(document.createTextNode(indent)); code.appendChild(ui.hlC(l.c)); b.appendChild(code);
    row.appendChild(b);
    if (l.why) {
      var why = el('div', 'rc-why'); why.hidden = true;
      why.appendChild(el('b', 'rc-why-h', '为什么这样写'));
      why.appendChild(rich(l.why, prog, app));
      var fl = fromList(l, prog, app);
      if (fl) { why.appendChild(el('b', 'rc-why-h', '怎么想到的：推导里的这一步')); why.appendChild(fl); }
      row.appendChild(why);
      b.addEventListener('click', function () { var on = why.hidden; why.hidden = !on; row.classList.toggle('open', on); b.setAttribute('aria-expanded', on ? 'true' : 'false'); });
    }
    return row;
  }

  /* render(prog, app, opt) → 元素；opt.compact：外设页里用，标题小一号 */
  function render(prog, app, opt) {
    opt = opt || {};
    var box = el('section', 'rc' + (opt.compact ? ' compact' : ''));
    var hh = el('div', 'rc-h'); hh.appendChild(el(opt.compact ? 'h3' : 'h2', null, prog.title));
    var tools = el('div', 'rc-tools');
    var all = ui.btn('pill', '全部展开'); all.addEventListener('click', function () {
      var rows = box.querySelectorAll('.rc-l.has'), open = all.textContent === '全部展开';
      Array.prototype.forEach.call(rows, function (r) { r.classList.toggle('open', open); r.querySelector('.rc-why').hidden = !open; r.querySelector('.rc-lb').setAttribute('aria-expanded', open ? 'true' : 'false'); });
      all.textContent = open ? '全部收起' : '全部展开';
    });
    tools.appendChild(all);
    tools.appendChild(ui.copyBtn('复制「' + prog.title + '」', function () { return textOf(prog); }));
    hh.appendChild(tools); box.appendChild(hh);
    if (prog.plan.length) {
      var pl = el('div', 'rc-plan'); pl.appendChild(el('b', null, '动笔前先想清楚'));
      var ol = el('ol'); prog.plan.forEach(function (x) { ol.appendChild(el('li', null, x)); }); pl.appendChild(ol);
      box.appendChild(pl);
    }
    var fig = el('figure', 'code rc-code');
    prog.fns.forEach(function (f) {
      var fb = el('div', 'rc-fn');
      f.pre.forEach(function (x) { fb.appendChild(lineEl(x, prog, app, '')); });
      var body = f.sig !== '#define';
      if (body) { var sg = el('div', 'rc-sig'); sg.appendChild(ui.hlC(f.sig)); fb.appendChild(sg); fb.appendChild(el('div', 'rc-sig', '{')); }
      f.lines.forEach(function (l) { fb.appendChild(lineEl(l, prog, app, body ? '    ' : '')); });
      if (body) fb.appendChild(el('div', 'rc-sig', '}'));
      fig.appendChild(fb);
    });
    box.appendChild(fig);
    box.appendChild(el('p', 'rc-tip', '点任意一行，看为什么这样写。'));
    return box;
  }

  STM.regcode = { progsOf: progsOf, progsOfChapter: progsOfChapter, render: render, textOf: textOf };
})();
