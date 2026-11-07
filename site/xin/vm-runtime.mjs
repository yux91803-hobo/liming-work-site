// Execution helpers. The controller owns state and credentials; tools see only a task workspace.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';

const mkdir = p => fs.mkdirSync(p, { recursive: true });
const hash = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const under = (p, root) => p === root || p.startsWith(root + path.sep);

export function inventory(root) {
  const out = {};
  let total = 0;
  const walk = (dir, rel = '') => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['.git', 'node_modules', '.xin-task'].includes(e.name)) continue;
      const name = rel ? rel + '/' + e.name : e.name, p = path.join(dir, e.name);
      if (e.isSymbolicLink()) throw new Error('项目里有软链接，请先改成普通文件：' + name);
      if (e.isDirectory()) walk(p, name);
      else if (e.isFile()) {
        total += fs.statSync(p).size;
        if (total > 150 * 1024 * 1024 || Object.keys(out).length >= 10000) throw new Error('项目太大，先指定较小的项目目录');
        out[name] = hash(p);
      } else throw new Error('项目包含非常规文件：' + name);
    }
  };
  walk(root); return out;
}

export function prepareWorkspace(t, controller) {
  if (t.workspace && fs.existsSync(t.workspace.work) && fs.existsSync(t.workspace.manifest)) return t.workspace;
  const root = path.join(os.tmpdir(), 'xin-task-' + t.sid);
  const work = path.join(root, 'work'), io = path.join(root, 'io'), home = path.join(root, 'home');
  mkdir(work); mkdir(io); mkdir(home); mkdir(path.join(home, 'bin')); mkdir(path.join(root, 'tmp'));
  const before = inventory(t.dir);
  // A fresh turn gets a new baseline. This also detects edits made by the foreground in between turns.
  fs.rmSync(work, { recursive: true, force: true }); mkdir(work);
  for (const name of Object.keys(before)) {
    const dest = path.join(work, name); mkdir(path.dirname(dest)); fs.copyFileSync(path.join(t.dir, name), dest);
    fs.chmodSync(dest, fs.statSync(path.join(t.dir, name)).mode & 0o777);
  }
  mkdir(path.join(controller, 'workspaces'));
  const manifest = path.join(controller, 'workspaces', t.sid + '.json');
  fs.writeFileSync(manifest, JSON.stringify({ original: fs.realpathSync(t.dir), before }), { mode: 0o600 });
  const bridge = `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const a=process.argv.slice(2),dir=process.env.XIN_TASK_IO;
if(!dir||!(a[0]==='remember'||a[0]==='task'&&a[1]==='ask')){console.error('后台只允许 xin remember 和 xin task ask');process.exit(1);}
const body={op:a[0]==='remember'?'remember':'ask',text:a.slice(a[0]==='remember'?1:2).join(' ').slice(0,1000)};
const id=crypto.randomBytes(12).toString('hex'),file=path.join(dir,id+'.request');
fs.writeFileSync(file+'.tmp',JSON.stringify(body));fs.renameSync(file+'.tmp',file);
const until=Date.now()+15000,reply=path.join(dir,id+'.reply');
while(!fs.existsSync(reply)&&Date.now()<until)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,50);
if(!fs.existsSync(reply)){console.error('管理进程没有回应，停止这一步');process.exit(1);}
console.log(fs.readFileSync(reply,'utf8'));fs.unlinkSync(reply);
`;
  fs.writeFileSync(path.join(home, 'bin', 'xin'), bridge, { mode: 0o755 });
  fs.writeFileSync(path.join(home, 'shell-env.sh'), 'export PATH=' + JSON.stringify(path.join(home, 'bin')) + ':"$PATH"\n');
  return { work, io, home, tmp: path.join(root, 'tmp'), manifest };
}

export function publicationPlan(t, controller) {
  const { original, before } = JSON.parse(fs.readFileSync(path.join(controller, 'workspaces', t.sid + '.json'), 'utf8'));
  if (fs.realpathSync(t.dir) !== original) throw new Error('项目目录已改变，结果未覆盖原文件');
  const after = inventory(t.workspace.work), current = inventory(original);
  const changes = Object.keys(after).filter(n => before[n] !== after[n]);
  const deleted = Object.keys(before).filter(n => !(n in after));
  const conflicts = [...changes, ...deleted].filter(n => current[n] !== before[n]);
  return { original, before, after, changes, deleted, conflicts };
}

export function stm32Task(t) {
  if(!t.workspace || !['code','review'].includes(t.tkind)) return false;
  const main=path.join(t.workspace.work,'main.c'),make=path.join(t.workspace.work,'Makefile');
  return fs.existsSync(main)&&fs.existsSync(make)&&/stm32|arm-none-eabi|cortex-m3/i.test(fs.readFileSync(main,'utf8')+fs.readFileSync(make,'utf8'));
}
export function compileWorkspace(t) {
  if(!stm32Task(t)) return null;
  const hexFile=path.join(t.workspace.work,'build/app.hex');
  if(fs.existsSync(hexFile)) fs.unlinkSync(hexFile); // only the private generated artifact, never the user's original
  const c=containerCommand(t,'/usr/bin/make',['-B']);
  const result=spawnSync(c.command,c.args,{cwd:t.workspace.work,env:{PATH:'/usr/bin:/bin'},encoding:'utf8',timeout:60000,maxBuffer:2*1024*1024});
  const ok=result.status===0 && fs.existsSync(hexFile) && /^:[0-9a-f]+$/im.test(fs.readFileSync(hexFile,'utf8'));
  return {ok,digest:ok?sourceDigest(t.workspace.work):null,output:((result.stdout||'')+'\n'+(result.stderr||'')+(result.error?'\n'+result.error.message:'')).slice(-10000)};
}
export function validateTask(t, controller, meta) {
  const plan = publicationPlan(t, controller);
  if (!stm32Task(t)) return { applicable: false };
  if (!meta.compileTrusted || !meta.compileOk || meta.compileDigest !== sourceDigest(t.workspace.work)) return { error: 'STM32 程序必须在最终改动后成功执行 make，并确认生成的文件；现在没有针对最终源码的成功编译记录。' };
  if(t.tkind==='code' && !plan.changes.some(n=>/\.[chs]$/i.test(n))) return {error:'STM32 实现任务没有源码改动，不能把只编译模板当成完成。请完成要求的程序后重新 make。'};
  const report = path.join(t.workspace.work, 'xin-review.json');
  if (t.tkind === 'review') {
    let data; try { data = JSON.parse(fs.readFileSync(report,'utf8')); } catch { return { error: '请生成 xin-review.json：verdict="pass"，checks 数组逐项写出 clock、pinmap、peripheral_clock、interrupt 的 id、status（pass/not_applicable）、reference（手册章节）和 evidence（源码文件:行号及判断依据）。' }; }
    if (data.verdict !== 'pass' || !Array.isArray(data.checks)) return { error: '检查报告没有通过；请修复问题并重新编译、核对。' };
    for (const id of ['clock','pinmap','peripheral_clock','interrupt']) {
      const c = data.checks.find(c=>c.id===id);
      if (!c || !['pass','not_applicable'].includes(c.status) || typeof c.reference !== 'string' || c.reference.trim().length<5 || typeof c.evidence !== 'string' || c.evidence.trim().length<8)
        return { error: '检查报告缺少 '+id+' 的手册依据、源码定位或明确结论；补齐后再完成。' };
    }
  }
  return { applicable: true, compiled: !!meta.compileOk, reviewed: t.tkind==='review', hardware: false };
}
export function sourceDigest(root) {
  const files = inventory(root);
  return crypto.createHash('sha256').update(JSON.stringify(Object.entries(files).filter(([n])=>/\.(?:c|h|s|ld|mk)$|(?:^|\/)Makefile$/i.test(n)).sort(([a],[b])=>a.localeCompare(b)))).digest('hex');
}

export function publishWorkspace(t, controller, approved = false) {
  const plan = publicationPlan(t, controller);
  if ((plan.deleted.length || plan.conflicts.length) && !approved) return { pending: true, deleted: plan.deleted, conflicts: plan.conflicts };
  // Validate every destination before changing any file. Never follow a task-created or concurrent symlink.
  for (const name of [...plan.changes, ...plan.deleted]) {
    const dst = path.resolve(plan.original, name);
    if (!under(dst, plan.original)) throw new Error('结果路径越界');
    let parent = path.dirname(dst);
    while (!fs.existsSync(parent)) parent = path.dirname(parent);
    if (!under(fs.realpathSync(parent), plan.original)) throw new Error('结果路径包含外部软链接');
    if (fs.existsSync(dst) && fs.lstatSync(dst).isSymbolicLink()) throw new Error('结果路径变成了软链接');
  }
  const backup = path.join(controller, 'backups', 'task-' + t.no + '-' + Date.now());
  mkdir(backup);
  for (const name of [...plan.changes, ...plan.deleted]) {
    const dst = path.join(plan.original, name);
    if (fs.existsSync(dst)) { const b = path.join(backup, name); mkdir(path.dirname(b)); fs.copyFileSync(dst, b); }
  }
  for (const name of plan.changes) {
    const src = path.join(t.workspace.work, name), dst = path.join(plan.original, name);
    mkdir(path.dirname(dst)); const tmp = dst + '.xin-' + process.pid;
    fs.copyFileSync(src, tmp); fs.chmodSync(tmp, fs.statSync(src).mode & 0o777); fs.renameSync(tmp, dst);
  }
  for (const name of plan.deleted) fs.unlinkSync(path.join(plan.original, name));
  return { ok: true, files: plan.changes.length, deleted: plan.deleted.length, backup };
}

export function permissionArgs(t, base, files = [], readRoots = []) {
  const w = t.workspace;
  if (!w) throw new Error('后台任务缺少隔离工作区');
  const filesystem = { ':minimal': 'read' };
  for (const p of ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/opt/npm', '/etc/ssl', '/etc/ld.so.cache', '/etc/alternatives']) if (fs.existsSync(p)) filesystem[p] = 'read';
  // Source projects are read-only; only the isolated copy and private temporary directories are writable.
  filesystem[t.dir] = 'read';
  const template = path.join(process.env.XIN_WORK || '/data/workspace', 'stm32-template');
  if (fs.existsSync(template)) filesystem[template] = 'read';
  if (fs.existsSync(path.join(t.dir, '.git'))) filesystem[path.join(t.dir, '.git')] = 'deny';
  for (const p of [w.work, w.io, w.home, w.tmp]) filesystem[p] = 'write';
  for (const p of files) filesystem[p] = 'read';
  for (const p of readRoots) filesystem[p] = 'read';
  // Explicit denies also protect credentials stored in the home directory or mounted via a symlink.
  for (const p of [base, path.join(os.homedir(), '.xin'), path.join(os.homedir(), '.codex'), path.join(os.homedir(), '.ssh'), path.join(os.homedir(), '.dsh'), '/etc/codex', '/proc']) if (fs.existsSync(p)) filesystem[p] = 'deny';
  const tomlMap = o => '{' + Object.entries(o).map(([k,v]) => JSON.stringify(k) + '=' + JSON.stringify(v)).join(',') + '}';
  const env = { PATH: path.join(w.home, 'bin') + ':/usr/local/bin:/usr/bin:/bin', HOME: w.home, TMPDIR: w.tmp, LANG: 'C.UTF-8', XIN_TASK_IO: w.io, BASH_ENV: path.join(w.home, 'shell-env.sh') };
  return ['-c', 'default_permissions="xin-task"', '-c', 'permissions.xin-task.filesystem=' + tomlMap(filesystem),
    '-c', 'permissions.xin-task.network.enabled=true', '-c', 'shell_environment_policy.inherit="none"',
    '-c', 'shell_environment_policy.set=' + tomlMap(env)];
}

export function mcpTransport(t, base, server) {
  const transport = server.transport || server;
  if (transport.type !== 'stdio' || !transport.command) throw new Error('后台插件必须是本机 stdio 服务，不能直接接管远程服务');
  if (!(transport.args||[]).every(a => a==='mcp' || a==='--mcp')) throw new Error('后台 REA 只接受本机 stdio 启动参数');
  const resolveCommand = c => path.isAbsolute(c) ? fs.realpathSync(c) : fs.realpathSync(spawnSync('sh',['-c','command -v "$1"','sh',c],{encoding:'utf8'}).stdout.trim());
  const command = resolveCommand(transport.command), roots = [];
  try {
    const interpreter = /^#!(\/\S+)/.exec(fs.readFileSync(command,'utf8').slice(0,300))?.[1];
    if (interpreter && interpreter !== '/usr/bin/env') roots.push(fs.realpathSync(interpreter));
  } catch { /* native executables need no interpreter root */ }
  let packageRoot = path.dirname(command);
  while (packageRoot !== path.dirname(packageRoot) && !fs.existsSync(path.join(packageRoot,'package.json'))) packageRoot=path.dirname(packageRoot);
  roots.push(fs.existsSync(path.join(packageRoot,'package.json')) ? packageRoot : command);
  const w=t.workspace, env={HOME:w.home,TMPDIR:w.tmp,PATH:path.join(w.home,'bin')+':/usr/local/bin:/usr/bin:/bin',
    XDG_CACHE_HOME:path.join(w.home,'.cache'),XDG_CONFIG_HOME:path.join(w.home,'.config'),
    JAVA_TOOL_OPTIONS:'-Duser.home='+w.home+' -Djava.io.tmpdir='+w.tmp+' -XX:-UsePerfData'};
  for (const name of ['JAVA_HOME','GHIDRA_INSTALL_DIR']) {
    const value=transport.env?.[name];
    if (value && path.isAbsolute(value) && fs.existsSync(value)) { env[name]=value; roots.push(fs.realpathSync(value)); }
  }
  const denied=[base,path.join(os.homedir(),'.codex'),path.join(os.homedir(),'.ssh'),path.join(os.homedir(),'.xin')];
  if (roots.some(p=>denied.some(d=>under(p,d)) || p===os.homedir() || p==='/')) throw new Error('插件程序目录与管理目录重叠，不能开放给后台');
  return { command, args: transport.args || [], env, cwd: w.work, roots };
}

export function containerCommand(t, command, args, env = {}, roots = []) {
  const w=t.workspace, mounts=[];
  for (const p of ['/usr','/bin','/sbin','/lib','/lib64','/opt','/data/opt','/etc/ssl','/etc/alternatives','/etc/ld.so.cache',
    '/etc/java-21-openjdk','/etc/fonts','/etc/passwd','/etc/group','/etc/nsswitch.conf','/etc/hosts','/etc/resolv.conf',t.dir,
    path.join(process.env.XIN_WORK || '/data/workspace','stm32-template'),...roots,...(t.files||[]).map(f=>f.path)])
    if (fs.existsSync(p)) mounts.push('--ro-bind',p,p);
  for (const p of [w.work,w.home,w.tmp,w.io]) mounts.push('--bind',p,p);
  // Bootstrap namespaces with privilege, then drop uid, groups and all capabilities before any model code.
  // env -i also keeps the namespace's init process free of controller credentials.
  const parents=new Set(['/etc','/data','/run']);
  for(let i=0;i<mounts.length;i+=3){let p=path.dirname(mounts[i+1]);while(p!=='/'){parents.add(p);p=path.dirname(p);}}
  const dirs=[...parents].sort((a,b)=>a.length-b.length).flatMap(p=>['--perms','0755','--dir',p]);
  const a=['-n','/usr/bin/env','-i','PATH=/usr/bin:/bin','/usr/bin/bwrap','--unshare-pid','--unshare-ipc','--unshare-uts',
    '--die-with-parent','--clearenv',...dirs,...mounts,'--dev','/dev','--proc','/proc','--tmpfs','/tmp','--dir','/run','--chdir',w.work];
  const safe={HOME:w.home,TMPDIR:w.tmp,PATH:path.join(w.home,'bin')+':/usr/local/bin:/usr/bin:/bin',LANG:'C.UTF-8',
    XIN_TASK_IO:w.io,BASH_ENV:path.join(w.home,'shell-env.sh'),...env};
  for(const [k,v] of Object.entries(safe)) a.push('--setenv',k,v);
  return {command:'/usr/bin/sudo',args:a.concat(['--','/usr/bin/setpriv','--reuid='+process.getuid(),'--regid='+process.getgid(),
    '--clear-groups','--bounding-set=-all','--inh-caps=-all','--ambient-caps=-all','--no-new-privs',command,...args])};
}

export function confinedMcp(t, base, server) {
  const m=mcpTransport(t,base,server);
  return {...containerCommand(t,m.command,m.args,m.env,m.roots),cwd:t.workspace.work};
}

// The task receives a short-lived inference-only credential, never the reusable gateway key.
// The controller pins the model and endpoint and caps request size, concurrency and total requests.
export async function inferenceProxy({baseURL,key,model,maxRequests=128}) {
  const token=crypto.randomBytes(32).toString('hex'), clients=new Set(); let total=0,active=0,closed=false;
  const server=http.createServer(async(req,res)=>{
    const reject=(status,msg)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:msg}}));};
    if(closed || req.headers.authorization!=='Bearer '+token) return reject(401,'invalid task credential');
    if(req.method!=='POST' || req.url!=='/v1/responses') return reject(403,'inference endpoint only');
    if(total>=maxRequests || active>=4) return reject(429,'task request budget reached');
    active++; const abort=new AbortController(); clients.add(abort);
    try {
      let size=0;const chunks=[];
      for await(const chunk of req){size+=chunk.length;if(size>16*1024*1024){reject(413,'request too large');return;}chunks.push(chunk);}
      let body;try{body=JSON.parse(Buffer.concat(chunks).toString());}catch{return reject(400,'invalid JSON');}
      if(body.model!==model) return reject(403,'task model is pinned');
      total++;
      const response=await fetch(baseURL.replace(/\/$/,'')+'/responses',{method:'POST',headers:{authorization:'Bearer '+key,'content-type':'application/json',accept:req.headers.accept||'text/event-stream'},body:JSON.stringify(body),signal:abort.signal});
      res.writeHead(response.status,{'content-type':response.headers.get('content-type')||'application/json','cache-control':'no-store'});
      if(response.body) for await(const chunk of response.body){if(res.destroyed)break;res.write(chunk);}
      res.end();
    }catch {if(!res.headersSent) reject(502,'task inference connection failed');else res.end();}
    finally{active--;clients.delete(abort);}
  });
  server.requestTimeout=120000;server.headersTimeout=30000;
  await new Promise((ok,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',ok);});
  return {token,baseURL:'http://127.0.0.1:'+server.address().port+'/v1',close(){closed=true;for(const c of clients)c.abort();server.closeAllConnections();server.close();}};
}

export function containerAppServer(t, config, options) {
  const w=t.workspace, privateCodex=path.join(w.home,'.codex');mkdir(privateCodex);
  const disabled=config.filter(v=>/^mcp_servers\.[^.]+\.enabled=false$/.test(v)).map(v=>v.slice(0,-'enabled=false'.length));
  const cleaned=[];
  for(let i=0;i<config.length;i+=2){const v=config[i+1];if(!disabled.some(prefix=>v.startsWith(prefix)) && !/^(?:default_permissions|permissions\.|model_catalog_json=)/.test(v))cleaned.push('-c',v);}
  if(options.catalog){const catalog=path.join(privateCodex,'models.json');fs.copyFileSync(options.catalog,catalog);cleaned.push('-c','model_catalog_json='+JSON.stringify(catalog));}
  cleaned.push('-c','sandbox_mode="danger-full-access"','-c','model_providers.xin-gateway.base_url='+JSON.stringify(options.proxy.baseURL));
  const c=containerCommand(t,'/usr/local/bin/codex',['app-server','--stdio',...cleaned],{CODEX_HOME:privateCodex,XIN_CODEX_KEY:options.proxy.token},t.mcpRoots||[]);
  return {command:c.command,args:c.args,cwd:w.work};
}

export function drainBridge(workspace, handle) {
  if (!workspace) return;
  for (const name of fs.readdirSync(workspace.io).filter(n => /^[a-f0-9]{24}\.request$/.test(n)).slice(0, 32)) {
    const p = path.join(workspace.io, name);
    try {
      if (!fs.lstatSync(p).isFile() || fs.lstatSync(p).isSymbolicLink() || fs.statSync(p).size > 4096) { fs.unlinkSync(p); continue; }
      const a = JSON.parse(fs.readFileSync(p, 'utf8'));
      const reply = handle(a);
      fs.unlinkSync(p);
      fs.writeFileSync(p.replace(/\.request$/, '.reply'), String(reply).slice(0, 1500));
    } catch { try { fs.unlinkSync(p); } catch {} }
  }
}

// JSON-RPC adapter. A server lives for the active turn, accepts steering and emits the existing event format.
// Persisted thread IDs remain the recovery boundary; no native sub-agent scheduler is used.
export function appServer(cmd, configArgs, options) {
  const child = spawn(cmd, options.commandArgs || ['app-server', '--stdio', ...configArgs], options.spawn);
  let seq = 0, buffer = '', activeTurn = '', thread = '', ended = false;
  const pending = new Map();
  const send = o => { if (!child.stdin.destroyed) child.stdin.write(JSON.stringify(o) + '\n'); };
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(method + ' 没有回应')); }, 30000);
    pending.set(id, { resolve, reject, timer }); send({ id, method, params });
  });
  const emit = options.emit;
  const item = (i, done) => {
    if (!i) return;
    if (i.type === 'agentMessage' && done) emit({ type: 'item.completed', item: { id: i.id, type: 'agent_message', text: i.text || '' } });
    else if (i.type === 'commandExecution') emit({ type: done ? 'item.completed' : 'item.started', item: { id: i.id, type: 'command_execution', command: i.command, aggregated_output: i.aggregatedOutput || '', exit_code: i.exitCode, status: done ? 'completed' : 'in_progress' } });
    else if (i.type === 'fileChange' || i.type === 'mcpToolCall') emit({ type: done ? 'item.completed' : 'item.started', item: { id: i.id, type: i.type === 'mcpToolCall' ? 'mcp_tool_call' : 'file_change', server: i.server, tool: i.tool, arguments: i.arguments, status: i.status, changes: i.changes, result: i.result, error: i.error } });
  };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', data => {
    buffer += data;
    if (buffer.length > 4 * 1024 * 1024) { options.fail(new Error('app-server 单条事件过大')); child.kill('SIGTERM'); return; }
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.id != null && !m.method) {
        const p = pending.get(m.id); if (!p) continue;
        pending.delete(m.id); clearTimeout(p.timer);
        if (m.error) p.reject(new Error(m.error.message || JSON.stringify(m.error))); else p.resolve(m.result);
      } else if (m.id != null && m.method) {
        Promise.resolve(options.approve ? options.approve(m) : { decision: 'decline' }).then(result => send({ id: m.id, result })).catch(() => send({ id: m.id, result: { decision: 'decline' } }));
      } else {
        const p = m.params || {};
        if (m.method === 'turn/started') { activeTurn = p.turn.id; options.turn?.(thread, activeTurn); emit({ type: 'turn.started' }); }
        else if (m.method === 'item/started') item(p.item, false);
        else if (m.method === 'item/completed') item(p.item, true);
        else if (m.method === 'error' && !p.willRetry) emit({ type: 'turn.failed', error: p.error || p });
        else if (m.method === 'turn/completed') {
          activeTurn = ''; ended = true;
          if (p.turn?.status === 'failed') emit({ type: 'turn.failed', error: p.turn.error || { message: '任务失败' } });
          else if (p.turn?.status === 'interrupted') emit({ type: 'turn.failed', error: { message: '已中断' } });
          else emit({ type: 'turn.completed', usage: {} });
          options.complete?.(p.turn?.status === 'completed' ? 0 : 1); child.stdin.end();
          try { if (options.spawn.detached) process.kill(-child.pid,'SIGTERM'); else child.kill('SIGTERM'); } catch {}
          if (options.spawn.detached) setTimeout(()=>{ try { process.kill(-child.pid,'SIGKILL'); } catch {} },1500).unref();
        }
      }
    }
  });
  child.on('close', () => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('app-server 已退出')); } pending.clear(); });
  const start = async () => {
    await request('initialize', { clientInfo: { name: 'liming-xin', version: '2.0.0' }, capabilities: { experimentalApi: true } });
    send({ method: 'initialized', params: {} });
    const init = { cwd: options.cwd, model: options.model, approvalPolicy: options.boxed ? 'on-request' : 'never', config: { model_reasoning_effort: options.effort || 'max' } };
    const res = await request(options.thread ? 'thread/resume' : 'thread/start', options.thread ? { ...init, threadId: options.thread } : init);
    thread = res.thread.id;
    emit({ type: 'thread.started', thread_id: thread });
    if (options.rollback) await request('thread/rollback', { threadId: thread, numTurns: 1 });
    const input = [{ type: 'text', text: options.text }].concat((options.images || []).map(p => ({ type: 'localImage', path: p })));
    const r = await request('turn/start', { threadId: thread, input, effort: options.effort || 'max' });
    if (!ended) { activeTurn = r.turn.id; options.turn?.(thread, activeTurn); }
  };
  start().catch(e => { if (!ended) options.fail(e); child.kill('SIGTERM'); });
  return { child, steer: async (text, messageId) => {
    if (!activeTurn) throw new Error('当前轮次已结束');
    return request('turn/steer', { threadId: thread, expectedTurnId: activeTurn, clientUserMessageId: messageId, input: [{ type: 'text', text }] });
  }, interrupt: () => activeTurn ? request('turn/interrupt', { threadId: thread, turnId: activeTurn }) : Promise.resolve() };
}
