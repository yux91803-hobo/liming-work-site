// Same controller assertions, a real state owner. Storage/algorithm and legacy-lock tests stay in check.
import { spawnSync } from 'node:child_process';
const suites='antigravity batch1 browser-login forget front-agy handoff main runtime steer system-task task-scope wait-ttl watch web'.split(' ');
const r=spawnSync(process.execPath,['--test',...suites.map(n=>'test/xin-'+n+'.test.cjs')],{
  env:{...process.env,XIN_TEST_STATE_MODE:'kernel'},stdio:'inherit'
});
process.exit(r.status??1);
