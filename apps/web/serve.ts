// serve.ts — M0 dev server: static files over the repo root + /api/packs.
// Usage: node apps/web/serve.ts [--port 8123]   (default 127.0.0.1:8123, docs/M0-SPIKE.md section 4)
//
// The browser cannot run TypeScript, so /apps/web/<name>.js is built from apps/web/<name>.ts with
// the local devDependency compiler (node_modules/typescript/bin/tsc, single-file emit) into
// out/web/<name>.js, and rebuilt whenever the .ts is newer. Everything else is node: builtins.
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(import.meta.url);
const ROOT = resolve(HERE, '..', '..', '..');
const ATLAS_DIR = join(ROOT, 'out', 'atlas');
const WEB_TS_DIR = join(ROOT, 'apps', 'web');
const WEB_JS_DIR = join(ROOT, 'out', 'web');
const TSC = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
const WEB_JS_ROUTE = /^\/apps\/web\/([A-Za-z0-9_-]+)\.js$/;

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

/** Build (when stale) and return out/web/<name>.js from apps/web/<name>.ts. */
function buildWebJs(name: string): string {
  const tsPath = join(WEB_TS_DIR, `${name}.ts`);
  const jsPath = join(WEB_JS_DIR, `${name}.js`);
  const fresh = existsSync(jsPath) && statSync(jsPath).mtimeMs >= statSync(tsPath).mtimeMs;
  if (!fresh) {
    const r = spawnSync(
      process.execPath,
      [TSC, tsPath, '--ignoreConfig', '--target', 'es2022', '--module', 'esnext', '--outDir', WEB_JS_DIR],
      { cwd: ROOT, encoding: 'utf8' },
    );
    if (r.status !== 0 || !existsSync(jsPath)) {
      throw new Error(`tsc failed (exit ${r.status}): ${r.stdout}${r.stderr}`);
    }
  }
  return readFileSync(jsPath, 'utf8');
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

  const webJs = path.match(WEB_JS_ROUTE);
  if (webJs !== null) {
    const name = webJs[1];
    if (!existsSync(join(WEB_TS_DIR, `${name}.ts`))) {
      send(res, 404, 'text/plain; charset=utf-8', `not found: ${path} (no apps/web/${name}.ts)`);
      return;
    }
    try {
      send(res, 200, MIME['.js']!, buildWebJs(name));
    } catch (err) {
      send(res, 500, 'text/plain; charset=utf-8', `apps/web/${name}.js build failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return;
  }

  // The two app pages live in apps/web even though the static root is the repo root.
  const page = path === '/' || path === '/index.html' ? 'index.html' : path === '/map.html' ? 'map.html' : null;
  const file = page !== null
    ? join(ROOT, 'apps', 'web', page)
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
