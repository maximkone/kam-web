// lobby.ts — the M6 multiplayer lobby panel of the game screen (docs/M6-SPIKE.md §2, §11). It is the DOM
// around packages/net/browserclient.ts: the relay url, the player name, the hand count, host/join, the room
// list, the room's player and slot list, ready and start. The room's map files are loaded (and hashed) before
// create/join, so both sides send the same mapSha and definesSha; at game/start browserclient.matchHooks
// builds the skirmish from those same bytes and calls back here, and game.ts attaches the renderer and runs
// the relay-driven tick loop.
//
// Fixed match settings, because the protocol carries delay/end/crc only: 4 delay ticks, end tick 100000,
// a CRC checkpoint every 50 ticks, peacetime 0 (peacetime is a local createSkirmish input with no field
// in the protocol, so both sides must use the same fixed value; recorded in docs/M6-SPIKE.md §12) and the
// AI start of an `ai` slot (`MP_AI_START`, the same reason and the same fixed value on every client).

import { openRelay, loadMatchFiles, matchHooks } from '../../../packages/net/browserclient.ts';
import type { MatchFiles } from '../../../packages/net/browserclient.ts';
import type { GameHooks, NetClient } from '../../../packages/net/client.ts';
import type { GameStartMsg, LobbySlot, RoomInfo, RoomState, ServerMessage } from '../../../packages/net/protocol.ts';
import type { Command } from '../../../packages/sim/commands.ts';
import type { Skirmish } from '../../../packages/sim/skirmish.ts';

export const MP_DELAY_TICKS = 4;
export const MP_END_TICK = 100000;
export const MP_CRC_INTERVAL = 50;
export const MP_PEACE_MINUTES = 0;
/**
 * The start an `ai` slot gets in a relay match. The lobby's slot list only carries human/AI, so the handicap is
 * a fixed value every client agrees on (matchHooks passes it to createSkirmish); it is the setup screen's
 * default, so an AI in a relay room is the same opponent as an AI in a single-player skirmish. Without it a
 * host playing alone sits against an AI that cannot raise an army at all (docs/M5-SPIKE.md 7.6).
 */
export const MP_AI_START = 'normal';

/** The lobby protocol's map id: "<folder>/<name>" (protocol.ts isMapId). */
const MAP_ID_RE = /^[A-Za-z][A-Za-z0-9_-]*\/[A-Za-z0-9][A-Za-z0-9 _-]*$/;
const ROOM_ID_RE = /^[A-Za-z0-9]{1,16}$/;

export interface LobbyHandlers {
  /** The map row the host picked on the setup screen (null when none is picked). */
  selectedMap: () => { kind: string; name: string } | null;
  /** The commands this client wants in the next set (the game UI's queue). */
  script: (sk: Skirmish, forTick: number) => Command[];
  /** The client built the skirmish of a game/start: attach the renderer and start the loop. */
  onGameStart: (client: NetClient, sk: Skirmish, files: MatchFiles, start: GameStartMsg) => void;
}

export interface Lobby {
  /** Back to the setup screen after a match: drop the relay socket and clear the panel. */
  reset: () => void;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function createLobby(h: LobbyHandlers): Lobby {
  const q = <T extends HTMLElement>(id: string): T => {
    const el = document.getElementById(id);
    if (el === null) throw new Error(`lobby: the page has no #${id}`);
    return el as T;
  };
  const urlEl = q<HTMLInputElement>('relayurl');
  const nameEl = q<HTMLInputElement>('mpname');
  const handsEl = q<HTMLSelectElement>('mphands');
  const hostEl = q<HTMLButtonElement>('mphost');
  const refreshEl = q<HTMLButtonElement>('mprefresh');
  const idEl = q<HTMLInputElement>('mpjoinid');
  const joinEl = q<HTMLButtonElement>('mpjoin');
  const leaveEl = q<HTMLButtonElement>('mpleave');
  const roomsEl = q<HTMLDivElement>('mprooms');
  const playersEl = q<HTMLDivElement>('mpplayers');
  const readyEl = q<HTMLButtonElement>('mpready');
  const startEl = q<HTMLButtonElement>('mpstart');
  const statusEl = q<HTMLDivElement>('mpstatus');

  let client: NetClient | null = null;
  let files: MatchFiles | null = null;
  let state: RoomState | null = null;
  let busy = false;
  let closing = false;

  const setStatus = (text: string, bad = false): void => {
    statusEl.textContent = text;
    statusEl.classList.toggle('bad', bad);
  };
  const fail = (err: unknown): void => setStatus(err instanceof Error ? err.message : String(err), true);

  const relayUrl = (): string => {
    const v = urlEl.value.trim();
    if (!v.startsWith('ws://') && !v.startsWith('wss://')) throw new Error('the relay url must start with ws:// (for example ws://127.0.0.1:8130)');
    return v;
  };
  const playerName = (): string => {
    const v = nameEl.value.trim();
    return (v === '' ? 'player' : v).slice(0, 32);
  };
  const isHost = (): boolean => client !== null && client.hand === 0;
  const myPlayer = (): { ready: boolean } | null =>
    state === null || client === null ? null : (state.players.find((p) => p.hand === client!.hand) ?? null);

  // ---- rendering --------------------------------------------------------------
  function renderRooms(rooms: RoomInfo[]): void {
    if (rooms.length === 0) {
      roomsEl.innerHTML = '<div class="mpdim">no rooms on this relay</div>';
      return;
    }
    roomsEl.innerHTML = rooms
      .map(
        (r) =>
          `<div class="mprow"><button class="mpbtn mpjoin" data-room="${esc(r.roomId)}" data-map="${esc(r.mapId)}">Join</button>` +
          `<span class="mpdim">${esc(r.roomId)} · ${esc(r.mapId)} · ${r.players}/${r.humans} players of ${r.hands} hands · ${r.phase}</span></div>`,
      )
      .join('');
  }

  function renderState(room: RoomState | null): void {
    state = room;
    if (room === null || client === null) {
      playersEl.innerHTML = '<div class="mpdim">not in a room: host a game or join one</div>';
      readyEl.disabled = true;
      startEl.disabled = true;
      leaveEl.disabled = true;
      return;
    }
    const c = client;
    const mine = myPlayer();
    const rows: string[] = [];
    for (const s of room.slots) {
      const p = room.players.find((x) => x.hand === s.hand);
      const who = p === undefined ? (s.kind === 'ai' ? `AI (${s.aiLevel ?? 'advanced'})` : 'empty') : `${esc(p.name)}${p.ready ? ' · ready' : ' · waiting'}`;
      const you = c.hand === s.hand ? ' (you)' : '';
      const free = p === undefined && s.hand !== 0 && isHost() && room.phase === 'lobby';
      const kind = free
        ? `<select class="mpslot" data-hand="${s.hand}"><option value="human"${s.kind === 'human' ? ' selected' : ''}>human</option><option value="ai"${s.kind === 'ai' ? ' selected' : ''}>AI (advanced)</option></select>`
        : esc(s.kind);
      rows.push(`<div class="mprow"><span class="mpdim">hand ${s.hand}${esc(you)}</span><span>${kind} · ${who}</span></div>`);
    }
    const missing = room.slots.filter((s) => s.kind === 'human' && !room.players.some((p) => p.hand === s.hand)).map((s) => s.hand);
    const hint =
      missing.length > 0 && room.phase === 'lobby'
        ? `<div class="mpdim">start needs a player in hand ${missing.join(', ')} - wait for one to join, or set that slot to AI (the host picks the slots)</div>`
        : '';
    playersEl.innerHTML =
      `<div class="mpdim">room ${esc(room.roomId)} · ${esc(room.mapId)} · ${room.phase}${isHost() ? ' · you are the host' : ''}</div>` + rows.join('') + hint;
    readyEl.disabled = room.phase !== 'lobby' || mine === null;
    readyEl.textContent = mine !== null && mine.ready ? 'Not ready' : 'Ready';
    startEl.disabled = !(isHost() && room.phase === 'lobby');
    leaveEl.disabled = false;
  }

  const sendSlots = (): void => {
    const c = client;
    if (state === null || c === null) return;
    const picked = new Map<number, string>();
    for (const sel of playersEl.querySelectorAll('select.mpslot')) {
      picked.set(Number((sel as HTMLSelectElement).dataset.hand), (sel as HTMLSelectElement).value);
    }
    const slots: LobbySlot[] = state.slots.map((s) => {
      const kind = picked.get(s.hand) ?? s.kind;
      return kind === 'ai' ? { hand: s.hand, kind: 'ai', aiLevel: 'advanced' } : { hand: s.hand, kind: 'human' };
    });
    c.send({ kind: 'lobby/slots', slots });
  };

  // ---- the relay --------------------------------------------------------------
  function onMessage(msg: ServerMessage): void {
    switch (msg.kind) {
      case 'lobby/created':
        setStatus(`room ${msg.roomId} created, you are hand ${msg.hand}`);
        return;
      case 'lobby/joined':
        setStatus(`joined room ${msg.roomId} as hand ${msg.hand}`);
        return;
      case 'lobby/rooms':
        renderRooms(msg.rooms);
        setStatus(`${msg.rooms.length} room(s) on the relay`);
        return;
      case 'lobby/state':
        renderState(msg.room);
        return;
      case 'lobby/closed':
        files = null;
        renderState(null);
        setStatus(msg.reason);
        return;
      case 'game/desync':
        setStatus(`DESYNC at tick ${msg.tick}: ${JSON.stringify(msg.values)}`, true);
        return;
      case 'game/rejected':
        setStatus(`rejected at tick ${msg.tick}: ${msg.reason}`, true);
        return;
      case 'game/playerLeft':
        setStatus(`hand ${msg.hand} left at tick ${msg.atTick}`);
        return;
      case 'error':
        setStatus(`${msg.code}: ${msg.reason}`, true);
        return;
      default:
        return;
    }
  }

  function hooks(): GameHooks {
    return matchHooks({
      files: () => {
        if (files === null) throw new Error('lobby: no match files were loaded for this room');
        return files;
      },
      peaceMinutes: MP_PEACE_MINUTES,
      aiStart: MP_AI_START,
      script: (sk: Skirmish, forTick: number) => h.script(sk, forTick),
      onProblem: (reason: string) => setStatus(reason, true),
      onStart: (sk: Skirmish, start: GameStartMsg) => {
        const c = client;
        const f = files;
        if (c === null || f === null) return;
        h.onGameStart(c, sk, f, start);
      },
    });
  }

  async function connect(): Promise<NetClient> {
    if (client !== null && client.status === 'open') return client;
    const url = relayUrl();
    setStatus(`connecting to ${url} ...`);
    const c = await openRelay(url, hooks());
    client = c;
    c.onMessage = onMessage;
    c.onError = (reason: string) => setStatus(reason, true);
    c.onClose = (code: number) => {
      const wasClosing = closing;
      closing = false;
      client = null;
      files = null;
      renderState(null);
      setStatus(wasClosing ? 'left the match' : `the relay closed the connection (${code})`, !wasClosing && code !== 1000);
    };
    setStatus(`connected to ${url}`);
    return c;
  }

  async function withBusy(run: () => Promise<void>): Promise<void> {
    if (busy) return;
    busy = true;
    hostEl.disabled = true;
    refreshEl.disabled = true;
    joinEl.disabled = true;
    try {
      await run();
    } catch (err) {
      fail(err);
    } finally {
      busy = false;
      hostEl.disabled = false;
      refreshEl.disabled = false;
      joinEl.disabled = false;
    }
  }

  /** The room list is the only place a joiner learns the host's mapId, so it comes first, then the files. */
  async function joinAs(roomId: string, mapId: string): Promise<void> {
    const c = await connect();
    setStatus(`loading ${mapId} ...`);
    files = await loadMatchFiles(mapId);
    setStatus(`joining ${roomId} ...`);
    c.send({ kind: 'lobby/join', roomId, mapSha: files.mapSha, definesSha: files.definesSha, name: playerName() });
  }

  /** Asks for the room list and resolves the room with this id (null after 5 s). */
  function findRoom(c: NetClient, roomId: string): Promise<RoomInfo | null> {
    return new Promise((resolve) => {
      const prev = c.onMessage;
      const done = (r: RoomInfo | null): void => {
        clearTimeout(timer);
        c.onMessage = prev;
        resolve(r);
      };
      const timer = setTimeout(() => done(null), 5000);
      c.onMessage = (m: ServerMessage) => {
        prev?.(m);
        if (m.kind !== 'lobby/rooms') return;
        done(m.rooms.find((r) => r.roomId === roomId) ?? null);
      };
      c.send({ kind: 'lobby/list' });
    });
  }

  // ---- the panel's controls ----------------------------------------------------
  hostEl.addEventListener('click', () =>
    void withBusy(async () => {
      const sel = h.selectedMap();
      if (sel === null) throw new Error('select a map in the list first');
      const mapId = `${sel.kind}/${sel.name}`;
      if (!MAP_ID_RE.test(mapId)) throw new Error(`the relay cannot take "${mapId}": a map id allows letters, digits, space, _ and - only`);
      const c = await connect();
      setStatus(`loading ${mapId} ...`);
      files = await loadMatchFiles(mapId);
      c.send({ kind: 'lobby/create', mapId, mapSha: files.mapSha, definesSha: files.definesSha, hands: Number(handsEl.value), name: playerName() });
    }),
  );

  refreshEl.addEventListener('click', () =>
    void withBusy(async () => {
      const c = await connect();
      c.send({ kind: 'lobby/list' });
    }),
  );

  joinEl.addEventListener('click', () =>
    void withBusy(async () => {
      const id = idEl.value.trim();
      if (!ROOM_ID_RE.test(id)) throw new Error('a room id is 1..16 letters or digits (the room list shows them)');
      if (state !== null && state.roomId === id) {
        await joinAs(id, state.mapId);
        return;
      }
      const c = await connect();
      const found = await findRoom(c, id);
      if (found === null) throw new Error(`no room ${id} on this relay`);
      await joinAs(found.roomId, found.mapId);
    }),
  );

  roomsEl.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button.mpjoin') as HTMLButtonElement | null;
    if (b === null) return;
    const roomId = b.dataset.room ?? '';
    const mapId = b.dataset.map ?? '';
    void withBusy(async () => {
      await joinAs(roomId, mapId);
    });
  });

  leaveEl.addEventListener('click', () => client?.send({ kind: 'lobby/leave' }));

  playersEl.addEventListener('change', (e) => {
    if ((e.target as HTMLElement).classList.contains('mpslot')) sendSlots();
  });

  readyEl.addEventListener('click', () => {
    const mine = myPlayer();
    client?.send({ kind: 'lobby/ready', ready: !(mine !== null && mine.ready) });
  });

  startEl.addEventListener('click', () => {
    const c = client;
    if (c === null || state === null) return;
    if (c.hand !== 0) {
      setStatus('only the host starts the match', true);
      return;
    }
    const mine = myPlayer();
    if (mine === null || !mine.ready) c.send({ kind: 'lobby/ready', ready: true });
    c.send({ kind: 'lobby/start', delayTicks: MP_DELAY_TICKS, endTick: MP_END_TICK, crcInterval: MP_CRC_INTERVAL });
  });

  renderRooms([]);
  renderState(null);
  setStatus('enter the relay url, pick a map, then host; or refresh the room list and join');

  return {
    reset(): void {
      const c = client;
      client = null;
      files = null;
      state = null;
      roomsEl.innerHTML = '';
      idEl.value = '';
      renderState(null);
      setStatus('left the match; host or join again');
      if (c !== null && c.status === 'open') {
        closing = true;
        c.close();
      }
    },
  };
}
