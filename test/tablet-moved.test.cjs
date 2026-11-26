// 平板装机文件 2026-11-26 搬到 yux91803-hobo/tablet-setup 仓库，由 Cloudflare Pages 发布到 https://tablet.liming-work.com/ 。
// 网站上只留旧地址的提示脚本：网站会把首页当成缺的文件返回 200，要是什么都不留，旧命令 curl … | bash 会把网页当命令跑。
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const dir=path.join(__dirname,'../site/tablet');
const BASH=spawnSync('sh',['-c','command -v bash'],{encoding:'utf8'}).stdout.trim(); // 下面 PATH 指向空目录，bash 本身要用绝对路径找

test('网站上只剩旧地址的提示脚本：只告诉新命令、退出码 1，什么命令都不跑',()=>{
  assert.deepEqual(fs.readdirSync(dir),['setup.sh'],'平板的其他文件都在 tablet-setup 仓库');
  // 照旧命令的样子把脚本从标准输入喂给 bash；PATH 指向不存在的目录，脚本要是调用任何外部命令就会报「找不到命令」
  const r=spawnSync(BASH,['-s','--','--dry-run'],{input:fs.readFileSync(path.join(dir,'setup.sh')),encoding:'utf8',env:{PATH:'/nonexistent'}});
  assert.equal(r.status,1);
  assert.equal(r.stdout,'');
  assert.ok(r.stderr.includes('curl -fsSL https://tablet.liming-work.com/setup.sh | bash'),r.stderr);
  assert.doesNotMatch(r.stderr,/not found|找不到|No such file/);
});
