// cli.ts — build the "KaM data pack": the files this client reads out of one KaM Remake install, in one zip
// the player can carry to another PC (a locked-down work machine, for instance) and point the page at.
//
// What goes in (see apps/web/game/localsource.ts, which decides what the client reads):
//   data/Sprites/{Units,Tileset,Houses,Trees,GUI,GUIMain}.rxx   the six sprite packs the page decodes
//   data/defines/*                                              tiles.json + the three .dat tables
//   Tutorials/**                                                the mission the page boots into
//   Maps/**                                                     every scenario, as it is
//   MapsMP/<name>/**                                            skirmish maps, bots-capable ones first
//
// What never goes in: the player's own install stays the player's. This tool writes a zip to out/ (never
// committed, see AGENTS.md rule 4); it does not upload anything anywhere.
//
//   node tools/pack/cli.ts --check                     build out/kam-data.zip and verify it byte for byte
//   node tools/pack/cli.ts --install <dir> --out <zip> --maps 30
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { readMapHeader } from '../../packages/map/map.ts';
import { parseMissionInfo } from '../../packages/mission/mission.ts';
import { crc32, readZipDirectory, unzipAll, writeZip } from '../../packages/archive/zip.ts';
import type { ZipEntryInput } from '../../packages/archive/zip.ts';

const DEFAULT_INSTALL = 'C:\\Users\\me\\Desktop\\KaM Remake\\KaM Remake Beta r15472';
const PACKS = ['Units', 'Tileset', 'Houses', 'Trees', 'GUI', 'GUIMain'];
/** Files that the client scans for (localsource.ts LOCAL_DEFINES). */
const DEFINES = ['tiles.json', 'mapelem.dat', 'unit.dat', 'houses.dat'];

function flag(name: string): boolean {
  return process.argv.includes(name);
}

function option(name: string, fallback: string): string {
  const at = process.argv.indexOf(name);
  return at >= 0 && at + 1 < process.argv.length ? process.argv[at + 1] : fallback;
}

interface Found {
  /** '/'-separated path inside the archive (what the page will see). */
  name: string;
  /** absolute path on disk */
  from: string;
  bytes: Uint8Array;
}

function walk(dir: string, base: string, out: Found[], keep?: (name: string) => boolean): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) walk(abs, base, out, keep);
    else if (entry.isFile() && (keep === undefined || keep(entry.name))) {
      out.push({ name: relative(base, abs).split(sep).join('/'), from: abs, bytes: readFileSync(abs) });
    }
  }
}

/** What the client reads out of a map folder, and nothing else: the page asks for map/dat/txt only
 *  (apps/web/game/localassets.ts LOCAL_ROUTES). The rest of a published map - .wav, .pdf, .script - is
 *  100 MB of a player's extras that a browser port has no use for. */
function neededMapFile(name: string): boolean {
  const ext = extname(name).toLowerCase();
  return ext === '.map' || ext === '.dat' || ext === '.txt';
}

function text(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('latin1').decode(bytes);
  }
}

function sha(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 16);
}

/** The MapsMP folders whose .dat hands at least one slot to a bot - the ones worth carrying. */
function botMaps(mapsDir: string): string[] {
  if (!existsSync(mapsDir)) return [];
  const capable: string[] = [];
  for (const entry of readdirSync(mapsDir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (!entry.isDirectory()) continue;
    const folder = join(mapsDir, entry.name);
    const mapFile = join(folder, `${entry.name}.map`);
    const datFile = join(folder, `${entry.name}.dat`);
    if (!existsSync(mapFile) || !existsSync(datFile)) continue;
    try {
      const header = readMapHeader(readFileSync(mapFile), entry.name);
      const info = parseMissionInfo(readFileSync(datFile), header.mapX, header.mapY);
      if (info.advancedAI.some(Boolean) || info.classicAI.some(Boolean)) capable.push(entry.name);
    } catch {
      // an unreadable map is simply not offered
    }
  }
  return capable;
}

async function main(): Promise<void> {
  const install = resolve(option('--install', DEFAULT_INSTALL));
  const out = resolve(option('--out', join('out', 'kam-data.zip')));
  const mapLimit = Number(option('--maps', '20'));
  const check = flag('--check');
  if (!existsSync(install)) {
    console.error(`pack: no KaM install at ${install} (use --install <dir>)`);
    process.exitCode = 1;
    return;
  }

  const found: Found[] = [];
  const missing: string[] = [];
  const add = (name: string, abs: string, required = true): void => {
    if (existsSync(abs) && statSync(abs).isFile()) found.push({ name, from: abs, bytes: readFileSync(abs) });
    else if (required) missing.push(name);
  };

  for (const pack of PACKS) add(`data/Sprites/${pack}.rxx`, join(install, 'data', 'Sprites', `${pack}.rxx`));
  for (const name of DEFINES) add(`data/defines/${name}`, join(install, 'data', 'defines', name));
  if (missing.length > 0) {
    console.error(`pack: this install is missing ${missing.join(', ')} - is ${install} the KaM Remake folder?`);
    process.exitCode = 1;
    return;
  }

  // everything else under these roots: the defines and the tutorial as they are, the maps trimmed to the
  // three files the client reads
  const extra: Found[] = [];
  for (const root of ['data/defines', 'Tutorials']) {
    const dir = join(install, root.split('/').join(sep));
    if (existsSync(dir)) walk(dir, install, extra);
  }
  const mapsRoot = join(install, 'Maps');
  if (existsSync(mapsRoot)) walk(mapsRoot, install, extra, neededMapFile);
  for (const file of extra) if (!found.some((f) => f.name === file.name)) found.push(file);

  const mpDir = join(install, 'MapsMP');
  const capable = botMaps(mpDir);
  const chosen = capable.slice(0, mapLimit);
  for (const name of chosen) {
    const folder = join(mpDir, name);
    const files: Found[] = [];
    walk(folder, mpDir, files, neededMapFile);
    for (const file of files) found.push({ ...file, name: `MapsMP/${file.name}` });
  }

  const entries: ZipEntryInput[] = found.map((f) => ({
    name: f.name,
    data: f.bytes,
    // .rxx are already deflated inside (readRxxContainer/inflate in localsource.ts): storing them keeps the
    // pack small and unpacking cheap; everything else is plain data and compresses well
    deflate: extname(f.name).toLowerCase() !== '.rxx',
  }));

  const note = [
    'KaM data pack for the kam-web client.',
    '',
    `built ${new Date().toISOString().slice(0, 16).replace('T', ' ')} from ${install}`,
    `contents: ${PACKS.length} sprite packs, ${DEFINES.length} define files, Tutorials, Maps, ` +
      `${chosen.length} of ${capable.length} bot-capable MapsMP maps`,
    `files: ${found.length}`,
    '',
    'This is one player\'s own KaM Remake data (the game art is TopWare\'s). Keep it to yourself: it is why',
    'the client can be public while the art is not. Point the page at this archive with "Use my KaM folder"',
    '(extract it first) or hand it to the file picker. Nothing here is uploaded by the page.',
    '',
  ].join('\n');
  entries.push({ name: 'PACK.txt', data: new TextEncoder().encode(note), deflate: true });

  const zip = writeZip(entries, (b) => new Uint8Array(deflateRawSync(b)));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, zip);

  const raw = found.reduce((n, f) => n + f.bytes.length, 0);
  console.log(`pack: ${out}`);
  console.log(
    `pack: ${entries.length} entries, ${(raw / 1048576).toFixed(2)} MB of files -> ${(zip.length / 1048576).toFixed(2)} MB zip ` +
      `(${PACKS.length} packs, ${found.length - entries.length + entries.length} files, ${chosen.length}/${capable.length} bot maps)`,
  );
  for (const name of ['data/Sprites/Units.rxx', 'data/defines/tiles.json', 'Maps', 'MapsMP']) {
    const count = entries.filter((e) => e.name === name || e.name.startsWith(`${name}/`)).length;
    console.log(`pack:   ${name}${count === 1 ? '' : ` (${count} files)`}`);
  }

  if (!check) return;

  // Read the archive back the way the page will: every entry decompressed, its CRC checked, the bytes
  // compared to the file it came from. A pack that fails here would fail inside the browser instead.
  const problems: string[] = [];
  let back: Map<string, Uint8Array>;
  try {
    back = await unzipAll(zip, (b) => new Uint8Array(inflateRawSync(b)));
  } catch (err) {
    console.error(`PACK CHECK FAIL: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }
  const dir = readZipDirectory(zip);
  if (dir.length !== entries.length) problems.push(`${dir.length} entries listed, ${entries.length} written`);
  if (dir.length !== back.size) problems.push(`${back.size} entries read back, ${dir.length} listed`);
  for (const f of found) {
    const got = back.get(f.name);
    if (got === undefined) problems.push(`${f.name} is missing from the archive`);
    else if (got.length !== f.bytes.length || sha(got) !== sha(f.bytes)) problems.push(`${f.name} differs from the file on disk`);
  }
  for (const required of ['data/Sprites/Units.rxx', 'data/Sprites/GUIMain.rxx', 'data/defines/tiles.json', 'data/defines/houses.dat', 'PACK.txt']) {
    if (!back.has(required)) problems.push(`${required} is not in the archive`);
  }
  const stored = dir.filter((e) => e.method === 0).length;
  const crcOk = dir.every((e) => e.crc === crc32(back.get(e.name) ?? new Uint8Array(0)));
  if (!crcOk) problems.push('an entry has a bad CRC');

  if (problems.length > 0) {
    for (const p of problems.slice(0, 8)) console.error(`  - ${p}`);
    console.error(`PACK CHECK FAIL (${problems.length} problem(s))`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `PACK CHECK PASS (${dir.length} entries, ${stored} stored + ${dir.length - stored} deflated, every file byte-identical ` +
      `to the install, ${chosen.length} bot-capable skirmish maps)`,
  );
}

void main();
