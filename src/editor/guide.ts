import { aabbOf } from "../sim/core/geometry";
import { type Vec2, add, dot, rotate, sub } from "../sim/core/vec2";
import type { RuntimePartDef } from "../sim/ship/catalogue";
import { CONNECT, edgeContact, type LayoutIndex, type PlacedEdge } from "../sim/ship/layout";
import { overlapsLayout, SNAP } from "./snap";

/**
 * Connection guidance for the editor: what a part being placed or dragged would connect to, and which
 * edges on the ship can accept a connection. Pure, so the editor UI and tests share it.
 */
export type ContactKind = "connect" | "short" | "blocked";

export interface Contact {
  readonly uid: string;
  readonly partName: string;
  readonly ownEdge: number;
  readonly targetEdge: number;
  /** Shared length (m). */
  readonly overlap: number;
  /**
   * connect: snap–snap with at least CONNECT.minOverlap shared;
   * short: snap–snap but too little shared length to connect;
   * blocked: one side is an outer hull or functional edge (nothing may attach there).
   */
  readonly kind: ContactKind;
  readonly blockedType?: "hull" | "function";
  /** Shared segment endpoints (ship frame), for drawing. */
  readonly a: Vec2;
  readonly b: Vec2;
}

export interface PlacementPreview {
  readonly contacts: readonly Contact[];
  readonly overlaps: boolean;
  /** True when at least one structural connection would form. */
  readonly connected: boolean;
  /** A no-attach edge (outer hull / functional) within snapping range: explains why nothing snaps. */
  readonly nearNoAttach?: { readonly partName: string; readonly type: "hull" | "function" };
}

/** The part's edges at a given pose (ship frame). */
export function ghostEdges(def: RuntimePartDef, pos: Vec2, angle: number, uid = "ghost"): PlacedEdge[] {
  return def.edges.map((e, index) => {
    const a = add(pos, rotate(e.a, angle));
    const b = add(pos, rotate(e.b, angle));
    return {
      uid,
      index,
      type: e.type,
      a,
      b,
      normal: rotate(e.normal, angle),
      length: Math.hypot(b.x - a.x, b.y - a.y),
    };
  });
}

function sharedSegment(e1: PlacedEdge, e2: PlacedEdge): [Vec2, Vec2] {
  const dir = { x: (e1.b.x - e1.a.x) / e1.length, y: (e1.b.y - e1.a.y) / e1.length };
  const t1 = dot(sub(e2.a, e1.a), dir);
  const t2 = dot(sub(e2.b, e1.a), dir);
  const lo = Math.max(0, Math.min(t1, t2));
  const hi = Math.min(e1.length, Math.max(t1, t2));
  return [add(e1.a, { x: dir.x * lo, y: dir.y * lo }), add(e1.a, { x: dir.x * hi, y: dir.y * hi })];
}

/** Everything a part at (pos, angle) would touch, connect to or wrongly cover. */
export function previewPlacement(
  layout: LayoutIndex,
  def: RuntimePartDef,
  pos: Vec2,
  angle: number,
  exclude: ReadonlySet<string> = new Set(),
): PlacementPreview {
  const own = ghostEdges(def, pos, angle);
  const box = aabbOf(own.flatMap((e) => [e.a, e.b]));
  const contacts: Contact[] = [];
  let nearNoAttach: PlacementPreview["nearNoAttach"];
  for (const uid of layout.near(box, SNAP.distance + 0.05)) {
    if (exclude.has(uid)) continue;
    const name = layout.parts.find((p) => p.uid === uid)!.def.def.name;
    for (const oe of own) {
      for (const te of layout.edges.get(uid)!) {
        const overlap = edgeContact(oe, te);
        if (overlap <= CONNECT.coverEpsilon) {
          if (
            !nearNoAttach &&
            te.type !== "snap" &&
            edgeContact(oe, te, SNAP.angle, SNAP.distance) > CONNECT.coverEpsilon
          ) {
            nearNoAttach = { partName: name, type: te.type };
          }
          continue;
        }
        const [a, b] = sharedSegment(oe, te);
        const blocked = oe.type !== "snap" ? oe.type : te.type !== "snap" ? te.type : undefined;
        contacts.push({
          uid,
          partName: name,
          ownEdge: oe.index,
          targetEdge: te.index,
          overlap,
          kind: blocked ? "blocked" : overlap >= CONNECT.minOverlap - 1e-9 ? "connect" : "short",
          ...(blocked ? { blockedType: blocked } : {}),
          a,
          b,
        });
      }
    }
  }
  return {
    contacts,
    overlaps: overlapsLayout(layout, def, pos, angle, exclude),
    connected: contacts.some((c) => c.kind === "connect"),
    ...(nearNoAttach ? { nearNoAttach } : {}),
  };
}

export interface AttachEdges {
  /** Snap edges with free length: a new part can connect here. */
  readonly free: readonly PlacedEdge[];
  /** Exposed outer-hull and functional edges: nothing may attach here. */
  readonly noAttach: readonly PlacedEdge[];
}

/** Edges on the ship that can (and cannot) take a new connection. */
export function attachEdges(layout: LayoutIndex, exclude: ReadonlySet<string> = new Set()): AttachEdges {
  const free: PlacedEdge[] = [];
  const noAttach: PlacedEdge[] = [];
  for (const p of layout.parts) {
    if (exclude.has(p.uid)) continue;
    for (const e of layout.edges.get(p.uid)!) {
      if (e.type === "snap") {
        if (layout.coveredLength(p.uid, e.index) < e.length - CONNECT.minOverlap + 1e-9) free.push(e);
      } else noAttach.push(e);
    }
  }
  return { free, noAttach };
}

export interface Hint {
  readonly level: "ok" | "info" | "warn" | "error";
  readonly text: string;
}

const m = (x: number) => `${x.toFixed(2)} m`;

/** One-line explanation of what clicking now would do (editor status line). */
export function describePreview(p: PlacementPreview, firstPart: boolean, partName: string): Hint {
  if (p.overlaps)
    return {
      level: "error",
      text: `✗ ${partName} overlaps an existing part. Move it so the edges only touch.`,
    };
  if (firstPart)
    return {
      level: "info",
      text: `First part: click anywhere to place ${partName}. Start with a command module.`,
    };
  const blocked = p.contacts.filter((c) => c.kind === "blocked");
  const connects = p.contacts.filter((c) => c.kind === "connect");
  const short = p.contacts.filter((c) => c.kind === "short");
  if (blocked.length) {
    const b = blocked[0]!;
    const what =
      b.blockedType === "hull" ? "an outer hull edge" : "a functional edge (nozzle, radiator or muzzle)";
    return {
      level: "warn",
      text: `⚠ Touches ${what} of ${b.partName}. Nothing may attach there; use a green edge instead.`,
    };
  }
  if (connects.length) {
    const names = [...new Set(connects.map((c) => c.partName))];
    const total = connects.reduce((s, c) => s + c.overlap, 0);
    return {
      level: "ok",
      text: `✓ Connects to ${names.join(", ")} (${m(total)} shared edge). Click to place.`,
    };
  }
  if (short.length) {
    return {
      level: "warn",
      text: `⚠ Touches ${short[0]!.partName} with only ${m(short[0]!.overlap)} of edge; at least ${m(CONNECT.minOverlap)} must overlap to connect.`,
    };
  }
  if (p.nearNoAttach) {
    const what =
      p.nearNoAttach.type === "hull"
        ? "an outer hull edge"
        : "a functional edge (nozzle, radiator or muzzle)";
    return {
      level: "warn",
      text: `⚠ That is ${what} of ${p.nearNoAttach.partName}: nothing can attach there. Use a green edge.`,
    };
  }
  return {
    level: "warn",
    text: "Not connected: move one of the part's green edges onto a green edge of the ship (it snaps within 0.3 m).",
  };
}
