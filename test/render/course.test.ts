import { describe, expect, it } from "vitest";
import catalogueJson from "../../src/data/core/catalogue.json";
import { validateCatalogue } from "../../src/data/validate";
import { PartCatalogue } from "../../src/sim/ship/catalogue";
import { BUNDLED_DESIGNS } from "../../src/data/designs/index";
import { World } from "../../src/sim/world";
import { type Vec2, length, sub, vec2 } from "../../src/sim/core/vec2";
import type { ControlIntent } from "../../src/sim/flight/controller";
import type { FlightModel } from "../../src/sim/flight/arcade";
import { COURSE, predictCourse } from "../../src/render/course";

const r = validateCatalogue(catalogueJson);
if (!r.ok) throw new Error(r.errors.join("\n"));
const cat = PartCatalogue.fromJson(r.value);
const rapier = BUNDLED_DESIGNS.get("fleet-rapier")!;

/**
 * Flies a ship with a fixed intent for `settle` seconds, takes the predicted course, flies on for the
 * horizon and returns how far the prediction was from where the ship really went (m), at each second,
 * together with the distance really travelled.
 */
function check(opts: {
  model?: FlightModel;
  intent: ControlIntent;
  settle: number;
  velocity?: Vec2;
  well?: boolean;
  /** Released after settling (the prediction is then made for the new intent). */
  then?: ControlIntent;
}): { error: number[]; travelled: number } {
  const w = new World({ seed: 1, flightModel: opts.model ?? "newtonian" });
  if (opts.well) w.addGravityWell({ position: vec2(0, -3000), mu: 4e8, softening: 10, coreRadius: 50 });
  const s = w.addShip(rapier, cat, opts.velocity ? { velocity: opts.velocity } : {});
  w.setIntent(s.id, opts.intent);
  w.run(Math.round(opts.settle * 60));
  if (opts.then) {
    w.setIntent(s.id, opts.then);
    w.step();
  }
  const start = w.physics.getWorldCenter(s.id);
  const predicted = predictCourse(w, s);
  const error: number[] = [];
  const perSecond = Math.round(1 / COURSE.step);
  for (let t = 1; t <= COURSE.horizon; t++) {
    w.run(60);
    error.push(length(sub(w.physics.getWorldCenter(s.id), predicted[t * perSecond]!)));
  }
  return { error, travelled: length(sub(w.physics.getWorldCenter(s.id), start)) };
}

const worst = (e: number[]) => Math.max(...e);

describe("projected course (movement predictor)", () => {
  it("returns one point per step, starting at the ship", () => {
    const w = new World({ seed: 1 });
    const s = w.addShip(rapier, cat, { position: vec2(100, -50) });
    w.step();
    const pts = predictCourse(w, s);
    expect(pts).toHaveLength(Math.round(COURSE.horizon / COURSE.step) + 1);
    expect(length(sub(pts[0]!, w.physics.getWorldCenter(s.id)))).toBeLessThan(1e-9);
  });

  it("newtonian, coasting: exact", () => {
    const { error, travelled } = check({
      intent: { thrust: vec2(0, 0), rotate: 0 },
      settle: 1,
      velocity: vec2(80, 30),
    });
    expect(travelled).toBeGreaterThan(800);
    expect(worst(error)).toBeLessThan(0.01);
  });

  it("newtonian, constant thrust: within 1 % of the distance over 10 s", () => {
    const { error, travelled } = check({ intent: { thrust: vec2(1, 0), rotate: 0 }, settle: 2 });
    expect(travelled).toBeGreaterThan(500);
    // The ship gets lighter as it burns fuel, so it ends a little ahead of the prediction.
    expect(worst(error)).toBeLessThan(travelled * 0.01);
  });

  it("newtonian, thrust and strafe in a gravity well: within 2 %", () => {
    const { error, travelled } = check({
      intent: { thrust: vec2(1, 0.5), rotate: 0 },
      settle: 2,
      velocity: vec2(0, 40),
      well: true,
    });
    expect(worst(error)).toBeLessThan(travelled * 0.02);
  });

  it("newtonian, thrusting while turning: the thrust turns with the ship (within 3 %)", () => {
    const { error, travelled } = check({ intent: { thrust: vec2(1, 0), rotate: 0.3 }, settle: 3 });
    expect(worst(error)).toBeLessThan(travelled * 0.03);
  });

  it("newtonian, speed kill: predicts the stop, not a reversal", () => {
    const w = new World({ seed: 1 });
    const s = w.addShip(rapier, cat, { velocity: vec2(60, 0) });
    w.setIntent(s.id, { thrust: vec2(0, 0), rotate: 0, speedKill: "keep" });
    w.run(30);
    const predicted = predictCourse(w, s);
    w.run(60 * COURSE.horizon);
    const end = w.physics.getWorldCenter(s.id);
    expect(length(w.physics.getBodyState(s.id).linearVelocity)).toBeLessThan(2);
    expect(length(sub(end, predicted[predicted.length - 1]!))).toBeLessThan(15);
  });

  it("arcade, forward held from rest: follows the acceleration and stops at the top speed (within 2 %)", () => {
    const { error, travelled } = check({
      model: "arcade",
      intent: { thrust: vec2(1, 0), rotate: 0 },
      settle: 0.1,
    });
    expect(travelled).toBeGreaterThan(600);
    expect(worst(error)).toBeLessThan(travelled * 0.02);
  });

  it("arcade, released at speed: predicts the braking distance (within 3 m)", () => {
    const { error, travelled } = check({
      model: "arcade",
      intent: { thrust: vec2(1, 0), rotate: 0 },
      settle: 8,
      then: { thrust: vec2(0, 0), rotate: 0 },
    });
    expect(travelled).toBeGreaterThan(20);
    expect(travelled).toBeLessThan(400);
    expect(worst(error)).toBeLessThan(3);
  });

  it("arcade, turning at speed: the course bends with the nose (within 4 %)", () => {
    const { error, travelled } = check({
      model: "arcade",
      intent: { thrust: vec2(1, 0), rotate: 0 },
      settle: 8,
      then: { thrust: vec2(1, 0), rotate: 0, faceAngle: Math.PI / 2 },
    });
    expect(worst(error)).toBeLessThan(travelled * 0.04);
  });
});
