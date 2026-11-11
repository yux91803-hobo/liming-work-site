// 测试里「等到某个条件」的时限都经过这里，像 Node.js 自己测试里的 common.platformTimeout(ms)
// （nodejs/node test/common/index.js：调试版、AIX、树莓派等慢环境按倍数放大时限）。
// 条件一满足就往下走，放大的只是「出错时多等多久才报失败」，正常通过不会变慢。
// CI 上（GitHub Actions 会设 CI=true）乘 3，和 Playwright 的 test.slow() 一样；本机不放大。
// XIN_TEST_TIMEOUT_SCALE 可以手动指定倍数。
// 背景：CI 自托管机器忙的时候，本机 1–4 秒的测试要 12 秒以上，写死的 15 秒时限会偶发超时（站长 2026-11-11）。
'use strict';
function timeoutScale() {
  const v = Number(process.env.XIN_TEST_TIMEOUT_SCALE);
  if (Number.isFinite(v) && v > 0) return v;
  return process.env.CI ? 3 : 1;
}
const platformTimeout = ms => Math.round(ms * timeoutScale());
module.exports = { platformTimeout, timeoutScale };
