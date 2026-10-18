// ui/ui.ts — the game UI controller (B2A). It owns the input router, the selection, the build modes,
// the local command queue and the notifications. Every human action becomes a Command
// (packages/sim/commands.ts); the shell (game/game.ts) hands the queue to skirmish step(). Nothing here
// writes sim state: reads only, and the renderer's own click/key handlers that DO write (its plan
// placement and order paths) never run, because the router stops those events in the capture phase.
import { humanHands } from '../../../packages/sim/skirmish.ts';
import type { Skirmish, StepResult } from '../../../packages/sim/skirmish.ts';
import type { Command } from '../../../packages/sim/commands.ts';
import type { EconomyWorld } from '../../../packages/sim/economy.ts';
import type { KaMap } from '../../../packages/map/map.ts';
import { CELL, houseName, unitName, linePath, validPrefix, rectOf, pointInRect, footprint } from './model.ts';
import type { Tile } from './model.ts';
import { createPanels } from './panels.ts';
import type { Panels, ToastKind } from './panels.ts';
import { createMinimap } from './minimap.ts';
import type { Minimap } from './minimap.ts';
import { drawOverlay } from './overlay.ts';
import type { OverlayFrame } from './overlay.ts';

/** The renderer's hook (play.ts window.__kamplay) as the UI uses it: camera, picking and sprite geometry. */
export interface PlayView {
  cam(): { x: number; y: number };
  zoom(): number;
  setCam(x: number, y: number): void;
  viewportOf(wx: number, wy: number): { x: number; y: number };
  viewportOfUnit(uid: number): { x: number; y: number } | null;
  tileAtViewport(vx: number, vy: number): { x: number; y: number } | null;
  selectAt(vx: number, vy: number): { unit: number; house: number; group: number };
  enemyAt(vx: number, vy: number): { unit: number; house: number };
  houseRect(uid: number): { x: number; y: number; w: number; h: number } | null;
  canPlaceHouse(typeId: number, x: number, y: number): boolean | null;
}

export type Mode = 'none' | 'house' | 'road' | 'corn' | 'erase';
export type Tab = 'houses' | 'roads' | 'fields';

export interface UiState {
  mode: Mode;
  houseType: number;
  tab: Tab;
  houseUid: number;
  groups: number[];
  units: number[];
  destroyArmedAt: number;
}

export interface GameUi {
  /** Attach a running skirmish. `hand` is the hand this client plays (the first human hand by default; the
   *  relay's yourHand in a multiplayer match). */
  attach(sk: Skirmish, map: KaMap, hand?: number): void;
  detach(): void;
  /** The queued commands, stamped with the tick they will run on (one batch per step). */
  takeCommands(tick: number): Command[];
  afterStep(res: StepResult): void;
  frame(now: number): void;
  inspect(): UiInspect;
  panels: Panels;
}

export interface UiInspect {
  mode: Mode;
  houseType: number;
  tab: Tab;
  houseUid: number;
  groups: number[];
  units: number[];
  hover: Tile | null;
  ghostOk: boolean | null;
  results: { tick: number; type: string; ok: boolean; reason: string }[];
  toasts: string[];
  queued: number;
}

type NewCommand = DistOmit<Command, 'hand' | 'tick'>;
type DistOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

const DRAG_PX = 5;
const PAN_PX_PER_S = 700;
const KEY_PAN: Record<string, [number, number]> = {
  ArrowUp: [0, -1], w: [0, -1], W: [0, -1], ArrowDown: [0, 1], s: [0, 1], S: [0, 1],
  ArrowLeft: [-1, 0], a: [-1, 0], A: [-1, 0], ArrowRight: [1, 0], d: [1, 0], D: [1, 0],
};
/** Keys the renderer would act on (its own plan placement / picker); the router takes them over. */
const RENDERER_KEYS = new Set(['b', 'B', 'v', 'V', 'c', 'C', 'm', 'M', '[', ']', ',', '.']);
const DESTROY_CONFIRM_MS = 4000;
const ATTACK_TOAST_GAP_MS = 4000;

interface Press {
  button: number;
  x: number;
  y: number;
  moved: boolean;
  tile: Tile | null;
}

export function createUi(view: PlayView, cv: HTMLCanvasElement, ov: HTMLCanvasElement): GameUi {
  const doc = document;
  const st: UiState = { mode: 'none', houseType: 9, tab: 'houses', houseUid: 0, groups: [], units: [], destroyArmedAt: 0 };
  let sk: Skirmish | null = null;
  let hand = 0;
  let press: Press | null = null;
  let mouse: { x: number; y: number } | null = null;
  let hover: Tile | null = null;
  let boxNow: { x: number; y: number } | null = null;
  const keysDown = new Set<string>();
  const queue: Command[] = [];
  const results: UiInspect['results'] = [];
  const toastLog: string[] = [];
  let lastPanels = 0;
  let lastMinimap = 0;
  let lastFrame = 0;
  let lastAttackToast = 0;
  let watch: { done: Set<number>; units: Set<number>; dmg: Map<number, number>; hp: Map<number, number> } | null = null;

  const toast = (text: string, kind: ToastKind): void => {
    panels.toast(text, kind);
    toastLog.push(text);
    if (toastLog.length > 40) toastLog.shift();
  };

  const panels: Panels = createPanels(doc, (name, value) => act(name, value));

  const minimap: Minimap = createMinimap(doc.getElementById('mm') as HTMLCanvasElement, (u, v) => {
    view.setCam(u * CELL, v * CELL);
  });

  const world = (): EconomyWorld | null => (sk === null ? null : sk.world);

  const issue = (c: NewCommand): void => {
    queue.push({ ...c, hand, tick: 0 } as Command);
  };

  // ---- selection bookkeeping --------------------------------------------------------------------
  const pruneSelection = (w: EconomyWorld): void => {
    st.groups = st.groups.filter((g) => w.groupByUid(g) !== null);
    st.units = st.units.filter((u) => {
      const unit = w.unitByUid(u);
      return unit !== null && !unit.dead;
    });
    if (st.houseUid !== 0) {
      const h = w.houseByUid(st.houseUid);
      if (h === null || h.destroyed) st.houseUid = 0;
    }
  };

  const clearSelection = (): void => {
    st.houseUid = 0;
    st.groups = [];
    st.units = [];
    st.destroyArmedAt = 0;
  };

  const setMode = (mode: Mode, houseType?: number): void => {
    if (houseType !== undefined) st.houseType = houseType;
    st.mode = mode;
    press = null;
    boxNow = null;
  };

  const toggleMode = (mode: Mode, houseType?: number): void => {
    const same = st.mode === mode && (mode !== 'house' || houseType === st.houseType);
    setMode(same ? 'none' : mode, houseType);
  };

  // ---- the panels' buttons ----------------------------------------------------------------------
  const act = (name: string, value: string): void => {
    const w = world();
    if (w === null) return;
    switch (name) {
      case 'tab':
        st.tab = value as Tab;
        return;
      case 'mode':
        if (value.startsWith('house:')) toggleMode('house', Number(value.slice(6)));
        else toggleMode(value as Mode);
        return;
      case 'cancel':
        setMode('none');
        return;
      case 'train':
        if (st.houseUid !== 0) issue({ type: 'houseTrain', houseUid: st.houseUid, unitType: Number(value), count: 1 });
        return;
      case 'equip':
        if (st.houseUid !== 0) issue({ type: 'houseEquip', houseUid: st.houseUid, soldierType: Number(value), count: 1 });
        return;
      case 'destroy': {
        if (st.houseUid === 0) return;
        const now = performance.now();
        if (st.destroyArmedAt !== 0 && now - st.destroyArmedAt < DESTROY_CONFIRM_MS) {
          st.destroyArmedAt = 0;
          issue({ type: 'houseDestroy', houseUid: st.houseUid });
        } else {
          st.destroyArmedAt = now;
          toast('Click Destroy again to confirm', 'warn');
        }
        return;
      }
      case 'halt':
        for (const g of st.groups) issue({ type: 'groupHalt', groupUid: g });
        return;
      case 'form': {
        const delta = Number(value);
        for (const g of st.groups) {
          const grp = w.groupByUid(g);
          if (grp === null) continue;
          const members = grp.memberUids.length;
          const next = Math.max(1, Math.min(members, grp.unitsPerRow + delta));
          if (next !== grp.unitsPerRow) issue({ type: 'groupFormation', groupUid: g, unitsPerRow: next });
        }
        return;
      }
      case 'deselect':
        clearSelection();
        return;
      default:
        return;
    }
  };

  // ---- pointer ----------------------------------------------------------------------------------
  const clickAt = (x: number, y: number, button: number): void => {
    const w = world();
    if (w === null) return;
    if (button === 2) {
      if (st.mode !== 'none') {
        setMode('none');
        return;
      }
      orderAt(x, y);
      return;
    }
    const tile = view.tileAtViewport(x, y);
    if (st.mode === 'house') {
      if (tile !== null) issue({ type: 'housePlan', typeId: st.houseType, x: tile.x, y: tile.y });
      return;
    }
    if (st.mode === 'road') {
      if (tile !== null) issue({ type: 'roadPlan', x: tile.x, y: tile.y });
      return;
    }
    if (st.mode === 'corn') {
      if (tile !== null) issue({ type: 'fieldPlan', x: tile.x, y: tile.y, kind: 'corn' });
      return;
    }
    if (st.mode === 'erase') {
      if (tile !== null) issue({ type: 'planRemove', x: tile.x, y: tile.y });
      return;
    }
    const pick = view.selectAt(x, y);
    st.houseUid = 0;
    st.groups = [];
    st.units = [];
    if (pick.unit !== 0) {
      const u = w.unitByUid(pick.unit);
      if (u !== null && u.owner === hand) {
        if (pick.group !== 0 && w.groupByUid(pick.group) !== null) st.groups = [pick.group];
        else st.units = [pick.unit];
      }
    } else if (pick.house !== 0) {
      st.houseUid = pick.house;
    }
  };

  const boxSelect = (x0: number, y0: number, x1: number, y1: number): void => {
    const w = world();
    if (w === null) return;
    const r = rectOf(x0, y0, x1, y1);
    const groups = new Set<number>();
    const units: number[] = [];
    for (const u of w.units) {
      if (u.owner !== hand || u.dead || u.inside) continue;
      const g = w.groupOf(u.uid);
      if (g === null) continue;
      const p = view.viewportOfUnit(u.uid);
      if (p === null || !pointInRect(p.x, p.y, r)) continue;
      groups.add(g.uid);
      units.push(u.uid);
    }
    st.groups = [...groups];
    st.units = units;
    st.houseUid = 0;
    if (units.length === 0) toast('No soldiers in the box', 'info');
  };

  const roadDrag = (a: Tile, b: Tile): void => {
    const w = world();
    if (w === null) return;
    const path = linePath(a, b);
    const ok = validPrefix(path, (t) => w.canAddFieldPlan(hand, t.x, t.y, 'road'));
    if (ok.length === 0) {
      toast(`roadPlan: (${path[0]!.x},${path[0]!.y}) cannot take a road`, 'bad');
      return;
    }
    if (ok.length === 1) issue({ type: 'roadPlan', x: ok[0]!.x, y: ok[0]!.y });
    else issue({ type: 'roadPlanLine', path: ok.map((t) => ({ x: t.x, y: t.y })) });
    if (ok.length < path.length) toast(`Road stops at the first blocked tile (${ok.length}/${path.length})`, 'warn');
  };

  const orderAt = (x: number, y: number): void => {
    const w = world();
    if (w === null) return;
    if (st.groups.length === 0) {
      toast('Select soldiers first: click one, or drag a box', 'warn');
      return;
    }
    const enemy = view.enemyAt(x, y);
    if (enemy.unit !== 0) {
      for (const g of st.groups) issue({ type: 'groupAttackUnit', groupUid: g, targetUid: enemy.unit });
      return;
    }
    if (enemy.house !== 0) {
      for (const g of st.groups) issue({ type: 'groupAttackHouse', groupUid: g, houseUid: enemy.house });
      return;
    }
    const tile = view.tileAtViewport(x, y);
    if (tile === null) return;
    if (!w.tileWalkable(tile.x, tile.y)) {
      toast(`groupWalk: (${tile.x},${tile.y}) is not walkable`, 'bad');
      return;
    }
    for (const g of st.groups) issue({ type: 'groupWalk', groupUid: g, x: tile.x, y: tile.y, dir: 0 });
  };

  const onPointerDown = (e: PointerEvent): void => {
    if (sk === null || e.target !== cv) return;
    e.stopImmediatePropagation(); // the renderer's own handler would move the camera or write the world
    if (e.button === 2) {
      clickAt(e.clientX, e.clientY, 2);
      return;
    }
    if (e.button !== 0) return;
    press = { button: 0, x: e.clientX, y: e.clientY, moved: false, tile: view.tileAtViewport(e.clientX, e.clientY) };
  };

  const onPointerMove = (e: PointerEvent): void => {
    mouse = { x: e.clientX, y: e.clientY };
    if (sk === null) return;
    if (e.target === cv || press !== null) {
      hover = view.tileAtViewport(e.clientX, e.clientY);
    } else {
      hover = null; // over a panel: no ghost on the map
    }
    if (press !== null) {
      if (Math.hypot(e.clientX - press.x, e.clientY - press.y) >= DRAG_PX) press.moved = true;
      boxNow = { x: e.clientX, y: e.clientY };
    }
  };

  const onPointerUp = (e: PointerEvent): void => {
    if (press === null || e.button !== 0) return;
    const p = press;
    press = null;
    boxNow = null;
    if (sk === null) return;
    if (!p.moved) {
      clickAt(p.x, p.y, 0);
      return;
    }
    if (st.mode === 'none') {
      boxSelect(p.x, p.y, e.clientX, e.clientY);
    } else if (st.mode === 'road') {
      const end = view.tileAtViewport(e.clientX, e.clientY);
      if (p.tile !== null && end !== null) roadDrag(p.tile, end);
    }
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (sk === null) return;
    const t = e.target as HTMLElement | null;
    if (t !== null && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (st.mode !== 'none') setMode('none');
      else clearSelection();
      return;
    }
    if (RENDERER_KEYS.has(e.key)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    if (KEY_PAN[e.key] !== undefined) {
      e.preventDefault();
      keysDown.add(e.key);
    }
  };

  const onKeyUp = (e: KeyboardEvent): void => {
    keysDown.delete(e.key);
  };

  cv.addEventListener('contextmenu', (e) => e.preventDefault());
  window.addEventListener('pointerdown', onPointerDown, true);
  window.addEventListener('pointermove', onPointerMove, true);
  window.addEventListener('pointerup', onPointerUp, true);
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);
  window.addEventListener('blur', () => keysDown.clear());

  // ---- notifications (diffs of the sim state: completed houses, new units, attacks) -------------
  const primeWatch = (w: EconomyWorld): void => {
    watch = { done: new Set(), units: new Set(), dmg: new Map(), hp: new Map() };
    for (const h of w.houses) {
      if (h.owner !== hand || h.destroyed) continue;
      if (h.buildState === 'done') watch.done.add(h.uid);
      watch.dmg.set(h.uid, h.damage);
    }
    for (const u of w.units) if (u.owner === hand && !u.dead && !u.inside) watch.units.add(u.uid);
  };

  const attackToast = (now: number, text: string): void => {
    if (now - lastAttackToast < ATTACK_TOAST_GAP_MS) return;
    lastAttackToast = now;
    toast(text, 'bad');
  };

  const watchStep = (w: EconomyWorld, now: number): void => {
    if (watch === null) return;
    for (const h of w.houses) {
      if (h.owner !== hand || h.destroyed) continue;
      if (h.buildState === 'done' && !watch.done.has(h.uid)) {
        watch.done.add(h.uid);
        toast(`${houseName(h.typeId)} completed`, 'good');
      }
      const prev = watch.dmg.get(h.uid) ?? 0;
      if (h.damage > prev) attackToast(now, `${houseName(h.typeId)} under attack`);
      watch.dmg.set(h.uid, h.damage);
    }
    for (const u of w.units) {
      if (u.owner !== hand || u.dead) continue;
      if (!u.inside && !watch.units.has(u.uid)) {
        watch.units.add(u.uid);
        toast(`New ${unitName(u.type)} ready`, 'good');
      }
      if (w.groupOf(u.uid) !== null) {
        const hp = w.unitHealth(u.uid);
        const prev = watch.hp.get(u.uid);
        if (prev !== undefined && hp < prev) attackToast(now, `${unitName(u.type)} under attack`);
        watch.hp.set(u.uid, hp);
      }
    }
  };

  // ---- per-frame work ---------------------------------------------------------------------------
  const frameOverlay = (w: EconomyWorld | null): OverlayFrame => {
    const ok = (x: number, y: number): boolean => {
      if (w === null) return false;
      if (st.mode === 'house') return view.canPlaceHouse(st.houseType, x, y) === true;
      if (st.mode === 'road') return w.canAddFieldPlan(hand, x, y, 'road');
      if (st.mode === 'corn') return w.canAddFieldPlan(hand, x, y, 'corn');
      return false;
    };
    let tiles: { tile: Tile; ok: boolean }[] = [];
    let roadPreview: { tile: Tile; ok: boolean }[] = [];
    if (st.mode === 'house' && hover !== null && w !== null) {
      const spec = w.houseSpecOf(st.houseType);
      if (spec !== undefined) {
        tiles = footprint(st.houseType, hover.x, hover.y, spec.entranceDx).map((t) => ({ tile: t, ok: ok(hover!.x, hover!.y) }));
      }
    } else if ((st.mode === 'road' || st.mode === 'corn' || st.mode === 'erase') && hover !== null) {
      tiles = [{ tile: hover, ok: ok(hover.x, hover.y) }];
    }
    if (st.mode === 'road' && press !== null && press.moved && press.tile !== null && boxNow !== null) {
      const end = view.tileAtViewport(boxNow.x, boxNow.y);
      if (end !== null) roadPreview = linePath(press.tile, end).map((t) => ({ tile: t, ok: ok(t.x, t.y) }));
    }
    const sel: { x: number; y: number }[] = [];
    if (w !== null) {
      for (const u of st.units) {
        const p = view.viewportOfUnit(u);
        if (p !== null) sel.push(p);
      }
      for (const g of st.groups) {
        const grp = w.groupByUid(g);
        if (grp === null) continue;
        for (const m of grp.memberUids) {
          const p = view.viewportOfUnit(m);
          if (p !== null) sel.push(p);
        }
      }
    }
    return {
      width: window.innerWidth,
      height: window.innerHeight,
      view,
      mode: st.mode,
      tiles,
      roadPreview,
      box: press !== null && press.moved && st.mode === 'none' && boxNow !== null
        ? rectOf(press.x, press.y, boxNow.x, boxNow.y)
        : null,
      selected: sel,
      houseRect: st.houseUid !== 0 ? view.houseRect(st.houseUid) : null,
    };
  };

  const ensureOverlaySize = (): void => {
    if (ov.width !== window.innerWidth || ov.height !== window.innerHeight) {
      ov.width = window.innerWidth;
      ov.height = window.innerHeight;
    }
  };

  const frame = (now: number): void => {
    ensureOverlaySize();
    const dt = lastFrame === 0 ? 0 : Math.min(0.1, (now - lastFrame) / 1000);
    lastFrame = now;
    const w = world();
    if (w !== null) {
      pruneSelection(w);
      if (keysDown.size > 0) {
        let dx = 0;
        let dy = 0;
        for (const k of keysDown) {
          const d = KEY_PAN[k];
          if (d !== undefined) {
            dx += d[0];
            dy += d[1];
          }
        }
        if (dx !== 0 || dy !== 0) {
          const c = view.cam();
          view.setCam(c.x + dx * PAN_PX_PER_S * dt, c.y + dy * PAN_PX_PER_S * dt);
        }
      }
      watchStep(w, now);
      if (now - lastPanels > 250) {
        lastPanels = now;
        panels.renderBuild(w, hand, st);
        panels.renderInfo(w, hand, st);
        panels.renderStock(w, hand);
        panels.renderHint(st.mode, st.houseType, w);
      }
      if (now - lastMinimap > 500) {
        lastMinimap = now;
        minimap.draw(w, hand, view.cam(), view.zoom(), cv.clientWidth, cv.clientHeight);
      }
    }
    panels.expire(now);
    drawOverlay(ov, frameOverlay(w));
  };

  return {
    attach(s: Skirmish, km: KaMap, handOverride?: number): void {
      sk = s;
      hand = typeof handOverride === 'number' ? handOverride : (humanHands(s)[0] ?? 0);
      queue.length = 0;
      results.length = 0;
      press = null;
      boxNow = null;
      hover = null;
      keysDown.clear();
      clearSelection();
      setMode('none');
      primeWatch(s.world);
      minimap.attach(s.world, km, hand);
      lastPanels = 0;
      lastMinimap = 0;
      panels.renderBuild(s.world, hand, st);
      panels.renderStock(s.world, hand);
      panels.renderInfo(s.world, hand, st);
      panels.renderHint(st.mode, st.houseType, s.world);
      panels.setVisible(true);
    },
    detach(): void {
      sk = null;
      queue.length = 0;
      clearSelection();
      setMode('none');
      watch = null;
      minimap.attach(null, null, 0);
      panels.setVisible(false);
    },
    takeCommands(tick: number): Command[] {
      const out = queue.map((c) => ({ ...c, tick }) as Command);
      queue.length = 0;
      return out;
    },
    afterStep(res: StepResult): void {
      for (const r of res.results) {
        const type = r.cmd.type;
        results.push({ tick: res.tick, type, ok: r.result.ok, reason: r.result.ok ? '' : r.result.reason });
        if (results.length > 200) results.shift();
        if (!r.result.ok) toast(`${type}: ${r.result.reason}`, 'bad');
      }
    },
    frame,
    inspect(): UiInspect {
      const ghost = st.mode === 'house' && hover !== null && sk !== null ? view.canPlaceHouse(st.houseType, hover.x, hover.y) : null;
      return {
        mode: st.mode,
        houseType: st.houseType,
        tab: st.tab,
        houseUid: st.houseUid,
        groups: st.groups.slice(),
        units: st.units.slice(),
        hover,
        ghostOk: ghost,
        results: results.slice(),
        toasts: toastLog.slice(),
        queued: queue.length,
      };
    },
    panels,
  };
}
