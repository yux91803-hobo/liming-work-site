// I2C 教学模拟器：总线、M24C02 模型、解码器、时序检查、程序执行器
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../site/tools/stm32/i2csim.js');

const L = (...ops) => ({ op: ops });
const F = {
  start: { body: [L(['sda', 1]), L(['scl', 1]), L(['delay']), L(['sda', 0]), L(['delay']), L(['scl', 0])] },
  stop: { body: [L(['sda', 0]), L(['delay']), L(['scl', 1]), L(['delay']), L(['sda', 1]), L(['delay'])] },
  send: { body: [{ loop: 8, body: [L(['bit']), L(['shl']), L(['delay']), L(['scl', 1]), L(['delay']), L(['scl', 0])] }] },
  wack: { body: [L(['sda', 1]), L(['delay']), L(['scl', 1]), L(['delay']), L(['read', 'n']), L(['scl', 0]), L(['ret', 'n'])] },
  rbyte: { body: [L(['sda', 1]), { loop: 8, body: [L(['delay']), L(['scl', 1]), L(['delay']), L(['sample']), L(['scl', 0])] }, L(['ret', 'v'])] },
  nack: { body: [L(['sda', 1]), L(['delay']), L(['scl', 1]), L(['delay']), L(['scl', 0])] },
  write: { body: [L(['call', 'start']), L(['call', 'send', 0xA0]), L(['call', 'wack'], ['chk']), L(['call', 'send', 'mem']), L(['call', 'wack'], ['chk']), L(['call', 'send', 'data']), L(['call', 'wack'], ['chk']), L(['label', 'end']), L(['call', 'stop']), L(['ms', 5])] },
  read: { body: [L(['call', 'start']), L(['call', 'send', 0xA0]), L(['call', 'wack'], ['chk']), L(['call', 'send', 'mem']), L(['call', 'wack'], ['chk']), L(['call', 'start']), L(['call', 'send', 0xA1]), L(['call', 'wack'], ['chk']), L(['call', 'rbyte']), L(['store', 'r']), L(['call', 'nack']), L(['label', 'end']), L(['call', 'stop']), L(['ret', 'r'])] },
};

test('线与：任何一方拉低就是 0，都松手才是 1', () => {
  const bus = new S.Bus();
  const dev = bus.attach(new S.M24C02());
  assert.equal(bus.levels().sda, 1);
  dev.drive = 0; assert.equal(bus.levels().sda, 0);
  bus.m.sda = 0; dev.drive = 1; assert.equal(bus.levels().sda, 0);
  bus.m.sda = 1; assert.equal(bus.levels().sda, 1);
});

test('写一个字节：波形解码正确、停止后才真正写入', () => {
  const bus = new S.Bus(); const dev = bus.attach(new S.M24C02());
  const r = S.run({ ...F, write: { body: F.write.body.slice(0, -2) } }, 'write', { bus, params: { mem: 0x12, data: 0x5A } });
  assert.equal(r.ret, 0);
  assert.equal(dev.mem[0x12], 0xFF, '还没有停止信号，不应写入');
  S.run(F, 'stop', { bus });
  assert.equal(dev.mem[0x12], 0x5A);
  assert.deepEqual(S.describe(S.decode(bus.trace)), ['起始', '地址 0xA0（7 位地址 0x50，写）', '应答', '写 0x12', '应答', '写 0x5A', '应答', '停止']);
});

test('应答位由从机拉低（解码器能分辨是谁拉的）', () => {
  const r = S.run(F, 'write', { params: { mem: 1, data: 2 } });
  const acks = r.ev.filter(e => e.k === 'A');
  assert.equal(acks.length, 3);
  assert.ok(acks.every(a => a.by === 's'));
});

test('5 µs 延时满足标准模式全部最小时间', () => {
  const r = S.run(F, 'write', { params: { mem: 1, data: 2 } });
  const t = S.timing(r.trace);
  for (const x of t) if (x.min != null) assert.ok(x.ok, x.k + ' = ' + x.min);
  assert.ok(t.find(x => x.k === 'tLOW').min >= 4.7);
});

test('2 µs 延时：SCL 低电平不够 4.7 µs，时序检查能指出来', () => {
  const r = S.run(F, 'write', { params: { mem: 1, data: 2 }, delayUs: 2 });
  const bad = S.timing(r.trace).filter(x => !x.ok).map(x => x.k);
  assert.ok(bad.includes('tLOW'));
});

test('随机读：先写存储地址，再重复起始读', () => {
  const bus = new S.Bus(); const dev = bus.attach(new S.M24C02());
  dev.mem[0x40] = 0xC3;
  const r = S.run(F, 'read', { bus, params: { mem: 0x40 } });
  assert.equal(r.ret, 0xC3);
  const d = S.describe(r.ev);
  assert.ok(d.includes('重复起始'));
  assert.ok(d.includes('读到 0xC3'));
  assert.equal(d[d.length - 2], '非应答');   // 主机对最后一个字节回非应答
});

test('没有器件：地址字节收到的是非应答（上拉把线留在 1）', () => {
  const r = S.run(F, 'write', { device: false, params: { mem: 1, data: 2 } });
  assert.equal(r.ret, 1);
  assert.deepEqual(S.describe(r.ev), ['起始', '地址 0xA0（7 位地址 0x50，写）', '非应答', '停止']);
});

test('地址不对：器件不应答', () => {
  const bus = new S.Bus(); const dev = bus.attach(new S.M24C02({ addr7: 0x51 }));
  const r = S.run(F, 'write', { bus, params: { mem: 1, data: 2 } });
  assert.equal(r.ret, 1);
  assert.match(dev.log[dev.log.length - 1].text, /不是我/);
});

test('写周期内不应答；等够时间再来就应答（应答轮询的依据）', () => {
  const bus = new S.Bus(); const dev = bus.attach(new S.M24C02());
  S.run({ ...F, write: { body: F.write.body.slice(0, -1) } }, 'write', { bus, params: { mem: 3, data: 7 } });
  const r1 = S.run(F, 'read', { bus, params: { mem: 3 } });
  assert.equal(r1.ret, 1);
  assert.match(dev.log[dev.log.length - 1].text, /内部写入/);
  bus.wait(5000);
  const r2 = S.run(F, 'read', { bus, params: { mem: 3 } });
  assert.equal(r2.ret, 7);
});

test('页内回卷：从 0x0C 连写 6 个，后两个回到本页开头', () => {
  const body = [L(['call', 'start']), L(['call', 'send', 0xA0]), L(['call', 'wack']), L(['call', 'send', 0x0C]), L(['call', 'wack'])]
    .concat([1, 2, 3, 4, 5, 6].map(v => L(['call', 'send', v], ['call', 'wack']))).concat([L(['call', 'stop'])]);
  const bus = new S.Bus(); const dev = bus.attach(new S.M24C02());
  S.run({ ...F, pw: { body } }, 'pw', { bus });
  assert.deepEqual([0x0C, 0x0D, 0x0E, 0x0F, 0x00, 0x01, 0x10].map(a => dev.mem[a]), [1, 2, 3, 4, 5, 6, 0xFF]);
});

test('停止信号顺序写反（先抬 SCL 再拉低 SDA）：解码器标出空报文', () => {
  const C = { ...F, stop: { body: [L(['scl', 1]), L(['sda', 0]), L(['delay']), L(['sda', 1]), L(['delay'])] } };
  const r = S.run(C, 'write', { params: { mem: 0x20, data: 0x33 } });
  const d = S.describe(r.ev);
  assert.ok(d.includes('重复起始'));
  assert.ok(d.some(s => /空报文/.test(s)));
});

test('没有起始就打时钟：解码器警告', () => {
  const r = S.run({ x: { body: [L(['scl', 0]), L(['delay']), L(['scl', 1]), L(['delay']), L(['scl', 0])] } }, 'x', {});
  assert.ok(S.describe(r.ev).some(s => /没有起始/.test(s)));
});

test('SCL 高的时候改 SDA：被当成起始 / 停止', () => {
  // 发送函数里把「改 SDA」放到 SCL 高之后
  const bad = { ...F, send: { body: [{ loop: 8, body: [L(['scl', 1]), L(['bit']), L(['shl']), L(['delay']), L(['scl', 0]), L(['delay'])] }] } };
  const r = S.run(bad, 'write', { params: { mem: 0x00, data: 0xFF } });
  const ks = r.ev.map(e => e.k);
  assert.ok(ks.filter(k => k === 'P' || k === 'Sr').length > 1);
});
