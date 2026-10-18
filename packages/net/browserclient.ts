// browserclient.ts — the browser entry of the multiplayer client (M6, docs/M6-SPIKE.md §2, §5, §11): the
// global WebSocket with the same NetClient and Lockstep the Node tests use, the match files of a lobby room
// (the .map, the mission and the four defines, hashed with crypto.subtle for the lobby's sha checks) and the
// game hooks of a game/start (the caller loads and checks its own map and defines; this file does the fetch).
// Wired into the web app: apps/web/game/lobby.ts opens the relay and builds the match through this module.
// Browser-safe: no node: imports; uses fetch, crypto.subtle and the global WebSocket.

import { NetClient } from './client.ts';
import type { GameHooks } from './client.ts';
import { createSkirmish } from '../sim/skirmish.ts';
import type { Skirmish, SkirmishDefines } from '../sim/skirmish.ts';
import type { CommandInput } from './lockstep.ts';
import type { Command } from '../sim/commands.ts';
import type { GameStartMsg } from './protocol.ts';
import type { AiStartLevel } from '../sim/aistart.ts';

/** Opens the relay socket (the global WebSocket) and resolves once it is open. */
export async function openRelay(url: string, hooks: GameHooks | null = null): Promise<NetClient> {
  const client = new NetClient({ url });
  client.hooks = hooks;
  await client.connect();
  return client;
}

/** SHA-256 of bytes, as 64 lowercase hex characters (the mapSha of the lobby). */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The definesSha of the lobby: SHA-256 over the defines files' bytes in the order given (tiles.json, mapelem.dat, unit.dat, houses.dat). */
export async function definesSha(files: Uint8Array[]): Promise<string> {
  const total = files.reduce((n, f) => n + f.length, 0);
  const all = new Uint8Array(total);
  let at = 0;
  for (const f of files) {
    all.set(f, at);
    at += f.length;
  }
  return sha256Hex(all);
}

// ---- the match files of one lobby room --------------------------------------
// A client can only create or join a room with the map and defines the host has, so it loads the room's
// mapId itself (the app serves the KaM install's files: /mapfile/<kind>/<name>/<map|dat> and /defines/*)
// and hashes the bytes with the same sha functions the lobby sends. The same bytes then build the sim at
// game/start (matchHooks), which is why nothing is re-fetched once the match starts: both sides build
// createSkirmish from exactly the bytes they hashed.

/** The files one room's match needs on this client, with the two sha256 hex strings the lobby carries. */
export interface MatchFiles {
  mapId: string; // "<kind>/<name>" (the lobby's mapId)
  kind: string;
  name: string;
  mapBytes: Uint8Array;
  missionDat: Uint8Array;
  defines: SkirmishDefines;
  mapSha: string;
  definesSha: string;
}

/** Where the dev server (apps/web/serve.ts) serves one match's files; override for another layout. */
export interface MatchFileUrls {
  map: string;
  dat: string;
  tilesJson: string;
  mapElem: string;
  unitDat: string;
  housesDat: string;
}

/** The routes of apps/web/serve.ts for one map: the .map, its mission .dat and the four defines files. */
export function matchFileUrls(kind: string, name: string): MatchFileUrls {
  const base = `/mapfile/${encodeURIComponent(kind)}/${encodeURIComponent(name)}`;
  return {
    map: `${base}/map`,
    dat: `${base}/dat`,
    tilesJson: '/defines/tiles.json',
    mapElem: '/defines/mapelem.dat',
    unitDat: '/defines/unit.dat',
    housesDat: '/defines/houses.dat',
  };
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`cannot load ${url}: ${r.status} ${r.statusText}`);
  return new Uint8Array(await r.arrayBuffer());
}

/**
 * Loads one map's match files and their sha256s (the lobby's mapSha and definesSha). The definesSha is over
 * the four files' bytes in the order tiles.json, mapelem.dat, unit.dat, houses.dat (the lobby's order).
 */
export async function loadMatchFiles(mapId: string, urls: MatchFileUrls | null = null): Promise<MatchFiles> {
  const at = mapId.indexOf('/');
  if (at <= 0) throw new Error(`the map id must be "<folder>/<name>", got "${mapId}"`);
  const kind = mapId.slice(0, at);
  const name = mapId.slice(at + 1);
  const u = urls ?? matchFileUrls(kind, name);
  const [mapBytes, missionDat, tiles, mapElem, unitDat, housesDat] = await Promise.all([
    fetchBytes(u.map),
    fetchBytes(u.dat),
    fetchBytes(u.tilesJson),
    fetchBytes(u.mapElem),
    fetchBytes(u.unitDat),
    fetchBytes(u.housesDat),
  ]);
  const defines: SkirmishDefines = {
    tilesJson: new TextDecoder().decode(tiles),
    mapElem,
    unitDat,
    housesDat,
  };
  const [mapSha, dsha] = await Promise.all([sha256Hex(mapBytes), definesSha([tiles, mapElem, unitDat, housesDat])]);
  return { mapId, kind, name, mapBytes, missionDat, defines, mapSha, definesSha: dsha };
}

export interface MatchHooksOptions {
  /** The match files of the room, loaded before create/join and read again at game/start. */
  files: () => MatchFiles;
  /** The Remake's peacetime option for the match (0 by default). Every client must use the same value. */
  peaceMinutes?: number;
  /**
   * The AI start handicap of an `ai` slot (the setup screen's option; `none` by default). Every client must use
   * the same value. Without it a relay match hands the AI only what the map gives it, which on most maps is no
   * army at all (docs/M5-SPIKE.md 7.6), so a host playing alone against an AI would face a much weaker opponent
   * than the very same AI in a single-player skirmish.
   */
  aiStart?: AiStartLevel;
  /** The commands this client chooses for a set of tick `forTick` (the app's UI queue). Optional. */
  script?: (sk: Skirmish, forTick: number) => Command[];
  /** Runs after the skirmish of a game/start is built (the app attaches its renderer here). Optional. */
  onStart?: (sk: Skirmish, start: GameStartMsg) => void;
  /** Reports why a game/start could not be built. Optional. */
  onProblem?: (reason: string) => void;
}

/**
 * The GameHooks of a relay match: game/start carries the seed and the slots, this client supplies the map it
 * loaded and hashed for the lobby, so every client builds the same `createSkirmish` inputs. A sha256 mismatch
 * (the room changed under us) is reported instead of starting a match that would desync.
 */
export function matchHooks(o: MatchHooksOptions): GameHooks {
  return {
    createSkirmish: (start: GameStartMsg): Skirmish => {
      const f = o.files();
      if (start.mapSha !== f.mapSha || start.definesSha !== f.definesSha) {
        o.onProblem?.('the local map or defines differ from the room (sha256 mismatch)');
        throw new Error(`the map or defines of ${start.mapId} differ from the room`);
      }
      let sk: Skirmish;
      try {
        sk = createSkirmish({
          mapBytes: f.mapBytes,
          mapPath: `${f.kind}/${f.name}.map`,
          missionDat: f.missionDat,
          defines: f.defines,
          seed: start.seed,
          slots: start.slots.map((s) => ({ hand: s.hand, kind: s.kind, aiLevel: s.aiLevel, aiStart: s.kind === 'ai' ? o.aiStart : undefined })),
          peaceMinutes: o.peaceMinutes ?? 0,
        });
      } catch (err) {
        o.onProblem?.(`cannot build the match: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      }
      o.onStart?.(sk, start);
      return sk;
    },
    // The lockstep stamps hand and tick onto every set command, so the sim's Command is the CommandInput it takes.
    script: o.script === undefined ? undefined : (sk: Skirmish, forTick: number) => o.script!(sk, forTick) as unknown as CommandInput[],
  };
}
