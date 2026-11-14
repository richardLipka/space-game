/**
 * Design audit: every bundled ship against the layout check and the design rules (docs/design-rules.md).
 *
 *   npm run designs:audit [-- --section Playable] [--fix]

 * --fix adds magazines, reactors and heat sinks (mirrored pairs) to the bundled design files that break a
 * rule, then audits again.
 */
import catalogueJson from "../data/core/catalogue.json";
import { validateCatalogue } from "../data/validate";
import { PartCatalogue } from "../sim/ship/catalogue";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { auditBundled } from "./design-audit";
import { fixDesign } from "./design-fix";
import { BUNDLED_DESIGNS } from "../data/designs/index";

const r = validateCatalogue(catalogueJson);
if (!r.ok) throw new Error(r.errors.join("\n"));
const cat = PartCatalogue.fromJson(r.value);
const i = process.argv.indexOf("--section");
const sections = i >= 0 ? process.argv[i + 1]!.split(",") : undefined;

if (process.argv.includes("--fix")) {
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? files(p) : p.endsWith(".json") ? [p] : [];
    });
  const byId = new Map(
    files("src/data/designs").map((f) => [(JSON.parse(readFileSync(f, "utf8")) as { id: string }).id, f]),
  );
  for (const a of auditBundled(cat, sections)) {
    if (a.ok) continue;
    const d = BUNDLED_DESIGNS.get(a.id)!;
    const r = fixDesign(d, cat);
    if (!r.added.length) {
      console.log(`unchanged ${a.id}: ${r.left.join(", ") || "layout issues only"}`);
      continue;
    }
    const file = byId.get(a.id)!;
    writeFileSync(
      file,
      `${JSON.stringify(r.design, null, 2)}
`,
    );
    console.log(
      `fixed ${a.id}: added ${r.added.join(", ")}${r.left.length ? `; still ${r.left.join(", ")}` : ""}`,
    );
  }
  console.log("Run prettier on src/data/designs and audit again (the bundled designs are read at start).");
  process.exit(0);
}

let failed = 0;
for (const a of auditBundled(cat, sections)) {
  if (!a.ok) failed++;
  console.log(`${a.ok ? "ok  " : "FAIL"} ${a.section.padEnd(14)} ${a.name} (${a.id}) · cost ${a.cost}`);
  for (const l of a.layout) console.log(`       layout ${l}`);
  for (const x of a.rules)
    console.log(
      `       ${x.ok ? " " : "✗"} ${x.rule.padEnd(20)} ${x.value.toFixed(2).padStart(6)} (≥ ${x.min}) ${x.note}`,
    );
}
console.log(`${failed} design(s) break a rule`);
process.exitCode = failed ? 1 : 0;
