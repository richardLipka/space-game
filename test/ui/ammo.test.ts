import { describe, expect, it } from "vitest";
import catalogueJson from "../../src/data/core/catalogue.json";
import { validateCatalogue } from "../../src/data/validate";
import { PartCatalogue } from "../../src/sim/ship/catalogue";
import { BUNDLED_DESIGNS } from "../../src/data/designs/index";
import { World } from "../../src/sim/world";
import { ammoSummary } from "../../src/ui/hud/ship-plan";

const r = validateCatalogue(catalogueJson);
if (!r.ok) throw new Error(r.errors.join("\n"));
const cat = PartCatalogue.fromJson(r.value);

describe("munition supply (strategy details, cockpit)", () => {
  it("counts gun rounds with seconds of fire, missiles per type and drones per hangar type", () => {
    const w = new World({ seed: 1 });
    const maul = w.addShip(BUNDLED_DESIGNS.get("fleet-maul")!, cat);
    const lines = ammoSummary(maul);
    const shells = lines.find((l) => l.label === "Cannon shells")!;
    expect(shells.left).toBe(shells.capacity);
    expect(shells.seconds).toBeGreaterThan(100);
    expect(lines.some((l) => /missile/i.test(l.label))).toBe(true);
    const ark = w.addShip(BUNDLED_DESIGNS.get("fleet-ark")!, cat);
    expect(ammoSummary(ark).some((l) => l.label.endsWith("drones"))).toBe(true);
  });

  it("a destroyed magazine counts as empty", () => {
    const w = new World({ seed: 1 });
    const s = w.addShip(BUNDLED_DESIGNS.get("platform-autocannon")!, cat);
    const full = ammoSummary(s)[0]!.left;
    s.parts.find((p) => p.def.def.magazine)!.hp = 0;
    expect(ammoSummary(s)[0]!.left).toBeLessThan(full);
  });
});
