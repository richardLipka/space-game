/** Regenerates test/golden/hashes.json. Every changed hash must be justified in the PR (plan §2). */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { goldenCases } from "./cases";

const file = join(fileURLToPath(new URL(".", import.meta.url)), "hashes.json");
const old: Record<string, string> = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
const next: Record<string, string> = {};
for (const name of Object.keys(goldenCases).sort()) {
  next[name] = goldenCases[name]!();
  const status = old[name] === undefined ? "new" : old[name] === next[name] ? "same" : "CHANGED";
  console.log(`${status.padEnd(8)} ${name}  ${next[name]}`);
}
for (const name of Object.keys(old)) if (!(name in next)) console.log(`removed  ${name}`);
writeFileSync(file, JSON.stringify(next, null, 2) + "\n");
