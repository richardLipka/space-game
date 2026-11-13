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
    /** Shown in the HUD and the editor ("Smart missile", "Rocket"). */
    name: Type.Optional(Type.String()),
    mass: PositiveNumber,
    thrust: PositiveNumber,
    fuel: PositiveNumber,
    turnRate: PositiveNumber,
    hp: PositiveNumber,
    damage: NonNegativeNumber,
    proximityFuse: PositiveNumber,
    blastRadius: PositiveNumber,
    /** "none": a rocket, it flies straight where the launcher points. */
    guidance: Type.Union([Type.Literal("pn"), Type.Literal("pursuit"), Type.Literal("none")]),
    navConstant: Type.Optional(PositiveNumber),
    /** Launcher reload time as a multiple of the launcher's own interval (default 1). */
    reload: Type.Optional(PositiveNumber),
  },
  strict,
);

export type MissileDef = Static<typeof MissileDef>;

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
    /**
     * Per-part multipliers on what the balance model (data/balance/model.ts) derives from the part's volume:
     * mass, hit points, its main output (reactor power, thrust, tank or magazine capacity, dissipation) and
     * the share of a game's rounds a gun holds itself.
     */
    balance: Type.Optional(
      Type.Object(
        {
          mass: Type.Optional(PositiveNumber),
          hp: Type.Optional(PositiveNumber),
          output: Type.Optional(PositiveNumber),
          internalShare: Type.Optional(PositiveNumber),
        },
        strict,
      ),
    ),

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
          /** Ion engine: little thrust for almost no fuel, paid for in power. */
          ion: Type.Optional(Type.Boolean()),
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
        {
          ammoType: Type.String(),
          capacity: Type.Integer({ minimum: 1 }),
          massPerRound: PositiveNumber,
          /** Missile magazines: the missile they hold. Launchers fire whatever their magazines hold. */
          missile: Type.Optional(MissileDef),
        },
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
    /** Decoy emitter (spec §9.7): enemy missiles and PD prefer its ship while it is active. */
    decoy: Type.Optional(Type.Object({ strength: Fraction, lifetime: PositiveNumber }, strict)),
    hangar: Type.Optional(
      Type.Object(
        {
          droneType: Type.String(),
          capacity: Type.Integer({ minimum: 1 }),
          launchInterval: PositiveNumber,
          /** Power drawn while the next drone is readied (W). */
          powerDraw: Type.Optional(NonNegativeNumber),
        },
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
