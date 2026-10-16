// serve.ts — M0 dev server: static files over the repo root + /api/packs.
// Usage: node apps/web/serve.ts [--port 8123]   (default 127.0.0.1:8123, docs/M0-SPIKE.md section 4)
//        node apps/web/serve.ts --check         (build + route check, no listening; SERVE CHECK PASS/FAIL)
//
// The browser cannot run TypeScript, so /apps/web/<name>.js is built from apps/web/<name>.ts with
// the local devDependency compiler (node_modules/typescript/bin/tsc, single-file emit) into
// out/web/<name>.js, and rebuilt whenever the .ts is newer. Everything else is node: builtins.
//
// M2b/M3: /apps/web/play.js is a module graph (play.ts imports packages/{assets,mission,sim}/*.ts),
// built by one tsc run (--rootDir ROOT --outDir out/web --rewriteRelativeImportExtensions) into
// out/web/apps/web/play.js + out/web/packages/**/*.js; those modules are served as
// /packages/<dir>/<name>.js. /defines/{tiles.json,mapelem.dat,unit.dat,houses.dat} come from KAM_DATA
// (default: the r15472 install; docs/M2B-SPIKE.md section 2.8); /mission/TownTutorial.dat (raw bytes)
// comes from KAM_MISSION (docs/M3-SPIKE.md section 5).
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
const MODULE_ROUTE = /^\/packages\/(sim|assets|mission)\/([A-Za-z0-9_-]+)\.js$/;
const DEFINES_ROUTE = /^\/defines\/(tiles\.json|mapelem\.dat|unit\.dat|houses\.dat)$/;
const DEFINES_DIR = process.env.KAM_DATA ?? 'C:\\Users\\me\\Desktop\\KaM Remake\\KaM Remake Beta r15472\\data\\defines';
const MISSION_PATH = process.env.KAM_MISSION ?? 'C:\\Users\\me\\Desktop\\KaM Remake\\Tutorials\\Town Tutorial\\Town Tutorial.dat';

// The play module graph: play.ts plus every file it imports (keep in sync with apps/web/play.ts).
const PLAY_ENTRY = 'apps/web/play.ts';
const PLAY_OUT = join(WEB_JS_DIR, 'apps', 'web', 'play.js');
const PLAY_MODULES = [
  'apps/web/play.ts',
  'packages/assets/tiledata.ts',
  'packages/assets/mapelem.ts',
  'packages/assets/unitdat.ts',
  'packages/assets/housedata.ts',
  'packages/assets/wares.ts',
  'packages/mission/mission.ts',
  'packages/map/map.ts',
  'packages/sim/terrain.ts',
  'packages/sim/astar.ts',
  'packages/sim/walk.ts',
  'packages/sim/sim.ts',
  'packages/sim/rng.ts',
  'packages/sim/economy.ts',
];

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

/** Build the M2b play module graph (play.ts + packages/{assets,sim}/*.ts) when stale. One tsc run
 *  emits out/web/apps/web/play.js + the module tree under out/web/packages with .ts import
 *  specifiers rewritten to .js (--rewriteRelativeImportExtensions; proven in the M2b spike scratch). */
function buildPlayGraph(): void {
  const stale = !existsSync(PLAY_OUT) || PLAY_MODULES.some((rel) => {
    const src = join(ROOT, rel);
    // A missing source counts as stale too, so the tsc run surfaces it instead of serving an old build.
    return !existsSync(src) || statSync(src).mtimeMs > statSync(PLAY_OUT).mtimeMs;
  });
  if (!stale) return;
  const r = spawnSync(
    process.execPath,
    [TSC, PLAY_ENTRY, '--ignoreConfig', '--target', 'es2022', '--module', 'esnext', '--types', 'node',
      '--rootDir', ROOT, '--outDir', WEB_JS_DIR, '--rewriteRelativeImportExtensions'],
    { cwd: ROOT, encoding: 'utf8' },
  );
  if (r.status !== 0 || !existsSync(PLAY_OUT)) {
    throw new Error(`tsc play graph failed (exit ${r.status}): ${r.stdout}${r.stderr}`);
  }
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

  // Mission script from the KaM install (raw bytes; KAM_MISSION overrides for other installs).
  if (path === '/mission/TownTutorial.dat') {
    if (!existsSync(MISSION_PATH)) {
      send(res, 404, 'text/plain; charset=utf-8', `not found: ${path} (KAM_MISSION=${MISSION_PATH})`);
      return;
    }
    send(res, 200, MIME['.map']!, readFileSync(MISSION_PATH));
    return;
  }

  // Defines from the KaM install (read-only; KAM_DATA overrides for other installs).
  if (DEFINES_ROUTE.test(path)) {
    const name = path.slice('/defines/'.length);
    const abs = join(DEFINES_DIR, name);
    if (!existsSync(abs)) {
      send(res, 404, 'text/plain; charset=utf-8', `not found: ${path} (KAM_DATA=${DEFINES_DIR})`);
      return;
    }
    send(res, 200, MIME[extname(name).toLowerCase()] ?? 'application/octet-stream', readFileSync(abs));
    return;
  }

  // Browser modules of the play graph, emitted under out/web/packages/... by buildPlayGraph.
  const mod = path.match(MODULE_ROUTE);
  if (mod !== null) {
    try {
      buildPlayGraph();
      const abs = join(WEB_JS_DIR, 'packages', mod[1], `${mod[2]}.js`);
      if (!existsSync(abs)) {
        send(res, 404, 'text/plain; charset=utf-8', `not found: ${path}`);
        return;
      }
      send(res, 200, MIME['.js']!, readFileSync(abs));
    } catch (err) {
      send(res, 500, 'text/plain; charset=utf-8', `${path} build failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return;
  }

  const webJs = path.match(WEB_JS_ROUTE);
  if (webJs !== null) {
    const name = webJs[1];
    if (name === 'play') {
      try {
        buildPlayGraph();
        send(res, 200, MIME['.js']!, readFileSync(PLAY_OUT));
      } catch (err) {
        send(res, 500, 'text/plain; charset=utf-8', `apps/web/play.js build failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }
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

  // The app pages live in apps/web even though the static root is the repo root.
  const page = path === '/' || path === '/index.html' ? 'index.html'
    : path === '/map.html' ? 'map.html'
      : path === '/play.html' ? 'play.html'
        : null;
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

/** --check: build the play graph and verify every route's backing file, without listening. */
function check(): void {
  const fails: string[] = [];
  try {
    buildPlayGraph();
  } catch (err) {
    fails.push(`play graph: ${err instanceof Error ? err.message : String(err)}`);
  }
  const files: [string, string][] = [
    ['play.html', join(WEB_TS_DIR, 'play.html')],
    ['map.html', join(WEB_TS_DIR, 'map.html')],
    ['index.html', join(WEB_TS_DIR, 'index.html')],
    ['out/maps/TownTutorial.json', join(ROOT, 'out', 'maps', 'TownTutorial.json')],
    ['out/atlas/Tileset.json', join(ATLAS_DIR, 'Tileset.json')],
    ['out/atlas/Units.json', join(ATLAS_DIR, 'Units.json')],
    ['out/atlas/Houses.json', join(ATLAS_DIR, 'Houses.json')],
    ['out/atlas/Trees.json', join(ATLAS_DIR, 'Trees.json')],
    ['defines/tiles.json', join(DEFINES_DIR, 'tiles.json')],
    ['defines/mapelem.dat', join(DEFINES_DIR, 'mapelem.dat')],
    ['defines/unit.dat', join(DEFINES_DIR, 'unit.dat')],
    ['defines/houses.dat', join(DEFINES_DIR, 'houses.dat')],
    ['mission/TownTutorial.dat', MISSION_PATH],
    // The M3 modules must be emitted by the play graph build (served as /packages/**/*.js).
    ['out/web/packages/mission/mission.js', join(WEB_JS_DIR, 'packages', 'mission', 'mission.js')],
    ['out/web/packages/assets/housedata.js', join(WEB_JS_DIR, 'packages', 'assets', 'housedata.js')],
    ['out/web/packages/assets/wares.js', join(WEB_JS_DIR, 'packages', 'assets', 'wares.js')],
    ['out/web/packages/sim/economy.js', join(WEB_JS_DIR, 'packages', 'sim', 'economy.js')],
  ];
  for (const [label, abs] of files) {
    if (!existsSync(abs)) fails.push(`missing ${label} (${abs})`);
  }
  if (!existsSync(PLAY_OUT)) fails.push(`missing ${PLAY_OUT}`);
  if (fails.length > 0) {
    console.log(`SERVE CHECK FAIL: ${fails.join('; ')}`);
    process.exitCode = 1;
    return;
  }
  console.log(`SERVE CHECK PASS (defines=${DEFINES_DIR}, play=${PLAY_OUT})`);
}

const argv = process.argv.slice(2);
if (argv.includes('--check')) {
  check();
} else {
  const port = parsePort(argv);
  server.listen(port, '127.0.0.1', () => {
    console.log(`serve: http://127.0.0.1:${port}/ root=${ROOT} packs=${listPacks().join(',') || '(none)'}`);
  });
}
