// fowrefresh.test.ts - the DynamicFOW refresh of standing units and finished houses (KM_Units.pas 2610, KM_Houses.pas 2205).
// Duck-typed world: refreshFog only reads tickCount, houses, units, fow, houseSpecs, houseCells and unitSpecs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FOW_PACE } from './combat.ts';
import { refreshFog } from './fowrefresh.ts';
import type { EconomyWorld } from './economy.ts';

interface Call { x: number; y: number; radius: number; max: boolean }

function fakeWorld(tick: number): { w: EconomyWorld; calls: Call[][] } {
  const calls: Call[][] = [[], []];
  const fogOf = (hand: number) => ({ reveal: (x: number, y: number, radius: number, max: boolean) => { calls[hand]!.push({ x, y, radius, max }); } });
  const w = {
    tickCount: tick,
    fow: [fogOf(0), fogOf(1)],
    houseSpecs: { 11: { sight: 13 } },
    unitSpecs: { 0: { sight: 4 } },
    houseCells: (h: { x: number; y: number }) => [{ x: h.x, y: h.y }, { x: h.x + 1, y: h.y }],
    houses: [
      { uid: 10, owner: 0, typeId: 11, x: 5, y: 5, buildState: 'done', destroyed: false },
      { uid: 20, owner: 0, typeId: 11, x: 9, y: 9, buildState: 'wood', destroyed: false },
      { uid: 30, owner: 0, typeId: 11, x: 12, y: 12, buildState: 'done', destroyed: true },
    ],
    units: [
      { uid: 4, owner: 1, type: 0, posF: { x: 7.4, y: 8.6 }, dead: false },
      { uid: 5, owner: 1, type: 0, posF: { x: 1, y: 1 }, dead: true },
    ],
  } as unknown as EconomyWorld;
  return { w, calls };
}

test('a finished house reveals every footprint cell with its sight, once per FOW_PACE', () => {
  const tickOk = FOW_PACE * 3 - (10 % FOW_PACE); // (tick + uid 10) % FOW_PACE === 0
  const { w, calls } = fakeWorld(tickOk);
  refreshFog(w);
  assert.deepEqual(calls[0], [{ x: 5, y: 5, radius: 13, max: false }, { x: 6, y: 5, radius: 13, max: false }]);
  const off = fakeWorld(tickOk + 1);
  refreshFog(off.w);
  assert.equal(off.calls[0]!.length, 0, 'between paces nothing is revealed');
});

test('houses under construction and destroyed houses are skipped (construction has its own refresh)', () => {
  for (let t = 0; t < FOW_PACE * 3; t++) {
    const { w, calls } = fakeWorld(t);
    refreshFog(w);
    for (const c of calls[0]!) assert.ok(c.x === 5 || c.x === 6, `only the finished house's cells (got x=${c.x})`);
  }
});

test('a live unit reveals its rounded tile with its sight for ITS OWNER; a dead unit does not', () => {
  const tickOk = FOW_PACE * 2 - (4 % FOW_PACE);
  const { w, calls } = fakeWorld(tickOk);
  refreshFog(w);
  assert.deepEqual(calls[1], [{ x: 7, y: 9, radius: 4, max: false }]);
  assert.equal(calls[0]!.filter((c) => c.radius === 4).length, 0, 'the unit never reveals for another hand');
});

test('over one full pace every live object is refreshed exactly once', () => {
  let houseHits = 0;
  let unitHits = 0;
  for (let t = 100; t < 100 + FOW_PACE; t++) {
    const { w, calls } = fakeWorld(t);
    refreshFog(w);
    houseHits += calls[0]!.filter((c) => c.radius === 13 && c.x === 5).length;
    unitHits += calls[1]!.length;
  }
  assert.equal(houseHits, 1);
  assert.equal(unitHits, 1);
});
