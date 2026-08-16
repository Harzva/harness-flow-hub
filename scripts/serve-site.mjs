import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, resolve } from 'node:path';

const port = Number.parseInt(process.env.HARNESS_FLOW_SITE_PORT ?? '41736', 10);
const root = resolve('site');
const registry = resolve('registry/generated/registry.json');
const contentTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
]);

createServer(async (request, response) => {
  const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
  const requested = pathname === '/registry.json'
    ? registry
    : resolve(join(root, pathname === '/' ? 'index.html' : pathname.slice(1)));

  if (requested !== registry && requested !== root && !requested.startsWith(`${root}\\`) && !requested.startsWith(`${root}/`)) {
    response.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const metadata = await stat(requested);
    if (!metadata.isFile()) throw new Error('Not a file');
    response.writeHead(200, {
      'Content-Type': contentTypes.get(extname(requested)) ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    createReadStream(requested).pipe(response);
  } catch {
    response.writeHead(404).end('Not found');
  }
}).listen(port, '127.0.0.1', () => {
  process.stdout.write(`Harness Flow Hub site: http://127.0.0.1:${port}\n`);
});
