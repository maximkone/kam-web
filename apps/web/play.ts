// play.ts — M2b playable slice (docs/M2B-SPIKE.md section 5).
//
// Terrain rendering + camera are the M1 mapdemo renderer (copied from mapdemo.ts, which stays
// untouched): one static VBO for all tiles, one drawElements, camera as a uniform.
// On top of that this page runs the headless Sim (packages/sim) with demoSpawns at 10 ticks/s,
// draws the units from the Units atlas and adds select / walk input.
//
// Sprite id: the walk loop step value (unit.dat, 0-based) IS the atlas `i` (KM_ResInterpolation.pas:97
// `Result := A.Step[step] + 1;` is the game render id, and atlas i = game render id - 1: erratum 2026-10-16).
// Still frame: step at (UNIT_STILL_FRAMES[dir] mod Count) of the loop.
// Anchor: world = ((posF.x + UNIT_OFF_X) * 40, (posF.y + UNIT_OFF_Y) * 40) minus the bilinear
// terrain height shift (spec 5: visual check only, exact anchoring later). The sprite top-left is
// anchor + pivot(px,py), size w x h world px at 1:1 (KM_RenderPool.pas:1052-1053).
//
// serve.ts transpiles this file together with the browser-safe sim/assets modules it imports
// (one tsc run, --rewriteRelativeImportExtensions): /apps/web/play.js + /packages/**/*.js.
// ESM, zero runtime deps, imports keep the .ts extension (node/tsc) and become .js for the browser.

import { parseTilesJson } from '../../packages/assets/tiledata.ts';
import { parseMapElem } from '../../packages/assets/mapelem.ts';
import { parseUnitDat, walkLoop } from '../../packages/assets/unitdat.ts';
import { buildPassGrid, tileWalkable } from '../../packages/sim/terrain.ts';
import { findPath } from '../../packages/sim/astar.ts';
import { Sim, demoSpawns } from '../../packages/sim/sim.ts';
import type { PassGrid } from '../../packages/sim/terrain.ts';
import type { UnitSpec } from '../../packages/assets/unitdat.ts';
import type { SimUnit } from '../../packages/sim/sim.ts';

// ---- frozen viewer data shapes (M1 section 3.2 + M0 section 3) --------------
interface MapJson { file: string; mapX: number; mapY: number; tiles: string }
interface AtlasSheet { file: string; w: number; h: number }
interface AtlasSprite { i: number; w: number; h: number; px: number; py: number; s: number; x: number; y: number; ms: number; mx: number; my: number }
interface Atlas { pack: string; sheets: AtlasSheet[]; maskSheets: AtlasSheet[]; sprites: AtlasSprite[] }

// ---- constants (M1 section 2.3 + M2b sections 2.4, 2.7, 5) ------------------
const CELL = 40;             // CELL_SIZE_PX (KM_Defaults.pas line 13)
const HEIGHT_DIV = 33.333;   // CELL_HEIGHT_DIV (line 14)
const PX_PER_HEIGHT = CELL / HEIGHT_DIV;
const ZOOM_STEP = 1.5;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 8;
const TICK_MS = 100;         // 10 sim ticks/s (spec 5)
const MAX_CATCHUP = 5;       // catch-up cap per frame (spec 5)
const UNIT_OFF_X = -0.5;     // KM_ResUnits.pas:188
const UNIT_OFF_Y = -0.4;     // KM_ResUnits.pas:189
const SPRITE_ID_ADD = 0;     // atlas i = game render id - 1 (KM_ResSprites.pas:780 aStartingIndex = 1); the stored step IS the atlas i
const SELECT_RADIUS_PX = 24; // spec 5
const UNIT_STILL_FRAMES = [0, 3, 2, 2, 1, 6, 7, 6, 6]; // KM_ResUnits.pas:181, index = dir 0..8
const OWNER_TINTS: [number, number, number][] = [
  [1, 1, 1],           // owner 0 = default: the raw sprite, mask not applied (spec 5)
  [0.36, 0.55, 0.95],  // placeholder team colors until the GUI art pass
  [0.93, 0.36, 0.30],
  [0.40, 0.85, 0.45],
  [0.93, 0.82, 0.32],
];

const cv = document.getElementById('cv') as HTMLCanvasElement;
const hud = document.getElementById('hud') as HTMLDivElement;
const errBox = document.getElementById('err') as HTMLDivElement;
const gl = cv.getContext('webgl2', { alpha: false });
if (gl === null) throw new Error('webgl2 unavailable');

// ---- shader programs --------------------------------------------------------
// Terrain: position + UV from the VBO, camera uniform only (M1 mapdemo).
const TERRAIN_VS = `#version 300 es
in vec2 aPos;        // world px
in vec2 aUV;         // atlas UV
uniform vec2 uCam;   // world px at the viewport centre
uniform float uZoom; // css px per world px
uniform vec2 uView;  // viewport, css px
out vec2 vUV;
void main() {
  vec2 css = (aPos - uCam) * uZoom + uView * 0.5;
  gl_Position = vec4(css.x / uView.x * 2.0 - 1.0, 1.0 - css.y / uView.y * 2.0, 0.0, 1.0);
  vUV = aUV;
}`;
const TERRAIN_FS = `#version 300 es
precision mediump float;
in vec2 vUV;
uniform sampler2D uTex;
out vec4 outColor;
void main() { outColor = texture(uTex, vUV); }`;

// Sprites + selection ring: one 0..1 quad, world top-left + size, sheet rect UVs, optional
// team tint through the mask sheet (mask byte = alpha, RGB red; packages/assets/atlas.ts).
const SPRITE_VS = `#version 300 es
in vec2 aPos;        // 0..1 quad
uniform vec2 uCam;
uniform float uZoom;
uniform vec2 uView;
uniform vec2 uWorld; // quad top-left, world px
uniform vec2 uSize;  // quad size, world px
out vec2 vPos;
void main() {
  vec2 css = (uWorld + aPos * uSize - uCam) * uZoom + uView * 0.5;
  gl_Position = vec4(css.x / uView.x * 2.0 - 1.0, 1.0 - css.y / uView.y * 2.0, 0.0, 1.0);
  vPos = aPos;
}`;
const SPRITE_FS = `#version 300 es
precision mediump float;
in vec2 vPos;
uniform sampler2D uTex;
uniform vec4 uRect;     // sprite rect in its sheet, px (x,y,w,h)
uniform vec2 uSheet;    // sheet size, px
uniform sampler2D uMaskTex;
uniform vec4 uMaskRect; // mask rect in its mask sheet, px
uniform vec2 uMaskSheet;
uniform float uHasMask;
uniform vec3 uTint;
out vec4 outColor;
void main() {
  vec2 uv = (uRect.xy + vPos * uRect.zw) / uSheet;
  vec4 c = texture(uTex, uv);
  if (uHasMask > 0.5) {
    vec2 muv = (uMaskRect.xy + vPos * uMaskRect.zw) / uMaskSheet;
    float m = texture(uMaskTex, muv).a;
    c.rgb = mix(c.rgb, uTint, m);
  }
  outColor = c;
}`;

function compile(type: number, src: string): WebGLShader {
  const sh = gl!.createShader(type)!;
  gl!.shaderSource(sh, src);
  gl!.compileShader(sh);
  if (!gl!.getShaderParameter(sh, gl!.COMPILE_STATUS)) {
    throw new Error(`shader: ${gl!.getShaderInfoLog(sh)}`);
  }
  return sh;
}

function link(vsSrc: string, fsSrc: string): WebGLProgram {
  const prog = gl!.createProgram()!;
  gl!.attachShader(prog, compile(gl!.VERTEX_SHADER, vsSrc));
  gl!.attachShader(prog, compile(gl!.FRAGMENT_SHADER, fsSrc));
  gl!.linkProgram(prog);
  if (!gl!.getProgramParameter(prog, gl!.LINK_STATUS)) throw new Error(`link: ${gl!.getProgramInfoLog(prog)}`);
  return prog;
}

const terrainProg = link(TERRAIN_VS, TERRAIN_FS);
const spriteProg = link(SPRITE_VS, SPRITE_FS);
gl.useProgram(spriteProg);

const uT = {
  cam: gl.getUniformLocation(terrainProg, 'uCam')!,
  zoom: gl.getUniformLocation(terrainProg, 'uZoom')!,
  view: gl.getUniformLocation(terrainProg, 'uView')!,
  tex: gl.getUniformLocation(terrainProg, 'uTex')!,
};
const uS = {
  cam: gl.getUniformLocation(spriteProg, 'uCam')!,
  zoom: gl.getUniformLocation(spriteProg, 'uZoom')!,
  view: gl.getUniformLocation(spriteProg, 'uView')!,
  world: gl.getUniformLocation(spriteProg, 'uWorld')!,
  size: gl.getUniformLocation(spriteProg, 'uSize')!,
  rect: gl.getUniformLocation(spriteProg, 'uRect')!,
  sheet: gl.getUniformLocation(spriteProg, 'uSheet')!,
  tex: gl.getUniformLocation(spriteProg, 'uTex')!,
  maskTex: gl.getUniformLocation(spriteProg, 'uMaskTex')!,
  maskRect: gl.getUniformLocation(spriteProg, 'uMaskRect')!,
  maskSheet: gl.getUniformLocation(spriteProg, 'uMaskSheet')!,
  hasMask: gl.getUniformLocation(spriteProg, 'uHasMask')!,
  tint: gl.getUniformLocation(spriteProg, 'uTint')!,
};

gl.enable(gl.BLEND);
gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

// ---- state ------------------------------------------------------------------
let map: MapJson | null = null;
let atlas: Atlas | null = null;          // Tileset atlas (M1 renderer)
let tiles: Uint8Array | null = null;     // mapX*mapY*4: [terrain, height, rot, obj]
let sheetTex: WebGLTexture[] = [];
let terrainVao: WebGLVertexArrayObject | null = null;
let indexCount = 0;

let unitsAtlas: Atlas | null = null;
let unitTex: WebGLTexture[] = [];
let maskTex: WebGLTexture[] = [];
let unitByI: Map<number, AtlasSprite> = new Map();
let specs: UnitSpec[] = [];
let passGrid: PassGrid | null = null;
let sim: Sim | null = null;
let selectedUid = 0;
let frameStats = { frames: 0, unitsDrawn: 0, missingSprites: 0 };

let quadVao: WebGLVertexArrayObject | null = null;
let ringTex: WebGLTexture | null = null;

let camX = 0;
let camY = 0;
let zoom = 1;
let fitZoom = 1;
let viewW = 1;
let viewH = 1;
let dragging = false;
let lastPX = 0;
let lastPY = 0;
let hoverX = -1; // 1-based tile under the cursor, -1 = none
let hoverY = -1;
let acc = 0;          // tick accumulator, ms
let lastFrame = 0;
let flashTimer = 0;

// ---- data helpers -----------------------------------------------------------
async function fetchJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`fetch ${url}: ${r.status} ${r.statusText}`);
  return (await r.json()) as T;
}
async function fetchBytes(url: string): Promise<Uint8Array> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`fetch ${url}: ${r.status} ${r.statusText}`);
  return new Uint8Array(await r.arrayBuffer());
}
async function fetchText(url: string): Promise<string> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`fetch ${url}: ${r.status} ${r.statusText}`);
  return await r.text();
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function loadTexture(url: string): Promise<WebGLTexture> {
  const blob = await (await fetch(url)).blob();
  const bmp = await createImageBitmap(blob);
  const tex = gl!.createTexture()!;
  gl!.bindTexture(gl!.TEXTURE_2D, tex);
  gl!.texImage2D(gl!.TEXTURE_2D, 0, gl!.RGBA8, gl!.RGBA, gl!.UNSIGNED_BYTE, bmp);
  gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MIN_FILTER, gl!.NEAREST);
  gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MAG_FILTER, gl!.NEAREST);
  gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_S, gl!.CLAMP_TO_EDGE);
  gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_T, gl!.CLAMP_TO_EDGE);
  bmp.close();
  return tex;
}

/** Height byte of tile (tX,tY), 1-based; out-of-map reads are 0 (M1 section 2.3). */
function cornerHeight(tX: number, tY: number): number {
  if (map === null || tiles === null) return 0;
  if (tX < 1 || tY < 1 || tX > map.mapX || tY > map.mapY) return 0;
  return tiles[((tY - 1) * map.mapX + (tX - 1)) * 4 + 1];
}

/** Bilinear terrain height shift (px) at a world point (spec 5: visual check only). */
function terrainHeightPx(wx: number, wy: number): number {
  const gx = Math.floor(wx / CELL);
  const gy = Math.floor(wy / CELL);
  const fx = wx / CELL - gx;
  const fy = wy / CELL - gy;
  const tX = gx + 1;
  const tY = gy + 1;
  const tl = cornerHeight(tX, tY);
  const tr = cornerHeight(tX + 1, tY);
  const bl = cornerHeight(tX, tY + 1);
  const br = cornerHeight(tX + 1, tY + 1);
  const h = tl * (1 - fx) * (1 - fy) + tr * fx * (1 - fy) + bl * (1 - fx) * fy + br * fx * fy;
  return h * PX_PER_HEIGHT;
}

// ---- terrain VBO (copied from mapdemo.ts, section 4.2/2.3) ------------------
/** One static vertex buffer: per tile 4 verts of (x,y,u,v) floats + 6 uint32 indices. */
function buildTerrainVbo(byI: Map<number, AtlasSprite>): void {
  if (map === null || atlas === null || tiles === null) return;
  const mx = map.mapX;
  const my = map.mapY;
  const n = mx * my;
  const verts = new Float32Array(n * 16);
  const inds = new Uint32Array(n * 6);
  let v = 0;
  let missing = 0;

  for (let ty = 1; ty <= my; ty++) {
    for (let tx = 1; tx <= mx; tx++) {
      const off = ((ty - 1) * mx + (tx - 1)) * 4;
      const terrain = tiles[off];
      const rot = tiles[off + 2] & 3; // original maps store raw rot > 3 (section 2.1); render uses rot & 3

      // Sprite for terrain id t is the atlas entry with i == t (section 2.3 errata 2026-10-16: the game
      // binds gGFXData[rxTiles, terrain+1] and atlas i = game render id - 1).
      let u1 = 0;
      let v1 = 0;
      let u2 = 0;
      let v2 = 0;
      const sp = byI.get(terrain);
      if (sp !== undefined) {
        const sheet = atlas.sheets[sp.s]!;
        u1 = sp.x / sheet.w;
        v1 = sp.y / sheet.h;
        u2 = (sp.x + sp.w) / sheet.w;
        v2 = (sp.y + sp.h) / sheet.h;
      } else {
        missing++;
      }

      // GetTileUV: TexO 1..4 = 1,2,3,4; rot&1 -> 4-1-2-3; rot&2 -> swap 1<->3 and 2<->4.
      const order = [0, 1, 2, 3];
      if ((rot & 1) !== 0) {
        const a = order[3];
        order[3] = order[2];
        order[2] = order[1];
        order[1] = order[0];
        order[0] = a;
      }
      if ((rot & 2) !== 0) {
        let a = order[0];
        order[0] = order[2];
        order[2] = a;
        a = order[1];
        order[1] = order[3];
        order[3] = a;
      }
      const base = [[u1, v1], [u1, v2], [u2, v2], [u2, v1]];
      const uv: number[][] = [[0, 0], [0, 0], [0, 0], [0, 0]];
      for (let k = 0; k < 4; k++) uv[order[k]] = base[k];

      // World corners TL,BL,BR,TR with the per-corner height shift (section 2.3).
      const x0 = (tx - 1) * CELL;
      const x1 = tx * CELL;
      const y0 = (ty - 1) * CELL;
      const y1 = ty * CELL;
      const xs = [x0, x0, x1, x1];
      const ys = [
        y0 - cornerHeight(tx, ty) * PX_PER_HEIGHT,
        y1 - cornerHeight(tx, ty + 1) * PX_PER_HEIGHT,
        y1 - cornerHeight(tx + 1, ty + 1) * PX_PER_HEIGHT,
        y0 - cornerHeight(tx + 1, ty) * PX_PER_HEIGHT,
      ];
      for (let k = 0; k < 4; k++) {
        verts[v++] = xs[k];
        verts[v++] = ys[k];
        verts[v++] = uv[k][0];
        verts[v++] = uv[k][1];
      }

      // Indices TL,BL,BR + TL,TR,BR (same winding as UpdateVBO, lines 437-442).
      const b = ((ty - 1) * mx + (tx - 1)) * 4;
      const io = ((ty - 1) * mx + (tx - 1)) * 6;
      inds[io] = b;
      inds[io + 1] = b + 1;
      inds[io + 2] = b + 2;
      inds[io + 3] = b;
      inds[io + 4] = b + 3;
      inds[io + 5] = b + 2;
    }
  }
  if (missing > 0) console.warn(`play: ${missing} tiles have no atlas sprite (drawn as zero UV)`);

  terrainVao = gl!.createVertexArray()!;
  gl!.bindVertexArray(terrainVao);
  const vbo = gl!.createBuffer()!;
  gl!.bindBuffer(gl!.ARRAY_BUFFER, vbo);
  gl!.bufferData(gl!.ARRAY_BUFFER, verts, gl!.STATIC_DRAW);
  const ebo = gl!.createBuffer()!;
  gl!.bindBuffer(gl!.ELEMENT_ARRAY_BUFFER, ebo);
  gl!.bufferData(gl!.ELEMENT_ARRAY_BUFFER, inds, gl!.STATIC_DRAW);
  const aPos = gl!.getAttribLocation(terrainProg, 'aPos');
  gl!.enableVertexAttribArray(aPos);
  gl!.vertexAttribPointer(aPos, 2, gl!.FLOAT, false, 16, 0);
  const aUV = gl!.getAttribLocation(terrainProg, 'aUV');
  gl!.enableVertexAttribArray(aUV);
  gl!.vertexAttribPointer(aUV, 2, gl!.FLOAT, false, 16, 8);
  gl!.bindVertexArray(null);
  indexCount = n * 6;
}

/** Shared 0..1 quad for sprites and the selection ring. */
function buildQuad(): void {
  quadVao = gl!.createVertexArray()!;
  gl!.bindVertexArray(quadVao);
  const vbo = gl!.createBuffer()!;
  gl!.bindBuffer(gl!.ARRAY_BUFFER, vbo);
  gl!.bufferData(gl!.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl!.STATIC_DRAW);
  const aPos = gl!.getAttribLocation(spriteProg, 'aPos');
  gl!.enableVertexAttribArray(aPos);
  gl!.vertexAttribPointer(aPos, 2, gl!.FLOAT, false, 0, 0);
  gl!.bindVertexArray(null);
}

/** Procedural white ellipse-ring texture (placeholder until the GUI art pass, spec 5). */
function buildRingTexture(): WebGLTexture {
  const w = 64;
  const h = 32;
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const nx = (x + 0.5 - w / 2) / (w / 2 - 2);
      const ny = (y + 0.5 - h / 2) / (h / 2 - 2);
      const q = nx * nx + ny * ny;
      const t = 1 - Math.abs(q - 0.81) / 0.19;
      const a = q >= 0.62 && q <= 1.0 ? Math.round(200 * Math.min(1, t * 2)) : 0;
      const i = (y * w + x) * 4;
      px[i] = 255;
      px[i + 1] = 255;
      px[i + 2] = 255;
      px[i + 3] = a;
    }
  }
  const tex = gl!.createTexture()!;
  gl!.bindTexture(gl!.TEXTURE_2D, tex);
  gl!.texImage2D(gl!.TEXTURE_2D, 0, gl!.RGBA8, w, h, 0, gl!.RGBA, gl!.UNSIGNED_BYTE, px);
  gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MIN_FILTER, gl!.LINEAR);
  gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MAG_FILTER, gl!.LINEAR);
  gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_S, gl!.CLAMP_TO_EDGE);
  gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_T, gl!.CLAMP_TO_EDGE);
  return tex;
}

// ---- camera (M1 section 4.2) ------------------------------------------------
/** Fit the whole map into the viewport and centre on it. */
function resetView(): void {
  if (map === null) return;
  const mw = map.mapX * CELL;
  const mh = map.mapY * CELL;
  fitZoom = Math.min(viewW / mw, viewH / mh);
  zoom = fitZoom;
  camX = mw / 2;
  camY = mh / 2;
  hoverX = -1;
  hoverY = -1;
}

// Wheel zoom clamps to 0.25..8, except that fitting a 128x128 map needs less than 0.25 on a small
// viewport; the fit stays reachable at the low end (M1 accepted deviation 1).
function zoomLimits(): { min: number; max: number } {
  return { min: Math.min(MIN_ZOOM, fitZoom), max: MAX_ZOOM };
}

function worldToScreen(wx: number, wy: number): { x: number; y: number } {
  return { x: (wx - camX) * zoom + viewW / 2, y: (wy - camY) * zoom + viewH / 2 };
}

function screenToWorld(sx: number, sy: number): { x: number; y: number } {
  return { x: camX + (sx - viewW / 2) / zoom, y: camY + (sy - viewH / 2) / zoom };
}

/** Tile under a canvas css point (mapdemo's tileAt, pure): the topmost drawn quad containing
 *  the point (row-major draw order, so the largest tY among the candidates wins). */
function tileAtPoint(sx: number, sy: number): { x: number; y: number } | null {
  if (map === null) return null;
  const wx = camX + (sx - viewW / 2) / zoom;
  const wy = camY + (sy - viewH / 2) / zoom;
  const gx = Math.floor(wx / CELL);
  const gy = Math.floor(wy / CELL);
  if (gx < 0 || gx >= map.mapX) return null;
  const fx = wx / CELL - gx;
  const end = Math.min(gy + 8, map.mapY - 1);
  let hit: { x: number; y: number } | null = null;
  for (let ty = Math.max(gy, 0); ty <= end; ty++) {
    const y0 = ty * CELL;
    const y1 = y0 + CELL;
    const top = (y0 - cornerHeight(gx + 1, ty + 1) * PX_PER_HEIGHT) * (1 - fx) + (y0 - cornerHeight(gx + 2, ty + 1) * PX_PER_HEIGHT) * fx;
    const bottom = (y1 - cornerHeight(gx + 1, ty + 2) * PX_PER_HEIGHT) * (1 - fx) + (y1 - cornerHeight(gx + 2, ty + 2) * PX_PER_HEIGHT) * fx;
    const lo = Math.min(top, bottom);
    const hi = Math.max(top, bottom);
    if (wy >= lo && wy <= hi) hit = { x: gx + 1, y: ty + 1 };
  }
  return hit;
}

// ---- units (spec 5) ---------------------------------------------------------
function selectedUnit(): SimUnit | null {
  if (sim === null || selectedUid === 0) return null;
  return sim.units.find((u) => u.uid === selectedUid) ?? null;
}

/** Unit anchor: world px at (posF + UNIT_OFF) * 40 minus the terrain height shift. */
function unitAnchor(u: SimUnit): { x: number; y: number } {
  const wx = (u.posF.x + UNIT_OFF_X) * CELL;
  const wy = (u.posF.y + UNIT_OFF_Y) * CELL;
  return { x: wx, y: wy - terrainHeightPx(wx, wy) };
}

/** Atlas sprite for the unit's current frame: walk loop while walking, still frame when stay. */
function spriteFor(u: SimUnit): AtlasSprite | undefined {
  const spec: UnitSpec | undefined = specs[u.type];
  if (spec === undefined) return undefined;
  const dir = u.dir >= 1 && u.dir <= 8 ? u.dir : 1;
  const loop = walkLoop(spec, dir);
  if (loop.count <= 0) return undefined;
  const idx = u.action === 'walk' ? u.animStep % loop.count : (UNIT_STILL_FRAMES[u.dir] ?? 0) % loop.count;
  const stored: number | undefined = loop.steps[idx];
  if (stored === undefined || stored < 0) return undefined;
  return unitByI.get(stored + SPRITE_ID_ADD);
}

/** Sprite centre on screen (css px, canvas-relative) — the select hit test point. */
function unitSpriteCenterScreen(u: SimUnit): { x: number; y: number } | null {
  const sp = spriteFor(u);
  if (sp === undefined) return null;
  const a = unitAnchor(u);
  return worldToScreen(a.x + sp.px + sp.w / 2, a.y + sp.py + sp.h / 2);
}

function tintFor(u: SimUnit): { tint: [number, number, number]; useMask: boolean } {
  const tint = OWNER_TINTS[u.owner % OWNER_TINTS.length]!;
  return { tint, useMask: u.owner % OWNER_TINTS.length !== 0 };
}

function drawUnit(u: SimUnit): boolean {
  const sp = spriteFor(u);
  if (sp === undefined || unitsAtlas === null) return false;
  const a = unitAnchor(u);
  const { tint, useMask } = tintFor(u);
  const sheet = unitsAtlas.sheets[sp.s]!;

  gl!.uniform2f(uS.world, a.x + sp.px, a.y + sp.py);
  gl!.uniform2f(uS.size, sp.w, sp.h);
  gl!.uniform4f(uS.rect, sp.x, sp.y, sp.w, sp.h);
  gl!.uniform2f(uS.sheet, sheet.w, sheet.h);
  gl!.activeTexture(gl!.TEXTURE0);
  gl!.bindTexture(gl!.TEXTURE_2D, unitTex[sp.s]!);
  gl!.uniform1i(uS.tex, 0);

  const hasMask = useMask && sp.ms >= 0 && sp.ms < maskTex.length;
  gl!.uniform1f(uS.hasMask, hasMask ? 1 : 0);
  if (hasMask) {
    const ms = unitsAtlas.maskSheets[sp.ms]!;
    gl!.activeTexture(gl!.TEXTURE1);
    gl!.bindTexture(gl!.TEXTURE_2D, maskTex[sp.ms]!);
    gl!.uniform1i(uS.maskTex, 1);
    gl!.uniform4f(uS.maskRect, sp.mx, sp.my, sp.w, sp.h);
    gl!.uniform2f(uS.maskSheet, ms.w, ms.h);
  }
  gl!.uniform3f(uS.tint, tint[0], tint[1], tint[2]);
  gl!.drawArrays(gl!.TRIANGLE_STRIP, 0, 4);
  return true;
}

/** White ellipse ring under the selected unit (placeholder, spec 5). */
function drawRing(u: SimUnit): void {
  if (ringTex === null) return;
  const a = unitAnchor(u);
  const rw = 40;
  const rh = 20;
  gl!.uniform2f(uS.world, a.x - rw / 2, a.y - rh / 2);
  gl!.uniform2f(uS.size, rw, rh);
  gl!.uniform4f(uS.rect, 0, 0, 64, 32);
  gl!.uniform2f(uS.sheet, 64, 32);
  gl!.uniform1f(uS.hasMask, 0);
  gl!.uniform3f(uS.tint, 1, 1, 1);
  gl!.activeTexture(gl!.TEXTURE0);
  gl!.bindTexture(gl!.TEXTURE_2D, ringTex);
  gl!.uniform1i(uS.tex, 0);
  gl!.drawArrays(gl!.TRIANGLE_STRIP, 0, 4);
}

// ---- render -----------------------------------------------------------------
function render(): void {
  if (map === null || terrainVao === null) return;
  const dpr = window.devicePixelRatio || 1;
  const cssW = cv.clientWidth;
  const cssH = cv.clientHeight;
  if (cv.width !== Math.round(cssW * dpr) || cv.height !== Math.round(cssH * dpr)) {
    cv.width = Math.round(cssW * dpr);
    cv.height = Math.round(cssH * dpr);
  }
  gl!.viewport(0, 0, cv.width, cv.height);
  viewW = cssW;
  viewH = cssH;
  gl!.clearColor(0x20 / 255, 0x28 / 255, 0x30 / 255, 1);
  gl!.clear(gl!.COLOR_BUFFER_BIT);

  // Terrain: one drawElements (M1 renderer).
  gl!.useProgram(terrainProg);
  gl!.uniform2f(uT.cam, camX, camY);
  gl!.uniform1f(uT.zoom, zoom);
  gl!.uniform2f(uT.view, viewW, viewH);
  gl!.activeTexture(gl!.TEXTURE0);
  gl!.bindTexture(gl!.TEXTURE_2D, sheetTex[0]!);
  gl!.uniform1i(uT.tex, 0);
  gl!.bindVertexArray(terrainVao);
  gl!.drawElements(gl!.TRIANGLES, indexCount, gl!.UNSIGNED_INT, 0);
  gl!.bindVertexArray(null);

  // Units: ring first, then sprites sorted by anchor y (painter's order).
  let drawn = 0;
  let missing = 0;
  if (sim !== null && unitsAtlas !== null && quadVao !== null) {
    gl!.useProgram(spriteProg);
    gl!.uniform2f(uS.cam, camX, camY);
    gl!.uniform1f(uS.zoom, zoom);
    gl!.uniform2f(uS.view, viewW, viewH);
    gl!.bindVertexArray(quadVao);
    const sel = selectedUnit();
    if (sel !== null) drawRing(sel);
    const order = sim.units.slice().sort((a, b) => unitAnchor(a).y - unitAnchor(b).y);
    for (const u of order) {
      if (drawUnit(u)) drawn++;
      else missing++;
    }
    gl!.bindVertexArray(null);
  }
  frameStats = { frames: frameStats.frames + 1, unitsDrawn: drawn, missingSprites: missing };
  updateHud();
}

function updateHud(): void {
  if (map === null) return;
  const lines = [`${map.file}  ${map.mapX}\u00d7${map.mapY}  zoom=${zoom.toFixed(3)}  cam=(${Math.round(camX)},${Math.round(camY)})`];
  if (hoverX >= 1 && hoverY >= 1 && tiles !== null) {
    const off = ((hoverY - 1) * map.mapX + (hoverX - 1)) * 4;
    const walk = passGrid === null ? '?' : tileWalkable(passGrid, hoverX, hoverY) ? 'walk' : 'blocked';
    lines.push(`tile (${hoverX},${hoverY}) index=${(hoverY - 1) * map.mapX + (hoverX - 1)} terrain=${tiles[off]} rot=${tiles[off + 2]} height=${tiles[off + 1]} obj=${tiles[off + 3]} ${walk}`);
  } else {
    lines.push('tile (-,-) move the pointer over the map');
  }
  const sel = selectedUnit();
  let line = `tick=${sim === null ? 0 : sim.tickCount} units=${sim === null ? 0 : sim.units.length} selected=${sel === null ? '-' : sel.uid}`;
  if (sel !== null) line += ` type=${sel.type} action=${sel.action} pos=(${sel.posF.x.toFixed(2)},${sel.posF.y.toFixed(2)})`;
  lines.push(line);
  hud.textContent = lines.join('\n');
}

function flashHud(): void {
  hud.classList.remove('flash');
  void hud.offsetWidth; // restart the CSS animation
  hud.classList.add('flash');
  window.clearTimeout(flashTimer);
  flashTimer = window.setTimeout(() => hud.classList.remove('flash'), 600);
}

function showError(err: unknown): void {
  errBox.textContent = String(err instanceof Error ? err.stack ?? err.message : err);
}

// ---- input (spec 5) ---------------------------------------------------------
function selectAt(sx: number, sy: number): void {
  if (sim === null) return;
  let best: SimUnit | null = null;
  let bestDist = SELECT_RADIUS_PX;
  for (const u of sim.units) {
    const p = unitSpriteCenterScreen(u);
    if (p === null) continue;
    const d = Math.hypot(p.x - sx, p.y - sy);
    if (d <= bestDist) {
      bestDist = d;
      best = u;
    }
  }
  selectedUid = best === null ? 0 : best.uid; // else deselects
}

/** Right-click order: walk to the tile under the cursor; flash red when findPath is null. */
function orderWalkAt(vx: number, vy: number): void {
  if (sim === null || passGrid === null) return;
  const u = selectedUnit();
  if (u === null) return; // nothing selected: no order, no flash
  const r = cv.getBoundingClientRect();
  const tile = tileAtPoint(vx - r.left, vy - r.top);
  if (tile === null) return;
  const from = { x: Math.round(u.posF.x), y: Math.round(u.posF.y) };
  if (findPath(passGrid, from, tile) === null) {
    flashHud();
    return;
  }
  if (!sim.orderWalk(u.uid, tile.x, tile.y)) flashHud();
}

function bindInput(): void {
  let downX = 0;
  let downY = 0;
  cv.addEventListener('pointerdown', (e) => {
    if (e.button === 2) {
      orderWalkAt(e.clientX, e.clientY);
      return;
    }
    if (e.button !== 0) return;
    dragging = true;
    downX = e.clientX;
    downY = e.clientY;
    cv.setPointerCapture(e.pointerId);
    cv.classList.add('drag');
    lastPX = e.clientX;
    lastPY = e.clientY;
  });
  cv.addEventListener('pointermove', (e) => {
    const r = cv.getBoundingClientRect();
    if (dragging) {
      camX -= (e.clientX - lastPX) / zoom;
      camY -= (e.clientY - lastPY) / zoom;
      lastPX = e.clientX;
      lastPY = e.clientY;
    }
    const t = tileAtPoint(e.clientX - r.left, e.clientY - r.top);
    hoverX = t === null ? -1 : t.x;
    hoverY = t === null ? -1 : t.y;
  });
  cv.addEventListener('pointerup', (e) => {
    if (e.button !== 0 || !dragging) return;
    dragging = false;
    cv.classList.remove('drag');
    const r = cv.getBoundingClientRect();
    if (Math.hypot(e.clientX - downX, e.clientY - downY) < 5) {
      selectAt(e.clientX - r.left, e.clientY - r.top);
    }
  });
  cv.addEventListener('pointercancel', () => {
    dragging = false;
    cv.classList.remove('drag');
  });
  cv.addEventListener('pointerleave', () => {
    if (dragging) return;
    hoverX = -1;
    hoverY = -1;
  });
  cv.addEventListener('contextmenu', (e) => e.preventDefault());
  cv.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (map === null) return;
    const limits = zoomLimits();
    const next = Math.min(limits.max, Math.max(limits.min, zoom * (e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP)));
    if (next === zoom) return;
    const r = cv.getBoundingClientRect();
    const sx = e.clientX - r.left;
    const sy = e.clientY - r.top;
    const wx = camX + (sx - viewW / 2) / zoom; // world point under the cursor stays fixed
    const wy = camY + (sy - viewH / 2) / zoom;
    zoom = next;
    camX = wx - (sx - viewW / 2) / zoom;
    camY = wy - (sy - viewH / 2) / zoom;
  }, { passive: false });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'r' || e.key === 'R') {
      resetView();
      return;
    }
    const n = Number(e.key);
    if (n >= 1 && n <= 3 && sim !== null) {
      const u: SimUnit | undefined = sim.units[n - 1];
      if (u !== undefined) {
        const a = unitAnchor(u);
        camX = a.x; // keys 1/2/3 jump to the spawn units (spec 5)
        camY = a.y;
      }
    }
  });
}

// ---- tick loop: 10 ticks/s, catch-up <= 5 (spec 5) --------------------------
function frame(now: number): void {
  try {
    acc += now - lastFrame;
    lastFrame = now;
    if (sim !== null) {
      let steps = 0;
      while (acc >= TICK_MS && steps < MAX_CATCHUP) {
        sim.tick();
        acc -= TICK_MS;
        steps++;
      }
      if (acc > TICK_MS * MAX_CATCHUP) acc = 0; // drop the backlog after a long stall
    } else {
      acc = 0;
    }
    render();
  } catch (err) {
    showError(err);
  }
  requestAnimationFrame(frame);
}

// ---- test hook (read-only; the CDP proof script drives the page through it) --
function installHook(): void {
  const hook = {
    TICK_MS,
    tick: () => (sim === null ? -1 : sim.tickCount),
    units: () => (sim === null ? [] : sim.units),
    unitOf: (uid: number) => (sim === null ? null : sim.units.find((u) => u.uid === uid) ?? null),
    selectedUid: () => selectedUid,
    frameStats: () => ({ ...frameStats }),
    zoom: () => zoom,
    cam: () => ({ x: camX, y: camY }),
    /** World px -> viewport css px (what CDP Input.dispatchMouseEvent wants). */
    viewportOf: (wx: number, wy: number) => {
      const r = cv.getBoundingClientRect();
      const p = worldToScreen(wx, wy);
      return { x: r.left + p.x, y: r.top + p.y };
    },
    /** Unit sprite centre -> viewport css px, or null when it has no sprite. */
    viewportOfUnit: (uid: number) => {
      const u = sim === null ? undefined : sim.units.find((x) => x.uid === uid);
      if (u === undefined) return null;
      const p = unitSpriteCenterScreen(u);
      if (p === null) return null;
      const r = cv.getBoundingClientRect();
      return { x: r.left + p.x, y: r.top + p.y };
    },
    /** The same resolver the input uses, in viewport css px. */
    tileAtViewport: (vx: number, vy: number) => {
      const r = cv.getBoundingClientRect();
      return tileAtPoint(vx - r.left, vy - r.top);
    },
    tileWalkable: (x: number, y: number) => (passGrid === null ? false : tileWalkable(passGrid, x, y)),
    findPath: (from: { x: number; y: number }, to: { x: number; y: number }) =>
      passGrid === null ? null : findPath(passGrid, from, to),
    spriteOf: (uid: number) => {
      const u = sim === null ? undefined : sim.units.find((x) => x.uid === uid);
      return u === undefined ? null : spriteFor(u) ?? null;
    },
  };
  (window as unknown as Record<string, unknown>).__kamplay = hook;
}

// ---- boot -------------------------------------------------------------------
async function boot(): Promise<void> {
  const [mapData, tilesetData, unitsData, tilesText, mapelemBuf, unitdatBuf] = await Promise.all([
    fetchJson<MapJson>('/out/maps/TownTutorial.json'),
    fetchJson<Atlas>('/out/atlas/Tileset.json'),
    fetchJson<Atlas>('/out/atlas/Units.json'),
    fetchText('/defines/tiles.json'),
    fetchBytes('/defines/mapelem.dat'),
    fetchBytes('/defines/unit.dat'),
  ]);

  map = mapData;
  atlas = tilesetData;
  unitsAtlas = unitsData;
  tiles = base64ToBytes(mapData.tiles);

  specs = parseUnitDat(unitdatBuf);
  const tileFlags = parseTilesJson(tilesText);
  const elems = parseMapElem(mapelemBuf);
  passGrid = buildPassGrid(
    {
      file: mapData.file, mapX: mapData.mapX, mapY: mapData.mapY, tiles,
      remake: false, tail: { resHead: null, mapEdChunk: false, tailBytes: 0 },
    },
    tileFlags,
    elems,
  );

  const simLocal = new Sim(passGrid, specs);
  sim = simLocal;
  const spawns = demoSpawns(passGrid);
  for (let i = 0; i < spawns.length; i++) {
    const s = spawns[i]!;
    simLocal.addUnit(s.type, s.x, s.y, i); // owner i: 0 default, others tinted (spec 5)
  }

  sheetTex = await Promise.all(tilesetData.sheets.map((s) => loadTexture(`/out/atlas/${s.file}`)));
  unitTex = await Promise.all(unitsData.sheets.map((s) => loadTexture(`/out/atlas/${s.file}`)));
  maskTex = await Promise.all((unitsData.maskSheets ?? []).map((s) => loadTexture(`/out/atlas/${s.file}`)));
  unitByI = new Map();
  for (const sp of unitsData.sprites) unitByI.set(sp.i, sp);
  const tileByI = new Map<number, AtlasSprite>();
  for (const sp of tilesetData.sprites) tileByI.set(sp.i, sp);
  buildTerrainVbo(tileByI);
  buildQuad();
  ringTex = buildRingTexture();

  viewW = cv.clientWidth;
  viewH = cv.clientHeight;
  resetView();
  bindInput();
  installHook();
  lastFrame = performance.now();
  requestAnimationFrame(frame);
}

window.addEventListener('error', (e) => showError(e.error ?? e.message));
window.addEventListener('unhandledrejection', (e) => showError(e.reason));
boot().catch(showError);
