// 后台补充测试共用的假 agy、假 codex（test/xin-steer.test.cjs、test/xin-steer-front.test.cjs）。
// 假 agy：每次（不算查额度）按 script.json 的第 n 项回；gate 的那一步写下 at-n 后一直等，直到测试放行（go-n）；
// 每次请求的提示词记进 calls.jsonl。quota 的那一步回额度用尽，之后查额度也是 0。
function fakeAgy(root){
 return '#!'+process.execPath+'\n'+`const fs=require('node:fs'),a=process.argv.slice(2),dir=${JSON.stringify(root)};
const prompt=a[a.indexOf('-p')+1],send=o=>console.log(JSON.stringify(o)),out=fs.existsSync(dir+'/quota-out');
if(prompt==='/usage'){send({event:'result',result:{status:'SUCCESS',command:{data:{groups:[{buckets:[{id:'gemini-5h',remaining_fraction:out?0:1,reset_time:new Date(Date.now()+3600000).toISOString()},{id:'gemini-weekly',remaining_fraction:1,reset_time:new Date(Date.now()+604800000).toISOString()}]},{buckets:[{id:'gemini-argon-wtu-weekly',remaining_fraction:out?0:1,reset_time:new Date(Date.now()+604800000).toISOString()}]}]}}}});process.exit(0);}
fs.appendFileSync(dir+'/calls.jsonl',JSON.stringify({prompt,conversation:a.includes('--conversation')})+'\\n');
const n=fs.readFileSync(dir+'/calls.jsonl','utf8').trim().split('\\n').length,script=JSON.parse(fs.readFileSync(dir+'/script.json','utf8')),step=script[Math.min(n,script.length)-1];
send({event:'init',init:{model:a[a.indexOf('--model')+1]}});
const reply=()=>{
 if(step.quota){fs.writeFileSync(dir+'/quota-out','');send({event:'result',result:{conversation_id:'12345678-1234-1234-1234-123456789abc',status:'ERROR',response:'RESOURCE_EXHAUSTED quota'}});process.exit(0);}
 send({event:'result',result:{conversation_id:'12345678-1234-1234-1234-123456789abc',status:'SUCCESS',structured_output:{action:step.action,command:step.command||'',text:step.text||''},usage:{input_tokens:10*n,output_tokens:5*n,total_tokens:15*n}}});process.exit(0);
};
fs.writeFileSync(dir+'/at-'+n,'');
if(step.gate){const iv=setInterval(()=>{if(fs.existsSync(dir+'/go-'+n)){clearInterval(iv);reply();}},20);}else reply();`;
}
// 假 codex（exec）：Gemini 额度用完后接手的模型，或点名的 Codex 线路模型；codex-gate 在时等到 codex-go 才回
function fakeCodex(root){
 return '#!'+process.execPath+'\n'+`const fs=require('node:fs'),dir=${JSON.stringify(root)};fs.appendFileSync(dir+'/codex.args',JSON.stringify(process.argv.slice(2))+'\\n');
const done=()=>{console.log(JSON.stringify({type:'turn.started'}));console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'接手的模型做完了'}}));process.exit(0);};
if(fs.existsSync(dir+'/codex-gate')){fs.writeFileSync(dir+'/codex-at','');const iv=setInterval(()=>{if(fs.existsSync(dir+'/codex-go')){clearInterval(iv);done();}},20);}else done();`;
}
module.exports = { fakeAgy, fakeCodex };
