// economy.ts — M3 v0 headless economy sim: mission houses, streets, trees, the three task state
// machines (goHome / mining / deliver) and the per-hand logistics pass (docs/M3-SPIKE.md), extended
// in M4 with the combat systems of docs/M4-SPIKE.md (combat.ts holds the systems, this world wires
// them into the tick).
//
// Tick order (M4, docs/M4-SPIKE.md 2.1; KM_Game.PlayGameTick 3031–3145 + KM_Hand.UpdateState
// 2099–2135): 1. IncTick; 2. terrain update (falling-tree end + tree growth, KM_Terrain.pas
// 5410–5498); 3. dead units deleted (KM_UnitsCollection.pas 352–391); 4. per hand ascending:
//    groups (KM_Hand.pas 2108; per group mod 5 CheckForFight, mod 7 CheckOrderDone, mod 10 hunger)
//    → units descending index (action first, then task, then the warrior orders/scan; KM_Units.pas
//    2652–2682 + KM_UnitWarrior.pas 1086–1127) → houses descending index (IncAnimStep; destroyed
//    houses deleted one tick later) → FOW updateState (KM_Hand.pas 2113) → logistics when
//    `tick mod handCount == handId` (KM_Hand.pas 2116–2120); 5. gProjectiles.UpdateState
//    (KM_Game.pas 3112); 6. the one RunningTimer RNG draw. Seed 1, like M2b (no parity claim yet).
//
// M4 divergences (documented; see also the combat.ts header):
//  - Units walk through each other (no FEAT_UNIT_INTERACTION): a melee attacker walking onto an
//    occupied tile stops at the tile arrival and fights from there (the walk action's arrival enemy
//    check, KM_UnitActionWalkTo.pas 1213–1218, is ported; push/exchange is not).
//  - Mission units keep the frozen M3 no-draw spawn; spawned warriors use the game's spawn draws
//    (condition per unit + per group, KM_Units.pas 1263, KM_UnitGroup.pas 302).
//  - Dismiss, storm attack, repair, sounds and script events are out of v0.
//
// v0 divergences (M3, unchanged):
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
// M5a construction slice (docs/M5-SPIKE.md §1a/§2; construction.ts holds the plan stores):
//  - Tile locks (tlNone/tlDigged/tlRoadWork/tlFieldWork/tlFenced/tlHouse) are modeled: the mission
//    houses and built houses hold tlHouse, a WIP house starts tlFenced (KM_Houses.pas 569), the
//    digger locks each dug cell tlDigged. tpWalk excludes tlDigged/tlHouse, tpWorker only tlHouse
//    (KM_Terrain.pas 3773–3784, 3840–3844) — so a second `workerGrid` carries the builder's
//    Digging passability (KM_Units.pas 2030–2034).
//  - The construction pass runs staggered with the logistics pass: `tick mod handCount == hand`
//    (KM_Hand.pas 2116–2120), AssignHousePlans → AssignFieldworks → AssignHouses
//    (KM_HandConstructions.pas 1414–1417; repairs are out of v0).
//  - FlattenTerrain (KM_Terrain.pas 4355–4468) is simplified: each of the tile's 4 corner heights
//    is mixed halfway to the tile's corner average, then the 3×3 passability is recomputed
//    (documented deviation: no tpElevate/recursion/lighting).
//  - Delivery to a WIP house is the fDeliverKind = dkToConstruction path of
//    KM_UnitTaskDelivery.pas 454–483 (phases 5/6/7 with the entrance diagonal rule); the 1.42
//    parameter of SetActionWalkToSpot is a distance tolerance in the Pascal — the port walks to
//    the exact tile (documented deviation).
//  - Field plans: roads and corn fields are built (SetRoad/SetField); wine fields are out of v0
//    (no TKMTaskBuildWine, spec §1a), so tileIsWineField always reads the (unused) wine overlay.
//
// Browser-safe: no node: imports.
import type { KaMap } from '../map/map.ts';
import type { PassGrid } from './terrain.ts';
import { buildPassGrid, canWalkDiagonal, checkHeightPass, tileWalkable } from './terrain.ts';
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
import {
  WARE_CNT,
  WT_TRUNK,
  WT_TIMBER,
  WT_STONE,
  WT_GOLD,
  WT_COAL,
  WT_IRON,
  WT_LEATHER,
  WT_AXE,
  WT_WOODEN_SHIELD,
  WT_LEATHER_ARMOR,
  WT_IRON_SHIELD,
  WT_IRON_ARMOR,
  WT_SWORD,
  WT_BOW,
  WT_CROSSBOW,
  WT_LANCE,
  WT_PIKE,
  WT_HORSE,
  WT_WINE,
  WT_BREAD,
  WT_SAUSAGE,
  WT_FISH,
  WT_CORN,
} from '../assets/wares.ts';
// M5a construction slice (docs/M5-SPIKE.md §1a/§2; construction.ts holds the plan stores).
import type {
  BuildSite,
  BuildState,
  ConstructionQueries,
  ConstructionState,
  FieldPlan,
  FieldType,
  HousePlan,
} from './construction.ts';
import * as C from './construction.ts';
// M4 combat systems (docs/M4-SPIKE.md; combat.ts holds the systems, this world wires them in).
import type { CombatHouse, CombatUnit, CombatWorld, GroupState, SimGroup, SimProjectile, UnitRuntime, WarriorState } from './combat.ts';
import {
  FOW_PACE,
  HITPOINT_RESTORE_PACE,
  UNIT_CONDITION_PACE,
  UNIT_CONDITION_BASE,
  UNIT_CONDITION_RANDOM,
  UNIT_MAX_CONDITION,
  FogOfWar,
  executeAttackHouseTask,
  executeDieTask,
  executeFightAction,
  getPositionFromIndex,
  hitPointsDecrease as combatHitPointsDecrease,
  isDeadOrDying,
  isDiagDir,
  killUnit as combatKillUnit,
  kmGetVertex,
  length,
  lengthSqr,
  createSoloGroup,
  isWarriorSpec,
  spawnGroup as combatSpawnGroup,
  updateProjectiles,
  warriorCheckForEnemy,
  warriorInFight,
  warriorTakeNextOrder,
  groupUpdateState,
  groupOrderWalk,
  groupOrderAttackUnit,
  groupOrderAttackHouse,
  groupOrderHalt,
  groupOrderNone,
  doKill as combatDoKill,
} from './combat.ts';

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

// TKMTileLock (KM_TerrainTypes.pas) — the M5a subset (KM_Terrain.pas 2173–2205, 3773–3844).
export const TL_NONE = 0;
export const TL_DIGGED = 1; // tlDigged: blocks tpWalk, still allowed for tpWorker
export const TL_ROAD_WORK = 2; // tlRoadWork
export const TL_FIELD_WORK = 3; // tlFieldWork
export const TL_FENCED = 4; // tlFenced: a WIP house — tpWalk is still allowed
export const TL_HOUSE = 5; // tlHouse: blocks tpWalk and tpWorker

// The field overlay (TileOverlay toCorn/toWine essentials): TileIsCornField/TileIsWineField.
export const FIELD_NONE = 0;
export const FIELD_CORN = 1;
export const FIELD_WINE = 2;

// utBuilder (unit.dat record 9; UNIT_ID_TO_TYPE[9], KM_ResUnits.pas 146–149).
export const UNIT_BUILDER = 9;

// The WIP house FOW radius (KM_Houses.pas 2336).
const HOUSE_PLAN_SIGHT = 2;

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
  // M4 (additive): house combat (docs/M4-SPIKE.md 2.5) — the viewer (worker J) reads these.
  maxHealth: number; // HouseSpec.maxHealth = (WoodCost + StoneCost) * 50
  damage: number; // fDamage; health = max(maxHealth − damage, 0)
  destroyed: boolean; // Demolish ran; the object is removed one tick later
  fireLevel: number; // 0..8 haFire1..haFire8 sub-actions by damage level (UpdateDamage)
  // M5a (additive): the construction slice (docs/M5-SPIKE.md §2.2/§2.3) — the viewer (worker L)
  // reads these. Mission houses are 'done' (hbsDone) with progress = MaxHealth (KM_Houses.pas 565).
  buildState: BuildState; // fBuildState
  buildingProgress: number; // fBuildingProgress
  buildSupplyWood: number; // fBuildSupplyWood
  buildSupplyStone: number; // fBuildSupplyStone
  buildReserve: number; // fBuildReserve (50 per ware unit, spent 5 per hit)
  readyToBeBuilt: boolean; // fIsReadyToBeBuilt
  woodCost: number; // gRes.Houses[type].WoodCost
  stoneCost: number; // gRes.Houses[type].StoneCost
  // M5b (additive): the woodcutter's flag point (KM_HouseWoodcutters.FlagPoint; null/undefined =
  // the default PointBelowEntrance, KM_Houses.pas 2554). The AI sets it for chop-only woodcutters.
  // Optional so pre-M5b EconHouse literals (the viewer) still typecheck.
  flagPoint?: Pt | null;
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
  taskKind: 'none' | 'goHome' | 'chop' | 'saw' | 'deliver' | 'idle' | 'buildHouseArea' | 'buildHouse' | 'buildRoad' | 'buildField' | 'selfTrain' | 'stone' | 'smith' | 'workshop';
  // M4 (additive): unit combat (docs/M4-SPIKE.md §3)
  hitPoints: number;
  groupUid: number; // 0 = none
  fightState: 'none' | 'fight' | 'die';
  dead: boolean; // CloseUnit ran (TaskDie phase 2); removed from the list next tick
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

/** M5c (additive): a stonemason work plan — the walkable tile below the stone deposit. */
interface StonePlan {
  loc: Pt; // the walkable tile below the stone deposit (KMGetVertexDir = dirN)
}

type Task =
  | { kind: 'goHome'; phase: number }
  | { kind: 'chop'; phase: number; plan: ChopPlan | null; distant: boolean }
  | { kind: 'stone'; phase: number; plan: StonePlan | null; distant: boolean }
  | { kind: 'saw'; phase: number; phase2: number }
  | { kind: 'smith'; phase: number; phase2: number }
  // M5e (additive, docs/M5-SPIKE.md 7.7): TKMTaskMining for a workshop (KM_UnitWorkPlan.pas 376–421):
  // the product (WareOutput), its input wares (ResourcePlan) and the house work steps (SubActAdd).
  | { kind: 'workshop'; phase: number; phase2: number; product: number; costs: number[]; steps: number[]; stepIdx: number }
  | { kind: 'deliver'; phase: number; fromUid: number; toUid: number; toUnitUid: number; ware: number; demand: Demand; taken: boolean; deliverKind: 'house' | 'construction' | 'unit' }
  // M5a builder tasks (docs/M5-SPIKE.md §2.2): TKMTaskBuildHouseArea (:681–765),
  // TKMTaskBuildHouse (:845–901), TKMTaskBuildRoad (:218–291), TKMTaskBuildField (:503–543).
  | {
      kind: 'buildHouseArea';
      phase: number;
      typeId: number;
      locX: number;
      locY: number;
      plan: HousePlan;
      houseUid: number;
      houseNeedsWorker: boolean;
      houseReadyToBuild: boolean;
      cells: Pt[];
      lastToDig: number;
      closed: boolean;
    }
  | {
      kind: 'buildHouse';
      phase: number;
      phase2: number;
      houseUid: number;
      site: BuildSite;
      buildFrom: Pt | null;
      fromDir: number;
      cells: { x: number; y: number; dir: number }[];
      closed: boolean;
    }
  | {
      kind: 'buildRoad';
      phase: number;
      x: number;
      y: number;
      field: FieldPlan | null;
      demandSet: boolean;
      tileLockSet: boolean;
      isDigged: boolean;
      closed: boolean;
    }
  | {
      kind: 'buildField';
      phase: number;
      phase2: number;
      x: number;
      y: number;
      field: FieldPlan | null;
      tileLockSet: boolean;
      closed: boolean;
    }
  // M5b (additive): TKMTaskSelfTrain (units/tasks/KM_UnitTaskSelfTrain.pas 70-118) — the school
  // training task of the unit being trained (5×29 stays + 9 idle ≈ 154 ticks, then walk out).
  | { kind: 'selfTrain'; phase: number; schoolUid: number };

interface Demand {
  houseUid: number; // the demand's house; the house may be destroyed/deleted later (KM_Houses Demolish)
  unitUid: number; // M5a: a unit demand (AddDemand(nil, aUnit, ...), 0 = house demand)
  ware: number;
  slot: number; // input slot for house demands; -1 for script demands
  script: boolean;
  count: number; // script demands: remaining count
  being: number; // reserved deliveries
  // M5a (additive): a construction demand (AddDemand(fHouse, nil, wtTimber, WoodCost, dtOnce, diHigh4),
  // KM_UnitTaskBuild.pas 637–638) — count-based like a script demand, delivered with WareAddToBuild.
  construction: boolean;
  /** TKMDemandImportance as an index (0 diNorm, 1 diHigh4, 2 diHigh3, 4 diHigh1; KM_HandLogistics.pas 30–35). */
  importance?: number;
}

/** TKMDemandImportance (KM_HandLogistics.pas 30–35), the enum order: the higher wins a bid first. */
const DI_NORM = 0;
const DI_HIGH4 = 1;
const DI_HIGH3 = 2;
const DI_HIGH1 = 4;

/** AddDemand's importance override (KM_HandLogistics.pas 1160–1171): gold to a school is diHigh1, food to an inn diHigh3. */
function houseDemandImportance(typeId: number, ware: number): number {
  if (ware === WT_GOLD && typeId === HOUSE_TYPE_SCHOOL) return DI_HIGH1;
  if ((ware === WT_BREAD || ware === WT_SAUSAGE || ware === WT_WINE || ware === WT_FISH) && typeId === HOUSE_TYPE_INN) return DI_HIGH3;
  return DI_NORM;
}

/** WareDistribution (KM_WareDistribution.pas 12–17, 71–88): the input cap of a ware/house pair, 5 for every pair
 *  without a setting. The sim has no ratio setting, so the Pascal defaults apply. Used by the bid's KaMRandom(16 - 3*distr). */
function wareDistribution(ware: number, typeId: number): number {
  if (ware === WT_COAL && (typeId === HOUSE_TYPE_IRON_SMITHY || typeId === HOUSE_TYPE_WEAPON_SMITHY || typeId === HOUSE_TYPE_ARMOR_SMITHY)) return 3;
  if (ware === WT_TIMBER && typeId === HOUSE_TYPE_ARMOR_WORKSHOP) return 2;
  if (ware === WT_CORN && typeId === HOUSE_TYPE_MILL) return 4;
  if (ware === WT_CORN && typeId === HOUSE_TYPE_STABLES) return 3;
  return 5;
}

interface Offer {
  houseUid: number;
  ware: number;
  count: number;
}

interface HouseState {
  spec: HouseSpec | undefined;
  stock: Int32Array | null; // stores only
  workerUid: number;
  being: number[]; // per input slot: reserved deliveries (demand cap)
  isStore: boolean;
  // M5b (additive): the school queue (KM_HouseSchool.pas 11-46): fQueue[0..5] of unit.dat records
  // (-1 = utNone; slot 0 trains), fUnitWip (the unit being trained, uid 0 = none), fHideOneGold
  // and fTrainProgress. Only htSchool houses get these.
  schoolQueue?: number[];
  unitWipUid?: number;
  hideOneGold?: boolean;
  trainProgress?: number;
  // M5e (additive): a workshop's production orders (KM_Houses.pas 136 fWareOrder[1..4], PickOrder
  // 1575–1649) and fLastOrderProduced (1-based, 0 = none). Set by setWareOrder (the AI's OrderWeapons).
  wareOrder?: number[];
  lastOrderProduced?: number;
}

interface UnitState {
  spec: UnitSpec;
  speed: { ortho: number; diag: number };
  walk: Walk | null;
  actionLock: number; // remaining ticks of the current stay; 0 = completes next tick
  locked: boolean; // locked stays block serf idle status (SetActionLockedStay)
  task: Task | null;
  homeUid: number;
  // M4 combat bookkeeping (docs/M4-SPIKE.md 2.1/2.2)
  warrior: WarriorState | null;
  posRound: Pt; // Position (rounded; FOW reveals when this tile changes)
  posPrev: Pt; // PositionPrev (the last walk node passed)
  posNext: Pt; // PositionNext (the tile the unit occupies in the terrain grid)
}

function pointBelowEntrance(h: EconHouse): Pt {
  return { x: h.entrance.x, y: h.entrance.y + 1 };
}

/** The script id of htSchool (HOUSE_ID_TO_TYPE[13] = 19) - the school queue exception. */
const HOUSE_TYPE_SCHOOL = 13;
/** The script id of htBarracks (ai.ts HT_BARRACKS) and the utRecruit unit record (ai.ts UT_RECRUIT). */
const HOUSE_TYPE_BARRACKS = 21;
const HOUSE_TYPE_STORE = 11;
const HOUSE_TYPE_INN = 27;
/** A store's wtAll demand has no count cap (dtAlways, KM_HandLogistics.pas 1372): any number of deliveries. */
const STORE_NO_CAP = 1 << 30;
/** The House>Store bid penalty (KM_HandLogistics.pas 1583–1590: IncAddition(1000) for a wtAll demand). */
const STORE_BID_PENALTY = 1000;
const UNIT_RECRUIT = 13;
/** TROOPS_TRAINED_CONDITION (KM_Defaults.pas 376): a barracks warrior starts at 0.6 of max condition. */
const TROOPS_TRAINED_CONDITION = 0.6;
/** M5e (additive, docs/M5-SPIKE.md 7.7): the production houses and workers (ai.ts HT_* / UT_*). */
const HOUSE_TYPE_QUARRY = 14;
const HOUSE_TYPE_WEAPON_WORKSHOP = 19;
const HOUSE_TYPE_ARMOR_WORKSHOP = 20;
/** The houses of the ware-distribution defaults (KM_WareDistribution.pas 12–17; ai.ts HT_*). */
const HOUSE_TYPE_IRON_SMITHY = 1;
const HOUSE_TYPE_WEAPON_SMITHY = 2;
const HOUSE_TYPE_STABLES = 12;
const HOUSE_TYPE_TOWN_HALL = 18;
const HOUSE_TYPE_MILL = 22;
const HOUSE_TYPE_ARMOR_SMITHY = 10;
const UNIT_CARPENTER = 5;
const UNIT_STONEMASON = 10;
/** WARFARE_MIN..WARFARE_MAX (wtWoodenShield..wtHorse): the barracks' input range (KM_HouseBarracks.pas 16). */
const WARFARE_MIN = 16;
const WARFARE_MAX = 26;
/** MAX_WARES_ORDER (KM_Defaults.pas 301): the cap of one WareOrder entry of a production house. */
const MAX_WARES_ORDER = 999;

/**
 * TROOP_COST (KM_ResUnits.pas 168–177): the wares one warrior costs at a barracks, keyed by the
 * unit.dat record (utMilitia 14 .. utKnight 22). Each listed ware is one unit of stock.
 */
export const TROOP_COST: Record<number, number[]> = {
  14: [WT_AXE],
  15: [WT_WOODEN_SHIELD, WT_LEATHER_ARMOR, WT_AXE],
  16: [WT_IRON_SHIELD, WT_IRON_ARMOR, WT_SWORD],
  17: [WT_LEATHER_ARMOR, WT_BOW],
  18: [WT_IRON_ARMOR, WT_CROSSBOW],
  19: [WT_LEATHER_ARMOR, WT_LANCE],
  20: [WT_IRON_ARMOR, WT_PIKE],
  21: [WT_WOODEN_SHIELD, WT_LEATHER_ARMOR, WT_AXE, WT_HORSE],
  22: [WT_IRON_SHIELD, WT_IRON_ARMOR, WT_SWORD, WT_HORSE],
};

/**
 * WARFARE_COSTS (KM_ResWares.pas 72–83): the two input wares of one workshop product (-1 = none).
 * The workshop's PickOrder and its ResourcePlan read it (KM_Houses.pas 1590–1595).
 */
const WARFARE_COSTS: Record<number, [number, number]> = {
  [WT_WOODEN_SHIELD]: [-1, WT_TIMBER],
  [WT_IRON_SHIELD]: [WT_COAL, WT_IRON],
  [WT_LEATHER_ARMOR]: [-1, WT_LEATHER],
  [WT_IRON_ARMOR]: [WT_COAL, WT_IRON],
  [WT_AXE]: [WT_TIMBER, WT_TIMBER],
  [WT_SWORD]: [WT_COAL, WT_IRON],
  [WT_LANCE]: [WT_TIMBER, WT_TIMBER],
  [WT_PIKE]: [WT_COAL, WT_IRON],
  [WT_BOW]: [WT_TIMBER, WT_TIMBER],
  [WT_CROSSBOW]: [WT_COAL, WT_IRON],
};

/**
 * The per-house runtime state. M5b: a school (script id 13) gets the queue of
 * TKMHouseSchool (fQueue 6 slots, -1 = utNone) + fUnitWip/fHideOneGold/fTrainProgress.
 */
function createHouseState(typeId: number, spec: HouseSpec | undefined): HouseState {
  const isStore = typeId === 11; // htStore script id
  // M5e: a barracks keeps its own warfare stock (fResourceCount, KM_HouseBarracks.pas 16, 184–198).
  const hasStock = isStore || typeId === HOUSE_TYPE_BARRACKS;
  const state: HouseState = {
    spec,
    stock: hasStock ? new Int32Array(WARE_CNT) : null,
    workerUid: 0,
    being: [0, 0, 0, 0],
    isStore,
  };
  if (typeId === HOUSE_TYPE_SCHOOL) {
    state.schoolQueue = [-1, -1, -1, -1, -1, -1];
    state.unitWipUid = 0;
    state.hideOneGold = false;
    state.trainProgress = 0;
  }
  if (typeId === HOUSE_TYPE_WEAPON_WORKSHOP || typeId === HOUSE_TYPE_ARMOR_WORKSHOP) {
    state.wareOrder = [0, 0, 0, 0];
    state.lastOrderProduced = 0;
  }
  return state;
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
  // M4 combat (docs/M4-SPIKE.md §3)
  readonly groups: GroupState[] = [];
  readonly projectiles: SimProjectile[] = [];
  readonly fow: FogOfWar[] = []; // per hand
  houseDamageTotal = 0; // telemetry: the damage applied to houses (AddDamage amounts)
  // M5a (additive): the construction store per hand (docs/M5-SPIKE.md §3).
  readonly constructions: ConstructionState[] = [];

  private readonly map: KaMap;
  private readonly unitSpecs: UnitSpec[];
  private readonly unitStates: UnitState[] = [];
  private readonly roadOverlay: Uint8Array;
  private readonly fieldOverlay: Uint8Array; // 0 none, 1 corn, 2 wine (TileIsCornField/TileIsWineField)
  private readonly digOverlay: Uint8Array; // 0 none, 1..4 = toDig1..toDig4 (IncDigState)
  private readonly tileLock: Uint8Array; // TKMTileLock per tile (TL_*)
  private readonly workerGrid: PassGrid; // tpWorker (KM_Terrain.pas 3840–3844)
  private readonly treeAge: Uint8Array;
  /** M5c (additive): per-tile stone deposit shadow (KM_Terrain.pas 1385–1388 TileIsStone); decremented
   *  by DecStoneDeposit (phase 6), read by tileIsStone. Initialized from the tileset stone values so
   *  that tileIsStone returns the same values until a stonemason mines (v0 does not modify map.tiles
   *  or grid.walk). Not serialized in any stateSha. */
  private readonly stoneRemaining: Uint8Array;
  private readonly houseTile: Int32Array; // house uid per tile (0 = none), for ChopTree's stamp rule
  private readonly falling = new Map<number, number>(); // tile index → fall tick
  private readonly offers: Offer[][] = []; // per hand
  private readonly demands: Demand[][] = []; // per hand
  private readonly unitStateMap = new Map<EconUnit, UnitState>();
  private readonly groupMap = new Map<number, GroupState>();
  private readonly houseStateMap = new Map<number, HouseState>(); // house uid → state (index-free)
  private readonly unitTile: Int32Array; // terrain IsUnit: uid per PositionNext tile (0 = none)
  private readonly vertexUsage: Uint8Array; // per vertex: 0 none, 1 vuNWSE, 2 vuNESW
  private walkConnect: Int32Array; // wcWalk component ids (rebuild on diagonal-blocking change)
  private walkConnectDirty = true;
  private rng = 1; // fixed v0 seed; the per-tick RunningTimer draw + task draws
  private tickNumber = 0;
  private uidCounter = 1;
  private projectileUidCounter = 1;
  private groupUidCounter = 1;

  constructor(o: EconomyWorldOptions) {
    this.map = o.map;
    this.houseSpecs = o.houseSpecs;
    this.serfCarry = o.serfCarry;
    this.unitSpecs = o.unitSpecs;

    const { mapX, mapY } = o.map;
    const size = (mapX + 1) * (mapY + 1);
    this.grid = buildPassGrid(o.map, o.tiles, o.elems);
    this.roadOverlay = new Uint8Array(size);
    this.fieldOverlay = new Uint8Array(size);
    this.digOverlay = new Uint8Array(size);
    this.tileLock = new Uint8Array(size);
    this.treeAge = new Uint8Array(size);
    this.stoneRemaining = new Uint8Array(size);
    this.houseTile = new Int32Array(size);
    this.unitTile = new Int32Array(size);
    this.vertexUsage = new Uint8Array(size);
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
    this.workerGrid = {
      mapX,
      mapY,
      walk: new Uint8Array(size),
      obj: this.grid.obj,
      height: this.grid.height,
      elems: this.grid.elems,
      tiles: this.grid.tiles,
    };
    for (let i = 0; i < this.grid.walk.length; i++) this.workerGrid.walk[i] = this.grid.walk[i];

    // Hand count: gHands.Count after SET_MAX_PLAYER; extended defensively if an owner appears.
    let handCount = Math.max(1, o.mission.maxPlayers);
    for (const h of o.mission.houses) handCount = Math.max(handCount, h.owner + 1);
    for (const u of o.mission.units) if (u.owner >= 0) handCount = Math.max(handCount, u.owner + 1);
    this.handCount = handCount;
    for (let i = 0; i < handCount; i++) {
      this.offers.push([]);
      this.demands.push([]);
      this.fow.push(new FogOfWar(mapX, mapY));
      this.constructions.push(C.createConstructionState(i, this.houseSpecs));
    }

    this.initTreeAges();
    this.initStoneRemaining();
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
    this.removeDeadUnits(); // dead units are deleted when pointer-free (KM_UnitsCollection.pas 352–391)
    for (let hand = 0; hand < this.handCount; hand++) {
      // Groups first (KM_Hand.pas 2108; KM_UnitGroups.UpdateState 2661–2677).
      for (const g of this.groups) {
        if (g.owner !== hand || g.memberUids.length === 0) continue;
        groupUpdateState(this, g);
      }
      this.removeDeadGroups();
      // Units, descending index (KM_UnitsCollection.pas 352–391).
      for (let i = this.units.length - 1; i >= 0; i--) {
        const u = this.units[i];
        if (u.owner !== hand) continue;
        if (u.dead) continue;
        this.tickUnit(i);
      }
      // Houses, descending index (KM_HouseCollection.pas 426–436).
      for (let i = this.houses.length - 1; i >= 0; i--) {
        const h = this.houses[i];
        if (h.owner !== hand) continue;
        if (h.destroyed) continue; // deleted one tick later when pointer-free
        h.animStep += 1;
        h.workAnimStep += 1;
        // WIP houses keep their BuildArea revealed with HOUSE_PLAN_SIGHT (KM_Houses.pas 2334–2361:
        // `(aTick + Owner) mod FOW_PACE = 0`, FOG_OF_WAR_INC).
        if (h.buildState !== 'done' && (this.tickNumber + hand) % FOW_PACE === 0) {
          const fog = this.fow[hand];
          if (fog !== undefined) {
            for (const c of this.houseCells(h)) fog.reveal(c.x, c.y, HOUSE_PLAN_SIGHT, false);
          }
        }
      }
      this.removeDestroyedHouses();
      // FOW (KM_Hand.pas 2113).
      this.fow[hand].updateState(true, this.tickNumber);
      if (this.tickNumber % this.handCount === hand) {
        // Staggered (KM_Hand.pas 2116–2120): constructions then deliveries
        // (KM_Hand.UpdateState: fConstructions.UpdateState + fDeliveries.UpdateState).
        this.constructionsPass(hand);
        this.logistics(hand);
      }
    }
    updateProjectiles(this); // after gHands (KM_Game.pas 3112)
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
    const st = this.houseState(h);
    let n = 0;
    if (st.stock !== null && ware >= 0 && ware < WARE_CNT) n += st.stock[ware];
    if (st.spec !== undefined) {
      for (let i = 0; i < 4; i++) if (st.spec.resIn[i] === ware) n += h.wareIn[i];
      for (let i = 0; i < 4; i++) if (st.spec.resOut[i] === ware) n += h.wareOut[i];
    }
    return n;
  }

  /** The state record of a house (uid-keyed: house array indices shift when a destroyed house is
   *  deleted, KM_HouseCollection.pas 426–436, so no task may hold an index). */
  private houseState(h: EconHouse): HouseState {
    const st = this.houseStateMap.get(h.uid);
    if (st === undefined) throw new Error(`houseState: unknown house uid ${h.uid}`);
    return st;
  }

  private houseStateByUid(uid: number): HouseState | undefined {
    return this.houseStateMap.get(uid);
  }

  /** The first house of a script-id type (optionally of one owner), in creation order. */
  findFirstHouse(typeId: number, owner?: number): EconHouse | null {
    for (const h of this.houses) {
      if (h.destroyed) continue;
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
    if (ware < 0 || ware >= WARE_CNT) throw new Error(`addScriptDemand: bad ware ${ware}`);
    this.demands[house.owner].push({ houseUid: house.uid, unitUid: 0, ware, slot: -1, script: true, count, being: 0, construction: false });
  }

  /**
   * A construction demand (KM_UnitTaskBuild.pas 637–638): `AddDemand(fHouse, nil, wtTimber,
   * WoodCost, dtOnce, diHigh4)` + the stone one. Count-based like a script demand (dtOnce: one
   * delivery reserved at a time), the ware lands in the build supply via WareAddToBuild.
   */
  addConstructionDemand(house: EconHouse, ware: number, count: number): void {
    if (ware < 0 || ware >= WARE_CNT) throw new Error(`addConstructionDemand: bad ware ${ware}`);
    if (count <= 0) return;
    this.demands[house.owner].push({ houseUid: house.uid, unitUid: 0, ware, slot: -1, script: true, count, being: 0, construction: true, importance: DI_HIGH4 });
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

  /** M5c (additive): stoneRemaining per tile from the tileset stone value (TileIsStone, 1385–1388),
   *  so tileIsStone returns the same values until a stonemason mines. Does not touch map.tiles or
   *  grid.walk → econsim sha unchanged (no stonemasons in the econsim scenario). */
  private initStoneRemaining(): void {
    const g = this.grid;
    for (let y = 1; y <= this.map.mapY - 1; y++) {
      for (let x = 1; x <= this.map.mapX - 1; x++) {
        const i = this.index(x, y);
        const flags = g.tiles[this.terrainId(x, y)];
        this.stoneRemaining[i] = flags !== undefined && typeof flags.stone === 'number' ? flags.stone : 0;
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
        maxHealth: spec !== undefined ? spec.maxHealth : 0,
        damage: 0,
        destroyed: false,
        fireLevel: 0,
        // A mission house is complete (hbsDone) with progress = MaxHealth (KM_Houses.pas 562–566).
        buildState: 'done',
        buildingProgress: spec !== undefined ? spec.maxHealth : 0,
        buildSupplyWood: 0,
        buildSupplyStone: 0,
        buildReserve: 0,
        readyToBeBuilt: false,
        woodCost: spec !== undefined ? spec.woodCost : 0,
        stoneCost: spec !== undefined ? spec.stoneCost : 0,
        flagPoint: null,
      };
      this.houses.push(house);

      const state: HouseState = createHouseState(mh.typeId, spec);
      this.houseStateMap.set(house.uid, state);

      // Footprint: BuildArea nonzero cells, row I = Y − pos.Y + 4, col K = X − pos.X + 3
      // (KM_Houses.pas 1109–1123) → tile (pos.X + K − 3, pos.Y + I − 4); remove from the walk grid.
      // A built house holds tlHouse (KM_Terrain.pas 4642–4644) — no tpWalk and no tpWorker.
      const plan = housePlan(mh.typeId);
      for (let I = 1; I <= 4; I++) {
        for (let K = 1; K <= 4; K++) {
          if (plan[I - 1][K - 1] === 0) continue;
          const tx = mh.x + K - 3;
          const ty = mh.y + I - 4;
          if (!this.inMapCoords(tx, ty)) continue;
          const i = this.index(tx, ty);
          this.grid.walk[i] = 0;
          this.workerGrid.walk[i] = 0;
          this.tileLock[i] = TL_HOUSE;
          this.houseTile[i] = house.uid;
        }
      }

      // Activate (KM_Houses.pas 689–695): reveal the house from every covered point (MAX).
      if (spec !== undefined) {
        const fog = this.fow[mh.owner];
        if (fog !== undefined) {
          for (let I = 1; I <= 4; I++) {
            for (let K = 1; K <= 4; K++) {
              if (plan[I - 1][K - 1] === 0) continue;
              fog.reveal(mh.x + K - 4, mh.y + I - 4, spec.sight ?? 0, true);
            }
          }
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
        hitPoints: spec.hitPoints ?? 0,
        groupUid: 0,
        fightState: 'none',
        dead: false,
      };
      this.units.push(unit);
      const st: UnitState = {
        spec,
        speed: walkSpeeds(spec.speedRaw),
        walk: null,
        actionLock: 0,
        locked: false,
        task: null,
        homeUid: 0,
        warrior: null,
        posRound: { x: mu.x, y: mu.y },
        posPrev: { x: mu.x, y: mu.y },
        posNext: { x: mu.x, y: mu.y },
      };
      this.unitStates.push(st);
      this.unitStateMap.set(unit, st);
      if (mu.typeId === UNIT_BUILDER) C.addWorker(this.constructions[mu.owner], unit.uid); // KM_Hand.pas 508–509
      if (this.inMapCoords(mu.x, mu.y)) this.unitTile[this.index(mu.x, mu.y)] = unit.uid;
      const fog = this.fow[mu.owner];
      if (fog !== undefined) fog.reveal(mu.x, mu.y, spec.sight ?? 0, true); // Create 1288–1290
    }
  }

  private buildStoreWares(mission: Mission): void {
    for (const mw of mission.wares) {
      if (mw.ware < 0 || mw.ware >= WARE_CNT) continue;
      // !ADD_WARE targets the hand's first store (KM_MissionScript_Standard.pas 483).
      const store = this.houses.find((h) => h.typeId === 11 && h.owner === mw.owner);
      if (store === undefined) continue;
      const st = this.houseState(store);
      if (st.stock === null) continue;
      st.stock[mw.ware] = Math.min(65535, st.stock[mw.ware] + mw.amount);
      this.addOffer(store.uid, mw.ware, mw.amount); // the store's script wares become offers (96–112)
    }
  }

  /** One demand per real WareInput slot of every house (UpdateDemands, KM_Houses.pas 2221–2277). */
  private buildDemands(): void {
    for (const h of this.houses) {
      const spec = this.houseState(h).spec;
      if (spec === undefined) continue;
      for (let slot = 0; slot < 4; slot++) {
        if (spec.resIn[slot] < 0) continue;
        this.demands[h.owner].push({ houseUid: h.uid, unitUid: 0, ware: spec.resIn[slot], slot, script: false, count: 0, being: 0, construction: false, importance: houseDemandImportance(h.typeId, spec.resIn[slot]) });
      }
      if (h.typeId === HOUSE_TYPE_BARRACKS) this.addBarracksDemands(h);
      if (h.typeId === HOUSE_TYPE_STORE) this.addStoreDemands(h);
    }
  }

  /** The barracks' WareInput wtWarfare (KM_HouseBarracks.pas 203–206): one always-on demand per warfare ware,
   *  AddDemand(Self, nil, wtWarfare, 1, dtAlways, diNorm) expanded by the queue (KM_Houses.pas 659). */
  private addBarracksDemands(h: EconHouse): void {
    for (let ware = WARFARE_MIN; ware <= WARFARE_MAX; ware++) {
      this.demands[h.owner].push({ houseUid: h.uid, unitUid: 0, ware, slot: -1, script: false, count: 0, being: 0, construction: false });
    }
  }

  /** The store's WareInput wtAll (KM_Houses.pas 657–660, KM_HouseStore): an always-on demand that takes every
   *  ware (KM_HandLogistics.pas 1863–1870). Expanded per ware here; demandAvailable applies the store rules. */
  private addStoreDemands(h: EconHouse): void {
    for (let ware = 0; ware < WARE_CNT; ware++) {
      this.demands[h.owner].push({ houseUid: h.uid, unitUid: 0, ware, slot: -1, script: false, count: 0, being: 0, construction: false });
    }
  }

  // -------------------------------------------------------------------------------------------
  // RNG helpers (KaMRandom, KM_CommonUtils.pas 1425–1558)

  /** KaMRandom(): the raw post-step state / M (public for the combat systems). */
  draw(): number {
    this.rng = rngStep(this.rng);
    return this.rng / RNG_M;
  }

  /** KaMRandom(n) = Trunc(KaMRandom()*n). */
  drawN(n: number): number {
    return Math.floor(this.draw() * n);
  }

  /** KaMRandomS1(max) = KaMRandom(Round(max*10000))/10000. */
  drawS1(max: number): number {
    return Math.floor(this.draw() * Math.round(max * 10000)) / 10000;
  }

  /** KaMRandomS2(range) = KaMRandom(Round(range*20000)+1)/10000 − range. */
  drawS2(range: number): number {
    return this.drawN(Math.round(range * 20000) + 1) / 10000 - range;
  }

  emit(kind: string, detail: string): void {
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
      const h = this.houseByUid(h1); // houseTile stores uids
      if (h !== null && !h.destroyed && h.entrance.x === x - 1 && h.entrance.y + 1 === y) removeStamp = true;
    }
    if (!removeStamp && h2 !== 0) {
      const h = this.houseByUid(h2);
      if (h !== null && !h.destroyed && h.entrance.x === x && h.entrance.y + 1 === y) removeStamp = true;
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

    if (u.dead) return; // removed by the pass before the next visit
    if (u.fightState === 'die' && st.warrior === null) {
      // Citizen TaskDie (KM_UnitTaskDie.pas 59–116): the locked die stay runs, then CloseUnit.
      if (st.actionLock > 0) {
        st.actionLock -= 1;
        return;
      }
      this.closeUnit(u);
      return;
    }
    if (st.warrior !== null) {
      this.tickWarrior(idx);
      return;
    }

    if (st.walk !== null) {
      const r = walkTick(this.grid, st.walk, u.posF, st.speed);
      if (r.dir !== 0) u.dir = r.dir;
      u.animStep += r.animStep;
      if (r.status === 'walking') {
        this.syncUnitPositions(u, st);
        return; // the action continues: the task is skipped
      }
      st.walk = null;
      u.action = 'stay';
      this.syncUnitPositions(u, st);
    } else if (st.actionLock > 0) {
      st.actionLock -= 1;
      if (st.actionLock > 0) return; // still locked: the task is skipped
    }

    if (st.task !== null) {
      const task = st.task;
      const res = this.runTask(u, st, task);
      if (res === 'continues') {
        this.refreshKind(u, st);
        return;
      }
      st.task = null;
      this.finishTask(u, st, task); // M5a: the builder-task destructors
    }
    this.unitLogic(u, st);
    this.refreshKind(u, st);
  }

  // -------------------------------------------------------------------------------------------
  // Warrior tick (KM_UnitWarrior.UpdateState 1086–1127; docs/M4-SPIKE.md 2.1/2.2)

  /** The warrior override: orders + the mod 6 scan run BEFORE the common tick (see the header). */
  private tickWarrior(idx: number): void {
    const u = this.units[idx];
    const st = this.unitStates[idx];
    const ws = st.warrior as WarriorState;

    // Dying units only run the common tick (1091–1096).
    if (isDeadOrDying(u)) {
      this.warriorCommonTick(u, st);
      return;
    }

    // UpdateOrderTargets (1098) + TakeNextOrder (1107–1108) + the mod 6 enemy scan (1110–1117).
    if (ws.orderTargetUid !== 0) {
      const t = this.unitByUid(ws.orderTargetUid);
      if (t === null || isDeadOrDying(t)) ws.orderTargetUid = 0;
    }
    if (ws.orderTargetHouseUid !== 0) {
      const h = this.houseByUid(ws.orderTargetHouseUid);
      if (h === null || h.destroyed) ws.orderTargetHouseUid = 0;
    }
    if (ws.nextOrder !== 'none') warriorTakeNextOrder(this, u);
    if (ws.ticker % 6 === 0 && !warriorInFight(this, u)) {
      warriorCheckForEnemy(this, u);
      // CheckForEnemyPassingBy (1115–1116) is AI-only: v0 hands are human, so it never runs.
    }

    this.warriorCommonTick(u, st);
  }

  /** TKMUnit.UpdateState (2560–2683) for warriors: killASAP, ticker, hunger, FOW, regen, action, task. */
  private warriorCommonTick(u: EconUnit, st: UnitState): void {
    const ws = st.warrior as WarriorState;
    const spec = st.spec;

    if (ws.killAsap) {
      ws.killAsap = false;
      combatDoKill(this, u, ws.killAsapShowAnimation);
    }

    ws.ticker += 1; // Inc(fTicker) (2597)

    if (ws.ticker % UNIT_CONDITION_PACE === 0 && ws.condition > 0) ws.condition -= 1;
    if (ws.condition <= 0) this.killUnit(u, -1, true, false);

    if (ws.ticker % FOW_PACE === 0) {
      const p = st.posRound;
      const fog = this.fow[u.owner];
      if (fog !== undefined) fog.reveal(p.x, p.y, spec.sight ?? 0, false);
    }

    const maxHp = spec.hitPoints ?? 0;
    if (ws.hitPointCounter % HITPOINT_RESTORE_PACE === 0 && u.hitPoints < maxHp) u.hitPoints += 1;
    ws.hitPointCounter += 1;

    // fAction.Execute (2652–2668).
    if (st.walk !== null) {
      // Walk action arrival (KM_UnitActionWalkTo.pas 1178–1218): the unit snaps to the node, checks
      // for an enemy and can replace the walk with a fight — this is how melee fights start.
      const walk = st.walk;
      const node = walk.nodeList[walk.nodePos];
      const tolerance = st.speed.ortho / 2;
      if (
        node !== undefined &&
        Math.abs(u.posF.x - node.x) < tolerance &&
        Math.abs(u.posF.y - node.y) < tolerance
      ) {
        this.syncUnitPositionsTo(u, st, node);
        if (warriorCheckForEnemy(this, u) && u.fightState === 'fight') return;
      }
      const r = walkTick(this.grid, st.walk, u.posF, st.speed);
      if (r.dir !== 0) u.dir = r.dir;
      u.animStep += r.animStep;
      if (r.status === 'walking') {
        this.syncUnitPositions(u, st);
        return;
      }
      st.walk = null;
      u.action = 'stay';
      this.syncUnitPositions(u, st);
    } else if (u.fightState === 'fight') {
      const res = executeFightAction(this, u);
      if (res === 'continues') return;
    } else if (ws.stayActive) {
      if (!ws.stayStill) u.animStep += 1;
      if (st.actionLock > 0) st.actionLock -= 1;
      if (st.actionLock <= 0) ws.stayActive = false;
      if (ws.stayActive) return;
    }

    // fTask.Execute (2671–2678).
    if (ws.task !== null) {
      const res = ws.task.kind === 'die' ? executeDieTask(this, u) : executeAttackHouseTask(this, u);
      if (res === 'continues') return;
      ws.task = null;
    }

    // Action is gone: SetActionStay(50, uaWalk) (1126).
    if (st.walk === null && u.fightState !== 'fight' && !ws.stayActive && ws.task === null) {
      this.setStay(u, 50, false, true, 0);
    }
  }

  /** SetPositionRoundByPosF (KM_Units.pas 1755–1763) + the FOW reveal on a tile change (1744–1752). */
  private syncUnitPositions(u: EconUnit, st: UnitState): void {
    const w = st.walk;
    let chosen: Pt;
    if (w !== null && w.nodeList.length > 0) {
      const prev = w.nodeList[Math.max(w.nodePos - 1, 0)];
      const next = w.nodeList[Math.min(w.nodePos, w.nodeList.length - 1)];
      chosen = lengthSqr(prev, u.posF) < lengthSqr(next, u.posF) ? prev : next;
    } else {
      chosen = { x: this.round(u.posF.x), y: this.round(u.posF.y) };
    }

    const nextTile =
      w !== null && w.nodeList.length > 0
        ? w.nodeList[Math.min(w.nodePos, w.nodeList.length - 1)]
        : chosen;
    const prevTile = w !== null && w.nodePos >= 1 ? w.nodeList[w.nodePos - 1] : chosen;

    if (chosen.x !== st.posRound.x || chosen.y !== st.posRound.y) {
      st.posRound = { x: chosen.x, y: chosen.y };
      if (u.owner >= 0 && !u.inside) {
        const fog = this.fow[u.owner];
        if (fog !== undefined) fog.reveal(chosen.x, chosen.y, st.spec.sight ?? 0, true);
      }
    }
    st.posPrev = { x: prevTile.x, y: prevTile.y };
    this.setUnitPosNext(u, st, nextTile);
  }

  /** The walk-arrival sync: the unit stands on `node` (KM_UnitActionWalkTo.pas 1178–1192). */
  private syncUnitPositionsTo(u: EconUnit, st: UnitState, node: Pt): void {
    if (node.x !== st.posRound.x || node.y !== st.posRound.y) {
      st.posRound = { x: node.x, y: node.y };
      if (u.owner >= 0 && !u.inside) {
        const fog = this.fow[u.owner];
        if (fog !== undefined) fog.reveal(node.x, node.y, st.spec.sight ?? 0, true);
      }
    }
    st.posPrev = { x: node.x, y: node.y };
    this.setUnitPosNext(u, st, node);
  }

  /** Terrain UnitAdd/UnitRem (KM_Terrain.pas 4243–4260): the tile holds the unit at PositionNext. */
  private setUnitPosNext(u: EconUnit, st: UnitState, pt: Pt): void {
    const old = st.posNext;
    if (old.x >= 0 && old.x <= this.map.mapX && old.y >= 0 && old.y <= this.map.mapY) {
      const oi = this.index(old.x, old.y);
      if (this.unitTile[oi] === u.uid) this.unitTile[oi] = 0;
    }
    if (pt.x >= 0 && pt.x <= this.map.mapX && pt.y >= 0 && pt.y <= this.map.mapY) {
      this.unitTile[this.index(pt.x, pt.y)] = u.uid;
    }
    st.posNext = { x: pt.x, y: pt.y };
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

  private walkTo(u: EconUnit, st: UnitState, to: Pt): boolean {
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
      case 'stone':
        return this.runStone(u, st, task);
      case 'saw':
        return this.runSaw(u, st, task);
      case 'workshop':
        return this.runWorkshop(u, st, task);
      case 'smith':
        return this.runSmith(u, st, task);
      case 'deliver':
        return this.runDeliver(u, st, task);
      case 'buildHouseArea':
        return this.runBuildHouseArea(u, st, task);
      case 'buildHouse':
        return this.runBuildHouse(u, st, task);
      case 'buildRoad':
        return this.runBuildRoad(u, st, task);
      case 'buildField':
        return this.runBuildField(u, st, task);
      case 'selfTrain':
        return this.runSelfTrain(u, st, task);
      default:
        return 'done';
    }
  }

  /** The woodcutter's flag point (KM_HouseWoodcutters.FlagPoint): the AI sets it once. */
  setHouseFlagPoint(houseUid: number, x: number, y: number): void {
    const h = this.houseByUid(houseUid);
    if (h !== null) h.flagPoint = { x, y };
  }

  /** TKMHouse.Demolish from the AI (exhausted mines, chop-only woodcutters, unused houses). */
  demolishHouseByUid(houseUid: number, fromOwner: number): boolean {
    const h = this.houseByUid(houseUid);
    if (h === null || h.destroyed) return false;
    this.demolishHouse(h, fromOwner);
    return true;
  }

  /** The unit's home, or null when the house is gone or destroyed (the task then abandons). */
  private homeOf(st: UnitState): EconHouse | null {
    if (st.homeUid === 0) return null;
    const home = this.houseByUid(st.homeUid);
    if (home === null || home.destroyed) return null;
    return home;
  }

  /** A worker whose home is destroyed loses it and will look for a new one next tick
   *  (Demolish leaves disposing of units inside the house to themselves, KM_Houses.pas 782). */
  private loseHome(u: EconUnit, st: UnitState): void {
    st.homeUid = 0;
    u.homeUid = 0;
    st.task = null;
    if (u.inside) u.inside = false; // the house is gone; the unit stands at its entrance (goIn)
    this.emit('home-lost', `unit#${u.uid}`);
  }

  private runGoHome(u: EconUnit, st: UnitState, task: { phase: number }): 'continues' | 'done' {
    const home = this.homeOf(st);
    if (home === null) {
      this.loseHome(u, st);
      return 'done';
    }
    switch (task.phase) {
      case 0: {
        // Walk to Home.PointBelowEntrance (KM_UnitTaskGoHome.pas 51–54).
        const target = pointBelowEntrance(home);
        if (samePoint({ x: Math.round(u.posF.x), y: Math.round(u.posF.y) }, target)) {
          st.actionLock = 1; // a zero-length walk still costs its action tick
        } else if (!this.walkTo(u, st, target)) {
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
    const home = this.homeOf(st);
    if (home === null) {
      this.loseHome(u, st);
      return 'done';
    }
    switch (task.phase) {
      case 0: // go outside (KM_UnitTaskMining.pas 247–256)
        this.goOut(u, st, home);
        task.phase = 1;
        return 'continues';
      case 1: {
        const plan = task.plan;
        if (plan === null) return 'done';
        if (!this.walkTo(u, st, plan.loc)) {
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
        } else if (!this.walkTo(u, st, target)) {
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
            this.addOffer(home.uid, WT_TRUNK, 1);
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
    const home = this.homeOf(st);
    if (home === null) {
      this.loseHome(u, st);
      return 'done';
    }
    const plan = this.chooseChopPlan(home, st);
    if (plan === null) return 'done'; // no other work plan (KM_UnitTaskMining.pas 141–159)
    task.plan = plan;
    task.phase = 1; // re-walk to the new spot
    this.setLockedStay(u, st, 0, false);
    this.emit('chop-plan', `tree=(${vertexTile(plan.loc, plan.dir).x},${vertexTile(plan.loc, plan.dir).y})`);
    return 'continues';
  }

  // -------------------------------------------------------------------------------------------
  // M5c stonemason (KM_UnitWorkPlan.pas 500–513; KM_UnitTaskMining.pas 240–339, gsStoneCutter)

  /** runChop mirror for the stonemason: walk to the tile below the stone deposit (dirN), face north,
   * DecStoneDeposit at phase 6, skip house work acts (phase 9 → 35), produce stone at phase 35.
   * WalkStyle(..., uaWork, 8, 0, ...) → WorkCyc = 8, AfterWorkDelay = 0. */
  private runStone(
    u: EconUnit,
    st: UnitState,
    task: { phase: number; plan: StonePlan | null; distant: boolean },
  ): 'continues' | 'done' {
    const home = this.homeOf(st);
    if (home === null) {
      this.loseHome(u, st);
      return 'done';
    }
    const houseSpec = this.houseState(home).spec;
    const houseAct = (a: number): number => (houseSpec !== undefined ? houseSpec.animCounts[a] : 0);
    switch (task.phase) {
      case 0: // go outside (KM_UnitTaskMining.pas 247–256)
        this.goOut(u, st, home);
        task.phase = 1;
        return 'continues';
      case 1: {
        const plan = task.plan;
        if (plan === null) return 'done';
        if (!this.walkTo(u, st, plan.loc)) {
          return this.replanStone(u, st, task);
        }
        task.phase = 2;
        return 'continues';
      }
      case 2: {
        const plan = task.plan;
        if (plan === null) return 'done';
        const spot = { x: Math.round(u.posF.x), y: Math.round(u.posF.y) };
        // The stone deposit is on the tile above the walkable spot (loc.y − 1, KMPointDir(loc, dirN)).
        if (!samePoint(spot, plan.loc) || !this.tileHasStone(plan.loc.x, plan.loc.y - 1)) {
          return this.replanStone(u, st, task);
        }
        this.setLockedStay(u, st, 0, false);
        task.phase = 3;
        return 'continues';
      }
      case 3: // before-work stay (281)
        this.setLockedStay(u, st, 0, false);
        task.phase = 4;
        return 'continues';
      case 4: {
        // Choose direction (dirN = 1, the stone is above) and time to work (WorkCyc = 8).
        const plan = task.plan;
        if (plan === null) return 'done';
        let dir = 1; // dirN — stone tile is at loc.y − 1
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
        const timeToWork = 8 * Math.max(count, 1); // WalkStyle(..., uaWork, 8, 0, ...)
        this.setLockedStay(u, st, timeToWork, true);
        task.phase = 5;
        return 'continues';
      }
      case 5: // after-work stay (else: 0 ticks, gsStoneCutter is not gsFisherCatch, 300–304)
        this.setLockedStay(u, st, 0, true);
        task.phase = 6;
        return 'continues';
      case 6: {
        // DecStoneDeposit(loc.x, loc.y−1) + AfterWorkDelay(0) stay (305–330).
        const plan = task.plan;
        if (plan === null) return 'done';
        task.distant = this.decStoneDeposit(plan.loc.x, plan.loc.y - 1);
        this.setLockedStay(u, st, 0, true);
        task.phase = 7;
        return 'continues';
      }
      case 7: {
        // Go home (333).
        const target = pointBelowEntrance(home);
        if (samePoint({ x: Math.round(u.posF.x), y: Math.round(u.posF.y) }, target)) {
          st.actionLock = 1;
        } else if (!this.walkTo(u, st, target)) {
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
        // Back at home (339–366): no resources to take. The house acts run only when stone was acquired
        // (fDistantResAcquired and fPhase2 < ActCount, KM_UnitTaskMining.pas 355–366); else SKIP_WORK.
        // The quarry plan is haWork1 x1, haWork2 x9, haWork5 x1 (KM_UnitWorkPlan.pas 500–509).
        home.state = 'work';
        if (!task.distant) {
          task.phase = 35;
          this.setLockedStay(u, st, 0, false);
          return 'continues';
        }
        this.setLockedStay(u, st, houseAct(0), true);
        task.phase = 10;
        return 'continues';
      }
      case 10:
        this.setLockedStay(u, st, houseAct(1) * 9, true);
        task.phase = 11;
        return 'continues';
      case 11:
        this.setLockedStay(u, st, houseAct(4), true);
        task.phase = 35;
        return 'continues';
      case 35: {
        // WareAddToOut(wtStone, ResProductionX) + hstIdle + AfterWorkIdle−1 (413–424).
        if (task.distant) {
          const slot = this.outSlot(home, WT_STONE);
          const prod = this.houseState(home).spec?.productionX ?? 1;
          if (slot >= 0) {
            home.wareOut[slot] += prod;
            this.addOffer(home.uid, WT_STONE, prod);
            this.emit('stone-out', `quarry#${home.uid} ${home.wareOut[slot]}`);
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

  private replanStone(
    u: EconUnit,
    st: UnitState,
    task: { phase: number; plan: StonePlan | null; distant: boolean },
  ): 'continues' | 'done' {
    const home = this.homeOf(st);
    if (home === null) {
      this.loseHome(u, st);
      return 'done';
    }
    const plan = this.chooseStonePlan(home, st);
    if (plan === null) return 'done'; // no other work plan (KM_UnitTaskMining.pas 141–159)
    task.plan = plan;
    task.phase = 1; // re-walk to the new spot
    this.setLockedStay(u, st, 0, false);
    this.emit('stone-plan', `loc=(${plan.loc.x},${plan.loc.y})`);
    return 'continues';
  }

  private runSaw(u: EconUnit, st: UnitState, task: { phase: number; phase2: number }): 'continues' | 'done' {
    const home = this.homeOf(st);
    if (home === null) {
      this.loseHome(u, st);
      return 'done';
    }
    const spec = this.houseState(home).spec;
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
          this.addOffer(home.uid, WT_TIMBER, prod);
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

  // -------------------------------------------------------------------------------------------
  // M5c smith (KM_UnitWorkPlan.pas 411–451; KM_UnitTaskMining.pas 240–367, htWeaponWorkshop/utSmith)

  /** runSaw mirror for the smith: HasToWalk=False (skip to phase 9), take 2 timber, 3 work cycles,
   * produce 1 axe at phase 35, emit `ware-produced`. ResourcePlan(wtTimber,2,wtNone,0,wtAxe). */
  private runSmith(u: EconUnit, st: UnitState, task: { phase: number; phase2: number }): 'continues' | 'done' {
    const home = this.homeOf(st);
    if (home === null) {
      this.loseHome(u, st);
      return 'done';
    }
    const spec = this.houseState(home).spec;
    const anim = (act: number): number => (spec !== undefined ? spec.animCounts[act] : 0);
    switch (task.phase) {
      case 0: // HasToWalk = False → skip to phase 9 (KM_UnitTaskMining.pas 257–263)
        this.setLockedStay(u, st, 0, false);
        task.phase = 9;
        return 'continues';
      case 9: {
        // Take 2 timber from input + first house act.
        const slot = this.inSlot(home, WT_TIMBER);
        if (slot >= 0 && home.wareIn[slot] >= 2) home.wareIn[slot] -= 2;
        home.state = 'work';
        home.workAnimStep = 0;
        this.emit('timber-taken', `workshop#${home.uid} in=${slot >= 0 ? home.wareIn[slot] : 0}`);
        this.setLockedStay(u, st, anim(0), true);
        task.phase2 = 0;
        task.phase = 10;
        return 'continues';
      }
      case 10:
        task.phase2 += 1;
        if (task.phase2 < 3) {
          home.workAnimStep = 0;
          // SubActAdd(haWork2, 1) → TimeToWork = Count × 25 (KM_UnitWorkPlan.pas 380).
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
        // WareAddToOut(wtAxe, 1) + ProcWareProduced + hstIdle + AfterWorkIdle−1.
        const slot = this.outSlot(home, WT_AXE);
        const prod = spec?.productionX ?? 1;
        if (slot >= 0) {
          home.wareOut[slot] += prod;
          this.addOffer(home.uid, WT_AXE, prod);
          this.emit('ware-produced', `/ axe house#${home.uid} ${home.wareOut[slot]}`);
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

  // -------------------------------------------------------------------------------------------
  // M5e workshops (KM_UnitWorkPlan.pas 376–421; KM_Houses.pas 1575–1649 PickOrder; KM_ResWares.pas 72–83)

  private wareInCount(h: EconHouse, ware: number): number {
    const slot = ware >= 0 ? this.inSlot(h, ware) : -1;
    return slot >= 0 ? h.wareIn[slot] : 0;
  }

  private wareOutCount(h: EconHouse, ware: number): number {
    const slot = ware >= 0 ? this.outSlot(h, ware) : -1;
    return slot >= 0 ? h.wareOut[slot] : 0;
  }

  /** TKMHouse.SetWareOrder (KM_Houses.pas 1555–1565): WareOrder[resI] for output slot resI (1..4). */
  setWareOrder(houseUid: number, resI: number, amount: number): void {
    const h = this.houseByUid(houseUid);
    if (h === null || h.destroyed || resI < 1 || resI > 4) return;
    const orders = this.houseState(h).wareOrder;
    if (orders === undefined) return;
    orders[resI - 1] = clamp(Math.trunc(amount), 0, MAX_WARES_ORDER);
  }

  /** WareOrder[resI] of a workshop (KM_Houses.pas 1549). */
  wareOrderOf(houseUid: number, resI: number): number {
    const h = this.houseByUid(houseUid);
    if (h === null || resI < 1 || resI > 4) return 0;
    return this.houseState(h).wareOrder?.[resI - 1] ?? 0;
  }

  /**
   * TKMHouse.PickOrder (KM_Houses.pas 1575–1601, FEAT_WARFARE_ORDER_SEQUENTIAL): the next output slot in
   * round-robin order with an order left, free output room and the input wares. The order is consumed
   * when picked (Dec, :1637). Returns the output slot (0..3), or -1.
   */
  private pickOrder(home: EconHouse): number {
    const st = this.houseState(home);
    const spec = st.spec;
    const orders = st.wareOrder;
    if (spec === undefined || orders === undefined) return -1;
    const last = st.lastOrderProduced ?? 0;
    for (let i = 0; i < 4; i++) {
      const resI = ((last + i) % 4) + 1;
      const slot = resI - 1;
      const ware = spec.resOut[slot];
      if (ware < 0 || orders[slot] <= 0) continue;
      if (this.wareOutCount(home, ware) >= MAX_WARES_IN_HOUSE) continue;
      const cost = WARFARE_COSTS[ware];
      if (cost === undefined) continue;
      const [c1, c2] = cost;
      if (!(c1 !== c2 || this.wareInCount(home, c1) > 1)) continue;
      if (!(c1 < 0 || this.wareInCount(home, c1) > 0)) continue;
      if (!(c2 < 0 || this.wareInCount(home, c2) > 0)) continue;
      st.lastOrderProduced = resI;
      orders[slot] -= 1;
      return slot;
    }
    return -1;
  }

  /** The house acts of a workshop plan (KM_UnitWorkPlan.pas 376–421), as stay lengths: an axe/lance/bow
   *  plan is haWork1, three (haWork2+3+4), haWork5; a wooden shield is four (haWork2+3+4) and haWork2 x0.25. */
  private workshopSteps(product: number, spec: HouseSpec): number[] {
    const act = (a: number): number => spec.animCounts[a] ?? 0;
    const steps: number[] = [];
    if (product === WT_WOODEN_SHIELD) {
      for (let i = 0; i < 4; i++) steps.push(act(1), act(2), act(3));
      steps.push(Math.round(act(1) * 0.25));
      return steps;
    }
    steps.push(act(0));
    for (let i = 0; i < 3; i++) steps.push(act(1), act(2), act(3));
    steps.push(act(4));
    return steps;
  }

  /** TaskGetWork for a carpenter at a workshop (KM_Units.pas 714–752): PickOrder, then the task is kept only
   *  when its inputs and the output room are there (the Pascal discards it otherwise, :744–752). */
  private workshopTask(home: EconHouse): Task | null {
    const slot = this.pickOrder(home);
    if (slot < 0) return null;
    const spec = this.houseState(home).spec;
    if (spec === undefined) return null;
    const product = spec.resOut[slot];
    const costs = (WARFARE_COSTS[product] ?? [-1, -1]).filter((w) => w >= 0);
    for (const ware of new Set(costs)) {
      if (this.wareInCount(home, ware) < costs.filter((w) => w === ware).length) return null;
    }
    if (this.wareOutCount(home, product) >= MAX_WARES_IN_HOUSE) return null;
    return { kind: 'workshop', phase: 0, phase2: 0, product, costs, steps: this.workshopSteps(product, spec), stepIdx: 0 };
  }

  /** TKMTaskMining for a workshop (KM_UnitTaskMining.pas 339–424): the carpenter is inside, takes the input
   *  wares (WareTakeFromIn), works the house acts (SubActionWork), then WareAddToOut(product, ResProductionX). */
  private runWorkshop(
    u: EconUnit,
    st: UnitState,
    task: { phase: number; phase2: number; product: number; costs: number[]; steps: number[]; stepIdx: number },
  ): 'continues' | 'done' {
    const home = this.homeOf(st);
    if (home === null) {
      this.loseHome(u, st);
      return 'done';
    }
    const spec = this.houseState(home).spec;
    switch (task.phase) {
      case 0:
        this.setLockedStay(u, st, 0, false);
        task.phase = 1;
        return 'continues';
      case 1: {
        home.state = 'work';
        home.workAnimStep = 0;
        for (const ware of task.costs) {
          const slot = this.inSlot(home, ware);
          if (slot >= 0 && home.wareIn[slot] > 0) home.wareIn[slot] -= 1;
        }
        this.emit('workshop-start', `workshop#${home.uid} product=${task.product}`);
        task.phase = 2;
        this.setLockedStay(u, st, 0, true);
        return 'continues';
      }
      case 2:
        if (task.stepIdx < task.steps.length) {
          const time = task.steps[task.stepIdx];
          task.stepIdx += 1;
          this.setLockedStay(u, st, time, true);
          return 'continues';
        }
        task.phase = 3;
        this.setLockedStay(u, st, 0, false);
        return 'continues';
      case 3: {
        const slot = this.outSlot(home, task.product);
        const prod = spec !== undefined ? spec.productionX : 1;
        if (slot >= 0) {
          home.wareOut[slot] += prod;
          this.addOffer(home.uid, task.product, prod);
          this.emit('ware-produced', `house#${home.uid} ware=${task.product} ${home.wareOut[slot]}`);
        }
        home.state = 'idle';
        this.setLockedStay(u, st, this.afterWorkIdle(home), false);
        task.phase = 4;
        return 'continues';
      }
      default:
        return 'done';
    }
  }

  private abandonDelivery(task: { fromUid: number; ware: number; demand: Demand; taken: boolean }): void {
    task.demand.being -= 1;
    if (task.taken) {
      // Put the ware back into the offer house so it can be re-offered (the game's RemOffer path).
      // A destroyed from-house no longer exists: the ware is lost with it (Demolish consumes it).
      const from = this.houseByUid(task.fromUid);
      if (from === null || from.destroyed) return;
      const st = this.houseState(from);
      if (st.stock !== null) {
        st.stock[task.ware] = Math.min(65535, st.stock[task.ware] + 1);
        this.addOffer(from.uid, task.ware, 1);
      } else {
        const slot = this.outSlot(from, task.ware);
        if (slot >= 0) from.wareOut[slot] += 1;
        this.addOffer(from.uid, task.ware, 1);
      }
    }
  }

  private runDeliver(
    u: EconUnit,
    st: UnitState,
    task: { phase: number; fromUid: number; toUid: number; toUnitUid: number; ware: number; demand: Demand; taken: boolean; deliverKind: 'house' | 'construction' | 'unit' },
  ): 'continues' | 'done' {
    // Houses are resolved by uid every tick: a destroyed house may be deleted from the array while
    // this task still references it (KM_HouseCollection.pas 426–436; KM_UnitTaskDelivery.pas 361).
    const from = this.houseByUid(task.fromUid);
    const to = this.houseByUid(task.toUid);
    const toGone = task.toUnitUid !== 0 ? this.unitByUid(task.toUnitUid) === null : to === null || to.destroyed;
    const fromGone = from === null || from.destroyed;
    if (toGone || (fromGone && task.phase <= 2)) {
      this.abandonDelivery(task);
      this.emit('delivery-abandoned', `unit#${u.uid} ware=${task.ware} from#${task.fromUid} to#${task.toUid}`);
      return 'done';
    }
    switch (task.phase) {
      case 0: {
        const target = pointBelowEntrance(from as EconHouse);
        if (samePoint({ x: Math.round(u.posF.x), y: Math.round(u.posF.y) }, target)) {
          st.actionLock = 1;
        } else if (!this.walkTo(u, st, target)) {
          this.abandonDelivery(task);
          return 'done';
        }
        task.phase = 1;
        return 'continues';
      }
      case 1:
        this.goIn(u, st, from as EconHouse);
        task.phase = 2;
        return 'continues';
      case 2: {
        // Take the ware (KM_UnitTaskDelivery.pas 372–388) + stay 5.
        if (!this.takeFromOut(from as EconHouse, task.ware)) {
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
        // We have the ware, so a destroyed from-house no longer matters (390–395).
        if (fromGone) this.setLockedStay(u, st, 0, false);
        else this.goOut(u, st, from as EconHouse);
        task.phase = 5;
        return 'continues';
      case 5: {
        if (task.deliverKind === 'unit') {
          // KM_UnitTaskDelivery.pas 490: SetActionWalkToUnit(fToUnit, 1.42, uaWalk).
          const target = this.unitByUid(task.toUnitUid);
          if (target === null) {
            this.abandonDelivery(task);
            return 'done';
          }
          const tp = this.roundPos(target);
          if (samePoint({ x: Math.round(u.posF.x), y: Math.round(u.posF.y) }, tp)) {
            st.actionLock = 1;
          } else if (!this.walkTo(u, st, tp)) {
            st.actionLock = 1;
          }
          task.phase = 6;
          return 'continues';
        }
        // KM_UnitTaskDelivery.pas 419 (dkToHouse) / 459 (dkToConstruction): walk to PointBelowEntrance.
        const target = pointBelowEntrance(to as EconHouse);
        if (samePoint({ x: Math.round(u.posF.x), y: Math.round(u.posF.y) }, target)) {
          st.actionLock = 1;
        } else if (!this.walkTo(u, st, target)) {
          this.abandonDelivery(task);
          return 'done';
        }
        task.phase = 6;
        return 'continues';
      }
      case 6: {
        if (task.deliverKind === 'unit') {
          // KM_UnitTaskDelivery.pas 491–513: hand the ware to the builder; a road/wine builder that
          // is still digging is waited for, otherwise his task phase is advanced by one.
          const target = this.unitByUid(task.toUnitUid);
          if (target === null) {
            this.abandonDelivery(task);
            return 'done';
          }
          const tp = this.roundPos(target);
          const spot = { x: Math.round(u.posF.x), y: Math.round(u.posF.y) };
          const far = C.diagDistance(u.posF.x, u.posF.y, target.posF.x, target.posF.y) > 1.5; // (493)
          if (!samePoint(spot, tp) || far) {
            if (!this.walkTo(u, st, tp)) st.actionLock = 1;
            return 'continues'; // retry phase 6 next tick
          }
          const tst = this.unitStateMap.get(target);
          if (tst !== undefined && tst.task !== null) {
            const tt = tst.task;
            const waiting =
              (tt.kind === 'buildRoad' && tt.phase < 4) || (tt.kind === 'buildField' && tt.phase < 3);
            if (waiting) {
              this.setLockedStay(u, st, 5, false); // Wait until the worker finishes digging
              return 'continues'; // phase 6 again
            }
            tt.phase += 1; // fToUnit.Task.Phase := fToUnit.Task.Phase + 1
            this.setLockedStay(target, tst, 0, true); // SetActionLockedStay(0, uaWork1)
          }
          u.carry = -1;
          task.demand.being -= 1;
          if (task.demand.script) task.demand.count -= 1;
          this.emit('ware-delivered', `ware=${task.ware} unit#${task.toUnitUid}`);
          this.setLockedStay(u, st, 5, false); // Pause briefly (like handing over the ware)
          task.phase = 7;
          return 'continues';
        }
        if (task.deliverKind === 'construction') {
          // 460–471: if a builder is hitting the house from the entrance, bring the ware diagonally
          // to the entrance tile, else walk to PointBelowEntrance (the serf is usually already there).
          const below = pointBelowEntrance(to as EconHouse);
          const builder = this.builderHittingAt(below.x, below.y, u.owner);
          const target = builder ? (to as EconHouse).entrance : below;
          const spot = { x: Math.round(u.posF.x), y: Math.round(u.posF.y) };
          if (samePoint(spot, target)) {
            st.actionLock = 1;
          } else if (!this.walkTo(u, st, target)) {
            st.actionLock = 1; // the Pascal's 1.42-tolerance walk just stops; the ware still lands
          }
          task.phase = 7;
          return 'continues';
        }
        this.goIn(u, st, to as EconHouse);
        task.phase = 7;
        return 'continues';
      }
      case 7: {
        if (task.deliverKind === 'unit') {
          // (527–553): after handing over to a builder the serf just stops; phase 8 ends the task.
          this.setUnlockedStay(u, st, 0); // SetActionStay(0, uaWalk)
          task.phase = 8;
          return 'continues';
        }
        if (task.deliverKind === 'construction') {
          // 472–481: WareAddToBuild(Carry) + GaveDemand + AbandonDelivery + SetActionStay(1, uaWalk).
          this.wareAddToBuild(to as EconHouse, task.ware);
          u.carry = -1;
          task.demand.being -= 1;
          if (task.demand.script) task.demand.count -= 1;
          this.emit('ware-delivered', `ware=${task.ware} house#${(to as EconHouse).uid}`);
          this.setUnlockedStay(u, st, 1);
          task.phase = 8;
          return 'continues';
        }
        this.setLockedStay(u, st, 5, false);
        task.phase = 8;
        return 'continues';
      }
      case 8: {
        if (task.deliverKind === 'construction' || task.deliverKind === 'unit') return 'done';
        // WareAddToIn + CarryTake + GaveDemand (422–449).
        this.addToIn(to as EconHouse, task.ware);
        u.carry = -1;
        task.demand.being -= 1;
        if (task.demand.script) task.demand.count -= 1;
        this.emit('ware-delivered', `ware=${task.ware} house#${(to as EconHouse).uid}`);
        this.goOut(u, st, to as EconHouse);
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
          this.houseState(home).workerUid = u.uid;
          home.workerUid = u.uid;
        }
        this.emit('worker-assigned', `unit#${u.uid} type=${u.type} house#${home.uid}`);
        st.task = { kind: 'goHome', phase: 0 };
        return;
      }
      this.setUnlockedStay(u, st, 20); // no home yet: don't sleep too long (651)
      return;
    }

    const home = this.homeOf(st);
    if (home === null) {
      // The home was destroyed: the worker becomes homeless and looks for a new one.
      this.loseHome(u, st);
      this.setUnlockedStay(u, st, 20);
      return;
    }
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
    for (const h of this.houses) {
      if (h.destroyed) continue;
      const hs = this.houseState(h);
      if (hs.spec === undefined) continue;
      if (h.owner !== u.owner) continue; // gHands[Owner].Houses.FindEmptyHouse (KM_Units.pas 467)
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

    // M5c: stonemason at htQuarry (KM_UnitTaskMining.pas 500–513; FindStone 2584–2628).
    if (u.type === 10 && home.typeId === 14) {
      // Refuse when the stone output is full (748–752 / 724–728).
      const outSlot = this.outSlot(home, WT_STONE);
      if (outSlot >= 0 && home.wareOut[outSlot] >= MAX_WARES_IN_HOUSE) {
        this.setUnlockedStay(u, st, this.restStay(home));
        return;
      }
      const plan = this.chooseStonePlan(home, st);
      if (plan === null) {
        this.setUnlockedStay(u, st, this.restStay(home));
        return;
      }
      st.task = { kind: 'stone', phase: 0, plan, distant: false };
      this.emit('stone-plan', `loc=(${plan.loc.x},${plan.loc.y})`);
      return;
    }

    // M5c: smith at htWeaponWorkshop (KM_UnitWorkPlan.pas 411–451; ResourcePlan wtTimber,2→wtAxe).
    if (u.type === 11 && home.typeId === 19) {
      // Needs 2 timber in and room for the axe output (746–749).
      const inSlot = this.inSlot(home, WT_TIMBER);
      const outSlot = this.outSlot(home, WT_AXE);
      const hasTimber = inSlot >= 0 && home.wareIn[inSlot] >= 2;
      const hasRoom = outSlot < 0 || home.wareOut[outSlot] < MAX_WARES_IN_HOUSE;
      if (hasTimber && hasRoom) {
        st.task = { kind: 'smith', phase: 0, phase2: 0 };
        return;
      }
      this.setUnlockedStay(u, st, this.restStay(home));
      return;
    }

    if (u.type === UNIT_CARPENTER && (home.typeId === HOUSE_TYPE_WEAPON_WORKSHOP || home.typeId === HOUSE_TYPE_ARMOR_WORKSHOP)) {
      const task = this.workshopTask(home);
      if (task !== null) {
        st.task = task;
        return;
      }
      this.setUnlockedStay(u, st, this.restStay(home));
      return;
    }

    // Every other (worker, house) combination is out of v0 scope: rest at home.
    this.setUnlockedStay(u, st, this.restStay(home));
  }

  private restStay(home: EconHouse): number {
    const spec = this.houseState(home).spec;
    const rest = spec !== undefined ? spec.workerRest : WORKER_REST_DEFAULT;
    return Math.max(rest, 1) * 10;
  }

  private afterWorkIdle(home: EconHouse): number {
    const spec = this.houseState(home).spec;
    const rest = spec !== undefined ? spec.workerRest : WORKER_REST_DEFAULT;
    return Math.max(rest * 10 - 1, 0);
  }

  // -------------------------------------------------------------------------------------------
  // House ware handshakes (KM_Houses.pas 1710–2010, KM_HouseStore.pas 96–112)

  private inSlot(h: EconHouse, ware: number): number {
    const spec = this.houseState(h).spec;
    if (spec === undefined) return -1;
    for (let i = 0; i < 4; i++) if (spec.resIn[i] === ware) return i;
    return -1;
  }

  private outSlot(h: EconHouse, ware: number): number {
    const spec = this.houseState(h).spec;
    if (spec === undefined) return -1;
    for (let i = 0; i < 4; i++) if (spec.resOut[i] === ware) return i;
    return -1;
  }

  /** Add an offer for a house (uid-keyed). Gone/destroyed houses never get offers. */
  private addOffer(houseUid: number, ware: number, count: number): void {
    if (count === 0) return;
    const house = this.houseByUid(houseUid);
    if (house === null || house.destroyed) return;
    const list = this.offers[house.owner];
    for (const o of list) {
      if (o.houseUid === houseUid && o.ware === ware) {
        o.count += count;
        return;
      }
    }
    list.push({ houseUid, ware, count });
  }

  private takeFromOut(h: EconHouse, ware: number): boolean {
    if (h.destroyed) return false;
    const st = this.houseState(h);
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
    if (h.destroyed) return;
    const st = this.houseState(h);
    if (st.stock !== null) {
      // Store (KM_HouseStore.pas 96–112): clamp the stock and create an offer. A barracks (M5e) keeps
      // the stock but makes no offer: its takeout mode is off by default (KM_HouseBarracks.pas 319–320).
      st.stock[ware] = Math.min(65535, st.stock[ware] + 1);
      if (h.typeId !== HOUSE_TYPE_BARRACKS) this.addOffer(h.uid, ware, 1);
      return;
    }
    const slot = this.inSlot(h, ware);
    if (slot >= 0) h.wareIn[slot] += 1;
    // TKMHouseSchool.WareAddToIn (:104–110): a delivery may start the next training.
    if (st.schoolQueue !== undefined && st.unitWipUid === 0) this.schoolStartTraining(h.uid);
  }

  // -------------------------------------------------------------------------------------------
  // Logistics (v0 rule, spec 2.7)

  private demandAvailable(d: Demand): number {
    if (d.unitUid !== 0) {
      // A unit demand (the road builder's stone, KM_UnitTaskBuild.pas 241): the unit must still
      // exist and want the ware; RemDemand drops the entry when the task ends (:175–176).
      const u = this.unitByUid(d.unitUid);
      if (u === null || u.dead) return 0;
      // dtOnce (1199): a reserved delivery blocks the next one.
      return d.being > 0 ? 0 : Math.max(d.count - d.being, 0);
    }
    if (d.script) {
      const h = this.houseByUid(d.houseUid);
      if (h === null || h.destroyed) return 0;
      // Construction demands are dtOnce too (one reserved delivery at a time, 1199) and a WIP
      // house always accepts (1229–1231). Plain script demands keep the v0 count rule.
      if (d.construction) return d.being > 0 ? 0 : Math.max(d.count - d.being, 0);
      return Math.max(d.count - d.being, 0);
    }
    const h = this.houseByUid(d.houseUid);
    if (h === null || h.destroyed) return 0;
    // A barracks warfare demand has no input slot: the barracks takes every warfare ware (no cap).
    if (d.slot < 0) {
      if (h.typeId === HOUSE_TYPE_STORE) return this.storeAccepts(h, d.ware) ? STORE_NO_CAP : 0;
      return Math.max(1 - d.being, 0);
    }
    const cap = MAX_WARES_IN_HOUSE; // GetWareDistribution default 5 (KM_WareDistribution.pas 71–88)
    return clamp(cap - h.wareIn[d.slot] - d.being, 0, MAX_WARES_IN_HOUSE);
  }

  /** A store takes a ware unless it is warfare and the hand has a barracks (KM_HandLogistics.pas 1243–1250). */
  private storeAccepts(store: EconHouse, ware: number): boolean {
    if (ware < WARFARE_MIN || ware > WARFARE_MAX) return true;
    return this.handHouseTotalCount(store.owner, HOUSE_TYPE_BARRACKS) === 0;
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

      // One road BFS and one nearest-serf search per offer house per pass (cached).
      const distCache = new Map<number, Int32Array>();
      const distances = (house: EconHouse): Int32Array => {
        let d = distCache.get(house.uid);
        if (d === undefined) {
          d = this.roadDistances(pointBelowEntrance(house));
          distCache.set(house.uid, d);
        }
        return d;
      };
      const serfCache = new Map<number, { serf: number; len: number }>();
      const nearestSerf = (house: EconHouse): { serf: number; len: number } => {
        let s = serfCache.get(house.uid);
        if (s === undefined) {
          s = { serf: -1, len: Number.POSITIVE_INFINITY };
          for (const si of idle) {
            const su = this.units[si];
            const from = { x: Math.round(su.posF.x), y: Math.round(su.posF.y) };
            const route = findPath(this.grid, from, pointBelowEntrance(house));
            if (route === null) continue;
            if (route.length < s.len) s = { serf: si, len: route.length };
          }
          serfCache.set(house.uid, s);
        }
        return s;
      };

      // The bid (KM_HandLogistics.pas 551–577, CompareBids 2356–2367): over all valid (offer, demand) pairs the
      // most important demand wins, then the lowest cost; a tie keeps the first pair found (offer order, then demand order).
      let win: { offer: Offer; demand: Demand; house: EconHouse; serf: number; imp: number; cost: number } | null = null;
      for (const offer of offers) {
        if (offer.count <= 0 || !wanted.has(offer.ware)) continue;
        const offerHouse = this.houseByUid(offer.houseUid);
        if (offerHouse === null || offerHouse.destroyed) continue;
        const dist = distances(offerHouse);
        const offerIsStore = offerHouse.typeId === HOUSE_TYPE_STORE;
        for (const d of demands) {
          if (d.ware !== offer.ware) continue;
          const imp = d.importance ?? DI_NORM;
          if (win !== null && imp < win.imp) continue;
          if (d.houseUid === offer.houseUid && d.unitUid === 0) continue; // no same-house deliveries
          if (this.demandAvailable(d) <= 0) continue;
          const serf = nearestSerf(offerHouse);
          if (serf.serf < 0) continue; // no idle serf can walk to the offer (AnySerfCanDoDelivery, KM_HandLogistics.pas 565)
          let cost: number;
          if (d.unitUid !== 0) {
            // A unit demand uses the walk route (KM_HandLogistics.pas 1223–1226): its step count is the cost.
            const target = this.unitByUid(d.unitUid);
            if (target === null || target.dead) continue;
            const tp = this.roundPos(target);
            if (!this.routeCanBeMade(pointBelowEntrance(offerHouse), tp)) continue; // tpWalk route
            const walk = findPath(this.grid, pointBelowEntrance(offerHouse), tp);
            if (walk === null) continue;
            cost = walk.length + this.drawN(10); // KaMRandom(10) (KM_HandLogistics.pas 1585)
          } else {
            const dHouse = this.houseByUid(d.houseUid);
            if (dHouse === null || dHouse.destroyed) continue;
            // No store→store (v0) — except into a WIP store (KM_HandLogistics.pas 1267–1270: a store
            // that is still being built accepts building materials from another store).
            if (offerIsStore && dHouse.typeId === HOUSE_TYPE_STORE && dHouse.buildState === 'done') continue;
            const target = pointBelowEntrance(dHouse);
            const road = dist[this.index(target.x, target.y)];
            if (road < 0) continue; // no road route
            cost = road + this.drawN(16 - 3 * wareDistribution(d.ware, dHouse.typeId)); // KaMRandom(16 - 3*distr) (KM_HandLogistics.pas 1554)
            if (dHouse.buildState !== 'done') {
              // Give priority to almost built houses, stone a little more (KM_HandLogistics.pas 1576–1579).
              cost -= 4 * C.buildResDeliveredPercent(dHouse);
              if (d.ware === WT_STONE) cost += 0.1;
            } else {
              cost += this.drawN(10); // KaMRandom(10) (KM_HandLogistics.pas 1585)
            }
            // Prefer houses with fewer supplies, except store, barracks and town hall (KM_HandLogistics.pas 1614–1618).
            if (dHouse.typeId !== HOUSE_TYPE_STORE && dHouse.typeId !== HOUSE_TYPE_BARRACKS && dHouse.typeId !== HOUSE_TYPE_TOWN_HALL) {
              cost += 20 * this.wareInCount(dHouse, d.ware);
            }
            // Always prefer House>House to House>Store (KM_HandLogistics.pas 1587–1590: the wtAll bid gets +1000).
            if (dHouse.typeId === HOUSE_TYPE_STORE) cost += STORE_BID_PENALTY;
            // Barracks: no weapons from a store while it holds more than 50 of that ware (KM_HandLogistics.pas 1633–1637).
            if (dHouse.typeId === HOUSE_TYPE_BARRACKS && offerIsStore && this.wareInCount(dHouse, d.ware) > 50) cost += 10000;
          }
          // Prefer taking wares from a house rather than a store, except warfare (KM_HandLogistics.pas 1587–1590).
          if (offerIsStore && (d.ware < WARFARE_MIN || d.ware > WARFARE_MAX)) cost += STORE_BID_PENALTY;
          if (win !== null && imp === win.imp && cost >= win.cost) continue;
          win = { offer, demand: d, house: offerHouse, serf: serf.serf, imp, cost };
        }
      }
      if (win === null) break;

      // Assign (TKMDeliveries.AssignDelivery 2151–2194).
      const offer = win.offer;
      const bestDemand = win.demand;
      const offerHouse = win.house;
      const bestSerf = win.serf;
      offer.count -= 1;
      bestDemand.being += 1;
      const su = this.units[bestSerf];
      const sst = this.unitStates[bestSerf];
      const targetHouse = bestDemand.unitUid !== 0 ? null : this.houseByUid(bestDemand.houseUid);
      const deliverKind: 'house' | 'construction' | 'unit' =
        bestDemand.unitUid !== 0
          ? 'unit'
          : targetHouse !== null && targetHouse.buildState !== 'done'
            ? 'construction'
            : 'house';
      sst.task = {
        kind: 'deliver',
        phase: 0,
        fromUid: offer.houseUid,
        toUid: bestDemand.unitUid !== 0 ? 0 : bestDemand.houseUid,
        toUnitUid: bestDemand.unitUid,
        ware: offer.ware,
        demand: bestDemand,
        taken: false,
        // fDeliverKind is decided when the task is created (KM_UnitTaskDelivery.pas 81–86, 105).
        deliverKind,
      };
      sst.walk = null;
      sst.actionLock = 0;
      sst.locked = false;
      su.action = 'stay';
      su.taskKind = 'deliver';
      this.emit(
        'delivery-assigned',
        `ware=${offer.ware} house#${offerHouse.uid}->${bestDemand.unitUid !== 0 ? `unit#${bestDemand.unitUid}` : `house#${targetHouse !== null ? targetHouse.uid : 0}`}`,
      );
      const at = idle.indexOf(bestSerf);
      if (at >= 0) idle.splice(at, 1);
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
    // Flag point default (KM_Houses.pas 2554); the AI's chop-only woodcutters set it explicitly.
    const center = home.flagPoint ?? pointBelowEntrance(home);
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

  // -------------------------------------------------------------------------------------------
  // M5c stone plan (KM_Terrain.pas 2584–2628: FindStoneLocs + FindStone)

  /** FindStone (KM_Terrain.pas 2613–2628): the spot is picked uniformly, GetRandom = KaMRandom(Count) (one draw). */
  private chooseStonePlan(home: EconHouse, st: UnitState): StonePlan | null {
    const center = pointBelowEntrance(home);
    const radius = st.spec.miningRange ?? 0;
    const stoneList = this.findStoneLocs(center, radius);
    if (stoneList.length === 0) return null;
    return stoneList[this.drawN(stoneList.length)];
  }

  /** FindStoneLocs (KM_Terrain.pas 2584–2608): walkable tiles whose north neighbor has stone,
   * not tile-locked, with a route from the center (tpWalk). Returns the walkable tile below the
   * deposit; the stonemason faces dirN (north) to the stone at loc.y − 1. */
  private findStoneLocs(center: Pt, radius: number): StonePlan[] {
    const out: StonePlan[] = [];
    const tiles = this.tilesWithinDistance(center, radius);
    for (const t of tiles) {
      if (t.y < 2) continue; // Can't mine stone from top row (TileIsStone would read y-1=0)
      if (!this.tileHasStone(t.x, t.y - 1)) continue;
      if (this.tileLock[this.index(t.x, t.y)] !== TL_NONE) continue; // TileIsLocked
      if (!this.routeCanBeMade(center, t)) continue;
      out.push({ loc: t });
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

  // =============================================================================================
  // M5a construction slice (docs/M5-SPIKE.md §1a/§2): the world side of packages/sim/construction.ts

  // ---- ConstructionQueries (construction.ts) --------------------------------------------------

  constructionState(hand: number): ConstructionState {
    const state = this.constructions[hand];
    if (state === undefined) throw new Error(`constructionState: no hand ${hand} (handCount ${this.handCount})`);
    return state;
  }

  houseSpecOf(typeId: number): HouseSpec | undefined {
    return this.houseSpecs[typeId];
  }

  /** TileInMapCoords(x, y, inset) (KM_Terrain.pas 1130–1134). */
  tileInMapCoordsInset(x: number, y: number, inset: number): boolean {
    return x >= 1 + inset && x <= this.map.mapX - 1 - inset && y >= 1 + inset && y <= this.map.mapY - 1 - inset;
  }

  /** TileIsCornField. */
  tileHasCornField(x: number, y: number): boolean {
    if (!this.inMapCoords(x, y)) return false;
    return this.fieldOverlay[this.index(x, y)] === FIELD_CORN;
  }

  /** TileIsWineField (no wine fields are built in v0; the overlay stays empty). */
  tileHasWineField(x: number, y: number): boolean {
    if (!this.inMapCoords(x, y)) return false;
    return this.fieldOverlay[this.index(x, y)] === FIELD_WINE;
  }

  /** TileHasRoad. */
  tileHasRoad(x: number, y: number): boolean {
    return this.isRoadTile(x, y);
  }

  /** tpMakeRoads at a tile (KM_Terrain.pas 3808–3813) — the CanAddField(ftRoad) check. */
  tileMakeRoads(x: number, y: number): boolean {
    if (!this.inMapCoords(x, y)) return false;
    const at = this.index(x, y);
    const flags = this.grid.tiles[this.terrainId(x, y)];
    if (flags === undefined || !flags.roadable) return false;
    if (this.grid.elems[this.grid.obj[at]].allBlocked) return false;
    if (this.tileLock[at] !== TL_NONE) return false;
    if (this.roadOverlay[at] === 1) return false;
    return checkHeightPass(this.grid, x, y);
  }

  /** TileGoodForField (KM_Terrain.pas 1275–1284). */
  tileGoodForField(x: number, y: number): boolean {
    if (!this.inMapCoords(x, y)) return false;
    const at = this.index(x, y);
    const flags = this.grid.tiles[this.terrainId(x, y)];
    if (flags === undefined || flags.soil !== true) return false;
    if (this.grid.elems[this.grid.obj[at]].allBlocked) return false;
    if (this.tileLock[at] !== TL_NONE) return false;
    if (this.roadOverlay[at] === 1) return false; // ROAD_LIKE_OVERLAYS
    if (this.fieldOverlay[at] !== FIELD_NONE) return false;
    return checkHeightPass(this.grid, x, y);
  }

  /** tpBuild at a tile (KM_Terrain.pas 3792–3806). */
  tileBuildable(x: number, y: number): boolean {
    if (!this.tileInMapCoordsInset(x, y, 1)) return false;
    const at = this.index(x, y);
    const flags = this.grid.tiles[this.terrainId(x, y)];
    if (flags === undefined || !flags.roadable) return false;
    if (this.tileHasCornField(x, y) || this.tileHasWineField(x, y)) return false;
    if (this.tileLock[at] !== TL_NONE) return false;
    if (!checkHeightPass(this.grid, x, y, 18)) return false; // hpBuilding (KM_Terrain.pas 4916)
    // hasHousesNearTile (3785–3790): no house lock anywhere in the 3×3.
    for (let i = -1; i <= 1; i++) {
      for (let k = -1; k <= 1; k++) {
        if (!this.inMapCoords(x + k, y + i)) continue;
        const lock = this.tileLock[this.index(x + k, y + i)];
        if (lock === TL_FENCED || lock === TL_DIGGED || lock === TL_HOUSE) return false;
      }
    }
    // Only OBJ_NONE or removable objects (3804–3806).
    const obj = this.grid.obj[at];
    if (obj !== OBJ_NONE && !this.grid.elems[obj].canBeRemoved) return false;
    return true;
  }

  /** RouteCanBeMade(a, b, tpWalk) — TKMUnit.CanWalkTo(aTo, 0). */
  canWalkTo(fromX: number, fromY: number, toX: number, toY: number): boolean {
    return this.routeCanBeMade({ x: fromX, y: fromY }, { x: toX, y: toY });
  }

  private terrainId(x: number, y: number): number {
    return this.map.tiles[((y - 1) * this.map.mapX + (x - 1)) * 4];
  }

  // ---- the frozen M5b plan API (docs/M5-SPIKE.md §3) ------------------------------------------

  /** A fresh uid from the tracker (gUIDTracker.GetNewUID). */
  nextUid(): number {
    return this.uidCounter++;
  }

  /** CanAddHousePlan (KM_Hand.pas:1081–1115); (x, y) is the entrance. */
  canAddHousePlan(hand: number, typeId: number, x: number, y: number): boolean {
    return C.canAddHousePlan(this, hand, typeId, x, y);
  }

  /** AddHousePlan (KM_Hand.pas:1294–1307); (x, y) is the entrance, the stored Loc is shifted. */
  addHousePlan(hand: number, typeId: number, x: number, y: number): HousePlan {
    return C.addHousePlan(this, hand, typeId, x, y, this.uidCounter++);
  }

  /** RemHousePlan (KM_Hand.pas:1338–1350) + RemPlan (KM_HandConstructions.pas:827–843). */
  remHousePlan(hand: number, x: number, y: number): HousePlan | null {
    const plan = C.tryGetPlan(this, hand, x, y);
    if (plan === null) return null;
    this.cancelPlanTask(hand, plan); // Worker.CancelTask runs first (:838–839)
    C.closePlan(plan);
    return plan;
  }

  /** HasHousePlan (KM_Hand.pas:1310–1313). */
  hasHousePlan(hand: number, x: number, y: number): boolean {
    return C.tryGetPlan(this, hand, x, y) !== null;
  }

  /** CanAddFieldPlan (KM_Hand.pas:1052–1058). */
  canAddFieldPlan(hand: number, x: number, y: number, fieldType: FieldType): boolean {
    return C.canAddFieldPlan(this, hand, x, y, fieldType);
  }

  /** AddField (KM_HandConstructions.pas:515–537); the caller checks canAddFieldPlan. */
  addFieldPlan(hand: number, x: number, y: number, fieldType: FieldType): FieldPlan {
    return C.addFieldPlan(this, hand, x, y, fieldType);
  }

  /** RemFieldPlan (:562–575) + KM_Hand.RemFieldPlan (:1354–1373). */
  remFieldPlan(hand: number, x: number, y: number): FieldPlan | null {
    const state = this.constructionState(hand);
    for (const f of state.fields) {
      if (f.status === 'empty' || f.x !== x || f.y !== y) continue;
      this.cancelFieldTask(hand, f);
      C.closeField(f);
      return f;
    }
    return null;
  }

  /** HasField (KM_HandConstructions.pas:579–591). */
  hasFieldPlan(hand: number, x: number, y: number): FieldType {
    return C.hasFieldPlan(this, hand, x, y);
  }

  /** FieldCount (:460–468). */
  fieldPlanCount(hand: number, fieldType: FieldType): number {
    return C.fieldCount(this.constructionState(hand), fieldType);
  }

  /** GetPlansWoodDemands (:1432–1440) — what the AI reads. */
  plansWoodDemands(hand: number): number {
    return C.plansWoodDemands(this.constructionState(hand));
  }

  /** GetPlansStoneDemands (:1421–1429). */
  plansStoneDemands(hand: number): number {
    return C.plansStoneDemands(this.constructionState(hand));
  }

  /** HouseCanBuild (KM_HandLocks.pas:87–95), the hlDefault case (v0 has no mission locks). */
  houseCanBuild(hand: number, typeId: number): boolean {
    return C.houseCanBuild(this.constructionState(hand).locks, typeId);
  }

  /**
   * Locks.HouseCreated (KM_HandLocks.pas:80–83): unlock every house released by a type. The
   * world's own `activate` calls it for built houses; the AI also needs it for the houses it
   * places directly (PlaceFirstStorehouse) and for mission houses (KM_Houses.pas 562–566 runs
   * Activate(False) for hbsDone houses — the v0 mission-house path skips that, so the AI scenario
   * applies it explicitly; see packages/sim/ai.ts applyMissionHouseUnlocks).
   */
  houseCreatedFor(hand: number, typeId: number): void {
    C.houseCreated(this.constructionState(hand).locks, typeId);
  }

  /** The ready-to-build site slot of a house, or null (TKMHouseList lookup by house). */
  siteOf(houseUid: number): BuildSite | null {
    const h = this.houseByUid(houseUid);
    if (h === null) return null;
    return C.siteOf(this.constructionState(h.owner), houseUid);
  }

  // ---- build-state readers (KM_Houses.pas) ----------------------------------------------------

  houseIsComplete(h: EconHouse): boolean {
    return C.isComplete(h);
  }

  houseIsStone(h: EconHouse): boolean {
    return C.isStone(h);
  }

  houseCheckResToBuild(h: EconHouse): boolean {
    return C.checkResToBuild(h);
  }

  houseBuildWoodDelivered(h: EconHouse): number {
    return C.buildWoodDelivered(h);
  }

  houseBuildStoneDelivered(h: EconHouse): number {
    return C.buildStoneDelivered(h);
  }

  houseBuildResourceDelivered(h: EconHouse): number {
    return C.buildResourceDelivered(h);
  }

  // ---- WIP houses + terrain (KM_Houses.pas / KM_Terrain.pas) ----------------------------------

  /** TKMHand.AddHouseWIP (KM_HouseCollection.pas:144–147): a hbsNoGlyph house on fenced tiles. */
  private addHouseWIP(typeId: number, locX: number, locY: number, owner: number): EconHouse {
    const spec = this.houseSpecs[typeId];
    const entrance = { x: locX + (spec !== undefined ? spec.entranceDx : 0), y: locY };
    const house: EconHouse = {
      uid: this.uidCounter++,
      typeId,
      owner,
      x: locX,
      y: locY,
      entrance,
      state: 'empty',
      wareIn: [0, 0, 0, 0],
      wareOut: [0, 0, 0, 0],
      workerUid: 0,
      animStep: 0,
      workAnimStep: 0,
      maxHealth: spec !== undefined ? spec.maxHealth : 0,
      damage: 0,
      destroyed: false,
      fireLevel: 0,
      buildState: 'noGlyph',
      buildingProgress: 0,
      buildSupplyWood: 0,
      buildSupplyStone: 0,
      buildReserve: 0,
      readyToBeBuilt: false,
      woodCost: spec !== undefined ? spec.woodCost : 0,
      stoneCost: spec !== undefined ? spec.stoneCost : 0,
      flagPoint: null,
    };
    this.houses.push(house);
    this.houseStateMap.set(house.uid, createHouseState(typeId, spec));
    this.setHouseTerrain(house, 'fence'); // KM_Houses.pas 569 (hbsNoGlyph → hsFence)
    this.emit('house-wip', `house#${house.uid} type=${typeId} (${locX},${locY})`);
    return house;
  }

  /**
   * SetHouse (KM_Terrain.pas 4611–4676) for the M5a stages: 'fence' (a WIP house, tlFenced),
   * 'built' (tlHouse + the door cell becomes road, 4642–4648) and 'none' (demolish).
   */
  private setHouseTerrain(h: EconHouse, stage: 'fence' | 'built' | 'none'): void {
    const plan = housePlan(h.typeId);
    for (let i = 1; i <= 4; i++) {
      for (let k = 1; k <= 4; k++) {
        if (plan[i - 1][k - 1] === 0) continue;
        const tx = h.x + k - 3;
        const ty = h.y + i - 4;
        if (!this.inMapCoords(tx, ty)) continue;
        const at = this.index(tx, ty);
        if (stage === 'none') {
          this.tileLock[at] = TL_NONE;
          this.houseTile[at] = 0;
        } else {
          this.tileLock[at] = stage === 'fence' ? TL_FENCED : TL_HOUSE;
          this.houseTile[at] = h.uid;
          if (stage === 'built' && plan[i - 1][k - 1] === 2 && this.roadOverlay[at] === 0) {
            this.roadOverlay[at] = 1; // the door cell (4647–4648)
            this.roadTileCount += 1;
          }
        }
        this.recomputeWalkTile(tx, ty);
      }
    }
    this.walkConnectDirty = true;
  }

  /** SetHouse(hsBuilt, flatten) (KM_Houses.pas 877–878): flatten + clear objects, then tlHouse. */
  private setHouseBuilt(h: EconHouse): void {
    for (const c of this.houseCells(h)) {
      this.flattenTerrain(c.x, c.y);
      this.removeObject(c.x, c.y);
    }
    this.setHouseTerrain(h, 'built');
    this.emit('house-terrain-built', `house#${h.uid}`);
  }

  /**
   * FlattenTerrain (KM_Terrain.pas 4355–4468), simplified (documented deviation): each of the
   * tile's 4 corner heights is mixed halfway toward the tile's corner average (Mix(avg, h, 0.5),
   * 4435–4454), then the 3×3 passability is recomputed (4464).
   */
  private flattenTerrain(x: number, y: number): void {
    if (!this.inMapCoords(x, y)) return;
    const x2 = Math.min(x + 1, this.map.mapX);
    const y2 = Math.min(y + 1, this.map.mapY);
    const p = [this.height(x, y), this.height(x2, y), this.height(x, y2), this.height(x2, y2)];
    const avg = Math.round((p[0] + p[1] + p[2] + p[3]) / 4);
    this.setHeight(x, y, Math.round(0.5 * (p[0] + avg)));
    this.setHeight(x2, y, Math.round(0.5 * (p[1] + avg)));
    this.setHeight(x, y2, Math.round(0.5 * (p[2] + avg)));
    this.setHeight(x2, y2, Math.round(0.5 * (p[3] + avg)));
    this.recomputeWalkAround(x, y);
  }

  private height(x: number, y: number): number {
    return this.grid.height[this.index(x, y)];
  }

  private setHeight(x: number, y: number, h: number): void {
    if (x < 0 || x > this.map.mapX || y < 0 || y > this.map.mapY) return;
    this.grid.height[this.index(x, y)] = clamp(h, 0, 255);
  }

  /** RemoveObject (KM_Terrain.pas 3295–3306). */
  private removeObject(x: number, y: number): void {
    if (!this.inMapCoords(x, y)) return;
    const at = this.index(x, y);
    if (this.grid.obj[at] === OBJ_NONE) return;
    const blockedDiagonal = this.grid.elems[this.grid.obj[at]].diagonalBlocked;
    this.grid.obj[at] = OBJ_NONE;
    this.treeAge[at] = 0;
    if (blockedDiagonal) this.walkConnectDirty = true;
  }

  /** SetRoad (KM_Terrain.pas 2410–2419): the toRoad overlay + the road grid. */
  private setRoad(x: number, y: number, _owner: number): void {
    if (!this.inMapCoords(x, y)) return;
    const at = this.index(x, y);
    if (this.roadOverlay[at] === 0) this.roadTileCount += 1;
    this.roadOverlay[at] = 1;
    // SetRoads removes wine/corn objects (KM_Terrain.pas 2220–2227).
    if (this.grid.elems[this.grid.obj[at]].wineOrCorn) {
      this.grid.obj[at] = OBJ_NONE;
      this.treeAge[at] = 0;
    }
    this.recomputeWalkAround(x, y);
    this.emit('road-built', `(${x},${y})`);
  }

  /** SetField(aLoc, Owner, ftCorn) (KM_Terrain.pas 3377–3447): the corn overlay. */
  private setFieldCorn(x: number, y: number, _owner: number): void {
    if (!this.inMapCoords(x, y)) return;
    const at = this.index(x, y);
    this.fieldOverlay[at] = FIELD_CORN;
    this.recomputeWalkAround(x, y);
    this.emit('field-built', `corn (${x},${y})`);
  }

  /** WareAddToBuild (KM_Houses.pas 1805–1817): timber/stone only, clamped to the costs. */
  wareAddToBuild(h: EconHouse, ware: number): void {
    if (h.destroyed) return;
    if (h.buildingProgress > 0 || h.buildSupplyWood > 0 || h.buildSupplyStone > 0) h.readyToBeBuilt = true;
    if (ware === WT_TIMBER) h.buildSupplyWood = clamp(h.buildSupplyWood + 1, 0, h.woodCost);
    else if (ware === WT_STONE) h.buildSupplyStone = clamp(h.buildSupplyStone + 1, 0, h.stoneCost);
    else throw new Error(`wareAddToBuild: a WIP house is not supposed to receive ware ${ware}`);
    this.emit('build-supply', `house#${h.uid} wood=${h.buildSupplyWood} stone=${h.buildSupplyStone}`);
  }

  /** IncBuildingProgress (KM_Houses.pas 1234–1271): +5 per hit, +50 reserve per ware unit. */
  private incBuildingProgress(h: EconHouse): void {
    if (C.isComplete(h)) return;
    h.readyToBeBuilt = true; // SetIsReadyToBeBuilt(True) (1238)
    if (h.buildState === 'wood' && h.buildReserve === 0) {
      h.buildSupplyWood -= 1;
      h.buildReserve += 50;
    }
    if (h.buildState === 'stone' && h.buildReserve === 0) {
      h.buildSupplyStone -= 1;
      h.buildReserve += 50;
    }
    h.buildingProgress += 5; // (1251)
    h.buildReserve -= 5; // (1252)
    if (h.buildState === 'wood' && h.buildingProgress === h.woodCost * 50) h.buildState = 'stone'; // (1254–1256)
    if (h.buildState === 'stone' && h.buildingProgress - h.woodCost * 50 === h.stoneCost * 50) {
      // (1258–1269): hbsDone + Activate(True).
      h.buildState = 'done';
      h.readyToBeBuilt = false;
      this.activate(h, true);
    }
  }

  /**
   * Activate (KM_Houses.pas 669–717): the lock release chain, the FOW reveal by BuildArea with the
   * house Sight, the entrance diagonal object fix and AddDemandsOnActivate.
   */
  private activate(h: EconHouse, wasBuilt: boolean): void {
    C.houseCreated(this.constructionState(h.owner).locks, h.typeId); // (684)
    const spec = this.houseSpecs[h.typeId];
    const fog = this.fow[h.owner];
    if (fog !== undefined) {
      for (const c of this.houseCells(h)) fog.reveal(c.x, c.y, spec !== undefined ? spec.sight ?? 0 : 0, true); // (689–694)
    }
    // CurrentAction := flag sub-actions (697–698) — a viewer concern (worker L).
    this.addDemandsOnActivate(h); // (701)
    if (wasBuilt) this.clearEntranceDiagonalObjects(h); // (703–716)
    this.emit('house-activated', `house#${h.uid} type=${h.typeId} wasBuilt=${wasBuilt}`);
  }

  /** AddDemandsOnActivate (KM_Houses.pas 649–666): every real WareInput slot gets a demand. */
  private addDemandsOnActivate(h: EconHouse): void {
    const spec = this.houseSpecs[h.typeId];
    if (spec === undefined) return;
    for (let slot = 0; slot < 4; slot++) {
      if (spec.resIn[slot] < 0) continue;
      this.demands[h.owner].push({
        houseUid: h.uid,
        unitUid: 0,
        ware: spec.resIn[slot],
        slot,
        script: false,
        count: 0,
        being: 0,
        construction: false,
        importance: houseDemandImportance(h.typeId, spec.resIn[slot]),
      });
    }
    if (h.typeId === HOUSE_TYPE_BARRACKS) this.addBarracksDemands(h);
    if (h.typeId === HOUSE_TYPE_STORE) this.addStoreDemands(h);
  }

  /** The Activate diagonal fix (703–716): clear non-tree objects blocking the entrance diagonals. */
  private clearEntranceDiagonalObjects(h: EconHouse): void {
    const p1 = { x: h.entrance.x - 1, y: h.entrance.y + 1 };
    const p2 = { x: p1.x + 2, y: p1.y };
    if (
      !this.canWalkDiagonal(h.entrance.x, h.entrance.y, p1.x, p1.y) &&
      this.objectShouldBeCleared(p1.x + 1, p1.y)
    ) {
      this.removeObject(p1.x + 1, p1.y);
    }
    if (!this.canWalkDiagonal(h.entrance.x, h.entrance.y, p2.x, p2.y) && this.objectShouldBeCleared(p2.x, p2.y)) {
      this.removeObject(p2.x, p2.y);
    }
  }

  private objectShouldBeCleared(x: number, y: number): boolean {
    if (!this.inMapCoords(x, y)) return false;
    const obj = this.grid.obj[this.index(x, y)];
    if (isChopableObj(obj)) return false; // do not clear choppable trees (KM_Houses.pas 673–676)
    if (this.grid.elems[obj].wineOrCorn) return false;
    return true;
  }

  /** TKMHand.UnitsHitTest (KM_Hand.pas 364–373): the builder hitting the house from the entrance. */
  private builderHittingAt(x: number, y: number, owner: number): EconUnit | null {
    const u = this.unitAtTile(x, y);
    if (u === null || u.dead || u.owner !== owner || u.type !== UNIT_BUILDER) return null;
    const st = this.unitStateMap.get(u);
    if (st === undefined || st.task === null || st.task.kind !== 'buildHouse') return null;
    if (st.task.phase < 1) return null; // (Worker.Task.Phase >= 1, KM_UnitTaskDelivery.pas 465)
    return u;
  }

  // ---- the staggered construction pass (KM_HandConstructions.pas 1389–1418) -------------------

  /**
   * TKMHandConstructions.UpdateState: HouseList.UpdateState + RemoveExtraWorkers, then
   * AssignHousePlans → AssignFieldworks → AssignHouses (repairs are out of v0, spec §1a).
   */
  private constructionsPass(hand: number): void {
    const state = this.constructionState(hand);
    C.removeExtraSites(state, (uid) => {
      const h = this.houseByUid(uid);
      return h === null || h.destroyed || C.isComplete(h);
    });
    C.removeExtraWorkers(state, (uid) => {
      const u = this.unitByUid(uid);
      return u === null || u.dead;
    });
    this.assignHousePlans(hand, state);
    this.assignFieldworks(hand, state);
    this.assignHouses(hand, state);
  }

  private roundPos(u: EconUnit): Pt {
    return { x: Math.round(u.posF.x), y: Math.round(u.posF.y) };
  }

  /** IsIdle (KM_Units.pas 2428–2431): no task and an unlocked stay action. */
  private isIdleBuilder(uid: number): boolean {
    const u = this.unitByUid(uid);
    if (u === null || u.dead) return false;
    const st = this.unitStateMap.get(u);
    if (st === undefined) return false;
    return st.task === null && st.walk === null && !st.locked;
  }

  private idleBuilderCount(hand: number): number {
    let n = 0;
    for (const uid of this.constructionState(hand).workers) if (this.isIdleBuilder(uid)) n += 1;
    return n;
  }

  /** GetBestWorker (:1253–1270): the nearest idle builder that can walk to the point. */
  private getBestWorker(hand: number, x: number, y: number): EconUnit | null {
    let best: EconUnit | null = null;
    let bestBid = Number.POSITIVE_INFINITY;
    for (const uid of this.constructionState(hand).workers) {
      if (!this.isIdleBuilder(uid)) continue;
      const u = this.unitByUid(uid);
      if (u === null) continue;
      const from = this.roundPos(u);
      if (!this.canWalkTo(from.x, from.y, x, y)) continue;
      const bid = C.diagDistance(from.x, from.y, x, y);
      if (bid < bestBid) {
        bestBid = bid;
        best = u;
      }
    }
    return best;
  }

  /** AssignHousePlans (:1301–1326). */
  private assignHousePlans(hand: number, state: ConstructionState): void {
    if (this.idleBuilderCount(hand) === 0) return;
    const jobs = C.openPlanCount(state);
    if (jobs === 0) return;
    if (jobs > this.idleBuilderCount(hand)) {
      for (const uid of state.workers.slice()) {
        if (!this.isIdleBuilder(uid)) continue;
        const u = this.unitByUid(uid);
        if (u === null) continue;
        const from = this.roundPos(u);
        const plan = C.bestBidPlan(this, hand, from.x, from.y);
        if (plan !== null) this.givePlanTask(u, plan);
      }
    } else {
      for (const plan of state.plans) {
        if (plan.status !== 'open') continue;
        const worker = this.getBestWorker(hand, plan.x, plan.y);
        if (worker !== null) this.givePlanTask(worker, plan);
      }
    }
  }

  /** AssignFieldworks (:1273–1298). Wine field plans are not assigned (out of v0, spec §1a). */
  private assignFieldworks(hand: number, state: ConstructionState): void {
    if (this.idleBuilderCount(hand) === 0) return;
    const jobs = state.fields.filter((f) => f.status === 'open' && this.fieldHasTask(f)).length;
    if (jobs === 0) return;
    if (jobs > this.idleBuilderCount(hand)) {
      for (const uid of state.workers.slice()) {
        if (!this.isIdleBuilder(uid)) continue;
        const u = this.unitByUid(uid);
        if (u === null) continue;
        const from = this.roundPos(u);
        const field = this.bestBidField(hand, from.x, from.y);
        if (field !== null) this.giveFieldTask(u, field);
      }
    } else {
      for (const field of state.fields) {
        if (field.status !== 'open' || !this.fieldHasTask(field)) continue;
        const worker = this.getBestWorker(hand, field.x, field.y);
        if (worker !== null) this.giveFieldTask(worker, field);
      }
    }
  }

  /** v0: only road and corn field plans get a builder task (TKMTaskBuildWine is out, spec §1a). */
  private fieldHasTask(field: FieldPlan): boolean {
    return field.fieldType === 'road' || field.fieldType === 'corn';
  }

  /** TKMFieldworksList.BestBid (:389–407) restricted to the v0 field types. */
  private bestBidField(hand: number, workerX: number, workerY: number): FieldPlan | null {
    const state = this.constructionState(hand);
    let best: FieldPlan | null = null;
    let bestBid = Number.POSITIVE_INFINITY;
    for (const f of state.fields) {
      if (f.status !== 'open' || !this.fieldHasTask(f)) continue;
      if (!this.canWalkTo(workerX, workerY, f.x, f.y)) continue;
      const bid = C.diagDistance(workerX, workerY, f.x, f.y);
      if (bid < bestBid) {
        bestBid = bid;
        best = f;
      }
    }
    return best;
  }

  /** AssignHouses (:1329–1355). */
  private assignHouses(hand: number, state: ConstructionState): void {
    if (this.idleBuilderCount(hand) === 0) return;
    const canBuild = (uid: number): boolean => {
      const h = this.houseByUid(uid);
      return h !== null && !h.destroyed && C.checkResToBuild(h);
    };
    const jobs = C.siteJobCount(state, canBuild);
    if (jobs === 0) return;
    if (jobs > this.idleBuilderCount(hand)) {
      for (const uid of state.workers.slice()) {
        if (!this.isIdleBuilder(uid)) continue;
        const u = this.unitByUid(uid);
        if (u === null) continue;
        const from = this.roundPos(u);
        const site = C.bestBidSite(this, hand, from.x, from.y, (houseUid) => {
          const h = this.houseByUid(houseUid);
          if (h === null || h.destroyed) return null;
          return {
            typeId: h.typeId,
            x: h.x,
            y: h.y,
            entranceX: h.entrance.x,
            entranceY: h.entrance.y,
            checkRes: C.checkResToBuild(h),
          };
        });
        if (site === null) continue;
        const house = this.houseByUid(site.houseUid);
        if (house !== null) this.giveHouseTask(u, site, house);
      }
    } else {
      for (const site of state.sites) {
        if (site.houseUid === 0) continue;
        const h = this.houseByUid(site.houseUid);
        if (h === null || h.destroyed || !C.checkResToBuild(h)) continue;
        if (site.assigned >= C.maxWorkersForHouse(h.typeId)) continue;
        const worker = this.getBestWorker(hand, h.entrance.x, h.entrance.y + 1);
        if (worker !== null) this.giveHouseTask(worker, site, h);
      }
    }
  }

  /** The fCellsToDig list (:571–581): BuildArea nonzero cells, left→right, top→bottom. */
  private houseAreaCells(typeId: number, locX: number, locY: number): Pt[] {
    const out: Pt[] = [];
    const area = housePlan(typeId);
    for (let i = 1; i <= 4; i++) {
      for (let k = 1; k <= 4; k++) {
        if (area[i - 1][k - 1] === 0) continue;
        out.push({ x: locX + k - 3, y: locY + i - 4 });
      }
    }
    return out;
  }

  /** GetListOfCellsAround (KM_Houses.pas 1076–1106) with the builder's tpWalk passability. */
  private houseCellsAround(h: EconHouse): { x: number; y: number; dir: number }[] {
    const out: { x: number; y: number; dir: number }[] = [];
    const area = housePlan(h.typeId);
    const add = (x: number, y: number, dir: number): void => {
      if (this.tileWalkable(x, y)) out.push({ x, y, dir }); // CheckPassability(cell, tpWalk)
    };
    for (let i = 1; i <= 4; i++) {
      for (let k = 1; k <= 4; k++) {
        if (area[i - 1][k - 1] === 0) continue;
        if (i === 1 || area[i - 2][k - 1] === 0) add(h.x + k - 3, h.y + i - 4 - 1, 5); // Above → dirS
        if (i === 4 || area[i][k - 1] === 0) add(h.x + k - 3, h.y + i - 4 + 1, 1); // Below → dirN
        if (k === 4 || area[i - 1][k] === 0) add(h.x + k - 3 + 1, h.y + i - 4, 7); // FromRight → dirW
        if (k === 1 || area[i - 1][k - 2] === 0) add(h.x + k - 3 - 1, h.y + i - 4, 3); // FromLeft → dirE
      }
    }
    return out;
  }

  /** GiveTask (:791–796) → TKMUnitWorker.BuildHouseArea (KM_Units.pas 982–985). */
  private givePlanTask(u: EconUnit, plan: HousePlan): void {
    const st = this.unitStateMap.get(u);
    if (st === undefined) return;
    C.takePlan(plan, u.uid);
    const cells = this.houseAreaCells(plan.typeId, plan.x, plan.y);
    st.task = {
      kind: 'buildHouseArea',
      phase: 0,
      typeId: plan.typeId,
      locX: plan.x,
      locY: plan.y,
      plan,
      houseUid: 0,
      houseNeedsWorker: false,
      houseReadyToBuild: false,
      cells,
      lastToDig: cells.length - 1,
      closed: false,
    };
    this.startBuilderTask(u, st);
    this.emit('build-area-assigned', `unit#${u.uid} plan#${plan.uid} type=${plan.typeId}`);
  }

  /** GiveTask (:471–476) → TKMUnitWorker.BuildField/BuildRoad (KM_Units.pas 970–979). */
  private giveFieldTask(u: EconUnit, field: FieldPlan): void {
    if (field.fieldType !== 'road' && field.fieldType !== 'corn') return; // wine is out of v0
    const st = this.unitStateMap.get(u);
    if (st === undefined) return;
    C.takeField(field, u.uid);
    if (field.fieldType === 'road') {
      st.task = {
        kind: 'buildRoad',
        phase: 0,
        x: field.x,
        y: field.y,
        field,
        demandSet: false,
        tileLockSet: false,
        isDigged: false,
        closed: false,
      };
      this.emit('build-road-assigned', `unit#${u.uid} (${field.x},${field.y})`);
    } else {
      st.task = {
        kind: 'buildField',
        phase: 0,
        phase2: 0,
        x: field.x,
        y: field.y,
        field,
        tileLockSet: false,
        closed: false,
      };
      this.emit('build-field-assigned', `unit#${u.uid} (${field.x},${field.y})`);
    }
    this.startBuilderTask(u, st);
  }

  /** GiveTask (:316–320) → TKMUnitWorker.BuildHouse (KM_Units.pas 964–967). */
  private giveHouseTask(u: EconUnit, site: BuildSite, house: EconHouse): void {
    const st = this.unitStateMap.get(u);
    if (st === undefined) return;
    site.assigned += 1;
    st.task = {
      kind: 'buildHouse',
      phase: 0,
      phase2: 0,
      houseUid: house.uid,
      site,
      buildFrom: null,
      fromDir: 0,
      cells: this.houseCellsAround(house),
      closed: false,
    };
    this.startBuilderTask(u, st);
    this.emit('build-house-assigned', `unit#${u.uid} house#${house.uid}`);
  }

  private startBuilderTask(u: EconUnit, st: UnitState): void {
    st.walk = null;
    st.actionLock = 0;
    st.locked = false;
    u.action = 'stay';
    u.taskKind = st.task !== null ? st.task.kind : 'none';
  }

  /** Worker.CancelTask for a removed plan (:838–839): the task's destructor runs. */
  private cancelPlanTask(hand: number, plan: HousePlan): void {
    void hand;
    if (plan.workerUid === 0) return;
    const u = this.unitByUid(plan.workerUid);
    if (u === null) return;
    const st = this.unitStateMap.get(u);
    if (st === undefined || st.task === null) return;
    if (st.task.kind === 'buildHouseArea' && st.task.plan === plan) {
      const task = st.task;
      st.task = null;
      this.finishTask(u, st, task);
    }
  }

  /** Worker.CancelTask for a removed field (:570–571). */
  private cancelFieldTask(hand: number, field: FieldPlan): void {
    void hand;
    if (field.workerUid === 0) return;
    const u = this.unitByUid(field.workerUid);
    if (u === null) return;
    const st = this.unitStateMap.get(u);
    if (st === undefined || st.task === null) return;
    const task = st.task;
    if ((task.kind === 'buildRoad' || task.kind === 'buildField') && task.field === field) {
      st.task = null;
      this.finishTask(u, st, task);
    }
  }

  // ---- the four builder tasks (KM_UnitTaskBuild.pas) ------------------------------------------

  /** tpWorker route check (KM_Terrain.pas 3840–3844 + KM_Units.pas 2030–2034). */
  private workerCanWalkTo(from: Pt, to: Pt): boolean {
    return findPath(this.workerGrid, from, to) !== null;
  }

  /** SetActionWalkToSpot with the builder's Digging passability (tpWorker). */
  private walkToWorker(u: EconUnit, st: UnitState, to: Pt): boolean {
    const from = this.roundPos(u);
    const w = startWalk(this.workerGrid, from, to);
    if (w === null) return false;
    st.walk = w;
    u.action = 'walk';
    return true;
  }

  /** TKMTaskBuildHouseArea (:681–765). */
  private runBuildHouseArea(u: EconUnit, st: UnitState, task: Task & { kind: 'buildHouseArea' }): 'continues' | 'done' {
    const state = this.constructionState(u.owner);
    // WalkShouldAbandon (:647–651): while the plan is still open, the terrain must still take it.
    if (task.houseUid === 0 && task.plan.status !== 'empty') {
      const entrance = C.planEntrance(state, task.plan);
      if (!C.canPlaceHouse(this, task.typeId, entrance.x, entrance.y)) return 'done';
    }
    if (task.houseUid !== 0) {
      const h = this.houseByUid(task.houseUid);
      if (h !== null && h.destroyed) return 'done'; // (:692–697)
    }
    const cell = task.cells[task.lastToDig];
    switch (task.phase) {
      case 0: {
        // SetActionWalkToSpot(GetHouseEntranceLoc) (:701–704).
        const entrance = { x: task.locX + C.entranceOffsetX(state, task.typeId), y: task.locY };
        if (!this.walkTo(u, st, entrance)) return 'done';
        task.phase = 1;
        return 'continues';
      }
      case 1: {
        // CancelThePlan + AddHouseWIP + stay 2 (:705–716).
        if (task.plan.status !== 'empty') C.closePlan(task.plan);
        const house = this.addHouseWIP(task.typeId, task.locX, task.locY, u.owner);
        task.houseUid = house.uid;
        task.houseNeedsWorker = true;
        this.setLockedStay(u, st, 2, false);
        task.phase = 2;
        return 'continues';
      }
      case 2: {
        // Walk to the next cell to dig, reversed (:717–725).
        if (cell === undefined) return 'done';
        const from = this.roundPos(u);
        if (!this.workerCanWalkTo(from, cell)) return 'done';
        if (!this.walkToWorker(u, st, cell)) return 'done';
        task.phase = 3;
        return 'continues';
      }
      case 3:
        this.setLockedStay(u, st, 11, true); // (726–729)
        task.phase = 4;
        return 'continues';
      case 4:
        this.setLockedStay(u, st, 11, true); // (729–732)
        if (cell !== undefined) this.flattenTerrain(cell.x, cell.y);
        task.phase = 5;
        return 'continues';
      case 5:
        this.setLockedStay(u, st, 11, true); // (733–736)
        if (cell !== undefined) this.flattenTerrain(cell.x, cell.y);
        task.phase = 6;
        return 'continues';
      case 6: {
        // (737–746): flatten twice, lock tlDigged, entrance road, remove object, next cell.
        this.setLockedStay(u, st, 11, true);
        if (cell !== undefined) {
          this.flattenTerrain(cell.x, cell.y);
          this.flattenTerrain(cell.x, cell.y);
          if (this.inMapCoords(cell.x, cell.y)) {
            this.tileLock[this.index(cell.x, cell.y)] = TL_DIGGED;
            this.recomputeWalkAround(cell.x, cell.y);
          }
          const house = task.houseUid !== 0 ? this.houseByUid(task.houseUid) : null;
          if (house !== null && house.entrance.x === cell.x && house.entrance.y === cell.y) {
            this.setRoad(cell.x, cell.y, u.owner);
          }
          this.removeObject(cell.x, cell.y);
        }
        task.lastToDig -= 1;
        task.phase = 7;
        if (task.lastToDig >= 0) task.phase = 2; // repeat with the next cell (:763–764)
        return 'continues';
      }
      case 7: {
        // Walk away from the site before it becomes stoned (:747–756).
        const house = task.houseUid !== 0 ? this.houseByUid(task.houseUid) : null;
        const out = this.getOutOfTheWay(u, house);
        if (!this.walkToWorker(u, st, out) && !this.walkTo(u, st, out)) st.actionLock = 1;
        task.houseNeedsWorker = false;
        task.houseReadyToBuild = true;
        task.phase = 8;
        return 'continues';
      }
      default:
        return 'done';
    }
  }

  /**
   * GetOutOfTheWay (KM_Terrain.pas 3963–4048) essentials: the weighted-random free neighbour
   * (40·isFree + isPushable + 2·KaMRandom(2)), falling back to PointBelowEntrance (:751–752).
   */
  private getOutOfTheWay(u: EconUnit, house: EconHouse | null): Pt {
    const loc = this.roundPos(u);
    let result = loc;
    let bestWeight = -1e30;
    for (let i = -1; i <= 1; i++) {
      for (let k = -1; k <= 1; k++) {
        if (i === 0 && k === 0) continue;
        const tx = loc.x + k;
        const ty = loc.y + i;
        if (!this.inMapCoords(tx, ty)) continue;
        if (!canWalkDiagonal(this.grid, loc, tx, ty)) continue;
        const at = this.index(tx, ty);
        const lock = this.tileLock[at];
        if (lock !== TL_NONE && lock !== TL_FENCED) continue; // (3999)
        if (this.grid.walk[at] !== 1) continue; // aPass = tpWalk (4000)
        const other = this.unitAtTile(tx, ty);
        const otherSt = other !== null ? this.unitStateMap.get(other) : undefined;
        const isFree = other === null || other === u;
        const isPushable =
          other !== null && other !== u && otherSt !== undefined && other.action === 'stay' && !otherSt.locked;
        const weight = 40 * (isFree ? 1 : 0) + (isPushable ? 1 : 0) + 2 * this.drawN(2); // (4030–4034)
        if (weight > bestWeight) {
          bestWeight = weight;
          result = { x: tx, y: ty };
        }
      }
    }
    if (samePoint(result, loc)) {
      return house !== null ? pointBelowEntrance(house) : loc; // (751–752)
    }
    return result;
  }

  /** TKMTaskBuildHouse (:845–901). */
  private runBuildHouse(u: EconUnit, st: UnitState, task: Task & { kind: 'buildHouse' }): 'continues' | 'done' {
    const house = this.houseByUid(task.houseUid);
    // WalkShouldAbandon (:831–834).
    if (house === null || house.destroyed || !C.checkResToBuild(house) || C.isComplete(house)) return 'done';
    switch (task.phase) {
      case 0: {
        if (!this.pickRandomSpot(u, task, house)) return 'done'; // (:858–864)
        if (task.buildFrom === null) return 'done';
        if (!this.walkTo(u, st, task.buildFrom)) return 'done';
        task.phase = 1;
        return 'continues';
      }
      case 1:
        u.dir = task.fromDir; // (866–870)
        this.setLockedStay(u, st, 0, false);
        task.phase = 2;
        return 'continues';
      case 2: {
        this.setLockedStay(u, st, 5, true); // (871–879)
        u.dir = task.fromDir;
        if (C.isStone(house) && this.tileLock[this.index(house.x, house.y)] !== TL_HOUSE) this.setHouseBuilt(house);
        task.phase = 3;
        return 'continues';
      }
      case 3: {
        this.incBuildingProgress(house); // (880–885)
        this.setLockedStay(u, st, 6, true);
        u.animStep = 5; // SetActionLockedStay(6, uaWork, False, 0, 5)
        task.phase2 += 1;
        task.phase = 4;
        if (!C.isComplete(house)) task.phase = task.phase2 % 5 === 0 ? 0 : 2; // (896–900)
        return 'continues';
      }
      case 4:
        this.setUnlockedStay(u, st, 1); // (886–889)
        task.phase = 5;
        return 'continues';
      default:
        return 'done';
    }
  }

  /** PickRandomSpot (KM_Units.pas 997–1017): one KaMRandom draw over the reachable cells. */
  private pickRandomSpot(u: EconUnit, task: Task & { kind: 'buildHouse' }, house: EconHouse): boolean {
    void house;
    const from = this.roundPos(u);
    const spots: { x: number; y: number; dir: number }[] = [];
    for (const c of task.cells) {
      if (samePoint(c, from)) continue;
      if (!this.canWalkTo(from.x, from.y, c.x, c.y)) continue;
      spots.push(c);
    }
    if (spots.length === 0) return false;
    const pick = spots[this.drawN(spots.length)];
    task.buildFrom = { x: pick.x, y: pick.y };
    task.fromDir = pick.dir;
    return true;
  }

  /** TKMTaskBuildRoad (:218–291). */
  private runBuildRoad(u: EconUnit, st: UnitState, task: Task & { kind: 'buildRoad' }): 'continues' | 'done' {
    const at = this.index(task.x, task.y);
    // WalkShouldAbandon (:204–208): the plan is still open and the tile can no longer take a road.
    if (task.field !== null && task.field.status !== 'empty' && !this.tileMakeRoads(task.x, task.y)) return 'done';
    switch (task.phase) {
      case 0: {
        if (!this.walkTo(u, st, { x: task.x, y: task.y })) return 'done'; // (230–233)
        task.phase = 1;
        return 'continues';
      }
      case 1: {
        this.tileLock[at] = TL_ROAD_WORK; // (234–244)
        this.recomputeWalkAround(task.x, task.y);
        task.tileLockSet = true;
        this.cancelRoadPlan(u, task); // CancelThePlan
        this.addUnitDemand(u.owner, u, WT_STONE, 1); // AddDemand(nil, fUnit, wtStone, 1, dtOnce, diHigh4)
        task.demandSet = true;
        this.setLockedStay(u, st, 11, true);
        task.phase = 2;
        return 'continues';
      }
      case 2: {
        this.incDigState(task.x, task.y); // (246–250)
        this.setLockedStay(u, st, 11, true);
        task.phase = 3;
        return 'continues';
      }
      case 3: {
        this.incDigState(task.x, task.y); // (251–254)
        this.setLockedStay(u, st, 11, true);
        task.phase = 4;
        return 'continues';
      }
      case 4: {
        // (255–264): the stone wait — stay 30, repeat until the serf delivers.
        this.setLockedStay(u, st, 30, false);
        if (!task.isDigged) {
          task.isDigged = true;
          this.emit('road-digged', `(${task.x},${task.y})`);
        }
        return 'continues'; // the phase is not advanced: the serf's delivery moves it to 5
      }
      case 5: {
        this.setLockedStay(u, st, 11, true); // (265–269)
        task.demandSet = false;
        task.phase = 6;
        return 'continues';
      }
      case 6: {
        this.incDigState(task.x, task.y); // (270–273)
        this.setLockedStay(u, st, 11, true);
        task.phase = 7;
        return 'continues';
      }
      case 7: {
        this.incDigState(task.x, task.y); // (274–280)
        this.flattenTerrain(task.x, task.y);
        if (this.grid.elems[this.grid.obj[at]].wineOrCorn) this.removeObject(task.x, task.y);
        this.setLockedStay(u, st, 11, true);
        task.phase = 8;
        return 'continues';
      }
      case 8: {
        // (281–287): SetRoad + RemoveObjectsKilledByRoad + stay 5 + unlock.
        this.setRoad(task.x, task.y, u.owner);
        this.removeObjectsKilledByRoad(task.x, task.y);
        this.setUnlockedStay(u, st, 5);
        this.tileLock[at] = TL_NONE;
        this.recomputeWalkAround(task.x, task.y);
        task.tileLockSet = false;
        task.phase = 9;
        return 'continues';
      }
      default:
        return 'done';
    }
  }

  /** TKMTaskBuildField (:503–543). */
  private runBuildField(u: EconUnit, st: UnitState, task: Task & { kind: 'buildField' }): 'continues' | 'done' {
    const at = this.index(task.x, task.y);
    if (task.field !== null && task.field.status !== 'empty' && !this.tileGoodForField(task.x, task.y)) return 'done';
    switch (task.phase) {
      case 0: {
        if (!this.walkTo(u, st, { x: task.x, y: task.y })) return 'done'; // (515–518)
        task.phase = 1;
        return 'continues';
      }
      case 1: {
        this.tileLock[at] = TL_FIELD_WORK; // (519–524)
        this.recomputeWalkAround(task.x, task.y);
        task.tileLockSet = true;
        this.cancelFieldPlan(u, task);
        this.setLockedStay(u, st, 0, false); // SetActionLockedStay(0, uaWalk)
        task.phase = 2;
        return 'continues';
      }
      case 2: {
        this.setLockedStay(u, st, 11, true); // (525–532)
        task.phase2 += 1;
        if (task.phase2 === 2) this.resetDigState(task.x, task.y);
        if (task.phase2 === 6 && this.grid.elems[this.grid.obj[at]].wineOrCorn) this.removeObject(task.x, task.y);
        if (task.phase2 === 6 || task.phase2 === 8) this.incDigState(task.x, task.y);
        if (task.phase2 === 10) task.phase = 3; // (:542: only phases 0 and 10 advance fPhase)
        return 'continues';
      }
      case 3: {
        this.setFieldCorn(task.x, task.y, u.owner); // (533–539)
        this.setUnlockedStay(u, st, 5);
        this.tileLock[at] = TL_NONE;
        this.recomputeWalkAround(task.x, task.y);
        task.tileLockSet = false;
        task.phase = 4;
        return 'continues';
      }
      default:
        return 'done';
    }
  }

  /** CancelThePlan of the road task (:211–215): the plan is closed now. */
  private cancelRoadPlan(u: EconUnit, task: Task & { kind: 'buildRoad' }): void {
    if (task.field === null) return;
    C.closeField(task.field);
  }

  /** CancelThePlan of the field task (:496–500). */
  private cancelFieldPlan(u: EconUnit, task: Task & { kind: 'buildField' }): void {
    if (task.field === null) return;
    C.closeField(task.field);
  }

  /** IncDigState (KM_Terrain.pas 2433–2442): the toDig1..toDig4 overlay steps. */
  private incDigState(x: number, y: number): void {
    if (!this.inMapCoords(x, y)) return;
    const at = this.index(x, y);
    const stage = this.digOverlay[at];
    this.digOverlay[at] = stage >= 3 ? 4 : stage + 1;
  }

  /** ResetDigState (KM_Terrain.pas 2445–2448). */
  private resetDigState(x: number, y: number): void {
    if (!this.inMapCoords(x, y)) return;
    this.digOverlay[this.index(x, y)] = 0;
  }

  /** RemoveObjectsKilledByRoad (KM_Terrain.pas 3309–3339). */
  private removeObjectsKilledByRoad(x: number, y: number): void {
    const killByRoadCorner = (px: number, py: number): void => {
      if (!this.inMapCoords(px, py)) return;
      const obj = this.grid.obj[this.index(px, py)];
      if (this.grid.elems[obj].killByRoad !== 'nwCorner') return;
      if (
        this.isRoadTile(px - 1, py) &&
        this.isRoadTile(px - 1, py - 1) &&
        this.isRoadTile(px, py - 1) &&
        this.isRoadTile(px, py)
      ) {
        this.removeObject(px, py);
      }
    };
    killByRoadCorner(x, y);
    killByRoadCorner(x + 1, y);
    killByRoadCorner(x, y + 1);
    killByRoadCorner(x + 1, y + 1);
    const removeIfWest = (px: number, py: number): void => {
      if (!this.inMapCoords(px, py)) return;
      if (this.grid.elems[this.grid.obj[this.index(px, py)]].killByRoad === 'west') this.removeObject(px, py);
    };
    if (this.isRoadTile(x - 1, y)) removeIfWest(x, y);
    if (this.isRoadTile(x + 1, y)) removeIfWest(x + 1, y);
  }

  /** AddDemand(nil, aUnit, wtStone, 1, dtOnce, diHigh4) — the road task's stone demand. */
  private addUnitDemand(owner: number, unit: EconUnit, ware: number, count: number): void {
    this.demands[owner].push({
      houseUid: 0,
      unitUid: unit.uid,
      ware,
      slot: -1,
      script: true,
      count,
      being: 0,
      construction: false,
      importance: DI_HIGH4,
    });
  }

  /** RemDemand(fUnit) — the road task's destructor drops its unit demand (:175–176). */
  private removeUnitDemands(unitUid: number): void {
    for (const list of this.demands) {
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i].unitUid === unitUid) list.splice(i, 1);
      }
    }
  }

  // ---- builder-task destructors (the Pascal's Destroy methods) --------------------------------

  /** The M5a task destructors: TKMTaskBuildHouseArea.Destroy (:608–644) and friends. */
  private finishTask(u: EconUnit, st: UnitState, task: Task): void {
    switch (task.kind) {
      case 'buildHouseArea':
        this.finishHouseAreaTask(u, task);
        break;
      case 'buildHouse':
        if (!task.closed) {
          task.closed = true;
          C.remSiteWorker(task.site); // HouseList.RemWorker (:819)
        }
        break;
      case 'buildRoad':
        if (!task.closed) {
          task.closed = true;
          this.finishRoadTask(u, task);
        }
        break;
      case 'buildField':
        if (!task.closed) {
          task.closed = true;
          this.finishFieldTask(u, task);
        }
        break;
      default:
        break;
    }
    void st;
  }

  /** TKMTaskBuildHouseArea.Destroy (:608–644). */
  private finishHouseAreaTask(u: EconUnit, task: Task & { kind: 'buildHouseArea' }): void {
    if (task.closed) return;
    task.closed = true;
    const state = this.constructionState(u.owner);
    // "Yet unstarted": the plan is still the worker's → reopen or close it (:615–624).
    if (task.houseUid === 0 && task.plan.status !== 'empty' && task.plan.workerUid === u.uid) {
      const entrance = C.planEntrance(state, task.plan);
      if (C.canPlaceHouse(this, task.typeId, entrance.x, entrance.y)) C.reopenPlan(task.plan);
      else C.closePlan(task.plan);
    }
    const house = task.houseUid !== 0 ? this.houseByUid(task.houseUid) : null;
    // The worker was killed: the WIP house is demolished (:626–630).
    if (task.houseNeedsWorker && house !== null && !house.destroyed) this.demolishHouse(house, -1);
    // The site joins the ready list with hbsWood + both demands (:632–640).
    if (task.houseReadyToBuild && !task.houseNeedsWorker && house !== null && !house.destroyed) {
      this.completeHouseArea(house);
    }
  }

  /** The TKMTaskBuildHouseArea success path (:633–640). */
  private completeHouseArea(house: EconHouse): void {
    house.buildState = 'wood';
    C.addSite(this.constructionState(house.owner), house.uid);
    this.addConstructionDemand(house, WT_TIMBER, house.woodCost);
    this.addConstructionDemand(house, WT_STONE, house.stoneCost);
    this.emit('house-plan-digged', `house#${house.uid} type=${house.typeId}`);
  }

  /** TKMTaskBuildRoad.Destroy (:173–201). */
  private finishRoadTask(u: EconUnit, task: Task & { kind: 'buildRoad' }): void {
    if (task.demandSet) this.removeUnitDemands(u.uid);
    if (task.tileLockSet) {
      this.tileLock[this.index(task.x, task.y)] = TL_NONE;
      this.recomputeWalkAround(task.x, task.y);
    }
    if (task.field === null || task.field.status === 'empty') return;
    // Allow other workers to take the task, or close an invalid plan (:182–197).
    if (this.tileMakeRoads(task.x, task.y)) C.reopenField(task.field);
    else C.closeField(task.field);
  }

  /** TKMTaskBuildField.Destroy (:473–486). */
  private finishFieldTask(u: EconUnit, task: Task & { kind: 'buildField' }): void {
    if (task.tileLockSet) {
      this.tileLock[this.index(task.x, task.y)] = TL_NONE;
      this.recomputeWalkAround(task.x, task.y);
    }
    if (task.field === null || task.field.status === 'empty') return;
    if (this.tileGoodForField(task.x, task.y)) C.reopenField(task.field);
    else C.closeField(task.field);
  }

  // =============================================================================================
  // M5b school training (docs/M5-AI-NOTES.md gap item 2; KM_HouseSchool.pas + KM_UnitTaskSelfTrain.pas)

  /** The school state of a house, or null when it is not a school. */
  private schoolState(h: EconHouse): HouseState | null {
    const st = this.houseState(h);
    return st.schoolQueue !== undefined ? st : null;
  }

  /** TKMHouseSchool.AddUnitToQueue (:116–133): fill the first free queue slots 1..5, start training. */
  schoolAddUnitToQueue(houseUid: number, unitType: number, count: number): number {
    const h = this.houseByUid(houseUid);
    if (h === null || h.destroyed) return 0;
    const st = this.schoolState(h);
    if (st === null || st.schoolQueue === undefined) return 0;
    let added = 0;
    for (let k = 1; k <= Math.min(count, st.schoolQueue.length); k++) {
      for (let i = 1; i < st.schoolQueue.length; i++) {
        if (st.schoolQueue[i] === -1) {
          added += 1;
          st.schoolQueue[i] = unitType;
          if (i === 1) this.schoolStartTraining(h.uid); // "If thats the first unit then start training it"
          break;
        }
      }
    }
    return added;
  }

  /** The queue slots of a school (copy; slot 0 = the unit in training, -1 = empty). */
  schoolQueueOf(houseUid: number): number[] {
    const h = this.houseByUid(houseUid);
    if (h === null) return [];
    const st = this.schoolState(h);
    return st !== null && st.schoolQueue !== undefined ? st.schoolQueue.slice() : [];
  }

  /** TKMHouseSchool.QueueCount (:318–326). */
  schoolQueueCount(houseUid: number): number {
    const h = this.houseByUid(houseUid);
    if (h === null) return 0;
    const st = this.schoolState(h);
    if (st === null || st.schoolQueue === undefined) return 0;
    let n = 0;
    for (const q of st.schoolQueue) if (q !== -1) n += 1;
    return n;
  }

  /** The uid of the unit being trained (0 = none) — fUnitWip. */
  schoolUnitWip(houseUid: number): number {
    const h = this.houseByUid(houseUid);
    if (h === null) return 0;
    const st = this.schoolState(h);
    return st !== null ? st.unitWipUid ?? 0 : 0;
  }

  /** TKMHouseSchool.StartTrainingUnit (:249–262): shift the queue, create the unit, start the task. */
  schoolStartTraining(houseUid: number): void {
    const h = this.houseByUid(houseUid);
    if (h === null || h.destroyed) return;
    const st = this.schoolState(h);
    if (st === null || st.schoolQueue === undefined) return;
    if (st.schoolQueue[0] !== -1) return; // a unit is already in training
    if (st.schoolQueue[1] === -1) return; // nothing queued
    if (this.wareCount(h, WT_GOLD) === 0) return; // there must be gold to train
    for (let i = 0; i < st.schoolQueue.length - 1; i++) st.schoolQueue[i] = st.schoolQueue[i + 1];
    st.schoolQueue[st.schoolQueue.length - 1] = -1;
    this.schoolCreateUnit(h, st);
  }

  /** TKMHouseSchool.CreateUnit (:233–246): hide one gold, create the unit inside, start the task. */
  private schoolCreateUnit(h: EconHouse, st: HouseState): void {
    const type = st.schoolQueue !== undefined ? st.schoolQueue[0] : -1;
    if (type < 0) return;
    st.hideOneGold = true;
    // gHands[Owner].TrainUnit: the unit is created at (Entrance, dirS), inside the house (no tile).
    const unit = this.spawnCitizen(h.owner, type, h.entrance.x, h.entrance.y, 6, h.uid);
    st.unitWipUid = unit.uid;
    const ust = this.unitStateMap.get(unit);
    if (ust !== undefined) {
      ust.task = { kind: 'selfTrain', phase: 0, schoolUid: h.uid };
      ust.walk = null;
      ust.actionLock = 0;
      ust.locked = false;
      unit.taskKind = 'selfTrain';
    }
    h.workAnimStep = 0; // WorkAnimStep := 0 (:245)
    this.emit('school-unit-created', `house#${h.uid} unit#${unit.uid} type=${type}`);
  }

  /** TKMHouseSchool.UnitTrainingComplete (:266–283): clear the wip, take the gold, start the next. */
  private schoolUnitTrainingComplete(h: EconHouse, st: HouseState): void {
    st.unitWipUid = 0;
    if (st.schoolQueue !== undefined) st.schoolQueue[0] = -1;
    // "Script command might have taken the gold while we were training, in which case ignore it"
    if (this.wareCount(h, WT_GOLD) > 0) this.takeFromIn(h, WT_GOLD);
    st.hideOneGold = false;
    st.trainProgress = 0;
    this.schoolStartTraining(h.uid);
  }

  /** WareTakeFromIn(wtGold) (KM_Houses.pas 1725–1740): take one unit of a ware from the input. */
  private takeFromIn(h: EconHouse, ware: number): boolean {
    if (h.destroyed) return false;
    const slot = this.inSlot(h, ware);
    if (slot < 0 || h.wareIn[slot] <= 0) return false;
    h.wareIn[slot] -= 1;
    return true;
  }

  /** TKMTaskSelfTrain.Execute (:70–118): 5×29 + 9 stays, then go outside + UnitTrainingComplete. */
  private runSelfTrain(u: EconUnit, st: UnitState, task: Task & { kind: 'selfTrain' }): 'continues' | 'done' {
    const school = this.houseByUid(task.schoolUid);
    if (school === null || school.destroyed) return 'done'; // the school erases the task on destruction
    const sch = this.schoolState(school);
    if (sch === null) return 'done';
    switch (task.phase) {
      case 0:
        school.state = 'work'; // SetState(hstWork) + SubActionWork(haWork1)
        this.setLockedStay(u, st, 29, false);
        task.phase = 1;
        return 'continues';
      case 1:
      case 2:
      case 3:
      case 4:
        this.setLockedStay(u, st, 29, false);
        task.phase += 1;
        return 'continues';
      case 5:
        school.state = 'idle'; // SetState(hstIdle)
        this.setLockedStay(u, st, 9, false);
        task.phase = 6;
        return 'continues';
      case 6: {
        // Put him in the school + go outside; the school completes the training (:107–114).
        // (TKMUnit.TrainInHouse only starts the task — the unit has no home yet; UnitTrained
        // registers builders in fConstructions / serfs in fDeliveries, KM_Hand.pas 553–563.)
        // M5c: a recruit goes to the owner's barracks and waits there (KM_HouseBarracks.pas 404–419:
        // RecruitsAdd + Home = barracks); the v0 world moves it in directly (no walk to the door).
        const barracks = u.type === UNIT_RECRUIT ? this.firstCompleteHouse(u.owner, HOUSE_TYPE_BARRACKS) : null;
        if (barracks !== null) this.recruitEnterBarracks(u, st, barracks);
        else this.goOut(u, st, school);
        this.schoolUnitTrainingComplete(school, sch);
        this.emit('school-unit-trained', `unit#${u.uid} type=${u.type}`);
        if (u.type === UNIT_BUILDER) C.addWorker(this.constructionState(u.owner), u.uid); // UnitTrained 553–565
        task.phase = 7;
        return 'continues';
      }
      default:
        return 'done';
    }
  }

  // =============================================================================================
  // M5b AI world API (docs/M5-AI-NOTES.md §3 checklist): the terrain/stat queries the ported
  // newAI reads (packages/sim/ai.ts). All additive; the viewer/tests are unaffected.

  /** TileIsStone (KM_Terrain.pas 1385–1388): the Stone deposit of the tile (0 = none). Reads the
   *  per-tile stoneRemaining shadow (DecStoneDeposit decrements it; see M5c). */
  tileIsStone(x: number, y: number): number {
    if (!this.inMapCoords(x, y)) return 0;
    return this.stoneRemaining[this.index(x, y)];
  }

  /** TileIsCoal (1391–1394). */
  tileIsCoal(x: number, y: number): number {
    return this.tileDeposit(x, y, 'coal');
  }

  /** TileIsIron (1397–1400). */
  tileIsIron(x: number, y: number): number {
    return this.tileDeposit(x, y, 'iron');
  }

  /** TileIsGold (1403–1406). */
  tileIsGold(x: number, y: number): number {
    return this.tileDeposit(x, y, 'gold');
  }

  tileHasStone(x: number, y: number): boolean {
    return this.tileIsStone(x, y) > 0;
  }

  tileHasCoal(x: number, y: number): boolean {
    return this.tileIsCoal(x, y) > 0;
  }

  tileHasIron(x: number, y: number): boolean {
    return this.tileIsIron(x, y) > 0;
  }

  tileHasGold(x: number, y: number): boolean {
    return this.tileIsGold(x, y) > 0;
  }

  /** CanPlaceIronMine (KM_Terrain.pas 4711–4716): TileIsGoodForIronMine. */
  tileGoodForIronMine(x: number, y: number): boolean {
    return this.tileFlag(x, y, 'ironMinable');
  }

  /** CanPlaceGoldMine: TileIsGoodForGoldMine. */
  tileGoodForGoldMine(x: number, y: number): boolean {
    return this.tileFlag(x, y, 'goldMinable');
  }

  /** tpWalkRoad (KM_Terrain.pas 3780–3782): a walkable, roaded tile. */
  tileWalkableRoad(x: number, y: number): boolean {
    return tileWalkable(this.roadGrid, x, y);
  }

  /** The tile lock (TKMTileLock; TL_* in this module) — the AI's plan/lock queries. */
  tileLockAt(x: number, y: number): number {
    if (!this.inMapCoords(x, y)) return TL_NONE;
    return this.tileLock[this.index(x, y)];
  }

  /** TileIsRoadable (KM_Terrain.pas 1620–1635): the tiles.json Roadable flag. */
  tileIsRoadable(x: number, y: number): boolean {
    return this.tileFlag(x, y, 'roadable');
  }

  private tileDeposit(x: number, y: number, field: 'stone' | 'coal' | 'iron' | 'gold'): number {
    if (!this.inMapCoords(x, y)) return 0;
    const flags = this.grid.tiles[this.terrainId(x, y)];
    if (flags === undefined) return 0;
    const v = flags[field];
    return typeof v === 'number' ? v : 0;
  }

  /** DecStoneDeposit (KM_Terrain.pas 3484–3716): extract one unit of stone from a deposit. v0 only
   *  decrements the stoneRemaining shadow (the full terrain-transition floodfill is deferred); does
   *  not modify map.tiles or grid.walk → econsim/buildsim/mapscan shas unchanged. */
  private decStoneDeposit(x: number, y: number): boolean {
    if (!this.inMapCoords(x, y)) return false;
    const i = this.index(x, y);
    if (this.stoneRemaining[i] > 0) {
      this.stoneRemaining[i] -= 1;
      return true;
    }
    return false;
  }

  /** TileIsSoil (KM_Terrain.pas 1523–1526): the tiles.json Soil flag. */
  tileIsSoil(x: number, y: number): boolean {
    return this.tileFlag(x, y, 'soil');
  }

  /** CanPlaceHouse (KM_Terrain.pas 4758–4781): the terrain-only house-plan check (entrance). */
  canPlaceHouse(typeId: number, entranceX: number, entranceY: number): boolean {
    return C.canPlaceHouse(this, typeId, entranceX, entranceY);
  }

  private tileFlag(x: number, y: number, field: 'roadable' | 'soil' | 'ironMinable' | 'goldMinable'): boolean {
    if (!this.inMapCoords(x, y)) return false;
    const flags = this.grid.tiles[this.terrainId(x, y)];
    if (flags === undefined) return false;
    return flags[field] === true;
  }

  /** CanFindTree (KM_Terrain.pas 2781–2814): any tree of the asked age with a valid cutting spot. */
  canFindTree(x: number, y: number, radius: number, onlyAgeFull = false): boolean {
    const tiles = this.tilesWithinDistance({ x, y }, radius);
    for (const t of tiles) {
      const dx = Math.abs(x - t.x);
      const dy = Math.abs(y - t.y);
      const diag = dx > dy ? dx + dy * 0.41 : dy + dx * 0.41;
      if (diag > radius) continue;
      const obj = this.treeAt(t.x, t.y);
      if (obj === null) continue;
      if (onlyAgeFull && (!isTreeAgeFull(obj.obj) || obj.age < TREE_AGE_FULL)) continue;
      if (!this.canCutTreeAtVertex({ x, y }, t)) continue;
      if (this.chooseCuttingDirection({ x, y }, t) === null) continue;
      return true;
    }
    return false;
  }

  /** GetWareBalance (KM_HandStats.pas): the wares of a hand held in its houses (stores included). */
  handWareBalance(hand: number, ware: number): number {
    let n = 0;
    for (const h of this.houses) {
      if (h.owner !== hand || h.destroyed) continue;
      n += this.wareCount(h, ware);
    }
    return n;
  }

  /** GetHouseQty (KM_HandStats): complete (hbsDone) houses of a script-id type. */
  handHouseCount(hand: number, typeId: number): number {
    let n = 0;
    for (const h of this.houses) {
      if (h.owner !== hand || h.destroyed) continue;
      if (h.typeId !== typeId) continue;
      if (h.buildState === 'done') n += 1;
    }
    return n;
  }

  /** GetHouseTotal: every (not destroyed) house of a script-id type, WIP included. */
  handHouseTotalCount(hand: number, typeId: number): number {
    let n = 0;
    for (const h of this.houses) {
      if (h.owner !== hand || h.destroyed) continue;
      if (h.typeId === typeId) n += 1;
    }
    return n;
  }

  /** GetHouseQty(htAny): all houses of the hand. */
  handHouseAnyCount(hand: number): number {
    let n = 0;
    for (const h of this.houses) {
      if (h.owner === hand && !h.destroyed) n += 1;
    }
    return n;
  }

  /** GetUnitQty (KM_HandStats): live units of a unit.dat record. */
  handUnitCount(hand: number, type: number): number {
    let n = 0;
    for (const u of this.units) {
      if (u.owner === hand && u.type === type && !u.dead) n += 1;
    }
    return n;
  }

  /**
   * TKMHand.AddFirstStorehouse's AddRoad (KM_Hand.pas 2185–2196): a real road on the tile
   * (SetRoad + FlattenTerrain + remove wine/corn objects). Only used by the AI's first store.
   */
  addRoadTile(x: number, y: number): void {
    if (!this.inMapCoords(x, y)) return;
    this.setRoad(x, y, 0);
    this.flattenTerrain(x, y);
    if (this.grid.elems[this.grid.obj[this.index(x, y)]].wineOrCorn) this.removeObject(x, y);
  }

  /**
   * WareAddToEitherFromScript (KM_Houses.pas): a script/AI ware injection — a store's stock or
   * the house's input slot, with an offer for output wares/stores. `addWareToStore` delegates here.
   */
  addWareToHouseFromScript(houseUid: number, ware: number, amount: number): boolean {
    if (ware < 0 || ware >= WARE_CNT || amount <= 0) return false;
    const h = this.houseByUid(houseUid);
    if (h === null || h.destroyed) return false;
    const st = this.houseState(h);
    if (st.stock !== null) {
      st.stock[ware] = Math.min(65535, st.stock[ware] + amount);
      if (h.typeId !== HOUSE_TYPE_BARRACKS) this.addOffer(h.uid, ware, amount);
      return true;
    }
    const inSlot = this.inSlot(h, ware);
    if (inSlot >= 0) {
      h.wareIn[inSlot] = Math.min(65535, h.wareIn[inSlot] + amount);
      if (st.schoolQueue !== undefined && st.unitWipUid === 0) this.schoolStartTraining(h.uid);
      return true;
    }
    const outSlot = this.outSlot(h, ware);
    if (outSlot >= 0) {
      h.wareOut[outSlot] = Math.min(65535, h.wareOut[outSlot] + amount);
      this.addOffer(h.uid, ware, amount);
      return true;
    }
    return false;
  }

  /**
   * WareAddToEitherFromScript into the hand's first complete store (KM_Hand.pas 2210) — the
   * bootstrap path the AI's first storehouse uses (fChooseLocation.Resources).
   */
  addWareToStore(hand: number, ware: number, amount: number): boolean {
    if (ware < 0 || ware >= WARE_CNT || amount <= 0) return false;
    const store = this.houses.find((h) => h.typeId === 11 && h.owner === hand && !h.destroyed && h.buildState === 'done');
    if (store === undefined) return false;
    return this.addWareToHouseFromScript(store.uid, ware, amount);
  }

  /**
   * TKMHand.TrainUnit (KM_Hand.pas 538–550): a citizen created at (entrance, dirS), inside the
   * house (it does not occupy a terrain tile). The school's CreateUnit + the AI's spawns use it.
   */
  spawnCitizen(owner: number, type: number, x: number, y: number, dir: number, inHouseUid = 0): EconUnit {
    const spec = this.unitSpecs[type];
    if (spec === undefined) throw new Error(`spawnCitizen: no unit.dat record ${type}`);
    const unit: EconUnit = {
      uid: this.uidCounter++,
      owner,
      type,
      posF: { x, y },
      dir,
      animStep: 0,
      action: 'stay',
      carry: -1,
      inside: inHouseUid !== 0,
      homeUid: 0,
      taskKind: 'none',
      hitPoints: spec.hitPoints ?? 0,
      groupUid: 0,
      fightState: 'none',
      dead: false,
    };
    this.units.push(unit);
    const st: UnitState = {
      spec,
      speed: walkSpeeds(spec.speedRaw),
      walk: null,
      actionLock: 0,
      locked: false,
      task: null,
      homeUid: 0,
      warrior: null,
      posRound: { x, y },
      posPrev: { x, y },
      posNext: { x, y },
    };
    this.unitStates.push(st);
    this.unitStateMap.set(unit, st);
    if (inHouseUid === 0 && x >= 0 && x <= this.map.mapX && y >= 0 && y <= this.map.mapY) {
      this.unitTile[this.index(x, y)] = unit.uid; // a free unit occupies its tile
    }
    const fog = this.fow[owner];
    if (fog !== undefined) fog.reveal(x, y, spec.sight ?? 0, true);
    return unit;
  }

  /** The unit's current task phase (−1 = no task) — the AI's builder dig-state check. */
  unitTaskPhase(unitUid: number): number {
    const u = this.unitByUid(unitUid);
    if (u === null) return -1;
    const st = this.unitStateMap.get(u);
    if (st === undefined || st.task === null) return -1;
    return (st.task as { phase: number }).phase;
  }

  /** The unit's buildHouse target house uid (0 = not building a house) — the builder's site check. */
  unitBuildHouseUid(unitUid: number): number {
    const u = this.unitByUid(unitUid);
    if (u === null) return 0;
    const st = this.unitStateMap.get(u);
    if (st === undefined || st.task === null || st.task.kind !== 'buildHouse') return 0;
    return st.task.houseUid;
  }

  /** TKMHandConstructions.AddWorker — a trained builder joins the registry (KM_Hand.pas 553–555). */
  registerBuilder(hand: number, unitUid: number): void {
    C.addWorker(this.constructionState(hand), unitUid);
  }


  // =============================================================================================
  // M4 combat host (docs/M4-SPIKE.md §3): the world side of packages/sim/combat.ts

  // ---- world ---------------------------------------------------------------------------------

  get mapX(): number {
    return this.map.mapX;
  }

  get mapY(): number {
    return this.map.mapY;
  }

  get mapSizeX(): number {
    return this.map.mapX;
  }

  get mapSizeY(): number {
    return this.map.mapY;
  }

  /** TileInMapCoords (KM_Terrain.pas 1137–1141): the usable 1..N−1 box. */
  tileInMapCoords(x: number, y: number): boolean {
    return this.inMapCoords(x, y);
  }

  /** tpWalk for one tile. */
  tileWalkable(x: number, y: number): boolean {
    return tileWalkable(this.grid, x, y);
  }

  /** CanWalkDiagonally (KM_Terrain.pas 2150–2169). */
  canWalkDiagonal(fromX: number, fromY: number, x: number, y: number): boolean {
    return canWalkDiagonal(this.grid, { x: fromX, y: fromY }, x, y);
  }

  /** wcWalk component id (GetWalkConnectID). */
  walkConnectId(x: number, y: number): number {
    if (!this.inMapCoords(x, y)) return 0;
    return this.connectIds()[this.index(x, y)];
  }

  /** GetClosestTile (KM_Terrain.pas 4171–4208). */
  closestTile(x: number, y: number, fromX: number, fromY: number, exact: boolean): Pt {
    const wcId = this.walkConnectId(fromX, fromY);
    if (exact && this.tileWalkable(x, y) && wcId === this.walkConnectId(x, y)) return { x, y };
    for (let i = 0; i <= 255; i++) {
      const p = getPositionFromIndex({ x, y }, i);
      if (!this.inMapCoords(p.x, p.y)) continue;
      if (!this.tileWalkable(p.x, p.y)) continue;
      if (wcId !== this.walkConnectId(p.x, p.y)) continue;
      if (!canWalkDiagonal(this.grid, { x, y }, p.x, p.y)) continue; // aNeedToFight (4199)
      const other = this.unitAtTile(p.x, p.y);
      if (other === null || (p.x === fromX && p.y === fromY)) return p;
    }
    return { x: fromX, y: fromY };
  }

  /** Route_Make over the shipped A* (returns the node list or null). */
  findRoute(fromX: number, fromY: number, toX: number, toY: number): Pt[] | null {
    return findPath(this.grid, { x: fromX, y: fromY }, { x: toX, y: toY });
  }

  // ---- units ---------------------------------------------------------------------------------

  unitCount(): number {
    return this.units.length;
  }

  unitAt(index: number): EconUnit {
    return this.units[index];
  }

  unitByUid(uid: number): EconUnit | null {
    if (uid <= 0) return null;
    for (const u of this.units) if (u.uid === uid) return u;
    return null;
  }

  private stateOf(u: CombatUnit): UnitState | undefined {
    return this.unitStateMap.get(u as EconUnit);
  }

  unitRuntime(u: CombatUnit): UnitRuntime {
    const st = this.stateOf(u);
    if (st === undefined) throw new Error(`unitRuntime: unknown unit uid ${u.uid}`);
    return st;
  }

  specOfType(type: number): UnitSpec {
    const spec = this.unitSpecs[type];
    if (spec === undefined) throw new Error(`specOfType: no unit.dat record ${type}`);
    return spec;
  }

  posFPoint(u: CombatUnit): Pt {
    return u.posF;
  }

  posRound(u: CombatUnit): Pt {
    const st = this.stateOf(u);
    return st !== undefined ? st.posRound : { x: this.round(u.posF.x), y: this.round(u.posF.y) };
  }

  posNext(u: CombatUnit): Pt {
    const st = this.stateOf(u);
    return st !== undefined ? st.posNext : { x: this.round(u.posF.x), y: this.round(u.posF.y) };
  }

  posPrev(u: CombatUnit): Pt {
    const st = this.stateOf(u);
    return st !== undefined ? st.posPrev : { x: this.round(u.posF.x), y: this.round(u.posF.y) };
  }

  /** GetMovementVector (KM_Units.pas 2405–2419): the walk direction × the effective speed. */
  movementVector(u: CombatUnit): Pt {
    const st = this.stateOf(u);
    if (st === undefined || st.walk === null) return { x: 0, y: 0 };
    const vertex = kmGetVertex(u.dir);
    const speed = isDiagDir(u.dir) ? st.speed.diag : st.speed.ortho;
    return { x: vertex.x * speed, y: vertex.y * speed };
  }

  /** Terrain IsUnit at a tile (the unit's PositionNext registration). */
  unitAtTile(x: number, y: number): EconUnit | null {
    if (x < 0 || x > this.map.mapX || y < 0 || y > this.map.mapY) return null;
    const uid = this.unitTile[this.index(x, y)];
    if (uid === 0) return null;
    const u = this.unitByUid(uid);
    return u !== null && !u.dead ? u : null;
  }

  /** UnitsHitTestF (KM_Terrain.pas 1870–1910): the closest unit within 1.0 of a float point.
   *  The Y loop bound uses fMapX in the Pascal — copied (flagged in the combat.ts header). */
  unitAtTileF(x: number, y: number): EconUnit | null {
    let result: EconUnit | null = null;
    const i1 = Math.max(Math.trunc(y) - 1, 1);
    const i2 = Math.min(Math.trunc(y) + 2, this.map.mapX);
    const k1 = Math.max(Math.trunc(x) - 1, 1);
    const k2 = Math.min(Math.trunc(x) + 2, this.map.mapX);
    for (let i = i1; i <= i2; i++) {
      for (let k = k1; k <= k2; k++) {
        const u = this.unitAtTile(k, i);
        if (u === null) continue;
        const t = lengthSqr(u.posF, { x, y });
        if (t <= 1 && (result === null || t < lengthSqr(result.posF, { x, y }))) result = u;
      }
    }
    return result;
  }

  /** CheckAlliance (KM_HandsCollection.pas 867–873): animals ally with everyone, same hand allies. */
  allianceOf(a: number, b: number): 'ally' | 'enemy' {
    if (a === -1 || b === -1) return 'ally';
    return a === b ? 'ally' : 'enemy';
  }

  /** fVisible: inside a house or closed units are not visible. */
  isVisible(u: CombatUnit): boolean {
    return !u.dead && !(u as EconUnit).inside;
  }

  warriorState(u: CombatUnit): WarriorState | null {
    const st = this.stateOf(u);
    return st !== undefined ? st.warrior : null;
  }

  /** SetActionWalkToSpot: replace the action with a walk to (x, y) from the current tile. */
  startWalkTo(u: CombatUnit, x: number, y: number): boolean {
    const st = this.stateOf(u);
    if (st === undefined) return false;
    const from = st.posRound;
    const walk = startWalk(this.grid, from, { x, y });
    if (walk === null) return false;
    this.endFight(u, st);
    st.walk = walk;
    st.actionLock = 0;
    st.locked = false;
    if (st.warrior !== null) st.warrior.stayActive = false;
    u.action = 'walk';
    return true;
  }

  /** AbandonWalk: stop the walk action. */
  abandonWalk(u: CombatUnit): void {
    const st = this.stateOf(u);
    if (st === undefined) return;
    st.walk = null;
    u.action = 'stay';
    this.syncUnitPositions(u as EconUnit, st);
  }

  /** SetActionStay / SetActionLockedStay: actionLock = executes; 0 = one final execute. */
  setStay(u: CombatUnit, ticks: number, locked: boolean, still: boolean, step: number): void {
    const st = this.stateOf(u);
    if (st === undefined) return;
    this.endFight(u, st);
    st.walk = null;
    u.action = 'stay';
    st.actionLock = ticks;
    st.locked = locked;
    if (st.warrior !== null) {
      st.warrior.stayActive = true;
      st.warrior.stayLocked = locked;
      st.warrior.stayStill = still;
    }
    if (step > 0) u.animStep = step;
  }

  /** Clear the stay action without starting a new one. */
  clearStay(u: CombatUnit): void {
    const st = this.stateOf(u);
    if (st === undefined) return;
    st.actionLock = 0;
    st.locked = false;
    if (st.warrior !== null) st.warrior.stayActive = false;
  }

  setFightState(u: CombatUnit, s: 'none' | 'fight' | 'die'): void {
    u.fightState = s;
  }

  /** The fight action's destructor: release the opponent + the diagonal vertex. */
  private endFight(u: CombatUnit, st: UnitState): void {
    if (u.fightState !== 'fight' && st.warrior === null) return;
    if (st.warrior !== null && st.warrior.fightVertex !== null) {
      this.vertexRemove(st.warrior.fightVertex.x, st.warrior.fightVertex.y);
      st.warrior.fightVertex = null;
    }
    if (st.warrior !== null) st.warrior.fightOpponentUid = 0;
    if (u.fightState === 'fight') u.fightState = 'none';
  }

  /** HitPointsDecrease (KM_Units.pas 1627–1645). */
  damageUnit(u: CombatUnit, amount: number, attackerUid: number, source: 'melee' | 'arrow' | 'script'): void {
    combatHitPointsDecrease(this, u, amount, attackerUid, source);
  }

  /** TKMUnit.Kill (1532–1566). */
  killUnit(u: CombatUnit, fromOwner: number, showAnim: boolean, forceDelay: boolean): void {
    combatKillUnit(this, u, fromOwner, showAnim, forceDelay);
  }

  /** CloseUnit (KM_Units.pas 1416–1443): erase the unit; it is removed from the list next tick. */
  closeUnit(u: CombatUnit): void {
    const st = this.stateOf(u);
    if (st !== undefined) {
      if (st.warrior !== null && st.warrior.fightVertex !== null) {
        this.vertexRemove(st.warrior.fightVertex.x, st.warrior.fightVertex.y);
        st.warrior.fightVertex = null;
      }
      st.walk = null;
      st.actionLock = 0;
      st.locked = false;
      if (st.posNext.x >= 0 && st.posNext.x <= this.map.mapX && st.posNext.y >= 0 && st.posNext.y <= this.map.mapY) {
        const oi = this.index(st.posNext.x, st.posNext.y);
        if (this.unitTile[oi] === u.uid) this.unitTile[oi] = 0;
      }
      st.posRound = { x: 0, y: 0 };
      st.posPrev = { x: 0, y: 0 };
      st.posNext = { x: 0, y: 0 };
    }
    u.dead = true;
    u.hitPoints = 0;
    u.owner = -1;
    u.dir = 0;
    u.animStep = 0;
    u.posF = { x: 0, y: 0 };
    u.groupUid = 0;
  }

  // ---- groups --------------------------------------------------------------------------------

  groupList(): GroupState[] {
    return this.groups;
  }

  groupByUid(uid: number): GroupState | null {
    return this.groupMap.get(uid) ?? null;
  }

  newGroup(owner: number, groupType: number, x: number, y: number, dir: number, unitsPerRow: number): GroupState {
    const g: GroupState = {
      uid: this.groupUidCounter++,
      owner,
      memberUids: [],
      groupType,
      order: 'none',
      orderX: x,
      orderY: y,
      targetUid: 0,
      targetHouseUid: 0,
      ticker: 0,
      offenders: [],
      unitsPerRow: Math.max(unitsPerRow, 1),
      orderDir: dir,
      orderWalkKind: 'none',
      targetGroupUid: 0,
      targetFollowTicker: 0,
      pushbackCommands: 0,
      timeSinceHungryReminder: 0,
      blockPlayerOrders: false,
      manualFormation: false,
      selectedUid: 0,
    };
    this.groups.push(g);
    this.groupMap.set(g.uid, g);
    return g;
  }

  // ---- houses --------------------------------------------------------------------------------

  houseAt(x: number, y: number): CombatHouse | null {
    if (x < 0 || x > this.map.mapX || y < 0 || y > this.map.mapY) return null;
    const uid = this.houseTile[this.index(x, y)];
    if (uid === 0) return null;
    const h = this.houseByUid(uid);
    return h !== null && !h.destroyed ? h : null;
  }

  houseByUid(uid: number): EconHouse | null {
    if (uid <= 0) return null;
    for (const h of this.houses) if (h.uid === uid) return h;
    return null;
  }

  /** GetListOfCellsWithin (KM_Houses.pas 1109–1123). */
  houseCells(h: EconHouse): Pt[] {
    const out: Pt[] = [];
    const plan = housePlan(h.typeId);
    for (let i = 1; i <= 4; i++) {
      for (let k = 1; k <= 4; k++) {
        if (plan[i - 1][k - 1] === 0) continue;
        const tx = h.x + k - 3;
        const ty = h.y + i - 4;
        if (this.inMapCoords(tx, ty)) out.push({ x: tx, y: ty });
      }
    }
    return out;
  }

  /** GetDistance (KM_Houses.pas 1046–1060): distance to the closest house tile. */
  houseDistance(h: EconHouse, x: number, y: number): number {
    let result = Number.POSITIVE_INFINITY;
    for (const c of this.houseCells(h)) result = Math.min(result, length({ x, y }, c));
    return result;
  }

  /** GetClosestCell (KM_Houses.pas 1029–1042). */
  houseClosestCell(h: EconHouse, x: number, y: number): Pt {
    let result: Pt = { x: 0, y: 0 };
    let best = Number.POSITIVE_INFINITY;
    for (const c of this.houseCells(h)) {
      const d = length({ x, y }, c);
      if (d < best) {
        best = d;
        result = c;
      }
    }
    return result;
  }

  /** GetHealth (KM_Houses.pas 1173–1176): max(buildingProgress − damage, 0). A complete house's
   *  progress is its MaxHealth (565); a WIP house's health is its building progress. */
  houseHealth(h: EconHouse): number {
    const base = h.buildState === 'done' ? h.maxHealth ?? 0 : h.buildingProgress;
    return Math.max(base - (h.damage ?? 0), 0);
  }

  /** MaxHealth (KM_Houses.pas 1274–1280): 0 for hbsNoGlyph houses, else the spec value. */
  houseMaxHealth(h: EconHouse): number {
    return h.buildState === 'noGlyph' ? 0 : h.maxHealth ?? 0;
  }

  /** AddDamage (KM_Houses.pas 1296–1330): clamp, fire sub-actions, AI notify stub, demolish at 0. */
  houseAddDamage(h: EconHouse, amount: number, attackerUid: number): void {
    if (h.destroyed === true) return;
    const maxHealth = this.houseMaxHealth(h);
    const before = h.damage ?? 0;
    h.damage = Math.min(before + amount, maxHealth);
    this.houseDamageTotal += h.damage - before;
    const dmgLevel = Math.floor(maxHealth / 8);
    h.fireLevel = 0;
    for (let i = 0; i < 8; i++) if ((h.damage ?? 0) > i * dmgLevel) h.fireLevel = i + 1;
    this.houseAttackNotification(h.uid, attackerUid); // stub at KM_Houses.pas 1317
    if (this.houseHealth(h) === 0) {
      const attacker = this.unitByUid(attackerUid);
      this.demolishHouse(h, attacker !== null ? attacker.owner : -1);
    }
  }

  /** Demolish (KM_Houses.pas 730–786) + AddHouseRemainder (KM_Terrain.pas 4922–4947). */
  private demolishHouse(h: EconHouse, fromOwner: number): void {
    if (h.destroyed === true) return;
    h.destroyed = true;
    void fromOwner;

    // TKMHouseSchool.Demolish (:89–100): drop the queued units and cancel the WIP one.
    const st = this.houseState(h);
    if (st.schoolQueue !== undefined) {
      for (let i = 1; i < st.schoolQueue.length; i++) st.schoolQueue[i] = -1;
      const wip = st.unitWipUid ?? 0;
      st.unitWipUid = 0;
      st.schoolQueue[0] = -1;
      st.hideOneGold = false;
      if (wip !== 0) {
        const wu = this.unitByUid(wip);
        if (wu !== null && !wu.dead) this.closeUnit(wu); // CancelTrainingUnit: CloseUnit(False)
      }
    }

    // SetHouse(fPosition, fType, hsNone, HAND_NONE): release the footprint, recompute tpWalk.
    const plan = housePlan(h.typeId);
    for (let i = 1; i <= 4; i++) {
      for (let k = 1; k <= 4; k++) {
        if (plan[i - 1][k - 1] === 0) continue;
        const tx = h.x + k - 3;
        const ty = h.y + i - 4;
        if (!this.inMapCoords(tx, ty)) continue;
        const at = this.index(tx, ty);
        this.houseTile[at] = 0;
        this.tileLock[at] = TL_NONE; // hsNone → TileLock := tlNone (KM_Terrain.pas 4640)
        this.recomputeWalkTile(tx, ty);
      }
    }

    // Rubble (AddHouseRemainder 4929–4936): one KaMRandom(6) per 2×2-block tile, I outer, K inner.
    let rubble = 0;
    for (let i = 2; i <= 4; i++) {
      for (let k = 2; k <= 4; k++) {
        if (plan[i - 2][k - 1] !== 0 && plan[i - 1][k - 2] !== 0 && plan[i - 2][k - 2] !== 0 && plan[i - 1][k - 1] !== 0) {
          const tx = h.x + k - 3;
          const ty = h.y + i - 4;
          if (!this.inMapCoords(tx, ty)) continue;
          this.grid.obj[this.index(tx, ty)] = 68 + this.drawN(6); // rubble 68..73
          rubble += 1;
        }
      }
    }

    // Road removal (Demolish 772–777): only for houses that do not sit on their own road.
    if (this.isRoadTile(h.entrance.x, h.entrance.y)) {
      const at = this.index(h.entrance.x, h.entrance.y);
      if (this.roadOverlay[at] === 1) {
        this.roadOverlay[at] = 0;
        this.roadTileCount -= 1;
        this.roadGrid.walk[at] = 0;
      }
    }

    // The house's offers and demands die with it (Demolish drops the queue entries; tasks notice
    // via their per-tick uid lookups and abandon, KM_UnitTaskDelivery.pas 361).
    for (const list of this.offers) {
      for (let i = list.length - 1; i >= 0; i--) if (list[i].houseUid === h.uid) list.splice(i, 1);
    }
    for (const list of this.demands) {
      for (let i = list.length - 1; i >= 0; i--) if (list[i].houseUid === h.uid) list.splice(i, 1);
    }

    // Units inside the destroyed house lose their home and are placed next to the entrance
    // (KM_Units.pas UpdateVisibility 2184–2226: FindPlaceForUnit spiral from the entrance).
    for (const u of this.units) {
      const st = this.unitStateMap.get(u);
      if (st === undefined || st.homeUid !== h.uid) continue;
      st.homeUid = 0;
      u.homeUid = 0;
      st.task = null;
      st.walk = null;
      if (u.inside) {
        u.inside = false;
        const spot = this.findPlaceNear({ x: h.entrance.x, y: h.entrance.y }, u);
        u.posF = { x: spot.x, y: spot.y };
        st.posRound = { x: spot.x, y: spot.y };
        st.posPrev = { x: spot.x, y: spot.y };
        this.setUnitPosNext(u, st, spot);
        const fog = this.fow[u.owner];
        if (fog !== undefined) fog.reveal(spot.x, spot.y, st.spec.sight ?? 0, true);
      }
      this.emit('home-lost', `unit#${u.uid}`);
    }

    this.walkConnectDirty = true;
    this.emit('house-destroyed', `house#${h.uid} type=${h.typeId} rubble=${rubble}`);
  }

  /** FindPlaceForUnit essentials: the nearest free walkable tile to a point (spiral order). */
  private findPlaceNear(origin: Pt, u: EconUnit): Pt {
    for (let i = 0; i <= 255; i++) {
      const p = getPositionFromIndex(origin, i);
      if (!this.inMapCoords(p.x, p.y)) continue;
      if (!tileWalkable(this.grid, p.x, p.y)) continue;
      const other = this.unitAtTile(p.x, p.y);
      if (other === null || other === u) return p;
    }
    return origin;
  }

  /** Recompute one tile's tpWalk/tpWorker/tpWalkRoad after an object/lock/house change
   *  (UpdatePassability essentials, KM_Terrain.pas 3752–3844). */
  private recomputeWalkTile(x: number, y: number): void {
    if (!this.inMapCoords(x, y)) return;
    const at = this.index(x, y);
    const rec = (y - 1) * this.map.mapX + (x - 1);
    const terrain = this.map.tiles[rec * 4];
    const flags = this.grid.tiles[terrain];
    const base =
      flags !== undefined &&
      flags.walkable &&
      !this.grid.elems[this.grid.obj[at]].allBlocked &&
      checkHeightPass(this.grid, x, y);
    const lock = this.tileLock[at];
    // tpWalk: the lock must be none/fenced/fieldWork/roadWork (3773–3778).
    const tpWalk = base && (lock === TL_NONE || lock === TL_FENCED || lock === TL_FIELD_WORK || lock === TL_ROAD_WORK);
    this.grid.walk[at] = tpWalk ? 1 : 0;
    // tpWorker: everything except tlHouse (3840–3844).
    this.workerGrid.walk[at] = base && lock !== TL_HOUSE ? 1 : 0;
    // tpWalkRoad (3780–3782).
    this.roadGrid.walk[at] = tpWalk && this.roadOverlay[at] === 1 ? 1 : 0;
  }

  /** UpdatePassability for a rect of tiles (the 3×3 around a changed tile, KM_Terrain.pas 4464). */
  private recomputeWalkAround(x: number, y: number, radius = 1): void {
    for (let i = y - radius; i <= y + radius; i++) {
      for (let k = x - radius; k <= x + radius; k++) this.recomputeWalkTile(k, i);
    }
    this.walkConnectDirty = true;
  }

  // ---- FOW / vertices ------------------------------------------------------------------------

  fog(hand: number): FogOfWar {
    const f = this.fow[hand];
    if (f === undefined) throw new Error(`fog: no hand ${hand} (handCount ${this.handCount})`);
    return f;
  }

  /** VertexUsageCompatible (KM_Terrain.pas 4319–4328): none or the same diagonal orientation. */
  vertexUsageCompatible(fromX: number, fromY: number, x: number, y: number): boolean {
    const vert = { x: Math.max(fromX, x), y: Math.max(fromY, y) };
    const usage = this.vertexUsage[this.index(vert.x, vert.y)];
    const type = (fromX - x) * (fromY - y) === 1 ? 1 : 2;
    return usage === 0 || usage === type;
  }

  /** UnitVertexAdd (KM_Terrain.pas 4301–4305). */
  vertexAdd(fromX: number, fromY: number, x: number, y: number): void {
    const vert = { x: Math.max(fromX, x), y: Math.max(fromY, y) };
    const type = (fromX - x) * (fromY - y) === 1 ? 1 : 2; // vuNWSE / vuNESW
    this.vertexUsage[this.index(vert.x, vert.y)] = type;
  }

  /** UnitVertexRem (KM_Terrain.pas 4309–4313). */
  vertexRemove(x: number, y: number): void {
    if (x < 0 || x > this.map.mapX || y < 0 || y > this.map.mapY) return;
    this.vertexUsage[this.index(x, y)] = 0;
  }

  // ---- notifications (M4 stubs; M5 wires the AI) ---------------------------------------------

  /** Stub (KM_UnitActionFight.pas 281/285, KM_Projectiles.pas 188). */
  unitAttackNotification(_unitUid: number, _attackerUid: number, _isDefender: boolean): void {}

  /** Stub (KM_Units.pas 1637). */
  unitHPDecreaseNotification(_unitUid: number, _attackerUid: number): void {}

  /** Stub (KM_Houses.pas 1317). */
  houseAttackNotification(_houseUid: number, _attackerUid: number): void {}

  // ---- projectiles ---------------------------------------------------------------------------

  projectileList(): SimProjectile[] {
    return this.projectiles;
  }

  nextProjectileUid(): number {
    return this.projectileUidCounter++;
  }

  addProjectile(p: SimProjectile): void {
    this.projectiles.push(p);
  }

  /** Drop resolved projectiles (RemItem, KM_Projectiles.pas 87–91). */
  compactProjectiles(): void {
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      if (this.projectiles[i].t < 0) this.projectiles.splice(i, 1);
    }
  }

  // ---- removal passes ------------------------------------------------------------------------

  private removeDeadUnits(): void {
    for (let i = this.units.length - 1; i >= 0; i--) {
      const u = this.units[i];
      if (!u.dead) continue;
      const st = this.unitStates[i];
      // A dying builder's task runs its destructor (the Pascal frees the task with the unit).
      if (st !== undefined && st.task !== null) {
        const task = st.task;
        st.task = null;
        this.finishTask(u, st, task);
      }
      this.unitStateMap.delete(u);
      this.units.splice(i, 1);
      this.unitStates.splice(i, 1);
    }
  }

  private removeDeadGroups(): void {
    for (let i = this.groups.length - 1; i >= 0; i--) {
      if (this.groups[i].memberUids.length > 0) continue;
      this.groupMap.delete(this.groups[i].uid);
      this.groups.splice(i, 1);
    }
  }

  private removeDestroyedHouses(): void {
    for (let i = this.houses.length - 1; i >= 0; i--) {
      const h = this.houses[i];
      if (!h.destroyed) continue;
      this.houseStateMap.delete(h.uid);
      this.houses.splice(i, 1);
    }
  }

  // ---- public M4 API (docs/M4-SPIKE.md §3) ---------------------------------------------------

  /**
   * Create one warrior (TKMUnit.Create 1238–1291): one condition draw, full HP, fTicker = UID, the
   * initial 10-tick stay, FOW MAX reveal at the spawn tile. Used by the combat CLI and tests; the
   * mission units keep the frozen M3 no-draw spawn (documented divergence).
   */
  spawnUnit(owner: number, type: number, x: number, y: number, dir: number): EconUnit {
    const spec = this.unitSpecs[type];
    if (spec === undefined) throw new Error(`spawnUnit: no unit.dat record ${type}`);
    const unit: EconUnit = {
      uid: this.uidCounter++,
      owner,
      type,
      posF: { x, y },
      dir,
      animStep: 0,
      action: 'stay',
      carry: -1,
      inside: false,
      homeUid: 0,
      taskKind: 'none',
      hitPoints: spec.hitPoints ?? 0,
      groupUid: 0,
      fightState: 'none',
      dead: false,
    };
    const condition = this.round(UNIT_MAX_CONDITION * (UNIT_CONDITION_BASE + this.drawS2(UNIT_CONDITION_RANDOM)));
    const ws: WarriorState = {
      ticker: unit.uid,
      hitPointCounter: 1,
      condition,
      stayActive: true,
      stayLocked: false,
      stayStill: true,
      fightOpponentUid: 0,
      fightDelay: -1,
      fightVertex: null,
      task: null,
      order: 'none',
      nextOrder: 'none',
      nextOrderForced: true,
      orderLoc: { x, y },
      useExactTarget: false,
      orderTargetUid: 0,
      orderTargetHouseUid: 0,
      attackingUid: 0,
      faceDir: 0,
      lastShootTime: 0,
      killAsap: false,
      killAsapShowAnimation: true,
      killedBy: -1,
    };
    const st: UnitState = {
      spec,
      speed: walkSpeeds(spec.speedRaw),
      walk: null,
      actionLock: 10, // SetActionStay(10, uaWalk) (1277)
      locked: false,
      task: null,
      homeUid: 0,
      warrior: ws,
      posRound: { x, y },
      posPrev: { x, y },
      posNext: { x, y },
    };
    this.units.push(unit);
    this.unitStates.push(st);
    this.unitStateMap.set(unit, st);
    if (x >= 0 && x <= this.map.mapX && y >= 0 && y <= this.map.mapY) this.unitTile[this.index(x, y)] = unit.uid;
    const fog = this.fow[owner];
    if (fog !== undefined) fog.reveal(x, y, spec.sight ?? 0, true); // 1288–1290
    return unit;
  }

  /** Spawn one warrior and its own 1-member group (WarriorTrained hndComputer path). */
  spawnWarrior(owner: number, type: number, x: number, y: number, dir: number): { unit: EconUnit; group: GroupState } {
    const unit = this.spawnUnit(owner, type, x, y, dir);
    const group = createSoloGroup(this, unit, dir);
    return { unit, group };
  }

  /** Spawn a whole group (the script constructor 279–337): see combat.spawnGroup. */
  spawnGroup(owner: number, type: number, x: number, y: number, dir: number, unitsPerRow: number, count: number): GroupState {
    return combatSpawnGroup(this, owner, type, x, y, dir, unitsPerRow, count);
  }

  /** Spawn a complete house (the mission's SET_HOUSE build path + Activate 669–717). */
  spawnHouse(typeId: number, x: number, y: number, owner: number): EconHouse {
    const spec = this.houseSpecs[typeId];
    const entrance = { x: x + (spec !== undefined ? spec.entranceDx : 0), y };
    const house: EconHouse = {
      uid: this.uidCounter++,
      typeId,
      owner,
      x,
      y,
      entrance,
      state: 'empty',
      wareIn: [0, 0, 0, 0],
      wareOut: [0, 0, 0, 0],
      workerUid: 0,
      animStep: 0,
      workAnimStep: 0,
      maxHealth: spec !== undefined ? spec.maxHealth : 0,
      damage: 0,
      destroyed: false,
      fireLevel: 0,
      buildState: 'done',
      buildingProgress: spec !== undefined ? spec.maxHealth : 0,
      buildSupplyWood: 0,
      buildSupplyStone: 0,
      buildReserve: 0,
      readyToBeBuilt: false,
      woodCost: spec !== undefined ? spec.woodCost : 0,
      stoneCost: spec !== undefined ? spec.stoneCost : 0,
      flagPoint: null,
    };
    this.houses.push(house);
    const state: HouseState = createHouseState(typeId, spec);
    this.houseStateMap.set(house.uid, state);

    const plan = housePlan(typeId);
    for (let i = 1; i <= 4; i++) {
      for (let k = 1; k <= 4; k++) {
        if (plan[i - 1][k - 1] === 0) continue;
        const tx = x + k - 3;
        const ty = y + i - 4;
        if (!this.inMapCoords(tx, ty)) continue;
        const at = this.index(tx, ty);
        this.grid.walk[at] = 0;
        this.workerGrid.walk[at] = 0;
        this.tileLock[at] = TL_HOUSE;
        this.houseTile[at] = house.uid;
      }
    }
    // Activate (689–695): reveal the house from every covered point.
    const fog = this.fow[owner];
    if (fog !== undefined && spec !== undefined) {
      for (const c of this.houseCells(house)) fog.reveal(c.x, c.y, spec.sight ?? 0, true);
    }
    if (typeId === HOUSE_TYPE_BARRACKS) this.addBarracksDemands(house); // Activate (701) for the barracks' warfare demands
    this.walkConnectDirty = true;
    return house;
  }

  /** AddDemandsOnActivate (KM_Houses.pas 649–666) for a house made by spawnHouse: one demand per WareInput slot. */
  addInputDemands(house: EconHouse): void {
    this.addDemandsOnActivate(house);
  }

  /** The frozen group-orders API (docs/M4-SPIKE.md §3). */
  orderGroup(uid: number, kind: 'walk' | 'attackUnit' | 'attackHouse' | 'halt' | 'none', x = 0, y = 0, target = 0): boolean {
    const g = this.groupMap.get(uid);
    if (g === undefined) return false;
    switch (kind) {
      case 'walk':
        groupOrderWalk(this, g, { x, y }, true, 'none', 0, true);
        break;
      case 'attackUnit':
        groupOrderAttackUnit(this, g, target, true);
        break;
      case 'attackHouse':
        groupOrderAttackHouse(this, g, target, true);
        break;
      case 'halt':
        groupOrderHalt(this, g, true);
        break;
      case 'none':
        groupOrderNone(this, g);
        break;
      default:
        return false;
    }
    return true;
  }

  /** The frozen house-damage API (docs/M4-SPIKE.md §3). */
  damageHouse(houseUid: number, amount: number, attackerUid: number): void {
    const h = this.houseByUid(houseUid);
    if (h === null) return;
    this.houseAddDamage(h, amount, attackerUid);
  }

  /** The frozen unit-health API (docs/M4-SPIKE.md §3); −1 for an unknown uid. */
  unitHealth(uid: number): number {
    const u = this.unitByUid(uid);
    return u !== null ? u.hitPoints : -1;
  }

  /** The frozen group-lookup API (docs/M4-SPIKE.md §3). */
  groupOf(uid: number): GroupState | null {
    const u = this.unitByUid(uid);
    if (u === null || u.groupUid === 0) return null;
    return this.groupByUid(u.groupUid);
  }

  // ---- M5c military world API (docs/M5-SPIKE.md 7.5; KM_HouseBarracks.pas 331–419) ------------

  /** The first complete house of a script-id type owned by a hand (creation order). */
  private firstCompleteHouse(owner: number, typeId: number): EconHouse | null {
    for (const h of this.houses) {
      if (h.owner === owner && h.typeId === typeId && !h.destroyed && h.buildState === 'done') return h;
    }
    return null;
  }

  /** A school recruit enters the barracks: Home = barracks, hidden inside (RecruitsAdd, 158–161). */
  private recruitEnterBarracks(u: EconUnit, st: UnitState, h: EconHouse): void {
    u.inside = true;
    u.homeUid = h.uid;
    st.homeUid = h.uid;
    st.walk = null;
    st.actionLock = 0;
    st.locked = false;
    u.action = 'stay';
  }

  /** CreateRecruitInside (KM_HouseBarracks.pas 404–419): a recruit waits hidden in the barracks (Home =
   *  barracks). Used by the scenario grant of the attack run; school-trained recruits come the same way. */
  barracksAddRecruit(houseUid: number): EconUnit | null {
    const h = this.houseByUid(houseUid);
    if (h === null || h.destroyed || h.typeId !== HOUSE_TYPE_BARRACKS) return null;
    const door = pointBelowEntrance(h);
    const u = this.spawnCitizen(h.owner, UNIT_RECRUIT, door.x, door.y, 6, h.uid);
    const st = this.stateOf(u);
    if (st !== undefined) this.recruitEnterBarracks(u, st, h);
    return u;
  }

  /** The recruits waiting in one barracks (TKMHouseBarracks.RecruitsCount, KM_HouseBarracks.pas 164–167). */
  barracksRecruitCount(houseUid: number): number {
    let n = 0;
    for (const u of this.units) if (u.homeUid === houseUid && u.type === UNIT_RECRUIT && u.inside && !u.dead) n += 1;
    return n;
  }

  /** The wares of a hand that can be taken out of its houses now (stock, or the output slot). */
  private handOutWareBalance(hand: number, ware: number): number {
    let n = 0;
    for (const h of this.houses) {
      if (h.owner !== hand || h.destroyed) continue;
      const st = this.houseState(h);
      if (st.stock !== null) n += st.stock[ware] ?? 0;
      else {
        const slot = this.outSlot(h, ware);
        if (slot >= 0) n += h.wareOut[slot];
      }
    }
    return n;
  }

  /** Take one ware of a hand out of its first house that holds one, with the matching offer. */
  private takeHouseOutWare(hand: number, ware: number): boolean {
    for (const h of this.houses) {
      if (h.owner !== hand || h.destroyed) continue;
      if (!this.takeFromOut(h, ware)) continue;
      const offer = this.offers[hand].find((o) => o.houseUid === h.uid && o.ware === ware && o.count > 0);
      if (offer !== undefined) offer.count -= 1;
      return true;
    }
    return false;
  }

  /**
   * CanEquip (KM_HouseBarracks.pas 331–341): a recruit waits, and the barracks' own warfare stock
   * (fResourceCount, filled by serf deliveries, M5e) holds each TROOP_COST ware. Locks.GetUnitBlocked
   * is not checked (no unit locks in v0).
   */
  barracksCanEquip(houseUid: number, unitType: number): boolean {
    const h = this.houseByUid(houseUid);
    const cost = TROOP_COST[unitType];
    if (h === null || h.destroyed || h.buildState !== 'done' || h.typeId !== HOUSE_TYPE_BARRACKS || cost === undefined) return false;
    if (this.barracksRecruitCount(houseUid) === 0) return false;
    const stock = this.houseState(h).stock;
    if (stock === null) return false;
    for (const ware of new Set(cost)) {
      if ((stock[ware] ?? 0) < cost.filter((w) => w === ware).length) return false;
    }
    return true;
  }

  /**
   * EquipWarrior (KM_HouseBarracks.pas 344–380): the wares are taken, the first recruit leaves, and
   * a warrior at 0.6 max condition (TROOPS_TRAINED_CONDITION) stands at the barracks door. The
   * Pascal walks him out with SetActionGoIn(gdGoOutside) and reports WarriorWalkedOut; the v0 world
   * places him at the door at once (documented). Returns the new warrior, or null.
   */
  barracksEquip(houseUid: number, unitType: number): EconUnit | null {
    if (!this.barracksCanEquip(houseUid, unitType)) return null;
    const h = this.houseByUid(houseUid) as EconHouse;
    const stock = this.houseState(h).stock as Int32Array;
    for (const ware of TROOP_COST[unitType]) stock[ware] -= 1;
    const recruit = this.units.find((u) => u.homeUid === houseUid && u.type === UNIT_RECRUIT && u.inside && !u.dead);
    if (recruit !== undefined) this.closeUnit(recruit);
    const door = pointBelowEntrance(h);
    const { unit } = this.spawnWarrior(h.owner, unitType, door.x, door.y, 4);
    const ws = this.warriorState(unit);
    if (ws !== null) ws.condition = Math.round(TROOPS_TRAINED_CONDITION * UNIT_MAX_CONDITION);
    this.emit('barracks-equipped', `house#${h.uid} unit#${unit.uid} type=${unitType}`);
    return unit;
  }

  /** The live warriors of a hand (GetArmyCount, KM_HandStats.pas): every warrior record. */
  handWarriorCount(hand: number): number {
    let n = 0;
    for (const u of this.units) if (u.owner === hand && !u.dead && isWarriorSpec(this.unitSpecs[u.type])) n += 1;
    return n;
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
