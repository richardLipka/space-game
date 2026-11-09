import { STANCES, type StanceId, type StanceParamKey } from "../data/ai/stances";
import type { Scenario } from "../data/schemas/scenario";
import type { SkirmishSetup, SkirmishShip } from "../sim/scenario/skirmish";
import type { Job, JobResult } from "./jobs";
import { engagementOf, median } from "./tune";

/**
 * AI type study: the symmetric scenarios' fleets fought AI against AI.
 * - Matrix: every pair of AI types (whole side one type), both sides swapped by the pairing itself.
 * - Sweeps: one parameter of one type at a time against the same type at its defaults, sides swapped.
 * Results: win rate of the row/variant, median fight length (first hit to end) and timeouts.
 */
export const TYPES: readonly StanceId[] = ["aggressive", "defensive", "retreating", "cautious"];

/** A whole side flown by one AI type. Defensive ships guard the side's first ship (which guards the second). */
export function sideOf(
  fleet: readonly string[],
  type: StanceId,
  params?: Partial<Record<StanceParamKey, number>>,
): SkirmishShip[] {
  return fleet.map((designId, i) => ({
    designId,
    pilot: type,
    params,
    guard: type === "defensive" ? (i === 0 ? (fleet.length > 1 ? 1 : undefined) : 0) : undefined,
  }));
}

export interface StudyOptions {
  readonly scenarios: readonly Scenario[];
  readonly seeds: number;
  readonly timeLimit: number;
}

const setupOf = (sc: Scenario, a: SkirmishShip[], b: SkirmishShip[]): SkirmishSetup => ({
  sides: [a, b],
  distance: 5000,
});

export function matrixJobs(o: StudyOptions): Job[] {
  const jobs: Job[] = [];
  for (const sc of o.scenarios) {
    const fleet = sc.referenceDesigns ?? [];
    for (const x of TYPES)
      for (const y of TYPES)
        for (let seed = 1; seed <= o.seeds; seed++)
          jobs.push({
            kind: "skirmish",
            label: `matrix|${sc.id}|${x}|${y}`,
            setup: setupOf(sc, sideOf(fleet, x), sideOf(fleet, y)),
            arenaFrom: sc.id,
            seed,
            timeLimit: o.timeLimit,
            overlay: {},
          });
  }
  return jobs;
}

/** Sweep values for a parameter: four points spread over its range (the default is the reference). */
export function sweepValues(min: number, max: number, step: number): number[] {
  const n = 4;
  const out = new Set<number>();
  for (let i = 0; i < n; i++) out.add(Math.round((min + ((max - min) * i) / (n - 1)) / step) * step);
  return [...out].map((v) => Math.round(v * 1000) / 1000);
}

export function sweepJobs(o: StudyOptions, types: readonly StanceId[] = TYPES): Job[] {
  const jobs: Job[] = [];
  for (const t of types) {
    const def = STANCES.find((s) => s.id === t)!;
    for (const p of def.params)
      for (const v of sweepValues(p.min, p.max, p.step))
        for (const sc of o.scenarios) {
          const fleet = sc.referenceDesigns ?? [];
          const variant = sideOf(fleet, t, { [p.key]: v });
          const base = sideOf(fleet, t);
          for (let seed = 1; seed <= o.seeds; seed++)
            for (const swap of [false, true])
              jobs.push({
                kind: "skirmish",
                label: `sweep|${t}|${p.key}|${v}|${sc.id}|${swap ? "b" : "a"}`,
                setup: swap ? setupOf(sc, base, variant) : setupOf(sc, variant, base),
                arenaFrom: sc.id,
                seed,
                timeLimit: o.timeLimit,
                overlay: {},
              });
        }
  }
  return jobs;
}

export interface Cell {
  readonly games: number;
  /** Wins of the row (matrix) or of the variant (sweep); a draw counts half. */
  readonly score: number;
  readonly timeouts: number;
  readonly medianTime: number;
}

const cell = (rows: { won: number; time: number; draw: boolean }[]): Cell => ({
  games: rows.length,
  score: rows.length ? rows.reduce((n, r) => n + r.won, 0) / rows.length : 0,
  timeouts: rows.length ? rows.filter((r) => r.draw).length / rows.length : 0,
  medianTime: median(rows.map((r) => r.time)),
});

export interface StudyReport {
  /** matrix[scenario][row type][column type] and the all-scenario total under "all". */
  readonly matrix: Record<string, Record<string, Record<string, Cell>>>;
  /** sweep[type][param][value] over all scenarios. */
  readonly sweep: Record<string, Record<string, Record<string, Cell>>>;
}

export function analyse(results: readonly JobResult[]): StudyReport {
  const mx: Record<
    string,
    Record<string, Record<string, { won: number; time: number; draw: boolean }[]>>
  > = {};
  const sw: Record<
    string,
    Record<string, Record<string, { won: number; time: number; draw: boolean }[]>>
  > = {};
  for (const r of results) {
    if (r.kind !== "skirmish") continue;
    const m = r.result.metrics;
    const parts = r.result.label.split("|");
    const time = engagementOf(m);
    const draw = m.winner === "draw";
    if (parts[0] === "matrix") {
      const [, sc, x, y] = parts as [string, string, string, string];
      const won = draw ? 0.5 : m.winner === "a" ? 1 : 0;
      for (const key of [sc, "all"]) (((mx[key] ??= {})[x] ??= {})[y] ??= []).push({ won, time, draw });
    } else {
      const [, t, p, v, , side] = parts as [string, string, string, string, string, string];
      const variantWon = side === "a" ? m.winner === "a" : m.winner === "b";
      const won = draw ? 0.5 : variantWon ? 1 : 0;
      (((sw[t] ??= {})[p] ??= {})[v] ??= []).push({ won, time, draw });
    }
  }
  const map3 = (o: typeof mx) =>
    Object.fromEntries(
      Object.entries(o).map(([a, b]) => [
        a,
        Object.fromEntries(
          Object.entries(b).map(([c, d]) => [
            c,
            Object.fromEntries(Object.entries(d).map(([e, f]) => [e, cell(f)])),
          ]),
        ),
      ]),
    );
  return { matrix: map3(mx), sweep: map3(sw) };
}

/** Recommended value per swept parameter: the best-scoring value whose fights still end in time. */
export function recommend(rep: StudyReport): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const [t, params] of Object.entries(rep.sweep))
    for (const [p, values] of Object.entries(params)) {
      let best: [number, number] | null = null;
      for (const [v, c] of Object.entries(values)) {
        // Penalise variants that stall battles (timeouts) so "win by never engaging" does not look best.
        const score = c.score - 0.5 * c.timeouts;
        if (!best || score > best[1]) best = [Number(v), score];
      }
      if (best) (out[t] ??= {})[p] = best[0];
    }
  return out;
}

export function studyMarkdown(rep: StudyReport, rec: Record<string, Record<string, number>>): string {
  const pct = (x: number) => `${Math.round(x * 100)} %`;
  const lines: string[] = [];
  const all = rep.matrix["all"];
  if (all) {
    lines.push("### Type against type (all mirror scenarios)", "");
    lines.push(
      "Row type's score against the column type (win = 1, draw = ½), median fight length, timeouts.",
      "",
    );
    lines.push(`| row \\ column | ${TYPES.join(" | ")} |`, `|---|${TYPES.map(() => "---").join("|")}|`);
    for (const x of TYPES)
      lines.push(
        `| ${x} | ${TYPES.map((y) => {
          const c = all[x]?.[y];
          return c ? `${pct(c.score)} · ${c.medianTime.toFixed(0)} s · ${pct(c.timeouts)} t/o` : "–";
        }).join(" | ")} |`,
      );
    lines.push("");
  }
  for (const [t, params] of Object.entries(rep.sweep)) {
    lines.push(`### ${t}: parameter sweeps (variant vs ${t} at defaults)`, "");
    lines.push("| parameter | values (score · median s · timeouts) | best |", "|---|---|---|");
    for (const [p, values] of Object.entries(params))
      lines.push(
        `| ${p} | ${Object.entries(values)
          .sort((a, b) => Number(a[0]) - Number(b[0]))
          .map(([v, c]) => `${v}: ${pct(c.score)} · ${c.medianTime.toFixed(0)} · ${pct(c.timeouts)}`)
          .join("; ")} | ${rec[t]?.[p] ?? "–"} |`,
      );
    lines.push("");
  }
  return lines.join("\n");
}
