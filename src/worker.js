// Liming 工具箱 Worker：只做这几件事，其余全部交给静态资源（SPA 回退）。
// 1. 工具的 assets 文件缺失时回 404，不让 SPA 回退成 index.html（找图失败时好排查）
// 2. /api/xin/* 小芯聊天（站长登录后，经 InstaBox 云电脑里的 AI 聊天干活，见 xin.js）；定时任务叫醒小芯做每日任务
// 3. 其余 /api/* 一律 404（互传、协作中心的接口已经删掉）
// 4. 工具 assets 里的图片缓存一天
import { handleXin, runCron } from './xin.js';
const IMAGE_CACHE = 'public, max-age=86400';
const SEC_HEADERS = { 'X-Robots-Tag': 'noindex, nofollow', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (/^\/tools\/[^/]+\/assets\//.test(url.pathname)) {
      const r = await env.ASSETS.fetch(req);
      const ct = (r.headers.get('content-type') || '').toLowerCase();
      // 只把「真缺失」改成 404：资源层 404，或 SPA 回退出来的 200 HTML。304 等其他状态原样透传
      if (r.status === 404 || (r.status === 200 && ct.includes('text/html'))) return new Response('Not Found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
      // 图片（课件图、原理图、手册图）缓存一天：再次打开不用逐张问服务器；JS / 数据不缓存，改了马上生效
      if (r.status === 200 && ct.startsWith('image/')) {
        const res = new Response(r.body, r);
        res.headers.set('Cache-Control', IMAGE_CACHE);
        return res;
      }
      return r;
    }
    if (url.pathname === '/api/xin' || url.pathname.startsWith('/api/xin/')) return handleXin(req, env, ctx);
    if (url.pathname.startsWith('/api/')) {
      return new Response(JSON.stringify({ error: 'not_found' }), { status: 404, headers: { 'Content-Type': 'application/json; charset=utf-8', ...SEC_HEADERS } });
    }
    return env.ASSETS.fetch(req);
  },
  // 定时任务：小芯的每日任务（见 xin.js 的 runCron；只有正式站配了 cron）
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCron(event.cron, env, ctx));
  },
};
