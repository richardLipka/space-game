import { BALANCE } from "../data/balance/model";
import { BUNDLED_DESIGNS, designSection } from "../data/designs/index";
import type { ShipDesign } from "../data/schemas/design";
import { designStats } from "../editor/stats";
import { validateDesignLayout } from "../editor/validate";
import type { PartCatalogue } from "../sim/ship/catalogue";

/**
 * Design rules every playable ship and test platform follows (docs/design-rules.md). Each rule gives a
 * number and a pass mark, so the audit says by how much a design misses.
 */
export interface RuleResult {
  readonly rule: string;
  readonly value: number;
  readonly min: number;
  readonly ok: boolean;
  readonly note: string;
}

export interface DesignAudit {
  readonly id: string;
  readonly name: string;
  readonly section: string;
  readonly cost: number;
  readonly mass: number;
  readonly layout: readonly string[];
  readonly rules: readonly RuleResult[];
  readonly ok: boolean;
}

/** Pass marks. */
export const DESIGN_RULES = {
  /** Reactor output ÷ combat power demand (weapons, point defense, gyros, command, hangars). */
  power: 1,
  /**
   * Cooling for a whole game of fire: (dissipation + heat capacity ÷ `game.fireTime`) ÷ heat of sustained
   * combat (power actually drawn, weapon and gyro heat; engines excluded). Small ships may lean on their
   * heat capacity; large ones need radiators.
   */
  cooling: 1,
  /** Seconds of fire every ammunition-using weapon gets from the ship's magazines and its own rounds, as a share of `game.fireTime`. */
  ammo: 0.9,
  /** Delta-v (m/s) for ships with engines. */
  deltaV: 300,
} as const;

/** Audits one design against the layout check and the design rules. */
export function auditDesign(d: ShipDesign, cat: PartCatalogue): DesignAudit {
  // Test platforms stand still on purpose; unarmed ships (targets, haulers) are not a rule break.
  const platform = designSection(d) === "Test platforms";
  const layout = validateDesignLayout(d, cat)
    .issues.filter((i) => i.code !== "no-weapons" && !(platform && i.code === "no-propulsion"))
    .map((i) => `${i.severity}: ${i.message}`);
  const s = designStats(d, cat);
  const rules: RuleResult[] = [];
  const add = (rule: string, value: number, min: number, note: string) =>
    rules.push({ rule, value, min, ok: value >= min - 1e-9, note });

  const dm = s.power.demand;
  const combat = dm.weapons + dm.pointDefense + dm.gyro + dm.hangar;
  if (combat > 0)
    add(
      "power",
      s.power.production / combat,
      DESIGN_RULES.power,
      `${kw(s.power.production)} for ${kw(combat)}`,
    );

  // Sustained combat heat: what the reactors make for the combat load, plus weapons' and gyros' own heat.
  let own = 0;
  const fire = new Map<string, { weapons: number; interval: number; internal: number }>();
  for (const pl of d.parts) {
    const def = cat.get(pl.partId).def;
    own += def.gyro?.heat ?? 0;
    const w = def.weapon;
    if (!w) continue;
    own += (w.heatPerShot ?? 0) / w.fireInterval + (w.heatWhileFiring ?? 0);
    if (w.ammoType) {
      const f = fire.get(w.ammoType) ?? { weapons: 0, interval: w.fireInterval, internal: 0 };
      f.weapons++;
      f.internal += w.internalMagazine;
      fire.set(w.ammoType, f);
    }
  }
  const heat = Math.min(combat, s.power.production) * BALANCE.power.heatPerWatt + own;
  const cooling = s.heat.dissipation + s.heat.capacity / BALANCE.game.fireTime;
  if (heat > 0) add("cooling", cooling / heat, DESIGN_RULES.cooling, `${kw(cooling)} for ${kw(heat)}`);

  for (const [type, f] of fire) {
    // Launchers load every missile type their network holds.
    const stored =
      type === "missile"
        ? Object.entries(s.ammo).reduce((n, [k, v]) => n + (k.startsWith("missile-") ? v : 0), 0)
        : (s.ammo[type] ?? 0);
    const rounds = stored + f.internal;
    const seconds = (rounds * f.interval) / f.weapons;
    add(
      `ammo ${type}`,
      seconds / BALANCE.game.fireTime,
      DESIGN_RULES.ammo,
      `${seconds.toFixed(0)} s per weapon (${f.weapons} weapons)`,
    );
  }
  if (d.parts.some((p) => cat.get(p.partId).def.engine))
    add("delta-v", s.fuel.deltaV, DESIGN_RULES.deltaV, `${s.fuel.deltaV.toFixed(0)} m/s`);
  return {
    id: d.id,
    name: d.name,
    section: designSection(d),
    cost: s.cost,
    mass: s.mass,
    layout,
    rules,
    ok: layout.length === 0 && rules.every((r) => r.ok),
  };
}

/** Audits every bundled design in the given sections (all when omitted). */
export function auditBundled(cat: PartCatalogue, sections?: readonly string[]): DesignAudit[] {
  return [...BUNDLED_DESIGNS.values()]
    .filter((d) => !d.drone && (!sections || sections.includes(designSection(d))))
    .map((d) => auditDesign(d, cat));
}

const kw = (w: number) => (w >= 1e6 ? `${(w / 1e6).toFixed(2)} MW` : `${(w / 1e3).toFixed(0)} kW`);
