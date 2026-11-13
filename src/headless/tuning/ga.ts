import type { Evaluation } from "./fitness";
import { decode, encode, startParams, type Gene, type Params } from "./genome";

/**
 * Genetic algorithm over the tuned parameters. A genome (DNA) is one number in [0, 1] per gene (see
 * genome.ts). Each generation every individual fights the matchups on that generation's seeds; elites
 * carry over and are measured again on the new seeds, so their score is an average over more battles and a
 * lucky set of seeds does not keep a poor genome on top. Everything here is pure and seeded: the state is
 * plain JSON, saved after every generation, and a run resumed from it continues exactly.
 */

export interface GaOptions {
  readonly population: number;
  /** Best individuals carried over unchanged (and re-measured). */
  readonly elite: number;
  /** Tournament size for parent selection. */
  readonly tournament: number;
  /** Chance a child blends its parents (otherwise it copies the first). */
  readonly crossover: number;
  /** Chance each gene mutates, and the mutation's standard deviation in range units (start, floor). */
  readonly mutationRate: number;
  readonly sigma: number;
  readonly sigmaMin: number;
  /** Per-generation decay of sigma. */
  readonly sigmaDecay: number;
  /** Fresh random individuals per generation (keeps the search from collapsing). */
  readonly immigrants: number;
  /** Battles per matchup per individual per generation. */
  readonly seeds: number;
  /** Elites need this many measurements before they count as the run's best. */
  readonly minEvals: number;
}

export const DEFAULT_GA: GaOptions = {
  population: 16,
  elite: 3,
  tournament: 3,
  crossover: 0.7,
  mutationRate: 0.3,
  sigma: 0.12,
  sigmaMin: 0.03,
  sigmaDecay: 0.95,
  immigrants: 1,
  seeds: 3,
  minEvals: 2,
};

/** Summary of an evaluation kept with an individual (the battles themselves are not stored). */
export interface Measured {
  readonly loss: number;
  readonly parts: Readonly<Record<string, number>>;
  readonly inBand: number;
  readonly medians: Readonly<Record<string, number>>;
  readonly timeouts: Readonly<Record<string, number>>;
}

export interface Individual {
  readonly id: number;
  readonly dna: readonly number[];
  /** How it was made: "start", "seed", "elite", "child of 12×40", "immigrant". */
  readonly origin: string;
  readonly born: number;
  lossSum: number;
  evals: number;
  last: Measured | null;
}

export interface GenerationLog {
  readonly generation: number;
  readonly best: number;
  readonly bestId: number;
  readonly median: number;
  readonly sigma: number;
  readonly battles: number;
  readonly seconds: number;
}

export interface GaState {
  readonly version: 1;
  readonly options: GaOptions;
  readonly genes: readonly Gene[];
  generation: number;
  rng: number;
  nextId: number;
  population: Individual[];
  /** Best individual so far with at least minEvals measurements (a copy). */
  best: Individual | null;
  history: GenerationLog[];
  /** Wall-clock seconds spent so far (over all sessions of the run). */
  elapsed: number;
}

// ---------- seeded random numbers (mulberry32; the state is one integer) ----------

export function nextRandom(state: { rng: number }): number {
  state.rng = (state.rng + 0x6d2b79f5) | 0;
  let t = state.rng;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function gaussian(s: { rng: number }): number {
  const u = Math.max(1e-12, nextRandom(s));
  const v = nextRandom(s);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

export const meanLoss = (i: Individual) => (i.evals > 0 ? i.lossSum / i.evals : Infinity);

export const summarise = (e: Evaluation): Measured => ({
  loss: e.loss,
  parts: e.parts,
  inBand: e.inBand,
  medians: Object.fromEntries(e.matchups.map((m) => [m.id, Math.round(m.median)])),
  timeouts: Object.fromEntries(e.matchups.map((m) => [m.id, m.timeouts])),
});

export const sigmaAt = (o: GaOptions, generation: number) =>
  Math.max(o.sigmaMin, o.sigma * Math.pow(o.sigmaDecay, generation));

function mutate(s: GaState, dna: readonly number[], sigma: number, rate: number): number[] {
  return dna.map((x) => (nextRandom(s) < rate ? clamp01(x + gaussian(s) * sigma) : x));
}

/**
 * A new run. The first individual is `start` (default: the game's current values), a few more are close
 * mutations of it, the rest spread wider, so the search starts around what the game has now.
 */
export function initialState(
  genes: readonly Gene[],
  options: GaOptions,
  seed = 1,
  start: Params = startParams(genes),
): GaState {
  const s: GaState = {
    version: 1,
    options,
    genes,
    generation: 0,
    rng: seed | 0,
    nextId: 0,
    population: [],
    best: null,
    history: [],
    elapsed: 0,
  };
  const base = encode(genes, start);
  const add = (dna: number[], origin: string) =>
    s.population.push({ id: s.nextId++, dna, origin, born: 0, lossSum: 0, evals: 0, last: null });
  add(base, "start");
  for (let i = 1; i < options.population; i++) {
    const wide = i >= options.population / 2;
    add(mutate(s, base, wide ? 0.3 : options.sigma, wide ? 0.8 : 0.5), wide ? "seed (wide)" : "seed");
  }
  return s;
}

function tournament(s: GaState, ranked: readonly Individual[]): Individual {
  let best: Individual | null = null;
  for (let i = 0; i < s.options.tournament; i++) {
    const c = ranked[Math.floor(nextRandom(s) * ranked.length)]!;
    if (!best || meanLoss(c) < meanLoss(best)) best = c;
  }
  return best!;
}

/** Blend crossover (BLX-0.3): each gene drawn from a range a little wider than the parents' values. */
function blend(s: GaState, a: readonly number[], b: readonly number[]): number[] {
  return a.map((x, i) => {
    const y = b[i]!;
    const lo = Math.min(x, y);
    const d = Math.abs(x - y);
    return clamp01(lo - 0.3 * d + nextRandom(s) * 1.6 * d);
  });
}

/** Records one generation's measurements (in population order) and updates the best individual. */
export function record(s: GaState, evals: readonly Evaluation[], battles: number, seconds: number): void {
  s.population.forEach((ind, i) => {
    const e = evals[i]!;
    ind.lossSum += e.loss;
    ind.evals++;
    ind.last = summarise(e);
  });
  const ranked = [...s.population].sort((a, b) => meanLoss(a) - meanLoss(b));
  // The best is re-ranked every generation: an elite measured again may turn out worse than it looked.
  // One that has left the population keeps its last average.
  const candidates = ranked.filter((i) => i.evals >= s.options.minEvals);
  if (s.best && !s.population.some((i) => i.id === s.best!.id)) candidates.push(s.best);
  candidates.sort((a, b) => meanLoss(a) - meanLoss(b));
  if (candidates[0]) s.best = structuredClone(candidates[0]);
  s.elapsed += seconds;
  s.history.push({
    generation: s.generation,
    best: meanLoss(ranked[0]!),
    bestId: ranked[0]!.id,
    median: meanLoss(ranked[ranked.length >> 1]!),
    sigma: sigmaAt(s.options, s.generation),
    battles,
    seconds,
  });
}

/** Breeds the next generation from the measured one. */
export function breed(s: GaState): void {
  const o = s.options;
  const ranked = [...s.population].sort((a, b) => meanLoss(a) - meanLoss(b));
  const g = s.generation + 1;
  const sigma = sigmaAt(o, g);
  const next: Individual[] = ranked.slice(0, o.elite).map((e) => ({ ...e, origin: "elite" }));
  const make = (dna: number[], origin: string): Individual => ({
    id: s.nextId++,
    dna,
    origin,
    born: g,
    lossSum: 0,
    evals: 0,
    last: null,
  });
  for (let i = 0; i < o.immigrants && next.length < o.population; i++)
    next.push(
      make(
        s.genes.map(() => nextRandom(s)),
        "immigrant",
      ),
    );
  while (next.length < o.population) {
    const a = tournament(s, ranked);
    const b = tournament(s, ranked);
    const cross = a.id !== b.id && nextRandom(s) < o.crossover;
    const dna = mutate(s, cross ? blend(s, a.dna, b.dna) : a.dna, sigma, o.mutationRate);
    next.push(make(dna, cross ? `child of ${a.id}×${b.id}` : `mutant of ${a.id}`));
  }
  s.population = next;
  s.generation = g;
}

export const paramsOf = (s: GaState, i: Individual): Params => decode(s.genes, i.dna);
