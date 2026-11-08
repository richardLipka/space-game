import { Type, type Static } from "@sinclair/typebox";
import { Fraction, NonNegativeNumber, PartId, PositiveNumber, Vec2Json } from "./common";

const strict = { additionalProperties: false } as const;

export const EdgeType = Type.Union([Type.Literal("snap"), Type.Literal("hull"), Type.Literal("function")]);
export type EdgeType = Static<typeof EdgeType>;

export const PartCategory = Type.Union(
  ["structure", "armor", "command", "propulsion", "power", "thermal", "storage", "weapon", "hangar"].map(
    (c) => Type.Literal(c),
  ),
);

const ProjectileDef = Type.Object(
  {
    speed: PositiveNumber,
    mass: PositiveNumber,
    damage: NonNegativeNumber,
    lifetime: PositiveNumber,
    proximityFuse: Type.Optional(PositiveNumber),
    burstRadius: Type.Optional(PositiveNumber),
    burstDamage: Type.Optional(NonNegativeNumber),
  },
  strict,
);

export const MissileDef = Type.Object(
  {
    mass: PositiveNumber,
    thrust: PositiveNumber,
    fuel: PositiveNumber,
    turnRate: PositiveNumber,
    hp: PositiveNumber,
    damage: NonNegativeNumber,
    proximityFuse: PositiveNumber,
    blastRadius: PositiveNumber,
    guidance: Type.Union([Type.Literal("pn"), Type.Literal("pursuit")]),
    navConstant: Type.Optional(PositiveNumber),
  },
  strict,
);

export const WeaponDef = Type.Object(
  {
    kind: Type.Union([
      Type.Literal("projectile"),
      Type.Literal("beam"),
      Type.Literal("missile"),
      Type.Literal("pd"),
    ]),
    mount: Type.Union([Type.Literal("fixed"), Type.Literal("turret")]),
    arc: Type.Optional(Type.Tuple([Type.Number(), Type.Number()])),
    traverseRate: Type.Optional(PositiveNumber),
    muzzle: Vec2Json,
    ammoType: Type.Optional(Type.String()),
    internalMagazine: Type.Integer({ minimum: 0 }),
    fireInterval: PositiveNumber,
    powerPerShot: Type.Optional(NonNegativeNumber),
    powerDraw: Type.Optional(NonNegativeNumber),
    heatPerShot: Type.Optional(NonNegativeNumber),
    heatWhileFiring: Type.Optional(NonNegativeNumber),
    range: PositiveNumber,
    spread: NonNegativeNumber,
    projectile: Type.Optional(ProjectileDef),
    beam: Type.Optional(Type.Object({ dps: PositiveNumber, falloffStart: PositiveNumber }, strict)),
    missile: Type.Optional(MissileDef),
  },
  strict,
);
export type WeaponDef = Static<typeof WeaponDef>;

export const PartDef = Type.Object(
  {
    id: PartId,
    rev: Type.Integer({ minimum: 1 }),
    source: Type.Union([Type.Literal("core"), Type.Literal("user")]),
    author: Type.Optional(Type.String()),
    name: Type.String({ minLength: 1 }),
    category: PartCategory,
    outline: Type.Array(Vec2Json, { minItems: 3, description: "local, counter-clockwise" }),
    convexPieces: Type.Optional(Type.Array(Type.Array(Vec2Json, { minItems: 3 }), { minItems: 1 })),
    edges: Type.Array(EdgeType, { minItems: 3 }),
    mirrorOf: Type.Optional(PartId),
    mass: PositiveNumber,
    hp: PositiveNumber,
    cost: NonNegativeNumber,
    armor: Type.Optional(NonNegativeNumber),
    conducts: Type.Optional(Type.Boolean()),

    command: Type.Optional(Type.Object({ gyroTorque: PositiveNumber, powerDraw: NonNegativeNumber }, strict)),
    gyro: Type.Optional(
      Type.Object({ torque: PositiveNumber, powerDraw: NonNegativeNumber, heat: NonNegativeNumber }, strict),
    ),
    engine: Type.Optional(
      Type.Object(
        {
          thrust: PositiveNumber,
          isp: PositiveNumber,
          gimbalMax: NonNegativeNumber,
          nozzleEdge: Type.Integer({ minimum: 0 }),
          powerDraw: NonNegativeNumber,
          heatAtMax: NonNegativeNumber,
        },
        strict,
      ),
    ),
    thruster: Type.Optional(
      Type.Object(
        {
          thrust: PositiveNumber,
          isp: PositiveNumber,
          direction: Vec2Json,
          powerDraw: NonNegativeNumber,
          heatAtMax: NonNegativeNumber,
        },
        strict,
      ),
    ),
    reactor: Type.Optional(
      Type.Object(
        {
          maxOutput: PositiveNumber,
          heatPerWatt: NonNegativeNumber,
          minOutput: Type.Optional(NonNegativeNumber),
        },
        strict,
      ),
    ),
    battery: Type.Optional(
      Type.Object(
        { capacity: PositiveNumber, maxCharge: PositiveNumber, maxDischarge: PositiveNumber },
        strict,
      ),
    ),
    fuelTank: Type.Optional(Type.Object({ capacity: PositiveNumber }, strict)),
    magazine: Type.Optional(
      Type.Object(
        { ammoType: Type.String(), capacity: Type.Integer({ minimum: 1 }), massPerRound: PositiveNumber },
        strict,
      ),
    ),
    radiator: Type.Optional(
      Type.Object(
        {
          dissipation: PositiveNumber,
          retractedFactor: Fraction,
          extendedDamageMult: Type.Number({ minimum: 1 }),
        },
        strict,
      ),
    ),
    heatSink: Type.Optional(Type.Object({ capacity: PositiveNumber }, strict)),
    weapon: Type.Optional(WeaponDef),
    hangar: Type.Optional(
      Type.Object(
        { droneType: Type.String(), capacity: Type.Integer({ minimum: 1 }), launchInterval: PositiveNumber },
        strict,
      ),
    ),
  },
  strict,
);
export type PartDef = Static<typeof PartDef>;

export const Catalogue = Type.Object(
  { catalogueVersion: Type.String({ minLength: 1 }), parts: Type.Array(PartDef) },
  strict,
);
export type Catalogue = Static<typeof Catalogue>;
