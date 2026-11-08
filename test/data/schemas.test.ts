import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  validateCatalogue,
  validateDesign,
  validateInputs,
  validatePart,
  validateScenario,
} from "../../src/data/validate";

const fx = (p: string) => join(__dirname, "..", "fixtures", p);
const load = (p: string): unknown => JSON.parse(readFileSync(fx(p), "utf8"));
const clone = <T>(v: T): T => structuredClone(v);

describe("0.5 schema validation", () => {
  it("valid fixtures pass", () => {
    const cat = validateCatalogue(load("parts/test-catalogue.json"));
    expect(cat.ok ? [] : cat.errors).toEqual([]);
    for (const f of readdirSync(fx("designs"))) {
      const r = validateDesign(load(`designs/${f}`));
      expect(r.ok ? [] : r.errors, f).toEqual([]);
    }
    for (const f of readdirSync(fx("scenarios"))) {
      const r = validateScenario(load(`scenarios/${f}`));
      expect(r.ok ? [] : r.errors, f).toEqual([]);
    }
    const inp = validateInputs(load("inputs/idle.json"));
    expect(inp.ok).toBe(true);
  });

  const part = () =>
    clone((load("parts/test-catalogue.json") as { parts: Record<string, unknown>[] }).parts[0]!);

  it("missing field fails with readable path", () => {
    const p = part();
    delete p.mass;
    const r = validatePart(p);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toContain('/: missing property "mass"');
  });

  it("wrong type fails with readable path", () => {
    const p = part();
    p.outline = [
      [0, 0],
      ["a", 0],
      [1, 1],
    ];
    const r = validatePart(p);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.startsWith("/outline/1/0"))).toBe(true);
  });

  it("extra field fails with readable path", () => {
    const p = part();
    p.colour = "red";
    const r = validatePart(p);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toContain('/: unexpected property "colour"');
  });

  it("semantic checks: edge count, winding, convexity, nozzle edge", () => {
    const p = part();
    p.edges = ["snap", "snap", "snap"];
    expect(validatePart(p).ok).toBe(false);

    const cw = part();
    cw.outline = [...(cw.outline as unknown[])].reverse();
    const r = validatePart(cw);
    expect(!r.ok && r.errors.some((e) => e.includes("counter-clockwise"))).toBe(true);

    const cat = load("parts/test-catalogue.json") as { parts: Record<string, unknown>[] };
    const l = clone(cat.parts.find((x) => x.id === "core:test.lshape")!);
    delete l.convexPieces;
    const rl = validatePart(l);
    expect(!rl.ok && rl.errors.some((e) => e.includes("convexPieces"))).toBe(true);

    const eng = clone(cat.parts.find((x) => x.id === "core:test.engine")!);
    (eng.engine as { nozzleEdge: number }).nozzleEdge = 0;
    expect(validatePart(eng).ok).toBe(false);
  });

  it("bad part id prefix and duplicate ids are rejected", () => {
    const p = part();
    p.id = "engine.main";
    expect(validatePart(p).ok).toBe(false);
    const cat = load("parts/test-catalogue.json") as { parts: unknown[] };
    cat.parts.push(clone(cat.parts[0]));
    const r = validateCatalogue(cat);
    expect(!r.ok && r.errors.some((e) => e.includes("duplicate"))).toBe(true);
  });

  it("design: duplicate uids rejected; scenario: concave asteroid rejected; inputs: unordered ticks rejected", () => {
    const d = load("designs/main-only.json") as { parts: { uid: string }[] };
    d.parts[1]!.uid = d.parts[0]!.uid;
    expect(validateDesign(d).ok).toBe(false);

    const s = load("scenarios/asteroid-field.json") as { arena: { asteroids: { outline: number[][] }[] } };
    s.arena.asteroids[0]!.outline = [
      [0, 0],
      [2, 0],
      [1, 0.2],
      [1, 2],
    ];
    expect(validateScenario(s).ok).toBe(false);

    const frame = (tick: number) => ({ tick, ship: "a", intent: { thrust: [0, 0], rotate: 0 } });
    expect(validateInputs({ formatVersion: 1, frames: [frame(5), frame(2)] }).ok).toBe(false);
  });
});
