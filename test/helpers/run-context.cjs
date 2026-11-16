// A fixture impersonating an executor captures its identity once, before waiting.
// Refreshing a late report from current metadata would hide attempt-fencing regressions.
const fs = require('node:fs'), path = require('node:path');
exports.captureRunContext = (home, run) => {
  const meta = JSON.parse(fs.readFileSync(path.join(home, 'runs', run + '.json'), 'utf8'));
  return { XIN_RUN: run, XIN_ATTEMPT: meta.attempt || '' };
};
