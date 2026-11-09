/**
 * Scenario simulation report (plan M7 task 6): every scenario played AI against AI with its reference
 * fleet, several seeds each, in parallel.
 *
 *   npm run balance:scenarios -- [--seeds 5] [--scenarios s02,…] [--overlay overlay.json] [--threads N]
 *                                [--profile balanced] [--limit 600] [--out balance-report/scenarios]
 *
 * Writes scenarios.csv and scenarios.html (fight-length histogram, end reasons per scenario).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateOverlay, type BalanceOverlay } from "../data/balance/overlay";
import { SCENARIOS } from "../data/scenarios/index";
import type { Job } from "./jobs";
import { defaultThreads, runJobs } from "./pool";
import { engagementOf, median } from "./tune";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const arg = (name: string, def: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : def;
};
const ids = arg(
  "scenarios",
  SCENARIOS.filter((s) => /^s\d/.test(s.id))
    .map((s) => s.id)
    .join(","),
)
  .split(",")
  .filter(Boolean);
const seeds = Number(arg("seeds", "5"));
const out = resolve(arg("out", join(root, "balance-report/scenarios")));
let overlay: BalanceOverlay = {};
const ov = arg("overlay", "");
if (ov) {
  const r = validateOverlay(JSON.parse(readFileSync(ov, "utf8")));
  if (!r.ok) throw new Error(r.errors.join("\n"));
  overlay = r.value;
}
const jobs: Job[] = ids.flatMap((scenario) =>
  Array.from({ length: seeds }, (_, i) => ({
    kind: "scenario" as const,
    scenario,
    seed: i + 1,
    profile: arg("profile", "balanced"),
    timeLimit: Number(arg("limit", "600")),
    overlay,
  })),
);

const t0 = Date.now();
const results = await runJobs(jobs, Number(arg("threads", String(defaultThreads()))), (d, n) =>
  process.stdout.write(`\r${d}/${n} battles (${((Date.now() - t0) / 1000).toFixed(0)} s)   `),
);
process.stdout.write("\n");

const rows = results.flatMap((r) =>
  r.kind === "scenario"
    ? [
        {
          scenario: r.result.scenario,
          seed: r.result.seed,
          status: r.result.status,
          time: r.result.metrics.time,
          engagement: engagementOf(r.result.metrics),
          reason: r.result.metrics.reason,
        },
      ]
    : [],
);
mkdirSync(out, { recursive: true });
writeFileSync(
  join(out, "scenarios.csv"),
  "scenario,seed,status,time,engagement,reason\n" +
    rows
      .map(
        (r) =>
          `${r.scenario},${r.seed},${r.status},${r.time.toFixed(1)},${r.engagement.toFixed(1)},${r.reason}`,
      )
      .join("\n") +
    "\n",
);

const bins = [0, 30, 60, 120, 180, 240, 300, 450, 600, Infinity];
const label = (i: number) => (bins[i + 1] === Infinity ? `${bins[i]}+ s` : `${bins[i]}–${bins[i + 1]} s`);
const hist = bins
  .slice(0, -1)
  .map((lo, i) => rows.filter((r) => r.engagement >= lo && r.engagement < bins[i + 1]!).length);
const peak = Math.max(1, ...hist);

const per = ids.map((id) => {
  const rs = rows.filter((r) => r.scenario === id);
  const reasons: Record<string, number> = {};
  for (const r of rs) reasons[r.reason] = (reasons[r.reason] ?? 0) + 1;
  return {
    id,
    won: rs.filter((r) => r.status === "won").length,
    runs: rs.length,
    median: median(rs.map((r) => r.engagement)),
    min: Math.min(...rs.map((r) => r.engagement)),
    max: Math.max(...rs.map((r) => r.engagement)),
    reasons,
  };
});
writeFileSync(
  join(out, "scenarios.html"),
  `<!doctype html><meta charset="utf-8"><title>Scenario simulations</title>
<style>body{font:14px system-ui;margin:24px;background:#fff;color:#111}table{border-collapse:collapse;margin:12px 0}
td,th{border:1px solid #ccc;padding:4px 8px;text-align:right}td:first-child{text-align:left}
.bar{display:inline-block;height:12px;background:#3b82f6}.band{background:#ecfdf5}</style>
<h1>Scenario simulations</h1><p>${rows.length} battles, ${seeds} seeds each. Engagement = first hull damage to the end; target band 60–300 s (shaded).</p>
<h2>Fight length</h2><table>${hist
    .map(
      (n, i) =>
        `<tr${bins[i]! >= 60 && bins[i + 1]! <= 300 ? ' class="band"' : ""}><td>${label(i)}</td><td style="text-align:left"><span class="bar" style="width:${(n / peak) * 300}px"></span> ${n}</td></tr>`,
    )
    .join("")}</table>
<h2>Per scenario</h2><table><tr><th>scenario</th><th>won</th><th>median</th><th>min</th><th>max</th><th>end reasons</th></tr>
${per
  .map(
    (p) =>
      `<tr><td>${p.id}</td><td>${p.won}/${p.runs}</td><td>${p.median.toFixed(0)} s</td><td>${p.min.toFixed(0)} s</td><td>${p.max.toFixed(0)} s</td><td style="text-align:left">${Object.entries(
        p.reasons,
      )
        .map(([k, v]) => `${k} ${v}`)
        .join(", ")}</td></tr>`,
  )
  .join("")}</table>`,
);
console.log("Scenario                    won   median    min    max  end reasons");
for (const p of per)
  console.log(
    `${p.id.padEnd(26)} ${`${p.won}/${p.runs}`.padStart(5)} ${p.median.toFixed(0).padStart(6)} s ${p.min.toFixed(0).padStart(4)} s ${p.max.toFixed(0).padStart(4)} s  ${Object.entries(
      p.reasons,
    )
      .map(([k, v]) => `${k} ${v}`)
      .join(", ")}`,
  );
console.log(`\nReport: ${join(out, "scenarios.html")}`);
