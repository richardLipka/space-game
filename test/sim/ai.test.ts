import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { performance } from "node:perf_hooks";
import type { ShipDesign } from "../../src/data/schemas/design";
import type { Scenario } from "../../src/data/schemas/scenario";
import { validateCatalogue, validateDesign } from "../../src/data/validate";
import { aiProfile, AI_PROFILES } from "../../src/data/ai/index";
import { PartCatalogue } from "../../src/sim/ship/catalogue";
import { World } from "../../src/sim/world";
import { type Vec2, angleOf, degToRad, length, sub, vec2 } from "../../src/sim/core/vec2";
import { Rng } from "../../src/sim/core/rng";
import { SIM_DT } from "../../src/sim/core/loop";
import { capabilityProfile } from "../../src/sim/ai/capabilities";
import { engagementRange, runAi, AI_TUNING } from "../../src/sim/ai/brain";
import { spawnMissile } from "../../src/sim/combat/missiles";
import { intercept } from "../../src/sim/combat/lead";
import { COMBAT } from "../../src/sim/combat/constants";
import { createWorldFromScenario } from "../../src/sim/scenario/setup";
import type { Ship } from "../../src/sim/ship/ship-entity";
import { design as fixtureDesign, PERF_RETRY, perfBudget, readFixture, testCatalogue } from "../helpers";

const read = (p: string): unknown =>
  JSON.parse(readFileSync(new URL(`../../src/data/${p}`, import.meta.url), "utf8"));
const catR = validateCatalogue(read("core/catalogue.json"));
if (!catR.ok) throw new Error(catR.errors.join("\n"));
const cat = PartCatalogue.fromJson(catR.value);
const design = (name: string): ShipDesign => {
  const r = validateDesign(read(`designs/${name}.json`));
  if (!r.ok) throw new Error(r.errors.join("\n"));
  return r.value;
};
const gunboat = design("demo-gunboat");
const frigate = design("demo-frigate");
const mule = design("demo-hauler");
/** Gunboat with its turrets removed: fixed cannon only. */
const fixedBoat: ShipDesign = {
  ...gunboat,
  id: "fixed-boat",
  parts: gunboat.parts.filter((p) => !["tur-l", "tur-r", "mag-a"].includes(p.uid)),
};
const balanced = aiProfile("balanced");

function newWorld(seed = 1): World {
  const w = new World({ seed, enforceDefeat: true });
  for (const n of ["drone-attack", "drone-pd", "drone-decoy"]) w.registerDesign(design(n));
  return w;
}
/** A target that cannot die, so behaviours can be watched for as long as needed. */
function invulnerable(ship: Ship): Ship {
  for (const p of ship.parts) p.hp = 1e9;
  return ship;
}
const dist = (w: World, a: string, b: string) =>
  length(sub(w.physics.getWorldCenter(a), w.physics.getWorldCenter(b)));
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

describe("M6 architecture", () => {
  it("6.1 AI code only produces intents and weapon commands: it never touches physics", () => {
    const dir = new URL("../../src/sim/ai/", import.meta.url);
    for (const f of readdirSync(dir)) {
      const src = readFileSync(new URL(f, dir), "utf8");
      expect(src, f).not.toMatch(/physics\.(apply|set|create|destroy|step|remove|add)/);
      expect(src, f).not.toMatch(/planck/);
      expect(src, f).not.toMatch(/setMassProps|applyForce|applyImpulse|applyTorque/);
    }
  });

  it("6.2 capability profile: main-only ship accelerates forward only; without its engine, not at all", () => {
    const w = new World({ seed: 1 });
    const s = w.addShip(fixtureDesign("main-only"), testCatalogue());
    const caps = capabilityProfile(s);
    expect(caps.accel.fwd).toBeGreaterThan(0);
    expect(caps.accel.left).toBe(0);
    expect(caps.accel.right).toBe(0);
    s.destroyPart("eng");
    expect(capabilityProfile(s).accel.fwd).toBe(0);
  });

  it("AI profiles load from data and differ in style", () => {
    expect([...AI_PROFILES.keys()].sort()).toEqual([
      "aggressive",
      "balanced",
      "brawler",
      "carrier",
      "kiter",
      "sniper",
    ]);
    expect(aiProfile("kiter").rangeFactor).toBeGreaterThan(aiProfile("brawler").rangeFactor);
  });
});

describe("M6 behaviours", () => {
  it("6.3 approach: an AI starting 5 km out settles at its preferred range ±15 %", () => {
    const w = newWorld();
    const a = w.addShip(gunboat, cat);
    const t = invulnerable(w.addShip(mule, cat, { position: vec2(5000, 0), team: 1 }));
    const st = w.setAi(a.id, balanced);
    w.run(60 * 70);
    const R = engagementRange(st);
    let sum = 0;
    for (let i = 0; i < 600; i++) {
      w.step();
      sum += dist(w, a.id, t.id);
    }
    expect(Math.abs(sum / 600 - R) / R).toBeLessThanOrEqual(0.15);
  });

  it("6.4 a fixed-weapon AI keeps its nose on the lead point (within the aim cone) ≥ 70 % of the engaged time", () => {
    const w = newWorld();
    const a = w.addShip(fixedBoat, cat);
    const t = invulnerable(w.addShip(mule, cat, { position: vec2(1500, 400), team: 1 }));
    w.setAi(a.id, balanced);
    const speed = cat.get("core:weapon.cannon.fixed.m").def.weapon!.projectile!.speed;
    let engaged = 0;
    let onTarget = 0;
    for (let i = 0; i < 60 * 40; i++) {
      w.step();
      const st = w.ai.get(a.id)!;
      if (st.behaviour !== "face" && st.behaviour !== "hold") continue;
      engaged++;
      const me = w.physics.getBodyState(a.id);
      const mp = w.physics.getWorldCenter(a.id);
      const tp = w.physics.getWorldCenter(t.id);
      const sol = intercept(mp, me.linearVelocity, tp, w.physics.getBodyState(t.id).linearVelocity, speed);
      if (Math.abs(wrap(angleOf(sub(sol?.aimPoint ?? tp, mp)) - me.angle)) <= COMBAT.fixedAimCone) onTarget++;
    }
    expect(engaged).toBeGreaterThan(600);
    expect(onTarget / engaged).toBeGreaterThanOrEqual(0.7);
  });

  it("6.5 a turret-heavy AI holds a broadside: turrets able to bear ≥ 80 % of the maximum", () => {
    const w = newWorld();
    const a = w.addShip(gunboat, cat);
    const t = invulnerable(w.addShip(mule, cat, { position: vec2(1200, 300), team: 1 }));
    w.setAi(a.id, balanced);
    const turrets = a.weapons.filter((x) => x.def.mount === "turret");
    let samples = 0;
    let bearing = 0;
    for (let i = 0; i < 60 * 40; i++) {
      w.step();
      if (w.ai.get(a.id)!.behaviour !== "broadside") continue;
      samples++;
      const me = w.physics.getBodyState(a.id);
      const b = angleOf(sub(w.physics.getWorldCenter(t.id), w.physics.getWorldCenter(a.id)));
      for (const x of turrets) {
        const rel = wrap(b - (me.angle + x.part.angle));
        const [a0, a1] = x.def.arc!.map(degToRad) as [number, number];
        if (rel >= a0 && rel <= a1 && !x.blocked.some(([lo, hi]) => rel >= lo && rel <= hi)) bearing++;
      }
    }
    expect(samples).toBeGreaterThan(600);
    expect(bearing / (samples * turrets.length)).toBeGreaterThanOrEqual(0.8);
  });

  it("6.6 an incoming missile triggers evasion within 0.5 s, and decoys go out", () => {
    const w = newWorld();
    const a = w.addShip(frigate, cat);
    const enemy = w.addShip(gunboat, cat, { position: vec2(6000, 0), angle: Math.PI, team: 1 });
    w.setAi(a.id, aiProfile("sniper"));
    w.run(5);
    const def = cat.get("core:weapon.missile.launcher.s").def.weapon!.missile!;
    spawnMissile(w, enemy, def, vec2(1500, 50), vec2(-1, 0), vec2(-300, 0), a.id);
    let evadedAt = -1;
    for (let i = 0; i < 60; i++) {
      w.step();
      if (evadedAt < 0 && w.ai.get(a.id)!.behaviour === "evade") evadedAt = i;
    }
    expect(evadedAt).toBeGreaterThanOrEqual(0);
    expect(evadedAt).toBeLessThanOrEqual(31);
    w.run(60);
    expect(w.allShips().some((s) => s.drone?.role === "decoy")).toBe(true);
  });

  it("6.7 cool down: above 70 % heat beams stop until heat is back under 50 %", () => {
    const beamer: ShipDesign = {
      ...gunboat,
      id: "beamer",
      parts: [
        { uid: "cmd", partId: "core:command.s", x: 0, y: 0, angle: 0 },
        { uid: "r", partId: "core:reactor.s", x: 0, y: 1.5, angle: 0 },
        { uid: "laser", partId: "core:weapon.laser.turret.s", x: 0, y: -1.443, angle: -90 },
        { uid: "tank", partId: "core:tank.fuel.s", x: -1.25, y: 0, angle: 0 },
        { uid: "eng", partId: "core:engine.main.s", x: -2.25, y: 0, angle: 0 },
      ],
    };
    const w = newWorld();
    const a = w.addShip(beamer, cat);
    w.addShip(mule, cat, { position: vec2(800, 0), team: 1 });
    const st = w.setAi(a.id, balanced);
    const heatTo = (lvl: number) => {
      a.heat = lvl * a.heatCapacity;
      st.nextEval = 0;
      w.step();
    };
    heatTo(0.75);
    expect(st.cooling).toBe(true);
    expect(a.weaponCommand.holdBeams).toBe(true);
    heatTo(0.6);
    expect(a.weaponCommand.holdBeams).toBe(true); // hysteresis
    heatTo(0.45);
    expect(a.weaponCommand.holdBeams).toBe(false);
  });

  it("6.8 retreat: below the hull threshold the AI moves away from the threat", () => {
    const w = newWorld();
    const a = w.addShip(gunboat, cat);
    const t = invulnerable(w.addShip(gunboat, cat, { position: vec2(1500, 0), angle: Math.PI, team: 1 }));
    w.setAi(a.id, balanced);
    w.run(30);
    // Everything but the engine and its tank shot to pieces: hull well under the 25 % retreat threshold.
    // The command module (and its gyro) at 30 %, so the ship can still turn away.
    for (const p of a.parts)
      if (p.def.def.command) p.hp = p.def.def.hp * 0.3;
      else if (!p.def.def.engine && !p.def.def.fuelTank) p.hp = Math.min(p.hp, 1);
    w.ai.get(a.id)!.nextEval = 0;
    w.step();
    expect(w.ai.get(a.id)!.behaviour).toBe("retreat");
    const d0 = dist(w, a.id, t.id);
    w.run(60 * 12); // a damaged gyro turns slowly before the engine can push away
    expect(dist(w, a.id, t.id)).toBeGreaterThan(d0 + 50);
  });

  it("6.9 asteroid and boundary avoidance: crossing a dense field rarely hits a rock and never leaves the arena", () => {
    const base = readFixture("scenarios/asteroid-field.json") as Scenario;
    let runsWithHits = 0;
    let exits = 0;
    const N = 12;
    for (let seed = 1; seed <= N; seed++) {
      const rng = new Rng(seed);
      const asteroids: Scenario["arena"]["asteroids"] = [];
      for (let i = 0; i < 40; i++) {
        const r = rng.range(15, 45);
        const n = 7;
        const outline = Array.from({ length: n }, (_, k) => {
          const a = (2 * Math.PI * k) / n;
          const rr = r * rng.range(0.75, 1);
          return [Math.round(rr * Math.cos(a) * 100) / 100, Math.round(rr * Math.sin(a) * 100) / 100] as [
            number,
            number,
          ];
        });
        asteroids.push({
          position: [rng.range(-1200, 1200), rng.range(-700, 700)],
          angle: 0,
          outline,
          static: true,
        });
      }
      const sc: Scenario = {
        ...base,
        arena: { ...base.arena, width: 4000, height: 3000, asteroids, gravityWells: [] },
      };
      const w = createWorldFromScenario(sc, { seed });
      const a = w.addShip(gunboat, cat, { position: vec2(-1800, 0) });
      const t = invulnerable(w.addShip(mule, cat, { position: vec2(1700, rng.range(-500, 500)), team: 1 }));
      w.setAi(a.id, aiProfile("aggressive"));
      let hit = false;
      for (let i = 0; i < 60 * 40; i++) {
        const tick = w.tick;
        w.step();
        if (w.combat.events.some((e) => e.kind === "collision" && e.tick === tick)) hit = true;
        const p = w.physics.getWorldCenter(a.id);
        if (Math.abs(p.x) > 2000 || Math.abs(p.y) > 1500) exits++;
      }
      void t;
      if (hit) runsWithHits++;
    }
    expect(exits).toBe(0);
    expect(runsWithHits / N).toBeLessThanOrEqual(0.25);
  });
});

describe("M6 combat", () => {
  it("6.10 each reference design kills a non-moving dummy within 90 s on every seed", () => {
    for (const d of [gunboat, frigate]) {
      for (let seed = 1; seed <= 5; seed++) {
        const w = newWorld(seed);
        const a = w.addShip(d, cat);
        const t = w.addShip(mule, cat, { position: vec2(3000, 600), angle: Math.PI, team: 1 });
        w.setAi(a.id, balanced);
        for (let i = 0; i < 60 * 90 && !t.defeated; i++) w.step();
        expect(t.defeated, `${d.id} seed ${seed}`).toBe(true);
      }
    }
  });

  const mirror = (seeds: number) => {
    let first = 0;
    let second = 0;
    let ended = 0;
    for (let seed = 1; seed <= seeds; seed++) {
      const w = newWorld(seed);
      const a = w.addShip(gunboat, cat);
      const b = w.addShip(gunboat, cat, { position: vec2(3000, 0), angle: Math.PI, team: 1 });
      w.setAi(a.id, balanced);
      w.setAi(b.id, balanced);
      for (let i = 0; i < 60 * 90 && !a.defeated && !b.defeated; i++) w.step();
      if (a.defeated || b.defeated) ended++;
      if (b.defeated && !a.defeated) first++;
      if (a.defeated && !b.defeated) second++;
    }
    return { first, second, ended };
  };

  it("6.11 mirror match (quick): no strong side bias, and nearly every battle ends in time", () => {
    const r = mirror(30);
    const decisive = r.first + r.second;
    expect(r.first / decisive).toBeGreaterThanOrEqual(0.25);
    expect(r.first / decisive).toBeLessThanOrEqual(0.75);
    expect(r.ended / 30).toBeGreaterThanOrEqual(0.9);
  });

  it.skipIf(!process.env.BALANCE)(
    "6.11 mirror match (200 seeds, BALANCE=1): win rate 40–60 %, ≥ 95 % end",
    () => {
      const r = mirror(200);
      const decisive = r.first + r.second;
      console.log("6.11 baseline", r);
      expect(r.first / decisive).toBeGreaterThanOrEqual(0.4);
      expect(r.first / decisive).toBeLessThanOrEqual(0.6);
      expect(r.ended / 200).toBeGreaterThanOrEqual(0.95);
    },
  );

  it("6.12 a kiter keeps a longer average range than a brawler with the same design", () => {
    const avgRange = (profile: string) => {
      const w = newWorld();
      const a = w.addShip(gunboat, cat);
      const t = invulnerable(w.addShip(mule, cat, { position: vec2(3000, 0), team: 1 }));
      w.setAi(a.id, aiProfile(profile));
      w.run(60 * 30);
      let sum = 0;
      for (let i = 0; i < 60 * 20; i++) {
        w.step();
        sum += dist(w, a.id, t.id);
      }
      return sum / (60 * 20);
    };
    expect(avgRange("kiter")).toBeGreaterThan(avgRange("brawler") * 1.3);
  });
});

describe("M6 allies and orders", () => {
  it("6.13 Tab switch: the new ship leaves AI control; the previous ship's AI acts on the same tick", () => {
    const w = newWorld();
    const a = w.addShip(gunboat, cat);
    const b = w.addShip(frigate, cat, { position: vec2(0, 100) });
    w.setAi(b.id, balanced, { kind: "follow", leader: a.id });
    w.step();
    // Switch: the player takes b, a goes to AI following b.
    w.clearAi(b.id);
    const st = w.setAi(a.id, balanced, { kind: "follow", leader: b.id });
    w.setIntent(b.id, { thrust: vec2(0, 0), rotate: 0 });
    w.step();
    expect(w.ai.has(b.id)).toBe(false);
    expect(st.behaviour).toBe("follow");
    expect(st.caps).not.toBeNull();
    expect(a.intent.faceAngle).toBeDefined();
  });

  it("6.14 orders: 'attack my target' → ally targets it within 0.5 s; 'hold' → ally stops and stays within 100 m", () => {
    const w = newWorld();
    const lead = w.addShip(gunboat, cat);
    const ally = w.addShip(gunboat, cat, { position: vec2(-80, 60), velocity: vec2(30, 0) });
    const t1 = invulnerable(w.addShip(mule, cat, { position: vec2(2500, 0), team: 1 }));
    const st = w.setAi(ally.id, balanced, { kind: "attack", target: t1.id });
    let tookAt = -1;
    for (let i = 0; i < 60; i++) {
      w.step();
      if (tookAt < 0 && st.targetId === t1.id) tookAt = i;
    }
    expect(tookAt).toBeGreaterThanOrEqual(0);
    expect(tookAt).toBeLessThanOrEqual(30);
    const point = w.physics.getWorldCenter(ally.id);
    st.order = { kind: "hold", point };
    st.targetId = null;
    w.addShip(gunboat, cat, { position: vec2(0, 0) }); // keep lead company; no armed enemy nearby
    let maxOff = 0;
    w.run(60 * 10);
    for (let i = 0; i < 60 * 10; i++) {
      w.step();
      maxOff = Math.max(maxOff, length(sub(w.physics.getWorldCenter(ally.id), point)));
    }
    void lead;
    expect(maxOff).toBeLessThanOrEqual(100);
    expect(length(w.physics.getBodyState(ally.id).linearVelocity)).toBeLessThan(5);
  });

  it("followers hold formation near their leader and ignore unarmed enemies", () => {
    const w = newWorld();
    const lead = w.addShip(gunboat, cat);
    const ally = w.addShip(gunboat, cat, { position: vec2(-300, 300) });
    w.addShip(mule, cat, { position: vec2(400, 0), team: 1 });
    const st = w.setAi(ally.id, balanced, { kind: "follow", leader: lead.id });
    w.run(60 * 30);
    expect(st.targetId).toBeNull();
    expect(st.behaviour).toBe("follow");
    expect(dist(w, ally.id, lead.id)).toBeLessThan(200);
  });
});

describe("M6 performance and determinism", () => {
  it("6.15 an AI-vs-AI battle has an identical hash on two runs", () => {
    const run = () => {
      const w = newWorld(3);
      const a = w.addShip(gunboat, cat);
      const b = w.addShip(frigate, cat, { position: vec2(3000, 400), angle: Math.PI, team: 1 });
      w.setAi(a.id, aiProfile("aggressive"));
      w.setAi(b.id, aiProfile("kiter"));
      w.run(60 * 20);
      return w.hash();
    };
    expect(run()).toBe(run());
  });

  it("6.16 10 AI ships cost under 1 ms of AI per tick on average", PERF_RETRY, () => {
    const w = newWorld();
    for (let i = 0; i < 10; i++) {
      const s = w.addShip(i % 2 ? frigate : gunboat, cat, {
        position: vec2((i % 5) * 300, i < 5 ? 0 : 3000),
        angle: i < 5 ? Math.PI / 2 : -Math.PI / 2,
        team: i < 5 ? 0 : 1,
      });
      w.setAi(s.id, balanced);
    }
    w.run(60);
    // Time the AI alone (the world runs it inside step; here it is called twice per tick on the same state).
    let total = 0;
    const ticks = 300;
    for (let i = 0; i < ticks; i++) {
      w.step();
      for (const st of w.ai.values()) st.nextEval = Math.min(st.nextEval, w.tick + (i % 30 === 0 ? 0 : 30));
      const t0 = performance.now();
      runAi(w, SIM_DT);
      total += performance.now() - t0;
    }
    const ms = total / ticks;
    console.log(`AI for 10 ships: ${ms.toFixed(3)} ms/tick`);
    expect(ms).toBeLessThan(perfBudget(1));
    expect(AI_TUNING.evalInterval).toBe(0.5);
  });
});

// Keeps helpers referenced for readers comparing designs.
export const _designs = { gunboat, frigate, fixedBoat } as Record<string, ShipDesign>;
export type _V = Vec2;
