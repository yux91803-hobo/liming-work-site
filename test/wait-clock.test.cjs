'use strict';
// 测试里「等到某个条件」的时限用单调时钟（performance.now），不用墙上时钟（Date.now）。
// CI 的自托管机器会被暂停或校时，墙上时钟一下往前跳几十秒；用 Date.now 算的时限会在条件满足之前就到期，
// 测试报「没做完」，其实一秒都没多等（#142 两项、#143 一项，都是这样红的）。
// 单调时钟不受校时影响；时限的数值和 platformTimeout 的倍数都不变。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const files = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(path.join(dir, e.name)) : /\.cjs$/.test(e.name) ? [path.join(dir, e.name)] : []);
// 这几种写法都算：时限由 Date.now() 加 platformTimeout 得出；拿 Date.now() 去和时限变量比（两个方向）；
// 用 Date.now() - t0 量「过了多久」
const WALL = [
  /Date\.now\(\)\s*\+\s*platformTimeout\(/,
  /Date\.now\(\)\s*[<>]=?\s*(end|until|deadline)\b/,
  /\b(end|until|deadline)\s*[<>]=?\s*Date\.now\(\)/,
  /Date\.now\(\)\s*-\s*t0\b/
];
const wallClockWaits = text => text.split('\n').flatMap((line, i) => WALL.some(re => re.test(line)) ? [i + 1] : []);

test('扫描认得出用墙上时钟算时限、量耗时的几种写法，也不误报单调时钟和普通的时间戳', () => {
  assert.deepStrictEqual(wallClockWaits('for (const end = Date.now() + platformTimeout(15000); Date.now() < end;) {}'), [1]);
  assert.deepStrictEqual(wallClockWaits('const until=Date.now()+platformTimeout(5000);\nlet v;\nwhile(Date.now()<until) v=1;'), [1, 3]);
  assert.deepStrictEqual(wallClockWaits('const deadline = start + 3000;\nif (deadline > Date.now()) again();'), [2]);
  assert.deepStrictEqual(wallClockWaits('if (Date.now() > deadline) reject(Error("timeout"));'), [1]);
  assert.deepStrictEqual(wallClockWaits('const t0 = Date.now();\nwork();\nassert.ok(Date.now() - t0 < 3000);'), [3]);
  assert.deepStrictEqual(wallClockWaits('const t0 = performance.now(); assert.ok(performance.now() - t0 < 3000);'), []);
  assert.deepStrictEqual(wallClockWaits('for (const end = performance.now() + platformTimeout(15000); performance.now() < end;) {}'), []);
  assert.deepStrictEqual(wallClockWaits('const later = new Date(Date.now() + 5000); const started = Date.now();'), []);
});

test('测试里等条件的时限不用墙上时钟：机器被暂停或校时后不会提前判超时', () => {
  const self = path.basename(__filename), bad = [];
  for (const f of files(__dirname)) {
    if (path.basename(f) === self) continue;
    for (const n of wallClockWaits(fs.readFileSync(f, 'utf8'))) bad.push(path.relative(__dirname, f) + ':' + n);
  }
  assert.deepStrictEqual(bad, [], '这些地方的时限改用 performance.now()');
});
