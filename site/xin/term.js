/* xin/term.js — 小芯的电脑（终端窗口）
   站长 2026-11-16：「实时展示小芯干活的命令行动画，UI 参考 Claude Code 命令行」；看过第一版后：「终端是我点击小芯聊天里的头像
   弹出来的；搞点像素风，和 Claude Code 差不多，它里面有小螃蟹的图案，我们搞小芯的图案；代码一个字符一个字符敲出来，
   不是一下冒出一大段」。
   这里只管窗口和画法；从哪儿打开、给哪些事件由 chat.js 决定（docs/superpowers/plans/2026-11-16-xin-workbench-round2-b.md）。
   - 样子：外框是首页那套像素风（方角、2px 粗边框、不模糊的硬阴影、点阵字的标题）；里面照站长给的 Claude Code 欢迎页（第三轮）：
     第一行琥珀色的名字、工作目录（天启还写它的模型；小芯的默认界面不露模型），一条点线，一幅像素夜景——点画的灰云、
     一闪一闪的 * 星、一弯像素月牙，小芯站在点线地平线上（Claude Code 那里是小螃蟹 Clawd），再一条点线；
     「> 要求」一行；每一步一个方块圆点，写成「运行(make -j4)」「修改(src/led.c)」，结果缩在折角线下面；
     改动左边是行号、整行红绿底、代码按 Monokai 配色高亮；模型的思考画成暗色的一行；
     最底下转圈的星、在干什么、用了多久。圆点、折角线、星都是画的（字符在 iPhone 上会变成 emoji）。
   - 打字机：所有字（命令、改的代码、输出、说的话）都一个一个敲出来，像在终端里看着它干活；积压多了就打快一点
     （最多落后 1.5 秒），不一下冒出一大段。刚打开时，之前做过的快速重放一遍。系统设了减少动态就直接画出来。
   - 不显示内部命令：xin 后面不是 browser 的（派活、记忆、交付这些）一律不画；xin browser 画成网页。 */
(function () {
  'use strict';
  function h(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function reduce() { return !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches); }
  function dur(ms) { var s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? s + ' 秒' : s < 3600 ? Math.round(s / 60) + ' 分钟' : (s / 3600).toFixed(1).replace(/\.0$/, '') + ' 小时'; }
  function secs(s) { s = Math.max(0, s | 0); return s >= 60 ? Math.floor(s / 60) + ' 分 ' + (s % 60) + ' 秒' : s + ' 秒'; }
  // 去掉 bash 外壳（/bin/bash -lc '…'）和前面的「cd 某处 &&」
  function bare(d) {
    var s = String(d || '').trim(), m = /^\/(?:usr\/)?bin\/(?:ba)?sh -l?c (['"])([\s\S]*)\1$/.exec(s);
    return (m ? m[2] : s).replace(/^\s*(?:cd\s+\S+\s*(?:&&|;)\s*)+/, '');
  }
  function short(p) { var a = String(p || '').split('/').filter(Boolean); return a.length > 2 ? a.slice(-2).join('/') : a.join('/') || String(p || ''); }
  function host(u) { return String(u || '').replace(/^[a-z]+:\/\//i, '').replace(/\/$/, ''); }
  function home(p) { return String(p || '').replace(/^\/data\/workspace(?=\/|$)/, '~/workspace').replace(/^\/data\/home(?=\/|$)/, '~'); }
  var BROWSER = { open: '打开网页', back: '后退', click: '点击', fill: '填写', press: '按键', select: '选择', scroll: '滚动', snapshot: '读取网页', text: '读取正文', screenshot: '截图', tabs: '查看标签页', tab: '切换标签页', close: '关闭浏览器', login: '等待登录' };
  var EDIT = { add: '新建', create: '新建', delete: '删除', update: '修改' };

  // 一个事件 → 一步：{kind, verb, arg, sub}；内部命令返回 null
  function line(ev) {
    var n = String(ev && ev.name || ''), raw = String(ev && ev.detail || ''), d = bare(raw), m;
    if (n === 'Bash') {
      if ((m = /^\s*xin\s+browser\s+([a-z]+)\s*([\s\S]*)$/.exec(d))) return { kind: 'web', verb: BROWSER[m[1]] || '浏览器', arg: m[2].replace(/^['"]|['"]$/g, ''), sub: m[1] };
      if (/^\s*xin(?:\s|$)/.test(d)) return null;
      return { kind: 'cmd', verb: '运行', arg: d };
    }
    if (/^(?:Edit|Write|MultiEdit|NotebookEdit)$/.test(n)) {
      var files = raw.split('\n').filter(Boolean), k0 = (/^(add|create|delete|update)\s/.exec(files[0] || '') || [])[1];
      return { kind: 'edit', verb: EDIT[k0] || '修改', arg: files.map(function (l) { return short(l.replace(/^(?:add|update|delete|create)\s+/, '')); }).join('、'), n: files.length || 1 };
    }
    if (n === 'WebSearch') return { kind: 'search', verb: '搜索', arg: raw };
    if (n === 'WebFetch') return { kind: 'web', verb: '打开网页', arg: raw, sub: 'open' };
    if (n === 'MCP') return { kind: 'tool', verb: '插件', arg: raw };
    if (/[一-龥]/.test(n)) return { kind: 'step', verb: n, arg: raw };   // 控制器自己的步骤：检查网页、生成预览、编译核验
    var p = '';
    try { var o = JSON.parse(raw); p = o && (o.path || o.file_path || o.file || o.url || o.pattern || o.query) || ''; } catch (e) { /* 不是 JSON */ }
    return { kind: 'tool', verb: n || '工具', arg: p ? String(p) : d };
  }
  // 做完那一行（第三轮按 skill 的文案标准改：状态词 + 用时 + 和每一步一致的动词）：已完成 · 用时 2 分钟 · 运行 4 条命令 · 修改 2 个文件；
  // 前台一轮没有状态：用时 18 秒 · 运行 2 条命令
  var LEAD = { done: '已完成', failed: '失败', stopped: '已停止', waiting: '等待确认' };
  function summary(c, state, ms) {
    c = c || {};
    var parts = (state ? [LEAD[state] || '已完成'] : []).concat(ms != null ? ['用时 ' + dur(ms)] : []);
    if (c.cmd) parts.push('运行 ' + c.cmd + ' 条命令');
    if (c.files) parts.push('修改 ' + c.files + ' 个文件');
    if (c.web) parts.push('打开 ' + c.web + ' 个网页');
    if (c.search) parts.push('搜索 ' + c.search + ' 次');
    if (c.tool) parts.push('使用 ' + c.tool + ' 次工具');
    return parts.join(' · ') || '已完成';
  }
  // 数一数做了什么（同一步的开头和结尾只算一次）
  function count(events) {
    var c = { cmd: 0, files: 0, web: 0, search: 0, tool: 0 }, seen = {};
    (events || []).forEach(function (ev) {
      if (ev.t !== 'tool_end' && ev.t !== 'tool') return;
      if (ev.id != null) { if (seen[ev.id]) return; seen[ev.id] = true; }
      var s = line(ev); if (!s) return;
      if (s.kind === 'cmd') c.cmd++; else if (s.kind === 'edit') c.files += s.n; else if (s.kind === 'web' && s.sub === 'open') c.web++; else if (s.kind === 'search') c.search++; else if (s.kind === 'tool') c.tool++;
    });
    return c;
  }

  /* ---------- 小图：转圈的星（Claude Code 的 · ✢ ✳ ✶ ✻ ✽ 来回换）、小芯的像素小人 ---------- */
  function star(len, n, rot) {
    var d = '';
    for (var i = 0; i < n; i++) { var a = (rot + i * 360 / n) * Math.PI / 180; d += 'M0 0L' + (Math.cos(a) * len).toFixed(2) + ' ' + (Math.sin(a) * len).toFixed(2); }
    return d;
  }
  var FR = ['M-.5 0a.5 .5 0 1 0 1 0a.5 .5 0 1 0-1 0', star(2.6, 4, 0), star(4.2, 4, 0) + star(2, 4, 45), star(5, 8, 0), star(6, 8, 22.5), star(6.4, 8, 0) + star(3, 8, 22.5)];
  var SEQ = [0, 1, 2, 3, 4, 5, 4, 3, 2, 1];
  // 小芯的全身像素小人（mascot.js 的 portrait，取景放到整个身子）
  function mascot(face) {
    var x = window.LimingXin, s = x && x.portrait ? x.portrait({ face: face || 'focus', arms: 'out' }) : '';
    return s.replace(/viewBox="[^"]*"/, 'viewBox="0 1 20 19"').replace('xin-portrait', 'xin-portrait tm-mascot-svg');
  }

  /* ---------- 像素夜景（Claude Code 欢迎页那幅：点画的灰云、* 星星、月牙；小螃蟹站在地平线上——这里是小芯）----------
     96×18 格，格子是正方形：云按棋盘格点两种灰（像终端里的 ▓），月牙是一个圆减去往右上偏的圆；位置都是定好的，不随机 */
  var SKY = (function () {
    var W = 96, H = 18, c1 = '', c2 = '', moon = '', px = function (x, y) { return 'M' + x + ' ' + y + 'h1v1h-1z'; };
    [[[3, 12, 18], [4, 9, 22], [5, 7, 25], [6, 10, 23]], [[9, 40, 46], [10, 36, 50], [11, 34, 53], [12, 37, 49]], [[2, 59, 64], [3, 56, 68], [4, 54, 71], [5, 58, 67]]].forEach(function (cl) {
      cl.forEach(function (r) { for (var x = r[1]; x <= r[2]; x++) { if ((x + r[0]) % 2) c2 += px(x, r[0]); else c1 += px(x, r[0]); } });
    });
    for (var y = 0; y < 11; y++) for (var x = 77; x < 93; x++) {
      var a = Math.pow(x + .5 - 85, 2) + Math.pow(y + .5 - 5, 2) <= 16, b = Math.pow(x + .5 - 86.8, 2) + Math.pow(y + .5 - 4, 2) <= 13;
      if (a && !b) moon += px(x, y);
    }
    return { W: W, H: H, c1: c1, c2: c2, moon: moon, stars: [[7, 2.6], [30, 3.4], [47, 2], [73, 10], [93, 13], [21, 12.4], [44, 15.6], [64, 8.2], [57, 13.6]] };
  })();
  function scene(tab) {
    var wrap = h('div', 'tm-scene'), s = SKY;
    wrap.innerHTML = '<svg class="tm-sky xc-px" viewBox="0 0 ' + s.W + ' ' + s.H + '" preserveAspectRatio="xMidYMax meet" shape-rendering="crispEdges" aria-hidden="true">' +
      '<path class="tm-cl1" d="' + s.c1 + '"/><path class="tm-cl2" d="' + s.c2 + '"/><path class="tm-moon" d="' + s.moon + '"/>' +
      s.stars.map(function (p, i) { return '<text class="tm-star" x="' + p[0] + '" y="' + p[1] + '" style="animation-delay:' + (i * .43 % 2.4).toFixed(2) + 's">*</text>'; }).join('') + '</svg>';
    var mk = h('div', 'tm-mk'); mk.innerHTML = tab.mark || mascot(tab.live ? 'focus' : 'smile'); mk.setAttribute('aria-hidden', 'true'); wrap.appendChild(mk);
    return wrap;
  }
  // 改动里的一行代码 → Monokai 配色（关键字粉、字符串黄、数字紫、注释灰、函数绿、类型青）。一行一行地认，不跨行
  var KW = /^(?:if|else|for|while|do|switch|case|default|break|continue|return|goto|struct|union|enum|typedef|static|const|volatile|extern|inline|sizeof|void|char|short|int|long|float|double|signed|unsigned|bool|true|false|NULL|nullptr|function|var|let|new|class|import|from|export|def|self|None|True|False|in|and|or|not|elif|pass|lambda|try|except|finally|raise|with|as|yield|await|async|this|of|typeof)$/;
  var TY = /^(?:u?int(?:8|16|32|64)_t|size_t|uint\d*|[A-Z][A-Za-z0-9]*_TypeDef|string|number|boolean)$/;
  function esc(t) { return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function hlCode(src) {
    var re = /(\/\/.*$|\/\*.*?\*\/|#\s*[A-Za-z_]\w*)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|(\b0[xX][0-9a-fA-F]+[uUlL]*\b|\b\d+(?:\.\d+)?[uUlLfF]*\b)|([A-Za-z_]\w*)(?=\s*\()|([A-Za-z_]\w*)/g;
    var out = '', last = 0, m;
    while ((m = re.exec(src))) {
      out += esc(src.slice(last, m.index)); last = re.lastIndex;
      var k = m[1] ? (m[1][0] === '#' ? 'kw' : 'cm') : m[2] ? 'st' : m[3] ? 'nu' : m[4] ? (KW.test(m[4]) ? 'kw' : 'fn') : KW.test(m[5]) ? 'kw' : TY.test(m[5]) ? 'ty' : '';
      out += k ? '<span class="tm-h' + k + '">' + esc(m[0]) + '</span>' : esc(m[0]);
    }
    return out + esc(src.slice(last));
  }

  /* ---------- 窗口（一个页面一个，点不同的头像换内容）---------- */
  function win(hostEl) {
    if (hostEl._tmWin) return hostEl._tmWin;
    var el = h('div', 'tm-win'); el.hidden = true;
    el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', '小芯的电脑'); el.tabIndex = -1;
    var bar = h('div', 'tm-bar'), face = h('span', 'tm-face'), name = h('span', 'tm-name', '小芯的电脑'), tabsEl = h('div', 'tm-tabs'), x = h('button', 'tm-x');
    face.setAttribute('aria-hidden', 'true');
    tabsEl.setAttribute('role', 'tablist'); tabsEl.setAttribute('aria-label', '任务');
    x.type = 'button'; x.setAttribute('aria-label', '关闭'); x.innerHTML = '<svg viewBox="0 0 7 7" aria-hidden="true" shape-rendering="crispEdges"><path d="M0 0h1v1h-1zM1 1h1v1h-1zM2 2h1v1h-1zM3 3h1v1h-1zM4 4h1v1h-1zM5 5h1v1h-1zM6 6h1v1h-1zM6 0h1v1h-1zM5 1h1v1h-1zM4 2h1v1h-1zM2 4h1v1h-1zM1 5h1v1h-1zM0 6h1v1h-1z"/></svg>';
    bar.appendChild(face); bar.appendChild(name); bar.appendChild(tabsEl); bar.appendChild(x);
    var scr = h('div', 'tm-scr'), st = h('div', 'tm-st');
    st.setAttribute('aria-hidden', 'true');
    st.innerHTML = '<svg class="tm-sp" viewBox="-8 -8 16 16"><path d="' + FR[3] + '"/></svg><span class="tm-sv"></span><span class="tm-ss"></span>';
    var sp = st.firstChild.firstChild, sv = st.childNodes[1], ss = st.childNodes[2];
    el.appendChild(bar); el.appendChild(scr); el.appendChild(st);
    var scrim = h('div', 'tm-scrim'); scrim.hidden = true;
    hostEl.appendChild(scrim); hostEl.appendChild(el);

    var W = { el: el, tabs: [], cur: null, anchor: null, opts: {} };
    var view = null, Q = [], job = null, raf = 0, last = 0, tick = 0, frame = 0, stick = true, boot = 0, bootTm = 0, due = 0;

    /* 打字机：一步一步来；每一步可以先往屏幕上放东西，再交给打字机一个字一个字地敲。
       速度：命令 22 毫秒一个字、代码 10、输出 3、说的话 9。来了新东西就定一个「最晚什么时候敲完」（刚打开重放 1.2 秒、
       之后 1.5 秒），排着的字按剩下的时间匀速敲：积压多了打得快，但还是一个字一个字出来，不会越拖越慢 */
    var BASE = { cmd: 22, code: 10, out: 3, say: 9 };
    function pending() { var n = job ? job.text.length - job.i : 0; Q.forEach(function (s) { n += s.len || 0; }); return n; }
    function pump(now) {
      raf = 0;
      var dt = last ? Math.min(60, now - last) : 16; last = now;
      while (dt > 0) {
        if (!job) {
          if (!Q.length) break;
          var j = Q.shift().run();
          if (j && j.text) { job = j; job.i = 0; job.acc = 0; job.node.textContent = ''; job.node.classList.add('tm-tp'); }
          continue;
        }
        var cps = Math.max(1 / (BASE[job.kind] || 10), pending() / Math.max(80, due - now)), rem = job.text.length - job.i, need = rem / cps;
        if (dt >= need) { job.node.textContent = job.text; finish(job); job = null; dt -= need; continue; }
        job.acc += dt * cps; var n = Math.floor(job.acc); job.acc -= n;
        if (n) { job.i = Math.min(job.text.length, job.i + n); job.node.textContent = job.text.slice(0, job.i); }
        dt = 0;
      }
      if (view && view.replay && !job && !Q.length) view.replay = false;
      follow();
      if (job || Q.length) raf = requestAnimationFrame(pump); else { last = 0; due = 0; }
    }
    function finish(j) { j.node.classList.remove('tm-tp'); if (j.done) j.done(); }
    function go() {
      if (reduce()) { drain(); return; }
      if (raf || bootTm) return;
      var wait = boot - performance.now();   // 刚打开：先停一下，开头那块小芯的欢迎框先让人看见
      if (wait > 0) { bootTm = setTimeout(function () { bootTm = 0; go(); }, wait); return; }
      raf = requestAnimationFrame(pump);
    }
    // 不打字（减少动态、关窗口前）：剩下的一次画完
    function drain() {
      if (job) { job.node.textContent = job.text; finish(job); job = null; }
      while (Q.length) { var j = Q.shift().run(); if (j && j.text) { j.node.textContent = j.text; finish(j); } }
      if (view) view.replay = false;
      follow();
    }
    function step(run, len) {
      Q.push({ run: run, len: len || 0 });
      due = Math.max(due, Math.max(performance.now(), boot) + (view && view.replay ? 1200 : 1500));
      go();
    }
    function follow() { if (stick) scr.scrollTop = scr.scrollHeight; }
    scr.addEventListener('scroll', function () { stick = scr.scrollHeight - scr.scrollTop - scr.clientHeight < 40; });

    /* 一行：方块圆点、动作（加粗）、括号里的参数；后面可以接输出、改动、网页卡片 */
    function row(spec, running) {
      var r = h('div', 'tm-l tm-k-' + spec.kind + (running ? ' tm-run' : '')), m = h('div', 'tm-m'), bl = h('i', 'tm-b');
      if (spec.kind === 'think') bl.innerHTML = '<svg viewBox="-8 -8 16 16" aria-hidden="true"><path d="' + FR[4] + '"/></svg>';
      r.appendChild(bl);
      if (spec.kind === 'say' || spec.kind === 'think') { var t = h('span', 'tm-say'); m.appendChild(t); r.appendChild(m); r._arg = t; return r; }
      m.appendChild(h('b', 'tm-v', spec.verb));
      m.appendChild(document.createTextNode('('));
      var a = h('span', 'tm-a'); m.appendChild(a); m.appendChild(document.createTextNode(')'));
      r.appendChild(m); r._arg = a;
      if (spec.kind === 'web' && spec.sub === 'open') r._web = true;   // 打开网页：做完在折角线下写网页标题（照终端的写法，不画小浏览器）
      return r;
    }
    function out(r) { var o = h('div', 'tm-o'); o.appendChild(h('i', 'tm-cn')); var b = h('div', 'tm-ob'); o.appendChild(b); r.appendChild(o); return b; }
    // 一段输出：最多 8 行（失败的看最后 8 行），多的写「… 还有 N 行」
    function outText(text, ok) {
      var a = String(text || '').replace(/\s+$/, '').split('\n'); if (a.length === 1 && !a[0]) return null;
      var keep = 8, part = ok === false ? a.slice(-keep) : a.slice(0, keep);
      return { text: part.join('\n'), more: a.length > keep ? a.length - keep : 0 };
    }
    // Codex 的改动：「--- 类型 路径」接着差异；新建的文件内容没有 +，当新增画。行号照 @@ -旧起,行数 +新起,行数 @@ 往下数：
    // 删的写旧行号，加的和没动的写新行号（站长给的 Claude Code 图里就是一列行号）
    function diffParse(text) {
      var files = [], cur = null, on = 1, nn = 1;
      String(text || '').replace(/\s+$/, '').split('\n').forEach(function (l) {
        var m = /^--- (add|update|delete|create) (.+)$/.exec(l), hm;
        if (m) { cur = { kind: m[1], path: m[2], lines: [], add: 0, del: 0 }; files.push(cur); on = nn = 1; return; }
        if (!cur) return;
        var k = /^@@/.test(l) ? 'hunk' : /^\+/.test(l) ? 'add' : /^-/.test(l) ? 'del' : cur.kind === 'add' || cur.kind === 'create' ? 'add' : 'ctx';
        if (k === 'hunk') { if ((hm = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(l))) { on = +hm[1]; nn = +hm[2]; } cur.lines.push({ k: k, s: '', n: '' }); return; }
        if (k === 'add') cur.add++; else if (k === 'del') cur.del++;
        cur.lines.push({ k: k, s: k === 'ctx' ? l.replace(/^ /, '') : l.replace(/^[+-]/, ''), n: k === 'del' ? on++ : k === 'add' ? nn++ : (on++, nn++) });
      });
      return files;
    }
    function put(r) { view.log.appendChild(r); follow(); return r; }

    // 一个事件 → 排进打字机的几步
    function feed(ev) {
      if (!view || !ev) return;
      var v = view, spec, r = null;
      function start() { r = put(row(spec, true)); r._spec = spec; if (ev.id != null) v.pend[ev.id] = r; return { node: r._arg, text: spec.kind === 'web' && spec.sub === 'open' ? host(spec.arg) : spec.arg, kind: 'cmd', row: r }; }
      if (ev.t === 'tool') {
        spec = line(ev); if (!spec) { if (ev.id != null) v.skip[ev.id] = true; return; }   // 内部命令：它的结尾也不画
        if (ev.id != null) v.ids[ev.id] = true;
        step(start, spec.arg.length);
        return;
      }
      if (ev.t === 'tool_end') {
        if (ev.id != null && v.skip[ev.id]) return;
        spec = line(ev); if (!spec) return;
        var known = ev.id != null && v.ids[ev.id];
        if (!known) step(start, spec.arg.length);
        if (ev.id != null) v.ids[ev.id] = true;
        var o = spec.kind === 'edit' ? null : outText(ev.out, ev.ok), files = spec.kind === 'edit' ? diffParse(ev.out) : [];
        step(function () {
          if (!r) r = ev.id != null && v.pend[ev.id] || null;
          if (ev.id != null) delete v.pend[ev.id];
          if (!r) return null;
          r.classList.remove('tm-run'); r.classList.add(ev.ok === false ? 'tm-bad' : 'tm-ok');
          if (r._web) { var t = (/(?:^|\n)标题：(.*)/.exec(String(ev.out || '')) || [])[1]; if (!t) return null; r._ob = out(r); var pt = h('pre', 'tm-pre'); r._ob.appendChild(pt); return { node: pt, text: '标题：' + t.trim(), kind: 'say' }; }
          if (spec.kind === 'edit') { if (files.length) r._ob = out(r); return null; }
          if (!o) return null;
          r._ob = out(r); var pre = h('pre', 'tm-pre'); r._ob.appendChild(pre);
          return { node: pre, text: o.text, kind: 'out', row: r, done: function () { if (o.more) r._ob.appendChild(h('span', 'tm-more', '… 还有 ' + o.more + ' 行')); follow(); } };
        }, o ? o.text.length : 0);
        // 改动：先一行「文件 +3 −1」，再一行一行敲出来（每个文件最多 12 行）
        files.forEach(function (f) {
          step(function () { if (!r || !r._ob) return null; r._ob.appendChild(h('div', 'tm-df', short(f.path) + (f.add ? '  +' + f.add : '') + (f.del ? '  −' + f.del : ''))); follow(); return null; });
          f.lines.slice(0, 12).forEach(function (x, xi) {
            if (x.k === 'hunk' && !xi) return;   // 第一段前面不用分隔
            step(function () {
              if (!r || !r._ob) return null;
              if (x.k === 'hunk') { r._ob.appendChild(h('div', 'tm-dl tm-hunk', '⋯')); follow(); return null; }
              var d = h('div', 'tm-dl tm-' + x.k); d.appendChild(h('i', 'tm-n', String(x.n))); d.appendChild(h('i', 'tm-g', x.k === 'add' ? '+' : x.k === 'del' ? '−' : ' ')); var c = h('span', 'tm-c'); d.appendChild(c);
              r._ob.appendChild(d); follow();
              // 敲完这一行再上色（像编辑器里打完字才高亮）
              return { node: c, text: x.s || ' ', kind: 'code', done: function () { c.innerHTML = hlCode(x.s || ' '); } };
            }, x.s.length);
          });
          if (f.lines.length > 12) step(function () { if (r && r._ob) r._ob.appendChild(h('span', 'tm-more', '… 还有 ' + (f.lines.length - 12) + ' 行')); return null; });
        });
        return;
      }
      if (ev.t === 'text' && ev.text) {
        var s = String(ev.text).replace(/[*`#>]/g, '').split('\n').filter(function (y) { return y.trim(); }).join(' ').slice(0, 280);
        if (!s) return;
        step(function () { r = put(row({ kind: 'say' }, false)); r.classList.add('tm-said'); return { node: r._arg, text: s, kind: 'say', row: r }; }, s.length);
        return;
      }
      if (ev.t === 'err' && ev.text) {
        var e = String(ev.text).slice(0, 300);
        step(function () { r = put(row({ kind: 'say' }, false)); r.classList.add('tm-bad'); return { node: r._arg, text: e, kind: 'say', row: r }; }, e.length);
        return;
      }
      if (ev.t === 'think' && ev.text && ev.src !== 'status') {
        var tk = String(ev.text).slice(0, 200);
        step(function () { r = put(row({ kind: 'think' }, false)); return { node: r._arg, text: tk, kind: 'say', row: r }; }, tk.length);
        return;
      }
      if (ev.t === 'mark' && ev.text) step(function () { put(h('div', 'tm-mark', ev.text)); return null; });
      // 兄弟在它干活时补充的话：和开头的要求一样一行「> …」，落在它被送进去的那一步前面（docs/superpowers/specs/2026-11-17-xin-steer-design.md）
      if (ev.t === 'ask' && ev.text) {
        var q = String(ev.text).slice(0, 300);
        step(function () { var p = h('div', 'tm-pr tm-ask'); p.appendChild(h('i', 'tm-pp', '>')); var sp = h('span', ''); p.appendChild(sp); put(p); return { node: sp, text: q, kind: 'say' }; }, q.length);
      }
    }

    /* 一页的内容：欢迎框、「> 要求」、各步、结尾（做完那一行 / 光标）*/
    function paint(tab) {
      Q = []; job = null; if (raf) cancelAnimationFrame(raf); raf = 0; last = 0; due = 0;
      scr.textContent = ''; stick = true;
      var ban = h('div', 'tm-ban'), bt = h('div', 'tm-bt');
      bt.appendChild(h('b', 'tm-bn', tab.who || '小芯'));
      if (tab.model) bt.appendChild(h('span', 'tm-bm', tab.model));
      bt.appendChild(h('span', 'tm-cwd', home(tab.cwd || '/data/workspace')));
      ban.appendChild(bt); ban.appendChild(h('i', 'tm-rule')); ban.appendChild(scene(tab)); ban.appendChild(h('i', 'tm-rule'));
      scr.appendChild(ban);
      if (tab.prompt) { var p = h('div', 'tm-pr'); p.appendChild(h('i', 'tm-pp', '>')); p.appendChild(h('span', '', tab.prompt)); scr.appendChild(p); }
      var log = h('div', 'tm-log'); log.setAttribute('role', 'log'); log.setAttribute('aria-live', 'off'); scr.appendChild(log);
      var end = h('div', 'tm-end'); scr.appendChild(end);
      view = { tab: tab, log: log, end: end, pend: {}, ids: {}, skip: {}, replay: true };
      if (tab.loading) log.appendChild(h('div', 'tm-mark', '正在读取…'));
      (tab.events || []).forEach(feed);
      ending();
      go();
    }
    // 结尾：还在做——最底下那一行在转；做完了——一行「已完成 · …」，然后一个闪着的光标
    function ending() {
      var tab = view.tab;
      st.hidden = !tab.live; el.classList.toggle('tm-live', !!tab.live);
      if (tab.live) { status(); startTick(); return; }
      step(function () {
        if (!view || view.tab !== tab) return null;
        view.end.textContent = '';
        if (!tab.loading && (tab.endState !== undefined || (tab.events || []).length)) {
          var sm = h('div', 'tm-sum');
          sm.appendChild(h('i', 'tm-b ' + (tab.endState === 'failed' ? 'tm-bad' : tab.endState === 'waiting' || tab.endState === 'stopped' ? 'tm-stop' : 'tm-ok')));
          sm.appendChild(h('span', '', summary(count(tab.events), tab.endState || null, tab.endMs)));
          view.end.appendChild(sm);
        }
        var cur = h('div', 'tm-cur'); cur.appendChild(h('i', 'tm-pp', '>')); cur.appendChild(h('i', 'tm-caret'));
        view.end.appendChild(cur); follow();
        return null;
      });
    }
    function status() {
      var tab = view && view.tab; if (!tab || !tab.live || !tab.status) return;
      var s = tab.status() || {};
      if (sv.textContent !== (s.verb || '')) sv.textContent = s.verb || '';
      var t = '(' + (s.sec != null && s.sec >= 1 ? secs(s.sec) + ' · ' : '') + 'Esc 关闭)';
      if (ss.textContent !== t) ss.textContent = t;
    }
    function startTick() {
      if (tick) return;
      tick = setInterval(function () {
        if (el.hidden || !view || !view.tab.live) { clearInterval(tick); tick = 0; return; }
        if (!reduce() && !document.hidden) { frame = (frame + 1) % SEQ.length; sp.setAttribute('d', FR[SEQ[frame]]); }
        status();
      }, 120);
    }

    function tabsPaint() {
      tabsEl.textContent = '';
      tabsEl.hidden = W.tabs.length < 2;
      if (tabsEl.hidden) return;
      W.tabs.forEach(function (t) {
        var b = h('button', 'tm-tab', t.label || t.prompt || '任务'); b.type = 'button'; b.setAttribute('role', 'tab'); b.dataset.k = t.key;
        b.setAttribute('aria-selected', t.key === W.cur ? 'true' : 'false'); b.tabIndex = t.key === W.cur ? 0 : -1;
        if (t.live) b.appendChild(h('i', 'tm-tl'));
        b.addEventListener('click', function () { W.show(t.key); });
        tabsEl.appendChild(b);
      });
    }
    tabsEl.addEventListener('keydown', function (e) {
      var i = -1; W.tabs.forEach(function (t, k) { if (t.key === W.cur) i = k; });
      var d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (!d) return; e.preventDefault();
      var t = W.tabs[(i + d + W.tabs.length) % W.tabs.length]; W.show(t.key);
      var b = tabsEl.querySelector('[data-k="' + t.key + '"]'); if (b) b.focus();
    });

    // 放在头像旁边（手机上从底下升起来）；从头像那一点长出来
    function place() {
      var vw = innerWidth, vh = innerHeight, sheet = vw < 600;
      el.classList.toggle('tm-sheet', sheet); scrim.hidden = !sheet || el.hidden;
      if (sheet) { el.style.left = el.style.top = el.style.width = el.style.height = ''; el.style.transformOrigin = '50% 100%'; return; }
      var w = Math.min(660, vw - 32), hh = Math.min(500, vh - 80), r = W.anchor && W.anchor.isConnected ? W.anchor.getBoundingClientRect() : null;
      var left = r ? Math.max(16, Math.min(vw - w - 16, r.right + 12)) : (vw - w) / 2, top = r ? Math.max(16, Math.min(vh - hh - 16, r.top - 18)) : (vh - hh) / 2;
      el.style.left = left + 'px'; el.style.top = top + 'px'; el.style.width = w + 'px'; el.style.height = hh + 'px';
      el.style.transformOrigin = r ? (r.left + r.width / 2 - left) + 'px ' + (r.top + r.height / 2 - top) + 'px' : '50% 50%';
    }
    function onKey(e) { if (e.key === 'Escape' && !el.hidden) { e.preventDefault(); e.stopPropagation(); W.close(true); } }
    function onDown(e) {
      if (el.hidden || el.contains(e.target)) return;
      if (e.target.closest && e.target.closest('[data-term]')) return;   // 点另一个头像：换内容，不关
      W.close(false);
    }
    x.addEventListener('click', function () { W.close(true); });
    scrim.addEventListener('click', function () { W.close(true); });

    // 收起要等动画走完才藏起来（站长 2026-11-16「不够丝滑」：原来一下就没了）；这期间算已经关了
    var closing = 0;
    function hideNow() {
      clearTimeout(closing); closing = 0;
      el.hidden = true; scrim.hidden = true;
      el.classList.remove('tm-in', 'tm-out'); scrim.classList.remove('tm-in', 'tm-out');
    }
    function enter(e) { e.classList.remove('tm-in', 'tm-out'); void e.offsetWidth; e.classList.add('tm-in'); }
    W.open = function (o) {
      W.opts = o || {}; W.anchor = W.opts.anchor || null; W.tabs = W.opts.tabs || [];
      var key = W.opts.active || (W.tabs[0] && W.tabs[0].key), was = !el.hidden && !closing;
      if (closing) hideNow();   // 正在收起又点开：收完，重新弹出来
      el.hidden = false; place();
      if (!was) {
        boot = performance.now() + 360;
        enter(el); if (!scrim.hidden) enter(scrim);
        document.addEventListener('keydown', onKey, true); document.addEventListener('pointerdown', onDown, true);
        addEventListener('resize', place);
      }
      W.cur = null; W.show(key);
      setTimeout(function () { if (!el.hidden) el.focus({ preventScroll: true }); }, 0);
      return W;
    };
    W.show = function (key) {
      var tab = W.tab(key); if (!tab || W.cur === key && view && view.tab === tab) return;
      W.cur = key; tabsPaint(); paint(tab);
      var x0 = window.LimingXin; face.innerHTML = x0 && x0.portrait ? x0.portrait({ face: tab.live ? 'focus' : 'eyes' }) : '';
      if (W.opts.onTab) W.opts.onTab(key);
    };
    W.tab = function (key) { return W.tabs.filter(function (t) { return t.key === key; })[0] || null; };
    // 开着的时候多了一件活（前台刚派出去）：加一页
    W.add = function (tab) { if (W.tab(tab.key)) return; W.tabs.push(tab); tabsPaint(); };
    W.isOpen = function () { return !el.hidden && !closing; };
    W.active = function () { return W.cur; };
    // 活着的那一页来了新事件：存起来；正看着就交给打字机
    W.push = function (key, ev) {
      var tab = W.tab(key); if (!tab) return;
      (tab.events = tab.events || []).push(ev);
      if (view && view.tab === tab && !el.hidden) feed(ev);
    };
    // 整页换内容（读完了历史）
    W.fill = function (key, events) { var tab = W.tab(key); if (!tab) return; tab.events = events || []; tab.loading = false; if (view && view.tab === tab && !el.hidden) paint(tab); };
    W.end = function (key, state, ms) {
      var tab = W.tab(key); if (!tab || !tab.live) return;
      tab.live = false; tab.endState = state; tab.endMs = ms;
      tabsPaint();
      if (view && view.tab === tab && !el.hidden) ending();
    };
    W.close = function (focusBack) {
      if (el.hidden || closing) return;
      drain(); Q = []; view = null; clearTimeout(bootTm); bootTm = 0;
      document.removeEventListener('keydown', onKey, true); document.removeEventListener('pointerdown', onDown, true);
      removeEventListener('resize', place);
      clearInterval(tick); tick = 0;
      // 手机那一张滑下去、遮罩淡出（0.28 秒），电脑上的缩一点淡出（0.14 秒）；减少动态时直接藏
      if (reduce()) hideNow();
      else {
        el.classList.remove('tm-in'); el.classList.add('tm-out');
        if (!scrim.hidden) { scrim.classList.remove('tm-in'); scrim.classList.add('tm-out'); }
        closing = setTimeout(hideNow, el.classList.contains('tm-sheet') ? 300 : 160);
      }
      if (W.opts.onClose) W.opts.onClose();
      if (focusBack && W.anchor && W.anchor.isConnected) W.anchor.focus({ preventScroll: true });
    };
    hostEl._tmWin = W;
    return W;
  }

  window.LimingXinTerm = { line: line, summary: summary, count: count, dur: dur, bare: bare, win: win, mascot: mascot };
})();
