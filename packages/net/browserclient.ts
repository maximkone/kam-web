// browserclient.ts — the browser entry of the multiplayer client (M6): the global WebSocket and the same
// NetClient and Lockstep as the Node tests. Not wired into apps/web yet (the lobby UI is not done).
// Browser-safe: no node: imports. Uses crypto.subtle for the map and defines checks.

import { NetClient } from './client.ts';
import type { GameHooks } from './client.ts';

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
