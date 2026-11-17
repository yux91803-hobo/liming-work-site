// 前台接补充（docs/superpowers/specs/2026-11-17-xin-steer-design.md §3）：兄弟这句像是在补充、改主意、要停或要接着做时才附 <手上的事>；
// 认出是哪件事转过去，回话按实际接法只说一次；做完、停了的先报状态，明确说继续才接着做。前台用脚本回话（test/helpers/front-responses.cjs）。
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{execFileSync}=require('node:child_process');
const { platformTimeout } = require('./helpers/timeout.cjs');
const { stopOwned } = require('./helpers/stop-owned.cjs');
const { fakeAgy } = require('./helpers/fake-agy.cjs');
const agent=path.join(__dirname,'../site/xin/vm-agent.mjs');

function fixture(t,agyScript,frontScript){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'xin-steer-front-')),xin=root+'/xin',profile=root+'/profile',bin=root+'/bin';
 for(const p of [xin,profile,bin])fs.mkdirSync(p,{recursive:true});
 const preload=root+'/preload.cjs';fs.writeFileSync(preload,'require("node:os").homedir=()=>'+JSON.stringify(profile)+';require("node:module").syncBuiltinESMExports();');
 fs.writeFileSync(root+'/script.json',JSON.stringify(agyScript));fs.writeFileSync(root+'/front-script.json',JSON.stringify(frontScript));
 fs.writeFileSync(bin+'/agy',fakeAgy(root),{mode:0o755});
 const env={...process.env,PATH:bin+':'+process.env.PATH,NODE_OPTIONS:'--require='+preload+' --require='+path.join(__dirname,'helpers/front-responses.cjs'),XIN_HOME:xin,XIN_WORK:root+'/work',
  CODEX_HOME:profile+'/.codex',XIN_AGY_HOME:profile,XIN_ANTIGRAVITY_BIN:bin+'/agy',XIN_CODEX_TRANSPORT:'exec',XIN_TASK_SANDBOX:'0',XIN_AGY_IDLE_MS:'60000',
  XIN_FRONT_TEST_LOG:root+'/front.jsonl',XIN_FRONT_TEST_SCRIPT:root+'/front-script.json'};
 const op=(name,args)=>JSON.parse(execFileSync(process.execPath,[agent,name],{env,input:JSON.stringify(args||{})}).toString());
 t.after(()=>stopOwned(xin,root));
 const until=async(fn,what,ms=15000)=>{let v;for(const end=performance.now()+platformTimeout(ms);performance.now()<end;){v=fn();if(v)return v;await new Promise(r=>setTimeout(r,40));}assert.fail('等不到：'+what);};
 // 发一句、等这一轮做完，返回这一轮的事件
 const say=async(sid,text)=>{const r=op('send',{agent:'codex',...(sid?{sid}:{}),text});await until(()=>op('poll',{run:r.run,off:0}).done,'前台回话');return {...r,events:op('poll',{run:r.run,off:0}).events};};
 const idle=sid=>until(()=>{const h=op('history',{sid});return !h.active&&h;},'对话空闲');
 const fronts=()=>fs.readFileSync(root+'/front.jsonl','utf8').trim().split('\n').map(JSON.parse);
 const input=req=>JSON.stringify(req.input);
 const task=sid=>op('tasks',{sid}).tasks[0];
 const calls=()=>fs.existsSync(root+'/calls.jsonl')?fs.readFileSync(root+'/calls.jsonl','utf8').trim().split('\n').map(JSON.parse):[];
 return {root,op,until,say,idle,fronts,input,task,calls,at:n=>until(()=>fs.existsSync(root+'/at-'+n),'第 '+n+' 次请求'),go:n=>fs.writeFileSync(root+'/go-'+n,'')};
}
const reply=events=>events.filter(e=>e.t==='text').map(e=>e.text).join('\n');

test('任务在做：兄弟补一句，前台看到 <手上的事>（写着能接进这一轮），转给那件事，用自己预先写好的话回一句；聊别的不附',async t=>{
 const f=fixture(t,[{action:'shell',command:'echo alpha-main >> list.txt',gate:true},{action:'final',text:'只列了启用的'}],[
  {when:'备用的别列',text:'行，最后只给你列正在用的',calls:[['xin','task','tell','1','备用的别列，只列实际启用的']]}]);
 const first=await f.say(null,'TEST_DISPATCH');
 await f.at(1);
 // 聊别的：不附 <手上的事>，不带进行中（#117）
 const chat=await f.say(first.sid,'只回复 陀螺 茶壶 贝壳，不要执行命令，也不要等待后台。');
 const chatReq=f.fronts().at(-1);
 assert.ok(!f.input(chatReq).includes('<手上的事>')&&!f.input(chatReq).includes('进行中（'),f.input(chatReq).slice(-300));
 assert.equal(reply(chat.events),'好的');
 // 补一句：附 <手上的事>，转给任务 1；回话就是前台预先写好的那句（接法和快照对得上），只说一次
 const steer=await f.say(first.sid,'刚才那件事，备用的别列，只列实际启用的');
 const req=f.fronts().at(-1),hands=req.input.find(m=>typeof m.content==='string'&&m.content.startsWith('<手上的事>\n'));
 assert.ok(hands&&/- 任务 1「编译 LED」在做（\d+ 分钟）：补充能接进正在做的这一轮，它下一步就按新要求来/.test(hands.content)&&hands.content.endsWith('\n</手上的事>'),JSON.stringify(hands));
 assert.ok(req.input.indexOf(hands)<req.input.length-1&&req.input.at(-1).content.includes('备用的别列'),'兄弟的原话是最后一条');
 assert.equal(reply(steer.events),'行，最后只给你列正在用的');
 assert.ok(f.fronts().at(-1).input.at(-1).content.includes('备用的别列'),'补充那一轮之后没有再要一句');
 f.go(1);
 await f.until(()=>f.task(first.sid).status==='done','任务做完');
 const c=f.calls();assert.ok(c[1].prompt.includes('【兄弟刚补充了要求】')&&c[1].prompt.includes('备用的别列，只列实际启用的'),c[1].prompt.slice(0,160));
});

test('做完了的事：补充不重新开工，前台先说状态问要不要接着做；兄弟明确说继续，带着之前的补充接着做',async t=>{
 const f=fixture(t,[{action:'final',text:'名单：alpha-main、beta-backup'},{action:'final',text:'只列启用的：alpha-main'}],[
  {when:'再加一条只列启用的',text:'行',calls:[['xin','task','tell','1','再加一条：只列启用的']]},
  {when:'再加一条只列启用的',text:'那件事已经做完了，名单里还有备用的。要我按只列启用的再筛一遍吗？'},
  {when:'要，接着做吧',text:'好，我按只列启用的再筛一遍',calls:[['xin','task','tell','1','--continue','要，接着做吧']]}]);
 const first=await f.say(null,'TEST_DISPATCH');
 await f.until(()=>f.task(first.sid).status==='done','做完');
 await f.idle(first.sid);
 const ask=await f.say(first.sid,'刚才那件事，再加一条只列启用的');
 const req=f.fronts().at(-1);
 assert.match(f.input(req),/任务 1「编译 LED」做完了：已经结束，兄弟明确说继续才接着做（用 --continue）/);
 assert.equal(reply(ask.events),'那件事已经做完了，名单里还有备用的。要我按只列启用的再筛一遍吗？');
 // tell 的回执（没有接着做）交回了前台，前台按它重新说了一句
 assert.ok(req.input.some(x=>x.type==='function_call_output'&&JSON.parse(x.output).ended===true&&JSON.parse(x.output).status==='done'),'回执说已经结束');
 const still=f.op('history',{sid:f.task(first.sid).sid}).task;assert.equal(still.status,'done');assert.equal(still.inbox,1,'补充记下了，接着做时带上');
 assert.equal(f.calls().length,1,'没有重新开工');
 const go=await f.say(first.sid,'要，接着做吧');
 assert.equal(reply(go.events),'好，我按只列启用的再筛一遍');
 await f.until(()=>f.calls().length===2&&f.task(first.sid).status==='done','接着做完');
 const resumed=f.calls()[1].prompt;
 assert.ok(resumed.includes('兄弟之前补充过')&&resumed.includes('再加一条：只列启用的')&&resumed.includes('要，接着做吧'),resumed.slice(0,300));
});

test('没附 <手上的事>（这句没有补充的说法）却转了补充：不用预先写好的话，带着实际接法再要一句',async t=>{
 const f=fixture(t,[{action:'shell',command:'echo a >> list.txt',gate:true},{action:'final',text:'好了'}],[
  {when:'蓝灯也算上',text:'好的我记下了',calls:[['xin','task','tell','1','蓝灯也算上']]},
  {when:'补充已经接进它正在做的这一轮',text:'行，最后把蓝灯也算上'}]);
 const first=await f.say(null,'TEST_DISPATCH');
 await f.at(1);
 const r=await f.say(first.sid,'蓝灯也算上');
 assert.equal(reply(r.events),'行，最后把蓝灯也算上');
 const own=f.fronts().at(-1),last=own.input.at(-1).content;
 assert.match(last,/补充已经接进它正在做的这一轮/);assert.equal(own.tool_choice,'none');
 assert.ok(own.input.some(x=>x.type==='function_call_output'&&JSON.parse(x.output).delivery==='now'),'回执带实际接法');
 f.go(1);
 await f.until(()=>f.task(first.sid).status==='done','做完');
});
