import type { ShipDesign } from "../data/schemas/design";
import type { AiProfile } from "../data/schemas/ai";
import { vec2 } from "../sim/core/vec2";
import type { PartCatalogue } from "../sim/ship/catalogue";
import { World } from "../sim/world";

/**
 * Balance harness (plan M7 task 6): fights designs against each other headless, AI against AI, and
 * reports win rates, time to kill and damage by weapon. Seeds alternate which side each design starts on
 * and which is added first, so neither spawn position nor id order favours a design.
 */

export interface MatchOptions {
  readonly profileA: AiProfile;
  readonly profileB: AiProfile;
  /** Start distance (m). */
  readonly distance?: number;
  /** Time limit (s); a battle still running then is a draw. */
  readonly timeLimit?: number;
  /** Square arena side (m). */
  readonly arena?: number;
}

export interface MatchResult {
  readonly a: string;
  readonly b: string;
  readonly seed: number;
  readonly winner: "a" | "b" | "draw";
  /** Battle length (s). */
  readonly time: number;
  /** Hull damage dealt by each side, by weapon part id. */
  readonly damageA: Readonly<Record<string, number>>;
  readonly damageB: Readonly<Record<string, number>>;
  /** Hull left at the end (fraction). */
  readonly hpA: number;
  readonly hpB: number;
}

const hull = (parts: readonly { hp: number; def: { def: { hp: number } } }[]) => {
  const max = parts.reduce((s, p) => s + p.def.def.hp, 0);
  return max > 0 ? parts.reduce((s, p) => s + Math.max(0, p.hp), 0) / max : 0;
};

export function runMatch(
  a: ShipDesign,
  b: ShipDesign,
  catalogue: PartCatalogue,
  droneDesigns: readonly ShipDesign[],
  seed: number,
  opts: MatchOptions,
): MatchResult {
  const dist = opts.distance ?? 3000;
  const limit = opts.timeLimit ?? 120;
  const side = opts.arena ?? 10_000;
  const w = new World({ seed, enforceDefeat: true });
  w.arena = { width: side, height: side };
  for (const d of droneDesigns) w.registerDesign(d);
  const flip = seed % 2 === 0; // alternate start sides and id order
  const spawn = (d: ShipDesign, left: boolean, team: number) =>
    w.addShip(d, catalogue, {
      position: vec2(left ? -dist / 2 : dist / 2, 0),
      angle: left ? 0 : Math.PI,
      team,
    });
  const [sa, sb] = flip
    ? (() => {
        const sb = spawn(b, true, 1);
        const sa = spawn(a, false, 0);
        return [sa, sb];
      })()
    : [spawn(a, true, 0), spawn(b, false, 1)];
  w.setAi(sa.id, opts.profileA);
  w.setAi(sb.id, opts.profileB);
  const ticks = Math.round(limit * 60);
  let t = 0;
  for (; t < ticks && !sa.defeated && !sb.defeated; t++) w.step();
  const winner = sa.defeated === sb.defeated ? "draw" : sb.defeated ? "a" : "b";
  return {
    a: a.id,
    b: b.id,
    seed,
    winner,
    time: t / 60,
    damageA: { ...(w.combat.damage[sa.id] ?? {}) },
    damageB: { ...(w.combat.damage[sb.id] ?? {}) },
    hpA: hull(sa.parts),
    hpB: hull(sb.parts),
  };
}

export interface DesignInfo {
  readonly id: string;
  readonly name: string;
  readonly cost: number;
  /** Weapon part ids (and hangars) aboard. */
  readonly weapons: readonly string[];
  /** Main weapon type: the weapon part (or hangar) carrying the most cost. */
  readonly primary: string;
  /** All part ids aboard. */
  readonly parts: readonly string[];
}

export function describeDesign(d: ShipDesign, catalogue: PartCatalogue): DesignInfo {
  const defs = d.parts.map((p) => catalogue.get(p.partId).def);
  const weapons = defs.filter((x) => (x.weapon && x.weapon.kind !== "pd") || x.hangar);
  const byCost = new Map<string, number>();
  for (const x of weapons) byCost.set(x.id, (byCost.get(x.id) ?? 0) + x.cost);
  const primary = [...byCost].sort((p, q) => q[1] - p[1] || (p[0] < q[0] ? -1 : 1))[0]?.[0] ?? "none";
  return {
    id: d.id,
    name: d.name,
    cost: defs.reduce((s, x) => s + x.cost, 0),
    weapons: [...new Set(weapons.map((x) => x.id))].sort(),
    primary,
    parts: [...new Set(defs.map((x) => x.id))].sort(),
  };
}

export interface PairResult {
  readonly a: string;
  readonly b: string;
  readonly games: number;
  readonly winsA: number;
  readonly winsB: number;
  readonly draws: number;
  /** Mean battle length of decisive games (s), or null. */
  readonly meanTime: number | null;
  readonly damageA: Readonly<Record<string, number>>;
  readonly damageB: Readonly<Record<string, number>>;
}

export interface DesignSummary {
  readonly id: string;
  readonly games: number;
  readonly wins: number;
  readonly losses: number;
  readonly draws: number;
  /** (wins + draws / 2) / games, mirror matches excluded. */
  readonly winRate: number;
  /** Mean time to kill in won games (s), or null. */
  readonly timeToKill: number | null;
  /** Damage dealt by weapon part id, summed over all games. */
  readonly damage: Readonly<Record<string, number>>;
}

export interface BalanceReport {
  readonly seeds: number;
  readonly profile: string;
  readonly designs: readonly DesignInfo[];
  readonly pairs: readonly PairResult[];
  readonly summary: readonly DesignSummary[];
  /** Win rate of row design against column design (wins + draws / 2), by id pair "a|b". */
  readonly vs: Readonly<Record<string, number>>;
}

const add = (into: Record<string, number>, from: Readonly<Record<string, number>>) => {
  for (const [k, v] of Object.entries(from)) into[k] = (into[k] ?? 0) + v;
};

/** Every design against every other (and itself, as a side-bias check), `seeds` battles each. */
export function runMatrix(
  designs: readonly ShipDesign[],
  catalogue: PartCatalogue,
  droneDesigns: readonly ShipDesign[],
  seeds: number,
  profile: AiProfile,
  opts: Partial<MatchOptions> = {},
  onProgress?: (done: number, total: number) => void,
): BalanceReport {
  const infos = designs.map((d) => describeDesign(d, catalogue));
  const pairs: PairResult[] = [];
  const total = ((designs.length * (designs.length + 1)) / 2) * seeds;
  let done = 0;
  for (let i = 0; i < designs.length; i++) {
    for (let j = i; j < designs.length; j++) {
      const da: Record<string, number> = {};
      const db: Record<string, number> = {};
      let winsA = 0;
      let winsB = 0;
      let draws = 0;
      let timeSum = 0;
      for (let s = 1; s <= seeds; s++) {
        const r = runMatch(designs[i]!, designs[j]!, catalogue, droneDesigns, s, {
          profileA: profile,
          profileB: profile,
          ...opts,
        });
        if (r.winner === "a") winsA++;
        else if (r.winner === "b") winsB++;
        else draws++;
        if (r.winner !== "draw") timeSum += r.time;
        add(da, r.damageA);
        add(db, r.damageB);
        onProgress?.(++done, total);
      }
      pairs.push({
        a: designs[i]!.id,
        b: designs[j]!.id,
        games: seeds,
        winsA,
        winsB,
        draws,
        meanTime: winsA + winsB > 0 ? timeSum / (winsA + winsB) : null,
        damageA: da,
        damageB: db,
      });
    }
  }
  const vs: Record<string, number> = {};
  for (const p of pairs) {
    vs[`${p.a}|${p.b}`] = (p.winsA + p.draws / 2) / p.games;
    vs[`${p.b}|${p.a}`] = (p.winsB + p.draws / 2) / p.games;
  }
  const summary: DesignSummary[] = infos.map((d) => {
    let wins = 0;
    let losses = 0;
    let draws = 0;
    let ttk = 0;
    let ttkN = 0;
    const damage: Record<string, number> = {};
    for (const p of pairs) {
      if (p.a === p.b) continue;
      const mine = p.a === d.id ? "a" : p.b === d.id ? "b" : null;
      if (!mine) continue;
      const w = mine === "a" ? p.winsA : p.winsB;
      wins += w;
      losses += mine === "a" ? p.winsB : p.winsA;
      draws += p.draws;
      if (p.meanTime !== null && w > 0) {
        ttk += p.meanTime * w;
        ttkN += w;
      }
      add(damage, mine === "a" ? p.damageA : p.damageB);
    }
    const games = wins + losses + draws;
    return {
      id: d.id,
      games,
      wins,
      losses,
      draws,
      winRate: games > 0 ? (wins + draws / 2) / games : 0,
      timeToKill: ttkN > 0 ? ttk / ttkN : null,
      damage,
    };
  });
  return { seeds, profile: profile.id, designs: infos, pairs, summary, vs };
}

export interface BalanceAnalysis {
  /** 7.6: non-chassis parts aboard more than `threshold` of the top designs. */
  readonly dominantParts: readonly { part: string; share: number }[];
  readonly topDesigns: readonly string[];
  /** 7.7: weapon types that never beat any opponent, or never lose to any (win rate vs > / < 0.5). */
  readonly noCounter: readonly string[];
  readonly neverWins: readonly string[];
  /** Designs with an overall win rate outside [low, high]. */
  readonly outliers: readonly { id: string; winRate: number }[];
  /** Largest side bias seen in mirror matches (|first-side win share − 0.5|), as a sanity check. */
  readonly ok: boolean;
}

export function analyze(
  r: BalanceReport,
  opts: { threshold?: number; topShare?: number; low?: number; high?: number } = {},
): BalanceAnalysis {
  const threshold = opts.threshold ?? 0.8;
  const low = opts.low ?? 0.2;
  const high = opts.high ?? 0.8;
  const ranked = [...r.summary].sort((a, b) => b.winRate - a.winRate || (a.id < b.id ? -1 : 1));
  const topN = Math.max(3, Math.ceil(ranked.length * (opts.topShare ?? 0.375)));
  const top = ranked.slice(0, topN).map((s) => s.id);
  const chassis = new Set(r.designs[0]?.parts ?? []);
  for (const d of r.designs) for (const p of [...chassis]) if (!d.parts.includes(p)) chassis.delete(p);
  const counts = new Map<string, number>();
  for (const id of top) {
    const d = r.designs.find((x) => x.id === id)!;
    for (const p of d.parts) if (!chassis.has(p)) counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  const dominantParts = [...counts]
    .map(([part, n]) => ({ part, share: n / top.length }))
    .filter((x) => x.share > threshold)
    .sort((a, b) => b.share - a.share || (a.part < b.part ? -1 : 1));
  const byType = new Map<string, string[]>();
  for (const d of r.designs) byType.set(d.primary, [...(byType.get(d.primary) ?? []), d.id]);
  const noCounter: string[] = [];
  const neverWins: string[] = [];
  for (const [type, ids] of [...byType].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const others = r.designs.filter((d) => !ids.includes(d.id)).map((d) => d.id);
    const rates = ids.flatMap((id) => others.map((o) => r.vs[`${id}|${o}`] ?? 0.5));
    if (!rates.some((x) => x < 0.5)) noCounter.push(type);
    if (!rates.some((x) => x > 0.5)) neverWins.push(type);
  }
  const outliers = r.summary
    .filter((s) => s.winRate < low || s.winRate > high)
    .map((s) => ({ id: s.id, winRate: s.winRate }));
  return {
    dominantParts,
    topDesigns: top,
    noCounter,
    neverWins,
    outliers,
    ok:
      dominantParts.length === 0 && noCounter.length === 0 && neverWins.length === 0 && outliers.length === 0,
  };
}

const short = (id: string) => id.replace(/^core:/, "").replace(/^drone:core:/, "drone:");

export function toCsv(r: BalanceReport): string {
  const sources = [
    ...new Set(r.pairs.flatMap((p) => [...Object.keys(p.damageA), ...Object.keys(p.damageB)])),
  ].sort();
  const head = [
    "a",
    "b",
    "games",
    "winsA",
    "winsB",
    "draws",
    "meanTime",
    ...sources.map((s) => `dmgA:${short(s)}`),
    ...sources.map((s) => `dmgB:${short(s)}`),
  ];
  const rows = r.pairs.map((p) =>
    [
      p.a,
      p.b,
      p.games,
      p.winsA,
      p.winsB,
      p.draws,
      p.meanTime === null ? "" : p.meanTime.toFixed(1),
      ...sources.map((s) => Math.round(p.damageA[s] ?? 0)),
      ...sources.map((s) => Math.round(p.damageB[s] ?? 0)),
    ].join(","),
  );
  return [head.join(","), ...rows].join("\n") + "\n";
}

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** Self-contained HTML report: win-rate heatmap, design summary, damage by weapon, checks 7.6 / 7.7. */
export function toHtml(r: BalanceReport, a: BalanceAnalysis, title = "Balance report"): string {
  const ids = r.designs.map((d) => d.id);
  const name = (id: string) => r.designs.find((d) => d.id === id)?.name ?? id;
  const cell = (v: number) => {
    const hue = Math.round(v * 120); // red → green
    return `<td style="background:hsl(${hue} 60% 30%)">${Math.round(v * 100)}%</td>`;
  };
  const heat = ids
    .map(
      (row) =>
        `<tr><th>${esc(name(row))}</th>${ids.map((col) => cell(r.vs[`${row}|${col}`] ?? 0.5)).join("")}</tr>`,
    )
    .join("");
  const sum = [...r.summary]
    .sort((x, y) => y.winRate - x.winRate)
    .map((s) => {
      const d = r.designs.find((x) => x.id === s.id)!;
      const total = Object.values(s.damage).reduce((t, v) => t + v, 0);
      const dmg = Object.entries(s.damage)
        .sort((p, q) => q[1] - p[1])
        .map(([k, v]) => `${esc(short(k))} ${Math.round((100 * v) / Math.max(1, total))}%`)
        .join(", ");
      return `<tr><td>${esc(d.name)}</td><td>${d.cost}</td><td>${Math.round(s.winRate * 100)}%</td><td>${s.wins}/${s.losses}/${s.draws}</td><td>${s.timeToKill === null ? "–" : s.timeToKill.toFixed(0) + " s"}</td><td>${esc(short(d.primary))}</td><td>${dmg || "–"}</td></tr>`;
    })
    .join("");
  const list = (xs: readonly string[]) => (xs.length ? xs.map((x) => esc(short(x))).join(", ") : "none");
  const checks = `<ul>
<li>${a.dominantParts.length ? "✗" : "✓"} 7.6 dominant parts (&gt; 80 % of top designs ${esc(a.topDesigns.map(name).join(", "))}): ${a.dominantParts.length ? a.dominantParts.map((d) => `${esc(short(d.part))} ${Math.round(d.share * 100)}%`).join(", ") : "none"}</li>
<li>${a.noCounter.length || a.neverWins.length ? "✗" : "✓"} 7.7 every weapon type wins at least once and loses at least once — never loses: ${list(a.noCounter)}; never wins: ${list(a.neverWins)}</li>
<li>${a.outliers.length ? "✗" : "✓"} overall win rate within 20–80 %: ${a.outliers.length ? a.outliers.map((o) => `${esc(name(o.id))} ${Math.round(o.winRate * 100)}%`).join(", ") : "all designs"}</li>
</ul>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
:root{--bg:#0b0d14;--fg:#d8e6f0;--dim:#7d8b99;--line:#26303d}
@media (prefers-color-scheme: light){:root{--bg:#f6f7f9;--fg:#1d2733;--dim:#5b6673;--line:#d4d9df}}
body{background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif;margin:0;padding:16px;max-width:1200px}
h1{font-size:20px}h2{font-size:16px;margin-top:28px}
table{border-collapse:collapse;margin:8px 0;font-variant-numeric:tabular-nums}
th,td{border:1px solid var(--line);padding:4px 8px;text-align:right}th{text-align:left;font-weight:600}
.heat td{color:#fff;min-width:44px;text-align:center}.dim{color:var(--dim)}
.wrap{overflow-x:auto}
</style></head><body>
<h1>${esc(title)}</h1>
<p class="dim">${r.designs.length} designs · ${r.seeds} battles per pairing (start sides alternate) · AI profile “${esc(r.profile)}” on both sides.</p>
<h2>Checks</h2>${checks}
<h2>Win rate (row vs column)</h2>
<div class="wrap"><table class="heat"><tr><th></th>${ids.map((id) => `<th>${esc(name(id).split(" (")[0]!)}</th>`).join("")}</tr>${heat}</table></div>
<p class="dim">The diagonal is the mirror match: it should sit near 50 %.</p>
<h2>Designs</h2>
<div class="wrap"><table><tr><th>Design</th><th>Cost</th><th>Win rate</th><th>W/L/D</th><th>Time to kill</th><th>Main weapon</th><th>Damage dealt by</th></tr>${sum}</table></div>
</body></html>
`;
}
