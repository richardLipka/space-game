import { type Vec2, dot, length, rotate } from "../core/vec2";
import type { Wrench } from "./allocator";
import { type ControlIntent, wrapAngle } from "./controller";
import type { Actuator, Capabilities } from "./propulsion";

/**
 * Which flight model a world uses.
 * - newtonian: thrust adds velocity and nothing removes it; engines and thrusters are allocated to produce
 *   the wanted force and torque (spec §6).
 * - arcade: the ship holds the speed the pilot asks for. Forward moves it up to a fixed top speed, letting
 *   go slows it to a stop, turning turns the direction of travel, strafing slides sideways.
 */
export type FlightModel = "newtonian" | "arcade";
export const FLIGHT_MODELS: readonly FlightModel[] = ["newtonian", "arcade"];

/**
 * Arcade flight tuning. Top speed and the time to reach it come from the ship's mass and its engines:
 * a heavier ship is slower and takes longer to get there, more thrust helps both, and a ship that loses
 * engines slows down.
 */
export const ARCADE = {
  /** Top speed (m/s) of a ship of refMass with refAccel of real forward acceleration. */
  baseSpeed: 150,
  refAccel: 15,
  refMass: 10_000,
  /** How strongly forward acceleration (up) and mass (down) change the top speed. */
  speedAccelExponent: 0.25,
  speedMassExponent: 0.2,
  minSpeed: 50,
  maxSpeed: 240,
  /** Time (s) the reference ship takes to reach its top speed; grows with mass, shrinks with thrust. */
  baseTime: 5,
  timeMassExponent: 0.35,
  timeAccelExponent: 0.3,
  minTime: 1.5,
  /** Sideways and reverse top speed, and acceleration, as a share of forward. */
  strafeShare: 0.6,
  reverseShare: 0.5,
  /** Braking and sideways grip as a multiple of the acceleration, at least minBrake (m/s²). */
  brakeFactor: 2.5,
  minBrake: 12,
  /** Turn rate (rad/s) = turnFactor · √(angular acceleration), within [minTurn, maxTurn]. */
  turnFactor: 1.6,
  minTurn: 0.5,
  maxTurn: 3,
  /** Angular acceleration used to reach the turn rate, as a multiple of the real one (at least minSpin). */
  spinFactor: 3,
  minSpin: 2,
  /** Response times of the speed and turn-rate loops (s). */
  speedTau: 0.15,
  rateTau: 0.08,
  /** Heading loop gain (1/s). */
  headingGain: 6,
} as const;

/** What a ship can do under the arcade model right now. */
export interface ArcadeLimits {
  /** Forward top speed (m/s); 0 when the ship has no forward thrust. */
  readonly topSpeed: number;
  readonly strafeSpeed: number;
  readonly reverseSpeed: number;
  /** Forward acceleration (m/s²). */
  readonly accel: number;
  /** Braking and sideways grip (m/s²). */
  readonly brake: number;
  /** Turn rate (rad/s) and the angular acceleration reaching it (rad/s²). */
  readonly turnRate: number;
  readonly spin: number;
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

export function arcadeLimits(mass: number, inertia: number, caps: Capabilities): ArcadeLimits {
  const A = ARCADE;
  const real = mass > 0 ? caps.fwd / mass : 0;
  const alpha = inertia > 0 ? Math.min(caps.torqueCcw, caps.torqueCw) / inertia : 0;
  const turnRate = alpha > 0 ? clamp(A.turnFactor * Math.sqrt(alpha), A.minTurn, A.maxTurn) : 0;
  const spin = alpha > 0 ? Math.max(A.minSpin, alpha * A.spinFactor) : 0;
  if (real <= 0) {
    // No forward thrust: the ship cannot move itself, but it still comes to rest and can turn.
    return { topSpeed: 0, strafeSpeed: 0, reverseSpeed: 0, accel: 0, brake: A.minBrake, turnRate, spin };
  }
  const topSpeed = clamp(
    A.baseSpeed *
      Math.pow(real / A.refAccel, A.speedAccelExponent) *
      Math.pow(A.refMass / mass, A.speedMassExponent),
    A.minSpeed,
    A.maxSpeed,
  );
  const time = Math.max(
    A.minTime,
    A.baseTime *
      Math.pow(mass / A.refMass, A.timeMassExponent) *
      Math.pow(A.refAccel / real, A.timeAccelExponent),
  );
  const accel = topSpeed / time;
  return {
    topSpeed,
    strafeSpeed: topSpeed * A.strafeShare,
    reverseSpeed: topSpeed * A.reverseShare,
    accel,
    brake: Math.max(A.minBrake, accel * A.brakeFactor),
    turnRate,
    spin,
  };
}

export interface ArcadeContext {
  readonly mass: number;
  readonly inertia: number;
  readonly angle: number;
  readonly angularVelocity: number;
  /** World-frame velocity. */
  readonly velocity: Vec2;
  readonly caps: Capabilities;
  readonly dt: number;
}

export interface ArcadeCommand {
  /** Force and torque to apply (ship frame). */
  readonly wrench: Wrench;
  /** Throttle per actuator, for fuel use, heat, power demand and the exhaust drawn. */
  readonly throttles: number[];
  readonly limits: ArcadeLimits;
}

/**
 * Arcade flight: the intent is a wanted velocity in the ship's own frame (forward/back and left/right as a
 * share of the top speeds), or for the AI a wanted world velocity. A speed loop pushes the ship toward it:
 * with the ship's acceleration where the pilot is pushing, with the stronger brake everywhere else. So the
 * ship stops when the keys are released, and sideways drift dies quickly, which makes the direction of
 * travel follow the nose in a turn.
 */
export function arcadeControl(
  intent: ControlIntent,
  ctx: ArcadeContext,
  acts: readonly Actuator[],
): ArcadeCommand {
  const lim = arcadeLimits(ctx.mass, ctx.inertia, ctx.caps);
  const local = rotate(ctx.velocity, -ctx.angle);
  let wantX: number;
  let wantY: number;
  if (intent.desiredVelocity) {
    const w = rotate(intent.desiredVelocity, -ctx.angle);
    wantX = clamp(w.x, -lim.reverseSpeed, lim.topSpeed);
    wantY = clamp(w.y, -lim.strafeSpeed, lim.strafeSpeed);
  } else {
    const t = intent.thrust;
    wantX = clamp(t.x, -1, 1) * (t.x >= 0 ? lim.topSpeed : lim.reverseSpeed);
    wantY = clamp(t.y, -1, 1) * lim.strafeSpeed;
  }
  const tau = Math.max(ARCADE.speedTau, ctx.dt);
  // Per axis: accelerate where the pilot pushes the way the ship already moves, brake otherwise.
  const axis = (want: number, have: number, accel: number): number => {
    const pushing = want !== 0 && want * have >= 0 && Math.abs(want) > Math.abs(have);
    const limit = pushing ? accel : lim.brake;
    return clamp((want - have) / tau, -limit, limit);
  };
  const ax = axis(wantX, local.x, wantX >= 0 ? lim.accel : lim.accel * ARCADE.reverseShare);
  const ay = axis(wantY, local.y, lim.accel * ARCADE.strafeShare);

  let omega = 0;
  if (lim.turnRate > 0) {
    if (intent.rotate !== 0) omega = clamp(intent.rotate, -1, 1) * lim.turnRate;
    else if (intent.faceAngle !== undefined) {
      const err = wrapAngle(intent.faceAngle - ctx.angle);
      // Slow down in time to stop on the heading.
      const mag = Math.min(
        lim.turnRate,
        ARCADE.headingGain * Math.abs(err),
        Math.sqrt(2 * lim.spin * 0.8 * Math.abs(err)),
      );
      omega = Math.sign(err) * mag;
    }
  }
  // Without any torque the ship cannot turn itself; it still stops spinning (as it stops moving).
  const spin = lim.spin > 0 ? lim.spin : ARCADE.minSpin;
  const alpha = clamp((omega - ctx.angularVelocity) / Math.max(ARCADE.rateTau, ctx.dt), -spin, spin);
  const wrench: Wrench = { fx: ctx.mass * ax, fy: ctx.mass * ay, torque: ctx.inertia * alpha };

  // Throttles shown and paid for: main engines for the push forward, thrusters and gyros for the rest.
  // Holding speed keeps the engines lit at a low setting.
  const cruise = wantX > 0 && lim.topSpeed > 0 ? 0.25 * (wantX / lim.topSpeed) : 0;
  const fwd = lim.accel > 0 ? Math.max(clamp(ax / lim.accel, 0, 1), cruise) : 0;
  const side = { x: Math.min(0, ax), y: ay };
  const sideMag = length(side);
  const sideShare = clamp(sideMag / lim.brake, 0, 1);
  const turnShare = clamp(Math.abs(alpha) / spin, 0, 1);
  const throttles = acts.map((a) => {
    if (a.kind === "engine") return a.fx > 0 ? fwd : 0;
    const turning = a.torque !== 0 && a.torque * alpha > 0 ? turnShare : 0;
    if (a.kind === "gyro") return turning;
    const f = Math.hypot(a.fx, a.fy);
    const pushing = sideMag > 1e-9 && f > 0 && dot({ x: a.fx / f, y: a.fy / f }, side) / sideMag > 0.3;
    return Math.max(turning, pushing ? sideShare : 0);
  });
  return { wrench, throttles, limits: lim };
}
