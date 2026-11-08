const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {spawnSync} = require('node:child_process');
const {pathToFileURL} = require('node:url');
const url = name => JSON.stringify(pathToFileURL(path.join(__dirname,'../site/xin/'+name+'.mjs')).href);

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'xin-idle-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  return code => {
    const r = spawnSync(process.execPath,['--input-type=module','-e',String.raw`
      import fs from 'node:fs';import path from 'node:path';
      import * as i from ${url('vm-memory-idle')};import * as m from ${url('vm-memory')};
      import {journal} from ${url('vm-base')};
      const home=process.env.XIN_HOME, now=Date.parse('2026-11-08T10:00:00Z');
      fs.mkdirSync(path.join(home,'sessions'),{recursive:true});fs.mkdirSync(path.join(home,'runs'),{recursive:true});
      const put=(p,x)=>fs.writeFileSync(path.join(home,p),JSON.stringify(x));
      let seq=0;
      function chat(text,at=now-60000,options={}){
        seq++;const sid='schat'+String(seq).padStart(5,'0'),run='rchat'+String(seq).padStart(5,'0');
        put('sessions/'+sid+'.json',{sid,agent:'codex',runs:[run],created:at,...options.session});
        put('runs/'+run+'.json',{run,sid,agent:'codex',started:at,ended:at+1000,...options.meta});
        fs.writeFileSync(path.join(home,'runs',run+'.jsonl'),JSON.stringify({t:'user',text,at})+'\n'+JSON.stringify({t:'text',text:'助手自己的话不能作为用户的证据'})+'\n');
        return {sid,run,text};
      }
      function plan(limits={}){return i.memoryReviewPlan(now,{...i.MEMORY_IDLE,minChars:1,minRuns:1,...limits});}
      function proposal(p,changes={}){const s=p.sources[0];return {content:'喜欢先看波形再看寄存器',type:'profile',basis:'stated',scope:'long-term',topic:'PWM',replaces:null,evidence:[{sid:s.sid,run:s.run,event:s.event,quote:s.text}],...changes};}
      m.setMemoryMeta('idle_deep_at',now);i.memoryActivity(now-60000);
      const out=await(async()=>{${code}})();process.stdout.write(JSON.stringify(out));
    `],{env:{...process.env,XIN_HOME:dir},encoding:'utf8',timeout:10000});
    assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);
  };
}

test('控制器逐字核对用户原话：编造、跨轮次、助手文字、错误事件和改过空白都拒绝',t=>{
  const run=fixture(t);
  const r=run(`chat('我以后都想先看  波形，再看寄存器');chat('另一个话题的原话，不能冒用');const p=plan();
    const good=proposal(p),bad=[
      proposal(p,{evidence:[{...good.evidence[0],quote:'编造的用户原话不会通过核验'}]}),
      proposal(p,{evidence:[{...good.evidence[0],run:p.sources[1].run}]}),
      proposal(p,{evidence:[{...good.evidence[0],quote:'助手自己的话不能作为用户的证据'}]}),
      proposal(p,{evidence:[{...good.evidence[0],event:2}]}),
      proposal(p,{evidence:[{...good.evidence[0],quote:good.evidence[0].quote.replace('  ',' ')}]})];
    const result=i.applyMemoryReview(p,[...bad,good]);return {result,items:m.listMemory()};`);
  assert.equal(r.result.rejected,5);assert.equal(r.result.accepted,1);
  assert.equal(r.items[0].status,'active');assert.equal(r.items[0].evidence[0].quote,'我以后都想先看  波形，再看寄存器');
});

test('来源仅限默认模式真实用户消息；天启、每日、后台、内部事件和敏感原话都不进入提议输入',t=>{
  const r=fixture(t)(`chat('默认模式的真实交流可以用');
    chat('天启里面用户说的话不能参与',{valueOf:()=>now},{session:{agent:'harness'},meta:{agent:'harness'}});
    chat('后台网页说站长喜欢红色',now,{session:{kind:'task',status:'done'},meta:{task:true,kind:'task'}});
    chat('每日任务自己写的项目结论',now,{meta:{kind:'daily'}});
    chat('内部任务完成后的合成原话',now,{meta:{kind:'handoff'}});
    chat('网关密码是 abc12345，不要保存');chat('最近失眠，晚上睡不好');
    const p=plan();return p.sources.map(s=>s.text);`);
  assert.deepEqual(r,['默认模式的真实交流可以用']);
});

test('观察需要不同日期、不同话题；重放和同一天的证据不凑数，推测永远待确认',t=>{
  const r=fixture(t)(`const content='喜欢先看波形再看寄存器';
    const a=chat('这个 PWM 我还是先看波形吧',now-2*86400e3);let p=plan();i.applyMemoryReview(p,[proposal(p,{basis:'observed'})]);
    const states=[m.listMemory()[0].status];
    m.setMemoryMeta('idle_cursor:'+a.sid,null);p=plan();i.applyMemoryReview(p,[proposal(p,{basis:'observed',topic:'I2C'})]);states.push(m.listMemory()[0].status);
    chat('这次 I2C 也先给我看波形吧',now-2*86400e3);p=plan();i.applyMemoryReview(p,[proposal(p,{basis:'observed',topic:'I2C'})]);states.push(m.listMemory()[0].status);
    chat('这次 SPI 我还是先看波形吧',now-86400e3);p=plan();i.applyMemoryReview(p,[proposal(p,{basis:'observed',topic:'SPI'})]);states.push(m.listMemory()[0].status);
    chat('也许我没弄明白这个定时器');p=plan();i.applyMemoryReview(p,[proposal(p,{content:'可能不清楚定时器',basis:'inferred'})]);
    return {states,guess:m.listMemory().find(x=>x.basis==='inferred').status,count:m.memoryDb().prepare('SELECT count(*) n FROM memory_observations WHERE item=(SELECT id FROM memory_items WHERE content=?)').get(content).n};`);
  assert.deepEqual(r.states,['pending','pending','pending','active']);assert.equal(r.guess,'pending');assert.equal(r.count,3);
});

test('站长以后又改变偏好：新的明确原话可以取代现判断，旧聊天仍被阻止',t=>{
  const r=fixture(t)(`const old=m.addMemory({content:'喜欢先看代码',source:'user'}).item;
    chat('我现在不是先看代码了，改成先看波形再看寄存器');let p=plan();i.applyMemoryReview(p,[proposal(p,{replaces:old.id})]);
    const current=m.listMemory()[0];const later=Date.now()+10000;
    chat('现在又改为先看代码，别再先讲波形了',later);p=plan();
    const result=i.applyMemoryReview(p,[proposal(p,{content:old.content,replaces:current.id})]);
    return {result,items:m.listMemory(),old:m.memoryDb().prepare('SELECT status FROM memory_items WHERE id=?').get(old.id).status};`);
  assert.equal(r.result.accepted,1);assert.equal(r.old,'superseded');assert.equal(r.items.length,1);
  assert.equal(r.items[0].content,'喜欢先看代码');assert.equal(r.items[0].status,'active');
});

test('纠正取代旧判断，保留历史和版本；不凭普通观察推翻用户确认过的判断，可显式回退',t=>{
  const r=fixture(t)(`const old=m.addMemory({content:'喜欢先看代码',source:'user'}).item;
    chat('我现在不是先看代码了，改成先看波形再看寄存器');let p=plan();
    const reject=i.applyMemoryReview(p,[proposal(p,{basis:'observed',replaces:old.id})]);
    m.setMemoryMeta('idle_cursor:'+p.sources[0].sid,null);p=plan();const result=i.applyMemoryReview(p,[proposal(p,{replaces:old.id})]);
    const history=m.memoryDb().prepare('SELECT status FROM memory_items WHERE id=?').get(old.id).status;
    const before=m.coreMemory();const version=m.memoryDb().prepare("SELECT id FROM memory_versions WHERE item=? AND reason='supersede'").get(old.id).id;
    const restore=m.restoreMemoryVersion(version);return {reject,result,history,before,restore,after:m.coreMemory()};`);
  assert.equal(r.reject.rejected,1);assert.equal(r.result.accepted,1);assert.equal(r.history,'superseded');
  assert.ok(!r.before.includes('喜欢先看代码'));assert.ok(r.before.includes('喜欢先看波形'));
  assert.equal(r.restore.item.status,'active');assert.ok(r.after.includes('喜欢先看代码'));assert.ok(!r.after.includes('喜欢先看波形'));
});

test('忘掉后连同纠正链、版本和出处一起去除；原轮次改写措辞也不能复记，网页手动添加仍可用',t=>{
  const r=fixture(t)(`const oldSource=chat('我以后想先看代码，再讲思路');let p=plan();i.applyMemoryReview(p,[proposal(p,{content:'喜欢先看代码'})]);
    const old=m.listMemory()[0];const newSource=chat('我现在不是先看代码了，改成先看波形再看寄存器');p=plan();i.applyMemoryReview(p,[proposal(p,{replaces:old.id})]);
    const current=m.listMemory()[0];m.forgetMemory(current.id);
    const d=m.memoryDb();const counts=['memory_items','memory_evidence','memory_versions','memory_observations'].map(t=>d.prepare('SELECT count(*) n FROM '+t).get().n);
    m.setMemoryMeta('idle_cursor:'+oldSource.sid,null);m.setMemoryMeta('idle_cursor:'+newSource.sid,null);
    const auto=m.addMemory({content:'偏爱先浏览源码',basis:'stated',evidence:{sid:oldSource.sid,run:oldSource.run,quote:oldSource.text}});
    return {counts,plan:plan(),auto:auto.error,manual:m.addMemory({content:current.content,source:'user'}).item.status};`);
  assert.deepEqual(r.counts,[0,0,0,0]);assert.equal(r.plan,null);assert.equal(r.auto,'forgotten');assert.equal(r.manual,'active');
});

test('手动改过的旧判断不会被旧聊天改写复活；隐私条目不能由整理器解除隐私',t=>{
  const r=fixture(t)(`const a=chat('我以后希望一直先看代码');let p=plan();i.applyMemoryReview(p,[proposal(p,{content:'先看代码'})]);
    const item=m.listMemory()[0];m.updateMemory(item.id,{content:'先看波形'});
    m.setMemoryMeta('idle_cursor:'+a.sid,null);const afterEdit=plan();
    const secret=m.addMemory({content:'喜欢安静地学习',source:'user'}).item;m.updateMemory(secret.id,{private:true});
    chat('我以后希望一直安静地学习');p=plan();const result=i.applyMemoryReview(p,[proposal(p,{content:secret.content})]);
    return {afterEdit,result,status:m.listMemory().find(x=>x.id===secret.id).status};`);
  assert.equal(r.afterEdit,null);assert.equal(r.result.rejected,1);assert.equal(r.status,'private');
});

test('深整理只让小比例判断直接生效；超过比例留待确认，确认新判断时才取代旧判断',t=>{
  const r=fixture(t)(`m.setMemoryMeta('idle_deep_at',0);const old=m.addMemory({content:'旧的项目方向',basis:'observed'}).item;
    chat('以后都改为学习定时器，项目改成串口助手，交流先看结论');const p=plan();
    const result=i.applyMemoryReview(p,[proposal(p,{content:'学习定时器',type:'learning'}),proposal(p,{content:'串口助手项目',type:'project',replaces:old.id}),proposal(p,{content:'交流先看结论'})]);
    const items=m.listMemory();const pending=items.find(x=>x.content==='串口助手项目');m.updateMemory(pending.id,{confirm:true});
    return {result,states:items.map(x=>x.status),old:m.memoryDb().prepare('SELECT status FROM memory_items WHERE id=?').get(old.id).status};`);
  assert.equal(r.result.mode,'deep');assert.equal(r.result.changed,1);assert.equal(r.result.pending,2);
  assert.equal(r.states.filter(s=>s==='active').length,1);assert.equal(r.old,'superseded');
});

test('部分长轮次保留事件/字符断点；提交原子且重放不重复，原话变化或被删除则不推进',t=>{
  const r=fixture(t)(`const a=chat('甲'.repeat(3000));const b=chat('以后都先看结论，再讲代码');
    let p=plan({sourceBytes:600});i.applyMemoryReview(p,[]);const first=m.memoryMeta('idle_cursor:'+a.sid);
    const second=plan({sourceBytes:600});i.applyMemoryReview(second,[]);const next=m.memoryMeta('idle_cursor:'+a.sid);
    const stale=plan();fs.unlinkSync(path.join(home,'sessions',a.sid+'.json'));const rejected=i.applyMemoryReview(stale,[]);
    return {first,next,secondChars:second.sources[0].text.length,rejected,cursor:m.memoryMeta('idle_cursor:'+a.sid)};`);
  assert.ok(r.first.offset>0&&r.first.offset<3000);assert.equal(r.next.offset,r.first.offset*2);assert.equal(r.secondChars,r.first.offset);
  assert.equal(r.rejected.error,'changed');assert.deepEqual(r.cursor,r.next);
});

test('每日次数和 token 预算在调用前持久预留；未知用量、重启、失败都不能绕过上限，北京时间换日重置',t=>{
  const r=fixture(t)(`chat('以后都先讲结论，再看代码');const p=plan();const limits={...i.MEMORY_IDLE,dailyCalls:2,dailyTokens:p.reservation*2};
    const first=i.reserveMemoryReview(p,now,limits),second=i.reserveMemoryReview(p,now,limits),blocked=i.reserveMemoryReview(p,now,limits);
    const tight=i.reserveMemoryReview(p,now+86400e3,{...limits,dailyTokens:p.reservation-1});
    const next=i.reserveMemoryReview(p,now+86400e3,limits);return {first,second,blocked,tight,next,budget:m.memoryMeta(first.key)};`);
  assert.ok(r.first&&r.second);assert.equal(r.blocked,null);assert.equal(r.tight,null);assert.ok(r.next);
  assert.equal(r.budget.calls,2);assert.equal(r.budget.tokens,r.first.reservation*2);
});

test('请求预留在进程退出后仍占预算；另一个控制器进程不能再次花同一天的额度',t=>{
  const run=fixture(t);
  const first=run(`chat('以后都先讲结论，再看代码');const p=plan();return i.reserveMemoryReview(p,now,{...i.MEMORY_IDLE,dailyCalls:1});`);
  assert.ok(first);
  const restarted=run(`const p=plan();return i.reserveMemoryReview(p,now,{...i.MEMORY_IDLE,dailyCalls:1});`);
  assert.equal(restarted,null);
});

test('用户消息/后台任务抢占在途请求，AbortSignal 取消且不推进断点；不写活动租约、不发唤醒请求',t=>{
  const r=fixture(t)(`const a=chat('以后都先讲结论，再看代码');put('tasks-lease.json',{on:false,at:123});let calls=0;
    const result=await i.idleMemoryReview({key:'fake-test-key',limits:{minChars:1,minRuns:1},now:()=>now,pollMs:5,fetch:async(url,opts)=>{
      calls++;setTimeout(()=>i.memoryActivity(now),5);
      await new Promise((resolve,reject)=>opts.signal.addEventListener('abort',()=>reject(Error('cancelled')),{once:true}));
    }});
    return {result,calls,cursor:m.memoryMeta('idle_cursor:'+a.sid),lease:JSON.parse(fs.readFileSync(path.join(home,'tasks-lease.json'))),items:m.listMemory()};`);
  assert.equal(r.calls,1);assert.equal(r.result.skipped,'interrupted');assert.equal(r.cursor,null);assert.deepEqual(r.items,[]);
  assert.deepEqual(r.lease,{on:false,at:123});
});

test('空闲只调用前台同款 DeepSeek，无工具；坏 JSON 不推进，正确返回有原话出处且能从断点继续',t=>{
  const r=fixture(t)(`const a=chat('以后都先讲结论，再看代码');let body,url;
    const fetch=async(u,o)=>{url=u;body=JSON.parse(o.body);const p=plan();return {ok:true,json:async()=>({status:'completed',usage:{input_tokens:100,output_tokens:50},output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({proposals:[proposal(p)]})}]}]})};};
    const result=await i.idleMemoryReview({key:'fake-test-key',limits:{minChars:1,minRuns:1},now:()=>now,fetch});
    const resumed=plan();chat('这个话题没有长期记忆，不用硬凑');const bad=await i.idleMemoryReview({key:'fake-test-key',limits:{minChars:1,minRuns:1},now:()=>now,fetch:async()=>({ok:true,json:async()=>({output:[{type:'message',content:[{type:'output_text',text:'not json'}]}]})})});
    return {result,model:body.model,tools:body.tools,url,items:m.listMemory(),resumed,bad,pending:!!plan()};`);
  assert.equal(r.result.accepted,1);assert.equal(r.model,'deepseek-v4.1-flash');assert.deepEqual(r.tools,[]);assert.match(r.url,/\/v1\/responses$/);
  assert.equal(r.items[0].evidence[0].quote,'以后都先讲结论，再看代码');assert.equal(r.resumed,null);
  assert.equal(r.bad.skipped,'invalid_response');assert.equal(r.pending,true);
});

test('有工作时不调用模型；等待安静窗口时的新消息使整理退出，未配置密钥也不占预算',t=>{
  const r=fixture(t)(`chat('以后都先讲结论，再看代码');let calls=0;const fetch=()=>{calls++;throw Error('must not call')};
    const a=await i.idleMemoryReview({key:'fake-test-key',busy:()=>true,fetch});
    const b=await i.idleMemoryReview({key:'',limits:{minChars:1,minRuns:1},now:()=>now,fetch});
    i.memoryActivity(Date.now());setTimeout(()=>i.memoryActivity(),5);
    const c=await i.idleMemoryReview({key:'fake-test-key',pollMs:2,limits:{quietMs:50,requestMs:100},fetch});
    return {calls,a,b,c,budgets:m.memoryDb().prepare("SELECT count(*) n FROM memory_meta WHERE key LIKE 'idle_budget:%'").get().n};`);
  assert.equal(r.calls,0);assert.equal(r.a.skipped,'busy');assert.equal(r.b.skipped,'no_key');assert.equal(r.c.skipped,'interrupted');assert.equal(r.budgets,0);
});

test('后台任务进入队列会中断整理，即使没有运行中的进程，也不抢任务的额度',t=>{
  const r=fixture(t)(`chat('以后都先讲结论，再看代码');let cancelled=false;
    const result=await i.idleMemoryReview({key:'fake-test-key',limits:{minChars:1,minRuns:1},now:()=>now,pollMs:2,
      fetch:async(url,o)=>{setTimeout(()=>put('sessions/stask00001.json',{sid:'stask00001',kind:'task',agent:'codex',status:'queued',runs:[]}),5);
        await new Promise((resolve,reject)=>o.signal.addEventListener('abort',()=>{cancelled=true;reject(Error('preempted'));},{once:true}));}});
    return {result,cancelled,items:m.listMemory(),taskBudget:fs.existsSync(path.join(home,'budgets'))};`);
  assert.equal(r.cancelled,true);assert.equal(r.result.skipped,'interrupted');assert.deepEqual(r.items,[]);assert.equal(r.taskBudget,false);
});

test('未达到轻整理阈值时等新内容；累计够多或超过一周才深整理，短期要求不泛化到长期',t=>{
  const r=fixture(t)(`chat('今天简单一点讲，我想先看结论');const small=i.memoryReviewPlan(now);
    const weekly=i.memoryReviewPlan(now+8*86400e3);const r=i.applyMemoryReview(weekly,[proposal(weekly,{scope:'session'})]);
    return {small,mode:weekly.mode,result:r,items:m.listMemory()};`);
  assert.equal(r.small,null);assert.equal(r.mode,'deep');assert.equal(r.result.rejected,1);assert.deepEqual(r.items,[]);
});

test('模型等待时用户改记忆或删除原会话，过期提议整批丢弃、断点不动',t=>{
  const r=fixture(t)(`const a=chat('以后都先讲结论，再看代码');const existing=m.addMemory({content:'原来的偏好',source:'user'}).item;
    const result=await i.idleMemoryReview({key:'fake-test-key',limits:{minChars:1,minRuns:1},now:()=>now,fetch:async()=>{
      const p=plan();m.updateMemory(existing.id,{content:'站长刚改过的偏好'});
      return {ok:true,json:async()=>({output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({proposals:[proposal(p)]})}]}]})};}});
    const p=plan();fs.unlinkSync(path.join(home,'sessions',a.sid+'.json'));const deleted=i.applyMemoryReview(p,[proposal(p)]);
    return {result,deleted,cursor:m.memoryMeta('idle_cursor:'+a.sid),items:m.listMemory().map(x=>x.content)};`);
  assert.equal(r.result.skipped,'interrupted');assert.equal(r.deleted.error,'changed');assert.equal(r.cursor,null);
  assert.deepEqual(r.items,['站长刚改过的偏好']);
});
