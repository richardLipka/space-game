import { BALANCE, type Balance } from "../../data/balance/model";
import type { BalanceOverlay } from "../../data/balance/overlay";

/**
 * The tuned parameters ("genes") of the simulation and how a vector of numbers ("DNA") maps to a balance
 * parameter table and an overlay. Every gene has a range; the DNA holds each gene's position in its range
 * as a number in [0, 1] (on a log scale for log genes), so mutation and crossover treat all genes alike.
 *
 * A gene's target is one of
 * - `balance:<path>`      a number in the balance model table (src/data/balance/model.ts), e.g.
 *                         `balance:heat.perKgFuel`;
 * - `balance:<path>.*`    a factor on every number under that path, e.g. `balance:hp.system.*` scales the hit
 *                         points of every system class (the value is the factor, 1 = unchanged);
 * - `overlay:<path>`      a factor in the balance overlay (src/data/balance/overlay.ts) for numbers the model
 *                         does not derive, e.g. `overlay:weapons.core:weapon.laser.turret.s.damage`.
 *                         The last segment is the field; the one before it is the record key (a part id may
 *                         contain dots, so everything between the first segment and the field is the key).
 */
export interface Gene {
  /** Short name used in reports and on the command line. */
  readonly id: string;
  readonly target: string;
  readonly min: number;
  readonly max: number;
  /** Search on a log scale (for factors and quantities spanning a wide range). */
  readonly log?: boolean;
  /** Starting value (default: the game's current value, or 1 for factors). */
  readonly start?: number;
  /** What it means, for reports. */
  readonly note?: string;
}

/** Parameter values by gene id. */
export type Params = Record<string, number>;

export interface Variant {
  readonly balance: Balance;
  readonly overlay: BalanceOverlay;
}

const isFactor = (g: Gene) => g.target.startsWith("overlay:") || g.target.endsWith(".*");

/** Reads a number from the balance table by dotted path. */
export function balanceValue(path: string, b: Balance = BALANCE): number {
  let o: unknown = b;
  for (const k of path.split(".")) o = (o as Record<string, unknown> | undefined)?.[k];
  if (typeof o !== "number") throw new Error(`No number at balance path "${path}"`);
  return o;
}

/** The value a gene has in the game as it is now. */
export function currentValue(g: Gene): number {
  if (isFactor(g)) return 1;
  return balanceValue(g.target.slice("balance:".length));
}

export const startValue = (g: Gene) => g.start ?? currentValue(g);

export function checkGenes(genes: readonly Gene[]): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const g of genes) {
    if (ids.has(g.id)) errors.push(`Duplicate gene "${g.id}"`);
    ids.add(g.id);
    if (!(g.min < g.max)) errors.push(`Gene "${g.id}": min must be below max`);
    if (g.log && g.min <= 0) errors.push(`Gene "${g.id}": a log gene needs min > 0`);
    if (!/^(balance|overlay):/.test(g.target)) errors.push(`Gene "${g.id}": unknown target "${g.target}"`);
    else if (g.target.startsWith("balance:") && !g.target.endsWith(".*"))
      try {
        balanceValue(g.target.slice(8));
      } catch (e) {
        errors.push(`Gene "${g.id}": ${(e as Error).message}`);
      }
    else if (g.target.startsWith("overlay:") && g.target.split(".").length < 2)
      errors.push(`Gene "${g.id}": overlay target needs a field`);
    try {
      const s = startValue(g);
      if (s < g.min || s > g.max) errors.push(`Gene "${g.id}": start ${s} outside [${g.min}, ${g.max}]`);
    } catch {
      // reported above
    }
  }
  return errors;
}

// ---------- DNA ⇄ values ----------

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

export function toUnit(g: Gene, v: number): number {
  const x = Math.min(g.max, Math.max(g.min, v));
  return g.log ? Math.log(x / g.min) / Math.log(g.max / g.min) : (x - g.min) / (g.max - g.min);
}

/** A gene's value at position u in its range, rounded to 6 significant digits (enough to keep the game's own values). */
export function fromUnit(g: Gene, u: number): number {
  const t = clamp01(u);
  const v = g.log ? g.min * Math.pow(g.max / g.min, t) : g.min + (g.max - g.min) * t;
  return Number(v.toPrecision(6));
}

export const encode = (genes: readonly Gene[], p: Params): number[] =>
  genes.map((g) => toUnit(g, p[g.id] ?? startValue(g)));

export function decode(genes: readonly Gene[], dna: readonly number[]): Params {
  const p: Params = {};
  genes.forEach((g, i) => (p[g.id] = fromUnit(g, dna[i] ?? toUnit(g, startValue(g)))));
  return p;
}

export function startParams(genes: readonly Gene[]): Params {
  const p: Params = {};
  for (const g of genes) p[g.id] = startValue(g);
  return p;
}

// ---------- values → balance table and overlay ----------

type Mutable = Record<string, unknown>;

function scaleAll(o: Mutable, k: number): void {
  for (const [key, v] of Object.entries(o)) {
    if (typeof v === "number") o[key] = v * k;
    else if (v && typeof v === "object") scaleAll(v as Mutable, k);
  }
}

/** The balance table and overlay a set of parameter values describes (genes missing from `p` keep start). */
export function variant(genes: readonly Gene[], p: Params): Variant {
  const balance = structuredClone(BALANCE) as unknown as Mutable;
  const overlay: Mutable = {};
  // Plain values first, then factors, so `hp.*` scales a value another gene has set.
  const ordered = [...genes].sort((a, b) => Number(isFactor(a)) - Number(isFactor(b)));
  for (const g of ordered) {
    const v = p[g.id] ?? startValue(g);
    if (g.target.startsWith("balance:")) {
      const path = g.target.slice(8);
      if (path.endsWith(".*")) {
        let o = balance;
        for (const k of path.slice(0, -2).split(".").filter(Boolean)) o = o[k] as Mutable;
        scaleAll(o, v);
      } else {
        const keys = path.split(".");
        let o = balance;
        for (const k of keys.slice(0, -1)) o = o[k] as Mutable;
        o[keys[keys.length - 1]!] = v;
      }
    } else {
      const rest = g.target.slice(8);
      const first = rest.indexOf(".");
      const last = rest.lastIndexOf(".");
      const section = rest.slice(0, first);
      const field = rest.slice(last + 1);
      if (section === "global") {
        const s = (overlay.global ??= {}) as Mutable;
        s[field] = ((s[field] as number | undefined) ?? 1) * v;
      } else {
        const key = rest.slice(first + 1, last);
        const s = (overlay[section] ??= {}) as Mutable;
        const e = (s[key] ??= {}) as Mutable;
        e[field] = ((e[field] as number | undefined) ?? 1) * v;
      }
    }
  }
  return { balance: balance as unknown as Balance, overlay: overlay as BalanceOverlay };
}

/** Gene values that differ from the game's current ones, for reports ("id: current → value"). */
export function changes(genes: readonly Gene[], p: Params): string[] {
  return genes
    .filter((g) => Math.abs((p[g.id] ?? currentValue(g)) / currentValue(g) - 1) > 1e-6)
    .map((g) => `${g.id}: ${currentValue(g)} → ${p[g.id]}`);
}
