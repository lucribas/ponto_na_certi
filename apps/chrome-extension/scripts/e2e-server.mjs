import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { URL } from 'node:url';

const host = '127.0.0.1';
const port = 4174;
const fixtureDirectory = join(
  import.meta.dirname,
  '..',
  'tests',
  'fixtures',
  'e2e',
);
const contentTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
]);

const server = createServer(async (request, response) => {
  const fixturePrefix = '/tests/fixtures/e2e/';
  const pathname = new URL(request.url ?? '/', `http://${host}:${port}`)
    .pathname;
  if (!pathname.startsWith(fixturePrefix)) {
    response.writeHead(404).end();
    return;
  }

  const fixtureName = pathname.slice(fixturePrefix.length);
  if (!fixtureName || fixtureName.includes('/') || fixtureName.includes('..')) {
    response.writeHead(404).end();
    return;
  }

  try {
    const body = await readFile(join(fixtureDirectory, fixtureName));
    response.writeHead(200, {
      'content-type':
        contentTypes.get(extname(fixtureName)) ?? 'application/octet-stream',
    });
    response.end(body);
  } catch {
    response.writeHead(404).end();
  }
});

server.listen(port, host);
