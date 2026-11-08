import { type Vec2, lengthSq, scale, ZERO } from "../core/vec2";

export interface WellLike {
  readonly position: Vec2;
  readonly mu: number;
  readonly softening: number;
  readonly cutoffRadius?: number | undefined;
}

/** Gravitational acceleration from point wells (spec §6.9): g = −μ r̂ / (r² + s²). */
export function gravityAccel(wells: readonly WellLike[], pos: Vec2): Vec2 {
  let ax = 0;
  let ay = 0;
  for (const w of wells) {
    const dx = w.position.x - pos.x;
    const dy = w.position.y - pos.y;
    const r2 = dx * dx + dy * dy;
    if (w.cutoffRadius !== undefined && r2 > w.cutoffRadius * w.cutoffRadius) continue;
    if (r2 === 0) continue;
    const r = Math.sqrt(r2);
    const g = w.mu / (r2 + w.softening * w.softening);
    ax += (dx / r) * g;
    ay += (dy / r) * g;
  }
  return { x: ax, y: ay };
}

export const BOUNDARY = {
  /** Acceleration per metre² past the edge (m/s² per m²). */
  k: 0.05,
  /** Distance from the edge at which the HUD starts warning (m). */
  warnDistance: 200,
} as const;

/** Soft arena boundary (spec §12): inward acceleration growing quadratically past the edge. Arena centred at origin. */
export function boundaryAccel(arena: { width: number; height: number } | null, pos: Vec2): Vec2 {
  if (!arena) return ZERO;
  const hw = arena.width / 2;
  const hh = arena.height / 2;
  const over = (v: number, h: number) => (v > h ? v - h : v < -h ? v + h : 0);
  const ox = over(pos.x, hw);
  const oy = over(pos.y, hh);
  if (ox === 0 && oy === 0) return ZERO;
  return { x: -Math.sign(ox) * BOUNDARY.k * ox * ox, y: -Math.sign(oy) * BOUNDARY.k * oy * oy };
}

export function nearBoundary(arena: { width: number; height: number } | null, pos: Vec2): boolean {
  if (!arena) return false;
  return (
    Math.abs(pos.x) > arena.width / 2 - BOUNDARY.warnDistance ||
    Math.abs(pos.y) > arena.height / 2 - BOUNDARY.warnDistance
  );
}

export const accelToForce = (a: Vec2, mass: number): Vec2 => (lengthSq(a) === 0 ? ZERO : scale(a, mass));
