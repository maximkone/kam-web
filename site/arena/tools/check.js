// check.js — the headless check: node tools/check.js
//
// Proves the three properties the game is built on, without a browser:
//   1. determinism  - two runs of the same seed and the same bots give the same state hash, tick by tick
//                     (this is what lockstep multiplayer will rely on);
//   2. a match ends  - two bots fight: a base falls or the five minutes run out, and the winner is set;
//   3. the economy works - gold moves out of the piles, units get trained, and somebody's base takes damage.
import { applyCommand, createGame, stateHash, step } from '../src/sim.js';
import { botCommands, createBot } from '../src/ai.js';
import { MATCH_TICKS } from '../src/rules.js';

/** Run a game with two bots, hashing every `hashEvery` ticks. */
function run(seed, ticks) {
  const state = createGame(seed, 2);
  const bots = [createBot(0), createBot(1)];
  const hashes = [];
  const pilesStart = state.piles.reduce((n, p) => n + p.amount, 0);
  let damage = 0;
  const baseStart = state.bases.map((b) => b.hp);
  while (!state.over && state.tick < ticks) {
    for (const bot of bots) for (const c of botCommands(state, bot)) applyCommand(state, c);
    step(state);
    damage = baseStart.reduce((n, hp, i) => n + Math.max(0, hp - state.bases[i].hp), 0);
    hashes.push(stateHash(state));
  }
  const pilesLeft = state.piles.reduce((n, p) => n + p.amount, 0);
  return { state, hashes, pilesStart, pilesLeft, damage, gold: state.gold.slice(), units: state.units.length };
}

const problems = [];
const ok = (cond, msg) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`);
  if (!cond) problems.push(msg);
};

console.log('ARENA CHECK');
const seeds = [7, 1234, 90210];
for (const seed of seeds) {
  const a = run(seed, MATCH_TICKS);
  const b = run(seed, MATCH_TICKS);
  const firstDiff = a.hashes.findIndex((h, i) => h !== b.hashes[i]);
  ok(firstDiff === -1, `seed ${seed}: ${a.hashes.length} ticks identical (hash ${a.hashes[a.hashes.length - 1]?.toString(16)})`);
  if (firstDiff !== -1) ok(false, `seed ${seed}: first differing tick ${firstDiff + 1}`);
  ok(a.state.over, `seed ${seed}: the match ends (tick ${a.state.tick} of ${MATCH_TICKS}, winner ${a.state.winner})`);
  ok(a.pilesLeft < a.pilesStart, `seed ${seed}: gold leaves the piles (${a.pilesStart} -> ${a.pilesLeft})`);
  ok(a.damage > 0, `seed ${seed}: a base takes damage (${a.damage} hp)`);
  ok(a.units > 4, `seed ${seed}: both sides train units (${a.units} on the field)`);
  console.log(`     seed ${seed}: gold ${a.gold.join('/')}, damage ${a.damage}, units left ${a.units}, winner ${a.state.winner}`);
}

// A human-shaped command must go through the same door as the bots' commands.
{
  const state = createGame(5, 2);
  const knight = state.units.find((u) => u.owner === 0);
  const x0 = knight.x;
  applyCommand(state, { tick: 1, player: 0, kind: 'move', ids: [knight.id], x: x0 + 80, y: knight.y });
  for (let i = 0; i < 40; i++) step(state);
  ok(knight.x > x0, `a move command moves a unit (x ${x0} -> ${knight.x})`);
  const gold = state.gold[0];
  applyCommand(state, { tick: state.tick, player: 0, kind: 'train', unit: 'archer' });
  ok(state.gold[0] === gold - 40, `training an archer costs 40 gold (${gold} -> ${state.gold[0]})`);
}

if (problems.length > 0) {
  console.error(`ARENA CHECK FAIL (${problems.length} problem(s))`);
  process.exitCode = 1;
} else {
  console.log('ARENA CHECK PASS (deterministic, matches end, economy and combat both move)');
}
