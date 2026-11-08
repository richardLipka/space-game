import { type Vec2, rotate, add } from "./vec2";

/** Polygon helpers (spec §6.1). Polygons are counter-clockwise vertex lists. */

export function polygonArea(poly: readonly Vec2[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]!;
    const q = poly[(i + 1) % poly.length]!;
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

export function polygonCentroid(poly: readonly Vec2[]): Vec2 {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]!;
    const q = poly[(i + 1) % poly.length]!;
    const c = p.x * q.y - q.x * p.y;
    a += c;
    cx += (p.x + q.x) * c;
    cy += (p.y + q.y) * c;
  }
  a /= 2;
  if (a === 0) throw new Error("Degenerate polygon (zero area)");
  return { x: cx / (6 * a), y: cy / (6 * a) };
}

/** Polar second moment of area about the coordinate origin, ∫(x²+y²) dA. */
export function polygonPolarMomentOrigin(poly: readonly Vec2[]): number {
  let j = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]!;
    const q = poly[(i + 1) % poly.length]!;
    const c = p.x * q.y - q.x * p.y;
    j += c * (p.x * p.x + p.x * q.x + q.x * q.x + p.y * p.y + p.y * q.y + q.y * q.y);
  }
  return j / 12;
}

export interface ShapeMassInfo {
  /** Total area of all pieces. */
  readonly area: number;
  /** Area centroid. */
  readonly centroid: Vec2;
  /** Inertia per unit mass about the centroid (m²): multiply by mass to get kg·m². */
  readonly unitInertia: number;
}

/** Combined area, centroid and inertia-per-kg for a set of convex pieces of uniform density. */
export function shapeMassInfo(pieces: readonly (readonly Vec2[])[]): ShapeMassInfo {
  let area = 0;
  let cx = 0;
  let cy = 0;
  let jOrigin = 0;
  for (const piece of pieces) {
    const a = polygonArea(piece);
    const c = polygonCentroid(piece);
    area += a;
    cx += c.x * a;
    cy += c.y * a;
    jOrigin += polygonPolarMomentOrigin(piece);
  }
  if (!(area > 0)) throw new Error("Shape must have positive area");
  const centroid = { x: cx / area, y: cy / area };
  const unitInertia = jOrigin / area - (centroid.x * centroid.x + centroid.y * centroid.y);
  return { area, centroid, unitInertia };
}

/**
 * Ray vs segment. Returns distance t ≥ 0 along the unit-length `dir` where the ray hits segment ab,
 * or null. Parallel/collinear rays count as misses.
 */
export function raySegment(origin: Vec2, dir: Vec2, a: Vec2, b: Vec2): number | null {
  const ex = b.x - a.x;
  const ey = b.y - a.y;
  const den = dir.x * ey - dir.y * ex;
  if (Math.abs(den) < 1e-12) return null;
  const ox = a.x - origin.x;
  const oy = a.y - origin.y;
  const t = (ox * ey - oy * ex) / den;
  const s = (ox * dir.y - oy * dir.x) / den;
  if (t < 0 || s < 0 || s > 1) return null;
  return t;
}

/** Nearest hit of a ray against a polygon outline (null if none within maxDist). */
export function rayPolygon(
  origin: Vec2,
  dir: Vec2,
  poly: readonly Vec2[],
  maxDist = Infinity,
): number | null {
  let best: number | null = null;
  for (let i = 0; i < poly.length; i++) {
    const t = raySegment(origin, dir, poly[i]!, poly[(i + 1) % poly.length]!);
    if (t !== null && t <= maxDist && (best === null || t < best)) best = t;
  }
  return best;
}

/**
 * Separating-axis test for two convex polygons. Returns the minimum penetration depth (> 0 means
 * overlapping by that much; ≤ 0 means separated or merely touching).
 */
export function convexPenetration(p: readonly Vec2[], q: readonly Vec2[]): number {
  let minDepth = Infinity;
  for (const poly of [p, q]) {
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]!;
      const b = poly[(i + 1) % poly.length]!;
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len === 0) continue;
      const nx = (b.y - a.y) / len;
      const ny = -(b.x - a.x) / len;
      let pMin = Infinity,
        pMax = -Infinity,
        qMin = Infinity,
        qMax = -Infinity;
      for (const v of p) {
        const d = v.x * nx + v.y * ny;
        if (d < pMin) pMin = d;
        if (d > pMax) pMax = d;
      }
      for (const v of q) {
        const d = v.x * nx + v.y * ny;
        if (d < qMin) qMin = d;
        if (d > qMax) qMax = d;
      }
      const depth = Math.min(pMax - qMin, qMax - pMin);
      if (depth <= 0) return depth;
      if (depth < minDepth) minDepth = depth;
    }
  }
  return minDepth;
}

export interface Aabb {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

export function aabbOf(points: readonly Vec2[]): Aabb {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

export const aabbOverlap = (a: Aabb, b: Aabb, margin = 0): boolean =>
  a.minX - margin <= b.maxX &&
  b.minX - margin <= a.maxX &&
  a.minY - margin <= b.maxY &&
  b.minY - margin <= a.maxY;

/** Transform local points by rotation (radians) then translation. */
export function transformPoints(points: readonly Vec2[], angle: number, offset: Vec2): Vec2[] {
  return points.map((p) => add(rotate(p, angle), offset));
}

/** Even-odd point-in-polygon test (boundary points may go either way). */
export function pointInPolygon(pt: Vec2, poly: readonly Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a.y > pt.y !== b.y > pt.y && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x)
      inside = !inside;
  }
  return inside;
}

/** Closest points of segments p1→q1 and p2→q2: distance and parameters s, t in [0, 1] along each. */
export function segmentSegmentClosest(
  p1: Vec2,
  q1: Vec2,
  p2: Vec2,
  q2: Vec2,
): { dist: number; s: number; t: number } {
  const d1 = { x: q1.x - p1.x, y: q1.y - p1.y };
  const d2 = { x: q2.x - p2.x, y: q2.y - p2.y };
  const r = { x: p1.x - p2.x, y: p1.y - p2.y };
  const a = d1.x * d1.x + d1.y * d1.y;
  const e = d2.x * d2.x + d2.y * d2.y;
  const f = d2.x * r.x + d2.y * r.y;
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  let s: number;
  let t: number;
  if (a <= 1e-12 && e <= 1e-12) {
    s = 0;
    t = 0;
  } else if (a <= 1e-12) {
    s = 0;
    t = clamp(f / e);
  } else {
    const c = d1.x * r.x + d1.y * r.y;
    if (e <= 1e-12) {
      t = 0;
      s = clamp(-c / a);
    } else {
      const b = d1.x * d2.x + d1.y * d2.y;
      const denom = a * e - b * b;
      s = denom > 1e-12 ? clamp((b * f - c * e) / denom) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = clamp(-c / a);
      } else if (t > 1) {
        t = 1;
        s = clamp((b - c) / a);
      }
    }
  }
  const dx = p1.x + d1.x * s - (p2.x + d2.x * t);
  const dy = p1.y + d1.y * s - (p2.y + d2.y * t);
  return { dist: Math.hypot(dx, dy), s, t };
}

/**
 * Distance from segment p→q to a polygon (0 when the segment touches or enters it) and the parameter s
 * in [0, 1] of the closest point along the segment (the entry point when it enters).
 */
export function segmentPolygonDistance(p: Vec2, q: Vec2, poly: readonly Vec2[]): { dist: number; s: number } {
  if (pointInPolygon(p, poly)) return { dist: 0, s: 0 };
  const len = Math.hypot(q.x - p.x, q.y - p.y);
  if (len > 1e-12) {
    const hit = rayPolygon(p, { x: (q.x - p.x) / len, y: (q.y - p.y) / len }, poly, len);
    if (hit !== null) return { dist: 0, s: hit / len };
  }
  let best = { dist: Infinity, s: 0 };
  for (let i = 0; i < poly.length; i++) {
    const r = segmentSegmentClosest(p, q, poly[i]!, poly[(i + 1) % poly.length]!);
    if (r.dist < best.dist) best = { dist: r.dist, s: r.s };
  }
  return best;
}
