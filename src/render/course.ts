import type { World } from "../sim/world";
import type { Ship } from "../sim/ship/ship-entity";
import { type Vec2, length, rotate } from "../sim/core/vec2";
import { capabilities } from "../sim/flight/propulsion";
import { arcadeControl } from "../sim/flight/arcade";
import { FLIGHT, forceAlong, strongestAxis, wrapAngle } from "../sim/flight/controller";
import { boundaryAccel, gravityAccel } from "../sim/physics/forces";

/** Projected course: how far ahead (s), the spacing of the points returned (s) and the integration step (s). */
export const COURSE = {
  horizon: 10,
  step: 0.1,
  substep: 1 / 30,
} as const;

/**
 * Where a ship's centre of mass will be over the next `horizon` seconds if its pilot keeps the controls as
 * they are: one point every `step` seconds, the first at the present position.
 *
 * The ship is integrated forward the way the simulation moves it (semi-implicit Euler):
 * - newtonian: the thrust it delivers now stays fixed in the ship's own frame and turns with the ship;
 *   while the pilot holds a turn the ship spins up to the commanded rate with the torque it has now,
 *   otherwise the flight computer stops the rotation; a speed kill brakes to a stop and no further;
 * - arcade: the arcade speed loop is run on the current intent, so the prediction settles at the top
 *   speed, slows to a stop when nothing is held, and follows the nose through a turn;
 * - gravity wells and the arena boundary act at each predicted position.
 * A ship without control (defeated or inert) just coasts.
 */
export function predictCourse(
  world: World,
  ship: Ship,
  horizon: number = COURSE.horizon,
  step: number = COURSE.step,
): Vec2[] {
  const body = world.physics.getBodyState(ship.id);
  let p = world.physics.getWorldCenter(ship.id);
  let v = world.physics.velocityAt(ship.id, p);
  let angle = body.angle;
  let omega = body.angularVelocity;
  const mp = ship.massProps;
  const controlled = !ship.inert && !(world.enforceDefeat && ship.defeated);
  const arcade = controlled && !ship.drone && world.flightModel === "arcade";
  const intent = ship.intent;
  const caps = arcade ? capabilities(ship.propulsion.actuators) : null;
  // Newtonian: the wrench delivered on the last tick, in the ship frame.
  const thrust =
    controlled && !arcade ? { x: ship.lastWrench.fx / mp.mass, y: ship.lastWrench.fy / mp.mass } : null;
  // Speed kill: brake along the velocity (keep) or turn the strongest engines against it first (flip).
  const braking = thrust !== null && ship.flight.speedKill !== "off";
  let brake = 0;
  let brakeDelay = 0;
  if (braking) {
    const c = capabilities(ship.propulsion.actuators);
    const speed = length(v);
    const flip = ship.flight.speedKill === "flip";
    const dir = flip
      ? strongestAxis(c)
      : speed > 1e-9
        ? rotate({ x: -v.x / speed, y: -v.y / speed }, -angle)
        : { x: 1, y: 0 };
    brake = forceAlong(c, dir) / mp.mass;
    if (flip && brake > 0 && speed > 1e-9) {
      // The burn starts once the strongest axis points within the alignment tolerance of "against the
      // velocity": a bang-bang turn through the error, less the last part of its slow-down.
      const want = Math.atan2(-v.y, -v.x) - Math.atan2(dir.y, dir.x);
      const err = Math.abs(wrapAngle(want - angle));
      const a = Math.min(c.torqueCcw, c.torqueCw) / mp.inertia;
      const tol = FLIGHT.flipAlignTolerance;
      brakeDelay = err <= tol ? 0 : a > 0 ? 2 * Math.sqrt(err / a) - Math.sqrt((2 * tol) / a) : Infinity;
    }
  }
  // Newtonian turning: the ship spins up with the torque it has now until it reaches the commanded rate.
  const omegaTarget = intent.rotate * FLIGHT.maxOmega;
  const alpha = thrust && intent.rotate !== 0 ? Math.abs(ship.lastWrench.torque) / mp.inertia : 0;
  if (thrust && intent.rotate === 0) omega = 0;

  const out: Vec2[] = [p];
  const n = Math.round(horizon / step);
  const sub = Math.max(1, Math.round(step / COURSE.substep));
  const dt = step / sub;
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < sub; k++) {
      let ax = 0;
      let ay = 0;
      if (arcade) {
        const cmd = arcadeControl(
          intent,
          { mass: mp.mass, inertia: mp.inertia, angle, angularVelocity: omega, velocity: v, caps: caps!, dt },
          [],
        );
        const f = rotate({ x: cmd.wrench.fx, y: cmd.wrench.fy }, angle);
        ax = f.x / mp.mass;
        ay = f.y / mp.mass;
        omega += (cmd.wrench.torque / mp.inertia) * dt;
      } else if (braking) {
        // Speed kill: thrust against the velocity (after the flip, if any), never past a stop.
        const speed = length(v);
        if (speed > 1e-9 && (i * sub + k) * dt >= brakeDelay) {
          const a = Math.min(brake, speed / dt);
          ax = (-v.x / speed) * a;
          ay = (-v.y / speed) * a;
        }
      } else if (thrust) {
        const f = rotate(thrust, angle);
        ax = f.x;
        ay = f.y;
        if (alpha > 0) {
          const d = omegaTarget - omega;
          omega += Math.sign(d) * Math.min(Math.abs(d), alpha * dt);
        }
      }
      const g = gravityAccel(world.gravityWells, p);
      const b = boundaryAccel(world.arena, p);
      v = { x: v.x + (ax + g.x + b.x) * dt, y: v.y + (ay + g.y + b.y) * dt };
      p = { x: p.x + v.x * dt, y: p.y + v.y * dt };
      angle += omega * dt;
    }
    out.push(p);
  }
  return out;
}
