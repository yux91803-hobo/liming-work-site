'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const js = fs.readFileSync(path.join(root, 'site/mascot.js'), 'utf8');
const block = js.match(/  var FACE = \{[\s\S]*?\n  \};/);
assert.ok(block, '小芯的表情图案存在');
const FACE = vm.runInNewContext(block[0] + '\nFACE');

test('视线移动时，像素折线保持镜像且不会碰到机身内框', () => {
  for (const lx of [-1, 0, 1]) for (const ly of [-1, 0, 1]) {
    const pixels = FACE.eyes(lx, ly), half = pixels.length / 2;
    assert.ok(half >= 3);
    for (const [x, y, w, h] of pixels) {
      assert.ok(x >= 5.2 && x + w <= 14.8, '眼睛水平位于内框内');
      assert.ok(y >= 7.3 && y + h <= 14.8, '眼睛垂直位于内框内');
      assert.ok(w > 0 && h > 0 && w === h, '折线由正方形像素组成');
    }
    for (let i = 0; i < half; i++) {
      const a = pixels[i], b = pixels[i + half];
      assert.ok(Math.abs(a[0] + a[2] + b[0] - (20 + lx * .7)) < 1e-9, '两眼相对视线中心镜像');
      assert.equal(a[1], b[1]);
    }
    const left = pixels.slice(0, half);
    assert.ok(left[0][0] < left[Math.floor(half / 2)][0], '左眼朝右折');
    assert.equal(left[0][0], left[half - 1][0], '折线的上下两端对齐');
  }
});
test('眨眼是细横线，六种参考表情及原有特殊表情均可绘制', () => {
  for (const lx of [-1, 0, 1]) for (const ly of [-1, 0, 1]) {
    const closed = FACE.blink(lx, ly);
    assert.equal(closed.length, 2);
    assert.ok(closed.every(p => p[2] > p[3] * 4));
  }
  for (const mood of ['focus', 'calm', 'love', 'hap', 'shut', 'dz', 'wow', 'sad', 'scared', 'confused', 'angry', 'cry', 'pout', 'tongue', 'back', 'side']) {
    assert.ok(FACE[mood], mood + ' 未丢失');
  }
});
test('机身、头像与收起的小脑袋复用画法，独立的渐变不会串色', () => {
  const start = js.indexOf('  var LEG_X'), end = js.indexOf('  var layer =');
  const draw = vm.runInNewContext(js.slice(start, end) + '\ndraw');
  for (const face of Object.keys(FACE)) {
    for (const b of [0, 1, 2]) {
      const svg = draw({ face, b, armL: 'out', armR: 'wave' }, 'test');
      assert.doesNotMatch(svg, /NaN|undefined|Infinity/);
      assert.match(svg, /id="test-pin"/);
      assert.match(svg, /id="test-glass"/);
      assert.match(svg, /url\(#test-pin\)/);
      assert.equal(/c-ew/.test(svg), face !== 'back');
    }
  }
  assert.match(draw({ face: 'eyes' }, 'portrait-2'), /id="portrait-2-pin"/);
  assert.doesNotMatch(draw({ face: 'eyes' }, 'portrait-2'), /id="test-pin"/);
});
