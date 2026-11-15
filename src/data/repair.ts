import type { TSchema, Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { CrewEntry, Officer, PortraitSpec, Position, Roster } from "./schemas/officer";
import { validate, validateOfficer, type ValidationResult } from "./validate";
import {
  crewRng,
  PORTRAIT_COUNTS,
  POSITIONS,
  randomPortrait,
  trainingOf,
  trait,
  TRAITS,
} from "../sim/crew/officers";
import { generateName } from "../sim/crew/names";

/**
 * Tolerant loading (docs/save-load.md): files written by another version of the game, or naming things this
 * version does not have, load as far as they can instead of failing. Each repair returns notes saying what
 * was dropped or replaced, for a warning to the player.
 */

export type Repaired<T> = { ok: true; value: T; notes: string[] } | { ok: false; errors: string[] };

/**
 * Validates, and when the only problem is properties this version does not know (a newer file), loads the
 * data without them. `check` adds the semantic checks of the strict validator.
 */
export function lenient<S extends TSchema>(
  schema: S,
  data: unknown,
  check: (d: unknown) => ValidationResult<Static<S>> = (d) => validate(schema, d),
): Repaired<Static<S>> {
  const first = check(data);
  if (first.ok) return { ok: true, value: first.value, notes: [] };
  if (!first.errors.some((e) => e.includes("unexpected property")))
    return { ok: false, errors: first.errors };
  let cleaned: unknown;
  try {
    cleaned = Value.Clean(schema, structuredClone(data));
  } catch {
    return { ok: false, errors: first.errors };
  }
  const second = check(cleaned);
  if (!second.ok) return { ok: false, errors: second.errors };
  const dropped = first.errors.filter((e) => e.includes("unexpected property"));
  return {
    ok: true,
    value: second.value,
    notes: [
      `Ignored ${dropped.length} setting(s) this version does not know: ${dropped.slice(0, 3).join("; ")}`,
    ],
  };
}

const POS_IDS = Object.keys(POSITIONS) as Position[];
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
let repairCounter = 0;

/**
 * An officer from whatever a file holds: unknown traits are replaced by random ones of the same kind (three
 * positive, two negative), bad levels, posts, portraits and names get defaults. Null when it is not an
 * officer at all.
 */
export function repairOfficer(raw: unknown, seed = 1): { officer: Officer | null; notes: string[] } {
  if (!isObj(raw)) return { officer: null, notes: ["An entry is not an officer; skipped."] };
  const exact = validateOfficer(raw);
  if (exact.ok) return { officer: exact.value, notes: [] };
  const random = crewRng(seed + repairCounter++ * 7919);
  const notes: string[] = [];
  const position: Position = POS_IDS.includes(raw.position as Position)
    ? (raw.position as Position)
    : "captain";
  const named = typeof raw.name === "string" && raw.name.trim().length > 0;
  const name = named ? (raw.name as string).trim().slice(0, 60) : generateName(random).name;
  const label = named ? name : "An officer";
  const id =
    typeof raw.id === "string" && ID_RE.test(raw.id)
      ? raw.id
      : `officer-r${Date.now().toString(36)}${repairCounter}`;
  const level = Number.isFinite(raw.level) ? Math.min(5, Math.max(1, Math.round(raw.level as number))) : 1;
  // Traits: keep known ones (first three positive, first two negative), refill the rest.
  const rawTraits = Array.isArray(raw.traits) ? raw.traits : [];
  const rawStrength = Array.isArray(raw.strength) ? raw.strength : [];
  const kept: { id: string; positive: boolean; strength: number }[] = [];
  rawTraits.forEach((t, i) => {
    const def = typeof t === "string" ? trait(t) : undefined;
    if (!def) {
      notes.push(`${label}: unknown trait "${String(t)}" replaced.`);
      return;
    }
    if (kept.some((k) => k.id === def.id)) return;
    if (kept.filter((k) => k.positive === def.positive).length >= (def.positive ? 3 : 2)) return;
    const st = Number(rawStrength[i]);
    kept.push({ id: def.id, positive: def.positive, strength: st >= 1 && st <= 3 ? Math.round(st) : 3 });
  });
  for (const positive of [true, false]) {
    const want = positive ? 3 : 2;
    const pool = TRAITS.filter((t) => t.positive === positive && !kept.some((k) => k.id === t.id));
    while (kept.filter((k) => k.positive === positive).length < want && pool.length) {
      const t = pool.splice(Math.floor(random() * pool.length), 1)[0]!;
      kept.push({ id: t.id, positive, strength: 1 + Math.floor(random() * 3) });
    }
  }
  const ordered = [...kept.filter((k) => k.positive), ...kept.filter((k) => !k.positive)];
  // Portrait: every part an index (out of range wraps when drawn); missing parts random.
  const rp = isObj(raw.portrait) ? raw.portrait : {};
  const fallback = randomPortrait(random);
  const portrait = { ...fallback } as PortraitSpec;
  for (const k of Object.keys(PORTRAIT_COUNTS) as (keyof typeof PORTRAIT_COUNTS)[]) {
    const v = rp[k];
    if (Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 99) portrait[k] = v as number;
  }
  portrait.suit = typeof rp.suit === "boolean" ? rp.suit : fallback.suit;
  const extras = Array.isArray(rp.extras)
    ? rp.extras.filter((v): v is number => Number.isInteger(v) && v >= 0 && v <= 99).slice(0, 8)
    : [];
  if (extras.length) portrait.extras = extras;
  else delete portrait.extras;
  const training = trainingOf({
    level,
    position,
    training: Array.isArray(raw.training) ? (raw.training as Officer["training"]) : undefined,
  });
  const officer: Officer = {
    id,
    name,
    ...(typeof raw.origin === "string" && raw.origin.length <= 30 ? { origin: raw.origin } : {}),
    position,
    level,
    traits: ordered.map((k) => k.id),
    strength: ordered.map((k) => k.strength),
    training,
    portrait,
  };
  const check = validateOfficer(officer);
  if (!check.ok) return { officer: null, notes: [`${label}: cannot be read (${check.errors[0]}); skipped.`] };
  if (!notes.length) notes.push(`${label}: repaired.`);
  return { officer: check.value, notes };
}

/** Officers at posts (design or scenario files), repaired; entries that are not officers are skipped. */
export function repairCrew(raw: unknown, seed = 1): { crew: CrewEntry[]; notes: string[] } {
  if (raw === undefined) return { crew: [], notes: [] };
  if (!Array.isArray(raw)) return { crew: [], notes: ["The crew list cannot be read; skipped."] };
  const notes: string[] = [];
  const crew: CrewEntry[] = [];
  raw.slice(0, 5).forEach((e, i) => {
    if (!isObj(e) || !POS_IDS.includes(e.position as Position)) {
      notes.push(`Crew entry ${i + 1}: unknown post; skipped.`);
      return;
    }
    if (crew.some((c) => c.position === e.position)) return;
    const r = repairOfficer(e.officer, seed + i);
    notes.push(...r.notes);
    if (r.officer) crew.push({ position: e.position as Position, officer: r.officer });
  });
  return { crew, notes };
}

/** A roster from whatever a file holds: officers repaired, posts that name unknown officers dropped. */
export function repairRoster(raw: unknown): { roster: Roster; notes: string[] } {
  const empty: Roster = { formatVersion: 1, officers: [], crews: {} };
  if (!isObj(raw)) return { roster: empty, notes: raw == null ? [] : ["The roster cannot be read."] };
  const notes: string[] = [];
  if (raw.formatVersion !== 1) notes.push(`Roster format ${String(raw.formatVersion)} read as format 1.`);
  const officers: Officer[] = [];
  (Array.isArray(raw.officers) ? raw.officers : []).forEach((o, i) => {
    const r = repairOfficer(o, 1000 + i);
    notes.push(...r.notes);
    if (!r.officer) return;
    let off = r.officer;
    if (officers.some((x) => x.id === off.id)) {
      off = { ...off, id: `${off.id}-${i}` };
      notes.push(`${off.name}: duplicate id renamed.`);
    }
    officers.push(off);
  });
  const ids = new Set(officers.map((o) => o.id));
  const crews: Roster["crews"] = {};
  if (isObj(raw.crews))
    for (const [design, posts] of Object.entries(raw.crews)) {
      if (!isObj(posts)) continue;
      const out: Record<string, string> = {};
      for (const [pos, id] of Object.entries(posts)) {
        if (POS_IDS.includes(pos as Position) && typeof id === "string" && ids.has(id)) out[pos] = id;
        else notes.push(`Crew of ${design}: ${pos} dropped (unknown post or officer).`);
      }
      crews[design] = out;
    }
  return { roster: { formatVersion: 1, officers, crews }, notes };
}
