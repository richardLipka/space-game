import { describe, expect, it } from "vitest";
import catalogueJson from "../../src/data/core/catalogue.json";
import { validateCatalogue } from "../../src/data/validate";
import { PartCatalogue } from "../../src/sim/ship/catalogue";
import { PLATFORMS } from "../../src/data/designs/index";
import { auditBundled } from "../../src/headless/design-audit";

const r = validateCatalogue(catalogueJson);
if (!r.ok) throw new Error(r.errors.join("\n"));
const cat = PartCatalogue.fromJson(r.value);

describe("design rules (docs/design-rules.md; npm run designs:audit)", () => {
  it("every playable ship and test platform has a valid layout, power, cooling and ammunition for a game", () => {
    // Experimental ships (demo ships, balance archetypes) are audited but not held to the rules: tests use
    // them as fixtures with fixed handling.
    for (const a of auditBundled(cat, ["Playable", "Test platforms"])) {
      const broken = [
        ...a.layout,
        ...a.rules.filter((x) => !x.ok).map((x) => `${x.rule} ${x.value.toFixed(2)} < ${x.min}`),
      ];
      expect(broken, `${a.name} (${a.id})`).toEqual([]);
    }
  });

  it("test platforms are stationary, in their own section, and fire on their own", () => {
    expect(PLATFORMS.length).toBeGreaterThanOrEqual(10);
    for (const d of PLATFORMS) {
      expect(d.section, d.id).toBe("Test platforms");
      expect(d.weaponGroupModes["1"], d.id).toBe("ai");
    }
  });
});
