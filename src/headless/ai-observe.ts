import catalogueJson from "../data/core/catalogue.json";
import { validateCatalogue } from "../data/validate";
import { aiProfile } from "../data/ai/index";
import type { AiProfile } from "../data/schemas/ai";
import { BUNDLED_DESIGNS, CORE_DRONES } from "../data/designs/index";
import { PartCatalogue } from "../sim/ship/catalogue";
import { applySkirmishOrders, skirmishBattle, type SkirmishShip } from "../sim/scenario/skirmish";
import { startBattle, updateBattle } from "../sim/scenario/battle";
import { capabilityProfile } from "../sim/ai/capabilities";
import { engagementRange, type Behaviour } from "../sim/ai/brain";
import { length, sub } from "../sim/core/vec2";
import type { Ship } from "../sim/ship/ship-entity";
import { BattleObserver } from "./observe";

/**
 * Observed battles of one AI profile (docs/ai-behaviour.md): its side fights a weaker, a comparable and a
 * stronger enemy flown by the balanced AI, and every half second the harness records what each of its ships
 * is doing, so the behaviour can be checked against what the profile is meant to do.
 */

export type Strength = "weaker" | "comparable" | "stronger";

export interface Matchup {
  /** The observed side: design ids, and which ship (index) the others guard, if they are defensive. */
  readonly own: readonly string[];
  readonly guard?: number;
  readonly enemy: Record<Strength, readonly string[]>;
}

const GUN: Matchup = {
  own: ["fleet-rapier", "fleet-wasp", "fleet-wasp"],
  enemy: {
    weaker: ["fleet-maul", "fleet-wasp"],
    comparable: ["fleet-rapier", "fleet-wasp", "fleet-wasp"],
    stronger: ["fleet-anvil", "fleet-rapier"],
  },
};

/** The fleets each profile is observed with: its role needs the right ships (a carrier, missile ships). */
export const MATCHUPS: Readonly<Record<string, Matchup>> = {
  balanced: GUN,
  aggressive: GUN,
  kiter: GUN,
  brawler: GUN,
  sniper: GUN,
  cautious: GUN,
  retreating: GUN,
  "fleet-pass": GUN,
  defensive: {
    own: ["fleet-viper", "fleet-rapier", "fleet-wasp"],
    guard: 0,
    enemy: {
      weaker: ["fleet-rapier"],
      comparable: ["fleet-rapier", "fleet-rapier", "fleet-wasp"],
      stronger: ["fleet-anvil", "fleet-rapier", "fleet-rapier", "fleet-wasp"],
    },
  },
  carrier: {
    own: ["fleet-ark"],
    enemy: {
      weaker: ["fleet-maul", "fleet-wasp"],
      comparable: ["fleet-rapier", "fleet-maul", "fleet-wasp"],
      stronger: ["fleet-anvil", "fleet-rapier", "fleet-wasp"],
    },
  },
  "missile-wall": {
    own: ["fleet-viper", "fleet-maul", "fleet-maul"],
    enemy: {
      weaker: ["fleet-rapier"],
      comparable: ["fleet-anvil", "fleet-wasp", "fleet-wasp"],
      stronger: ["fleet-anvil", "fleet-rapier", "fleet-rapier"],
    },
  },
};

export interface ShipTrace {
  readonly design: string;
  /** Seconds in each behaviour. */
  readonly behaviour: Partial<Record<Behaviour, number>>;
  /** Distance to the current target over the range the behaviour aims for (samples while targeting). */
  readonly rangeRatio: number[];
  /** Distance to the nearest enemy (m). */
  readonly nearest: number[];
  /** Speed (m/s), and speed of opening (+) or closing (−) on the nearest enemy. */
  readonly speed: number[];
  readonly opening: number[];
  /** Hull share when the first retreat began (null: never retreated). */
  retreatAt: number | null;
  /** Hull share at the end, and whether the ship was defeated. */
  hull: number;
  defeated: boolean;
  /** Seconds with missiles incoming (evade horizon), and seconds evading. */
  threatened: number;
  /** Defensive: distance to the guarded ship (m), and its target's distance to the guarded ship (m). */
  readonly guardDistance: number[];
  readonly targetFromGuard: number[];
  /** Missile volleys (tick) and drone launch distance (m). */
  readonly volleys: number[];
  droneLaunch: number | null;
  /** Missile range (m), for standoff checks. */
  missileRange: number;
}

export interface ObservedBattle {
  readonly profile: string;
  readonly strength: Strength;
  readonly own: readonly string[];
  readonly enemy: readonly string[];
  readonly costRatio: number;
  readonly winner: "own" | "enemy" | "draw";
  readonly time: number;
  readonly ownLost: number;
  readonly enemyLost: number;
  readonly ownFiring: number;
  readonly ships: readonly ShipTrace[];
  /** Pass doctrine: closest approaches to the enemy below 1.5 km (passes), and abreast spacing (m). */
  readonly passes: number;
  readonly spacing: number[];
}

const r = validateCatalogue(catalogueJson);
if (!r.ok) throw new Error(r.errors.join("\n"));
const CAT = PartCatalogue.fromJson(r.value);

const cost = (ids: readonly string[]) =>
  ids.reduce(
    (s, id) =>
      s +
      BUNDLED_DESIGNS.get(id)!.parts.reduce(
        (a, p) => a + (CAT.has(p.partId) ? CAT.get(p.partId).def.cost : 0),
        0,
      ),
    0,
  );

const SAMPLE = 30;

/** One observed battle of `profile` (or a full profile object) against the balanced AI. */
export function observeBattle(
  profileId: string,
  strength: Strength,
  opts: {
    seed?: number;
    timeLimit?: number;
    distance?: number;
    profile?: AiProfile;
    /** Fleets to use instead of the profile's default matchup. */
    matchup?: Matchup;
    /** Hull share the enemy starts with (a weaker copy of the same ship). */
    enemyHull?: number;
  } = {},
): ObservedBattle {
  const m = opts.matchup ?? MATCHUPS[profileId] ?? GUN;
  const profile = opts.profile ?? aiProfile(profileId);
  const enemyIds = m.enemy[strength];
  const ownSide: SkirmishShip[] = m.own.map((designId, i) =>
    m.guard !== undefined && i !== m.guard
      ? { designId, pilot: "defensive", profile, guard: m.guard }
      : m.guard !== undefined
        ? { designId, pilot: "aggressive", profile: aiProfile("balanced") }
        : { designId, pilot: "aggressive", profile },
  );
  const enemySide: SkirmishShip[] = enemyIds.map((designId) => ({
    designId,
    pilot: "aggressive",
    profile: aiProfile("balanced"),
  }));
  const setup = { sides: [ownSide, enemySide] as const, distance: opts.distance ?? 6000 };
  const seed = opts.seed ?? 1;
  const sk = skirmishBattle(setup, BUNDLED_DESIGNS, {
    width: 16000,
    height: 12000,
    asteroids: [],
    gravityWells: [],
  });
  const battle = startBattle({ ...sk.scenario, seed }, sk.fleet, CAT, {
    seed,
    designs: BUNDLED_DESIGNS,
    profiles: sk.profiles,
    droneDesigns: CORE_DRONES,
  });
  applySkirmishOrders(battle, sk, setup);
  if (opts.enemyHull !== undefined)
    for (const s of battle.enemyShips) for (const p of s.parts) p.hp = p.def.def.hp * opts.enemyHull;
  const w = battle.world;
  const own = battle.allyShips;
  const enemies = battle.enemyShips;
  const observed = own.filter((s, i) => m.guard === undefined || i !== m.guard);
  const obs = new BattleObserver(w, own, enemies);
  const traces = new Map<string, ShipTrace>();
  for (const s of observed)
    traces.set(s.id, {
      design: s.design.id,
      behaviour: {},
      rangeRatio: [],
      nearest: [],
      speed: [],
      opening: [],
      retreatAt: null,
      hull: 1,
      defeated: false,
      threatened: 0,
      guardDistance: [],
      targetFromGuard: [],
      volleys: [],
      droneLaunch: null,
      missileRange: capabilityProfile(s).missiles.range,
    });
  const lastVolley = new Map<string, number>();
  const spacing: number[] = [];
  let passes = 0;
  let prevGap = Infinity;
  let falling = false;
  const alive = (s: Ship) => !s.defeated && w.hasShip(s.id);
  const ticks = Math.round((opts.timeLimit ?? 360) * 60);
  let t = 0;
  for (; t < ticks && battle.status === "running"; t++) {
    w.step();
    updateBattle(battle);
    obs.tick(1 / 60);
    if (t % 60 === 59 && !obs.undecided()) break;
    if (t % SAMPLE !== 0) continue;
    const foes = enemies.filter(alive);
    for (const s of observed) {
      const tr = traces.get(s.id)!;
      if (!alive(s)) continue;
      const st = w.ai.get(s.id);
      if (!st) continue;
      const dt = SAMPLE / 60;
      tr.behaviour[st.behaviour] = (tr.behaviour[st.behaviour] ?? 0) + dt;
      const caps = capabilityProfile(s);
      if (st.behaviour === "retreat" && tr.retreatAt === null) tr.retreatAt = caps.hp;
      const pos = w.physics.getWorldCenter(s.id);
      const vel = w.physics.getBodyState(s.id).linearVelocity;
      tr.speed.push(length(vel));
      if (foes.length) {
        let best = foes[0]!;
        let bd = Infinity;
        for (const f of foes) {
          const d = length(sub(w.physics.getWorldCenter(f.id), pos));
          if (d < bd) {
            bd = d;
            best = f;
          }
        }
        tr.nearest.push(bd);
        const fp = w.physics.getWorldCenter(best.id);
        const fv = w.physics.getBodyState(best.id).linearVelocity;
        const rel = sub(pos, fp);
        const rv = sub(vel, fv);
        tr.opening.push((rel.x * rv.x + rel.y * rv.y) / Math.max(1, length(rel)));
      }
      if (st.targetId && w.hasShip(st.targetId)) {
        const d = length(sub(w.physics.getWorldCenter(st.targetId), pos));
        tr.rangeRatio.push(d / Math.max(1, engagementRange(st)));
      }
      const incoming = w.combat.missiles.some((mm) => mm.target === s.id && mm.hp > 0 && mm.team !== s.team);
      if (incoming) tr.threatened += dt;
      const o = st.order;
      if (o?.kind === "guard" && w.hasShip(o.target)) {
        const g = w.physics.getWorldCenter(o.target);
        tr.guardDistance.push(length(sub(pos, g)));
        if (st.targetId && w.hasShip(st.targetId))
          tr.targetFromGuard.push(length(sub(w.physics.getWorldCenter(st.targetId), g)));
      }
      if (st.lastVolleyTick !== (lastVolley.get(s.id) ?? -1e9) && st.lastVolleyTick > 0) {
        tr.volleys.push(st.lastVolleyTick);
        lastVolley.set(s.id, st.lastVolleyTick);
      }
      if (st.dronesLaunched && tr.droneLaunch === null) tr.droneLaunch = tr.nearest.at(-1) ?? null;
    }
    // Formation: spacing between the observed ships still flying, and passes (closest approaches).
    const live = observed.filter(alive).map((s) => w.physics.getWorldCenter(s.id));
    if (live.length > 1) {
      let sum = 0;
      for (let i = 1; i < live.length; i++) sum += length(sub(live[i]!, live[i - 1]!));
      spacing.push(sum / (live.length - 1));
    }
    if (foes.length && live.length) {
      let gap = Infinity;
      for (const p of live)
        for (const f of foes) gap = Math.min(gap, length(sub(w.physics.getWorldCenter(f.id), p)));
      if (gap > prevGap) {
        if (falling && prevGap < 1500) passes++;
        falling = false;
      } else falling = true;
      prevGap = gap;
    }
  }
  const metrics = obs.finish(false);
  for (const s of observed) {
    const tr = traces.get(s.id)!;
    tr.hull = capabilityProfile(s).hp;
    tr.defeated = s.defeated || !w.hasShip(s.id);
  }
  let alive0 = 0;
  let alive1 = 0;
  let fire = 0;
  let aliveT = 0;
  for (const s of metrics.ships) {
    if (s.side === "a") {
      fire += s.firing;
      aliveT += s.alive;
      if (s.defeated) alive0++;
    } else if (s.defeated) alive1++;
  }
  return {
    profile: profileId,
    strength,
    own: m.own,
    enemy: enemyIds,
    costRatio: cost(enemyIds) / cost(m.own),
    winner: metrics.winner === "a" ? "own" : metrics.winner === "b" ? "enemy" : "draw",
    time: metrics.time,
    ownLost: alive0,
    enemyLost: alive1,
    ownFiring: aliveT > 0 ? fire / aliveT : 0,
    ships: [...traces.values()],
    passes,
    spacing,
  };
}

const med = (xs: readonly number[]) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};
const pct = (xs: readonly number[], q: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * q))]!;
};

/** One line per observed ship: the numbers the behaviour descriptions are checked against. */
export function describe(b: ObservedBattle): string {
  const out = [
    `${b.profile} vs ${b.strength} (enemy ${b.enemy.join("+")}, cost ×${b.costRatio.toFixed(2)}): ` +
      `${b.winner} in ${b.time.toFixed(0)} s, lost ${b.ownLost}:${b.enemyLost}, firing ${(b.ownFiring * 100).toFixed(0)} %` +
      (b.spacing.length ? `, spacing med ${med(b.spacing).toFixed(0)} m, passes ${b.passes}` : ""),
  ];
  for (const s of b.ships) {
    const total = Object.values(s.behaviour).reduce((a, x) => a + x, 0) || 1;
    const beh = Object.entries(s.behaviour)
      .sort((x, y) => y[1] - x[1])
      .map(([k, v]) => `${k} ${Math.round((100 * v) / total)}%`)
      .join(" ");
    const vol = s.volleys.length;
    out.push(
      `  ${s.design.padEnd(13)} ${beh}\n` +
        `    range/R med ${med(s.rangeRatio).toFixed(2)} (p10 ${pct(s.rangeRatio, 0.1).toFixed(2)}, p90 ${pct(s.rangeRatio, 0.9).toFixed(2)})` +
        ` · nearest med ${med(s.nearest).toFixed(0)} m min ${Math.min(...s.nearest).toFixed(0)}` +
        ` · speed med ${med(s.speed).toFixed(0)} max ${Math.max(...s.speed, 0).toFixed(0)}` +
        ` · opening med ${med(s.opening).toFixed(1)}` +
        ` · retreat at ${s.retreatAt === null ? "—" : `${(s.retreatAt * 100).toFixed(0)}%`}` +
        ` · hull ${(s.hull * 100).toFixed(0)}%${s.defeated ? " DEFEATED" : ""}` +
        (s.threatened ? ` · missiles incoming ${s.threatened.toFixed(0)} s` : "") +
        (s.guardDistance.length
          ? ` · guard dist med ${med(s.guardDistance).toFixed(0)} max ${Math.max(...s.guardDistance).toFixed(0)}, target from guard med ${med(s.targetFromGuard).toFixed(0)} max ${Math.max(...s.targetFromGuard, 0).toFixed(0)}`
          : "") +
        (vol ? ` · volleys ${vol} (missile range ${s.missileRange.toFixed(0)})` : "") +
        (s.droneLaunch !== null ? ` · drones at ${s.droneLaunch.toFixed(0)} m` : ""),
    );
  }
  return out.join("\n");
}

/** Missile-wall: share of volleys that another ship of the side fired within 1 s of. */
export function salvoSync(b: ObservedBattle): number {
  const all = b.ships.flatMap((s, i) => s.volleys.map((t) => [i, t] as const));
  if (!all.length) return NaN;
  let together = 0;
  for (const [i, t] of all) if (all.some(([j, u]) => j !== i && Math.abs(u - t) <= 60)) together++;
  return together / all.length;
}

/** Ship sizes each profile flies in the per-ship study: small, medium and large. */
export type Size = "small" | "medium" | "large";
export const SIZES: Readonly<Record<string, Readonly<Record<Size, string>>>> = {
  default: { small: "fleet-wasp", medium: "fleet-rapier", large: "fleet-anvil" },
  "missile-wall": { small: "fleet-maul", medium: "fleet-viper", large: "fleet-squall" },
  carrier: { small: "fleet-wasp", medium: "fleet-ark", large: "fleet-anvil" },
};

/**
 * One ship flown by the profile against the balanced AI in the same ship: a damaged copy (weaker, 50 %
 * hull), an equal copy (comparable) or two copies (stronger). Defensive ships guard an unarmed Spark.
 */
export function shipMatchup(
  profileId: string,
  design: string,
  strength: Strength,
): {
  matchup: Matchup;
  enemyHull?: number;
} {
  const enemy = strength === "stronger" ? [design, design] : [design];
  const own = profileId === "defensive" ? ["fleet-spark", design] : [design];
  const matchup: Matchup = {
    own,
    ...(profileId === "defensive" ? { guard: 0 } : {}),
    enemy: { weaker: enemy, comparable: enemy, stronger: enemy },
  };
  return strength === "weaker" ? { matchup, enemyHull: 0.5 } : { matchup };
}
