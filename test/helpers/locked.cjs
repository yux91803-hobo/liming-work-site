// 测试里调控制器的 locked 操作，要和正式环境一样先拿锁（vm-agent.mjs 的 lockedCall：flock 锁文件 + XIN_LOCK）。
// 直接跑 `node vm-agent.mjs locked 操作` 等于没拿锁：后台进程真正拿着锁改任务记录（比如报会话号的 session_patch）时，
// 两边会交错读写、后写的把先写的盖掉。#133 的 CI 就因此偶尔丢了「到点那一刻站长的回答」（本地 12 次里 1 次）。
// 只有内部操作（vm-agent.mjs 的 iops）和 session_patch 由调用方先拿锁；公开操作（tasks、history 这些，在 ops 里）
// 自己会在里面拿锁，先拿了反而会自己等自己，照原样直接调。
// 选哪把锁照 vm-agent.mjs main()：对话自己的操作用对话编号那把锁，任务记录和调度一律用 tasks 锁。
const fs = require('node:fs'), path = require('node:path'), { spawnSync } = require('node:child_process');
const SESSION_OPS = ['send', 'session_patch', 'run_complete', 'continue_steers'];
let internal = null;
function internalOps(agent) {
  if (internal) return internal;
  const src = fs.readFileSync(agent, 'utf8'), start = src.indexOf('\nconst iops = {'), end = src.indexOf('\n};', start);
  if (start < 0 || end < 0) throw Error('vm-agent.mjs 里找不到 iops');
  internal = new Set([...src.slice(start, end).matchAll(/\b([a-z][a-z_]*)\s*(?:\(a\)|:\s*[a-zA-Z(])/g)].map(m => m[1]).concat('session_patch'));
  return internal;
}
function lockKey(home, op, args) {
  const sid = args && args.sid;
  if (!SESSION_OPS.includes(op) || !sid) return 'tasks';
  try { return JSON.parse(fs.readFileSync(path.join(home, 'sessions', sid + '.json'), 'utf8')).kind === 'task' ? 'tasks' : sid; }
  catch { return sid; }
}
// 用法和 spawnSync(process.execPath, [agent, 'locked', op], opts) 一样；opts.env 里要有 XIN_HOME
function lockedSpawn(agent, op, args, opts) {
  const env = opts.env || process.env, input = JSON.stringify(args || {});
  if (!internalOps(agent).has(op)) return spawnSync(process.execPath, [agent, 'locked', op], { ...opts, input });
  const home = env.XIN_HOME, key = lockKey(home, op, args || {});
  fs.mkdirSync(path.join(home, 'locks'), { recursive: true });
  return spawnSync('flock', ['--exclusive', '--timeout', '20', '--close', path.join(home, 'locks', key + '.lock'), process.execPath, agent, 'locked', op],
    { ...opts, env: { ...env, XIN_LOCK: key }, input });
}
module.exports = { lockedSpawn, lockKey, internalOps };
