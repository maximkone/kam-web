// skirmish-cli-utils.ts — the map and defines of the net check, read from the frozen install (read-only).
// The four defines files are in the order the lobby's definesSha hashes them (tiles.json, mapelem.dat,
// unit.dat, houses.dat). KAM_INSTALL overrides the install root, like the other tools.

import { readFileSync } from 'node:fs';
import type { SkirmishDefines } from '../../packages/sim/skirmish.ts';

const INSTALL = process.env.KAM_INSTALL ?? 'C:/Users/me/Desktop/KaM Remake/KaM Remake Beta r15472';
const DEFINES_DIR = `${INSTALL}/data/defines`;
const DEFINE_FILES = ['tiles.json', 'mapelem.dat', 'unit.dat', 'houses.dat'];

function readDefine(name: string): Uint8Array {
  const path = `${DEFINES_DIR}/${name}`;
  try {
    return new Uint8Array(readFileSync(path));
  } catch (err) {
    throw new Error(`defines: ${path}: cannot read file (${err instanceof Error ? err.message : String(err)})`);
  }
}

/** The four defines files' bytes, in the order definesSha hashes them. */
export function definesBytes(): Uint8Array[] {
  return DEFINE_FILES.map(readDefine);
}

export function defines(): SkirmishDefines {
  return {
    tilesJson: Buffer.from(readDefine('tiles.json')).toString('utf8'),
    mapElem: readDefine('mapelem.dat'),
    unitDat: readDefine('unit.dat'),
    housesDat: readDefine('houses.dat'),
  };
}

export function mapFiles(map: string): { mapPath: string; mapBytes: Uint8Array; missionDat: Uint8Array } {
  const at = map.indexOf('/');
  if (at <= 0) throw new Error(`map wants <kind>/<name>, got "${map}"`);
  const base = `${INSTALL}/${map}/${map.slice(at + 1)}`;
  return {
    mapPath: `${base}.map`,
    mapBytes: new Uint8Array(readFileSync(`${base}.map`)),
    missionDat: new Uint8Array(readFileSync(`${base}.dat`)),
  };
}
