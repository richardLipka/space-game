import type { NameDescriptor, NamePool, NameStyle } from "../../data/schemas/names";
import namesJson from "../../data/names/names.json";

/**
 * Officer names from a descriptor file (src/data/names/names.json, docs/officers.md): each style (English,
 * German, Japanese, …) has pools of given and family names, either picked whole or built from syllable
 * groups, with optional prefixes ("von"), written in the style's order.
 */

/** The bundled descriptor (validated by the tests). */
export const NAMES = namesJson as NameDescriptor;

/** "mixed" = a style picked by weight for every name. */
export const MIXED = "mixed";

function pickStyle(desc: NameDescriptor, random: () => number): NameStyle {
  const w = desc.styles.map((s) => s.weight ?? 1);
  const total = w.reduce((a, b) => a + b, 0);
  if (total <= 0) return desc.styles[Math.floor(random() * desc.styles.length)]!;
  let r = random() * total;
  for (let i = 0; i < w.length; i++) if ((r -= w[i]!) < 0) return desc.styles[i]!;
  return desc.styles[desc.styles.length - 1]!;
}

/** A style by id, or one picked by weight for `mixed`/unknown ids. */
export function nameStyle(desc: NameDescriptor, style: string, random: () => number): NameStyle {
  return desc.styles.find((s) => s.id === style) ?? pickStyle(desc, random);
}

const pick = <T>(xs: readonly T[], random: () => number): T => xs[Math.floor(random() * xs.length)]!;

/** One name from a pool: whole from the list, or built from its syllable groups (no piece twice). */
export function poolName(pool: NamePool, random: () => number): string {
  let name = pick(pool.names, random);
  if (pool.parts && random() < (pool.partChance ?? 0)) {
    for (let tries = 0; tries < 8; tries++) {
      const pieces = pool.parts.map((g) => pick(g, random));
      const lower = pieces.filter(Boolean).map((p) => p.toLowerCase());
      if (new Set(lower).size !== lower.length) continue;
      const built = pieces.join("");
      if (!built) continue;
      name = built[0]!.toUpperCase() + built.slice(1).toLowerCase();
      break;
    }
  }
  if (pool.prefix && random() < pool.prefix.chance) {
    const p = pick(pool.prefix.values, random);
    // "Mac" joins the name ("MacCrane"); "von " stays a separate word.
    name = p + name;
  }
  return name;
}

/** A full name in a style (or mixed), and the style used. */
export function generateName(
  random: () => number,
  style: string = MIXED,
  desc: NameDescriptor = NAMES,
): { name: string; origin: string } {
  const s = nameStyle(desc, style, random);
  const given = poolName(s.given, random);
  const family = poolName(s.family, random);
  return { name: s.order === "family-given" ? `${family} ${given}` : `${given} ${family}`, origin: s.id };
}
