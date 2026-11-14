import type { SkirmishShip } from "../../sim/scenario/skirmish";
import type { Job, JobResult } from "../jobs";
import type { BattleMetrics } from "../observe";
import { engagementOf, median } from "../tune";
import { limitOf, type Matchup, type TuningConfig } from "./config";
import { encode, startParams, type Params, variant } from "./genome";
import { references, viability, type Margins, type ViabilityResult } from "./viability";
import { checkRules, rulesLoss, runsOf, TUNING_TESTS, type RuleResult } from "./tests";

/**
 * Measuring a parameter set: every matchup fought `seeds` times, the fight lengths compared with the
 * matchup's band, and one loss number for the whole set (lower is better, 0 = every matchup on target
 * with no timeouts). Pure apart from the injected battle runner.
 */

export interface MatchupStats {
  readonly id: string;
  readonly battles: number;
  /** Fight lengths (s, first hit to the end; a timeout counts as the time limit), sorted. */
  readonly lengths: readonly number[];
  readonly median: number;
  /** Interquartile range over the median. */
  readonly spread: number;
  readonly band: readonly [number, number];
  readonly target: number;
  readonly inBand: boolean;
  readonly timeouts: number;
  readonly ammoOut: number;
  /** Share won by side A (mirror matches should sit near 0.5). */
  readonly sideA: number;
  /** How battles ended. */
  readonly reasons: Readonly<Record<string, number>>;
  /** Share of fighting time ships spent above 70 % heat, and with weapons short of power. */
  readonly hot: number;
  readonly brownout: number;
  /** Ammunition left at the end (share, both sides). */
  readonly ammoLeft: number;
  readonly missiles: { readonly launched: number; readonly down: number; readonly hits: number };
  /** This matchup's term in the loss. */
  readonly loss: number;
}

export interface Evaluation {
  readonly params: Params;
  readonly loss: number;
  /** Loss parts: length error, timeouts, ammunition, spread, drift, viability, balance rules. */
  readonly parts: Readonly<Record<string, number>>;
  readonly matchups: readonly MatchupStats[];
  readonly inBand: number;
  /** Why the set was refused without battles (designs left without power or cooling); empty if fought. */
  readonly refused: readonly string[];
  /** Balance rules from the tuning tests (empty when they did not run). */
  readonly rules?: readonly RuleResult[];
  readonly margins: readonly Margins[];
}

const ship = (designId: string, pilot: Matchup["pilot"]): SkirmishShip => ({
  designId,
  pilot: pilot ?? "aggressive",
});

/** Seeds for a round: round r uses seeds r·1000 + 1 … r·1000 + n, so rounds see fresh battles. */
export const seedsFor = (round: number, n: number) =>
  Array.from({ length: n }, (_, i) => round * 1000 + i + 1);

/** Battles for one parameter set (label "<tag>|<matchup>"). */
export function jobsFor(cfg: TuningConfig, p: Params, seeds: readonly number[], tag = "eval"): Job[] {
  const v = variant(cfg.genes, p);
  const jobs: Job[] = [];
  for (const m of cfg.matchups)
    for (const seed of seeds)
      jobs.push({
        kind: "skirmish",
        label: `${tag}|${m.id}`,
        setup: {
          sides: [m.sides[0].map((d) => ship(d, m.pilot)), m.sides[1].map((d) => ship(d, m.pilot))],
          distance: m.distance ?? 4000,
        },
        seed,
        timeLimit: limitOf(m, cfg),
        overlay: v.overlay,
        balance: v.balance,
        jitter: { position: m.jitter ?? 300, angle: 25 },
        stopWhenDisarmed: true,
      });
  return jobs;
}

/** Tuning-test runs for one parameter set (none when the rules' weight is 0). */
export function testJobsFor(cfg: TuningConfig, p: Params, tag = "eval"): Job[] {
  if (cfg.rules.weight <= 0) return [];
  const v = variant(cfg.genes, p);
  return TUNING_TESTS.flatMap((t) =>
    Array.from({ length: runsOf(t, cfg.rules.runs) }, (_, k): Job => ({
      kind: "test",
      label: `${tag}|test|${t.scenario.id}`,
      test: t.scenario.id,
      seed: k + 1,
      overlay: v.overlay,
      balance: v.balance,
    })),
  );
}

/** The rules from a set's test results (empty when there are none). */
export function rulesOf(results: readonly JobResult[]): RuleResult[] {
  const sums = new Map<string, { s: number; n: number }>();
  for (const r of results) {
    if (r.kind !== "test") continue;
    const e = sums.get(r.result.test) ?? { s: 0, n: 0 };
    e.s += r.result.value;
    e.n++;
    sums.set(r.result.test, e);
  }
  if (sums.size === 0) return [];
  return checkRules(new Map([...sums].map(([k, e]) => [k, e.s / e.n])));
}

const quantile = (s: readonly number[], q: number) => {
  if (s.length === 0) return 0;
  const i = (s.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return s[lo]! + (s[hi]! - s[lo]!) * (i - lo);
};

/** Length error in log units: 0 inside the band, ln(distance ratio) outside. */
export function bandError(m: number, [lo, hi]: readonly [number, number]): number {
  const x = Math.max(1, m);
  return x < lo ? Math.log(lo / x) : x > hi ? Math.log(x / hi) : 0;
}

export function matchupStats(m: Matchup, metrics: readonly BattleMetrics[], cfg: TuningConfig): MatchupStats {
  const L = cfg.loss;
  const limit = limitOf(m, cfg);
  const lengths = metrics
    .map((x) => (x.winner === "draw" ? limit : Math.min(limit, engagementOf(x))))
    .sort((a, b) => a - b);
  const med = median(lengths);
  const spread = med > 0 ? (quantile(lengths, 0.75) - quantile(lengths, 0.25)) / med : 0;
  const n = Math.max(1, metrics.length);
  const timeouts = metrics.filter((x) => x.winner === "draw").length / n;
  const ammoOut = metrics.filter((x) => x.reason === "timeout-out-of-ammo").length / n;
  const reasons: Record<string, number> = {};
  for (const x of metrics) reasons[x.reason] = (reasons[x.reason] ?? 0) + 1;
  let hot = 0;
  let brown = 0;
  let shipTime = 0;
  for (const x of metrics)
    for (const s of x.ships) {
      hot += s.hot;
      brown += s.brownout;
      shipTime += x.time;
    }
  const target = m.target ?? Math.sqrt(m.band[0] * m.band[1]);
  const err = bandError(med, m.band);
  const centre = Math.log(Math.max(1, med) / target);
  const lengthTerm = err * err + L.centre * centre * centre;
  const loss =
    (m.weight ?? 1) *
    (lengthTerm +
      L.timeouts * Math.max(0, timeouts - L.allowedTimeouts) +
      L.ammoOut * ammoOut +
      L.spread * Math.max(0, spread - L.allowedSpread));
  return {
    id: m.id,
    battles: metrics.length,
    lengths,
    median: med,
    spread,
    band: m.band,
    target,
    inBand: err === 0,
    timeouts,
    ammoOut,
    sideA: (metrics.filter((x) => x.winner === "a").length + 0.5 * timeouts * metrics.length) / n,
    reasons,
    hot: shipTime > 0 ? hot / shipTime : 0,
    brownout: shipTime > 0 ? brown / shipTime : 0,
    ammoLeft: metrics.length ? metrics.reduce((a, x) => a + (x.ammoLeftA + x.ammoLeftB) / 2, 0) / n : 1,
    missiles: metrics.reduce(
      (a, x) => ({
        launched: a.launched + x.missiles.launched,
        down: a.down + x.missiles.down,
        hits: a.hits + x.missiles.hits,
      }),
      { launched: 0, down: 0, hits: 0 },
    ),
    loss,
  };
}

/** Squared distance of the parameters from their starting values, in units of each gene's range. */
export function drift(cfg: TuningConfig, p: Params): number {
  const a = encode(cfg.genes, p);
  const b = encode(cfg.genes, startParams(cfg.genes));
  return a.reduce((s, x, i) => s + (x - b[i]!) ** 2, 0);
}

/** Scores one parameter set from its battles (results whose label is "<tag>|<matchup>"). */
export function evaluate(
  cfg: TuningConfig,
  p: Params,
  results: readonly JobResult[],
  via?: ViabilityResult,
): Evaluation {
  const by = new Map<string, BattleMetrics[]>();
  for (const r of results) {
    if (r.kind !== "skirmish") continue;
    const id = r.result.label.slice(r.result.label.indexOf("|") + 1);
    (by.get(id) ?? by.set(id, []).get(id)!).push(r.result.metrics);
  }
  const matchups = cfg.matchups.map((m) => matchupStats(m, by.get(m.id) ?? [], cfg));
  const rules = rulesOf(results);
  const wsum = cfg.matchups.reduce((s, m) => s + (m.weight ?? 1), 0) || 1;
  const sum = (f: (s: MatchupStats, m: Matchup) => number) =>
    matchups.reduce((a, s, i) => a + f(s, cfg.matchups[i]!), 0) / wsum;
  const parts = {
    length: sum((s, m) => {
      const e = bandError(s.median, m.band);
      const c = Math.log(Math.max(1, s.median) / s.target);
      return (m.weight ?? 1) * (e * e + cfg.loss.centre * c * c);
    }),
    timeouts: sum(
      (s, m) => (m.weight ?? 1) * cfg.loss.timeouts * Math.max(0, s.timeouts - cfg.loss.allowedTimeouts),
    ),
    ammoOut: sum((s, m) => (m.weight ?? 1) * cfg.loss.ammoOut * s.ammoOut),
    spread: sum((s, m) => (m.weight ?? 1) * cfg.loss.spread * Math.max(0, s.spread - cfg.loss.allowedSpread)),
    drift: cfg.loss.drift * drift(cfg, p),
    viability: via?.penalty ?? 0,
    rules: cfg.rules.weight * rulesLoss(rules),
  };
  const loss = Object.values(parts).reduce((a, b) => a + b, 0);
  return {
    params: p,
    loss,
    parts,
    matchups,
    inBand: matchups.filter((m) => m.inBand).length,
    refused: [],
    margins: via?.margins ?? [],
    rules,
  };
}

/** A set refused before any battle: its loss is the refusal plus how far short its designs fall. */
export function refusedEvaluation(cfg: TuningConfig, p: Params, via: ViabilityResult): Evaluation {
  const parts = { viability: cfg.viability.refusedLoss + via.penalty, drift: cfg.loss.drift * drift(cfg, p) };
  return {
    params: p,
    loss: parts.viability + parts.drift,
    parts,
    matchups: [],
    inBand: 0,
    refused: via.refused,
    margins: via.margins,
  };
}

const refs = new WeakMap<TuningConfig, Map<string, Margins>>();
/** The designs' margins under the start values, measured once per config. */
export function referenceMargins(cfg: TuningConfig): Map<string, Margins> {
  let r = refs.get(cfg);
  if (!r) refs.set(cfg, (r = references(cfg)));
  return r;
}

/** Runs and scores several parameter sets on the same seeds (one batch, so all threads stay busy). */
export async function evaluateMany(
  cfg: TuningConfig,
  sets: readonly Params[],
  seeds: readonly number[],
  run: (jobs: Job[]) => Promise<JobResult[]>,
): Promise<Evaluation[]> {
  const ref = referenceMargins(cfg);
  const via = sets.map((p) => viability(cfg, p, ref));
  const jobs = sets.flatMap((p, i) =>
    via[i]!.refused.length ? [] : [...jobsFor(cfg, p, seeds, `p${i}`), ...testJobsFor(cfg, p, `p${i}`)],
  );
  const results = jobs.length ? await run(jobs) : [];
  return sets.map((p, i) =>
    via[i]!.refused.length
      ? refusedEvaluation(cfg, p, via[i]!)
      : evaluate(
          cfg,
          p,
          results.filter(
            (r) => (r.kind === "skirmish" || r.kind === "test") && r.result.label.startsWith(`p${i}|`),
          ),
          via[i],
        ),
  );
}
