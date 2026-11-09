import { Type, type Static } from "@sinclair/typebox";
import { NonNegativeNumber, PositiveNumber, Transform, Uuidish, Vec2Json } from "./common";

const strict = { additionalProperties: false } as const;

export const AsteroidSpawn = Type.Object(
  {
    position: Vec2Json,
    angle: Type.Number({ description: "degrees" }),
    outline: Type.Array(Vec2Json, { minItems: 3, description: "convex, counter-clockwise" }),
    density: Type.Optional(PositiveNumber),
    velocity: Type.Optional(Vec2Json),
    angularVelocity: Type.Optional(Type.Number({ description: "deg/s" })),
    static: Type.Optional(Type.Boolean()),
  },
  strict,
);
export type AsteroidSpawn = Static<typeof AsteroidSpawn>;

export const GravityWell = Type.Object(
  {
    position: Vec2Json,
    mu: PositiveNumber, // G·M, m³/s²
    softening: NonNegativeNumber,
    coreRadius: PositiveNumber,
    cutoffRadius: Type.Optional(PositiveNumber),
  },
  strict,
);
export type GravityWell = Static<typeof GravityWell>;

/**
 * Win condition (spec §12). destroyAll: every enemy ship (not drones) defeated. survive: hold out for
 * `seconds`. protect: the allied ship spawned from `designId` (an `enemies` entry on team 0) must live
 * until every enemy is defeated. Losing all player ships always loses.
 */
export const Objective = Type.Union([
  Type.Object({ type: Type.Literal("destroyAll") }, strict),
  Type.Object({ type: Type.Literal("survive"), seconds: PositiveNumber }, strict),
  Type.Object({ type: Type.Literal("protect"), designId: Uuidish }, strict),
]);

export type Objective = Static<typeof Objective>;

export const Scenario = Type.Object(
  {
    id: Uuidish,
    name: Type.String({ minLength: 1 }),
    description: Type.String(),
    budget: NonNegativeNumber,
    maxPlayerShips: Type.Integer({ minimum: 0 }),
    allowedParts: Type.Optional(Type.Array(Type.String())),
    arena: Type.Object(
      {
        width: PositiveNumber,
        height: PositiveNumber,
        asteroids: Type.Array(AsteroidSpawn),
        gravityWells: Type.Array(GravityWell),
      },
      strict,
    ),
    playerSpawns: Type.Array(Transform),
    enemies: Type.Array(
      Type.Object(
        {
          designId: Uuidish,
          aiProfile: Type.String(),
          spawn: Transform,
          team: Type.Integer({ minimum: 0 }),
          /** Defensive AI: index (in `enemies`) of the ship this one guards, and the guard radius (m). */
          guard: Type.Optional(Type.Integer({ minimum: 0 })),
          guardRadius: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
        },
        strict,
      ),
    ),
    objective: Objective,
    seed: Type.Integer(),
    /** Order in the scenario list (lower first). */
    order: Type.Optional(Type.Integer()),
    /** Short tips shown before and during the battle (tutorial hints, plan M7 task 7). */
    hints: Type.Optional(Type.Array(Type.String())),
    /** Player designs known to win this scenario (offered as a starting point; used by test 7.2). */
    referenceDesigns: Type.Optional(Type.Array(Uuidish)),
  },
  strict,
);
export type Scenario = Static<typeof Scenario>;
