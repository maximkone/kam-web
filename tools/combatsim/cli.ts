// cli.ts — M4 combatsim: a deterministic scripted skirmish on a real map (docs/M4-SPIKE.md 1/6).
// Usage:
//   node tools/combatsim/cli.ts --check        run TICKS, compare to expected.ts, COMBAT CHECK PASS/FAIL
//   node tools/combatsim/cli.ts --ticks N      run N ticks, print the event log + summary
//   node tools/combatsim/cli.ts --json         print the JSON summary
//   node tools/combatsim/cli.ts --map <kind>/<name>   load another map (default MapsMP/Arena)
//
// The skirmish exercises the whole slice: a melee battle (kills in the units pass), crossbowmen
// (arrow kills in the projectiles pass, arrows fired/hit), a house destroyed by melee (2 HP per
// strike, rubble draws), and both FOW gates (an unrevealed target cannot be acquired; a covered
// opponent drops the ranged fight). Combatants are spawned deterministically — the v0 mission
// parser does not read !SET_GROUP, so the map's own units are ignored by the skirmish.
//
// Reads the map/mission/defines from the frozen r15472 install (read-only). Paths can be overridden
// with KAM_INSTALL, KAM_MAP (full .map path) and KAM_MISSION.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parseMapFile } from '../../packages/map/mapfile.ts';
import { parseTilesJson } from '../../packages/assets/tiledata.ts';
import { parseMapElem } from '../../packages/assets/mapelem.ts';
import { parseUnitDat, parseSerfCarry } from '../../packages/assets/unitdat.ts';
import { parseHousesDat, housePlan } from '../../packages/assets/housedata.ts';
import { parseMissionScript } from '../../packages/mission/mission.ts';
import { createEconomyWorld } from '../../packages/sim/economy.ts';
import type { EconomyWorld, SimEvent } from '../../packages/sim/economy.ts';
import type { GroupState, SimProjectile } from '../../packages/sim/combat.ts';
import { getPositionFromIndex } from '../../packages/sim/combat.ts';
import { TICKS, EXPECTED } from './expected.ts';

const INSTALL = process.env.KAM_INSTALL ?? 'C:/Users/me/Desktop/KaM Remake/KaM Remake Beta r15472';
const DEFAULT_MAP = 'MapsMP/Arena';

interface Options {
  check: boolean;
  ticks: number | null;
  json: boolean;
  map: string;
}

function usage(): string {
  return (
    'usage: node tools/combatsim/cli.ts --check        (run ' +
    `${TICKS} ticks, compare to expected.ts, COMBAT CHECK PASS/FAIL)\n` +
    '       node tools/combatsim/cli.ts --ticks N      (run N ticks, event log + summary)\n' +
    '       node tools/combatsim/cli.ts --json         (JSON summary)\n' +
    '       node tools/combatsim/cli.ts --map <kind>/<name>  (default MapsMP/Arena)\n' +
    'env: KAM_INSTALL (install root), KAM_MAP (full .map path), KAM_MISSION'
  );
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { check: false, ticks: null, json: false, map: DEFAULT_MAP };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--check') opts.check = true;
    else if (arg === '--ticks') {
      const n = Number(argv[i + 1]);
      if (!Number.isInteger(n) || n <= 0) throw new Error(`--ticks needs a positive integer, got "${argv[i + 1]}"`);
      opts.ticks = n;
      i += 1;
    } else if (arg === '--json') opts.json = true;
    else if (arg === '--map') {
      i += 1;
      if (i >= argv.length) throw new Error(`missing value for --map\n${usage()}`);
      opts.map = argv[i];
    } else if (arg === '--help' || arg === '-h') {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`unknown argument "${arg}"\n${usage()}`);
    }
  }
  return opts;
}

function readDefine(name: string): Buffer {
  const path = `${INSTALL}/data/defines/${name}`;
  try {
    return readFileSync(path);
  } catch (err) {
    throw new Error(`defines: ${path}: cannot read file (${err instanceof Error ? err.message : String(err)})`);
  }
}

function mapPaths(mapArg: string): { mapPath: string; missionPath: string } {
  const mapPath = process.env.KAM_MAP ?? `${INSTALL}/${mapArg}/${mapArg.slice(mapArg.lastIndexOf('/') + 1)}.map`;
  const missionPath = process.env.KAM_MISSION ?? mapPath.replace(/\.map$/i, '.dat');
  return { mapPath, missionPath };
}

/** Nearest walkable in-map tile to (x, y), deterministic (GetPositionFromIndex order). */
function placeNear(w: EconomyWorld, x: number, y: number): { x: number; y: number } {
  if (w.tileInMapCoords(x, y) && w.tileWalkable(x, y)) return { x, y };
  for (let i = 0; i <= 255; i++) {
    const p = getPositionFromIndex({ x, y }, i);
    if (w.tileInMapCoords(p.x, p.y) && w.tileWalkable(p.x, p.y)) return p;
  }
  return { x, y };
}

/** The nearest tile where a house footprint fits fully on walkable map tiles, or null. */
function placeHouseNear(w: EconomyWorld, typeId: number, x: number, y: number): { x: number; y: number } | null {
  for (let i = 0; i <= 255; i++) {
    const p = getPositionFromIndex({ x, y }, i);
    const plan = housePlan(typeId);
    let ok = true;
    for (let row = 1; row <= 4 && ok; row++) {
      for (let col = 1; col <= 4 && ok; col++) {
        if (plan[row - 1][col - 1] === 0) continue;
        const tx = p.x + col - 3;
        const ty = p.y + row - 4;
        if (!w.tileInMapCoords(tx, ty) || !w.tileWalkable(tx, ty)) ok = false;
      }
    }
    if (ok) return p;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// The frozen skirmish script (positions verified against the Arena 32x32 walk grid)
//
// Layout (all tiles checked walkable): the melee battle in the left corridor (x 4..5), the house
// raid in the top arena (y 9..13), the archers in the middle facing SE with target1 (revealed by
// the archers' own spawn circle) and target2 (deliberately outside every hand-0 reveal: its four
// corner vertices are 82+ tiles² from the archers, so only the scripted phase-2 reveal opens the
// FOW gate — and the phase-3 cover closes it again for the gate-drop check).

const SKIRMISH = {
  // Melee battle: hand 0 vs hand 1 militia in the 2-wide left corridor, 4 tiles apart.
  meleeA: { owner: 0, type: 14, x: 4, y: 16, dir: 3, perRow: 2, count: 3 },
  meleeB: { owner: 1, type: 14, x: 4, y: 20, dir: 3, perRow: 2, count: 3 },
  // Crossbowmen (hand 0) at (10,20),(9,21) facing dirSE.
  archers: { owner: 0, type: 18, x: 10, y: 20, dir: 4, perRow: 1, count: 2 },
  target1: { owner: 1, type: 14, x: 19, y: 22, dir: 4 }, // militia at 9.2 tiles — dies to bolts
  target2: { owner: 1, type: 22, x: 20, y: 22, dir: 4 }, // knight at 10.2 tiles — survives for the drop
  // House raid: hand 0 militia vs a hand-1 woodcutter hut (250 HP, 2 HP per melee strike) in the
  // bottom corridor.
  house: { typeId: 9, x: 16, y: 28, owner: 1 },
  raiders: { owner: 0, type: 14, x: 12, y: 29, dir: 1, perRow: 3, count: 3 },
  // Scripted phases (ticks).
  phase2: 300, // reveal target2 + order the archers onto it
  phase3: 360, // cover target2 → FOW gate #2 drops the fight
  phase4: 380, // halt the archers: clears the offenders, so the drop is not re-issued
};

interface LoadSummary {
  map: string;
  mapSize: string;
  hands: number;
  houses: number;
  streets: number;
  units: number;
  warriors: number;
  houseSpawned: string;
}

interface SkirmishHandles {
  meleeA: GroupState;
  meleeB: GroupState;
  archers: GroupState;
  target1: number; // unit uid
  target2: number;
  house: number; // house uid
  raiders: GroupState;
}

function buildWorld(opts: Options): { world: EconomyWorld; summary: LoadSummary; handles: SkirmishHandles } {
  const { mapPath, missionPath } = mapPaths(opts.map);
  const map = parseMapFile(mapPath);
  const tiles = parseTilesJson(readDefine('tiles.json').toString('utf8'));
  const elems = parseMapElem(readDefine('mapelem.dat'));
  const unitBuf = readDefine('unit.dat');
  const unitSpecs = parseUnitDat(unitBuf);
  const serfCarry = parseSerfCarry(unitBuf);
  const houseSpecs = parseHousesDat(readDefine('houses.dat'));
  const mission = parseMissionScript(readFileSync(missionPath), map.mapX, map.mapY);

  const world = createEconomyWorld({ map, tiles, elems, unitSpecs, serfCarry, houseSpecs, mission });

  // Spawn the scripted combatants (each spawn draws from the world's KaMRandom stream). On maps
  // where a scripted tile is not walkable, the nearest walkable tile is used (no-op on Arena).
  const pos = (p: { x: number; y: number }) => placeNear(world, p.x, p.y);
  const m1 = pos(SKIRMISH.meleeA);
  const m2 = pos(SKIRMISH.meleeB);
  const ar = pos(SKIRMISH.archers);
  const t1 = pos(SKIRMISH.target1);
  const t2 = pos(SKIRMISH.target2);
  const ra = pos(SKIRMISH.raiders);
  const houseAt = placeHouseNear(world, SKIRMISH.house.typeId, SKIRMISH.house.x, SKIRMISH.house.y);
  if (houseAt === null) throw new Error(`combatsim: no walkable hut spot near (${SKIRMISH.house.x},${SKIRMISH.house.y})`);

  const meleeA = world.spawnGroup(SKIRMISH.meleeA.owner, SKIRMISH.meleeA.type, m1.x, m1.y, SKIRMISH.meleeA.dir, SKIRMISH.meleeA.perRow, SKIRMISH.meleeA.count);
  const meleeB = world.spawnGroup(SKIRMISH.meleeB.owner, SKIRMISH.meleeB.type, m2.x, m2.y, SKIRMISH.meleeB.dir, SKIRMISH.meleeB.perRow, SKIRMISH.meleeB.count);
  const archers = world.spawnGroup(SKIRMISH.archers.owner, SKIRMISH.archers.type, ar.x, ar.y, SKIRMISH.archers.dir, SKIRMISH.archers.perRow, SKIRMISH.archers.count);
  const target1 = world.spawnWarrior(SKIRMISH.target1.owner, SKIRMISH.target1.type, t1.x, t1.y, SKIRMISH.target1.dir).unit.uid;
  const target2 = world.spawnWarrior(SKIRMISH.target2.owner, SKIRMISH.target2.type, t2.x, t2.y, SKIRMISH.target2.dir).unit.uid;
  const house = world.spawnHouse(SKIRMISH.house.typeId, houseAt.x, houseAt.y, SKIRMISH.house.owner).uid;
  const raiders = world.spawnGroup(SKIRMISH.raiders.owner, SKIRMISH.raiders.type, ra.x, ra.y, SKIRMISH.raiders.dir, SKIRMISH.raiders.perRow, SKIRMISH.raiders.count);

  // Orders (executed at tick 1: melee charge, house raid, archers onto target1).
  world.orderGroup(meleeA.uid, 'attackUnit', 0, 0, meleeB.memberUids[0]);
  world.orderGroup(raiders.uid, 'attackHouse', 0, 0, house);
  // target1 is already inside the archers' own spawn reveal (a corner vertex 68 tiles² away).
  world.orderGroup(archers.uid, 'attackUnit', 0, 0, target1);

  const summary: LoadSummary = {
    map: map.file,
    mapSize: `${map.mapX}x${map.mapY}`,
    hands: world.handCount,
    houses: world.houses.length,
    streets: mission.streets.length,
    units: world.units.length,
    warriors: world.units.filter((u) => unitSpecs[u.type]?.isWarrior === true).length,
    houseSpawned: `hut#${house}@(${SKIRMISH.house.x},${SKIRMISH.house.y})`,
  };
  return { world, summary, handles: { meleeA, meleeB, archers, target1, target2, house, raiders } };
}

/** The scripted phases (reveal/cover/order) at their fixed ticks. */
function scriptedPhases(w: EconomyWorld, h: SkirmishHandles, tick: number): void {
  if (tick === SKIRMISH.phase2) {
    w.fow[0].reveal(SKIRMISH.target2.x, SKIRMISH.target2.y, 2, true);
    w.orderGroup(h.archers.uid, 'attackUnit', 0, 0, h.target2);
  }
  if (tick === SKIRMISH.phase3) {
    w.fow[0].cover(SKIRMISH.target2.x, SKIRMISH.target2.y, 2);
  }
  if (tick === SKIRMISH.phase4) {
    // The player gives up the shot: halt clears the group's offenders, so the gate drop is not
    // re-issued every CheckForFight tick.
    w.orderGroup(h.archers.uid, 'halt');
  }
}

function eventTotals(events: SimEvent[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of events) {
    const kind = e.text.split(' ')[0];
    out[kind] = (out[kind] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

interface FinalCounts {
  meleeKills: number;
  rangedKills: number;
  arrowsFired: number;
  arrowsHit: number;
  fowDrops: number;
  houseDamage: number;
  houseDestroyed: number;
  rubbleTiles: number;
  houseHealthLeft: number;
  unitsAlive: number;
  groupsAlive: number;
  rngState: number;
}

function finalCounts(w: EconomyWorld, houseUid: number): FinalCounts {
  const kills = w.events.filter((e) => e.text.startsWith('kill-source '));
  const destroyed = w.events.find((e) => e.text.startsWith('house-destroyed '));
  const rubble = destroyed !== undefined ? Number(/rubble=(\d+)/.exec(destroyed.text)?.[1] ?? 0) : 0;
  const house = w.houseByUid(houseUid);
  return {
    meleeKills: kills.filter((e) => e.text.includes('source=melee')).length,
    rangedKills: kills.filter((e) => e.text.includes('source=arrow')).length,
    arrowsFired: w.events.filter((e) => e.text.startsWith('arrow-fired ')).length,
    arrowsHit: w.events.filter((e) => e.text.startsWith('hp-decrease ') && e.text.includes('source=arrow')).length,
    fowDrops: w.events.filter((e) => e.text.startsWith('fow-drop ')).length,
    houseDamage: w.houseDamageTotal,
    houseDestroyed: destroyed !== undefined ? 1 : 0,
    rubbleTiles: rubble,
    houseHealthLeft: house !== null ? w.houseHealth(house) : 0,
    unitsAlive: w.units.filter((u) => !u.dead).length,
    groupsAlive: w.groups.length,
    rngState: w.rngState,
  };
}

/** A canonical, order-stable serialization of the observable world state, sha256'd. */
function stateSha(w: EconomyWorld): string {
  const units = w.units
    .filter((u) => !u.dead)
    .map((u) => ({
      uid: u.uid,
      owner: u.owner,
      type: u.type,
      pos: [u.posF.x, u.posF.y],
      dir: u.dir,
      animStep: u.animStep,
      action: u.action,
      hitPoints: u.hitPoints,
      groupUid: u.groupUid,
      fightState: u.fightState,
    }));
  const groups = w.groups.map((g) => ({
    uid: g.uid,
    owner: g.owner,
    members: g.memberUids.slice(),
    groupType: g.groupType,
    order: g.order,
    orderX: g.orderX,
    orderY: g.orderY,
    orderDir: g.orderDir,
    targetUid: g.targetUid,
    targetHouseUid: g.targetHouseUid,
    offenders: g.offenders.slice(),
  }));
  const projectiles = w.projectiles.map((p: SimProjectile) => ({
    uid: p.uid,
    kind: p.kind,
    from: [p.fromX, p.fromY],
    to: [p.toX, p.toY],
    targetUid: p.targetUid,
    targetHouseUid: p.targetHouseUid,
    t: p.t,
  }));
  const houses = w.houses.map((h) => ({
    uid: h.uid,
    typeId: h.typeId,
    owner: h.owner,
    x: h.x,
    y: h.y,
    damage: h.damage,
    destroyed: h.destroyed,
    fireLevel: h.fireLevel,
  }));
  const rubble: number[][] = [];
  for (let y = 1; y <= w.grid.mapY - 1; y++) {
    for (let x = 1; x <= w.grid.mapX - 1; x++) {
      const obj = w.grid.obj[y * (w.grid.mapX + 1) + x];
      if (obj >= 68 && obj <= 73) rubble.push([x, y, obj]);
    }
  }
  const fow = w.fow.map((f) => Array.from(f.revelation));
  const canonical = JSON.stringify({
    tick: w.tickCount,
    rngState: w.rngState,
    units,
    groups,
    projectiles,
    houses,
    rubble,
    fow,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.check && opts.ticks === null && !opts.json) {
    console.log(usage());
    return;
  }

  const { world, summary, handles } = buildWorld(opts);
  console.log(
    `COMBATSIM ${summary.map} ${summary.mapSize} hands=${summary.hands} houses=${summary.houses} ` +
      `streets=${summary.streets} units=${summary.units} warriors=${summary.warriors} house=${summary.houseSpawned}`,
  );

  const ticks = opts.check || (opts.json && opts.ticks === null) ? TICKS : opts.ticks ?? 0;
  const start = Date.now();
  for (let i = 1; i <= ticks; i++) {
    scriptedPhases(world, handles, i);
    world.tick();
  }
  const elapsed = Date.now() - start;

  const totals = eventTotals(world.events);
  const finals = finalCounts(world, handles.house);
  const sha = stateSha(world);

  if (opts.json) {
    console.log(
      JSON.stringify(
        { load: summary, ticks: world.tickCount, events: totals, final: finals, sha256: sha, elapsedMs: elapsed },
        null,
        2,
      ),
    );
    return;
  }

  if (opts.ticks !== null && !opts.check) {
    for (const e of world.events) console.log(`EVENT t=${e.tick} ${e.text}`);
    console.log(
      `TICKS ${world.tickCount} events=${world.events.length} meleeKills=${finals.meleeKills} rangedKills=${finals.rangedKills} ` +
        `arrows=${finals.arrowsFired} hits=${finals.arrowsHit} fowDrops=${finals.fowDrops} houseDestroyed=${finals.houseDestroyed} ` +
        `rubble=${finals.rubbleTiles} rngState=${world.rngState} sha256=${sha}`,
    );
    return;
  }

  // --check: compare the frozen numbers.
  console.log(`EVENTS ${Object.entries(totals).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  console.log(
    `FINAL meleeKills=${finals.meleeKills} rangedKills=${finals.rangedKills} arrows=${finals.arrowsFired} hits=${finals.arrowsHit} ` +
      `fowDrops=${finals.fowDrops} houseDamage=${finals.houseDamage} houseDestroyed=${finals.houseDestroyed} rubble=${finals.rubbleTiles} ` +
      `houseHealthLeft=${finals.houseHealthLeft} unitsAlive=${finals.unitsAlive} groupsAlive=${finals.groupsAlive} rngState=${finals.rngState}`,
  );
  console.log(`SHA256 ${sha}`);

  const problems: string[] = [];
  compare('load', summary, EXPECTED.load, problems);
  compare('events', totals, EXPECTED.events, problems);
  compare('final', finals, EXPECTED.final, problems);
  compare('sha256', sha, EXPECTED.sha256, problems);

  if (problems.length === 0) {
    console.log(`COMBAT CHECK PASS (${world.tickCount} ticks, ${world.events.length} events, ${elapsed} ms)`);
  } else {
    console.log(`COMBAT CHECK FAIL:\n  ${problems.join('\n  ')}`);
    process.exitCode = 1;
  }
}

function compare(label: string, actual: unknown, expected: unknown, problems: string[]): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) problems.push(`${label}: ${a} != expected ${b}`);
}

try {
  main();
} catch (err) {
  console.error(`ERROR ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
