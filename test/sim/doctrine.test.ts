import { describe, expect, it } from "vitest";
import catalogueJson from "../../src/data/core/catalogue.json";
import { validateCatalogue } from "../../src/data/validate";
import { PartCatalogue } from "../../src/sim/ship/catalogue";
import { BUNDLED_DESIGNS, CORE_DRONES } from "../../src/data/designs/index";
import { AI_PROFILES, aiProfile } from "../../src/data/ai/index";
import { applySkirmishOrders, skirmishBattle, type SkirmishSetup } from "../../src/sim/scenario/skirmish";
import { startBattle, updateBattle } from "../../src/sim/scenario/battle";
import { length, sub } from "../../src/sim/core/vec2";
import { salvoDue } from "../../src/sim/ai/doctrine";
import { duelJobs, mutate, rng, setParam, summarize } from "../../src/headless/ai-duel";
import type { JobResult } from "../../src/headless/jobs";
import type { BattleMetrics } from "../../src/headless/observe";

const r = validateCatalogue(catalogueJson);
if (!r.ok) throw new Error(r.errors.join("\n"));
const cat = PartCatalogue.fromJson(r.value);

function battle(a: string, b: string, fleet: string[], distance: number) {
  const side = (p: string) =>
    fleet.map((designId) => ({ designId, pilot: "aggressive" as const, profile: aiProfile(p) }));
  const setup: SkirmishSetup = { sides: [side(a), side(b)], distance };
  const sk = skirmishBattle(setup, BUNDLED_DESIGNS, {
    width: 20000,
    height: 14000,
    asteroids: [],
    gravityWells: [],
  });
  const bt = startBattle({ ...sk.scenario, seed: 1 }, sk.fleet, cat, {
    seed: 1,
    designs: BUNDLED_DESIGNS,
    profiles: sk.profiles,
    droneDesigns: CORE_DRONES,
  });
  applySkirmishOrders(bt, sk, setup);
  return bt;
}

describe("fleet doctrines", () => {
  it("doctrine profiles are part of the AI profile set and reach the ships through the skirmish setup", () => {
    expect(AI_PROFILES.get("fleet-pass")?.doctrine).toBe("pass");
    expect(AI_PROFILES.get("missile-wall")?.doctrine).toBe("missile-line");
    const b = battle("fleet-pass", "missile-wall", ["fleet-wasp"], 6000);
    expect(b.world.ai.get(b.allyShips[0]!.id)?.profile.doctrine).toBe("pass");
    expect(b.world.ai.get(b.enemyShips[0]!.id)?.profile.doctrine).toBe("missile-line");
  });

  it("pass: the formation closes at speed, goes through the enemy, and comes about for another pass", () => {
    const b = battle("fleet-pass", "fleet-pass", ["fleet-rapier", "fleet-wasp"], 6000);
    const w = b.world;
    const leader = b.allyShips[0]!;
    const st = w.ai.get(leader.id)!;
    const phases: string[] = [];
    let topSpeed = 0;
    for (let i = 0; i < 60 * 150 && b.status === "running"; i++) {
      w.step();
      updateBattle(b);
      if (phases.at(-1) !== st.passPhase) phases.push(st.passPhase);
      topSpeed = Math.max(topSpeed, length(w.physics.getBodyState(leader.id).linearVelocity));
    }
    expect(topSpeed).toBeGreaterThan(200);
    // in → out (through the enemy) → in again (came about).
    expect(phases.slice(0, 3)).toEqual(["in", "out", "in"]);
  });

  it("pass: followers keep formation abreast of the leader", () => {
    const b = battle("fleet-pass", "balanced", ["fleet-wasp", "fleet-wasp", "fleet-wasp"], 8000);
    const w = b.world;
    for (let i = 0; i < 60 * 25; i++) {
      w.step();
      updateBattle(b);
    }
    const [l, f1, f2] = b.allyShips.map((s) => w.physics.getWorldCenter(s.id));
    // Spread across the formation (not bunched), but close together (not scattered).
    for (const f of [f1!, f2!]) {
      const d = length(sub(f, l!));
      expect(d).toBeGreaterThan(60);
      expect(d).toBeLessThan(800);
    }
  });

  it("missile line: the side's ships share one salvo clock", () => {
    const b = battle("missile-wall", "balanced", ["fleet-viper", "fleet-viper"], 9000);
    const w = b.world;
    const [s1, s2] = b.allyShips.map((s) => w.ai.get(s.id)!);
    const every = s1!.profile.salvoInterval! * 60;
    w.tick = every * 3 + 5;
    s1!.lastVolleyTick = every * 2 + 10;
    s2!.lastVolleyTick = every * 2 + 40;
    expect(salvoDue(w, s1!)).toBe(true);
    expect(salvoDue(w, s2!)).toBe(true);
    s1!.lastVolleyTick = w.tick;
    expect(salvoDue(w, s1!)).toBe(false);
  });
});

describe("AI duel harness", () => {
  const a = aiProfile("fleet-pass");
  const bp = aiProfile("balanced");

  it("fights each seed twice, A on each side, with the given profiles", () => {
    const jobs = duelJobs({
      fleet: ["fleet-wasp", "fleet-spark"],
      a,
      b: bp,
      seeds: 3,
      distance: 5000,
      timeLimit: 300,
    });
    expect(jobs).toHaveLength(6);
    const j = jobs[1]!;
    if (j.kind !== "skirmish") throw new Error("skirmish");
    expect(j.label).toBe("duel|A1|1");
    expect(j.setup.sides[1][0]!.profile?.id).toBe("fleet-pass");
    expect(j.setup.sides[0][0]!.profile?.id).toBe("balanced");
  });

  it("counts wins for A whichever side it flew on", () => {
    const res = (label: string, winner: BattleMetrics["winner"]): JobResult => ({
      kind: "skirmish",
      job: {} as never,
      result: {
        label,
        seed: 1,
        metrics: {
          time: 100,
          engagement: 80,
          winner,
          reason: "incapacitated",
          ammoLeftA: 1,
          ammoLeftB: 1,
          missiles: { launched: 0, down: 0, hits: 0 },
          ships: [],
        },
      },
    });
    const s = summarize(
      [res("duel|A0|1", "a"), res("duel|A1|1", "b"), res("duel|A1|2", "a"), res("duel|A0|2", "draw")],
      1,
    );
    expect([s.winsA, s.winsB, s.draws]).toEqual([2, 1, 1]);
    expect(s.score).toBeCloseTo(0.625, 6);
  });

  it("tuning steps stay inside each parameter's range and are reproducible", () => {
    expect(setParam(a, "passSpeed", 10_000).passSpeed).toBe(500);
    const m1 = mutate(a, ["passSpeed", "weights.evade"], rng(7));
    const m2 = mutate(a, ["passSpeed", "weights.evade"], rng(7));
    expect(m1).toEqual(m2);
    expect(m1.passSpeed!).toBeGreaterThanOrEqual(80);
  });
});
