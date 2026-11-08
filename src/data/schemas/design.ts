import { Type, type Static } from "@sinclair/typebox";
import { IsoDate, PartId, Uuidish } from "./common";

const strict = { additionalProperties: false } as const;

export const PowerGroup = Type.Union(
  ["propulsion", "gyro", "weapons", "pointDefense", "hangar"].map((g) => Type.Literal(g)),
);
export type PowerGroup = "propulsion" | "gyro" | "weapons" | "pointDefense" | "hangar";

export const GroupMode = Type.Union([Type.Literal("hold"), Type.Literal("manual"), Type.Literal("ai")]);

export const PartPlacement = Type.Object(
  {
    uid: Uuidish,
    partId: PartId,
    x: Type.Number(),
    y: Type.Number(),
    angle: Type.Number({ description: "degrees" }),
    weaponGroup: Type.Optional(Type.Integer({ minimum: 1, maximum: 9 })),
  },
  strict,
);
export type PartPlacement = Static<typeof PartPlacement>;

/** Ship design save file (spec §4.3). Connections are recomputed from geometry, never stored. */
export const ShipDesign = Type.Object(
  {
    formatVersion: Type.Literal(1),
    id: Uuidish,
    name: Type.String({ minLength: 1, maxLength: 80 }),
    author: Type.Optional(Type.String({ maxLength: 80 })),
    description: Type.Optional(Type.String({ maxLength: 2000 })),
    drone: Type.Optional(Type.Boolean()),
    createdAt: IsoDate,
    modifiedAt: IsoDate,
    parts: Type.Array(PartPlacement, { minItems: 1 }),
    weaponGroupModes: Type.Record(Type.String({ pattern: "^[1-9]$" }), GroupMode),
    powerPriority: Type.Array(PowerGroup, { uniqueItems: true }),
  },
  strict,
);
export type ShipDesign = Static<typeof ShipDesign>;
