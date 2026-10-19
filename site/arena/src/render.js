// render.js — everything you see, drawn in code: no image files, no fonts, no assets of any kind. That is
// what makes this game hostable for everyone (nothing to license) and why it loads instantly.
import { BASE_RADIUS, FP, H, TILE, UNIT, W } from './rules.js';

export const COLORS = {
  grass: ['#2f5d3a', '#356641'],
  sand: ['#7a6a45', '#867450'],
  wall: ['#4a4a52', '#57575f'],
  pile: '#e8c14a',
  teams: ['#3d7dd8', '#d8543d'],
  teamsDark: ['#22456f', '#7a2f22'],
};

/**
 * One frame. `cam` is {x, y, zoom} in world pixels (1 tile = 24 px at zoom 1).
 * @param {CanvasRenderingContext2D} ctx
 * @param {any} state
 * @param {{selected:Set<number>, cam:{x:number,y:number,zoom:number}, hover:any, timeMs:number}} view
 */
export function draw(ctx, state, view) {
  const T = 24 * view.cam.zoom;
  const ox = -view.cam.x * T;
  const oy = -view.cam.y * T;
  const tx = (x) => ox + x * T;
  const ty = (y) => oy + y * T;

  // terrain: two shades of grass/sand in a stable checker so the field reads without any texture
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const t = state.tiles[y * W + x];
      const shade = (x + y) % 2;
      const c =
        t === TILE.WALL
          ? COLORS.wall[shade]
          : t === TILE.SAND
            ? COLORS.sand[shade]
            : COLORS.grass[shade];
      ctx.fillStyle = c;
      ctx.fillRect(tx(x), ty(y), T + 1, T + 1);
    }
  }

  // gold piles: a bright disc, dimmed as it is mined out
  for (const p of state.piles) {
    const cx = ox + (p.x / FP) * T;
    const cy = oy + (p.y / FP) * T;
    const r = T * 0.42;
    const left = Math.max(0, p.amount) / 150;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(232,193,74,${0.25 + 0.75 * left})`;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = COLORS.pile;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, r * Math.max(0.12, left), 0, Math.PI * 2);
    ctx.fillStyle = COLORS.pile;
    ctx.fill();
  }

  // bases: big enough to spot from across the field, with the health bar on top
  for (let p = 0; p < state.bases.length; p++) {
    const b = state.bases[p];
    const cx = ox + (b.x / FP) * T;
    const cy = oy + (b.y / FP) * T;
    const s = T * 0.85;
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(cx - s * 1.05, cy - s * 1.05, s * 2.1, s * 2.1);
    ctx.fillStyle = COLORS.teamsDark[p];
    ctx.fillRect(cx - s, cy - s, s * 2, s * 2);
    ctx.fillStyle = COLORS.teams[p];
    ctx.fillRect(cx - s * 0.7, cy - s * 0.7, s * 1.4, s * 1.4);
    ctx.beginPath();
    ctx.moveTo(cx, cy - s);
    ctx.lineTo(cx, cy - s * 1.9);
    ctx.lineTo(cx + s * 0.75, cy - s * 1.55);
    ctx.lineTo(cx, cy - s * 1.25);
    ctx.closePath();
    ctx.fillStyle = COLORS.teams[p];
    ctx.fill();
    const w = s * 2.1;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(cx - w / 2, cy - s * 2.5, w, 5);
    ctx.fillStyle = COLORS.teams[p];
    ctx.fillRect(cx - w / 2, cy - s * 2.5, w * Math.max(0, b.hp / 400), 5);
    // a word, so "which one is mine" is never a question (a system font, not an asset)
    ctx.font = 'bold 11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    ctx.fillText(p === 0 ? 'YOU' : 'BOT', cx + 1, cy + s * 3.6 + 1);
    ctx.fillStyle = COLORS.teams[p];
    ctx.fillText(p === 0 ? 'YOU' : 'BOT', cx, cy + s * 3.6);
  }

  // units
  for (const u of state.units) {
    const spec = UNIT[u.type];
    const cx = ox + (u.x / FP) * T;
    const cy = oy + (u.y / FP) * T;
    const r = (spec.radius / FP) * T * 2.0;
    ctx.beginPath();
    if (u.type === 'knight') {
      // a square-ish shield: melee
      ctx.moveTo(cx - r, cy - r);
      ctx.lineTo(cx + r, cy - r * 0.6);
      ctx.lineTo(cx + r, cy + r);
      ctx.lineTo(cx - r, cy + r);
    } else {
      // a diamond: a bow
      ctx.moveTo(cx, cy - r);
      ctx.lineTo(cx + r, cy);
      ctx.lineTo(cx, cy + r);
      ctx.lineTo(cx - r, cy);
    }
    ctx.closePath();
    ctx.fillStyle = COLORS.teams[u.owner];
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.stroke();
    if (u.hp < spec.hp) {
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillRect(cx - r, cy - r - 5, r * 2, 3);
      ctx.fillStyle = u.hp / spec.hp > 0.5 ? '#7ee787' : '#ffb86b';
      ctx.fillRect(cx - r, cy - r - 5, r * 2 * Math.max(0, u.hp / spec.hp), 3);
    }
    if (view.selected.has(u.id)) {
      ctx.beginPath();
      ctx.arc(cx, cy, r * 1.7, 0, Math.PI * 2);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = '#ffffffcc';
      ctx.stroke();
    }
  }

  // effects: hit sparks and mining sparks, fading over a few frames
  const effects = view.effects ?? state.events;
  for (const e of effects) {
    const cx = ox + (e.x / FP) * T;
    const cy = oy + (e.y / FP) * T;
    const r = (e.kind === 'mine' ? 0.3 : e.ranged ? 0.55 : 0.35) * T;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = e.kind === 'mine' ? '#ffe28a' : e.ranged ? '#ffe9c0' : '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  // the order line of the selection at the cursor, so a right-click reads as a command
  if (view.hover !== null) {
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(ox + view.hover.x * T, oy + view.hover.y * T, T * 0.3, 0, Math.PI * 2);
    ctx.stroke();
  }
}

/** The drag rectangle of a box selection, in canvas pixels. */
export function drawSelectionBox(ctx, box) {
  if (box === null) return;
  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  ctx.strokeStyle = 'rgba(255,255,255,0.6)';
  ctx.lineWidth = 1;
  ctx.fillRect(box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0);
  ctx.strokeRect(box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0);
}

export const BASE_HP = 400;
export const PILE_TOTAL = 150;
export const TILE_PX = 24;
export const MAP_PX = { w: W * TILE_PX, h: H * TILE_PX };
