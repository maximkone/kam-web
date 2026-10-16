// terrain.ts — the standard-map passability grid behind the A* port.
//
// Source of truth: KM_Terrain.pas (r15472, read-only reference).
//  - buildPassGrid mirrors the Land grid: Land^[Y, X] with X 0..mapX, Y 0..mapY (one more row/col
//    than the file, the last row/column is the border). File record i ↔ X = i mod mapX + 1,
//    Y = floor(i / mapX) + 1 (KM_Terrain.pas 507–540); the parsed KaMap stores [terrain, height,
//    rot, obj] per record (packages/map/map.ts).
//  - tpWalk (the only passability v0 needs) comes from UpdatePassability (3752–3782):
//    `TileIsWalkable(aLoc) and not gMapElements[Land[Y,X].Obj].AllBlocked and CheckHeightPass(aLoc,
//    hpWalking)`. TileIsWalkable for standard maps (HasNoLayers, KM_TerrainTypes.pas 299–302) is the
//    direct tiles.json lookup `Walkable[BaseLayer.Terrain]` (TileHasParameter 1547–1595).
//  - Bounds: usable tiles are 1 ≤ X ≤ mapX−1, 1 ≤ Y ≤ mapY−1 (TileInMapCoords 1137–1141). Border
//    rows/columns and everything outside are unwalkable (TileHasParameter exits False out of box).
//
// Browser-safe: no node: imports.
import type { KaMap } from '../map/map.ts';
import type { MapElem } from '../assets/mapelem.ts';
import type { TileFlags } from '../assets/tiledata.ts';

export interface PassGrid {
  mapX: number;
  mapY: number;
  walk: Uint8Array; // (mapX+1)*(mapY+1), Land-style [y*(mapX+1)+x]; 1 = tpWalk
  obj: Uint8Array; // Land Obj byte (255 = none, 254 = invisible block, 61 = OBJ_BLOCK)
  height: Uint8Array; // corner height bytes (Land^[Y,X].Height)
  elems: MapElem[];
  tiles: TileFlags[];
}

const OBJ_NONE = 255;

/** Grid index for a Land cell (x 0..mapX, y 0..mapY). */
function at(g: PassGrid, x: number, y: number): number {
  return y * (g.mapX + 1) + x;
}

function objAt(g: PassGrid, x: number, y: number): number {
  if (x < 0 || x > g.mapX || y < 0 || y > g.mapY) return OBJ_NONE; // cannot happen for A* scans
  return g.obj[at(g, x, y)];
}

/** TileInMapCoords (KM_Terrain.pas 1137–1141): the usable box, border excluded. */
function inMapCoords(g: PassGrid, x: number, y: number): boolean {
  return x >= 1 && x <= g.mapX - 1 && y >= 1 && y <= g.mapY - 1;
}

/** tpWalk result for one tile: walkable terrain ∧ no blocking object ∧ height pass. */
export function tileWalkable(g: PassGrid, x: number, y: number): boolean {
  if (!inMapCoords(g, x, y)) return false;
  return g.walk[at(g, x, y)] === 1;
}

/** CheckHeightPass(aLoc, hpWalking) — KM_Terrain.pas 4866–4919, TestHeight(25). */
export function checkHeightPass(g: PassGrid, x: number, y: number): boolean {
  // As coded (4910–4912): out-of-map returns True (the caller's TileIsWalkable already fails).
  if (!inMapCoords(g, x, y)) return true;
  const x2 = Math.min(x + 1, g.mapX);
  const y2 = Math.min(y + 1, g.mapY);
  const p1 = g.height[at(g, x, y)]; // H(X, Y)
  const p2 = g.height[at(g, x2, y)]; // H(X2, Y)
  const p3 = g.height[at(g, x, y2)]; // H(X, Y2)
  const p4 = g.height[at(g, x2, y2)]; // H(X2, Y2)
  return (
    Math.abs(p1 - p2) < 25 && // side 1–2
    Math.abs(p3 - p4) < 25 && // side 3–4
    Math.abs(p3 - p1) < 25 && // side 3–1
    Math.abs(p4 - p2) < 50 && // side 4–2, twice as tolerant (4901)
    Math.abs(p1 - p4) < 25 && // diagonal 1–4
    Math.abs(p3 - p2) < 50 // diagonal 3–2, twice as tolerant (4905)
  );
}

/**
 * CanWalkDiagonally — KM_Terrain.pas 2150–2169, ported branch by branch including the
 * asymmetry: each branch tests the DiagonalBlocked flag of one particular corner tile.
 * Non-diagonal steps return True.
 */
export function canWalkDiagonal(
  g: PassGrid,
  from: { x: number; y: number },
  x: number,
  y: number,
): boolean {
  if (Math.abs(from.x - x) !== 1 || Math.abs(from.y - y) !== 1) return true;

  let obj: number;
  if (from.x < x && from.y < y) {
    obj = objAt(g, x, y); // Land[aY, aX]
  } else if (from.x < x && from.y > y) {
    obj = objAt(g, x, y + 1); // Land[aY+1, aX]
  } else if (from.x > x && from.y > y) {
    obj = objAt(g, from.x, from.y); // Land[from.Y, from.X]
  } else {
    obj = objAt(g, from.x, from.y + 1); // Land[from.Y+1, from.X]
  }
  return !g.elems[obj].diagonalBlocked;
}

/** Build the passability grid: copy Land fields, then precompute tpWalk for every usable tile. */
export function buildPassGrid(map: KaMap, tiles: TileFlags[], elems: MapElem[]): PassGrid {
  const { mapX, mapY } = map;
  const size = (mapX + 1) * (mapY + 1);
  const g: PassGrid = {
    mapX,
    mapY,
    walk: new Uint8Array(size),
    obj: new Uint8Array(size),
    height: new Uint8Array(size),
    elems,
    tiles,
  };

  for (let y = 1; y <= mapY; y++) {
    for (let x = 1; x <= mapX; x++) {
      const rec = (y - 1) * mapX + (x - 1); // file record for Land[X, Y]
      g.height[at(g, x, y)] = map.tiles[rec * 4 + 1];
      g.obj[at(g, x, y)] = map.tiles[rec * 4 + 3];
    }
  }

  for (let y = 1; y <= mapY - 1; y++) {
    for (let x = 1; x <= mapX - 1; x++) {
      const terrain = map.tiles[((y - 1) * mapX + (x - 1)) * 4];
      const flags = tiles[terrain];
      if (flags === undefined) {
        throw new Error(`buildPassGrid: tiles.json has no entry for terrain id ${terrain} at (${x},${y})`);
      }
      if (flags.walkable && !elems[g.obj[at(g, x, y)]].allBlocked && checkHeightPass(g, x, y)) {
        g.walk[at(g, x, y)] = 1;
      }
    }
  }
  return g;
}
