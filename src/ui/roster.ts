import type { ShipDesign } from "../data/schemas/design";
import type { Officer, Position, Roster } from "../data/schemas/officer";
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

export function loadRoster(): Roster {
  try {
    const r = validateRoster(JSON.parse(safeStorage.get(KEY) ?? "null"));
    return r.ok ? r.value : emptyRoster();
  } catch {
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

/** Simple string hash (FNV-1a) for seeding enemy crews from ship ids. */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/**
 * Puts officers aboard every ship of a battle: the player's side (team 0) carries the crew the roster gives
 * its design (posts left empty stay empty), every other ship a random crew seeded by the battle and the
 * ship. Drones carry none.
 */
export function crewBattle(
  world: World,
  roster: Roster,
  playerTeam = 0,
  names: NameOptions = { names: loadNames() },
): void {
  for (const ship of world.allShips()) {
    if (ship.drone) continue;
    const cls = classOfMass(ship.massProps.mass);
    const slots = crewSlots(cls);
    if (!slots.length) continue;
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
