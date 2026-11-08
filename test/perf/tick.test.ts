import { describe, expect, it } from "vitest";
import { performance } from "node:perf_hooks";
import catalogueJson from "../../src/data/core/catalogue.json";
import { validateCatalogue } from "../../src/data/validate";
import { makeCruiserDesign } from "../../src/data/designs/generate";
import { PartCatalogue } from "../../src/sim/ship/catalogue";
import type { ShipDesign } from "../../src/data/schemas/design";
import { World } from "../../src/sim/world";
import { vec2 } from "../../src/sim/core/vec2";

const r = validateCatalogue(catalogueJson);
if (!r.ok) throw new Error(r.errors.join("\n"));
const cat = PartCatalogue.fromJson(r.value);

/** First N parts of the generated cruiser plus its engines: a realistic ~50-part ship. */
function shipWithParts(n: number): ShipDesign {
  const c = makeCruiserDesign();
  const engines = c.parts.filter(
    (p) => p.partId.startsWith("core:engine") || p.partId.startsWith("core:command"),
  );
  const rest = c.parts.filter((p) => !engines.includes(p)).slice(0, n - engines.length);
  return { ...c, id: `perf-${n}`, parts: [...engines, ...rest] };
}

function msPerTick(design: ShipDesign, ticks: number): number {
  const w = new World({ seed: 1 });
  const ship = w.addShip(design, cat);
  w.setIntent(ship.id, { thrust: vec2(1, 0.3), rotate: 0.2 });
  w.run(200); // warm-up (JIT)
  const t0 = performance.now();
  w.run(ticks);
  return (performance.now() - t0) / ticks;
}

describe("M1 performance", () => {
  it("one tick of a single 50-part ship takes < 0.5 ms", () => {
    const d = shipWithParts(50);
    expect(d.parts).toHaveLength(50);
    const ms = msPerTick(d, 2000);
    console.log(`50-part ship: ${ms.toFixed(3)} ms/tick`);
    expect(ms).toBeLessThan(0.5);
  });

  it("150-part cruiser stays well inside the 16 ms frame", () => {
    const ms = msPerTick(makeCruiserDesign(), 1000);
    console.log(`150-part cruiser: ${ms.toFixed(3)} ms/tick`);
    expect(ms).toBeLessThan(2);
  });
});

describe("M5 performance", () => {
  it("5.20 40 missiles + 30 drones + 500 projectiles + 10 ships → tick under 8 ms", async () => {
    const { spawnMissile } = await import("../../src/sim/combat/missiles");
    const droneJson = (await import("../../src/data/designs/drone-attack.json")).default;
    const { validateDesign } = await import("../../src/data/validate");
    const dr = validateDesign(droneJson);
    if (!dr.ok) throw new Error(dr.errors.join("\n"));
    const w = new World({ seed: 1 });
    w.registerDesign(dr.value);
    const ships = Array.from({ length: 10 }, (_, i) =>
      w.addShip(shipWithParts(50), cat, {
        position: vec2((i % 5) * 400, Math.floor(i / 5) * 1200),
        angle: i < 5 ? Math.PI / 2 : -Math.PI / 2,
        team: i < 5 ? 0 : 1,
      }),
    );
    for (let i = 0; i < 30; i++) {
      const mother = ships[i % 10]!;
      const d = w.addShip(dr.value, cat, {
        position: vec2((i % 10) * 200 - 100, 300 + Math.floor(i / 10) * 200),
        team: mother.team,
      });
      d.drone = { mother: mother.id, hangarUid: "x", role: "attack", launchTick: 0 };
    }
    const mdef = cat.get("core:weapon.missile.launcher.s").def.weapon!.missile!;
    const rng = w.rng.fork();
    const topUp = () => {
      while (w.combat.missiles.length < 40) {
        const from = ships[w.combat.missiles.length % 5]!;
        const to = ships[5 + (w.combat.missiles.length % 5)]!;
        spawnMissile(w, from, mdef, vec2(rng.range(0, 1600), 500), vec2(0, 1), vec2(0, 0), to.id);
      }
      while (w.combat.projectiles.length < 500) {
        w.combat.projectiles.push({
          id: w.combat.nextProjectileId++,
          owner: ships[0]!.id,
          team: 0,
          pos: vec2(rng.range(-200, 1800), rng.range(-200, 1400)),
          vel: vec2(rng.range(-1000, 1000), rng.range(-1000, 1000)),
          mass: 0.5,
          damage: 5,
          age: 0,
          lifetime: 2,
          kind: "perf",
        });
      }
    };
    for (let i = 0; i < 30; i++) {
      topUp();
      w.step(); // warm-up (JIT)
    }
    let total = 0;
    const ticks = 60;
    for (let i = 0; i < ticks; i++) {
      topUp();
      const t0 = performance.now();
      w.step();
      total += performance.now() - t0;
    }
    const ms = total / ticks;
    console.log(`M5 load (10 ships, 30 drones, 40 missiles, 500 rounds): ${ms.toFixed(2)} ms/tick`);
    expect(ms).toBeLessThan(8);
  });
});
