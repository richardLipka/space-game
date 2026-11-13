import { BALANCE, deriveCatalogue, type Balance } from "../../data/balance/model";
import { applyOverlay } from "../../data/balance/overlay";
import type { Catalogue } from "../../data/schemas/part";
import { type Gene, type Params, variant } from "./genome";

/**
 * Accepting a tuning result: the balance table's changed numbers written into the model's source text
 * (src/data/balance/model.ts, comments and layout kept), and the catalogue derived from the new table with
 * the overlay's factors applied to the numbers the model does not derive (weapon damage).
 */

/** Rounds to 4 significant digits, the precision written into the source. */
const sig4 = (v: number) => Number(v.toPrecision(4));

/** Every number in the table that differs from the game's, by dotted path (rounded as written). */
export function balanceChanges(b: Balance, ref: Balance = BALANCE): Map<string, number> {
  const out = new Map<string, number>();
  const walk = (x: unknown, y: unknown, path: string) => {
    if (typeof x === "number") {
      const v = sig4(x);
      if (v !== y) out.set(path, v);
    } else if (x && typeof x === "object")
      for (const k of Object.keys(x))
        walk(
          (x as Record<string, unknown>)[k],
          (y as Record<string, unknown>)?.[k],
          path ? `${path}.${k}` : k,
        );
  };
  walk(b, ref, "");
  return out;
}

/** A number as the model's source writes it (digit groups for large whole numbers). */
export function formatNumber(v: number): string {
  if (Number.isInteger(v) && Math.abs(v) >= 10_000) return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, "_");
  return String(v);
}

/**
 * The model source with the given values replaced. Only numbers on their own line (`key: 123,`) inside
 * `export const BALANCE = {` can be written; anything else is reported as not placed.
 */
export function rewriteModel(
  src: string,
  values: ReadonlyMap<string, number>,
): { text: string; missing: string[] } {
  const lines = src.split("\n");
  const stack: string[] = [];
  let inside = false;
  const placed = new Set<string>();
  const unquote = (k: string) => k.replace(/^"|"$/g, "");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!inside) {
      if (/^export const BALANCE = \{\s*$/.test(line)) inside = true;
      continue;
    }
    if (/^\}/.test(line)) break;
    const open = /^\s*("?[\w-]+"?): \{\s*$/.exec(line);
    if (open) {
      stack.push(unquote(open[1]!));
      continue;
    }
    if (/^\s*\}.*,\s*$/.test(line)) {
      stack.pop();
      continue;
    }
    const leaf = /^(\s*)("?[\w-]+"?): (-?[\d_.eE+-]+),(.*)$/.exec(line);
    if (!leaf) continue;
    const path = [...stack, unquote(leaf[2]!)].join(".");
    const v = values.get(path);
    if (v === undefined) continue;
    lines[i] = `${leaf[1]}${leaf[2]}: ${formatNumber(v)},${leaf[4]}`;
    placed.add(path);
  }
  return { text: lines.join("\n"), missing: [...values.keys()].filter((k) => !placed.has(k)) };
}

/** The balance table with the written (rounded) values, as the game will read it after applying. */
export function writtenBalance(values: ReadonlyMap<string, number>): Balance {
  const b = structuredClone(BALANCE) as unknown as Record<string, unknown>;
  for (const [path, v] of values) {
    const keys = path.split(".");
    let o = b;
    for (const k of keys.slice(0, -1)) o = o[k] as Record<string, unknown>;
    o[keys[keys.length - 1]!] = v;
  }
  return b as unknown as Balance;
}

/** Model source and catalogue for accepted parameters, with a readable list of what changed. */
export function applyParams(
  genes: readonly Gene[],
  p: Params,
  modelSource: string,
  catalogue: Catalogue,
): { model: string; catalogue: Catalogue; changes: string[]; missing: string[] } {
  const v = variant(genes, p);
  const values = balanceChanges(v.balance);
  const { text, missing } = rewriteModel(modelSource, values);
  // Overlay factors on numbers the model derives would be undone by the next `balance:derive`.
  for (const s of ["global", "category", "parts"] as const)
    if (v.overlay[s]) missing.push(`overlay ${s} (derived by the model: tune it with a balance: gene)`);
  const derived = deriveCatalogue(catalogue, writtenBalance(values));
  const changes = [...values].map(([k, x]) => {
    let old: unknown = BALANCE;
    for (const s of k.split(".")) old = (old as Record<string, unknown>)[s];
    return `balance ${k}: ${String(old)} → ${x}`;
  });
  for (const [section, rec] of Object.entries(v.overlay))
    changes.push(`overlay ${section}: ${JSON.stringify(rec)}`);
  return { model: text, catalogue: applyOverlay(derived, v.overlay), changes, missing };
}
