import { generateName } from "./names";
import type { NameDescriptor } from "../../data/schemas/names";
import type { Officer, PortraitPart, PortraitSpec, Position } from "../../data/schemas/officer";
import type { ShipClass } from "../ship/classes";

/**
 * Officers (docs/officers.md): each has three positive and two negative traits that change ship
 * performance by a few percent. The position an officer holds emphasises the traits that matter to it
 * (a tactical officer's gunnery counts more, its helmsmanship less). Traits come in three strengths (small,
 * medium, full). Experience (levels 1–5) trains one stat per level above the first. A ship's modifiers are
 * the sum over its officers.
 */

export type Stat =
  | "thrust"
  | "turning"
  | "gunDamage"
  | "missileDamage"
  | "pdDamage"
  | "fireRate"
  | "accuracy"
  | "cooling"
  | "power";

export const STATS: readonly Stat[] = [
  "thrust",
  "turning",
  "gunDamage",
  "missileDamage",
  "pdDamage",
  "fireRate",
  "accuracy",
  "cooling",
  "power",
];

export const STAT_LABEL: Record<Stat, string> = {
  thrust: "Thrust",
  turning: "Turning",
  gunDamage: "Gun damage",
  missileDamage: "Missile damage",
  pdDamage: "Point defense",
  fireRate: "Rate of fire",
  accuracy: "Accuracy",
  cooling: "Cooling",
  power: "Reactor output",
};

export interface Trait {
  readonly id: string;
  readonly name: string;
  readonly positive: boolean;
  /** Percent per stat, before position emphasis and experience. */
  readonly effects: Readonly<Partial<Record<Stat, number>>>;
}

export const TRAITS: readonly Trait[] = [
  { id: "steady-hand", name: "Steady hand", positive: true, effects: { accuracy: 6 } },
  { id: "gunnery-expert", name: "Gunnery expert", positive: true, effects: { gunDamage: 5 } },
  { id: "missile-savant", name: "Missile savant", positive: true, effects: { missileDamage: 6 } },
  { id: "quick-loader", name: "Quick loader", positive: true, effects: { fireRate: 5 } },
  { id: "daredevil", name: "Daredevil", positive: true, effects: { turning: 4, thrust: 3 } },
  { id: "hot-rodder", name: "Hot-rodder", positive: true, effects: { thrust: 5 } },
  { id: "cool-head", name: "Cool head", positive: true, effects: { cooling: 6 } },
  { id: "reactor-whisperer", name: "Reactor whisperer", positive: true, effects: { power: 6 } },
  { id: "eagle-eye", name: "Eagle eye", positive: true, effects: { accuracy: 3, pdDamage: 3 } },
  { id: "pd-ace", name: "Point-defense ace", positive: true, effects: { pdDamage: 7 } },
  { id: "tactician", name: "Tactician", positive: true, effects: { gunDamage: 3, missileDamage: 3 } },
  { id: "smooth-helm", name: "Smooth helm", positive: true, effects: { turning: 6 } },
  { id: "heavy-handed", name: "Heavy-handed", positive: false, effects: { accuracy: -4 } },
  { id: "slow-reflexes", name: "Slow reflexes", positive: false, effects: { turning: -4 } },
  { id: "sloppy-loader", name: "Sloppy loader", positive: false, effects: { fireRate: -4 } },
  { id: "reckless", name: "Reckless", positive: false, effects: { cooling: -5 } },
  { id: "superstitious", name: "Superstitious", positive: false, effects: { missileDamage: -4 } },
  { id: "gun-shy", name: "Gun-shy", positive: false, effects: { gunDamage: -4 } },
  { id: "absent-minded", name: "Absent-minded", positive: false, effects: { pdDamage: -5 } },
  { id: "timid-throttle", name: "Timid throttle", positive: false, effects: { thrust: -4 } },
  { id: "wasteful", name: "Wasteful", positive: false, effects: { power: -4 } },
  { id: "nervous", name: "Nervous", positive: false, effects: { accuracy: -2, turning: -2 } },
];

const TRAIT_BY_ID = new Map(TRAITS.map((t) => [t.id, t]));
export const trait = (id: string): Trait | undefined => TRAIT_BY_ID.get(id);

export interface PositionDef {
  readonly id: Position;
  readonly label: string;
  /** Stats this post works on: their trait effects count ×`FOCUS`, the others ×`OFF_FOCUS`. */
  readonly focus: readonly Stat[];
}

export const POSITIONS: Record<Position, PositionDef> = {
  pilot: { id: "pilot", label: "Pilot", focus: ["thrust", "turning", "gunDamage", "accuracy"] },
  captain: { id: "captain", label: "Captain", focus: [] },
  tactical: {
    id: "tactical",
    label: "Tactical",
    focus: ["gunDamage", "missileDamage", "pdDamage", "fireRate", "accuracy"],
  },
  navigation: { id: "navigation", label: "Navigation", focus: ["thrust", "turning"] },
  engineering: { id: "engineering", label: "Engineering", focus: ["cooling", "power", "fireRate"] },
  operations: { id: "operations", label: "Operations", focus: ["pdDamage", "missileDamage", "accuracy"] },
};

/** Emphasis of a trait effect on a stat the position works on, and on one it does not. */
export const FOCUS = 1.5;
export const OFF_FOCUS = 0.5;
/** A pilot flies alone: off-focus stats still count fully. A captain oversees everything evenly. */
const PILOT_OFF = 1;
const CAPTAIN = 0.8;
/** Trait strength 1–3 (small, medium, full) as a share of the trait's listed effect. */
export const STRENGTH = [0, 1 / 3, 2 / 3, 1] as const;
export const STRENGTH_LABEL = ["", "small", "medium", "full"] as const;
/** Experience: every level above 1 trains one stat by this many percent (before post emphasis). */
export const TRAINING_PCT = 3;

/** Stats a post trains when an older file lists no training (captains: an even spread). */
const CAPTAIN_TRAINING: readonly Stat[] = ["accuracy", "thrust", "cooling", "gunDamage"];

/** The stats an officer's levels trained, one per level above 1 (older files: the post's own stats). */
export function trainingOf(o: Pick<Officer, "level" | "position" | "training">): Stat[] {
  const n = Math.min(5, Math.max(1, o.level)) - 1;
  const known = (o.training ?? []).filter((s): s is Stat => (STATS as readonly string[]).includes(s));
  if (o.training && known.length >= n) return known.slice(0, n);
  const focus = POSITIONS[o.position]?.focus.length ? POSITIONS[o.position]!.focus : CAPTAIN_TRAINING;
  const out = known.slice(0, n);
  for (let k = out.length; k < n; k++) out.push(focus[k % focus.length]!);
  return out;
}

/** A stat for a new level: the post's own stats three times as likely as any other. */
export function levelUpStat(random: () => number, position: Position): Stat {
  const focus = POSITIONS[position].focus;
  const pool = [...STATS, ...focus, ...focus];
  return pool[Math.floor(random() * pool.length)]!;
}

/** Positions a ship of this class has, in order. */
export function crewSlots(cls: ShipClass): Position[] {
  if (cls === "drone") return [];
  if (cls === "fighter") return ["pilot"];
  if (cls === "corvette" || cls === "frigate") return ["captain", "tactical"];
  return ["captain", "tactical", "navigation", "engineering", "operations"];
}

function emphasis(position: Position, stat: Stat): number {
  if (position === "captain") return CAPTAIN;
  const focused = POSITIONS[position].focus.includes(stat);
  if (position === "pilot") return focused ? FOCUS : PILOT_OFF;
  return focused ? FOCUS : OFF_FOCUS;
}

export type OfficerStats = Pick<Officer, "traits" | "level" | "position" | "strength" | "training">;

/** What an officer adds in a position (percent per stat, rounded to 0.1): traits by strength, plus training. */
export function officerEffects(o: OfficerStats, position: Position): Partial<Record<Stat, number>> {
  const sum: Partial<Record<Stat, number>> = {};
  o.traits.forEach((id, i) => {
    const t = trait(id);
    if (!t) return;
    const k = STRENGTH[o.strength?.[i] ?? 3] ?? 1;
    for (const [s, pct] of Object.entries(t.effects) as [Stat, number][])
      sum[s] = (sum[s] ?? 0) + pct * k * emphasis(position, s);
  });
  for (const s of trainingOf(o)) sum[s] = (sum[s] ?? 0) + TRAINING_PCT * emphasis(position, s);
  const out: Partial<Record<Stat, number>> = {};
  for (const [s, v] of Object.entries(sum) as [Stat, number][]) out[s] = Math.round(v * 10) / 10;
  return out;
}

export type Mods = Readonly<Record<Stat, number>>;
export const NO_MODS: Mods = Object.fromEntries(STATS.map((s) => [s, 1])) as Mods;

/** A ship's multipliers from its crew (1 = no effect), each kept within ±30 %. */
export function shipMods(crew: readonly { officer: OfficerStats; position: Position }[]): Mods {
  const pct: Partial<Record<Stat, number>> = {};
  for (const c of crew)
    for (const [s, v] of Object.entries(officerEffects(c.officer, c.position)) as [Stat, number][])
      pct[s] = (pct[s] ?? 0) + v;
  return Object.fromEntries(
    STATS.map((s) => [s, Math.min(1.3, Math.max(0.7, 1 + (pct[s] ?? 0) / 100))]),
  ) as Mods;
}

// ---------- random officers ----------

/** Option counts of every portrait part (src/ui/portrait.ts draws them). */
export const PORTRAIT_COUNTS: Readonly<Record<PortraitPart, number>> = {
  head: 7,
  skin: 9,
  hair: 18,
  hairColor: 11,
  eyes: 13,
  mouth: 9,
  facialHair: 11,
  neck: 9,
  uniform: 13,
  uniformColor: 10,
  collar: 12,
  accessory: 15,
};

/** Seeded random numbers (mulberry32). */
export function crewRng(seed: number): () => number {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Uniform styles (uniform, cap, collar and colour indices): British colonial navy whites, a modern uniform with
 * metal stripes, and the Kaiserliche Marine's dark tunic with its high collar.
 */
export const UNIFORM_STYLES = {
  colonial: { uniform: 10, hair: 15, collar: 9, uniformColor: 5 },
  modern: { uniform: 11, hair: 16, collar: 11, uniformColor: 3 },
  kaiser: { uniform: 12, hair: 17, collar: 10, uniformColor: 0 },
} as const satisfies Record<string, Partial<PortraitSpec>>;
export type UniformStyle = keyof typeof UNIFORM_STYLES;

export function randomPortrait(random: () => number): PortraitSpec {
  const pick = (n: number) => Math.floor(random() * n);
  const c = PORTRAIT_COUNTS;
  const spec: PortraitSpec = {
    head: pick(c.head),
    skin: pick(c.skin),
    hair: pick(c.hair),
    hairColor: pick(c.hairColor),
    eyes: pick(c.eyes),
    mouth: pick(c.mouth),
    facialHair: random() < 0.55 ? 0 : pick(c.facialHair),
    neck: pick(c.neck),
    uniform: pick(c.uniform),
    uniformColor: pick(c.uniformColor),
    collar: pick(c.collar),
    accessory: random() < 0.35 ? 0 : pick(c.accessory),
    suit: random() < 0.15,
  };
  // Sometimes a second accessory; often one of the uniform styles.
  if (spec.accessory && random() < 0.3) {
    const extra = 1 + pick(c.accessory - 1);
    if (extra !== spec.accessory) spec.extras = [extra];
  }
  if (random() < 0.45) {
    const styles = Object.values(UNIFORM_STYLES);
    const st = styles[Math.floor(random() * styles.length)]!;
    spec.uniform = st.uniform;
    spec.collar = st.collar;
    spec.uniformColor = st.uniformColor;
    if (random() < 0.7) spec.hair = st.hair;
  }
  return spec;
}

/** Name options for random officers: a style id (or "mixed") and the descriptor to draw from. */
export interface NameOptions {
  readonly style?: string;
  readonly names?: NameDescriptor;
}

/** A random officer for `position`: three positive and two negative traits, level 1–5 (lower more common). */
export function randomOfficer(
  random: () => number,
  position: Position,
  id: string,
  names: NameOptions = {},
): Officer {
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(random() * xs.length)]!;
  const draw = (pool: Trait[], n: number) => {
    const out: string[] = [];
    while (out.length < n && pool.length) out.push(pool.splice(Math.floor(random() * pool.length), 1)[0]!.id);
    return out;
  };
  // Officers lean towards traits of their post.
  const focus = POSITIONS[position].focus;
  const pos = TRAITS.filter((t) => t.positive);
  const weighted = [
    ...pos,
    ...pos.filter((t) => Object.keys(t.effects).some((s) => focus.includes(s as Stat))),
  ];
  const positives: string[] = [];
  while (positives.length < 3) {
    const t = pick(weighted).id;
    if (!positives.includes(t)) positives.push(t);
  }
  const negatives = draw(
    TRAITS.filter((t) => !t.positive),
    2,
  );
  const level = 1 + Math.min(4, Math.floor(-Math.log(1 - random() * 0.97) * 1.4));
  // Trait strengths: small, medium or full, equally likely.
  const strength = Array.from({ length: 5 }, () => 1 + Math.floor(random() * 3));
  const training = Array.from({ length: level - 1 }, () => levelUpStat(random, position));
  const { name, origin } = generateName(random, names.style, names.names);
  return {
    id,
    name,
    origin,
    position,
    level,
    traits: [...positives, ...negatives],
    strength,
    training,
    portrait: randomPortrait(random),
  };
}

/** A whole crew for a ship class: one random officer per position. */
export function randomCrew(random: () => number, cls: ShipClass, idPrefix: string): Officer[] {
  return crewSlots(cls).map((p, i) => randomOfficer(random, p, `${idPrefix}-${i + 1}`));
}
