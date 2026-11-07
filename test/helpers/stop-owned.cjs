// Test teardown: detached runners and watchdogs keep writing into their XIN_HOME after a test body
// finishes. Stop every process carrying this XIN_HOME, wait until they are really gone, then delete.
const fs = require('node:fs');

function owned(xinHome) {
  const out = [];
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    try {
      if (!fs.readFileSync('/proc/' + name + '/environ', 'utf8').split('\0').includes('XIN_HOME=' + xinHome)) continue;
      const stat = fs.readFileSync('/proc/' + name + '/stat', 'utf8'), state = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0];
      if (state !== 'Z' && state !== 'X') out.push(Number(name));
    } catch { /* exited while scanning */ }
  }
  return out;
}

async function stopOwned(xinHome, root, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let left = owned(xinHome);
  while (left.length && Date.now() < deadline) {
    for (const pid of left) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
    await new Promise(ok => setTimeout(ok, 30));
    left = owned(xinHome);
  }
  if (left.length) throw new Error('test processes did not exit: ' + left.join(','));
  if (root) fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

module.exports = { stopOwned };
