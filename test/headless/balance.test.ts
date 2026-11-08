import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import type { ShipDesign } from "../../src/data/schemas/design";
import { validateCatalogue, validateDesign } from "../../src/data/validate";
import { aiProfile } from "../../src/data/ai/index";
import { PartCatalogue } from "../../src/sim/ship/catalogue";
import { validateDesignLayout } from "../../src/editor/validate";
import {
  analyze,
  describeDesign,
  runMatch,
  runMatrix,
  toCsv,
  toHtml,
  type BalanceReport,
} from "../../src/headless/balance";

const data = new URL("../../src/data/", import.meta.url);
const json = (p: string): unknown => JSON.parse(readFileSync(new URL(p, data), "utf8"));
const catR = validateCatalogue(json("core/catalogue.json"));
if (!catR.ok) throw new Error(catR.errors.join("\n"));
const cat = PartCatalogue.fromJson(catR.value);
const design = (p: string): ShipDesign => {
  const r = validateDesign(json(p));
  if (!r.ok) throw new Error(r.errors.join("\n"));
  return r.value;
};
const drones = ["drone-attack", "drone-pd", "drone-decoy"].map((n) => design(`designs/${n}.json`));
const archetypes = readdirSync(new URL("designs/balance/", data))
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => design(`designs/balance/${f}`));
const balanced = aiProfile("balanced");

describe("balance harness", () => {
  it("the archetype roster is valid, similar in cost and covers each weapon type", () => {
    expect(archetypes.length).toBeGreaterThanOrEqual(8);
    const infos = archetypes.map((d) => describeDesign(d, cat));
    for (const d of archetypes) expect(validateDesignLayout(d, cat).errors, d.id).toBe(0);
    const costs = infos.map((i) => i.cost);
    expect(Math.max(...costs) / Math.min(...costs)).toBeLessThan(1.4);
    const primaries = new Set(infos.map((i) => i.primary));
    for (const w of [
      "core:weapon.cannon.fixed.m",
      "core:weapon.autocannon.turret.s",
      "core:weapon.cannon.turret.m",
      "core:weapon.laser.turret.s",
      "core:weapon.lance.fixed.m",
      "core:weapon.missile.launcher.s",
      "core:hangar.attack.m",
    ])
      expect(primaries.has(w), w).toBe(true);
  });

  it("a match is deterministic per seed, ends within the limit and credits damage to weapons", () => {
    const a = archetypes.find((d) => d.id === "arch-autocannon")!;
    const b = archetypes.find((d) => d.id === "arch-cannon")!;
    const opts = { profileA: balanced, profileB: balanced, timeLimit: 60 };
    const r1 = runMatch(a, b, cat, drones, 3, opts);
    const r2 = runMatch(a, b, cat, drones, 3, opts);
    expect(r2).toEqual(r1);
    expect(r1.time).toBeLessThanOrEqual(60);
    const dealt =
      Object.values(r1.damageA).reduce((s, v) => s + v, 0) +
      Object.values(r1.damageB).reduce((s, v) => s + v, 0);
    expect(dealt).toBeGreaterThan(0);
    for (const k of [...Object.keys(r1.damageA), ...Object.keys(r1.damageB)])
      expect(k).toMatch(/^(core:|drone:)/);
  });

  const synthetic = (): BalanceReport => {
    const mk = (id: string, parts: string[], primary: string) => ({
      id,
      name: id,
      cost: 100,
      weapons: [primary],
      primary,
      parts,
    });
    const chassis = ["core:command.s", "core:engine.main.s"];
    const designs = [
      mk("a", [...chassis, "core:x"], "core:wa"),
      mk("b", [...chassis, "core:x"], "core:wb"),
      mk("c", [...chassis, "core:x"], "core:wc"),
      mk("d", [...chassis, "core:y"], "core:wd"),
    ];
    const vs: Record<string, number> = {};
    const ids = designs.map((d) => d.id);
    // a beats everyone; d loses to everyone; b and c split.
    for (const x of ids) for (const y of ids) vs[`${x}|${y}`] = 0.5;
    for (const y of ["b", "c", "d"]) {
      vs[`a|${y}`] = 1;
      vs[`${y}|a`] = 0;
    }
    for (const x of ["b", "c"]) {
      vs[`${x}|d`] = 1;
      vs[`d|${x}`] = 0;
    }
    vs["b|c"] = 0.6;
    vs["c|b"] = 0.4;
    const winRate = (id: string) =>
      ids.filter((o) => o !== id).reduce((s, o) => s + vs[`${id}|${o}`]!, 0) / 3;
    return {
      seeds: 1,
      profile: "balanced",
      designs,
      pairs: [],
      vs,
      summary: ids.map((id) => ({
        id,
        games: 3,
        wins: 0,
        losses: 0,
        draws: 0,
        winRate: winRate(id),
        timeToKill: null,
        damage: {},
      })),
    };
  };

  it("7.6 / 7.7 analysis flags dominant parts, weapon types without a counter or a win, and outliers", () => {
    const a = analyze(synthetic());
    expect(a.topDesigns).toEqual(["a", "b", "c"]);
    expect(a.dominantParts).toEqual([{ part: "core:x", share: 1 }]); // chassis parts are ignored
    expect(a.noCounter).toEqual(["core:wa"]);
    expect(a.neverWins).toEqual(["core:wd"]);
    expect(a.outliers.map((o) => o.id).sort()).toEqual(["a", "d"]);
    expect(a.ok).toBe(false);
  });

  it("CSV and HTML reports carry every pairing and the checks", () => {
    const pair = archetypes.slice(0, 2);
    const r = runMatrix(pair, cat, drones, 1, balanced, { timeLimit: 30 });
    expect(r.pairs).toHaveLength(3); // a–a, a–b, b–b
    const csv = toCsv(r).trim().split("\n");
    expect(csv[0]).toMatch(/^a,b,games,winsA,winsB,draws,meanTime/);
    expect(csv).toHaveLength(4);
    const html = toHtml(r, analyze(r));
    expect(html).toContain("<title>Balance report</title>");
    expect(html).toContain("7.6 dominant parts");
    expect(html).toContain("7.7 every weapon type");
  });

  it.skipIf(!process.env.BALANCE)(
    "full matrix (BALANCE=1): checks 7.6 and 7.7 pass and no win-rate outliers",
    () => {
      const r = runMatrix(archetypes, cat, drones, Number(process.env.BALANCE_SEEDS ?? 4), balanced, {
        timeLimit: 90,
      });
      const a = analyze(r);
      console.log(
        [...r.summary]
          .sort((x, y) => y.winRate - x.winRate)
          .map((s) => `${s.id} ${Math.round(s.winRate * 100)}%`)
          .join(", "),
      );
      expect(a.dominantParts).toEqual([]);
      expect(a.noCounter).toEqual([]);
      expect(a.neverWins).toEqual([]);
      expect(a.outliers).toEqual([]);
    },
  );
});
