import type { StanceId } from "../../data/ai/stances";
import type { Gene } from "./genome";

/**
 * What the tuner measures and what it aims for. The default below can be replaced by a JSON file with the
 * same shape (`--config file.json`); missing fields fall back to the default.
 */
export interface Matchup {
  readonly id: string;
  /** Designs of each side (a mirror match lists the same designs on both sides). */
  readonly sides: readonly [readonly string[], readonly string[]];
  /** Fight length band (s, first hit to the end) counted as right, and the length aimed for inside it. */
  readonly band: readonly [number, number];
  readonly target?: number;
  /** Relative importance in the loss (default 1). */
  readonly weight?: number;
  /** AI type flying both sides (default aggressive, so fights are not decided by who runs away). */
  readonly pilot?: StanceId;
  /** Start distance (m, default 4000). */
  readonly distance?: number;
  /**
   * Time limit (s). Default: 90 s to close in plus twice the band's upper end, capped by the config's
   * limit — a fight that long is far off target whatever its exact length, and stopping it early saves
   * most of the run time.
   */
  readonly limit?: number;
  /** Random spawn offset (m, default 300) so mirror fights are not perfectly symmetric. */
  readonly jitter?: number;
}

export const limitOf = (m: Matchup, cfg: TuningConfig) =>
  m.limit ?? Math.min(cfg.timeLimit, 90 + 2 * m.band[1]);

export interface LossWeights {
  /** Pull toward the target inside the band (0: anything inside the band is as good). */
  readonly centre: number;
  /** Per share of battles that time out, beyond `allowedTimeouts`. */
  readonly timeouts: number;
  readonly allowedTimeouts: number;
  /** Per share of battles that end with both sides out of ammunition. */
  readonly ammoOut: number;
  /**
   * Spread of fight lengths inside a matchup (interquartile range over median): fights of the same ships
   * should not swing between a 10 s alpha strike and a 5 minute brawl.
   */
  readonly spread: number;
  readonly allowedSpread: number;
  /** Pull back toward the starting values (per gene, squared distance in range units). */
  readonly drift: number;
}

export interface TuningConfig {
  readonly genes: readonly Gene[];
  readonly matchups: readonly Matchup[];
  /** Battles per matchup and parameter set. */
  readonly seeds: number;
  /** Time limit per battle (s); a fight still running then counts as this long and as a timeout. */
  readonly timeLimit: number;
  readonly loss: LossWeights;
}

/**
 * Default genes: the balance-model parameters that set how long fights last and what ends them.
 * Hit points set the pace for every weapon; heat, power and ammunition decide whether ships can keep
 * fighting; per-weapon damage lets one weapon family's mirror fights be tuned apart from the others.
 */
export const DEFAULT_GENES: readonly Gene[] = [
  { id: "hp", target: "balance:hp.*", min: 0.25, max: 6, log: true, note: "hit points of every component" },
  { id: "hpArmor", target: "balance:hp.armor", min: 400, max: 4000, log: true, note: "armor HP per m³" },
  {
    id: "hpCommand",
    target: "balance:hp.command",
    min: 600,
    max: 6000,
    log: true,
    note: "command module HP per m³",
  },
  {
    id: "hpWeapon",
    target: "balance:hp.weapon",
    min: 250,
    max: 2500,
    log: true,
    note: "weapon HP per m³ (fights end in mutual disarming when turrets break first)",
  },
  {
    id: "missileFactor",
    target: "balance:ordnance.damageFactor",
    min: 1.5,
    max: 15,
    log: true,
    note: "smart missile warhead ÷ heavy shell",
  },
  {
    id: "fireTime",
    target: "balance:game.fireTime",
    min: 60,
    max: 480,
    log: true,
    note: "seconds of fire per magazine",
  },
  {
    id: "fuelHeat",
    target: "balance:heat.perKgFuel",
    min: 4000,
    max: 80000,
    log: true,
    note: "engine heat per kg of fuel (J)",
  },
  {
    id: "muzzleHeat",
    target: "balance:heat.muzzleShare",
    min: 0.004,
    max: 0.08,
    log: true,
    note: "gun heat as a share of muzzle energy",
  },
  {
    id: "radiator",
    target: "balance:heat.radiatorTurrets",
    min: 0.75,
    max: 3,
    log: true,
    note: "laser turrets one m³ of radiator cools",
  },
  {
    id: "hullHeat",
    target: "balance:heat.hullPerMetre",
    min: 800,
    max: 6000,
    log: true,
    note: "heat the hull sheds per metre (W)",
  },
  {
    id: "reactor",
    target: "balance:power.perVolume",
    min: 100_000,
    max: 320_000,
    log: true,
    note: "reactor output per m³ (W)",
  },
  {
    id: "dmgLaser",
    target: "overlay:weapons.core:weapon.laser.turret.s.damage",
    min: 0.4,
    max: 2.5,
    log: true,
    note: "small laser turret damage factor",
  },
  {
    id: "dmgAutocannon",
    target: "overlay:weapons.core:weapon.autocannon.turret.s.damage",
    min: 0.4,
    max: 2.5,
    log: true,
    note: "autocannon turret damage factor",
  },
  {
    id: "dmgLightAutocannon",
    target: "overlay:weapons.core:weapon.autocannon.turret.light.damage",
    min: 0.4,
    max: 2.5,
    log: true,
    note: "light autocannon turret damage factor",
  },
  {
    id: "dmgCannon",
    target: "overlay:weapons.core:weapon.cannon.turret.m.damage",
    min: 0.4,
    max: 2.5,
    log: true,
    note: "medium cannon turret damage factor",
  },
];

const mirror = (designs: readonly string[]): readonly [readonly string[], readonly string[]] => [
  designs,
  designs,
];

/**
 * Default matchups: identical ships and groups against each other. Small ships fight fast and brutally,
 * medium ones longer, and two large ships for three to five minutes.
 */
export const DEFAULT_MATCHUPS: readonly Matchup[] = [
  { id: "small-wasp", sides: mirror(["fleet-wasp"]), band: [15, 60], target: 30 },
  { id: "small-spark", sides: mirror(["fleet-spark"]), band: [15, 60], target: 30 },
  {
    id: "small-group",
    sides: mirror(["fleet-wasp", "fleet-wasp", "fleet-spark"]),
    band: [30, 90],
    target: 50,
  },
  { id: "medium-maul", sides: mirror(["fleet-maul"]), band: [45, 150], target: 90 },
  { id: "medium-needle", sides: mirror(["fleet-needle"]), band: [45, 150], target: 90 },
  { id: "large-rapier", sides: mirror(["fleet-rapier"]), band: [180, 300], target: 240, weight: 1.5 },
  { id: "large-viper", sides: mirror(["fleet-viper"]), band: [180, 300], target: 240 },
  { id: "large-anvil", sides: mirror(["fleet-anvil"]), band: [180, 300], target: 240, weight: 1.5 },
  {
    id: "large-group",
    sides: mirror(["fleet-rapier", "fleet-viper"]),
    band: [180, 300],
    target: 240,
  },
];

export const DEFAULT_CONFIG: TuningConfig = {
  genes: DEFAULT_GENES,
  matchups: DEFAULT_MATCHUPS,
  seeds: 4,
  timeLimit: 600,
  loss: {
    centre: 0.25,
    timeouts: 2,
    allowedTimeouts: 0.05,
    ammoOut: 1,
    spread: 0.3,
    allowedSpread: 1,
    drift: 0.05,
  },
};

/** A config from JSON over the default (genes and matchups replace the default lists when given). */
export function configFrom(json: Partial<TuningConfig> | undefined): TuningConfig {
  if (!json) return DEFAULT_CONFIG;
  return {
    ...DEFAULT_CONFIG,
    ...json,
    loss: { ...DEFAULT_CONFIG.loss, ...(json.loss ?? {}) },
  };
}
