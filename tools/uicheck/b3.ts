// tools/uicheck/b3.ts — the REAL browser check of M6 multiplayer (docs/M6-SPIKE.md §2, §11, §12): one player
// is a real browser, the other is the SAME client code (packages/net/browserclient.ts) run by Node. The check
// starts its own relay and its own dev server: the browser hosts a room, the Node peer loads the room's map
// and defines over /mapfile + /defines, hashes them with the same sha256 the browser uses, joins, readies,
// and the host starts. Both must run the relay's clock, stay on the same tick and never report DESYNC.
//
// Why not two browsers: a second headless window is throttled and can be frozen outright, which killed one
// player mid-match (measured 2026-10-18). The Node peer keeps the browser honest all the same — the browser
// still builds the skirmish from the room's bytes and runs the relay-driven loop.
//
//   node tools/uicheck/b3.ts --check [--web-port 8220] [--cdp-port 9420] [--relay-port 8131] [--map "Battle Sun"]
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { openSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, SHOTS, openBrowser, sleep, waitFor } from './cdplib.ts';
import type { Browser } from './cdplib.ts';
import { loadMatchFiles, matchHooks, openRelay } from '../../packages/net/browserclient.ts';
import type { MatchFiles, MatchFileUrls } from '../../packages/net/browserclient.ts';
import type { NetClient } from '../../packages/net/client.ts';
import type { ServerMessage } from '../../packages/net/protocol.ts';
import type { Skirmish } from '../../packages/sim/skirmish.ts';

const arg = (name: string, d: string): string => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1]! : d;
};
if (!process.argv.includes('--check')) {
  console.log('usage: node tools/uicheck/b3.ts --check [--web-port 8220] [--cdp-port 9420] [--relay-port 8131] [--map "Battle Sun"]');
  process.exit(1);
}
const webPort = Number(arg('--web-port', '8220'));
const cdpPort = Number(arg('--cdp-port', '9420'));
const relayPort = Number(arg('--relay-port', '8131'));
const mapName = arg('--map', 'Battle Sun');
const relayUrl = `ws://127.0.0.1:${relayPort}`;
const webBase = `http://127.0.0.1:${webPort}`;

/** Type into a text/select field the way a player does: value + event. */
const put = (id: string, value: string, ev = 'input'): string =>
  `(() => { const el = document.getElementById(${JSON.stringify(id)}); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event(${JSON.stringify(ev)}, { bubbles: true })); return true; })()`;

let relay: ChildProcess | null = null;
let relayExit = '';
const relayLog = join(SHOTS, 'b3-relay.log');
const stopRelay = (): void => { if (relay !== null && relay.exitCode === null) { try { relay.kill(); } catch { /* gone */ } } };

const host = await openBrowser({ webPort, cdpPort, deadlineMs: 280000 });
const statusOf = async (): Promise<string> => host.eval("document.getElementById('mpstatus').textContent").then((v) => String(v)).catch((e: Error) => `<eval failed: ${e.message.slice(0, 60)}>`);
const tickOf = async (): Promise<number> => host.eval("Number(document.getElementById('tick').textContent)").catch(() => -1);
const setupHidden = async (): Promise<boolean> => host.eval("document.getElementById('setup').classList.contains('hide')").catch(() => false);

/** The peer (the second player): the same NetClient the browser runs, pumped by a 100 ms interval. */
interface Peer {
  client: NetClient;
  tick: () => number;
  notes: string[];
  interval: ReturnType<typeof setInterval> | null;
}

/** Loads the room's files over the dev server exactly as the browser does, then joins the room as a second player. */
async function startPeer(kind: string, name: string, roomId: string): Promise<Peer> {
  const urls: MatchFileUrls = {
    map: `${webBase}/mapfile/${encodeURIComponent(kind)}/${encodeURIComponent(name)}/map`,
    dat: `${webBase}/mapfile/${encodeURIComponent(kind)}/${encodeURIComponent(name)}/dat`,
    tilesJson: `${webBase}/defines/tiles.json`,
    mapElem: `${webBase}/defines/mapelem.dat`,
    unitDat: `${webBase}/defines/unit.dat`,
    housesDat: `${webBase}/defines/houses.dat`,
  };
  const files: MatchFiles = await loadMatchFiles(`${kind}/${name}`, urls);
  const notes: string[] = [`peer mapSha ${files.mapSha.slice(0, 12)} definesSha ${files.definesSha.slice(0, 12)}`];
  const state: { client: NetClient | null; interval: ReturnType<typeof setInterval> | null; tick: number } = { client: null, interval: null, tick: 0 };
  const hooks = matchHooks({
    files: () => files,
    peaceMinutes: 0,
    script: () => [],
    onProblem: (reason: string) => notes.push('problem: ' + reason),
    onStart: () => {
      if (state.interval !== null) clearInterval(state.interval);
      state.interval = setInterval(() => {
        const c = state.client;
        if (c === null) return;
        try { c.advance(); if (c.sk !== null) state.tick = c.sk.world.tickCount; } catch { /* finished */ }
      }, 100);
    },
  });
  const client = await openRelay(relayUrl, hooks);
  state.client = client;
  client.onMessage = (m: ServerMessage) => {
    if (m.kind === 'game/desync') notes.push(`peer DESYNC at tick ${m.tick}`);
    if (m.kind === 'error') notes.push(`peer error ${m.code}: ${m.reason}`);
    if (m.kind === 'lobby/rooms') {
      const room = m.rooms.find((r) => r.roomId === roomId) ?? m.rooms[0];
      if (room === undefined) notes.push('peer: no room in the list');
      else client.send({ kind: 'lobby/join', roomId: room.roomId, mapSha: files.mapSha, definesSha: files.definesSha, name: 'peer' });
    }
  };
  // Find the host's room the way the browser does: ask for the list, then join what comes back.
  client.send({ kind: 'lobby/list' });
  await waitFor<boolean>(async () => (client.hand !== null ? true : null), 'the peer is in the room', 30000)
    .catch((e: Error) => { notes.push(e.message); return false; });
  client.send({ kind: 'lobby/ready', ready: true });
  return { client, tick: () => state.tick, notes, interval: state.interval };
}

const relayer = (p: Peer): void => { if (p.interval !== null) clearInterval(p.interval); };

try {
  // ---- our own relay (never the one on the Desktop) ---------------------------
  const relayFd = openSync(relayLog, 'w');
  relay = spawn(process.execPath, ['apps/server/relay.ts', '--port', String(relayPort), '--host', '127.0.0.1'], { cwd: ROOT, stdio: ['ignore', relayFd, relayFd] });
  relay.on('exit', (code, signal) => { relayExit = `exited (${code ?? signal})`; });
  await waitFor(async () => { try { await fetch(`http://127.0.0.1:${relayPort}/`, { signal: AbortSignal.timeout(1500) }); return true; } catch { return false; } }, `the relay on ${relayPort}`, 30000);

  // ---- the browser hosts a room ------------------------------------------------
  await host.goto('/game.html');
  await waitFor(async () => (await host.eval("document.querySelectorAll('.maprow').length")) > 0, 'the map list', 90000);
  await host.eval(`(() => { const f = document.getElementById('filter'); f.value = ${JSON.stringify(mapName)}; f.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await waitFor(async () => (await host.eval(`[...document.querySelectorAll('.maprow')].some((r) => r.dataset.name === ${JSON.stringify(mapName)})`)) === true, `the map row "${mapName}"`, 30000);
  await host.eval(`[...document.querySelectorAll('.maprow')].find((r) => r.dataset.name === ${JSON.stringify(mapName)}).click()`);
  await host.eval(put('relayurl', relayUrl));
  await host.eval(put('mpname', 'host'));
  await host.expect((await host.eval("document.getElementById('relayurl').value")) === relayUrl, 'the relay url field took ' + relayUrl);
  await host.eval("document.getElementById('mphost').click()");
  const created = await waitFor(async () => {
    const m = /room ([A-Za-z0-9]{1,16}) created/.exec(await statusOf());
    return m === null ? null : m[1]!;
  }, 'the host creates a room', 60000).catch(async (e: Error) => { throw new Error(`${e.message} (host: ${await statusOf()}; relay ${relayExit || 'alive'})`); });
  host.notes.push(`host created room ${created}`);
  await waitFor(async () => (await host.eval("document.getElementById('mpplayers').textContent")).includes('hand 1'), 'the slot list shows hand 1', 30000);

  // ---- the Node peer joins and readies, then the host starts -------------------
  const peer = await startPeer('MapsMP', mapName, created);
  for (const n of peer.notes) host.notes.push(n);
  const joined = await waitFor(async () => ((await host.eval("document.getElementById('mpplayers').textContent")).includes('peer') ? true : null), 'the host sees the peer', 30000)
    .catch(async (e: Error) => { throw new Error(`${e.message} (host: ${await statusOf()}; peer: ${peer.notes.join('; ')})`); });
  host.expect(joined === true, 'the host sees the peer in the slot list');
  host.expect((await host.eval("document.getElementById('mpstart').disabled")) === false, 'the host may start');
  await host.eval("document.getElementById('mpstart').click()");
  await waitFor(async () => (await setupHidden()) === true, 'the host leaves the setup screen (game/start arrived)', 60000)
    .catch(async (e: Error) => { throw new Error(`${e.message} (host: ${await statusOf()}; peer: ${peer.notes.join('; ')})`); });
  await waitFor(async () => (await tickOf()) >= 5, 'the host game loop runs (tick >= 5)', 90000)
    .catch(async (e: Error) => { throw new Error(`${e.message} (host: ${await statusOf()}; peer: ${peer.notes.join('; ')})`); });
  const a1 = await tickOf();
  await sleep(3000);
  const a2 = await tickOf();
  const peer1 = peer.tick();
  host.notes.push(`host tick ${a1}->${a2}, peer tick ${peer1}`);
  host.expect(a2 > a1, `the host keeps ticking (${a1} -> ${a2})`);
  host.expect(peer1 >= 5, `the peer runs the same match (peer tick ${peer1})`);
  host.expect(Math.abs(a2 - peer1) <= 25, `both clients are at the same tick (host ${a2}, peer ${peer1})`);
  const hs = await statusOf();
  host.expect(!hs.includes('DESYNC'), `the host reports no DESYNC (status: ${hs.slice(0, 100)})`);
  host.expect(!peer.notes.some((n) => n.includes('DESYNC')), `the peer reports no DESYNC (${peer.notes.join('; ')})`);
  host.expect(!hs.includes('rejected'), `the relay rejected nothing (status: ${hs.slice(0, 100)})`);
  const shot = await host.shot('mp-host');
  host.notes.push(`shot mp-host=${shot} bytes`);
  relayer(peer);
  peer.client.close();
} catch (err) {
  host.failures.push('threw: ' + (err instanceof Error ? err.message : String(err)) + ` (host: ${await statusOf()})`);
}
const code = host.report('UI B3 CHECK');
await host.close();
stopRelay();
process.exit(code);
