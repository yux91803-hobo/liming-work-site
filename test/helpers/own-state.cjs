// 测试进程（或它起的脚本子进程）自己当主人（docs/superpowers/plans/2026-11-18-xin-remove-legacy.md Task A2）。
// 给「直接调控制器模块、不起控制器子进程」的测试用：这些代码在正式环境里跑在常驻状态进程里，
// 状态进程就是拿着所有权写库的那一个；旧模式删掉以后，不是主人的进程不能写库。
// 锁是 owner.sqlite 的独占锁，进程退出时跟着放掉。
// 同一个 XIN_HOME 已经起了真的状态进程（state-mode.cjs）时不能再拿：那时脚本当普通客户端，写库经套接字交给它。
//   ownState()：测试进程自己当主人。
//   OWN_IMPORT：起脚本子进程时放在参数最前面（node --import …），子进程加载控制器模块之前就拿到所有权。
const path = require('node:path'), { pathToFileURL } = require('node:url');
const BASE = pathToFileURL(path.join(__dirname, '../../site/xin/vm-base.mjs')).href;
const OWN_IMPORT = ['--import', pathToFileURL(path.join(__dirname, 'own-state-preload.mjs')).href];
async function ownState() {
  const { ownership } = await import(BASE);
  if (!ownership.owning) ownership.take({ waitMs: 5000 });
  return ownership;
}
module.exports = { ownState, OWN_IMPORT };
