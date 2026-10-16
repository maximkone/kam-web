// astar.test.ts — synthetic mini-map route tests (docs/M2B-SPIKE.md 4.4): the 10/14 metric prefers
// the orthogonal-heavy route among equal tile-length routes, DiagonalBlocked forces a detour,
// height wall unreachable, unwalkable start/dest/border → null.
// Run: node --test packages/sim/astar.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPassGrid, canWalkDiagonal, tileWalkable } from './terrain.ts';
import type { PassGrid } from './terrain.ts';
import { findPath } from './astar.ts';
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

interface Pt {
  x: number;
  y: number;
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

function routeStats(route: Pt[]): { steps: number; ortho: number; diag: number; cost: number } {
  let ortho = 0;
  let diag = 0;
  for (let i = 1; i < route.length; i++) {
    const dx = Math.abs(route[i].x - route[i - 1].x);
    const dy = Math.abs(route[i].y - route[i - 1].y);
    if (dx === 1 && dy === 1) diag += 1;
    else ortho += 1;
  }
  return { steps: route.length - 1, ortho, diag, cost: ortho * 10 + diag * 14 };
}

test('10/14 metric prefers the orthogonal-heavy route among equal tile-length routes', () => {
  const open = new Set(['2,2', '3,2', '4,2', '5,2', '6,2', '3,3', '4,4', '5,3']);
  const g = makeGrid(8, 8, (x, y) => (open.has(`${x},${y}`) ? GRASS : WATER));
  const route = findPath(g, { x: 2, y: 2 }, { x: 6, y: 2 });
  assert.deepEqual(route, [
    { x: 2, y: 2 },
    { x: 3, y: 2 },
    { x: 4, y: 2 },
    { x: 5, y: 2 },
    { x: 6, y: 2 },
  ]);
  assert.deepEqual(routeStats(route as Pt[]), { steps: 4, ortho: 4, diag: 0, cost: 40 });

  // the equal-length zigzag via (3,3),(4,4),(5,3) is 4 diagonal steps, cost 56
  const legs: [Pt, Pt][] = [
    [{ x: 2, y: 2 }, { x: 3, y: 3 }],
    [{ x: 3, y: 3 }, { x: 4, y: 4 }],
    [{ x: 4, y: 4 }, { x: 5, y: 3 }],
    [{ x: 5, y: 3 }, { x: 6, y: 2 }],
  ];
  let altCost = 0;
  for (const [from, to] of legs) {
    const leg = findPath(g, from, to);
    assert.notEqual(leg, null);
    assert.equal(routeStats(leg as Pt[]).diag, 1);
    altCost += routeStats(leg as Pt[]).cost;
  }
  assert.equal(altCost, 56);
  assert.ok(routeStats(route as Pt[]).cost < altCost);
});

test('DiagonalBlocked corner forbids the diagonal but the ortho detour exists', () => {
  const g = makeGrid(5, 5, (x, y) => (x === 3 && y === 3 ? { terrain: 0, height: 0, obj: 5 } : GRASS), {
    5: { diagonalBlocked: true },
  });
  assert.equal(canWalkDiagonal(g, { x: 2, y: 2 }, 3, 3), false);
  const route = findPath(g, { x: 2, y: 2 }, { x: 3, y: 3 });
  assert.deepEqual(route, [
    { x: 2, y: 2 },
    { x: 3, y: 2 },
    { x: 3, y: 3 },
  ]); // via (3,2)
  assert.deepEqual(routeStats(route as Pt[]), { steps: 2, ortho: 2, diag: 0, cost: 20 });
});

test('height wall splits the map: same side routes, cross-wall null', () => {
  const g = makeGrid(5, 5, (x) => ({ terrain: 0, height: x === 3 ? 30 : 0, obj: 255 }));
  assert.equal(tileWalkable(g, 1, 1), true);
  assert.equal(tileWalkable(g, 4, 1), true);
  assert.equal(findPath(g, { x: 1, y: 1 }, { x: 4, y: 1 }), null);
  assert.notEqual(findPath(g, { x: 1, y: 1 }, { x: 1, y: 4 }), null); // same side still routes
});

test('unwalkable start / dest / border → null; route is dense start..end inclusive', () => {
  const g = makeGrid(5, 5, (x, y) => ((x === 1 && y === 1) || (x === 2 && y === 2) ? WATER : GRASS));
  assert.equal(findPath(g, { x: 1, y: 1 }, { x: 3, y: 3 }), null); // start gate (line 92)
  assert.equal(findPath(g, { x: 1, y: 2 }, { x: 2, y: 2 }), null); // destination water
  assert.equal(findPath(g, { x: 1, y: 2 }, { x: 5, y: 2 }), null); // border column not usable
  assert.equal(findPath(g, { x: 0, y: 0 }, { x: 3, y: 3 }), null); // outside the box

  const route = findPath(g, { x: 3, y: 1 }, { x: 4, y: 4 });
  assert.notEqual(route, null);
  const r = route as Pt[];
  assert.deepEqual(r[0], { x: 3, y: 1 });
  assert.deepEqual(r[r.length - 1], { x: 4, y: 4 });
  for (let i = 1; i < r.length; i++) {
    const dx = Math.abs(r[i].x - r[i - 1].x);
    const dy = Math.abs(r[i].y - r[i - 1].y);
    assert.ok(dx <= 1 && dy <= 1 && dx + dy > 0, `dense step ${JSON.stringify(r[i - 1])} -> ${JSON.stringify(r[i])}`);
  }
});
