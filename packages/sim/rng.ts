// rng.ts — exact port of the KaM Remake RNG: Park–Miller with M = 2^31 − 1, A = 16807.
//
// step(x): c2 = floor(x / 127773), c1 = x mod 127773, n = 16807*c1 − 2836*c2, n > 0 ? n : n + M
// (Schrage; exact in JS doubles). KaMRandom(MaxInt) returns the raw post-step state, so a stored
// `rand` in a .rpl IS that state (docs/M2-SPIKE.md 2.2). Backwards: invStep = ·A^-1 mod M.
// seedFromCheck(value, drawsBefore) inverts (drawsBefore + 1) steps (spec 3.1).
//
// dlogK solves step^k(from) = to via Pohlig–Hellman over the multiplicative group mod M;
// the group order M − 1 factors as 2 · 3^2 · 7 · 11 · 31 · 151 · 331 (BSGS per prime power, CRT).
// 16807 is a primitive root mod M, so every pair of nonzero states has a solution.
//
// No fs, no deps (spec section 3.1).
export const RNG_M = 2147483647; // 2^31 - 1
export const RNG_A = 16807;

const M_BIG = BigInt(RNG_M);
const ORDER = M_BIG - 1n; // order of the multiplicative group mod M
const FACTORS: ReadonlyArray<readonly [number, number]> = [
  [2, 1],
  [3, 2],
  [7, 1],
  [11, 1],
  [31, 1],
  [151, 1],
  [331, 1],
];

/** x mod M, always in [0, M). */
function modM(x: bigint): bigint {
  const r = x % M_BIG;
  return r < 0n ? r + M_BIG : r;
}

/** base^exp mod M in BigInt (exp >= 0). */
function powMod(base: bigint, exp: bigint): bigint {
  let b = modM(base);
  let e = exp;
  let r = 1n;
  while (e > 0n) {
    if (e & 1n) r = (r * b) % M_BIG;
    b = (b * b) % M_BIG;
    e >>= 1n;
  }
  return r;
}

/** Modular inverse of a mod m via extended Euclid (throws when gcd(a, m) != 1). */
function invModBig(a: bigint, m: bigint): bigint {
  let oldR = ((a % m) + m) % m;
  let r = m;
  let oldS = 1n;
  let s = 0n;
  while (r !== 0n) {
    const q = oldR / r;
    const t = oldR - q * r;
    oldR = r;
    r = t;
    const u = oldS - q * s;
    oldS = s;
    s = u;
  }
  if (oldR !== 1n) throw new Error(`modInv: ${a} has no inverse mod ${m}`);
  return ((oldS % m) + m) % m;
}

const INV_A = invModBig(BigInt(RNG_A), M_BIG); // A^-1 mod M

/** One forward Park–Miller step: the value KaMRandom(MaxInt) stores. */
export function step(state: number): number {
  const c2 = Math.floor(state / 127773);
  const c1 = state % 127773;
  const n = 16807 * c1 - 2836 * c2;
  return n > 0 ? n : n + RNG_M;
}

/** Modular inverse of a mod M (extended Euclid on BigInt). */
export function modInv(a: number): number {
  return Number(invModBig(BigInt(a), M_BIG));
}

/** One backwards Park–Miller step: A^-1 · state mod M. */
export function invStep(state: number): number {
  return Number(modM(INV_A * BigInt(state)));
}

/** step^k(state) = state · A^k mod M (BigInt modpow internally). */
export function powStep(state: number, k: number): number {
  if (!Number.isInteger(k) || k < 0) throw new Error(`powStep: k must be a non-negative integer, got ${k}`);
  return Number(modM(BigInt(state) * powMod(BigInt(RNG_A), BigInt(k))));
}

interface DlogTable {
  q: number; // prime power of M - 1
  m: number; // ceil(sqrt(q))
  baby: Map<number, number>; // gamma^j -> j
  giant: bigint; // gamma^-m
}

let dlogTables: DlogTable[] | null = null;

/** Per-prime-power BSGS tables; constants of (M, A) only, so built once and cached. */
function buildDlogTables(): DlogTable[] {
  const tables: DlogTable[] = [];
  for (const [p, e] of FACTORS) {
    const q = p ** e;
    const gamma = powMod(BigInt(RNG_A), ORDER / BigInt(q)); // element of order q
    const m = Math.ceil(Math.sqrt(q));
    const baby = new Map<number, number>();
    let value = 1n;
    for (let j = 0; j < m; j++) {
      const key = Number(value);
      if (!baby.has(key)) baby.set(key, j);
      value = (value * gamma) % M_BIG;
    }
    tables.push({ q, m, baby, giant: invModBig(powMod(gamma, BigInt(m)), M_BIG) });
  }
  return tables;
}

/**
 * Smallest k >= 0 with step^k(from) = to, or null when there is none.
 * Correct for any nonzero from, to in 1..M-1 (A is a primitive root mod M).
 */
export function dlogK(from: number, to: number): number | null {
  if (from <= 0 || to <= 0) return null;
  const h = modM(BigInt(to) * invModBig(BigInt(from) % M_BIG, M_BIG)); // A^k = to / from
  if (h === 0n) return null;
  if (h === 1n) return 0;
  const tables = dlogTables ?? (dlogTables = buildDlogTables());
  let x = 0n;
  let n = 1n;
  for (const { q, m, baby, giant } of tables) {
    const target = powMod(h, ORDER / BigInt(q));
    let gamma = target;
    let residue = -1;
    for (let i = 0; i <= m; i++) {
      const j = baby.get(Number(gamma));
      if (j !== undefined) {
        residue = i * m + j;
        break;
      }
      gamma = (gamma * giant) % M_BIG;
    }
    if (residue < 0 || residue >= q) return null; // not in this subgroup
    const qb = BigInt(q);
    let delta = (BigInt(residue) - x) % qb;
    if (delta < 0n) delta += qb;
    const crt = (delta * invModBig(((n % qb) + qb) % qb, qb)) % qb;
    x += n * crt;
    n *= qb;
  }
  const k = Number(x % ORDER);
  return powStep(from, k) === to ? k : null; // never report a wrong distance
}

/** State before the draws of a check: invStep^(drawsBefore + 1)(value) (spec 2.2). */
export function seedFromCheck(value: number, drawsBefore: number): number {
  if (!Number.isInteger(drawsBefore) || drawsBefore < 0) {
    throw new Error(`seedFromCheck: drawsBefore must be a non-negative integer, got ${drawsBefore}`);
  }
  return Number(modM(BigInt(value) * powMod(INV_A, BigInt(drawsBefore + 1))));
}
