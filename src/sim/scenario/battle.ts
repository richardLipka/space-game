import type { ShipDesign } from "../../data/schemas/design";
import type { Scenario } from "../../data/schemas/scenario";
import type { AiProfile } from "../../data/schemas/ai";
import { degToRad, vec2 } from "../core/vec2";
import type { PartCatalogue } from "../ship/catalogue";
import type { Ship } from "../ship/ship-entity";
import type { World } from "../world";
import { createWorldFromScenario } from "./setup";

/**
 * Scenario battles (spec §12, plan M7 tasks 1–3): fleet budget check, set-up from a scenario, objective
 * tracking and the numbers for the results screen. Pure simulation code: no DOM, no storage.
 */

export interface FleetCheck {
  readonly ok: boolean;
  readonly cost: number;
  readonly errors: readonly string[];
}

/** Fleet cost (sum of part costs) against the scenario's budget, ship limit and allowed parts (7.4). */
export function checkFleet(
  scenario: Scenario,
  fleet: readonly ShipDesign[],
  catalogue: PartCatalogue,
): FleetCheck {
  const errors: string[] = [];
  let cost = 0;
  for (const d of fleet)
    for (const p of d.parts) cost += catalogue.has(p.partId) ? catalogue.get(p.partId).def.cost : 0;
  if (fleet.length === 0) errors.push("Add at least one ship to the fleet.");
  if (fleet.length > scenario.maxPlayerShips)
    errors.push(`Too many ships: ${fleet.length} of at most ${scenario.maxPlayerShips}.`);
  if (cost > scenario.budget) errors.push(`Over budget: ${cost} of ${scenario.budget}.`);
  const allowed = scenario.allowedParts ? new Set(scenario.allowedParts) : null;
  if (allowed)
    for (const d of fleet)
      for (const p of d.parts)
        if (!allowed.has(p.partId)) errors.push(`${d.name}: ${p.partId} is not allowed in this scenario.`);
  return { ok: errors.length === 0, cost, errors: [...new Set(errors)] };
}

export type BattleStatus = "running" | "won" | "lost";

export interface BattleTally {
  /** Hull damage dealt by the player's side and taken by it. */
  dealt: number;
  taken: number;
  /** Player parts destroyed (wrecked or ejected). */
  partsLost: number;
}

export interface Battle {
  readonly scenario: Scenario;
  readonly world: World;
  readonly playerShips: Ship[];
  readonly enemyShips: Ship[];
  /** Allied AI ships from the scenario (team 0), e.g. the ship to protect. */
  readonly allyShips: Ship[];
  readonly protectId: string | null;
  status: BattleStatus;
  reason: string;
  /** Battle time when the status changed (s). */
  endTime: number | null;
  readonly tally: BattleTally;
}

export interface BattleOptions {
  readonly seed?: number;
  /** Resolves design ids used by the scenario (enemies, protect target). */
  readonly designs: ReadonlyMap<string, ShipDesign>;
  readonly profiles: ReadonlyMap<string, AiProfile>;
  /** Drone designs hangars can launch. */
  readonly droneDesigns?: readonly ShipDesign[];
}

/** Builds the world and spawns the player's fleet and the scenario's AI ships. */
export function startBattle(
  scenario: Scenario,
  fleet: readonly ShipDesign[],
  catalogue: PartCatalogue,
  opts: BattleOptions,
): Battle {
  const world = createWorldFromScenario(scenario, opts.seed !== undefined ? { seed: opts.seed } : {});
  for (const d of opts.droneDesigns ?? []) world.registerDesign(d);
  const playerShips = fleet.map((d, i) => {
    const sp = scenario.playerSpawns[i] ?? scenario.playerSpawns[0];
    const pos = sp?.position ?? [0, 0];
    const offset = i >= scenario.playerSpawns.length ? i * 60 : 0;
    return world.addShip(d, catalogue, {
      position: vec2(pos[0], pos[1] + offset),
      angle: degToRad(sp?.angle ?? 0),
      team: 0,
    });
  });
  const enemyShips: Ship[] = [];
  const allyShips: Ship[] = [];
  let protectId: string | null = null;
  for (const e of scenario.enemies) {
    const d = opts.designs.get(e.designId);
    if (!d) throw new Error(`Scenario ${scenario.id}: unknown design "${e.designId}"`);
    const profile = opts.profiles.get(e.aiProfile);
    if (!profile) throw new Error(`Scenario ${scenario.id}: unknown AI profile "${e.aiProfile}"`);
    const s = world.addShip(d, catalogue, {
      position: vec2(e.spawn.position[0], e.spawn.position[1]),
      angle: degToRad(e.spawn.angle),
      team: e.team,
    });
    if (e.team === 0) {
      allyShips.push(s);
      world.setAi(s.id, profile, { kind: "hold", point: world.physics.getWorldCenter(s.id) });
      if (scenario.objective.type === "protect" && e.designId === scenario.objective.designId && !protectId)
        protectId = s.id;
    } else {
      enemyShips.push(s);
      world.setAi(s.id, profile);
    }
  }
  if (scenario.objective.type === "protect" && !protectId)
    throw new Error(
      `Scenario ${scenario.id}: no team-0 ship with design "${scenario.objective.designId}" to protect`,
    );
  return {
    scenario,
    world,
    playerShips,
    enemyShips,
    allyShips,
    protectId,
    status: "running",
    reason: "",
    endTime: null,
    tally: { dealt: 0, taken: 0, partsLost: 0 },
  };
}

const hull = (s: Ship) => s.parts.reduce((t, p) => t + Math.max(0, p.hp), 0);
const maxHull = (s: Ship) => s.parts.reduce((t, p) => t + p.def.def.hp, 0);

/**
 * Checks the objective after a world step (7.3). The status changes once; later calls keep it. Also
 * updates the tally (damage dealt and taken, player parts lost).
 */
export function updateBattle(b: Battle): BattleStatus {
  const w = b.world;
  const playerIds = new Set(b.playerShips.map((s) => s.id));
  let dealt = 0;
  for (const [attacker, row] of Object.entries(w.combat.damage))
    if (playerIds.has(attacker)) for (const v of Object.values(row)) dealt += v;
  b.tally.dealt = dealt;
  let taken = 0;
  let lost = 0;
  for (const s of b.playerShips) {
    taken += Math.max(0, maxHull(s) - hull(s));
    lost += s.parts.filter((p) => p.hp <= 0).length + (s.design.parts.length - s.parts.length);
  }
  b.tally.taken = taken;
  b.tally.partsLost = lost;
  if (b.status !== "running") return b.status;
  const end = (status: BattleStatus, reason: string) => {
    b.status = status;
    b.reason = reason;
    b.endTime = w.time;
  };
  if (b.playerShips.every((s) => s.defeated)) {
    end("lost", "All your ships were defeated.");
    return b.status;
  }
  const o = b.scenario.objective;
  const enemiesDown = b.enemyShips.every((s) => s.defeated);
  if (o.type === "protect") {
    const p = b.protectId && w.hasShip(b.protectId) ? w.getShip(b.protectId) : null;
    if (!p || p.defeated) end("lost", `${p?.design.name ?? "The escorted ship"} was destroyed.`);
    else if (enemiesDown) end("won", `${p.design.name} is safe.`);
  } else if (o.type === "survive") {
    if (w.time >= o.seconds) end("won", `You held out for ${o.seconds} s.`);
  } else if (enemiesDown) end("won", "Every enemy ship was defeated.");
  return b.status;
}

/** Steps the battle until it ends or `maxSeconds` pass (headless runs, tests). */
export function runBattle(b: Battle, maxSeconds: number): BattleStatus {
  const ticks = Math.round(maxSeconds * 60);
  for (let i = 0; i < ticks && b.status === "running"; i++) {
    b.world.step();
    updateBattle(b);
  }
  return b.status;
}
