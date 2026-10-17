// aisupervisor.ts — M5c: the Supervisor, the game-wide coordinator of the Advanced AI (docs/M5-SPIKE.md 7.5).
//
// Ported from src/ai/newAI/KM_Supervisor.pas (r15472, read-only reference):
//  - UpdateAlliances (242–280), UpdateFFA (282–296), NewAIInTeam (304–317), IsTeamAlive/HasAssets (319–338).
//  - UpdateState (214–240): the defence window `tick mod 27000 = 500 + team` and the attack window
//    `… = 10 + team` (both share the modulo variable, so they never run in the same tick), the attack
//    window after the peace time + 3 minutes.
//  - AttackDecision (853–1046) with CompareAlliances (897–1046) and the attack request it writes.
//  - UpdateDefPos (1048–1151): the defence positions per team, DefPosReq = round(troops / 8) + 5.
//  - DivideResources (1153–1238): the iron and gold mines in each team's influence, shared out.
//
// Simplified (each is flagged; docs/M5-SPIKE.md 7.5 lists them):
//  - Alliances: the v0 world has no alliance table (economy.allianceOf: the same hand is an ally, every
//    other hand an enemy), so each team is one hand. The team logic is kept for when it has more.
//  - CompareAllianceStrength (Eye.ArmyEvaluation, not ported): a team's strength is its warrior count, the
//    comparison is (A − E) / (A + E) (0 when both are empty).
//  - The NavMesh polygon route is replaced by the straight distance between the teams' city points, and
//    the walking distance is rounded to a whole tile (Pascal: a Word). DISTANCE_COEF_1v1/FFA are computed
//    in the Pascal but not used in its formula; they are not used here either.
//  - FoodProblems is always false (no food model); the combat status matrix (UpdateCombatStatus) and the
//    army-vector clusters (UpdateAttacks, DivideForces, FindPositions) are not ported, so no combat groups
//    are released by the combat status, and no cluster orders are given (the AttackNew targets are chosen
//    by the army from the request's enemies).
//  - Defence positions (the navmesh defence lines, FindTeamDefences) are replaced by a v0 line generator:
//    tiles on rings 4..14 around the hand's city centre that the centre can walk to, sorted by distance to
//    the nearest enemy house, kept 3 tiles apart; the nearest third is the front line (line 0).
//  - The mine division keeps the Pascal's share rule for one hand per team and sorts the mine evaluations
//    with a stable sort (the Pascal's SortCustom is not stable for equal values).
//
// Browser-safe: no node: imports.
import type { EconomyWorld } from './economy.ts';
import type { AiPlayer, Eye, Influences, Pt } from './ai.ts';
import { distanceSqr, HT_BARRACKS, HT_GOLD_MINE, HT_IRON_MINE, HT_SCHOOL, HT_STORE, HT_TOWN_HALL, UT_RECRUIT } from './ai.ts';
import { ArmyManagement } from './aiarmy.ts';
import type { AttackRequest, DefencePositionRequest } from './aiarmy.ts';
import { isWarriorSpec } from './combat.ts';
import { MAX_HANDS } from '../mission/mission.ts';
import { delphiRound } from './walk.ts';

/** DEF_OR_ATT_DIVISION (KM_Supervisor.pas 216–218), DEFENCES 500, ATTACKS 10. */
const DEF_OR_ATT_DIVISION = 10 * MAX_HANDS * 10;
const DEFENCES = 500;
const ATTACKS = 10;
/** MIN_DEF_RATIO and MIN_ADVANTAGE (the constants of AttackDecision) and RESERVE_DEF_POS (UpdateDefPos). */
const MIN_DEF_RATIO = 1.2;
const MIN_ADVANTAGE = 0.15;
const RESERVE_DEF_POS = 5;
/** The houses that count as a team's assets (HasAssets, KM_Supervisor.pas 330–338; FindTargetAssets 855–896). */
const ASSET_HOUSES = [HT_BARRACKS, HT_STORE, HT_SCHOOL, HT_TOWN_HALL];
/** MAX_INFLUENCE in the mine evaluation (KM_Supervisor.pas 1156). */
const MAX_INFLUENCE = 256;

interface CompareResult {
  bestCmpTeam: number;
  bestCmp: number;
  worstCmp: number;
  bestTarget: number;
}

export class AiSupervisor {
  private readonly world: EconomyWorld;
  private readonly eye: Eye;
  private readonly influences: Influences;
  private readonly ais: AiPlayer[];
  /** fAlli2PL: the teams (alliance groups) of the hands, in hand order. */
  teams: number[][] = [];
  /** fFFA: more than two teams have assets. */
  ffa = false;

  constructor(world: EconomyWorld, eye: Eye, influences: Influences, ais: AiPlayer[]) {
    this.world = world;
    this.eye = eye;
    this.influences = influences;
    this.ais = ais;
  }

  private aiOf(hand: number): AiPlayer | undefined {
    return this.ais.find((a) => a.hand === hand);
  }

  private armyOf(hand: number): ArmyManagement | null {
    const army = this.aiOf(hand)?.army;
    return army instanceof ArmyManagement ? army : null;
  }

  private peacetimeMinutes(): number {
    return this.ais[0]?.predictor.peacetimeMinutes ?? 0;
  }

  private isPeaceTime(tick: number): boolean {
    return this.ais[0]?.predictor.isPeaceTime(tick) ?? false;
  }

  /** AfterMissionInit (207–211): the alliances, then the mine division. */
  afterMissionInit(): void {
    this.updateAlliances();
    this.divideResources();
  }

  /** UpdateState (214–240). */
  updateState(tick: number): void {
    const modulo = tick % DEF_OR_ATT_DIVISION;
    if (modulo >= DEFENCES && modulo - DEFENCES < this.teams.length) this.updateDefPos(modulo - DEFENCES);
    if (!this.isPeaceTime(tick) && modulo >= ATTACKS && modulo - ATTACKS < this.teams.length && tick > (this.peacetimeMinutes() + 3) * 10 * 60) {
      this.updateFFA();
      this.attackDecision(modulo - ATTACKS);
    }
  }

  /** UpdateAlliances (242–280) over the v0 alliance rule (economy.allianceOf). */
  updateAlliances(): void {
    const n = this.world.handCount;
    const assigned = new Array<boolean>(n).fill(false);
    this.teams = [];
    for (let h = 0; h < n; h++) {
      if (assigned[h]) continue;
      const team = [h];
      assigned[h] = true;
      for (let h2 = h + 1; h2 < n; h2++) {
        if (assigned[h2]) continue;
        if (team.every((m) => this.world.allianceOf(m, h2) === 'ally' && this.world.allianceOf(h2, m) === 'ally')) {
          team.push(h2);
          assigned[h2] = true;
        }
      }
      this.teams.push(team);
    }
    this.updateFFA();
  }

  /** HasAssets (330–338): a complete asset house, or a warrior. */
  hasAssets(hand: number, includeArmy = true): boolean {
    let houses = 0;
    for (const t of ASSET_HOUSES) houses += this.world.handHouseCount(hand, t);
    return houses > 0 || (includeArmy && this.world.handWarriorCount(hand) > 0);
  }

  /** IsTeamAlive (319–328). */
  private isTeamAlive(team: number[]): boolean {
    return team.some((h) => this.hasAssets(h, true));
  }

  /** UpdateFFA (282–296). */
  updateFFA(): void {
    let cnt = 0;
    for (const team of this.teams) if (team.some((h) => this.hasAssets(h, true))) cnt += 1;
    this.ffa = cnt > 2;
  }

  /** NewAIInTeam (304–317). */
  private newAIInTeam(team: number[], attack: boolean, defence: boolean): boolean {
    return team.some((h) => {
      const ai = this.aiOf(h);
      return ai !== undefined && ai.setup.newAI && (!attack || ai.setup.autoAttack) && (!defence || ai.setup.autoDefend);
    });
  }

  /** The point a hand's army or city stands at (FindTargetAssets 855–896): the first asset house's walk
   *  point, else the first warrior. */
  private assetPoint(hand: number): Pt | null {
    const w = this.world;
    for (const h of w.houses) {
      if (h.owner === hand && !h.destroyed && h.buildState === 'done' && ASSET_HOUSES.includes(h.typeId)) {
        return { x: h.entrance.x, y: h.entrance.y + 1 };
      }
    }
    for (const u of w.units) if (u.owner === hand && !u.dead && isWarriorSpec(w.specOfType(u.type))) return w.posRound(u);
    return null;
  }

  /** The strength comparison of two teams: (A − E) / (A + E) over their warriors (0 when both are empty). */
  private allianceStrength(a: number[], e: number[]): number {
    const sum = (team: number[]): number => team.reduce((s, h) => s + this.world.handWarriorCount(h), 0);
    const A = sum(a);
    const E = sum(e);
    return A + E > 0 ? (A - E) / (A + E) : 0;
  }

  /** CompareAlliances (897–1046): the best and worst comparison over the other teams; null when no enemy
   *  team can be reached. */
  private compareAlliances(aTeam: number): CompareResult | null {
    const team = this.teams[aTeam];
    const allyPts = team.map((h) => this.assetPoint(h));
    const dist: number[] = this.teams.map(() => Number.POSITIVE_INFINITY);
    const targetPl: number[] = this.teams.map(() => -1);
    for (let t = 0; t < this.teams.length; t++) {
      if (t === aTeam || !this.isTeamAlive(this.teams[t])) continue;
      for (const L of this.teams[t]) {
        const enemyPt = this.assetPoint(L);
        if (enemyPt === null) continue;
        for (const ap of allyPts) {
          if (ap === null) continue;
          const d = delphiRound(Math.sqrt(distanceSqr(ap, enemyPt)));
          if (d < dist[t]) {
            dist[t] = d;
            targetPl[t] = L;
          }
        }
      }
    }
    const reachable = this.teams.map((_, t) => t).filter((t) => Number.isFinite(dist[t]));
    if (reachable.length === 0) return null;
    const minDist = Math.min(...reachable.map((t) => dist[t]));
    const maxDist = Math.max(...reachable.map((t) => dist[t]));
    let bestCmp = -1;
    let worstCmp = 1;
    let bestCmpTeam = 0;
    let bestTarget = -1;
    for (const t of reachable) {
      const comparison = this.allianceStrength(team, this.teams[t]) - (dist[t] - minDist) / Math.max(1, maxDist - minDist);
      if (comparison >= bestCmp) {
        bestCmp = comparison;
        bestCmpTeam = t;
        bestTarget = targetPl[t];
      }
      if (comparison <= worstCmp) worstCmp = comparison;
    }
    return { bestCmpTeam, bestCmp, worstCmp, bestTarget };
  }

  /** AttackDecision (853–1046): an attack request for the team's auto-attack hands. */
  attackDecision(teamIdx: number): void {
    const team = this.teams[teamIdx];
    if (!this.newAIInTeam(team, true, false) || !this.isTeamAlive(team) || this.teams.length < 2) return;
    if (this.ffa) {
      let defRatio = 0;
      for (const h of team) {
        const ai = this.aiOf(h);
        if (ai !== undefined && ai.setup.newAI && ai.setup.autoAttack) {
          defRatio = Math.max(defRatio, this.armyOf(h)?.defence.defenceStatus() ?? 0);
        }
      }
      if (defRatio < MIN_DEF_RATIO) return;
    }
    const cmp = this.compareAlliances(teamIdx);
    if (cmp === null) return;
    if (cmp.bestCmp > MIN_ADVANTAGE) {
      const ar: AttackRequest = {
        active: true,
        foodShortage: false,
        ffa: this.ffa,
        bestAllianceCmp: cmp.bestCmp,
        worstAllianceCmp: cmp.worstCmp,
        bestEnemy: cmp.bestTarget,
        enemies: this.teams[cmp.bestCmpTeam].slice(),
      };
      for (const h of team) {
        const ai = this.aiOf(h);
        const army = this.armyOf(h);
        if (ai !== undefined && ai.setup.autoAttack && army !== null) army.setAttackRequest(ar);
      }
    }
  }

  /** UpdateDefPos (1048–1151): each team's defence positions, DivideDefences over one hand per team. */
  updateDefPos(teamIdx: number): void {
    const team = this.teams[teamIdx];
    if (!this.newAIInTeam(team, false, true) || this.teams.length <= 1) return;
    for (const h of team) {
      const ai = this.aiOf(h);
      const troops = ai !== undefined ? this.world.handUnitCount(h, UT_RECRUIT) + this.world.handWarriorCount(h) : 0;
      const req = delphiRound(troops / 8) + RESERVE_DEF_POS;
      const army = this.armyOf(h);
      if (ai !== undefined && ai.setup.newAI && ai.setup.autoDefend && army !== null) {
        army.defence.updateDefences(this.defenceLines(h, req));
      }
    }
  }

  /** The v0 defence-line generator (replaces the navmesh lines, see the header). */
  private defenceLines(hand: number, req: number): DefencePositionRequest[] {
    const w = this.world;
    this.eye.ownerUpdate(hand);
    const centers = this.eye.getCityCenterPoints(false);
    let center: Pt | null = centers[0] ?? null;
    if (center === null) {
      const h = w.houses.find((x) => x.owner === hand && !x.destroyed && x.buildState === 'done');
      if (h === undefined) return [];
      center = { x: h.entrance.x, y: h.entrance.y + 1 };
    }
    let anchor: Pt = center;
    let bestD = Number.POSITIVE_INFINITY;
    for (const h of w.houses) {
      if (h.destroyed || h.buildState !== 'done' || h.owner === hand || w.allianceOf(hand, h.owner) !== 'enemy') continue;
      const e = { x: h.entrance.x, y: h.entrance.y + 1 };
      const d = distanceSqr(center, e);
      if (d < bestD) {
        bestD = d;
        anchor = e;
      }
    }
    const cands: { x: number; y: number; d: number }[] = [];
    for (let r = 4; r <= 14; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = center.x + dx;
          const y = center.y + dy;
          if (!w.tileInMapCoords(x, y) || !w.tileWalkable(x, y) || w.isRoadTile(x, y) || w.houseAt(x, y) !== null) continue;
          if (!w.canWalkTo(center.x, center.y, x, y)) continue;
          cands.push({ x, y, d: distanceSqr({ x, y }, anchor) });
        }
      }
    }
    cands.sort((a, b) => a.d - b.d || a.y - b.y || a.x - b.x);
    const chosen: Pt[] = [];
    for (const c of cands) {
      if (chosen.length >= req) break;
      if (chosen.every((p) => Math.max(Math.abs(p.x - c.x), Math.abs(p.y - c.y)) >= 3)) chosen.push({ x: c.x, y: c.y });
    }
    const front = Math.max(1, Math.ceil(chosen.length / 3));
    return chosen.map((p, i) => ({ loc: p, dir: 4, weight: 1, line: i < front ? 0 : 1 }));
  }

  /** DivideResources (1153–1238): the mines of each team, shared out by influence. */
  divideResources(): void {
    const iron = this.eye.findSeparateMineLocs(true, HT_IRON_MINE);
    const gold = this.eye.findSeparateMineLocs(true, HT_GOLD_MINE);
    for (const team of this.teams) {
      const ironCnt = this.divideMines(team, iron);
      const goldCnt = this.divideMines(team, gold);
      team.forEach((h, i) => {
        const ai = this.aiOf(h);
        if (ai === undefined) return;
        ai.predictor.ironMineCnt = ironCnt[i];
        ai.predictor.maxGoldMineCnt = goldCnt[i];
      });
    }
  }

  /** FindAndDivideMines (1154–1224): the mines whose best owner is in the team, each given to the
   *  player with the fewest candidate mines; returns the count per team member. */
  private divideMines(team: number[], mines: Pt[]): number[] {
    const inf = this.influences;
    const plMines = team.map(() => 0);
    const plPossible = team.map(() => 0);
    const evals: { val: number; pt: Pt }[] = [];
    for (let k = mines.length - 1; k >= 0; k--) {
      const pt = mines[k];
      const best = inf.getBestOwner(pt.x, pt.y);
      if (!team.includes(best)) continue;
      let plCnt = 0;
      team.forEach((h, idx) => {
        if (inf.getOwnership(h, pt.x, pt.y) > 0) {
          plPossible[idx] += 1;
          plCnt += 1;
        }
      });
      evals.push({ val: plCnt * MAX_INFLUENCE + inf.getOwnership(best, pt.x, pt.y), pt });
    }
    evals.sort((a, b) => a.val - b.val);
    for (const m of evals) {
      let idx2 = 0;
      let bestPrice = 65535;
      team.forEach((h, idx) => {
        if (inf.getOwnership(h, m.pt.x, m.pt.y) > 0 && plPossible[idx] + plMines[idx] < bestPrice) {
          bestPrice = plPossible[idx] + plMines[idx];
          idx2 = idx;
        }
      });
      if (bestPrice === 65535) continue;
      plMines[idx2] += 1;
      team.forEach((h, idx) => {
        if (inf.getOwnership(h, m.pt.x, m.pt.y) > 0) plPossible[idx] -= 1;
      });
    }
    return plMines;
  }
}
