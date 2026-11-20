// 天启的终端里站长自己输命令（天启 v4 第 3 个 PR，docs/superpowers/plans/2026-11-20-tianqi-terminal-workspace-plan.md）：
// 在对话的工作区里跑，最多 60 秒、输出最多 64 KB。外壳转一个操作最多等 40 秒，所以命令放后台跑：
// term_run 马上回编号，term_poll 按字节位置取输出。只给天启（li2）；/api/tq 本身只给登录了的站长。
// 站长自己输的命令不受对话权限（只读等）限制：权限管的是天启，和 Claude Code 的 ! 命令一样直接跑。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { BASE, TIANQI, mk, rid, readText } from './vm-base.mjs';
import { workPath, workError } from './vm-persona.mjs';

export const TERM_OUT_MAX = 65536;
const TERM_DIR = () => path.join(BASE, 'term'), TERM_ID = /^t[0-9a-z]{6,24}$/, KEEP_MS = 86400000;
export function termLimitMs() { const n = Number(process.env.XIN_TERM_LIMIT_MS); return Number.isFinite(n) && n > 0 && n < 60000 ? n : 60000; }
// timeout 管时限（超时退出码 124，-k 5：不理 TERM 的再过 5 秒 KILL，退出码 137）；head 截到 64 KB 以后接着吞掉，命令不会因为管道断了被杀；
// 退出码最后写，先写临时文件再改名：看到退出码时输出一定写完了
const WRAP = 'timeout -k 5 "$4" bash -lc "$1" 2>&1 | { head -c ' + TERM_OUT_MAX + '; cat >/dev/null; } > "$2"\n' +
  'echo "${PIPESTATUS[0]}" > "$3.tmp" && mv "$3.tmp" "$3"';
const no = (error, msg) => ({ error, msg });
const ONLY = no('tianqi_only', '只有天启能在终端里跑命令');
// 一天前的命令记录删掉
function sweep(dir) {
  const old = Date.now() - KEEP_MS;
  for (const f of fs.readdirSync(dir)) { try { if (fs.statSync(path.join(dir, f)).mtimeMs < old) fs.unlinkSync(path.join(dir, f)); } catch { /* 已经删了 */ } }
}
// 还没跑完时，末尾半个多字节字符留到下次再给
function wholeChars(buf) {
  let i = buf.length - 1, k = 0;
  while (i >= 0 && k < 3 && (buf[i] & 0xc0) === 0x80) { i--; k++; }
  if (i < 0) return buf.length;
  const need = buf[i] >= 0xf0 ? 4 : buf[i] >= 0xe0 ? 3 : buf[i] >= 0xc0 ? 2 : 1;
  return buf.length - i >= need ? buf.length : i;
}
export const termOps = {
  term_run(a) {
    if (!TIANQI) return ONLY;
    const bad = workError(a.work); if (bad) return bad;
    const cmd = a.cmd;
    if (typeof cmd !== 'string' || !cmd.trim() || cmd.length > 4000 || cmd.includes('\0')) return no('bad_cmd', '命令不能为空，最多 4000 个字');
    const cwd = workPath(a.work), dir = TERM_DIR(), id = rid('t');
    mk(cwd); mk(dir); sweep(dir);
    fs.writeFileSync(path.join(dir, id + '.json'), JSON.stringify({ cmd, work: a.work || '', at: Date.now() }));
    const child = spawn('bash', ['-c', WRAP, 'term', cmd, path.join(dir, id + '.out'), path.join(dir, id + '.code'), String(termLimitMs() / 1000)],
      { cwd, detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
    return { id };
  },
  term_poll(a) {
    if (!TIANQI) return ONLY;
    const id = String(a.id || ''), base = path.join(TERM_DIR(), id);
    if (!TERM_ID.test(id) || !readText(base + '.json')) return no('bad_id', '没有这条命令');
    const at = JSON.parse(readText(base + '.json')).at, codeText = readText(base + '.code').trim();   // 先看退出码：有了就说明输出写完了
    let buf = Buffer.alloc(0);
    try { buf = fs.readFileSync(base + '.out'); } catch { /* 还没开始输出 */ }
    const off = Math.min(Math.max(0, a.off | 0), buf.length), part = buf.subarray(off), take = codeText ? part.length : wholeChars(part);
    const code = codeText ? Number(codeText) : null, done = !!codeText && off + take >= buf.length;
    let ms = Date.now() - at;
    if (codeText) { try { ms = fs.statSync(base + '.code').mtimeMs - at; } catch { /* 刚好被清掉 */ } }
    return { out: part.subarray(0, take).toString('utf8'), off: off + take, done, code, timedOut: code === 124 || code === 137, truncated: buf.length >= TERM_OUT_MAX, ms: Math.round(ms) };
  }
};
