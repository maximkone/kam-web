// sim.js — the whole simulation. Pure, deterministic, DOM-free: integers only (positions are sub-units),
// one seeded LCG for the map, no Math.random, no clock. Two machines given the same commands and the same
// seed produce the same state hash, which is exactly what lockstep multiplayer will need (tools/check.js
// proves it).
import {
  AUTO_ACQUIRE,
  BASE_HP,
  BASE_RADIUS,
  FP,
  H,
  INCOME_AMOUNT,
  INCOME_TICKS,
  MATCH_TICKS,
  PILE_GOLD,
  PILE_RATE_AMOUNT,
  PILE_RATE_TICKS,
  PILE_REACH,
  SEPARATION,
  START_GOLD,
  TILE,
  UNIT,
  W,
  isqrt,
  within,
} from './rules.js';

/** @typedef {{kind:'move', x:number, y:number}
 *           | {kind:'attackUnit', id:number}
 *           | {kind:'attackBase', owner:number}} Order */
/** @typedef {{id:number, owner:number, type:'knight'|'archer', x:number, y:number, hp:number, cd:number, order:Order|null}} Unit */

/** The seeded generator: an LCG, because a sim may not call Math.random. */
function nextRandom(state) {
  state.rng = (Math.imul(state.rng, 1103515245) + 12345) & 0x7fffffff;
  return state.rng;
}

function idx(x, y) {
  return y * W + x;
}

function inMap(tx, ty) {
  return tx >= 0 && ty >= 0 && tx < W && ty < H;
}

function tileAt(state, tx, ty) {
  return inMap(tx, ty) ? state.tiles[idx(tx, ty)] : TILE.WALL;
}

/** Is the tile under a sub-unit position a wall? (1 tile = FP sub-units) */
function wallAt(state, x, y) {
  return tileAt(state, x >> 4, y >> 4) === TILE.WALL;
}

function spawnPoint(state, owner, slot) {
  const b = state.bases[owner];
  const side = owner === 0 ? 1 : -1;
  // far enough from the base that the base stays readable behind its own troops
  const ox = 30 + (slot % 3) * 9;
  const oy = (((slot * 4) % 9) - 4) * 8;
  return { x: b.x + side * ox, y: b.y + oy };
}

/** Put a unit on the map, nudging it out of a wall if the spot is taken. */
function addUnit(state, owner, type, x, y) {
  const spec = UNIT[type];
  let px = x;
  let py = y;
  for (let tries = 0; tries < 24 && wallAt(state, px, py); tries++) {
    const dir = tries % 4;
    px = x + (dir === 0 ? 1 : dir === 1 ? -1 : 0) * (8 + tries * 3);
    py = y + (dir === 2 ? 1 : dir === 3 ? -1 : 0) * (8 + tries * 3);
  }
  const unit = {
    id: state.nextId++,
    owner,
    type,
    x: px,
    y: py,
    hp: spec.hp,
    cd: 0,
    order: /** @type {Order|null} */ (null),
  };
  state.units.push(unit);
  return unit;
}

/** A symmetric arena: mirrored obstacles so neither side gets a better map. */
function buildMap(state) {
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const border = x === 0 || y === 0 || x === W - 1 || y === H - 1;
      state.tiles[idx(x, y)] = border ? TILE.WALL : TILE.GRASS;
    }
  }
  // a few sand patches, then small obstacle blocks, each mirrored left/right and top/bottom
  for (let n = 0; n < 12; n++) {
    const cx = 2 + (nextRandom(state) % (W - 4));
    const cy = 2 + (nextRandom(state) % (H - 4));
    const r = 2 + (nextRandom(state) % 2);
    for (let y = cy - r; y <= cy + r; y++) {
      for (let x = cx - r; x <= cx + r; x++) {
        if (inMap(x, y) && state.tiles[idx(x, y)] === TILE.GRASS) state.tiles[idx(x, y)] = TILE.SAND;
      }
    }
  }
  const blocks = 7;
  for (let n = 0; n < blocks; n++) {
    const bx = 7 + (nextRandom(state) % (W / 2 - 14));
    const by = 4 + (nextRandom(state) % (H - 8));
    const bw = 1 + (nextRandom(state) % 3);
    const bh = 1 + (nextRandom(state) % 2);
    for (const [mx, my] of [
      [bx, by],
      [W - 1 - bx - bw, by],
      [bx, H - 1 - by - bh],
      [W - 1 - bx - bw, H - 1 - by - bh],
    ]) {
      for (let y = 0; y < bh; y++) {
        for (let x = 0; x < bw; x++) {
          if (inMap(mx + x, my + y) && state.tiles[idx(mx + x, my + y)] === TILE.GRASS) {
            state.tiles[idx(mx + x, my + y)] = TILE.WALL;
          }
        }
      }
    }
  }
  // keep both bases and the middle open
  for (const [cx, cy, r] of [
    [4, (H / 2) | 0, 5],
    [W - 5, (H / 2) | 0, 5],
  ]) {
    for (let y = cy - r; y <= cy + r; y++) {
      for (let x = cx - r; x <= cx + r; x++) {
        if (inMap(x, y)) state.tiles[idx(x, y)] = TILE.SAND;
      }
    }
  }
}

function addPiles(state) {
  // Mirrored exactly (tile x -> W-1-x, tile y -> H-1-y), so neither side sits closer to a pile: an
  // off-by-one here is a real, measurable advantage (the check's winners were always the same player).
  const half = [
    [17, 10],
    [17, 21],
  ];
  const tiles = /** @type {number[][]} */ ([]);
  const seen = new Set();
  for (const [x, y] of half) {
    for (const [mx, my] of [
      [x, y],
      [W - 1 - x, y],
      [x, H - 1 - y],
      [W - 1 - x, H - 1 - y],
    ]) {
      const key = `${mx},${my}`;
      if (seen.has(key)) continue;
      seen.add(key);
      tiles.push([mx, my]);
    }
  }
  for (const [tx, ty] of tiles) {
    state.piles.push({ x: tx * FP + FP / 2, y: ty * FP + FP / 2, amount: PILE_GOLD });
    if (inMap(tx, ty)) {
      state.tiles[idx(tx, ty)] = TILE.PILE;
      // the pile is walkable ground: clear the walls the random blocks may have put under it
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        if (inMap(tx + dx, ty + dy) && state.tiles[idx(tx + dx, ty + dy)] === TILE.WALL) {
          state.tiles[idx(tx + dx, ty + dy)] = TILE.SAND;
        }
      }
    }
  }
}

/** @returns {any} a fresh game state */
export function createGame(seed = 1, players = 2) {
  const state = {
    seed,
    rng: (Math.imul(seed, 2654435761) + 1) & 0x7fffffff,
    tick: 0,
    players,
    tiles: new Int8Array(W * H),
    piles: /** @type {{x:number,y:number,amount:number}[]} */ ([]),
    units: /** @type {Unit[]} */ ([]),
    gold: new Array(players).fill(0),
    bases: [
      { x: 4 * FP + FP / 2, y: ((H / 2) | 0) * FP + FP / 2, hp: BASE_HP },
      { x: (W - 5) * FP + FP / 2, y: ((H / 2) | 0) * FP + FP / 2, hp: BASE_HP },
    ],
    nextId: 1,
    winner: -1,
    over: false,
    events: /** @type {any[]} */ ([]),
  };
  buildMap(state);
  addPiles(state);
  state.gold.fill(START_GOLD);
  for (let owner = 0; owner < players; owner++) {
    for (let slot = 0; slot < 2; slot++) {
      const p = spawnPoint(state, owner, slot);
      addUnit(state, owner, 'knight', p.x, p.y);
    }
  }
  return state;
}

/** Train one unit for a player; false when the gold is not there. */
export function train(state, owner, type) {
  const spec = UNIT[type];
  if (spec === undefined || state.gold[owner] < spec.cost) return false;
  const slot = state.units.filter((u) => u.owner === owner).length;
  const p = spawnPoint(state, owner, slot);
  state.gold[owner] -= spec.cost;
  addUnit(state, owner, type, p.x, p.y);
  return true;
}

/** The sim's only input: `{tick, player, kind, ...}` (the shape lockstep will carry). */
export function applyCommand(state, cmd) {
  if (state.over) return;
  if (cmd.kind === 'train') {
    train(state, cmd.player, cmd.unit);
    return;
  }
  const ids = Array.isArray(cmd.ids) ? cmd.ids : [];
  for (const u of state.units) {
    if (!ids.includes(u.id) || u.owner !== cmd.player) continue;
    if (cmd.kind === 'move') u.order = { kind: 'move', x: cmd.x, y: cmd.y };
    else if (cmd.kind === 'attackUnit') u.order = { kind: 'attackUnit', id: cmd.id };
    else if (cmd.kind === 'attackBase') u.order = { kind: 'attackBase', owner: cmd.owner };
    else if (cmd.kind === 'stop') u.order = null;
  }
}

function findUnit(state, id) {
  return state.units.find((u) => u.id === id) ?? null;
}

/** Move one sub-unit step toward (tx,ty), sliding along walls; nothing is blocked by another unit. */
function moveToward(state, u, tx, ty) {
  const spec = UNIT[u.type];
  const dx = tx - u.x;
  const dy = ty - u.y;
  const d = isqrt(dx * dx + dy * dy);
  if (d <= 2) return;
  let mx = Math.trunc((dx * spec.speed) / d);
  let my = Math.trunc((dy * spec.speed) / d);
  if (mx === 0 && my === 0) {
    if (Math.abs(dx) >= Math.abs(dy)) mx = Math.sign(dx);
    else my = Math.sign(dy);
  }
  const nx = u.x + mx;
  const ny = u.y + my;
  if (!wallAt(state, nx, ny)) {
    u.x = nx;
    u.y = ny;
    return;
  }
  if (!wallAt(state, u.x + mx, u.y)) u.x += mx;
  else if (!wallAt(state, u.x, u.y + my)) u.y += my;
}

function targetOf(state, u) {
  const o = u.order;
  if (o === null) return null;
  if (o.kind === 'move') return { x: o.x, y: o.y, unit: null, baseOwner: -1 };
  if (o.kind === 'attackUnit') {
    const t = findUnit(state, o.id);
    if (t === null || t.owner === u.owner) {
      u.order = null;
      return null;
    }
    return { x: t.x, y: t.y, unit: t, baseOwner: -1 };
  }
  const owner = o.owner === u.owner ? 1 - u.owner : o.owner;
  const b = state.bases[owner];
  return { x: b.x, y: b.y, unit: null, baseOwner: owner };
}

function nearestEnemy(state, u, range) {
  let best = null;
  let bestD = range * range;
  for (const t of state.units) {
    if (t.owner === u.owner || t.hp <= 0) continue;
    const dx = t.x - u.x;
    const dy = t.y - u.y;
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = t;
    }
  }
  return best;
}

function nearestPile(state, u) {
  let best = null;
  let bestD = PILE_REACH * PILE_REACH;
  for (const p of state.piles) {
    if (p.amount <= 0) continue;
    const dx = p.x - u.x;
    const dy = p.y - u.y;
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}

/** One tick. Order of operations is fixed: it is part of the contract, not an implementation detail. */
export function step(state) {
  if (state.over) return;
  state.tick += 1;
  state.events.length = 0;

  if (state.tick % INCOME_TICKS === 0) {
    for (let p = 0; p < state.players; p++) state.gold[p] += INCOME_AMOUNT;
  }

  // mining: every second, a unit standing at a pile takes gold (both sides can mine the same pile)
  if (state.tick % PILE_RATE_TICKS === 0) {
    for (const u of state.units) {
      const pile = nearestPile(state, u);
      if (pile === null) continue;
      const take = Math.min(PILE_RATE_AMOUNT, pile.amount);
      pile.amount -= take;
      state.gold[u.owner] += take;
      state.events.push({ kind: 'mine', x: pile.x, y: pile.y, owner: u.owner });
    }
  }

  for (const u of state.units) {
    if (u.hp <= 0) continue;
    if (u.cd > 0) u.cd -= 1;

    // an idle unit engages whatever is close by; a unit at a pile stays to mine
    if (u.order === null && nearestPile(state, u) === null) {
      const e = nearestEnemy(state, u, AUTO_ACQUIRE);
      if (e !== null) u.order = { kind: 'attackUnit', id: e.id };
    }

    const target = targetOf(state, u);
    if (target === null) continue;
    const spec = UNIT[u.type];

    if (target.unit !== null) {
      if (within(u.x, u.y, target.unit.x, target.unit.y, spec.range)) {
        if (u.cd === 0 && target.unit.hp > 0) {
          target.unit.hp -= spec.damage;
          u.cd = spec.cooldown;
          state.events.push({ kind: 'hit', x: target.unit.x, y: target.unit.y, owner: u.owner, ranged: spec.range > 20 });
        }
        continue;
      }
      moveToward(state, u, target.unit.x, target.unit.y);
      continue;
    }

    if (target.baseOwner >= 0) {
      const b = state.bases[target.baseOwner];
      if (within(u.x, u.y, b.x, b.y, spec.range + BASE_RADIUS)) {
        if (u.cd === 0 && b.hp > 0) {
          b.hp -= spec.damage;
          u.cd = spec.cooldown;
          state.events.push({ kind: 'hit', x: b.x, y: b.y, owner: u.owner, ranged: spec.range > 20 });
        }
        continue;
      }
      moveToward(state, u, b.x, b.y);
      continue;
    }

    if (nearestPile(state, u) !== null) continue; // standing at a pile: mine instead of shuffling
    moveToward(state, u, target.x, target.y);
  }

  // light separation so a group does not stack into one dot
  for (let i = 0; i < state.units.length; i++) {
    const a = state.units[i];
    if (a.hp <= 0) continue;
    for (let j = i + 1; j < state.units.length; j++) {
      const b = state.units[j];
      if (b.hp <= 0) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      if (dx * dx + dy * dy >= SEPARATION * SEPARATION) continue;
      const sx = dx === 0 ? 1 : Math.sign(dx);
      const sy = dy === 0 ? 1 : Math.sign(dy);
      const px = a.x - sx;
      const py = a.y - sy;
      const qx = b.x + sx;
      const qy = b.y + sy;
      if (!wallAt(state, px, py)) {
        a.x = px;
        a.y = py;
      }
      if (!wallAt(state, qx, qy)) {
        b.x = qx;
        b.y = qy;
      }
    }
  }

  // deaths, then the win condition
  if (state.units.some((u) => u.hp <= 0)) state.units = state.units.filter((u) => u.hp > 0);
  for (let p = 0; p < state.players; p++) {
    if (state.bases[p].hp <= 0) state.bases[p].hp = 0;
  }
  const dead = state.bases.findIndex((b) => b.hp <= 0);
  if (dead >= 0) {
    state.over = true;
    state.winner = 1 - dead;
    return;
  }
  if (state.tick >= MATCH_TICKS) {
    state.over = true;
    const [a, b] = state.bases;
    if (a.hp !== b.hp) state.winner = a.hp > b.hp ? 0 : 1;
    else {
      const counts = [0, 0];
      for (const u of state.units) if (u.owner < counts.length) counts[u.owner] += 1;
      state.winner = counts[0] === counts[1] ? 2 : counts[0] > counts[1] ? 0 : 1;
    }
  }
}

/** A stable 32-bit digest of everything that matters (the lockstep desync check). */
export function stateHash(s) {
  let h = 2166136261 >>> 0;
  const mix = (v) => {
    for (let i = 0; i < 32; i += 8) {
      h ^= (v >>> i) & 0xff;
      h = Math.imul(h, 16777619) >>> 0;
    }
  };
  mix(s.tick);
  for (const g of s.gold) mix(g);
  for (const b of s.bases) mix(b.hp);
  for (const p of s.piles) mix(p.amount);
  for (const u of s.units) {
    mix(u.id);
    mix(u.owner);
    mix(u.type === 'knight' ? 0 : 1);
    mix(u.x);
    mix(u.y);
    mix(u.hp);
    mix(u.cd);
    mix(u.order === null ? 0 : u.order.kind === 'move' ? 1 : u.order.kind === 'attackUnit' ? 2 : 3);
    mix(u.order !== null && u.order.kind === 'attackUnit' ? u.order.id : 0);
  }
  return h >>> 0;
}

/** Convenience for the UI: units of one player, alive. */
export function unitsOf(state, owner) {
  return state.units.filter((u) => u.owner === owner);
}
