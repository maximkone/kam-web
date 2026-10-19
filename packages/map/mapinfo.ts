// mapinfo.ts — the shape of one scanned map folder (docs/M3B-SPIKE.md 2.5). Types only, no imports: the
// node scanner (maplist.ts) and the browser's own scan (apps/web/game/localsource.ts) both produce this,
// and the browser build must not pull node builtins in through a type import.
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
