import { Type, type Static } from "@sinclair/typebox";
import { NonNegativeNumber, PositiveNumber, Transform, Uuidish, Vec2Json } from "./common";
import { CrewEntry } from "./officer";

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

/** A circular area of the arena: a jump point, a beacon to hold (docs/objectives.md). */
export const Zone = Type.Object(
  {
    position: Vec2Json,
    radius: PositiveNumber,
    /** Shown on the map. */
    label: Type.Optional(Type.String({ maxLength: 40 })),
  },
  strict,
);
export type Zone = Static<typeof Zone>;

/** A jump point: ships of `team` (absent = every team) that stay inside it for a few seconds leave the battle. */
export const Exit = Type.Object(
  {
    position: Vec2Json,
    radius: PositiveNumber,
    label: Type.Optional(Type.String({ maxLength: 40 })),
    team: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  strict,
);
export type Exit = Static<typeof Exit>;

/**
 * Win condition (spec §12, docs/objectives.md). Losing every player ship always loses.
 * - destroyAll: every enemy ship (not drones) defeated or fled.
 * - survive: hold out for `seconds`.
 * - protect: the allied ship spawned from `designId` (an `enemies` entry on team 0) must live until every
 *   enemy is defeated.
 * - escort: that allied ship must reach `zone` (it flies there on its own).
 * - hold: keep a ship of yours inside `zone`, with no enemy ship in it, for `seconds` in all.
 * - breakout: get `count` of your ships (default: every one) out through the jump point `zone`.
 */
export const Objective = Type.Union([
  Type.Object({ type: Type.Literal("destroyAll") }, strict),
  Type.Object({ type: Type.Literal("survive"), seconds: PositiveNumber }, strict),
  Type.Object({ type: Type.Literal("protect"), designId: Uuidish }, strict),
  Type.Object({ type: Type.Literal("escort"), designId: Uuidish, zone: Zone }, strict),
  Type.Object({ type: Type.Literal("hold"), zone: Zone, seconds: PositiveNumber }, strict),
  Type.Object(
    { type: Type.Literal("breakout"), zone: Zone, count: Type.Optional(Type.Integer({ minimum: 1 })) },
    strict,
  ),
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
        /** Jump points (docs/objectives.md): retreating ships leave the battle through them. */
        exits: Type.Optional(Type.Array(Exit)),
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
          /** Officers of this ship (scenario crew dialog); absent = the roster's (team 0) or random. */
          crew: Type.Optional(Type.Array(CrewEntry, { maxItems: 5 })),
        },
        strict,
      ),
    ),
    objective: Objective,
    /** Battle time limit (s): an objective not met by then is lost (survive is met by then). */
    timeLimit: Type.Optional(PositiveNumber),
    seed: Type.Integer(),
    /** Flight model of every ship in the battle (absent = Newtonian). */
    flightModel: Type.Optional(Type.Union([Type.Literal("newtonian"), Type.Literal("arcade")])),
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
