import {
  type Vec2,
  add,
  angleOf,
  dot,
  length,
  lengthSq,
  normalize,
  rotate,
  scale,
  sub,
  vec2,
} from "../core/vec2";
import type { ControlIntent } from "../flight/controller";
import type { Ship } from "../ship/ship-entity";
import type { World } from "../world";
import type { CapabilityProfile } from "./capabilities";

/**
 * Steering layer (plan M6 task 2): a behaviour asks for a velocity and a heading; this turns them into the
 * same ControlIntent a player produces (spec §11.1). It never applies forces itself.
 */
export interface Steering {
  /** World velocity the ship should have (m/s). */
  readonly desiredVel: Vec2;
  /** World heading to hold (rad), or null to let the steering choose (e.g. to burn). */
  readonly faceAngle: number | null;
  /** May turn away from faceAngle to use its strongest engines when the velocity error is large. */
  readonly mayBurn: boolean;
  /** Cut thrust entirely (cool down). */
  readonly coast?: boolean;
}

export const STEER = {
  /** Velocity error (m/s) the ship tries to remove per second of full thrust (response time, s). */
  responseTime: 0.6,
  /** Velocity error above which a ship may turn to burn with its strongest axis (m/s). */
  burnThreshold: 15,
  /** Turn to burn when the current orientation offers less than this share of the strongest axis. */
  burnRatio: 0.5,
  /** Asteroid look-ahead (s) and clearance beyond the rock's and ship's radii (m). */
  lookAhead: 5,
  clearance: 40,
  /** Arena boundary margin where steering starts pushing inward (m), and the inward speed at the edge. */
  boundaryMargin: 600,
  boundarySpeed: 80,
} as const;

/** Local axes (unit vectors in the ship frame) and the acceleration each offers. */
function axes(caps: CapabilityProfile): [Vec2, number][] {
  return [
    [vec2(1, 0), caps.accel.fwd],
    [vec2(-1, 0), caps.accel.back],
    [vec2(0, 1), caps.accel.left],
    [vec2(0, -1), caps.accel.right],
  ];
}

/** Acceleration available along a local unit direction (ellipse of the axis maxima). */
function accelAlong(caps: CapabilityProfile, u: Vec2): number {
  const ax = u.x >= 0 ? caps.accel.fwd : caps.accel.back;
  const ay = u.y >= 0 ? caps.accel.left : caps.accel.right;
  if ((Math.abs(u.x) > 1e-6 && ax <= 0) || (Math.abs(u.y) > 1e-6 && ay <= 0)) return 0;
  const s = Math.hypot(ax > 0 ? u.x / ax : 0, ay > 0 ? u.y / ay : 0);
  return s > 0 ? 1 / s : 0;
}

export function steerToIntent(world: World, ship: Ship, caps: CapabilityProfile, s: Steering): ControlIntent {
  const body = world.physics.getBodyState(ship.id);
  const angle = body.angle;
  if (s.coast) return { thrust: vec2(0, 0), rotate: 0, faceAngle: s.faceAngle ?? undefined };
  const dv = sub(s.desiredVel, body.linearVelocity);
  const dvLen = length(dv);
  let face = s.faceAngle ?? angle;
  if (s.mayBurn && dvLen > STEER.burnThreshold) {
    const local = rotate(scale(dv, 1 / dvLen), -angle);
    const [bestAxis, best] = axes(caps).reduce((a, b) => (b[1] > a[1] ? b : a));
    if (best > 0 && accelAlong(caps, local) < STEER.burnRatio * best) face = angleOf(dv) - angleOf(bestAxis);
  }
  const local = rotate(dv, -angle);
  const axis = (v: number, pos: number, neg: number) => {
    const a = v >= 0 ? pos : neg;
    return a > 0 ? Math.max(-1, Math.min(1, v / (a * STEER.responseTime))) : 0;
  };
  const thrust =
    dvLen < 0.2
      ? vec2(0, 0)
      : vec2(
          axis(local.x, caps.accel.fwd, caps.accel.back),
          axis(local.y, caps.accel.left, caps.accel.right),
        );
  return { thrust, rotate: 0, faceAngle: face };
}

const rockRadius = new WeakMap<readonly Vec2[], number>();
function radiusOf(outline: readonly Vec2[]): number {
  let r = rockRadius.get(outline);
  if (r === undefined) {
    r = Math.max(...outline.map((v) => length(v)));
    rockRadius.set(outline, r);
  }
  return r;
}

/**
 * Bends a desired velocity around asteroids on a collision course within STEER.lookAhead and away from
 * the arena boundary (plan M6 task 2). Deterministic: rocks are visited in world order.
 */
export function avoidObstacles(world: World, ship: Ship, desired: Vec2): Vec2 {
  const pos = world.physics.getWorldCenter(ship.id);
  const me = ship.layout.boundingRadius;
  let out = desired;
  const v = desired;
  const vv = lengthSq(v);
  if (vv > 1) {
    for (const a of world.asteroids) {
      const rp = world.physics.getBodyState(a.id).position;
      const rel = sub(rp, pos);
      const safe = radiusOf(a.outline) + me + STEER.clearance;
      if (length(rel) - safe > Math.sqrt(vv) * STEER.lookAhead) continue;
      const t = Math.max(0, Math.min(STEER.lookAhead, dot(rel, v) / vv));
      const closest = sub(rel, scale(v, t));
      const miss = length(closest);
      if (miss >= safe) continue;
      const away = miss > 1e-6 ? normalize(scale(closest, -1)) : normalize(vec2(-v.y, v.x));
      const k = (safe - miss) / safe;
      out = add(out, scale(away, k * (Math.sqrt(vv) + 20)));
    }
  }
  const arena = world.arena;
  if (arena) {
    const hw = arena.width / 2;
    const hh = arena.height / 2;
    const now = world.physics.getBodyState(ship.id).linearVelocity;
    // The faster the ship already heads for an edge, the earlier it starts turning back.
    const push = (p: number, half: number, vel: number, cur: number): number => {
      const outSpeed = Math.max(0, Math.sign(p) * cur);
      const margin = STEER.boundaryMargin + outSpeed * STEER.lookAhead;
      const toEdge = half - Math.abs(p);
      if (toEdge > margin) return vel;
      const inward = -Math.sign(p) * STEER.boundarySpeed * (1 - Math.max(0, toEdge) / margin);
      const outward = Math.sign(p) * vel > 0;
      return outward ? inward : vel + inward * 0.5;
    };
    out = vec2(push(pos.x, hw, out.x, now.x), push(pos.y, hh, out.y, now.y));
  }
  return out;
}
