#!/usr/bin/env node
// 真实 Harness 契约验证运行器：在真实 dsh web（0.2.2-rc.3 与 0.2.2-rc.1）上逐项跑契约并输出汇总。
// 不进每次 PR 的默认 CI，详见同目录 README.md。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { startMockResponsesServer } from './mock-responses-server.mjs';
import { CONTRACT_CASES } from './cases.mjs';

function parseArgs(argv) {
  const opts = { target: 'both', only: null, fullRc1: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--target') opts.target = argv[++i];
    else if (a.startsWith('--target=')) opts.target = a.slice('--target='.length);
    else if (a === '--only') opts.only = new Set(argv[++i].split(',').map(s => s.trim()).filter(Boolean));
    else if (a.startsWith('--only=')) opts.only = new Set(a.slice('--only='.length).split(',').map(s => s.trim()).filter(Boolean));
    else if (a === '--full-rc1') opts.fullRc1 = true;
    else if (a === '-h' || a === '--help') {
      console.log('用法: node scripts/tablet-harness-contract/run.mjs [--target both|rc3|rc1] [--only E1,E7a,C2] [--full-rc1]');
      process.exit(0);
    } else {
      console.error(`不认识的参数: ${a}`);
      process.exit(2);
    }
  }
  if (!['both', 'rc3', 'rc1'].includes(opts.target)) {
    console.error(`--target 必须是 both、rc3 或 rc1，收到: ${opts.target}`);
    process.exit(2);
  }
  return opts;
}

function resolveBin(kind) {
  const cacheDir = process.env.CONTRACT_CACHE_DIR || path.join(os.homedir(), '.cache', 'liming-dsh-contract');
  const envKey = kind === 'rc3' ? 'DSH_RC3_BIN' : 'DSH_RC1_BIN';
  const bin = process.env[envKey] || path.join(cacheDir, kind, 'node_modules', '.bin', 'dsh');
  if (!fs.existsSync(bin)) {
    throw new Error(`找不到 ${kind} 的 dsh 二进制：${bin}（请先运行 bash scripts/tablet-harness-contract/install-harness.sh 或设置 ${envKey}）`);
  }
  const ver = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 10000 });
  if (ver.status !== 0) {
    throw new Error(`执行 ${bin} --version 失败：${ver.stderr || ver.stdout}`);
  }
  return { bin, version: ver.stdout.trim() };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const targetList = opts.target === 'both' ? ['rc3', 'rc1'] : [opts.target];
  const resolved = {};
  for (const t of targetList) resolved[t] = resolveBin(t);

  const mockServer = await startMockResponsesServer();
  const results = [];
  console.log(`Mock Responses 服务已启动：${mockServer.v1Url}`);
  for (const t of targetList) {
    console.log(`目标 ${t}：dsh ${resolved[t].version} (${resolved[t].bin})`);
  }
  console.log('');

  try {
    for (const target of targetList) {
      const { bin, version } = resolved[target];
      const cases = CONTRACT_CASES.filter(c => {
        if (opts.only && !opts.only.has(c.id)) return false;
        if (target === 'rc1' && opts.fullRc1) return true;
        return c.targets.includes(target);
      });
      console.log(`=== 运行目标 ${target} (dsh ${version})，共 ${cases.length} 项 ===`);
      for (const c of cases) {
        const t0 = performance.now();
        try {
          const detail = await c.run({ dshBin: bin, version, target, mockServer });
          const ms = Math.round(performance.now() - t0);
          results.push({ target, version, id: c.id, name: c.name, status: 'PASS', ms, detail });
          console.log(`[PASS] ${target}/${c.id} (${ms}ms) ${c.name}\n       ${detail}`);
        } catch (err) {
          const ms = Math.round(performance.now() - t0);
          const msg = err?.stack || String(err);
          results.push({ target, version, id: c.id, name: c.name, status: 'FAIL', ms, detail: msg });
          console.error(`[FAIL] ${target}/${c.id} (${ms}ms) ${c.name}\n       ${msg}`);
        }
      }
      console.log('');
    }
  } finally {
    await mockServer.close();
  }

  const passed = results.filter(r => r.status === 'PASS').length;
  const failed = results.filter(r => r.status === 'FAIL').length;
  console.log('=== 汇总 ===');
  for (const t of targetList) {
    const sub = results.filter(r => r.target === t);
    const p = sub.filter(r => r.status === 'PASS').length;
    const f = sub.filter(r => r.status === 'FAIL').length;
    console.log(`- ${t} (dsh ${resolved[t].version}): ${p}/${sub.length} PASS, ${f} FAIL`);
  }
  console.log(`总计：${passed}/${results.length} PASS，${failed} FAIL`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});
