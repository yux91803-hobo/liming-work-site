const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process'), { pathToFileURL } = require('node:url');
const { platformTimeout } = require('./helpers/timeout.cjs');
const RUNTIME = pathToFileURL(path.join(__dirname, '../site/xin/vm-runtime.mjs')).href;

// Exercise the real preflight against a local fake CLI. The blocked and rejected
// cases must return before creating a network or invoking a working-model action.
function preflight(t, { usage = 'blocked', reportCode = 'state_disconnected', executed = 'unknown' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-quota-report-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const binary = path.join(root, 'agy'), calls = path.join(root, 'calls.jsonl'), result = path.join(root, 'result.json');
  fs.mkdirSync(path.join(root, 'client'));
  fs.writeFileSync(binary, '#!' + process.execPath + '\n' + `
const fs=require('node:fs'),args=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n');
if(args[args.indexOf('-p')+1]!=='/usage')throw Error('unexpected model call');
if(${JSON.stringify(usage)}==='failed')process.exit(2);
const result=${JSON.stringify(usage)}==='malformed'?{status:'SUCCESS'}:{status:'SUCCESS',command:{data:{groups:[{buckets:[
  {id:'gemini-5h',remaining_fraction:${JSON.stringify(usage)}==='blocked'?0:1,reset_time:new Date(Date.now()+3600000).toISOString()},
  {id:'gemini-weekly',remaining_fraction:1,reset_time:new Date(Date.now()+604800000).toISOString()}
]}]}}};
console.log(JSON.stringify({event:'result',result}));
`, { mode: 0o755 });
  const wrapper = `
import fs from 'node:fs';
import { antigravityWork } from ${JSON.stringify(RUNTIME)};
const reports=[];
try {
  const code=await antigravityWork({workspace:{work:${JSON.stringify(path.join(root, 'work'))}}},{
    clientDir:${JSON.stringify(path.join(root, 'client'))},
    quota:q=>{reports.push(q);throw Object.assign(Error('quota-report-rejected'),{code:${JSON.stringify(reportCode)},executed:${JSON.stringify(executed)}});}
  });
  fs.writeFileSync(${JSON.stringify(result)},JSON.stringify({code,reports}));
} catch(error) {
  fs.writeFileSync(${JSON.stringify(result)},JSON.stringify({error:error.message,errorCode:error.code,reports}));
}
`;
  const ran = spawnSync(process.execPath, ['--input-type=module', '-e', wrapper], {
    env: { ...process.env, XIN_ANTIGRAVITY_BIN: binary, XIN_AGY_HOME: root, XIN_TASK_SANDBOX: '0' },
    encoding: 'utf8', timeout: platformTimeout(5000)
  });
  assert.equal(ran.status, 0, ran.stderr);
  const observed = JSON.parse(fs.readFileSync(result, 'utf8'));
  const invocations = fs.readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(invocations.length, 1, '只查真实额度，不启动工作模型');
  assert.equal(invocations[0][invocations[0].indexOf('-p') + 1], '/usage');
  return observed;
}

test('真实额度已用完，即使缓存报告失联也仍返回75，不启动工作模型', t => {
  for (const reportCode of ['owner_unavailable', 'state_disconnected', 'state_timeout', 'state_client_failed']) {
    for (const executed of [false, 'unknown']) {
      const observed = preflight(t, { reportCode, executed });
      assert.equal(observed.code, 75, JSON.stringify(observed));
      assert.equal(observed.reports.length, 1);
      assert.equal(observed.reports[0].blocked, true);
    }
  }
});

test('真实额度查询失败或字段畸形：报告容错不放行，也不伪造额度', t => {
  for (const usage of ['failed', 'malformed']) {
    const observed = preflight(t, { usage });
    assert.match(observed.error, /暂时无法核对 Antigravity 额度/);
    assert.equal(observed.code, undefined);
    assert.deepEqual(observed.reports, []);
  }
});

test('额度报告的校验或程序错误仍原样传播，不能当网络失联忽略', t => {
  for (const reportCode of ['stale_attempt', 'state_response', 'state_protocol', 'state_failed', 'EACCES']) {
    const observed = preflight(t, { usage: 'available', reportCode });
    assert.equal(observed.error, 'quota-report-rejected');
    assert.equal(observed.errorCode, reportCode);
    assert.equal(observed.reports.length, 1);
  }
  const observed = preflight(t, { usage: 'available', reportCode: 'state_disconnected', executed: true });
  assert.equal(observed.error, 'quota-report-rejected', '矛盾的执行标记不获传输容错');
});
