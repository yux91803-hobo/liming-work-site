const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'xin-daily-context-')),xin=path.join(root,'xin');fs.mkdirSync(path.join(xin,'sessions'),{recursive:true});fs.mkdirSync(path.join(xin,'runs'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  return code=>{const r=spawnSync(process.execPath,['--input-type=module','-e',`
    import fs from 'node:fs';import path from 'node:path';
    import * as d from ${JSON.stringify(new URL('../site/xin/vm-daily.mjs','file://'+__filename).href)};
    import * as b from ${JSON.stringify(new URL('../site/xin/vm-base.mjs','file://'+__filename).href)};
    import * as p from ${JSON.stringify(new URL('../site/xin/vm-persona.mjs','file://'+__filename).href)};
    import * as a from ${JSON.stringify(new URL('../site/xin/vm-agent.mjs','file://'+__filename).href)};
    import * as m from ${JSON.stringify(new URL('../site/xin/vm-memory.mjs','file://'+__filename).href)};
    const out=await(async()=>{${code}})();process.stdout.write(JSON.stringify(out));`],{env:{...process.env,XIN_HOME:xin,XIN_WORK:path.join(root,'work')},encoding:'utf8'});
    assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);};
}
test('前台收到每日清单和真实结果；task list 从新对话也能读，天启不带这些资料',t=>{
  const run=fixture(t),r=run(`const date=b.today(),sid='sdailyctx01',task='sdailytask01',rr='rdailyctx01';
    b.writeJ(path.join(b.BASE,'daily-last.json'),{date,sid:task,run:'rdailytask01',ok:true,at:Date.now()});
    b.writeJ(path.join(b.BASE,'sessions',task+'.json'),{sid:task,kind:'task',dailyDate:date,runs:['rdailytask01'],result:{text:'甲站页面显示已签到；乙站还未核验',at:Date.now()}});
    fs.writeFileSync(path.join(b.BASE,'daily.md'),'每日查询甲站与乙站的签到记录');
    b.writeJ(path.join(b.BASE,'sessions',sid+'.json'),{sid,agent:'codex',runs:[rr]});
    b.writeJ(path.join(b.BASE,'runs',rr+'.json'),{run:rr,sid,agent:'codex',started:Date.now()});
    return {front:p.systemPrompt('',{tasks:true}),tianqi:p.tianqiPrompt(),listed:a.frontAction({run:rr,argv:['xin','task','list']})};`);
  assert.match(r.front,/每日查询甲站与乙站/);assert.match(r.front,/甲站页面显示已签到；乙站还未核验/);
  assert.match(r.front,/不能单凭它断言每一项已经签到/);assert.equal(r.listed.daily.last.isToday,true);
  assert.match(r.listed.daily.last.summary,/乙站还未核验/);assert.doesNotMatch(r.tianqi,/每日查询|乙站还未核验/);
});
test('昨日完成不等于今天签到；缺记录、错任务来源都不造结果',t=>{
  const run=fixture(t),r=run(`const yesterday=new Date(Date.now()+8*3600e3-86400e3).toISOString().slice(0,10);
    const empty=d.dailyEvidence();b.writeJ(path.join(b.BASE,'daily-last.json'),{date:yesterday,ok:true,sid:'../secret',at:1});
    const old=d.dailyEvidence();b.writeJ(path.join(b.BASE,'daily-last.json'),{date:b.today(),ok:true,sid:'swrong00001',run:'rwrong00001'});
    b.writeJ(path.join(b.BASE,'sessions','swrong00001.json'),{sid:'swrong00001',agent:'harness',runs:['rwrong00001'],result:{text:'伪造的别处签到'}});
    const wrong=d.dailyEvidence();b.writeJ(path.join(b.BASE,'sessions','swrong00001.json'),{sid:'swrong00001',kind:'task',dailyDate:b.today(),runs:['rwrong00001','rnewer00001'],result:{text:'来自较新轮次的结果'}});
    return {empty,old,wrong,newer:d.dailyEvidence(),context:d.dailyContext(old)};`);
  assert.equal(r.empty.last,null);assert.equal(r.old.last.isToday,false);assert.equal(r.old.last.summary,'');
  assert.equal(r.wrong.last.summary,'');assert.match(r.context,/不能当作今天的签到/);
  assert.equal(r.newer.last.summary,'','旧 run 不能借用同任务较新轮次的结果');
});
test('每日上下文不重新带回已忘内容，凭据文件位置和真实密钥不发给前台',t=>{
  const run=fixture(t),r=run(`const it=m.addMemory({content:'不要再提旧项目名称',source:'user'}).item;m.forgetMemory(it.id);
    return d.dailySafeText('方法：登录后查询签到日志\\n读取 /data/home/private/passwords.txt 后检查结果\\n凭据在 /data/workspace/accounts.json；检查 https://example.org/checkin\\n不要再提旧项目名称\\nkey sk-proj_abcdefghijklmnop');`);
  assert.match(r,/登录后查询签到日志/);assert.doesNotMatch(r,/\/data\/home|passwords|旧项目名称|sk-proj/);
  assert.doesNotMatch(r,/\/data\/workspace|accounts.json/);assert.match(r,/https:\/\/example.org\/checkin/);
});
