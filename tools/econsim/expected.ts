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
    'chop-plan': 7,
    'delivery-assigned': 157,
    'timber-out': 14,
    'tree-fell': 7,
    'trunk-out': 7,
    'trunk-taken': 15,
    'ware-delivered': 157,
    'worker-assigned': 9,
  } as Record<string, number>,
  final: {
    trunksProduced: 7,
    trunksTaken: 15,
    timberProduced: 14,
    treesFelled: 7,
    deliveriesAssigned: 157,
    wareDelivered: 157,
    timberDelivered: 52,
    workersAssigned: 9,
    chopPlans: 7,
    storeTimber: 38,
    sawmillTimber: 0,
    hutTrunks: 0,
    rngState: 1679080829,
  },
  sha256: 'fd51da4a1fe0df3f7bf26aa6b708c73ce8606d5ec5fd5ba82ccfd37b4c10e397',
};
