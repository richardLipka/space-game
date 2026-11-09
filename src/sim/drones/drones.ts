import { type Vec2, add, angleOf, length, normalize, rotate, scale, sub, vec2 } from "../core/vec2";
import { compareIds } from "../core/ids";
import { DRONE } from "../combat/constants";
import { intercept } from "../combat/lead";
import { pushEvent } from "../combat/combat-world";
import { instantiateParts } from "../ship/ship";
import { droneRole, type Ship } from "../ship/ship-entity";
import type { World } from "../world";

/**
 * Drones (spec §9.7): hangars launch them as ordinary ships flagged as drones, a small per-role AI flies
 * them, and they go inert when they run out of fuel, lose the link to the mother ship or (decoys) burn out.
 */

/** Hangar bay of a part: world point on its first functional edge and the outward normal. */
function bayOf(world: World, ship: Ship, uid: string): { point: Vec2; normal: Vec2 } | null {
  const p = ship.part(uid);
  const edge = p.def.edges.find((e) => e.type === "function");
  if (!edge) return null;
  const s = world.physics.getBodyState(ship.id);
  const local = add(p.position, rotate(edge.mid, p.angle));
  return {
    point: add(s.position, rotate(local, s.angle)),
    normal: rotate(rotate(edge.normal, p.angle), s.angle),
  };
}

/**
 * Step 0b: hangars with drones queued (H) launch one every `launchInterval` while intact and in command
 * (spec §9.7). The drone appears just outside the bay, facing out, with the bay's velocity plus a push.
 */
export function launchDrones(world: World, dt: number): void {
  for (const ship of world.allShips()) {
    // Launch cooldowns run down whether or not anything is queued (single launches need them too).
    for (const [uid, cd] of ship.hangarCooldown)
      if (cd > 0) ship.hangarCooldown.set(uid, Math.max(0, cd - dt));
    if (ship.hangarPending.size === 0) continue;
    const disabled = ship.inert || (world.enforceDefeat && ship.defeated);
    for (const uid of [...ship.hangarPending.keys()].sort(compareIds)) {
      const cd = ship.hangarCooldown.get(uid) ?? 0;
      const part = ship.parts.find((p) => p.uid === uid);
      const pending = ship.hangarPending.get(uid) ?? 0;
      const h = part?.def.def.hangar;
      if (!part || !h || part.hp <= 0 || pending <= 0 || part.ammo < 1) {
        ship.hangarPending.delete(uid);
        continue;
      }
      if (disabled || !ship.isCommanded(uid) || cd > 1e-9) continue;
      const design = world.designs.get(h.droneType);
      const bay = bayOf(world, ship, uid);
      if (!design || !bay) {
        ship.hangarPending.delete(uid);
        continue;
      }
      const catalogue = world.catalogueOf(ship.id);
      let radius = 0;
      for (const dp of instantiateParts(design, catalogue))
        for (const v of dp.def.outline)
          radius = Math.max(radius, length(add(dp.position, rotate(v, dp.angle))));
      const position = add(bay.point, scale(bay.normal, radius + 0.5));
      const drone = world.addShip(design, catalogue, {
        position,
        angle: angleOf(bay.normal),
        velocity: add(world.physics.velocityAt(ship.id, bay.point), scale(bay.normal, DRONE.launchSpeed)),
        angularVelocity: world.physics.getBodyState(ship.id).angularVelocity,
        team: ship.team,
      });
      drone.drone = { mother: ship.id, hangarUid: uid, role: droneRole(drone.parts), launchTick: world.tick };
      part.ammo -= 1;
      ship.hangarPending.set(uid, pending - 1);
      ship.hangarCooldown.set(uid, h.launchInterval);
      pushEvent(world, "launch", bay.point, 1);
    }
  }
}

/** Step 0c: drones lose control when out of fuel, out of range, orphaned or (decoys) expired. */
export function updateDroneLinks(world: World, dt: number): void {
  const ships = world.allShips();
  for (const s of ships) s.liveDrones = 0;
  for (const d of ships)
    if (d.drone && !d.inert && world.hasShip(d.drone.mother)) world.getShip(d.drone.mother).liveDrones++;
  for (const d of ships) {
    const link = d.drone;
    if (!link || d.inert) continue;
    const mother = world.hasShip(link.mother) ? world.getShip(link.mother) : null;
    if (!mother || mother.defeated) d.makeInert("mother-lost");
    else if (d.totalFuel <= 0) d.makeInert("no-fuel");
    else if (
      length(sub(world.physics.getWorldCenter(d.id), world.physics.getWorldCenter(mother.id))) >
      DRONE.controlRange
    )
      d.makeInert("out-of-range");
    else {
      const life = d.decoyLifetime;
      if (life !== null && (world.tick - link.launchTick) * dt >= life) d.makeInert("expired");
    }
  }
}

/** Velocity-matching steering toward a goal, as a ship-relative thrust intent. */
function steer(d: Ship, world: World, goalPos: Vec2, goalVel: Vec2, faceAngle: number): void {
  const s = world.physics.getBodyState(d.id);
  const pos = world.physics.getWorldCenter(d.id);
  const toGoal = scale(sub(goalPos, pos), DRONE.gain);
  const speed = length(toGoal);
  const desired = add(goalVel, speed > DRONE.maxSpeed ? scale(toGoal, DRONE.maxSpeed / speed) : toGoal);
  const local = rotate(sub(desired, s.linearVelocity), -s.angle);
  const clamp = (v: number) => Math.max(-1, Math.min(1, v / 3));
  const thrust = length(local) < 0.3 ? vec2(0, 0) : vec2(clamp(local.x), clamp(local.y));
  d.intent = { thrust, rotate: 0, faceAngle };
}

/** The attack drone's target: the mother ship's selected target, else the nearest enemy (ships before drones). */
function attackTarget(world: World, d: Ship, mother: Ship): Ship | null {
  const sel = mother.weaponCommand.targetId;
  if (sel && world.hasShip(sel)) {
    const t = world.getShip(sel);
    if (t.team !== d.team && !t.defeated) return t;
  }
  const me = world.physics.getWorldCenter(d.id);
  let best: Ship | null = null;
  let bestKey = Infinity;
  for (const s of world.allShips()) {
    if (s.team === d.team || s.defeated || s.inert) continue;
    const key = length(sub(world.physics.getWorldCenter(s.id), me)) + (s.drone ? 1e6 : 0);
    if (key < bestKey) {
      bestKey = key;
      best = s;
    }
  }
  return best;
}

/** Step 0d: per-role drone AI sets each live drone's intent and weapon command. */
export function controlDrones(world: World): void {
  for (const d of world.allShips()) {
    const link = d.drone;
    if (!link || d.inert || d.defeated || !world.hasShip(link.mother)) continue;
    const mother = world.getShip(link.mother);
    const mPos = world.physics.getWorldCenter(mother.id);
    const mState = world.physics.getBodyState(mother.id);
    const pos = world.physics.getWorldCenter(d.id);
    const escort = () => {
      const side = Number(d.id.slice(-1)) % 2 === 0 ? 1 : -1;
      const goal = add(mPos, rotate(vec2(0, side * DRONE.escortDistance), mState.angle));
      steer(d, world, goal, mState.linearVelocity, mState.angle);
      d.weaponCommand = { trigger: false, aimPoint: null, selected: new Set(), targetId: null };
    };
    if (link.role === "decoy") {
      const away =
        length(sub(pos, mPos)) > 1e-6 ? normalize(sub(pos, mPos)) : rotate(vec2(1, 0), mState.angle);
      steer(d, world, pos, add(mState.linearVelocity, scale(away, DRONE.decoySpeed)), angleOf(away));
      continue;
    }
    if (link.role === "pd") {
      escort();
      continue;
    }
    const target = attackTarget(world, d, mother);
    if (!target) {
      escort();
      continue;
    }
    const tPos = world.physics.getWorldCenter(target.id);
    const tVel = world.physics.getBodyState(target.id).linearVelocity;
    const out = length(sub(pos, tPos)) > 1e-6 ? normalize(sub(pos, tPos)) : vec2(1, 0);
    const gun = d.weapons.find((w) => w.def.projectile);
    const sol = gun
      ? intercept(pos, world.physics.getBodyState(d.id).linearVelocity, tPos, tVel, gun.def.projectile!.speed)
      : null;
    steer(d, world, add(tPos, scale(out, DRONE.standoff)), tVel, angleOf(sub(sol?.aimPoint ?? tPos, pos)));
    d.weaponCommand = { trigger: false, aimPoint: null, selected: new Set(), targetId: target.id };
  }
}
