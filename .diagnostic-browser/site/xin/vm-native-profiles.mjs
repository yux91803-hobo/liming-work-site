// Private native model caches are owned per website conversation; credentials remain shared by reference.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {BASE,journal,readJ,okId} from './vm-base.mjs';

const parent=()=>path.join(BASE,'native-profiles');
const expected=sid=>path.join(parent(),sid);
const existsTable=name=>!!journal.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
function schema(){
 const d=journal.db;
 d.exec(`CREATE TABLE IF NOT EXISTS native_profiles(sid TEXT PRIMARY KEY,kind TEXT NOT NULL,root TEXT NOT NULL,nonce TEXT NOT NULL,created INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS native_profile_sessions(sid TEXT NOT NULL,run TEXT NOT NULL,id TEXT NOT NULL,at INTEGER NOT NULL,PRIMARY KEY(sid,run,id));`);
 return d;
}
function row(sid){if(!okId(sid,'s'))throw Error('原生缓存的对话编号不正确');return existsTable('native_profiles')?journal.db.prepare('SELECT * FROM native_profiles WHERE sid=?').get(sid):null;}
function verify(r,{missing=false}={}){
 if(!r||r.root!==expected(r.sid)||!['front','worker'].includes(r.kind)||!/^[a-f0-9]{32}$/.test(r.nonce))throw Error('原生缓存归属尚未确认');
 let st;try{st=fs.lstatSync(r.root);}catch(e){if(e.code==='ENOENT'&&missing)return;throw Error('原生缓存目录暂不可用');}
 if(!st.isDirectory()||st.isSymbolicLink()||fs.realpathSync(r.root)!==r.root)throw Error('原生缓存目录归属不明确');
 let fd;try{
  fd=fs.openSync(path.join(r.root,'.native-owner.json'),fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
  if(!fs.fstatSync(fd).isFile()||fs.fstatSync(fd).size>1024)throw Error();
  const m=JSON.parse(fs.readFileSync(fd,'utf8'));
  if(m.sid!==r.sid||m.kind!==r.kind||m.nonce!==r.nonce||m.version!==1)throw Error();
 }catch{throw Error('原生缓存归属标记不正确');}finally{if(fd!==undefined)fs.closeSync(fd);}
}
const info=r=>({...r,home:r.root,app:path.join(r.root,'.gemini/antigravity-cli'),agents:path.join(r.root,'.gemini/config/agents'),work:path.join(r.root,'work')});
export function nativeProfile(sid){const r=row(sid);if(!r)return null;verify(r);return info(r);}
export function ensureNativeProfile({sid,kind,loginHome=process.env.XIN_AGY_HOME||os.homedir()}={}){
 const s=readJ(path.join(BASE,'sessions',String(sid)+'.json'));
 if(!okId(sid,'s')||s?.agent!=='codex'||kind==='front'&&(s.kind||s.dailyDate)||kind==='worker'&&s.kind!=='task'||!['front','worker'].includes(kind))throw Error('原生缓存只供对应的默认模式工作使用');
 const d=schema();let r=row(sid);
 if(!r){
  if(fs.existsSync(expected(sid)))throw Error('已有目录归属不明，不覆盖');
  r={sid,kind,root:expected(sid),nonce:crypto.randomBytes(16).toString('hex'),created:Date.now()};
  journal.atomic(()=>d.prepare('INSERT INTO native_profiles VALUES(?,?,?,?,?)').run(r.sid,r.kind,r.root,r.nonce,r.created));
 }
 if(r.kind!==kind)throw Error('原生缓存用途不一致');
 fs.mkdirSync(parent(),{recursive:true,mode:0o700});if(fs.realpathSync(parent())!==parent())throw Error('原生缓存父目录不能是软链接');
 if(!fs.existsSync(r.root))fs.mkdirSync(r.root,{mode:0o700});
 const marker=path.join(r.root,'.native-owner.json');
 if(!fs.existsSync(marker)&&fs.readdirSync(r.root).length===0){try{fs.writeFileSync(marker,JSON.stringify({...r,version:1}),{mode:0o600,flag:'wx'});}catch(e){if(e.code!=='EEXIST')throw e;}}
 verify(r);const p=info(r);for(const dir of [p.app,p.agents,p.work])fs.mkdirSync(dir,{recursive:true,mode:0o700});
 const auth=path.resolve(loginHome,'.gemini/antigravity-cli/antigravity-oauth-token'),local=path.join(p.app,'antigravity-oauth-token');
 if(!fs.existsSync(local)){
  if(!fs.existsSync(auth)||!fs.statSync(auth).isFile())throw Error('原生模型的既有登录资料暂不可用');
  try{fs.symlinkSync(auth,local);}catch(e){if(e.code!=='EEXIST')throw e;}
 }
 if(!fs.lstatSync(local).isSymbolicLink()||fs.readlinkSync(local)!==auth)throw Error('原生模型的登录引用归属不一致');
 // Only this owned settings file is managed; global Tianqi/native preferences are untouched.
 const setting=path.join(p.app,'settings.json'),tmp=setting+'.'+crypto.randomBytes(6).toString('hex');
 try{fs.writeFileSync(tmp,JSON.stringify({model:'gemini-3.8-flash-high',useG1Credits:false,toolPermission:'strict',allowNonWorkspaceAccess:false}),{mode:0o600,flag:'wx'});fs.renameSync(tmp,setting);}finally{try{fs.unlinkSync(tmp);}catch{}}
 return p;
}
export function recordNativeSession({sid,run,id}={}){
 const p=nativeProfile(sid),m=okId(run,'r')&&readJ(path.join(BASE,'runs',run+'.json'));
 if(!p||m?.sid!==sid||typeof id!=='string'||!/^[A-Za-z0-9_-]{1,200}$/.test(id))throw Error('原生轮次归属不正确');
 journal.atomic(()=>schema().prepare('INSERT OR IGNORE INTO native_profile_sessions VALUES(?,?,?,?)').run(sid,run,id,Date.now()));return {ok:true};
}
export function nativeProfileProblem(s){
 try{
  const p=nativeProfile(s.sid);if(s.kind==='task'&&s.antigravityConversation&&!p)return true;
  for(const run of s.runs||[]){const m=readJ(path.join(BASE,'runs',run+'.json'));if((/^claude-opus-4[.-]6/.test(m?.model||'')||/^claude-opus-4[.-]6/.test(m?.from||''))&&(!p||m.nativeFrontScope!==1))return true;}
  return false;
 }catch{return true;}
}
export function purgeNativeProfile(sid,{confirmed=false}={}){
 if(!confirmed)return {error:'native_confirmation_required'};
 const r=row(sid);if(!r)return {ok:true,none:true};
 try{
  verify(r,{missing:true});if(fs.existsSync(r.root))fs.rmSync(r.root,{recursive:true});
  journal.atomic(()=>{const d=schema();d.prepare('DELETE FROM native_profile_sessions WHERE sid=?').run(sid);d.prepare('DELETE FROM native_profiles WHERE sid=?').run(sid);});return {ok:true};
 }catch{return {error:'native_profile_pending'};}
}
