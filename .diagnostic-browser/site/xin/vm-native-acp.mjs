// Shared native model transport. Only controller-provided JSON-RPC methods and prompt blocks can run.
import os from 'node:os';
import {spawn} from 'node:child_process';
import {processIdentity,signalProcessGroup} from './vm-base.mjs';

export function stopNativeChild(child){
 if(child.exitCode!==null||child.signalCode)return;
 signalProcessGroup(child.pid,child.xinIdentity,'SIGTERM');
 const timer=setTimeout(()=>signalProcessGroup(child.pid,child.xinIdentity,'SIGKILL'),1000);timer.unref();
}
export function nativeChildOptions(cwd,home=process.env.XIN_AGY_HOME||os.homedir()){return {cwd,detached:true,stdio:['pipe','pipe','pipe'],env:{HOME:home,PATH:process.env.PATH||'/usr/local/bin:/usr/bin:/bin',LANG:'C.UTF-8'}};}
export class NativeACP {
 constructor(binary,args,cwd,signal,observe,home,options={}){
  this.seq=0;this.pending=new Map();this.text='';this.update=null;this.signal=signal;this.buffer='';this.bytes=0;this.observe=observe;
  this.child=spawn(binary,args,{...nativeChildOptions(cwd,home),detached:options.detached!==false});this.child.xinIdentity=processIdentity(this.child.pid);
  this.cancel=()=>this.close();signal?.addEventListener('abort',this.cancel,{once:true});
  this.child.stdout.setEncoding('utf8');this.child.stderr.resume();
  this.child.stdout.on('data',s=>{this.bytes+=Buffer.byteLength(s);if(this.bytes>4*1024*1024){this.fail(Error('原生模型回复过长'));this.close();return;}this.buffer+=s;let i;while((i=this.buffer.indexOf('\n'))>=0){const line=this.buffer.slice(0,i);this.buffer=this.buffer.slice(i+1);let o;try{o=JSON.parse(line);}catch{continue;}this.accept(o);}});
  this.child.stdin.on('error',e=>this.fail(e));
  this.child.on('error',e=>this.fail(e));this.child.on('close',()=>{this.closed=true;this.fail(Error(signal?.aborted?'前台已停止':'原生模型连接结束'));});
 }
 send(o){if(!this.child.stdin.destroyed)this.child.stdin.write(JSON.stringify({jsonrpc:'2.0',...o})+'\n');}
 accept(o){
  if(o.method==='session/update'){
   const u=o.params?.update||{},known=['agent_message_chunk','agent_thought_chunk','tool_call','tool_call_update','usage_update','config_option_update','current_mode_update','session_info_update','available_commands_update','plan'];
   const fields=['text','message','response','final_response','final_answer','answer','output','result','structured_output','content'].filter(k=>Object.hasOwn(u.rawInput||{},k));
   this.observe?.({kind:known.includes(u.sessionUpdate)?u.sessionUpdate:'other',bytes:u.content?.type==='text'?Buffer.byteLength(u.content.text||''):0,inputFields:fields});
  }
  if(o.method){
   if(Object.hasOwn(o,'id')){
    if(o.method==='session/request_permission')this.send({id:o.id,result:{outcome:{outcome:'cancelled'}}});
    else this.send({id:o.id,error:{code:-32601,message:'This native transport has no filesystem, terminal or external tool permission'}});
   }else if(o.method==='session/update'){
    const u=o.params?.update;if(u?.sessionUpdate==='agent_message_chunk'&&u.content?.type==='text')this.text+=u.content.text;
    if(u?.sessionUpdate==='usage_update')this.update=u;
   }
   return;
  }
  const p=this.pending.get(o.id);if(!p)return;clearTimeout(p.timer);this.pending.delete(o.id);
  if(o.error){const e=Error(String(o.error.message||'原生模型请求失败'));e.code=o.error.code;e.data=o.error.data;p.reject(e);}else p.resolve(o.result||{});
 }
 request(method,params,signal,ms=20000){
  if(signal?.aborted||this.signal?.aborted||this.closed)return Promise.reject(Error('前台已停止或连接已经结束'));
  return new Promise((resolve,reject)=>{const id=++this.seq,timer=setTimeout(()=>{this.pending.delete(id);reject(Error('原生模型请求超时'));},ms);timer.unref();this.pending.set(id,{resolve,reject,timer});this.send({id,method,params});});
 }
 fail(e){for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(e);}this.pending.clear();}
 close(){this.signal?.removeEventListener('abort',this.cancel);this.fail(Error('前台已停止'));stopNativeChild(this.child);}
}
