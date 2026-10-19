// main.js — the game loop, the input and the HUD. No framework, no build step: this file is loaded by
// index.html as a plain ES module and everything it needs is a canvas.
import { createBot, botCommands } from './ai.js';
import { COLORS, draw, drawSelectionBox, MAP_PX, TILE_PX } from './render.js';
import { BASE_HP, FP, MATCH_TICKS, TPS, UNIT } from './rules.js';
import { applyCommand, createGame, stateHash, step, unitsOf } from './sim.js';

const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('game'));
const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
const hud = {
  gold: document.getElementById('gold'),
  base: document.getElementById('basehp'),
  army: document.getElementById('army'),
  timer: document.getElementById('timer'),
  plan: document.getElementById('plan'),
  hint: document.getElementById('hint'),
  end: document.getElementById('end'),
  endTitle: document.getElementById('endtitle'),
  endText: document.getElementById('endtext'),
  restart: document.getElementById('restart'),
};

const HUMAN = 0;
const BOT = 1;
let seed = (Date.now() % 100000) | 0;
let state = createGame(seed, 2);
let bots = [createBot(BOT)];
/** Commands with a tick stamp, exactly the shape the sim takes (and the shape a relay would carry). */
let queue = [];
let selected = new Set();
let paused = false;
let speed = 1;
let acc = 0;
let last = 0;
let drag = null;
let mouse = { x: 0, y: 0, wx: 0, wy: 0 };
let effects = [];
let spectate = false;

function reset(newSeed) {
  seed = newSeed === undefined ? (Date.now() % 100000) | 0 : newSeed;
  state = createGame(seed, 2);
  bots = [createBot(BOT)];
  if (spectate) bots = [createBot(0), createBot(1)];
  queue = [];
  selected = new Set();
  effects = [];
  paused = false;
  hud.end.classList.add('hide');
  hud.hint.textContent = `arena ${seed} - drag to select, right-click to move or attack`;
}

// ---- input -----------------------------------------------------------------
function canvasPos(ev) {
  const r = canvas.getBoundingClientRect();
  return { x: ev.clientX - r.left, y: ev.clientY - r.top };
}

/** Canvas pixel -> world tile position (the sim's sub-units). */
function worldPos(p) {
  const zoom = canvas.width / (MAP_PX.w);
  return { x: (p.x / zoom) / 1, y: (p.y / zoom) / 1 };
}

function unitAt(w) {
  const wx = w.x * FP;
  const wy = w.y * FP;
  let best = null;
  let bestD = 16 * 16;
  for (const u of state.units) {
    const d = (u.x - wx) ** 2 + (u.y - wy) ** 2;
    if (d < bestD) {
      bestD = d;
      best = u;
    }
  }
  return best;
}

canvas.addEventListener('mousedown', (ev) => {
  ev.preventDefault();
  const p = canvasPos(ev);
  const w = worldPos(p);
  if (ev.button === 0) {
    drag = { x0: p.x, y0: p.y, x1: p.x, y1: p.y, add: ev.shiftKey };
  } else if (ev.button === 2) {
    const ids = [...selected];
    if (ids.length === 0) return;
    const target = unitAt(w);
    if (target !== null && target.owner !== HUMAN) queue.push({ tick: state.tick + 2, player: HUMAN, kind: 'attackUnit', ids, id: target.id });
    else if (Math.abs(w.x - state.bases[BOT].x / FP) < 1 && Math.abs(w.y - state.bases[BOT].y / FP) < 1) {
      queue.push({ tick: state.tick + 2, player: HUMAN, kind: 'attackBase', ids, owner: BOT });
    } else {
      queue.push({ tick: state.tick + 2, player: HUMAN, kind: 'move', ids, x: Math.round(w.x * FP), y: Math.round(w.y * FP) });
    }
  }
});

canvas.addEventListener('mousemove', (ev) => {
  const p = canvasPos(ev);
  mouse = p;
  const w = worldPos(p);
  mouse.wx = w.x;
  mouse.wy = w.y;
  if (drag !== null) {
    drag.x1 = p.x;
    drag.y1 = p.y;
  }
});

window.addEventListener('mouseup', (ev) => {
  if (drag === null) return;
  const box = drag;
  drag = null;
  const zoom = canvas.width / MAP_PX.w;
  const alive = unitsOf(state, HUMAN);
  if (Math.abs(box.x1 - box.x0) < 4 && Math.abs(box.y1 - box.y0) < 4) {
    const u = unitAt(worldPos({ x: box.x1, y: box.y1 }));
    if (u !== null && u.owner === HUMAN) {
      if (!box.add) selected.clear();
      selected.add(u.id);
    } else if (!box.add) selected.clear();
    return;
  }
  const x0 = Math.min(box.x0, box.x1) / zoom;
  const y0 = Math.min(box.y0, box.y1) / zoom;
  const x1 = Math.max(box.x0, box.x1) / zoom;
  const y1 = Math.max(box.y0, box.y1) / zoom;
  if (!box.add) selected.clear();
  for (const u of alive) {
    const ux = u.x / FP;
    const uy = u.y / FP;
    if (ux >= x0 && ux <= x1 && uy >= y0 && uy <= y1) selected.add(u.id);
  }
});

canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());

window.addEventListener('keydown', (ev) => {
  const k = ev.key.toLowerCase();
  if (k === '1') queue.push({ tick: state.tick + 2, player: HUMAN, kind: 'train', unit: 'knight' });
  else if (k === '2') queue.push({ tick: state.tick + 2, player: HUMAN, kind: 'train', unit: 'archer' });
  else if (k === 'a') selected = new Set(unitsOf(state, HUMAN).map((u) => u.id));
  else if (k === 's') queue.push({ tick: state.tick + 2, player: HUMAN, kind: 'stop', ids: [...selected] });
  else if (k === ' ') {
    paused = !paused;
    hud.hint.textContent = paused ? 'paused' : 'running';
    ev.preventDefault();
  } else if (k === 'v') {
    spectate = !spectate;
    reset(seed);
  } else if (k === 'r') reset();
});
hud.restart.addEventListener('click', () => reset());

// ---- the loop --------------------------------------------------------------
function tickOnce() {
  // commands first (exactly what a lockstep turn would do), then the tick
  const due = queue.filter((c) => c.tick <= state.tick);
  if (due.length > 0) {
    queue = queue.filter((c) => c.tick > state.tick);
    for (const c of due) applyCommand(state, c);
  }
  for (const bot of bots) for (const c of botCommands(state, bot)) applyCommand(state, c);
  step(state);

  for (const e of state.events) effects.push({ ...e, ttl: 6 });
  for (const e of effects) e.ttl -= 1;
  effects = effects.filter((e) => e.ttl > 0);

  if (state.over) {
    hud.end.classList.remove('hide');
    const w = state.winner;
    hud.endTitle.textContent = w === 2 ? 'draw' : spectate ? `player ${w} wins` : w === HUMAN ? 'you win' : 'you lose';
    hud.endText.textContent =
      w === 2 ? 'both bases stood - nobody takes the field' : `base destroyed or the clock ran out at tick ${state.tick}`;
  }
}

function updateHud() {
  const mine = unitsOf(state, HUMAN).length;
  const theirs = unitsOf(state, BOT).length;
  hud.gold.textContent = `gold ${state.gold[HUMAN]}${spectate ? ` / ${state.gold[BOT]}` : ''}`;
  hud.base.textContent = `base ${Math.max(0, state.bases[HUMAN].hp)}/${BASE_HP}`;
  hud.army.textContent = `units ${mine}${spectate ? ` / ${theirs}` : ''}`;
  const left = Math.max(0, MATCH_TICKS - state.tick);
  hud.timer.textContent = `${Math.floor(left / TPS / 60)}:${String(Math.floor(left / TPS) % 60).padStart(2, '0')}`;
  if (bots.length > 0) hud.plan.textContent = `bot: ${bots[bots.length - 1].plan}`;
}

function frame(now) {
  if (last === 0) last = now;
  acc += Math.min(250, now - last) * speed;
  last = now;
  try {
    if (!paused && !state.over) {
      let guard = 0;
      while (acc >= 1000 / TPS && guard++ < 8) {
        tickOnce();
        acc -= 1000 / TPS;
        if (state.over) break;
      }
    }
    const view = {
      selected,
      cam: { x: 0, y: 0, zoom: canvas.width / MAP_PX.w },
      hover: { x: mouse.wx, y: mouse.wy },
      effects,
    };
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    draw(ctx, state, view);
    drawSelectionBox(ctx, drag === null ? null : { x0: drag.x0, y0: drag.y0, x1: drag.x1, y1: drag.y1 });
    updateHud();
  } catch (err) {
    // A first-person view of the sim must never die silently: show what broke and stop.
    hud.hint.textContent = `error: ${err instanceof Error ? err.message : String(err)}`;
    console.error('arena frame error:', err);
    return;
  }
  requestAnimationFrame(frame);
}

function resize() {
  const box = canvas.parentElement.getBoundingClientRect();
  canvas.width = Math.floor(box.width);
  canvas.height = Math.floor((box.width * MAP_PX.h) / MAP_PX.w);
  canvas.style.height = `${canvas.height}px`;
  ctx.imageSmoothingEnabled = false;
}

window.addEventListener('resize', resize);
resize();
hud.hint.textContent = `arena ${seed} - drag to select, right-click to move or attack`;
document.getElementById('train1').addEventListener('click', () => queue.push({ tick: state.tick + 2, player: HUMAN, kind: 'train', unit: 'knight' }));
document.getElementById('train2').addEventListener('click', () => queue.push({ tick: state.tick + 2, player: HUMAN, kind: 'train', unit: 'archer' }));
document.getElementById('newgame').addEventListener('click', () => reset());
requestAnimationFrame(frame);

// A tiny debug hook, so a browser check can read the sim without touching the internals.
window.__arena = {
  state: () => state,
  hash: () => stateHash(state),
  seed: () => seed,
  selectAll: () => {
    selected = new Set(unitsOf(state, HUMAN).map((u) => u.id));
    return selected.size;
  },
  queue: (cmd) => queue.push(cmd),
};
