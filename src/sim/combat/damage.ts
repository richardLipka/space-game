import { COMBAT } from "./constants";

/** Damage after flat armor reduction (spec §8): max(minDamage, hit − armor); unarmored parts take it all. */
export function afterArmor(hit: number, armor: number, minDamage: number = COMBAT.minDamage): number {
  if (hit <= 0) return 0;
  if (armor <= 0) return hit;
  return Math.max(Math.min(minDamage, hit), hit - armor);
}

export interface RayTarget {
  readonly uid: string;
  readonly intact: boolean;
  readonly armor: number;
}

export interface RayDamageResult {
  /** Damage applied per part uid (intact parts only). */
  readonly applied: { uid: string; damage: number }[];
  /** Share of the hit each wreck on the way absorbed (goes to its shadow life). */
  readonly absorbed: { uid: string; damage: number }[];
  /** Part that stopped the ray (first intact part hit), if any. */
  readonly stoppedBy: string | null;
}

/**
 * Walks the parts a ray enters, nearest first (spec §8): wrecks absorb `wreckAbsorb` of the hit and pass
 * the rest on; the first intact part takes the remainder (after its armor) and stops the ray.
 * `minDamage` scales with dt for beams.
 */
export function damageAlongRay(
  hits: readonly RayTarget[],
  hit: number,
  minDamage: number = COMBAT.minDamage,
): RayDamageResult {
  let remaining = hit;
  const absorbed: { uid: string; damage: number }[] = [];
  for (const h of hits) {
    if (!h.intact) {
      absorbed.push({ uid: h.uid, damage: remaining * COMBAT.wreckAbsorb });
      remaining *= 1 - COMBAT.wreckAbsorb;
      continue;
    }
    return {
      applied: [{ uid: h.uid, damage: afterArmor(remaining, h.armor, minDamage) }],
      absorbed,
      stoppedBy: h.uid,
    };
  }
  return { applied: [], absorbed, stoppedBy: null };
}

/** Beam damage falloff: full up to falloffStart, then linear to zero at max range. */
export function beamFalloff(distance: number, falloffStart: number, range: number): number {
  if (distance <= falloffStart) return 1;
  if (distance >= range) return 0;
  return 1 - (distance - falloffStart) / (range - falloffStart);
}

/** Collision damage to each contacting part for a contact impulse J (N·s), spec §6.8. */
export function collisionDamage(impulse: number): number {
  return Math.max(0, impulse - COMBAT.collisionImpulseThreshold) * COMBAT.collisionDamagePerImpulse;
}
