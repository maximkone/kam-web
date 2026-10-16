// sim.test.ts — tick order + walk orders (docs/M2B-SPIKE.md 2.5, 2.6): order applies next tick,
// moves + 2 tick counts, re-order mid-walk, unknown uid, demoSpawns.
// Run: node --test packages/sim/sim.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPassGrid } from './terrain.ts';
import type { PassGrid } from './terrain.ts';
import { Sim, demoSpawns } from './sim.ts';
import type { KaMap } from '../map/map.ts';
import type { MapElem } from '../assets/mapelem.ts';
import type { TileFlags } from '../assets/tiledata.ts';
import type { UnitSpec } from '../assets/unitdat.ts';

const TILES: TileFlags[] = [
  { walkable: true, roadable: true, corners: [0, 0, 0, 0] }, // 0 grass
  { walkable: false, roadable: false, corners: [0, 0, 0, 0] }, // 1 water
];

const SPECS: UnitSpec[] = [{ speedRaw: 24, anim: [] }]; // Sim only reads specs[type].speedRaw

function makeElems(): MapElem[] {
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
    });
  }
  return out;
}

function makeGrid(mapX: number, mapY: number, water: Set<string> = new Set()): PassGrid {
  const tiles = new Uint8Array(mapX * mapY * 4);
  for (let y = 1; y <= mapY; y++) {
    for (let x = 1; x <= mapX; x++) {
      tiles[((y - 1) * mapX + (x - 1)) * 4] = water.has(`${x},${y}`) ? 1 : 0;
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
  return buildPassGrid(map, TILES, makeElems());
}

function runToDone(sim: Sim, u: ReturnType<Sim['addUnit']>): number {
  let ticks = 0;
  while (ticks < 10000 && u.action === 'walk') {
    sim.tick();
    ticks += 1;
  }
  return ticks;
}

test('order applies at the end of the next tick (gicArmyWalk), movement starts the tick after', () => {
  const sim = new Sim(makeGrid(8, 8), SPECS);
  const u = sim.addUnit(0, 1, 1);
  assert.equal(u.action, 'stay');
  assert.equal(u.walk, null);
  assert.equal(sim.orderWalk(u.uid, 5, 1), true);
  assert.equal(u.action, 'stay'); // queued, not applied yet
  assert.equal(sim.tickCount, 0);

  sim.tick();
  assert.equal(sim.tickCount, 1);
  assert.equal(u.action, 'walk');
  assert.ok(u.walk !== null);
  assert.deepEqual(u.posF, { x: 1, y: 1 }); // the order tick does not move the unit
  assert.equal(u.dir, 0);

  sim.tick();
  assert.ok(Math.abs(u.posF.x - 1.1) < 1e-9); // first movement tick
});

test('a 4-tile ortho walk takes moves + 2 ticks (order tick + arrival tick)', () => {
  const sim = new Sim(makeGrid(8, 8), SPECS);
  const u = sim.addUnit(0, 1, 1);
  assert.equal(sim.orderWalk(u.uid, 5, 1), true);
  sim.tick(); // order applies here
  const rest = runToDone(sim, u);
  assert.equal(rest + 1, 42);
  assert.equal(sim.tickCount, 42);
  assert.equal(u.animStep, 40);
  assert.equal(u.dir, 3); // dirE
  assert.deepEqual(u.posF, { x: 5, y: 1 });
  assert.equal(u.action, 'stay');
  assert.equal(u.walk, null);
});

test('re-order mid-walk starts the new route from the node being walked to', () => {
  const sim = new Sim(makeGrid(8, 8), SPECS);
  const u = sim.addUnit(0, 1, 1);
  sim.orderWalk(u.uid, 5, 1);
  sim.tick(); // 1: order applies
  sim.tick(); // 2: x = 1.1
  sim.tick(); // 3: x = 1.2
  assert.ok(Math.abs(u.posF.x - 1.2) < 1e-9);
  assert.ok(u.walk !== null);
  assert.equal(u.walk.nodePos, 1);
  assert.deepEqual(u.walk.nodeList[u.walk.nodePos], { x: 2, y: 1 });

  assert.equal(sim.orderWalk(u.uid, 2, 3), true);
  sim.tick(); // 4: old walk moves, then the order applies from node (2,1)
  assert.ok(u.walk !== null);
  assert.deepEqual(u.walk.nodeList[0], { x: 2, y: 1 }); // the node being headed to, not posF
  assert.equal(u.walk.nodeList.length, 3);

  const rest = runToDone(sim, u);
  assert.equal(rest + 4, 32);
  assert.equal(u.animStep, 30);
  assert.equal(u.dir, 5); // dirS on the final segment
  assert.deepEqual(u.posF, { x: 2, y: 3 });
  assert.equal(u.action, 'stay');
});

test('unknown uid returns false and the tick stays safe', () => {
  const sim = new Sim(makeGrid(8, 8), SPECS);
  const u = sim.addUnit(0, 1, 1);
  assert.equal(sim.orderWalk(999, 2, 2), false);
  sim.tick();
  assert.equal(u.action, 'stay');
  assert.equal(sim.units.length, 1);
});

test('addUnit validates the unit.dat record index', () => {
  const sim = new Sim(makeGrid(8, 8), SPECS);
  assert.throws(() => sim.addUnit(1, 1, 1), /unit type must be a unit.dat record/);
  assert.throws(() => sim.addUnit(-1, 1, 1), /unit type must be a unit.dat record/);
  assert.equal(sim.addUnit(0, 1, 1).type, 0);
});

test('demoSpawns picks the frozen ring tiles on an open map and throws on water only', () => {
  const open = makeGrid(128, 128);
  assert.deepEqual(demoSpawns(open), [
    { type: 0, x: 64, y: 64 },
    { type: 14, x: 63, y: 63 },
    { type: 22, x: 64, y: 63 },
  ]);

  const water = makeGrid(8, 8, new Set(Array.from({ length: 64 }, (_, i) => `${(i % 8) + 1},${Math.floor(i / 8) + 1}`)));
  assert.throws(() => demoSpawns(water), /found only 0 walkable tiles/);
});
