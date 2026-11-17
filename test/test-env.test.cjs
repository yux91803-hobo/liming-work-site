// 整套测试默认碰不到执行机器上的 systemd。
// GitHub 托管机器有用户总线（/run/user/<uid>/bus，linger=yes），不隔开的话：每个测试的模型运行都进真的 xin-run-*.scope，
// 清理定时器装进机器的真实用户目录，清理器拿某个测试的目录去对别的测试的 scope，找不到记录就当「对话删了」停掉。
// 照 git 的 t/test-lib.sh：整套测试默认 GIT_TEST_MAINT_SCHEDULER="none:exit 1"（不让测试碰真的定时任务、永久改动用户的系统），
// 要测调度的测试自己另设——这里 xin-kernel、xin-reaper 本来就自己设 XIN_SYSTEMD_BUS。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const root = path.join(__dirname, '..');

// 另起一个进程问生产代码：这台机器有 systemd-run 时，一轮会不会放进 systemd scope
function scopeFor(env) {
  const reaper = pathToFileURL(path.join(root, 'site/xin/vm-reaper.mjs')).href;
  const code = `import(${JSON.stringify(reaper)}).then(m => process.stdout.write(JSON.stringify(m.scoped('true', [], { unit: 'xin-run-t1-a1', which: () => true }).scope)))`;
  const r = spawnSync(process.execPath, ['-e', code], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('测试环境：机器上有用户总线，测试里的运行也不进 systemd', async () => {
  const { hermeticTestEnv } = await import(pathToFileURL(path.join(root, 'scripts/test-env.mjs')).href);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xin-test-env-')), bus = path.join(dir, 'bus');
  fs.writeFileSync(bus, '');
  try {
    const host = { PATH: process.env.PATH, XIN_SYSTEMD_BUS: bus };
    assert.equal(scopeFor(host), 'xin-run-t1-a1.scope', '不隔开时真的会进 scope');
    for (const outer of [{ PATH: process.env.PATH }, host]) {
      const env = hermeticTestEnv(outer);
      assert.equal(fs.existsSync(env.XIN_SYSTEMD_BUS), false);
      assert.match(env.XIN_SYSTEMD_BUS, /\/bus$/, '和真的总线一样以 /bus 结尾，按形状判断的测试替身照常');
      assert.equal(scopeFor(env), null);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('测试环境：npm run check 用它起测试（常驻状态进程那一遍已经并进 check）', () => {
  for (const f of ['scripts/check.mjs']) {
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    assert.match(src, /import \{ hermeticTestEnv \} from '\.\/test-env\.mjs';/, f);
    assert.match(src, /spawnSync\(process\.execPath, ?\['--test',[^\n]*\n?[^\n]*env: ?hermeticTestEnv\(/, f);
  }
});
