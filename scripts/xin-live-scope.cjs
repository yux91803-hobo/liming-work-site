'use strict';
/* 正式站发布要不要跑小芯真模型联调（scripts/test-xin-live.py）。站长 2026-11-21：只改天启界面时不要被小芯联调卡住。
   做法参考 nrwl/nx-set-shas：拿「上一次成功发布到正式站」的提交当基准，比较基准到这次提交改了哪些文件；
   参考 dorny/paths-filter：按路径判断。只有下面这些路径全都不碰小芯和服务端时才跳过，其它一律照跑（宁可多跑）。
   找不到基准、文件太多（GitHub 比较接口最多列 300 个）或读接口出错，都照跑。 */
const SKIP_PREFIXES = ['site/tools/tianqi/', 'docs/', 'test/e2e/'];
const TIANQI_VISION_FILES = new Set(['site/xin/vm-persona.mjs', 'site/xin/vm-models.mjs', 'scripts/test-xin-live.py']);

function skippable(file) {
  const f = String(file || '');
  if (!f || f.includes('..')) return false;
  if (SKIP_PREFIXES.some(p => f.startsWith(p))) return true;
  return /^[^/]+\.md$/.test(f);   // 仓库根目录的说明文件（README、CLAUDE.md 等），不进 Worker
}

// files：基准到这次提交改过的文件（含改名前的旧路径）；truncated：比较结果被截断
function needsXinLive(files, truncated) {
  if (truncated || !Array.isArray(files) || files.length === 0) return true;
  return !files.every(skippable);
}

/* 在 actions/github-script 里调用。只在 Harness 模型配置或联调变化时另外唤醒 li2。 */
async function decide({ github, context, core }) {
  const { owner, repo } = context.repo, head = context.sha;
  try {
    const { data } = await github.rest.actions.listWorkflowRuns({ owner, repo, workflow_id: 'deploy.yml', branch: 'main', event: 'push', status: 'success', per_page: 20 });
    const last = data.workflow_runs.find(r => r.conclusion === 'success' && r.head_sha !== head && r.id !== context.runId);
    if (!last) return { run: true, tianqiVision: true, reason: '找不到上一次成功发布到正式站的运行' };
    const { data: cmp } = await github.rest.repos.compareCommits({ owner, repo, base: last.head_sha, head, per_page: 300 });
    if (cmp.status !== 'ahead') return { run: true, tianqiVision: true, reason: `基准 ${last.head_sha.slice(0, 7)} 不在这次提交之前（${cmp.status}）` };
    const list = cmp.files || [], files = list.flatMap(f => [f.filename, f.previous_filename].filter(Boolean));
    const run = needsXinLive(files, list.length >= 300);
    const tianqiVision = !files.length || list.length >= 300 || files.some(f => TIANQI_VISION_FILES.has(f));
    const outside = files.filter(f => !skippable(f));
    return { run, tianqiVision, reason: run ? `基准 ${last.head_sha.slice(0, 7)} 之后改到了：${outside.slice(0, 10).join('、') || '（文件太多或为空）'}` : `基准 ${last.head_sha.slice(0, 7)}（运行 ${last.id}）之后只改了天启界面、文档或浏览器测试，共 ${files.length} 个文件` };
  } catch (e) {
    core.warning('判断小芯联调范围失败，照跑：' + e.message);
    return { run: true, tianqiVision: true, reason: '读 GitHub 接口失败' };
  }
}

module.exports = { SKIP_PREFIXES, skippable, needsXinLive, decide };
