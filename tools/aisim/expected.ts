// expected.ts — the frozen aisim numbers (docs/M5-SPIKE.md §6 wave 2; 7.4 the economy half, 7.5 the
// military half). Worker M froze the economy run from the first deterministic run of
// `node tools/aisim/cli.ts --check`; worker N (M5c) re-froze it once, because the Supervisor's mine
// division is now part of the economy run (docs/M5-SPIKE.md 7.5, "Economy numbers moved"): the old
// economy sha f62714ce… is reproduced by the same run with the division switched off. Worker Q3 re-froze
// all three phases (docs/M5-SPIKE.md 7.7): the store's always-on demand (KM_Houses.pas 657–660), the
// importance-first bids (KM_HandLogistics.pas 551–577) and the House>Store bid penalty (1583–1590) move the
// economy, attack and organic numbers; the causes are in 7.7. Worker Q4 re-froze all three again (7.8): the
// global best bid (KM_HandLogistics.pas 551–577, 2356–2367) and the store-offer penalty (1587–1590) move them.
// Two consecutive runs of the check print
// identical numbers and sha256s (both phases).
export const TICKS = 30000;

/** The attack run's length (docs/M5-SPIKE.md 7.5): the economy plus the army against the enemies' stores. */
export const ATTACK_TICKS = 12000;

/** The organic run's length (docs/M5-SPIKE.md 7.6): the economy scenario with no military grants. */
export const ORGANIC_TICKS = 60000;

/**
 * The frozen organic chain (docs/M5-SPIKE.md 7.7, M5e): the economy scenario with no military grants, 60000
 * ticks. Stone and the sawmill are reached; the barracks is never wanted: the stone crisis (stone at 1 after
 * tick ~12000) blocks every non-quarry placement, so the weapon workshop is never placed, so warfare stays 0
 * (KM_CityPredictor.pas 468: warfare > 0 needed). Frozen as measured; the chain table is in 7.7.
 */
export const EXPECTED_ORGANIC = {
  links: [
    { link: 'quarry produces stone (stone-* events)', reached: true, tick: 2923, value: 49 },
    { link: 'sawmill placed (house-wip type=0)', reached: true, tick: 5573, value: 1 },
    { link: 'barracks wanted (predictor requires it)', reached: false, tick: null, value: 0 },
    { link: 'barracks placed (house-wip type=21)', reached: false, tick: null, value: 0 },
    { link: 'barracks built (house-activated type=21)', reached: false, tick: null, value: 0 },
    { link: 'recruits trained (school-unit-trained type=13)', reached: false, tick: null, value: 0 },
    { link: 'weapons/armour produced (ware-produced events)', reached: false, tick: null, value: 0 },
    { link: 'weapons/armour in stock at the end (warfare wares)', reached: false, tick: null, value: 0 },
    { link: 'soldiers equipped (barracks-equipped)', reached: false, tick: null, value: 0 },
    { link: 'army groups formed (military groups with members)', reached: false, tick: null, value: 0 },
  ] as { link: string; reached: boolean; tick: number | null; value: number }[],
  sha256: 'f36f6bb4e17a7e28416ee5d1471823e2bddfbe82c11bd05bd611a897c62e3adf',
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
    warriors: 59,
    requests: 2,
    combatGroupsMax: 6,
    groupsAddedToAttack: 6,
    combatGroupsEnd: 6,
    killsByHand: 9,
    killsByEnemy: 7,
    lossesByEnemy: 7,
    houseDamage: 550,
    houseDestroyedEvents: 1,
    enemyHousesStart: 3,
    enemyHousesEnd: 2,
    enemyWarriorsStart: 18,
    enemyWarriorsEnd: 12,
    rngState: 1045738567,
  } as Record<string, unknown>,
  sha256: '72bf668e788778d07c65a1814e8213806175df3049886242cf1704f398eae172',
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
    'build-house-assigned': 79,
    'build-road-assigned': 168,
    'build-supply': 38,
    'chop-plan': 12,
    'delivery-assigned': 313,
    'house-activated': 6,
    'house-plan-digged': 8,
    'house-terrain-built': 6,
    'house-wip': 8,
    'road-built': 154,
    'road-digged': 168,
    'school-unit-created': 47,
    'school-unit-trained': 47,
    'stone-out': 24,
    'stone-plan': 25,
    'timber-out': 12,
    'tree-fell': 12,
    'trunk-out': 12,
    'trunk-taken': 12,
    'ware-delivered': 313,
    'worker-assigned': 6,
  } as Record<string, number>,
  final: {
    plannedByType: { house0: 1, house3: 1, house9: 2, house11: 1, house13: 1, house14: 5, house15: 1 },
    plannedPlaced: 10,
    plannedReserved: 2,
    builtByType: { house11: 1, house13: 1, house14: 4, house9: 2, house0: 1 },
    completedHouses: 7,
    wipHouses: 2,
    roadTiles: 234,
    cornFields: 0,
    fieldBuiltEvents: 0,
    roadBuiltEvents: 154,
    housePlansDigged: 8,
    housesActivated: 6,
    unitsByType: { unit0: 26, unit9: 22, unit10: 3, unit1: 3, unit5: 3 },
    trainedUnits: 47,
    schoolQueued: 0,
    workers: 22,
    serfs: 26,
    builders: 22,
    wares: { timber: 52, goldOre: 30, coal: 30, gold: 23, wine: 30, bread: 40, sausage: 20, fish: 10 },
    workerCount: 21,
    requiredSchool: 2,
    cityCompleted: false,
    rngState: 1831796386,
  },
  sha256: 'fae374de6d24d7771325c38155cf5f3d4593934ea8f6632d11fcb225873960e7',
};
