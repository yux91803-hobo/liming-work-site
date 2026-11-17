// Fault injection belongs only to a temporary copy of the real state server.
const fs = require('node:fs'), path = require('node:path');

const stateSocketFaultFile = home => path.join(home, 'run', 'test-state-fault.json');
function stateSocketFault(home) {
  try { return JSON.parse(fs.readFileSync(stateSocketFaultFile(home), 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
function installStateSocketFault(agentDir) {
  const file = path.join(agentDir, 'vm-kernel-state.mjs');
  let source = fs.readFileSync(file, 'utf8');
  const server = '  const server = net.createServer({ allowHalfOpen: true }, socket => {';
  const control = "      if (q.kind === 'control') {";
  const handle = 'try { const result = await handle(q); ok = true; reply(q, { ok: true, result }); }';
  if (!source.includes(server) || !source.includes(control) || !source.includes(handle)) throw Error('state fault hook no longer matches the real server');
  source = source.replace(server, `  function testStateFault(phase, q, result) {
    const rule = process.env.XIN_STATE_TEST_FAULT || '';
    const reject = phase === 'before' && rule === 'reject:' + q.op;
    if (rule !== phase + ':' + q.op && !reject) return;
    if (q.op === 'health' && !q.testStartupRun) return;
    const marker = path.join(home, 'run', 'test-state-fault.json');
    if (fs.existsSync(marker)) return;
    const tmp = marker + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ phase, pid: process.pid, kind: q.kind, op: q.op, id: q.id, run: q.run || q.testStartupRun, attempt: q.attempt || q.testStartupAttempt, ...(phase === 'after' ? { result } : {}) }), { mode: 0o600 });
    fs.renameSync(tmp, marker);
    if (reject) return true;
    process.kill(process.pid, 'SIGSTOP');
  }
` + server);
  source = source.replace(control, "      if (q.kind === 'control') testStateFault('before', q);\n" + control);
  source = source.replace(handle, "try { if (testStateFault('before', q)) { reply(q, { ok: false, error: 'state_request', executed: false }); return; } const result = await handle(q); testStateFault('after', q, result); ok = true; reply(q, { ok: true, result }); }");
  fs.writeFileSync(file, source);
}

module.exports = { installStateSocketFault, stateSocketFault, stateSocketFaultFile };
