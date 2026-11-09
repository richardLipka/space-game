import { describe, expect, it } from "vitest";
import catalogueJson from "../../src/data/core/catalogue.json";
import { validateCatalogue } from "../../src/data/validate";
import { PartCatalogue } from "../../src/sim/ship/catalogue";
import { FLEET } from "../../src/data/designs/index";
import { validateDesignLayout } from "../../src/editor/validate";
import { designStats } from "../../src/editor/stats";

const r = validateCatalogue(catalogueJson);
if (!r.ok) throw new Error(r.errors.join("\n"));
const cat = PartCatalogue.fromJson(r.value);
const count = (id: string, pred: (partId: string) => boolean) =>
  FLEET.find((d) => d.id === id)!.parts.filter((p) => pred(p.partId)).length;
const has = (s: string) => (p: string) => p.includes(s);

describe("the fleet", () => {
  it("ten designs, each valid with no layout errors or warnings", () => {
    expect(FLEET).toHaveLength(10);
    for (const d of FLEET) {
      const rep = validateDesignLayout(d, cat);
      expect(
        rep.issues.map((i) => i.message),
        d.id,
      ).toEqual([]);
    }
  });

  it("every design is mirror-symmetric about its long axis", () => {
    for (const d of FLEET) {
      const key = (id: string, x: number, y: number) => `${id}|${x.toFixed(3)}|${y.toFixed(3)}`;
      const set = new Set(d.parts.map((p) => key(p.partId, p.x, p.y)));
      const lonely = d.parts.filter((p) => !set.has(key(p.partId, p.x, -p.y))).map((p) => p.uid);
      expect(lonely, d.id).toEqual([]);
    }
  });

  it("each ship carries what its role asks for", () => {
    // Fighters: autocannon turrets; lasers with a reactor and radiators.
    expect(count("fleet-wasp", has("autocannon.turret"))).toBe(2);
    expect(count("fleet-spark", has("laser.turret"))).toBe(2);
    expect(count("fleet-spark", has("reactor"))).toBeGreaterThanOrEqual(1);
    expect(count("fleet-spark", has("radiator"))).toBeGreaterThanOrEqual(2);
    // Gunboats: a large forward gun, forward missiles and PD.
    for (const id of ["fleet-maul", "fleet-needle"]) {
      expect(
        count(id, (p) => p.endsWith(".fixed.m")),
        id,
      ).toBe(1);
      expect(count(id, has("missile.launcher")), id).toBeGreaterThanOrEqual(2);
      expect(count(id, has("weapon.pd.")), id).toBeGreaterThanOrEqual(2);
    }
    // Destroyers: kinetic; missiles + lasers + radiators.
    expect(count("fleet-rapier", (p) => /cannon|autocannon/.test(p))).toBeGreaterThanOrEqual(5);
    expect(count("fleet-viper", has("missile.launcher"))).toBeGreaterThanOrEqual(4);
    expect(count("fleet-viper", has("laser.turret"))).toBeGreaterThanOrEqual(2);
    expect(count("fleet-viper", has("radiator"))).toBeGreaterThanOrEqual(2);
    // Cruisers with PD: forward kinetic; missile broadsides (launchers facing the flanks).
    expect(count("fleet-anvil", has("cannon"))).toBeGreaterThanOrEqual(5);
    const squall = FLEET.find((d) => d.id === "fleet-squall")!;
    const broadside = squall.parts.filter(
      (p) => p.partId.includes("missile.launcher") && Math.abs(Math.abs(p.angle) - 90) < 1e-9,
    );
    expect(broadside.length).toBeGreaterThanOrEqual(8);
    for (const id of ["fleet-anvil", "fleet-squall"])
      expect(count(id, has("weapon.pd.")), id).toBeGreaterThanOrEqual(2);
    // Battleship: heavy turrets and missiles on both flanks.
    const bs = FLEET.find((d) => d.id === "fleet-leviathan")!;
    const flank = (s: string) =>
      bs.parts.filter((p) => p.partId.includes(s) && Math.abs(Math.abs(p.angle) - 90) < 1e-9).length;
    expect(flank("cannon.turret")).toBeGreaterThanOrEqual(8);
    expect(flank("missile.launcher")).toBeGreaterThanOrEqual(8);
    // Carrier: three drone types and PD.
    for (const h of ["hangar.attack", "hangar.pd", "hangar.decoy"])
      expect(count("fleet-ark", has(h)), h).toBeGreaterThanOrEqual(2);
    expect(count("fleet-ark", has("weapon.pd."))).toBeGreaterThanOrEqual(2);
  });

  it("sizes and costs grow with the class", () => {
    const stats = FLEET.map((d) => designStats(d, cat));
    const cost = (i: number) => stats[i]!.cost;
    // Fighters < gunboats < destroyers < cruisers < battleship.
    expect(Math.max(cost(0), cost(1))).toBeLessThan(Math.min(cost(2), cost(3)));
    expect(Math.max(cost(2), cost(3))).toBeLessThan(Math.min(cost(4), cost(5)));
    expect(Math.max(cost(4), cost(5))).toBeLessThan(Math.min(cost(6), cost(7)));
    expect(Math.max(cost(6), cost(7), cost(9))).toBeLessThan(cost(8));
    for (const s of stats) expect(s.power.production).toBeGreaterThan(0);
  });
});
