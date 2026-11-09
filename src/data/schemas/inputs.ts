import { Type, type Static } from "@sinclair/typebox";

const strict = { additionalProperties: false } as const;

/** Control intent as stored in recorded input streams (spec §6.6). */
export const ControlIntentJson = Type.Object(
  {
    thrust: Type.Tuple([Type.Number({ minimum: -1, maximum: 1 }), Type.Number({ minimum: -1, maximum: 1 })]),
    rotate: Type.Number({ minimum: -1, maximum: 1 }),
    faceAngle: Type.Optional(Type.Number({ description: "degrees, world frame" })),
    speedKill: Type.Optional(
      Type.Union([Type.Literal("keep"), Type.Literal("flip"), Type.Literal("cancel")]),
    ),
    /** Weapons: trigger held, world aim point and selected groups (spec §9.2). */
    fire: Type.Optional(Type.Boolean()),
    aim: Type.Optional(Type.Tuple([Type.Number(), Type.Number()])),
    groups: Type.Optional(Type.Array(Type.Integer({ minimum: 1, maximum: 9 }), { uniqueItems: true })),
    /** Persistent: the selected target ship id (RMB), used by missiles and AI-mode weapons. */
    target: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Null()])),
    /** One-shot: launch a missile from every ready launcher at the target (M). */
    launch: Type.Optional(Type.Boolean()),
    /** One-shot: launch a single missile from the first ready launcher (M). */
    launchOne: Type.Optional(Type.Boolean()),
    /** One-shot: launch all drones (Shift+H). */
    drones: Type.Optional(Type.Boolean()),
    /** One-shot: launch a single drone (H). */
    droneOne: Type.Optional(Type.Boolean()),
    /** Persistent: PD may engage ships when no missiles or drones are in reach. */
    pdShips: Type.Optional(Type.Boolean()),
    /** One-shot: part uids to jettison on this tick (decision log: Ejection). */
    eject: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true })),
  },
  strict,
);
export type ControlIntentJson = Static<typeof ControlIntentJson>;

/**
 * Recorded input stream for golden runs and replays. Each frame sets a ship's intent from `tick` onward
 * (until the next frame for the same ship), so streams stay short.
 */
export const InputStream = Type.Object(
  {
    formatVersion: Type.Literal(1),
    frames: Type.Array(
      Type.Object(
        {
          tick: Type.Integer({ minimum: 0 }),
          ship: Type.String({ minLength: 1 }),
          intent: ControlIntentJson,
        },
        strict,
      ),
    ),
  },
  strict,
);
export type InputStream = Static<typeof InputStream>;
