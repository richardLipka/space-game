import { BALANCE } from "../../data/balance/model";

/** Global heat pool per ship (spec §7.4). */
export const HEAT = {
  /** Base heat capacity of any ship (J); heat sinks add to it. */
  baseCapacity: 5_000_000,
  /**
   * Hull surface radiation (W per metre of exposed outline). Every ship sheds a little heat through its
   * skin, so small or cool ships manage without radiators (decision log: Hull radiation).
   */
  hullRadiation: BALANCE.heat.hullPerMetre,
  /** Heat level where throttling starts (fraction of capacity). */
  throttleStart: 0.7,
  /** Output factor at 100 % heat. */
  throttleMin: 0.5,
  /** HP lost per second per unit of excess heat fraction, as a fraction of max HP. */
  overheatDamage: 0.5,
} as const;

/** Output factor for heat-producing parts: 1 below 70 %, linear down to 0.5 at 100 %, 0.5 above. */
export function heatThrottle(level: number): number {
  if (level <= HEAT.throttleStart) return 1;
  const t = Math.min(1, (level - HEAT.throttleStart) / (1 - HEAT.throttleStart));
  return 1 - (1 - HEAT.throttleMin) * t;
}

export interface RadiatorInput {
  readonly dissipation: number;
  /** Uncovered share of the radiating (function) edges, 0..1. */
  readonly exposedFraction: number;
  readonly retractedFactor: number;
  readonly hpFactor: number;
}

export function radiatorDissipation(r: RadiatorInput, extended: boolean): number {
  return r.dissipation * r.exposedFraction * (extended ? 1 : r.retractedFactor) * r.hpFactor;
}

/** Heat shed by the hull through `exposedLength` metres of uncovered outline (W). */
export function hullDissipation(exposedLength: number): number {
  return exposedLength * HEAT.hullRadiation;
}

/** New heat after one tick (never below zero). `dissipation` includes radiators and the hull. */
export function stepHeat(heat: number, generation: number, dissipation: number, dt: number): number {
  return Math.max(0, heat + (generation - dissipation) * dt);
}

/** Where heat comes from, for the HUD (W). */
export interface HeatSources {
  reactors: number;
  propulsion: number;
  gyros: number;
  weapons: number;
}

export interface HeatFlow {
  /** Total generation (W). */
  readonly generation: number;
  /** Total dissipation: radiators + hull (W). */
  readonly dissipation: number;
  readonly radiators: number;
  readonly hull: number;
  readonly sources: Readonly<HeatSources>;
}

export const NO_HEAT_FLOW: HeatFlow = {
  generation: 0,
  dissipation: 0,
  radiators: 0,
  hull: 0,
  sources: { reactors: 0, propulsion: 0, gyros: 0, weapons: 0 },
};

/** HP lost by one heat-producing part this tick when above 100 % (spec §7.4). */
export function overheatDamage(level: number, maxHp: number, dt: number): number {
  return level > 1 ? maxHp * HEAT.overheatDamage * (level - 1) * dt : 0;
}
