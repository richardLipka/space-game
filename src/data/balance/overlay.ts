import { Type, type Static } from "@sinclair/typebox";
import type { Catalogue, PartDef } from "../schemas/part";
import { validate, type ValidationResult } from "../validate";

/**
 * Balance overlay (plan M7 task 6, tuning loop): multipliers applied to the core catalogue when it is
 * loaded, so tuning never edits the hand-written numbers until a result is accepted. All factors default
 * to 1; a missing field means "unchanged".
 */
const Factor = Type.Number({ exclusiveMinimum: 0, maximum: 100 });
const strict = { additionalProperties: false } as const;

export const BalanceOverlay = Type.Object(
  {
    /**
     * Whole-game pace: HP of every part, magazine and internal ammo, fuel endurance, and all weapon damage.
     * Ammo and fuel are mass-neutral: more rounds weigh proportionally less each, and more fuel means
     * proportionally higher specific impulse (same thrust, slower burn), so ships keep their handling.
     */
    global: Type.Optional(
      Type.Object(
        {
          hp: Type.Optional(Factor),
          ammo: Type.Optional(Factor),
          fuel: Type.Optional(Factor),
          damage: Type.Optional(Factor),
        },
        strict,
      ),
    ),
    /** Per part category (e.g. "command", "armor"): HP and armor value. */
    category: Type.Optional(
      Type.Record(
        Type.String(),
        Type.Object({ hp: Type.Optional(Factor), armor: Type.Optional(Factor) }, strict),
      ),
    ),
    /** Per weapon part id: damage, fire interval, power draw and heat. */
    weapons: Type.Optional(
      Type.Record(
        Type.String(),
        Type.Object(
          {
            damage: Type.Optional(Factor),
            fireInterval: Type.Optional(Factor),
            powerDraw: Type.Optional(Factor),
            heat: Type.Optional(Factor),
          },
          strict,
        ),
      ),
    ),
    /** Per part id: HP. */
    parts: Type.Optional(Type.Record(Type.String(), Type.Object({ hp: Type.Optional(Factor) }, strict))),
  },
  strict,
);
export type BalanceOverlay = Static<typeof BalanceOverlay>;

export const validateOverlay = (data: unknown): ValidationResult<BalanceOverlay> =>
  validate(BalanceOverlay, data);

const f = (x: number | undefined) => x ?? 1;
/** Rounds to a sensible precision so tuned catalogues stay readable. */
const nice = (x: number) => (Math.abs(x) >= 100 ? Math.round(x) : Math.round(x * 100) / 100);
const int = (x: number, min = 1) => Math.max(min, Math.round(x));

/** The catalogue with the overlay applied (a deep copy; the input is not changed). */
export function applyOverlay(cat: Catalogue, o: BalanceOverlay): Catalogue {
  const g = o.global ?? {};
  const parts: PartDef[] = cat.parts.map((src) => {
    const p = structuredClone(src) as PartDef & Record<string, unknown>;
    const cat_ = o.category?.[p.category] ?? {};
    const hpK = f(g.hp) * f(cat_.hp) * f(o.parts?.[p.id]?.hp);
    if (hpK !== 1) p.hp = int(p.hp * hpK);
    if (p.armor !== undefined && f(cat_.armor) !== 1) p.armor = nice(p.armor * f(cat_.armor));
    if (f(g.fuel) !== 1) {
      if (p.engine) p.engine = { ...p.engine, isp: nice(p.engine.isp * f(g.fuel)) };
      if (p.thruster) p.thruster = { ...p.thruster, isp: nice(p.thruster.isp * f(g.fuel)) };
    }
    if (p.magazine && f(g.ammo) !== 1) {
      const capacity = int(p.magazine.capacity * f(g.ammo));
      // Same full-magazine mass with more rounds.
      const massPerRound =
        Math.round(((p.magazine.capacity * p.magazine.massPerRound) / capacity) * 1e4) / 1e4;
      p.magazine = { ...p.magazine, capacity, massPerRound };
    }
    const w = p.weapon;
    if (w) {
      const wk = o.weapons?.[p.id] ?? {};
      const dmg = f(g.damage) * f(wk.damage);
      if (w.internalMagazine > 0 && f(g.ammo) !== 1) w.internalMagazine = int(w.internalMagazine * f(g.ammo));
      if (dmg !== 1) {
        if (w.projectile) {
          w.projectile.damage = nice(w.projectile.damage * dmg);
          if (w.projectile.burstDamage !== undefined)
            w.projectile.burstDamage = nice(w.projectile.burstDamage * dmg);
        }
        if (w.beam) w.beam.dps = nice(w.beam.dps * dmg);
        if (w.missile) w.missile.damage = nice(w.missile.damage * dmg);
      }
      if (f(wk.fireInterval) !== 1) w.fireInterval = nice(w.fireInterval * f(wk.fireInterval));
      if (f(wk.powerDraw) !== 1) {
        if (w.powerDraw !== undefined) w.powerDraw = nice(w.powerDraw * f(wk.powerDraw));
        if (w.powerPerShot !== undefined) w.powerPerShot = nice(w.powerPerShot * f(wk.powerDraw));
      }
      if (f(wk.heat) !== 1) {
        if (w.heatPerShot !== undefined) w.heatPerShot = nice(w.heatPerShot * f(wk.heat));
        if (w.heatWhileFiring !== undefined) w.heatWhileFiring = nice(w.heatWhileFiring * f(wk.heat));
      }
    }
    return p;
  });
  return { ...cat, parts };
}

/** Field-level differences between two catalogues ("part.field: old → new"), for review. */
export function catalogueDiff(before: Catalogue, after: Catalogue): string[] {
  const out: string[] = [];
  const walk = (id: string, path: string, a: unknown, b: unknown) => {
    if (typeof a === "object" && a && typeof b === "object" && b) {
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)]))
        walk(
          id,
          path ? `${path}.${k}` : k,
          (a as Record<string, unknown>)[k],
          (b as Record<string, unknown>)[k],
        );
    } else if (a !== b) out.push(`${id} ${path}: ${JSON.stringify(a)} → ${JSON.stringify(b)}`);
  };
  const byId = new Map(after.parts.map((p) => [p.id, p]));
  for (const p of before.parts) walk(p.id, "", p, byId.get(p.id));
  return out;
}
