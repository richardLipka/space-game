import { AI_PROFILES } from "../data/ai/index";
import { observeBattle, shipMatchup, SIZES, type Size, type Strength } from "./ai-observe";

/**
 * `npm run ai:ships -- [profile ...] [--seed N] [--json]`: each AI profile flies a small, a medium and a large
 * ship against the balanced AI in a weaker, a comparable and a stronger setup (9 battles per profile), and
 * one line per battle summarises how it behaved (docs/ai-recommendations.md).
 */
const args = process.argv.slice(2);
const opt = (name: string, def: number) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : def;
};
const ids = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
const extra = args.includes("--extra") ? (args[args.indexOf("--extra") + 1] ?? "").split(",") : [];
const med = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]! : NaN);
for (const id of ids.length ? ids : [...AI_PROFILES.keys()]) {
  const sizes = SIZES[id] ?? SIZES.default!;
  const ships: [string, string][] = extra.length
    ? extra.map((d) => [d, d])
    : (["small", "medium", "large"] as Size[]).map((s) => [s, sizes[s]]);
  for (const [size, design] of ships)
    for (const strength of ["weaker", "comparable", "stronger"] as Strength[]) {
      const { matchup, enemyHull } = shipMatchup(id, design, strength);
      const b = observeBattle(id, strength, { seed: opt("seed", 1), timeLimit: 300, matchup, enemyHull });
      const s = b.ships[b.ships.length - 1]!;
      const total = Object.values(s.behaviour).reduce((a, x) => a + x, 0) || 1;
      const beh = Object.fromEntries(
        Object.entries(s.behaviour).map(([k, v]) => [k, Math.round((100 * v) / total)]),
      );
      const row = {
        profile: id,
        size,
        design,
        strength,
        winner: b.winner,
        time: Math.round(b.time),
        hull: Math.round(s.hull * 100),
        defeated: s.defeated,
        firing: Math.round(b.ownFiring * 100),
        range: Math.round(med(s.rangeRatio) * 100) / 100,
        nearest: Math.round(med(s.nearest)),
        speed: Math.round(med(s.speed)),
        maxSpeed: Math.round(Math.max(0, ...s.speed)),
        opening: Math.round(med(s.opening)),
        retreatAt: s.retreatAt === null ? null : Math.round(s.retreatAt * 100),
        beh,
      };
      console.log(JSON.stringify(row));
    }
}
