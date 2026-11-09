import type { MissileDef } from "../../data/schemas/part";
import {
  type Vec2,
  add,
  angleOf,
  cross,
  degToRad,
  dot,
  fromAngle,
  length,
  rotate,
  scale,
  sub,
} from "../core/vec2";
import { segmentPolygonDistance } from "../core/geometry";
import { gravityAccel } from "../physics/forces";
import type { Ship } from "../ship/ship-entity";
import type { World } from "../world";
import { blast, pushEvent, raycastWorld } from "./combat-world";
import { MISSILE } from "./constants";

/**
 * A guided missile (spec §9.5): a point mass with a heading, a turn-rate limit, thrust while it has fuel,
 * gravity, HP, a proximity fuse and a blast warhead. Not a physics body.
 */
export interface Missile {
  readonly id: string;
  readonly owner: string;
  readonly team: number;
  pos: Vec2;
  vel: Vec2;
  /** World heading (rad); thrust acts along it. */
  heading: number;
  /** Burn time left (s). */
  fuel: number;
  hp: number;
  age: number;
  readonly def: MissileDef;
  /** Ship it homes on, or null (lost target: it coasts). */
  target: string | null;
  /** Decoys this missile has already had its one chance to be fooled by (sorted ids). */
  readonly rolled: string[];
  /** Launcher part id, for damage attribution. */
  readonly source?: string;
}

export function spawnMissile(
  world: World,
  ship: Ship,
  def: MissileDef,
  muzzle: Vec2,
  dir: Vec2,
  muzzleVelocity: Vec2,
  targetId: string,
  source?: string,
): Missile {
  const m: Missile = {
    id: world.ids.next("missile"),
    owner: ship.id,
    team: ship.team,
    pos: muzzle,
    vel: add(muzzleVelocity, scale(dir, MISSILE.launchSpeed)),
    heading: angleOf(dir),
    fuel: def.fuel,
    hp: def.hp,
    age: 0,
    def,
    target: targetId,
    rolled: [],
    ...(source ? { source } : {}),
  };
  world.combat.missiles.push(m);
  world.combat.stats.missilesLaunched++;
  return m;
}

const wrap = (a: number): number => {
  let x = (a + Math.PI) % (2 * Math.PI);
  if (x < 0) x += 2 * Math.PI;
  return x - Math.PI;
};

/**
 * Direction the missile wants to accelerate in. Proportional navigation (spec §9.5): lateral acceleration
 * N·Vc·(line-of-sight rate) across the line of sight, the rest of the thrust along it to keep closing.
 * Pursuit points straight at the target. Only used while the motor burns: without fuel a missile flies straight.
 */
export function guidanceDirection(m: Missile, targetPos: Vec2, targetVel: Vec2): Vec2 {
  const r = sub(targetPos, m.pos);
  const dist = length(r);
  if (dist < 1e-6) return fromAngle(m.heading);
  const rhat = scale(r, 1 / dist);
  if (m.def.guidance === "pursuit") return rhat;
  const v = sub(targetVel, m.vel);
  const losRate = cross(r, v) / (dist * dist);
  const closing = Math.max(-dot(r, v) / dist, 50);
  const aMax = m.def.thrust / m.def.mass;
  const n = m.def.navConstant ?? 3.5;
  const aLat = Math.max(-aMax, Math.min(aMax, n * closing * losRate));
  const aAlong = Math.sqrt(Math.max(0, aMax * aMax - aLat * aLat));
  const nhat = { x: -rhat.y, y: rhat.x };
  const d = add(scale(nhat, aLat), scale(rhat, aAlong));
  const len = length(d);
  return len > 1e-9 ? scale(d, 1 / len) : rhat;
}

/** One chance per decoy in range to pull the missile onto it (spec §9.7), rolled on the world RNG. */
function considerDecoys(world: World, m: Missile): void {
  for (const s of world.allShips()) {
    if (s.team === m.team || s.id === m.target || m.rolled.includes(s.id)) continue;
    const strength = s.decoyStrength;
    if (strength <= 0) continue;
    if (length(sub(world.physics.getWorldCenter(s.id), m.pos)) > MISSILE.decoyRange) continue;
    m.rolled.push(s.id);
    m.rolled.sort();
    if (world.rng.next() < strength) m.target = s.id;
  }
}

/** Closest approach of the path from→to to any enemy ship's hull this tick, if within the fuse distance. */
function fusePoint(world: World, m: Missile, from: Vec2, to: Vec2): Vec2 | null {
  let best: number | null = null;
  const reach = m.def.proximityFuse + length(sub(to, from));
  for (const s of world.allShips()) {
    if (s.team === m.team) continue;
    const p = world.physics.getBodyState(s.id);
    if (length(sub(p.position, from)) > s.layout.boundingRadius + reach) continue;
    const a = rotate(sub(from, p.position), -p.angle);
    const b = rotate(sub(to, p.position), -p.angle);
    for (const outline of s.layout.outlines.values()) {
      const r = segmentPolygonDistance(a, b, outline);
      if (r.dist <= m.def.proximityFuse && (best === null || r.s < best)) best = r.s;
    }
  }
  return best === null ? null : add(from, scale(sub(to, from), best));
}

function detonate(world: World, m: Missile, at: Vec2): void {
  blast(world, at, m.def.blastRadius, m.def.damage, {
    source: { ship: m.owner, source: m.source ?? "missile" },
  });
  pushEvent(world, "explosion", at, m.def.blastRadius * 0.4);
  world.combat.stats.missileHits++;
  m.hp = 0;
}

/** Past the arena edge by more than MISSILE.arenaMargin (a coasting missile never comes back). */
function outsideArena(world: World, p: Vec2): boolean {
  const a = world.arena;
  if (!a) return false;
  return (
    Math.abs(p.x) > a.width / 2 + MISSILE.arenaMargin || Math.abs(p.y) > a.height / 2 + MISSILE.arenaMargin
  );
}

/**
 * Step 10b: guide, move and fuse missiles. Runs after the physics step and projectiles, so missiles shot
 * down this tick are already gone. Guidance needs thrust: once the fuel is spent the missile stops steering
 * (and can no longer be pulled by decoys) and flies straight on, still able to hit whatever is in its path,
 * until it leaves the arena or has coasted for MISSILE.maxCoastTime.
 */
export function stepMissiles(world: World, dt: number): void {
  const keep: Missile[] = [];
  for (const m of world.combat.missiles) {
    if (m.hp <= 0) continue;
    const burning = m.fuel > 0;
    if (burning) considerDecoys(world, m);
    if (m.target && !world.hasShip(m.target)) m.target = null;
    let accel = gravityAccel(world.gravityWells, m.pos);
    if (burning && m.target) {
      const tp = world.physics.getWorldCenter(m.target);
      const tv = world.physics.getBodyState(m.target).linearVelocity;
      const want = angleOf(guidanceDirection(m, tp, tv));
      const maxTurn = degToRad(m.def.turnRate) * dt;
      const d = wrap(want - m.heading);
      m.heading = wrap(m.heading + Math.max(-maxTurn, Math.min(maxTurn, d)));
    }
    if (burning) {
      accel = add(accel, scale(fromAngle(m.heading), m.def.thrust / m.def.mass));
      m.fuel = Math.max(0, m.fuel - dt);
    }
    const from = m.pos;
    m.vel = add(m.vel, scale(accel, dt));
    const to = add(from, scale(m.vel, dt));
    m.age += dt;
    if (m.age >= MISSILE.armTime) {
      const fused = fusePoint(world, m, from, to);
      if (fused) {
        detonate(world, m, fused);
        continue;
      }
      const step = length(sub(to, from));
      if (step > 0) {
        const rock = raycastWorld(world, from, scale(sub(to, from), 1 / step), step, m.owner);
        if (rock && (rock.kind === "asteroid" || rock.kind === "debris")) {
          detonate(world, m, add(from, scale(sub(to, from), rock.t / step)));
          continue;
        }
      }
    }
    m.pos = to;
    if (!burning) {
      // Coasting: point along the flight path (the motor is dead, nothing turns it).
      if (length(m.vel) > 1e-6) m.heading = angleOf(m.vel);
      if (m.age > m.def.fuel + MISSILE.maxCoastTime || outsideArena(world, m.pos)) continue;
    }
    keep.push(m);
  }
  world.combat.missiles = keep;
}
