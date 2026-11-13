const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');

// 只供测试选择 Chromium 沙盒模式。参考 Playwright #33377：独立进程组，先杀整组再清理资料。
// spawnSync 超时只杀主进程时，renderer 还会写 Default，曾导致 ENOTEMPTY，连登录测试都没加载就退出。
function sandboxAvailable(exe, timeout = 30000) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-sb-probe-'));
  let child;
  try {
    child = spawnSync(exe, ['--headless=new', '--user-data-dir=' + dir, '--dump-dom', 'data:text/html,<p>sandbox-ok</p>'],
      { encoding: 'utf8', timeout, detached: true, killSignal: 'SIGKILL' });
    return child.status === 0 && String(child.stdout || '').includes('sandbox-ok');
  } finally {
    if (child?.pid) try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}
module.exports = { sandboxAvailable };
