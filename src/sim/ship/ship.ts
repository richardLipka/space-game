import type { ShipDesign } from "../../data/schemas/design";
import { transformPoints } from "../core/geometry";
import { type Vec2, add, degToRad, rotate, vec2, lengthSq, sub } from "../core/vec2";
import type { PartCatalogue, RuntimePartDef } from "./catalogue";

export interface PartInstance {
  readonly uid: string;
  readonly def: RuntimePartDef;
  /** Part origin in the ship (design) frame. */
  readonly position: Vec2;
  /** Rotation in radians, ship frame. */
  readonly angle: number;
  hp: number;
  /** Fuel mass in kg (fuel tanks only). */
  fuel: number;
  /** Stored energy in J (batteries only). */
  charge: number;
  /** Rounds: magazine stock, or a weapon's internal magazine (spec §7.3). */
  ammo: number;
}

export interface MassProps {
  readonly mass: number;
  /** Centre of mass in the ship frame. */
  readonly center: Vec2;
  /** Moment of inertia about the centre of mass, kg·m². */
  readonly inertia: number;
}

/** Dry mass + fuel + magazine rounds (weapon internal rounds are negligible and ignored). */
export const partMass = (p: PartInstance): number =>
  p.def.def.mass + p.fuel + (p.def.def.magazine ? p.ammo * p.def.def.magazine.massPerRound : 0);
export const hpFactor = (p: PartInstance): number => Math.max(0, p.hp / p.def.def.hp);
export const isIntact = (p: PartInstance): boolean => p.hp > 0;

/** Centroid of the part in the ship frame. */
export const partCentroid = (p: PartInstance): Vec2 => add(p.position, rotate(p.def.centroid, p.angle));

/** Direction (ship frame) and point for a vector given in part-local frame. */
export const toShipDir = (p: PartInstance, localDir: Vec2): Vec2 => rotate(localDir, p.angle);

/**
 * Ship mass properties from parts (spec §6.1):
 *   M = Σmᵢ,  c = Σmᵢcᵢ / M,  I = Σ(Iᵢ + mᵢ|cᵢ − c|²)
 * Destroyed parts keep their mass (spec §8).
 */
export function computeMassProps(parts: readonly PartInstance[]): MassProps {
  let mass = 0;
  let cx = 0;
  let cy = 0;
  for (const p of parts) {
    const m = partMass(p);
    const c = partCentroid(p);
    mass += m;
    cx += m * c.x;
    cy += m * c.y;
  }
  if (!(mass > 0)) throw new Error("Ship must have positive mass");
  const center = vec2(cx / mass, cy / mass);
  let inertia = 0;
  for (const p of parts) {
    const m = partMass(p);
    inertia += m * p.def.unitInertia + m * lengthSq(sub(partCentroid(p), center));
  }
  return { mass, center, inertia };
}

/** Convex collision pieces of a part, in the ship frame. */
export function partPiecesShipFrame(p: PartInstance): Vec2[][] {
  return p.def.pieces.map((piece) => transformPoints(piece, p.angle, p.position));
}

export interface InstantiateOptions {
  /** Initial fuel as a fraction of tank capacity (default 1). */
  readonly fuelFraction?: number;
  /** Initial battery charge as a fraction of capacity (default 1). */
  readonly chargeFraction?: number;
}

export function instantiateParts(
  design: ShipDesign,
  catalogue: PartCatalogue,
  options: InstantiateOptions = {},
): PartInstance[] {
  const fuelFraction = options.fuelFraction ?? 1;
  const chargeFraction = options.chargeFraction ?? 1;
  return design.parts.map((pl) => {
    const def = catalogue.get(pl.partId);
    return {
      uid: pl.uid,
      def,
      position: vec2(pl.x, pl.y),
      angle: degToRad(pl.angle),
      hp: def.def.hp,
      fuel: (def.def.fuelTank?.capacity ?? 0) * fuelFraction,
      charge: (def.def.battery?.capacity ?? 0) * chargeFraction,
      ammo: def.def.magazine?.capacity ?? def.def.weapon?.internalMagazine ?? def.def.hangar?.capacity ?? 0,
    };
  });
}
