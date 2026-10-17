// game/game.ts — B1 game shell (setup -> skirmish -> end). Uses the existing play.ts renderer hook.
// Import paths keep .ts for node build; serve.ts rewrites them to .js for the browser.
import { createSkirmish, step, skirmishStatus, humanHands } from '../../../packages/sim/skirmish.ts';
import type { Skirmish, SkirmishSlot, SkirmishDefines, SkirmishStatus } from '../../../packages/sim/skirmish.ts';
import { parseMapFileBytes } from '../../../packages/map/map.ts';
import type { KaMap } from '../../../packages/map/map.ts';
import { AI_START_LEVELS, isAiStartLevel } from '../../../packages/sim/aistart.ts';
import type { AiStartLevel } from '../../../packages/sim/aistart.ts';
import { createUi } from '../ui/ui.ts';
import type { GameUi, PlayView } from '../ui/ui.ts';
import { installGameTest } from '../ui/gametest.ts';

const MAP_LIST_URL = '/maps';
const TICK_MS = 100; // 10 ticks/s

interface MapInfoView {
  kind: string; name: string; mapX: number; mapY: number; remake: boolean; rev: number;
  maxPlayers: number; tactic: boolean; smallDesc: string; valid: boolean;
}

// debug/test counters (read by tools/uicheck): how many loops were started, frames drawn, sim steps run
const stats = { starts: 0, frames: 0, steps: 0 };
(window as any).__gameStats = stats;

let sk: Skirmish | null = null;
let speedMult = 1;
let paused = false;
let tickAcc = 0;
let lastFrame = 0;
let running = false;
let startTimeMs = 0;
let endScreenActive = false;
let ui: GameUi | null = null; // B2A: the game UI (input router, panels, minimap, command queue)
(window as any).__gameSk = (): Skirmish | null => sk; // debug/test: the running skirmish (tools/uicheck/b1.ts reads its AI slot)

interface MatchSetup {
  aiStart: AiStartLevel;
  peaceMinutes: number;
}

// ---- DOM refs ----
const setupEl = document.getElementById('setup')!;
const maplistEl = document.getElementById('maplist')!;
const filterEl = document.getElementById('filter')! as HTMLInputElement;
const slottbl = document.getElementById('slottbl')!;
const startbtn = document.getElementById('startbtn')! as HTMLButtonElement;
const peaceEl = document.getElementById('peace')! as HTMLSelectElement;
const mapnameEl = document.getElementById('mapname')!;
const tickEl = document.getElementById('tick')!;
const timeEl = document.getElementById('time')!;
const stockEl = document.getElementById('stock')!;
const pausebtn = document.getElementById('pausebtn')! as HTMLButtonElement;
const speedbtn = document.getElementById('speedbtn')! as HTMLButtonElement;
const endbtn = document.getElementById('endbtn')! as HTMLButtonElement;
const endEl = document.getElementById('end')!;
const endtitle = document.getElementById('endtitle')!;
const endreason = document.getElementById('endreason')!;
const endstats = document.getElementById('endstats')!;
const backbtn = document.getElementById('backbtn')! as HTMLButtonElement;

// ---- Setup screen ----
async function loadMapList(): Promise<MapInfoView[]> {
  const r = await fetch(MAP_LIST_URL);
  if (!r.ok) throw new Error(`maps: ${r.status}`);
  return r.json() as Promise<MapInfoView[]>;
}

function renderMapList(maps: MapInfoView[]): void {
  const q = filterEl.value.trim().toLowerCase();
  const items = maps.filter((m) => q === '' || m.name.toLowerCase().includes(q));
  const rows: string[] = [];
  for (const m of items) {
    const fmt = m.remake ? `Remake r${m.rev}` : 'Standard';
    rows.push(`<button class="maprow" data-kind="${m.kind}" data-name="${m.name}"><b>${escHtml(m.name)}</b> <span class="dim">${m.mapX}×${m.mapY} ${m.maxPlayers}P ${fmt}</span></button>`);
  }
  maplistEl.innerHTML = rows.join('');
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderSlots(): void {
  const levels = AI_START_LEVELS.map((l) => `<option value="${l}"${l === 'normal' ? ' selected' : ''}>${l}</option>`).join('');
  const rows = [
    `<tr><td>0</td><td>Human</td><td>-</td><td>-</td><td>0</td><td>0</td></tr>`,
    `<tr><td>1</td><td>AI (Advanced)</td><td>advanced</td><td><select id="aistart" aria-label="AI start">${levels}</select></td><td>1</td><td>1</td></tr>`,
  ];
  slottbl.innerHTML = rows.join('');
}

function readSetup(): MatchSetup {
  const aiVal = (document.getElementById('aistart') as HTMLSelectElement).value;
  return { aiStart: isAiStartLevel(aiVal) ? aiVal : 'normal', peaceMinutes: Number(peaceEl.value) };
}

// ---- Game loop ----
function startGame(kind: string, name: string): void {
  stats.starts++;
  setupEl.classList.add('hide');
  endEl.classList.add('hide');
  endScreenActive = false;
  running = true;
  paused = false;
  speedMult = 1;
  tickAcc = 0;
  startTimeMs = performance.now();
  lastFrame = performance.now(); // must be set BEFORE the first frame, or the first frame catches up thousands of ticks
  updateTop();
  (function loopFrame(now: number) {
    if (!running) return;
    stats.frames++;
    if (!endScreenActive) {
      // performance.now(), NOT the rAF timestamp: a headless/virtual-time browser advances the rAF timestamp by a synthetic
      // 16.7 ms per frame while frames run far faster than that, which made the sim run ~10x too fast.
      const wall = performance.now();
      tickAcc += (wall - lastFrame) * speedMult;
      if (tickAcc > TICK_MS * 20) tickAcc = TICK_MS * 20; // never run more than 20 ticks in one frame (hidden tab, slow AI)
      lastFrame = wall;
      while (tickAcc >= TICK_MS && running && !paused && !endScreenActive) {
        tickAcc -= TICK_MS;
        if (sk !== null) {
          const cmds = ui !== null ? ui.takeCommands(sk.world.tickCount + 1) : [];
          const res = step(sk, cmds);
          if (ui !== null) ui.afterStep(res);
          stats.steps++;
        }
      }
      if (sk !== null && !paused) {
        const st = skirmishStatus(sk);
        if (st.matchOver) showEnd(st);
      }
    }
    if (ui !== null) ui.frame(now);
    updateTop();
    requestAnimationFrame(loopFrame);
  })(performance.now());
}

function updateTop(): void {
  if (sk === null) return;
  const st = skirmishStatus(sk);
  tickEl.textContent = String(st.tick);
  const sec = Math.floor(st.tick / 10); // game time from the tick (10 ticks per second), not the wall clock
  const min = Math.floor(sec / 60);
  const s = sec % 60;
  timeEl.textContent = `${min}:${String(s).padStart(2, '0')}`;
  speedbtn.textContent = speedMult + 'x';
  // the stock row is drawn by the game UI (ui/panels.ts renderStock)
}

function showEnd(st: SkirmishStatus): void {
  endScreenActive = true;
  running = false;
  const h = st.hands.find((h: { kind: string; status: string }) => h.kind === 'human');
  if (h) {
    if (h.status === 'won') {
      endtitle.textContent = 'Victory';
      endreason.textContent = 'Your hand has won.';
    } else if (h.status === 'defeated') {
      endtitle.textContent = 'Defeat';
      endreason.textContent = 'Your hand has been defeated.';
    } else {
      endtitle.textContent = 'Match Over';
      endreason.textContent = `Status: ${h.status}`;
    }
  } else {
    endtitle.textContent = 'Match Over';
    endreason.textContent = 'No human hand.';
  }
  const sec = Math.floor((performance.now() - startTimeMs) / 1000);
  endstats.textContent = `Ticks played: ${st.tick} · Time: ${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
  endEl.classList.remove('hide');
}

// ---- Start flow ----
startbtn.addEventListener('click', () => {
  const btn = maplistEl.querySelector('.maprow.active') as HTMLButtonElement | null;
  if (!btn) return alert('Select a map first');
  const kind = btn.getAttribute('data-kind')!;
  const name = btn.getAttribute('data-name')!;
  void initAndStart(kind, name, readSetup());
});

maplistEl.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('.maprow') as HTMLButtonElement;
  if (btn) {
    document.querySelectorAll('.maprow').forEach((b) => (b as HTMLElement).classList.remove('active'));
    btn.classList.add('active');
  }
});

filterEl.addEventListener('input', () => {
  const maps = (window as any).__mapList as MapInfoView[] | undefined;
  if (maps) renderMapList(maps);
});

backbtn.addEventListener('click', () => {
  endEl.classList.add('hide');
  setupEl.classList.remove('hide');
  running = false;
  sk = null;
  if (ui !== null) ui.detach();
});

pausebtn.addEventListener('click', () => {
  paused = !paused;
  pausebtn.textContent = paused ? 'Resume' : 'Pause';
});

speedbtn.addEventListener('click', () => {
  speedMult = speedMult >= 4 ? 1 : speedMult * 2;
  speedbtn.textContent = speedMult + 'x';
});

endbtn.addEventListener('click', () => {
  if (sk === null) return;
  const st = skirmishStatus(sk);
  if (!st.matchOver) showEnd(st);
});

// ---- Keyboard (only behind ?dev=1; but spec asks for game keys) ----
window.addEventListener('keydown', (e) => {
  if (e.key === ' ' || e.key === 'Spacebar') {
    e.preventDefault();
    paused = !paused;
    pausebtn.textContent = paused ? 'Resume' : 'Pause';
  }
  if (e.key === '+' || e.key === '=') {
    speedMult = Math.min(4, speedMult * 2);
    speedbtn.textContent = speedMult + 'x';
  }
  if (e.key === '-' || e.key === '_') {
    speedMult = Math.max(1, speedMult / 2);
    speedbtn.textContent = speedMult + 'x';
  }
  if (e.key === 'ArrowUp' || e.key === 'w' || e.key === 'W') {
    // Pan handled by play renderer; no direct action needed for B1
  }
});

// ---- Renderer readiness: play.js boots asynchronously (atlases, textures) and publishes window.__kamplay last ----
async function waitForHook(): Promise<any> {
  for (let i = 0; i < 1200; i++) { // up to 120 s
    const h = (window as any).__kamplay;
    if (h && typeof h.attachWorld === 'function') return h;
    await new Promise<void>((r) => setTimeout(r, 100));
  }
  return null;
}

// ---- Initialization ----
async function initAndStart(kind: string, name: string, setup: MatchSetup): Promise<void> {
  const base = `/mapfile/${encodeURIComponent(kind)}/${encodeURIComponent(name)}`;
  const [mapBuf, datBuf] = await Promise.all([
    (await fetch(`${base}/map`)).arrayBuffer().then((b) => new Uint8Array(b)),
    (await fetch(`${base}/dat`)).arrayBuffer().then((b) => new Uint8Array(b)),
  ]);
  const tilesText = await (await fetch('/defines/tiles.json')).text();
  const mapElem = await (await fetch('/defines/mapelem.dat')).arrayBuffer().then((b) => new Uint8Array(b));
  const unitDat = await (await fetch('/defines/unit.dat')).arrayBuffer().then((b) => new Uint8Array(b));
  const housesDat = await (await fetch('/defines/houses.dat')).arrayBuffer().then((b) => new Uint8Array(b));

  const defines: SkirmishDefines = {
    tilesJson: tilesText,
    mapElem,
    unitDat,
    housesDat,
  };

  const slots: SkirmishSlot[] = [
    { hand: 0, kind: 'human' },
    { hand: 1, kind: 'ai', aiLevel: 'advanced', aiStart: setup.aiStart, color: 1 },
  ];

  sk = createSkirmish({
    mapBytes: mapBuf,
    mapPath: `${kind}/${name}.map`,
    missionDat: datBuf,
    defines,
    seed: 1,
    slots,
    peaceMinutes: setup.peaceMinutes,
  });

  // Hook into the play renderer (wait for its async boot to finish)
  const hook = await waitForHook();
  if (hook && typeof hook.attachWorld === 'function') {
    const parsed = parseMapFileBytes(mapBuf, `${kind}/${name}`);
    hook.attachWorld(sk.world, parsed.map, 0);
    mapnameEl.textContent = `${kind}/${name}`;
    if (ui === null) {
      ui = createUi(hook as PlayView, document.getElementById('cv') as HTMLCanvasElement, document.getElementById('ov') as HTMLCanvasElement);
      installGameTest({ sk: () => sk, hand: () => (sk === null ? 0 : humanHands(sk)[0] ?? 0), view: hook as PlayView, ui });
    }
    if (sk !== null) ui.attach(sk, parsed.map);
  } else {
    console.error('No renderer hook found (window.__kamplay.attachWorld)');
    alert('Renderer hook missing — game cannot render. Check play.js load.');
    return;
  }

  // Set up initial camera roughly centered
  try {
    const hook2 = (window as any).__kamplay;
    const myHand = humanHands(sk)[0] ?? 0;
    if (hook2 && typeof hook2.jumpToVillage === 'function') {
      if (!hook2.jumpToVillage(myHand) && typeof hook2.setCam === 'function') hook2.setCam(256, 256, 1);
    }
  } catch {
    // ignore
  }

  startGame(kind, name);
}

// ---- Boot ----
async function boot(): Promise<void> {
  const maps = await loadMapList();
  (window as any).__mapList = maps;
  renderMapList(maps);
  renderSlots();
  setupEl.classList.remove('hide');
  // Start stays disabled until the renderer is ready, so a click can never race its boot.
  startbtn.disabled = true;
  startbtn.textContent = 'Loading renderer...';
  void waitForHook().then((h) => {
    startbtn.disabled = h === null;
    startbtn.textContent = h !== null ? 'Start skirmish' : 'Renderer failed to load';
  });
}

boot().catch((err) => console.error('game boot error:', err));
