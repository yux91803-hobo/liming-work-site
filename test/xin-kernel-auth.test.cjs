// 小芯内核的第二层认证：Worker 签名（src/xin-kernel.js），内核校验（site/xin/vm-kernel.mjs），两边必须对得上。
// 设计见 docs/xin-kernel-design.md §14.5。
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');

const load = rel => import(pathToFileURL(path.join(__dirname, rel)).href);
const KEY_A = Buffer.alloc(32, 1).toString('base64url'), KEY_B = Buffer.alloc(32, 2).toString('base64url');
const NOW = 1794550000000;

function keysFile(keys) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-kauth-')), file = path.join(dir, 'kernel-keys.json');
  fs.writeFileSync(file, JSON.stringify({ v: 1, keys }), { mode: 0o600 });
  return { dir, file };
}
async function setup(keys = { ka: KEY_A }) {
  const kernel = await load('../site/xin/vm-kernel.mjs'), worker = await load('../src/xin-kernel.js');
  const { dir, file } = keysFile(keys);
  const ring = new kernel.KeyRing(file), nonces = new kernel.NonceStore(path.join(dir, 'kernel.sqlite'));
  const verify = (header, o = {}) => kernel.verifyRequest({ method: 'POST', target: '/xin/op', body: '{"op":"ping"}', keys: ring.keys(), nonces, now: NOW, header, ...o });
  const sign = (o = {}) => worker.signKernelRequest({ key: KEY_A, kid: 'ka', method: 'POST', target: '/xin/op', body: '{"op":"ping"}', now: NOW, ...o });
  return { kernel, worker, dir, file, ring, nonces, verify, sign };
}

test('Worker 签的请求内核认得', async () => {
  const { verify, sign } = await setup();
  assert.deepStrictEqual(verify(await sign()), { ok: true, kid: 'ka' });
});

test('改了任何一处都不认', async () => {
  const { verify, sign } = await setup();
  assert.strictEqual(verify(await sign(), { method: 'GET' }).reason, 'bad_sig');
  assert.strictEqual(verify(await sign({ target: '/xin/stream?run=r1' }), { target: '/xin/stream?run=r2' }).reason, 'bad_sig');
  assert.strictEqual(verify(await sign(), { body: '{"op":"pinG"}' }).reason, 'bad_sig');
  // 篡改头里的 ts：签名不再对得上
  const h = (await sign()).replace('ts=' + NOW, 'ts=' + (NOW + 1));
  assert.strictEqual(verify(h).reason, 'bad_sig');
  assert.strictEqual(verify(await sign({ now: NOW - 300001 })).reason, 'expired');
  assert.strictEqual(verify(await sign({ now: NOW + 300001 })).reason, 'expired');
  assert.strictEqual(verify(await sign({ kid: 'kz' })).reason, 'unknown_kid');
  assert.strictEqual(verify('').reason, 'missing');
  assert.strictEqual(verify(undefined).reason, 'missing');
  assert.strictEqual(verify('Basic abc').reason, 'malformed');
});

test('同一个签名只认一次，内核重启后也认得', async () => {
  const { kernel, dir, verify, sign } = await setup();
  const h = await sign();
  assert.strictEqual(verify(h).ok, true);
  assert.strictEqual(verify(h).reason, 'replay');
  const restarted = new kernel.NonceStore(path.join(dir, 'kernel.sqlite'));
  assert.strictEqual(verify(h, { nonces: restarted }).reason, 'replay');
  // 超过 600 秒的随机数会被清掉，但那时时间戳早已过期，照样不认
  assert.strictEqual(verify(h, { nonces: restarted, now: NOW + 700000 }).reason, 'expired');
});

test('签名不对不消耗随机数', async () => {
  const { verify, sign } = await setup();
  const nonce = Buffer.alloc(16, 9).toString('base64url');
  const bad = await sign({ nonce, body: 'other' });
  assert.strictEqual(verify(bad).reason, 'bad_sig');
  assert.strictEqual(verify(await sign({ nonce })).ok, true);
});

test('钥匙文件换了会重读，新旧两把都认；软链接不认', async () => {
  const { file, ring, verify, sign } = await setup();
  assert.strictEqual(verify(await sign({ kid: 'kb', key: KEY_B })).reason, 'unknown_kid');
  fs.writeFileSync(file, JSON.stringify({ v: 1, keys: { ka: KEY_A, kb: KEY_B } }), { mode: 0o600 });
  const later = new Date(Date.now() + 5000); fs.utimesSync(file, later, later);   // 确保修改时间变了
  assert.strictEqual(verify(await sign({ kid: 'kb', key: KEY_B }), { keys: ring.keys() }).ok, true);
  assert.strictEqual(verify(await sign(), { keys: ring.keys() }).ok, true);
  const real = file + '.real'; fs.renameSync(file, real); fs.symlinkSync(real, file);
  const again = new Date(Date.now() + 10000); fs.lutimesSync(file, again, again);
  assert.strictEqual(ring.keys().size, 0);
});

test('钥匙文件不存在或坏了：没有钥匙，不抛错', async () => {
  const kernel = await load('../site/xin/vm-kernel.mjs');
  assert.strictEqual(new kernel.KeyRing(path.join(os.tmpdir(), 'no-such-dir-xin', 'k.json')).keys().size, 0);
  const { file } = keysFile({}); fs.writeFileSync(file, '{oops');
  assert.strictEqual(new kernel.KeyRing(file).keys().size, 0);
});

test('端口号两边一致', async () => {
  const kernel = await load('../site/xin/vm-kernel.mjs'), worker = await load('../src/xin-kernel.js');
  assert.strictEqual(kernel.KERNEL_PORT, 8797);
  assert.strictEqual(worker.KERNEL_PORT, 8797);
});

test('脱敏：两边规则相同，秘密都去掉', async () => {
  const kernel = await load('../site/xin/vm-kernel.mjs'), worker = await load('../src/xin-kernel.js');
  const input = 'x ibp_AbC-1 Bearer tok sig=zz, ibk_q end';
  const a = kernel.redact(input), b = worker.redact(input);
  assert.strictEqual(a, b);
  for (const secret of ['AbC', 'tok', 'zz', 'ibk_q']) assert.ok(!a.includes(secret), secret);
  assert.ok(a.startsWith('x ') && a.endsWith(' end'));
  assert.strictEqual(kernel.redact(undefined), '');
});

test('签名头的格式：kid、ts、nonce、sig 四项', async () => {
  const { kernel, sign } = await setup();
  const h = await sign({ nonce: 'AAAAAAAAAAAAAAAAAAAAAA' });
  assert.match(h, /^XinKernel-HMAC-SHA256 kid=ka,ts=1794550000000,nonce=AAAAAAAAAAAAAAAAAAAAAA,sig=[A-Za-z0-9_-]{43}$/);
  assert.deepStrictEqual(Object.keys(kernel.parseAuth(h)).sort(), ['kid', 'nonce', 'sig', 'ts']);
  // 被签的字符串：独立算一遍 HMAC，和头里的 sig 一样
  const bodySha = crypto.createHash('sha256').update('{"op":"ping"}').digest('hex');
  const str = ['xin-kernel-v1', 'POST', '/xin/op', '1794550000000', 'AAAAAAAAAAAAAAAAAAAAAA', bodySha].join('\n');
  const want = crypto.createHmac('sha256', Buffer.from(KEY_A, 'base64url')).update(str).digest('base64url');
  assert.strictEqual(kernel.parseAuth(h).sig, want);
});
