// Admission check for old, unbridged controllers. This is a migration guard, not a same-uid security boundary.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
export const BRIDGE_MARKER = '// xin-state-bridge:1';
// 正在退出的进程（僵尸、已死，或 stat 第 9 项 flags 带 PF_EXITING）不会再写状态，不算旧控制器。
// 进程退出时内核先收走它的内存映射：Linux v6.18 起这样的进程 /proc 下的文件归 root（fs/proc/base.c 的 task_dump_owner），
// 普通用户读 environ 被拒（EACCES）；较新的内核可能读出空内容。两种都要先认出「正在退出」再决定拦不拦。
const PF_EXITING=0x4;
function exiting(proc,pid){
  let stat;
  try{stat=fs.readFileSync(path.join(proc,pid,'stat'),'utf8');}catch(e){return ['ENOENT','ESRCH'].includes(e.code);}
  const field=stat.slice(stat.lastIndexOf(')')+2).split(' ');   // state ppid pgrp session tty_nr tpgid flags …
  return field[0]==='Z'||field[0]==='X'||(Number(field[6])&PF_EXITING)!==0;
}
export function checkControllers(home,self,{proc='/proc',ignore=process.pid}={}) {
  const directory=path.dirname(path.resolve(self));
  for(const pid of fs.readdirSync(proc).filter(p=>/^\d+$/.test(p)&&Number(p)!==ignore)){
    let argv;
    try{argv=fs.readFileSync(path.join(proc,pid,'cmdline'),'utf8').split('\0');}
    catch(e){if(['ENOENT','ESRCH','EACCES'].includes(e.code))continue;throw e;}
    if(!/^node(?:js)?$/.test(path.basename(argv[0]||''))||!argv[1]||!path.isAbsolute(argv[1])||
       path.dirname(argv[1])!==directory||!/^vm-agent(?:-[a-f0-9]{12})?\.mjs$/.test(path.basename(argv[1])))continue;
    let env,source;
    try{
      env=Object.fromEntries(fs.readFileSync(path.join(proc,pid,'environ'),'utf8').split('\0').filter(s=>s.includes('=')).map(s=>[s.slice(0,s.indexOf('=')),s.slice(s.indexOf('=')+1)]));
      if(path.resolve(env.XIN_HOME||path.join(env.HOME||os.homedir(),'.xin'))!==path.resolve(home))continue;
      source=fs.readFileSync(argv[1],'utf8');
    }catch(e){if(['ENOENT','ESRCH'].includes(e.code)||exiting(proc,pid))continue;throw Object.assign(Error('无法核对旧控制器，请先排空'),{code:'state_compat'});}
    if(!source.split('\n').includes(BRIDGE_MARKER)&&!exiting(proc,pid))throw Object.assign(Error('仍有未接入状态桥的旧控制器，请先排空'),{code:'state_compat'});
  }
}
