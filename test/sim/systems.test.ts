import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { ShipDesign } from "../../src/data/schemas/design";
import type { PartDef } from "../../src/data/schemas/part";
import { PartCatalogue } from "../../src/sim/ship/catalogue";
import { World } from "../../src/sim/world";
import { vec2 } from "../../src/sim/core/vec2";
import { SIM_DT } from "../../src/sim/core/loop";
import { computeNetworks } from "../../src/sim/systems/networks";
import { allocatePower } from "../../src/sim/systems/power";
import { HEAT, heatThrottle, stepHeat } from "../../src/sim/systems/heat";
import { MASS_RECOMPUTE_THRESHOLD } from "../../src/sim/ship/ship-entity";
import { design, testCatalogue } from "../helpers";

const base = testCatalogue();
/** Command module whose gyro needs power and that has no generator of its own. */
const poweredCommand: PartDef = {
  ...base.get("core:test.command").def,
  id: "core:test.command.powered",
  command: { gyroTorque: 1000, powerDraw: 100 },
};
/** Engine hot enough to beat passive cooling (200 kW at full thrust). */
const hotEngine: PartDef = {
  ...base.get("core:test.engine").def,
  id: "core:test.engine.hot",
  engine: { ...base.get("core:test.engine").def.engine!, heatAtMax: 200_000 },
};
const cat = new PartCatalogue("test", [...base.all().map((p) => p.def), poweredCommand, hotEngine]);

function ship(
  parts: [string, number, number, number?][],
  opts: { chargeFraction?: number; priority?: ShipDesign["powerPriority"] } = {},
) {
  const d: ShipDesign = {
    ...design("brick"),
    id: "s",
    parts: parts.map(([partId, x, y, angle], i) => ({ uid: `p${i + 1}`, partId, x, y, angle: angle ?? 0 })),
    ...(opts.priority ? { powerPriority: opts.priority } : {}),
  };
  const w = new World({ seed: 1 });
  const s = w.addShip(
    d,
    cat,
    opts.chargeFraction !== undefined ? { chargeFraction: opts.chargeFraction } : {},
  );
  return { w, s };
}
const sets = (members: readonly (readonly string[])[]) => members.map((m) => [...m]);

describe("M3 networks", () => {
  it("3.1 chain A–B–C, destroy B → 2 networks {A}, {C}", () => {
    const { s } = ship([
      ["core:test.command", 0, 0],
      ["core:test.square", 1, 0],
      ["core:test.square", 2, 0],
    ]);
    expect(sets(s.networks.members)).toEqual([["p1", "p2", "p3"]]);
    s.destroyPart("p2");
    s.updateNetworks();
    expect(sets(s.networks.members)).toEqual([["p1"], ["p3"]]);
  });

  it("3.2 ring A–B–C–D, destroy B → still 1 network", () => {
    const { s } = ship([
      ["core:test.command", 0, 0],
      ["core:test.square", 1, 0],
      ["core:test.square", 1, 1],
      ["core:test.square", 0, 1],
    ]);
    s.destroyPart("p2");
    s.updateNetworks();
    expect(sets(s.networks.members)).toEqual([["p1", "p3", "p4"]]);
  });

  it("3.3 property: every intact conducting part is in exactly one network; count ≤ intact parts", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.record({ x: fc.integer({ min: 0, max: 5 }), y: fc.integer({ min: 0, max: 5 }) }), {
          minLength: 1,
          maxLength: 20,
          selector: (c) => `${c.x},${c.y}`,
        }),
        fc.array(fc.boolean(), { minLength: 20, maxLength: 20 }),
        (cells, dead) => {
          const parts = cells.map(
            (c, i) =>
              [i === 0 ? "core:test.command" : "core:test.square", c.x, c.y] as [string, number, number],
          );
          const { s } = ship(parts);
          s.parts.forEach((p, i) => dead[i] && i > 0 && s.destroyPart(p.uid));
          s.updateNetworks();
          const intact = s.parts.filter((p) => p.hp > 0).map((p) => p.uid);
          const all = s.networks.members.flat();
          expect([...all].sort()).toEqual([...intact].sort());
          expect(new Set(all).size).toBe(all.length);
          expect(s.networks.members.length).toBeLessThanOrEqual(intact.length);
        },
      ),
      { numRuns: 60 },
    );
  });

  it("3.4 a non-conducting part between two sections keeps them separate", () => {
    const { s } = ship([
      ["core:test.command", 0, 0],
      ["core:test.insulator", 1, 0],
      ["core:test.square", 2, 0],
    ]);
    expect(sets(s.networks.members)).toEqual([["p1"], ["p3"]]);
    // computeNetworks is independent of connection order.
    const conns = [...s.connections].reverse();
    expect(
      computeNetworks(
        s.parts.map((p) => ({ uid: p.uid, intact: true, conducts: p.def.def.conducts !== false })),
        conns,
      ).members,
    ).toEqual(s.networks.members);
  });
});

describe("M3 power allocation", () => {
  const cons = [
    { uid: "e", group: "propulsion" as const, demand: 60 },
    { uid: "w", group: "weapons" as const, demand: 60 },
  ];
  const reactor = [{ uid: "r", maxOutput: 100 }];

  it("3.5 supply 100 W, demands 60/60, propulsion first → 1.0 / 0.667", () => {
    const r = allocatePower(reactor, [], cons, ["propulsion", "weapons"], SIM_DT);
    expect(r.factors.get("e")).toBe(1);
    expect(r.factors.get("w")).toBeCloseTo(40 / 60, 9);
    expect(r.reactorOutput.get("r")).toBeCloseTo(100, 9);
  });

  it("3.6 reversed priority → weapons 1.0, propulsion 0.667", () => {
    const r = allocatePower(reactor, [], cons, ["weapons", "propulsion"], SIM_DT);
    expect(r.factors.get("w")).toBe(1);
    expect(r.factors.get("e")).toBeCloseTo(40 / 60, 9);
  });

  it("3.7 three groups, supply covers only the first: second shares the remainder, third gets 0", () => {
    const three = [
      { uid: "g", group: "gyro" as const, demand: 50 },
      { uid: "e1", group: "propulsion" as const, demand: 40 },
      { uid: "e2", group: "propulsion" as const, demand: 60 },
      { uid: "w", group: "weapons" as const, demand: 10 },
    ];
    const r = allocatePower(
      [{ uid: "r", maxOutput: 80 }],
      [],
      three,
      ["gyro", "propulsion", "weapons"],
      SIM_DT,
    );
    expect(r.factors.get("g")).toBe(1);
    expect(r.factors.get("e1")).toBeCloseTo(0.3, 9);
    expect(r.factors.get("e2")).toBeCloseTo(0.3, 9);
    expect(r.factors.get("w")).toBe(0);
  });

  it("3.8 surplus charges batteries up to maxCharge and capacity; deficits discharge up to maxDischarge", () => {
    const bat = { uid: "b", charge: 500, capacity: 1000, maxCharge: 50, maxDischarge: 100 };
    const charge = allocatePower(reactor, [bat], [{ uid: "x", group: "gyro", demand: 20 }], ["gyro"], 1);
    expect(charge.batteryCharge.get("b")).toBeCloseTo(550, 9); // 80 W spare, capped at 50 W
    expect(charge.reactorOutput.get("r")).toBeCloseTo(70, 9);
    const full = allocatePower(reactor, [{ ...bat, charge: 990 }], [], ["gyro"], 1);
    expect(full.batteryCharge.get("b")).toBeCloseTo(1000, 9);
    const drain = allocatePower(reactor, [bat], [{ uid: "x", group: "gyro", demand: 250 }], ["gyro"], 1);
    expect(drain.factors.get("x")).toBeCloseTo(200 / 250, 9); // 100 reactor + 100 battery
    expect(drain.batteryCharge.get("b")).toBeCloseTo(400, 9);
  });

  it("3.9 empty battery + destroyed reactor → powered gyro has no power → the ship cannot rotate", () => {
    const { w, s } = ship(
      [
        ["core:test.command.powered", 0, 0],
        ["core:test.battery", 1, 0],
        ["core:test.reactor", -1, 0],
      ],
      { chargeFraction: 0 },
    );
    w.setIntent(s.id, { thrust: vec2(0, 0), rotate: 1 });
    w.run(10);
    expect(w.physics.getBodyState(s.id).angularVelocity).toBeGreaterThan(0.01); // reactor alive: rotates
    w.physics.applyTorque(s.id, 0);
    // Reactor knocked out without its M4 explosion (this test is about power, not blasts).
    s.part("p3").hp = 0;
    s.markNetworksDirty();
    const w0 = w.physics.getBodyState(s.id).angularVelocity;
    w.setIntent(s.id, { thrust: vec2(0, 0), rotate: -1 });
    w.run(30);
    expect(s.power.groups.gyro.factor).toBe(0);
    expect(w.physics.getBodyState(s.id).angularVelocity).toBeCloseTo(w0, 9); // no torque at all
  });

  it("3.10 reactor at half HP → max output halved", () => {
    const { w, s } = ship([
      ["core:test.command", 0, 0],
      ["core:test.reactor", 1, 0],
      ["core:test.gyro.powered", 2, 0],
      ["core:test.gyro.powered", 0, 1],
    ]);
    w.step();
    expect(s.power.supply).toBeCloseTo(100, 9);
    s.part("p2").hp = 50;
    w.step();
    expect(s.power.supply).toBeCloseTo(50, 9);
    expect(s.power.groups.gyro.factor).toBeCloseTo(50 / 120, 9);
  });

  it("3.11 a cut-off network with its own reactor runs on its own power but takes no commands", () => {
    const { w, s } = ship(
      [
        ["core:test.command", 0, 0],
        ["core:test.insulator", 1, 0],
        ["core:test.reactor", 2, 0],
        ["core:test.battery", 3, 0],
        ["core:test.engine.electric", 2, 1, 90],
        ["core:test.fueltank", 3, 1],
      ],
      { chargeFraction: 0.5 },
    );
    expect(s.isCommanded("p5")).toBe(false);
    w.setIntent(s.id, { thrust: vec2(0, 1), rotate: 0 });
    w.run(60);
    expect(s.propulsion.actuators.some((a) => a.partUid === "p5")).toBe(false); // no commands reach it
    expect(s.part("p4").charge).toBeGreaterThan(500); // its reactor still charges its battery
  });
});

describe("M3 fuel", () => {
  const layout: [string, number, number][] = [
    ["core:test.command", 1, 0],
    ["core:test.engine", 0, 0],
    ["core:test.fueltank", 1, 1],
    ["core:test.fueltank", 1, -1],
    ["core:test.insulator", 2, 0],
    ["core:test.fueltank", 3, 0],
  ];

  it("3.12 tanks on the engine's network drain proportionally; a tank on another network is untouched", () => {
    const { w, s } = ship(layout);
    s.part("p4").fuel = 200; // tank B half full
    w.setIntent(s.id, { thrust: vec2(1, 0), rotate: 0 });
    w.run(120);
    const a = s.part("p3").fuel;
    const b = s.part("p4").fuel;
    expect(a).toBeLessThan(400);
    expect((400 - a) / (200 - b)).toBeCloseTo(2, 6); // proportional to contents
    expect(s.part("p6").fuel).toBe(400);
  });

  it("3.13 an engine with no fuel path gives no thrust", () => {
    const { w, s } = ship([
      ["core:test.command", 1, 0],
      ["core:test.engine", 0, 0],
      ["core:test.insulator", 2, 0],
      ["core:test.fueltank", 3, 0],
    ]);
    w.setIntent(s.id, { thrust: vec2(1, 0), rotate: 0 });
    w.run(30);
    expect(s.fuelInNetwork(s.networkOf("p2"))).toBe(0);
    expect(s.propulsion.actuators.some((a) => a.kind === "engine")).toBe(false);
    expect(w.physics.getBodyState(s.id).linearVelocity.x).toBeCloseTo(0, 9);
  });

  it("3.19 mass properties recompute once per 0.5 % mass change", () => {
    const { w, s } = ship(layout);
    const m0 = s.massProps.mass;
    w.setIntent(s.id, { thrust: vec2(1, 0), rotate: 0 });
    w.run(60 * 40);
    const m1 = s.parts.reduce((t, p) => t + p.def.def.mass + p.fuel, 0);
    const expected = Math.log(m1 / m0) / Math.log(1 - MASS_RECOMPUTE_THRESHOLD);
    expect(Math.abs(s.massRecomputes - expected)).toBeLessThanOrEqual(1.5);
  });
});

describe("M3 heat", () => {
  it("3.14 steady state: generation = dissipation keeps heat constant", () => {
    let h = 1_000_000;
    for (let i = 0; i < 10_000; i++) h = stepHeat(h, 50_000, 50_000, SIM_DT);
    expect(Math.abs(h - 1_000_000) / 1_000_000).toBeLessThan(0.001);
  });

  it("3.15 at 85 % heat, heat-producing parts are throttled to 0.75", () => {
    expect(heatThrottle(0.85)).toBeCloseTo(0.75, 9);
    expect(heatThrottle(0.5)).toBe(1);
    expect(heatThrottle(1.4)).toBe(0.5);
    const { w, s } = ship([
      ["core:test.command", 1, 0],
      ["core:test.engine.electric", 0, 0],
      ["core:test.fueltank", 2, 0],
      ["core:test.reactor", 1, 1],
    ]);
    w.setIntent(s.id, { thrust: vec2(1, 0), rotate: 0 });
    w.run(5);
    const full = s.propulsion.actuators.find((a) => a.kind === "engine")!.fx;
    s.heat = 0.85 * s.heatCapacity;
    w.step();
    // Reactor output is throttled too (100 W → 75 W), and the engine is both power- and heat-limited.
    expect(s.power.supply).toBeCloseTo(75, 6);
    expect(s.propulsion.actuators.find((a) => a.kind === "engine")!.fx / full).toBeCloseTo(0.75 * 0.75, 3); // tiny drift: fuel burn shifts the gimbal angle between samples
  });

  it("3.16 above 100 % heat, heat-producing parts lose HP at the specified rate", () => {
    const { w, s } = ship([
      ["core:test.command", 1, 0],
      ["core:test.engine.electric", 0, 0],
      ["core:test.fueltank", 2, 0],
      ["core:test.reactor", 1, 1],
      ["core:test.square", 1, -1],
    ]);
    w.setIntent(s.id, { thrust: vec2(1, 0), rotate: 0 });
    w.run(3);
    s.heat = 1.1 * s.heatCapacity;
    const level = s.heatLevel;
    w.step();
    const expectedLoss = 100 * HEAT.overheatDamage * (level - 1) * SIM_DT;
    expect(100 - s.part("p2").hp).toBeCloseTo(expectedLoss, 3); // engine produces heat
    expect(s.part("p5").hp).toBe(100); // passive hull plate does not
  });

  it("3.17 radiator retracted → × retractedFactor; extended → × 1", () => {
    const { w, s } = ship([
      ["core:test.command", 0, 0],
      ["core:test.radiator", 1.5, 0],
    ]); // attached by its short snap edge
    w.step();
    expect(s.heatFlow.radiators).toBeCloseTo(1000, 6);
    s.radiatorsExtended = false;
    w.step();
    expect(s.heatFlow.radiators).toBeCloseTo(250, 6);
  });

  it("3.18 a part in one face's keep-clear zone silences that face; at half HP → 25 % dissipation", () => {
    // Radiator on the command's side by its short edge; a plate 0.25 m above its upper face (not touching).
    const { w, s } = ship([
      ["core:test.command", 0, 0],
      ["core:test.radiator", 1.5, 0],
      ["core:test.square", 0, 1],
      ["core:test.square", 1, 1],
    ]);
    expect(s.radiatorExposure.get("p2")).toBeCloseTo(0.5, 6);
    s.part("p2").hp = 50;
    w.step();
    expect(s.heatFlow.radiators).toBeCloseTo(250, 6);
  });

  it("heat rises while a hot engine burns, then passive cooling and radiators bring it back down", () => {
    const { w, s } = ship([
      ["core:test.command", 1, 0],
      ["core:test.engine.hot", 0, 0],
      ["core:test.fueltank", 2, 0],
      ["core:test.radiator", 1, 0.75],
    ]);
    w.setIntent(s.id, { thrust: vec2(1, 0), rotate: 0 });
    w.run(120);
    const hot = s.heat;
    expect(hot).toBeGreaterThan(100_000);
    w.setIntent(s.id, { thrust: vec2(0, 0), rotate: 0 });
    w.run(60);
    expect(s.heat).toBeLessThan(hot);
    expect(s.heatFlow.dissipation).toBeGreaterThan(0);
  });
});

describe("hull radiation", () => {
  it("a ship without radiators sheds HEAT.hullRadiation per metre of exposed outline", () => {
    const { w, s } = ship([
      ["core:test.command", 0, 0],
      ["core:test.square", 1, 0],
    ]);
    expect(s.hullExposedLength).toBeCloseTo(6, 9); // 2×1 m block: 6 m of outline
    s.heat = 1_000_000;
    w.step();
    expect(s.heatFlow.hull).toBeCloseTo(6 * HEAT.hullRadiation, 6);
    expect(s.heatFlow.radiators).toBe(0);
    expect(s.heat).toBeCloseTo(1_000_000 - 6 * HEAT.hullRadiation * SIM_DT, 3);
  });

  it("radiator faces count as radiators, not hull; heat sources add up to generation", () => {
    const { w, s } = ship([
      ["core:test.command", 1, 0],
      ["core:test.engine.hot", 0, 0],
      ["core:test.fueltank", 2, 0],
      ["core:test.radiator", 1, 0.75],
    ]);
    w.setIntent(s.id, { thrust: vec2(1, 0), rotate: 0 });
    w.run(30);
    const f = s.heatFlow;
    const sum = f.sources.reactors + f.sources.propulsion + f.sources.gyros + f.sources.weapons;
    expect(sum).toBeCloseTo(f.generation, 6);
    expect(f.sources.propulsion).toBeGreaterThan(0);
    expect(f.dissipation).toBeCloseTo(f.radiators + f.hull, 6);
    // Radiator: 2 m long faces excluded; its 0.5 m ends are covered/exposed hull like any part.
    expect(s.hullExposedLength).toBeLessThan(3 * 4 + 2 * 0.5);
  });
});

describe("M3 heat from powered weapons", () => {
  it("a browned-out beam weapon heats only in proportion to the power it gets", () => {
    const hot: PartDef = {
      ...base.get("core:test.load.weapons").def,
      id: "core:test.load.hot",
      weapon: { ...base.get("core:test.load.weapons").def.weapon!, heatWhileFiring: 100_000 },
    };
    const c2 = new PartCatalogue("t2", [...cat.all().map((p) => p.def), hot]);
    const d: ShipDesign = {
      ...design("brick"),
      id: "h",
      parts: [
        { uid: "p1", partId: "core:test.command", x: 0, y: 0, angle: 0 },
        { uid: "p2", partId: "core:test.load.hot", x: 1, y: 0, angle: 0 },
        { uid: "p3", partId: "core:test.reactor", x: 0, y: 1, angle: 0 },
      ],
    };
    const w = new World({ seed: 1 });
    const s = w.addShip(d, c2);
    s.weaponCommand = { trigger: true, aimPoint: vec2(100, 0), selected: new Set([1]), targetId: null };
    w.run(2); // first tick requests power, second fires
    const factor = s.power.groups.weapons.factor; // 100 W reactor vs 60 W demand → fully served
    expect(factor).toBe(1);
    const full = s.heatFlow.generation;
    s.part("p3").hp = 30; // reactor at 30 % → 30 W of 60 W
    w.step();
    expect(s.power.groups.weapons.factor).toBeCloseTo(0.5, 6);
    expect(s.heatFlow.generation).toBeLessThan(full * 0.6);
  });
});

describe("M3 ammo", () => {
  it("weapon internal magazines refill from magazines on the same network only", () => {
    const { w, s } = ship([
      ["core:test.command", 0, 0],
      ["core:test.gun", 1, 0],
      ["core:test.magazine", 0, 1],
      ["core:test.insulator", -1, 0],
      ["core:test.magazine", -2, 0],
    ]);
    expect(s.part("p2").ammo).toBe(10);
    expect(s.drawRounds("p2", 10)).toBe(10);
    w.run(60); // 1 s = half a reload
    expect(s.part("p2").ammo).toBeCloseTo(5, 6);
    expect(s.part("p3").ammo).toBeCloseTo(95, 6);
    w.run(120);
    expect(s.part("p2").ammo).toBeCloseTo(10, 6);
    expect(s.part("p5").ammo).toBe(100); // other network untouched
  });

  it("magazine rounds count toward ship mass", () => {
    const { s } = ship([
      ["core:test.command", 0, 0],
      ["core:test.magazine", 0, 1],
    ]);
    const m0 = s.massProps.mass;
    s.part("p2").ammo = 0;
    s.maybeRecomputeMass(true);
    expect(m0 - s.massProps.mass).toBeCloseTo(100, 9);
  });
});
