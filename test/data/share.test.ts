import { describe, expect, it } from "vitest";
import fc from "fast-check";
import coreJson from "../../src/data/core/catalogue.json";
import fighterJson from "../../src/data/designs/demo-fighter.json";
import { validateCatalogue, validateDesign } from "../../src/data/validate";
import type { PartDef } from "../../src/data/schemas/part";
import type { ShipDesign } from "../../src/data/schemas/design";
import { PartCatalogue } from "../../src/sim/ship/catalogue";
import { canonicalJson, contentHash } from "../../src/sim/core/hash";
import {
  buildExport,
  encodeShareCode,
  parseShareText,
  prettyJson,
  type DependencySources,
  type ShipExport,
} from "../../src/data/share/bundle";
import { analyzeImport, applyImport, type ImportContext } from "../../src/data/share/import";
import { MemoryLibrary, designsUsingPart, librarySnapshot } from "../../src/data/share/library";
import { designStats } from "../../src/editor/stats";
import { LayoutIndex } from "../../src/sim/ship/layout";
import { placedParts } from "../../src/editor/placement";

const r = validateCatalogue(coreJson);
if (!r.ok) throw new Error(r.errors.join("\n"));
const core = PartCatalogue.fromJson(r.value);
const fr = validateDesign(fighterJson);
if (!fr.ok) throw new Error(fr.errors.join("\n"));
const fighter = fr.value;
const NOW = "2026-11-08T00:00:00Z";

const square = (id: string, mass: number, extra: Partial<PartDef> = {}): PartDef => ({
  id,
  rev: 1,
  source: "user",
  author: "alice",
  name: id,
  category: "structure",
  outline: [
    [-0.5, -0.5],
    [0.5, -0.5],
    [0.5, 0.5],
    [-0.5, 0.5],
  ],
  edges: ["snap", "snap", "snap", "snap"],
  mass,
  hp: 50,
  cost: 3,
  ...extra,
});
const ion = square("user:alice/engine.ion", 150, {
  category: "propulsion",
  edges: ["snap", "snap", "snap", "function"],
  engine: { thrust: 9000, isp: 3000, gimbalMax: 10, nozzleEdge: 3, powerDraw: 50000, heatAtMax: 1000 },
});
const lightPlate = square("user:alice/plate.light", 10);
const hangar = square("user:alice/hangar.s", 300, {
  category: "hangar",
  edges: ["snap", "snap", "function", "snap"], // launch bay on the outer side
  hangar: { droneType: "drone-x", capacity: 2, launchInterval: 1 },
});
const drone: ShipDesign = {
  ...fighter,
  id: "drone-x",
  name: "Drone X",
  drone: true,
  parts: [
    { uid: "d1", partId: "core:command.s", x: 0, y: 0, angle: 0 },
    { uid: "d2", partId: "user:alice/plate.light", x: 1.25, y: 0, angle: 0 },
  ],
};
const carrier: ShipDesign = {
  ...fighter,
  id: "carrier-1",
  name: "Carrier",
  author: "alice",
  parts: [
    ...fighter.parts,
    { uid: "ion", partId: "user:alice/engine.ion", x: -2.25, y: 1.25, angle: 0 },
    { uid: "hg", partId: "user:alice/hangar.s", x: 0, y: 2.75, angle: 0 },
  ],
};

const srcFor = (parts: PartDef[], designs: ShipDesign[]): DependencySources => ({
  core,
  userParts: new Map(parts.map((p) => [p.id, p])),
  designs: new Map(designs.map((d) => [d.id, d])),
});
const aliceSrc = srcFor([ion, lightPlate, hangar], [drone, carrier]);
const summaryOf = (d: ShipDesign, src: DependencySources) => {
  const cat = new PartCatalogue(core.version, [...core.all().map((p) => p.def), ...src.userParts.values()]);
  const s = designStats(d, cat);
  return { cost: s.cost, mass: s.mass, class: s.shipClass, partCount: s.partCount };
};
const exportOf = (d: ShipDesign, src = aliceSrc, archival = false) =>
  buildExport([d], src, { exportedAt: NOW, archival, summary: summaryOf(d, src) });
const emptyCtx = (): ImportContext => ({ core, userParts: new Map(), designs: new Map() });
const newIds = () => {
  let n = 0;
  return () => `imported-${++n}`;
};

describe("M2 export", () => {
  it("2.19 export → import round trip gives an identical design, connections and mass properties", async () => {
    const bundle = exportOf(carrier);
    const lib = new MemoryLibrary();
    const a = analyzeImport(prettyJson(bundle), emptyCtx());
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    await applyImport(a.plan, lib, { newId: newIds() });
    const back = (await lib.getDesign("carrier-1"))!;
    expect(back).toEqual(carrier);
    const catA = new PartCatalogue(core.version, [...core.all().map((p) => p.def), ion, lightPlate, hangar]);
    const snap = await librarySnapshot(lib);
    const catB = new PartCatalogue(core.version, [
      ...core.all().map((p) => p.def),
      ...snap.userParts.values(),
    ]);
    expect(new LayoutIndex(placedParts(back, catB)).connections()).toEqual(
      new LayoutIndex(placedParts(carrier, catA)).connections(),
    );
    expect(designStats(back, catB)).toEqual(designStats(carrier, catA));
  });

  it("2.20 dependency collection: 2 user parts + hangar with custom drone → exactly 3 parts + 1 drone design", () => {
    const b = exportOf(carrier);
    expect(b.dependencies.parts.map((p) => p.id)).toEqual([
      "user:alice/engine.ion",
      "user:alice/hangar.s",
      "user:alice/plate.light",
    ]);
    expect(b.designs.map((d) => d.id)).toEqual(["carrier-1", "drone-x"]);
    expect(b.format).toBe("spacegame.ship");
  });

  it("2.21 core parts are referenced by hash, not embedded (unless archival)", () => {
    const b = exportOf(carrier);
    expect(b.dependencies.parts.some((p) => p.id.startsWith("core:"))).toBe(false);
    expect(b.core.parts["core:command.s"]).toBe(core.get("core:command.s").hash);
    expect(b.core.archived).toBeUndefined();
    expect(exportOf(carrier, aliceSrc, true).core.archived?.map((p) => p.id)).toEqual(
      Object.keys(b.core.parts),
    );
  });

  it("2.22 content hash ignores key order and formatting", () => {
    fc.assert(
      fc.property(fc.shuffledSubarray(Object.keys(ion), { minLength: Object.keys(ion).length }), (keys) => {
        const reordered = Object.fromEntries(keys.map((k) => [k, (ion as Record<string, unknown>)[k]]));
        const reparsed = JSON.parse(JSON.stringify(reordered, null, 7));
        expect(contentHash(reparsed)).toBe(contentHash(ion));
      }),
    );
    expect(contentHash({ ...ion, mass: 151 })).not.toBe(contentHash(ion));
    expect(canonicalJson({ b: 1, a: 2 }, { quantum: 0 })).toBe('{"a":2,"b":1}');
  });
});

describe("M2 import", () => {
  it("2.23 same user-part id and hash → reused, not duplicated", () => {
    const ctx: ImportContext = { core, userParts: new Map([[ion.id, ion]]), designs: new Map() };
    const a = analyzeImport(exportOf(carrier), ctx);
    expect(a.ok && a.plan.reused).toEqual([ion.id]);
    expect(a.ok && a.plan.newParts.map((p) => p.id)).toEqual([
      "user:alice/hangar.s",
      "user:alice/plate.light",
    ]);
  });

  it("2.24 same id, different hash → renamed ~2, references rewritten, local part untouched", async () => {
    const localIon = { ...ion, engine: { ...ion.engine!, thrust: 1 } };
    const lib = new MemoryLibrary();
    await lib.putPart({ def: localIon });
    const a = analyzeImport(exportOf(carrier), { core, ...(await librarySnapshot(lib)) });
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(a.plan.renamed).toEqual({ [ion.id]: `${ion.id}~2` });
    expect(a.plan.designs[0]!.parts.find((p) => p.uid === "ion")!.partId).toBe(`${ion.id}~2`);
    await applyImport(a.plan, lib, { newId: newIds() });
    expect((await lib.getPart(ion.id))!.def).toEqual(localIon);
    expect((await lib.getPart(`${ion.id}~2`))!.def.engine!.thrust).toBe(9000);
    expect(await designsUsingPart(lib, `${ion.id}~2`)).toEqual(["carrier-1"]);
  });

  it("2.25 missing core part (newer game) → rejected with the missing ids", () => {
    const b = structuredClone(exportOf(fighter, srcFor([], []))) as ShipExport;
    b.core.parts["core:engine.warp"] = "0123456789abcdef";
    b.designs[0]!.parts.push({ uid: "w", partId: "core:engine.warp", x: 9, y: 9, angle: 0 });
    const a = analyzeImport(b, emptyCtx());
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.errors.join()).toContain("core:engine.warp");
  });

  it("2.26 core hash mismatch → warning; pin original keeps the exported definition", async () => {
    const oldEngine = {
      ...core.get("core:engine.main.s").def,
      engine: { ...core.get("core:engine.main.s").def.engine!, thrust: 55555 },
    };
    const oldCore = new PartCatalogue(
      "old",
      core.all().map((p) => (p.id === oldEngine.id ? oldEngine : p.def)),
    );
    const b = buildExport(
      [fighter],
      { core: oldCore, userParts: new Map(), designs: new Map() },
      { exportedAt: NOW, archival: true, summary: summaryOf(fighter, srcFor([], [])) },
    );
    const a = analyzeImport(b, emptyCtx());
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(a.plan.coreMismatches).toEqual(["core:engine.main.s"]);
    expect(a.plan.canPinOriginal).toBe(true);
    expect(a.plan.warnings.join()).toContain("changed since");
    const lib = new MemoryLibrary();
    await applyImport(a.plan, lib, { newId: newIds(), pinOriginal: true });
    const d = (await lib.getDesign(fighter.id))!;
    const pinnedId = d.parts.find((p) => p.uid === "eng")!.partId;
    expect(pinnedId).toMatch(/^user:pinned\/engine\.main\.s~[0-9a-f]{6}$/);
    expect((await lib.getPart(pinnedId))!.def.engine!.thrust).toBe(55555);
    // Without archival data, pinning is not offered.
    const noArchive = analyzeImport({ ...b, core: { ...b.core, archived: undefined } }, emptyCtx());
    expect(noArchive.ok && noArchive.plan.canPinOriginal).toBe(false);
  });

  it("2.27 out-of-range values → rejected with field list, nothing written", async () => {
    const huge = {
      ...ion,
      engine: { ...ion.engine!, thrust: 1e12 },
      outline: Array.from({ length: 10_000 }, (_, i) => [Math.cos(i), Math.sin(i)] as [number, number]),
    };
    const b = exportOf(carrier, srcFor([huge, lightPlate, hangar], [drone]));
    const lib = new MemoryLibrary();
    const a = analyzeImport(b, { core, ...(await librarySnapshot(lib)) });
    expect(a.ok).toBe(false);
    if (!a.ok) {
      expect(a.errors.join("\n")).toContain("engine.thrust");
      expect(a.errors.join("\n")).toContain("vertices");
    }
    expect(lib.parts.size + lib.designs.size).toBe(0);
  });

  it("2.28 tampered summary is ignored; recomputed values are used", () => {
    const b = { ...exportOf(carrier), summary: { cost: 1, mass: 1, class: "drone", partCount: 1 } };
    const a = analyzeImport(b, emptyCtx());
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(a.plan.warnings.join()).toContain("recomputed");
    const cat = new PartCatalogue(core.version, [...core.all().map((p) => p.def), ...a.plan.newParts]);
    expect(designStats(a.plan.designs[0]!, cat).cost).toBe(summaryOf(carrier, aliceSrc).cost);
  });

  it("2.29 newer formatVersion → clear rejection", () => {
    const a = analyzeImport({ ...exportOf(carrier), formatVersion: 99 }, emptyCtx());
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.errors[0]).toMatch(/newer version/);
  });

  it("2.30 SG1 code round trip equals JSON round trip; corrupted code → clean error", () => {
    const b = exportOf(carrier);
    const code = encodeShareCode(b);
    expect(code.startsWith("SG1:")).toBe(true);
    expect(code).not.toMatch(/[\s+/=]/);
    expect(code.length).toBeLessThan(prettyJson(b).length / 3);
    const viaCode = analyzeImport(code, emptyCtx());
    const viaJson = analyzeImport(prettyJson(b), emptyCtx());
    expect(viaCode.ok && viaJson.ok).toBe(true);
    if (viaCode.ok && viaJson.ok) expect(viaCode.plan.designs).toEqual(viaJson.plan.designs);
    const broken = analyzeImport(code.slice(0, code.length - 20) + "AAAA", emptyCtx());
    expect(broken.ok).toBe(false);
    if (!broken.ok) expect(broken.errors[0]).toMatch(/damaged/);
  });

  it("2.31 paste detection: raw JSON, SG1 code and junk text", () => {
    const b = exportOf(fighter, srcFor([], []));
    expect(parseShareText(JSON.stringify(b))).toMatchObject({ ok: true, source: "json" });
    expect(parseShareText(`  ${encodeShareCode(b)}\n`)).toMatchObject({ ok: true, source: "code" });
    expect(parseShareText("hello there")).toMatchObject({ ok: false });
    expect(parseShareText("{ not json")).toMatchObject({ ok: false });
  });

  it("design id collision: replace / keep both / cancel", async () => {
    const lib = new MemoryLibrary();
    await lib.putDesign({ ...carrier, name: "Mine" });
    const a = analyzeImport(exportOf(carrier), { core, ...(await librarySnapshot(lib)) });
    if (!a.ok) throw new Error("unexpected");
    expect(a.plan.designConflicts).toEqual(["carrier-1"]);
    expect((await applyImport(a.plan, lib, { newId: newIds(), onConflict: "cancel" })).applied).toBe(false);
    expect((await lib.getDesign("carrier-1"))!.name).toBe("Mine");
    const kept = await applyImport(a.plan, lib, { newId: newIds(), onConflict: "keep-both" });
    expect(kept.designIds[0]).toBe("imported-1");
    expect((await lib.getDesign("carrier-1"))!.name).toBe("Mine");
    await applyImport(a.plan, lib, { newId: newIds(), onConflict: "replace" });
    expect((await lib.getDesign("carrier-1"))!.name).toBe("Carrier");
  });
});
