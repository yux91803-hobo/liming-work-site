// 平板装机脚本 site/tablet/setup.sh（docs/superpowers/specs/2026-11-25-tablet-dshgo-design.md §4.3、§4.4）
// 假 ssh：记下每次调用；「cat 安装包」给测试 zip（主机有 no-zip-<主机> 标记时报错）；「bash -s」在该主机自己的临时 HOME 里真的执行远端脚本。
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),tablet=path.join(root,'site/tablet'),setup=path.join(tablet,'setup.sh');
const tmp=t=>{const d=fs.mkdtempSync(path.join(os.tmpdir(),'tablet-setup-'));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));return d;};
const FAKE_SSH=`#!/usr/bin/env bash
target=""; cmd=()
while [ $# -gt 0 ]; do case "$1" in -o|-p|-i|-l) shift 2;; -n|-T|-q) shift;; *) if [ -z "$target" ]; then target=$1; else cmd+=("$1"); fi; shift;; esac; done
host=\${target#*@}
printf '%s %s\\n' "$target" "\${cmd[*]}" >> "$FAKE_DIR/ssh.log"
case "\${cmd[*]}" in
  "cat "*) [ -f "$FAKE_DIR/no-zip-$host" ] && { echo "cat: no such file" >&2; exit 1; }; cat "$FAKE_ZIP";;
  "bash -s") HOME="$FAKE_DIR/home-$host" LIMING_REMOTE_WS="$FAKE_DIR/ws-$host" bash -s;;
  *) echo "unexpected: \${cmd[*]}" >&2; exit 2;;
esac
`;
function makeZip(file,extra={}){
  const files={'wb-proxy/wb_proxy.py':'print("fake")\n','wb-proxy/bin/wb-tls-bridge-linux-arm64':'bin\n','wb-proxy/start-wb-proxy.sh':'#!/bin/sh\n',...extra};
  const r=spawnSync('python3',['-c','import json,sys,zipfile\nz=zipfile.ZipFile(sys.argv[1],"w")\nfor k,v in json.loads(sys.argv[2]).items(): z.writestr(k,v)\nz.close()',file,JSON.stringify(files)]);
  assert.equal(r.status,0,String(r.stderr));
  const buf=fs.readFileSync(file);return {size:String(buf.length),sha:crypto.createHash('sha256').update(buf).digest('hex')};
}
function remoteHome(dir,host){
  const h=path.join(dir,'home-'+host);fs.mkdirSync(path.join(h,'.local/bin'),{recursive:true});fs.mkdirSync(path.join(h,'.xin'));
  fs.writeFileSync(path.join(h,'.local/bin/dsh'),'#!/bin/sh\necho "$*" >> "$HOME/dsh.log"\n',{mode:0o755});fs.writeFileSync(path.join(h,'.xin/harness.key'),'remote-secret-key\n',{mode:0o600});
  return h;
}
// 终端里依次输入：li2 令牌、li2 只读 key、li2 写 key、li 令牌、li 只读 key、li 写 key（空行 = 回车跳过或保留原来的）
const KEYS={li2read:'ibk_li2read_SECRET111',li2write:'ibk_li2write_SECRET222',liread:'ibk_liread_SECRET333',liwrite:'ibk_liwrite_SECRET444'};
const INPUT=['ssh ibssh_li2token@li2.example',KEYS.li2read,KEYS.li2write,'ssh ibssh_litoken@li.example',KEYS.liread,KEYS.liwrite];
function rig(t,tokens=INPUT){
  const d=tmp(t),bin=path.join(d,'bin');fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin,'ssh'),FAKE_SSH,{mode:0o755});
  fs.writeFileSync(path.join(bin,'dsh'),'#!/bin/sh\necho "$*" >> "$FAKE_DIR/dsh.log"\n',{mode:0o755});
  fs.writeFileSync(path.join(bin,'apt-get'),'#!/bin/sh\necho "$*" >> "$FAKE_DIR/apt.log"\n',{mode:0o755});
  fs.writeFileSync(path.join(d,'tty'),tokens.join('\n')+'\n');
  const zip=path.join(d,'gw.zip'),z=makeZip(zip);
  remoteHome(d,'li2.example');remoteHome(d,'li.example');
  const env={...process.env,FAKE_DIR:d,FAKE_ZIP:zip,LIMING_BASE:'file://'+tablet,LIMING_GW_DIR:path.join(d,'gw'),LIMING_PLUGIN_DIR:path.join(d,'plugin'),LIMING_CLOUD_PLUGIN_DIR:path.join(d,'cloud-plugin'),LIMING_CLOUD_DIR:path.join(d,'cloud'),
    LIMING_SSH:path.join(bin,'ssh'),LIMING_DSH:path.join(bin,'dsh'),LIMING_APT:path.join(bin,'apt-get'),LIMING_TTY:path.join(d,'tty'),LIMING_ZIP_SIZE:z.size,LIMING_ZIP_SHA256:z.sha};
  const run=(...args)=>spawnSync('bash',[setup,...args],{env,encoding:'utf8',input:''});
  const lib=(code,...args)=>spawnSync('bash',['-c','source "$0"; '+code,setup,...args],{env:{...env,LIMING_SETUP_LIB:'1'},encoding:'utf8'});
  const read=f=>{try{return fs.readFileSync(path.join(d,f),'utf8');}catch{return '';}};
  return {d,env,run,lib,read,zip,z};
}
const mode=f=>fs.statSync(f).mode&0o777;

test('语法对、不含任何令牌或 key；默认校验值就是从 li 核对过的那份安装包',t=>{
  assert.equal(spawnSync('bash',['-n',setup]).status,0);
  const walk=d=>fs.readdirSync(d,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(d,e.name)):[path.join(d,e.name)]);
  for(const f of walk(tablet)){const s=fs.readFileSync(f,'utf8');
    for(const re of [/ibssh_[A-Za-z0-9]{8,}/,/ibk_[A-Za-z0-9]{8,}/,/sk-[A-Za-z0-9]{16,}/])assert.ok(!re.test(s),path.relative(root,f)+' 里像有密钥：'+re);}
  const r=spawnSync('bash',['-c','source "$0"; echo "$ZIP_SIZE $ZIP_SHA256 $REMOTE_ZIP"',setup],{env:{PATH:process.env.PATH,LIMING_SETUP_LIB:'1'},encoding:'utf8'});
  assert.equal(r.stdout.trim(),'22962873 b322c73b9a18f09c6560bff0e4b748e9acdc26272c339b4f5fce2413bb500cc6 /data/workbuddy-gateway/releases/workbuddy2api-hub-v2.0.8.zip');
});

test('令牌行各种粘法都认得；不是令牌行就拒绝，而且不回显令牌',t=>{
  const {lib}=rig(t);
  for(const line of ['ssh ibssh_ab12@x.instabox.sh','  ibssh_ab12@x.instabox.sh\r','ssh  ibssh_ab12@x.instabox.sh  ']){
    const r=lib('parse_token_line "$1"',line);assert.equal(r.status,0,JSON.stringify(line));assert.equal(r.stdout,'ibssh_ab12@x.instabox.sh\n');}
  for(const line of ['ssh root@x','ibssh_ab12','ssh ibssh_ab12@x; rm -rf /','ssh -p 22 ibssh_ab12@x','']){
    const r=lib('parse_token_line "$1"',line);assert.notEqual(r.status,0,JSON.stringify(line));assert.ok(!(r.stdout+r.stderr).includes('ab12'));}
});

test('下载到的是网站首页（不存在的路径回首页）或内容不对就停，不留半截文件',t=>{
  const {d,lib}=rig(t),fake=path.join(d,'site');fs.mkdirSync(fake);
  fs.writeFileSync(path.join(fake,'package.json'),'\n  <!doctype html><title>Liming</title> "name": "liming-gateway"');
  fs.writeFileSync(path.join(fake,'other.js'),'console.log(1)\n');
  for(const [name,marker] of [['package.json','"name": "liming-gateway"'],['other.js','createSupervisor'],['missing.js','x']]){
    const dest=path.join(d,'out-'+name),r=lib('fetch_file "$1" "$2" "$3"','file://'+path.join(fake,name),dest,marker);
    assert.notEqual(r.status,0,name);assert.ok(!fs.existsSync(dest),name);
    assert.deepEqual(fs.readdirSync(d).filter(f=>f.startsWith('out-')),[]);}
  const ok=lib('fetch_file "$1" "$2" "$3"','file://'+path.join(tablet,'liming-gateway/lib/gateway.js'),path.join(d,'g.js'),'createSupervisor');
  assert.equal(ok.status,0,ok.stderr);assert.equal(fs.readFileSync(path.join(d,'g.js'),'utf8'),fs.readFileSync(path.join(tablet,'liming-gateway/lib/gateway.js'),'utf8'));
});

test('安装包大小或哈希不对就不装，已有的 current 原样不动',t=>{
  const {d,env,lib,zip,z}=rig(t),gw=env.LIMING_GW_DIR;
  const bad=spawnSync('bash',['-c','source "$0"; install_gateway "$1"',setup,zip],{env:{...env,LIMING_SETUP_LIB:'1',LIMING_ZIP_SIZE:String(Number(z.size)-1)},encoding:'utf8'});
  assert.notEqual(bad.status,0);assert.ok(!fs.existsSync(path.join(gw,'current')));
  const badSha=spawnSync('bash',['-c','source "$0"; verify_zip "$1"',setup,zip],{env:{...env,LIMING_SETUP_LIB:'1',LIMING_ZIP_SHA256:'0'.repeat(64)},encoding:'utf8'});
  assert.notEqual(badSha.status,0);
  fs.mkdirSync(path.join(gw,'old'),{recursive:true});fs.symlinkSync('old',path.join(gw,'current'));
  const again=spawnSync('bash',['-c','source "$0"; install_gateway "$1"',setup,zip],{env:{...env,LIMING_SETUP_LIB:'1',LIMING_ZIP_SHA256:'f'.repeat(64)},encoding:'utf8'});
  assert.notEqual(again.status,0);assert.equal(fs.readlinkSync(path.join(gw,'current')),'old');
  assert.equal(lib('verify_zip "$1"',zip).status,0,'对的安装包能过');
});

test('整套装一遍：网关解好、插件挂上、li2 和 li 上建好 tablet 配置，key 不出现在输出里',t=>{
  const {d,env,run,read}=rig(t),gw=env.LIMING_GW_DIR,pl=env.LIMING_PLUGIN_DIR;
  const r=run();assert.equal(r.status,0,r.stdout+r.stderr);
  assert.ok(fs.existsSync(path.join(gw,'current/wb_proxy.py')));
  assert.equal(fs.readlinkSync(path.join(gw,'current')),'v2.0.8/wb-proxy');
  for(const f of ['bin/wb-tls-bridge-linux-arm64','start-wb-proxy.sh'])assert.ok(mode(path.join(gw,'current',f))&0o100,f+' 可执行');
  for(const sub of ['accounts','usage','logs'])assert.equal(mode(path.join(gw,sub)),0o700,sub);
  for(const f of ['package.json','cordis.patch.yml','lib/index.js','lib/gateway.js'])
    assert.equal(fs.readFileSync(path.join(pl,f),'utf8'),fs.readFileSync(path.join(tablet,'liming-gateway',f),'utf8'),f);
  assert.equal(read('dsh.log'),'plugin --profile web add '+pl+'\nplugin --profile web add '+env.LIMING_CLOUD_PLUGIN_DIR+'\n');
  for(const host of ['li2.example','li.example']){
    const h=path.join(d,'home-'+host);
    assert.equal(fs.readFileSync(path.join(h,'.local/bin/dsh-tablet'),'utf8'),fs.readFileSync(path.join(tablet,'dsh-tablet.sh'),'utf8'));
    assert.equal(mode(path.join(h,'.local/bin/dsh-tablet')),0o700);
    assert.equal(fs.readFileSync(path.join(h,'.dsh/profiles/web/cordis.patch.yml'),'utf8'),fs.readFileSync(path.join(tablet,'dsh-tablet-profile.yml'),'utf8'));
    assert.equal(fs.readFileSync(path.join(h,'.xin/harness.key'),'utf8'),'remote-secret-key\n');
    assert.ok(fs.statSync(path.join(d,'ws-'+host)).isDirectory());
    assert.ok(r.stdout.includes('启动命令 '+path.join(h,'.local/bin/dsh-tablet')+'，工作目录 '+path.join(d,'ws-'+host)),'打印 '+host+' 的启动命令（后面不加 web）');
  }
  const all=r.stdout+r.stderr;
  for(const secret of ['remote-secret-key','li2token','litoken',...Object.values(KEYS)])assert.ok(!all.includes(secret),'输出里不该有 '+secret);
  assert.ok(all.includes('http://127.0.0.1:8788/v1'));assert.ok(all.includes('Responses'));
});

test('远端 web 配置里已有别的补丁时先备份再换，内容不丢',t=>{
  const {d,run}=rig(t),prof=path.join(d,'home-li2.example/.dsh/profiles/web');
  fs.mkdirSync(prof,{recursive:true});fs.writeFileSync(path.join(prof,'cordis.patch.yml'),'# 站长自己的\n- id: something\n');
  const r=run();assert.equal(r.status,0,r.stdout+r.stderr);
  const baks=fs.readdirSync(prof).filter(f=>f.startsWith('cordis.patch.yml.bak'));
  assert.equal(baks.length,1);assert.equal(fs.readFileSync(path.join(prof,baks[0]),'utf8'),'# 站长自己的\n- id: something\n');
  assert.equal(fs.readFileSync(path.join(prof,'cordis.patch.yml'),'utf8'),fs.readFileSync(path.join(tablet,'dsh-tablet-profile.yml'),'utf8'));
  assert.equal(run().status,0);assert.equal(fs.readdirSync(prof).filter(f=>f.startsWith('cordis.patch.yml.bak')).length,1,'再跑一次不会多一份备份');
});

test('重复跑：不再下载安装包、不碰 accounts、不重复挂插件',t=>{
  const {env,run,read}=rig(t),gw=env.LIMING_GW_DIR;
  assert.equal(run().status,0);
  fs.writeFileSync(path.join(gw,'accounts/acct.json'),'{"keep":true}');
  const before=read('ssh.log').split('\n').filter(l=>/ cat /.test(l)).length;
  const r=run();assert.equal(r.status,0,r.stdout+r.stderr);
  assert.equal(read('ssh.log').split('\n').filter(l=>/ cat /.test(l)).length,before);
  assert.equal(fs.readFileSync(path.join(gw,'accounts/acct.json'),'utf8'),'{"keep":true}');
  assert.equal(read('dsh.log').split('\n').filter(Boolean).length,2,'网关插件和云端任务插件各挂一次');
});

test('li2 上没有安装包就从 li 取，li 的令牌后面接着用，不再问第三次',t=>{
  const {d,env,run,read}=rig(t,['ssh ibssh_li2token@li2.example','ssh ibssh_litoken@li.example',KEYS.li2read,KEYS.li2write,KEYS.liread,KEYS.liwrite]);fs.writeFileSync(path.join(d,'no-zip-li2.example'),'');
  const r=run();assert.equal(r.status,0,r.stdout+r.stderr);
  assert.ok(fs.existsSync(path.join(env.LIMING_GW_DIR,'current/wb_proxy.py')));
  const cats=read('ssh.log').split('\n').filter(l=>/ cat /.test(l)).map(l=>l.split(' ')[0]);
  assert.deepEqual(cats,['ibssh_li2token@li2.example','ibssh_litoken@li.example']);
  assert.equal(r.stderr.match(/SSH 令牌行/g)?.length,2,'令牌只问两次');
  assert.ok(fs.existsSync(path.join(d,'home-li.example/.local/bin/dsh-tablet')));
});

test('--dry-run 只列步骤，什么都不改、什么命令都不跑',t=>{
  const {d,env,run}=rig(t);const before=fs.readdirSync(d).sort();
  const r=run('--dry-run');assert.equal(r.status,0,r.stderr);
  assert.match(r.stdout,/网关/);assert.match(r.stdout,/插件/);
  assert.deepEqual(fs.readdirSync(d).sort(),before);
  assert.ok(!fs.existsSync(env.LIMING_GW_DIR));assert.ok(!fs.existsSync(env.LIMING_PLUGIN_DIR));
});

test('--skip-li 只问 li2 的令牌，不碰 li',t=>{
  const {d,run,read}=rig(t,['ssh ibssh_li2token@li2.example',KEYS.li2read,KEYS.li2write]);
  const r=run('--skip-li');assert.equal(r.status,0,r.stdout+r.stderr);
  assert.equal(r.stderr.match(/SSH 令牌行/g)?.length,1);
  assert.ok(!read('ssh.log').includes('li.example '));
  assert.ok(!fs.existsSync(path.join(d,'home-li.example/.local/bin/dsh-tablet')));
});

// ---- 平板调用云电脑（docs/superpowers/specs/2026-11-26-tablet-cloud-tasks-design.md §5.10、§5.11）----
const listFiles=dir=>fs.readdirSync(dir,{recursive:true,withFileTypes:true}).filter(e=>e.isFile()).map(e=>path.relative(dir,path.join(e.parentPath??e.path,e.name))).sort();

test('装机脚本里的两个插件文件清单和仓库里的一致（加了文件忘了改脚本会红）',t=>{
  const {lib}=rig(t);
  for(const [name,v] of [['liming-cloud','CLOUD_FILES'],['liming-lease','LEASE_FILES']]){
    const r=lib('printf "%s\\n" $'+v);assert.equal(r.status,0,r.stderr);
    assert.deepEqual(r.stdout.trim().split('\n').sort(),listFiles(path.join(tablet,name)),name);
  }
});

test('平板：装 liming-cloud 并挂进 web 配置；secrets.json 权限 600，记 SSH 目标和只读 key，绝不含写 key',t=>{
  const {d,env,run}=rig(t);
  const r=run();assert.equal(r.status,0,r.stdout+r.stderr);
  for(const f of listFiles(path.join(tablet,'liming-cloud')))
    assert.equal(fs.readFileSync(path.join(env.LIMING_CLOUD_PLUGIN_DIR,f),'utf8'),fs.readFileSync(path.join(tablet,'liming-cloud',f),'utf8'),f);
  const sec=path.join(env.LIMING_CLOUD_DIR,'secrets.json');
  assert.equal(mode(env.LIMING_CLOUD_DIR),0o700);assert.equal(mode(sec),0o600);
  const doc=JSON.parse(fs.readFileSync(sec,'utf8'));
  assert.equal(doc.schemaVersion,1);
  assert.deepEqual(doc.machines.li2,{sshTarget:'ibssh_li2token@li2.example',sshPort:22,readKey:KEYS.li2read});
  assert.deepEqual(doc.machines.li,{sshTarget:'ibssh_litoken@li.example',sshPort:22,readKey:KEYS.liread});
  const raw=fs.readFileSync(sec,'utf8');
  for(const w of [KEYS.li2write,KEYS.liwrite])assert.ok(!raw.includes(w),'写 key 不落平板');
  const all=fs.readdirSync(d,{recursive:true}).filter(f=>!String(f).startsWith('home-')&&String(f)!=='tty').map(f=>path.join(d,String(f))).filter(f=>fs.statSync(f).isFile());  // tty 是测试里模拟站长在终端里敲的字
  for(const f of all){const c=fs.readFileSync(f,'utf8');for(const w of [KEYS.li2write,KEYS.liwrite])assert.ok(!c.includes(w),`写 key 出现在平板的 ${f}`);}
});

test('li2、li：装 liming-lease 并第一次挂进 web 配置；lease.key（600）和 machine-name 写在那台上',t=>{
  const {d,run}=rig(t);
  const r=run();assert.equal(r.status,0,r.stdout+r.stderr);
  for(const [host,name,key] of [['li2.example','li2',KEYS.li2write],['li.example','li',KEYS.liwrite]]){
    const h=path.join(d,'home-'+host);
    for(const f of listFiles(path.join(tablet,'liming-lease')))
      assert.equal(fs.readFileSync(path.join(h,'.liming-lease',f),'utf8'),fs.readFileSync(path.join(tablet,'liming-lease',f),'utf8'),host+' '+f);
    assert.equal(mode(path.join(h,'.liming-cloud')),0o700);
    assert.equal(fs.readFileSync(path.join(h,'.liming-cloud/lease.key'),'utf8'),key+'\n');
    assert.equal(mode(path.join(h,'.liming-cloud/lease.key')),0o600);
    assert.equal(fs.readFileSync(path.join(h,'.liming-cloud/machine-name'),'utf8'),name+'\n');
    assert.equal(fs.readFileSync(path.join(h,'dsh.log'),'utf8'),'plugin --profile web add '+path.join(h,'.liming-lease')+'\n');
  }
});

test('重复跑：直接回车保留原来的只读 key 和写 key，插件不重复挂',t=>{
  const {d,env,run}=rig(t);
  assert.equal(run().status,0);
  fs.writeFileSync(path.join(d,'tty'),['ssh ibssh_li2token@li2.example','','','ssh ibssh_litoken@li.example','',''].join('\n')+'\n');
  const r=run();assert.equal(r.status,0,r.stdout+r.stderr);
  const doc=JSON.parse(fs.readFileSync(path.join(env.LIMING_CLOUD_DIR,'secrets.json'),'utf8'));
  assert.equal(doc.machines.li2.readKey,KEYS.li2read);assert.equal(doc.machines.li.readKey,KEYS.liread);
  const h=path.join(d,'home-li2.example');
  assert.equal(fs.readFileSync(path.join(h,'.liming-cloud/lease.key'),'utf8'),KEYS.li2write+'\n');
  assert.equal(fs.readFileSync(path.join(h,'dsh.log'),'utf8').split('\n').filter(Boolean).length,1);
});

test('只读 key 一开始就没给：secrets.json 里不写 readKey（插件按「状态未知」退回精简判断）；写 key 没给就不写 lease.key',t=>{
  const {d,env,run}=rig(t,['ssh ibssh_li2token@li2.example','','','ssh ibssh_litoken@li.example','','']);
  const r=run();assert.equal(r.status,0,r.stdout+r.stderr);
  const doc=JSON.parse(fs.readFileSync(path.join(env.LIMING_CLOUD_DIR,'secrets.json'),'utf8'));
  assert.deepEqual(doc.machines.li2,{sshTarget:'ibssh_li2token@li2.example',sshPort:22});
  assert.ok(!fs.existsSync(path.join(d,'home-li2.example/.liming-cloud/lease.key')));
  assert.equal(fs.readFileSync(path.join(d,'home-li2.example/.liming-cloud/machine-name'),'utf8'),'li2\n');
  assert.match(r.stdout,/没装写 key/);
});
