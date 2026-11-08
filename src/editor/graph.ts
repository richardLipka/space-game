import type { PartDef } from "../data/schemas/part";
import { compareIds } from "../sim/core/ids";
import { transformPoints } from "../sim/core/geometry";
import type { Vec2 } from "../sim/core/vec2";
import type { LayoutIndex } from "../sim/ship/layout";

/** Resources carried across part connections (spec §7.1). */
export type Resource = "power" | "fuel" | "ammo";
export const RESOURCES: readonly Resource[] = ["power", "fuel", "ammo"];

export interface GraphNode {
  readonly uid: string;
  /** Part centre (design frame). */
  readonly position: Vec2;
  readonly category: string;
  /** False for parts that hold structure but carry nothing (`conducts: false`). */
  readonly conducts: boolean;
}

export interface GraphEdge {
  readonly a: string;
  readonly b: string;
  /** False when either end does not conduct: structural only. */
  readonly conducts: boolean;
  /** Resources routed over this connection (sorted in RESOURCES order). */
  readonly flows: readonly Resource[];
}

export interface ConnectionGraph {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  /** Parts that need a resource no source on their network can provide, e.g. an engine without a tank. */
  readonly unsupplied: readonly {
    readonly uid: string;
    readonly resource: Resource;
    readonly detail: string;
  }[];
}

/** What a part supplies and needs. Ammo is keyed by ammo type. */
interface Roles {
  power: { source: boolean; sink: boolean };
  fuel: { source: boolean; sink: boolean };
  ammoSources: string[];
  ammoSinks: string[];
}

function roles(d: PartDef): Roles {
  const w = d.weapon;
  const powerSink =
    (d.command?.powerDraw ?? 0) > 0 ||
    (d.gyro?.powerDraw ?? 0) > 0 ||
    (d.engine?.powerDraw ?? 0) > 0 ||
    (d.thruster?.powerDraw ?? 0) > 0 ||
    (w?.powerDraw ?? 0) > 0 ||
    (w?.powerPerShot ?? 0) > 0;
  return {
    power: { source: !!d.reactor || !!d.battery, sink: powerSink },
    fuel: { source: !!d.fuelTank, sink: !!d.engine || !!d.thruster },
    ammoSources: d.magazine ? [d.magazine.ammoType] : [],
    ammoSinks: w?.ammoType && w.internalMagazine > 0 ? [w.ammoType] : [],
  };
}

const edgeKey = (a: string, b: string) => (compareIds(a, b) <= 0 ? `${a}|${b}` : `${b}|${a}`);

/**
 * Connection graph of a design: one node per part, one edge per structural connection, and the route each
 * resource takes from its sources to the parts that need it. Every consumer is fed along a shortest path
 * (fewest connections) from the nearest source on its network, ties broken by uid, so the picture is
 * deterministic. Non-conducting parts join the structure but no resource crosses them.
 */
export function connectionGraph(layout: LayoutIndex): ConnectionGraph {
  const parts = [...layout.parts].sort((x, y) => compareIds(x.uid, y.uid));
  const nodes: GraphNode[] = parts.map((p) => ({
    uid: p.uid,
    position: transformPoints([p.def.centroid], p.angle, p.position)[0]!,
    category: p.def.def.category,
    conducts: p.def.def.conducts !== false,
  }));
  const conducts = new Map(nodes.map((n) => [n.uid, n.conducts]));
  const seen = new Set<string>();
  const links: { a: string; b: string; conducts: boolean }[] = [];
  for (const c of layout.connections()) {
    const k = edgeKey(c.a, c.b);
    if (seen.has(k)) continue;
    seen.add(k);
    const [a, b] = compareIds(c.a, c.b) <= 0 ? [c.a, c.b] : [c.b, c.a];
    links.push({ a, b, conducts: conducts.get(a)! && conducts.get(b)! });
  }
  links.sort((x, y) => compareIds(x.a, y.a) || compareIds(x.b, y.b));
  const adj = new Map<string, string[]>(nodes.map((n) => [n.uid, []]));
  for (const l of links) {
    if (!l.conducts) continue;
    adj.get(l.a)!.push(l.b);
    adj.get(l.b)!.push(l.a);
  }
  for (const list of adj.values()) list.sort(compareIds);

  const role = new Map(parts.map((p) => [p.uid, roles(p.def.def)]));
  const flows = new Map<string, Set<Resource>>();
  const unsupplied: { uid: string; resource: Resource; detail: string }[] = [];

  /** Multi-source BFS; marks the path from every sink back to its nearest source. */
  const route = (resource: Resource, sources: string[], sinks: string[], detail: string) => {
    if (sinks.length === 0) return;
    const parent = new Map<string, string | null>();
    const queue = sources.filter((u) => conducts.get(u)).sort(compareIds);
    for (const s of queue) parent.set(s, null);
    for (let i = 0; i < queue.length; i++) {
      for (const v of adj.get(queue[i]!)!) {
        if (parent.has(v)) continue;
        parent.set(v, queue[i]!);
        queue.push(v);
      }
    }
    for (const sink of sinks) {
      if (!parent.has(sink)) {
        unsupplied.push({ uid: sink, resource, detail });
        continue;
      }
      for (let u = sink, p = parent.get(u); p != null; u = p, p = parent.get(u)) {
        const k = edgeKey(u, p);
        if (!flows.has(k)) flows.set(k, new Set());
        flows.get(k)!.add(resource);
      }
    }
  };

  const uids = parts.map((p) => p.uid);
  for (const r of ["power", "fuel"] as const) {
    route(
      r,
      uids.filter((u) => role.get(u)![r].source),
      uids.filter((u) => role.get(u)![r].sink),
      r === "power" ? "no reactor or battery connected" : "no fuel tank connected",
    );
  }
  const ammoTypes = [...new Set(uids.flatMap((u) => role.get(u)!.ammoSinks))].sort();
  for (const t of ammoTypes) {
    route(
      "ammo",
      uids.filter((u) => role.get(u)!.ammoSources.includes(t)),
      uids.filter((u) => role.get(u)!.ammoSinks.includes(t)),
      `no ${t} magazine connected`,
    );
  }

  const edges: GraphEdge[] = links.map((l) => {
    const f = flows.get(edgeKey(l.a, l.b));
    return { ...l, flows: RESOURCES.filter((r) => f?.has(r)) };
  });
  unsupplied.sort((x, y) => compareIds(x.uid, y.uid) || x.resource.localeCompare(y.resource));
  return { nodes, edges, unsupplied };
}
