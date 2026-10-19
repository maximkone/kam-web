// cli.ts — LOCAL CHECK: the browser's own asset path, run in node, must produce exactly what the dev
// server serves. apps/web/game/localsource.ts is what a player's browser runs when they pick their KaM
// Remake folder (docs/DEPLOY.md section 4); here the same code runs with node capabilities (node:fs tree,
// zlib.inflateSync, packages/assets/png.ts) and its output is compared, file by file, with
//   out/atlas/*            (the atlases tools/import/cli.ts wrote from the same install)
//   <install>/data/defines (what serve.ts answers for /defines/*)
//   scanMapFolders         (what serve.ts answers for /maps)
// so a browser-only break shows up here, without a browser.
//
// Usage: node tools/localcheck/cli.ts --check [--install "<KaM Remake root>"] [--out out]
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { inflateSync } from 'node:zlib';
import { toPng } from '../../packages/assets/png.ts';
import { scanMapFolders } from '../../packages/map/maplist.ts';
import { buildBundle } from '../../apps/web/game/localsource.ts';
import type { DirListing, DirTree, LocalBundle } from '../../apps/web/game/localsource.ts';

const DEFAULT_INSTALL = process.env.KAM_INSTALL ?? 'C:\\Users\\me\\Desktop\\KaM Remake\\KaM Remake Beta r15472';

function argValue(args: string[], name: string): string | null {
  const at = args.indexOf(name);
  return at >= 0 && at + 1 < args.length ? (args[at + 1] ?? null) : null;
}

/** The picked folder as a DirTree, backed by node:fs. */
function nodeTree(root: string): DirTree {
  const abs = (rel: string): string => (rel === '' ? root : join(root, ...rel.split('/')));
  const stat = (p: string): ReturnType<typeof statSync> | null => {
    try {
      return statSync(p);
    } catch {
      return null;
    }
  };
  return {
    async list(rel: string): Promise<DirListing | null> {
      const p = abs(rel);
      if (stat(p)?.isDirectory() !== true) return null;
      const entries = readdirSync(p, { withFileTypes: true });
      return {
        dirs: entries.filter((e) => e.isDirectory()).map((e) => e.name),
        files: entries.filter((e) => e.isFile()).map((e) => e.name),
      };
    },
    async read(rel: string): Promise<Uint8Array | null> {
      const p = abs(rel);
      if (stat(p)?.isFile() !== true) return null;
      return readFileSync(p);
    },
  };
}

function hash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function same(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** The fields of a MapInfo the page reads; paths differ by design (the bundle keeps relative labels). */
function mapKey(m: {
  kind: string;
  name: string;
  mapX: number;
  mapY: number;
  remake: boolean;
  rev: number;
  maxPlayers: number;
  tactic: boolean;
  valid: boolean;
  smallDesc: string;
  canBeHuman: boolean[];
  classicAI: boolean[];
  advancedAI: boolean[];
  aiStart: { x: number; y: number }[];
}): string {
  return [
    m.kind,
    m.name,
    m.mapX,
    m.mapY,
    m.remake ? 1 : 0,
    m.rev,
    m.maxPlayers,
    m.tactic ? 1 : 0,
    m.valid ? 1 : 0,
    m.canBeHuman.map((b) => (b ? 1 : 0)).join(''),
    m.classicAI.map((b) => (b ? 1 : 0)).join(''),
    m.advancedAI.map((b) => (b ? 1 : 0)).join(''),
    m.aiStart.map((p) => `${p.x},${p.y}`).join(';'),
    m.smallDesc,
  ].join('|');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const install = argValue(args, '--install') ?? DEFAULT_INSTALL;
  const out = argValue(args, '--out') ?? 'out';
  const problems: string[] = [];
  const note = (ok: boolean, msg: string): void => {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`);
    if (!ok) problems.push(msg);
  };

  console.log(`LOCAL CHECK install=${install} out=${resolve(out)}`);
  const bundle: LocalBundle = await buildBundle(
    {
      tree: nodeTree(install),
      inflate: async (b) => inflateSync(b),
      encodePng: async (w, h, rgba) => toPng(w, h, rgba),
    },
    (m) => console.log(`  ... ${m}`),
  );
  console.log(`bundle: ${bundle.files.size} files, ${bundle.packs} packs, ${bundle.maps} maps, built ${bundle.builtAt}`);

  // 1. the atlases must be byte-identical to out/atlas (tools/import/cli.ts wrote those from this install)
  const atlasDir = join(out, 'atlas');
  if (!existsSync(atlasDir)) {
    note(false, `no ${atlasDir}: run "npm run import -- --install \\"${install}\\" --out ${out} --check" first`);
  } else {
    const onDisk = readdirSync(atlasDir).sort();
    let compared = 0;
    for (const name of onDisk) {
      const url = `/out/atlas/${name}`;
      const mine = bundle.files.get(url);
      if (mine === undefined) {
        note(false, `the bundle has no ${url}`);
        continue;
      }
      const theirs = readFileSync(join(atlasDir, name));
      const ok = same(mine, theirs);
      note(ok, `${url} ${ok ? `identical (${theirs.length} bytes, sha256 ${hash(theirs).slice(0, 12)})` : `DIFFERS: bundle ${mine.length} bytes vs ${theirs.length}`}`);
      compared += 1;
    }
    const extra = [...bundle.files.keys()].filter((u) => u.startsWith('/out/atlas/') && !onDisk.includes(u.slice('/out/atlas/'.length)));
    note(extra.length === 0, `the bundle adds no atlas file (${extra.length} unexpected)`);
    console.log(`compared ${compared} atlas files`);
  }

  // 2. the defines must be the install's own bytes
  for (const name of ['tiles.json', 'mapelem.dat', 'unit.dat', 'houses.dat']) {
    const mine = bundle.files.get(`/defines/${name}`);
    const theirs = readFileSync(join(install, 'data', 'defines', name));
    note(mine !== undefined && same(mine, theirs), `/defines/${name} matches the install (${theirs.length} bytes)`);
  }

  // 3. the mission
  const mission = bundle.files.get('/mission/TownTutorial.dat');
  note(mission !== undefined && mission.length > 0, `/mission/TownTutorial.dat is in the bundle (${mission?.length ?? 0} bytes)`);

  // 4. the map list must carry the same facts as the server's scan
  const mine = JSON.parse(bundle.mapsJson) as Parameters<typeof mapKey>[0][];
  const theirs = scanMapFolders([
    { kind: 'Maps', dir: join(install, 'Maps') },
    { kind: 'MapsMP', dir: join(install, 'MapsMP') },
  ]);
  note(mine.length === theirs.length, `/maps has ${mine.length} entries, the server's scan has ${theirs.length}`);
  let firstDiff = '';
  const n = Math.min(mine.length, theirs.length);
  for (let i = 0; i < n; i++) {
    if (mapKey(mine[i]!) !== mapKey(theirs[i]!)) {
      firstDiff = `#${i}: bundle ${mapKey(mine[i]!)} vs server ${mapKey(theirs[i]!)}`;
      break;
    }
  }
  note(firstDiff === '', firstDiff === '' ? `/maps entries are identical field by field (${n} compared)` : `/maps differs: ${firstDiff}`);

  if (problems.length > 0) {
    console.error(`LOCAL CHECK FAIL (${problems.length} problem(s))`);
    process.exitCode = 1;
  } else {
    console.log(`LOCAL CHECK PASS (${bundle.files.size} files, ${bundle.maps} maps, atlases byte-identical)`);
  }
}

main().catch((err: unknown) => {
  console.error(`ERROR ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
