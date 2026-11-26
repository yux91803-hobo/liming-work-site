/* Static preview only: /api/* returns 404 like the Worker; tool routes (/map, /stm32) serve the homepage like the SPA fallback. */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const site = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../site');
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg' };
const server = http.createServer((req, res) => {
  let p; try { p = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); } catch { res.writeHead(400).end(); return; }
  if (p.startsWith('/api/')) { res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'not_found' })); return; }
  if (['/map', '/stm32'].includes(p.replace(/\/$/, ''))) p = '/index.html';
  let file = path.resolve(site, '.' + p);
  if (!file.startsWith(site + path.sep) && file !== site) { res.writeHead(403).end(); return; }
  try { if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html'); if (!fs.statSync(file).isFile()) throw new Error(); }
  catch { res.writeHead(404, { 'content-type': 'text/plain' }).end('Not Found'); return; }
  res.writeHead(200, { 'content-type': mime[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  if (req.method === 'HEAD') res.end(); else fs.createReadStream(file).pipe(res);
});
const portArg = process.argv.indexOf('--port');
const port = Number(portArg >= 0 ? process.argv[portArg + 1] : process.env.PORT) || 5173;
server.listen(port, '0.0.0.0', () => console.log(`Static preview: http://localhost:${port}/`));
