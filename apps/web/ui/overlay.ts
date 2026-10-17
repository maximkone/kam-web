// ui/overlay.ts — the transparent canvas over the game (B2A): build ghosts (green = valid, red = invalid),
// the road preview, the drag box and the rings of the selected soldiers. Drawing only; pointer-events are off,
// so the game canvas still gets every click where no panel is.
import type { PlayView } from './ui.ts';
import { CELL } from './model.ts';
import type { Tile } from './model.ts';
import type { Mode } from './ui.ts';

export interface OverlayFrame {
  width: number;
  height: number;
  view: Pick<PlayView, 'viewportOf'>;
  mode: Mode;
  tiles: { tile: Tile; ok: boolean }[];
  roadPreview: { tile: Tile; ok: boolean }[];
  box: { x: number; y: number; w: number; h: number } | null;
  selected: { x: number; y: number }[];
  houseRect: { x: number; y: number; w: number; h: number } | null;
}

function tileQuad(view: Pick<PlayView, 'viewportOf'>, t: Tile): { x: number; y: number }[] {
  const x0 = (t.x - 1) * CELL;
  const x1 = t.x * CELL;
  const y0 = (t.y - 1) * CELL;
  const y1 = t.y * CELL;
  return [view.viewportOf(x0, y0), view.viewportOf(x1, y0), view.viewportOf(x1, y1), view.viewportOf(x0, y1)];
}

function fillQuad(ctx: CanvasRenderingContext2D, pts: { x: number; y: number }[], fill: string, stroke: string): void {
  ctx.beginPath();
  ctx.moveTo(pts[0]!.x, pts[0]!.y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i]!.x, pts[i]!.y);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

export function drawOverlay(ov: HTMLCanvasElement, f: OverlayFrame): void {
  const ctx = ov.getContext('2d');
  if (ctx === null) return;
  ctx.clearRect(0, 0, ov.width, ov.height);
  for (const { tile, ok } of [...f.tiles, ...f.roadPreview]) {
    fillQuad(ctx, tileQuad(f.view, tile), ok ? 'rgba(61,220,110,0.38)' : 'rgba(255,90,79,0.38)', ok ? '#3ddc6e' : '#ff5a4f');
  }
  if (f.box !== null) {
    ctx.fillStyle = 'rgba(79,140,255,0.16)';
    ctx.strokeStyle = '#7fb0ff';
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 4]);
    ctx.fillRect(f.box.x, f.box.y, f.box.w, f.box.h);
    ctx.strokeRect(f.box.x, f.box.y, f.box.w, f.box.h);
    ctx.setLineDash([]);
  }
  if (f.houseRect !== null) {
    ctx.strokeStyle = '#ffd24a';
    ctx.lineWidth = 2;
    ctx.strokeRect(f.houseRect.x, f.houseRect.y, f.houseRect.w, f.houseRect.h);
  }
  ctx.strokeStyle = '#7fd1ff';
  ctx.lineWidth = 2;
  for (const p of f.selected) {
    ctx.beginPath();
    ctx.arc(p.x, p.y + 4, 9, 0, Math.PI * 2);
    ctx.stroke();
  }
}
