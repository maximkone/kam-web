// ui/model.ts — pure helpers of the game UI (B2A): names, footprints, paths, colours. No DOM, no sim
// state is written here. Browser-safe (no node: imports).
import { housePlan } from '../../../packages/assets/housedata.ts';
import { WARE_NAMES } from '../../../packages/assets/wares.ts';

/** Pixels per tile in the renderer's world space (play.ts CELL). Tile T spans [(T-1)*CELL, T*CELL). */
export const CELL = 40;

/** Script ids of the house types (play.ts HOUSE_TYPE_NAMES; the index is the script id). */
export const HOUSE_NAMES: string[] = [
  'sawmill', 'iron smithy', 'weapon smithy', 'coal mine', 'iron mine', 'gold mine', 'fisherman',
  'bakery', 'farm', 'woodcutters', 'armor smithy', 'store', 'stables', 'school', 'quarry',
  'metallurgists', 'swine', 'watchtower', 'town hall', 'weapon workshop', 'armor workshop',
  'barracks', 'mill', 'siege workshop', 'butcher', 'tannery', 'none', 'inn', 'vineyard', 'market',
];
export const HT_NONE = 26;
export const HT_STORE = 11;
export const HT_SCHOOL = 13;
export const HT_BARRACKS = 21;

/** unit.dat records 0..22 (ai.ts UT_*): the names the panels show. */
export const UNIT_NAMES: string[] = [
  'serf', 'woodcutter', 'miner', 'animal breeder', 'farmer', 'carpenter', 'baker', 'butcher', 'fisher',
  'builder', 'stonemason', 'smith', 'metallurgist', 'recruit', 'militia', 'axe fighter', 'sword fighter',
  'bowman', 'crossbowman', 'lance carrier', 'pikeman', 'scout', 'knight',
];
/** What a school can train (the sim's houseTrain allows 0..13; 13 is the recruit for the barracks). */
export const SCHOOL_UNITS: number[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];
/** What a barracks can equip (TROOP_COST keys, economy.ts). */
export const BARRACKS_UNITS: number[] = [14, 15, 16, 17, 18, 19, 20, 21, 22];

/** Wares listed in the resource bar, in this order; `trunks` stays first (the B1 check reads it). */
export const STOCK_WARES: number[] = [0, 2, 1, 7, 6, 5, 3, 4, 10, 9, 8, 13, 27, 11];
/** Short top-bar labels by ware id (the full names go in the stock tooltip). */
export const WARE_SHORT: string[] = ['trk', 'stn', 'tmb', 'iOre', 'gOre', 'coal', 'iron', 'gold', 'wine', 'corn', 'brd', 'flr', 'lthr', 'saus', 'pig', 'skin', 'wshd', 'ishd', 'larm', 'iarm', 'axe', 'swd', 'lnc', 'pke', 'bow', 'xbow', 'hrs', 'fish'];

/** Hand colours (the human hand is 0). */
export const HAND_COLOURS: string[] = ['#4f8cff', '#ff5a4f', '#47d16b', '#ffd24a', '#c77dff', '#ff9f43', '#2ed3c6', '#ff6fb5'];

export function wareName(id: number): string {
  return WARE_NAMES[id] ?? `ware ${id}`;
}

export function houseName(typeId: number): string {
  return HOUSE_NAMES[typeId] ?? `house ${typeId}`;
}

export function unitName(type: number): string {
  return UNIT_NAMES[type] ?? `unit ${type}`;
}

export interface Tile {
  x: number;
  y: number;
}

/** The tiles a house plan covers: the 4x4 BuildArea of KM_Terrain (x, y = the entrance tile). */
export function footprint(typeId: number, x: number, y: number, entranceDx: number): Tile[] {
  const area = housePlan(typeId);
  const locX = x - entranceDx;
  const out: Tile[] = [];
  for (let i = 1; i <= 4; i++) {
    for (let k = 1; k <= 4; k++) {
      if (area[i - 1]![k - 1] === 0) continue;
      out.push({ x: locX + k - 3, y: y + i - 4 });
    }
  }
  return out;
}

/** The tiles of a straight 8-connected line from a to b, both ends included (Bresenham). */
export function linePath(a: Tile, b: Tile): Tile[] {
  const out: Tile[] = [];
  let x = a.x;
  let y = a.y;
  const dx = Math.abs(b.x - a.x);
  const dy = -Math.abs(b.y - a.y);
  const sx = a.x < b.x ? 1 : -1;
  const sy = a.y < b.y ? 1 : -1;
  let err = dx + dy;
  for (let guard = 0; guard < 4096; guard++) {
    out.push({ x, y });
    if (x === b.x && y === b.y) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
  }
  return out;
}

/** The longest prefix of `items` whose entries all pass `ok` (a road line must stay connected). */
export function validPrefix<T>(items: T[], ok: (t: T) => boolean): T[] {
  const out: T[] = [];
  for (const t of items) {
    if (!ok(t)) break;
    out.push(t);
  }
  return out;
}

/** The screen rectangle spanned by two points, normalised (x, y is the top-left corner). */
export function rectOf(x0: number, y0: number, x1: number, y1: number): { x: number; y: number; w: number; h: number } {
  return { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
}

export function pointInRect(px: number, py: number, r: { x: number; y: number; w: number; h: number }): boolean {
  return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
}

/** Game time from a tick (10 ticks per second), as m:ss. */
export function clockText(tick: number): string {
  const sec = Math.floor(tick / 10);
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

/** A house's state for the panel, from the sim's build state (construction.ts BuildState). */
export function houseStateText(buildState: string): string {
  switch (buildState) {
    case 'noGlyph':
      return 'digging';
    case 'wood':
    case 'stone':
      return 'building';
    case 'done':
      return 'active';
    default:
      return buildState;
  }
}

/** Terrain kind (tiledata.ts TKMTerrainKind id) -> an RGB colour for the minimap. */
export function kindRgb(kind: number): [number, number, number] {
  if (kind === 0 || kind === 1 || kind === 2 || kind === 5 || kind === 6 || kind === 7) return [74, 128, 58]; // grass
  if (kind === 3 || kind === 4 || kind === 8) return [206, 190, 118]; // pale grass, coast sand, sand
  if (kind === 9 || kind === 10 || kind === 11 || kind === 23) return [126, 96, 62]; // dirt, cobbles, gravel
  if (kind === 12 || kind === 13) return [58, 96, 70]; // grassy water, swamp
  if (kind === 14 || kind === 15 || kind === 16 || kind === 17 || kind === 18) return [226, 232, 238]; // snow, ice
  if (kind === 19 || kind === 20 || kind === 21) return [122, 122, 130]; // stone, mountains
  if (kind === 22) return [20, 20, 24]; // abyss
  if (kind === 24 || kind === 25 || kind === 26) return [90, 80, 96]; // coal, gold, iron ore
  if (kind === 27 || kind === 28) return [46, 96, 168]; // water
  if (kind === 29) return [210, 80, 30]; // lava
  return [70, 90, 70];
}
