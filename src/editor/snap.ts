import { aabbOf, convexPenetration, transformPoints } from "../sim/core/geometry";
import { type Vec2, add, angleBetween, degToRad, dot, neg, rotate, scale, sub } from "../sim/core/vec2";
import type { RuntimePartDef } from "../sim/ship/catalogue";
import { CONNECT, type LayoutIndex, type PlacedEdge } from "../sim/ship/layout";

export const SNAP = {
  /** Max distance between the dragged edge and a target edge's line (m). */
  distance: 0.3,
  /** Max angle between edge directions before snapping (rad). */
  angle: degToRad(10),
  /** After snapping, slide to align endpoints when they are this close (m). */
  endAlign: 0.15,
  /** Rotation step with Shift held (deg). */
  rotationStepDeg: 15,
} as const;

export interface SnapResult {
  readonly position: Vec2;
  readonly angle: number;
  readonly targetUid: string;
  readonly targetEdge: number;
  readonly ownEdge: number;
}

export function quantizeAngle(angle: number, stepDeg: number = SNAP.rotationStepDeg): number {
  const step = degToRad(stepDeg);
  return Math.round(angle / step) * step;
}

function edgeAt(def: RuntimePartDef, index: number, pos: Vec2, angle: number) {
  const e = def.edges[index]!;
  return {
    a: add(pos, rotate(e.a, angle)),
    b: add(pos, rotate(e.b, angle)),
    normal: rotate(e.normal, angle),
  };
}

export function overlapsLayout(
  layout: LayoutIndex,
  def: RuntimePartDef,
  pos: Vec2,
  angle: number,
  exclude: ReadonlySet<string>,
): boolean {
  const pieces = def.pieces.map((p) => transformPoints(p, angle, pos));
  const box = aabbOf(pieces.flat());
  for (const uid of layout.near(box, 0)) {
    if (exclude.has(uid)) continue;
    for (const a of pieces)
      for (const b of layout.pieces.get(uid)!)
        if (convexPenetration(a, b) > CONNECT.overlapTolerance) return true;
  }
  return false;
}

/**
 * Finds the best edge snap for a part being dragged at (pos, angle) (spec §3.2):
 * a free `snap` edge of the dragged part within SNAP.distance and SNAP.angle of a `snap` edge in the layout.
 * The result makes the two edges exactly anti-parallel and collinear, keeps the slide position along the edge
 * (aligning endpoints when close), and never overlaps existing parts.
 */
export function findSnap(
  layout: LayoutIndex,
  def: RuntimePartDef,
  pos: Vec2,
  angle: number,
  exclude: ReadonlySet<string> = new Set(),
): SnapResult | null {
  const outline = transformPoints(def.outline, angle, pos);
  const box = aabbOf(outline);
  const candidates: { score: number; result: SnapResult }[] = [];

  for (const uid of layout.near(box, SNAP.distance + 0.05)) {
    if (exclude.has(uid)) continue;
    for (const target of layout.edges.get(uid)!) {
      if (target.type !== "snap") continue;
      for (let i = 0; i < def.edges.length; i++) {
        if (def.edges[i]!.type !== "snap") continue;
        const own = edgeAt(def, i, pos, angle);
        const turn = angleBetween(own.normal, neg(target.normal));
        if (Math.abs(turn) > SNAP.angle) continue;
        const ownMid = scale(add(own.a, own.b), 0.5);
        const dist = Math.abs(dot(sub(ownMid, target.a), target.normal));
        if (dist > SNAP.distance) continue;

        // Rotate about the edge midpoint so normals are anti-parallel, then push onto the target line.
        const newAngle = angle + turn;
        let newPos = add(ownMid, rotate(sub(pos, ownMid), turn));
        const rotated = edgeAt(def, i, newPos, newAngle);
        const d = dot(sub(scale(add(rotated.a, rotated.b), 0.5), target.a), target.normal);
        newPos = sub(newPos, scale(target.normal, d));
        let placed = edgeAt(def, i, newPos, newAngle);

        // Endpoint alignment along the target line.
        const len = Math.hypot(target.b.x - target.a.x, target.b.y - target.a.y);
        const dir = { x: (target.b.x - target.a.x) / len, y: (target.b.y - target.a.y) / len };
        let bestShift = Infinity;
        for (const p of [placed.a, placed.b]) {
          for (const q of [target.a, target.b]) {
            const shift = dot(sub(q, p), dir);
            if (Math.abs(shift) < Math.abs(bestShift)) bestShift = shift;
          }
        }
        if (Math.abs(bestShift) <= SNAP.endAlign) {
          newPos = add(newPos, scale(dir, bestShift));
          placed = edgeAt(def, i, newPos, newAngle);
        }

        // Must actually share some length with the target.
        const t1 = dot(sub(placed.a, target.a), dir);
        const t2 = dot(sub(placed.b, target.a), dir);
        const shared = Math.min(len, Math.max(t1, t2)) - Math.max(0, Math.min(t1, t2));
        if (shared <= CONNECT.coverEpsilon) continue;
        if (overlapsLayout(layout, def, newPos, newAngle, exclude)) continue;

        candidates.push({
          score: dist + Math.abs(turn) * 0.5 - Math.min(shared, 1) * 0.05,
          result: { position: newPos, angle: newAngle, targetUid: uid, targetEdge: target.index, ownEdge: i },
        });
      }
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.score - b.score || (a.result.targetUid < b.result.targetUid ? -1 : 1));
  return candidates[0]!.result;
}

/** Signed distance between a placed edge and the line of another (test/debug helper). */
export function edgeLineDistance(e: { a: Vec2; b: Vec2 }, target: PlacedEdge): number {
  return Math.max(
    Math.abs(dot(sub(e.a, target.a), target.normal)),
    Math.abs(dot(sub(e.b, target.a), target.normal)),
  );
}
