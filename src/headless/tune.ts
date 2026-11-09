import type { BalanceOverlay } from "../data/balance/overlay";
import type { ShipDesign } from "../data/schemas/design";
import type { PartCatalogue } from "../sim/ship/catalogue";
import { describeDesign } from "./balance";
import type { Job, JobResult } from "./jobs";
import type { BattleMetrics } from "./observe";

/**
 * Automated balance tuning (plan M7 task 6). Each iteration fights the weapon archetypes against each
 * other and the scenarios with their reference fleets, measures the battles, and nudges a balance overlay:
 *
 * 1. Pace: every part's HP (with ammunition following, fuel a little) so the median engagement — first hit
 *    to the end — lands near the target.
 * 2. Weapons: damage of a weapon type whose archetypes win clearly more or less than half their duels.
 * 3. Energy: power draw and heat of weapons whose ships spend too long throttled or browned out.
 * 4. Element HP: command modules, when most battles end with the command module destroyed.
 * 5. Ammunition, when too many battles end with both sides out of ammo.
 *
 * Steps are damped and clamped; every adjustment is listed in the iteration's notes. Pure functions apart
 * from `tune`, which runs the battles through an injected runner.
 */

export interface TuneTargets {
  /** Median engagement time the pace step aims for, and the band counted as done (s). */
  readonly engagement: number;
  readonly engagementBand: readonly [number, number];
  /** Per weapon type, the duel win-rate band counted as balanced. */
  readonly winBand: readonly [number, number];
  /** Largest acceptable shares of battles that time out, and that end with everyone out of ammo. */
  readonly maxTimeouts: number;
  readonly maxAmmoOut: number;
  /** Throttled-time share band for energy weapons. */
  readonly throttleBand: readonly [number, number];
  /** Largest acceptable share of decided battles ended by a destroyed command module. */
  readonly maxCommandShare: number;
}

export const DEFAULT_TARGETS: TuneTargets = {
  engagement: 150,
  engagementBand: [60, 300],
  winBand: [0.35, 0.65],
  maxTimeouts: 0.1,
  maxAmmoOut: 0.1,
  throttleBand: [0.02, 0.3],
  maxCommandShare: 0.6,
};

/** Limits on how far tuning may move a knob from the hand-set catalogue. */
export const GUARDRAILS = {
  pace: [0.5, 8] as const,
  weapon: [0.5, 1.5] as const,
  element: [0.5, 2] as const,
  /** Largest change of a weapon or element knob in one iteration. */
  step: 0.15,
};

export interface WeaponStats {
  readonly games: number;
  readonly winRate: number;
  /** 95 % Wilson interval of the win rate. */
  readonly ci: readonly [number, number];
}

export interface IterationStats {
  readonly battles: number;
  readonly medianEngagement: number;
  readonly medianDuel: number;
  readonly medianScenario: number;
  readonly timeouts: number;
  readonly ammoOut: number;
  readonly commandShare: number;
  readonly weapons: Readonly<Record<string, WeaponStats>>;
  /** Share of battle time energy-weapon ships spent overheated or browned out, by weapon id. */
  readonly throttle: Readonly<Record<string, number>>;
  readonly scenarios: Readonly<Record<string, { runs: number; wins: number; median: number }>>;
  /** How battles ended, and which ones timed out (for the report). */
  readonly reasons: Readonly<Record<string, number>>;
  readonly draws: readonly string[];
}

export const median = (xs: readonly number[]) => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** 95 % Wilson score interval for k successes in n trials. */
export function wilson(k: number, n: number): [number, number] {
  if (n === 0) return [0, 1];
  const z = 1.96;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const r = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [(c - r) / d, (c + r) / d];
}

/**
 * Engagement time counted for pace: the first-hit-to-end span, or the whole battle when the first hit
 * also ended it (an alpha strike) or no hit landed.
 */
export const engagementOf = (m: BattleMetrics) => (m.engagement > 0 ? m.engagement : m.time);

export function measure(
  results: readonly JobResult[],
  designs: ReadonlyMap<string, ShipDesign>,
  catalogue: PartCatalogue,
): IterationStats {
  const all: BattleMetrics[] = [];
  const duel: number[] = [];
  const scen: number[] = [];
  const primary = new Map<string, string>();
  const powered = new Set<string>();
  const wins = new Map<string, { w: number; n: number }>();
  const thr = new Map<string, { t: number; total: number }>();
  const scenarios: Record<string, { runs: number; wins: number; times: number[] }> = {};
  const primaryOf = (id: string) => {
    let p = primary.get(id);
    if (!p) {
      const d = designs.get(id);
      p = d ? describeDesign(d, catalogue).primary : "none";
      primary.set(id, p);
      if (p !== "none" && catalogue.has(p)) {
        const w = catalogue.get(p).def.weapon;
        if (w && ((w.powerDraw ?? 0) > 0 || (w.powerPerShot ?? 0) > 0)) powered.add(p);
      }
    }
    return p;
  };
  const reasons: Record<string, number> = {};
  const draws: string[] = [];
  for (const r of results) {
    const m = r.result.metrics;
    all.push(m);
    reasons[m.reason] = (reasons[m.reason] ?? 0) + 1;
    if (m.winner === "draw")
      draws.push(
        `${r.kind === "match" ? `${r.result.a} vs ${r.result.b}` : r.result.scenario} #${r.job.seed}: ${m.reason}`,
      );
    if (r.kind === "match") {
      duel.push(engagementOf(m));
      const pa = primaryOf(r.result.a);
      const pb = primaryOf(r.result.b);
      if (pa !== pb) {
        for (const [p, side] of [
          [pa, "a"],
          [pb, "b"],
        ] as const) {
          const e = wins.get(p) ?? { w: 0, n: 0 };
          e.n++;
          if (m.winner === side) e.w++;
          else if (m.winner === "draw") e.w += 0.5;
          wins.set(p, e);
        }
      }
      for (const s of m.ships) {
        const p = primaryOf(s.design);
        if (!powered.has(p)) continue;
        const e = thr.get(p) ?? { t: 0, total: 0 };
        e.t += Math.max(s.hot, s.brownout);
        e.total += m.time;
        thr.set(p, e);
      }
    } else {
      scen.push(engagementOf(m));
      const e = (scenarios[r.result.scenario] ??= { runs: 0, wins: 0, times: [] });
      e.runs++;
      if (r.result.status === "won") e.wins++;
      e.times.push(engagementOf(m));
    }
  }
  const decided = all.filter((m) => m.winner !== "draw");
  const weapons: Record<string, WeaponStats> = {};
  for (const [p, e] of wins) weapons[p] = { games: e.n, winRate: e.w / e.n, ci: wilson(e.w, e.n) };
  const throttle: Record<string, number> = {};
  for (const [p, e] of thr) throttle[p] = e.total > 0 ? e.t / e.total : 0;
  return {
    battles: all.length,
    medianEngagement: median(all.map(engagementOf)),
    medianDuel: median(duel),
    medianScenario: median(scen),
    timeouts: all.length ? all.filter((m) => m.winner === "draw").length / all.length : 0,
    ammoOut: all.length ? all.filter((m) => m.reason === "timeout-out-of-ammo").length / all.length : 0,
    commandShare: decided.length
      ? decided.filter((m) => m.reason === "command-destroyed").length / decided.length
      : 0,
    weapons,
    throttle,
    reasons,
    draws,
    scenarios: Object.fromEntries(
      Object.entries(scenarios).map(([k, v]) => [k, { runs: v.runs, wins: v.wins, median: median(v.times) }]),
    ),
  };
}

const clamp = (x: number, [lo, hi]: readonly [number, number]) => Math.min(hi, Math.max(lo, x));
const round3 = (x: number) => Math.round(x * 1000) / 1000;
const stepClamp = (k: number) => clamp(k, [1 - GUARDRAILS.step, 1 + GUARDRAILS.step]);

/** True when every target is met. */
export function converged(s: IterationStats, t: TuneTargets = DEFAULT_TARGETS): boolean {
  const [lo, hi] = t.engagementBand;
  return (
    s.medianEngagement >= lo &&
    s.medianEngagement <= hi &&
    Object.values(s.weapons).every((w) => w.winRate >= t.winBand[0] && w.winRate <= t.winBand[1]) &&
    s.timeouts <= t.maxTimeouts &&
    s.ammoOut <= t.maxAmmoOut
  );
}

/** The next overlay and the reasons for each change. */
export function adjust(
  overlay: BalanceOverlay,
  s: IterationStats,
  t: TuneTargets = DEFAULT_TARGETS,
): { overlay: BalanceOverlay; notes: string[] } {
  const o: BalanceOverlay = structuredClone(overlay);
  const notes: string[] = [];
  const g = (o.global ??= {});
  // 1. Pace.
  if (s.medianEngagement > 0) {
    const ratio = t.engagement / s.medianEngagement;
    if (Math.abs(Math.log(ratio)) > Math.log(1.15)) {
      const k = Math.pow(ratio, 0.8);
      const hp = round3(clamp((g.hp ?? 1) * k, GUARDRAILS.pace));
      const applied = hp / (g.hp ?? 1);
      g.hp = hp;
      g.ammo = round3(clamp((g.ammo ?? 1) * applied, GUARDRAILS.pace));
      g.fuel = round3(clamp((g.fuel ?? 1) * Math.sqrt(applied), GUARDRAILS.pace));
      notes.push(
        `pace: median engagement ${s.medianEngagement.toFixed(0)} s vs target ${t.engagement} s → HP ×${applied.toFixed(2)} (now ×${hp}), ammo follows, fuel ×${Math.sqrt(applied).toFixed(2)}`,
      );
    }
  }
  // 2. Weapon damage.
  for (const [id, w] of Object.entries(s.weapons).sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const outside = w.winRate < t.winBand[0] || w.winRate > t.winBand[1];
    const significant = w.ci[0] > 0.5 || w.ci[1] < 0.5;
    if (!outside || !significant) continue;
    const k = stepClamp(Math.pow(0.5 / Math.max(0.05, Math.min(0.95, w.winRate)), 0.3));
    const wk = ((o.weapons ??= {})[id] ??= {});
    wk.damage = round3(clamp((wk.damage ?? 1) * k, GUARDRAILS.weapon));
    notes.push(
      `weapon ${id}: wins ${(w.winRate * 100).toFixed(0)} % of ${w.games} duels → damage ×${k.toFixed(2)} (now ×${wk.damage})`,
    );
  }
  // 3. Energy.
  for (const [id, share] of Object.entries(s.throttle).sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    let k = 1;
    if (share > t.throttleBand[1]) k = 0.9;
    else if (share < t.throttleBand[0]) k = 1.05;
    if (k === 1) continue;
    const wk = ((o.weapons ??= {})[id] ??= {});
    wk.powerDraw = round3(clamp((wk.powerDraw ?? 1) * k, GUARDRAILS.weapon));
    wk.heat = round3(clamp((wk.heat ?? 1) * k, GUARDRAILS.weapon));
    notes.push(`energy ${id}: throttled ${(share * 100).toFixed(0)} % of the time → power and heat ×${k}`);
  }
  // 4. Element HP: command modules.
  if (s.commandShare > t.maxCommandShare) {
    const c = ((o.category ??= {}).command ??= {});
    c.hp = round3(clamp((c.hp ?? 1) * 1.15, GUARDRAILS.element));
    notes.push(
      `element: ${(s.commandShare * 100).toFixed(0)} % of decided battles ended with the command module destroyed → command HP ×1.15 (now ×${c.hp})`,
    );
  }
  // 4b. Element HP: armor, when defence outlasts every weapon (battles stuck with both sides firing).
  const stalemates = s.battles ? (s.reasons["timeout-stalemate"] ?? 0) / s.battles : 0;
  if (stalemates > t.maxTimeouts / 2) {
    const a = ((o.category ??= {}).armor ??= {});
    a.hp = round3(clamp((a.hp ?? 1) * 0.9, GUARDRAILS.element));
    notes.push(
      `element: ${(stalemates * 100).toFixed(0)} % of battles stalemated → armor HP ×0.9 (now ×${a.hp})`,
    );
  }
  // 5. Ammunition.
  if (s.ammoOut > t.maxAmmoOut) {
    g.ammo = round3(clamp((g.ammo ?? 1) * 1.25, GUARDRAILS.pace));
    notes.push(
      `ammo: ${(s.ammoOut * 100).toFixed(0)} % of battles ran out of ammunition → ammo ×1.25 (now ×${g.ammo})`,
    );
  }
  return { overlay: o, notes };
}

export interface TuneOptions {
  readonly archetypes: readonly string[];
  readonly scenarios: readonly string[];
  readonly iterations: number;
  /** Seeds per pairing while far from the target pace, and once close to it. */
  readonly seeds: number;
  readonly fineSeeds: number;
  readonly profile: string;
  readonly timeLimit: number;
  readonly targets?: TuneTargets;
  readonly start?: BalanceOverlay;
}

export interface Iteration {
  readonly index: number;
  readonly seeds: number;
  readonly overlay: BalanceOverlay;
  readonly stats: IterationStats;
  readonly notes: readonly string[];
  readonly converged: boolean;
}

/** Jobs for one iteration: every archetype pairing (no mirrors) and every scenario, `seeds` each. */
export function iterationJobs(o: TuneOptions, overlay: BalanceOverlay, seeds: number): Job[] {
  const jobs: Job[] = [];
  for (let i = 0; i < o.archetypes.length; i++)
    for (let j = i + 1; j < o.archetypes.length; j++)
      for (let seed = 1; seed <= seeds; seed++)
        jobs.push({
          kind: "match",
          a: o.archetypes[i]!,
          b: o.archetypes[j]!,
          seed,
          profile: o.profile,
          timeLimit: o.timeLimit,
          overlay,
        });
  for (const sc of o.scenarios)
    for (let seed = 1; seed <= seeds; seed++)
      jobs.push({
        kind: "scenario",
        scenario: sc,
        seed,
        profile: o.profile,
        timeLimit: o.timeLimit,
        overlay,
      });
  return jobs;
}

/**
 * The tuning loop. `run` executes a batch of jobs (in parallel in practice); `catalogueFor` gives the
 * catalogue for an overlay (for weapon identification). Stops early once every target is met.
 */
export async function tune(
  o: TuneOptions,
  run: (jobs: Job[]) => Promise<JobResult[]>,
  designs: ReadonlyMap<string, ShipDesign>,
  catalogueFor: (overlay: BalanceOverlay) => PartCatalogue,
  onIteration?: (it: Iteration) => void,
): Promise<Iteration[]> {
  const targets = o.targets ?? DEFAULT_TARGETS;
  let overlay: BalanceOverlay = o.start ?? {};
  let close = false;
  const out: Iteration[] = [];
  for (let i = 0; i < o.iterations; i++) {
    const seeds = close ? o.fineSeeds : o.seeds;
    const results = await run(iterationJobs(o, overlay, seeds));
    const stats = measure(results, designs, catalogueFor(overlay));
    const done = converged(stats, targets) && seeds === o.fineSeeds;
    const next = done ? { overlay, notes: ["all targets met"] } : adjust(overlay, stats, targets);
    // Nothing left to adjust although a target is missed (e.g. at a guardrail): stop, the rest is manual.
    const stalled = !done && next.notes.length === 0 && seeds === o.fineSeeds;
    if (stalled) next.notes.push("stalled: targets missed but no rule applies (guardrail or design issue)");
    const it: Iteration = { index: i + 1, seeds, overlay, stats, notes: next.notes, converged: done };
    out.push(it);
    onIteration?.(it);
    if (done || stalled) break;
    close =
      Math.abs(Math.log(targets.engagement / Math.max(1, stats.medianEngagement))) < Math.log(1.4) ||
      converged(stats, targets);
    overlay = next.overlay;
  }
  return out;
}
