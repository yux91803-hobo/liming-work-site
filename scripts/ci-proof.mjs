// Reuse successful PR tests only for the exact same Git tree. Never infer success from a branch name.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const kinds = ['check','e2e'];
const tree = () => execFileSync('git',['rev-parse','HEAD^{tree}'],{encoding:'utf8'}).trim();
function cleanCheckout() {
  execFileSync('git',['diff','--quiet','HEAD'],{stdio:'ignore'});
  const extra=execFileSync('git',['ls-files','--others','--exclude-standard','-z'],{encoding:'utf8'}).split('\0').filter(p=>p&&!p.startsWith('.ci-proof/'));
  if(extra.length)throw Error('工作区包含未纳入代码树的文件，不能复用验证');
}
export function verifyProofs(proofs, expected) {
  if (!/^[a-f0-9]{40}$/.test(expected.tree) || !/^[a-f0-9]{40}$/.test(expected.head) || !/^\d+$/.test(expected.run)) throw Error('缺少可信的 PR 验证来源');
  for (const kind of kinds) {
    const proof=proofs[kind];
    if (proof?.version!==1 || proof.kind!==kind || proof.tree!==expected.tree || proof.head!==expected.head || proof.run!==expected.run)
      throw Error(kind+' 验证证据与本次代码不一致，停止部署');
  }
}
function main() {
  const [mode,kind]=process.argv.slice(2), dir='.ci-proof';
  if (mode==='write') {
    if (!kinds.includes(kind) || process.env.GITHUB_EVENT_NAME!=='pull_request') throw Error('只能记录已通过的 PR 测试');
    cleanCheckout();
    const event=JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH,'utf8'));
    const proof={version:1,kind,tree:tree(),head:event.pull_request.head.sha,run:process.env.GITHUB_RUN_ID};
    fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,kind+'.json'),JSON.stringify(proof));
  } else if (mode==='verify') {
    cleanCheckout();
    const proofs=Object.fromEntries(kinds.map(k=>[k,JSON.parse(fs.readFileSync(path.join(dir,k+'.json'),'utf8'))]));
    verifyProofs(proofs,{tree:tree(),head:process.env.CI_CHECKED_HEAD,run:process.env.CI_CHECKED_RUN});
    console.log('PR 单元与浏览器测试已通过，代码目录树完全一致，复用验证结果。');
  } else throw Error('用法：ci-proof.mjs write check|e2e / verify');
}
if (process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) main();
