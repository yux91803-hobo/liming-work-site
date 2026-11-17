// Controller dispatch shared by the compatibility CLI and the resident state owner.
import path from 'node:path';
import { format } from 'node:util';
import { BASE, journal, readJ, writeJ, mk, okId } from './vm-base.mjs';
import { inputDigest } from './vm-state.mjs';
import { ACTS } from './vm-companion.mjs';
import { callContext, withCallContext } from './vm-kernel-context.mjs';
import { stateOperations } from './vm-kernel-operations.mjs';
import { attemptError, staleAttempt } from './vm-run-attempt.mjs';

const object = a => a && typeof a === 'object' && !Array.isArray(a);
const bad = () => ({ error: 'bad_op', msg: '不认识的操作' });
const RUN_REPORTS = new Set(['session_patch','run_patch','run_complete','task_finish','task_stage','task_model','agy_conversation','front_reply','front_model','front_immediate','front_action','front_fallback','handoff_start','handoff_finish','continue_steers','run_stat','task_bridge','steer_take','steer_handover']);
export function createController({ ops, iops, isTask, saveTask, rememberAgentSession, mainSid, listTasks,
  lockedCall, dispatchLaunches, markCurrentController, xinCmd, reapNow }) {
  const sessF = sid => path.join(BASE,'sessions',sid+'.json'), metaF = run => path.join(BASE,'runs',run+'.json');
  function inferKey(op,args) {
    const sid=args.sid||readJ(metaF(args.run||''))?.sid;
    return ['send','session_patch','run_complete','continue_steers'].includes(op)&&sid&&!isTask(readJ(sessF(sid)))?sid:'tasks';
  }
  function transaction(op,args,fn) {
    const { locked, key } = callContext();
    if(!locked)return fn();
    const taskScope=key==='tasks'&&Object.hasOwn(iops,op);
    if(!taskScope&&!['send','handoff_start','front_reply','front_model','continue_steers','run_recover','run_stopped'].includes(op))return fn();
    // Keep the original command IDs/digests: retries across a mode switch must find the same receipt.
    if(op==='send'||op==='continue_steers'){mk(path.join(BASE,'sessions'));mk(path.join(BASE,'runs'));listTasks();}
    let command=null;
    if(op==='task_bridge'){
      if(!/^[a-f0-9]{24}$/.test(args.id||'')||!['remember','ask','note'].includes(args.op)||typeof args.text!=='string'||!args.text.trim()||args.text.length>1000)return {error:'bad_bridge_request',msg:'不认识的任务请求'};
      command={id:'task-bridge:'+args.run+':'+callContext().attempt+':'+args.id,digest:inputDigest(args)};
    }
    if(op==='send'&&/^[a-zA-Z0-9_-]{8,80}$/.test(args.clientId||'')){
      const {sid,agent,text,effort,model,context,ctxLabel,files}=args;
      command={id:'send:'+args.clientId,digest:inputDigest({sid:args.mainSid?null:sid||null,agent:agent||null,text:text||'',effort:effort||null,model:model||null,context:context||'',ctxLabel:ctxLabel||'',files:files||[],...(args.main?{main:true}:{})})};
    }else if(['task_tell','task_stop'].includes(op)&&/^[a-zA-Z0-9_-]{8,80}$/.test(args.clientId||'')){
      command={id:op+':'+args.clientId,digest:inputDigest(args)};
    }else if(op==='front_action'&&(['remember','forget','task','bond','next','move'].includes(args.argv?.[1])||Object.hasOwn(ACTS,args.argv?.[1]||''))&&!['list','show'].includes(args.argv?.[2])){
      command={id:'front:'+args.run+':'+inputDigest(args.argv).slice(0,20),digest:inputDigest({run:args.run,argv:args.argv})};
    }
    return journal.atomic(fn,command);
  }
  function invoke({ op, args = {}, locked = false, key, run = null, attempt = null, stdin = '' }, { internal = false } = {}) {
    args=object(args)?args:{};
    if(op==='task_bridge'&&(!run||! /^[a-f0-9]{32}$/.test(attempt||'')))return staleAttempt();
    if(run&&!okId(run,'r')||attempt&&(typeof attempt!=='string'||attempt.length>128))return bad();
    if(!internal){
      const target=RUN_REPORTS.has(op)||['run_recover','run_stopped'].includes(op)?args.run||(op==='session_patch'?readJ(sessF(args.sid||''))?.runs?.at(-1):null):null;
      if(run&&target&&run!==target)return staleAttempt();
      const source=run||(RUN_REPORTS.has(op)?target:null);
      if(source&&!okId(source,'r'))return bad();
      if(source){const error=attemptError(readJ(metaF(source)),{run,attempt});if(error)return error;}
    }
    key=locked?(key||inferKey(op,args)):null;
    if(op==='task_bridge'&&(!locked||key!=='tasks'))return {error:'bad_bridge_request',msg:'任务请求需要状态事务'};
    if(locked&&key!=='new'&&key!=='daily'&&key!=='tasks'&&!okId(key,'s'))return bad();
    return withCallContext({locked,key,run,attempt,stdin},()=>{
      if(op==='session_patch'&&locked&&okId(args.sid,'s')){
        return journal.atomic(()=>{
        const s=readJ(sessF(args.sid));if(!s)return {error:'no_session',msg:'找不到这个对话'};
        for(const k of ['agentSid','started','ctxWin','hUsage','frontUsage'])if(Object.hasOwn(args.changes||{},k))s[k]=args.changes[k];
        s.updated=Date.now();if(isTask(s))saveTask(s);else writeJ(sessF(args.sid),s);rememberAgentSession(s.agent,s.agentSid);
        return {session:s};
        });
      }
      if(locked&&Object.hasOwn(iops,op)){
        const res=transaction(op,args,()=>iops[op](args));dispatchLaunches();return res||{};
      }
      if(!Object.hasOwn(ops,op))return bad();
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
  return { invoke, handle, transaction };
}
