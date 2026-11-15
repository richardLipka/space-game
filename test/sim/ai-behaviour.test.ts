import { describe, expect, it } from "vitest";
import catalogueJson from "../../src/data/core/catalogue.json";
import { validateCatalogue } from "../../src/data/validate";
import { aiProfile } from "../../src/data/ai/index";
import { BUNDLED_DESIGNS } from "../../src/data/designs/index";
import { PartCatalogue } from "../../src/sim/ship/catalogue";
import { World } from "../../src/sim/world";
import { capabilityProfile } from "../../src/sim/ai/capabilities";
import { AI_TUNING, createAiState, preferredRange, speedLimit } from "../../src/sim/ai/brain";
import { salvoDue } from "../../src/sim/ai/doctrine";
import { DRONE } from "../../src/sim/combat/constants";
import { observeBattle, salvoSync } from "../../src/headless/ai-observe";
import { commanderAi, crewRng, randomOfficer, suggestedAi } from "../../src/sim/crew/officers";
import type { Ship } from "../../src/sim/ship/ship-entity";

const r = validateCatalogue(catalogueJson);
if (!r.ok) throw new Error(r.errors.join("\n"));
const cat = PartCatalogue.fromJson(r.value);
const ship = (id: string) => new World({ seed: 1 }).addShip(BUNDLED_DESIGNS.get(id)!, cat);

describe("AI behaviour fixes (docs/ai-behaviour.md)", () => {
  it("speed requests stay within the top speed, and within what the fuel left allows", () => {
    const s = ship("fleet-rapier");
    const caps = capabilityProfile(s);
    const st = createAiState(s, aiProfile("sniper"), null);
    st.behaviour = "hold";
    expect(speedLimit(st, caps, false)).toBe(aiProfile("sniper").maxSpeed);
    st.behaviour = "evade";
    expect(speedLimit(st, caps, false)).toBeCloseTo(caps.deltaV * AI_TUNING.fuelSpeedShare, 6);
    // Dry tanks: only the minimum crawl is left.
    for (const p of s.parts) p.fuel = 0;
    expect(speedLimit(st, capabilityProfile(s), true)).toBe(AI_TUNING.fuelMinSpeed);
  });

  it("a gunless carrier stands off at drone range, also once its drones are out", () => {
    const s = ship("fleet-ark");
    const p = aiProfile("carrier");
    const caps = capabilityProfile(s);
    const want = Math.min(p.droneLaunchRange, DRONE.controlRange) * AI_TUNING.carrierStandoff * p.rangeFactor;
    expect(preferredRange(caps, p)).toBeCloseTo(want, 6);
    const launched = { ...caps, drones: { ...caps.drones, stored: 0 } };
    expect(preferredRange(launched, p)).toBeCloseTo(want, 6);
  });

  it("missile-line ships launch only in the first second of a salvo window", () => {
    const s = ship("fleet-viper");
    const st = createAiState(s, aiProfile("missile-wall"), null);
    const w = { tick: 12 * 60 * 3 + 10 } as World;
    expect(salvoDue(w, st)).toBe(true);
    expect(salvoDue({ tick: 12 * 60 * 3 + 90 } as World, st)).toBe(false);
    st.lastVolleyTick = w.tick;
    expect(salvoDue({ tick: 12 * 60 * 3 + 20 } as World, st)).toBe(false);
  });

  it("observed: the sniper fires and beats a weaker enemy; the missile wall launches together", () => {
    const sniper = observeBattle("sniper", "weaker", { seed: 2, timeLimit: 240 });
    expect(sniper.winner).not.toBe("enemy");
    expect(sniper.ownFiring).toBeGreaterThan(0.15);
    for (const sh of sniper.ships)
      expect(Math.max(...sh.speed)).toBeLessThan(aiProfile("sniper").maxSpeed * 1.25);
    const wall = observeBattle("missile-wall", "comparable", { seed: 1, timeLimit: 240 });
    expect(salvoSync(wall)).toBeGreaterThan(0.6);
  }, 120_000);
});

describe("formations and flip-and-burn", () => {
  it("a gunboat flip-and-burns to rest from low speed (RCS side push no longer loops it)", async () => {
    const { validateDesign } = await import("../../src/data/validate");
    const gun = (await import("../../src/data/designs/demo-gunboat.json")).default;
    const d = validateDesign(gun);
    if (!d.ok) throw new Error(d.errors.join());
    for (const ticks of [40, 70, 100]) {
      const w = new World({ seed: 1 });
      const s = w.addShip(d.value, cat);
      for (let i = 0; i < ticks; i++) {
        w.setIntent(s.id, { thrust: { x: 1, y: 0 }, rotate: 0 });
        w.step();
      }
      w.setIntent(s.id, { thrust: { x: 0, y: 0 }, rotate: 0, speedKill: "flip" });
      w.step();
      w.setIntent(s.id, { thrust: { x: 0, y: 0 }, rotate: 0 });
      for (let i = 0; i < 60 * 20 && s.flight.speedKill !== "off"; i++) w.step();
      expect(s.flight.speedKill).toBe("off");
      const v = w.physics.getBodyState(s.id).linearVelocity;
      expect(Math.hypot(v.x, v.y)).toBeLessThan(0.1);
    }
  });
});

describe("AI characters: ramming, escaping, kiting, officer AI", () => {
  const duel = (profile: string, own: string, foes: string[], gap: number) => {
    const w = new World({ seed: 1 });
    const me = w.addShip(BUNDLED_DESIGNS.get(own)!, cat, { position: { x: 0, y: 0 }, angle: 0 });
    for (const s of w.allShips())
      for (const p of s.parts) if (p.def.def.fuelTank) p.fuel = p.def.def.fuelTank.capacity;
    foes.forEach((id, i) => {
      const f = w.addShip(BUNDLED_DESIGNS.get(id)!, cat, {
        position: { x: gap, y: i * 300 },
        angle: Math.PI,
        team: 1,
      });
      w.setAi(f.id, aiProfile("balanced"));
    });
    w.setAi(me.id, aiProfile(profile));
    return { w, me, st: () => w.ai.get(me.id)! };
  };
  const dry = (s: Ship) => {
    for (const p of s.parts) p.ammo = 0;
  };

  it("out of ammunition: the aggressive AI rams, the others get away at full speed", () => {
    const a = duel("aggressive", "fleet-rapier", ["fleet-rapier"], 3000);
    dry(a.me);
    for (let i = 0; i < 60; i++) a.w.step();
    expect(a.st().behaviour).toBe("ram");
    const b = duel("balanced", "fleet-rapier", ["fleet-rapier"], 3000);
    dry(b.me);
    for (let i = 0; i < 60; i++) b.w.step();
    expect(b.st().behaviour).toBe("retreat");
    expect(b.st().retreatMode).toBe("escape");
  });

  it("cautious gets away from a far stronger force before it is in gun range", () => {
    const c = duel("cautious", "fleet-wasp", ["fleet-anvil", "fleet-anvil"], 3500);
    for (let i = 0; i < 60; i++) c.w.step();
    expect(c.st().behaviour).toBe("retreat");
    expect(c.st().retreatMode).toBe("escape");
    // The balanced AI does not: it fights.
    const b = duel("balanced", "fleet-wasp", ["fleet-anvil", "fleet-anvil"], 3500);
    for (let i = 0; i < 60; i++) b.w.step();
    expect(b.st().behaviour).not.toBe("retreat");
  });

  it("a kiter backs away from an enemy inside its range, guns on it", () => {
    const k = duel("kiter", "fleet-rapier", ["fleet-rapier"], 500);
    for (let i = 0; i < 40; i++) k.w.step();
    const st = k.st();
    expect(["hold", "face", "broadside"]).toContain(st.behaviour);
    expect(st.debug.desiredVel.x).toBeLessThan(0);
  });

  it("officers suggest an AI that suits their traits, and the commander's choice is used", () => {
    const base = randomOfficer(crewRng(5), "captain", "c1");
    const steady = {
      ...base,
      traits: ["steady-hand", "eagle-eye", "cool-head", "wasteful", "sloppy-loader"],
      strength: [3, 3, 3, 3, 3],
    };
    expect(suggestedAi(steady)).toBe("sniper");
    const nervous = {
      ...base,
      traits: ["tactician", "pd-ace", "quick-loader", "nervous", "timid-throttle"],
      strength: [1, 1, 1, 3, 3],
    };
    expect(suggestedAi(nervous)).toBe("cautious");
    const plain = {
      ...base,
      traits: ["reactor-whisperer", "quick-loader", "tactician", "wasteful", "sloppy-loader"],
      strength: [1, 1, 1, 1, 1],
    };
    expect(suggestedAi(plain)).toBe("balanced");
    const pilot = { ...base, id: "p1", position: "pilot" as const, ai: "aggressive" };
    expect(commanderAi([{ position: "pilot", officer: pilot }])).toBe("aggressive");
    expect(
      commanderAi([
        { position: "pilot", officer: pilot },
        { position: "captain", officer: { ...base, ai: "sniper" } },
      ]),
    ).toBe("sniper");
    expect(commanderAi([{ position: "captain", officer: base }])).toBeNull();
  });
});
