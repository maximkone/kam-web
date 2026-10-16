// mapdemo.ts — M1 terrain viewer (docs/M1-SPIKE.md section 4.2).
// Loads the frozen TownTutorial export (out/maps/TownTutorial.json) + the Tileset atlas,
// builds ONE static VBO for all map tiles (4 verts / 6 indices each, ~16384 tiles) and draws
// them with a single drawElements per frame; the camera is a uniform (translate + scale).
//
// World/UV math is the frozen section 2.3 (KM_RenderTerrain.pas RenderQuadTexture, 2D branch,
// GetTileUV; CELL_SIZE_PX = 40, CELL_HEIGHT_DIV = 33.333):
//   tile (tX,tY) 1-based covers [tX-1..tX] x [tY-1..tY] * 40 px; corner heights
//   TL=[tY,tX], BL=[tY+1,tX], BR=[tY+1,tX+1], TR=[tY,tX+1], each vertex y -= h * 40/33.333;
//   reads outside the map = 0. UV corners TL,BL,BR,TR = (u1,v1),(u1,v2),(u2,v2),(u2,v1) from the
//   atlas sprite with i == terrain+1, permuted by rot&3 (rot&1 -> 4-1-2-3, rot&2 -> swap 1<->3, 2<->4).
// Drag pans, wheel zooms at the cursor (1.5x per notch), R resets to fit. Kept dependency-free
// on purpose; transpiled to /apps/web/mapdemo.js by serve.ts.

interface MapJson { file: string; mapX: number; mapY: number; tiles: string }
interface AtlasSheet { file: string; w: number; h: number }
interface AtlasSprite { i: number; w: number; h: number; s: number; x: number; y: number }
interface Atlas { pack: string; sheets: AtlasSheet[]; sprites: AtlasSprite[] }

const CELL = 40;            // CELL_SIZE_PX (KM_Defaults.pas line 13)
const HEIGHT_DIV = 33.333;  // CELL_HEIGHT_DIV (line 14): screen shift px = height * 40 / 33.333 = *1.2
const PX_PER_HEIGHT = CELL / HEIGHT_DIV;
const ZOOM_STEP = 1.5;      // per wheel notch
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 8;

const cv = document.getElementById('cv') as HTMLCanvasElement;
const hud = document.getElementById('hud') as HTMLDivElement;
const errBox = document.getElementById('err') as HTMLDivElement;
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
let map: MapJson | null = null;
let atlas: Atlas | null = null;
let tiles: Uint8Array | null = null; // mapX*mapY*4: [terrain, height, rot, obj]
let sheetTex: WebGLTexture[] = [];
let vao: WebGLVertexArrayObject | null = null;
let indexCount = 0;
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
      const terrain = tiles[off];
      const rot = tiles[off + 2] & 3; // original maps store raw rot > 3 (section 2.1); render uses rot & 3

      // Sprite for terrain id t is the atlas entry with i == t + 1 (section 2.3).
      // A tile with no sprite keeps zero UVs (samples nothing visible); the towns have all of them.
      let u1 = 0;
      let v1 = 0;
      let u2 = 0;
      let v2 = 0;
      const sp = byI.get(terrain + 1);
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
      // UV corners of the unrotated quad, TL,BL,BR,TR; Result[TexO[k]] = base[k].
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
  if (missing > 0) console.warn(`mapdemo: ${missing} tiles have no atlas sprite (drawn as zero UV)`);

  vao = gl!.createVertexArray()!;
  gl!.bindVertexArray(vao);
  const vbo = gl!.createBuffer()!;
  gl!.bindBuffer(gl!.ARRAY_BUFFER, vbo);
  gl!.bufferData(gl!.ARRAY_BUFFER, verts, gl!.STATIC_DRAW);
  const ebo = gl!.createBuffer()!;
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
  gl!.bindVertexArray(vao);
  gl!.clearColor(0x20 / 255, 0x28 / 255, 0x30 / 255, 1);
  gl!.clear(gl!.COLOR_BUFFER_BIT);
  gl!.drawElements(gl!.TRIANGLES, indexCount, gl!.UNSIGNED_INT, 0);
  updateHud();
}

function updateHud(): void {
  if (map === null) return;
  const lines = [`${map.file}  ${map.mapX}\u00d7${map.mapY}  zoom=${zoom.toFixed(3)}  cam=(${Math.round(camX)},${Math.round(camY)})`];
  if (hoverX >= 1 && hoverY >= 1 && tiles !== null) {
    const off = ((hoverY - 1) * map.mapX + (hoverX - 1)) * 4;
    lines.push(`tile (${hoverX},${hoverY}) index=${(hoverY - 1) * map.mapX + (hoverX - 1)} terrain=${tiles[off]} rot=${tiles[off + 2]} height=${tiles[off + 1]} obj=${tiles[off + 3]}`);
  } else {
    lines.push('tile (-,-) move the pointer over the map');
  }
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
    if (e.key === 'r' || e.key === 'R') {
      resetView();
      render();
    }
  });
  window.addEventListener('resize', () => render());
}

// ---- boot -------------------------------------------------------------------
async function boot(): Promise<void> {
  const mapData: MapJson = await (await fetch('/out/maps/TownTutorial.json')).json();
  const atlasData: Atlas = await (await fetch('/out/atlas/Tileset.json')).json();
  map = mapData;
  atlas = atlasData;

  const bin = atob(mapData.tiles);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  tiles = bytes;

  sheetTex = await Promise.all(atlasData.sheets.map((s) => loadTexture(`/out/atlas/${s.file}`)));
  const byI = new Map<number, AtlasSprite>();
  for (const sp of atlasData.sprites) byI.set(sp.i, sp);
  buildVbo(byI);

  viewW = cv.clientWidth;
  viewH = cv.clientHeight;
  resetView();
  bindInput();
  render();
}

boot().catch((err: unknown) => {
  errBox.textContent = String(err instanceof Error ? err.stack ?? err.message : err);
});
