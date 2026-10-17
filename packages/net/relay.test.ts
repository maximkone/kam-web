// relay.test.ts — the relay in-process over real sockets (node's global WebSocket): lobby refusals, the lockstep
// ordering of a short game without a sim (broadcast order, a rogue command, the late deadline, CRC match and
// desync, game/end) and the bad frames. The full sim check is tools/nettest/cli.ts --check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRelay } from '../../apps/server/relay.ts';
import type { Relay } from '../../apps/server/relay.ts';
import { NetClient } from './client.ts';
import type { ServerMessage } from './protocol.ts';

const SHA = 'c'.repeat(64);

interface Peer {
  client: NetClient;
  msgs: ServerMessage[];
}

async function until(cond: () => boolean, label: string, ms = 30000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout: ${label}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

async function peer(url: string): Promise<Peer> {
  const client = new NetClient({ url });
  const msgs: ServerMessage[] = [];
  client.onMessage = (m) => msgs.push(m);
  client.onError = () => {};
  await client.connect();
  return { client, msgs };
}

function ofKind<K extends ServerMessage['kind']>(p: Peer, kind: K): Extract<ServerMessage, { kind: K }>[] {
  return p.msgs.filter((m): m is Extract<ServerMessage, { kind: K }> => m.kind === kind);
}

async function tickSeen(p: Peer, tick: number): Promise<void> {
  await until(() => ofKind(p, 'game/tick').some((m) => m.tick === tick), `game/tick ${tick}`);
}

async function lobbyWithGame(relay: Relay, endTick: number, delayTicks: number, crcInterval: number): Promise<{ host: Peer; guest: Peer }> {
  const url = `ws://127.0.0.1:${relay.port}`;
  const host = await peer(url);
  const guest = await peer(url);
  host.client.send({ kind: 'lobby/create', mapId: 'MapsMP/Battle Sun', mapSha: SHA, definesSha: SHA, hands: 2, name: 'host' });
  await until(() => ofKind(host, 'lobby/created').length === 1, 'created');
  const roomId = ofKind(host, 'lobby/created')[0].roomId;
  guest.client.send({ kind: 'lobby/join', roomId, mapSha: SHA, definesSha: SHA, name: 'guest' });
  await until(() => ofKind(guest, 'lobby/joined').length === 1, 'joined');
  host.client.send({ kind: 'lobby/ready', ready: true });
  guest.client.send({ kind: 'lobby/ready', ready: true });
  await until(() => {
    const states = ofKind(host, 'lobby/state');
    return states.length > 0 && states[states.length - 1].room.players.filter((p) => p.ready).length === 2;
  }, 'both ready');
  host.client.send({ kind: 'lobby/start', delayTicks, endTick, crcInterval });
  await until(() => ofKind(guest, 'game/start').length === 1 && ofKind(host, 'game/start').length === 1, 'game/start');
  return { host, guest };
}

test('a joiner with another map sha is refused with a reason; the same sha joins', async () => {
  const relay = await startRelay({ seed: 1, lateMs: 50 });
  const url = `ws://127.0.0.1:${relay.port}`;
  try {
    const host = await peer(url);
    host.client.send({ kind: 'lobby/create', mapId: 'MapsMP/Battle Sun', mapSha: SHA, definesSha: SHA, hands: 2, name: 'host' });
    await until(() => ofKind(host, 'lobby/created').length === 1, 'created');
    const bad = await peer(url);
    bad.client.send({ kind: 'lobby/join', roomId: ofKind(host, 'lobby/created')[0].roomId, mapSha: 'a'.repeat(64), definesSha: SHA, name: 'bad' });
    await until(() => ofKind(bad, 'error').length === 1, 'refusal');
    assert.equal(ofKind(bad, 'error')[0].code, 'refused');
    assert.match(ofKind(bad, 'error')[0].reason, /sha256/);
    host.client.close();
    bad.client.close();
  } finally {
    await relay.stop();
  }
});

test('lockstep: broadcasts in order, a rogue command rejected, the CRCs match, game/end', async () => {
  const relay = await startRelay({ seed: 2, lateMs: 500 });
  try {
    const { host, guest } = await lobbyWithGame(relay, 6, 2, 2);
    const hostCmd = { hand: 0, tick: 3, type: 'groupHalt', groupUid: 1 };
    for (let t = 1; t <= 6; t++) {
      host.client.send({ kind: 'game/commands', tick: t, commands: t === 3 ? [hostCmd] : [] });
      guest.client.send({ kind: 'game/commands', tick: t, commands: t === 3 ? [{ ...hostCmd, hand: 0 }] : [] });
    }
    for (const t of [2, 4, 6]) {
      await tickSeen(host, t);
      await tickSeen(guest, t);
      host.client.send({ kind: 'game/crc', tick: t, value: 'abcd1234' });
      guest.client.send({ kind: 'game/crc', tick: t, value: 'abcd1234' });
    }
    await until(() => ofKind(host, 'game/end').length === 1 && ofKind(guest, 'game/end').length === 1, 'game/end');
    for (const p of [host, guest]) {
      assert.deepEqual(ofKind(p, 'game/tick').map((m) => m.tick), [1, 2, 3, 4, 5, 6]);
      assert.equal(ofKind(p, 'game/desync').length, 0);
    }
    assert.deepEqual(ofKind(host, 'game/tick')[2].commands, [{ hand: 0, tick: 3, type: 'groupHalt', groupUid: 1 }]);
    assert.deepEqual(ofKind(guest, 'game/tick')[2].commands, ofKind(host, 'game/tick')[2].commands);
    const rejected = ofKind(guest, 'game/rejected');
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].tick, 3);
    assert.match(rejected[0].reason, /you are hand 1/);
    assert.equal(ofKind(host, 'game/end')[0].tick, 6);
    host.client.close();
    guest.client.close();
  } finally {
    await relay.stop();
  }
});

test('a CRC mismatch stops the match with game/desync naming the tick', async () => {
  const relay = await startRelay({ seed: 3, lateMs: 500 });
  try {
    const { host, guest } = await lobbyWithGame(relay, 4, 1, 2);
    for (let t = 1; t <= 4; t++) {
      host.client.send({ kind: 'game/commands', tick: t, commands: [] });
      guest.client.send({ kind: 'game/commands', tick: t, commands: [] });
    }
    await tickSeen(host, 2);
    await tickSeen(guest, 2);
    host.client.send({ kind: 'game/crc', tick: 2, value: '11111111' });
    guest.client.send({ kind: 'game/crc', tick: 2, value: '22222222' });
    await until(() => ofKind(host, 'game/desync').length === 1 && ofKind(guest, 'game/desync').length === 1, 'desync');
    assert.equal(ofKind(host, 'game/desync')[0].tick, 2);
    assert.deepEqual(ofKind(host, 'game/desync')[0].values, { '0': '11111111', '1': '22222222' });
    assert.equal(ofKind(host, 'game/end').length, 0);
    host.client.close();
    guest.client.close();
  } finally {
    await relay.stop();
  }
});

test('a set that misses the late deadline goes on without it; the late player is told', async () => {
  const relay = await startRelay({ seed: 4, lateMs: 60 });
  try {
    const { host, guest } = await lobbyWithGame(relay, 4, 1, 1000);
    host.client.send({ kind: 'game/commands', tick: 1, commands: [] });
    guest.client.send({ kind: 'game/commands', tick: 1, commands: [] });
    host.client.send({ kind: 'game/commands', tick: 2, commands: [] });
    guest.client.send({ kind: 'game/commands', tick: 2, commands: [] });
    host.client.send({ kind: 'game/commands', tick: 3, commands: [{ hand: 0, tick: 3, type: 'groupHalt', groupUid: 1 }] });
    await until(() => ofKind(host, 'game/tick').length >= 3, 'tick 3 after the deadline');
    assert.deepEqual(ofKind(host, 'game/tick')[2].commands, [{ hand: 0, tick: 3, type: 'groupHalt', groupUid: 1 }]);
    await until(() => ofKind(guest, 'game/late').length === 1, 'game/late to the guest');
    assert.equal(ofKind(guest, 'game/late')[0].tick, 3);
    host.client.send({ kind: 'game/commands', tick: 4, commands: [] });
    guest.client.send({ kind: 'game/commands', tick: 3, commands: [] });
    guest.client.send({ kind: 'game/commands', tick: 4, commands: [] });
    await until(() => ofKind(host, 'game/end').length === 1, 'game/end after the late set');
    host.client.close();
    guest.client.close();
  } finally {
    await relay.stop();
  }
});

test('a malformed frame is rejected and the connection goes on; an oversized frame closes 1009', async () => {
  const relay = await startRelay({ seed: 5, lateMs: 50 });
  const url = `ws://127.0.0.1:${relay.port}`;
  try {
    const p = await peer(url);
    p.client.sendRaw('{"kind": "lobby/list"');
    await until(() => ofKind(p, 'error').length === 1, 'bad-message');
    assert.equal(ofKind(p, 'error')[0].code, 'bad-message');
    p.client.send({ kind: 'lobby/list' });
    await until(() => ofKind(p, 'lobby/rooms').length === 1, 'rooms after a bad frame');

    const big = new NetClient({ url });
    let code = 0;
    big.onClose = (c) => {
      code = c;
    };
    await big.connect();
    big.sendRaw('x'.repeat(70000));
    await until(() => code !== 0, 'close 1009');
    assert.equal(code, 1009);

    const q = await peer(url);
    q.client.send({ kind: 'lobby/list' });
    await until(() => ofKind(q, 'lobby/rooms').length === 1, 'relay alive after an oversized frame');
    p.client.close();
    q.client.close();
  } finally {
    await relay.stop();
  }
});
