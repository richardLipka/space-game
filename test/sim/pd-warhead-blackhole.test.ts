import { describe, expect, it } from "vitest";
import catalogueJson from "../../src/data/core/catalogue.json";
import { validateCatalogue } from "../../src/data/validate";
import { PartCatalogue } from "../../src/sim/ship/catalogue";
import { BUNDLED_DESIGNS } from "../../src/data/designs/index";
import { World } from "../../src/sim/world";
import { stepProjectiles, warhead } from "../../src/sim/combat/combat-world";
import { spawnMissile } from "../../src/sim/combat/missiles";
import { COMBAT, MISSILE } from "../../src/sim/combat/constants";
import { SIM_DT } from "../../src/sim/core/loop";
import { rotate, vec2 } from "../../src/sim/core/vec2";
import type { Ship } from "../../src/sim/ship/ship-entity";

const r = validateCatalogue(catalogueJson);
if (!r.ok) throw new Error(r.errors.join("\n"));
const cat = PartCatalogue.fromJson(r.value);
const target = BUNDLED_DESIGNS.get("platform-target")!;
const hull = (s: Ship) => s.parts.reduce((t, p) => t + Math.max(0, p.hp), 0);

/** One round flying straight at the target block's front from 50 m. */
function shoot(kind: string, damage: number): number {
  const w = new World({ seed: 1 });
  const t = w.addShip(target, cat, { position: vec2(0, 0), angle: Math.PI, team: 1 });
  const before = hull(t);
  w.combat.projectiles = [
    {
      id: 1,
      owner: "x",
      team: 0,
      pos: vec2(-50, 0),
      vel: vec2(900, 0),
      mass: 0.1,
      damage,
      age: 0,
      lifetime: 2,
      kind,
    },
  ];
  for (let i = 0; i < 10; i++) stepProjectiles(w, SIM_DT);
  return before - hull(t);
}

describe("point defense against ships", () => {
  it("a point-defense round deals only a small share of its damage to a ship; other rounds deal it all", () => {
    expect(shoot("autocannon-30", 100)).toBeCloseTo(100, 6);
    expect(shoot("pd-20", 100)).toBeCloseTo(100 * COMBAT.pdShipShare, 6);
  });
});

describe("missile warheads", () => {
  it("a warhead that fuses off a corner still delivers most of its damage", () => {
    const w = new World({ seed: 1 });
    const t = w.addShip(BUNDLED_DESIGNS.get("fleet-rapier")!, cat, { position: vec2(0, 0), team: 1 });
    const before = hull(t);
    // About 2.8 m diagonally off the hull's outermost corner: no part centre is within the 5 m blast.
    const corner = [...t.layout.outlines.values()].flat().reduce((a, v) => (v.x + v.y > a.x + a.y ? v : a));
    warhead(w, vec2(corner.x + 2, corner.y + 2), 5, 5000);
    expect(before - hull(t)).toBeGreaterThan(5000 * MISSILE.directShare * 0.5);
  });

  it("the warhead's jet goes on into the next part when the first cannot take it all", () => {
    const w = new World({ seed: 1 });
    const t = w.addShip(target, cat, { position: vec2(0, 0), team: 1 });
    const front = t.parts.find((p) => p.uid === "h-f")!;
    const local = vec2(front.position.x + 1.5, front.position.y);
    const at = rotate(local, 0);
    warhead(w, at, 5, 10 * front.hp);
    expect(front.hp).toBeLessThanOrEqual(0);
    // The command module behind it took the rest.
    expect(t.parts.find((p) => p.uid === "cmd")!.hp).toBeLessThan(
      t.parts.find((p) => p.uid === "cmd")!.def.def.hp,
    );
  });
});

describe("black holes", () => {
  const well = { position: vec2(0, 0), mu: 4e7, softening: 10, coreRadius: 60 };

  it("a ship that flies into the core is torn apart; one that passes outside it only bends its course", () => {
    const w = new World({ seed: 1 });
    w.addGravityWell(well);
    const into = w.addShip(target, cat, { position: vec2(-600, 0), velocity: vec2(150, 0) });
    const past = w.addShip(target, cat, { position: vec2(-600, 900), velocity: vec2(150, 0) });
    const pastHull = hull(past);
    w.run(60 * 8);
    expect(into.parts.filter((p) => p.hp > 0)).toHaveLength(0);
    expect(into.defeated).toBe(true);
    expect(hull(past)).toBe(pastHull);
    expect(past.defeated).toBe(false);
  });

  it("missiles and rounds that enter the core are gone", () => {
    const w = new World({ seed: 1 });
    w.addGravityWell(well);
    const s = w.addShip(target, cat, { position: vec2(-2000, 0) });
    const def = cat.get("core:magazine.missile.s").def.magazine!.missile!;
    spawnMissile(w, s, def, vec2(-100, 0), vec2(1, 0), vec2(300, 0), null);
    w.combat.projectiles = [
      {
        id: 1,
        owner: "x",
        team: 0,
        pos: vec2(-100, 5),
        vel: vec2(900, 0),
        mass: 0.1,
        damage: 10,
        age: 0,
        lifetime: 5,
        kind: "autocannon-30",
      },
    ];
    w.run(30);
    expect(w.combat.missiles).toHaveLength(0);
    expect(w.combat.projectiles).toHaveLength(0);
  });
});
