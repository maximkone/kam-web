// nettest/cli.ts — the M6 network check (docs/M6-SPIKE.md §10). A relay on a real socket (apps/server/relay.ts),
// two clients on node's global WebSocket, each running the real sim (createSkirmish + step) on MapsMP/Battle Sun
// through lockstep (packages/net/client.ts), and a single-process reference that replays the relay's merged
// command list. Usage:
//   node tools/nettest/cli.ts --check   the full check: the 3000-tick game (0-20 ms jitter per client send, a
//                                       rogue command from hand 1, a late join), the lobby battery (wrong map sha,
//                                       malformed and oversized frames, rate limit) and a disconnect run.
//                                       Prints NET CHECK PASS or NET CHECK FAIL.
//   node tools/nettest/cli.ts --break   client B corrupts one command (x+1) in its local copy from tick 1025 on, CRC32
//                                       every tick: the relay reports a DESYNC and names the first bad tick. Prints
//                                       NET CHECK FAIL (exit 1) by design.
// Env: KAM_INSTALL (the install root, read only).

import { createHash } from 'node:crypto';
import { startRelay } from '../../apps/server/relay.ts';
import type { RelayStats } from '../../apps/server/relay.ts';
import { NetClient } from '../../packages/net/client.ts';
import type { GameHooks, SocketFactory } from '../../packages/net/client.ts';
import { canonicalState } from '../../packages/net/statehash.ts';
import type { GameCommand, GameStartMsg, ServerMessage } from '../../packages/net/protocol.ts';
import type { CommandInput } from '../../packages/net/lockstep.ts';
import { createSkirmish, step } from '../../packages/sim/skirmish.ts';
import type { Skirmish, SkirmishDefines, SkirmishSlot } from '../../packages/sim/skirmish.ts';
import type { EconomyWorld } from '../../packages/sim/economy.ts';
import { HT_STORE, HT_SCHOOL, HT_WOODCUTTERS, UT_MILITIA, UT_SERF } from '../../packages/sim/ai.ts';
import { defines, definesBytes, mapFiles } from './skirmish-cli-utils.ts';

const MAP = 'MapsMP/Battle Sun';
const SEED = 4242;
const TICKS = 3000;
const DELAY = 4;
const CRC_INTERVAL = 50;
const LATE_MS = 200;
const JITTER_MS = 20;
const ROGUE_SET = 20;
const LATE_JOIN_TICK = 300;
const DISCONNECT_TICK = 100;
const DISCONNECT_END = 300;
const GAME_TIMEOUT_MS = 900000;

interface Files {
  mapPath: string;
  mapBytes: Uint8Array;
  missionDat: Uint8Array;
  defines: SkirmishDefines;
  mapSha: string;
  definesSha: string;
}

interface HandScenario {
  school: number;
  group: number;
}

interface Scen {
  byHand: Map<number, HandScenario>;
}

interface GameCfg {
  label: string;
  endTick: number;
  rogue: boolean;
  lateJoinAt: number | null;
  breakAt: number | null;
  disconnectAt: number | null;
  crcInterval: number;
}

interface GameOutcome {
  hostTick: number;
  hostHash: string | null;
  hostReason: string | null;
  guestTick: number;
  guestHash: string | null;
  guestReason: string | null;
  refHash: string | null;
  broadcastsSame: boolean;
  commands: number;
  ticks: number;
  desyncTick: number | null;
  desyncValues: Record<string, string> | null;
  corruptedAt: number | null;
  rejected: string[];
  lateJoin: string | null;
  playerLeft: { hand: number; atTick: number } | null;
  lates: number;
  alive: boolean;
  stats: RelayStats;
  wallMs: number;
}

function sha(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function short(hash: string | null): string {
  return hash === null ? 'none' : hash.slice(0, 8);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function until(cond: () => boolean, label: string, timeoutMs = 20000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await sleep(2);
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout: ${label}`)), ms);
  });
  return Promise.race([p, limit]).finally(() => clearTimeout(timer));
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Collects every message of one client; waitMsg finds the first unused message of a kind. */
class Mailbox {
  readonly messages: ServerMessage[] = [];
  latestState: Extract<ServerMessage, { kind: 'lobby/state' }>['room'] | null = null;
  private used = new Set<number>();

  constructor(client: NetClient) {
    client.onMessage = (m: ServerMessage) => {
      this.messages.push(m);
      if (m.kind === 'lobby/state') this.latestState = m.room;
    };
  }

  async waitMsg<K extends ServerMessage['kind']>(kind: K, timeoutMs = 15000): Promise<Extract<ServerMessage, { kind: K }>> {
    let at = -1;
    await until(() => {
      for (let i = 0; i < this.messages.length; i++) {
        if (this.used.has(i) || this.messages[i].kind !== kind) continue;
        at = i;
        return true;
      }
      return false;
    }, kind, timeoutMs);
    this.used.add(at);
    return this.messages[at] as Extract<ServerMessage, { kind: K }>;
  }

  ofKind<K extends ServerMessage['kind']>(kind: K): Extract<ServerMessage, { kind: K }>[] {
    return this.messages.filter((m): m is Extract<ServerMessage, { kind: K }> => m.kind === kind);
  }
}

/** The first walkable spot in rings around (x, y) that the predicate accepts, or null. */
function scanRing(w: EconomyWorld, x: number, y: number, rMin: number, rMax: number, ok: (sx: number, sy: number) => boolean): { x: number; y: number } | null {
  for (let r = rMin; r <= rMax; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const sx = x + dx;
        const sy = y + dy;
        if (!w.tileInMapCoords(sx, sy)) continue;
        if (ok(sx, sy)) return { x: sx, y: sy };
      }
    }
  }
  return null;
}

/** A road line of three plannable tiles for `hand`: the first ring tile that starts one, then a greedy walk. */
function roadLineFrom(w: EconomyWorld, hand: number, x: number, y: number): { x: number; y: number }[] {
  const greedy = (sx: number, sy: number): { x: number; y: number }[] => {
    const path: { x: number; y: number }[] = [];
    let cur: { x: number; y: number } | null = null;
    for (let i = 0; i < 3; i++) {
      const from: { x: number; y: number } | null = cur;
      const cands: { x: number; y: number }[] =
        from === null
          ? [{ x: sx, y: sy }]
          : [
              { x: from.x, y: from.y + 1 },
              { x: from.x + 1, y: from.y },
              { x: from.x - 1, y: from.y },
            ];
      const next: { x: number; y: number } | undefined = cands.find(
        (p) => w.canAddFieldPlan(hand, p.x, p.y, 'road') && !path.some((q) => q.x === p.x && q.y === p.y),
      );
      if (next === undefined) break;
      path.push(next);
      cur = next;
    }
    return path;
  };
  for (let r = 1; r <= 6; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const path = greedy(x + dx, y + dy);
        if (path.length === 3) return path;
      }
    }
  }
  return [];
}

/** The setup grants of one human hand (the same on every client and in the reference): a school and a militia group. */
function grantHand(w: EconomyWorld, hand: number): HandScenario {
  const store = w.findFirstHouse(HT_STORE, hand);
  if (store === null) throw new Error(`nettest: hand ${hand} has no store`);
  const spec = w.houseSpecOf(HT_SCHOOL);
  if (spec === undefined) throw new Error('nettest: no school spec');
  const spot = scanRing(w, store.x, store.y, 4, 14, (x, y) => w.canPlaceHouse(HT_SCHOOL, x + spec.entranceDx, y));
  if (spot === null) throw new Error(`nettest: no school spot near the store of hand ${hand}`);
  const school = w.spawnHouse(HT_SCHOOL, spot.x, spot.y, hand);
  w.houseCreatedFor(hand, HT_SCHOOL);
  const entrance = store.entrance;
  const gs = scanRing(w, entrance.x, entrance.y + 3, 0, 5, (x, y) => w.tileWalkable(x, y) && w.houseAt(x, y) === null && !w.isRoadTile(x, y));
  if (gs === null) throw new Error(`nettest: no group spot near the store of hand ${hand}`);
  const group = w.spawnGroup(hand, UT_MILITIA, gs.x, gs.y, 4, 3, 9);
  return { school: school.uid, group: group.uid };
}

function build(files: Files, seed: number, slots: SkirmishSlot[]): { sk: Skirmish; scen: Scen } {
  const sk = createSkirmish({
    mapBytes: files.mapBytes,
    mapPath: files.mapPath,
    missionDat: files.missionDat,
    defines: files.defines,
    seed,
    slots,
  });
  const scen: Scen = { byHand: new Map() };
  for (const s of slots) {
    if (s.kind === 'human') scen.byHand.set(s.hand, grantHand(sk.world, s.hand));
  }
  return { sk, scen };
}

/** This client's commands for the set of tick t (its own state; the relay merges them). */
function scriptFor(sk: Skirmish, scen: Scen, hand: number, t: number): CommandInput[] {
  const w = sk.world;
  const sc = scen.byHand.get(hand);
  const store = w.findFirstHouse(HT_STORE, hand);
  if (sc === undefined || store === null) return [];
  switch (t) {
    case 5: {
      const spot = scanRing(w, store.entrance.x, store.entrance.y, 3, 10, (x, y) => w.canAddHousePlan(hand, HT_WOODCUTTERS, x, y));
      return spot === null ? [] : [{ type: 'housePlan', typeId: HT_WOODCUTTERS, x: spot.x, y: spot.y }];
    }
    case 6: {
      const path = roadLineFrom(w, hand, store.entrance.x, store.entrance.y + 2);
      return path.length === 0 ? [] : [{ type: 'roadPlanLine', path }];
    }
    case 7: {
      const spot = scanRing(w, store.entrance.x, store.entrance.y, 4, 12, (x, y) => w.canAddFieldPlan(hand, x, y, 'corn'));
      return spot === null ? [] : [{ type: 'fieldPlan', kind: 'corn', x: spot.x, y: spot.y }];
    }
    case 8:
      return [{ type: 'houseTrain', houseUid: sc.school, unitType: UT_SERF, count: 2 }];
    case 50:
      return [{ type: 'groupFormation', groupUid: sc.group, unitsPerRow: 3 }];
    case 100: {
      const enemy = w.findFirstHouse(HT_STORE, 1 - hand);
      if (enemy === null) return [];
      const mid = { x: Math.round((store.x + enemy.x) / 2), y: Math.round((store.y + enemy.y) / 2) };
      const spot = scanRing(w, mid.x, mid.y, 0, 12, (x, y) => w.tileWalkable(x, y));
      return spot === null ? [] : [{ type: 'groupWalk', groupUid: sc.group, x: spot.x, y: spot.y, dir: 0 }];
    }
    case 400: {
      const g = w.groupByUid(sc.group);
      const from = g !== null && g.memberUids.length > 0 ? w.unitByUid(g.memberUids[0]) : null;
      if (from === null) return [];
      let best: { uid: number; d: number } | null = null;
      for (const u of w.units) {
        if (u.dead || u.owner === hand || u.owner < 0) continue;
        const d = Math.abs(u.posF.x - from.posF.x) + Math.abs(u.posF.y - from.posF.y);
        if (best === null || d < best.d || (d === best.d && u.uid < best.uid)) best = { uid: u.uid, d };
      }
      return best === null ? [] : [{ type: 'groupAttackUnit', groupUid: sc.group, targetUid: best.uid }];
    }
    case 900:
      return [{ type: 'groupHalt', groupUid: sc.group }];
    default:
      return [];
  }
}

function slotsOf(start: GameStartMsg): SkirmishSlot[] {
  return start.slots.map((s) => ({ hand: s.hand, kind: s.kind, aiLevel: s.aiLevel }));
}

function hooksFor(files: Files, client: NetClient, ctx: { scen: Scen | null; corrupted: number | null }, opts: { rogue: boolean; breakAt: number | null }): GameHooks {
  return {
    createSkirmish: (start: GameStartMsg): Skirmish => {
      if (start.mapSha !== files.mapSha || start.definesSha !== files.definesSha) {
        throw new Error('nettest: the local map or defines differ from the game');
      }
      const built = build(files, start.seed, slotsOf(start));
      ctx.scen = built.scen;
      return built.sk;
    },
    script: (sk: Skirmish, t: number): CommandInput[] => {
      const hand = client.hand ?? -1;
      const cmds: CommandInput[] = ctx.scen === null ? [] : scriptFor(sk, ctx.scen, hand, t);
      if (opts.rogue && hand === 1 && t === ROGUE_SET) cmds.push({ hand: 0, type: 'groupHalt', groupUid: 1 });
      return cmds;
    },
    tamper: (tick: number, cmds: GameCommand[]): GameCommand[] => {
      if (opts.breakAt === null || ctx.corrupted !== null || tick < opts.breakAt) return cmds;
      const idx = cmds.findIndex((c) => 'x' in c);
      if (idx < 0) return cmds;
      ctx.corrupted = tick;
      const copy = cmds.slice();
      copy[idx] = { ...copy[idx], x: (copy[idx] as { x: number }).x + 1 } as GameCommand;
      return copy;
    },
  };
}

/** The single-process reference: a fresh sim, the same grants, the relay's merged command list. */
function reference(files: Files, seed: number, slots: SkirmishSlot[], merged: Map<number, GameCommand[]>, endTick: number): string {
  const built = build(files, seed, slots);
  for (let t = 1; t <= endTick; t++) {
    const cmds = merged.get(t);
    if (cmds === undefined) throw new Error(`reference: no broadcast for tick ${t}`);
    step(built.sk, cmds);
  }
  return sha(canonicalState(built.sk));
}

/** The socket: global WebSocket; with jitter, every client send waits its own 0..JITTER_MS (sets are keyed by tick, so reordering is harmless). */
function socketFactory(rng: () => number, jitter: boolean): SocketFactory {
  return (url: string): WebSocket => {
    const ws = new WebSocket(url);
    if (!jitter) return ws;
    const raw = ws.send.bind(ws) as (data: string) => void;
    ws.send = (data: string) => {
      setTimeout(() => {
        try {
          raw(data);
        } catch {
          // the socket closed while the frame waited
        }
      }, Math.floor(rng() * JITTER_MS));
    };
    return ws;
  };
}

function onceFinished(c: NetClient): Promise<string> {
  return new Promise((resolve) => {
    c.onFinished = (reason: string) => resolve(reason);
  });
}

async function lateJoinAttempt(url: string, files: Files, roomId: string): Promise<string> {
  const c = new NetClient({ url });
  await c.connect();
  const box = new Mailbox(c);
  c.send({ kind: 'lobby/join', roomId, mapSha: files.mapSha, definesSha: files.definesSha, name: 'late' });
  const err = await box.waitMsg('error');
  c.close();
  return err.reason;
}

async function runGame(files: Files, cfg: GameCfg): Promise<GameOutcome> {
  const relay = await startRelay({ seed: SEED, lateMs: LATE_MS });
  const url = `ws://127.0.0.1:${relay.port}`;
  const rng = mulberry32(SEED + 7);
  const host = new NetClient({ url, makeSocket: socketFactory(rng, true) });
  const guest = new NetClient({ url, makeSocket: socketFactory(rng, true) });
  const hostCtx: { scen: Scen | null; corrupted: number | null } = { scen: null, corrupted: null };
  const guestCtx: { scen: Scen | null; corrupted: number | null } = { scen: null, corrupted: null };
  host.hooks = hooksFor(files, host, hostCtx, { rogue: false, breakAt: null });
  guest.hooks = hooksFor(files, guest, guestCtx, { rogue: cfg.rogue, breakAt: cfg.breakAt });
  const hb = new Mailbox(host);
  const gb = new Mailbox(guest);
  const hostDone = onceFinished(host);
  const guestDone = onceFinished(guest);
  const late: { p: Promise<string> | null } = { p: null };
  let roomId = '';
  const started = Date.now();
  try {
    await host.connect();
    await guest.connect();
    host.send({ kind: 'lobby/create', mapId: MAP, mapSha: files.mapSha, definesSha: files.definesSha, hands: 2, name: 'host' });
    roomId = (await hb.waitMsg('lobby/created')).roomId;
    guest.send({ kind: 'lobby/join', roomId, mapSha: files.mapSha, definesSha: files.definesSha, name: 'guest' });
    await gb.waitMsg('lobby/joined');
    host.send({ kind: 'lobby/ready', ready: true });
    guest.send({ kind: 'lobby/ready', ready: true });
    await until(() => hb.latestState !== null && hb.latestState.players.filter((p) => p.ready).length === 2, 'both players ready');
    host.onStep = (tick: number) => {
      if (cfg.lateJoinAt === tick && late.p === null) late.p = lateJoinAttempt(url, files, roomId);
      if (cfg.disconnectAt === tick) guest.close();
    };
    host.send({ kind: 'lobby/start', delayTicks: DELAY, endTick: cfg.endTick, crcInterval: cfg.crcInterval });

    const hostReason = await withTimeout(hostDone, GAME_TIMEOUT_MS, `${cfg.label} host finish`);
    const guestReason = cfg.disconnectAt !== null ? null : await withTimeout(guestDone, GAME_TIMEOUT_MS, `${cfg.label} guest finish`);
    const lateJoinReason = late.p === null ? null : await withTimeout(late.p, 15000, 'late join');

    const hostSk = host.sk;
    const guestSk = guest.sk;
    const hostBC = hb.ofKind('game/tick').map((m) => ({ tick: m.tick, commands: m.commands }));
    const guestBC = gb.ofKind('game/tick').map((m) => ({ tick: m.tick, commands: m.commands }));
    const broadcastsSame = guestBC.length <= hostBC.length && guestBC.every((b, i) => JSON.stringify(b) === JSON.stringify(hostBC[i]));
    const merged = new Map<number, GameCommand[]>(hostBC.map((b) => [b.tick, b.commands]));
    const hostTick = hostSk === null ? 0 : hostSk.world.tickCount;
    const desync = hb.ofKind('game/desync')[0] ?? gb.ofKind('game/desync')[0] ?? null;
    let refHash: string | null = null;
    if (desync === null && hostTick === cfg.endTick && host.start !== null) {
      refHash = reference(files, SEED, slotsOf(host.start), merged, cfg.endTick);
    }
    const probe = new NetClient({ url });
    await probe.connect();
    const probeBox = new Mailbox(probe);
    probe.send({ kind: 'lobby/list' });
    const alive = (await probeBox.waitMsg('lobby/rooms')).kind === 'lobby/rooms';
    probe.close();
    const commands = [...merged.values()].reduce((n, c) => n + c.length, 0);
    const playerLeft = hb.ofKind('game/playerLeft')[0];
    return {
      hostTick,
      hostHash: hostSk === null ? null : sha(canonicalState(hostSk)),
      hostReason,
      guestTick: guestSk === null ? 0 : guestSk.world.tickCount,
      guestHash: guestSk === null ? null : sha(canonicalState(guestSk)),
      guestReason,
      refHash,
      broadcastsSame,
      commands,
      ticks: hostBC.length,
      desyncTick: desync === null ? null : desync.tick,
      desyncValues: desync === null ? null : desync.values,
      corruptedAt: guestCtx.corrupted,
      rejected: gb.ofKind('game/rejected').map((m) => m.reason),
      lateJoin: lateJoinReason,
      playerLeft: playerLeft === undefined ? null : { hand: playerLeft.hand, atTick: playerLeft.atTick },
      lates: hb.ofKind('game/late').length + gb.ofKind('game/late').length,
      alive,
      stats: relay.stats(),
      wallMs: Date.now() - started,
    };
  } finally {
    host.close();
    guest.close();
    await relay.stop();
  }
}

/** The lobby battery on its own relay: refusals, malformed and oversized frames, the rate limit. */
async function lobbyBattery(files: Files): Promise<{ label: string; ok: boolean }[]> {
  const relay = await startRelay({ seed: SEED, lateMs: LATE_MS });
  const url = `ws://127.0.0.1:${relay.port}`;
  const out: { label: string; ok: boolean }[] = [];
  const clients: NetClient[] = [];
  const open = async (): Promise<[NetClient, Mailbox]> => {
    const c = new NetClient({ url });
    clients.push(c);
    await c.connect();
    return [c, new Mailbox(c)];
  };
  try {
    const [host, hb] = await open();
    host.send({ kind: 'lobby/create', mapId: MAP, mapSha: files.mapSha, definesSha: files.definesSha, hands: 2, name: 'host' });
    const created = await hb.waitMsg('lobby/created');

    const [bad, bb] = await open();
    bad.send({ kind: 'lobby/join', roomId: created.roomId, mapSha: 'a'.repeat(64), definesSha: files.definesSha, name: 'bad' });
    const refusal = await bb.waitMsg('error');
    out.push({ label: `joiner with another map sha is refused (${refusal.reason})`, ok: refusal.code === 'refused' && refusal.reason.includes('sha256') });

    bad.send({ kind: 'lobby/join', roomId: created.roomId, mapSha: files.mapSha, definesSha: files.definesSha, name: 'good' });
    const joined = await bb.waitMsg('lobby/joined');
    out.push({ label: 'joiner with the same shas joins as hand 1', ok: joined.hand === 1 });

    const [mal, mb] = await open();
    mal.sendRaw('{"kind": "lobby/list"');
    const bad1 = await mb.waitMsg('error');
    mal.send({ kind: 'lobby/list' });
    const after = await mb.waitMsg('lobby/rooms');
    out.push({ label: `malformed frame is rejected (${bad1.code}), the connection goes on`, ok: bad1.code === 'bad-message' && after.rooms.length === 1 });

    const [big] = await open();
    const closed: { code: number | null } = { code: null };
    big.onClose = (code: number) => {
      closed.code = code;
    };
    big.sendRaw(`{"kind":"lobby/chat","text":"${'a'.repeat(70000)}"}`);
    await until(() => closed.code !== null, 'oversized frame close', 10000);
    out.push({ label: `oversized frame (70000 bytes) closes the connection with 1009 (got ${String(closed.code)})`, ok: closed.code === 1009 });

    const [probe, pb] = await open();
    probe.send({ kind: 'lobby/list' });
    const alive = await pb.waitMsg('lobby/rooms');
    out.push({ label: 'server still answers after the oversized frame', ok: alive.rooms.length === 1 });

    const [spam, sb] = await open();
    for (let i = 0; i < 60; i++) spam.send({ kind: 'lobby/list' });
    await until(() => sb.messages.some((m) => m.kind === 'error' && m.code === 'rate-limit'), 'rate-limit error', 10000);
    out.push({ label: 'a burst of 60 lobby messages in one second is rate-limited', ok: true });
  } finally {
    for (const c of clients) c.close();
    await relay.stop();
  }
  return out;
}

function report(o: GameOutcome, endTick: number): string[] {
  const lines: string[] = [];
  lines.push(`NET HAND 0 host:  tick ${o.hostTick} hash ${short(o.hostHash)} (${o.hostReason ?? 'no finish'})`);
  lines.push(`NET HAND 1 guest: tick ${o.guestTick} hash ${short(o.guestHash)} (${o.guestReason ?? 'not waited for'})`);
  lines.push(`NET MERGED commands=${o.commands} ticks=${o.ticks} broadcasts identical on both clients=${o.broadcastsSame}`);
  lines.push(`NET REFERENCE single process, same merged list: hash ${short(o.refHash)} (end tick ${endTick})`);
  lines.push(`NET GUEST rejected: ${o.rejected.length === 0 ? 'none' : o.rejected.join(' | ')}`);
  lines.push(`NET LATE sets missing at a tick: ${o.lates}`);
  const s = o.stats;
  const wall = s.gameStartAt !== null && s.gameEndAt !== null ? s.gameEndAt - s.gameStartAt : o.wallMs;
  const msgs = s.messagesIn + s.messagesOut;
  lines.push(
    `NET LOAD relay: ${s.messagesIn} in, ${s.messagesOut} out; ${Math.round((msgs * 1000) / Math.max(1, wall))} msgs/s; ` +
      `${(wall / Math.max(1, o.ticks)).toFixed(2)} ms/tick over ${o.ticks} ticks (wall ${wall} ms, 2 clients, 0-${JITTER_MS} ms jitter per send)`,
  );
  return lines;
}

async function check(): Promise<number> {
  const files = loadFiles();
  console.log(`NET RUN ${MAP} seed ${SEED}, ${TICKS} ticks, delay ${DELAY}, crc every ${CRC_INTERVAL}, 2 humans, jitter 0-${JITTER_MS} ms`);
  console.log(`NET FILES map sha256 ${short(files.mapSha)}, defines sha256 ${short(files.definesSha)}`);
  const problems: string[] = [];

  const runs: GameOutcome[] = [];
  for (let run = 1; run <= 2; run++) {
    const r = await runGame(files, {
      label: `game ${run}`,
      endTick: TICKS,
      rogue: true,
      lateJoinAt: LATE_JOIN_TICK,
      breakAt: null,
      disconnectAt: null,
      crcInterval: CRC_INTERVAL,
    });
    runs.push(r);
    console.log(`NET RUN ${run}:`);
    for (const l of report(r, TICKS)) console.log(l);
    if (r.desyncTick !== null) problems.push(`run ${run}: DESYNC at tick ${r.desyncTick}`);
    if (r.hostTick !== TICKS) problems.push(`run ${run}: host stopped at tick ${r.hostTick}`);
    if (r.guestTick !== TICKS) problems.push(`run ${run}: guest stopped at tick ${r.guestTick}`);
    if (r.hostHash === null || r.hostHash !== r.guestHash) problems.push(`run ${run}: host and guest hashes differ`);
    if (r.refHash === null || r.refHash !== r.hostHash) problems.push(`run ${run}: single-process reference differs`);
    if (!r.broadcastsSame) problems.push(`run ${run}: the broadcast lists differ between the clients`);
    if (!r.rejected.some((x) => x.includes('you are hand'))) problems.push(`run ${run}: the command from another hand was not rejected`);
    if (r.lateJoin === null || !r.lateJoin.includes('already started')) problems.push(`run ${run}: late join not refused cleanly (${String(r.lateJoin)})`);
    if (!r.alive) problems.push(`run ${run}: relay did not answer after the game`);
  }
  const g = runs[0];
  if (runs[0].hostHash !== runs[1].hostHash) problems.push('the two runs end in different states');

  const battery = await lobbyBattery(files);
  for (const b of battery) console.log(`NET LOBBY ${b.ok ? 'PASS' : 'FAIL'}: ${b.label}`);
  for (const b of battery) if (!b.ok) problems.push(`lobby: ${b.label}`);

  const d = await runGame(files, {
    label: 'disconnect',
    endTick: DISCONNECT_END,
    rogue: false,
    lateJoinAt: null,
    breakAt: null,
    disconnectAt: DISCONNECT_TICK,
    crcInterval: CRC_INTERVAL,
  });
  const dOk =
    d.hostTick === DISCONNECT_END &&
    d.hostReason === `ended at tick ${DISCONNECT_END}` &&
    d.playerLeft !== null &&
    d.playerLeft.hand === 1 &&
    d.refHash !== null &&
    d.refHash === d.hostHash &&
    d.alive;
  console.log(
    `NET DISCONNECT ${dOk ? 'PASS' : 'FAIL'}: guest closed at tick ${DISCONNECT_TICK}; host got playerLeft ${JSON.stringify(d.playerLeft)}, ` +
      `ran to tick ${d.hostTick} (hash ${short(d.hostHash)}, reference ${short(d.refHash)}), relay alive ${d.alive}`,
  );
  if (!dOk) problems.push('disconnect run');

  if (problems.length === 0) {
    console.log(`NET CHECK PASS (2 clients, ${TICKS} ticks, ${g.commands} commands, hash ${short(g.hostHash)}, identical)`);
    return 0;
  }
  console.log(`NET CHECK FAIL: ${problems.join('; ')}`);
  return 1;
}

async function breakCheck(): Promise<number> {
  const files = loadFiles();
  console.log(`NET RUN break: ${MAP} seed ${SEED}, client B corrupts the first command with an x coordinate (x+1), CRC32 every tick`);
  const o = await runGame(files, {
    label: 'break',
    endTick: TICKS,
    rogue: false,
    lateJoinAt: null,
    breakAt: 1,
    disconnectAt: null,
    crcInterval: 1,
  });
  console.log(`NET HAND 0 host:  tick ${o.hostTick} hash ${short(o.hostHash)} (${o.hostReason ?? 'no finish'})`);
  console.log(`NET HAND 1 guest: tick ${o.guestTick} hash ${short(o.guestHash)} (${o.guestReason ?? 'no finish'})`);
  if (o.corruptedAt === null) {
    console.log('NET CHECK FAIL: no command was there to corrupt');
    return 1;
  }
  if (o.desyncTick === null) {
    console.log(`NET CHECK FAIL: the corrupted command on client B (tick ${o.corruptedAt}) was not detected`);
    return 1;
  }
  console.log(`NET DESYNC first bad tick ${o.desyncTick}: the CRC32 values differ ${JSON.stringify(o.desyncValues)}; client B's copy of tick ${o.corruptedAt} was corrupted`);
  console.log(`NET CHECK FAIL: DESYNC at tick ${o.desyncTick} (corrupted command on client B at tick ${o.corruptedAt}; the match stopped)`);
  return 1;
}

function loadFiles(): Files {
  const m = mapFiles(MAP);
  return {
    mapPath: m.mapPath,
    mapBytes: m.mapBytes,
    missionDat: m.missionDat,
    defines: defines(),
    mapSha: sha(m.mapBytes),
    definesSha: sha(Buffer.concat(definesBytes())),
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--break')) return process.exit(await breakCheck());
  if (args.includes('--check')) return process.exit(await check());
  console.log('usage: node tools/nettest/cli.ts --check | --break');
  process.exit(2);
}

main().catch((err: unknown) => {
  console.error(`NET ERROR ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
});
