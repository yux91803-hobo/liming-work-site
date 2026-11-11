const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process'),{pathToFileURL}=require('node:url');
const url=n=>pathToFileURL(path.join(__dirname,'../site/xin/'+n+'.mjs')).href;
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'xin-learning-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 return code=>{const r=spawnSync(process.execPath,['--input-type=module','-e',`import * as l from ${JSON.stringify(url('vm-learning'))};import * as m from ${JSON.stringify(url('vm-memory'))};import * as b from ${JSON.stringify(url('vm-base'))};
 const now=Date.UTC(2026,10,8),event=(id,extra={})=>({id:'learn00000'+id,topic:'gpio',exercise:'led-init',kind:'code',answer:'LED_PORT->BSRR = GPIO_BSRR_BS0;',correct:true,independent:true,at:now,...extra});
 const report=(events,extra={})=>l.reportLearning({agent:'codex',events,...extra},now);const defaultLearning=m.memoryPreferences().learning;m.setMemoryPreferences({learning:true});const out=await(async()=>{${code}})();process.stdout.write(JSON.stringify(out));`],{env:{...process.env,XIN_HOME:path.join(root,'xin'),XIN_WORK:path.join(root,'work')},encoding:'utf8'});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);};
}
test('学习证据只收默认模式的网页上报；开关默认关（站长不要学习记录），打开后才收，关闭后不收，天启/任务/敏感输入/重复编号不收',t=>{
 const run=fixture(t),r=run(`b.mk(b.BASE+'/sessions');b.writeJ(b.BASE+'/sessions/stianqi001.json',{agent:'harness'});
 const on=m.memoryPreferences().learning,dflt=defaultLearning,view=report([event(1,{kind:'view',answer:'',correct:null,independent:false})]);
 const before=m.listMemory().length,code=report([event(2)]),duplicate=report([event(2)]),tq=report([event(3)],{sid:'stianqi001'}),agent=report([event(4)],{agent:'harness'}),worker=report([event(5)],{task:true});
 const sensitive=report([event(6,{answer:'网关密码是 abc12345'})]);m.setMemoryPreferences({learning:false});const off=report([event(7)]);
 return {on,dflt,view,before,code,duplicate,tq,agent,worker,sensitive,off,n:l.learningDb().prepare('SELECT count(*) n FROM learning_events').get().n};`);
 assert.equal(r.dflt,false,'默认关');assert.equal(r.on,true);assert.equal(r.view.accepted,1);assert.equal(r.before,0);assert.equal(r.code.accepted,1);assert.equal(r.duplicate.accepted,0);
 assert.equal(r.tq.error,'not_default');assert.equal(r.agent.error,'not_default');assert.equal(r.worker.error,'not_default');assert.equal(r.sensitive.accepted,0);assert.equal(r.off.ignored,'disabled');assert.equal(r.n,2);
});
test('近期证据权重大；独立代码通过提升为基本掌握，后来出错标需要复习，辅助答对不能冒充独立掌握',t=>{
 const run=fixture(t),r=run(`const day=86400e3,events=[event(1,{kind:'answer',correct:0,at:now-42*day}),event(2,{kind:'answer',correct:1,at:now-day}),event(3,{kind:'answer',answer:'先开时钟，再配置',correct:1})];
 const weighted=l.learningState(events,{},now),assisted=l.learningState([event(4,{independent:0,correct:1})],{},now);
 const mastered=l.learningState([event(1,{correct:1,independent:1})],{},now),review=l.learningState([event(2,{correct:0,at:now+1})],{mastered:1,state:'mastered'},now+1);
 const hold=l.learningState([event(1,{correct:1,at:now-1}),event(3,{correct:1,independent:0,at:now+3})],{mastered:1,state:'review',at:now+2},now+3);
 const clear=l.learningState([event(4,{correct:1,at:now+4})],{mastered:1,state:'review',at:now+2},now+4);
 return {weighted,assisted,mastered,review,hold,clear};`);
 assert.equal(r.weighted.state,'mastered');assert.ok(r.weighted.score>0.9);assert.equal(r.assisted.state,'practising');assert.equal(r.mastered.state,'mastered');assert.equal(r.review.state,'review');assert.equal(r.hold.state,'review');assert.equal(r.clear.state,'mastered');
});
test('学习判断保留历史与真实答案出处；用户纠正立即优先；忘掉清除派生证据，不从学习记录重建',t=>{
 const run=fixture(t),r=run(`report([event(1)]);const it=m.listMemory()[0],proof=l.learningEvidence(it.id)[0];
 l.reportLearning({agent:'codex',events:[event(2,{correct:false,at:now+1,answer:'忘了先置输出电平'})]},now+1);
 const review=m.listMemory()[0],versions=m.memoryDb().prepare('SELECT count(*) n FROM memory_versions WHERE item=?').get(it.id).n;
 m.updateMemory(it.id,{content:'GPIO 已经掌握，不用再推测这道题'});
 l.reportLearning({agent:'codex',events:[event(3,{correct:true,at:now+2})]},now+2);const corrected=m.listMemory()[0].content;
 m.forgetMemory(it.id);const later=l.reportLearning({agent:'codex',events:[event(4,{at:now+3})]},now+3);
 return {first:it,proof,review,versions,corrected,later,remaining:m.listMemory().length,n:l.learningDb().prepare('SELECT count(*) n FROM learning_events').get().n,links:l.learningDb().prepare('SELECT count(*) n FROM learning_links').get().n};`);
 assert.equal(r.first.basis,'observed');assert.match(r.first.content,/基本掌握/);assert.match(r.proof.url,/^\/tools\/stm32\/\?/);assert.equal(r.proof.quote,'LED_PORT->BSRR = GPIO_BSRR_BS0;');
 assert.match(r.review.content,/需要复习/);assert.ok(r.versions>=1);assert.equal(r.corrected,'GPIO 已经掌握，不用再推测这道题');assert.equal(r.later.accepted,0);assert.equal(r.remaining,0);assert.equal(r.n,0);assert.equal(r.links,0);
});
test('网页输入证据不复用教材答案：只看页面不判断掌握，首建事务回滚后仍能再用',t=>{
 const run=fixture(t),r=run(`try{b.journal.atomic(()=>{report([event(1)]);throw Error('stop');});}catch{}
 const after=report([event(2,{kind:'view',answer:'',correct:null,independent:false})]);return {after,n:m.listMemory().length,guide:l.learningGuidance('GPIO',now)};`);
 assert.equal(r.after.accepted,1);assert.equal(r.n,0);assert.match(r.guide,/看过页面不代表已经掌握/);
});
