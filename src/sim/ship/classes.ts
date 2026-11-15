import { weaponDps } from "../../data/balance/model";
import type { MissileDef, PartDef } from "../../data/schemas/part";

/**
 * Ship classes by size (mass), with a role from the weapon mix: drones, fighters, corvettes (gun), frigates,
 * destroyers, cruisers, battlecruisers and battleships. Each class has its own map symbol when the ship is
 * too small on screen to draw.
 */
export type ShipClass =
  "drone" | "fighter" | "corvette" | "frigate" | "destroyer" | "cruiser" | "battlecruiser" | "battleship";
export type ShipRole = "gun" | "missile" | "carrier" | "support";

/** Upper mass bound (t) of each class; battleships are everything heavier. */
export const CLASS_MASS: readonly (readonly [ShipClass, number])[] = [
  ["drone", 0.5],
  ["fighter", 5],
  ["corvette", 12],
  ["frigate", 17],
  ["destroyer", 25],
  ["cruiser", 45],
  ["battlecruiser", 65],
];

export function classOfMass(massKg: number, drone = false): ShipClass {
  if (drone) return "drone";
  const t = massKg / 1000;
  for (const [c, max] of CLASS_MASS) if (t < max) return c;
  return "battleship";
}

/** Role from the weapons: whichever of guns and missiles deals more; hangar ships without either carry drones. */
export function roleOf(parts: readonly PartDef[], missile?: MissileDef): ShipRole {
  let gun = 0;
  let missiles = 0;
  let hangars = 0;
  for (const d of parts) {
    if (d.hangar) hangars++;
    const w = d.weapon;
    if (!w || w.kind === "pd") continue;
    if (w.kind === "missile") missiles += missile ? weaponDps(w, missile) : 1;
    else gun += weaponDps(w);
  }
  if (gun <= 0 && missiles <= 0) return hangars ? "carrier" : "support";
  return missiles > gun ? "missile" : "gun";
}

export const CLASS_LABEL: Record<ShipClass, string> = {
  drone: "Drone",
  fighter: "Fighter",
  corvette: "Corvette",
  frigate: "Frigate",
  destroyer: "Destroyer",
  cruiser: "Cruiser",
  battlecruiser: "Battlecruiser",
  battleship: "Battleship",
};

/**
 * Map symbol of a class: an outline with the nose at +x, in units of the symbol size (screen pixels), and
 * the size. Bigger classes get bigger, more complex shapes.
 */
export const CLASS_SYMBOL: Record<
  ShipClass,
  { readonly size: number; readonly points: readonly [number, number][] }
> = {
  drone: {
    size: 4,
    points: [
      [1, 0],
      [-0.8, 0.7],
      [-0.8, -0.7],
    ],
  },
  fighter: {
    size: 6,
    points: [
      [1, 0],
      [-0.9, 0.9],
      [-0.4, 0],
      [-0.9, -0.9],
    ],
  },
  corvette: {
    size: 7,
    points: [
      [1, 0],
      [0, 0.6],
      [-1, 0],
      [0, -0.6],
    ],
  },
  frigate: {
    size: 8,
    points: [
      [1, 0],
      [-0.7, 0.8],
      [-1, 0.8],
      [-1, -0.8],
      [-0.7, -0.8],
    ],
  },
  destroyer: {
    size: 9,
    points: [
      [1, 0],
      [0.3, 0.6],
      [-1, 0.6],
      [-1, -0.6],
      [0.3, -0.6],
    ],
  },
  cruiser: {
    size: 10,
    points: [
      [1, 0],
      [0.5, 0.7],
      [-0.6, 0.7],
      [-1, 0],
      [-0.6, -0.7],
      [0.5, -0.7],
    ],
  },
  battlecruiser: {
    size: 11,
    points: [
      [1, 0],
      [0.6, 0.45],
      [0.2, 0.75],
      [-1, 0.75],
      [-0.8, 0],
      [-1, -0.75],
      [0.2, -0.75],
      [0.6, -0.45],
    ],
  },
  battleship: {
    size: 12,
    points: [
      [1, 0],
      [0.7, 0.55],
      [0.3, 0.8],
      [-0.9, 0.8],
      [-1, 0.5],
      [-1, -0.5],
      [-0.9, -0.8],
      [0.3, -0.8],
      [0.7, -0.55],
    ],
  },
};

const live = new WeakMap<object, { cls: ShipClass; role: ShipRole }>();

/** A ship's class and role (from its design; mass as it was when first asked). */
export function classOfShip(ship: {
  readonly drone: unknown;
  readonly massProps: { readonly mass: number };
  readonly parts: readonly { readonly def: { readonly def: PartDef } }[];
}): { cls: ShipClass; role: ShipRole } {
  let c = live.get(ship);
  if (!c) {
    c = {
      cls: classOfMass(ship.massProps.mass, !!ship.drone),
      role: roleOf(ship.parts.map((p) => p.def.def)),
    };
    live.set(ship, c);
  }
  return c;
}
