// statehash.ts — the observable state of a skirmish as one canonical string, and a CRC32 of it (M6 desync check).
// Pure and browser-safe: no node: imports. The fields are the ones tools/skirmish/cli.ts hashes (its stateSha);
// the caller hashes the string with sha256 when it needs the strong hash (the nettest does).
// Every client computes the same string after the same tick, so the relay compares only the CRC32.

import type { Skirmish } from '../sim/skirmish.ts';

export function canonicalState(sk: Skirmish): string {
  const w = sk.world;
  const houses = w.houses.map((h) => [
    h.uid,
    h.typeId,
    h.owner,
    h.x,
    h.y,
    h.buildState,
    h.buildingProgress,
    h.buildSupplyWood,
    h.buildSupplyStone,
    h.damage,
    h.destroyed,
    h.wareIn.slice(),
    h.wareOut.slice(),
  ]);
  const units = w.units.map((u) => [u.uid, u.owner, u.type, u.posF.x, u.posF.y, u.action, u.taskKind, u.hitPoints, u.groupUid, u.fightState, u.dead, u.inside, u.homeUid]);
  const groups = w.groups.map((g) => ({
    uid: g.uid,
    owner: g.owner,
    members: g.memberUids.slice(),
    order: g.order,
    orderX: g.orderX,
    orderY: g.orderY,
    targetUid: g.targetUid,
    targetHouseUid: g.targetHouseUid,
    unitsPerRow: g.unitsPerRow,
  }));
  const projectiles = w.projectiles.map((p) => [p.uid, p.fromX, p.fromY, p.toX, p.toY, p.targetUid]);
  const plans: unknown[] = [];
  for (let h = 0; h < w.handCount; h++) {
    const cs = w.constructionState(h);
    plans.push(
      cs.plans.map((p) => [p.uid, p.typeId, p.x, p.y, p.status]),
      cs.fields.map((f) => [f.x, f.y, f.fieldType, f.status]),
    );
  }
  const ai = sk.ais.map((a, h) => (a === undefined ? null : [h, a.predictor.workerCount, a.predictor.requiredHouses]));
  return JSON.stringify({
    tick: w.tickCount,
    rngState: w.rngState,
    houses,
    units,
    groups,
    projectiles,
    plans,
    status: sk.status.slice(0, w.handCount),
    ai,
    houseDamage: w.houseDamageTotal,
    logLength: sk.log.length,
  });
}

const CRC_TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC32 (IEEE) of a string's UTF-8 bytes, as 8 lowercase hex characters. */
export function crc32Hex(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return ((c ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0');
}

/** The per-checkpoint value a client reports for its state (game/crc). */
export function stateCrc(sk: Skirmish): string {
  return crc32Hex(canonicalState(sk));
}
