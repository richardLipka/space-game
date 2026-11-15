import { weaponDps } from "../../data/balance/model";
import type { ShipDesign } from "../../data/schemas/design";
import type { MissileDef, PartDef } from "../../data/schemas/part";
import { degToRad } from "../core/vec2";
import type { PartCatalogue } from "../ship/catalogue";
import { LayoutIndex, turretBlockedRanges } from "../ship/layout";
import { instantiateParts } from "../ship/ship";
import type { Ship } from "../ship/ship-entity";

/**
 * Firepower by direction: how much damage per second a ship can put out at each bearing in its own frame,
 * from its weapon arcs. Turrets count across their arc minus what the hull blocks; fixed guns and rockets
 * along their mount; smart missiles over a wide cone (they steer). Point defense does not count. The
 * strongest smoothed direction is the ship's attack front: where it should turn to face the enemy.
 */

type WeaponDef = NonNullable<PartDef["weapon"]>;

export interface Gun {
  /** Mount direction in the ship frame (rad). */
  readonly mount: number;
  readonly def: WeaponDef;
  /** Blocked angle ranges relative to the mount (rad). */
  readonly blocked: readonly (readonly [number, number])[];
  /** Damage per second it can deal (0 when destroyed or out of ammunition). */
  readonly dps: number;
  /** Smart missiles steer; rockets fly straight. */
  readonly steers?: boolean;
}

export const FIREPOWER = {
  /** Directions sampled round the ship. */
  samples: 72,
  /** Fixed guns and rockets bear within this cone of their mount (rad). */
  fixedCone: degToRad(8),
  /** Smart missiles can be launched at targets within this cone of the launcher (rad). */
  smartCone: degToRad(60),
  /** Half-width of the smoothing window that picks the attack front (rad). */
  smooth: degToRad(20),
  /** Directions within this share of the best count as equally good; the one nearest the nose wins. */
  tie: 0.97,
} as const;

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** Whether a weapon can fire towards ship-frame bearing `theta`. */
export function bears(g: Gun, theta: number): boolean {
  const rel = wrap(theta - g.mount);
  if (g.def.kind === "missile")
    return Math.abs(rel) <= (g.steers ? FIREPOWER.smartCone : FIREPOWER.fixedCone);
  if (g.def.mount !== "turret") return Math.abs(rel) <= FIREPOWER.fixedCone;
  const [a0, a1] = (g.def.arc ?? [-180, 180]).map(degToRad) as [number, number];
  if (rel < a0 || rel > a1) return false;
  return !g.blocked.some(([a, b]) => rel >= a && rel <= b);
}

/** Damage per second at each of `FIREPOWER.samples` bearings (index i = i·360°/samples, ship frame). */
export function firepowerProfile(guns: readonly Gun[]): number[] {
  const n = FIREPOWER.samples;
  return Array.from({ length: n }, (_, i) => {
    const theta = (i / n) * Math.PI * 2;
    let dps = 0;
    for (const g of guns) if (g.dps > 0 && bears(g, theta)) dps += g.dps;
    return dps;
  });
}

/** Bearing (rad, ship frame, −π…π) of index i. */
export const bearingOf = (i: number): number => wrap((i / FIREPOWER.samples) * Math.PI * 2);

/**
 * The attack front: the bearing with the most smoothed firepower. When several are about as good (within
 * `FIREPOWER.tie`), the one nearest the nose wins, so a ship with no clear side keeps its nose forward.
 * 0 for a ship without weapons.
 */
export function attackFront(profile: readonly number[]): number {
  const n = profile.length;
  if (n === 0) return 0;
  const half = Math.round((FIREPOWER.smooth / (Math.PI * 2)) * n);
  const smoothed = profile.map((_, i) => {
    let s = 0;
    // Triangular window: the centre counts most, so a narrow peak keeps its own direction.
    for (let k = -half; k <= half; k++) s += (half + 1 - Math.abs(k)) * profile[(i + k + n) % n]!;
    return s;
  });
  const best = Math.max(...smoothed);
  if (best <= 0) return 0;
  let pick = 0;
  let pickOff = Infinity;
  smoothed.forEach((v, i) => {
    if (v < best * FIREPOWER.tie) return;
    const off = Math.abs(bearingOf(i));
    if (off < pickOff - 1e-9) {
      pick = i;
      pickOff = off;
    }
  });
  return bearingOf(pick);
}

/** A live ship's weapons as they are now: destroyed ones and launchers without missiles count 0. */
export function gunsOfShip(ship: Ship): Gun[] {
  return ship.weapons
    .filter((w) => w.def.kind !== "pd")
    .map((w) => {
      const alive = w.part.hp > 0 && ship.isCommanded(w.part.uid);
      const missile = w.def.kind === "missile" ? ship.nextMissile(w.part.uid) : null;
      const dps = !alive
        ? 0
        : w.def.kind === "missile"
          ? missile
            ? weaponDps(w.def, missile)
            : 0
          : weaponDps(w.def);
      return {
        mount: w.part.angle,
        def: w.def,
        blocked: w.blocked,
        dps,
        steers: missile ? missile.guidance !== "none" : true,
      };
    });
}

/** A design's weapons (editor): turret blocking from its layout; launchers count with `missile`. */
export function gunsOfDesign(design: ShipDesign, catalogue: PartCatalogue, missile?: MissileDef): Gun[] {
  const parts = instantiateParts(design, catalogue);
  const layout = new LayoutIndex(parts);
  return parts
    .filter((p) => p.def.def.weapon && p.def.def.weapon.kind !== "pd")
    .map((p) => {
      const def = p.def.def.weapon!;
      const blocked = turretBlockedRanges(layout, p, 60, 3).map(
        ([a, b]) => [degToRad(a), degToRad(b)] as const,
      );
      const dps = def.kind === "missile" ? (missile ? weaponDps(def, missile) : 0) : weaponDps(def);
      return { mount: p.angle, def, blocked, dps, steers: missile ? missile.guidance !== "none" : true };
    });
}

/** A design's profile and attack front, launchers counted with the catalogue's smart missile. */
export function designFirepower(
  design: ShipDesign,
  catalogue: PartCatalogue,
): { profile: number[]; front: number } {
  const missile = catalogue.has("core:magazine.missile.s")
    ? catalogue.get("core:magazine.missile.s").def.magazine?.missile
    : undefined;
  const profile = firepowerProfile(gunsOfDesign(design, catalogue, missile));
  return { profile, front: attackFront(profile) };
}

const cache = new WeakMap<Ship, { key: string; profile: number[]; front: number }>();

/**
 * A live ship's firepower profile and attack front, recomputed only when a weapon is destroyed, cut off or
 * runs out of missiles.
 */
export function liveFirepower(ship: Ship): { profile: number[]; front: number } {
  const guns = gunsOfShip(ship);
  const key = guns.map((g) => (g.dps > 0 ? "1" : "0")).join("");
  const c = cache.get(ship);
  if (c && c.key === key) return c;
  const profile = firepowerProfile(guns);
  const v = { key, profile, front: attackFront(profile) };
  cache.set(ship, v);
  return v;
}

/** Human description of a ship-frame bearing: nose, port broadside, … */
export function describeBearing(rad: number): string {
  const d = Math.round((rad * 180) / Math.PI);
  const a = Math.abs(d);
  const side = d > 0 ? "port" : "starboard";
  if (a <= 20) return `nose (${d}°)`;
  if (a >= 160) return `stern (${d}°)`;
  if (a >= 70 && a <= 110) return `${side} broadside (${d}°)`;
  return `${side} ${a < 90 ? "bow" : "quarter"} (${d}°)`;
}
