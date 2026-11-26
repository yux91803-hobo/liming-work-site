const test = require('node:test');
const assert = require('node:assert');
const { skippable, needsXinLive, decide } = require('../scripts/xin-live-scope.cjs');

test('只改天启界面、文档、浏览器测试时跳过小芯联调', () => {
  assert.equal(needsXinLive(['site/tools/tianqi/sky.js', 'site/tools/tianqi/workbench.css', 'docs/CHANGES.md', 'test/e2e/xin_tianqi_e2e.py', 'README.md']), false);
});

test('碰到小芯、服务端、配置或流程就照跑', () => {
  for (const f of ['site/xin/chat.js', 'src/xin.js', 'wrangler.jsonc', '.github/workflows/deploy.yml', 'scripts/test-xin-live.py', 'site/index.html', 'site/tools.js', 'test/xin-live-policy.test.cjs', 'site/tools/tianqi-other/x.js', 'docs/../src/x.js', 'site/README.md'])
    assert.equal(needsXinLive(['site/tools/tianqi/sky.js', f]), true, f);
});

test('只改平板文件（站点 tablet 目录、平板脚本和单测）时也跳过小芯联调', () => {
  assert.equal(needsXinLive(['site/tablet/setup.sh', 'site/tablet/liming-gateway/lib/gateway.js', 'site/tablet/dsh-tablet-profile.yml',
    'scripts/tablet-profile.mjs', 'test/tablet-gateway.test.cjs', 'docs/tablet.md', 'README.md']), false);
});

test('平板只认这几个前缀：名字挨着的文件和小芯模型表照跑', () => {
  for (const f of ['site/tablets/x.js', 'site/tablet.js', 'scripts/tablet.mjs', 'scripts/xin-tablet-profile.mjs', 'test/tablet.test.cjs',
    'site/tablet/../xin/vm-agent.mjs', 'site/xin/vm-models.mjs'])
    assert.equal(needsXinLive(['site/tablet/setup.sh', f]), true, f);
});

test('拿不到文件列表或被截断时照跑', () => {
  assert.equal(needsXinLive([], false), true);
  assert.equal(needsXinLive(null, false), true);
  assert.equal(needsXinLive(['docs/a.md'], true), true);
  assert.equal(skippable(''), false);
});

// 假 GitHub 接口。真实的运行记录都带 event（push、workflow_dispatch 等），这里没写的按合并触发的 push 算。
// cmp 可以是按基准提交返回比较结果的函数；jobs 是手动运行的作业和步骤（按运行编号）。
function fake({ runs, cmp, fail, jobs = {} }) {
  return {
    context: { repo: { owner: 'o', repo: 'r' }, sha: 'h'.repeat(40), runId: 9 },
    core: { warning() {} },
    github: { rest: {
      actions: {
        listWorkflowRuns: async ({ event }) => { if (fail) throw Error('boom'); return { data: { workflow_runs: runs.map(r => ({ event: 'push', ...r })).filter(r => !event || r.event === event) } }; },
        listJobsForWorkflowRun: async ({ run_id }) => ({ data: { jobs: jobs[run_id] || [] } }),
      },
      repos: { compareCommits: async ({ base }) => ({ data: typeof cmp === 'function' ? cmp(base) : cmp }) },
    } },
  };
}

test('以上一次成功发布为基准比较', async () => {
  const runs = [{ id: 9, head_sha: 'h'.repeat(40), conclusion: 'success' }, { id: 7, head_sha: 'b'.repeat(40), conclusion: 'success' }];
  const ui = await decide(fake({ runs, cmp: { status: 'ahead', files: [{ filename: 'site/tools/tianqi/sky.js' }] } }));
  assert.equal(ui.run, false);
  assert.equal(ui.tianqiVision, false);
  assert.equal((await decide(fake({ runs, cmp: { status: 'ahead', files: [{ filename: 'site/tools/tianqi/a.js', previous_filename: 'site/xin/a.js' }] } }))).run, true);
  assert.equal((await decide(fake({ runs, cmp: { status: 'diverged', files: [] } }))).run, true);
  assert.equal((await decide(fake({ runs: [], cmp: {} }))).run, true);
  assert.equal((await decide(fake({ fail: true }))).run, true);
});

test('上一次成功发布之后只改了平板文件就跳过，也不测天启读图', async () => {
  const runs = [{ id: 7, head_sha: 'b'.repeat(40), conclusion: 'success' }];
  const r = await decide(fake({ runs, cmp: { status: 'ahead', files: [{ filename: 'site/tablet/setup.sh' }, { filename: 'test/tablet-setup.test.cjs' }] } }));
  assert.equal(r.run, false);
  assert.equal(r.tianqiVision, false);
});

test('模型目录或 Harness 配置变化时验证 li2 读图，普通内核改动只测小芯', async () => {
  const runs = [{ id: 7, head_sha: 'b'.repeat(40), conclusion: 'success' }];
  const scope = filename => decide(fake({ runs, cmp: { status: 'ahead', files: [{ filename }] } }));
  for (const file of ['site/xin/vm-persona.mjs', 'site/xin/vm-models.mjs', 'scripts/test-xin-live.py']) {
    const r = await scope(file);
    assert.equal(r.run, true);
    assert.equal(r.tianqiVision, true);
  }
  const r = await scope('site/xin/vm-state.mjs');
  assert.equal(r.run, true);
  assert.equal(r.tianqiVision, false);
  assert.equal((await decide(fake({ fail: true }))).tianqiVision, true);
});

// 站长 2026-11-26：平板文件要独立发布。#516、#519 是在 Actions 页手动发布到正式站的，也要算「上一次成功发布」，
// 不然基准一直停在更早的合并发布，之后只改平板仍会跑小芯联调。
const xinSince = base => ({ status: 'ahead', files: base === 'c'.repeat(40) ? [{ filename: 'site/tablet/liming-cloud/lib/index.js' }]
  : [{ filename: 'site/tablet/liming-cloud/lib/index.js' }, { filename: 'site/xin/chat.js' }] });
const deployedJob = conclusion => [{ name: 'deploy', steps: [{ name: '部署', conclusion }, { name: '判断这次要不要跑小芯联调', conclusion }] }];

test('手动发布到正式站并通过检查的运行也算基准', async () => {
  const runs = [{ id: 20, head_sha: 'c'.repeat(40), conclusion: 'success', event: 'workflow_dispatch' }, { id: 7, head_sha: 'b'.repeat(40), conclusion: 'success' }];
  const r = await decide(fake({ runs, cmp: xinSince, jobs: { 20: deployedJob('success') } }));
  assert.equal(r.run, false, r.reason);
  assert.match(r.reason, /基准 ccccccc/);
});

test('手动只 dry-run 或只发测试站的运行不算基准，往前找真发布的', async () => {
  const runs = [{ id: 21, head_sha: 'c'.repeat(40), conclusion: 'success', event: 'workflow_dispatch' }, { id: 7, head_sha: 'b'.repeat(40), conclusion: 'success' }];
  const r = await decide(fake({ runs, cmp: xinSince, jobs: { 21: deployedJob('skipped') } }));
  assert.equal(r.run, true);
  assert.match(r.reason, /基准 bbbbbbb/);
  const other = await decide(fake({ runs: [{ id: 22, head_sha: 'c'.repeat(40), conclusion: 'success', event: 'schedule' }, runs[1]], cmp: xinSince, jobs: { 22: deployedJob('success') } }));
  assert.match(other.reason, /基准 bbbbbbb/, '只认合并和手动发布');
});

test('认手动发布靠的那一步还在部署流程里', () => {
  const { PRODUCTION_MARK_STEP } = require('../scripts/xin-live-scope.cjs');
  const yml = require('node:fs').readFileSync(require('node:path').join(__dirname, '../.github/workflows/deploy.yml'), 'utf8');
  assert.equal(typeof PRODUCTION_MARK_STEP, 'string');
  assert.equal(yml.split(`- name: ${PRODUCTION_MARK_STEP}\n`).length - 1, 1, '部署流程里改了这一步的名字，要同步改 scripts/xin-live-scope.cjs');
  assert.match(yml, new RegExp(`- name: ${PRODUCTION_MARK_STEP}\\n\\s+id: xin_scope\\n\\s+if: steps\\.smoke\\.outcome == 'success' && env\\.TARGET == 'production'`), '这一步只在真发布到正式站、冒烟通过后才跑');
});
