// Admission check for old, unbridged controllers. This is a migration guard, not a same-uid security boundary.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
export const BRIDGE_MARKER = '// xin-state-bridge:1';
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
    }catch(e){if(['ENOENT','ESRCH'].includes(e.code))continue;throw Object.assign(Error('无法核对旧控制器，请先排空'),{code:'state_compat'});}
    if(!source.split('\n').includes(BRIDGE_MARKER))throw Object.assign(Error('仍有未接入状态桥的旧控制器，请先排空'),{code:'state_compat'});
  }
}
