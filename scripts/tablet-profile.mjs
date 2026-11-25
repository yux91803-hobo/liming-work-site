// 生成平板（DSH Go）连 li、li2 时用的 tablet 配置补丁：线路和模型表取自天启（HARNESS_ROUTE、HARNESS_MODELS），
// 形状照 site/xin/vm-persona.mjs 的 writeHarnessPatch，只留线路和默认模型（不要人设、purge、REA）。
// 用法：node scripts/tablet-profile.mjs [--check] [--out 文件]，默认写 site/tablet/dsh-tablet-profile.yml。
// 设计：docs/superpowers/specs/2026-11-25-tablet-dshgo-design.md §4.4
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HARNESS_MODELS, HARNESS_ROUTE } from '../site/xin/vm-models.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PROFILE_FILE = path.join(root, 'site/tablet/dsh-tablet-profile.yml');

export function tabletProfileYaml() {
  const R = HARNESS_ROUTE, q = JSON.stringify; // JSON 字符串就是合法的 YAML 双引号字符串
  return [
    '# 平板（DSH Go）连 li、li2 时用的 tablet 配置：网关线路和默认模型。',
    '# 由 scripts/tablet-profile.mjs 从天启的模型表生成，别手改；装机脚本把它放到 ~/.dsh/profiles/tablet/cordis.patch.yml。',
    '- id: llm-pi-ai', '  config:', '    providers:', '      ' + R.provider + ':',
    '        displayName: ' + q(R.name), '        apiKeyEnv: XIN_HARNESS_KEY', '        api: ' + R.api, '        baseURL: ' + q(R.baseURL),
    '        models:',
    ...HARNESS_MODELS.flatMap(m => [
      '          - id: ' + q(m.id), '            name: ' + q(m.name), '            contextWindow: ' + m.win,
      '            input: ' + q(m.image ? ['text', 'image'] : ['text']), '            reasoningEfforts:',
      ...m.efforts.map(x => '              ' + x + ': ' + (x === 'off' ? 'none' : x))]),
    '- id: agent-default-model', '  config:', '    provider: ' + R.provider, '    model: ' + q(R.model), '    reasoningEffort: ' + R.def,
    ''].join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), at = args.indexOf('--out');
  const out = at >= 0 ? path.resolve(args[at + 1]) : PROFILE_FILE, want = tabletProfileYaml();
  let have = null;
  try { have = fs.readFileSync(out, 'utf8'); } catch {}
  if (!args.includes('--check')) fs.writeFileSync(out, want);
  else if (have !== want) {
    console.error(path.relative(process.cwd(), out) + ' 过期了：运行 node scripts/tablet-profile.mjs 重新生成');
    process.exit(1);
  }
}
