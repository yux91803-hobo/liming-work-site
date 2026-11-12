/* 小芯浏览器第二步：站长的登录（docs/xin-browser-v2-design.md）。
   不设白名单：任务点名哪个网站，就把那个网站保存的 cookie 装进这一轮的干净浏览器；别的网站的登录一概不装。
   一个网站一个文件（~/.xin/browser-logins/<网站>.json，目录 700、文件 600），只有控制器读写，不挂进容器、不进机外备份。
   参考 Playwright MCP 的 --isolated + --storage-state：每次一个干净浏览器，把保存的 cookie 装进去（一份持久资料同时只能给一个浏览器用）。
   这个文件不 import 别的 vm-*.mjs（vm-browser、vm-agent 都要用它，Worker 装脚本时不允许模块循环引用）。 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

/* ---------- 网站 = 可注册域名 ----------
   没带完整的公共后缀表：常见的多段后缀（com.cn、co.uk…）和托管域名（github.io…，每个子域名是不同的人）按下一级算，
   其余取最后两段。认错的后果只是「两个网站被当成一个」或者反过来，cookie 归属跟着走，不会装进别的网站。 */
const MULTI = new Set(('com.cn net.cn org.cn gov.cn edu.cn ac.cn mil.cn com.hk net.hk org.hk edu.hk gov.hk com.tw net.tw org.tw edu.tw gov.tw com.mo ' +
  'co.uk org.uk ac.uk gov.uk me.uk ltd.uk plc.uk co.jp ne.jp or.jp ac.jp go.jp co.kr or.kr ac.kr com.au net.au org.au edu.au gov.au co.nz ' +
  'com.br com.sg edu.sg gov.sg com.my co.in com.ru com.tr com.mx co.za').split(' '));
const HOSTED = new Set(('github.io gitee.io gitlab.io vercel.app netlify.app pages.dev workers.dev herokuapp.com web.app firebaseapp.com blogspot.com ' +
  'appspot.com readthedocs.io onrender.com fly.dev deno.dev glitch.me replit.app azurewebsites.net cloudfront.net').split(' '));
export function siteOf(host) {
  let h = String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/^\.+|\.+$/g, '');
  if (!h || net.isIP(h)) return null;
  const a = h.split('.');
  if (a.length < 2 || a.some(x => !/^[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?$/.test(x))) return null;
  const two = a.slice(-2).join('.');
  if (MULTI.has(two) || HOSTED.has(two)) return a.length >= 3 ? a.slice(-3).join('.') : null;
  return two;
}
// 站长、前台写的网站：bilibili.com、https://www.bilibili.com/…、www.lcsc.com.cn/order 都认；认不出是哪个网站就是 null
export function normalizeSite(input) {
  const s = String(input || '').trim();
  if (!s || /\s/.test(s)) return null;
  let u; try { u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /^(javascript|data|file|about|chrome|blob|mailto|view-source):/i.test(s) ? s : 'http://' + s); } catch { return null; }
  if (!['http:', 'https:'].includes(u.protocol)) return null;
  return siteOf(u.hostname);
}
export const cookieSite = c => siteOf(c && c.domain);

// Storage.setCookies 认的字段；会话 cookie（expires ≤ 0）不带 expires，装进去就是这一次浏览器开着时有效
const FIELDS = ['name', 'value', 'domain', 'path', 'expires', 'httpOnly', 'secure', 'sameSite', 'priority', 'sourceScheme', 'sourcePort', 'partitionKey'];
const clean = c => Object.fromEntries(FIELDS.filter(k => c[k] !== undefined && c[k] !== null).map(k => [k, c[k]]));
const MAX_COOKIES = 300;

export function loginStore(dir) {
  const ok = site => typeof site === 'string' && siteOf(site) === site;
  const file = site => path.join(dir, site + '.json');
  const read = site => { if (!ok(site)) return null; try { return JSON.parse(fs.readFileSync(file(site), 'utf8')); } catch { return null; } };
  return {
    dir,
    has: site => !!read(site),
    save(site, cookies) {
      if (!ok(site)) throw Error('不认的网站：' + site);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); fs.chmodSync(dir, 0o700);
      const body = JSON.stringify({ site, saved: Date.now(), cookies: (cookies || []).slice(0, MAX_COOKIES).map(clean) });
      const tmp = file(site) + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, body, { mode: 0o600 }); fs.renameSync(tmp, file(site));
    },
    list() {
      let names = []; try { names = fs.readdirSync(dir).filter(f => f.endsWith('.json')); } catch { return []; }
      return names.map(f => read(f.slice(0, -5))).filter(Boolean).map(x => ({ site: x.site, saved: x.saved, count: (x.cookies || []).length })).sort((a, b) => a.site < b.site ? -1 : 1);
    },
    // 点名网站保存的 cookie，变成装进浏览器的参数；过期的不装
    cookies(sites) {
      const now = Date.now() / 1000, out = [];
      for (const site of new Set(sites || [])) for (const c of read(site)?.cookies || []) {
        if (cookieSite(c) !== site || c.expires > 0 && c.expires < now) continue;
        const p = clean(c); if (!(p.expires > 0)) delete p.expires;
        out.push(p);
      }
      return out;
    },
    remove(site) { if (!ok(site)) return false; try { fs.unlinkSync(file(site)); return true; } catch { return false; } },
  };
}
// 浏览器里拿到的整罐 cookie，按网站分开存：只存给出的网站；这次一个都没拿到的网站不存（不把原来好好的登录冲掉）
export function saveSites(store, jar, sites) {
  const saved = [];
  for (const site of [...new Set(sites || [])]) {
    const list = (jar || []).filter(c => cookieSite(c) === site);
    if (!list.length) continue;
    store.save(site, list); saved.push(site);
  }
  return saved;
}
