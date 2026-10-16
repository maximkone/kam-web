// walk.test.ts — walk action tick math (docs/M2B-SPIKE.md 2.4): 10/11 and 14/15 tick cases, the
// direction bucket table, walkSpeeds, Delphi banker's rounding, duplicate-node skip, guards.
// Run: node --test packages/sim/walk.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPassGrid } from './terrain.ts';
import type { PassGrid } from './terrain.ts';
import { delphiRound, kmGetDirection, startWalk, walkSpeeds, walkTick } from './walk.ts';
import type { Walk } from './walk.ts';
import type { KaMap } from '../map/map.ts';
import type { MapElem } from '../assets/mapelem.ts';
import type { TileFlags } from '../assets/tiledata.ts';

const TILES: TileFlags[] = [{ walkable: true, roadable: true, corners: [0, 0, 0, 0] }];

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

function makeGrid(mapX: number, mapY: number): PassGrid {
  const tiles = new Uint8Array(mapX * mapY * 4);
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

function makeWalk(nodes: { x: number; y: number }[], walkFrom = nodes[0], walkTo = nodes[nodes.length - 1]): Walk {
  return { nodeList: nodes, nodePos: 0, walkFrom, walkTo, done: false, aborted: false };
}

interface RunResult {
  ticks: number;
  moves: number;
  dirs: number[];
  posF: { x: number; y: number };
}

function run(g: PassGrid, w: Walk, start: { x: number; y: number }, speedRaw: number): RunResult {
  const posF = { x: start.x, y: start.y };
  const speed = walkSpeeds(speedRaw);
  const dirs: number[] = [];
  let ticks = 0;
  let moves = 0;
  for (;;) {
    const r = walkTick(g, w, posF, speed);
    ticks += 1;
    moves += r.animStep;
    dirs.push(r.dir);
    if (r.status !== 'walking') break;
    if (ticks > 1000) throw new Error('walkTick did not finish');
  }
  return { ticks, moves, dirs, posF };
}

test('ortho step at speed 24: 10 moves, done on the 11th tick', () => {
  const g = makeGrid(4, 4);
  const r = run(g, makeWalk([{ x: 0, y: 0 }, { x: 1, y: 0 }]), { x: 0, y: 0 }, 24);
  assert.equal(r.ticks, 11);
  assert.equal(r.moves, 10);
  assert.deepEqual(r.posF, { x: 1, y: 0 }); // snapped on arrival
  assert.deepEqual(r.dirs.slice(0, 10), [3, 3, 3, 3, 3, 3, 3, 3, 3, 3]); // dirE each moved tick
  assert.equal(r.dirs[10], 0); // done tick: no direction update
});

test('diagonal step at speed 24: 14 moves, done on the 15th tick', () => {
  const g = makeGrid(4, 4);
  const r = run(g, makeWalk([{ x: 0, y: 0 }, { x: 1, y: 1 }]), { x: 0, y: 0 }, 24);
  assert.equal(r.ticks, 15);
  assert.equal(r.moves, 14);
  assert.deepEqual(r.posF, { x: 1, y: 1 });
  assert.deepEqual(r.dirs.slice(0, 14), [4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4]); // dirSE
  assert.equal(r.dirs[14], 0);
});

test('corner walk returns the current segment direction: dirE 10 ticks, then dirS 10 ticks', () => {
  const g = makeGrid(4, 4);
  const r = run(g, makeWalk([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }]), { x: 0, y: 0 }, 24);
  assert.equal(r.ticks, 21);
  assert.equal(r.moves, 20);
  assert.deepEqual(r.posF, { x: 1, y: 1 });
  assert.deepEqual(r.dirs.slice(0, 10), Array(10).fill(3));
  assert.deepEqual(r.dirs.slice(10, 20), Array(10).fill(5));
  assert.equal(r.dirs[20], 0);
});

test('walkSpeeds: 24 → 1/10 & 1/14, 39 → 1/6 & 1/9, 40 → 1/6 & 1/8', () => {
  assert.deepEqual(walkSpeeds(24), { ortho: 0.1, diag: 1 / 14 });
  assert.deepEqual(walkSpeeds(39), { ortho: 1 / 6, diag: 1 / 9 });
  assert.deepEqual(walkSpeeds(40), { ortho: 1 / 6, diag: 1 / 8 });
});

test('delphiRound rounds half to even (Delphi Round)', () => {
  assert.equal(delphiRound(0.5), 0);
  assert.equal(delphiRound(1.5), 2);
  assert.equal(delphiRound(2.5), 2);
  assert.equal(delphiRound(3.5), 4);
  assert.equal(delphiRound(-0.5), 0);
  assert.equal(delphiRound(-1.5), -2);
  assert.equal(delphiRound(-2.5), -2);
  assert.equal(delphiRound(2.49), 2);
  assert.equal(delphiRound(2.51), 3);
});

test('kmGetDirection buckets (dirN 1 .. dirNW 8, dirNA 0)', () => {
  assert.equal(kmGetDirection(0, 0), 0);
  assert.equal(kmGetDirection(0, -1), 1); // N
  assert.equal(kmGetDirection(1, -1), 2); // NE
  assert.equal(kmGetDirection(1, 0), 3); // E
  assert.equal(kmGetDirection(1, 1), 4); // SE
  assert.equal(kmGetDirection(0, 1), 5); // S
  assert.equal(kmGetDirection(-1, 1), 6); // SW
  assert.equal(kmGetDirection(-1, 0), 7); // W
  assert.equal(kmGetDirection(-1, -1), 8); // NW
});

test('guards: same tile completes, empty route aborts, single node completes', () => {
  const g = makeGrid(4, 4);
  const speed = walkSpeeds(24);

  const same = makeWalk([{ x: 1, y: 1 }], { x: 1, y: 1 }, { x: 1, y: 1 });
  assert.deepEqual(walkTick(g, same, { x: 1, y: 1 }, speed), { dir: 0, animStep: 0, status: 'done' });
  assert.equal(same.done, true);

  const empty = makeWalk([]);
  empty.walkFrom = { x: 1, y: 1 };
  empty.walkTo = { x: 2, y: 2 };
  assert.deepEqual(walkTick(g, empty, { x: 1, y: 1 }, speed), { dir: 0, animStep: 0, status: 'aborted' });
  assert.equal(empty.aborted, true);

  const single = makeWalk([{ x: 1, y: 1 }], { x: 1, y: 1 }, { x: 2, y: 2 });
  assert.deepEqual(walkTick(g, single, { x: 1, y: 1 }, speed), { dir: 0, animStep: 0, status: 'done' });

  const doneTick = walkTick(g, same, { x: 1, y: 1 }, speed); // repeated call stays 'done'
  assert.deepEqual(doneTick, { dir: 0, animStep: 0, status: 'done' });
});

test('duplicate node is skipped without a move (Inc nodePos, return walking)', () => {
  const g = makeGrid(4, 4);
  const speed = walkSpeeds(24);
  const w = makeWalk([{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 0 }], { x: 0, y: 0 }, { x: 1, y: 0 });
  const posF = { x: 0, y: 0 };

  const t1 = walkTick(g, w, posF, speed);
  assert.deepEqual(t1, { dir: 0, animStep: 0, status: 'walking' });
  assert.equal(w.nodePos, 1);
  assert.deepEqual(posF, { x: 0, y: 0 }); // no move

  const t2 = walkTick(g, w, posF, speed);
  assert.deepEqual(t2, { dir: 3, animStep: 1, status: 'walking' });
  assert.equal(w.nodePos, 2);
  assert.ok(Math.abs(posF.x - 0.1) < 1e-9);
  assert.equal(posF.y, 0);
});

test('startWalk builds a dense route; null when unreachable; single node for from = to', () => {
  const g = makeGrid(4, 4);
  const w = startWalk(g, { x: 1, y: 1 }, { x: 3, y: 1 });
  assert.notEqual(w, null);
  const walk = w as Walk;
  assert.deepEqual(walk.nodeList, [
    { x: 1, y: 1 },
    { x: 2, y: 1 },
    { x: 3, y: 1 },
  ]);
  assert.deepEqual(walk.walkFrom, { x: 1, y: 1 });
  assert.deepEqual(walk.walkTo, { x: 3, y: 1 });
  assert.equal(walk.done, false);
  assert.equal(walk.aborted, false);

  assert.equal(startWalk(g, { x: 1, y: 1 }, { x: 4, y: 4 }), null); // border target, unwalkable

  const stay = startWalk(g, { x: 2, y: 2 }, { x: 2, y: 2 });
  assert.notEqual(stay, null);
  assert.equal((stay as Walk).nodeList.length, 1);
});
