// lobby.test.ts — the relay address the multiplayer panel fills in by itself (docs/DEPLOY.md).
// The rule: a page served from this machine talks to this machine's relay; a page served from another
// machine on the network (--lan) talks to that machine's relay on the same port, so a player on the LAN
// types no address; a static deployment (https) must use the deployed relay over wss.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultRelayUrl, RELAY_PUBLIC } from './lobby.ts';

test('localhost and 127.0.0.1 use the local relay', () => {
  assert.equal(defaultRelayUrl({ protocol: 'http:', hostname: 'localhost' }), 'ws://127.0.0.1:8130');
  assert.equal(defaultRelayUrl({ protocol: 'http:', hostname: '127.0.0.1' }), 'ws://127.0.0.1:8130');
});

test('a page opened over the network uses that machine name and port 8130', () => {
  assert.equal(defaultRelayUrl({ protocol: 'http:', hostname: '192.168.43.208' }), 'ws://192.168.43.208:8130');
  assert.equal(defaultRelayUrl({ protocol: 'http:', hostname: 'game-pc.local' }), 'ws://game-pc.local:8130');
});

test('a page with no hostname (file://) still points at the local relay', () => {
  assert.equal(defaultRelayUrl({ protocol: 'file:', hostname: '' }), 'ws://127.0.0.1:8130');
});

test('an https deployment never uses ws:// (mixed content is blocked)', () => {
  const url = defaultRelayUrl({ protocol: 'https:', hostname: 'games.example.com' });
  assert.ok(url.startsWith('wss://'), `expected wss://, got ${url}`);
  if (RELAY_PUBLIC !== '') assert.equal(url, RELAY_PUBLIC);
});
