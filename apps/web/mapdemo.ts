// mapdemo.ts — M1 terrain viewer (docs/M1-SPIKE.md section 4.2) + M3b any-map loading.
// Loads the frozen TownTutorial export (out/maps/TownTutorial.json) + the Tileset atlas by default;
// /map.html?kind=MapsMP&name=Arena (or the picker, key M, list from /maps) loads any scanned map's
// .map through /mapfile/<kind>/<name>/map instead (apps/web/mapread.ts walks the bytes).
// Builds ONE static VBO for all map tiles (4 verts / 6 indices each) and draws them with a single
// drawElements per frame; the camera is a uniform (translate + scale). The overlay pass draws the
// map's stored overlays: toRoad via the connectivity table, toDig1..4 as sprites 249/251/253/255
// plain rot 0 (docs/M3B-SPIKE.md section 5; mission !SET_STREET roads are the play viewer's job —
// this terrain viewer has no mission script).
//
// World/UV math is the frozen section 2.3 (KM_RenderTerrain.pas RenderQuadTexture, 2D branch,
// GetTileUV; CELL_SIZE_PX = 40, CELL_HEIGHT_DIV = 33.333):
//   tile (tX,tY) 1-based covers [tX-1..tX] x [tY-1..tY] * 40 px; corner heights
//   TL=[tY,tX], BL=[tY+1,tX], BR=[tY+1,tX+1], TR=[tY,tX+1], each vertex y -= h * 40/33.333;
//   reads outside the map = 0. UV corners TL,BL,BR,TR = (u1,v1),(u1,v2),(u2,v2),(u2,v1) from the
//   atlas sprite with i == terrain (errata 2026-10-16: the game binds gGFXData[rxTiles, terrain+1]
//   and atlas i = game render id - 1), permuted by rot&3 (rot&1 -> 4-1-2-3, rot&2 -> swap 1<->3, 2<->4).
// Drag pans, wheel zooms at the cursor (1.5x per notch), R resets to fit, M opens the picker.
// Kept dependency-free on purpose (mapread.ts is the only import); transpiled by serve.ts as a
// module graph into out/web/apps/web/mapdemo.js + mapread.js.

import { parseMapBytes } from './mapread.ts';

interface MapJson { file: string; mapX: number; mapY: number; tiles: string }
interface MapMeta { file: string; mapX: number; mapY: number }
interface MapInfoView { kind: string; name: string; mapX: number; mapY: number; remake: boolean; rev: number; maxPlayers: number; tactic: boolean }
interface AtlasSheet { file: string; w: number; h: number }
interface AtlasSprite { i: number; w: number; h: number; s: number; x: number; y: number }
interface Atlas { pack: string; sheets: AtlasSheet[]; sprites: AtlasSprite[] }

const CELL = 40;            // CELL_SIZE_PX (KM_Defaults.pas line 13)
const HEIGHT_DIV = 33.333;  // CELL_HEIGHT_DIV (line 14): screen shift px = height * 40 / 33.333 = *1.2
const PX_PER_HEIGHT = CELL / HEIGHT_DIV;
const ZOOM_STEP = 1.5;      // per wheel notch
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 8;

// RoadsConnectivity[0..15] = (atlas i, rot); bits N=1, E=2, S=4, W=8 (KM_RenderTerrain.pas:808-812).
const ROADS_CONNECTIVITY: [number, number][] = [
  [248, 0], [248, 0], [248, 1], [250, 3], [248, 0], [248, 0], [250, 0], [252, 0],
  [248, 1], [250, 2], [248, 1], [252, 3], [250, 1], [252, 2], [252, 1], [254, 0],
];
// TILE_OVERLAY_IDS (KM_TerrainTypes.pas:176) as atlas i: toDig1..4 -> 249/251/253/255, plain rot 0.
const DIG_OVERLAY_IDS: number[] = [0, 249, 251, 253, 255];

const cv = document.getElementById('cv') as HTMLCanvasElement;
const hud = document.getElementById('hud') as HTMLDivElement;
const errBox = document.getElementById('err') as HTMLDivElement;
const pickerEl = document.getElementById('picker') as HTMLDivElement;
const pickerListEl = document.getElementById('pickerlist') as HTMLDivElement;
const pickerCountEl = document.getElementById('pickercount') as HTMLSpanElement;
const filterEl = document.getElementById('filter') as HTMLInputElement;
const gl = cv.getContext('webgl2', { alpha: false });
if (gl === null) throw new Error('webgl2 unavailable');

// ---- shader program ---------------------------------------------------------
// Position + UV come from the VBO; the shader needs only the camera uniform.
const VS = `#version 300 es
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
const FS = `#version 300 es
precision mediump float;
in vec2 vUV;
uniform sampler2D uTex;
out vec4 outColor;
void main() { outColor = texture(uTex, vUV); }`;

function compile(type: number, src: string): WebGLShader {
  const sh = gl!.createShader(type)!;
  gl!.shaderSource(sh, src);
  gl!.compileShader(sh);
  if (!gl!.getShaderParameter(sh, gl!.COMPILE_STATUS)) {
    throw new Error(`shader: ${gl!.getShaderInfoLog(sh)}`);
  }
  return sh;
}
const prog = gl.createProgram()!;
gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS));
gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS));
gl.linkProgram(prog);
if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(`link: ${gl.getProgramInfoLog(prog)}`);
gl.useProgram(prog);

const u = {
  cam: gl.getUniformLocation(prog, 'uCam')!,
  zoom: gl.getUniformLocation(prog, 'uZoom')!,
  view: gl.getUniformLocation(prog, 'uView')!,
  tex: gl.getUniformLocation(prog, 'uTex')!,
};

gl.enable(gl.BLEND);
gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

// ---- state ------------------------------------------------------------------
let map: MapMeta | null = null;
let atlas: Atlas | null = null;
let tiles: Uint8Array | null = null; // mapX*mapY*4: [terrain, height, rot, obj]
let overlay: Uint8Array | null = null; // per-tile TileOverlay (Remake maps; zeros for standard)
let baseTerrain: Uint16Array | null = null; // true terrain ids (Remake Word; null = use the byte)
let mapSource: { kind: string; name: string } | null = null; // null = Town Tutorial
let mapRev = 0;
let mapRemake = false;
let mapList: MapInfoView[] = [];
let loadToken = 0;
let sheetTex: WebGLTexture[] = [];
let vao: WebGLVertexArrayObject | null = null;
let indexCount = 0;
let vaoBuffers: WebGLBuffer[] = [];
let overlayVao: WebGLVertexArrayObject | null = null;
let overlayIndexCount = 0;
let overlayBuffers: WebGLBuffer[] = [];
let roadQuadCount = 0;
let digQuadCount = 0;
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

/** Height byte of tile (tX,tY), 1-based; out-of-map reads are 0 (section 2.3). */
function cornerHeight(tX: number, tY: number): number {
  if (map === null || tiles === null) return 0;
  if (tX < 1 || tY < 1 || tX > map.mapX || tY > map.mapY) return 0;
  return tiles[((tY - 1) * map.mapX + (tX - 1)) * 4 + 1];
}

/** UV rect of the atlas sprite with i == id, or zero UVs when missing. */
function spriteUv(byI: Map<number, AtlasSprite>, id: number): { u1: number; v1: number; u2: number; v2: number } {
  const sp = byI.get(id);
  if (sp === undefined || atlas === null) return { u1: 0, v1: 0, u2: 0, v2: 0 };
  const sheet = atlas.sheets[sp.s]!;
  return { u1: sp.x / sheet.w, v1: sp.y / sheet.h, u2: (sp.x + sp.w) / sheet.w, v2: (sp.y + sp.h) / sheet.h };
}

/** The rot&3 UV permutation (GetTileUV): rot&1 -> 4-1-2-3, rot&2 -> swap 1<->3 and 2<->4. */
function rotatedUv(uv: { u1: number; v1: number; u2: number; v2: number }, rot: number): number[][] {
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
  const base = [[uv.u1, uv.v1], [uv.u1, uv.v2], [uv.u2, uv.v2], [uv.u2, uv.v1]];
  const out: number[][] = [[0, 0], [0, 0], [0, 0], [0, 0]];
  for (let k = 0; k < 4; k++) out[order[k]!] = base[k]!;
  return out;
}

/** One static vertex buffer: per tile 4 verts of (x,y,u,v) floats + 6 uint32 indices. */
function buildVbo(byI: Map<number, AtlasSprite>): void {
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
      const terrain = baseTerrain !== null ? baseTerrain[off >> 2]! : tiles[off]!;
      const rot = tiles[off + 2]! & 3; // original maps store raw rot > 3 (section 2.1); render uses rot & 3
      // Sprite for terrain id t is the atlas entry with i == t (section 2.3 errata 2026-10-16: the game
      // binds gGFXData[rxTiles, terrain+1] and atlas i = game render id - 1).
      // A tile with no sprite keeps zero UVs (samples nothing visible).
      const uv0 = spriteUv(byI, terrain);
      if (!byI.has(terrain)) missing++;
      const uv = rotatedUv(uv0, rot);

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
        verts[v++] = xs[k]!;
        verts[v++] = ys[k]!;
        verts[v++] = uv[k]![0]!;
        verts[v++] = uv[k]![1]!;
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
  if (missing > 0) console.warn(`mapdemo: ${missing} tiles have no atlas sprite (drawn as zero UV)`);

  for (const b of vaoBuffers) gl!.deleteBuffer(b);
  if (vao !== null) gl!.deleteVertexArray(vao);
  vao = gl!.createVertexArray()!;
  gl!.bindVertexArray(vao);
  const vbo = gl!.createBuffer()!;
  vaoBuffers = [vbo];
  gl!.bindBuffer(gl!.ARRAY_BUFFER, vbo);
  gl!.bufferData(gl!.ARRAY_BUFFER, verts, gl!.STATIC_DRAW);
  const ebo = gl!.createBuffer()!;
  vaoBuffers.push(ebo);
  gl!.bindBuffer(gl!.ELEMENT_ARRAY_BUFFER, ebo);
  gl!.bufferData(gl!.ELEMENT_ARRAY_BUFFER, inds, gl!.STATIC_DRAW);
  const aPos = gl!.getAttribLocation(prog, 'aPos');
  gl!.enableVertexAttribArray(aPos);
  gl!.vertexAttribPointer(aPos, 2, gl!.FLOAT, false, 16, 0);
  const aUV = gl!.getAttribLocation(prog, 'aUV');
  gl!.enableVertexAttribArray(aUV);
  gl!.vertexAttribPointer(aUV, 2, gl!.FLOAT, false, 16, 8);
  gl!.bindVertexArray(null);
  indexCount = n * 6;
}

/**
 * Overlay pass (docs/M3B-SPIKE.md section 5): the map's stored overlays only —
 *  - toRoad tiles draw their connectivity sprite from the neighbor mask N=1,E=2,S=4,W=8;
 *  - toDig1..toDig4 draw 249/251/253/255 plain, rot 0.
 * (Mission !SET_STREET roads are drawn by the play viewer, which parses the .dat; this terrain
 * viewer does not — documented v0.)
 */
function buildOverlayVbo(byI: Map<number, AtlasSprite>): void {
  if (map === null || atlas === null || overlay === null) return;
  const mx = map.mapX;
  const my = map.mapY;
  const stride = mx + 1;
  const isRoad = (x: number, y: number): boolean => overlay![(y - 1) * mx + (x - 1)] === 5;
  const quads: { x: number; y: number; id: number; rot: number }[] = [];
  let roads = 0;

  for (let y = 1; y <= my; y++) {
    for (let x = 1; x <= mx; x++) {
      const ov = overlay[(y - 1) * mx + (x - 1)]!;
      if (ov === 5) {
        let mask = 0;
        if (y - 1 >= 1 && isRoad(x, y - 1)) mask += 1;        // N
        if (x + 1 <= mx - 1 && isRoad(x + 1, y)) mask += 2;   // E
        if (y + 1 <= my - 1 && isRoad(x, y + 1)) mask += 4;   // S
        if (x - 1 >= 1 && isRoad(x - 1, y)) mask += 8;        // W
        const entry = ROADS_CONNECTIVITY[mask]!;
        quads.push({ x, y, id: entry[0], rot: entry[1] });
        roads++;
      } else if (ov >= 1 && ov <= 4) {
        quads.push({ x, y, id: DIG_OVERLAY_IDS[ov]!, rot: 0 });
      }
    }
  }
  roadQuadCount = roads;
  digQuadCount = quads.length - roads;

  const verts = new Float32Array(quads.length * 16);
  const inds = new Uint32Array(quads.length * 6);
  let v = 0;
  let q = 0;
  let missing = 0;
  for (const item of quads) {
    const tx = item.x;
    const ty = item.y;
    const uv0 = spriteUv(byI, item.id);
    if (!byI.has(item.id)) missing++;
    const uv = rotatedUv(uv0, item.rot & 3);

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
      verts[v++] = xs[k]!;
      verts[v++] = ys[k]!;
      verts[v++] = uv[k]![0]!;
      verts[v++] = uv[k]![1]!;
    }
    const b = q * 4;
    inds[q * 6] = b;
    inds[q * 6 + 1] = b + 1;
    inds[q * 6 + 2] = b + 2;
    inds[q * 6 + 3] = b;
    inds[q * 6 + 4] = b + 3;
    inds[q * 6 + 5] = b + 2;
    q++;
  }
  if (missing > 0) console.warn(`mapdemo: ${missing} overlay sprites missing from the Tileset atlas`);

  for (const b of overlayBuffers) gl!.deleteBuffer(b);
  if (overlayVao !== null) gl!.deleteVertexArray(overlayVao);
  overlayVao = gl!.createVertexArray()!;
  gl!.bindVertexArray(overlayVao);
  const vbo = gl!.createBuffer()!;
  overlayBuffers = [vbo];
  gl!.bindBuffer(gl!.ARRAY_BUFFER, vbo);
  gl!.bufferData(gl!.ARRAY_BUFFER, verts, gl!.STATIC_DRAW);
  const ebo = gl!.createBuffer()!;
  overlayBuffers.push(ebo);
  gl!.bindBuffer(gl!.ELEMENT_ARRAY_BUFFER, ebo);
  gl!.bufferData(gl!.ELEMENT_ARRAY_BUFFER, inds, gl!.STATIC_DRAW);
  const aPos = gl!.getAttribLocation(prog, 'aPos');
  gl!.enableVertexAttribArray(aPos);
  gl!.vertexAttribPointer(aPos, 2, gl!.FLOAT, false, 16, 0);
  const aUV = gl!.getAttribLocation(prog, 'aUV');
  gl!.enableVertexAttribArray(aUV);
  gl!.vertexAttribPointer(aUV, 2, gl!.FLOAT, false, 16, 8);
  gl!.bindVertexArray(null);
  overlayIndexCount = q * 6;
}

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

// Wheel zoom clamps to 0.25..8 (section 4.2), except that fitting a 128x128 map needs less than
// 0.25 on a small viewport (e.g. 0.156 at 800 px tall); the fit stays reachable at the low end.
function zoomLimits(): { min: number; max: number } {
  return { min: Math.min(MIN_ZOOM, fitZoom), max: MAX_ZOOM };
}

function render(): void {
  if (map === null || vao === null) return;
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
  gl!.uniform2f(u.cam, camX, camY);
  gl!.uniform1f(u.zoom, zoom);
  gl!.uniform2f(u.view, viewW, viewH);
  gl!.activeTexture(gl!.TEXTURE0);
  gl!.bindTexture(gl!.TEXTURE_2D, sheetTex[0]!); // Tileset.0.png: the atlas has exactly one sheet
  gl!.uniform1i(u.tex, 0);
  gl!.clearColor(0x20 / 255, 0x28 / 255, 0x30 / 255, 1);
  gl!.clear(gl!.COLOR_BUFFER_BIT);
  gl!.bindVertexArray(vao);
  gl!.drawElements(gl!.TRIANGLES, indexCount, gl!.UNSIGNED_INT, 0);
  if (overlayVao !== null && overlayIndexCount > 0) {
    gl!.bindVertexArray(overlayVao);
    gl!.drawElements(gl!.TRIANGLES, overlayIndexCount, gl!.UNSIGNED_INT, 0);
  }
  gl!.bindVertexArray(null);
  updateHud();
}

function updateHud(): void {
  if (map === null) return;
  const src = mapSource === null ? 'Town Tutorial (tutorial)' : `${mapSource.kind}/${mapSource.name}`;
  const fmt = mapRemake ? `Remake r${mapRev}` : 'Standard';
  const lines = [`${src}  ${map.mapX}\u00d7${map.mapY} ${fmt}  zoom=${zoom.toFixed(3)}  cam=(${Math.round(camX)},${Math.round(camY)})`];
  if (hoverX >= 1 && hoverY >= 1 && tiles !== null) {
    const off = ((hoverY - 1) * map.mapX + (hoverX - 1)) * 4;
    const ov = overlay === null ? 0 : overlay[(hoverY - 1) * map.mapX + (hoverX - 1)]!;
    lines.push(`tile (${hoverX},${hoverY}) index=${(hoverY - 1) * map.mapX + (hoverX - 1)} terrain=${tiles[off]} rot=${tiles[off + 2]} height=${tiles[off + 1]} obj=${tiles[off + 3]} overlay=${ov}`);
  } else {
    lines.push('tile (-,-) move the pointer over the map');
  }
  lines.push(`roads=${roadQuadCount} digs=${digQuadCount}`);
  hud.textContent = lines.join('\n');
}

/** Tile under a canvas css point: the topmost drawn quad containing the point (row-major draw order,
 *  so the largest tY among the candidates wins — the same tile the pixel visually belongs to).
 *  x never shifts, so only column gx can be under the cursor; a tile in row ty >= gy reaches a point
 *  in row gy because the height shift moves it up (max 255*1.2 px ~ 7.65 tiles, so gy..gy+8). */
function tileAt(sx: number, sy: number): void {
  if (map === null) return;
  hoverX = -1;
  hoverY = -1;
  const wx = camX + (sx - viewW / 2) / zoom;
  const wy = camY + (sy - viewH / 2) / zoom;
  const gx = Math.floor(wx / CELL);
  const gy = Math.floor(wy / CELL);
  if (gx < 0 || gx >= map.mapX) return;
  const fx = wx / CELL - gx;
  const end = Math.min(gy + 8, map.mapY - 1);
  for (let ty = Math.max(gy, 0); ty <= end; ty++) {
    const y0 = ty * CELL;
    const y1 = y0 + CELL;
    const top = (y0 - cornerHeight(gx + 1, ty + 1) * PX_PER_HEIGHT) * (1 - fx) + (y0 - cornerHeight(gx + 2, ty + 1) * PX_PER_HEIGHT) * fx;
    const bottom = (y1 - cornerHeight(gx + 1, ty + 2) * PX_PER_HEIGHT) * (1 - fx) + (y1 - cornerHeight(gx + 2, ty + 2) * PX_PER_HEIGHT) * fx;
    const lo = Math.min(top, bottom);
    const hi = Math.max(top, bottom);
    if (wy >= lo && wy <= hi) {
      hoverX = gx + 1;
      hoverY = ty + 1;
    }
  }
}

// ---- M3b picker (bonus for the terrain viewer) ------------------------------
function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderPickerList(): void {
  const q = filterEl.value.trim().toLowerCase();
  const items = mapList.filter((m) => q === '' || m.name.toLowerCase().includes(q));
  pickerCountEl.textContent = `${items.length}/${mapList.length}`;
  const rows: string[] = [
    '<button class="maprow tutorial" data-tutorial="1"><b>Town Tutorial</b> <span class="dim">128\u00d7128 tutorial</span></button>',
  ];
  for (const m of items) {
    const fmt = m.remake ? `Remake r${m.rev}` : 'Standard';
    rows.push(
      `<button class="maprow" data-kind="${escHtml(m.kind)}" data-name="${escHtml(m.name)}">` +
        `<b>${escHtml(m.name)}</b> <span class="dim">${m.mapX}\u00d7${m.mapY} ${m.maxPlayers}P ${fmt} ${m.tactic ? 'tactic' : 'building'}</span></button>`,
    );
  }
  pickerListEl.innerHTML = rows.join('');
}

function openPicker(): void {
  pickerEl.classList.remove('closed');
  renderPickerList();
  filterEl.focus();
  filterEl.select();
}
function closePicker(): void {
  pickerEl.classList.add('closed');
}
function togglePicker(): void {
  if (pickerEl.classList.contains('closed')) openPicker();
  else closePicker();
}

function setUrlMap(kind: string | null, name: string | null): void {
  const url = new URL(location.href);
  if (kind === null || name === null) {
    url.searchParams.delete('kind');
    url.searchParams.delete('name');
  } else {
    url.searchParams.set('kind', kind);
    url.searchParams.set('name', name);
  }
  history.replaceState(null, '', url.toString());
}

// ---- loading ----------------------------------------------------------------
async function loadTutorial(): Promise<void> {
  const token = ++loadToken;
  const mapData = await fetchJson<MapJson>('/out/maps/TownTutorial.json');
  if (token !== loadToken) return;
  mapSource = null;
  mapRev = 0;
  mapRemake = false;
  map = { file: mapData.file, mapX: mapData.mapX, mapY: mapData.mapY };
  const bin = atob(mapData.tiles);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  tiles = bytes;
  baseTerrain = null;
  overlay = new Uint8Array(mapData.mapX * mapData.mapY);
  finishLoad();
}

async function loadScannedMap(kind: string, name: string): Promise<void> {
  const token = ++loadToken;
  const base = `/mapfile/${encodeURIComponent(kind)}/${encodeURIComponent(name)}`;
  const bytes = await fetchBytes(`${base}/map`);
  if (token !== loadToken) return;
  const lm = parseMapBytes(bytes, `${kind}/${name}`);
  mapSource = { kind, name };
  mapRev = lm.rev;
  mapRemake = lm.remake;
  map = { file: `${name}.map`, mapX: lm.mapX, mapY: lm.mapY };
  tiles = lm.tiles;
  baseTerrain = lm.baseTerrain;
  overlay = lm.overlay;
  finishLoad();
}

function finishLoad(): void {
  if (atlas === null) return;
  const byI = new Map<number, AtlasSprite>();
  for (const sp of atlas.sprites) byI.set(sp.i, sp);
  buildVbo(byI);
  buildOverlayVbo(byI);
  viewW = cv.clientWidth;
  viewH = cv.clientHeight;
  resetView();
  errBox.textContent = '';
  render();
}

async function switchTo(kind: string, name: string): Promise<void> {
  try {
    await loadScannedMap(kind, name);
    setUrlMap(kind, name);
  } catch (err) {
    showError(err);
  }
}

async function switchToTutorial(): Promise<void> {
  try {
    await loadTutorial();
    setUrlMap(null, null);
  } catch (err) {
    showError(err);
  }
}

// ---- controls ---------------------------------------------------------------
function bindInput(): void {
  cv.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    dragging = true;
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
    tileAt(e.clientX - r.left, e.clientY - r.top);
    render();
  });
  const endDrag = (): void => {
    dragging = false;
    cv.classList.remove('drag');
  };
  cv.addEventListener('pointerup', endDrag);
  cv.addEventListener('pointercancel', endDrag);
  cv.addEventListener('pointerleave', () => {
    if (dragging) return;
    hoverX = -1;
    hoverY = -1;
    render();
  });
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
    tileAt(sx, sy);
    render();
  }, { passive: false });
  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement) {
      if (e.key === 'Escape') closePicker();
      return;
    }
    if (e.key === 'm' || e.key === 'M') {
      e.preventDefault(); // keep the "m" out of the filter box openPicker just focused
      togglePicker();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      closePicker();
      return;
    }
    if (e.key === 'r' || e.key === 'R') {
      resetView();
      render();
    }
  });
  window.addEventListener('resize', () => render());
  filterEl.addEventListener('input', renderPickerList);
  pickerListEl.addEventListener('click', (e) => {
    const el = (e.target as HTMLElement).closest('button.maprow');
    if (el === null) return;
    closePicker();
    if (el.getAttribute('data-tutorial') === '1') {
      void switchToTutorial();
      return;
    }
    const kind = el.getAttribute('data-kind');
    const name = el.getAttribute('data-name');
    if (kind !== null && name !== null) void switchTo(kind, name);
  });
}

function showError(err: unknown): void {
  errBox.textContent = String(err instanceof Error ? err.stack ?? err.message : err);
}

// ---- boot -------------------------------------------------------------------
async function boot(): Promise<void> {
  const [atlasData, mapsJson] = await Promise.all([
    fetchJson<Atlas>('/out/atlas/Tileset.json'),
    fetchJson<MapInfoView[]>('/maps'),
  ]);
  atlas = atlasData;
  mapList = mapsJson
    .slice()
    .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'Maps' ? -1 : 1));
  sheetTex = await Promise.all(atlasData.sheets.map((s) => loadTexture(`/out/atlas/${s.file}`)));

  const params = new URLSearchParams(location.search);
  const kind = params.get('kind');
  const name = params.get('name');
  if (kind !== null && name !== null) {
    try {
      await loadScannedMap(kind, name);
    } catch (err) {
      showError(err);
      await loadTutorial();
    }
  } else {
    await loadTutorial();
  }
  bindInput();

  const hook = {
    mapInfo: () =>
      map === null
        ? null
        : {
            source: mapSource,
            file: map.file,
            mapX: map.mapX,
            mapY: map.mapY,
            remake: mapRemake,
            rev: mapRev,
            roads: roadQuadCount,
            digs: digQuadCount,
            loaded: loadToken,
          },
    pickerOpen: () => !pickerEl.classList.contains('closed'),
    pickerMaps: () => mapList.length,
    pickerToggle: () => togglePicker(),
    pickerFilter: (q: string) => {
      filterEl.value = q;
      renderPickerList();
    },
    loadMap: (kind: string, name: string) => switchTo(kind, name),
    loadTutorial: () => switchToTutorial(),
    zoom: () => zoom,
    cam: () => ({ x: camX, y: camY }),
    tileAtViewport: (vx: number, vy: number) => {
      const r = cv.getBoundingClientRect();
      tileAt(vx - r.left, vy - r.top);
      return hoverX >= 1 && hoverY >= 1 ? { x: hoverX, y: hoverY } : null;
    },
  };
  (window as unknown as Record<string, unknown>).__kammap = hook;
}

window.addEventListener('error', (e) => showError(e.error ?? e.message));
window.addEventListener('unhandledrejection', (e) => showError(e.reason));
boot().catch(showError);
