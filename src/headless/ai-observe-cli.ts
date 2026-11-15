import { AI_PROFILES } from "../data/ai/index";
import { describe, MATCHUPS, observeBattle, salvoSync, type Strength } from "./ai-observe";

/**
 * `npm run ai:observe -- [profile ...] [--seed N] [--time S]`: observed battles of AI profiles (default:
 * all) against a weaker, a comparable and a stronger enemy, printed as behaviour summaries
 * (docs/ai-behaviour.md).
 */
const args = process.argv.slice(2);
const opt = (name: string, def: number) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : def;
};
const ids = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
const profiles = ids.length ? ids : [...AI_PROFILES.keys()].filter((id) => MATCHUPS[id]);
for (const id of profiles)
  for (const strength of ["weaker", "comparable", "stronger"] as Strength[]) {
    const b = observeBattle(id, strength, { seed: opt("seed", 1), timeLimit: opt("time", 360) });
    console.log(describe(b));
    if (id === "missile-wall") console.log(`  salvo sync ${(salvoSync(b) * 100).toFixed(0)} %`);
  }
