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
    /** Kiter: backs off at full speed, guns on the target, whenever an enemy comes inside 80 % of its range. */
    kite: Type.Optional(Type.Boolean()),
    /**
     * Disengages (escapes at full speed) when the enemies' threat near it exceeds this multiple of its own
     * side's there (cautious, carrier). Default: never.
     */
    outgunnedRatio: Type.Optional(Type.Number({ minimum: 1, maximum: 10 })),
    /** Out of ammunition and missiles: rams its target instead of leaving (aggressive). */
    ramWhenDry: Type.Optional(Type.Boolean()),
    /** Retreating stance: speed of the steady withdrawal (m/s). */
    withdrawSpeed: Type.Optional(PositiveNumber),
    /**
     * Fleet doctrine (src/sim/ai/doctrine.ts): "pass" flies formation passes through the enemy at high
     * speed and comes about for the next one; "missile-line" stands off near missile range in a wall of
     * battle and launches synchronised salvos. Default: standard (behaviour scores only).
     */
    doctrine: Type.Optional(
      Type.Union([Type.Literal("standard"), Type.Literal("pass"), Type.Literal("missile-line")]),
    ),
    /** Pass doctrine: speed of the passes (m/s), how far to the side of the enemy centre they aim (m), and the distance past it at which the formation comes about (m). */
    passSpeed: Type.Optional(PositiveNumber),
    passOffset: Type.Optional(NonNegativeNumber),
    passTurnDistance: Type.Optional(PositiveNumber),
    /** Pass and missile-line doctrines: distance between ships across the formation (m). */
    formationSpacing: Type.Optional(PositiveNumber),
    /** Missile-line doctrine: standoff as a share of missile range, and seconds between the side's salvos. */
    standoffFactor: Type.Optional(Type.Number({ minimum: 0.2, maximum: 1.2 })),
    salvoInterval: Type.Optional(PositiveNumber),
  },
  strict,
);
export type AiProfile = Static<typeof AiProfile>;

export const AiProfileSet = Type.Object(
  { formatVersion: Type.Literal(1), profiles: Type.Array(AiProfile, { minItems: 1 }) },
  strict,
);
export type AiProfileSet = Static<typeof AiProfileSet>;
