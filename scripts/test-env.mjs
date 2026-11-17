// 测试进程的环境：整套测试默认碰不到执行机器上的 systemd（用户总线、scope、清理定时器）。
// 照 git 的 t/test-lib.sh：GIT_TEST_MAINT_SCHEDULER="none:exit 1"——不让测试碰真的定时任务、永久改动用户的系统；
// 要测 systemd 的测试自己另设 XIN_SYSTEMD_BUS（xin-kernel、xin-reaper 就是这样）。
// 指向一个不存在、但和真的总线一样以 /bus 结尾的路径：按形状判断的测试替身照常工作。
export const NO_USER_BUS = '/nonexistent/xin-tests-no-user-session/bus';

export function hermeticTestEnv(env = process.env) {
  return { ...env, XIN_SYSTEMD_BUS: NO_USER_BUS };
}
