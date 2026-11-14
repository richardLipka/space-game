import { type Vec2, angleOf, length, neg, rotate, scale, sub, ZERO } from "../core/vec2";
import type { Wrench } from "./allocator";
import type { Capabilities } from "./propulsion";

/** What the player or AI wants this tick (spec §6.6). */
export interface ControlIntent {
  /** Desired local thrust per axis in [−1, 1]: x = forward/back, y = left/right. */
  readonly thrust: Vec2;
  /** Desired rotation in [−1, 1]; positive = counter-clockwise. */
  readonly rotate: number;
  /** Optional absolute heading target (radians, world frame), e.g. face-cursor or AI. */
  readonly faceAngle?: number | undefined;
  /** One-shot speed-kill command for this tick. */
  readonly speedKill?: "keep" | "flip" | "cancel" | undefined;
  /** One-shot course-matching command (C, V, Shift+V): start, change or stop matching a target. */
  readonly match?: MatchCommand | undefined;
  /**
   * Arcade flight only: the world velocity the ship should hold (the AI steers by velocity). Takes the place
   * of `thrust`.
   */
  readonly desiredVelocity?: Vec2 | undefined;
}

export const IDLE_INTENT: ControlIntent = { thrust: ZERO, rotate: 0 };

export type SpeedKillMode = "off" | "keep" | "flip";

/**
 * Course matching: hold the target's velocity ("velocity", C), or also close to `distance` metres and stay
 * there ("distance", V). Locked matching survives manual steering: the ship goes back to it as soon as the
 * pilot lets go.
 */
export interface MatchState {
  readonly kind: "velocity" | "distance";
  readonly targetId: string;
  readonly distance: number;
  readonly lock: boolean;
}

/** `toggle`: the same kind again switches matching off (pressing C or V twice). */
export type MatchCommand = (MatchState & { readonly toggle?: boolean }) | "cancel";

export interface FlightState {
  speedKill: SpeedKillMode;
  match?: MatchState | null;
}

/** Applies this tick's matching command (before the reference velocity is read). */
export function updateMatch(intent: ControlIntent, state: FlightState): void {
  const c = intent.match;
  if (intent.speedKill) state.match = null; // X stops the ship: it replaces matching
  if (!c) return;
  if (c === "cancel") state.match = null;
  else if (c.toggle && state.match?.kind === c.kind && state.match.targetId === c.targetId)
    state.match = null;
  else state.match = { kind: c.kind, targetId: c.targetId, distance: c.distance, lock: c.lock };
}

export interface FlightContext {
  readonly mass: number;
  readonly inertia: number;
  /** Ship heading (radians, world). */
  readonly angle: number;
  readonly angularVelocity: number;
  /** World-frame velocity. */
  readonly velocity: Vec2;
  /** Speed-kill reference velocity (spec §6.7 hook). World zero in the prototype. */
  readonly referenceVelocity: Vec2;
  readonly caps: Capabilities;
  readonly dt: number;
}

export const FLIGHT = {
  /** Gameplay cap on commanded angular speed (rad/s). */
  maxOmega: 3,
  /** Rate-loop response time (s). */
  rateTau: 0.05,
  /** Heading loop gain (1/s) for small errors. */
  headingGain: 8,
  /** Allocator weight for a force axis the pilot did not request (spec §6.6). */
  freeAxisWeight: 0.2,
  /** Fraction of angular acceleration capacity used to plan heading braking. */
  headingBrakeMargin: 0.8,
  /** Speed-kill response time (s). */
  killTau: 0.1,
  /** Speed-kill completion threshold (m/s). */
  killEpsilon: 0.05,
  /** Course matching turns the ship to burn only for errors above this relative speed (m/s). */
  matchFlipSpeed: 5,
  /** Flip-and-burn: start burning when heading error is below this (rad). */
  flipAlignTolerance: (10 * Math.PI) / 180,
  /**
   * Speed kill (X) keeps orientation only while that is not much slower than flip-and-burn: it switches
   * to flip when the estimated keep time exceeds this factor times the flip time (decision log: Speed kill auto).
   */
  keepSlowFactor: 1.5,
} as const;

export const wrapAngle = (a: number): number => {
  let x = (a + Math.PI) % (2 * Math.PI);
  if (x < 0) x += 2 * Math.PI;
  return x - Math.PI;
};

/** Rate target for reaching a heading with a bang-bang-like profile. */
function headingRate(err: number, ctx: FlightContext): number {
  const tq = err > 0 ? ctx.caps.torqueCcw : ctx.caps.torqueCw;
  const alpha = (tq / ctx.inertia) * FLIGHT.headingBrakeMargin;
  const mag = Math.min(
    Math.sqrt(2 * alpha * Math.abs(err)),
    FLIGHT.headingGain * Math.abs(err),
    FLIGHT.maxOmega,
  );
  return Math.sign(err) * mag;
}

function torqueFor(omegaTarget: number, ctx: FlightContext): number {
  return (ctx.inertia * (omegaTarget - ctx.angularVelocity)) / Math.max(FLIGHT.rateTau, ctx.dt);
}

/** Local axis (unit vector) with the largest available force — used for flip-and-burn. */
export function strongestAxis(caps: Capabilities): Vec2 {
  const options: [number, Vec2][] = [
    [caps.fwd, { x: 1, y: 0 }],
    [caps.back, { x: -1, y: 0 }],
    [caps.left, { x: 0, y: 1 }],
    [caps.right, { x: 0, y: -1 }],
  ];
  let best = options[0]!;
  for (const o of options) if (o[0] > best[0]) best = o;
  return best[1];
}

/** Force available along a local unit direction (N), treating the four axis maxima as an ellipse. */
export function forceAlong(caps: Capabilities, u: Vec2): number {
  const fx = u.x >= 0 ? caps.fwd : caps.back;
  const fy = u.y >= 0 ? caps.left : caps.right;
  const ax = Math.abs(u.x);
  const ay = Math.abs(u.y);
  if ((ax > 1e-9 && fx <= 0) || (ay > 1e-9 && fy <= 0)) return 0;
  const sx = ax > 1e-9 ? ax / fx : 0;
  const sy = ay > 1e-9 ? ay / fy : 0;
  const s = Math.hypot(sx, sy);
  return s > 0 ? 1 / s : 0;
}

/** Time to rotate by |angle| from rest with the ship's weaker torque, capped at maxOmega (s). */
function rotationTime(angle: number, ctx: FlightContext): number {
  const alpha = (Math.min(ctx.caps.torqueCcw, ctx.caps.torqueCw) / ctx.inertia) * FLIGHT.headingBrakeMargin;
  if (alpha <= 0) return Infinity;
  const a = Math.abs(angle);
  const w = FLIGHT.maxOmega;
  return a <= (w * w) / alpha ? 2 * Math.sqrt(a / alpha) : a / w + w / alpha;
}

/** Estimated times (s) to null `vRel` by keeping orientation vs. by flip-and-burn. */
export function speedKillTimes(vRel: Vec2, ctx: FlightContext): { keep: number; flip: number } {
  const speed = length(vRel);
  if (speed <= 0) return { keep: 0, flip: 0 };
  const brakeLocal = rotate(scale(vRel, -1 / speed), -ctx.angle);
  const fKeep = forceAlong(ctx.caps, brakeLocal);
  const axis = strongestAxis(ctx.caps);
  const fFlip = forceAlong(ctx.caps, axis);
  const err = wrapAngle(angleOf(neg(vRel)) - angleOf(axis) - ctx.angle);
  return {
    keep: fKeep > 0 ? (speed * ctx.mass) / fKeep : Infinity,
    flip: fFlip > 0 ? rotationTime(err, ctx) + (speed * ctx.mass) / fFlip : Infinity,
  };
}

export interface FlightCommand {
  readonly desired: Wrench;
  /** Allocator weights: unrequested force axes matter less, so off-axis engines still give full thrust. */
  readonly weights: { readonly fx: number; readonly fy: number; readonly torque: number };
}

/**
 * Turns intent + state into a desired wrench (ship frame) and allocator weights, and updates
 * speed-kill state. The same function serves the player and the AI (spec §11.1).
 */
export function flightControl(intent: ControlIntent, state: FlightState, ctx: FlightContext): FlightCommand {
  const thrusting = intent.thrust.x !== 0 || intent.thrust.y !== 0;

  // Course matching runs on the speed-kill machinery against the target's (reference) velocity. Manual
  // steering ends it, unless it is locked: then it only pauses while the pilot steers.
  if (state.match && thrusting && !state.match.lock) state.match = null;
  const matching = !!state.match && !thrusting;
  if (matching && state.speedKill === "off") state.speedKill = "keep";

  // Speed-kill state machine (spec §6.7).
  if (intent.speedKill === "cancel") state.speedKill = "off";
  else if (intent.speedKill === "keep") state.speedKill = state.speedKill === "keep" ? "off" : "keep";
  else if (intent.speedKill === "flip") state.speedKill = "flip";
  if (thrusting) state.speedKill = "off";
  if (state.speedKill === "flip" && intent.rotate !== 0) state.speedKill = "keep";

  const vRel = sub(ctx.velocity, ctx.referenceVelocity);
  // Done braking: speed kill switches off; matching keeps holding (without turning the ship).
  if (state.speedKill !== "off" && length(vRel) < FLIGHT.killEpsilon)
    state.speedKill = matching ? "keep" : "off";
  // While matching, small corrections use whatever thrust points the right way, without turning the ship
  // around each time (it would spin endlessly holding station).
  if (matching && state.speedKill === "flip" && length(vRel) < FLIGHT.matchFlipSpeed)
    state.speedKill = "keep";
  if (
    state.speedKill === "keep" &&
    intent.rotate === 0 &&
    !(matching && length(vRel) < FLIGHT.matchFlipSpeed)
  ) {
    // X is "auto": without enough retro thrust along the velocity, turn and burn instead.
    const t = speedKillTimes(vRel, ctx);
    if (t.keep > FLIGHT.keepSlowFactor * t.flip) state.speedKill = "flip";
  }

  let fx = 0;
  let fy = 0;
  let omegaTarget: number;

  if (state.speedKill !== "off") {
    const fWorld = scale(vRel, -ctx.mass / Math.max(FLIGHT.killTau, ctx.dt));
    const fLocal = rotate(fWorld, -ctx.angle);
    if (state.speedKill === "keep") {
      fx = fLocal.x;
      fy = fLocal.y;
      omegaTarget = intent.rotate * FLIGHT.maxOmega;
    } else {
      const axis = strongestAxis(ctx.caps);
      const heading = angleOf(neg(vRel)) - angleOf(axis);
      const err = wrapAngle(heading - ctx.angle);
      omegaTarget = headingRate(err, ctx);
      if (Math.abs(err) < FLIGHT.flipAlignTolerance) {
        fx = fLocal.x;
        fy = fLocal.y;
      }
    }
  } else {
    const t = intent.thrust;
    fx = t.x > 0 ? t.x * ctx.caps.fwd : t.x * ctx.caps.back;
    fy = t.y > 0 ? t.y * ctx.caps.left : t.y * ctx.caps.right;
    if (intent.rotate !== 0) omegaTarget = intent.rotate * FLIGHT.maxOmega;
    else if (intent.faceAngle !== undefined)
      omegaTarget = headingRate(wrapAngle(intent.faceAngle - ctx.angle), ctx);
    else omegaTarget = 0; // rotational stabilisation (spec §6.5)
  }

  const exact = state.speedKill !== "off";
  const free = FLIGHT.freeAxisWeight;
  return {
    desired: { fx, fy, torque: torqueFor(omegaTarget, ctx) },
    weights: {
      fx: exact || intent.thrust.x !== 0 || intent.thrust.y === 0 ? 1 : free,
      fy: exact || intent.thrust.y !== 0 || intent.thrust.x === 0 ? 1 : free,
      torque: 1,
    },
  };
}
