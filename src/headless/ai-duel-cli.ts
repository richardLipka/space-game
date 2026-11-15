/**
 * AI duels: identical fleets, AI parameter set A against B (docs/ai-types.md).
 *
 *   npm run ai:duel -- --a fleet-pass --b balanced [--fleet fleet-rapier,fleet-viper,fleet-wasp]
 *                      [--seeds 8] [--distance 6000] [--time 600] [--round 0] [--threads N]
 *   npm run ai:duel -- --a missile-wall --b balanced --tune [--iterations 20] [--params a,b,c] [--seed 1]
 *
 * --a / --b: an AI profile id or a JSON file with a full profile. Each seed is fought twice, A on each side.
 * --tune hill-climbs A's parameters against a fixed B; every accepted step is confirmed on fresh seeds, and
 * the best profile is written to balance-report/ai-duel/<name>.json.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { availableParallelism } from "node:os";
import { AI_PROFILES } from "../data/ai/index";
import type { AiProfile } from "../data/schemas/ai";
import { runJobs } from "./pool";
import { defaultParams, duelJobs, getParam, mutate, rng, summarize, type DuelOptions } from "./ai-duel";

const args = process.argv.slice(2);
const arg = (name: string, dflt: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined && !args[i + 1]!.startsWith("--") ? args[i + 1]! : dflt;
};
const flag = (name: string) => args.includes(`--${name}`);

function profileOf(ref: string): AiProfile {
  if (existsSync(ref)) return JSON.parse(readFileSync(ref, "utf8")) as AiProfile;
  const p = AI_PROFILES.get(ref);
  if (!p)
    throw new Error(`No AI profile "${ref}" (ids: ${[...AI_PROFILES.keys()].join(", ")}) and no such file`);
  return p;
}

const threads = Number(arg("threads", String(Math.max(1, availableParallelism() - 1))));
const fleet = arg("fleet", "fleet-rapier,fleet-viper,fleet-wasp").split(",");
const base: Omit<DuelOptions, "a" | "b"> = {
  fleet,
  seeds: Number(arg("seeds", "8")),
  distance: Number(arg("distance", "6000")),
  timeLimit: Number(arg("time", "600")),
  round: Number(arg("round", "0")),
};
const out = "balance-report/ai-duel";

async function duel(a: AiProfile, b: AiProfile, round = base.round ?? 0) {
  const o = { ...base, a, b, round };
  return summarize(await runJobs(duelJobs(o), threads), fleet.length);
}

const line = (name: string, r: Awaited<ReturnType<typeof duel>>) =>
  `${name.padEnd(24)} A ${r.winsA} : ${r.winsB} B (draws ${r.draws}) · score ${r.score.toFixed(3)} · lost A ${r.lostA.toFixed(2)} / B ${r.lostB.toFixed(2)} · ${r.length.toFixed(0)} s · firing A ${Math.round(r.fireA * 100)}% / B ${Math.round(r.fireB * 100)}% · missiles ${r.missiles.launched}/${r.missiles.down} down/${r.missiles.hits} hit`;

const a0 = profileOf(arg("a", "balanced"));
const b = profileOf(arg("b", "balanced"));
console.log(
  `Fleet ${fleet.join(", ")} · ${base.seeds} seeds × 2 sides · ${base.distance} m · ${threads} threads`,
);

if (!flag("tune")) {
  console.log(line(`${a0.id} vs ${b.id}`, await duel(a0, b)));
} else {
  const keys = arg("params", "") ? arg("params", "").split(",") : defaultParams(a0);
  const iterations = Number(arg("iterations", "20"));
  const random = rng(Number(arg("seed", "1")));
  let best = a0;
  let bestScore = (await duel(best, b)).score;
  console.log(`start ${bestScore.toFixed(3)} · tuning ${keys.join(", ")}`);
  for (let i = 1; i <= iterations; i++) {
    const cand = { ...mutate(best, keys, random), id: `${a0.id}-tuned`, name: `${a0.name} (tuned)` };
    const s = (await duel(cand, b)).score;
    // Accept only what holds up on fresh seeds too (one lucky round is not an improvement).
    const confirmed = s > bestScore ? (await duel(cand, b, 100 + i)).score : -Infinity;
    const accept = s > bestScore && confirmed > bestScore - 0.02;
    if (accept) {
      best = cand;
      bestScore = (s + confirmed) / 2;
    }
    const changed = keys
      .filter((k) => getParam(cand, k) !== getParam(a0, k))
      .map((k) => `${k} ${getParam(cand, k)}`)
      .join(", ");
    console.log(
      `${String(i).padStart(3)} ${s.toFixed(3)}${accept ? ` ✓ (fresh ${confirmed.toFixed(3)})` : ""}  ${changed}`,
    );
  }
  mkdirSync(out, { recursive: true });
  const file = join(out, `${best.id}.json`);
  writeFileSync(file, `${JSON.stringify(best, null, 2)}\n`);
  console.log(`best ${bestScore.toFixed(3)} → ${file}`);
  console.log(line("best vs B (fresh seeds)", await duel(best, b, 999)));
}
