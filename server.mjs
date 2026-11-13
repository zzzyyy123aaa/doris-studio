import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { createDorisApi } from './server/doris-api.mjs';

try {
  loadEnvFile(fileURLToPath(new URL('.env', import.meta.url)));
} catch (error) {
  if (error.code !== 'ENOENT') throw new Error('无法读取项目的 .env 配置。');
}

const root = path.resolve(fileURLToPath(new URL('./dist/', import.meta.url)));
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};
const portValue = process.env.STUDIO_PORT?.trim() || '4173';
const port = Number(portValue);
if (!/^\d+$/.test(portValue) || port < 1 || port > 65535) {
  throw new Error('STUDIO_PORT 必须是 1 至 65535 之间的整数。');
}
const doris = createDorisApi(process.env);

async function serveStatic(request, response, url) {
  if (!['GET', 'HEAD'].includes(request.method)) {
    response.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }
  const pathname = decodeURIComponent(url.pathname);
  const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
  if (!file.startsWith(root + path.sep)) {
    response.writeHead(403).end();
    return;
  }
  let data = await readFile(file);
  if (file === path.join(root, 'index.html') && doris.mode === 'live') {
    data = data.toString('utf8').replace(/<head>/i, '$&\n  <meta name="doris-mode" content="live">');
  }
  response.writeHead(200, {
    'Content-Type': types[path.extname(file)] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  }).end(request.method === 'HEAD' ? undefined : data);
}

const server = createServer({ headersTimeout: 10_000, requestTimeout: 20_000, connectionsCheckingInterval: 1000 },
  async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      const api = url.pathname === '/api' || url.pathname.startsWith('/api/');
      if (!/^(localhost|127\.0\.0\.1)(?::\d+)?$/i.test(request.headers.host || '')) {
        response.writeHead(421, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
          .end(JSON.stringify({ error: '请通过本机地址或配置了本机上游 Host 的反向代理访问。' }));
        return;
      }
      if (api) await doris.handle(request, response, url);
      else await serveStatic(request, response, url);
    } catch {
      if (!response.destroyed) response.writeHead(404).end('Not found');
    }
  },
);

server.listen(port, '127.0.0.1', () => {
  console.log(`Local: http://127.0.0.1:${port} (${doris.mode})`);
  doris.start();
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => server.close(async () => {
    await doris.close();
  }));
}
