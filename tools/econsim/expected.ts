// expected.ts — the frozen econsim numbers (docs/M3-SPIKE.md §6.1). Frozen by worker E from the
// first deterministic run of `node tools/econsim/cli.ts --check` (two consecutive runs printed
// identical numbers and sha256); the lead re-runs the same command.
export const TICKS = 6000;

export const EXPECTED = {
  load: {
    map: 'Town Tutorial.map',
    mapSize: '128x128',
    hands: 3,
    houses: 21,
    streets: 249,
    roadTiles: 249,
    units: 49,
    animals: 32,
    walkable: 11705,
    treesFull: 159, // the map's 147 full trees + the 12 demo-forest trees
    storeTrunks: 30,
    storeTimber: 20,
    scenario: true,
  },
  events: {
    'chop-plan': 5,
    'delivery-assigned': 143,
    'timber-out': 13,
    'tree-fell': 5,
    'trunk-out': 5,
    'trunk-taken': 13,
    'ware-delivered': 143,
    'worker-assigned': 9,
  } as Record<string, number>,
  final: {
    trunksProduced: 5,
    trunksTaken: 13,
    timberProduced: 13,
    treesFelled: 5,
    deliveriesAssigned: 143,
    wareDelivered: 143,
    timberDelivered: 45,
    workersAssigned: 9,
    chopPlans: 5,
    storeTimber: 30,
    sawmillTimber: 6,
    hutTrunks: 5,
    rngState: 619533300,
  },
  sha256: '6d780b62b56f83b3c9f4b1aa2d414ae6186c0a84491843d315554d49f7fcbc41',
};
