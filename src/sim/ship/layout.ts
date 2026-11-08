import {
  aabbOf,
  aabbOverlap,
  convexPenetration,
  rayPolygon,
  transformPoints,
  type Aabb,
  pointInPolygon,
} from "../core/geometry";
import { type Vec2, add, dot, rotate, sub, degToRad, fromAngle, normalize } from "../core/vec2";
import type { RuntimePartDef } from "./catalogue";

/**
 * Design-time geometry analysis shared by the editor and the simulation (spec §3.3, §3.4, §7.1):
 * edge connections, edge coverage/exposure, exhaust clearance, overlap and turret occlusion.
 * All coordinates are in the ship (design) frame.
 */
export interface PlacedPart {
  readonly uid: string;
  readonly def: RuntimePartDef;
  readonly position: Vec2;
  /** Radians. */
  readonly angle: number;
}

export interface PlacedEdge {
  readonly uid: string;
  readonly index: number;
  readonly type: "snap" | "hull" | "function";
  readonly a: Vec2;
  readonly b: Vec2;
  readonly normal: Vec2;
  readonly length: number;
}

export const CONNECT = {
  /** Max angle between edge normals and exact anti-parallel (rad). */
  angleTolerance: degToRad(0.5),
  /** Max distance of one edge's endpoints from the other edge's line (m). */
  distanceTolerance: 0.01,
  /** Minimum shared length for a structural connection (m). */
  minOverlap: 0.25,
  /** Overlap below this does not count as covering an edge (m). */
  coverEpsilon: 1e-3,
  /** Penetration depth tolerated between neighbouring parts (m). */
  overlapTolerance: 1e-3,
} as const;

export function placedOutline(p: PlacedPart): Vec2[] {
  return transformPoints(p.def.outline, p.angle, p.position);
}

export function placedPieces(p: PlacedPart): Vec2[][] {
  return p.def.pieces.map((piece) => transformPoints(piece, p.angle, p.position));
}

export function placedEdges(p: PlacedPart): PlacedEdge[] {
  return p.def.edges.map((e, index) => {
    const a = add(p.position, rotate(e.a, p.angle));
    const b = add(p.position, rotate(e.b, p.angle));
    return {
      uid: p.uid,
      index,
      type: e.type,
      a,
      b,
      normal: rotate(e.normal, p.angle),
      length: Math.hypot(b.x - a.x, b.y - a.y),
    };
  });
}

/**
 * Shared length of two edges that are collinear and face each other (anti-parallel normals).
 * Returns 0 when they are not in contact.
 */
export function edgeContact(
  e1: PlacedEdge,
  e2: PlacedEdge,
  angleTol: number = CONNECT.angleTolerance,
  distTol: number = CONNECT.distanceTolerance,
): number {
  if (dot(e1.normal, e2.normal) > -Math.cos(angleTol)) return 0;
  if (Math.abs(dot(sub(e2.a, e1.a), e1.normal)) > distTol) return 0;
  if (Math.abs(dot(sub(e2.b, e1.a), e1.normal)) > distTol) return 0;
  if (e1.length === 0) return 0;
  const dir = { x: (e1.b.x - e1.a.x) / e1.length, y: (e1.b.y - e1.a.y) / e1.length };
  const t1 = dot(sub(e2.a, e1.a), dir);
  const t2 = dot(sub(e2.b, e1.a), dir);
  const lo = Math.max(0, Math.min(t1, t2));
  const hi = Math.min(e1.length, Math.max(t1, t2));
  return Math.max(0, hi - lo);
}

/** Interval [lo, hi] along e1 covered by e2 (assumes edgeContact > 0). */
function contactInterval(e1: PlacedEdge, e2: PlacedEdge): [number, number] {
  const dir = { x: (e1.b.x - e1.a.x) / e1.length, y: (e1.b.y - e1.a.y) / e1.length };
  const t1 = dot(sub(e2.a, e1.a), dir);
  const t2 = dot(sub(e2.b, e1.a), dir);
  return [Math.max(0, Math.min(t1, t2)), Math.min(e1.length, Math.max(t1, t2))];
}

export interface Connection {
  readonly a: string;
  readonly edgeA: number;
  readonly b: string;
  readonly edgeB: number;
  /** Shared length (m); kept for future structural strength (spec §3.3). */
  readonly overlap: number;
}

/** Analysis cache for one design: placed geometry plus a broad-phase grid. */
export class LayoutIndex {
  readonly parts: readonly PlacedPart[];
  readonly edges = new Map<string, PlacedEdge[]>();
  readonly pieces = new Map<string, Vec2[][]>();
  readonly outlines = new Map<string, Vec2[]>();
  readonly aabbs = new Map<string, Aabb>();
  private readonly grid = new Map<string, string[]>();
  private static readonly CELL = 4;

  constructor(parts: readonly PlacedPart[]) {
    this.parts = parts;
    for (const p of parts) {
      const outline = placedOutline(p);
      const box = aabbOf(outline);
      this.outlines.set(p.uid, outline);
      this.edges.set(p.uid, placedEdges(p));
      this.pieces.set(p.uid, placedPieces(p));
      this.aabbs.set(p.uid, box);
      for (const key of LayoutIndex.cells(box, 0.05)) {
        const bucket = this.grid.get(key);
        if (bucket) bucket.push(p.uid);
        else this.grid.set(key, [p.uid]);
      }
    }
  }

  private static cells(box: Aabb, margin: number): string[] {
    const c = LayoutIndex.CELL;
    const keys: string[] = [];
    for (let x = Math.floor((box.minX - margin) / c); x <= Math.floor((box.maxX + margin) / c); x++) {
      for (let y = Math.floor((box.minY - margin) / c); y <= Math.floor((box.maxY + margin) / c); y++)
        keys.push(`${x},${y}`);
    }
    return keys;
  }

  /** Parts whose bounding boxes come within `margin` of `box` (deduplicated, sorted by uid). */
  near(box: Aabb, margin = 0.05, exclude?: string): string[] {
    const found = new Set<string>();
    for (const key of LayoutIndex.cells(box, margin)) {
      for (const uid of this.grid.get(key) ?? []) {
        if (uid !== exclude && aabbOverlap(box, this.aabbs.get(uid)!, margin)) found.add(uid);
      }
    }
    return [...found].sort();
  }

  /** Candidate neighbour pairs (uidA < uidB). */
  pairs(margin = 0.05): [string, string][] {
    const out: [string, string][] = [];
    for (const p of this.parts) {
      for (const other of this.near(this.aabbs.get(p.uid)!, margin, p.uid))
        if (p.uid < other) out.push([p.uid, other]);
    }
    return out;
  }

  /** Structural connections: snap–snap edge contacts with at least `minOverlap` shared length. */
  connections(minOverlap: number = CONNECT.minOverlap): Connection[] {
    const out: Connection[] = [];
    for (const [ua, ub] of this.pairs()) {
      for (const ea of this.edges.get(ua)!) {
        if (ea.type !== "snap") continue;
        for (const eb of this.edges.get(ub)!) {
          if (eb.type !== "snap") continue;
          const overlap = edgeContact(ea, eb);
          if (overlap >= minOverlap - 1e-9)
            out.push({ a: ua, edgeA: ea.index, b: ub, edgeB: eb.index, overlap });
        }
      }
    }
    return out;
  }

  /** Covered length of an edge by any other part's edges (union of intervals). */
  coveredLength(uid: string, index: number): number {
    const e = this.edges.get(uid)![index]!;
    const intervals: [number, number][] = [];
    for (const other of this.near(aabbOf([e.a, e.b]), 0.05, uid)) {
      for (const oe of this.edges.get(other)!) {
        if (edgeContact(e, oe) > CONNECT.coverEpsilon) intervals.push(contactInterval(e, oe));
      }
    }
    intervals.sort((x, y) => x[0] - y[0]);
    let total = 0;
    let curLo = -Infinity;
    let curHi = -Infinity;
    for (const [lo, hi] of intervals) {
      if (lo > curHi) {
        if (curHi > curLo) total += curHi - curLo;
        curLo = lo;
        curHi = hi;
      } else curHi = Math.max(curHi, hi);
    }
    if (curHi > curLo) total += curHi - curLo;
    return total;
  }

  /** Fraction of an edge that is not covered by another part (spec §7.4 radiators). */
  exposedFraction(uid: string, index: number): number {
    const e = this.edges.get(uid)![index]!;
    return e.length > 0 ? Math.max(0, 1 - this.coveredLength(uid, index) / e.length) : 0;
  }

  /**
   * Total uncovered outline length (m) that radiates as hull (spec §7.4): every exposed edge except
   * radiator panels' functional edges, which count as radiators instead.
   */
  exposedHullLength(): number {
    let total = 0;
    for (const p of this.parts) {
      const radiator = !!p.def.def.radiator;
      for (const e of this.edges.get(p.uid)!) {
        if (radiator && e.type === "function") continue;
        total += e.length * this.exposedFraction(p.uid, e.index);
      }
    }
    return total;
  }

  /** Uid of the part whose outline contains `pt` (design frame), or null. Later parts win ties. */
  partAt(pt: Vec2): string | null {
    let found: string | null = null;
    for (const p of this.parts) {
      const box = this.aabbs.get(p.uid)!;
      if (pt.x < box.minX || pt.x > box.maxX || pt.y < box.minY || pt.y > box.maxY) continue;
      if (pointInPolygon(pt, this.outlines.get(p.uid)!)) found = p.uid;
    }
    return found;
  }

  /** Pairs of parts that overlap by more than the tolerance. */
  overlaps(tolerance: number = CONNECT.overlapTolerance): [string, string][] {
    const out: [string, string][] = [];
    for (const [ua, ub] of this.pairs(0)) {
      let hit = false;
      for (const pa of this.pieces.get(ua)!) {
        for (const pb of this.pieces.get(ub)!) if (convexPenetration(pa, pb) > tolerance) hit = true;
      }
      if (hit) out.push([ua, ub]);
    }
    return out;
  }

  /** Nearest hit of a ray against parts other than `exclude` (within maxDist). */
  raycast(origin: Vec2, dir: Vec2, maxDist: number, exclude?: string): { uid: string; t: number } | null {
    let best: { uid: string; t: number } | null = null;
    for (const p of this.parts) {
      if (p.uid === exclude) continue;
      const box = this.aabbs.get(p.uid)!;
      // Cheap reject: ray segment bounding box vs part box.
      const end = add(origin, { x: dir.x * maxDist, y: dir.y * maxDist });
      if (!aabbOverlap(box, aabbOf([origin, end]), 0.01)) continue;
      const t = rayPolygon(origin, dir, this.outlines.get(p.uid)!, maxDist);
      if (t !== null && (best === null || t < best.t)) best = { uid: p.uid, t };
    }
    return best;
  }

  /** Every part a ray enters within maxDist (first hit per part), nearest first; ties broken by uid. */
  raycastAll(origin: Vec2, dir: Vec2, maxDist: number): { uid: string; t: number }[] {
    const hits: { uid: string; t: number }[] = [];
    const end = add(origin, { x: dir.x * maxDist, y: dir.y * maxDist });
    const segBox = aabbOf([origin, end]);
    for (const p of this.parts) {
      if (!aabbOverlap(this.aabbs.get(p.uid)!, segBox, 0.01)) continue;
      const t = rayPolygon(origin, dir, this.outlines.get(p.uid)!, maxDist);
      if (t !== null) hits.push({ uid: p.uid, t });
    }
    return hits.sort((x, y) => x.t - y.t || (x.uid < y.uid ? -1 : 1));
  }

  /** Radius of a circle around the ship origin that contains every part. */
  get boundingRadius(): number {
    let r = 0;
    for (const o of this.outlines.values()) for (const v of o) r = Math.max(r, Math.hypot(v.x, v.y));
    return r;
  }
}

export const EXHAUST_CLEARANCE = 30;

/** Exhaust path check: three rays (both ends inset + middle) out of the nozzle edge (spec §3.4). */
export function exhaustBlockedBy(layout: LayoutIndex, p: PlacedPart): string | null {
  const engine = p.def.def.engine;
  if (!engine) return null;
  const e = layout.edges.get(p.uid)![engine.nozzleEdge]!;
  const inset = 0.1;
  for (const t of [inset, 0.5, 1 - inset]) {
    const origin = add(
      { x: e.a.x + (e.b.x - e.a.x) * t, y: e.a.y + (e.b.y - e.a.y) * t },
      { x: e.normal.x * 1e-4, y: e.normal.y * 1e-4 },
    );
    const hit = layout.raycast(origin, e.normal, EXHAUST_CLEARANCE, p.uid);
    if (hit) return hit.uid;
  }
  return null;
}

/**
 * Turret self-occlusion (spec §9.1): angle ranges (degrees, relative to the mount axis) inside the arc where
 * a ray from the muzzle hits the ship's own parts. Sampled every `step`° and refined by bisection.
 */
export function turretBlockedRanges(
  layout: LayoutIndex,
  p: PlacedPart,
  range = 60,
  step = 1,
): [number, number][] {
  const w = p.def.def.weapon;
  if (!w || w.mount !== "turret") return [];
  const [arcMin, arcMax] = w.arc ?? [-180, 180];
  const muzzle = add(p.position, rotate({ x: w.muzzle[0], y: w.muzzle[1] }, p.angle));
  const blocked = (deg: number) =>
    layout.raycast(muzzle, fromAngle(p.angle + degToRad(deg)), range, p.uid) !== null;
  const refine = (inside: number, outside: number) => {
    let a = inside,
      b = outside;
    for (let i = 0; i < 14; i++) {
      const m = (a + b) / 2;
      if (blocked(m)) a = m;
      else b = m;
    }
    return a;
  };
  const ranges: [number, number][] = [];
  let start: number | null = blocked(arcMin) ? arcMin : null;
  let prev = arcMin;
  for (let d = arcMin + step; d <= arcMax + 1e-9; d += step) {
    const deg = Math.min(d, arcMax);
    const b = blocked(deg);
    if (b && start === null) start = refine(deg, prev);
    if (!b && start !== null) {
      ranges.push([start, refine(prev, deg)]);
      start = null;
    }
    prev = deg;
  }
  if (start !== null) ranges.push([start, arcMax]);
  return ranges;
}

/** Unit vector helper re-export for editor code. */
export const unit = normalize;
