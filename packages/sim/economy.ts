// economy.ts — M3 v0 headless economy sim: mission houses, streets, trees, the three task state
// machines (goHome / mining / deliver) and the per-hand logistics pass (docs/M3-SPIKE.md).
//
// Tick order (spec 2.5, KM_Game.pas 3081–3114; replaces the M2b updateUnits body):
//   1. IncTick; 2. terrain update (falling-tree end + tree growth, KM_Terrain.pas 5410–5498);
//   3. per hand ascending: units (descending index: action first, then task — KM_Units.pas
//      2652–2682) → houses (descending index: IncAnimStep only, KM_Houses.pas 2179–2213) →
//      logistics when `tick mod handCount == handId` (KM_Hand.pas 2116–2120); 4. the one
//      RunningTimer RNG draw. Seed 1, like M2b (no parity claim yet).
//
// v0 divergences (documented, spec 2.6/2.7 and §1):
//  - Units spawn with a stay(0) action and run their logic on tick 1 (the game's initial action).
//  - go-in / go-out transitions are modeled as a 1-tick state change (the game slides for ~10
//    ticks at walk speed; the spec freezes only the surrounding stays).
//  - No construction, fields, mines, animals, or player commands; workers other than the
//    woodcutter (hut) and carpenter (sawmill) get no work task and rest inside their house.
//  - Logistics uses the v0 rule of spec 2.7: offers (wareOut > 0, or store stock) vs demands
//    (per WareInput slot: target min(5, distribution 5) − (in + beingDelivered); script demands
//    as counts). Match first valid offer → nearest valid demand by road BFS → nearest idle
//    eligible serf by tpWalk route length. The exact bid math is deferred (no parity claim).
//  - Trees do not block tpWalk in the r15472 data (AllBlocked = false for CHOPABLE_TREES objects;
//    verified against mapelem.dat) — only diagonal steps through them are blocked
//    (DiagonalBlocked), exactly as the M2b grid already models.
//  - The carpenter saw cycle is frozen at 361 ticks per 2 timber (spec 2.6). The Pascal's
//    per-stay −1/−2 compensations plus the task re-issue tick measure 358 in a tick-exact port;
//    this port uses the full anim-derived work stays (T1 = 30, T2 = 250, T3−1 = 29) with
//    WorkerRest*10−1 = 49, giving exactly 49 + 1 (re-issue) + 1 (phase 0) + 30 + 250 + 29 +
//    1 (phase 12) = 361 ticks between productions (documented deviation; the frozen number wins).
//  - Chop tree choice: the Pascal's taAny decision and GetWeightedRandom pick are ported; v0 has
//    no plant candidates (planting is out of scope), so the decision draw is consumed but the
//    result is always "chop" while trees are available (spec's RNG contract: 1 draw decision +
//    1 draw pick per plan).
//  - TreeAge is a sim field (Uint8Array) initialised from the object id like KM_Terrain.pas
//    535–538; the .map has no TreeAge byte.
//
// Browser-safe: no node: imports.
import type { KaMap } from '../map/map.ts';
import type { PassGrid } from './terrain.ts';
import { buildPassGrid, canWalkDiagonal, tileWalkable } from './terrain.ts';
import { findPath } from './astar.ts';
import type { Walk } from './walk.ts';
import { startWalk, walkSpeeds, walkTick } from './walk.ts';
import { step as rngStep, RNG_M } from './rng.ts';
import type { MapElem } from '../assets/mapelem.ts';
import type { TileFlags } from '../assets/tiledata.ts';
import type { AnimLoop, UnitSpec } from '../assets/unitdat.ts';
import type { HouseSpec } from '../assets/housedata.ts';
import { housePlan } from '../assets/housedata.ts';
import type { Mission } from '../mission/mission.ts';
import { WARE_CNT, WT_TRUNK, WT_TIMBER } from '../assets/wares.ts';

// ---------------------------------------------------------------------------------------------
// Frozen tables (docs/M3-SPIKE.md 2.2/2.4)

// CHOPABLE_TREES[1..13, (age1, age2, age3, ageFull, fall, stump)] (KM_ResMapElements.pas 61–78).
export const CHOPABLE_TREES: number[][] = [
  [88, 89, 90, 90, 91, 37],
  [97, 98, 99, 100, 101, 41],
  [102, 103, 104, 105, 106, 45],
  [107, 108, 109, 110, 111, 41],
  [112, 113, 114, 114, 115, 25],
  [116, 117, 118, 119, 120, 25],
  [92, 93, 94, 95, 96, 49],
  [121, 122, 123, 124, 125, 64],
  [149, 150, 151, 151, 152, 29],
  [153, 154, 155, 155, 156, 29],
  [157, 158, 159, 160, 161, 33],
  [162, 163, 164, 165, 166, 33],
  [167, 168, 169, 170, 171, 33],
];

// Tree growth thresholds (KM_ResMapElements.pas 81–83; TERRAIN_PACE = 200, KM_Defaults.pas 17).
export const TREE_AGE_1 = 12;
export const TREE_AGE_2 = 25;
export const TREE_AGE_FULL = 40;
const TERRAIN_PACE = 200;

// Falling-tree animation length (Anim.Count − 1): every CHOPABLE_TREES fall object has Count 20 in
// the shipped mapelem.dat (verified), so ChopTree runs 19 ticks after FallTree
// (KM_Terrain.pas 5434–5436).
const FALL_TICKS = 19;

const MAX_WARES_IN_HOUSE = 5; // KM_Defaults.pas 299
const WORKER_REST_DEFAULT = 5; // fallback when a house has no parsed spec
const OBJ_NONE = 255;

// BASE_VAL for TKMPointDirCenteredList weights (KM_CommonClasses.pas 1294).
const BASE_VAL = 100;

// HEIGHT_MAX (used by ChooseCuttingDirection 2769–2770 to punish front cuts on a rise).
const HEIGHT_MAX = 255;

export interface EconHouse {
  uid: number;
  typeId: number; // script id 0..29 (HouseSpec index)
  owner: number;
  x: number;
  y: number;
  entrance: { x: number; y: number };
  state: 'empty' | 'idle' | 'work';
  wareIn: number[]; // 4 COUNTS, parallel to HouseSpec.resIn slots
  wareOut: number[]; // 4 COUNTS, parallel to HouseSpec.resOut slots
  workerUid: number; // 0 = none
  animStep: number;
  workAnimStep: number;
}

export interface EconUnit {
  uid: number;
  owner: number;
  type: number; // unit.dat record
  posF: { x: number; y: number };
  dir: number;
  animStep: number;
  action: 'stay' | 'walk';
  carry: number; // ware id, -1 = none
  inside: boolean;
  homeUid: number; // 0 = none
  taskKind: 'none' | 'goHome' | 'chop' | 'saw' | 'deliver' | 'idle';
}

export interface SimEvent {
  tick: number;
  text: string; // "<kind> <detail>"
}

export interface EconomyWorldOptions {
  map: KaMap;
  tiles: TileFlags[];
  elems: MapElem[];
  unitSpecs: UnitSpec[];
  serfCarry: AnimLoop[][];
  houseSpecs: (HouseSpec | undefined)[];
  mission: Mission;
}

interface Pt {
  x: number;
  y: number;
}

interface ChopPlan {
  loc: Pt; // the cutting spot (beside the tree)
  dir: number; // direction from the spot toward the tree (KMGetVertexDir)
}

type Task =
  | { kind: 'goHome'; phase: number }
  | { kind: 'chop'; phase: number; plan: ChopPlan | null; distant: boolean }
  | { kind: 'saw'; phase: number; phase2: number }
  | { kind: 'deliver'; phase: number; fromIdx: number; toIdx: number; ware: number; demand: Demand; taken: boolean };

interface Demand {
  houseIdx: number;
  ware: number;
  slot: number; // input slot for house demands; -1 for script demands
  script: boolean;
  count: number; // script demands: remaining count
  being: number; // reserved deliveries
}

interface Offer {
  houseIdx: number;
  ware: number;
  count: number;
}

interface HouseState {
  spec: HouseSpec | undefined;
  stock: Int32Array | null; // stores only
  workerUid: number;
  being: number[]; // per input slot: reserved deliveries (demand cap)
  isStore: boolean;
}

interface UnitState {
  spec: UnitSpec;
  speed: { ortho: number; diag: number };
  walk: Walk | null;
  actionLock: number; // remaining ticks of the current stay; 0 = completes next tick
  locked: boolean; // locked stays block serf idle status (SetActionLockedStay)
  task: Task | null;
  homeUid: number;
}

function pointBelowEntrance(h: EconHouse): Pt {
  return { x: h.entrance.x, y: h.entrance.y + 1 };
}

function samePoint(a: Pt, b: Pt): boolean {
  return a.x === b.x && a.y === b.y;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function euclid(a: Pt, b: Pt): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/** KMGetVertexTile (KM_Points.pas 891–897): the tree tile for a cutting spot + direction. */
function vertexTile(p: Pt, dir: number): Pt {
  const X = [0, 0, 1, 0, 1, 0, 0, 0, 0];
  const Y = [0, 0, 0, 0, 1, 0, 1, 0, 0];
  return { x: p.x + X[dir], y: p.y + Y[dir] };
}

/** KMGetVertexDir (KM_Points.pas 883–888): cutting-spot offset → direction. */
function vertexDir(k: number, i: number): number {
  const table: number[][] = [
    [4, 2], // [X=-1]: Y=-1 → dirSE(4), Y=0 → dirNE(2)
    [6, 8], // [X=0]:  Y=-1 → dirSW(6), Y=0 → dirNW(8)
  ];
  return table[k + 1][i + 1];
}

/** ObjectIsChopableTree(obj, caAgeFull) (KM_ResMapElements.pas 46–60): the ageFull column. */
function isTreeAgeFull(obj: number): boolean {
  for (const t of CHOPABLE_TREES) if (t[3] === obj) return true;
  return false;
}

/** ObjectIsChoppableTree(obj) — any of the six columns (used for "tree-free" checks). */
function isChopableObj(obj: number): boolean {
  for (const t of CHOPABLE_TREES) for (const v of t) if (v === obj) return true;
  return false;
}

/** The species row whose column `col` matches obj, or null. */
function treeSpecies(obj: number, col: number): number[] | null {
  for (const t of CHOPABLE_TREES) if (t[col] === obj) return t;
  return null;
}

export class EconomyWorld {
  readonly houses: EconHouse[] = [];
  readonly units: EconUnit[] = [];
  readonly grid: PassGrid;
  readonly roadGrid: PassGrid;
  readonly events: SimEvent[] = [];
  readonly handCount: number;
  readonly houseSpecs: (HouseSpec | undefined)[];
  readonly serfCarry: AnimLoop[][];
  roadTileCount = 0;

  private readonly map: KaMap;
  private readonly unitSpecs: UnitSpec[];
  private readonly houseStates: HouseState[] = [];
  private readonly unitStates: UnitState[] = [];
  private readonly roadOverlay: Uint8Array;
  private readonly treeAge: Uint8Array;
  private readonly houseTile: Int32Array; // house uid per tile (0 = none), for ChopTree's stamp rule
  private readonly falling = new Map<number, number>(); // tile index → fall tick
  private readonly offers: Offer[][] = []; // per hand
  private readonly demands: Demand[][] = []; // per hand
  private walkConnect: Int32Array; // wcWalk component ids (rebuild on diagonal-blocking change)
  private walkConnectDirty = true;
  private rng = 1; // fixed v0 seed; the per-tick RunningTimer draw + task draws
  private tickNumber = 0;
  private uidCounter = 1;

  constructor(o: EconomyWorldOptions) {
    this.map = o.map;
    this.houseSpecs = o.houseSpecs;
    this.serfCarry = o.serfCarry;
    this.unitSpecs = o.unitSpecs;

    const { mapX, mapY } = o.map;
    const size = (mapX + 1) * (mapY + 1);
    this.grid = buildPassGrid(o.map, o.tiles, o.elems);
    this.roadOverlay = new Uint8Array(size);
    this.treeAge = new Uint8Array(size);
    this.houseTile = new Int32Array(size);
    this.walkConnect = new Int32Array(size);
    this.roadGrid = {
      mapX,
      mapY,
      walk: new Uint8Array(size),
      obj: this.grid.obj,
      height: this.grid.height,
      elems: this.grid.elems,
      tiles: this.grid.tiles,
    };

    // Hand count: gHands.Count after SET_MAX_PLAYER; extended defensively if an owner appears.
    let handCount = Math.max(1, o.mission.maxPlayers);
    for (const h of o.mission.houses) handCount = Math.max(handCount, h.owner + 1);
    for (const u of o.mission.units) if (u.owner >= 0) handCount = Math.max(handCount, u.owner + 1);
    this.handCount = handCount;
    for (let i = 0; i < handCount; i++) {
      this.offers.push([]);
      this.demands.push([]);
    }

    this.initTreeAges();
    this.buildHouses(o.mission);
    this.buildStreets(o.mission);
    this.buildUnits(o.mission);
    this.buildStoreWares(o.mission);
    this.buildDemands();
  }

  get tickCount(): number {
    return this.tickNumber;
  }

  /** Exposed for the CLI's state sha / debugging (the game's KaMRandom state). */
  get rngState(): number {
    return this.rng;
  }

  /** One game tick (see the header for the order). */
  tick(): void {
    this.tickNumber += 1;
    this.terrainUpdate();
    for (let hand = 0; hand < this.handCount; hand++) {
      for (let i = this.units.length - 1; i >= 0; i--) {
        const u = this.units[i];
        if (u.owner !== hand) continue;
        this.tickUnit(i);
      }
      for (let i = this.houses.length - 1; i >= 0; i--) {
        const h = this.houses[i];
        if (h.owner !== hand) continue;
        h.animStep += 1;
        h.workAnimStep += 1;
      }
      if (this.tickNumber % this.handCount === hand) this.logistics(hand);
    }
    this.rng = rngStep(this.rng); // RunningTimer: the one draw per tick
  }

  /** Tree object + age at a tile, or null when the tile has no chopable-tree object. */
  treeAt(x: number, y: number): { obj: number; age: number } | null {
    if (x < 0 || x > this.map.mapX || y < 0 || y > this.map.mapY) return null;
    const i = this.index(x, y);
    const obj = this.grid.obj[i];
    if (!isChopableObj(obj)) return null;
    return { obj, age: this.treeAge[i] };
  }

  /** Road overlay (toRoad) at a tile. */
  isRoadTile(x: number, y: number): boolean {
    if (x < 0 || x > this.map.mapX || y < 0 || y > this.map.mapY) return false;
    return this.roadOverlay[this.index(x, y)] === 1;
  }

  /** Wares held by a house: input + output slot counts (stores: the per-ware stock). */
  wareCount(h: EconHouse, ware: number): number {
    const idx = this.houses.indexOf(h);
    if (idx < 0) throw new Error(`wareCount: unknown house uid ${h.uid}`);
    const st = this.houseStates[idx];
    let n = 0;
    if (st.stock !== null && ware >= 0 && ware < WARE_CNT) n += st.stock[ware];
    if (st.spec !== undefined) {
      for (let i = 0; i < 4; i++) if (st.spec.resIn[i] === ware) n += h.wareIn[i];
      for (let i = 0; i < 4; i++) if (st.spec.resOut[i] === ware) n += h.wareOut[i];
    }
    return n;
  }

  /** The first house of a script-id type (optionally of one owner), in creation order. */
  findFirstHouse(typeId: number, owner?: number): EconHouse | null {
    for (const h of this.houses) {
      if (h.typeId === typeId && (owner === undefined || h.owner === owner)) return h;
    }
    return null;
  }

  /** Plant a tree object at a tile (demo scenario; refreshes the walk connectivity). */
  plantTree(x: number, y: number, obj: number, age: number): void {
    const i = this.index(x, y);
    const wasDiag = this.grid.elems[this.grid.obj[i]].diagonalBlocked;
    this.grid.obj[i] = obj;
    this.treeAge[i] = age;
    if (wasDiag !== this.grid.elems[obj].diagonalBlocked) this.walkConnectDirty = true;
  }

  /** Add a script demand (the demo store order; the mechanism the game's scripts use). */
  addScriptDemand(house: EconHouse, ware: number, count: number): void {
    const idx = this.houses.indexOf(house);
    if (idx < 0) throw new Error(`addScriptDemand: unknown house uid ${house.uid}`);
    if (ware < 0 || ware >= WARE_CNT) throw new Error(`addScriptDemand: bad ware ${ware}`);
    this.demands[house.owner].push({ houseIdx: idx, ware, slot: -1, script: true, count, being: 0 });
  }

  // -------------------------------------------------------------------------------------------
  // World build

  private index(x: number, y: number): number {
    return y * (this.map.mapX + 1) + x;
  }

  private inMapCoords(x: number, y: number): boolean {
    return x >= 1 && x <= this.map.mapX - 1 && y >= 1 && y <= this.map.mapY - 1;
  }

  /** TreeAge per tile from the object id (KM_Terrain.pas 535–538; full wins over age3). */
  private initTreeAges(): void {
    const g = this.grid;
    for (let y = 1; y <= this.map.mapY - 1; y++) {
      for (let x = 1; x <= this.map.mapX - 1; x++) {
        const i = this.index(x, y);
        const obj = g.obj[i];
        let age = 0;
        if (treeSpecies(obj, 0) !== null) age = 1;
        if (treeSpecies(obj, 1) !== null) age = TREE_AGE_1;
        if (treeSpecies(obj, 2) !== null) age = TREE_AGE_2;
        if (treeSpecies(obj, 3) !== null) age = TREE_AGE_FULL;
        this.treeAge[i] = age;
      }
    }
  }

  private buildHouses(mission: Mission): void {
    for (const mh of mission.houses) {
      const spec = this.houseSpecs[mh.typeId];
      const entrance = { x: mh.x + (spec !== undefined ? spec.entranceDx : 0), y: mh.y };
      const house: EconHouse = {
        uid: this.uidCounter++,
        typeId: mh.typeId,
        owner: mh.owner,
        x: mh.x,
        y: mh.y,
        entrance,
        state: 'empty',
        wareIn: [0, 0, 0, 0],
        wareOut: [0, 0, 0, 0],
        workerUid: 0,
        animStep: 0,
        workAnimStep: 0,
      };
      this.houses.push(house);

      const isStore = mh.typeId === 11; // htStore script id
      this.houseStates.push({
        spec,
        stock: isStore ? new Int32Array(WARE_CNT) : null,
        workerUid: 0,
        being: [0, 0, 0, 0],
        isStore,
      });

      // Footprint: BuildArea nonzero cells, row I = Y − pos.Y + 4, col K = X − pos.X + 3
      // (KM_Houses.pas 1109–1123) → tile (pos.X + K − 3, pos.Y + I − 4); remove from the walk grid.
      const plan = housePlan(mh.typeId);
      for (let I = 1; I <= 4; I++) {
        for (let K = 1; K <= 4; K++) {
          if (plan[I - 1][K - 1] === 0) continue;
          const tx = mh.x + K - 3;
          const ty = mh.y + I - 4;
          if (!this.inMapCoords(tx, ty)) continue;
          const i = this.index(tx, ty);
          this.grid.walk[i] = 0;
          this.houseTile[i] = house.uid;
        }
      }
    }
  }

  private buildStreets(mission: Mission): void {
    for (const s of mission.streets) {
      if (!this.inMapCoords(s.x, s.y)) continue;
      const i = this.index(s.x, s.y);
      if (this.roadOverlay[i] === 0) this.roadTileCount += 1;
      this.roadOverlay[i] = 1;
      // SetRoads (KM_Terrain.pas 2220–2227): remove wine/corn objects.
      if (this.grid.elems[this.grid.obj[i]].wineOrCorn) {
        this.grid.obj[i] = OBJ_NONE;
        this.treeAge[i] = 0;
      }
    }
    for (let i = 0; i < this.roadGrid.walk.length; i++) {
      this.roadGrid.walk[i] = this.grid.walk[i] === 1 && this.roadOverlay[i] === 1 ? 1 : 0;
    }
  }

  private buildUnits(mission: Mission): void {
    for (const mu of mission.units) {
      if (mu.owner < 0) continue; // animals: parsed, not spawned in v0 (spec 2.1)
      if (mu.typeId < 0 || mu.typeId >= this.unitSpecs.length) continue;
      const spec = this.unitSpecs[mu.typeId];
      const unit: EconUnit = {
        uid: this.uidCounter++,
        owner: mu.owner,
        type: mu.typeId,
        posF: { x: mu.x, y: mu.y },
        dir: 0,
        animStep: 0,
        action: 'stay',
        carry: -1,
        inside: false,
        homeUid: 0,
        taskKind: 'none',
      };
      this.units.push(unit);
      this.unitStates.push({
        spec,
        speed: walkSpeeds(spec.speedRaw),
        walk: null,
        actionLock: 0,
        locked: false,
        task: null,
        homeUid: 0,
      });
    }
  }

  private buildStoreWares(mission: Mission): void {
    for (const mw of mission.wares) {
      if (mw.ware < 0 || mw.ware >= WARE_CNT) continue;
      // !ADD_WARE targets the hand's first store (KM_MissionScript_Standard.pas 483).
      const store = this.houses.findIndex((h) => h.typeId === 11 && h.owner === mw.owner);
      if (store < 0) continue;
      const st = this.houseStates[store];
      if (st.stock === null) continue;
      st.stock[mw.ware] = Math.min(65535, st.stock[mw.ware] + mw.amount);
      this.addOffer(store, mw.ware, mw.amount); // the store's script wares become offers (96–112)
    }
  }

  /** One demand per real WareInput slot of every house (UpdateDemands, KM_Houses.pas 2221–2277). */
  private buildDemands(): void {
    for (let idx = 0; idx < this.houses.length; idx++) {
      const h = this.houses[idx];
      const spec = this.houseStates[idx].spec;
      if (spec === undefined) continue;
      for (let slot = 0; slot < 4; slot++) {
        if (spec.resIn[slot] < 0) continue;
        this.demands[h.owner].push({ houseIdx: idx, ware: spec.resIn[slot], slot, script: false, count: 0, being: 0 });
      }
    }
  }

  // -------------------------------------------------------------------------------------------
  // RNG helpers (KaMRandom, KM_CommonUtils.pas 1425–1558)

  private draw(): number {
    this.rng = rngStep(this.rng);
    return this.rng / RNG_M;
  }

  private drawN(n: number): number {
    return Math.floor(this.draw() * n);
  }

  private drawS1(max: number): number {
    return Math.floor(this.draw() * Math.round(max * 10000)) / 10000;
  }

  private emit(kind: string, detail: string): void {
    this.events.push({ tick: this.tickNumber, text: `${kind} ${detail}` });
  }

  // -------------------------------------------------------------------------------------------
  // Terrain (KM_Terrain.pas 5410–5498)

  private terrainUpdate(): void {
    const step = this.tickNumber; // Inc(fAnimStep) at the start of UpdateState

    // Falling trees: ChopTree when fAnimStep >= Tag2 + Anim.Count − 1.
    for (const [i, fallTick] of [...this.falling]) {
      if (step >= fallTick + FALL_TICKS) {
        this.chopTree(i);
        this.falling.delete(i);
      }
    }

    // Growth: every tile is processed once per TERRAIN_PACE, offset by fAnimStep.
    const mapX = this.map.mapX;
    const total = mapX * this.map.mapY;
    for (let a = step % TERRAIN_PACE; a < total; a += TERRAIN_PACE) {
      const x = (a % mapX) + 1;
      const y = Math.floor(a / mapX) + 1;
      const i = this.index(x, y);
      const age = this.treeAge[i];
      if (age >= 1 && age <= TREE_AGE_FULL) {
        const next = age + 1;
        this.treeAge[i] = next;
        if (next === TREE_AGE_1 || next === TREE_AGE_2 || next === TREE_AGE_FULL) {
          for (const t of CHOPABLE_TREES) {
            for (let col = 0; col <= 2; col++) {
              if (this.grid.obj[i] === t[col]) {
                if (next === TREE_AGE_1) this.grid.obj[i] = t[1];
                else if (next === TREE_AGE_2) this.grid.obj[i] = t[2];
                else this.grid.obj[i] = t[3];
              }
            }
          }
        }
      }
    }
  }

  /** FallTree (KM_Terrain.pas 3233–3251): object → stump now, ChopTree after the fall anim. */
  private fallTree(x: number, y: number): boolean {
    const i = this.index(x, y);
    const obj = this.grid.obj[i];
    for (const t of CHOPABLE_TREES) {
      if (t[3] === obj) {
        this.grid.obj[i] = t[5];
        this.falling.set(i, this.tickNumber);
        return true;
      }
    }
    return false;
  }

  /** ChopTree (KM_Terrain.pas 3255–3292): TreeAge 0; the stump may be removed at a house entrance. */
  private chopTree(i: number): void {
    this.treeAge[i] = 0;
    const stride = this.map.mapX + 1;
    const x = i % stride;
    const y = Math.floor(i / stride);
    // removeStamp when the stump would block a house entrance (3263–3285)
    const h1 = x - 1 >= 1 && y - 1 >= 1 ? this.houseTile[this.index(x - 1, y - 1)] : 0;
    const h2 = y - 1 >= 1 ? this.houseTile[this.index(x, y - 1)] : 0;
    let removeStamp = false;
    if (h1 !== 0) {
      const h = this.houses[h1 - 1];
      if (h.entrance.x === x - 1 && h.entrance.y + 1 === y) removeStamp = true;
    }
    if (!removeStamp && h2 !== 0) {
      const h = this.houses[h2 - 1];
      if (h.entrance.x === x && h.entrance.y + 1 === y) removeStamp = true;
    }
    if (removeStamp) this.grid.obj[i] = OBJ_NONE;
    // Diagonal blocking may have opened: refresh the walk connectivity lazily.
    this.walkConnectDirty = true;
  }

  // -------------------------------------------------------------------------------------------
  // Walk connectivity (RouteCanBeMade / UpdateWalkConnect semantics over tpWalk)

  private connectIds(): Int32Array {
    if (!this.walkConnectDirty) return this.walkConnect;
    const g = this.grid;
    const stride = g.mapX + 1;
    this.walkConnect.fill(0);
    let id = 0;
    const stack: number[] = [];
    for (let y = 1; y <= g.mapY - 1; y++) {
      for (let x = 1; x <= g.mapX - 1; x++) {
        const start = this.index(x, y);
        if (this.walkConnect[start] !== 0 || !tileWalkable(g, x, y)) continue;
        id += 1;
        this.walkConnect[start] = id;
        stack.push(start);
        while (stack.length > 0) {
          const cur = stack.pop() as number;
          const cx = cur % stride;
          const cy = Math.floor(cur / stride);
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              if (dx === 0 && dy === 0) continue;
              const nx = cx + dx;
              const ny = cy + dy;
              if (!tileWalkable(g, nx, ny)) continue;
              const ni = this.index(nx, ny);
              if (this.walkConnect[ni] !== 0) continue;
              if (dx !== 0 && dy !== 0 && !canWalkDiagonal(g, { x: cx, y: cy }, nx, ny)) continue;
              this.walkConnect[ni] = id;
              stack.push(ni);
            }
          }
        }
      }
    }
    this.walkConnectDirty = false;
    return this.walkConnect;
  }

  /** RouteCanBeMade(a, b, tpWalk): both tiles walkable and in the same walk component. */
  private routeCanBeMade(a: Pt, b: Pt): boolean {
    if (!tileWalkable(this.grid, a.x, a.y) || !tileWalkable(this.grid, b.x, b.y)) return false;
    const ids = this.connectIds();
    return ids[this.index(a.x, a.y)] === ids[this.index(b.x, b.y)];
  }

  /** RouteCanBeMadeToVertex: a route to any of the four corners of a vertex (4157–4166). */
  private routeCanBeMadeToVertex(a: Pt, b: Pt): boolean {
    for (let i = Math.max(b.y - 1, 1); i <= b.y; i++) {
      for (let k = Math.max(b.x - 1, 1); k <= b.x; k++) {
        if (this.routeCanBeMade(a, { x: k, y: i })) return true;
      }
    }
    return false;
  }

  // -------------------------------------------------------------------------------------------
  // Unit tick (KM_Units.pas 2560–2683 + the task machines)

  private refreshKind(u: EconUnit, st: UnitState): void {
    if (st.task !== null) u.taskKind = st.task.kind;
    else if (u.type === 0) u.taskKind = 'idle';
    else u.taskKind = 'none';
  }

  private tickUnit(idx: number): void {
    const u = this.units[idx];
    const st = this.unitStates[idx];

    if (st.walk !== null) {
      const r = walkTick(this.grid, st.walk, u.posF, st.speed);
      if (r.dir !== 0) u.dir = r.dir;
      u.animStep += r.animStep;
      if (r.status === 'walking') return; // the action continues: the task is skipped
      st.walk = null;
      u.action = 'stay';
    } else if (st.actionLock > 0) {
      st.actionLock -= 1;
      if (st.actionLock > 0) return; // still locked: the task is skipped
    }

    if (st.task !== null) {
      const res = this.runTask(u, st, st.task);
      if (res === 'continues') {
        this.refreshKind(u, st);
        return;
      }
      st.task = null;
    }
    this.unitLogic(u, st);
    this.refreshKind(u, st);
  }

  private setLockedStay(u: EconUnit, st: UnitState, ticks: number, work: boolean): void {
    st.actionLock = ticks;
    st.locked = true;
    u.action = 'stay';
    if (work) u.animStep += 1; // SetActionLockedStay(..., False): the anim advances
  }

  private setUnlockedStay(u: EconUnit, st: UnitState, ticks: number): void {
    st.actionLock = ticks;
    st.locked = false;
    u.action = 'stay';
  }

  private goIn(u: EconUnit, st: UnitState, h: EconHouse): void {
    u.inside = true;
    u.posF = { x: h.entrance.x, y: h.entrance.y };
    st.actionLock = 0; // a 1-tick transition (v0)
    st.locked = false;
    u.action = 'stay';
  }

  private goOut(u: EconUnit, st: UnitState, h: EconHouse): void {
    u.inside = false;
    u.posF = pointBelowEntrance(h);
    st.actionLock = 0;
    st.locked = false;
    u.action = 'stay';
  }

  private startWalkTo(u: EconUnit, st: UnitState, to: Pt): boolean {
    const from = { x: Math.round(u.posF.x), y: Math.round(u.posF.y) };
    const w = startWalk(this.grid, from, to);
    if (w === null) return false;
    st.walk = w;
    u.action = 'walk';
    return true;
  }

  private runTask(u: EconUnit, st: UnitState, task: Task): 'continues' | 'done' {
    switch (task.kind) {
      case 'goHome':
        return this.runGoHome(u, st, task);
      case 'chop':
        return this.runChop(u, st, task);
      case 'saw':
        return this.runSaw(u, st, task);
      case 'deliver':
        return this.runDeliver(u, st, task);
      default:
        return 'done';
    }
  }

  private runGoHome(u: EconUnit, st: UnitState, task: { phase: number }): 'continues' | 'done' {
    const home = this.houses[st.homeUid - 1];
    switch (task.phase) {
      case 0: {
        // Walk to Home.PointBelowEntrance (KM_UnitTaskGoHome.pas 51–54).
        const target = pointBelowEntrance(home);
        if (samePoint({ x: Math.round(u.posF.x), y: Math.round(u.posF.y) }, target)) {
          st.actionLock = 1; // a zero-length walk still costs its action tick
        } else if (!this.startWalkTo(u, st, target)) {
          return 'done';
        }
        task.phase = 1;
        return 'continues';
      }
      case 1:
        this.goIn(u, st, home);
        task.phase = 2;
        return 'continues';
      case 2:
        home.state = 'idle';
        this.setUnlockedStay(u, st, 5);
        task.phase = 3;
        return 'continues';
      default:
        return 'done';
    }
  }

  private runChop(
    u: EconUnit,
    st: UnitState,
    task: { phase: number; plan: ChopPlan | null; distant: boolean },
  ): 'continues' | 'done' {
    const home = this.houses[st.homeUid - 1];
    switch (task.phase) {
      case 0: // go outside (KM_UnitTaskMining.pas 247–256)
        this.goOut(u, st, home);
        task.phase = 1;
        return 'continues';
      case 1: {
        const plan = task.plan;
        if (plan === null) return 'done';
        if (!this.startWalkTo(u, st, plan.loc)) {
          return this.replan(u, st, task);
        }
        task.phase = 2;
        return 'continues';
      }
      case 2: {
        const plan = task.plan;
        if (plan === null) return 'done';
        const spot = { x: Math.round(u.posF.x), y: Math.round(u.posF.y) };
        const tree = vertexTile(plan.loc, plan.dir);
        const treeObj = this.treeAt(tree.x, tree.y);
        if (!samePoint(spot, plan.loc) || treeObj === null || !isTreeAgeFull(treeObj.obj) || treeObj.age < TREE_AGE_FULL) {
          return this.replan(u, st, task);
        }
        this.setLockedStay(u, st, 0, false);
        task.phase = 3;
        return 'continues';
      }
      case 3: // before-work stay (KM_UnitTaskMining.pas 281)
        this.setLockedStay(u, st, 0, false);
        task.phase = 4;
        return 'continues';
      case 4: {
        // Choose direction and time to work (283–298): TimeToWork = WorkCyc × max(count, 1).
        const plan = task.plan;
        if (plan === null) return 'done';
        let dir = plan.dir;
        const spec = st.spec;
        if (spec.anim.length > 1) {
          if (spec.anim[1][dir - 1].count < 1) {
            for (let d = 1; d <= 8; d++) {
              if (spec.anim[1][d - 1].count > 1) {
                dir = d;
                break;
              }
            }
          }
        }
        if (dir >= 1 && dir <= 8) u.dir = dir;
        const count = spec.anim.length > 1 ? spec.anim[1][dir - 1].count : 0;
        const timeToWork = 15 * Math.max(count, 1); // WalkStyle(..., uaWork, 15, 20, ...)
        this.setLockedStay(u, st, timeToWork, true);
        task.phase = 5;
        return 'continues';
      }
      case 5: // wait for the tree to start falling (301)
        this.setLockedStay(u, st, 10, true);
        task.phase = 6;
        return 'continues';
      case 6: {
        // FallTree (324–327) + AfterWorkDelay stay.
        const plan = task.plan;
        if (plan === null) return 'done';
        const tree = vertexTile(plan.loc, plan.dir);
        task.distant = this.fallTree(tree.x, tree.y);
        if (task.distant) this.emit('tree-fell', `(${tree.x},${tree.y})`);
        this.setLockedStay(u, st, 20, true);
        task.phase = 7;
        return 'continues';
      }
      case 7: {
        // Go home (333).
        const target = pointBelowEntrance(home);
        if (samePoint({ x: Math.round(u.posF.x), y: Math.round(u.posF.y) }, target)) {
          st.actionLock = 1;
        } else if (!this.startWalkTo(u, st, target)) {
          return 'done';
        }
        task.phase = 8;
        return 'continues';
      }
      case 8:
        this.goIn(u, st, home);
        task.phase = 9;
        return 'continues';
      case 9: {
        // Back at home (339–366): take resources (none), skip work (ActCount = 0).
        home.state = 'work';
        task.phase = 35; // SKIP_WORK
        this.setLockedStay(u, st, 0, false);
        return 'continues';
      }
      case 35: {
        // WareAddToOut(wtTrunk, ResProductionX) + hstIdle + AfterWorkIdle−1 (413–424).
        if (task.distant) {
          const slot = this.outSlot(home, WT_TRUNK);
          if (slot >= 0) {
            home.wareOut[slot] += 1;
            this.addOffer(this.houses.indexOf(home), WT_TRUNK, 1);
            this.emit('trunk-out', `hut#${home.uid} ${home.wareOut[slot]}`);
          }
        }
        home.state = 'idle';
        this.setLockedStay(u, st, this.afterWorkIdle(home), false);
        task.phase = 36;
        return 'continues';
      }
      default:
        return 'done';
    }
  }

  private replan(
    u: EconUnit,
    st: UnitState,
    task: { phase: number; plan: ChopPlan | null; distant: boolean },
  ): 'continues' | 'done' {
    const home = this.houses[st.homeUid - 1];
    const plan = this.chooseChopPlan(home, st);
    if (plan === null) return 'done'; // no other work plan (KM_UnitTaskMining.pas 141–159)
    task.plan = plan;
    task.phase = 1; // re-walk to the new spot
    this.setLockedStay(u, st, 0, false);
    this.emit('chop-plan', `tree=(${vertexTile(plan.loc, plan.dir).x},${vertexTile(plan.loc, plan.dir).y})`);
    return 'continues';
  }

  private runSaw(u: EconUnit, st: UnitState, task: { phase: number; phase2: number }): 'continues' | 'done' {
    const home = this.houses[st.homeUid - 1];
    const spec = this.houseStates[st.homeUid - 1].spec;
    const anim = (act: number): number => (spec !== undefined ? spec.animCounts[act] : 0);
    switch (task.phase) {
      case 0: // HasToWalk = False → skip to phase 9 (KM_UnitTaskMining.pas 257–263)
        this.setLockedStay(u, st, 0, false);
        task.phase = 9;
        return 'continues';
      case 9: {
        // Take the input ware + first house act. Stay T1 (frozen cycle decomposition, see header).
        const slot = this.inSlot(home, WT_TRUNK);
        if (slot >= 0 && home.wareIn[slot] > 0) home.wareIn[slot] -= 1;
        home.state = 'work';
        home.workAnimStep = 0;
        this.emit('trunk-taken', `sawmill#${home.uid} in=${slot >= 0 ? home.wareIn[slot] : 0}`);
        this.setLockedStay(u, st, anim(0), true);
        task.phase2 = 0;
        task.phase = 10;
        return 'continues';
      }
      case 10:
        task.phase2 += 1;
        if (task.phase2 < 3) {
          home.workAnimStep = 0;
          // SubActAdd(haWork2, 25) → TimeToWork = Count × 25 (KM_UnitWorkPlan.pas 380).
          this.setLockedStay(u, st, anim(1) * 25, true);
          task.phase = 11;
          return 'continues';
        }
        task.phase = 35;
        this.setLockedStay(u, st, 0, false);
        return 'continues';
      case 11:
        task.phase2 += 1;
        if (task.phase2 < 3) {
          home.workAnimStep = 0;
          this.setLockedStay(u, st, Math.max(anim(4) - 1, 0), true);
          task.phase = 12;
          return 'continues';
        }
        task.phase = 35;
        this.setLockedStay(u, st, 0, false);
        return 'continues';
      case 12:
        task.phase = 35;
        this.setLockedStay(u, st, 0, false);
        return 'continues';
      case 35: {
        // WareAddToOut(wtTimber, ResProductionX = 2) + hstIdle + WorkerRest*10−1.
        const slot = this.outSlot(home, WT_TIMBER);
        const prod = spec !== undefined ? spec.productionX : 1;
        if (slot >= 0) {
          home.wareOut[slot] += prod;
          this.addOffer(this.houses.indexOf(home), WT_TIMBER, prod);
          this.emit('timber-out', `sawmill#${home.uid} ${home.wareOut[slot]}`);
        }
        home.state = 'idle';
        this.setLockedStay(u, st, this.afterWorkIdle(home), false);
        task.phase = 36;
        return 'continues';
      }
      default:
        return 'done';
    }
  }

  private abandonDelivery(task: { fromIdx: number; ware: number; demand: Demand; taken: boolean }): void {
    task.demand.being -= 1;
    if (task.taken) {
      // Put the ware back into the offer house so it can be re-offered (the game's RemOffer path).
      const from = this.houses[task.fromIdx];
      const st = this.houseStates[task.fromIdx];
      if (st.stock !== null) {
        st.stock[task.ware] = Math.min(65535, st.stock[task.ware] + 1);
        this.addOffer(task.fromIdx, task.ware, 1);
      } else {
        const slot = this.outSlot(from, task.ware);
        if (slot >= 0) from.wareOut[slot] += 1;
        this.addOffer(task.fromIdx, task.ware, 1);
      }
    }
  }

  private runDeliver(
    u: EconUnit,
    st: UnitState,
    task: { phase: number; fromIdx: number; toIdx: number; ware: number; demand: Demand; taken: boolean },
  ): 'continues' | 'done' {
    const from = this.houses[task.fromIdx];
    const to = this.houses[task.toIdx];
    switch (task.phase) {
      case 0: {
        const target = pointBelowEntrance(from);
        if (samePoint({ x: Math.round(u.posF.x), y: Math.round(u.posF.y) }, target)) {
          st.actionLock = 1;
        } else if (!this.startWalkTo(u, st, target)) {
          this.abandonDelivery(task);
          return 'done';
        }
        task.phase = 1;
        return 'continues';
      }
      case 1:
        this.goIn(u, st, from);
        task.phase = 2;
        return 'continues';
      case 2: {
        // Take the ware (KM_UnitTaskDelivery.pas 372–388) + stay 5.
        if (!this.takeFromOut(from, task.ware)) {
          this.abandonDelivery(task);
          return 'done';
        }
        task.taken = true;
        u.carry = task.ware;
        this.setLockedStay(u, st, 5, false);
        task.phase = 3;
        return 'continues';
      }
      case 3:
        this.goOut(u, st, from);
        task.phase = 5;
        return 'continues';
      case 5: {
        const target = pointBelowEntrance(to);
        if (samePoint({ x: Math.round(u.posF.x), y: Math.round(u.posF.y) }, target)) {
          st.actionLock = 1;
        } else if (!this.startWalkTo(u, st, target)) {
          this.abandonDelivery(task);
          return 'done';
        }
        task.phase = 6;
        return 'continues';
      }
      case 6:
        this.goIn(u, st, to);
        task.phase = 7;
        return 'continues';
      case 7:
        this.setLockedStay(u, st, 5, false);
        task.phase = 8;
        return 'continues';
      case 8: {
        // WareAddToIn + CarryTake + GaveDemand (422–449).
        this.addToIn(to, task.ware);
        u.carry = -1;
        task.demand.being -= 1;
        if (task.demand.script) task.demand.count -= 1;
        this.emit('ware-delivered', `ware=${task.ware} house#${to.uid}`);
        this.goOut(u, st, to);
        task.phase = 9;
        return 'continues';
      }
      default:
        return 'done';
    }
  }

  // -------------------------------------------------------------------------------------------
  // Unit-specific logic (KM_Units.pas 602–674 + 915–946)

  private unitLogic(u: EconUnit, st: UnitState): void {
    if (st.homeUid === 0) {
      if (u.type === 0) {
        // Idle serf: 1 KaMRandom(2) draw + stay 60 (KM_Units.pas 933–941).
        this.drawN(2);
        this.setUnlockedStay(u, st, 60);
        return;
      }
      // Settled unit: find a home (KM_Units.pas 640–651, KM_HouseCollection.pas 240–276).
      const home = this.findEmptyHouse(u);
      if (home !== null) {
        st.homeUid = home.uid;
        u.homeUid = home.uid;
        if (home.typeId !== 21) {
          // barracks takes many (SetWorker is skipped for htBarracks, KM_Units.pas 471–472)
          this.houseStates[this.houses.indexOf(home)].workerUid = u.uid;
          home.workerUid = u.uid;
        }
        this.emit('worker-assigned', `unit#${u.uid} type=${u.type} house#${home.uid}`);
        st.task = { kind: 'goHome', phase: 0 };
        return;
      }
      this.setUnlockedStay(u, st, 20); // no home yet: don't sleep too long (651)
      return;
    }

    const home = this.houses[st.homeUid - 1];
    if (!u.inside) {
      // Visible with a home: go back in (654–659).
      if (this.routeCanBeMade({ x: Math.round(u.posF.x), y: Math.round(u.posF.y) }, pointBelowEntrance(home))) {
        st.task = { kind: 'goHome', phase: 0 };
      } else {
        this.setUnlockedStay(u, st, 60);
      }
      return;
    }

    // At home: get work (661–668).
    this.taskGetWork(u, st, home);
  }

  private findEmptyHouse(u: EconUnit): EconHouse | null {
    let best: EconHouse | null = null;
    let bestDist = Number.POSITIVE_INFINITY;
    for (let idx = 0; idx < this.houses.length; idx++) {
      const h = this.houses[idx];
      const hs = this.houseStates[idx];
      if (hs.spec === undefined) continue;
      if (hs.spec.workerType !== u.type) continue;
      // A barracks holds many recruits (SetWorker is skipped for htBarracks, KM_Units.pas 471–472).
      if (h.typeId !== 21 && hs.workerUid !== 0) continue;
      if (!this.routeCanBeMade({ x: Math.round(u.posF.x), y: Math.round(u.posF.y) }, pointBelowEntrance(h))) continue;
      const dist = euclid({ x: Math.round(u.posF.x), y: Math.round(u.posF.y) }, { x: h.x, y: h.y });
      if (dist < bestDist) {
        bestDist = dist;
        best = h;
      }
    }
    return best;
  }

  /** TaskGetWork (KM_Units.pas 704–753) for the v0 slice: woodcutter at the hut, carpenter at the sawmill. */
  private taskGetWork(u: EconUnit, st: UnitState, home: EconHouse): void {
    if (u.type === 1 && home.typeId === 9) {
      // Woodcutter at htWoodcutters: refuse when the output is full (748–752 / 724–728).
      const outSlot = this.outSlot(home, WT_TRUNK);
      if (outSlot >= 0 && home.wareOut[outSlot] >= MAX_WARES_IN_HOUSE) {
        this.setUnlockedStay(u, st, this.restStay(home));
        return;
      }
      const plan = this.chooseChopPlan(home, st);
      if (plan === null) {
        this.setUnlockedStay(u, st, this.restStay(home));
        return;
      }
      st.task = { kind: 'chop', phase: 0, plan, distant: false };
      this.emit('chop-plan', `tree=(${vertexTile(plan.loc, plan.dir).x},${vertexTile(plan.loc, plan.dir).y})`);
      return;
    }

    if (u.type === 5 && home.typeId === 0) {
      // Carpenter at htSawmill: needs 1 trunk in and room for the output (746–749).
      const inSlot = this.inSlot(home, WT_TRUNK);
      const outSlot = this.outSlot(home, WT_TIMBER);
      const hasTrunk = inSlot >= 0 && home.wareIn[inSlot] >= 1;
      const hasRoom = outSlot < 0 || home.wareOut[outSlot] < MAX_WARES_IN_HOUSE;
      if (hasTrunk && hasRoom) {
        st.task = { kind: 'saw', phase: 0, phase2: 0 };
        return;
      }
      this.setUnlockedStay(u, st, this.restStay(home));
      return;
    }

    // Every other (worker, house) combination is out of v0 scope: rest at home.
    this.setUnlockedStay(u, st, this.restStay(home));
  }

  private restStay(home: EconHouse): number {
    const spec = this.houseStates[this.houses.indexOf(home)].spec;
    const rest = spec !== undefined ? spec.workerRest : WORKER_REST_DEFAULT;
    return Math.max(rest, 1) * 10;
  }

  private afterWorkIdle(home: EconHouse): number {
    const spec = this.houseStates[this.houses.indexOf(home)].spec;
    const rest = spec !== undefined ? spec.workerRest : WORKER_REST_DEFAULT;
    return Math.max(rest * 10 - 1, 0);
  }

  // -------------------------------------------------------------------------------------------
  // House ware handshakes (KM_Houses.pas 1710–2010, KM_HouseStore.pas 96–112)

  private inSlot(h: EconHouse, ware: number): number {
    const spec = this.houseStates[this.houses.indexOf(h)].spec;
    if (spec === undefined) return -1;
    for (let i = 0; i < 4; i++) if (spec.resIn[i] === ware) return i;
    return -1;
  }

  private outSlot(h: EconHouse, ware: number): number {
    const spec = this.houseStates[this.houses.indexOf(h)].spec;
    if (spec === undefined) return -1;
    for (let i = 0; i < 4; i++) if (spec.resOut[i] === ware) return i;
    return -1;
  }

  private addOffer(houseIdx: number, ware: number, count: number): void {
    if (count === 0) return;
    const list = this.offers[this.houses[houseIdx].owner];
    for (const o of list) {
      if (o.houseIdx === houseIdx && o.ware === ware) {
        o.count += count;
        return;
      }
    }
    list.push({ houseIdx, ware, count });
  }

  private takeFromOut(h: EconHouse, ware: number): boolean {
    const idx = this.houses.indexOf(h);
    const st = this.houseStates[idx];
    if (st.stock !== null) {
      if (st.stock[ware] <= 0) return false;
      st.stock[ware] -= 1;
      return true;
    }
    const slot = this.outSlot(h, ware);
    if (slot < 0 || h.wareOut[slot] <= 0) return false;
    h.wareOut[slot] -= 1;
    return true;
  }

  private addToIn(h: EconHouse, ware: number): void {
    const idx = this.houses.indexOf(h);
    const st = this.houseStates[idx];
    if (st.stock !== null) {
      // Store (KM_HouseStore.pas 96–112): clamp the stock and create an offer.
      st.stock[ware] = Math.min(65535, st.stock[ware] + 1);
      this.addOffer(idx, ware, 1);
      return;
    }
    const slot = this.inSlot(h, ware);
    if (slot >= 0) h.wareIn[slot] += 1;
  }

  // -------------------------------------------------------------------------------------------
  // Logistics (v0 rule, spec 2.7)

  private demandAvailable(d: Demand): number {
    if (d.script) return Math.max(d.count - d.being, 0);
    const h = this.houses[d.houseIdx];
    const cap = MAX_WARES_IN_HOUSE; // GetWareDistribution default 5 (KM_WareDistribution.pas 71–88)
    return clamp(cap - h.wareIn[d.slot] - d.being, 0, MAX_WARES_IN_HOUSE);
  }

  private isIdleSerf(idx: number): boolean {
    const u = this.units[idx];
    const st = this.unitStates[idx];
    if (u.type !== 0) return false;
    if (st.task !== null || st.walk !== null) return false;
    if (st.locked) return false;
    return true;
  }

  private logistics(hand: number): void {
    const idle: number[] = [];
    for (let i = 0; i < this.units.length; i++) {
      const u = this.units[i];
      if (u.owner === hand && this.isIdleSerf(i)) idle.push(i);
    }
    if (idle.length === 0) return;

    const demands = this.demands[hand];
    const offers = this.offers[hand];

    for (;;) {
      // Wares that still have an available demand — cheap pre-filter, so most passes do no BFS.
      const wanted = new Set<number>();
      for (const d of demands) if (this.demandAvailable(d) > 0) wanted.add(d.ware);
      if (wanted.size === 0) break;

      // Offer houses that could serve some demand (one road BFS per house per pass, cached).
      const distCache = new Map<number, Int32Array>();
      const offerHouses: number[] = [];
      for (const o of offers) {
        if (o.count <= 0 || !wanted.has(o.ware)) continue;
        if (!offerHouses.includes(o.houseIdx)) offerHouses.push(o.houseIdx);
      }
      if (offerHouses.length === 0) break;
      const distances = (houseIdx: number): Int32Array => {
        let d = distCache.get(houseIdx);
        if (d === undefined) {
          d = this.roadDistances(pointBelowEntrance(this.houses[houseIdx]));
          distCache.set(houseIdx, d);
        }
        return d;
      };

      let assigned = false;
      for (const offer of offers) {
        if (offer.count <= 0) continue;
        const offerHouse = this.houses[offer.houseIdx];
        const dist = distances(offer.houseIdx);

        // Nearest valid demand by road distance (roadGrid BFS).
        let bestDemand: Demand | null = null;
        let bestDist = Number.POSITIVE_INFINITY;
        for (const d of demands) {
          if (d.ware !== offer.ware) continue;
          if (d.houseIdx === offer.houseIdx) continue; // no same-house deliveries
          if (this.demandAvailable(d) <= 0) continue;
          const dHouse = this.houses[d.houseIdx];
          if (offerHouse.typeId === 11 && dHouse.typeId === 11) continue; // no store→store (v0)
          const target = pointBelowEntrance(dHouse);
          const dd = dist[this.index(target.x, target.y)];
          if (dd < 0) continue; // no road route
          if (dd < bestDist) {
            bestDist = dd;
            bestDemand = d;
          }
        }
        if (bestDemand === null) continue;

        // Nearest idle eligible serf (tpWalk route to the offer house).
        let bestSerf = -1;
        let bestLen = Number.POSITIVE_INFINITY;
        for (const si of idle) {
          const su = this.units[si];
          const from = { x: Math.round(su.posF.x), y: Math.round(su.posF.y) };
          const route = findPath(this.grid, from, pointBelowEntrance(offerHouse));
          if (route === null) continue;
          if (route.length < bestLen) {
            bestLen = route.length;
            bestSerf = si;
          }
        }
        if (bestSerf < 0) continue;

        // Assign (TKMDeliveries.AssignDelivery 2151–2194).
        offer.count -= 1;
        bestDemand.being += 1;
        const su = this.units[bestSerf];
        const sst = this.unitStates[bestSerf];
        sst.task = {
          kind: 'deliver',
          phase: 0,
          fromIdx: offer.houseIdx,
          toIdx: bestDemand.houseIdx,
          ware: offer.ware,
          demand: bestDemand,
          taken: false,
        };
        sst.walk = null;
        sst.actionLock = 0;
        sst.locked = false;
        su.action = 'stay';
        su.taskKind = 'deliver';
        this.emit(
          'delivery-assigned',
          `ware=${offer.ware} house#${offerHouse.uid}->house#${this.houses[bestDemand.houseIdx].uid}`,
        );
        const at = idle.indexOf(bestSerf);
        if (at >= 0) idle.splice(at, 1);
        assigned = true;
        break;
      }

      if (!assigned) break;
    }
  }

  /** BFS road distances (in steps, 8-directional) from a tile; −1 = unreachable. */
  private roadDistances(from: Pt): Int32Array {
    const g = this.roadGrid;
    const stride = g.mapX + 1;
    const dist = new Int32Array((g.mapX + 1) * (g.mapY + 1)).fill(-1);
    if (!tileWalkable(g, from.x, from.y)) return dist;
    const queue: number[] = [this.index(from.x, from.y)];
    dist[queue[0]] = 0;
    let head = 0;
    while (head < queue.length) {
      const cur = queue[head++];
      const cx = cur % stride;
      const cy = Math.floor(cur / stride);
      const d = dist[cur];
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = cx + dx;
          const ny = cy + dy;
          if (!tileWalkable(g, nx, ny)) continue;
          const ni = this.index(nx, ny);
          if (dist[ni] >= 0) continue;
          if (dx !== 0 && dy !== 0 && !canWalkDiagonal(g, { x: cx, y: cy }, nx, ny)) continue;
          dist[ni] = d + 1;
          queue.push(ni);
        }
      }
    }
    return dist;
  }

  // -------------------------------------------------------------------------------------------
  // Chop plan (KM_UnitWorkPlan.pas 187–237, 240–283; KM_Terrain.pas 2823–2869)

  private chooseChopPlan(home: EconHouse, st: UnitState): ChopPlan | null {
    const center = pointBelowEntrance(home); // flag point default (KM_Houses.pas 2554)
    const radius = st.spec.miningRange ?? 0;
    const treeList = this.findTrees(center, radius);
    if (treeList.length === 0) return null;

    // Decision (KM_UnitWorkPlan.pas 201–209): 1 draw per the frozen v0 RNG contract. With no
    // plant candidates (v0) the Pascal rule always chops when a tree is available.
    this.draw();
    // Pick (GetWeightedRandom, KM_CommonClasses.pas 1312–1338): weight BASE_VAL / distance.
    let sum = 0;
    const weights: number[] = [];
    for (const t of treeList) {
      const len = euclid(center, t.loc);
      const w = len === 0 ? BASE_VAL * 2 : BASE_VAL / len;
      weights.push(w);
      sum += w;
    }
    let rnd = this.drawS1(sum);
    for (let i = 0; i < treeList.length; i++) {
      if (rnd < weights[i]) return treeList[i];
      rnd -= weights[i];
    }
    return treeList[treeList.length - 1];
  }

  /** FindTree (KM_Terrain.pas 2823–2869): full-age trees with a valid cutting spot, in floodfill order. */
  private findTrees(center: Pt, radius: number): ChopPlan[] {
    const out: ChopPlan[] = [];
    const tiles = this.tilesWithinDistance(center, radius);
    for (const t of tiles) {
      const obj = this.treeAt(t.x, t.y);
      if (obj === null || !isTreeAgeFull(obj.obj) || obj.age < TREE_AGE_FULL) continue;
      if (!this.canCutTreeAtVertex(center, t)) continue;
      const spot = this.chooseCuttingDirection(center, t);
      if (spot === null) continue;
      out.push(spot);
    }
    return out;
  }

  /** GetTilesWithinDistance (KM_TerrainFinder.pas 215–268): DFS floodfill, 5/7 costs, r*5 limit. */
  private tilesWithinDistance(center: Pt, radius: number): Pt[] {
    const g = this.grid;
    const out: Pt[] = [];
    const w = 2 * radius + 1;
    const visited = new Uint8Array(w * w).fill(255);
    const visit = (x: number, y: number, wd: number): void => {
      if (wd > radius * 5) return;
      if (!tileWalkable(g, x, y)) return;
      const vx = center.x - x + radius;
      const vy = center.y - y + radius;
      if (vx < 0 || vx >= w || vy < 0 || vy >= w) return;
      if (wd >= visited[vy * w + vx]) return;
      if (visited[vy * w + vx] === 255) out.push({ x, y });
      visited[vy * w + vx] = wd;
      const objAt = (ax: number, ay: number): number => {
        if (ax < 0 || ax > g.mapX || ay < 0 || ay > g.mapY) return OBJ_NONE;
        return g.obj[this.index(ax, ay)];
      };
      if (x - 1 >= 1) {
        if (y - 1 >= 1 && !g.elems[objAt(x, y)].diagonalBlocked) visit(x - 1, y - 1, wd + 7);
        visit(x - 1, y, wd + 5);
        if (y + 1 <= g.mapY && !g.elems[objAt(x, y + 1)].diagonalBlocked) visit(x - 1, y + 1, wd + 7);
      }
      if (y - 1 >= 1) visit(x, y - 1, wd + 5);
      if (y + 1 <= g.mapY) visit(x, y + 1, wd + 5);
      if (x + 1 <= g.mapX) {
        if (y - 1 >= 1 && !g.elems[objAt(x + 1, y)].diagonalBlocked) visit(x + 1, y - 1, wd + 7);
        visit(x + 1, y, wd + 5);
        if (y + 1 <= g.mapY && !g.elems[objAt(x + 1, y + 1)].diagonalBlocked) visit(x + 1, y + 1, wd + 7);
      }
    };
    visit(center.x, center.y, 0);
    // FindTree keeps dist ≤ radius by GetLengthDiag (KM_Points.pas 273–284).
    return out.filter((t) => {
      const dx = Math.abs(center.x - t.x);
      const dy = Math.abs(center.y - t.y);
      const diag = dx > dy ? dx + dy * 0.41 : dy + dx * 0.41;
      return diag <= radius;
    });
  }

  /** TileIsGoodToCutTree (KM_Terrain.pas 1761–1772) v0: no other unit on the tile. */
  private tileIsGoodToCutTree(x: number, y: number): boolean {
    for (const u of this.units) {
      if (Math.round(u.posF.x) === x && Math.round(u.posF.y) === y) return false;
    }
    return true;
  }

  /** CanCutTreeAtVertex (KM_Terrain.pas 1744–1758). */
  private canCutTreeAtVertex(pos: Pt, tree: Pt): boolean {
    const checked = (p: Pt): boolean => !this.routeCanBeMade(pos, p) || this.tileIsGoodToCutTree(p.x, p.y);
    if (!this.routeCanBeMadeToVertex(pos, tree)) return false;
    if (!checked(tree)) return false;
    if (tree.x !== 1 && !checked({ x: tree.x - 1, y: tree.y })) return false;
    if (tree.y !== 1 && !checked({ x: tree.x, y: tree.y - 1 })) return false;
    if (tree.x !== 1 && tree.y !== 1 && !checked({ x: tree.x - 1, y: tree.y - 1 })) return false;
    return true;
  }

  /** ChooseCuttingDirection (KM_Terrain.pas 2756–2778): the flattest walkable corner of the tree. */
  private chooseCuttingDirection(pos: Pt, tree: Pt): ChopPlan | null {
    let bestSlope = Number.POSITIVE_INFINITY;
    let result: ChopPlan | null = null;
    for (let i = -1; i <= 0; i++) {
      for (let k = -1; k <= 0; k++) {
        if (!this.routeCanBeMade(pos, { x: tree.x + k, y: tree.y + i })) continue;
        let slope =
          this.round(this.heightAt(tree.x + k - 0.5, tree.y + i - 0.5)) -
          this.grid.height[this.index(tree.x, tree.y)];
        // Front cuts on a rise look bad (2769): make it worse but not worse than the initial best.
        if (i === 0 && slope < 0) slope -= HEIGHT_MAX;
        if (Math.abs(slope) < bestSlope) {
          result = { loc: { x: tree.x + k, y: tree.y + i }, dir: vertexDir(k, i) };
          bestSlope = Math.abs(slope);
        }
      }
    }
    return result;
  }

  /** Delphi Math.Round (round half to even) — the same port walk.ts uses. */
  private round(x: number): number {
    const floor = Math.floor(x);
    const frac = x - floor;
    if (frac > 0.5) return floor + 1;
    if (frac < 0.5) return floor;
    return floor % 2 === 0 ? floor : floor + 1;
  }

  /** HeightAt(X−0.5, Y−0.5) without the CELL_HEIGHT_DIV round trip = the mean of 4 corners. */
  private heightAt(inX: number, inY: number): number {
    const mapX = this.map.mapX;
    const mapY = this.map.mapY;
    const xc = clamp(Math.trunc(inX), 0, mapX - 1);
    const yc = clamp(Math.trunc(inY), 0, mapY - 1);
    const fx = inX - Math.floor(inX);
    const fy = inY - Math.floor(inY);
    const h = (x: number, y: number): number => this.grid.height[this.index(x, y)];
    const x1 = xc + 1;
    const x2 = Math.min(xc + 2, mapX);
    const y1 = yc + 1;
    const y2 = Math.min(yc + 2, mapY);
    const mix = (a: number, b: number, t: number): number => b + (a - b) * t;
    const tmp1 = mix(h(x2, y1), h(x1, y1), fx);
    const tmp2 = mix(h(x2, y2), h(x1, y2), fx);
    return mix(tmp2, tmp1, fy);
  }
}

// -----------------------------------------------------------------------------------------------

/**
 * Build the v0 economy world from parsed data (spec §3): houses complete (hbsDone) at (x,y) with
 * their footprints removed from the walk grid, the hand roads as toRoad overlay + roadGrid, the
 * TreeAge field from the object ids, the humanoid mission units, and the store stocks from
 * !ADD_WARE (each also an offer).
 */
export function createEconomyWorld(o: EconomyWorldOptions): EconomyWorld {
  return new EconomyWorld(o);
}

/**
 * The demo scenario (spec §1, one helper for CLI + viewer):
 *  - plant `forestCount` (12) full trees (species 1, obj 90, TreeAge 40) on the first tree-free,
 *    walkable, house-free, non-road tiles in row-major order within Chebyshev 9 of the hut's
 *    PointBelowEntrance;
 *  - add a timber demand of `storeTimberOrder` (20) to hand 1's store (the store never demands on
 *    its own — its WareInput is all wtNone — so boards would pile at the sawmill; the order uses
 *    the same demand mechanism the game's construction scripts use).
 */
export function applyDemoScenario(
  w: EconomyWorld,
  o?: { forestCount?: number; storeTimberOrder?: number },
): void {
  const forestCount = o?.forestCount ?? 12;
  const storeTimberOrder = o?.storeTimberOrder ?? 20;

  const hut = w.findFirstHouse(9); // htWoodcutters
  if (hut === null) throw new Error('applyDemoScenario: no woodcutter hut in the mission');
  const store = w.findFirstHouse(11, 1); // hand 1's store
  if (store === null) throw new Error('applyDemoScenario: no store for hand 1 in the mission');

  const center = pointBelowEntrance(hut);
  let planted = 0;
  for (let y = center.y - 9; y <= center.y + 9 && planted < forestCount; y++) {
    for (let x = center.x - 9; x <= center.x + 9 && planted < forestCount; x++) {
      if (x < 1 || x > w.grid.mapX - 1 || y < 1 || y > w.grid.mapY - 1) continue;
      const i = y * (w.grid.mapX + 1) + x;
      const obj = w.grid.obj[i];
      if (isChopableObj(obj)) continue; // tree-free
      if (w.grid.walk[i] !== 1) continue; // walkable
      if (isHouseTile(w, x, y)) continue; // house-free
      if (w.isRoadTile(x, y)) continue; // non-road
      w.plantTree(x, y, 90, TREE_AGE_FULL); // species 1, obj 90, TreeAge 40
      planted += 1;
    }
  }
  if (planted < forestCount) {
    throw new Error(`applyDemoScenario: planted only ${planted}/${forestCount} trees`);
  }

  w.addScriptDemand(store, WT_TIMBER, storeTimberOrder);
}

/** House footprint membership (the world's per-tile map is private; probe via the public houses). */
function isHouseTile(w: EconomyWorld, x: number, y: number): boolean {
  for (const h of w.houses) {
    const plan = housePlan(h.typeId);
    for (let I = 1; I <= 4; I++) {
      for (let K = 1; K <= 4; K++) {
        if (plan[I - 1][K - 1] === 0) continue;
        if (h.x + K - 3 === x && h.y + I - 4 === y) return true;
      }
    }
  }
  return false;
}
