import { describe, expect, it } from "vitest";
import catalogueJson from "../../src/data/core/catalogue.json";
import { validateCatalogue } from "../../src/data/validate";
import { PartCatalogue } from "../../src/sim/ship/catalogue";
import { BUNDLED_DESIGNS, CORE_DRONES } from "../../src/data/designs/index";
import { World } from "../../src/sim/world";
import { angleOf, length, rotate, vec2 } from "../../src/sim/core/vec2";
import { capabilities } from "../../src/sim/flight/propulsion";
import { ARCADE, arcadeLimits } from "../../src/sim/flight/arcade";
import { wrapAngle } from "../../src/sim/flight/controller";
import { stanceProfile } from "../../src/data/ai/stances";
import type { Ship } from "../../src/sim/ship/ship-entity";

const r = validateCatalogue(catalogueJson);
if (!r.ok) throw new Error(r.errors.join("\n"));
const cat = PartCatalogue.fromJson(r.value);
const D = (id: string) => BUNDLED_DESIGNS.get(id)!;
const arcade = (seed = 1) => {
  const w = new World({ seed, enforceDefeat: true, flightModel: "arcade" });
  for (const d of CORE_DRONES) w.registerDesign(d);
  return w;
};
const limitsOf = (w: World, s: Ship) => {
  w.step();
  return arcadeLimits(s.massProps.mass, s.massProps.inertia, capabilities(s.propulsion.actuators));
};
const speed = (w: World, s: Ship) => length(w.physics.getBodyState(s.id).linearVelocity);
const seconds = (w: World, t: number) => w.run(Math.round(t * 60));

describe("arcade flight model", () => {
  it("heavier ships are slower and take longer to reach their top speed", () => {
    const ids = ["fleet-wasp", "fleet-rapier", "fleet-anvil", "fleet-leviathan"];
    const rows = ids.map((id) => {
      const w = arcade();
      const s = w.addShip(D(id), cat);
      const lim = limitsOf(w, s);
      return { id, mass: s.massProps.mass, top: lim.topSpeed, time: lim.topSpeed / lim.accel };
    });
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]!.mass, rows[i]!.id).toBeGreaterThan(rows[i - 1]!.mass);
      expect(rows[i]!.top, rows[i]!.id).toBeLessThan(rows[i - 1]!.top);
      expect(rows[i]!.time, rows[i]!.id).toBeGreaterThan(rows[i - 1]!.time);
    }
    for (const x of rows) {
      expect(x.top).toBeGreaterThanOrEqual(ARCADE.minSpeed);
      expect(x.top).toBeLessThanOrEqual(ARCADE.maxSpeed);
    }
  });

  it("forward held: speeds up to the top speed and stays there; released: comes to a stop", () => {
    const w = arcade();
    const s = w.addShip(D("fleet-rapier"), cat);
    const lim = limitsOf(w, s);
    w.setIntent(s.id, { thrust: vec2(1, 0), rotate: 0 });
    seconds(w, lim.topSpeed / lim.accel + 3);
    expect(speed(w, s)).toBeGreaterThan(lim.topSpeed * 0.97);
    seconds(w, 10);
    expect(speed(w, s)).toBeLessThan(lim.topSpeed * 1.02);
    w.setIntent(s.id, { thrust: vec2(0, 0), rotate: 0 });
    seconds(w, lim.topSpeed / lim.brake + 1.5);
    expect(speed(w, s)).toBeLessThan(0.5);
  });

  it("turning turns the direction of travel: the velocity follows the nose", () => {
    const w = arcade();
    const s = w.addShip(D("fleet-rapier"), cat);
    const lim = limitsOf(w, s);
    w.setIntent(s.id, { thrust: vec2(1, 0), rotate: 0 });
    seconds(w, lim.topSpeed / lim.accel + 2);
    // Turn left by a quarter circle while holding forward.
    w.setIntent(s.id, { thrust: vec2(1, 0), rotate: 0, faceAngle: Math.PI / 2 });
    seconds(w, Math.PI / 2 / lim.turnRate + 4);
    const b = w.physics.getBodyState(s.id);
    expect(Math.abs(wrapAngle(b.angle - Math.PI / 2))).toBeLessThan(0.05);
    expect(Math.abs(wrapAngle(angleOf(b.linearVelocity) - b.angle))).toBeLessThan(0.08);
    expect(length(b.linearVelocity)).toBeGreaterThan(lim.topSpeed * 0.9);
  });

  it("strafing slides sideways at the strafe speed; reverse is slower than forward", () => {
    const w = arcade();
    const s = w.addShip(D("fleet-rapier"), cat);
    const lim = limitsOf(w, s);
    w.setIntent(s.id, { thrust: vec2(0, 1), rotate: 0 });
    seconds(w, 15);
    const b = w.physics.getBodyState(s.id);
    const local = rotate(b.linearVelocity, -b.angle);
    expect(local.y).toBeGreaterThan(lim.strafeSpeed * 0.95);
    expect(local.y).toBeLessThan(lim.strafeSpeed * 1.02);
    expect(Math.abs(local.x)).toBeLessThan(1);
    w.setIntent(s.id, { thrust: vec2(-1, 0), rotate: 0 });
    seconds(w, 20);
    const back = rotate(w.physics.getBodyState(s.id).linearVelocity, -w.physics.getBodyState(s.id).angle);
    expect(back.x).toBeLessThan(-lim.reverseSpeed * 0.95);
    expect(back.x).toBeGreaterThan(-lim.reverseSpeed * 1.02);
  });

  it("rotation holds a steady turn rate and stops when released", () => {
    const w = arcade();
    const s = w.addShip(D("fleet-rapier"), cat);
    const lim = limitsOf(w, s);
    w.setIntent(s.id, { thrust: vec2(0, 0), rotate: 1 });
    seconds(w, 3);
    expect(w.physics.getBodyState(s.id).angularVelocity).toBeCloseTo(lim.turnRate, 1);
    w.setIntent(s.id, { thrust: vec2(0, 0), rotate: 0 });
    seconds(w, 2);
    expect(Math.abs(w.physics.getBodyState(s.id).angularVelocity)).toBeLessThan(0.01);
  });

  it("a ship that loses its engines slows down and cannot move itself", () => {
    const w = arcade();
    const s = w.addShip(D("fleet-rapier"), cat);
    const lim = limitsOf(w, s);
    w.setIntent(s.id, { thrust: vec2(1, 0), rotate: 0 });
    seconds(w, lim.topSpeed / lim.accel + 2);
    for (const p of s.parts) if (p.def.def.engine) s.destroyPart(p.uid);
    seconds(w, 20);
    expect(speed(w, s)).toBeLessThan(lim.topSpeed * 0.5);
  });

  it("burns fuel while accelerating and less while holding speed", () => {
    const w = arcade();
    const s = w.addShip(D("fleet-rapier"), cat);
    const lim = limitsOf(w, s);
    const f0 = s.totalFuel;
    w.setIntent(s.id, { thrust: vec2(1, 0), rotate: 0 });
    const t = lim.topSpeed / lim.accel;
    seconds(w, t);
    const accelBurn = (f0 - s.totalFuel) / t;
    seconds(w, 3);
    const f1 = s.totalFuel;
    seconds(w, 10);
    const cruiseBurn = (f1 - s.totalFuel) / 10;
    expect(accelBurn).toBeGreaterThan(0);
    expect(cruiseBurn).toBeGreaterThan(0);
    expect(cruiseBurn).toBeLessThan(accelBurn * 0.5);
  });

  it("the default model is newtonian: a ship keeps coasting after the thrust is released", () => {
    const w = new World({ seed: 1 });
    const s = w.addShip(D("fleet-rapier"), cat);
    w.setIntent(s.id, { thrust: vec2(1, 0), rotate: 0 });
    seconds(w, 5);
    const v = speed(w, s);
    w.setIntent(s.id, { thrust: vec2(0, 0), rotate: 0 });
    seconds(w, 5);
    expect(speed(w, s)).toBeCloseTo(v, 3);
  });

  it("the AI fights under the arcade model: a duel does damage and ships stay under their top speed", () => {
    const w = arcade(3);
    const a = w.addShip(D("fleet-rapier"), cat, { position: vec2(-1500, 0) });
    const b = w.addShip(D("fleet-rapier"), cat, { position: vec2(1500, 0), angle: Math.PI, team: 1 });
    w.setAi(a.id, stanceProfile("aggressive"));
    w.setAi(b.id, stanceProfile("cautious"));
    const lim = limitsOf(w, a);
    let fastest = 0;
    for (let i = 0; i < 60 * 120 && !a.defeated && !b.defeated; i++) {
      w.step();
      fastest = Math.max(fastest, speed(w, a), speed(w, b));
    }
    const dealt = (s: Ship) => Object.values(w.combat.damage[s.id] ?? {}).reduce((x, y) => x + y, 0);
    expect(dealt(a) + dealt(b)).toBeGreaterThan(500);
    // Recoil and hits may push a ship a little past its own top speed.
    expect(fastest).toBeLessThan(lim.topSpeed * 1.25);
  }, 120_000);
});
