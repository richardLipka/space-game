import { Type, type Static } from "@sinclair/typebox";
import { Uuidish } from "./common";

const strict = { additionalProperties: false } as const;
const Index = Type.Integer({ minimum: 0, maximum: 99 });

/** Portrait parts by index (src/ui/portrait.ts draws them; out-of-range indices wrap). */
export const PortraitSpec = Type.Object(
  {
    head: Index,
    skin: Index,
    hair: Index,
    hairColor: Index,
    eyes: Index,
    mouth: Index,
    facialHair: Index,
    neck: Index,
    uniform: Index,
    uniformColor: Index,
    collar: Index,
    accessory: Index,
    /** More accessories worn together with `accessory` (scar, medal, monocle chain, …). */
    extras: Type.Optional(Type.Array(Index, { maxItems: 8 })),
    /** Space suit: a helmet ring round the head instead of the uniform's collar. */
    suit: Type.Boolean(),
    /**
     * Part layout version. 2: cigar, monocle and eyepatch are accessories. Without it the indices are read
     * the old way (eyes and mouth) and moved over (`migratePortrait`).
     */
    v: Type.Optional(Type.Integer({ minimum: 1, maximum: 99 })),
  },
  strict,
);
export type PortraitSpec = Static<typeof PortraitSpec>;
/** The portrait parts picked by a single index (not the suit flag or the extra accessories). */
export type PortraitPart = Exclude<keyof PortraitSpec, "suit" | "extras" | "v">;

export const Position = Type.Union([
  Type.Literal("pilot"),
  Type.Literal("captain"),
  Type.Literal("tactical"),
  Type.Literal("navigation"),
  Type.Literal("engineering"),
  Type.Literal("operations"),
]);
export type Position = Static<typeof Position>;

/** Ship stats officers change (src/sim/crew/officers.ts). */
export const StatId = Type.Union([
  Type.Literal("thrust"),
  Type.Literal("turning"),
  Type.Literal("gunDamage"),
  Type.Literal("missileDamage"),
  Type.Literal("pdDamage"),
  Type.Literal("fireRate"),
  Type.Literal("accuracy"),
  Type.Literal("cooling"),
  Type.Literal("power"),
]);
export type StatId = Static<typeof StatId>;

/**
 * An officer (docs/officers.md): three positive and two negative traits (ids from src/sim/crew/officers.ts),
 * an experience level from 1 to 5 and a portrait. Officers are kept in a roster (JSON) and assigned to the
 * positions of ships.
 */
export const Officer = Type.Object(
  {
    id: Uuidish,
    name: Type.String({ minLength: 1, maxLength: 60 }),
    /** Naming style the name came from (src/data/names/names.json), for new names in the same style. */
    origin: Type.Optional(Type.String({ maxLength: 30 })),
    /** The post the officer is trained for (shown in the roster; any officer can fill any position). */
    position: Position,
    level: Type.Integer({ minimum: 1, maximum: 5 }),
    traits: Type.Array(Type.String({ minLength: 1 }), { minItems: 5, maxItems: 5 }),
    /** Strength of each trait: 1 small, 2 medium, 3 full (absent = all full). */
    strength: Type.Optional(
      Type.Array(Type.Integer({ minimum: 1, maximum: 3 }), { minItems: 5, maxItems: 5 }),
    ),
    /**
     * What each level above the first trained: one stat per level (length level − 1). Absent (older files):
     * worked out from the post the officer is trained for.
     */
    training: Type.Optional(Type.Array(StatId, { maxItems: 4 })),
    /**
     * The AI profile this officer flies by when the ship is under AI control and the officer commands it
     * (captain, or the pilot of a fighter). Optional: without it the ship gets the usual default.
     */
    ai: Type.Optional(Type.String({ minLength: 1, maxLength: 40 })),
    portrait: PortraitSpec,
  },
  strict,
);
export type Officer = Static<typeof Officer>;

/** An officer at a post, carried in a ship design or scenario file (the crew travels with the ship). */
export const CrewEntry = Type.Object({ position: Position, officer: Officer }, strict);
export type CrewEntry = Static<typeof CrewEntry>;

/** The roster file: officers, and which officer holds which position on which ship design. */
export const Roster = Type.Object(
  {
    formatVersion: Type.Literal(1),
    officers: Type.Array(Officer),
    /** Design id → position → officer id. */
    crews: Type.Record(Type.String(), Type.Record(Type.String(), Uuidish)),
  },
  strict,
);
export type Roster = Static<typeof Roster>;
