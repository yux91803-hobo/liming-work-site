// Queue directories belong to one immutable execution attempt, not a reusable task workspace.
import fs from 'node:fs';
import path from 'node:path';

export const BRIDGE_DEFAULT = false;
export const bridgeEnabled = (env = process.env) => env.XIN_TASK_BRIDGE === '1' || env.XIN_TASK_BRIDGE !== '0' && BRIDGE_DEFAULT;
const badScope = () => Object.assign(new Error('后台任务桥的执行身份或目录无效'), { code: 'bad_bridge_scope' });

export function scopedBridgeWorkspace(workspace, scope = {}) {
  if (scope?.bridgeProtocol === undefined || scope.bridgeProtocol === 0) return workspace;
  if (scope.bridgeProtocol !== 1) throw badScope();
  const { run, attempt } = scope;
  if (!/^r[0-9a-z]{6,24}$/.test(run || '') || !/^[0-9a-f]{32}$/.test(attempt || '') ||
      typeof workspace?.io !== 'string' || !path.isAbsolute(workspace.io)) throw badScope();
  const io = path.resolve(workspace.io), parent = path.dirname(io), name = 'io-' + run + '-' + attempt;
  const C = fs.constants; let directory, target;
  try {
    directory = fs.openSync(parent, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);
    const root = '/proc/self/fd/' + directory, canonical = fs.lstatSync(path.join(root, path.basename(io)));
    if (!canonical.isDirectory() || canonical.isSymbolicLink()) throw badScope();
    const scoped = path.join(root, name);
    try { fs.mkdirSync(scoped, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    target = fs.openSync(scoped, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);
    const stat = fs.fstatSync(target);
    if (!stat.isDirectory() || (stat.mode & 0o777) !== 0o700 || stat.uid !== process.getuid()) throw badScope();
    fs.fsyncSync(directory);
    return { ...workspace, io: path.join(parent, name) };
  } catch { throw badScope(); }
  finally { if (target !== undefined) fs.closeSync(target); if (directory !== undefined) fs.closeSync(directory); }
}
