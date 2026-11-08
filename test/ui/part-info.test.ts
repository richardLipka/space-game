import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { validateCatalogue, partSemanticErrors } from "../../src/data/validate";
import { matchesSearch, partInfoRows } from "../../src/ui/editor/part-info";
import type { PartDef } from "../../src/data/schemas/part";

const core = validateCatalogue(
  JSON.parse(readFileSync(new URL("../../src/data/core/catalogue.json", import.meta.url), "utf8")),
);
if (!core.ok) throw new Error(core.errors.join("\n"));
const parts = core.value.parts;
const byId = (id: string) => parts.find((p) => p.id === id)!;

describe("palette search", () => {
  it("matches name, id, category and weapon kind/mount, case-insensitively, all terms required", () => {
    const hits = (q: string) => parts.filter((p) => matchesSearch(p, q)).map((p) => p.id);
    expect(hits("TURRET")).toEqual(
      expect.arrayContaining(["core:weapon.autocannon.turret.s", "core:weapon.cannon.turret.m"]),
    );
    expect(hits("turret")).not.toContain("core:weapon.cannon.fixed.m");
    expect(hits("propulsion")).toContain("core:rcs.s");
    expect(hits("heavy cannon")).toEqual(["core:weapon.cannon.turret.m"]);
    expect(hits("core:hull.square.s")).toEqual(["core:hull.square.s"]);
    expect(hits("autocannon-30")).toEqual(
      expect.arrayContaining(["core:magazine.autocannon.s", "core:weapon.autocannon.turret.light"]),
    );
    expect(hits("zzz")).toEqual([]);
    expect(hits("   ")).toHaveLength(parts.length);
  });
});

describe("part info", () => {
  it("turrets show their turn rate, so different turrets can be compared", () => {
    const rate = (id: string) => partInfoRows(byId(id)).find(([k]) => k === "Turn rate")?.[1];
    expect(rate("core:weapon.autocannon.turret.light")).toBe("240°/s");
    expect(rate("core:weapon.autocannon.turret.s")).toBe("120°/s");
    expect(rate("core:weapon.cannon.turret.m")).toBe("35°/s");
    expect(rate("core:weapon.cannon.fixed.m")).toBeUndefined();
  });

  it("heat producers list their heat; radiators their dissipation", () => {
    const rows = (id: string) => Object.fromEntries(partInfoRows(byId(id)));
    expect(rows("core:engine.main.s")["Heat at full"]).toBeDefined();
    expect(rows("core:reactor.s")["Heat"]).toMatch(/% of output/);
    expect(rows("core:radiator.s")["Dissipation"]).toMatch(/kW/);
    expect(rows("core:weapon.autocannon.turret.s")["Heat firing"]).toBeDefined();
  });

  it("every core turret has a traverse rate; a turret without one is rejected", () => {
    for (const p of parts) if (p.weapon?.mount === "turret") expect(p.weapon.traverseRate).toBeGreaterThan(0);
    const bad: PartDef = {
      ...byId("core:weapon.autocannon.turret.s"),
      weapon: { ...byId("core:weapon.autocannon.turret.s").weapon! },
    };
    delete (bad.weapon as { traverseRate?: number }).traverseRate;
    expect(partSemanticErrors(bad).join()).toMatch(/traverseRate/);
  });
});
