// maplist.ts — scan the install's map folders into MapInfo[] (docs/M3B-SPIKE.md 2.5, 3).
//
// Source of truth (r15472, read-only reference):
//  - Scanner (KM_Maps.pas 1920–1951): a folder is listed only when <Name>.dat AND <Name>.map
//    both exist; a folder without either is skipped (not listed).
//  - Map size from the .map header only (KM_MissionScript_Info.pas LoadMapInfo 128–146).
//  - Players / AI flags / tactic / AI starts from the .dat (KM_MissionScript_Info.pas 37–95 +
//    KM_MissionScript_Standard.pas 697); see parseMissionInfo in packages/mission/mission.ts.
//  - SmallDesc from the .txt (KM_Maps.pas 1152–1236): line-oriented, UTF-8 with an ANSI fallback,
//    the value sits on the line after the "SmallDesc" line; '' when there is no .txt.
//  - .mi is a regenerable scan cache (KM_Maps.pas 702–798) — never read here.
//  - valid: LocCount > 0 and both files present (KM_Maps.pas IsValid 801–806); presence is
//    already required to list the folder, so `valid` is maxPlayers > 0.
//
// Node-only by nature (walks the install's folders), like parseMapFile in packages/map/map.ts;
// all byte parsing lives in map.ts/mission.ts and stays browser-safe. Worker H serves the scan
// as /maps JSON — the browser never imports this module.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readMapHeader } from './map.ts';
import { MAX_HANDS, parseMissionInfo } from '../mission/mission.ts';
import type { MissionInfo } from '../mission/mission.ts';

export interface MapInfo {
  kind: string;            // 'Maps' | 'MapsMP' | ...
  name: string;            // folder name
  mapPath: string; datPath: string; txtPath: string | null;
  mapX: number; mapY: number; remake: boolean; rev: number;
  maxPlayers: number; canBeHuman: boolean[]; classicAI: boolean[]; advancedAI: boolean[];
  aiStart: { x: number; y: number }[];
  tactic: boolean; smallDesc: string; // '' when no .txt (or no SmallDesc line)
  valid: boolean;          // map+dat present and maxPlayers > 0
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Case-insensitive name order with an exact-name tiebreak, so the list is deterministic. */
function compareNames(a: string, b: string): number {
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  if (la < lb) return -1;
  if (la > lb) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The `SmallDesc` value of a .txt (KM_Maps.pas 1210–1213): the line after the line that reads
 * "SmallDesc" (case-insensitive); '' when there is no such line or no line after it.
 */
export function parseTxtSmallDesc(text: string): string {
  const lines = text.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/);
  for (let i = 0; i + 1 < lines.length; i++) {
    if (lines[i].toLowerCase() === 'smalldesc') return lines[i + 1];
  }
  return '';
}

/** Read a .txt as UTF-8; on invalid UTF-8 fall back to latin1 (KM_Maps.pas 1178–1188). */
function readTxt(path: string): string {
  const bytes = readFileSync(path);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('latin1').decode(bytes);
  }
}

/** Scan every root's subfolders; folders without both <name>.map and <name>.dat are skipped. */
export function scanMapFolders(roots: { kind: string; dir: string }[]): MapInfo[] {
  const out: MapInfo[] = [];
  for (const { kind, dir } of roots) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue; // a missing root contributes nothing
    }
    names.sort(compareNames);
    for (const name of names) {
      const folder = join(dir, name);
      if (!isDirectory(folder)) continue;
      const mapPath = join(folder, `${name}.map`);
      const datPath = join(folder, `${name}.dat`);
      if (!isFile(mapPath) || !isFile(datPath)) continue; // KM_Maps.pas 1931–1933

      // Size/format from the .map header; a header that cannot be read keeps the zeros.
      let mapX = 0;
      let mapY = 0;
      let remake = false;
      let rev = 0;
      try {
        const header = readMapHeader(readFileSync(mapPath), mapPath);
        mapX = header.mapX;
        mapY = header.mapY;
        remake = header.remake;
        rev = header.rev;
      } catch {
        // unreadable header: the folder is still listed (size 0); `valid` follows maxPlayers
      }

      // Players/AI from the .dat; a script that cannot be parsed keeps the defaults.
      let info: MissionInfo | null = null;
      try {
        info = parseMissionInfo(readFileSync(datPath), mapX, mapY);
      } catch {
        info = null;
      }

      const txtPath = isFile(join(folder, `${name}.txt`)) ? join(folder, `${name}.txt`) : null;
      const maxPlayers = info !== null ? info.maxPlayers : 0;
      out.push({
        kind,
        name,
        mapPath,
        datPath,
        txtPath,
        mapX,
        mapY,
        remake,
        rev,
        maxPlayers,
        canBeHuman: info !== null ? info.canBeHuman : new Array<boolean>(MAX_HANDS).fill(false),
        classicAI: info !== null ? info.classicAI : new Array<boolean>(MAX_HANDS).fill(false),
        advancedAI: info !== null ? info.advancedAI : new Array<boolean>(MAX_HANDS).fill(false),
        aiStart: info !== null ? info.aiStart : Array.from({ length: MAX_HANDS }, () => ({ x: 1, y: 1 })),
        tactic: info !== null ? info.tactic : false,
        smallDesc: txtPath !== null ? parseTxtSmallDesc(readTxt(txtPath)) : '',
        valid: maxPlayers > 0,
      });
    }
  }
  return out;
}
