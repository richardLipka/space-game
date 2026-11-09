import { Type, type Static } from "@sinclair/typebox";
import { IsoDate, PartId, Uuidish } from "./common";

const strict = { additionalProperties: false } as const;

export const PowerGroup = Type.Union(
  ["propulsion", "gyro", "weapons", "pointDefense", "hangar"].map((g) => Type.Literal(g)),
);
export type PowerGroup = "propulsion" | "gyro" | "weapons" | "pointDefense" | "hangar";

export const GroupMode = Type.Union([Type.Literal("hold"), Type.Literal("manual"), Type.Literal("ai")]);

/**
 * How an automatic (AI-mode) weapon group picks what to shoot (decision log: Weapon groups):
 * target = the selected target first, then the nearest enemy; nearest; threat = most dangerous for its
 * distance; weakest = lowest hull first; drones = small craft first; missiles = missiles aimed at this
 * ship first (point-defense duty for guns), then like `target`.
 */
export const TargetPriority = Type.Union(
  ["target", "nearest", "threat", "weakest", "drones", "missiles"].map((p) => Type.Literal(p)),
);
export type TargetPriority = "target" | "nearest" | "threat" | "weakest" | "drones" | "missiles";

/** Saved settings of one weapon group (its mode lives in `weaponGroupModes`). */
export const WeaponGroupSettings = Type.Object(
  {
    name: Type.Optional(Type.String({ maxLength: 40 })),
    /** Automatic fire starts within this distance (m); defaults to each weapon's own range. */
    range: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
    priority: Type.Optional(TargetPriority),
  },
  strict,
);
export type WeaponGroupSettings = Static<typeof WeaponGroupSettings>;

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
    /** Per-group fire range, target priority and name (groups 1–9). */
    weaponGroups: Type.Optional(Type.Record(Type.String({ pattern: "^[1-9]$" }), WeaponGroupSettings)),
    powerPriority: Type.Array(PowerGroup, { uniqueItems: true }),
  },
  strict,
);
export type ShipDesign = Static<typeof ShipDesign>;
