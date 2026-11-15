import { describe, expect, it } from "vitest";
import catalogueJson from "../../src/data/core/catalogue.json";
import { validateCatalogue } from "../../src/data/validate";
import { PartCatalogue } from "../../src/sim/ship/catalogue";
import { World } from "../../src/sim/world";
import { length, vec2 } from "../../src/sim/core/vec2";
import { burstKind, burstPush } from "../../src/sim/flight/burst";
import { IDLE_INTENT, type BurstKind } from "../../src/sim/flight/controller";
import type { ShipDesign } from "../../src/data/schemas/design";
import { design, testCatalogue } from "../helpers";

const core = validateCatalogue(catalogueJson);
if (!core.ok) throw new Error(core.errors.join("\n"));
const burstDef = core.value.parts.find((p) => p.id === "core:burst.s")!;
const cat = new PartCatalogue("test+burst", [
  ...["core:test.command", "core:test.fueltank", "core:test.square"].map((id) => testCatalogue().get(id).def),
  burstDef,
]);

/**
 * Command module in the middle, fuel tank behind, a block on the left. A burst engine off-centre on the right
 * pushing left (nozzle outward), and one in front with its nozzle forward (a retro burst).
 */
function burstShip(): ShipDesign {
  const parts: [string, number, number, number][] = [
    ["core:test.command", 0, 0, 0],
    ["core:test.fueltank", -1, 0, 0],
    ["core:test.square", -1, 1, 0],
    ["core:burst.s", -1, -1, 0],
    ["core:burst.s", 1, 0, 90],
  ];
  return {
    ...design("brick"),
    id: "burster",
    name: "Burster",
    parts: parts.map(([partId, x, y, angle], i) => ({ uid: `p${i}`, partId, x, y, angle })),
  };
}

function setup() {
  const w = new World({ seed: 1 });
  const ship = w.addShip(burstShip(), cat);
  const fuel = ship.parts.find((p) => p.def.def.fuelTank)!;
  fuel.fuel = fuel.def.def.fuelTank!.capacity;
  return { w, ship, state: () => w.physics.getBodyState(ship.id) };
}

function burst(w: World, id: string, kind: BurstKind, ticks: number): void {
  w.setIntent(id, { ...IDLE_INTENT, burst: kind });
  for (let i = 0; i < ticks; i++) w.step();
}

describe("burst engines", () => {
  it("classifies engines by the way they push", () => {
    expect(burstKind(vec2(0, 1))).toBe("left");
    expect(burstKind(vec2(0, -1))).toBe("right");
    expect(burstKind(vec2(1, 0))).toBe("forward");
    expect(burstKind(vec2(-1, 0))).toBe("back");
  });

  it("a retro burst pushes against the velocity and never more than stops the ship", () => {
    const ship = { angle: 0, velocity: vec2(0, 3), reference: vec2(0, 0), mass: 100, dt: 1 / 60 };
    const f = burstPush("back", vec2(-1, 0), 1e9, ship);
    expect(f.x).toBeCloseTo(0, 6);
    expect(f.y).toBeCloseTo((-100 * 3) / (1 / 60), 3);
    expect(length(burstPush("back", vec2(-1, 0), 10, { ...ship, velocity: vec2(0, 0) }))).toBe(0);
  });

  it("an off-centre side burst jolts the ship sideways without turning it, then cools down", () => {
    const { w, ship, state } = setup();
    const before = ship.totalFuel;
    burst(w, ship.id, "left", 40);
    const s = state();
    expect(s.linearVelocity.y).toBeGreaterThan(5);
    expect(Math.abs(s.linearVelocity.x)).toBeLessThan(0.05);
    expect(Math.abs(s.angularVelocity)).toBeLessThan(1e-6);
    expect(ship.totalFuel).toBeLessThan(before);
    const side = ship.burstEngines.find((p) => p.uid === "p3")!;
    expect(ship.burstReadyIn(side.uid)).toBeGreaterThan(0);
    // Still cooling down: a second press does nothing.
    const vy = s.linearVelocity.y;
    burst(w, ship.id, "left", 10);
    expect(state().linearVelocity.y).toBeCloseTo(vy, 6);
  });

  it("the front engine fires a retro burst against the velocity", () => {
    const { w, ship, state } = setup();
    w.physics.setLinearVelocity(ship.id, vec2(3, 4));
    burst(w, ship.id, "back", 40);
    const v = state().linearVelocity;
    expect(length(v)).toBeLessThan(0.01);
    expect(Math.abs(state().angularVelocity)).toBeLessThan(1e-6);
  });

  it("no burst engine of that kind: nothing happens", () => {
    const { w, ship, state } = setup();
    burst(w, ship.id, "right", 20);
    expect(length(state().linearVelocity)).toBeLessThan(1e-9);
  });
});
