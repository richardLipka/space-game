import { Type, type Static } from "@sinclair/typebox";

/** In JSON files, a 2D vector is written as a compact `[x, y]` tuple (metres unless stated). */
export const Vec2Json = Type.Tuple([Type.Number(), Type.Number()]);
export type Vec2Json = Static<typeof Vec2Json>;

export const Transform = Type.Object(
  { position: Vec2Json, angle: Type.Number({ description: "degrees" }) },
  { additionalProperties: false },
);
export type Transform = Static<typeof Transform>;

export const PositiveNumber = Type.Number({ exclusiveMinimum: 0 });
export const NonNegativeNumber = Type.Number({ minimum: 0 });
export const Fraction = Type.Number({ minimum: 0, maximum: 1 });

/** core:engine.main.m  |  user:7f3a9c/engine.ion  (spec §4.5) */
export const PartId = Type.String({
  pattern: "^(core:[a-z0-9][a-z0-9._-]*|user:[a-z0-9]+/[a-z0-9][a-z0-9._~-]*)$",
});

export const Uuidish = Type.String({ minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9._-]+$" });
export const IsoDate = Type.String({ minLength: 10, maxLength: 40 });
