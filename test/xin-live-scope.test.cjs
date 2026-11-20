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

test('拿不到文件列表或被截断时照跑', () => {
  assert.equal(needsXinLive([], false), true);
  assert.equal(needsXinLive(null, false), true);
  assert.equal(needsXinLive(['docs/a.md'], true), true);
  assert.equal(skippable(''), false);
});

function fake({ runs, cmp, fail }) {
  return {
    context: { repo: { owner: 'o', repo: 'r' }, sha: 'h'.repeat(40), runId: 9 },
    core: { warning() {} },
    github: { rest: {
      actions: { listWorkflowRuns: async () => { if (fail) throw Error('boom'); return { data: { workflow_runs: runs } }; } },
      repos: { compareCommits: async () => ({ data: cmp }) },
    } },
  };
}

test('以上一次成功发布为基准比较', async () => {
  const runs = [{ id: 9, head_sha: 'h'.repeat(40), conclusion: 'success' }, { id: 7, head_sha: 'b'.repeat(40), conclusion: 'success' }];
  assert.equal((await decide(fake({ runs, cmp: { status: 'ahead', files: [{ filename: 'site/tools/tianqi/sky.js' }] } }))).run, false);
  assert.equal((await decide(fake({ runs, cmp: { status: 'ahead', files: [{ filename: 'site/tools/tianqi/a.js', previous_filename: 'site/xin/a.js' }] } }))).run, true);
  assert.equal((await decide(fake({ runs, cmp: { status: 'diverged', files: [] } }))).run, true);
  assert.equal((await decide(fake({ runs: [], cmp: {} }))).run, true);
  assert.equal((await decide(fake({ fail: true }))).run, true);
});
