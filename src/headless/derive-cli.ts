import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { deriveCatalogue } from "../data/balance/model";
import { validateCatalogue } from "../data/validate";

/**
 * `npm run balance:derive`: rewrites the core catalogue's derived numbers (mass, hit points, power, heat,
 * fuel, ammunition) from the balance model. Run it after changing src/data/balance/model.ts or a part's
 * outline or `balance` factors, then `npm run format` and `npm run golden:update`.
 */
const path = fileURLToPath(new URL("../data/core/catalogue.json", import.meta.url));
const r = validateCatalogue(JSON.parse(readFileSync(path, "utf8")));
if (!r.ok) throw new Error(`Invalid catalogue:\n${r.errors.join("\n")}`);
const out = deriveCatalogue(r.value);
const check = validateCatalogue(out);
if (!check.ok) throw new Error(`Derived catalogue is invalid:\n${check.errors.join("\n")}`);
writeFileSync(path, `${JSON.stringify(out, null, 2)}\n`);
const changed = out.parts.filter((p, i) => JSON.stringify(p) !== JSON.stringify(r.value.parts[i])).length;
console.log(`catalogue ${out.catalogueVersion}: ${out.parts.length} parts, ${changed} changed`);
