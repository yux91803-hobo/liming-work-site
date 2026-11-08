// One-time owner-authorized edit: only these two unchanged private legacy records. No panel login.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{spawnSync}=require('node:child_process');
const base='/data/home/.xin',hash=s=>crypto.createHash('sha256').update(s).digest('hex');
const expected=new Map([['mmw7hth5885acc276','df2a50f42ccd4d16ee304166b250940edbbb89ee511c72311b5352ec1b13f5eb'],['mmw7hth59ae1746d1','15b74bf34260a97ff34cc26f2988d44be6dbac2fc8a51764de67dbb078887573']]);
(async()=>{
 process.env.XIN_HOME=base;
 const m=await import('file://'+base+'/agent/vm-memory-12a079b3512c.mjs'),{journal}=await import('file://'+base+'/agent/vm-base-5fd0c2483782.mjs'),d=m.memoryDb();
 const memory=journal.atomic(()=>{
  const rows=[...expected].map(([id])=>d.prepare('SELECT * FROM memory_items WHERE id=?').get(id));
  if(rows.some(r=>!r||r.status!=='private'||r.source!=='legacy'||hash(r.content)!==expected.get(r.id)))return {changed:0,requiresReview:true};
  const changed=[];let editedContent=0;
  for(const r of rows){
   const text=r.content.replace(/[（(][^）)]*(?:密码|口令|凭据文件|password|passwd)[^）)]*[）)]/gi,'')
    .replace(/(?:~\/[\w./-]+|\/(?:data|home|root|workspace|tmp|etc|opt|var|mnt|run|srv)\/[^\s，。；、）)\]】<>"'`]+)/g,'（凭据位置已移除）').replace(/\s+/g,' ').trim();
   if(m.memorySensitivity(text)==='value')throw Error('sanitized_item_still_sensitive');
   const result=m.updateMemory(r.id,{content:text,private:false,confirm:true});if(result.error)throw Error('owner_memory_edit_refused');
   editedContent+=text!==r.content?1:0;changed.push(result.item);
  }
  const front=m.coreMemory('front'),daily=m.coreMemory('daily');
  return {changed:changed.length,editedContent,activeUnsorted:d.prepare("SELECT count(*) n FROM memory_items WHERE status='active' AND type='unsorted'").get().n,
   frontSeesEdited:changed.filter(r=>front.includes(r.content)).length,dailySeesEdited:changed.filter(r=>daily.includes(r.content)).length};
 });
 const read=file=>{try{return fs.readFileSync(file,'utf8');}catch{return '';}};
 const errors=read(path.join(base,'logs/front.jsonl')).split('\n').flatMap(l=>{try{return [JSON.parse(l)];}catch{return [];}})
  .filter(e=>e.at>=Date.parse('2026-11-08T18:27:00Z')&&e.at<Date.parse('2026-11-08T18:29:00Z')&&e.outcome==='error')
  .map(e=>({badFrontModel:e.error==='bad_front_model',quota:/额度|quota/i.test(e.error||''),unsupportedACP:/不支持.*ACP/i.test(e.error||''),missingOpus:/没有提供.*(?:Opus|Claude)/i.test(e.error||''),replyFormat:/回复格式|回复字段|有效.*JSON/i.test(e.error||''),filesystem:/ENOENT|EACCES|ENOTDIR/.test(e.error||'')}));
 const binary=['/data/home/.local/bin/agy','/data/home/.gemini/bin/agy'].find(p=>fs.existsSync(p)),capabilities={};
 if(binary){
  const run=args=>spawnSync(binary,args,{cwd:path.join(base,'front-antigravity'),env:{HOME:'/data/home',PATH:process.env.PATH||'/usr/local/bin:/usr/bin:/bin',LANG:'C.UTF-8'},encoding:'utf8',timeout:18000,maxBuffer:2*1024*1024});
  for(const [kind,args] of [['help',['acp','--help']],['models',['-p','/model','--output-format','stream-json']],['usage',['-p','/usage','--output-format','stream-json']]]){
   const r=run(args),ids=new Set(),keys=new Set(),buckets=[];
   const walk=(x,p='')=>{if(typeof x==='string'&&/(?:claude|opus)/i.test(x)&&/^[a-zA-Z0-9 _.,()/+-]{1,140}$/.test(x))ids.add(x);
    else if(x&&typeof x==='object'){if(typeof x.id==='string'&&Object.hasOwn(x,'remaining_fraction'))buckets.push({id:x.id,remaining:x.remaining_fraction,reset:x.reset_time});for(const [k,v] of Object.entries(x)){if(p.split('.').length<4)keys.add(p+'.'+k);walk(v,p+'.'+k);}}};
   for(const l of (r.stdout||'').split('\n'))try{walk(JSON.parse(l));}catch{}
   capabilities[kind]={exit:r.status,stdoutBytes:Buffer.byteLength(r.stdout||''),stderrBytes:Buffer.byteLength(r.stderr||''),flags:Object.fromEntries(['--agent','--settings','--input-format','--acp'].map(f=>[f,(r.stdout||'').includes(f)||(r.stderr||'').includes(f)])),models:[...ids],keys:[...keys].slice(0,70),buckets};
  }
 }
 process.stdout.write(JSON.stringify({memory,errors,capabilities}));
})().catch(()=>{process.stdout.write(JSON.stringify({error:'maintenance_failed'}));process.exitCode=1;});
