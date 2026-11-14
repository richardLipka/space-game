import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import catalogueJson from "../../src/data/core/catalogue.json";
import { validateCatalogue, validateScenario } from "../../src/data/validate";
import { PartCatalogue } from "../../src/sim/ship/catalogue";
import { runTuningTests, TUNING_TESTS } from "../../src/headless/tuning/tests";

const r = validateCatalogue(catalogueJson);
if (!r.ok) throw new Error(r.errors.join("\n"));
const cat = PartCatalogue.fromJson(r.value);

describe("tuning tests (docs/tuning.md)", () => {
  it("every test is a valid scenario of bundled platforms", () => {
    for (const t of TUNING_TESTS) expect(validateScenario(t.scenario).ok, t.scenario.id).toBe(true);
  });

  it("the scenario files (src/data/scenarios/tests, for the scenario editor) match the tests", () => {
    for (const t of TUNING_TESTS) {
      const file = new URL(`../../src/data/scenarios/tests/${t.scenario.id}.json`, import.meta.url);
      expect(
        JSON.parse(readFileSync(file, "utf8")),
        `${t.scenario.id}: run npm run tuning -- tests --write src/data/scenarios/tests`,
      ).toEqual(t.scenario);
    }
  });

  it("the game meets every balance rule: point defense against salvos, laser against autocannon", () => {
    // Seeded, so the shares are exact; 80 runs resolve the 10 % steps of the salvo rules.
    const { rules } = runTuningTests(cat, undefined, 80);
    for (const x of rules)
      expect(`${x.rule.text}: ${x.value.toFixed(2)} ${x.ok ? "ok" : "MISS"}`).toMatch(/ok$/);
  }, 60_000);
});
