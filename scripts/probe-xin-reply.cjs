// Bounded synthetic production probe. Never print user chat, model text, memory paths or credentials.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{spawnSync}=require('node:child_process');
const base='/data/home/.xin',agent=process.argv[1]||path.join(base,'agent/vm-agent-158f619f9dcc.mjs'),mode=process.argv[2]||'deepseek';
const unique=crypto.randomBytes(6).toString('hex'),root='/data/workspace/.xin-reply-diag/'+unique;
fs.mkdirSync(root,{recursive:true,mode:0o700});
const markers=['front-'+unique,'generation-original-'+unique,'generation-current-'+unique],trace=path.join(root,'counts.jsonl');
const observer=`import fs from 'node:fs';const original=globalThis.fetch;const markers=${JSON.stringify(markers)},file=${JSON.stringify(trace)};
globalThis.fetch=async function(url,init){const response=await original.apply(this,arguments);let body;try{body=JSON.parse(init?.body);}catch{return response;}
if(!String(url).endsWith('/responses')||!Array.isArray(body?.input))return response;
const last=[...body.input].reverse().find(x=>x.role==='user');const current=typeof last?.content==='string'?last.content:JSON.stringify(last?.content||'');
if(!markers.some(m=>current.includes(m)))return response;
try{const data=await response.clone().json(),said=(data.output||[]).filter(x=>x.type==='message').flatMap(x=>x.content||[]).filter(x=>x.type==='output_text').map(x=>x.text).join('\\n');
fs.appendFileSync(file,JSON.stringify({input:markers.map(m=>current.includes(m)),response:markers.map(m=>said.includes(m)),bytes:Buffer.byteLength(said),status:data.status,reason:data.incomplete_details?.reason,types:(data.output||[]).map(x=>x.type),usage:data.usage})+'\\n');}catch{}
return response;};`;
const env={...process.env,HOME:'/data/home',XIN_HOME:base,XIN_WORK:root,XIN_FRONT_PROVIDER:mode==='native'?'':'deepseek',NODE_OPTIONS:(process.env.NODE_OPTIONS||'')+' --import=data:text/javascript;base64,'+Buffer.from(observer).toString('base64')};
const call=(op,args)=>{const r=spawnSync('node',[agent,op],{env,input:JSON.stringify(args),encoding:'utf8',timeout:18000,maxBuffer:2*1024*1024});
if(r.status!==0)throw Error('controller_exit');const out=JSON.parse(r.stdout);if(out.error)throw Error('controller_'+out.error);return out;};
const delay=ms=>new Promise(r=>setTimeout(r,ms)),created=[];
const wait=async run=>{const until=Date.now()+(mode==='native'?110000:40000);while(Date.now()<until){const r=call('poll',{run,off:0});if(r.done)return {done:true,events:r.events||[]};await delay(400);}throw Error('specific_run_timeout');};
const evidence=(result)=>{const es=result.events,said=es.filter(e=>e.t==='text').map(e=>e.text||'').join('\n');return {done:result.done,types:es.map(e=>e.t),text:markers.map(m=>said.includes(m)),bytes:Buffer.byteLength(said),finish:es.filter(e=>e.t==='done').map(e=>({ok:e.ok,model:e.model,stopped:e.stopped})),errorTypes:es.filter(e=>e.t==='err').map(e=>/Opus|Antigravity|ACP/.test(e.text)?'opus_interface':/前台.*回复|格式/.test(e.text)?'reply_format':'other')};};
(async()=>{const out={};try{
if(mode==='inspect'){
 const memory=await import('file://'+path.join(base,'agent/vm-memory-5d8065faa2c7.mjs')),db=memory.memoryDb();
 out.memoryCounts=db.prepare('SELECT status,type,count(*) AS n FROM memory_items GROUP BY status,type').all();
 const rows=db.prepare("SELECT id,content FROM memory_items WHERE status='private' AND source='legacy' AND (content LIKE '%网关%' OR content LIKE '%签到%') LIMIT 3").all();
 out.gatewayPreview=rows.map(r=>{const safe=r.content.replace(/https?:\/\/[^\s，。；、）)\]】<>"'`]+|(?:[A-Za-z]:[\\/]|~?\/)[^\s，。；、）)\]】<>"'`]+/g,p=>/^https?:\/\//i.test(p)?p:/^(?:[A-Za-z]:|~|\/(?:data|home|root|workspace|tmp|etc|opt|var|mnt|run|srv)\/)|password|passwd|credential|secret|密码|口令|\.key(?:\W|$)/i.test(p)?'（路径已省略）':p);return {id:r.id,digest:crypto.createHash('sha256').update(r.content).digest('hex'),sanitized:memory.memorySensitivity(safe)==='value'?'（仍有敏感内容，未输出）':safe};});
 const binary=['/data/home/.local/bin/agy','/data/home/.gemini/bin/agy'].find(p=>fs.existsSync(p));
 if(binary){const cli=args=>spawnSync(binary,args,{env:{HOME:'/data/home',PATH:process.env.PATH||'/usr/local/bin:/usr/bin:/bin',LANG:'C.UTF-8'},encoding:'utf8',timeout:18000,maxBuffer:2*1024*1024});
 const help=cli(['acp','--help']),models=cli(['-p','/model','--output-format','stream-json']);
 out.nativeCapabilities={acpHelpOk:help.status===0,acpSettings:help.stdout?.includes('--settings'),acpAgent:help.stdout?.includes('--agent'),modelQueryOk:models.status===0};
 const ids=new Set();for(const line of (models.stdout||'').split('\n'))try{const o=JSON.parse(line);const visit=x=>{if(typeof x==='string'&&/^(?:claude[-./_a-z0-9]*opus[-./_a-z0-9]*|Claude Opus )4[.-]6(?:$|[ ._-]Thinking$)/i.test(x))ids.add(x);else if(x&&typeof x==='object')for(const v of Object.values(x))visit(v);};visit(o);}catch{}
 out.nativeCapabilities.opusModels=[...ids];
 }
}
if(!fs.existsSync(agent))throw Error('missing_bundle');
const initial=call('send',{agent:'codex',text:'只回复 '+markers[0]+'，不要执行命令、派任务或记忆。'});created.push(initial.sid);
out.initial=evidence(await wait(initial.run));
if(mode==='native')return;
const old=call('send',{sid:initial.sid,text:'只回复 '+markers[1]+'，不要执行命令、派任务或记忆。'});
const current=call('send',{agent:'codex',text:'只回复 '+markers[2]+'，不要执行命令、派任务或记忆。'});created.push(current.sid);
const results=await Promise.all([wait(old.run),wait(current.run)]);out.original=evidence(results[0]);out.current=evidence(results[1]);
const history=call('history',{sid:initial.sid}),saved=history.runs.find(r=>r.run===old.run);out.originalHistory=evidence(saved);
}catch(e){out.error=/^[a-z_]+$/.test(e.message)?e.message:'probe_failed';}
finally{
try{out.responses=fs.readFileSync(trace,'utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l));}catch{out.responses=[];}
for(const sid of created){try{const h=call('history',{sid});for(const r of h.runs||[])if(!r.done)call('stop',{run:r.run});for(const t of h.tasks||[])if(!['done','failed','stopped'].includes(t.status))call('task_stop',{sid:t.sid});await delay(300);call('forget',{sid});}catch{out.cleanupPending=true;}}
// The credential-free data-URI observer needs no persistent module. Only our trace directory is removed.
try{fs.rmSync(root,{recursive:true,force:true});}catch{}
process.stdout.write(JSON.stringify(out));
}})();
