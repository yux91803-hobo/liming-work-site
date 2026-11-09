// Controller-owned transaction journal. JSON/JSONL remain compatible projections.
// A committed input, its metadata changes, launch intent and reply are recovered together.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export const inputDigest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
export class StateJournal {
  constructor(root) { this.root=path.resolve(root);this.active=false;this.overlay=new Map();this.after=[]; }
  get db(){
    if(this.connection)return this.connection;
    fs.mkdirSync(this.root,{recursive:true,mode:0o700});
    // A new controller request can interrupt optional compaction before it waits on SQLite.
    let activity;try{activity=fs.openSync(path.join(this.root,'.state-access'),fs.constants.O_CREAT|fs.constants.O_WRONLY|fs.constants.O_TRUNC|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK,0o600);if(fs.fstatSync(activity).isFile())fs.writeSync(activity,crypto.randomBytes(16).toString('hex'));}catch{}finally{if(activity!==undefined)fs.closeSync(activity);}
    const file=path.join(this.root,'workflow.sqlite');
    if(fs.existsSync(file)&&fs.lstatSync(file).isSymbolicLink())throw Error('状态库不能是软链接');
    const d=new DatabaseSync(file);fs.chmodSync(file,0o600);
    d.exec('PRAGMA busy_timeout=15000');
    // Concurrent first opens race on WAL setup and schema creation, which can report busy without
    // waiting. Every statement below is idempotent: retry briefly, and cache the connection only once ready.
    for(let attempt=0;;attempt++)try{
    d.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS documents (name TEXT PRIMARY KEY, body TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, dirty INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS appends (id TEXT PRIMARY KEY, name TEXT NOT NULL, body TEXT NOT NULL, projected INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS commands (id TEXT PRIMARY KEY, digest TEXT NOT NULL, result TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS launches (run TEXT PRIMARY KEY, sid TEXT NOT NULL, lane INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, dispatchedAt INTEGER NOT NULL DEFAULT 0, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS handoffs (id TEXT PRIMARY KEY, parent TEXT NOT NULL, task TEXT NOT NULL, version TEXT NOT NULL, payload TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, nextAt INTEGER NOT NULL, run TEXT);
      CREATE INDEX IF NOT EXISTS pending_launches ON launches(state,lane,at);
      CREATE INDEX IF NOT EXISTS pending_handoffs ON handoffs(state,nextAt,parent);`);
    if(!d.prepare('PRAGMA table_info(launches)').all().some(c=>c.name==='attempts'))d.exec('ALTER TABLE launches ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0');
    if(!d.prepare('PRAGMA table_info(launches)').all().some(c=>c.name==='dispatchedAt'))d.exec('ALTER TABLE launches ADD COLUMN dispatchedAt INTEGER NOT NULL DEFAULT 0');
    break;
    }catch(e){
      if(![5,6].includes(e.errcode)&&!/duplicate column/.test(e.message)||attempt>=60){d.close();throw e;}
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10+attempt*5);
    }
    return this.connection=d;
  }
  name(file){const n=path.relative(this.root,path.resolve(file));if(!n||n.startsWith('..')||path.isAbsolute(n))throw Error('状态投影越界');return n;}
  staged(file){if(!this.active)return;try{return this.overlay.get(this.name(file));}catch{return;}}
  stagedNames(prefix){return [...this.overlay.keys()].filter(n=>n.startsWith(prefix));}
  atomic(fn,command){
    if(this.active)return fn();
    const d=this.db;d.exec('BEGIN IMMEDIATE');this.active=true;this.overlay.clear();this.after=[];this.eventSequence=0;this.operation=command?.id||crypto.randomUUID();
    let result;
    try{
      if(command){const old=d.prepare('SELECT digest,result FROM commands WHERE id=?').get(command.id);if(old){
        if(old.digest!==command.digest){d.exec('ROLLBACK');return {error:'message_conflict',msg:'同一个消息标识对应了不同内容，请重新发送'};}
        result=JSON.parse(old.result);d.exec('COMMIT');return result;
      }}
      result=fn();if(result&&typeof result.then==='function')throw Error('状态事务不能等待网络或异步任务');
      if(result?.error){d.exec('ROLLBACK');return result;}
      if(command)d.prepare('INSERT INTO commands(id,digest,result,at) VALUES(?,?,?,?)').run(command.id,command.digest,JSON.stringify(result??{}),Date.now());
      d.exec('COMMIT');
    }catch(e){try{d.exec('ROLLBACK');}catch{}throw e;}
    finally{this.active=false;this.overlay.clear();}
    const after=this.after;this.after=[];this.recover();for(const f of after)f();return result;
  }
  write(file,body){
    if(!this.active)return this.atomic(()=>this.write(file,body));
    const n=this.name(file);this.overlay.set(n,body);
    this.db.prepare('INSERT INTO documents(name,body) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET body=excluded.body,revision=revision+1,dirty=1').run(n,body);
  }
  append(file,event){
    if(!this.active)return this.atomic(()=>this.append(file,event));
    const id=this.operation+':'+this.eventSequence++,body=JSON.stringify({...event,_eventId:id});
    this.db.prepare('INSERT OR IGNORE INTO appends(id,name,body) VALUES(?,?,?)').run(id,this.name(file),body);
  }
  defer(fn){if(this.active)this.after.push(fn);else fn();}
  recover(){
    if(this.active)return;
    const d=this.db;d.exec('BEGIN IMMEDIATE');
    try{
      for(const x of d.prepare('SELECT * FROM documents WHERE dirty=1 ORDER BY name').all()){
        const file=path.join(this.root,x.name);this.name(file);fs.mkdirSync(path.dirname(file),{recursive:true});
        const tmp=file+'.journal-'+crypto.randomBytes(8).toString('hex');const fd=fs.openSync(tmp,'wx',0o600);
        try{fs.writeFileSync(fd,x.body);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(tmp,file);
        d.prepare('UPDATE documents SET dirty=0 WHERE name=? AND revision=?').run(x.name,x.revision);
      }
      for(const x of d.prepare('SELECT * FROM appends WHERE projected=0 ORDER BY rowid').all()){
        const file=path.join(this.root,x.name);this.name(file);fs.mkdirSync(path.dirname(file),{recursive:true});
        let existing='';try{existing=fs.readFileSync(file,'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}
        const marker='"_eventId":'+JSON.stringify(x.id);
        if(!existing.split('\n').some(line=>line.includes(marker))){const fd=fs.openSync(file,'a',0o600);try{fs.writeFileSync(fd,x.body+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
        d.prepare('UPDATE appends SET projected=1 WHERE id=?').run(x.id);
      }
      d.exec('COMMIT');
    }catch(e){d.exec('ROLLBACK');throw e;}
  }
  enqueueLaunch(run,sid,lane=0){this.db.prepare('INSERT OR IGNORE INTO launches(run,sid,lane,at) VALUES(?,?,?,?)').run(run,sid,lane,Date.now());}
  pendingLaunches(){return this.db.prepare("SELECT * FROM launches WHERE state='pending' ORDER BY lane,at LIMIT 32").all();}
  dispatched(run){this.db.prepare("UPDATE launches SET state='dispatched',attempts=attempts+1,dispatchedAt=? WHERE run=?").run(Date.now(),run);}
  launchRecord(run){return this.db.prepare('SELECT * FROM launches WHERE run=?').get(run);}
  launchedRuns(){return this.db.prepare("SELECT * FROM launches WHERE state='dispatched' ORDER BY at LIMIT 128").all();}
  finishLaunch(run){this.db.prepare("UPDATE launches SET state='finished' WHERE run=?").run(run);}
  hasOpenLaunches(){return !!this.db.prepare("SELECT 1 FROM launches WHERE state IN ('pending','dispatched') LIMIT 1").get();}
  enqueueHandoff({id,parent,task,version,payload}){
    this.db.prepare('INSERT OR IGNORE INTO handoffs(id,parent,task,version,payload,nextAt) VALUES(?,?,?,?,?,?)').run(id,parent,task,version,JSON.stringify(payload),Date.now());
  }
  handoff(id){const r=this.db.prepare('SELECT * FROM handoffs WHERE id=?').get(id);return r?{...r,payload:JSON.parse(r.payload)}:null;}
  dueHandoffs(){return this.db.prepare("SELECT id,parent,task,state,run FROM handoffs WHERE state IN ('pending','running') AND nextAt<=? ORDER BY nextAt LIMIT 16").all(Date.now());}
  startHandoff(id,run){this.db.prepare("UPDATE handoffs SET state='running',run=?,attempts=attempts+1,nextAt=? WHERE id=? AND state='pending'").run(run,Date.now()+5000,id);}
  settleHandoff(id,state){if(!['delivered','continued','silent','superseded','cancelled'].includes(state))throw Error('无效交接结果');this.db.prepare('UPDATE handoffs SET state=?,nextAt=0 WHERE id=?').run(state,id);}
  retryHandoff(id){this.db.prepare("UPDATE handoffs SET state='pending',run=NULL,nextAt=? WHERE id=? AND state='running'").run(Date.now()+5000,id);}
  hasPendingHandoffs(){return !!this.db.prepare("SELECT 1 FROM handoffs WHERE state IN ('pending','running') LIMIT 1").get();}
  handoffCount(){return this.db.prepare("SELECT COUNT(DISTINCT parent) AS n FROM handoffs WHERE state IN ('pending','running')").get().n;}
  dropConversation(sid,runs=[]){
    return this.atomic(()=>{
      const names=['sessions/'+sid+'.json','contexts/'+sid+'.json'];
      for(const r of runs){for(const row of this.db.prepare('SELECT name FROM documents WHERE name GLOB ?').all('runs/'+r+'.*'))names.push(row.name);this.db.prepare('DELETE FROM appends WHERE name=?').run('runs/'+r+'.jsonl');}
      for(const name of names){this.overlay.delete(name);this.db.prepare('DELETE FROM documents WHERE name=?').run(name);}
      this.db.prepare('DELETE FROM launches WHERE sid=?').run(sid);
      this.db.prepare('DELETE FROM handoffs WHERE parent=? OR task=?').run(sid,sid);
      this.db.prepare("DELETE FROM commands WHERE json_extract(result,'$.sid')=? OR json_extract(result,'$.task.sid')=? OR json_extract(result,'$.task.parent')=?").run(sid,sid,sid);
    });
  }
  close(){this.connection?.close();this.connection=null;}
}
