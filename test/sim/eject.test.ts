import { describe, expect, it } from "vitest";
import type { ShipDesign } from "../../src/data/schemas/design";
import type { InputStream } from "../../src/data/schemas/inputs";
import { World, EJECT } from "../../src/sim/world";
import { add, length, scale, vec2 } from "../../src/sim/core/vec2";
import { raycastWorld } from "../../src/sim/combat/combat-world";
import { InputPlayer } from "../../src/sim/scenario/replay";
import { partMass } from "../../src/sim/ship/ship";
import { HEAT } from "../../src/sim/systems/heat";
import { design, testCatalogue } from "../helpers";

const cat = testCatalogue();

function ship(parts: [string, number, number, number?][], w = new World({ seed: 1 })) {
  const d: ShipDesign = {
    ...design("brick"),
    id: "s",
    parts: parts.map(([partId, x, y, angle], i) => ({ uid: `p${i + 1}`, partId, x, y, angle: angle ?? 0 })),
  };
  return { w, s: w.addShip(d, cat, { velocity: vec2(5, 2), angularVelocity: 0.3 }) };
}

/** Total linear momentum of every dynamic body (kg·m/s). */
function momentum(w: World) {
  let p = vec2(0, 0);
  for (const id of w.physics.dynamicBodyIds())
    p = add(p, scale(w.physics.getBodyState(id).linearVelocity, w.physics.getMassProps(id).mass));
  return p;
}

const row: [string, number, number][] = [
  ["core:test.command", 0, 0],
  ["core:test.square", 1, 0],
  ["core:test.square", 2, 0],
  ["core:test.fueltank", 3, 0],
];

describe("ejection", () => {
  it("removes the part from the ship and turns it into a debris body; momentum is conserved", () => {
    const { w, s } = ship(row);
    w.step();
    const before = momentum(w);
    const m0 = s.massProps.mass;
    const tankMass = partMass(s.part("p4"));
    const d = w.ejectPart(s.id, "p4")!;
    expect(d).not.toBeNull();
    expect(s.parts.map((p) => p.uid)).toEqual(["p1", "p2", "p3"]);
    expect(s.massProps.mass).toBeCloseTo(m0 - tankMass, 9);
    expect(w.physics.getMassProps(s.id).mass).toBeCloseTo(m0 - tankMass, 6);
    expect(w.physics.getMassProps(d.id).mass).toBeCloseTo(tankMass, 6);
    expect(w.debris).toHaveLength(1);
    const after = momentum(w);
    expect(length({ x: after.x - before.x, y: after.y - before.y })).toBeLessThan(1e-6 * m0);
    // The debris drifts away from the ship.
    const sep0 = length({
      x: w.physics.getWorldCenter(d.id).x - w.physics.getWorldCenter(s.id).x,
      y: w.physics.getWorldCenter(d.id).y - w.physics.getWorldCenter(s.id).y,
    });
    w.run(60);
    const sep1 = length({
      x: w.physics.getWorldCenter(d.id).x - w.physics.getWorldCenter(s.id).x,
      y: w.physics.getWorldCenter(d.id).y - w.physics.getWorldCenter(s.id).y,
    });
    expect(sep1 - sep0).toBeGreaterThan(EJECT.speed * 0.5);
  });

  it("the command module cannot be ejected", () => {
    const { w, s } = ship(row);
    expect(s.canEject("p1")).toBe(false);
    expect(s.requestEject("p1")).toBe(false);
    expect(w.ejectPart(s.id, "p1")).toBeNull();
    expect(s.parts).toHaveLength(4);
  });

  it("requests are applied at the start of the next tick", () => {
    const { w, s } = ship(row);
    expect(s.requestEject("p3")).toBe(true);
    expect(s.parts).toHaveLength(4);
    w.step();
    expect(s.parts.map((p) => p.uid)).toEqual(["p1", "p2"]); // p4 hung on p3 and leaves with it
    expect(s.pendingEject).toEqual([]);
  });

  it("ejecting a middle part takes everything attached only through it, as one debris body", () => {
    const { w, s } = ship(row);
    w.step();
    const before = momentum(w);
    const leaving = ["p2", "p3", "p4"].map((u) => partMass(s.part(u))).reduce((a, b) => a + b);
    expect(s.ejectionSet("p2")).toEqual(["p2", "p3", "p4"]);
    const d = w.ejectPart(s.id, "p2")!;
    expect(d.uid).toBe("p2");
    expect(d.pieces.map((pc) => pc.uid)).toEqual(["p2", "p3", "p4"]);
    expect(s.parts.map((p) => p.uid)).toEqual(["p1"]);
    expect(w.debris).toHaveLength(1);
    expect(w.physics.getMassProps(d.id).mass).toBeCloseTo(leaving, 6);
    const after = momentum(w);
    expect(length({ x: after.x - before.x, y: after.y - before.y })).toBeLessThan(1e-3);
    // Nothing left on the ship is cut off.
    expect(s.networks.members).toHaveLength(1);
  });

  it("parts still attached another way stay (a loop of parts)", () => {
    const { w, s } = ship([
      ["core:test.command", 0, 0],
      ["core:test.square", 1, 0],
      ["core:test.square", 1, 1],
      ["core:test.square", 0, 1],
    ]);
    expect(s.ejectionSet("p2")).toEqual(["p2"]);
    w.ejectPart(s.id, "p2");
    expect(s.parts.map((p) => p.uid)).toEqual(["p1", "p3", "p4"]);
  });

  it("wrecks still hold the structure together: a part attached through a wreck stays", () => {
    const { w, s } = ship([
      ["core:test.command", 0, 0],
      ["core:test.square", 1, 0],
      ["core:test.square", 2, 0],
      ["core:test.square", -1, 0],
    ]);
    s.destroyPart("p2");
    s.updateNetworks();
    expect(s.isCommanded("p3")).toBe(false); // no network through the wreck…
    expect(s.ejectionSet("p4")).toEqual(["p4"]); // …but it is still bolted on
    expect(s.ejectionSet("p2")).toEqual(["p2", "p3"]);
    w.ejectPart(s.id, "p4");
    expect(s.parts.map((p) => p.uid)).toEqual(["p1", "p2", "p3"]);
  });

  it("the command module has an empty ejection set", () => {
    const { s } = ship(row);
    expect(s.ejectionSet("p1")).toEqual([]);
  });

  it("wrecks can be ejected too", () => {
    const { w, s } = ship(row);
    s.destroyPart("p4");
    const d = w.ejectPart(s.id, "p4")!;
    expect(d.pieces[0]!.wreck).toBe(true);
    expect(s.parts.some((p) => p.uid === "p4")).toBe(false);
  });

  it("ejected parts no longer stop rounds aimed at the ship, but the debris does", () => {
    const { w, s } = ship([
      ["core:test.command", 0, 0],
      ["core:test.square", 0, 1],
    ]);
    const pos = w.physics.getBodyState(s.id);
    const hitBefore = raycastWorld(w, add(pos.position, vec2(-10, 1)), vec2(1, 0), 20);
    expect(hitBefore?.kind).toBe("ship");
    const d = w.ejectPart(s.id, "p2")!;
    const hitAfter = raycastWorld(w, add(pos.position, vec2(-10, 1)), vec2(1, 0), 20);
    expect(hitAfter?.kind).toBe("debris");
    expect(hitAfter && "id" in hitAfter ? hitAfter.id : null).toBe(d.id);
  });

  it("an ejected heat sink takes its stored share of the heat with it", () => {
    const { w, s } = ship([
      ["core:test.command", 0, 0],
      ["core:test.heatsink", 1, 0],
    ]);
    s.heat = 0.8 * s.heatCapacity;
    const sinkCap = s.part("p2").def.def.heatSink!.capacity;
    const expectedShare =
      (HEAT.baseCapacity * (partMass(s.part("p2")) / s.massProps.mass) + sinkCap) / s.heatCapacity;
    const h0 = s.heat;
    w.ejectPart(s.id, "p2");
    expect(s.heat).toBeCloseTo(h0 * (1 - Math.min(1, expectedShare)), 3);
  });

  it("ejecting a radiator removes its dissipation and exposes the hull behind it", () => {
    const { w, s } = ship([
      ["core:test.command", 0, 0],
      ["core:test.radiator", 1.5, 0],
    ]);
    w.step();
    expect(s.heatFlow.radiators).toBeGreaterThan(0);
    const hull0 = s.hullExposedLength;
    w.ejectPart(s.id, "p2");
    w.step();
    expect(s.heatFlow.radiators).toBe(0);
    // The radiator's free 0.5 m end stops radiating as hull; the 0.5 m of command edge it covered starts.
    expect(s.hullExposedLength).toBeCloseTo(hull0, 6);
  });

  it("replays with ejection are deterministic", () => {
    const stream = (id: string): InputStream => ({
      formatVersion: 1,
      frames: [
        { tick: 0, ship: id, intent: { thrust: [1, 0], rotate: 0.2 } },
        { tick: 30, ship: id, intent: { thrust: [1, 0], rotate: 0.2, eject: ["p3"] } },
        { tick: 90, ship: id, intent: { thrust: [0, 0], rotate: 0, eject: ["p4"] } },
      ],
    });
    const run = () => {
      const { w, s } = ship([
        ["core:test.command", 0, 0],
        ["core:test.engine", -1, 0],
        ["core:test.fueltank", 0, 1],
        ["core:test.square", 0, -1],
      ]);
      new InputPlayer(stream(s.id)).runWith(w, 240);
      expect(w.debris).toHaveLength(2);
      return w.hash();
    };
    expect(run()).toBe(run());
  });
});
