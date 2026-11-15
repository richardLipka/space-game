import type { ShipDesign } from "../../data/schemas/design";
import type { PartCatalogue } from "./catalogue";

/**
 * A design with every part this game knows (docs/save-load.md): placements of parts missing from the
 * catalogue (a newer version's parts, a deleted user part) are left out, and the ids are listed. `design` is
 * null when nothing would be left.
 */
export function resolveDesign(
  design: ShipDesign,
  catalogue: PartCatalogue,
): { design: ShipDesign | null; missing: string[] } {
  const missing = [...new Set(design.parts.filter((p) => !catalogue.has(p.partId)).map((p) => p.partId))];
  if (!missing.length) return { design, missing };
  const parts = design.parts.filter((p) => catalogue.has(p.partId));
  return { design: parts.length ? { ...design, parts } : null, missing };
}

/** "Kestrel: 2 unknown part(s) left out (core:x, user:y/z)". */
export const missingPartsNote = (name: string, missing: readonly string[]): string =>
  `${name}: ${missing.length} unknown part(s) left out (${missing.slice(0, 4).join(", ")}${missing.length > 4 ? ", …" : ""})`;
