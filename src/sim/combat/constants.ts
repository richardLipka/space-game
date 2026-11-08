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
  /** Hit / effect events kept for rendering (s). */
  eventLifetime: 2,
} as const;

/** Explosions of destroyed parts (spec §8, "Should"): blast radius (m) and peak damage. */
export const EXPLOSION = {
  fuelTank: { radius: 3, damage: 300, minFill: 0.1 },
  magazine: { radius: 3, damage: 400, minFill: 0.1 },
  reactor: { radius: 4, damage: 600, minFill: 0 },
} as const;
