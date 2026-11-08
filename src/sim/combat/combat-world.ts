import { type Vec2, add, angleOf, dot, length, rotate, scale, sub } from "../core/vec2";
import { rayPolygon } from "../core/geometry";
import { compareIds } from "../core/ids";
import { gravityAccel } from "../physics/forces";
import type { ContactImpulse } from "../physics/planck-adapter";
import type { Ship } from "../ship/ship-entity";
import type { World } from "../world";
import { COMBAT } from "./constants";
import { beamFalloff, collisionDamage, damageAlongRay } from "./damage";
import { updateWeapons, type FireOrder, type TargetInfo } from "./weapons";

/** A ballistic round in flight (spec §9.3). Not a physics body: hits are found by swept raycasts. */
export interface Projectile {
  readonly id: number;
  readonly owner: string;
  readonly team: number;
  pos: Vec2;
  vel: Vec2;
  readonly mass: number;
  readonly damage: number;
  age: number;
  readonly lifetime: number;
  /** Ammo / weapon kind for rendering (e.g. "kinetic-120"). */
  readonly kind: string;
}

export interface BeamTrace {
  readonly owner: string;
  readonly from: Vec2;
  readonly to: Vec2;
  readonly hit: boolean;
}

export interface CombatEvent {
  readonly tick: number;
  readonly kind: "fire" | "hit" | "beam-hit" | "explosion" | "destroyed" | "collision" | "eject";
  readonly pos: Vec2;
  readonly size: number;
}

export class CombatState {
  projectiles: Projectile[] = [];
  nextProjectileId = 1;
  /** Beams fired this tick (for rendering). */
  beams: BeamTrace[] = [];
  /** Recent events for effects (pruned after COMBAT.eventLifetime). */
  events: CombatEvent[] = [];
  /** Totals for tests and debugging. */
  stats = { shots: 0, hits: 0 };
}

interface ShipRayHit {
  readonly kind: "ship";
  readonly ship: Ship;
  /** Distance along the ray to the first part entered (m). */
  readonly t: number;
  /** All parts entered along the ray (first hits, nearest first), including those behind the first. */
  readonly hits: { uid: string; t: number }[];
}
interface RockRayHit {
  /** Asteroids and debris: inert obstacles that stop rounds. */
  readonly kind: "asteroid" | "debris";
  readonly id: string;
  readonly t: number;
}
export type RayHit = ShipRayHit | RockRayHit;

/** Pose of a body: world position of its origin and angle. */
function pose(world: World, id: string): { position: Vec2; angle: number } {
  const s = world.physics.getBodyState(id);
  return { position: s.position, angle: s.angle };
}

/** Nearest ship part or asteroid hit by a world-space ray within maxDist. */
export function raycastWorld(
  world: World,
  origin: Vec2,
  dir: Vec2,
  maxDist: number,
  excludeShip?: string,
): RayHit | null {
  let best: RayHit | null = null;
  for (const ship of world.allShips()) {
    if (ship.id === excludeShip) continue;
    const p = pose(world, ship.id);
    // Broad phase: distance from the ship origin to the ray segment.
    const rel = sub(p.position, origin);
    const along = Math.max(0, Math.min(maxDist, dot(rel, dir)));
    const closest = sub(rel, scale(dir, along));
    if (length(closest) > ship.layout.boundingRadius + 0.5) continue;
    const lo = rotate(sub(origin, p.position), -p.angle);
    const ld = rotate(dir, -p.angle);
    const hits = ship.layout.raycastAll(lo, ld, maxDist + COMBAT.passThroughReach);
    const first = hits[0];
    if (!first || first.t > maxDist) continue;
    if (!best || first.t < best.t) best = { kind: "ship", ship, t: first.t, hits };
  }
  for (const a of world.asteroids) {
    const p = pose(world, a.id);
    const lo = rotate(sub(origin, p.position), -p.angle);
    const ld = rotate(dir, -p.angle);
    const t = rayPolygon(lo, ld, a.outline, maxDist);
    if (t !== null && (!best || t < best.t)) best = { kind: "asteroid", id: a.id, t };
  }
  for (const d of world.debris) {
    const p = pose(world, d.id);
    const rel = sub(p.position, origin);
    const along = Math.max(0, Math.min(maxDist, dot(rel, dir)));
    if (length(sub(rel, scale(dir, along))) > d.radius + 0.5) continue;
    const lo = rotate(sub(origin, p.position), -p.angle);
    const ld = rotate(dir, -p.angle);
    for (const pc of d.pieces) {
      const t = rayPolygon(lo, ld, pc.outline, maxDist);
      if (t !== null && (!best || t < best.t)) best = { kind: "debris", id: d.id, t };
    }
  }
  return best;
}

function pushEvent(world: World, kind: CombatEvent["kind"], pos: Vec2, size: number): void {
  world.combat.events.push({ tick: world.tick, kind, pos, size });
}

/** Applies a hit along a ship ray: wrecks pass part of it on, the first intact part takes the rest. */
function damageShipAlongRay(world: World, hit: ShipRayHit, damage: number, minDamage: number): string | null {
  const ship = hit.ship;
  const targets = hit.hits.map((h) => {
    const p = ship.part(h.uid);
    return { uid: h.uid, intact: p.hp > 0, armor: p.def.def.armor ?? 0 };
  });
  const res = damageAlongRay(targets, damage, minDamage);
  for (const a of res.applied)
    if (ship.applyDamage(a.uid, a.damage))
      pushEvent(world, "destroyed", worldPartCenter(world, ship, a.uid), 2);
  return res.stoppedBy;
}

function worldPartCenter(world: World, ship: Ship, uid: string): Vec2 {
  const p = pose(world, ship.id);
  const part = ship.part(uid);
  return add(p.position, rotate(add(part.position, rotate(part.def.centroid, part.angle)), p.angle));
}

/** Target for AI-mode groups: the selected target, else the nearest enemy ship. */
function aiTarget(world: World, ship: Ship): TargetInfo | null {
  const me = world.physics.getWorldCenter(ship.id);
  let chosen: Ship | null = null;
  const sel = ship.weaponCommand.targetId;
  if (sel && world.hasShip(sel)) chosen = world.getShip(sel);
  else {
    let best = Infinity;
    for (const other of world.allShips()) {
      if (other.team === ship.team || other.defeated) continue;
      const d = length(sub(world.physics.getWorldCenter(other.id), me));
      if (d < best) {
        best = d;
        chosen = other;
      }
    }
  }
  if (!chosen) return null;
  const s = world.physics.getBodyState(chosen.id);
  return { id: chosen.id, position: world.physics.getWorldCenter(chosen.id), velocity: s.linearVelocity };
}

/** Step 9 (plan §13.3): weapons aim and fire; projectiles spawn, beams resolve immediately. */
export function fireWeapons(world: World, dt: number): void {
  world.combat.beams = [];
  for (const ship of world.allShips()) {
    if (ship.weapons.length === 0) continue;
    const enabled = !(world.enforceDefeat && ship.defeated);
    const p = pose(world, ship.id);
    const orders = updateWeapons(
      ship.weapons,
      {
        isCommanded: (uid) => ship.isCommanded(uid),
        powerFactor: (uid) => ship.powerFactorOf(uid),
        drawRounds: (uid, n) => ship.drawRounds(uid, n),
        addHeat: (j) => ship.addHeat(j),
        setBeamActive: (uid, on) => (on ? ship.activeWeapons.add(uid) : ship.activeWeapons.delete(uid)),
      },
      ship.weaponCommand,
      ship.groupModes,
      { position: p.position, angle: p.angle, velocityAt: (pt) => world.physics.velocityAt(ship.id, pt) },
      ship.weapons.some((w) => (ship.groupModes.get(w.group) ?? "manual") === "ai")
        ? aiTarget(world, ship)
        : null,
      world.rng,
      dt,
      enabled,
    );
    for (const o of orders) resolveOrder(world, ship, o, dt);
  }
}

function resolveOrder(world: World, ship: Ship, o: FireOrder, dt: number): void {
  const def = o.weapon.def;
  if (o.kind === "projectile" && def.projectile) {
    const pr = def.projectile;
    world.combat.projectiles.push({
      id: world.combat.nextProjectileId++,
      owner: ship.id,
      team: ship.team,
      pos: o.muzzle,
      vel: add(o.muzzleVelocity, scale(o.dir, pr.speed)),
      mass: pr.mass,
      damage: pr.damage,
      age: 0,
      lifetime: pr.lifetime,
      kind: def.ammoType ?? def.kind,
    });
    // Recoil.
    world.physics.applyImpulse(
      ship.id,
      scale(o.dir, -pr.mass * pr.speed * COMBAT.momentumTransfer),
      o.muzzle,
    );
    world.combat.stats.shots++;
    pushEvent(world, "fire", o.muzzle, 1);
    return;
  }
  if (o.kind === "beam" && def.beam) {
    const hit = raycastWorld(world, o.muzzle, o.dir, def.range, ship.id);
    const to = add(o.muzzle, scale(o.dir, hit ? hit.t : def.range));
    world.combat.beams.push({ owner: ship.id, from: o.muzzle, to, hit: !!hit });
    if (hit?.kind === "ship") {
      const dmg =
        def.beam.dps *
        dt *
        beamFalloff(hit.t, def.beam.falloffStart, def.range) *
        ship.powerFactorOf(o.weapon.uid);
      damageShipAlongRay(world, hit, dmg, COMBAT.minDamage * dt);
      if (world.tick % 6 === 0) pushEvent(world, "beam-hit", to, 1);
    }
  }
}

/** Step 10: move projectiles (with gravity) and resolve swept hits. */
export function stepProjectiles(world: World, dt: number): void {
  const keep: Projectile[] = [];
  for (const pr of world.combat.projectiles) {
    const g = gravityAccel(world.gravityWells, pr.pos);
    pr.vel = add(pr.vel, scale(g, dt));
    const step = scale(pr.vel, dt);
    const dist = length(step);
    if (dist > 0) {
      const dir = scale(step, 1 / dist);
      const hit = raycastWorld(world, pr.pos, dir, dist, pr.owner);
      if (hit) {
        const at = add(pr.pos, scale(dir, hit.t));
        if (hit.kind === "ship") {
          const vTarget = world.physics.velocityAt(hit.ship.id, at);
          world.physics.applyImpulse(
            hit.ship.id,
            scale(sub(pr.vel, vTarget), pr.mass * COMBAT.momentumTransfer),
            at,
          );
          damageShipAlongRay(world, hit, pr.damage, COMBAT.minDamage);
          world.combat.stats.hits++;
        }
        pushEvent(world, "hit", at, Math.min(3, 0.5 + pr.damage / 150));
        continue;
      }
    }
    pr.pos = add(pr.pos, step);
    pr.age += dt;
    if (pr.age < pr.lifetime) keep.push(pr);
  }
  world.combat.projectiles = keep;
}

/** Collision damage from contact impulses (spec §6.8). Both contacting ship parts take damage. */
export function applyContactDamage(world: World, contacts: readonly ContactImpulse[]): void {
  for (const c of contacts) {
    const dmg = collisionDamage(c.impulse);
    if (dmg <= 0) continue;
    for (const tag of [c.tagA, c.tagB]) {
      const slash = tag.indexOf("/");
      if (slash < 0) continue; // asteroid or well: indestructible
      const shipId = tag.slice(0, slash);
      const uid = tag.slice(slash + 1);
      if (!world.hasShip(shipId)) continue;
      const ship = world.getShip(shipId);
      if (ship.applyDamage(uid, dmg)) pushEvent(world, "destroyed", worldPartCenter(world, ship, uid), 2);
    }
    const shipTag = [c.tagA, c.tagB].find((t) => t.includes("/"));
    if (shipTag) {
      const ship = world.getShip(shipTag.slice(0, shipTag.indexOf("/")));
      pushEvent(world, "collision", world.physics.getWorldCenter(ship.id), 1);
    }
  }
}

/** Exploding parts (spec §8): blast damage to nearby parts of the same ship, chaining deterministically. */
export function processExplosions(world: World): void {
  for (let guard = 0; guard < 1000; guard++) {
    const ship = world.allShips().find((s) => s.pendingExplosions.length > 0);
    if (!ship) return;
    const e = ship.pendingExplosions.shift()!;
    const p = pose(world, ship.id);
    pushEvent(world, "explosion", add(p.position, rotate(e.center, p.angle)), e.radius);
    ship.applyBlast(e.center, e.radius, e.damage, e.uid);
  }
}

export function pruneEvents(world: World): void {
  const minTick = world.tick - Math.round(COMBAT.eventLifetime * 60);
  if (world.combat.events.length && world.combat.events[0]!.tick < minTick) {
    world.combat.events = world.combat.events.filter((e) => e.tick >= minTick);
  }
}

/** Sorted ids helper for snapshots. */
export const byId = (a: { id: string }, b: { id: string }) => compareIds(a.id, b.id);
export const angleOfVec = angleOf;
