// The state process selects the transaction scope for the CLI's internal operation.
const { spawnSync } = require('node:child_process');

function lockedSpawn(agent, op, args, opts) {
  return spawnSync(process.execPath, [agent, 'locked', op], { ...opts, input: JSON.stringify(args || {}) });
}

module.exports = { lockedSpawn };
