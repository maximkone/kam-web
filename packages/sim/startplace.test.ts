// startplace.test.ts - the skirmish start of the maps whose start has no gold, iron or stone in reach
// (MapsMP Atoll, Equilibrium, Rain Season, Arena): each must start with a store and its road for hand 0.
// Reads the frozen r15472 install like tools/skirmish (KAM_INSTALL overrides); skipped when it is absent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createSkirmish, step } from './skirmish.ts';
import type { SkirmishDefines } from './skirmish.ts';
import { HT_STORE } from './ai.ts';

const INSTALL = process.env.KAM_INSTALL ?? 'C:/Users/me/Desktop/KaM Remake/KaM Remake Beta r15472';
const DEFINES = `${INSTALL}/data/defines`;
const MAPS = ['MapsMP/Atoll', 'MapsMP/Equilibrium', 'MapsMP/Rain Season', 'MapsMP/Arena'];
const HUMAN = 0;
const AI = 1;
const skip = existsSync(`${DEFINES}/tiles.json`) ? false : 'the KaM install is not present';

function defines(): SkirmishDefines {
  const read = (name: string): Buffer => readFileSync(`${DEFINES}/${name}`);
  return {
    tilesJson: read('tiles.json').toString('utf8'),
    mapElem: new Uint8Array(read('mapelem.dat')),
    unitDat: new Uint8Array(read('unit.dat')),
    housesDat: new Uint8Array(read('houses.dat')),
  };
}

for (const map of MAPS) {
  test(`start: ${map} starts with a store and its road for the human hand`, { skip }, () => {
    const base = `${INSTALL}/${map}/${map.slice(map.indexOf('/') + 1)}`;
    const sk = createSkirmish({
      mapBytes: new Uint8Array(readFileSync(`${base}.map`)),
      mapPath: `${base}.map`,
      missionDat: new Uint8Array(readFileSync(`${base}.dat`)),
      defines: defines(),
      seed: 1,
      slots: [
        { hand: HUMAN, kind: 'human' },
        { hand: AI, kind: 'ai' },
      ],
    });
    const w = sk.world;
    const store = w.findFirstHouse(HT_STORE, HUMAN);
    assert.ok(store !== null, 'hand 0 has a store');
    assert.ok(w.isRoadTile(store.entrance.x, store.entrance.y + 1), 'the store has its road below the entrance');
    for (let i = 0; i < 100; i++) step(sk, []);
    assert.equal(sk.world.tickCount, 100);
    assert.ok(w.findFirstHouse(HT_STORE, HUMAN) !== null, 'the store is still there after 100 ticks');
  });
}

for (const map of MAPS) {
  test(`start: ${map} starts with the AI rich start (aiStart normal) and runs 100 ticks`, { skip }, () => {
    const base = `${INSTALL}/${map}/${map.slice(map.indexOf('/') + 1)}`;
    const sk = createSkirmish({
      mapBytes: new Uint8Array(readFileSync(`${base}.map`)),
      mapPath: `${base}.map`,
      missionDat: new Uint8Array(readFileSync(`${base}.dat`)),
      defines: defines(),
      seed: 1,
      slots: [
        { hand: HUMAN, kind: 'human' },
        { hand: AI, kind: 'ai', aiStart: 'normal' },
      ],
    });
    assert.ok(sk.world.findFirstHouse(HT_STORE, AI) !== null, 'the AI hand has a store');
    for (let i = 0; i < 100; i++) step(sk, []);
    assert.equal(sk.world.tickCount, 100);
  });
}
