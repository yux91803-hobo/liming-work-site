/* xin/chat.js — 小芯聊天：和 InstaBox 云电脑里的 AI（Claude Code / Codex）聊天、让它干活
   入口：小芯背包里的「聊天」（首页和 STM32 学习台里的小芯都有）：小芯旁边冒一个输入框（打字或语音），回复出现在小芯头上的气泡里，
   点气泡或输入框上的「展开」才打开这个面板看全文和历史。地址后面加 #xin 直接打开面板。没登录时先在面板里输密码。
   接口见 src/xin.js；AI 每一步（说话、执行命令、xin 动作）都整理成事件，这里一边轮询一边画出来，同时让小芯跟着动：
   AI 在思考 → 小芯坐在电脑前挠头；在执行命令 → 敲代码；xin 命令 → 照做；做完 → 开心，失败 → 难过。
   侧边栏：新对话、主对话（一直聊下去的那一个，所有设备共用）、每日任务、别的对话（能改名、归档、删除）、设置。
   记忆、好感度由小芯自己打理，界面上没有入口；它电脑里的文件从聊天里的路径和附件点开（能预览、下载）；它在做的事看聊天里的任务卡片和输入框上面那一条。
   回答里出现的 /data/workspace/… 路径点一下就打开那个文件。
   聊天区像聊天软件：小芯在左边（像素头像）、你在右边；它在电脑上执行的命令不显示，干活时只冒一个「正在输入」的气泡和用时；代码上色。
   标题栏的「屏幕」：全屏看小芯的电脑桌面（桌面上有个终端实时滚动它在干什么），能「观看」也能「接管」。
   设置（对话列表最下面）：附带正在看的页面、做完提醒（Web Push：网页没在看时做完了发通知，
   推送从小芯的电脑直接发出，见 vm-agent.mjs 的 pushAll；通知由 /sw.js 弹出，点了打开 #xin=<对话>）。
   小芯会自己编新动作（xin move add），打开网页时拿过来教给页面上的小芯（背包「新动作」、闲着时偶尔做）；
   好感度记在它电脑上，只影响页面上的小芯有多听话，不显示。 */
(function () {
  'use strict';
  var TQ = !!(window.LIMING_CHAT && window.LIMING_CHAT.role === 'tianqi');
  var API = TQ ? '/api/tq/' : '/api/xin/', LS_PFX = TQ ? 'lm.tq.' : 'lm.xin.';
  var LS_SID = LS_PFX + 'sid', LS_MAIN = LS_PFX + 'main', LS_DRAFT = LS_PFX + 'draft', LS_EFF = LS_PFX + 'effort', LS_CTX = LS_PFX + 'ctx', LS_HM = LS_PFX + 'hmodel';
  var AGENTS = { harness: 'Harness', codex: 'Codex', claude: 'Claude' };
  // Codex（默认模式）的几个模型：小芯每一轮自己挑（见 vm-agent.mjs 的路由器），这里只用来显示名字
  var CX_MODELS = { 'glm-5.3-flash': 'GLM-5.3 Flash', 'glm-5.3': 'GLM-5.3', 'kimi-k3.1-pro': 'Kimi K3.1 Pro', 'deepseek-v4.1-flash': 'DeepSeek V4.1 Flash' };
  var HM_MODELS = { 'deepseek-v4.1-flash': 'DeepSeek V4.1 Flash', 'glm-5.3': 'GLM-5.3', 'glm-5.3-flash': 'GLM-5.3 Flash' };
  var touch = window.matchMedia && matchMedia('(pointer: coarse)').matches;
  var WORK = '/data/workspace';

  function ls(k, v) { try { if (v === undefined) return localStorage.getItem(k); if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { return null; } }
  // 现在看得见的那个小芯：打开了 STM32 学习台、小芯又被扔进去了，就是学习台里的那个
  function xin() {
    if (TQ) return null;
    if (document.body.classList.contains('tool-open')) {
      var fs = document.querySelectorAll('iframe');
      for (var i = 0; i < fs.length; i++) {
        try { var X = fs[i].contentWindow && fs[i].contentWindow.LimingXin; if (X && X.mode !== 'away') return X; } catch (e) { /* 别的源 */ }
      }
    }
    return window.LimingXin || null;
  }
  function h(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function sleepMs(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // 新对话的执行器由入口决定。打开已有对话时仍使用它自己的执行器。
  function hmPref() { var m = ls(LS_HM); return HM_MODELS[m] ? m : 'deepseek-v4.1-flash'; }
  function agentPref() { return TQ ? 'harness' : 'codex'; }
  function modelName(id) { return CX_MODELS[id] || HM_MODELS[id] || id || ''; }
  function deviceId(){var id=ls('lm.xin.device');if(!id||!/^[A-Za-z0-9_-]{8,80}$/.test(id)){id=crypto.randomUUID();ls('lm.xin.device',id);}return id;}
  var S = { deviceId:deviceId(), tabId:crypto.randomUUID(), enabled: false, authed: false, tqNoGw: false, open: false, sid: ls(LS_SID) || '', moves: [], bond: null, agent: agentPref(), sessAgent: '', effort: ls(LS_EFF) || 'high', hModel: hmPref(), lastModel: '',
    run: '', off: 0, polling: false, mine: {}, errRuns: {}, lastAct: 0, view: 'chat', machine: '', mstate: '', loadSeq: 0, convSeq: 0, drawer: false, drawerSeq: 0 };
  // 主对话：一直聊下去的那一个（默认模式，所有设备共用，编号由小芯的电脑记着，这里存一份好直接打开）。
  // 没在看别的对话时就落在它上面：S.sid 空着、S.toMain 为真，发出去的第一句带 main，云电脑认得是哪一个。「新对话」才另开一个。
  S.main = TQ ? '' : ls(LS_MAIN) || ''; S.toMain = !TQ && !S.sid;
  S.runEv = {}; S.runMeta = {}; S.tf = {};   // 小芯的电脑（终端窗口）：每一轮做的事、那一轮你说的话、后台的活读到哪
  function mainDraft() { return !TQ && !S.sid && S.toMain && S.agent === 'codex'; }
  function setMain(sid) { if (TQ) return; sid = sid && /^s[0-9a-z]{6,24}$/.test(sid) ? sid : ''; if (sid !== S.main) { S.main = sid; ls(LS_MAIN, sid || null); } }

  /* ---------- 和页面上的小芯共用机身、眼睛和引脚，避免头像仍然显示旧方眼 ---------- */
  function avatar(cls) {
    var e = h('span', 'xc-av' + (cls ? ' ' + cls : '')), x = xin();
    if (x && x.portrait) e.innerHTML = x.portrait();
    return e;
  }
  /* 天启的标志（站长 2026-11-16：天启「属于另一种 agent 形式」）：深蓝底上一颗像素的四角星，冷色星光，旁边几粒星点一闪一闪；
     不跟着小芯换表情（不是 .xc-face）。天启的东西才用这套冷色，小芯的琥珀色不混用 */
  var TQ_STAR = (function () {
    var rows = ['......#......', '......#......', '.....###.....', '.....###.....', '....#####....', '..#########..', '#############', '..#########..', '....#####....', '.....###.....', '.....###.....', '......#......', '......#......'], d = '';
    rows.forEach(function (r, y) { for (var x = 0; x < r.length; x++) if (r[x] === '#') d += 'M' + x + ' ' + y + 'h1v1h-1z'; });
    return d;
  })();
  function tqMark(cls) {
    var e = h('span', 'xc-tq' + (cls ? ' ' + cls : ''));
    e.innerHTML = '<svg class="xc-px" viewBox="-2.5 -2.5 18 18" aria-hidden="true" shape-rendering="crispEdges"><path class="tq-s" d="' + TQ_STAR + '"/>' +
      '<path class="tq-c" d="M6 4h1v5H6zM4 6h5v1H4z"/><path class="tq-g" d="M0 0h1v1H0zM11 1h1v1h-1zM12 11h1v1h-1zM-1 11h1v1h-1z"/></svg>';
    return e;
  }
  function tqConv() { return TQ || curAgent() === 'harness'; }

  /* ---------- 请求 ---------- */
  // ms：这次请求的期限。连接被静默丢掉（手机休眠、换 Wi-Fi、宿主机暂停虚拟机）时 fetch 永远不结束也不报错，
  // 轮询停在半路、S.run / S.sending 永远清不掉；到期就 abort，按 state:'timeout' 失败，交给调用方重试。
  // 测试可用 window.LimingXinChatTimeoutMs 把期限调短（只会更短）。
  function reqMs(ms) { var o = +(window.LimingXinChatTimeoutMs || 0); return o > 0 ? Math.min(o, ms) : ms; }
  function req(path, body, ms) {
    var opt = body === undefined ? { credentials: 'same-origin' } : { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Xin': '1' }, body: JSON.stringify(body) };
    var ctl = ms && typeof AbortController === 'function' ? new AbortController() : null, tm = 0, late = false;
    if (ctl) { opt.signal = ctl.signal; tm = setTimeout(function () { late = true; ctl.abort(); }, reqMs(ms)); }
    return fetch(API + path, opt).then(function (r) {
      return r.json().catch(function (e) { if (late) throw e; return {}; }).then(function (d) { d = d || {}; d._status = r.status; return d; });
    }).then(function (d) { clearTimeout(tm); return d; }, function (e) {
      clearTimeout(tm);
      if (late) { e = new Error('连接超时'); e.state = 'timeout'; }
      else if (e && typeof e === 'object' && !e.state) e.state = 'network';   // fetch 的 TypeError：断网 / 连接被重置
      throw e;
    });
  }
  // 调云电脑：正在唤醒 / InstaBox 忙就等一会儿再试（最多 maxWait 毫秒），状态写在面板上
  function call(op, args, maxWait, onWait, current) {
    if(op==='task_tell'||op==='task_stop'){args=args||{};if(!args.clientId)args.clientId=crypto.randomUUID();}
    var t0 = Date.now(), ms = op === 'poll' ? 25000 : op === 'wake' || op === 'greet' ? 120000 : 60000;   // Worker → exec 最长 40 秒；poll 在服务器上是立即返回的
    function once() {
      return req('call', { op: op, args: args || {} }, ms).then(function (d) {
        if (d._status === 401) { S.authed = false; S.tqNoGw = false; syncBag(); render(); throw new Error('要先登录'); }
        if (d._status !== 200) throw new Error(d.msg || d.error || ('出错了（' + d._status + '）'));
        if (d.ok) { if (op !== 'status' && (!current || current())) setStatus(''); return d.data; }
        // 发消息：Cloudflare 已经存好了这句（待送达），只是还没送进云电脑——不再重发，交给 waitDelivery 看进度
        if (d.accepted && d.delivery) { if (!current || current()) setStatus(''); return { _accepted: true, delivery: d.delivery, state: d.state, retryAfter: d.retryAfter, msg: d.msg }; }
        if ((d.state === 'waking' || d.state === 'busy') && Date.now() - t0 < (maxWait || 0)) {
          if (!current || current()) { if (onWait) onWait(d); else setStatus(d.msg || '唤醒中…', 'wait'); }
          var x = xin(); if (x && op === 'send' && (!current || current())) x.ai('think');
          return sleepMs((d.retryAfter || 3) * 1000).then(once);
        }
        var err = new Error(d.state === 'cooldown' ? '云电脑连续跑满了时长，在冷却，大约 ' + Math.ceil((d.retryAfter || 60) / 60) + ' 分钟后再试' : (d.msg || '云电脑出错了'));
        err.state = d.state; err.retryAfter = d.retryAfter; err.resend = !!d.resend;
        throw err;
      }, function (e) {
        // 超时 / 断网：带 clientId 的操作（send、task_tell…）云电脑按 clientId 去重，原样重发同一份 args 不会多发一遍
        if ((e.state === 'timeout' || e.state === 'network') && args && args.clientId && Date.now() - t0 < (maxWait || 0)) {
          if (!current || current()) setStatus('网络不稳，正在重发…', 'wait');
          return sleepMs(1500).then(once);
        }
        throw e;
      });
    }
    return once();
  }

  /* ---------- 面板 ----------
     标题栏正中是「小芯岛」：小芯的像素脸、它现在在干什么、在做几件、几件等你。点一下从药丸里长出一块面板（.xc-work）：
     它的电脑、额度、进行中 / 待处理 / 成果；全屏工作台里能「钉住」成右边一栏。 */
  var root, list, statusEl, input, sendBtn, titleEl, sessEl, loginEl, foot, drawerEl, useEl, sheetEl, menuEl, fileEl, attsEl, pickEl, mdlBtn;
  var isleEl, workEl, jumpEl, palEl, toastEl, gwWarnEl;
  var HI = {
    menu: '<path d="M4.5 7.5h15M4.5 12h15M4.5 16.5h9"/>',
    plus: '<path d="M12 5.5v13M5.5 12h13"/>',
    grow: '<path d="M14.5 4.5h5v5M19.5 4.5l-6 6M9.5 19.5h-5v-5M4.5 19.5l6-6"/>',
    shrink: '<path d="M4.5 14.5h5v5M9.5 14.5l-5 5M19.5 9.5h-5v-5M14.5 9.5l5-5"/>',
    x: '<path d="m6.5 6.5 11 11M17.5 6.5l-11 11"/>',
    pin: '<path d="M9.5 4.5h5l-.8 5.2 3.3 3.3H7l3.3-3.3zM12 13v6.5"/>',
    down: '<path d="M12 5.5v12M6.5 12l5.5 5.5 5.5-5.5"/>',
    send: '<path d="M12 18.5V6M6.5 11.5 12 6l5.5 5.5"/>',
    clip: '<path d="M15.5 7.5 9 14a2 2 0 0 0 2.8 2.8l7-7a4 4 0 0 0-5.6-5.6l-7 7a6 6 0 0 0 8.5 8.5l6-6"/>',
    plug: '<path d="M9 3.5v4M15 3.5v4M7 7.5h10v3.5a5 5 0 0 1-10 0zM12 16v4.5"/>'
  };
  function hi(k) { return '<svg viewBox="0 0 24 24" aria-hidden="true">' + HI[k] + '</svg>'; }
  function build() {
    root = h('section', 'xc' + (TQ ? ' tq-mode' : '')); root.id = 'xinChat'; root.setAttribute('role', 'dialog'); root.setAttribute('aria-label', TQ ? '和天启聊天' : '和小芯聊天'); root.hidden = true;
    if (TQ) {
      root.appendChild(document.getElementById('tianqi-workbench').content.cloneNode(true));
      root.querySelector('.tq-brand-mark').appendChild(tqMark());
      root.querySelector('.xc-x').innerHTML = hi('x');
      root.querySelector('.xc-jump').insertAdjacentHTML('afterbegin', hi('down'));
      root.querySelector('.xc-mi-file').insertAdjacentHTML('afterbegin', hi('clip'));
      root.querySelector('textarea').setAttribute('enterkeyhint', touch ? 'enter' : 'send');
    } else root.innerHTML =
      '<header class="xc-hd">' +
        '<div class="xc-hd-l"><button class="xc-ib xc-list-b" type="button" aria-label="对话列表">' + hi('menu') + '</button>' +
        '<div class="xc-conv"><b class="xc-conv-t"></b></div></div>' +
        '<button class="xc-isle" type="button" aria-haspopup="dialog" aria-controls="xin-tray" aria-expanded="false">' +
            '<span class="xc-face" aria-hidden="true"></span>' +
            '<span class="xc-ttl"><b>小芯</b><span class="xc-sw-w"><span class="xc-sub"></span></span></span>' +
            '<span class="xc-isle-n" aria-hidden="true"></span>' +
          '</button>' +
        '<div class="xc-hd-r">' +
          '<button class="xc-ib xc-new-b" type="button" aria-label="新对话" title="新对话">' + hi('plus') + '</button>' +
          ('<button class="xc-ib xc-wb-b" type="button" aria-label="工作台" title="工作台"><span class="xc-wb-in">' + hi('grow') + '</span><span class="xc-wb-out">' + hi('shrink') + '</span></button>') +
          '<button class="xc-ib xc-x" type="button" aria-label="关闭" title="关闭">' + hi('x') + '</button>' +
        '</div>' +
      '</header>' +
      '<div class="xc-st" role="status" aria-live="polite" hidden></div>' +
      '<div class="xc-body"><div class="xc-up-w"><button type="button" class="xc-upchip" hidden></button></div><div class="xc-msgs" aria-live="polite"></div>' +
        '<div class="xc-jump-w"><button type="button" class="xc-jump" hidden>' + hi('down') + '<span>回到底部</span></button></div></div>' +
      '<div class="xc-sess" hidden></div>' +
      '<div class="xc-scrim" aria-hidden="true"></div>' +
      // 侧边栏：小芯、搜索、新对话、主对话、每日任务、对话列表、设置。宽屏全屏时常驻左边，别的时候从左边滑出来
      '<aside class="xc-drawer" aria-label="对话列表"><div class="xc-dr"></div></aside>' +
      // 小芯岛展开的面板：它的电脑、额度、进行中 / 待处理 / 成果
      ('<aside class="xc-work" id="xin-tray" role="dialog" aria-label="小芯在做的事">' +
        '<div class="xc-wk-hd"><span class="xc-wk-id"><span class="xc-face" aria-hidden="true"></span><span class="xc-wk-t"><b>小芯</b><span class="xc-wk-st"></span></span><span class="xc-wk-n" aria-hidden="true"></span></span>' +
          '<button class="xc-ib xc-wk-pin" type="button" aria-pressed="false" aria-label="钉在右边" title="钉在右边">' + hi('pin') + '</button>' +
          '<button class="xc-ib xc-wk-x" type="button" aria-label="收起" title="收起">' + hi('x') + '</button></div>' +
        '<div class="xc-wk-sc"><div class="xt-top"></div><div class="xt-tasks"></div></div>' +
      '</aside>') +
      '<form class="xc-login" hidden>' +
        '<span class="xc-login-av" aria-hidden="true"></span>' +
        '<b class="xc-login-t">登录</b>' +
        '<input type="password" name="pw" autocomplete="current-password" placeholder="密码" aria-label="密码" required>' +
        '<button type="submit" class="xc-btn">登录</button>' +
        '<p class="xc-err" role="alert"></p>' +
      '</form>' +
      // 详情、用量、插件：电脑上是右边一栏（聊天照样能用），手机上从底下升起来
      '<section class="xc-sheet" aria-label="详情" hidden></section>' +
      '<form class="xc-ft">' +
        // 「＋」点开的小菜单：发图片或文件、开关插件
        '<div class="xc-menu" role="menu" hidden>' +
          '<button type="button" class="xc-mi xc-mi-file" role="menuitem">' + hi('clip') + '<b>图片或文件</b></button>' +
          ('<button type="button" class="xc-mi xc-mi-plug" role="menuitem">' + hi('plug') + '<b>插件</b></button>') +
        '</div>' +
        // 模型、思考强度（新对话还能选 AI）：输入框底下那颗按钮点开
        '<div class="xc-pick" id="xin-model-picker" role="dialog" aria-label="模型和思考强度" hidden></div>' +
        '<input type="file" class="xc-file" multiple hidden>' +
        '<div class="xc-atts" hidden></div>' +
        ('<div class="xc-ctx" hidden>' + hi('clip') + '<span></span><button type="button" aria-label="这次不带">' + hi('x') + '</button></div>') +
        '<div class="xc-row">' +
          '<button type="button" class="xc-plus" aria-label="发图片、文件或开关插件" aria-haspopup="menu" aria-expanded="false">' + hi('plus') + '</button>' +
          '<textarea rows="1" placeholder="给小芯发消息" aria-label="消息" enterkeyhint="' + (touch ? 'enter' : 'send') + '"></textarea>' +
          '<button type="button" class="xc-mdl" aria-haspopup="dialog" aria-controls="xin-model-picker" aria-expanded="false"><span></span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5"/></svg></button>' +
          '<button type="submit" class="xc-send" aria-label="发送">' + hi('send') + '</button>' +
        '</div>' +
        // 这个对话的用量：上下文、消耗的 token、缓存命中率（点一下看明细）
        '<div class="xc-use" hidden></div>' +
      '</form>' +
      '<div class="xc-pal" role="dialog" aria-label="搜索和命令" hidden></div>' +
      '<div class="xc-toast" role="status" aria-live="polite"></div>';
    document.body.appendChild(root);
    list = root.querySelector('.xc-msgs'); new MutationObserver(syncGrp).observe(list, { childList: true }); statusEl = root.querySelector('.xc-st'); input = root.querySelector('textarea');
    sendBtn = root.querySelector('.xc-send'); titleEl = root.querySelector('.xc-sub');
    isleEl = root.querySelector('.xc-isle'); workEl = root.querySelector('.xc-work'); jumpEl = root.querySelector('.xc-jump');
    palEl = root.querySelector('.xc-pal'); toastEl = root.querySelector('.xc-toast'); gwWarnEl = root.querySelector('.xc-gw-warn');
    sessEl = root.querySelector('.xc-sess'); loginEl = root.querySelector('.xc-login'); foot = root.querySelector('.xc-ft'); drawerEl = root.querySelector('.xc-dr');
    if (TQ) { var lav = loginEl.querySelector('.xc-login-av'); if (lav) lav.appendChild(tqMark('big')); }
    useEl = root.querySelector('.xc-use');
    // 点小芯的头像：弹出「小芯的电脑」（终端窗口，term.js），看它那一次在电脑上做了什么
    list.addEventListener('click', function (e) { var a = e.target.closest && e.target.closest('[data-term]'); if (a && list.contains(a)) openTerm(a.dataset.term, a); });
    list.addEventListener('keydown', function (e) { var a = e.target; if ((e.key === 'Enter' || e.key === ' ') && a && a.dataset && a.dataset.term) { e.preventDefault(); openTerm(a.dataset.term, a); } });
    sheetEl = root.querySelector('.xc-sheet'); menuEl = root.querySelector('.xc-menu'); fileEl = root.querySelector('.xc-file'); attsEl = root.querySelector('.xc-atts');
    pickEl = root.querySelector('.xc-pick'); mdlBtn = root.querySelector('.xc-mdl');
    root.querySelector('.xc-plus').addEventListener('click', function () { setPick(false); setMenu(menuEl.hidden); });
    mdlBtn.addEventListener('click', function () { setMenu(false); setPick(pickEl.hidden); });
    pickEl.addEventListener('focusout', function (e) { if (e.relatedTarget && !pickEl.contains(e.relatedTarget) && e.relatedTarget !== mdlBtn) setPick(false); });
    window.addEventListener('resize', fitPick);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', fitPick);
    root.querySelector('.xc-mi-file').addEventListener('click', function () { setMenu(false); fileEl.value = ''; fileEl.click(); });
    var plugB = root.querySelector('.xc-mi-plug'); if (plugB) plugB.addEventListener('click', function () { setMenu(false); openPlugins(); });
    if (TQ) root.querySelector('.tq-plug-b').addEventListener('click', function () {
      if (this.getAttribute('aria-expanded') === 'true') setSheet(false);
      else { setMenu(false); setPick(false); openPlugins(); }
    });
    fileEl.addEventListener('change', function () { addFiles(fileEl.files); fileEl.value = ''; });
    // 粘贴图片、把文件拖进面板：也当附件；拖着的时候整块聊天亮一圈
    root.addEventListener('dragover', function (e) { if (e.dataTransfer && [].indexOf.call(e.dataTransfer.types || [], 'Files') >= 0 && S.view === 'chat' && S.authed) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; root.classList.add('drop'); } });
    root.addEventListener('dragleave', function (e) { if (!e.relatedTarget || !root.contains(e.relatedTarget)) root.classList.remove('drop'); });
    root.addEventListener('drop', function (e) { root.classList.remove('drop'); if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length && S.view === 'chat' && S.authed) { e.preventDefault(); addFiles(e.dataTransfer.files); } });
    document.addEventListener('pointerdown', function (e) {
      if (menuEl && !menuEl.hidden && !e.target.closest('.xc-menu, .xc-plus')) setMenu(false);
      if (pickEl && !pickEl.hidden && !e.target.closest('.xc-pick, .xc-mdl')) setPick(false);
      if (!TQ && S.tray && !e.target.closest('.xc-work, .xc-isle, .xc-sheet, .xs, .xq-wrap')) setTray(false);
    }, true);
    useEl.addEventListener('click', function () { S.useMore = !S.useMore; renderUsage(); });
    root.querySelector('.xc-scrim').addEventListener('click', function () { if (S.sheet) setSheet(false); else setDrawer(false); });
    root.querySelector('.xc-list-b').setAttribute('aria-expanded', 'false');
    root.querySelector('.xc-x').addEventListener('click', close);
    root.querySelector('.xc-new-b').addEventListener('click', function () { newChat(); if (!touch) input.focus(); });
    var wbB = root.querySelector('.xc-wb-b'); if (wbB) wbB.addEventListener('click', function () { if (S.wb) unwork(); else work(); });
    if (!TQ) isleEl.addEventListener('click', function () { if (trayDocked()) { workEl.querySelector('.xc-wk-sc').scrollTo({ top: 0, behavior: 'smooth' }); flash(workEl); return; } setTray(!S.tray); });
    var wkX = root.querySelector('.xc-wk-x'); if (wkX) wkX.addEventListener('click', function () { if (trayDocked()) setPin(false); else setTray(false, true); });
    var wkPin = root.querySelector('.xc-wk-pin'); if (wkPin) wkPin.addEventListener('click', function () { setPin(!S.pin); });
    window.addEventListener('resize', layout);
    window.addEventListener('resize', function () { if (S.tray) placeTray(); });
    root.querySelector('.xc-list-b').addEventListener('click', function () { setDrawer(!S.drawer); });
    loginEl.addEventListener('submit', function (e) { e.preventDefault(); login(loginEl.pw.value); });
    // 输密码时小芯闭上眼睛，不偷看
    loginEl.pw.addEventListener('focus', paintFaces); loginEl.pw.addEventListener('blur', paintFaces); loginEl.pw.addEventListener('input', paintFaces);
    // 小芯还在回上一句：输入框里有话就排队（回完一起发），没话按钮就是「停止」
    foot.addEventListener('submit', function (e) { e.preventDefault(); if (S.run || S.sending) { if (hasDraft()) queueMsg(); else if (S.run) stop(); } else send(); });
    input.value = ls(LS_DRAFT) || '';
    input.addEventListener('input', function () { grow(); ls(LS_DRAFT, input.value || null); renderSendBtn(); paintFaces(); });
    root.querySelector('.xc-row').addEventListener('click', function (e) { if (e.target === this) input.focus(); });
    input.addEventListener('focus', function () { setPick(false); refreshCtx(); paintFaces(); });
    input.addEventListener('blur', paintFaces);
    input.addEventListener('paste', function (e) {
      var fs = e.clipboardData && e.clipboardData.files;
      if (fs && fs.length) { e.preventDefault(); addFiles(fs); }
    });
    var ctxX = root.querySelector('.xc-ctx button'); if (ctxX) ctxX.addEventListener('click', function () { skipCtx(); refreshCtx(); input.focus(); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229 && !touch) { e.preventDefault(); if (S.run || S.sending) queueMsg(); else send(); }
    });
    root.addEventListener('keydown', function (e) {
      if ((e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey) && !e.altKey && S.authed) { e.preventDefault(); if (palEl.classList.contains('in')) closePal(); else openPal(); return; }
      if (e.key !== 'Escape' || e.isComposing || (scrEl && !scrEl.hidden)) return;
      // 收掉一层就说一声（preventDefault），外壳就不会顺带把下面的工具也关了
      e.preventDefault();
      if (palEl.classList.contains('in')) { closePal(); return; }
      if (menuEl && !menuEl.hidden) { setMenu(false); return; }
      if (pickEl && !pickEl.hidden) { e.preventDefault(); e.stopPropagation(); setPick(false, true); return; }
      if (S.sheet) setSheet(false); else if (!TQ && S.tray) setTray(false, true); else if (S.drawer && !root.classList.contains('wb-side')) setDrawer(false); else close();
    });
    list.addEventListener('click', function (e) {
      var fp = e.target.closest('.xc-path'); if (fp) { e.preventDefault(); loadFiles(fp.getAttribute('data-path'), 'chat'); return; }
      var c = e.target.closest('.xc-copy');
      if (c) { var code = c.closest('.xc-code').querySelector('code'); copy(code ? code.textContent : '', c); return; }
      var w = e.target.closest('.xc-wrap');
      if (w) { var cb = w.closest('.xc-code'), on = !cb.classList.contains('wrap'); cb.classList.toggle('wrap', on); w.setAttribute('aria-pressed', on ? 'true' : 'false'); return; }
      var more = e.target.closest('.xc-code-more');
      if (more) { var box = more.closest('.xc-code'); box.classList.remove('fold'); more.remove(); return; }
      var mc = e.target.closest('.xc-mcopy');
      // 「复制」在这一轮最后一条下面，复制这一轮小芯说的全部原文（Markdown）
      if (mc) {
        var parts = [], g0 = grpOf(mc.closest('.xc-m'));
        for (var m = mc.closest('.xc-m'); m; m = m.previousElementSibling) {
          if (m === typingEl) continue;
          if (m.classList.contains('xc-ai') && grpOf(m) !== g0) break;   // 只复制这一条（同一分组：派活那句、结果）
          if (m.classList.contains('xc-ai') && !m.classList.contains('bad')) parts.unshift(m._md || (m.querySelector('.xc-bub') || {}).innerText || '');
          if (!m.classList.contains('cont')) break;
        }
        copy(parts.filter(Boolean).join('\n\n'), mc);
      }
    });
    root.querySelector('.xc-body').addEventListener('scroll', jumpCheck, { passive: true });
    jumpEl.addEventListener('click', function () { toBottom(true, true); });
    upEl = root.querySelector('.xc-upchip'); upEl.addEventListener('click', upGo);
    S.pin = !TQ && ls(LS_PFX + 'trayPin') === '1';
  }
  function grow() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 168) + 'px'; }
  function copy(text, btn) {
    var lab = btn && btn.lastChild;
    var ok = function () {
      if (!btn) return;
      btn.classList.add('done'); if (lab) lab.textContent = '已复制';
      clearTimeout(btn._t); btn._t = setTimeout(function () { btn.classList.remove('done'); if (lab) lab.textContent = '复制'; }, 1400);
    };
    var old = function () {
      var t = document.createElement('textarea'); t.value = text; t.setAttribute('readonly', ''); t.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
      document.body.appendChild(t); t.select(); var done = false;
      try { done = document.execCommand('copy'); } catch (e) { done = false; }
      t.remove(); if (done) ok(); else toast('没复制成：浏览器不让读写剪贴板');
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(ok, old); else old();
  }
  /* ---------- 小芯的脸：跟着状态换表情 ----------
     想事情抬眼、在电脑上忙侧身、等你打字时低头看你写的、做完笑、出错难过、电脑睡着闭眼、输密码时闭眼不偷看。
     只在表情换了的时候重画（像素 SVG），眨眼、左右看用 CSS 逐帧动画 */
  S.mood = ''; S.moodAt = 0;
  function faceKey() {
    if (S.mood && Date.now() - S.moodAt < 3500) return S.mood;
    if (S.enabled && !S.authed) return document.activeElement === (loginEl && loginEl.pw) ? 'shut' : 'idle';
    if (S.run) return S.doing === 'work' ? 'work' : 'think';
    if (S.sending) return /waking|cooldown/.test(S.waitSend || '') ? 'sleepy' : 'think';
    if (input && document.activeElement === input && input.value.trim()) return 'read';
    if ((S.tactive || []).some(tLive)) return 'busy';
    if (S.mstate === 'suspended' || S.mstate === 'stopped') return 'sleep';
    return 'idle';
  }
  var FACES = {
    idle: { face: 'eyes' }, read: { face: 'eyes', ly: 1 }, think: { face: 'eyes', ly: -1 }, work: { face: 'side' }, busy: { face: 'focus' },
    sleepy: { face: 'blink' }, sleep: { face: 'shut' }, shut: { face: 'shut' }, happy: { face: 'hap' }, sad: { face: 'sad' }
  };
  function faceSvg(k) { var x = xin(); return x && x.portrait ? x.portrait(FACES[k] || FACES.idle) : ''; }
  function paintFace(el, k) {
    if (!el || el.dataset.k === k) return;
    el.dataset.k = k; el.innerHTML = faceSvg(k);
    el.className = el.className.replace(/\s*f-\w+/g, '') + ' f-' + k;
  }
  function setMood(k) { S.mood = k; S.moodAt = Date.now(); paintFaces(); setTimeout(paintFaces, 3600); }
  function paintFaces() {
    if (TQ || !root) return;
    var k = faceKey();
    [].forEach.call(root.querySelectorAll('.xc-face'), function (el) { paintFace(el, k); });
    var lf = root.querySelector('.xc-login-av'); if (lf) paintFace(lf, faceKey());
    var tfc = typingEl && typingEl.querySelector('.xc-face'); if (tfc) paintFace(tfc, k === 'read' ? 'think' : k);
  }
  // 标题栏「小芯」下面那行：在忙就说在干什么，闲着就说电脑醒没醒
  function statusText() {
    var t = '', cls = '';
    if (S.sending) { t = sendingText(true) + '…'; cls = 'busy'; }   // 标题栏地方小：冷却只说「冷却中」，几点送到写在对话里那一行
    else if (S.run) { t = (S.doing === 'work' && S.act ? '执行中' : '思考中') + '…'; cls = 'busy'; }
    else if (S.mstate === 'running') { t = '在线'; cls = 'on'; }
    else if (S.mstate === 'suspended') t = '唤醒中…';
    else if (S.mstate === 'stopped') t = '开机中…';
    else if (S.mstate) t = S.mstate;
    return { t: t, cls: cls };
  }
  function convTitle() { return !TQ && (S.sid && S.sid === S.main || mainDraft()) ? '主对话' : S.title || (S.sid ? '对话' : '新对话'); }
  function renderHead() {
    if (!titleEl) return;
    var st = statusText(), t = st.t, cls = st.cls;
    swapText(titleEl, t); titleEl.className = 'xc-sub' + (cls ? ' ' + cls : '') + (titleEl.classList.contains('xc-sw-in') ? ' xc-sw-in' : '');
    // 左栏常驻时，标题栏左边写正在看的是哪个对话
    root.querySelector('.xc-conv-t').textContent = convTitle();
    var ds = drawerEl && drawerEl.querySelector('.xc-dr-st'); if (ds) { ds.textContent = t; ds.className = 'xc-dr-st' + (cls ? ' ' + cls : ''); }
    var ws = workEl && workEl.querySelector('.xc-wk-st'); if (ws) { ws.textContent = t; ws.className = 'xc-wk-st' + (cls ? ' ' + cls : ''); }
    renderIsle();
    if (S.tray || trayDocked()) renderTray();
    paintFaces();
  }
  // 小芯岛右边：在做几件（眼光色）、几件等你（待处理色）；读屏念完整的一句
  function renderIsle() {
    if (!isleEl) return;
    var act = S.tactive || [], n = act.filter(tLive).length, w = act.filter(function (t) { return t.status === 'waiting'; }).length;
    var box = isleEl.querySelector('.xc-isle-n'), sig = n + ':' + w, wn = workEl && workEl.querySelector('.xc-wk-n');
    if (box.dataset.sig !== sig) {
      var fill = function (b) { b.textContent = ''; if (w) b.appendChild(h('i', 'w', String(w))); if (n) b.appendChild(h('i', 'r', String(n))); };
      var first = box.dataset.sig == null;
      box.dataset.sig = sig;
      if (first || S.tray) { fill(box); } else flipWidth(isleEl, function () { fill(box); });
      if (wn) fill(wn);
    }
    isleEl.classList.toggle('live', !!n); isleEl.classList.toggle('wait', !!w);
    isleEl.classList.toggle('busy', !!(S.run || S.sending));
    var st = statusText().t;
    isleEl.setAttribute('aria-label', (TQ ? '天启' : '小芯') + (st ? '，' + st.replace(/…$/, '') : '') + (TQ ? '' : (n ? '，' + n + ' 个任务进行中' : '') + (w ? '，' + w + ' 个待处理' : '') + '。点开看它在做的事'));
  }
  function render() {
    if (!root) return;
    var login = S.enabled && !S.authed, off = !S.enabled, gwOff = !!(TQ && S.enabled && S.authed && S.tqNoGw), ph = tqConv() ? '给天启发消息' : '给小芯发消息';
    if (input.placeholder !== ph) input.placeholder = ph;   // 天启的对话（和选了天启的空白页）
    if (gwWarnEl) gwWarnEl.hidden = !gwOff;
    input.disabled = gwOff;
    loginEl.hidden = !login;
    foot.hidden = login || off || S.view !== 'chat';
    sessEl.hidden = login || off || S.view === 'chat';
    root.querySelector('.xc-body').hidden = login || S.view !== 'chat';
    if (TQ) root.querySelector('.tq-desk').hidden = login || S.view !== 'chat';
    root.querySelector('.xc-list-b').hidden = root.querySelector('.xc-new-b').hidden = login || off;
    if (TQ) {
      root.querySelector('.tq-plug-b').hidden = login || off;
      if ((login || off) && S.sheet) setSheet(false);
    }
    if (!TQ) isleEl.disabled = login || off;
    if ((login || off) && S.drawer) setDrawer(false);
    if ((login || off) && S.tray) setTray(false);
    root.classList.toggle('running', !!S.run);
    root.classList.toggle('locked', login || off);
    renderPick();
    renderSendBtn();
    if (off) { list.innerHTML = ''; list.appendChild(h('p', 'xc-hint', TQ ? '天启还没配好（网站没配密码或 InstaBox key）。' : '小芯聊天还没开（网站没配密码或 InstaBox key）。')); }
    renderHead();
  }
  // 发送键：小芯在回上一句时，输入框空着是「停止」，有话是「排队发送」
  function hasDraft() { return !!(input && input.value.trim()) || (S.atts || []).some(function (a) { return a.state === 'ok'; }); }
  function renderSendBtn() {
    if (!sendBtn) return;
    var q = !!(S.run || S.sending) && hasDraft(), stopMode = !!S.run && !q, gwOff = !!(TQ && S.enabled && S.authed && S.tqNoGw);
    sendBtn.setAttribute('aria-label', stopMode ? '停止' : q ? '排队发送' : '发送');
    sendBtn.disabled = gwOff || !!S.loadingConversation || !stopMode && attsBusy();
    sendBtn.classList.toggle('q', q);
    sendBtn.classList.toggle('ready', !gwOff && (hasDraft() || stopMode));
    var want = stopMode ? 'stop' : 'send';
    if (sendBtn.dataset.k !== want) {
      sendBtn.dataset.k = want;
      sendBtn.innerHTML = stopMode ? '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7.5" y="7.5" width="9" height="9" rx="1.5" class="fill"/></svg>' : hi('send');
    }
  }
  function setStatus(text, kind) {
    if (!statusEl) return;
    statusEl.hidden = !text; statusEl.textContent = text || ''; statusEl.className = 'xc-st' + (kind ? ' ' + kind : '');
  }

  /* ---------- 打开 / 关上 ---------- */
  function open() {
    if (!root) build();
    S.open = true; root.hidden = false; S.view = 'chat'; setDrawer(false);
    // 直接打开工作台链接时首页先藏着：等工作台淡入完（.22s 透明度、.32s 上移）再放开，不然淡入那一下首页会透出来
    requestAnimationFrame(function () { root.classList.add('show'); setTimeout(function () { document.documentElement.classList.remove('xc-boot-work'); }, 400); });
    document.body.classList.add('xc-open');
    var x = xin(); if (x && x.home && window.innerWidth < 900) x.home();
    render(); grow(); refreshCtx();
    if (!S.enabled) return;
    if (!S.authed) { if (!touch) loginEl.pw.focus(); return; }
    var p = !S.loadingConversation && (S.histFor !== (S.sid || '') || !list.childNodes.length) ? loadCurrent() : null;
    if (!TQ && S.bg > 0) pollTasksSoon(300);
    if (!TQ && S.wb) pollWork();
    if (!touch) input.focus();
    return p;
  }
  function close() {
    if (TQ) {
      if (window.parent && window.parent !== window) { try { window.parent.postMessage({ type: 'close' }, location.origin); } catch (e) {} }
      else location.href = '/';
      return;
    }
    if (!root) return;
    S.open = false; root.classList.remove('show'); document.body.classList.remove('xc-open');
    if (S.tray) setTray(false); closePal();
    setTimeout(function () { if (!S.open) { root.hidden = true; if (S.wb) unwork(true); } }, 240);
    if (XIN_HASH.test(location.hash) || location.hash === '#xin-work') history.replaceState(null, '', location.pathname + location.search);
    renderHome(); nextWork();
  }

  /* ---------- 登录 ---------- */
  function pingTianqi() {
    if (!TQ || !S.enabled || !S.authed) return;
    call('ping', {}, 60000).then(function (d) { S.tqNoGw = !!(d && d.ready === false); render(); }, function () {});
  }
  function login(pw) {
    var err = loginEl.querySelector('.xc-err'); err.textContent = '';
    req('login', { password: pw }).then(function (d) {
      if (d._status === 200) {
        if (TQ) { S.authed = true; S.tqNoGw = false; loginEl.pw.value = ''; render(); loadCurrent(); wakeVm(); loadDeliveries(); pingTianqi(); if (S.wb) layout(); return; }
        S.authed = true; syncPushDevice(); loginEl.pw.value = ''; syncBag(); render(); setMood('happy'); loadCurrent(); wakeVm(); greet(); loadDeliveries(); pollWork(); renderHome(); if (S.wb) layout(); var x = xin(); if (x) { x.cmd('happy'); x.say('你来啦！'); } return;
      }
      err.textContent = d.msg || (d._status === 429 ? '试太多次了，过一分钟再试' : '登录失败');
      loginEl.classList.remove('no'); void loginEl.offsetWidth; loginEl.classList.add('no'); setMood('sad');
    }, function () { err.textContent = '网络不通'; });
  }
  function logout() {
    req('logout', {}).then(function () { S.authed = false; S.tqNoGw = false; syncBag(); render(); renderHome(); });
  }
  function syncBag() {
    if (TQ) return;
    // 功能开着就放进背包：点了小芯旁边冒输入框（没登录先开面板输密码）。学习台里的小芯在 mascot.js 里调 ask
    var x = window.LimingXin; if (!x || !x.addBag) return;
    if (S.enabled) x.addBag('chat', '聊天', function () { quick(x); }); else x.removeBag('chat');
  }

  /* ---------- 对话 ---------- */
  function clearList() { termReset(); list.innerHTML = ''; typingEl = null; S.lastAt = 0; S.errRuns = {}; setUsage(null); hideUp(); }
  /* 聊天框底下那一行：这个对话的上下文用了多少（最近一次请求 / 模型上限）、累计消耗的 token、缓存命中率（输入里有多少是缓存命中的）。
     打开对话时从 history 拿，每轮做完从 done 事件里拿；新对话还没有，不显示。点一下展开明细 */
  function setUsage(u) { S.usage = u && typeof u === 'object' && u.total ? u : null; renderUsage(); }
  function tok(n) {
    n = Math.max(0, Math.round(+n || 0));
    if (n < 1e4) return String(n);
    if (n < 1e8) { var v = n / 1e4; return (v < 100 ? v.toFixed(1).replace(/\.0$/, '') : Math.round(v)) + '万'; }
    var y = n / 1e8; return (y < 100 ? y.toFixed(2).replace(/\.?0+$/, '') : Math.round(y)) + '亿';
  }
  function renderUsage() {
    if (!useEl) return;
    var u = S.usage;
    useEl.hidden = !u;
    if (!u) { useEl.innerHTML = ''; return; }
    var pct = u.win > 0 ? Math.min(100, Math.max(u.ctx > 0 ? 1 : 0, Math.round(u.ctx / u.win * 100))) : -1;
    var hit = typeof u.cached === 'number' && u.input > 0 ? Math.round(u.cached / u.input * 100) : -1;   // Harness 不报缓存命中
    var b = h('button', 'xc-use-b'), ctx = h('span', 'xc-use-i xc-use-ctx', '上下文 ');
    b.type = 'button'; b.setAttribute('aria-expanded', S.useMore ? 'true' : 'false'); b.title = S.useMore ? '收起明细' : '看明细';
    if (pct >= 0) {
      var bar = h('i', 'xc-use-bar' + (pct >= 90 ? ' hot' : pct >= 70 ? ' warm' : '')), fill = h('i');
      fill.style.width = pct + '%'; bar.appendChild(fill); ctx.appendChild(bar); ctx.appendChild(document.createTextNode(pct + '%'));
    } else ctx.appendChild(document.createTextNode(tok(u.ctx)));
    b.appendChild(ctx);
    b.appendChild(h('span', 'xc-use-i', '消耗 ' + tok(u.total) + ' token'));
    if (hit >= 0) b.appendChild(h('span', 'xc-use-i', '缓存命中 ' + hit + '%'));
    useEl.innerHTML = ''; useEl.appendChild(b);
    if (S.useMore) useEl.appendChild(h('div', 'xc-use-more', '上下文 ' + tok(u.ctx) + (u.win > 0 ? ' / ' + tok(u.win) : '') + ' · 输入 ' + tok(u.input) + (typeof u.cached === 'number' ? '（缓存命中 ' + tok(u.cached) + '）' : '') + ' · 输出 ' + tok(u.output)));
  }
  function newChat(stay, toMain) {
    detachConversation();
    S.agent = agentPref();
    stopPolling(); S.sid = ''; S.sessAgent = ''; S.run = ''; S.off = 0; S.pos = null; ls(LS_SID, null); S.hModel = hmPref(); S.lastModel = ''; S.queue = []; setPick(false);
    S.toMain = !TQ && !!toMain; S.more = false; S.title = '';
    if (!stay) { S.view = 'chat'; setDrawer(false); }
    clearList(); S.histFor = ''; welcome(); render(); refreshSide();
  }
  // 回到主对话：有就打开，还没有就是一张空白页，第一句发出去才有
  function goMain() {
    if (S.main && S.main === S.sid && S.view === 'chat') { setDrawer(false); return; }
    if (S.main) openSession(S.main); else newChat(false, true);
  }
  function welcome() {
    if (TQ) {
      var constellation = h('div', 'tq-empty xc-hello tq');
      var orbit = h('div', 'tq-empty-orbit'); orbit.setAttribute('aria-hidden', 'true');
      orbit.appendChild(h('i', 'tq-empty-ring'));
      orbit.appendChild(h('i', 'tq-empty-star'));
      orbit.appendChild(h('i', 'tq-empty-planet'));
      constellation.appendChild(orbit);
      constellation.appendChild(h('p', 'tq-empty-text', '从一个问题开始探索'));
      list.appendChild(constellation);
      return;
    }
    var p = h('div', 'xc-hello');
    var mk = h('div', 'xc-hello-mk');
    mk.appendChild(avatar('big xc-face'));
    p.appendChild(mk);
    var tw = h('span', 'xc-sw-w xc-hello-tw'); tw.appendChild(h('b', 'xc-hello-t', '小芯')); p.appendChild(tw);
    list.appendChild(p);
    paintFaces();
  }
  function loadCurrent() {
    status();
    if (!S.sid && mainDraft() && S.main) return openSession(S.main);
    if (S.sid) return openSession(S.sid);
    clearList(); S.histFor = ''; welcome(); render(); showDeliveries();
    return null;
  }
  function status() {
    call('status').then(function (d) {
      S.machine = d.name || ''; S.mstate = d.state || '';
      if (d.state === 'suspended' || d.state === 'stopped') { wakeVm(); setTimeout(status, 8000); }
      renderHead(); renderHome();
    }, function (e) { setStatus(e.message, 'bad'); });
  }
  function openSession(sid) {
    detachConversation();var my=S.loadSeq,generation=S.convSeq;
    S.sid=sid;S.sessAgent='';S.loadingConversation=true;
    // 先清掉「这一轮还在跑」：重读期间那一轮可能已经做完了，以历史里说的为准（还在跑就从那里接着取）
    stopPolling(); S.run = ''; S.off = 0; S.pos = null; S.queue = []; S.view = 'chat'; setDrawer(false); clearList(); render();
    list.appendChild(h('p', 'xc-hint xc-loading', '正在读取对话…'));
    return call('history', { sid: sid }, 60000, null, function(){return generation===S.convSeq;}).then(function (d) {
      if(generation!==S.convSeq)return;
      S.loadingConversation=false;renderSendBtn();
      if (my !== S.loadSeq) return;
      clearList();
      S.sid = sid; S.sessAgent = d.session.agent; ls(LS_SID, sid); S.histFor = sid; S.toMain = false; S.title = d.session.title || '';
      if (!TQ) { if (d.session.main) setMain(sid); else if (sid === S.main) setMain(''); }
      refreshSide();
      S.more = !!d.more; S.first = d.runs.length ? d.runs[0].run : '';
      if (S.more) list.appendChild(earlierBtn());
      // Harness 对话接着用它上次的模型；Codex（默认模式）的模型是小芯挑的，只记下最近一句用的是谁（模型按钮点开能看到）
      if (TQ || d.session.agent === 'harness') S.hModel = HM_MODELS[d.session.model] ? d.session.model : hmPref();
      S.lastModel = d.session.model || '';
      // 这个对话派出去的后台任务：先记下最新状态（卡片按它画），做完的结果按结束时间插在各轮之间
      (d.tasks || []).forEach(function (t) { S.tinfo[t.sid] = t; });
      var ended = (d.tasks || []).filter(function (t) { return !tLive(t); }).sort(function (a, b) { return (a.endedAt || 0) - (b.endedAt || 0); });
      d.runs.forEach(function (r) {
        while (ended.length && r.started && (ended[0].endedAt || 0) < r.started) placeEnded(ended.shift());
        r.events.forEach(function (ev) { draw(ev, true, r.run); });
      });
      ended.forEach(placeEnded);
      (d.tasks || []).filter(tLive).forEach(function (t) { taskBox(t.sid, false); });   // 在做的：聊天最底下
      termSync();
      if (!TQ && (d.tasks || []).some(function(t){return tLive(t)||t.delivery?.state==='pending';})) pollTasksSoon(1500);
      setUsage(d.usage);
      if (d.active) { S.run = d.active.run; S.off = d.active.off; S.pos = typeof d.active.pos === 'number' ? d.active.pos : null; S.t0 = Math.min(Date.now(), d.active.started || Date.now()); S.doing = 'think'; S.act = ''; S.thinkS = ''; S.thinkFixed = false; startPolling(); typing(true); var x = xin(); if (x) x.ai('think'); }
      restoreQueue(); if (!d.active) flushQueue();
      render(); toBottom(true); showDeliveries();
    }, function (e) {
      if(generation!==S.convSeq)return;
      S.loadingConversation=false;renderSendBtn();
      if (my !== S.loadSeq) return;
      clearList();
      if (/找不到/.test(e.message)) { if (!TQ && sid === S.main) setMain(''); newChat(false, !TQ); return; }
      list.appendChild(h('p', 'xc-hint', '读取失败：' + e.message));
    });
  }
  /* 更早的消息：历史一页 30 轮，顶上一颗按钮往前翻（主对话一直聊下去，早先的也要看得到）。
     新取到的画在一个临时的列表里，再整段插到最前面，页面停在原来看的位置 */
  function earlierBtn() {
    var b = h('button', 'xc-earlier', '更早的消息'); b.type = 'button';
    b.addEventListener('click', function () {
      if (b.disabled || !S.sid || !S.first) return;
      b.disabled = true;
      var sid = S.sid, generation = S.convSeq;
      call('history', { sid: sid, before: S.first }, 60000, null, function () { return generation === S.convSeq; }).then(function (d) {
        if (generation !== S.convSeq || sid !== S.sid) return;
        // 页面停在原处：记下按钮后面那一条现在在哪，插完以后把它挪回原位（浏览器自己的滚动锚定先关掉，免得两边各挪一次）
        var body = root.querySelector('.xc-body'), anchor = b.nextElementSibling, y0 = anchor ? anchor.getBoundingClientRect().top : 0;
        body.style.overflowAnchor = 'none';
        var real = list, realTyping = typingEl, lastAt = S.lastAt, tmp = h('div');
        list = tmp; typingEl = null; S.lastAt = 0;
        try { (d.runs || []).forEach(function (r) { r.events.forEach(function (ev) { draw(ev, true, r.run); }); }); }
        finally { list = real; typingEl = realTyping; S.lastAt = lastAt; }
        b.remove();
        [].forEach.call(tmp.querySelectorAll('[data-tres]'), function (e) { if (real.querySelector('[data-tres="' + e.dataset.tres + '"]')) e.remove(); });
        var frag = document.createDocumentFragment();
        S.more = !!d.more; if (d.runs && d.runs.length) S.first = d.runs[0].run;
        if (S.more) frag.appendChild(earlierBtn());
        while (tmp.firstChild) frag.appendChild(tmp.firstChild);
        list.insertBefore(frag, list.firstChild);
        if (anchor) body.scrollTop += anchor.getBoundingClientRect().top - y0;
        requestAnimationFrame(function () { body.style.overflowAnchor = ''; });
      }, function () { b.disabled = false; });
    });
    return b;
  }
  function openConversation(sid) {
    if (sid && sid !== S.sid) {
      if (!root) build();
      if (S.authed) openSession(sid);
      else { detachConversation(); S.sid = sid; S.histFor = ''; }
      ls(LS_SID, sid);
    }
    open();
  }
  /* ---------- 侧边栏 ----------
     上面：小芯和好感度、「新对话」；中间：小芯的记忆 / 每日任务 / 小芯的文件三个入口，下面是最近的对话；最下面：设置（点开）、退出登录。
     点了对话或入口，侧边栏收起来；入口打开的页面左上角「← 返回」回到聊天并重新拉开侧边栏。 */
  var ICON = {
    mem: '<path d="M6 3h11a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H6zM6 3v18M9 8h6M9 12h6"/>',
    pin: '<path d="M9 4h6l-1 6 3 3H7l3-3zM12 13v7"/>',
    daily: '<circle cx="12" cy="13" r="7.5"/><path d="M12 9v4l2.5 2M9 3h6"/>',
    files: '<path d="M3 7a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1"/>',
    chev: '<path d="m9 6 6 6-6 6"/>',
    x: '<path d="m6 6 12 12M18 6 6 18"/>'
  };
  function svgIcon(k) { return '<svg viewBox="0 0 24 24" aria-hidden="true">' + ICON[k] + '</svg>'; }
  function setDrawer(on) {
    on = !!on;
    if (root && root.classList.contains('wb-side')) { S.drawer = false; root.classList.remove('dr-open'); return; }
    if (!root || S.drawer === on) { S.drawer = on; return; }
    if (TQ && on && S.sheet) setSheet(false);
    S.drawer = on;
    root.classList.toggle('dr-open', on);
    var button = root.querySelector('.xc-list-b'), drawer = root.querySelector('.xc-drawer');
    button.setAttribute('aria-expanded', on ? 'true' : 'false');
    drawer.setAttribute('aria-hidden', on ? 'false' : 'true');
    if (on) {
      loadSessions();
      var f = drawerEl.querySelector(TQ ? '.xc-dr-x' : '.xc-dr-new');
      if (f && !touch) setTimeout(function () { if (S.drawer) f.focus(); }, 60);
    } else if (TQ && !button.hidden && drawer.contains(document.activeElement)) button.focus({ preventScroll: true });
  }
  // 从侧边栏打开一个页面（小芯的记忆 / 每日任务 / 文件）
  function fromDrawer(fn) { return function () { setDrawer(false); fn(); }; }
  // 页面左上角的「← 返回」：回到聊天，拉开侧边栏（从侧边栏进来的）
  function backBtn(toDrawer) {
    var b = h('button', 'xc-link xc-back', toDrawer ? '← 返回' : '← 回到对话'); b.type = 'button';
    b.addEventListener('click', function () { S.view = 'chat'; render(); if (toDrawer) setDrawer(true); });
    return b;
  }
  function loadSessions() {
    drawerEl.innerHTML = '';
    // 头：小芯（或天启）+ 名字 + 好感度，右边收起
    var hd = h('div', 'xc-dr-hd'), who = h('div', 'xc-dr-who'), x = h('button', 'xc-ib xc-dr-x');
    x.type = 'button'; x.setAttribute('aria-label', TQ ? '关闭对话记录' : '收起侧边栏'); x.innerHTML = svgIcon('x');
    x.addEventListener('click', function () { setDrawer(false); });
    who.appendChild(h('b', 'xc-dr-name', TQ ? '对话记录' : '小芯'));
    if (!TQ) who.appendChild(h('span', 'xc-dr-st', titleEl.textContent || ''));
    hd.appendChild(TQ ? tqMark('dr') : glowAv('', 'dr')); hd.appendChild(who); hd.appendChild(x);
    drawerEl.appendChild(hd);
    var sc = h('div', 'xc-dr-sc');
    var keys = h('div', 'xc-dr-keys');
    var nb = h('button', 'xc-dr-new xc-key' + (TQ ? ' xc-tqb' : '')); nb.type = 'button';
    if (TQ) { nb.appendChild(tqMark()); nb.appendChild(h('span', '', '新建对话')); }
    else nb.innerHTML = svgIcon('plus') + '<span>新建对话</span>';
    nb.addEventListener('click', function () { newChat(); if (!touch) input.focus(); });
    keys.appendChild(nb);
    sc.appendChild(keys);
    // 搜索：对话、功能都从命令面板找（电脑上 Ctrl / ⌘ + K 也能打开）
    var q = h('button', 'xc-dr-q'); q.type = 'button'; q.setAttribute('aria-haspopup', 'dialog');
    q.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/></svg><span>搜索对话和功能</span>' + (touch ? '' : '<kbd>' + (/Mac|iP/.test(navigator.platform) ? '⌘' : 'Ctrl ') + 'K</kbd>');
    q.addEventListener('click', function () { openPal(); });
    sc.appendChild(q);

    if (!TQ) {
      // 主对话：一直聊下去的那一个，固定在最上面
      var mb = h('button', 'xc-mainb'); mb.type = 'button'; mb.innerHTML = svgIcon('pin') + '<span>主对话</span><i></i>';
      mb.addEventListener('click', function () { goMain(); if (!touch) input.focus(); });
      // 主对话后面的 ⋯：只有一件事——归档（记录收进「已归档」），主对话从头开始
      var mrow = h('div', 'xc-mainrow'), mm = h('button', 'xc-si-more xc-main-more'); mm.type = 'button'; mm.setAttribute('aria-label', '归档主对话，重新开始'); mm.setAttribute('aria-expanded', 'false'); mm.hidden = !S.main;
      mm.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle class="fill" cx="5.5" cy="12" r="1.6"/><circle class="fill" cx="12" cy="12" r="1.6"/><circle class="fill" cx="18.5" cy="12" r="1.6"/></svg>';
      mm.addEventListener('click', function () {
        var old = mrow.querySelector('.xc-sa'); if (old) { old.remove(); mm.setAttribute('aria-expanded', 'false'); return; }
        mm.setAttribute('aria-expanded', 'true');
        var row = h('div', 'xc-sa'), go = h('button', 'xc-sa-b', '归档并新建'), msg = h('p', 'xc-sa-m'); go.type = 'button';
        go.addEventListener('click', function () {
          var sid = S.main; if (!sid) return;
          go.disabled = true; msg.textContent = '';
          call('archive', { sid: sid, on: true }, 60000).then(function (r) {
            if (r && r.error) throw new Error(r.msg || r.error);
            setMain(''); if (S.sid === sid) newChat(true, true);
            loadSessions(); toast('主对话已归档，重新开始');
          }).catch(function (e) { go.disabled = false; msg.textContent = '归档失败：' + e.message; });
        });
        row.appendChild(go); row.appendChild(msg); mrow.appendChild(row);
      });
      mrow.appendChild(mb); mrow.appendChild(mm);
      sc.appendChild(mrow); paintMainB();
    }
    var unsent=[];try{for(var i=0;i<localStorage.length;i++){var k=localStorage.key(i);if(k.indexOf(LS_PFX+'unsent.')===0){var v=JSON.parse(ls(k)||'null');if(v)unsent.push({key:k,value:v});}}}catch{}
    if(unsent.length){sc.appendChild(h('p','xc-dr-h','未发送的消息'));unsent.slice(0,20).forEach(function(item){var b=h('button','xc-memb',String(item.value.text||'附件消息').slice(0,40));b.type='button';b.addEventListener('click',function(){var v=item.value,p=v.sid?openSession(v.sid):newChat(),generation=S.convSeq;Promise.resolve(p).then(function(){if(generation!==S.convSeq)return;input.value=v.text||'';S.atts=v.atts||[];S.retrySend=v;ls(LS_DRAFT,input.value||null);ls(item.key,null);renderAtts();grow();render();input.focus();});});sc.appendChild(b);});}
    var dh = h('p', 'xc-dr-h xc-dr-conv', '对话');   // 自己的类名：上面有「未发送的消息」时，重画列表不能改到那一行
    sc.appendChild(dh);
    var ul = h('ul', 'xc-sl xc-sl-main');
    ul.appendChild(h('li', 'xc-hint xc-sl-wait', '正在读取…'));
    sc.appendChild(ul);
    // 对话多了只露最近几个，其余收在「更多对话」里，侧边栏不会越拉越长
    var fold = h('button', 'xc-dr-fold xc-more-b'); fold.type = 'button'; fold.hidden = true;
    fold.addEventListener('click', function () { S.sessAll = !S.sessAll; foldSess(); if (!S.sessAll) dh.scrollIntoView({ block: 'nearest' }); });
    sc.appendChild(fold);
    // 归档的对话：收在「已归档（N）」里，默认收着
    var ab = h('button', 'xc-dr-fold xc-arch-b'); ab.type = 'button'; ab.hidden = true;
    var aul = h('ul', 'xc-sl xc-sl-arch'); aul.hidden = true;
    ab.addEventListener('click', function () { S.archOpen = !S.archOpen; renderSess(); if (S.archOpen) ab.scrollIntoView({ block: 'nearest' }); });
    sc.appendChild(ab); sc.appendChild(aul);
    var ft = h('div', 'xc-dr-ft');
    if (!TQ) {
      // 设置：默认收着，点开
      var setB = h('button', 'xc-dr-row xc-set-b'); setB.type = 'button'; setB.setAttribute('aria-expanded', 'false');
      setB.innerHTML = svgIcon('gear') + '<span>设置</span>' + svgIcon('chev');
      var set = settings(); set.hidden = true;
      setB.addEventListener('click', function () { set.hidden = !set.hidden; setB.setAttribute('aria-expanded', set.hidden ? 'false' : 'true'); if (!set.hidden) { if (set.load) set.load(); set.scrollIntoView({ block: 'nearest' }); } });
      // 底部一排：每日任务、设置并排（设置原地展开），下面退出登录
      var tools = h('div', 'xc-dr-tools'), nav = h('nav', 'xc-nav'); nav.setAttribute('aria-label', '小芯的东西');
      var db = h('button', 'xc-memb xc-dailyb'); db.type = 'button'; db.innerHTML = svgIcon('daily') + '<span>每日任务</span>';
      db.addEventListener('click', fromDrawer(loadDaily)); nav.appendChild(db);
      tools.appendChild(nav); tools.appendChild(setB);
      ft.appendChild(tools); ft.appendChild(set);
    }
    var out = h('button', 'xc-link xc-dr-out', '退出登录'); out.type = 'button'; out.addEventListener('click', logout);
    ft.appendChild(out);
    sc.appendChild(ft);
    drawerEl.appendChild(sc);
    var my = ++S.drawerSeq;
    if (S.sessList) renderSess();
    call('sessions', {}, 60000).then(function (d) {
      if (my !== S.drawerSeq) return;
      S.sessList = d.sessions || [];
      if (!TQ) {
        var m = S.sessList.filter(function (x) { return x.main; })[0];
        setMain(m ? m.sid : ''); paintMainB();
      }
      renderSess();
    }, function (e) { if (my !== S.drawerSeq) return; ul.innerHTML = ''; ul.appendChild(h('li', 'xc-hint', '读取失败：' + e.message)); });
  }
  // 侧边栏最上面那行「主对话」：正在看它就标出来，它在回话就亮个点
  function paintMainB() {
    var b = drawerEl && drawerEl.querySelector('.xc-mainb'); if (!b) return;
    var m = (S.sessList || []).filter(function (x) { return x.main; })[0];
    var cur = S.main ? S.sid === S.main : mainDraft();
    b.classList.toggle('cur', !!cur); if (cur) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current');
    b.classList.toggle('live', !!(m && m.active));
    b.lastChild.textContent = m && m.updated ? shortWhen(m.updated) : '';
    var more = drawerEl.querySelector('.xc-main-more'); if (more) more.hidden = !S.main;
  }
  // 画对话列表：没归档的放「对话」，归档的放「已归档（N）」里（默认收着）。归档 / 取消归档 / 删除以后重画
  function sessItem(s) {
    var li = h('li', 'xc-sli'), b = h('button', 'xc-si'); b.type = 'button';
    // 一行：天启的对话前面一颗星，标题，右边等宽的时间；在回话时时间前面一个像素点在闪。哪个 AI、在不在回话写进读屏名
    var tq = TQ || s.agent === 'harness', who = tq ? '天启' : s.agent === 'codex' ? '' : AGENTS[s.agent] || s.agent;
    b.appendChild(tq ? tqMark('xc-si-tq') : h('i', 'xc-si-tq'));
    b.appendChild(h('span', 'xc-si-t', s.title || '（无标题）'));
    var sm = h('span', 'xc-si-m');
    if (s.active) sm.appendChild(h('i', 'on'));
    if (who && !tq) sm.appendChild(h('span', 'xc-si-who', who));
    sm.appendChild(h('span', '', shortWhen(s.updated)));
    b.appendChild(sm);
    b.setAttribute('aria-label', [s.title || '（无标题）', who, when(s.updated), s.active ? '进行中' : ''].filter(Boolean).join('，'));
    if (s.sid === S.sid) { b.classList.add('cur'); b.setAttribute('aria-current', 'true'); }
    b.addEventListener('click', function () { openSession(s.sid); });
    var more = h('button', 'xc-si-more'); more.type = 'button'; more.setAttribute('aria-label', '改名、归档或删除'); more.setAttribute('aria-expanded', 'false');
    more.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle class="fill" cx="5.5" cy="12" r="1.6"/><circle class="fill" cx="12" cy="12" r="1.6"/><circle class="fill" cx="18.5" cy="12" r="1.6"/></svg>';
    more.addEventListener('click', function () { sessActions(li, s, more); });
    li.appendChild(b); li.appendChild(more);
    return li;
  }
  function renderSess() {
    var ul = drawerEl && drawerEl.querySelector('.xc-sl-main'), aul = drawerEl && drawerEl.querySelector('.xc-sl-arch'), ab = drawerEl && drawerEl.querySelector('.xc-arch-b');
    var dh = drawerEl && drawerEl.querySelector('.xc-dr-conv');
    if (!ul || !aul || !ab) return;
    var list = (S.sessList || []).filter(function (s) { return !s.main; }), main = list.filter(function (s) { return !s.archived; }), arch = list.filter(function (s) { return s.archived; });
    ul.innerHTML = ''; aul.innerHTML = '';
    if (dh) { dh.textContent = '对话'; if (main.length > SESS_SHOW) dh.appendChild(h('i', '', String(main.length))); dh.hidden = !main.length; }
    main.forEach(function (s) { ul.appendChild(sessItem(s)); });
    arch.forEach(function (s) { aul.appendChild(sessItem(s)); });
    ab.hidden = !arch.length; aul.hidden = !arch.length || !S.archOpen;
    ab.setAttribute('aria-expanded', S.archOpen ? 'true' : 'false');
    ab.innerHTML = '<span></span>' + svgIcon('chev');
    ab.querySelector('span').textContent = '已归档（' + arch.length + '）';
    foldSess();
  }
  // 对话列表折起来：只露最近 SESS_SHOW 个（正在看的那个不管排第几都露着），其余点「更多对话」展开；删了一个以后重新算
  var SESS_SHOW = 5;
  function foldSess() {
    var ul = drawerEl && drawerEl.querySelector('.xc-sl-main'), fold = drawerEl && drawerEl.querySelector('.xc-more-b');
    if (!ul || !fold) return;
    var items = ul.querySelectorAll('.xc-sli'), extra = 0;
    for (var i = 0; i < items.length; i++) {
      var keep = i < SESS_SHOW || !!items[i].querySelector('.xc-si.cur');
      if (!keep) extra++;
      items[i].hidden = !keep && !S.sessAll;
    }
    fold.hidden = !extra;
    fold.setAttribute('aria-expanded', S.sessAll ? 'true' : 'false');
    fold.innerHTML = '<span></span>' + svgIcon('chev');
    fold.querySelector('span').textContent = S.sessAll ? '收起' : '更多对话（' + extra + '）';
  }
  /* ---------- 新动作、好感度 ----------
     都存在小芯的电脑上（vm-agent.mjs 的 moves / bond），打开网页时跟着 greet 一起拿过来；
     页面上可能有两个小芯（工具箱首页一个、学习台 iframe 里一个），两个都教。 */
  function allXin() {
    var out = [];
    if (window.LimingXin) out.push(window.LimingXin);
    [].forEach.call(document.querySelectorAll('iframe'), function (f) { try { var X = f.contentWindow && f.contentWindow.LimingXin; if (X) out.push(X); } catch (e) { /* 别的源 */ } });
    return out;
  }
  function setMoves(list) { S.moves = Array.isArray(list) ? list : []; allXin().forEach(function (X) { if (X.learn) X.learn(S.moves); }); }
  function setBond(b) { if (!b || typeof b.score !== 'number') return; S.bond = b; allXin().forEach(function (X) { if (X.bond) X.bond(b.level); }); }
  // 你在网页上喂它、陪它玩（mascot.js 告诉这里）：一分钟最多报一次，小芯电脑那边一天最多 +3
  var playedAt = 0;
  function played(kind) {
    if (TQ || !S.enabled || !S.authed || Date.now() - playedAt < 60000) return;
    playedAt = Date.now();
    call('bond_play', { kind: kind }, 0).then(function (r) { if (r && r.info) setBond(r.info); }, function () {});
  }

  /* ---------- 小芯的屏幕：全屏看它的电脑桌面，也能接管 ----------
     Worker 的 screen：开桌面、在桌面上开一个终端实时滚动它在干什么、要一个短时链接（InstaBox 的桌面查看页），嵌在 iframe 里。
     「观看」时服务器丢掉你的键盘鼠标；「接管」换一个能操作的链接；关掉时接管过的话把链接全部作废（screen_off）。 */
  var scrEl = null, scrUsedCtl = false, scrSeq = 0;
  function buildScreen() {
    scrEl = h('div', 'xs'); scrEl.setAttribute('role', 'dialog'); scrEl.setAttribute('aria-label', '小芯的屏幕'); scrEl.hidden = true;
    scrEl.innerHTML =
      '<header class="xs-hd">' +
        '<button class="xc-ib xs-x" type="button" aria-label="关闭"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button>' +
        '<b class="xs-t">小芯的屏幕</b>' +
        '<div class="xc-segs xs-mode" role="radiogroup" aria-label="模式">' +
          '<button class="xc-ag" type="button" role="radio" data-mode="view">观看</button>' +
          '<button class="xc-ag" type="button" role="radio" data-mode="ctl">接管</button>' +
        '</div>' +
      '</header>' +
      '<p class="xs-tip"></p>' +
      '<div class="xs-body"><p class="xs-msg"></p><iframe class="xs-fr" title="小芯的电脑桌面" allow="clipboard-read; clipboard-write; fullscreen" referrerpolicy="no-referrer" hidden></iframe></div>';
    document.body.appendChild(scrEl);
    scrEl.querySelector('.xs-x').addEventListener('click', closeScreen);
    [].forEach.call(scrEl.querySelectorAll('.xs-mode .xc-ag'), function (b) {
      b.addEventListener('click', function () { var ctl = b.getAttribute('data-mode') === 'ctl'; if (ctl !== scrEl._ctl) loadScreen(ctl); });
    });
    scrEl.addEventListener('keydown', function (e) { if (e.key === 'Escape') { e.preventDefault(); closeScreen(); } });
  }
  // first：先用别的操作拿链接（登录窗口：login_open 开好窗口回一个接管链接），之后切换观看 / 接管照常用 screen
  function openScreen(control, first) {
    if (TQ || !S.enabled || !S.authed) return;
    if (!scrEl) buildScreen();
    scrEl.hidden = false; document.body.classList.add('xs-open');
    loadScreen(!!control, first);
    try { scrEl.querySelector('.xs-x').focus({ preventScroll: true }); } catch (e) { /* 老浏览器 */ }
  }
  function loadScreen(control, first) {
    var my = ++scrSeq, fr = scrEl.querySelector('.xs-fr'), msg = scrEl.querySelector('.xs-msg');
    scrEl._ctl = control; if (control) scrUsedCtl = true;
    scrEl.classList.toggle('ctl', control);
    [].forEach.call(scrEl.querySelectorAll('.xs-mode .xc-ag'), function (b) { b.setAttribute('aria-checked', (b.getAttribute('data-mode') === 'ctl') === control ? 'true' : 'false'); });
    scrEl.querySelector('.xs-tip').textContent = first ? '在登录窗口里自己登录（输密码、扫码都行），小芯看不到你输的东西。登录后关掉屏幕，点「已登录，继续」或「保存登录」。'
      : control ? '接管中：你的鼠标、键盘会直接操作小芯的电脑。用完点「观看」或关掉。' : '只看不动：中间那个终端实时显示小芯在干什么。想自己动手，点「接管」。';
    fr.hidden = true; fr.src = 'about:blank';
    msg.hidden = false; msg.textContent = first ? '正在打开登录窗口…' : '正在打开屏幕…';
    (first ? first() : call('screen', { control: control }, 90000)).then(function (d) {
      if (my !== scrSeq || scrEl.hidden) return;
      fr.src = d.url; fr.hidden = false; msg.hidden = true;
    }, function (e) { if (my === scrSeq) msg.textContent = '打不开：' + e.message; });
  }
  // 登录窗口（docs/xin-browser-v2-design.md 第 7 节）：任务等你登录时传 {sid}，设置里登录新网站传 {url}
  function openLogin(args) { openScreen(true, function () { return call('login_open', args, 90000); }); }
  function closeScreen() {
    if (!scrEl || scrEl.hidden) return;
    scrSeq++;
    scrEl.hidden = true; document.body.classList.remove('xs-open');
    var fr = scrEl.querySelector('.xs-fr'); fr.src = 'about:blank'; fr.hidden = true;
    if (scrUsedCtl) { scrUsedCtl = false; call('screen_off', {}, 20000).catch(function () {}); }   // 接管过：能操作的链接全部作废
    if (root && S.open && !touch) { var sb = root.querySelector('.xc-work .xc-scr-b'); (sb && sb.offsetParent ? sb : isleEl).focus({ preventScroll: true }); }
  }

  /* ---------- 设置：天启模式、附带正在看的页面、做完提醒（学习记录、主动跟进站长 2026-11-11 说不要，已去掉） ---------- */
  function toggleRow(cls, title, desc) {
    var row = h('div', 'xc-tg ' + cls), txt = h('div', 'xc-tg-t'), b = h('button', 'xc-sw'), note = h('p', 'xc-tg-n');
    txt.appendChild(h('b', '', title)); if (desc) txt.appendChild(h('span', '', desc));   // 说明小字：没有就不放
    b.type = 'button'; b.setAttribute('role', 'switch'); b.setAttribute('aria-checked', 'false'); b.setAttribute('aria-label', title);
    row.appendChild(txt); row.appendChild(b); row.appendChild(note);
    return { row: row, btn: b, set: function (on) { b.setAttribute('aria-checked', on ? 'true' : 'false'); }, note: function (t) { note.textContent = t || ''; } };
  }
  function settings() {
    var box = h('div', 'xc-set');
    box.appendChild(h('p', 'xc-set-h', '设置'));
    // 附带：发消息时带上学习台里正在看的页面、选中的文字、写的代码。关掉就都不带（记在这个浏览器里）
    var ctx = toggleRow('xc-ctxauto', '附带当前页面', '');
    ctx.set(ls(LS_CTX) !== '0');
    ctx.btn.addEventListener('click', function () { var on = ls(LS_CTX) === '0'; ls(LS_CTX, on ? null : '0'); ctx.set(on); S.ctxSkip = null; refreshCtx(); });
    box.appendChild(ctx.row);
    var push = toggleRow('xc-push', '完成通知', '');
    box.appendChild(push.row);
    pushSetup(push);
    // 机外备份：Worker 每天把小芯的状态包加密存进 Cloudflare（docs/xin-reliability-usage-design.md 的 C 部分）。打开设置才去取列表；
    // 网站没开备份（404）这一行就不出现。「下载」是最近那份解密后的包，新电脑上解进空的 ~/.xin 就恢复了
    var bk = h('div', 'xc-tg xc-bk'), bt = h('div', 'xc-tg-t'), bdesc = h('span'), dl = h('a', 'xc-bk-dl', '下载'), bkAt = 0;
    bt.appendChild(h('b', '', '机外备份')); bt.appendChild(bdesc); bk.appendChild(bt); bk.appendChild(dl);
    bk.hidden = true; dl.hidden = true; box.appendChild(bk);
    var bjDay = function (t) { return new Date(t + 8 * 3600e3).toISOString().slice(0, 10); };
    // 网站登录（docs/xin-browser-v2-design.md 第 8 节）：任务点名网站时带上你在那儿保存的登录。点「查看」才去云电脑取列表
    var lgRow = h('div', 'xc-tg xc-lg'), lgT = h('div', 'xc-tg-t'), lgBtn = h('button', 'xc-btn sec', '查看'), lgBody = h('div', 'xc-lg-b');
    lgT.appendChild(h('b', '', '网站登录')); lgT.appendChild(h('span', '', '任务点名哪个网站，就带上你在那儿的登录'));
    lgBtn.type = 'button'; lgRow.appendChild(lgT); lgRow.appendChild(lgBtn); lgRow.appendChild(lgBody); lgBody.hidden = true;
    box.appendChild(lgRow);
    var lgDay = function (t) { var d = new Date(t + 8 * 3600e3); return (d.getUTCMonth() + 1) + '月' + d.getUTCDate() + '日'; };
    function lgRender(d) {
      lgBody.innerHTML = ''; lgBody.hidden = false;
      var list = h('ul', 'xc-lg-l');
      (d.sites || []).forEach(function (x) {
        var li = h('li'), rm = h('button', 'xc-lnk', '删除'); rm.type = 'button'; rm.setAttribute('aria-label', '删除 ' + x.site + ' 的登录');
        li.appendChild(h('span', '', x.site)); li.appendChild(h('small', '', lgDay(x.saved))); li.appendChild(rm);
        rm.addEventListener('click', function () { rm.disabled = true; call('login_remove', { site: x.site }, 30000).then(lgRender, function (e) { rm.disabled = false; lgNote.textContent = '删除失败：' + e.message; }); });
        list.appendChild(li);
      });
      if (!(d.sites || []).length) lgBody.appendChild(h('p', 'xc-lg-e', '还没有保存的登录'));
      else lgBody.appendChild(list);
      var add = h('div', 'xc-lg-add'), inp = h('input', 'xc-lg-in'), go = h('button', 'xc-btn', '登录新网站'), done = h('button', 'xc-btn sec', '保存登录');
      inp.type = 'url'; inp.placeholder = '网址，比如 https://www.bilibili.com'; inp.setAttribute('aria-label', '要登录的网址');
      go.type = 'button'; done.type = 'button'; done.hidden = !d.window;
      go.addEventListener('click', function () { if (!inp.value.trim()) { inp.focus(); return; } openLogin({ url: inp.value.trim() }); done.hidden = false; });
      done.addEventListener('click', function () { done.disabled = true; call('login_done', {}, 30000).then(function () { return call('logins', {}, 30000); }).then(lgRender, function (e) { done.disabled = false; lgNote.textContent = '没存上：' + e.message; }); });
      add.appendChild(inp); add.appendChild(go); add.appendChild(done); lgBody.appendChild(add);
      var lgNote = h('p', 'xc-tg-n', d.window ? '登录窗口开着：' + d.window.site + '，登录后点「保存登录」' : '删除只删小芯电脑上保存的登录；网站那边的登录设备要你自己去网站上退出。');
      lgBody.appendChild(lgNote);
    }
    lgBtn.addEventListener('click', function () {
      lgBtn.disabled = true; lgBtn.textContent = '取…';
      call('logins', {}, 60000).then(function (d) { lgBtn.hidden = true; lgRender(d); }, function (e) { lgBtn.disabled = false; lgBtn.textContent = '查看'; lgBody.hidden = false; lgBody.textContent = '取不到：' + e.message; });
    });
    box.load = function () {
      if (Date.now() - bkAt < 60000) return; bkAt = Date.now();
      fetch(API + 'backups', { credentials: 'same-origin' }).then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); }).then(function (d) {
        var list = (d && d.backups) || [], last = list[0];
        bk.hidden = false; bk.classList.remove('warn');
        if (!last) { bdesc.textContent = '还没有备份（每天 9:10 自动做）'; dl.hidden = true; return; }
        var age = Math.round((Date.parse(bjDay(Date.now())) - Date.parse(last.date)) / 864e5);
        var name = age === 0 ? '今天' : age === 1 ? '昨天' : (+last.date.slice(5, 7)) + '月' + (+last.date.slice(8, 10)) + '日';
        bdesc.textContent = '最近一次 ' + name + ' · 共 ' + list.length + ' 份' + (age > 2 ? ' · 已经 ' + age + ' 天没备份了' : '');
        bk.classList.toggle('warn', age > 2);
        dl.hidden = false; dl.href = API + 'backup?date=' + last.date; dl.setAttribute('download', '');
      }).catch(function () { bk.hidden = true; bkAt = 0; });
    };
    return box;
  }

  /* ---------- 做完提醒：Web Push ----------
     开关在设置里。打开时浏览器订阅推送（公钥来自小芯的电脑），订阅交给小芯的电脑保存；之后它做完一轮、而网页没在看时，直接从它的电脑发推送。
     iPhone / iPad 要先把网站「添加到主屏幕」，从主屏幕打开才能开（Safari 的规定）。打开以后发一条试试。 */
  function pushNoSupport() {
    if ('serviceWorker' in navigator && window.PushManager && window.Notification) return '';
    var ios = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    var app = navigator.standalone || (window.matchMedia && matchMedia('(display-mode: standalone)').matches);
    return ios && !app ? 'iPhone / iPad 上要先在 Safari 里点「分享 → 添加到主屏幕」，从主屏幕打开工具箱，再来这里打开。' : '这个浏览器收不了通知。';
  }
  function u8(b64) {
    var s = atob(String(b64).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((String(b64).length + 3) % 4)), a = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
    return a;
  }
  function b64of(buf) { var s = '', a = new Uint8Array(buf || []); for (var i = 0; i < a.length; i++) s += String.fromCharCode(a[i]); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
  function swReady() { return navigator.serviceWorker.register('/sw.js').then(function () { return navigator.serviceWorker.ready; }); }
  function syncPushDevice(){
    if(TQ||!S.authed||!('serviceWorker' in navigator))return;
    navigator.serviceWorker.getRegistration('/').then(function(r){return r&&r.pushManager?r.pushManager.getSubscription():null;}).then(function(sub){if(sub)return call('push_sub',{sub:sub.toJSON(),deviceId:S.deviceId,ua:navigator.userAgent.slice(0,160)},30000);}).catch(function(){});
  }
  function pushSetup(t) {
    var no = pushNoSupport();
    if (no) { t.btn.disabled = true; t.note(no); return; }
    if (Notification.permission === 'denied') t.note('通知被拒绝了：到浏览器（或系统）设置里允许这个网站发通知，再回来打开。');
    var reg = null, key = '', busy = false;
    // 先把 Service Worker 和公钥准备好：iPhone 要求点开关那一下直接订阅，中间不能再等别的
    swReady().then(function (r) { reg = r; return call('push_key', {}, 60000); }).then(function (d) {
      key = d.key;
      return reg.pushManager.getSubscription();
    }).then(function (sub) {
      // 公钥换过了（小芯电脑上的钥匙重新生成）：旧订阅作废
      if (sub && sub.options && sub.options.applicationServerKey && b64of(sub.options.applicationServerKey) !== key) return sub.unsubscribe().then(function () { return null; });
      return sub;
    }).then(function (sub) {
      t.set(!!sub);
      if (sub) call('push_sub', { sub: sub.toJSON(), deviceId:S.deviceId, ua: navigator.userAgent.slice(0, 160) }, 60000).catch(function () {});   // 让小芯那边也记着（它可能删过）
    }).catch(function (e) { t.note('完成通知没打开：' + e.message); });
    t.btn.addEventListener('click', function () {
      if (busy) return;
      if (!reg || !key) { t.note('还在准备，过一两秒再点'); return; }
      busy = true; t.note('');
      var on = t.btn.getAttribute('aria-checked') !== 'true';
      var p = on ? reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: u8(key) }).then(function (sub) {
        return call('push_sub', { sub: sub.toJSON(), deviceId:S.deviceId, ua: navigator.userAgent.slice(0, 160) }, 60000);
      }).then(function () {
        t.set(true); t.note('开好了，发了一条试试');
        return call('push_test', {}, 60000).then(function (r) { if (!r.ok) t.note('开好了，但试的那条没发出去：' + JSON.stringify(r.results || []).slice(0, 120)); });
      }) : reg.pushManager.getSubscription().then(function (sub) {
        if (!sub) return null;
        var ep = sub.endpoint;
        return sub.unsubscribe().then(function () { return call('push_unsub', { endpoint: ep }, 60000).catch(function () {}); });
      }).then(function () { t.set(false); t.note('关了'); });
      p.catch(function (e) {
        var denied = e && (e.name === 'NotAllowedError' || Notification.permission === 'denied');
        t.note(denied ? '没有允许通知：到浏览器（或系统）设置里允许这个网站发通知，再回来打开。' : '开启失败：' + e.message);
      }).then(function () { busy = false; });
    });
  }
  // 点通知：sw.js 让已经开着的网页打开那段对话
  if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('message', function (e) {
    var d = e.data || {};
    if (TQ || d.type !== 'xin-open' || !S.enabled) return;
    openConversation(d.sid && /^s[0-9a-z]{6,24}$/.test(d.sid) ? d.sid : '');
  });

  /* ---------- 对话改名 / 删除：点对话后面的 ⋯ ---------- */
  function sessActions(li, s, more) {
    var old = li.querySelector('.xc-sa');
    [].forEach.call(drawerEl.querySelectorAll('.xc-sa'), function (x) { x.remove(); });
    [].forEach.call(drawerEl.querySelectorAll('.xc-si-more'), function (x) { x.setAttribute('aria-expanded', 'false'); });
    if (old) return;                       // 再点一次 ⋯ 就收起
    more.setAttribute('aria-expanded', 'true');
    var row = h('div', 'xc-sa'), inp = h('input'), ren = h('button', 'xc-sa-b', '改名'), del = h('button', 'xc-sa-b xc-sa-del', '删除'), msg = h('p', 'xc-sa-m');
    var arc = h('button', 'xc-sa-b xc-sa-arc', s.archived ? '取消归档' : '归档');
    inp.type = 'text'; inp.value = s.title || ''; inp.maxLength = 60; inp.setAttribute('aria-label', '对话的名字'); inp.setAttribute('enterkeyhint', 'done');
    ren.type = del.type = arc.type = 'button';
    // 归档：收进「已归档」，记录都留着；取消归档放回「最近的对话」
    arc.addEventListener('click', function () {
      arc.disabled = true; msg.textContent = '';
      call('archive', { sid: s.sid, on: !s.archived }, 60000).then(function (r) {
        if (r && r.error) throw new Error(r.msg || r.error);
        s.archived = !s.archived; renderSess(); toast(s.archived ? '已归档' : '已放回对话列表');
      }).catch(function (e) { arc.disabled = false; msg.textContent = '归档失败：' + e.message; });
    });
    var rename = function () {
      var t = inp.value.replace(/\s+/g, ' ').trim();
      if (!t) { inp.focus(); return; }
      ren.disabled = true; msg.textContent = '';
      call('rename', { sid: s.sid, title: t }, 60000).then(function (r) {
        if (r && r.error) throw new Error(r.msg || r.error);
        s.title = t; li.querySelector('.xc-si-t').textContent = t;
        row.remove(); more.setAttribute('aria-expanded', 'false'); toast('已改名'); if (s.sid === S.sid) { S.title = t; renderHead(); }
      }).catch(function (e) { ren.disabled = false; msg.textContent = '修改失败：' + e.message; });
    };
    ren.addEventListener('click', rename);
    inp.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); rename(); } });
    // 删除要点两下：第一下变成「确定删除？」，4 秒内再点才删
    var armed = 0;
    del.addEventListener('click', function () {
      if (Date.now() - armed > 4000) {
        armed = Date.now(); del.textContent = '确定删除？'; del.classList.add('armed');
        setTimeout(function () { if (Date.now() - armed >= 4000) { del.textContent = '删除'; del.classList.remove('armed'); } }, 4100);
        return;
      }
      del.disabled = true; msg.textContent = '';
      call('forget', { sid: s.sid }, 60000).then(function (r) {
        if (r && r.error) throw new Error(r.msg || r.error);
        S.sessList = (S.sessList || []).filter(function (x) { return x !== s; });
        if (s.sid === S.sid) newChat(true);
        renderSess(); toast('已删除');
      }).catch(function (e) { del.disabled = false; armed = 0; del.textContent = '删除'; del.classList.remove('armed'); msg.textContent = '删除失败：' + e.message; });
    });
    row.appendChild(inp); row.appendChild(ren); row.appendChild(arc); row.appendChild(del); row.appendChild(msg);
    li.appendChild(row);
    if (!touch) inp.focus();
  }

  /* ---------- 小芯的文件：它电脑里工作目录（/data/workspace）的文件，能预览、能下载 ---------- */
  var FILE_ICON = {
    dir: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/></svg>',
    file: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h8l4 4v14H6zM14 3v4h4"/></svg>'
  };
  function fmtSize(n) { return n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB' : (n / 1048576).toFixed(1) + ' MB'; }
  function loadFiles(p, from) {
    if (from) S.filesFrom = from;
    S.view = 'files'; render();
    var my = ++S.loadSeq;
    sessEl.innerHTML = ''; sessEl.appendChild(h('p', 'xc-hint', '正在读取…'));
    call('files', { path: p || WORK }, 60000).then(function (d) {
      if (my !== S.loadSeq) return;
      sessEl.innerHTML = '';
      sessEl.appendChild(backBtn(S.filesFrom !== 'chat'));
      if (d.error) {
        sessEl.appendChild(h('p', 'xc-hint', d.msg || d.error));
        var home = h('button', 'xc-link xc-inl', '打开工作目录'); home.type = 'button';
        home.addEventListener('click', function () { loadFiles(WORK); });
        sessEl.appendChild(home);
        return;
      }
      sessEl.appendChild(crumbs(d.path, d.work || WORK));
      if (d.dir) drawDir(d); else drawFile(d);
    }, function (e) {
      if (my !== S.loadSeq) return;
      sessEl.innerHTML = ''; sessEl.appendChild(h('p', 'xc-hint', '读取失败：' + e.message));
    });
  }
  // 面包屑：工作目录 › blink › build（每一段都能点）
  function crumbs(p, work) {
    var nav = h('nav', 'xc-crumbs'); nav.setAttribute('aria-label', '位置');
    var segs = p.length > work.length ? p.slice(work.length + 1).split('/') : [];
    var add = function (label, target, last) {
      if (last) { nav.appendChild(h('b', '', label)); return; }
      var b = h('button', 'xc-crumb', label); b.type = 'button';
      b.addEventListener('click', function () { loadFiles(target); });
      nav.appendChild(b); nav.appendChild(h('span', 'xc-crumb-s', '›'));
    };
    add('工作目录', work, !segs.length);
    segs.forEach(function (seg, i) { add(seg, work + '/' + segs.slice(0, i + 1).join('/'), i === segs.length - 1); });
    return nav;
  }
  function drawDir(d) {
    if (d.path === (d.work || WORK)) sessEl.appendChild(h('p', 'xc-hint', TQ ? '天启电脑里的工作目录：它写的代码、文件都放在这里。点文件能预览、下载。' : '小芯电脑里的工作目录：它写的代码、编译出来的 .hex 都放在这里。点文件能预览、下载。'));
    var ul = h('ul', 'xc-fl');
    if (!d.entries.length) ul.appendChild(h('li', 'xc-hint', d.path === (d.work || WORK) ? (TQ ? '还没有文件。让天启写点东西，做好的文件会放在这里。' : '还没有文件。让小芯写个程序编译一下，做好的东西会放在这里。') : '这个文件夹是空的'));
    d.entries.forEach(function (it) {
      var li = h('li'), b = h('button', 'xc-fi' + (it.dir ? ' dir' : '')); b.type = 'button';
      b.innerHTML = it.dir ? FILE_ICON.dir : FILE_ICON.file;
      b.appendChild(h('span', 'xc-fi-n', it.name));
      b.appendChild(h('span', 'xc-fi-m', it.dir ? when(it.mtime) : fmtSize(it.size) + ' · ' + when(it.mtime)));
      b.addEventListener('click', function () { loadFiles(d.path + '/' + it.name); });
      li.appendChild(b); ul.appendChild(li);
    });
    sessEl.appendChild(ul);
    if (d.more) sessEl.appendChild(h('p', 'xc-hint', '还有 ' + d.more + ' 个没列出来'));
  }
  function drawFile(d) {
    var name = d.path.split('/').pop();
    sessEl.appendChild(h('p', 'xc-fmeta', fmtSize(d.size) + ' · ' + when(d.mtime)));
    var row = h('div', 'xc-memrow'), dl = h('button', 'xc-btn', '下载'), cp = h('button', 'xc-btn xc-btn2', '复制路径'), msg = h('span', 'xc-hint', '');
    dl.type = cp.type = 'button';
    dl.addEventListener('click', function () { download(d.path, name, dl, msg); });
    cp.addEventListener('click', function () {
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(d.path).then(function () { msg.textContent = '复制好了'; }, function () { msg.textContent = d.path; });
      else msg.textContent = d.path;
    });
    row.appendChild(dl); row.appendChild(cp); row.appendChild(msg); sessEl.appendChild(row);
    if (typeof d.text === 'string') {
      var pre = h('pre', 'xc-pre'), c = h('code');
      // 按扩展名上色（Makefile 没有扩展名）；太长的就不上色了
      var ext = /^makefile$/i.test(name) ? 'make' : (name.indexOf('.') > 0 ? name.split('.').pop() : '');
      if (d.text.length < 150000) c.innerHTML = hl(d.text, ext); else c.textContent = d.text;
      pre.appendChild(c); sessEl.appendChild(pre);
    } else sessEl.appendChild(h('p', 'xc-hint', d.big ? '文件太大，这里不预览，可以下载下来看。' : '这不是文字文件（比如 .bin、.elf），不能预览，可以下载。'));
  }
  // 下载：先取成 Blob 再存（出错时能在这里说清楚，而不是下载一个报错的网页）；电脑在睡就等它醒
  function download(p, name, btn, msg) {
    var t0 = Date.now();
    btn.disabled = true; msg.textContent = '正在下载…';
    (function once() {
      fetch(API + 'file?path=' + encodeURIComponent(p), { credentials: 'same-origin' }).then(function (r) {
        if (r.ok && (r.headers.get('content-type') || '').indexOf('application/json') < 0) {
          return r.blob().then(function (b) {
            var u = URL.createObjectURL(b), a = document.createElement('a');
            a.href = u; a.download = name; a.hidden = true; document.body.appendChild(a); a.click(); a.remove();
            setTimeout(function () { URL.revokeObjectURL(u); }, 60000);
            btn.disabled = false; msg.textContent = '下载好了（' + fmtSize(b.size) + '）';
          });
        }
        return r.json().catch(function () { return {}; }).then(function (d) {
          if (r.status === 401) { S.authed = false; S.tqNoGw = false; syncBag(); render(); throw new Error('要先登录'); }
          if (r.status === 503 && (d.state === 'waking' || d.state === 'busy') && Date.now() - t0 < 60000) {
            msg.textContent = d.msg || '唤醒中…'; setTimeout(once, (d.retryAfter || 3) * 1000); return;
          }
          throw new Error(d.msg || ('出错了（' + r.status + '）'));
        });
      }).catch(function (e) { btn.disabled = false; msg.textContent = '没下载下来：' + e.message; });
    })();
  }

  /* ---------- 后台任务中心（侧边栏「后台任务」）----------
     所有对话派出去的分身：还没做完的在上面，最近做完的在下面（写着是哪个对话派的），点一个看过程；
     每日任务做得怎么样；各模型最近 14 天用得怎么样（用了几次、成了几次、平均多久、换过几次模型）——路由器的候选顺序按这个手动调。
     有任务在做时 5 秒刷新一次。 */
  function loadTasksView() {
    if (TQ) return;
    clearTimeout(S.tvTm);
    if (S.view !== 'tasks') { S.view = 'tasks'; render(); sessEl.innerHTML = ''; sessEl.appendChild(h('p', 'xc-hint', '正在读取…')); }
    call('tasks', { all: true }, 60000).then(function (d) {
      if (d && d.error) throw new Error(d.msg || d.error);
      if (S.view !== 'tasks') return;
      S.bg = d.bg || 0; S.tactive = d.active || []; glowFrom(d);
      setTasks(d.tasks || [], true); renderStrip();
      var top = sessEl.scrollTop;
      sessEl.innerHTML = '';
      sessEl.appendChild(backBtn(true));
      var all = (d.tasks || []).slice().reverse(), titles = d.titles || {};
      var live = all.filter(function (t) { return tLive(t) || t.status === 'waiting'; }), done = all.filter(function (t) { return !tLive(t) && t.status !== 'waiting'; });
      function row(t) {
        var b = h('button', 'xc-tl-i'); b.type = 'button'; b.dataset.tsid = t.sid;
        b.appendChild(h('b', '', t.title));
        var m = h('span', 'xc-tl-m'); m.appendChild(h('span', 'xc-task-st st-' + t.status, tStatText(t)));
        m.appendChild(document.createTextNode([TKIND[t.kind]].filter(Boolean).join(' · ')));
        b.appendChild(m);
        var from = t.parent && titles[t.parent];
        if (from) b.appendChild(h('span', 'xc-tl-from', '在「' + from + '」里提到的'));
        b.addEventListener('click', function () { openTask(t.sid); });
        return b;
      }
      function sec(name, arr) { if (!arr.length) return; sessEl.appendChild(h('p', 'xc-set-h xc-tv-h', name)); arr.forEach(function (t) { sessEl.appendChild(row(t)); }); }
      sec('还没做完的', live);
      sec('最近的', done.slice(0, 30));
      if (!all.length) sessEl.appendChild(h('p', 'xc-hint', '我还没开始做事。'));
      // 每日任务
      var dl = d.daily && d.daily.last, dst = h('p', 'xc-dailyst');
      dst.appendChild(document.createTextNode('最近一次：' + (dl && dl.date ? dl.date.slice(5) + ' ' + (dl.ok === null ? '进行中' : dl.ok ? '已完成' : '失败') : '还没做过') + '　'));
      if (dl && dl.sid) { var lk = h('button', 'xc-link xc-inl', '查看'); lk.type = 'button'; lk.addEventListener('click', function () { openSession(dl.sid); }); dst.appendChild(lk); }
      sessEl.appendChild(h('p', 'xc-set-h xc-tv-h', '每日任务'));
      sessEl.appendChild(dst);
      // 各模型最近 14 天
      var st = (d.stats || []).filter(function (x) { return x.n > 0; });
      if (S.sessAgent === 'harness' && st.length) {
        sessEl.appendChild(h('p', 'xc-set-h xc-tv-h', '各模型最近 14 天'));
        var ul = h('ul', 'xc-tv-st');
        st.forEach(function (x) {
          var li = h('li');
          li.appendChild(h('b', '', modelName(x.model) + (x.agent === 'harness' ? '（天启）' : '')));
          li.appendChild(h('span', '', '用了 ' + x.n + ' 次，成了 ' + x.ok + ' 次' + (x.avgMs ? '，平均 ' + dur(x.avgMs) : '') + (x.fellBack ? '，换过 ' + x.fellBack + ' 次模型' : '')));
          ul.appendChild(li);
        });
        sessEl.appendChild(ul);
      }
      sessEl.scrollTop = top;
      if (live.some(tLive)) S.tvTm = setTimeout(function () { if (S.view === 'tasks' && S.open) loadTasksView(); }, 5000);
    }).catch(function (e) { if (S.view !== 'tasks') return; sessEl.innerHTML = ''; sessEl.appendChild(backBtn(true)); sessEl.appendChild(h('p', 'xc-hint', '读取失败：' + e.message)); });
  }

  /* ---------- 每日任务：网站后台每天定时叫醒小芯的电脑，让它按这份清单做一遍 ---------- */
  function loadDaily() {
    if (TQ) return;
    S.view = 'daily'; render();
    sessEl.innerHTML = ''; sessEl.appendChild(h('p', 'xc-hint', '正在读取…'));
    call('daily_get', {}, 60000).then(function (d) {
      sessEl.innerHTML = '';
      sessEl.appendChild(backBtn(true));
      sessEl.appendChild(h('p', 'xc-hint', '每天 9:10 执行，失败时 21:10 重试。每行一项。'));
      if (d.last && d.last.date) {
        var st = h('p', 'xc-dailyst'), lk = h('button', 'xc-link xc-inl', '查看'); lk.type = 'button';
        st.appendChild(document.createTextNode('最近一次：' + d.last.date.slice(5) + ' ' + (d.last.ok === null ? '进行中' : d.last.ok ? '已完成' : '失败') + '　'));
        lk.addEventListener('click', function () { openSession(d.last.sid); });
        st.appendChild(lk); sessEl.appendChild(st);
      }
      var ta = h('textarea', 'xc-memt'); ta.value = d.text || ''; ta.placeholder = '比如：\n- 看看网关今天签到成没成，没成就补签，记下积分和连签天数'; ta.setAttribute('aria-label', '每日任务清单');
      sessEl.appendChild(ta);
      var row = h('div', 'xc-memrow'), save = h('button', 'xc-btn', '保存'), now = h('button', 'xc-btn xc-btn2', '立即执行'), msg = h('span', 'xc-hint', '');
      save.type = now.type = 'button';
      var saveIt = function () { return call('daily_set', { text: ta.value }, 60000); };
      save.addEventListener('click', function () {
        save.disabled = true; msg.textContent = '正在保存…';
        saveIt().then(function () { msg.textContent = '存好了'; save.disabled = false; }, function (e) { msg.textContent = '没存上：' + e.message; save.disabled = false; });
      });
      now.addEventListener('click', function () {
        if (!ta.value.trim()) { msg.textContent = '清单是空的'; return; }
        now.disabled = true; msg.textContent = '正在开始…';
        saveIt().then(function () { return call('daily', { force: true }, 90000); }).then(function (r) {
          now.disabled = false;
          if (r.sid) { openSession(r.sid); var x = xin(); if (x) x.ai('think'); } else msg.textContent = r.skipped === 'running' ? '正在做着呢' : '没开始：' + (r.msg || r.skipped || '');
        }, function (e) { now.disabled = false; msg.textContent = '没开始：' + e.message; });
      });
      row.appendChild(save); row.appendChild(now); row.appendChild(msg); sessEl.appendChild(row);
    }, function (e) { sessEl.innerHTML = ''; sessEl.appendChild(h('p', 'xc-hint', '读取失败：' + e.message)); });
  }
  /* ---------- 小芯的记忆：它记住的关于你、你的学习和一起做的事。看出处，确认、改、设隐私、忘掉 ----------
     只有你说过或确认过的才当真；它观察到的、猜的、后台任务记的和以前记事本里的先放在「待确认」。 */
  var MEM_TYPES = { profile: '关于你', learning: '学习', project: '在做的事', procedure: '做事方法', self: '小芯自己', unsorted: '旧记事本' };
  var MEM_BASIS = { stated: '你说的', observed: '它观察到的', inferred: '它猜的', legacy: '以前的记事本' };
  function loadMemory(note) {
    if (TQ) return;
    S.view = 'mem'; render();
    sessEl.innerHTML = ''; sessEl.appendChild(h('p', 'xc-hint', '正在读取…'));
    call('memory_list', {}, 60000).then(function (d) {
      if (S.view !== 'mem') return;
      sessEl.innerHTML = '';
      sessEl.appendChild(backBtn(true));
      var add = h('form', 'xm-add'), inp = h('input', 'xm-in'), sel = h('select', 'xm-sel'), btn = h('button', 'xc-btn', '记住');
      inp.type = 'text'; inp.maxLength = 300; inp.placeholder = '让小芯记住…（比如：讲代码先给结论）'; inp.setAttribute('aria-label', '让小芯记住的事');
      sel.setAttribute('aria-label', '类型');
      ['profile', 'learning', 'project', 'self'].forEach(function (k) { var o = h('option', '', MEM_TYPES[k]); o.value = k; sel.appendChild(o); });
      btn.type = 'submit';
      add.appendChild(inp); add.appendChild(sel); add.appendChild(btn);
      var msg = h('p', 'xm-msg', note || ''); msg.setAttribute('role', 'status');
      add.addEventListener('submit', function (e) {
        e.preventDefault();
        if (!inp.value.trim()) { inp.focus(); return; }
        btn.disabled = true; msg.textContent = '正在记…';
        call('memory_add', { content: inp.value, type: sel.value }, 60000).then(function (r) {
          if (r && r.error) { btn.disabled = false; msg.textContent = r.msg || '没记上'; return; }
          var x = xin(); if (x) x.say('记住啦～', 2500);
          loadMemory(r && r.duplicate ? '这件事已经记着了' : '记住了');
        }, function (e2) { btn.disabled = false; msg.textContent = '没记上：' + e2.message; });
      });
      sessEl.appendChild(add); sessEl.appendChild(msg);
      var items = d.items || [], titles = d.titles || {};
      if (!items.length) sessEl.appendChild(h('p', 'xc-hint xm-empty', '还没有记住什么。聊天时你说「记住……」，或者在上面直接写。'));
      var section = function (title, list, cls) {
        if (!list.length) return;
        var sec = h('section', 'xm-sec' + (cls ? ' ' + cls : ''));
        sec.appendChild(h('h3', 'xm-h', title + '（' + list.length + '）'));
        var ul = h('ul', 'xm-list');
        list.forEach(function (it) { ul.appendChild(memItem(it, titles, msg)); });
        sec.appendChild(ul); sessEl.appendChild(sec);
      };
      section('待确认', items.filter(function (it) { return it.status === 'pending'; }), 'pend');
      ['profile', 'learning', 'project', 'procedure', 'self', 'unsorted'].forEach(function (k) {
        section(MEM_TYPES[k], items.filter(function (it) { return it.status === 'active' && it.type === k; }));
      });
      section('隐私（不主动提起）', items.filter(function (it) { return it.status === 'private'; }), 'priv');
    }, function (e) { if (S.view !== 'mem') return; sessEl.innerHTML = ''; sessEl.appendChild(backBtn(true)); sessEl.appendChild(h('p', 'xc-hint', '读取失败：' + e.message)); });
  }
  function memItem(it, titles, msg) {
    var li = h('li', 'xm-it'), txt = h('p', 'xm-txt', it.content), meta = h('p', 'xm-meta');
    li.appendChild(txt);
    meta.appendChild(h('span', 'xm-tag', MEM_BASIS[it.basis] || it.basis));
    if (it.status === 'pending' && it.type !== 'unsorted') meta.appendChild(h('span', 'xm-tag', MEM_TYPES[it.type] || it.type));
    var ev = (it.evidence || [])[0];
    if(ev && /^\/tools\/stm32\/\?/.test(ev.url||'')){
      var study=h('a','xc-link xm-src','来自「'+ev.title+'」');study.href=ev.url;meta.appendChild(study);
    } else if (ev && ev.sid && Object.prototype.hasOwnProperty.call(titles, ev.sid) && titles[ev.sid].indexOf('后台任务：') !== 0) {
      var a = h('button', 'xc-link xm-src', '来自「' + (titles[ev.sid] || '一段对话') + '」'); a.type = 'button';
      a.addEventListener('click', function () { openSession(ev.sid); });
      meta.appendChild(a);
    } else if (ev) meta.appendChild(h('span', 'xm-when', when(ev.at) + (ev.sid ? (titles[ev.sid] ? ' · ' + titles[ev.sid] : ' · 原对话已删除') : '')));
    else meta.appendChild(h('span', 'xm-when', when(it.updated)));
    li.appendChild(meta);
    if (ev && ev.quote && ev.quote !== it.content) li.appendChild(h('p', 'xm-quote', '“' + ev.quote.slice(0, 120) + (ev.quote.length > 120 ? '…' : '') + '”'));
    var acts = h('div', 'xm-acts');
    var act = function (label, cls, fn) { var b = h('button', 'xm-b' + (cls ? ' ' + cls : ''), label); b.type = 'button'; b.addEventListener('click', function () { fn(b); }); acts.appendChild(b); return b; };
    var send = function (args, done, b) {
      if (b) b.disabled = true;
      return call('memory_update', Object.assign({ id: it.id }, args), 60000).then(function (r) {
        if (r && r.error) { if (b) b.disabled = false; msg.textContent = r.msg || '修改失败'; return; }
        loadMemory(done);
      }, function (e) { if (b) b.disabled = false; msg.textContent = '修改失败：' + e.message; });
    };
    if (it.status === 'pending') act('对，记住', 'ok', function (b) { send({ confirm: true }, '确认了', b); });
    act('改', '', function () {
      var ta = h('textarea', 'xm-edit'); ta.value = it.content; ta.maxLength = 300; ta.setAttribute('aria-label', '改这条记忆');
      var row = h('div', 'xm-acts'), save = h('button', 'xm-b ok', '保存'), cancel = h('button', 'xm-b', '取消');
      save.type = cancel.type = 'button';
      save.addEventListener('click', function () { send({ content: ta.value }, '改好了', save); });
      cancel.addEventListener('click', function () { loadMemory(); });
      row.appendChild(save); row.appendChild(cancel);
      li.replaceChild(ta, txt); li.replaceChild(row, acts);
      ta.focus();
    });
    act(it.status === 'private' ? '取消隐私' : '设为隐私', '', function (b) { send({ private: it.status !== 'private' }, it.status === 'private' ? '小芯又可以用这条了' : '设为隐私了：小芯不会主动提起', b); });
    act('忘掉', 'bad', function (b) {
      if (!b.classList.contains('sure')) { b.classList.add('sure'); b.textContent = '确定忘掉？'; setTimeout(function () { b.classList.remove('sure'); b.textContent = '忘掉'; }, 4000); return; }
      b.disabled = true;
      call('memory_forget', { id: it.id }, 60000).then(function (r) {
        if (r && r.error) { b.disabled = false; msg.textContent = r.msg || '没忘掉'; return; }
        loadMemory('忘掉了，以后也不会再从聊天里记回来');
      }, function (e) { b.disabled = false; msg.textContent = '没忘掉：' + e.message; });
    });
    li.appendChild(acts);
    return li;
  }
  // 侧边栏右边那列时间：今天写钟点，昨天写「昨天」，今年写 月/日，更早写 年/月/日
  function shortWhen(t) {
    if (!t) return '';
    var d = new Date(t), now = new Date(), p = function (n) { return (n < 10 ? '0' : '') + n; }, y = new Date(now); y.setDate(now.getDate() - 1);
    if (d.toDateString() === now.toDateString()) return p(d.getHours()) + ':' + p(d.getMinutes());
    if (d.toDateString() === y.toDateString()) return '昨天';
    return (d.getFullYear() === now.getFullYear() ? '' : d.getFullYear() + '/') + (d.getMonth() + 1) + '/' + d.getDate();
  }
  function when(t) {
    var d = new Date(t), now = new Date(), p = function (n) { return (n < 10 ? '0' : '') + n; };
    var hm = p(d.getHours()) + ':' + p(d.getMinutes());
    if (d.toDateString() === now.toDateString()) return '今天 ' + hm;
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + hm;
  }

  /* ---------- 模型和思考强度 ----------
     模型列表与带名称的强度档位放在同一块紧凑面板。模型、档位都支持键盘选择；
     关闭时恢复焦点，输入时收起，窗口或软键盘变化时限制面板高度。
     Harness（天启模式）记住自己选的模型，已有对话恢复自己的选择。Claude 沿用原有命令行配置。
     Codex（默认模式）不让选：按钮写「自动 · 最高」，点开只说明小芯怎么挑模型、上一句用的是谁。 */
  var LEVELS = { off: '关', low: '低', medium: '中', high: '高', xhigh: '超高', max: '最高' };
  // 每档一句（参考 OpenAI Codex 的 codex-rs/models-manager/models.json：supported_reasoning_levels 里每档 effort 配一句 description）
  var EFF_DESC = { off: '不思考，直接回复', low: '思考较少，回复更快', medium: '兼顾速度和深度', high: '思考更深，适合复杂问题', xhigh: '深度思考，适合很复杂的问题', max: '思考最深，适合最难的问题' };
  // 思考强度的像素格：「关」以外每档一格、从矮到高，亮到当前那一档（关 = 一格都不亮）；档位名藏着给读屏
  function effMeter(sp, e, cls) {
    var lv = sp.efforts.filter(function (x) { return x !== 'off'; }), m = h('i', 'xc-em' + (cls ? ' ' + cls : ''));
    lv.forEach(function (x, i) { var b = h('b'); b.style.setProperty('--h', (i + 1) / lv.length); m.appendChild(b); });
    m.appendChild(h('span', 'xc-vh', ''));
    paintMeter(m, sp, e);
    return m;
  }
  function paintMeter(m, sp, e) {
    var lv = sp.efforts.filter(function (x) { return x !== 'off'; }), k = lv.indexOf(e) + 1, was = m.dataset.lv == null ? k : +m.dataset.lv;
    m.dataset.lv = k;
    [].forEach.call(m.querySelectorAll('b'), function (b, i) {
      // 逐格：往上加从矮到高一格一格亮，往下减从高到矮一格一格灭
      b.style.transitionDelay = (k > was ? Math.max(0, i - was) : Math.max(0, was - 1 - i)) * 45 + 'ms';
      b.classList.toggle('on', i < k);
    });
    m.lastChild.textContent = LEVELS[e];
  }
  var SPECS = {
    harness: { name: 'DeepSeek V4.1 Flash', efforts: ['off', 'low', 'high', 'max'] },
    claude: { name: 'Claude', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] }
  };
  function curAgent() { return S.sid ? (S.sessAgent || S.agent) : S.agent; }
  function curModel() { return curAgent() === 'harness' ? S.hModel : undefined; }
  function curSpec() {
    var a = curAgent();
    if (a === 'codex') return { agent: 'codex', auto: true, name: '自动', model: undefined, efforts: ['max'], models: null };
    var sp = SPECS[a] || SPECS.claude, models = a === 'harness' ? HM_MODELS : null, model = curModel();
    return { agent: a, name: models ? models[model] : sp.name, model: model, efforts: models ? (model === 'deepseek-v4.1-flash' ? ['off', 'low', 'high', 'max'] : ['low', 'high', 'max']) : sp.efforts, models: models };
  }
  function curEffort() { var sp = curSpec(); return sp.auto ? 'max' : sp.efforts.indexOf(S.effort) >= 0 ? S.effort : 'high'; }
  function pickKey() { return curAgent() + '|' + (curModel() || '') + '|' + (curAgent() === 'codex' ? S.lastModel : ''); }
  function renderPick() {
    if (!mdlBtn) return;
    var sp = curSpec(), e = LEVELS[curEffort()];
    // 默认模式没有可选的（一直是「自动 最高」），按钮不放（站长 2026-11-11）；天启模式才有模型和思考强度可选
    mdlBtn.hidden = !!sp.auto;
    if (sp.auto) { if (pickEl && !pickEl.hidden) setPick(false); return; }
    var t = mdlBtn.firstChild; t.textContent = sp.name; t.appendChild(effMeter(sp, curEffort()));
    mdlBtn.classList.toggle('tq', sp.agent === 'harness');
    mdlBtn.setAttribute('aria-label', sp.auto ? '模型：小芯自己安排' : '模型和思考强度：' + sp.name + ' ' + e);
    if (!pickEl.hidden) { if (pickEl.dataset.k !== pickKey()) buildPick(); else paintEff(); }
  }
  function fitPick() {
    if (!pickEl || pickEl.hidden) return;
    var available = root.clientHeight - foot.offsetHeight - 68;
    if (TQ) {
      var bounds = foot.getBoundingClientRect(), below = root.clientHeight - bounds.bottom - 16, above = bounds.top - 16;
      var up = below < 190 && above > below;
      pickEl.classList.toggle('tq-pick-up', up);
      available = up ? above : below;
    }
    pickEl.style.maxHeight = Math.min(360, Math.max(96, available)) + 'px';
  }
  function setPick(on, restoreFocus) {
    if (!pickEl) return;
    pickEl.hidden = !on;
    mdlBtn.setAttribute('aria-expanded', on ? 'true' : 'false');
    if (on) {
      buildPick(); fitPick();
      requestAnimationFrame(function () { if (!pickEl.hidden) { var b = pickEl.querySelector('[aria-checked="true"]') || pickEl.querySelector('.xc-pk-close'); if (b) b.focus({ preventScroll: true }); } });
    } else if (restoreFocus) mdlBtn.focus({ preventScroll: true });
  }
  function buildPick() {
    var sp = curSpec();
    pickEl.textContent = ''; pickEl.dataset.k = pickKey();
    var hd = h('div', 'xc-pk-hd'), title = h('div', 'xc-pk-heading');
    title.appendChild(h('b', '', sp.auto ? '工作方式' : '模型与思考')); title.appendChild(h('span', 'xc-pk-agent', sp.auto ? '小芯' : sp.agent === 'harness' ? '天启' : AGENTS[sp.agent]));
    pickEl.classList.toggle('tq', sp.agent === 'harness');
    var close = h('button', 'xc-pk-close'); close.type = 'button'; close.setAttribute('aria-label', '关闭模型设置'); close.innerHTML = svgIcon('x');
    close.addEventListener('click', function () { setPick(false, true); });
    hd.appendChild(title); hd.appendChild(close); pickEl.appendChild(hd);
    // 默认模式：不让选，只说明小芯怎么挑、有哪几个模型、上一句用的是谁
    if (sp.auto) {
      var box = h('div', 'xc-pk-auto');
      box.appendChild(h('p', '', '用哪个模型、想多久，我自己安排。'));
      box.appendChild(h('p', 'xc-pk-tip', '想自己选，到设置里打开天启模式。'));
      pickEl.appendChild(box); fitPick();
      return;
    }
    if (sp.models) {
      var g = h('div', 'xc-pk-g'); g.dataset.g = 'model';
      g.setAttribute('role', 'radiogroup'); g.setAttribute('aria-label', '模型');
      function choose(k) {
        S.hModel = k; ls(LS_HM, k);
        renderPick();
        var b = pickEl.querySelector('.xc-pk-o[data-v="' + k + '"]'); if (b) b.focus({ preventScroll: true });
      }
      Object.keys(sp.models).forEach(function (k) {
        var b = h('button', 'xc-pk-o'); b.type = 'button'; b.setAttribute('role', 'radio'); b.dataset.v = k;
        b.setAttribute('aria-checked', k === sp.model ? 'true' : 'false'); b.tabIndex = k === sp.model ? 0 : -1;
        b.appendChild(h('span', '', sp.models[k]));
        b.insertAdjacentHTML('beforeend', '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>');
        b.addEventListener('click', function () { choose(k); });
        g.appendChild(b);
      });
      pickEl.appendChild(g);
      g.addEventListener('keydown', function (ev) {
        var keys = Object.keys(sp.models), i = keys.indexOf(curModel()), next = ev.key === 'Home' ? 0 : ev.key === 'End' ? keys.length - 1 : ev.key === 'ArrowDown' || ev.key === 'ArrowRight' ? Math.min(keys.length - 1, i + 1) : ev.key === 'ArrowUp' || ev.key === 'ArrowLeft' ? Math.max(0, i - 1) : -1;
        if (next >= 0) { ev.preventDefault(); choose(keys[next]); }
      });
    }
    var t = h('div', 'xc-pk-t'), tv = h('span', 'xc-pk-tv'); t.appendChild(h('b', '', '思考强度'));
    tv.appendChild(effMeter(sp, curEffort(), 'big')); tv.appendChild(h('i', 'xc-pk-tl', LEVELS[curEffort()])); t.appendChild(tv);
    pickEl.appendChild(t);
    // 档位直接写出名称；支持点击、拖动和方向键，不用猜圆点代表哪一档。
    var n = sp.efforts.length, tr = h('div', 'xc-eff');
    tr.setAttribute('role', 'radiogroup'); tr.setAttribute('aria-label', '思考强度');
    tr.style.setProperty('--n', n);
    var th = h('i', 'xc-eff-th'); th.setAttribute('aria-hidden', 'true'); tr.appendChild(th);   // 跟着档位滑过去的那块底（弹簧）
    sp.efforts.forEach(function (lv) {
      var b = h('button', 'xc-eff-d'); b.type = 'button'; b.setAttribute('role', 'radio'); b.dataset.v = lv; b.setAttribute('aria-label', LEVELS[lv]);
      b.textContent = LEVELS[lv];
      b.addEventListener('click', function () { setEffort(lv); });
      tr.appendChild(b);
    });
    function at(x) { var r = tr.getBoundingClientRect(); return sp.efforts[Math.max(0, Math.min(n - 1, Math.floor((x - r.left) / r.width * n)))]; }
    var drag = false;
    tr.addEventListener('pointerdown', function (ev) { if (ev.button !== 0) return; drag = true; try { tr.setPointerCapture(ev.pointerId); } catch (er) { /* 不支持就算了 */ } setEffort(at(ev.clientX)); });
    tr.addEventListener('pointermove', function (ev) { if (drag) setEffort(at(ev.clientX)); });
    tr.addEventListener('pointerup', function () { drag = false; });
    tr.addEventListener('pointercancel', function () { drag = false; });
    tr.addEventListener('keydown', function (ev) {
      var k = sp.efforts.indexOf(curEffort()), d = ev.key === 'ArrowRight' || ev.key === 'ArrowUp' ? 1 : ev.key === 'ArrowLeft' || ev.key === 'ArrowDown' ? -1 : 0;
      if (!d && ev.key !== 'Home' && ev.key !== 'End') return;
      ev.preventDefault();
      var lv = sp.efforts[ev.key === 'Home' ? 0 : ev.key === 'End' ? n - 1 : Math.max(0, Math.min(n - 1, k + d))]; setEffort(lv);
      var f = tr.querySelector('[data-v="' + lv + '"]'); if (f) f.focus();
    });
    pickEl.appendChild(tr);
    var hp = h('p', 'xc-eff-hp'), hw = h('span', 'xc-sw-w'); hw.appendChild(h('span', 'xc-eff-help')); hp.appendChild(hw); pickEl.appendChild(hp);
    paintEff();
    fitPick();
  }
  function setEffort(lv) {
    if (lv === curEffort() && S.effort === lv) return;
    S.effort = lv; ls(LS_EFF, lv); renderPick();
  }
  // 滑块和标题跟着当前档位走（原地改，不重画：拖的时候不断）
  function paintEff() {
    var tr = pickEl.querySelector('.xc-eff'); if (!tr) return;
    var sp = curSpec(), e = curEffort(), k = sp.efforts.indexOf(e), n = sp.efforts.length;
    [].forEach.call(tr.querySelectorAll('.xc-eff-d'), function (b, i) {
      b.classList.toggle('on', i === k); b.classList.toggle('in', i < k);
      b.setAttribute('aria-checked', i === k ? 'true' : 'false'); b.tabIndex = i === k ? 0 : -1;
    });
    tr.style.setProperty('--k', k);
    var m = pickEl.querySelector('.xc-pk-t .xc-em'); if (m) paintMeter(m, sp, e);
    var t = pickEl.querySelector('.xc-pk-tl'); if (t) t.textContent = LEVELS[e];
    var help = pickEl.querySelector('.xc-eff-help'); if (help) swapText(help, EFF_DESC[e] || '');
  }

  /* ---------- 后台任务（分身） ----------
     默认模式下，前台的小芯把要花时间的活派给分身在后台做，你可以接着聊：
     - 聊天里不放任务卡片（站长 2026-11-11），任务在工作台里看；输入框上面一条「在做 N 件事」，点开是任务列表。
     - 做完（或者在等你确认）时，聊天最后小芯说一条结果；你不在看这个对话时页面上的小芯冒个气泡（关着网页就推送，vm-agent 发）。
     - 「详情」：一页里看它每一步说的话、执行的命令和结果；在做的能改要求、能停，做完的、停了的能补充后继续，等确认的直接回复。
     状态靠轮询 tasks：看着有任务在做的对话时 4 秒一次，别的时候有任务在做 20 秒一次，没有就不轮询。 */
  var TSTAT = { queued: '排队中', running: '进行中', stopping: '停止中', waiting: '待处理', done: '已完成', failed: '失败', stopped: '已停止' };
  var TKIND = { quick: '杂活', code: '写代码', research: '查资料', hard: '难题', vision: '看图', review: '检查', daily: '每日任务', system: '电脑维护' };
  var TICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3.2"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/></svg>';
  S.tinfo = {}; S.tactive = []; S.bg = 0; S.queue = [];
  function tLive(t) { return t.status === 'queued' || t.status === 'running' || t.status === 'stopping'; }
  // 后台做完、前台还在写总结（delivery 还是 pending）也算在做：框到话说出来才停（站长 2026-11-18「即使做完了，也要等下面的话发出来才结束」）。
  // 转达卡住的：结束 10 分钟后不再算在做，免得框一直转
  function tBusy(t) { return tLive(t) || !!(t.delivery && t.delivery.state === 'pending' && Date.now() - (t.endedAt || 0) < 600000); }
  // 用时算到话说出来（delivery.at）；没有转达的算到任务结束
  function endAt(t) { var d = t.delivery; return d && (d.state === 'delivered' || d.state === 'silent') && d.at ? d.at : t.endedAt; }
  // 一条消息的分组：派活那一轮，和它派出去的活的框、结果（站长 2026-11-18「这个整体只能算一段话」）。找不到派活那一轮的自成一组
  var TDISP = {};
  function tgrp(sid) { return TDISP[sid] || 'task-' + sid; }
  function grpOf(e) { return e.dataset.grp || e.dataset.run || ''; }
  // 待处理最多等 30 分钟（控制器给 waitUntil），过了任务自己停下；这里显示还剩多久
  function waitLeft(t) { return t.status === 'waiting' && t.waitUntil ? '剩 ' + Math.max(1, Math.ceil((t.waitUntil - Date.now()) / 60000)) + ' 分钟' : ''; }
  // 待处理的三种：登录、审批（要批准的操作、写回）、回复（问题）
  function waitAction(t) { return t.browserStep ? '登录' : t.approval && t.approval.kind !== 'input' ? '审批' : '回复'; }
  function stopLine(t) { return t.expired ? '已停止：等待超时' : '已停止'; }
  function dur(ms) { var s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? s + ' 秒' : s < 3600 ? Math.round(s / 60) + ' 分钟' : (s / 3600).toFixed(1).replace(/\.0$/, '') + ' 小时'; }
  function bareCmd(d) { var m = /^\/(?:usr\/)?bin\/(?:ba)?sh -l?c (['"])([\s\S]*)\1$/.exec(String(d || '').trim()); return m ? m[2] : String(d || ''); }
  function tStatText(t) {
    if (t.status === 'running') return '已进行 ' + dur(Date.now() - (t.startedAt || t.created || Date.now()));
    if (t.status === 'queued') return t.retryAt > Date.now() ? '连接出错，稍后重试' : t.after && t.after.length ? '等待前一项' : '排队中';
    return TSTAT[t.status] || t.status;
  }
  function tLine(t) {
    if (t.status === 'running') return t.activity || '准备中';
    if (t.status === 'waiting') return t.question || '';
    if (t.result) return firstLine(t.result.text) || t.result.err || '';
    return '';
  }
  function taskCard(ev) {
    var e = h('div', 'xc-task'); e.dataset.tsid = ev.sid;
    paintCard(e, S.tinfo[ev.sid] || ev);
    return e;
  }
  function paintCard(e, t) {
    e.className = 'xc-task st-' + t.status; e.innerHTML = '';
    var hd = h('div', 'xc-task-h'); hd.innerHTML = TICON; hd.appendChild(h('b', '', t.title)); e.appendChild(hd);
    var st = h('div', 'xc-task-s');
    st.appendChild(h('span', 'xc-task-st', tStatText(t)));
    st.appendChild(h('span', 'xc-task-m', [TKIND[t.kind]].filter(Boolean).join(' · ')));
    e.appendChild(st);
    var line = tLine(t); if (line) e.appendChild(h('div', 'xc-task-a', line));
    var ft = h('div', 'xc-task-b');
    var v = h('button', 'xc-task-btn', t.status === 'waiting' ? waitAction(t) : '查看详情'); v.type = 'button';
    v.addEventListener('click', function () { openTask(t.sid); });
    ft.appendChild(v);
    var preview=previewLink(t);if(preview)ft.appendChild(preview);
    // 还在做：随时能改要求（点开直接写）、能停
    if (tLive(t) && t.status !== 'stopping') { var c = h('button', 'xc-task-btn xc-task-tell', '修改'); c.type = 'button'; c.addEventListener('click', function () { openTask(t.sid, true); }); ft.appendChild(c); }
    if (tLive(t)) { var x = h('button', 'xc-task-btn', '停止'); x.type = 'button'; x.addEventListener('click', function () { stopTask(t.sid, x); }); ft.appendChild(x); }
    e.appendChild(ft);
  }
  function previewLink(t){
    if(!t.preview||!t.preview.ready||!/^\/xin\/preview\.html\?id=[a-f0-9]{32}$/.test(t.preview.url||''))return null;
    var a=h('a','xc-task-btn xc-preview','打开网页');a.href=t.preview.url;a.target='_blank';a.rel='noopener';return a;
  }
  function paintCards() { if (list) [].forEach.call(list.querySelectorAll('.xc-task'), function (e) { var t = S.tinfo[e.dataset.tsid]; if (t) paintCard(e, t); }); }
  // 结果：做完 / 没做成 / 停了 / 在等你确认时，小芯在聊天里说一条（同一次结果只说一次）。
  // 站长 2026-11-16：问题的答案直接说在聊天里，不要卡片——和别的回答一样是一条消息（能复制），下面一行小操作
  function resKey(t) { return t.sid + '@' + (t.status === 'waiting' ? 'w' + (t.endedAt || '') : (t.result && t.result.at) || t.endedAt || ''); }
  function drawTaskResult(t, fresh) {
    if(t.delivery&&['pending','silent','continued'].includes(t.delivery.state))return null;
    var key = resKey(t);
    if (list.querySelector('[data-tres="' + key + '"]')) return null;
    var text = t.status === 'waiting' ? '我需要你确认一下：' + (t.question || '待处理') : (t.result && t.result.text) || (t.status === 'done' ? '我做好了：' + t.title + '。' : '这次还没有完成。');
    var m = placeResult(t.sid, t, text, t.status === 'failed' || t.status === 'stopped' ? 'tbad' : '', fresh);
    m.e.dataset.tres = key;
    if (t.status === 'failed' && t.result && t.result.err && text.indexOf(t.result.err) < 0) m.b.appendChild(h('p', 'xc-tres-err', t.result.err));
    return m.e;
  }
  // 整条消息最后一行操作，挂在这件活的框那一条下面：要你处理时一个主按钮（审批 / 回复 / 登录），复制整条，网页成品「打开网页」。
  // 没有「详情」：站长 2026-11-18「那个详情我觉得没必要兄弟，我点终端就已经可以看到了」
  function boxActs(w, t) {
    var old = w.querySelector(':scope > .xc-acts'); if (old) old.remove();
    msgActs(w, ''); w._md = '';
    var a = w.querySelector(':scope > .xc-acts');
    if (t.status === 'waiting') { var wb = h('button', 'xc-tact on', waitAction(t)); wb.type = 'button'; wb.addEventListener('click', function () { openTask(t.sid); }); a.insertBefore(wb, a.firstChild); }
    // 正文里已经链到同一个网页（控制器写的「我画好了。打开网页」）就不再放一颗：站长 2026-11-16「打开网页和打开预览其实重复了」
    var pv = previewLink(t), same = pv && [].some.call(list.querySelectorAll('.xc-tres[data-tsid="' + String(t.sid).replace(/["\\]/g, '') + '"] .xc-bub a[href]'), function (x) { return x.getAttribute('href') === t.preview.url; });
    if (pv && !same) { pv.className = 'xc-tact pv xc-preview'; a.appendChild(pv); }
  }
  /* ---------- 小芯的电脑（终端窗口，画法在 term.js）----------
     站长 2026-11-16：「终端是我点击小芯聊天里的头像弹出来的」。点开看它那一次在电脑上做了什么：
     - 「正在输入」那一行、后台有活在做时最下面那一行的头像：现在正在做的（这一轮，加上这个对话里还没做完的活，多件就分页）；
     - 一条回答的头像：那一轮在电脑上做的，那一轮派出去的活各一页；任务结果的头像：那件活。
     头像右下角有个像素小终端标记的才点得开（有东西可看），正在干活时它在闪。
     后台的活只在窗口开着、正看那一页时才去取：按任务摘要里的轮次编号（run）轮询 poll，不带设备和标签页（不算在看这个对话、
     不影响完成通知）；取到的存着，再打开从存着的地方接着取。已经做完的活，点开才去取它的完整记录（history）。 */
  var TW = null, boxTk = 0;
  function termReset() {
    Object.keys(S.tf || {}).forEach(function (k) { clearTimeout(S.tf[k].tm); });
    S.runEv = {}; S.runMeta = {}; S.tf = {};
    if (TW && TW.isOpen()) TW.close(false);
    clearInterval(boxTk); boxTk = 0;
  }
  function termLine(ev) { return !!(window.LimingXinTerm && LimingXinTerm.line(ev)); }
  // 记下这一轮在电脑上做的事（历史和正在跑的都走 draw）；你说的那句是终端里「> 要求」那一行
  function termKeep(ev, run) {
    if (!run) return;
    var m = S.runMeta[run] = S.runMeta[run] || {};
    if (ev.t === 'user') { m.prompt = ev.text || ''; return; }
    if (ev.t === 'done') { m.ms = ev.ms; m.model = ev.model; return; }
    if (!/^(tool|tool_end|text|err|task|think)$/.test(ev.t)) return;
    var a = S.runEv[run] = S.runEv[run] || [];
    if (a.length < 600) a.push(ev);
  }
  function runTools(run) { return (S.runEv[run] || []).some(function (e) { return (e.t === 'tool' || e.t === 'tool_end') && termLine(e); }); }
  function runTasks(run) { return (S.runEv[run] || []).filter(function (e) { return e.t === 'task'; }).map(function (e) { return e.sid; }); }
  /* ---------- 框：聊天里能点开终端的地方 ----------
     站长 2026-11-16：「终端小标没去掉……不需要这个小标，你不是做了个框框把思考中框住了么，我点那个就可以打开终端就行」，
     「我让他干的这个活不要让他分成两个独立的话来答，可以弄成他要去画那段话下面搞一个框框加载，显示思考过程的话，左边不要显示头像，然后点开这个加载框可以看到终端」。
     - 「思考中」那一条（前台这一轮）整条是按钮；
     - 派出去的活：那段话下面一个框（不画头像），在做时两行（任务名 / 此刻那一步 + 秒数），做完收成一行（✓ 任务名 · 用时）；结果接在这一轮后面，不另起一条；
     - 前台跑过命令的一轮：回答下面一行「用时 9 秒 · 运行 2 条命令」（和终端结尾同一句）。
     整块是按钮，里面的字不接指针（CSS）：字一直在换，点击不能落在会被换掉的元素上（照 open-webui 的 StatusHistory：一层按钮盖住、内容 pointer-events-none） */
  function termBtn(el, ctx, label) { el.dataset.term = ctx; el.setAttribute('role', 'button'); el.tabIndex = 0; el.setAttribute('aria-label', label); }
  function runSel(run) { return '.xc-ai[data-run="' + String(run || '').replace(/["\\]/g, '') + '"]'; }
  // 这一轮小芯说的最后一条（不算「思考中」、转达的结果、出错那一条）
  function runLast(run) {
    var all = list.querySelectorAll(runSel(run) + ':not(.xc-typing):not(.xc-tres):not(.bad)');
    return all.length ? all[all.length - 1] : null;
  }
  // 框放进这一轮最后说的那一条里（正文和下面那行操作之间）；还没说话就先占一条（xc-tbh），后面说的话填进它的正文，话还在框上面
  function boxHost(run) {
    var host = runLast(run);
    if (!host) { var m = aiMsg(run); m.e.classList.add('xc-tbh'); put(m.e); host = m.e; }
    return host;
  }
  function inHost(host, el) { host.insertBefore(el, host.querySelector(':scope > .xc-acts')); }
  var TB_ICON = { done: '<path d="m5.5 12.5 4 4 9-9.5"/>', failed: '<path d="m7 7 10 10M17 7 7 17"/>', stopped: '<path d="M8 8h8v8H8z"/>',
    waiting: '<path d="M9.6 9.4a2.5 2.5 0 1 1 3.4 2.4c-.6.3-1 .9-1 1.6v.5M12 17.4v.1"/>', proc: '<path d="M4.5 6h15v12h-15zM8 10l2.5 2L8 14M12.5 14.5h3.5"/>' };
  var TB_LEAD = { done: '已完成', failed: '失败', stopped: '已停止', waiting: '等待确认' };
  function tbIcon(k) { return '<svg class="xc-tb-i" viewBox="0 0 24 24" aria-hidden="true">' + TB_ICON[k] + '</svg>'; }
  function durText(ms) { return window.LimingXinTerm ? LimingXinTerm.dur(ms) : Math.round(ms / 1000) + ' 秒'; }
  /* 站长 2026-11-17：「图一的那个要跟着相应的最新对话下面，不然我还得翻上去找着看」——框不再塞进派活那条回答里，
     单独一条（.xc-tbw，不画头像，和结果那条同一种排法）：在做的（带 dock）一直在聊天最底下，新消息和「思考中」插在它上面；
     做完、没做成、停了、等你确认：落到这时候聊天的最后，结果接在它下面；又接着做就回到最底下。刷新以后在做的照样在最底下，
     做完的按结束时间排在各轮之间（openSession）。设计 docs/superpowers/specs/2026-11-17-xin-term-follow-design.md */
  // 站长 2026-11-19：派出新活、活做完时小芯岛鼓一下、亮一圈往外扩的光（像灵动岛来通知）
  function isleBump() {
    var i = root && root.querySelector('.xc-isle'); if (!i || reduceMotion()) return;
    i.classList.remove('bump'); void i.offsetWidth; i.classList.add('bump');
    clearTimeout(i._bt); i._bt = setTimeout(function () { i.classList.remove('bump'); }, 900);
  }
  // 站长 2026-11-19：亲眼看着做完的那一下 ✓ 盖章、迸几颗像素火花（刷新、翻历史时不盖）
  function stampBox(b) {
    b.classList.add('stamp');
    for (var i = 0; i < 6; i++) { var sp = h('i', 'xc-spark'); sp.style.setProperty('--a', (i * 60 + 15) + 'deg'); b.appendChild(sp); }
    setTimeout(function () { [].forEach.call(b.querySelectorAll('.xc-spark'), function (x) { x.remove(); }); }, 800);
  }
  function boxWrap(sid) { return list.querySelector('.xc-tbw[data-tsid="' + String(sid).replace(/["\\]/g, '') + '"]'); }
  function dockBox(w) { w.classList.add('dock'); list.appendChild(w); }
  function settleBox(w) { w.classList.remove('dock'); w.remove(); put(w); }
  function taskBox(sid, fresh) {
    if (boxWrap(sid)) return null;
    var w = h('div', 'xc-m xc-ai cont xc-tbw'), b = h('div', 'xc-tb'), t = S.tinfo[sid];
    w.dataset.tsid = sid; w.dataset.run = 'tb-' + sid; w.dataset.grp = tgrp(sid); b.dataset.tsid = sid; w.appendChild(b);
    if (!t || tBusy(t)) dockBox(w); else put(w);
    paintBox(b);
    if (fresh) b.classList.add('enter');
    return w;
  }
  function paintBox(b) {
    var sid = b.dataset.tsid, t = S.tinfo[sid] || { status: 'queued' }, title = t.title || '后台的活', w = b.parentNode;
    // 在做 → 最底下；不在做 → 落下。结果先到落下的（held 记着那时的一轮）：任务摘要还说在做这一轮就不拉回去，换了新的一轮才回最底下
    if (w && w.classList && w.classList.contains('xc-tbw')) {
      if (!tBusy(t)) { delete w.dataset.held; if (w.classList.contains('dock')) settleBox(w); }
      else if (!w.classList.contains('dock') && w.dataset.held !== String(t.run || '')) { delete w.dataset.held; dockBox(w); }
    }
    if (tBusy(t)) {
      var oa = w && w.querySelector && w.querySelector(':scope > .xc-acts'); if (oa) oa.remove();   // 还没说完：不露操作行
      if (!b.classList.contains('live')) {
        b.className = 'xc-tb live'; b.removeAttribute('data-st');
        b.innerHTML = '<div class="xc-tb-tx"><b class="xc-tb-t"></b><span class="xc-tb-ln"><span class="xc-sw-w xc-tb-sw"><span class="xc-tb-s"></span></span><i class="xc-tb-sec"></i></span></div>' +
          '<div class="xc-tb-dots"><i></i><i></i><i></i></div>';   // 不叫 .xc-bub：那是回答正文的类名（正式站联调取最后一个 .xc-ai .xc-bub 当回答，#159 因此被回滚）
      }
      var verb = taskVerb(sid), sec = t.status === 'queued' || !t.startedAt ? 0 : Math.round((Date.now() - t.startedAt) / 1000);
      var te = b.querySelector('.xc-tb-t'); if (te.textContent !== title) te.textContent = title;
      swapText(b.querySelector('.xc-tb-s'), verb, sid + verb);
      b.querySelector('.xc-tb-sec').textContent = sec >= 1 ? secText(sec) : '';
      termBtn(b, 'task:' + sid, title + '，进行中，查看正在执行的步骤');
      return;
    }
    // 做完、没做成、停了、等你确认：收成一行（和终端结尾那行同一套词）
    var st = endState(t), ms = t.startedAt && endAt(t) ? endAt(t) - t.startedAt : null;
    var meta = st === 'done' ? (ms != null ? '用时 ' + durText(ms) : TB_LEAD.done) : TB_LEAD[st] + (st === 'failed' && ms != null ? ' · 用时 ' + durText(ms) : '');
    if (b.dataset.st !== st + '|' + meta + '|' + title) {
      var fold = b.classList.contains('live');
      b.className = 'xc-tb st-' + st + (fold ? ' fold' : ''); b.dataset.st = st + '|' + meta + '|' + title;
      b.innerHTML = tbIcon(st) + '<b class="xc-tb-t"></b><span class="xc-tb-m"></span>' + svgIcon('chev');
      if (fold && st === 'done' && !reduceMotion()) stampBox(b);
      b.querySelector('.xc-tb-t').textContent = title; b.querySelector('.xc-tb-m').textContent = meta;
      if (w && w.classList && w.classList.contains('xc-tbw')) boxActs(w, t);
    }
    termBtn(b, 'task:' + sid, title + '，' + TB_LEAD[st] + '，查看执行过程');
  }
  // 任务情况变了、每秒：在做的框跟着走（那一步、秒数），做完的收成一行；没有在做的就停下计时
  function paintBoxes() {
    if (!list) return;
    var any = false;
    [].forEach.call(list.querySelectorAll('.xc-tb[data-tsid]'), function (b) { paintBox(b); if (b.classList.contains('live')) any = true; });
    if (any && !boxTk) boxTk = setInterval(paintBoxes, 1000);
    else if (!any && boxTk) { clearInterval(boxTk); boxTk = 0; }
  }
  // 前台跑过命令的一轮：回答下面一行，和终端结尾同一句（「用时 9 秒 · 运行 2 条命令」），点开看那一轮
  function procLine(run, ms) {
    if (!window.LimingXinTerm || !list || !run || !runTools(run)) return;
    var host = boxHost(run); if (host.querySelector(':scope > .xc-proc')) return;
    var text = LimingXinTerm.summary(LimingXinTerm.count(S.runEv[run] || []), null, ms != null ? ms : (S.runMeta[run] || {}).ms);
    var p = h('div', 'xc-tb xc-proc'); p.innerHTML = tbIcon('proc') + '<span class="xc-tb-t"></span>' + svgIcon('chev');
    p.querySelector('.xc-tb-t').textContent = text;
    termBtn(p, 'run:' + run, text + '，查看执行过程');
    inHost(host, p);
  }
  // 后台做完的结果放进那条消息：结果在框前面，框收成一行留在整条最下面，操作行在框下面（站长 2026-11-18「那个打开终端的…放在任务完成话的最下面」）。
  // 框还在最底下（结果比任务状态先到）就先落到这时候的最后；找不到框（太早的、别处派的）就补一个落下的框。
  // 前面紧挨着的是同一条消息（派活那句、这条里先说完的结果和框）就接着写、不画头像；中间插了别的话就另起一条，带头像
  function resultSlot(sid) {
    var w = boxWrap(sid) || taskBox(sid, false);
    if (w.classList.contains('dock')) { w.dataset.held = String((S.tinfo[sid] || {}).run || ''); settleBox(w); }
    var p = w.previousElementSibling; while (p && p === typingEl) p = p.previousElementSibling;
    return { w: w, cont: !!p && p.classList.contains('xc-ai') && !p.classList.contains('bad') && grpOf(p) === tgrp(sid) };
  }
  function placeResult(sid, t, text, cls, fresh) {
    var w0 = fresh && boxWrap(sid), y0 = w0 ? w0.getBoundingClientRect().top : null;
    var s = resultSlot(sid), e = h('div', 'xc-m xc-ai xc-tres' + (s.cont ? ' cont' : '') + (cls ? ' ' + cls : '')), b = h('div', 'xc-bub'), body = md(text);
    e.dataset.run = 'task-' + sid; e.dataset.grp = tgrp(sid); e.dataset.tsid = sid;
    e.appendChild(avatar()); if (!s.cont) e.appendChild(h('span', 'xc-who', '小芯'));
    e.appendChild(b); b.appendChild(body); msgActs(e, text);
    if (body.querySelector('.xc-code, .xc-tbl')) e.classList.add('wide');
    s.w.parentNode.insertBefore(e, s.w);
    boxActs(s.w, t); paintBoxes();
    // 新来的结果淡入；任务框从原来的位置平滑滑到结果下面（FLIP），不再瞬间跳下去（站长 2026-11-19 体检第 2 条）
    if (fresh) {
      e.classList.add('enter');
      if (y0 != null && !reduceMotion()) { var y1 = s.w.getBoundingClientRect().top; if (Math.abs(y1 - y0) > 2) s.w.animate([{ transform: 'translateY(' + Math.round(y0 - y1) + 'px)' }, { transform: 'none' }], { duration: 380, easing: 'cubic-bezier(.2,.9,.25,1)' }); }
    }
    return { e: e, b: b };
  }
  // 框前面紧挨着的是同一条消息就标 own：那一条不露操作行，整条的操作在框下面；框跟着最新消息走、前面是别的话时不标，那句话照常露复制键
  function syncGrp() {
    if (!list) return;
    [].forEach.call(list.querySelectorAll(':scope > .xc-tbw[data-tsid], :scope > .xc-tres[data-tsid]'), function (e) { var g = tgrp(e.dataset.tsid); if (e.dataset.grp !== g) e.dataset.grp = g; });
    [].forEach.call(list.querySelectorAll(':scope > .xc-tbw'), function (w) {
      var p = w.previousElementSibling; while (p && p === typingEl) p = p.previousElementSibling;
      w.classList.toggle('own', !!p && p.classList.contains('xc-ai') && !p.classList.contains('bad') && grpOf(p) === grpOf(w));
    });
  }
  // 历史里做完的活：结束的时候框落在那里，结果接在下面
  function placeEnded(t) { if (!boxWrap(t.sid)) taskBox(t.sid, false); return drawTaskResult(t); }
  // 结果接回来以后让人看到：就在最下面——照旧跟到底；在眼前——轻轻闪一下；接回了上面那一轮、眼下看不到——聊天顶上冒一个小提示，点了滚过去
  var upEl = null;
  function nextMsg(e) { for (var n = e.nextElementSibling; n; n = n.nextElementSibling) if (n !== typingEl && n.classList.contains('xc-m') && !n.classList.contains('dock')) return n; return null; }
  function inView(e) { var b = root.querySelector('.xc-body').getBoundingClientRect(), r = e.getBoundingClientRect(); return r.bottom > b.top + 24 && r.top < b.bottom - 24; }
  function seeResult(e, t) {
    // 结果后面紧跟着的是这条消息自己的框：按整条的最后一个算
    var z = e; while (z.nextElementSibling && z.nextElementSibling.classList.contains('xc-tbw') && grpOf(z.nextElementSibling) === grpOf(e)) z = z.nextElementSibling;
    if (!nextMsg(z)) { toBottom(); return; }
    if (inView(e)) { glint(e); return; }
    if (!upEl) return;
    var above = e.getBoundingClientRect().top < root.querySelector('.xc-body').getBoundingClientRect().top, st = t && t.status;
    upEl.innerHTML = hi(above ? 'send' : 'down') + '<span></span>';
    upEl.lastChild.textContent = (t && t.title ? t.title + ' ' : '') + (st === 'failed' ? '没做成' : st === 'stopped' ? '已停止' : st === 'waiting' ? '需要你确认' : '做好了');
    upEl._to = e; upEl.hidden = false;
  }
  function hideUp() { if (upEl) { upEl.hidden = true; upEl._to = null; } }
  function upGo() {
    var e = upEl && upEl._to; hideUp();
    if (!e || !e.isConnected) return;
    var b = root.querySelector('.xc-body'), to = e.getBoundingClientRect().top - b.getBoundingClientRect().top + b.scrollTop - Math.max(16, (b.clientHeight - e.offsetHeight) / 3);
    if (reduceMotion()) b.scrollTop = to; else b.scrollTo({ top: to, behavior: 'smooth' });
    glint(e);
  }
  function glint(e) { e.classList.remove('xc-glint'); void e.offsetWidth; e.classList.add('xc-glint'); clearTimeout(e._gl); e._gl = setTimeout(function () { e.classList.remove('xc-glint'); }, 1400); }
  function endState(t) { return t.status === 'done' ? 'done' : t.status === 'failed' ? 'failed' : t.status === 'waiting' ? 'waiting' : 'stopped'; }
  // 后台的活在干什么：正跟着它就用它最近的命令；没跟着就从任务摘要的 activity 认（内部命令当没有），再不行就是「在想」那几句
  function taskVerb(sid) {
    var t = S.tinfo[sid] || {}, f = S.tf[sid];
    if (!tLive(t) && tBusy(t)) return '整理结果';   // 后台做完了，前台在写总结
    if (t.status === 'queued') return t.after && t.after.length ? '排队中' : '准备中';
    if (t.status === 'stopping') return '正在停止';
    if (f && f.done) return '整理结果';
    if (f && f.verb) return f.verb;
    // 旧控制器的 activity 可能是内部命令（在执行：xin task …）：不显示
    return t.activity && !/^在执行：\s*xin\s+(?!browser\b)/.test(t.activity) ? t.activity : '思考中';
  }

  // 欢迎框里的模型只在天启写（天启的模型是站长自己选的）；小芯的默认界面不露模型（后台的活也一样）
  function runModel(m) { return tqConv() ? modelName(m.model || S.hModel) : ''; }
  function runTab(run) {
    var m = S.runMeta[run] || {};
    var tq = tqConv();
    return { key: 'run:' + run, label: '本轮', prompt: m.prompt || '', model: runModel(m), live: run === S.run, endMs: m.ms,
      who: tq ? '天启' : '', mark: tq ? tqMark('big').outerHTML : '', smallMark: tq ? tqMark().outerHTML : '',
      events: (S.runEv[run] || []).filter(function (e) { return e.t !== 'task'; }),
      status: function () { return { verb: doingWord(), sec: (Date.now() - (S.t0 || Date.now())) / 1000 }; } };
  }
  function taskTab(sid) {
    var t = S.tinfo[sid]; if (!t) return null;
    var f = S.tf[sid], live = tLive(t);
    var tab = { key: 'task:' + sid, label: t.title || '后台的活', prompt: t.title || '', cwd: t.dir || '', live: live, events: f ? f.events.slice() : [],
      status: function () { var x = S.tinfo[sid] || t; return { verb: taskVerb(sid), sec: x.status === 'queued' || !x.startedAt ? null : (Date.now() - x.startedAt) / 1000 }; } };
    if (!live) { tab.endState = endState(t); tab.endMs = t.startedAt && t.endedAt ? t.endedAt - t.startedAt : null; if (!f || !f.full) tab.loading = true; }
    return tab;
  }
  function termTabs(ctx) {
    var tabs = [], seen = {};
    function addTask(sid) { if (seen[sid]) return; seen[sid] = 1; var t = taskTab(sid); if (t) tabs.push(t); }
    if (ctx === 'live') {
      if (S.run) { tabs.push(runTab(S.run)); runTasks(S.run).forEach(addTask); }
      Object.keys(S.tinfo).forEach(function (sid) { var t = S.tinfo[sid]; if (S.sid && t.parent === S.sid && tLive(t)) addTask(sid); });
    } else if (ctx.indexOf('run:') === 0) {
      var run = ctx.slice(4);
      if (runTools(run) || run === S.run) tabs.push(runTab(run));
      runTasks(run).forEach(addTask);
    } else if (ctx.indexOf('task:') === 0) addTask(ctx.slice(5));
    return tabs;
  }
  function openTerm(ctx, anchor) {
    if (!window.LimingXinTerm || !root) return;
    var tabs = termTabs(ctx); if (!tabs.length) return;
    // 先看正在电脑上做事的那一页：这一轮自己在敲命令就看这一轮，不然看还在做的后台活
    var fg = tabs[0].key.indexOf('run:') === 0 && runTools(tabs[0].key.slice(4)) ? tabs[0] : null;
    var act = fg || tabs.filter(function (t) { return t.live && t.key.indexOf('task:') === 0; })[0] || tabs[0];
    TW = LimingXinTerm.win(root);
    TW.open({ anchor: anchor, tabs: tabs, active: act.key, onTab: termFollow, onClose: termUnfollow });
  }
  function termFollow(key) {
    Object.keys(S.tf).forEach(function (k) { if ('task:' + k !== key) { clearTimeout(S.tf[k].tm); S.tf[k].tm = 0; } });
    if (!key || key.indexOf('task:') !== 0) return;
    var sid = key.slice(5), t = S.tinfo[sid]; if (!t) return;
    var f = S.tf[sid] = S.tf[sid] || { sid: sid, run: '', off: 0, pos: null, events: [], busy: false, tm: 0, full: false, done: false };
    // 在做的活：打开（或换到这一页）以后第一次取回来的是打开前就做过的，一次画好（catchup）；之后来的才逐字敲
    if (tLive(t)) { f.catchup = true; tfRun(f, t); tfPoll(f); } else if (!f.full) tfLoad(f);
  }
  function termUnfollow() { Object.keys(S.tf).forEach(function (k) { clearTimeout(S.tf[k].tm); S.tf[k].tm = 0; }); }
  // 补充要求、批准以后开了新的一轮：中间画一行「接着做」，从新一轮的开头取
  function tfRun(f, t) {
    if (!t.run || t.run === f.run) return;
    if (f.run) tfEvent(f, { t: 'mark', text: '继续' });
    f.run = t.run; f.off = 0; f.pos = null; f.done = false;
  }
  function tfPoll(f) {
    clearTimeout(f.tm); f.tm = 0;
    if (!TW || !TW.isOpen() || TW.active() !== 'task:' + f.sid || !f.run || f.busy || f.done) return;
    if (document.hidden) { f.tm = setTimeout(function () { tfPoll(f); }, 2000); return; }
    tfFetch(f).then(function (n) { if (n >= 0 && !f.done) f.tm = setTimeout(function () { tfPoll(f); }, n ? 1000 : 1800); });
  }
  // 取一页：返回取到几条（-1 = 换了对话，不用再取）
  function tfFetch(f) {
    var run = f.run, gen = S.convSeq; f.busy = true;
    return call('poll', Object.assign({ run: run, off: f.off }, typeof f.pos === 'number' ? { pos: f.pos } : {}), 0, null, function () { return gen === S.convSeq; }).then(function (d) {
      f.busy = false;
      if (gen !== S.convSeq || f.run !== run) return -1;
      if (d && d.error) throw new Error(d.msg || d.error);
      var evs = d.events || [], now = !!f.catchup;
      evs.forEach(function (ev) { tfEvent(f, ev, now); });
      f.off = d.off; f.pos = typeof d.pos === 'number' ? d.pos : null;
      if (d.next && d.next !== run) { tfEvent(f, { t: 'mark', text: '继续' }, now); f.run = d.next; f.off = 0; f.pos = null; return 1; }
      if (evs.length < 400) f.catchup = false;   // 打开前积下的取完了（一页最多 400 条，换到下一轮也接着算）
      if (d.done) f.done = true;
      return evs.length;
    }).catch(function () { f.busy = false; return gen === S.convSeq ? 0 : -1; });
  }
  // 终端里也看得到：兄弟中途补充的话（一行「> …」）、后台主动回聊天说的那句（站长 2026-11-17）
  function termEv(ev) {
    if (ev.t === 'user' && ev.steer && ev.text) return { t: 'ask', text: ev.text, at: ev.at };
    if (ev.t === 'note' && ev.text) return { t: 'text', text: '告诉兄弟：' + ev.text, at: ev.at };
    return ev;
  }
  function tfEvent(f, ev, now) {
    ev = termEv(ev);
    if (!/^(tool|tool_end|text|err|mark|think|ask)$/.test(ev.t)) return;   // 要求原文（user）、状态、结束不画
    if (ev.t === 'tool' && termLine(ev)) f.verb = stepOf(ev);
    else if (ev.t === 'tool_end' || ev.t === 'text') f.verb = '';
    f.events.push(ev);
    if (TW && TW.isOpen()) TW.push('task:' + f.sid, ev, now);
  }
  function tfLoad(f) {
    if (f.loading) return; f.loading = true;
    var gen = S.convSeq;
    call('history', { sid: f.sid }, 60000).then(function (d) {
      f.loading = false;
      if (gen !== S.convSeq) return;
      if (d && d.error) throw new Error(d.msg || d.error);
      var evs = [];
      (d.runs || []).forEach(function (r) {
        if (evs.length) evs.push({ t: 'mark', text: '继续' });
        (r.events || []).forEach(function (ev) { ev = termEv(ev); if (/^(tool|tool_end|text|err|think|ask)$/.test(ev.t)) evs.push(ev); });
      });
      f.events = evs; f.full = true;
      if (TW && TW.isOpen()) TW.fill('task:' + f.sid, evs);
    }).catch(function (e) { f.loading = false; if (TW && TW.isOpen()) TW.fill('task:' + f.sid, [{ t: 'err', text: '读取失败：' + e.message }]); });
  }
  // 任务情况变了：开着的那一页跟着（结束了补取最后一页、写结果），头像标记、后台那一行跟着
  function termSync() {
    paintBoxes();
    if (!TW || !TW.isOpen()) return;
    TW.tabs.forEach(function (tab) {
      if (tab.key.indexOf('task:') !== 0 || !tab.live) return;
      var sid = tab.key.slice(5), t = S.tinfo[sid], f = S.tf[sid]; if (!t) return;
      if (tLive(t)) { if (f) { var was = f.run; tfRun(f, t); if (TW.active() === tab.key && (f.run !== was || !f.tm && !f.busy)) tfPoll(f); } return; }
      var fin = function () { TW.end(tab.key, endState(t), t.startedAt ? (t.endedAt || Date.now()) - t.startedAt : null); };
      if (f && f.run && !f.done && !f.busy && TW.active() === tab.key) { clearTimeout(f.tm); tfFetch(f).then(fin, fin); } else fin();
    });
  }
  // 前台这一轮的事件：终端正开着这一轮就交给它；这一轮派出去的活加一页
  function termLive(ev, run) {
    if (!TW || !TW.isOpen() || !TW.tab('run:' + run)) return;
    if (ev.t === 'task') { var tt = taskTab(ev.sid); if (tt) TW.add(tt); return; }
    if (/^(tool|tool_end|text|err|think)$/.test(ev.t)) TW.push('run:' + run, ev);
    else if (ev.t === 'done') TW.end('run:' + run, null, ev.ms);
  }
  // 合进轮询到的任务情况：live 时，从「在做」变成结束的，聊天最后说结果；不在看那个对话就让页面上的小芯冒气泡
  function setTasks(arr, live) {
    var changed = [];
    (arr || []).forEach(function (t) {
      var old = S.tinfo[t.sid];
      S.tinfo[t.sid] = t;
      if(live&&old&&t.delivery?.state==='delivered'&&old.delivery?.state!=='delivered')changed.push(t);
      else if (live && old && old.status !== t.status && !tLive(t) && (tLive(old) || old.status === 'waiting')&&(!t.delivery||t.delivery.state==='delivered')) changed.push(t);
    });
    termSync();
    paintCards(); renderWork(); renderHome();
    if (changed.length) isleBump();
    changed.forEach(function (t) {
      var here = S.open && S.view === 'chat' && S.sid === t.parent;
      if (here && list) { var re = drawTaskResult(t, true); if (re) seeResult(re, t); }
      if (t.status !== 'stopped') announce(t, here);
    });
  }
  function announce(t, here) {
    var x = xin(); if (!x || here) return;
    var msg = t.status === 'waiting' ? '我这边需要你确认：' + t.title : (t.status === 'done' ? '我弄好了：' : '我没做成：') + t.title;
    x.say(msg, 12000, function () { open(); if (t.parent && t.parent !== S.sid) openSession(t.parent); });
    if (x.cmd) x.cmd(t.status === 'failed' ? 'sad' : 'happy');
  }
  var tpTm = 0;
  function pollTasksSoon(ms) { if (TQ) return; clearTimeout(tpTm); tpTm = setTimeout(pollTasks, ms == null ? 300 : ms); }
  function convLive() { return Object.keys(S.tinfo).some(function (k) { var t = S.tinfo[k]; return t.parent === S.sid && (tLive(t)||t.delivery?.state==='pending'); }); }
  function pollTasks() {
    clearTimeout(tpTm);
    if (TQ || !S.enabled || !S.authed) return;
    if (document.hidden) { tpTm = setTimeout(pollTasks, 5000); return; }
    var sid = S.sid;
    call('tasks', { sid: sid || undefined, deviceId:S.deviceId, tabId:S.tabId, watching: !!(S.open && S.view === 'chat' && !document.hidden && document.hasFocus()) }, 30000).then(function (d) {
      if (d && d.error) throw new Error(d.msg || d.error);
      S.bg = d.bg || 0; S.tactive = d.active || []; glowFrom(d);
      setTasks((d.active || []).concat(d.recent || [], sid === S.sid ? d.tasks || [] : []), true);
      if (sid && sid === S.sid && !S.loadingConversation) drawNotes(d.notes);   // 历史还在读的话，读完由历史画
      renderStrip(); renderWork(); renderHome();
      var waits = (d.active || []).some(function (t) { return t.status === 'waiting'; });
      var next = S.open && convLive() ? (S.view === 'chat' && !document.hidden ? 2000 : 4000) : S.bg > 0 ? 20000 : waits ? 60000 : 0;
      if (next) tpTm = setTimeout(pollTasks, next);
    }, function () { tpTm = setTimeout(pollTasks, 30000); });
  }
  // 后台主动回来说的一句（控制器在原对话里记的一轮说完的话，站长 2026-11-17）：正看着这个对话时画在最后；同一轮只画一次，刷新以后由历史画
  function drawNotes(notes) {
    if (!list || !(notes || []).length) return;
    notes.forEach(function (n) {
      if (!n || !n.run || !n.text || list.querySelector('.xc-ai[data-run="' + String(n.run).replace(/["\\]/g, '') + '"]')) return;
      draw({ t: 'text', text: n.text, note: n.task }, false, n.run);
    });
  }
  // 以前输入框上面的「N 个任务进行中」：现在由小芯岛显示
  function renderStrip() { renderIsle(); paintFaces(); }
  function stopTask(sid, btn) {
    if (btn) btn.disabled = true;
    call('task_stop', { sid: sid }, 30000).then(function (r) {
      if (r && r.error) throw new Error(r.msg || r.error);
      if (r && r.task) setTasks([r.task], false);
      pollTasksSoon(600);
      if (S.sheet && S.sheetTask === sid) loadTask(sid);
    }).catch(function (e) { if (btn) btn.disabled = false; setStatus('停止失败：' + e.message, 'bad'); setTimeout(function () { setStatus(''); }, 4000); });
  }
  function tellTask(sid, text, btn, note, decision, approvalId) {
    text = String(text || '').trim();
    if (btn) btn.disabled = true;
    call('task_tell', { sid: sid, text: text || undefined, decision: decision, approvalId: approvalId }, 30000).then(function (r) {
      if (r && r.error) throw new Error(r.msg || r.error);
      if (r && r.task) setTasks([r.task], false);
      if (note) note.textContent = r.msg || '好了';
      pollTasksSoon(800);
      setTimeout(function () { if (S.sheet && S.sheetTask === sid) loadTask(sid); }, 600);
    }).catch(function (e) { if (btn) btn.disabled = false; if (note) note.textContent = '发送失败：' + e.message; });
  }
  // 「详情」：从底下升起来的一页
  function sheetHead(title) {
    sheetEl.innerHTML = '';
    if (TQ) {
      sheetEl.classList.remove('tq-plugins');
      sheetEl.setAttribute('aria-label', title);
    }
    var hd = h('div', 'xc-sh-hd'), x = h('button', 'xc-ib xc-sh-x');
    hd.appendChild(h('i', 'xc-sh-grip'));
    x.type = 'button'; x.setAttribute('aria-label', '关掉'); x.innerHTML = svgIcon('x');
    x.addEventListener('click', function () { setSheet(false); });
    hd.appendChild(h('b', '', title)); hd.appendChild(x);
    sheetEl.appendChild(hd);
  }
  function openTask(sid, toInput) {
    var t = S.tinfo[sid];
    S.sheetTask = sid; S.sheetFocus = !!toInput;
    sheetHead(t ? t.title : '任务');
    var box = h('div', 'xc-sh-list xc-tk'); box.appendChild(h('p', 'xc-hint', '正在读取…'));
    sheetEl.appendChild(box);
    setSheet(true);
    loadTask(sid);
  }
  function loadTask(sid) {
    clearTimeout(S.tkTm);
    call('history', { sid: sid }, 60000).then(function (d) {
      if (d && d.error) throw new Error(d.msg || d.error);
      if (!S.sheet || S.sheetTask !== sid) return;
      var t = Object.assign({}, S.tinfo[sid] || {}, d.task || {});
      S.tinfo[sid] = t; paintCards();
      paintTask(sheetEl.querySelector('.xc-tk'), t, d.runs || []);
      if (tLive(t)) S.tkTm = setTimeout(function () { if (S.sheet && S.sheetTask === sid) loadTask(sid); }, 3000);
    }).catch(function (e) { var box = sheetEl.querySelector('.xc-tk'); if (box) { box.innerHTML = ''; box.appendChild(h('p', 'xc-hint', '读取失败：' + e.message)); } });
  }
  function paintTask(box, t, runs) {
    if (!box) return;
    var atEnd = box.scrollHeight - box.scrollTop - box.clientHeight < 60, top = box.scrollTop;
    var opened = [].map.call(box.querySelectorAll('.xc-tk-cmd'), function (d) { return d.open; });
    var was = box.querySelector('.xc-tk-in'), draft = was ? was.value : '', typing_ = !!was && document.activeElement === was, caret = typing_ ? was.selectionStart : 0;
    box.innerHTML = '';
    var meta = h('div', 'xc-tk-meta');
    meta.appendChild(h('span', 'xc-task-st st-' + t.status, tStatText(t)));
    meta.appendChild(h('span', '', [TKIND[t.kind], t.turns > 1 ? t.turns + ' 轮' : ''].filter(Boolean).join(' · ')));
    box.appendChild(meta);
    var preview=previewLink(t);if(preview)box.appendChild(preview);
    if (t.sites && t.sites.length) box.appendChild(h('p', 'xc-tk-dir', '用你的登录：' + t.sites.join('、')));
    if (t.dir) {
      var dl = h('p', 'xc-tk-dir'); dl.appendChild(document.createTextNode('工作目录 '));
      var a = h('a', 'xc-path', t.dir); a.href = '#'; a.setAttribute('data-path', t.dir);
      a.addEventListener('click', function (ev) { ev.preventDefault(); setSheet(false); loadFiles(t.dir, 'chat'); });
      dl.appendChild(a); box.appendChild(dl);
    }
    var log = h('div', 'xc-tk-log'), k = 0;
    runs.forEach(function (r, i) {
      var pend = {};
      r.events.forEach(function (ev) {
        if (ev.t === 'user') { var u = h('div', 'xc-tk-ask'); u.appendChild(h('b', '', i === 0 ? '要求' : '补充')); u.appendChild(h('div', '', ev.text)); log.appendChild(u); }
        else if (ev.t === 'text') { var tx = h('div', 'xc-tk-say'); tx.appendChild(md(ev.text)); log.appendChild(tx); }
        else if (ev.t === 'tool') { pend[ev.id] = ev; }
        else if (ev.t === 'tool_end') {
          delete pend[ev.id];
          var c = h('details', 'xc-tk-cmd' + (ev.ok ? '' : ' bad')), sm = h('summary');
          sm.appendChild(h('code', '', bareCmd(ev.detail || ev.name))); c.appendChild(sm);
          if (ev.out) c.appendChild(h('pre', '', ev.out));
          if (opened[k]) c.open = true;
          k++; log.appendChild(c);
        }
        else if (ev.t === 'err') log.appendChild(h('div', 'xc-tk-err', ev.text));
        else if (ev.t === 'done') log.appendChild(h('div', 'xc-tk-done', (ev.stopped ? '已停止' : ev.ok ? '本轮完成' : '本轮失败') + (ev.ms ? '，用时 ' + dur(ev.ms) : '')));
      });
      Object.keys(pend).forEach(function (id) { var p = h('div', 'xc-tk-cmd now'); p.appendChild(h('code', '', bareCmd(pend[id].detail || pend[id].name))); log.appendChild(p); });
    });
    box.appendChild(log);
    var act = h('div', 'xc-tk-act'), note = h('p', 'xc-tk-note');
    if (t.approval && t.approval.kind !== 'input') {
      act.appendChild(h('p', 'xc-tk-q', t.question || '批准这一次操作吗？'));
      if (t.publication) {
        var plan = h('details', 'xc-tk-plan'), entries = h('ul', '');
        plan.open = true; plan.appendChild(h('summary', '', '这次写回的文件'));
        ['deleted', 'conflicts', 'changes'].forEach(function (kind) {
          (t.publication[kind] || []).forEach(function (file) {
            if (kind === 'changes' && (t.publication.conflicts || []).indexOf(file) !== -1) return;
            entries.appendChild(h('li', '', (kind === 'deleted' ? '删除：' : kind === 'conflicts' ? '覆盖冲突：' : '写入：') + file));
          });
        });
        plan.appendChild(entries); act.appendChild(plan);
      }
      if (waitLeft(t)) act.appendChild(h('p', 'xc-tk-due', waitLeft(t) + '，未处理将自动停止'));
      ['approve', 'deny'].forEach(function (decision) {
        var button = h('button', 'xc-btn' + (decision === 'deny' ? ' sec' : ''), decision === 'approve' ? '批准' : '拒绝'); button.type = 'button';
        button.addEventListener('click', function () { tellTask(t.sid, '', button, note, decision, t.approval.id); });
        act.appendChild(button);
      });
    } else if (tLive(t)) {
      // 还在做：补充或改要求直接送进去（它手上这一步做完就按新的来），也能停
      if (t.status !== 'stopping') {
        var live = h('textarea', 'xc-tk-in'); live.rows = 1; live.value = draft; live.placeholder = '修改要求'; live.setAttribute('aria-label', '修改要求');
        var sendB = h('button', 'xc-btn', '发送'); sendB.type = 'button';
        var tell = function () { if (!live.value.trim()) { live.focus(); return; } tellTask(t.sid, live.value, sendB, note); live.value = ''; };
        sendB.addEventListener('click', tell);
        live.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing && !touch) { ev.preventDefault(); tell(); } });
        act.appendChild(live); act.appendChild(sendB);
        if (S.sheetFocus) { S.sheetFocus = false; setTimeout(function () { try { live.focus({ preventScroll: true }); } catch (e) { live.focus(); } }, 60); }
      }
      var stopB = h('button', 'xc-btn sec', '停止'); stopB.type = 'button';
      stopB.addEventListener('click', function () { stopTask(t.sid, stopB); });
      act.appendChild(stopB);
    } else {
      if (t.status === 'waiting' && t.question) act.appendChild(h('p', 'xc-tk-q', t.question));
      if (waitLeft(t)) act.appendChild(h('p', 'xc-tk-due', waitLeft(t) + '，未处理将自动停止'));
      // 等你登录：打开登录窗口（屏幕接管）→ 自己登 →「已登录，继续」；「跳过登录」。也可以直接回一句话
      if (t.status === 'waiting' && t.browserStep) {
        var lg = h('div', 'xc-tk-login');
        var openB = h('button', 'xc-btn', '打开登录窗口'), okB = h('button', 'xc-btn', '已登录，继续'), noB = h('button', 'xc-btn sec', '跳过登录');
        [openB, okB, noB].forEach(function (b) { b.type = 'button'; lg.appendChild(b); });
        openB.addEventListener('click', function () { openLogin({ sid: t.sid }); });
        okB.addEventListener('click', function () { okB.disabled = noB.disabled = true; tellTask(t.sid, '', okB, note, 'approve'); });
        noB.addEventListener('click', function () { okB.disabled = noB.disabled = true; tellTask(t.sid, '', noB, note, 'deny'); });
        act.appendChild(lg);
      }
      var ta = h('textarea', 'xc-tk-in'); ta.rows = 2; ta.value = draft;
      ta.placeholder = t.status === 'waiting' ? '输入回复' : '补充要求';
      ta.setAttribute('aria-label', ta.placeholder);
      var go = h('button', 'xc-btn', t.status === 'waiting' ? '回复' : '继续'); go.type = 'button';
      go.addEventListener('click', function () { tellTask(t.sid, ta.value, go, note); });
      act.appendChild(ta); act.appendChild(go);
    }
    act.appendChild(note);
    box.appendChild(act);
    if (typing_) { var now_ = box.querySelector('.xc-tk-in'); if (now_) { now_.focus({ preventScroll: true }); try { now_.setSelectionRange(caret, caret); } catch (e) { /* 不支持就算了 */ } } }
    box.scrollTop = atEnd ? box.scrollHeight : top;
  }
  function openTaskCenter() { if (TQ) return; open(); setDrawer(false); setTray(true); }
  // 没有入口的几页（全部任务、小芯的记忆、小芯的文件）：界面上不放，功能留着，按名字还能打开
  function page(name) {
    if (TQ && name !== 'files') return;
    open(); if (!S.authed) return;
    if (name === 'tasks') loadTasksView(); else if (name === 'mem') loadMemory(); else if (name === 'files') loadFiles(WORK, 'sess'); else if (name === 'daily') loadDaily();
  }
  // 小芯还在回上一句时发的话：先排着（灰色气泡「排队中」，能 ✕ 掉），这一句回完依次发出去
  function saveQueue() {
    var q = (S.queueFlight || []).concat(S.queue || []);
    ls(LS_PFX + 'queue.' + (S.sid || 'pending'), q.length ? JSON.stringify(q.map(function (v) { return { id: v.id, text: v.text, atts: v.atts }; })) : null);
  }
  function detachConversation(){
    if(S.sendFlight)S.sendFlight.snapshot=(S.queueFlight||[]).concat(S.queue||[]).map(function(v){return {id:v.id,text:v.text,atts:v.atts};});
    if((S.queue||[]).length||(S.queueFlight||[]).length)saveQueue();
    S.convSeq++;S.loadSeq++;S.sending=false;S.waitSend='';S.queueFlight=[];S.sendFlight=null;S.retrySend=null;S.loadingConversation=false;
  }
  function settleDetachedSend(f,d,error){
    var key=LS_PFX+'queue.'+(f.sid||'pending'),accepted=f.queued||[],snapshot=f.snapshot||[];
    try{
      var saved=JSON.parse(ls(key)||'[]'),owned=snapshot.map(function(v){return v.id;});
      if(d){
        var remaining=saved.filter(function(v){return (f.sid?accepted:owned).indexOf(v.id)<0;});ls(key,remaining.length?JSON.stringify(remaining):null);
        if(!f.sid){var dest=LS_PFX+'queue.'+d.sid,prior=JSON.parse(ls(dest)||'[]');snapshot.filter(function(v){return accepted.indexOf(v.id)<0;}).forEach(function(v){if(!prior.some(function(x){return x.id===v.id;}))prior.push(v);});ls(dest,prior.length?JSON.stringify(prior):null);}
      }else if(!f.sid){
        var remaining=saved.filter(function(v){return owned.indexOf(v.id)<0;});ls(key,remaining.length?JSON.stringify(remaining):null);
        snapshot.concat(accepted.length?[]:[{id:f.id,text:f.text,atts:f.atts,payload:f.payload}]).forEach(function(v){ls(LS_PFX+'unsent.'+v.id,JSON.stringify({id:v.id,text:v.text,atts:v.atts,payload:v.id===f.id?f.payload:v.payload,sid:'',error:error.message}));});
      }else if(!accepted.length)ls(LS_PFX+'unsent.'+f.id,JSON.stringify({id:f.id,text:f.text,atts:f.atts,payload:f.payload,sid:f.sid,error:error.message}));
    }catch{}
  }
  function restoreQueue() {
    if (S.queue.length) return;
    try { var q = JSON.parse(ls(LS_PFX + 'queue.' + (S.sid || 'pending')) || '[]'); q.forEach(function (v) { queueMsg(v.text, v); }); } catch (e) { /* invalid local data is ignored */ }
  }
  function queueMsg(given, restored) {
    var text = given != null ? String(given).trim() : input.value.trim();
    var atts = restored ? restored.atts || [] : given != null ? [] : (S.atts || []).filter(function (a) { return a.state === 'ok'; });
    if (!text && !atts.length) return false;
    if (given == null && attsBusy()) { setStatus('文件还没传完，传完再发', 'wait'); setTimeout(function () { setStatus(''); }, 2500); return false; }
    if (TQ && S.tqNoGw) { setStatus('天启的网关还没配好，暂时发不了消息。', 'bad'); return false; }
    if (list.querySelector('.xc-hello')) clearList();
    var files = atts.map(function (a) { return { name: a.name, path: a.path, size: a.size, image: a.image, url: a.url }; });
    if (given == null) { S.atts = []; renderAtts(); input.value = ''; ls(LS_DRAFT, null); grow(); }
    var e = draw({ t: 'user', text: text, files: files });
    e.classList.add('queued');
    var tag = h('div', 'xc-qtag', '待发送'), x = h('button', '', '✕');
    x.type = 'button'; x.setAttribute('aria-label', '取消发送');
    tag.appendChild(x); e.appendChild(tag);
    var q = { id: restored && restored.id || crypto.randomUUID(), text: text, atts: atts, el: e };
    e.dataset.messageId=q.id;
    x.addEventListener('click', function () {
      S.queue = S.queue.filter(function (y) { return y !== q; }); saveQueue(); e.remove();
      if (!input.value && text) { input.value = text; ls(LS_DRAFT, text); grow(); }
      renderSendBtn();
    });
    S.queue = S.queue.concat([q]);
    saveQueue();
    if (S.sessAgent === 'codex' && !atts.length) {
      var steer = h('button', 'xc-qsteer', '立即发送'); steer.type = 'button';
      steer.addEventListener('click', function () {
        if (!S.run) { flushQueue(); return; }
        steer.disabled = true;
        var generation=S.convSeq,run=S.run,sid=S.sid;
        call('steer', { sid: sid, run: run, text: text, clientId: q.id }, 30000,null,function(){return generation===S.convSeq;}).then(function (r) {
          if (r.error) throw new Error(r.msg || r.error);
          if(generation!==S.convSeq){settleDetachedSend({sid:sid,queued:[q.id]}, {sid:sid});return;}
          S.queue = S.queue.filter(function (v) { return v !== q; }); saveQueue();
          e.classList.remove('queued'); tag.textContent = '已发送'; steer.remove();
          if (r.next && r.run) { S.run = r.run; S.off = 0; S.pos = null; startPolling(); }
        }).catch(function (error) { if(generation!==S.convSeq)return;steer.disabled = false; tag.firstChild.textContent = '尚未补充：' + error.message; });
      });
      e.appendChild(steer);
    }
    renderSendBtn(); toBottom(true);
    return true;
  }
  function flushQueue() {
    if (!S.queue.length || S.run || S.sending) return;
    var q = S.queue.slice(0, 1); S.queue = S.queue.slice(1); S.queueFlight = q;
    saveQueue();
    q.forEach(function (y) { y.el.remove(); });
    send(null, { text: q.map(function (y) { return y.text; }).filter(Boolean).join('\n'), atts: [].concat.apply([], q.map(function (y) { return y.atts; })), queued: q });
  }

  /* ---------- 工作台：全屏的聊天；首页一张卡片进来 ----------
     ≥1180 左边对话常驻、中间聊天；更窄只有聊天，☰ 拉出对话。小芯岛点开的面板（.xc-work）在全屏 ≥900 时能「钉住」成右边一栏。
     数据都是现成的：任务卡片和看过程用聊天里那一套（openTask），列表从 tasks {all:true} 来，有在做的 4 秒刷一次。 */
  var SIDE_MIN = 1180, WORK_MIN = 900, wTm = 0, wSeq = 0, thumbs = {}, xwSeen = {};
  S.wkCat = TQ ? 'all' : ls(LS_PFX + 'wkCat') || 'all'; S.tray = false;
  // 面板、首页每次刷新都是重画：循环的动画（进度条、闪的点）按同一个时钟接着走，不从头来；进场动画只给第一次出现的
  function phase(el) { var t = Date.now(); el.style.setProperty('--p16', -(t % 1600) + 'ms'); el.style.setProperty('--p12', -(t % 1200) + 'ms'); el.style.setProperty('--p10', -(t % 1000) + 'ms'); }
  function work(opt) {
    opt = opt || {};
    // 站长 2026-11-19：从首页进工作台用像素点阵溶解过去（View Transitions）。直接打开链接、已经开着、减少动态、浏览器不支持时照旧
    if (!opt.vt && !opt.keepHash && !(S.open && S.wb) && document.startViewTransition && !reduceMotion()) {
      var de = document.documentElement, done = function () { de.classList.remove('vt-work'); };
      de.classList.add('vt-work');
      return new Promise(function (res) {
        // 换页这一步里浏览器不出新帧：不能等 requestAnimationFrame（以前等两帧，干等到 4 秒超时，过渡被掐掉），直接把工作台摆成最后的样子
        var vt = document.startViewTransition(function () { var p = work({ vt: true }); root.classList.add('show'); res(p); });
        vt.finished.then(done, done);
      });
    }
    if (!root) build();
    S.wb = true; root.classList.add('wb'); document.body.classList.add('xc-wb');
    layout();
    var p = open();
    if (location.hash !== '#xin-work' && !opt.keepHash) try { history.replaceState(history.state, '', location.pathname + location.search + '#xin-work'); } catch (e) { /* 地址改不了不影响 */ }
    return p;
  }
  function unwork(silent) {
    if (!root) return;
    S.wb = false; root.classList.remove('wb'); document.body.classList.remove('xc-wb');
    if (S.tray) setTray(false);
    layout();
    if (!silent && location.hash === '#xin-work') try { history.replaceState(history.state, '', location.pathname + location.search); } catch (e) { /* 同上 */ }
  }
  // 钉住的面板：只有全屏工作台、而且够宽（≥900）才是右边一栏
  function trayDocked() { return !TQ && !!(root && S.pin && S.wb && window.innerWidth >= WORK_MIN); }
  function layout() {
    if (!root) return;
    var w = window.innerWidth, side = !TQ && !!S.wb && w >= SIDE_MIN, dock = trayDocked();
    var was = root.classList.contains('wb-side');
    root.classList.toggle('wb-side', side); root.classList.toggle('wb-pin', dock);
    if (dock && S.tray) setTray(false, false, true);
    var dr = root.querySelector('.xc-drawer');
    if (side) { root.classList.remove('dr-open'); S.drawer = false; dr.setAttribute('aria-hidden', 'false'); if (S.authed && (!was || !drawerEl.firstChild)) loadSessions(); }
    else if (was) dr.setAttribute('aria-hidden', S.drawer ? 'false' : 'true');
    var wb = root.querySelector('.xc-wb-b'); if (wb) { wb.setAttribute('aria-label', S.wb ? '收起工作台' : '工作台'); wb.title = S.wb ? '收起工作台' : '工作台'; }
    var pin = root.querySelector('.xc-wk-pin');
    if (pin) {
      pin.hidden = !(S.wb && w >= WORK_MIN); pin.setAttribute('aria-pressed', dock ? 'true' : 'false');
      pin.setAttribute('aria-label', dock ? '取消钉住' : '钉在右边'); pin.title = pin.getAttribute('aria-label');
    }
    if (workEl) workEl.setAttribute('role', dock ? 'complementary' : 'dialog');
    if (dock && workEl) { workEl.style.clipPath = ''; workEl.style.left = workEl.style.top = workEl.style.width = ''; renderTray(); if (!TQ && S.authed) { pollWork(); loadQuota(); } }
    renderWork(); renderHead();
  }
  function setPin(on) {
    if (TQ) return;
    S.pin = !!on; ls(LS_PFX + 'trayPin', S.pin ? '1' : null);
    if (S.pin && S.tray) setTray(false, false, true);
    layout();
    if (!S.pin && S.wb) setTray(true);
  }
  // 面板摆在小芯岛下面：顶边和小芯岛对齐，左右尽量居中，不出屏幕；手机上左右各留 8px
  function placeTray() {
    if (!workEl || trayDocked()) return;
    var r = root.getBoundingClientRect(), ir = isleEl.getBoundingClientRect(), narrow = r.width < 600;
    var w = narrow ? r.width - 16 : Math.min(440, r.width - 24);
    var left = narrow ? 8 : Math.max(12, Math.min(ir.left - r.left + ir.width / 2 - w / 2, r.width - w - 12));
    workEl.style.width = w + 'px'; workEl.style.left = left + 'px'; workEl.style.top = Math.max(6, ir.top - r.top) + 'px';
    workEl.style.setProperty('--max', Math.max(240, Math.round(r.height * (narrow ? .8 : .76))) + 'px');
    return { left: left, w: w, il: ir.left - r.left, iw: ir.width, ih: ir.height };
  }
  /* 从小芯岛长出来（站长 2026-11-16：「细节动画过度……有的地方卡卡的」）。参考 cult-ui 的 Dynamic Island（弹簧 stiffness 400、
     damping 30）和 Vaul 的 iOS 曲线：
     - 形状：clip-path 从药丸那一块长成整块面板，曲线是按 400/30 弹簧采样的 linear()；圆角从药丸的半高过渡到 22，不再从 999 掉下来。
     - 共享元素：面板标题左边那一组（脸、小芯、状态、数字）和药丸里排得一模一样，第一帧摆在药丸的位置，跟着形状移到标题的位置；
       药丸藏在面板下面。收起反过来，形状缩回药丸那一刻再把药丸换回来——换的那一帧两边一模一样，看不出接缝。
     - 阴影：裁剪会把阴影也裁掉，所以展开完去掉裁剪、阴影再淡入；收起先收阴影。
     - 动画途中不重画（数据到了记一笔，展开完再画）。 */
  function isleClip(p) {
    var h_ = workEl.offsetHeight || 400, r = Math.round(p.ih / 2);
    return 'inset(0px ' + Math.max(0, p.left + p.w - p.il - p.iw) + 'px ' + Math.max(0, h_ - p.ih) + 'px ' + Math.max(0, p.il - p.left) + 'px round ' + r + 'px)';
  }
  var trayTm = 0, trayEnd = 0, enterTm = 0, OPEN_MS = 520, CLOSE_MS = 270;
  function setTray(on, focusBack, instant) {
    if (TQ || !root) return;
    on = !!on && !trayDocked() && S.authed;
    if (on === S.tray) return;
    S.tray = on; clearTimeout(trayTm); clearTimeout(trayEnd); clearTimeout(enterTm);
    isleEl.setAttribute('aria-expanded', on ? 'true' : 'false');
    var quick = instant || reduceMotion(), id = workEl.querySelector('.xc-wk-id'), fresh = !workEl.classList.contains('pop');
    if (on) {
      setMenu(false); setPick(false);
      workEl.classList.remove('out', 'done');
      workEl.classList.add('pop'); root.classList.add('tray-open');
      S.trayMv = false; renderTray(); renderWork(true);   // 先按最终的样子排好，动画途中不再重画
      var p = placeTray();
      isleEl.classList.add('under');
      if (!quick) {
        S.trayMv = true;
        if (fresh) {
          workEl.style.transition = id.style.transition = 'none';
          workEl.style.clipPath = isleClip(p); id.style.transform = 'translateX(' + (p.il - p.left) + 'px)';
          void workEl.offsetWidth;
          workEl.style.transition = id.style.transition = '';
        } else if (getComputedStyle(workEl).clipPath === 'none') workEl.style.clipPath = 'inset(0px 0px 0px 0px round 22px)';
        workEl.classList.add('mv', 'enter');
        workEl.style.clipPath = 'inset(0px 0px 0px 0px round 22px)'; id.style.transform = '';
        trayEnd = setTimeout(trayOpened, OPEN_MS);
      } else { workEl.style.clipPath = ''; id.style.transform = ''; trayOpened(); }
      workEl.classList.add('in');
      pollWork(); loadQuota();
      setTimeout(function () { if (S.tray) { var f = workEl.querySelector('.wk-sg.on, .wk-c, .xc-scr-b'); if (f && !touch) f.focus({ preventScroll: true }); } }, quick ? 0 : 200);
    } else {
      root.classList.remove('tray-open');
      if (fresh) { isleEl.classList.remove('under'); S.trayMv = false; return; }
      if (quick) trayClosed();
      else {
        var q = placeTray();
        S.trayMv = true;
        if (getComputedStyle(workEl).clipPath === 'none') { workEl.style.transition = 'none'; workEl.style.clipPath = 'inset(0px 0px 0px 0px round 22px)'; void workEl.offsetWidth; workEl.style.transition = ''; }
        workEl.classList.remove('in', 'done', 'enter'); workEl.classList.add('mv', 'out');
        workEl.style.clipPath = isleClip(q); id.style.transform = 'translateX(' + (q.il - q.left) + 'px)';
        trayTm = setTimeout(trayClosed, CLOSE_MS);
      }
      if (focusBack && !touch) isleEl.focus({ preventScroll: true });
    }
  }
  function trayOpened() {
    if (!S.tray) return;
    S.trayMv = false; workEl.classList.remove('mv');
    workEl.style.clipPath = 'none'; workEl.classList.add('done');
    enterTm = setTimeout(function () { workEl.classList.remove('enter'); }, 500);   // 记着，快速收起再展开时别把新一次的错开进场掐掉
    if (S.trayDirty) { S.trayDirty = false; renderTray(); renderWork(); }
  }
  function trayClosed() {
    if (S.tray) return;
    S.trayMv = false; S.trayDirty = false;
    workEl.classList.remove('pop', 'in', 'out', 'mv', 'done', 'enter');
    workEl.style.clipPath = ''; var id = workEl.querySelector('.xc-wk-id'); if (id) id.style.transform = '';
    isleEl.classList.remove('under');
  }
  function reduceMotion() { return !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches); }
  function flash(el) { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }
  // 左边那栏常驻时，对话有变化（开了新的、发出第一句、切换）就跟着刷新，别等手动拉开
  var sideTm = 0;
  function refreshSide() { if (!root || !root.classList.contains('wb-side')) return; clearTimeout(sideTm); sideTm = setTimeout(loadSessions, 250); }
  function pollWork() {
    clearTimeout(wTm);
    if (TQ || !S.enabled || !S.authed) return;
    var my = ++wSeq;
    call('tasks', { all: true, deviceId: S.deviceId, tabId: S.tabId }, 30000).then(function (d) {
      if (my !== wSeq) return;
      if (d && d.error) throw new Error(d.msg || d.error);
      S.bg = d.bg || 0; S.tactive = d.active || []; S.wall = d.tasks || []; glowFrom(d);
      setTasks(S.wall.concat(d.active || []), true); renderStrip();
      nextWork();
    }).catch(function () { if (my === wSeq) wTm = setTimeout(pollWork, 30000); });
  }
  function workShown() { return !!(S.open && !document.hidden && (S.wb || S.tray)); }
  function nextWork() {
    clearTimeout(wTm);
    var live = (S.tactive || []).some(tLive), shown = workShown(), home = homeShown();
    var ms = shown ? (live ? 4000 : 30000) : home && live ? 10000 : 0;
    if (ms) wTm = setTimeout(pollWork, ms);
  }
  /* 面板上面一块：小芯的电脑（在线 / 休息、看屏幕）和额度（每个模型 5 小时 / 每周，几点重置），「用量」进用量页。
     额度来自 usage（30 秒内用缓存）；没读到就只写一句 */
  function loadQuota() {
    if (TQ || !S.authed) return;
    loadUsage().then(function () { renderTray(); }, function () { /* 读不到就不显示额度 */ });
  }
  function renderTray(force) {
    if (TQ || !workEl) return;
    if (S.trayMv && !force) { S.trayDirty = true; return; }
    var top = workEl.querySelector('.xt-top'); if (!top) return;
    var pc = top.querySelector('.xt-pc');
    if (!pc) {
      top.innerHTML = '';
      pc = h('div', 'xt-pc');
      pc.innerHTML = '<span class="xt-k">电脑</span><span class="xt-v"><i class="xt-led"></i><span></span></span>';
      var sb = h('button', 'xt-b xc-scr-b'); sb.type = 'button'; sb.setAttribute('aria-label', '看小芯的屏幕');
      sb.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="11.5" rx="1.8"/><path d="M8.5 19.5h7M12 16v3.5"/></svg><span>看屏幕</span>';
      sb.addEventListener('click', function () { openScreen(false); });
      pc.appendChild(sb); top.appendChild(pc);
      var q = h('div', 'xt-q'); top.appendChild(q);
    }
    var on = S.mstate === 'running', sleep = S.mstate === 'suspended' || S.mstate === 'stopped';
    pc.querySelector('.xt-v span').textContent = on ? '在线' : S.mstate === 'suspended' ? '休息中' : S.mstate === 'stopped' ? '关机了' : S.mstate || '连接中';
    pc.querySelector('.xt-led').className = 'xt-led' + (on ? ' on' : sleep ? ' off' : '');
    var qb = top.querySelector('.xt-q'), u = S.uv, sig = u ? String(S.uvAt) : '';
    if (qb.dataset.sig === sig && qb.childNodes.length) return;
    qb.dataset.sig = sig; qb.textContent = '';
    var hd = h('div', 'xt-qh'); hd.appendChild(h('span', 'xt-k', 'Google 额度'));
    var ub = h('button', 'xt-b xt-use'); ub.type = 'button'; ub.innerHTML = '<span>用量</span>' + svgIcon('chev');
    ub.addEventListener('click', function () { setTray(false); openUsage(); });
    hd.appendChild(ub); qb.appendChild(hd);
    if (!u) { qb.appendChild(h('p', 'xt-qe', '正在读取…')); return; }
    quotaRows(qb, u);
  }
  // 所有任务：最新状态在 S.tinfo（轮询会更新），列表顺序以 tasks {all:true} 为准；没拿到之前就用手上有的
  function allTasks() {
    var seen = {}, out = [];
    (S.wall || []).concat(S.tactive || [], Object.keys(S.tinfo).map(function (k) { return S.tinfo[k]; })).forEach(function (t) {
      if (!t || !t.sid || seen[t.sid] || !t.title) return; seen[t.sid] = true; out.push(S.tinfo[t.sid] || t);
    });
    return out;
  }
  // 成果按类别分（站长 2026-11-11）：网页成品、查资料、写代码、每日任务、其他
  var WK_CATS = [['web', '网页'], ['research', '资料'], ['code', '代码'], ['other', '其他'], ['daily', '每日任务']];
  var WK_ICON = {
    web: '<rect x="3" y="4.5" width="18" height="15" rx="2.6"/><path d="M3 9h18"/><path d="M6.3 6.8h.01M8.6 6.8h.01"/>',
    research: '<circle cx="11" cy="11" r="6.2"/><path d="m20 20-4.4-4.4"/>',
    code: '<path d="m8.5 8-4 4 4 4M15.5 8l4 4-4 4M13.6 5.5l-3.2 13"/>',
    daily: '<rect x="3.5" y="5" width="17" height="15.5" rx="2.6"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
    other: '<path d="M12 3.6 14 9l5.4 2-5.4 2-2 5.4-2-5.4-5.4-2L10 9z"/>',
    wait: '<circle cx="12" cy="12" r="8.6"/><path d="M12 7.6v5.2M12 16.3h.01"/>'
  };
  function wkIcon(k) { var i = h('span', 'wk-ic'); i.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">' + (WK_ICON[k] || WK_ICON.other) + '</svg>'; return i; }
  function tCat(t) {
    if (t.kind === 'daily' || t.dailyDate) return 'daily';
    if (previewId(t) || t.web) return 'web';
    if (t.kind === 'research') return 'research';
    if (t.kind === 'code' || t.kind === 'hard' || t.kind === 'review') return 'code';
    return 'other';
  }
  function groups() {
    var all = allTasks(), by = function (k) { return function (a, b) { return (b[k] || b.created || 0) - (a[k] || a.created || 0); }; };
    var done = all.filter(function (t) { return !tLive(t) && t.status !== 'waiting'; }).sort(by('endedAt')), cats = {};
    done.forEach(function (t) { (cats[tCat(t)] = cats[tCat(t)] || []).push(t); });
    return {
      live: all.filter(tLive).sort(function (a, b) { return (a.created || 0) - (b.created || 0); }),
      wait: all.filter(function (t) { return t.status === 'waiting'; }).sort(by('endedAt')),
      done: done, cats: cats
    };
  }
  function ago(t) {
    var s = Math.max(0, Math.round((Date.now() - t) / 1000));
    return s < 60 ? '刚刚' : s < 3600 ? Math.floor(s / 60) + ' 分钟前' : s < 86400 ? Math.floor(s / 3600) + ' 小时前' : when(t);
  }
  function previewId(t) { var m = t.preview && t.preview.ready && /^\/xin\/preview\.html\?id=([a-f0-9]{32})$/.exec(t.preview.url || ''); return m ? m[1] : ''; }
  // 网页成品的截图：同一个任务只建一次 <img>，重画时搬过去，不重新下载
  function thumb(t) {
    var id = previewId(t); if (!id) return null;
    var im = thumbs[id];
    if (!im) {
      im = thumbs[id] = h('img', 'wk-img'); im.alt = ''; im.loading = 'lazy'; im.decoding = 'async';
      im.addEventListener('error', function () { im.classList.add('bad'); });
      im.addEventListener('load', function () { tallFig(im); });
      im.src = API + 'preview/' + id + '/preview.png';
    }
    return im;
  }
  // 竖的截图（2026-11-16 以前在手机宽度上截的）：卡片是 16:10 横框，cover 只剩最上面一截空背景（站长：「这个网页有显示bug」）。
  // 整张缩进框里，两边垫同一张图的模糊底；新的截图是电脑宽度的横图，照旧铺满
  function tallFig(im) {
    var f = im.parentNode; if (!f || !f.classList || !f.classList.contains('wk-fig')) return;
    var tall = im.naturalHeight > im.naturalWidth;
    f.classList.toggle('tall', tall);
    if (tall) f.style.setProperty('--wk-shot', 'url("' + im.getAttribute('src') + '")'); else f.style.removeProperty('--wk-shot');
  }
  // 一行一个任务（分组列表，不是一张张卡片）：左边类别或状态，中间标题和一句话，右边时间；进行中的下面是操作和一条细进度光。
  // 网页成品例外：截图是这一页唯一的大图。
  function wkCard(t, kind) {
    var cat = tCat(t), im = kind === 'done' && cat === 'web' ? thumb(t) : null;
    var c = h('div', 'wk-c ' + kind + ' c-' + cat + ' st-' + t.status + (t.status === 'failed' ? ' bad' : '') + (im ? ' fig' : ' row')); c.dataset.tsid = t.sid; c.tabIndex = 0; c.setAttribute('role', 'button');
    phase(c);
    c.setAttribute('aria-label', t.title + '，' + (TSTAT[t.status] || t.status));
    var open_ = function () { openTask(t.sid); };
    c.addEventListener('click', function (e) { if (!e.target.closest('button, a')) open_(); });
    c.addEventListener('keydown', function (e) { if ((e.key === 'Enter' || e.key === ' ') && e.target === c) { e.preventDefault(); open_(); } });
    if (im) { var fig = h('div', 'wk-fig'); fig.appendChild(im); c.appendChild(fig); if (im.complete && im.naturalWidth) tallFig(im); }
    if (!im) c.appendChild(wkIcon(kind === 'wait' ? 'wait' : cat));
    var head = h('div', 'wk-hd');
    head.appendChild(h('b', 'wk-t', t.title));
    var line = kind === 'live' ? (t.status === 'stopping' ? '停止中' : t.status === 'queued' ? (t.retryAt > Date.now() ? '连接出错，稍后重试' : '排队中') : t.activity || '准备中')
      : kind === 'wait' ? t.question || '待处理'
      : t.status === 'failed' ? '失败' + (t.result && (t.result.err || firstLine(t.result.text)) ? '：' + (t.result.err || firstLine(t.result.text)) : '')
      : t.status === 'stopped' ? stopLine(t) : t.result ? firstLine(t.result.text) : '';
    if (line && !im) head.appendChild(h('p', 'wk-line', line));
    c.appendChild(head);
    c.appendChild(h('span', 'wk-time', wkTime(t, kind))); c.dataset.kind = kind;
    var act = h('div', 'wk-act');
    if (kind === 'live' && t.status !== 'stopping') {
      var tell = h('button', 'wk-b', '修改'); tell.type = 'button'; tell.addEventListener('click', function () { openTask(t.sid, true); });
      var stopB = h('button', 'wk-b', '停止'); stopB.type = 'button'; stopB.addEventListener('click', function () { stopTask(t.sid, stopB); });
      act.appendChild(tell); act.appendChild(stopB);
    } else if (kind === 'wait') {
      var rep_ = h('button', 'wk-b on', waitAction(t)); rep_.type = 'button'; rep_.addEventListener('click', open_); act.appendChild(rep_);
    } else if (previewId(t)) {
      var a = h('a', 'wk-b', '打开网页'); a.href = t.preview.url; a.target = '_blank'; a.rel = 'noopener'; act.appendChild(a);
    }
    if (act.childNodes.length) c.appendChild(act);
    if (kind === 'live') c.appendChild(h('div', 'wk-bar'));
    return c;
  }
  function wkTimes(box) {
    [].forEach.call(box.querySelectorAll('.wk-c[data-kind]'), function (c) {
      var t = S.tinfo[c.dataset.tsid], e = c.querySelector('.wk-time'); if (!t || !e) return;
      var v = wkTime(t, c.dataset.kind); if (e.textContent !== v) e.textContent = v;
    });
  }
  function wkTime(t, kind) { return kind === 'live' ? (t.status === 'queued' ? '' : dur(Date.now() - (t.startedAt || t.created || Date.now()))) : kind === 'wait' && waitLeft(t) ? waitLeft(t) : ago(t.endedAt || t.created || Date.now()); }
  // 每日任务：日期 + 那天的结果，多于 4 天先收起
  function wkDaily(list) {
    var wrap = h('div', 'wk-list done daily'), more = !S.wkDailyAll && list.length > 4;
    (more ? list.slice(0, 4) : list).forEach(function (t) {
      var r = h('div', 'wk-c done c-daily row day' + (t.status === 'failed' ? ' bad' : '')); r.dataset.tsid = t.sid; r.tabIndex = 0; r.setAttribute('role', 'button');
      var m = /(\d{1,2}-\d{1,2})\s*$/.exec(t.title || ''), day = m ? m[1] : '';
      r.setAttribute('aria-label', t.title + '，' + (TSTAT[t.status] || t.status));
      r.appendChild(h('b', 'wk-day', day || t.title));
      r.appendChild(h('span', 'wk-line', t.status === 'failed' ? '失败' : (t.result && firstLine(t.result.text)) || ''));
      r.appendChild(h('span', 'wk-st', TSTAT[t.status] || t.status));
      var go = function () { openTask(t.sid); };
      r.addEventListener('click', go);
      r.addEventListener('keydown', function (e) { if ((e.key === 'Enter' || e.key === ' ') && e.target === r) { e.preventDefault(); go(); } });
      wrap.appendChild(r);
    });
    if (more) {
      var all = h('button', 'wk-more', '显示全部（' + list.length + '）'); all.type = 'button';
      all.addEventListener('click', function () { S.wkDailyAll = true; renderWork(); });
      wrap.appendChild(all);
    }
    return wrap;
  }
  /* 面板里的任务列表。每 4 秒轮询一次，以前每次整块重画：进行中那条细进度光每次从头跑、悬停和焦点也跟着丢。
     现在按内容签名：显示的东西没变就不重画，只把时间文字原地改掉；展开动画途中不画（展开完再画）。 */
  function renderWork(force) {
    if (TQ || !root || !(S.tray || trayDocked() || workEl.classList.contains('pop'))) return;
    if (S.trayMv && !force) { S.trayDirty = true; return; }
    var sc = root.querySelector('.xc-wk-sc'), box = root.querySelector('.xt-tasks'), g = groups(), top = sc.scrollTop, focus = document.activeElement && box.contains(document.activeElement) ? document.activeElement.closest('[data-tsid], [data-cat]') : null;
    var fsid = focus && focus.dataset.tsid, fcat = focus && focus.dataset.cat;
    var present = WK_CATS.filter(function (c) { return (g.cats[c[0]] || []).length; });
    var cat = S.wkCat && S.wkCat !== 'all' && present.some(function (c) { return c[0] === S.wkCat; }) ? S.wkCat : 'all';
    var sig = cat + '|' + (S.wkDailyAll ? 1 : 0) + '|' + g.live.concat(g.wait, g.done).map(function (t) {
      return [t.sid, t.status, t.title, t.activity || '', t.question || '', t.result ? t.result.at + ':' + (t.result.ok ? 1 : 0) : '', t.preview && t.preview.ready ? t.preview.url : '', t.retryAt > Date.now() ? 1 : 0, tCat(t)].join('\u0001');
    }).join('\u0002');
    if (!force && box.dataset.sig === sig && box.firstChild) { wkTimes(box); renderIsle(); return; }
    box.dataset.sig = sig;
    box.textContent = '';
    // 类别：有两类以上成果才出现；只筛成果，进行中和待处理总在上面
    if (present.length > 1) {
      var seg = h('div', 'wk-seg'); seg.setAttribute('role', 'tablist'); seg.setAttribute('aria-label', '成果类别');
      [['all', '全部', g.done.length]].concat(present.map(function (c) { return [c[0], c[1], g.cats[c[0]].length]; })).forEach(function (c) {
        var b = h('button', 'wk-sg' + (c[0] === cat ? ' on' : '')); b.type = 'button'; b.dataset.cat = c[0];
        b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', c[0] === cat ? 'true' : 'false');
        b.appendChild(document.createTextNode(c[1])); b.setAttribute('aria-label', c[1] + ' ' + c[2]);
        b.addEventListener('click', function () { if (S.wkCat === c[0]) return; S.wkCat = c[0]; ls(LS_PFX + 'wkCat', c[0] === 'all' ? null : c[0]); S.wkSwap = true; renderWork(); });
        seg.appendChild(b);
      });
      box.appendChild(seg);
    }
    var body = h('div', 'wk-body' + (S.wkSwap ? ' swap' : '')); S.wkSwap = false;
    var sec = function (name, n) { var hd = h('p', 'wk-h'); hd.appendChild(document.createTextNode(name)); hd.appendChild(h('i', '', String(n))); body.appendChild(hd); };
    var group = function (list, kind, cls, max) { var wrap = h('div', 'wk-list ' + kind + (cls ? ' ' + cls : '')); list.slice(0, max).forEach(function (t) { wrap.appendChild(wkCard(t, kind)); }); body.appendChild(wrap); };
    if (g.live.length) { sec('进行中', g.live.length); group(g.live, 'live', '', 20); }
    if (g.wait.length) { sec('待处理', g.wait.length); group(g.wait, 'wait', '', 20); }
    (cat === 'all' ? present : present.filter(function (c) { return c[0] === cat; })).forEach(function (c) {
      var list = g.cats[c[0]];
      sec(c[1], list.length);
      if (c[0] === 'daily') body.appendChild(wkDaily(list));
      else group(list, 'done', 'c-' + c[0], 30);
    });
    if (!g.live.length && !g.wait.length && !g.done.length) {
      var e = h('div', 'wk-empty'); e.appendChild(h('p', '', '暂无任务')); body.appendChild(e);
    }
    box.appendChild(body);
    [].forEach.call(box.querySelectorAll('.wk-c'), function (c, i) { c.style.setProperty('--i', Math.min(i, 8)); });
    sc.scrollTop = top;
    var again = fsid ? box.querySelector('[data-tsid="' + fsid + '"]') : fcat ? box.querySelector('.wk-sg[data-cat="' + fcat + '"]') : null;
    if (again) again.focus({ preventScroll: true });
    renderIsle();
  }


  /* ---------- 额度光环、额度卡、用量页（数据见 vm-usage.mjs 和 usage op） ----------
     照 Agent HUD：头像外一圈光环，颜色按用得最多的那项额度（<70% 绿、≥70% 黄、≥90% 红，用完变暗），小芯在干活时呼吸快一些；
     点头像出额度卡（每个模型 5 小时 / 每周、几点重置、照现在的速度几点用完）；卡片底部「用量」打开工作台里的用量页。 */
  var GLOW_TXT = { ok: '额度充足', warn: '有一项用了七成以上', high: '有一项快用完了', out: '有一项用完了' };
  S.glow = '';
  // 旧控制器不带 glow：颜色不动，但「有没有活在做」照样跟着刷新
  function glowFrom(d) { if (d && Object.prototype.hasOwnProperty.call(d, 'glow')) S.glow = GLOW_TXT[d.glow] ? d.glow : ''; paintGlow(); }
  // 新建的头像还没挂到页面上时 querySelectorAll 找不到它，所以 glowAv 建好就先按当前状态涂一次
  function paintOne(b) {
    b.classList.remove('g-ok', 'g-warn', 'g-high', 'g-out');
    if (S.glow) b.classList.add('g-' + S.glow);
    b.classList.toggle('busy', !!(S.run || (S.tactive || []).some(tLive)));
    b.setAttribute('aria-label', '额度' + (S.glow ? '：' + GLOW_TXT[S.glow] : ''));
  }
  function paintGlow() {
    if (TQ) return;
    [].forEach.call(document.querySelectorAll('.xc-glow'), paintOne);
    if (isleEl) { isleEl.classList.remove('g-ok', 'g-warn', 'g-high', 'g-out'); if (S.glow) isleEl.classList.add('g-' + S.glow); }
  }
  function glowAv(cls, avCls) {
    var b = h('button', 'xc-glow' + (cls ? ' ' + cls : '')); b.type = 'button'; b.setAttribute('aria-haspopup', 'dialog'); b.setAttribute('aria-expanded', 'false'); b.setAttribute('aria-label', '额度');
    b.appendChild(avatar(avCls || ''));
    b.addEventListener('click', function (e) { e.stopPropagation(); if (!S.authed) { work(); return; } openQuota(b); });
    paintOne(b);
    return b;
  }
  function qlv(u) { return u >= 1 ? 'out' : u >= 0.9 ? 'high' : u >= 0.7 ? 'warn' : 'ok'; }
  // 重置、用完的时间：今天写几点，明天写「明天」，一周内写星期几，再远写日期
  function clock(t) {
    var d = new Date(t), n = new Date(), p = function (x) { return (x < 10 ? '0' : '') + x; }, hm = p(d.getHours()) + ':' + p(d.getMinutes());
    var day = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - new Date(n.getFullYear(), n.getMonth(), n.getDate())) / 864e5);
    return day === 0 ? hm : day === 1 ? '明天 ' + hm : day > 1 && day < 7 ? '周' + '日一二三四五六'[d.getDay()] + ' ' + hm : (d.getMonth() + 1) + '月' + d.getDate() + '日';
  }
  function loadUsage(fresh) {
    if (!fresh && S.uv && Date.now() - S.uvAt < 30000) return Promise.resolve(S.uv);
    return call('usage', {}, 60000).then(function (d) { if (d && d.error) throw new Error(d.msg || d.error); S.uv = d; S.uvAt = Date.now(); return d; });
  }
  function quotaRows(box, u) {
    var qs = (u && u.quotas) || [];
    if (!qs.length) { box.appendChild(h('p', 'xq-hint', '还没读到额度：和小芯聊一句或者派个活之后就有了。')); return; }
    qs.forEach(function (q) {
      var m = h('div', 'xq-m'), fc = [];
      m.appendChild(h('p', 'xq-name', q.name));
      (q.windows || []).filter(function (w) { return w.kind === '5h' || w.kind === 'week'; }).forEach(function (w) {
        var pct = Math.round(w.used * 100), name = w.kind === '5h' ? '5 小时' : '每周', row = h('div', 'xq-row lv-' + qlv(w.used)), bar = h('span', 'xq-bar'), fill = h('i');
        var reset = w.reset ? '已重置' : clock(w.resetAt) + ' 重置';
        row.setAttribute('role', 'group'); row.setAttribute('aria-label', q.name + name + '额度已用 ' + pct + '%，' + reset);
        row.appendChild(h('span', 'xq-k', name)); fill.style.width = pct + '%'; bar.appendChild(fill); row.appendChild(bar);
        row.appendChild(h('span', 'xq-v', pct + '%')); row.appendChild(h('span', 'xq-r', reset));
        m.appendChild(row);
        if (w.forecastAt) fc.push(name + '额度照现在的速度 ' + clock(w.forecastAt) + ' 用完');
      });
      fc.forEach(function (t) { m.appendChild(h('p', 'xq-fc', t)); });
      if (q.checkedAt) m.appendChild(h('p', 'xq-at', ago(q.checkedAt) + '读取'));
      box.appendChild(m);
    });
  }
  var quotaEl = null, quotaFrom = null;
  function quotaKey(e) { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeQuota(); } }
  function quotaOut(e) { if (quotaEl && !quotaEl.querySelector('.xq').contains(e.target) && !(quotaFrom && quotaFrom.contains(e.target))) closeQuota(); }
  function closeQuota(keepFocus) {
    if (!quotaEl) return;
    quotaEl.remove(); quotaEl = null;
    document.removeEventListener('keydown', quotaKey, true); document.removeEventListener('pointerdown', quotaOut, true); removeEventListener('resize', closeQuota);
    var from = quotaFrom; quotaFrom = null;
    if (from) from.setAttribute('aria-expanded', 'false');
    if (!keepFocus && from && from.isConnected) from.focus();
  }
  // 电脑、平板贴着头像弹出；手机从底部升起来（CSS 管）
  function placeQuota(card, btn) {
    if (innerWidth < 600) { card.style.left = card.style.top = ''; return; }
    var r = btn.getBoundingClientRect(), w = card.offsetWidth, hh = card.offsetHeight;
    var left = Math.max(12, Math.min(r.left - 4, innerWidth - w - 12)), top = r.bottom + 8;
    if (top + hh > innerHeight - 12 && r.top - hh - 8 > 12) top = r.top - hh - 8;
    card.style.left = left + 'px'; card.style.top = Math.max(12, top) + 'px';
  }
  function openQuota(btn) {
    if (quotaEl) { var same = quotaFrom === btn; closeQuota(); if (same) return; }
    quotaFrom = btn; btn.setAttribute('aria-expanded', 'true');
    var wrap = h('div', 'xq-wrap'), card = h('section', 'xq');
    card.setAttribute('role', 'dialog'); card.setAttribute('aria-label', '额度'); card.tabIndex = -1;
    card.appendChild(h('p', 'xq-hint', '正在读取…'));
    wrap.appendChild(h('div', 'xq-scrim')); wrap.appendChild(card); document.body.appendChild(wrap); quotaEl = wrap;
    placeQuota(card, btn); card.focus();
    document.addEventListener('keydown', quotaKey, true); document.addEventListener('pointerdown', quotaOut, true); addEventListener('resize', closeQuota);
    loadUsage().then(function (u) {
      if (quotaEl !== wrap) return;
      card.innerHTML = '';
      var hd = h('div', 'xq-hd'); hd.appendChild(h('b', '', '额度')); card.appendChild(hd);
      quotaRows(card, u);
      var more = h('button', 'xq-more'); more.type = 'button'; more.innerHTML = '<span>用量</span>' + svgIcon('chev');
      more.addEventListener('click', function () { closeQuota(true); openUsage(); });
      card.appendChild(more);
      placeQuota(card, btn);
    }, function (e) { if (quotaEl !== wrap) return; card.innerHTML = ''; card.appendChild(h('p', 'xq-hint', '读取失败：' + e.message)); });
  }
  // 用量页的模型颜色跟着模型走、不跟着排名走（dataviz 参考调色板的前六个，浅色 / 深色都验过色盲可分）；别的模型并成「其他」
  var SERIES = ['gemini-4-hydrogen', 'deepseek-v4.1-flash', 'glm-5.3', 'kimi-k3.1-pro', 'glm-5.3-flash', 'gemini-4-neon', 'gemini-4-argon'];
  function seriesOf(id) { var i = SERIES.indexOf(id); return i >= 0 ? 's' + (i + 1) : 'so'; }
  var RANGES = [['1', '今天'], ['7', '7 天'], ['30', '30 天']];
  function openUsage() {
    var p = S.open && S.wb ? null : work();
    Promise.resolve(p).then(function () {
      S.sheetTask = null; clearTimeout(S.uTm);
      sheetHead('用量');
      var box = h('div', 'xc-sh-list xu'); box.appendChild(h('p', 'xc-hint', '正在读取…'));
      sheetEl.appendChild(box); setSheet(true);
      var x = sheetEl.querySelector('.xc-sh-x'); if (x) x.focus();
      var load = function (fresh) {
        loadUsage(fresh).then(function (u) {
          if (!S.sheet || !box.isConnected) return;
          renderUsagePage(box, u);
          S.uTm = setTimeout(function () { if (S.sheet && box.isConnected && !document.hidden) load(true); }, 60000);
        }, function (e) { if (box.isConnected) { box.innerHTML = ''; box.appendChild(h('p', 'xc-hint', '读取失败：' + e.message)); } });
      };
      load(false);
    });
  }
  /* 用量页（站长 2026-11-16：「把网关和谷歌的分开」）：最上面「电脑」（叫醒电脑，「状态」这一行紧跟在下面）；
     下面「Google | 网关」切换（记在这个浏览器里），额度（只有 Google 有）、范围、合计、每天的柱子、图例和按模型列表都只算这一边。
     模型属于哪边看控制器给的 sources，旧控制器没有就按名字猜 */
  var SRCS = [['google', 'Google'], ['gateway', '网关'], ['other', '其他']];
  function srcOf(u, id) { var m = u.sources && u.sources[id]; if (m) return m; return /^gemini/i.test(id) ? 'google' : /^(?:glm|kimi|deepseek|qwen)/i.test(id) ? 'gateway' : 'other'; }
  function renderUsagePage(box, u) {
    S.uRange = S.uRange || '7';
    var used = {}; (u.days || []).forEach(function (d) { Object.keys(d.models || {}).forEach(function (id) { used[srcOf(u, id)] = true; }); });
    var srcs = SRCS.filter(function (x) { return x[0] !== 'other' || used.other; });
    if (TQ) S.uSrc = 'gateway';
    else {
      if (!S.uSrc) S.uSrc = ls(LS_PFX + 'uSrc') || 'google';
      if (!srcs.some(function (x) { return x[0] === S.uSrc; })) S.uSrc = 'google';
    }
    box.innerHTML = '';
    // 待送达记下的叫醒耗时（docs/xin-kernel-design.md §12：超过 45 秒的多了再想别的办法）
    var wake = u.wake && u.wake.count > 0, own = ownerLine(u.owner);
    if (wake || own) box.appendChild(h('p', 'wk-h', '电脑'));
    if (wake) box.appendChild(h('p', 'xu-wake', '叫醒电脑：最近 ' + u.wake.count + ' 次，一般 ' + Math.round(u.wake.p50 / 1000) + ' 秒，最长 ' + Math.round(u.wake.max / 1000) + ' 秒'));
    // 状态由谁在管（第 2 批：内核外壳拉起、看住的常驻状态进程）；旧 Worker、exec 通道没有 owner，就不显示
    if (own) box.appendChild(h('p', 'xu-owner', own));
    var sb = h('div', 'xu-sb');
    if (!TQ) {
      var ss = h('div', 'xu-seg xu-src'); ss.setAttribute('role', 'tablist'); ss.setAttribute('aria-label', '来源');
      srcs.forEach(function (x) {
        var b = h('button', 'xu-sc' + (x[0] === S.uSrc ? ' on' : ''), x[1]); b.type = 'button'; b.setAttribute('role', 'tab'); b.dataset.src = x[0];
        b.setAttribute('aria-selected', x[0] === S.uSrc ? 'true' : 'false');
        b.addEventListener('click', function () {
          if (S.uSrc === x[0]) return; S.uSrc = x[0]; ls(LS_PFX + 'uSrc', x[0] === 'google' ? null : x[0]);
          [].forEach.call(ss.children, function (y) { var on = y === b; y.classList.toggle('on', on); y.setAttribute('aria-selected', on ? 'true' : 'false'); });
          usageSrc(sb, u, true);
        });
        ss.appendChild(b);
      });
      box.appendChild(ss);
    }
    box.appendChild(sb);
    usageSrc(sb, u);
  }
  function usageSrc(sb, u, swap) {
    sb.innerHTML = '';
    if (swap) { sb.classList.remove('swap'); void sb.offsetWidth; sb.classList.add('swap'); }
    if (S.uSrc === 'google' && (u.quotas || []).length) { sb.appendChild(h('p', 'wk-h', '额度')); var q = h('div', 'xu-q'); quotaRows(q, u); sb.appendChild(q); }
    sb.appendChild(h('p', 'wk-h', '用了多少'));
    var seg = h('div', 'xu-seg'); seg.setAttribute('role', 'tablist'); seg.setAttribute('aria-label', '时间范围');
    var body = h('div', 'xu-body');
    RANGES.forEach(function (r) {
      var b = h('button', 'xu-rg' + (r[0] === S.uRange ? ' on' : ''), r[1]); b.type = 'button'; b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', r[0] === S.uRange ? 'true' : 'false');
      b.addEventListener('click', function () {
        if (S.uRange === r[0]) return; S.uRange = r[0];
        [].forEach.call(seg.children, function (x) { var on = x === b; x.classList.toggle('on', on); x.setAttribute('aria-selected', on ? 'true' : 'false'); });
        usageBody(body, u);
      });
      seg.appendChild(b);
    });
    sb.appendChild(seg); sb.appendChild(body);
    usageBody(body, u);
  }
  function ownerLine(o) {
    if (!o || typeof o !== 'object') return '';
    if (o.phase === 'running') {
      var up = Math.max(0, Number(o.up) || 0), all = o.ops && o.ops.all;
      var dur = up >= 3600000 ? Math.floor(up / 3600000) + ' 小时' : up >= 60000 ? Math.floor(up / 60000) + ' 分钟' : '不到 1 分钟';
      var p50 = all && all.n > 0 && typeof all.p50 === 'number' && isFinite(all.p50) ? '，操作一般 ' + Math.max(1, Math.round(all.p50)) + ' 毫秒' : '';
      return '状态：常驻进程在管（已切换 ' + (Number(o.epoch) || 0) + ' 次，这次运行了 ' + dur + p50 + '）';
    }
    // 删旧模式第 2 步：没有旧方式了。起不来就先停一下、看护接着重试
    if (o.phase === 'down') return '状态：常驻进程起不来（' + (o.lastError || '原因不明') + '），' + (TQ ? '先停一下，正在重试' : '小芯先停一下，正在重试');
    if (o.phase === 'starting' || o.phase === 'waiting' || o.phase === 'stopping') return '状态：正在换常驻进程';
    return '状态：常驻进程没在运行';
  }
  function usageBody(body, u) {
    body.innerHTML = '';
    var n = +S.uRange, src = S.uSrc || 'google', mine = function (id) { return srcOf(u, id) === src; };
    // 只算这一边的模型：合计按天加起来（控制器的 totals 是两边加在一起的）
    var days = (u.days || []).slice(-n).map(function (d) { var m = {}; Object.keys(d.models || {}).forEach(function (id) { if (mine(id)) m[id] = d.models[id]; }); return { date: d.date, models: m }; });
    var t = { input: 0, output: 0, cached: 0, runs: 0, hit: null };
    days.forEach(function (d) { Object.keys(d.models).forEach(function (id) { var m = d.models[id]; t.input += m.input || 0; t.cached += m.cached || 0; t.output += m.output || 0; t.runs += m.runs || 0; }); });
    t.hit = t.input > 0 ? t.cached / t.input : null;
    var names = u.names || {}, nm = function (id) { return id === '其他' ? '其他' : names[id] || id; };
    body.appendChild(h('p', 'xu-sum', '共 ' + tok(t.input + t.output) + ' token（输入 ' + tok(t.input) + '、输出 ' + tok(t.output) + '）' +
      (t.hit == null ? '' : '，缓存命中 ' + Math.round(t.hit * 100) + '%') + '，' + t.runs + ' 轮'));
    // 每天按模型合计（不在 SERIES 里的并成「其他」）
    var perDay = days.map(function (d) {
      var by = {};
      Object.keys(d.models || {}).forEach(function (id) { var m = d.models[id], k = SERIES.indexOf(id) >= 0 ? id : '其他'; by[k] = (by[k] || 0) + (m.input || 0) + (m.output || 0); });
      return { date: d.date, by: by, total: Object.keys(by).reduce(function (a, k) { return a + by[k]; }, 0) };
    });
    var max = Math.max.apply(null, perDay.map(function (d) { return d.total; }).concat([0]));
    var order = SERIES.concat(['其他']);
    var wrap = h('div', 'xu-cw'), chart = h('div', 'xu-chart n' + n), tip = h('div', 'xu-tip'); tip.hidden = true;
    chart.setAttribute('role', 'list'); chart.setAttribute('aria-label', '每天的 token');
    if (max > 0) chart.appendChild(h('span', 'xu-max', tok(max)));
    var today = u.days && u.days.length ? u.days[u.days.length - 1].date : '';
    var dname = function (date) { return date === today ? '今天' : (+date.slice(5, 7)) + '月' + (+date.slice(8, 10)) + '日'; };
    perDay.forEach(function (d) {
      var col = h('div', 'xu-day' + (d.total ? '' : ' empty')); col.tabIndex = 0; col.setAttribute('role', 'listitem');
      var lines = order.filter(function (k) { return d.by[k]; }).map(function (k) { return nm(k) + ' ' + tok(d.by[k]); });
      col.setAttribute('aria-label', dname(d.date) + '：' + (d.total ? tok(d.total) + ' token，' + lines.join('，') : '没有用量'));
      var stack = h('div', 'xu-col'); stack.style.height = (max ? d.total / max * 100 : 0) + '%';
      order.forEach(function (k) { if (!d.by[k]) return; var b = h('span', 'xu-b ' + seriesOf(k)); b.style.flexGrow = d.by[k]; stack.appendChild(b); });
      col.appendChild(stack);
      var show = function () {
        tip.innerHTML = ''; tip.appendChild(h('b', '', dname(d.date) + ' · ' + tok(d.total) + ' token'));
        order.forEach(function (k) { if (!d.by[k]) return; var r = h('span', 'xu-tr'); r.appendChild(h('i', 'xu-sw ' + seriesOf(k))); r.appendChild(document.createTextNode(nm(k) + ' ' + tok(d.by[k]))); tip.appendChild(r); });
        tip.hidden = false;
        var cr = wrap.getBoundingClientRect(), br = col.getBoundingClientRect();
        tip.style.left = Math.max(0, Math.min(br.left - cr.left + br.width / 2 - tip.offsetWidth / 2, cr.width - tip.offsetWidth)) + 'px';
      };
      var hide = function () { tip.hidden = true; };
      col.addEventListener('pointerenter', show); col.addEventListener('focus', show);
      col.addEventListener('pointerleave', hide); col.addEventListener('blur', hide);
      chart.appendChild(col);
    });
    wrap.appendChild(chart); wrap.appendChild(tip);
    var ax = h('div', 'xu-ax');
    if (perDay.length) { ax.appendChild(h('span', '', perDay.length > 1 ? dname(perDay[0].date) : '')); ax.appendChild(h('span', '', dname(perDay[perDay.length - 1].date))); }
    wrap.appendChild(ax);
    body.appendChild(wrap);
    // 图例（两个以上模型才有意义，但一直给：颜色不能是唯一的区分）和按模型列表
    var sums = {};
    perDay.forEach(function (d) { Object.keys(d.by).forEach(function (k) { sums[k] = (sums[k] || 0) + d.by[k]; }); });
    var present = order.filter(function (k) { return sums[k]; });
    if (present.length) {
      var lg = h('ul', 'xu-lg'); lg.setAttribute('aria-label', '图例');
      present.forEach(function (k) { var li = h('li'); li.appendChild(h('i', 'xu-sw ' + seriesOf(k))); li.appendChild(document.createTextNode(nm(k))); lg.appendChild(li); });
      body.appendChild(lg);
      var all = present.reduce(function (a, k) { return a + sums[k]; }, 0), list = h('div', 'xu-ms');
      present.slice().sort(function (a, b) { return sums[b] - sums[a]; }).forEach(function (k) {
        var r = h('div', 'xu-m'); r.appendChild(h('i', 'xu-sw ' + seriesOf(k))); r.appendChild(h('span', 'xu-mn', nm(k)));
        r.appendChild(h('span', 'xu-mv', tok(sums[k]))); r.appendChild(h('span', 'xu-mp', Math.round(sums[k] / all * 100) + '%')); list.appendChild(r);
      });
      body.appendChild(list);
    } else body.appendChild(h('p', 'xc-hint', '这段时间没有用量记录。'));
  }

  /* 首页上的「小芯」：一块终端屏，最近在做的、做好的几行，最后一行直接打字。
     点哪里都进工作台：点任务打开那个任务；回车把话发到主对话。网站没开小芯聊天时不显示。 */
  var homeEl = null;
  function homeShown() { return !!homeEl && !homeEl.hidden && !document.hidden && !document.body.classList.contains('tool-open') && !(S.open && S.wb); }
  function buildHome() {
    if (TQ) return;
    var slot = document.getElementById('xinWork'); if (!slot || homeEl) return;
    homeEl = slot;
    slot.innerHTML = '<h2 class="cat-h">小芯</h2><div class="xw-card"><div class="xw-top"><button class="xw-head" type="button"><span class="xw-who"><b>工作台</b><span class="xw-st"><i></i><em></em></span></span><span class="xw-go" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M9.5 7.5 14 12l-4.5 4.5"/></svg></span></button></div>' +
      '<div class="xw-term"><ul class="xw-list"></ul><form class="xw-ask"><span class="xw-caret" aria-hidden="true">&gt;</span><input type="text" autocomplete="off" enterkeyhint="send" aria-label="和小芯说"><button type="submit" class="xw-send" aria-label="发送"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13M13 6l6 6-6 6"/></svg></button></form></div></div>';
    var head = slot.querySelector('.xw-head');
    head.parentNode.insertBefore(glowAv('xw-glow', 'xw-av'), head);
    head.setAttribute('aria-label', '打开小芯工作台');
    head.addEventListener('click', function () { work(); });
    var form = slot.querySelector('.xw-ask'), inp = form.querySelector('input');
    inp.value = ls(LS_PFX + 'homeDraft') || '';
    inp.addEventListener('input', function () { ls(LS_PFX + 'homeDraft', inp.value || null); form.classList.toggle('has', !!inp.value.trim()); });
    form.classList.toggle('has', !!inp.value.trim());
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var t = inp.value.trim();
      if (!t) { work(); return; }
      inp.value = ''; ls(LS_PFX + 'homeDraft', null); form.classList.remove('has'); inp.blur();
      homeSend(t);
    });
    slot.querySelector('.xw-term').addEventListener('click', function (e) { if (e.target === this || e.target.classList.contains('xw-list')) inp.focus(); });
    renderHome();
  }
  // 首页打的字：进工作台，发到主对话（正在回上一句就先排着）；没登录先登录，话留在输入框里
  function homeSend(text) {
    if (TQ) return;
    if (!root) build();
    if (S.authed) {
      if (S.main) { if (S.sid !== S.main) { detachConversation(); stopPolling(); typing(false); S.run = ''; S.sid = S.main; ls(LS_SID, S.main); S.histFor = ''; } }
      else if (S.sid || !S.toMain) newChat(true, true);
    }
    var p = work();
    Promise.resolve(p).then(function () {
      if (!S.authed || S.agent !== 'codex' && !S.sid) { input.value = text; ls(LS_DRAFT, text); grow(); renderSendBtn(); return; }
      if (S.run || S.sending || S.loadingConversation) queueMsg(text); else send(text);
    });
  }
  function renderHome() {
    if (TQ || !homeEl) return;
    homeEl.hidden = !S.enabled;
    if (!S.enabled) return;
    var st = homeEl.querySelector('.xw-st'), inp = homeEl.querySelector('.xw-ask input'), g = groups();
    var busy = g.live.length > 0, state = !S.authed ? 'off' : busy ? 'busy' : S.mstate === 'running' ? 'on' : S.mstate ? 'sleep' : '';
    st.className = 'xw-st ' + state;
    st.lastChild.textContent = { off: '未登录', busy: '在忙', on: '在线', sleep: '休息中', '': '' }[state];
    inp.placeholder = S.authed ? '给小芯发消息' : '登录后可以聊天';
    var ul = homeEl.querySelector('.xw-list');
    var rows = g.live.concat(g.wait, g.done).slice(0, 3);
    var sig = rows.map(function (t) { return t.sid + t.status + (t.activity || ''); }).join('|') + S.authed;
    if (ul.dataset.sig !== sig) {
      ul.dataset.sig = sig; ul.textContent = '';
      rows.forEach(function (t) {
        var kind = tLive(t) ? 'run' : t.status === 'waiting' ? 'wait' : t.status === 'failed' ? 'bad' : t.status === 'stopped' ? 'stop' : 'ok';
        var li = h('li'), b = h('button', 'xw-t ' + kind + (xwSeen[t.sid + kind] ? '' : ' new')); b.type = 'button'; b.dataset.tsid = t.sid;
        xwSeen[t.sid + kind] = true; phase(b);
        b.appendChild(h('i', 'xw-g')); b.appendChild(h('span', 'xw-tt', t.title)); b.appendChild(h('time', 'xw-tm'));
        b.setAttribute('aria-label', t.title + ' ' + (TSTAT[t.status] || ''));
        b.addEventListener('click', function () { var p = work(); Promise.resolve(p).then(function () { openTask(t.sid); }); });
        li.appendChild(b); ul.appendChild(li);
      });
    }
    [].forEach.call(ul.querySelectorAll('.xw-t'), function (b) {
      var t = S.tinfo[b.dataset.tsid] || rows.filter(function (x) { return x.sid === b.dataset.tsid; })[0]; if (!t) return;
      b.querySelector('.xw-tm').textContent = tLive(t) ? (t.status === 'queued' ? (t.retryAt > Date.now() ? '稍后重试' : '排队中') : dur(Date.now() - (t.startedAt || t.created || Date.now()))) : t.status === 'waiting' ? (waitLeft(t) || '待处理') : ago(t.endedAt || t.created || Date.now());
    });
    ul.hidden = !rows.length;
  }
  // 在做的任务计时、「几分钟前」每 15 秒走一下
  if (!TQ) setInterval(function () { if (!document.hidden && (homeShown() || workShown())) { renderHome(); if (workShown()) renderWork(); } }, 15000);

  /* ---------- 「＋」菜单、插件 ---------- */
  function setMenu(on) {
    if (!menuEl) return;
    menuEl.hidden = !on;
    root.querySelector('.xc-plus').setAttribute('aria-expanded', on ? 'true' : 'false');
  }
  function setSheet(on) {
    on = !!on;
    if (on && S.tray) setTray(false, false, true);
    if (TQ && on && S.drawer) setDrawer(false);
    S.sheet = on; sheetEl.hidden = !on; sheetEl.style.transform = '';
    root.classList.toggle('sheet-open', on);
    if (TQ) {
      var trigger = root.querySelector('.tq-plug-b'), wasOpen = trigger.getAttribute('aria-expanded') === 'true';
      trigger.setAttribute('aria-expanded', on && sheetEl.classList.contains('tq-plugins') ? 'true' : 'false');
      if (!on && wasOpen && !trigger.hidden) trigger.focus({ preventScroll: true });
    }
    if (on && !sheetEl._drag) dragSheet();
  }
  // 手机上的底部页：按住顶上那一条往下拖，松手超过 90px（或者甩得快）就关掉，不够就弹回去
  function dragSheet() {
    sheetEl._drag = true;
    var y0 = 0, t0 = 0, dy = 0, on = false;
    sheetEl.addEventListener('pointerdown', function (e) {
      if (e.pointerType === 'mouse' || !e.target.closest('.xc-sh-hd') || e.target.closest('button') || getComputedStyle(sheetEl).position === 'static') return;
      if (sheetEl.getBoundingClientRect().bottom < innerHeight - 2) return;   // 侧边一栏（电脑）不拖
      on = true; y0 = e.clientY; t0 = performance.now(); dy = 0; sheetEl.classList.add('drag');
      try { sheetEl.setPointerCapture(e.pointerId); } catch (er) { /* 不支持就算了 */ }
    });
    sheetEl.addEventListener('pointermove', function (e) { if (!on) return; dy = Math.max(0, e.clientY - y0); sheetEl.style.transform = 'translateY(' + dy + 'px)'; });
    var end = function () {
      if (!on) return; on = false; sheetEl.classList.remove('drag');
      var v = dy / Math.max(1, performance.now() - t0);
      if (dy > 90 || v > .6) { sheetEl.classList.add('away'); setTimeout(function () { sheetEl.classList.remove('away'); setSheet(false); }, 180); }
      else sheetEl.style.transform = '';
    };
    sheetEl.addEventListener('pointerup', end); sheetEl.addEventListener('pointercancel', end);
  }
  // 插件开关记在当前模式的电脑上，从下一句开始生效。
  var PLUG_NAME = { purge: 'Purge', rea: 'REA 逆向', instabox: 'InstaBox', 'open-computer-use': '操作桌面' };
  function openPlugins() {
    var agent = curAgent();
    sheetHead(TQ ? '天启插件' : AGENTS[agent] + ' 插件');
    if (TQ) sheetEl.classList.add('tq-plugins');
    var box = h('div', 'xc-sh-list'); box.appendChild(h('p', 'xc-hint', '正在读取…'));
    sheetEl.appendChild(box);
    setSheet(true);
    if (TQ) sheetEl.querySelector('.xc-sh-x').focus({ preventScroll: true });
    call('plugins', { agent: agent }, 60000).then(function (d) {
      if (d && d.error) throw new Error(d.msg || d.error);
      S.plugins = d.plugins || [];
      box.innerHTML = '';
      if (!S.plugins.length) { box.appendChild(h('p', 'xc-hint', '还没有自己装的插件。')); return; }
      S.plugins.forEach(function (p) {
        var t = toggleRow('xc-plug-' + p.name, PLUG_NAME[p.name] || p.name, TQ ? p.desc : '');
        t.set(p.on); t.row.dataset.name = p.name;
        var pending = TQ ? 'aria-disabled' : 'disabled';
        t.btn.addEventListener('click', function () {
          if (t.btn.hasAttribute(pending)) return;
          var want = !p.on; t.btn.setAttribute(pending, 'true'); t.note('');
          call('plugin_set', { agent: agent, name: p.name, on: want }, 60000).then(function (r) {
            if (r && r.error) throw new Error(r.msg || r.error);
            p.on = r.on; t.set(p.on);
          }).catch(function (e) { t.note('修改失败：' + e.message); }).finally(function () { t.btn.removeAttribute(pending); });
        });
        box.appendChild(t.row);
      });
    }).catch(function (e) { box.innerHTML = ''; box.appendChild(h('p', 'xc-hint', '读取失败：' + e.message)); });
  }

  /* ---------- 发图片和文件 ----------
     选好马上传到小芯的电脑（/api/xin/upload → 它工作目录的 uploads/日期/），输入框上面一排显示，能去掉；
     传完了才能发。图片太大先在手机上压一下（长边 2048、JPEG），省流量也省 token。一次最多 10 个、每个 100 MB 以内（网站那边收请求的上限）。 */
  var ATT_MAX = 10, ATT_SIZE = 100 * 1024 * 1024, attSeq = 0;
  function attsBusy() { return (S.atts || []).some(function (a) { return a.state === 'up'; }); }
  function addFiles(fl) {
    S.atts = S.atts || [];
    var arr = [].slice.call(fl || []);
    if (!arr.length) return;
    setMenu(false);
    var room = ATT_MAX - S.atts.length;
    if (arr.length > room) { setStatus('一次最多发 ' + ATT_MAX + ' 个文件', 'bad'); setTimeout(function () { setStatus(''); }, 3000); arr = arr.slice(0, Math.max(0, room)); }
    arr.forEach(function (f) {
      var img = /^image\/(png|jpeg|gif|webp|heic|heif)$/i.test(f.type || '');
      var a = { id: ++attSeq, name: f.name || (img ? 'image.jpg' : 'file'), size: f.size, image: img, blob: f, state: 'up', pct: 0 };
      if (img) { try { a.url = URL.createObjectURL(f); } catch (e) { /* 没有预览也能传 */ } }
      S.atts.push(a);
      if (f.size > ATT_SIZE) { a.state = 'err'; a.err = '太大了（最大 100 MB）'; return; }
      (img ? shrink(f) : Promise.resolve(null)).then(function (b) {
        if (b) { a.blob = b; a.size = b.size; a.name = a.name.replace(/\.[^.]*$/, '') + '.jpg'; }
        if (S.atts.indexOf(a) >= 0) upload(a, 0);
      });
    });
    renderAtts(); render();
    if (!touch) input.focus();
  }
  function shrink(f) {
    return new Promise(function (ok) {
      if (!/^image\/(jpeg|png|webp|heic|heif)$/i.test(f.type) || !window.createImageBitmap) { ok(null); return; }
      createImageBitmap(f).then(function (bm) {
        var k = Math.min(1, 2048 / Math.max(bm.width, bm.height));
        if (k === 1 && f.size < 1.5e6 && /jpeg|png|webp/i.test(f.type)) { ok(null); return; }
        var c = document.createElement('canvas'); c.width = Math.round(bm.width * k); c.height = Math.round(bm.height * k);
        var g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(bm, 0, 0, c.width, c.height);
        c.toBlob(function (b) { ok(b && (b.size < f.size || /heic|heif/i.test(f.type)) ? b : null); }, 'image/jpeg', 0.86);
      }).catch(function () { ok(null); });
    });
  }
  function upload(a, tries) {
    var x = new XMLHttpRequest(); a.xhr = x;
    x.open('POST', API + 'upload?name=' + encodeURIComponent(a.name));
    x.setRequestHeader('x-xin', '1'); x.setRequestHeader('Content-Type', 'application/octet-stream');
    x.upload.onprogress = function (e) { if (e.lengthComputable) { a.pct = Math.round(e.loaded / e.total * 100); renderAtt(a); } };
    x.onload = function () {
      var d = null; try { d = JSON.parse(x.responseText); } catch (e) { /* 不是 JSON */ }
      if (S.atts.indexOf(a) < 0) return;
      if (x.status === 200 && d && d.ok && d.data) { a.state = 'ok'; a.path = d.data.path; a.name = d.data.name; a.image = !!d.data.image; a.note = ''; }
      else if (d && d.state === 'waking' && tries < 30) { a.note = '唤醒中'; renderAtt(a); setTimeout(function () { if (S.atts.indexOf(a) >= 0) upload(a, tries + 1); }, 3000); return; }
      else { a.state = 'err'; a.err = (d && (d.msg || d.error)) || (x.status === 413 ? '太大了（最大 100 MB）' : '没传上去（' + x.status + '）'); }
      renderAtts(); render();
    };
    x.onerror = function () { if (S.atts.indexOf(a) < 0) return; a.state = 'err'; a.err = '网络断了'; renderAtts(); render(); };
    x.send(a.blob);
  }
  function removeAtt(a) {
    if (a.xhr && a.state === 'up') { try { a.xhr.abort(); } catch (e) { /* 已经完了 */ } }
    S.atts = (S.atts || []).filter(function (b) { return b !== a; });
    renderAtts(); render();
  }
  function attLine(a) { return a.state === 'err' ? a.err : a.state === 'up' ? (a.note || ('上传中 ' + (a.pct || 0) + '%')) : fmtSize(a.size); }
  function renderAtt(a) {
    var e = attsEl && attsEl.querySelector('[data-att="' + a.id + '"]');
    if (!e) return;
    e.className = 'xc-att' + (a.image ? ' img' : '') + ' ' + a.state;
    var m = e.querySelector('.xc-att-m'); if (m) m.textContent = attLine(a);
    var bar = e.querySelector('.xc-att-bar i'); if (bar) bar.style.width = (a.state === 'up' ? a.pct || 0 : 100) + '%';
  }
  function renderAtts() {
    if (!attsEl) return;
    var l = S.atts || [];
    attsEl.hidden = !l.length; attsEl.innerHTML = '';
    l.forEach(function (a) {
      var e = h('div', ''); e.dataset.att = a.id;
      if (a.image && a.url) { var im = h('img', 'xc-att-p'); im.src = a.url; im.alt = ''; e.appendChild(im); }
      else e.appendChild(h('span', 'xc-att-ic', ''));
      if (!(a.image && a.url)) e.querySelector('.xc-att-ic').innerHTML = FILE_ICON.file;
      var t = h('span', 'xc-att-t'); t.appendChild(h('b', '', a.name)); t.appendChild(h('i', 'xc-att-m', '')); e.appendChild(t);
      var bar = h('span', 'xc-att-bar'); bar.appendChild(h('i')); e.appendChild(bar);
      var x = h('button', 'xc-att-x'); x.type = 'button'; x.setAttribute('aria-label', '去掉 ' + a.name); x.innerHTML = svgIcon('x');
      x.addEventListener('click', function () { removeAtt(a); });
      e.appendChild(x);
      attsEl.appendChild(e); renderAtt(a);
    });
  }
  // 消息里的附件：图片显示缩略图（点开看大图），别的文件一个小卡片（点开在「小芯的文件」里预览、下载）
  function fileUrl(p, img) { return API + 'file?' + (img ? 'img=1&' : '') + 'path=' + encodeURIComponent(p); }
  function msgFiles(files) {
    var box = h('div', 'xc-mfiles');
    files.forEach(function (f) {
      if (f.image) {
        var a = h('a', 'xc-mimg'); a.href = fileUrl(f.path, true); a.target = '_blank'; a.rel = 'noopener';
        var im = h('img'); im.src = f.url || fileUrl(f.path, true); im.alt = f.name; im.loading = 'lazy';
        a.appendChild(im); box.appendChild(a);
      } else {
        var b = h('button', 'xc-mfile'); b.type = 'button';
        b.innerHTML = FILE_ICON.file; b.appendChild(h('span', '', f.name)); if (f.size != null) b.appendChild(h('i', '', fmtSize(f.size)));
        b.addEventListener('click', function () { loadFiles(f.path, 'chat'); });
        box.appendChild(b);
      }
    });
    return box;
  }

  /* ---------- 发消息 ---------- */
  // given：小芯旁边的输入框发来的话；prep：排队的几句合成的 {text, atts}；都没有就发输入框里的
  function send(given, prep) {
    var text = prep ? prep.text : given != null ? String(given).trim() : input.value.trim();
    var atts = prep ? prep.atts : given != null ? [] : (S.atts || []).filter(function (a) { return a.state === 'ok'; });
    if ((!text && !atts.length) || S.run || S.sending || S.loadingConversation) return false;
    if (given == null && !prep && attsBusy()) { setStatus('文件还没传完，传完再发', 'wait'); setTimeout(function () { setStatus(''); }, 2500); return false; }
    if (TQ && S.tqNoGw) { setStatus('天启的网关还没配好，暂时发不了消息。', 'bad'); return false; }
    S.sending = true;
    var retry=S.retrySend&&S.retrySend.text===text&&(S.retrySend.sid==null||S.retrySend.sid===S.sid)&&JSON.stringify(S.retrySend.atts||[])===JSON.stringify(atts)?S.retrySend:null;
    S.retrySend=null;
    var generation=S.convSeq,flight={generation:generation,sid:S.sid,id:prep&&prep.queued?prep.queued[0].id:retry?retry.id:crypto.randomUUID(),text:text,atts:atts,queued:prep&&prep.queued?prep.queued.map(function(v){return v.id;}):[]};S.sendFlight=flight;
    if (list.querySelector('.xc-hello')) clearList();
    var c = curCtx();
    var files = atts.map(function (a) { return { name: a.name, path: a.path, size: a.size, image: a.image, url: a.url }; });
    if (atts.length && !prep) { S.atts = []; renderAtts(); }
    var pending = draw({ t: 'user', text: text, ctx: c ? ctxLabel(c) : '', files: files });
    pending.classList.add('pending');
    if (given == null && !prep) { input.value = ''; ls(LS_DRAFT, null); grow(); }
    // 还没送到小芯的电脑：「正在输入」旁边写「接收中」（电脑在睡写「唤醒中」），送到了才「思考中」并开始计时
    S.lastText = ''; S.doing = 'think'; S.act = ''; S.thinkS = ''; S.thinkFixed = false; S.note = null; S.waitSend = '';
    typing(true); renderHead(); toBottom(true); if (!TQ) flyFromComposer(pending);
    var x = xin(); if (x) x.ai('think');
    flight.payload=retry&&retry.payload||{ sid: flight.sid || undefined, main: !TQ && !flight.sid && mainDraft() || undefined, clientId: flight.id, agent: flight.sid ? undefined : (TQ ? 'harness' : S.agent), text: text, effort: curEffort(), model: curModel(), context: c ? ctxText(c) : undefined, ctxLabel: c ? ctxLabel(c) : undefined,files:files.length?files.map(function(f){return {path:f.path,name:f.name};}):undefined};
    call('send', flight.payload, 90000, function (w) { if(generation===S.convSeq){S.waitSend = w.state; progress();} },function(){return generation===S.convSeq;}).then(function (d) {
      if (d && d._accepted) return waitDelivery(d.delivery, d, function () { return generation === S.convSeq; }, function (w) { if (generation === S.convSeq) { S.waitSend = w; progress(); } });
      return d;
    }).then(function (d) {
      // vm-agent 的软错误也包在 ok:true 的 data 里（busy / empty / no_session…），不能当发送成功
      if (d && d.error) {
        var er = new Error(d.msg || d.error);
        er.code = d.error; er.run = d.run; er.sid = d.sid;
        throw er;   // 交给后面的 catch（不能写在 then 的第二个参数里，那边接不住这里的 throw）
      }
      if(generation!==S.convSeq){settleDetachedSend(flight,d);return;}
      S.sendFlight=null;
      if (c && c.sel) S.sel = null;      // 选中的内容用过一次就不再带
      refreshCtx();
      // 送到了：小芯的电脑收到这句、AI 开始干活，从这一刻开始算「思考中」的时间
      S.sending = false; S.waitSend = ''; pending.classList.remove('pending');
      S.sid = d.sid; S.sessAgent = d.agent || S.sessAgent || (TQ ? 'harness' : S.agent); ls(LS_SID, d.sid); S.toMain = false; if (d.title) S.title = d.title;
      // 这句进了主对话，而这台设备还没读过它以前的内容：回完重读一遍，把前面的接上
      if (!TQ && d.main) { setMain(d.sid); if (d.turns > 1 && S.histFor !== d.sid) S.reload = d.sid; }
      if (prep && prep.queued) S.queueFlight = [];
      saveQueue();
      ls(LS_PFX + 'queue.pending', null);
      if (d.bg != null) S.bg = d.bg;
      glowFrom(d);
      S.runMeta[d.run] = Object.assign(S.runMeta[d.run] || {}, { prompt: S.runMeta[d.run] && S.runMeta[d.run].prompt || text || '' });   // 终端里「> 要求」那一行
      S.mine[d.run] = true; S.run = d.run; S.off = 0; S.pos = null; S.t0 = Date.now(); render(); typing(true); startPolling(); if (!flight.sid) refreshSide();
    }).catch(function (e) {
      if(generation!==S.convSeq){settleDetachedSend(flight,null,e);return;}
      S.sendFlight=null;
      S.sending = false; S.waitSend = ''; pending.remove(); typing(false); renderHead();
      if (prep && prep.queued) { S.queueFlight = []; prep.queued.forEach(function (v) { queueMsg(v.text, v); }); saveQueue(); }
      if (!(prep && prep.queued) && !input.value) { input.value = text; ls(LS_DRAFT, text); grow(); }
      if (!(prep && prep.queued) && atts.length && !(S.atts || []).length) { S.atts = atts; renderAtts(); render(); }   // 没发出去：附件放回去
      // 可能其实送到了、或者其实存上了（服务器说 resend）：再点发送沿用同一个 clientId，待送达和云电脑都认得出来，不会多一轮
      if (!(prep && prep.queued) && (e.state === 'timeout' || e.state === 'network' || e.resend)) S.retrySend = { id: flight.id, sid: flight.sid, text: text, atts: atts, payload: flight.payload };
      var x2 = xin(); if (x2) { x2.ai(''); x2.cmd('confused'); if (!S.open) x2.say('没发出去：' + e.message, 9000, open); }
      // 上一句还在跑（多标签最常见）：别弄脏 S.run，把输入还回去，重新打开同一对话接着看进行中的那一轮
      if (e.code === 'busy' || /还没做完/.test(e.message)) {
        setStatus('上一句还没做完，请稍后再试', 'wait');
        setTimeout(function () { setStatus(''); }, 4000);
        if (e.sid || S.sid) openSession(e.sid || S.sid);
        return;
      }
      draw({ t: 'err', text: (e.delivery ? '发送失败：' : '没发出去：') + e.message }); toBottom(true);
    });
  }
  /* ---------- 待送达（docs/xin-kernel-design.md §14.1）：这句已经存在 Cloudflare 上，等它送进云电脑 ----------
     电脑在睡、在冷却时不再报「没发出去」，一直显示「已收到 · …」，不设总时限（关掉页面它也会送到）。
     送到了 resolve 成和以前 send 一样的结果；24 小时都没送到等情况 reject，e.delivery 为真。 */
  function waitDelivery(view, first, current, onWait) {
    return new Promise(function (resolve, reject) {
      function step(v, hint) {
        if (v && v.state === 'delivered') { resolve(v.result || {}); return; }
        if (v && v.state === 'failed' && v.result) { resolve(v.result); return; }   // 控制器回的错误（找不到对话等），照以前的方式处理
        if (!v || v.error || v.state === 'failed') { var e = new Error((v && v.error && v.error.msg) || '这句话没找到，请再发一次'); e.delivery = true; reject(e); return; }
        var w = v.wait || {}, cool = w.state === 'cooldown';
        if (!current || current()) { S.waitUntil = cool ? w.until || 0 : 0; if (onWait) onWait(cool ? 'accepted-cooldown' : w.state === 'retrying' || w.state === 'busy' ? 'accepted-retrying' : 'accepted-waking'); }
        setTimeout(function () {
          call('delivery', { id: v.id }, 30000).then(function (nv) { step(nv && nv.id ? nv : nv && nv.error ? nv : v); }, function () { step(v); });
        }, cool ? 30000 : Math.max(2000, ((hint && hint.retryAfter) || 2) * 1000));
      }
      step(view, first);
    });
  }
  // 刷新页面、换设备回来：Cloudflare 上还有没送完的句子，画出当前对话里的那一句并接着等；别的对话的只在状态栏说一声
  S.waitingIds = {};
  function loadDeliveries() {
    if (!S.enabled || !S.authed) return;
    call('deliveries', {}, 30000).then(function (d) {
      S.failedDeliveries = (S.failedDeliveries || []).concat(((d && d.rows) || []).filter(function (r) { return r.state === 'failed' && !S.waitingIds[r.id]; }));
      S.deliveries = ((d && d.rows) || []).filter(function (r) { return r.state === 'pending' && !S.waitingIds[r.id]; });
      showDeliveries();
    }, function () {});
  }
  // 没有网页在等的时候才失败的（24 小时都没送到、送到时对话已经没了）：把那句话和原因画出来，不悄悄丢。
  // 这一次打开网页期间换到哪个对话都看得见；第一次画出来时向服务器确认读过了（delivery 读到终态就算确认），下次打开不再报
  function showFailedDeliveries() {
    (S.failedDeliveries || []).forEach(function (r) {
      if (list.querySelector('[data-delivery="' + r.id + '"]')) return;
      if (list.querySelector('.xc-hello')) clearList();
      draw({ t: 'user', text: r.text, files: (r.files || []).map(function (f) { return { name: f.name, path: f.path }; }) }).setAttribute('data-delivery', r.id);
      draw({ t: 'err', text: '发送失败：' + ((r.error && r.error.msg) || '原因不明') + '。这句没有送到' + (TQ ? '天启的电脑' : '小芯的电脑') + '，需要的话请重新发送' });
      if (!S.waitingIds[r.id]) { S.waitingIds[r.id] = true; call('delivery', { id: r.id }, 30000).catch(function () {}); }
      toBottom(true);
    });
  }
  function showDeliveries() {
    if (!list || S.loadingConversation) return;
    showFailedDeliveries();
    var rows = (S.deliveries || []).filter(function (r) { return !S.waitingIds[r.id]; });
    if (!rows.length) return;
    var mine = rows.filter(function (r) { return r.sid ? r.sid === S.sid : !S.sid; }), others = rows.length - mine.length;
    if (others > 0) setStatus('还有 ' + others + ' 句在' + (TQ ? '等天启醒来' : '等小芯醒来'), 'wait');
    var row = mine[0];
    if (!row || S.sending || S.run) return;
    S.waitingIds[row.id] = true;
    if (list.querySelector('.xc-hello')) clearList();
    var generation = S.convSeq, bubble = draw({ t: 'user', text: row.text, files: (row.files || []).map(function (f) { return { name: f.name, path: f.path }; }) });
    bubble.classList.add('pending');
    S.sending = true; S.doing = 'think'; S.act = ''; S.thinkS = ''; S.thinkFixed = false; typing(true); renderHead(); toBottom(true);
    waitDelivery(row, null, function () { return generation === S.convSeq; }, function (w) { if (generation === S.convSeq) { S.waitSend = w; progress(); } }).then(function (d) {
      if (generation !== S.convSeq) return;
      S.sending = false; S.waitSend = ''; bubble.classList.remove('pending');
      if (d && d.sid) openSession(d.sid); else { typing(false); renderHead(); }
    }, function (e) {
      if (generation !== S.convSeq) return;
      S.sending = false; S.waitSend = ''; bubble.remove(); typing(false); renderHead();
      draw({ t: 'err', text: '发送失败：' + e.message }); toBottom(true);
    });
  }
  /* ---------- 附带页面信息：发消息时告诉小芯你正在看什么 ----------
     在哪一页（学习台的标题 + 亮着的小标签）、最近 3 分钟里在网站上选中的文字、「验证」里写的代码。
     不是一直盯着：只在发消息那一下读一次；只发到你自己的云电脑。 */
  var SEL_MAX = 4000, CODE_MAX = 6000, SEL_AGE = 180000, watched = [];
  function watchDoc(d) {
    if (TQ || !d || watched.indexOf(d) >= 0) return;
    watched.push(d);
    // 记下最近一次选中的文字：点开输入框时选区会被清掉，所以选的那一刻就记。
    // 选区没了的时候分两种：是你点小芯、背包、输入框、面板（打开聊天）弄没的 → 留着；是你点了页面别处、自己取消的 → 马上忘掉
    var UI = '.xin, .xin-bag, .xin-ask, .xin-say, .xc';
    var lastDown = { ui: false, at: 0 };
    d.addEventListener('pointerdown', function (e) {
      var t = e.target;
      lastDown = { ui: !!(t && t.closest && t.closest(UI)), at: Date.now() };
    }, true);
    d.addEventListener('selectionchange', function () {
      var sel = d.getSelection && d.getSelection();
      if (!sel) return;
      if (sel.isCollapsed || !String(sel).trim()) {
        var a = d.activeElement, byChat = (a && a.closest && a.closest(UI)) || (lastDown.ui && Date.now() - lastDown.at < 2500);
        if (!byChat && S.sel && S.sel.doc === d) S.sel = null;
        return;
      }
      if (!sel.anchorNode) return;
      var n = sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement;
      if (n && n.closest && n.closest(UI + ', textarea, input')) return;
      var t = String(sel).replace(/\u00a0/g, ' ').trim();
      if (t) S.sel = { text: t.slice(0, SEL_MAX), at: Date.now(), doc: d };
    });
  }
  function toolDoc() {
    if (!document.body.classList.contains('tool-open')) return null;
    var f = document.querySelector('.panel.show iframe');
    try { return f && f.contentDocument; } catch (e) { return null; }
  }
  function pageContext() {
    var d = toolDoc(), c = { label: '', sel: '', code: '' };
    if (d && d.getElementById('main')) {
      watchDoc(d);
      var title = String(d.title || '').replace(/\s*·\s*STM32 学习台\s*$/, '').trim();
      var parts = title ? title.split(/\s*·\s*/) : ['首页'];
      [].forEach.call(d.querySelectorAll('#main .snav-i.on, #main .cseg-b.on, #main .lm-tab.on'), function (e) {
        var t = e.textContent.replace(/\s+/g, ' ').trim();
        if (t && parts.indexOf(t) < 0 && title.indexOf(t) < 0) parts.push(t);
      });
      c.place = parts.join(' · '); c.label = 'STM32 学习台 · ' + c.place;   // 给 AI 的写全，框上面那行短一点
      var ta = d.querySelector('#main .lab-ta');
      if (ta && ta.offsetParent && ta.value.trim()) c.code = ta.value.slice(0, CODE_MAX);
    }
    // 只带「现在这一页」上选中的：关掉学习台以后，学习台里选过的就不算了
    if (S.sel && Date.now() - S.sel.at < SEL_AGE && (S.sel.doc === d || S.sel.doc === document)) { c.sel = S.sel.text; c.selAt = S.sel.at; }
    return c.label || c.sel || c.code ? c : null;
  }
  /* 这次发消息带不带「附带」：设置里关了就都不带；点过 ✕ 的，在这一页上一直不带（发完也不再冒出来），
     换到别的页面、或者又选中了新的文字（你主动要它看的），之前的「不带」才作废 */
  function curCtx() {
    if (TQ || ls(LS_CTX) === '0') return null;
    var c = pageContext(), k = S.ctxSkip;
    if (!c) return null;
    if (k && ((c.place || '') !== k.place || (c.sel && c.selAt !== k.selAt))) S.ctxSkip = k = null;
    return k ? null : c;
  }
  function skipCtx() {
    var c = pageContext();
    S.ctxSkip = c ? { place: c.place || '', selAt: c.sel ? c.selAt : 0 } : null;
  }
  function ctxLabel(c) {
    var out = [c.place || c.label || '网页'];
    if (c.sel) { var n = c.sel.split('\n').length, one = c.sel.replace(/\s+/g, ' '); out.push(n > 1 ? '选中 ' + n + ' 行' : '选中「' + (one.length > 14 ? one.slice(0, 13) + '…' : one) + '」'); }
    if (c.code) out.push('你写的代码');
    return out.join(' · ');
  }
  function ctxText(c) {
    var t = [];
    if (c.label) t.push('【用户正在看】' + c.label);
    if (c.sel) t.push('【用户选中的内容】\n' + c.sel);
    if (c.code) t.push('【用户在「验证」里写的代码】\n```c\n' + c.code + '\n```');
    return t.join('\n');
  }
  function refreshCtx() {
    if (!root) return;
    var box = root.querySelector('.xc-ctx'), c = curCtx();
    if (!box) return;
    box.hidden = !c; if (c) box.querySelector('span').textContent = '附带：' + ctxLabel(c);
  }

  /* ---------- 不开面板，直接和小芯说：小芯旁边冒输入框，回复在它头上的气泡里 ---------- */
  function quick(X) {
    X = X || xin();
    if (TQ || !S.enabled || !X || !X.ask) return;
    if (!S.authed) { open(); return; }
    if (!root) build();
    var c = curCtx();
    X.ask({
      placeholder: S.run ? '小芯还在回上一句，说了先排着…' : '给小芯发消息',
      chip: c ? '附带：' + ctxLabel(c) : '',
      onChipOff: function () { skipCtx(); },
      onExpand: open,
      onSend: function (t) {
        if (S.run || S.sending) { if (queueMsg(t)) X.say('好，我说完这句就看', 3000); return; }
        send(t);
      }
    });
  }
  function stop() {
    if (!S.run) return;
    // 停完（或者其实早就做完了）再取一次进度：拿到「做完」，停止键才会变回发送
    var generation=S.convSeq,run=S.run;
    call('stop', { run: run }, 20000,null,function(){return generation===S.convSeq;}).then(function () { if(generation===S.convSeq&&run===S.run&&!S.polling)startPolling(); }, function (e) { if(generation===S.convSeq)setStatus('停止失败：' + e.message, 'bad'); });
  }

  /* ---------- 轮询这一轮的新事件 ---------- */
  var pollTm = 0, streamCtl = null, streamFails = {}, pollBusy = '';
  function watchingNow() { return !!(S.open && S.view === 'chat' && !document.hidden && document.hasFocus()); }
  function startPolling() { if (S.polling) return; S.polling = true; follow(); }
  function stopPolling() { S.polling = false; clearTimeout(pollTm); if (streamCtl) { streamCtl.abort(); streamCtl = null; } }
  // 跟进这一轮：服务器说能用流（/api/xin/me 的 stream）就用 SSE，连续失败两次这一轮就改回轮询
  function follow() {
    clearTimeout(pollTm);
    if (!S.polling || !S.run) return;
    // 上一次轮询还在路上：等它回来再决定。两路从同一个位置各取一遍的话，同一段会画两次
    if (pollBusy === S.run + ':' + S.convSeq) { pollTm = setTimeout(follow, 300); return; }
    if (S.streamOn && (streamFails[S.run] || 0) < 2 && !document.hidden && window.fetch && window.TextDecoder && typeof AbortController === 'function') openStream(); else poll();
  }
  // 一页新进度（轮询的结果和流里的每一条形状一样）：画出来、记下读到哪；返回 continue / again（done 但还没看到 done 那一行）/ finished
  function applyTurn(d, run) {
    d.events.forEach(function (ev) {
      if (ev.t === 'done') S.sawDone = run;
      if (!(ev.t === 'user' && S.mine[run])) draw(ev, false, run); else termKeep(ev, run);
      react(ev); termLive(ev, run); if (ev.t === 'done' && ev.usage) setUsage(ev.usage);
    });
    S.off = d.off; S.pos = typeof d.pos === 'number' ? d.pos : null;   // 新控制器给字节位置，下次只读新增的部分
    if (d.events.length) toBottom();
    // 记录里的 ended 可能先于回复行可见。这时 done 为真但这一页没有 done 事件，接着取，不能把这轮收掉。
    if (d.done && S.sawDone !== run) { progress(); return 'again'; }
    if (d.done) {
      S.run = ''; stopPolling(); setStatus(''); typing(false); render(); if (!touch && S.open) input.focus();
      if (!TQ && (S.sessAgent === 'codex' || d.events.some(function (ev) { return ev.t === 'task'; }))) pollTasksSoon(800);   // 这一句派了分身、或者有任务在做：看看任务
      if (d.next || S.reload === S.sid) { S.reload = ''; openSession(S.sid); return 'finished'; }
      flushQueue();
      return 'finished';
    }
    progress();
    return 'continue';
  }
  /* SSE（docs/xin-kernel-design.md §14.3）：只是传输方式——控制器一写进运行记录就推过来，不用等下一次轮询。
     回答仍然是整段到的（前台模型一次给出完整答案），这里不做打字机效果。 */
  function openStream() {
    var run = S.run, generation = S.convSeq, ctl = new AbortController(), finished = false, buf = '', idleTm = 0;
    if (streamCtl) streamCtl.abort();
    streamCtl = ctl;
    // 流和别的请求一样要有期限（见上面 req 的说明）：连接被静默丢掉时既不来数据也不报错，页面会一直停在「思考中」。
    // 内核每 15 秒发一次心跳，45 秒什么都没收到就当它断了：断开，算一次失败（重连；连续两次这一轮就退回轮询）
    var beat = function (ms) { clearTimeout(idleTm); idleTm = setTimeout(function () { ctl.abort(); }, reqMs(ms)); };
    var over = function () { clearTimeout(idleTm); if (streamCtl === ctl) streamCtl = null; };   // 这条流完了：streamCtl 只在流开着时有值
    beat(60000);
    var live = function () { return run === S.run && generation === S.convSeq && S.polling && streamCtl === ctl; };
    var q = 'run=' + encodeURIComponent(run) + '&off=' + (S.off | 0) + (typeof S.pos === 'number' ? '&pos=' + S.pos : '') + '&deviceId=' + encodeURIComponent(S.deviceId) + '&tabId=' + encodeURIComponent(S.tabId) + '&watching=' + (watchingNow() ? '1' : '0');
    fetch(API + 'stream?' + q, { credentials: 'same-origin', headers: { 'X-Xin': '1' }, signal: ctl.signal }).then(function (r) {
      if (!r.ok || !r.body || !/event-stream/.test(r.headers.get('content-type') || '')) throw new Error('no_stream');
      var reader = r.body.getReader(), dec = new TextDecoder();
      function pump() {
        return reader.read().then(function (x) {
          if (x.done || !live()) return;
          beat(45000);
          buf += dec.decode(x.value, { stream: true });
          for (var i = buf.indexOf('\n\n'); i >= 0; i = buf.indexOf('\n\n')) {
            var block = buf.slice(0, i), data = '', kind = '';
            buf = buf.slice(i + 2);
            block.split('\n').forEach(function (l) { if (l.indexOf('data: ') === 0) data += l.slice(6); else if (l.indexOf('event: ') === 0) kind = l.slice(7); });
            if (!data) continue;
            if (kind === 'error') throw new Error('stream_error');
            var st = applyTurn(JSON.parse(data), run);
            streamFails[run] = 0;
            if (st !== 'continue') { finished = true; over(); ctl.abort(); if (st === 'again' && S.polling) pollTm = setTimeout(poll, 300); return; }
          }
          return pump();
        });
      }
      return pump();
    }).then(function () {
      var on = !finished && live(); over();
      if (on) pollTm = setTimeout(follow, 1000);   // 流正常结束但这一轮还没完（内核换一条流、电脑暂停）：接着连
    }, function () {
      var on = !finished && live(); over();
      if (!on) return;
      streamFails[run] = (streamFails[run] || 0) + 1;
      pollTm = setTimeout(follow, 1000);
    });
  }
  function poll() {
    clearTimeout(pollTm);
    if (!S.polling || !S.run) return;
    if (document.hidden) { pollTm = setTimeout(follow, 1500); return; }
    var run = S.run,generation=S.convSeq,key=run+':'+generation;
    if (pollBusy === key) return;   // 这一轮已经有一次轮询在路上：它回来以后会接着排下一次
    pollBusy = key;
    call('poll', Object.assign({ run: run, off: S.off }, typeof S.pos === 'number' ? { pos: S.pos } : {}, { deviceId:S.deviceId, tabId:S.tabId, watching:watchingNow() }), 0,null,function(){return generation===S.convSeq&&run===S.run;}).then(function (d) {
      if (pollBusy === key) pollBusy = '';
      if (run !== S.run || generation!==S.convSeq) return;
      var st = applyTurn(d, run);
      if (st === 'finished') return;
      pollTm = setTimeout(poll, st === 'again' ? (d.events.length ? 400 : 300) : d.events.length ? 700 : 1300);
    }, function (e) {
      if (pollBusy === key) pollBusy = '';
      if (run !== S.run || generation!==S.convSeq) return;
      if (e.state === 'cooldown') { setStatus(e.message, 'bad'); pollTm = setTimeout(poll, Math.max(30, e.retryAfter || 60) * 1000); return; }
      if (/要先登录/.test(e.message)) { stopPolling(); return; }
      setStatus(e.state === 'waking' ? '唤醒中…' : '连不上云电脑，正在重试：' + e.message, 'wait');
      pollTm = setTimeout(poll, 3000);
    });
  }
  /* 「正在输入」气泡旁边那行字：思考中还是在电脑上忙、从消息送到小芯电脑那一刻起过了多久（分得清是慢还是卡住了），每秒走一下；
     偶尔的状态（比如卡住了重连）闪几秒。「思考中」= AI 已经收到这句、还没出声也没在执行命令：主要是模型在想、在写回答
     （回答是整段到的，看不到一个字一个字地写），也包括 AI 程序启动、请求发给模型的那一两秒 */
  var NOISE = /^Model metadata for .* not found/i;   // Codex 每轮都报的无关警告
  function progress() {
    if (!S.run && !S.sending) return;
    renderHead();
    if (!typingEl) return;
    var sec = Math.round((Date.now() - (S.t0 || Date.now())) / 1000), lab = typingEl.querySelector('.xc-typing-l');
    if (S.sending) { lab.textContent = sendingText(); return; }
    if (S.note && Date.now() - S.note.at < 6000) { swapText(lab, S.note.text, S.note.text); return; }
    var verb = clip(doingWord(), innerWidth < 600 ? 32 : 52);
    swapText(lab, verb + (sec >= 1 ? ' · ' + secText(sec) : ''), verb);
  }
  /* 状态行（站长 2026-11-16：「希望像 grok bot 那样根据用户的输入问题显示相关的文字」「派了后台任务也要动态地在动」）：
     永远写此刻真实在做的事——做哪一步写哪一步（在搜索：…、在执行：…，和控制器 vm-events.mjs 的 stepActivity 一个写法）；
     没在做哪一步时写前台一开始概括的那一句（vm-status.mjs，例「查 Gemini 4 Hydrogen 的评测」；天启写它中文的思考）；
     都没有就是「思考中」。不再轮换「琢磨中、盘算中……」（impeccable clarify：界面里不为文采换说法，加载文字说真实在做的操作）。
     参考 openai/codex 状态行取推理摘要的粗体标题（extract_first_bold）、open-webui 的 status 事件（「正在搜索 “…”」） */
  function shortUrl(u) { return String(u || '').replace(/^[a-z]+:\/\//i, '').replace(/^www\./, '').replace(/[?#].*$/, '').replace(/\/+$/, ''); }
  function shortFile(p) { var a = String(p || '').split('/').filter(Boolean); return a.length > 2 ? a.slice(-2).join('/') : a.join('/'); }
  // 一步（tool 事件）→ 在做什么；内部命令（xin 后面不是 browser 的：派活、记忆、交付）给空串
  function stepOf(ev) {
    var n = String(ev.name || ''), d = bareCmd(ev.detail || '').replace(/\s+/g, ' ').trim(), m;
    if (n === 'Bash') {
      if ((m = /^xin\s+browser\s+(?:open|back)\s*(\S*)/.exec(d))) return '在打开网页' + (m[1] ? '：' + shortUrl(m[1]) : '');
      if (/^xin\s+browser\s+(?:snapshot|text)\b/.test(d)) return '在读网页';
      if (/^xin\s+browser\s+(?:click|fill|press|select|scroll)\b/.test(d)) return '在操作网页';
      if (/^xin\s+browser\s+screenshot\b/.test(d)) return '在截图';
      if (/^xin(\s|$)/.test(d)) return '';
      return '在执行：' + d.replace(/^(?:cd\s+\S+\s*(?:&&|;)\s*)+/, '');
    }
    if (n === 'WebSearch') return '在搜索：' + d;
    if (n === 'WebFetch') return '在打开网页：' + shortUrl(d);
    if (/^(?:Edit|Write|MultiEdit|NotebookEdit)$/.test(n)) return '在修改：' + d.split('\n').map(function (l) { return shortFile(l.replace(/^(?:add|update|delete|create)\s+/, '')); }).join('、');
    if (n === 'MCP') return '在使用插件：' + d;
    if (/^(?:Read|Glob|Grep|LS)$/.test(n)) return '在查看文件：' + shortFile(d);
    if (/[一-龥]/.test(n)) return n;   // 控制器自己的步骤：检查网页、生成预览、编译核验
    return '执行中';
  }
  function doingWord() { return S.doing === 'work' && S.act ? S.act : S.thinkS || '思考中'; }
  // 按显示宽度截：中文和全角算 2、英文数字算 1，超过 n 就截到 n - 2 再加「…」。状态行常是中英混排（查 Gemini 4 Hydrogen 的评测），
  // 按字数截会截得太早；手机按屏幕宽度给 32（约 16 个汉字），平板和电脑 52，平板不再跟手机一样短
  function clip(t, n) {
    var a = Array.from(String(t || '')), w = 0, cut = -1;
    for (var i = 0; i < a.length; i++) { w += a[i].charCodeAt(0) > 0x2e7f ? 2 : 1; if (cut < 0 && w > n - 2) cut = i; if (w > n) return a.slice(0, cut).join('').replace(/\s+$/, '') + '…'; }
    return a.join('');
  }
  function secText(sec) { return sec >= 60 ? Math.floor(sec / 60) + ' 分 ' + (sec % 60) + ' 秒' : sec + ' 秒'; }
  /* 换字：旧字往上淡出、新字从下面进来；外面那一层的宽度跟着平滑变。旧字是叠在同一格里的影子（不在 el 里），
     读 el 的人（读屏、测试）只看到新字。key 一样（比如只是秒数在走）就直接换，不动画 */
  function swapText(el, text, key) {
    key = key == null ? text : key;
    if (el.textContent === text && el.dataset.k === key) return;
    var was = el.dataset.k, old = el.textContent, w = el.parentNode;
    el.dataset.k = key;
    if (was == null || was === key || !old || reduceMotion() || !w || !w.classList.contains('xc-sw-w') || !el.offsetParent) { el.textContent = text; return; }
    var g = w.querySelector('.xc-sw-o'); if (g) g.remove();
    g = h('span', el.className.replace(/\bxc-sw-in\b/, '') + ' xc-sw-o', old); g.setAttribute('aria-hidden', 'true'); w.appendChild(g);
    flipWidth(w, function () { el.textContent = text; });
    el.classList.remove('xc-sw-in'); void el.offsetWidth; el.classList.add('xc-sw-in');
    clearTimeout(w._sw); w._sw = setTimeout(function () { if (g.parentNode) g.remove(); el.classList.remove('xc-sw-in'); }, 320);
  }
  // 宽度跟着内容平滑变（FLIP）：量旧宽度 → 改内容 → 量新宽度 → 从旧宽度过渡过去 → 完了放开（回到 auto）
  function flipWidth(el, mutate) {
    if (!el || reduceMotion() || !el.offsetParent) { mutate(); return; }
    var w0 = el.getBoundingClientRect().width;
    el.style.width = ''; mutate();
    var w1 = el.getBoundingClientRect().width;
    if (Math.abs(w1 - w0) < 0.5) return;
    el.style.width = w0 + 'px'; void el.offsetWidth; el.style.width = w1 + 'px';
    clearTimeout(el._fw); el._fw = setTimeout(function () { el.style.width = ''; }, 380);
  }
  // 还没送到小芯的电脑时那行字：接收中；电脑在睡：唤醒中；InstaBox 忙：排队中
  function bjClock(t) { return new Date(t + 8 * 3600e3).toISOString().slice(11, 16); }   // 北京时间 HH:MM
  function sendingText(short) {
    if (S.waitSend === 'accepted-waking') return '已收到 · 唤醒中';
    if (S.waitSend === 'accepted-retrying') return '已收到 · 正在重试';
    if (S.waitSend === 'accepted-cooldown') return S.waitUntil && !short ? '已收到 · 冷却中，约 ' + bjClock(S.waitUntil) + ' 送到' : '已收到 · 冷却中';
    return S.waitSend === 'waking' ? '唤醒中' : S.waitSend === 'busy' ? '排队中' : '接收中';
  }
  function react(ev) {
    if (ev.t === 'status') { if (!NOISE.test(ev.text || '')) S.note = { text: ev.text, at: Date.now() }; return; }
    if (ev.t === 'think') { var tx = ev.src === 'status' ? ev.text : /[\u3400-\u9fff]/.test(ev.text || '') && !S.thinkFixed ? ev.text : ''; if (tx) { S.thinkS = tx; if (ev.src === 'status') S.thinkFixed = true; progress(); } return; }
    if (ev.t === 'tool') { var st = stepOf(ev); if (st) { S.doing = 'work'; S.act = st; } } else if (ev.t === 'tool_end' || ev.t === 'text') { S.doing = 'think'; S.act = ''; }
    if (ev.t === 'done' && !ev.stopped) setMood(ev.ok ? 'happy' : 'sad'); else if (ev.t === 'tool' || ev.t === 'tool_end' || ev.t === 'text') paintFaces();
    var x = xin(); if (!x) return;
    if (ev.t === 'text') { S.lastText = ev.text; x.ai('think'); var line = firstLine(ev.text); if (line) x.say(line, 0, open); }
    else if (ev.t === 'tool') x.ai('work');
    else if (ev.t === 'xin') { S.lastAct = Date.now(); if (ev.act === 'move' && ev.frames) x.learn([{ name: ev.arg, frames: ev.frames }]); x.cmd(ev.act, ev.arg); }
    else if (ev.t === 'move') { setMoves(S.moves.filter(function (m) { return m.name !== ev.name; }).concat([{ name: ev.name, frames: ev.frames }])); S.lastAct = Date.now(); x.cmd('move', ev.name); x.say('学会新动作啦：' + ev.name, 3000); }
    else if (ev.t === 'bond') setBond(ev);
    else if (ev.t === 'done') {
      x.ai('');
      if (ev.stopped) return;
      if (ev.ok && S.lastText) x.say(summary(S.lastText), 16000, open);
      else if (!ev.ok) x.say('这次回复失败了', 10000, open);
      if (Date.now() - S.lastAct < 4000) return;          // AI 刚让它做了动作，就不抢戏了
      x.cmd(ev.ok ? 'happy' : 'sad');
    }
  }
  // 气泡里放纯文字：去掉 Markdown 记号。# 和 > 只去行首的（标题、引用），RCC->APB2ENR 里的 > 要留着
  function mdPlain(t) { return t.replace(/^[ \t]*(#{1,6}|>+)[ \t]*/gm, '').replace(/\*\*|`/g, ''); }
  // 做完时气泡里的话：最后那段回答的开头；有代码或太长就提示点开看全文
  function summary(t) {
    t = String(t || '');
    var code = /```/.test(t), plain = mdPlain(t.replace(/```[\s\S]*?(```|$)/g, ' ')).replace(/\s+/g, ' ').trim();
    var cut = plain.length > 80 ? plain.slice(0, 78) + '…' : plain;
    return (cut || '写好了') + (code || plain.length > 80 ? '…' : '');
  }
  function firstLine(t) {
    t = mdPlain(String(t || '').replace(/```[\s\S]*?(```|$)/g, ' ')).trim();
    var m = /^[^\n。！？!?]{1,60}[。！？!?]?/.exec(t);
    if (!m) return '';
    var s = m[0].trim();
    return s.length > 36 ? s.slice(0, 34) + '…' : s;
  }

  /* ---------- 画消息 ---------- */
  function toBottom(force, smooth) {
    var b = root.querySelector('.xc-body');
    if (force || b.scrollHeight - b.scrollTop - b.clientHeight < 160) {
      if (smooth && !reduceMotion()) b.scrollTo({ top: b.scrollHeight, behavior: 'smooth' }); else b.scrollTop = b.scrollHeight;
      jumpEl.classList.remove('new');
    }
    jumpCheck();
  }
  // 往上翻了一屏多：右下角「回到底部」；这时下面来了新内容就写「新消息」
  function jumpCheck() {
    if (upEl && upEl._to && (!upEl._to.isConnected || inView(upEl._to))) hideUp();   // 自己滚到了结果那里：顶上的提示收起
    if (!jumpEl) return;
    var b = root.querySelector('.xc-body'), away = b.scrollHeight - b.scrollTop - b.clientHeight > Math.max(240, b.clientHeight * .6);
    if (!away) jumpEl.classList.remove('new');
    if (jumpEl.hidden === !away) return;
    jumpEl.hidden = !away;
  }
  function jumpNew() {
    var b = root.querySelector('.xc-body');
    if (b.scrollHeight - b.scrollTop - b.clientHeight > Math.max(240, b.clientHeight * .6)) { jumpEl.classList.add('new'); jumpEl.lastChild.textContent = '新消息'; jumpEl.hidden = false; }
    else jumpEl.lastChild.textContent = '回到底部';
  }
  // 最下面：「思考中」那一行，再下面是在做的活的框（dock）。新画的东西插在它们上面
  function liveAnchor() { return typingEl && typingEl.parentNode === list ? typingEl : list.querySelector(':scope > .xc-tbw.dock'); }
  function put(e) { var a = liveAnchor(); if (a) list.insertBefore(e, a); else list.appendChild(e); return e; }
  // 上一条（不算「正在输入」）是不是同一轮里小芯说的：是的话这条不再画头像，和上一条挨着
  function lastAi(run) {
    var a = liveAnchor(), e = a ? a.previousElementSibling : list.lastElementChild;
    return !!e && e.classList.contains('xc-ai') && !e.classList.contains('xc-typing') && e.dataset.run === (run || '');
  }
  // 小芯说的一条：左边头像一栏，同一轮里第一条上面写「小芯」，后面接着说的不再画头像；正文不套气泡
  function aiMsg(run, cls) {
    var e = h('div', 'xc-m xc-ai' + (cls ? ' ' + cls : '')), b = h('div', 'xc-bub');
    e.dataset.run = run || '';
    if (lastAi(run)) e.classList.add('cont');
    var tq = tqConv() && !/^task-/.test(run || '');   // 天启对话里它自己说的话；后台的活做完是小芯转达的
    e.appendChild(tq ? tqMark('xc-av') : avatar());
    if (!e.classList.contains('cont')) e.appendChild(h('span', 'xc-who', tq ? '天启' : '小芯'));
    e.appendChild(b);
    return { e: e, b: b };
  }
  // 回答下面的操作：复制。只在这一轮最后一条下面露出来（CSS），复制整轮原文
  function msgActs(e, text) {
    e._md = text;
    var a = h('div', 'xc-acts'), c = h('button', 'xc-mcopy'); c.type = 'button'; c.setAttribute('aria-label', '复制这条回答');
    c.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8.5" y="8.5" width="11" height="11" rx="2.2"/><path d="M15.5 8.5V6.2a1.7 1.7 0 0 0-1.7-1.7H6.2a1.7 1.7 0 0 0-1.7 1.7v7.6a1.7 1.7 0 0 0 1.7 1.7h2.3"/><path class="ok" d="m9 12.5 2.2 2.2 4.3-4.6"/></svg><span>复制</span>';
    a.appendChild(c); e.appendChild(a);
  }
  function sysChip(text, cls) { return h('div', 'xc-sys' + (cls ? ' ' + cls : ''), text); }
  function byLine(ev, run) {
    var e = h('div', 'xc-by', modelName(ev.model) + (ev.why === 'named' ? ' · 按你点名' : '') + (ev.from ? ' · ' + modelName(ev.from) + ' 没接上，换了它' : ''));
    e.dataset.run = run || '';
    return e;
  }
  // 两句之间隔了 10 分钟以上，中间写一下时间
  function timeSep(at) {
    at = at || Date.now();
    if (!S.lastAt || at - S.lastAt > 600000) put(h('div', 'xc-time', when(at)));
    S.lastAt = at;
  }
  // run：这一条属于哪一轮。工具调用（执行的命令）、xin 动作、临时状态都不画
  function draw(ev, old, run) {
    var e = null, m;
    run = run || S.run || '';
    termKeep(ev, run);
    if (ev.t === 'user') {
      if(ev.clientId && list.querySelector('[data-message-id="'+ev.clientId.replace(/[^a-zA-Z0-9_-]/g,'')+'"]')) return null;
      timeSep(ev.at);
      e = h('div', 'xc-m xc-me');
      if (TQ) e.appendChild(h('b', 'tq-me-name', '你'));
      if(ev.clientId) e.dataset.messageId=ev.clientId;
      if (ev.files && ev.files.length) e.appendChild(msgFiles(ev.files));
      if (ev.text) e.appendChild(h('div', 'xc-bub', ev.text));
      if (ev.ctx) e.appendChild(h('div', 'xc-ctxm', '附带：' + ev.ctx));
    } else if (ev.t === 'text') {
      var hole = null;
      if(ev.taskResult){
        var tr=ev.taskResult,key=tr.sid+'@'+(tr.status==='waiting'?'w'+(tr.endedAt||''):tr.at||'');
        if(list.querySelector('[data-tres="'+key+'"]'))return null;
        // 转达的话到了：这件活算说完了（框收成一行，用时算到这时）；任务摘要随后也会这么说
        var ti=S.tinfo[tr.sid]||(S.tinfo[tr.sid]={sid:tr.sid,status:tr.status,endedAt:tr.endedAt});
        if(!ti.delivery||ti.delivery.state!=='delivered')ti.delivery={state:'delivered',at:tr.deliveredAt||Date.now()};
        var rm=placeResult(tr.sid,ti,ev.text,'',!old);rm.e.dataset.tres=key;
        if(!old)seeResult(rm.e,ti);
        return rm.e;
      } else if ((hole = runLast(run)) && !hole.classList.contains('xc-tbh')) hole = null;
      var body = md(ev.text);
      // 先派活、后说话：框先占的那一条，话填进它的正文（话还在框上面）
      if (hole) {
        hole.classList.remove('xc-tbh'); hole.querySelector(':scope > .xc-bub').appendChild(body); msgActs(hole, ev.text);
        if (body.querySelector('.xc-code, .xc-tbl')) hole.classList.add('wide');
        return hole;
      }
      m = aiMsg(run); m.b.appendChild(body); msgActs(m.e, ev.text);
      if (body.querySelector('.xc-code, .xc-tbl')) m.e.classList.add('wide');
      e = m.e;
    } else if (ev.t === 'err') {
      S.errRuns[run] = true;
      m = aiMsg(run, 'bad'); m.b.textContent = ev.text; e = m.e;
    } else if (ev.t === 'done') {
      procLine(run, ev.ms);
      if (ev.stopped) e = sysChip('已停止');
      else if (!ev.ok && !S.errRuns[run]) { m = aiMsg(run, 'bad'); m.b.textContent = '回复失败，请重新发送'; e = m.e; }
      if (ev.model) S.lastModel = ev.model;
      // 这一轮实际用的模型写在回答下面（默认模式是小芯挑的；用户点名、换了模型也说一声）
      if (ev.model && !ev.stopped && S.sessAgent !== 'codex') { if (e) put(e); e = byLine(ev, run); }
    } else if (ev.t === 'task') {
      // 前台派出去的后台任务：那段话下面一个框（站长 2026-11-16）。不是卡片（2026-11-11 定的「聊天里不放卡片」还算数：没有按钮，点开是终端，操作在工作台和「详情」）。
      // 刚派出去的记下来，好知道它什么时候做完
      if (!S.tinfo[ev.sid]) S.tinfo[ev.sid] = { sid: ev.sid, no: ev.no, parent: S.sid || '', title: ev.title, kind: ev.kind, model: ev.model, status: ev.status || 'queued', after: ev.after || [], created: ev.at || Date.now() };
      TDISP[ev.sid] = run;   // 这件活属于派它的这一条消息
      if (!old) { taskBox(ev.sid, true); pollTasksSoon(1500); paintBoxes(); isleBump(); }
    } else if (ev.t === 'move') e = sysChip('学会了新动作：' + ev.name, 'move');   // 记忆、好感度是小芯自己的事，不在聊天里报
    if (e) {
      var bd = root.querySelector('.xc-body'), near = !old && bd.scrollHeight - bd.scrollTop - bd.clientHeight < 160;
      if (!old) e.classList.add('enter');
      put(e);
      if (!old) { if (near && ev.t !== 'user') followNew(e); else jumpNew(); }
    }
    return e;
  }
  // 站长 2026-11-19：你的话从输入框飞上去变成气泡（FLIP：从输入框的位置挪到气泡的位置）。只给这里发出去的（send 里滚到底以后再量）
  function flyFromComposer(e) {
    var src = root.querySelector('.xc-row'), bub = e.querySelector('.xc-bub'), body = root.querySelector('.xc-body');
    if (!src || !bub || !body || reduceMotion()) return;
    e.style.animation = bub.style.animation = 'none';   // 量的时候不算进场动画的位移
    var a = src.getBoundingClientRect(), b = bub.getBoundingClientRect(), bd = body.getBoundingClientRect();
    e.style.animation = bub.style.animation = '';
    if (!a.width || !b.width) return;
    // 起点最低到消息区最下面（紧挨着输入框）：再往下就探出消息区，消息区多出一截能滚，发完先往下滚、飞上去又弹回来，整屏跳一下
    var fy = Math.min(a.top + a.height / 2 - b.top - b.height / 2, bd.bottom - b.bottom);
    bub.style.setProperty('--fx', Math.round(a.left + a.width / 2 - b.left - b.width / 2) + 'px');
    bub.style.setProperty('--fy', Math.floor(fy) + 'px');
    e.classList.add('fly');
  }
  // 正看着最底下时来了新回答：短的直接滚到底；长的停在它开头，从头读（下面还有的话「回到底部」写「新消息」）
  function followNew(e) {
    var b = root.querySelector('.xc-body'), room = b.clientHeight - 120;
    var top = e.getBoundingClientRect().top - b.getBoundingClientRect().top + b.scrollTop - 16;
    var to = e.offsetHeight > room ? top : b.scrollHeight;
    if (reduceMotion()) b.scrollTop = to; else b.scrollTo({ top: to, behavior: 'smooth' });
    setTimeout(jumpNew, 400);
  }
  // 小芯在干活时，最后面冒一个「正在输入」的气泡（三个点在跳）和一行字：思考中 / 在电脑上忙，用了多久（每秒走）
  var typingEl = null, typingTick = 0;
  function typing(on) {
    paintGlow();
    if (!on) { clearInterval(typingTick); typingTick = 0; if (typingEl) typingEl.remove(); typingEl = null; paintBoxes(); return; }
    if (!typingTick) typingTick = setInterval(progress, 1000);
    if (!typingEl) {
      // 小芯的脸跟着状态换（想事情抬眼、在电脑上忙侧身），旁边一行字和秒数，后面三个像素点一格一格亮
      // 整条是按钮，点开看这一轮正在做的（站长 2026-11-16：「我点那个就可以打开终端就行」）；头像不再带小终端标记
      typingEl = h('div', 'xc-m xc-ai xc-typing'); termBtn(typingEl, 'live', '查看正在执行的步骤'); typingEl.title = '查看正在执行的步骤';
      var tf = tqConv() ? tqMark('xc-av') : h('span', 'xc-av xc-face'); typingEl.appendChild(tf);
      var b = h('div', 'xc-bub'); b.innerHTML = '<i></i><i></i><i></i>';
      var lw = h('span', 'xc-sw-w xc-typing-w'); lw.appendChild(h('span', 'xc-typing-l', '思考中')); typingEl.appendChild(lw); typingEl.appendChild(b);
    }
    list.insertBefore(typingEl, list.querySelector(':scope > .xc-tbw.dock'));   // 在做的活的框还在它下面
    var prev = typingEl.previousElementSibling;
    typingEl.classList.toggle('cont', !!prev && prev.classList.contains('xc-ai'));
    paintFaces(); progress();
  }
  // Markdown：代码块、标题、列表（可以套一层）、引用、分隔线、表格、段落；行内：代码、粗体、链接、小芯电脑里的路径。全部先转义
  function md(text) {
    var box = h('div', 'xc-md'), parts = String(text).split(/```/);
    parts.forEach(function (part, i) {
      if (i % 2) {
        var nl = part.indexOf('\n'), lang = nl >= 0 ? part.slice(0, nl).trim() : '', code = nl >= 0 ? part.slice(nl + 1) : part;
        var wrap = h('div', 'xc-code'), hd = h('div', 'xc-code-h'), pre = h('pre'), c = h('code'), src = code.replace(/\n$/, '');
        c.innerHTML = hl(src, lang);
        hd.appendChild(h('span', 'xc-lang', lang || '代码'));
        // 换行：长行在手机上不用左右拖；复制：原文
        var wb = h('button', 'xc-wrap'); wb.type = 'button'; wb.setAttribute('aria-pressed', 'false'); wb.setAttribute('aria-label', '自动换行');
        wb.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 6.5h15M4.5 12h12a3 3 0 0 1 0 6h-4M14.5 15.5 12 18l2.5 2.5M4.5 17.5h5"/></svg><span>换行</span>';
        var cp = h('button', 'xc-copy'); cp.type = 'button';
        cp.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8.5" y="8.5" width="11" height="11" rx="2.2"/><path d="M15.5 8.5V6.2a1.7 1.7 0 0 0-1.7-1.7H6.2a1.7 1.7 0 0 0-1.7 1.7v7.6a1.7 1.7 0 0 0 1.7 1.7h2.3"/><path class="ok" d="m9 12.5 2.2 2.2 4.3-4.6"/></svg><span>复制</span>';
        hd.appendChild(wb); hd.appendChild(cp); pre.appendChild(c); wrap.appendChild(hd); wrap.appendChild(pre);
        // 很长的代码先收起一截，底下「展开全部 N 行」
        var n = src.split('\n').length;
        if (n > 24) { wrap.classList.add('fold'); var more = h('button', 'xc-code-more', '展开全部 ' + n + ' 行'); more.type = 'button'; wrap.appendChild(more); }
        box.appendChild(wrap);
        return;
      }
      blocks(part, box);
    });
    return box;
  }
  function blocks(text, box) {
    var lines = text.replace(/\r/g, '').split('\n'), i = 0, para = [];
    var flush = function () { if (para.length) { var p = h('p'); p.innerHTML = para.map(inline).join('<br>'); box.appendChild(p); para = []; } };
    var LI = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/;
    while (i < lines.length) {
      var ln = lines[i], m;
      if (!ln.trim()) { flush(); i++; continue; }
      if ((m = /^\s*(#{1,6})\s+(.*)$/.exec(ln))) { flush(); var hh = h('h4'); hh.innerHTML = inline(m[2]); box.appendChild(hh); i++; continue; }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(ln)) { flush(); box.appendChild(h('hr')); i++; continue; }
      if (/^\s*>/.test(ln)) {
        flush(); var q = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ''));
        var bq = h('blockquote'); blocks(q.join('\n'), bq); box.appendChild(bq); continue;
      }
      if (/\|/.test(ln) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
        flush(); var rows = [ln]; i += 2;
        while (i < lines.length && /\|/.test(lines[i]) && lines[i].trim()) rows.push(lines[i++]);
        box.appendChild(table(rows)); continue;
      }
      if (LI.test(ln)) {
        flush(); i = list_(lines, i, box, LI); continue;
      }
      para.push(ln.trim()); i++;
    }
    flush();
  }
  // 列表：同一缩进的一串；缩进更深的接在上一项里当子列表
  function list_(lines, i, box, LI) {
    var m = LI.exec(lines[i]), ind = m[1].length, ordered = /\d/.test(m[2]), el = h(ordered ? 'ol' : 'ul'), li = null;
    if (ordered && parseInt(m[2], 10) > 1) el.setAttribute('start', parseInt(m[2], 10));
    while (i < lines.length) {
      var ln = lines[i];
      if (!ln.trim()) { if (i + 1 < lines.length && LI.test(lines[i + 1]) && LI.exec(lines[i + 1])[1].length >= ind) { i++; continue; } break; }
      m = LI.exec(ln);
      if (m && m[1].length > ind && li) { i = list_(lines, i, li, LI); continue; }
      if (m && m[1].length === ind && /\d/.test(m[2]) === ordered) { li = h('li'); li.innerHTML = inline(m[3]); el.appendChild(li); i++; continue; }
      if (!m && li && /^\s{2,}\S/.test(ln)) { li.innerHTML += '<br>' + inline(ln.trim()); i++; continue; }
      break;
    }
    box.appendChild(el);
    return i;
  }
  function table(rows) {
    var cells = function (r) { return r.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(function (c) { return c.trim(); }); };
    var wrap = h('div', 'xc-tbl'), t = h('table'), head = cells(rows[0]);
    var tr = h('tr'); head.forEach(function (c) { var th = h('th'); th.innerHTML = inline(c); tr.appendChild(th); });
    var th_ = h('thead'); th_.appendChild(tr); t.appendChild(th_);
    var tb = h('tbody');
    rows.slice(1).forEach(function (r) {
      var row = h('tr'); cells(r).forEach(function (c) { var td = h('td'); td.innerHTML = inline(c); row.appendChild(td); }); tb.appendChild(row);
    });
    t.appendChild(tb); wrap.appendChild(t);
    return wrap;
  }
  /* ---------- 代码上色：C（含 STM32 的寄存器宏）、shell、Python、JS / JSON、Makefile、汇编 ----------
     一个大正则从头扫到尾：注释、字符串、预处理（#include）、变量（$x）、数字、标识符；标识符再分关键字、类型、函数（后面跟括号）、
     全大写的宏 / 寄存器名，shell 里每条命令的第一个词也算「函数」。没认出语言就按内容猜，猜不出就不上色。全部先转义。 */
  var HL_ALIAS = { c: 'c', h: 'c', cpp: 'c', 'c++': 'c', cc: 'c', hpp: 'c', cxx: 'c', ino: 'c', arduino: 'c', java: 'c', ld: 'c',
    js: 'js', javascript: 'js', mjs: 'js', cjs: 'js', ts: 'js', typescript: 'js', json: 'js', jsonc: 'js',
    sh: 'sh', bash: 'sh', shell: 'sh', console: 'sh', zsh: 'sh', terminal: 'sh', shellsession: 'sh',
    py: 'py', python: 'py', python3: 'py', make: 'make', makefile: 'make', mk: 'make', s: 'asm', asm: 'asm', armasm: 'asm' };
  var HL_KW = {}, HL_RE = {};
  (function () {
    var w = {
      c: 'auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while bool true false NULL nullptr class public private protected namespace template typename new delete this virtual override using __IO __I __O __attribute__ __asm __NOP __WFI',
      js: 'await break case catch class const continue debugger default delete do else export extends finally for from function if import in instanceof let new of return static super switch this throw try typeof var void while with yield async true false null undefined',
      py: 'and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield True False None self',
      sh: 'if then else elif fi for while until do done case esac function in return export local readonly unset set source alias',
      make: 'ifeq ifneq ifdef ifndef else endif include define endef export override',
      asm: ''
    };
    Object.keys(w).forEach(function (l) { HL_KW[l] = {}; w[l].split(' ').forEach(function (k) { if (k) HL_KW[l][k] = 1; }); });
  })();
  var HL_TYPE = /^(u?int(8|16|32|64)_t|u?int_(least|fast)(8|16|32|64)_t|size_t|ssize_t|ptrdiff_t|u?intptr_t|[us](8|16|32|64)|uint(8|16|32)|\w+_TypeDef|\w+_t|FILE)$/;
  function hlLang(lang, code) {
    var l = HL_ALIAS[String(lang || '').toLowerCase()];
    if (l) return l;
    if (lang) return '';
    if (/#\s*include|->|\b(void|uint32_t|int)\b[^\n]*[;{]/.test(code)) return 'c';
    if (/^\s*(\$ |sudo |cd |make\b|ls\b|cp\b|mkdir\b|arm-none-eabi-)/m.test(code)) return 'sh';
    if (/^\s*(def |import |from \S+ import )/m.test(code)) return 'py';
    return '';
  }
  function hlRe(l) {
    if (HL_RE[l]) return HL_RE[l];
    var NO = '(?!)';
    var com = l === 'c' || l === 'js' ? '\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?(?:\\*\\/|$)' : l === 'asm' ? '\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?(?:\\*\\/|$)|[;@][^\\n]*' : '#[^\\n]*';
    var str = '"(?:[^"\\\\\\n]|\\\\.)*"?|\'(?:[^\'\\\\\\n]|\\\\.)*\'?' + (l === 'js' || l === 'sh' ? '|`(?:[^`\\\\]|\\\\.)*`?' : '');
    var pre = l === 'c' ? '^[ \\t]*#[ \\t]*\\w+(?:[ \\t]*<[^>\\n]*>)?' : l === 'asm' ? '\\.\\w+' : NO;
    var vr = l === 'sh' ? '\\$\\{[^}\\n]*\\}|\\$\\w+|\\$[@#?$!*-]' : l === 'make' ? '\\$\\([^)\\n]*\\)|\\$[@<^\\w]' : NO;
    var num = '\\b(?:0[xX][0-9a-fA-F]+|0[bB][01]+|\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)[uUlLfF]*\\b';
    var parts = l === 'c' ? [pre, com, str, vr, num] : [com, str, pre, vr, num];
    // shell 的命令名、文件名里常有 - 和 .（arm-none-eabi-gcc）
    HL_RE[l] = new RegExp(parts.map(function (x) { return '(' + x + ')'; }).join('|') + (l === 'sh' ? '|([A-Za-z_][\\w.-]*)' : '|([A-Za-z_]\\w*)'), 'gm');
    HL_RE[l].order = l === 'c' ? ['pre', 'com', 'str', 'var', 'num'] : ['com', 'str', 'pre', 'var', 'num'];
    return HL_RE[l];
  }
  function hlId(l, word, src, i) {
    if (HL_KW[l][word]) return 'kw';
    var j = i + word.length; while (src.charAt(j) === ' ' || src.charAt(j) === '\t') j++;
    var k = i - 1; while (k >= 0 && (src.charAt(k) === ' ' || src.charAt(k) === '\t')) k--;
    var prev = k < 0 ? '\n' : src.charAt(k);
    if (l === 'asm') { if (/^(r\d{1,2}|sp|lr|pc|apsr|primask)$/i.test(word)) return 'mc'; if (prev === '\n' || prev === ':') return src.charAt(j) === ':' ? 'fn' : 'kw'; }
    if (l === 'sh') {
      if (prev === '\n' || prev === '|' || prev === ';' || prev === '&' || prev === '(' || (prev === '$' && (k === 0 || src.charAt(k - 1) === '\n'))) return 'fn';
      if (prev === '-' || src.charAt(i - 1) === '-') return '';
    }
    if (l === 'make' && prev === '\n' && src.charAt(j) === ':') return 'fn';
    if (l === 'c' || l === 'js' || l === 'py') { if (HL_TYPE.test(word) && l === 'c') return 'ty'; if (src.charAt(j) === '(') return 'fn'; }
    if (/^[A-Z][A-Z0-9_]+$/.test(word) && /[A-Z]/.test(word)) return 'mc';
    return '';
  }
  function hl(src, lang) {
    var l = hlLang(lang, src);
    if (!l) return esc(src);
    var re = hlRe(l), out = '', last = 0, m;
    re.lastIndex = 0;
    while ((m = re.exec(src))) {
      if (!m[0]) { re.lastIndex++; continue; }
      out += esc(src.slice(last, m.index));
      var cls = '';
      for (var g = 1; g <= 5; g++) if (m[g] !== undefined) { cls = re.order[g - 1]; break; }
      if (!cls) cls = hlId(l, m[6], src, m.index);
      out += cls ? '<span class="hl-' + cls + '">' + esc(m[0]) + '</span>' : esc(m[0]);
      last = re.lastIndex;
    }
    return out + esc(src.slice(last));
  }
  function esc(s) { return s.replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  // 小芯电脑里的路径（/data/workspace/…）：点了打开「小芯的文件」
  var PATH_RE = /(^|[^\w\/:.~-])(\/data\/workspace(?:\/[\w.+@%~=-]+)*\/?)(?!\w)/g;
  function pathLink(p, inner) { p = p.replace(/[.\/]+$/, '') || WORK; return '<a href="#" class="xc-path" data-path="' + esc(p) + '">' + inner + '</a>'; }
  function inline(line) {
    return line.split(/(`[^`]+`)/).map(function (seg, i) {
      if (i % 2) {
        var inner = seg.slice(1, -1).trim();
        return /^\/data\/workspace(\/[\w.+@%~=-]+)*\/?$/.test(inner) ? pathLink(inner, '<code>' + esc(inner) + '</code>') : '<code>' + esc(seg.slice(1, -1)) + '</code>';
      }
      return esc(seg)
        .replace(/\[([^\[\]]{1,80})\]\((\/xin\/preview\.html\?id=[a-f0-9]{32})\)/g, '<a class="xc-preview xc-plink" href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
        .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
        .replace(/(https?:\/\/[^\s<>()（）]+[^\s<>()（）.,;:!?。，；：！？'"])/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>')
        .replace(PATH_RE, function (m, pre, p) { var t = p.replace(/[.]+$/, ''); return pre + pathLink(t, t) + p.slice(t.length); });
    }).join('');
  }

  /* ---------- 命令面板（Ctrl / ⌘ + K，侧边栏的搜索框也打开它） ----------
     一个输入框找所有东西：对话（标题）、在做的任务、能做的事（新对话、主对话、每日任务、屏幕、用量、文件、设置、主题、全屏）。
     上下键选、回车执行、Esc 关；鼠标移上去就选中。 */
  var palIdx = 0, palItems = [], palBack = null;
  var PICON = {
    new: '<path d="M12 5.5v13M5.5 12h13"/>', star: '<path d="M12 3.5 13.6 10.4 20.5 12 13.6 13.6 12 20.5 10.4 13.6 3.5 12 10.4 10.4z"/>', main: '<path d="M9.5 4.5h5l-.8 5.2 3.3 3.3H7l3.3-3.3zM12 13v6.5"/>',
    daily: '<circle cx="12" cy="13" r="7.2"/><path d="M12 9.5v3.5l2.3 1.8M9.5 3.5h5"/>', tray: '<rect x="4" y="4" width="16" height="16" rx="5"/><path d="M8 12h8M8 8.5h5M8 15.5h6"/>',
    screen: '<rect x="3.5" y="4.5" width="17" height="11.5" rx="1.8"/><path d="M8.5 19.5h7M12 16v3.5"/>', usage: '<path d="M5 19.5V11M10 19.5V5M15 19.5v-6M20 19.5V8.5"/>',
    files: '<path d="M3.5 7.5a1.5 1.5 0 0 1 1.5-1.5h4.5l2 2H19a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8"/>',
    theme: '<circle cx="12" cy="12" r="7.5"/><path d="M12 4.5a7.5 7.5 0 0 1 0 15z" class="fill"/>', full: '<path d="M14.5 4.5h5v5M19.5 4.5l-6 6M9.5 19.5h-5v-5M4.5 19.5l6-6"/>',
    chat: '<path d="M5 6.5A2.5 2.5 0 0 1 7.5 4h9A2.5 2.5 0 0 1 19 6.5v7a2.5 2.5 0 0 1-2.5 2.5H11l-4.5 3.5V16H7.5A2.5 2.5 0 0 1 5 13.5z"/>',
    task: '<circle cx="12" cy="12" r="7.5"/><path d="M12 8v4l2.5 1.5"/>'
  };
  function palActions() {
    if (TQ) {
      return [
        { ic: 'new', t: '新建对话', k: '新对话 新建 对话', run: function () { newChat(); input.focus(); } },
        { ic: 'usage', t: '用量', k: '额度 token 用量 统计', run: function () { openUsage(); } },
        { ic: 'files', t: '天启的文件', k: '文件 工作目录 下载', run: function () { loadFiles(WORK, 'sess'); } },
        { ic: 'theme', t: document.documentElement.dataset.theme === 'dark' ? '换成浅色' : '换成深色', k: '主题 深色 浅色 夜间', run: function () { flipTheme(); } }
      ];
    }
    var x = [
      { ic: 'new', t: '新建对话', k: '新对话 新建 对话', run: function () { newChat(); input.focus(); } },
      { ic: 'main', t: '回到主对话', k: '主对话', run: function () { goMain(); } },
      { ic: 'tray', t: '小芯在做的事', k: '任务 进行中 待处理 成果 工作台', run: function () { if (trayDocked()) flash(workEl); else setTray(true); } },
      { ic: 'daily', t: '每日任务', k: '每日 签到 清单', run: function () { loadDaily(); } },
      { ic: 'screen', t: '小芯的屏幕', k: '屏幕 桌面 接管 电脑', run: function () { openScreen(false); } },
      { ic: 'usage', t: '用量', k: '额度 token 用量 统计', run: function () { openUsage(); } },
      { ic: 'files', t: '小芯的文件', k: '文件 工作目录 hex 下载', run: function () { loadFiles(WORK, 'sess'); } },
      { ic: 'gear', t: '设置', k: '设置 通知 备份 登录 附带', run: function () { setDrawer(true); setTimeout(openSettings, 60); } },
      { ic: 'theme', t: document.documentElement.dataset.theme === 'dark' ? '换成浅色' : '换成深色', k: '主题 深色 浅色 夜间', run: function () { flipTheme(); } }
    ];
    x.push(S.wb ? { ic: 'full', t: '收起工作台', k: '小窗 面板', run: function () { unwork(); } } : { ic: 'full', t: '全屏工作台', k: '全屏 工作台', run: function () { work(); } });
    return x;
  }
  // 站长 2026-11-19：深浅色从点的那个地方一圈圈扩散着换（View Transitions；不支持或减少动态时直接换）
  // 圈从「刚才点的地方」扩散：只认 1.5 秒内的；命令面板里选的由 palRun 记下位置，都没有就从屏幕中间
  var LASTPT = null; document.addEventListener('pointerdown', function (e) { LASTPT = [e.clientX, e.clientY, Date.now()]; }, true);
  function freshPt() { return LASTPT && Date.now() - LASTPT[2] < 1500 ? LASTPT : null; }
  function themeSwap(apply) {
    var de = document.documentElement;
    if (!document.startViewTransition || reduceMotion()) { apply(); return; }
    var p = freshPt() || [innerWidth / 2, innerHeight / 2];
    de.style.setProperty('--vt-x', p[0] + 'px'); de.style.setProperty('--vt-y', p[1] + 'px'); de.classList.add('vt-theme');
    var done = function () { de.classList.remove('vt-theme'); }, vt = document.startViewTransition(apply); vt.finished.then(done, done);
  }
  function flipTheme() {
    var dark = document.documentElement.dataset.theme === 'dark';
    try { localStorage.setItem('lm.theme', dark ? 'light' : 'dark'); } catch (e) { /* 存不了就只换这一次 */ }
    themeSwap(function () {
      var h_ = document.documentElement; h_.dataset.theme = dark ? 'light' : 'dark'; h_.dataset.pref = dark ? 'light' : 'dark';
      var m = document.getElementById('themeColor'); if (m) m.setAttribute('content', TQ ? (dark ? '#090c14' : '#0d1019') : (dark ? '#faf9f5' : '#1f1e1d'));
    });
    [].forEach.call(document.querySelectorAll('iframe'), function (f) { try { f.contentWindow.postMessage({ type: 'theme' }, location.origin); } catch (er) { /* 别的源 */ } });
    toast(dark ? '换成浅色了' : '换成深色了');
  }
  function openSettings() {
    var b = drawerEl && drawerEl.querySelector('.xc-set-b'), set = drawerEl && drawerEl.querySelector('.xc-set');
    if (b && set && set.hidden) b.click(); else if (set) set.scrollIntoView({ block: 'nearest' });
  }
  function openPal() {
    if (!root || !S.authed) return;
    setTray(false); setMenu(false); setPick(false);
    if (!palEl.classList.contains('in') && !palEl.contains(document.activeElement)) palBack = document.activeElement;
    if (!S.sessList) call('sessions', {}, 60000).then(function (d) { S.sessList = d.sessions || []; if (!palEl.hidden) palRender(); }, function () {});
    palEl.innerHTML = '';
    var box = h('div', 'xc-pal-box'), top = h('div', 'xc-pal-q'), inp = h('input'), l = h('div', 'xc-pal-l');
    top.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/></svg>';
    inp.type = 'search'; inp.placeholder = '搜索对话，或者输入要做的事'; inp.setAttribute('aria-label', '搜索对话和功能'); inp.setAttribute('autocomplete', 'off'); inp.setAttribute('enterkeyhint', 'go');
    inp.setAttribute('role', 'combobox'); inp.setAttribute('aria-controls', 'xin-pal-l'); inp.setAttribute('aria-expanded', 'true');
    l.id = 'xin-pal-l'; l.setAttribute('role', 'listbox');
    var esc = h('button', 'xc-pal-x', 'Esc'); esc.type = 'button'; esc.setAttribute('aria-label', '关掉'); esc.addEventListener('click', closePal);
    top.appendChild(inp); top.appendChild(esc); box.appendChild(top); box.appendChild(l); palEl.appendChild(box);
    palEl.hidden = false; root.classList.add('pal-open');
    requestAnimationFrame(function () { palEl.classList.add('in'); });
    palEl.onclick = function (e) { if (e.target === palEl) closePal(); };
    inp.addEventListener('input', function () { palIdx = 0; palRender(); });
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); palMove(e.key === 'ArrowDown' ? 1 : -1); }
      else if (e.key === 'Enter') { if (e.isComposing || e.keyCode === 229) return; e.preventDefault(); palRun(palIdx); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePal(); }
    });
    palIdx = 0; palRender();
    // 当场给焦点：按完 Ctrl+K 马上打字不丢字；手机上要在点击的同一刻聚焦才弹得出键盘
    inp.focus({ preventScroll: true });
  }
  function closePal() {
    if (!palEl || palEl.hidden) return;
    palEl.classList.remove('in'); root.classList.remove('pal-open');
    var back = palBack; palBack = null;
    if (palEl.contains(document.activeElement)) { if (back && back !== document.body && document.contains(back) && !touch) back.focus({ preventScroll: true }); else document.activeElement.blur(); }
    setTimeout(function () { if (!palEl.classList.contains('in')) palEl.hidden = true; }, reduceMotion() ? 0 : 140);
  }
  function palRender() {
    var inp = palEl.querySelector('input'), l = palEl.querySelector('.xc-pal-l'); if (!inp || !l) return;
    var q = inp.value.trim().toLowerCase(), hit = function (s) { return !q || String(s || '').toLowerCase().indexOf(q) >= 0; };
    var acts = palActions().filter(function (a) { return hit(a.t) || hit(a.k); });
    var sess = (S.sessList || []).filter(function (s_) { return !s_.archived && hit(s_.main ? '主对话 ' + (s_.title || '') : s_.title); }).slice(0, q ? 12 : 6);
    var tasks = TQ ? [] : allTasks().filter(function (t) { return (tLive(t) || t.status === 'waiting') && hit(t.title); }).slice(0, 6);
    palItems = []; l.textContent = '';
    var group = function (name, arr, mk) {
      if (!arr.length) return;
      l.appendChild(h('p', 'xc-pal-g', name));
      arr.forEach(function (it) { var o = mk(it); palItems.push(o); l.appendChild(o.el); });
    };
    var item = function (ic, text, meta, run, cls) {
      var b = h('button', 'xc-pal-i' + (cls ? ' ' + cls : '')); b.type = 'button'; b.setAttribute('role', 'option'); b.id = 'xin-pal-' + palItems.length;
      b.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">' + (PICON[ic] || PICON.chat) + '</svg>';
      b.appendChild(h('span', 'xc-pal-t', text)); if (meta) b.appendChild(h('span', 'xc-pal-m', meta));
      var o = { el: b, run: run }, i = palItems.length;
      b.addEventListener('mousemove', function () { if (palIdx !== i) { palIdx = i; palPaint(); } });
      b.addEventListener('click', function (ev) { palRun(i, ev); });
      return o;
    };
    if (q) group('对话', sess, function (s_) { return item('chat', s_.main ? '主对话' : s_.title || '（无标题）', s_.active ? '进行中' : s_.updated ? when(s_.updated) : '', function () { if (s_.main) goMain(); else openSession(s_.sid); }); });
    group('在做的事', tasks, function (t) { return item('task', t.title, tStatText(t), function () { openTask(t.sid); }, t.status === 'waiting' ? 'wait' : 'live'); });
    group(q ? '操作' : '常用', acts, function (a) { return item(a.ic, a.t, '', a.run); });
    if (!q) group('最近的对话', sess, function (s_) { return item('chat', s_.main ? '主对话' : s_.title || '（无标题）', s_.active ? '进行中' : s_.updated ? when(s_.updated) : '', function () { if (s_.main) goMain(); else openSession(s_.sid); }); });
    if (!palItems.length) {
      var e = h('div', 'xc-pal-e'); e.appendChild(h('b', '', '没有找到「' + inp.value.trim() + '」'));
      var b = h('button', 'xc-pal-i'); b.type = 'button'; b.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">' + PICON.chat + '</svg>';
      b.appendChild(h('span', 'xc-pal-t', '直接问' + (TQ ? '天启' : '小芯') + '：' + inp.value.trim()));
      var said = inp.value.trim(), o = { el: b, run: function () { input.value = said; ls(LS_DRAFT, said); grow(); renderSendBtn(); input.focus(); } };
      b.addEventListener('click', function (ev) { palRun(0, ev); }); palItems.push(o); e.appendChild(b); l.appendChild(e);
    }
    palIdx = Math.min(palIdx, Math.max(0, palItems.length - 1)); palPaint();
  }
  function palPaint() {
    palItems.forEach(function (o, i) { o.el.classList.toggle('on', i === palIdx); o.el.setAttribute('aria-selected', i === palIdx ? 'true' : 'false'); });
    var cur = palItems[palIdx], inp = palEl.querySelector('input');
    if (cur) { cur.el.scrollIntoView({ block: 'nearest' }); if (inp) inp.setAttribute('aria-activedescendant', cur.el.id); }
  }
  function palMove(d) { if (!palItems.length) return; palIdx = (palIdx + d + palItems.length) % palItems.length; palPaint(); }
  // 点的就从点的地方；用键盘选的（回车，或者键盘「点」按钮时 detail 是 0）从选中那一项的图标那儿
  function palRun(i, ev) {
    var o = palItems[i]; if (!o) return;
    var r = o.el.getBoundingClientRect(); LASTPT = ev && ev.detail ? [ev.clientX, ev.clientY, Date.now()] : [r.left + 22, r.top + r.height / 2, Date.now()];
    closePal(); setDrawer(false); setTimeout(o.run, 10);
  }

  /* ---------- 轻提示：底部中间一颗小药丸，不抢焦点，3 秒后消失 ---------- */
  var toastTm = 0;
  function toast(msg) {
    if (!toastEl) return;
    toastEl.textContent = msg; toastEl.classList.remove('in'); void toastEl.offsetWidth; toastEl.classList.add('in');
    clearTimeout(toastTm); toastTm = setTimeout(function () { toastEl.classList.remove('in'); }, 3000);
  }
  document.addEventListener('keydown', function (e) {
    if (e.defaultPrevented || !S.open || !S.authed || !root) return;
    if ((e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey) && !e.altKey) { e.preventDefault(); if (palEl.classList.contains('in')) closePal(); else openPal(); }
  });

  /* ---------- 启动 ---------- */
  /* ---------- 打开网页就叫醒云电脑：等你发第一句话时它已经醒了 ----------
     登录了才叫；已经醒着什么都不做；离开页面超过 10 分钟再回来时再叫一次（它空闲 30 分钟会自己睡）。失败不提示，发消息时还会再叫。 */
  var wokeAt = 0, xinWasInTianqi = tianqiOpen(), startXinOnReturn = xinWasInTianqi, wakeXinOnReturn = false, xinMeSeq = 0;
  function tianqiOpen() { return !TQ && /^\/tianqi\/?$/.test(location.pathname); }
  function refreshXinMe(ready, failed) {
    var seq = ++xinMeSeq;
    req('me').then(function (d) {
      if (seq !== xinMeSeq) return;
      var authChanged = S.authed !== !!d.authed;
      S.enabled = !!d.enabled; S.authed = !!d.authed; S.streamOn = !!d.stream;
      syncBag(); if (S.enabled) buildHome();
      ready(authChanged);
    }, function () { if (seq === xinMeSeq && failed) failed(); });
  }
  function startXinActivity() {
    if (tianqiOpen()) { startXinOnReturn = true; return; }
    wakeVm(); greet(); syncPushDevice(); loadDeliveries();
    if (S.authed) { status(); pollWork(); }
  }
  function resumeXinActivity() {
    if (tianqiOpen()) { xinWasInTianqi = true; return; }
    if (!xinWasInTianqi) return;
    xinWasInTianqi = false;
    // 内嵌的天启可能更新了两边共用的登录 cookie。
    refreshXinMe(function (authChanged) {
      if (tianqiOpen()) return;
      if (authChanged) { render(); renderHome(); if (S.authed && S.open) loadCurrent(); }
      if (startXinOnReturn || (authChanged && S.authed)) {
        startXinOnReturn = wakeXinOnReturn = false;
        startXinActivity();
      } else if (wakeXinOnReturn) {
        wakeXinOnReturn = false;
        wakeVm(); greet();
      }
      openFromHash();
    });
  }
  function wakeVm() {
    if (!S.enabled || !S.authed) return;
    if (tianqiOpen()) { wakeXinOnReturn = true; return; }
    wokeAt = Date.now();
    call('wake', {}, 0).catch(function () {});
  }
  // 流带着「在不在看」：可见性、焦点变了就重新连一次，让控制器知道
  function restartStream() { if (S.polling && S.streamOn && streamCtl) { streamCtl.abort(); streamCtl = null; follow(); } }
  window.addEventListener('focus', restartStream); window.addEventListener('blur', restartStream);
  document.addEventListener('visibilitychange', function () {
    restartStream();
    if (document.hidden) return;
    if (Date.now() - wokeAt > 600000) { wakeVm(); if (TQ) pingTianqi(); else greet(); }
    if (!TQ && S.bg > 0) pollTasksSoon(500);
    if (!TQ && S.authed && (homeShown() || workShown())) pollWork();
  });

  /* ---------- 见面打招呼：小芯用 xin next 留的那句话（比如每日任务的结果），打开网页时在气泡里说 ----------
     同一句只说一次（记在本机）；小芯不在屏幕上（收起来了、在别处）就等它出来再说。点气泡回它一句。
     取这句话时云电脑顺便预热模型网关（刚睡醒的第一个请求常常卡很久）。 */
  var GREETED = LS_PFX + 'greeted';
  function greet() {
    if (TQ || !S.enabled || !S.authed) return;
    if (tianqiOpen()) { wakeXinOnReturn = true; return; }
    call('greet', {deviceId:S.deviceId,agent:S.sessAgent||S.agent}, 60000).then(function (g) {
      if (g && g.moves) setMoves(g.moves);
      if (g && g.bond) setBond(g.bond);
      if (g && 'main' in g) {
        setMain(g.main);
        // 正停在主对话的空白页（还没开始打字发送）：把它读出来
        if (g.main && mainDraft() && !S.sending && !S.run && !S.loadingConversation) { if (S.open && S.authed) openSession(g.main); else S.histFor = ''; }
      }
      glowFrom(g);
      if (g && g.bg) { S.bg = g.bg; pollTasksSoon(500); }   // 后台有任务在做：看看进度（做完了小芯会冒气泡）
      if (!g || !g.id || !g.text || ls(GREETED) === g.id) {
        if (g && g.bg) setTimeout(function () { var x = xin(); if (x && x.say && x.mode !== 'away' && !x.asking && !S.open) x.say('我还在忙着（' + g.bg + ' 件事），好了告诉你', 6000, openTaskCenter); }, 2500);
        return;
      }
      var tries = 0;
      (function show() {
        var x = xin();
        if (!x || !x.say || x.mode === 'away' || x.asking) { if (tries++ < 30) setTimeout(show, 2000); return; }
        ls(GREETED, g.id);
        x.say(g.text, 14000, function () { quick(x); });
        if (x.cmd) x.cmd('happy');
      })();
    }, function () {});
  }

  // #xin 打开面板；#xin=<对话编号>（点「做完提醒」的通知进来的）打开那段对话
  var XIN_HASH = /^#xin(=s[0-9a-z]{6,24})?$/;
  function openFromHash() {
    if (tianqiOpen()) return;
    if (location.hash === '#xin-work') { if (!S.open || !S.wb) work({ keepHash: true }); return; }
    var m = XIN_HASH.exec(location.hash);
    if (!m) return;
    openConversation(m[1] ? m[1].slice(1) : '');
  }
  function boot() {
    if (TQ) {
      window.addEventListener('message', function (e) {
        if (e.origin === location.origin && e.data && e.data.type === 'reset' && root) {
          closePal(); setMenu(false); setPick(false); setSheet(false); setDrawer(false);
          if (TW && TW.isOpen()) TW.close(false);
          if (S.view !== 'chat') { S.view = 'chat'; render(); }
        }
      });
      req('me').then(function (d) {
        S.enabled = !!d.enabled; S.authed = !!d.authed; S.streamOn = !!d.stream;
        work({ keepHash: true });
        if (window.parent && window.parent !== window) { try { window.parent.postMessage({ type: 'ready' }, location.origin); } catch (e) {} }
        if (S.enabled && S.authed) { wakeVm(); loadDeliveries(); pingTianqi(); }
      }, function () {
        S.enabled = false; work({ keepHash: true });
        if (window.parent && window.parent !== window) { try { window.parent.postMessage({ type: 'ready' }, location.origin); } catch (e) {} }
      });
      return;
    }
    // 浏览器历史返回和工具直接关闭都能恢复首页活动。
    window.addEventListener('popstate', resumeXinActivity);
    new MutationObserver(resumeXinActivity).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    watchDoc(document);
    // 学习台在 iframe 里：它加载好就开始记选中的文字
    document.addEventListener('load', function (e) { if (e.target && e.target.tagName === 'IFRAME') try { watchDoc(e.target.contentDocument); } catch (er) {} }, true);
    [].forEach.call(document.querySelectorAll('iframe'), function (f) { try { watchDoc(f.contentDocument); } catch (er) {} });
    refreshXinMe(function () {
      startXinActivity();
      openFromHash();
      // 刷新页面时上一轮还在跑：小芯接着陪着（打开面板时会接上）
    }, function () { if (XIN_HASH.test(location.hash)) { S.enabled = false; open(); } });
    window.addEventListener('hashchange', openFromHash);
  }
  window.addEventListener('pagehide',function(){
    if(!TQ&&S.authed&&S.sid&&(S.run||S.bg>0))fetch(API+'call',{method:'POST',credentials:'same-origin',keepalive:true,headers:{'Content-Type':'application/json','X-Xin':'1'},body:JSON.stringify({op:'tasks',args:{sid:S.sid,deviceId:S.deviceId,tabId:S.tabId,watching:false}})}).catch(function(){});
  });
  // 站长 2026-11-19：在做的小方点改成呼吸，各自错开节拍——每个点进页面时随机给一个相位（--ph，CSS 里当负的延迟）
  var PH = '.xc-st,.xc-dr-st,.xc-mainb i,.xc-si-m > *,.wk-ic,.xc-task-st,.xc-tk-cmd,.xw-st i,.xw-g';
  function phase(n) { if (n.nodeType !== 1) return; (n.matches(PH) ? [n] : []).concat([].slice.call(n.querySelectorAll(PH))).forEach(function (e) { if (!e.style.getPropertyValue('--ph')) e.style.setProperty('--ph', (Math.random() * 1.8).toFixed(2) + 's'); }); }
  new MutationObserver(function (ms) { ms.forEach(function (m) { [].forEach.call(m.addedNodes, phase); }); }).observe(document.body, { childList: true, subtree: true });
  phase(document.body);
  window.LimingXinChat = { open: open, close: close, work: work, ask: quick, played: played, page: page, tasks: function () { pollTasks(); }, get state() { return S; } };
  boot();
})();
