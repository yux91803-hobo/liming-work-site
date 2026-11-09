const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xin-context-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const xin=path.join(dir,'xin');fs.mkdirSync(path.join(xin,'runs'),{recursive:true});fs.mkdirSync(path.join(xin,'sessions'));
 return code=>{const r=spawnSync(process.execPath,['--input-type=module','-e',`
 import * as c from ${JSON.stringify(new URL('../site/xin/vm-context.mjs','file://'+__filename).href)};
 import * as m from ${JSON.stringify(new URL('../site/xin/vm-memory.mjs','file://'+__filename).href)};
 import * as b from ${JSON.stringify(new URL('../site/xin/vm-base.mjs','file://'+__filename).href)};
 import * as p from ${JSON.stringify(new URL('../site/xin/vm-companion.mjs','file://'+__filename).href)};
 import fs from 'node:fs';import path from 'node:path';
 const chat=(n,text,opts={})=>{const sid='scontext0'+n,run='rcontext0'+n,at=opts.at||Date.now();
 b.writeJ(path.join(b.BASE,'sessions',sid+'.json'),{sid,agent:opts.agent||'codex',title:opts.title||'定时器学习',runs:[run],kind:opts.kind});
 b.writeJ(path.join(b.BASE,'runs',run+'.json'),{run,sid,agent:opts.agent||'codex',started:at-1,ended:at,task:opts.task});
 fs.writeFileSync(path.join(b.BASE,'runs',run+'.jsonl'),JSON.stringify({t:'user',text,at})+'\\n'+JSON.stringify({t:'text',text:'一起分析一下',at})+'\\n');return {sid,run,at};};
 const out=await(async()=>{${code}})();process.stdout.write(JSON.stringify(out));`],{env:{...process.env,XIN_HOME:xin,XIN_WORK:path.join(dir,'work')},encoding:'utf8'});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);};
}
test('回忆跨默认对话，中文三字走 FTS、两字也能找，带日期和出处；天启/任务/敏感内容不进入',t=>{
 const run=fixture(t),r=run(`chat(1,'定时器输入捕获遇到上升沿', {at:Date.UTC(2026,10,1),title:'输入捕获'});chat(2,'定时器输入捕获已经跑通');
 chat(3,'定时器输入捕获天启',{agent:'harness'});chat(4,'定时器输入捕获后台',{task:true});chat(5,'定时器输入捕获每日',{kind:'daily'});
 chat(6,'定时器输入捕获，网关密码是 abc12345');
 return {fts:c.recallAll('定时器'),short:c.recallAll('上升'),literal:c.recallAll('" OR text:*'),n:m.memoryDb().prepare('SELECT count(*) n FROM recall_sources').get().n};`);
 assert.equal(r.fts.matches.length,2);assert.equal(r.short.matches.length,1);assert.equal(r.literal.matches.length,0);
 const old=r.fts.matches.find(x=>x.title==='输入捕获');assert.match(old.date,/2026-11-01 08:00/);assert.equal(old.url,'/#xin=scontext01');assert.equal(old.run,'rcontext01');assert.equal(r.n,3);
});
test('忘掉在一次事务内清掉索引、版本和其它会话里的相同引文，旧上下文也不恢复；失去来源的缓存随检索清理',t=>{
 const run=fixture(t),r=run(`const a=chat(1,'我喜欢熬夜写代码'),b1=chat(2,'后来聊过：我喜欢熬夜写代码，今天在看定时器');
 const it=m.addMemory({content:'喜欢熬夜写代码',basis:'stated',evidence:{...a,quote:'我喜欢熬夜写代码'}}).item;c.syncRecall();
 const before=c.recallAll('写代码').matches.length;m.forgetMemory(it.id);
 const immediate=m.memoryDb().prepare('SELECT count(*) n FROM recall_fts WHERE text LIKE ?').get('%写代码%').n;
 const after=c.recallAll('写代码').matches.length,ctx=c.safeContextEvents(b1.run).length,g=c.turnGuidance({text:'熬夜写代码'});
 chat(7,'串口日志正常');c.syncRecall();fs.unlinkSync(path.join(b.BASE,'runs','rcontext07.jsonl'));c.syncRecall();
 return {before,immediate,after,ctx,g,orphan:c.recallAll('串口').matches.length,versions:m.memoryDb().prepare('SELECT count(*) n FROM memory_versions').get().n};`);
 assert.equal(r.before,2);assert.equal(r.immediate,0);assert.equal(r.after,0);assert.equal(r.ctx,0);assert.doesNotMatch(r.g,/喜欢熬夜/);assert.equal(r.orphan,0);assert.equal(r.versions,0);
});
test('每轮给可照做的建议，待确认/隐私不混入；久未涉及先问，后台只取相关习惯',t=>{
 const run=fixture(t),r=run(`m.addMemory({content:'回答先给结论',source:'user'});m.addMemory({content:'可能爱看红色',basis:'inferred'});
 const it=m.addMemory({content:'PWM 还没独立算对',source:'user',type:'learning'}).item;
 m.memoryDb().prepare('UPDATE memory_items SET confirmed=?,updated=? WHERE id=?').run(1,1,it.id);
 const priv=m.addMemory({content:'只想私下提起的爱好',source:'user'}).item;m.updateMemory(priv.id,{private:true});
 m.addMemory({content:'音乐喜欢爵士',source:'user'});chat(1,'PWM 频率先分频，再看 ARR');
 return {g:c.turnGuidance({text:'PWM 怎么算',sid:'scontext01'}),task:c.taskMemory('写 PWM 代码')};`);
 assert.match(r.g,/交流时照顾：回答先给结论/);assert.match(r.g,/很久没确认/);assert.match(r.g,/先分频/);assert.doesNotMatch(r.g,/爱看红色|私下提起/);
 assert.match(r.task,/回答先给结论/);assert.doesNotMatch(r.task,/音乐|爱看红色|还没独立算对|私下/);
 const agent=fs.readFileSync(path.join(__dirname,'../site/xin/vm-agent.mjs'),'utf8');assert.match(agent,/input\.push\(\{role:'user',content:guide\}\)/);
 const persona=fs.readFileSync(path.join(__dirname,'../site/xin/vm-persona.mjs'),'utf8');assert.doesNotMatch(persona,/turnGuidance/);
});
test('主动跟进每天全设备至多一次，同设备重试不丢；可关闭，忘掉的开场白不再说',t=>{
 const run=fixture(t),r=run(`const now=Date.now(),g=p.setNext('明天继续看看 PWM 吧');
 const first=p.claimNext(now,'one'),retry=p.claimNext(now,'one'),other=p.claimNext(now,'two');p.setNext('再跟进一次');const extra=p.claimNext(now,'one');
 const tomorrow=p.claimNext(now+86400e3,'two');m.setMemoryPreferences({followups:false});const off=p.claimNext(now+2*86400e3,'two');
 m.setMemoryPreferences({followups:true});const it=m.addMemory({content:'再跟进一次',source:'user'}).item;m.forgetMemory(it.id);const forgotten=p.getNext(now);
 return {first:first?.id===g.id,retry:retry?.id===g.id,other,extra,tomorrow:!!tomorrow,off,forgotten};`);
 assert.deepEqual(r,{first:true,retry:true,other:null,extra:null,tomorrow:true,off:null,forgotten:null});
});
test('FTS 首次创建随事务回滚后还能重新初始化',t=>{
 const run=fixture(t),r=run(`chat(1,'DMA 循环模式');try{b.journal.atomic(()=>{c.syncRecall();throw Error('rollback');});}catch{}
 return c.recallAll('DMA').matches.length;`);assert.equal(r,1);
});
test('敏感本轮原话不触发自动跨对话检索；已确认的交流习惯仍可用',t=>{
 const run=fixture(t),r=run(`chat(1,'只回复 front-oldmarker，别的都不做');m.addMemory({content:'先给结论',source:'user'});
 return c.turnGuidance({text:'只回复 generation-original-123456abcdef，不要记忆'});`);
 assert.match(r,/先给结论/);assert.doesNotMatch(r,/相关旧话|front-oldmarker/);
});
test('保留控制器已经交付的真实结果，但不读回内部完成事件指令',t=>{
 const run=fixture(t),r=run(`const a=chat(1,'内部完成事件');const file=path.join(b.BASE,'runs',a.run+'.json');
 b.writeJ(file,{...b.readJ(file),kind:'handoff'});fs.appendFileSync(path.join(b.BASE,'runs',a.run+'.jsonl'),JSON.stringify({t:'text',text:'编好了，生成 blink.hex',taskResult:{sid:'stask00001',status:'done'},at:a.at}));
 return {ctx:c.safeContextEvents(a.run),found:c.recallAll('blink').matches,internal:c.recallAll('内部完成').matches};`);
 assert.equal(r.ctx.length,1);assert.equal(r.found.length,1);assert.equal(r.internal.length,0);
});
