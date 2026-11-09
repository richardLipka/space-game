import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { ShipDesign } from "../../src/data/schemas/design";
import { validateCatalogue } from "../../src/data/validate";
import { PartCatalogue } from "../../src/sim/ship/catalogue";
import { World } from "../../src/sim/world";
import { vec2 } from "../../src/sim/core/vec2";
import { SIM_DT } from "../../src/sim/core/loop";
import { stepProjectiles } from "../../src/sim/combat/combat-world";
import { COMBAT, EXPLOSION, storeBlast } from "../../src/sim/combat/constants";

const catR = validateCatalogue(
  JSON.parse(readFileSync(new URL("../../src/data/core/catalogue.json", import.meta.url), "utf8")),
);
if (!catR.ok) throw new Error(catR.errors.join("\n"));
const cat = PartCatalogue.fromJson(catR.value);
const NOW = "2026-11-09T00:00:00Z";
const D = (parts: [string, string, number, number][]): ShipDesign => ({
  formatVersion: 1,
  id: "w",
  name: "w",
  createdAt: NOW,
  modifiedAt: NOW,
  weaponGroupModes: {},
  powerPriority: ["gyro", "propulsion", "weapons", "pointDefense", "hangar"],
  parts: parts.map(([uid, p, x, y]) => ({ uid, partId: `core:${p}`, x, y, angle: 0 })),
});
/** Command module with a chain to the right: a (plate) → b (plate). */
const row = D([
  ["cmd", "command.s", 0, 0],
  ["a", "hull.square.s", 1.25, 0],
  ["b", "hull.square.s", 2.25, 0],
]);
const round = (x: number, damage: number) => ({
  id: 1,
  owner: "x",
  team: 9,
  pos: vec2(x, 0),
  vel: vec2(-2000, 0),
  mass: 0.1,
  damage,
  age: 0,
  lifetime: 2,
  kind: "t",
});

describe("wreck shadow life", () => {
  it("a wreck starts with its full HP as shadow life; rounds through it wear it by the share it absorbs", () => {
    const w = new World({ seed: 1 });
    const s = w.addShip(row, cat);
    s.destroyPart("b");
    expect(s.part("b").wreckHp).toBe(60);
    w.combat.projectiles = [round(20, 40)];
    for (let i = 0; i < 10; i++) stepProjectiles(w, SIM_DT);
    expect(s.part("b").wreckHp).toBeCloseTo(60 - 40 * COMBAT.wreckAbsorb, 6); // b absorbed half
    expect(60 - s.part("a").hp).toBeCloseTo(40 * (1 - COMBAT.wreckAbsorb), 6); // a took the rest
  });

  it("when the shadow life runs out the wreck breaks off and is gone; what hung on it drifts off as debris", () => {
    const w = new World({ seed: 1 });
    const s = w.addShip(row, cat);
    s.destroyPart("a");
    s.damageWreck("a", 59);
    w.step();
    expect(s.parts.map((p) => p.uid)).toEqual(["cmd", "a", "b"]);
    s.damageWreck("a", 1);
    w.step();
    expect(s.parts.map((p) => p.uid)).toEqual(["cmd"]);
    expect(w.debris).toHaveLength(1);
    expect(w.debris[0]!.pieces.map((p) => p.uid)).toEqual(["b"]); // the wreck itself vanished
    expect(w.combat.events.some((e) => e.kind === "explosion" && e.size === EXPLOSION.wreckBreak)).toBe(true);
  });

  it("an outer wreck simply disappears; the command module's wreck never breaks off", () => {
    const w = new World({ seed: 1 });
    const s = w.addShip(row, cat);
    s.destroyPart("b");
    s.damageWreck("b", 1e6);
    s.destroyPart("cmd");
    s.damageWreck("cmd", 1e6);
    w.step();
    expect(s.parts.map((p) => p.uid)).toEqual(["cmd", "a"]);
    expect(w.debris).toHaveLength(0);
  });

  it("blasts and collisions wear wrecks down too", () => {
    const w = new World({ seed: 1 });
    const s = w.addShip(row, cat);
    s.destroyPart("b");
    s.applyBlast(vec2(2.25, 0), 5, 30);
    expect(s.part("b").wreckHp).toBeCloseTo(30, 6);
    s.applyDamage("b", 10);
    expect(s.part("b").wreckHp).toBeCloseTo(20, 6);
  });
});

describe("store explosions", () => {
  it("fuel tanks and magazines blow up in proportion to what they hold", () => {
    const full = storeBlast("fuelTank", 500)!;
    const half = storeBlast("fuelTank", 250)!;
    expect(half.damage / full.damage).toBeCloseTo(0.5, 9);
    expect(half.radius).toBeLessThan(full.radius);
    expect(storeBlast("fuelTank", 1)).toBeNull();
    expect(storeBlast("magazine", 340)!.damage).toBeCloseTo(340 * EXPLOSION.magazine.damagePerKg, 9);
  });

  it("a full magazine hurts its neighbours far more than a nearly empty one", () => {
    const blastWith = (rounds: number) => {
      const w = new World({ seed: 1 });
      const s = w.addShip(
        D([
          ["cmd", "command.s", 0, 0],
          ["mag", "magazine.kinetic.s", 1.25, 0],
          ["n", "armor.square.s", 2.25, 0],
        ]),
        cat,
      );
      s.part("mag").ammo = rounds;
      s.destroyPart("mag");
      w.step();
      return 400 - s.part("n").hp;
    };
    const full = blastWith(40);
    const few = blastWith(4);
    expect(full).toBeGreaterThan(0);
    expect(few).toBeGreaterThan(0);
    expect(full / few).toBeGreaterThan(5);
    expect(blastWith(0)).toBe(0);
  });
});
