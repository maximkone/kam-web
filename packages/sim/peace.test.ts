// peace.test.ts - the skirmish `peaceMinutes` option (the Remake's lobby Peacetime): validation, default 0 = unchanged,
// applied to every AI predictor, and the end-to-end effect on the first attack (tools/aistart/cli.ts, Battle Sun).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createSkirmish, step } from './skirmish.ts';
import type { SkirmishDefines, SkirmishSlot } from './skirmish.ts';

const INSTALL = process.env.KAM_INSTALL ?? 'C:/Users/me/Desktop/KaM Remake/KaM Remake Beta r15472';
const MAP = `${INSTALL}/MapsMP/Battle Sun/Battle Sun`;

function defines(): SkirmishDefines {
  const f = (n: string): Buffer => readFileSync(`${INSTALL}/data/defines/${n}`);
  return {
    tilesJson: f('tiles.json').toString('utf8'),
    mapElem: new Uint8Array(f('mapelem.dat')),
    unitDat: new Uint8Array(f('unit.dat')),
    housesDat: new Uint8Array(f('houses.dat')),
  };
}

function make(peace?: number, seed = 1) {
  const slots: SkirmishSlot[] = [{ hand: 0, kind: 'human' }, { hand: 1, kind: 'ai', aiStart: 'normal' }];
  return createSkirmish({
    mapBytes: new Uint8Array(readFileSync(`${MAP}.map`)),
    mapPath: `${MAP}.map`,
    missionDat: new Uint8Array(readFileSync(`${MAP}.dat`)),
    defines: defines(),
    seed,
    slots,
    ...(peace === undefined ? {} : { peaceMinutes: peace }),
  });
}

function firstRequest(peace: number): number {
  const r = spawnSync(process.execPath, ['--no-warnings', 'tools/aistart/cli.ts', '--level', 'normal', '--ticks', '12000', '--peace', String(peace)], { encoding: 'utf8', cwd: new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1') });
  assert.equal(r.status, 0, r.stderr);
  const m = /firstRequest=(\d+|null)/.exec(r.stdout);
  assert.ok(m, 'no firstRequest in output: ' + r.stdout.slice(0, 300));
  return m[1] === 'null' ? Infinity : Number(m[1]);
}

test('peaceMinutes below 0, NaN and above 240 are rejected', () => {
  for (const bad of [-1, Number.NaN, 241]) assert.throws(() => make(bad), /peaceMinutes must be 0\.\.240/, String(bad));
});

test('peaceMinutes 0 and 240 are accepted', () => {
  for (const ok of [0, 240]) assert.doesNotThrow(() => make(ok));
});

test('every AI predictor gets peaceMinutes (default 0)', () => {
  const sk = make(10);
  assert.equal(sk.ais[1]?.predictor.peacetimeMinutes, 10);
  const def = make();
  assert.equal(def.ais[1]?.predictor.peacetimeMinutes, 0);
});

test('omitted and 0 behave identically over 600 ticks', () => {
  const a = make();
  const b = make(0);
  for (let t = 0; t < 600; t++) {
    step(a, []);
    step(b, []);
  }
  const ev = (s: typeof a): string => JSON.stringify(s.world.units.map((u) => [u.uid, u.posF.x, u.posF.y]));
  assert.equal(ev(a), ev(b));
});

test('isPeaceTime follows peaceMinutes (10 ticks = 1 s)', () => {
  const p = make(10).ais[1]!.predictor;
  assert.equal(p.isPeaceTime(5999), true);
  assert.equal(p.isPeaceTime(6000), false);
});

test('peace 0: the AI first requests an attack at tick 2711', { timeout: 120000 }, () => {
  assert.equal(firstRequest(0), 2711);
});

test('peace 10: no attack request before tick 6000 (measured 8111)', { timeout: 120000 }, () => {
  const t = firstRequest(10);
  assert.ok(t >= 6000, `first request ${t}`);
});
