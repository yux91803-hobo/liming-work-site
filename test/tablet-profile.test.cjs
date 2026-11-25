// 平板（DSH Go）连 li、li2 时用的 tablet 配置和包装脚本（docs/superpowers/specs/2026-11-25-tablet-dshgo-design.md §4.4）
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const {pathToFileURL}=require('node:url');
const root=path.resolve(__dirname,'..');
const script=path.join(root,'scripts/tablet-profile.mjs');
const yml=path.join(root,'site/tablet/dsh-tablet-profile.yml');
const wrapper=path.join(root,'site/tablet/dsh-tablet.sh');
const gen=()=>import(pathToFileURL(script).href);
const tmp=t=>{const d=fs.mkdtempSync(path.join(os.tmpdir(),'tablet-profile-'));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));return d;};

test('生成的 tablet 配置和提交的文件一致：天启换了模型表却没重新生成时这里会红',async()=>{
  const {tabletProfileYaml}=await gen();
  assert.equal(fs.readFileSync(yml,'utf8'),tabletProfileYaml());
  assert.equal(spawnSync(process.execPath,[script,'--check'],{encoding:'utf8'}).status,0);
});

test('--check 发现文件过期就退出码 1，不改文件；不带 --check 时写出新文件',async t=>{
  const d=tmp(t),out=path.join(d,'p.yml');
  fs.writeFileSync(out,'# stale\n');
  const r=spawnSync(process.execPath,[script,'--check','--out',out],{encoding:'utf8'});
  assert.equal(r.status,1);assert.equal(fs.readFileSync(out,'utf8'),'# stale\n');
  assert.equal(spawnSync(process.execPath,[script,'--out',out],{encoding:'utf8'}).status,0);
  assert.equal(fs.readFileSync(out,'utf8'),fs.readFileSync(yml,'utf8'));
});

test('线路和模型取自天启的模型表：网关地址、key 走环境变量、三个模型都能看图、上下文 100 万',async()=>{
  const text=(await gen()).tabletProfileYaml();
  for(const want of ['- id: llm-pi-ai','      xin-gateway:','        apiKeyEnv: XIN_HARNESS_KEY','        api: openai-responses',
    '        baseURL: "http://127.0.0.1:8788/v1"','          - id: "deepseek-v4.1-flash"','          - id: "glm-5.4"','          - id: "kimi-k3.1-pro"',
    '              off: none','              max: max','- id: agent-default-model','    provider: xin-gateway','    model: "deepseek-v4.1-flash"','    reasoningEffort: high'])
    assert.ok(text.includes(want+'\n'),'缺少：'+want);
  assert.equal(text.match(/contextWindow: 1000000\n/g)?.length,3);
  assert.equal(text.match(/input: \["text","image"\]\n/g)?.length,3);
  assert.equal(text.match(/off: none\n/g)?.length,1,'只有 DeepSeek 能关掉思考');
});

test('不带人设、purge、REA：平板那边只要线路和默认模型',async()=>{
  const text=(await gen()).tabletProfileYaml();
  for(const no of ['personaPrefix','system-prompt','dsh-purge','mcp-rea','apiKey:'])assert.ok(!text.includes(no),'不该有：'+no);
});

function fakeHome(t,key){
  const home=tmp(t);fs.mkdirSync(path.join(home,'.local/bin'),{recursive:true});
  fs.writeFileSync(path.join(home,'.local/bin/dsh'),'#!/bin/sh\nprintf \'%s\\n\' "$@" > "$HOME/args.txt"\nprintf \'%s\' "$XIN_HARNESS_KEY" > "$HOME/key-seen.txt"\n',{mode:0o755});
  if(key!=null){fs.mkdirSync(path.join(home,'.xin'));fs.writeFileSync(path.join(home,'.xin/harness.key'),key,{mode:0o600});}
  return home;
}

test('包装脚本把 DSH Go 追加的参数原样传给 dsh，固定用内置的 web 配置（dsh web 就是 dsh --profile web）；key 只进环境变量、不出现在输出里',t=>{
  assert.equal(spawnSync('sh',['-n',wrapper]).status,0);
  const home=fakeHome(t,'test-key-123\n');
  const r=spawnSync('sh',[wrapper,'--host','127.0.0.1','--port','0','--no-open','--note','a b'],{env:{PATH:process.env.PATH,HOME:home},encoding:'utf8'});
  assert.equal(r.status,0,r.stderr);
  assert.deepEqual(fs.readFileSync(path.join(home,'args.txt'),'utf8').split('\n').slice(0,-1),
    ['--profile','web','--host','127.0.0.1','--port','0','--no-open','--note','a b']);
  assert.equal(fs.readFileSync(path.join(home,'key-seen.txt'),'utf8'),'test-key-123');
  assert.ok(!(r.stdout+r.stderr).includes('test-key-123'));
});

test('这台电脑没有网关 key 时退出码 78、说明缺哪个文件，不启动 dsh',t=>{
  const home=fakeHome(t,null);
  const r=spawnSync('sh',[wrapper,'web'],{env:{PATH:process.env.PATH,HOME:home},encoding:'utf8'});
  assert.equal(r.status,78);assert.match(r.stderr,/harness\.key/);
  assert.ok(!fs.existsSync(path.join(home,'args.txt')));
});
