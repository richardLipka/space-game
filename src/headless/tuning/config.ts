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

/**
 * Ship designs must stay workable: a parameter set that leaves a fleet design with much less power for its
 * weapons, or much less cooling for its heat, than it has today is refused before any battle is fought.
 * Margins are the editor's own numbers (power production ÷ combat demand, dissipation ÷ heat at full use),
 * each compared with the same design under the game's current values.
 */
export interface Viability {
  /** Refuse a set when any design's margin falls below this share of its current margin (or of 1). */
  readonly refuseBelow: number;
  /** Loss per squared shortfall below 1 × the reference margin, for sets that are not refused. */
  readonly weight: number;
  /** Loss of a refused set (plus its shortfall), so the search learns to stay away. */
  readonly refusedLoss: number;
}

export interface TuningConfig {
  readonly genes: readonly Gene[];
  readonly matchups: readonly Matchup[];
  /** Battles per matchup and parameter set. */
  readonly seeds: number;
  /** Time limit per battle (s); a fight still running then counts as this long and as a timeout. */
  readonly timeLimit: number;
  readonly loss: LossWeights;
  readonly viability: Viability;
}

/**
 * Default genes: the balance model's exchange rates (src/data/balance/model.ts), never single part values.
 * Every one is a ratio or a rate the formulas turn into many parts' numbers at once, and they are chosen to
 * pull apart: the pace moves every fight; HP ratios decide what breaks first; family shares move one weapon
 * family against the others; supply, cooling and endurance decide whether ships can keep fighting.
 * Structure HP per m³ stays fixed: it anchors the scale.
 */
const g = (id: string, path: string, min: number, max: number, note: string, log = true): Gene => ({
  id,
  target: `balance:${path}`,
  min,
  max,
  log,
  note,
});

export const DEFAULT_GENES: readonly Gene[] = [
  g("pace", "weapons.killTime", 1.5, 25, "s for 1 m³ of kinetic weapon system to destroy 1 m³ of structure"),
  g("hpArmor", "hp.armor", 1, 12, "armor HP per m³ ÷ structure"),
  g("hpCommand", "hp.command", 2, 20, "command module HP per m³ ÷ structure"),
  g("hpWeapon", "hp.weapon", 0.6, 6, "weapon HP per m³ ÷ structure (disarming vs destruction)"),
  g("hpSystems", "hp.systems", 0.4, 3, "factor on every other system's HP ratio"),
  g("armorStop", "armor.stop", 0.05, 1.5, "s of a 1 m³ kinetic system's damage a plate stops per hit"),
  g("beam", "weapons.family.beam", 0.15, 2, "beam damage rate per system m³ ÷ kinetic"),
  g("missile", "weapons.family.missile", 0.3, 4, "missile damage rate per system m³ ÷ kinetic"),
  g("pd", "weapons.family.pd", 0.4, 5, "point-defense damage rate per system m³ ÷ kinetic"),
  g("rangePrice", "weapons.range.exponent", -0.5, 1, "damage rate × (range ÷ 1500 m)^−x", false),
  g("calibre", "weapons.calibre.exponent", -0.3, 0.3, "damage rate × (interval ÷ 0.12 s)^x", false),
  g("supply", "power.turretsPerVolume", 0.5, 2.5, "reactor output per m³, in laser turrets"),
  g("radiator", "heat.radiatorTurrets", 0.75, 4, "laser turrets one m³ of radiator cools"),
  g("hullHeat", "heat.hullTurretsPerMetre", 0.004, 0.04, "laser turrets of heat a metre of hull sheds"),
  g("fuelHeat", "heat.perKgFuel", 3000, 80_000, "engine heat per kg of fuel (J)"),
  g("muzzleHeat", "heat.muzzleShare", 0.003, 0.08, "gun heat as a share of muzzle energy"),
  g("fireTime", "game.fireTime", 60, 480, "s of fire one magazine gives one weapon"),
  g("missileHp", "hp.missilePerKg", 0.0003, 0.005, "missile HP per kg ÷ structure HP per m³"),
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
  viability: { refuseBelow: 0.6, weight: 1, refusedLoss: 5 },
};

/** A config from JSON over the default (genes and matchups replace the default lists when given). */
export function configFrom(json: Partial<TuningConfig> | undefined): TuningConfig {
  if (!json) return DEFAULT_CONFIG;
  return {
    ...DEFAULT_CONFIG,
    ...json,
    loss: { ...DEFAULT_CONFIG.loss, ...(json.loss ?? {}) },
    viability: { ...DEFAULT_CONFIG.viability, ...(json.viability ?? {}) },
  };
}
