import { describe, expect, it } from "vitest";
import catalogueJson from "../../src/data/core/catalogue.json";
import { validateCatalogue } from "../../src/data/validate";
import { PartCatalogue } from "../../src/sim/ship/catalogue";
import { BUNDLED_DESIGNS } from "../../src/data/designs/index";
import { aiProfile } from "../../src/data/ai/index";
import { World } from "../../src/sim/world";
import { vec2 } from "../../src/sim/core/vec2";
import {
  attackFront,
  bearingOf,
  bears,
  designFirepower,
  FIREPOWER,
  liveFirepower,
} from "../../src/sim/ai/firepower";
import { classOfMass, classOfShip } from "../../src/sim/ship/classes";

const r = validateCatalogue(catalogueJson);
if (!r.ok) throw new Error(r.errors.join("\n"));
const cat = PartCatalogue.fromJson(r.value);
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

describe("firepower by direction and the attack front", () => {
  it("a fighter with forward guns has its attack front at the nose", () => {
    const fp = designFirepower(BUNDLED_DESIGNS.get("fleet-wasp")!, cat);
    expect(fp.front).toBeCloseTo(0, 6);
    expect(fp.profile).toHaveLength(FIREPOWER.samples);
    expect(fp.profile[0]).toBe(Math.max(...fp.profile));
  });

  it("with no clear side the nose wins; with no weapons it is 0", () => {
    expect(attackFront(new Array(FIREPOWER.samples).fill(5))).toBe(0);
    expect(attackFront(new Array(FIREPOWER.samples).fill(0))).toBe(0);
    const port = new Array(FIREPOWER.samples).fill(0);
    port[18] = 10; // 90°
    expect(attackFront(port)).toBeCloseTo(Math.PI / 2, 6);
  });

  it("in combat the front follows the weapons that are left", () => {
    const w = new World({ seed: 1 });
    const s = w.addShip(BUNDLED_DESIGNS.get("fleet-rapier")!, cat);
    const before = liveFirepower(s).front;
    // Destroy every weapon that bears on the current front: the front moves.
    for (const g of s.weapons)
      if (
        g.def.kind !== "pd" &&
        bears({ mount: g.part.angle, def: g.def, blocked: g.blocked, dps: 1 }, before)
      )
        s.destroyPart(g.part.uid);
    const after = liveFirepower(s);
    expect(Math.abs(wrap(after.front - before))).toBeGreaterThan(0.2);
    expect(
      after.profile[
        Math.round((wrap(before) / (2 * Math.PI)) * FIREPOWER.samples + FIREPOWER.samples) % FIREPOWER.samples
      ],
    ).toBe(0);
    expect(bearingOf(0)).toBe(0);
  });

  it("a move order with a facing ends with the attack front pointing that way", () => {
    const w = new World({ seed: 1 });
    const s = w.addShip(BUNDLED_DESIGNS.get("fleet-rapier")!, cat);
    const st = w.setAi(s.id, aiProfile("balanced"));
    const facing = Math.PI * 0.75;
    st.order = { kind: "move", point: vec2(600, 300), facing };
    w.run(60 * 60);
    const angle = w.physics.getBodyState(s.id).angle;
    expect(Math.abs(wrap(angle + liveFirepower(s).front - facing))).toBeLessThan(0.35);
  });
});

describe("ship classes", () => {
  it("sorts the fleet by mass into classes, with roles from the weapon mix", () => {
    const w = new World({ seed: 1 });
    const c = (id: string) => classOfShip(w.addShip(BUNDLED_DESIGNS.get(id)!, cat));
    expect(c("fleet-wasp")).toEqual({ cls: "fighter", role: "gun" });
    expect(c("fleet-maul").cls).toBe("corvette");
    expect(c("fleet-rapier")).toEqual({ cls: "destroyer", role: "gun" });
    expect(c("fleet-squall")).toEqual({ cls: "cruiser", role: "missile" });
    expect(c("fleet-leviathan").cls).toBe("battleship");
    expect(c("fleet-ark").role).toBe("carrier");
    expect(c("drone-attack").cls).toBe("drone");
    expect(classOfMass(50_000)).toBe("battlecruiser");
  });
});
