import { Type, type Static } from "@sinclair/typebox";
import { Fraction, NonNegativeNumber, PositiveNumber } from "./common";

const strict = { additionalProperties: false } as const;

/** Utility weights per behaviour (spec §11.2); 1 is neutral, 0 disables a behaviour. */
export const BehaviourWeights = Type.Object(
  {
    approach: NonNegativeNumber,
    hold: NonNegativeNumber,
    broadside: NonNegativeNumber,
    face: NonNegativeNumber,
    evade: NonNegativeNumber,
    retreat: NonNegativeNumber,
    cool: NonNegativeNumber,
  },
  strict,
);

/** An AI profile (spec §11.2): behaviour weights and fighting style, referenced by scenarios. */
export const AiProfile = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    name: Type.String({ minLength: 1 }),
    /** Preferred range as a share of the ship's best weapon range. */
    rangeFactor: Type.Number({ minimum: 0.1, maximum: 2 }),
    weights: BehaviourWeights,
    /** Retreat below this hull fraction. */
    retreatHp: Fraction,
    /** Speed limit relative to the goal (m/s). */
    maxSpeed: PositiveNumber,
    /** Sideways speed while orbiting a target (m/s). */
    orbitSpeed: NonNegativeNumber,
    /** Weapons fire only when the estimated hit probability is at least this. */
    minHitProbability: Fraction,
    /** Seconds between missile volleys. */
    volleyInterval: PositiveNumber,
    /** Drones launch once the target is closer than this (m). */
    droneLaunchRange: NonNegativeNumber,
    /** How strongly damaged targets are preferred (0 = not at all). */
    preferWeakened: NonNegativeNumber,
    /**
     * Behaviour type (skirmish AI types): aggressive closes in, defensive guards a ship (with a guard
     * order), retreating falls back steadily while firing, cautious keeps its distance. Default: none.
     */
    stance: Type.Optional(
      Type.Union([
        Type.Literal("aggressive"),
        Type.Literal("defensive"),
        Type.Literal("retreating"),
        Type.Literal("cautious"),
      ]),
    ),
    /** Retreating stance: speed of the steady withdrawal (m/s). */
    withdrawSpeed: Type.Optional(PositiveNumber),
  },
  strict,
);
export type AiProfile = Static<typeof AiProfile>;

export const AiProfileSet = Type.Object(
  { formatVersion: Type.Literal(1), profiles: Type.Array(AiProfile, { minItems: 1 }) },
  strict,
);
export type AiProfileSet = Static<typeof AiProfileSet>;
