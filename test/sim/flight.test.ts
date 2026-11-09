import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { ShipDesign } from "../../src/data/schemas/design";
import { allocate, wrenchOf } from "../../src/sim/flight/allocator";
import { buildPropulsion, capabilities, G0 } from "../../src/sim/flight/propulsion";
import { buildRuntimePart } from "../../src/sim/ship/catalogue";
import { computeMassProps, instantiateParts, type PartInstance } from "../../src/sim/ship/ship";
import { degToRad, length, vec2 } from "../../src/sim/core/vec2";
import { SIM_DT } from "../../src/sim/core/loop";
import { World } from "../../src/sim/world";
import { FLIGHT, forceAlong, speedKillTimes, wrapAngle } from "../../src/sim/flight/controller";
import { design, testCatalogue } from "../helpers";

const cat = testCatalogue();

function customDesign(id: string, parts: [string, number, number, number][]): ShipDesign {
  const base = design("brick");
  return {
    ...base,
    id,
    name: id,
    parts: parts.map(([partId, x, y, angle], i) => ({ uid: `p${i}`, partId, x, y, angle })),
  };
}

function engineAt(angleDeg = 0): PartInstance {
  const def = cat.get("core:test.engine");
  return {
    uid: "eng",
    def,
    position: vec2(0, 0),
    angle: degToRad(angleDeg),
    hp: def.def.hp,
    fuel: 0,
    charge: 0,
    ammo: 0,
    wreckHp: def.def.hp,
  };
}

/** Runs ticks until predicate or limit; returns ticks taken (or -1). */
function runUntil(w: World, pred: () => boolean, limit: number): number {
  for (let i = 0; i < limit; i++) {
    if (pred()) return i;
    w.step();
  }
  return pred() ? limit : -1;
}

describe("M1 propulsion: main engines, RCS, gyro", () => {
  it("1.7 engine pointing through CoM: force = T, torque = 0", () => {
    const parts = instantiateParts(design("main-only"), cat);
    const mp = computeMassProps(parts);
    const { actuators, engines } = buildPropulsion(parts, mp, true);
    const eng = actuators.find((a) => a.kind === "engine")!;
    expect(mp.center.y).toBeCloseTo(0, 12);
    expect(eng.fx).toBeCloseTo(10000, 9);
    expect(eng.fy).toBeCloseTo(0, 9);
    expect(eng.torque).toBe(0);
    expect(engines[0]!.outOfGimbal).toBe(false);
  });

  const mpToward = (deg: number) => ({
    mass: 500,
    inertia: 100,
    center: vec2(5 * Math.cos(degToRad(deg)), 5 * Math.sin(degToRad(deg))),
  });

  it("1.8 φ = 10° within 15° limit: F = T·cos10°, zero torque, fuel at full T", () => {
    const { actuators, engines } = buildPropulsion([engineAt()], mpToward(10), true);
    const eng = actuators[0]!;
    expect(Math.hypot(eng.fx, eng.fy)).toBeCloseTo(10000 * Math.cos(degToRad(10)), 9);
    expect(Math.atan2(eng.fy, eng.fx)).toBeCloseTo(degToRad(10), 9);
    expect(eng.torque).toBe(0);
    expect(eng.fuelFlow).toBeCloseTo(10000 / (300 * G0), 12);
    expect(engines[0]!.phi).toBeCloseTo(degToRad(10), 9);
  });

  it("1.9 φ = 20° beyond 15° limit: no force, flagged out of gimbal", () => {
    const { actuators, engines } = buildPropulsion([engineAt()], mpToward(20), true);
    expect(actuators.filter((a) => a.kind === "engine")).toHaveLength(0);
    expect(engines[0]!.outOfGimbal).toBe(true);
  });

  it("1.10 CoM shift from fuel burn pushes the engine out of gimbal at runtime", () => {
    // Connected layout (fuel must reach the engine, M3): tank above, ballast below. Full tank: CoM on the
    // engine axis; draining it moves the CoM down until the engine is past its 15° gimbal (~190 kg left).
    const d = customDesign("drift", [
      ["core:test.engine", 0, 0, 0],
      ["core:test.command", 1, 0, 0],
      ["core:test.fueltank", 1, 1, 0],
      ["core:test.rect", 1.5, -1, 0],
      ["core:test.square", 1, -2, 0],
    ]);
    const full = instantiateParts(d, cat);
    expect(buildPropulsion(full, computeMassProps(full), true).engines[0]!.outOfGimbal).toBe(false);

    const w = new World({ seed: 1 });
    const ship = w.addShip(d, cat);
    w.setIntent(ship.id, { thrust: vec2(1, 0), rotate: 0 });
    const ticks = runUntil(w, () => ship.propulsion.engines[0]?.outOfGimbal === true, 120 * 60);
    expect(ticks).toBeGreaterThan(0);
    const fuelAtCutoff = ship.totalFuel;
    expect(fuelAtCutoff).toBeGreaterThan(100);
    w.run(120);
    expect(ship.totalFuel).toBeCloseTo(fuelAtCutoff, 9); // engine no longer burns
  });

  it("1.11 RCS at r = (0, 2) with force (1000, 0) gives torque −2000", () => {
    const base = cat.get("core:test.rcs").def;
    const def = buildRuntimePart({ ...base, thruster: { ...base.thruster!, thrust: 1000 } });
    const p: PartInstance = {
      uid: "r",
      def,
      position: vec2(0, 2),
      angle: degToRad(-90),
      hp: def.def.hp,
      fuel: 0,
      charge: 0,
      ammo: 0,
      wreckHp: def.def.hp,
    };
    const { actuators } = buildPropulsion(
      [p],
      { mass: 10, inertia: 1, center: vec2(0, 2 + def.centroid.y) },
      true,
    );
    // Centroid at the part origin, so put CoM at the origin explicitly:
    const a = buildPropulsion([p], { mass: 10, inertia: 1, center: vec2(0, 0) }, true).actuators[0]!;
    expect(a.fx).toBeCloseTo(1000, 9);
    expect(a.fy).toBeCloseTo(0, 9);
    expect(a.torque).toBeCloseTo(-2000, 9);
    expect(actuators[0]!.torque).toBeCloseTo(0, 9); // force through CoM → no torque
  });

  it("1.12 angular acceleration = τ/I; bang-bang 180° in 2√(π/α) within 2%", () => {
    const w = new World({ seed: 1 });
    w.physics.createBody({ id: "b", type: "dynamic", position: vec2(0, 0), angle: 0 });
    w.physics.addPolygon("b", { vertices: [vec2(-1, -1), vec2(1, -1), vec2(1, 1), vec2(-1, 1)] });
    const I = 100;
    const tau = 10;
    w.physics.setMassProps("b", { mass: 50, center: vec2(0, 0), inertia: I });
    w.physics.applyTorque("b", tau);
    w.step();
    expect(w.physics.getBodyState("b").angularVelocity).toBeCloseTo((tau / I) * SIM_DT, 12);

    const alpha = tau / I;
    const half = Math.round(Math.sqrt(Math.PI / alpha) / SIM_DT) - 1;
    for (let i = 0; i < half; i++) {
      w.physics.applyTorque("b", tau);
      w.step();
    }
    for (let i = 0; i < half + 1; i++) {
      w.physics.applyTorque("b", -tau);
      w.step();
    }
    expect(w.physics.getBodyState("b").angle / Math.PI).toBeCloseTo(1, 1);
    expect(Math.abs(w.physics.getBodyState("b").angle / Math.PI - 1)).toBeLessThan(0.02);
  });

  it("1.12b face-angle controller turns the brick 180° within 1.3× the optimum (with ω cap)", () => {
    const w = new World({ seed: 1 });
    const ship = w.addShip(design("brick"), cat);
    const alpha = 1000 / ship.massProps.inertia;
    // Time-optimal turn with angular-speed cap: trapezoid if the cap is reached, else bang-bang.
    const wMax = FLIGHT.maxOmega;
    const optimal =
      Math.PI > (wMax * wMax) / alpha ? Math.PI / wMax + wMax / alpha : 2 * Math.sqrt(Math.PI / alpha);
    w.setIntent(ship.id, { thrust: vec2(0, 0), rotate: 0, faceAngle: Math.PI - 1e-6 });
    const s = () => w.physics.getBodyState(ship.id);
    const ticks = runUntil(
      w,
      () => Math.abs(wrapAngle(s().angle - Math.PI)) < degToRad(1) && Math.abs(s().angularVelocity) < 0.05,
      600,
    );
    expect(ticks).toBeGreaterThan(0);
    expect(ticks * SIM_DT).toBeLessThan(1.3 * optimal + 0.3);
  });

  it("1.13 doubling arm length increases turn time by √(I₂/I₁) within 5%", () => {
    const turnTime = (L: number) => {
      const d = customDesign(`arm${L}`, [
        ["core:test.command", 0, 0, 0],
        ["core:test.square", -L, 0, 0],
        ["core:test.square", L, 0, 0],
      ]);
      const w = new World({ seed: 1 });
      const ship = w.addShip(d, cat);
      w.setIntent(ship.id, { thrust: vec2(0, 0), rotate: 0, faceAngle: Math.PI / 2 });
      const s = () => w.physics.getBodyState(ship.id);
      const t = runUntil(w, () => Math.abs(wrapAngle(s().angle - Math.PI / 2)) < degToRad(5), 5000);
      return { t, I: ship.massProps.inertia };
    };
    const a = turnTime(10);
    const b = turnTime(20);
    expect(a.t).toBeGreaterThan(0);
    expect(b.t / a.t / Math.sqrt(b.I / a.I)).toBeGreaterThan(0.95);
    expect(b.t / a.t / Math.sqrt(b.I / a.I)).toBeLessThan(1.05);
  });
});

describe("M1 thrust allocator", () => {
  it("1.14 pure forward on main-only: engine at full, torque ≈ 0", () => {
    const parts = instantiateParts(design("main-only"), cat);
    const { actuators } = buildPropulsion(parts, computeMassProps(parts), true);
    const caps = capabilities(actuators);
    const u = allocate(actuators, { fx: caps.fwd, fy: 0, torque: 0 });
    const ei = actuators.findIndex((a) => a.kind === "engine");
    expect(u[ei]).toBeCloseTo(1, 3);
    const w = wrenchOf(actuators, u);
    expect(Math.abs(w.torque)).toBeLessThan(1e-6);
  });

  it("1.15 strafe on rcs-only: lateral force with net torque < 1% of maximum", () => {
    const parts = instantiateParts(design("rcs-only"), cat);
    const { actuators } = buildPropulsion(parts, computeMassProps(parts), true);
    const caps = capabilities(actuators);
    const u = allocate(actuators, { fx: 0, fy: caps.left * 0.5, torque: 0 });
    const w = wrenchOf(actuators, u);
    expect(w.fy).toBeGreaterThan(caps.left * 0.45);
    expect(Math.abs(w.torque)).toBeLessThan(0.01 * caps.torqueCcw);
    expect(Math.abs(w.fx)).toBeLessThan(0.01 * caps.fwd);
  });

  it("1.16 impossible intent: best effort, no NaN, throttles in [0, 1]", () => {
    const parts = instantiateParts(design("main-only"), cat);
    const { actuators } = buildPropulsion(parts, computeMassProps(parts), true);
    const u = allocate(actuators, { fx: 0, fy: 1e6, torque: 1e9 });
    for (const t of u) {
      expect(Number.isFinite(t)).toBe(true);
      expect(t).toBeGreaterThanOrEqual(0);
      expect(t).toBeLessThanOrEqual(1);
    }
  });

  it("1.17 allocator is bit-identical for identical inputs (1000 random cases)", () => {
    const parts = instantiateParts(design("asymmetric"), cat);
    const { actuators } = buildPropulsion(parts, computeMassProps(parts), true);
    fc.assert(
      fc.property(
        fc.double({ min: -1e5, max: 1e5, noNaN: true }),
        fc.double({ min: -1e5, max: 1e5, noNaN: true }),
        fc.double({ min: -1e5, max: 1e5, noNaN: true }),
        (fx, fy, torque) => {
          expect(allocate(actuators, { fx, fy, torque })).toEqual(allocate(actuators, { fx, fy, torque }));
        },
      ),
      { numRuns: 1000 },
    );
  });
});

describe("M1 flight dynamics", () => {
  it("1.18 full burn matches Tsiolkovsky Δv within 1%", () => {
    const w = new World({ seed: 1 });
    const ship = w.addShip(design("main-only"), cat);
    const m0 = ship.massProps.mass;
    const m1 = m0 - ship.totalFuel;
    w.setIntent(ship.id, { thrust: vec2(1, 0), rotate: 0 });
    runUntil(w, () => ship.totalFuel <= 1e-9, 200 * 60);
    const dv = length(w.physics.getBodyState(ship.id).linearVelocity);
    const expected = 300 * G0 * Math.log(m0 / m1);
    expect(Math.abs(dv / expected - 1)).toBeLessThan(0.01);
    expect(ship.massRecomputes).toBeGreaterThan(10);
  });

  it("1.19 free drift with no input keeps velocity constant over 10k ticks", () => {
    const w = new World({ seed: 1 });
    const ship = w.addShip(design("asymmetric"), cat, { velocity: vec2(10, -3) });
    w.run(10_000);
    const v = w.physics.getBodyState(ship.id).linearVelocity;
    expect(Math.abs(v.x - 10)).toBeLessThan(1e-6);
    expect(Math.abs(v.y + 3)).toBeLessThan(1e-6);
  });

  it("1.20 stabilisation brakes ω = 2 rad/s to < 0.01 within the predicted time", () => {
    const w = new World({ seed: 1 });
    const ship = w.addShip(design("main-only"), cat, { angularVelocity: 2 });
    const predicted = (2 * ship.massProps.inertia) / 1000;
    const ticks = runUntil(w, () => Math.abs(w.physics.getBodyState(ship.id).angularVelocity) < 0.01, 6000);
    expect(ticks).toBeGreaterThan(0);
    expect(ticks * SIM_DT).toBeLessThan(predicted + 0.5);
  });

  it("1.21 speed kill (keep) from 100 m/s stops in ≈ v/a_max ±10% and uses fuel", () => {
    const w = new World({ seed: 1 });
    const ship = w.addShip(design("main-only"), cat, { velocity: vec2(-100, 0) });
    const aMax = 10000 / ship.massProps.mass;
    const fuel0 = ship.totalFuel;
    w.setIntent(ship.id, { thrust: vec2(0, 0), rotate: 0, speedKill: "keep" });
    const ticks = runUntil(w, () => w.tick > 0 && ship.flight.speedKill === "off", 60 * 30);
    expect(ticks).toBeGreaterThan(0);
    const t = ticks * SIM_DT;
    expect(Math.abs(t / (100 / aMax) - 1)).toBeLessThan(0.1);
    expect(length(w.physics.getBodyState(ship.id).linearVelocity)).toBeLessThan(FLIGHT.killEpsilon + 0.01);
    expect(ship.totalFuel).toBeLessThan(fuel0);
  });

  it("1.22 speed kill (flip) from 100 m/s prograde rotates ≈180° then stops", () => {
    const w = new World({ seed: 1 });
    const ship = w.addShip(design("main-only"), cat, { velocity: vec2(100, 0) });
    w.setIntent(ship.id, { thrust: vec2(0, 0), rotate: 0, speedKill: "flip" });
    const ticks = runUntil(w, () => w.tick > 0 && ship.flight.speedKill === "off", 60 * 60);
    expect(ticks).toBeGreaterThan(0);
    const s = w.physics.getBodyState(ship.id);
    expect(length(s.linearVelocity)).toBeLessThan(FLIGHT.killEpsilon + 0.01);
    expect(Math.abs(wrapAngle(s.angle - Math.PI))).toBeLessThan(degToRad(10));
  });

  it("1.23 speed kill cancels on thrust input; flip falls back to keep on rotation input", () => {
    const w = new World({ seed: 1 });
    // Drifting backwards: the main engine is retro thrust, so X keeps orientation.
    const ship = w.addShip(design("main-only"), cat, { velocity: vec2(-50, 0) });
    w.setIntent(ship.id, { thrust: vec2(0, 0), rotate: 0, speedKill: "keep" });
    w.step();
    expect(ship.flight.speedKill).toBe("keep");
    w.setIntent(ship.id, { thrust: vec2(1, 0), rotate: 0 });
    w.step();
    expect(ship.flight.speedKill).toBe("off");

    w.setIntent(ship.id, { thrust: vec2(0, 0), rotate: 0, speedKill: "flip" });
    w.step();
    expect(ship.flight.speedKill).toBe("flip");
    w.setIntent(ship.id, { thrust: vec2(0, 0), rotate: 0.5 });
    w.step();
    expect(ship.flight.speedKill).toBe("keep");
  });

  it("X switches to flip-and-burn when the ship has no thrust against its velocity", () => {
    const w = new World({ seed: 1 });
    const ship = w.addShip(design("main-only"), cat, { velocity: vec2(50, 0) }); // engine faces the wrong way
    w.setIntent(ship.id, { thrust: vec2(0, 0), rotate: 0, speedKill: "keep" });
    w.step();
    expect(ship.flight.speedKill).toBe("flip");
    w.setIntent(ship.id, { thrust: vec2(0, 0), rotate: 0 });
    runUntil(w, () => ship.flight.speedKill === "off", 60 * 60);
    expect(length(w.physics.getBodyState(ship.id).linearVelocity)).toBeLessThan(FLIGHT.killEpsilon + 0.01);
  });

  it("speedKillTimes: keep is impossible without retro thrust, flip pays for the turn", () => {
    const caps = { fwd: 1000, back: 0, left: 100, right: 100, torqueCcw: 500, torqueCw: 500 };
    const ctx = {
      mass: 100,
      inertia: 50,
      angle: 0,
      angularVelocity: 0,
      velocity: vec2(10, 0),
      referenceVelocity: vec2(0, 0),
      caps,
      dt: SIM_DT,
    };
    const fwdMoving = speedKillTimes(vec2(10, 0), ctx);
    expect(fwdMoving.keep).toBe(Infinity);
    expect(fwdMoving.flip).toBeGreaterThan(1); // 1 s burn + the half turn
    const backMoving = speedKillTimes(vec2(-10, 0), ctx);
    expect(backMoving.keep).toBeCloseTo(1, 9);
    expect(backMoving.flip).toBeCloseTo(1, 9); // already facing the right way
    expect(forceAlong(caps, { x: -Math.SQRT1_2, y: Math.SQRT1_2 })).toBe(0); // needs back thrust
    expect(forceAlong(caps, { x: 0, y: 1 })).toBeCloseTo(100, 9);
  });

  it("1.24 non-zero reference velocity makes speed kill converge to it", () => {
    const w = new World({ seed: 1 });
    const ship = w.addShip(design("main-only"), cat, { velocity: vec2(-40, 0) });
    ship.referenceVelocity = () => vec2(5, 0);
    w.setIntent(ship.id, { thrust: vec2(0, 0), rotate: 0, speedKill: "keep" });
    const ticks = runUntil(w, () => w.tick > 0 && ship.flight.speedKill === "off", 60 * 30);
    expect(ticks).toBeGreaterThan(0);
    expect(w.physics.getBodyState(ship.id).linearVelocity.x).toBeCloseTo(5, 1);
  });
});
