import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateCatalogue, validateDesign, validateScenario } from "../src/data/validate";
import type { ShipDesign } from "../src/data/schemas/design";
import type { Scenario } from "../src/data/schemas/scenario";
import { PartCatalogue } from "../src/sim/ship/catalogue";

export const fixturesDir = fileURLToPath(new URL("./fixtures/", import.meta.url));
export const readFixture = (p: string): unknown => JSON.parse(readFileSync(join(fixturesDir, p), "utf8"));

export function testCatalogue(): PartCatalogue {
  const r = validateCatalogue(readFixture("parts/test-catalogue.json"));
  if (!r.ok) throw new Error(r.errors.join("\n"));
  return PartCatalogue.fromJson(r.value);
}

export function design(name: string): ShipDesign {
  const r = validateDesign(readFixture(`designs/${name}.json`));
  if (!r.ok) throw new Error(r.errors.join("\n"));
  return r.value;
}

export function scenario(name: string): Scenario {
  const r = validateScenario(readFixture(`scenarios/${name}.json`));
  if (!r.ok) throw new Error(r.errors.join("\n"));
  return r.value;
}
