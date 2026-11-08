import { degToRad } from "../core/vec2";

/** Combat tuning (spec §8, §9). Global constants; per-weapon values live in the part catalogue. */
export const COMBAT = {
  /** Minimum damage of a hit after armor (per hit; per second for beams). */
  minDamage: 2,
  /** Share of a hit absorbed by a wreck before the rest continues along the ray (spec §8). */
  wreckAbsorb: 0.5,
  /** Fixed mounts auto-aim within ± this cone (spec §9.1). */
  fixedAimCone: degToRad(3),
  /** Turrets fire when within this angle of the aim direction (or within their spread if larger). */
  turretAimTolerance: degToRad(0.15),
  /** HP factor below which damaged weapons stop getting worse (avoids infinite intervals). */
  hpFloor: 0.25,
  /** Extra distance behind a first hit that pass-through damage can still reach (m). */
  passThroughReach: 400,
  /** Collision damage: HP per N·s of contact impulse above the threshold (spec §6.8). */
  collisionDamagePerImpulse: 0.02,
  collisionImpulseThreshold: 3000,
  /**
   * Share of a round's momentum passed to the firing ship (recoil) and to the ship it hits. Mounts and
   * armor are assumed to absorb the rest (decision log: Recoil damping); 1 would be pure Newtonian.
   */
  momentumTransfer: 0.1,
  /**
   * Share of a beam's power (at the target, after range falloff and brownout) that ends up as heat in
   * the ship it hits (decision log: Beam heat). Beams cook ships as well as cutting parts.
   */
  beamHeatToTarget: 0.3,
  /** AI-mode turrets turn on missiles homing on their ship when impact is this close (s). */
  turretMissileDefense: 4,
  /** Hit / effect events kept for rendering (s). */
  eventLifetime: 2,
} as const;

/** Explosions of destroyed parts (spec §8, "Should"): blast radius (m) and peak damage. */
export const EXPLOSION = {
  fuelTank: { radius: 3, damage: 300, minFill: 0.1 },
  magazine: { radius: 3, damage: 400, minFill: 0.1 },
  reactor: { radius: 4, damage: 600, minFill: 0 },
} as const;

/** Missiles (spec §9.5). Per-missile numbers live in the launcher's MissileDef. */
export const MISSILE = {
  /** The fuse arms this long after launch, so a missile never detonates on its own ship (s). */
  armTime: 0.4,
  /** Hit radius for rounds and beams (m). */
  radius: 0.8,
  /** Seconds a missile keeps coasting after its fuel runs out before it self-destructs. */
  coastTime: 20,
  /** Launch speed relative to the launcher (m/s). */
  launchSpeed: 25,
  /** Enemy decoys closer than this get one chance to pull each missile off its target (m). */
  decoyRange: 1200,
} as const;

/** Point defense and the shared targeting (spec §9.6). */
export const PD = {
  /** Threats whose closest approach misses the ship by more than this rank behind direct threats (m). */
  missMargin: 150,
  /** Decoys rank as if their time to impact were this many times shorter (decoy preference). */
  decoyPriority: 3,
} as const;

/** Drones (spec §9.7). */
export const DRONE = {
  /** Beyond this distance from the mother ship a drone loses its link and goes inert (m). */
  controlRange: 5000,
  /** Attack drones hold this distance from their target (m). */
  standoff: 300,
  /** PD drones escort at this distance from the mother ship (m). */
  escortDistance: 35,
  /** Decoys fly away from the mother ship at this relative speed (m/s). */
  decoySpeed: 60,
  /** Drone steering: speed limit relative to the goal (m/s) and position gain (1/s). */
  maxSpeed: 80,
  gain: 0.6,
  /** Launch push out of the bay (m/s). */
  launchSpeed: 4,
} as const;
