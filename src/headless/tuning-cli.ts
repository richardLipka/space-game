/**
 * Balance-model tuning by fight length (docs/tuning.md).
 *
 *   npm run tuning -- eval        [--set pace=7,fuelHeat=20000] [--params file.json] [--seeds 4] [--round 0]
 *                                 [--matchups small-wasp,large-anvil] [--note "why"]
 *   npm run tuning -- sensitivity [--genes hp,fuelHeat] [--factor 1.5] [--set …] [--params …] [--seeds 4]
 *   npm run tuning -- history
 *   npm run tuning -- ga          [--run name] [--hours 6] [--generations 200] [--population 16] [--seeds 3]
 *                                 [--patience 15] [--seed 1] [--params start.json] [--resume]
 *   npm run tuning -- report      --run name
 *   npm run tuning -- apply       --params file.json            (or --run name: the run's best)
 *
 * Common: [--config tuning.json] [--threads N] [--out balance-report/tuning]
 *
 * eval and sensitivity are the small steps (a person or an AI agent reads the table and decides the next
 * values); every eval is logged to steps.jsonl. ga runs unattended for hours, saving its state after every
 * generation (Ctrl+C stops after the current one; --resume continues).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, appendFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateCatalogue } from "../data/validate";
import { configFrom, type TuningConfig } from "./tuning/config";
import { evaluateMany, seedsFor, type Evaluation } from "./tuning/fitness";
import { changes, checkGenes, currentValue, startParams, toUnit, type Params } from "./tuning/genome";
import {
  breed,
  DEFAULT_GA,
  initialState,
  meanLoss,
  paramsOf,
  record,
  type GaOptions,
  type GaState,
} from "./tuning/ga";
import { applyParams } from "./tuning/apply";
import { gaReport } from "./tuning/report";
import { defaultThreads, runJobs } from "./pool";
import type { Job } from "./jobs";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const command = process.argv[2] ?? "help";
const arg = (name: string, def: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1]! : def;
};
const flag = (name: string) => process.argv.includes(`--${name}`);

// PowerShell's npm wrapper drops `--` and npm then eats the flags, leaving bare words ("ga run x hours 2").
// Refuse to run rather than silently fall back to defaults (a 6-hour GA instead of a short trial).
{
  const booleans = new Set(["--resume", "--restart"]);
  const rest = process.argv.slice(3);
  const stray = rest.filter(
    (t, i) =>
      !t.startsWith("--") && (i === 0 || !rest[i - 1]!.startsWith("--") || booleans.has(rest[i - 1]!)),
  );
  if (stray.length)
    throw new Error(
      `Unexpected arguments without a flag: ${stray.join(" ")}. If you ran \`npm run tuning -- …\` in PowerShell, ` +
        "npm dropped the flags: use `npm run tuning '--' ga --run x` or `npx tsx src/headless/tuning-cli.ts ga --run x`.",
    );
}
const out = resolve(arg("out", join(root, "balance-report/tuning")));
const threads = Number(arg("threads", String(defaultThreads())));

function loadConfig(): TuningConfig {
  const path = arg("config", "");
  let cfg = configFrom(path ? (JSON.parse(readFileSync(path, "utf8")) as Partial<TuningConfig>) : undefined);
  const only = arg("matchups", "");
  if (only) {
    const ids = only.split(",");
    cfg = { ...cfg, matchups: cfg.matchups.filter((m) => ids.includes(m.id)) };
    if (cfg.matchups.length === 0) throw new Error(`No matchups ${only}`);
  }
  if (flag("seeds")) cfg = { ...cfg, seeds: Number(arg("seeds", "4")) };
  const errors = checkGenes(cfg.genes);
  if (errors.length) throw new Error(errors.join("\n"));
  return cfg;
}

/** Parameters from --params (a params object, or a file with a "params" field) and --set overrides. */
function loadParams(cfg: TuningConfig): Params {
  const p: Params = startParams(cfg.genes);
  const file = arg("params", "");
  if (file) {
    const j = JSON.parse(readFileSync(file, "utf8")) as { params?: Params } & Params;
    Object.assign(p, j.params ?? j);
  }
  for (const kv of arg("set", "").split(",").filter(Boolean)) {
    const [k, v] = kv.split("=");
    if (!cfg.genes.some((g) => g.id === k)) throw new Error(`Unknown gene "${k}"`);
    p[k!] = Number(v);
  }
  return p;
}

function runner(label: string) {
  const t0 = Date.now();
  return async (jobs: Job[]) => {
    let last = 0;
    const r = await runJobs(jobs, threads, (d, n) => {
      const now = Date.now();
      if (process.stdout.isTTY && (now - last > 2000 || d === n)) {
        last = now;
        process.stdout.write(`\r  ${label}: ${d}/${n} battles (${((now - t0) / 1000).toFixed(0)} s)   `);
      }
    });
    if (process.stdout.isTTY) process.stdout.write("\n");
    return r;
  };
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const pad = (s: string, n: number) => (s.length >= n ? s : s + " ".repeat(n - s.length));

/** The evaluation as a compact text table (what an agent reads to decide the next step). */
function table(cfg: TuningConfig, e: Evaluation): string {
  const rows = [
    `loss ${e.loss.toFixed(3)} (${Object.entries(e.parts)
      .map(([k, v]) => `${k} ${v.toFixed(3)}`)
      .join(", ")}); ${e.inBand}/${e.matchups.length} matchups in band`,
    `${pad("matchup", 15)} ${pad("band", 9)} ${pad("median", 7)} ${pad("lengths (s)", 26)} ${pad("t/o", 4)} ${pad("hot", 4)} ${pad("brwn", 4)} ${pad("ammo", 4)} ${pad("msl l/d/h", 10)} end reasons`,
  ];
  for (const m of e.matchups) {
    const mark = m.inBand ? " " : m.median < m.band[0] ? "↓" : "↑";
    rows.push(
      `${pad(m.id, 15)} ${pad(`${m.band[0]}-${m.band[1]}`, 9)} ${pad(`${m.median.toFixed(0)}${mark}`, 7)} ${pad(m.lengths.map((x) => x.toFixed(0)).join(","), 26)} ${pad(pct(m.timeouts), 4)} ${pad(pct(m.hot), 4)} ${pad(pct(m.brownout), 4)} ${pad(pct(m.ammoLeft), 4)} ${pad(`${m.missiles.launched}/${m.missiles.down}/${m.missiles.hits}`, 10)} ${Object.entries(
        m.reasons,
      )
        .map(([k, v]) => `${k.replace("timeout-", "t/o-")}×${v}`)
        .join(" ")}`,
    );
  }
  if (e.refused.length) rows.push(`REFUSED without battles: ${e.refused.join("; ")}`);
  rows.push(
    `design margins (power, cooling; today's = 1 or better): ${e.margins
      .map((m) => `${m.design.replace("fleet-", "")} ${m.power.toFixed(2)}/${m.cooling.toFixed(2)}`)
      .join(", ")}`,
  );
  const ch = changes(cfg.genes, e.params);
  rows.push(ch.length ? `params: ${ch.join(", ")}` : "params: the game's current values");
  return rows.join("\n");
}

async function cmdEval() {
  const cfg = loadConfig();
  const p = loadParams(cfg);
  const seeds = seedsFor(Number(arg("round", "0")), cfg.seeds);
  const [e] = await evaluateMany(cfg, [p], seeds, runner("eval"));
  console.log(table(cfg, e!));
  mkdirSync(out, { recursive: true });
  const step = {
    time: new Date().toISOString(),
    note: arg("note", ""),
    seeds,
    params: p,
    loss: e!.loss,
    parts: e!.parts,
    inBand: e!.inBand,
    medians: Object.fromEntries(e!.matchups.map((m) => [m.id, Math.round(m.median)])),
    matchups: e!.matchups,
  };
  appendFileSync(join(out, "steps.jsonl"), JSON.stringify(step) + "\n");
  writeFileSync(join(out, "last-eval.json"), JSON.stringify(step, null, 2));
  console.log(`logged to ${join(out, "steps.jsonl")}; params in ${join(out, "last-eval.json")}`);
}

async function cmdSensitivity() {
  const cfg = loadConfig();
  const base = loadParams(cfg);
  const factor = Number(arg("factor", "1.5"));
  const genes = arg("genes", "")
    ? cfg.genes.filter((g) => arg("genes", "").split(",").includes(g.id))
    : cfg.genes;
  const sets: Params[] = [base];
  const probes: { gene: string; lo: number; hi: number }[] = [];
  for (const g of genes) {
    const v = base[g.id]!;
    const span = g.max - g.min;
    const lo = Math.max(g.min, g.log ? v / factor : v - 0.15 * span);
    const hi = Math.min(g.max, g.log ? v * factor : v + 0.15 * span);
    probes.push({ gene: g.id, lo, hi });
    sets.push({ ...base, [g.id]: lo }, { ...base, [g.id]: hi });
  }
  const seeds = seedsFor(Number(arg("round", "0")), cfg.seeds);
  const evals = await evaluateMany(cfg, sets, seeds, runner("sensitivity"));
  const b = evals[0]!;
  console.log(table(cfg, b));
  console.log(
    "\nElasticity of median fight length (d ln length / d ln value) per matchup, and loss at the low / high value:",
  );
  console.log(
    `${pad("gene", 18)} ${pad("low→high", 20)} ${cfg.matchups.map((m) => pad(m.id.slice(0, 11), 11)).join(" ")} loss lo/hi`,
  );
  const rows: Record<string, unknown>[] = [];
  probes.forEach((pr, k) => {
    const lo = evals[1 + 2 * k]!;
    const hi = evals[2 + 2 * k]!;
    const dv = Math.log(pr.hi / pr.lo) || 1;
    const el = cfg.matchups.map((_, j) => {
      const a = Math.max(1, lo.matchups[j]!.median);
      const c = Math.max(1, hi.matchups[j]!.median);
      return Math.log(c / a) / dv;
    });
    rows.push({ gene: pr.gene, lo: pr.lo, hi: pr.hi, elasticity: el, lossLo: lo.loss, lossHi: hi.loss });
    console.log(
      `${pad(pr.gene, 18)} ${pad(`${+pr.lo.toPrecision(3)}→${+pr.hi.toPrecision(3)}`, 20)} ${el.map((x) => pad((x >= 0 ? "+" : "") + x.toFixed(2), 11)).join(" ")} ${lo.loss.toFixed(2)}/${hi.loss.toFixed(2)}`,
    );
  });
  console.log(
    `(base loss ${b.loss.toFixed(3)}; medians move in steps of whole battles, so small values are noise)`,
  );
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "sensitivity.json"), JSON.stringify({ base: b, probes: rows }, null, 2));
}

function cmdHistory() {
  const path = join(out, "steps.jsonl");
  if (!existsSync(path)) return console.log("No steps yet.");
  const steps = readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map(
      (l) =>
        JSON.parse(l) as {
          time: string;
          note: string;
          loss: number;
          inBand: number;
          medians: Record<string, number>;
          params: Params;
        },
    );
  const cfg = loadConfig();
  steps.forEach((s, i) =>
    console.log(
      `#${i + 1} ${s.time.slice(0, 16)} loss ${s.loss.toFixed(3)} in band ${s.inBand}  ${Object.entries(
        s.medians,
      )
        .map(([k, v]) => `${k} ${v}`)
        .join(
          ", ",
        )}${s.note ? `  — ${s.note}` : ""}\n    ${changes(cfg.genes, s.params).join(", ") || "current values"}`,
    ),
  );
}

// ---------- GA ----------

const runDir = () => join(out, "runs", arg("run", "ga"));

function saveJson(path: string, data: unknown) {
  writeFileSync(path + ".tmp", JSON.stringify(data, null, 2));
  renameSync(path + ".tmp", path);
}

async function cmdGa() {
  const dir = runDir();
  mkdirSync(dir, { recursive: true });
  const statePath = join(dir, "state.json");
  let state: GaState;
  let cfg: TuningConfig;
  if (flag("resume") && existsSync(statePath)) {
    state = JSON.parse(readFileSync(statePath, "utf8")) as GaState;
    cfg = JSON.parse(readFileSync(join(dir, "config.json"), "utf8")) as TuningConfig;
    console.log(
      `Resuming ${dir} at generation ${state.generation} (${(state.elapsed / 3600).toFixed(2)} h so far)`,
    );
  } else {
    if (existsSync(statePath) && !flag("restart"))
      throw new Error(`${statePath} exists: pass --resume to continue it or --restart to start over`);
    cfg = loadConfig();
    const options: GaOptions = {
      ...DEFAULT_GA,
      population: Number(arg("population", String(DEFAULT_GA.population))),
      seeds: Number(arg("seeds", String(DEFAULT_GA.seeds))),
      elite: Number(arg("elite", String(DEFAULT_GA.elite))),
      sigma: Number(arg("sigma", String(DEFAULT_GA.sigma))),
    };
    state = initialState(cfg.genes, options, Number(arg("seed", "1")), loadParams(cfg));
    saveJson(join(dir, "config.json"), cfg);
    writeFileSync(join(dir, "log.jsonl"), "");
  }
  const hours = Number(arg("hours", "6"));
  const maxGen = Number(arg("generations", "1000"));
  const patience = Number(arg("patience", "15"));
  const sessionStart = Date.now();
  let stop = false;
  process.on("SIGINT", () => {
    if (stop) process.exit(130);
    stop = true;
    console.log(
      "\nStopping after this generation (Ctrl+C again to quit now; state is saved per generation).",
    );
  });
  const battlesPer = state.options.seeds * cfg.matchups.length;
  console.log(
    `GA: ${cfg.genes.length} genes, ${cfg.matchups.length} matchups, population ${state.options.population}, ${battlesPer} battles each → ${battlesPer * state.options.population} per generation, ${threads} threads, budget ${hours} h`,
  );
  for (;;) {
    const t0 = Date.now();
    const sets = state.population.map((i) => paramsOf(state, i));
    const evals = await evaluateMany(
      cfg,
      sets,
      seedsFor(state.generation + 1, state.options.seeds),
      runner(`gen ${state.generation}`),
    );
    const secs = (Date.now() - t0) / 1000;
    record(state, evals, battlesPer * sets.length, secs);
    const h = state.history[state.history.length - 1]!;
    const best = state.best;
    appendFileSync(
      join(dir, "log.jsonl"),
      JSON.stringify({
        ...h,
        population: state.population.map((i) => ({
          id: i.id,
          origin: i.origin,
          evals: i.evals,
          mean: meanLoss(i),
          last: i.last,
          params: paramsOf(state, i),
        })),
      }) + "\n",
    );
    if (best)
      saveJson(join(dir, "best.json"), {
        generation: state.generation,
        id: best.id,
        loss: meanLoss(best),
        evals: best.evals,
        params: paramsOf(state, best),
        changes: changes(cfg.genes, paramsOf(state, best)),
        last: best.last,
      });
    writeFileSync(join(dir, "report.html"), gaReport(state, cfg));
    console.log(
      `gen ${state.generation}: best this gen ${h.best.toFixed(3)} (#${h.bestId}), median ${h.median.toFixed(3)}, run best ${best ? `${meanLoss(best).toFixed(3)} (#${best.id}, ${best.evals} evals, in band ${best.last?.inBand}/${cfg.matchups.length})` : "–"}, σ ${h.sigma.toFixed(3)}, ${secs.toFixed(0)} s`,
    );
    const elapsedH = state.elapsed / 3600;
    const gens = state.history.length;
    const bestAt = state.history.reduce((a, x, i) => (x.best < state.history[a]!.best - 1e-9 ? i : a), 0);
    const stalled = gens - 1 - bestAt >= patience;
    const sessionH = (Date.now() - sessionStart) / 3.6e6;
    const reason = stop
      ? "interrupted"
      : sessionH + secs / 3600 > hours
        ? `time budget (${hours} h) reached`
        : state.generation + 1 >= maxGen
          ? "generation limit reached"
          : stalled
            ? `no improvement for ${patience} generations`
            : null;
    breed(state);
    saveJson(statePath, state);
    if (reason) {
      console.log(
        `Stopped: ${reason}. ${elapsedH.toFixed(2)} h total. Best: ${join(dir, "best.json")}, report: ${join(dir, "report.html")}`,
      );
      if (best) console.log(`Best params: ${changes(cfg.genes, paramsOf(state, best)).join(", ")}`);
      break;
    }
  }
}

function cmdReport() {
  const dir = runDir();
  const state = JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) as GaState;
  const cfg = JSON.parse(readFileSync(join(dir, "config.json"), "utf8")) as TuningConfig;
  writeFileSync(join(dir, "report.html"), gaReport(state, cfg));
  console.log(join(dir, "report.html"));
  if (state.best) {
    console.log(
      `best #${state.best.id}: loss ${meanLoss(state.best).toFixed(3)} over ${state.best.evals} measurements`,
    );
    for (const g of cfg.genes) {
      const v = paramsOf(state, state.best)[g.id]!;
      const bar = Math.round(toUnit(g, v) * 20);
      console.log(
        `  ${pad(g.id, 18)} ${pad(String(v), 10)} [${"-".repeat(bar)}|${"-".repeat(20 - bar)}] now ${currentValue(g)}`,
      );
    }
    console.log(`  medians: ${JSON.stringify(state.best.last?.medians)}`);
  }
}

function cmdApply() {
  let cfg = loadConfig();
  let p: Params;
  if (flag("run")) {
    const dir = runDir();
    cfg = JSON.parse(readFileSync(join(dir, "config.json"), "utf8")) as TuningConfig;
    p = (JSON.parse(readFileSync(join(dir, "best.json"), "utf8")) as { params: Params }).params;
  } else p = loadParams(cfg);
  const modelPath = join(root, "src/data/balance/model.ts");
  const catPath = join(root, "src/data/core/catalogue.json");
  const cat = validateCatalogue(JSON.parse(readFileSync(catPath, "utf8")));
  if (!cat.ok) throw new Error(cat.errors.join("\n"));
  const r = applyParams(cfg.genes, p, readFileSync(modelPath, "utf8"), cat.value);
  if (r.missing.length) throw new Error(`Cannot write: ${r.missing.join(", ")}`);
  writeFileSync(modelPath, r.model);
  writeFileSync(catPath, JSON.stringify(r.catalogue, null, 2) + "\n");
  execSync(`npx prettier --write "${catPath}" "${modelPath}"`, { stdio: "inherit", cwd: root });
  console.log(r.changes.join("\n"));
  console.log(
    "Applied. Next: npm run golden:update, then npm run check (tests that pin balance numbers may need updating).",
  );
}

const commands: Record<string, () => unknown> = {
  eval: cmdEval,
  sensitivity: cmdSensitivity,
  history: cmdHistory,
  ga: cmdGa,
  report: cmdReport,
  apply: cmdApply,
};
const fn = commands[command];
if (!fn) {
  console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0]);
  process.exit(command === "help" ? 0 : 1);
}
await fn();
