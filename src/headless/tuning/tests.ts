import { BALANCE, type Balance } from "../../data/balance/model";
import { AI_PROFILES } from "../../data/ai/index";
import { BUNDLED_DESIGNS } from "../../data/designs/index";
import type { Scenario } from "../../data/schemas/scenario";
import { startBattle, updateBattle } from "../../sim/scenario/battle";
import type { PartCatalogue } from "../../sim/ship/catalogue";
import { setRuntimeBalance } from "../../sim/systems/heat";
import { jitterSpawns } from "../jitter";

/**
 * Tuning tests: scenarios built from the test platforms, each with a measured value and the range it
 * should fall in (docs/tuning.md, "Tuning tests"). They are ordinary scenarios, so they can be opened,
 * watched and changed in the scenario editor; `npm run tuning -- tests` measures them, and the GA adds
 * their misses to its loss.
 */

export interface TuningTest {
  readonly scenario: Scenario;
  /** Seconds each run lasts. */
  readonly seconds: number;
  /** What is measured in one run. */
  readonly measure: "stopped" | "damage";
  readonly note: string;
}

/** A rule over one or two tests' results. */
export interface TuningRule {
  readonly id: string;
  readonly text: string;
  /** Value of the rule from the tests' mean results (by test id). */
  value(results: ReadonlyMap<string, number>): number;
  readonly min: number;
  readonly max: number;
}

const base = (id: string, name: string, description: string): Scenario => ({
  id: `test-${id}`,
  name,
  description,
  budget: 0,
  maxPlayerShips: 0,
  arena: { width: 8000, height: 4000, asteroids: [], gravityWells: [] },
  playerSpawns: [],
  enemies: [],
  objective: { type: "survive", seconds: 30 },
  seed: 1,
  order: 900,
});

/**
 * Point defense against a salvo: launcher platforms 2.5 km from a gatling platform fire together (they
 * reload in 10 s, so a run ends before the second salvo).
 */
function salvo(
  id: string,
  name: string,
  gatling: string,
  launchers: number,
  description: string,
): TuningTest {
  const s = base(id, name, description);
  s.enemies.push({
    designId: gatling,
    aiProfile: "none",
    team: 0,
    spawn: { position: [-1250, 0], angle: 0 },
  });
  for (let i = 0; i < launchers; i++)
    s.enemies.push({
      designId: "platform-launcher",
      aiProfile: "none",
      team: 1,
      spawn: { position: [1250, (i - (launchers - 1) / 2) * 50], angle: 180 },
    });
  return { scenario: s, seconds: 9.5, measure: "stopped", note: "share of runs with every missile stopped" };
}

/** A weapon platform against the target block at a range: damage dealt in 20 s (the runner makes the target unbreakable). */
function duel(id: string, name: string, platform: string, range: number): TuningTest {
  const s = base(id, name, `${name}: damage dealt in 20 s to an unarmed target block ${range} m away.`);
  s.enemies.push(
    { designId: platform, aiProfile: "none", team: 0, spawn: { position: [-range / 2, 0], angle: 0 } },
    {
      designId: "platform-target",
      aiProfile: "none",
      team: 1,
      spawn: { position: [range / 2, 0], angle: 180 },
    },
  );
  return { scenario: s, seconds: 20, measure: "damage", note: "hull damage dealt" };
}

export const TUNING_TESTS: readonly TuningTest[] = [
  salvo(
    "pd-1v1",
    "Test: 1 gatling vs 1 missile",
    "platform-gatling",
    1,
    "One gatling should stop one smart missile.",
  ),
  salvo(
    "pd-1v2",
    "Test: 1 gatling vs 2 missiles",
    "platform-gatling",
    2,
    "Of two missiles, the second should have a chance to pass.",
  ),
  salvo(
    "pd-2v2",
    "Test: 2 gatlings vs 2 missiles",
    "platform-gatling-2",
    2,
    "Two gatlings should stop two missiles.",
  ),
  salvo(
    "pd-2v3",
    "Test: 2 gatlings vs 3 missiles",
    "platform-gatling-2",
    3,
    "Of three missiles, the third should have a chance to pass.",
  ),
  ...[400, 800, 1100].flatMap((r) => [
    duel(`autocannon-${r}`, `Test: autocannon at ${r} m`, "platform-autocannon", r),
    duel(`laser-${r}`, `Test: laser at ${r} m`, "platform-laser", r),
  ]),
];

const mean = (r: ReadonlyMap<string, number>, id: string) => r.get(`test-${id}`) ?? 0;
const sum = (r: ReadonlyMap<string, number>, p: string) =>
  [400, 800, 1100].reduce((s, x) => s + mean(r, `${p}-${x}`), 0);

export const TUNING_RULES: readonly TuningRule[] = [
  { id: "pd-1v1", text: "1 gatling stops 1 missile", value: (r) => mean(r, "pd-1v1"), min: 0.9, max: 1 },
  {
    id: "pd-1v2",
    text: "of 2 missiles vs 1 gatling, one passes",
    value: (r) => 1 - mean(r, "pd-1v2"),
    min: 0.1,
    max: 0.8,
  },
  { id: "pd-2v2", text: "2 gatlings stop 2 missiles", value: (r) => mean(r, "pd-2v2"), min: 0.9, max: 1 },
  {
    id: "pd-2v3",
    text: "of 3 missiles vs 2 gatlings, one passes",
    value: (r) => 1 - mean(r, "pd-2v3"),
    min: 0.1,
    max: 0.8,
  },
  {
    id: "laser-vs-autocannon",
    text: "laser damage ÷ autocannon damage",
    value: (r) => {
      const ac = sum(r, "autocannon");
      return ac > 0 ? sum(r, "laser") / ac : 10;
    },
    min: 0.8,
    max: 0.95,
  },
];

/** One run of a test: its measured value. */
export function runTest(t: TuningTest, seed: number, cat: PartCatalogue, balance: Balance = BALANCE): number {
  setRuntimeBalance(balance);
  try {
    // Small spawn jitter so runs differ (the world seed alone changes little for stationary platforms).
    const sc = jitterSpawns({ ...t.scenario, seed }, seed, { position: 15, angle: 3 });
    const b = startBattle(sc, [], cat, { designs: BUNDLED_DESIGNS, profiles: AI_PROFILES, seed });
    // Damage tests: the target cannot break, so every hit counts the same all the way through.
    const HP = 1e9;
    if (t.measure === "damage") for (const e of b.enemyShips) for (const p of e.parts) p.hp = HP;
    const ticks = Math.round(t.seconds * 60);
    for (let i = 0; i < ticks; i++) {
      b.world.step();
      updateBattle(b);
    }
    const w = b.world;
    if (t.measure === "stopped")
      return w.combat.stats.missileHits === 0 && w.combat.stats.missilesLaunched > 0 ? 1 : 0;
    return b.enemyShips.reduce((s, e) => s + e.parts.reduce((u, p) => u + (HP - p.hp), 0), 0);
  } finally {
    setRuntimeBalance(BALANCE);
  }
}

export interface RuleResult {
  readonly rule: TuningRule;
  readonly value: number;
  readonly ok: boolean;
  /** Distance outside the range, relative to the range's width (0 inside). */
  readonly miss: number;
}

/** Runs every test `runs` times (seeds 1…runs) and checks the rules. Salvo tests need about 80 runs to resolve 10 % steps. */
export function runTuningTests(
  cat: PartCatalogue,
  balance: Balance = BALANCE,
  runs = 40,
): { results: Map<string, number>; rules: RuleResult[] } {
  const results = new Map<string, number>();
  for (const t of TUNING_TESTS) {
    const n = runsOf(t, runs);
    let s = 0;
    for (let seed = 1; seed <= n; seed++) s += runTest(t, seed, cat, balance);
    results.set(t.scenario.id, s / n);
  }
  return { results, rules: checkRules(results) };
}

/** Runs per test: salvo tests `runs`, duels (which barely vary) at most 3. */
export const runsOf = (t: TuningTest, runs: number): number =>
  t.measure === "damage" ? Math.min(runs, 3) : runs;

/** The rules over the tests' mean results (by scenario id). */
export function checkRules(results: ReadonlyMap<string, number>): RuleResult[] {
  return TUNING_RULES.map((rule) => {
    const value = rule.value(results);
    const width = Math.max(1e-9, rule.max - rule.min);
    const miss =
      value < rule.min ? (rule.min - value) / width : value > rule.max ? (value - rule.max) / width : 0;
    return { rule, value, ok: miss === 0, miss };
  });
}

/** Loss term for the GA: the squared misses of every rule. */
export const rulesLoss = (rules: readonly RuleResult[]): number =>
  rules.reduce((s, r) => s + r.miss * r.miss, 0);
