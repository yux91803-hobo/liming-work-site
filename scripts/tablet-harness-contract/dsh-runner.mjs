// 真实 dsh web 生命周期管理：隔离临时目录、写入模拟模型补丁、挂载探针插件、优雅停止与强杀重启。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DshClient } from './dsh-client.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PROBE_PLUGIN_DIR = path.join(HERE, 'probe-plugin');

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function waitFor(fn, { timeoutMs = 15000, intervalMs = 50, label = 'condition' } = {}) {
  const deadline = performance.now() + timeoutMs;
  let lastErr = null;
  while (performance.now() < deadline) {
    try {
      const val = await fn();
      if (val) return val;
    } catch (err) {
      lastErr = err;
    }
    await sleep(intervalMs);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}${lastErr ? `: ${lastErr.message}` : ''}`);
}

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function findProcessesInDir(targetDir, marker = null) {
  const realTarget = fs.realpathSync(targetDir);
  const found = [];
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (pid === process.pid) continue;
    try {
      const cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
      if (cwd === realTarget || cwd.startsWith(realTarget + path.sep)) {
        const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim();
        if (marker && !cmdline.includes(marker)) continue;
        found.push({ pid, cwd, cmdline });
      }
    } catch {
      // 权限不足或进程已退出
    }
  }
  return found;
}

export async function killProcessesInDir(targetDir) {
  const first = findProcessesInDir(targetDir);
  for (const p of first) {
    try { process.kill(p.pid, 'SIGTERM'); } catch {}
  }
  if (first.length > 0) {
    await sleep(250);
    for (const p of findProcessesInDir(targetDir)) {
      try { process.kill(p.pid, 'SIGKILL'); } catch {}
    }
  }
  return first;
}

function buildMockPatchYaml(mockV1Url) {
  return [
    '# 由 scripts/tablet-harness-contract 自动生成的测试补丁',
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    '      contract-mock:',
    '        displayName: "Contract Mock"',
    '        apiKeyEnv: CONTRACT_MOCK_KEY',
    '        api: openai-responses',
    `        baseURL: ${JSON.stringify(mockV1Url)}`,
    '        models:',
    '          - id: "contract-model"',
    '            name: "Contract Model"',
    '            contextWindow: 1000000',
    '            input: ["text"]',
    '- id: agent-default-model',
    '  config:',
    '    provider: contract-mock',
    '    model: "contract-model"',
    '',
  ].join('\n');
}

export class DshHarnessRunner {
  constructor({ dshBin, mockV1Url, withProbe = false, label = 'dsh', extraEnv = {} }) {
    this.dshBin = dshBin;
    this.mockV1Url = mockV1Url;
    this.withProbe = withProbe;
    this.label = label;
    this.extraEnv = extraEnv;
    this.root = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-contract-${label}-`));
    this.home = path.join(this.root, 'home');
    this.dshHome = path.join(this.home, '.dsh');
    this.probeDir = path.join(this.root, 'probe');
    this.workspace = path.join(this.root, 'workspace');
    fs.mkdirSync(this.home, { recursive: true });
    fs.mkdirSync(path.join(this.dshHome, 'profiles', 'web'), { recursive: true });
    fs.mkdirSync(this.probeDir, { recursive: true });
    fs.mkdirSync(this.workspace, { recursive: true });
    this.child = null;
    this.client = null;
    this.logs = '';
    this.probePort = null;
    this.initialized = false;
  }

  env() {
    const cacheDir = process.env.CONTRACT_CACHE_DIR || path.join(os.homedir(), '.cache', 'liming-dsh-contract');
    const pnpmBin = path.join(cacheDir, 'pnpm', 'node_modules', '.bin');
    const pathVal = fs.existsSync(pnpmBin) ? `${pnpmBin}${path.delimiter}${process.env.PATH || ''}` : process.env.PATH;
    return {
      ...process.env,
      PATH: pathVal,
      HOME: this.home,
      DSH_HOME: this.dshHome,
      CONTRACT_MOCK_KEY: 'contract-mock-key',
      CONTRACT_PROBE_DIR: this.probeDir,
      NO_COLOR: '1',
      HTTP_PROXY: '',
      HTTPS_PROXY: '',
      http_proxy: '',
      https_proxy: '',
      ALL_PROXY: '',
      all_proxy: '',
      ...this.extraEnv,
    };
  }

  prepareProfile() {
    if (this.initialized) return;
    const patchPath = path.join(this.dshHome, 'profiles', 'web', 'cordis.patch.yml');
    if (this.withProbe) {
      const addRes = spawnSync(this.dshBin, ['plugin', '--profile', 'web', 'add', PROBE_PLUGIN_DIR], {
        env: this.env(),
        encoding: 'utf8',
        timeout: 60000,
      });
      if (addRes.status !== 0) {
        throw new Error(`dsh plugin add failed (exit ${addRes.status}):\n${addRes.stdout}\n${addRes.stderr}`);
      }
    }
    // dsh plugin add 会把探针插件的 dsh.bundle.patch 写入包依赖，并在 cordis.patch.yml 里留空数组 []；
    // 直接覆盖写用户层补丁即可。
    fs.writeFileSync(patchPath, buildMockPatchYaml(this.mockV1Url));
    this.initialized = true;
  }

  async start({ timeoutMs = 60000 } = {}) {
    this.prepareProfile();
    const controlFile = path.join(this.probeDir, 'control.json');
    try { fs.rmSync(controlFile, { force: true }); } catch {}
    this.logs = '';
    this.probePort = null;

    const child = spawn(this.dshBin, ['--profile', 'web', '--host', '127.0.0.1', '--port', '0', '--no-open'], {
      cwd: this.workspace,
      env: this.env(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    let exited = null;
    child.on('exit', (code, signal) => {
      exited = { code, signal };
    });

    const onChunk = (buf) => { this.logs += buf.toString('utf8'); };
    child.stdout.on('data', onChunk);
    child.stderr.on('data', onChunk);

    let launchMatch;
    try {
      const res = await waitFor(() => {
        const m = this.logs.match(/https?:\/\/127\.0\.0\.1:(\d+)\/\?token=([^\s]+)/);
        if (m) return { ok: true, match: m };
        if (exited) return { ok: false, exited };
        return null;
      }, { timeoutMs, intervalMs: 50, label: `${this.label} dsh web launch URL` });
      if (!res.ok) {
        throw new Error(`dsh web exited prematurely (code=${res.exited.code}, sig=${res.exited.signal}):\n${this.logs.slice(-2000)}`);
      }
      launchMatch = res.match;
    } catch (err) {
      throw new Error(`${err.message}\n--- dsh web logs ---\n${this.logs.slice(-2000)}`);
    }

    const baseUrl = `http://127.0.0.1:${launchMatch[1]}`;
    const token = launchMatch[2];
    this.client = await DshClient.login(baseUrl, token);

    if (this.withProbe) {
      const ctrl = await waitFor(() => {
        if (!fs.existsSync(controlFile)) return null;
        const parsed = JSON.parse(fs.readFileSync(controlFile, 'utf8'));
        return parsed.pid === child.pid && parsed.port ? parsed : null;
      }, { timeoutMs: 15000, intervalMs: 50, label: `${this.label} probe control.json` });
      this.probePort = ctrl.port;
    }

    return this.client;
  }

  async stopGraceful(timeoutMs = 15000) {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      this.child = null;
      return;
    }
    const done = new Promise(resolve => child.once('exit', () => resolve()));
    child.kill('SIGTERM');
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
    }, timeoutMs);
    await done;
    clearTimeout(timer);
    this.child = null;
  }

  async killHard(timeoutMs = 10000) {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      this.child = null;
      return;
    }
    const done = new Promise(resolve => child.once('exit', () => resolve()));
    child.kill('SIGKILL');
    await Promise.race([
      done,
      sleep(timeoutMs).then(() => { throw new Error('SIGKILL did not terminate dsh web in time'); }),
    ]);
    this.child = null;
  }

  async restart(opts) {
    await this.stopGraceful();
    return this.start(opts);
  }

  async probePost(route, body) {
    if (!this.probePort) throw new Error('probe control server is not running');
    const res = await fetch(`http://127.0.0.1:${this.probePort}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`probe POST ${route} HTTP ${res.status}: ${text}`);
    return JSON.parse(text);
  }

  async probeLedger() {
    if (this.probePort) {
      const res = await fetch(`http://127.0.0.1:${this.probePort}/ledger`);
      if (res.ok) return res.json();
    }
    const f = path.join(this.probeDir, 'ledger.json');
    if (!fs.existsSync(f)) return { tasks: {} };
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  }

  readProbeEvents() {
    const f = path.join(this.probeDir, 'events.jsonl');
    if (!fs.existsSync(f)) return [];
    return fs.readFileSync(f, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line));
  }

  async cleanup() {
    try { await this.killHard(); } catch {}
    try { await killProcessesInDir(this.root); } catch {}
    try { fs.rmSync(this.root, { recursive: true, force: true }); } catch {}
  }
}
