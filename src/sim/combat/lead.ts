import { type Vec2, dot, lengthSq, sub } from "../core/vec2";

/**
 * Intercept solution for a projectile fired at `speed` (relative to the shooter) from a shooter moving at
 * `shooterVel` toward a target moving at constant `targetVel` (spec §9.3, §9.6).
 * Returns the time to intercept and the world point to aim at, or null when no solution exists.
 */
export function intercept(
  shooterPos: Vec2,
  shooterVel: Vec2,
  targetPos: Vec2,
  targetVel: Vec2,
  speed: number,
): { t: number; aimPoint: Vec2 } | null {
  const r = sub(targetPos, shooterPos);
  const v = sub(targetVel, shooterVel); // projectile inherits shooter velocity
  // |r + v t| = speed t  →  (v·v − s²) t² + 2 (r·v) t + r·r = 0
  const a = lengthSq(v) - speed * speed;
  const b = 2 * dot(r, v);
  const c = lengthSq(r);
  let t: number;
  if (Math.abs(a) < 1e-9) {
    if (Math.abs(b) < 1e-12) return null;
    t = -c / b;
  } else {
    const disc = b * b - 4 * a * c;
    if (disc < 0) return null;
    const sq = Math.sqrt(disc);
    const t1 = (-b - sq) / (2 * a);
    const t2 = (-b + sq) / (2 * a);
    const candidates = [t1, t2].filter((x) => x > 0).sort((x, y) => x - y);
    if (candidates.length === 0) return null;
    t = candidates[0]!;
  }
  if (!(t > 0) || !Number.isFinite(t)) return null;
  return { t, aimPoint: { x: shooterPos.x + r.x + v.x * t, y: shooterPos.y + r.y + v.y * t } };
}
