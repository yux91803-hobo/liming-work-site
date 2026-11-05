'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const js = fs.readFileSync(path.join(root, 'site/mascot.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'site/mascot.css'), 'utf8');
const block = js.match(/  var FACE = \{[\s\S]*?\n  \};/);
assert.ok(block, '小芯的表情图案存在');
const FACE = vm.runInNewContext(block[0] + '\nFACE');

test('默认眼睛保持 > < 像素折线并能随视线移动', () => {
  for (const lx of [-1, 0, 1]) for (const ly of [-1, 0, 1]) {
    const pixels = FACE.eyes(lx, ly);
    assert.equal(pixels.length, 10);
    for (const [x, y] of pixels) {
      assert.ok(x >= 5 && x <= 14, '眼睛水平位于芯片面板内');
      assert.ok(y >= 7 && y <= 12, '眼睛垂直位于芯片面板内');
    }
    for (let i = 0; i < 5; i++) {
      assert.equal(pixels[i][0] + pixels[i + 5][0], 19 + 2 * lx, '两眼镜像对称');
      assert.equal(pixels[i][1], pixels[i + 5][1], '两眼位于同一高度');
    }
  }
});
test('眨眼仍使用窄横条，原有特殊表情保留', () => {
  assert.equal(FACE.blink(0, 0).length, 2);
  assert.ok(FACE.blink(0, 0).every(p => p[2] === 3 && p[3] === 1));
  for (const mood of ['hap', 'shut', 'dz', 'wow', 'sad', 'scared', 'confused', 'angry', 'cry', 'pout', 'tongue', 'back', 'side']) {
    assert.ok(FACE[mood], mood + ' 未丢失');
  }
});
test('眼睛发光和腮红在浅色、深色主题都有样式', () => {
  assert.match(css, /\.xin \.c-ew\{fill:var\(--xe\)/);
  assert.match(css, /\.xin \.c-rose\{fill:var\(--xr\)/);
  assert.match(css, /\[data-theme=dark\] \.xin\{[^\n]+--xe:/);
  assert.match(js, /R\(6 \+ sx, 13 \+ b, 2, 1, 'rose'\)/);
  assert.match(js, /if \(blinking && p\.face === 'eyes'\) p\.face = 'blink'/);
});
