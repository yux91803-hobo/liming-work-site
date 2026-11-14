const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { sandboxAvailable } = require('./helpers/chromium-probe.cjs');

test('沙盒探针收掉仍写资料的子进程后才删目录；正常和超时都不留下浏览器', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-probe-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const hang of [false, true]) {
    const exe = path.join(dir, hang ? 'hang' : 'exit'), record = exe + '.json';
    fs.writeFileSync(exe, '#!' + process.execPath + '\n' + `
const fs=require('node:fs'),{spawn}=require('node:child_process');
const profile=process.argv.find(x=>x.startsWith('--user-data-dir=')).slice('--user-data-dir='.length);
fs.mkdirSync(profile+'/Default');
const writer=spawn(process.execPath,['-e', 'const fs=require("node:fs");setInterval(()=>fs.writeFileSync(process.argv[1]+"/Default/file","x"),5);',profile],{stdio:'ignore'});
fs.writeFileSync(${JSON.stringify(record)},JSON.stringify({pid:writer.pid,profile}));
${hang ? 'setInterval(()=>{},1000);' : 'console.log("<p>sandbox-ok</p>");writer.unref();'}
`, { mode: 0o755 });
    assert.equal(sandboxAvailable(exe, 1000), !hang);
    const info = JSON.parse(fs.readFileSync(record));
    assert.equal(fs.existsSync(info.profile), false);
    await new Promise(resolve => setTimeout(resolve, 50));
    let state = '';
    try { const stat=fs.readFileSync('/proc/'+info.pid+'/stat','utf8'); state=stat.slice(stat.lastIndexOf(')')+2).split(' ')[0]; } catch {}
    assert.ok(!state || state === 'Z', '探针的子进程已经不能继续写：' + state);
  }
});
