import { describe, expect, it } from "vitest";
import catalogueJson from "../../src/data/core/catalogue.json";
import { validateCatalogue, validateOfficer, validateRoster } from "../../src/data/validate";
import { lenient, repairCrew, repairOfficer, repairRoster } from "../../src/data/repair";
import { Scenario as ScenarioSchema } from "../../src/data/schemas/scenario";
import { PartCatalogue } from "../../src/sim/ship/catalogue";
import { BUNDLED_DESIGNS } from "../../src/data/designs/index";
import { SCENARIOS } from "../../src/data/scenarios/index";
import { AI_PROFILES } from "../../src/data/ai/index";
import { startBattle, runBattle } from "../../src/sim/scenario/battle";
import { resolveDesign } from "../../src/sim/ship/resolve";
import { World } from "../../src/sim/world";
import { parseGameFile } from "../../src/editor/scenario-model";
import { adoptCrew, crewBattle, emptyRoster, generateCrew } from "../../src/ui/roster";
import { crewRng, randomOfficer } from "../../src/sim/crew/officers";
import type { Scenario } from "../../src/data/schemas/scenario";

const r = validateCatalogue(catalogueJson);
if (!r.ok) throw new Error(r.errors.join("\n"));
const cat = PartCatalogue.fromJson(r.value);
const wasp = BUNDLED_DESIGNS.get("fleet-wasp")!;
const opts = { designs: BUNDLED_DESIGNS, profiles: AI_PROFILES };
const base = (): Scenario => structuredClone(SCENARIOS.find((s) => s.objective.type === "destroyAll")!);

describe("tolerant loading: officers and rosters", () => {
  it("an officer with unknown traits, a bad level and a half portrait is repaired", () => {
    const { officer, notes } = repairOfficer({
      id: "x1",
      name: "Gideon Crane",
      position: "tactical",
      level: 9,
      traits: ["gunnery-expert", "warp-whisperer", "gunnery-expert", "nervous"],
      portrait: { head: 2, skin: "green" },
    });
    expect(officer).not.toBeNull();
    expect(validateOfficer(officer).ok).toBe(true);
    expect(officer!.name).toBe("Gideon Crane");
    expect(officer!.level).toBe(5);
    expect(officer!.training).toHaveLength(4);
    expect(officer!.traits).toContain("gunnery-expert");
    expect(officer!.traits).toContain("nervous");
    expect(officer!.portrait.head).toBe(2);
    expect(notes.join()).toContain("warp-whisperer");
    expect(repairOfficer("not an officer").officer).toBeNull();
  });

  it("a roster with a broken officer keeps everyone else, and drops posts of missing officers", () => {
    const good = randomOfficer(crewRng(1), "captain", "good-1");
    const { roster, notes } = repairRoster({
      formatVersion: 1,
      officers: [good, { ...good, id: "bad-1", traits: ["nope"] }, 42],
      crews: { "fleet-wasp": { captain: "good-1", tactical: "gone", admiral: "good-1" } },
      extra: true,
    });
    expect(validateRoster(roster).ok).toBe(true);
    expect(roster.officers.map((o) => o.id)).toEqual(["good-1", "bad-1"]);
    expect(roster.crews["fleet-wasp"]).toEqual({ captain: "good-1" });
    expect(notes.length).toBeGreaterThan(0);
  });

  it("crew lists skip unknown posts and non-officers", () => {
    const o = randomOfficer(crewRng(2), "pilot", "p1");
    const { crew } = repairCrew([{ position: "pilot", officer: o }, { position: "cook", officer: o }, null]);
    expect(crew).toEqual([{ position: "pilot", officer: o }]);
  });

  it("officers from a ship file join the roster; a clashing id gets a new one", () => {
    const o = randomOfficer(crewRng(3), "pilot", "p1");
    let roster = adoptCrew(emptyRoster(), "fleet-wasp", [{ position: "pilot", officer: o }]);
    expect(roster.crews["fleet-wasp"]).toEqual({ pilot: "p1" });
    roster = adoptCrew(roster, "other", [{ position: "pilot", officer: { ...o, name: "Someone Else" } }]);
    expect(roster.officers).toHaveLength(2);
    expect(roster.crews.other!.pilot).not.toBe("p1");
    expect(validateRoster(roster).ok).toBe(true);
  });
});

describe("tolerant loading: designs, scenarios and battles", () => {
  it("parts this version lacks are left out of a design; none left = null", () => {
    const d = {
      ...wasp,
      parts: [...wasp.parts, { uid: "zz", partId: "core:warp.drive", x: 0, y: 9, angle: 0 }],
    };
    const res = resolveDesign(d, cat);
    expect(res.missing).toEqual(["core:warp.drive"]);
    expect(res.design!.parts).toHaveLength(wasp.parts.length);
    const w = new World({ seed: 1 });
    expect(() => w.addShip(d, cat)).not.toThrow();
    const none = { ...wasp, parts: [{ uid: "zz", partId: "core:warp.drive", x: 0, y: 0, angle: 0 }] };
    expect(resolveDesign(none, cat).design).toBeNull();
  });

  it("a scenario with an unknown design, AI profile and protect target still starts, with warnings", () => {
    const s = base();
    s.enemies[0] = { ...s.enemies[0]!, aiProfile: "berserker-9000" };
    s.enemies.push({ ...s.enemies[0]!, designId: "from-the-future", aiProfile: "balanced" });
    s.objective = { type: "protect", designId: "from-the-future" };
    const b = startBattle(s, [wasp], cat, opts);
    expect(b.warnings.join(" ")).toContain("berserker-9000");
    expect(b.warnings.join(" ")).toContain("from-the-future");
    expect(b.scenario.objective.type).toBe("destroyAll");
    expect(b.scenarioShips[s.enemies.length - 1]).toBeUndefined();
    expect(() => runBattle(b, 5)).not.toThrow();
  });

  it("scenario crews and flight model reach the battle", () => {
    const s = base();
    s.flightModel = "arcade";
    const o = randomOfficer(crewRng(4), "captain", "sc-1");
    s.enemies[0] = { ...s.enemies[0]!, crew: [{ position: "captain", officer: o }] };
    const b = startBattle(s, [wasp], cat, opts);
    expect(b.scenario.flightModel).toBe("arcade");
    const ship = b.scenarioShips[0]!;
    crewBattle(b.world, emptyRoster(), { fixed: new Map([[ship.id, s.enemies[0]!.crew!]]) });
    // The captain post holds the scenario's officer when the class has one.
    const captain = ship.crew.find((c) => c.position === "captain");
    if (captain) expect(captain.officer.id).toBe("sc-1");
  });

  it("scenario files from a newer version load without the unknown settings; bad crews are repaired", () => {
    const s = base() as Scenario & Record<string, unknown>;
    (s as Record<string, unknown>).weather = "stormy";
    (s.enemies[0] as Record<string, unknown>).crew = [
      { position: "captain", officer: { name: "Odd One", position: "captain", level: 2, traits: ["?"] } },
    ];
    expect(lenient(ScenarioSchema, { ...s, enemies: [] }).ok).toBe(true);
    const p = parseGameFile(s);
    expect(p.kind).toBe("scenario");
    if (p.kind !== "scenario") return;
    expect(p.notes.join(" ")).toContain("weather");
    expect(p.scenario.enemies[0]!.crew![0]!.officer.name).toBe("Odd One");
    expect(parseGameFile({ hello: "world" }).kind).toBe("error");
    const d = parseGameFile({ ...wasp, crew: [{ position: "pilot", officer: { traits: [] } }] });
    expect(d.kind).toBe("design");
  });

  it("generated crews and saved rosters stay valid", () => {
    const roster = generateCrew(emptyRoster(), "fleet-wasp", "cruiser", 5);
    expect(validateRoster(JSON.parse(JSON.stringify(roster))).ok).toBe(true);
  });
});
