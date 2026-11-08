// The desktop activity terminal (「小芯在干什么」): readable event lines and the terminal window.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { BASE, readText, hasCmd, mk, alive } from './vm-base.mjs';

/* ---------- 小芯的屏幕 ----------
   它平时在后台跑命令，桌面上看不到。所以每一轮的事件同时写成好读的几行（screen.log，带颜色）：你说了什么、它说了什么、
   执行的命令和结果（太长只留前面）、做完没有；op screen 在桌面（Xvnc 的 DISPLAY）上开一个终端 tail 这个文件。
   网站「小芯的屏幕」嵌的就是这个桌面（InstaBox 的桌面链接），能看也能接管。 */
export const SCREEN_LOG = () => path.join(BASE, 'screen.log'), SCREEN_PID = () => path.join(BASE, 'screen.pid');
export const SCREEN_MAX = 2 * 1024 * 1024, SCREEN_KEEP = 256 * 1024;
export const AN = { r: '\x1b[0m', b: '\x1b[1m', dim: '\x1b[2m', clay: '\x1b[38;5;173m', cyan: '\x1b[36m', green: '\x1b[32m', red: '\x1b[31m', gray: '\x1b[90m', yellow: '\x1b[33m' };
// Codex 报的命令是 /bin/bash -lc '…'：只留里面那句
export function bareCmd(d) {
  const m = /^\/(?:usr\/)?bin\/(?:ba)?sh -lc (['"])([\s\S]*)\1$/.exec(String(d || '').trim());
  if (!m) return String(d || '');
  return m[1] === "'" ? m[2].replace(/'\\''/g, "'") : m[2].replace(/\\(["\\$`])/g, '$1');
}
export function cutLines(s, n) {
  const a = String(s || '').replace(/\s+$/, '').split('\n');
  return a.length > n ? a.slice(0, n).concat(['…（还有 ' + (a.length - n) + ' 行）']) : a;
}
export function screenLine(ev, now = Date.now()) {
  switch (ev.t) {
    case 'user': return '\n' + AN.b + AN.clay + '── 你（' + new Date(now + 8 * 3600e3).toISOString().slice(11, 16) + '）：' + AN.r + String(ev.text || '').replace(/\s+/g, ' ').slice(0, 300) + '\n';
    case 'text': return AN.cyan + '小芯：' + AN.r + cutLines(ev.text, 40).join('\n      ') + '\n';
    case 'tool': return AN.b + AN.yellow + '$ ' + AN.r + AN.b + bareCmd(ev.detail || ev.name || '') + AN.r + '\n';
    case 'tool_end': return (ev.out ? AN.gray + cutLines(ev.out, 30).map(l => '  ' + l).join('\n') + AN.r + '\n' : '') + (ev.ok ? AN.green + '  ✓' : AN.red + '  ✗ 没成功') + AN.r + '\n';
    case 'err': return AN.red + '出错：' + String(ev.text || '') + AN.r + '\n';
    case 'mem': return AN.dim + '（记住了：' + ev.text + '）' + AN.r + '\n';
    case 'done': return AN.dim + '── ' + (ev.stopped ? '已停止' : ev.ok ? '做完了' : '没做成') + (ev.ms ? ' · ' + Math.round(ev.ms / 1000) + ' 秒' : '') + AN.r + '\n';
    default: return '';
  }
}
export let screenTag = '';
export function screenLog(ev) {
  const line = screenLine(ev);
  if (!line) return;
  try {
    const f = SCREEN_LOG();
    // 太长了只留最后一段（从一行的开头开始）；tail -F 会接着读
    try {
      if (fs.statSync(f).size > SCREEN_MAX) {
        const buf = fs.readFileSync(f), tail = buf.subarray(buf.length - SCREEN_KEEP), nl = tail.indexOf(10);
        fs.writeFileSync(f, tail.subarray(nl + 1));
      }
    } catch { /* 还没有这个文件 */ }
    fs.appendFileSync(f, screenTag ? line.replace(/^(\n?)/, '$1' + AN.dim + screenTag + AN.r) : line);
  } catch { /* 写不了就算了，不影响聊天 */ }
}
export function screenDisplay() {
  if (process.env.XIN_DISPLAY) return process.env.XIN_DISPLAY;
  try {
    const xs = fs.readdirSync('/tmp/.X11-unix').filter(n => /^X\d+$/.test(n)).map(n => +n.slice(1)).sort((a, b) => a - b);
    if (xs.length) return ':' + xs[xs.length - 1];
  } catch { /* 桌面没开 */ }
  return ':1';
}
export function openScreen() {
  mk(BASE);
  if (!fs.existsSync(SCREEN_LOG())) fs.writeFileSync(SCREEN_LOG(), AN.clay + '小芯的屏幕：这里实时显示我在电脑上干什么（执行的命令和结果）。' + AN.r + '\n');
  const pid = Number(readText(SCREEN_PID()).trim()) || 0;
  if (pid && alive(pid) && /xfce4-terminal|tail/.test(readText('/proc/' + pid + '/cmdline'))) return { ok: true, already: true };
  if (!hasCmd('xfce4-terminal')) return { error: 'no_terminal', msg: '电脑里没有 xfce4-terminal，开不了终端（桌面还是能看）' };
  const display = screenDisplay();
  const env = Object.assign({}, process.env, { DISPLAY: display, DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS || 'unix:path=/run/user/' + process.getuid() + '/bus' });
  // 最大化、字大一点：手机、平板上看缩小了的桌面也认得出字
  const c = spawn('xfce4-terminal', ['--disable-server', '--title', '小芯在干什么', '--maximize', '--hide-menubar', '--hide-toolbar', '--font=Monospace 14', '-x', 'tail', '-n', '400', '-F', SCREEN_LOG()],
    { detached: true, stdio: 'ignore', env, cwd: os.homedir() });
  c.on('error', () => { /* 起不来就算了 */ });
  c.unref();
  fs.writeFileSync(SCREEN_PID(), String(c.pid));
  return { ok: true, opened: true, display };
}

export function setScreenTag(tag) { screenTag = tag; }
