import type { ShipDesign } from "../data/schemas/design";
import type { Scenario } from "../data/schemas/scenario";
import type { AiProfile } from "../data/schemas/ai";
import type { PartCatalogue } from "../sim/ship/catalogue";
import { startBattle, updateBattle } from "../sim/scenario/battle";
import { BattleObserver, type BattleMetrics } from "./observe";

/**
 * Scenario simulation mode (balance tooling): a scenario fought AI against AI, the reference fleet on the
 * player's side, with the same metrics as the archetype duels.
 */
export interface ScenarioRun {
  readonly scenario: string;
  readonly seed: number;
  readonly status: "won" | "lost" | "running";
  readonly metrics: BattleMetrics;
  /** Hull damage the player's side dealt, by weapon part id. */
  readonly damage: Readonly<Record<string, number>>;
}

export function runScenario(
  scenario: Scenario,
  seed: number,
  catalogue: PartCatalogue,
  ctx: {
    readonly designs: ReadonlyMap<string, ShipDesign>;
    readonly profiles: ReadonlyMap<string, AiProfile>;
    readonly droneDesigns: readonly ShipDesign[];
    readonly playerProfile: AiProfile;
    readonly fleet?: readonly ShipDesign[];
    readonly timeLimit: number;
  },
): ScenarioRun {
  const fleet = ctx.fleet ?? (scenario.referenceDesigns ?? []).map((id) => ctx.designs.get(id)!);
  const b = startBattle(scenario, fleet, catalogue, {
    seed,
    designs: ctx.designs,
    profiles: ctx.profiles,
    droneDesigns: ctx.droneDesigns,
  });
  for (const p of b.playerShips) b.world.setAi(p.id, ctx.playerProfile);
  const obs = new BattleObserver(b.world, [...b.playerShips, ...b.allyShips], b.enemyShips);
  const ticks = Math.round(ctx.timeLimit * 60);
  for (let i = 0; i < ticks && b.status === "running"; i++) {
    b.world.step();
    updateBattle(b);
    obs.tick(1 / 60);
  }
  const damage: Record<string, number> = {};
  for (const p of b.playerShips)
    for (const [k, v] of Object.entries(b.world.combat.damage[p.id] ?? {})) damage[k] = (damage[k] ?? 0) + v;
  const m = obs.finish();
  // The objective decides the winner in scenarios (survive / protect), not only who is left standing.
  const metrics: BattleMetrics = {
    ...m,
    winner: b.status === "won" ? "a" : b.status === "lost" ? "b" : "draw",
  };
  return { scenario: scenario.id, seed, status: b.status, metrics, damage };
}
