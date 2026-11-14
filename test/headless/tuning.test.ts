import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { BALANCE, deriveCatalogue, hullPerMetre } from "../../src/data/balance/model";
import { validateCatalogue } from "../../src/data/validate";
import { HEAT } from "../../src/sim/systems/heat";
import { DEFAULT_CONFIG, configFrom, limitOf, type TuningConfig } from "../../src/headless/tuning/config";
import { bandError, evaluate, evaluateMany, jobsFor, matchupStats } from "../../src/headless/tuning/fitness";
import { references, viability } from "../../src/headless/tuning/viability";
import {
  checkGenes,
  currentValue,
  decode,
  encode,
  startParams,
  variant,
  type Gene,
} from "../../src/headless/tuning/genome";
import { breed, DEFAULT_GA, initialState, meanLoss, record } from "../../src/headless/tuning/ga";
import {
  applyParams,
  balanceChanges,
  formatNumber,
  rewriteModel,
  writtenBalance,
} from "../../src/headless/tuning/apply";
import { jitterSpawns, runJob } from "../../src/headless/jobs";
import type { Scenario } from "../../src/data/schemas/scenario";
import type { BattleMetrics } from "../../src/headless/observe";
import type { Evaluation } from "../../src/headless/tuning/fitness";

const root = new URL("../../", import.meta.url);
const catR = validateCatalogue(
  JSON.parse(readFileSync(new URL("src/data/core/catalogue.json", root), "utf8")),
);
if (!catR.ok) throw new Error(catR.errors.join("\n"));
const catalogue = catR.value;
const modelSrc = readFileSync(new URL("src/data/balance/model.ts", root), "utf8");
const genes = DEFAULT_CONFIG.genes;

const metric = (
  time: number,
  winner: BattleMetrics["winner"] = "a",
  reason = "incapacitated",
): BattleMetrics => ({
  time: time + 20,
  engagement: time,
  winner,
  reason: reason as BattleMetrics["reason"],
  ammoLeftA: 0.5,
  ammoLeftB: 0.5,
  missiles: { launched: 0, down: 0, hits: 0 },
  ships: [],
});

describe("tuning loss: activity and manoeuvring", () => {
  const ship = (alive: number, firing: number, moving: number) => ({
    design: "x",
    side: "a" as const,
    hot: 0,
    brownout: 0,
    alive,
    moving,
    firing,
    defeated: false,
    defeatReason: null,
    lost: {},
  });
  const m = DEFAULT_CONFIG.matchups.find((x) => x.id === "large-rapier")!;
  const at = (ships: ReturnType<typeof ship>[]) =>
    matchupStats(m, [{ ...metric(240), ships }], DEFAULT_CONFIG);

  it("busy ships cost nothing; idle, drifting or silent ships cost", () => {
    const busy = at([ship(200, 150, 180), ship(200, 120, 160)]);
    expect(busy.loss).toBeLessThan(0.01);
    const idle = at([ship(200, 5, 180), ship(200, 120, 160)]);
    expect(idle.passive).toBe(0.5);
    expect(idle.loss).toBeGreaterThan(busy.loss + 0.3);
    const drifting = at([ship(200, 150, 20), ship(200, 120, 30)]);
    expect(drifting.loss).toBeGreaterThan(busy.loss + 0.3);
  });

  it("a run stopped at the disabled-ship limit counts its length, not a timeout", () => {
    const g = DEFAULT_CONFIG.matchups.find((x) => x.id === "large-group")!;
    const s = matchupStats(g, [metric(220, "draw", "defeat-limit")], DEFAULT_CONFIG);
    expect(s.timeouts).toBe(0);
    expect(s.median).toBe(220);
  });
});

describe("tuning genome", () => {
  it("the default genes are valid and start at the game's current values", () => {
    expect(checkGenes(genes)).toEqual([]);
    const v = variant(genes, startParams(genes));
    expect(v.balance).toEqual(BALANCE);
    // Factors at 1 still name their weapons in the overlay, but change nothing.
    for (const rec of Object.values(v.overlay.weapons ?? {})) expect(rec.damage).toBe(1);
  });

  it("DNA round-trips through values (6 significant digits), and stays inside each range", () => {
    const p = startParams(genes);
    const back = decode(genes, encode(genes, p));
    for (const g of genes)
      expect(Math.abs(back[g.id]! - p[g.id]!), g.id).toBeLessThanOrEqual(Math.abs(p[g.id]!) * 1e-3 + 1e-9);
    const lo = decode(
      genes,
      genes.map(() => -1),
    );
    const hi = decode(
      genes,
      genes.map(() => 2),
    );
    for (const g of genes) {
      expect(lo[g.id]).toBe(g.min);
      expect(hi[g.id]).toBe(g.max);
    }
  });

  it("the default DNA holds exchange rates of the model, never single part values", () => {
    for (const g of genes) expect(g.target, g.id).toMatch(/^balance:[\w.]+$/);
    const p = { ...startParams(genes), pace: 9, hpArmor: 5, fuelHeat: 30_000, beam: 0.8 };
    const v = variant(genes, p);
    expect(v.balance.weapons.killTime).toBe(9);
    expect(v.balance.hp.armor).toBe(5);
    expect(v.balance.heat.perKgFuel).toBe(30_000);
    expect(v.balance.weapons.family.beam).toBe(0.8);
    expect(v.overlay).toEqual({});
    // The anchor is not a gene, and the game's table is untouched.
    expect(v.balance.hp.structure).toBe(BALANCE.hp.structure);
    expect(BALANCE.weapons.killTime).not.toBe(9);
  });

  it("still maps custom genes: factors on whole sections (after values set inside them) and overlay factors", () => {
    const custom: Gene[] = [
      { id: "all", target: "balance:hp.system.*", min: 0.1, max: 10 },
      { id: "reactorHp", target: "balance:hp.system.reactor", min: 0.1, max: 10 },
      { id: "dmg", target: "overlay:weapons.core:weapon.laser.turret.s.damage", min: 0.1, max: 10 },
    ];
    const v = variant(custom, { all: 2, reactorHp: 3, dmg: 1.5 });
    expect(v.balance.hp.system.engine).toBeCloseTo(BALANCE.hp.system.engine * 2, 9);
    expect(v.balance.hp.system.reactor).toBe(6);
    expect(v.overlay.weapons?.["core:weapon.laser.turret.s"]?.damage).toBe(1.5);
  });

  it("rejects genes with bad ranges, unknown paths and duplicates", () => {
    const bad: Gene[] = [
      { id: "a", target: "balance:heat.nope", min: 1, max: 2 },
      { id: "a", target: "balance:hp.*", min: 2, max: 1 },
      { id: "c", target: "balance:heat.perKgFuel", min: 0, max: 10, log: true },
      { id: "d", target: "whatever:x", min: 0, max: 1 },
    ];
    const e = checkGenes(bad).join("\n");
    expect(e).toMatch(/No number at balance path "heat.nope"/);
    expect(e).toMatch(/Duplicate gene "a"/);
    expect(e).toMatch(/min must be below max/);
    expect(e).toMatch(/log gene needs min > 0/);
    expect(e).toMatch(/unknown target/);
  });
});

describe("tuning battles", () => {
  it("a battle derives its catalogue from the parameters under test and restores the run-time values", () => {
    const cfg: TuningConfig = {
      ...DEFAULT_CONFIG,
      matchups: [{ id: "t", sides: [["fleet-wasp"], ["fleet-wasp"]], band: [5, 10], limit: 3 }],
    };
    const jobs = jobsFor(cfg, { ...startParams(genes), hullHeat: 0.02 }, [1]);
    expect(jobs).toHaveLength(1);
    const job = jobs[0]!;
    expect(job.kind === "skirmish" && job.timeLimit).toBe(3);
    expect(job.balance?.heat.hullTurretsPerMetre).toBe(0.02);
    const r = runJob(job);
    expect(r.kind).toBe("skirmish");
    expect(HEAT.hullRadiation).toBe(hullPerMetre(BALANCE));
  });

  it("spawn jitter is seeded: the same seed moves ships the same way, another seed differently", () => {
    const sc = {
      enemies: [{ designId: "x", aiProfile: "a", team: 1, spawn: { position: [100, 0], angle: 180 } }],
      playerSpawns: [{ position: [-100, 0], angle: 0 }],
    } as unknown as Scenario;
    const a = jitterSpawns(sc, 1, { position: 300, angle: 25 });
    const b = jitterSpawns(sc, 1, { position: 300, angle: 25 });
    const c = jitterSpawns(sc, 2, { position: 300, angle: 25 });
    expect(a).toEqual(b);
    expect(a.enemies[0]!.spawn).not.toEqual(c.enemies[0]!.spawn);
    const s = a.enemies[0]!.spawn;
    expect(Math.abs(s.position[0] - 100)).toBeLessThanOrEqual(300);
    expect(Math.abs(s.angle - 180)).toBeLessThanOrEqual(25);
    expect(sc.enemies[0]!.spawn.position).toEqual([100, 0]); // input untouched
  });

  it("matchup time limits leave room to close in and stop far-off fights early", () => {
    const m = DEFAULT_CONFIG.matchups.find((x) => x.id === "small-wasp")!;
    expect(limitOf(m, DEFAULT_CONFIG)).toBe(90 + 2 * m.band[1]);
    const big = DEFAULT_CONFIG.matchups.find((x) => x.id === "large-anvil")!;
    expect(limitOf(big, DEFAULT_CONFIG)).toBe(DEFAULT_CONFIG.timeLimit);
  });
});

describe("tuning loss", () => {
  const m = { id: "x", sides: [["a"], ["a"]] as const, band: [100, 200] as const, target: 150 };
  const cfg: TuningConfig = { ...DEFAULT_CONFIG, matchups: [m], loss: { ...DEFAULT_CONFIG.loss, drift: 0 } };

  it("band error is zero inside the band and grows with the log distance outside", () => {
    expect(bandError(150, [100, 200])).toBe(0);
    expect(bandError(50, [100, 200])).toBeCloseTo(Math.log(2));
    expect(bandError(400, [100, 200])).toBeCloseTo(Math.log(2));
  });

  it("scores a matchup on target near zero, too short or too long worse, timeouts worse still", () => {
    const at = matchupStats(
      m,
      [140, 150, 160].map((t) => metric(t)),
      cfg,
    );
    const short = matchupStats(
      m,
      [40, 50, 60].map((t) => metric(t)),
      cfg,
    );
    const long = matchupStats(
      m,
      [380, 400, 420].map((t) => metric(t)),
      cfg,
    );
    const timeouts = matchupStats(
      m,
      [0, 0, 0].map(() => metric(0, "draw", "timeout-stalemate")),
      cfg,
    );
    expect(at.inBand).toBe(true);
    expect(at.loss).toBeLessThan(0.01);
    expect(short.loss).toBeGreaterThan(0.5);
    expect(long.loss).toBeGreaterThan(0.5);
    expect(timeouts.median).toBe(limitOf(m, cfg));
    expect(timeouts.timeouts).toBe(1);
    expect(timeouts.loss).toBeGreaterThan(long.loss);
  });

  it("evaluates a parameter set from labelled battle results", () => {
    const results = [140, 150, 160].map((t, i) => ({
      kind: "skirmish" as const,
      job: jobsFor(cfg, startParams(genes), [i + 1])[0]!,
      result: { label: "p0|x", seed: i + 1, metrics: metric(t) },
    }));
    const e = evaluate(cfg, startParams(genes), results);
    expect(e.inBand).toBe(1);
    expect(e.matchups[0]!.battles).toBe(3);
    expect(e.loss).toBeLessThan(0.01);
  });

  it("drift pulls toward the starting values", () => {
    const c = { ...cfg, loss: { ...cfg.loss, drift: 1 } };
    const results = [
      {
        kind: "skirmish" as const,
        job: jobsFor(cfg, startParams(genes), [1])[0]!,
        result: { label: "p0|x", seed: 1, metrics: metric(150) },
      },
    ];
    const a = evaluate(c, startParams(genes), results);
    const b = evaluate(c, { ...startParams(genes), pace: 20 }, results);
    expect(a.parts.drift).toBe(0);
    expect(b.parts.drift).toBeGreaterThan(0.1);
  });

  it("a config file replaces the lists it gives and keeps the default loss weights it leaves out", () => {
    const c = configFrom({ seeds: 2, loss: { drift: 0 } as TuningConfig["loss"] });
    expect(c.seeds).toBe(2);
    expect(c.matchups).toBe(DEFAULT_CONFIG.matchups);
    expect(c.loss.drift).toBe(0);
    expect(c.loss.timeouts).toBe(DEFAULT_CONFIG.loss.timeouts);
  });
});

describe("tuning GA", () => {
  /** A fake evaluation: loss is the squared distance of the DNA from a hidden optimum. */
  const fake = (dna: readonly number[], opt: readonly number[]): Evaluation => ({
    params: {},
    loss: dna.reduce((s, x, i) => s + (x - opt[i]!) ** 2, 0),
    parts: {},
    matchups: [],
    inBand: 0,
    refused: [],
    margins: [],
  });

  it("finds a hidden optimum and is reproducible from its seed", () => {
    const run = () => {
      const s = initialState(genes, { ...DEFAULT_GA, population: 14 }, 7);
      const opt = genes.map((_, i) => (i % 3) / 3 + 0.1);
      const start = fake(s.population[0]!.dna, opt).loss;
      for (let g = 0; g < 40; g++) {
        record(
          s,
          s.population.map((i) => fake(i.dna, opt)),
          0,
          0,
        );
        breed(s);
      }
      return { s, start };
    };
    const a = run();
    const b = run();
    expect(meanLoss(a.s.best!)).toBeLessThan(a.start * 0.2);
    expect(a.s.best!.evals).toBeGreaterThanOrEqual(DEFAULT_GA.minEvals);
    expect(JSON.stringify(a.s)).toBe(JSON.stringify(b.s));
  });

  it("starts from the given parameters and keeps elites, re-measuring them", () => {
    const s = initialState(genes, DEFAULT_GA, 1, { ...startParams(genes), pace: 8 });
    expect(decode(genes, s.population[0]!.dna).pace).toBe(8);
    expect(s.population).toHaveLength(DEFAULT_GA.population);
    record(
      s,
      s.population.map((_, i) => fake([i / 100], [0])),
      0,
      0,
    );
    breed(s);
    const elites = s.population.filter((i) => i.origin === "elite");
    expect(elites).toHaveLength(DEFAULT_GA.elite);
    expect(elites.every((e) => e.evals === 1)).toBe(true);
    // Survives a JSON round trip (the saved state).
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
  });
});

describe("tuning apply", () => {
  it("writes changed numbers into the model source, keeping comments and layout", () => {
    const { text, missing } = rewriteModel(
      modelSrc,
      new Map([
        ["heat.perKgFuel", 30_000],
        ["hp.armor", 4.5],
        ["weapons.family.beam", 0.6],
        ["hp.system.reactor", 2.5],
        ["power.battery.chargeTime", 12],
      ]),
    );
    expect(missing).toEqual([]);
    expect(text).toContain("    perKgFuel: 30_000,");
    expect(text).toContain("    armor: 4.5,");
    expect(text).toContain("      beam: 0.6,");
    expect(text).toContain("      reactor: 2.5,");
    expect(text).toContain("      chargeTime: 12,");
    // density.armor is a different path and stays.
    expect(text).toContain("    armor: 160,");
    expect(text.split("\n").length).toBe(modelSrc.split("\n").length);
    expect(rewriteModel(modelSrc, new Map([["ammo.pd-20.interval", 1]])).missing).toEqual([
      "ammo.pd-20.interval",
    ]);
  });

  it("formats numbers like the source", () => {
    expect(formatNumber(200000)).toBe("200_000");
    expect(formatNumber(2500)).toBe("2500");
    expect(formatNumber(0.012)).toBe("0.012");
  });

  it("applying parameters writes every gene into the model and gives a catalogue it re-derives unchanged", () => {
    const p = {
      ...startParams(genes),
      pace: 9.3,
      hpArmor: 4.2,
      fuelHeat: 25_000,
      beam: 0.6,
      rangePrice: 0.3,
    };
    const r = applyParams(genes, p, modelSrc, catalogue);
    expect(r.missing).toEqual([]);
    expect(r.changes.join("\n")).toMatch(/heat\.perKgFuel: [\d.]+ → 25000/);
    // Every default gene's path can be written.
    const mid = Object.fromEntries(genes.map((g) => [g.id, Number(((g.min + g.max) / 2).toPrecision(4))]));
    const all = applyParams(genes, mid, modelSrc, catalogue);
    expect(all.missing).toEqual([]);
    expect(all.changes.length).toBe(genes.filter((g) => mid[g.id] !== currentValue(g)).length);
    // Slower pace: less damage everywhere.
    const ac = (c: typeof catalogue) =>
      c.parts.find((x) => x.id === "core:weapon.autocannon.turret.s")!.weapon!.projectile!.damage;
    expect(ac(r.catalogue) / ac(catalogue)).toBeCloseTo(BALANCE.weapons.killTime / 9.3, 2);
    // The written table, read back, derives exactly this catalogue (what the balance-model test checks).
    const reDerived = deriveCatalogue(r.catalogue, writtenBalance(balanceChanges(variant(genes, p).balance)));
    expect(reDerived).toEqual(r.catalogue);
  });
});

describe("tuning viability", () => {
  const cfg: TuningConfig = {
    ...DEFAULT_CONFIG,
    matchups: DEFAULT_CONFIG.matchups.filter((m) => ["small-spark", "large-rapier"].includes(m.id)),
  };

  it("today's values pass with no penalty; margins are the editor's power and cooling numbers", () => {
    const ref = references(cfg);
    expect([...ref.keys()]).toEqual(["fleet-rapier", "fleet-spark"]);
    const v = viability(cfg, startParams(cfg.genes), ref);
    expect(v.refused).toEqual([]);
    expect(v.penalty).toBeCloseTo(0, 9);
    for (const m of v.margins) expect(m.power).toBeGreaterThan(0);
    expect(HEAT.hullRadiation).toBe(hullPerMetre(BALANCE));
  });

  it("refuses a set that leaves designs without power, before any battle", async () => {
    const p = { ...startParams(cfg.genes), supply: 0.35 };
    const v = viability(cfg, p, references(cfg));
    expect(v.refused.join(" ")).toMatch(/power/);
    let ran = 0;
    const [e] = await evaluateMany(cfg, [p], [1], async (jobs) => {
      ran += jobs.length;
      return [];
    });
    expect(ran).toBe(0);
    expect(e!.refused.length).toBeGreaterThan(0);
    expect(e!.loss).toBeGreaterThanOrEqual(cfg.viability.refusedLoss);
  });
});
