/**
 * AI type study CLI (skirmish AI types, docs/ai-types.md).
 *
 *   npm run ai:study -- [--part matrix|sweep|all] [--seeds 2] [--limit 600] [--threads N]
 *                       [--scenarios s11,s12,…] [--sweep-scenarios s11,s12,s15] [--out balance-report/ai-study]
 *
 * Fights the symmetric (mirror) scenarios' fleets AI against AI and writes study.json and study.md.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SCENARIOS } from "../data/scenarios/index";
import { analyse, matrixJobs, recommend, studyMarkdown, sweepJobs } from "./ai-study";
import { defaultThreads, runJobs } from "./pool";
import type { Job } from "./jobs";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const arg = (name: string, def: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : def;
};
const pick = (list: string) =>
  SCENARIOS.filter((s) => s.id.includes("mirror") && list.split(",").some((p) => s.id.startsWith(p)));
const part = arg("part", "all");
const seeds = Number(arg("seeds", "2"));
const timeLimit = Number(arg("limit", "600"));
const out = resolve(arg("out", join(root, "balance-report/ai-study")));
const jobs: Job[] = [];
if (part !== "sweep") jobs.push(...matrixJobs({ scenarios: pick(arg("scenarios", "s1")), seeds, timeLimit }));
if (part !== "matrix")
  jobs.push(...sweepJobs({ scenarios: pick(arg("sweep-scenarios", "s11,s12,s15")), seeds, timeLimit }));

const t0 = Date.now();
let last = 0;
const results = await runJobs(jobs, Number(arg("threads", String(defaultThreads()))), (d, n) => {
  const now = Date.now();
  if (now - last > 3000 || d === n) {
    last = now;
    process.stdout.write(`\r${d}/${n} battles (${((now - t0) / 1000).toFixed(0)} s)   `);
  }
});
process.stdout.write("\n");
const rep = analyse(results);
const rec = recommend(rep);
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "study.json"), JSON.stringify({ report: rep, recommended: rec }, null, 2));
const md = studyMarkdown(rep, rec);
writeFileSync(join(out, "study.md"), md + "\n");
console.log(md);
console.log(
  `\n${results.length} battles in ${((Date.now() - t0) / 1000).toFixed(0)} s → ${join(out, "study.md")}`,
);
