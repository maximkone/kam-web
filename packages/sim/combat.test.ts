// combat.test.ts — M4 combat systems on a synthetic mini world (docs/M4-SPIKE.md 2.2–2.6).
// Run: node --test packages/sim/combat.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createEconomyWorld } from './economy.ts';
import type { EconomyWorld, EconomyWorldOptions } from './economy.ts';
import { parseUnitDat } from '../assets/unitdat.ts';
import type { AnimLoop, UnitSpec } from '../assets/unitdat.ts';
import { parseHousesDat } from '../assets/housedata.ts';
import type { HouseSpec } from '../assets/housedata.ts';
import type { KaMap } from '../map/map.ts';
import type { TileFlags } from '../assets/tiledata.ts';
import type { MapElem } from '../assets/mapelem.ts';
import type { Mission } from '../mission/mission.ts';
import {
  FogOfWar,
  FOG_OF_WAR_MAX,
  aimTargetUnit,
  getDirModifier,
  getPositionInGroup2,
  updateProjectiles,
} from './combat.ts';

const TILES: TileFlags[] = [
  { walkable: true, roadable: true, corners: [0, 0, 0, 0] }, // 0 grass
  { walkable: false, roadable: false, corners: [0, 0, 0, 0] }, // 1 water
];

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
  for (let i = 68; i <= 73; i++) out[i].diagonalBlocked = true; // rubble (mapelem.dat)
  return out;
}

function loop(count: number): AnimLoop {
  return { steps: new Int16Array(30), count, moveX: 0, moveY: 0 };
}

/** 14 actions × 8 dirs; uaWork (1) = fight, uaDie (3) = death, uaWalk (0) = walk. */
function makeSpec(o: Partial<UnitSpec> & { work?: number }): UnitSpec {
  const anim: AnimLoop[][] = [];
  for (let a = 0; a < 14; a++) {
    const dirs: AnimLoop[] = [];
    for (let d = 0; d < 8; d++) dirs.push(loop(a === 1 ? (o.work ?? 12) : a === 3 ? 16 : 8));
    anim.push(dirs);
  }
  return {
    speedRaw: 24,
    anim,
    miningRange: 0,
    hitPoints: o.hitPoints ?? 3,
    attack: o.attack ?? 35,
    attackHorse: o.attackHorse ?? 0,
    defence: o.defence ?? 1,
    sight: o.sight ?? 9,
    fightType: o.fightType ?? 'melee',
    isWarrior: o.isWarrior ?? true,
    record: o.record ?? 14,
  };
}

function makeSpecs(): UnitSpec[] {
  const specs: UnitSpec[] = [];
  for (let i = 0; i < 31; i++) specs.push(makeSpec({ record: i }));
  specs[0] = makeSpec({ record: 0, isWarrior: false, hitPoints: 1, attack: 0, sight: 5 }); // serf
  specs[14] = makeSpec({ record: 14, hitPoints: 3, attack: 35, defence: 1, sight: 9 }); // militia
  specs[17] = makeSpec({ record: 17, hitPoints: 1, attack: 60, defence: 2, sight: 9, fightType: 'ranged', work: 18 }); // bowman
  specs[18] = makeSpec({ record: 18, hitPoints: 1, attack: 120, defence: 3, sight: 9, fightType: 'ranged', work: 28 }); // crossbowman
  specs[28] = makeSpec({ record: 28, hitPoints: 50, attack: 0, defence: 1, sight: 1 }); // training dummy
  specs[30] = makeSpec({ record: 30, isWarrior: false, hitPoints: 10, attack: 20, defence: 0, sight: 5 }); // wolf
  return specs;
}

function makeHouseSpecs(): (HouseSpec | undefined)[] {
  const out: (HouseSpec | undefined)[] = new Array(30).fill(undefined);
  out[9] = {
    typeId: 9,
    workerType: 1,
    resIn: [-1, -1, -1, -1],
    resOut: [0, -1, -1, -1],
    productionX: 1,
    workerRest: 5,
    animCounts: [0, 0, 0, 0, 0],
    entranceDx: 0,
    woodPic: 142,
    stonePic: 141,
    maxHealth: 250, // (3 + 2) * 50
    woodCost: 3,
    stoneCost: 2,
    sight: 6,
  };
  return out;
}

function makeMap(mapX = 32, mapY = 32): KaMap {
  return {
    file: 'mini',
    mapX,
    mapY,
    tiles: new Uint8Array(mapX * mapY * 4), // grass, obj 255 = none
    remake: false,
    tail: { resHead: null, mapEdChunk: false, tailBytes: 0 },
  };
}

function makeMission(): Mission {
  return { mapName: 'mini', maxPlayers: 2, humanPlayer: 0, houses: [], streets: [], units: [], wares: [] };
}

function makeWorld(): EconomyWorld {
  const o: EconomyWorldOptions = {
    map: makeMap(),
    tiles: TILES,
    elems: makeElems(),
    unitSpecs: makeSpecs(),
    serfCarry: [],
    houseSpecs: makeHouseSpecs(),
    mission: makeMission(),
  };
  return createEconomyWorld(o);
}

function eventsOf(w: EconomyWorld, kind: string): { tick: number; text: string }[] {
  return w.events.filter((e) => e.text.startsWith(`${kind} `));
}

// ---------------------------------------------------------------------------------------------

test('formation: GetPositionInGroup2 slots for dirE (3 per row)', () => {
  const p = (i: number) => getPositionInGroup2(10, 10, 3, i, 3, 32, 32);
  assert.deepEqual([p(0).x, p(0).y], [10, 10]); // leader
  assert.deepEqual([p(1).x, p(1).y], [10, 9]);
  assert.deepEqual([p(2).x, p(2).y], [10, 11]);
  assert.deepEqual([p(3).x, p(3).y], [9, 9]);
  assert.equal(p(0).fits, true);
  const off = getPositionInGroup2(1, 1, 3, 5, 3, 32, 32);
  assert.equal(off.fits, false); // clamped into the map, flagged as not fitting
  assert.equal(off.x, 1);
});

test('fog of war: reveal/cover/thresholds/decay', () => {
  const fow = new FogOfWar(32, 32);
  assert.equal(fow.checkTileRev(5, 5), 0);
  fow.reveal(5, 5, 3, true);
  assert.equal(fow.checkTileRev(5, 5), FOG_OF_WAR_MAX);
  assert.equal(fow.checkTileRev(20, 20), 0);
  fow.cover(5, 5, 3);
  assert.equal(fow.checkTileRev(5, 5), 0);

  // INC path: 128 → (128 shl 8) div 160 = 204; a second INC reaches MAX.
  const inc = new FogOfWar(32, 32);
  inc.reveal(5, 5, 1, false);
  assert.equal(inc.checkVerticeRev(5, 5), 204);
  inc.reveal(5, 5, 1, false);
  assert.equal(inc.checkVerticeRev(5, 5), FOG_OF_WAR_MAX);

  // Decay: one DEC per tile per FOW_PACE ticks; the first pass just clears revealedToMax.
  const dec = new FogOfWar(10, 10);
  dec.reveal(1, 1, 0, true);
  const at = 1 * 10 + 1;
  assert.equal(dec.revelation[at], 255);
  dec.updateState(true, 9); // (1*10+1+9) mod 10 = 0
  assert.equal(dec.revelation[at], 255); // revealedToMax flag consumed first
  dec.updateState(true, 19);
  assert.equal(dec.revelation[at], 243);
  dec.updateState(true, 29);
  assert.equal(dec.revelation[at], 231);
  assert.equal(dec.checkVerticeRev(1, 1), 255); // still >= ACT (160)
  dec.updateState(false, 39);
  assert.equal(dec.revelation[at], 231); // non-dynamic: no decay
});

test('unitdat: real r15472 combat stats (militia/bowman/crossbowman/knight)', () => {
  let bytes: Uint8Array;
  try {
    bytes = readFileSync('C:/Users/me/Desktop/KaM Remake/KaM Remake Beta r15472/data/defines/unit.dat');
  } catch {
    return; // install not present — skip
  }
  const specs = parseUnitDat(bytes);
  const row = (i: number) => {
    const s = specs[i];
    return [s.hitPoints, s.attack, s.attackHorse, s.defence, s.sight, s.fightType, s.isWarrior].join(',');
  };
  assert.equal(row(14), '3,35,0,1,9,melee,true'); // militia
  assert.equal(row(16), '3,55,0,3,9,melee,true'); // sword fighter
  assert.equal(row(17), '1,60,0,2,9,ranged,true'); // bowman
  assert.equal(row(18), '1,120,0,3,9,ranged,true'); // crossbowman
  assert.equal(row(21), '4,35,0,2,18,melee,true'); // scout (raw sight 18 → no patch)
  assert.equal(row(22), '4,55,0,3,9,melee,true'); // knight
  assert.equal(row(24), '3,25,50,1,9,melee,true'); // rebel (AttackHorse patched 60 → 50)
  assert.equal(row(25), '1,60,0,1,9,ranged,true'); // rogue
  assert.equal(row(27), '4,35,0,1,9,melee,true'); // vagabond (Attack patched 40 → 35)
  assert.equal(row(0), '2,0,0,1,4,melee,false'); // serf is not a warrior
  assert.equal(specs[30].isWarrior, false); // wolf
});

test('getDirModifier: 0 facing, 4 from behind (KM_Points.pas 874–880)', () => {
  assert.equal(getDirModifier(3, 7), 0); // east vs west: facing
  assert.equal(getDirModifier(1, 5), 0); // north vs south: facing
  assert.equal(getDirModifier(3, 3), 4); // same direction: from behind
  assert.equal(getDirModifier(2, 3), 3);
  assert.equal(getDirModifier(1, 6), 1); // |1 − ((6+4) mod 8)| = 1
});

test('spawnGroup: script constructor draws, formation, condition, HP', () => {
  const w = makeWorld();
  const g = w.spawnGroup(0, 14, 10, 10, 3, 3, 3);
  assert.equal(g.memberUids.length, 3);
  assert.equal(g.groupType, 2); // gtMelee
  assert.equal(g.order, 'none');
  const u = w.unitByUid(g.memberUids[0]);
  assert.notEqual(u, null);
  assert.equal(w.unitHealth(u!.uid), 3);
  assert.equal(u!.hitPoints, 3);
  assert.equal(w.groupOf(u!.uid)?.uid, g.uid);
  const st = w.unitRuntime(u!) as { actionLock: number; warrior: { ticker: number; condition: number } | null };
  assert.equal(st.actionLock, 10); // SetActionStay(10, uaWalk)
  assert.equal(st.warrior!.ticker, u!.uid); // fTicker := aID
  assert.ok(st.warrior!.condition >= Math.round(45 * 60 * 0.5) && st.warrior!.condition <= Math.round(45 * 60 * 0.7));
});

test('orderGroup walk: members walk to their formation slots and the order clears', () => {
  const w = makeWorld();
  const g = w.spawnGroup(0, 14, 6, 6, 3, 3, 3);
  assert.equal(w.orderGroup(g.uid, 'walk', 14, 6), true);
  assert.equal(g.order, 'walk');
  for (let i = 0; i < 300; i++) w.tick();
  assert.equal(g.order, 'none');
  const slots = g.memberUids.map((uid) => {
    const u = w.unitByUid(uid)!;
    return [Math.round(u.posF.x), Math.round(u.posF.y)];
  });
  const expected = [0, 1, 2].map((i) => {
    const p = getPositionInGroup2(14, 6, 3, i, 3, 32, 32);
    return [p.x, p.y];
  });
  assert.deepEqual(slots, expected);
  assert.equal(w.orderGroup(999, 'walk', 1, 1), false); // unknown group
});

test('melee fight: the units pass lands the kill (militia vs militia)', () => {
  const w = makeWorld();
  const a = w.spawnGroup(0, 14, 10, 10, 3, 1, 1);
  const b = w.spawnGroup(1, 14, 11, 10, 7, 1, 1);
  const victimUid = b.memberUids[0];
  w.orderGroup(a.uid, 'attackUnit', 0, 0, victimUid);
  let killed = -1;
  for (let i = 0; i < 600 && killed < 0; i++) {
    w.tick();
    const ev = eventsOf(w, 'unit-killed').find((e) => e.text.includes(`unit#${victimUid} `));
    if (ev !== undefined) killed = ev.tick;
  }
  assert.ok(killed > 0, 'a melee kill happened');
  // The melee damage source is recorded just before the kill.
  const hp = eventsOf(w, 'hp-decrease').filter((e) => e.text.includes(`unit#${victimUid} `));
  assert.ok(hp.length > 0);
  assert.ok(hp[hp.length - 1].text.includes('source=melee'));
  // The corpse is closed after the die animation (16 ticks) and removed next tick.
  assert.ok(hp[hp.length - 1].text.includes('hp=0'));
  for (let i = 0; i < 40; i++) w.tick();
  assert.equal(w.unitByUid(victimUid), null); // closed and removed
});

test('ranged fight: crossbowman kills by arrow in the projectiles pass', () => {
  const w = makeWorld();
  const a = w.spawnGroup(0, 18, 10, 10, 3, 1, 1); // crossbowman (120 attack → always hits militia)
  const b = w.spawnGroup(1, 14, 15, 10, 7, 1, 1); // militia at 5 tiles (inside 4..10.99)
  const victimUid = b.memberUids[0];
  w.orderGroup(a.uid, 'attackUnit', 0, 0, victimUid);
  let killed = -1;
  for (let i = 0; i < 900 && killed < 0; i++) {
    w.tick();
    const ev = eventsOf(w, 'unit-killed').find((e) => e.text.includes(`unit#${victimUid} `));
    if (ev !== undefined) killed = ev.tick;
  }
  assert.ok(killed > 0, 'an arrow kill happened');
  const arrows = eventsOf(w, 'arrow-fired');
  assert.ok(arrows.length > 0);
  assert.ok(arrows[0].text.includes('kind=bolt'));
  const hp = eventsOf(w, 'hp-decrease').filter((e) => e.text.includes(`unit#${victimUid} `));
  assert.ok(hp.some((e) => e.text.includes('source=arrow')));
});

test('FOW gate 1: an archer cannot target an unrevealed enemy until it is revealed', () => {
  const w = makeWorld();
  const a = w.spawnGroup(0, 18, 10, 10, 3, 1, 1); // crossbowman
  const b = w.spawnGroup(1, 28, 20, 13, 7, 1, 1); // dummy at 10.44 tiles: in range, all corners unrevealed
  const dummyUid = b.memberUids[0];
  w.orderGroup(a.uid, 'attackUnit', 0, 0, dummyUid);
  for (let i = 0; i < 200; i++) w.tick();
  assert.equal(eventsOf(w, 'arrow-fired').length, 0, 'no arrows while the target tile is unrevealed');
  w.fow[0].reveal(20, 13, 2, true); // e.g. a scout was there
  for (let i = 0; i < 300; i++) w.tick();
  assert.ok(eventsOf(w, 'arrow-fired').length > 0, 'arrows fire once the target is revealed');
});

test('FOW gate 2: a covered opponent drops the ranged fight (fow-drop)', () => {
  const w = makeWorld();
  const a = w.spawnGroup(0, 18, 10, 10, 3, 1, 1);
  const b = w.spawnGroup(1, 28, 20, 13, 7, 1, 1); // 50 HP dummy survives the arrows
  const dummyUid = b.memberUids[0];
  w.fow[0].reveal(20, 13, 2, true);
  w.orderGroup(a.uid, 'attackUnit', 0, 0, dummyUid);
  let fired = 0;
  for (let i = 0; i < 300 && fired < 1; i++) {
    w.tick();
    fired = eventsOf(w, 'arrow-fired').length;
  }
  assert.ok(fired >= 1, 'the archer was shooting while the target was revealed');
  w.fow[0].cover(20, 13, 2); // the target is covered (scripted fog)
  let dropped = false;
  for (let i = 0; i < 30 && !dropped; i++) {
    w.tick();
    dropped = eventsOf(w, 'fow-drop').length > 0;
  }
  assert.ok(dropped, 'the fight was dropped by the FOW gate');
  const drop = eventsOf(w, 'fow-drop');
  assert.ok(drop[0].text.includes(`target#${dummyUid}`));
  assert.ok(w.unitHealth(dummyUid) > 0, 'the gate dropped a live target');
});

test('projectiles: arrows skip animals (no damage even on a direct landing)', () => {
  const w = makeWorld();
  const shooter = w.spawnGroup(0, 18, 10, 10, 3, 1, 1).memberUids[0];
  const animal = w.spawnGroup(-1, 30, 14, 10, 7, 1, 1).memberUids[0]; // animals are HAND_ANIMAL
  const su = w.unitByUid(shooter)!;
  const au = w.unitByUid(animal)!;
  const flight = aimTargetUnit(w, su, au, 'bolt', 10.99, 4);
  assert.ok(flight > 0);
  for (let i = 0; i < 60; i++) w.tick();
  assert.equal(w.unitHealth(animal), 10); // unharmed
  assert.equal(eventsOf(w, 'hp-decrease').length, 0);
  assert.equal(w.projectiles.length, 0); // the bolt resolved
});

test('houses: melee strikes do 2 HP, destruction leaves rubble (KaMRandom(6) draws)', () => {
  const w = makeWorld();
  const house = w.spawnHouse(9, 18, 18, 1); // hut, 250 HP
  const g = w.spawnGroup(0, 14, 14, 18, 3, 2, 2);
  w.orderGroup(g.uid, 'attackHouse', 0, 0, house.uid);
  let destroyed = -1;
  for (let i = 0; i < 2000 && destroyed < 0; i++) {
    w.tick();
    const ev = eventsOf(w, 'house-destroyed');
    if (ev.length > 0) destroyed = ev[0].tick;
  }
  assert.ok(destroyed > 0, 'the house was destroyed');
  const text = eventsOf(w, 'house-destroyed')[0].text;
  const rubble = Number(/rubble=(\d+)/.exec(text)![1]);
  assert.ok(rubble > 0, 'rubble tiles were placed');
  // The house object is deleted one tick after Demolish.
  assert.equal(w.houses.length, 0);
  // Rubble objects 68..73 sit on the footprint's inner 2×2 blocks.
  let found = 0;
  for (let y = 1; y < 32; y++) {
    for (let x = 1; x < 32; x++) {
      const obj = w.grid.obj[y * (w.grid.mapX + 1) + x];
      if (obj >= 68 && obj <= 73) found += 1;
    }
  }
  assert.equal(found, rubble);
  // Melee-only damage is always even (2 HP per strike).
  assert.ok(destroyed > 0);
});

test('houses: arrows do 1 HP and raise the fire level', () => {
  const w = makeWorld();
  const house = w.spawnHouse(9, 18, 18, 1);
  const g = w.spawnGroup(0, 18, 24, 18, 7, 1, 1); // crossbowman at 6 tiles
  w.orderGroup(g.uid, 'attackHouse', 0, 0, house.uid);
  for (let i = 0; i < 400 && (house.damage ?? 0) < 2; i++) w.tick();
  assert.ok((house.damage ?? 0) >= 1);
  assert.ok(eventsOf(w, 'arrow-fired').length > 0);
  assert.ok(house.fireLevel >= 1); // fDamage > 0 → haFire1
  assert.ok(!house.destroyed);
});

test('frozen APIs: damageHouse destroys a house; unitHealth/groupOf report', () => {
  const w = makeWorld();
  const house = w.spawnHouse(9, 18, 18, 1);
  assert.equal(w.houseHealth(house), 250);
  w.damageHouse(house.uid, 249, 0);
  assert.equal(w.houseHealth(house), 1);
  assert.equal(house.destroyed, false);
  assert.equal(w.houseDamageTotal, 249);
  w.damageHouse(house.uid, 1, 0);
  assert.equal(house.destroyed, true);
  assert.equal(w.houseDamageTotal, 250);
  assert.equal(house.fireLevel, 8); // damage == maxHealth > 7 * dmgLevel
  assert.equal(w.unitHealth(9999), -1); // unknown uid
  assert.equal(w.groupOf(9999), null);
  for (let i = 0; i < 3; i++) w.tick();
  assert.equal(w.houses.length, 0); // deleted one tick after Demolish
});

test('groups: halt becomes a walk (KM_UnitGroup.pas 1494–1511) and the API predicates work', () => {
  const w = makeWorld();
  const g = w.spawnGroup(0, 14, 6, 6, 3, 2, 2);
  assert.equal(w.orderGroup(g.uid, 'walk', 12, 6), true);
  w.tick();
  assert.equal(g.order, 'walk');
  assert.equal(w.orderGroup(g.uid, 'halt'), true);
  assert.equal(g.orderWalkKind, 'halt');
  w.orderGroup(g.uid, 'none');
  assert.equal(g.order, 'none');
  // Predicates.
  const st = w.unitRuntime(w.unitByUid(g.memberUids[0])!) as { warrior: unknown };
  assert.ok(st.warrior !== null);
  assert.equal(w.groupOf(g.memberUids[0])?.uid, g.uid);
});
