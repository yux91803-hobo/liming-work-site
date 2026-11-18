// 所有权锁和记录：谁能写状态库（workflow.sqlite）。
// 设计见 docs/superpowers/specs/2026-11-14-xin-kernel-stage2-design.md §6.2。
//
// 一个单独的小库 owner.sqlite，用 SQLite 自己的文件锁：
//   - 常驻状态进程拿独占锁，是 workflow.sqlite 的唯一写者。
// 锁跟着进程走：进程死了（包括 kill -9）系统立刻放掉，子进程不会把它带走。所以不用 flock：flock 是包在外面的一层进程，
// 包装进程被杀而里面的还活着，锁就丢了；不让它丢，锁的句柄又会被子进程继承走。
// 「一把锁保证只有一个常驻进程」的做法参考 tmux client.c 的 client_get_lock（在套接字旁边的 .lock 上拿独占锁）。
//
// 这个库必须是回滚日志模式，不能改成 WAL：WAL 下独占事务挡不住读者。
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const BRIDGE_PROTOCOL = 1;
const busy = e => e && (e.errcode === 5 || e.errcode === 6 || /database is locked|database table is locked/.test(String(e.message)));
const KEYS = ['mode', 'epoch', 'protocol', 'since'];

export class Ownership {
  constructor(home, { waitMs = 250, beforeRelease = () => {} } = {}) {
    this.file = path.join(path.resolve(home), 'owner.sqlite'); this.waitMs = waitMs;
    this.connection = null; this.owning = false; this.beforeRelease = beforeRelease;
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
      // An exclusive owner makes schema reads busy too. Discovery need not wait before forwarding.
      d.exec('PRAGMA busy_timeout=0');
      try { has = !!d.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='owner'").get(); }
      catch (e) { if (!busy(e)) throw e; has = true; }   // 读都读不了：有人独占着，表一定已经建好了
      finally { d.exec('PRAGMA busy_timeout=' + Math.max(0, this.waitMs | 0)); }
      if (!has) d.exec('CREATE TABLE IF NOT EXISTS owner(k TEXT PRIMARY KEY, v TEXT NOT NULL)');
    } catch (e) { d.close(); throw e; }
    return this.connection = d;
  }
  rows() {
    const r = Object.fromEntries(this.db.prepare('SELECT k, v FROM owner').all().map(x => [x.k, x.v]));
    if (!Object.keys(r).length) return { mode: 'legacy', epoch: 0, protocol: 0, since: 0 };
    const epoch = Number(r.epoch), protocol = Number(r.protocol), since = Number(r.since);
    // 保留历史记录格式。损坏或协议不兼容的记录必须拒绝接管。
    if (!KEYS.every(k => Object.hasOwn(r, k)) || !['legacy', 'kernel'].includes(r.mode) ||
        !Number.isSafeInteger(epoch) || epoch < 1 || !Number.isSafeInteger(protocol) || protocol < 1 || protocol > BRIDGE_PROTOCOL ||
        !Number.isSafeInteger(since) || since < 0)
      throw Object.assign(new Error('所有权记录损坏或桥协议不兼容'), { code: 'owner_invalid' });
    return { mode: r.mode, epoch, protocol, since };
  }
  #saveKernel(previous) {
    const next = { mode: 'kernel', epoch: previous.epoch + 1, protocol: BRIDGE_PROTOCOL, since: Date.now() };
    const put = this.db.prepare('INSERT INTO owner(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v');
    for (const k of KEYS) put.run(k, String(next[k]));
    return next.epoch;
  }
  // 现在的记录。不留锁。主人活着时读不了，返回 { busy: true }
  record({waitMs=this.waitMs}={}) {
    if (this.owning) return this.rows();
    const d=this.db;d.exec('PRAGMA busy_timeout='+Math.max(0,waitMs|0));
    try { d.exec('BEGIN'); } catch (e) { d.exec('PRAGMA busy_timeout='+Math.max(0,this.waitMs|0));if (busy(e)) return { busy: true }; throw e; }
    try { return this.rows(); }
    catch (e) { if (busy(e)) return { busy: true }; throw e; }
    finally { try { d.exec('COMMIT'); } catch { /* 没开成 */ } d.exec('PRAGMA busy_timeout='+Math.max(0,this.waitMs|0)); }
  }
  // 在独占锁下先完成启动校验和备份，再提交接管记录。若失败或被杀，SQLite 保留上次记录。
  // locking_mode=EXCLUSIVE 让提交之后锁仍然在手里。
  take({ waitMs = 30000, initialize = () => {} } = {}) {
    if (this.owning) throw Object.assign(new Error('本连接已经持有所有权锁'), { code: 'owner_busy' });
    const d = this.db;
    d.exec('PRAGMA busy_timeout=' + Math.max(0, waitMs | 0));
    try { d.exec('PRAGMA locking_mode=EXCLUSIVE'); d.exec('BEGIN EXCLUSIVE'); }
    catch (e) {
      try { d.exec('PRAGMA locking_mode=NORMAL'); d.exec('PRAGMA busy_timeout=' + Math.max(0, this.waitMs | 0)); } catch { /* 连接还能用就行 */ }
      if (busy(e)) throw Object.assign(new Error('所有权锁被别人拿着'), { code: 'owner_busy' });
      throw e;
    }
    this.owning = true;
    let epoch;
    try {
      const before = this.rows();
      const init = initialize(before);
      if (init?.then) throw Error('状态初始化必须同步完成');
      epoch = this.#saveKernel(before);
      d.exec('COMMIT');
    } catch (e) {
      try { d.exec('ROLLBACK'); } catch { /* 未开始或已回滚 */ }
      this.close(); throw e;
    }
    return { epoch, release: () => this.close() };
  }
  close() { this.beforeRelease();try { this.connection?.close(); } catch { /* 已经关了 */ } this.connection = null; this.owning = false; }
}
