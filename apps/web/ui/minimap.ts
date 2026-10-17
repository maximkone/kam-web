// ui/minimap.ts — the corner minimap (B2A): terrain colours from the map tiles (shaded by height), hand
// colours for houses and units, the fog of war of the human hand, and the view rectangle. A click or a
// drag jumps the camera through the renderer's setCam (the camera is the only thing it changes).
import type { EconomyWorld } from '../../../packages/sim/economy.ts';
import type { KaMap } from '../../../packages/map/map.ts';
import { CELL, HAND_COLOURS, kindRgb } from './model.ts';

export interface Minimap {
  attach(w: EconomyWorld | null, map: KaMap | null, hand: number): void;
  draw(w: EconomyWorld, hand: number, cam: { x: number; y: number }, zoom: number, viewW: number, viewH: number): void;
}

const SIZE = 200;

function hexRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function createMinimap(canvas: HTMLCanvasElement, onJump: (u: number, v: number) => void): Minimap {
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d')!;
  const off = document.createElement('canvas');
  const offCtx = off.getContext('2d')!;
  let world: EconomyWorld | null = null;
  let mapX = 0;
  let mapY = 0;
  let scale = 1;
  let base: Uint8ClampedArray | null = null;
  let img: ImageData | null = null;
  let held = false;

  const jump = (e: PointerEvent): void => {
    if (world === null) return;
    const r = canvas.getBoundingClientRect();
    const u = (e.clientX - r.left) / scale;
    const v = (e.clientY - r.top) / scale;
    if (u < 0 || v < 0 || u > mapX || v > mapY) return;
    onJump(u, v);
  };
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    held = true;
    canvas.setPointerCapture(e.pointerId);
    jump(e);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (held) jump(e);
  });
  canvas.addEventListener('pointerup', () => {
    held = false;
  });
  canvas.addEventListener('pointercancel', () => {
    held = false;
  });

  const bake = (w: EconomyWorld, map: KaMap): void => {
    mapX = map.mapX;
    mapY = map.mapY;
    scale = SIZE / Math.max(mapX, mapY);
    off.width = mapX;
    off.height = mapY;
    base = new Uint8ClampedArray(mapX * mapY * 4);
    img = offCtx.createImageData(mapX, mapY);
    let lo = 255;
    let hi = 0;
    for (let i = 0; i < mapX * mapY; i++) {
      const h = map.tiles[i * 4 + 1] ?? 0;
      if (h < lo) lo = h;
      if (h > hi) hi = h;
    }
    const span = Math.max(1, hi - lo);
    for (let i = 0; i < mapX * mapY; i++) {
      const terr = map.baseTerrain !== undefined ? map.baseTerrain[i] ?? 0 : map.tiles[i * 4] ?? 0;
      const kind = w.grid.tiles[terr]?.corners[0] ?? -1;
      const [r, g, b] = kindRgb(kind);
      const shade = 0.8 + 0.4 * (((map.tiles[i * 4 + 1] ?? 0) - lo) / span);
      base[i * 4] = Math.min(255, r * shade);
      base[i * 4 + 1] = Math.min(255, g * shade);
      base[i * 4 + 2] = Math.min(255, b * shade);
      base[i * 4 + 3] = 255;
    }
  };

  return {
    attach(w, map, _hand) {
      world = w;
      if (w === null || map === null) {
        base = null;
        img = null;
        return;
      }
      bake(w, map);
    },
    draw(w, hand, cam, zoom, viewW, viewH) {
      if (base === null || img === null || world !== w) return;
      const fog = w.fog(hand);
      const data = img.data;
      data.set(base);
      for (let y = 0; y < mapY; y++) {
        for (let x = 0; x < mapX; x++) {
          const seen = fog.checkTileRev(x + 1, y + 1) > 0;
          if (seen) continue;
          const i = (y * mapX + x) * 4;
          data[i] = data[i]! * 0.4;
          data[i + 1] = data[i + 1]! * 0.4;
          data[i + 2] = data[i + 2]! * 0.4;
        }
      }
      offCtx.putImageData(img, 0, 0);
      const seenAt = (tx: number, ty: number): boolean => fog.checkTileRev(tx, ty) > 0;
      for (const h of w.houses) {
        if (h.destroyed) continue;
        if (h.owner !== hand && !seenAt(h.x, h.y)) continue;
        offCtx.fillStyle = HAND_COLOURS[h.owner % HAND_COLOURS.length]!;
        offCtx.fillRect(h.x - 1, h.y - 1, 2, 2);
      }
      for (const u of w.units) {
        if (u.dead || u.inside) continue;
        const tx = Math.round(u.posF.x);
        const ty = Math.round(u.posF.y);
        if (u.owner !== hand && !seenAt(tx, ty)) continue;
        const rgb = u.owner === hand ? hexRgb('#f4f7fb') : hexRgb(HAND_COLOURS[u.owner % HAND_COLOURS.length]!);
        offCtx.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
        offCtx.fillRect(tx - 1, ty - 1, 1, 1);
      }
      ctx.clearRect(0, 0, SIZE, SIZE);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(off, 0, 0, mapX * scale, mapY * scale);
      const cx = cam.x / CELL;
      const cy = cam.y / CELL;
      const hw = viewW / 2 / zoom / CELL;
      const hh = viewH / 2 / zoom / CELL;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1;
      ctx.strokeRect((cx - hw) * scale, (cy - hh) * scale, 2 * hw * scale, 2 * hh * scale);
    },
  };
}
