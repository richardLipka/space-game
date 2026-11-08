/**
 * Balance harness CLI (plan M7 task 6).
 *
 *   npm run balance -- [--seeds 10] [--designs dir|file,file] [--profile balanced] [--limit 120] [--out balance-report] [--strict]
 *
 * Writes report.csv, report.json and report.html to --out. With --strict, exits 1 when a check fails
 * (dominant part, weapon type without counter or without a win, win-rate outlier).
 */
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateCatalogue, validateDesign } from "../data/validate";
import { aiProfile } from "../data/ai/index";
import { PartCatalogue } from "../sim/ship/catalogue";
import type { ShipDesign } from "../data/schemas/design";
import { analyze, runMatrix, toCsv, toHtml } from "./balance";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const arg = (name: string, def: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : def;
};
const flag = (name: string) => process.argv.includes(`--${name}`);
const json = (p: string): unknown => JSON.parse(readFileSync(p, "utf8"));
const design = (p: string): ShipDesign => {
  const r = validateDesign(json(p));
  if (!r.ok) throw new Error(`${p}:\n${r.errors.join("\n")}`);
  return r.value;
};

const cat = validateCatalogue(json(join(root, "src/data/core/catalogue.json")));
if (!cat.ok) throw new Error(cat.errors.join("\n"));
const catalogue = PartCatalogue.fromJson(cat.value);
const drones = ["drone-attack", "drone-pd", "drone-decoy"].map((n) =>
  design(join(root, `src/data/designs/${n}.json`)),
);

const src = arg("designs", join(root, "src/data/designs/balance"));
const files = src.includes(",")
  ? src.split(",")
  : statSync(src).isDirectory()
    ? readdirSync(src)
        .filter((f) => f.endsWith(".json"))
        .sort()
        .map((f) => join(src, f))
    : [src];
const designs = files.map(design);
const seeds = Number(arg("seeds", "10"));
const profile = aiProfile(arg("profile", "balanced"));
const limit = Number(arg("limit", "120"));
const out = resolve(arg("out", join(root, "balance-report")));

const t0 = Date.now();
let last = 0;
const report = runMatrix(designs, catalogue, drones, seeds, profile, { timeLimit: limit }, (done, total) => {
  const now = Date.now();
  if (now - last > 2000 || done === total) {
    last = now;
    process.stdout.write(`\r${done}/${total} battles (${((now - t0) / 1000).toFixed(0)} s)   `);
  }
});
process.stdout.write("\n");
const analysis = analyze(report);
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "report.csv"), toCsv(report));
writeFileSync(join(out, "report.json"), JSON.stringify({ report, analysis }, null, 2));
writeFileSync(join(out, "report.html"), toHtml(report, analysis));

const name = (id: string) => report.designs.find((d) => d.id === id)?.name ?? id;
console.log("\nDesign                              cost  win%   W/L/D       TTK");
for (const s of [...report.summary].sort((a, b) => b.winRate - a.winRate)) {
  const d = report.designs.find((x) => x.id === s.id)!;
  console.log(
    `${name(s.id).padEnd(34)} ${String(d.cost).padStart(5)} ${String(Math.round(s.winRate * 100)).padStart(5)}  ${`${s.wins}/${s.losses}/${s.draws}`.padEnd(10)} ${s.timeToKill === null ? "   –" : s.timeToKill.toFixed(0).padStart(4) + " s"}`,
  );
}
const mirror = report.pairs.filter((p) => p.a === p.b);
const ends =
  mirror.reduce((n, p) => n + p.winsA + p.winsB, 0) /
  Math.max(
    1,
    mirror.reduce((n, p) => n + p.games, 0),
  );
console.log(`\nMirror matches decided: ${Math.round(ends * 100)} %`);
console.log(
  `7.6 dominant parts: ${analysis.dominantParts.map((d) => `${d.part} ${Math.round(d.share * 100)}%`).join(", ") || "none"}`,
);
console.log(
  `7.7 never loses: ${analysis.noCounter.join(", ") || "none"}; never wins: ${analysis.neverWins.join(", ") || "none"}`,
);
console.log(
  `Outliers (win rate outside 20–80 %): ${analysis.outliers.map((o) => `${name(o.id)} ${Math.round(o.winRate * 100)}%`).join(", ") || "none"}`,
);
console.log(`\nReport: ${join(out, "report.html")}`);
if (flag("strict") && !analysis.ok) process.exit(1);
