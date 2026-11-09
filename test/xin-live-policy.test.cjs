const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),{spawnSync}=require('node:child_process');
test('正式联调按实际前台模型验收，DeepSeek 必须有尚未到期的 Claude 额度耗尽证据',()=>{
 const r=spawnSync('python3',[path.join(__dirname,'xin_live_policy_test.py')],{encoding:'utf8',timeout:10000});assert.equal(r.status,0,r.stderr||r.stdout);
});
