// expected.ts — the frozen aisim numbers (docs/M5-SPIKE.md §6 wave 2). Frozen by worker M from the
// first deterministic run of `node tools/aisim/cli.ts --check` (two consecutive runs printed
// identical numbers and sha256); the lead re-runs the same command.
export const TICKS = 30000;

/**
 * The frozen scenario: hand 1 of MapsMP/Battle Sun (all four hands !SET_ADVANCED_AI_PLAYER), the
 * map's own store at (37,115) with its !ADD_WARE start, the AI's economy half active for 30000
 * ticks: the school built and 39 citizens trained (builders/serfs/stonemasons/woodcutters), the
 * city's roads + 5 quarries + 1 woodcutter up (5 trees felled, 5 trunks), the sawmill/coal
 * mine/farm/metallurgists planned. v0 produces only hut/sawmill wares (docs/M3-SPIKE.md), so the
 * city stops growing once the mission kit runs out (docs/M5-AI-NOTES.md §7).
 */
export const EXPECTED = {
  load: {
    map: 'Battle Sun.map',
    mapSize: '128x128',
    hand: 1,
    advanced: '0,1,2,3',
    hands: 4,
    houses: 4,
    streets: 80,
    units: 40,
    store: '37,115',
    kit: 'mission !ADD_WARE',
  },
  events: {
    'build-area-assigned': 7,
    'build-house-assigned': 53,
    'build-road-assigned': 100,
    'build-supply': 26,
    'chop-plan': 5,
    'delivery-assigned': 149,
    'house-activated': 4,
    'house-plan-digged': 7,
    'house-terrain-built': 4,
    'house-wip': 7,
    'road-built': 86,
    'road-digged': 100,
    'school-unit-created': 39,
    'school-unit-trained': 39,
    'tree-fell': 5,
    'trunk-out': 5,
    'ware-delivered': 149,
    'worker-assigned': 4,
  } as Record<string, number>,
  final: {
    plannedByType: { house0: 1, house3: 1, house8: 1, house9: 1, house11: 1, house13: 1, house14: 5 },
    plannedPlaced: 8,
    plannedReserved: 3,
    builtByType: { house11: 1, house13: 1, house14: 5, house9: 1 },
    completedHouses: 5,
    wipHouses: 3,
    roadTiles: 166,
    cornFields: 0,
    fieldBuiltEvents: 0,
    roadBuiltEvents: 86,
    housePlansDigged: 7,
    housesActivated: 4,
    unitsByType: { unit0: 22, unit9: 21, unit10: 3, unit1: 3 },
    trainedUnits: 39,
    schoolQueued: 0,
    workers: 21,
    serfs: 22,
    builders: 21,
    wares: { trunk: 5, timber: 35, goldOre: 30, coal: 30, gold: 31, wine: 30, bread: 40, sausage: 20, fish: 10 },
    workerCount: 21,
    requiredSchool: 2,
    cityCompleted: false,
    rngState: 1199244808,
  },
  sha256: 'f62714ce8f5aada2634107349e8fac4b8bc9d3f9ae646f9ebc53e85bcdbbf91a',
};


