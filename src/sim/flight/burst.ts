import { type Vec2, length, rotate, scale } from "../core/vec2";
import type { BurstKind } from "./controller";

/**
 * Burst engines (docs/flight.md): a short, strong push, then a cooldown. The engine swivels so its push
 * always goes through the centre of mass, wherever it is mounted, so a burst never turns the ship. Side
 * engines jolt the ship sideways, rear ones forward; an engine whose nozzle faces forward (pushing backwards)
 * fires against the ship's velocity instead, as a retro burst.
 */
export function burstKind(dir: Vec2): BurstKind {
  if (dir.x < -0.5) return "back";
  if (dir.x > 0.5) return "forward";
  return dir.y >= 0 ? "left" : "right";
}

/** Below this relative speed (m/s) a retro burst has nothing to push against. */
export const RETRO_MIN_SPEED = 0.05;

/**
 * Push of one burst engine this tick in the ship frame: along its own direction, or for a retro burst against
 * the velocity relative to `reference`, never more than stops the ship in one tick.
 */
export function burstPush(
  kind: BurstKind,
  dir: Vec2,
  force: number,
  ship: { angle: number; velocity: Vec2; reference: Vec2; mass: number; dt: number },
): Vec2 {
  if (kind !== "back") return scale(dir, force);
  const rel = { x: ship.velocity.x - ship.reference.x, y: ship.velocity.y - ship.reference.y };
  const speed = length(rel);
  if (speed < RETRO_MIN_SPEED) return { x: 0, y: 0 };
  const f = Math.min(force, (ship.mass * speed) / ship.dt);
  return rotate({ x: (-rel.x / speed) * f, y: (-rel.y / speed) * f }, -ship.angle);
}
