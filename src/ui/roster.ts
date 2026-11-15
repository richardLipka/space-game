import type { ShipDesign } from "../data/schemas/design";
import type { CrewEntry, Officer, Position, Roster } from "../data/schemas/officer";
import { repairRoster } from "../data/repair";
import { validateRoster } from "../data/validate";
import { crewRng, crewSlots, randomOfficer, type NameOptions } from "../sim/crew/officers";
import type { NameDescriptor } from "../data/schemas/names";
import { validateNames } from "../data/validate";
import { NAMES } from "../sim/crew/names";
import { classOfMass, type ShipClass } from "../sim/ship/classes";
import type { CrewMember, Ship } from "../sim/ship/ship-entity";
import type { World } from "../sim/world";
import { designStats } from "../editor/stats";
import type { PartCatalogue } from "../sim/ship/catalogue";
import { safeStorage } from "./storage";

/**
 * The officer roster (docs/officers.md): officers and their posts on ship designs, kept in the browser and
 * exported or imported as one JSON file (schema: src/data/schemas/officer.ts).
 */

const KEY = "space-game.roster.v1";

export const emptyRoster = (): Roster => ({ formatVersion: 1, officers: [], crews: {} });

/** Notes from repairing the stored roster on the last load (shown once as a warning). */
export let rosterLoadNotes: string[] = [];

/** The stored roster; officers that do not quite fit this version are repaired, not thrown away. */
export function loadRoster(): Roster {
  try {
    const raw = JSON.parse(safeStorage.get(KEY) ?? "null");
    const exact = validateRoster(raw);
    if (exact.ok) return exact.value;
    const { roster, notes } = repairRoster(raw);
    rosterLoadNotes = notes;
    return roster;
  } catch {
    rosterLoadNotes = ["The stored roster could not be read; starting empty."];
    return emptyRoster();
  }
}

export function saveRoster(r: Roster): void {
  safeStorage.set(KEY, JSON.stringify(r));
}

const NAMES_KEY = "space-game.names.v1";

/** The name descriptor in use: one imported in the roster, else the bundled one. */
export function loadNames(): NameDescriptor {
  try {
    const r = validateNames(JSON.parse(safeStorage.get(NAMES_KEY) ?? "null"));
    return r.ok ? r.value : NAMES;
  } catch {
    return NAMES;
  }
}

/** Keeps an imported name descriptor; null goes back to the bundled one. */
export function saveNames(n: NameDescriptor | null): void {
  if (n) safeStorage.set(NAMES_KEY, JSON.stringify(n));
  else safeStorage.remove(NAMES_KEY);
}

/** A design's class (by mass, from its parts). */
export function designClass(d: ShipDesign, cat: PartCatalogue): ShipClass {
  try {
    return classOfMass(designStats(d, cat).mass, !!d.drone);
  } catch {
    return "fighter";
  }
}

/** The officers holding the design's posts (posts the class does not have are ignored). */
export function crewOf(r: Roster, designId: string, cls: ShipClass): CrewMember[] {
  const posts = r.crews[designId] ?? {};
  const byId = new Map(r.officers.map((o) => [o.id, o]));
  return crewSlots(cls).flatMap((position) => {
    const o = posts[position] ? byId.get(posts[position]!) : undefined;
    return o ? [{ officer: o, position }] : [];
  });
}

let counter = 0;
const newId = () => `officer-${Date.now().toString(36)}-${(counter++).toString(36)}`;

/** A fresh random officer (for "New officer" and crew generation). */
export function freshOfficer(
  position: Position,
  seed = Date.now() + counter * 7919,
  names: NameOptions = {},
): Officer {
  return randomOfficer(crewRng(seed), position, newId(), names);
}

/** Fills every empty post of the design with a new random officer. Returns the roster changed in place. */
export function generateCrew(
  r: Roster,
  designId: string,
  cls: ShipClass,
  seed = Date.now(),
  names: NameOptions = {},
): Roster {
  const posts = { ...(r.crews[designId] ?? {}) };
  const ids = new Set(r.officers.map((o) => o.id));
  crewSlots(cls).forEach((p, i) => {
    if (posts[p] && ids.has(posts[p]!)) return;
    const o = freshOfficer(p, seed + i * 104729, names);
    r.officers.push(o);
    posts[p] = o.id;
  });
  r.crews[designId] = posts;
  return r;
}

/** The roster's officers at a design's posts, as crew entries (for ship files). */
export function crewEntries(r: Roster, design: ShipDesign, cat: PartCatalogue): CrewEntry[] {
  return crewOf(r, design.id, designClass(design, cat)).map((c) => ({
    position: c.position,
    officer: c.officer,
  }));
}

/**
 * Officers from a ship file join the roster at the design's posts. An officer whose id is taken by a
 * different officer gets a new id; one already in the roster (same id and content) is reused.
 */
export function adoptCrew(r: Roster, designId: string, crew: readonly CrewEntry[]): Roster {
  const officers = [...r.officers];
  const posts: Record<string, string> = { ...(r.crews[designId] ?? {}) };
  for (const c of crew) {
    let o = c.officer;
    const same = officers.find((x) => x.id === o.id);
    if (same && JSON.stringify(same) !== JSON.stringify(o)) o = { ...o, id: newId() };
    if (!officers.some((x) => x.id === o.id)) officers.push(o);
    posts[c.position] = o.id;
  }
  return { ...r, officers, crews: { ...r.crews, [designId]: posts } };
}

/** Simple string hash (FNV-1a) for seeding enemy crews from ship ids. */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/**
 * Puts officers aboard every ship of a battle: a crew set for that ship (scenario) first, then a crew the
 * design carries (ship file), then for the player's side (team 0) the crew the roster gives its design
 * (posts left empty stay empty), and for every other ship a random crew seeded by the battle and the ship.
 * Drones carry none.
 */
export interface BattleCrewOptions {
  readonly playerTeam?: number;
  readonly names?: NameOptions;
  /** Crews set for particular ships (scenario crew dialog), by ship id; they win over everything else. */
  readonly fixed?: ReadonlyMap<string, readonly CrewEntry[]>;
}

/** The entries for the posts a class has (one officer per post). */
const fitSlots = (entries: readonly CrewEntry[], cls: ShipClass): CrewMember[] =>
  crewSlots(cls).flatMap((position) => {
    const e = entries.find((c) => c.position === position);
    return e ? [{ officer: e.officer, position }] : [];
  });

export function crewBattle(world: World, roster: Roster, opts: BattleCrewOptions = {}): void {
  const playerTeam = opts.playerTeam ?? 0;
  const names = opts.names ?? { names: loadNames() };
  for (const ship of world.allShips()) {
    if (ship.drone) continue;
    const cls = classOfMass(ship.massProps.mass);
    const slots = crewSlots(cls);
    if (!slots.length) continue;
    const fixed = opts.fixed?.get(ship.id);
    if (fixed) {
      ship.setCrew(fitSlots(fixed, cls));
      continue;
    }
    if (ship.design.crew?.length) {
      ship.setCrew(fitSlots(ship.design.crew, cls));
      continue;
    }
    if (ship.team === playerTeam) {
      ship.setCrew(crewOf(roster, ship.design.id, cls));
      continue;
    }
    const random = crewRng(hash(`${world.seed}|${ship.id}|${ship.design.id}`));
    ship.setCrew(
      slots.map((position, i) => ({
        officer: randomOfficer(random, position, `${ship.id}-officer-${i + 1}`, names),
        position,
      })),
    );
  }
}

export const isShip = (s: unknown): s is Ship => !!s && typeof s === "object" && "setCrew" in s;
