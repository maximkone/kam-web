// fowrefresh.ts - the periodic fog-of-war refresh of the Remake's DynamicFOW, for every live unit and every finished house.
//
// Why: the economy world only reveals fog when a unit is created or moves, when a house activates, for houses under construction and
// for warriors (ticker mod FOW_PACE). Idle citizens and FINISHED houses were never refreshed, while FogOfWar.updateState decays every
// tile each FOW_PACE: after ~30 game seconds the player's own village went completely black (lead probe 2026-10-17: revelation
// 255 -> 235 at tick 100 -> 0 at tick 300 over the store and all 10 units, and it stayed 0).
//
// Pascal:
//   units  KM_Units.pas 2610-2612   `if gGameParams.DynamicFOW and (fTicker mod FOW_PACE = 0) then
//                                     gHands.RevealForTeam(Owner, fPositionRound, gRes.Units[fType].Sight, FOG_OF_WAR_INC)`
//   houses KM_Houses.pas 2205-2212  `if DynamicFOW and (FlagAnimStep mod FOW_PACE = 0)`: every BuildArea cell reveals with the house Sight
//
// v0 simplifications (documented): the per-object ticker is replaced by `(tick + uid) mod FOW_PACE` (deterministic, staggered); only the
// owner's own fog is refreshed (RevealForTeam also reveals for allies; skirmish teams are not linked yet); the call lives here and is made
// by skirmish.step() so the frozen econ/build/combat/ai shas, which tick the world directly, stay untouched. It belongs in the economy
// tick once that file is not under parallel edit.
import { FOW_PACE } from './combat.ts';
import type { EconomyWorld } from './economy.ts';

interface SightSpecs { unitSpecs?: { sight?: number }[] }

export function refreshFog(w: EconomyWorld): void {
  const tick = w.tickCount;
  const unitSpecs = (w as unknown as SightSpecs).unitSpecs ?? [];
  for (const h of w.houses) {
    if (h.destroyed || h.buildState !== 'done') continue;
    if ((tick + h.uid) % FOW_PACE !== 0) continue;
    const fog = w.fow[h.owner];
    if (fog === undefined) continue;
    const sight = w.houseSpecs[h.typeId]?.sight ?? 0;
    for (const c of w.houseCells(h)) fog.reveal(c.x, c.y, sight, false);
  }
  for (const u of w.units) {
    if (u.dead) continue;
    if ((tick + u.uid) % FOW_PACE !== 0) continue;
    const fog = w.fow[u.owner];
    if (fog === undefined) continue;
    fog.reveal(Math.round(u.posF.x), Math.round(u.posF.y), unitSpecs[u.type]?.sight ?? 0, false);
  }
}
