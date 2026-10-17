// expected.ts — the frozen buildsim numbers (docs/M5-SPIKE.md §6.1). Frozen by worker K from the
// first deterministic run of `node tools/buildsim/cli.ts --check` (two consecutive runs printed
// identical numbers and sha256); the lead re-runs the same command.
export const TICKS = 2000;

/**
 * The scripted build on the Town Tutorial (hand 1): a woodcutter's hut plan at the entrance
 * (19,112) — Loc (19,112), entranceDx 0 — whose PointBelowEntrance (19,113) is on the village
 * street (so the store's serfs can reach the site); a road plan at (16,112) beside the existing
 * street; a corn field plan at (12,112) on open soil.
 */
export const SCENARIO = {
  hand: 1,
  houseType: 9, // htWoodcutters (script id 9)
  entrance: { x: 19, y: 112 },
  loc: { x: 19, y: 112 },
  road: { x: 16, y: 112 },
  corn: { x: 12, y: 112 },
};

export const EXPECTED = {
  load: {
    map: 'Town Tutorial.map',
    mapSize: '128x128',
    hands: 3,
    houses: 21,
    streets: 249,
    roadTiles: 249,
    units: 49,
    builders: 3,
    storeTimber: 20,
    storeStone: 9000,
  },
  events: {
    'build-area-assigned': 1,
    'build-field-assigned': 1,
    'build-house-assigned': 8,
    'build-road-assigned': 1,
    'build-supply': 5,
    'chop-plan': 1,
    'delivery-assigned': 126,
    'field-built': 1,
    'house-activated': 1,
    'house-plan-digged': 1,
    'house-terrain-built': 1,
    'house-wip': 1,
    'road-built': 2,
    'road-digged': 1,
    'timber-out': 3,
    'tree-fell': 1,
    'trunk-out': 1,
    'trunk-taken': 4,
    'ware-delivered': 126,
    'worker-assigned': 9,
  } as Record<string, number>,
  final: {
    hutState: 'done',
    hutProgress: 250, // (WoodCost 3 + StoneCost 2) × 50
    hutWood: 0,
    hutStone: 0,
    hutReserve: 0,
    hutReady: false,
    hutWoodDelivered: 3,
    hutStoneDelivered: 2,
    hutHealth: 250,
    houseWip: 1,
    housePlanDigged: 1,
    houseActivated: 1,
    buildSupply: 5, // 3 timber + 2 stone deliveries into the build supply
    buildHouseAssigned: 8, // 3 builders over several assignment rounds (dtOnce deliveries)
    roadDigged: 1,
    roadBuilt: 2, // the road plan tile + the house entrance cell (KM_UnitTaskBuild.pas 742–743)
    fieldBuilt: 1,
    doorRoad: true,
    roadAtSite: true,
    cornField: true,
    siteCount: 0,
    planCount: 0,
    fieldPlanCount: 0,
    unitDelivered: 1, // the serf's stone hand-over to the road builder (dkToUnit)
    sawmillUnlocked: true, // the hut released htSawmill (KM_HandLocks.pas 69–83)
    storeUnlocked: true,
    barracksUnlocked: false, // the barracks need a sawmill
    rngState: 514943164,
  },
  sha256: '6d9d96eda5a61fbb8d61e863459922d90d28313cd9f63f0c9fda2d2d78c3d87c',
};
