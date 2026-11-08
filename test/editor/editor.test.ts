import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { performance } from "node:perf_hooks";
import coreJson from "../../src/data/core/catalogue.json";
import { validateCatalogue } from "../../src/data/validate";
import type { PartPlacement, ShipDesign } from "../../src/data/schemas/design";
import { PartCatalogue } from "../../src/sim/ship/catalogue";
import { LayoutIndex, edgeContact, turretBlockedRanges } from "../../src/sim/ship/layout";
import { degToRad, vec2 } from "../../src/sim/core/vec2";
import { findSnap } from "../../src/editor/snap";
import { layoutOf, placedPart } from "../../src/editor/placement";
import { validateDesignLayout } from "../../src/editor/validate";
import { EditorModel, emptyDesign } from "../../src/editor/model";
import { designStats } from "../../src/editor/stats";
import { mirrorAxis } from "../../src/editor/mirror";
import { makeCruiserDesign } from "../../src/data/designs/generate";
import { buildPropulsion, capabilities } from "../../src/sim/flight/propulsion";
import { computeMassProps, instantiateParts } from "../../src/sim/ship/ship";
import { testCatalogue } from "../helpers";

const test = testCatalogue();
const coreR = validateCatalogue(coreJson);
if (!coreR.ok) throw new Error(coreR.errors.join("\n"));
const core = PartCatalogue.fromJson(coreR.value);

const NOW = "2026-11-08T00:00:00Z";
function designOf(parts: [string, number, number, number?][], id = "d"): ShipDesign {
  return {
    ...emptyDesign(id, id, NOW),
    parts: parts.map(([partId, x, y, angle], i) => ({ uid: `p${i + 1}`, partId, x, y, angle: angle ?? 0 })),
  };
}
const layout = (cat: PartCatalogue, parts: [string, number, number, number?][]) =>
  layoutOf(designOf(parts), cat);
const codes = (cat: PartCatalogue, parts: [string, number, number, number?][]) =>
  validateDesignLayout(designOf(parts), cat).issues.map((i) => `${i.severity}:${i.code}`);

describe("M2 snapping", () => {
  it("2.1 edge within 0.3 m and 10° snaps exactly anti-parallel and collinear", () => {
    const L = layout(test, [["core:test.square", 0, 0]]);
    const def = test.get("core:test.square");
    const snap = findSnap(L, def, vec2(1.2, 0.13), degToRad(7));
    expect(snap).not.toBeNull();
    const placed = new LayoutIndex([
      ...L.parts,
      { uid: "new", def, position: snap!.position, angle: snap!.angle },
    ]);
    const own = placed.edges.get("new")![snap!.ownEdge]!;
    const target = placed.edges.get("p1")![snap!.targetEdge]!;
    expect(edgeContact(own, target, 1e-9, 1e-6)).toBeGreaterThan(0.5);
    // Endpoint alignment kicked in (0.13 < 0.15) so it sits flush.
    expect(snap!.position.y).toBeCloseTo(0, 6);
    expect(snap!.position.x).toBeCloseTo(1, 6);
  });

  it("2.1b no snap when farther than 0.3 m or more than 10° off", () => {
    const L = layout(test, [["core:test.square", 0, 0]]);
    const def = test.get("core:test.square");
    expect(findSnap(L, def, vec2(1.4, 0), 0)).toBeNull();
    expect(findSnap(L, def, vec2(1.1, 0), degToRad(30))).toBeNull();
  });

  it("2.2 snapping to hull or function edges is rejected", () => {
    const L = layout(core, [["core:hull.wedge.m", 0, 0]]);
    const sq = core.get("core:hull.square.s");
    expect(findSnap(L, sq, vec2(1.6, 0), 0)).toBeNull(); // nose edge is hull
    expect(findSnap(L, sq, vec2(-1.6, 0), 0)).not.toBeNull(); // back edge is snap
  });
});

describe("M2 connections", () => {
  const conns = (parts: [string, number, number, number?][]) => layout(test, parts).connections();

  it("2.3 overlap 0.3 m ≥ 0.25 m → connected with overlapLength 0.3", () => {
    const c = conns([
      ["core:test.square", 0, 0],
      ["core:test.square", 1, 0.7],
    ]);
    expect(c).toHaveLength(1);
    expect(c[0]!.overlap).toBeCloseTo(0.3, 9);
  });

  it("2.4 overlap 0.2 m → not connected", () => {
    expect(
      conns([
        ["core:test.square", 0, 0],
        ["core:test.square", 1, 0.8],
      ]),
    ).toHaveLength(0);
  });

  it("2.5 parallel edges 2 cm apart, or 1° off → not connected", () => {
    expect(
      conns([
        ["core:test.square", 0, 0],
        ["core:test.square", 1.02, 0],
      ]),
    ).toHaveLength(0);
    expect(
      conns([
        ["core:test.square", 0, 0],
        ["core:test.square", 1, 0, 1],
      ]),
    ).toHaveLength(0);
    expect(
      conns([
        ["core:test.square", 0, 0],
        ["core:test.square", 1.005, 0],
      ]),
    ).toHaveLength(1);
  });

  const grid = fc.array(
    fc.record({ x: fc.integer({ min: -6, max: 6 }), y: fc.integer({ min: -6, max: 6 }) }),
    { minLength: 2, maxLength: 14 },
  );
  const pairSet = (L: LayoutIndex) =>
    L.connections()
      .map((c) => [c.a, c.b].sort().join("|"))
      .sort();

  it("2.6 connections are symmetric and independent of part order", () => {
    fc.assert(
      fc.property(grid, fc.integer(), (cells, seed) => {
        const parts = cells.map((c, i) =>
          placedPart(
            { uid: `u${i}`, partId: "core:test.square", x: c.x * 0.5, y: c.y * 0.5, angle: 0 },
            test,
          ),
        );
        const shuffled = [...parts].sort(
          (a, b) => ((a.uid.charCodeAt(1) * 31 + seed) % 7) - ((b.uid.charCodeAt(1) * 31 + seed) % 7),
        );
        expect(pairSet(new LayoutIndex(shuffled))).toEqual(pairSet(new LayoutIndex(parts)));
        for (const c of new LayoutIndex(parts).connections()) expect(c.a < c.b).toBe(true);
      }),
    );
  });

  it("2.7 rigid transform of the whole design keeps the connection set", () => {
    fc.assert(
      fc.property(
        grid,
        fc.double({ min: -Math.PI, max: Math.PI, noNaN: true }),
        fc.double({ min: -50, max: 50, noNaN: true }),
        (cells, rot, dx) => {
          const base = cells.map((c, i) => ({ uid: `u${i}`, x: c.x * 0.5, y: c.y * 0.5 }));
          const a = base.map((b) => placedPart({ ...b, partId: "core:test.square", angle: 0 }, test));
          const cs = Math.cos(rot),
            sn = Math.sin(rot);
          const b = base.map((p) =>
            placedPart(
              {
                uid: p.uid,
                partId: "core:test.square",
                x: p.x * cs - p.y * sn + dx,
                y: p.x * sn + p.y * cs,
                angle: (rot * 180) / Math.PI,
              },
              test,
            ),
          );
          expect(pairSet(new LayoutIndex(b))).toEqual(pairSet(new LayoutIndex(a)));
        },
      ),
    );
  });
});

describe("M2 validation", () => {
  it("2.8 shared edge → no overlap; 1 cm overlap → error", () => {
    expect(
      layout(test, [
        ["core:test.square", 0, 0],
        ["core:test.square", 1, 0],
      ]).overlaps(),
    ).toHaveLength(0);
    expect(
      codes(test, [
        ["core:test.command", 0, 0],
        ["core:test.square", 0.99, 0],
      ]),
    ).toContain("error:overlap");
  });

  it("2.9 zero or two command modules → error", () => {
    expect(codes(test, [["core:test.square", 0, 0]])).toContain("error:command-count");
    expect(
      codes(test, [
        ["core:test.command", 0, 0],
        ["core:test.command", 1, 0],
      ]),
    ).toContain("error:command-count");
    expect(codes(test, [["core:test.command", 0, 0]])).not.toContain("error:command-count");
  });

  it("2.10 disconnected island → error naming its parts", () => {
    const r = validateDesignLayout(
      designOf([
        ["core:test.command", 0, 0],
        ["core:test.square", 1, 0],
        ["core:test.square", 5, 0],
        ["core:test.square", 6, 0],
      ]),
      test,
    );
    const island = r.issues.find((i) => i.code === "disconnected");
    expect(island?.parts).toEqual(["p3", "p4"]);
  });

  it("2.11 hull edge covered by a part → error", () => {
    expect(
      codes(core, [
        ["core:command.s", -1.75, 0],
        ["core:hull.wedge.m", 0, 0],
        ["core:hull.square.s", 1.5, 0],
      ]),
    ).toContain("error:covered-edge");
    expect(
      codes(core, [
        ["core:command.s", -1.75, 0],
        ["core:hull.wedge.m", 0, 0],
      ]),
    ).not.toContain("error:covered-edge");
  });

  it("2.12 part blocking the exhaust ray → error", () => {
    const ok = [
      ["core:test.command", 1, 0],
      ["core:test.engine", 0, 0],
    ] as [string, number, number][];
    expect(codes(test, ok)).not.toContain("error:exhaust-blocked");
    expect(codes(test, [...ok, ["core:test.square", -6, 0]])).toContain("error:exhaust-blocked");
    expect(codes(test, [...ok, ["core:test.square", -6, 3]])).not.toContain("error:exhaust-blocked");
  });

  it("2.13 main engine outside gimbal reach → warning, not error", () => {
    const c = codes(test, [
      ["core:test.engine", 0, 0],
      ["core:test.command", 1, 0],
      ["core:test.rect", 1.5, 1],
      ["core:test.rect", 1.5, 2],
    ]);
    expect(c).toContain("warning:out-of-gimbal");
    expect(c.filter((x) => x.startsWith("error:"))).toEqual([]);
  });

  it("2.14 radiator with half its function edge covered → exposedFraction 0.5", () => {
    const L = layout(core, [
      ["core:radiator.s", 0, 0],
      ["core:hull.square.s", 0.5, -0.75],
    ]);
    expect(L.exposedFraction("p1", 0)).toBeCloseTo(0.5, 6);
    expect(L.exposedFraction("p1", 2)).toBeCloseTo(1, 6);
  });

  it("2.15 turret occlusion by a block matches the analytic angle ±0.5°", () => {
    const L = layout(core, [
      ["core:weapon.autocannon.turret.s", 0, 0],
      ["core:hull.square.m", 3, 0],
    ]);
    const ranges = turretBlockedRanges(L, L.parts[0]!);
    expect(ranges).toHaveLength(1);
    const half = (Math.atan2(1, 2) * 180) / Math.PI;
    expect(Math.abs(ranges[0]![0] + half)).toBeLessThan(0.5);
    expect(Math.abs(ranges[0]![1] - half)).toBeLessThan(0.5);
  });
});

describe("M2 editor model", () => {
  it("2.16 mirror mode places twins; symmetric design has CoM on the axis and balanced thrust", () => {
    const m = new EditorModel(core, emptyDesign("m", "m", NOW), () => NOW);
    m.mirror = true;
    m.addPart("core:command.s", 0, 0, 0);
    expect(m.design.parts).toHaveLength(1); // on the axis → no twin
    m.addPart("core:hull.square.s", 0, 1.25, 0);
    m.addPart("core:rcs.s", 0, 2, Math.PI);
    m.addPart("core:engine.main.s", -1.25, 1.25, 0);
    m.addPart("core:weapon.autocannon.turret.s", 0.75, 2.6, degToRad(30));
    expect(m.design.parts).toHaveLength(9);
    const parts = instantiateParts(m.design, core);
    const mp = computeMassProps(parts);
    expect(mp.center.y).toBeCloseTo(0, 9);
    const caps = capabilities(buildPropulsion(parts, mp, true).actuators);
    expect(caps.left).toBeCloseTo(caps.right, 6);
    expect(caps.torqueCcw).toBeCloseTo(caps.torqueCw, 6);
    // Moving one part moves its twin.
    const uid = m.design.parts.find((p) => p.partId === "core:hull.square.s" && p.y > 0)!.uid;
    m.beginDrag();
    m.dragTo(uid, 0.5, 1.5, 0);
    m.endDrag();
    const twin = m.design.parts.find((p) => p.partId === "core:hull.square.s" && p.y < 0)!;
    expect([twin.x, twin.y]).toEqual([0.5, -1.5]);
    expect(mirrorAxis(core.get("core:rcs.s"))).toBeCloseTo(Math.PI / 2, 9);
    expect(mirrorAxis(core.get("core:engine.main.s"))).toBe(0);
  });

  it("2.17 50 random edits then undo all → original design", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(
            fc.integer({ min: 0, max: 4 }),
            fc.double({ min: -5, max: 5, noNaN: true }),
            fc.double({ min: -5, max: 5, noNaN: true }),
          ),
          { minLength: 50, maxLength: 50 },
        ),
        (ops) => {
          const start = designOf([
            ["core:command.s", 0, 0],
            ["core:hull.square.s", 1.25, 0],
          ]);
          const m = new EditorModel(core, start, () => NOW);
          let steps = 0;
          for (const [op, x, y] of ops) {
            const uids = m.design.parts.map((p) => p.uid);
            const target = uids[Math.abs(Math.round(x * 10)) % Math.max(1, uids.length)];
            if (op === 0 || !target) m.addPart("core:hull.square.s", x, y, y);
            else if (op === 1) m.removeParts([target]);
            else if (op === 2) {
              m.beginDrag();
              m.dragTo(target, x, y, x);
              m.dragTo(target, y, x, y);
              m.endDrag();
            } else if (op === 3) m.setWeaponGroup(target, 1 + (Math.abs(Math.round(y)) % 9));
            else m.rename(`n${x.toFixed(2)}`);
            steps++;
          }
          for (let i = 0; i < steps; i++) expect(m.undo()).toBe(true);
          expect(m.undo()).toBe(false);
          expect(m.design).toEqual(start);
          for (let i = 0; i < steps; i++) m.redo();
          expect(m.canRedo).toBe(false);
        },
      ),
      { numRuns: 20 },
    );
  });

  it("2.18 stats equal the flight-model values for the same design", () => {
    const d = makeCruiserDesign();
    const s = designStats(d, core);
    const parts = instantiateParts(d, core);
    const mp = computeMassProps(parts);
    const caps = capabilities(buildPropulsion(parts, mp, true).actuators);
    expect(s.mass).toBe(mp.mass);
    expect(s.inertia).toBe(mp.inertia);
    expect(s.accel.fwd).toBe(caps.fwd / mp.mass);
    expect(s.shipClass).toBe("frigate");
    expect(s.fuel.deltaV).toBeGreaterThan(0);
  });
});

describe("M2 performance", () => {
  it("2.35 snapping and validation for a 300-part design stay under the frame budget", () => {
    const c = makeCruiserDesign();
    const shifted: PartPlacement[] = c.parts.map((p) => ({ ...p, uid: `${p.uid}b`, y: p.y + 20 }));
    const big: ShipDesign = { ...c, parts: [...c.parts, ...shifted] };
    expect(big.parts.length).toBeGreaterThanOrEqual(300);
    const L = layoutOf(big, core);
    const def = core.get("core:hull.square.m");
    const t0 = performance.now();
    for (let i = 0; i < 50; i++) findSnap(L, def, vec2(-10 + i * 0.4, 8.2), 0);
    const snapMs = (performance.now() - t0) / 50;

    const t1 = performance.now();
    const runs = 5;
    for (let i = 0; i < runs; i++) validateDesignLayout(big, core);
    const validateMs = (performance.now() - t1) / runs;
    console.log(`300 parts: snap ${snapMs.toFixed(2)} ms/frame, full validation ${validateMs.toFixed(1)} ms`);
    expect(snapMs).toBeLessThan(8);
    expect(validateMs).toBeLessThan(8 * 4); // validation runs on drop, not every frame
  });
});

describe("M2 empty design", () => {
  it("validation, stats and layout handle an empty design without throwing", () => {
    const m = new EditorModel(core, emptyDesign("e", "e", NOW), () => NOW);
    expect(m.report.valid).toBe(false);
    expect(m.report.issues[0]!.code).toBe("command-count");
    expect(m.stats).toBeNull();
    expect(m.layout.parts).toHaveLength(0);
  });
});

describe("editor connection guidance", () => {
  it("preview reports connect / short / blocked contacts and the hint explains them", async () => {
    const { previewPlacement, describePreview, attachEdges } = await import("../../src/editor/guide");
    const L = layout(core, [
      ["core:command.s", 0, 0],
      ["core:hull.wedge.m", 1.75, 0],
    ]);
    const sq = core.get("core:hull.square.s");
    // Flush against the command module's top edge: connects with 1 m shared.
    const ok = previewPlacement(L, sq, vec2(0, 1.25), 0);
    expect(ok.connected).toBe(true);
    expect(ok.contacts.find((c) => c.kind === "connect")!.overlap).toBeCloseTo(1, 6);
    expect(describePreview(ok, false, "Hull plate S").text).toMatch(
      /^✓ Connects to Command module \(1\.00 m/,
    );
    // Only 0.2 m of edge overlap at the corner: touches but too short.
    const short = previewPlacement(L, sq, vec2(-1.05, 1.25), 0);
    expect(short.connected).toBe(false);
    expect(describePreview(short, false, "Hull plate S").text).toMatch(/only 0\.20 m/);
    // Against the wedge's slanted hull edge region: blocked (nose edge x = 2.75 is hull).
    const blocked = previewPlacement(L, sq, vec2(3.25, 0), 0);
    expect(blocked.contacts.some((c) => c.kind === "blocked" && c.blockedType === "hull")).toBe(true);
    expect(describePreview(blocked, false, "Hull plate S").text).toMatch(/outer hull edge/);
    // Just short of the nose (hull edge): explains that nothing can attach there.
    const nearNose = previewPlacement(L, sq, vec2(3.3, 0.1), 0);
    expect(describePreview(nearNose, false, "Hull plate S").text).toMatch(
      /outer hull edge of Nose wedge M: nothing can attach/,
    );
    // Floating: not connected.
    const far = previewPlacement(L, sq, vec2(0, 5), 0);
    expect(describePreview(far, false, "Hull plate S").text).toMatch(/^Not connected/);
    // Overlap wins over everything.
    expect(describePreview(previewPlacement(L, sq, vec2(0, 0.5), 0), false, "x").level).toBe("error");
    // Attach edges: wedge contributes only no-attach edges except its back (snap, covered by the command module).
    const edges = attachEdges(L);
    expect(edges.free.every((e) => e.uid === "p1")).toBe(true);
    expect(edges.free).toHaveLength(3);
    expect(edges.noAttach.filter((e) => e.uid === "p2")).toHaveLength(3);
  });
});
