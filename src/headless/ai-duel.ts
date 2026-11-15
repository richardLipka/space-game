import type { AiProfile } from "../data/schemas/ai";
import type { SkirmishShip } from "../sim/scenario/skirmish";
import type { Job, JobResult } from "./jobs";
import type { BattleMetrics } from "./observe";
import { engagementOf, median } from "./tune";

/**
 * AI duel harness (docs/ai-types.md): two identical fleets, one flown by AI parameter set A and one by B,
 * over seeded battles with A on each side in turn (so neither gains from its spawn). Used to compare AI
 * profiles and doctrines and to tune their parameters.
 */

export interface DuelOptions {
  /** Design ids of one side; the other side flies the same ships. */
  readonly fleet: readonly string[];
  readonly a: AiProfile;
  readonly b: AiProfile;
  readonly seeds: number;
  /** Distance between the fleets at the start (m). */
  readonly distance: number;
  readonly timeLimit: number;
  /** Seed offset, so a confirmation round sees fresh battles. */
  readonly round?: number;
}

const side = (fleet: readonly string[], profile: AiProfile): SkirmishShip[] =>
  fleet.map((designId) => ({ designId, pilot: "aggressive", profile }));

/** Battles of a duel: per seed one with A as side 0 and one with A as side 1 (labels "duel|A0|seed"). */
export function duelJobs(o: DuelOptions, tag = "duel"): Job[] {
  const jobs: Job[] = [];
  for (let k = 1; k <= o.seeds; k++) {
    const seed = (o.round ?? 0) * 1000 + k;
    for (const aSide of [0, 1] as const) {
      const sides: [SkirmishShip[], SkirmishShip[]] =
        aSide === 0 ? [side(o.fleet, o.a), side(o.fleet, o.b)] : [side(o.fleet, o.b), side(o.fleet, o.a)];
      jobs.push({
        kind: "skirmish",
        label: `${tag}|A${aSide}|${seed}`,
        setup: { sides, distance: o.distance },
        seed,
        timeLimit: o.timeLimit,
        overlay: {},
        jitter: { position: 200, angle: 10 },
        stopWhenDisarmed: true,
      });
    }
  }
  return jobs;
}

export interface DuelResult {
  readonly battles: number;
  readonly winsA: number;
  readonly winsB: number;
  readonly draws: number;
  /** Ships each AI lost, on average per battle. */
  readonly lostA: number;
  readonly lostB: number;
  /** Median fight length (first hit to end, s). */
  readonly length: number;
  /** Share of alive time A's and B's ships spent firing. */
  readonly fireA: number;
  readonly fireB: number;
  readonly missiles: { launched: number; down: number; hits: number };
  /** A's score: win share (draws count half) plus a little for ships lost by B rather than A. */
  readonly score: number;
}

export function summarize(results: readonly JobResult[], fleetSize: number, tag = "duel"): DuelResult {
  let winsA = 0;
  let winsB = 0;
  let draws = 0;
  let lostA = 0;
  let lostB = 0;
  let aliveA = 0;
  let aliveB = 0;
  let fireA = 0;
  let fireB = 0;
  const lengths: number[] = [];
  const missiles = { launched: 0, down: 0, hits: 0 };
  let n = 0;
  for (const r of results) {
    if (r.kind !== "skirmish" || !r.result.label.startsWith(`${tag}|`)) continue;
    const aSide = r.result.label.split("|")[1] === "A0" ? "a" : "b";
    const m: BattleMetrics = r.result.metrics;
    n++;
    if (m.winner === "draw") draws++;
    else if (m.winner === aSide) winsA++;
    else winsB++;
    for (const s of m.ships) {
      const isA = s.side === aSide;
      if (s.defeated) {
        if (isA) lostA++;
        else lostB++;
      }
      if (isA) {
        aliveA += s.alive;
        fireA += s.firing;
      } else {
        aliveB += s.alive;
        fireB += s.firing;
      }
    }
    lengths.push(engagementOf(m));
    missiles.launched += m.missiles.launched;
    missiles.down += m.missiles.down;
    missiles.hits += m.missiles.hits;
  }
  const d = Math.max(1, n);
  const win = (winsA + draws / 2) / d;
  return {
    battles: n,
    winsA,
    winsB,
    draws,
    lostA: lostA / d,
    lostB: lostB / d,
    length: median(lengths.sort((x, y) => x - y)),
    fireA: aliveA > 0 ? fireA / aliveA : 0,
    fireB: aliveB > 0 ? fireB / aliveB : 0,
    missiles,
    score: win + (0.1 * (lostB - lostA)) / d / Math.max(1, fleetSize),
  };
}

/** Numeric parameters of a profile the tuner may change ("weights.evade" for behaviour weights). */
export const TUNABLE: Readonly<Record<string, readonly [min: number, max: number]>> = {
  rangeFactor: [0.2, 1.5],
  maxSpeed: [40, 400],
  orbitSpeed: [0, 150],
  retreatHp: [0, 0.6],
  minHitProbability: [0.02, 0.6],
  volleyInterval: [1, 30],
  preferWeakened: [0, 2],
  passSpeed: [80, 500],
  passOffset: [0, 2000],
  passTurnDistance: [1000, 10000],
  formationSpacing: [40, 800],
  standoffFactor: [0.3, 1.2],
  salvoInterval: [4, 40],
  "weights.approach": [0, 3],
  "weights.hold": [0, 3],
  "weights.broadside": [0, 3],
  "weights.face": [0, 3],
  "weights.evade": [0, 3],
  "weights.retreat": [0, 3],
  "weights.cool": [0, 3],
};

export function getParam(p: AiProfile, key: string): number | undefined {
  if (key.startsWith("weights.")) return p.weights[key.slice(8) as keyof AiProfile["weights"]];
  return (p as unknown as Record<string, number | undefined>)[key];
}

export function setParam(p: AiProfile, key: string, v: number): AiProfile {
  const [lo, hi] = TUNABLE[key] ?? [-Infinity, Infinity];
  const x = Number(Math.min(hi, Math.max(lo, v)).toPrecision(4));
  if (key.startsWith("weights.")) return { ...p, weights: { ...p.weights, [key.slice(8)]: x } };
  return { ...p, [key]: x };
}

/** Parameters worth tuning for a profile: the general ones and those of its doctrine. */
export function defaultParams(p: AiProfile): string[] {
  const common = ["rangeFactor", "maxSpeed", "minHitProbability", "retreatHp", "weights.evade"];
  if (p.doctrine === "pass")
    return [...common, "passSpeed", "passOffset", "passTurnDistance", "formationSpacing"];
  if (p.doctrine === "missile-line")
    return [...common, "standoffFactor", "salvoInterval", "formationSpacing", "orbitSpeed"];
  return [...common, "orbitSpeed", "volleyInterval", "weights.broadside", "weights.approach"];
}

/** Seeded random numbers (mulberry32) for reproducible tuning. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A candidate near `p`: each listed parameter scaled by e^(N(0, σ)) (or nudged, for values near 0). */
export function mutate(p: AiProfile, keys: readonly string[], random: () => number, sigma = 0.25): AiProfile {
  let q = p;
  for (const k of keys) {
    if (random() > 0.6) continue;
    const g = Math.sqrt(-2 * Math.log(Math.max(1e-9, random()))) * Math.cos(2 * Math.PI * random());
    const v = getParam(q, k);
    const [lo, hi] = TUNABLE[k] ?? [0, 1];
    const base = v === undefined ? (lo + hi) / 2 : v;
    q = setParam(
      q,
      k,
      Math.abs(base) < (hi - lo) * 0.05 ? base + g * sigma * (hi - lo) * 0.2 : base * Math.exp(g * sigma),
    );
  }
  return q;
}
