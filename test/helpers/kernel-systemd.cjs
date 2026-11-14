// 假用户管理器读取真实服务文件、启动真实 HTTP 内核；不连接宿主 systemd。
const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
const home=process.env.XIN_HOME,args=process.argv.slice(2),unit=path.join(process.env.XDG_CONFIG_HOME,'systemd/user/xin-kernel-resident.service');
const role=path.basename(process.argv[1]),action=args[1],legacy=role==='systemd-run'||args[2]==='xin-kernel.service';
const prefix=legacy?'legacy.':'';
const read=f=>{try{return fs.readFileSync(path.join(home,prefix+f),'utf8');}catch{return '';}};
const write=(f,v)=>fs.writeFileSync(path.join(home,prefix+f),v);
const drop=f=>{try{fs.unlinkSync(path.join(home,prefix+f));}catch{}};
fs.appendFileSync(path.join(home,'systemd.log'),role+' '+args.join(' ')+'\n');
if(role==='systemctl'&&process.env.XIN_FAKE_CRASH===action) { process.kill(process.ppid,'SIGKILL');process.exit(0); }
if(role==='systemd-run'&&process.env.XIN_FAKE_RUN_FAIL==='once'&&!fs.existsSync(path.join(home,'run-failed'))) { fs.writeFileSync(path.join(home,'run-failed'),'yes');process.exit(1); }
const wait=ms=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms);
function start(argv,env) {
  const c=spawn(argv[0],argv.slice(1),{detached:true,stdio:'ignore',env});c.unref();
  fs.appendFileSync(path.join(home,'pids'),c.pid+'\n');write('unit.pid',String(c.pid));
}
if(role==='systemd-run') {
  let i=0;while(i<args.length&&args[i].startsWith('-'))i+=args[i]==='-p'?2:1;
  write('argv',JSON.stringify(args.slice(i)));start(args.slice(i),process.env);write('fragment','/run/user/1000/systemd/transient/xin-kernel.service');
} else if(action==='show')process.stdout.write(read(args.includes('--property=MainPID')?'unit.pid':'fragment'));
else if(action==='is-enabled') { process.stdout.write(read('enabled')?'enabled':'disabled');process.exitCode=read('enabled')?0:1; }
else if(action==='disable') { if(!read('enabled')&&!fs.existsSync(unit))process.exitCode=1;else drop('enabled'); }
else if(action==='enable'&&process.env.XIN_FAKE_FAIL==='enable-partial') { write('enabled','yes');process.exitCode=1; }
else if(process.env.XIN_FAKE_FAIL===action)process.exitCode=1;
else if(process.env.XIN_FAKE_FAIL===action+'-once'&&!fs.existsSync(path.join(home,'failed-'+action))) { fs.writeFileSync(path.join(home,'failed-'+action),'yes');process.exitCode=1; }
else if(action==='enable')write('enabled','yes');
else if(action==='stop') {
  const pid=Number(read('unit.pid'));
  if(pid>1)try{process.kill(pid,'SIGTERM');wait(200);}catch{}
  drop('unit.pid');if(read('fragment').includes('/transient/')&&!fs.existsSync(path.join(home,'transient-busy')))drop('fragment');
} else if(action==='start') {
  if(read('unit.pid'))process.exit(0);
  if(legacy) { start(JSON.parse(read('argv')),process.env);process.exit(0); }
  const text=fs.readFileSync(unit,'utf8');
  const raw=text.match(/^ExecStart=(.*)$/m)?.[1]||'';
  const argv=(raw.match(/"(?:\\.|[^"\\])*"|[^\s]+/g)||[]).map(x=>x.replace(/^"|"$/g,'').replace(/\\(.)/g,'$1').replaceAll('%%','%').replaceAll('$$','$'));
  const rawHome=text.match(/^Environment="XIN_HOME=(.*)"$/m)?.[1];
  const savedHome=rawHome?.replace(/\\(.)/g,'$1').replaceAll('%%','%');
  if(savedHome!==home)throw Error('单元未保留 XIN_HOME');
  // 模拟开机时没有 ensure 的凭据/模型环境，serve 必须从私有环境文件恢复。
  const serveEnv={PATH:process.env.PATH,HOME:process.env.HOME,XIN_HOME:savedHome};
  if(process.env.XIN_FAKE_UNHEALTHY==='1'&&!read('unhealthy')) { write('unhealthy','yes');start([process.execPath,'-e','setInterval(()=>{},1000)'],serveEnv); }
  else start(argv,serveEnv);
  write('fragment',unit);
}
