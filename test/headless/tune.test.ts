import { describe, expect, it } from "vitest";
import catalogueJson from "../../src/data/core/catalogue.json";
import { validateCatalogue } from "../../src/data/validate";
import { applyOverlay, catalogueDiff, validateOverlay } from "../../src/data/balance/overlay";
import { runJob, type Job } from "../../src/headless/jobs";
import { runJobs } from "../../src/headless/pool";
import {
  DEFAULT_TARGETS,
  GUARDRAILS,
  adjust,
  converged,
  engagementOf,
  wilson,
  type IterationStats,
} from "../../src/headless/tune";

const r = validateCatalogue(catalogueJson);
if (!r.ok) throw new Error(r.errors.join("\n"));
const base = r.value;
const byId = (cat: typeof base, id: string) => cat.parts.find((p) => p.id === id)!;
const gun = base.parts.find((p) => p.weapon?.projectile && p.weapon.internalMagazine > 0)!;
const beam = base.parts.find((p) => p.weapon?.beam)!;
const command = base.parts.find((p) => p.category === "command")!;
const magazine = base.parts.find((p) => p.magazine)!;

const stats = (over: Partial<IterationStats> = {}): IterationStats => ({
  battles: 100,
  medianEngagement: 150,
  medianDuel: 150,
  medianScenario: 150,
  timeouts: 0,
  ammoOut: 0,
  commandShare: 0.3,
  weapons: {},
  throttle: {},
  scenarios: {},
  reasons: {},
  draws: [],
  ...over,
});

describe("balance overlay", () => {
  it("an empty overlay changes nothing", () => {
    expect(catalogueDiff(base, applyOverlay(base, {}))).toEqual([]);
  });

  it("scales HP, ammunition, damage, power and heat, and lists the changes", () => {
    const o = {
      global: { hp: 2, ammo: 1.5 },
      category: { command: { hp: 1.5 } },
      weapons: { [gun.id]: { damage: 0.5 }, [beam.id]: { powerDraw: 0.8, heat: 0.8 } },
    };
    expect(validateOverlay(o).ok).toBe(true);
    const t = applyOverlay(base, o);
    expect(byId(t, gun.id).hp).toBe(Math.round(gun.hp * 2));
    expect(byId(t, command.id).hp).toBe(Math.round(command.hp * 3));
    expect(byId(t, magazine.id).magazine!.capacity).toBe(Math.round(magazine.magazine!.capacity * 1.5));
    expect(byId(t, gun.id).weapon!.internalMagazine).toBe(Math.round(gun.weapon!.internalMagazine * 1.5));
    expect(byId(t, gun.id).weapon!.projectile!.damage).toBeCloseTo(gun.weapon!.projectile!.damage * 0.5, 1);
    const pd = beam.weapon!.powerDraw ?? beam.weapon!.powerPerShot!;
    const pt = byId(t, beam.id).weapon!.powerDraw ?? byId(t, beam.id).weapon!.powerPerShot!;
    expect(pt).toBeCloseTo(pd * 0.8, 0);
    // The input catalogue is untouched.
    expect(byId(base, gun.id).hp).toBe(gun.hp);
    const diff = catalogueDiff(base, t);
    expect(diff.some((d) => d.startsWith(`${command.id} hp:`))).toBe(true);
    expect(diff.some((d) => d.startsWith(`${gun.id} weapon.projectile.damage:`))).toBe(true);
  });

  it("ammunition and fuel are mass-neutral: same full-magazine mass, longer burn at the same thrust", () => {
    const t = applyOverlay(base, { global: { ammo: 4, fuel: 2 } });
    for (const p of base.parts.filter((x) => x.magazine)) {
      const m = byId(t, p.id).magazine!;
      const ratio = (m.capacity * m.massPerRound) / (p.magazine!.capacity * p.magazine!.massPerRound);
      expect(Math.abs(ratio - 1), p.id).toBeLessThan(0.01); // rounding only
    }
    const eng = base.parts.find((p) => p.engine)!;
    expect(byId(t, eng.id).engine!.thrust).toBe(eng.engine!.thrust);
    expect(byId(t, eng.id).engine!.isp).toBeCloseTo(eng.engine!.isp * 2, 1);
    const tank = base.parts.find((p) => p.fuelTank)!;
    expect(byId(t, tank.id).fuelTank!.capacity).toBe(tank.fuelTank!.capacity);
  });

  it("rejects unknown fields and non-positive factors", () => {
    expect(validateOverlay({ global: { speed: 2 } }).ok).toBe(false);
    expect(validateOverlay({ global: { hp: 0 } }).ok).toBe(false);
  });
});

describe("tuning rules", () => {
  it("Wilson interval brackets the rate and narrows with games", () => {
    const [a, b] = wilson(6, 10);
    expect(a).toBeLessThan(0.6);
    expect(b).toBeGreaterThan(0.6);
    const [c, d] = wilson(60, 100);
    expect(d - c).toBeLessThan(b - a);
  });

  it("short fights raise HP, ammunition follows and fuel follows its square root", () => {
    const { overlay, notes } = adjust({}, stats({ medianEngagement: 30 }));
    const k = Math.pow(5, 0.8);
    expect(overlay.global!.hp).toBeCloseTo(k, 2);
    expect(overlay.global!.ammo).toBeCloseTo(k, 2);
    expect(overlay.global!.fuel).toBeCloseTo(Math.sqrt(k), 2);
    expect(notes[0]).toMatch(/^pace/);
  });

  it("long fights lower HP within the guardrails; on-target pace changes nothing", () => {
    expect(adjust({}, stats({ medianEngagement: 1500 })).overlay.global!.hp).toBeGreaterThanOrEqual(
      GUARDRAILS.pace[0],
    );
    expect(adjust({}, stats({ medianEngagement: 900 })).overlay.global!.hp).toBeLessThan(1);
    expect(adjust({}, stats()).overlay.global?.hp).toBeUndefined();
  });

  it("weapon damage moves only for clear, significant outliers and by at most one step", () => {
    const s = stats({
      weapons: {
        strong: { games: 100, winRate: 0.8, ci: wilson(80, 100) },
        weak: { games: 100, winRate: 0.2, ci: wilson(20, 100) },
        noisy: { games: 6, winRate: 0.7, ci: wilson(4.2, 6) },
        fine: { games: 100, winRate: 0.55, ci: wilson(55, 100) },
      },
    });
    const w = adjust({}, s).overlay.weapons!;
    expect(w.strong!.damage).toBeLessThan(1);
    expect(w.strong!.damage).toBeGreaterThanOrEqual(1 - GUARDRAILS.step);
    expect(w.weak!.damage).toBeGreaterThan(1);
    expect(w.weak!.damage).toBeLessThanOrEqual(1 + GUARDRAILS.step);
    expect(w.noisy).toBeUndefined();
    expect(w.fine).toBeUndefined();
  });

  it("energy, command HP and ammunition rules", () => {
    const { overlay } = adjust(
      {},
      stats({ throttle: { hot: 0.5, cold: 0, ok: 0.1 }, commandShare: 0.8, ammoOut: 0.3 }),
    );
    expect(overlay.weapons!.hot).toEqual({ powerDraw: 0.9, heat: 0.9 });
    expect(overlay.weapons!.cold).toEqual({ powerDraw: 1.05, heat: 1.05 });
    expect(overlay.weapons!.ok).toBeUndefined();
    expect(overlay.category!.command!.hp).toBeCloseTo(1.15);
    expect(overlay.global!.ammo).toBeCloseTo(1.25);
  });

  it("stalemates lower armor HP", () => {
    const { overlay } = adjust({}, stats({ reasons: { "timeout-stalemate": 10 } }));
    expect(overlay.category!.armor!.hp).toBeCloseTo(0.9);
    expect(adjust({}, stats({ reasons: { "timeout-stalemate": 2 } })).overlay.category).toBeUndefined();
  });

  it("converged needs pace, win rates, timeouts and ammunition all in range", () => {
    expect(converged(stats())).toBe(true);
    expect(converged(stats({ medianEngagement: 40 }))).toBe(false);
    expect(converged(stats({ timeouts: DEFAULT_TARGETS.maxTimeouts + 0.01 }))).toBe(false);
    expect(converged(stats({ weapons: { x: { games: 50, winRate: 0.8, ci: wilson(40, 50) } } }))).toBe(false);
  });
});

describe("battle jobs", () => {
  const jobs: Job[] = [
    {
      kind: "match",
      a: "arch-cannon",
      b: "arch-laser",
      seed: 1,
      profile: "balanced",
      timeLimit: 600,
      overlay: {},
    },
    {
      kind: "match",
      a: "arch-cannon",
      b: "arch-laser",
      seed: 1,
      profile: "balanced",
      timeLimit: 600,
      overlay: { global: { hp: 0.5 } },
    },
    {
      kind: "scenario",
      scenario: "s02-fixed-or-turret",
      seed: 1,
      profile: "balanced",
      timeLimit: 300,
      overlay: {},
    },
  ];

  it("records battle metrics; halving HP makes the duel shorter", () => {
    const [a, b] = jobs.slice(0, 2).map(runJob);
    const m = a!.result.metrics;
    // Engagement runs from the first hull hit; a single shell that sets off a store can end it at once.
    expect(m.engagement).toBeGreaterThanOrEqual(0);
    expect(m.engagement).toBeLessThanOrEqual(m.time);
    expect(engagementOf(m)).toBeGreaterThan(0);
    expect(m.ships).toHaveLength(2);
    expect(["a", "b", "draw"]).toContain(m.winner);
    expect(b!.result.metrics.time).toBeLessThan(m.time);
    const s = runJob(jobs[2]!);
    expect(s.kind).toBe("scenario");
    if (s.kind === "scenario")
      expect(s.result.metrics.winner).toBe(
        s.result.status === "won" ? "a" : s.result.status === "lost" ? "b" : "draw",
      );
  });

  it("worker threads give the same results as running in this thread", async () => {
    const serial = await runJobs(jobs, 1);
    const parallel = await runJobs(jobs, 3);
    expect(JSON.stringify(parallel.map((x) => x.result))).toBe(JSON.stringify(serial.map((x) => x.result)));
  }, 120_000);
});
