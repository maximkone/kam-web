// expected.ts — the frozen combatsim numbers (docs/M4-SPIKE.md §6). Filled from a run of
// `node tools/combatsim/cli.ts --check` on the frozen r15472 install; two runs give the same
// sha256. Regenerate by running the CLI and copying its LOAD/EVENTS/FINAL/SHA256 lines.
export const TICKS = 900;

export const EXPECTED = {
  load: {
    map: 'Arena.map',
    mapSize: '32x32',
    hands: 7,
    houses: 1,
    streets: 2,
    units: 20,
    warriors: 13,
    houseSpawned: 'hut#18@(16,28)',
  },
  events: {
    'arrow-fired': 26,
    'fight-retarget': 3,
    'fow-drop': 1,
    'group-died': 2,
    'house-destroyed': 1,
    'hp-decrease': 24,
    'kill-source': 6,
    'unit-killed': 6,
  },
  final: {
    meleeKills: 4,
    rangedKills: 2,
    arrowsFired: 26,
    arrowsHit: 13,
    fowDrops: 1,
    houseDamage: 250,
    houseDestroyed: 1,
    rubbleTiles: 2,
    houseHealthLeft: 0,
    unitsAlive: 14,
    groupsAlive: 4,
    rngState: 590275977,
  },
  sha256: '09a19821bab67969bad8d1e0e45d3aa3c026c7ee08119cb43927ee0f5c6a30a8',
} as {
  load: unknown;
  events: unknown;
  final: unknown;
  sha256: string;
};
