import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';

function regular(root, relative) {
  let file=root;
  for (const part of relative.split('/')) {
    file=path.join(file,part);
    const st=fs.lstatSync(file);
    if (st.isSymbolicLink()) throw Error(`报告不接受 link：${relative}`);
  }
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try {
    if (!fs.fstatSync(fd).isFile()) throw Error(`报告必须是普通文件：${relative}`);
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}

export function snapshotReport({root,temporary,run,attempt,nonce=randomUUID()}) {
  if (!/^\d{1,25}$/.test(run??'') || !/^\d{1,10}$/.test(attempt??'') || !/^[a-zA-Z0-9-]{1,64}$/.test(nonce)) throw Error('报告运行编号不合法');
  root=path.resolve(root);temporary=path.resolve(temporary);
  const inside=path.relative(root,temporary);
  if (!inside || (!inside.startsWith(`..${path.sep}`)&&inside!=='..'&&!path.isAbsolute(inside))) throw Error('报告快照必须放在 checkout 外');
  const files=[];
  const collect=(dir,match)=>{
    const full=path.join(root,dir);
    let st;try { st=fs.lstatSync(full); } catch(e) { if(e.code==='ENOENT')return;throw e; }
    if (st.isSymbolicLink()||!st.isDirectory()) throw Error(`报告目录必须是普通目录：${dir}`);
    for (const name of fs.readdirSync(full).sort()) if(match(name))files.push(`${dir}/${name}`);
  };
  collect('test-results/e2e',name=>name.endsWith('.log'));
  collect('screens',name=>name==='stm32-drag-failure.png');
  try { fs.lstatSync(path.join(root,'preview.log'));files.push('preview.log'); } catch(e) { if(e.code!=='ENOENT')throw e; }
  files.sort();
  fs.mkdirSync(temporary,{recursive:true});
  const snapshot=fs.mkdtempSync(path.join(temporary,'e2e-report-'));
  fs.chmodSync(snapshot,0o700);
  try {
    const hash=createHash('sha256');
    for (const file of files) {
      const bytes=regular(root,file),target=path.join(snapshot,file);
      fs.mkdirSync(path.dirname(target),{recursive:true,mode:0o700});
      fs.writeFileSync(target,bytes,{flag:'wx',mode:0o600});
      hash.update(JSON.stringify([file,bytes.length])+'\n');hash.update(bytes);
    }
    const digest=hash.digest('hex');
    return {name:`e2e-report-${run}-${attempt}-${digest}-${nonce}`,path:snapshot,digest,files};
  } catch(e) { fs.rmSync(snapshot,{recursive:true,force:true});throw e; }
}

if (process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  const report=snapshotReport({root:process.cwd(),temporary:process.env.RUNNER_TEMP||os.tmpdir(),run:process.env.GITHUB_RUN_ID,attempt:process.env.GITHUB_RUN_ATTEMPT});
  if (!process.env.GITHUB_OUTPUT) throw Error('缺少 GITHUB_OUTPUT');
  fs.appendFileSync(process.env.GITHUB_OUTPUT,`name=${report.name}\npath=${report.path}\n`);
  console.log(`浏览器报告快照：${report.files.length} 个文件，SHA-256 ${report.digest}`);
}
