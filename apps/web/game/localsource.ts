// localsource.ts — turn a KaM Remake install the player owns into the URL -> bytes bundle the page needs,
// so the game can run with no asset server (docs/DEPLOY.md section 4). The art and the maps stay on the
// player's own machine and are never uploaded: that is the only legal way to publish this client.
//
// Everything in this file is pure logic behind three injected pieces, so the browser build and a node
// check run the very same code:
//   tree       a directory tree to read from (FileSystemDirectoryHandle in the browser, node:fs in a check)
//   inflate    zlib expansion (DecompressionStream('deflate') in the browser, zlib.inflateSync in node)
//   encodePng  sheet pixels -> PNG bytes (OffscreenCanvas in the browser, packages/assets/png.ts in node)
//
// The keys of the bundle mirror the dev server's routes exactly - /defines/*, /mission/TownTutorial.dat,
// /maps and /out/atlas/* - so no loader in play.ts or the lobby changes when the assets come from a folder.
import { buildAtlasData } from '../../../packages/assets/atlas.ts';
import { decodeRxxPayload, readRxxContainer } from '../../../packages/assets/rxx.ts';
import { readMapHeader } from '../../../packages/map/map.ts';
import { parseTxtSmallDesc } from '../../../packages/map/smalldesc.ts';
import { MAX_HANDS, parseMissionInfo } from '../../../packages/mission/mission.ts';
import type { MapInfo } from '../../../packages/map/mapinfo.ts';

/** The six sprite packs the page asks for (tools/import/cli.ts DEFAULT_PACKS). */
export const LOCAL_PACKS = ['Units', 'Tileset', 'Houses', 'Trees', 'GUI', 'GUIMain'];
/** The four define files under <install>/data/defines (apps/web/serve.ts DEFINES_ROUTE). */
export const LOCAL_DEFINES = ['tiles.json', 'mapelem.dat', 'unit.dat', 'houses.dat'];
/** The map roots the scan walks (apps/web/serve.ts MAP_ROOTS). */
export const LOCAL_MAP_ROOTS = ['Maps', 'MapsMP'];
export const ATLAS_URL_DIR = '/out/atlas';
export const MISSION_URL = '/mission/TownTutorial.dat';

export interface DirListing {
  dirs: string[];
  files: string[];
}

/** A read-only view of a directory tree. Paths are '/'-separated and relative to the root it was made for. */
export interface DirTree {
  /** The entries of one directory, or null when it does not exist / cannot be read. */
  list(path: string): Promise<DirListing | null>;
  /** The bytes of one file, or null when it does not exist / cannot be read. */
  read(path: string): Promise<Uint8Array | null>;
}

export interface BuildEnv {
  tree: DirTree;
  inflate(zlibBytes: Uint8Array): Promise<Uint8Array>;
  encodePng(w: number, h: number, rgba: Uint8Array): Promise<Uint8Array>;
}

export interface LocalBundle {
  /** URL path (the dev server's route) -> file bytes. */
  files: Map<string, Uint8Array>;
  mapsJson: string;
  maps: number;
  packs: number;
  builtAt: string;
}

export type Progress = (message: string) => void;

const path = (dir: string, name: string): string => (dir === '' ? name : `${dir}/${name}`);

function text(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('latin1').decode(bytes);
  }
}

/** Case-insensitive name order with an exact-name tiebreak, so the list is deterministic (maplist.ts). */
function compareNames(a: string, b: string): number {
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  if (la < lb) return -1;
  if (la > lb) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The KaM Remake root itself or its data/Sprites directory - whichever holds .rxx files. */
export async function findSpritesDir(tree: DirTree): Promise<string> {
  for (const dir of ['', 'data/Sprites', 'Sprites', 'data/sprites']) {
    const list = await tree.list(dir);
    if (list !== null && list.files.some((f) => f.toLowerCase().endsWith('.rxx'))) return dir;
  }
  throw new Error('no .rxx sprite packs found: pick the KaM Remake folder itself (the one with data\\Sprites)');
}

/** The directory holding tiles.json + the three .dat files. */
export async function findDefinesDir(tree: DirTree): Promise<string> {
  for (const dir of ['data/defines', 'data/Defines', 'defines']) {
    if ((await tree.read(path(dir, 'tiles.json'))) !== null) return dir;
  }
  throw new Error('no data\\defines\\tiles.json found: pick the KaM Remake folder itself');
}

/** The town tutorial mission (/mission/TownTutorial.dat): a fixed path, else the first .dat under Tutorials. */
export async function findMission(tree: DirTree): Promise<string | null> {
  for (const p of ['Tutorials/Town Tutorial/Town Tutorial.dat', 'data/mission/TownTutorial.dat']) {
    if ((await tree.read(p)) !== null) return p;
  }
  const tutorials = await tree.list('Tutorials');
  if (tutorials !== null) {
    for (const dir of [...tutorials.dirs].sort(compareNames)) {
      const sub = await tree.list(path('Tutorials', dir));
      if (sub === null) continue;
      const dat = sub.files.filter((f) => f.toLowerCase().endsWith('.dat')).sort(compareNames)[0];
      if (dat !== undefined) return path(path('Tutorials', dir), dat);
    }
  }
  return null;
}

/**
 * The map list (/maps), the browser's twin of packages/map/maplist.ts scanMapFolders: a folder counts only
 * when <Name>.map and <Name>.dat are both there; size comes from the .map header, players from the .dat,
 * and the SmallDesc from the .txt.
 */
export async function scanMaps(tree: DirTree, onProgress: Progress = () => {}): Promise<MapInfo[]> {
  const out: MapInfo[] = [];
  for (const kind of LOCAL_MAP_ROOTS) {
    const root = await tree.list(kind);
    if (root === null) continue;
    const names = [...root.dirs].sort(compareNames);
    for (const name of names) {
      const folder = path(kind, name);
      const listing = await tree.list(folder);
      if (listing === null) continue;
      const has = (f: string): boolean => listing.files.some((x) => x.toLowerCase() === f.toLowerCase());
      if (!has(`${name}.map`) || !has(`${name}.dat`)) continue;

      const mapBytes = await tree.read(path(folder, `${name}.map`));
      const datBytes = await tree.read(path(folder, `${name}.dat`));
      if (mapBytes === null || datBytes === null) continue;

      let mapX = 0;
      let mapY = 0;
      let remake = false;
      let rev = 0;
      try {
        const header = readMapHeader(mapBytes, `${folder}/${name}.map`);
        mapX = header.mapX;
        mapY = header.mapY;
        remake = header.remake;
        rev = header.rev;
      } catch {
        // unreadable header: the folder is still listed (size 0); `valid` follows maxPlayers
      }

      let info = null as ReturnType<typeof parseMissionInfo> | null;
      try {
        info = parseMissionInfo(datBytes, mapX, mapY);
      } catch {
        info = null;
      }

      const txtFile = listing.files.find((f) => f.toLowerCase() === `${name}.txt`.toLowerCase()) ?? null;
      const txtBytes = txtFile === null ? null : await tree.read(path(folder, txtFile));
      out.push({
        kind,
        name,
        mapPath: `${folder}/${name}.map`,
        datPath: `${folder}/${name}.dat`,
        txtPath: txtFile === null ? null : `${folder}/${txtFile}`,
        mapX,
        mapY,
        remake,
        rev,
        maxPlayers: info !== null ? info.maxPlayers : 0,
        canBeHuman: info !== null ? info.canBeHuman : new Array<boolean>(MAX_HANDS).fill(false),
        classicAI: info !== null ? info.classicAI : new Array<boolean>(MAX_HANDS).fill(false),
        advancedAI: info !== null ? info.advancedAI : new Array<boolean>(MAX_HANDS).fill(false),
        aiStart: info !== null ? info.aiStart : Array.from({ length: MAX_HANDS }, () => ({ x: 1, y: 1 })),
        tactic: info !== null ? info.tactic : false,
        smallDesc: txtBytes === null ? '' : parseTxtSmallDesc(text(txtBytes)),
        valid: (info !== null ? info.maxPlayers : 0) > 0,
      });
    }
    onProgress(`${kind}: ${out.length} maps so far`);
  }
  return out;
}

/** Read and decode the packs, the defines, the mission and the map list; return the URL -> bytes bundle. */
export async function buildBundle(env: BuildEnv, onProgress: Progress = () => {}): Promise<LocalBundle> {
  const files = new Map<string, Uint8Array>();
  const encoder = new TextEncoder();
  const spritesDir = await findSpritesDir(env.tree);
  const definesDir = await findDefinesDir(env.tree);

  let packs = 0;
  for (const pack of LOCAL_PACKS) {
    const file = path(spritesDir, `${pack}.rxx`);
    const raw = await env.tree.read(file);
    if (raw === null) throw new Error(`sprite pack not found: ${file}`);
    const { format, headerLen } = readRxxContainer(raw);
    const payload = await env.inflate(raw.subarray(headerLen));
    const decoded = decodeRxxPayload(payload, pack, format);
    const build = buildAtlasData(decoded);
    for (const sheet of [...build.sheets, ...build.maskSheets]) {
      files.set(`${ATLAS_URL_DIR}/${sheet.file}`, await env.encodePng(sheet.w, sheet.h, sheet.rgba));
    }
    files.set(`${ATLAS_URL_DIR}/${pack}.json`, encoder.encode(`${JSON.stringify(build.manifest)}\n`));
    packs += 1;
    onProgress(`${pack}: ${decoded.sprites.length} sprites, ${build.sheets.length} sheet(s)`);
  }

  for (const name of LOCAL_DEFINES) {
    const bytes = await env.tree.read(path(definesDir, name));
    if (bytes === null) throw new Error(`defines file not found: ${path(definesDir, name)}`);
    files.set(`/defines/${name}`, bytes);
  }

  const mission = await findMission(env.tree);
  if (mission === null) throw new Error('the town tutorial mission was not found (Tutorials\\<name>\\<name>.dat)');
  const missionBytes = await env.tree.read(mission);
  if (missionBytes === null) throw new Error(`cannot read ${mission}`);
  files.set(MISSION_URL, missionBytes);

  const maps = await scanMaps(env.tree, onProgress);
  const mapsJson = `${JSON.stringify(maps)}\n`;
  files.set('/maps', encoder.encode(mapsJson));
  onProgress(`${maps.length} maps, ${files.size} files in the bundle`);
  return { files, mapsJson, maps: maps.length, packs, builtAt: new Date().toISOString() };
}
