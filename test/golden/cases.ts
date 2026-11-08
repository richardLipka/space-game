import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateCatalogue, validateDesign, validateInputs, validateScenario } from "../../src/data/validate";
import { PartCatalogue } from "../../src/sim/ship/catalogue";
import { InputPlayer } from "../../src/sim/scenario/replay";
import { createWorldFromScenario } from "../../src/sim/scenario/setup";
import { World } from "../../src/sim/world";
import { vec2 } from "../../src/sim/core/vec2";
import { aiProfile } from "../../src/data/ai/index";

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
  /** Plan test 5.19: missile duel with PD on both sides (core catalogue), recorded launches. */
  "m5-missile-duel-1800": () => {
    const w = new World({ seed: 1, enforceDefeat: true });
    const catR = validateCatalogue(
      JSON.parse(readFileSync(new URL("../../src/data/core/catalogue.json", import.meta.url), "utf8")),
    );
    const duelist = validateDesign(fixture("designs/missile-duelist.json"));
    const inR = validateInputs(fixture("inputs/m5-missile-duel.json"));
    if (!catR.ok || !duelist.ok || !inR.ok) throw new Error("invalid fixtures");
    const cat = PartCatalogue.fromJson(catR.value);
    w.addShip(duelist.value, cat);
    w.addShip(duelist.value, cat, { position: vec2(2500, 300), angle: Math.PI, team: 1 });
    new InputPlayer(inR.value).runWith(w, 1800);
    return w.hash();
  },
  /** Plan test 6.15: AI vs AI (aggressive gunboat vs kiting missile frigate with drones), core catalogue. */
  "m6-ai-battle-3600": () => {
    const w = new World({ seed: 1, enforceDefeat: true });
    const core = new URL("../../src/data/", import.meta.url);
    const json = (p: string) => JSON.parse(readFileSync(new URL(p, core), "utf8"));
    const catR = validateCatalogue(json("core/catalogue.json"));
    if (!catR.ok) throw new Error("invalid catalogue");
    const cat = PartCatalogue.fromJson(catR.value);
    const d = (n: string) => {
      const r = validateDesign(json(`designs/${n}.json`));
      if (!r.ok) throw new Error(`invalid ${n}`);
      return r.value;
    };
    for (const n of ["drone-attack", "drone-pd", "drone-decoy"]) w.registerDesign(d(n));
    const a = w.addShip(d("demo-gunboat"), cat);
    const b = w.addShip(d("demo-frigate"), cat, { position: vec2(3500, 600), angle: Math.PI, team: 1 });
    w.setAi(a.id, aiProfile("aggressive"));
    w.setAi(b.id, aiProfile("kiter"));
    w.run(3600);
    return w.hash();
  },
};
