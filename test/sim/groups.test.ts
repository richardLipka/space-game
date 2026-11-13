import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { ShipDesign } from "../../src/data/schemas/design";
import { validateCatalogue, validateDesign } from "../../src/data/validate";
import { PartCatalogue } from "../../src/sim/ship/catalogue";
import { World } from "../../src/sim/world";
import { vec2 } from "../../src/sim/core/vec2";
import { orderByPriority, type Contact } from "../../src/sim/combat/targeting";
import { spawnMissile } from "../../src/sim/combat/missiles";
import { EditorModel } from "../../src/editor/model";
import { validateDesignLayout } from "../../src/editor/validate";

const read = (p: string): unknown =>
  JSON.parse(readFileSync(new URL(`../../src/data/${p}`, import.meta.url), "utf8"));
const catR = validateCatalogue(read("core/catalogue.json"));
if (!catR.ok) throw new Error(catR.errors.join("\n"));
const cat = PartCatalogue.fromJson(catR.value);
const design = (p: string): ShipDesign => {
  const r = validateDesign(read(p));
  if (!r.ok) throw new Error(r.errors.join("\n"));
  return r.value;
};
const NOW = "2026-11-09T00:00:00Z";
const D = (
  parts: [string, string, number, number, number?][],
  extra: Partial<ShipDesign> = {},
): ShipDesign => ({
  formatVersion: 1,
  id: "g",
  name: "g",
  createdAt: NOW,
  modifiedAt: NOW,
  weaponGroupModes: {},
  powerPriority: ["gyro", "propulsion", "weapons", "pointDefense", "hangar"],
  parts: parts.map(([uid, p, x, y, a]) => ({ uid, partId: `core:${p}`, x, y, angle: a ?? 0 })),
  ...extra,
});
const mule = design("designs/demo-hauler.json");
/** Command module with an autocannon turret on top (group 1). */
const turretBoat = (extra: Partial<ShipDesign> = {}) =>
  D(
    [
      ["cmd", "command.s", 0, 0],
      ["mag", "magazine.autocannon.s", 0, 1.25],
      ["tur", "weapon.autocannon.turret.s", 0, 1.75 + 0.6929, 90],
      ["tank", "tank.fuel.s", -1.25, 0],
      ["eng", "engine.main.s", -2.25, 0],
    ],
    extra,
  );

describe("weapon groups: automatic fire range and target priority", () => {
  it("an automatic group holds fire beyond its set range and opens fire inside it", () => {
    const shotsAt = (range: number | undefined, dist: number) => {
      const w = new World({ seed: 1 });
      w.addShip(
        turretBoat({ weaponGroupModes: { "1": "ai" }, weaponGroups: range ? { "1": { range } } : {} }),
        cat,
      );
      w.addShip(mule, cat, { position: vec2(0, dist), team: 1 });
      w.run(90);
      return w.combat.stats.shots;
    };
    expect(shotsAt(undefined, 900)).toBeGreaterThan(0); // weapon range 1500
    expect(shotsAt(600, 900)).toBe(0);
    expect(shotsAt(600, 500)).toBeGreaterThan(0);
  });

  it("priorities order the candidates: nearest, threat, weakest, drones", () => {
    const me = { id: "me", team: 0, position: vec2(0, 0), velocity: vec2(0, 0) };
    const c = (id: string, x: number, extra: Partial<Contact> = {}): Contact => ({
      id,
      kind: "ship",
      team: 1,
      position: vec2(x, 0),
      velocity: vec2(0, 0),
      targetId: null,
      decoy: false,
      ...extra,
    });
    const list = [
      c("far-strong", 2000, { threat: 900, hull: 1 }),
      c("near-weak", 500, { threat: 10, hull: 0.2 }),
      c("mid", 1000, { threat: 50, hull: 0.6 }),
      c("drone", 1500, { kind: "drone", threat: 30, hull: 1 }),
    ];
    const ids = (p: Parameters<typeof orderByPriority>[2], pref: string | null = null) =>
      orderByPriority(list, me, p, pref).map((x) => x.id);
    expect(ids("nearest")).toEqual(["near-weak", "mid", "drone", "far-strong"]);
    expect(ids("target", "mid")[0]).toBe("mid");
    expect(ids("threat")[0]).toBe("far-strong"); // 900 dps at 2 km outweighs 10 dps at 500 m
    expect(ids("weakest")).toEqual(["near-weak", "mid", "drone", "far-strong"]);
    expect(ids("drones")[0]).toBe("drone");
  });

  it('a "missiles first" group shoots at a missile homing on its ship long before it is about to hit', () => {
    const run = (priority: "missiles" | "target") => {
      const w = new World({ seed: 1 });
      const s = w.addShip(
        turretBoat({ weaponGroupModes: { "1": "ai" }, weaponGroups: { "1": { priority } } }),
        cat,
      );
      const enemy = w.addShip(mule, cat, { position: vec2(0, 5000), team: 1 });
      const def = cat.get("core:magazine.missile.s").def.magazine!.missile!;
      // A slow missile 1.2 km out: more than 4 s from impact, beyond the default automatic missile defense.
      spawnMissile(w, enemy, def, vec2(0, 1200), vec2(0, -1), vec2(0, -100), s.id).fuel = 0;
      w.run(20);
      return w.combat.stats.shots;
    };
    expect(run("target")).toBe(0);
    expect(run("missiles")).toBeGreaterThan(0);
  });
});

describe("launching missiles and drones one by one", () => {
  const boat = D([
    ["cmd", "command.s", 0, 0],
    ["ml-1", "weapon.missile.launcher.s", 1.5, 0.5],
    ["ml-2", "weapon.missile.launcher.s", 1.5, -0.5],
    ["mag", "magazine.missile.s", 0, 1.25],
  ]);
  const setup = () => {
    const w = new World({ seed: 1 });
    const s = w.addShip(boat, cat);
    const t = w.addShip(mule, cat, { position: vec2(3000, 0), team: 1 });
    return { w, s, t };
  };

  it("M launches one missile from the first ready launcher; Shift+M fires every ready launcher", () => {
    const one = setup();
    one.s.weaponCommand = {
      trigger: false,
      aimPoint: null,
      selected: new Set([1]),
      targetId: one.t.id,
      launch: "one",
    };
    one.w.step();
    expect(one.w.combat.stats.missilesLaunched).toBe(1);
    // The next single launch uses the other launcher while the first reloads.
    one.s.weaponCommand = { ...one.s.weaponCommand, launch: "one" };
    one.w.step();
    expect(one.w.combat.stats.missilesLaunched).toBe(2);
    // Both reloading: nothing goes out until a launcher is ready again.
    one.s.weaponCommand = { ...one.s.weaponCommand, launch: "one" };
    one.w.step();
    expect(one.w.combat.stats.missilesLaunched).toBe(2);
    const salvo = setup();
    salvo.s.weaponCommand = {
      trigger: false,
      aimPoint: null,
      selected: new Set([1]),
      targetId: salvo.t.id,
      launch: "salvo",
    };
    salvo.w.step();
    expect(salvo.w.combat.stats.missilesLaunched).toBe(2);
  });

  it("H launches one drone; the hangar then cools down before it can launch the next", () => {
    const w = new World({ seed: 1 });
    w.registerDesign(design("designs/drone-attack.json"));
    const c = w.addShip(
      D([
        ["cmd", "command.s", 0, 0],
        ["hg", "hangar.attack.m", 0, 1.5],
        ["bat", "battery.s", 0, -1.25], // readying a drone takes power
      ]),
      cat,
    );
    const drones = () => w.allShips().filter((s) => s.drone).length;
    expect(c.launchOneDrone()).toBe(true);
    w.step();
    expect(drones()).toBe(1);
    expect(c.droneCooldown).toBeGreaterThan(0);
    expect(c.launchOneDrone()).toBe(false); // still cooling down
    w.run(605); // launch interval 10 s
    expect(c.droneCooldown).toBe(0);
    expect(c.launchOneDrone()).toBe(true);
    w.step();
    expect(drones()).toBe(2);
  });
});

describe("editor weapon groups", () => {
  it("creates groups, configures mode, range and priority, moves weapons and deletes groups", () => {
    const base = D(
      [
        ["cmd", "command.s", 0, 0],
        ["ml-1", "weapon.missile.launcher.s", 1.5, 0.5],
        ["ml-2", "weapon.missile.launcher.s", 1.5, -0.5],
      ],
      { weaponGroupModes: { "1": "manual" } },
    );
    const m = new EditorModel(cat, base, () => NOW);
    expect(m.groupsInUse()).toEqual([1]);
    expect(m.createGroup(["ml-2"])).toBe(2);
    expect(m.design.parts.find((p) => p.uid === "ml-2")!.weaponGroup).toBe(2);
    m.setGroupMode(2, "ai");
    m.setGroupSettings(2, { name: "Long range", range: 2500, priority: "threat" });
    expect(m.design.weaponGroups?.["2"]).toEqual({ name: "Long range", range: 2500, priority: "threat" });
    m.setGroupSettings(2, { range: undefined });
    expect(m.design.weaponGroups?.["2"]).toEqual({ name: "Long range", priority: "threat" });
    expect(validateDesign(m.design).ok).toBe(true);
    m.deleteGroup(2);
    expect(m.groupsInUse()).toEqual([1]);
    expect(m.design.parts.find((p) => p.uid === "ml-2")!.weaponGroup).toBeUndefined();
    m.undo();
    expect(m.groupsInUse()).toEqual([1, 2]);
  });
});

describe("armor strips", () => {
  it("are a third as wide as the armor plates, with the same armor, and attach along their long side", () => {
    const s = cat.get("core:armor.strip.s").def;
    const sq = cat.get("core:armor.square.s").def;
    const h = (p: typeof s) =>
      Math.max(...p.outline.map((v) => v[1])) - Math.min(...p.outline.map((v) => v[1]));
    expect(h(s)).toBeCloseTo(h(sq) / 3, 3);
    expect(s.armor).toBe(sq.armor);
    expect(cat.get("core:armor.strip.m").def.armor).toBe(cat.get("core:armor.square.m").def.armor);
    const d = D([
      ["cmd", "command.s", 0, 0],
      ["st-1", "armor.strip.s", 0, 0.75 + 1 / 6],
      ["st-2", "armor.strip.s", 0, 0.75 + 1 / 3 + 1 / 6],
    ]);
    expect(validateDesignLayout(d, cat).errors).toBe(0);
  });
});
