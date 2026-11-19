// Execution helpers. The controller owns state and credentials; tools see only a task workspace.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import dns from 'node:dns';
import { spawn, spawnSync } from 'node:child_process';
import { browserBroker } from './vm-browser.mjs';
import { steerBlock, LATE_STEER, LATE_STEER_MAX, DELIVERY } from './vm-steer.mjs';

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

// 任务副本放在控制器自己的目录（XIN_HOME 的同级 <名字>-tasks，正式云电脑上是 ~/.xin-tasks）：以前用 os.tmpdir()，
// 正式云电脑上是 /data/tmp，InstaBox 会删其中 10 天没用的文件，副本缺文件时写回会误报「将删除原文件」。
// 不放在 XIN_HOME 里（后台的权限配置拒绝它），也不放在 WORK 里（会出现在「小芯的文件」里、和项目目录重叠）。
export function taskRoot(controller) { return path.join(path.dirname(controller), path.basename(controller) + '-tasks'); }
// 旧版放在系统临时目录的副本照样认：续做、清理、删对话都要找得到
export function taskRoots(controller) { return [...new Set([taskRoot(controller), os.tmpdir()])]; }
// The script carries no run identity; the immutable mounted IO directory supplies its scope.
export function taskBridgeScript() {
  return `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const a=process.argv.slice(2),dir=process.env.XIN_TASK_IO;
if(a[0]==='browser'){
 // 浏览器：经转发端口发给控制器这一轮的浏览器代理（docs/xin-browser-v1-design.md），拿不到 CDP
 const http=require('node:http'),body=JSON.stringify({cmd:a[1]||'help',args:a.slice(2)});
 const q=http.request({host:'127.0.0.1',port:Number(process.env.XIN_BROWSER_PORT)||${TASK_PORTS.browser},method:'POST',path:'/',timeout:120000,headers:{'content-type':'application/json','content-length':Buffer.byteLength(body)}},res=>{
  let t='';res.setEncoding('utf8');res.on('data',d=>t+=d);res.on('end',()=>{let r={};try{r=JSON.parse(t);}catch{}
   if(r.ok){console.log(r.text);process.exit(0);}console.error(r.msg||'浏览器出错了');process.exit(1);});});
 q.on('timeout',()=>q.destroy(Error('timeout')));
 q.on('error',e=>{console.error(e.message==='timeout'?'浏览器这一步超时了':'这一轮没有可用的浏览器（电脑上没装 Chromium，或者这一轮已经结束）');process.exit(1);});
 q.end(body);
 return;
}
if(!dir||!(a[0]==='remember'||a[0]==='task'&&(a[1]==='ask'||a[1]==='note'))){console.error('后台只允许 xin remember、xin task ask、xin task note 和 xin browser');process.exit(1);}
const body={op:a[0]==='remember'?'remember':a[1],text:a.slice(a[0]==='remember'?1:2).join(' ').slice(0,1000)};
const directory=fs.openSync(dir,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW),root='/proc/self/fd/'+directory;
const id=crypto.randomBytes(12).toString('hex'),file=path.join(root,id+'.request'),output=fs.openSync(file+'.tmp','wx',0o600);
try{fs.writeFileSync(output,JSON.stringify(body));fs.fsyncSync(output);}finally{fs.closeSync(output);}
fs.renameSync(file+'.tmp',file);fs.fsyncSync(directory);
const until=Date.now()+15000,reply=path.join(root,id+'.reply');
while(!fs.existsSync(reply)&&Date.now()<until)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,50);
if(!fs.existsSync(reply)){console.error('管理进程没有回应，停止这一步');process.exit(1);}
console.log(fs.readFileSync(reply,'utf8'));fs.unlinkSync(reply);
fs.closeSync(directory);
`;
}

// Install through pinned directory descriptors. Never follow a writable home/bin symlink.
export function installTaskBridge(workspace, { shellEnvironment = false } = {}) {
  const fail = () => Object.assign(new Error('后台任务命令桥目录无效，未更新'), { code: 'bad_bridge_shim' });
  if (typeof shellEnvironment !== 'boolean' || typeof workspace?.home !== 'string' || !path.isAbsolute(workspace.home)) throw fail();
  const C = fs.constants; let home, bin, output, temporary;
  try {
    home = fs.openSync(workspace.home, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);
    const root = '/proc/self/fd/' + home;
    try { fs.mkdirSync(path.join(root, 'bin'), { mode: 0o755 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    bin = fs.openSync(path.join(root, 'bin'), C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);
    const files = [{ fd: bin, name: 'xin', body: taskBridgeScript(), mode: 0o755 }];
    if (shellEnvironment) files.push({ fd: home, name: 'shell-env.sh',
      body: 'export PATH=' + JSON.stringify(path.join(workspace.home, 'bin')) + ':"$PATH"\n', mode: 0o644 });
    for (const file of files) {
      const directory = '/proc/self/fd/' + file.fd;
      const candidate = path.join(directory, '.xin-' + crypto.randomBytes(16).toString('hex') + '.tmp');
      output = fs.openSync(candidate, C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, 0o600);
      temporary = candidate; // Only clean up a file whose exclusive creation succeeded.
      fs.writeFileSync(output, file.body); fs.fchmodSync(output, file.mode); fs.fsyncSync(output);
      fs.closeSync(output); output = undefined;
      fs.renameSync(temporary, path.join(directory, file.name)); temporary = undefined;
      fs.fsyncSync(file.fd);
    }
    fs.fsyncSync(home);
    const sameDirectory = (file, fd) => { const a = fs.lstatSync(file), b = fs.fstatSync(fd); return a.isDirectory() && !a.isSymbolicLink() && a.dev === b.dev && a.ino === b.ino; };
    if (!sameDirectory(workspace.home, home) || !sameDirectory(path.join(root, 'bin'), bin)) throw fail();
  } catch { throw fail(); }
  finally {
    if (output !== undefined) fs.closeSync(output);
    if (temporary) try { fs.unlinkSync(temporary); } catch {}
    if (bin !== undefined) fs.closeSync(bin);
    if (home !== undefined) fs.closeSync(home);
  }
}

export function prepareWorkspace(t, controller) {
  if (t.workspace && fs.existsSync(t.workspace.work) && fs.existsSync(t.workspace.manifest)) {if(t.workspace.stm32===undefined)t.workspace.stm32=detectStm32(t.dir,Object.keys(inventory(t.dir)));return t.workspace;}
  const base = taskRoot(controller); mkdir(base); fs.chmodSync(base, 0o700);
  const root = path.join(base, 'xin-task-' + t.sid);
  const work = path.join(root, 'work'), io = path.join(root, 'io'), home = path.join(root, 'home');
  mkdir(root); fs.chmodSync(root, 0o700); mkdir(work); mkdir(io); mkdir(home); mkdir(path.join(root, 'tmp'));
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
  installTaskBridge({ home }, { shellEnvironment: true });
  return { work, io, home, tmp: path.join(root, 'tmp'), manifest,stm32:detectStm32(t.dir,Object.keys(before)) };
}

export function publicationPlan(t, controller) {
  const { original, before } = JSON.parse(fs.readFileSync(path.join(controller, 'workspaces', t.sid + '.json'), 'utf8'));
  if (fs.realpathSync(t.dir) !== original) throw new Error('项目目录已改变，结果未覆盖原文件');
  const after = inventory(t.workspace.work), current = inventory(original);
  // 原项目已经等于副本的（上次写回到一半被杀、或别人恰好改成一样）算已写回：不算冲突，也不再写
  const changed = Object.keys(after).filter(n => before[n] !== after[n]), removed = Object.keys(before).filter(n => !(n in after));
  const applied = [...changed.filter(n => current[n] === after[n]), ...removed.filter(n => !(n in current))];
  const changes = changed.filter(n => current[n] !== after[n]), deleted = removed.filter(n => n in current);
  const conflicts = [...changes, ...deleted].filter(n => current[n] !== before[n]);
  return { original, before, after, current, changes, deleted, conflicts, applied };
}

export function publicationInventory(plan) {
  const entries = files => Object.keys(files).sort().map(name => [name, files[name]]);
  return crypto.createHash('sha256').update(JSON.stringify([plan.original, entries(plan.before), entries(plan.after)])).digest('hex');
}

function syncPath(file, flags = fs.constants.O_RDONLY) {
  const fd = fs.openSync(file, flags | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function syncParents(dir, root) {
  for (; under(dir, root); dir = path.dirname(dir)) {
    syncPath(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    if (dir === root) break;
  }
}

function currentFileHash(file) {
  let fd;
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); }
  catch (e) { if (e.code === 'ENOENT') return undefined; throw e; }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > 150 * 1024 * 1024) throw Error('项目文件在写回期间发生变化');
    return crypto.createHash('sha256').update(fs.readFileSync(fd)).digest('hex');
  } finally { fs.closeSync(fd); }
}

export function stm32Task(t) {
  if(!t.workspace || !['code','review'].includes(t.tkind)) return false;
  if(t.web){try{return !!t.workspace.stm32||detectStm32(t.workspace.work,Object.keys(inventory(t.workspace.work)));}catch{return true;}}
  if(t.workspace.stm32||/stm32|arm-none-eabi|cortex-m\d/i.test((t.goal||'')+' '+(t.userRequest||'')))return true;
  try{return detectStm32(t.workspace.work,Object.keys(inventory(t.workspace.work)));}catch{return true;} // Invalid trees must fail controlled validation, not bypass it.
}
function detectStm32(root,names){
  if(names.some(n=>/\.ioc$|(?:^|\/)[^/]*stm32[^/]*\.(?:c|h|s|ld)$/i.test(n)))return true;
  for(const n of names.filter(n=>/\.(?:c|h|cpp|hpp|cmake|ini|rs|toml)$|(?:^|\/)(?:Makefile|GNUmakefile|CMakeLists\.txt|xin-build\.json|\.cproject|\.project)$/i.test(n))){
    const fd=fs.openSync(path.join(root,n),fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const b=Buffer.alloc(65536),length=fs.readSync(fd,b,0,b.length,0);if(/stm32|arm-none-eabi|cortex-m\d/i.test(b.toString('utf8',0,length)))return true;}finally{fs.closeSync(fd);}
  }return false;
}
export function buildPlan(t){
  const root=t.workspace.work,names=Object.keys(inventory(root));let config={};
  if(names.includes('xin-build.json'))config=JSON.parse(fs.readFileSync(path.join(root,'xin-build.json'),'utf8'));
  const relative=p=>{if(typeof p!=='string'||path.isAbsolute(p)||p.split(/[\\/]/).includes('..'))throw Error('构建路径必须留在任务副本内');const full=path.resolve(root,p);if(!under(full,root))throw Error('构建路径越界');return full;};
  let directory=config.directory===undefined?null:relative(config.directory),system=config.system;
  if(system!==undefined&&!['make','cmake'].includes(system))throw Error('xin-build.json 只支持 make 或 cmake');
  if(!directory){
    if(names.some(n=>/^(?:GNUmakefile|[Mm]akefile)$/.test(n))){directory=root;system=system||'make';}
    else if(names.includes('CMakeLists.txt')){directory=root;system=system||'cmake';}
    else{
      const entries=names.filter(n=>/(?:^|\/)(?:GNUmakefile|[Mm]akefile|CMakeLists\.txt)$/.test(n)&&!/(?:^|\/)(?:build|out|Debug|Release|node_modules)(?:\/|$)/i.test(n));
      const dirs=[...new Set(entries.map(n=>path.dirname(n)))];
      if(dirs.length!==1)throw Error('STM32 工程缺少唯一构建入口，请用 xin-build.json 指定 system 和 directory');
      directory=relative(dirs[0]);system=system||(/CMakeLists\.txt$/.test(entries[0])?'cmake':'make');
    }
  }
  const local=path.relative(root,directory);const has=n=>names.includes((local?local+'/':'')+n);
  system=system||(has('Makefile')||has('makefile')||has('GNUmakefile')?'make':has('CMakeLists.txt')?'cmake':null);
  if(!system)throw Error('指定目录没有受支持的 STM32 构建入口');
  let artifacts=null;
  if(config.artifacts!==undefined){if(!Array.isArray(config.artifacts)||!config.artifacts.length||config.artifacts.length>32)throw Error('artifacts 必须是非空输出路径数组');artifacts=config.artifacts.map(p=>path.relative(root,relative(p)));}
  const configure=['-S',directory,'-B',path.join(directory,'build')];
  if(config.preset!==undefined){if(typeof config.preset!=='string'||!/^[A-Za-z0-9_.-]{1,80}$/.test(config.preset))throw Error('CMake preset 名称无效');configure.push('--preset',config.preset);}
  const toolchains=names.filter(n=>/(?:^|\/)(?:gcc-)?arm-none-eabi\.cmake$/i.test(n));
  const toolchain=config.toolchain!==undefined?relative(config.toolchain):toolchains.length===1?relative(toolchains[0]):null;
  if(toolchain)configure.push('-DCMAKE_TOOLCHAIN_FILE='+toolchain);
  const commands=system==='make'? [['/usr/bin/make',['-B','-C',directory]]]:[['/usr/bin/cmake',configure],['/usr/bin/cmake',['--build',path.join(directory,'build'),'--clean-first']]];
  return {directory,system,artifacts,commands};
}
function validBuildArtifact(file){
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{
    const st=fs.fstatSync(fd);if(!st.isFile()||!st.size||st.size>32*1024*1024)return false;
    const b=Buffer.alloc(st.size);if(fs.readSync(fd,b,0,b.length,0)!==b.length)return false;
    if(/\.elf$/i.test(file))return b.length>=52&&b.subarray(0,4).equals(Buffer.from([127,69,76,70]))&&b[4]===1&&b[5]===1&&b[6]===1&&b.readUInt16LE(18)===40;
    if(/\.hex$/i.test(file)){
      let data=false,eof=false;for(const line of b.toString('ascii').trim().split(/\r?\n/)){
        if(!/^:(?:[0-9a-f]{2})+$/i.test(line)||eof)return false;const record=Buffer.from(line.slice(1),'hex');
        if(record.length!==record[0]+5||record.reduce((a,v)=>a+v,0)%256)return false;
        if(record[3]===0&&record[0])data=true;if(record[3]===1)eof=true;
      }return data&&eof;
    }return /\.bin$/i.test(file);
  }finally{fs.closeSync(fd);}
}
export function compileWorkspace(t) {
  if(!stm32Task(t)) return null;
  let plan;try{plan=buildPlan(t);}catch(e){return {ok:false,output:e.message};}
  // Filesystem timestamps can lag Date.now() by a clock tick. Compare actual
  // before/after identity, timestamps and content; unchanged old/future-dated files are not evidence.
  const stamp=file=>{const s=fs.statSync(file,{bigint:true});return [s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].join(':');};
  let before;try{before=Object.fromEntries(Object.entries(inventory(t.workspace.work)).filter(([n])=>plan.artifacts?plan.artifacts.includes(n):/\.(?:hex|elf|bin)$/i.test(n)).map(([n,hash])=>[n,{hash,stamp:stamp(path.join(t.workspace.work,n))}]));}catch(e){return {ok:false,output:e.message};}
  let output='';
  for(const [command,args] of plan.commands){
    const c=containerCommand(t,command,args),result=spawnSync(c.command,c.args,{cwd:t.workspace.work,env:{PATH:'/usr/bin:/bin'},encoding:'utf8',timeout:60000,maxBuffer:2*1024*1024});
    output=((output+'\n'+(result.stdout||'')+'\n'+(result.stderr||'')+(result.error?'\n'+result.error.message:''))).slice(-10000);
    if(result.status!==0)return {ok:false,output};
  }
  let after;try{after=inventory(t.workspace.work);}catch(e){return {ok:false,output:output+'\n'+e.message};}
  const names=Object.keys(after);
  const candidates=plan.artifacts||names.filter(n=>/\.(?:hex|elf|bin)$/i.test(n));
  const artifacts=candidates.filter(n=>{const file=path.join(t.workspace.work,n),old=before[n];try{return names.includes(n)&&(!old||old.stamp!==stamp(file)||old.hash!==after[n])&&validBuildArtifact(file);}catch{return false;}});
  const ok=artifacts.length>0&&(!plan.artifacts||artifacts.length===plan.artifacts.length);
  return {ok,digest:ok?sourceDigest(t.workspace.work):null,artifacts,system:plan.system,output:output+(ok?'':'\n没有生成本次构建的新 ARM ELF / 有效 HEX / 非空 BIN 产物，不能使用旧文件作为编译证据。')};
}
export function validateTask(t, controller, meta, plan = publicationPlan(t, controller)) {
  if (!stm32Task(t)) return { applicable: false };
  if (!meta.compileTrusted || !meta.compileOk || meta.compileDigest !== sourceDigest(t.workspace.work)) return { error: 'STM32 程序必须在最终改动后通过受控 make / CMake 构建并生成新的有效产物；现在没有针对最终源码的成功编译记录。' };
  if(t.tkind==='code' && ![...plan.changes,...plan.applied].some(n=>/\.(?:c|h|s|cpp|hpp)$/i.test(n))) return {error:'STM32 实现任务没有源码改动，不能把只编译模板当成完成。请完成要求的程序后重新构建。'};
  const report = path.join(t.workspace.work, 'xin-review.json');
  if (t.tkind === 'review') {
    let data; try { data = JSON.parse(fs.readFileSync(report,'utf8')); } catch { return { error: '请生成 xin-review.json：verdict="pass"，checks 数组逐项写出 clock、pinmap、peripheral_clock、interrupt 的 id、status（pass/not_applicable）、reference（手册章节）和 evidence（源码文件:行号及判断依据）。' }; }
    if (data.verdict !== 'pass' || !Array.isArray(data.checks)) return { error: '检查报告没有通过；请修复问题并重新编译、核对。' };
    const missing=[];
    for(const id of ['clock','pinmap','peripheral_clock','interrupt']){
      const c=data.checks.find(c=>c.id===id);
      if(!c||!['pass','not_applicable'].includes(c.status)||typeof c.reference!=='string'||c.reference.trim().length<5||typeof c.evidence!=='string'||c.evidence.trim().length<8)missing.push(id);
    }
    if(missing.length)return {error:'请一次补齐这些检查项：'+missing.join('、')+'。每项必须有明确字段 id、status、reference（非空字符串，写官方手册章节）、evidence（非空字符串，写源码文件:行号和判断）。已有 manual_sections 等丰富字段可以保留，但不能代替 reference；请为全部四项补齐后再结束。'};
  }
  return { applicable: true, compiled: !!meta.compileOk, reviewed: t.tkind==='review', hardware: false };
}
export function sourceDigest(root) {
  const files = inventory(root);
  return crypto.createHash('sha256').update(JSON.stringify(Object.entries(files).filter(([n])=>/\.(?:c|h|s|cpp|hpp|ld|mk|cmake|ioc)$|(?:^|\/)(?:Makefile|GNUmakefile|CMakeLists\.txt|CMakePresets\.json|xin-build\.json)$/i.test(n)).sort(([a],[b])=>a.localeCompare(b)))).digest('hex');
}

export function publishWorkspace(t, controller, approval = null, finalization = null) {
  const plan = publicationPlan(t, controller);
  if (finalization && (publicationInventory(plan) !== finalization.inventory || !/^[a-f0-9]{32}$/.test(finalization.id)))
    throw Error('项目副本在收尾期间发生变化，已暂停写回。');
  // 批准的是这一份具体清单和文件内容，不是「这个任务以后都能删除/覆盖」。旧的无摘要批准也必须重新展示。
  const entries = [...new Set([...plan.changes, ...plan.deleted])].sort().map(name =>
    [name, plan.before[name] ?? null, plan.after[name] ?? null, plan.current[name] ?? null]);
  const id = 'publish-' + crypto.createHash('sha256').update(JSON.stringify({ sid: t.sid, original: plan.original, entries })).digest('hex');
  if (entries.length && (plan.deleted.length || plan.conflicts.length || approval) && approval?.id !== id)
    return { pending: true, id, changes: plan.changes, deleted: plan.deleted, conflicts: plan.conflicts };
  // Validate every destination before changing any file. Never follow a task-created or concurrent symlink.
  for (const name of [...plan.changes, ...plan.deleted]) {
    const dst = path.resolve(plan.original, name);
    if (!under(dst, plan.original)) throw new Error('结果路径越界');
    let parent = path.dirname(dst);
    while (!fs.existsSync(parent)) parent = path.dirname(parent);
    if (!under(fs.realpathSync(parent), plan.original)) throw new Error('结果路径包含外部软链接');
    if (fs.existsSync(dst) && fs.lstatSync(dst).isSymbolicLink()) throw new Error('结果路径变成了软链接');
  }
  const backup = path.join(controller, 'backups', 'task-' + t.no + '-' + (finalization ? finalization.at + '-' + finalization.id : Date.now()));
  const originals = finalization ? path.join(backup, 'originals') : backup;
  mkdir(backup);
  const created = plan.changes.filter(n => !fs.existsSync(path.join(plan.original, n)));
  for (const name of [...plan.changes, ...plan.deleted]) {
    const dst = path.join(plan.original, name);
    if (fs.existsSync(dst)) {
      const b = path.join(originals, name); mkdir(path.dirname(b)); fs.copyFileSync(dst, b);
      if (finalization) {
        if (currentFileHash(b) !== plan.current[name]) throw Error('项目文件在备份期间发生变化');
        syncPath(b); syncParents(path.dirname(b), controller);
      }
    }
  }
  // 写回清单：一批文件不是原子的。中途出错按清单从备份还原；中途被杀则下次收尾把已写回的算 applied、补齐剩下的。
  // 参考 opencode packages/core/src/snapshot.ts（按内容记录、按文件还原）
  const record = state => {
    const file = path.join(backup, 'publish.json');
    fs.writeFileSync(file, JSON.stringify({ state, changes: plan.changes, deleted: plan.deleted, created, applied: plan.applied, at: Date.now() }), { mode: 0o600 });
    if (finalization) { syncPath(file); syncParents(backup, controller); }
  };
  record('writing');
  const done = [], failAfter = Number(process.env.XIN_TEST_PUBLISH_FAIL_AFTER) || 0;
  const step = name => { done.push(name); if (failAfter && done.length >= failAfter) throw new Error('测试：模拟写回失败'); };
  try {
    for (const name of plan.changes) {
      const src = path.join(t.workspace.work, name), dst = path.join(plan.original, name);
      mkdir(path.dirname(dst)); const tmp = dst + '.xin-' + (finalization ? crypto.randomBytes(8).toString('hex') : process.pid);
      fs.copyFileSync(src, tmp, finalization ? fs.constants.COPYFILE_EXCL : 0);
      try {
        if (finalization && hash(tmp) !== plan.after[name]) throw Error('副本文件在写回期间发生变化');
        fs.chmodSync(tmp, fs.statSync(src).mode & 0o777);
        if (finalization) {
          syncPath(tmp);
          if (!under(fs.realpathSync(path.dirname(dst)),plan.original) || currentFileHash(dst) !== plan.current[name])
            throw Error('项目文件在写回期间发生变化');
        }
        fs.renameSync(tmp, dst); step(name);
        if (finalization) syncParents(path.dirname(dst), plan.original);
      } finally { if (finalization) fs.rmSync(tmp, { force: true }); }
    }
    for (const name of plan.deleted) { fs.unlinkSync(path.join(plan.original, name)); step(name); }
  } catch (e) {
    const failed = [];
    for (const name of done) {
      const dst = path.join(plan.original, name), saved = path.join(originals, name);
      try {
        if (process.env.XIN_TEST_RESTORE_FAIL === name) throw new Error('测试：模拟还原失败');
        if (finalization && currentFileHash(dst) !== plan.after[name]) throw Error('项目文件已被其他操作修改');
        if (fs.existsSync(saved)) { mkdir(path.dirname(dst)); const tmp = dst + '.xin-restore-' + process.pid; fs.copyFileSync(saved, tmp); fs.renameSync(tmp, dst); }
        else fs.rmSync(dst, { force: true });
      } catch { failed.push(name); }   // 磁盘满时还原也可能失败：如实说，备份目录和 publish.json 留着清单
    }
    try { record(failed.length ? 'rollback_incomplete' : 'rolled_back'); } catch { /* 记不下来也要把真实情况告诉调用方 */ }
    throw new Error(failed.length ? '写回中途失败，有 ' + failed.length + ' 个文件没能还原（' + failed.slice(0, 10).join('、') + '），写回前的备份在 ' + backup + '：' + e.message
      : '写回中途失败，原项目已还原：' + e.message);
  }
  record('done');
  return { ok: true, files: plan.changes.length + (finalization ? plan.applied.filter(n => n in plan.after).length : 0), deleted: plan.deleted.length, backup };
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
    // Fallback exec transport only: its commands share the host network, so they get none at all.
    '-c', 'permissions.xin-task.network.enabled=false', '-c', 'shell_environment_policy.inherit="none"',
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

// Task containers get a private network namespace: only their own loopback exists, so the desktop
// (VNC/X11), the model gateway and every other host service are unreachable. Controller services
// enter through Unix sockets mounted read-only; TASK_FORWARDER maps fixed loopback ports to them.
export const TASK_PORTS = { inference: 18080, egress: 18081, browser: 18082 };
export const TASK_FORWARDER = String.raw`const net=require('node:net'),os=require('node:os'),{spawn}=require('node:child_process');
const [spec,command,...args]=process.argv.slice(1),forward=JSON.parse(spec);let child=null,waiting=forward.length;
const start=()=>{child=spawn(command,args,{stdio:'inherit'});child.on('error',e=>{console.error('任务进程未能启动：'+e.message);process.exit(127);});
 child.on('exit',(code,signal)=>process.exit(code==null?128+(os.constants.signals[signal]||1):code));};
for(const s of ['SIGTERM','SIGINT','SIGHUP'])process.on(s,()=>child?child.kill(s):process.exit(143));
for(const [port,socket] of forward){
 const server=net.createServer(client=>{const upstream=net.connect(socket),close=()=>{client.destroy();upstream.destroy();};
  for(const x of [client,upstream]){x.on('error',close);x.on('close',close);}client.pipe(upstream);upstream.pipe(client);});
 server.on('error',e=>{console.error('任务网络转发未能启动：'+e.message);process.exit(1);});
 server.listen(port,'127.0.0.1',()=>{if(--waiting===0)start();});
}
if(!waiting)start();`;
export function containerCommand(t, command, args, env = {}, roots = [], network = null) {
  const w=t.workspace, mounts=[], forward=network?.forward||[];
  const readOnly=['/usr','/bin','/sbin','/lib','/lib64','/opt','/data/opt','/etc/ssl','/etc/alternatives','/etc/ld.so.cache',
    '/etc/java-21-openjdk','/etc/fonts','/etc/passwd','/etc/group','/etc/nsswitch.conf','/etc/hosts','/etc/resolv.conf',t.dir,
    path.join(process.env.XIN_WORK || '/data/workspace','stm32-template'),...roots,...(t.files||[]).map(f=>f.path)];
  const node=forward.length?fs.realpathSync(process.execPath):null;
  if(node&&!readOnly.some(p=>under(node,p)))readOnly.push(node);
  for (const p of readOnly) if (fs.existsSync(p)) mounts.push('--ro-bind',p,p);
  for (const p of [w.work,w.home,w.tmp,w.io]) mounts.push('--bind',p,p);
  // The socket directory is controller-owned and read-only inside: a task cannot replace a socket.
  for (const dir of new Set(forward.map(([,socket])=>path.dirname(socket)))) mounts.push('--ro-bind',dir,dir);
  // Bootstrap namespaces with privilege, then drop uid, groups and all capabilities before any model code.
  // env -i also keeps the namespace's init process free of controller credentials.
  const parents=new Set(['/etc','/data','/run']);
  for(let i=0;i<mounts.length;i+=3){let p=path.dirname(mounts[i+1]);while(p!=='/'){parents.add(p);p=path.dirname(p);}}
  const dirs=[...parents].sort((a,b)=>a.length-b.length).flatMap(p=>['--perms','0755','--dir',p]);
  const a=['-n','/usr/bin/env','-i','PATH=/usr/bin:/bin','/usr/bin/bwrap','--unshare-pid','--unshare-ipc','--unshare-uts','--unshare-net',
    '--die-with-parent','--clearenv',...dirs,...mounts,'--dev','/dev','--proc','/proc','--tmpfs','/tmp','--dir','/run','--chdir',w.work];
  const proxy='http://127.0.0.1:'+TASK_PORTS.egress, local='127.0.0.1,localhost,::1';
  const egress=network?.egress?{HTTP_PROXY:proxy,HTTPS_PROXY:proxy,http_proxy:proxy,https_proxy:proxy,NO_PROXY:local,no_proxy:local}:{};
  const safe={HOME:w.home,TMPDIR:w.tmp,PATH:path.join(w.home,'bin')+':/usr/local/bin:/usr/bin:/bin',LANG:'C.UTF-8',
    XIN_TASK_IO:w.io,BASH_ENV:path.join(w.home,'shell-env.sh'),...egress,...env};
  for(const [k,v] of Object.entries(safe)) a.push('--setenv',k,v);
  const inner=forward.length?[node,'-e',TASK_FORWARDER,'--',JSON.stringify(forward),command,...args]:[command,...args];
  return {command:'/usr/bin/sudo',args:a.concat(['--','/usr/bin/setpriv','--reuid='+process.getuid(),'--regid='+process.getgid(),
    '--clear-groups','--bounding-set=-all','--inh-caps=-all','--ambient-caps=-all','--no-new-privs',...inner])};
}

// Outbound access for task containers: plain HTTP and CONNECT, public unicast addresses only.
// The address is resolved and checked here, then used for the connection itself (no DNS rebinding).
// Separate lists: a single BlockList matches IPv4 addresses against the IPv4-mapped IPv6 range.
const NON_PUBLIC_V4 = new net.BlockList(), NON_PUBLIC_V6 = new net.BlockList();
for (const [a, p] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],
  ['192.0.2.0',24],['192.88.99.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]]) NON_PUBLIC_V4.addSubnet(a, p, 'ipv4');
for (const [a, p] of [['::',127],['::ffff:0:0',96],['64:ff9b::',96],['100::',64],['2001::',32],['2001:db8::',32],['2002::',16],['fc00::',7],['fe80::',10],['ff00::',8]]) NON_PUBLIC_V6.addSubnet(a, p, 'ipv6');
export function publicAddress(ip) {
  ip = String(ip || ''); const family = net.isIP(ip);
  return family === 4 ? !NON_PUBLIC_V4.check(ip, 'ipv4') : family === 6 ? !NON_PUBLIC_V6.check(ip, 'ipv6') : false;
}
const listenSocket = (server, socketPath) => new Promise((ok, no) => {
  try { fs.unlinkSync(socketPath); } catch { /* no stale socket */ }
  server.once('error', no); server.listen(socketPath, () => { fs.chmodSync(socketPath, 0o600); ok(); });
});
// socketPath：给容器转发用的 unix socket；不给就只听 127.0.0.1 的随机端口（给控制器自己的 Chromium 当代理，vm-browser.mjs）
export async function egressProxy({ socketPath, ports = [80, 443], lookup = (host, o) => dns.promises.lookup(host, o), allowAddress = publicAddress, maxConnections = 32 }) {
  const open = new Set(), track = s => { open.add(s); s.on('close', () => open.delete(s)); };
  const portOk = p => typeof ports === 'function' ? !!ports(p) : ports.includes(p);
  const resolve = async host => {
    host = String(host).replace(/^\[|\]$/g, '');
    const list = net.isIP(host) ? [{ address: host }] : await lookup(host, { all: true, verbatim: true }).catch(() => []);
    const hit = list.find(x => allowAddress(x.address));
    if (!hit) throw Object.assign(Error('后台任务只能访问公网地址'), { status: 403 });
    return hit.address;
  };
  const server = http.createServer(async (req, res) => {
    const deny = (status, msg) => { if (!res.headersSent) res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' }); res.end(msg); };
    let url; try { url = new URL(req.url); } catch { return deny(400, '代理请求需要完整网址'); }
    const port = Number(url.port || 80);
    if (url.protocol !== 'http:' || !portOk(port)) return deny(403, '后台任务只能访问公网的 80/443 端口');
    let address; try { address = await resolve(url.hostname); } catch (e) { return deny(e.status || 502, e.message); }
    const headers = { ...req.headers, host: url.host }; delete headers['proxy-connection']; delete headers['proxy-authorization'];
    const upstream = http.request({ host: address, port, method: req.method, path: url.pathname + url.search, headers, setHost: false }, r => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    upstream.setTimeout(120000, () => upstream.destroy(Error('timeout')));
    upstream.on('error', () => deny(502, '连接失败'));
    req.pipe(upstream);
  });
  server.on('connect', async (req, client, head) => {
    track(client); client.setTimeout(300000, () => client.destroy()); client.on('error', () => client.destroy());
    const refuse = status => client.end('HTTP/1.1 ' + status + ' Blocked\r\n\r\n');
    const m = /^(\[[0-9a-fA-F:.]+\]|[^:\s]+):(\d{1,5})$/.exec(req.url || ''), port = m && Number(m[2]);
    if (!m || !portOk(port)) return refuse(403);
    if (open.size > maxConnections) return refuse(429);
    let address; try { address = await resolve(m[1]); } catch (e) { return refuse(e.status || 502); }
    const upstream = net.connect({ host: address, port, timeout: 15000 });
    let connected = false;
    track(upstream);
    upstream.once('connect', () => { connected = true; upstream.setTimeout(0); client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head?.length) upstream.write(head); upstream.pipe(client); client.pipe(upstream); });
    upstream.on('timeout', () => upstream.destroy());
    upstream.on('error', () => { if (!connected && client.writable) refuse(502); upstream.destroy(); });
    upstream.on('close', () => client.destroy()); client.on('close', () => upstream.destroy());
  });
  server.headersTimeout = 30000; server.requestTimeout = 0;
  if (socketPath) await listenSocket(server, socketPath);
  else await new Promise((ok, no) => { server.once('error', no); server.listen(0, '127.0.0.1', ok); });
  return { socket: socketPath || null, port: socketPath ? null : server.address().port, close() { for (const s of open) s.destroy(); server.closeAllConnections(); server.close(); } };
}
// One task turn's network: egress for tools, plus the pinned inference proxy for the model client,
// plus this turn's browser broker（浏览器 v1，docs/xin-browser-v1-design.md）：Chromium 第一次用到才启动，这一轮结束连资料一起删。
// browser.testNet 只给测试用（放行本机测试页面）；正式调用不传，按公网地址检查。
export const CHROMIUM = () => process.env.XIN_CHROMIUM || '/usr/lib/chromium/chromium';
export async function taskNetwork(workspace, inference = null, browser = {}) {
  if (!workspace?.io) throw new Error('后台任务缺少隔离工作区');
  const dir = path.join(path.dirname(workspace.io), 'net');
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const egress = await egressProxy({ socketPath: path.join(dir, 'egress.sock') });
  let proxy = null, broker = null;
  try {
    if (inference) proxy = await inferenceProxy({ ...inference, socketPath: path.join(dir, 'inference.sock') });
    const chrome = browser.chrome || CHROMIUM();
    if (fs.existsSync(chrome)) broker = await browserBroker({ chrome, socketPath: path.join(dir, 'browser.sock'), profileDir: path.join(path.dirname(workspace.io), 'browser-profile'),
      work: workspace.work, headless: browser.headless ?? !browser.display, display: browser.display || '', log: browser.log || (() => {}),
      egress: browser.testNet?.egress || egressProxy, allowAddress: browser.testNet?.allowAddress || publicAddress, ports: browser.testNet?.ports || [80, 443], noSandbox: !!browser.noSandbox,
      sites: browser.sites || [], logins: browser.logins || null, step: browser.step || null });
  } catch (e) { proxy?.close(); egress.close(); throw e; }
  const forward = [[TASK_PORTS.egress, egress.socket]].concat(proxy ? [[TASK_PORTS.inference, proxy.socket]] : [], broker ? [[TASK_PORTS.browser, broker.socket]] : []);
  return { token: proxy?.token || null, baseURL: proxy ? 'http://127.0.0.1:' + TASK_PORTS.inference + '/v1' : null,
    network: { forward, egress: true }, close() { broker?.closeNow(); proxy?.close(); egress.close(); } };
}

export function confinedMcp(t, base, server) {
  const m=mcpTransport(t,base,server);
  return {...containerCommand(t,m.command,m.args,m.env,m.roots),cwd:t.workspace.work};
}

// The task receives a short-lived inference-only credential, never the reusable gateway key.
// The controller pins the model and endpoint and caps request size, concurrency and total requests.
export function requestBudget(file,limit=128,options={}) {
  limit=Math.min(512,Math.max(1,Math.floor(limit)));
  const read=()=>{try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return {};}};
  const save=value=>{
    mkdir(path.dirname(file));const tmp=file+'.'+process.pid+'.tmp';
    fs.writeFileSync(tmp,JSON.stringify({...value,limit,updated:Date.now()}),{mode:0o600});fs.renameSync(tmp,file);
  };
  const take=()=>{const b=read();if((b.used||0)>=limit||options.tokens>0&&(b.total||0)>=options.tokens)return false;save({...b,used:(b.used||0)+1,tokenLimit:options.tokens||null});return true;};
  take.recordUsage=u=>{const b=read();if(!u){save({...b,unknownUsage:(b.unknownUsage||0)+1});return;}const input=Math.max(0,Number(u.input_tokens)||0),output=Math.max(0,Number(u.output_tokens)||0),cached=Math.max(0,Number(u.input_tokens_details?.cached_tokens)||0);save({...b,input:(b.input||0)+input,output:(b.output||0)+output,cached:(b.cached||0)+cached,total:(b.total||0)+input+output});};
  take.recordCumulativeUsage=(provider,id,u)=>{
    const b=read(),key=provider+':'+id,previous=b.providerUsage?.[key]||{},next={};
    u={...u,total_tokens:u?.total_tokens??((Number(u?.input_tokens)||0)+(Number(u?.output_tokens)||0))};
    for(const k of ['input_tokens','output_tokens','cache_read_tokens','total_tokens']){next[k]=Math.max(0,Number(u?.[k])||0);if(next[k]<(previous[k]||0))throw Error('供应商累计用量倒退，未重复记账');}
    const delta=Object.fromEntries(Object.keys(next).map(k=>[k,next[k]-(previous[k]||0)]));
    // Antigravity's result usage covers the WHOLE resumed conversation. Store
    // the watermark with the budget, so both later turns and restarts use deltas.
    save({...b,input:(b.input||0)+delta.input_tokens,output:(b.output||0)+delta.output_tokens,cached:(b.cached||0)+delta.cache_read_tokens,total:(b.total||0)+delta.total_tokens,providerUsage:{...b.providerUsage,[key]:next}});
    return delta;
  };
  return take;
}
export async function inferenceProxy({baseURL,key,model,maxRequests=128,takeBudget,socketPath}) {
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
      if(takeBudget&&!takeBudget())return reject(400,'task inference budget exhausted; partial work is retained');
      total++;
      const response=await fetch(baseURL.replace(/\/$/,'')+'/responses',{method:'POST',headers:{authorization:'Bearer '+key,'content-type':'application/json',accept:req.headers.accept||'text/event-stream'},body:JSON.stringify(body),signal:abort.signal});
      res.writeHead(response.status,{'content-type':response.headers.get('content-type')||'application/json','cache-control':'no-store'});
      let buffer='',accounted=false;const decoder=new TextDecoder(),json=(response.headers.get('content-type')||'').includes('application/json');
      const account=data=>{const u=data.response?.usage||data.usage;if(u&&!accounted){takeBudget?.recordUsage?.(u);accounted=true;}};
      if(response.body) for await(const chunk of response.body){if(res.destroyed)break;res.write(chunk);buffer+=decoder.decode(chunk,{stream:true});if(!json){let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(line.startsWith('data:'))try{account(JSON.parse(line.slice(5).trim()));}catch{}}}if(buffer.length>2*1024*1024)buffer='';}
      if(json)try{account(JSON.parse(buffer));}catch{}if(!accounted)takeBudget?.recordUsage?.(null);
      res.end();
    }catch {if(!res.headersSent) reject(502,'task inference connection failed');else res.end();}
    finally{active--;clients.delete(abort);}
  });
  server.requestTimeout=120000;server.headersTimeout=30000;
  if(socketPath)await listenSocket(server,socketPath);
  else await new Promise((ok,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',ok);});
  return {token,socket:socketPath||null,baseURL:socketPath?null:'http://127.0.0.1:'+server.address().port+'/v1',close(){closed=true;for(const c of clients)c.abort();server.closeAllConnections();server.close();}};
}

export function containerAppServer(t, config, options) {
  const w=t.workspace, privateCodex=path.join(w.home,'.codex');mkdir(privateCodex);
  const disabled=config.filter(v=>/^mcp_servers\.[^.]+\.enabled=false$/.test(v)).map(v=>v.slice(0,-'enabled=false'.length));
  const cleaned=[];
  for(let i=0;i<config.length;i+=2){const v=config[i+1];if(!disabled.some(prefix=>v.startsWith(prefix)) && !/^(?:default_permissions|permissions\.|model_catalog_json=)/.test(v))cleaned.push('-c',v);}
  if(options.catalog){const catalog=path.join(privateCodex,'models.json');fs.copyFileSync(options.catalog,catalog);cleaned.push('-c','model_catalog_json='+JSON.stringify(catalog));}
  cleaned.push('-c','sandbox_mode="danger-full-access"','-c','model_providers.xin-gateway.base_url='+JSON.stringify(options.proxy.baseURL));
  const c=containerCommand(t,'/usr/local/bin/codex',['app-server','--stdio',...cleaned],{CODEX_HOME:privateCodex,XIN_CODEX_KEY:options.proxy.token},t.mcpRoots||[],options.proxy.network);
  return {command:c.command,args:c.args,cwd:w.work};
}

export function drainBridge(workspace, handle) {
  if (!workspace) return;
  const C=fs.constants;let directory;
  try {
    directory=fs.openSync(workspace.io,C.O_RDONLY|C.O_DIRECTORY|C.O_NOFOLLOW);
    // Resolve every operation through the pinned directory inode, even if its path is replaced.
    const root='/proc/self/fd/'+directory;
    for(const name of fs.readdirSync(root).filter(n=>/^[a-f0-9]{24}\.request$/.test(n)).slice(0,32)){
      const request=path.join(root,name),reply=path.join(root,name.replace(/\.request$/,'.reply'));let input,output,temporary,consumed=true;
      try{
        input=fs.openSync(request,C.O_RDONLY|C.O_NOFOLLOW|C.O_NONBLOCK);
        const stat=fs.fstatSync(input);if(!stat.isFile()||stat.size>4096)continue;
        const data=Buffer.alloc(4097),length=fs.readSync(input,data,0,data.length,0);
        if(length>4096)continue;
        const a=JSON.parse(data.subarray(0,length).toString('utf8'));
        consumed=false;
        try{fs.lstatSync(reply);consumed=true;continue;}catch(e){if(e.code!=='ENOENT')throw e;}
        // Publish only a complete reply. Both temporary creation and final link refuse existing entries.
        temporary=path.join(root,'.reply-'+crypto.randomBytes(16).toString('hex'));
        output=fs.openSync(temporary,C.O_WRONLY|C.O_CREAT|C.O_EXCL|C.O_NOFOLLOW,0o600);
        const result=handle(a,{id:name.slice(0,-'.request'.length)});
        if(typeof result!=='string')break;
        fs.writeFileSync(output,result.slice(0,1500));fs.fsyncSync(output);
        fs.linkSync(temporary,reply);fs.fsyncSync(directory);consumed=true;
      }catch{if(!consumed)break; /* uncertain delivery must retain the original request ID */ }
      finally{
        if(input!==undefined)fs.closeSync(input);
        if(output!==undefined)fs.closeSync(output);
        if(temporary)try{fs.unlinkSync(temporary);}catch{}
        if(consumed)try{fs.unlinkSync(request);}catch{}
      }
    }
  }catch{ /* a replaced or unavailable bridge directory cannot grant controller access */ }
  finally{if(directory!==undefined)fs.closeSync(directory);}
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
          if(options.stop)options.stop(child);else child.kill('SIGTERM');
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

// Foreground is an inference-only client, NOT a CLI with a filtered shell.
// Function arguments are data; no eval, shell, MCP, filesystem or browser tool exists here.
export const FRONT_MODEL = 'deepseek-v4.1-flash';
export const FRONT_GATEWAY_MS = 45000;
// acts: the mascot's display actions. bond/next/move only touch the page mascot and small personal data files.
export function frontCommand(argv, acts = []) {
  if (!Array.isArray(argv) || argv.length > 128 || argv.some(x => typeof x !== 'string' || x.length > 60000)) return false;
  if (argv[0] !== 'xin') return false;
  if (['remember','forget','recall','bond','next','move'].includes(argv[1])) return argv.length >= 3;
  if (argv[1] === 'task') return ['new','list','show','tell','stop'].includes(argv[2]);
  return acts.includes(argv[1]);
}
// 补充转过去以后那一句怎么说：照实际接法，只说一次（站长 2026-11-17：不先说「已记下」再说「已送进当前轮」）
const TELL_HINT = {
  now: '补充已经接进它正在做的这一轮，下一步就按新要求来：顺着他的话应一声，说清最后会按新要求给（像「行，最后只给你列正在用的」）。',
  next: '这一轮中途接不了，这一轮跑完才会按补充接着做：顺口告诉他这轮跑完会按他补的再来一遍（像「这轮跑完我就按你补的范围再核一遍」）。',
  start: '它还没开始，补充会在开始时一起带上：顺口应一声。',
  reply: '他这句当回复交过去了，接着做了。',
  resumed: '按他说的接着做了，之前的补充也带上了。'
};
export const frontLookupRequired=text=>/签到|每日任务|签到了|签过到/.test(String(text||''));
const claimsLookup=text=>/我(?:(?!没|未|不|想|要|会|打算|可以|需要)[^。！？!?，,\n]){0,12}(?:查了|查过|查到|翻了|翻过|翻到)/u.test(text)||/\bI(?:'ve| have| just| already| also)* (?:checked|looked up|searched)\b/i.test(text);
export async function frontTurn(o) {
  const abort = new AbortController();
  let expired=false;
  const cancel=()=>abort.abort();
  o.signal?.addEventListener('abort',cancel,{once:true});
  if(o.signal?.aborted)cancel();
  const timer = setTimeout(() => {expired=true;abort.abort();}, o.ms || 25000);
  const input = o.input.slice(), max = o.steps || 3;
  let usedCommand = false;
  const command = (...args) => { usedCommand = true; return o.command(...args); };
  // Expressions (mascot actions, bond, greeting, moves) never consume the work-step budget; they get their
  // own small cap, and the total number of model rounds stays bounded.
  const expression = argv => Array.isArray(argv) && argv[0] === 'xin' && (['bond','next','move'].includes(argv[1]) || (o.acts||[]).includes(argv[1]));
  let steps = 0, rounds = 0, expressed = 0;
  let lookedUp=false,lookupAttempted=false;
  const isLookup=argv=>argv?.[0]==='xin'&&(argv[1]==='recall'||argv[1]==='task'&&['list','show'].includes(argv[2]));
  const lookup=async()=>{
    lookupAttempted=true;
    const argv=['xin','task','list'],call_id='controller_lookup';
    const result=await command(argv,call_id);o.trace?.('xin',{argv},result);
    lookedUp=!!result&&!result.error;
    input.push({type:'function_call',name:'xin',call_id,arguments:JSON.stringify({argv})},
      {type:'function_call_output',call_id,output:JSON.stringify(result??{error:'没有查询结果'})});
    return lookedUp;
  };
  const textOf = data => (data?.output || []).filter(x => x.type === 'message').flatMap(x => x.content || []).filter(x => x.type === 'output_text').map(x => x.text).join('\n').trim();
  // 工作已经交出去以后要一句回兄弟的话：带上回执，tool_choice none；失败、超时、又想调工具都只是要不到这句话
  const ownWords = async (payload, calls, i, call, result) => {
    try {
      input.push({type:'function_call_output',call_id:call.call_id,output:JSON.stringify({ok:true,title:result.task.title,status:result.task.status,...(result.delivery?{delivery:result.delivery,how:DELIVERY[result.delivery]||''}:{})})});
      for (const c of calls.slice(i + 1)) input.push({type:'function_call_output',call_id:c.call_id,output:JSON.stringify({skipped:true})});
      input.push({role:'user',content:'已经交出去了。'+(TELL_HINT[result.delivery]||'')+'用你自己的话简短回兄弟一句，像朋友顺口应一声那样接住他这句话里的具体内容；别套固定说法，别预告结果和要多久，别提编号、模型和分身；不要再调用工具。'});
      const req = {...payload, input, tool_choice:'none'};
      let data;
      if (o.request) data = await o.request(req, abort.signal);
      else {
        const response = await (o.fetch||fetch)(o.baseURL.replace(/\/$/,'')+'/responses',{method:'POST',signal:abort.signal,headers:{authorization:'Bearer '+o.key,'content-type':'application/json'},body:JSON.stringify(req)});
        if (!response.ok) return '';
        data = await response.json();
      }
      o.usage?.(data.usage);
      const text = textOf(data);
      return text && !claimsLookup(text) ? text.slice(0, 2000) : '';
    } catch { return ''; }
  };
  try {
    // Factual daily questions always use a fresh, real read before the first model answer.
    if(o.lookupBeforeAnswer&&!await lookup())return '我还没查到可靠的当天记录，暂时不能确认。';
    while (steps < max && rounds++ < max + 2) {
      if(o.takeBudget&&!o.takeBudget())throw Error('本项工作的推理预算已用完，保留现有结果');
      const payload={model:FRONT_MODEL, stream:false, reasoning:{effort:'max'}, instructions:o.instructions, input,
          // 提示词 v2 以后 DeepSeek 想得更久（真实模型实测思考 1000–1700 token），1800 的上限一半被截断；放到 4000（docs/xin-prompt-v2.md）
          max_output_tokens:4000, tools:[{type:'function',name:'xin',description:'把要动手的事派给后台、查后台工作的真实进度、把兄弟的回复转给后台、记事和查以前的原话；也能做表情动作、留下次见面的开场白。argv 是参数数组，不是 shell。这一轮真的需要时才调用，没调用就不说查过；新建或转达工作后本轮立即结束，不预告结果和时间。',
            parameters:{type:'object',properties:{argv:{type:'array',items:{type:'string'}}},required:['argv'],additionalProperties:false},strict:true},...(o.handoff?[{type:'function',name:'finish_event',description:'对后台结果做最终决定：deliver 用自己的话把兄弟要的、或他该知道的新结果告诉他（text 就是给他的话，要紧的说全）；silent 用于重复、过期、已经说过、没有新东西的。',strict:true,parameters:{type:'object',properties:{action:{type:'string',enum:['deliver','silent']},text:{type:'string'}},required:['action','text'],additionalProperties:false}}]:[])]};
      let data;
      if(o.request)data=await o.request(payload,abort.signal);
      else{
        const response=await (o.fetch||fetch)(o.baseURL.replace(/\/$/,'')+'/responses',{method:'POST',signal:abort.signal,headers:{authorization:'Bearer '+o.key,'content-type':'application/json'},body:JSON.stringify(payload)});
        if(!response.ok)throw new Error('前台连接失败（HTTP '+response.status+'）');data=await response.json();
      }
      if (abort.signal.aborted) throw new Error('前台超时');
      const output = data.output || [], calls = output.filter(x => x.type === 'function_call');
      const said = output.filter(x => x.type === 'message').flatMap(x => x.content || []).filter(x => x.type === 'output_text').map(x => x.text).join('\n');
      // 推理把输出额度用完时，网关会标 incomplete，但正文可能已经在 output 里。先读正文，没有正文才算失败。
      if (data.error || data.status === 'failed' || (data.status === 'incomplete' && !said)) throw new Error('前台未完成回复');
      o.usage?.(data.usage);
      const parsed = calls.map(call => { try { return JSON.parse(call.arguments); } catch { return null; } });
      // Withhold an invented "I checked". Execute the read, then regenerate against its evidence.
      // A later turn or an injected old quote is never proof of a read in this turn.
      if(said&&!o.handoff&&!lookedUp&&claimsLookup(said)&&(!calls.length||calls.every((c,i)=>c.name==='xin'&&expression(parsed[i]?.argv)))){
        if(lookupAttempted||!await lookup())return '我还没查到可靠记录，暂时不能确认。';
        input.push({role:'user',content:'控制器刚刚才实际执行了查询。请依据上方工具结果重新回答，不要沿用没有证据的结论；查不到就明确说不能确认。'});
        continue;
      }
      // Text plus expressions only: perform them and answer now, without another model round.
      if (said && !o.handoff && calls.length && calls.every((c, i) => c.name === 'xin' && expression(parsed[i]?.argv))) {
        for (const [i, call] of calls.entries()) if (++expressed <= 2 && frontCommand(parsed[i].argv, o.acts)) await command(parsed[i].argv, call.call_id);
        return said;
      }
      if (!calls.length) {
        const text = said;
        if (!text) throw new Error('前台没有返回文字');
        if(o.handoff){const r=await o.deliver({action:'deliver',text});if(r.error)throw Error(r.msg||r.error);return '';}
        return text;
      }
      input.push(...output);
      for (const [i, call] of calls.entries()) {
        const args = parsed[i], free = call.name === 'xin' && expression(args?.argv);
        if (!free && ++steps > max) { o.trace?.(call.name, args, {error:'步数用完'}); return await o.fallback(); }
        const result = free && ++expressed > 2 ? {error:'这一轮的表情动作已经够了，直接回复用户。'}
          : o.handoff&&call.name==='finish_event'&&['deliver','silent'].includes(args?.action)
          ? await o.deliver(args)
          : call.name === 'xin' && frontCommand(args?.argv, o.acts)
          ? await command(args.argv, call.call_id)
          : {error:'请派出去：前台只能使用 xin task new/list/show/tell/stop、xin remember/forget/recall 和小芯自己的表情、好感度、开场白、动作。'};
        o.trace?.(call.name, args, result);
        if(call.name==='xin'&&isLookup(args?.argv)&&result&&!result.error)lookedUp=true;
        if (result.terminal) {
          // 派活、转达、停下之后用它自己的话回兄弟，不套「好，我这就去弄」（站长 2026-11-11）：
          // 同一条回复里写了话就用；没写就再要一句，不许再调工具；要不到才用控制器的那句。
          if (o.handoff || !result.task || !result.text) return result.text;
          // 补充：预先写好的话是照快照里的接法写的，实际接法不一样（reword）时不用它，带着回执再要一句（docs/superpowers/specs/2026-11-17-xin-steer-design.md §3）
          if (said && !claimsLookup(said) && !result.reword) return said.trim().slice(0, 2000);
          const own = await ownWords(payload, calls, i, call, result);
          return own || result.text;
        }
        input.push({type:'function_call_output',call_id:call.call_id,output:JSON.stringify(result)});
      }
    }
    return await o.fallback();
  } catch (e) {
    if (o.signal?.aborted) throw e;
    // Before any controller action, the saved request can get one fresh inference budget.
    if ((expired || e?.code === 'front_prompt_timeout') && !o.handoff && !usedCommand && o.useFallbackOnTimeout?.()) {
      return frontTurn({ ...o, ms: FRONT_GATEWAY_MS, useFallbackOnTimeout: undefined });
    }
    if (expired) return await o.fallback();
    throw e;
  } finally { clearTimeout(timer);o.signal?.removeEventListener('abort',cancel); }
}

// Delete only controller-owned ephemeral scratch, never the work tree or a user path.
// Pending questions/publication retain scratch for resume. Arbitrary files in work are NOT secret-scanned.
export function cleanupTaskTemporary(t, controller) {
  if (!['done','failed','stopped'].includes(t.status) || !t.workspace) return false;
  const root = path.dirname(String(t.workspace.tmp || '')), tmp=path.join(root,'tmp');
  if (!taskRoots(controller).some(base => root === path.join(base, 'xin-task-' + t.sid)) || t.workspace.tmp !== tmp || fs.realpathSync(root) !== root) throw new Error('临时目录归属不符，未清理');
  fs.rmSync(tmp,{recursive:true,force:true});mkdir(tmp);
  return true;
}

// 删对话时，它的后台任务在控制器外留下的东西一起删（审查问题 5）：/tmp 里的项目副本（含任务自己的 Codex 会话）、
// 工作区清单、用量记录、网页预览。每一样都核对归属；删不掉的记下来，不让删对话失败。返回删掉的字节数和没删掉的路径。
function treeBytes(p){let n=0;try{const st=fs.lstatSync(p);if(!st.isDirectory())return st.size;for(const e of fs.readdirSync(p))n+=treeBytes(path.join(p,e));}catch{}return n;}
function removeTree(p){
  try{fs.rmSync(p,{recursive:true,force:true});}
  catch{ // 只读的子目录（工具链常见）先放开写权限再删
    const open=d=>{try{fs.chmodSync(d,0o700);for(const e of fs.readdirSync(d,{withFileTypes:true}))if(e.isDirectory()&&!e.isSymbolicLink())open(path.join(d,e.name));}catch{}};
    open(p);fs.rmSync(p,{recursive:true,force:true});
  }
}
export function dropTaskFiles(t,controller){
  const out={bytes:0,kept:[]};
  if(!t||!/^s[0-9a-z]{6,24}$/.test(t.sid||''))return out;
  const drop=(p,check=()=>true)=>{
    try{if(!fs.existsSync(p))return;if(!check())throw Error('owner');const b=treeBytes(p);removeTree(p);out.bytes+=b;}
    catch{out.kept.push(p);}
  };
  for(const base of taskRoots(controller)){
    const copy=path.join(base,'xin-task-'+t.sid);
    drop(copy,()=>{const st=fs.lstatSync(copy);return st.isDirectory()&&!st.isSymbolicLink()&&fs.realpathSync(copy)===copy;});
  }
  drop(path.join(controller,'workspaces',t.sid+'.json'));
  drop(path.join(controller,'budgets',t.sid+'.json'));
  const id=/[?&]id=([a-f0-9]{32})$/.exec(t.preview?.url||'')?.[1];
  if(id){const dir=path.join(controller,'previews',id);drop(dir,()=>{const st=fs.lstatSync(dir);if(!st.isDirectory()||st.isSymbolicLink())return false;const m=JSON.parse(fs.readFileSync(path.join(dir,'manifest.json'),'utf8'));return m.id===id&&m.sid===t.sid;});}
  return out;
}
// 保留期（站长 2026-11-11 同意）：做完的任务，结果已经写回项目，副本 7 天后删（每日清理时）；没做成、停了、等确认的
// 副本是进度，留到删对话为止。只认目录名 xin-task-<编号>、不是软链接、真实路径等于自身的。
export function pruneTaskCopies(controller,tasks,now=Date.now(),maxAge=7*86400e3){
  const out={removed:0,bytes:0};
  for(const t of tasks||[]){
    if(t?.status!=='done'||!(t.endedAt>0)||now-t.endedAt<maxAge||!/^s[0-9a-z]{6,24}$/.test(t.sid||''))continue;
    for(const base of taskRoots(controller)){
      const copy=path.join(base,'xin-task-'+t.sid);
      try{const st=fs.lstatSync(copy);if(!st.isDirectory()||st.isSymbolicLink()||fs.realpathSync(copy)!==copy)continue;const b=treeBytes(copy);removeTree(copy);out.removed++;out.bytes+=b;}catch{/* 没有或删不掉，下次 */}
    }
  }
  return out;
}
// 写回前的备份属于项目，按已有的 30 天保留期处理。新版目录还带稳定发布编号。
export function pruneBackups(controller,now=Date.now(),maxAge=30*86400e3){
  const root=path.join(controller,'backups'),out={removed:0,bytes:0};let names=[];try{names=fs.readdirSync(root);}catch{return out;}
  for(const name of names){
    const m=/^task-\d+-(\d{10,})(?:-[a-f0-9]{32})?$/.exec(name);if(!m||now-Number(m[1])<maxAge)continue;
    const p=path.join(root,name);try{const st=fs.lstatSync(p);if(!st.isDirectory()||st.isSymbolicLink())continue;const b=treeBytes(p);removeTree(p);out.removed++;out.bytes+=b;}catch{}
  }
  return out;
}

// Preview documents execute in an opaque origin. The owner session and API are never exposed to them.
export const WEB_PREVIEW_CSP = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
export function webManifest(t) {
  const root=t.workspace.work, names=inventory(root);
  const config=JSON.parse(fs.readFileSync(path.join(root,'xin-web.json'),'utf8'));
  if(typeof config.entry!=='string'||!/^[-a-zA-Z0-9_/ .]+\.html?$/.test(config.entry)||path.isAbsolute(config.entry)||config.entry.split('/').includes('..'))throw Error('xin-web.json 的 entry 必须是副本内的 HTML 文件');
  if(!Object.hasOwn(names,config.entry))throw Error('预览入口不存在');
  const file=path.resolve(root,config.entry);if(!under(file,root))throw Error('预览入口越界');
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);let html;
  try{const s=fs.fstatSync(fd);if(!s.isFile()||s.size>512*1024)throw Error('预览 HTML 必须是 512 KB 内的普通文件');html=fs.readFileSync(fd,'utf8');}finally{fs.closeSync(fd);}
  if(!/<html\b/i.test(html)||!/<body\b/i.test(html))throw Error('请交付完整 HTML 文档');
  // Self-contained output keeps the preview independent of temporary servers and third-party CDNs.
  if(/<(?:script|iframe|frame|embed)\b[^>]*\bsrc\s*=|<link\b[^>]*\bhref\s*=/i.test(html))throw Error('预览须自包含：CSS/JS 内联，不引用外部资源或临时端口');
  for(const a of html.matchAll(/<(?:img|source|video|audio)\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi))if(!/^(?:data:|blob:)/i.test(a[1]??a[2]??a[3]))throw Error('图片和音视频须嵌入 data URI，不能依赖临时服务');
  const checks=config.checks;
  if(!Array.isArray(checks)||!checks.length||checks.length>8)throw Error('xin-web.json 需要 1–8 个真实点击检查');
  for(const c of checks){
    if(!c||typeof c.selector!=='string'||!c.selector||c.selector.length>200||typeof c.expectSelector!=='string'||!c.expectSelector||c.expectSelector.length>200)throw Error('点击检查缺少 selector / expectSelector');
    if(!['expectText','expectClass','expectAttribute'].some(k=>Object.hasOwn(c,k)))throw Error('点击检查必须说明点击后的可观察变化');
    if(c.expectText!==undefined&&(typeof c.expectText!=='string'||!c.expectText||c.expectText.length>200))throw Error('expectText 无效');
    if(c.expectClass!==undefined&&(typeof c.expectClass!=='string'||!/^[-_a-zA-Z0-9]{1,80}$/.test(c.expectClass)))throw Error('expectClass 无效');
    if(c.expectAttribute!==undefined&&(!c.expectAttribute||! /^(?:data-[a-z0-9-]+|aria-[a-z-]+)$/.test(c.expectAttribute.name)||typeof c.expectAttribute.value!=='string'||c.expectAttribute.value.length>200))throw Error('expectAttribute 无效');
  }
  return {entry:config.entry,title:String(config.title||t.title||'我的作品').slice(0,80),checks,html,digest:crypto.createHash('sha256').update(html).digest('hex')};
}
export const WEB_BROWSER_CHECK=String.raw`
import fs from 'node:fs';import path from 'node:path';import http from 'node:http';import {spawn} from 'node:child_process';
const [file,tmp,configText,csp,browser='/usr/lib/chromium/chromium']=process.argv.slice(1),config=JSON.parse(configText),html=fs.readFileSync(file);
const profile=fs.mkdtempSync(path.join(tmp,'web-browser-'));let chrome,ws,server,requestId=0,chromeError='';const pending=new Map(),errors=[];
const pause=ms=>new Promise(r=>setTimeout(r,ms));
function rpc(method,params={}){return new Promise((resolve,reject)=>{const id=++requestId;const timer=setTimeout(()=>{pending.delete(id);reject(Error('浏览器检查超时：'+method));},5000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}));});}
async function evaluate(expression){const r=await rpc('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error('页面脚本执行失败');return r.result.value;}
let result,code=1;
try{
 server=http.createServer((q,r)=>{if(q.url==='/favicon.ico'){r.writeHead(204);r.end();return;}if(q.url!=='/'){r.writeHead(404);r.end();return;}r.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':csp});r.end(html);});
 await new Promise(ok=>server.listen(0,'127.0.0.1',ok));const origin='http://127.0.0.1:'+server.address().port;
 chrome=spawn(browser,['--headless','--no-sandbox','--disable-dev-shm-usage','--disable-background-networking','--disable-component-update','--disable-extensions','--disable-sync','--no-first-run','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{stdio:['ignore','ignore','pipe']});chrome.stderr.setEncoding('utf8');chrome.stderr.on('data',s=>{chromeError=(chromeError+s).slice(-1000);});
 const portFile=path.join(profile,'DevToolsActivePort');for(let i=0;i<480&&!fs.existsSync(portFile);i++){if(chrome.exitCode!==null)throw Error('Chromium 启动失败：'+chromeError);await pause(25);}if(!fs.existsSync(portFile))throw Error('Chromium 没有就绪：'+chromeError);
 // 调试端口就绪时页面不一定已经登记上（机器忙时见过），等它出现再连，最多 15 秒（几套浏览器测试并行时 5 秒都不够）
 const port=fs.readFileSync(portFile,'utf8').split('\n')[0];let page=null;for(let i=0;i<300&&!page;i++){try{page=(await (await fetch('http://127.0.0.1:'+port+'/json/list')).json()).find(p=>p.type==='page');}catch{}if(!page)await pause(50);}if(!page)throw Error('Chromium 没有打开页面：'+chromeError);
 ws=new WebSocket(page.webSocketDebuggerUrl);await new Promise((ok,no)=>{ws.addEventListener('open',ok,{once:true});ws.addEventListener('error',no,{once:true});});
 ws.addEventListener('message',event=>{const m=JSON.parse(event.data);if(m.id){const p=pending.get(m.id);if(p){pending.delete(m.id);clearTimeout(p.timer);if(m.error)p.reject(Error(m.error.message));else p.resolve(m.result);}}else if(m.method==='Runtime.exceptionThrown')errors.push('页面 JavaScript 报错');else if(m.method==='Runtime.consoleAPICalled'&&m.params.type==='error')errors.push('页面报告错误');else if(m.method==='Log.entryAdded'&&m.params.entry.level==='error')errors.push(String(m.params.entry.text).slice(0,150));});
 await rpc('Page.enable');await rpc('Runtime.enable');await rpc('Log.enable');
 const viewports=[];
 for(const width of [1280,390]){
  errors.length=0;await rpc('Emulation.setDeviceMetricsOverride',{width,height:800,deviceScaleFactor:1,mobile:false});await rpc('Page.navigate',{url:origin+'/'});
  let ready=false;for(let i=0;i<100;i++){if(await evaluate('document.readyState === "complete" && !!document.body')){ready=true;break;}await pause(30);}if(!ready)throw Error('预览未加载完成');await pause(250);
  const visible=await evaluate('({title:document.title,ok:[...document.body.querySelectorAll("*")].some(e=>{const r=e.getBoundingClientRect();return r.width>10&&r.height>10}),overflow:document.documentElement.scrollWidth>innerWidth})');
  if(!visible.ok||(!config.lenient&&(!visible.title||visible.overflow)))throw Error(width+' 像素预览为空、缺标题或横向溢出');
  for(const c of config.checks){
   const inspect='(()=>{const c='+JSON.stringify(c)+',e=document.querySelector(c.expectSelector);return e?{text:c.expectText===undefined?null:e.textContent,cls:c.expectClass===undefined?null:e.classList.contains(c.expectClass),attr:c.expectAttribute===undefined?null:e.getAttribute(c.expectAttribute.name)}:null;})()';
   const before=await evaluate(inspect);
   const point=await evaluate('(()=>{const e=document.querySelector('+JSON.stringify(c.selector)+');if(!e)return null;e.scrollIntoView({block:"center"});const r=e.getBoundingClientRect();return r.width&&r.height?{x:r.x+r.width/2,y:r.y+r.height/2}:null;})()');if(!point)throw Error('找不到可点击的元素：'+c.selector);
   await rpc('Input.dispatchMouseEvent',{type:'mouseMoved',...point});await rpc('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1});await rpc('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount:1});await pause(120);
   // Pages often update on the next frame or after a short transition: give the expected state up to 1.5 s to appear.
   const expect='(()=>{const c='+JSON.stringify(c)+',e=document.querySelector(c.expectSelector);return !!e&&(c.expectText===undefined||e.textContent.includes(c.expectText))&&(c.expectClass===undefined||e.classList.contains(c.expectClass))&&(c.expectAttribute===undefined||e.getAttribute(c.expectAttribute.name)===c.expectAttribute.value);})()';
   let actual=await evaluate(expect);for(const until=Date.now()+1400;!actual&&Date.now()<until;){await pause(100);actual=await evaluate(expect);}
   if(!actual){const now=await evaluate(inspect),what=!now?'找不到 '+c.expectSelector:c.expectClass!==undefined?c.expectSelector+' 没有 class '+c.expectClass:c.expectAttribute!==undefined?c.expectSelector+' 的 '+c.expectAttribute.name+' 是 '+JSON.stringify(now.attr)+'，不是 '+JSON.stringify(c.expectAttribute.value):c.expectSelector+' 的文字里没有 '+JSON.stringify(c.expectText);throw Error('点击 '+c.selector+' 后 1.5 秒内没有得到预期变化（'+what+'）；检查在同一页面按顺序连续点击，前面的动画可能还在播放');}
   if(JSON.stringify(before)===JSON.stringify(await evaluate(inspect)))throw Error('点击没有产生可观察变化：'+c.selector);
  }
  if(errors.length)throw Error(errors.join('；'));
  viewports.push({width,checks:config.checks.length});
 }
 // 截图给工作台的「网页」卡片（16:10 横框）：换回电脑宽度、重新打开（不带点击检查改过的样子），等入场动画走完再截。
 // 站长 2026-11-16：原来最后在 390×800 的手机宽度上截，竖图塞进横框只剩最上面一截空背景
 await rpc('Emulation.setDeviceMetricsOverride',{width:1280,height:800,deviceScaleFactor:1,mobile:false});await rpc('Page.navigate',{url:origin+'/'});
 for(let i=0;i<100;i++){if(await evaluate('document.readyState === "complete" && !!document.body'))break;await pause(30);}await pause(600);
 const shot=await rpc('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(tmp,'xin-web-preview.png'),Buffer.from(shot.data,'base64'));
 result={ok:true,viewports};code=0;
}catch(e){result={ok:false,error:String(e.message).slice(0,1000)};}finally{for(const p of pending.values())clearTimeout(p.timer);ws?.close();chrome?.kill('SIGKILL');server?.closeAllConnections();server?.close();}
process.stdout.write(JSON.stringify(result)+'\n',()=>process.exit(code));
`;
export function checkWebWorkspace(t) {
  let manifest;try{manifest=webManifest(t);}catch(e){return {ok:false,error:e.message};}
  const args=['--signal=KILL','40',process.execPath,'--input-type=module','-e',WEB_BROWSER_CHECK,path.join(t.workspace.work,manifest.entry),t.workspace.tmp,JSON.stringify({checks:manifest.checks}),WEB_PREVIEW_CSP];
  const c=containerCommand(t,'/usr/bin/timeout',args),r=spawnSync(c.command,c.args,{cwd:t.workspace.work,env:{PATH:'/usr/bin:/bin'},encoding:'utf8',timeout:46000,maxBuffer:2*1024*1024});
  let result;try{result=JSON.parse(r.stdout.trim());}catch{return {ok:false,error:'浏览器预览检查未完成：'+String(r.stderr||r.error?.message||'').slice(-700)};}
  return {...result,ok:r.status===0&&!!result.ok,entry:manifest.entry,title:manifest.title,digest:manifest.digest,screenshot:path.join(t.workspace.tmp,'xin-web-preview.png')};
}
export function publishWebPreview(t,controller,check,id) {
  const m=webManifest(t);if(!check?.ok||m.digest!==check.digest)throw Error('网页需要在最终修改后通过浏览器检查');
  return storePreview(t,controller,m,check,id);
}
// 不是「网页成品」的任务，这次新做或改过的 HTML（比如查资料时顺手做的看板）也给一个预览入口（站长 2026-11-11）。
// 只挑一个：层级最浅的，同层先 index.html。要自包含才能在预览的沙盒里打开；不要求点击检查，只在浏览器里打开截一张图。
export function findPage(t) {
  if(!t.workspace?.work||!t.workspace.manifest||!fs.existsSync(t.workspace.manifest))return null;
  let before={};try{before=JSON.parse(fs.readFileSync(t.workspace.manifest,'utf8')).before||{};}catch{}
  let now;try{now=inventory(t.workspace.work);}catch{return null;}
  const pages=Object.keys(now).filter(n=>/\.html?$/i.test(n)&&now[n]!==before[n]&&!n.split('/').some(p=>p.startsWith('.')));
  const index=n=>/(^|\/)index\.html?$/i.test(n)?0:1;
  pages.sort((a,b)=>a.split('/').length-b.split('/').length||index(a)-index(b)||a.localeCompare(b));
  return pages[0]||null;
}
function pageManifest(t,entry) {
  const root=t.workspace.work,file=path.resolve(root,entry);if(!under(file,root))throw Error('预览入口越界');
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);let html;
  try{const s=fs.fstatSync(fd);if(!s.isFile()||s.size>512*1024)throw Error('页面超过 512 KB');html=fs.readFileSync(fd,'utf8');}finally{fs.closeSync(fd);}
  if(!/<html\b/i.test(html)||!/<body\b/i.test(html))throw Error('不是完整的 HTML 文档');
  if(/<(?:script|iframe|frame|embed)\b[^>]*\bsrc\s*=|<link\b[^>]*\bhref\s*=/i.test(html))throw Error('页面引用了外部文件，预览里打不开');
  for(const a of html.matchAll(/<(?:img|source|video|audio)\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi))if(!/^(?:data:|blob:)/i.test(a[1]??a[2]??a[3]))throw Error('页面引用了外部图片或音视频，预览里打不开');
  const title=String((/<title[^>]*>([^<]{1,200})<\/title>/i.exec(html)||[])[1]||t.title||path.basename(entry)).trim().slice(0,80);
  return {entry,title,checks:[],html,digest:crypto.createHash('sha256').update(html).digest('hex')};
}
export function checkPageWorkspace(t) {
  const entry=findPage(t);if(!entry)return null;
  let m;try{m=pageManifest(t,entry);}catch(e){return {ok:false,entry,error:e.message};}
  const args=['--signal=KILL','40',process.execPath,'--input-type=module','-e',WEB_BROWSER_CHECK,path.join(t.workspace.work,entry),t.workspace.tmp,JSON.stringify({checks:[],lenient:true}),WEB_PREVIEW_CSP];
  const c=containerCommand(t,'/usr/bin/timeout',args),r=spawnSync(c.command,c.args,{cwd:t.workspace.work,env:{PATH:'/usr/bin:/bin'},encoding:'utf8',timeout:46000,maxBuffer:2*1024*1024});
  let result;try{result=JSON.parse(r.stdout.trim());}catch{return {ok:false,entry,error:'页面没能在浏览器里打开'};}
  return {...result,ok:r.status===0&&!!result.ok,entry,title:m.title,digest:m.digest,screenshot:path.join(t.workspace.tmp,'xin-web-preview.png')};
}
export function publishPagePreview(t,controller,check,id) {
  const m=pageManifest(t,check?.entry||'');if(!check?.ok||m.digest!==check.digest)throw Error('页面在打开检查之后又改过');
  return storePreview(t,controller,m,check,id);
}
function storePreview(t,controller,m,check,stableId) {
  if(stableId&&!/^[a-f0-9]{32}$/.test(stableId))throw Error('收尾预览标识无效');
  const id=stableId||crypto.randomBytes(16).toString('hex'),root=path.join(controller,'previews'),dest=path.join(root,id);mkdir(root);
  const checks = stableId ? m.checks.map(({selector,expectSelector,expectText,expectClass,expectAttribute})=>(
    {selector,expectSelector,expectText,expectClass,...(expectAttribute ? {expectAttribute:{name:expectAttribute.name,value:expectAttribute.value}} : {})})) : m.checks;
  const result=meta=>({id,title:meta.title,url:'/xin/preview.html?id='+id,ready:true,run:meta.run,at:meta.at,viewports:meta.viewports,checks});
  if(stableId&&fs.existsSync(dest)){
    if(!fs.lstatSync(dest).isDirectory()||!fs.lstatSync(path.join(dest,'manifest.json')).isFile())throw Error('已存在的收尾预览无法核对');
    const html=previewAsset(controller,{id}),shot=previewAsset(controller,{id,file:'preview.png'});
    const meta=html.real&&shot.real&&JSON.parse(fs.readFileSync(path.join(dest,'manifest.json'),'utf8'));
    if(!meta||meta.sid!==t.sid||meta.run!==lastRunId(t)||html.sha256!==m.digest||hash(html.real)!==m.digest||hash(shot.real)!==shot.sha256)
      throw Error('已存在的收尾预览无法核对');
    return result(meta);
  }
  const staging=fs.mkdtempSync(path.join(root,'.'+id+'-'));
  try{
    fs.writeFileSync(path.join(staging,'index.html'),m.html,{mode:0o400,flag:'wx'});
    const shot=fs.openSync(check.screenshot,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);let screenshot;
    try{const s=fs.fstatSync(shot);if(!s.isFile()||s.size>16*1024*1024)throw Error('预览截图不是有效的普通文件');screenshot=fs.readFileSync(shot);}finally{fs.closeSync(shot);}
    if(!screenshot.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw Error('缺少真实预览截图');fs.writeFileSync(path.join(staging,'preview.png'),screenshot,{mode:0o400,flag:'wx'});
    const meta={id,sid:t.sid,parent:t.parent,run:lastRunId(t),title:m.title,at:Date.now(),files:{'index.html':{mime:'text/html; charset=utf-8',size:Buffer.byteLength(m.html),sha256:m.digest},'preview.png':{mime:'image/png',size:screenshot.length,sha256:crypto.createHash('sha256').update(screenshot).digest('hex')}},viewports:check.viewports};
    fs.writeFileSync(path.join(staging,'manifest.json'),JSON.stringify(meta),{mode:0o400,flag:'wx'});
    if(stableId){for(const name of ['index.html','preview.png','manifest.json'])syncPath(path.join(staging,name));syncPath(staging);}
    fs.renameSync(staging,dest);if(stableId)syncPath(root);
    return result(meta);
  }catch(e){fs.rmSync(staging,{recursive:true,force:true});throw e;}
}
const lastRunId=t=>(t.runs||[]).at(-1)||null;
export function previewAsset(controller,a) {
  if(!/^[a-f0-9]{32}$/.test(a.id||'')||!['index.html','preview.png'].includes(a.file||'index.html'))return {error:'bad_preview',msg:'预览地址不正确'};
  const dir=path.join(controller,'previews',a.id),file=a.file||'index.html';
  try{const m=JSON.parse(fs.readFileSync(path.join(dir,'manifest.json'),'utf8')),entry=m.files[file],real=path.join(dir,file);if(!entry||m.id!==a.id||fs.lstatSync(dir).isSymbolicLink()||!fs.lstatSync(real).isFile())throw Error('bad file');return {real,...entry,title:m.title,parent:m.parent};}catch{return {error:'not_found',msg:'找不到这个预览'};}
}

// Antigravity keeps its login in the controller profile. Its model receives no
// native file/terminal/MCP permission; requested commands run through bwrap here.
/* Antigravity 的后台执行模型。站长 2026-11-13：「后台干活优先也派 hydrogen，根据任务难度选择思考强度」，以前的 Gemini 模型不再用。
   只用 Gemini 4 Hydrogen，思考强度按任务类别（前台派活时定的类别就是难度）：参考 Codex 的 model_reasoning_effort / plan_mode_reasoning_effort、
   opencode 每个 agent 自己的 reasoningEffort、Antigravity Orchestrator（Carbon 规划、Hydrogen 执行）。
   实测每一步（结构化动作）：low 3 秒、medium 5 秒、high 7 秒、xhigh 30 秒。 */
export const AGY_MODEL='gemini-4-hydrogen';   // 前台用的（站长 11-18：前台 Hydrogen High）；后台按类别见 vm-models.mjs 的 agyPick
/* 站长 11-19：后台写代码换 Gemini 4 Neon（High，难题 Extra = xhigh），检查和查资料用 Gemini 4 Argon；Hydrogen 后台不再默认用。
   额度分池（li 上 agy -p /usage 实测）：Neon、Hydrogen 共用 Gemini 池（gemini-5h、gemini-weekly），Argon 单独一池（gemini-argon-wtu-weekly）。
   li 上按小芯的单步方式实测：Hydrogen High 6～8 秒一步，Argon Medium ≈7.5，Argon High ≈13，Neon High 16～25，Neon Extra ≈45。
   档位照 agy models 列出的：Argon 没有 xhigh。 */
export const AGY_NEON='gemini-4-neon',AGY_ARGON='gemini-4-argon';
export const AGY_CATALOG={
  [AGY_MODEL]:{name:'Gemini 4 Hydrogen',pool:'gemini',efforts:['low','medium','high','xhigh']},
  [AGY_NEON]:{name:'Gemini 4 Neon',pool:'gemini',efforts:['low','medium','high','xhigh']},
  [AGY_ARGON]:{name:'Gemini 4 Argon',pool:'argon',efforts:['low','medium','high']}
};
export const isAgyModel=id=>Object.hasOwn(AGY_CATALOG,String(id||''));
export const agyPool=id=>isAgyModel(id)?AGY_CATALOG[id].pool:null;
export const AGY_EFFORTS=['low','medium','high','xhigh'];
export const AGY_KIND_EFFORT={quick:'low',research:'medium',code:'high',review:'high',hard:'xhigh'};
// 这个模型没有的档位（Argon 的 xhigh）降到它有的、不高于要的那档里最高的；不认识的档当 high
function agyLevel(model,effort){
  const have=(AGY_CATALOG[model]||AGY_CATALOG[AGY_MODEL]).efforts,want=AGY_EFFORTS.includes(effort)?effort:'high';
  return have.includes(want)?want:have.filter(e=>AGY_EFFORTS.indexOf(e)<=AGY_EFFORTS.indexOf(want)).at(-1)||have[0];
}
export const agyEffort=(kind,model=AGY_MODEL)=>agyLevel(model,AGY_KIND_EFFORT[kind]||'high');
// CLI 里的模型编号带思考强度（gemini-4-neon-xhigh、gemini-4-argon-medium）
export const agyProviderModel=(model,effort)=>(isAgyModel(model)?model:AGY_MODEL)+'-'+agyLevel(isAgyModel(model)?model:AGY_MODEL,effort);
export function antigravityBinary(home=process.env.XIN_AGY_HOME||os.homedir()) {
  return [process.env.XIN_ANTIGRAVITY_BIN,path.join(home,'.local/bin/agy'),path.join(home,'.gemini/bin/agy')].find(p=>p&&fs.existsSync(p))||null;
}
export function antigravityQuota(result,now=Date.now(),model=AGY_MODEL) {
  const groups=result?.command?.data?.groups;
  if(!Array.isArray(groups))throw Error('Antigravity 没有返回可核对的额度信息');
  // 按额度组算：Claude/GPT 一组（3p-），Gemini 4 Argon 单独一组（gemini-argon-），其余 Gemini（Flash、Hydrogen）一组。
  // 2026-11-13 新账号多了 Argon 的单独周限额：以前按 gemini- 前缀把它也算进来，Argon 用完会被当成 Hydrogen / Flash 也用完。
  const family=model.startsWith('claude-')?/^(?:claude-|3p-)/:/argon/.test(model)?/^gemini-argon-/:/^gemini-(?!argon-)/;
  // 停用的限额（disabled）不起作用，也不带恢复时间：周限额用完后，Antigravity 把五小时限额标成停用、去掉 reset_time。
  // 把它当成「字段不完整」会让前台整轮报错，而不是按额度用完改用 DeepSeek。
  const buckets=groups.flatMap(g=>g.buckets||[]).filter(b=>family.test(b?.id||'')&&b.disabled!==true).map(b=>({id:b.id,remaining:Number(b.remaining_fraction),resetAt:Date.parse(b.reset_time)}));
  if(!buckets.length||buckets.some(b=>!Number.isFinite(b.remaining)||b.remaining<0||b.remaining>1||!Number.isFinite(b.resetAt)))throw Error('Antigravity 额度字段不完整');
  const exhausted=buckets.filter(b=>b.remaining<=0);
  return {model,checkedAt:now,buckets,blocked:exhausted.length>0,retryAt:exhausted.length?Math.max(...exhausted.map(b=>b.resetAt)):0};
}
export const AGY_SETTINGS={toolPermission:'request-review',allowNonWorkspaceAccess:false,useG1Credits:false,permissions:{deny:['command(*)','read_file(*)','write_file(*)','execute_url(*)','mcp(*)'],allow:['read_url(*)']}};
export function mergeAntigravityQuota(old,next,now=Date.now()) {
  if(!old?.blocked||old.retryAt<=now)return next;
  // A slower successful query must not erase a concurrent quota exhaustion.
  const buckets=next.buckets.map(b=>{const prior=old.buckets?.find(p=>p.id===b.id&&p.remaining<=0&&p.resetAt>now);return prior?{...b,remaining:0,resetAt:Math.max(b.resetAt,prior.resetAt)}:b;});
  const exhausted=buckets.filter(b=>b.remaining<=0);return {...next,buckets,blocked:exhausted.length>0,retryAt:exhausted.length?Math.max(...exhausted.map(b=>b.resetAt)):0};
}
const AGY_SCHEMA={type:'object',properties:{action:{type:'string',enum:['shell','final','ask','remember','note']},command:{type:'string'},text:{type:'string'}},required:['action','command','text'],additionalProperties:false};
/* Gemini（Antigravity）一直不出声（2026-11-12 正式站联调：2 分 20 秒一个字不回）：idleMs 内 stdout 什么都没有就当卡住，杀掉、回 stalled。
   参考 opencode 的 chunkTimeout（两段输出之间等不到就中止）、Codex 的 stream_idle_timeout_ms。正常的第一步 16–101 秒（11-12 的 cli.log），取 2 分钟 */
export const AGY_IDLE_MS = () => Number(process.env.XIN_AGY_IDLE_MS) || 120000;
function agyProcess(binary,args,cwd,onEvent=()=>{},idleMs=0) {
  return new Promise((resolve,reject)=>{
    const child=spawn(binary,args,{cwd,stdio:['ignore','pipe','pipe'],env:{HOME:process.env.XIN_AGY_HOME||os.homedir(),PATH:process.env.PATH||'/usr/local/bin:/usr/bin:/bin',LANG:'C.UTF-8'}});
    let buf='',stderr='',result=null,model=null,bytes=0,stalled=false,idle=null;
    const timer=setTimeout(()=>child.kill('SIGKILL'),260000);timer.unref();
    const poke=()=>{if(!idleMs)return;clearTimeout(idle);idle=setTimeout(()=>{stalled=true;child.kill('SIGKILL');},idleMs);idle.unref?.();};
    poke();
    child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
    child.stdout.on('data',s=>{poke();bytes+=Buffer.byteLength(s);if(bytes>4*1024*1024){child.kill('SIGKILL');return;}buf+=s;let i;while((i=buf.indexOf('\n'))>=0){const line=buf.slice(0,i);buf=buf.slice(i+1);try{const o=JSON.parse(line);if(o.event==='init')model=o.init?.model;if(o.event==='result')result=o.result;onEvent(o);}catch{}}});
    child.stderr.on('data',s=>{stderr=(stderr+s).slice(-4000);});
    child.on('error',e=>{clearTimeout(timer);clearTimeout(idle);reject(e);});
    child.on('close',code=>{clearTimeout(timer);clearTimeout(idle);resolve({code,result,model,stderr,stalled});});
  });
}
// 按任务自己的模型查它那个池（Neon、Hydrogen 看 Gemini 池，Argon 看 Argon 池）
export async function readAntigravityQuota(binary,cwd,model=AGY_MODEL) {
  const r=await agyProcess(binary,['-p','/usage','--output-format','stream-json','--print-timeout','25s'],cwd);
  if(r.code!==0)throw Error('Antigravity 额度查询失败');return antigravityQuota(r.result,Date.now(),model);
}
export async function antigravityWork(t,options) {
  const binary=antigravityBinary();if(!binary)throw Error('Antigravity 命令不可用');
  const model=isAgyModel(options.model)?options.model:AGY_MODEL,effort=agyLevel(model,options.effort),provider=agyProviderModel(model,effort);
  if(!t.workspace)throw Error('Antigravity 只接收隔离的项目副本');
  const report=o=>process.stdout.write(JSON.stringify(o)+'\n');
  if(options.quotaState?.blocked&&options.quotaState.retryAt>Date.now()){report({type:'error',message:'Antigravity 额度仍在倒计时，按已记录的恢复时间等待。'});return 75;}
  const clientDir=options.clientDir;if(!clientDir||under(clientDir,t.workspace.work))throw Error('Antigravity 客户端目录必须由控制器单独持有');
  let quota;try{quota=await readAntigravityQuota(binary,clientDir,model);}catch{quota=null;}
  // A lost cache-report reply cannot invalidate the fresh provider reading; never replay its sample here.
  if(quota)try{options.quota(quota);}catch(e){if(!['owner_unavailable','state_disconnected','state_timeout','state_client_failed'].includes(e?.code)||![false,'unknown'].includes(e?.executed))throw e;}
  if(quota?.blocked){report({type:'error',message:'Antigravity 额度暂不可用，已记录服务端恢复时间。'});return 75;}
  if(!quota)throw Error('暂时无法核对 Antigravity 额度，保留任务交给其他执行入口');
  const home=process.env.XIN_AGY_HOME||os.homedir(),agents=path.join(home,'.gemini/config/agents');mkdir(agents);
  const agent=path.join(agents,'xin-confined-worker.md'),body='---\nname: xin-confined-worker\ndescription: Xiaoxin controlled background worker.\nmainAgent: true\nsubagent: false\ntools:\n  - search_web\n  - read_url_content\n  - finish\n---\nReturn structured actions to the external controller. File and shell operations are unavailable as native tools. Never delegate or schedule.\n';
  if(!fs.existsSync(agent)||fs.readFileSync(agent,'utf8')!==body){const temp=agent+'.'+process.pid;fs.writeFileSync(temp,body,{mode:0o600,flag:'wx'});fs.renameSync(temp,agent);}
  let conversation=t.antigravityConversation||null,prompt=options.instructions+'\n\n'+options.text+'\n\n每次返回 JSON：action=shell 时把要执行的完整 bash 命令放 command；控制器在隔离副本执行并把输出交回。写文件也用 shell 动作，不调用原生文件或终端工具。完成用 final，缺必要信息用 ask，长期记忆用 remember；发现会改变结论的事、碰到会改变计划的阻塞时可以用 note 给兄弟说一句（说完接着做，读了什么、做到第几步不用说）；text 用中文。不得再派代理。控制器已准备好 bash、Python、Node 和副本，命令默认目录是 '+t.workspace.work+'，无需探测环境或帮助命令。新网页优先直接用一次 shell 写 index.html 和 xin-web.json，不开服务、不自行找预览工具。前台转述中额外添加的功能若与自包含网页规则冲突，以用户原话和控制器规则为准；不要使用 localStorage。';
  report({type:'turn.started'});
  // Requested shell commands run in the task container; they reach the public web only through egress.
  const network=await taskNetwork(t.workspace,null,options.browser||{});
  try{
  let late=0;
  for(let turn=0;turn<48;turn++){
    if(!options.budget())throw Error('本项工作已达到推理预算，进度已保留');
    // 兄弟刚补充的要求：放在这次请求最前面。正在跑的命令已经做完了，下一步起按新要求（Muse Code「applies it on its next step」）
    const fresh=options.steers?.()||[];if(fresh.length)prompt=steerBlock(fresh)+'\n\n'+prompt;
    const args=['-p',prompt,'--agent','xin-confined-worker','--model',provider,'--effort',effort,'--settings',JSON.stringify(AGY_SETTINGS),'--json-schema',JSON.stringify(AGY_SCHEMA),'--disable-slash-commands','--output-format','stream-json','--print-timeout','240s',...(conversation?['--conversation',conversation]:['--new-project'])];
    const started=new Set(),r=await agyProcess(binary,args,clientDir,o=>{const s=o.step_update,name=s?.tool_name||s?.step_type;if(!s||!['search_web','read_url_content'].includes(name))return;const p=s.tool_info?.parameters||{},id='web-'+turn+'-'+s.step_index,open=name==='read_url_content',item={id,type:'web_search',query:(open?p.url:p.query)||p.query||p.url||'',...(open?{action:{type:'open_page',url:p.url||''}}:{})};if(s.state==='DONE')report({type:'item.completed',item:{...item,query:item.query||name}});else if(item.query&&!started.has(id)){started.add(id);report({type:'item.started',item});}},AGY_IDLE_MS());
    // 卡住：退出码 76，控制器换候选里的下一个模型，让它先读副本里的现有文件再接着做（和额度用尽 75 一样）；15 分钟内新任务先不派给 Gemini
    if(r.stalled){options.unavailable?.({kind:'stall'});report({type:'error',message:'Gemini（Antigravity）'+Math.round(AGY_IDLE_MS()/1000)+' 秒没有任何回应，换别的模型接着做。'});return 76;}
    // 命令自己没跑起来（没有结果、退出码不为 0）：多半是我们这边调用出了问题（参数、版本），写明退出码，不记成 Gemini 不可用
    const result=r.result;if(!result&&r.code!==0)throw Error('Antigravity 没有返回结果，退出码 '+r.code+'，已保留进度');
    if(r.model!==provider)throw Error('Antigravity 实际模型与指定模型不一致');
    if(result?.usage&&result.conversation_id){const delta=options.budget.recordCumulativeUsage('antigravity',result.conversation_id,result.usage);report({type:'xin.usage',usage:delta});}
    else options.budget.recordUsage?.(null);
    if(r.code!==0||result?.status!=='SUCCESS'){
      try{quota=await readAntigravityQuota(binary,clientDir,model);options.quota(quota);}catch{}
      if(quota?.blocked||/quota|rate.limit|resource.exhausted/i.test(JSON.stringify(result||{})+' '+r.stderr)){report({type:'error',message:'Antigravity 额度已用尽，已保留当前文件和额度记录。'});return 75;}
      // 服务答了但没做完（2026-11-13 正式站：约 2 分钟后回了不是 SUCCESS 的状态，同时只回「OK」也要 118 秒）：和不出声一样记下，15 分钟内新任务先不派给它
      const status=String(result?.status||'').replace(/[^A-Za-z_]/g,'').slice(0,32)||'空';
      if(result)options.unavailable?.({kind:'status',status});
      throw Error('Antigravity 本轮未完成（'+(result?'状态 '+status:'没有返回结果，退出码 '+r.code)+'），已保留进度');
    }
    conversation=result.conversation_id||conversation;if(conversation)options.conversation(conversation);
    let a=result.structured_output;try{a=a||JSON.parse(result.response);}catch{throw Error('Antigravity 未返回可执行的结构化动作');}
    if(!a||!AGY_SCHEMA.properties.action.enum.includes(a.action)||typeof a.command!=='string'||typeof a.text!=='string')throw Error('Antigravity 动作字段无效');
    if(a.action==='final'||a.action==='ask'){
      // 交结果（或问问题）前再看一眼：这时又来了补充就不结束，带着补充再走一步（Codex：这一轮还有待处理的输入就接着处理）
      const more=late<LATE_STEER_MAX?options.steers?.()||[]:[];
      if(more.length){late++;prompt=steerBlock(more)+'\n\n'+(a.action==='ask'?'你刚才想问兄弟：'+a.text+'\n先按补充判断还要不要问；能做就接着做。\n':'')+LATE_STEER;continue;}
      if(a.action==='ask')options.ask(a.text);
      report({type:'item.completed',item:{type:'agent_message',text:a.text}});
      try{options.quota(await readAntigravityQuota(binary,clientDir,model));}catch{}return 0;
    }
    if(a.action==='remember'){options.remember(a.text);prompt='已记录。请继续当前工作。';continue;}
    // 主动回原聊天说一句（docs/superpowers/specs/2026-11-17-xin-steer-design.md §4）：控制器记下、合并、到时候看还有没有用再发
    if(a.action==='note'){const r=options.note?.(a.text)||'已记下。';prompt=r+'\n请继续当前工作。';continue;}
    if(!a.command.trim()||Buffer.byteLength(a.command)>256*1024)throw Error('Antigravity 命令为空或过长');
    const id='agy-'+turn;report({type:'item.started',item:{id,type:'command_execution',command:a.command}});
    const c=containerCommand(t,'/bin/bash',['-lc',a.command],{},[],network.network);
    const resultCommand=await new Promise(resolve=>{const ch=spawn(c.command,c.args,{cwd:t.workspace.work,stdio:['ignore','pipe','pipe'],env:{PATH:'/usr/bin:/bin'}});let out='';const collect=s=>{out=(out+s).slice(-64000);};ch.stdout.on('data',collect);ch.stderr.on('data',collect);const timer=setTimeout(()=>{ch.kill('SIGKILL');},60000);timer.unref();ch.on('error',e=>{clearTimeout(timer);resolve({code:127,out:e.message});});ch.on('close',code=>{clearTimeout(timer);resolve({code:code??1,out});});});
    report({type:'item.completed',item:{id,type:'command_execution',command:a.command,exit_code:resultCommand.code,aggregated_output:resultCommand.out}});
    prompt='控制器执行结果（仅副本；不要重复已成功的操作）：\n'+JSON.stringify(resultCommand)+'\n请继续下一步，完成则返回 final。';
  }
  throw Error('Antigravity 达到本轮动作上限，进度已保留');
  }finally{network.close();}
}
