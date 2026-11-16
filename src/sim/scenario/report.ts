import { capabilityProfile } from "../ai/capabilities";
import type { Behaviour } from "../ai/brain";
import type { Ship } from "../ship/ship-entity";
import type { World } from "../world";

/**
 * Battle log and after-action report (docs/battle-report.md): who destroyed whom, ships that fled, ran dry or
 * turned to retreat, objective events, each side's strength over time, and per ship the damage dealt and
 * taken, gunnery, what the AI spent its time doing, and how it ended. It only reads the world, so it runs
 * the same live, headless and in a replay.
 */

export type Side = "yours" | "ally" | "enemy";

export type Fate = "destroyed" | "escaped" | "retreating" | "disabled" | "fighting";

export interface BattleEvent {
  /** Battle time (s). */
  readonly t: number;
  readonly kind: "destroyed" | "escaped" | "retreat" | "dry" | "objective";
  readonly ship?: string;
  readonly text: string;
}

export interface StrengthSample {
  readonly t: number;
  /** Hull left as a share of the starting hull: your side (team 0), then the enemy. */
  readonly yours: number;
  readonly enemy: number;
}

export interface ShipReport {
  readonly id: string;
  readonly name: string;
  readonly side: Side;
  readonly team: number;
  /** Hull left (0..1). */
  readonly hull: number;
  readonly dealt: number;
  readonly taken: number;
  readonly kills: number;
  /** Gun rounds fired and the share that hit a ship (null: no guns fired). */
  readonly shots: number;
  readonly accuracy: number | null;
  readonly fate: Fate;
  /** Time of the fate, for destroyed and escaped ships (s). */
  readonly fateAt: number | null;
  /** Name of the ship that destroyed it ("collision" for impacts and black holes). */
  readonly killedBy: string | null;
  /** AI ships: share of time per behaviour, largest first (at most four). */
  readonly behaviours: readonly { readonly behaviour: string; readonly share: number }[];
  /** Fuel and ammunition left (0..1; ammo null without stores). */
  readonly fuel: number;
  readonly ammo: number | null;
}

export interface BattleReport {
  readonly scenario: string;
  readonly status: "running" | "won" | "lost";
  readonly reason: string;
  readonly time: number;
  readonly ships: readonly ShipReport[];
  readonly events: readonly BattleEvent[];
  readonly strength: readonly StrengthSample[];
}

/** Ticks between kill-attribution checks, behaviour samples and strength samples. */
const EVERY = { hits: 10, behaviour: 30, strength: 120 } as const;

const hullOf = (s: Ship) => s.parts.reduce((t, p) => t + Math.max(0, p.hp), 0);
const maxHullOf = (s: Ship) => s.parts.reduce((t, p) => t + p.def.def.hp, 0);
export const shortName = (s: Ship) => s.design.name.split(" (")[0]!;

interface Tracked {
  readonly ship: Ship;
  readonly side: Side;
  readonly startHull: number;
  readonly maxHull: number;
  readonly behaviours: Map<Behaviour, number>;
  fate: Fate | null;
  fateAt: number | null;
  killedBy: string | null;
  killerId: string | null;
  retreated: boolean;
  dry: boolean;
}

export class BattleLog {
  private readonly tracked = new Map<string, Tracked>();
  readonly events: BattleEvent[] = [];
  readonly strength: StrengthSample[] = [];
  /** Last attacker to damage each ship, from the damage matrix. */
  private readonly lastHit = new Map<string, string>();
  private prevDamage: Record<string, Record<string, number>> = {};

  constructor(ships: readonly { ship: Ship; side: Side }[]) {
    for (const { ship, side } of ships)
      this.tracked.set(ship.id, {
        ship,
        side,
        startHull: hullOf(ship),
        maxHull: maxHullOf(ship),
        behaviours: new Map(),
        fate: null,
        fateAt: null,
        killedBy: null,
        killerId: null,
        retreated: false,
        dry: false,
      });
  }

  /** An objective event (zone taken, escort arrived …) for the timeline. */
  note(world: World, text: string): void {
    this.events.push({ t: world.time, kind: "objective", text });
  }

  /** After every world step. */
  update(world: World): void {
    const tick = world.tick;
    if (tick % EVERY.hits === 0) this.attribute(world);
    for (const tr of this.tracked.values()) {
      if (tr.fate) continue;
      const s = tr.ship;
      if (s.escaped) {
        tr.fate = "escaped";
        tr.fateAt = s.escapedAt ?? world.time;
        this.events.push({ t: tr.fateAt, kind: "escaped", ship: s.id, text: `${shortName(s)} jumped out` });
      } else if (s.defeated) {
        this.attribute(world);
        tr.fate = "destroyed";
        tr.fateAt = world.time;
        const by = this.lastHit.get(s.id) ?? null;
        tr.killerId = by;
        tr.killedBy =
          by === null
            ? null
            : this.tracked.has(by) || world.hasShip(by)
              ? shortName(this.tracked.get(by)?.ship ?? world.getShip(by))
              : "collision";
        this.events.push({
          t: world.time,
          kind: "destroyed",
          ship: s.id,
          text: `${shortName(s)} destroyed${tr.killedBy ? ` by ${tr.killedBy}` : ""}`,
        });
      }
    }
    if (tick % EVERY.behaviour === 0) this.sampleBehaviour(world);
    if (tick % EVERY.strength === 0) this.sampleStrength(world);
  }

  /** Who last hit whom: the attacker → target damage record grows. */
  private attribute(world: World): void {
    const now = world.combat.dealtTo;
    for (const [attacker, row] of Object.entries(now)) {
      const prev = this.prevDamage[attacker];
      for (const [target, v] of Object.entries(row))
        if (v > (prev?.[target] ?? 0)) this.lastHit.set(target, attacker);
    }
    this.prevDamage = Object.fromEntries(Object.entries(now).map(([a, row]) => [a, { ...row }]));
  }

  private sampleBehaviour(world: World): void {
    for (const tr of this.tracked.values()) {
      if (tr.fate) continue;
      const s = tr.ship;
      const st = world.ai.get(s.id);
      if (st) tr.behaviours.set(st.behaviour, (tr.behaviours.get(st.behaviour) ?? 0) + 1);
      if (st && st.behaviour === "retreat" && !tr.retreated) {
        tr.retreated = true;
        this.events.push({
          t: world.time,
          kind: "retreat",
          ship: s.id,
          text: `${shortName(s)} ${st.retreatMode === "escape" ? "is getting away" : "falls back"}`,
        });
      }
      if (!tr.dry && !s.drone && s.parts.some((p) => p.def.def.weapon && p.def.def.weapon.kind !== "pd")) {
        const c = capabilityProfile(s);
        const armed =
          c.weapons.fixedDps + c.weapons.turretDps > 0 || c.missiles.stock > 0 || c.drones.stored > 0;
        if (!armed) {
          tr.dry = true;
          this.events.push({
            t: world.time,
            kind: "dry",
            ship: s.id,
            text: `${shortName(s)} has nothing left to fire`,
          });
        }
      }
    }
  }

  private sampleStrength(world: World): void {
    this.strength.push(this.strengthNow(world));
  }

  private strengthNow(world: World): StrengthSample {
    let y = 0;
    let y0 = 0;
    let e = 0;
    let e0 = 0;
    for (const tr of this.tracked.values()) {
      const h = tr.ship.defeated ? 0 : hullOf(tr.ship);
      if (tr.ship.team === 0) {
        y += h;
        y0 += tr.startHull;
      } else {
        e += h;
        e0 += tr.startHull;
      }
    }
    return { t: world.time, yours: y0 > 0 ? y / y0 : 0, enemy: e0 > 0 ? e / e0 : 0 };
  }

  /** The report as it stands now (final once the battle has ended). */
  report(
    world: World,
    head: { scenario: string; status: BattleReport["status"]; reason: string; time: number },
  ): BattleReport {
    const ships: ShipReport[] = [];
    const kills = new Map<string, number>();
    for (const tr of this.tracked.values())
      if (tr.fate === "destroyed" && tr.killerId) kills.set(tr.killerId, (kills.get(tr.killerId) ?? 0) + 1);
    for (const tr of this.tracked.values()) {
      const s = tr.ship;
      const st = world.hasShip(s.id) ? world.ai.get(s.id) : undefined;
      // Hull damage to the other side (not friendly fire).
      let dealt = 0;
      for (const [target, v] of Object.entries(world.combat.dealtTo[s.id] ?? {}))
        if (this.tracked.get(target)?.ship.team !== s.team) dealt += v;
      const g = world.combat.gunnery[s.id];
      const samples = [...tr.behaviours.values()].reduce((t, v) => t + v, 0);
      const fate: Fate =
        tr.fate ?? (s.inert ? "disabled" : st?.behaviour === "retreat" ? "retreating" : "fighting");
      const c = capabilityProfile(s);
      const hasAmmo = s.parts.some((p) => p.def.def.magazine);
      ships.push({
        id: s.id,
        name: shortName(s),
        side: tr.side,
        team: s.team,
        hull: tr.maxHull > 0 ? hullOf(s) / tr.maxHull : 0,
        dealt,
        taken: Math.max(0, tr.startHull - hullOf(s)),
        kills: kills.get(s.id) ?? 0,
        shots: g?.shots ?? 0,
        accuracy: g && g.shots > 0 ? g.hits / g.shots : null,
        fate,
        fateAt: tr.fateAt,
        killedBy: tr.killedBy,
        behaviours: [...tr.behaviours]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 4)
          .map(([behaviour, n]) => ({ behaviour, share: samples > 0 ? n / samples : 0 })),
        fuel: s.fuelCapacity > 0 ? s.totalFuel / s.fuelCapacity : 0,
        ammo: hasAmmo ? c.ammo : null,
      });
    }
    return {
      ...head,
      ships,
      events: [...this.events].sort((a, b) => a.t - b.t),
      // Ends with the state at the time of the report.
      strength:
        this.strength.at(-1)?.t === world.time
          ? [...this.strength]
          : [...this.strength, this.strengthNow(world)],
    };
  }
}
