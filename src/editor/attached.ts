import type { ShipDesign } from "../data/schemas/design";
import { compareIds } from "../sim/core/ids";
import type { LayoutIndex } from "../sim/ship/layout";

/**
 * Parts that hang on `uid`: everything that would lose its structural connection to the command module if
 * `uid` were taken away (the same rule as jettison in flight, decision log: Ejection). Only parts reached
 * through `uid` count, so separate loose parts elsewhere are not swept up. Moving or rotating `uid` in the
 * editor carries these along. Empty for the command module itself, and when there is no command module.
 */
export function attachedTo(design: ShipDesign, layout: LayoutIndex, uid: string): string[] {
  const root = design.parts
    .filter((p) => layout.parts.find((q) => q.uid === p.uid)?.def.def.command)
    .map((p) => p.uid)
    .sort(compareIds)[0];
  if (!root || root === uid) return [];
  const adj = new Map<string, string[]>(design.parts.map((p) => [p.uid, []]));
  for (const c of layout.connections()) {
    adj.get(c.a)?.push(c.b);
    adj.get(c.b)?.push(c.a);
  }
  // Everything still reachable from the command module without passing through `uid`.
  const kept = new Set<string>([uid]);
  const stack = [root];
  kept.add(root);
  while (stack.length) {
    const u = stack.pop()!;
    for (const v of adj.get(u) ?? []) {
      if (kept.has(v)) continue;
      kept.add(v);
      stack.push(v);
    }
  }
  // What hangs on `uid`: reachable from it without entering the kept part of the ship.
  const out = new Set<string>();
  const walk = [uid];
  while (walk.length) {
    const u = walk.pop()!;
    for (const v of adj.get(u) ?? []) {
      if (kept.has(v) || out.has(v)) continue;
      out.add(v);
      walk.push(v);
    }
  }
  return [...out].sort(compareIds);
}
