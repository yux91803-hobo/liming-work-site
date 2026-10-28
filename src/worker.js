// Liming 工具箱 Worker：只做两件事，其余全部交给静态资源（SPA 回退）。
// 1. 工具的 assets 文件缺失时回 404，不让 SPA 回退成 index.html（找图失败时好排查）
// 2. /api/* 一律 404（互传、协作中心的接口已经删掉）
const SEC_HEADERS = { 'X-Robots-Tag': 'noindex, nofollow', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (/^\/tools\/[^/]+\/assets\//.test(url.pathname)) {
      const r = await env.ASSETS.fetch(req);
      const ct = (r.headers.get('content-type') || '').toLowerCase();
      // 只把「真缺失」改成 404：资源层 404，或 SPA 回退出来的 200 HTML。304 等其他状态原样透传
      if (r.status === 404 || (r.status === 200 && ct.includes('text/html'))) return new Response('Not Found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
      return r;
    }
    if (url.pathname.startsWith('/api/')) {
      return new Response(JSON.stringify({ error: 'not_found' }), { status: 404, headers: { 'Content-Type': 'application/json; charset=utf-8', ...SEC_HEADERS } });
    }
    return env.ASSETS.fetch(req);
  },
};
