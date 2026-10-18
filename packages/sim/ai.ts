// ai.ts — M5b Advanced AI, the economy half (docs/M5-AI-NOTES.md §2/§3, docs/M5-SPIKE.md §3).
//
// The port of the newAI's city systems against the v0 economy world: Eye (per-hand map view +
// TKMBuildFF), Influences-lite, CityPredictor, CityPlanner, CityBuilder, CityManagement. The
// military half (ArmyManagement/ArmyAttackNew/ArmyDefence/Supervisor + recruit/equip) is worker N's
// job; this file leaves the interfaces (AiPlayer.cityManagement's weapon demands, the per-tick
// army slot in AiPlayer.updateState, Eye.armyEvaluation stub).
//
// Source of truth (r15472, read-only reference):
//  - newAI/KM_Eye.pas — house mapping (InitHousesMapping 630–755), soil/routes/flatArea
//    (AfterMissionInit 345–442, ScanLoc 531–626), mine/stone/forest lists (GetMineLocs 902–930,
//    GetStoneLocs 933–971, GetForests 976–1064), CanPlaceHouse (772–798), CanAddHousePlan
//    (805–899), TKMBuildFF (1292–1840), TKMFFInitPlace (1842–1926), TKMFFCheckStoneTiles
//    (1929–1973).
//  - ai/KM_AIInfluences.pas — AvoidBuilding constants (14–23), AddAvoidBuilding/RemAvoidBuilding
//    (234–257), MarkForest (260–290), InitAvoidBuilding (294–339), ownership queries (460–634),
//    UpdateOwnership cadence (714–748, 638–670).
//  - newAI/KM_CityPredictor.pas — the whole class (ware balance 300–452, basic houses 456–485,
//    city stats 489–527, final production 530–620, filter 640–813, cadence 816–834).
//  - newAI/KM_CityPlanner.pas — HOUSE_DEPENDENCE (189–220), UpdateState (427–560), GetPlan
//    (591–715), RemoveHouseType/RemovePlan (733–812), GetHousePlan (815–860), GetRoadToHouse
//    (863–1016), GetRoadBetweenPoints (1019–1028), GetFieldToHouse (1031–1042),
//    GetTreesInHousePlan (1045–1065), CheckFields (1177–1223), PlanFields (1226–1455),
//    ObstaclesInHousePlan/FieldCrit/SnapCrit/DistCrit (1458–1608), FindPlaceForHouse (1612–1902),
//    FindPlaceForMines (1905–2048), CheckStoneReserves/FindPlaceForQuary (2051–2283),
//    FindPlaceForWoodcutter/FindForestAndWoodcutter (2287–2531), FindForestAround (2535–2607),
//    PlanDefenceTowers (2610–2702), TKMPathFindingCityPlanner + shortcuts (2829–2968),
//    TKMFieldEvaluation (2971–3082).
//  - newAI/KM_CityBuilder.pas — the whole class (build nodes 393–820, materials 823–893,
//    BuildHouse 902–1080, ChooseHousesToBuild 1083–1472, CreateShortcuts 1475–1657).
//  - newAI/KM_CityManagement.pas — the whole class (cadence 151–194, unit count 197–438,
//    markets 442–586, store wares 589–634, exhausted houses 638–664, repair 668–693, ware
//    distribution 696–772, weapons balance 776–1044, order weapons 1048–1104).
//  - newAI/KM_AIParameters.pas — the AI_Par table values (213–387).
//  - ai/KM_AI.pas — PlaceFirstStorehouse (595–698), AfterMissionInit (529–545), UpdateState
//    cadence (548–585); ai/KM_AISetup.pas — the setup defaults (11–83).
//
// Frozen integration (docs/M5-AI-NOTES.md §1/§3):
//  - The Eye is ONE shared instance for all hands, context-switched by `ownerUpdate(hand)` — the
//    port keeps the singleton (docs/M5-AI-NOTES.md gotcha).
//  - Cadences use MAX_HANDS = 27, not the player count: city every `tick mod 27 = owner`,
//    management long update every `tick mod 54 = owner`, predictor production refresh every
//    `27*60*5 = 8100`, influences city ownership every 150 (offset 15).
//  - `!SET_AI_*` values are honoured via parseAiSetups (the economy half reads AutoBuild,
//    IsRepairAlways/UnlimitedEquip/ArmyType/equip rates into the setup; ArmyType and the equip
//    rates are read by the army half only).
//
// v0 simplifications (documented; each is a deliberate, flagged divergence):
//  - No NavMesh: influences are per-tile arrays. Ownership is the same flood-fill shape
//    (HouseInfluence: max(0, 255 − distance·2), KMDistanceWalk 10/14 per step, max 150,
//    KM_NavMeshInfluences.pas 177–186) but over tiles, and `tpOwn` = ownership > 0. Army
//    presence is not modelled (worker N).
//  - The road pathfinder is a Dijkstra over tiles with the Pascal MovementCost tables
//    (ROADS_*/SHORTCUTS_*), not TKMPathFindingRoad (which is not ported; docs/M5-AI-NOTES.md gap
//    11) — routes may differ from the game's A* in tie cases.
//  - Wine field plans are placed by the remove-tree-in-plan procedure (as in the Pascal) but the
//    v0 builder has no wine task (docs/M5-SPIKE.md §1a), so a tree-blocked plan is abandoned
//    instead of cleared (flagged in `updateBuildNode`).
//  - The live CityBuilder never mutates terrain (docs/M5-SPIKE.md §2.4): the port only places
//    plans (house/field) — the single terrain mutation is PlaceFirstStorehouse's road, which is
//    ported as the world's addRoadTile (as in the game).
//  - CityManagement's market trading, store NotAcceptFlag blocking, auto-repair and ware
//    distribution need world features that do not exist in v0 (no market house, no NotAcceptFlag,
//    no WareDistribution): the port keeps the demand/weapon computation and documents the
//    missing writes (see the class methods).
//  - Mine production is out of the v0 economy slice (only hut/sawmill work), so a planned
//    quarry/mine/farm produces nothing yet; the planner/builder still place them (faithful).
//
// The military half (M5c, docs/M5-SPIKE.md 7.5) is in aiarmy.ts (ArmyManagement: recruit/equip,
// CheckAttack, combat groups, defence positions) and aisupervisor.ts (the Supervisor: attack requests,
// defence-position lines, the mine division). It attaches to the hand's AiPlayer through `attachArmy`:
//  - `AiPlayer`: owns eye/predictor/planner/builder/cityManagement; `army` is the slot updated between
//    the Eye context switch and CityManagement (KM_AI.pas 567–572); `eye.armyEvaluation` is the
//    matching slot in the shared Eye (KM_Eye.pas 758–761), unused (the army-power model is not ported).
//  - `CityManagement.requiredWeapons` (wtWoodenShield..wtHorse: available/required/fraction) and
//    `warriorsDemands` (utMilitia..utKnight) are the recruit/equip inputs (KM_CityManagement.pas
//    30–31, 776–1044); `OrderWeapons` needs a house WareOrder the v0 world does not have.
//  - `CityPredictor.maxSoldiersInMin` / `maxIronWeapProd` / `maxWoodWeapProd` and the setup's
//    `equipRateIron`/`equipRateLeather` (adjusted by UnlimitedEquip, KM_CityPredictor.pas 598–602)
//    are the army-production targets.
//  - `Influences.getOwnership/getBestOwner/getBestAllianceOwnership/getOtherOwnerships` are the
//    army-side influence reads (military presence is not modelled — N adds it).
//
// Browser-safe: no node: imports.
import type { EconomyWorld, EconHouse } from './economy.ts';
import { housePlan } from '../assets/housedata.ts';
import type { HouseSpec } from '../assets/housedata.ts';
import {
  WARE_CNT,
  WT_TRUNK, WT_STONE, WT_TIMBER, WT_IRON_ORE, WT_GOLD_ORE, WT_COAL, WT_IRON, WT_GOLD,
  WT_WINE, WT_CORN, WT_BREAD, WT_FLOUR, WT_LEATHER, WT_SAUSAGE, WT_PIG, WT_SKIN,
  WT_WOODEN_SHIELD, WT_IRON_SHIELD, WT_LEATHER_ARMOR, WT_IRON_ARMOR, WT_AXE, WT_SWORD,
  WT_LANCE, WT_PIKE, WT_BOW, WT_CROSSBOW, WT_HORSE, WT_FISH,
} from '../assets/wares.ts';
import { decodeMissionScript, tokenizeMissionScript } from '../mission/mission.ts';
import type { MissionInfo } from '../mission/mission.ts';
import { MAX_HANDS } from '../mission/mission.ts';
import { hasFieldPlan, hasHousePlan, houseCanBuild, HOUSE_TYPE_NONE, unlockedByHouse } from './construction.ts';
import type { FieldType } from './construction.ts';

export interface Pt {
  x: number;
  y: number;
}

function kmPoint(x: number, y: number): Pt {
  return { x, y };
}

/** KMDistanceAbs (KM_Points.pas): the Manhattan distance. */
export function distanceAbs(a: Pt, b: Pt): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

/** KMDistanceSqr (KM_Points.pas). */
export function distanceSqr(a: Pt, b: Pt): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

/** GetLengthDiag (KM_Points.pas 273–284). */
export function lengthDiag(a: Pt, b: Pt): number {
  const dx = Math.abs(a.x - b.x);
  const dy = Math.abs(a.y - b.y);
  return dx > dy ? dx + dy * 0.41 : dy + dx * 0.41;
}

/** Delphi Math.Round (round half to even), like walk.ts/economy.ts. */
function round(x: number): number {
  const floor = Math.floor(x);
  const frac = x - floor;
  if (frac > 0.5) return floor + 1;
  if (frac < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// ---------------------------------------------------------------------------------------------
// Frozen constants

// AvoidBuilding values (KM_AIInfluences.pas 14–23).
export const AVOID_BUILDING_UNLOCK = 0;
export const AVOID_BUILDING_HOUSE_OUTSIDE_LOCK = 10;
export const AVOID_BUILDING_HOUSE_INSIDE_LOCK = 15;
export const AVOID_BUILDING_HOUSE_ENTRANCE = 20;
export const AVOID_BUILDING_COAL_TILE = 25;
export const AVOID_BUILDING_NODE_LOCK_FIELD = 30;
export const AVOID_BUILDING_NODE_LOCK_ROAD = 35;
export const AVOID_BUILDING_MINE_TILE = 40;
export const AVOID_BUILDING_FOREST_RANGE = 200;
export const AVOID_BUILDING_FOREST_MINIMUM = 254 - AVOID_BUILDING_FOREST_RANGE; // 54

// TKMBuildState (KM_Eye.pas 32).
export const BS_NO_BUILD = 0;
export const BS_HOUSE_PLAN = 1;
export const BS_FIELD_PLAN = 2;
export const BS_ROAD_PLAN = 3;
export const BS_ROAD = 4;
export const BS_BUILD = 9;
export const BS_TREE = 10;
export const BS_FOREST = 11;
export const BS_COAL = 12;
export const BS_MINE = 13;
export const BS_DEBUG = 200;
export const BS_RESERVED = 255;

// MAX_SCAN_DIST_FROM_HOUSE / MIN_SCAN_DIST_FROM_HOUSE (KM_Eye.pas 18–19).
export const MAX_SCAN_DIST_FROM_HOUSE = 10;
export const MIN_SCAN_DIST_FROM_HOUSE = 2;

// TDirection order (KM_Eye.pas 22): dirN=0, dirE=1, dirS=2, dirW=3.
export const DIR_N = 0;
export const DIR_E = 1;
export const DIR_S = 2;
export const DIR_W = 3;

// House script ids used by name (HOUSE_ID_TO_TYPE, KM_ResHouses.pas 193–199):
// 0 sawmill, 1 ironSmithy, 2 weaponSmithy, 3 coalMine, 4 ironMine, 5 goldMine, 6 fishermans,
// 7 bakery, 8 farm, 9 woodcutters, 10 armorSmithy, 11 store, 12 stables, 13 school, 14 quarry,
// 15 metallurgists, 16 swine, 17 watchTower, 18 townHall, 19 weaponWorkshop, 20 armorWorkshop,
// 21 barracks, 22 mill, 23 siegeWorkshop, 24 butchers, 25 tannery, 26 none, 27 inn, 28 vineyard,
// 29 market.
export const HT_STORE = 11;
export const HT_SCHOOL = 13;
export const HT_BARRACKS = 21;
export const HT_MARKET = 29;
export const HT_WOODCUTTERS = 9;
export const HT_SAWMILL = 0;
export const HT_QUARRY = 14;
export const HT_FARM = 8;
export const HT_VINEYARD = 28;
export const HT_INN = 27;
export const HT_WATCHTOWER = 17;
export const HT_COAL_MINE = 3;
export const HT_IRON_MINE = 4;
export const HT_GOLD_MINE = 5;
export const HT_METALLURGISTS = 15;
export const HT_IRON_SMITHY = 1;
export const HT_ARMOR_SMITHY = 10;
export const HT_WEAPON_SMITHY = 2;
export const HT_ARMOR_WORKSHOP = 20;
export const HT_WEAPON_WORKSHOP = 19;
export const HT_TANNERY = 25;
export const HT_SWINE = 16;
export const HT_BUTCHERS = 24;
export const HT_MILL = 22;
export const HT_BAKERY = 7;
export const HT_STABLES = 12;
export const HT_FISHER_HUT = 6;
export const HT_TOWN_HALL = 18;
export const HT_SIEGE_WORKSHOP = 23;

// Unit records (UNIT_ID_TO_TYPE, KM_ResUnits.pas 146–157).
export const UT_SERF = 0;
export const UT_WOODCUTTER = 1;
export const UT_MINER = 2;
export const UT_ANIMAL_BREEDER = 3;
export const UT_FARMER = 4;
export const UT_CARPENTER = 5;
export const UT_BAKER = 6;
export const UT_BUTCHER = 7;
export const UT_FISHER = 8;
export const UT_BUILDER = 9;
export const UT_STONEMASON = 10;
export const UT_SMITH = 11;
export const UT_METALLURGIST = 12;
export const UT_RECRUIT = 13;
export const UT_MILITIA = 14;
export const UT_AXE_FIGHTER = 15;
export const UT_SWORD_FIGHTER = 16;
export const UT_BOWMAN = 17;
export const UT_CROSSBOWMAN = 18;
export const UT_LANCE_CARRIER = 19;
export const UT_PIKEMAN = 20;
export const UT_SCOUT = 21;
export const UT_KNIGHT = 22;

// WARFARE_MIN..WARFARE_MAX = wtWoodenShield..wtHorse (KM_ResTypes.pas).
export const WARE_WARFARE_MIN = WT_WOODEN_SHIELD;
export const WARE_WARFARE_MAX = WT_HORSE;

// PRODUCTION_RATE (KM_ResWares.pas 87–93): ware produced per minute on average, ware ids 0..27.
export const PRODUCTION_RATE: number[] = [
  88 / 120, 414 / 120, 390 / 120, 160 / 120, 160 / 120,
  155 / 120, 218 / 120, 330 / 120, 120 / 120, 138 / 120,
  336 / 120, 162 / 120, 324 / 120, 510 / 120, 84 / 180,
  84 / 180, 180 / 120, 155 / 120, 180 / 120, 155 / 120,
  200 / 120, 195 / 120, 200 / 120, 195 / 120, 200 / 120,
  195 / 120, 69 / 120, 122 / 120,
];

/**
 * The AI_Par table (KM_AIParameters.pas 213–387) — the economy-half entries and the ATTACK_SQUAD
 * entries (the military half, aiarmy.ts), exact values. The ATTACK_ArmyVectorField and
 * ATTACK_SUPERVISOR entries are not copied (the army vector is not ported).
 */
export const AI_PAR = {
  ATTACK_SQUAD_ChangeTarget_Delay: 416.4127197,
  ATTACK_SQUAD_MinWalkingDistance: 5.0,
  ATTACK_SQUAD_TargetReached_House: 8.0,
  ATTACK_SQUAD_TargetReached_Position: 5.0,
  ATTACK_SQUAD_TargetReached_RangedSquad: 10.2428083,
  ATTACK_SQUAD_TargetReached_Unit: 35.0,
  ATTACK_SQUAD_TrafficDetection_Limit: 1.0,
  ATTACK_SQUAD_TrafficDetection_Threshold: 10.0,
  BUILDER_BuildHouse_FieldMaxWork: 1.6684477,
  BUILDER_BuildHouse_RTPMaxWork: 11.6014986,
  BUILDER_BuildHouse_RoadMaxWork: 21.677248,
  BUILDER_ChHTB_AllWorkerCoef: 8.1070709,
  BUILDER_ChHTB_FractionCoef: 21.3621922,
  BUILDER_ChHTB_FreeWorkerCoef: 17.1468201,
  BUILDER_ChHTB_TrunkBalance: 0.2159205,
  BUILDER_ChHTB_TrunkFactor: 11.5937538,
  BUILDER_CreateShortcuts_MaxWork: 10.0,
  BUILDER_Shortage_Gold: 29.1807594,
  BUILDER_Shortage_Stone: 11.748311,
  BUILDER_Shortage_StoneReserve: 14.046031,
  BUILDER_Shortage_Trunk: 1.8335937,
  BUILDER_Shortage_Wood: 19.8352127,
  EYE_GetForests_MaxAB: 26.4097462,
  EYE_GetForests_MinRndSoil: 45.289257,
  EYE_GetForests_MinTrees: 2.9898586,
  EYE_GetForests_Radius: 6.1196084,
  EYE_GetForests_SPRndOwnLimMax: 165.0055695,
  EYE_GetForests_SPRndOwnLimMin: 98.0682449,
  MANAGEMENT_CheckUnitCount_SerfGoldCoef: 0.3049391,
  MANAGEMENT_CheckUnitCount_SerfLimit1: 22.1768589,
  MANAGEMENT_CheckUnitCount_SerfLimit2: 34.9827499,
  MANAGEMENT_CheckUnitCount_SerfLimit3: 51.9892654,
  MANAGEMENT_CheckUnitCount_WorkerGoldCoef: 2.2670105,
  MANAGEMENT_GoldShortage: 6.1128011,
  MANAGEMENT_CheckStoreWares_Stone: 27.4838066,
  PLANNER_FARM_FieldCrit_FlatArea: 13.7585087,
  PLANNER_FARM_FieldCrit_PolyRoute: 0.4989614,
  PLANNER_FARM_FieldCrit_Soil: 1.9767742,
  PLANNER_FARM_FindPlaceForHouse_CityCenter: 5.639627,
  PLANNER_FARM_FindPlaceForHouse_FlatArea: 16.0,
  PLANNER_FARM_FindPlaceForHouse_HouseDist: 19.9625053,
  PLANNER_FARM_FindPlaceForHouse_Route: -1.1648518,
  PLANNER_FARM_PlanFields_CanBuild: 759.2076416,
  PLANNER_FARM_PlanFields_Dist: 32.8001213,
  PLANNER_FARM_PlanFields_ExistField: 95.6147385,
  PLANNER_FindPlaceForHouse_CityCenter: 40.0904541,
  PLANNER_FindPlaceForHouse_FlatArea: 2.7339566,
  PLANNER_FindPlaceForHouse_HouseDist: 43.220047,
  PLANNER_FindPlaceForHouse_Route: 2.4208529,
  PLANNER_FindPlaceForHouse_SeedDist: 25.1297512,
  PLANNER_FindPlaceForHouse_SnapCrit: 0.8601482,
  PREDICTOR_WareNeedPerAWorker_Stone: 0.6821785,
  PREDICTOR_WareNeedPerAWorker_StoneOffset: 14.5459347,
  PREDICTOR_WorkerCountCoef: 0.0047831,
  PLANNER_FindPlaceForQuary_StoneLoc_StoneCnt: 5.0048351,
  PLANNER_FindPlaceForQuary_StoneLoc_AlreadyMined: 125.4238663,
  PLANNER_FindPlaceForQuary_StoneLoc_Distance: 13.8679466,
  PLANNER_FindPlaceForQuary_DistCity: 20.9321098,
  PLANNER_FindPlaceForQuary_DistStone: 25.5000973,
  PLANNER_FindPlaceForQuary_DistTimer: 3051.0822754,
  PLANNER_FindPlaceForQuary_Obstacle: 90.0,
  PLANNER_FindPlaceForQuary_SnapCrit: 14.2139816,
  PLANNER_FindPlaceForQuary_QtyStone: 26.7360783,
  PLANNER_FOREST_FindForestAround_MaxDist: 8.3981934,
  PLANNER_FOREST_FindPlaceForWoodcutter_ABRange: 43.0639,
  PLANNER_FOREST_FindPlaceForWoodcutter_DistCrit: 18.3647213,
  PLANNER_FOREST_FindPlaceForWoodcutter_DistTimer: 6053.0366211,
  PLANNER_FOREST_FindPlaceForWoodcutter_ExistForest: 359.9281311,
  PLANNER_FOREST_FindPlaceForWoodcutter_FlatArea: 5.8913641,
  PLANNER_FOREST_FindPlaceForWoodcutter_FreeTiles: 4.6900163,
  PLANNER_FOREST_FindPlaceForWoodcutter_Radius: 3.5208817,
  PLANNER_FOREST_FindPlaceForWoodcutter_Routes: -0.6038398,
  PLANNER_FOREST_FindPlaceForWoodcutter_Soil: 0.1276233,
  PLANNER_FOREST_FindPlaceForWoodcutter_TreeCnt: 7.248507,
  PLANNER_FOREST_FindPlaceForWoodcutter_TreeCntTimer: 21258.125,
  PLANNER_FOREST_PlaceWoodcutter_DistFromForest: 0.2943508,
  PLANNER_ObstaclesInHousePlan_Road: 293.8428345,
  PLANNER_ObstaclesInHousePlan_Tree: 599.5475464,
  PLANNER_SnapCrit_Field: 27.8181629,
  PLANNER_SnapCrit_HouseOrRoad: 1.1461508,
  PLANNER_SnapCrit_NoBuild: -9.2810154,
  PLANNER_SnapCrit_ObstacleInEntrance: 201.9597015,
  PLANNER_SnapCrit_Road: 61.5381699,
  PLANNER_SnapCrit_RoadInEntrance: 22.1572151,
  PREDICTOR_SecondSchool_MinRequiredUnits: 44.3221283,
  PREDICTOR_WareNeedPerAWorker_Wood: 0.3007088,
  SHORTCUTS_BasePrice: 95.1310349,
  SHORTCUTS_Coal: 49.1626778,
  SHORTCUTS_Field: 50.0,
  SHORTCUTS_Forest: 18.1300087,
  SHORTCUTS_OtherCase: 24.3808022,
  SHORTCUTS_Road: 46.6517181,
  SHORTCUTS_TurnPenalization: 33.4370956,
  SHORTCUTS_noBuildArea: 25.7135334,
  ROADS_BasePrice: 42.2091637,
  ROADS_Coal: 29.032589,
  ROADS_Field: 46.5412674,
  ROADS_Forest: 57.8719749,
  ROADS_OtherCase: 11.6849775,
  ROADS_Road: 23.1054745,
  ROADS_TurnPenalization: 50.0,
  ROADS_noBuildArea: 35.9236031,
} as const;

// ---------------------------------------------------------------------------------------------
// AI setup (ai/KM_AISetup.pas 11–83 + the !SET_AI_* handlers, KM_MissionScript_Standard.pas
// 647–697; docs/M5-AI-NOTES.md §5)

/** TKMArmyType (KM_ResTypes.pas): atIronThenLeather = 0 (the script value). */
export interface AiSetup {
  hand: number;
  /** !SET_ADVANCED_AI_PLAYER / EnableAdvancedAI: the newAI is selected. */
  newAI: boolean;
  /** AutoBuild (default true): CityManagement drives the Builder. */
  autoBuild: boolean;
  /** AutoAttack (default false; forced to AutoAttackRange = 0 by EnableAdvancedAI). */
  autoAttack: boolean;
  /** !SET_AI_CHARACTER AUTO_ATTACK_RANGE (default 4, → 0 with the advanced AI). */
  autoAttackRange: number;
  /** !SET_AI_ARMY_TYPE (default atIronThenLeather = 0) — read by the army half only. */
  armyType: number;
  /** !SET_AI_CHARACTER EQUIP_RATE_IRON (default 500). */
  equipRateIron: number;
  /** !SET_AI_CHARACTER EQUIP_RATE_LEATHER (default 1000). */
  equipRateLeather: number;
  /** !SET_AI_CHARACTER MAX_SOLDIER (default −1 = unlimited). */
  maxSoldiers: number;
  /** !SET_AI_CHARACTER RECRUT_COUNT (default 5). */
  recruitCount: number;
  /** !SET_AI_CHARACTER RECRUTS → RecruitDelay (minutes, default 0). */
  recruitDelay: number;
  /** !SET_AI_CHARACTER CONSTRUCTORS → WorkerCount (default 6; v0 reads it as an upper hint). */
  workerCount: number;
  /** !SET_AI_CHARACTER ATTACK_FACTOR → Aggressiveness (default 100). */
  aggressiveness: number;
  /** !SET_AI_CHARACTER TOWN_DEFENSE → TownDefence (default 100). */
  townDefence: number;
  /** !SET_AI_NO_BUILD (default false). */
  noBuild: boolean;
  /** !SET_AI_AUTO_REPAIR → IsRepairAlways (default false). */
  isRepairAlways: boolean;
  /** !SET_AI_UNLIMITED_EQUIP (default false) — read by the predictor + army half. */
  unlimitedEquip: boolean;
  /** !SET_AI_START_POSITION (x+1, y+1); default (1,1). */
  startPosition: Pt;
  /** !CENTER_SCREEN (x+1, y+1) — PlaceFirstStorehouse's seed point; (0,0) when absent. */
  centerScreen: Pt;
  /** !SET_AI_AUTO_DEFEND (default false): the Supervisor distributes the defence positions. */
  autoDefend: boolean;
  /** !SET_AI_CHARACTER TROUP_PARAM per group type (melee..mounted, script index 0..3): the formation. */
  troopFormations: { numUnits: number; unitsPerRow: number }[];
  /** !SET_AI_DEFENSE records, in script order (General.DefencePositions, KM_AIDefensePos.pas). */
  defencePositions: ScriptDefencePosition[];
  /** !SET_AI_ATTACK / !COPY_AI_ATTACK records, in script order (General.Attacks, KM_AIAttacks.pas). */
  attacks: ScriptAttack[];
}

/** One !SET_AI_DEFENSE record (TAIDefencePosition, KM_AIDefensePos.pas). */
export interface ScriptDefencePosition {
  pos: Pt;
  /** dir 1..8 (dirN..dirNW). */
  dir: number;
  /** Group type script index 0..3 (gtMelee..gtMounted). */
  groupType: number;
  radius: number;
  /** TKMAIDefencePosType: dtFrontLine (0) or dtBackLine (1). */
  backLine: boolean;
}

/** One scripted attack (TKMAIAttack, KM_AIAttacks.pas 15–26). */
export interface ScriptAttack {
  uid: number;
  /** aatRepeating (script TYPE 0 or 2) or aatOnce (TYPE 1). */
  repeating: boolean;
  hasOccured: boolean;
  delay: number;
  totalMen: number;
  /** Squads per group type, script index 0..3 (melee..mounted). */
  groupAmounts: number[];
  randomGroups: boolean;
  /** TKMAIAttackTarget: 0 closest unit, 1 closest building from the army, 2 from the start, 3 custom. */
  target: number;
  range: number;
  customPosition: Pt;
}

/** The defaults of TKMHandAISetup.Create (KM_AISetup.pas 11–83). */
export function defaultAiSetup(hand: number): AiSetup {
  return {
    hand,
    newAI: false,
    autoBuild: true,
    autoAttack: false,
    autoAttackRange: 4,
    armyType: 0,
    equipRateIron: 500,
    equipRateLeather: 1000,
    maxSoldiers: -1,
    recruitCount: 5,
    recruitDelay: 0,
    workerCount: 6,
    aggressiveness: 100,
    townDefence: 100,
    noBuild: false,
    isRepairAlways: false,
    unlimitedEquip: false,
    startPosition: kmPoint(1, 1),
    centerScreen: kmPoint(0, 0),
    autoDefend: false,
    troopFormations: [0, 1, 2, 3].map(() => ({ numUnits: 9, unitsPerRow: 3 })), // TKMArmyDefence.Create (KM_ArmyDefence.pas 206–210)
    defencePositions: [],
    attacks: [],
  };
}

/** A fresh TKMAIAttack record (FillChar 0 — ctClearAIAttack, KM_MissionScript_Standard.pas 806). */
function blankScriptAttack(): Omit<ScriptAttack, 'uid'> {
  return {
    repeating: false,
    hasOccured: false,
    delay: 0,
    totalMen: 0,
    groupAmounts: [0, 0, 0, 0],
    randomGroups: false,
    target: 0,
    range: 0,
    customPosition: kmPoint(0, 0),
  };
}

/**
 * Parse the mission script's `!SET_AI_*` records into per-hand setups (docs/M5-AI-NOTES.md §5):
 * the notes' "read by newAI" set is AutoBuild, ArmyType, EquipRate*, UnlimitedEquip, MaxSoldiers,
 * RecruitDelay, AutoAttack, StartPosition, IsRepairAlways. `info` supplies the
 * !SET_ADVANCED_AI_PLAYER flags (parseMissionInfo); CENTER_SCREEN is read here too because the
 * first-storehouse placement needs it and parseMissionInfo does not keep it.
 * A hand's setup is created for every hand of the mission (index = hand).
 */
export function parseAiSetups(bytes: Uint8Array, info: MissionInfo, mapX = 0, mapY = 0): AiSetup[] {
  const text = decodeMissionScript(bytes);
  const commands = tokenizeMissionScript(text);
  const setups: AiSetup[] = [];
  for (let h = 0; h < MAX_HANDS; h++) setups.push(defaultAiSetup(h));

  let hand = -1;
  // fAIAttack (KM_MissionScript_Standard.pas): one record that the script fills in piece by piece;
  // ctCopyAIAttack stores a copy and ctClearAIAttack resets it (it is not reset per hand).
  let pending = blankScriptAttack();
  let nextAttackUid = 1;
  const inRange = (h: number): boolean => h >= 0 && h < MAX_HANDS;
  const inMap = (x: number, y: number): boolean => mapX <= 0 || (x >= 1 && x <= mapX && y >= 1 && y <= mapY);
  const setup = (): AiSetup | null => (inRange(hand) ? setups[hand] : null);

  for (const { cmd, params: p, textParam } of commands) {
    switch (cmd) {
      case '!SET_CURR_PLAYER':
        hand = inRange(p[0]) ? p[0] : -1;
        break;
      case '!SET_AI_START_POSITION':
        if (setup() !== null && inMap(p[0] + 1, p[1] + 1)) (setup() as AiSetup).startPosition = kmPoint(p[0] + 1, p[1] + 1);
        break;
      case '!CENTER_SCREEN':
        if (setup() !== null && inMap(p[0] + 1, p[1] + 1)) (setup() as AiSetup).centerScreen = kmPoint(p[0] + 1, p[1] + 1);
        break;
      case '!SET_AI_ARMY_TYPE':
        if (setup() !== null && p[0] >= 0 && p[0] <= 1) (setup() as AiSetup).armyType = p[0];
        break;
      case '!SET_AI_NO_BUILD':
        if (setup() !== null) (setup() as AiSetup).noBuild = true;
        break;
      case '!SET_AI_AUTO_REPAIR':
        if (setup() !== null) (setup() as AiSetup).isRepairAlways = true;
        break;
      case '!SET_AI_AUTO_ATTACK':
        if (setup() !== null) (setup() as AiSetup).autoAttack = true;
        break;
      case '!SET_AI_UNLIMITED_EQUIP':
        if (setup() !== null) (setup() as AiSetup).unlimitedEquip = true;
        break;
      case '!SET_AI_AUTO_DEFEND':
        if (setup() !== null) (setup() as AiSetup).autoDefend = true;
        break;
      case '!SET_AI_DEFENSE': {
        // KM_MissionScript_Standard.pas 760–762: P[2] = dir−1, P[3] = group type index (0..3).
        const s = setup();
        if (s !== null && inMap(p[0] + 1, p[1] + 1) && p[3] >= 0 && p[3] <= 3) {
          s.defencePositions.push({
            pos: kmPoint(p[0] + 1, p[1] + 1),
            dir: p[2] + 1,
            groupType: p[3],
            radius: p[4],
            backLine: p[5] === 1,
          });
        }
        break;
      }
      case '!SET_AI_ATTACK': {
        // KM_MissionScript_Standard.pas 771–793: the parameter names are the Pascal's AI_ATTACK_PARAMS.
        const name = textParam;
        if (name === 'TYPE' && p[1] >= 0 && p[1] <= 2) pending.repeating = p[1] !== 1; // RemakeAttackType
        else if (name === 'TOTAL_AMOUNT') pending.totalMen = p[1];
        else if (name === 'COUNTER') pending.delay = p[1];
        else if (name === 'RANGE') pending.range = p[1];
        else if (name === 'TROUP_AMOUNT' && p[1] >= 0 && p[1] <= 3) pending.groupAmounts[p[1]] = p[2];
        else if (name === 'TARGET') pending.target = p[1];
        else if (name === 'POSITION') pending.customPosition = kmPoint(p[1] + 1, p[2] + 1);
        else if (name === 'TAKEALL') pending.randomGroups = true;
        break;
      }
      case '!COPY_AI_ATTACK': {
        const s = setup();
        if (s !== null) s.attacks.push({ ...pending, groupAmounts: pending.groupAmounts.slice(), uid: nextAttackUid++, hasOccured: false });
        break;
      }
      case '!CLEAR_AI_ATTACK':
        pending = blankScriptAttack();
        break;
      case '!SET_AI_CHARACTER': {
        const s = setup();
        if (s === null) break;
        // The name is the command's first parameter; the tokenizer keeps it in textParam when it
        // is not a number (KM_MissionScript_Standard.pas 305–306).
        const name = textParam;
        if (name === 'EQUIP_RATE_IRON' && p[1] >= 0) s.equipRateIron = p[1];
        else if (name === 'EQUIP_RATE_LEATHER' && p[1] >= 0) s.equipRateLeather = p[1];
        else if (name === 'EQUIP_RATE' && p[1] >= 0) {
          s.equipRateIron = p[1];
          s.equipRateLeather = p[1];
        } else if (name === 'MAX_SOLDIER' && p[1] >= -1) s.maxSoldiers = p[1];
        else if (name === 'CONSTRUCTORS' && p[1] >= 0) s.workerCount = p[1];
        else if (name === 'RECRUTS' && p[1] >= 0) s.recruitDelay = p[1];
        else if (name === 'RECRUT_COUNT' && p[1] >= 0) s.recruitCount = p[1];
        else if (name === 'WORKER_FACTOR' && p[1] >= 0) s.workerCount = p[1];
        else if (name === 'TOWN_DEFENSE' && p[1] >= 0) s.townDefence = p[1];
        else if (name === 'ATTACK_FACTOR' && p[1] >= 0) s.aggressiveness = p[1];
        else if (name === 'AUTO_ATTACK_RANGE' && p[1] >= 0) s.autoAttackRange = p[1];
        else if (name === 'TROUP_PARAM' && p[1] >= 0 && p[1] <= 3) s.troopFormations[p[1]] = { numUnits: p[2], unitsPerRow: p[3] };
        break;
      }
      default:
        break;
    }
  }

  // EnableAdvancedAI (KM_AISetup.pas 156–161): NewAI = True and AutoAttackRange := 0.
  for (let h = 0; h < MAX_HANDS; h++) {
    if (info.advancedAI[h] === true) {
      setups[h].newAI = true;
      setups[h].autoAttackRange = 0;
    }
    if (setups[h].noBuild) setups[h].autoBuild = false;
  }
  return setups;
}

// ---------------------------------------------------------------------------------------------
// Influences-lite (KM_AIInfluences.pas; docs/M5-AI-NOTES.md §2)

/**
 * The v0 influences: AvoidBuilding (the full per-tile byte array the planner/builder read) and
 * the city ownership (per hand, per tile). Military presence is not modelled (worker N).
 */
export class Influences {
  readonly avoidBuilding: Uint8Array;
  readonly ownership: Uint8Array[]; // per hand: mapX*mapY stride
  private readonly world: EconomyWorld;
  private readonly mapX: number;
  private readonly mapY: number;
  private updateCityIdx = 0;

  constructor(world: EconomyWorld) {
    this.world = world;
    this.mapX = world.mapX;
    this.mapY = world.mapY;
    const size = (this.mapX + 1) * (this.mapY + 1);
    this.avoidBuilding = new Uint8Array(size);
    this.ownership = [];
    for (let h = 0; h < world.handCount; h++) this.ownership.push(new Uint8Array(size));
  }

  private index(x: number, y: number): number {
    return y * (this.mapX + 1) + x;
  }

  getAvoid(x: number, y: number): number {
    if (x < 1 || x > this.mapX - 1 || y < 1 || y > this.mapY - 1) return 0;
    return this.avoidBuilding[this.index(x, y)];
  }

  setAvoid(x: number, y: number, value: number): void {
    if (x < 1 || x > this.mapX - 1 || y < 1 || y > this.mapY - 1) return;
    this.avoidBuilding[this.index(x, y)] = value;
  }

  /** AddAvoidBuilding (KM_AIInfluences.pas 234–246): a circle of 255 (protects reservations). */
  addAvoidBuilding(x: number, y: number, radius: number): void {
    if (radius === 0) return;
    const rad = Math.ceil(radius);
    for (let ty = Math.max(y - rad, 1); ty <= Math.min(y + rad, this.mapY - 1); ty++) {
      for (let tx = Math.max(x - rad, 1); tx <= Math.min(x + rad, this.mapX - 1); tx++) {
        const cur = this.avoidBuilding[this.index(tx, ty)];
        if ((cur === 0 || cur >= AVOID_BUILDING_FOREST_MINIMUM) && (x - tx) * (x - tx) + (y - ty) * (y - ty) <= radius * radius) {
          this.avoidBuilding[this.index(tx, ty)] = 255;
        }
      }
    }
  }

  /** RemAvoidBuilding (249–257): clears the AVOID_BUILDING_COAL_TILE markers of a rect. */
  remAvoidBuilding(left: number, top: number, right: number, bottom: number): void {
    for (let ty = Math.max(top, 1); ty <= Math.min(bottom, this.mapY - 1); ty++) {
      for (let tx = Math.max(left, 1); tx <= Math.min(right, this.mapX - 1); tx++) {
        if (this.avoidBuilding[this.index(tx, ty)] === AVOID_BUILDING_COAL_TILE) this.avoidBuilding[this.index(tx, ty)] = 0;
      }
    }
  }

  /** MarkForest (260–290): the radial forest reservation ramp (254 max, 54 minimum). */
  markForest(p: Pt, radius: number, decreaseCoef: number, onlyUnmarkedArea = false): void {
    if (radius === 0) return;
    const sqrMax = radius * radius;
    const rad = Math.ceil(radius);
    for (let ty = Math.max(p.y - rad, 1); ty <= Math.min(p.y + rad, this.mapY - 1); ty++) {
      for (let tx = Math.max(p.x - rad, 1); tx <= Math.min(p.x + rad, this.mapX - 1); tx++) {
        const at = this.index(tx, ty);
        const cur = this.avoidBuilding[at];
        if (!(cur === 0 || cur >= AVOID_BUILDING_FOREST_MINIMUM)) continue;
        const sqrDist = (p.x - tx) * (p.x - tx) + (p.y - ty) * (p.y - ty);
        if (sqrDist > sqrMax) continue;
        if (!onlyUnmarkedArea) {
          this.avoidBuilding[at] = Math.min(254, Math.max(AVOID_BUILDING_FOREST_MINIMUM, cur + 254 - round(sqrDist * decreaseCoef)));
        } else if (cur === 0) {
          this.avoidBuilding[at] = Math.min(254, Math.max(AVOID_BUILDING_FOREST_MINIMUM, 254 - round(sqrDist * decreaseCoef)));
        }
      }
    }
  }

  /** InitAvoidBuilding (294–339): coal tiles, mine arenas, the space below every store. */
  initAvoidBuilding(): void {
    this.avoidBuilding.fill(0);
    // Coal fields first (must be before the mine arenas).
    for (let y = 1; y <= this.mapY - 1; y++) {
      for (let x = 1; x <= this.mapX - 1; x++) {
        if (this.world.tileIsCoal(x, y) > 1) this.avoidBuilding[this.index(x, y)] = AVOID_BUILDING_COAL_TILE;
      }
    }
    // Gold/iron mine arenas.
    for (let y = 3; y <= this.mapY - 2; y++) {
      for (let x = 2; x <= this.mapX - 2; x++) {
        const ironOk = this.world.tileGoodForIronMine(x, y);
        const goldOk = !ironOk && this.world.tileGoodForGoldMine(x, y);
        if (!ironOk && !goldOk) continue;
        const ore = (px: number, py: number): boolean => (ironOk ? this.world.tileIsIron(px, py) > 1 : this.world.tileIsGold(px, py) > 1);
        let found = false;
        for (let py = Math.max(1, y - 3); py <= Math.min(this.mapY - 1, y - 1) && !found; py++) {
          for (let px = Math.max(1, x - 1); px <= Math.min(this.mapX - 1, x + 1); px++) {
            if (ore(px, py)) {
              for (let y2 = y; y2 <= Math.min(this.mapY - 1, y + 1); y2++) {
                for (let x2 = Math.max(1, x - 2); x2 <= Math.min(this.mapX - 1, x + 1 + (ironOk ? 1 : 0)); x2++) {
                  this.avoidBuilding[this.index(x2, y2)] = AVOID_BUILDING_MINE_TILE;
                }
              }
              found = true;
              break;
            }
          }
        }
      }
    }
    // Leave the space below all stores free (331–338).
    for (let h = 0; h < this.world.handCount; h++) {
      for (const house of this.world.houses) {
        if (house.owner !== h || house.typeId !== HT_STORE || house.destroyed) continue;
        for (let y = Math.max(house.entrance.y + 1, 1); y <= Math.min(house.entrance.y + 2, this.mapY - 1); y++) {
          for (let x = Math.max(house.entrance.x - 1, 1); x <= Math.min(house.entrance.x + 1, this.mapX - 1); x++) {
            this.avoidBuilding[this.index(x, y)] = AVOID_BUILDING_HOUSE_ENTRANCE;
          }
        }
      }
    }
  }

  // ---- ownership -------------------------------------------------------------------------

  /** UpdateOwnership (638–670) over tiles: flood from the house entrances, 255 − distance·2. */
  updateOwnership(hand: number): void {
    const own = this.ownership[hand];
    if (own === undefined) return;
    own.fill(0);
    const starts: number[] = [];
    for (const house of this.world.houses) {
      if (house.owner !== hand || house.destroyed) continue;
      if (house.typeId === HT_WATCHTOWER || house.typeId === HT_WOODCUTTERS) continue;
      const p = { x: house.entrance.x, y: house.entrance.y + 1 };
      if (!this.world.tileInMapCoords(p.x, p.y)) continue;
      starts.push(this.index(p.x, p.y));
    }
    if (starts.length === 0) return;
    // HouseInfluence flood (KM_NavMeshInfluences.pas 177–186): max(0, 255 − distance·2), max 150.
    // v0 tiles stand in for navmesh polygons; to keep the game's reach (polygon centres are ~3
    // tiles apart, so the game's 150-distance flood covers ~40 tiles) each tile step costs
    // 10/3 ≈ 3 (ortho) and 14/3 ≈ 5 (diag) — documented simplification.
    const STEP_ORTHO = 3;
    const STEP_DIAG = 5;
    const dist = new Uint16Array(own.length).fill(65535);
    const queue: number[] = [];
    for (const s of starts) {
      if (dist[s] === 0) continue;
      dist[s] = 0;
      own[s] = 255;
      queue.push(s);
    }
    let head = 0;
    const stride = this.mapX + 1;
    while (head < queue.length) {
      const cur = queue[head++];
      const cd = dist[cur];
      if (cd >= 150) continue;
      const cx = cur % stride;
      const cy = Math.floor(cur / stride);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = cx + dx;
          const ny = cy + dy;
          if (!this.world.tileInMapCoords(nx, ny)) continue;
          const ni = this.index(nx, ny);
          const step = dx !== 0 && dy !== 0 ? STEP_DIAG : STEP_ORTHO;
          if (cd + step >= dist[ni]) continue;
          dist[ni] = cd + step;
          own[ni] = Math.max(0, 255 - (cd + step) * 2);
          queue.push(ni);
        }
      }
    }
  }

  /** UpdateState (714–748): city ownership every 150 ticks (offset 15), one hand at a time. */
  updateState(tick: number): void {
    if (tick % 150 !== 15) return;
    this.updateCityIdx = (this.updateCityIdx + 1) % this.world.handCount;
    this.updateOwnership(this.updateCityIdx);
  }

  /** GetOwnership (460–463). */
  getOwnership(hand: number, x: number, y: number): number {
    const own = this.ownership[hand];
    if (own === undefined || x < 0 || x > this.mapX || y < 0 || y > this.mapY) return 0;
    return own[this.index(x, y)];
  }

  /** GetBestOwner (496–518): the hand with the highest ownership (HAND_NONE = −1 when none). */
  getBestOwner(x: number, y: number): number {
    let best = 0;
    let owner = -1;
    for (let h = 0; h < this.world.handCount; h++) {
      const v = this.getOwnership(h, x, y);
      if (v > best) {
        best = v;
        owner = h;
      }
    }
    return owner;
  }

  /** GetBestAllianceOwnership (575–592): the highest ownership among the hands whose alliance to
   *  `hand` is unchanged by `alliance` (atAlly = the hands allied with it, atEnemy = its enemies). */
  getBestAllianceOwnership(hand: number, x: number, y: number, alliance: 'ally' | 'enemy'): number {
    let result = 0;
    for (let h = 0; h < this.world.handCount; h++) {
      if (h === hand) continue;
      if (this.world.allianceOf(hand, h) !== alliance) continue;
      const v = this.getOwnership(h, x, y);
      if (v > result) result = v;
    }
    return result;
  }

  /** GetBestAllianceOwner (521–539) for atEnemy. */
  getBestAllianceOwner(hand: number, p: Pt, _alliance: 'ally' | 'enemy'): number {
    let best = 0;
    let owner = -1;
    for (let h = 0; h < this.world.handCount; h++) {
      if (h === hand) continue;
      const v = this.getOwnership(h, p.x, p.y);
      if (v > best) {
        best = v;
        owner = h;
      }
    }
    return owner;
  }

  /** GetOtherOwnerships (595–619): the summed ownership of the other hands (enemy ×2). */
  getOtherOwnerships(hand: number, x: number, y: number): number {
    let result = 0;
    for (let h = 0; h < this.world.handCount; h++) {
      if (h === hand) continue;
      result += this.getOwnership(h, x, y) * 2;
    }
    return result;
  }

  /** CanPlaceHouseByInfluence (622–634), aIgnoreAllies = false: own or allied ownership. */
  canPlaceHouseByInfluence(hand: number, x: number, y: number, ignoreAllies = false): boolean {
    const best = this.getBestOwner(x, y);
    return best >= 0 && this.getOwnership(hand, x, y) > 0 && (best === hand || (!ignoreAllies && true));
  }
}

// === END OF PART 1 ===

// ---------------------------------------------------------------------------------------------
// House mapping (KM_Eye.pas InitHousesMapping 630–755)

/** THouseMapping (KM_Eye.pas 24–29). `surroundings[dist][dir]` with dist 1..MAX_SCAN_DIST. */
export interface HouseMapping {
  tiles: Pt[]; // vectors from the entrance to each house-plan tile
  surroundings: Pt[][][]; // [dist][TDirection][i] — vectors from the entrance
  moveToEntrance: Pt[]; // [TDirection] — how to move an entrance for each direction
}

/** InitHousesMapping (KM_Eye.pas 630–755) for every script id (0..29). */
export function buildHousesMapping(specs: (HouseSpec | undefined)[]): HouseMapping[] {
  const MAX = MAX_SCAN_DIST_FROM_HOUSE;
  const OFF = MAX; // POMArr is [1-MAX .. 4+MAX]
  const SIZE = 4 + MAX - (1 - MAX) + 1;
  const out: HouseMapping[] = [];

  for (let typeId = 0; typeId < 30; typeId++) {
    const spec = specs[typeId];
    const enterOff = spec !== undefined ? spec.entranceDx : 0;
    const pom = new Uint8Array(SIZE * SIZE).fill(255);
    const pomAt = (x: number, y: number): number => pom[(y + OFF) * SIZE + (x + OFF)];
    const pomSet = (x: number, y: number, v: number): void => {
      pom[(y + OFF) * SIZE + (x + OFF)] = v;
    };

    // Find the house plan shape and save it into POMArr.
    const area = housePlan(typeId);
    for (let y = 1; y <= 4; y++) {
      for (let x = 1; x <= 4; x++) {
        if (area[y - 1][x - 1] !== 0) pomSet(x, y, 0);
      }
    }

    // Vectors from the entrance to each house-plan tile.
    const tiles: Pt[] = [];
    for (let y = 1; y <= 4; y++) {
      for (let x = 1; x <= 4; x++) {
        if (pomAt(x, y) === 0) tiles.push(kmPoint(x - 3 - enterOff, y - 4));
      }
    }

    // Around-the-plan layers of increasing distance.
    for (let i = 1; i <= MAX; i++) {
      const actual = i - 1;
      for (let y = 1 - actual; y <= 4 + actual; y++) {
        for (let x = 1 - actual; x <= 4 + actual; x++) {
          if (pomAt(x, y) !== actual) continue;
          for (let ay = -1; ay <= 1; ay++) {
            for (let ax = -1; ax <= 1; ax++) {
              if (pomAt(x + ax, y + ay) > i) pomSet(x + ax, y + ay, i);
            }
          }
        }
      }
    }

    // Plan size.
    const idx: number[] = [0, 0, 0, 0];
    idx[DIR_N] = 3 - (pomAt(2, 2) === 0 ? 1 : 0) - (pomAt(1, 2) === 0 ? 1 : 0);
    idx[DIR_S] = 4;
    idx[DIR_W] = 2 - (pomAt(4, 1) === 0 ? 1 : 0);
    idx[DIR_E] = 3 + (pomAt(4, 4) === 0 ? 1 : 0);

    // The entrance column (the '2' cell of the plan's bottom row).
    let entranceX = 1;
    for (let x = 1; x <= 4; x++) {
      if (area[3][x - 1] === 2) {
        entranceX = x;
        break;
      }
    }
    const moveToEntrance: Pt[] = [kmPoint(0, 0), kmPoint(0, 0), kmPoint(0, 0), kmPoint(0, 0)];
    moveToEntrance[DIR_N] = kmPoint(0, 0);
    moveToEntrance[DIR_S] = kmPoint(0, 4 - idx[DIR_N]);
    moveToEntrance[DIR_W] = kmPoint(entranceX - idx[DIR_E], 0);
    moveToEntrance[DIR_E] = kmPoint(entranceX - idx[DIR_W], 0);

    // Fill the surroundings layers (a counting pass, then the fill pass — as the Pascal does).
    const surroundings: Pt[][][] = [];
    for (let d = 0; d <= MAX; d++) surroundings.push([[], [], [], []]);
    for (let i = 1; i <= MAX; i++) {
      const counts = [0, 0, 0, 0];
      searchAndFill(i, false, counts, null);
      for (let d = 0; d < 4; d++) surroundings[i][d] = new Array<Pt>(counts[d]);
      searchAndFill(i, true, counts, surroundings[i]);
    }

    out.push({ tiles, surroundings, moveToEntrance });

    function searchAndFill(aIdx: number, aFill: boolean, counts: number[], dest: Pt[][] | null): void {
      counts[0] = 0;
      counts[1] = 0;
      counts[2] = 0;
      counts[3] = 0;
      for (let y = 1 - aIdx; y <= 4 + aIdx; y++) {
        for (let x = 1 - aIdx; x <= 4 + aIdx; x++) {
          if (pomAt(x, y) !== aIdx) continue;
          let pointAdded = false;
          const v = kmPoint(x - 3 - enterOff, y - 4);
          if (x === idx[DIR_W] - aIdx) {
            pointAdded = true;
            if (aFill && dest !== null) dest[DIR_W][counts[DIR_W]] = v;
            counts[DIR_W] += 1;
          } else if (x === idx[DIR_E] + aIdx) {
            pointAdded = true;
            if (aFill && dest !== null) dest[DIR_E][counts[DIR_E]] = v;
            counts[DIR_E] += 1;
          }
          if (y === idx[DIR_S] + aIdx) {
            if (aFill && dest !== null) dest[DIR_S][counts[DIR_S]] = v;
            counts[DIR_S] += 1;
          } else if (!pointAdded || y === idx[DIR_N] - aIdx) {
            if (aFill && dest !== null) dest[DIR_N][counts[DIR_N]] = v;
            counts[DIR_N] += 1;
          }
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// TKMBuildFF (KM_Eye.pas 1292–1840)

/** TKMHouseRequirements (KM_Eye.pas 41–46). */
export interface HouseRequirements {
  houseType: number;
  ignoreTrees: boolean;
  ignoreAvoidBuilding: boolean;
  maxCnt: number;
  maxDist: number;
}

/**
 * TKMBuildFF: the terrain flood fill (bsBuild/bsRoad/bsTree/… states) + the house flood fill that
 * produces the candidate locations (`locs`). One instance lives in the shared Eye.
 */
export class BuildFF {
  owner = 0;
  readonly visited: Uint8Array;
  readonly visitedHouse: Uint8Array;
  readonly state: Uint8Array;
  readonly next: Int32Array;
  readonly distance: Uint16Array;
  readonly distanceInitPoint: Uint16Array;
  visitIdx = 255;
  visitIdxHouse = 255;
  locs: Pt[] = [];
  houseReq: HouseRequirements = { houseType: 0, ignoreTrees: false, ignoreAvoidBuilding: false, maxCnt: 0, maxDist: 0 };
  updateTick = 0;
  private readonly world: EconomyWorld;
  private readonly influences: Influences;
  private readonly mapping: HouseMapping[];
  private readonly mapX: number;
  private readonly mapY: number;
  private queue: number[] = [];
  private queueHead = 0;
  private currentTick = 0;
  private initLocsFn: () => Pt[] = () => [];

  constructor(world: EconomyWorld, influences: Influences, mapping: HouseMapping[]) {
    this.world = world;
    this.influences = influences;
    this.mapping = mapping;
    this.mapX = world.mapX;
    this.mapY = world.mapY;
    const size = (this.mapX + 1) * (this.mapY + 1);
    this.visited = new Uint8Array(size);
    this.visitedHouse = new Uint8Array(size);
    this.state = new Uint8Array(size);
    this.next = new Int32Array(size);
    this.distance = new Uint16Array(size);
    this.distanceInitPoint = new Uint16Array(size);
  }

  private index(x: number, y: number): number {
    return y * (this.mapX + 1) + x;
  }

  /** The init points of the terrain flood: the planner's planned houses (KM_Eye.pas 1781–1797). */
  setInitLocsProvider(fn: () => Pt[]): void {
    this.initLocsFn = fn;
  }

  /** The current game tick (gGameParams.Tick): the AI sets it before its update slice. */
  setTick(tick: number): void {
    this.currentTick = tick;
  }

  ownerUpdate(hand: number): void {
    this.owner = hand;
    this.updateTick = 0; // rescan on the next update
  }

  // ---- queue -------------------------------------------------------------------------------

  private initQueue(houseFF: boolean): void {
    if (houseFF) {
      if (this.visitIdxHouse >= 254) {
        this.visitIdxHouse = 0;
        this.visitedHouse.fill(0);
      }
      this.visitIdxHouse += 1;
    } else {
      if (this.visitIdx >= 254) {
        this.visitIdx = 0;
        this.visited.fill(0);
      }
      this.visitIdx += 1;
    }
  }

  private insertInQueue(idx: number): number {
    this.queue.push(idx);
    return idx;
  }

  private removeFromQueue(): number {
    if (this.queueHead >= this.queue.length) {
      this.queue = [];
      this.queueHead = 0;
      return -1;
    }
    const idx = this.queue[this.queueHead];
    this.queueHead += 1;
    return idx;
  }

  // ---- state accessors ---------------------------------------------------------------------

  getState(x: number, y: number): number {
    if (x < 1 || x > this.mapX - 1 || y < 1 || y > this.mapY - 1) return BS_NO_BUILD;
    const at = this.index(x, y);
    return this.visited[at] === this.visitIdx ? this.state[at] : BS_NO_BUILD;
  }

  setState(x: number, y: number, value: number): void {
    if (x < 1 || x > this.mapX - 1 || y < 1 || y > this.mapY - 1) return;
    this.state[this.index(x, y)] = value;
  }

  getDistance(p: Pt): number {
    const at = this.index(p.x, p.y);
    return this.visited[at] === this.visitIdx ? this.distance[at] : 50;
  }

  getDistanceInitPoint(p: Pt): number {
    const at = this.index(p.x, p.y);
    return this.visited[at] === this.visitIdx ? this.distanceInitPoint[at] : 50;
  }

  // ---- flood fill --------------------------------------------------------------------------

  private canBeVisited(x: number, y: number, idx: number, houseQueue: boolean): boolean {
    if (houseQueue) {
      return (
        this.visited[idx] === this.visitIdx &&
        this.visitedHouse[idx] < this.visitIdxHouse &&
        this.influences.getOwnership(this.owner, x, y) > 0 // tpOwn = the owner's influence area
      );
    }
    return this.visited[idx] < this.visitIdx && this.world.tileIsRoadable(x, y);
  }

  private markAsVisitedTerrain(_y: number, idx: number, dist: number, state: number): void {
    this.visited[idx] = this.visitIdx;
    this.state[idx] = state;
    this.distance[idx] = dist;
  }

  private markAsVisitedHouse(x: number, y: number, idx: number, dist: number): void {
    this.visitedHouse[idx] = this.visitIdxHouse;
    this.distanceInitPoint[idx] = dist;
    if (this.canBePlacedHouse({ x, y })) this.locs.push({ x, y });
  }

  /** GetTerrainState (KM_Eye.pas 1610–1659). */
  private getTerrainState(x: number, y: number): number {
    let output: number;
    if (this.world.tileBuildable(x, y)) output = BS_BUILD;
    else if (this.world.treeAt(x, y) !== null && this.world.canAddFieldPlan(this.owner, x, y, 'wine')) output = BS_TREE;
    else if (this.world.tileMakeRoads(x, y) || this.world.tileWalkableRoad(x, y)) output = BS_ROAD;
    else if (this.world.tileLockAt(x, y) === 3) output = BS_ROAD_PLAN; // tlRoadWork
    else return BS_NO_BUILD;

    const ab = this.influences.getAvoid(x, y);
    if (ab === AVOID_BUILDING_NODE_LOCK_FIELD) output = BS_FIELD_PLAN;
    else if (ab === AVOID_BUILDING_NODE_LOCK_ROAD) output = BS_ROAD_PLAN;
    else if (ab === AVOID_BUILDING_HOUSE_INSIDE_LOCK) output = BS_RESERVED;
    else if (ab === AVOID_BUILDING_HOUSE_OUTSIDE_LOCK) {
      if (output === BS_BUILD) output = BS_ROAD;
    } else if (ab === AVOID_BUILDING_HOUSE_ENTRANCE) output = BS_ROAD;
    else if (ab === AVOID_BUILDING_MINE_TILE) output = BS_MINE;
    else if (ab === AVOID_BUILDING_COAL_TILE) {
      if (output === BS_TREE) output = BS_NO_BUILD;
      else if (output === BS_BUILD) output = BS_COAL;
    } else if (ab > AVOID_BUILDING_FOREST_MINIMUM && output !== BS_TREE) output = BS_FOREST;
    return output;
  }

  /** TerrainFF (1713–1728): the 4-direction BFS over roadable tiles. */
  private terrainFF(maxDistance: number): void {
    for (;;) {
      const idx = this.removeFromQueue();
      if (idx < 0) break;
      const dist = this.distance[idx] + 1;
      if (dist > maxDistance) break;
      const y = Math.floor(idx / (this.mapX + 1));
      const x = idx - y * (this.mapX + 1);
      if (y - 1 >= 1 && this.canBeVisited(x, y - 1, idx - (this.mapX + 1), false)) {
        this.markAsVisitedTerrain(y - 1, this.insertInQueue(idx - (this.mapX + 1)), dist, this.getTerrainState(x, y - 1));
      }
      if (x - 1 >= 1 && this.canBeVisited(x - 1, y, idx - 1, false)) {
        this.markAsVisitedTerrain(y, this.insertInQueue(idx - 1), dist, this.getTerrainState(x - 1, y));
      }
      if (x + 1 <= this.mapX - 1 && this.canBeVisited(x + 1, y, idx + 1, false)) {
        this.markAsVisitedTerrain(y, this.insertInQueue(idx + 1), dist, this.getTerrainState(x + 1, y));
      }
      if (y + 1 <= this.mapY - 1 && this.canBeVisited(x, y + 1, idx + (this.mapX + 1), false)) {
        this.markAsVisitedTerrain(y + 1, this.insertInQueue(idx + (this.mapX + 1)), dist, this.getTerrainState(x, y + 1));
      }
    }
  }

  /** HouseFF (1731–1750): the house-location BFS from the init points. */
  private houseFF(): void {
    const MAX_DIST = 40 - 10;
    for (;;) {
      const idx = this.removeFromQueue();
      if (idx < 0) break;
      const dist = this.distanceInitPoint[idx] + 1;
      if (dist > MAX_DIST || this.houseReq.maxCnt <= this.locs.length || dist > this.houseReq.maxDist) break;
      const y = Math.floor(idx / (this.mapX + 1));
      const x = idx - y * (this.mapX + 1);
      if (y - 1 >= 1 && this.canBeVisited(x, y - 1, idx - (this.mapX + 1), true)) {
        this.markAsVisitedHouse(x, y - 1, this.insertInQueue(idx - (this.mapX + 1)), dist);
      }
      if (x - 1 >= 1 && this.canBeVisited(x - 1, y, idx - 1, true)) {
        this.markAsVisitedHouse(x - 1, y, this.insertInQueue(idx - 1), dist);
      }
      if (x + 1 <= this.mapX - 1 && this.canBeVisited(x + 1, y, idx + 1, true)) {
        this.markAsVisitedHouse(x + 1, y, this.insertInQueue(idx + 1), dist);
      }
      if (y + 1 <= this.mapY - 1 && this.canBeVisited(x, y + 1, idx + (this.mapX + 1), true)) {
        this.markAsVisitedHouse(x, y + 1, this.insertInQueue(idx + (this.mapX + 1)), dist);
      }
    }
  }

  /** MarkPlans (1662–1710): allied house plans and field plans into the state array. */
  private markPlans(): void {
    const DIST = 1;
    for (let pl = 0; pl < this.world.handCount; pl++) {
      const state = this.world.constructionState(pl);
      for (const plan of state.plans) {
        if (plan.typeId === HOUSE_TYPE_NONE) continue; // htNone
        const p1 = kmPoint(plan.x + this.entranceOffset(plan.typeId), plan.y);
        const map = this.mapping[plan.typeId];
        if (map === undefined) continue;
        for (const off of map.tiles) {
          const p2 = kmPoint(p1.x + off.x, p1.y + off.y);
          this.setState(p2.x, p2.y, BS_HOUSE_PLAN);
        }
        for (let dir = 0; dir < 4; dir++) {
          for (const off of map.surroundings[DIST][dir]) {
            const p2 = kmPoint(p1.x + off.x, p1.y + off.y);
            if (this.world.tileMakeRoads(p2.x, p2.y) || this.world.tileWalkableRoad(p2.x, p2.y)) this.setState(p2.x, p2.y, BS_ROAD);
            else if (this.getState(p2.x, p2.y) !== BS_NO_BUILD) this.setState(p2.x, p2.y, BS_HOUSE_PLAN);
          }
        }
      }
      for (const field of state.fields) {
        if (field.status === 'empty') continue;
        if (field.fieldType === 'road') this.setState(field.x, field.y, BS_ROAD_PLAN);
        else this.setState(field.x, field.y, BS_FIELD_PLAN);
      }
    }
  }

  private entranceOffset(typeId: number): number {
    const spec = this.world.houseSpecOf(typeId);
    return spec !== undefined ? spec.entranceDx : 0;
  }

  /** UpdateState (1763–1803): one terrain scan per tick; init points from houses or the planner. */
  updateState(tick = this.currentTick): void {
    if (!(this.updateTick === 0 || this.updateTick < tick)) return;
    this.currentTick = tick;
    this.initQueue(false);
    if (tick <= MAX_HANDS) {
      // Make sure that the Planner is updated, otherwise take only the available houses.
      for (const h of this.world.houses) {
        if (h.owner !== this.owner || h.destroyed) continue;
        if (h.typeId === HT_WATCHTOWER || h.typeId === HT_WOODCUTTERS) continue;
        this.markHouse({ x: h.entrance.x, y: h.entrance.y });
      }
    } else {
      for (const p of this.initLocsFn()) this.markHouse(p);
    }
    this.terrainFF(40);
    this.updateTick = tick;
    this.markPlans();
  }

  private markHouse(loc: Pt): void {
    const at = this.index(loc.x, loc.y);
    this.markAsVisitedTerrain(loc.y, this.insertInQueue(at), 0, this.getTerrainState(loc.x, loc.y));
  }

  /** ActualizeTile (1813–1817): refresh one tile while the current scan is alive. */
  actualizeTile(x: number, y: number): void {
    if (this.updateTick === this.currentTick) this.setState(x, y, this.getTerrainState(x, y));
  }

  /** CanBePlacedHouse (1541–1607): the house-plan tile + distance-1 side checks on the state FF. */
  canBePlacedHouse(loc: Pt): boolean {
    const DIST = 1;
    const map = this.mapping[this.houseReq.houseType];
    if (map === undefined) return false;
    let coalUnderPlan = false;
    for (const off of map.tiles) {
      const p = kmPoint(loc.x + off.x, loc.y + off.y);
      if (p.y < 2 || p.x < 2 || p.x > this.mapX - 2 || p.y > this.mapY - 2) return false;
      const st = this.getState(p.x, p.y);
      if (st === BS_DEBUG || st === BS_BUILD) continue;
      else if (st === BS_TREE) {
        if (!this.houseReq.ignoreTrees) return false;
      } else if (st === BS_COAL) {
        coalUnderPlan = true;
        if (!this.houseReq.ignoreAvoidBuilding) return false;
      } else if (st === BS_FOREST) {
        if (!this.houseReq.ignoreAvoidBuilding) return false;
      } else return false;
    }
    if (this.houseReq.houseType === HT_COAL_MINE && !coalUnderPlan) return false;
    let leftSideFree = true;
    let rightSideFree = true;
    for (let dir = 0; dir < 4; dir++) {
      const list = map.surroundings[DIST][dir];
      const from = dir === DIR_S ? 1 : 0;
      const to = dir === DIR_S ? list.length - 1 : list.length;
      for (let k = from; k < to; k++) {
        const p = kmPoint(loc.x + list[k].x, loc.y + list[k].y);
        const st = this.getState(p.x, p.y);
        if (this.houseReq.ignoreAvoidBuilding && (st === BS_RESERVED || st === BS_HOUSE_PLAN)) return false;
        // (Dir = dirS) and State in [bsNoBuild, bsHousePlan] and ((K < 2) or (K > 3) or
        // State <> bsFieldPlan): the third term is redundant for states 0/1 (bsFieldPlan is 2).
        if (dir === DIR_S && (st === BS_NO_BUILD || st === BS_HOUSE_PLAN)) return false;
        if (dir === DIR_E) rightSideFree = rightSideFree && !(st === BS_NO_BUILD || st === BS_HOUSE_PLAN);
        if (dir === DIR_W) leftSideFree = leftSideFree && !(st === BS_NO_BUILD || st === BS_HOUSE_PLAN);
        if (!(leftSideFree || rightSideFree)) return false;
      }
    }
    return true;
  }

  /** FindPlaceForHouse (1820–1839). */
  findPlaceForHouse(req: HouseRequirements, initPoints: Pt[], clearHouseList = true): void {
    if (clearHouseList) this.locs = [];
    if (initPoints.length === 0) return;
    this.houseReq = req;
    this.updateState(this.currentTick);
    this.initQueue(true);
    for (const p of initPoints) {
      const at = this.index(p.x, p.y);
      if (this.canBeVisited(p.x, p.y, at, true)) {
        this.visitedHouse[at] = this.visitIdxHouse;
        this.distanceInitPoint[at] = 0;
        this.insertInQueue(at);
      }
    }
    this.houseFF();
  }
}

// ---------------------------------------------------------------------------------------------
// TKMFFInitPlace (KM_Eye.pas 1842–1926) — the routes flood used by Eye.ScanLoc

/** FillArea (1905–1926): spread INIT_VALUE 255 by 15 per step, keeping the max in `routes`. */
export function fillInitArea(routes: Uint8Array, mapX: number, mapY: number, initPoints: Pt[]): void {
  const INIT_VALUE = 255;
  const DEC_COEF = 15;
  const stride = mapX + 1;
  const visited = new Uint8Array((mapX + 1) * (mapY + 1));
  const queue: { x: number; y: number; d: number }[] = [];
  const canVisit = (x: number, y: number, d: number): boolean => {
    if (x < 0 || x > mapX || y < 0 || y > mapY) return false;
    const at = y * stride + x;
    return visited[at] === 0 && routes[at] < d;
  };
  const insert = (x: number, y: number, d: number): void => {
    const at = y * stride + x;
    visited[at] = 1;
    routes[at] = d;
    queue.push({ x, y, d });
  };
  for (const p of initPoints) {
    if (canVisit(p.x, p.y, INIT_VALUE)) insert(p.x, p.y, INIT_VALUE);
  }
  let head = 0;
  while (head < queue.length) {
    const cur = queue[head++];
    if (cur.d <= DEC_COEF) continue;
    const d = cur.d - DEC_COEF;
    if (canVisit(cur.x - 1, cur.y, d)) insert(cur.x - 1, cur.y, d);
    if (canVisit(cur.x + 1, cur.y, d)) insert(cur.x + 1, cur.y, d);
    if (canVisit(cur.x, cur.y - 1, d)) insert(cur.x, cur.y - 1, d);
    if (canVisit(cur.x, cur.y + 1, d)) insert(cur.x, cur.y + 1, d);
  }
}

// === END OF PART 2A ===

// ---------------------------------------------------------------------------------------------
// Eye (KM_Eye.pas 166–222; the shared instance, docs/M5-AI-NOTES.md §2)

export interface ForestInfo {
  partOfForest: boolean;
  loc: Pt;
  treeCount: number;
  distance: number;
  bid: number;
}

export interface ForestsInfo {
  count: number;
  forests: ForestInfo[];
}

export interface MineLoc {
  loc: Pt;
  tag: number;
}

export interface StoneLoc {
  loc: Pt;
  tag: number;
  tag2: number;
}

/**
 * The AI's map view. ONE instance is shared by all hands (the game's gotcha, KM_AI.pas 569 →
 * KM_Eye.pas 764–768); `ownerUpdate(hand)` switches the context. Everything the planner/builder
 * reads lives here: the house mapping, soil/routes/flatArea, the mine/stone/forest lists and the
 * shared BuildFF.
 */
export class Eye {
  owner = 0;
  readonly world: EconomyWorld;
  readonly influences: Influences;
  readonly mapping: HouseMapping[];
  readonly buildFF: BuildFF;
  readonly soil: Uint8Array;
  readonly routes: Uint8Array;
  readonly flatArea: Uint8Array;
  goldLocs: Pt[] = [];
  ironLocs: Pt[] = [];
  stoneMiningTiles: Pt[] = [];
  /** Worker N's army-evaluation slot (KM_Eye.pas 174, 758–761); the economy half never reads it. */
  armyEvaluation: unknown = null;

  constructor(world: EconomyWorld, influences: Influences) {
    this.world = world;
    this.influences = influences;
    this.mapping = buildHousesMapping(world.houseSpecs);
    this.buildFF = new BuildFF(world, influences, this.mapping);
    const size = (world.mapX + 1) * (world.mapY + 1);
    this.soil = new Uint8Array(size);
    this.routes = new Uint8Array(size);
    this.flatArea = new Uint8Array(size);
  }

  private index(x: number, y: number): number {
    return y * (this.world.mapX + 1) + x;
  }

  /** AfterMissionInit (KM_Eye.pas 345–442): soil/flatArea, mine + stone lists, generalization. */
  afterMissionInit(): void {
    const world = this.world;
    const mapX = world.mapX;
    const mapY = world.mapY;
    this.soil.fill(0);
    this.routes.fill(0);
    this.flatArea.fill(0);
    this.goldLocs = [];
    this.ironLocs = [];
    this.stoneMiningTiles = [];

    for (let y = 1; y <= mapY - 1; y++) {
      for (let x = 1; x <= mapX - 1; x++) {
        const at = this.index(x, y);
        this.flatArea[at] = world.tileWalkable(x, y) ? 1 : 0;
        if (world.tileIsSoil(x, y)) {
          this.soil[at] = 1;
        } else if (world.tileHasStone(x, y)) {
          this.soil[at] = 1; // a stone tile can be mined and used for farms
          if (y < mapY - 1 && world.tileWalkable(x, y + 1) && this.checkStoneCount(x, y)) {
            this.stoneMiningTiles.push(kmPoint(x, y));
          }
        } else if (this.canAddHousePlan(kmPoint(x, y), HT_GOLD_MINE, true, false)) {
          if (this.checkResourcesNearMine(kmPoint(x, y), HT_GOLD_MINE)) this.goldLocs.push(kmPoint(x, y));
        } else if (this.canAddHousePlan(kmPoint(x, y), HT_IRON_MINE, true, false)) {
          if (this.checkResourcesNearMine(kmPoint(x, y), HT_IRON_MINE)) this.ironLocs.push(kmPoint(x, y));
        }
      }
    }
    this.generalizeArray(4, this.soil);
    this.generalizeArray(4, this.flatArea);
  }

  /** GeneralizeArray (KM_Eye.pas 346–389): each tile becomes the sum over its (2R+1)² box. */
  private generalizeArray(radius: number, arr: Uint8Array): void {
    const mapX = this.world.mapX;
    const mapY = this.world.mapY;
    const copy = Uint8Array.from(arr);
    for (let y = 1; y <= mapY - 1; y++) {
      for (let x = 1; x <= mapX - 1; x++) {
        const at = this.index(x, y);
        let sum = 0;
        for (let y2 = Math.max(1, y - radius); y2 <= Math.min(mapY - 1, y + radius); y2++) {
          for (let x2 = Math.max(1, x - radius); x2 <= Math.min(mapX - 1, x + radius); x2++) {
            sum += copy[y2 * (mapX + 1) + x2];
          }
        }
        arr[at] = Math.min(255, sum);
      }
    }
  }

  /** TKMFFCheckStoneTiles.CheckCount (KM_Eye.pas 1962–1973): MIN_STONES_IN_MINE = 50. */
  private checkStoneCount(x: number, y: number): boolean {
    const LIMIT = 50;
    let count = 0;
    const seen = new Set<number>();
    const stack: Pt[] = [kmPoint(x, y)];
    while (stack.length > 0 && count < LIMIT) {
      const p = stack.pop() as Pt;
      if (!this.world.tileInMapCoords(p.x, p.y)) continue;
      const at = this.index(p.x, p.y);
      if (seen.has(at)) continue;
      if (!this.world.tileHasStone(p.x, p.y)) continue;
      seen.add(at);
      count += this.world.tileIsStone(p.x, p.y) * 3;
      stack.push(kmPoint(p.x - 1, p.y), kmPoint(p.x + 1, p.y), kmPoint(p.x, p.y - 1), kmPoint(p.x, p.y + 1));
    }
    return LIMIT <= count;
  }

  /** CheckResourcesNearMine (KM_Eye.pas 446–457). */
  checkResourcesNearMine(loc: Pt, typeId: number): boolean {
    const mapX = this.world.mapX;
    for (let x = Math.max(loc.x - 4, 1); x <= Math.min(loc.x + 3 + (typeId === HT_GOLD_MINE ? 1 : 0), mapX - 1); x++) {
      for (let y = Math.max(loc.y - 8, 1); y <= loc.y; y++) {
        if (typeId === HT_GOLD_MINE && this.world.tileHasGold(x, y)) return true;
        if (typeId === HT_IRON_MINE && this.world.tileHasIron(x, y)) return true;
      }
    }
    return false;
  }

  /** OwnerUpdate (KM_Eye.pas 764–768). */
  ownerUpdate(hand: number): void {
    this.owner = hand;
    this.buildFF.ownerUpdate(hand);
  }

  /** UpdateState (KM_Eye.pas 758–761): the army-evaluation slice is worker N's. */
  updateState(_tick: number): void {
    // no-op in the economy half (the shared Eye still ticks; the army half adds its slice)
  }

  // ---- placement queries -------------------------------------------------------------------

  /** Eye.CanPlaceHouse (KM_Eye.pas 772–798): the house-plan tiles, mines special, trees optional. */
  canPlaceHouse(loc: Pt, typeId: number, ignoreTrees = false): boolean {
    const map = this.mapping[typeId];
    if (map === undefined) return false;
    let output = true;
    for (const off of map.tiles) {
      const x = loc.x + off.x;
      const y = loc.y + off.y;
      output = output && this.world.tileInMapCoordsInset(x, y, 1);
      if (typeId === HT_IRON_MINE) output = output && this.world.tileGoodForIronMine(x, y);
      else if (typeId === HT_GOLD_MINE) output = output && this.world.tileGoodForGoldMine(x, y);
      else {
        output =
          output &&
          (this.world.tileBuildable(x, y) ||
            (ignoreTrees && this.world.treeAt(x, y) !== null && this.world.canAddFieldPlan(this.owner, x, y, 'wine')));
      }
      if (!output) break;
    }
    return output;
  }

  /** CanBeRoad (KM_Eye.pas 806–811). */
  private canBeRoad(x: number, y: number): boolean {
    if (this.world.tileMakeRoads(x, y) || this.world.tileWalkableRoad(x, y)) return true;
    if (this.world.hasFieldPlan(this.owner, x, y) !== 'none') return true;
    const lock = this.world.tileLockAt(x, y);
    return lock === 3 || lock === 4; // tlFieldWork, tlRoadWork
  }

  /**
   * Eye.CanAddHousePlan (KM_Eye.pas 805–899): the AI's variant of the plan check.
   * aIgnoreAvoidBuilding ignores the forest/coal marks (not the house locks);
   * aIgnoreTrees ignores trees inside the plan; aIgnoreLocks ignores house-lock marks.
   */
  canAddHousePlan(loc: Pt, typeId: number, ignoreAvoidBuilding = false, ignoreTrees = false, ignoreLocks = true): boolean {
    if (!this.world.tileInMapCoordsInset(loc.x, loc.y, 1)) return false;
    if (!this.canPlaceHouse(loc, typeId, ignoreTrees)) return false;
    if (!this.canBeRoad(loc.x, loc.y + 1)) return false; // a road below the house must be possible

    const map = this.mapping[typeId];
    if (map === undefined) return false;
    for (const off of map.tiles) {
      const x = loc.x + off.x;
      const y = loc.y + off.y;
      const ab = this.influences.getAvoid(x, y);
      if (ignoreAvoidBuilding) {
        if (!ignoreLocks && (ab === AVOID_BUILDING_HOUSE_OUTSIDE_LOCK || ab === AVOID_BUILDING_HOUSE_INSIDE_LOCK)) return false;
      } else if (ab > 0) {
        return false;
      }
      for (let pl = 0; pl < this.world.handCount; pl++) {
        if (this.world.hasFieldPlan(pl, x, y) !== 'none') return false; // allied field plans (v0: all hands)
      }
    }

    // Distance 1 around the plan.
    let leftSideFree = true;
    let rightSideFree = true;
    for (let dir = 0; dir < 4; dir++) {
      for (const off of map.surroundings[1][dir]) {
        const x = loc.x + off.x;
        const y = loc.y + off.y;
        for (let pl = 0; pl < this.world.handCount; pl++) {
          if (this.world.hasHousePlan(pl, x, y)) return false;
        }
        if (typeId === HT_GOLD_MINE || typeId === HT_IRON_MINE) continue;
        if (ignoreAvoidBuilding) {
          if (this.influences.getAvoid(x, y) === AVOID_BUILDING_HOUSE_INSIDE_LOCK) return false;
          if (typeId === HT_WATCHTOWER) {
            if (dir === DIR_E) rightSideFree = rightSideFree && this.canBeRoad(x, y);
            if (dir === DIR_W) leftSideFree = leftSideFree && this.canBeRoad(x, y);
          }
        } else if (dir === DIR_E) {
          rightSideFree = rightSideFree && this.canBeRoad(x, y);
        } else if (dir === DIR_W) {
          leftSideFree = leftSideFree && this.canBeRoad(x, y);
        }
        if (!(leftSideFree && rightSideFree)) return false;
      }
    }
    return true;
  }

  /**
   * TKMHand.CanAddHousePlanAI (KM_Hand.pas 1118–1194): the extra AI rules — no blocking roads,
   * AvoidBuilding (when aCheckInfluence), the entrance owner, the choke-point corners, the road
   * row below and allied fields/plans around. (x, y) is the entrance.
   */
  canAddHousePlanAI(hand: number, x: number, y: number, typeId: number, checkInfluence: boolean): boolean {
    if (!this.world.canPlaceHouse(typeId, x, y)) return false; // gTerrain.CanPlaceHouse
    const spec = this.world.houseSpecOf(typeId);
    const enterOff = spec !== undefined ? spec.entranceDx : 0;
    const area = housePlan(typeId);
    for (let i = 1; i <= 4; i++) {
      for (let k = 1; k <= 4; k++) {
        if (area[i - 1][k - 1] === 0) continue;
        const tx = x + k - 3 - enterOff;
        const ty = y + i - 4;
        // Make sure we do not block existing roads.
        if (this.world.tileWalkableRoad(tx, ty)) return false;
        if (checkInfluence) {
          if (this.influences.getAvoid(tx, ty) > 0) return false;
          if (area[i - 1][k - 1] === 2) {
            const terOwner = this.influences.getBestOwner(tx, ty);
            if (terOwner !== hand && terOwner !== -1) return false;
          }
        }
        if (typeId !== HT_GOLD_MINE && typeId !== HT_IRON_MINE) {
          // Choke points (upper corners) must be road-makeable.
          if (!this.canBeRoad(tx - 1, ty - 1) || !this.canBeRoad(tx + 1, ty - 1)) return false;
        }
        if (i === 4 && typeId !== HT_GOLD_MINE && typeId !== HT_IRON_MINE) {
          if (!this.canBeRoad(tx - 1, ty + 1) || !this.canBeRoad(tx, ty + 1) || !this.canBeRoad(tx + 1, ty + 1)) return false;
        }
        for (let pl = 0; pl < this.world.handCount; pl++) {
          if (this.world.hasFieldPlan(pl, tx, ty) !== 'none') return false;
          for (let s = -1; s <= 1; s++) {
            for (let t = -1; t <= 1; t++) {
              if (this.world.hasHousePlan(pl, tx + s, ty + t)) return false;
            }
          }
        }
      }
    }
    return true;
  }

  // ---- mine / stone / forest lists ---------------------------------------------------------

  /** FindSeparateMineLocs (KM_Eye.pas 474–528): drop mines closer than 3 (4 iron) tiles in X. */
  findSeparateMineLocs(allMines: boolean, typeId: number): Pt[] {
    let mines: Pt[];
    if (allMines) {
      if (typeId === HT_IRON_MINE) mines = this.ironLocs;
      else if (typeId === HT_GOLD_MINE) mines = this.goldLocs;
      else return [];
    } else {
      mines = this.getMineLocs(typeId).map((m) => m.loc);
    }
    const out: Pt[] = [];
    const keep: Pt[] = [];
    for (let i = 0; i < mines.length; i++) {
      let ok = true;
      for (let k = 0; k < keep.length; k++) {
        if (keep[k].y === mines[i].y && Math.abs(keep[k].x - mines[i].x) < 3 + (typeId === HT_IRON_MINE ? 1 : 0)) {
          ok = false;
          break;
        }
      }
      if (ok) keep.push(mines[i]);
    }
    for (const p of keep) out.push(p);
    return out;
  }

  /** GetMineLocs (KM_Eye.pas 902–930): the mine spots that are still valid for the owner. */
  getMineLocs(typeId: number): MineLoc[] {
    const src = typeId === HT_GOLD_MINE ? this.goldLocs : typeId === HT_IRON_MINE ? this.ironLocs : [];
    const out: MineLoc[] = [];
    for (let i = src.length - 1; i >= 0; i--) {
      const loc = src[i];
      const ownership = this.influences.getOwnership(this.owner, loc.x, loc.y);
      const roadBelow = this.world.tileMakeRoads(loc.x, loc.y + 1) || this.world.tileWalkableRoad(loc.x, loc.y + 1);
      if (
        roadBelow &&
        ownership > 0 &&
        this.influences.canPlaceHouseByInfluence(this.owner, loc.x, loc.y) &&
        this.canAddHousePlan(loc, typeId, true, false) &&
        this.checkResourcesNearMine(loc, typeId)
      ) {
        out.push({ loc, tag: ownership });
      } else {
        src.splice(i, 1); // the Pascal deletes the entry from the eye's list
      }
    }
    return out;
  }

  /** GetStoneLocs (KM_Eye.pas 933–971): the stone mining spots with their deposit counts. */
  getStoneLocs(): StoneLoc[] {
    const SCAN_LIMIT = 10;
    const out: StoneLoc[] = [];
    for (let k = this.stoneMiningTiles.length - 1; k >= 0; k--) {
      let x = this.stoneMiningTiles[k].x;
      let y = this.stoneMiningTiles[k].y;
      const maxDist = Math.max(1, y - SCAN_LIMIT);
      while (!this.world.tileHasStone(x, y) && y > maxDist) y -= 1;
      if (this.world.tileHasStone(x, y) && this.world.tileWalkable(x, y + 1)) {
        this.stoneMiningTiles[k] = kmPoint(x, y);
        if (this.influences.canPlaceHouseByInfluence(this.owner, x, y + 1)) {
          let sum = 0;
          while (y > 1) {
            const stone = this.world.tileIsStone(x, y);
            if (stone <= 0) break;
            sum += stone;
            y -= 1;
          }
          out.push({ loc: this.stoneMiningTiles[k], tag: sum, tag2: 0 });
        }
      } else {
        this.stoneMiningTiles.splice(k, 1);
      }
    }
    return out;
  }

  /** GetForests (KM_Eye.pas 976–1064): the cluster algorithm over the BuildFF tree tiles. */
  getForests(): ForestsInfo {
    const UNVISITED_TILE = 0;
    const VISITED_TILE = 1;
    const UNVISITED_TREE = 2;
    const VISITED_TREE = 3;
    const UNVISITED_TREE_IN_FOREST = 4;
    const VISITED_TREE_IN_FOREST = 5;
    const mapX = this.world.mapX;
    const mapY = this.world.mapY;
    const stride = mapX + 1;
    this.buildFF.updateState();
    const visit = new Uint8Array(stride * (mapY + 1));
    for (let y = 1; y <= mapY - 1; y++) {
      for (let x = 1; x <= mapX - 1; x++) {
        const at = this.index(x, y);
        visit[at] = VISITED_TILE;
        if (this.buildFF.visited[at] === this.buildFF.visitIdx && this.buildFF.state[at] === BS_TREE) {
          const ab = this.influences.getAvoid(x, y);
          if (ab < AVOID_BUILDING_FOREST_MINIMUM) visit[at] = UNVISITED_TREE;
          else if (ab < AVOID_BUILDING_FOREST_MINIMUM + AI_PAR.EYE_GetForests_MaxAB) visit[at] = UNVISITED_TREE_IN_FOREST;
        }
      }
    }
    const RADIUS = round(AI_PAR.EYE_GetForests_Radius);
    const MAX_DIST = RADIUS + 1;
    const out: ForestsInfo = { count: 0, forests: [] };
    for (let y = 1; y <= mapY - 1; y++) {
      for (let x = 1; x <= mapX - 1; x++) {
        const at = this.index(x, y);
        if (visit[at] !== UNVISITED_TREE && visit[at] !== UNVISITED_TREE_IN_FOREST) continue;
        const point = kmPoint(x, y);
        let inForest = false;
        let sumX = 0;
        let sumY = 0;
        let cnt = 0;
        for (let y2 = Math.max(1, y - RADIUS); y2 <= Math.min(y + RADIUS, mapY - 1); y2++) {
          for (let x2 = Math.max(1, x - RADIUS); x2 <= Math.min(x + RADIUS, mapX - 1); x2++) {
            const at2 = y2 * stride + x2;
            if (visit[at2] < UNVISITED_TREE) continue;
            if (distanceAbs(point, kmPoint(x2, y2)) > MAX_DIST) continue;
            cnt += 1;
            sumX += x2;
            sumY += y2;
            if (visit[at2] === UNVISITED_TREE) visit[at2] = VISITED_TREE;
            else if (visit[at2] >= UNVISITED_TREE_IN_FOREST) {
              inForest = true;
              visit[at2] = VISITED_TREE_IN_FOREST;
            }
          }
        }
        if (cnt > AI_PAR.EYE_GetForests_MinTrees) {
          const loc = kmPoint(round(sumX / cnt), round(sumY / cnt));
          const locAt = this.index(loc.x, loc.y);
          const dist =
            this.buildFF.visited[locAt] === this.buildFF.visitIdx ? this.buildFF.getDistance(loc) : this.buildFF.getDistance(point);
          out.forests.push({ partOfForest: inForest, loc, treeCount: cnt, distance: dist, bid: 0 });
          out.count += 1;
        }
      }
    }
    return out;
  }

  /** GetPotentialForests (KM_Eye.pas 1067–1101): navmesh-based — not modelled in v0 (returns none). */
  getPotentialForests(_maxCnt: number): ForestsInfo {
    return { count: 0, forests: [] };
  }

  /** GetCityCenterPoints (KM_Eye.pas 1116–1149): store/school/barracks/townhall entrances. */
  getCityCenterPoints(multiple = false): Pt[] {
    const scanned = [HT_STORE, HT_SCHOOL, HT_BARRACKS, HT_TOWN_HALL];
    let cnt = 0;
    for (const ht of scanned) cnt += this.world.handHouseCount(this.owner, ht);
    if (cnt === 0) return [];
    const out: Pt[] = [];
    for (const h of this.world.houses) {
      if (h.owner !== this.owner || h.destroyed || h.buildState !== 'done') continue;
      if (!scanned.includes(h.typeId)) continue;
      out.push(kmPoint(h.entrance.x, h.entrance.y + 1));
      if (!multiple) break;
    }
    return out;
  }

  /** ScanLoc (KM_Eye.pas 531–626): the routes flood to the mines + the field/build counts. */
  scanLoc(planner: CityPlanner, predictor: CityPredictor): void {
    const centers = this.getCityCenterPoints(false);
    const initPoints: Pt[] = [];
    if (centers.length > 0) {
      const center = centers[0];
      for (const loc of this.findSeparateMineLocs(false, HT_IRON_MINE)) {
        const road = planner.getRoadBetweenPoints(center, kmPoint(loc.x, loc.y + 1));
        if (road !== null) for (const p of road) initPoints.push(p);
      }
      for (const loc of this.findSeparateMineLocs(false, HT_GOLD_MINE)) {
        const road = planner.getRoadBetweenPoints(center, kmPoint(loc.x, loc.y + 1));
        if (road !== null) for (const p of road) initPoints.push(p);
      }
    }
    if (initPoints.length > 0) fillInitArea(this.routes, this.world.mapX, this.world.mapY, initPoints);

    let fieldCnt = 0;
    let buildCnt = 0;
    for (let y = 1; y <= this.world.mapY - 1; y++) {
      for (let x = 1; x <= this.world.mapX - 1; x++) {
        if (this.influences.getBestOwner(x, y) !== this.owner) continue;
        if (!this.world.tileIsRoadable(x, y)) continue;
        if (this.soil[this.index(x, y)] > 0) fieldCnt += 1;
        buildCnt += 1;
      }
    }
    predictor.fieldCnt = fieldCnt;
    predictor.buildCnt = buildCnt;
  }
}

// ---------------------------------------------------------------------------------------------
// Road pathfinding (KM_CityPlanner.pas TKMPathFindingCityPlanner 2829–2968)

/**
 * The city-planner road route: a Dijkstra over tiles with the Pascal's MovementCost tables
 * (ROADS_* for GetRoadToHouse, SHORTCUTS_* for GetRoadBetweenPoints). v0 simplification: the game
 * uses TKMPathFindingRoad's A* (not ported, docs/M5-AI-NOTES.md gap 11) — the cost model is the
 * same, tie-breaking may differ.
 */
export function roadRoute(
  world: EconomyWorld,
  influences: Influences,
  hand: number,
  from: Pt,
  to: Pt,
  variant: 'roads' | 'shortcuts',
): Pt[] | null {
  const mapX = world.mapX;
  const mapY = world.mapY;
  const stride = mapX + 1;
  const P: { base: number; coal: number; field: number; forest: number; other: number; road: number; turn: number; noBuild: number } =
    variant === 'roads'
    ? {
        base: AI_PAR.ROADS_BasePrice,
        coal: AI_PAR.ROADS_Coal,
        field: AI_PAR.ROADS_Field,
        forest: AI_PAR.ROADS_Forest,
        other: AI_PAR.ROADS_OtherCase,
        road: AI_PAR.ROADS_Road,
        turn: AI_PAR.ROADS_TurnPenalization,
        noBuild: AI_PAR.ROADS_noBuildArea,
      }
    : {
        base: AI_PAR.SHORTCUTS_BasePrice,
        coal: AI_PAR.SHORTCUTS_Coal,
        field: AI_PAR.SHORTCUTS_Field,
        forest: AI_PAR.SHORTCUTS_Forest,
        other: AI_PAR.SHORTCUTS_OtherCase,
        road: AI_PAR.SHORTCUTS_Road,
        turn: AI_PAR.SHORTCUTS_TurnPenalization,
        noBuild: AI_PAR.SHORTCUTS_noBuildArea,
      };

  const walkable = (x: number, y: number): boolean => {
    if (!world.tileInMapCoords(x, y)) return false;
    const lock = world.tileLockAt(x, y);
    const pass = world.tileMakeRoads(x, y) || world.tileWalkableRoad(x, y) || lock === 3 || lock === 4;
    if (!pass) return false;
    return influences.getAvoid(x, y) !== AVOID_BUILDING_HOUSE_INSIDE_LOCK;
  };

  const movementCost = (fromIdx: number, toIdx: number): number => {
    const tx = toIdx % stride;
    const ty = Math.floor(toIdx / stride);
    const fx = fromIdx % stride;
    const fy = Math.floor(fromIdx / stride);
    let cost = P.base;
    const ab = influences.getAvoid(tx, ty);
    const isRoad =
      ab === AVOID_BUILDING_NODE_LOCK_ROAD ||
      world.tileWalkableRoad(tx, ty) ||
      world.hasFieldPlan(hand, tx, ty) === 'road' ||
      world.tileLockAt(tx, ty) === 3;
    if (isRoad) {
      cost = Math.max(0, cost - P.road);
    } else if (
      ab === AVOID_BUILDING_HOUSE_OUTSIDE_LOCK ||
      (!world.tileBuildable(tx, ty) && ab === 0) ||
      ab === AVOID_BUILDING_MINE_TILE
    ) {
      cost += P.noBuild;
    } else {
      const par = parentOf(fromIdx);
      if (par >= 0 && par % stride !== tx && Math.floor(par / stride) !== ty) cost += P.turn;
      if (ab === AVOID_BUILDING_NODE_LOCK_FIELD) cost += P.field;
      else if (ab === AVOID_BUILDING_COAL_TILE) cost += P.coal;
      else if (ab > AVOID_BUILDING_FOREST_MINIMUM) cost += P.forest;
      else cost += P.other;
    }
    return round(cost);
  };

  if (!walkable(from.x, from.y) || !walkable(to.x, to.y)) return null;
  const startIdx = from.y * stride + from.x;
  const endIdx = to.y * stride + to.x;
  const dist = new Map<number, number>();
  const parent = new Map<number, number>();
  const parentOf = (idx: number): number => parent.get(idx) ?? -1;
  dist.set(startIdx, 0);

  // A small binary heap with an insertion-order tie-break (deterministic).
  interface HeapEntry {
    idx: number;
    cost: number;
    seq: number;
  }
  const heap: HeapEntry[] = [];
  let seq = 0;
  const less = (a: HeapEntry, b: HeapEntry): boolean => (a.cost !== b.cost ? a.cost < b.cost : a.seq < b.seq);
  const push = (e: HeapEntry): void => {
    heap.push(e);
    let pos = heap.length - 1;
    while (pos > 0) {
      const par = (pos - 1) >> 1;
      if (less(heap[pos], heap[par])) {
        const t = heap[pos];
        heap[pos] = heap[par];
        heap[par] = t;
        pos = par;
      } else break;
    }
  };
  const pop = (): HeapEntry => {
    const top = heap[0];
    const last = heap.pop() as HeapEntry;
    if (heap.length > 0) {
      heap[0] = last;
      let pos = 0;
      for (;;) {
        const l = pos * 2 + 1;
        const r = l + 1;
        let best = pos;
        if (l < heap.length && less(heap[l], heap[best])) best = l;
        if (r < heap.length && less(heap[r], heap[best])) best = r;
        if (best === pos) break;
        const t = heap[pos];
        heap[pos] = heap[best];
        heap[best] = t;
        pos = best;
      }
    }
    return top;
  };
  push({ idx: startIdx, cost: 0, seq: seq++ });

  const visited = new Set<number>();
  while (heap.length > 0) {
    const cur = pop();
    if (visited.has(cur.idx)) continue;
    visited.add(cur.idx);
    if (cur.idx === endIdx) break;
    const cx = cur.idx % stride;
    const cy = Math.floor(cur.idx / stride);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = cx + dx;
        const ny = cy + dy;
        if (!walkable(nx, ny)) continue;
        if (dx !== 0 && dy !== 0 && !world.canWalkDiagonal(cx, cy, nx, ny)) continue;
        const ni = ny * stride + nx;
        const step = movementCost(cur.idx, ni);
        const nd = cur.cost + step;
        const old = dist.get(ni);
        if (old === undefined || nd < old) {
          dist.set(ni, nd);
          parent.set(ni, cur.idx);
          push({ idx: ni, cost: nd, seq: seq++ });
        }
      }
    }
  }

  if (!dist.has(endIdx)) return null;
  const route: Pt[] = [];
  let cur = endIdx;
  for (;;) {
    route.push(kmPoint(cur % stride, Math.floor(cur / stride)));
    if (cur === startIdx) break;
    const par = parent.get(cur);
    if (par === undefined) return null;
    cur = par;
  }
  route.reverse();
  return route;
}

// === END OF PART 2B ===

// ---------------------------------------------------------------------------------------------
// CityPredictor (KM_CityPredictor.pas 163–834)

/** TWareBalance (KM_CityPredictor.pas 17–19). */
export interface WareBalance {
  production: number;
  actualConsumption: number;
  finalConsumption: number;
  exhaustion: number;
  fraction: number;
}

/** TCityStats (KM_CityPredictor.pas 21–26). */
export interface CityStats {
  citizensCnt: number;
  warriorsCnt: number;
  housesCnt: number;
  citizens: number[]; // UT_SERF..UT_RECRUIT
  warriors: number[]; // UT_MILITIA..UT_VAGABOND
  houses: number[]; // script ids 0..29
}

// PRODUCTION_WARE2HOUSE (KM_CityPredictor.pas 102–109) as script ids (ware id → house script id).
export const PRODUCTION_WARE2HOUSE: number[] = [
  HT_WOODCUTTERS, HT_QUARRY, HT_SAWMILL, HT_IRON_MINE, HT_GOLD_MINE,
  HT_COAL_MINE, HT_IRON_SMITHY, HT_METALLURGISTS, HT_VINEYARD, HT_FARM,
  HT_BAKERY, HT_MILL, HT_TANNERY, HT_BUTCHERS, HT_SWINE,
  HT_SWINE, HT_ARMOR_WORKSHOP, HT_ARMOR_SMITHY, HT_ARMOR_WORKSHOP, HT_ARMOR_SMITHY,
  HT_WEAPON_WORKSHOP, HT_WEAPON_SMITHY, HT_WEAPON_WORKSHOP, HT_WEAPON_SMITHY, HT_WEAPON_WORKSHOP,
  HT_WEAPON_SMITHY, HT_STABLES, HT_FISHER_HUT,
];

// CONSUMPTION_WARE (KM_CityPredictor.pas 111–118): the product wares a ware is consumed for
// (−1 = wtNone).
const CONSUMPTION_WARE: number[][] = [
  [WT_TIMBER, -1, -1, -1], [-1, -1, -1, -1], [WT_AXE, -1, -1, -1], [WT_IRON, -1, -1, -1], [WT_GOLD, -1, -1, -1],
  [WT_IRON, WT_GOLD, WT_IRON_ARMOR, WT_SWORD], [WT_IRON_ARMOR, WT_SWORD, -1, -1], [-1, -1, -1, -1], [-1, -1, -1, -1], [WT_FLOUR, WT_PIG, WT_HORSE, -1],
  [-1, -1, -1, -1], [WT_BREAD, -1, -1, -1], [WT_LEATHER_ARMOR, -1, -1, -1], [-1, -1, -1, -1], [WT_SAUSAGE, -1, -1, -1],
  [WT_LEATHER, -1, -1, -1], [-1, -1, -1, -1], [-1, -1, -1, -1], [-1, -1, -1, -1], [-1, -1, -1, -1],
  [-1, -1, -1, -1], [-1, -1, -1, -1], [-1, -1, -1, -1], [-1, -1, -1, -1], [-1, -1, -1, -1],
  [-1, -1, -1, -1], [-1, -1, -1, -1], [-1, -1, -1, -1],
];

// CONSUMPTION_RATIO (KM_CityPredictor.pas 120–128) for wtTrunk..wtSkin.
const CONSUMPTION_RATIO: number[][] = [
  [0.5, 1, 1, 1], [1, 1, 1, 1], [2, 1, 1, 1], [1, 1, 1, 1], [0.5, 1, 1, 1],
  [0.5, 1, 1, 1], [1, 1, 1, 1], [1, 1, 1, 1], [1, 1, 1, 1], [1, 4, 4, 1],
  [1, 1, 1, 1], [0.5, 1, 1, 1], [1, 1, 1, 1], [1, 1, 1, 1], [0.333, 1, 1, 1],
  [0.5, 1, 1, 1],
];

// CONSUMPTION_ORDER (KM_CityPredictor.pas 130–137) — wares sorted resource → product.
export const CONSUMPTION_ORDER: number[] = [
  WT_STONE, WT_TRUNK, WT_TIMBER,
  WT_CORN, WT_FLOUR, WT_BREAD, WT_WINE, WT_FISH,
  WT_PIG, WT_SAUSAGE, WT_SKIN, WT_LEATHER, WT_HORSE,
  WT_GOLD_ORE, WT_IRON_ORE, WT_COAL, WT_GOLD, WT_IRON,
  WT_AXE, WT_BOW, WT_LANCE, WT_LEATHER_ARMOR, WT_WOODEN_SHIELD,
  WT_SWORD, WT_CROSSBOW, WT_PIKE, WT_IRON_SHIELD, WT_IRON_ARMOR,
];
const CO_WEAPONS_MIN = 18;
const CO_WEAPONS_MAX = 27;
const CO_WARE_MIN = 0;
const CO_WARE_MAX = 17;

/**
 * TKMCityPredictor: the resource-flow prediction — required houses by type, the ware balance and
 * the worker count the planner/builder/management read.
 */
export class CityPredictor {
  owner: number;
  readonly setup: AiSetup;
  cityStats: CityStats = {
    citizensCnt: 0,
    warriorsCnt: 0,
    housesCnt: 0,
    citizens: new Array<number>(14).fill(0),
    warriors: new Array<number>(14).fill(0),
    houses: new Array<number>(30).fill(0),
  };
  cityUnderConstruction = false;
  cityCompleted = false;
  workerCount = 0;
  maxGoldMineCnt = 0;
  decCoalMineCnt = 0;
  ironMineCnt = 0;
  fieldCnt = 0;
  buildCnt = 0;
  maxIronWeapProd = 0;
  maxWoodWeapProd = 0;
  maxSoldiersInMin = 0;
  peaceFactor = 0;
  updatedPeaceFactor = 0;
  wareBalance: WareBalance[] = [];
  farmBuildHistory = { count: 1, quantity: [0], tick: [10 * 60 * 10] };
  requiredHouses: number[] = new Array<number>(30).fill(0);
  peacetimeMinutes = 0; // v0: no lobby option (docs/M5-AI-NOTES.md gap 15)

  private readonly world: EconomyWorld;
  private planner: CityPlanner | null = null;
  private builder: CityBuilder | null = null;
  private management: CityManagement | null = null;

  constructor(world: EconomyWorld, owner: number, setup: AiSetup) {
    this.world = world;
    this.owner = owner;
    this.setup = setup;
    for (let w = 0; w < WARE_CNT; w++) {
      this.wareBalance.push({ production: 0, actualConsumption: 0, finalConsumption: 0, exhaustion: 999, fraction: 0 });
    }
  }

  /** The cross-references the predictor reads (set once by AiPlayer; avoids construction cycles). */
  link(planner: CityPlanner, builder: CityBuilder, management: CityManagement): void {
    this.planner = planner;
    this.builder = builder;
    this.management = management;
  }

  ownerUpdate(hand: number): void {
    this.owner = hand;
  }

  /** IsPeaceTime: v0 has no lobby options — peacetimeMinutes is a scenario constant (0 = none). */
  isPeaceTime(tick: number): boolean {
    return tick < this.peacetimeMinutes * 60 * 10;
  }

  /** MarkExhaustedMine (288–296). */
  markExhaustedMine(typeId: number): void {
    if (typeId === HT_IRON_MINE) this.ironMineCnt -= 1;
    else if (typeId === HT_GOLD_MINE) this.maxGoldMineCnt -= 1;
    else if (typeId === HT_COAL_MINE) this.decCoalMineCnt += 1;
    this.updateFinalProduction();
  }

  // ---- ware balance --------------------------------------------------------------------------

  /** UpdateWareProduction (300–303). */
  private updateWareProduction(ware: number): void {
    this.wareBalance[ware].production = this.cityStats.houses[PRODUCTION_WARE2HOUSE[ware]] * PRODUCTION_RATE[ware];
  }

  /** UpdateWareConsumption (307–323). */
  private updateWareConsumption(ware: number, initialization = false): void {
    this.wareBalance[ware].actualConsumption = 0;
    if (initialization) this.wareBalance[ware].finalConsumption = 0;
    for (let i = 0; i < 4; i++) {
      const dep = CONSUMPTION_WARE[ware][i];
      if (dep < 0) break;
      this.wareBalance[ware].actualConsumption += this.wareBalance[dep].actualConsumption * CONSUMPTION_RATIO[ware][i];
      if (initialization) {
        this.wareBalance[ware].finalConsumption +=
          Math.max(this.wareBalance[dep].finalConsumption, this.wareBalance[dep].actualConsumption) * CONSUMPTION_RATIO[ware][i];
      }
    }
  }

  /** UpdateFoodConsumption (327–352). */
  private updateFoodConsumption(initialization = false): void {
    const CITIZEN_FOOD_COEF = 0.05;
    const SOLDIER_FOOD_COEF = 0.025;
    let consumption = this.cityStats.citizensCnt * CITIZEN_FOOD_COEF + this.cityStats.warriorsCnt * SOLDIER_FOOD_COEF;
    this.wareBalance[WT_SAUSAGE].actualConsumption = Math.min(consumption, this.wareBalance[WT_LEATHER_ARMOR].finalConsumption * 1.5);
    consumption = Math.max(0, consumption - this.wareBalance[WT_SAUSAGE].actualConsumption);
    this.wareBalance[WT_BREAD].actualConsumption = consumption * 0.7;
    this.wareBalance[WT_WINE].actualConsumption = consumption * 0.3;
    this.wareBalance[WT_FISH].actualConsumption = 0;
    if (initialization) {
      this.wareBalance[WT_SAUSAGE].finalConsumption = this.wareBalance[WT_SAUSAGE].actualConsumption;
      this.wareBalance[WT_BREAD].finalConsumption = this.wareBalance[WT_BREAD].actualConsumption;
      this.wareBalance[WT_WINE].finalConsumption = this.wareBalance[WT_WINE].actualConsumption;
      this.wareBalance[WT_FISH].finalConsumption = this.wareBalance[WT_FISH].actualConsumption;
    }
  }

  /** UpdateGoldConsumption (356–361). */
  private updateGoldConsumption(_initialization = false): void {
    const GOLD_NEED_PER_A_SCHOOL = 3.5;
    this.wareBalance[WT_GOLD].actualConsumption = Math.min(
      this.maxSoldiersInMin,
      (this.cityStats.houses[HT_SCHOOL] + this.requiredHouses[HT_SCHOOL]) * GOLD_NEED_PER_A_SCHOOL,
    );
  }

  /** UpdateBuildMaterialConsumption (365–374). */
  private updateBuildMaterialConsumption(initialization = false): void {
    this.wareBalance[WT_STONE].actualConsumption =
      Math.min(this.cityStats.citizens[UT_BUILDER] + round(AI_PAR.PREDICTOR_WareNeedPerAWorker_StoneOffset), this.workerCount) *
      AI_PAR.PREDICTOR_WareNeedPerAWorker_Stone;
    this.wareBalance[WT_STONE].finalConsumption = this.wareBalance[WT_STONE].actualConsumption;
    this.updateWareConsumption(WT_TIMBER, initialization);
    this.wareBalance[WT_TIMBER].actualConsumption = Math.max(
      this.wareBalance[WT_TIMBER].actualConsumption,
      this.cityStats.citizens[UT_BUILDER] * AI_PAR.PREDICTOR_WareNeedPerAWorker_Wood,
    );
    this.wareBalance[WT_TIMBER].finalConsumption = Math.max(
      this.wareBalance[WT_TIMBER].finalConsumption,
      this.workerCount * AI_PAR.PREDICTOR_WareNeedPerAWorker_Wood,
    );
  }

  /** UpdateWareDerivation (380–413). */
  private updateWareDerivation(ware: number, initialization = false): void {
    void initialization;
    const dependentBalance = (): number => {
      let result = this.world.handWareBalance(this.owner, ware);
      if (ware === WT_TRUNK) result += this.world.handWareBalance(this.owner, WT_TIMBER) / 2;
      else if (ware === WT_IRON_ORE) result += this.world.handWareBalance(this.owner, WT_IRON);
      else if (ware === WT_FLOUR) result += this.world.handWareBalance(this.owner, WT_BREAD) / 2;
      else if (ware === WT_PIG) result += this.world.handWareBalance(this.owner, WT_SAUSAGE) / 3;
      else if (ware === WT_SKIN) result += this.world.handWareBalance(this.owner, WT_LEATHER) / 2;
      return result;
    };
    const ht = PRODUCTION_WARE2HOUSE[ware];
    const balance = this.wareBalance[ware];
    balance.exhaustion = 999;
    if (balance.actualConsumption - balance.production > 0) {
      balance.exhaustion = Math.min(999, dependentBalance() / (balance.actualConsumption - balance.production));
    }
    let houseReqCnt = Math.ceil(
      (Math.max(balance.actualConsumption, balance.finalConsumption) - balance.production) / Math.max(0.0001, PRODUCTION_RATE[ware]),
    );
    if (houseReqCnt > 0 && balance.exhaustion >= 950 && this.cityStats.houses[ht] === 0) houseReqCnt = 1;
    else houseReqCnt = (balance.exhaustion < 950 ? 1 : 0) * houseReqCnt;
    balance.fraction = houseReqCnt / Math.max(1, this.cityStats.houses[ht] + houseReqCnt);
    this.requiredHouses[ht] = houseReqCnt;
  }

  /** UpdateWareBalance (417–452). */
  private updateWareBalance(initialization = false): void {
    for (let i = CO_WEAPONS_MAX; i >= CO_WEAPONS_MIN; i--) {
      const ware = CONSUMPTION_ORDER[i];
      this.updateWareProduction(ware);
      this.wareBalance[ware].actualConsumption = this.wareBalance[ware].finalConsumption;
      this.updateWareDerivation(ware, initialization);
    }
    this.updateFoodConsumption(initialization);
    this.updateGoldConsumption(initialization);
    this.updateBuildMaterialConsumption(initialization);
    for (let i = CO_WARE_MAX; i >= CO_WARE_MIN; i--) {
      const ware = CONSUMPTION_ORDER[i];
      this.updateWareProduction(ware);
      if (ware !== WT_WINE && ware !== WT_BREAD && ware !== WT_SAUSAGE && ware !== WT_FISH && ware !== WT_GOLD && ware !== WT_STONE && ware !== WT_TIMBER) {
        this.updateWareConsumption(ware, initialization);
      }
      this.updateWareDerivation(ware, initialization);
    }
  }

  /** UpdateBasicHouses (456–485). */
  private updateBasicHouses(tick: number, initialization = false): void {
    const INN_TIME_LIMIT = 60 * 10 * 14;
    const SCHOOL_PRODUCTION = 3;
    const FIRST_MARKETPLACE = 10 * 60 * 60;
    const SECOND_MARKETPLACE = 10 * 60 * 100;
    const BARRACKS_PEACE_DELAY = 30;
    const BARRACKS_BEFORE_PEACE_END = 20;
    this.requiredHouses[HT_STORE] = 1 - this.cityStats.houses[HT_STORE];
    let warfare = 0;
    for (let wt = WT_WOODEN_SHIELD; wt <= WT_HORSE; wt++) warfare += this.world.handWareBalance(this.owner, wt); // GetWareBalance(wtWarfare)
    const barracksTime =
      tick > BARRACKS_PEACE_DELAY * 600 || tick > (this.peacetimeMinutes - BARRACKS_BEFORE_PEACE_END) * 600;
    this.requiredHouses[HT_BARRACKS] =
      (initialization || (warfare > 0 && barracksTime) ? 1 : 0) - this.cityStats.houses[HT_BARRACKS];
    const requiredUnits = this.management !== null ? this.management.requiredUnitsCnt : 0;
    const shortageFree =
      this.builder !== null &&
      !this.builder.goldShortage &&
      !this.builder.stoneShortage &&
      !this.builder.trunkShortage &&
      !this.builder.woodShortage;
    this.requiredHouses[HT_SCHOOL] = Math.max(
      0,
      Math.max(
        1 + (requiredUnits > round(AI_PAR.PREDICTOR_SecondSchool_MinRequiredUnits) && shortageFree ? 1 : 0),
        (this.cityStats.houses[HT_BARRACKS] > 0 || initialization ? 1 : 0) * Math.ceil(this.maxSoldiersInMin / SCHOOL_PRODUCTION),
      ) - this.cityStats.houses[HT_SCHOOL],
    );
    this.requiredHouses[HT_INN] = Math.max(
      0,
      Math.ceil((tick > INN_TIME_LIMIT || initialization ? 1 : 0) * (this.cityStats.citizensCnt / 80)) - this.cityStats.houses[HT_INN],
    );
    this.requiredHouses[HT_MARKET] =
      (initialization || tick > FIRST_MARKETPLACE ? 1 : 0) +
      (initialization || tick > SECOND_MARKETPLACE ? 1 : 0) -
      this.cityStats.houses[HT_MARKET];
  }

  /** UpdateCityStats (489–527). */
  private updateCityStats(): void {
    const citizens = this.cityStats.citizens;
    const warriors = this.cityStats.warriors;
    let citizensCnt = 0;
    for (let ut = 0; ut < citizens.length; ut++) {
      citizens[ut] = this.world.handUnitCount(this.owner, ut);
      citizensCnt += citizens[ut];
    }
    citizensCnt -= citizens[UT_RECRUIT]; // recruits count as soldiers
    let warriorsCnt = citizens[UT_RECRUIT];
    for (let ut = 0; ut < warriors.length; ut++) {
      warriors[ut] = this.world.handUnitCount(this.owner, UT_MILITIA + ut);
      warriorsCnt += warriors[ut];
    }
    this.cityStats.citizensCnt = citizensCnt;
    this.cityStats.warriorsCnt = warriorsCnt;

    let constructedHouses = 0;
    this.cityStats.housesCnt = 0;
    for (let ht = 0; ht < 30; ht++) {
      const ph = this.planner !== null ? this.planner.plannedHouses[ht] : null;
      this.cityStats.houses[ht] = ph !== null ? ph.completed + ph.underConstruction + ph.planned : 0;
      this.cityStats.housesCnt += this.cityStats.houses[ht];
      if (ph !== null) constructedHouses += ph.underConstruction + ph.planned;
    }
    const freeWorkerCnt = this.builder !== null ? this.builder.freeWorkersCnt : 0;
    this.cityUnderConstruction = constructedHouses > 0 && (freeWorkerCnt < 10 || constructedHouses > 3);
    this.cityCompleted = constructedHouses === 0 && freeWorkerCnt === this.cityStats.citizens[UT_BUILDER];
  }

  /** UpdateFinalProduction (530–620). */
  updateFinalProduction(incPeaceFactor = 0, incrementMines = false): void {
    const IRON_WARFARE = [WT_IRON_SHIELD, WT_IRON_ARMOR, WT_SWORD, WT_PIKE, WT_CROSSBOW];
    const WOOD_WARFARE = [WT_AXE, WT_LANCE, WT_BOW];
    const MIN_IRON_PRODUCTION = 2;
    const MAX_IRON_PRODUCTION = 6;
    const INV_REQUIRED_TILES_PER_IRON = 1 / 250;
    const MIN_WOOD_PRODUCTION = 2;
    const MAX_WOOD_PRODUCTION = 6;
    const INV_REQUIRED_TILES_PER_WOOD = 1 / 450.0;
    const TILE_RESERVE = 1000;
    const IRON_RESERVE_COEF = 300;

    this.updatedPeaceFactor = Math.min(1, this.updatedPeaceFactor + incPeaceFactor);

    let freePlace = Math.max(0, (Math.min(this.buildCnt, 2000) - TILE_RESERVE) * INV_REQUIRED_TILES_PER_IRON);
    let maxIronWeapProd = Math.min(
      round(freePlace) + MIN_IRON_PRODUCTION,
      Math.min(
        MAX_IRON_PRODUCTION,
        this.ironMineCnt + (this.world.handWareBalance(this.owner, WT_IRON_ORE) + this.world.handWareBalance(this.owner, WT_IRON)) / IRON_RESERVE_COEF,
      ),
    );
    freePlace = Math.max(0, (Math.min(this.fieldCnt, 3000) - TILE_RESERVE) * INV_REQUIRED_TILES_PER_WOOD);
    let maxWoodWeapProd = Math.min(MAX_WOOD_PRODUCTION, Math.max(MIN_WOOD_PRODUCTION, round(freePlace * this.updatedPeaceFactor)));
    maxWoodWeapProd = Math.max(
      MIN_WOOD_PRODUCTION - (maxIronWeapProd > 0 ? 1 : 0),
      round(maxWoodWeapProd - maxIronWeapProd * (1.0 - this.updatedPeaceFactor) * 0.5),
    );
    maxIronWeapProd = maxIronWeapProd * PRODUCTION_RATE[WT_IRON_ORE] * 0.5;
    for (const wt of IRON_WARFARE) this.wareBalance[wt].finalConsumption = maxIronWeapProd;
    maxWoodWeapProd = maxWoodWeapProd * PRODUCTION_RATE[WT_AXE];
    for (const wt of WOOD_WARFARE) this.wareBalance[wt].finalConsumption = maxWoodWeapProd;
    this.wareBalance[WT_LEATHER_ARMOR].finalConsumption = maxWoodWeapProd;
    this.wareBalance[WT_WOODEN_SHIELD].finalConsumption = maxWoodWeapProd / 5;
    this.maxIronWeapProd = maxIronWeapProd;
    this.maxWoodWeapProd = maxWoodWeapProd;
    this.maxSoldiersInMin = maxWoodWeapProd + maxIronWeapProd;
    if (this.setup.newAI && this.setup.unlimitedEquip) {
      this.setup.equipRateIron = round(600 / Math.max(0.01, maxIronWeapProd));
      this.setup.equipRateLeather = round(600 / Math.max(0.01, maxWoodWeapProd));
    }

    // Predict the final city stats (by the potential size of the city).
    this.cityStats.citizensCnt = round(Math.max(0, Math.min(this.buildCnt, 4000) - 1500) * 0.052 + 70);
    this.cityStats.warriorsCnt = round(Math.max(0, Math.min(this.buildCnt, 4000) - 1500) * 0.042 + 50);
    this.updateWareBalance(true);

    freePlace = Math.max(0, Math.min(2000, Math.min(this.fieldCnt, this.buildCnt) - 1000));
    this.workerCount = round(
      Math.min(
        50 - 35 * this.updatedPeaceFactor * (this.isPeaceTime(0) ? 0 : 1), // Byte(not gGame.IsPeaceTime)
        15 + freePlace * AI_PAR.PREDICTOR_WorkerCountCoef + this.peaceFactor * 8,
      ),
    );
    if (incrementMines) this.decCoalMineCnt = Math.max(0, this.decCoalMineCnt - 1);
  }

  /** AfterMissionInit (624–637). */
  afterMissionInit(): void {
    this.peaceFactor = 0; // "the peace factor only harms"
    this.updateFinalProduction();
  }

  /** FilterRequiredHouses (640–813). */
  private filterRequiredHouses(tick: number): void {
    const CORN_DELAY = 10 * 60 * 6;
    const WEAP_WORKSHOP_DELAY = 35 * 60 * 10;
    const stats = this.world;
    const planner = this.planner;
    if (planner === null) return;

    const updateFarmHistory = (): boolean => {
      const hist = this.farmBuildHistory;
      if (hist.count > 1) {
        let i = 0;
        while (i < hist.count) {
          if (hist.tick[i] > tick) break;
          i += 1;
        }
        if (i > 1) {
          let cnt = 0;
          for (let k = i - 1; k < hist.count; k++) {
            hist.quantity[cnt] = hist.quantity[k];
            hist.tick[cnt] = hist.tick[k];
            cnt += 1;
          }
          hist.count = cnt;
        }
      }
      const cnt = stats.handHouseCount(this.owner, HT_FARM);
      if (hist.quantity[hist.count - 1] !== cnt) {
        hist.quantity[hist.count] = cnt;
        hist.tick[hist.count] = tick + CORN_DELAY;
        hist.count += 1;
      }
      return (
        this.wareBalance[WT_FLOUR].production +
          this.wareBalance[WT_PIG].production * 4 +
          this.wareBalance[WT_HORSE].production * 4 >=
        hist.quantity[0] * PRODUCTION_RATE[WT_CORN] + stats.handWareBalance(this.owner, WT_CORN) * 0.25
      );
    };

    // Do not build anything without a completed school.
    const schoolPlan = planner.plannedHouses[HT_SCHOOL].plans[0];
    let schoolPlanComplete = false;
    if (schoolPlan !== undefined && schoolPlan.placed && schoolPlan.houseUid !== 0) {
      const sh = this.world.houseByUid(schoolPlan.houseUid);
      schoolPlanComplete = sh !== null && sh.buildState === 'done';
    }
    if (this.cityStats.houses[HT_SCHOOL] === 0 || (this.cityStats.houses[HT_SCHOOL] === 1 && !schoolPlanComplete)) {
      this.requiredHouses.fill(0);
      this.updateWareProduction(WT_STONE);
      this.wareBalance[WT_STONE].actualConsumption =
        Math.min(this.cityStats.citizens[UT_BUILDER] + 8, this.workerCount) * AI_PAR.PREDICTOR_WareNeedPerAWorker_Stone;
      this.wareBalance[WT_STONE].finalConsumption =
        Math.max(this.cityStats.citizens[UT_BUILDER], this.workerCount) * AI_PAR.PREDICTOR_WareNeedPerAWorker_Stone;
      this.updateWareDerivation(WT_STONE);
      this.requiredHouses[HT_SCHOOL] = Math.max(0, 1 - planner.plannedHouses[HT_SCHOOL].count);
      return;
    }

    if (!this.cityUnderConstruction) this.updateFinalProduction(0.1);

    if (this.requiredHouses[HT_IRON_SMITHY] < 0 && stats.handWareBalance(this.owner, WT_IRON_ORE) < 20) planner.removeHouseType(HT_IRON_SMITHY);
    if (this.requiredHouses[HT_ARMOR_SMITHY] < 0 && this.requiredHouses[HT_IRON_SMITHY] === 0) planner.removeHouseType(HT_ARMOR_SMITHY);
    if (this.requiredHouses[HT_WEAPON_SMITHY] < 0 && this.requiredHouses[HT_IRON_SMITHY] === 0) planner.removeHouseType(HT_WEAPON_SMITHY);

    if (this.updatedPeaceFactor < 1) this.requiredHouses[HT_VINEYARD] = 0;
    // v0: mission house blocks do not exist (HouseBlocked is always false).
    if (updateFarmHistory()) {
      this.requiredHouses[HT_MILL] = this.cityStats.houses[HT_MILL] === 0 ? 1 : 0;
      this.requiredHouses[HT_SWINE] = 0;
      this.requiredHouses[HT_STABLES] = 0;
    }
    this.requiredHouses[HT_BAKERY] = Math.min(
      this.requiredHouses[HT_BAKERY],
      stats.handHouseCount(this.owner, HT_MILL) - this.cityStats.houses[HT_BAKERY],
    );
    this.requiredHouses[HT_BUTCHERS] = Math.min(
      this.requiredHouses[HT_BUTCHERS],
      Math.ceil(stats.handHouseCount(this.owner, HT_SWINE) / 3 - this.cityStats.houses[HT_BUTCHERS]),
    );
    this.requiredHouses[HT_TANNERY] = Math.min(
      this.requiredHouses[HT_TANNERY],
      Math.ceil(stats.handHouseCount(this.owner, HT_SWINE) / 2 - this.cityStats.houses[HT_TANNERY]),
    );
    this.requiredHouses[HT_ARMOR_WORKSHOP] = Math.min(
      this.requiredHouses[HT_ARMOR_WORKSHOP],
      stats.handHouseTotalCount(this.owner, HT_TANNERY) * 2 - this.cityStats.houses[HT_ARMOR_WORKSHOP],
    );
    this.requiredHouses[HT_WEAPON_WORKSHOP] =
      this.requiredHouses[HT_WEAPON_WORKSHOP] *
      (this.requiredHouses[HT_TANNERY] > 0 || WEAP_WORKSHOP_DELAY < tick || tick > (this.peacetimeMinutes - 20) * 10 * 60 ? 1 : 0);

    this.requiredHouses[HT_COAL_MINE] =
      Math.max(planner.plannedHouses[HT_METALLURGISTS].count, this.requiredHouses[HT_GOLD_MINE]) -
      planner.plannedHouses[HT_COAL_MINE].count +
      stats.handHouseTotalCount(this.owner, HT_IRON_SMITHY) +
      stats.handHouseTotalCount(this.owner, HT_ARMOR_SMITHY) +
      stats.handHouseTotalCount(this.owner, HT_WEAPON_SMITHY) +
      1;
    this.requiredHouses[HT_COAL_MINE] -= this.decCoalMineCnt;
    this.requiredHouses[HT_GOLD_MINE] = Math.min(this.requiredHouses[HT_GOLD_MINE], this.maxGoldMineCnt);
  }

  /** UpdateState (816–834). */
  updateState(tick: number): void {
    const UPDATE_PRODUCTION = MAX_HANDS * 60 * 5; // 8100
    if (tick % UPDATE_PRODUCTION === this.owner) this.updateFinalProduction(0, true);
    this.requiredHouses.fill(0);
    this.updateCityStats();
    this.updateWareBalance();
    this.updateBasicHouses(tick, false);
    this.filterRequiredHouses(tick);
  }
}

// === END OF PART 2C ===

// ---------------------------------------------------------------------------------------------
// CityPlanner (KM_CityPlanner.pas)

/** THousePlan (KM_CityPlanner.pas 24–28). `loc` = the ENTRANCE (as in the Pascal, where plan.Loc
 *  equals the house entrance / AddHousePlan's argument). */
export interface PlannedHouse {
  placed: boolean;
  shortcutsCompleted: boolean;
  removeTreeInPlanProcedure: boolean;
  houseReservation: boolean;
  chopOnly: boolean;
  houseUid: number; // 0 = none
  loc: Pt;
  specPoint: Pt;
}

/** THousePlanArray (KM_CityPlanner.pas 29–35). */
export interface PlannedHouseArray {
  count: number;
  completed: number;
  underConstruction: number;
  planned: number;
  plans: PlannedHouse[];
}

/** TFieldMemory (KM_CityPlanner.pas 40–48). */
export interface FieldFarm {
  fieldAvailable: boolean;
  center: Pt;
  fieldType: FieldType;
  points: Pt[];
}

export interface FieldMemory {
  count: number;
  updateIdx: number;
  farms: FieldFarm[];
}

export const FARM_RADIUS = 11;
export const FIELDS_PER_FARM = 14;
export const FIELDS_PER_WINE = 9;

// HOUSE_DEPENDENCE (KM_CityPlanner.pas 189–220), keyed by script id, in the Pascal's set order
// (ascending TKMHouseType id — the order `for HT in set of TKMHouseType` iterates).
export const HOUSE_DEPENDENCE: number[][] = [];
HOUSE_DEPENDENCE[HT_ARMOR_SMITHY] = [HT_BARRACKS, HT_COAL_MINE, HT_IRON_MINE, HT_IRON_SMITHY];
HOUSE_DEPENDENCE[HT_ARMOR_WORKSHOP] = [HT_ARMOR_WORKSHOP, HT_BARRACKS, HT_SAWMILL, HT_TANNERY];
HOUSE_DEPENDENCE[HT_BAKERY] = [HT_BAKERY, HT_INN, HT_MILL, HT_STORE];
HOUSE_DEPENDENCE[HT_BARRACKS] = [HT_ARMOR_SMITHY, HT_ARMOR_WORKSHOP, HT_WEAPON_SMITHY, HT_WEAPON_WORKSHOP];
HOUSE_DEPENDENCE[HT_BUTCHERS] = [HT_BUTCHERS, HT_INN, HT_STORE, HT_SWINE];
HOUSE_DEPENDENCE[HT_COAL_MINE] = [HT_COAL_MINE, HT_GOLD_MINE, HT_IRON_MINE, HT_METALLURGISTS, HT_STORE];
HOUSE_DEPENDENCE[HT_FARM] = [HT_FARM, HT_MILL, HT_STABLES, HT_SWINE];
HOUSE_DEPENDENCE[HT_FISHER_HUT] = [HT_STORE];
HOUSE_DEPENDENCE[HT_GOLD_MINE] = [HT_METALLURGISTS, HT_STORE];
HOUSE_DEPENDENCE[HT_INN] = [HT_BAKERY, HT_BUTCHERS, HT_STORE, HT_VINEYARD];
HOUSE_DEPENDENCE[HT_IRON_MINE] = [HT_STORE];
HOUSE_DEPENDENCE[HT_IRON_SMITHY] = [HT_COAL_MINE, HT_IRON_MINE, HT_IRON_SMITHY, HT_WEAPON_SMITHY];
HOUSE_DEPENDENCE[HT_MARKET] = [HT_BARRACKS, HT_MARKET, HT_METALLURGISTS, HT_STORE];
HOUSE_DEPENDENCE[HT_METALLURGISTS] = [HT_COAL_MINE, HT_GOLD_MINE];
HOUSE_DEPENDENCE[HT_MILL] = [HT_BAKERY, HT_INN, HT_MILL];
HOUSE_DEPENDENCE[HT_QUARRY] = [HT_STORE];
HOUSE_DEPENDENCE[HT_SAWMILL] = [HT_ARMOR_WORKSHOP, HT_SAWMILL, HT_WEAPON_WORKSHOP];
HOUSE_DEPENDENCE[HT_SCHOOL] = [HT_METALLURGISTS, HT_SCHOOL, HT_STORE];
HOUSE_DEPENDENCE[HT_SIEGE_WORKSHOP] = [HT_IRON_SMITHY, HT_SAWMILL, HT_SIEGE_WORKSHOP, HT_STORE];
HOUSE_DEPENDENCE[HT_STABLES] = [HT_BARRACKS, HT_FARM, HT_STABLES];
HOUSE_DEPENDENCE[HT_STORE] = [HT_BARRACKS, HT_INN, HT_SCHOOL];
HOUSE_DEPENDENCE[HT_SWINE] = [HT_BUTCHERS, HT_FARM, HT_SWINE];
HOUSE_DEPENDENCE[HT_TANNERY] = [HT_ARMOR_WORKSHOP, HT_BARRACKS, HT_TANNERY];
HOUSE_DEPENDENCE[HT_TOWN_HALL] = [HT_METALLURGISTS, HT_TOWN_HALL, HT_STORE];
HOUSE_DEPENDENCE[HT_WATCHTOWER] = [HT_STORE];
HOUSE_DEPENDENCE[HT_WEAPON_SMITHY] = [HT_BARRACKS, HT_COAL_MINE, HT_IRON_MINE, HT_IRON_SMITHY];
HOUSE_DEPENDENCE[HT_WEAPON_WORKSHOP] = [HT_BARRACKS, HT_SAWMILL, HT_WEAPON_WORKSHOP];
HOUSE_DEPENDENCE[HT_VINEYARD] = [HT_COAL_MINE, HT_INN, HT_QUARRY];
HOUSE_DEPENDENCE[HT_WOODCUTTERS] = [HT_STORE];
for (let i = 0; i < 30; i++) if (HOUSE_DEPENDENCE[i] === undefined) HOUSE_DEPENDENCE[i] = [];

/** TKMFieldEvaluation (KM_CityPlanner.pas 70–91, 2971–3082): the field fertility flood. */
class FieldEvaluation {
  owner = 0;
  fieldEval = new Int8Array((2 * FARM_RADIUS + 1) * (2 * FARM_RADIUS + 1));
  fieldPrice = new Int16Array((2 * FARM_RADIUS + 1) * (2 * FARM_RADIUS + 1));
  private world: EconomyWorld;
  private influences: Influences;
  private initPoint: Pt = kmPoint(0, 0);
  private fieldType: FieldType = 'none';

  constructor(world: EconomyWorld, influences: Influences) {
    this.world = world;
    this.influences = influences;
  }

  private at(k: number, l: number): number {
    return (l + FARM_RADIUS) * (2 * FARM_RADIUS + 1) + (k + FARM_RADIUS);
  }

  private canBeVisited(x: number, y: number): boolean {
    const k = x - this.initPoint.x;
    const l = y - this.initPoint.y;
    return (
      k >= -FARM_RADIUS && l >= -FARM_RADIUS && k <= FARM_RADIUS && l <= FARM_RADIUS &&
      this.fieldPrice[this.at(k, l)] === 0 &&
      this.world.tileInMapCoords(x, y) &&
      this.world.tileWalkable(x, y) &&
      this.influences.getAvoid(x, y) !== AVOID_BUILDING_HOUSE_INSIDE_LOCK
    );
  }

  private markAsVisited(x: number, y: number, dist: number): void {
    const k = x - this.initPoint.x;
    const l = y - this.initPoint.y;
    this.fieldPrice[this.at(k, l)] = dist;
    const ab = this.influences.getAvoid(x, y);
    if (ab === AVOID_BUILDING_UNLOCK || ab === AVOID_BUILDING_HOUSE_OUTSIDE_LOCK) {
      if (this.world.tileHasCornField(x, y)) this.fieldEval[this.at(k, l)] = 2; // feExistingField
      else if (this.world.canAddFieldPlan(this.owner, x, y, this.fieldType)) this.fieldEval[this.at(k, l)] = 1; // feFertileTile
      else this.fieldEval[this.at(k, l)] = 3; // feObstacle
    } else if (ab === AVOID_BUILDING_NODE_LOCK_FIELD) {
      this.fieldEval[this.at(k, l)] = 2;
    }
  }

  /** EvalField (3055–3076). */
  evalField(maxDist: number, initPoint: Pt, fieldType: FieldType): void {
    this.fieldEval.fill(0);
    this.fieldPrice.fill(0);
    this.initPoint = initPoint;
    this.fieldType = fieldType;
    const queue: { x: number; y: number; d: number }[] = [];
    const insert = (x: number, y: number, d: number): void => {
      this.markAsVisited(x, y, d);
      queue.push({ x, y, d });
    };
    if (this.canBeVisited(initPoint.x, initPoint.y)) insert(initPoint.x, initPoint.y, 1);
    let head = 0;
    while (head < queue.length) {
      const cur = queue[head++];
      if (cur.d >= maxDist) continue;
      const d = cur.d + 1;
      if (cur.x > 0 && this.canBeVisited(cur.x - 1, cur.y)) insert(cur.x - 1, cur.y, d);
      if (cur.x < this.world.mapX - 1 && this.canBeVisited(cur.x + 1, cur.y)) insert(cur.x + 1, cur.y, d);
      if (cur.y > 0 && this.canBeVisited(cur.x, cur.y - 1)) insert(cur.x, cur.y - 1, d);
      if (cur.y < this.world.mapY - 1 && this.canBeVisited(cur.x, cur.y + 1)) insert(cur.x, cur.y + 1, d);
    }
  }
}

/**
 * TKMCityPlanner: the city layout — house/mine/quarry/woodcutter placement, field planning and
 * road planning. Plans are only data here; CityBuilder turns them into the world's plans.
 */
export class CityPlanner {
  owner: number;
  readonly predictor: CityPredictor;
  readonly plannedHouses: PlannedHouseArray[] = [];
  fields: FieldMemory = { count: 0, updateIdx: 0, farms: [] };
  forestsInfo: ForestsInfo = { count: 0, forests: [] };
  constructedHouses = 0;
  defenceTowersPlanned = false;
  stonesDepleted = false;

  private readonly world: EconomyWorld;
  private readonly eye: Eye;
  private readonly influences: Influences;
  private readonly fieldEval: FieldEvaluation;
  private builder: CityBuilder | null = null;

  constructor(world: EconomyWorld, owner: number, eye: Eye, influences: Influences, predictor: CityPredictor) {
    this.world = world;
    this.owner = owner;
    this.eye = eye;
    this.influences = influences;
    this.predictor = predictor;
    this.fieldEval = new FieldEvaluation(world, influences);
    for (let ht = 0; ht < 30; ht++) {
      this.plannedHouses.push({ count: 0, completed: 0, underConstruction: 0, planned: 0, plans: [] });
    }
  }

  link(builder: CityBuilder): void {
    this.builder = builder;
  }

  ownerUpdate(hand: number): void {
    this.owner = hand;
  }

  afterMissionInit(): void {
    this.updateState(0);
  }

  /** UpdateState (427–560): connect actual houses to the plan, recount, chop-only woodcutters. */
  updateState(tick: number): void {
    const checkChopOnly = tick % (MAX_HANDS * 100) === this.owner;
    for (const h of this.world.houses) {
      if (h.owner !== this.owner || h.destroyed) continue;
      const ht = h.typeId;
      let checkExistHouse = false;
      const arr = this.plannedHouses[ht];
      for (let k = 0; k < arr.count; k++) {
        if (arr.plans[k].loc.x === h.entrance.x && arr.plans[k].loc.y === h.entrance.y) {
          if (arr.plans[k].houseUid !== h.uid) {
            if (this.builder !== null) this.builder.unlockHouseLoc(ht, h.entrance);
            if (ht === HT_WOODCUTTERS) {
              this.influences.markForest(
                arr.plans[k].specPoint,
                AI_PAR.PLANNER_FOREST_FindPlaceForWoodcutter_Radius,
                Math.min(AI_PAR.PLANNER_FOREST_FindPlaceForWoodcutter_ABRange, AVOID_BUILDING_FOREST_RANGE - 1) /
                  (AI_PAR.PLANNER_FOREST_FindPlaceForWoodcutter_Radius * AI_PAR.PLANNER_FOREST_FindPlaceForWoodcutter_Radius),
                true,
              );
            }
            arr.plans[k].houseUid = h.uid;
          }
          checkExistHouse = true;
          break;
        }
      }
      if (!checkExistHouse) {
        // A house added by the script (or a mission house): add a placed plan.
        this.addPlan(ht, h.entrance, h.flagPoint ?? kmPoint(0, 0), false);
        const plan = arr.plans[arr.count - 1];
        plan.houseUid = h.uid;
        plan.placed = true;
      }
    }

    // Check whether the existing houses are completed / destroyed.
    this.constructedHouses = 0;
    for (let ht = 0; ht < 30; ht++) {
      let completedHouses = 0;
      let housesUnderConstruction = 0;
      let plannedHouses = 0;
      const arr = this.plannedHouses[ht];
      for (let i = 0; i < arr.count; i++) {
        const plan = arr.plans[i];
        const house = plan.houseUid !== 0 ? this.world.houseByUid(plan.houseUid) : null;
        const houseExist = house !== null && !house.destroyed;
        plan.placed = houseExist || hasHousePlan(this.world, this.owner, plan.loc.x, plan.loc.y);
        if (plan.placed) {
          if (houseExist && house !== null && house.buildState === 'done') {
            completedHouses += 1;
          } else {
            this.constructedHouses += 1;
            housesUnderConstruction += 1;
          }
          if (ht === HT_WOODCUTTERS && houseExist && house !== null) {
            if (plan.chopOnly && house.buildState === 'done') completedHouses -= 1;
            if (house.buildState === 'done') this.checkWoodcutter(plan, house, checkChopOnly);
          }
        } else if (plan.houseReservation || plan.removeTreeInPlanProcedure) {
          plannedHouses += 1;
        } else {
          plan.houseUid = 0; // destroyed: drop the pointer
        }
      }
      arr.completed = completedHouses;
      arr.underConstruction = housesUnderConstruction;
      arr.planned = plannedHouses;
    }
  }

  /** CheckWoodcutter (439–463) + ScanChopOnly (428–437). */
  private checkWoodcutter(plan: PlannedHouse, house: EconHouse, checkChopOnly: boolean): void {
    // Set the cutting point once (the Pascal's W.IsFlagPointSet).
    if ((plan.specPoint.x !== 0 || plan.specPoint.y !== 0) && (house.flagPoint === undefined || house.flagPoint === null)) {
      this.world.setHouseFlagPoint(house.uid, plan.specPoint.x, plan.specPoint.y);
    }
    const point = house.flagPoint ?? kmPoint(house.entrance.x, house.entrance.y + 1);
    if (plan.chopOnly && this.influences.getAvoid(point.x, point.y) < AVOID_BUILDING_FOREST_MINIMUM) {
      if (checkChopOnly) {
        // ScanChopOnly: no trees left and no trunk -> demolish.
        if (this.world.handWareBalance(this.owner, WT_TRUNK) === 0 && !this.world.canFindTree(point.x, point.y, 10, true)) {
          this.removePlanByLoc(HT_WOODCUTTERS, house.entrance);
          this.world.demolishHouseByUid(house.uid, this.owner);
        }
      }
      // WoodcutterMode := wmChop — planting is out of the v0 economy slice (no-op, flagged).
    }
  }

  // ---- plans -------------------------------------------------------------------------------

  /** AddPlan (563–588). */
  addPlan(typeId: number, loc: Pt, specPoint: Pt = kmPoint(0, 0), chopOnly = false): void {
    const arr = this.plannedHouses[typeId];
    const plan: PlannedHouse = {
      placed: false,
      shortcutsCompleted: false,
      removeTreeInPlanProcedure: false,
      houseReservation: false,
      chopOnly,
      houseUid: 0,
      loc: kmPoint(loc.x, loc.y),
      specPoint: kmPoint(specPoint.x, specPoint.y),
    };
    arr.plans.push(plan);
    arr.count += 1;
  }

  /** GetPlan (591–715): the best unplaced plan (mines filtered when exhausted). */
  getPlan(typeId: number, onlyLatest: boolean): { loc: Pt; idx: number } | null {
    const MAX_BID = 1000000;
    const CHOP_ONLY_ADVANTAGE = 200;
    const arr = this.plannedHouses[typeId];

    const isExhaustedMine = (loc: Pt, isGold: boolean): boolean => {
      for (let x = Math.max(loc.x - 4, 1); x <= Math.min(loc.x + 3, this.world.mapX - 1); x++) {
        for (let y = Math.max(loc.y - 8, 1); y <= loc.y; y++) {
          if (!isGold && this.world.tileHasIron(x, y)) return false;
          if (isGold && this.world.tileHasGold(x, y)) return false;
        }
      }
      return true;
    };
    const isExhaustedQuarry = (loc: Pt): boolean => {
      const RADIUS = 15;
      for (let y = Math.max(loc.y - RADIUS, 1); y <= Math.min(loc.y + RADIUS, this.world.mapY - 1); y++) {
        for (let x = Math.max(loc.x - RADIUS, 1); x <= Math.min(loc.x + RADIUS, this.world.mapX - 1); x++) {
          if (this.world.tileHasStone(x, y)) return false;
        }
      }
      return true;
    };
    const isExhaustedCoalMine = (loc: Pt): boolean => {
      for (const off of this.eye.mapping[HT_COAL_MINE].tiles) {
        if (this.world.tileHasCoal(loc.x + off.x, loc.y + off.y)) return false;
      }
      return true;
    };
    const checkMine = (idx: number): boolean => {
      const loc = arr.plans[idx].loc;
      let exhausted = false;
      if (typeId === HT_GOLD_MINE) exhausted = isExhaustedMine(loc, true);
      else if (typeId === HT_IRON_MINE) exhausted = isExhaustedMine(loc, false);
      else if (typeId === HT_COAL_MINE) exhausted = isExhaustedCoalMine(loc);
      else if (typeId === HT_QUARRY) exhausted = isExhaustedQuarry(loc);
      if (exhausted) this.removePlan(typeId, idx);
      return exhausted;
    };

    let bestBid = MAX_BID;
    let bestIdx = 0;
    for (let i = arr.count - 1; i >= 0; i--) {
      const plan = arr.plans[i];
      if (plan.placed) continue;
      if (plan.removeTreeInPlanProcedure || this.eye.canAddHousePlan(plan.loc, typeId, true, true)) {
        if ((typeId === HT_GOLD_MINE || typeId === HT_IRON_MINE || typeId === HT_COAL_MINE || typeId === HT_QUARRY) && checkMine(i)) continue;
        const bid =
          this.obstaclesInHousePlan(typeId, plan.loc) -
          this.influences.getOwnership(this.owner, plan.loc.x, plan.loc.y) -
          (typeId === HT_WOODCUTTERS && plan.chopOnly ? CHOP_ONLY_ADVANTAGE : 0);
        if (bid < bestBid) {
          bestBid = bid;
          bestIdx = i;
        }
        if (onlyLatest) break;
      } else {
        this.removePlan(typeId, i);
      }
    }
    if (bestBid === MAX_BID) return null;
    return { loc: kmPoint(arr.plans[bestIdx].loc.x, arr.plans[bestIdx].loc.y), idx: bestIdx };
  }

  /** MarkAsExhausted (718–730): drop the plan; a coal mine may become a vineyard. */
  markAsExhausted(typeId: number, loc: Pt): void {
    const isOrCanBeRoad = (x: number, y: number): boolean =>
      this.world.tileWalkableRoad(x, y) ||
      this.world.hasFieldPlan(this.owner, x, y) === 'road' ||
      this.world.tileLockAt(x, y) === 3;
    this.removePlanByLoc(typeId, loc);
    if (typeId === HT_COAL_MINE && isOrCanBeRoad(loc.x + 1, loc.y + 1)) this.addPlan(HT_VINEYARD, kmPoint(loc.x + 1, loc.y));
  }

  /** RemoveHouseType (733–787): the plan with the fewest wares, or an unplaced plan. */
  removeHouseType(typeId: number): void {
    const INIT_BID = 10000;
    const RESOURCE_PRICE = 1;
    const PRODUCT_PRICE = 5;
    const MAX_BID = 8;
    const arr = this.plannedHouses[typeId];
    let bestBid = INIT_BID;
    let bestIdx = -1;
    for (let idx = 0; idx < arr.count; idx++) {
      const plan = arr.plans[idx];
      if (!plan.placed) {
        bestBid = 0;
        bestIdx = idx;
        break;
      }
      if (plan.houseUid === 0) {
        bestBid = 0;
        bestIdx = idx;
      } else {
        const house = this.world.houseByUid(plan.houseUid);
        if (house === null) continue;
        let wares = 0;
        for (let w = 0; w < WARE_CNT; w++) wares += this.world.wareCount(house, w);
        const bid = wares * RESOURCE_PRICE;
        if (bid < bestBid) {
          bestBid = bid;
          bestIdx = idx;
        }
      }
    }
    if (bestBid < MAX_BID && bestIdx >= 0) {
      const plan = arr.plans[bestIdx];
      if (plan.placed) {
        if (plan.houseUid === 0) this.world.remHousePlan(this.owner, plan.loc.x, plan.loc.y);
        else this.world.demolishHouseByUid(plan.houseUid, this.owner);
      }
      this.removePlan(typeId, bestIdx);
    }
  }

  /** RemovePlan (789–799) by location. */
  removePlanByLoc(typeId: number, loc: Pt): void {
    const arr = this.plannedHouses[typeId];
    for (let i = 0; i < arr.count; i++) {
      if (arr.plans[i].loc.x === loc.x && arr.plans[i].loc.y === loc.y) {
        this.removePlan(typeId, i);
        return;
      }
    }
  }

  /** RemovePlan (801–812): swap-remove; an unplaced plan unlocks its reservation. */
  removePlan(typeId: number, idx: number): void {
    const arr = this.plannedHouses[typeId];
    if (idx >= arr.count) return;
    const plan = arr.plans[idx];
    if (plan.houseUid === 0 && this.builder !== null) this.builder.unlockHouseLoc(typeId, plan.loc);
    arr.count -= 1;
    arr.plans[idx] = arr.plans[arr.count];
    arr.plans.length = arr.count;
  }

  /** GetHousePlan (815–860). */
  getHousePlan(ignoreTrees: boolean, ignoreExistingPlans: boolean, typeId: number): { loc: Pt; idx: number } | null {
    if (!ignoreExistingPlans) {
      const plan = this.getPlan(typeId, false);
      if (plan !== null) return plan;
    }
    // The search runs when there is no usable plan or when existing plans may be ignored
    // (the Pascal: `else begin case aHT of … end; Output := GetPlan(aHT, True, …); end;`).
    this.findNewPlan(typeId, ignoreTrees);
    return this.getPlan(typeId, true);
  }

  private findNewPlan(typeId: number, ignoreTrees: boolean): void {
    if (typeId === HT_WOODCUTTERS) {
      this.findForestAndWoodcutter();
    } else if (typeId === HT_GOLD_MINE || typeId === HT_IRON_MINE) {
      this.findPlaceForMines(typeId);
    } else if (typeId === HT_COAL_MINE) {
      const loc = this.findPlaceForMines(typeId);
      if (loc !== null && this.builder !== null) this.builder.lockHouseLoc(HT_COAL_MINE, loc);
    } else if (typeId === HT_QUARRY) {
      this.checkStoneReserves(true, 0);
    } else if (typeId === HT_WATCHTOWER) {
      if (!this.defenceTowersPlanned) {
        this.defenceTowersPlanned = true;
        this.planDefenceTowers();
      }
    } else {
      const locs = this.findPlaceForHouse(ignoreTrees, typeId);
      if (locs.length > 0) {
        const loc = locs[0];
        this.addPlan(typeId, loc);
        if (this.builder !== null) this.builder.lockHouseLoc(typeId, loc);
        this.findForestAround(loc, false);
      }
    }
  }

  /** GetRoadToHouse (863–1016). Returns the road tile list (aFieldType = ftRoad). */
  getRoadToHouse(typeId: number, idx: number): Pt[] | null {
    const arr = this.plannedHouses[typeId];
    if (idx >= arr.count) return null;
    const newLoc = arr.plans[idx].loc;
    const isRoad = (p: Pt): boolean =>
      this.influences.getAvoid(p.x, p.y) === AVOID_BUILDING_NODE_LOCK_ROAD ||
      this.world.tileWalkableRoad(p.x, p.y) ||
      this.world.hasFieldPlan(this.owner, p.x, p.y) === 'road' ||
      this.world.tileLockAt(p.x, p.y) === 3;
    const field: Pt[] = [];

    // Find the closest placed house entrance.
    let bestDist = 1000000;
    let existLoc: Pt | null = null;
    for (let ht = 0; ht < 30; ht++) {
      const other = this.plannedHouses[ht];
      for (let k = 0; k < other.count; k++) {
        const plan = other.plans[k];
        if (!plan.placed) continue;
        if (plan.removeTreeInPlanProcedure) continue;
        if (plan.loc.x === newLoc.x && plan.loc.y === newLoc.y) continue;
        if (ht === HT_WOODCUTTERS && plan.chopOnly) continue;
        if (typeId === HT_SCHOOL && plan.houseReservation) continue;
        const dist = Math.abs(plan.loc.x - newLoc.x) + Math.abs(plan.loc.y - newLoc.y) * 1.5;
        const watchtowerOk = typeId !== HT_WATCHTOWER || ht !== HT_WATCHTOWER || dist < 10;
        if (dist < bestDist && watchtowerOk) {
          bestDist = dist;
          existLoc = plan.loc;
        }
      }
    }
    if (existLoc === null) {
      this.removePlan(typeId, idx);
      return null;
    }
    const route = roadRoute(this.world, this.influences, this.owner, kmPoint(newLoc.x, newLoc.y + 1), kmPoint(existLoc.x, existLoc.y + 1), 'roads');
    const MAX_ROAD_DISTANCE = 90;
    if (route === null || (!(route.length < MAX_ROAD_DISTANCE) && typeId !== HT_WATCHTOWER)) {
      this.removePlan(typeId, idx);
      if (typeId === HT_GOLD_MINE || typeId === HT_IRON_MINE || typeId === HT_COAL_MINE) this.predictor.markExhaustedMine(typeId);
      return null;
    }
    for (const p of route) field.push(p);
    this.replaceOverlappingRoad(typeId, newLoc, field);
    // Watchtower roads into enemy influence are rejected (CheckRoadToTowers 949–967).
    if (typeId === HT_WATCHTOWER) {
      const MAX_ENEMY_INFLUENCE = 150;
      for (let k = 0; k < field.length; k += 5) {
        if (this.influences.getBestAllianceOwnership(this.owner, field[k].x, field[k].y, 'enemy') > MAX_ENEMY_INFLUENCE) {
          this.removePlan(typeId, idx);
          return null;
        }
      }
    }
    return field;
  }

  /** ReplaceOverlappingRoad (872–914): route around roads inside the new plan. */
  private replaceOverlappingRoad(typeId: number, loc: Pt, field: Pt[]): void {
    const VECTORS = [kmPoint(0, 1), kmPoint(1, 0), kmPoint(0, -1), kmPoint(-1, 0)];
    const isRoad = (p: Pt): boolean =>
      this.influences.getAvoid(p.x, p.y) === AVOID_BUILDING_NODE_LOCK_ROAD ||
      this.world.tileWalkableRoad(p.x, p.y) ||
      this.world.hasFieldPlan(this.owner, p.x, p.y) === 'road' ||
      this.world.tileLockAt(p.x, p.y) === 3;
    const road: Pt[] = [];
    for (const off of this.eye.mapping[typeId].tiles) {
      const p = kmPoint(loc.x + off.x, loc.y + off.y);
      if (isRoad(p)) road.push(p);
    }
    const insideCount = road.length;
    if (insideCount === 0) return;
    for (let i = insideCount - 1; i >= 0; i--) {
      for (const v of VECTORS) {
        const p = kmPoint(road[i].x + v.x, road[i].y + v.y);
        if (isRoad(p) && !road.some((r) => r.x === p.x && r.y === p.y)) road.push(p);
      }
    }
    const point = road[insideCount];
    if (point === undefined) return;
    for (let i = insideCount + 1; i < road.length; i++) {
      const path = roadRoute(this.world, this.influences, this.owner, road[i], point, 'shortcuts');
      if (path !== null) for (const p of path) field.push(p);
    }
  }

  /** GetRoadBetweenPoints (1019–1028) — the shortcut planner. */
  getRoadBetweenPoints(start: Pt, end: Pt): Pt[] | null {
    return roadRoute(this.world, this.influences, this.owner, end, start, 'shortcuts');
  }

  /** GetFieldToHouse (1031–1042). */
  getFieldToHouse(typeId: number, idx: number, field: Pt[]): FieldType | null {
    if (typeId !== HT_FARM && typeId !== HT_VINEYARD) return null;
    const fieldType: FieldType = typeId === HT_VINEYARD ? 'wine' : 'corn';
    field.length = 0;
    const cnt = typeId === HT_VINEYARD ? FIELDS_PER_WINE : FIELDS_PER_FARM;
    this.planFields(cnt, this.plannedHouses[typeId].plans[idx].loc, fieldType, field);
    return fieldType;
  }

  /** GetTreesInHousePlan (1045–1065). */
  getTreesInHousePlan(typeId: number, idx: number, field: Pt[]): number {
    field.length = 0;
    const loc = this.plannedHouses[typeId].plans[idx].loc;
    const map = this.eye.mapping[typeId];
    for (const off of map.tiles) {
      const p = kmPoint(loc.x + off.x, loc.y + off.y);
      if (this.world.treeAt(p.x, p.y) !== null) field.push(p);
    }
    if (field.length > 0) {
      for (const off of map.tiles) {
        const p = kmPoint(loc.x + off.x, loc.y + off.y);
        if (this.influences.getAvoid(p.x, p.y) === 0) this.influences.setAvoid(p.x, p.y, 10);
      }
    }
    return field.length;
  }

  /** CheckFields (1177–1223): repair the next farm's missing fields. */
  checkFields(fieldType: FieldType, nodeList: Pt[]): boolean {
    if (this.fields.count <= 0) return false;
    this.fields.updateIdx = (this.fields.updateIdx + 1) % this.fields.count;
    const farm = this.fields.farms[this.fields.updateIdx];
    if (!farm.fieldAvailable) return false;
    const isWine = (p: Pt): boolean =>
      this.world.tileHasWineField(p.x, p.y) ||
      this.world.hasFieldPlan(this.owner, p.x, p.y) === 'wine' ||
      this.world.tileLockAt(p.x, p.y) === 4 ||
      (this.influences.getAvoid(p.x, p.y) === AVOID_BUILDING_NODE_LOCK_FIELD && this.world.canAddFieldPlan(this.owner, p.x, p.y, 'wine'));
    const isField = (p: Pt): boolean =>
      this.world.tileHasCornField(p.x, p.y) ||
      this.world.hasFieldPlan(this.owner, p.x, p.y) === 'corn' ||
      this.world.tileLockAt(p.x, p.y) === 4 ||
      (this.influences.getAvoid(p.x, p.y) === AVOID_BUILDING_NODE_LOCK_FIELD && this.world.canAddFieldPlan(this.owner, p.x, p.y, 'corn'));
    const fldType = farm.fieldType;
    const expectedCnt = fldType === 'corn' ? FIELDS_PER_FARM : fldType === 'wine' ? FIELDS_PER_WINE : 0;
    let cnt = expectedCnt;
    for (let k = expectedCnt - 1; k >= 0; k--) {
      const p = farm.points[k];
      const valid = (p.x !== 0 || p.y !== 0) && (fldType === 'wine' ? isWine(p) : fldType === 'corn' ? isField(p) : false);
      if (!valid) {
        cnt -= 1;
        farm.points[k] = farm.points[cnt];
        farm.points[cnt] = kmPoint(0, 0);
      }
    }
    if (expectedCnt - cnt > 1) {
      this.planFields(expectedCnt - cnt, farm.center, fldType, nodeList, this.fields.updateIdx, cnt);
    }
    return nodeList.length > 0;
  }

  /** PlanFields (1226–1455): the 11×11 field grid algorithm. */
  planFields(cnt: number, loc: Pt, fieldType: FieldType, nodeList: Pt[], replaceFarmIdx = -1, replaceFieldIdx = 0): void {
    const NOBUILD = 0;
    const BSBUILD_TILE = 1;
    const BSBUILD_SQUARE = 2;
    const FIELD_EXIST = 4;
    const FERTILE = 8;
    const MIN_PRICE = -100000;
    const W = 2 * FARM_RADIUS + 1;
    const build = new Uint8Array(W * W);
    const price = new Int32Array(W * W);
    const at = (x: number, y: number): number => (y + FARM_RADIUS) * W + (x + FARM_RADIUS);

    const checkBit = (x: number, y: number, bit: number): boolean => {
      let any = false;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if ((build[at(x + dx, y + dy)] & bit) === 0) any = true;
        }
      }
      return any;
    };
    const addBit = (x: number, y: number, bit: number): void => {
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) build[at(x + dx, y + dy)] |= bit;
    };
    const removeBit = (x: number, y: number, bit: number): void => {
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) build[at(x + dx, y + dy)] &= ~bit;
    };

    this.eye.buildFF.updateState();
    const belowLoc = kmPoint(loc.x, loc.y + 1);
    this.fieldEval.evalField(FARM_RADIUS, belowLoc, fieldType);

    // Find the build areas (11×11).
    for (let y = -FARM_RADIUS; y <= FARM_RADIUS; y++) {
      for (let x = -FARM_RADIUS; x <= FARM_RADIUS; x++) {
        const tx = belowLoc.x + x;
        const ty = belowLoc.y + y;
        const st = this.eye.buildFF.getState(tx, ty);
        build[at(x, y)] = BSBUILD_TILE * (this.world.tileInMapCoords(tx, ty) && (st === BS_BUILD || st === BS_TREE) ? 1 : 0);
      }
    }
    for (let y = -FARM_RADIUS + 1; y <= FARM_RADIUS - 1; y++) {
      for (let x = -FARM_RADIUS + 1; x <= FARM_RADIUS - 1; x++) {
        if (!checkBit(x, y, BSBUILD_TILE)) addBit(x, y, BSBUILD_SQUARE);
      }
    }
    // Fertility.
    for (let y = -FARM_RADIUS + 1; y <= FARM_RADIUS - 1; y++) {
      for (let x = -FARM_RADIUS + 1; x <= FARM_RADIUS - 1; x++) {
        const ev = this.fieldEval.fieldEval[at(x, y)];
        if (ev === 2) build[at(x, y)] = FIELD_EXIST;
        else if (ev === 1) build[at(x, y)] |= FERTILE;
      }
    }
    // Evaluate.
    const canBuild = round(AI_PAR.PLANNER_FARM_PlanFields_CanBuild);
    const fieldNearby = round(AI_PAR.PLANNER_FARM_PlanFields_ExistField);
    const distance = round(AI_PAR.PLANNER_FARM_PlanFields_Dist);
    const priceOf = (x: number, y: number): number =>
      (build[at(x, y)] & FERTILE) > 0
        ? -((build[at(x, y)] & BSBUILD_SQUARE) > 0 ? canBuild : 0) +
          (checkBit(x, y, FIELD_EXIST) ? fieldNearby : 0) +
          (FARM_RADIUS - this.fieldEval.fieldPrice[at(x, y)]) * distance
        : MIN_PRICE;
    for (let y = -FARM_RADIUS + 1; y <= FARM_RADIUS - 1; y++) {
      for (let x = -FARM_RADIUS + 1; x <= FARM_RADIUS - 1; x++) price[at(x, y)] = priceOf(x, y);
    }
    // Select fields.
    let k = 0;
    let bestX = 0;
    let bestY = 0;
    while (k < cnt) {
      let bestPrice = MIN_PRICE;
      for (let y = -FARM_RADIUS + 1; y <= FARM_RADIUS - 1; y++) {
        for (let x = -FARM_RADIUS + 1; x <= FARM_RADIUS - 1; x++) {
          if (price[at(x, y)] > bestPrice) {
            bestPrice = price[at(x, y)];
            bestX = x;
            bestY = y;
          }
        }
      }
      if (bestPrice === MIN_PRICE) break;
      if ((build[at(bestX, bestY)] & BSBUILD_SQUARE) > 0) {
        build[at(bestX, bestY)] = FIELD_EXIST;
        removeBit(bestX, bestY, BSBUILD_SQUARE);
        const x1 = Math.max(-FARM_RADIUS + 1, bestX - 2);
        const x2 = Math.min(FARM_RADIUS - 1, bestX + 2);
        for (let y = Math.max(-FARM_RADIUS + 1, bestY - 2); y <= Math.min(FARM_RADIUS - 1, bestY + 2); y++) {
          if (!checkBit(x1, y, BSBUILD_TILE)) addBit(x1, y, BSBUILD_SQUARE);
          if (!checkBit(x2, y, BSBUILD_TILE)) addBit(x2, y, BSBUILD_SQUARE);
        }
        const y1 = Math.max(-FARM_RADIUS + 1, bestY - 2);
        const y2 = Math.min(FARM_RADIUS - 1, bestY + 2);
        for (let x = Math.max(-FARM_RADIUS + 1, bestX - 2); x <= Math.min(FARM_RADIUS - 1, bestX + 2); x++) {
          if (!checkBit(x, y1, BSBUILD_TILE)) addBit(x, y1, BSBUILD_SQUARE);
          if (!checkBit(x, y2, BSBUILD_TILE)) addBit(x, y2, BSBUILD_SQUARE);
        }
      } else {
        build[at(bestX, bestY)] = FIELD_EXIST;
      }
      for (let y = bestY - 1; y <= bestY + 1; y++) {
        for (let x = bestX - 1; x <= bestX + 1; x++) price[at(x, y)] = priceOf(x, y);
      }
      const farmIdx = replaceFarmIdx !== -1 ? replaceFarmIdx : this.fields.count;
      while (this.fields.farms.length <= farmIdx) {
        this.fields.farms.push({ fieldAvailable: false, center: kmPoint(0, 0), fieldType: 'none', points: new Array<Pt>(FIELDS_PER_FARM).fill(kmPoint(0, 0)) });
      }
      const farm = this.fields.farms[farmIdx];
      const p = kmPoint(bestX + belowLoc.x, bestY + belowLoc.y);
      farm.points[k + replaceFieldIdx] = p;
      nodeList.push(p);
      k += 1;
    }
    const farmIdx = replaceFarmIdx !== -1 ? replaceFarmIdx : this.fields.count;
    while (this.fields.farms.length <= farmIdx) {
      this.fields.farms.push({ fieldAvailable: false, center: kmPoint(0, 0), fieldType: 'none', points: new Array<Pt>(FIELDS_PER_FARM).fill(kmPoint(0, 0)) });
    }
    const farm = this.fields.farms[farmIdx];
    farm.center = kmPoint(loc.x, loc.y);
    farm.fieldType = fieldType;
    farm.fieldAvailable = k >= cnt;
    if (replaceFarmIdx === -1) this.fields.count += 1;
  }

  /** ObstaclesInHousePlan (1458–1473). */
  obstaclesInHousePlan(typeId: number, loc: Pt): number {
    let road = 0;
    let tree = 0;
    for (const off of this.eye.mapping[typeId].tiles) {
      const x = loc.x + off.x;
      const y = loc.y + off.y;
      if (this.world.treeAt(x, y) !== null) tree += 1;
      if (this.world.tileWalkableRoad(x, y)) road += 1;
    }
    return tree * AI_PAR.PLANNER_ObstaclesInHousePlan_Tree + road * AI_PAR.PLANNER_ObstaclesInHousePlan_Road;
  }

  /** FieldCrit (1476–1505). */
  fieldCrit(typeId: number, loc: Pt): number {
    const MIN_CORN_FIELDS = 15;
    const MIN_WINE_FIELDS = 9;
    const DECREASE_CRIT = 1000;
    let fields = 0;
    const maxDist = (typeId === HT_VINEYARD ? 2 : 0) + (typeId === HT_FARM ? 5 : 0);
    for (let dist = 1; dist <= maxDist; dist++) {
      for (let dir = 0; dir < 4; dir++) {
        const list = this.eye.mapping[typeId].surroundings[dist][dir];
        for (let i = dist; i <= list.length - dist; i++) {
          const x = loc.x + list[i].x;
          const y = loc.y + list[i].y;
          if (!this.world.tileInMapCoords(x, y)) continue;
          if (this.influences.getAvoid(x, y) !== 0) continue;
          if (this.world.canAddFieldPlan(this.owner, x, y, 'corn')) fields += 1;
        }
      }
    }
    return (
      -(Math.max(0, MIN_WINE_FIELDS - fields) * (typeId === HT_VINEYARD ? 1 : 0) * DECREASE_CRIT +
        Math.max(0, MIN_CORN_FIELDS - fields) * (typeId === HT_FARM ? 1 : 0) * DECREASE_CRIT) -
      this.eye.routes[this.index(loc.x, loc.y)] * AI_PAR.PLANNER_FARM_FieldCrit_PolyRoute -
      this.eye.flatArea[this.index(loc.x, loc.y)] * AI_PAR.PLANNER_FARM_FieldCrit_FlatArea +
      this.eye.soil[this.index(loc.x, loc.y)] * AI_PAR.PLANNER_FARM_FieldCrit_Soil
    );
  }

  /** SnapCrit (1508–1568). */
  snapCrit(typeId: number, loc: Pt): number {
    const isPlan = (p: Pt, lock: number, field: FieldType): boolean =>
      this.world.hasFieldPlan(this.owner, p.x, p.y) === field || this.world.tileLockAt(p.x, p.y) === lock;
    const isRoad = (ab: number, p: Pt): boolean =>
      ab === AVOID_BUILDING_NODE_LOCK_ROAD || this.world.tileWalkableRoad(p.x, p.y) || isPlan(p, 3, 'road');
    let output = 0;
    const list = this.eye.mapping[typeId].surroundings[1];
    for (let dir = 0; dir < 4; dir++) {
      const skip = dir === DIR_E || dir === DIR_W ? 1 : 0;
      for (let k = skip; k < list[dir].length - skip; k++) {
        const p = kmPoint(loc.x + list[dir][k].x, loc.y + list[dir][k].y);
        const ab = this.influences.getAvoid(p.x, p.y);
        const st = this.eye.buildFF.getState(p.x, p.y);
        output +=
          (st === BS_ROAD || st === BS_ROAD_PLAN ? 1 : 0) * AI_PAR.PLANNER_SnapCrit_HouseOrRoad +
          (st === BS_NO_BUILD ? 1 : 0) * AI_PAR.PLANNER_SnapCrit_NoBuild +
          (isRoad(ab, p) ? 1 : 0) * AI_PAR.PLANNER_SnapCrit_Road +
          (ab === AVOID_BUILDING_NODE_LOCK_FIELD ? 1 : 0) * AI_PAR.PLANNER_SnapCrit_Field;
      }
    }
    const entrance = kmPoint(loc.x, loc.y + 1);
    const abEntrance = this.influences.getAvoid(entrance.x, entrance.y);
    output +=
      -(abEntrance === AVOID_BUILDING_NODE_LOCK_FIELD ? 1 : 0) * AI_PAR.PLANNER_SnapCrit_ObstacleInEntrance +
      (isRoad(abEntrance, entrance) ? 1 : 0) * AI_PAR.PLANNER_SnapCrit_RoadInEntrance;
    return output;
  }

  /** DistCrit (1571–1608). */
  distCrit(typeId: number, loc: Pt): number {
    const closestDistance = (): number => {
      const MAX_DIST = 1000;
      let output = MAX_DIST;
      for (const ht of HOUSE_DEPENDENCE[typeId]) {
        for (let i = 0; i < this.plannedHouses[ht].count; i++) {
          const p = this.plannedHouses[ht].plans[i].loc;
          const bid = Math.abs(loc.x - p.x) + Math.abs(loc.y - p.y) * 1.5;
          if (bid < output) output = bid;
        }
      }
      return output === MAX_DIST ? 0 : output;
    };
    const allDistances = (): number => {
      let result = 0;
      for (const ht of HOUSE_DEPENDENCE[typeId]) {
        for (let i = 0; i < this.plannedHouses[ht].count; i++) {
          result += distanceAbs(loc, this.plannedHouses[ht].plans[i].loc);
        }
      }
      return result;
    };
    return typeId === HT_BARRACKS ? -allDistances() : -closestDistance();
  }

  private index(x: number, y: number): number {
    return y * (this.world.mapX + 1) + x;
  }

  /** FindPlaceForHouse (1612–1902): the BuildFF candidates + the gain criteria; best 8. */
  findPlaceForHouse(ignoreTrees: boolean, typeId: number): Pt[] {
    const BEST_PLANS_CNT = 8;
    const INIT_BEST_GAIN = -1e20;
    const centers = this.eye.getCityCenterPoints(false);
    if (centers.length === 0) return [];
    const cityCenter = centers[0];
    const bestLocs: Pt[] = new Array<Pt>(BEST_PLANS_CNT).fill(kmPoint(0, 0));
    const bestGainArr: number[] = new Array<number>(BEST_PLANS_CNT).fill(INIT_BEST_GAIN);

    const evalFreeEntrance = (loc: Pt): number => {
      const OBSTACLE_COEF = 1000;
      if (loc.y + 2 >= this.world.mapY) return OBSTACLE_COEF * 3;
      let result = 0;
      for (let k = -1; k <= 1; k++) {
        if (this.world.tileWalkable(loc.x + k, loc.y + 2)) result += OBSTACLE_COEF;
      }
      return result;
    };

    const evaluateLoc = (loc: Pt): void => {
      const PLANNER_ALLY_INFLUENCE = 1;
      const PLANNER_ENEMY_INFLUENCE = 10;
      const obstacles = -this.obstaclesInHousePlan(typeId, loc);
      const snap = this.snapCrit(typeId, loc) * AI_PAR.PLANNER_FindPlaceForHouse_SnapCrit;
      const seedDist = -this.eye.buildFF.getDistance(loc) * AI_PAR.PLANNER_FindPlaceForHouse_SeedDist;
      const centerDist = -distanceAbs(cityCenter, loc) * AI_PAR.PLANNER_FindPlaceForHouse_CityCenter;
      const routes = this.eye.routes[this.index(loc.x, loc.y)] * AI_PAR.PLANNER_FindPlaceForHouse_Route;
      const flatArea = this.eye.flatArea[this.index(loc.x, loc.y)] * AI_PAR.PLANNER_FindPlaceForHouse_FlatArea;
      const allyInf = -this.influences.getBestAllianceOwnership(this.owner, loc.x, loc.y, 'ally') * PLANNER_ALLY_INFLUENCE;
      const enemyInf = -this.influences.getBestAllianceOwnership(this.owner, loc.x, loc.y, 'enemy') * PLANNER_ENEMY_INFLUENCE;
      let gain: number;
      if (typeId === HT_FARM || typeId === HT_VINEYARD) {
        const houseDist = this.distCrit(typeId, loc) * AI_PAR.PLANNER_FARM_FindPlaceForHouse_HouseDist;
        const farmCenterDist = -distanceAbs(cityCenter, loc) * AI_PAR.PLANNER_FARM_FindPlaceForHouse_CityCenter;
        const farmRoutes = this.eye.routes[this.index(loc.x, loc.y)] * AI_PAR.PLANNER_FARM_FindPlaceForHouse_Route;
        const farmFlat = this.eye.flatArea[this.index(loc.x, loc.y)] * AI_PAR.PLANNER_FARM_FindPlaceForHouse_FlatArea;
        const field = this.fieldCrit(typeId, loc);
        gain = snap + houseDist + farmCenterDist + seedDist + farmRoutes + farmFlat + obstacles + allyInf + enemyInf + field;
      } else {
        const houseDist = this.distCrit(typeId, loc) * AI_PAR.PLANNER_FindPlaceForHouse_HouseDist;
        const freeEntrance = typeId === HT_STORE || typeId === HT_BARRACKS ? evalFreeEntrance(loc) : 0;
        gain = snap + houseDist + centerDist + seedDist + routes + flatArea + obstacles + allyInf + enemyInf + freeEntrance;
      }
      for (let l = 0; l < BEST_PLANS_CNT; l++) {
        if (bestLocs[l].x === loc.x && bestLocs[l].y === loc.y) break;
        if (gain > bestGainArr[l]) {
          const tmp = bestLocs[l];
          bestLocs[l] = loc;
          loc = tmp;
          const g = bestGainArr[l];
          bestGainArr[l] = gain;
          gain = g;
        }
      }
    };

    const req: HouseRequirements = {
      houseType: typeId,
      ignoreTrees,
      ignoreAvoidBuilding: false,
      maxDist: 30 - 20 * (typeId === HT_METALLURGISTS ? 1 : 0),
      maxCnt: 100,
    };
    const initPoints: Pt[] = [];
    for (const ht of HOUSE_DEPENDENCE[typeId]) {
      for (let l = this.plannedHouses[ht].count - 1; l >= 0; l--) {
        const p = this.plannedHouses[ht].plans[l].loc;
        initPoints.push(kmPoint(p.x, p.y + 1));
      }
    }
    this.eye.buildFF.findPlaceForHouse(req, initPoints, true);
    if (this.eye.buildFF.locs.length < 10) {
      initPoints.length = 0;
      const PROBABILITY = 0.3;
      const MAX_RND_HOUSES = 10;
      outer: for (let ht = 0; ht < 30; ht++) {
        if (ht === HT_WATCHTOWER || ht === HT_WOODCUTTERS || ht === HT_COAL_MINE || ht === HT_IRON_MINE || ht === HT_GOLD_MINE) continue;
        if (HOUSE_DEPENDENCE[typeId].includes(ht)) continue;
        for (let l = this.plannedHouses[ht].count - 1; l >= 0; l--) {
          // KaMRandom draw (KM_CityPlanner.pas 1855) — consumed as coded.
          if (initPoints.length === 0 || ht === HT_STORE || this.world.draw() < PROBABILITY) {
            if (initPoints.length >= MAX_RND_HOUSES) break outer;
            const p = this.plannedHouses[ht].plans[l].loc;
            initPoints.push(kmPoint(p.x, p.y + 1));
          }
        }
        if (initPoints.length >= MAX_RND_HOUSES) break;
      }
      this.eye.buildFF.findPlaceForHouse(req, initPoints, false);
    }
    for (const loc of this.eye.buildFF.locs) evaluateLoc(loc);
    const out: Pt[] = [];
    for (let l = 0; l < BEST_PLANS_CNT; l++) {
      if (bestGainArr[l] === INIT_BEST_GAIN) break;
      out.push(bestLocs[l]);
    }
    return out;
  }

  /** FindPlaceForMines (1905–2048). */
  findPlaceForMines(typeId: number): Pt | null {
    if (typeId === HT_GOLD_MINE || typeId === HT_IRON_MINE) {
      const BEST_GAIN = -10000;
      const locs = this.eye.getMineLocs(typeId);
      if (locs.length === 0) return null;
      this.eye.buildFF.updateState();
      for (const l of locs) {
        if (this.eye.buildFF.visited[l.loc.y * (this.world.mapX + 1) + l.loc.x + (this.world.mapX + 1)] === this.eye.buildFF.visitIdx) {
          // Prefer mines in the walkable area (the Pascal reads Visited[Y+1, X]).
        }
        l.tag = 10000 + l.tag - this.eye.buildFF.getDistance(kmPoint(l.loc.x, l.loc.y + 1)) * 10 - this.influences.getOtherOwnerships(this.owner, l.loc.x, l.loc.y);
      }
      locs.sort((a, b) => b.tag - a.tag);
      let bestGain = BEST_GAIN;
      let bestLoc: Pt | null = null;
      for (let i = locs.length - 1; i >= 0; i--) {
        // Check reserved mines.
        let check = true;
        for (let k = 0; k < this.plannedHouses[typeId].count; k++) {
          const loc = this.plannedHouses[typeId].plans[k].loc;
          if (loc.x === locs[i].loc.x && loc.y === locs[i].loc.y) {
            check = false;
            break;
          }
        }
        if (!check) continue;
        const gain = locs[i].tag + this.distCrit(typeId, locs[i].loc) * 4;
        if (gain > bestGain) {
          bestGain = gain;
          bestLoc = locs[i].loc;
        }
      }
      if (bestLoc !== null) {
        this.addPlan(typeId, bestLoc);
        return bestLoc;
      }
      return null;
    }
    if (typeId === HT_COAL_MINE) {
      const INIT_GAIN = -10000;
      const initPoints: Pt[] = [];
      for (let ht = 0; ht < 30; ht++) {
        for (let i = 0; i < this.plannedHouses[ht].count; i++) {
          const p = this.plannedHouses[ht].plans[i].loc;
          initPoints.push(kmPoint(p.x, p.y + 1));
        }
      }
      const req: HouseRequirements = { houseType: HT_COAL_MINE, ignoreTrees: false, ignoreAvoidBuilding: true, maxCnt: 20, maxDist: 30 };
      this.eye.buildFF.findPlaceForHouse(req, initPoints, true);
      let bestGain = INIT_GAIN;
      let bestLoc: Pt | null = null;
      for (const p of this.eye.buildFF.locs) {
        const gain =
          -this.eye.buildFF.getDistance(p) * 10 +
          this.snapCrit(HT_COAL_MINE, p) -
          this.obstaclesInHousePlan(HT_COAL_MINE, p) -
          this.influences.getOtherOwnerships(this.owner, p.x, p.y);
        if (gain > bestGain) {
          bestGain = gain;
          bestLoc = p;
        }
      }
      if (bestLoc !== null) this.addPlan(HT_COAL_MINE, bestLoc);
      return bestLoc;
    }
    return null;
  }

  /** CheckStoneReserves (2051–2147). */
  checkStoneReserves(forceToPlaceQuarry: boolean, reqQuarryCnt: number): void {
    const HT = HT_QUARRY;
    const MIN_CNT = 60;
    const MIN_CNT_USED = 25;
    const arr = this.plannedHouses[HT];
    if (!forceToPlaceQuarry && (arr.completed === 0 || arr.count > arr.completed)) return;
    const stoneLocs = this.eye.getStoneLocs();
    if (stoneLocs.length === 0) return;
    if (arr.count > 0) {
      const canMineCnt = new Array<number>(arr.count).fill(0);
      for (const sl of stoneLocs) sl.tag2 = 0;
      for (let i = 0; i < arr.count; i++) {
        const loc = arr.plans[i].loc;
        for (const sl of stoneLocs) {
          if (distanceSqr(loc, sl.loc) <= 16 * 16) {
            canMineCnt[i] += sl.tag;
            sl.tag2 += 1;
          }
        }
      }
      let lowestIdx = 0;
      for (let i = canMineCnt.length - 1; i >= 0; i--) {
        const house = arr.plans[i].houseUid !== 0 ? this.world.houseByUid(arr.plans[i].houseUid) : null;
        if (canMineCnt[lowestIdx] >= canMineCnt[i] && house !== null && !house.destroyed) lowestIdx = i;
      }
      if (canMineCnt[lowestIdx] < MIN_CNT) {
        let canBeReplaced = true;
        const loc = arr.plans[lowestIdx].loc;
        for (let i = stoneLocs.length - 1; i >= 0; i--) {
          if (stoneLocs[i].tag2 < 3 && distanceSqr(loc, stoneLocs[i].loc) <= 16 * 16) {
            canBeReplaced = false;
            break;
          } else if (
            (!forceToPlaceQuarry && stoneLocs[i].tag2 > 1) ||
            (stoneLocs[i].tag2 > 0 && stoneLocs[i].tag < MIN_CNT_USED) ||
            stoneLocs[i].tag2 > 3
          ) {
            stoneLocs.splice(i, 1);
          }
        }
        this.stonesDepleted = stoneLocs.length === 0;
        if (canBeReplaced && !this.stonesDepleted) {
          if (reqQuarryCnt >= 0 && this.findPlaceForQuary(stoneLocs)) {
            const last = arr.plans[arr.count - 1];
            if (last !== undefined) last.houseReservation = true;
          } else {
            this.stonesDepleted = true;
          }
          if (!forceToPlaceQuarry && reqQuarryCnt < 0) {
            const house = arr.plans[lowestIdx].houseUid !== 0 ? this.world.houseByUid(arr.plans[lowestIdx].houseUid) : null;
            if (house !== null) this.world.demolishHouseByUid(house.uid, this.owner);
            this.removePlan(HT, lowestIdx);
          }
        } else if (forceToPlaceQuarry) {
          this.findPlaceForQuary(stoneLocs);
        }
      } else if (forceToPlaceQuarry) {
        this.findPlaceForQuary(stoneLocs);
      }
    } else if (forceToPlaceQuarry) {
      this.findPlaceForQuary(stoneLocs);
    }
  }

  /** FindPlaceForQuary (2151–2283). */
  findPlaceForQuary(stoneLocs: StoneLoc[]): boolean {
    const HT = HT_QUARRY;
    const MAX_DERIVATION = 75;
    const MAX_SCAN_DIST = 3;
    if (stoneLocs.length === 0) return false;
    this.eye.buildFF.updateState();
    // Consider ownership when picking stone locs.
    for (let i = stoneLocs.length - 1; i >= 0; i--) {
      let bestTag = 0;
      let isWalkable = false;
      let bestLoc = kmPoint(0, 0);
      for (let y = Math.max(stoneLocs[i].loc.y - 1, 1); y <= Math.min(stoneLocs[i].loc.y + MAX_SCAN_DIST, this.world.mapY - 1); y++) {
        for (let x = Math.max(stoneLocs[i].loc.x - 1, 1); x <= Math.min(stoneLocs[i].loc.x + 1, this.world.mapX - 1); x++) {
          if (this.eye.buildFF.visited[y * (this.world.mapX + 1) + x] !== this.eye.buildFF.visitIdx) continue;
          const newTag = Math.max(
            0,
            round(
              100000 +
                this.influences.getOwnership(this.owner, x, y) -
                this.influences.getOtherOwnerships(this.owner, x, y) -
                this.eye.buildFF.getDistance(kmPoint(x, y)) * AI_PAR.PLANNER_FindPlaceForQuary_StoneLoc_Distance,
            ),
          );
          if (newTag > bestTag) {
            bestLoc = kmPoint(x, y);
            bestTag = newTag;
            isWalkable = true;
          }
        }
      }
      if (!isWalkable) {
        stoneLocs.splice(i, 1);
      } else {
        const newTag = stoneLocs[i].tag;
        stoneLocs[i].loc = bestLoc;
        stoneLocs[i].tag = round(
          bestTag + stoneLocs[i].tag * AI_PAR.PLANNER_FindPlaceForQuary_StoneLoc_StoneCnt - stoneLocs[i].tag2 * AI_PAR.PLANNER_FindPlaceForQuary_StoneLoc_AlreadyMined,
        );
        stoneLocs[i].tag2 = newTag;
      }
    }
    stoneLocs.sort((a, b) => a.tag - b.tag);
    let maxIdx = stoneLocs.length - 1;
    let output = false;
    let bestLoc: Pt | null = null;
    while (!output && maxIdx > 0) {
      let minIdx = 0;
      for (let i = maxIdx - 1; i >= 0; i--) {
        if (stoneLocs[i + 1].tag - stoneLocs[i].tag > MAX_DERIVATION) {
          minIdx = i;
          break;
        }
      }
      const initPoints: Pt[] = [];
      for (let i = maxIdx; i >= minIdx + 1; i--) initPoints.push(stoneLocs[i].loc);
      maxIdx = minIdx;
      const req: HouseRequirements = { houseType: HT, ignoreTrees: false, ignoreAvoidBuilding: true, maxCnt: 150, maxDist: 11 };
      this.eye.buildFF.findPlaceForHouse(req, initPoints, true);
      let bestGain = -10000000;
      for (const loc of this.eye.buildFF.locs) {
        let stonesAvailable = 0;
        for (const sl of stoneLocs) {
          if (distanceSqr(loc, sl.loc) < 16 * 16 - 3) stonesAvailable += sl.tag2;
        }
        const gain =
          -this.obstaclesInHousePlan(HT, loc) * AI_PAR.PLANNER_FindPlaceForQuary_Obstacle -
          this.eye.buildFF.getDistance(loc) * AI_PAR.PLANNER_FindPlaceForQuary_DistCity * Math.max(1, AI_PAR.PLANNER_FindPlaceForQuary_DistTimer - this.currentTick) -
          this.eye.buildFF.getDistanceInitPoint(loc) * AI_PAR.PLANNER_FindPlaceForQuary_DistStone +
          this.snapCrit(HT, loc) * AI_PAR.PLANNER_FindPlaceForQuary_SnapCrit +
          stonesAvailable * AI_PAR.PLANNER_FindPlaceForQuary_QtyStone;
        if (gain > bestGain) {
          bestGain = gain;
          bestLoc = loc;
          output = true;
        }
      }
    }
    if (output && bestLoc !== null) {
      this.addPlan(HT, bestLoc);
      if (this.builder !== null) this.builder.lockHouseLoc(HT_QUARRY, bestLoc);
    }
    return output;
  }

  private currentTick = 0;

  /** FindPlaceForWoodcutter (2287–2363). */
  findPlaceForWoodcutter(center: Pt, chopOnly = false): boolean {
    const RADIUS = 8;
    const COAL_PENALIZATION = 5;
    const req: HouseRequirements = {
      houseType: HT_WOODCUTTERS,
      ignoreTrees: false,
      ignoreAvoidBuilding: !chopOnly,
      maxCnt: 20,
      maxDist: RADIUS,
    };
    this.eye.buildFF.findPlaceForHouse(req, [center], true);
    let bestGain = -1e10;
    let bestLoc: Pt | null = null;
    for (const loc of this.eye.buildFF.locs) {
      let gain =
        -AI_PAR.PLANNER_FOREST_PlaceWoodcutter_DistFromForest * this.eye.buildFF.getDistanceInitPoint(loc) +
        this.distCrit(HT_WOODCUTTERS, loc) +
        this.snapCrit(HT_WOODCUTTERS, loc);
      if (gain > bestGain) {
        let coalTiles = 0;
        for (const off of this.eye.mapping[HT_WOODCUTTERS].tiles) {
          coalTiles += this.world.tileIsCoal(loc.x + off.x, loc.y + off.y) > 0 ? 1 : 0;
        }
        gain -= coalTiles * COAL_PENALIZATION;
        if (gain > bestGain) {
          bestGain = gain;
          bestLoc = loc;
        }
      }
    }
    if (bestGain === -1e10 || bestLoc === null) return false;
    let specPoint = center;
    if ((center.y <= bestLoc.y && center.y >= bestLoc.y - 1) && (center.x <= bestLoc.x && center.x >= bestLoc.x - 2)) {
      specPoint = kmPoint(bestLoc.x - 1, bestLoc.y + 1);
    }
    this.addPlan(HT_WOODCUTTERS, bestLoc, specPoint, chopOnly);
    if (this.builder !== null) this.builder.lockHouseLoc(HT_WOODCUTTERS, bestLoc);
    return true;
  }

  /** FindForestAndWoodcutter (2366–2531). */
  findForestAndWoodcutter(): boolean {
    const getFreeTiles = (loc: Pt): number => {
      const RADIUS = 4;
      let result = 0;
      for (let y = Math.max(1, loc.y - RADIUS); y <= Math.min(this.world.mapY - 1, loc.y + RADIUS); y++) {
        for (let x = Math.max(1, loc.x - RADIUS); x <= Math.min(this.world.mapX - 1, loc.x + RADIUS); x++) {
          const st = this.eye.buildFF.getState(x, y);
          result += st >= BS_BUILD && st <= BS_FOREST ? 1 : 0;
        }
      }
      return result;
    };
    const fi = this.eye.getForests();
    const firnd = this.eye.getPotentialForests(500); // v0: none (no navmesh)
    for (const f of firnd.forests) {
      fi.forests.push(f);
      fi.count += 1;
    }
    // Filter by influence + chop-only forests.
    for (let k = fi.count - 1; k >= 0; k--) {
      const loc = fi.forests[k].loc;
      if (
        this.influences.getBestAllianceOwnership(this.owner, loc.x, loc.y, 'enemy') > 10 ||
        this.influences.getBestOwner(loc.x, loc.y) !== this.owner
      ) {
        fi.count -= 1;
        fi.forests[k] = fi.forests[fi.count];
        continue;
      }
      for (const plan of this.plannedHouses[HT_WOODCUTTERS].plans.slice(0, this.plannedHouses[HT_WOODCUTTERS].count)) {
        if (plan.chopOnly && distanceSqr(loc, plan.specPoint) < 12 * 12) {
          fi.count -= 1;
          fi.forests[k] = fi.forests[fi.count];
          break;
        }
      }
    }
    const evalForest = (idx: number): void => {
      const PLANNER_ALLY_INFLUENCE = 3;
      const PLANNER_ENEMY_INFLUENCE = 10;
      const p = fi.forests[idx].loc;
      const treeCnt = fi.forests[idx].treeCount * AI_PAR.PLANNER_FOREST_FindPlaceForWoodcutter_TreeCnt * Math.max(1, AI_PAR.PLANNER_FOREST_FindPlaceForWoodcutter_TreeCntTimer - this.currentTick);
      const distCrit = -fi.forests[idx].distance * AI_PAR.PLANNER_FOREST_FindPlaceForWoodcutter_DistCrit * Math.max(1, AI_PAR.PLANNER_FOREST_FindPlaceForWoodcutter_DistTimer - this.currentTick);
      const existFrs = (fi.forests[idx].partOfForest ? 1 : 0) * AI_PAR.PLANNER_FOREST_FindPlaceForWoodcutter_ExistForest;
      const routes = this.eye.routes[this.index(p.x, p.y)] * AI_PAR.PLANNER_FOREST_FindPlaceForWoodcutter_Routes;
      const flatArea = this.eye.flatArea[this.index(p.x, p.y)] * AI_PAR.PLANNER_FOREST_FindPlaceForWoodcutter_FlatArea;
      const soil = this.eye.soil[this.index(p.x, p.y)] * AI_PAR.PLANNER_FOREST_FindPlaceForWoodcutter_Soil;
      const freeTiles = getFreeTiles(p) * AI_PAR.PLANNER_FOREST_FindPlaceForWoodcutter_FreeTiles;
      const allyInf = -this.influences.getBestAllianceOwnership(this.owner, p.x, p.y, 'ally') * PLANNER_ALLY_INFLUENCE;
      const enemyInfl = -this.influences.getBestAllianceOwnership(this.owner, p.x, p.y, 'enemy') * PLANNER_ENEMY_INFLUENCE;
      fi.forests[idx].bid = treeCnt + distCrit + existFrs + routes + flatArea + soil + freeTiles + allyInf + enemyInfl;
    };
    for (let k = 0; k < fi.count; k++) evalForest(k);
    fi.forests.length = fi.count;
    if (fi.count > 1) {
      // SortCustom by Bid ascending (CompareForests), a stable sort in the port.
      fi.forests.sort((a, b) => (a.bid === b.bid ? 0 : a.bid < b.bid ? -1 : 1));
    }
    let output = false;
    let k = fi.count;
    while (!output && k > 0) {
      k -= 1;
      const p = fi.forests[k].loc;
      output = this.findPlaceForWoodcutter(p, false);
      if (output) {
        const decreaseSpeed =
          Math.min(AI_PAR.PLANNER_FOREST_FindPlaceForWoodcutter_ABRange, AVOID_BUILDING_FOREST_RANGE - 1) /
          (AI_PAR.PLANNER_FOREST_FindPlaceForWoodcutter_Radius * AI_PAR.PLANNER_FOREST_FindPlaceForWoodcutter_Radius);
        this.influences.markForest(p, AI_PAR.PLANNER_FOREST_FindPlaceForWoodcutter_Radius, decreaseSpeed);
      }
    }
    this.forestsInfo = fi;
    return output;
  }

  /** FindForestAround (2535–2607): a chop-only woodcutter near the new house. */
  findForestAround(point: Pt, countByInfluence = false): boolean {
    const MIN_TREES = 3;
    const SQR_MIN_DIST_FROM_ACTIVE_FORESTS = 10 * 10;
    const SQR_MIN_DIST_FROM_CHOP_ONLY = 12 * 12;
    let output = false;
    if (this.forestsInfo.count > 0) {
      let bestGain = 0;
      let bestLoc: Pt | null = null;
      this.eye.buildFF.updateState();
      for (let k = this.forestsInfo.count - 1; k >= 0; k--) {
        const loc = this.forestsInfo.forests[k].loc;
        const near = countByInfluence || distanceSqr(point, loc) < AI_PAR.PLANNER_FOREST_FindForestAround_MaxDist * AI_PAR.PLANNER_FOREST_FindForestAround_MaxDist;
        if (!near || this.forestsInfo.forests[k].treeCount < MIN_TREES) continue;
        if (this.influences.getBestAllianceOwnership(this.owner, loc.x, loc.y, 'enemy') >= 20) continue;
        const gain = this.influences.getOwnership(this.owner, loc.x, loc.y);
        if (gain > bestGain) {
          let check = true;
          for (let l = 0; l < this.plannedHouses[HT_WOODCUTTERS].count; l++) {
            if (distanceSqr(loc, this.plannedHouses[HT_WOODCUTTERS].plans[l].specPoint) < SQR_MIN_DIST_FROM_ACTIVE_FORESTS) {
              check = false;
              break;
            }
          }
          if (check) {
            bestGain = gain;
            bestLoc = loc;
            output = true;
          }
        }
      }
      if (output && bestLoc !== null) {
        output = this.findPlaceForWoodcutter(bestLoc, true);
        if (output) {
          for (let k = this.forestsInfo.count - 1; k >= 0; k--) {
            if (distanceSqr(this.forestsInfo.forests[k].loc, bestLoc) < SQR_MIN_DIST_FROM_CHOP_ONLY) {
              this.forestsInfo.forests[k] = this.forestsInfo.forests[this.forestsInfo.count - 1];
              this.forestsInfo.count -= 1;
            }
          }
        }
      }
    }
    return output;
  }

  /** PlanDefenceTowers (2610–2702): the navmesh defence lines are out of the v0 scope (worker N);
   *  the flag is set so watchtowers are not planned by the economy half. */
  planDefenceTowers(): boolean {
    this.defenceTowersPlanned = true;
    return false;
  }

  /** The planner's tick (for the timer-based bids). */
  setTick(tick: number): void {
    this.currentTick = tick;
  }
}

// === END OF PART 3A ===

// ---------------------------------------------------------------------------------------------
// CityBuilder (KM_CityBuilder.pas)

// NODE_PRIO_* (KM_CityBuilder.pas 16–24).
export const NODE_PRIO_ROADS_UNLOCK_HOUSE = 1;
export const NODE_PRIO_ROADS = 2;
export const NODE_PRIO_ROADS_RESERVATION = 3;
export const NODE_PRIO_REMOVE_TREE_IN_PLAN = 3;
export const NODE_PRIO_FIELDS = 4;
export const NODE_PRIO_FIELDS_RESERVATION = 4;
export const NODE_PRIO_SHORTCUTS = 3;
export const NODE_PRIO_DEFAULT = 255;

/** TBuildNode (KM_CityBuilder.pas 28–35). */
export interface BuildNode {
  active: boolean;
  removeTreesMode: boolean;
  shortcutMode: boolean;
  priority: number;
  freeWorkers: number;
  requiredWorkers: number;
  maxReqWorkers: number;
  centerPoint: Pt;
  fieldType: FieldType;
  fieldList: Pt[];
}

/**
 * TKMCityBuilder: turns the planner's plans into the world's house/field plans through the build
 * nodes (roads, fields, remove-tree-in-plan) and drives ChooseHousesToBuild.
 */
export class CityBuilder {
  owner: number;
  readonly planner: CityPlanner;
  readonly predictor: CityPredictor;
  stoneCrisis = false;
  stoneShortage = false;
  woodShortage = false;
  trunkShortage = false;
  goldShortage = false;
  freeWorkersCnt = 0;
  buildNodes: BuildNode[] = [];
  workersPos: Pt[] = [];

  private readonly world: EconomyWorld;
  private readonly eye: Eye;
  private readonly influences: Influences;
  private tick = 0;

  constructor(world: EconomyWorld, owner: number, eye: Eye, influences: Influences, planner: CityPlanner, predictor: CityPredictor) {
    this.world = world;
    this.owner = owner;
    this.eye = eye;
    this.influences = influences;
    this.planner = planner;
    this.predictor = predictor;
  }

  afterMissionInit(): void {
    this.planner.afterMissionInit();
    this.buildNodes = [];
    for (let i = 0; i < this.predictor.workerCount; i++) {
      this.buildNodes.push({
        active: false,
        removeTreesMode: false,
        shortcutMode: false,
        priority: 0,
        freeWorkers: 0,
        requiredWorkers: 0,
        maxReqWorkers: 0,
        centerPoint: kmPoint(0, 0),
        fieldType: 'none',
        fieldList: [],
      });
    }
  }

  ownerUpdate(hand: number): void {
    this.owner = hand;
    this.planner.ownerUpdate(hand);
  }

  /** UpdateState (254–284): planner first, then the nodes; stone reserves / fields every N ticks. */
  updateState(tick: number): void {
    const CHECK_STONE_RESERVES = 3 * 60 * MAX_HANDS; // every 3 min
    const CHECK_FIELDS = 1 * 30 * MAX_HANDS; // every 30 sec 1 farm
    if (tick % MAX_HANDS !== this.owner) return;
    this.tick = tick;
    this.planner.setTick(tick);
    this.planner.updateState(tick);
    this.updateBuildNodes();
    if (this.predictor.requiredHouses[HT_QUARRY] <= 0 && tick % CHECK_STONE_RESERVES === this.owner) {
      this.planner.checkStoneReserves(false, this.predictor.requiredHouses[HT_QUARRY]);
    } else if (tick % CHECK_FIELDS === this.owner) {
      for (const node of this.buildNodes) {
        if (node.active) continue;
        if (this.planner.checkFields(node.fieldType, node.fieldList)) {
          this.lockNode(node);
          node.active = true;
          node.priority = NODE_PRIO_FIELDS;
          node.removeTreesMode = false;
          node.shortcutMode = false;
          node.maxReqWorkers = 1;
          node.requiredWorkers = Math.min(node.maxReqWorkers, node.fieldList.length);
          node.centerPoint = node.fieldList[0];
          break;
        }
      }
    }
  }

  /** LockHouseLoc (287–315): reserve the plan tiles + the distance-1 ring in AvoidBuilding. */
  lockHouseLoc(typeId: number, loc: Pt): void {
    for (const off of this.eye.mapping[typeId].tiles) {
      const p = kmPoint(loc.x + off.x, loc.y + off.y);
      this.influences.setAvoid(p.x, p.y, AVOID_BUILDING_HOUSE_INSIDE_LOCK);
      this.eye.buildFF.actualizeTile(p.x, p.y);
    }
    for (let dir = 0; dir < 4; dir++) {
      for (const off of this.eye.mapping[typeId].surroundings[1][dir]) {
        const p = kmPoint(loc.x + off.x, loc.y + off.y);
        if (this.influences.getAvoid(p.x, p.y) < AVOID_BUILDING_HOUSE_INSIDE_LOCK) {
          this.influences.setAvoid(p.x, p.y, AVOID_BUILDING_HOUSE_OUTSIDE_LOCK);
          this.eye.buildFF.actualizeTile(p.x, p.y);
        }
      }
    }
  }

  /** UnlockHouseLoc (318–342). Mines are never unlocked (their arena stays reserved). */
  unlockHouseLoc(typeId: number, loc: Pt): void {
    if (typeId === HT_GOLD_MINE || typeId === HT_IRON_MINE) return;
    for (const off of this.eye.mapping[typeId].tiles) {
      const p = kmPoint(loc.x + off.x, loc.y + off.y);
      this.influences.setAvoid(p.x, p.y, AVOID_BUILDING_UNLOCK);
    }
    for (let dir = 0; dir < 4; dir++) {
      for (const off of this.eye.mapping[typeId].surroundings[1][dir]) {
        const p = kmPoint(loc.x + off.x, loc.y + off.y);
        if (this.influences.getAvoid(p.x, p.y) === AVOID_BUILDING_HOUSE_OUTSIDE_LOCK) {
          this.influences.setAvoid(p.x, p.y, AVOID_BUILDING_UNLOCK);
        }
      }
    }
  }

  /** LockNode (345–361). */
  lockNode(node: BuildNode): void {
    const nodeType = node.fieldType === 'road' ? AVOID_BUILDING_NODE_LOCK_ROAD : AVOID_BUILDING_NODE_LOCK_FIELD;
    for (const p of node.fieldList) {
      if (this.influences.getAvoid(p.x, p.y) < nodeType) {
        this.influences.setAvoid(p.x, p.y, nodeType);
        this.eye.buildFF.actualizeTile(p.x, p.y);
      }
    }
  }

  /** UnlockPointOfNode (364–380). */
  unlockPointOfNode(point: Pt, checkHousePlan = false): void {
    if (checkHousePlan) {
      for (let y = Math.max(1, point.y - 1); y <= Math.min(point.y + 1, this.world.mapY - 1); y++) {
        for (let x = Math.max(1, point.x - 1); x <= Math.min(point.x + 1, this.world.mapX - 1); x++) {
          if (this.influences.getAvoid(x, y) === AVOID_BUILDING_HOUSE_INSIDE_LOCK) {
            this.influences.setAvoid(point.x, point.y, AVOID_BUILDING_HOUSE_OUTSIDE_LOCK);
            return;
          }
        }
      }
    }
    const ab = this.influences.getAvoid(point.x, point.y);
    if ((checkHousePlan && ab !== AVOID_BUILDING_MINE_TILE && ab !== 255) || ab === AVOID_BUILDING_NODE_LOCK_ROAD) {
      this.influences.setAvoid(point.x, point.y, AVOID_BUILDING_UNLOCK);
    }
  }

  /** UnlockNode (383–390). */
  unlockNode(node: BuildNode, checkHousePlan = false): void {
    for (const p of node.fieldList) this.unlockPointOfNode(p, checkHousePlan);
  }

  /** UpdateBuildNodes (393–555). */
  updateBuildNodes(): void {
    if (this.buildingFirstSchool()) return;
    for (const node of this.buildNodes) node.freeWorkers = 0;

    // Positions of builders with no task.
    this.freeWorkersCnt = 0;
    const workersPos: Pt[] = [];
    for (const u of this.world.units) {
      if (u.dead || u.owner !== this.owner || u.type !== UT_BUILDER) continue;
      if (u.taskKind === 'none') {
        workersPos.push(kmPoint(Math.round(u.posF.x), Math.round(u.posF.y)));
        this.freeWorkersCnt += 1;
      }
    }
    // Houses with all resources but no builder on site count as busy.
    for (const h of this.world.houses) {
      if (h.owner !== this.owner || h.destroyed || h.buildState === 'done') continue;
      const total = h.woodCost + h.stoneCost;
      const pct = total === 0 ? 0 : this.world.houseBuildResourceDelivered(h) / total;
      if (pct !== 1) continue;
      let check = false;
      for (const u of this.world.units) {
        if (u.dead || u.owner !== this.owner || u.type !== UT_BUILDER) continue;
        if (this.world.unitBuildHouseUid(u.uid) === h.uid) {
          check = true;
          break;
        }
      }
      if (!check) this.freeWorkersCnt -= 1;
    }
    this.freeWorkersCnt = Math.max(0, this.freeWorkersCnt);
    this.workersPos = workersPos.slice(0, this.freeWorkersCnt);

    // Sort nodes by priority and active state (CompareBuildNode).
    this.buildNodes.sort((a, b) => {
      if (a.active && b.active) return a.priority - b.priority;
      if (a.active) return -1;
      if (b.active) return 1;
      return 0;
    });

    // Assign the closest free workers to the highest-priority active nodes.
    let k = 0;
    let l = 0;
    while (this.freeWorkersCnt > 0 && k < this.buildNodes.length && this.buildNodes[k].active) {
      while (this.freeWorkersCnt > 0) {
        let closestDist = Number.MAX_SAFE_INTEGER;
        let closestIdx = -1;
        for (l = k; l < this.buildNodes.length; l++) {
          const node = this.buildNodes[l];
          if (node.priority !== this.buildNodes[k].priority || !node.active) break;
          if (node.requiredWorkers > 0) {
            const dist = distanceAbs(this.workersPos[this.freeWorkersCnt - 1], node.centerPoint);
            if (dist < closestDist) {
              closestDist = dist;
              closestIdx = l;
            }
          }
        }
        if (closestDist !== Number.MAX_SAFE_INTEGER && closestIdx >= 0) {
          this.freeWorkersCnt -= 1;
          this.buildNodes[closestIdx].requiredWorkers -= 1;
          this.buildNodes[closestIdx].freeWorkers += 1;
        } else break;
      }
      k = l;
    }

    this.createShortcuts();

    let reqWorkerCnt = 0;
    for (const node of this.buildNodes) {
      if (!node.active) continue;
      this.updateBuildNode(node);
      if (node.active) reqWorkerCnt += node.requiredWorkers;
    }
    if (this.world.handHouseAnyCount(this.owner) > 15) {
      this.freeWorkersCnt = Math.max(this.freeWorkersCnt, reqWorkerCnt < 5 ? 1 : 0);
    }
  }

  /** BuildingFirstSchool (394–425): while the first school digs, no node updates. */
  private buildingFirstSchool(): boolean {
    const arr = this.planner.plannedHouses[HT_SCHOOL];
    let result = arr.underConstruction === 1 && arr.completed === 0 && arr.plans[0] !== undefined && arr.plans[0].placed && arr.plans[0].houseUid !== 0;
    if (!result) return false;
    const below = kmPoint(arr.plans[0].loc.x, arr.plans[0].loc.y + 1);
    for (const node of this.buildNodes) {
      if (node.active && node.fieldList.length > 0 && node.fieldList[0].x === below.x && node.fieldList[0].y === below.y) return false;
    }
    for (const u of this.world.units) {
      if (u.dead || u.owner !== this.owner || u.type !== UT_BUILDER) continue;
      if (u.taskKind === 'buildHouseArea' && this.world.unitTaskPhase(u.uid) > 1) return true;
    }
    return false;
  }

  /** UpdateBuildNode (558–820): the three node procedures. */
  updateBuildNode(node: BuildNode): void {
    const isPlan = (p: Pt, lock: number, field: FieldType): boolean =>
      this.world.hasFieldPlan(this.owner, p.x, p.y) === field || this.world.tileLockAt(p.x, p.y) === lock;
    const isCompletedRoad = (p: Pt): boolean => this.world.tileWalkableRoad(p.x, p.y);
    const isCompletedField = (p: Pt): boolean => this.world.tileHasCornField(p.x, p.y);
    const isCompletedWine = (p: Pt): boolean => this.world.tileHasWineField(p.x, p.y);
    const isRoad = (p: Pt): boolean => isCompletedRoad(p) || isPlan(p, 3, 'road');
    const isCornField = (p: Pt): boolean => isCompletedField(p) || isPlan(p, 4, 'corn');
    const isWineField = (p: Pt): boolean => isCompletedWine(p) || isPlan(p, 4, 'wine');

    const buildField = (idx: number, fieldType: FieldType): boolean => {
      const p = node.fieldList[idx];
      if (!this.world.canAddFieldPlan(this.owner, p.x, p.y, fieldType)) return false;
      this.world.addFieldPlan(this.owner, p.x, p.y, fieldType);
      node.freeWorkers -= 1;
      node.requiredWorkers -= 1;
      return true;
    };

    const buildRoad = (): void => {
      let activeWorkers = 0;
      for (let k = node.fieldList.length - 1; k >= 0; k--) {
        if (isCompletedRoad(node.fieldList[k])) {
          this.unlockPointOfNode(node.fieldList[k], true);
          node.fieldList.splice(k, 1);
        } else if (!node.shortcutMode) break;
      }
      if (node.fieldList.length === 0) {
        node.active = false;
        return;
      }
      node.requiredWorkers = node.fieldList.length;
      for (let k = node.fieldList.length - 1; k >= 0; k--) {
        const p = node.fieldList[k];
        if (this.world.hasFieldPlan(this.owner, p.x, p.y) === 'wine' || this.world.hasFieldPlan(this.owner, p.x, p.y) === 'corn') {
          this.world.remFieldPlan(this.owner, p.x, p.y);
        }
        if (isPlan(p, 3, 'road')) {
          activeWorkers += 1;
          node.requiredWorkers -= 1;
        } else if (this.world.tileLockAt(p.x, p.y) === 4 && (this.world.hasFieldPlan(this.owner, p.x, p.y) === 'corn' || this.world.hasFieldPlan(this.owner, p.x, p.y) === 'corn')) {
          // Wait for the worker to finish the corn.
        } else if (isCompletedRoad(p)) {
          node.requiredWorkers -= 1;
          node.centerPoint = p;
        } else {
          if (node.freeWorkers <= 0) break;
          if (!buildField(k, 'road')) {
            if (node.shortcutMode) {
              this.unlockPointOfNode(p, true);
              node.fieldList.splice(k, 1);
            } else {
              this.unlockNode(node, true);
              const route = this.planner.getRoadBetweenPoints(node.centerPoint, node.fieldList[0]);
              if (route === null) {
                node.fieldList.length = 0;
                node.active = false;
              } else {
                node.fieldList.length = 0;
                for (const q of route) node.fieldList.push(q);
              }
              this.lockNode(node);
              node.requiredWorkers = Math.min(node.maxReqWorkers, node.fieldList.length);
              return;
            }
          }
        }
      }
      node.requiredWorkers = Math.min(Math.max(0, node.maxReqWorkers - activeWorkers), node.requiredWorkers);
    };

    const buildFields = (): void => {
      let activeWorkers = 0;
      node.requiredWorkers = node.fieldList.length;
      for (let k = 0; k < node.fieldList.length; k++) {
        const p = node.fieldList[k];
        if (this.influences.getAvoid(p.x, p.y) !== AVOID_BUILDING_NODE_LOCK_FIELD) {
          node.requiredWorkers -= 1;
        } else if ((node.fieldType === 'wine' && isCompletedWine(p)) || (node.fieldType === 'corn' && isCompletedField(p))) {
          node.requiredWorkers -= 1;
        } else if (
          (node.fieldType === 'wine' && isPlan(p, 4, 'wine')) ||
          (node.fieldType === 'corn' && isPlan(p, 4, 'corn'))
        ) {
          activeWorkers += 1;
          if (node.maxReqWorkers <= activeWorkers) break;
        } else {
          buildField(k, node.fieldType);
          if (node.freeWorkers <= 0) break;
        }
        if (node.requiredWorkers <= 0 || k === node.fieldList.length - 1) {
          node.fieldList.length = 0;
          node.active = false;
        }
      }
      node.requiredWorkers = Math.min(Math.max(0, node.maxReqWorkers - activeWorkers), node.requiredWorkers);
    };

    const removeObstaclesInPlan = (): void => {
      if (node.fieldList.length === 0) {
        node.active = false;
        return;
      }
      node.requiredWorkers = node.fieldList.length;
      for (let k = node.fieldList.length - 1; k >= 0; k--) {
        const p = node.fieldList[k];
        if (this.world.treeAt(p.x, p.y) !== null) {
          if (isPlan(p, 4, 'wine')) {
            node.requiredWorkers -= 1;
          } else if (!buildField(k, 'wine')) {
            // A tree can be cleared by a wineyard plan; when the tile cannot take one, drop the point
            // and let the planner re-check it next time.
            node.fieldList.splice(k, 1);
          }
        } else if (isCompletedWine(p) || isCompletedField(p) || isRoad(p)) {
          if (isCompletedRoad(p)) node.fieldList.splice(k, 1);
          else if (!isPlan(p, 3, 'road')) {
            if (!buildField(k, 'road')) node.fieldList.splice(k, 1);
          }
        } else if (this.world.hasFieldPlan(this.owner, p.x, p.y) !== 'none') {
          this.world.remFieldPlan(this.owner, p.x, p.y);
          node.fieldList.splice(k, 1);
        } else if (this.world.tileLockAt(p.x, p.y) === 4) {
          // A dug field/wine tile: wait for the worker.
        } else {
          node.fieldList.splice(k, 1);
          node.requiredWorkers -= 1;
        }
      }
      node.requiredWorkers = Math.min(node.maxReqWorkers, node.requiredWorkers);
    };

    if (node.removeTreesMode) removeObstaclesInPlan();
    else if (node.fieldType === 'road') buildRoad();
    else if (node.fieldType === 'wine' || node.fieldType === 'corn') buildFields();
  }

  /** CheckBasicMaterials (823–893). */
  checkBasicMaterials(maxPlans: { value: number }, maxPlace: { value: number }, trunkBalance: { value: number }, tick: number): void {
    void tick;
    const stats = this.world;
    maxPlans.value = Math.ceil(this.freeWorkersCnt / Math.max(0.01, AI_PAR.BUILDER_ChHTB_FreeWorkerCoef));
    if (this.predictor.wareBalance[WT_STONE].exhaustion > 60) {
      maxPlans.value = Math.max(
        maxPlans.value,
        Math.ceil(stats.handUnitCount(this.owner, UT_BUILDER) / Math.max(0.01, AI_PAR.BUILDER_ChHTB_AllWorkerCoef)) - this.planner.constructedHouses,
      );
    }
    this.stoneShortage = this.predictor.wareBalance[WT_STONE].exhaustion < AI_PAR.BUILDER_Shortage_Stone && !this.planner.stonesDepleted;
    this.goldShortage = this.predictor.wareBalance[WT_GOLD].exhaustion < AI_PAR.BUILDER_Shortage_Gold;
    const trunk = stats.handWareBalance(this.owner, WT_TRUNK);
    const wood = stats.handWareBalance(this.owner, WT_TIMBER);
    const woodReserves = trunk * 2 + wood;
    trunkBalance.value = woodReserves / (2 * Math.max(0.1, this.predictor.wareBalance[WT_TRUNK].actualConsumption));
    this.trunkShortage = trunkBalance.value < AI_PAR.BUILDER_Shortage_Trunk;

    let requiredStones = stats.plansStoneDemands(this.owner);
    let requiredWood = stats.plansWoodDemands(this.owner);
    for (const h of this.world.houses) {
      if (h.owner !== this.owner || h.destroyed || h.buildState === 'done') continue;
      requiredStones += h.stoneCost - stats.houseBuildStoneDelivered(h);
      requiredWood += h.woodCost - stats.houseBuildWoodDelivered(h);
    }
    for (const node of this.buildNodes) {
      if (node.active && node.fieldType === 'road') requiredStones += node.fieldList.length - 1;
    }
    const quarry = this.planner.plannedHouses[HT_QUARRY];
    this.stoneCrisis =
      quarry.underConstruction + quarry.planned > 0 &&
      quarry.completed * PRODUCTION_RATE[WT_STONE] < stats.handUnitCount(this.owner, UT_BUILDER) * AI_PAR.PREDICTOR_WareNeedPerAWorker_Stone &&
      stats.handWareBalance(this.owner, WT_STONE) < requiredStones + AI_PAR.BUILDER_Shortage_StoneReserve;
    this.stoneShortage = this.stoneShortage || this.stoneCrisis;
    this.trunkShortage = this.trunkShortage || woodReserves < requiredWood;
    maxPlace.value = round(
      (wood + Math.min(trunk * 2, stats.handHouseCount(this.owner, HT_SAWMILL) * 4) - requiredWood) / 3.5,
    );
    this.woodShortage =
      this.predictor.wareBalance[WT_TIMBER].exhaustion < AI_PAR.BUILDER_Shortage_Wood ||
      ((this.predictor.requiredHouses[HT_SAWMILL] > 0 || this.planner.plannedHouses[HT_SAWMILL].planned > 0) && requiredWood > wood && requiredWood < woodReserves);
  }

  /** BuildHouse (902–1080). */
  buildHouse(ignoreTrees: boolean, houseReservation: boolean, ignoreExistingPlans: boolean, typeId: number, roadNodePrio = NODE_PRIO_DEFAULT): string {
    let output = 'csNoNodeAvailable';
    let fieldsComplete = false;
    let node1Idx = -1;
    let node2Idx = -1;
    for (let k = 0; k < this.buildNodes.length; k++) {
      if (!this.buildNodes[k].active) {
        if (node1Idx === -1) node1Idx = k;
        else {
          node2Idx = k;
          break;
        }
      }
    }
    if (node1Idx === -1 || node2Idx === -1) return output;

    output = 'csNoPlaceCanBeFound';
    const plan = this.planner.getHousePlan(ignoreTrees, ignoreExistingPlans, typeId);
    if (plan === null) return output;
    const loc = plan.loc;
    const arr = this.planner.plannedHouses[typeId];
    const planned = arr.plans[plan.idx];
    if (this.world.canAddHousePlan(this.owner, typeId, loc.x, loc.y)) {
      if (planned.houseReservation) {
        output = 'csHouseReservation';
        if (!houseReservation) {
          planned.houseReservation = false;
          fieldsComplete = true;
        }
      }
      if (!planned.houseReservation) {
        output = 'csHousePlaced';
        this.world.addHousePlan(this.owner, typeId, loc.x, loc.y);
        if ((typeId === HT_STORE || typeId === HT_BARRACKS) && loc.y + 2 < this.world.mapY) {
          for (let k = loc.x - 1; k <= loc.x + 1; k++) this.influences.setAvoid(k, loc.y + 2, AVOID_BUILDING_HOUSE_ENTRANCE);
        }
        const node1 = this.buildNodes[node1Idx];
        const road = this.planner.getRoadToHouse(typeId, plan.idx);
        if (road !== null && road.length > 0) {
          node1.fieldList.length = 0;
          for (const p of road) node1.fieldList.push(p);
          this.lockNode(node1);
          node1.active = true;
          node1.priority = roadNodePrio;
          node1.removeTreesMode = false;
          node1.shortcutMode = false;
          node1.maxReqWorkers = round(AI_PAR.BUILDER_BuildHouse_RoadMaxWork) + (NODE_PRIO_ROADS_UNLOCK_HOUSE === roadNodePrio ? 20 : 0);
          node1.requiredWorkers = Math.min(node1.maxReqWorkers, node1.fieldList.length);
          node1.centerPoint = node1.fieldList[node1.fieldList.length - 1];
          if (!fieldsComplete) {
            const node2 = this.buildNodes[node2Idx];
            const fieldType = this.planner.getFieldToHouse(typeId, plan.idx, node2.fieldList);
            if (fieldType !== null) {
              this.lockNode(node2);
              node2.active = true;
              node2.priority = houseReservation ? NODE_PRIO_FIELDS_RESERVATION : NODE_PRIO_FIELDS;
              node2.removeTreesMode = false;
              node2.shortcutMode = false;
              node2.maxReqWorkers = round(AI_PAR.BUILDER_BuildHouse_FieldMaxWork);
              node2.requiredWorkers = Math.min(node2.maxReqWorkers, node2.fieldList.length);
              node2.centerPoint = loc;
              node2.fieldType = fieldType;
            }
          }
          node1.fieldType = 'road';
        } else {
          this.world.remHousePlan(this.owner, loc.x, loc.y);
          return 'csNoPlaceCanBeFound';
        }
        if (houseReservation) {
          planned.houseReservation = true;
          this.world.remHousePlan(this.owner, loc.x, loc.y);
        } else {
          planned.houseReservation = false;
          planned.removeTreeInPlanProcedure = false;
          planned.placed = true;
        }
      }
    } else if (this.eye.canPlaceHouse(loc, typeId, true)) {
      output = 'csRemoveTreeProcedure';
      let check = false;
      if (planned.removeTreeInPlanProcedure) {
        for (const node of this.buildNodes) {
          if (node.active && node.removeTreesMode) {
            check = true;
            break;
          }
        }
      }
      if (!check) {
        const node1 = this.buildNodes[node1Idx];
        const trees = this.planner.getTreesInHousePlan(typeId, plan.idx, node1.fieldList);
        if (trees > 0) {
          planned.removeTreeInPlanProcedure = true;
          for (const node of this.buildNodes) {
            if (node.active && node.removeTreesMode && node.fieldList.length > 0 && node1.fieldList.length > 0 && node.fieldList[0].x === node1.fieldList[0].x && node.fieldList[0].y === node1.fieldList[0].y) {
              node1.fieldList.length = 0;
              return output;
            }
          }
          node1.active = true;
          node1.priority = NODE_PRIO_REMOVE_TREE_IN_PLAN;
          node1.removeTreesMode = true;
          node1.shortcutMode = false;
          node1.maxReqWorkers = round(AI_PAR.BUILDER_BuildHouse_RTPMaxWork);
          node1.requiredWorkers = Math.min(node1.maxReqWorkers, node1.fieldList.length);
          node1.centerPoint = loc;
        } else {
          this.planner.removePlan(typeId, plan.idx);
        }
      }
    } else {
      for (const node of this.buildNodes) {
        if (node.active && node.removeTreesMode && node.centerPoint.x === loc.x && node.centerPoint.y === loc.y) {
          output = 'csRemoveTreeProcedure';
          break;
        }
      }
      if (output === 'csNoPlaceCanBeFound') this.planner.removePlan(typeId, plan.idx);
    }
    return output;
  }

  /** ChooseHousesToBuild (1083–1472). */
  chooseHousesToBuild(tick: number): void {
    const BASIC_HOUSES = [HT_SCHOOL, HT_BARRACKS, HT_INN, HT_MARKET, HT_STORE];
    const ALL_WARE = [WT_CORN, WT_PIG, WT_SAUSAGE, WT_WINE, WT_FISH, WT_STONE, WT_TRUNK, WT_TIMBER, WT_SKIN, WT_LEATHER, WT_HORSE, WT_IRON_ORE, WT_COAL, WT_IRON, WT_AXE, WT_LEATHER_ARMOR, WT_SWORD, WT_IRON_ARMOR, WT_FLOUR, WT_BREAD];
    const BUILD_ORDER_WARE = [WT_STONE, WT_GOLD_ORE, WT_COAL, WT_GOLD, WT_TRUNK, WT_TIMBER];
    const maxPlans = { value: 0 };
    const maxPlace = { value: 0 };
    const trunkBalance = { value: 0 };
    this.checkBasicMaterials(maxPlans, maxPlace, trunkBalance, tick);

    const required = this.predictor.requiredHouses.slice();
    const F = (typeId: number): number => required[typeId];

    // No more than 3 quarries at once when stone shortage is possible.
    required[HT_QUARRY] = required[HT_QUARRY] * (this.stoneShortage && this.planner.plannedHouses[HT_QUARRY].completed < 3 && this.planner.plannedHouses[HT_QUARRY].underConstruction > 2 ? 0 : 1);
    if (this.stoneShortage && required[HT_QUARRY] > 0 && this.planner.plannedHouses[HT_SCHOOL].completed > 0) {
      required[HT_QUARRY] = 0;
      if (this.addToConstruction(required, maxPlace, HT_QUARRY, true, true) === 'csHousePlaced') maxPlans.value -= 1;
    }
    // Do not try to place wine when out of wood.
    required[HT_VINEYARD] = required[HT_VINEYARD] * (this.trunkShortage || maxPlace.value < 3 ? 0 : 1);

    // Chop-only woodcutters when wood runs low.
    if ((AI_PAR.BUILDER_ChHTB_TrunkBalance - trunkBalance.value) / Math.max(1, AI_PAR.BUILDER_ChHTB_TrunkFactor) - this.getChopOnlyCnt() > 0) {
      this.planner.findForestAround(kmPoint(0, 0), true);
    }
    // A woodcutter when there is a forest near a new house.
    const HT = HT_WOODCUTTERS;
    if (
      this.world.handHouseTotalCount(this.owner, HT) < this.planner.plannedHouses[HT].count &&
      !this.stoneShortage &&
      ((this.trunkShortage || !this.goldShortage) && !this.woodShortage) &&
      this.addToConstruction(required, maxPlace, HT, true, true) === 'csHousePlaced'
    ) {
      maxPlans.value -= 1;
      required[HT] = 0;
    }

    if (maxPlace.value > 0) this.checkHouseReservation(required, maxPlace);
    if (maxPlans.value <= 0) return;

    // Basic houses (for city management).
    for (const ht of BASIC_HOUSES) {
      if (required[ht] > 0 && this.addToConstruction(required, maxPlace, ht, true, true) === 'csHousePlaced') {
        maxPlans.value -= 1;
        if (maxPlans.value <= 0) return;
      }
    }
    // The most important houses for city production (soon depleted).
    this.selectHouseBySetOrder(required, maxPlans, maxPlace, BUILD_ORDER_WARE);
    if (maxPlans.value <= 0) return;
    // Watchtowers (the v0 economy half never plans them — PlanDefenceTowers is the army half's).
    const tower = HT_WATCHTOWER;
    const BUILD_TOWER_DELAY = 17 * 60 * 10;
    const MINIMAL_TOWER_DELAY = 50 * 60 * 10;
    if (
      (!this.planner.defenceTowersPlanned || this.world.handHouseTotalCount(this.owner, tower) < this.planner.plannedHouses[tower].count) &&
      tick + BUILD_TOWER_DELAY > this.predictor.peacetimeMinutes * 600 &&
      tick > MINIMAL_TOWER_DELAY &&
      this.addToConstruction(required, maxPlace, tower, true, true) === 'csHousePlaced'
    ) {
      maxPlans.value -= 1;
      if (maxPlans.value <= 0) return;
    }
    // All other houses (food and weapon production).
    this.selectHouse(required, maxPlans, maxPlace, ALL_WARE);
  }

  private getChopOnlyCnt(): number {
    let result = 0;
    for (let k = 0; k < this.planner.plannedHouses[HT_WOODCUTTERS].count; k++) {
      if (this.planner.plannedHouses[HT_WOODCUTTERS].plans[k].chopOnly) result += 1;
    }
    return result;
  }

  /** AddToConstruction (1159–1194) with the unlock procedure (GetHousesToUnlock 1127–1156). */
  private addToConstruction(
    required: number[],
    maxPlace: { value: number },
    typeId: number,
    unlockProcedureAllowed = false,
    ignoreWareReserves = false,
  ): string {
    let output = 'csCannotPlaceHouse';
    if (this.stoneCrisis && typeId !== HT_QUARRY && typeId !== HT_SCHOOL && typeId !== HT_INN) return output;
    const unlock = this.getHousesToUnlock(typeId);
    if (unlock !== null && (unlockProcedureAllowed || unlock.length === 1)) {
      const materialShortage =
        maxPlace.value <= 0 || (!ignoreWareReserves && (this.woodShortage || this.trunkShortage || this.stoneShortage || this.goldShortage));
      const ignoreTreesInPlan = !(unlock.length > 1 || materialShortage);
      for (let k = 0; k < unlock.length; k++) {
        if (k !== unlock.length - 1 || unlock.length === 1 || this.planner.plannedHouses[unlock[k]].count === 0) {
          const houseReservation = materialShortage || k !== unlock.length - 1;
          const ignoreExistingPlans =
            unlock.length === 1 && materialShortage && typeId !== HT_WOODCUTTERS && typeId !== HT_GOLD_MINE && typeId !== HT_IRON_MINE && typeId !== HT_COAL_MINE;
          let nodePrio: number;
          if (k !== unlock.length - 1) nodePrio = NODE_PRIO_ROADS_RESERVATION;
          else if (unlock.length === 1) nodePrio = NODE_PRIO_ROADS;
          else nodePrio = NODE_PRIO_ROADS_UNLOCK_HOUSE;
          output = this.buildHouse(ignoreTreesInPlan, houseReservation, ignoreExistingPlans, unlock[k], nodePrio);
          required[unlock[k]] = 0;
        }
      }
    } else if (unlockProcedureAllowed && this.tryUnlockByRnd(typeId) !== null) {
      output = this.buildHouse(false, false, false, typeId);
      required[typeId] = 0;
    }
    return output;
  }

  /** GetHousesToUnlock (1127–1156): the chain of houses needed to unlock a type. */
  private getHousesToUnlock(typeId: number): number[] | null {
    const arr = [typeId];
    let ht = typeId;
    while (!this.world.houseCanBuild(this.owner, ht)) {
      // v0: mission house blocks do not exist (HouseBlocked is always false).
      if (ht === HT_QUARRY && !this.world.houseCanBuild(this.owner, HT_SCHOOL)) {
        if (this.planner.plannedHouses[HT_SCHOOL].completed > 0) arr.push(HT_INN);
        else arr.push(HT_INN, HT_SCHOOL);
        return arr;
      }
      const releasedBy = unlockedByHouse(ht);
      if (releasedBy < 0) return null;
      ht = releasedBy;
      arr.push(ht);
    }
    return arr;
  }

  /** TryUnlockByRnd (1108–1125). */
  private tryUnlockByRnd(typeId: number): number | null {
    const FORBIDDEN = [HT_IRON_MINE, HT_GOLD_MINE, HT_COAL_MINE, HT_VINEYARD, HT_STABLES, HT_FISHER_HUT, HT_TOWN_HALL, HT_SIEGE_WORKSHOP, HT_IRON_SMITHY, HT_ARMOR_SMITHY, HT_WEAPON_SMITHY];
    for (let ht = 0; ht < 30; ht++) {
      if (ht === 26) continue;
      if (FORBIDDEN.includes(ht)) continue;
      if (this.world.handHouseTotalCount(this.owner, ht) !== 0) continue;
      if (!this.world.houseCanBuild(this.owner, ht)) continue;
      void typeId;
      return ht;
    }
    return null;
  }

  /** SelectHouseBySetOrder (1272–1303). */
  private selectHouseBySetOrder(required: number[], maxPlans: { value: number }, maxPlace: { value: number }, order: number[]): void {
    for (const wt of order) {
      const ht = PRODUCTION_WARE2HOUSE[wt];
      if (required[ht] > 0 && this.predictor.wareBalance[wt].exhaustion < 30) {
        required[ht] = 0;
        const allowStoneReservation = !this.stoneShortage || (wt === WT_STONE && this.planner.plannedHouses[HT_SCHOOL].completed === 0);
        const state = this.addToConstruction(required, maxPlace, ht, allowStoneReservation, allowStoneReservation);
        if (state === 'csHousePlaced') {
          maxPlans.value = 0;
          return;
        }
        if (state === 'csNoPlaceCanBeFound' && (ht === HT_IRON_MINE || ht === HT_GOLD_MINE || ht === HT_COAL_MINE)) {
          this.predictor.markExhaustedMine(ht);
        }
      }
    }
  }

  /** CheckHouseReservation (1305–1388). */
  private checkHouseReservation(required: number[], maxPlace: { value: number }): void {
    const RESERVATION_FULL_SET = [HT_SCHOOL, HT_INN, HT_QUARRY, HT_MARKET, HT_WOODCUTTERS, HT_SAWMILL, HT_GOLD_MINE, HT_COAL_MINE, HT_METALLURGISTS, HT_BARRACKS, HT_FARM, HT_MILL, HT_BAKERY, HT_SWINE, HT_BUTCHERS, HT_STABLES, HT_FISHER_HUT, HT_IRON_MINE, HT_IRON_SMITHY, HT_ARMOR_SMITHY, HT_WEAPON_SMITHY, HT_TANNERY, HT_ARMOR_WORKSHOP, HT_WEAPON_WORKSHOP, HT_SIEGE_WORKSHOP, HT_TOWN_HALL, HT_VINEYARD, HT_STORE, HT_WATCHTOWER];
    const STONE_SHORTAGE_IDX = 2;
    const TRUNK_SHORTAGE_IDX = 4;
    const WOOD_SHORTAGE_IDX = 8;
    const GOLD_SHORTAGE_IDX = 8;
    const FULL_SET = 28;
    let minIdx = 0;
    let maxIdx: number;
    if (this.stoneShortage) maxIdx = STONE_SHORTAGE_IDX;
    else if (this.woodShortage) {
      maxIdx = WOOD_SHORTAGE_IDX;
      if (this.planner.plannedHouses[HT_SAWMILL].completed === 0) minIdx = TRUNK_SHORTAGE_IDX + 1;
    } else if (this.trunkShortage && maxPlace.value < 3) maxIdx = TRUNK_SHORTAGE_IDX;
    else if (this.goldShortage) maxIdx = GOLD_SHORTAGE_IDX;
    else maxIdx = FULL_SET;

    const reservations = new Array<number>(30).fill(0);
    for (let k = minIdx; k <= maxIdx; k++) {
      const ht = RESERVATION_FULL_SET[k];
      for (let l = 0; l < this.planner.plannedHouses[ht].count; l++) {
        const plan = this.planner.plannedHouses[ht].plans[l];
        if (!plan.placed && (plan.houseReservation || plan.removeTreeInPlanProcedure)) reservations[ht] += 1;
      }
    }
    let overflow = 0;
    while (maxPlace.value > 0 && overflow <= maxIdx) {
      overflow += 1;
      let bestHT = -1;
      let bestGain = -1e10;
      for (let k = minIdx; k <= maxIdx; k++) {
        const ht = RESERVATION_FULL_SET[k];
        if (reservations[ht] > 0) {
          if (this.planner.plannedHouses[ht].completed === 0 && this.planner.plannedHouses[ht].underConstruction === 0) {
            bestHT = ht;
            break;
          }
          const gain = reservations[ht] * 2 - k;
          if (gain > bestGain) {
            bestHT = ht;
            bestGain = gain;
          }
        }
      }
      if (bestHT === -1) return;
      if (this.addToConstruction(required, maxPlace, bestHT, false, true) === 'csHousePlaced') {
        maxPlace.value -= 1;
        required[bestHT] = 0;
      }
      reservations[bestHT] = 0;
    }
  }

  /** SelectHouse (1197–1270): the bubble-sorted priority list over a ware set. */
  private selectHouse(required: number[], maxPlans: { value: number }, maxPlace: { value: number }, wareSet: number[]): boolean {
    const MAX_ORDER = 11;
    const wareOrder: number[] = new Array<number>(MAX_ORDER).fill(-1);
    const warePriority: number[] = new Array<number>(MAX_ORDER).fill(1000000);
    for (const ware of wareSet) {
      let wt = ware;
      const ht = PRODUCTION_WARE2HOUSE[wt];
      if (required[ht] > 0) {
        let priority =
          this.predictor.wareBalance[wt].exhaustion -
          this.predictor.wareBalance[wt].fraction * AI_PAR.BUILDER_ChHTB_FractionCoef -
          (ht === HT_BAKERY ? 1000 : 0);
        for (let k = 0; k < MAX_ORDER; k++) {
          if (wt === -1) break;
          if (wareOrder[k] === -1 || priority < warePriority[k]) {
            const pom = wt;
            wt = wareOrder[k];
            wareOrder[k] = pom;
            const p = priority;
            priority = warePriority[k];
            warePriority[k] = p;
          }
        }
      }
    }
    let output = false;
    for (let k = 0; k < MAX_ORDER; k++) {
      if (wareOrder[k] === -1) break;
      const ht = PRODUCTION_WARE2HOUSE[wareOrder[k]];
      if (required[ht] <= 0) continue;
      const state = this.addToConstruction(required, maxPlace, ht, ht === HT_FARM || ht === HT_VINEYARD, false);
      if (state === 'csNoNodeAvailable') break;
      if (state === 'csHouseReservation' || state === 'csRemoveTreeProcedure') output = true;
      else if (state === 'csHousePlaced') {
        output = true;
        maxPlans.value -= 1;
        maxPlace.value -= 1;
        if (maxPlans.value <= 0) break;
      } else if (state === 'csNoPlaceCanBeFound') {
        if (ht === HT_IRON_MINE || ht === HT_GOLD_MINE || ht === HT_COAL_MINE) this.predictor.markExhaustedMine(ht);
      }
      required[ht] = 0;
    }
    return output;
  }

  /** CreateShortcuts (1475–1657). */
  createShortcuts(): void {
    const MAX_SHORTCUTS_PER_HOUSE_TYPE = 2;
    const MAX_DISTANCE_TO_ALL_HOUSES = 10;
    const HOUSE_CONNECTION: number[][] = [];
    HOUSE_CONNECTION[HT_ARMOR_SMITHY] = [HT_IRON_SMITHY, HT_COAL_MINE, HT_BARRACKS];
    HOUSE_CONNECTION[HT_ARMOR_WORKSHOP] = [HT_TANNERY, HT_BARRACKS];
    HOUSE_CONNECTION[HT_BAKERY] = [HT_INN, HT_STORE, HT_MILL];
    HOUSE_CONNECTION[HT_BARRACKS] = [HT_SCHOOL];
    HOUSE_CONNECTION[HT_BUTCHERS] = [HT_INN, HT_STORE, HT_SWINE];
    HOUSE_CONNECTION[HT_COAL_MINE] = [];
    HOUSE_CONNECTION[HT_FARM] = [];
    HOUSE_CONNECTION[HT_FISHER_HUT] = [];
    HOUSE_CONNECTION[HT_GOLD_MINE] = [HT_METALLURGISTS];
    HOUSE_CONNECTION[HT_INN] = [HT_STORE, HT_INN];
    HOUSE_CONNECTION[HT_IRON_MINE] = [HT_IRON_SMITHY];
    HOUSE_CONNECTION[HT_IRON_SMITHY] = [HT_COAL_MINE, HT_WEAPON_SMITHY, HT_ARMOR_SMITHY];
    HOUSE_CONNECTION[HT_MARKET] = [HT_STORE];
    HOUSE_CONNECTION[HT_METALLURGISTS] = [HT_SCHOOL, HT_GOLD_MINE, HT_COAL_MINE];
    HOUSE_CONNECTION[HT_MILL] = [HT_FARM, HT_BAKERY];
    HOUSE_CONNECTION[HT_QUARRY] = [HT_STORE];
    HOUSE_CONNECTION[HT_SAWMILL] = [HT_ARMOR_WORKSHOP, HT_STORE];
    HOUSE_CONNECTION[HT_SCHOOL] = [HT_METALLURGISTS, HT_STORE, HT_BARRACKS];
    HOUSE_CONNECTION[HT_SIEGE_WORKSHOP] = [HT_IRON_SMITHY, HT_SAWMILL, HT_STORE];
    HOUSE_CONNECTION[HT_STABLES] = [HT_FARM, HT_BARRACKS];
    HOUSE_CONNECTION[HT_STORE] = [HT_INN, HT_BARRACKS, HT_SCHOOL];
    HOUSE_CONNECTION[HT_SWINE] = [HT_FARM, HT_BUTCHERS];
    HOUSE_CONNECTION[HT_TANNERY] = [HT_ARMOR_WORKSHOP, HT_SWINE];
    HOUSE_CONNECTION[HT_TOWN_HALL] = [HT_METALLURGISTS, HT_STORE];
    HOUSE_CONNECTION[HT_WATCHTOWER] = [];
    HOUSE_CONNECTION[HT_WEAPON_SMITHY] = [HT_IRON_SMITHY, HT_COAL_MINE, HT_BARRACKS];
    HOUSE_CONNECTION[HT_WEAPON_WORKSHOP] = [HT_SAWMILL, HT_BARRACKS];
    HOUSE_CONNECTION[HT_VINEYARD] = [HT_INN];
    HOUSE_CONNECTION[HT_WOODCUTTERS] = [];
    for (let i = 0; i < 30; i++) if (HOUSE_CONNECTION[i] === undefined) HOUSE_CONNECTION[i] = [];

    if (
      this.predictor.wareBalance[WT_STONE].exhaustion < 60 ||
      this.predictor.wareBalance[WT_GOLD].exhaustion < 60 ||
      this.world.handHouseCount(this.owner, HT_SCHOOL) === 0 ||
      this.world.handUnitCount(this.owner, UT_BUILDER) === 0
    ) {
      return;
    }
    if (this.buildNodes.length === 0) return;
    let nodeIdx = -1;
    for (let k = 0; k < this.buildNodes.length; k++) {
      if (!this.buildNodes[k].active) {
        nodeIdx = k;
        break;
      }
    }
    if (nodeIdx === -1 || this.buildNodes[Math.min(this.buildNodes.length - 1, nodeIdx)].active) return;

    // Find a house which was not checked for shortcuts yet.
    let baseHT = -1;
    let baseLoc: Pt | null = null;
    outer: for (let ht = 0; ht < 30; ht++) {
      if (ht === HT_WOODCUTTERS) continue;
      const arr = this.planner.plannedHouses[ht];
      for (let k = 0; k < arr.count; k++) {
        if (arr.plans[k].placed && !arr.plans[k].shortcutsCompleted) {
          arr.plans[k].shortcutsCompleted = true;
          baseLoc = kmPoint(arr.plans[k].loc.x, arr.plans[k].loc.y + 1);
          baseHT = ht;
          break outer;
        }
      }
    }
    if (baseHT === -1 || baseLoc === null) return;

    if (baseHT === HT_STORE || baseHT === HT_BARRACKS) {
      if (baseLoc.y < this.world.mapY - 1) {
        for (let k = baseLoc.x - 1; k <= baseLoc.x + 1; k++) {
          this.influences.setAvoid(k, baseLoc.y + 1, 255);
          if (this.world.canAddFieldPlan(this.owner, k, baseLoc.y + 1, 'road')) {
            this.world.addFieldPlan(this.owner, k, baseLoc.y + 1, 'road');
          }
        }
      }
    }

    const node = this.buildNodes[nodeIdx];
    const planRoad = (locs: { loc: Pt; tag: number }[], allLocs: boolean): void => {
      if (locs.length === 0) return;
      if (!allLocs) locs.sort((a, b) => a.tag - b.tag);
      let cnt = 0;
      for (const item of locs) {
        const route = this.planner.getRoadBetweenPoints(item.loc, baseLoc as Pt);
        if (route !== null) {
          for (const p of route) node.fieldList.push(p);
          cnt += 1;
          this.lockNode(node);
          if (!allLocs && cnt === MAX_SHORTCUTS_PER_HOUSE_TYPE) break;
        }
      }
      if (node.fieldList.length > 0) {
        node.active = true;
        node.priority = NODE_PRIO_SHORTCUTS;
        node.removeTreesMode = false;
        node.shortcutMode = true;
        node.maxReqWorkers = round(AI_PAR.BUILDER_CreateShortcuts_MaxWork);
        node.requiredWorkers = Math.min(node.maxReqWorkers, node.fieldList.length);
        node.centerPoint = node.fieldList[0];
        node.fieldType = 'road';
      }
    };

    // Basic connections for the house's network.
    for (const ht of HOUSE_CONNECTION[baseHT]) {
      const locs: { loc: Pt; tag: number }[] = [];
      for (let l = 0; l < this.planner.plannedHouses[ht].count; l++) {
        const plan = this.planner.plannedHouses[ht].plans[l];
        if (plan.placed) locs.push({ loc: kmPoint(plan.loc.x, plan.loc.y + 1), tag: distanceAbs(plan.loc, baseLoc) });
      }
      planRoad(locs, false);
    }
    // Additional shortcuts to the closest houses.
    const locs: { loc: Pt; tag: number }[] = [];
    for (let ht = 0; ht < 30; ht++) {
      if (ht === HT_WOODCUTTERS) continue;
      for (let k = 0; k < this.planner.plannedHouses[ht].count; k++) {
        const plan = this.planner.plannedHouses[ht].plans[k];
        if (!plan.placed) continue;
        const dist = distanceAbs(baseLoc, kmPoint(plan.loc.x, plan.loc.y + 1));
        if (dist !== 0 && dist < MAX_DISTANCE_TO_ALL_HOUSES) locs.push({ loc: kmPoint(plan.loc.x, plan.loc.y + 1), tag: dist });
      }
    }
    planRoad(locs, true);
  }
}

// === END OF PART 3B ===

// ---------------------------------------------------------------------------------------------
// CityManagement (KM_CityManagement.pas)

/** TRAINING_PRIORITY / TRAINING_PRIORITY_Serf (KM_CityManagement.pas 204–211), unit records. */
const TRAINING_PRIORITY = [UT_MINER, UT_METALLURGIST, UT_STONEMASON, UT_WOODCUTTER, UT_CARPENTER, UT_FARMER, UT_ANIMAL_BREEDER, UT_BAKER, UT_BUTCHER, UT_FISHER, UT_SMITH, UT_SERF, UT_BUILDER, UT_RECRUIT];
const TRAINING_PRIORITY_SERF = [UT_MINER, UT_METALLURGIST, UT_STONEMASON, UT_WOODCUTTER, UT_CARPENTER, UT_SERF, UT_FARMER, UT_ANIMAL_BREEDER, UT_BAKER, UT_BUTCHER, UT_FISHER, UT_SMITH, UT_BUILDER, UT_RECRUIT];
const DISMISS_UNITS = [UT_MINER, UT_METALLURGIST, UT_STONEMASON, UT_WOODCUTTER, UT_CARPENTER, UT_FARMER, UT_ANIMAL_BREEDER, UT_BAKER, UT_BUTCHER, UT_FISHER, UT_SMITH, UT_BUILDER];

/** TKMWarfareArr entry (KM_CityManagement.pas 15–18) — worker N's army interface. */
export interface WeaponDemand {
  available: number;
  required: number;
  fraction: number;
}

/**
 * TKMCityManagement: the economy manager — it drives the builder + predictor, the school training
 * and the ware/weapon bookkeeping. v0 gaps (flagged): market trading, store NotAcceptFlag
 * blocking, auto-repair and WareDistribution need world features the v0 slice does not have;
 * the demand computation (weapons balance) is kept as worker N's interface.
 */
export class CityManagement {
  owner: number;
  readonly builder: CityBuilder;
  readonly predictor: CityPredictor;
  requiredUnitsCnt = 0;
  /** WARFARE_MIN..WARFARE_MAX (wtWoodenShield..wtHorse) demands — the army half reads these. */
  readonly requiredWeapons: WeaponDemand[] = [];
  /** WARRIOR_EQUIPABLE_BARRACKS_MIN..MAX (utMilitia..utKnight) demands. */
  readonly warriorsDemands: number[] = new Array<number>(9).fill(0);

  private readonly world: EconomyWorld;
  private readonly setup: AiSetup;

  constructor(world: EconomyWorld, owner: number, setup: AiSetup, builder: CityBuilder, predictor: CityPredictor) {
    this.world = world;
    this.owner = owner;
    this.setup = setup;
    this.builder = builder;
    this.predictor = predictor;
    for (let w = WARE_WARFARE_MIN; w <= WARE_WARFARE_MAX; w++) {
      this.requiredWeapons.push({ available: 0, required: 0, fraction: 0 });
    }
  }

  ownerUpdate(hand: number): void {
    this.owner = hand;
    this.predictor.ownerUpdate(hand);
    this.builder.ownerUpdate(hand);
  }

  /** AfterMissionInit (137–148): the city's resource scan + the predictor/builder startup. */
  afterMissionInit(eye: Eye, planner: CityPlanner): void {
    eye.scanLoc(planner, this.predictor);
    this.predictor.afterMissionInit();
    this.builder.afterMissionInit();
  }

  /** UpdateState (151–194): the city slice every 27, the management slice every 54. */
  updateState(tick: number): void {
    const LONG_UPDATE = MAX_HANDS * 2; // 54
    if (this.setup.autoBuild && tick % MAX_HANDS === this.owner) {
      this.builder.updateState(tick);
      this.predictor.updateState(tick);
      this.builder.chooseHousesToBuild(tick);
    }
    if (tick % LONG_UPDATE === this.owner) {
      this.checkUnitCount(tick);
      // CheckMarketplaces: no market house in v0 (flagged).
      // CheckStoreWares: no NotAcceptFlag in v0 (flagged).
      // CheckAutoRepair: no repair mode in v0 (flagged).
      // CheckWareDistribution: no WareDistribution in v0 (flagged).
      this.weaponsBalance();
      this.orderWeapons();
      // CheckExhaustedHouses: mines do not deplete in v0 (flagged).
    }
  }

  /** CheckUnitCount (197–438): the school training priority list. */
  checkUnitCount(tick: number): void {
    const MAX_QUEUE = 4;
    const stats = this.world;
    const unitReq = new Array<number>(14).fill(0);
    const unitTrain = new Array<number>(14).fill(0);
    const houses = new Array<number>(30).fill(0);

    // GoldShortage (350–361).
    let goldProduced = 0;
    for (const h of this.world.houses) {
      if (h.owner !== this.owner || h.destroyed || h.buildState !== 'done') continue;
      const spec = stats.houseSpecOf(h.typeId);
      if (spec !== undefined && spec.resOut.includes(WT_GOLD)) goldProduced += 1;
    }
    const goldShortage = stats.handWareBalance(this.owner, WT_GOLD) < AI_PAR.MANAGEMENT_GoldShortage && goldProduced === 0;
    if (goldShortage) {
      unitReq[UT_SERF] = 3;
      unitReq[UT_BUILDER] = this.predictor.workerCount > 0 && (this.setup.autoBuild || this.setup.isRepairAlways) ? 1 : 0;
      unitReq[UT_MINER] =
        stats.handHouseTotalCount(this.owner, HT_COAL_MINE) + stats.handHouseTotalCount(this.owner, HT_GOLD_MINE) + stats.handHouseCount(this.owner, HT_IRON_MINE);
      unitReq[UT_METALLURGIST] = stats.handHouseTotalCount(this.owner, HT_METALLURGISTS) + stats.handHouseCount(this.owner, HT_IRON_SMITHY);
      unitReq[UT_WOODCUTTER] = stats.handHouseCount(this.owner, HT_WOODCUTTERS) > 0 ? 1 : 0;
      unitReq[UT_STONEMASON] = stats.handHouseCount(this.owner, HT_QUARRY) > 0 ? 1 : 0;
      unitReq[UT_CARPENTER] = stats.handHouseCount(this.owner, HT_SAWMILL) > 0 ? 1 : 0;
    } else {
      // Count the houses that can take a worker (completed or with progress).
      for (const h of this.world.houses) {
        if (h.owner !== this.owner || h.destroyed) continue;
        if (h.buildState === 'done') houses[h.typeId] += 1;
        else if (h.buildingProgress > 0 && h.typeId !== HT_WATCHTOWER) houses[h.typeId] += 1;
      }
      for (let ht = 0; ht < 30; ht++) {
        const spec = stats.houseSpecOf(ht);
        if (spec === undefined || spec.workerType < 0) continue;
        if (ht === HT_BARRACKS) continue;
        unitTrain[spec.workerType] += houses[ht];
      }
      const recruitsNeeded = this.recruitsNeeded(tick, houses[HT_WATCHTOWER]);
      if (stats.handWareBalance(this.owner, WT_GOLD) > AI_PAR.MANAGEMENT_GoldShortage * AI_PAR.MANAGEMENT_CheckUnitCount_WorkerGoldCoef || goldProduced > 0) {
        unitReq[UT_BUILDER] = this.predictor.workerCount * (this.setup.autoBuild ? 1 : 0);
        unitReq[UT_RECRUIT] = recruitsNeeded;
      }
      if (stats.handWareBalance(this.owner, WT_GOLD) > AI_PAR.MANAGEMENT_GoldShortage * AI_PAR.MANAGEMENT_CheckUnitCount_SerfGoldCoef || goldProduced > 0) {
        unitReq[UT_SERF] = stats.handUnitCount(this.owner, UT_SERF) + this.requiredSerfCount();
      }
    }

    // Consider the existing units.
    this.requiredUnitsCnt = 0;
    for (let ut = 0; ut < unitReq.length; ut++) {
      unitReq[ut] = unitReq[ut] - stats.handUnitCount(this.owner, ut);
      unitTrain[ut] = unitTrain[ut] + unitReq[ut];
      this.requiredUnitsCnt = Math.min(this.requiredUnitsCnt + Math.max(0, unitReq[ut]), 65535);
    }

    // Find the completed schools; decrease UnitReq by the already trained citizens.
    const schools: number[] = []; // school house uids
    for (const h of this.world.houses) {
      if (h.owner !== this.owner || h.destroyed || h.buildState !== 'done' || h.typeId !== HT_SCHOOL) continue;
      if (goldShortage && stats.wareCount(h, WT_GOLD) === 0) continue;
      const queue = stats.schoolQueueOf(h.uid);
      for (let l = queue.length - 1; l >= 0; l--) {
        if (queue[l] !== -1) {
          if (l === 0) unitTrain[queue[l]] -= 1;
          else stats.schoolQueueOf(h.uid)[l] = -1; // remove from the queue (RemUnitFromQueue)
        }
      }
      schools.push(h.uid);
    }

    // Order the citizen training.
    if (schools.length > 0) {
      const priority = stats.handUnitCount(this.owner, UT_SERF) < stats.handHouseAnyCount(this.owner) ? TRAINING_PRIORITY_SERF : TRAINING_PRIORITY;
      for (const ut of priority) {
        while (unitTrain[ut] > 0) {
          let minQueue = MAX_QUEUE;
          let minIdx = -1;
          for (let l = 0; l < schools.length; l++) {
            const qc = stats.schoolQueueCount(schools[l]);
            if (qc < minQueue) {
              minQueue = qc;
              minIdx = l;
            }
          }
          if (minQueue < MAX_QUEUE && minIdx >= 0) {
            const added = stats.schoolAddUnitToQueue(schools[minIdx], ut, 1);
            if (added <= 0) break; // defensive: a non-school state can never block the loop
            unitTrain[ut] -= added;
          } else break;
        }
      }
    }
    this.dismissUnusedUnits(unitReq, houses);
  }

  /** RecruitsNeeded (220–246). */
  private recruitsNeeded(tick: number, completedWatchtowers: number): number {
    const RECRUIT_PEACE_DELAY = 17 * 60 * 10;
    const MIN_2_TICK = 600;
    let output = completedWatchtowers;
    const stats = this.world;
    if (
      tick + RECRUIT_PEACE_DELAY > this.predictor.peacetimeMinutes * MIN_2_TICK &&
      stats.handHouseCount(this.owner, HT_BARRACKS) > 0 &&
      tick > this.setup.recruitDelay * MIN_2_TICK
    ) {
      if (this.setup.unlimitedEquip) {
        output += Math.min(
          stats.handWareBalance(this.owner, WT_IRON_ARMOR),
          stats.handWareBalance(this.owner, WT_CROSSBOW) + stats.handWareBalance(this.owner, WT_PIKE) + Math.min(stats.handWareBalance(this.owner, WT_SWORD), stats.handWareBalance(this.owner, WT_IRON_SHIELD)),
        );
        output += Math.min(
          stats.handWareBalance(this.owner, WT_LEATHER_ARMOR),
          stats.handWareBalance(this.owner, WT_BOW) + stats.handWareBalance(this.owner, WT_LANCE) + Math.min(stats.handWareBalance(this.owner, WT_AXE), stats.handWareBalance(this.owner, WT_WOODEN_SHIELD)),
        );
        output += Math.max(
          0,
          stats.handWareBalance(this.owner, WT_AXE) - Math.min(stats.handWareBalance(this.owner, WT_LEATHER_ARMOR), stats.handWareBalance(this.owner, WT_WOODEN_SHIELD)),
        );
      } else output += 10;
    }
    return output;
  }

  /** RequiredSerfCount (248–268). */
  private requiredSerfCount(): number {
    const stats = this.world;
    const serfCount = stats.handUnitCount(this.owner, UT_SERF);
    let result = Math.max(0, round(stats.handUnitCount(this.owner, UT_BUILDER) - serfCount));
    let idleCount = 0;
    for (const u of this.world.units) {
      if (u.dead || u.owner !== this.owner || u.type !== UT_SERF) continue;
      if (u.taskKind === 'idle' && u.action === 'stay') idleCount += 1;
    }
    if (idleCount === 0) {
      result = Math.max(
        1 +
          (serfCount < AI_PAR.MANAGEMENT_CheckUnitCount_SerfLimit1 ? 1 : 0) +
          (serfCount < AI_PAR.MANAGEMENT_CheckUnitCount_SerfLimit2 ? 1 : 0) +
          (serfCount < AI_PAR.MANAGEMENT_CheckUnitCount_SerfLimit3 ? 1 : 0),
        result,
      );
    }
    return result;
  }

  /** DismissUnusedUnits (298–328): the v0 slice has no Dismiss (flagged); the requirement adjust
   *  (builder count × CityCompleted + planned houses → units) is kept so the school trains right. */
  private dismissUnusedUnits(unitReq: number[], _houses: number[]): void {
    unitReq[UT_BUILDER] = unitReq[UT_BUILDER] * (this.predictor.cityCompleted ? 1 : 0);
    for (let ht = 0; ht < 30; ht++) {
      const spec = this.world.houseSpecOf(ht);
      if (spec === undefined || spec.workerType < 0 || ht === HT_BARRACKS) continue;
      unitReq[spec.workerType] += this.builder.planner.plannedHouses[ht].count;
    }
    // Dismiss (the Pascal) — v0 has no unit dismiss; flagged.
  }

  /** WeaponsBalance (776–1044): the weapon/armor demands worker N reads (OrderWeapons needs the
   *  house WareOrder the v0 world does not have). */
  weaponsBalance(): void {
    const IRON_WEAPONS = [WT_SWORD, WT_PIKE, WT_CROSSBOW];
    const IRON_ARMORS = [WT_IRON_ARMOR, WT_IRON_SHIELD];
    const stats = this.world;
    const armorCnt = stats.handHouseCount(this.owner, HT_ARMOR_SMITHY) + stats.handHouseCount(this.owner, HT_ARMOR_WORKSHOP);
    const smithyCnt = stats.handHouseCount(this.owner, HT_WEAPON_SMITHY);
    const workshopCnt = stats.handHouseCount(this.owner, HT_WEAPON_WORKSHOP);
    if (armorCnt + smithyCnt + workshopCnt === 0) return;
    // Get the weapon reserves.
    for (let i = 0; i < this.requiredWeapons.length; i++) {
      this.requiredWeapons[i].available = stats.handWareBalance(this.owner, WARE_WARFARE_MIN + i);
      this.requiredWeapons[i].required = 0;
    }
    for (let i = 0; i < this.warriorsDemands.length; i++) this.warriorsDemands[i] = 0;
    // The v0 economy half does not predict the enemy army (worker N); the minimum requirements
    // keep a baseline production: the DEFAULT_ARMY_REQUIREMENTS of the Pascal (866–870).
    const DEFAULT_COEFICIENT = 15;
    const DEFAULT_ARMY_REQUIREMENTS = [1, 1, 1, 3, 2, 1, 1, 0.5, 0.5]; // utMilitia..utKnight
    const TROOP_COST: number[][] = [
      [WT_AXE, -1, -1, -1], // utMilitia
      [WT_WOODEN_SHIELD, WT_LEATHER_ARMOR, WT_AXE, -1], // utAxeFighter
      [WT_IRON_SHIELD, WT_IRON_ARMOR, WT_SWORD, -1], // utSwordFighter
      [WT_LEATHER_ARMOR, WT_BOW, -1, -1], // utBowman
      [WT_IRON_ARMOR, WT_CROSSBOW, -1, -1], // utCrossbowman
      [WT_LEATHER_ARMOR, WT_LANCE, -1, -1], // utLanceCarrier
      [WT_IRON_ARMOR, WT_PIKE, -1, -1], // utPikeman
      [WT_WOODEN_SHIELD, WT_LEATHER_ARMOR, WT_AXE, WT_HORSE], // utScout
      [WT_IRON_SHIELD, WT_IRON_ARMOR, WT_SWORD, WT_HORSE], // utKnight
    ];
    for (let ut = UT_AXE_FIGHTER; ut <= UT_KNIGHT; ut++) {
      for (const cost of TROOP_COST[ut - UT_MILITIA]) {
        if (cost < 0) break;
        const idx = cost - WARE_WARFARE_MIN;
        if (idx >= 0 && idx < this.requiredWeapons.length) {
          this.requiredWeapons[idx].required += round(DEFAULT_COEFICIENT * DEFAULT_ARMY_REQUIREMENTS[ut - UT_MILITIA]);
        }
      }
    }
    // Fractions.
    for (const d of this.requiredWeapons) d.fraction = Math.max(1, d.available) / Math.max(1, d.required);
    // Do not produce bows and lances without leather.
    if (this.predictor.peacetimeMinutes < 45 && stats.handWareBalance(this.owner, WT_LEATHER) === 0 && stats.handWareBalance(this.owner, WT_LEATHER_ARMOR) === 0) {
      this.requiredWeapons[WT_BOW - WARE_WARFARE_MIN].fraction = 1;
      this.requiredWeapons[WT_LANCE - WARE_WARFARE_MIN].fraction = 1;
      this.requiredWeapons[WT_AXE - WARE_WARFARE_MIN].fraction = 0;
    }
    // The iron share drives WareDistribution in the Pascal (no WareDistribution in v0, flagged).
    let weaponFraction = 0;
    for (const wt of IRON_WEAPONS) weaponFraction += this.requiredWeapons[wt - WARE_WARFARE_MIN].fraction;
    weaponFraction /= 3.0;
    let armorFraction: number;
    if (this.requiredWeapons[WT_IRON_ARMOR - WARE_WARFARE_MIN].fraction > this.requiredWeapons[WT_IRON_SHIELD - WARE_WARFARE_MIN].fraction) {
      armorFraction = 0;
      for (const wt of IRON_ARMORS) armorFraction += this.requiredWeapons[wt - WARE_WARFARE_MIN].fraction;
      armorFraction /= 2.0;
    } else {
      armorFraction = this.requiredWeapons[WT_IRON_ARMOR - WARE_WARFARE_MIN].fraction;
    }
    void weaponFraction;
    void armorFraction;
  }

  /**
   * CheckWeaponOrderCount (KM_AIMayor.pas 278–329): a workshop without an order left gets the orders of its
   * products, in portions of 8. v0 simplification: the Pascal WarfareRatios (KM_AIMayorBalance) are replaced
   * by each product's deficit (required − available, floored at 0), normalised over the house's outputs.
   */
  orderWeapons(): void {
    const PORTIONS = 8;
    const stats = this.world;
    for (const h of stats.houses) {
      if (h.owner !== this.owner || h.destroyed || h.buildState !== 'done') continue;
      if (h.typeId !== HT_WEAPON_WORKSHOP && h.typeId !== HT_ARMOR_WORKSHOP) continue;
      const spec = stats.houseSpecOf(h.typeId);
      if (spec === undefined) continue;
      let ordered = 0;
      for (let r = 1; r <= 4; r++) ordered += stats.wareOrderOf(h.uid, r);
      if (ordered !== 0) continue;
      const deficit: number[] = [];
      let sum = 0;
      for (let r = 1; r <= 4; r++) {
        const ware = spec.resOut[r - 1];
        const demand = ware >= WARE_WARFARE_MIN && ware - WARE_WARFARE_MIN < this.requiredWeapons.length
          ? this.requiredWeapons[ware - WARE_WARFARE_MIN]
          : undefined;
        const d = demand !== undefined ? Math.max(demand.required - demand.available, 0) : 0;
        deficit.push(d);
        sum += d;
      }
      if (sum <= 0) continue;
      for (let r = 1; r <= 4; r++) stats.setWareOrder(h.uid, r, Math.round((deficit[r - 1] / sum) * PORTIONS));
    }
  }
}

/**
 * KM_Houses.pas 562–566: a mission house (hbsDone) runs Activate(False) → Locks.HouseCreated, so
 * the map's starting houses unlock their build chains. The v0 world's mission-house path skips
 * Activate (the M5a flag: "the AI ignores FOW", locks only from built houses), so the AI scenario
 * applies the unlock pass explicitly. Existing frozen scenarios (buildsim/econsim/combatsim) never
 * call this, so their lock arrays stay unchanged.
 */
export function applyMissionHouseUnlocks(world: EconomyWorld, hand: number): void {
  for (const h of world.houses) {
    if (h.owner === hand && !h.destroyed && h.buildState === 'done') world.houseCreatedFor(hand, h.typeId);
  }
}

// ---------------------------------------------------------------------------------------------
// PlaceFirstStorehouse (ai/KM_AI.pas 595–698 + KM_Hand.pas 2183–2223)

/**
 * The AI's first storehouse: the mine/stone lists pick a seed point, then the store spot is
 * scored (stone/gold/iron distances, coal tiles, road access below) and the store is placed with
 * the three road tiles below it (AddFirstStorehouse). `centerScreen` = the hand's CENTER_SCREEN
 * (or its StartPosition when absent). Returns the placed house uid (0 = failed).
 */
export function placeFirstStorehouse(world: EconomyWorld, eye: Eye, hand: number, centerScreen: Pt): number {
  const getClosestResource = (list: Pt[]): Pt | null => {
    const SQR_MAX_DISTANCE = 20 * 20;
    let best: Pt | null = null;
    let bestDist = 1e10;
    for (const p of list) {
      const d = distanceSqr(centerScreen, p);
      if (d < bestDist) {
        bestDist = d;
        best = p;
      }
    }
    return bestDist < SQR_MAX_DISTANCE ? best : null;
  };
  const gold = getClosestResource(eye.goldLocs);
  const iron = getClosestResource(eye.ironLocs);
  const stone = getClosestResource(eye.stoneMiningTiles);
  let initPoint: Pt | null = null;
  if (stone !== null) {
    if (gold !== null) initPoint = kmPoint(round((stone.x * 4 + gold.x * 2 + centerScreen.x) / 7), round((stone.y * 4 + gold.y * 2 + centerScreen.y) / 7));
    else if (iron !== null) initPoint = kmPoint(round((stone.x * 4 + iron.x + centerScreen.x) / 6), round((stone.y * 4 + iron.y + centerScreen.y) / 6));
    else initPoint = stone;
  } else if (gold !== null) initPoint = gold;
  else if (iron !== null) initPoint = iron;
  if (initPoint === null) return 0;

  // FindPlaceForStore (634–665).
  const RAD = 15;
  let bestPrice = 1e10;
  let bestLoc: Pt | null = null;
  for (let x = Math.max(1, initPoint.x - RAD); x <= Math.min(world.mapX - 1, initPoint.x + RAD); x++) {
    for (let y = Math.max(1, initPoint.y - RAD); y <= Math.min(world.mapY - 1, initPoint.y + RAD); y++) {
      if (!world.canAddFieldPlan(hand, x, y + 1, 'road')) continue;
      if (!eye.canAddHousePlanAI(hand, x, y, HT_STORE, false)) continue;
      const loc = kmPoint(x, y);
      const price =
        6 * (stone !== null ? 1 : 0) * distanceSqr(loc, stone ?? kmPoint(0, 0)) +
        50 * ((world.tileIsCoal(x, y) > 1 ? 1 : 0) + (world.tileIsCoal(x, y - 1) > 1 ? 1 : 0) + (world.tileIsCoal(x, y - 2) > 1 ? 1 : 0)) +
        2 * (gold !== null ? 1 : 0) * distanceSqr(loc, gold ?? kmPoint(0, 0)) +
        1 * (iron !== null ? 1 : 0) * distanceSqr(loc, iron ?? kmPoint(0, 0)) -
        20 *
          ((world.canAddFieldPlan(hand, x, y + 2, 'road') ? 1 : 0) +
            (world.canAddFieldPlan(hand, x + 1, y + 1, 'road') ? 1 : 0) +
            (world.canAddFieldPlan(hand, x - 1, y + 1, 'road') ? 1 : 0));
      if (price < bestPrice) {
        bestPrice = price;
        bestLoc = loc;
      }
    }
  }
  if (bestLoc === null) return 0;

  // AddFirstStorehouse (KM_Hand.pas 2183–2223): the house + the three road tiles below.
  const house = world.spawnHouse(HT_STORE, bestLoc.x, bestLoc.y, hand);
  const entrance = { x: house.entrance.x, y: house.entrance.y };
  const addRoad = (x: number, y: number): void => {
    if (world.canAddFieldPlan(hand, x, y, 'road')) world.addRoadTile(x, y);
  };
  addRoad(entrance.x, entrance.y + 1);
  addRoad(entrance.x - 1, entrance.y + 1);
  addRoad(entrance.x + 1, entrance.y + 1);
  // A house placed directly (hbsDone) runs Activate → HouseCreated in the game (KM_Houses.pas 564).
  world.houseCreatedFor(hand, HT_STORE);
  return house.uid;
}

// ---------------------------------------------------------------------------------------------
// AiPlayer (ai/KM_AI.pas 529–585; the economy half)

/** The army-management slot (TKMHandAI.fArmyManagement): aiarmy.ts's ArmyManagement implements it. */
export interface ArmySlot {
  afterMissionInit(): void;
  updateState(tick: number): void;
}

/**
 * The per-hand advanced AI (economy half). `updateState(tick)` mirrors TKMHandAI.UpdateState:
 * the shared Eye is context-switched to this hand, then ArmyManagement (worker N's slot) and
 * CityManagement run. Only hands with `setup.newAI` do anything (hndComputer + NewAI).
 */
export class AiPlayer {
  readonly hand: number;
  readonly setup: AiSetup;
  readonly eye: Eye;
  readonly influences: Influences;
  readonly predictor: CityPredictor;
  readonly planner: CityPlanner;
  readonly builder: CityBuilder;
  readonly cityManagement: CityManagement;
  /** The military half (M5c, aiarmy.ts) — TKMHandAI.fArmyManagement; null = economy only. */
  army: ArmySlot | null = null;
  started = false;

  constructor(world: EconomyWorld, influences: Influences, eye: Eye, setup: AiSetup) {
    this.hand = setup.hand;
    this.setup = setup;
    this.eye = eye;
    this.influences = influences;
    this.predictor = new CityPredictor(world, setup.hand, setup);
    this.planner = new CityPlanner(world, setup.hand, eye, influences, this.predictor);
    this.builder = new CityBuilder(world, setup.hand, eye, influences, this.planner, this.predictor);
    this.cityManagement = new CityManagement(world, setup.hand, setup, this.builder, this.predictor);
    this.predictor.link(this.planner, this.builder, this.cityManagement);
    this.planner.link(this.builder);
    eye.buildFF.setInitLocsProvider(() => this.plannedHouseLocs());
  }

  /** The BuildFF init points: the planned house entrances of the planner (KM_Eye.pas 1791–1797). */
  private plannedHouseLocs(): Pt[] {
    const out: Pt[] = [];
    for (let ht = 0; ht < 30; ht++) {
      const arr = this.planner.plannedHouses[ht];
      for (let k = 0; k < arr.count; k++) out.push(arr.plans[k].loc);
    }
    return out;
  }

  /** Attach the military half (TKMHandAI.fArmyManagement, created with the hand's AI). */
  attachArmy(army: ArmySlot): void {
    this.army = army;
  }

  /** AfterMissionInit (KM_AI.pas 529–545) for the economy half and the army. */
  afterMissionInit(): void {
    if (!this.setup.newAI) return;
    this.eye.ownerUpdate(this.hand);
    this.cityManagement.afterMissionInit(this.eye, this.planner);
    this.army?.afterMissionInit();
    this.started = true;
  }

  /** UpdateState (548–585): Eye context switch → army → city management. */
  updateState(tick: number): void {
    if (!this.setup.newAI) return;
    this.eye.ownerUpdate(this.hand);
    this.eye.buildFF.setTick(tick);
    this.influences.updateState(tick);
    this.army?.updateState(tick);
    this.cityManagement.updateState(tick);
  }
}






