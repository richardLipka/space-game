import catalogueJson from "../data/core/catalogue.json";
import { validateCatalogue } from "../data/validate";
import { applyOverlay, type BalanceOverlay } from "../data/balance/overlay";
import { AI_PROFILES, aiProfile } from "../data/ai/index";
import { BUNDLED_DESIGNS, CORE_DRONES } from "../data/designs/index";
import { SCENARIOS } from "../data/scenarios/index";
import { PartCatalogue } from "../sim/ship/catalogue";
import { runMatch, type MatchResult } from "./balance";
import { runScenario, type ScenarioRun } from "./scenario-runs";
import { BattleObserver, type BattleMetrics } from "./observe";
import { applySkirmishOrders, skirmishBattle, type SkirmishSetup } from "../sim/scenario/skirmish";
import { startBattle, updateBattle } from "../sim/scenario/battle";

/**
 * One battle for the balance tools, described by plain data so it can run in a worker thread:
 * an archetype duel or a scenario, under a balance overlay. Same job → same result on any thread.
 */
export type Job =
  | {
      readonly kind: "match";
      readonly a: string;
      readonly b: string;
      readonly seed: number;
      readonly profile: string;
      readonly timeLimit: number;
      readonly overlay: BalanceOverlay;
    }
  | {
      readonly kind: "skirmish";
      /** Label for reports (e.g. "s11 aggressive vs cautious"). */
      readonly label: string;
      readonly setup: SkirmishSetup;
      /** Arena (asteroids) from a scenario, or open space. */
      readonly arenaFrom?: string;
      readonly seed: number;
      readonly timeLimit: number;
      readonly overlay: BalanceOverlay;
    }
  | {
      readonly kind: "scenario";
      readonly scenario: string;
      readonly seed: number;
      readonly profile: string;
      readonly timeLimit: number;
      readonly overlay: BalanceOverlay;
    };

export type JobResult =
  | { kind: "match"; job: Job; result: MatchResult }
  | { kind: "scenario"; job: Job; result: ScenarioRun }
  | { kind: "skirmish"; job: Job; result: SkirmishRun };

export interface SkirmishRun {
  readonly label: string;
  readonly seed: number;
  /** Side 1 won ("a"), side 2 won ("b") or neither in time. */
  readonly metrics: BattleMetrics;
}

const base = (() => {
  const r = validateCatalogue(catalogueJson);
  if (!r.ok) throw new Error(r.errors.join("\n"));
  return r.value;
})();
const catalogues = new Map<string, PartCatalogue>();

/** The core catalogue with `overlay` applied (cached per overlay). */
export function catalogueFor(overlay: BalanceOverlay): PartCatalogue {
  const key = JSON.stringify(overlay);
  let c = catalogues.get(key);
  if (!c) {
    c = PartCatalogue.fromJson(applyOverlay(base, overlay));
    catalogues.set(key, c);
  }
  return c;
}

export function runJob(job: Job): JobResult {
  const cat = catalogueFor(job.overlay);
  if (job.kind === "skirmish") {
    const sc = job.arenaFrom ? SCENARIOS.find((x) => x.id === job.arenaFrom) : undefined;
    const arena = sc?.arena ?? { width: 14000, height: 10000, asteroids: [], gravityWells: [] };
    const sk = skirmishBattle(job.setup, BUNDLED_DESIGNS, arena);
    const battle = startBattle({ ...sk.scenario, seed: job.seed }, sk.fleet, cat, {
      seed: job.seed,
      designs: BUNDLED_DESIGNS,
      profiles: sk.profiles,
      droneDesigns: CORE_DRONES,
    });
    applySkirmishOrders(battle, sk, job.setup);
    const obs = new BattleObserver(battle.world, battle.allyShips, battle.enemyShips);
    const ticks = Math.round(job.timeLimit * 60);
    for (let i = 0; i < ticks && battle.status === "running"; i++) {
      battle.world.step();
      updateBattle(battle);
      obs.tick(1 / 60);
    }
    return { kind: "skirmish", job, result: { label: job.label, seed: job.seed, metrics: obs.finish() } };
  }
  const profile = aiProfile(job.profile);
  if (job.kind === "match") {
    const a = BUNDLED_DESIGNS.get(job.a);
    const b = BUNDLED_DESIGNS.get(job.b);
    if (!a || !b) throw new Error(`Unknown design ${job.a} / ${job.b}`);
    const result = runMatch(a, b, cat, CORE_DRONES, job.seed, {
      profileA: profile,
      profileB: profile,
      timeLimit: job.timeLimit,
    });
    return { kind: "match", job, result };
  }
  const s = SCENARIOS.find((x) => x.id === job.scenario);
  if (!s) throw new Error(`Unknown scenario ${job.scenario}`);
  const result = runScenario(s, job.seed, cat, {
    designs: BUNDLED_DESIGNS,
    profiles: AI_PROFILES,
    droneDesigns: CORE_DRONES,
    playerProfile: profile,
    timeLimit: job.timeLimit,
  });
  return { kind: "scenario", job, result };
}
