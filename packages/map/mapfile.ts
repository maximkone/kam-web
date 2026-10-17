// mapfile.ts — node-specific file reading wrapper (extract from map.ts for browser safety).
// Keeps the frozen Node tools (mapinfo, skirmish cli, tests) working unchanged.
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { parseMapFileBytes } from './map.ts';
import type { KaMap } from './map.ts';

export function parseMapFile(path: string): KaMap {
  let file: Uint8Array;
  try {
    file = new Uint8Array(readFileSync(path));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`map: ${path}: cannot read file (${msg})`);
  }
  return parseMapFileBytes(file, path).map;
}
