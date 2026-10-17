// cli.ts — M5e prodsim: the production chain on MapsMP/Battle Sun (docs/M5-SPIKE.md 7.7).
// A scripted village around hand 1's store: a quarry next to the stone with one stonemason, a weapon
// workshop (timber -> axes) with one carpenter, and a barracks with five recruits. Roads join them to
// the store; the store gets a stone order (the same mechanism as the demo's timber order, because the
// v0 store never demands on its own); a scripted equip queue turns axes and recruits into militia.
// Usage:
//   node tools/prodsim/cli.ts --check        run TICKS twice, compare to expected.ts, PROD CHECK PASS/FAIL
//   node tools/prodsim/cli.ts --ticks N      run N ticks, print the event totals and the state sha
//   node tools/prodsim/cli.ts --json         print the JSON summary
// Reads the map/mission/defines from the frozen r15472 install (read-only). Data paths can be
// overridden with KAM_INSTALL / KAM_DATA like aisim.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parseMapFile } from '../../packages/map/mapfile.ts';
import { parseTilesJson } from '../../packages/assets/tiledata.ts';
import { parseMapElem } from '../../packages/assets/mapelem.ts';
import { parseUnitDat, parseSerfCarry } from '../../packages/assets/unitdat.ts';
import { parseHousesDat } from '../../packages/assets/housedata.ts';
import { parseMissionScript } from '../../packages/mission/mission.ts';
import { createEconomyWorld } from '../../packages/sim/economy.ts';
import type { EconHouse, EconomyWorld, SimEvent } from '../../packages/sim/economy.ts';
import { WARE_CNT, WT_AXE, WT_STONE, WT_TIMBER } from '../../packages/assets/wares.ts';
import { TICKS, MIN, EXPECTED_SHA } from './expected.ts';

const INSTALL = process.env.KAM_INSTALL ?? 'C:/Users/me/Desktop/KaM Remake/KaM Remake Beta r15472';
const DEFINES_DIR = process.env.KAM_DATA ?? `${INSTALL}/data/defines`;
const MAP_PATH = `${INSTALL}/MapsMP/Battle Sun/Battle Sun.map`;
const MISSION_PATH = `${INSTALL}/MapsMP/Battle Sun/Battle Sun.dat`;

const HAND = 1;
const HT_STORE = 11;
const HT_QUARRY = 14;
const HT_WEAPON_WORKSHOP = 19;
const HT_BARRACKS = 21;
const UT_CARPENTER = 5;
const UT_STONEMASON = 10;
const UT_MILITIA = 14;

/** The scripted stock: timber for the workshop, a stone order for the store, five recruits. */
const TIMBER_KIT = 24;
const STONE_ORDER = 40;
const RECRUITS = 5;
/** The workshop's axe order (WareOrder of output slot 1 = wtAxe, KM_Houses.pas 1555–1565). */
const AXE_ORDER = 12;
/** The scripted equip queue: one attempt every EQUIP_EVERY ticks (KM_HouseBarracks.pas 331–380). */
const EQUIP_EVERY = 100;

interface Result {
  ticks: number;
  events: Record<string, number>;
  stoneInStore: number;
  stoneOut: number;
  weaponsProduced: number;
  soldiersEquipped: number;
  sites: string;
  sha256: string;
}

interface Options {
  check: boolean;
  ticks: number | null;
  json: boolean;
}

function usage(): string {
  return (
    'usage: node tools/prodsim/cli.ts --check        (run ' +
    `${TICKS} ticks twice, compare to expected.ts, PROD CHECK PASS/FAIL)\n` +
    '       node tools/prodsim/cli.ts --ticks N      (run N ticks, event totals + sha)\n' +
    '       node tools/prodsim/cli.ts --json         (JSON summary)\n' +
    'env: KAM_INSTALL, KAM_DATA (defines dir)'
  );
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { check: false, ticks: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--check') opts.check = true;
    else if (arg === '--ticks') {
      const n = Number(argv[i + 1]);
      if (!Number.isInteger(n) || n <= 0) throw new Error(`--ticks needs a positive integer, got "${argv[i + 1]}"`);
      opts.ticks = n;
      i += 1;
    } else if (arg === '--json') opts.json = true;
    else if (arg === '--help' || arg === '-h') {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`unknown argument "${arg}"\n${usage()}`);
    }
  }
  return opts;
}

function readDefine(name: string): Buffer {
  const path = `${DEFINES_DIR}/${name}`;
  try {
    return readFileSync(path);
  } catch (err) {
    throw new Error(`defines: ${path}: cannot read file (${err instanceof Error ? err.message : String(err)})`);
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

/** The first spot (Chebyshev rings from the anchor) where the house fits and the extra test holds. */
function spotNear(
  w: EconomyWorld,
  typeId: number,
  anchor: { x: number; y: number },
  rMin: number,
  rMax: number,
  ok: (x: number, y: number) => boolean,
): { x: number; y: number } {
  const spec = w.houseSpecOf(typeId);
  if (spec === undefined) throw new Error(`prodsim: no house spec for ${typeId}`);
  for (let r = rMin; r <= rMax; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = anchor.x + dx;
        const y = anchor.y + dy;
        if (!w.canPlaceHouse(typeId, x + spec.entranceDx, y)) continue;
        if (!ok(x, y)) continue;
        return { x, y };
      }
    }
  }
  throw new Error(`prodsim: no spot for house ${typeId} within ${rMax} of (${anchor.x},${anchor.y})`);
}

function belowEntrance(h: EconHouse): { x: number; y: number } {
  return { x: h.entrance.x, y: h.entrance.y + 1 };
}

/** Lay roads along the walk route between two house doors (the store's road network). */
function connectRoad(w: EconomyWorld, from: { x: number; y: number }, to: { x: number; y: number }): void {
  const route = w.findRoute(from.x, from.y, to.x, to.y);
  if (route === null) throw new Error(`prodsim: no walk route from (${from.x},${from.y}) to (${to.x},${to.y})`);
  for (const p of route) if (!w.isRoadTile(p.x, p.y)) w.addRoadTile(p.x, p.y);
}

function stateSha(w: EconomyWorld): string {
  const houses = w.houses.map((h) => ({
    uid: h.uid,
    typeId: h.typeId,
    owner: h.owner,
    state: h.state,
    wareIn: h.wareIn.slice(),
    wareOut: h.wareOut.slice(),
    workerUid: h.workerUid,
    wares: Array.from({ length: WARE_CNT }, (_, i) => w.wareCount(h, i)),
  }));
  const units = w.units.map((u) => ({
    uid: u.uid,
    owner: u.owner,
    type: u.type,
    pos: [u.posF.x, u.posF.y],
    action: u.action,
    carry: u.carry,
    inside: u.inside,
    homeUid: u.homeUid,
    taskKind: u.taskKind,
  }));
  const canonical = JSON.stringify({ tick: w.tickCount, rngState: w.rngState, roadTiles: w.roadTileCount, houses, units });
  return createHash('sha256').update(canonical).digest('hex');
}

function runOnce(ticks: number): Result {
  const at = MAP_PATH;
  const map = parseMapFile(at);
  const tiles = parseTilesJson(readDefine('tiles.json').toString('utf8'));
  const elems = parseMapElem(readDefine('mapelem.dat'));
  const unitBuf = readDefine('unit.dat');
  const unitSpecs = parseUnitDat(unitBuf);
  const serfCarry = parseSerfCarry(unitBuf);
  const houseSpecs = parseHousesDat(readDefine('houses.dat'));
  const missionBytes = readFileSync(MISSION_PATH);
  const mission = parseMissionScript(missionBytes, map.mapX, map.mapY);
  const w = createEconomyWorld({ map, tiles, elems, unitSpecs, serfCarry, houseSpecs, mission });

  const store = w.findFirstHouse(HT_STORE, HAND);
  if (store === null) throw new Error(`prodsim: hand ${HAND} has no store on Battle Sun`);
  const storeBelow = belowEntrance(store);
  const stoneNear = (x: number, y: number): boolean => {
    for (let dy = -5; dy <= 5; dy++) for (let dx = -5; dx <= 5; dx++) if (w.tileHasStone(x + dx, y + dy)) return true;
    return false;
  };

  const quarrySpot = spotNear(w, HT_QUARRY, store.entrance, 6, 24, stoneNear);
  const quarry = w.spawnHouse(HT_QUARRY, quarrySpot.x, quarrySpot.y, HAND);
  connectRoad(w, belowEntrance(quarry), storeBelow);
  w.spawnCitizen(HAND, UT_STONEMASON, belowEntrance(quarry).x, belowEntrance(quarry).y, 6);
  w.addScriptDemand(store, WT_STONE, STONE_ORDER);

  const workshopSpot = spotNear(w, HT_WEAPON_WORKSHOP, store.entrance, 5, 14, () => true);
  const workshop = w.spawnHouse(HT_WEAPON_WORKSHOP, workshopSpot.x, workshopSpot.y, HAND);
  w.addInputDemands(workshop);
  connectRoad(w, belowEntrance(workshop), storeBelow);
  w.spawnCitizen(HAND, UT_CARPENTER, belowEntrance(workshop).x, belowEntrance(workshop).y, 6);
  w.addWareToStore(HAND, WT_TIMBER, TIMBER_KIT);
  w.setWareOrder(workshop.uid, 1, AXE_ORDER);

  const barracksSpot = spotNear(w, HT_BARRACKS, store.entrance, 5, 14, () => true);
  const barracks = w.spawnHouse(HT_BARRACKS, barracksSpot.x, barracksSpot.y, HAND);
  connectRoad(w, belowEntrance(barracks), storeBelow);
  for (let i = 0; i < RECRUITS; i++) w.barracksAddRecruit(barracks.uid);

  const stoneAtStart = w.wareCount(store, WT_STONE);
  let equipped = 0;
  for (let t = 1; t <= ticks; t++) {
    w.tick();
    if (t % EQUIP_EVERY === 0 && w.barracksEquip(barracks.uid, UT_MILITIA) !== null) equipped += 1;
  }

  const events = eventTotals(w.events);
  const stoneProd = w.houseSpecOf(HT_QUARRY)?.productionX ?? 1;
  const weaponProd = w.houseSpecOf(HT_WEAPON_WORKSHOP)?.productionX ?? 1;
  const stoneOut = (events['stone-out'] ?? 0) * stoneProd;
  const weaponsProduced = (events['ware-produced'] ?? 0) * weaponProd;
  const sites = `quarry=(${quarry.x},${quarry.y}) workshop=(${workshop.x},${workshop.y}) barracks=(${barracks.x},${barracks.y})`;
  return {
    ticks,
    events,
    stoneInStore: w.wareCount(store, WT_STONE) - stoneAtStart,
    stoneOut,
    weaponsProduced,
    soldiersEquipped: equipped,
    sites,
    sha256: stateSha(w),
  };
}

function summaryLine(r: Result): string {
  const ev = Object.entries(r.events)
    .filter(([k]) => ['stone-out', 'stone-plan', 'workshop-start', 'ware-produced', 'ware-delivered', 'barracks-equipped', 'house-activated'].includes(k))
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
  return `PROD ${r.sites} stoneOut=${r.stoneOut} stoneInStore=${r.stoneInStore} weapons=${r.weaponsProduced} soldiers=${r.soldiersEquipped} events(${ev}) sha256=${r.sha256}`;
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.check) {
    const a = runOnce(TICKS);
    const b = runOnce(TICKS);
    const identical = a.sha256 === b.sha256 && JSON.stringify(a.events) === JSON.stringify(b.events);
    const problems: string[] = [];
    if (!identical) problems.push('two runs differ');
    if (a.stoneInStore < MIN.stoneInStore) problems.push(`stone in store ${a.stoneInStore} < ${MIN.stoneInStore}`);
    if (a.weaponsProduced < MIN.weaponsProduced) problems.push(`weapons ${a.weaponsProduced} < ${MIN.weaponsProduced}`);
    if (a.soldiersEquipped < MIN.soldiersEquipped) problems.push(`soldiers ${a.soldiersEquipped} < ${MIN.soldiersEquipped}`);
    if (EXPECTED_SHA !== '' && a.sha256 !== EXPECTED_SHA) problems.push(`sha ${a.sha256} != expected ${EXPECTED_SHA}`);
    console.log(summaryLine(a));
    console.log(`run 2: sha256=${b.sha256} identical=${identical}`);
    console.log(`EVENTS ${Object.entries(a.events).map(([k, v]) => `${k}=${v}`).join(' ')}`);
    if (problems.length === 0) {
      console.log(
        `PROD CHECK PASS (${TICKS} ticks, stone in store ${a.stoneInStore} >= ${MIN.stoneInStore}, weapons ${a.weaponsProduced} >= ${MIN.weaponsProduced}, soldiers ${a.soldiersEquipped} >= ${MIN.soldiersEquipped}, two runs identical)`,
      );
      return;
    }
    console.log(`PROD CHECK FAIL: ${problems.join('; ')}`);
    process.exitCode = 1;
    return;
  }
  const r = runOnce(opts.ticks ?? TICKS);
  if (opts.json) console.log(JSON.stringify(r, null, 2));
  else console.log(summaryLine(r));
}

main();
