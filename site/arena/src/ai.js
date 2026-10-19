// ai.js — the bots. They play by exactly the same rules as a human: the same gold, the same prices, the
// same units, no peeking at your input. Deterministic on purpose (no randomness), so a headless run
// (tools/check.js) and a browser run of the same seed produce the same game.
import { PILE_REACH, UNIT, within } from './rules.js';
import { unitsOf } from './sim.js';

const THINK_EVERY = 10; // ticks between decisions (twice a second)
const MAX_ARMY = 14; // a bot stops growing past this, so a stalled match still ends

/**
 * @param {number} owner
 * @returns {{owner:number, plan:string, lastThink:number}}
 */
export function createBot(owner) {
  return { owner, plan: 'mine', lastThink: -999 };
}

function nearestPile(state, x, y) {
  let best = null;
  let bestD = Infinity;
  for (const p of state.piles) {
    if (p.amount <= 0) continue;
    const d = (p.x - x) * (p.x - x) + (p.y - y) * (p.y - y);
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}

/** The commands this bot wants this tick (an empty array most ticks). */
export function botCommands(state, bot) {
  const cmds = [];
  const mine = unitsOf(state, bot.owner);
  const enemyOwner = 1 - bot.owner;
  const enemy = unitsOf(state, enemyOwner);
  const base = state.bases[bot.owner];
  const enemyBase = state.bases[enemyOwner];
  const gold = state.gold[bot.owner];

  // Defence first: an enemy close to the base pulls everyone home.
  const threat = enemy.find((e) => within(e.x, e.y, base.x, base.y, 70));
  const plan = threat !== undefined ? 'defend' : mine.length >= 4 ? 'attack' : 'mine';

  if (state.tick - bot.lastThink < THINK_EVERY) return cmds;
  bot.lastThink = state.tick;

  // Train: keep a small frontline, then add archers behind it.
  if (mine.length < MAX_ARMY) {
    const knights = mine.filter((u) => u.type === 'knight').length;
    const archers = mine.filter((u) => u.type === 'archer').length;
    if (archers < knights && gold >= UNIT.archer.cost) cmds.push({ tick: state.tick, player: bot.owner, kind: 'train', unit: 'archer' });
    else if (gold >= UNIT.knight.cost) cmds.push({ tick: state.tick, player: bot.owner, kind: 'train', unit: 'knight' });
  }

  const changed = plan !== bot.plan;
  bot.plan = plan;
  if (!changed && state.tick % 60 !== 0) return cmds;

  const ids = mine.map((u) => u.id);
  if (ids.length === 0) return cmds;

  if (plan === 'defend' && threat !== undefined) {
    cmds.push({ tick: state.tick, player: bot.owner, kind: 'attackUnit', ids, id: threat.id });
    return cmds;
  }
  if (plan === 'attack') {
    cmds.push({ tick: state.tick, player: bot.owner, kind: 'attackBase', ids, owner: enemyOwner });
    return cmds;
  }
  // mine: gather at the pile nearest to the base's half of the map
  const pile = nearestPile(state, base.x, base.y);
  if (pile !== null) {
    const spot = { x: pile.x + (bot.owner === 0 ? PILE_REACH - 4 : -(PILE_REACH - 4)), y: pile.y };
    cmds.push({ tick: state.tick, player: bot.owner, kind: 'move', ids, x: spot.x, y: spot.y });
  }
  return cmds;
}
