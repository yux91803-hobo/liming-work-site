// Shared controller foundation: paths, the single state journal, small file helpers and process identity.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { StateJournal } from './vm-state.mjs';
import { Ownership } from './vm-kernel-owner.mjs';
import { requestStateSync } from './vm-kernel-client.mjs';
import { callContext } from './vm-kernel-context.mjs';
import { assertAttempt } from './vm-run-attempt.mjs';

export const BASE = process.env.XIN_HOME || path.join(os.homedir(), '.xin');
export const journal = new StateJournal(BASE);
// 先关可写连接，再释放独占锁。
export const ownership = journal.owner = new Ownership(BASE,{beforeRelease:()=>journal.closeWriter()});
journal.bridge = (kind,args) => requestStateSync(BASE,{kind,...args,run:callContext().run,attempt:callContext().attempt});
journal.checkWriter = (transaction=false) => {
  const context=callContext();
  if(!context.run)return;
  if(!okId(context.run,'r'))assertAttempt(null,{...context,attempt:context.attempt||'invalid'});
  const name='runs/'+context.run+'.json',file=path.join(BASE,name),db=transaction?journal.db:journal.connection||journal.reader;
  const stored=db?.prepare('SELECT body FROM documents WHERE name=?').get(name);
  let meta=readJ(file);
  if(stored)try{meta=JSON.parse(stored.body);}catch{throw Object.assign(new Error('执行状态损坏，报告未应用'),{code:'invalid_run_state'});}
  assertAttempt(meta,context);
};
export const WORK = process.env.XIN_WORK || '/data/workspace';
// 天启（docs/superpowers/specs/2026-11-18-tianqi-li2-design.md §4.2）：第二台电脑 li2 上的控制器。Worker 发给 li2 的 exec 都带
// XIN_ROLE=tianqi，外壳 ensure 时存进 kernel.env.json，再传给状态进程和每一轮的进程。只用 Harness，小芯的功能都不开
export const TIANQI = process.env.XIN_ROLE === 'tianqi';
// Harness（DeepSeek Harness，命令 dsh）在这台电脑上的位置：命令（测试用 XIN_DSH 指到假的）、网关给本机客户端的 key（只有自己能读）
export const HARNESS_KEY = () => path.join(BASE, 'harness.key');
export function dshCmd() {
  if (process.env.XIN_DSH) return process.env.XIN_DSH;
  const p = path.join(os.homedir(), '.local', 'bin', 'dsh');
  return fs.existsSync(p) ? p : 'dsh';
}
export function harnessInstalled() { const c = dshCmd(); return c !== 'dsh' ? fs.existsSync(c) : hasCmd('dsh'); }
// 天启准备好没有：Harness 装了、网关给本机的 key 放好了
export function tianqiReady() { return harnessInstalled() && !!readText(HARNESS_KEY()).trim(); }
// 天启发消息之前查：只用 Harness（a 是 send 的参数，s 是要接着聊的对话），没准备好就说网关还没配好，不起一轮注定失败的
export function tianqiRefuse(a, s) {
  if (!TIANQI) return null;
  if ((a.agent && a.agent !== 'harness') || (s && s.agent !== 'harness')) return { error: 'tianqi_only', msg: '天启只用 Harness' };
  return tianqiReady() ? null : { error: 'not_ready', msg: '天启的网关还没配好' };
}
export const TEMPLATE = () => path.join(WORK, 'stm32-template');   // STM32 空工程（scripts/vm/setup-stm32.sh 装的）

export function today() { const d = new Date(Date.now() + 8 * 3600e3); return d.toISOString().slice(0, 10); }   // 北京时间的日期
export function bjNow() { return new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' '); }
// 北京时间的星期几：控制器算好写进当前时间，不让模型自己推（参考 Muse 的系统提示：星期几先用 date 算，不凭感觉）
export function bjWeek(at = Date.now()) { return '星期' + '日一二三四五六'[new Date(at + 8 * 3600e3).getUTCDay()]; }
export function readText(f) { try { return journal.staged(f) ?? fs.readFileSync(f, 'utf8'); } catch { return ''; } }

export function hasCmd(c) { return spawnSync('sh', ['-lc', 'command -v ' + c], { encoding: 'utf8' }).status === 0; }

/* ---------- 小工具 ---------- */
export function mk(d) { fs.mkdirSync(d, { recursive: true }); }
export function rid(p) { return p + Date.now().toString(36) + crypto.randomBytes(3).toString('hex'); }
export function okId(s, p) { return typeof s === 'string' && new RegExp('^' + p + '[0-9a-z]{6,24}$').test(s); }
export function readJ(f, d) { try { return JSON.parse(journal.staged(f) ?? fs.readFileSync(f, 'utf8')); } catch { return d; } }
export function writeJ(f, o) {
  if(path.resolve(f).startsWith(path.resolve(BASE)+path.sep))return journal.write(f,JSON.stringify(o));
  const t = f + '.' + process.pid + '.tmp'; fs.writeFileSync(t, JSON.stringify(o)); fs.renameSync(t, f);
}
export function cut(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) + '\n…（省略 ' + (s.length - n) + ' 字）' : s; }
export function processIdentity(pid) {
  try {
    const stat = fs.readFileSync('/proc/' + Number(pid) + '/stat', 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return { start: fields[19], state: fields[0], group:Number(fields[2]),session:Number(fields[3]),boot: readText('/proc/sys/kernel/random/boot_id').trim() };
  } catch { return null; }
}
export function alive(pid, expected) {
  if (!pid) return false;
  const current = processIdentity(pid);
  if (current && (current.state === 'Z' || current.state === 'X')) return false;
  if (expected && current && (expected.start !== current.start || expected.boot !== current.boot)) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
export function processGroupMembers(pid,expected){
  if(!expected?.start||expected.boot!==readText('/proc/sys/kernel/random/boot_id').trim())return [];
  const leader=processIdentity(pid);if(leader&&(leader.start!==expected.start||leader.boot!==expected.boot))return [];
  const group=expected.group||pid,session=expected.session||pid;
  if(group!==pid)return leader&&alive(pid,expected)?[{pid,identity:leader}]:[];
  const members=[];
  for(const name of fs.readdirSync('/proc').filter(n=>/^\d+$/.test(n))){const id=Number(name),identity=processIdentity(id);if(identity&&!['Z','X'].includes(identity.state)&&identity.session===session&&BigInt(identity.start)>=BigInt(expected.start))members.push({pid:id,identity});}
  return members;
}
export const SIGNAL_PROCESSES=String.raw`import os,sys,json,signal
q=json.loads(sys.argv[1]);boot=open('/proc/sys/kernel/random/boot_id').read().strip();opened=[];denied=[]
for item in q['members']:
 fd=None
 try:
  pid=int(item['pid']);expected=item['identity'];fd=os.pidfd_open(pid,0)
  stat=open('/proc/'+str(pid)+'/stat').read();parts=stat[stat.rfind(')')+2:].split()
  if boot!=expected['boot'] or parts[19]!=expected['start']:os.close(fd);continue
  opened.append((fd,item));fd=None
 except PermissionError:
  denied.append(item)
  if fd is not None:os.close(fd)
 except (OSError,ValueError):
  if fd is not None:os.close(fd)
for fd,item in opened:
 try:signal.pidfd_send_signal(fd,signal.SIGKILL if q['signal']=='SIGKILL' else signal.SIGTERM)
 except PermissionError:denied.append(item)
 except ProcessLookupError:pass
 finally:os.close(fd)
print(json.dumps({'denied':denied}))`;
export function signalProcessGroup(pid,expected,signal='SIGTERM'){
  const members=processGroupMembers(pid,expected);if(!members.length)return;
  const input=JSON.stringify({members,signal});
  const r=spawnSync('python3',['-c',SIGNAL_PROCESSES,input],{encoding:'utf8',timeout:5000});
  let denied;try{denied=JSON.parse(r.stdout).denied;}catch{return;}
  if(denied?.length)spawnSync('/usr/bin/sudo',['-n','/usr/bin/python3','-c',SIGNAL_PROCESSES,JSON.stringify({members:denied,signal})],{env:{PATH:'/usr/bin:/bin'},encoding:'utf8',timeout:5000});
}

export const UPLOADS = () => path.join(WORK, 'uploads');

export function readTail(f, n) {
  let fd = null;
  try {
    fd = fs.openSync(f, 'r');
    const size = fs.fstatSync(fd).size, len = Math.min(n, size), b = Buffer.alloc(len);
    return b.toString('utf8', 0, fs.readSync(fd, b, 0, len, size - len));
  } catch { return ''; } finally { if (fd !== null) fs.closeSync(fd); }
}

export const TASK_SANDBOX = () => process.env.XIN_TASK_SANDBOX !== '0';
