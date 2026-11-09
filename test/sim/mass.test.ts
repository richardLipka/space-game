import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { polygonArea, polygonCentroid, shapeMassInfo } from "../../src/sim/core/geometry";
import { vec2, type Vec2 } from "../../src/sim/core/vec2";
import { computeMassProps, instantiateParts, partMass, type PartInstance } from "../../src/sim/ship/ship";
import { design, testCatalogue } from "../helpers";

const square: Vec2[] = [vec2(0, 0), vec2(1, 0), vec2(1, 1), vec2(0, 1)];
const tri: Vec2[] = [vec2(0, 0), vec2(1, 0), vec2(0, 1)];
const hexagon: Vec2[] = Array.from({ length: 6 }, (_, i) =>
  vec2(Math.cos((i * Math.PI) / 3), Math.sin((i * Math.PI) / 3)),
);

describe("M1 geometry and mass properties", () => {
  it("1.1 area and centroid of square, right triangle, hexagon", () => {
    expect(polygonArea(square)).toBeCloseTo(1, 9);
    expect(polygonCentroid(square)).toEqual({ x: 0.5, y: 0.5 });
    expect(polygonArea(tri)).toBeCloseTo(0.5, 9);
    const c = polygonCentroid(tri);
    expect(c.x).toBeCloseTo(1 / 3, 9);
    expect(c.y).toBeCloseTo(1 / 3, 9);
    expect(polygonArea(hexagon)).toBeCloseTo((3 * Math.sqrt(3)) / 2, 9);
    const h = polygonCentroid(hexagon);
    expect(h.x).toBeCloseTo(0, 9);
    expect(h.y).toBeCloseTo(0, 9);
  });

  it("1.2 inertia of a uniform rectangle is m(w²+h²)/12", () => {
    const w = 3;
    const h = 0.7;
    const rect = [vec2(5, 5), vec2(5 + w, 5), vec2(5 + w, 5 + h), vec2(5, 5 + h)];
    const m = 250;
    expect(m * shapeMassInfo([rect]).unitInertia).toBeCloseTo((m * (w * w + h * h)) / 12, 9);
  });

  it("1.3 concave L from 2 convex pieces equals triangle decomposition", () => {
    const pieces = [
      [vec2(0, 0), vec2(2, 0), vec2(2, 1), vec2(0, 1)],
      [vec2(0, 1), vec2(1, 1), vec2(1, 2), vec2(0, 2)],
    ];
    // Fan triangulation of the L outline from vertex 0.
    const outline = [vec2(0, 0), vec2(2, 0), vec2(2, 1), vec2(1, 1), vec2(1, 2), vec2(0, 2)];
    const tris = [1, 2, 3, 4].map((i) => [outline[0]!, outline[i]!, outline[i + 1]!]);
    const a = shapeMassInfo(pieces);
    const b = shapeMassInfo(tris);
    expect(a.area).toBeCloseTo(b.area, 9);
    expect(a.centroid.x).toBeCloseTo(b.centroid.x, 9);
    expect(a.centroid.y).toBeCloseTo(b.centroid.y, 9);
    expect(a.unitInertia).toBeCloseTo(b.unitInertia, 9);
  });

  it("1.4 dumbbell: CoM at origin, I = 2(I_local + 100·25)", () => {
    const parts = instantiateParts(design("dumbbell"), testCatalogue());
    const mp = computeMassProps(parts);
    expect(mp.center.x).toBeCloseTo(0, 9);
    expect(mp.center.y).toBeCloseTo(0, 9);
    const iLocal = (100 * (1 + 1)) / 12;
    expect(mp.inertia).toBeCloseTo(2 * (iLocal + 100 * 25), 9);
  });

  const cat = testCatalogue();
  const partIds = cat.all().map((p) => p.id);
  const arbParts = fc.array(
    fc.record({
      id: fc.constantFrom(...partIds),
      x: fc.double({ min: -50, max: 50, noNaN: true }),
      y: fc.double({ min: -50, max: 50, noNaN: true }),
      a: fc.double({ min: -Math.PI, max: Math.PI, noNaN: true }),
      fuel: fc.double({ min: 0, max: 1, noNaN: true }),
    }),
    { minLength: 1, maxLength: 12 },
  );
  const build = (spec: { id: string; x: number; y: number; a: number; fuel: number }[]): PartInstance[] =>
    spec.map((s, i) => {
      const def = cat.get(s.id);
      return {
        uid: `p${i}`,
        def,
        position: vec2(s.x, s.y),
        angle: s.a,
        hp: def.def.hp,
        fuel: (def.def.fuelTank?.capacity ?? 0) * s.fuel,
        charge: 0,
        ammo: 0,
        wreckHp: def.def.hp,
      };
    });

  it("1.5 rigid transform of a whole design keeps mass and inertia; CoM moves with it", () => {
    fc.assert(
      fc.property(
        arbParts,
        fc.double({ min: -Math.PI, max: Math.PI, noNaN: true }),
        fc.double({ min: -100, max: 100, noNaN: true }),
        (spec, rot, dx) => {
          const parts = build(spec);
          const moved = parts.map((p) => {
            const c = Math.cos(rot);
            const s = Math.sin(rot);
            return {
              ...p,
              position: vec2(p.position.x * c - p.position.y * s + dx, p.position.x * s + p.position.y * c),
              angle: p.angle + rot,
            };
          });
          const a = computeMassProps(parts);
          const b = computeMassProps(moved);
          expect(b.mass).toBeCloseTo(a.mass, 6);
          expect(b.inertia / a.inertia).toBeCloseTo(1, 6);
          const c = Math.cos(rot);
          const s = Math.sin(rot);
          expect(b.center.x).toBeCloseTo(a.center.x * c - a.center.y * s + dx, 6);
          expect(b.center.y).toBeCloseTo(a.center.x * s + a.center.y * c, 6);
        },
      ),
    );
  });

  it("1.6 total mass equals the sum of part masses", () => {
    fc.assert(
      fc.property(arbParts, (spec) => {
        const parts = build(spec);
        const sum = parts.reduce((s, p) => s + partMass(p), 0);
        expect(computeMassProps(parts).mass).toBe(sum);
      }),
    );
  });
});
