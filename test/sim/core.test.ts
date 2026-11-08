import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { Rng } from "../../src/sim/core/rng";
import { FixedStepLoop } from "../../src/sim/core/loop";
import { canonicalJson, hashState } from "../../src/sim/core/hash";
import { World } from "../../src/sim/world";

describe("M0 core", () => {
  it("0.1 same seed gives the same 10k-value sequence", () => {
    const a = new Rng(42);
    const b = new Rng(42);
    for (let i = 0; i < 10_000; i++) expect(a.nextU32()).toBe(b.nextU32());
  });

  it("0.2 different seeds give different sequences", () => {
    const a = new Rng(1);
    const b = new Rng(2);
    const sa = Array.from({ length: 16 }, () => a.nextU32());
    const sb = Array.from({ length: 16 }, () => b.nextU32());
    expect(sa).not.toEqual(sb);
  });

  it.each([30, 60, 144])("0.3 %i FPS for 10 s gives 600 ticks ±1", (fps) => {
    let ticks = 0;
    const loop = new FixedStepLoop(() => ticks++);
    for (let f = 0; f < fps * 10; f++) loop.advance(1 / fps);
    expect(Math.abs(ticks - 600)).toBeLessThanOrEqual(1);
  });

  it("0.4 state hash is independent of key insertion order", () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.double({ noNaN: true, noDefaultInfinity: true })), (obj) => {
        const reversed = Object.fromEntries(Object.entries(obj).reverse());
        expect(canonicalJson(reversed)).toBe(canonicalJson(obj));
      }),
    );
  });

  it("0.7 empty world for 1000 ticks hashes identically on two runs", () => {
    const run = () => {
      const w = new World({ seed: 1 });
      w.run(1000);
      return w.hash();
    };
    expect(run()).toBe(run());
  });

  it("physics adapter: dropped box under constant force is deterministic", () => {
    const run = () => {
      const w = new World({ seed: 7 });
      w.physics.createBody({ id: "b-1", type: "dynamic", position: { x: 0, y: 0 }, angle: 0 });
      w.physics.addPolygon("b-1", {
        vertices: [
          { x: -1, y: -1 },
          { x: 1, y: -1 },
          { x: 1, y: 1 },
          { x: -1, y: 1 },
        ],
      });
      w.physics.setMassProps("b-1", { mass: 100, center: { x: 0, y: 0 }, inertia: (100 * 8) / 12 });
      for (let i = 0; i < 60; i++) {
        w.physics.applyForceToCenter("b-1", { x: 100, y: 0 });
        w.step();
      }
      return w;
    };
    const w = run();
    // a = F/m = 1 m/s², after 1 s v ≈ 1 m/s
    expect(w.physics.getBodyState("b-1").linearVelocity.x).toBeCloseTo(1, 6);
    expect(w.hash()).toBe(run().hash());
    expect(hashState({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });
});
