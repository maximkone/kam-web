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
    'build-house-assigned': 28,
    'build-road-assigned': 34,
    'build-supply': 21,
    'delivery-assigned': 67,
    'field-built': 1,
    'fight-retarget': 11,
    'group-died': 1,
    'house-activated': 3,
    'house-plan-digged': 5,
    'house-terrain-built': 3,
    'house-wip': 5,
    'hp-decrease': 38,
    'kill-source': 11,
    'road-built': 31,
    'road-digged': 31,
    'school-unit-created': 9,
    'school-unit-trained': 8,
    'unit-killed': 11,
    'ware-delivered': 59,
    'worker-assigned': 1,
  },
  final: {
    tick: 3000,
    accepted: 8,
    rejectedCount: 0,
    houses: 8,
    housesDone: 6,
    units: 33,
    groups: 1,
    kills: 6,
    killed: 5,
    statuses: '0:human:playing 1:ai:playing',
    matchOver: false,
    houseDamage: 0,
  },
  sha256: '54a2cdfc08561e692aeed4cf3cc6ef2e3c805b0fa39be095c169305691c2ed91',
};
