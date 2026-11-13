import type { Ship } from "../sim/ship/ship-entity";
import type { World } from "../sim/world";
import { capabilityProfile } from "../sim/ai/capabilities";

/**
 * Battle metrics for balancing (plan M7 task 6): when the shooting started, how the battle ended, how much
 * of it ships spent overheated or short of power, and what ammunition was left. Reads the world only.
 */
export type EndReason =
  | "command-destroyed"
  | "incapacitated"
  | "timeout-out-of-ammo"
  /** Nobody can fight because every weapon is destroyed (ships that can still fly are not defeated). */
  | "timeout-disarmed"
  | "timeout-retreat"
  | "timeout-stalemate";

/** A ship that can still hurt someone: a weapon that can fire, missiles or drones. */
const armed = (s: Ship) => {
  const c = capabilityProfile(s);
  return c.weapons.fixedDps + c.weapons.turretDps > 0 || c.missiles.stock > 0 || c.drones.stored > 0;
};

export interface ShipStats {
  readonly design: string;
  readonly side: "a" | "b";
  /** Seconds above 70 % heat (output throttled) and with weapons short of power. */
  hot: number;
  brownout: number;
  defeated: boolean;
  defeatReason: string | null;
  /** Parts destroyed by category at the end. */
  readonly lost: Record<string, number>;
}

export interface BattleMetrics {
  /** Battle length and time from the first hull damage to the end (s). */
  readonly time: number;
  readonly engagement: number;
  readonly winner: "a" | "b" | "draw";
  readonly reason: EndReason;
  /** Share of ammunition (rounds in magazines and weapons) each side still had at the end. */
  readonly ammoLeftA: number;
  readonly ammoLeftB: number;
  readonly missiles: { readonly launched: number; readonly down: number; readonly hits: number };
  readonly ships: readonly ShipStats[];
}

const ammoShare = (ships: readonly Ship[]) => {
  let have = 0;
  let cap = 0;
  for (const s of ships)
    for (const p of s.parts) {
      const d = p.def.def;
      const c = d.magazine?.capacity ?? (d.weapon?.ammoType ? d.weapon.internalMagazine : 0);
      if (!c) continue;
      cap += c;
      have += Math.max(0, p.ammo);
    }
  return cap > 0 ? have / cap : 1;
};

export class BattleObserver {
  private firstHit: number | null = null;
  private readonly stats = new Map<string, ShipStats>();

  constructor(
    private readonly world: World,
    private readonly a: readonly Ship[],
    private readonly b: readonly Ship[],
  ) {
    for (const [side, list] of [
      ["a", a],
      ["b", b],
    ] as const)
      for (const s of list)
        this.stats.set(s.id, {
          design: s.design.id,
          side,
          hot: 0,
          brownout: 0,
          defeated: false,
          defeatReason: null,
          lost: {},
        });
  }

  /** Call after every world step. */
  tick(dt: number): void {
    if (this.firstHit === null) {
      for (const row of Object.values(this.world.combat.damage))
        if (Object.values(row).some((v) => v > 0)) this.firstHit = this.world.time;
    }
    for (const s of [...this.a, ...this.b]) {
      if (s.defeated) continue;
      const st = this.stats.get(s.id)!;
      if (s.heatLevel > 0.7) st.hot += dt;
      const g = s.power.groups.weapons;
      if (g.demand > 0 && g.factor < 0.99) st.brownout += dt;
    }
  }

  /**
   * True while at least one ship on each side is undefeated and someone can still fight. When it turns
   * false nothing more can happen (both sides disarmed or out of ammunition), so a measuring run may stop.
   */
  undecided(): boolean {
    const live = [...this.a, ...this.b].filter((s) => !s.defeated && !s.inert);
    return live.some(armed);
  }

  finish(): BattleMetrics {
    const w = this.world;
    const aDown = this.a.every((s) => s.defeated);
    const bDown = this.b.every((s) => s.defeated);
    const winner = aDown === bDown ? "draw" : bDown ? "a" : "b";
    for (const s of [...this.a, ...this.b]) {
      const st = this.stats.get(s.id)!;
      st.defeated = s.defeated;
      st.defeatReason = s.defeatReason;
      for (const p of s.parts)
        if (p.hp <= 0) st.lost[p.def.def.category] = (st.lost[p.def.def.category] ?? 0) + 1;
    }
    let reason: EndReason;
    if (winner !== "draw") {
      const losers = winner === "a" ? this.b : this.a;
      reason = losers.some((s) => s.defeatReason === "command-destroyed")
        ? "command-destroyed"
        : "incapacitated";
    } else {
      const live = [...this.a, ...this.b].filter((s) => !s.defeated && !s.inert);
      const retreating = live.some((s) => w.ai.get(s.id)?.behaviour === "retreat");
      const weaponsLeft = live.some((s) => s.weapons.some((x) => x.part.hp > 0 && x.def.kind !== "pd"));
      reason = !live.some(armed)
        ? weaponsLeft
          ? "timeout-out-of-ammo"
          : "timeout-disarmed"
        : retreating
          ? "timeout-retreat"
          : "timeout-stalemate";
    }
    const st = w.combat.stats;
    return {
      time: w.time,
      engagement: this.firstHit === null ? 0 : w.time - this.firstHit,
      winner,
      reason,
      ammoLeftA: ammoShare(this.a),
      ammoLeftB: ammoShare(this.b),
      missiles: { launched: st.missilesLaunched, down: st.missilesDown, hits: st.missileHits },
      ships: [...this.stats.values()],
    };
  }
}
