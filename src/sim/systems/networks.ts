import { compareIds } from "../core/ids";
import type { Connection } from "../ship/layout";

/** A node in the resource network: an intact, conducting part (spec §7.1). */
export interface NetworkNode {
  readonly uid: string;
  readonly intact: boolean;
  /** Parts with `conducts: false` hold structure but carry no power/fuel/ammo. */
  readonly conducts: boolean;
}

export interface Networks {
  /** Network index per participating part (destroyed/non-conducting parts are absent). */
  readonly networkOf: ReadonlyMap<string, number>;
  /** Members of each network, sorted by uid; networks ordered by their smallest uid. */
  readonly members: readonly (readonly string[])[];
}

/**
 * Connected components of the connection graph restricted to intact, conducting parts.
 * Deterministic: depends only on uids, never on input order.
 */
export function computeNetworks(nodes: readonly NetworkNode[], connections: readonly Connection[]): Networks {
  const active = new Set(nodes.filter((n) => n.intact && n.conducts).map((n) => n.uid));
  const parent = new Map<string, string>();
  for (const uid of active) parent.set(uid, uid);
  const find = (u: string): string => {
    let r = u;
    while (parent.get(r) !== r) r = parent.get(r)!;
    // Path compression.
    let c = u;
    while (parent.get(c) !== r) {
      const next = parent.get(c)!;
      parent.set(c, r);
      c = next;
    }
    return r;
  };
  for (const c of connections) {
    if (!active.has(c.a) || !active.has(c.b)) continue;
    const ra = find(c.a);
    const rb = find(c.b);
    if (ra === rb) continue;
    // Smaller uid becomes the root so the result does not depend on connection order.
    if (compareIds(ra, rb) < 0) parent.set(rb, ra);
    else parent.set(ra, rb);
  }
  const groups = new Map<string, string[]>();
  for (const uid of [...active].sort(compareIds)) {
    const r = find(uid);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r)!.push(uid);
  }
  const members = [...groups.values()].sort((a, b) => compareIds(a[0]!, b[0]!));
  const networkOf = new Map<string, number>();
  members.forEach((m, i) => m.forEach((uid) => networkOf.set(uid, i)));
  return { networkOf, members };
}
