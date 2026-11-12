#!/usr/bin/env node
// 离线解开小芯的机外备份（docs/xin-reliability-usage-design.md 的 C 部分）。
// 站长改过登录密码以后，网页上解不开以前的备份：登录后打开 /api/xin/backup?date=YYYY-MM-DD&raw=1 下载加密原件，再用当时的密码解：
//   XIN_BACKUP_PASSWORD='当时的登录密码' node scripts/xin-backup-decrypt.mjs xin-state-20261112.backup xin-state-20261112.tar.gz
// 加密原件：第一行是参数 JSON（日期、大小、sha256、盐、IV），换行后是 AES-GCM 密文（二进制）。
// 解出来是一个 tar.gz：新云电脑上解进空的 ~/.xin（tar xzf … -C ~/.xin）就恢复了，网关密钥另配。
import fs from 'node:fs';
import { webcrypto as crypto, createHash } from 'node:crypto';

const [input, output] = process.argv.slice(2);
const password = process.env.XIN_BACKUP_PASSWORD || '';
if (!input || !output || !password) {
  console.error('用法：XIN_BACKUP_PASSWORD=登录密码 node scripts/xin-backup-decrypt.mjs <加密原件.backup> <输出.tar.gz>');
  process.exit(2);
}
const file = fs.readFileSync(input), nl = file.indexOf(0x0a);
let rec = null;
try { rec = nl > 0 ? JSON.parse(file.subarray(0, nl).toString('utf8')) : null; } catch { rec = null; }
if (!rec || rec.alg !== 'AES-256-GCM' || rec.kdf !== 'HKDF-SHA256' || !rec.salt || !rec.iv || file.length <= nl + 1) { console.error('这不是小芯的备份原件'); process.exit(2); }
const data = file.subarray(nl + 1);
const bytes = s => Uint8Array.from(Buffer.from(s, 'base64'));
const ikm = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'HKDF', false, ['deriveKey']);
const key = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: bytes(rec.salt), info: new TextEncoder().encode(rec.info) }, ikm, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
let plain;
try { plain = Buffer.from(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes(rec.iv) }, key, data)); }
catch { console.error('密码不对：解不开这份备份（要用备份那天的登录密码）'); process.exit(1); }
if (createHash('sha256').update(plain).digest('hex') !== rec.sha256) { console.error('解出来的内容和备份记录对不上'); process.exit(1); }
fs.writeFileSync(output, plain, { mode: 0o600 });
console.log('已解开：' + output + '（' + plain.length + ' 字节，' + rec.date + '）');
