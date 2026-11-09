import { describe, expect, it } from "vitest";
import catalogueJson from "../../src/data/core/catalogue.json";
import { validateCatalogue } from "../../src/data/validate";
import { PartCatalogue } from "../../src/sim/ship/catalogue";
import { BUNDLED_DESIGNS, CORE_DRONES } from "../../src/data/designs/index";
import { AI_PROFILES } from "../../src/data/ai/index";
import { STANCES, stanceProfile, stanceValues } from "../../src/data/ai/stances";
import { SCENARIOS } from "../../src/data/scenarios/index";
import { World } from "../../src/sim/world";
import { length, sub, vec2 } from "../../src/sim/core/vec2";
import {
  applySkirmishOrders,
  checkSkirmish,
  DEFAULT_SKIRMISH,
  skirmishBattle,
} from "../../src/sim/scenario/skirmish";
import { runBattle, startBattle } from "../../src/sim/scenario/battle";
import type { Ship } from "../../src/sim/ship/ship-entity";

const r = validateCatalogue(catalogueJson);
if (!r.ok) throw new Error(r.errors.join("\n"));
const cat = PartCatalogue.fromJson(r.value);
const D = (id: string) => BUNDLED_DESIGNS.get(id)!;
const world = (seed = 1) => {
  const w = new World({ seed, enforceDefeat: true });
  for (const d of CORE_DRONES) w.registerDesign(d);
  return w;
};
const dist = (w: World, a: Ship, b: Ship) =>
  length(sub(w.physics.getWorldCenter(a.id), w.physics.getWorldCenter(b.id)));
const unkillable = (s: Ship) => {
  for (const p of s.parts) p.hp = 1e9;
  return s;
};
const open = { width: 14000, height: 10000, asteroids: [], gravityWells: [] };

describe("AI types", () => {
  it("each type has 3–5 parameters with defaults inside their ranges; the registered profiles match them", () => {
    expect(STANCES.map((s) => s.id)).toEqual(["aggressive", "defensive", "retreating", "cautious"]);
    for (const s of STANCES) {
      expect(s.params.length).toBeGreaterThanOrEqual(3);
      expect(s.params.length).toBeLessThanOrEqual(5);
      const v = stanceValues(s.id);
      for (const p of s.params) {
        expect(v[p.key], `${s.id}.${p.key}`).toBeGreaterThanOrEqual(p.min);
        expect(v[p.key], `${s.id}.${p.key}`).toBeLessThanOrEqual(p.max);
      }
      const built = stanceProfile(s.id);
      const reg = AI_PROFILES.get(s.id)!;
      expect(reg.stance).toBe(s.id);
      for (const key of [
        "rangeFactor",
        "maxSpeed",
        "retreatHp",
        "minHitProbability",
        "withdrawSpeed",
      ] as const)
        expect(reg[key], `${s.id}.${key}`).toBe(built[key]);
    }
    // Overrides are clamped.
    expect(stanceValues("aggressive", { maxSpeed: 1e6 }).maxSpeed).toBe(250);
  });

  /** Average distance kept from an unarmed, unkillable target between 30 and 90 s. */
  const keeps = (type: "aggressive" | "cautious") => {
    const w = world();
    const a = w.addShip(D("fleet-rapier"), cat);
    const t = unkillable(
      w.addShip(D("demo-hauler"), cat, { position: vec2(4000, 0), angle: Math.PI, team: 1 }),
    );
    w.setAi(a.id, stanceProfile(type));
    w.run(60 * 30);
    let sum = 0;
    for (let i = 0; i < 60 * 60; i++) {
      w.step();
      sum += dist(w, a, t);
    }
    return sum / (60 * 60);
  };

  it("cautious keeps clearly further away than aggressive", () => {
    expect(keeps("cautious")).toBeGreaterThan(keeps("aggressive") * 1.4);
  }, 60_000);

  it("retreating falls back from an armed enemy at its withdraw speed and keeps firing", () => {
    const w = world();
    const a = w.addShip(D("fleet-rapier"), cat);
    const e = unkillable(
      w.addShip(D("fleet-rapier"), cat, { position: vec2(1500, 0), angle: Math.PI, team: 1 }),
    );
    w.setAi(a.id, stanceProfile("retreating", { withdrawSpeed: 30 }));
    w.run(60 * 5);
    const d0 = dist(w, a, e);
    w.run(60 * 20);
    expect(w.ai.get(a.id)!.behaviour).toBe("retreat");
    expect(dist(w, a, e)).toBeGreaterThan(d0 + 200);
    expect(Object.values(w.combat.damage[a.id] ?? {}).reduce((x, y) => x + y, 0)).toBeGreaterThan(0);
  }, 60_000);

  it("defensive stays with the ship it guards and ignores enemies outside the guard radius", () => {
    const w = world();
    const a = w.addShip(D("fleet-wasp"), cat);
    const charge = w.addShip(D("demo-hauler"), cat, { position: vec2(-200, 200) });
    const e = w.addShip(D("fleet-rapier"), cat, { position: vec2(5000, 0), angle: Math.PI, team: 1 });
    w.setAi(a.id, stanceProfile("defensive"), { kind: "guard", target: charge.id, radius: 1500 });
    let maxOff = 0;
    for (let i = 0; i < 60 * 40; i++) {
      w.step();
      maxOff = Math.max(maxOff, dist(w, a, charge));
    }
    expect(w.ai.get(a.id)!.targetId).toBeNull();
    expect(maxOff).toBeLessThan(400);
    void e;
  }, 60_000);
});

describe("skirmish", () => {
  it("the default setup is valid; bad setups are explained", () => {
    expect(checkSkirmish(DEFAULT_SKIRMISH, BUNDLED_DESIGNS)).toEqual([]);
    expect(checkSkirmish({ sides: [[], []], distance: 5000 }, BUNDLED_DESIGNS)).toHaveLength(2);
    const errs = checkSkirmish(
      {
        sides: [
          [{ designId: "fleet-wasp", pilot: "defensive" }],
          [{ designId: "fleet-wasp", pilot: "player" }],
        ],
        distance: 5000,
      },
      BUNDLED_DESIGNS,
    );
    expect(errs.join(" ")).toMatch(/guard/);
    expect(errs.join(" ")).toMatch(/player/);
  });

  it("builds a mirrored battle: player ships first, AI ships with their types, guards resolved", () => {
    const sk = skirmishBattle(DEFAULT_SKIRMISH, BUNDLED_DESIGNS, open);
    expect(sk.fleet.map((d) => d.id)).toEqual(["fleet-rapier"]);
    expect(sk.scenario.enemies.map((e) => e.team)).toEqual([0, 1, 1]);
    const b = startBattle(sk.scenario, sk.fleet, cat, {
      designs: BUNDLED_DESIGNS,
      profiles: sk.profiles,
      droneDesigns: CORE_DRONES,
    });
    applySkirmishOrders(b, sk, DEFAULT_SKIRMISH);
    // The Wasp guards the player's Rapier.
    const wasp = b.world.ai.get(b.allyShips[0]!.id)!;
    expect(wasp.order).toMatchObject({ kind: "guard", target: b.playerShips[0]!.id });
    expect(b.world.ai.get(b.enemyShips[0]!.id)!.profile.stance).toBe("aggressive");
    expect(b.world.ai.get(b.enemyShips[1]!.id)!.profile.stance).toBe("cautious");
  });

  it("a watched skirmish (no player ship) runs until one side is down, not over at once", () => {
    const setup = {
      sides: [
        [{ designId: "fleet-wasp", pilot: "aggressive" as const }],
        [{ designId: "fleet-wasp", pilot: "aggressive" as const }],
      ] as const,
      distance: 3000,
    };
    const sk = skirmishBattle(setup, BUNDLED_DESIGNS, open);
    const b = startBattle(sk.scenario, sk.fleet, cat, {
      designs: BUNDLED_DESIGNS,
      profiles: sk.profiles,
      droneDesigns: CORE_DRONES,
    });
    applySkirmishOrders(b, sk, setup);
    expect(runBattle(b, 1)).toBe("running");
  });
});

describe("mirror scenarios", () => {
  it("s11–s15: the same fleet on both sides, mirrored spawns and asteroids, within budget", () => {
    const mirrors = SCENARIOS.filter((s) => s.id.includes("mirror"));
    expect(mirrors).toHaveLength(5);
    for (const s of mirrors) {
      expect(
        s.enemies.map((e) => e.designId),
        s.id,
      ).toEqual(s.referenceDesigns);
      s.enemies.forEach((e, i) => {
        const p = s.playerSpawns[i]!;
        expect(e.spawn.position[0], s.id).toBeCloseTo(-p.position[0], 6);
        expect(e.spawn.position[1], s.id).toBeCloseTo(p.position[1], 6);
      });
      const key = (x: number, y: number) => `${x.toFixed(0)}|${y.toFixed(0)}`;
      const rocks = new Set(s.arena.asteroids.map((a) => key(a.position[0], a.position[1])));
      for (const a of s.arena.asteroids)
        expect(rocks.has(key(-a.position[0], a.position[1])), s.id).toBe(true);
    }
  });
});
