/* mascot.js — 小芯（像素风），首页和 STM32 学习台共用
   一块像素小芯片：两只引脚手、四只引脚脚、两只发光像素眼。整个页面都是它的地盘：
   首页能站在标题栏、每张卡片的上沿，也能跳进卡片里沿着底边走；学习台里在芯片图、标题区、代码框这些方块的上沿走来走去。
   平台之间先蹲一下再划弧线跳过去，落到方块上时那块被压得往下沉一下；页面滚走了，它会跳回你正在看的地方。
   学习台里只有被你从首页拖着扔进 STM32 卡片时才有小芯；关掉学习台，它跳回首页。
   会眨眼、眼睛跟着指针/手指，没人理就坐下睡觉；闲着会从背后摸出饼干吃、抛小球、玩 LED。
   点它会跳，连点会晕；拎起来乱蹬，半空松手就往下掉到最近的方块上；首页拖到卡片上松手就打开那个工具。
   有脾气：连戳、被扔、被拎太久、被吵醒会攒火气，攒够了砸东西（耳机、LED），跺脚，抱着胳膊哼一声背过身去；听歌听久了会烦，把耳机砸了。
   会荡秋千、跳舞、坐在边上晃腿、走着走着绊一跤；有点叛逆：让它睡、叫它过来有时候偏不，吃饱了不吃，被拎走了偏要走回去，冲你吐舌头。
   学习台里你在看代码区时，它跳到代码框上掏出笔记本敲代码，停下来想；想通了开心，想不出来会烦躁、伤心、生气，甚至把电脑砸了。
   画法：20×20 动作坐标，机身用分层倒角、像素眼和金属引脚复刻参考造型；动作仍然逐帧拼合。
   坐标：小芯挂在 body 下的一层（.xin-layer），x / y 是它左上角在整个文档里的位置。 */
(function () {
  'use strict';
  if (!window.requestAnimationFrame || !document.body) return;
  var track = document.getElementById('xinTrack'), grid = document.getElementById('grid');
  var HOME = !!(track && grid), STM = !HOME && !!document.getElementById('main');
  if (!HOME && !STM) return;
  var body = document.body;
  var reduce = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
  var G = 20, W = 80, H = 80, SLEEP_AFTER = 30000;

  /* ---------- 像素造型 ----------
     身子：x 4..15、y 7..16（外框一圈深色，顶边正中一个芯片缺口）；姿势里的 b 是身子往下蹲几格。
     脚：x = 5.5 / 7.5 / 12 / 14（都在身子里面，中间两条隔得开一点），3 格长，从身子下面到地面 y = 19；蹲下时脚尖往外撇。
     手：从身子两侧水平伸出来。
     下面 ARM / FACE / 饼干 / LED 的坐标都按身子在 y 6 写的，画的时候整体再往下挪 OY 格。 */
  var LEG_X = [5.5, 7.5, 12, 14], OY = 1;
  // 手是一根粗引脚（2 格粗、3 格长），不分节：平时水平伸出、垂直于身子侧边，做动作时整根换个朝向。
  // [x, y, 宽, 高]，左手；右手按 x → 20 - x - 宽 镜像
  var ARM = {
    out:    [[1.7, 7.2, 2.3, 2.6]],
    swingF: [[1, 9, 3, 2]],
    swingB: [[1, 11, 3, 2]],
    up:     [[2, 7, 2, 3]],
    wave:   [[3, 9, 1, 2], [2, 8, 1, 2], [1, 7, 1, 2]],
    hold:   [[2, 10, 2, 2]],
    back:   [[3, 10, 1, 2]],
    down:   [[2, 11, 2, 3]],
    crossA: [[3, 11, 8, 1]],      // 抱着胳膊：左手横在前面一行
    crossB: [[3, 12, 8, 1]],      // 右手（镜像后）横在下一行，两只手交叉
    typeUp: [[2, 13, 2, 2]],      // 侧身敲键盘：手抬起来
    typeDn: [[2, 14, 2, 2]],      //             手按下去（正好碰到键盘）
    none:   []                    // 侧身时另一只手在身子后面看不见
  };
  // 脸：[x, y, 宽, 高, 颜色]；eyes / blink 会跟着视线挪一格
  var FACE = {
    // 参考图的 > < 由正方形像素拼成；缩小视线位移，避免眼睛撞到倒角内框。
    eyes: function (lx, ly) {
      var x = lx * .35, y = 8.25 + ly * .35;
      return [
        [6.5 + x, y, .625, .625], [7.125 + x, y + .625, .625, .625], [7.75 + x, y + 1.25, .625, .625], [7.125 + x, y + 1.875, .625, .625], [6.5 + x, y + 2.5, .625, .625],
        [12.875 + x, y, .625, .625], [12.25 + x, y + .625, .625, .625], [11.625 + x, y + 1.25, .625, .625], [12.25 + x, y + 1.875, .625, .625], [12.875 + x, y + 2.5, .625, .625]
      ];
    },
    blink: function (lx, ly) { return [[6.1 + lx * .35, 9.65 + ly * .35, 2.5, .4], [11.4 + lx * .35, 9.65 + ly * .35, 2.5, .4]]; },
    hap:   [[6.1, 9.5, .625, .85], [6.725, 8.875, 1.25, .625], [7.975, 9.5, .625, .85], [11.4, 9.5, .625, .85], [12.025, 8.875, 1.25, .625], [13.275, 9.5, .625, .85]],
    shut:  [[6.1, 9.65, 2.5, .4], [11.4, 9.65, 2.5, .4]],
    focus: [[6.85, 8.75, .95, 2.2], [12.2, 8.75, .95, 2.2]],
    calm:  [[6.1, 9.5, 2.5, .45], [6.75, 9.95, 1.2, .95], [11.4, 9.5, 2.5, .45], [12.05, 9.95, 1.2, .95]],
    love:  [[6.2, 8.6, .9, .45], [7.55, 8.6, .9, .45], [5.75, 9.05, 3.15, .9], [6.2, 9.95, 2.25, .45], [6.65, 10.4, 1.35, .45], [7.1, 10.85, .45, .45], [11.55, 8.6, .9, .45], [12.9, 8.6, .9, .45], [11.1, 9.05, 3.15, .9], [11.55, 9.95, 2.25, .45], [12, 10.4, 1.35, .45], [12.45, 10.85, .45, .45]],
    dz:    [[5, 7], [7, 7], [6, 8], [5, 9], [7, 9], [12, 7], [14, 7], [13, 8], [12, 9], [14, 9]],
    wow:   [[7.1, 8.25, .5, 3], [5.85, 9.5, 3, .5], [6.6, 9, .5, .5], [7.6, 9, .5, .5], [6.6, 10, .5, .5], [7.6, 10, .5, .5], [12.4, 8.25, .5, 3], [11.15, 9.5, 3, .5], [11.9, 9, .5, .5], [12.9, 9, .5, .5], [11.9, 10, .5, .5], [12.9, 10, .5, .5]],
    sad:   [[6, 10, 2, 1], [12, 10, 2, 1]],
    scared:   [[6, 7, 2, 3], [12, 7, 2, 3], [16, 5, 1, 1, 'sw'], [16, 6, 1, 1, 'sw'], [17, 7, 1, 1, 'sw']],   // 眼睛瞪圆 + 一滴汗
    confused: [[6, 8, 2, 2], [12, 9, 2, 1]],                                                          // 一只眼眯起来
    angry:    [[5, 7], [6, 7], [7, 8], [12, 8], [13, 7], [14, 7], [6, 9, 2, 1], [12, 9, 2, 1]],      // 眉毛往中间压
    cry:      [[6, 9, 2, 1], [12, 9, 2, 1], [5, 10], [14, 10]],                                          // 眼睛闭成两条线
    pout:     [[5, 7], [6, 7], [7, 8], [12, 8], [13, 7], [14, 7], [6, 10, 2, 1], [12, 10, 2, 1]],        // 哼：眉毛压着、眼睛闭上
    tongue:   [[6, 8, 2, 2], [12, 9, 2, 1], [8, 11, 4, 1, 'o'], [10, 12, 2, 2, 'tg']],                   // 挤一只眼、吐舌头
    back:     [],                                                                                    // 背过身去：只看得到芯片背面
    // 侧身朝右（敲代码）：只看得到靠前的一只眼睛
    side:     function (lx, ly) { return [[12, 8 + ly, 2, 2]]; },
    sidePout: [[11, 7], [12, 7], [13, 8], [12, 10, 2, 1]],                                                // 侧脸皱眉、眯眼
    sideSad:  [[11, 9], [12, 10, 2, 1]]                                                                   // 侧脸耷拉着眼
  };
  // 音符（绝对格子坐标）
  function noteFx(nx, ny) { return [[nx, ny + 2, 'q'], [nx + 1, ny + 2, 'q'], [nx + 1, ny + 1, 'q'], [nx + 1, ny, 'q'], [nx + 2, ny, 'q']]; }
  var QMARK = [[16, 1, 'q'], [17, 1, 'q'], [18, 2, 'q'], [17, 3, 'q'], [17, 5, 'q']];   // 头顶上的「？」
  // 圆饼干 4×4（ck 饼干色、cc 巧克力豆），从上往下一口一口咬
  var COOKIE = [[1, 0, 'ck'], [2, 0, 'ck'], [0, 1, 'ck'], [1, 1, 'cc'], [2, 1, 'ck'], [3, 1, 'ck'], [0, 2, 'ck'], [1, 2, 'ck'], [2, 2, 'ck'], [3, 2, 'cc'], [1, 3, 'ck'], [2, 3, 'ck']];
  var BITE_ROWS = [-1, 0, 1, 3];   // 咬了 n 口以后，第几行（含）以上都没了

  function straight(x) { return [[x, 17], [x, 18], [x, 19]]; }
  // 蹲：脚变短，脚尖往外撇（b = 1 蹲一格，b = 2 蹲到底）
  function bent(x, s, b) { return b === 1 ? [[x, 18], [x + s, 19]] : [[x + s, 19]]; }

  function draw(p, prefix) {
    var o = [], lb = p.b | 0, b = lb + OY, sx = p.sx | 0, i;
    prefix = prefix || 'xin-body';
    function R(x, y, w, h, c) { o.push('<rect class="c-' + c + '" x="' + x + '" y="' + y + '" width="' + (w || 1) + '" height="' + (h || 1) + '"/>'); }
    function P(points, fill) { o.push('<polygon points="' + points.map(function (a) { return a.join(','); }).join(' ') + '" fill="' + fill + '"/>'); }
    function metal(x, y, w, h) {
      o.push('<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" fill="url(#' + prefix + '-pin)"/>');
    }
    o.push('<defs><linearGradient id="' + prefix + '-pin"><stop stop-color="#c2b19c"/><stop offset=".45" stop-color="#dfd0ba"/><stop offset="1" stop-color="#bcaa94"/></linearGradient>' +
      '<linearGradient id="' + prefix + '-glass" x2=".9" y2="1"><stop stop-color="#121212"/><stop offset=".55" stop-color="#211e1b"/><stop offset="1" stop-color="#171615"/></linearGradient>' +
      '<linearGradient id="' + prefix + '-bevel" x2="1" y2="1"><stop stop-color="#56534c"/><stop offset=".2" stop-color="#373530"/><stop offset=".7" stop-color="#252421"/><stop offset="1" stop-color="#111110"/></linearGradient></defs>');
    // 脚（画在身子后面）
    for (i = 0; i < 4; i++) {
      var lx = LEG_X[i], s = i < 2 ? -1 : 1, A = i % 2 === 0, q = p.lp | 0, pix;
      if (p.legs === 'walk') pix = ((q === 0 && A) || (q === 2 && !A)) ? [[lx, 17], [lx + (p.dir || 1), 18]] : (lb ? bent(lx, s, lb) : straight(lx));
      else if (p.legs === 'tuck') pix = [[lx, 17 + lb], [lx + s, 18 + lb]];
      else if (p.legs === 'dangle') pix = ((q === 0) === A) ? straight(lx) : [[lx, 17], [lx - s, 18]];
      else pix = lb ? bent(lx, s, lb) : straight(lx);
      pix.forEach(function (c) { metal(c[0], c[1], 1, 1); });
    }
    // 身子
    var X = 4 + sx, Y = 6 + b;
    // 顶部两段凸台、中央缺口、黑色厚框、斜切内沿和暗玻璃；颜色不随网页主题改变。
    R(X + .9, Y - .85, 3.75, .85, 'o'); R(X + 7.35, Y - .85, 3.75, .85, 'o');
    R(X + .9, Y - .45, 3.75, .4, 'edge'); R(X + 7.35, Y - .45, 3.75, .4, 'edge');
    P([[X, Y + .35], [X + .4, Y + .35], [X + .4, Y], [X + 4.65, Y], [X + 4.65, Y + .55], [X + 7.35, Y + .55], [X + 7.35, Y], [X + 11.6, Y], [X + 11.6, Y + .35], [X + 12, Y + .35], [X + 12, Y + 10], [X, Y + 10]], '#050505');
    R(X + .4, Y + .4, 11.2, 9.2, 'rim');
    P([[X + .7, Y + .75], [X + 4.65, Y + .75], [X + 4.65, Y + 1], [X + 7.35, Y + 1], [X + 7.35, Y + .75], [X + 11.3, Y + .75], [X + 11.3, Y + 9.35], [X + .7, Y + 9.35]], 'url(#' + prefix + '-bevel)');
    P([[X + 1.2, Y + 1.3], [X + 10.8, Y + 1.3], [X + 10.8, Y + 8.8], [X + 1.2, Y + 8.8]], 'url(#' + prefix + '-glass)');
    P([[X + .7, Y + .75], [X + 1.2, Y + 1.3], [X + 1.2, Y + 8.8], [X + .7, Y + 9.35]], '#3c3933');
    P([[X + 10.8, Y + 1.3], [X + 11.3, Y + .75], [X + 11.3, Y + 9.35], [X + 10.8, Y + 8.8]], '#121211');
    R(X + .6, Y + .05, 4.05, .2, 'edge'); R(X + 7.35, Y + .05, 4.05, .2, 'edge');
    R(X + 4.65, Y + .55, 2.7, .25, 'edge'); R(X + .15, Y + .6, .15, 8.9, 'rim');
    // 脸
    var f = FACE[p.face] || FACE.eyes, fl = typeof f === 'function' ? f(p.lx | 0, p.ly | 0) : f;
    fl.forEach(function (c) { R(c[0] + sx, c[1] + b, c[2] || 1, c[3] || 1, c[4] || 'ew'); });
    // 腮红固定在脸颊，不跟着视线跑；背面、生气和伤心时隐藏。
    if (['eyes', 'blink', 'hap', 'wow', 'focus', 'calm', 'love', 'shut', 'confused', 'tongue'].indexOf(p.face) >= 0) {
      [5.8, 6.8, 12.2, 13.2].forEach(function (cx) {
        P([[cx + sx + .25, 12.35 + b], [cx + sx + 1, 12.35 + b], [cx + sx + .75, 13.1 + b], [cx + sx, 13.1 + b]], 'var(--xr)');
      });
    }
    // 手里的东西
    var it = p.item;
    if (it && it.k === 'cookie') {
      var gone = BITE_ROWS[Math.min(3, it.n | 0)];
      COOKIE.forEach(function (c) { if (c[1] > gone) R(8 + c[0] + sx, 12 + c[1] + b, 1, 1, c[2]); });
    }
    if (it && it.k === 'led') {
      var LX = it.x != null ? it.x : 8 + sx, LY = it.y != null ? it.y : 12 + b;
      R(LX + 1, LY, 2, 2, it.on ? 'lon' : 'led'); R(LX, LY + 2, 4, 1, 'lb'); R(LX + 1, LY + 3, 1, 1, 'p'); R(LX + 2, LY + 3, 1, 1, 'p');
      if (it.on) { R(LX, LY - 1, 1, 1, 'gl'); R(LX + 3, LY - 1, 1, 1, 'gl'); R(LX - 1, LY + 1, 1, 1, 'gl'); R(LX + 4, LY + 1, 1, 1, 'gl'); }
    }
    // 嘴：只有吃东西时才有（1 合上，2 张开咬下去）
    if (p.mouth) R(9 + sx, 11 + b, 2, p.mouth === 2 ? 2 : 1, 'o');
    // 手（在身子前面）
    [[p.armL || 'out', false], [p.armR || 'wave', true]].forEach(function (a) {
      (ARM[a[0]] || ARM.out).forEach(function (c) { metal((a[1] ? 20 - c[0] - c[2] : c[0]) + sx, c[1] + b, c[2], c[3]); });
    });
    if (it && it.k === 'ball') { R(it.x, it.y, 2, 2, 'ball'); R(it.x, it.y, 1, 1, 'bh'); }
    if (it && it.k === 'batt') {             // 电池：4×4，绿色格子是电量
      R(9 + sx, 11 + b, 2, 1, 'bt'); R(8 + sx, 12 + b, 4, 4, 'bt');
      for (var bi = 0; bi < (it.n | 0); bi++) R(9 + sx, 14 + b - bi, 2, 1, 'bl');
    }
    if (it && it.k === 'pcs') {              // 侧面看的笔记本：放在它右前方的地上，键盘一条，屏幕竖起来往后仰一点，屏幕的光朝着它
      R(16, 18, 7, 1, 'lt'); R(16, 19, 7, 1, 'lk');
      R(23, 12, 1, 7, 'lk'); R(24, 9, 1, 3, 'lk'); R(22, 12, 1, 6, 'sc'); R(23, 9, 1, 3, 'sc');
    }
    if (it && it.k === 'pc') {               // 笔记本：平时搁在腿上（我们看到的是屏幕背面），举起来 / 砸到地上时用绝对坐标
      // 屏幕背面：深色边框 + 浅灰壳 + 中间一个小标；下面一条更宽的键盘底座
      if (it.y == null) { R(5 + sx, 11 + b, 10, 6, 'lk'); R(6 + sx, 12 + b, 8, 4, 'lt'); R(9 + sx, 13 + b, 2, 2, 'lg'); R(3 + sx, 17 + b, 14, 1, 'lk'); }
      else { R(3, it.y, 14, 6, 'lk'); R(4, it.y + 1, 12, 4, 'lt'); R(9, it.y + 2, 2, 2, 'lg'); R(2, it.y + 6, 16, 1, 'lk'); }
    }
    if (it && it.k === 'phones') {           // 摘下来拿在手里的耳机（绝对格子坐标，y 是头箍那一行）
      var py = it.y;
      R(4, py, 12, 1, 'hp'); R(3, py + 1, 1, 1, 'hp'); R(16, py + 1, 1, 1, 'hp'); R(2, py + 2, 2, 2, 'hk'); R(16, py + 2, 2, 2, 'hk');
    }
    if (p.phones) {                          // 耳机：头顶一道箍，两边耳罩
      R(5 + sx, 5 + b, 10, 1, 'hp'); R(4 + sx, 6 + b, 1, 2, 'hp'); R(15 + sx, 6 + b, 1, 2, 'hp');
      R(3 + sx, 8 + b, 2, 3, 'hk'); R(15 + sx, 8 + b, 2, 3, 'hk');
    }
    // 灰、饼干渣（绝对位置）
    (p.fx || []).forEach(function (c) { R(c[0], c[1], 1, 1, c[2]); });
    return o.join('');
  }

  var layer = document.createElement('div');
  layer.className = 'xin-layer' + (STM ? ' in-stm' : '');
  var el = document.createElement('div');
  el.className = 'xin';
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = '<div class="xin-r"><div class="xin-s"><svg viewBox="0 0 20 20" focusable="false" shape-rendering="crispEdges"></svg></div></div>';
  var thr = document.createElement('div'); thr.className = 'xin-thread';   // 吊着它的那根线
  layer.appendChild(thr); layer.appendChild(el); body.appendChild(layer);
  var rEl = el.querySelector('.xin-r'), sEl = el.querySelector('.xin-s'), svgEl = el.querySelector('svg');
  function dims() { W = el.offsetWidth || 80; H = el.offsetHeight || 80; }
  dims();

  /* ---------- 状态 ---------- */
  var x = -999, y = -999, sc = 1, ang = 0, av = 0, angT = 0;
  var mode = 'away';                   // idle walk drag fly plug away sleep play
  var tx = 0, dir = 1, raf = 0, lastT = 0, tw = null, drag = null, overCard = null, plat = null;
  var mood = '', moodTm = 0, lookTm = 0, look = { x: 0, y: 0 }, looking = false, blinking = false;
  var seq = null, lastSig = '', tick = 0, forced = null;
  var lastInput = Date.now(), idleTm = 0, blinkTm = 0, zTm = 0, taps = [];
  var music = false, energy = 0;   // 戴着耳机听歌；吃了电池以后一段时间跑得飞快
  // 好感度（小芯电脑上记着，xin/chat.js 告诉这里是第几级）：越熟越听话，叛逆的概率从 0.3 降到 0.08
  var bondLv = 0, obedientF = false, REBEL_BY_BOND = [0.3, 0.22, 0.14, 0.08];
  function rebelBase() { return obedientF ? 0 : REBEL_BY_BOND[bondLv]; }
  function setBond(lv) { bondLv = Math.max(0, Math.min(3, lv | 0)); REBEL = rebelBase(); }

  /* ---------- 学会的新动作 ----------
     小芯在它电脑上用 xin move add 编的：一串姿势帧（只认下面这些字段和取值，和 site/xin/vm-agent.mjs 的 MOVE_ENUM / MOVE_NUM 一致）。
     背包里「新动作」挨个做；闲着时偶尔做一个；聊天时它也能让这里做（xin move 名字）。 */
  var MOVE_ARMS = ['out', 'swingF', 'swingB', 'up', 'wave', 'hold', 'back', 'down', 'crossA', 'crossB'];
  var MOVE_ENUM = { armL: MOVE_ARMS, armR: MOVE_ARMS, legs: ['stand', 'walk', 'tuck', 'dangle'],
    face: ['eyes', 'blink', 'hap', 'shut', 'dz', 'wow', 'sad', 'scared', 'confused', 'angry', 'cry', 'pout', 'tongue', 'back', 'side'] };
  var MOVE_NUM = { t: [60, 1500], b: [0, 2], dy: [-6, 0], sx: [-1, 1], lx: [-1, 1], ly: [-1, 1], lp: [0, 3], mouth: [0, 2] };
  var learned = [], learnI = 0;
  function cleanFrames(frames) {
    if (!Array.isArray(frames) || !frames.length || frames.length > 48) return null;
    var out = [], total = 0;
    for (var i = 0; i < frames.length; i++) {
      var f = frames[i], g = {}, k;
      if (!f || typeof f !== 'object') return null;
      for (k in f) {
        if (!Object.prototype.hasOwnProperty.call(f, k)) continue;
        if (MOVE_ENUM[k]) { if (MOVE_ENUM[k].indexOf(f[k]) < 0) return null; g[k] = f[k]; }
        else if (MOVE_NUM[k]) { if (typeof f[k] !== 'number' || !isFinite(f[k])) return null; g[k] = Math.round(Math.min(MOVE_NUM[k][1], Math.max(MOVE_NUM[k][0], f[k]))); }
        else return null;
      }
      if (!g.t) g.t = 200;
      total += g.t; out.push(g);
    }
    return total <= 15000 ? out : null;
  }
  function learn(list) {
    (list || []).forEach(function (m) {
      var name = m && String(m.name || '').trim().slice(0, 12), fr = m && cleanFrames(m.frames);
      if (!name || !fr) return;
      learned = learned.filter(function (x) { return x.name !== name; });
      learned.push({ name: name, frames: fr });
    });
    learned = learned.slice(-30);
  }
  function findMove(name) { for (var i = 0; i < learned.length; i++) if (learned[i].name === name) return learned[i]; return null; }
  // 学习台里的小芯（iframe）：学会的动作、好感度在外面工具箱页面的 xin/chat.js 那里，拿过来
  function syncLearned() {
    if (!STM || window.parent === window) return;
    try { var c = window.parent.LimingXinChat, st = c && c.state; if (st && st.moves && st.moves.length !== learned.length) learn(st.moves); if (st && st.bond) setBond(st.bond.level); } catch (e) { /* 别的源 */ }
  }
  function doMove(m) {
    if (!m || reduce || paused() || mode === 'away') return false;
    if (mode === 'sleep') { clearTimeout(zTm); clearTimeout(sleepTm); }
    stopWalk(); setMood(''); setMode('play');
    playSeq(m.frames.map(function (f) { return mix({}, f); }), function () { if (mode === 'play') { mode = 'idle'; render(); } schedule(); });
    return true;
  }
  // 你在网页上喂它、陪它玩：告诉 xin/chat.js，小芯电脑那边加好感（一天最多 +3）
  function played(kind) {
    try { var c = window.LimingXinChat || (STM && window.parent !== window ? window.parent.LimingXinChat : null); if (c && c.played) c.played(kind); } catch (e) { /* 别的源 */ }
  }
  var grr = 0, grrT = 0, ragePending = false;   // 脾气：被惹多了就发火砸东西
  var musicAt = 0, boreAt = 0, phonesBroke = 0, ate = [];
  var REBEL = 0.3;                 // 叛逆的概率：不听话、背过身、偏要回去
  var sw = null, backTo = null, tripAt = null;

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function mix(a, b) { var o = {}, k; for (k in a) o[k] = a[k]; for (k in b) o[k] = b[k]; return o; }
  function sX() { return window.pageXOffset || 0; }
  function sY() { return window.pageYOffset || 0; }
  // 学习台嵌在工具箱的面板里：面板收起时（不在看）就歇着
  var panel = null;
  try { panel = window.frameElement && window.frameElement.closest ? window.frameElement.closest('.panel') : null; } catch (e) { panel = null; }
  function hiddenFrame() { return !!panel && !panel.classList.contains('show'); }
  // 「小芯被扔进了哪个工具」：首页把它拖到卡片上松手时记下，学习台里的小芯只有看到这个才出来；回到首页时清掉
  var CARRY = 'lm.xin.in';
  function carried() { try { return sessionStorage.getItem(CARRY) || ''; } catch (e) { return ''; } }
  function carry(v) { try { if (v) sessionStorage.setItem(CARRY, v); else sessionStorage.removeItem(CARRY); } catch (e) {} }
  // 学习台里「收起来」：记在这个标签页里（刷新也还收着）；首页再把它扔进学习台时清掉
  var STMOFF = 'lm.xin.stmoff';
  function stmOff() { try { return sessionStorage.getItem(STMOFF) === '1'; } catch (e) { return false; } }
  function paused() {
    if (document.hidden) return true;
    if (HOME) return body.classList.contains('tool-open') || off();
    return !panel || hiddenFrame() || carried() !== 'stm32' || stmOff();   // 学习台：只有被扔进来、没收起来才出来
  }
  function cls(c, on) { el.classList.toggle(c, !!on); }
  function place() {
    el.style.transform = 'translate3d(' + Math.round(x) + 'px,' + Math.round(y) + 'px,0)' + (sc !== 1 ? ' scale(' + sc.toFixed(3) + ')' : '');
    var q = Math.round(ang / 12) * 12;            // 像素风：摆动角度按 12° 一档跳
    rEl.style.transform = q ? 'rotate(' + q + 'deg)' : '';
    drawThread(); placeSay();
  }
  /* 线：上端挂在 thread.top（文档 y），下端在小芯举起来的右手上 */
  var thread = null;
  function handX() { return x + W * 17 / G; }
  function handY() { return y + H * (7 + OY) / G; }
  function drawThread() {
    var hx = handX(), hy = handY();
    if (!thread || hy <= thread.top) { thr.style.display = 'none'; return; }
    // 荡秋千时线的上端（thread.ax）固定，下端跟着手走，线是斜的
    var ax = thread.ax != null ? thread.ax : hx, dx = hx - ax, dy = hy - thread.top;
    thr.style.display = 'block';
    thr.style.transform = 'translate3d(' + Math.round(ax - 1) + 'px,' + Math.round(thread.top) + 'px,0)' + (Math.abs(dx) > 0.5 ? ' rotate(' + (Math.atan2(-dx, dy) * 180 / Math.PI).toFixed(2) + 'deg)' : '');
    thr.style.height = Math.round(Math.sqrt(dx * dx + dy * dy)) + 'px';
  }
  function animThread(from, to, ms, done) {
    if (!thread) thread = { top: from };
    var t0 = performance.now(), me = thread;
    (function step() {
      if (thread !== me) return;
      var k = clamp((performance.now() - t0) / ms, 0, 1);
      thread.top = from + (to - from) * k; drawThread();
      if (k < 1) requestAnimationFrame(step); else if (done) done();
    })();
  }
  function retract() {   // 落地后线往下收回手里
    if (!thread) return;
    if (reduce) { thread = null; drawThread(); return; }
    animThread(thread.top, handY(), 260, function () { thread = null; drawThread(); });
  }
  function setMode(m) {
    if (mode === 'play' && m !== 'play') stopSeq();
    mode = m;
    cls('is-drag', m === 'drag'); cls('is-air', /^(drag|fly|plug|hang|rope|climb|swing)$/.test(m)); cls('is-away', m === 'away');
    render();
  }
  function setMood(m, ms) {
    clearTimeout(moodTm);
    mood = m || '';
    if (mood && ms) moodTm = setTimeout(function () { setMood(''); }, ms);
    render();
  }

  /* ---------- 平台：能站的地方 ----------
     { el, kind, x0, x1, fy }：x0..x1 是小芯左上角 x 的可走范围，fy 是脚踩的那条线（文档坐标）。
     kind：ground 首页标题栏；top 方块上沿；in 首页卡片里面，沿着底边走。 */
  function shown(e) { return !!e && document.documentElement.contains(e) && !(e.closest && e.closest('[hidden],.hide')) && e.getClientRects().length > 0; }
  function platOf(e, kind) {
    if (!shown(e)) return null;
    var r = e.getBoundingClientRect(), ox = sX(), oy = sY();
    if (r.width < 4) return null;
    // 宽屏上的小芯更大：标题栏落脚点留足头顶空间，顶部凸台不会被视口裁掉。
    if (kind === 'ground') return { el: e, kind: kind, x0: r.left + ox, x1: Math.max(r.left + ox, r.right + ox - W), fy: Math.max(r.bottom + oy + 2, 8 + H * (1 - (6 + OY - .85) / G)) };
    if (kind === 'in') {
      if (r.height < H * 0.8 + 16 || r.width < W + 16) return null;
      return { el: e, kind: kind, x0: r.left + ox + 6, x1: r.right + ox - W - 6, fy: r.bottom + oy - 5 };
    }
    // 脚踩在两条腿之间（格子 5..14），只要这段落在横线上就站得住
    if (r.width < W * 0.55) return null;
    var fy = kind === 'bottom' ? r.bottom + oy : r.top + oy + 1;
    return { el: e, kind: kind === 'bottom' ? 'bottom' : 'top', x0: r.left + ox - W * 0.25, x1: Math.max(r.left + ox - W * 0.25, r.right + ox - W * 0.75), fy: fy };
  }
  /* 学习台：页面上凡是画出来的横线都能站——方块（有边框或底色）站上沿，只有下边框的分隔线站在那条线上。
     吸顶 / 固定的栏会跟着滚动跑，不站；图（svg）里面不找。结果缓存 1.5 秒，只存元素，位置每次现量。 */
  var lineCache = null, lineAt = 0;
  function visible(c) { return c && c !== 'transparent' && !/rgba\([^)]*,\s*0\)$/.test(c); }
  function pinned(e) {
    for (var n = e; n && n !== document.body; n = n.parentElement) { var ps = getComputedStyle(n).position; if (ps === 'sticky' || ps === 'fixed') return true; }
    return false;
  }
  function lines() {
    var now = performance.now();
    if (lineCache && now - lineAt < 1500) return lineCache;
    var root = document.getElementById('main') || document.body, out = [], vh = innerHeight;
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, { acceptNode: function (n) {
      if (n.namespaceURI !== 'http://www.w3.org/1999/xhtml' || n === layer || n.hidden) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    } });
    for (var e = walker.nextNode(); e; e = walker.nextNode()) {
      var r = e.getBoundingClientRect();
      if (r.width < W * 0.55 || r.height < 1 || r.bottom < -vh || r.top > vh * 2) continue;
      var cs = getComputedStyle(e);
      if (cs.visibility === 'hidden' || +cs.opacity === 0) continue;
      var bt = parseFloat(cs.borderTopWidth) > 0 && cs.borderTopStyle !== 'none' && visible(cs.borderTopColor);
      var bb = parseFloat(cs.borderBottomWidth) > 0 && cs.borderBottomStyle !== 'none' && visible(cs.borderBottomColor);
      var bg = r.height >= 20 && visible(cs.backgroundColor) && e !== root;
      if (!bt && !bb && !bg) continue;
      if (pinned(e)) continue;
      if (bt || bg) out.push({ el: e, kind: 'top' });
      if (bb && !bt && !bg) out.push({ el: e, kind: 'bottom' });   // 只有下边框的分隔线（标题下面那条、列表行之间那条）
    }
    lineCache = out; lineAt = now;
    return out;
  }
  function plats() {
    var out = [], add = function (p) { if (p) out.push(p); };
    if (HOME) {
      add(platOf(track, 'ground'));
      grid.querySelectorAll('.card[data-id]').forEach(function (c) { add(platOf(c, 'top')); add(platOf(c, 'in')); });
    } else {
      lines().forEach(function (c) { add(platOf(c.el, c.kind)); });
      // 同一条线上叠着好几个方块（外框套内框）时只留一个
      out.sort(function (a, b) { return a.fy - b.fy || (b.x1 - b.x0) - (a.x1 - a.x0); });
      out = out.filter(function (p, i) {
        for (var j = 0; j < i; j++) { var q = out[j]; if (Math.abs(q.fy - p.fy) < 3 && p.x0 >= q.x0 - 2 && p.x1 <= q.x1 + 2) return false; }
        return true;
      });
    }
    return out;
  }
  // 学习台：屏幕上没有能站的横线时（电脑布局里方块都顶在最上面，站上去头会出屏），就站进大方块里面，沿着底边走
  function inside() {
    var out = [];
    lines().forEach(function (c) {
      if (c.kind !== 'top') return;
      var r = c.el.getBoundingClientRect();
      if (r.height < H * 2 || r.width < W * 2.5) return;
      var p = platOf(c.el, 'in'); if (p) out.push(p);
    });
    out.sort(function (a, b) { return (b.x1 - b.x0) - (a.x1 - a.x0); });
    return out;
  }
  function same(a, b) { return !!a && !!b && a.el === b.el && a.kind === b.kind; }
  // 学习台顶上有一条吸顶的栏（手机上），小芯的身子不能钻到它底下
  function topPad() {
    if (HOME) return 0;
    var b = document.getElementById('bar'), r = b && b.getBoundingClientRect();
    return r && r.height && r.bottom > 0 ? r.bottom : 0;
  }
  function inView(p) {
    var top = sY() + topPad(), bot = sY() + innerHeight - 8;
    return p.fy - H * 0.62 > top && p.fy < bot;
  }
  function onScreen() { var feet = y + H; return feet > sY() + 20 && y < sY() + innerHeight - 20; }
  // 页面里最合适落脚的地方：看得见的平台里离屏幕中间最近的（首页优先标题栏）
  function bestPlat() {
    var ps = plats().filter(function (p) { return inView(p); });
    if (HOME) { var g = ps.filter(function (p) { return p.kind === 'ground'; })[0]; if (g) return g; }
    if (!ps.length && STM) ps = inside().filter(function (p) { return inView(p); });
    if (!ps.length) return null;
    var mid = sY() + innerHeight * 0.45;
    ps.sort(function (a, b) { return Math.abs(a.fy - mid) - Math.abs(b.fy - mid); });
    return ps[0];
  }
  // 站在平台上：每一拍跟着平台挪（布局变了、卡片按下去了）；平台没了就掉下去
  function follow() {
    if (!plat || !(mode === 'idle' || mode === 'walk' || mode === 'sleep' || mode === 'play')) return;
    var np = platOf(plat.el, plat.kind);
    if (!np) { plat = null; fall('lost'); return; }
    plat = np;
    var nx = clamp(x, np.x0, np.x1), ny = np.fy - H;
    if (mode === 'walk') tx = clamp(tx, np.x0, np.x1);
    if (Math.abs(nx - x) > 0.5 || Math.abs(ny - y) > 0.5) { x = nx; y = ny; place(); }
  }

  /* ---------- 姿势：基础姿势（由状态决定）+ 正在播放的那一帧 ---------- */
  function base(t) {
    var p = { b: 0, sx: 0, legs: 'stand', lp: 0, dir: dir, armL: 'out', armR: 'wave', face: 'eyes', lx: look.x, ly: look.y, mouth: 0, item: null, fx: null, dy: 0 };
    if (mode === 'walk') {
      var q = Math.floor(t / 90) % 4;
      p.legs = 'walk'; p.lp = q; p.b = q % 2;
      p.armL = q < 2 ? 'swingF' : 'swingB'; p.armR = q < 2 ? 'swingB' : 'swingF';
      if (!looking) { p.lx = dir; p.ly = 0; }
    } else if (mode === 'drag') {
      var held = drag && drag.t0 ? t - drag.t0 : 0;
      if (held > 1400) {                   // 拎太久了：手脚乱蹬、拼命挣扎，脸也拉下来了
        var q2 = Math.floor(t / 90) % 2;
        p.legs = 'dangle'; p.lp = q2; p.armL = q2 ? 'up' : 'wave'; p.armR = q2 ? 'wave' : 'up'; p.face = 'angry'; p.sx = q2;
      } else { p.legs = 'dangle'; p.lp = Math.floor(t / 170) % 2; p.armL = p.armR = 'wave'; p.face = 'wow'; }
    } else if (mode === 'swing') {
      // 荡秋千：往外荡时收腿，往回荡时伸腿（像小孩荡秋千那样蹬），一直笑着
      var outw = !!sw && sw.th * sw.thd > 0;
      p.legs = outw ? 'tuck' : 'stand'; p.armR = 'up'; p.armL = 'wave'; p.face = 'hap'; p.lx = 0; p.ly = 0;
    } else if (mode === 'fly' || mode === 'plug') {
      p.legs = 'tuck'; p.armL = p.armR = 'up'; p.face = 'wow';
    } else if (mode === 'sleep') {
      p.b = Math.floor(t / 1700) % 2 ? 2 : 1; p.face = 'shut'; p.armL = p.armR = 'out';    // 坐着，手平伸（垂直于身子，不往下垂），一呼一吸
    } else if (mode === 'hang' || mode === 'rope' || mode === 'climb') {
      // 吊在线上：右手举着抓线，脚悬空乱晃；往上爬时两只手轮流
      p.legs = mode === 'climb' ? 'tuck' : 'dangle'; p.lp = Math.floor(t / (mode === 'rope' ? 360 : 160)) % 2;
      p.armR = 'up'; p.armL = mode === 'climb' ? (Math.floor(t / 150) % 2 ? 'up' : 'wave') : 'out';
      p.lx = 0; p.ly = mode === 'climb' ? -1 : 1;
    }
    if (music) {
      p.phones = true;
      if (mode === 'idle') {               // 跟着节拍点头、跺脚，头顶冒音符
        var bt = Math.floor(t / 300), kk = Math.floor(t / 200) % 8;
        p.b = bt % 2; p.legs = 'walk'; p.lp = bt % 2 ? 0 : 2; p.armL = p.armR = 'down';
        p.face = bt % 10 < 8 ? 'hap' : 'eyes'; p.lx = 0; p.ly = 0;   // 大部分时间闭眼陶醉，偶尔睁眼
        p.fx = noteFx(16, 3 - kk % 4).concat(noteFx(1, 4 - (kk + 2) % 4));
      }
    }
    if (mood === 'happy') { var w = Math.floor(t / 170) % 2; p.face = 'hap'; p.armL = w ? 'up' : 'wave'; p.armR = w ? 'wave' : 'up'; }
    else if (mood === 'over') { p.face = 'love'; p.armL = p.armR = Math.floor(t / 140) % 2 ? 'up' : 'wave'; }
    else if (mood === 'dizzy') { p.face = 'dz'; p.sx = Math.floor(t / 150) % 2; p.armL = 'wave'; p.armR = 'swingB'; }
    else if (mood === 'sad') { p.face = 'sad'; p.b = Math.max(p.b, 1); p.lx = 0; p.ly = 0; p.armL = p.armR = 'down'; }
    else if (mood === 'wow') { p.face = 'wow'; p.armL = p.armR = 'wave'; }
    else if (mood === 'scared') {          // 害怕 / 恐高：瞪眼、冒汗、浑身发抖；站着时缩成一团
      p.face = 'scared'; p.sx = Math.floor(t / 110) % 2;
      if (mode === 'idle' || mode === 'walk' || mode === 'play') { p.b = 1; p.armL = p.armR = 'down'; }
    }
    else if (mood === 'confused') { p.face = 'confused'; p.armR = 'up'; p.fx = QMARK; }   // 疑惑：一只手挠头，头顶冒问号
    else if (mood === 'angry') {           // 生气：跺脚、两手上下挥、头顶冒烟
      var k2 = Math.floor(t / 120) % 2, k3 = Math.floor(t / 160) % 3;
      p.face = 'angry'; p.sx = k2; p.b = 0; p.legs = 'walk'; p.lp = k2 ? 0 : 2; p.armL = p.armR = k2 ? 'up' : 'out';
      p.fx = [[5, 5 - k3, 'd'], [14, 4 - k3 + (k3 ? 1 : 0), 'd'], [6, 3 - k3, 'd']];
    }
    else if (mood === 'cry') {             // 哭：坐下、手放下、两行眼泪往下掉
      var k4 = Math.floor(t / 130) % 4;
      p.face = 'cry'; p.b = 1; p.armL = p.armR = 'down'; p.fx = [[6, 12 + k4, 'tr'], [13, 12 + (k4 + 2) % 4, 'tr']];
    }
    return p;
  }
  function render() {
    var p = base(performance.now()), k;
    if (seq && seq.cur) for (k in seq.cur) if (k !== 't' && k !== 'fn') p[k] = seq.cur[k];
    if (forced) for (k in forced) p[k] = forced[k];
    if (blinking && p.face === 'eyes') p.face = 'blink';
    var sig = JSON.stringify(p);
    if (sig === lastSig) return;
    lastSig = sig;
    svgEl.innerHTML = draw(p);
    var S = W / G;
    sEl.style.transform = p.dy ? 'translateY(' + Math.round(p.dy * S) + 'px)' : '';
  }
  function ticker(on) {
    clearInterval(tick); tick = 0;
    if (on) tick = setInterval(render, 45);
  }

  /* ---------- 逐帧播放 ---------- */
  function playSeq(frames, done) {
    stopSeq();
    if (reduce || !frames.length) { if (done) done(); return; }
    seq = { frames: frames, i: -1, done: done, cur: null, tm: 0 };
    nextFrame();
  }
  function nextFrame() {
    if (!seq) return;
    seq.i++;
    if (seq.i >= seq.frames.length) { var d = seq.done; seq = null; render(); if (d) d(); return; }
    seq.cur = seq.frames[seq.i];
    if (seq.cur.fn) seq.cur.fn();
    render();
    var s = seq;
    s.tm = setTimeout(function () { if (seq === s) nextFrame(); }, seq.cur.t || 100);
  }
  function stopSeq() { if (seq) { clearTimeout(seq.tm); seq = null; render(); } }

  // 跳：先蹲两格蓄力 → 伸腿起跳 → 空中收腿、举手 → 伸腿下落 → 落地屈膝缓冲、扬灰
  function landFrames(drop) {
    return [
      { b: 2, armL: 'swingB', armR: 'swingB', fx: [[3, 19, 'd'], [16, 19, 'd']], t: 90, fn: function () { press(drop); } },
      { b: 1, armL: 'out', armR: 'out', fx: [[2, 19, 'd'], [1, 18, 'd'], [17, 19, 'd'], [18, 18, 'd']], t: 90 },
      { b: 0, fx: [[0, 18, 'd'], [19, 18, 'd']], t: 70 }
    ];
  }
  function jumpFrames(h) {
    var a = Math.max(1, Math.round(h * 0.4)), c = Math.max(1, Math.round(h * 0.8));
    return [
      { b: 1, t: 70 },
      { b: 2, armL: 'swingB', armR: 'swingB', t: 90 },
      { legs: 'stand', armL: 'up', armR: 'up', dy: -a, t: 60 },
      { legs: 'tuck', armL: 'up', armR: 'up', dy: -c, t: 70 },
      { legs: 'tuck', armL: 'wave', armR: 'wave', dy: -h, t: 110 },
      { legs: 'stand', armL: 'swingF', armR: 'swingF', dy: -c, t: 70 },
      { legs: 'stand', armL: 'out', armR: 'out', dy: -a, t: 60 }
    ].concat(landFrames(h * W / G));
  }
  function jump(h, done) { playSeq(jumpFrames(h), done); }

  /* ---------- 自己玩：从背后摸出东西 ---------- */
  function reach() { return [{ armR: 'back', lx: 1, t: 280 }, { armR: 'back', lx: 1, ly: 1, t: 220 }]; }
  function putAway() { return [{ armR: 'back', lx: 1, t: 240 }, { t: 120 }]; }
  var TOYS = {
    cookie: function (given) {
      // 先低头看一眼饼干，然后从第一口起一直闭着眼享受，吃完才睁眼
      var Hd = { armL: 'hold', armR: 'hold', lx: 0, ly: 1 }, f = given ? [] : reach();
      f.push(mix(Hd, { item: { k: 'cookie', n: 0 }, face: 'eyes', t: 700 }));
      f.push(mix(Hd, { item: { k: 'cookie', n: 0 }, face: 'hap', t: 360 }));
      for (var n = 1; n <= 3; n++) {
        f.push(mix(Hd, { item: { k: 'cookie', n: n - 1 }, mouth: 2, face: 'hap', t: 220 }));
        f.push(mix(Hd, { item: { k: 'cookie', n: n }, mouth: 1, face: 'hap', fx: [[9 + n % 2, 16, 'ck']], t: 140 }));
        f.push(mix(Hd, { item: { k: 'cookie', n: n }, mouth: 1, face: 'hap', b: 1, fx: [[10 - n % 2, 17, 'ck']], t: 140 }));
        f.push(mix(Hd, { item: { k: 'cookie', n: n }, mouth: 1, face: 'hap', fx: [[9 + n % 2, 19, 'ck']], t: 180 }));
      }
      f.push({ face: 'hap', fx: [[9, 19, 'ck'], [11, 19, 'ck']], t: 260 });
      return { frames: f, after: function () { setMood('happy', 900); jump(2); } };
    },
    ball: function (given) {
      var U = { armR: 'up' }, f = given ? [] : reach(), ys = [4, 1, -1, -2, -1, 1, 4, 6], r;
      f.push(mix(U, { item: { k: 'ball', x: 16, y: 6 }, lx: 1, ly: -1, t: 420 }));
      function toss(yy, i) { f.push(mix(U, { armR: i === 0 || i === ys.length - 1 ? 'up' : 'wave', item: { k: 'ball', x: 16, y: yy }, lx: 1, ly: -1, t: 70 })); }
      for (r = 0; r < 2; r++) ys.forEach(toss);
      // 最后一下抛歪了，正好砸到自己头上
      [[16, 2], [14, -1], [12, -2], [10, 0], [9, 3]].forEach(function (c) { f.push(mix(U, { armR: 'wave', item: { k: 'ball', x: c[0], y: c[1] }, lx: 0, ly: -1, t: 70 })); });
      f.push({ armL: 'wave', armR: 'wave', item: { k: 'ball', x: 9, y: 5 }, face: 'dz', b: 1, t: 260 });
      [[11, 2], [13, 1], [15, 3], [17, 7], [18, 12], [19, 16], [21, 18], [24, 18], [27, 18]].forEach(function (c, i) {
        f.push({ item: { k: 'ball', x: c[0], y: c[1] }, face: i < 3 ? 'dz' : 'eyes', lx: 1, ly: c[1] < 8 ? -1 : 1, b: i < 2 ? 1 : 0, t: 70 });
      });
      f.push({ face: 'eyes', lx: 1, ly: 1, t: 600 });
      return { frames: f, after: function () { blink(true); } };
    },
    // 电池：抱着「吸」电，电量一格一格变少，身边冒火花，吸完满血蹦一下，接下来一阵子走路飞快
    batt: function (given) {
      var Hd = { armL: 'hold', armR: 'hold', lx: 0, ly: 1 }, f = given ? [] : reach(), n;
      f.push(mix(Hd, { item: { k: 'batt', n: 3 }, face: 'eyes', t: 600 }));
      for (n = 3; n >= 0; n--) f.push(mix(Hd, { item: { k: 'batt', n: n }, face: 'hap', b: n % 2, fx: [[n % 2 ? 2 : 17, 7 + n, 'gl'], [n % 2 ? 17 : 2, 11 - n, 'gl']], t: 260 }));
      f.push({ face: 'wow', armL: 'up', armR: 'up', t: 300 });
      return { frames: f, after: function () { energy = Date.now() + 12000; sparks(6); setMood('happy', 1200); jump(8); } };
    },
    led: function (given) {
      // 一直盯着灯看（表情不跟着灯一闪一闪地变），看够了才笑一下收起来
      var Hd = { armL: 'hold', armR: 'hold', face: 'eyes', lx: 0, ly: 1 }, f = given ? [] : reach(), i;
      f.push(mix(Hd, { item: { k: 'led', on: false }, t: 600 }));
      for (i = 0; i < 4; i++) {
        f.push(mix(Hd, { item: { k: 'led', on: true }, t: 300 }));
        f.push(mix(Hd, { item: { k: 'led', on: false }, t: 300 }));
      }
      f.push(mix(Hd, { item: { k: 'led', on: true }, t: 400 }));
      f.push(mix(Hd, { item: { k: 'led', on: true }, face: 'hap', t: 900 }));
      return { frames: f.concat(putAway()), after: null };
    }
  };
  function playToy(name, given) {
    if (reduce || paused() || mode === 'drag' || mode === 'away') return;
    if (mode === 'sleep') { clearTimeout(zTm); setMode('idle'); }
    var toy = TOYS[name](given); stopWalk(); setMood('');
    setMode('play');
    playSeq(toy.frames, function () { if (mode === 'play') { mode = 'idle'; render(); } if (toy.after) toy.after(); schedule(); });
  }


  /* ---------- 脾气：被惹多了就发火 ----------
     连戳、晕着还戳、被扔、被拎太久、被吵醒、写代码写不出来都会攒火气，一分钟慢慢消下去；攒够了就砸东西 */
  function annoy(n) {
    var now = Date.now();
    grr = grr * Math.exp(-(now - grrT) / 60000) + n; grrT = now;
    return grr >= 3;
  }
  // 碎片：从格子 (gx, gy) 那里崩开，带重力往下掉
  function shatter(gx, gy, colors, n) {
    if (reduce) return;
    var cx = x + gx * W / G, cy = y + gy * H / G;
    for (var i = 0; i < n; i++) {
      var a = -Math.PI * (0.1 + 0.8 * i / Math.max(1, n - 1)), v = 18 + Math.random() * 26;
      var s = document.createElement('span');
      s.className = 'xin-k';
      s.style.left = Math.round(cx - 3) + 'px'; s.style.top = Math.round(cy - 3) + 'px'; s.style.background = colors[i % colors.length];
      s.style.setProperty('--dx', Math.round(Math.cos(a) * v * 1.6) + 'px'); s.style.setProperty('--dy', Math.round(Math.sin(a) * v) + 'px');
      s.addEventListener('animationend', function () { this.remove(); });
      layer.appendChild(s);
      (function (n2) { setTimeout(function () { if (n2.parentNode) n2.remove(); }, 1500); })(s);
    }
  }
  // 脚下那块（卡片 / 方块）被跺得抖一下
  function shakePlat(k) {
    var e = plat && plat.kind !== 'ground' ? plat.el : null;
    if (!e || !e.animate || reduce) return;
    e.animate([{ transform: 'none' }, { transform: 'translate(' + -k + 'px,' + k + 'px)' }, { transform: 'translate(' + k + 'px,0)' }, { transform: 'translate(' + Math.round(-k / 2) + 'px,1px)' }, { transform: 'none' }],
      { duration: 240, easing: 'steps(4, end)', composite: 'add' });
  }
  var DEB = [[3, 19, 'hp'], [6, 19, 'hk'], [14, 19, 'hp'], [17, 19, 'hk']];
  function steam(k) { return [[3, 5 - k % 3, 'd'], [16, 4 - (k + 1) % 3, 'd']]; }
  function stomps(n, fx) {
    var f = [];
    for (var i = 0; i < n; i++) {
      f.push({ face: 'angry', legs: 'walk', lp: i % 2 ? 2 : 0, b: 0, armL: 'up', armR: 'up', fx: (fx || []).concat(steam(i)), t: 130 });
      f.push({ face: 'angry', b: 1, armL: 'down', armR: 'down', fx: (fx || []).concat([[2, 19, 'd'], [17, 19, 'd']]), t: 150, fn: function () { shakePlat(2); } });
    }
    return f;
  }
  // 发完火：抱着胳膊「哼」，再背过身去不理你
  function huff() {
    return [
      { face: 'pout', armL: 'crossA', armR: 'crossB', fx: steam(0), t: 420 },
      { face: 'pout', armL: 'crossA', armR: 'crossB', fx: steam(1), t: 420 },
      { face: 'pout', armL: 'crossA', armR: 'crossB', fx: steam(2), t: 420 },
      { face: 'back', armL: 'down', armR: 'down', t: 1700 },
      { face: 'pout', armL: 'crossA', armR: 'crossB', t: 700 }
    ];
  }
  // 听歌听烦了：摇摇头，一把扯下耳机举过头顶，狠狠砸到地上，再跺几脚
  function phonesFrames() {
    var A = { face: 'angry', lx: 0, ly: 0 };
    return [
      mix(A, { armL: 'down', armR: 'down', t: 800 }),
      mix(A, { sx: 1, t: 110 }), mix(A, { sx: -1, t: 110 }), mix(A, { sx: 1, t: 110 }), mix(A, { t: 160 }),
      mix(A, { armL: 'up', armR: 'up', item: { k: 'phones', y: 4 }, dy: -1, t: 520, fn: function () { music = false; } }),
      mix(A, { armL: 'up', armR: 'up', item: { k: 'phones', y: 3 }, dy: -2, t: 160 }),
      mix(A, { armL: 'down', armR: 'down', b: 1, item: { k: 'phones', y: 16 }, t: 70, fn: function () { shatter(10, 18, ['var(--clay)', '#5a2c1f', '#9a948a'], 10); shakePlat(3); phonesBroke = Date.now(); } }),
      mix(A, { armL: 'down', armR: 'down', b: 1, fx: DEB, t: 420 })
    ].concat(stomps(3, DEB));
  }
  // 没东西可砸：从背后摸出 LED 举起来摔，或者直接跺脚把脚下的卡片跺得直抖
  function smashLed() {
    var A = { face: 'angry', lx: 0, ly: 0 }, d = [[12, 19, 'led'], [15, 19, 'lb'], [17, 18, 'd']];
    return reach().concat([
      mix(A, { armR: 'up', item: { k: 'led', x: 15, y: 4 }, t: 600 }),
      mix(A, { armR: 'up', item: { k: 'led', x: 15, y: 3 }, dy: -1, t: 200 }),
      mix(A, { armR: 'down', b: 1, item: { k: 'led', x: 14, y: 16 }, t: 70, fn: function () { shatter(16, 18, ['#b84a35', '#ff8d6e', '#9a948a'], 9); shakePlat(3); } }),
      mix(A, { armR: 'down', b: 1, fx: d, t: 420 })
    ]).concat(stomps(3, d));
  }
  function rage(what) {
    if (reduce || paused()) return;
    if (!(mode === 'idle' || mode === 'play' || mode === 'walk')) { ragePending = true; return; }
    ragePending = false; grr = 0;
    stopWalk(); stopSeq(); setMood(''); setMode('play');
    var f = what === 'phones' || music ? phonesFrames() : what === 'stomp' || Math.random() < 0.4 ? stomps(5) : smashLed();
    playSeq(f.concat(huff()), done);
  }
  function done() { if (mode === 'play') { mode = 'idle'; render(); } schedule(); }

  /* ---------- 叛逆 ----------
     让它睡、叫它过来，有时候偏不：摇头、吐舌头、背过身去；刚吃饱再喂也不吃；被拎到别处，有时候偏要走回去 */
  function refuse(after) {
    if (reduce) { if (after) after(); return; }
    if (mode === 'sleep') { clearTimeout(zTm); clearTimeout(sleepTm); }
    stopWalk(); stopSeq(); setMood(''); setMode('play');
    var f = [], i;
    for (i = 0; i < 4; i++) f.push({ face: 'pout', sx: i % 2 ? 1 : -1, armL: 'down', armR: 'down', t: 140 });   // 摇头：不要不要
    f.push({ face: 'tongue', armL: 'wave', t: 900 });                                                         // 略略略
    f.push({ face: 'back', armL: 'down', armR: 'down', t: 1400 });                                            // 背过身去
    playSeq(f, function () { if (mode === 'play') { mode = 'idle'; render(); } if (after) after(); else schedule(); });
  }
  function rebel() { return !reduce && Math.random() < REBEL; }
  // 冲你吐舌头（鼠标在它旁边晃太久了）
  function tease(cx) {
    var r = el.getBoundingClientRect();
    setMode('play');
    playSeq([{ face: 'tongue', lx: cx < r.left + r.width / 2 ? -1 : 1, armL: 'wave', t: 1000 }, { t: 200 }], done);
  }
  // 调皮：踢一脚脚下的卡片，然后冲你吐舌头
  function mischief() {
    setMode('play');
    playSeq([
      { lx: dir, legs: 'walk', lp: 0, t: 260 },
      { lx: dir, b: 1, legs: 'walk', lp: 2, armL: 'swingB', armR: 'swingF', t: 160, fn: function () { shakePlat(4); } },
      { lx: dir, t: 300 },
      { face: 'tongue', armL: 'wave', t: 900 }
    ], done);
  }

  /* ---------- 跳舞：扭胯 → 转一圈 → 迪斯科指天 → 机械舞 → 跳起来定格，一直冒音符 ---------- */
  function danceFrames() {
    var f = [], i, H2 = { face: 'hap', lx: 0, ly: 0 };
    for (i = 0; i < 6; i++) f.push(mix(H2, { sx: i % 2 ? 1 : -1, b: i % 2, legs: 'walk', lp: i % 2 ? 0 : 2, armL: i % 2 ? 'down' : 'up', armR: i % 2 ? 'up' : 'down', t: 260 }));
    f.push({ face: 'eyes', lx: 1, ly: 0, t: 110 }, { face: 'back', t: 160 }, { face: 'eyes', lx: -1, ly: 0, t: 110 },
      mix(H2, { armL: 'up', armR: 'up', legs: 'tuck', dy: -2, t: 220 }), mix(H2, { armL: 'up', armR: 'up', b: 1, t: 200 }));
    for (i = 0; i < 4; i++) f.push(mix(H2, { armL: 'down', armR: i % 2 ? 'up' : 'wave', b: i % 2, t: 240 }));
    for (i = 0; i < 4; i++) f.push(mix(H2, { armR: 'down', armL: i % 2 ? 'up' : 'wave', b: i % 2, t: 240 }));
    ['out', 'up', 'down', 'up', 'out'].forEach(function (a, j) {
      f.push({ face: 'eyes', lx: 0, ly: 0, armL: a, armR: a === 'up' ? 'down' : a === 'down' ? 'up' : 'out', sx: j % 2, t: 230 });
    });
    f.push(mix(H2, { b: 2, armL: 'swingB', armR: 'swingB', t: 120 }), mix(H2, { dy: -4, legs: 'tuck', armL: 'up', armR: 'up', t: 170 }), mix(H2, { dy: -2, armL: 'up', armR: 'up', t: 100 }));
    f = f.concat(landFrames(0));
    f.push(mix(H2, { armL: 'up', armR: 'wave', t: 700 }));
    f.forEach(function (fr, k) { if (!fr.fx) fr.fx = noteFx(16, 3 - k % 4).concat(noteFx(1, 4 - (k + 2) % 4)); });
    return f;
  }
  function dance() {
    if (reduce || paused()) return;
    if (mode === 'sleep') { clearTimeout(zTm); clearTimeout(sleepTm); }
    stopWalk(); setMood(''); setMode('play');
    playSeq(danceFrames(), function () { if (mode === 'play') { mode = 'idle'; render(); } sparks(4); schedule(); });
  }

  /* ---------- 坐在边上晃腿（像 Shimeji 那样）---------- */
  function sitDown() {
    if (reduce || !plat || plat.kind === 'in') return false;
    setMode('play');
    var f = [{ b: 1, t: 120 }, { b: 2, armL: 'down', armR: 'down', t: 140 }], n = 12 + Math.floor(Math.random() * 8), i;
    for (i = 0; i < n; i++) {
      var lx = i > n * 0.4 && i < n * 0.6 ? 1 : i >= n * 0.6 && i < n * 0.8 ? -1 : 0;   // 慢慢左右看看
      f.push({ dy: 3, legs: 'dangle', lp: i % 2, armL: 'down', armR: 'down', face: 'calm', lx: lx, ly: 0, t: 420 });
    }
    f.push({ b: 1, t: 140 });
    playSeq(f, done);
    return true;
  }

  /* ---------- 走着走着绊一跤：往前扑倒、晕一下、爬起来一脸懵（偶尔哭） ---------- */
  function trip() {
    var d = dir;
    setMode('play');
    rEl.style.transformOrigin = '50% 96%';
    playSeq([
      { legs: 'walk', lp: 0, face: 'wow', armL: 'up', armR: 'up', t: 90, fn: function () { angT = d * 36; kick(); } },
      { legs: 'tuck', face: 'wow', armL: 'up', armR: 'up', t: 140, fn: function () { angT = d * 84; kick(); } },
      { face: 'dz', armL: 'out', armR: 'out', t: 900, fn: function () { shakePlat(1); } },
      { face: 'dz', t: 480, fn: function () { angT = 0; kick(); } }
    ], function () {
      rEl.style.transformOrigin = '50% 60%'; ang = angT = 0; av = 0; place();
      if (mode === 'play') { mode = 'idle'; render(); }
      if (Math.random() < 0.25) { annoy(0.5); setMood('cry', 1800); } else setMood('confused', 1500);
      schedule();
    });
  }

  /* ---------- 荡秋千：朝头顶射一根线，蹦上去抓住，越荡越高，最后松手飞出去落到平台上 ---------- */
  var swingNext = false;
  function room(p) { return p.fy - H + H * (7 + OY) / G - 18 - (sY() + topPad() + 2); }   // 站在 p 上时头顶能放多长的线
  function swing() {
    if (reduce || !plat || paused()) return false;
    var top = sY() + topPad() + 2, L = Math.min(700, handY() - 18 - top);
    if (L < 110) {               // 头顶太矮：先跳到上面空得多的地方再荡
      var c = plats().filter(function (q) { return !same(q, plat) && inView(q) && room(q) >= 130; });
      if (!c.length) return false;
      swingNext = true; hop(c[Math.floor(Math.random() * c.length)]);
      return true;
    }
    var from = plat;
    stopWalk(); stopSeq(); setMood(''); setMode('play');
    playSeq([{ b: 1, armR: 'up', t: 90 }, { b: 2, armL: 'swingB', armR: 'up', t: 110 }], function () {
      if (mode !== 'play') return;
      plat = null; setMode('swing');
      var ax = handX(), hy = top + L;
      thread = { top: handY(), ax: ax };
      animThread(handY(), top, 160);
      fly(x, hy - H * (7 + OY) / G, 1, hy - H * (7 + OY) / G - 10, 240, easeOut, function () {
        if (mode !== 'swing') return;
        rEl.style.transformOrigin = (W * 17 / G).toFixed(1) + 'px ' + (H * (7 + OY) / G).toFixed(1) + 'px';
        sw = { t0: performance.now(), ax: ax, top: top, L: L, w: Math.sqrt(2400 / L), dur: 6500 + Math.random() * 2500, from: from, th: 0, thd: 0 };
        requestAnimationFrame(swingStep);
      });
    });
    return true;
  }
  function swingStep(now) {
    if (!sw || mode !== 'swing') { sw = null; return; }
    var s = sw, t = (now - s.t0) / 1000, k = Math.min(1, t / 3.2), A = 0.1 + 0.52 * k * k * (3 - 2 * k);
    s.th = A * Math.sin(s.w * t); s.thd = A * s.w * Math.cos(s.w * t);
    x = s.ax + s.L * Math.sin(s.th) - W * 17 / G; y = s.top + s.L * Math.cos(s.th) - H * (7 + OY) / G;
    ang = angT = -s.th * 180 / Math.PI; av = 0;
    place(); render();
    if ((now - s.t0 > s.dur && Math.abs(s.th) < 0.09) || now - s.t0 > s.dur + 4000) { letGo(); return; }
    requestAnimationFrame(swingStep);
  }
  function letGo() {
    var s = sw; sw = null;
    var vx = s.L * s.thd;
    thread = null; drawThread();
    ang = angT = 0; av = 0; rEl.style.transformOrigin = '50% 60%';
    var tx2 = x + vx * 0.35, p = below(tx2, y) || below(x, y);
    if (!p) { var q = platOf(s.from.el, s.from.kind); p = q || bestPlat(); }
    if (!p) { goAway(); return; }
    setMode('fly');
    var x2 = clamp(tx2, p.x0, p.x1), y2 = p.fy - H;
    fly(x2, y2, 1, Math.min(y, y2) - 50, clamp(460 + Math.abs(x2 - x) * 0.6, 460, 900), easeInOut, function () { land(p); setMood('happy', 900); });
  }

  /* ---------- 敲代码：看代码区的时候掏出笔记本敲；敲着敲着停下来想。
     想出来了就开心；想不出来会烦躁地狂敲、伤心地叹气、生气冒烟，甚至把电脑举起来砸了 ---------- */
  var CODE_SEL = 'figure.code, .dv-fn, .dv-term';
  var GLYPHS = ['{', '}', ';', '=', '0x', '()', '//', '|=', '<<', '&', '++', 'if'];
  function glyph() {
    if (reduce) return;
    var s = document.createElement('span');
    s.className = 'xin-cd'; s.textContent = GLYPHS[Math.floor(Math.random() * GLYPHS.length)];
    s.style.left = Math.round(x + W * (0.95 + Math.random() * 0.2)) + 'px'; s.style.top = Math.round(y + H * 0.5) + 'px';   // 从屏幕那儿冒出来
    s.addEventListener('animationend', function () { s.remove(); });
    layer.appendChild(s);
    setTimeout(function () { if (s.parentNode) s.remove(); }, 2000);
  }
  // 电脑放在右前方地上。敲的时候侧身朝着屏幕（pcS）；停下来想、有情绪的时候转过来正对着你（pc）
  function pc(o) { return mix({ item: { k: 'pcs' }, b: 1, lx: 1, ly: 1, face: 'eyes', armL: 'out', armR: 'out' }, o || {}); }
  var SIDE = { pout: 'sidePout', sad: 'sideSad' };
  function pcS(o) { return mix({ item: { k: 'pcs' }, b: 1, lx: 0, ly: 1, face: 'side', armL: 'none', armR: 'typeDn' }, o || {}); }
  function typing(n, fast, face) {
    var f = [];
    for (var i = 0; i < n; i++) f.push(pcS({ armR: i % 2 ? 'typeUp' : 'typeDn', face: SIDE[face] || 'side', sx: fast ? i % 2 : 0, t: fast ? 90 : 160, fn: i % (fast ? 2 : 3) === 0 ? glyph : null }));
    return f;
  }
  function thinking(ms) {     // 停下来想：转过来，一只手挠头，眼睛往上看，头顶冒「…」
    var f = [], n = Math.max(1, Math.round(ms / 320));
    for (var i = 0; i < n; i++) f.push(pc({ armR: 'up', face: 'focus', lx: 1, ly: -1, fx: [[14, 3, 'q'], [16, 3, 'q'], [18, 3, 'q']].slice(0, i % 4), t: 320 }));
    return f;
  }
  function code(given, how) {
    if (reduce || paused() || mode === 'drag' || mode === 'away') return;
    if (mode === 'sleep') { clearTimeout(zTm); clearTimeout(sleepTm); }
    stopWalk(); stopSeq(); setMood(''); setMode('play');
    var f = (given ? [] : reach()).concat([pc({ t: 500 }), pcS({ armR: 'typeUp', t: 220 })], typing(14), thinking(1600), [pcS({ armR: 'typeUp', t: 200 })], typing(10));
    var r = Math.random();
    how = how || (r < 0.42 ? 'ok' : r < 0.64 ? 'sad' : r < 0.86 ? 'mad' : 'smash');
    var tail = putAway();
    if (how === 'ok') {          // 想通了：眼睛一亮，举手欢呼
      f = f.concat(thinking(900), [pc({ face: 'wow', ly: 0, t: 520 }), pc({ face: 'hap', ly: 0, armL: 'up', armR: 'up', t: 800, fn: function () { sparks(4); } })], typing(8));
    } else if (how === 'sad') {  // 想不出来：低下头叹气，蔫蔫地接着敲
      f = f.concat(thinking(2200), [pc({ face: 'sad', ly: 0, armL: 'down', armR: 'down', t: 1800 })], typing(6, false, 'sad'));
    } else if (how === 'mad') {  // 烦躁：皱着眉狂敲键盘，越敲越气，冒烟
      f = f.concat(thinking(1600), typing(18, true, 'pout'), [pc({ face: 'angry', ly: 0, armL: 'up', armR: 'up', fx: steam(0), t: 450 }), pc({ face: 'angry', ly: 0, armL: 'up', armR: 'up', fx: steam(1), t: 450 })], typing(6, true, 'pout'));
    } else {                     // 气炸了：把电脑举过头顶砸了
      f = f.concat(thinking(1600), typing(18, true, 'pout'), [
        pc({ face: 'angry', ly: 0, armL: 'down', armR: 'down', t: 700 }),
        { face: 'angry', armL: 'up', armR: 'up', item: { k: 'pc', y: 2 }, dy: -1, t: 560 },
        { face: 'angry', armL: 'up', armR: 'up', item: { k: 'pc', y: 1 }, dy: -2, t: 160 },
        { face: 'angry', armL: 'down', armR: 'down', b: 1, item: { k: 'pc', y: 13 }, t: 70, fn: function () { shatter(10, 17, ['#8d887c', '#3b3833', '#8ec5ff', 'var(--clay)'], 12); shakePlat(4); } },
        { face: 'angry', armL: 'down', armR: 'down', b: 1, fx: [[3, 19, 'lt'], [7, 19, 'lk'], [13, 19, 'lt'], [16, 19, 'sw']], t: 420 }
      ], stomps(3, [[3, 19, 'lt'], [7, 19, 'lk'], [13, 19, 'lt'], [16, 19, 'sw']]));
      tail = huff();
    }
    playSeq(f.concat(tail), function () {
      if (mode === 'play') { mode = 'idle'; render(); }
      if (how === 'sad') setMood('sad', 1400);
      else if (how === 'mad') annoy(1);
      schedule();
    });
  }
  // 代码区在屏幕上吗（学习台）
  function codeInView() {
    if (!STM) return null;
    var cs = document.querySelectorAll(CODE_SEL), top = topPad();
    for (var i = 0; i < cs.length; i++) {
      var r = cs[i].getBoundingClientRect();
      if (r.width > 0 && r.bottom > top + innerHeight * 0.15 && r.top < innerHeight * 0.85) return cs[i];
    }
    return null;
  }

  /* ---------- 眼睛 ---------- */
  // 视线按像素格挪：-1 / 0 / 1
  function pupils(px, py) { look = { x: clamp(Math.round(px / 1.6), -1, 1), y: clamp(Math.round(py / 1.6), -1, 1) }; render(); }
  function lookAt(cx, cy, hold) {
    if (!(mode === 'idle' || mode === 'walk')) return;
    var r = el.getBoundingClientRect();
    var dx = cx - (r.left + r.width / 2), dy = cy - (r.top + r.height * 0.45);
    var d = Math.sqrt(dx * dx + dy * dy) || 1, k = Math.min(1, d / 90);
    looking = true; clearTimeout(lookTm);
    pupils(dx / d * 2.2 * k, dy / d * 1.9 * k);
    lookTm = setTimeout(function () { looking = false; if (mode !== 'walk') pupils(0, 0); }, hold || 2200);
  }
  function lookEl(node, hold) {
    if (!node) return;
    var r = node.getBoundingClientRect();
    lookAt(r.left + r.width / 2, r.top + r.height / 2, hold);
  }
  function blink(twice) {
    blinking = true; render();
    setTimeout(function () {
      blinking = false; render();
      if (twice) setTimeout(function () { blink(false); }, 150);
    }, 120);
  }
  function blinkLoop() {
    clearTimeout(blinkTm);
    blinkTm = setTimeout(function () {
      if (!paused() && mode !== 'sleep' && !mood) blink(Math.random() < 0.22);
      blinkLoop();
    }, 2400 + Math.random() * 3600);
  }


  /* ---------- 小粒子：睡觉的 z、开心时蹦出的像素块（都挂在小芯那一层，用文档坐标） ---------- */
  function particle(c, ch, left, top, dx, dy) {
    var s = document.createElement('span');
    s.className = c; s.textContent = ch;
    s.style.left = left.toFixed(1) + 'px'; s.style.top = top.toFixed(1) + 'px';
    if (dx != null) { s.style.setProperty('--dx', dx.toFixed(1) + 'px'); s.style.setProperty('--dy', dy.toFixed(1) + 'px'); }
    s.addEventListener('animationend', function () { s.remove(); });
    layer.appendChild(s);
    setTimeout(function () { if (s.parentNode) s.remove(); }, 3000);
  }
  function headY() { return y + H * (6 + OY) / G; }
  function sparks(n) {
    if (reduce) return;
    for (var i = 0; i < n; i++) {
      var a = -Math.PI / 2 + (i - (n - 1) / 2) * 0.75 + (Math.random() - 0.5) * 0.3;
      particle('xin-p', '', x + W / 2 - 3, headY() - 6, Math.round(Math.cos(a) * 26 / 3) * 3, Math.round((Math.sin(a) * 24 - 6) / 3) * 3);
    }
  }
  function zz() {
    clearTimeout(zTm);
    if (mode !== 'sleep' || paused()) return;
    if (!reduce) particle('xin-z', Math.random() < 0.5 ? 'z' : 'Z', x + W * 0.72, headY() - 8);
    zTm = setTimeout(zz, 1800);
  }

  /* ---------- 动作 ---------- */
  function land(p) {
    if (p) plat = p;
    setMode('idle');
    var drop = 0;
    if (plat) { x = clamp(x, plat.x0, plat.x1); y = plat.fy - H; drop = y - airFrom; }
    sc = 1; angT = 0; place(); kick();
    playSeq(landFrames(drop));
    schedule();
    if (pendingAct) { var pa = pendingAct; pendingAct = null; setTimeout(function () { if (mode === 'idle') pa(); }, 300); }
    if (swingNext) { swingNext = false; setTimeout(function () { if (mode === 'idle' && !mood) swing(); }, 450); }
    // 叛逆：被你拎到这儿来的，偏要回原来那儿去（先「哼」一下）
    if (backTo) {
      var bt = backTo; backTo = null;
      var q = platOf(bt.plat.el, bt.plat.kind);
      if (q && !same(q, plat) && inView(q)) setTimeout(function () {
        if (mode !== 'idle' || seq || mood === 'cry') return;
        setMode('play');
        playSeq([{ face: 'pout', armL: 'crossA', armR: 'crossB', t: 800 }, { face: 'back', t: 700 }], function () { if (mode === 'play') hop(q, bt.x); });
      }, 600);
    }
  }
  /* 重力挤压：落到卡片 / 方块上时，被踩的那块往下沉一下再弹回来；落得越高压得越深。小芯跟着一起沉 */
  var pressing = 0;
  function press(drop) {
    var e = plat && plat.kind !== 'ground' ? plat.el : null;
    if (!e || !e.animate || reduce || !(drop > 6)) return;
    var d = Math.round(clamp(drop / 45, 2, 7));
    e.animate([{ transform: 'none' }, { transform: 'translateY(' + d + 'px)', offset: 0.25 }, { transform: 'translateY(' + Math.round(d / 2) + 'px)', offset: 0.5 },
      { transform: 'translateY(-1px)', offset: 0.75 }, { transform: 'none' }], { duration: 300, easing: 'steps(4, end)', composite: 'add' });
    pressing = performance.now() + 340;
    var step = function () { follow(); if (performance.now() < pressing) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  }
  function walkTo(target) {
    if (!plat) return;
    tx = clamp(target, plat.x0, plat.x1);
    if (Math.abs(tx - x) < 2) return;
    dir = tx > x ? 1 : -1;
    tripAt = !reduce && Math.abs(tx - x) > 70 && Math.random() < 0.1 ? x + (tx - x) * (0.4 + Math.random() * 0.3) : null;
    setMode('walk');
    kick();
  }
  function stopWalk() {
    if (mode !== 'walk') return;
    setMode('idle');
  }
  // 恐高：走到平台边上，往下一看离下一个落脚点很远，就吓得缩成一团
  function edgeFear() {
    if (!plat || plat.kind === 'in' || mood) return;
    var atL = x - plat.x0 < 3, atR = plat.x1 - x < 3;
    if (!atL && !atR) return;
    var nx = atL ? x - W * 0.5 : x + W * 0.5, q = below(nx, y + 4), gap = q && !same(q, plat) ? q.fy - plat.fy : 9999;
    if (gap > 110) { look = { x: atL ? -1 : 1, y: 1 }; setMood('scared', 1400); setTimeout(function () { if (mode === 'idle') look = { x: 0, y: 0 }; }, 1500); }
  }
  // 睡觉：让它睡的睡 25~40 秒，自己困了睡的睡 45~75 秒，然后自己伸个懒腰醒来。点它、拖它、从背包叫醒会提前醒
  var sleepTm = 0;
  function sleep(told) {
    if (mode !== 'idle') return;
    setMood(''); look = { x: 0, y: 0 }; setMode('sleep'); zz();
    clearTimeout(sleepTm);
    sleepTm = setTimeout(function () { if (mode === 'sleep') { wake(false); lastInput = Date.now(); } }, told ? 25000 + Math.random() * 15000 : 45000 + Math.random() * 30000);
  }
  function wake(startled) {
    if (mode !== 'sleep') return;
    clearTimeout(zTm); clearTimeout(sleepTm); setMode('idle'); lastInput = Date.now();
    if (startled) { annoy(1); setMood('wow', 700); jump(3); }
    else playSeq([{ armL: 'up', armR: 'up', face: 'shut', b: 0, t: 450 }, { armL: 'wave', armR: 'wave', face: 'shut', t: 200 }, { face: 'blink', t: 120 }]);   // 伸个懒腰
    schedule();
  }
  function tap() {
    var t = Date.now();
    taps = taps.filter(function (v) { return t - v < 1600; }); taps.push(t);
    lastInput = t;
    if (mode === 'sleep') { wake(true); return; }
    if (mode === 'play') setMode('idle');
    if (mode !== 'idle' && mode !== 'walk') return;
    stopWalk();
    if (mood === 'dizzy' || mood === 'angry') {   // 晕着还戳它：生气了；再戳就发火砸东西
      taps = []; stopSeq();
      if (annoy(1.5)) { setMood(''); rage(); return; }
      setMood('angry', 1900); return;
    }
    if (taps.length >= 5) {
      taps = [];
      stopSeq();
      rEl.style.transformOrigin = '50% 60%';
      if (!reduce && rEl.animate) rEl.animate([0, 90, 180, 270, 360, 450, 540, 630, 720].map(function (a) { return { transform: 'rotate(' + a + 'deg)' }; }), { duration: 720, easing: 'steps(8, end)' });
      setMood('dizzy', 1900);
      return;
    }
    setMood('happy', 1100); sparks(3); jump(6);
    schedule();
  }
  // 跳到另一个平台：先蹲两格蓄力，再划一道弧线过去，落地屈膝
  function hop(p2, xt) {
    if (!p2) return;
    var x2 = clamp(xt == null ? (p2.x0 + p2.x1) / 2 : xt, p2.x0, p2.x1), y2 = p2.fy - H;
    if (reduce) { x = x2; y = y2; place(); land(p2); return; }
    stopWalk(); dir = x2 > x ? 1 : -1;
    setMode('play');
    playSeq([{ b: 1, lx: dir, t: 80 }, { b: 2, lx: dir, armL: 'swingB', armR: 'swingB', t: 110 }], function () {
      plat = null; setMode('fly');
      var dx = Math.abs(x2 - x), up = Math.max(36, Math.min(160, 40 + dx * 0.25 + Math.max(0, y - y2) * 0.4));
      fly(x2, y2, 1, Math.min(y, y2) - up, clamp(380 + Math.sqrt(dx * dx + (y2 - y) * (y2 - y)) * 0.7, 420, 900), easeInOut, function () { land(p2); });
    });
  }
  // 脚下没东西了：往下掉到下面最近的平台上；下面也没有，就跳到看得见的地方
  function below(px, py) {
    var feet = py + H, best = null;
    plats().forEach(function (p) {
      if (px + W * 0.5 < p.x0 || px > p.x1 + W * 0.5) return;
      if (p.fy < feet - 12) return;
      if (!best || p.fy < best.fy) best = p;
    });
    return best;
  }
  // 往下掉：落到下面最近的平台上。掉得高会害怕，摔得太狠会哭；平台突然没了，落地后一脸疑惑。
  // 被扔下去、下面又没有能站的地方：射一根线挂住（hang）
  function fall(why) {
    var p = below(x, y);
    if (!p && (why === 'drop' || why === 'lost')) { hang(); return; }
    p = p || bestPlat();
    if (!p) { goAway(); return; }
    if (reduce) { x = clamp(x, p.x0, p.x1); y = p.fy - H; place(); land(p); return; }
    setMode('fly'); angT = 0;
    var x2 = clamp(x, p.x0, p.x1), y2 = p.fy - H, d = Math.abs(y2 - y) + Math.abs(x2 - x), drop = y2 - y;
    if (drop > 150) setMood('scared');
    fly(x2, y2, 1, Math.min(y, y2) - (y2 > y ? 16 : 50), clamp(300 + d * 0.6, 320, 900), y2 > y ? easeIn : easeInOut, function () {
      land(p);
      if (drop > 260 && why === 'drop') { annoy(1); setMood('cry', 2200); }
      else if (why === 'lost') setMood('confused', 1600);
      else if (mood === 'scared') setMood('');
    });
  }
  // 像蜘蛛侠一样：右手朝屏幕顶上射一根线，吊住、往下坠一下再弹回来，吓得发抖，然后顺着线爬上去，跳到看得见的平台上
  function hang() {
    if (reduce) { var q = bestPlat(); if (q) { x = clamp(x, q.x0, q.x1); y = q.fy - H; place(); land(q); } else goAway(); return; }
    stopSeq(); tw = null; plat = null; angT = 0;
    setMode('hang'); setMood('scared');
    var top = sY() + topPad() + 2, hy = handY();
    if (hy - top < 40) { climbDone(); return; }
    thread = { top: hy };
    animThread(hy, top, 160, function () {
      var y0 = y;
      fly(x, y0 + 28, 1, y0 + 14, 180, easeOut, function () {
        fly(x, y0 - 6, 1, y0 + 10, 240, easeInOut, function () {
          setTimeout(function () { if (mode === 'hang') climb(); }, 900);
        });
      });
    });
  }
  function climb() {
    setMood(''); setMode('climb');
    var target = thread.top - H * (7 + OY) / G + 6;
    fly(x, target, 1, (y + target) / 2, clamp((y - target) / 0.16, 400, 2600), function (k) { return k; }, climbDone);
  }
  function climbDone() {
    var p = bestPlat();
    thread = null; drawThread();
    if (!p) { goAway(); return; }
    setMode('fly');
    var x2 = clamp(x, p.x0, p.x1), y2 = p.fy - H;
    fly(x2, y2, 1, Math.min(y, y2) - 40, clamp(420 + Math.abs(y2 - y) * 0.5, 420, 900), easeInOut, function () { land(p); setMood('happy', 900); });
  }
  function goAway() {
    stopSeq(); tw = null; plat = null; thread = null; drawThread();
    if (sw) { sw = null; ang = angT = 0; av = 0; rEl.style.transformOrigin = '50% 60%'; }
    setMode('away');
  }
  // 出场：顺着一根线从屏幕顶上慢慢放下来，落到 p（默认挑一个看得见的），落地后线收回去
  function dropIn(delay, p) {
    p = p || bestPlat();
    if (!p) { setMode('away'); setTimeout(function () { if (mode === 'away' && !paused()) dropIn(0); }, 700); return; }
    setMood(''); stopSeq(); tw = null;
    var x2 = HOME && p.kind === 'ground' ? p.x0 + (p.x1 - p.x0) * 0.4 : p.x0 + (p.x1 - p.x0) * (0.2 + Math.random() * 0.6);
    x = x2; sc = 1; ang = 0; av = 0; angT = 0; rEl.style.transformOrigin = '50% 60%';
    if (reduce) { thread = null; y = p.fy - H; setMode('idle'); place(); land(p); return; }
    var top = sY() + topPad(), y2 = p.fy - H;
    y = Math.min(y2 - 20, top - H * 0.9);
    thread = { top: top }; setMode('rope'); place();
    setTimeout(function () {
      if (mode !== 'rope') return;
      fly(x2, y2, 1, (y + y2) / 2, clamp((y2 - y) / 0.28, 500, 1600), easeInOut, function () { land(p); retract(); setMood('happy', 900); });
    }, delay || 0);
  }

  /* 闲着的时候自己找点事做 */
  var toyOrder = ['cookie', 'ball', 'led'], toyI = Math.floor(Math.random() * 3);
  function schedule(ms) { clearTimeout(idleTm); idleTm = setTimeout(think, ms || 2200 + Math.random() * 3800); }
  function think() {
    if (paused()) return;
    if (mode === 'away') { dropIn(0); return; }
    if (ragePending && mode === 'idle' && !seq) { rage(); return; }
    if (mode !== 'idle' || mood || seq) { schedule(); return; }
    if (!onScreen() || !plat) { dropIn(0); return; }      // 页面滚走了：跳回看得见的地方
    if (askEl) { lastInput = Date.now(); schedule(); return; }               // 你在跟它说话：待在原地听着
    if (aiState && !reduce) { lastInput = Date.now(); aiStep(); return; }   // 云电脑里的 AI 在想 / 在干活：坐在电脑前陪着
    if (music) {                 // 听歌：待着听，时不时跳段舞；听久了会烦，把耳机砸了
      lastInput = Date.now();
      if (!reduce && Date.now() > boreAt) { rage('phones'); return; }
      if (!reduce && Math.random() < 0.35) { dance(); return; }
      schedule(); return;
    }
    // 学习台里你在看代码区：它也掏出电脑敲代码（先跳到代码框上面去）
    var box = !reduce && codeInView();
    if (box && Math.random() < 0.6) {
      var cp = plats().filter(function (q) { return q.kind === 'top' && inView(q) && (q.el === box || box.contains(q.el)); })[0];
      if (cp && !same(cp, plat) && Math.random() < 0.7) { hop(cp, cp.x0 + Math.random() * (cp.x1 - cp.x0)); return; }
      code(); return;
    }
    if (Date.now() - lastInput > SLEEP_AFTER) { sleep(); return; }
    var r = Math.random(), span = plat.x1 - plat.x0;
    if (!reduce && r < 0.26 && span > 30) {
      var t = Math.random() < 0.3 ? (Math.random() < 0.5 ? plat.x0 : plat.x1) : plat.x0 + Math.random() * span;   // 有时候走到边上往下看
      if (Math.abs(t - x) < 24) t = x - plat.x0 < span / 2 ? Math.min(plat.x1, x + 24 + Math.random() * (plat.x1 - x - 24)) : plat.x0 + Math.random() * Math.max(0, x - plat.x0 - 24);
      walkTo(t);
    } else if (!reduce && r < 0.48) {
      var cand = plats().filter(function (p) {
        if (same(p, plat) || !inView(p)) return false;
        var cx = clamp(x, p.x0, p.x1);
        return Math.abs(cx - x) + Math.abs(p.fy - plat.fy) < (STM ? 520 : 600);
      });
      if (cand.length) { var p2 = cand[Math.floor(Math.random() * cand.length)]; hop(p2, p2.x0 + Math.random() * (p2.x1 - p2.x0)); return; }
      walkTo(plat.x0 + Math.random() * span);
    } else if (!reduce && r < 0.6) {
      playToy(toyOrder[toyI++ % toyOrder.length]); return;
    } else if (!reduce && r < 0.66) {
      if (sitDown()) return;
    } else if (!reduce && r < 0.7) {
      if (swing()) return;
    } else if (!reduce && r < 0.73) {
      syncLearned();
      if (learned.length && Math.random() < 0.5 && doMove(learned[Math.floor(Math.random() * learned.length)])) return;
      dance(); return;
    } else if (!reduce && r < 0.75 && REBEL > 0 && plat.kind !== 'ground') {
      mischief(); return;
    } else if (r < 0.8) {
      setMood('confused', 1700);           // 想起什么又想不起来
    } else if (r < 0.9) {
      if (!looking) { pupils((Math.random() < 0.5 ? -1 : 1) * 2, (Math.random() - 0.3) * 1.6); setTimeout(function () { if (!looking && mode === 'idle') pupils(0, 0); }, 1300); }
    } else if (!reduce && r < 0.94) jump(2);
    else blink(true);
    schedule();
  }

  /* ---------- 移动循环（只在走路/拖动/飞行/摆动时运行） ---------- */
  function kick() { if (!raf) { lastT = 0; raf = requestAnimationFrame(loop); } }
  function bez(a, c, b, t) { var u = 1 - t; return u * u * a + 2 * u * t * c + t * t * b; }
  function loop(t) {
    raf = 0;
    var dt = lastT ? Math.min(0.05, (t - lastT) / 1000) : 0.016, busy = false;
    lastT = t;
    if (mode === 'walk') {
      var d = tx - x, st = (Date.now() < energy ? 80 : 30) * dt;
      if (Math.abs(d) <= st) { x = tx; stopWalk(); edgeFear(); } else { x += d > 0 ? st : -st; busy = true; }
      if (mode === 'walk' && tripAt != null && (dir > 0 ? x >= tripAt : x <= tripAt)) { tripAt = null; trip(); }
    }
    if (mode === 'drag' && drag) {
      drag.vx *= Math.pow(0.02, dt);
      angT = clamp(drag.vx * 0.035, -36, 36);
    }
    if (tw) {
      var p = clamp((t - tw.t0) / tw.dur, 0, 1), e = tw.ease(p);
      x = bez(tw.x0, tw.cx, tw.x1, e); y = bez(tw.y0, tw.cy, tw.y1, e); sc = tw.s0 + (tw.s1 - tw.s0) * e;
      if (p >= 1) { var done = tw.done; tw = null; if (done) done(); } else busy = true;
    }
    // 摆动：阻尼弹簧
    av += (-140 * (ang - angT) - 13 * av) * dt; ang += av * dt;
    if (Math.abs(ang - angT) > 0.05 || Math.abs(av) > 0.05) busy = true; else { ang = angT; av = 0; }
    place();
    if (busy || mode === 'drag' || tw) raf = requestAnimationFrame(loop);
  }
  function easeIn(p) { return p * p; }
  function easeInOut(p) { return p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2; }
  function easeOut(p) { return 1 - (1 - p) * (1 - p); }
  var airFrom = 0;   // 这次腾空是从多高开始的（算落地压多深）
  function fly(x1, y1, s1, cy, ms, ease, done) {
    airFrom = Math.min(y, cy);
    tw = { t0: performance.now(), dur: ms, x0: x, y0: y, s0: sc, cx: (x + x1) / 2, cy: cy, x1: x1, y1: y1, s1: s1, ease: ease, done: done };
    kick();
  }

  /* ---------- 拖：首页拖到卡片上打开工具；别的地方松手就往下掉 ---------- */
  // 看它的身子落在哪张卡片上：先看身子中间，再看手指 / 鼠标，最后看脚（抓着头拖时身子挂在下面）
  function cardAt(cx, cy) {
    if (!HOME) return null;
    var cs = grid.querySelectorAll('.card[data-id]:not(.hide)');
    var bx = x - sX() + W / 2, pts = [[bx, y - sY() + H * 0.6], [cx, cy], [bx, y - sY() + H * 0.92]];
    for (var k = 0; k < pts.length; k++) {
      for (var i = 0; i < cs.length; i++) {
        var r = cs[i].getBoundingClientRect();
        if (pts[k][0] >= r.left && pts[k][0] <= r.right && pts[k][1] >= r.top && pts[k][1] <= r.bottom) return cs[i];
      }
    }
    return null;
  }
  function hover(c) {
    if (overCard === c) return;
    if (overCard) overCard.classList.remove('xin-over');
    overCard = c;
    if (c) c.classList.add('xin-over');
    setMood(c ? 'over' : '');
  }
  function plug(card) {
    setMode('plug'); angT = 0;
    var r = card.getBoundingClientRect();
    var x1 = r.left + sX() + r.width / 2 - W / 2, y1 = r.top + sY() + r.height / 2 - H / 2;
    var go = function () {
      setMood('');
      card.classList.remove('xin-over');
      card.classList.add('xin-hit');
      setTimeout(function () { card.classList.remove('xin-hit'); }, 600);
      goAway(); sc = 1; ang = 0; av = 0; place();
      carry(card.dataset.id || 'tool');     // 小芯被扔进了这个工具
      try { sessionStorage.removeItem(STMOFF); } catch (e) {}   // 重新扔进来：之前在学习台里收起来的不算了
      card.click();
      // 没打开（例如工具不存在），就回来
      setTimeout(function () { if (mode === 'away' && !body.classList.contains('tool-open')) { carry(''); dropIn(0); } }, 400);
    };
    if (reduce) { go(); return; }
    fly(x1, y1, 0.3, Math.min(y, y1) - 24, 300, easeOut, go);
  }

  el.addEventListener('pointerdown', function (e) {
    if (e.button > 0 || mode === 'plug' || mode === 'away' || drag) return;
    e.preventDefault(); e.stopPropagation();
    lastInput = Date.now();
    try { el.setPointerCapture(e.pointerId); } catch (er) {}
    var r = el.getBoundingClientRect();
    drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, px: e.pageX, py: e.pageY,
      gx: clamp(e.clientX - r.left, 6, W - 6), gy: clamp(e.clientY - r.top, H * 0.3, H - 10),
      lx: e.clientX, lt: performance.now(), vx: 0, on: false, bag: false };
    // 手机上长按 = 右键：打开背包
    if (e.pointerType !== 'mouse') { var me = drag; me.lp = setTimeout(function () { if (drag === me && !me.on) { me.bag = true; openBag(); } }, 520); }
  });
  el.addEventListener('pointermove', function (e) {
    if (!drag || e.pointerId !== drag.id) return;
    if (!drag.on) {
      if (Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy) < 7 || drag.bag) return;
      clearTimeout(drag.lp); closeBag();
      drag.from = plat; drag.fx = x; drag.t0 = performance.now();
      if (sw) { sw = null; ang = angT = 0; av = 0; }
      drag.on = true; tw = null; plat = null; thread = null; drawThread();
      if (mode === 'sleep') clearTimeout(zTm);
      drag.x0 = x; drag.y0 = y;
      rEl.style.transformOrigin = drag.gx.toFixed(1) + 'px ' + drag.gy.toFixed(1) + 'px';
      stopSeq(); setMood(''); look = { x: 0, y: -1 }; setMode('drag'); body.classList.add('xin-drag');
    }
    var t = performance.now(), dt = Math.max(8, t - drag.lt);
    drag.vx = drag.vx * 0.6 + (e.clientX - drag.lx) / dt * 1000 * 0.4;
    drag.lx = e.clientX; drag.lt = t;
    x = drag.x0 + (e.pageX - drag.px); y = drag.y0 + (e.pageY - drag.py); sc = 1;
    hover(cardAt(e.clientX, e.clientY));
    kick();
  });
  function up(e) {
    if (!drag || e.pointerId !== drag.id) return;
    var d = drag; drag = null; clearTimeout(d.lp);
    if (!d.on) { if (e.type === 'pointerup' && !d.bag) tap(); return; }
    body.classList.remove('xin-drag');
    var c = overCard; hover(null); look = { x: 0, y: 0 };
    if (c && e.type === 'pointerup') { plug(c); return; }
    // 被扔：攒点火气（拎太久了更气）；有时候偏要走回原来那儿
    annoy(performance.now() - (d.t0 || 0) > 3000 ? 1.2 : 0.5);
    backTo = d.from && rebel() ? { plat: d.from, x: d.fx } : null;
    fall('drop');
  }
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  el.addEventListener('lostpointercapture', up);
  el.addEventListener('contextmenu', function (e) { e.preventDefault(); if (drag && drag.on) return; openBag(); });


  /* ---------- 说话气泡（小芯聊天：AI 让它说的话） ---------- */
  var sayEl = null, sayTm = 0;
  function placeSay() {
    if (!sayEl) return;
    if (mode === 'away') { sayEl.style.visibility = 'hidden'; return; }
    sayEl.style.visibility = '';
    sayEl.style.maxWidth = '';
    var bw = sayEl.offsetWidth, bh = sayEl.offsetHeight, head = y + H * (6 + OY) / G;
    if (head - bh - 10 >= sY() + 4) {            // 头顶放得下：气泡在头上
      sayEl.className = 'xin-say';
      var half = bw / 2, cx = clamp(x + W / 2, sX() + 8 + half, sX() + innerWidth - 8 - half);
      sayEl.style.left = Math.round(cx) + 'px'; sayEl.style.top = Math.round(head - 6) + 'px';
      sayEl.style.setProperty('--tail', Math.round(clamp(x + W / 2 - cx + half, 10, bw - 10)) + 'px');
    } else if (bw > Math.max(x + W * 0.12 - sX() - 8, sX() + innerWidth - 8 - (x + W * 0.88))) {
      // 站在页面最上面、旁边也放不下（手机上较长的回答）：放在脚下
      sayEl.className = 'xin-say b';
      var hb = bw / 2, cb = clamp(x + W / 2, sX() + 8 + hb, sX() + innerWidth - 8 - hb);
      sayEl.style.left = Math.round(cb) + 'px'; sayEl.style.top = Math.round(y + H + 8) + 'px';
      sayEl.style.setProperty('--tail', Math.round(clamp(x + W / 2 - cb + hb, 10, bw - 10)) + 'px');
    } else {                                     // 站在页面最上面（手机标题栏）：放在旁边空得多的一侧
      var roomL = x + W * 0.12 - sX() - 8, roomR = sX() + innerWidth - 8 - (x + W * 0.88), left = roomL > roomR;
      sayEl.className = 'xin-say ' + (left ? 'l' : 'r');
      sayEl.style.maxWidth = Math.round(Math.min(240, Math.max(96, left ? roomL : roomR))) + 'px';
      bw = sayEl.offsetWidth; bh = sayEl.offsetHeight;
      var ty = clamp(y + H * 0.42, sY() + 4 + bh / 2, sY() + innerHeight - 4 - bh / 2);
      sayEl.style.top = Math.round(ty) + 'px';
      sayEl.style.left = Math.round(left ? Math.max(x + W * 0.12, sX() + 8 + bw) : Math.min(x + W * 0.88, sX() + innerWidth - 8 - bw)) + 'px';
    }
  }
  // onTap：给了就能点（小芯聊天：点气泡打开面板看全文），字也可以多一点
  function say(text, ms, onTap) {
    clearTimeout(sayTm);
    text = String(text == null ? '' : text).replace(/\s+/g, ' ').trim().slice(0, onTap ? 140 : 80);
    if (!text) { if (sayEl) { sayEl.remove(); sayEl = null; } return; }
    if (!sayEl) { sayEl = document.createElement('div'); sayEl.className = 'xin-say'; sayEl.setAttribute('role', 'status'); layer.appendChild(sayEl); }
    sayEl.textContent = text;
    sayEl.onclick = onTap ? function (e) { e.preventDefault(); e.stopPropagation(); var f = onTap; say(''); f(); } : null;
    if (onTap) sayEl.setAttribute('data-tap', ''); else sayEl.removeAttribute('data-tap');
    placeSay();
    sayTm = setTimeout(function () { if (sayEl) { sayEl.remove(); sayEl = null; } }, ms || Math.min(9000, 2600 + text.length * 160));
  }

  /* ---------- 和小芯说话：小芯旁边冒一个输入框（打字或语音），发出去就收起来 ----------
     o = { onSend(text), onExpand(), placeholder, chip, onChipOff() }；chip 是框上面那行「附带：…」（点 ✕ 这次不带）；语音用浏览器自带的识别（没有就不显示话筒） */
  var askEl = null, rec = null;
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition || null;
  var ASK_ICON = {
    mic: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/></svg>',
    send: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13M13 6l6 6-6 6"/></svg>',
    more: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7"/></svg>'
  };
  function closeAsk() {
    if (rec) { try { rec.abort(); } catch (e) {} rec = null; }
    if (askEl) { askEl.remove(); askEl = null; }
  }
  function placeAsk() {
    if (!askEl) return;
    var r = el.getBoundingClientRect(), vw = window.visualViewport ? visualViewport.width : innerWidth, vh = window.visualViewport ? visualViewport.height : innerHeight;
    var w = Math.min(360, vw - 16), bh = askEl.offsetHeight;
    askEl.style.width = w + 'px';
    var left = clamp(r.left + r.width / 2 - w / 2, 8, vw - w - 8);
    // 小芯在屏幕上半截：框放在它下面（手机上键盘弹起来也挡不住）；否则放在它头上
    var top = r.top < vh * 0.45 ? r.bottom + 6 : r.top + r.height * 0.25 - bh - 6;
    askEl.style.left = Math.round(left) + 'px'; askEl.style.top = Math.round(clamp(top, 8, Math.max(8, vh - bh - 8))) + 'px';
  }
  function ask(o) {
    o = o || {};
    closeBag(); closeAsk();
    if (paused() || mode === 'away') return false;
    lastInput = Date.now();
    if (mode === 'sleep') wake(false);
    stopWalk();
    askEl = document.createElement('div');
    askEl.className = 'xin-ask'; askEl.setAttribute('role', 'dialog'); askEl.setAttribute('aria-label', '和小芯说话');
    askEl.innerHTML = (o.chip ? '<div class="xin-ask-ctx"><span></span><button type="button" aria-label="这次不带">✕</button></div>' : '') + '<div class="xin-ask-row"><textarea rows="1" enterkeyhint="send" aria-label="和小芯说的话"></textarea>' +
      (SR ? '<button type="button" class="xin-ask-mic" aria-label="说话">' + ASK_ICON.mic + '</button>' : '') +
      '<button type="button" class="xin-ask-send" aria-label="发送">' + ASK_ICON.send + '</button></div>' +
      '<div class="xin-ask-ft"><span class="xin-ask-hint" role="status"></span>' +
      (o.onExpand ? '<button type="button" class="xin-ask-more">' + ASK_ICON.more + '<span>展开</span></button>' : '') + '</div>';
    var ta = askEl.querySelector('textarea'), hint = askEl.querySelector('.xin-ask-hint'), mic = askEl.querySelector('.xin-ask-mic'), box = askEl;
    var chip = askEl.querySelector('.xin-ask-ctx');
    if (chip) {
      chip.firstChild.textContent = o.chip;
      chip.lastChild.addEventListener('click', function () { chip.remove(); placeAsk(); if (o.onChipOff) o.onChipOff(); ta.focus(); });
    }
    ta.placeholder = o.placeholder || '和小芯说点什么…';
    var grow = function () { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 120) + 'px'; placeAsk(); };
    var send = function () {
      var t = ta.value.trim();
      if (!t) { ta.focus(); return; }
      closeAsk();
      if (o.onSend) o.onSend(t);
    };
    ta.addEventListener('input', grow);
    ta.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
      else if (e.key === 'Escape') closeAsk();
    });
    askEl.querySelector('.xin-ask-send').addEventListener('click', send);
    var more = askEl.querySelector('.xin-ask-more');
    if (more) more.addEventListener('click', function () { closeAsk(); o.onExpand(); });
    if (mic) mic.addEventListener('click', function () {
      if (rec) { try { rec.stop(); } catch (e) {} return; }
      var base = ta.value ? ta.value.replace(/\s+$/, '') + ' ' : '';
      try { rec = new SR(); } catch (e) { hint.textContent = '这个浏览器不能语音输入，可以用键盘上的话筒'; return; }
      var me = rec;
      rec.lang = 'zh-CN'; rec.interimResults = true; rec.continuous = false;
      rec.onresult = function (ev) {
        var t = '';
        for (var i = 0; i < ev.results.length; i++) t += ev.results[i][0].transcript;
        ta.value = (base + t).replace(/^\s+/, ''); grow();
      };
      rec.onerror = function (ev) {
        var m = { 'not-allowed': '没有话筒权限：在浏览器设置里允许这个网站用话筒', 'service-not-allowed': '这个浏览器的语音识别用不了，可以用键盘上的话筒',
          network: '语音识别连不上（电脑上的 Chrome 在国内多半用不了），可以用键盘上的话筒', 'no-speech': '没听到声音，再试一次', 'audio-capture': '找不到话筒' }[ev.error];
        if (m) hint.textContent = m;
      };
      rec.onend = function () { if (rec === me) rec = null; if (box) box.classList.remove('rec'); if (mic) mic.setAttribute('aria-label', '说话'); if (mode === 'idle') setMood(''); };
      try { rec.start(); } catch (e) { rec = null; hint.textContent = '语音输入开不了：' + e.message; return; }
      hint.textContent = '在听…说完会自动停'; box.classList.add('rec'); mic.setAttribute('aria-label', '停止说话');
      if (mode === 'idle') setMood('wow', 1500);
    });
    body.appendChild(askEl);
    placeAsk();
    lookEl(askEl, 1500);
    try { ta.focus({ preventScroll: true }); } catch (e) { ta.focus(); }
    return true;
  }
  document.addEventListener('pointerdown', function (e) { if (askEl && !askEl.contains(e.target) && !el.contains(e.target)) closeAsk(); }, true);
  window.addEventListener('resize', placeAsk);
  if (window.visualViewport) visualViewport.addEventListener('resize', placeAsk);

  /* ---------- 跟着云电脑里的 AI 动：think 坐在电脑前想，work 敲代码（一直循环到 AI 停下来） ---------- */
  var aiState = '', aiLoop = false;
  function aiStep() {
    aiLoop = true; stopWalk(); setMood(''); setMode('play');
    var f = aiState === 'work' ? [pcS({ armR: 'typeUp', t: 160 })].concat(typing(12)) : thinking(1900);
    playSeq(f, function () {
      if (aiState && mode === 'play' && !paused()) { aiStep(); return; }
      aiLoop = false;
      if (mode === 'play') { mode = 'idle'; render(); }
      schedule();
    });
  }
  function setAi(st) {
    st = st === 'work' || st === 'think' ? st : '';
    if (st === aiState) return;
    aiState = st; lastInput = Date.now();
    if (st) {
      if (mode === 'sleep') { clearTimeout(zTm); clearTimeout(sleepTm); setMode('idle'); }
      if (reduce || paused()) return;
      if (aiLoop) return;                     // 已经在电脑前了：这一段做完自动换成新的状态
      if (mode === 'idle' || mode === 'walk') aiStep();
      else schedule(300);                     // 正在做别的（跳舞、吃饼干…）：做完再回电脑前
    } else if (aiLoop && mode === 'play') { aiLoop = false; stopSeq(); putPcAway(); }
  }
  function putPcAway() { setMode('play'); playSeq([pc({ t: 260 })].concat(putAway()), done); }
  // AI 用 xin 命令让小芯做的动作（名字和 site/xin/vm-agent.mjs 里的 ACTS 一致）
  var AI_MOOD = { happy: 'happy', sad: 'sad', angry: 'angry', wow: 'wow', confused: 'confused' };
  function idleNow() { aiLoop = false; stopWalk(); if (mode === 'play') { stopSeq(); setMode('idle'); } }
  function command(name, arg) {
    if (paused() || mode === 'away') return false;
    lastInput = Date.now();
    if (name === 'say') { say(arg); return true; }
    act(function () {
      aiLoop = false;                         // 动作接替了电脑前的循环；AI 还在忙的话，做完动作会自己回电脑前
      if (mode === 'sleep' && name !== 'sleep') { clearTimeout(zTm); clearTimeout(sleepTm); setMode('idle'); }
      if (AI_MOOD[name]) { idleNow(); setMood(AI_MOOD[name], 2600); if (name === 'happy') sparks(4); schedule(2800); return; }
      switch (name) {
        case 'dance': dance(); break;
        case 'jump': idleNow(); jump(5); schedule(1400); break;
        case 'cookie': case 'ball': case 'led': playToy(name, true); break;
        case 'battery': playToy('batt', true); break;
        case 'sleep': idleNow(); setMood(''); sleep(true); break;
        case 'wake': wake(false); break;
        case 'music': setMusic(arg !== 'off'); break;
        case 'swing': idleNow(); if (!swing()) jump(4); break;
        case 'sit': idleNow(); if (!sitDown()) schedule(); break;
        case 'code': code(true, 'ok'); break;
        case 'rage': idleNow(); rage(); break;
        case 'tongue': idleNow(); var r = el.getBoundingClientRect(); tease(r.left + r.width); break;
        case 'move': idleNow(); syncLearned(); if (!doMove(findMove(arg))) { setMood('confused', 1600); schedule(1800); } break;
        default: break;
      }
    });
    return true;
  }

  /* ---------- 小背包：电脑上右键小芯、手机上长按小芯打开 ----------
     吃的（饼干、电池）、玩的（小球、LED）、耳机（陪你听歌）、睡觉 / 叫醒、回来、收起来（首页）。 */
  var ICONS = {
    cookie: ['..####..', '.#c##c#.', '########', '##c#####', '#####c##', '########', '.#c####.', '..####..'],
    batt:   ['...oo...', '..oooo..', '..oggo..', '..oggo..', '..oggo..', '..oggo..', '..oggo..', '..oooo..'],
    ball:   ['..####..', '.#hh###.', '##h#####', '########', '########', '########', '.######.', '..####..'],
    led:    ['..rrrr..', '.rrhrrr.', '.rrhrrr.', '.rrrrrr.', 'oooooooo', '..m..m..', '..m..m..', '..m..m..'],
    pc:     ['########', '#oooooo#', '#og.ooo#', '#oogg.o#', '#oooooo#', '########', '.#....#.', '########'],
    dance:  ['....##..', '....#.#.', '....#..#', '....#...', '..###...', '.####...', '.###....', '........'],
    swing:  ['########', '.o....o.', '.o....o.', '.o....o.', '.o....o.', '.o....o.', '.kkkkkk.', '........'],
    phones: ['..####..', '.#....#.', '#......#', '#......#', '#......#', 'kk....kk', 'kk....kk', 'kk....kk'],
    moon:   ['...###..', '..##....', '.##.....', '.##.....', '.##.....', '.##.....', '..##....', '...###..'],
    sun:    ['...#....', '#..#..#.', '.#####..', '##ooo##.', '.#ooo#..', '.#####..', '#..#..#.', '...#....'],
    home:   ['...##...', '..####..', '.######.', '########', '.#....#.', '.#.##.#.', '.#.##.#.', '.######.'],
    hide:   ['...##...', '...##...', '...##...', '#..##..#', '.#.##.#.', '..####..', '...##...', '########'],
    chat:   ['.######.', '#hhhhhh#', '#hkhkhk#', '#hhhhhh#', '.######.', '..##....', '..#.....', '........'],
    star:   ['...##...', '...##...', '..####..', '########', '.######.', '..####..', '.##..##.', '.#....#.']
  };
  var PAL = { '#': 'var(--ink)', c: '#5a3a22', o: 'var(--ink-3, #888)', g: '#7bd88f', h: '#ffffff', r: '#d9573f', m: '#9a948a', k: 'var(--clay)' };
  var ICON_C = { cookie: { '#': '#c98d4b' }, ball: { '#': 'var(--clay)' }, phones: { '#': 'var(--ink)' }, moon: { '#': '#e5b84f' }, star: { '#': '#e5b84f' }, dance: { '#': 'var(--clay)' }, sun: { '#': '#e5b84f', o: '#f2d27a' }, home: { '#': 'var(--ink-2, var(--ink))' }, hide: { '#': 'var(--ink-2, var(--ink))' } };
  function pixIcon(name) {
    var rows = ICONS[name], o = ['<svg viewBox="0 0 8 8" width="28" height="28" aria-hidden="true" shape-rendering="crispEdges" style="stroke:none">'];
    rows.forEach(function (row, yy) {
      for (var xx = 0; xx < 8; xx++) {
        var ch = row.charAt(xx); if (ch === '.') continue;
        var col = (ICON_C[name] && ICON_C[name][ch]) || PAL[ch];
        o.push('<rect x="' + xx + '" y="' + yy + '" width="1" height="1" fill="' + col + '"/>');
      }
    });
    return o.join('') + '</svg>';
  }
  var bagEl = null, extraBag = [];
  function bagItems() {
    var out = [
      ['cookie', '饼干', function () { feed('cookie'); }],
      ['batt', '电池', function () { feed('batt'); }],
      ['ball', '小球', function () { playToy('ball', true); played('ball'); }],
      ['led', 'LED', function () { playToy('led', true); played('led'); }],
      ['phones', music ? '摘耳机' : '耳机', function () { if (!music && Date.now() - phonesBroke < 30000) refuse(); else { setMusic(!music); if (music) played('phones'); } }],   // 刚砸完：不戴
      ['pc', '敲代码', function () { code(true); }],
      ['dance', '跳舞', function () { dance(); played('dance'); }],
      ['swing', '秋千', function () { if (mode === 'play') setMode('idle'); stopWalk(); if (!swing()) jump(4); played('swing'); }],
      mode === 'sleep' ? ['sun', '叫醒', function () { wake(true); }] : ['moon', '睡觉', function () {
        if (mode === 'play') setMode('idle'); stopWalk(); setMood('');
        // 叛逆：刚吃了电池精神得很、或者就是不想睡——摇头、吐舌头、背过身；嘴上说不要，过一会儿自己就睡着了
        if (Date.now() < energy || rebel()) { refuse(function () { schedule(); setTimeout(function () { if (mode === 'idle' && !seq && !mood) sleep(true); }, 6000); }); return; }
        sleep(true);
      }]
    ];
    syncLearned();
    if (learned.length) out.push(['star', '新动作', function () { var m = learned[learnI++ % learned.length]; if (doMove(m)) say(m.name, 1800); }]);
    extraBag.forEach(function (it) { out.push([it.icon, it.label, it.fn]); });
    // 学习台里的小芯：聊天面板在外面的工具箱页面上（xin/chat.js），从这里叫它打开
    var chat = null; try { chat = STM && window.parent !== window ? window.parent.LimingXinChat : null; } catch (e) { chat = null; }
    if (chat && chat.state && chat.state.enabled) out.push(['chat', '聊天', function () { if (chat.ask) chat.ask(window.LimingXin); else chat.open(); }]);
    if (HOME) {
      out.push(['home', '回标题栏', function () { var g = plats().filter(function (q) { return q.kind === 'ground'; })[0]; if (g && !same(g, plat)) come(function () { hop(g, g.x0 + (g.x1 - g.x0) * 0.4); }); }]);
      out.push(['hide', '收起来', function () { setOff(true); }]);
    } else {
      out.push(['home', '过来', function () { var q = bestPlat(); if (q && !same(q, plat)) come(function () { hop(q); }); }]);
      out.push(['hide', '收起来', function () { setStmOff(true); }]);
    }
    return out;
  }
  // 喂东西：40 秒里已经吃了两样，饱了，不吃
  function feed(name) {
    var t = Date.now(); ate = ate.filter(function (v) { return t - v < 40000; });
    if (ate.length >= 2) { refuse(); return; }
    ate.push(t); playToy(name, true); played(name);
  }
  // 叫它过来：有时候先背过身不理你，磨蹭一会儿才过来
  function come(go) { if (rebel()) refuse(go); else go(); }
  function openBag() {
    closeBag();
    if (paused() || mode === 'away') return;
    lastInput = Date.now();
    bagEl = document.createElement('div');
    bagEl.className = 'xin-bag'; bagEl.setAttribute('role', 'menu'); bagEl.setAttribute('aria-label', '小芯的背包');
    bagItems().forEach(function (it) {
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'xin-it'; b.setAttribute('role', 'menuitem');
      b.innerHTML = pixIcon(it[0]) + '<span></span>'; b.lastChild.textContent = it[1];
      b.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); closeBag(); act(it[2]); });
      bagEl.appendChild(b);
    });
    body.appendChild(bagEl);
    var r = el.getBoundingClientRect(), bw = bagEl.offsetWidth, bh = bagEl.offsetHeight;
    var left = clamp(r.left + r.width / 2 - bw / 2, 8, innerWidth - bw - 8), top = r.top + r.height * 0.3 - bh - 6;
    if (top < topPad() + 8) top = Math.min(innerHeight - bh - 8, r.bottom + 6);
    bagEl.style.left = Math.round(left) + 'px'; bagEl.style.top = Math.round(top) + 'px';
    look = { x: 0, y: r.top > top ? -1 : 1 }; render();
    var first = bagEl.querySelector('button'); if (first) try { first.focus({ preventScroll: true }); } catch (e2) {}
  }
  // 背包里选的事：它正在半空（跳、掉、吊在线上、荡秋千）就等落地再做，不然一落地就被打断了
  var pendingAct = null;
  function act(fn) { if (/^(fly|hang|rope|climb|swing|plug)$/.test(mode)) { pendingAct = fn; return; } pendingAct = null; fn(); }
  function closeBag() { if (bagEl) { bagEl.remove(); bagEl = null; } }
  document.addEventListener('pointerdown', function (e) { if (bagEl && !bagEl.contains(e.target) && !el.contains(e.target)) closeBag(); }, true);
  document.addEventListener('keydown', function (e) { if (bagEl && e.key === 'Escape') closeBag(); });
  window.addEventListener('scroll', function () { closeBag(); }, { passive: true });
  window.addEventListener('resize', function () { closeBag(); });

  // 戴上耳机：坐着跟节拍点头跺脚冒音符，不乱跑也不睡觉，直到你从背包里摘下来
  function setMusic(on) {
    music = !!on;
    if (music) { musicAt = Date.now(); boreAt = musicAt + 45000 + Math.random() * 40000; }
    if (music) { if (mode === 'sleep') { clearTimeout(zTm); setMode('idle'); } if (mode === 'walk') stopWalk(); setMood('happy', 700); }
    else blink(false);
    render();
  }

  // 首页「收起来」：小芯回去休息；点标题栏左边的 ✻ 它再出来
  var spark = HOME ? document.querySelector('.hd .spark') : null;
  function off() { try { return localStorage.getItem('lm.xin.off') === '1'; } catch (e) { return false; } }
  function setOff(v) {
    try { if (v) localStorage.setItem('lm.xin.off', '1'); else localStorage.removeItem('lm.xin.off'); } catch (e) {}
    if (spark) spark.classList.toggle('xin-call', !!v);
    if (v) { music = false; stopWalk(); stopSeq(); clearTimeout(idleTm); clearTimeout(zTm); goAway(); }
    else if (!paused()) { lastInput = Date.now(); dropIn(0); }
  }
  if (spark) {
    spark.classList.toggle('xin-call', off());
    spark.addEventListener('click', function () { if (off()) setOff(false); });
  }

  /* ---------- 对外界的反应 ---------- */
  /* 只有碰它（点、拖、背包）才会把它吵醒。鼠标在附近晃，它只是用眼睛跟着看；离得远就不理，和手机上一样各干各的 */
  function poke() { lastInput = Date.now(); }
  function near(cx, cy, d) { var r = el.getBoundingClientRect(); return Math.abs(cx - (r.left + r.width / 2)) < d && Math.abs(cy - (r.top + r.height / 2)) < d; }
  function canLook() { return mode === 'idle' || mode === 'walk'; }   // 玩东西、睡觉、吊在线上时眼睛有自己要看的
  // 鼠标在它身边晃太久，偶尔冲你吐舌头
  var nearSince = 0, teasedAt = 0;
  document.addEventListener('pointermove', function (e) {
    if (e.pointerType !== 'mouse' || drag || paused() || !near(e.clientX, e.clientY, 260)) { nearSince = 0; return; }
    poke(); if (canLook()) lookAt(e.clientX, e.clientY, 1800);
    var now = Date.now();
    if (!near(e.clientX, e.clientY, 150)) { nearSince = 0; return; }
    if (!nearSince) nearSince = now;
    else if (now - nearSince > 2600 && now - teasedAt > 20000 && mode === 'idle' && !mood && !seq && rebel()) { teasedAt = now; nearSince = 0; tease(e.clientX); }
  }, { passive: true });
  document.addEventListener('pointerdown', function (e) {
    if (paused() || el.contains(e.target)) return;
    poke(); if (canLook() && near(e.clientX, e.clientY, 320)) lookAt(e.clientX, e.clientY, 1600);
  }, { passive: true, capture: true });
  document.addEventListener('keydown', function () { if (!paused()) poke(); });
  var scrollTm = 0;
  window.addEventListener('scroll', function () {
    if (paused()) return;
    lastInput = Date.now();
    // 滚动停下来以后，如果小芯已经不在屏幕上，就跳回来
    clearTimeout(scrollTm);
    scrollTm = setTimeout(function () { if (!onScreen() && (mode === 'idle' || mode === 'walk' || mode === 'sleep' || mode === 'play')) { stopSeq(); clearTimeout(zTm); dropIn(0); } }, 700);
  }, { passive: true });

  if (HOME) {
    var q = document.getElementById('q'), empty = document.getElementById('empty'), themeBtn = document.getElementById('themeBtn');
    if (q) {
      q.addEventListener('input', function () { lookEl(q, 1600); });
      q.addEventListener('focus', function () { lookEl(q, 1600); });
    }
    if (empty && window.MutationObserver) new MutationObserver(function () {
      if (!empty.hidden) { if (mode === 'play') setMode('idle'); setMood('sad'); }
      else if (mood === 'sad') setMood('');
    }).observe(empty, { attributes: true, attributeFilter: ['hidden'] });
    if (themeBtn) themeBtn.addEventListener('click', function () { lookEl(themeBtn, 1200); blink(false); });
  }

  window.addEventListener('resize', function () {
    dims(); lastSig = ''; render();
    if (mode === 'drag' || mode === 'fly' || mode === 'plug' || mode === 'swing') return;
    follow();
  });

  /* 首页：打开工具时小芯在面板后面歇着。正常点开工具再关掉，它还在原来的地方；
     要是它被扔进了工具（carried），关掉工具时它从工具里出来，掉回首页。
     学习台在面板里：被扔进来时掉进来，面板收起时歇着。 */
  var saved = null;
  function pause() {
    closeBag(); stopWalk(); stopSeq(); clearTimeout(idleTm); clearTimeout(zTm); ticker(false);
    if (mode === 'drag' || mode === 'fly' || mode === 'plug' || mode === 'swing') { tw = null; drag = null; hover(null); body.classList.remove('xin-drag'); }
    saved = mode !== 'away' && plat ? { plat: plat, x: x } : null;
    goAway();   // goAway 会把线也收掉
  }
  function resume(delay) {
    lastInput = Date.now(); ticker(true);
    if (HOME && carried()) { carry(''); saved = null; dropIn(delay); return; }
    var sv = saved, p = sv && platOf(sv.plat.el, sv.plat.kind); saved = null;
    if (p) { plat = p; x = clamp(sv.x, p.x0, p.x1); y = p.fy - H; setMode('idle'); place(); schedule(); return; }
    dropIn(delay);
  }
  var wasPaused = paused();
  function onState() {
    syncPeek();
    var p = paused();
    if (p === wasPaused) return;
    wasPaused = p;
    if (p) pause(); else resume(HOME ? 260 : 300);
  }

  /* ---------- 学习台里收起来 / 叫回来 ----------
     背包「收起来」：小芯回去歇着，屏幕右边探出它的小脑袋；点小脑袋它就跳回来。只在被扔进学习台、学习台开着的时候有。 */
  var peek = null;
  function setStmOff(v) {
    try { if (v) sessionStorage.setItem(STMOFF, '1'); else sessionStorage.removeItem(STMOFF); } catch (e) {}
    if (v) { closeAsk(); music = false; }
    onState();
    if (v) saved = null;   // 叫回来时从上面掉进来，不是凭空出现在原地
  }
  function syncPeek() {
    var show = STM && !!panel && carried() === 'stm32' && stmOff() && !hiddenFrame() && !document.hidden;
    if (show && !peek) {
      peek = document.createElement('button');
      peek.type = 'button'; peek.className = 'xin-peek'; peek.title = '叫小芯出来'; peek.setAttribute('aria-label', '叫小芯出来');
      var p = base(0); p.face = 'eyes'; p.lx = -1; p.ly = 0; p.item = null; p.fx = null; p.mouth = 0; p.armL = 'out'; p.armR = 'out'; p.b = 0; p.sx = 0; p.dy = 0;
      peek.innerHTML = '<svg viewBox="2 6 16 10" aria-hidden="true" shape-rendering="crispEdges">' + draw(p, 'xin-peek-body') + '</svg>';
      peek.addEventListener('click', function () { setStmOff(false); });
      body.appendChild(peek);
    }
    if (peek) peek.hidden = !show;
  }
  if (window.MutationObserver) {
    if (HOME) new MutationObserver(onState).observe(body, { attributes: true, attributeFilter: ['class'] });
    if (panel) new MutationObserver(onState).observe(panel, { attributes: true, attributeFilter: ['class'] });
  }
  document.addEventListener('visibilitychange', onState);
  setInterval(function () { if (!paused()) follow(); }, 120);

  /* ---------- 出场 ---------- */
  place(); render(); syncPeek();
  if (!wasPaused) {
    ticker(true);
    // 学习台的内容是脚本画出来的，等它画好再掉进来
    var tries = 0, start = function () {
      if (paused()) return;
      if (!bestPlat() && tries++ < 20) { setTimeout(start, 300); return; }
      dropIn(HOME ? 380 : 200);
    };
    start();
  }
  blinkLoop();

  var portraitId = 0;
  window.LimingXin = {
    get mode() { return mode; },
    get mood() { return mood; },
    get plat() { return plat ? { kind: plat.kind, el: plat.el } : null; },
    el: el,
    portrait: function () { return '<svg class="xc-px xin-portrait" viewBox="0 5.8 20 14.2" aria-hidden="true" shape-rendering="crispEdges">' + draw({ face: 'eyes', armL: 'out', armR: 'wave' }, 'xin-portrait-' + (++portraitId)) + '</svg>'; },
    sleep: function () { setMode('idle'); setMood(''); sleep(); },
    toy: playToy,
    bag: openBag,
    hide: function (v) { if (STM) setStmOff(v !== false); },
    get hidden() { return STM && stmOff(); },
    music: setMusic,
    feel: function (m, ms) { setMood(m, ms); },
    drop: function () { fall('drop'); },
    jump: function () { tap(); },
    plats: plats,
    hop: function (i) { var ps = plats(); hop(ps[i]); },
    // 调试 / 截图：固定一个姿势（传 null 恢复）
    pose: function (p) { forced = p; lastSig = ''; render(); },
    frames: function (n) { return n === 'jump' ? jumpFrames(6) : n === 'dance' ? danceFrames() : TOYS[n]().frames; },
    get grr() { return grr; },
    set obedient(v) { obedientF = !!v; REBEL = rebelBase(); },   // 测试用：不叛逆
    get rebel() { return REBEL; },
    dance: dance, swing: swing, rage: rage, refuse: refuse, sit: sitDown, trip: trip, code: code, tease: tease, mischief: mischief,
    bore: function () { boreAt = 0; },
    // 小芯聊天（xin-chat.js）用
    say: say,
    ask: ask,
    closeAsk: closeAsk,
    get asking() { return !!askEl; },
    ai: setAi,
    get aiState() { return aiState; },
    cmd: command,
    learn: learn,
    get learned() { return learned.map(function (m) { return m.name; }); },
    bond: setBond,
    addBag: function (id, label, fn) { extraBag = extraBag.filter(function (it) { return it.id !== id; }); extraBag.push({ id: id, icon: ICONS[id] ? id : 'chat', label: label, fn: fn }); },
    // 回到标题栏上（手机上聊天面板从底下升起来，别让小芯被挡住）
    home: function () { if (!HOME || paused() || !(mode === 'idle' || mode === 'walk' || mode === 'play')) return; var g = plats().filter(function (q) { return q.kind === 'ground'; })[0]; if (g && !same(g, plat)) { aiLoop = false; stopWalk(); stopSeq(); setMode('idle'); hop(g, g.x0 + (g.x1 - g.x0) * 0.4); } },
    removeBag: function (id) { extraBag = extraBag.filter(function (it) { return it.id !== id; }); }
  };
})();
