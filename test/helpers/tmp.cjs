// 测试用的临时目录：等这个测试文件里的测试都收完尾（停状态进程、杀子进程）以后，进程退出时再删。
// 为什么不在 t.after 里删：node:test 的 t.after 按登记顺序跑，前一个钩子出错，后面的钩子都会被跳过。
// 临时目录总是最先建的，在 t.after 里删就抢在停进程之前：撞上还在写的进程报 ENOTEMPTY，后面停状态进程的钩子
// 被跳过，状态进程连着管道一直活着，测试进程退不出去，CI 就卡满 15 分钟（11-19 #181、#184 的 check）。
// 做法照 Node.js 自己的测试（nodejs/node test/common/tmpdir.js）：进程退出时用 maxRetries: 3 删；
// 删不掉只打一行提示、不算失败（留下的临时目录无害，算失败反而又成了偶发失败）。
'use strict';
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const dirs = [];
process.on('exit', () => {
  for (const d of dirs) {
    try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3 }); }
    catch (e) { process.stderr.write('临时目录没删干净（还有进程在写？）：' + d + ' ' + (e && e.code || e) + '\n'); }
  }
});
function tmpDir(prefix) { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); dirs.push(d); return d; }
module.exports = { tmpDir };
