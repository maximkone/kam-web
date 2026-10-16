// rng.test.ts — frozen vectors from docs/M2-SPIKE.md 2.2 / 2.4 (worker A).
// Run: node --test packages/sim/rng.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dlogK, invStep, modInv, powStep, RNG_A, RNG_M, seedFromCheck, step } from './rng.ts';

// autosave01 early stream: seed -> check #2 -> ... -> check #18 (docs/M2-SPIKE.md 2.4).
const CHAIN = [
  1247813158, 2135059644, 1643178985, 269500475, 451471802, 524178204, 885154634, 1548408412,
  893346138, 934538962, 100940176, 1043294615, 448616550, 615217756, 1978548434, 519284878,
];
const DIST = [5, 1, 1, 1, 2, 1, 2, 1, 3, 1, 2, 1, 10, 1, 41];

test('constants and the two spec examples', () => {
  assert.equal(RNG_M, 2147483647);
  assert.equal(RNG_A, 16807);
  assert.equal(step(1), 16807);
  assert.equal(step(16807), 282475249);
});

test('frozen step chain between consecutive checks (docs/M2-SPIKE.md 2.4)', () => {
  for (let i = 0; i < DIST.length; i++) {
    let value = CHAIN[i];
    for (let j = 0; j < DIST[i]; j++) value = step(value); // plain Schrage loop
    assert.equal(value, CHAIN[i + 1], `step^${DIST[i]}(${CHAIN[i]})`);
    assert.equal(powStep(CHAIN[i], DIST[i]), CHAIN[i + 1], `powStep(${CHAIN[i]}, ${DIST[i]})`);
  }
});

test('seedFromCheck inverts the spec formula: seedFromCheck(2135059644, 4) === 1247813158', () => {
  assert.equal(seedFromCheck(2135059644, 4), 1247813158);
  // the same identity holds for every frozen chain hop: each check is the target state, and
  // seedFromCheck inverts (drawsBefore + 1) steps, so drawsBefore = total distance - 1
  for (let i = 0; i + 1 < CHAIN.length; i++) {
    const reached = DIST.slice(0, i + 1).reduce((sum, d) => sum + d, 0);
    assert.equal(seedFromCheck(CHAIN[i + 1], reached - 1), CHAIN[0]);
  }
});

test('invStep(step(x)) === x and step(invStep(x)) === x on 1000 deterministic states', () => {
  const states: number[] = [1, 2, 3, 16807, 12345, RNG_M - 1, RNG_M - 2];
  let value = 1;
  while (states.length < 1000) {
    value = step(value);
    states.push(value);
  }
  for (const x of states) {
    assert.equal(invStep(step(x)), x);
    assert.equal(step(invStep(x)), x);
  }
});

test('modInv: A^-1 · A ≡ 1 mod M', () => {
  const inv = modInv(RNG_A);
  assert.equal((BigInt(inv) * BigInt(RNG_A)) % BigInt(RNG_M), 1n);
  assert.equal(modInv(inv), RNG_A);
  assert.throws(() => modInv(0), /no inverse/);
});

test('powStep agrees with repeated step for small k', () => {
  for (const base of [1, 2, 448616550, 1247813158]) {
    let value = base;
    for (let k = 0; k <= 8; k++) {
      assert.equal(powStep(base, k), value);
      value = step(value);
    }
  }
  assert.equal(powStep(12345, 0), 12345);
  assert.throws(() => powStep(1, -1), /non-negative/);
});

test('dlogK(a, step^k(a)) === k for a spread of k and bases', () => {
  const ks = [1, 2, 5, 41, 6290, 100000];
  const bases = [1, 12345, 448616550, 1247813158, RNG_M - 1];
  for (const base of bases) {
    assert.equal(dlogK(base, base), 0);
    for (const k of ks) {
      assert.equal(dlogK(base, powStep(base, k)), k, `base ${base}, k ${k}`);
    }
  }
});

test('dlogK distances of the frozen early stream (1, 2, 3, 10, 41)', () => {
  assert.equal(dlogK(2135059644, 1643178985), 1);
  assert.equal(dlogK(451471802, 524178204), 2);
  assert.equal(dlogK(893346138, 934538962), 3);
  assert.equal(dlogK(448616550, 615217756), 10); // #15 -> #16: 8 sim draws at tick 10
  assert.equal(dlogK(1978548434, 519284878), 41); // #17 -> #18: 39 sim draws at tick 11
});

test('dlogK has no solution for zero states', () => {
  assert.equal(dlogK(0, 5), null);
  assert.equal(dlogK(5, 0), null);
  assert.equal(dlogK(0, 0), null);
});
