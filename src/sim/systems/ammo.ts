/** Ammunition flow (spec §7.3): weapons fire from an internal magazine refilled from magazines on the same network. */
export const AMMO = {
  /** Seconds to refill an empty internal magazine completely. */
  reloadTime: 2,
} as const;

export interface MagazineStore {
  readonly uid: string;
  readonly ammoType: string;
  rounds: number;
}

export interface WeaponFeed {
  readonly uid: string;
  readonly ammoType: string;
  readonly internalCapacity: number;
  /** Rounds in the weapon (fractional while reloading). */
  internal: number;
}

/**
 * Moves rounds from network magazines into weapons this tick. Magazines are drained in uid order so the
 * result is deterministic. Mutates the given objects; returns rounds moved.
 */
export function refillWeapons(
  weapons: readonly WeaponFeed[],
  magazines: readonly MagazineStore[],
  dt: number,
): number {
  let moved = 0;
  for (const w of weapons) {
    if (w.internal >= w.internalCapacity) continue;
    let want = Math.min(w.internalCapacity - w.internal, (w.internalCapacity / AMMO.reloadTime) * dt);
    for (const m of magazines) {
      if (want <= 0) break;
      if (m.ammoType !== w.ammoType || m.rounds <= 0) continue;
      const take = Math.min(want, m.rounds);
      m.rounds -= take;
      w.internal += take;
      want -= take;
      moved += take;
    }
  }
  return moved;
}
