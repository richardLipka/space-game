import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { Scenario } from "../../src/data/schemas/scenario";
import type { ShipDesign } from "../../src/data/schemas/design";
import { validateCatalogue } from "../../src/data/validate";
import { SCENARIOS } from "../../src/data/scenarios/index";
import { BUNDLED_DESIGNS, CORE_DRONES } from "../../src/data/designs/index";
import { AI_PROFILES, aiProfile } from "../../src/data/ai/index";
import { PartCatalogue } from "../../src/sim/ship/catalogue";
import { checkFleet, runBattle, startBattle, updateBattle } from "../../src/sim/scenario/battle";
import { validateDesignLayout } from "../../src/editor/validate";

const catR = validateCatalogue(
  JSON.parse(readFileSync(new URL("../../src/data/core/catalogue.json", import.meta.url), "utf8")),
);
if (!catR.ok) throw new Error(catR.errors.join("\n"));
const cat = PartCatalogue.fromJson(catR.value);
const opts = (seed: number) => ({
  seed,
  designs: BUNDLED_DESIGNS,
  profiles: AI_PROFILES,
  droneDesigns: CORE_DRONES,
});
const design = (id: string): ShipDesign => BUNDLED_DESIGNS.get(id)!;
const base = SCENARIOS[0]!;

describe("M7 scenarios", () => {
  it("ships 6–10 scenarios in teaching order, each with hints and reference designs that fit its budget", () => {
    expect(SCENARIOS.length).toBeGreaterThanOrEqual(6);
    expect(SCENARIOS.length).toBeLessThanOrEqual(10);
    const orders = SCENARIOS.map((s) => s.order);
    expect(orders).toEqual([...orders].sort((a, b) => a! - b!));
    for (const s of SCENARIOS) {
      expect(s.hints?.length, s.id).toBeGreaterThan(0);
      const fleet = (s.referenceDesigns ?? []).map(design);
      expect(fleet.length, s.id).toBeGreaterThan(0);
      expect(checkFleet(s, fleet, cat).errors, s.id).toEqual([]);
      for (const e of s.enemies) expect(BUNDLED_DESIGNS.has(e.designId), `${s.id}: ${e.designId}`).toBe(true);
    }
    for (const d of BUNDLED_DESIGNS.values()) expect(validateDesignLayout(d, cat).errors, d.id).toBe(0);
  });

  it("7.1 every scenario loads, validates and runs headless for 60 s without errors", () => {
    for (const s of SCENARIOS) {
      const b = startBattle(s, (s.referenceDesigns ?? []).map(design), cat, opts(1));
      for (const p of b.playerShips) b.world.setAi(p.id, aiProfile("balanced"));
      expect(() => runBattle(b, 60), s.id).not.toThrow();
      expect(Number.isFinite(b.world.time)).toBe(true);
    }
  });

  it(
    "7.2 every scenario can be won: its reference fleet flown by the AI wins at least one of 20 seeds",
    { timeout: 300_000 },
    () => {
      for (const s of SCENARIOS) {
        let won = false;
        for (let seed = 1; seed <= 20 && !won; seed++) {
          const b = startBattle(s, (s.referenceDesigns ?? []).map(design), cat, opts(seed));
          // Every ship of the reference fleet fights on its own, like the enemy ships do.
          for (const p of b.playerShips) b.world.setAi(p.id, aiProfile("balanced"));
          won = runBattle(b, 180) === "won";
        }
        expect(won, s.id).toBe(true);
      }
    },
  );

  it("7.3 objectives: destroyAll, survive and protect produce the right win and loss events", () => {
    const sc = (objective: Scenario["objective"], enemies: Scenario["enemies"]): Scenario => ({
      ...base,
      id: "t",
      objective,
      enemies,
      arena: { ...base.arena, asteroids: [] },
    });
    const enemy = (designId: string, team = 1, x = 1500): Scenario["enemies"][number] => ({
      designId,
      aiProfile: "balanced",
      spawn: { position: [x, 0], angle: 180 },
      team,
    });
    const gunboat = [design("demo-gunboat")];

    // destroyAll: win when the last enemy falls, not before.
    const d = startBattle(
      sc({ type: "destroyAll" }, [enemy("demo-hauler"), enemy("demo-hauler", 1, 2000)]),
      gunboat,
      cat,
      opts(1),
    );
    d.world.step();
    expect(updateBattle(d)).toBe("running");
    d.enemyShips[0]!.destroyPart("cmd");
    d.world.step();
    expect(updateBattle(d)).toBe("running");
    d.enemyShips[1]!.destroyPart("cmd");
    d.world.step();
    expect(updateBattle(d)).toBe("won");
    expect(d.reason).toMatch(/defeated/);

    // Losing every player ship loses, whatever the objective.
    const l = startBattle(sc({ type: "destroyAll" }, [enemy("demo-hauler")]), gunboat, cat, opts(1));
    l.playerShips[0]!.destroyPart("cmd");
    l.world.step();
    expect(updateBattle(l)).toBe("lost");

    // survive: win at the time limit.
    const s = startBattle(
      sc({ type: "survive", seconds: 2 }, [enemy("demo-hauler", 1, 3000)]),
      gunboat,
      cat,
      opts(1),
    );
    expect(runBattle(s, 1.9)).toBe("running");
    expect(runBattle(s, 0.2)).toBe("won");
    expect(s.endTime).toBeCloseTo(2, 1);

    // protect: lose when the escorted ship falls; win when the enemies fall first.
    const prot = sc({ type: "protect", designId: "demo-hauler" }, [
      enemy("demo-hauler", 0, -800),
      enemy("demo-picket"),
    ]);
    const p1 = startBattle(prot, gunboat, cat, opts(1));
    expect(p1.protectId).not.toBeNull();
    p1.world.getShip(p1.protectId!).destroyPart("cmd");
    p1.world.step();
    expect(updateBattle(p1)).toBe("lost");
    const p2 = startBattle(prot, gunboat, cat, opts(1));
    p2.enemyShips[0]!.destroyPart("cmd");
    p2.world.step();
    expect(updateBattle(p2)).toBe("won");
    // The status sticks once decided.
    p2.world.getShip(p2.protectId!).destroyPart("cmd");
    p2.world.step();
    expect(updateBattle(p2)).toBe("won");
  });

  it("7.4 budget: a fleet over budget cannot start; at exactly the budget it can", () => {
    const fleet = [design("demo-gunboat")];
    const cost = checkFleet(base, fleet, cat).cost;
    expect(checkFleet({ ...base, budget: cost }, fleet, cat).ok).toBe(true);
    const over = checkFleet({ ...base, budget: cost - 1 }, fleet, cat);
    expect(over.ok).toBe(false);
    expect(over.errors.join()).toMatch(/Over budget/);
    expect(
      checkFleet({ ...base, budget: 1e6, maxPlayerShips: 1 }, [...fleet, ...fleet], cat).errors.join(),
    ).toMatch(/Too many ships/);
    expect(checkFleet(base, [], cat).ok).toBe(false);
    expect(
      checkFleet({ ...base, budget: 1e6, allowedParts: ["core:command.s"] }, fleet, cat).errors.join(),
    ).toMatch(/not allowed/);
  });

  it("7.5 drifting asteroids are deterministic: same scenario and seed → same hash", () => {
    const s = SCENARIOS.find((x) => x.arena.asteroids.some((a) => a.velocity))!;
    expect(s).toBeDefined();
    const run = () => {
      const b = startBattle(s, (s.referenceDesigns ?? []).map(design), cat, opts(3));
      b.world.run(600);
      return b.world.hash();
    };
    expect(run()).toBe(run());
  });
});
