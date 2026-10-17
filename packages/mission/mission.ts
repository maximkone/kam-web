// mission.ts — parser for KaM mission scripts (`*.dat`), the v0 subset (docs/M3-SPIKE.md 2.1) and
// the map-list info commands (docs/M3B-SPIKE.md 2.5, KM_MissionScript_Info.pas 37-95).
//
// Source of truth: mission/KM_MissionScript.pas (r15472, read-only reference).
//  - Decode (ReadMissionFile 196–250): count bytes in [tab, CR, LF, '0'..'9', space, '!']; when
//    their share is < 0.20 XOR every byte with 239 (212–222). Tab/CR/LF become spaces (228–230);
//    runs of two spaces and of two '!' collapse to one (232–241).
//  - Tokenizer (TokenizeScript 253–319): a command starts at '!' and runs to the first space; up
//    to 6 parameters follow until the next '!' (each parsed as an int, default −1; the first
//    parameter may be text). Commands that are not in the v0 list are walked over and skipped.
//
// Commands handled (KM_MissionScript_Standard.pas ProcessCommand):
//  - SET_MAP (205): the game ignores the text (maps load next to the script); we keep the quoted
//    name for Mission.mapName.
//  - SET_MAX_PLAYER (216) → maxPlayers (gHands.AddPlayers).
//  - SET_HUMAN_PLAYER (247) → humanPlayer (fDefaultLocation).
//  - SET_CURR_PLAYER (236) → the current hand (all hands enabled by default, KM_MissionScript_Standard.pas
//    88–89). A script id out of range skips the hand (HAND_NONE).
//  - ENABLE_PLAYER (821) → no-op (all players have it anyway).
//  - SET_HOUSE (360) → HOUSE_ID_TO_TYPE[id] at (x+1, y+1). MissionHouse.typeId is the
//    HOUSE_ID_TO_TYPE index (the script id, 0..29 — the same id HouseSpec.typeId uses).
//  - SET_STREET (456) → AddRoadToList((x+1, y+1)).
//  - SET_UNIT (408) → UNIT_OLD_ID_TO_TYPE[id] at (x+1, y+1); MissionUnit.typeId is the unit.dat
//    record index (UNIT_ID_TO_TYPE). Old ids 0..23 are humanoids (record = old id); 24..31 are
//    animals (record = old id + 6, utWolf..utDuck) — **parsed with owner −1 (HAND_ANIMAL) but not
//    spawned by the v0 world** (docs/M3-SPIKE.md 2.1; the game adds them to PlayerAnimals).
//  - ADD_WARE (479) → qty = clamp(amount, −1, 65535), −1 → 65535, for the current hand. The target
//    house (the hand's first store) is resolved by the world build, not here.
//  - SET_FIELD (459) and everything else: skipped.
//
// MissionInfo (parseMissionInfo, additive — docs/M3B-SPIKE.md 3): the map list's commands.
//  - SET_MAX_PLAYER → maxPlayers; SET_TACTIC → tactic (fighting mode, KM_MissionScript_Info.pas 72).
//  - SET_CURR_PLAYER → the current hand; SET_HUMAN_PLAYER → humanPlayer + canBeHuman[hand].
//  - SET_USER_PLAYER / SET_AI_PLAYER / SET_ADVANCED_AI_PLAYER → the capability flags; a −1
//    parameter (missing) means the current hand (KM_MissionScript_Info.pas 82-95).
//  - SET_AI_START_POSITION x y → aiStart[hand] = (x+1, y+1) with the PointInMap check
//    (KM_MissionScript_Standard.pas 697-698; the info parser itself does not read this command);
//    the default for every hand is (1,1) (KM_AISetup.pas 80).
//
// Throws on malformed input (empty script, no '!' at all is fine — an empty Mission is returned).
//
// Browser-safe: no node: imports.

export interface MissionHouse {
  typeId: number; // HOUSE_ID_TO_TYPE index (script id 0..29)
  x: number;
  y: number;
  owner: number;
}

export interface MissionStreet {
  x: number;
  y: number;
  owner: number;
}

export interface MissionUnit {
  typeId: number; // unit.dat record (UNIT_ID_TO_TYPE index)
  x: number;
  y: number;
  owner: number; // −1 = animal (parsed, not spawned in v0)
}

export interface MissionWare {
  ware: number; // 0..27 (the script convention, packages/assets/wares.ts)
  amount: number;
  owner: number;
}

export interface Mission {
  mapName: string;
  maxPlayers: number;
  humanPlayer: number;
  houses: MissionHouse[];
  streets: MissionStreet[];
  units: MissionUnit[];
  wares: MissionWare[];
}

/** The map-list metadata (docs/M3B-SPIKE.md 3), from the same decode + tokenizer. */
export interface MissionInfo {
  maxPlayers: number;
  humanPlayer: number;
  canBeHuman: boolean[];  // indexed by hand 0..MAX_HANDS-1
  classicAI: boolean[];
  advancedAI: boolean[];
  aiStart: { x: number; y: number }[]; // indexed by hand; (1,1) unless SET_AI_START_POSITION says otherwise
  tactic: boolean;        // !SET_TACTIC present (fighting mode)
}

// HOUSE_ID_TO_TYPE (KM_ResHouses.pas 193–199): script id → TKMHouseType id. Kept here (and used by
// the economy world for the script-id semantics of the tutorial's houses).
export const HOUSE_ID_TO_TYPE: number[] = [
  18, 13, 27, 7, 12, 10, 9, 4, 8, 30, 2, 22, 21, 19, 17, 15, 23, 26, 25, 28, 3, 5, 16, 20, 6, 24, 0,
  11, 29, 14,
];

// UNIT_OLD_ID_TO_TYPE (KM_ResUnits.pas 128–135) resolved to unit.dat records via UNIT_ID_TO_TYPE
// (146–157): old ids 0..23 are utSerf..utBarbarian (records 0..23), old ids 24..31 are
// utWolf..utDuck (records 30..37).
export const UNIT_OLD_ID_TO_RECORD: number[] = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 30, 31, 32, 33,
  34, 35, 36, 37,
];

/** HAND_ANIMAL / HAND_NONE (KM_HandTypes): −1 — animals keep this owner and are not spawned in v0. */
export const HAND_ANIMAL = -1;

export const MAX_HANDS = 27; // KM_Defaults.pas 309
const MAX_CMD = 6; // TokenizeScript(fileText, 6, []) (KM_MissionScript_Standard.pas 140)
const HAND_NONE = -1;

/** The XOR-239 heuristic of ReadMissionFile (212–222): the share of common bytes is < 0.20. */
export function missionScriptIsXor239(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false;
  let common = 0;
  for (const b of bytes) {
    if (b === 9 || b === 10 || b === 13 || b === 0x20 || b === 0x21 || (b >= 0x30 && b <= 0x39)) common += 1;
  }
  return common / bytes.length < 0.2;
}

/** The decoded script text (XOR-239 detection + space collapsing), exposed for tests/tools. */
export function decodeMissionScript(bytes: Uint8Array): string {
  if (bytes.length === 0) throw new Error('mission: script is empty');

  const buf = Uint8Array.from(bytes);
  if (missionScriptIsXor239(buf)) {
    for (let i = 0; i < buf.length; i++) buf[i] ^= 239; // XOR-239 (212–222)
  }
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 9 || buf[i] === 10 || buf[i] === 13) buf[i] = 0x20; // tab/CR/LF → space (228–230)
  }

  // Collapse double spaces and !! byte-wise, keeping the first byte of each run (232–241).
  const out = new Uint8Array(buf.length);
  let n = 0;
  for (let i = 0; i < buf.length; i++) {
    out[n] = buf[i];
    const dup = n > 0 && ((out[n - 1] === 0x20 && out[n] === 0x20) || (out[n - 1] === 0x21 && out[n] === 0x21));
    if (!dup) n += 1;
  }
  return new TextDecoder('latin1').decode(out.subarray(0, n));
}

function tryStrToInt(s: string): number | null {
  // Pascal TryStrToInt: optional sign, decimal digits only.
  if (!/^[+-]?\d+$/.test(s)) return null;
  const v = Number(s);
  return Number.isSafeInteger(v) ? v : null;
}

function pointInMap(x: number, y: number, mapX: number, mapY: number): boolean {
  return x >= 1 && x <= mapX && y >= 1 && y <= mapY;
}

interface ParsedCommand {
  cmd: string;
  params: number[];
  textParam: string;
  rawParams: string;
}

/** Tokenize one decoded script into commands (the Pascal tokenizer, 0-based). */
export function tokenizeMissionScript(text: string): ParsedCommand[] {
  const out: ParsedCommand[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] !== '!') {
      i += 1;
      continue;
    }

    // Command text until the first space (263–272).
    let cmd = '';
    while (i < text.length && text[i] !== ' ') {
      cmd += text[i];
      i += 1;
    }
    const afterCmd = i; // at the space (or end)

    // Parameters: up to MAX_CMD, default −1, first may be text (281–310).
    const params: number[] = [];
    for (let k = 0; k < MAX_CMD; k++) params.push(-1);
    let textParam = '';
    i += 1; // Inc(I): step over the space (290)
    for (let k = 0; k < MAX_CMD; k++) {
      if (i < text.length && text[i] !== '!') {
        let str = '';
        while (i < text.length && text[i] !== '!' && text[i] !== ' ') {
          str += text[i];
          i += 1;
        }
        const v = tryStrToInt(str);
        if (v !== null) params[k] = v;
        else if (k === 0) textParam = str; // Accept text for first parameter (305–306)
        if (i < text.length && text[i] === ' ') i += 1;
      }
    }

    // Raw parameter text (up to the next '!') — used only to recover a quoted SET_MAP name, which
    // the game's tokenizer would cut at the first space.
    let j = afterCmd;
    let raw = '';
    while (j < text.length && text[j] !== '!') {
      raw += text[j];
      j += 1;
    }

    out.push({ cmd, params, textParam, rawParams: raw });
  }
  return out;
}

/**
 * Parse one mission script (`*.dat`) into the Mission lists. Throws on malformed input.
 * `mapX`/`mapY` are the map size used for the PointInMap checks (the game's PointInMap is 1..MapX);
 * pass 0 to skip them (tests without a map).
 */
export function parseMissionScript(bytes: Uint8Array, mapX = 0, mapY = 0): Mission {
  const text = decodeMissionScript(bytes);
  const commands = tokenizeMissionScript(text);
  const hasMap = mapX > 0 && mapY > 0;
  const inMap = (x: number, y: number): boolean => !hasMap || pointInMap(x, y, mapX, mapY);

  const mission: Mission = {
    mapName: '',
    maxPlayers: 0,
    humanPlayer: 0,
    houses: [],
    streets: [],
    units: [],
    wares: [],
  };

  let hand: number = HAND_NONE;

  for (const { cmd, params, textParam, rawParams } of commands) {
    const p = params;
    switch (cmd) {
      case '!SET_MAP': {
        const quoted = /^\s*"([^"]*)"/.exec(rawParams);
        mission.mapName = quoted !== null ? quoted[1] : textParam;
        break;
      }
      case '!SET_MAX_PLAYER':
        mission.maxPlayers = Math.max(0, p[0]);
        break;
      case '!SET_HUMAN_PLAYER':
        if (p[0] >= 0 && p[0] < MAX_HANDS) mission.humanPlayer = p[0];
        break;
      case '!SET_CURR_PLAYER':
        hand = p[0] >= 0 && p[0] < MAX_HANDS ? p[0] : HAND_NONE;
        break;
      case '!ENABLE_PLAYER':
        break; // no-op (821)
      case '!SET_HOUSE': {
        if (hand === HAND_NONE) break;
        if (!inMap(p[1] + 1, p[2] + 1)) break;
        if (p[0] < 0 || p[0] >= HOUSE_ID_TO_TYPE.length) break;
        if (HOUSE_ID_TO_TYPE[p[0]] === 0) break; // htNone: nothing to place
        mission.houses.push({ typeId: p[0], x: p[1] + 1, y: p[2] + 1, owner: hand });
        break;
      }
      case '!SET_STREET':
        if (hand !== HAND_NONE && inMap(p[0] + 1, p[1] + 1)) {
          mission.streets.push({ x: p[0] + 1, y: p[1] + 1, owner: hand });
        }
        break;
      case '!SET_UNIT': {
        if (!inMap(p[1] + 1, p[2] + 1)) break;
        if (p[0] < 0 || p[0] >= UNIT_OLD_ID_TO_RECORD.length) break;
        const typeId = UNIT_OLD_ID_TO_RECORD[p[0]];
        if (p[0] >= 24) {
          // Animals are added regardless of the current player (411–416) — owner −1, not spawned in v0.
          mission.units.push({ typeId, x: p[1] + 1, y: p[2] + 1, owner: HAND_ANIMAL });
          break;
        }
        if (hand === HAND_NONE) break; // humanoids need the current hand (419–420)
        mission.units.push({ typeId, x: p[1] + 1, y: p[2] + 1, owner: hand });
        break;
      }
      case '!ADD_WARE': {
        if (hand === HAND_NONE) break;
        let qty = p[1];
        if (qty < -1) qty = -1;
        if (qty > 65535) qty = 65535;
        if (qty === -1) qty = 65535; // −1 means maximum resources (481–482)
        mission.wares.push({ ware: p[0], amount: qty, owner: hand });
        break;
      }
      default:
        break; // every other command is walked over by the tokenizer and skipped
    }
  }

  return mission;
}

/**
 * Parse one mission script (`*.dat`) into the map-list MissionInfo (docs/M3B-SPIKE.md 2.5/3).
 * Reuses decodeMissionScript + tokenizeMissionScript; throws on malformed input (empty script).
 * `mapX`/`mapY` (optional) are the map size for the SET_AI_START_POSITION PointInMap check —
 * pass 0/omit when unknown, exactly like parseMissionScript.
 */
export function parseMissionInfo(bytes: Uint8Array, mapX = 0, mapY = 0): MissionInfo {
  const text = decodeMissionScript(bytes);
  const commands = tokenizeMissionScript(text);
  const hasMap = mapX > 0 && mapY > 0;
  const inMap = (x: number, y: number): boolean => !hasMap || pointInMap(x, y, mapX, mapY);

  const info: MissionInfo = {
    maxPlayers: 0,
    humanPlayer: 0,
    canBeHuman: new Array<boolean>(MAX_HANDS).fill(false),
    classicAI: new Array<boolean>(MAX_HANDS).fill(false),
    advancedAI: new Array<boolean>(MAX_HANDS).fill(false),
    aiStart: Array.from({ length: MAX_HANDS }, () => ({ x: 1, y: 1 })), // KM_AISetup.pas 80
    tactic: false,
  };

  let hand: number = HAND_NONE;
  const inRange = (h: number): boolean => h >= 0 && h < MAX_HANDS;

  for (const { cmd, params: p } of commands) {
    switch (cmd) {
      case '!SET_MAX_PLAYER':
        info.maxPlayers = Math.max(0, p[0]);
        break;
      case '!SET_TACTIC':
        info.tactic = true;
        break;
      case '!SET_CURR_PLAYER':
        hand = inRange(p[0]) ? p[0] : HAND_NONE;
        break;
      case '!SET_HUMAN_PLAYER':
        // DefaultHuman + CanBeHuman[P[0]] (KM_MissionScript_Info.pas 76-80).
        if (inRange(p[0])) {
          info.humanPlayer = p[0];
          info.canBeHuman[p[0]] = true;
        }
        break;
      case '!SET_USER_PLAYER':
        if (p[0] === -1) {
          if (inRange(hand)) info.canBeHuman[hand] = true;
        } else if (inRange(p[0])) {
          info.canBeHuman[p[0]] = true;
        }
        break;
      case '!SET_AI_PLAYER':
        if (p[0] === -1) {
          if (inRange(hand)) info.classicAI[hand] = true;
        } else if (inRange(p[0])) {
          info.classicAI[p[0]] = true;
        }
        break;
      case '!SET_ADVANCED_AI_PLAYER':
        if (p[0] === -1) {
          if (inRange(hand)) info.advancedAI[hand] = true;
        } else if (inRange(p[0])) {
          info.advancedAI[p[0]] = true;
        }
        break;
      case '!SET_AI_START_POSITION':
        // KM_MissionScript_Standard.pas 697: (x+1, y+1) when it is inside the map; the info
        // parser does not read this command, the standard mission parser does.
        if (inRange(hand) && inMap(p[0] + 1, p[1] + 1)) info.aiStart[hand] = { x: p[0] + 1, y: p[1] + 1 };
        break;
      default:
        break; // everything else is walked over by the tokenizer and skipped
    }
  }

  return info;
}
