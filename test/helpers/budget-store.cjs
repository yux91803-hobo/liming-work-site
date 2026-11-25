const fs = require('node:fs'), path = require('node:path');

exports.budgetStore = file => ({
  read() {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') throw e; return {}; }
  },
  write(value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
  }
});
