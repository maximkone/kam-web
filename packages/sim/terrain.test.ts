// terrain.test.ts — synthetic mini-map rule tests (docs/M2B-SPIKE.md 4.4): water blocks, AllBlocked
// objects block, the height wall, border/out-of-map, DiagonalBlocked corners.
// Run: node --test packages/sim/terrain.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPassGrid, canWalkDiagonal, checkHeightPass, tileWalkable } from './terrain.ts';
import type { PassGrid } from './terrain.ts';
import type { KaMap } from '../map/map.ts';
import type { MapElem } from '../assets/mapelem.ts';
import type { TileFlags } from '../assets/tiledata.ts';

const GRASS: Cell = { terrain: 0, height: 0, obj: 255 };
const WATER: Cell = { terrain: 1, height: 0, obj: 255 };

const TILES: TileFlags[] = [
  { walkable: true, roadable: true, corners: [0, 0, 0, 0] }, // 0 grass
  { walkable: false, roadable: false, corners: [0, 0, 0, 0] }, // 1 water
];

interface Cell {
  terrain: number;
  height: number;
  obj: number;
}

function makeElems(overrides: Record<number, Partial<MapElem>> = {}): MapElem[] {
  const out: MapElem[] = [];
  for (let i = 0; i < 256; i++) {
    out.push({
      cuttableTree: false,
      diagonalBlocked: false,
      allBlocked: false,
      wineOrCorn: false,
      canGrow: false,
      dontPlantNear: false,
      stump: 0,
      canBeRemoved: false,
      ...(overrides[i] ?? {}),
    });
  }
  return out;
}

function makeGrid(
  mapX: number,
  mapY: number,
  cell: (x: number, y: number) => Cell,
  elemOverrides: Record<number, Partial<MapElem>> = {},
): PassGrid {
  const tiles = new Uint8Array(mapX * mapY * 4);
  for (let y = 1; y <= mapY; y++) {
    for (let x = 1; x <= mapX; x++) {
      const c = cell(x, y);
      const o = ((y - 1) * mapX + (x - 1)) * 4;
      tiles[o] = c.terrain;
      tiles[o + 1] = c.height;
      tiles[o + 3] = c.obj;
    }
  }
  const map: KaMap = {
    file: 'mini',
    mapX,
    mapY,
    tiles,
    remake: false,
    tail: { resHead: null, mapEdChunk: false, tailBytes: 0 },
  };
  return buildPassGrid(map, TILES, makeElems(elemOverrides));
}

test('tiles.json Walkable: grass is walkable, water blocks the tile', () => {
  const g = makeGrid(5, 5, (x, y) => (x === 2 && y === 2 ? WATER : GRASS));
  assert.equal(tileWalkable(g, 1, 1), true);
  assert.equal(tileWalkable(g, 2, 2), false);
  assert.equal(tileWalkable(g, 3, 3), true);
});

test('an AllBlocked object blocks the tile; obj 255 (none) does not', () => {
  const g = makeGrid(5, 5, (x, y) => (x === 2 && y === 2 ? { terrain: 0, height: 0, obj: 61 } : GRASS), {
    61: { allBlocked: true },
  });
  assert.equal(tileWalkable(g, 2, 2), false);
  assert.equal(tileWalkable(g, 1, 1), true);
});

test('height wall: a ≥25 corner step fails CheckHeightPass and blocks both flanking columns', () => {
  const g = makeGrid(5, 5, (x) => ({ terrain: 0, height: x === 3 ? 30 : 0, obj: 255 }));
  // the raised column x=3 makes both x=2 and x=3 fail (each reads the 30 next to a 0)
  assert.equal(checkHeightPass(g, 2, 2), false);
  assert.equal(checkHeightPass(g, 1, 2), true);
  assert.equal(checkHeightPass(g, 4, 2), true);
  assert.equal(tileWalkable(g, 2, 2), false);
  assert.equal(tileWalkable(g, 3, 2), false);
  assert.equal(tileWalkable(g, 1, 2), true);
  assert.equal(tileWalkable(g, 4, 2), true);
});

test('border row/col and everything outside are unwalkable; CheckHeightPass is true out of map (as-coded)', () => {
  const g = makeGrid(5, 5, () => GRASS);
  assert.equal(tileWalkable(g, 5, 2), false); // usable box is 1..mapX-1
  assert.equal(tileWalkable(g, 2, 5), false);
  assert.equal(tileWalkable(g, 0, 0), false);
  assert.equal(checkHeightPass(g, 0, 0), true); // caller's TileIsWalkable already fails
});

test('all four diagonal moves of a 2×2 square consult the DiagonalBlocked flag of the SE corner', () => {
  // square (1..2, 1..2): SE corner (2,2)
  const blocked = makeGrid(5, 5, (x, y) => (x === 2 && y === 2 ? { terrain: 0, height: 0, obj: 5 } : GRASS), {
    5: { diagonalBlocked: true },
  });
  assert.equal(tileWalkable(blocked, 2, 2), true); // diagonalBlocked does not block the tile itself
  assert.equal(canWalkDiagonal(blocked, { x: 1, y: 1 }, 2, 2), false); // NW -> SE
  assert.equal(canWalkDiagonal(blocked, { x: 2, y: 2 }, 1, 1), false); // SE -> NW
  assert.equal(canWalkDiagonal(blocked, { x: 2, y: 1 }, 1, 2), false); // NE -> SW
  assert.equal(canWalkDiagonal(blocked, { x: 1, y: 2 }, 2, 1), false); // SW -> NE
  // a neighbouring square (2..3, 1..2, SE corner (3,2)) is unaffected
  assert.equal(canWalkDiagonal(blocked, { x: 2, y: 1 }, 3, 2), true);
  assert.equal(canWalkDiagonal(blocked, { x: 3, y: 2 }, 2, 1), true);

  // same square with obj 255: all four moves allowed
  const open = makeGrid(5, 5, () => GRASS);
  assert.equal(canWalkDiagonal(open, { x: 1, y: 1 }, 2, 2), true);
  assert.equal(canWalkDiagonal(open, { x: 2, y: 2 }, 1, 1), true);
  assert.equal(canWalkDiagonal(open, { x: 2, y: 1 }, 1, 2), true);
  assert.equal(canWalkDiagonal(open, { x: 1, y: 2 }, 2, 1), true);

  // second square (2..3, 2..3), SE corner (3,3): same rule
  const blocked2 = makeGrid(5, 5, (x, y) => (x === 3 && y === 3 ? { terrain: 0, height: 0, obj: 5 } : GRASS), {
    5: { diagonalBlocked: true },
  });
  assert.equal(canWalkDiagonal(blocked2, { x: 2, y: 2 }, 3, 3), false);
  assert.equal(canWalkDiagonal(blocked2, { x: 3, y: 3 }, 2, 2), false);
  assert.equal(canWalkDiagonal(blocked2, { x: 3, y: 2 }, 2, 3), false);
  assert.equal(canWalkDiagonal(blocked2, { x: 2, y: 3 }, 3, 2), false);
});

test('canWalkDiagonal returns true for non-diagonal steps', () => {
  const blocked = makeGrid(5, 5, (x, y) => (x === 2 && y === 2 ? { terrain: 0, height: 0, obj: 5 } : GRASS), {
    5: { diagonalBlocked: true },
  });
  assert.equal(canWalkDiagonal(blocked, { x: 1, y: 1 }, 2, 1), true);
  assert.equal(canWalkDiagonal(blocked, { x: 1, y: 1 }, 1, 2), true);
});
