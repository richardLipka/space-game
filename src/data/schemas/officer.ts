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
    /** Space suit: a helmet ring round the head instead of the uniform's collar. */
    suit: Type.Boolean(),
  },
  strict,
);
export type PortraitSpec = Static<typeof PortraitSpec>;

export const Position = Type.Union([
  Type.Literal("pilot"),
  Type.Literal("captain"),
  Type.Literal("tactical"),
  Type.Literal("navigation"),
  Type.Literal("engineering"),
  Type.Literal("operations"),
]);
export type Position = Static<typeof Position>;

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
    portrait: PortraitSpec,
  },
  strict,
);
export type Officer = Static<typeof Officer>;

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
