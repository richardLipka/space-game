import { BALANCE } from "../../data/balance/model";
import { BUNDLED_DESIGNS } from "../../data/designs/index";
import { designStats } from "../../editor/stats";
import { setRuntimeBalance } from "../../sim/systems/heat";
import { catalogueFor } from "../jobs";
import type { TuningConfig } from "./config";
import { type Params, startParams, variant } from "./genome";

/**
 * Design viability before any battle (docs/tuning.md): the fleet designs a config fights, measured with the
 * editor's own stats under a parameter set. A set that leaves a design with far less power for its weapons
 * or far less cooling than it has today is refused without simulation.
 */

export interface Margins {
  readonly design: string;
  /** Power production ÷ combat demand (weapons, point defense, gyros, hangars). */
  readonly power: number;
  /** Heat dissipation (radiators extended and hull) ÷ heat at full use. */
  readonly cooling: number;
}

export interface ViabilityResult {
  /** Loss term for sets that are not refused. */
  readonly penalty: number;
  /** Why the set is refused ("fleet-spark power 0.41 of 0.86"); empty when it may be fought. */
  readonly refused: readonly string[];
  readonly margins: readonly Margins[];
}

export const designsOf = (cfg: TuningConfig): string[] =>
  [...new Set(cfg.matchups.flatMap((m) => [...m.sides[0], ...m.sides[1]]))].sort();

/** Margins of the designs under parameters `p` (the run-time values are set for the measurement and restored). */
export function margins(
  cfg: TuningConfig,
  p: Params,
  designs: readonly string[] = designsOf(cfg),
): Margins[] {
  const v = variant(cfg.genes, p);
  const cat = catalogueFor(v.overlay, v.balance);
  setRuntimeBalance(v.balance);
  try {
    return designs.map((id) => {
      const d = BUNDLED_DESIGNS.get(id);
      if (!d) throw new Error(`Unknown design ${id}`);
      const s = designStats(d, cat);
      const dm = s.power.demand;
      const demand = dm.weapons + dm.pointDefense + dm.gyro + dm.hangar;
      return {
        design: id,
        power: demand > 0 ? s.power.production / demand : 10,
        cooling: s.heat.generation > 0 ? s.heat.dissipation / s.heat.generation : 10,
      };
    });
  } finally {
    setRuntimeBalance(BALANCE);
  }
}

/** The reference each margin is held to: today's margin, but never more than 1 (enough is enough). */
export function references(cfg: TuningConfig): Map<string, Margins> {
  return new Map(
    margins(cfg, startParams(cfg.genes)).map((m) => [
      m.design,
      { design: m.design, power: Math.min(1, m.power), cooling: Math.min(1, m.cooling) },
    ]),
  );
}

export function viability(cfg: TuningConfig, p: Params, ref: ReadonlyMap<string, Margins>): ViabilityResult {
  const ms = margins(cfg, p, [...ref.keys()]);
  let penalty = 0;
  const refused: string[] = [];
  for (const m of ms) {
    const r = ref.get(m.design)!;
    for (const k of ["power", "cooling"] as const) {
      const share = m[k] / r[k];
      if (share < 1) penalty += (1 - share) ** 2;
      if (share < cfg.viability.refuseBelow)
        refused.push(`${m.design} ${k} ${m[k].toFixed(2)} of ${r[k].toFixed(2)}`);
    }
  }
  return { penalty: cfg.viability.weight * penalty, refused, margins: ms };
}
