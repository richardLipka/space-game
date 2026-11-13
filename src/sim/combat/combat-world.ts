import { type Vec2, add, dot, length, lengthSq, normalize, rotate, scale, sub } from "../core/vec2";
import { rayPolygon } from "../core/geometry";
import { gravityAccel } from "../physics/forces";
import type { ContactImpulse } from "../physics/planck-adapter";
import type { PartInstance } from "../ship/ship";
import type { TargetPriority } from "../../data/schemas/design";
import { partCentroid } from "../ship/ship";
import type { Ship } from "../ship/ship-entity";
import type { World } from "../world";
import { COMBAT, MISSILE } from "./constants";
import { beamFalloff, collisionDamage, damageAlongRay } from "./damage";
import type { Missile } from "./missiles";
import { spawnMissile } from "./missiles";
import { intercept } from "./lead";
import {
  closestApproach,
  firstEngageable,
  orderShipTargets,
  orderByPriority,
  rankThreats,
  type Contact,
  type Defender,
} from "./targeting";
import { updateWeapons, type FireOrder, type WeaponTargeting } from "./weapons";

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
  /** Weapon part id that fired it, for damage attribution (balance harness). */
  readonly source?: string;
  /**
   * Burst shell (flak, spec §9.6): bursts when an enemy missile or drone passes within `proximity`, or at
   * `time` (the predicted intercept), damaging everything hostile within `radius`.
   */
  readonly fuse?: {
    readonly proximity: number;
    readonly radius: number;
    readonly damage: number;
    readonly time: number | null;
  };
}

export interface BeamTrace {
  readonly owner: string;
  readonly from: Vec2;
  readonly to: Vec2;
  readonly hit: boolean;
}

export interface CombatEvent {
  readonly tick: number;
  readonly kind:
    | "fire"
    | "hit"
    | "beam-hit"
    | "explosion"
    | "destroyed"
    | "collision"
    | "eject"
    | "burst"
    | "missile-down"
    | "launch";
  readonly pos: Vec2;
  readonly size: number;
}

export class CombatState {
  projectiles: Projectile[] = [];
  nextProjectileId = 1;
  /** Guided missiles in flight (spec §9.5), sorted by id. */
  missiles: Missile[] = [];
  /** Beams fired this tick (for rendering). */
  beams: BeamTrace[] = [];
  /** Recent events for effects (pruned after COMBAT.eventLifetime). */
  events: CombatEvent[] = [];
  /** Totals for tests and debugging. */
  stats = { shots: 0, hits: 0, missilesLaunched: 0, missilesDown: 0, missileHits: 0 };
  /**
   * Hull damage dealt, by attacking ship and weapon part id (drone damage counts for the carrier, as
   * "drone:<part>"). Read by the balance harness; not part of the simulation state.
   */
  damage: Record<string, Record<string, number>> = {};
}

/** Who did the damage: attacking ship (null for collisions) and the weapon part id. */
export interface DamageSource {
  readonly ship: string | null;
  readonly source: string;
}

const hullHp = (ship: Ship) => ship.parts.reduce((s, p) => s + Math.max(0, p.hp), 0);

/** Credits hull damage to its source; drones credit their carrier. */
export function recordDamage(world: World, src: DamageSource | undefined, amount: number): void {
  if (!src || amount <= 0) return;
  let attacker = src.ship ?? "environment";
  let source = src.source;
  if (src.ship && world.hasShip(src.ship)) {
    const s = world.getShip(src.ship);
    if (s.drone) {
      attacker = s.drone.mother;
      source = `drone:${source}`;
    }
  }
  const row = (world.combat.damage[attacker] ??= {});
  row[source] = (row[source] ?? 0) + amount;
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
interface MissileRayHit {
  readonly kind: "missile";
  readonly missile: Missile;
  readonly t: number;
}
export type RayHit = ShipRayHit | RockRayHit | MissileRayHit;

/** Pose of a body: world position of its origin and angle. */
function pose(world: World, id: string): { position: Vec2; angle: number } {
  const s = world.physics.getBodyState(id);
  return { position: s.position, angle: s.angle };
}

/** Distance along a unit ray to a circle, or null. */
function rayCircle(origin: Vec2, dir: Vec2, center: Vec2, radius: number, maxDist: number): number | null {
  const oc = sub(origin, center);
  const b = dot(oc, dir);
  const c = lengthSq(oc) - radius * radius;
  if (c <= 0) return 0;
  const disc = b * b - c;
  if (disc < 0) return null;
  const t = -b - Math.sqrt(disc);
  return t >= 0 && t <= maxDist ? t : null;
}

/**
 * Nearest ship part, asteroid, debris or (when `missileTeam` is given) missile of another team hit by a
 * world-space ray within maxDist.
 */
export function raycastWorld(
  world: World,
  origin: Vec2,
  dir: Vec2,
  maxDist: number,
  excludeShip?: string,
  missileTeam?: number,
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
  if (missileTeam !== undefined) {
    for (const m of world.combat.missiles) {
      if (m.team === missileTeam || m.hp <= 0) continue;
      const t = rayCircle(origin, dir, m.pos, MISSILE.radius, maxDist);
      if (t !== null && (!best || t < best.t)) best = { kind: "missile", missile: m, t };
    }
  }
  return best;
}

export function pushEvent(world: World, kind: CombatEvent["kind"], pos: Vec2, size: number): void {
  world.combat.events.push({ tick: world.tick, kind, pos, size });
}

/** Applies a hit along a ship ray: wrecks pass part of it on, the first intact part takes the rest. */
function damageShipAlongRay(
  world: World,
  hit: ShipRayHit,
  damage: number,
  minDamage: number,
  src?: DamageSource,
): string | null {
  const ship = hit.ship;
  const before = hullHp(ship);
  const targets = hit.hits.map((h) => {
    const p = ship.part(h.uid);
    return { uid: h.uid, intact: p.hp > 0, armor: p.def.def.armor ?? 0 };
  });
  const res = damageAlongRay(targets, damage, minDamage);
  for (const a of res.applied)
    if (ship.applyDamage(a.uid, a.damage))
      pushEvent(world, "destroyed", worldPartCenter(world, ship, a.uid), 2);
  for (const a of res.absorbed) ship.damageWreck(a.uid, a.damage);
  recordDamage(world, src, before - hullHp(ship));
  return res.stoppedBy;
}

function worldPartCenter(world: World, ship: Ship, uid: string): Vec2 {
  const p = pose(world, ship.id);
  const part = ship.part(uid);
  return add(p.position, rotate(add(part.position, rotate(part.def.centroid, part.angle)), p.angle));
}

/** Damage to a missile; it is destroyed at 0 HP. */
function damageMissile(world: World, m: Missile, damage: number): void {
  if (m.hp <= 0) return;
  m.hp -= damage;
  if (m.hp <= 0) {
    world.combat.stats.missilesDown++;
    pushEvent(world, "missile-down", m.pos, 1);
  }
}

/**
 * Blast at a world point (missile warheads, flak bursts; spec §8, §9.5): parts within `radius` take
 * `damage` falling off linearly, after armor; every wreck between the blast and a part halves its share
 * (COMBAT.wreckAbsorb). `hostileTo` limits it to ships and missiles of other teams (flak); missile warheads
 * hurt everyone. Missiles inside a flak burst take the burst damage.
 */
export function blast(
  world: World,
  center: Vec2,
  radius: number,
  damage: number,
  opts: { hostileTo?: number; missiles?: boolean; source?: DamageSource } = {},
): void {
  for (const ship of world.allShips()) {
    if (opts.hostileTo !== undefined && ship.team === opts.hostileTo) continue;
    const p = pose(world, ship.id);
    if (length(sub(p.position, center)) > ship.layout.boundingRadius + radius) continue;
    const local = rotate(sub(center, p.position), -p.angle);
    const before = hullHp(ship);
    const destroyed = ship.applyBlast(local, radius, damage, undefined, (part, dist) =>
      shelter(ship, local, part, dist),
    );
    for (const uid of destroyed) pushEvent(world, "destroyed", worldPartCenter(world, ship, uid), 2);
    // Friendly fire is not credited.
    if (
      !opts.source?.ship ||
      !world.hasShip(opts.source.ship) ||
      world.getShip(opts.source.ship).team !== ship.team
    )
      recordDamage(world, opts.source, before - hullHp(ship));
  }
  if (opts.missiles) {
    for (const m of world.combat.missiles) {
      if (opts.hostileTo !== undefined && m.team === opts.hostileTo) continue;
      if (length(sub(m.pos, center)) <= radius) damageMissile(world, m, damage);
    }
  }
}

/** Share of a blast that reaches `part`: halved by every wreck on the straight line from the blast. */
function shelter(ship: Ship, center: Vec2, part: PartInstance, dist: number): number {
  if (dist < 1e-6) return 1;
  const dir = normalize(sub(partCentroid(part), center));
  let k = 1;
  for (const h of ship.layout.raycastAll(center, dir, dist)) {
    if (h.uid === part.uid || h.t >= dist - 1e-6) continue;
    if (ship.part(h.uid).hp <= 0) k *= 1 - COMBAT.wreckAbsorb;
  }
  return k;
}

/** Rough damage per second of a ship's working guns and beams (threat priority). */
function gunDps(s: Ship): number {
  let dps = 0;
  for (const w of s.weapons) {
    if (w.part.hp <= 0 || w.def.kind === "pd") continue;
    if (w.def.projectile) dps += w.def.projectile.damage / w.def.fireInterval;
    else if (w.def.beam) dps += w.def.beam.dps;
    else if (w.def.kind === "missile") dps += (s.nextMissile(w.uid)?.damage ?? 0) / w.def.fireInterval;
  }
  return dps;
}

function hullFraction(s: Ship): number {
  let hp = 0;
  let max = 0;
  for (const p of s.parts) {
    hp += Math.max(0, p.hp);
    max += p.def.def.hp;
  }
  return max > 0 ? hp / max : 0;
}

/** Everything that can be targeted this tick (spec §9.6): live ships, drones and missiles. */
export function contactsOf(world: World): Contact[] {
  const out: Contact[] = [];
  for (const s of world.allShips()) {
    if (s.defeated || s.inert) continue;
    out.push({
      id: s.id,
      kind: s.drone ? "drone" : "ship",
      team: s.team,
      position: world.physics.getWorldCenter(s.id),
      velocity: world.physics.getBodyState(s.id).linearVelocity,
      targetId: null,
      decoy: s.decoyStrength > 0,
      radius: Math.max(1, s.layout.boundingRadius * 0.6),
      threat: gunDps(s),
      hull: hullFraction(s),
    });
  }
  for (const m of world.combat.missiles) {
    if (m.hp <= 0) continue;
    out.push({
      id: m.id,
      kind: "missile",
      team: m.team,
      position: m.pos,
      velocity: m.vel,
      targetId: m.target,
      decoy: false,
      radius: MISSILE.radius,
    });
  }
  return out;
}

/** Targeting for one ship's automatic weapons, built from this tick's contacts. */
function targetingFor(world: World, ship: Ship, contacts: readonly Contact[]): WeaponTargeting {
  const me: Defender = {
    id: ship.id,
    team: ship.team,
    position: world.physics.getWorldCenter(ship.id),
    velocity: world.physics.getBodyState(ship.id).linearVelocity,
  };
  let threats: Contact[] | null = null;
  let ships: Contact[] | null = null;
  let inbound: Contact[] | null = null;
  let homing: Contact[] | null = null;
  const byPriority = new Map<TargetPriority, Contact[]>();
  const shipList = () => (ships ??= orderShipTargets(contacts, me, ship.weaponCommand.targetId));
  const priorityList = (p: TargetPriority): Contact[] => {
    const cached = byPriority.get(p);
    if (cached) return cached;
    const l = orderByPriority(contacts, me, p, ship.weaponCommand.targetId);
    byPriority.set(p, l);
    return l;
  };
  // Every missile homing on this ship, most urgent first (groups with the "missiles" priority).
  const homingList = () =>
    (homing ??= rankThreats(contacts, me).filter((c) => c.kind === "missile" && c.targetId === ship.id));
  // Missiles homing on this ship and about to arrive: AI-mode turrets shoot at them first (spec §9.5:
  // any round can down a missile; decision log: Turret missile defense).
  const inboundList = () =>
    (inbound ??= rankThreats(contacts, me).filter(
      (c) =>
        c.kind === "missile" &&
        c.targetId === ship.id &&
        closestApproach(c, me).t < COMBAT.turretMissileDefense,
    ));
  return {
    ship: (w, mount) => {
      // Group settings from the design (decision log: Weapon groups): fire range and target priority.
      const g = ship.groupSettings.get(w.group);
      const priority = (g?.priority ?? "target") as TargetPriority;
      const range = g?.range ?? Infinity;
      if (priority === "missiles") {
        const m = firstEngageable(w, mount, homingList(), 0, range);
        if (m) return m;
      } else if (w.def.mount === "turret") {
        const m = firstEngageable(w, mount, inboundList(), 0, range);
        if (m) return m;
      }
      return firstEngageable(w, mount, priorityList(priority), ship.minHitProbability, range);
    },
    pd: (w, mount) => {
      threats ??= rankThreats(contacts, me);
      return (
        firstEngageable(w, mount, threats) ??
        (ship.pdEngageShips ? firstEngageable(w, mount, shipList()) : null)
      );
    },
  };
}

/** Step 9 (plan §13.3): weapons aim and fire; projectiles and missiles spawn, beams resolve immediately. */
export function fireWeapons(world: World, dt: number): void {
  world.combat.beams = [];
  const contacts = contactsOf(world);
  for (const ship of world.allShips()) {
    if (ship.weapons.length === 0) continue;
    const enabled = !(world.enforceDefeat && ship.defeated) && !ship.inert;
    const p = pose(world, ship.id);
    const orders = updateWeapons(
      ship.weapons,
      {
        isCommanded: (uid) => ship.isCommanded(uid),
        powerFactor: (uid) => ship.powerFactorOf(uid),
        drawRounds: (uid, n) => ship.drawRounds(uid, n),
        nextMissile: (uid) => ship.nextMissile(uid),
        drawMissile: (uid) => ship.drawMissile(uid),
        rocketAligned: (muzzle, mountAngle, targetId) =>
          rocketAligned(world, ship, muzzle, mountAngle, targetId),
        addHeat: (j) => ship.addHeat(j),
        setBeamActive: (uid, on) => (on ? ship.activeWeapons.add(uid) : ship.activeWeapons.delete(uid)),
      },
      ship.weaponCommand,
      ship.groupModes,
      { position: p.position, angle: p.angle, velocityAt: (pt) => world.physics.velocityAt(ship.id, pt) },
      targetingFor(world, ship, contacts),
      world.rng,
      dt,
      enabled,
    );
    for (const o of orders) resolveOrder(world, ship, o, dt);
    if (ship.weaponCommand.launch) ship.weaponCommand = { ...ship.weaponCommand, launch: false };
  }
}

/**
 * Does a launcher point at where a rocket fired now would meet the target? (The AI holds rockets until then;
 * with no target there is nothing to wait for.) A rocket's average speed over its flight is taken as 300 m/s.
 */
function rocketAligned(
  world: World,
  ship: Ship,
  muzzle: Vec2,
  mountAngle: number,
  targetId: string | null,
): boolean {
  if (!targetId || !world.hasShip(targetId)) return true;
  const tp = world.physics.getWorldCenter(targetId);
  const tv = world.physics.getBodyState(targetId).linearVelocity;
  const sol = intercept(muzzle, world.physics.velocityAt(ship.id, muzzle), tp, tv, 300);
  const to = sub(sol?.aimPoint ?? tp, muzzle);
  let d = (Math.atan2(to.y, to.x) - mountAngle) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  return Math.abs(d) <= MISSILE.rocketAlign;
}

function resolveOrder(world: World, ship: Ship, o: FireOrder, dt: number): void {
  const def = o.weapon.def;
  if (o.kind === "missile" && o.missile) {
    const targetId = o.targetId && world.hasShip(o.targetId) ? o.targetId : null;
    if (!targetId && o.missile.guidance !== "none") return;
    spawnMissile(world, ship, o.missile, o.muzzle, o.dir, o.muzzleVelocity, targetId, o.weapon.part.def.id);
    world.physics.applyImpulse(
      ship.id,
      scale(o.dir, -o.missile.mass * MISSILE.launchSpeed * COMBAT.momentumTransfer),
      o.muzzle,
    );
    pushEvent(world, "launch", o.muzzle, 1);
    return;
  }
  if (o.kind === "projectile" && def.projectile) {
    const pr = def.projectile;
    const burst =
      pr.burstRadius && pr.burstDamage
        ? {
            proximity: pr.proximityFuse ?? 0,
            radius: pr.burstRadius,
            damage: pr.burstDamage,
            time: o.fuseTime ?? null,
          }
        : undefined;
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
      source: o.weapon.part.def.id,
      ...(burst ? { fuse: burst } : {}),
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
    const hit = raycastWorld(world, o.muzzle, o.dir, def.range, ship.id, ship.team);
    const to = add(o.muzzle, scale(o.dir, hit ? hit.t : def.range));
    world.combat.beams.push({ owner: ship.id, from: o.muzzle, to, hit: !!hit });
    if (!hit) return;
    const strength = beamFalloff(hit.t, def.beam.falloffStart, def.range) * ship.powerFactorOf(o.weapon.uid);
    const dmg = def.beam.dps * dt * strength;
    if (hit.kind === "ship") {
      damageShipAlongRay(world, hit, dmg, COMBAT.minDamage * dt, {
        ship: ship.id,
        source: o.weapon.part.def.id,
      });
      // Beam heating (decision log: Beam heat): part of the beam's power goes into the target's heat pool.
      hit.ship.addHeat((def.powerDraw ?? 0) * COMBAT.beamHeatToTarget * strength * dt);
    } else if (hit.kind === "missile") damageMissile(world, hit.missile, dmg);
    if (hit.kind !== "asteroid" && hit.kind !== "debris" && world.tick % 6 === 0)
      pushEvent(world, "beam-hit", to, 1);
  }
}

/** Distance from point `c` to segment a→b and the parameter of the closest point. */
function pointSegment(c: Vec2, a: Vec2, b: Vec2): { dist: number; s: number } {
  const ab = sub(b, a);
  const l2 = lengthSq(ab);
  const s = l2 > 1e-12 ? Math.min(1, Math.max(0, dot(sub(c, a), ab) / l2)) : 0;
  return { dist: length(sub(c, add(a, scale(ab, s)))), s };
}

/**
 * Where along this tick's path a burst shell goes off: the closest approach to an enemy missile or drone
 * within its proximity, else the moment its time fuse runs out. Null if it keeps flying.
 */
function burstPoint(world: World, pr: Projectile, from: Vec2, to: Vec2, dt: number): Vec2 | null {
  const fuse = pr.fuse!;
  let best: { s: number } | null = null;
  for (const m of world.combat.missiles) {
    if (m.team === pr.team || m.hp <= 0) continue;
    const r = pointSegment(m.pos, from, to);
    if (r.dist <= fuse.proximity && (!best || r.s < best.s)) best = { s: r.s };
  }
  for (const s of world.allShips()) {
    if (s.team === pr.team || !s.drone || s.inert) continue;
    const r = pointSegment(world.physics.getWorldCenter(s.id), from, to);
    if (r.dist <= fuse.proximity + s.layout.boundingRadius * 0.5 && (!best || r.s < best.s))
      best = { s: r.s };
  }
  if (best) return add(from, scale(sub(to, from), best.s));
  if (fuse.time !== null && pr.age + dt >= fuse.time) {
    const s = Math.min(1, Math.max(0, (fuse.time - pr.age) / dt));
    return add(from, scale(sub(to, from), s));
  }
  return null;
}

/** Step 10: move projectiles (with gravity) and resolve swept hits, burst fuses and hits on missiles. */
export function stepProjectiles(world: World, dt: number): void {
  const keep: Projectile[] = [];
  for (const pr of world.combat.projectiles) {
    const g = gravityAccel(world.gravityWells, pr.pos);
    pr.vel = add(pr.vel, scale(g, dt));
    const step = scale(pr.vel, dt);
    const dist = length(step);
    const end = add(pr.pos, step);
    if (pr.fuse) {
      const at = burstPoint(world, pr, pr.pos, end, dt);
      if (at) {
        blast(world, at, pr.fuse.radius, pr.fuse.damage, {
          hostileTo: pr.team,
          missiles: true,
          source: { ship: pr.owner, source: pr.source ?? pr.kind },
        });
        pushEvent(world, "burst", at, pr.fuse.radius);
        continue;
      }
    }
    if (dist > 0) {
      const dir = scale(step, 1 / dist);
      const hit = raycastWorld(world, pr.pos, dir, dist, pr.owner, pr.team);
      if (hit) {
        const at = add(pr.pos, scale(dir, hit.t));
        if (hit.kind === "ship") {
          const vTarget = world.physics.velocityAt(hit.ship.id, at);
          world.physics.applyImpulse(
            hit.ship.id,
            scale(sub(pr.vel, vTarget), pr.mass * COMBAT.momentumTransfer),
            at,
          );
          damageShipAlongRay(world, hit, pr.damage, COMBAT.minDamage, {
            ship: pr.owner,
            source: pr.source ?? pr.kind,
          });
          world.combat.stats.hits++;
        } else if (hit.kind === "missile") {
          damageMissile(world, hit.missile, pr.damage);
          world.combat.stats.hits++;
        }
        pushEvent(world, "hit", at, Math.min(3, 0.5 + pr.damage / 150));
        continue;
      }
    }
    pr.pos = end;
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
