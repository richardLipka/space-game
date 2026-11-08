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

export const Objective = Type.Union([
  Type.Object({ type: Type.Literal("destroyAll") }, strict),
  Type.Object({ type: Type.Literal("survive"), seconds: PositiveNumber }, strict),
  Type.Object({ type: Type.Literal("protect"), designId: Uuidish }, strict),
]);

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
        { designId: Uuidish, aiProfile: Type.String(), spawn: Transform, team: Type.Integer({ minimum: 0 }) },
        strict,
      ),
    ),
    objective: Objective,
    seed: Type.Integer(),
  },
  strict,
);
export type Scenario = Static<typeof Scenario>;
