import { Type, type Static } from "@sinclair/typebox";

const strict = { additionalProperties: false } as const;
const Word = Type.String({ minLength: 1, maxLength: 40 });

/**
 * One part of a name (given or family): picked from a list of whole names, or built from syllable groups
 * (one piece from each group, joined), with `partChance` deciding between the two. An optional prefix
 * ("von", "Mac") is put in front with its own chance.
 */
export const NamePool = Type.Object(
  {
    names: Type.Array(Word, { minItems: 1 }),
    /** Groups of pieces; a built name takes one from each group in order ("" = nothing). */
    parts: Type.Optional(
      Type.Array(Type.Array(Type.String({ maxLength: 20 }), { minItems: 1 }), { minItems: 1 }),
    ),
    /** Chance of a built name instead of one from the list (0–1, default 0). */
    partChance: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
    prefix: Type.Optional(
      Type.Object(
        { values: Type.Array(Word, { minItems: 1 }), chance: Type.Number({ minimum: 0, maximum: 1 }) },
        strict,
      ),
    ),
  },
  strict,
);
export type NamePool = Static<typeof NamePool>;

/** A naming style: given and family name pools, the order they are written in, and how often it is used. */
export const NameStyle = Type.Object(
  {
    id: Type.String({ pattern: "^[a-z0-9-]+$", minLength: 1, maxLength: 30 }),
    label: Word,
    /** Share of random officers given this style when no style is chosen (relative weight, default 1). */
    weight: Type.Optional(Type.Number({ minimum: 0 })),
    /** "given-family" (Ada Cogsworth) or "family-given" (Tanaka Hiroshi). */
    order: Type.Union([Type.Literal("given-family"), Type.Literal("family-given")]),
    given: NamePool,
    family: NamePool,
  },
  strict,
);
export type NameStyle = Static<typeof NameStyle>;

/** The name descriptor file (src/data/names/names.json, docs/officers.md). */
export const NameDescriptor = Type.Object(
  {
    formatVersion: Type.Literal(1),
    styles: Type.Array(NameStyle, { minItems: 1 }),
  },
  strict,
);
export type NameDescriptor = Static<typeof NameDescriptor>;
