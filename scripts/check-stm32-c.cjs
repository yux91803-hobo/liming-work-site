#!/usr/bin/env node
/* 把「代码推导」里 10 个外设的 .h / .c / main.c 导出来，用 clang 按 Cortex-M3 编译一遍。
   需要标准库的芯片头文件（stm32f10x.h、system_stm32f10x.h、core_cm3.h、core_cmFunc.h、core_cmInstr.h），
   放在一个目录里，用环境变量指过去：
     STM32F10X_INC=/path/to/inc npm run check:c
   没设这个变量就跳过（头文件是 ST / ARM 的，不放进仓库）。
   检查两件事：每个 .c 编译没有错误和警告；每一章连同它依赖的 led.c / delay.c / usart.c，
   除了 C 库（memcpy、printf）和 system_stm32f10x.c 里的 SystemCoreClock，没有找不到的函数。 */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');

const inc = process.env.STM32F10X_INC;
if (!inc) { console.log('跳过：没有设置 STM32F10X_INC（标准库芯片头文件所在的目录）'); process.exit(0); }
if (!fs.existsSync(path.join(inc, 'stm32f10x.h'))) { console.error('找不到 ' + path.join(inc, 'stm32f10x.h')); process.exit(1); }
const which = (n) => { try { return execFileSync('sh', ['-c', 'command -v ' + n]).toString().trim(); } catch (e) { return ''; } };
const clang = which('clang'), nm = which('llvm-nm');
if (!clang || !nm) { console.error('需要 clang 和 llvm-nm'); process.exit(1); }

const root = path.join(__dirname, '../site/tools/stm32');
const sb = { window: {} }; sb.window.window = sb.window; vm.createContext(sb);
['codederive.js', 'codederive-more.js'].forEach((f) => vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), sb, { filename: f }));
const CD = sb.window.STM32_CODEDERIVE.CD;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stm32c-'));
const stub = path.join(tmp, 'stub'); fs.mkdirSync(stub);
fs.writeFileSync(path.join(stub, 'stdio.h'), '#pragma once\ntypedef struct __FILE FILE;\nint printf(const char *, ...);\nint fputc(int, FILE *);\n');
fs.writeFileSync(path.join(stub, 'string.h'), '#pragma once\ntypedef unsigned int size_t;\nvoid *memcpy(void *, const void *, size_t);\nvoid *memset(void *, int, size_t);\nsize_t strlen(const char *);\n');
const indent = (c) => (/^\s*/.exec(c) || [''])[0];
for (const [id, cd] of Object.entries(CD)) {
  fs.mkdirSync(path.join(tmp, id));
  for (const f of cd.files) {
    const out = [];
    f.lines.forEach((l) => { if (l[1]) out.push(indent(l[0]) + '// ' + l[1]); out.push(l[0]); });
    fs.writeFileSync(path.join(tmp, id, f.name), out.join('\n') + '\n');
  }
}
const flags = ['--target=thumbv7m-none-eabi', '-mcpu=cortex-m3', '-ffreestanding', '-std=c99', '-O1', '-DSTM32F10X_HD',
  '-Wall', '-Wextra', '-Wno-unused-parameter', '-Werror', '-I' + stub, '-I' + inc];
const SHARED = ['gpio/led.c', 'sys/delay.c', 'usart/usart.c'];
const LIBC = new Set(['memcpy', 'memset', 'strlen', 'printf', 'SystemCoreClock']);
let bad = 0, files = 0;
for (const id of Object.keys(CD)) {
  const own = fs.readdirSync(path.join(tmp, id)).filter((n) => n.endsWith('.c')).map((n) => id + '/' + n);
  const srcs = own.concat(SHARED.filter((s) => !s.startsWith(id + '/')));
  const objs = [];
  for (const s of srcs) {
    const o = path.join(tmp, s.replace('/', '_') + '.o');
    try {
      execFileSync(clang, flags.concat(['-I' + path.join(tmp, id), '-I' + path.join(tmp, 'gpio'), '-I' + path.join(tmp, 'sys'), '-I' + path.join(tmp, 'usart'), '-c', path.join(tmp, s), '-o', o]), { stdio: 'pipe' });
    } catch (e) { bad++; console.error('✗ ' + s + '\n' + e.stderr.toString()); continue; }
    if (own.includes(s)) files++;
    objs.push(o);
  }
  const sym = (args) => new Set(execFileSync(nm, args.concat(objs)).toString().split('\n').map((l) => l.trim().split(/\s+/).pop()).filter(Boolean));
  const def = sym(['--defined-only']), miss = [...sym(['-u'])].filter((x) => !def.has(x) && !LIBC.has(x));
  if (miss.length) { bad++; console.error('✗ ' + id + '：找不到 ' + miss.join(', ')); }
}
fs.rmSync(tmp, { recursive: true, force: true });
if (bad) { console.error(bad + ' 处问题'); process.exit(1); }
console.log('✓ ' + files + ' 个 .c 文件按 stm32f10x.h 编译通过，' + Object.keys(CD).length + ' 章都能链接上');
