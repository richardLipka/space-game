/**
 * Automated balance tuning CLI (plan M7 task 6).
 *
 *   npm run tune -- [--iterations 8] [--seeds 3] [--fine-seeds 8] [--threads N] [--target 150]
 *                   [--scenarios s02,s03,…] [--profile balanced] [--limit 600] [--start overlay.json]
 *                   [--out balance-report/tune]
 *
 * Runs the archetype duels and the scenarios, adjusts a balance overlay until fights last the target time
 * and weapon types are even, and writes iteration-NN.json, overlay.json, catalogue.tuned.json, diff.txt
 * and report.html to --out. The catalogue is derived from the balance model: accept results there or with
 * `npm run tuning -- apply`.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyOverlay, catalogueDiff, validateOverlay, type BalanceOverlay } from "../data/balance/overlay";
import { validateCatalogue } from "../data/validate";
import { BUNDLED_DESIGNS } from "../data/designs/index";
import { SCENARIOS } from "../data/scenarios/index";
import { catalogueFor } from "./jobs";
import { defaultThreads, runJobs } from "./pool";
import { DEFAULT_TARGETS, tune, type Iteration } from "./tune";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const arg = (name: string, def: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : def;
};
const flag = (name: string) => process.argv.includes(`--${name}`);

const archetypes = [...BUNDLED_DESIGNS.keys()].filter((id) => id.startsWith("arch-")).sort();
const defaultScenarios = SCENARIOS.filter((s) => /^s(0[2-9]|1\d)/.test(s.id)).map((s) => s.id);
const scenarios = arg("scenarios", defaultScenarios.join(",")).split(",").filter(Boolean);
const threads = Number(arg("threads", String(defaultThreads())));
const target = Number(arg("target", String(DEFAULT_TARGETS.engagement)));
const out = resolve(arg("out", join(root, "balance-report/tune")));
const startPath = arg("start", "");
let start: BalanceOverlay = {};
if (startPath) {
  const r = validateOverlay(JSON.parse(readFileSync(startPath, "utf8")));
  if (!r.ok) throw new Error(r.errors.join("\n"));
  start = r.value;
}
const opts = {
  archetypes,
  scenarios,
  iterations: Number(arg("iterations", "8")),
  seeds: Number(arg("seeds", "3")),
  fineSeeds: Number(arg("fine-seeds", "8")),
  profile: arg("profile", "balanced"),
  timeLimit: Number(arg("limit", "600")),
  targets: { ...DEFAULT_TARGETS, engagement: target },
  start,
};

mkdirSync(out, { recursive: true });
console.log(
  `Tuning: ${archetypes.length} archetypes, ${scenarios.length} scenarios, ${threads} threads, target ${target} s`,
);
const t0 = Date.now();
const iterations = await tune(
  opts,
  async (jobs) => {
    let last = 0;
    return runJobs(jobs, threads, (done, total) => {
      const now = Date.now();
      if (now - last > 2000 || done === total) {
        last = now;
        process.stdout.write(`\r  ${done}/${total} battles (${((now - t0) / 1000).toFixed(0)} s)   `);
      }
    });
  },
  BUNDLED_DESIGNS,
  catalogueFor,
  (it) => {
    process.stdout.write("\n");
    writeFileSync(
      join(out, `iteration-${String(it.index).padStart(2, "0")}.json`),
      JSON.stringify(it, null, 2),
    );
    const s = it.stats;
    console.log(
      `#${it.index} (${it.seeds} seeds, ${s.battles} battles): engagement median ${s.medianEngagement.toFixed(0)} s (duels ${s.medianDuel.toFixed(0)}, scenarios ${s.medianScenario.toFixed(0)}), timeouts ${pct(s.timeouts)}, out of ammo ${pct(s.ammoOut)}, command kills ${pct(s.commandShare)}`,
    );
    console.log(
      "   win rates: " +
        Object.entries(s.weapons)
          .map(([k, w]) => `${k} ${pct(w.winRate)}`)
          .join(", "),
    );
    for (const n of it.notes) console.log(`   → ${n}`);
  },
);
function pct(x: number) {
  return `${Math.round(x * 100)} %`;
}

const best = iterations.find((i) => i.converged) ?? iterations[iterations.length - 1]!;
const baseJson = JSON.parse(readFileSync(join(root, "src/data/core/catalogue.json"), "utf8")) as unknown;
const base = validateCatalogue(baseJson);
if (!base.ok) throw new Error(base.errors.join("\n"));
const tuned = applyOverlay(base.value, best.overlay);
const diff = catalogueDiff(base.value, tuned);
writeFileSync(join(out, "overlay.json"), JSON.stringify(best.overlay, null, 2) + "\n");
writeFileSync(join(out, "catalogue.tuned.json"), JSON.stringify(tuned, null, 2) + "\n");
writeFileSync(join(out, "diff.txt"), diff.join("\n") + "\n");
writeFileSync(join(out, "report.html"), toHtml(iterations, best, diff));
console.log(
  `\n${best.converged ? "Converged" : "Not converged"} after ${iterations.length} iterations (${((Date.now() - t0) / 1000).toFixed(0)} s). Overlay of iteration ${best.index}: ${JSON.stringify(best.overlay)}`,
);
console.log(`${diff.length} catalogue changes; report: ${join(out, "report.html")}`);
// The catalogue is derived from the balance model: an overlay written into it would be undone by the next
// `npm run balance:derive` and fails the model test, so results are carried into the model instead.
if (flag("apply"))
  console.log(
    "--apply is no longer supported: the catalogue is derived from src/data/balance/model.ts. Carry the overlay's direction into the model, or use `npm run tuning -- apply` (docs/tuning.md).",
  );

function toHtml(its: readonly Iteration[], chosen: Iteration, d: readonly string[]): string {
  const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
  const weapons = [...new Set(its.flatMap((i) => Object.keys(i.stats.weapons)))].sort();
  const max = Math.max(1, ...its.map((i) => i.stats.medianEngagement), target * 1.2);
  const rows = its
    .map(
      (
        i,
      ) => `<tr${i === chosen ? ' class="chosen"' : ""}><td>${i.index}</td><td>${i.seeds}</td><td>${i.stats.battles}</td>
<td><div class="bar" style="width:${(i.stats.medianEngagement / max) * 160}px"></div>${i.stats.medianEngagement.toFixed(0)} s</td>
<td>${i.stats.medianDuel.toFixed(0)}</td><td>${i.stats.medianScenario.toFixed(0)}</td><td>${pct(i.stats.timeouts)}</td><td>${pct(i.stats.ammoOut)}</td>
${weapons.map((w) => `<td>${i.stats.weapons[w] ? pct(i.stats.weapons[w].winRate) : "–"}</td>`).join("")}
<td class="notes">${i.notes.map(esc).join("<br>")}</td></tr>`,
    )
    .join("\n");
  const sc = Object.entries(chosen.stats.scenarios)
    .map(
      ([k, v]) => `<tr><td>${esc(k)}</td><td>${v.wins}/${v.runs}</td><td>${v.median.toFixed(0)} s</td></tr>`,
    )
    .join("");
  return `<!doctype html><meta charset="utf-8"><title>Balance tuning</title>
<style>body{font:14px system-ui;margin:24px;background:#fff;color:#111}table{border-collapse:collapse;margin:12px 0}
td,th{border:1px solid #ccc;padding:4px 8px;text-align:right;vertical-align:top}.notes{text-align:left;font-size:12px}
.bar{display:inline-block;height:10px;background:#3b82f6;margin-right:6px}.chosen{background:#eef6ff}
pre{background:#f5f5f5;padding:12px;max-height:480px;overflow:auto}</style>
<h1>Balance tuning</h1><p>Target median engagement ${target} s (band ${opts.targets.engagementBand.join("–")} s).
${chosen.converged ? "Converged" : "Not converged"}; chosen iteration ${chosen.index}.</p>
<table><tr><th>#</th><th>seeds</th><th>battles</th><th>median engagement</th><th>duels</th><th>scenarios</th><th>timeouts</th><th>out of ammo</th>
${weapons.map((w) => `<th>${esc(w)}</th>`).join("")}<th>adjustments</th></tr>${rows}</table>
<h2>Scenarios (chosen iteration)</h2><table><tr><th>scenario</th><th>won</th><th>median engagement</th></tr>${sc}</table>
<h2>Overlay</h2><pre>${esc(JSON.stringify(chosen.overlay, null, 2))}</pre>
<h2>Catalogue changes (${d.length})</h2><pre>${esc(d.join("\n"))}</pre>`;
}
