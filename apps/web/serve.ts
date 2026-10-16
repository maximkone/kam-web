// serve.ts — M0 dev server: static files over the repo root + /api/packs.
// Usage: node apps/web/serve.ts [--port 8123]   (default 127.0.0.1:8123, docs/M0-SPIKE.md section 4)
//
// The browser cannot run TypeScript, so /apps/web/demo.js is built from demo.ts with the
// local devDependency compiler (node_modules/typescript/bin/tsc, single-file emit) into
// out/web/demo.js, and rebuilt whenever demo.ts is newer. Everything else is node: builtins.
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(import.meta.url);
const ROOT = resolve(HERE, '..', '..', '..');
const ATLAS_DIR = join(ROOT, 'out', 'atlas');
const DEMO_TS = join(ROOT, 'apps', 'web', 'demo.ts');
const DEMO_JS = join(ROOT, 'out', 'web', 'demo.js');
const TSC = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/octet-stream',
};

function parsePort(argv: string[]): number {
  const i = argv.indexOf('--port');
  if (i === -1) return 8123;
  const p = Number(argv[i + 1]);
  if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error(`bad --port "${argv[i + 1]}"`);
  return p;
}

/** Pack names from out/atlas/*.json, sorted; empty list when the dir is missing. */
function listPacks(): string[] {
  try {
    return readdirSync(ATLAS_DIR)
      .filter((f) => f.toLowerCase().endsWith('.json'))
      .map((f) => f.slice(0, -'.json'.length))
      .sort();
  } catch {
    return [];
  }
}

function send(res: import('node:http').ServerResponse, status: number, type: string, body: string | Buffer): void {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

/** Build (when stale) and return out/web/demo.js from apps/web/demo.ts. */
function demoJs(): string {
  const fresh = existsSync(DEMO_JS) && statSync(DEMO_JS).mtimeMs >= statSync(DEMO_TS).mtimeMs;
  if (!fresh) {
    const r = spawnSync(
      process.execPath,
      [TSC, DEMO_TS, '--ignoreConfig', '--target', 'es2022', '--module', 'esnext', '--outDir', join(ROOT, 'out', 'web')],
      { cwd: ROOT, encoding: 'utf8' },
    );
    if (r.status !== 0 || !existsSync(DEMO_JS)) {
      throw new Error(`tsc failed (exit ${r.status}): ${r.stdout}${r.stderr}`);
    }
  }
  return readFileSync(DEMO_JS, 'utf8');
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const path = decodeURIComponent(url.pathname);

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(res, 405, 'text/plain; charset=utf-8', 'method not allowed');
    return;
  }

  if (path === '/api/packs') {
    send(res, 200, MIME['.json']!, JSON.stringify(listPacks()));
    return;
  }

  if (path === '/apps/web/demo.js') {
    try {
      send(res, 200, MIME['.js']!, demoJs());
    } catch (err) {
      send(res, 500, 'text/plain; charset=utf-8', `demo build failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return;
  }

  const file = path === '/' || path === '/index.html'
    ? join(ROOT, 'apps', 'web', 'index.html')
    : join(ROOT, normalize(path).replace(/^[/\\]+/, ''));

  // Path traversal guard: the resolved path must stay inside the repo root.
  const abs = resolve(file);
  if (!abs.startsWith(resolve(ROOT) + sep)) {
    send(res, 403, 'text/plain; charset=utf-8', 'forbidden');
    return;
  }

  if (!existsSync(abs) || !statSync(abs).isFile()) {
    send(res, 404, 'text/plain; charset=utf-8', `not found: ${path}`);
    return;
  }
  const type = MIME[extname(abs).toLowerCase()] ?? 'application/octet-stream';
  send(res, 200, type, readFileSync(abs));
});

const port = parsePort(process.argv.slice(2));
server.listen(port, '127.0.0.1', () => {
  console.log(`serve: http://127.0.0.1:${port}/ root=${ROOT} packs=${listPacks().join(',') || '(none)'}`);
});
