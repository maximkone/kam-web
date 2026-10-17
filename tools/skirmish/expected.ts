// expected.ts — the frozen skirmish numbers (docs/M5D-SPIKE.md §4 A). Frozen by the M5d-A worker from its
// own `node tools/skirmish/cli.ts --check` run (two runs identical, replay identical). The sha depends on
// the Advanced AI (ai.ts, aiarmy.ts, aisupervisor.ts): an AI change moves it, and the record says so.
export const TICKS = 3000;

/** The bench length (1 human + 3 AI on MapsMP/Sharks Islands). */
export const BENCH_TICKS = 3000;

export const EXPECTED: { load: unknown; events: unknown; final: unknown; sha256: string } = {
  load: { map: 'MapsMP/Battle Sun', slots: ['0:human', '1:ai'] },
  events: {
    'build-area-assigned': 5,
    'build-field-assigned': 1,
    'build-house-assigned': 35,
    'build-road-assigned': 31,
    'build-supply': 21,
    'delivery-assigned': 65,
    'field-built': 1,
    'fight-retarget': 10,
    'group-died': 1,
    'house-activated': 3,
    'house-plan-digged': 5,
    'house-terrain-built': 3,
    'house-wip': 5,
    'hp-decrease': 32,
    'kill-source': 10,
    'road-built': 29,
    'road-digged': 31,
    'school-unit-created': 9,
    'school-unit-trained': 8,
    'unit-killed': 10,
    'ware-delivered': 58,
    'worker-assigned': 1,
  },
  final: {
    tick: 3000,
    accepted: 8,
    rejectedCount: 0,
    houses: 8,
    housesDone: 6,
    units: 34,
    groups: 1,
    kills: 6,
    killed: 4,
    statuses: '0:human:playing 1:ai:playing',
    matchOver: false,
    houseDamage: 0,
  },
  sha256: '3bdddedb6f992eb10b2c2e1bc28f7dc62c1749ad1b0b6ab79d2774c418b81375',
};
