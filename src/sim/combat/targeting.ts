import { type Vec2, angleOf, degToRad, dot, length, lengthSq, sub } from "../core/vec2";
import { compareIds } from "../core/ids";
import { COMBAT, PD } from "./constants";
import { intercept } from "./lead";
import type { WeaponState } from "./weapons";

/**
 * Shared targeting (spec §9.6, plan M5 task 3): threat ranking by time to impact, intercept solutions and
 * arc/occlusion checks. Used by PD turrets, AI-mode weapon groups and drones. Pure: it works on contact
 * snapshots, never on the world.
 */

/** Something that can be shot at, as seen this tick. */
export interface Contact {
  readonly id: string;
  readonly kind: "ship" | "drone" | "missile";
  readonly team: number;
  /** World position (ships: centre of mass) and velocity. */
  readonly position: Vec2;
  readonly velocity: Vec2;
  /** Missiles: the ship they are homing on. */
  readonly targetId: string | null;
  /** Active decoy (spec §9.7): enemy missiles and PD prefer it. */
  readonly decoy: boolean;
  /** Rough size for hit-probability estimates (m); defaults to 1. */
  readonly radius?: number;
}

/** The ship doing the defending. */
export interface Defender {
  readonly id: string;
  readonly team: number;
  readonly position: Vec2;
  readonly velocity: Vec2;
}

/** A weapon's mount this tick. */
export interface Mount {
  readonly muzzle: Vec2;
  /** World angle of the mount axis (rad). */
  readonly mountAngle: number;
  /** World velocity of the muzzle (rounds inherit it). */
  readonly muzzleVelocity: Vec2;
}

/** What a weapon should shoot at: contact id, world aim point and time until the shot arrives (s). */
export interface Engagement {
  readonly id: string;
  readonly aimPoint: Vec2;
  readonly t: number;
}

const wrap = (a: number): number => {
  let x = (a + Math.PI) % (2 * Math.PI);
  if (x < 0) x += 2 * Math.PI;
  return x - Math.PI;
};

/** Closest approach of a contact to the defender, assuming both keep their velocity: time (s) and miss distance (m). */
export function closestApproach(c: Contact, d: Defender): { t: number; miss: number } {
  const r = sub(c.position, d.position);
  const v = sub(c.velocity, d.velocity);
  const vv = lengthSq(v);
  const t = vv > 1e-9 ? Math.max(0, -dot(r, v) / vv) : 0;
  return { t, miss: length({ x: r.x + v.x * t, y: r.y + v.y * t }) };
}

/**
 * Priority score of a threat (lower = engage first). Missiles homing on the defender count as direct hits;
 * anything that would miss by more than PD.missMargin ranks behind every direct threat. Decoys rank as if
 * they arrived PD.decoyPriority times sooner.
 */
export function threatScore(c: Contact, d: Defender): number {
  const { t, miss } = closestApproach(c, d);
  const direct = c.kind === "missile" && c.targetId === d.id;
  let score = direct || miss <= PD.missMargin ? t : 1000 + t + miss / 100;
  if (c.decoy) score /= PD.decoyPriority;
  return score;
}

/** Enemy missiles and drones, most urgent first (ties by id, so the order is deterministic). */
export function rankThreats(contacts: readonly Contact[], d: Defender): Contact[] {
  return contacts
    .filter((c) => c.team !== d.team && (c.kind === "missile" || c.kind === "drone"))
    .map((c) => ({ c, s: threatScore(c, d) }))
    .sort((a, b) => a.s - b.s || compareIds(a.c.id, b.c.id))
    .map((x) => x.c);
}

/**
 * Whether and how `w` can hit `target` from `mount`: lead for projectiles, straight for beams and missiles;
 * the aim point must be in range (and within a projectile's lifetime), inside a turret's arc and not in an
 * angle blocked by the ship's own parts, or inside a fixed weapon's aim cone. Missile launchers can always
 * launch (missiles steer themselves) while the target is in range.
 */
/**
 * Estimated chance that one round from `w` hits a target of `radius` at `dist`: the target's size against
 * the spread cone (spec §11.2 fire control). Beams and missiles count as sure hits.
 */
export function hitProbability(w: WeaponState, dist: number, radius: number): number {
  if (w.def.kind === "beam" || w.def.kind === "missile") return 1;
  const sigma = degToRad(Math.max(w.def.spread, 0.05));
  return Math.min(1, radius / (dist * Math.tan(sigma) * 2 + 1e-6));
}

export function engageSolution(
  w: WeaponState,
  mount: Mount,
  target: { readonly position: Vec2; readonly velocity: Vec2; readonly radius?: number },
  minHitProbability = 0,
): { aimPoint: Vec2; t: number } | null {
  const def = w.def;
  let aimPoint = target.position;
  let t = 0;
  const proj = def.projectile;
  if (proj && (def.kind === "projectile" || def.kind === "pd")) {
    const sol = intercept(mount.muzzle, mount.muzzleVelocity, target.position, target.velocity, proj.speed);
    if (!sol || sol.t > proj.lifetime) return null;
    aimPoint = sol.aimPoint;
    t = sol.t;
  }
  const dist = length(sub(aimPoint, mount.muzzle));
  if (dist > def.range) return null;
  if (minHitProbability > 0 && hitProbability(w, dist, target.radius ?? 1) < minHitProbability) return null;
  if (def.kind === "missile") return { aimPoint, t: dist / 300 };
  if (def.kind === "beam") t = 0;
  const rel = wrap(angleOf(sub(aimPoint, mount.muzzle)) - mount.mountAngle);
  if (def.mount === "turret") {
    const [a0, a1] = (def.arc ?? [-180, 180]).map(degToRad) as [number, number];
    if (rel < a0 || rel > a1) return null;
    if (w.blocked.some(([a, b]) => rel >= a && rel <= b)) return null;
  } else if (Math.abs(rel) > COMBAT.fixedAimCone) return null;
  return { aimPoint, t };
}

/** First contact in `ordered` that `w` can engage. */
export function firstEngageable(
  w: WeaponState,
  mount: Mount,
  ordered: readonly Contact[],
  minHitProbability = 0,
): Engagement | null {
  for (const c of ordered) {
    const sol = engageSolution(w, mount, c, minHitProbability);
    if (sol) return { id: c.id, ...sol };
  }
  return null;
}

/**
 * Enemy ships for AI-mode weapons and missile launchers: the selected target first, then the rest by
 * distance (non-drones before drones at equal standing). Defeated ships are not offered.
 */
export function orderShipTargets(
  contacts: readonly Contact[],
  d: Defender,
  preferredId: string | null,
): Contact[] {
  const enemies = contacts.filter((c) => c.team !== d.team && (c.kind === "ship" || c.kind === "drone"));
  const dist = (c: Contact) => length(sub(c.position, d.position));
  return enemies.sort(
    (a, b) =>
      Number(b.id === preferredId) - Number(a.id === preferredId) ||
      dist(a) - dist(b) ||
      compareIds(a.id, b.id),
  );
}
