// play.ts — M3 economy viewer: the Town Tutorial village (docs/M3-SPIKE.md section 5) + the M3b
// any-map picker (docs/M3B-SPIKE.md sections 3 and 5).
//
// Terrain rendering + camera are the M1 mapdemo renderer (copied through the M2b play.ts, which
// stays the ancestor): one static VBO for all tiles, one drawElements, camera as a uniform.
// On top of that this page runs the headless economy sim (packages/sim/economy.ts) on the real
// mission (Town Tutorial.dat): houses, roads, trees, wares and serfs, at 10 ticks/s.
//
// M3b: the page boots the Town Tutorial as before; /play.html?kind=MapsMP&name=Arena (or the map
// picker, key M, list from /maps) loads any scanned map instead. For a scanned map the viewer
// renders terrain + the mission's houses/units/streets as-is, plus the Remake map's stored
// overlays (roads via the connectivity table over overlay toRoad + !SET_STREET; digs 249/251/253/255
// plain rot 0) — the economy world + demo scenario stay tutorial-only (spec section 5). Layered
// tiles draw the base layer only (documented v0 simplification). The .map bytes are walked by
// apps/web/mapread.ts (the browser-side reader of the same frozen KaMap shape).
//
// Frozen interfaces used (docs/M3-SPIKE.md section 3): parseMissionScript, parseHousesDat,
// WARE_CNT/WARE_NAMES/WT_*, parseSerfCarry, createEconomyWorld, applyDemoScenario.
// The viewer additionally parses two tables out of bytes it already has, because the frozen
// interfaces do not carry them (flagged in the worker report):
//  - mapelem.dat Anim loops (Step[1..30] + Count per object) for the rxTrees sprite of every
//    terrain object and the falling-tree animation (KM_RenderPool.pas:581-627);
//  - houses.dat SupplyIn/SupplyOut (record offsets 8/48, 4x5 i16 per house) for the ware stacks
//    (KM_RenderPool.pas:878-949; spec 2.2/2.9).
//
// Sprite ids: atlas `i` = game render id - 1 (M1 errata 2026-10-16). Unit walk loop step value IS
// the atlas i; a tile object's sprite is Anim.Step[step]; a house is StonePic (complete) / WoodPic.
//
// Two documented viewer-side choices (the frozen EconomyWorld has no order API and no falling list):
//  - click-to-move for hand-0 units without a task is a VIEWER-side walk (startWalk/walkTick on
//    world.grid, queued and applied at the end of the next tick like M2b's Sim.orderWalk); the sim
//    owns every other unit. A `walk`/`speed` field is mirrored onto the live EconUnit objects for
//    the M2b CDP hooks, and never overwrites a field the sim itself defines.
//  - falling trees are detected from the sim state (stump object + TreeAge > 0, spec 2.4) and drawn
//    with the fall object's non-looping steps; the animation start tick is the tick the viewer first
//    saw the stump, so the fall anim can lag the sim by up to one tick.
//
// M4 (docs/M4-SPIKE.md section 5): the combat viewer. FOW dims the world by the human hand's
// revelation (world.fow[hand], toggle key F; the render copy's RENDER_RADIUS_ADD = 5 is not
// exposed by the frozen FogOfWar interface, so the sim revelation itself is drawn — the accepted
// section 2.7 approximation). Warriors draw the uaWork fight loop (KM_UnitWarrior.pas:754) and the
// uaDie sequence (KM_UnitTaskDie.pas:85-86); arrows/bolts/sling rocks draw the shooter's uaSpec
// loop along the Paint() parabola (KM_Projectiles.pas:362-400, KM_RenderPool.pas:997-1036) and are
// hidden under FOW exactly like the game (:1010-1011). Damaged houses draw the haFire1..8
// sub-action sprites by damage level (KM_Houses.pas:1347-1363); a demolished house's rubble
// objects (68 + KaMRandom(6), KM_Terrain.pas:4936) appear through the object scan. Click selects a
// unit and its group; right-click orders walk / attack (enemy unit or house under the cursor)
// through the frozen world.orderGroup. The M4 world API (groups/projectiles/fow/orderGroup/
// damageHouse/unitHealth/groupOf, combat.ts + economy.ts) is used directly, typed by the sim.
//
// serve.ts transpiles this file together with the browser-safe modules it imports (one tsc run,
// --rewriteRelativeImportExtensions): /apps/web/play.js + /packages/**/*.js.
// ESM, zero runtime deps, imports keep the .ts extension (node/tsc) and become .js for the browser.

import { parseTilesJson } from '../../packages/assets/tiledata.ts';
import { parseMapElem } from '../../packages/assets/mapelem.ts';
import { parseUnitDat, parseSerfCarry, walkLoop } from '../../packages/assets/unitdat.ts';
import { parseHousesDat, housePlan } from '../../packages/assets/housedata.ts';
import { WARE_CNT, WARE_NAMES, WT_TRUNK, WT_TIMBER } from '../../packages/assets/wares.ts';
import { parseMissionScript } from '../../packages/mission/mission.ts';
import { createEconomyWorld, applyDemoScenario } from '../../packages/sim/economy.ts';
import { buildPassGrid, tileWalkable } from '../../packages/sim/terrain.ts';
import { findPath } from '../../packages/sim/astar.ts';
import { startWalk, walkTick, walkSpeeds } from '../../packages/sim/walk.ts';
import { parseMapBytes } from './mapread.ts';
import { spawnGroup } from '../../packages/sim/combat.ts';
import type { Walk } from '../../packages/sim/walk.ts';
import type { PassGrid } from '../../packages/sim/terrain.ts';
import type { TileFlags } from '../../packages/assets/tiledata.ts';
import type { UnitSpec, AnimLoop } from '../../packages/assets/unitdat.ts';
import type { HouseSpec } from '../../packages/assets/housedata.ts';
import type { MapElem } from '../../packages/assets/mapelem.ts';
import type { Mission, MissionUnit } from '../../packages/mission/mission.ts';
import type { FogOfWar, GroupState, SimProjectile } from '../../packages/sim/combat.ts';
import type { EconomyWorld, EconHouse, EconUnit, SimEvent } from '../../packages/sim/economy.ts';
import type { KaMap } from '../../packages/map/map.ts';
import type { LoadedMap } from './mapread.ts';

// ---- frozen viewer data shapes (M1 section 3.2 + M0 section 3) --------------
interface MapJson { file: string; mapX: number; mapY: number; tiles: string }
interface MapMeta { file: string; mapX: number; mapY: number }
/** The /maps entry fields the picker shows (docs/M3B-SPIKE.md section 3 MapInfo). */
interface MapInfoView {
  kind: string; name: string;
  mapX: number; mapY: number; remake: boolean; rev: number;
  maxPlayers: number; tactic: boolean; smallDesc: string; valid: boolean;
  canBeHuman: boolean[]; classicAI: boolean[]; advancedAI: boolean[];
  aiStart: { x: number; y: number }[];
}
interface AtlasSheet { file: string; w: number; h: number }
interface AtlasSprite { i: number; w: number; h: number; px: number; py: number; s: number; x: number; y: number; ms: number; mx: number; my: number }
interface Atlas { pack: string; sheets: AtlasSheet[]; maskSheets: AtlasSheet[]; sprites: AtlasSprite[] }

// ---- constants (M1 section 2.3 + M2b sections 2.4, 2.7, 5 + M3 section 2) --
const CELL = 40;             // CELL_SIZE_PX (KM_Defaults.pas line 13)
const HEIGHT_DIV = 33.333;   // CELL_HEIGHT_DIV (line 14)
const PX_PER_HEIGHT = CELL / HEIGHT_DIV;
const ZOOM_STEP = 1.5;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 8;
const VILLAGE_ZOOM = 1.5;    // camera keys 1/2/3 zoom (village view)
const TICK_MS = 100;         // 10 sim ticks/s (M2b/M3 spec 5)
const MAX_CATCHUP = 5;       // catch-up cap per frame (spec 5)
const UNIT_OFF_X = -0.5;     // KM_ResUnits.pas:188
const UNIT_OFF_Y = -0.4;     // KM_ResUnits.pas:189
const SELECT_RADIUS_PX = 24; // M2b spec 5
const UNIT_STILL_FRAMES = [0, 3, 2, 2, 1, 6, 7, 6, 6]; // KM_ResUnits.pas:181, index = dir 0..8
const OWNER_TINTS: [number, number, number][] = [
  [1, 1, 1],           // owner 0 = default: the raw sprite, mask not applied (M2b spec 5)
  [0.36, 0.55, 0.95],  // placeholder team colors until the GUI art pass
  [0.93, 0.36, 0.30],
  [0.40, 0.85, 0.45],
  [0.93, 0.82, 0.32],
];
const OBJ_NONE = 255;
const OBJ_BLOCK = 61;        // invisible wall: never drawn (KM_RenderPool.pas:592-601)
const MAX_WARES_IN_HOUSE = 5; // common/KM_Defaults.pas:299
const HT_SAWMILL = 0;        // HOUSE_ID_TO_TYPE (KM_ResHouses.pas:193-199)
const HT_WOODCUTTERS = 9;
const HT_STORE = 11;
const HT_NONE = 26;
// KaM scripts and houses.dat address houses in this order (KM_ResHouses.pas:193-199, identity list).
const HOUSE_ID_TO_TYPE = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29];
const HOUSE_TYPE_NAMES = [
  'sawmill', 'iron smithy', 'weapon smithy', 'coal mine', 'iron mine', 'gold mine', 'fisherman',
  'bakery', 'farm', 'woodcutters', 'armor smithy', 'store', 'stables', 'school', 'quarry',
  'metallurgists', 'swine', 'watchtower', 'town hall', 'weapon workshop', 'armor workshop',
  'barracks', 'mill', 'siege workshop', 'butcher', 'tannery', 'none', 'inn', 'vineyard', 'market',
];
// RoadsConnectivity[0..15] = (sprite id, rot); bits N=1, E=2, S=4, W=8 (KM_RenderTerrain.pas:808-812).
const ROADS_CONNECTIVITY: [number, number][] = [
  [248, 0], [248, 0], [248, 1], [250, 3], [248, 0], [248, 0], [250, 0], [252, 0],
  [248, 1], [250, 2], [248, 1], [252, 3], [250, 1], [252, 2], [252, 1], [254, 0],
];
// TILE_OVERLAY_IDS (KM_TerrainTypes.pas:176), atlas i = render id - 1 (M1 errata): the digs draw
// plain, rot 0 (docs/M3B-SPIKE.md section 5). Index = TileOverlay (1..4).
const DIG_OVERLAY_IDS: number[] = [0, 249, 251, 253, 255];
// CHOPABLE_TREES[1..13] = (age1, age2, age3, ageFull, fall, stump) (KM_ResMapElements.pas:61-78).
const CHOPABLE_TREES: [number, number, number, number, number, number][] = [
  [88, 89, 90, 90, 91, 37], [97, 98, 99, 100, 101, 41], [102, 103, 104, 105, 106, 45],
  [107, 108, 109, 110, 111, 41], [112, 113, 114, 114, 115, 25], [116, 117, 118, 119, 120, 25],
  [92, 93, 94, 95, 96, 49], [121, 122, 123, 124, 125, 64], [149, 150, 151, 151, 152, 29],
  [153, 154, 155, 155, 156, 29], [157, 158, 159, 160, 161, 33], [162, 163, 164, 165, 166, 33],
  [167, 168, 169, 170, 171, 33],
];
const FULL_TREE_OBJS = new Set(CHOPABLE_TREES.map((t) => t[3]));
const ALL_TREE_OBJS = new Set(CHOPABLE_TREES.flatMap((t) => [t[0], t[1], t[2], t[3]]));
const STUMP_OBJS = new Set(CHOPABLE_TREES.map((t) => t[5]));
/** ageFull object -> falling object (unique per species; the stump ids repeat, the full ones do not). */
const FALL_BY_FULL = new Map<number, number>(CHOPABLE_TREES.map((t) => [t[3], t[4]]));
const HOUSES_DAT_HEAD = 2100;   // beast block (spec 2.2)
const HOUSES_DAT_RECORD = 1688;
const MAPELEM_RECORD = 99;
const SERF_CARRY_DIRS = 8;

// ---- M4 constants (docs/M4-SPIKE.md sections 2.2, 2.3, 2.5, 2.7) -------------
const UA_WORK = 1;  // anim index of uaWork (121 − 120): the fight loop (KM_UnitWarrior.pas:754)
const UA_SPEC = 2;  // uaSpec (122 − 120): the projectile sprite loop (KM_RenderPool.pas:1015-1018)
const UA_DIE = 3;   // uaDie (123 − 120): the death sequence (KM_UnitTaskDie.pas:85-86)
const UT_SWORDFIGHTER = 16; // UNIT_ID_TO_TYPE records (KM_ResUnits.pas:146-157)
const UT_BOWMAN = 17;
const UT_CROSSBOWMAN = 18;
const UT_ROGUE = 25;
// PROJECTILE_ARC base curve per kind (KM_Projectiles.pas:71; the sim owns the RNG jitter part).
const PROJECTILE_ARC: Record<string, number> = { arrow: 1.6, bolt: 1.4, stone: 2.5 };
// AddHouseRemainder writes 68 + KaMRandom(6) (KM_Terrain.pas:4936).
const RUBBLE_OBJS = new Set([68, 69, 70, 71, 72, 73]);
const HOUSE_ANIM_BASE = 88;   // houses.dat record: Anim[haWork1..] at +88 (housedata.ts header)
const HOUSE_ANIM_LOOP = 70;
const HA_FIRE1 = 11;          // TKMHouseActionType haFire1 (KM_Defaults.pas:768)
const FIRE_COUNT = 8;
const FOW_HIDE_AT = 128;      // projectile render skip: CheckRevelation <= 128 (KM_RenderPool.pas:1011)
const HUMAN_HAND_FALLBACK = 0; // mission.humanPlayer fallback (M3 spec 2.1: hand 0 is the human)

// ---- M4 combat types (docs/M4-SPIKE.md section 3) ---------------------------
// The sim's own types (packages/sim/combat.ts landed); the viewer reads the frozen world API
// directly. `FowPointRev` only probes the optional point-revelation helper beyond section 3.
interface FowPointRev {
  checkRev?(x: number, y: number): number;
}

const cv = document.getElementById('cv') as HTMLCanvasElement;
const hud = document.getElementById('hud') as HTMLDivElement;
const errBox = document.getElementById('err') as HTMLDivElement;
const gl = cv.getContext('webgl2', { alpha: false });
if (gl === null) throw new Error('webgl2 unavailable');

// ---- shader programs --------------------------------------------------------
// Terrain: position + UV from the VBO, camera uniform only (M1 mapdemo). M4: the FOW texture
// (per-vertex revelation, the game's RenderFOW multiply — KM_RenderTerrain.pas:1052-1119) darkens
// every fragment by rev/255; uFowOn = 0 skips it (toggle key F).
const TERRAIN_VS = `#version 300 es
in vec2 aPos;        // world px
in vec2 aUV;         // atlas UV
uniform vec2 uCam;   // world px at the viewport centre
uniform float uZoom; // css px per world px
uniform vec2 uView;  // viewport, css px
out vec2 vUV;
out vec2 vWorld;     // world px (FOW sampling)
void main() {
  vec2 css = (aPos - uCam) * uZoom + uView * 0.5;
  gl_Position = vec4(css.x / uView.x * 2.0 - 1.0, 1.0 - css.y / uView.y * 2.0, 0.0, 1.0);
  vUV = aUV;
  vWorld = aPos;
}`;
const TERRAIN_FS = `#version 300 es
precision mediump float;
in vec2 vUV;
in vec2 vWorld;
uniform sampler2D uTex;
uniform sampler2D uFow;    // vertex revelation grid, mapX x mapY
uniform float uFowOn;
uniform vec2 uMapCells;    // mapX, mapY (vertex grid size)
uniform float uCell;       // CELL_SIZE_PX
out vec4 outColor;
void main() {
  vec4 c = texture(uTex, vUV);
  if (uFowOn > 0.5) {
    vec2 fuv = (vWorld / uCell + 0.5) / uMapCells;
    c.rgb *= texture(uFow, fuv).r;
  }
  outColor = c;
}`;

// Sprites + selection ring: one 0..1 quad, world top-left + size, sheet rect UVs, optional
// team tint through the mask sheet (mask byte = alpha, RGB red; packages/assets/atlas.ts).
// M4: the same FOW multiply per fragment (the game draws sprites, then multiplies the FOW
// texture over the whole scene — KM_RenderTerrain.pas:1072).
const SPRITE_VS = `#version 300 es
in vec2 aPos;        // 0..1 quad
uniform vec2 uCam;
uniform float uZoom;
uniform vec2 uView;
uniform vec2 uWorld; // quad top-left, world px
uniform vec2 uSize;  // quad size, world px
out vec2 vPos;
out vec2 vWorld;
void main() {
  vec2 w = uWorld + aPos * uSize;
  vec2 css = (w - uCam) * uZoom + uView * 0.5;
  gl_Position = vec4(css.x / uView.x * 2.0 - 1.0, 1.0 - css.y / uView.y * 2.0, 0.0, 1.0);
  vPos = aPos;
  vWorld = w;
}`;
const SPRITE_FS = `#version 300 es
precision mediump float;
in vec2 vPos;
in vec2 vWorld;
uniform sampler2D uTex;
uniform vec4 uRect;     // sprite rect in its sheet, px (x,y,w,h)
uniform vec2 uSheet;    // sheet size, px
uniform sampler2D uMaskTex;
uniform vec4 uMaskRect; // mask rect in its mask sheet, px
uniform vec2 uMaskSheet;
uniform float uHasMask;
uniform vec3 uTint;
uniform sampler2D uFow; // vertex revelation grid, mapX x mapY
uniform float uFowOn;
uniform vec2 uMapCells;
uniform float uCell;
out vec4 outColor;
void main() {
  vec2 uv = (uRect.xy + vPos * uRect.zw) / uSheet;
  vec4 c = texture(uTex, uv);
  if (uHasMask > 0.5) {
    vec2 muv = (uMaskRect.xy + vPos * uMaskRect.zw) / uMaskSheet;
    float m = texture(uMaskTex, muv).a;
    c.rgb = mix(c.rgb, uTint, m);
  }
  if (uFowOn > 0.5) {
    vec2 fuv = (vWorld / uCell + 0.5) / uMapCells;
    c.rgb *= texture(uFow, fuv).r;
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
  fow: gl.getUniformLocation(terrainProg, 'uFow')!,
  fowOn: gl.getUniformLocation(terrainProg, 'uFowOn')!,
  mapCells: gl.getUniformLocation(terrainProg, 'uMapCells')!,
  cell: gl.getUniformLocation(terrainProg, 'uCell')!,
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
  fow: gl.getUniformLocation(spriteProg, 'uFow')!,
  fowOn: gl.getUniformLocation(spriteProg, 'uFowOn')!,
  mapCells: gl.getUniformLocation(spriteProg, 'uMapCells')!,
  cell: gl.getUniformLocation(spriteProg, 'uCell')!,
};

gl.enable(gl.BLEND);
gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

// ---- state ------------------------------------------------------------------
let map: MapMeta | null = null;           // current map {file, mapX, mapY}
let mapSource: { kind: string; name: string } | null = null; // null = Town Tutorial
let loadedMap: LoadedMap | null = null;   // the scanned .map walk (overlay/layers/rev/tail)
let mapRev = 0;                           // parsed revision (0 = standard / tutorial export)
let mapRemake = false;
let mapInfo: MapInfoView | null = null;   // the /maps entry of the current map (null = tutorial)
let mapList: MapInfoView[] = [];          // the scanned map list (/maps)
let loadToken = 0;                        // guards out-of-order async map switches
let atlas: Atlas | null = null;          // Tileset atlas (M1 renderer)
let tiles: Uint8Array | null = null;     // mapX*mapY*4: [terrain, height, rot, obj]
let baseTerrain: Uint16Array | null = null; // true terrain ids (Remake Word; null = use the byte)
let tileFlags: TileFlags[] = [];         // tiles.json (parsed once)
let sheetTex: WebGLTexture[] = [];
let terrainVao: WebGLVertexArrayObject | null = null;
let terrainIndexCount = 0;
let terrainBuffers: WebGLBuffer[] = [];
let overlayVao: WebGLVertexArrayObject | null = null;
let overlayIndexCount = 0;
let overlayBuffers: WebGLBuffer[] = [];
let roadQuadCount = 0;
let digQuadCount = 0;

let unitsAtlas: Atlas | null = null;
let housesAtlas: Atlas | null = null;
let treesAtlas: Atlas | null = null;
let unitTex: WebGLTexture[] = [];
let unitMaskTex: WebGLTexture[] = [];
let houseTex: WebGLTexture[] = [];
let houseMaskTex: WebGLTexture[] = [];
let treeTex: WebGLTexture[] = [];
let unitByI: Map<number, AtlasSprite> = new Map();
let houseByI: Map<number, AtlasSprite> = new Map();
let treeByI: Map<number, AtlasSprite> = new Map();
let tilesByI: Map<number, AtlasSprite> = new Map(); // Tileset atlas lookup (terrain + road overlay)

// M3 world + the tables the frozen interfaces do not carry (see the header note).
let specs: UnitSpec[] = [];
let serfCarry: AnimLoop[][] = [];
let elems: MapElem[] = [];
let houseSpecs: (HouseSpec | undefined)[] = [];
let mission: Mission | null = null;
let world: EconomyWorld | null = null;
let staticHouses: EconHouse[] = [];                              // mission entities of non-tutorial maps
let staticUnits: EconUnit[] = [];
let treeAnims: { steps: number[]; count: number }[] = [];       // per mapelem object id
let supplyIn: Int16Array[] = [];                                 // per house type id, 4 slots x 5 counts
let supplyOut: Int16Array[] = [];
let roadTiles: Set<number> = new Set();                          // grid index (y*(mapX+1)+x) of toRoad tiles
let digTiles: Map<number, number> = new Map();                   // grid index -> TileOverlay 1..4 (toDig1..4)

// Object tiles + falling-tree tracking (viewer-side; the frozen world API has no falling list).
let objTiles: number[] = [];
let prevObj: Map<number, number> = new Map();
let falling: Map<number, { fallObj: number; start: number }> = new Map();
let scannedTick = -1;
let objOverride: Map<number, number> = new Map(); // defensive treeAt fallback (see scanObjects)
let mapObjectTiles: number[] = [];                // object tiles of the raw map (boot scan)

// M2b compat: viewer-side walk orders for hand-0 units without tasks (the frozen EconomyWorld has
// no order API). `speeds` mirrors the M2b SimUnit.speed field for the CDP hooks.
let moves: Map<number, Walk> = new Map();
let pendingOrders: { uid: number; x: number; y: number }[] = [];
let speedCache: Map<number, { ortho: number; diag: number }> = new Map();

let selectedUid = 0;
let selectedHouseUid = 0;
let frameStats = { frames: 0, unitsDrawn: 0, housesDrawn: 0, objectsDrawn: 0, projectilesDrawn: 0, missingSprites: 0 };

// M4 combat viewer state: the FOW toggle/hand, the revelation texture (vertex grid), the selected
// group, the fire-anim table and the KaMap of the current page (for the scripted-fight rebuild).
let fowOn = true;             // spec 2.7 toggle (key F)
let fowHand = HUMAN_HAND_FALLBACK; // the human hand's revelation (mission.humanPlayer when known)
let fowTex: WebGLTexture | null = null;
let fowTexW = 0;
let fowTexH = 0;
let fowPixels: Uint8Array | null = null;
let fowDirtyTick = -1;
let currentKaMap: KaMap | null = null;
let selectedGroupUid = 0;
let houseFireAnims: AnimLoop[][] = []; // per script id, [haFire1..8] loops (viewer parse, like supply)
let projectileDrawCount = 0;
let projectileScreens: { uid: number; kind: string; x: number; y: number; w: number; h: number }[] = [];

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

function readI16(buf: Uint8Array, o: number): number {
  const v = buf[o] | (buf[o + 1] << 8);
  return v < 0x8000 ? v : v - 0x10000;
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

/** Bilinear terrain height shift (px) at a world point (M2b spec 5: visual check only). */
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

// ---- viewer-side table parsers (not in the frozen interfaces; see header) ----
/** mapelem.dat Anim loops: Step[1..30] i16 at +0, Count i16 at +60 (KM_ResMapElements.pas:127-160). */
function parseElemAnims(buf: Uint8Array): { steps: number[]; count: number }[] {
  const out: { steps: number[]; count: number }[] = [];
  for (let i = 0; i < 256; i++) {
    const b = i * MAPELEM_RECORD;
    if (b + 62 > buf.length) {
      out.push({ steps: [], count: 0 });
      continue;
    }
    const count = Math.max(0, Math.min(30, readI16(buf, b + 60)));
    const steps: number[] = [];
    for (let k = 0; k < 30; k++) steps.push(readI16(buf, b + k * 2));
    out.push({ steps, count });
  }
  out[63] = { steps: [16], count: 1 }; // loader override (KM_ResMapElements.pas:147-156)
  return out;
}

/** houses.dat SupplyIn@8 / SupplyOut@48, 4 slots x 5 counts i16 per record (spec 2.2/2.9). */
function parseSupplyTables(buf: Uint8Array): { in: Int16Array[]; out: Int16Array[] } {
  const inT: Int16Array[] = [];
  const outT: Int16Array[] = [];
  for (let i = 0; i < HOUSE_ID_TO_TYPE.length; i++) {
    inT.push(new Int16Array(20).fill(-1));
    outT.push(new Int16Array(20).fill(-1));
  }
  for (let slot = 0; slot < 29; slot++) {
    const b = HOUSES_DAT_HEAD + slot * HOUSES_DAT_RECORD;
    if (b + HOUSES_DAT_RECORD > buf.length) break;
    const typeId = HOUSE_ID_TO_TYPE[slot]!;
    for (let k = 0; k < 20; k++) {
      inT[typeId]![k] = readI16(buf, b + 8 + k * 2);
      outT[typeId]![k] = readI16(buf, b + 48 + k * 2);
    }
  }
  return { in: inT, out: outT };
}

function readI32(buf: Uint8Array, o: number): number {
  return buf[o]! | (buf[o + 1]! << 8) | (buf[o + 2]! << 16) | (buf[o + 3]! << 24);
}

/**
 * houses.dat Anim[haFire1..haFire8] loops (TKMHouseActionType 11..18, KM_Defaults.pas:764-768):
 * record Anim at +88, 19 loops of 70 B (housedata.ts header). Viewer-side like the supply tables —
 * the frozen HouseSpec does not carry the house animations.
 */
function parseHouseFireAnims(buf: Uint8Array): AnimLoop[][] {
  const out: AnimLoop[][] = [];
  for (let i = 0; i < HOUSE_ID_TO_TYPE.length; i++) out.push([]);
  for (let slot = 0; slot < 29; slot++) {
    const b = HOUSES_DAT_HEAD + slot * HOUSES_DAT_RECORD;
    if (b + HOUSES_DAT_RECORD > buf.length) break;
    const loops: AnimLoop[] = [];
    for (let k = 0; k < FIRE_COUNT; k++) {
      const o = b + HOUSE_ANIM_BASE + (HA_FIRE1 + k) * HOUSE_ANIM_LOOP;
      const steps = new Int16Array(30);
      for (let s = 0; s < 30; s++) steps[s] = readI16(buf, o + s * 2);
      loops.push({ steps, count: readI16(buf, o + 60), moveX: readI32(buf, o + 62), moveY: readI32(buf, o + 66) });
    }
    out[slot] = loops;
  }
  return out;
}

// ---- M4 combat helpers (docs/M4-SPIKE.md section 3) -------------------------
/** Fight state of a unit: 'none' | 'fight' | 'die' (the frozen EconUnit field). */
function fightStateOf(u: EconUnit): 'none' | 'fight' | 'die' {
  return u.fightState === 'fight' || u.fightState === 'die' ? u.fightState : 'none';
}

function isDeadUnit(u: EconUnit): boolean {
  return u.dead === true;
}

function unitHitPoints(u: EconUnit): number | null {
  if (world === null) return null; // static mode: no sim health to show
  return Number.isFinite(u.hitPoints) ? u.hitPoints : null;
}

/** The human hand (mission.humanPlayer; hand 0 in the tutorial and Arena — M3 spec 2.1). */
function humanHand(): number {
  const m = mission;
  return m !== null && Number.isInteger(m.humanPlayer) && m.humanPlayer >= 0 ? m.humanPlayer : HUMAN_HAND_FALLBACK;
}

function fowOf(hand: number): FogOfWar | null {
  if (world === null) return null;
  const f = world.fow[hand];
  return f === undefined || f === null ? null : f;
}

/** Tile revelation (1-based tile, 0..255); -1 when the sim has no FOW for the hand. */
function fowTileRev(x: number, y: number): number {
  const f = fowOf(fowHand);
  if (f === null) return -1;
  const v = f.checkTileRev(x, y);
  return typeof v === 'number' && Number.isFinite(v) ? v : -1;
}

function fowVertRev(x: number, y: number): number {
  const f = fowOf(fowHand);
  if (f === null) return -1;
  const v = f.checkVerticeRev(x, y);
  return typeof v === 'number' && Number.isFinite(v) ? v : -1;
}

/**
 * Revelation at a world-px point: the game's CheckRevelation (KM_FogOfWar.pas:478-498, tile-space
 * point) when the sim exposes it, else the containing tile's revelation (accepted approximation,
 * spec 2.7). -1 when FOW is unavailable.
 */
function fowRevAtWorld(wx: number, wy: number): number {
  const f = fowOf(fowHand);
  if (f === null) return -1;
  const probe = f as unknown as FowPointRev;
  if (typeof probe.checkRev === 'function') {
    const v = probe.checkRev(wx / CELL, wy / CELL);
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return fowTileRev(Math.floor(wx / CELL) + 1, Math.floor(wy / CELL) + 1);
}

/**
 * Rebuild the per-vertex revelation texture when the sim tick changed (the game's RenderFOW
 * multiplies the scene by Revelation/255; vertex grid mapX x mapY — KM_RenderTerrain.pas:1076-1119).
 */
function updateFowTexture(): void {
  if (map === null) return;
  const f = fowOf(fowHand);
  const active = fowOn && f !== null;
  if (!active) return;
  const w = map.mapX;
  const h = map.mapY;
  const tick = world === null ? 0 : world.tickCount;
  if (fowTex !== null && fowTexW === w && fowTexH === h && fowDirtyTick === tick) return;
  if (fowTex === null || fowTexW !== w || fowTexH !== h) {
    if (fowTex !== null) gl!.deleteTexture(fowTex);
    fowTex = gl!.createTexture()!;
    fowTexW = w;
    fowTexH = h;
    fowPixels = new Uint8Array(w * h);
    fowDirtyTick = -1;
  }
  const px = fowPixels!;
  for (let vy = 0; vy < h; vy++) {
    for (let vx = 0; vx < w; vx++) {
      const v = f.checkVerticeRev(vx, vy);
      px[vy * w + vx] = typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(255, Math.round(v))) : 0;
    }
  }
  gl!.bindTexture(gl!.TEXTURE_2D, fowTex);
  gl!.pixelStorei(gl!.UNPACK_ALIGNMENT, 1);
  gl!.texImage2D(gl!.TEXTURE_2D, 0, gl!.R8, w, h, 0, gl!.RED, gl!.UNSIGNED_BYTE, px);
  gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MIN_FILTER, gl!.LINEAR);
  gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MAG_FILTER, gl!.LINEAR);
  gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_S, gl!.CLAMP_TO_EDGE);
  gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_T, gl!.CLAMP_TO_EDGE);
  fowDirtyTick = tick;
}

/** Group uid of a unit: the frozen groupOf() first, the additive unit field as fallback. */
function groupUidOf(uid: number): number {
  if (world === null) return 0;
  const g = world.groupOf(uid);
  if (g !== null && g !== undefined && typeof g.uid === 'number') return g.uid;
  const u = activeUnits().find((x) => x.uid === uid);
  const gu = u === undefined ? 0 : u.groupUid;
  return typeof gu === 'number' && gu > 0 ? gu : 0;
}

function selectedGroup(): GroupState | null {
  if (selectedGroupUid === 0 || world === null) return null;
  return world.groups.find((g) => g.uid === selectedGroupUid) ?? null;
}

/** Member units of a group that are still on the field (dead/closed units are skipped). */
function groupMembers(g: GroupState): EconUnit[] {
  const out: EconUnit[] = [];
  for (const uid of g.memberUids) {
    const u = activeUnits().find((x) => x.uid === uid);
    if (u === undefined || isDeadUnit(u)) continue;
    out.push(u);
  }
  return out;
}

/** Viewer-side group condition (the frozen SimGroup has no Condition field; KM_UnitGroup.pas:471). */
function groupCondition(g: GroupState): string {
  const members = groupMembers(g);
  if (members.length === 0) return 'dead';
  if (members.some((u) => fightStateOf(u) === 'fight')) return 'fighting';
  if (g.order === 'walk') return 'walking';
  if (g.order === 'attackUnit' || g.order === 'attackHouse') return 'attacking';
  if (g.order === 'halt') return 'halted';
  return 'idle';
}

/** House health: MaxHealth − fDamage (KM_Houses.pas:1173-1176); null in static mode. */
function houseHealthOf(h: EconHouse): number | null {
  if (world === null) return null;
  if (Number.isFinite(h.maxHealth) && Number.isFinite(h.damage)) return Math.max(0, h.maxHealth - h.damage);
  return null;
}

/** A demolished house (the sim deletes it from world.houses a tick later). */
function houseDestroyed(h: EconHouse): boolean {
  return h.destroyed === true;
}

/**
 * Fire sub-actions by damage level: dmgLevel = MaxHealth div 8; fire k shows when
 * fDamage > (k-1)*dmgLevel (KM_Houses.pas:1347-1363, complete houses only — v0 has none under
 * construction). The sim's own fireLevel wins; else derived from the house health.
 */
function houseFireCount(h: EconHouse): number {
  if (Number.isFinite(h.fireLevel)) return Math.max(0, Math.min(FIRE_COUNT, Math.round(h.fireLevel)));
  const spec = houseSpecs[h.typeId];
  const health = houseHealthOf(h);
  if (spec === undefined || health === null) return 0;
  const dmg = Math.max(0, spec.maxHealth - health);
  if (dmg <= 0) return 0;
  const level = Math.floor(spec.maxHealth / 8);
  if (level <= 0) return FIRE_COUNT;
  let n = 0;
  for (let k = 1; k <= FIRE_COUNT; k++) if (dmg > (k - 1) * level) n = k;
  return n;
}

/** KMGetDirection(FromPos, ToPos) (KM_Points.pas:835-867): 8-way direction from a delta. */
function dirFromDelta(dx: number, dy: number): number {
  if (dx === 0 && dy === 0) return 1;
  const distSqr = dx * dx + dy * dy;
  const ang = Math.atan2(dy / distSqr, dx / distSqr);
  return Math.round((((ang + Math.PI / 2) / Math.PI) * 180 + 3600 + 22.5) % 360 / 45) + 1;
}

/**
 * Projectile sprite: the shooter's uaSpec loop at trunc(pct*(count-1)) (the game's
 * UnitActionByPercent with interpolation disabled — KM_ResInterpolation.pas:101-109).
 */
function projectileSprite(kind: SimProjectile['kind'], dir: number, pct: number): AtlasSprite | undefined {
  const rec = kind === 'bolt' ? UT_CROSSBOWMAN : kind === 'stone' ? UT_ROGUE : UT_BOWMAN;
  const spec = specs[rec];
  if (spec === undefined) return undefined;
  const loop = spec.anim[UA_SPEC]?.[dir - 1];
  if (loop === undefined || loop.count <= 0) return undefined;
  const step = Math.min(loop.count - 1, Math.max(0, Math.trunc(pct * (loop.count - 1))));
  const stored = loop.steps[step];
  if (stored === undefined || stored < 0) return undefined;
  return unitByI.get(stored);
}

// ---- terrain VBO (M1 renderer) ----------------------------------------------
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
      // True terrain id: the Remake Terrain Word (G's baseTerrain) or the M1 byte for standard maps
      // (some Remake maps carry ids > 255; the low byte aliases them onto foreign sprites).
      const terrain = baseTerrain !== null ? baseTerrain[off >> 2]! : tiles[off]!;
      const rot = tiles[off + 2]! & 3; // original maps store raw rot > 3 (section 2.1); render uses rot & 3

      // Sprite for terrain id t is the atlas entry with i == t (M1 errata: atlas i = game render id - 1).
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

      // World corners TL,BL,BR,TR with the per-corner height shift (M1 section 2.3).
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

  for (const b of terrainBuffers) gl!.deleteBuffer(b);
  if (terrainVao !== null) gl!.deleteVertexArray(terrainVao);
  terrainVao = gl!.createVertexArray()!;
  gl!.bindVertexArray(terrainVao);
  const vbo = gl!.createBuffer()!;
  terrainBuffers = [vbo];
  gl!.bindBuffer(gl!.ARRAY_BUFFER, vbo);
  gl!.bufferData(gl!.ARRAY_BUFFER, verts, gl!.STATIC_DRAW);
  const ebo = gl!.createBuffer()!;
  terrainBuffers.push(ebo);
  gl!.bindBuffer(gl!.ELEMENT_ARRAY_BUFFER, ebo);
  gl!.bufferData(gl!.ELEMENT_ARRAY_BUFFER, inds, gl!.STATIC_DRAW);
  const aPos = gl!.getAttribLocation(terrainProg, 'aPos');
  gl!.enableVertexAttribArray(aPos);
  gl!.vertexAttribPointer(aPos, 2, gl!.FLOAT, false, 16, 0);
  const aUV = gl!.getAttribLocation(terrainProg, 'aUV');
  gl!.enableVertexAttribArray(aUV);
  gl!.vertexAttribPointer(aUV, 2, gl!.FLOAT, false, 16, 8);
  gl!.bindVertexArray(null);
  terrainIndexCount = n * 6;
}

/**
 * Overlay pass (M3 spec 2.9 + M3b spec section 5): one static VBO with two quad groups —
 *  - roads: every toRoad tile (the mission's !SET_STREET list, plus the Remake map's stored
 *    overlay toRoad) draws its connectivity sprite from the neighbor mask N=1,E=2,S=4,W=8
 *    (KM_RenderTerrain.pas:808-836 -> ROADS_CONNECTIVITY);
 *  - digs: every stored toDig1..toDig4 overlay draws TILE_OVERLAY_IDS[ov] = 249/251/253/255
 *    plain, rot 0 (KM_TerrainTypes.pas:176, KM_RenderTerrain.pas:838-839).
 */
function buildOverlayVbo(): void {
  if (map === null || atlas === null) return;
  const mx = map.mapX;
  const my = map.mapY;
  const stride = mx + 1;
  const isRoad = (x: number, y: number): boolean => roadTiles.has(y * stride + x);
  const quads: { x: number; y: number; id: number; rot: number }[] = [];

  for (const idx of roadTiles) {
    const x = idx % stride;
    const y = (idx - x) / stride;
    let mask = 0;
    if (y - 1 >= 1 && isRoad(x, y - 1)) mask += 1;        // N
    if (x + 1 <= mx - 1 && isRoad(x + 1, y)) mask += 2;   // E
    if (y + 1 <= my - 1 && isRoad(x, y + 1)) mask += 4;   // S
    if (x - 1 >= 1 && isRoad(x - 1, y)) mask += 8;        // W
    const entry = ROADS_CONNECTIVITY[mask]!;
    quads.push({ x, y, id: entry[0], rot: entry[1] });
  }
  roadQuadCount = quads.length;
  for (const [idx, ov] of digTiles) {
    const x = idx % stride;
    const y = (idx - x) / stride;
    quads.push({ x, y, id: DIG_OVERLAY_IDS[ov]!, rot: 0 });
  }
  digQuadCount = quads.length - roadQuadCount;

  const verts = new Float32Array(quads.length * 16);
  const inds = new Uint32Array(quads.length * 6);
  let v = 0;
  let q = 0;
  let missing = 0;
  for (const item of quads) {
    const tx = item.x;
    const ty = item.y;
    const rot = item.rot & 3;
    let u1 = 0;
    let v1 = 0;
    let u2 = 0;
    let v2 = 0;
    const tsp = tilesByI.get(item.id);
    if (tsp !== undefined) {
      const sheet = atlas.sheets[tsp.s]!;
      u1 = tsp.x / sheet.w;
      v1 = tsp.y / sheet.h;
      u2 = (tsp.x + tsp.w) / sheet.w;
      v2 = (tsp.y + tsp.h) / sheet.h;
    } else {
      missing++;
    }
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
  if (missing > 0) console.warn(`play: ${missing} overlay sprites missing from the Tileset atlas`);

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
  const aPos = gl!.getAttribLocation(terrainProg, 'aPos');
  gl!.enableVertexAttribArray(aPos);
  gl!.vertexAttribPointer(aPos, 2, gl!.FLOAT, false, 16, 0);
  const aUV = gl!.getAttribLocation(terrainProg, 'aUV');
  gl!.enableVertexAttribArray(aUV);
  gl!.vertexAttribPointer(aUV, 2, gl!.FLOAT, false, 16, 8);
  gl!.bindVertexArray(null);
  overlayIndexCount = q * 6;
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

/** Procedural white ellipse-ring texture (placeholder until the GUI art pass, M2b spec 5). */
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

/** Camera keys 1/2/3: the village centre of a hand (centroid of its houses), at village zoom. */
function jumpToVillage(owner: number): boolean {
  if (world === null && staticHouses.length === 0) return false;
  const houses = activeHouses().filter((h) => h.owner === owner);
  if (houses.length === 0) return false;
  let sx = 0;
  let sy = 0;
  for (const h of houses) {
    sx += h.x;
    sy += h.y;
  }
  camX = (sx / houses.length) * CELL;
  camY = (sy / houses.length) * CELL;
  zoom = VILLAGE_ZOOM;
  hoverX = -1;
  hoverY = -1;
  return true;
}

// ---- sprite drawing (M2b drawUnit generalised to the three atlases) ---------
const WHITE: [number, number, number] = [1, 1, 1];

function drawSpriteIn(
  atlasData: Atlas,
  tex: WebGLTexture[],
  masks: WebGLTexture[],
  sp: AtlasSprite,
  wx: number,
  wy: number,
  tint: [number, number, number],
  useMask: boolean,
): void {
  const sheet = atlasData.sheets[sp.s]!;
  gl!.uniform2f(uS.world, wx, wy);
  gl!.uniform2f(uS.size, sp.w, sp.h);
  gl!.uniform4f(uS.rect, sp.x, sp.y, sp.w, sp.h);
  gl!.uniform2f(uS.sheet, sheet.w, sheet.h);
  gl!.activeTexture(gl!.TEXTURE0);
  gl!.bindTexture(gl!.TEXTURE_2D, tex[sp.s]!);
  gl!.uniform1i(uS.tex, 0);

  const hasMask = useMask && sp.ms >= 0 && sp.ms < masks.length;
  gl!.uniform1f(uS.hasMask, hasMask ? 1 : 0);
  if (hasMask) {
    const ms = atlasData.maskSheets[sp.ms]!;
    gl!.activeTexture(gl!.TEXTURE1);
    gl!.bindTexture(gl!.TEXTURE_2D, masks[sp.ms]!);
    gl!.uniform1i(uS.maskTex, 1);
    gl!.uniform4f(uS.maskRect, sp.mx, sp.my, sp.w, sp.h);
    gl!.uniform2f(uS.maskSheet, ms.w, ms.h);
  }
  gl!.uniform3f(uS.tint, tint[0], tint[1], tint[2]);
  gl!.uniform1f(uS.fowOn, fowOn && fowTex !== null ? 1 : 0);
  gl!.drawArrays(gl!.TRIANGLE_STRIP, 0, 4);
}

function tintFor(owner: number): { tint: [number, number, number]; useMask: boolean } {
  const idx = owner % OWNER_TINTS.length;
  return { tint: OWNER_TINTS[idx]!, useMask: idx !== 0 };
}

// ---- units (M2b section 5 + M3 carry overlay) --------------------------------
/** The entities the current mode draws: the economy world (tutorial) or the mission's static lists. */
function activeHouses(): EconHouse[] {
  return world !== null ? world.houses : staticHouses;
}

function activeUnits(): EconUnit[] {
  return world !== null ? world.units : staticUnits;
}

function selectedUnit(): EconUnit | null {
  if (selectedUid === 0) return null;
  return activeUnits().find((u) => u.uid === selectedUid) ?? null;
}

function selectedHouse(): EconHouse | null {
  if (selectedHouseUid === 0) return null;
  return activeHouses().find((h) => h.uid === selectedHouseUid) ?? null;
}

/** Unit anchor: world px at (posF + UNIT_OFF) * 40 minus the terrain height shift (M2b spec 5). */
function unitAnchor(u: EconUnit): { x: number; y: number } {
  const wx = (u.posF.x + UNIT_OFF_X) * CELL;
  const wy = (u.posF.y + UNIT_OFF_Y) * CELL;
  return { x: wx, y: wy - terrainHeightPx(wx, wy) };
}

/**
 * The loop + frame a unit draws: uaDie while dying (locked stay of Count ticks — KM_UnitTaskDie.pas
 * :85-86), the uaWork fight loop while fighting (SetActionFight(uaWork) — KM_UnitWarrior.pas:754),
 * the walk loop while walking, the still frame when staying (M2b).
 */
function unitLoop(u: EconUnit, spec: UnitSpec, dir: number): { loop: AnimLoop | undefined; frame: number } {
  const fs = fightStateOf(u);
  if (fs === 'die') {
    const loop = spec.anim[UA_DIE]?.[dir - 1];
    const count = loop !== undefined && loop.count > 0 ? loop.count : 1;
    return { loop, frame: Math.max(0, Math.min(u.animStep, count - 1)) };
  }
  if (fs === 'fight') {
    return { loop: spec.anim[UA_WORK]?.[dir - 1], frame: u.animStep };
  }
  const loop = walkLoop(spec, dir);
  return { loop, frame: u.action === 'walk' ? u.animStep : (UNIT_STILL_FRAMES[u.dir] ?? 0) };
}

/** Atlas sprite for the unit's current frame (fight/die loops included — M4 section 2.7). */
function unitSprite(u: EconUnit): AtlasSprite | undefined {
  const spec: UnitSpec | undefined = specs[u.type];
  if (spec === undefined) return undefined;
  const dir = u.dir >= 1 && u.dir <= 8 ? u.dir : 1;
  const pick = unitLoop(u, spec, dir);
  const loop = pick.loop !== undefined && pick.loop.count > 0 ? pick.loop : walkLoop(spec, dir);
  if (loop.count <= 0) return undefined;
  const idx = pick.frame % loop.count;
  const stored: number | undefined = loop.steps[idx];
  if (stored === undefined || stored < 0) return undefined;
  return unitByI.get(stored);
}

/** Sprite centre on screen (css px, canvas-relative) — the select hit test point. */
function unitSpriteCenterScreen(u: EconUnit): { x: number; y: number } | null {
  const sp = unitSprite(u);
  if (sp === undefined) return null;
  const a = unitAnchor(u);
  return worldToScreen(a.x + sp.px + sp.w / 2, a.y + sp.py + sp.h / 2);
}

function speedsFor(type: number): { ortho: number; diag: number } {
  const cached = speedCache.get(type);
  if (cached !== undefined) return cached;
  const spec = specs[type];
  const s = spec === undefined ? { ortho: 1 / 10, diag: 1 / 14 } : walkSpeeds(spec.speedRaw);
  speedCache.set(type, s);
  return s;
}

function drawUnitEntity(u: EconUnit, sp: AtlasSprite, a: { x: number; y: number }, drawn: { units: number }): void {
  if (unitsAtlas === null) return;
  const { tint, useMask } = tintFor(u.owner);
  drawSpriteIn(unitsAtlas, unitTex, unitMaskTex, sp, a.x + sp.px, a.y + sp.py, tint, useMask);
  drawn.units++;

  // Carried ware overlay (KM_RenderPool.pas:1092-1108): SerfCarry[ware, dir], step = animStep mod
  // Count + 1, corner += MoveX / MoveY of the loop.
  const carry = u.carry;
  if (typeof carry !== 'number' || carry < 0 || carry >= WARE_CNT) return;
  const dir = u.dir >= 1 && u.dir <= 8 ? u.dir : 1;
  const loop: AnimLoop | undefined = serfCarry[carry]?.[dir - 1];
  if (loop === undefined || loop.count <= 0) return;
  const step = (u.animStep % loop.count) + 1;
  const stored = loop.steps[step - 1];
  if (stored === undefined || stored < 0) return;
  const csp = unitByI.get(stored);
  if (csp === undefined) return;
  drawSpriteIn(unitsAtlas, unitTex, unitMaskTex, csp, a.x + csp.px + loop.moveX, a.y + csp.py + csp.h + loop.moveY, tint, useMask);
}

// ---- houses (M3 spec 2.9) ----------------------------------------------------
/** Complete house sprite + corner: stone sprite, CornerX/CornerY (KM_RenderPool.pas:767-776). */
function houseSpriteOf(h: EconHouse): { sp: AtlasSprite; cornerX: number; cornerY: number } | null {
  if (housesAtlas === null) return null;
  const spec = houseSpecs[h.typeId];
  if (spec === undefined) return null;
  let sp = houseByI.get(spec.stonePic); // complete houses draw the stone sprite
  if (sp === undefined) sp = houseByI.get(spec.woodPic);
  if (sp === undefined) return null;
  const cornerX = (h.x - 1) * CELL + sp.px;
  const cornerY = (h.y - 1) * CELL + sp.py + sp.h - cornerHeight(h.x, h.y + 1) * PX_PER_HEIGHT;
  return { sp, cornerX, cornerY };
}

/** Ware count of one house ware slot: EconHouse.wareIn/Out are per-slot (4) like the game's
 *  fWareIn; a 28-long array (ware-indexed) is accepted too, defensively. */
function slotCount(arr: number[] | undefined, res: number[], slot: number): number {
  if (arr === undefined) return 0;
  if (arr.length <= 4) return arr[slot] ?? 0;
  const ware = res[slot] ?? -1;
  return ware >= 0 ? arr[ware] ?? 0 : 0;
}

/**
 * Damaged-house fire sub-action sprites (KM_RenderPool.pas:827-875): haFire1..8 are continuous
 * anims on the global terrain AnimStep, each drawn at CornerX/Y + Anim.MoveX/MoveY; v0 shows the
 * first `count` fires by damage level (KM_Houses.pas:1347-1363). Fires draw untinted (flag color 0).
 */
function drawHouseFires(h: EconHouse, count: number): void {
  const loops = houseFireAnims[h.typeId];
  if (loops === undefined || loops.length === 0 || housesAtlas === null) return;
  const tick = world === null ? 0 : world.tickCount;
  for (let k = 0; k < count && k < loops.length; k++) {
    const loop = loops[k]!;
    if (loop.count <= 0) continue;
    const step = (tick % loop.count) + 1;
    const stored = loop.steps[step - 1];
    if (stored === undefined || stored < 0) continue;
    const sp = houseByI.get(stored);
    if (sp === undefined) continue;
    const cornerX = (h.x - 1) * CELL + sp.px + loop.moveX;
    const cornerY = (h.y - 1) * CELL + sp.py + loop.moveY + sp.h - cornerHeight(h.x, h.y + 1) * PX_PER_HEIGHT;
    drawSpriteIn(housesAtlas, houseTex, houseMaskTex, sp, cornerX, cornerY, WHITE, false);
  }
}

function drawHouseEntity(h: EconHouse, drawn: { houses: number }): void {
  if (housesAtlas === null) return;
  const hs = houseSpriteOf(h);
  if (hs === null) return;
  const spec = houseSpecs[h.typeId];
  const { tint, useMask } = tintFor(h.owner);
  drawSpriteIn(housesAtlas, houseTex, houseMaskTex, hs.sp, hs.cornerX, hs.cornerY, tint, useMask);
  drawn.houses++;
  if (spec === undefined) return;

  // Ground ware stacks (AddHouseSupply): SupplyIn[slot, count]/SupplyOut[slot, count], count = Min(wares, 5).
  const drawStack = (id: number): void => {
    if (id < 0) return;
    const ssp = houseByI.get(id);
    if (ssp === undefined) return;
    const cx = (h.x - 1) * CELL + ssp.px;
    const cy = (h.y - 1) * CELL + ssp.py + ssp.h - cornerHeight(h.x, h.y + 1) * PX_PER_HEIGHT;
    drawSpriteIn(housesAtlas!, houseTex, houseMaskTex, ssp, cx, cy, tint, useMask);
  };
  const inTable = supplyIn[h.typeId];
  const outTable = supplyOut[h.typeId];
  for (let slot = 0; slot < 4; slot++) {
    const inCount = slotCount(h.wareIn, spec.resIn, slot);
    if (inCount > 0 && (spec.resIn[slot] ?? -1) >= 0 && inTable !== undefined) {
      drawStack(inTable[slot * 5 + Math.min(inCount, MAX_WARES_IN_HOUSE) - 1]!);
    }
    const outCount = slotCount(h.wareOut, spec.resOut, slot);
    if (outCount > 0 && (spec.resOut[slot] ?? -1) >= 0 && outTable !== undefined) {
      drawStack(outTable[slot * 5 + Math.min(outCount, MAX_WARES_IN_HOUSE) - 1]!);
    }
  }

  // M4: fire sub-actions by damage level (a destroyed house leaves world.houses; its rubble comes
  // through the object scan).
  drawHouseFires(h, houseFireCount(h));
}

/** White ellipse ring under the selected unit (placeholder, M2b spec 5). UI: never FOW-dimmed. */
function drawRingAt(cx: number, cy: number, rw: number, rh: number): void {
  if (ringTex === null) return;
  gl!.uniform2f(uS.world, cx - rw / 2, cy - rh / 2);
  gl!.uniform2f(uS.size, rw, rh);
  gl!.uniform4f(uS.rect, 0, 0, 64, 32);
  gl!.uniform2f(uS.sheet, 64, 32);
  gl!.uniform1f(uS.hasMask, 0);
  gl!.uniform3f(uS.tint, 1, 1, 1);
  gl!.uniform1f(uS.fowOn, 0);
  gl!.activeTexture(gl!.TEXTURE0);
  gl!.bindTexture(gl!.TEXTURE_2D, ringTex);
  gl!.uniform1i(uS.tex, 0);
  gl!.drawArrays(gl!.TRIANGLE_STRIP, 0, 4);
}

/**
 * Flight progress 0..1: the sim's `t` is fPosition along the route and `length` is fLength
 * (combat.ts SimProjectile:154-172); a frozen-minimum implementation exposing only t as a
 * fraction still works (t <= 1).
 */
function projectilePct(p: SimProjectile): number {
  if (typeof p.length === 'number' && p.length > 0) return Math.max(0, Math.min(1, p.t / p.length));
  return Math.max(0, Math.min(1, p.t));
}

/**
 * Projectiles in flight (KM_Projectiles.pas:362-400 + KM_RenderPool.pas:997-1036): the sim's
 * tile-space start/end lerped by t, lifted by the Paint parabola (arc * sin(pi*t) + 0.4) and
 * drawn with the shooter's uaSpec frame; hidden when the point's revelation <= 128 (:1010-1011).
 */
function drawProjectile(p: SimProjectile, drawn: { projectiles: number; missing: number }): void {
  if (world === null || unitsAtlas === null) return;
  if (p.t < 0) return; // resolved (the sim compacts these away; defensive)
  const pct = projectilePct(p);
  const tx = p.fromX + (p.toX - p.fromX) * pct;
  const ty = p.fromY + (p.toY - p.fromY) * pct;
  const wx = tx * CELL;
  const wy = ty * CELL;
  if (fowOn) {
    const rev = fowRevAtWorld(wx, wy);
    if (rev >= 0 && rev <= FOW_HIDE_AT) return; // the game skips projectiles behind FOW
  }
  const dir = dirFromDelta(p.toX - p.fromX, p.toY - p.fromY);
  const sp = projectileSprite(p.kind, dir, pct);
  if (sp === undefined) {
    drawn.missing++;
    return;
  }
  const arc = typeof p.arc === 'number' && Number.isFinite(p.arc) && p.arc > 0 ? p.arc : PROJECTILE_ARC[p.kind] ?? 1.6;
  const cornerX = wx + sp.px - CELL;
  const cornerY = wy - (arc * Math.sin(pct * Math.PI) + 0.4) * CELL + sp.py + sp.h - CELL - terrainHeightPx(wx, wy);
  drawSpriteIn(unitsAtlas, unitTex, unitMaskTex, sp, cornerX, cornerY, WHITE, false);
  const sc = worldToScreen(cornerX, cornerY);
  projectileScreens.push({ uid: p.uid, kind: p.kind, x: sc.x, y: sc.y, w: sp.w * zoom, h: sp.h * zoom });
  drawn.projectiles++;
}

function drawHouseRing(h: EconHouse): void {
  const hs = houseSpriteOf(h);
  if (hs === null) return;
  const rw = Math.min(220, Math.max(60, hs.sp.w * 0.8));
  drawRingAt(hs.cornerX + hs.sp.w / 2, hs.cornerY + hs.sp.h - 6, rw, rw / 2);
}

// ---- terrain objects: trees, stumps, falling trees (M3 spec 2.4/2.9) --------
/** mapelem Anim sprite for a frame (looping: step = animStep mod Count + 1, KM_ResInterpolation.pas:153-174). */
function objectSprite(obj: number, frame: number): AtlasSprite | undefined {
  const anim = treeAnims[obj];
  if (anim === undefined || anim.count <= 0) return undefined;
  const step = (frame % anim.count) + 1;
  const stored = anim.steps[step - 1];
  return stored === undefined || stored < 0 ? undefined : treeByI.get(stored);
}

/** RenderMapElement1 anchor: corner from the drawn sprite, ground point from the base sprite
 *  (KM_RenderPool.pas:611-621). */
function objectAnchor(x: number, y: number, obj: number, sp: AtlasSprite): { cornerX: number; cornerY: number } {
  const anim = treeAnims[obj];
  const baseId = anim !== undefined && anim.steps.length > 0 ? anim.steps[0]! : -1;
  const base = baseId >= 0 ? treeByI.get(baseId) : undefined;
  const bx = base !== undefined ? base.px : sp.px;
  const bw = base !== undefined ? base.w : sp.w;
  const by = base !== undefined ? base.py : sp.py;
  const bh = base !== undefined ? base.h : sp.h;
  const gx = (x - 1) * CELL + bx + bw / 2;
  const gy = (y - 1) * CELL + by + bh;
  return { cornerX: (x - 1) * CELL + sp.px, cornerY: (y - 1) * CELL + sp.py + sp.h - terrainHeightPx(gx, gy) };
}

/**
 * Object tiles from the sim's Land obj bytes (PassGrid.obj, M2b terrain.ts), refreshed once per
 * tick: which objects exist is sim state (the demo forest plants 12 new trees, chopping turns
 * trees into stumps), so a boot-time map scan is not enough. Stump tiles additionally ask
 * treeAt() for the TreeAge: a stump object with TreeAge > 0 is a falling tree (spec 2.4).
 */
function objAt(idx: number): number {
  if (world === null) return objOverride.get(idx) ?? OBJ_NONE;
  const fromGrid = world.grid.obj[idx]!;
  return fromGrid !== OBJ_NONE ? fromGrid : objOverride.get(idx) ?? OBJ_NONE;
}

/** Static mode: the object tiles of the raw map (mission maps have no sim to scan each tick). */
function buildMapObjectTiles(fillStatic: boolean): void {
  if (map === null || tiles === null) return;
  const stride = map.mapX + 1;
  mapObjectTiles = [];
  for (let y = 1; y <= map.mapY; y++) {
    for (let x = 1; x <= map.mapX; x++) {
      const obj = tiles[((y - 1) * map.mapX + (x - 1)) * 4 + 3];
      if (obj !== OBJ_NONE && obj !== OBJ_BLOCK) mapObjectTiles.push(y * stride + x);
    }
  }
  if (!fillStatic) return; // tutorial: scanObjects owns objTiles/objOverride
  objTiles = mapObjectTiles.slice();
  objOverride = new Map();
  for (const idx of mapObjectTiles) {
    const x = idx % stride;
    const y = (idx - x) / stride;
    objOverride.set(idx, tiles[((y - 1) * map.mapX + (x - 1)) * 4 + 3]!);
  }
}

function scanObjects(): void {
  if (world === null) return;
  const g = world.grid;
  const stride = g.mapX + 1;
  const live: number[] = [];

  const note = (idx: number, obj: number): void => {
    live.push(idx);
    const prev = prevObj.get(idx);
    if (STUMP_OBJS.has(obj)) {
      const x = idx % stride;
      const y = (idx - x) / stride;
      const t = world!.treeAt(x, y);
      const age = t === null ? 0 : t.age;
      if (age > 0) {
        if (!falling.has(idx) && prev !== undefined && FALL_BY_FULL.has(prev)) {
          falling.set(idx, { fallObj: FALL_BY_FULL.get(prev)!, start: world!.tickCount });
        }
      } else {
        falling.delete(idx);
      }
    } else if (falling.has(idx)) {
      falling.delete(idx);
    }
    prevObj.set(idx, obj);
  };
  const clear = (idx: number): void => {
    if (prevObj.has(idx)) {
      prevObj.delete(idx);
      falling.delete(idx);
    }
  };

  for (let y = 1; y <= g.mapY; y++) {
    const row = y * stride;
    for (let x = 1; x <= g.mapX; x++) {
      const idx = row + x;
      const obj = g.obj[idx]!;
      if (obj === OBJ_NONE || obj === OBJ_BLOCK) {
        clear(idx);
        continue;
      }
      note(idx, obj);
    }
  }

  if (live.length === 0 && mapObjectTiles.length > 0) {
    // Defensive path (the shipped economy build keeps grid.obj in sync; this is insurance): ask the
    // frozen treeAt() for every object tile the raw map had, so the village still renders.
    objOverride.clear();
    for (const idx of mapObjectTiles) {
      const x = idx % stride;
      const y = (idx - x) / stride;
      const t = world.treeAt(x, y);
      if (t === null) {
        clear(idx);
        continue;
      }
      objOverride.set(idx, t.obj);
      note(idx, t.obj);
    }
    console.warn('play: grid obj bytes are empty; using the treeAt fallback for object tiles');
  }
  objTiles = live;
}

function ensureScan(): void {
  if (world === null) return;
  if (scannedTick !== world.tickCount) {
    scannedTick = world.tickCount;
    scanObjects();
  }
}

// ---- counters (page counters + the fast-forward hook) ------------------------
function counts(): Record<string, number> {
  const w = world;
  if (w === null) {
    // Static mode (a scanned non-tutorial map): the mission's entities + the raw map's objects.
    let trees = 0;
    let fullTrees = 0;
    let stumps = 0;
    let otherObjects = 0;
    for (const idx of objTiles) {
      const obj = objAt(idx);
      if (FULL_TREE_OBJS.has(obj)) {
        fullTrees++;
        trees++;
      } else if (ALL_TREE_OBJS.has(obj)) {
        trees++;
      } else if (STUMP_OBJS.has(obj)) {
        stumps++;
      } else {
        otherObjects++;
      }
    }
    return {
      tick: 0,
      houses: staticHouses.length,
      units: staticUnits.length,
      serfs: staticUnits.filter((u) => u.type === 0).length,
      tasked: 0,
      trees,
      fullTrees,
      stumps,
      falling: 0,
      otherObjects,
      trunks: 0,
      timber: 0,
      sawmillTimber: 0,
      storeTrunks: 0,
      events: 0,
      roads: roadTiles.size,
      digs: digTiles.size,
    };
  }
  ensureScan();
  let trees = 0;
  let fullTrees = 0;
  let stumps = 0;
  let otherObjects = 0;
  for (const idx of objTiles) {
    const obj = objAt(idx);
    if (FULL_TREE_OBJS.has(obj)) {
      fullTrees++;
      trees++;
    } else if (ALL_TREE_OBJS.has(obj)) {
      trees++;
    } else if (STUMP_OBJS.has(obj)) {
      stumps++;
    } else {
      otherObjects++;
    }
  }
  let trunks = 0;
  let timber = 0;
  let sawmillTimber = 0;
  let storeTrunks = 0;
  for (const h of w.houses) {
    trunks += w.wareCount(h, WT_TRUNK);
    timber += w.wareCount(h, WT_TIMBER);
    if (h.typeId === HT_SAWMILL) sawmillTimber += w.wareCount(h, WT_TIMBER);
    if (h.typeId === HT_STORE) storeTrunks += w.wareCount(h, WT_TRUNK);
  }
  return {
    tick: w.tickCount,
    houses: w.houses.length,
    units: w.units.length,
    serfs: w.units.filter((u) => u.type === 0).length,
    tasked: w.units.filter((u) => u.taskKind !== 'none').length,
    trees,
    fullTrees,
    stumps,
    falling: falling.size,
    otherObjects,
    trunks,
    timber,
    sawmillTimber,
    storeTrunks,
    events: w.events.length,
  };
}

function lastEvent(): SimEvent | null {
  if (world === null || world.events.length === 0) return null;
  return world.events[world.events.length - 1] ?? null;
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
  ensureScan();
  updateFowTexture();

  // Terrain: one drawElements (M1 renderer) + the overlay pass (roads + digs; M3 spec 2.9).
  // M4: the revelation texture multiplies the pass when FOW is on (KM_RenderTerrain.pas:1052-1119).
  gl!.useProgram(terrainProg);
  gl!.uniform2f(uT.cam, camX, camY);
  gl!.uniform1f(uT.zoom, zoom);
  gl!.uniform2f(uT.view, viewW, viewH);
  gl!.uniform1f(uT.fowOn, fowOn && fowTex !== null ? 1 : 0);
  gl!.uniform2f(uT.mapCells, map.mapX, map.mapY);
  gl!.uniform1f(uT.cell, CELL);
  if (fowTex !== null) {
    gl!.activeTexture(gl!.TEXTURE1);
    gl!.bindTexture(gl!.TEXTURE_2D, fowTex);
    gl!.uniform1i(uT.fow, 1);
  }
  gl!.activeTexture(gl!.TEXTURE0);
  gl!.bindTexture(gl!.TEXTURE_2D, sheetTex[0]!);
  gl!.uniform1i(uT.tex, 0);
  gl!.bindVertexArray(terrainVao);
  gl!.drawElements(gl!.TRIANGLES, terrainIndexCount, gl!.UNSIGNED_INT, 0);
  if (overlayVao !== null && overlayIndexCount > 0) {
    gl!.bindVertexArray(overlayVao);
    gl!.drawElements(gl!.TRIANGLES, overlayIndexCount, gl!.UNSIGNED_INT, 0);
  }
  gl!.bindVertexArray(null);

  // Sprites: rings first, then every entity sorted by its ground line (painter's order).
  const drawn = { units: 0, houses: 0, objects: 0, projectiles: 0, missing: 0 };
  const houses = activeHouses();
  const units = activeUnits();
  const cw = world;
  const projectiles = cw === null ? [] : cw.projectiles;
  if ((houses.length > 0 || units.length > 0 || objTiles.length > 0 || projectiles.length > 0) && quadVao !== null) {
    gl!.useProgram(spriteProg);
    gl!.uniform2f(uS.cam, camX, camY);
    gl!.uniform1f(uS.zoom, zoom);
    gl!.uniform2f(uS.view, viewW, viewH);
    gl!.uniform2f(uS.mapCells, map.mapX, map.mapY);
    gl!.uniform1f(uS.cell, CELL);
    if (fowTex !== null) {
      gl!.activeTexture(gl!.TEXTURE2);
      gl!.bindTexture(gl!.TEXTURE_2D, fowTex);
      gl!.uniform1i(uS.fow, 2);
    }
    gl!.bindVertexArray(quadVao);

    // Rings: every live member of the selected group (M4 group selection), else the single unit.
    const grp = selectedGroup();
    const selU = selectedUnit();
    if (grp !== null) {
      let shown = 0;
      for (const m of groupMembers(grp)) {
        if (shown >= 24) break;
        const a = unitAnchor(m);
        drawRingAt(a.x, a.y, m.uid === selectedUid ? 48 : 40, m.uid === selectedUid ? 24 : 20);
        shown++;
      }
    } else if (selU !== null) {
      const a = unitAnchor(selU);
      drawRingAt(a.x, a.y, 40, 20);
    }
    const selH = selectedHouse();
    if (selH !== null) drawHouseRing(selH);

    const stride = map.mapX + 1;
    const tick = world === null ? 0 : world.tickCount;
    const list: { y: number; run: () => void }[] = [];

    if (treesAtlas !== null) {
      for (const idx of objTiles) {
        const x = idx % stride;
        const y = (idx - x) / stride;
        const obj = objAt(idx);
        const sp = objectSprite(obj, tick);
        if (sp === undefined) {
          drawn.missing++;
        } else {
          const a = objectAnchor(x, y, obj, sp);
          const spr = sp;
          list.push({ y: a.cornerY + spr.h, run: () => { drawSpriteIn(treesAtlas!, treeTex, [], spr, a.cornerX, a.cornerY, WHITE, false); drawn.objects++; } });
        }
        // Falling trees are drawn from a separate entity (spec 2.9: non-looping elapsed steps).
        const f = falling.get(idx);
        if (f !== undefined) {
          const anim = treeAnims[f.fallObj];
          if (anim !== undefined && anim.count > 0) {
            const elapsed = Math.max(0, Math.min(tick - f.start, anim.count - 1));
            const fsp = objectSprite(f.fallObj, elapsed);
            if (fsp !== undefined) {
              const fa = objectAnchor(x, y, f.fallObj, fsp);
              list.push({ y: fa.cornerY + fsp.h, run: () => { drawSpriteIn(treesAtlas!, treeTex, [], fsp, fa.cornerX, fa.cornerY, WHITE, false); drawn.objects++; } });
            }
          }
        }
      }
    }

    for (const h of houses) {
      if (houseDestroyed(h)) continue; // demolished; the sim deletes it a tick later
      const hs = houseSpriteOf(h);
      if (hs === null) {
        drawn.missing++;
        continue;
      }
      list.push({ y: hs.cornerY + hs.sp.h, run: () => drawHouseEntity(h, drawn) });
    }

    for (const u of units) {
      if (u.inside) continue; // invisible inside a house (spec 2.6)
      if (isDeadUnit(u)) continue; // corpse closed by the sim (deleted when pointer-free)
      const sp = unitSprite(u);
      if (sp === undefined) {
        drawn.missing++;
        continue;
      }
      const a = unitAnchor(u);
      list.push({ y: a.y + sp.py + sp.h, run: () => drawUnitEntity(u, sp, a, drawn) });
    }

    // Projectiles in flight (M4): sorted into the same painter list by their ground line.
    projectileScreens = [];
    for (const p of projectiles) {
      const pct = projectilePct(p);
      const tx = p.fromX + (p.toX - p.fromX) * pct;
      const ty = p.fromY + (p.toY - p.fromY) * pct;
      const ground = (ty + 0.5 - Math.abs(Math.min(pct, 1) - 0.5) - 0.5) * CELL;
      list.push({ y: ground, run: () => drawProjectile(p, drawn) });
    }

    list.sort((p, q) => p.y - q.y);
    for (const e of list) e.run();
    gl!.bindVertexArray(null);
  }
  projectileDrawCount = drawn.projectiles;
  frameStats = { frames: frameStats.frames + 1, unitsDrawn: drawn.units, housesDrawn: drawn.houses, objectsDrawn: drawn.objects, projectilesDrawn: drawn.projectiles, missingSprites: drawn.missing };
  updateHud();
}

function updateHud(): void {
  if (map === null) return;
  const src = mapSource === null ? 'Town Tutorial (tutorial)' : `${mapSource.kind}/${mapSource.name}`;
  const fmt = mapRemake ? `Remake r${mapRev}` : 'Standard';
  const lines = [`${src}  ${map.mapX}\u00d7${map.mapY} ${fmt}  zoom=${zoom.toFixed(3)}  cam=(${Math.round(camX)},${Math.round(camY)})`];
  if (hoverX >= 1 && hoverY >= 1 && tiles !== null) {
    const off = ((hoverY - 1) * map.mapX + (hoverX - 1)) * 4;
    const walk = world === null ? '?' : tileWalkable(world.grid, hoverX, hoverY) ? 'walk' : 'blocked';
    lines.push(`tile (${hoverX},${hoverY}) index=${(hoverY - 1) * map.mapX + (hoverX - 1)} terrain=${tiles[off]} rot=${tiles[off + 2]} height=${tiles[off + 1]} obj=${tiles[off + 3]} ${walk}`);
  } else {
    lines.push('tile (-,-) move the pointer over the map');
  }
  const sel = selectedUnit();
  let line = `tick=${world === null ? 0 : world.tickCount} units=${activeUnits().length} selected=${sel === null ? '-' : sel.uid}`;
  if (sel !== null) {
    line += ` type=${sel.type} action=${sel.action} task=${sel.taskKind} pos=(${sel.posF.x.toFixed(2)},${sel.posF.y.toFixed(2)})`;
    const hp = unitHitPoints(sel);
    const fs = fightStateOf(sel);
    if (hp !== null) line += ` hp=${hp}`;
    if (fs !== 'none') line += ` fight=${fs}`;
  }
  lines.push(line);

  // M4: the selected group (count, order, condition) and the human hand's damaged houses' HP.
  if (world !== null) {
    const grp = selectedGroup();
    if (grp !== null) {
      const members = groupMembers(grp);
      const target = grp.order === 'attackUnit' ? ` unit=${grp.targetUid}` : grp.order === 'attackHouse' ? ` house=${grp.targetHouseUid}` : '';
      const at = grp.order === 'walk' || grp.order === 'attackUnit' || grp.order === 'attackHouse' ? ` @(${grp.orderX},${grp.orderY})` : '';
      lines.push(`group=${grp.uid} owner=${grp.owner} members=${members.length}/${grp.memberUids.length} order=${grp.order}${at}${target} condition=${groupCondition(grp)}`);
    } else if (selectedUid !== 0) {
      lines.push('group=- (unit is not in a warrior group)');
    }
    const hand = humanHand();
    const dmg: string[] = [];
    for (const h of activeHouses()) {
      if (h.owner !== hand) continue;
      const hp = houseHealthOf(h);
      const spec = houseSpecs[h.typeId];
      if (hp === null || spec === undefined || hp >= spec.maxHealth) continue;
      dmg.push(`${h.uid}:${hp}/${spec.maxHealth}`);
    }
    if (dmg.length > 0) lines.push(`houses dmg (hand ${hand}): ${dmg.join(' ')}`);
    const revTxt = hoverX >= 1 && hoverY >= 1 ? ` rev=(${fowTileRev(hoverX, hoverY)})` : '';
    lines.push(`fow=${fowOn ? 'on' : 'off'} hand=${fowHand} (F toggles)${revTxt}`);
  }

  if (world !== null) {
    const c = counts();
    lines.push(`houses=${c.houses} serfs=${c.serfs} trees=${c.trees} full=${c.fullTrees} stumps=${c.stumps} falling=${c.falling} trunks=${c.trunks} timber=${c.timber}`);
  } else {
    const c = counts();
    lines.push(`mission houses=${c.houses} units=${c.units} serfs=${c.serfs} trees=${c.trees} full=${c.fullTrees} roads=${c.roads} digs=${c.digs}`);
  }

  const sh = selectedHouse();
  if (sh !== null && world !== null) {
    const spec = houseSpecs[sh.typeId];
    const name = HOUSE_TYPE_NAMES[sh.typeId] ?? `type${sh.typeId}`;
    const inPart: string[] = [];
    const outPart: string[] = [];
    if (spec !== undefined) {
      for (let slot = 0; slot < 4; slot++) {
        const wi = spec.resIn[slot] ?? -1;
        const ni = slotCount(sh.wareIn, spec.resIn, slot);
        if (wi >= 0 && ni > 0) inPart.push(`${WARE_NAMES[wi] ?? wi}\u00d7${ni}`);
        const wo = spec.resOut[slot] ?? -1;
        const no = slotCount(sh.wareOut, spec.resOut, slot);
        if (wo >= 0 && no > 0) outPart.push(`${WARE_NAMES[wo] ?? wo}\u00d7${no}`);
      }
    }
    const stock: string[] = [];
    for (let ware = 0; ware < WARE_CNT; ware++) {
      const n = world.wareCount(sh, ware);
      if (n > 0) stock.push(`${WARE_NAMES[ware] ?? ware}\u00d7${n}`);
    }
    lines.push(`house=${sh.uid} ${name} owner=${sh.owner} state=${sh.state} worker=${sh.workerUid} in=[${inPart.join(' ')}] out=[${outPart.join(' ')}]`);
    const hp = houseHealthOf(sh);
    const fires = houseFireCount(sh);
    if (hp !== null && spec !== undefined) lines.push(`house hp=${hp}/${spec.maxHealth} fires=${fires}`);
    lines.push(`house stock: ${stock.join(' ') || '-'}`);
  }

  const ev = lastEvent();
  lines.push(ev === null ? 'event -' : `event [${ev.tick}] ${ev.text}`);
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

// ---- sim stepping + M2b move orders -----------------------------------------
function setCompatWalk(u: EconUnit, w: Walk | null): void {
  const holder = u as unknown as Record<string, unknown>;
  if (holder['walk'] === undefined || holder['walk'] === null) holder['walk'] = w;
}

function applyOrders(): void {
  if (world === null) return;
  while (pendingOrders.length > 0) {
    const order = pendingOrders.shift()!;
    const u = world.units.find((v) => v.uid === order.uid);
    if (u === undefined || u.inside || u.taskKind !== 'none') continue;
    const w = startWalk(world.grid, { x: u.posF.x, y: u.posF.y }, { x: order.x, y: order.y });
    if (w === null) continue;
    moves.set(u.uid, w);
    u.action = 'walk';
    setCompatWalk(u, w);
  }
}

function advanceMoves(): void {
  if (world === null) return;
  for (const [uid, w] of moves) {
    const u = world.units.find((v) => v.uid === uid);
    if (u === undefined || u.inside || u.taskKind !== 'none') {
      moves.delete(uid);
      if (u !== undefined) setCompatWalk(u, null);
      continue;
    }
    const r = walkTick(world.grid, w, u.posF, speedsFor(u.type));
    if (r.dir !== 0) u.dir = r.dir;
    u.animStep += r.animStep;
    if (r.status !== 'walking') {
      u.action = 'stay';
      moves.delete(uid);
      setCompatWalk(u, null);
    }
  }
}

function stepWorld(): void {
  if (world === null) return;
  world.tick();
  advanceMoves();
  applyOrders();
}

// ---- input (M2b spec 5 + M3 camera keys + M4 group orders) -------------------
function selectAt(sx: number, sy: number): void {
  let best: EconUnit | null = null;
  let bestDist = SELECT_RADIUS_PX;
  for (const u of activeUnits()) {
    if (u.inside || isDeadUnit(u)) continue;
    const p = unitSpriteCenterScreen(u);
    if (p === null) continue;
    const d = Math.hypot(p.x - sx, p.y - sy);
    if (d <= bestDist) {
      bestDist = d;
      best = u;
    }
  }
  if (best !== null) {
    selectedUid = best.uid;
    selectedHouseUid = 0;
    selectedGroupUid = groupUidOf(best.uid); // M4: click selects the unit and its group
    return;
  }
  // No unit under the cursor: a house sprite rect (topmost drawn one wins).
  let pick: EconHouse | null = null;
  let pickY = -Infinity;
  for (const h of activeHouses()) {
    const hs = houseSpriteOf(h);
    if (hs === null) continue;
    const tl = worldToScreen(hs.cornerX, hs.cornerY);
    if (sx >= tl.x && sx <= tl.x + hs.sp.w * zoom && sy >= tl.y && sy <= tl.y + hs.sp.h * zoom) {
      const bottom = hs.cornerY + hs.sp.h;
      if (bottom > pickY) {
        pick = h;
        pickY = bottom;
      }
    }
  }
  selectedUid = 0;
  selectedGroupUid = 0;
  selectedHouseUid = pick === null ? 0 : pick.uid;
}

/** Nearest unit of a different owner under the cursor (an attack target for the selected group). */
function enemyUnitAt(sx: number, sy: number): EconUnit | null {
  const hand = humanHand();
  let best: EconUnit | null = null;
  let bestDist = SELECT_RADIUS_PX;
  for (const u of activeUnits()) {
    if (u.inside || isDeadUnit(u) || u.owner === hand) continue;
    const p = unitSpriteCenterScreen(u);
    if (p === null) continue;
    const d = Math.hypot(p.x - sx, p.y - sy);
    if (d <= bestDist) {
      bestDist = d;
      best = u;
    }
  }
  return best;
}

/** Topmost house of a different owner under the cursor (an attack target for the selected group). */
function enemyHouseAt(sx: number, sy: number): EconHouse | null {
  const hand = humanHand();
  let pick: EconHouse | null = null;
  let pickY = -Infinity;
  for (const h of activeHouses()) {
    if (h.owner === hand) continue;
    const hs = houseSpriteOf(h);
    if (hs === null) continue;
    const tl = worldToScreen(hs.cornerX, hs.cornerY);
    if (sx >= tl.x && sx <= tl.x + hs.sp.w * zoom && sy >= tl.y && sy <= tl.y + hs.sp.h * zoom) {
      const bottom = hs.cornerY + hs.sp.h;
      if (bottom > pickY) {
        pick = h;
        pickY = bottom;
      }
    }
  }
  return pick;
}

/** Right-click order (M2b): walk to the tile under the cursor; flash red when findPath is null.
 *  M3 scope: hand-0 units without a task only (the economy sim owns every other unit). */
function orderWalkAt(vx: number, vy: number): void {
  if (world === null) return;
  const u = selectedUnit();
  if (u === null) return; // nothing selected: no order, no flash
  if (u.owner !== 0 || u.inside || u.taskKind !== 'none') {
    flashHud();
    return;
  }
  const r = cv.getBoundingClientRect();
  const tile = tileAtPoint(vx - r.left, vy - r.top);
  if (tile === null) return;
  const from = { x: Math.round(u.posF.x), y: Math.round(u.posF.y) };
  if (findPath(world.grid, from, tile) === null) {
    flashHud();
    return;
  }
  pendingOrders.push({ uid: u.uid, x: tile.x, y: tile.y });
}

/**
 * M4 right-click: a selected warrior group of the human hand orders walk / attack through the
 * frozen world.orderGroup (attack = enemy unit or house under the cursor, KM_UnitGroup.pas orders).
 * A selected unit without a group keeps the M3 viewer-side walk (economy demo unchanged).
 */
function orderAt(vx: number, vy: number): void {
  const r = cv.getBoundingClientRect();
  const sx = vx - r.left;
  const sy = vy - r.top;
  const grp = selectedGroup();
  if (world !== null && grp !== null && grp.owner === humanHand()) {
    const tile = tileAtPoint(sx, sy);
    if (tile === null) return;
    const enemy = enemyUnitAt(sx, sy);
    if (enemy !== null) {
      try {
        if (!world.orderGroup(grp.uid, 'attackUnit', enemy.posF.x, enemy.posF.y, enemy.uid)) flashHud();
      } catch {
        flashHud();
      }
      return;
    }
    const house = enemyHouseAt(sx, sy);
    if (house !== null) {
      try {
        if (!world.orderGroup(grp.uid, 'attackHouse', house.x, house.y, house.uid)) flashHud();
      } catch {
        flashHud();
      }
      return;
    }
    try {
      if (!world.orderGroup(grp.uid, 'walk', tile.x, tile.y)) flashHud();
    } catch {
      flashHud();
    }
    return;
  }
  orderWalkAt(vx, vy);
}

function bindInput(): void {
  let downX = 0;
  let downY = 0;
  cv.addEventListener('pointerdown', (e) => {
    if (e.button === 2) {
      orderAt(e.clientX, e.clientY);
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
    // The picker's filter box owns its keystrokes (M3b): only Escape acts globally.
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
    if (e.key === 'f' || e.key === 'F') {
      fowOn = !fowOn;
      fowDirtyTick = -1;
      return;
    }
    if (e.key === 'r' || e.key === 'R') {
      resetView();
      return;
    }
    const n = Number(e.key);
    if (n >= 1 && n <= 3) jumpToVillage(n - 1); // keys 1/2/3 jump to the north/south/NE village
  });
}

// ---- tick loop: 10 ticks/s, catch-up <= 5 (spec 5) --------------------------
function frame(now: number): void {
  try {
    acc += now - lastFrame;
    lastFrame = now;
    if (world !== null) {
      let steps = 0;
      while (acc >= TICK_MS && steps < MAX_CATCHUP) {
        stepWorld();
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

// ---- M3b map picker (docs/M3B-SPIKE.md section 5) ---------------------------
const pickerEl = document.getElementById('picker') as HTMLDivElement;
const pickerListEl = document.getElementById('pickerlist') as HTMLDivElement;
const pickerCountEl = document.getElementById('pickercount') as HTMLSpanElement;
const filterEl = document.getElementById('filter') as HTMLInputElement;

function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** List from /maps: name, size, players, Remake r<rev>/Standard, tactic/building (spec section 5). */
function renderPickerList(): void {
  const q = filterEl.value.trim().toLowerCase();
  const items = mapList.filter((m) => q === '' || m.name.toLowerCase().includes(q));
  pickerCountEl.textContent = `${items.length}/${mapList.length}`;
  const rows: string[] = [
    '<button class="maprow tutorial" data-tutorial="1"><b>Town Tutorial</b> <span class="dim">128\u00d7128 tutorial \u00b7 economy demo</span></button>',
  ];
  for (const m of items) {
    const fmt = m.remake ? `Remake r${m.rev}` : 'Standard';
    const mode = m.tactic ? 'tactic' : 'building';
    rows.push(
      `<button class="maprow" data-kind="${escHtml(m.kind)}" data-name="${escHtml(m.name)}">` +
        `<b>${escHtml(m.name)}</b> <span class="dim">${m.mapX}\u00d7${m.mapY} ${m.maxPlayers}P ${fmt} ${mode}</span></button>`,
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

function bindPicker(): void {
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

// ---- map loading (M3b: tutorial default + any scanned map) ------------------
/** Per-load state reset; atlases, defines and sprite lookups survive a map switch. */
function resetMapState(): void {
  world = null;
  staticHouses = [];
  staticUnits = [];
  mission = null;
  loadedMap = null;
  baseTerrain = null;
  mapInfo = null;
  mapSource = null;
  mapRev = 0;
  mapRemake = false;
  objTiles = [];
  prevObj = new Map();
  falling = new Map();
  scannedTick = -1;
  objOverride = new Map();
  mapObjectTiles = [];
  roadTiles = new Set();
  digTiles = new Map();
  moves = new Map();
  pendingOrders = [];
  speedCache = new Map();
  selectedUid = 0;
  selectedHouseUid = 0;
  selectedGroupUid = 0;
  currentKaMap = null;
  fowHand = HUMAN_HAND_FALLBACK;
  fowDirtyTick = -1;
  fowTexW = 0;
  fowTexH = 0;
  hoverX = -1;
  hoverY = -1;
  acc = 0;
}

/** Build the VBOs + camera for the freshly installed map; a good load clears the error box. */
function finishLoad(): void {
  buildTerrainVbo(tilesByI);
  buildOverlayVbo();
  viewW = cv.clientWidth;
  viewH = cv.clientHeight;
  resetView();
  errBox.textContent = '';
  updateHud();
}

/** Mission houses as viewer entities (the shape the economy world builds; no wares/workers). */
function buildStaticHouses(m: Mission): EconHouse[] {
  const out: EconHouse[] = [];
  let uid = 1;
  for (const mh of m.houses) {
    const spec = houseSpecs[mh.typeId];
    out.push({
      uid: uid++,
      typeId: mh.typeId,
      owner: mh.owner,
      x: mh.x,
      y: mh.y,
      entrance: { x: mh.x + (spec !== undefined ? spec.entranceDx : 0), y: mh.y },
      state: 'empty',
      wareIn: [0, 0, 0, 0],
      wareOut: [0, 0, 0, 0],
      workerUid: 0,
      animStep: 0,
      workAnimStep: 0,
      maxHealth: spec !== undefined ? spec.maxHealth : 0,
      damage: 0,
      destroyed: false,
      fireLevel: 0,
    });
  }
  return out;
}

/** Mission humanoid units as static viewer entities (animals stay parsed-only, M3 spec 2.1). */
function buildStaticUnits(m: Mission): EconUnit[] {
  const out: EconUnit[] = [];
  let uid = 1;
  for (const mu of m.units) {
    if (mu.owner < 0) continue;
    if (mu.typeId < 0 || mu.typeId >= specs.length) continue;
    out.push({
      uid: uid++,
      owner: mu.owner,
      type: mu.typeId,
      posF: { x: mu.x, y: mu.y },
      dir: 0,
      animStep: 0,
      action: 'stay',
      carry: -1,
      inside: false,
      homeUid: 0,
      taskKind: 'none',
      hitPoints: 0,
      groupUid: 0,
      fightState: 'none',
      dead: false,
    });
  }
  return out;
}

/** The Town Tutorial: the frozen M1 export + the real mission, economy world + demo scenario. */
async function loadTutorial(): Promise<void> {
  const token = ++loadToken;
  resetMapState();
  const [mapData, missionBuf] = await Promise.all([
    fetchJson<MapJson>('/out/maps/TownTutorial.json'),
    fetchBytes('/mission/TownTutorial.dat'),
  ]);
  if (token !== loadToken) return;
  const tileBytes = base64ToBytes(mapData.tiles);
  map = { file: mapData.file, mapX: mapData.mapX, mapY: mapData.mapY };
  tiles = tileBytes;
  mission = parseMissionScript(missionBuf, mapData.mapX, mapData.mapY);
  fowHand = humanHand();

  // Road overlay tiles: mission.streets are map coords (spec 2.1: SET_STREET places (x+1, y+1)).
  const stride = mapData.mapX + 1;
  for (const st of mission.streets) roadTiles.add(st.y * stride + st.x);
  buildMapObjectTiles(false);

  const n = mapData.mapX * mapData.mapY;
  const kaMap = {
    file: mapData.file,
    mapX: mapData.mapX,
    mapY: mapData.mapY,
    tiles: tileBytes,
    remake: false,
    rev: 0,
    overlay: new Uint8Array(n),
    layers: new Uint8Array(n),
    layerBytes: null,
    tail: { resHead: null, mapEdChunk: false, tailBytes: 0 },
  } as KaMap;
  world = createEconomyWorld({ map: kaMap, tiles: tileFlags, elems, unitSpecs: specs, serfCarry, houseSpecs, mission });
  currentKaMap = kaMap;
  applyDemoScenario(world);

  // M2b compat shim: SimUnit.speed on the live units for the CDP hooks (the frozen EconUnit has no
  // speed field; a field the sim owns is never overwritten).
  for (const u of world.units) {
    const holder = u as unknown as Record<string, unknown>;
    if (holder['speed'] === undefined) holder['speed'] = speedsFor(u.type);
  }

  finishLoad();
  ensureScan();
  jumpToVillage(1); // boot into the economy village (hand 1); R fits the whole map again
}

/** Any scanned map: terrain + the mission's houses/units/streets as-is (no economy world). */
async function loadScannedMap(kind: string, name: string): Promise<void> {
  const token = ++loadToken;
  resetMapState();
  const base = `/mapfile/${encodeURIComponent(kind)}/${encodeURIComponent(name)}`;
  const [mapBuf, datBuf] = await Promise.all([fetchBytes(`${base}/map`), fetchBytes(`${base}/dat`)]);
  if (token !== loadToken) return;
  const lm = parseMapBytes(mapBuf, `${kind}/${name}`);
  loadedMap = lm;
  currentKaMap = lm;
  map = { file: `${name}.map`, mapX: lm.mapX, mapY: lm.mapY };
  tiles = lm.tiles;
  baseTerrain = lm.baseTerrain;
  mapRev = lm.rev;
  mapRemake = lm.remake;
  mapSource = { kind, name };
  mapInfo = mapList.find((m) => m.kind === kind && m.name === name) ?? null;
  mission = parseMissionScript(datBuf, lm.mapX, lm.mapY);
  fowHand = humanHand();

  // Stored overlays (Remake maps): toRoad joins the mission streets in the road set, toDig1..4
  // become the plain dig sprites (spec section 5; standard maps carry all-zero overlays).
  const stride = lm.mapX + 1;
  for (let ty = 1; ty <= lm.mapY; ty++) {
    for (let tx = 1; tx <= lm.mapX; tx++) {
      const ov = lm.overlay[(ty - 1) * lm.mapX + (tx - 1)]!;
      if (ov === 5) roadTiles.add(ty * stride + tx);
      else if (ov >= 1 && ov <= 4) digTiles.set(ty * stride + tx, ov);
    }
  }
  for (const st of mission.streets) roadTiles.add(st.y * stride + st.x);
  buildMapObjectTiles(true);
  staticHouses = buildStaticHouses(mission);
  staticUnits = buildStaticUnits(mission);
  finishLoad();
}

function setUrlMap(kind: string | null, name: string | null): void {
  const u = new URL(location.href);
  if (kind === null || name === null) {
    u.searchParams.delete('kind');
    u.searchParams.delete('name');
  } else {
    u.searchParams.set('kind', kind);
    u.searchParams.set('name', name);
  }
  history.replaceState(null, '', u.toString());
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

// ---- M4 combat helpers (viewer-side world setup for the CDP proof + the lead) ----------------
/** Build the economy/combat world for the current scanned map on demand. The M3b page loads other
 *  maps static (no sim); the frozen world API needs a world to fight in, so this switches the page
 *  to economy mode for the current map. The tutorial is already economy. */
function enableCombatWorld(): { ok: boolean; mode: string; reason?: string } {
  if (world !== null) return { ok: true, mode: 'economy' };
  if (currentKaMap === null || mission === null) return { ok: false, mode: 'static', reason: 'no map loaded' };
  try {
    world = createEconomyWorld({ map: currentKaMap, tiles: tileFlags, elems, unitSpecs: specs, serfCarry, houseSpecs, mission });
  } catch (err) {
    world = null;
    return { ok: false, mode: 'static', reason: err instanceof Error ? err.message : String(err) };
  }
  scannedTick = -1;
  prevObj = new Map();
  falling = new Map();
  moves = new Map();
  pendingOrders = [];
  selectedUid = 0;
  selectedGroupUid = 0;
  selectedHouseUid = 0;
  ensureScan();
  updateHud();
  return { ok: true, mode: 'economy' };
}

/** House footprint tiles of the current mission (the same plan the world carves out of the walk
 *  grid; keeps the scripted fight from spawning inside a house). */
function missionHouseTiles(): Set<number> {
  const out = new Set<number>();
  if (mission === null || currentKaMap === null) return out;
  const stride = currentKaMap.mapX + 1;
  for (const mh of mission.houses) {
    const plan = housePlan(mh.typeId);
    for (let i = 1; i <= 4; i++) {
      for (let k = 1; k <= 4; k++) {
        if (plan[i - 1]![k - 1] === 0) continue;
        const tx = mh.x + k - 3;
        const ty = mh.y + i - 4;
        if (tx >= 1 && ty >= 1 && tx <= currentKaMap.mapX && ty <= currentKaMap.mapY) out.add(ty * stride + tx);
      }
    }
  }
  return out;
}

/** Walkable tiles around an anchor, nearest ring first, skipping house tiles and used spots. */
function openTilesNear(g: PassGrid, cx: number, cy: number, count: number, houseTiles: Set<number>, used: Set<number>): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  const stride = g.mapX + 1;
  for (let r = 0; r <= 16 && out.length < count; r++) {
    for (let dy = -r; dy <= r && out.length < count; dy++) {
      for (let dx = -r; dx <= r && out.length < count; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = cx + dx;
        const y = cy + dy;
        if (x < 1 || y < 1 || x > g.mapX - 1 || y > g.mapY - 1) continue;
        const idx = y * stride + x;
        if (used.has(idx) || houseTiles.has(idx)) continue;
        if (!tileWalkable(g, x, y)) continue;
        used.add(idx);
        out.push({ x, y });
      }
    }
  }
  return out;
}

interface FightPlan { owner: number; typeId: number; anchorX: number; anchorY: number; count: number; dir: number }
interface FightGroupReport { owner: number; groupUid: number; typeId: number; members: number[] }
interface FightReport { ok: boolean; reason?: string; mode?: string; spawned?: number; groups?: FightGroupReport[] }

/**
 * Scripted skirmish for the viewer proof: first tries the sim's own script group constructor
 * (spawnGroup — the game's TKMUnitGroup.Create from `!SET_GROUP`, combat.ts:2413-2436, needs the
 * world's spawnUnit/newGroup); falls back to rebuilding the world with a synthetic mission, which
 * the frozen createEconomyWorld turns into units + warrior groups. Default plan: 3 bowmen + 2
 * sword fighters per side, 8 tiles between the archers (inside the 4..10.99 range).
 */
function scriptedFight(plan?: FightPlan[]): FightReport {
  if (world === null) {
    const en = enableCombatWorld();
    if (!en.ok) return { ok: false, reason: en.reason ?? 'no world' };
  }
  if (mission === null || currentKaMap === null) return { ok: false, reason: 'no mission or map loaded' };
  if (world === null) return { ok: false, reason: 'no world (enableCombatWorld failed?)' };
  const mx = currentKaMap.mapX;
  const my = currentKaMap.mapY;
  const cx = Math.max(2, Math.floor(mx / 2));
  const cy = Math.max(2, Math.floor(my / 2));
  const specsPlan: FightPlan[] = plan ?? [
    { owner: 0, typeId: UT_BOWMAN, anchorX: cx - 4, anchorY: cy, count: 3, dir: 3 },
    { owner: 0, typeId: UT_SWORDFIGHTER, anchorX: cx - 2, anchorY: cy, count: 2, dir: 3 },
    { owner: 1, typeId: UT_BOWMAN, anchorX: cx + 4, anchorY: cy, count: 3, dir: 7 },
    { owner: 1, typeId: UT_SWORDFIGHTER, anchorX: cx + 2, anchorY: cy, count: 2, dir: 7 },
  ];
  const g = buildPassGrid(currentKaMap, tileFlags, elems);
  const houseTiles = missionHouseTiles();
  const used = new Set<number>();
  const spots: { owner: number; typeId: number; x: number; y: number; dir: number }[] = [];
  for (const p of specsPlan) {
    for (const s of openTilesNear(g, p.anchorX, p.anchorY, p.count, houseTiles, used)) {
      spots.push({ owner: p.owner, typeId: p.typeId, x: s.x, y: s.y, dir: p.dir });
    }
  }
  if (spots.length === 0) return { ok: false, reason: 'no open tiles near the map centre' };

  // 1) the sim's own script constructor (spawnGroup + the world's spawnUnit/newGroup).
  const wv = world as unknown as { spawnUnit?: unknown; newGroup?: unknown };
  if (typeof wv.spawnUnit === 'function' && typeof wv.newGroup === 'function') {
    try {
      const groups: FightGroupReport[] = [];
      let spawned = 0;
      for (const p of specsPlan) {
        const anchor = openTilesNear(g, p.anchorX, p.anchorY, 1, houseTiles, used)[0];
        if (anchor === undefined) continue;
        const grp = spawnGroup(world as unknown as Parameters<typeof spawnGroup>[0], p.owner, p.typeId, anchor.x, anchor.y, p.dir, p.count, p.count);
        spawned += grp.memberUids.length;
        groups.push({ owner: p.owner, groupUid: grp.uid, typeId: p.typeId, members: grp.memberUids.slice() });
      }
      if (groups.length > 0) {
        selectedUid = 0;
        selectedGroupUid = 0;
        ensureScan();
        updateHud();
        return { ok: true, mode: 'spawn', spawned, groups };
      }
    } catch {
      // fall through to the synthetic-mission rebuild
    }
  }

  // 2) frozen-interface fallback: rebuild the world with a synthetic mission.
  const units: MissionUnit[] = mission.units.map((u) => ({ typeId: u.typeId, x: u.x, y: u.y, owner: u.owner }));
  for (const s of spots) units.push({ typeId: s.typeId, x: s.x, y: s.y, owner: s.owner });
  const synth: Mission = { ...mission, units };
  let w2: EconomyWorld;
  try {
    w2 = createEconomyWorld({ map: currentKaMap, tiles: tileFlags, elems, unitSpecs: specs, serfCarry, houseSpecs, mission: synth });
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
  world = w2;
  scannedTick = -1;
  prevObj = new Map();
  falling = new Map();
  moves = new Map();
  pendingOrders = [];
  selectedUid = 0;
  selectedGroupUid = 0;
  selectedHouseUid = 0;
  ensureScan();
  updateHud();

  // The spawned warriors are the last `spots.length` units (buildUnits keeps mission order).
  const spawned = world.units.slice(Math.max(0, world.units.length - spots.length));
  const byGroup = new Map<number, FightGroupReport>();
  for (const u of spawned) {
    const guid = groupUidOf(u.uid);
    if (guid === 0) continue;
    let entry = byGroup.get(guid);
    if (entry === undefined) {
      entry = { owner: u.owner, groupUid: guid, typeId: u.type, members: [] };
      byGroup.set(guid, entry);
    }
    entry.members.push(u.uid);
  }
  return { ok: true, mode: 'rebuild', spawned: spots.length, groups: [...byGroup.values()] };
}

// ---- test hook (the CDP proof script drives the page through it) ------------
function installHook(): void {
  const hook = {
    TICK_MS,
    get world() {
      return world;
    },
    tick: () => (world === null ? -1 : world.tickCount),
    units: () => activeUnits(),
    unitOf: (uid: number) => activeUnits().find((u) => u.uid === uid) ?? null,
    houses: () => activeHouses(),
    houseOf: (uid: number) => activeHouses().find((h) => h.uid === uid) ?? null,
    counts: () => counts(),
    /** Fast-forward the world n ticks and return the fresh counters (acceptance hook). */
    fastForward: (n: number) => {
      if (world === null) return counts(); // static map: nothing to step
      const steps = Math.max(0, Math.min(1_000_000, Math.floor(n)));
      for (let i = 0; i < steps; i++) world.tick();
      ensureScan();
      fowDirtyTick = -1;
      return counts();
    },
    selectedUid: () => selectedUid,
    selectedHouseUid: () => selectedHouseUid,
    frameStats: () => ({ ...frameStats }),
    zoom: () => zoom,
    cam: () => ({ x: camX, y: camY }),
    /** Test hook: aim the camera at a world px point (optional zoom). */
    setCam: (x: number, y: number, z?: number) => {
      camX = x;
      camY = y;
      if (typeof z === 'number' && Number.isFinite(z)) zoom = Math.min(MAX_ZOOM, Math.max(Math.min(MIN_ZOOM, fitZoom), z));
      hoverX = -1;
      hoverY = -1;
    },
    speedOf: (uid: number) => {
      const u = activeUnits().find((v) => v.uid === uid);
      return u === undefined ? null : speedsFor(u.type);
    },
    walkOf: (uid: number) => moves.get(uid) ?? null,
    treeAt: (x: number, y: number) => (world === null ? null : world.treeAt(x, y)),
    /** Stump tiles the viewer is drawing (obj = the stump object id). */
    stumps: () => {
      const out: { x: number; y: number; obj: number }[] = [];
      if (map === null) return out;
      const stride = map.mapX + 1;
      for (const idx of objTiles) {
        const obj = objAt(idx);
        if (!STUMP_OBJS.has(obj)) continue;
        const x = idx % stride;
        out.push({ x, y: (idx - x) / stride, obj });
      }
      return out;
    },
    /** Falling-tree entities the viewer is drawing (fallObj + start tick). */
    fallingTiles: () => {
      const out: { x: number; y: number; fallObj: number; start: number }[] = [];
      if (map === null) return out;
      const stride = map.mapX + 1;
      for (const [idx, f] of falling) {
        const x = idx % stride;
        out.push({ x, y: (idx - x) / stride, fallObj: f.fallObj, start: f.start });
      }
      return out;
    },
    roadTiles: () => roadTiles.size,
    roadQuads: () => roadQuadCount,
    digTiles: () => digTiles.size,
    digQuads: () => digQuadCount,
    /** World px -> viewport css px (what CDP Input.dispatchMouseEvent wants). */
    viewportOf: (wx: number, wy: number) => {
      const r = cv.getBoundingClientRect();
      const p = worldToScreen(wx, wy);
      return { x: r.left + p.x, y: r.top + p.y };
    },
    /** Unit sprite centre -> viewport css px, or null when it has no sprite. */
    viewportOfUnit: (uid: number) => {
      const u = activeUnits().find((x) => x.uid === uid);
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
    tileWalkable: (x: number, y: number) => (world === null ? false : tileWalkable(world.grid, x, y)),
    findPath: (from: { x: number; y: number }, to: { x: number; y: number }) =>
      world === null ? null : findPath(world.grid, from, to),
    spriteOf: (uid: number) => {
      const u = activeUnits().find((x) => x.uid === uid);
      return u === undefined ? null : unitSprite(u) ?? null;
    },
    // ---- M3b hooks (the picker + any-map CDP proof) --------------------------
    /** Current map: source (null = tutorial), size, format, and the readable entity/overlay counts. */
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
            mode: world === null ? 'static' : 'economy',
            houses: activeHouses().length,
            units: activeUnits().length,
            missionUnits: mission === null ? 0 : mission.units.length,
            animals: mission === null ? 0 : mission.units.filter((u) => u.owner < 0).length,
            roads: roadTiles.size,
            digs: digTiles.size,
            overlayTiles: loadedMap === null ? 0 : loadedMap.overlay.reduce((n, v) => n + (v !== 0 ? 1 : 0), 0),
            layers: loadedMap === null ? 0 : loadedMap.layers.reduce((n, v) => n + (v > 0 ? 1 : 0), 0),
            tailBytes: loadedMap === null ? 0 : loadedMap.tail.tailBytes,
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

    // ---- M4 hooks (docs/M4-SPIKE.md section 5: FOW, groups, projectiles, houses, orders) ----
    /** Tile revelation of the current FOW hand, 1-based tile (0..255; -1 = no FOW data). */
    fowAt: (x: number, y: number) => fowTileRev(x, y),
    fowVertAt: (x: number, y: number) => fowVertRev(x, y),
    fowOn: () => fowOn,
    /** Toggle (or set) the FOW rendering; returns the new state. */
    fowToggle: (on?: boolean) => {
      fowOn = typeof on === 'boolean' ? on : !fowOn;
      fowDirtyTick = -1;
      return fowOn;
    },
    fowHand: () => fowHand,
    setFowHand: (h: number) => {
      fowHand = Number.isFinite(h) ? Math.max(0, Math.floor(h)) : HUMAN_HAND_FALLBACK;
      fowDirtyTick = -1;
      return fowHand;
    },
    humanHand: () => humanHand(),
    /** Projectiles in flight (frozen SimProjectile list, copied). */
    projectiles: () => (world === null ? [] : world.projectiles.map((p) => ({ ...p }))),
    /** Projectiles actually drawn in the last frame (FOW-hidden ones are skipped). */
    projectileDraws: () => projectileDrawCount,
    /** Viewport rects of the projectiles drawn in the last frame (css px, canvas-relative). */
    projectileScreens: () => projectileScreens.map((p) => ({ ...p })),
    /** Warrior groups (frozen SimGroup list, copied). */
    groups: () => (world === null ? [] : world.groups.map((g) => ({ ...g, memberUids: g.memberUids.slice() }))),
    groupOf: (uid: number) => {
      if (world === null) return null;
      const g = world.groupOf(uid);
      return g === null || g === undefined ? null : { ...g, memberUids: g.memberUids.slice() };
    },
    selectedGroupUid: () => selectedGroupUid,
    selectedGroup: () => {
      const g = selectedGroup();
      return g === null ? null : { ...g, memberUids: g.memberUids.slice() };
    },
    /** The viewer-side group condition (fighting/walking/attacking/halted/idle/dead). */
    groupCondition: (uid: number) => {
      const g = world === null ? null : world.groups.find((x) => x.uid === uid) ?? null;
      return g === null ? null : groupCondition(g);
    },
    unitHealth: (uid: number) => {
      if (world === null) return null;
      const v = world.unitHealth(uid);
      return typeof v === 'number' && Number.isFinite(v) ? v : null;
    },
    houseHealth: (uid: number) => {
      const h = activeHouses().find((x) => x.uid === uid);
      return h === undefined ? null : houseHealthOf(h);
    },
    /** MaxHealth accessor: the sim's house field, else the parsed spec. */
    houseMaxHealth: (uid: number) => {
      const h = activeHouses().find((x) => x.uid === uid);
      if (h === undefined) return null;
      if (Number.isFinite(h.maxHealth)) return h.maxHealth;
      const spec = houseSpecs[h.typeId];
      return spec === undefined ? null : spec.maxHealth;
    },
    /** One house's combat summary (health, max, fires, destroyed) for the proof. */
    houseCombat: (uid: number) => {
      const h = activeHouses().find((x) => x.uid === uid);
      if (h === undefined) return null;
      return {
        uid: h.uid,
        owner: h.owner,
        typeId: h.typeId,
        health: houseHealthOf(h),
        maxHealth: Number.isFinite(h.maxHealth) ? h.maxHealth : houseSpecs[h.typeId]?.maxHealth ?? null,
        fires: houseFireCount(h),
        destroyed: houseDestroyed(h),
      };
    },
    /** Fire sub-action sprites the viewer is drawing for a house (0..8). */
    houseFires: (uid: number) => {
      const h = activeHouses().find((x) => x.uid === uid);
      return h === undefined ? null : houseFireCount(h);
    },
    damageHouse: (uid: number, amount: number, attackerUid = 0) => {
      if (world === null) return false;
      try {
        world.damageHouse(uid, amount, attackerUid);
        return true;
      } catch {
        return false;
      }
    },
    /** Rubble tiles the viewer is drawing (obj 68..73 — KM_Terrain.pas:4936). */
    rubble: () => {
      const out: { x: number; y: number; obj: number }[] = [];
      if (map === null) return out;
      const stride = map.mapX + 1;
      for (const idx of objTiles) {
        const obj = objAt(idx);
        if (!RUBBLE_OBJS.has(obj)) continue;
        const x = idx % stride;
        out.push({ x, y: (idx - x) / stride, obj });
      }
      return out;
    },
    /** Refresh the viewer's object scan now (no sim tick) — proof helper for rubble after Demolish. */
    rescan: () => {
      if (world === null) return 0;
      scannedTick = -1;
      scanObjects();
      return objTiles.length;
    },
    /** Order any group through the frozen orderGroup (the UI itself orders the human hand only). */
    orderGroup: (uid: number, kind: 'walk' | 'attackUnit' | 'attackHouse' | 'halt' | 'none', x: number, y: number, target?: number) => {
      if (world === null) return false;
      try {
        return world.orderGroup(uid, kind, x, y, target);
      } catch {
        return false;
      }
    },
    orderAttack: (groupUid: number, targetUid: number) => {
      if (world === null) return false;
      try {
        return world.orderGroup(groupUid, 'attackUnit', 0, 0, targetUid);
      } catch {
        return false;
      }
    },
    orderAttackHouse: (groupUid: number, houseUid: number) => {
      if (world === null) return false;
      try {
        return world.orderGroup(groupUid, 'attackHouse', 0, 0, houseUid);
      } catch {
        return false;
      }
    },
    orderWalk: (groupUid: number, x: number, y: number) => {
      if (world === null) return false;
      try {
        return world.orderGroup(groupUid, 'walk', x, y);
      } catch {
        return false;
      }
    },
    orderHalt: (groupUid: number) => {
      if (world === null) return false;
      try {
        return world.orderGroup(groupUid, 'halt', 0, 0);
      } catch {
        return false;
      }
    },
    combatMode: () => (world === null ? 'none' : 'combat'),
    /** Build the economy/combat world for the current scanned map (M3b loads other maps static). */
    enableCombatWorld: () => enableCombatWorld(),
    /** Scripted skirmish (spawnGroup, else a synthetic-mission rebuild); returns the spawned groups. */
    scriptedFight: (plan?: FightPlan[]) => scriptedFight(plan),
  };
  (window as unknown as Record<string, unknown>).__kamplay = hook;
}

// ---- boot -------------------------------------------------------------------
async function boot(): Promise<void> {
  const [tilesetData, unitsData, housesData, treesData, tilesText, mapelemBuf, unitdatBuf, housesBuf, mapsJson] = await Promise.all([
    fetchJson<Atlas>('/out/atlas/Tileset.json'),
    fetchJson<Atlas>('/out/atlas/Units.json'),
    fetchJson<Atlas>('/out/atlas/Houses.json'),
    fetchJson<Atlas>('/out/atlas/Trees.json'),
    fetchText('/defines/tiles.json'),
    fetchBytes('/defines/mapelem.dat'),
    fetchBytes('/defines/unit.dat'),
    fetchBytes('/defines/houses.dat'),
    fetchJson<MapInfoView[]>('/maps'),
  ]);

  atlas = tilesetData;
  unitsAtlas = unitsData;
  housesAtlas = housesData;
  treesAtlas = treesData;

  specs = parseUnitDat(unitdatBuf);
  serfCarry = parseSerfCarry(unitdatBuf);
  elems = parseMapElem(mapelemBuf);
  treeAnims = parseElemAnims(mapelemBuf);
  houseSpecs = parseHousesDat(housesBuf);
  const supply = parseSupplyTables(housesBuf);
  supplyIn = supply.in;
  supplyOut = supply.out;
  houseFireAnims = parseHouseFireAnims(housesBuf);
  tileFlags = parseTilesJson(tilesText);
  mapList = mapsJson
    .slice()
    .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'Maps' ? -1 : 1));

  sheetTex = await Promise.all(tilesetData.sheets.map((s) => loadTexture(`/out/atlas/${s.file}`)));
  unitTex = await Promise.all(unitsData.sheets.map((s) => loadTexture(`/out/atlas/${s.file}`)));
  unitMaskTex = await Promise.all((unitsData.maskSheets ?? []).map((s) => loadTexture(`/out/atlas/${s.file}`)));
  houseTex = await Promise.all(housesData.sheets.map((s) => loadTexture(`/out/atlas/${s.file}`)));
  houseMaskTex = await Promise.all((housesData.maskSheets ?? []).map((s) => loadTexture(`/out/atlas/${s.file}`)));
  treeTex = await Promise.all(treesData.sheets.map((s) => loadTexture(`/out/atlas/${s.file}`)));

  unitByI = new Map();
  for (const sp of unitsData.sprites) unitByI.set(sp.i, sp);
  houseByI = new Map();
  for (const sp of housesData.sprites) houseByI.set(sp.i, sp);
  treeByI = new Map();
  for (const sp of treesData.sprites) treeByI.set(sp.i, sp);
  tilesByI = new Map();
  for (const sp of tilesetData.sprites) tilesByI.set(sp.i, sp);

  buildQuad();
  ringTex = buildRingTexture();
  bindPicker();

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
  installHook();
  lastFrame = performance.now();
  requestAnimationFrame(frame);
}

window.addEventListener('error', (e) => showError(e.error ?? e.message));
window.addEventListener('unhandledrejection', (e) => showError(e.reason));
boot().catch(showError);
