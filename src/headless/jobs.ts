import catalogueJson from "../data/core/catalogue.json";
import { validateCatalogue } from "../data/validate";
import { applyOverlay, type BalanceOverlay } from "../data/balance/overlay";
import { AI_PROFILES, aiProfile } from "../data/ai/index";
import { BUNDLED_DESIGNS, CORE_DRONES } from "../data/designs/index";
import { SCENARIOS } from "../data/scenarios/index";
import { PartCatalogue } from "../sim/ship/catalogue";
import { runMatch, type MatchResult } from "./balance";
import { runScenario, type ScenarioRun } from "./scenario-runs";

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
      readonly kind: "scenario";
      readonly scenario: string;
      readonly seed: number;
      readonly profile: string;
      readonly timeLimit: number;
      readonly overlay: BalanceOverlay;
    };

export type JobResult =
  { kind: "match"; job: Job; result: MatchResult } | { kind: "scenario"; job: Job; result: ScenarioRun };

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
