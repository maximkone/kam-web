// demo.ts — M0 WebGL2 sprite browser (docs/M0-SPIKE.md section 4).
// Loads out/atlas/<Pack>.json + sheet PNGs, draws one sprite centered at 4x with
// pivot crosshair (G), mask overlay (M), flat/checker background (B).
// Kept dependency-free on purpose; transpiled to /apps/web/demo.js by serve.ts.

interface AtlasSheet { file: string; w: number; h: number }
interface AtlasSprite { i: number; w: number; h: number; px: number; py: number; s: number; x: number; y: number; ms: number; mx: number; my: number }
interface Atlas { pack: string; format: string; count: number; present: number; sheets: AtlasSheet[]; maskSheets: AtlasSheet[]; sprites: AtlasSprite[] }

const SCALE = 4; // integer sprite-pixel scale, per spec

const cv = document.getElementById('cv') as HTMLCanvasElement;
const packSel = document.getElementById('pack') as HTMLSelectElement;
const idxInput = document.getElementById('idx') as HTMLInputElement;
const hud = document.getElementById('hud') as HTMLDivElement;
const errBox = document.getElementById('err') as HTMLDivElement;
const gl = cv.getContext('webgl2', { alpha: false });
if (gl === null) throw new Error('webgl2 unavailable');

// ---- shader program ---------------------------------------------------------
// One program, three modes: 0 = texture, 1 = solid tint, 2 = checkerboard.
const VS = `#version 300 es
in vec2 aPos;
uniform vec2 uOrigin;   // sprite top-left, css px
uniform vec2 uSize;     // sprite size, css px
uniform vec2 uView;     // viewport, css px
out vec2 vPos;
void main() {
  vec2 css = uOrigin + aPos * uSize;
  gl_Position = vec4(css.x / uView.x * 2.0 - 1.0, 1.0 - css.y / uView.y * 2.0, 0.0, 1.0);
  vPos = aPos;
}`;
const FS = `#version 300 es
precision mediump float;
in vec2 vPos;
uniform int uMode;
uniform sampler2D uTex;
uniform vec4 uPxRect;  // x, y, w, h in sheet pixels
uniform vec2 uSheet;   // sheet size, px
uniform vec4 uTint;
out vec4 outColor;
void main() {
  if (uMode == 1) { outColor = uTint; return; }
  if (uMode == 2) {
    float c = mod(floor(gl_FragCoord.x / 16.0) + floor(gl_FragCoord.y / 16.0), 2.0);
    outColor = vec4(mix(vec3(0.16), vec3(0.23), c), 1.0);
    return;
  }
  vec2 uv = (uPxRect.xy + vPos * uPxRect.zw) / uSheet;
  outColor = texture(uTex, uv) * uTint;
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
const prog = gl.createProgram()!;
gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS));
gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS));
gl.linkProgram(prog);
if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(`link: ${gl.getProgramInfoLog(prog)}`);
gl.useProgram(prog);

const u = {
  origin: gl.getUniformLocation(prog, 'uOrigin')!,
  size: gl.getUniformLocation(prog, 'uSize')!,
  view: gl.getUniformLocation(prog, 'uView')!,
  mode: gl.getUniformLocation(prog, 'uMode')!,
  tex: gl.getUniformLocation(prog, 'uTex')!,
  pxRect: gl.getUniformLocation(prog, 'uPxRect')!,
  sheet: gl.getUniformLocation(prog, 'uSheet')!,
  tint: gl.getUniformLocation(prog, 'uTint')!,
};

const vao = gl.createVertexArray()!;
gl.bindVertexArray(vao);
const vbo = gl.createBuffer()!;
gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
const aPos = gl.getAttribLocation(prog, 'aPos');
gl.enableVertexAttribArray(aPos);
gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

gl.enable(gl.BLEND);
gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

// ---- state ------------------------------------------------------------------
let atlas: Atlas | null = null;
let sheetTex: (WebGLTexture | null)[] = [];
let maskTex: (WebGLTexture | null)[] = [];
let cursor = 0; // position in atlas.sprites
let showCross = true;
let showMask = false;
let checker = false;
let playTimer: number | null = null;
let viewW = 1;
let viewH = 1;

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

async function loadPack(name: string): Promise<void> {
  stopPlay();
  atlas = null;
  for (const t of [...sheetTex, ...maskTex]) if (t !== null) gl!.deleteTexture(t);
  sheetTex = []; maskTex = [];

  const data: Atlas = await (await fetch(`/out/atlas/${name}.json`)).json();
  atlas = data;
  sheetTex = await Promise.all(data.sheets.map((s) => loadTexture(`/out/atlas/${s.file}`)));
  maskTex = await Promise.all(data.maskSheets.map((s) => loadTexture(`/out/atlas/${s.file}`)));
  cursor = 0;
  render();
}

// ---- drawing ----------------------------------------------------------------
function quad(x: number, y: number, w: number, h: number): void {
  gl!.uniform2f(u.origin, x, y);
  gl!.uniform2f(u.size, w, h);
  gl!.drawArrays(gl!.TRIANGLE_STRIP, 0, 4);
}

function drawSprite(tex: WebGLTexture, sheet: AtlasSheet, rect: [number, number, number, number], x: number, y: number, w: number, h: number, tint: [number, number, number, number]): void {
  gl!.uniform1i(u.mode, 0);
  gl!.activeTexture(gl!.TEXTURE0);
  gl!.bindTexture(gl!.TEXTURE_2D, tex);
  gl!.uniform1i(u.tex, 0);
  gl!.uniform4f(u.pxRect, rect[0], rect[1], rect[2], rect[3]);
  gl!.uniform2f(u.sheet, sheet.w, sheet.h);
  gl!.uniform4f(u.tint, tint[0], tint[1], tint[2], tint[3]);
  quad(x, y, w, h);
}

function render(): void {
  if (atlas === null) return;
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
  gl!.uniform2f(u.view, viewW, viewH);

  gl!.clearColor(0x20 / 255, 0x28 / 255, 0x30 / 255, 1);
  gl!.clear(gl!.COLOR_BUFFER_BIT);

  if (checker) {
    gl!.uniform1i(u.mode, 2);
    quad(0, 0, viewW, viewH);
  }

  const sp = atlas.sprites[cursor];
  if (sp === undefined) {
    hud.textContent = `pack=${atlas.pack} (no present sprites)`;
    return;
  }
  const snap = (v: number): number => Math.round(v * dpr) / dpr;
  const sw = sp.w * SCALE;
  const sh = sp.h * SCALE;
  const x = snap((viewW - sw) / 2);
  const y = snap((viewH - sh) / 2);

  drawSprite(sheetTex[sp.s]!, atlas.sheets[sp.s]!, [sp.x, sp.y, sp.w, sp.h], x, y, sw, sh, [1, 1, 1, 1]);
  if (showMask && sp.ms >= 0) {
    drawSprite(maskTex[sp.ms]!, atlas.maskSheets[sp.ms]!, [sp.mx, sp.my, sp.w, sp.h], x, y, sw, sh, [1, 1, 1, 0.7]);
  }

  if (showCross) {
    const px = snap(x + sp.px * SCALE);
    const py = snap(y + sp.py * SCALE);
    gl!.uniform1i(u.mode, 1);
    gl!.uniform4f(u.tint, 1, 0.95, 0.2, 0.9);
    quad(px, py - 8, 1, 16);
    quad(px - 8, py, 16, 1);
  }

  hud.textContent =
    `pack=${atlas.pack}\n` +
    `idx=${sp.i}  ${sp.w}x${sp.h}  pivot(${sp.px},${sp.py})  mask=${sp.ms >= 0 ? `yes sheet ${sp.ms}` : 'no'}\n` +
    `sheet ${sp.s} xy=(${sp.x},${sp.y})  atlas ${atlas.present}/${atlas.count} present  pos ${cursor + 1}/${atlas.sprites.length}`;
  idxInput.value = String(sp.i);
}

// ---- controls ---------------------------------------------------------------
function step(delta: number): void {
  if (atlas === null) return;
  cursor = Math.min(Math.max(cursor + delta, 0), atlas.sprites.length - 1);
  render();
}

function gotoIndex(n: number): void {
  if (atlas === null) return;
  let pos = atlas.sprites.findIndex((s) => s.i >= n);
  if (pos === -1) pos = atlas.sprites.length - 1;
  cursor = pos;
  render();
}

function stopPlay(): void {
  if (playTimer !== null) {
    window.clearInterval(playTimer);
    playTimer = null;
    document.getElementById('play')!.classList.remove('on');
  }
}

function togglePlay(): void {
  if (playTimer !== null) {
    stopPlay();
    return;
  }
  document.getElementById('play')!.classList.add('on');
  let left = 8;
  playTimer = window.setInterval(() => {
    if (left-- <= 0) {
      stopPlay();
      return;
    }
    step(1);
  }, 125);
}

async function boot(): Promise<void> {
  const packs: string[] = await (await fetch('/api/packs')).json();
  packSel.innerHTML = '';
  for (const p of packs) {
    const o = document.createElement('option');
    o.value = p;
    o.textContent = p;
    packSel.append(o);
  }
  document.getElementById('prev')!.addEventListener('click', () => step(-1));
  document.getElementById('next')!.addEventListener('click', () => step(1));
  document.getElementById('go')!.addEventListener('click', () => gotoIndex(Number(idxInput.value) || 0));
  idxInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') gotoIndex(Number(idxInput.value) || 0); });
  document.getElementById('play')!.addEventListener('click', togglePlay);
  const tog = (id: string, get: () => boolean, set: (v: boolean) => void): void => {
    document.getElementById(id)!.addEventListener('click', () => {
      set(!get());
      document.getElementById(id)!.classList.toggle('on', get());
      render();
    });
  };
  tog('tc', () => showCross, (v) => { showCross = v; });
  tog('tm', () => showMask, (v) => { showMask = v; });
  tog('tb', () => checker, (v) => { checker = v; });
  window.addEventListener('keydown', (e) => {
    if (e.target === idxInput) return;
    if (e.key === 'ArrowLeft') step(-1);
    else if (e.key === 'ArrowRight') step(1);
    else if (e.key === 'g' || e.key === 'G') { showCross = !showCross; document.getElementById('tc')!.classList.toggle('on', showCross); render(); }
    else if (e.key === 'm' || e.key === 'M') { showMask = !showMask; document.getElementById('tm')!.classList.toggle('on', showMask); render(); }
    else if (e.key === 'b' || e.key === 'B') { checker = !checker; document.getElementById('tb')!.classList.toggle('on', checker); render(); }
  });
  window.addEventListener('resize', () => render());
  packSel.addEventListener('change', () => void loadPack(packSel.value));

  const first = packs.includes('Units') ? 'Units' : packs[0];
  if (first !== undefined) {
    packSel.value = first;
    await loadPack(first);
  }
}

boot().catch((err: unknown) => {
  errBox.textContent = String(err instanceof Error ? err.stack ?? err.message : err);
});
