import { describe, expect, it } from "vitest";
import catalogueJson from "../../src/data/core/catalogue.json";
import { validateCatalogue } from "../../src/data/validate";
import { PartCatalogue } from "../../src/sim/ship/catalogue";
import { BUNDLED_DESIGNS } from "../../src/data/designs/index";
import { World } from "../../src/sim/world";
import { Camera } from "../../src/render/camera";
import { damageClass, hullFraction, systemStatus } from "../../src/ui/hud/ship-plan";

const r = validateCatalogue(catalogueJson);
if (!r.ok) throw new Error(r.errors.join("\n"));
const cat = PartCatalogue.fromJson(r.value);

describe("cockpit damage plan", () => {
  it("damage classes: intact, three steps of damage, wreck", () => {
    expect(damageClass(100, 100)).toBe(4);
    expect(damageClass(90, 100)).toBe(4);
    expect(damageClass(89, 100)).toBe(3);
    expect(damageClass(60, 100)).toBe(3);
    expect(damageClass(59, 100)).toBe(2);
    expect(damageClass(30, 100)).toBe(2);
    expect(damageClass(29, 100)).toBe(1);
    expect(damageClass(0, 100)).toBe(0);
    expect(damageClass(-5, 100)).toBe(0);
  });

  it("hull share and system counts follow the parts' hit points", () => {
    const w = new World({ seed: 1 });
    const s = w.addShip(BUNDLED_DESIGNS.get("fleet-rapier")!, cat);
    expect(hullFraction(s)).toBe(1);
    const before = systemStatus(s);
    const wpn = before.find((x) => x.label === "WPN")!;
    const eng = before.find((x) => x.label === "ENG")!;
    expect(wpn.alive).toBe(wpn.total);
    expect(eng.total).toBeGreaterThan(0);
    // Systems the ship does not have are left out.
    expect(before.every((x) => x.total > 0)).toBe(true);

    const gun = s.parts.find((p) => p.def.def.weapon)!;
    s.destroyPart(gun.uid);
    const total = s.parts.reduce((n, p) => n + p.def.def.hp, 0);
    expect(hullFraction(s)).toBeCloseTo(1 - gun.def.def.hp / total, 9);
    expect(systemStatus(s).find((x) => x.label === "WPN")).toMatchObject({
      alive: wpn.total - 1,
      total: wpn.total,
    });
  });
});

describe("camera insets (HUD panels)", () => {
  it("the view is centred in, and fitted to, the area the panels leave free", () => {
    const c = new Camera();
    c.resize(1400, 800);
    c.insets = { left: 260, right: 300, top: 60, bottom: 100 };
    expect(c.viewWidth).toBe(840);
    expect(c.viewHeight).toBe(640);
    c.center = { x: 50, y: -20 };
    c.zoom = 4;
    // The camera centre lands in the middle of the free area, and the mapping round-trips.
    expect(c.worldToScreen(c.center)).toEqual({ x: 260 + 420, y: 60 + 320 });
    const p = { x: 123, y: 45 };
    const back = c.screenToWorld(c.worldToScreen(p));
    expect(back.x).toBeCloseTo(p.x, 9);
    expect(back.y).toBeCloseTo(p.y, 9);

    // Follow-target framing keeps both ships inside the free area.
    const ship = { x: 0, y: 0 };
    const target = { x: 2000, y: 600 };
    for (let i = 0; i < 600; i++) c.update(ship, 10, target, 1 / 60);
    for (const q of [ship, target]) {
      const s = c.worldToScreen(q);
      expect(s.x).toBeGreaterThan(260);
      expect(s.x).toBeLessThan(1400 - 300);
      expect(s.y).toBeGreaterThan(60);
      expect(s.y).toBeLessThan(800 - 100);
    }
  });

  it("without insets the view is the whole screen", () => {
    const c = new Camera();
    c.resize(800, 600);
    c.center = { x: 0, y: 0 };
    expect(c.worldToScreen({ x: 0, y: 0 })).toEqual({ x: 400, y: 300 });
  });
});
