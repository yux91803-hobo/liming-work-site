// 所有权锁和记录：谁能写状态库（workflow.sqlite）。
// 设计见 docs/superpowers/specs/2026-11-14-xin-kernel-stage2-design.md §6.2。
//
// 一个单独的小库 owner.sqlite，用 SQLite 自己的文件锁：
//   - 状态进程（以后的唯一写者）拿独占锁，一直不放；
//   - 旧模式的写者每次写之前开一个读事务（共享锁），写完才放。
// 锁跟着进程走：进程死了（包括 kill -9）系统立刻放掉，子进程不会把它带走。所以不用 flock：flock 是包在外面的一层进程，
// 包装进程被杀而里面的还活着，锁就丢了；不让它丢，锁的句柄又会被子进程继承走。
// 「一把锁保证只有一个常驻进程」的做法参考 tmux client.c 的 client_get_lock（在套接字旁边的 .lock 上拿独占锁）。
//
// 这个库必须是回滚日志模式，不能改成 WAL：WAL 下独占事务挡不住读者。
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const BRIDGE_PROTOCOL = 1;
// status：'alive' 主人活着；'missing' 该内核当主人但它不在。两种都不能写。
export class OwnerUnavailable extends Error {
  constructor(status) { super('owner_' + status); this.code = 'owner_unavailable'; this.status = status; }
}
const busy = e => e && (e.errcode === 5 || e.errcode === 6 || /database is locked|database table is locked/.test(String(e.message)));
const KEYS = ['mode', 'epoch', 'protocol', 'since'];

export class Ownership {
  constructor(home, { waitMs = 250 } = {}) {
    this.file = path.join(path.resolve(home), 'owner.sqlite'); this.waitMs = waitMs;
    this.connection = null; this.depth = 0; this.owning = false;
  }
  // 内部用的连接，第一次用到才打开
  get db() {
    if (this.connection) return this.connection;
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    let stat; try { stat = fs.lstatSync(this.file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (stat?.isSymbolicLink()) throw Error('所有权库不能是软链接');
    const d = new DatabaseSync(this.file);
    try {
      fs.chmodSync(this.file, 0o600);
      d.exec('PRAGMA busy_timeout=' + Math.max(0, this.waitMs | 0));
      // 只在表还没有的时候才建：平时不为建表去拿写锁，不会把别的写者挡一下
      let has = false;
      try { has = !!d.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='owner'").get(); }
      catch (e) { if (!busy(e)) throw e; has = true; }   // 读都读不了：有人独占着，表一定已经建好了
      if (!has) d.exec('CREATE TABLE IF NOT EXISTS owner(k TEXT PRIMARY KEY, v TEXT NOT NULL)');
    } catch (e) { d.close(); throw e; }
    return this.connection = d;
  }
  rows() {
    const r = Object.fromEntries(this.db.prepare('SELECT k, v FROM owner').all().map(x => [x.k, x.v]));
    if (!Object.keys(r).length) return { mode: 'legacy', epoch: 0, protocol: 0, since: 0 };
    const epoch = Number(r.epoch), protocol = Number(r.protocol), since = Number(r.since);
    // 只有真正的新库才能默认旧模式。损坏/不认识的记录不能放行旧写者，也不自动覆盖修复。
    if (!KEYS.every(k => Object.hasOwn(r, k)) || !['legacy', 'kernel'].includes(r.mode) ||
        !Number.isSafeInteger(epoch) || epoch < 1 || !Number.isSafeInteger(protocol) || protocol < 1 || protocol > BRIDGE_PROTOCOL ||
        !Number.isSafeInteger(since) || since < 0)
      throw Object.assign(new Error('所有权记录损坏或桥协议不兼容'), { code: 'owner_invalid' });
    return { mode: r.mode, epoch, protocol, since };
  }
  save(mode) {
    const now = this.rows(), next = { mode, epoch: now.epoch + 1, protocol: BRIDGE_PROTOCOL, since: Date.now() };
    const put = this.db.prepare('INSERT INTO owner(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v');
    for (const k of KEYS) put.run(k, String(next[k]));
    return next.epoch;
  }
  // 现在的记录。不留锁。主人活着时读不了，返回 { busy: true }
  record() {
    if (this.owning || this.depth > 0) return this.rows();
    try { this.db.exec('BEGIN'); } catch (e) { if (busy(e)) return { busy: true }; throw e; }
    try { return this.rows(); }
    catch (e) { if (busy(e)) return { busy: true }; throw e; }
    finally { try { this.db.exec('COMMIT'); } catch { /* 没开成 */ } }
  }
  // 旧模式的写入口：拿共享锁并确认归旧模式，返回放锁函数。每次都重新判断，不缓存（执行进程会活过一次切换）。
  // 可重入：本进程已经拿着（或本进程就是主人）时返回空操作。
  enter() {
    if (this.owning) return () => {};
    if (this.depth > 0) { this.depth++; return () => { this.leave(); }; }
    const d = this.db;
    let r;
    try { d.exec('BEGIN'); r = this.rows(); }   // 读这一下才真的拿到共享锁
    catch (e) { try { d.exec('ROLLBACK'); } catch { /* 没开成 */ } if (busy(e)) throw new OwnerUnavailable('alive'); throw e; }
    if (r.mode !== 'legacy') { d.exec('COMMIT'); throw new OwnerUnavailable('missing'); }
    this.depth = 1;
    return () => { this.leave(); };
  }
  leave() { if (this.depth > 0 && --this.depth === 0) this.db.exec('COMMIT'); }
  // 同 enter，但一直拿到进程结束：一次性进程用（每个请求起的那个、flock 里面的那个），本来就只活几十毫秒
  hold() { this.enter(); }
  // 当主人：拿独占锁（等正在写的旧写者写完，最多 waitMs），写「归内核」、切换次数加一，一直不放。
  // locking_mode=EXCLUSIVE 让提交之后锁仍然在手里。
  take({ waitMs = 30000 } = {}) {
    if (this.depth > 0) throw Object.assign(new Error('本进程还拿着共享锁，不能当主人'), { code: 'owner_busy' });
    const d = this.db;
    d.exec('PRAGMA busy_timeout=' + Math.max(0, waitMs | 0));
    try { d.exec('PRAGMA locking_mode=EXCLUSIVE'); d.exec('BEGIN EXCLUSIVE'); }
    catch (e) {
      try { d.exec('PRAGMA locking_mode=NORMAL'); d.exec('PRAGMA busy_timeout=' + Math.max(0, this.waitMs | 0)); } catch { /* 连接还能用就行 */ }
      if (busy(e)) throw Object.assign(new Error('所有权锁被别人拿着'), { code: 'owner_busy' });
      throw e;
    }
    let epoch;
    try { epoch = this.save('kernel'); d.exec('COMMIT'); } catch (e) { try { d.exec('ROLLBACK'); } catch { /* 没开成 */ } this.close(); throw e; }
    this.owning = true;
    return { epoch, release: mode => { if (this.owning && mode) { this.db.exec('BEGIN'); this.save(mode); this.db.exec('COMMIT'); } this.close(); } };
  }
  // 没有主人时改记录（内核起不来以后切回旧模式用）。有主人活着就改不了。
  set(mode) {
    if (mode !== 'legacy' && mode !== 'kernel') throw Error('不认识的模式');
    const d = this.db;
    try { d.exec('BEGIN EXCLUSIVE'); } catch (e) { if (busy(e)) throw Object.assign(new Error('所有权锁被别人拿着'), { code: 'owner_busy' }); throw e; }
    try { const epoch = this.save(mode); d.exec('COMMIT'); return { epoch }; }
    catch (e) { try { d.exec('ROLLBACK'); } catch { /* 没开成 */ } throw e; }
  }
  close() { try { this.connection?.close(); } catch { /* 已经关了 */ } this.connection = null; this.depth = 0; this.owning = false; }
}
