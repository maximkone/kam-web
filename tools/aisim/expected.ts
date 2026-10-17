// expected.ts — the frozen aisim numbers (docs/M5-SPIKE.md §6 wave 2; 7.4 the economy half, 7.5 the
// military half). Worker M froze the economy run from the first deterministic run of
// `node tools/aisim/cli.ts --check`; worker N (M5c) re-froze it once, because the Supervisor's mine
// division is now part of the economy run (docs/M5-SPIKE.md 7.5, "Economy numbers moved"): the old
// economy sha f62714ce… is reproduced by the same run with the division switched off. Two consecutive
// runs of the check print identical numbers and sha256s (both phases).
export const TICKS = 30000;

/** The attack run's length (docs/M5-SPIKE.md 7.5): the economy plus the army against the enemies' stores. */
export const ATTACK_TICKS = 12000;

/** The organic run's length (docs/M5-SPIKE.md 7.6): the economy scenario with no military grants. */
export const ORGANIC_TICKS = 60000;

/**
 * The frozen organic chain (worker N2, docs/M5-SPIKE.md 7.6): the economy scenario with no military grants,
 * 60000 ticks. No link is reached: no stone is produced (quarries never work in the port), so the sawmill
 * reservation never places, so the barracks is never wanted (KM_CityPredictor.pas 468: warfare > 0 needed).
 */
export const EXPECTED_ORGANIC = {
  links: [
    { link: 'quarry produces stone (stone-* events)', reached: false, tick: null, value: 0 },
    { link: 'sawmill placed (house-wip type=0)', reached: false, tick: null, value: 0 },
    { link: 'barracks wanted (predictor requires it)', reached: false, tick: null, value: 0 },
    { link: 'barracks placed (house-wip type=21)', reached: false, tick: null, value: 0 },
    { link: 'barracks built (house-activated type=21)', reached: false, tick: null, value: 0 },
    { link: 'recruits trained (school-unit-trained type=13)', reached: false, tick: null, value: 0 },
    { link: 'weapons/armour produced (ware-produced events)', reached: false, tick: null, value: 0 },
    { link: 'weapons/armour in stock at the end (warfare wares)', reached: false, tick: null, value: 0 },
    { link: 'soldiers equipped (barracks-equipped)', reached: false, tick: null, value: 0 },
    { link: 'army groups formed (military groups with members)', reached: false, tick: null, value: 0 },
  ] as { link: string; reached: boolean; tick: number | null; value: number }[],
  sha256: 'c2fe7b1c5fdc15b49a6c23792fa6790053fce96abab9a40adfcd268d385b3eb8',
};

/**
 * The frozen attack-run numbers (worker N, M5c): the AI hand 1 of Battle Sun with a military kit, a
 * finished barracks, 12 recruits waiting in it and 6 militia groups; each other hand has a 6-militia
 * garrison beside its store (see tools/aisim/cli.ts). The Supervisor's attack request (FFA: four teams)
 * sends 5 groups at the nearest enemy team; the store of hand 0 falls, 9 enemy units die for 3 of ours.
 */
export const EXPECTED_ATTACK = {
  final: {
    ticks: 12000,
    hand: 1,
    equipped: 12,
    recruitsTrained: 0,
    warriors: 63,
    requests: 1,
    combatGroupsMax: 5,
    groupsAddedToAttack: 5,
    combatGroupsEnd: 5,
    killsByHand: 9,
    killsByEnemy: 3,
    lossesByEnemy: 3,
    houseDamage: 550,
    houseDestroyedEvents: 1,
    enemyHousesStart: 3,
    enemyHousesEnd: 2,
    enemyWarriorsStart: 18,
    enemyWarriorsEnd: 12,
    rngState: 785051773,
  } as Record<string, unknown>,
  sha256: 'd1825fa9985e904f3ac9c1281b5095a75f33b586518d7d18dcda4e6221cb7c59',
};

/**
 * The frozen scenario: hand 1 of MapsMP/Battle Sun (all four hands !SET_ADVANCED_AI_PLAYER), the
 * map's own store at (37,115) with its !ADD_WARE start, the AI's economy and military halves active
 * for 30000 ticks: the school built and 41 citizens trained (builders/serfs/stonemasons/woodcutters),
 * the city's roads + 5 quarries + 1 woodcutter + 1 inn up (5 trees felled, 5 trunks), the sawmill and the
 * metallurgists planned. v0 produces only hut/sawmill wares (docs/M3-SPIKE.md), so the city stops growing
 * once the mission kit runs out (docs/M5-AI-NOTES.md §7). The Supervisor's mine division sets the
 * predictor's mine caps (the gold-mine cap and the iron reserve), so the coal mine and the farm are no
 * longer planned in this run (M5c; the sha before the division: f62714ce…).
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
    'build-area-assigned': 8,
    'build-house-assigned': 112,
    'build-road-assigned': 69,
    'build-supply': 37,
    'chop-plan': 5,
    'delivery-assigned': 172,
    'house-activated': 5,
    'house-plan-digged': 8,
    'house-terrain-built': 5,
    'house-wip': 8,
    'road-built': 77,
    'road-digged': 69,
    'school-unit-created': 41,
    'school-unit-trained': 41,
    'tree-fell': 5,
    'trunk-out': 5,
    'ware-delivered': 172,
    'worker-assigned': 4,
  } as Record<string, number>,
  final: {
    plannedByType: { house0: 1, house9: 1, house11: 1, house13: 1, house14: 5, house27: 1 },
    plannedPlaced: 9,
    plannedReserved: 1,
    builtByType: { house11: 1, house13: 1, house14: 5, house9: 1, house27: 1 },
    completedHouses: 6,
    wipHouses: 3,
    roadTiles: 157,
    cornFields: 0,
    fieldBuiltEvents: 0,
    roadBuiltEvents: 77,
    housePlansDigged: 8,
    housesActivated: 5,
    unitsByType: { unit0: 23, unit9: 22, unit10: 3, unit1: 3 },
    trainedUnits: 41,
    schoolQueued: 0,
    workers: 22,
    serfs: 23,
    builders: 22,
    wares: { trunk: 5, stone: 5, timber: 29, goldOre: 30, coal: 30, gold: 29, wine: 30, bread: 40, sausage: 20, fish: 10 },
    workerCount: 21,
    requiredSchool: 2,
    cityCompleted: false,
    rngState: 2032645329,
  },
  sha256: '1a425dcd44f3672a9d5b5059f0f8ca8b4f2ee4c15130d81737b013a63eb2fe0e',
};
