import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateCatalogue, validateDesign, validateInputs, validateScenario } from "../../src/data/validate";
import { PartCatalogue } from "../../src/sim/ship/catalogue";
import { InputPlayer } from "../../src/sim/scenario/replay";
import { createWorldFromScenario } from "../../src/sim/scenario/setup";
import { World } from "../../src/sim/world";
import { vec2 } from "../../src/sim/core/vec2";

const fixturesDir = fileURLToPath(new URL("../fixtures/", import.meta.url));
const fixture = (p: string): unknown => JSON.parse(readFileSync(join(fixturesDir, p), "utf8"));

function scenarioWorld(file: string): World {
  const r = validateScenario(fixture(`scenarios/${file}`));
  if (!r.ok) throw new Error(r.errors.join("\n"));
  return createWorldFromScenario(r.value);
}

/** Golden cases: fixed seed + fixed inputs → final state hash must match test/golden/hashes.json. */
export const goldenCases: Record<string, () => string> = {
  "m0-empty-1000": () => {
    const w = new World({ seed: 1 });
    w.run(1000);
    return w.hash();
  },
  "m0-asteroid-field-3600": () => {
    const w = scenarioWorld("asteroid-field.json");
    w.run(3600);
    return w.hash();
  },
  /** Plan test 1.27: asymmetric design + recorded inputs for 6000 ticks. */
  "m1-asymmetric-6000": () => {
    const w = new World({ seed: 1 });
    const catR = validateCatalogue(fixture("parts/test-catalogue.json"));
    const desR = validateDesign(fixture("designs/asymmetric.json"));
    const inR = validateInputs(fixture("inputs/m1-asymmetric.json"));
    if (!catR.ok || !desR.ok || !inR.ok) throw new Error("invalid fixtures");
    w.addShip(desR.value, PartCatalogue.fromJson(catR.value));
    new InputPlayer(inR.value).runWith(w, 6000);
    return w.hash();
  },
  /** Plan test 3.20: power-starved ship (gyros want more than the reactor gives) on a recorded script. */
  "m3-power-starved-3600": () => {
    const w = new World({ seed: 1 });
    const catR = validateCatalogue(fixture("parts/test-catalogue.json"));
    const desR = validateDesign(fixture("designs/power-starved.json"));
    const inR = validateInputs(fixture("inputs/m3-power-starved.json"));
    if (!catR.ok || !desR.ok || !inR.ok) throw new Error("invalid fixtures");
    w.addShip(desR.value, PartCatalogue.fromJson(catR.value));
    new InputPlayer(inR.value).runWith(w, 3600);
    return w.hash();
  },
  /** Plan test 4.22: gunship vs a scripted dummy, recorded inputs incl. weapons, defeat enforced. */
  "m4-duel-3600": () => {
    const w = new World({ seed: 1, enforceDefeat: true });
    const catR = validateCatalogue(fixture("parts/test-catalogue.json"));
    const gun = validateDesign(fixture("designs/gunship.json"));
    const dummy = validateDesign(fixture("designs/target-dummy.json"));
    const inR = validateInputs(fixture("inputs/m4-duel.json"));
    if (!catR.ok || !gun.ok || !dummy.ok || !inR.ok) throw new Error("invalid fixtures");
    const cat = PartCatalogue.fromJson(catR.value);
    w.addShip(gun.value, cat);
    w.addShip(dummy.value, cat, { position: vec2(60, 0), team: 1 });
    new InputPlayer(inR.value).runWith(w, 3600);
    return w.hash();
  },
};
