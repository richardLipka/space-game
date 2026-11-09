import type { AiProfile } from "../schemas/ai";
import { aiProfile } from "./index";

/**
 * Skirmish AI types. Each type is a full AI profile built from a base profile plus a handful (3–5) of
 * parameters a player can tune. Defaults come from the AI parameter study (docs/ai-types.md).
 */
export type StanceId = "aggressive" | "defensive" | "retreating" | "cautious";

export type StanceParamKey =
  "rangeFactor" | "maxSpeed" | "retreatHp" | "minHitProbability" | "guardRadius" | "withdrawSpeed";

export interface StanceParam {
  readonly key: StanceParamKey;
  readonly label: string;
  readonly help: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  /** Shown as a percentage in the UI. */
  readonly percent?: boolean;
}

export interface StanceDef {
  readonly id: StanceId;
  readonly name: string;
  readonly description: string;
  /** Profile the type starts from (behaviour weights, volley timing, drone range). */
  readonly base: string;
  readonly params: readonly StanceParam[];
  readonly defaults: Readonly<Partial<Record<StanceParamKey, number>>>;
  /** Behaviour weight changes on top of the base profile. */
  readonly weights?: Partial<AiProfile["weights"]>;
  /** Defensive AI needs a ship to guard. */
  readonly needsGuardTarget?: boolean;
}

const P: Record<StanceParamKey, StanceParam> = {
  rangeFactor: {
    key: "rangeFactor",
    label: "Engage range",
    help: "Preferred distance as a share of the weapons' effective range",
    min: 0.2,
    max: 1.3,
    step: 0.05,
    percent: true,
  },
  maxSpeed: {
    key: "maxSpeed",
    label: "Top speed",
    help: "Speed limit when closing in or repositioning (m/s)",
    min: 40,
    max: 250,
    step: 10,
  },
  retreatHp: {
    key: "retreatHp",
    label: "Retreat below hull",
    help: "Falls back when its hull drops below this share",
    min: 0,
    max: 0.8,
    step: 0.05,
    percent: true,
  },
  minHitProbability: {
    key: "minHitProbability",
    label: "Fire threshold",
    help: "Fires only when the estimated hit chance is at least this",
    min: 0.05,
    max: 0.6,
    step: 0.05,
    percent: true,
  },
  guardRadius: {
    key: "guardRadius",
    label: "Guard radius",
    help: "Engages enemies within this distance of the guarded ship and never chases further (m)",
    min: 300,
    max: 4000,
    step: 100,
  },
  withdrawSpeed: {
    key: "withdrawSpeed",
    label: "Withdraw speed",
    help: "Speed of the steady fighting withdrawal (m/s)",
    min: 5,
    max: 120,
    step: 5,
  },
};

export const STANCES: readonly StanceDef[] = [
  {
    id: "aggressive",
    name: "Aggressive",
    description: "Closes in fast, fires at long odds and fights almost to the end.",
    base: "aggressive",
    params: [P.rangeFactor, P.maxSpeed, P.retreatHp, P.minHitProbability],
    defaults: { rangeFactor: 0.55, maxSpeed: 160, retreatHp: 0.1, minHitProbability: 0.1 },
  },
  {
    id: "defensive",
    name: "Defensive",
    description: "Stays with a guarded ship and engages only enemies that come near it.",
    base: "balanced",
    params: [P.guardRadius, P.rangeFactor, P.retreatHp, P.minHitProbability],
    defaults: { guardRadius: 2500, rangeFactor: 0.6, retreatHp: 0.15, minHitProbability: 0.15 },
    weights: { hold: 1.3, approach: 0.9 },
    needsGuardTarget: true,
  },
  {
    id: "retreating",
    name: "Retreating",
    description: "Falls back slowly from the nearest threat, guns pointed at it, and fights back.",
    base: "balanced",
    params: [P.withdrawSpeed, P.rangeFactor, P.minHitProbability],
    defaults: { withdrawSpeed: 20, rangeFactor: 0.9, minHitProbability: 0.15 },
  },
  {
    id: "cautious",
    name: "Cautious",
    description: "Keeps its distance, evades more and leaves early when hurt.",
    base: "kiter",
    params: [P.rangeFactor, P.maxSpeed, P.retreatHp, P.minHitProbability],
    defaults: { rangeFactor: 0.95, maxSpeed: 140, retreatHp: 0.3, minHitProbability: 0.15 },
    weights: { hold: 1.4, evade: 1.2 },
  },
];

export function stance(id: StanceId): StanceDef {
  const s = STANCES.find((x) => x.id === id);
  if (!s) throw new Error(`Unknown AI type "${id}"`);
  return s;
}

/** Parameter values of a type: its defaults with `overrides` on top, clamped to each parameter's range. */
export function stanceValues(
  id: StanceId,
  overrides: Partial<Record<StanceParamKey, number>> = {},
): Record<StanceParamKey, number> {
  const s = stance(id);
  const out = {} as Record<StanceParamKey, number>;
  for (const p of s.params) {
    const v = overrides[p.key] ?? s.defaults[p.key] ?? p.min;
    out[p.key] = Math.min(p.max, Math.max(p.min, v));
  }
  return out;
}

/** The AI profile for a type with the given parameter values (guard radius goes into the guard order). */
export function stanceProfile(
  id: StanceId,
  overrides: Partial<Record<StanceParamKey, number>> = {},
): AiProfile {
  const s = stance(id);
  const v = stanceValues(id, overrides);
  const base = aiProfile(s.base);
  const profile: AiProfile = {
    ...base,
    id: `stance-${id}`,
    name: s.name,
    stance: id,
    weights: { ...base.weights, ...s.weights },
  };
  if (v.rangeFactor !== undefined) profile.rangeFactor = v.rangeFactor;
  if (v.maxSpeed !== undefined) profile.maxSpeed = v.maxSpeed;
  if (v.retreatHp !== undefined) profile.retreatHp = v.retreatHp;
  if (v.minHitProbability !== undefined) profile.minHitProbability = v.minHitProbability;
  if (v.withdrawSpeed !== undefined) profile.withdrawSpeed = v.withdrawSpeed;
  return profile;
}
