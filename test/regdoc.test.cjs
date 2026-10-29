/* 寄存器面板「作用」：每个寄存器都有一段大白话说明，没有多余的 id */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.join(__dirname, '../site/tools/stm32');
const sb = { window: {} }; sb.window.window = sb.window; vm.createContext(sb);
['assets/registers.js', 'regdoc.js'].forEach((f) => vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), sb, { filename: f }));
const W = sb.window, ids = W.STM32_REGS.groups.flatMap((g) => g.regs.map((r) => r.id)), D = W.STM.regdoc.all;

test('每个寄存器都有「作用」说明，够详细', () => {
  ids.forEach((id) => {
    const t = W.STM.regdoc(id);
    assert.ok(t && t.length >= 40, id + ' 缺说明或太短');
    assert.doesNotMatch(t, /->|\|=|&=/, id + ' 说明里不写代码');
  });
});
test('说明里没有不存在的寄存器', () => {
  Object.keys(D).forEach((id) => assert.ok(ids.includes(id), id));
});
