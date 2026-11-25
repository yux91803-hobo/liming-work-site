// Controller dispatch shared by the compatibility CLI and the resident state owner.
import path from 'node:path';
import { format } from 'node:util';
import { BASE, TIANQI, journal, readJ, writeJ, mk, okId } from './vm-base.mjs';
import { inputDigest } from './vm-state.mjs';
import { ACTS } from './vm-companion.mjs';
import { callContext, withCallContext } from './vm-kernel-context.mjs';
import { stateOperations } from './vm-kernel-operations.mjs';
import { attemptError, hasFinalization, staleAttempt } from './vm-run-attempt.mjs';

const object = a => a && typeof a === 'object' && !Array.isArray(a);
const bad = () => ({ error: 'bad_op', msg: '不认识的操作' });
// 天启身份（li2）下网页和 Worker 能用的操作：聊天、看对话、文件、用量、插件以及例行维护。
export const TIANQI_OPS = new Set(['ping', 'send', 'steer', 'poll', 'stop', 'sessions', 'history', 'rename', 'archive', 'forget', 'files', 'usage', 'plugins', 'plugin_set', 'prune', 'preview_asset', 'integrity_event', 'term_run', 'term_poll']);
const RUN_REPORTS = new Set(['session_patch','run_patch','run_complete','task_finish','task_stage','task_model','agy_conversation','front_reply','front_model','front_immediate','front_action','front_fallback','handoff_start','handoff_finish','continue_steers','run_stat','task_bridge','steer_take','steer_ack','steer_handover']);
const nativeReport = (op, args) => ['task_note','task_ask'].includes(op) && /^agy-[a-f0-9]{32}$/.test(args.id || '');
export function createController({ ops, iops, isTask, saveTask, rememberAgentSession, mainSid, listTasks,
  lockedCall, dispatchLaunches, markCurrentController, xinCmd, reapNow, finalizeRun }) {
  const sessF = sid => path.join(BASE,'sessions',sid+'.json'), metaF = run => path.join(BASE,'runs',run+'.json');
  function inferKey(op,args) {
    const sid=args.sid||readJ(metaF(args.run||''))?.sid;
    return ['send','session_patch','run_complete','continue_steers'].includes(op)&&sid&&!isTask(readJ(sessF(sid)))?sid:'tasks';
  }
  function patchSession(sid, changes) {
    const s=readJ(sessF(sid));if(!s)return {error:'no_session',msg:'找不到这个对话'};
    for(const k of ['agentSid','started','ctxWin','hUsage','frontUsage'])if(Object.hasOwn(changes||{},k))s[k]=changes[k];
    s.updated=Date.now();if(isTask(s))saveTask(s);else writeJ(sessF(sid),s);rememberAgentSession(s.agent,s.agentSid);
    return {session:s};
  }
  function transaction(op,args,fn) {
    const { locked, key } = callContext();
    if(!locked)return fn();
    const taskScope=key==='tasks'&&Object.hasOwn(iops,op);
    if(!taskScope&&!['send','handoff_start','front_reply','front_model','continue_steers','steer_ack','run_recover','run_stopped'].includes(op))return fn();
    // Keep the original command IDs/digests: retries across a mode switch must find the same receipt.
    if(op==='send'||op==='continue_steers'){mk(path.join(BASE,'sessions'));mk(path.join(BASE,'runs'));listTasks();}
    let command=null;
    if(nativeReport(op,args)){
      const {run, attempt} = callContext();
      const meta = readJ(metaF(run));
      if (!taskScope || !meta?.task || meta.sid !== args.sid || run !== args.run) return staleAttempt();
      command = {id:'native:'+run+':'+(attempt || 'legacy')+':'+op+':'+args.id, digest:inputDigest(args)};
      const apply = fn;
      fn = () => {
        const task = readJ(sessF(meta.sid));
        if (!isTask(task) || task.runs?.at(-1) !== run || task.status !== 'running' || meta.stopped || meta.ended)
          return {error:'bridge_ended', msg:'这次运行已结束，请求未应用'};
        return apply();
      };
    }else if(op==='steer_handover'&&args.claim==='handover-input'){
      command={id:'steer-handover:'+args.run+':'+callContext().attempt,digest:inputDigest(args)};
    }else if(op==='task_bridge'){
      if(!/^[a-f0-9]{24}$/.test(args.id||'')||!['remember','ask','note'].includes(args.op)||typeof args.text!=='string'||!args.text.trim()||args.text.length>1000)return {error:'bad_bridge_request',msg:'不认识的任务请求'};
      command={id:'task-bridge:'+args.run+':'+callContext().attempt+':'+args.id,digest:inputDigest(args)};
    }
    if(op==='send'&&/^[a-zA-Z0-9_-]{8,80}$/.test(args.clientId||'')){
      const {sid,agent,text,effort,model,context,ctxLabel,files}=args;
      command={id:'send:'+args.clientId,digest:inputDigest({sid:args.mainSid?null:sid||null,agent:agent||null,text:text||'',effort:effort||null,model:model||null,context:context||'',ctxLabel:ctxLabel||'',files:files||[],...(args.main?{main:true}:{}),...(args.perm!=null?{perm:args.perm}:{}),...(args.work!=null?{work:args.work}:{}),...(args.plan===true?{plan:true}:{})})};   // 权限、计划只在带了时算进去：旧网页重发的同一句摘要不变
    }else if(['task_tell','task_stop'].includes(op)&&/^[a-zA-Z0-9_-]{8,80}$/.test(args.clientId||'')){
      command={id:op+':'+args.clientId,digest:inputDigest(args)};
    }else if(op==='front_action'&&(['remember','forget','task','bond','next','move'].includes(args.argv?.[1])||Object.hasOwn(ACTS,args.argv?.[1]||''))&&!['list','show'].includes(args.argv?.[2])){
      command={id:'front:'+args.run+':'+inputDigest(args.argv).slice(0,20),digest:inputDigest({run:args.run,argv:args.argv})};
    }
    return journal.atomic(fn,command);
  }
  function invoke({ op, args = {}, locked = false, key, run = null, attempt = null, stdin = '' }, { internal = false } = {}) {
    args=object(args)?args:{};
    if(op==='run_finalize'){
      if(!locked||!okId(run,'r')||typeof attempt!=='string'||! /^[a-f0-9]{32}$/.test(attempt))return staleAttempt();
      if(run!==args.run||typeof args.digest!=='string'||! /^[a-f0-9]{64}$/.test(args.digest)||Object.keys(args).length!==2)return bad();
      const meta=readJ(metaF(run));
      if(attemptError(meta,{run,attempt})||key!==(meta.task?'tasks':meta.sid))return staleAttempt();
      const result=finalizeRun(meta,{digest:args.digest});
      dispatchLaunches();return result;
    }
    if(op==='task_bridge'&&(!run||! /^[a-f0-9]{32}$/.test(attempt||'')))return staleAttempt();
    if(nativeReport(op,args)&&(!locked||key!=='tasks'||!run||run!==args.run))return staleAttempt();
    if(run&&!okId(run,'r')||attempt&&(typeof attempt!=='string'||attempt.length>128))return bad();
    if(!internal){
      const target=RUN_REPORTS.has(op)||['run_recover','run_stopped'].includes(op)?args.run||(op==='session_patch'?readJ(sessF(args.sid||''))?.runs?.at(-1):null):null;
      if(run&&target&&run!==target)return staleAttempt();
      const source=run||(RUN_REPORTS.has(op)?target:null);
      if(source&&!okId(source,'r'))return bad();
      if(source){
        const meta=readJ(metaF(source)), error=attemptError(meta,{run,attempt});if(error)return error;
        if(hasFinalization(meta)&&['run_complete','task_finish','front_reply'].includes(op))return {error:'finalization_protocol'};
      }
    }
    key=locked?(key||inferKey(op,args)):null;
    if(op==='task_bridge'&&(!locked||key!=='tasks'))return {error:'bad_bridge_request',msg:'任务请求需要状态事务'};
    if(locked&&key!=='new'&&key!=='daily'&&key!=='tasks'&&!okId(key,'s'))return bad();
    return withCallContext({locked,key,run,attempt,stdin},()=>{
      if(op==='session_patch'&&locked&&okId(args.sid,'s'))return journal.atomic(()=>patchSession(args.sid,args.changes));
      if(locked&&Object.hasOwn(iops,op)){
        const res=transaction(op,args,()=>iops[op](args));dispatchLaunches();return res||{};
      }
      if(!Object.hasOwn(ops,op))return bad();
      // 天启（li2）：网页和 Worker 来的公开操作只认天启用得到的；内部报告、加了锁的转交不受影响
      if(!locked&&TIANQI&&!TIANQI_OPS.has(op))return {error:'not_in_tianqi',msg:'天启没有这个功能'};
      if(!locked)markCurrentController();
      if(op==='send'&&!args.sid&&args.main&&!['harness','claude'].includes(args.agent)&&!args.mainSid){const m=mainSid();if(m){args.sid=m;args.mainSid=m;}}
      const publicKey=op==='stop'?inferKey('run_complete',args):['push_key','push_sub','push_unsub'].includes(op)?'tasks':op==='daily'?'daily':['send','steer','rename','archive','forget'].includes(op)
        ?(okId(args.sid,'s')?isTask(readJ(sessF(args.sid)))?'tasks':args.sid:op==='send'&&!args.sid?'new':null):null;
      if(!locked&&publicKey)return lockedCall(publicKey,op,args);
      const res=transaction(op,args,()=>ops[op](args));
      if(res?.then)return res.then(r=>{dispatchLaunches();return r;});
      dispatchLaunches();return res;
    });
  }
  function receipt(q,fn) {
    const {id,v,...request}=q;
    const r=journal.atomic(()=>{
      const value=fn();if(value?.then)throw Error('桥接状态操作必须同步完成');
      return value?.error?value:{hasValue:value!==undefined,value};
    },{id:'bridge:'+id,digest:inputDigest(request)});
    return r?.error?r:r.hasValue?r.value:undefined;
  }
  function handle(q) {
    // A commit may have succeeded before a transient projection error. Repair before any new read/write or receipt replay.
    journal.recover();
    // Business ops retain their own receipts; an outer RPC transaction would bypass those IDs.
    if(q.kind==='op')return invoke(q);
    if(q.attempt&&!q.run)return staleAttempt();
    if(q.run&&!okId(q.run,'r'))return bad();
    if(q.run){const error=attemptError(readJ(metaF(q.run)),q);if(error)return error;}
    return withCallContext({locked:false,key:null,run:q.run||null,attempt:q.attempt||null,stdin:q.stdin||''},()=>handleReport(q));
  }
  function handleReport(q) {
    if(q.kind==='reap'){const res=reapNow();lockedCall('tasks','task_expire',{});return res;}
    if(q.kind==='xin'){
      if(!Array.isArray(q.argv)||q.argv.some(a=>typeof a!=='string')||typeof(q.stdin??'')!=='string')return bad();
      return receipt(q,()=>{
        const output=[];const code=xinCmd(q.argv,(...a)=>output.push(format(...a)));
        return {code,output:output.length?output.join('\n')+'\n':''};
      });
    }
    if(q.kind==='named'){
      if(!Object.hasOwn(stateOperations,q.name)||!Array.isArray(q.args)||q.args.length>8)return bad();
      return receipt(q,()=>stateOperations[q.name](...q.args));
    }
    if(q.kind==='write'||q.kind==='append'){
      if(typeof q.name!=='string'||path.isAbsolute(q.name))return bad();
      const file=path.resolve(BASE,q.name);journal.name(file);
      if(q.kind==='write'&&typeof q.body!=='string'||q.kind==='append'&&!object(q.event))return bad();
      return receipt(q,()=>q.kind==='write'?journal.write(file,q.body):journal.append(file,q.event));
    }
    return bad();
  }
  return { invoke, handle, transaction, patchSession };
}
