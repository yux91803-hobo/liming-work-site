'use strict';
// 状态进程启动前扫一遍 /proc：同一目录、同一个 XIN_HOME 下还有没接状态桥的旧控制器，就拒绝启动（state_compat）。
// 别的控制器正好在退出时，内核已经收走它的内存映射；Linux v6.18 起这样的进程 /proc 下的文件归 root
// （fs/proc/base.c 的 task_dump_owner），普通用户读它的 environ 被拒（EACCES），较新的内核可能读出空内容。
// 以前这会被当成「核对不了旧控制器」而拒绝启动：#143 合并后的正式运行 43627096116 就这样红了一项。
// 正在退出或已经是僵尸的进程不会再写状态，不算旧控制器；还活着却核对不了的，照旧拒绝。
// 用假的 /proc 目录：测试可能以 root 运行，root 不受文件权限限制，造不出 EACCES，所以把 environ 做成目录让读取失败。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '../site/xin/vm-kernel-compat.mjs')).href);
const RUNNING = 0x400100, EXITING = 0x400104;   // /proc/<pid>/stat 第 9 项 flags；0x4 是 PF_EXITING

// 一个用 node 跑 vm-agent.mjs、没接状态桥的控制器。environ：'unreadable' 读取失败，'' 读出空内容
function fakeProc(t, { state, flags = RUNNING, stat = true, environ = 'unreadable' }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-compat-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const site = path.join(dir, 'site'), proc = path.join(dir, 'proc'), pid = '4242';
  fs.mkdirSync(site); fs.mkdirSync(path.join(proc, pid), { recursive: true });
  const agent = path.join(site, 'vm-agent.mjs');
  fs.writeFileSync(agent, '// 旧控制器，没有接状态桥\n');
  fs.writeFileSync(path.join(proc, pid, 'cmdline'), ['/usr/bin/node', agent, 'send', ''].join('\0'));
  if (environ === 'unreadable') fs.mkdirSync(path.join(proc, pid, 'environ'));
  else fs.writeFileSync(path.join(proc, pid, 'environ'), environ);
  if (stat) fs.writeFileSync(path.join(proc, pid, 'stat'), `${pid} (node) ${state} 1 ${pid} ${pid} 0 -1 ${flags} 0 0 0 0 0 0 0 0 20 0 1 0 100 0 0\n`);
  // environ 读出空内容时，控制器按读的人自己的家目录算 XIN_HOME（和 vm-agent 自己的默认一样）
  return { home: environ === '' ? path.join(os.homedir(), '.xin') : path.join(dir, 'xin'), self: agent, proc };
}
const blocked = { code: 'state_compat' };

test('旧控制器读不到 environ、已经是僵尸：不拦，状态进程照常启动', async t => {
  const { checkControllers } = await load(), f = fakeProc(t, { state: 'Z' });
  assert.doesNotThrow(() => checkControllers(f.home, f.self, { proc: f.proc }));
});

test('旧控制器读不到 environ、还没成僵尸但 flags 带 PF_EXITING（正在退出）：不拦', async t => {
  const { checkControllers } = await load(), f = fakeProc(t, { state: 'R', flags: EXITING });
  assert.doesNotThrow(() => checkControllers(f.home, f.self, { proc: f.proc }));
});

test('读 environ 时进程已经被回收（stat 也没了）：不拦', async t => {
  const { checkControllers } = await load(), f = fakeProc(t, { stat: false });
  assert.doesNotThrow(() => checkControllers(f.home, f.self, { proc: f.proc }));
});

test('旧控制器还活着却读不到 environ：照旧拒绝启动', async t => {
  const { checkControllers } = await load(), f = fakeProc(t, { state: 'S' });
  assert.throws(() => checkControllers(f.home, f.self, { proc: f.proc }), blocked);
});

test('environ 读出空内容、没有桥标记：正在退出就不拦，还活着照旧拒绝', async t => {
  const { checkControllers } = await load();
  const gone = fakeProc(t, { state: 'Z', environ: '' }), alive = fakeProc(t, { state: 'S', environ: '' });
  assert.doesNotThrow(() => checkControllers(gone.home, gone.self, { proc: gone.proc }));
  assert.throws(() => checkControllers(alive.home, alive.self, { proc: alive.proc }), blocked);
});
