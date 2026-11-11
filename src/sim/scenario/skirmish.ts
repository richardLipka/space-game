import type { FlightModel } from "../flight/arcade";
import type { AiProfile } from "../../data/schemas/ai";
import type { ShipDesign } from "../../data/schemas/design";
import type { Scenario } from "../../data/schemas/scenario";
import { GUARD_RADIUS, type Battle } from "./battle";
import {
  stance,
  stanceProfile,
  stanceValues,
  type StanceId,
  type StanceParamKey,
} from "../../data/ai/stances";

/**
 * Skirmish setup: two sides, each a list of ships with a design and either the player at the helm or one
 * of the four AI types with its parameters. Turned into an ordinary scenario battle (destroy every enemy),
 * so objectives, results and watch mode work the same as for the scenario list.
 */
export type SkirmishPilot = "player" | StanceId;

export interface SkirmishShip {
  readonly designId: string;
  readonly pilot: SkirmishPilot;
  readonly params?: Partial<Record<StanceParamKey, number>>;
  /** Defensive AI: index of the ship on the same side it guards. */
  readonly guard?: number;
}

export interface SkirmishSetup {
  /** Side 0 (blue, the player's) and side 1 (red). */
  readonly sides: readonly [readonly SkirmishShip[], readonly SkirmishShip[]];
  /** Distance between the two lines at the start (m). */
  readonly distance: number;
  /** How ships fly in this battle (default newtonian). */
  readonly flightModel?: FlightModel;
}

export const DEFAULT_SKIRMISH: SkirmishSetup = {
  sides: [
    [
      { designId: "fleet-rapier", pilot: "player" },
      { designId: "fleet-wasp", pilot: "defensive", guard: 0 },
    ],
    [
      { designId: "fleet-rapier", pilot: "aggressive" },
      { designId: "fleet-viper", pilot: "cautious" },
    ],
  ],
  distance: 5000,
};

const SPACING = 400;

export interface SkirmishBattle {
  readonly scenario: Scenario;
  /** Player-flown designs (spawned first, in this order). */
  readonly fleet: ShipDesign[];
  readonly profiles: ReadonlyMap<string, AiProfile>;
  /**
   * For every scenario `enemies` entry, the skirmish ship it came from: [side, index]. Player ships are
   * not in `enemies`; `playerSlots` lists them.
   */
  readonly enemySlots: readonly (readonly [number, number])[];
  readonly playerSlots: readonly number[];
}

/** Problems that keep a setup from starting (empty list = it can start). */
export function checkSkirmish(setup: SkirmishSetup, designs: ReadonlyMap<string, ShipDesign>): string[] {
  const errors: string[] = [];
  setup.sides.forEach((side, s) => {
    if (side.length === 0) errors.push(`Side ${s + 1} has no ships.`);
    side.forEach((ship, i) => {
      if (!designs.has(ship.designId)) errors.push(`Side ${s + 1}, ship ${i + 1}: unknown design.`);
      if (ship.pilot === "player" && s !== 0) errors.push(`Only side 1 can have player ships.`);
      if (ship.pilot === "defensive" && (ship.guard === undefined || ship.guard === i || !side[ship.guard]))
        errors.push(`Side ${s + 1}, ship ${i + 1}: a defensive AI needs another ship of its side to guard.`);
    });
  });
  return errors;
}

/** The scenario, player fleet and AI profiles for a valid setup (see checkSkirmish). */
export function skirmishBattle(
  setup: SkirmishSetup,
  designs: ReadonlyMap<string, ShipDesign>,
  arena: Scenario["arena"],
): SkirmishBattle {
  const profiles = new Map<string, AiProfile>();
  const enemies: Scenario["enemies"] = [];
  const enemySlots: [number, number][] = [];
  const playerSpawns: Scenario["playerSpawns"] = [];
  const fleet: ShipDesign[] = [];
  const playerSlots: number[] = [];
  const x0 = setup.distance / 2;
  // Enemies-list index of each skirmish ship (for guard orders).
  const index = new Map<string, number>();
  setup.sides.forEach((side, s) => {
    const n = side.length;
    side.forEach((ship, i) => {
      const position: [number, number] = [s === 0 ? -x0 : x0, (i - (n - 1) / 2) * SPACING];
      const angle = s === 0 ? 0 : 180;
      if (ship.pilot === "player") {
        fleet.push(designs.get(ship.designId)!);
        playerSpawns.push({ position, angle });
        playerSlots.push(i);
        return;
      }
      const id = `skirmish-${s}-${i}`;
      profiles.set(id, { ...stanceProfile(ship.pilot, ship.params), id });
      index.set(`${s}:${i}`, enemies.length);
      enemySlots.push([s, i]);
      enemies.push({
        designId: ship.designId,
        aiProfile: id,
        spawn: { position, angle },
        team: s,
      });
    });
  });
  // Guard orders point at enemies-list entries; a player ship cannot be guarded this way (it is not in
  // the list), so defensive AI guarding the player follows the player's ship instead (see main).
  enemySlots.forEach(([s, i], k) => {
    const ship = setup.sides[s]![i]!;
    if (ship.pilot !== "defensive" || ship.guard === undefined) return;
    const target = index.get(`${s}:${ship.guard}`);
    const radius = stanceValues("defensive", ship.params).guardRadius;
    if (target !== undefined) enemies[k] = { ...enemies[k]!, guard: target, guardRadius: radius };
  });
  const scenario: Scenario = {
    id: "skirmish",
    name: "Skirmish",
    description: "Custom battle",
    budget: 1e9,
    maxPlayerShips: Math.max(1, fleet.length),
    arena,
    playerSpawns: playerSpawns.length ? playerSpawns : [{ position: [-x0, 0], angle: 0 }],
    enemies,
    objective: { type: "destroyAll" },
    seed: 1,
  };
  return { scenario, fleet, profiles, enemySlots, playerSlots };
}

/** Short summary of a ship's pilot for lists ("Defensive · guard 2500 m"). */
export function pilotLabel(ship: SkirmishShip): string {
  if (ship.pilot === "player") return "Player";
  const s = stance(ship.pilot);
  return s.name;
}

/**
 * After startBattle: scenario allies hold their spawn point, but skirmish AI ships on side 1 fight freely,
 * except defensive ones, which guard their ship (set here when that ship is player-flown).
 */
export function applySkirmishOrders(battle: Battle, sk: SkirmishBattle, setup: SkirmishSetup): void {
  let ally = 0;
  sk.scenario.enemies.forEach((e, k) => {
    if (e.team !== 0) return;
    const ship = battle.allyShips[ally++]!;
    const st = battle.world.ai.get(ship.id);
    if (!st) return;
    const [s, i] = sk.enemySlots[k]!;
    const def = setup.sides[s]![i]!;
    const playerIdx = def.guard !== undefined ? sk.playerSlots.indexOf(def.guard) : -1;
    if (def.pilot === "defensive" && playerIdx >= 0)
      st.order = {
        kind: "guard",
        target: battle.playerShips[playerIdx]!.id,
        radius: stanceValues("defensive", def.params).guardRadius ?? GUARD_RADIUS,
      };
    else if (st.order?.kind !== "guard") st.order = null;
  });
}
