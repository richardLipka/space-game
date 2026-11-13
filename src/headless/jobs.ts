import catalogueJson from "../data/core/catalogue.json";
import { validateCatalogue } from "../data/validate";
import { applyOverlay, type BalanceOverlay } from "../data/balance/overlay";
import { BALANCE, deriveCatalogue, type Balance } from "../data/balance/model";
import { setRuntimeBalance } from "../sim/systems/heat";
import { AI_PROFILES, aiProfile } from "../data/ai/index";
import { BUNDLED_DESIGNS, CORE_DRONES } from "../data/designs/index";
import { SCENARIOS } from "../data/scenarios/index";
import type { Scenario } from "../data/schemas/scenario";
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
      /** Balance-model parameters to derive the catalogue from (default: the game's own table). */
      readonly balance?: Balance;
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
      /** Balance-model parameters to derive the catalogue from (default: the game's own table). */
      readonly balance?: Balance;
      /**
       * Seeded random offsets of every ship's spawn (m) and heading (degrees). Mirror matches are otherwise
       * so symmetric that both ships take the same damage at the same moment.
       */
      readonly jitter?: { readonly position: number; readonly angle: number };
      /** End the battle as soon as nobody can fight any more (it would only run out the clock). */
      readonly stopWhenDisarmed?: boolean;
    }
  | {
      readonly kind: "scenario";
      readonly scenario: string;
      readonly seed: number;
      readonly profile: string;
      readonly timeLimit: number;
      readonly overlay: BalanceOverlay;
      /** Balance-model parameters to derive the catalogue from (default: the game's own table). */
      readonly balance?: Balance;
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

/**
 * The core catalogue derived from `balance` (default: the game's table) with `overlay` applied. Cached per
 * combination; the cache is kept small because tuning tries a new combination every few battles.
 */
export function catalogueFor(overlay: BalanceOverlay, balance?: Balance): PartCatalogue {
  const key = JSON.stringify([overlay, balance ?? null]);
  let c = catalogues.get(key);
  if (!c) {
    if (catalogues.size >= 16) catalogues.clear();
    const derived = balance ? deriveCatalogue(base, balance) : base;
    c = PartCatalogue.fromJson(applyOverlay(derived, overlay));
    catalogues.set(key, c);
  }
  return c;
}

/** Spawn points and headings moved by a seeded random amount (the same job always moves them the same). */
export function jitterSpawns(
  sc: Scenario,
  seed: number,
  j: { readonly position: number; readonly angle: number },
): Scenario {
  let state = (seed * 2654435761) | 0;
  const rnd = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), state | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  };
  const move = (t: { position: [number, number]; angle: number }) => ({
    position: [t.position[0] + rnd() * j.position, t.position[1] + rnd() * j.position] as [number, number],
    angle: t.angle + rnd() * j.angle,
  });
  return {
    ...sc,
    enemies: sc.enemies.map((e) => ({ ...e, spawn: move(e.spawn) })),
    playerSpawns: sc.playerSpawns.map(move),
  };
}

/** Runs a job with its balance parameters in force (catalogue and run-time values), then restores them. */
export function runJob(job: Job): JobResult {
  setRuntimeBalance(job.balance ?? BALANCE);
  try {
    return runJobWith(job);
  } finally {
    setRuntimeBalance(BALANCE);
  }
}

function runJobWith(job: Job): JobResult {
  const cat = catalogueFor(job.overlay, job.balance);
  if (job.kind === "skirmish") {
    const sc = job.arenaFrom ? SCENARIOS.find((x) => x.id === job.arenaFrom) : undefined;
    const arena = sc?.arena ?? { width: 14000, height: 10000, asteroids: [], gravityWells: [] };
    const sk = skirmishBattle(job.setup, BUNDLED_DESIGNS, arena);
    const scenario = job.jitter ? jitterSpawns(sk.scenario, job.seed, job.jitter) : sk.scenario;
    const battle = startBattle({ ...scenario, seed: job.seed }, sk.fleet, cat, {
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
      if (job.stopWhenDisarmed && i % 60 === 59 && !obs.undecided()) break;
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
