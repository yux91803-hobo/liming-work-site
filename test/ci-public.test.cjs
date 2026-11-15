// 仓库要公开（站长 2026-11-15）：公开后任何人都能开 PR、看 Actions 的全部日志。
// GitHub 文档 docs.github.com/en/actions/reference/security/secure-use：自托管执行机「几乎永远不该用于公开仓库」；
// docs.github.com/en/repositories/…/setting-repository-visibility：改成公开后「Actions 历史和日志任何人都能看」。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { spawnSync } = require('node:child_process');

const WORKFLOWS = path.resolve(__dirname, '../.github/workflows');
const read = name => fs.readFileSync(path.join(WORKFLOWS, name), 'utf8');
// 和 test/ci-proof.test.cjs 一样：取出 github-script 的脚本正文，用假的 github / core 真跑一遍
function scriptOf(yaml) {
  const body = yaml.match(/\n          script: \|\n((?: {12}[^\n]*\n|\n)+)/)?.[1];
  assert.ok(body, '有 github-script 脚本');
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  return new AsyncFunction('github', 'context', 'core', body.split('\n').map(l => l.slice(12)).join('\n'));
}

test('所有作业都在 GitHub 自带的执行机上跑，不再用自托管执行机（公开后别人的 PR 会在上面跑代码）', () => {
  const files = fs.readdirSync(WORKFLOWS).filter(f => /\.ya?ml$/.test(f));
  assert.ok(files.length > 0);
  for (const f of files) {
    const runsOn = [...read(f).matchAll(/^\s+runs-on:\s*(.+)$/gm)].map(m => m[1].trim());
    assert.ok(runsOn.length > 0, f + ' 里有作业');
    for (const r of runsOn) assert.equal(r, 'ubuntu-latest', f + '：' + r);
  }
});

test('部署列表进日志前隐去邮箱（wrangler 的部署列表会打出账号邮箱）；别的内容原样留着', () => {
  const sample = [
    '== liming-worldmap 最近的部署 ==',
    'Created:     2026-11-15T00:10:38.233Z',
    'Author:      someone.name+ci@qq.com',
    'Source:      Unknown (deployment)',
    'Message:     上线验证失败，回滚到发布前版本',
    'Version(s):  (100%) 905d3ba6-8302-48c2-8254-caf0408b5cf6',
    '                 Created:  2026-11-14T19:45:51.088Z',
    'Author:      Other.Person@Example.co.uk 和 third@mail.example.com',
  ].join('\n') + '\n';
  const r = spawnSync(process.execPath, [path.resolve(__dirname, '../scripts/ci-redact.mjs')], { input: sample, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /@/, r.stdout);
  assert.equal(r.stdout.split('\n').length, sample.split('\n').length, '行数不变');
  for (const keep of ['905d3ba6-8302-48c2-8254-caf0408b5cf6', '上线验证失败，回滚到发布前版本', 'Created:     2026-11-15T00:10:38.233Z', 'Source:      Unknown (deployment)'])
    assert.ok(r.stdout.includes(keep), keep);
  assert.match(r.stdout, /^Author: +\S/m, '作者那一行还在，只是邮箱换成了占位');
  // 工作流里打部署列表的地方都经过它
  const yaml = read('deploy.yml');
  const lists = yaml.split('\n').filter(l => /deployments list/.test(l));
  assert.ok(lists.length > 0);
  for (const l of lists) assert.match(l, /deployments list[^|]*\|\s*node scripts\/ci-redact\.mjs/, l.trim());
});

test('清理旧日志只能手动运行：只删 before 以前、已经结束的运行的日志（运行记录留着），跳过这次运行；日志早没了的不算错，别的错误让这次运行失败', async () => {
  const yaml = read('clean-logs.yml');
  assert.match(yaml, /^on:\n {2}workflow_dispatch:/m, '只能在 Actions 页手动运行');
  assert.doesNotMatch(yaml, /^ {2}(push|pull_request|pull_request_target|schedule|workflow_run):/m);
  assert.match(yaml, /^permissions:\n {2}actions: write\n(?! {2}\S)/m, '只要删日志这一项写权限');
  const execute = scriptOf(yaml);
  const runs = [
    { id: 1, status: 'completed', created_at: '2026-11-10T00:00:00Z' },     // 删
    { id: 2, status: 'completed', created_at: '2026-11-14T00:00:00Z' },     // 日志早过期了（404）：不算错
    { id: 3, status: 'in_progress', created_at: '2026-11-14T00:00:00Z' },   // 还在跑：不动
    { id: 4, status: 'completed', created_at: '2026-11-16T00:00:00Z' },     // 在 before 之后：不动
    { id: 5, status: 'completed', created_at: '2026-11-12T00:00:00Z' },     // 删
    { id: 99, status: 'completed', created_at: '2026-11-11T00:00:00Z' },    // 这次运行自己：不动
  ];
  async function run(before, fail = {}) {
    const deleted = [], failed = [], notes = [];
    const rest = { actions: {
      listWorkflowRunsForRepo: () => {},
      deleteWorkflowRunLogs: async ({ owner, repo, run_id }) => {
        assert.deepEqual([owner, repo], ['owner', 'site']);
        if (fail[run_id]) { const e = Error('boom'); e.status = fail[run_id]; throw e; }
        deleted.push(run_id);
      },
      deleteWorkflowRun: () => assert.fail('只删日志，不删运行记录'),
    } };
    const github = { rest, paginate: async (fn, args) => (assert.equal(fn, rest.actions.listWorkflowRunsForRepo), assert.deepEqual(args, { owner: 'owner', repo: 'site', per_page: 100 }), runs) };
    const core = { info: m => notes.push(m), warning: m => notes.push(m), setFailed: m => failed.push(m) };
    await execute(github, { repo: { owner: 'owner', repo: 'site' }, runId: 99, payload: { inputs: { before } } }, core);
    return { deleted, failed, notes };
  }
  const pause = process.env.CLEAN_PAUSE_MS;
  process.env.CLEAN_PAUSE_MS = '0';   // 正式运行时删一个歇 0.8 秒（GitHub 对接连的删改有次数限制）；测试里不歇
  try {
    const ok = await run('2026-11-15T00:00:00Z', { 2: 404 });
    assert.deepEqual(ok.deleted, [1, 5]);
    assert.deepEqual(ok.failed, []);
    assert.ok(ok.notes.some(n => /删了 2 个/.test(n)), ok.notes.join('\n'));
    const bad = await run('2026-11-15T00:00:00Z', { 1: 403, 2: 404 });
    assert.deepEqual(bad.deleted, [5], '一个出错不挡后面的');
    assert.equal(bad.failed.length, 1, '别的错误让这次运行失败');
    await assert.rejects(run('昨天'), /before/);
    await assert.rejects(run(''), /before/);
  } finally { if (pause === undefined) delete process.env.CLEAN_PAUSE_MS; else process.env.CLEAN_PAUSE_MS = pause; }
});
