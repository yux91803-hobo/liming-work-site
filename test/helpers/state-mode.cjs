// Reuse controller behavior tests against an actual resident owner, using only temporary state.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawn}=require('node:child_process');
function stateMode(t,env,{force=false,agent=path.join(__dirname,'../../site/xin/vm-agent.mjs')}={}){
  if(!force&&process.env.XIN_TEST_STATE_MODE!=='kernel')return null;
  const home=path.resolve(env.XIN_HOME);
  if(!home.startsWith(path.resolve(os.tmpdir())+path.sep))throw Error('state-mode tests require temporary state');
  fs.mkdirSync(home,{recursive:true});
  const ready=path.join(home,'test-state-ready.jsonl'),error=path.join(home,'test-state-error.log');
  const out=fs.openSync(ready,'w'),err=fs.openSync(error,'w');
  const child=spawn(process.execPath,[agent,'serve','--parent-pipe'],{env,stdio:['pipe',out,err]});
  fs.closeSync(out);fs.closeSync(err);
  const exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
  child.on('error',()=>{});child.stdin.on('error',()=>{});
  t.after(async()=>{
    child.stdin.end();const timer=setTimeout(()=>child.kill('SIGKILL'),2000);
    await exited;clearTimeout(timer);
  });
  const end=performance.now()+10000;
  while(performance.now()<end){
    try{const r=JSON.parse(fs.readFileSync(ready,'utf8'));if(r.ready)return {child,exited,ready:r};}catch{}
    if(fs.readFileSync(error,'utf8').match(/^(?:state_|owner_)/m))throw Error('state fixture startup: '+fs.readFileSync(error,'utf8'));
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);
  }
  child.kill('SIGKILL');throw Error('state fixture did not start: '+fs.readFileSync(error,'utf8'));
}
function stateClient(t,env,options){
  let started=false;
  return ()=>{if(!started){stateMode(t,env,options);started=true;}};
}
module.exports={stateMode,stateClient};
