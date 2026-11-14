// Controller-owned transaction journal. JSON/JSONL remain compatible projections.
// A committed input, its metadata changes, launch intent and reply are recovered together.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export const inputDigest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const SCHEMA = `CREATE TABLE IF NOT EXISTS documents (name TEXT PRIMARY KEY, body TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, dirty INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS appends (id TEXT PRIMARY KEY, name TEXT NOT NULL, body TEXT NOT NULL, projected INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS commands (id TEXT PRIMARY KEY, digest TEXT NOT NULL, result TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS launches (run TEXT PRIMARY KEY, sid TEXT NOT NULL, lane INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, dispatchedAt INTEGER NOT NULL DEFAULT 0, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS handoffs (id TEXT PRIMARY KEY, parent TEXT NOT NULL, task TEXT NOT NULL, version TEXT NOT NULL, payload TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, nextAt INTEGER NOT NULL, run TEXT);
      CREATE INDEX IF NOT EXISTS dirty_documents ON documents(name) WHERE dirty=1;
      CREATE INDEX IF NOT EXISTS unprojected_appends ON appends(projected) WHERE projected=0;
      CREATE INDEX IF NOT EXISTS pending_launches ON launches(state,lane,at);
      CREATE INDEX IF NOT EXISTS pending_handoffs ON handoffs(state,nextAt,parent);`;
const SCHEMA_NAMES = [...SCHEMA.matchAll(/CREATE (?:TABLE|INDEX) IF NOT EXISTS (\w+)/g)].map(m => m[1]);
export class StateJournal {
  constructor(root) { this.root=path.resolve(root);this.active=false;this.overlay=new Map();this.after=[];this.owner=null;this.writers=0;this.bridge=null; }
  // 所有写入口都从这里过（docs/superpowers/specs/2026-11-14-xin-kernel-stage2-design.md §6.2）：旧模式下拿着共享的所有权锁写，
  // 主人活着、或者该内核当主人但它不在，owner.enter() 会抛 owner_unavailable，这里就不写。一次最外层调用只问一次。
  // owner 为空（单独用 StateJournal 的测试）时不检查。
  writing(fn,unavailable){
    if(!this.owner||this.writers>0)return fn();
    if(!this.owner.owning&&!this.owner.depth&&unavailable&&this.bridge?.available?.())
      return unavailable(Object.assign(Error('owner_alive'),{code:'owner_unavailable'}));
    const held=this.owner.depth>0;let release;
    try{release=this.owner.enter();}catch(e){if(e.code==='owner_unavailable'&&unavailable)return unavailable(e);throw e;}
    this.writers++;
    try{return fn();}finally{
      this.writers--;
      // A writable handle must not survive the shared authority that allowed it to open.
      if(!this.writers&&!held&&!this.owner.owning)this.closeWriter();
      release();
    }
  }
  named(name,args,fn){return this.writing(()=>this.atomic(fn),e=>{if(!this.bridge)throw e;return this.bridge('named',{name,args});});}
  get writable(){return !this.owner||this.writers>0||this.owner.owning||this.owner.depth>0;}
  get db(){
    if(!this.writable){
      this.closeWriter();if(this.reader)return this.reader;
      const file=path.join(this.root,'workflow.sqlite');let stat;
      try{stat=fs.lstatSync(file);}catch(e){if(e.code!=='ENOENT')throw e;}
      if(stat?.isSymbolicLink())throw Error('状态库不能是软链接');
      if(!stat||!stat.size)this.writing(()=>this.db);
      let d=new DatabaseSync(file,{readOnly:true});
      try{
        d.exec('PRAGMA busy_timeout=15000');
        if(!this.schemaReady(d)){
          d.close();d=null;this.writing(()=>this.db);d=new DatabaseSync(file,{readOnly:true});d.exec('PRAGMA busy_timeout=15000');
        }
        return this.reader=d;
      }catch(e){d?.close();throw e;}
    }
    if(this.connection)return this.connection;
    const file=path.join(this.root,'workflow.sqlite');
    let stat;try{stat=fs.lstatSync(file);}catch(e){if(e.code!=='ENOENT')throw e;}
    if(stat?.isSymbolicLink())throw Error('状态库不能是软链接');
    // 打开缺失/空库本身就会写文件。先拿所有权，不能先创建了再在 recover 里拒绝。
    return !stat||stat.size===0?this.writing(()=>this.#open()):this.#open();
  }
  schemaReady(d){
    const names=new Set(d.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','index')").all().map(r=>r.name));
    const columns=new Set(d.prepare('PRAGMA table_info(launches)').all().map(c=>c.name));
    return SCHEMA_NAMES.every(n=>names.has(n))&&columns.has('attempts')&&columns.has('dispatchedAt')&&d.prepare('PRAGMA journal_mode').get().journal_mode==='wal';
  }
  #open(){
    fs.mkdirSync(this.root,{recursive:true,mode:0o700});
    const file=path.join(this.root,'workflow.sqlite');
    if(fs.existsSync(file)&&fs.lstatSync(file).isSymbolicLink())throw Error('状态库不能是软链接');
    const d=new DatabaseSync(file);
    try{
    fs.chmodSync(file,0o600);d.exec('PRAGMA busy_timeout=15000; PRAGMA synchronous=FULL');
    // Concurrent first opens race on WAL setup and schema creation, which can report busy without
    // waiting. Every statement below is idempotent: retry briefly, and cache the connection only once ready.
    for(let attempt=0;;attempt++)try{
    if(!this.schemaReady(d))this.writing(()=>{
      d.exec('PRAGMA journal_mode=WAL;'+SCHEMA);
      const latest=new Set(d.prepare('PRAGMA table_info(launches)').all().map(c=>c.name));
      if(!latest.has('attempts'))d.exec('ALTER TABLE launches ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0');
      if(!latest.has('dispatchedAt'))d.exec('ALTER TABLE launches ADD COLUMN dispatchedAt INTEGER NOT NULL DEFAULT 0');
    });
    break;
    }catch(e){
      if(![5,6].includes(e.errcode)&&!/duplicate column/.test(e.message)||attempt>=60)throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10+attempt*5);
    }
    return this.connection=d;
    }catch(e){d.close();throw e;}
  }
  name(file){const n=path.relative(this.root,path.resolve(file));if(!n||n.startsWith('..')||path.isAbsolute(n))throw Error('状态投影越界');return n;}
  staged(file){if(!this.active)return;try{return this.overlay.get(this.name(file));}catch{return;}}
  stagedNames(prefix){return [...this.overlay.keys()].filter(n=>n.startsWith(prefix));}
  atomic(fn,command){
    if(this.active)return fn();
    return this.writing(()=>this.commit(fn,command));
  }
  commit(fn,command){
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
    if(!this.active)return this.writing(()=>this.atomic(()=>this.write(file,body)),e=>{if(!this.bridge)throw e;return this.bridge('write',{name:this.name(file),body});});
    const n=this.name(file);this.overlay.set(n,body);
    this.db.prepare('INSERT INTO documents(name,body) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET body=excluded.body,revision=revision+1,dirty=1').run(n,body);
  }
  append(file,event){
    if(!this.active)return this.writing(()=>this.atomic(()=>this.append(file,event)),e=>{if(!this.bridge)throw e;return this.bridge('append',{name:this.name(file),event});});
    const id=this.operation+':'+this.eventSequence++,body=JSON.stringify({...event,_eventId:id});
    this.db.prepare('INSERT OR IGNORE INTO appends(id,name,body) VALUES(?,?,?)').run(id,this.name(file),body);
  }
  defer(fn){if(this.active)this.after.push(fn);else fn();}
  recover(){
    if(this.active)return;
    const d=this.db;
    // Every controller call starts here. With nothing committed-but-unprojected there is nothing to repair, so
    // a plain WAL read is enough and a reader never waits behind another process's write transaction.
    if(!d.prepare('SELECT 1 FROM documents WHERE dirty=1 LIMIT 1').get()&&!d.prepare('SELECT 1 FROM appends WHERE projected=0 LIMIT 1').get())return;
    return this.writing(()=>this.project());
  }
  project(){
    const d=this.db;
    d.exec('BEGIN IMMEDIATE');
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
  enqueueLaunch(run,sid,lane=0){this.writing(()=>this.db.prepare('INSERT OR IGNORE INTO launches(run,sid,lane,at) VALUES(?,?,?,?)').run(run,sid,lane,Date.now()));}
  pendingLaunches(){return this.db.prepare("SELECT * FROM launches WHERE state='pending' ORDER BY lane,at LIMIT 32").all();}
  dispatched(run){this.writing(()=>this.db.prepare("UPDATE launches SET state='dispatched',attempts=attempts+1,dispatchedAt=? WHERE run=?").run(Date.now(),run));}
  launchRecord(run){return this.db.prepare('SELECT * FROM launches WHERE run=?').get(run);}
  launchedRuns(){return this.db.prepare("SELECT * FROM launches WHERE state='dispatched' ORDER BY at LIMIT 128").all();}
  finishLaunch(run){this.writing(()=>this.db.prepare("UPDATE launches SET state='finished' WHERE run=?").run(run));}
  hasOpenLaunches(){return !!this.db.prepare("SELECT 1 FROM launches WHERE state IN ('pending','dispatched') LIMIT 1").get();}
  enqueueHandoff({id,parent,task,version,payload}){
    this.writing(()=>this.db.prepare('INSERT OR IGNORE INTO handoffs(id,parent,task,version,payload,nextAt) VALUES(?,?,?,?,?,?)').run(id,parent,task,version,JSON.stringify(payload),Date.now()));
  }
  handoff(id){const r=this.db.prepare('SELECT * FROM handoffs WHERE id=?').get(id);return r?{...r,payload:JSON.parse(r.payload)}:null;}
  dueHandoffs(){return this.db.prepare("SELECT id,parent,task,state,run FROM handoffs WHERE state IN ('pending','running') AND nextAt<=? ORDER BY nextAt LIMIT 16").all(Date.now());}
  startHandoff(id,run){this.writing(()=>this.db.prepare("UPDATE handoffs SET state='running',run=?,attempts=attempts+1,nextAt=? WHERE id=? AND state='pending'").run(run,Date.now()+5000,id));}
  settleHandoff(id,state){if(!['delivered','continued','silent','superseded','cancelled'].includes(state))throw Error('无效交接结果');this.writing(()=>this.db.prepare('UPDATE handoffs SET state=?,nextAt=0 WHERE id=?').run(state,id));}
  retryHandoff(id){this.writing(()=>this.db.prepare("UPDATE handoffs SET state='pending',run=NULL,nextAt=? WHERE id=? AND state='running'").run(Date.now()+5000,id));}
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
  closeWriter(){if(this.connection){this.connection.close();this.connection=null;}}
  close(){this.closeWriter();this.reader?.close();this.reader=null;}
}
