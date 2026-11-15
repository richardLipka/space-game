import { describe, expect, it } from "vitest";
import catalogueJson from "../../src/data/core/catalogue.json";
import { validateCatalogue, validateOfficer, validateRoster } from "../../src/data/validate";
import { PartCatalogue } from "../../src/sim/ship/catalogue";
import { BUNDLED_DESIGNS } from "../../src/data/designs/index";
import { World } from "../../src/sim/world";
import { length, vec2 } from "../../src/sim/core/vec2";
import {
  crewRng,
  crewSlots,
  FOCUS,
  MAX_LEVEL,
  migratePortrait,
  MOVED_ACCESSORY,
  OFF_FOCUS,
  PORTRAIT_VERSION,
  promote,
  promotionOptions,
  officerEffects,
  STRENGTH,
  TRAINING_PCT,
  trainingOf,
  randomOfficer,
  shipMods,
  TRAITS,
} from "../../src/sim/crew/officers";
import { crewBattle, crewOf, emptyRoster, generateCrew } from "../../src/ui/roster";
import type { Officer } from "../../src/data/schemas/officer";

const r = validateCatalogue(catalogueJson);
if (!r.ok) throw new Error(r.errors.join("\n"));
const cat = PartCatalogue.fromJson(r.value);

const officer = (traits: string[], level = 1): Officer => ({
  id: "o1",
  name: "Test Officer",
  position: "tactical",
  level,
  traits,
  portrait: {
    head: 0,
    skin: 0,
    hair: 0,
    hairColor: 0,
    eyes: 0,
    mouth: 0,
    facialHair: 0,
    neck: 0,
    uniform: 0,
    uniformColor: 0,
    collar: 0,
    accessory: 0,
    suit: false,
  },
});
const traits = ["gunnery-expert", "hot-rodder", "cool-head", "gun-shy", "nervous"];

describe("officers", () => {
  it("posts by class: none on drones, a pilot on fighters, 2 on corvettes and frigates, 5 above", () => {
    expect(crewSlots("drone")).toEqual([]);
    expect(crewSlots("fighter")).toEqual(["pilot"]);
    expect(crewSlots("corvette")).toEqual(["captain", "tactical"]);
    expect(crewSlots("frigate")).toEqual(["captain", "tactical"]);
    for (const c of ["destroyer", "cruiser", "battlecruiser", "battleship"] as const)
      expect(crewSlots(c)).toHaveLength(5);
  });

  it("the post emphasises its own stats and experience adds a little", () => {
    const o = officer(["gunnery-expert", "hot-rodder", "cool-head", "heavy-handed", "slow-reflexes"]);
    // Gun damage is tactical's work, thrust is navigation's.
    expect(officerEffects(o, "tactical").gunDamage).toBeCloseTo(5 * FOCUS, 6);
    expect(officerEffects(o, "tactical").thrust).toBeCloseTo(5 * OFF_FOCUS, 6);
    expect(officerEffects(o, "navigation").thrust).toBeCloseTo(5 * FOCUS, 6);
    expect(officerEffects(o, "navigation").gunDamage).toBeCloseTo(5 * OFF_FOCUS, 6);
    // Each level above 1 trains exactly one stat.
    const veteran = { ...officer(o.traits, 3), training: ["gunDamage", "turning"] as Officer["training"] };
    const fx = officerEffects(veteran, "tactical");
    expect(fx.gunDamage).toBeCloseTo((5 + TRAINING_PCT) * FOCUS, 6);
    expect(fx.turning).toBeCloseTo((TRAINING_PCT - 4) * OFF_FOCUS, 6); // slow reflexes −4, trained +3
    expect(fx.thrust).toBeCloseTo(5 * OFF_FOCUS, 6);
  });

  it("traits come in three strengths: small, medium and full", () => {
    const o = officer(["gunnery-expert", "hot-rodder", "cool-head", "heavy-handed", "slow-reflexes"]);
    for (const k of [1, 2, 3])
      expect(officerEffects({ ...o, strength: [k, 3, 3, 3, 3] }, "tactical").gunDamage).toBeCloseTo(
        5 * FOCUS * STRENGTH[k]!,
        6,
      );
    // Random officers use all three.
    const random = crewRng(3);
    const seen = new Set<number>();
    for (let i = 0; i < 50; i++)
      for (const k of randomOfficer(random, "tactical", `x${i}`).strength!) seen.add(k);
    expect([...seen].sort()).toEqual([1, 2, 3]);
  });

  it("older officers without training train their post's stats; a level up adds one stat", () => {
    const o = officer(traits, 4);
    expect(trainingOf(o)).toEqual(["gunDamage", "missileDamage", "pdDamage"]);
    expect(trainingOf({ ...o, position: "captain" })).toHaveLength(3);
    const r = randomOfficer(crewRng(9), "navigation", "n1");
    expect(r.training).toHaveLength(r.level - 1);
  });

  it("a ship's modifiers sum its officers and stay within ±30 %", () => {
    const o = officer(traits);
    const m = shipMods([
      { officer: o, position: "tactical" },
      { officer: o, position: "captain" },
    ]);
    // Gun damage: +5 and −4 per officer, ×1.5 tactical and ×0.8 captain.
    expect(m.gunDamage).toBeCloseTo(1 + (1 * 1.5 + 1 * 0.8) / 100, 6);
    expect(m.missileDamage).toBe(1);
    const lots = Array.from({ length: 20 }, () => ({
      officer: officer(traits, 5),
      position: "tactical" as const,
    }));
    expect(shipMods(lots).gunDamage).toBe(1.3);
  });

  it("random officers are valid: three positive and two negative traits, levels 1–5", () => {
    const random = crewRng(7);
    for (let i = 0; i < 200; i++) {
      const o = randomOfficer(random, "operations", `o-${i}`);
      const v = validateOfficer(o);
      expect(v.ok, v.ok ? "" : v.errors.join("; ")).toBe(true);
      expect(o.level).toBeGreaterThanOrEqual(1);
      expect(o.level).toBeLessThanOrEqual(5);
    }
    expect(TRAITS.filter((t) => t.positive).length).toBeGreaterThanOrEqual(3);
  });

  it("the validator rejects wrong trait counts, signs and unknown officers in crews", () => {
    expect(
      validateOfficer(officer(["gunnery-expert", "hot-rodder", "gun-shy", "nervous", "wasteful"])).ok,
    ).toBe(false);
    expect(
      validateOfficer(officer(["gunnery-expert", "gunnery-expert", "cool-head", "gun-shy", "nervous"])).ok,
    ).toBe(false);
    expect(validateOfficer(officer(["gunnery-expert", "x", "cool-head", "gun-shy", "nervous"])).ok).toBe(
      false,
    );
    expect(validateRoster({ ...emptyRoster(), crews: { ship: { captain: "nobody" } } }).ok).toBe(false);
  });
});

describe("roster", () => {
  it("generates a crew for the empty posts and reads it back", () => {
    const roster = emptyRoster();
    generateCrew(roster, "ship-a", "cruiser", 3);
    expect(roster.officers).toHaveLength(5);
    expect(crewOf(roster, "ship-a", "cruiser").map((c) => c.position)).toEqual(crewSlots("cruiser"));
    // Full: nothing new. Smaller class: only its posts count.
    generateCrew(roster, "ship-a", "cruiser", 4);
    expect(roster.officers).toHaveLength(5);
    expect(crewOf(roster, "ship-a", "frigate")).toHaveLength(2);
    expect(validateRoster(JSON.parse(JSON.stringify(roster))).ok).toBe(true);
  });

  it("enemy ships get random officers (the same for the same seed), the player's ships the roster's", () => {
    const crews = (seed: number, roster = emptyRoster()) => {
      const w = new World({ seed });
      w.addShip(BUNDLED_DESIGNS.get("fleet-wasp")!, cat);
      w.addShip(BUNDLED_DESIGNS.get("fleet-wasp")!, cat, { position: vec2(300, 0), team: 1 });
      crewBattle(w, roster);
      return w
        .allShips()
        .map((s) => s.crew.map((c) => `${c.position}:${c.officer.id}:${c.officer.traits.join(",")}`));
    };
    const [mine, theirs] = crews(5);
    expect(mine).toEqual([]);
    expect(theirs!.length).toBeGreaterThan(0);
    expect(crews(5)).toEqual([mine, theirs]);
    const roster = generateCrew(emptyRoster(), "fleet-wasp", "fighter", 9);
    expect(crews(5, roster)[0]).toEqual([
      `pilot:${roster.officers[0]!.id}:${roster.officers[0]!.traits.join(",")}`,
    ]);
  });
});

describe("officer modifiers in the simulation", () => {
  it("thrust follows the modifier", () => {
    const run = (thrust: number) => {
      const w = new World({ seed: 1 });
      const s = w.addShip(BUNDLED_DESIGNS.get("fleet-wasp")!, cat);
      if (thrust !== 1) (s as { mods: unknown }).mods = { ...s.mods, thrust };
      w.setIntent(s.id, { thrust: vec2(1, 0), rotate: 0 });
      w.run(60);
      return length(w.physics.getBodyState(s.id).linearVelocity);
    };
    const base = run(1);
    expect(base).toBeGreaterThan(0);
    expect(run(1.2) / base).toBeCloseTo(1.2, 1);
  });

  it("setCrew passes rate of fire and accuracy to the weapons", () => {
    const w = new World({ seed: 1 });
    const s = w.addShip(BUNDLED_DESIGNS.get("fleet-wasp")!, cat);
    s.setCrew([
      {
        officer: officer(["quick-loader", "steady-hand", "cool-head", "gun-shy", "nervous"]),
        position: "pilot",
      },
    ]);
    expect(s.mods.fireRate).toBeGreaterThan(1);
    for (const wp of s.weapons) expect(wp.mods?.rate).toBe(s.mods.fireRate);
    s.setCrew([]);
    expect(s.mods.fireRate).toBe(1);
  });
});

describe("promotion and portrait layout", () => {
  it("promotion adds one level that trains the chosen stat; none past level 5", () => {
    const o = { ...randomOfficer(crewRng(11), "tactical", "t1"), level: 2, training: ["thrust" as const] };
    const up = promote(o, "cooling")!;
    expect(up.level).toBe(3);
    expect(up.training).toEqual([...trainingOf(o), "cooling"]);
    expect(validateOfficer(up).ok).toBe(true);
    expect(officerEffects(up, "tactical").cooling ?? 0).toBeGreaterThan(
      officerEffects(o, "tactical").cooling ?? 0,
    );
    expect(
      promote({ ...o, level: MAX_LEVEL, training: trainingOf({ ...o, level: MAX_LEVEL }) }, "power"),
    ).toBeNull();
  });

  it("promotion options list every stat, the post's own stats first", () => {
    const opts = promotionOptions("navigation");
    expect(opts).toHaveLength(9);
    expect(
      opts
        .slice(0, 2)
        .map((x) => x.stat)
        .sort(),
    ).toEqual(["thrust", "turning"]);
    expect(opts[0]!.focus).toBe(true);
    expect(opts[0]!.gain).toBeCloseTo(TRAINING_PCT * FOCUS, 6);
    expect(opts[8]!.gain).toBeCloseTo(TRAINING_PCT * OFF_FOCUS, 6);
  });

  it("old portraits move the monocle, eyepatch and cigar to the accessories", () => {
    const old = {
      head: 1,
      skin: 2,
      hair: 3,
      hairColor: 1,
      eyes: 4,
      mouth: 8,
      facialHair: 0,
      neck: 0,
      uniform: 0,
      uniformColor: 0,
      collar: 0,
      accessory: 5,
      suit: false,
    };
    const m = migratePortrait(old);
    expect(m.v).toBe(PORTRAIT_VERSION);
    expect(m.eyes).toBe(0);
    expect(m.mouth).toBe(0);
    expect([m.accessory, ...(m.extras ?? [])]).toEqual([5, MOVED_ACCESSORY.monocle, MOVED_ACCESSORY.cigar]);
    expect(migratePortrait(m)).toBe(m);
    expect(migratePortrait({ ...old, eyes: 7, mouth: 2 }).accessory).toBe(5);
    expect(migratePortrait({ ...old, eyes: 7, mouth: 2, accessory: 0 }).accessory).toBe(
      MOVED_ACCESSORY.eyepatch,
    );
    // Eyes after the moved ones shift down: old spectacles (6) are 5, old welding goggles (12) are 10.
    expect(migratePortrait({ ...old, eyes: 6 }).eyes).toBe(5);
    expect(migratePortrait({ ...old, eyes: 12 }).eyes).toBe(10);
    expect(migratePortrait({ ...old, eyes: 2 }).eyes).toBe(2);
  });
});
