// client.test.ts — NetClient over a fake socket: connect, lobby routing, bad frames, send and close (no sim).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NetClient } from './client.ts';

class FakeSocket {
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  send(data: string): void {
    this.sent.push(data);
  }
  close(code = 1000): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  deliver(text: string): void {
    this.onmessage?.({ data: text });
  }
}

function clientWithFake(): { client: NetClient; fake: FakeSocket } {
  const fake = new FakeSocket();
  const client = new NetClient({ url: 'ws://fake', makeSocket: () => fake as unknown as WebSocket });
  return { client, fake };
}

test('connect resolves when the socket opens and the client is open', async () => {
  const { client, fake } = clientWithFake();
  const p = client.connect();
  fake.open();
  await p;
  assert.equal(client.status, 'open');
});

test('lobby/created sets the room and the hand', async () => {
  const { client, fake } = clientWithFake();
  const p = client.connect();
  fake.open();
  await p;
  const seen: string[] = [];
  client.onMessage = (m) => seen.push(m.kind);
  fake.deliver(JSON.stringify({ kind: 'lobby/created', roomId: 'abc123', hand: 0 }));
  assert.equal(client.roomId, 'abc123');
  assert.equal(client.hand, 0);
  assert.deepEqual(seen, ['lobby/created']);
});

test('a malformed server frame is reported and does not throw', async () => {
  const { client, fake } = clientWithFake();
  const p = client.connect();
  fake.open();
  await p;
  const errors: string[] = [];
  client.onError = (r) => errors.push(r);
  fake.deliver('{not json');
  fake.deliver(JSON.stringify({ kind: 'game/tick', tick: 'one', commands: [] }));
  assert.equal(errors.length, 2);
});

test('game/start without game hooks is reported, not run', async () => {
  const { client, fake } = clientWithFake();
  const p = client.connect();
  fake.open();
  await p;
  const errors: string[] = [];
  client.onError = (r) => errors.push(r);
  fake.deliver(
    JSON.stringify({
      kind: 'game/start',
      seed: 1,
      mapId: 'MapsMP/Battle Sun',
      mapSha: 'a'.repeat(64),
      definesSha: 'b'.repeat(64),
      delayTicks: 4,
      endTick: 100,
      crcInterval: 50,
      slots: [{ hand: 0, kind: 'human' }, { hand: 1, kind: 'human' }],
      yourHand: 0,
    }),
  );
  assert.deepEqual(errors, ['game/start received without game hooks']);
  assert.equal(client.sk, null);
});

test('send writes one JSON frame; sending before open throws', async () => {
  const { client, fake } = clientWithFake();
  assert.throws(() => client.send({ kind: 'lobby/list' }), /cannot send/);
  const p = client.connect();
  fake.open();
  await p;
  client.send({ kind: 'lobby/list' });
  assert.deepEqual(fake.sent, ['{"kind":"lobby/list"}']);
});

test('the close code reaches onClose and the status is closed', async () => {
  const { client, fake } = clientWithFake();
  const p = client.connect();
  fake.open();
  await p;
  let code = 0;
  client.onClose = (c) => {
    code = c;
  };
  fake.close(1009);
  assert.equal(code, 1009);
  assert.equal(client.status, 'closed');
});
