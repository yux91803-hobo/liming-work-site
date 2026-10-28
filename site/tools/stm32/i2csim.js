/* i2csim.js — 教学用 I2C 总线模拟器（不碰 DOM，可在 Node 里测试）
   · 线：开漏 + 上拉，「线与」：谁都不拉就是 1，任何一方拉低就是 0。
   · 主机：程序一步步写 SCL / SDA（1 = 松手，0 = 拉低）、读 SDA、延时；每次写引脚记一次波形。
   · 从机：M24C02 模型（地址 1010 000，256 字节，16 字节一页，写周期内不应答）。
   · 解码器：只看两根线的波形，标出起始 / 停止 / 每一位 / 每个字节 / 应答，以及不合规的地方。
   · 时序检查：按 I2C 标准模式（100 kHz）的最小时间核对。
   这是一个教学模型：规则按 NXP UM10204 与 M24C02 数据手册；对不合规的时序，模型按多数器件的「宽容」方式处理，并由解码器标出来。 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.STM32I2CSim = api;
})(typeof window === 'object' ? window : this, function () {
  'use strict';

  /* ===================== 总线 ===================== */
  function Bus(opt) {
    opt = opt || {};
    this.t = 0;                                         // 微秒
    this.opUs = opt.opUs != null ? opt.opUs : 0.05;     // 写一次 BSRR 的耗时（72 MHz 下几个周期）
    this.m = { scl: 1, sda: 1 };                        // 主机：1 = 松手，0 = 拉低
    this.devs = [];
    this.last = { scl: 1, sda: 1 };
    this.trace = [{ t: 0, scl: 1, sda: 1, ms: 1, ss: 1 }];
    this.maxPoints = opt.maxPoints || 20000;
  }
  Bus.prototype.attach = function (d) { this.devs.push(d); d.bus = this; return d; };
  Bus.prototype.slaveSda = function () { var v = 1; this.devs.forEach(function (d) { if (d.drive === 0) v = 0; }); return v; };
  Bus.prototype.levels = function () { return { scl: this.m.scl, sda: this.m.sda & this.slaveSda() }; };   // 线与
  Bus.prototype._rec = function (L) {
    if (this.trace.length >= this.maxPoints) throw new Error('trace too long');
    this.trace.push({ t: this.t, scl: L.scl, sda: L.sda, ms: this.m.sda, ss: this.slaveSda() });
  };
  Bus.prototype._settle = function () {
    for (var k = 0; k < 8; k++) {
      var L = this.levels(), P = this.last;
      if (L.scl === P.scl && L.sda === P.sda) { var tp = this.trace[this.trace.length - 1]; tp.ms = this.m.sda; tp.ss = this.slaveSda(); return; }
      this.last = L; this._rec(L);
      for (var i = 0; i < this.devs.length; i++) this.devs[i].onChange(P, L);
    }
  };
  Bus.prototype.set = function (line, v) { this.t += this.opUs; this.m[line] = v ? 1 : 0; this._settle(); };
  Bus.prototype.read = function () { this.t += this.opUs; return this.levels().sda; };
  Bus.prototype.wait = function (us) { this.t += us; this._tick(); };
  Bus.prototype._tick = function () { var t = this.t; this.devs.forEach(function (d) { if (d.tick) d.tick(t); }); };

  /* ===================== M24C02 ===================== */
  function M24C02(opt) {
    opt = opt || {};
    this.addr7 = opt.addr7 != null ? opt.addr7 : 0x50;
    this.tW = opt.tW != null ? opt.tW : 4000;            // 内部写周期（手册最长 5 ms），模型取 4 ms
    this.mem = []; for (var i = 0; i < 256; i++) this.mem.push(opt.fill != null ? opt.fill : 0xFF);
    this.ptr = 0; this.busyUntil = -1; this.drive = 1;
    this.st = 'idle'; this.bit = 0; this.sh = 0; this.rw = 0; this.wbuf = []; this.afterStart = false;
    this.log = [];                                      // 「EEPROM 听到了什么」
  }
  M24C02.prototype.busy = function () { return this.bus && this.bus.t < this.busyUntil; };
  M24C02.prototype._say = function (k, text) { this.log.push({ t: this.bus ? this.bus.t : 0, k: k, text: text }); };
  M24C02.prototype.onChange = function (P, L) {
    if (P.scl === 1 && L.scl === 1 && P.sda !== L.sda) { if (L.sda === 0) this._start(); else this._stop(); return; }
    if (P.scl === 0 && L.scl === 1) this._rise(L.sda);
    else if (P.scl === 1 && L.scl === 0) this._fall();
  };
  M24C02.prototype._start = function () {
    if (this.st === 'data' && this.wbuf.length) this._say('warn', '还没收到停止信号就又来了一个起始信号');
    this.st = 'addr'; this.bit = 0; this.sh = 0; this.drive = 1; this.afterStart = true;
  };
  M24C02.prototype._stop = function () {
    // 写入只由停止信号触发；起始后紧跟停止（中间没有任何数据位）时按宽容方式当作上一段的停止
    var writing = (this.st === 'data' || (this.afterStart && this.st === 'addr')) && this.wbuf.length;
    if (writing && !this.busy()) {
      var self = this;
      this.wbuf.forEach(function (w) { self.mem[w[0]] = w[1]; });
      this.busyUntil = this.bus.t + this.tW;
      this._say('write', '收到停止信号：开始内部写入 ' + this.wbuf.length + ' 个字节（约 ' + (this.tW / 1000) + ' ms，期间不应答）');
    }
    this.wbuf = []; this.st = 'idle'; this.drive = 1; this.afterStart = false; this.bit = 0;
  };
  M24C02.prototype._rise = function (sda) {
    if (this.afterStart) { this.afterStart = false; this.wbuf = []; }   // 新的一段真的开始了：上一段没写入的数据作废
    if (this.st === 'addr' || this.st === 'mem' || this.st === 'data') {
      if (this.bit < 8) this.sh = ((this.sh << 1) | sda) & 0xFF;
      this.bit++;
    } else if (this.st === 'tx') {
      if (this.bit === 8) this.mack = sda === 0;          // 第 9 个时钟：主机的应答
      this.bit++;
    }
  };
  M24C02.prototype._fall = function () {
    var st = this.st;
    if (st === 'addr' || st === 'mem' || st === 'data') {
      if (this.bit === 8) {                                // 8 位收齐：决定在第 9 个时钟要不要应答
        var ack = true;
        if (st === 'addr') {
          if ((this.sh >> 1) !== this.addr7) { ack = false; this.st = 'ignore'; this._say('nack', '地址 0x' + hx(this.sh) + ' 不是我（我是 0x' + hx(this.addr7 << 1) + ' / 0x' + hx((this.addr7 << 1) | 1) + '），不应答'); }
          else if (this.busy()) { ack = false; this.st = 'ignore'; this._say('nack', '正在内部写入，不应答'); }
          else { this.rw = this.sh & 1; this._say('ack', '地址对上了：' + (this.rw ? '主机要读' : '主机要写') + '，应答'); }
        } else if (st === 'mem') { this.ptr = this.sh; this._say('ack', '存储地址 0x' + hx(this.sh) + '，应答'); }
        else { this.wbuf.push([this.ptr, this.sh]); this._say('ack', '数据 0x' + hx(this.sh) + ' 暂存到页缓冲（地址 0x' + hx(this.ptr) + '），应答'); this.ptr = (this.ptr & 0xF0) | ((this.ptr + 1) & 0x0F); }
        if (ack) this.drive = 0;
      } else if (this.bit === 9) {                         // 第 9 个时钟结束：松开 SDA，进入下一个字节
        this.drive = 1; this.bit = 0; this.sh = 0;
        if (st === 'addr') { if (this.rw) { this.st = 'tx'; this._load(); } else this.st = 'mem'; }
        else if (st === 'mem') this.st = 'data';
      }
    } else if (st === 'tx') {
      if (this.bit >= 1 && this.bit <= 7) this.drive = (this.txb >> (7 - this.bit)) & 1;
      else if (this.bit === 8) this.drive = 1;             // 8 位发完：松开 SDA，让主机应答
      else if (this.bit === 9) {
        this.bit = 0;
        if (this.mack) this._load(); else { this.st = 'txdone'; this.drive = 1; this._say('info', '主机回了非应答：不再发送，松开 SDA'); }
      }
    }
  };
  M24C02.prototype._load = function () {
    this.txb = this.mem[this.ptr]; this._say('tx', '发送地址 0x' + hx(this.ptr) + ' 的内容 0x' + hx(this.txb));
    this.ptr = (this.ptr + 1) & 0xFF; this.bit = 0; this.drive = (this.txb >> 7) & 1;
  };

  function hx(v) { return ('0' + (v & 0xFF).toString(16).toUpperCase()).slice(-2); }

  /* ===================== 解码器：只看波形 ===================== */
  function decode(trace) {
    // 一位数据要等 SCL 再次变低才算数：SCL 高的时候如果 SDA 变了，那次时钟其实是起始 / 停止的准备，不是数据
    var ev = [], inTx = false, bits = [], nByte = 0, sinceStart = 0, pend = null;
    for (var i = 1; i < trace.length; i++) {
      var P = trace[i - 1], L = trace[i];
      if (P.scl === 1 && L.scl === 1 && P.sda !== L.sda) {
        pend = null;
        if (L.sda === 0) {
          if (inTx && bits.length) ev.push({ t: L.t, k: 'warn', text: '一个字节还没传完（才 ' + bits.length + ' 位）就出现了起始信号' });
          ev.push({ t: L.t, k: inTx ? 'Sr' : 'S' }); inTx = true; bits = []; nByte = 0; sinceStart = 0;
        } else {
          if (inTx && sinceStart === 0) ev.push({ t: L.t, k: 'warn', text: '起始信号后面紧跟停止信号（规范里叫「空报文」，是非法格式；很多器件能容忍）' });
          else if (inTx && bits.length) ev.push({ t: L.t, k: 'warn', text: '一个字节还没传完（才 ' + bits.length + ' 位）就出现了停止信号' });
          ev.push({ t: L.t, k: 'P' }); inTx = false; bits = [];
        }
        continue;
      }
      if (P.scl === 0 && L.scl === 1) { pend = { v: L.sda, t: L.t, by: L.ss === 0 ? 's' : 'm' }; continue; }
      if (P.scl === 1 && L.scl === 0 && pend) {
        var bt = pend; pend = null;
        if (!inTx) { ev.push({ t: bt.t, k: 'warn', text: '没有起始信号就出现了时钟' }); continue; }
        bits.push(bt); sinceStart++;
        ev.push({ t: bt.t, k: 'bit', v: bt.v, n: bits.length, by: bt.by });
        if (bits.length === 9) {
          var b = 0; for (var j = 0; j < 8; j++) b = (b << 1) | bits[j].v;
          nByte++;
          ev.push({ t: bits[0].t, t1: bits[7].t, k: 'byte', v: b, n: nByte, first: nByte === 1 });
          ev.push({ t: bt.t, k: bt.v === 0 ? 'A' : 'N', by: bt.by });
          bits = [];
        }
      }
    }
    return ev;
  }
  // 解码结果 → 一行行人能读懂的话
  function describe(ev) {
    var out = [], dir = 0;
    ev.forEach(function (e) {
      if (e.k === 'S') out.push('起始');
      else if (e.k === 'Sr') out.push('重复起始');
      else if (e.k === 'P') out.push('停止');
      else if (e.k === 'byte') {
        if (e.first) { dir = e.v & 1; out.push('地址 0x' + hx(e.v) + '（7 位地址 0x' + hx(e.v >> 1) + '，' + (dir ? '读' : '写') + '）'); }
        else out.push((dir ? '读到 ' : '写 ') + '0x' + hx(e.v));
      }
      else if (e.k === 'A') out.push('应答');
      else if (e.k === 'N') out.push('非应答');
      else if (e.k === 'warn') out.push('⚠ ' + e.text);
    });
    return out;
  }

  /* ===================== 时序检查（标准模式 100 kHz，UM10204 表 10） ===================== */
  var SPEC = [
    ['tLOW', 4.7, 'SCL 低电平'], ['tHIGH', 4.0, 'SCL 高电平'], ['tHD;STA', 4.0, '起始后保持'], ['tSU;STA', 4.7, '重复起始建立'],
    ['tSU;STO', 4.0, '停止建立'], ['tBUF', 4.7, '停止到下一次起始'], ['tSU;DAT', 0.25, '数据建立']
  ];
  function timing(trace) {
    var min = {}, inTx = false, lastFall = null, lastRise = null, lastStop = null, lastSdaChg = null, startAt = null;
    function put(k, v) { if (v == null || !(v >= 0)) return; if (min[k] == null || v < min[k]) min[k] = v; }
    for (var i = 1; i < trace.length; i++) {
      var P = trace[i - 1], L = trace[i];
      if (P.scl === 1 && L.scl === 1 && P.sda !== L.sda) {
        if (L.sda === 0) { if (inTx && lastRise != null) put('tSU;STA', L.t - lastRise); if (!inTx && lastStop != null) put('tBUF', L.t - lastStop); inTx = true; startAt = L.t; }
        else { if (lastRise != null) put('tSU;STO', L.t - lastRise); inTx = false; lastStop = L.t; }
        continue;
      }
      if (P.scl === 1 && L.scl === 0) { if (startAt != null) { put('tHD;STA', L.t - startAt); startAt = null; } if (inTx && lastRise != null) put('tHIGH', L.t - lastRise); lastFall = L.t; }
      if (P.scl === 0 && L.scl === 1) { if (inTx && lastFall != null) put('tLOW', L.t - lastFall); if (inTx && lastSdaChg != null && lastSdaChg > lastFall) put('tSU;DAT', L.t - lastSdaChg); lastRise = L.t; }
      if (P.scl === 0 && L.scl === 0 && P.sda !== L.sda) lastSdaChg = L.t;
    }
    return SPEC.map(function (s) { var v = min[s[0]]; return { k: s[0], name: s[2], spec: s[1], min: v == null ? null : Math.round(v * 100) / 100, ok: v == null || v >= s[1] - 1e-9 }; });
  }

  /* ===================== 程序执行器 =====================
     函数体：[{ op: [...] } | { loop: 8, body: [...] }]，每个 op：
       ['scl', v] ['sda', v]      写引脚（1 = 松手，0 = 拉低）
       ['delay']                  I2C_DELAY()，默认 5 µs；['us', n] ['ms', n]
       ['bit']                    SDA = 当前字节最高位；['shl'] 字节左移一位
       ['read', 'x']              x = SDA 的电平；['sample'] v = (v << 1) | SDA
       ['ret', 'x']               返回 x；['call', 名字, 参数]
       ['chk']                    上一次调用返回非 0（非应答）→ 跳到 ['label', 'end']
       ['label', 'end']           跳转点
       ['ifok']                   前面有过非应答就跳过这一行剩下的操作（if (!err) …）
       ['store', 'x']             x = 上一次调用的返回值；['out'] 把上一次调用的返回值记为结果（*out = …） */
  function run(fns, entry, opt) {
    opt = opt || {};
    var bus = opt.bus || new Bus(opt);
    if (!opt.bus && opt.device !== false) bus.attach(new M24C02(opt.eeprom));
    var dly = opt.delayUs != null ? opt.delayUs : 5, steps = 0, calls = [], out;
    function exec(name, arg, depth) {
      var f = fns[name]; if (!f) throw new Error('no function ' + name);
      if (depth > 8) throw new Error('too deep');
      var ctx = { b: arg != null ? arg & 0xFF : 0, v: 0, ret: undefined, jump: false };
      calls.push({ name: name, arg: arg, t: bus.t, depth: depth });
      var flat = [];
      (f.body || []).forEach(function (it) { if (it.loop) { for (var k = 0; k < it.loop; k++) it.body.forEach(function (x) { flat.push(x); }); } else flat.push(it); });
      for (var i = 0; i < flat.length; i++) {
        var ops = flat[i].op || [];
        if (ctx.jump && !(ops[0] && ops[0][0] === 'label')) continue;
        for (var j = 0; j < ops.length; j++) {
          if (++steps > 50000) throw new Error('too many steps');
          var o = ops[j], k = o[0];
          if (k === 'scl' || k === 'sda') bus.set(k, o[1]);
          else if (k === 'delay') bus.wait(dly);
          else if (k === 'us') bus.wait(o[1]);
          else if (k === 'ms') bus.wait(o[1] * 1000);
          else if (k === 'bit') bus.set('sda', (ctx.b & 0x80) ? 1 : 0);
          else if (k === 'shl') ctx.b = (ctx.b << 1) & 0xFF;
          else if (k === 'read') ctx[o[1]] = bus.read();
          else if (k === 'sample') ctx.v = ((ctx.v << 1) | bus.read()) & 0xFF;
          else if (k === 'ret') ctx.ret = ctx[o[1]];
          else if (k === 'call') ctx.last = exec(o[1], typeof o[2] === 'string' ? (opt.params || {})[o[2]] : o[2], depth + 1);
          else if (k === 'chk') { if (ctx.last) { ctx.jump = true; ctx.err = 1; break; } }
          else if (k === 'label') { ctx.jump = false; }
          else if (k === 'store') ctx[o[1]] = ctx.last;
          else if (k === 'out') out = ctx.last;
          else if (k === 'ifok') { if (ctx.err) break; }
        }
      }
      return ctx.ret !== undefined ? ctx.ret : ctx.err || 0;
    }
    var ret = exec(entry, opt.arg, 0);
    var dev = bus.devs[0] || null;
    return { bus: bus, trace: bus.trace, ev: decode(bus.trace), ret: ret, out: out, dev: dev, calls: calls };
  }

  return { Bus: Bus, M24C02: M24C02, decode: decode, describe: describe, timing: timing, run: run, hx: hx, SPEC: SPEC };
});
