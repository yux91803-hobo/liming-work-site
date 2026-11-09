// Inspect only the known synthetic deployment turn. Never print prompts, replies or owner memories.
const fs=require('node:fs'),path=require('node:path'),base='/data/home/.xin',out={matches:[]};
const expected='你让 Kimi 去画个奶龙。做成可爱的动画互动网页：黄色圆滚滚的小恐龙、大眼睛，可以点按钮跳舞和挥手，适合手机。不使用任何外部资源。请直接制作，不要先讨论。';
const read=p=>{try{return JSON.parse(fs.readFileSync(p,'utf8'));}catch{return null;}};
for(const name of fs.readdirSync(path.join(base,'runs'))){
 if(!/^r[0-9a-z]{6,24}\.json$/.test(name))continue;
 const file=path.join(base,'runs',name),st=fs.statSync(file);if(st.mtimeMs<Date.parse('2026-11-09T08:17:00Z')||st.mtimeMs>Date.parse('2026-11-09T08:19:00Z'))continue;
 const m=read(file);if(m?.frontRequest!==expected||m.task||m.agent!=='codex')continue;
 const es=(()=>{try{return fs.readFileSync(file.replace(/\.json$/,'.jsonl'),'utf8').split('\n').flatMap(l=>{try{return [JSON.parse(l)];}catch{return [];}});}catch{return [];}})(),texts=es.filter(e=>e.t==='text'),reply=texts.map(e=>e.text||'').join('\n'),done=es.findLast(e=>e.t==='done'),receipt=read(file.replace(/\.json$/,'.front.json'));
 out.matches.push({runSeconds:(Number(m.ended)-Number(m.started))/1000,model:m.model,providerModel:m.providerModel,doneOk:!!done?.ok,doneModel:done?.model,replyBytes:Buffer.byteLength(reply),firstPerson:reply.includes('我'),leaks:['kimi','deepseek','分身','任务编号'].filter(w=>reply.toLowerCase().includes(w)),taskCreated:!!receipt?.task,receiptTerminal:!!receipt?.terminal,eventCounts:Object.fromEntries([...new Set(es.map(e=>e.t))].map(t=>[t,es.filter(e=>e.t===t).length]))});
}
process.stdout.write(JSON.stringify(out));
