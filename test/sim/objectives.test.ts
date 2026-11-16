import { describe, expect, it } from "vitest";
import catalogueJson from "../../src/data/core/catalogue.json";
import { validateCatalogue, validateScenario } from "../../src/data/validate";
import { AI_PROFILES, aiProfile } from "../../src/data/ai/index";
import { BUNDLED_DESIGNS } from "../../src/data/designs/index";
import type { Scenario } from "../../src/data/schemas/scenario";
import { PartCatalogue } from "../../src/sim/ship/catalogue";
import {
  battleReport,
  runBattle,
  startBattle,
  stepBattle,
  updateBattle,
} from "../../src/sim/scenario/battle";
import { EXIT } from "../../src/sim/world";
import { vec2 } from "../../src/sim/core/vec2";
import { makeObjective, ScenarioModel } from "../../src/editor/scenario-model";

const r = validateCatalogue(catalogueJson);
if (!r.ok) throw new Error(r.errors.join("\n"));
const cat = PartCatalogue.fromJson(r.value);
const opts = { designs: BUNDLED_DESIGNS, profiles: AI_PROFILES };
const D = (id: string) => BUNDLED_DESIGNS.get(id)!;

/** A small open-space scenario: the player starts at the left, enemies on the right. */
function scenario(patch: Partial<Scenario>): Scenario {
  const s: Scenario = {
    id: "t",
    name: "Test",
    description: "",
    budget: 100000,
    maxPlayerShips: 3,
    arena: { width: 12000, height: 8000, asteroids: [], gravityWells: [] },
    playerSpawns: [{ position: [-3000, 0], angle: 0 }],
    enemies: [
      {
        designId: "fleet-wasp",
        aiProfile: "balanced",
        spawn: { position: [4000, 2500], angle: 180 },
        team: 1,
      },
    ],
    objective: { type: "destroyAll" },
    seed: 7,
    ...patch,
  };
  const v = validateScenario(s);
  if (!v.ok) throw new Error(v.errors.join("\n"));
  return v.value;
}

describe("objectives (docs/objectives.md)", () => {
  it("jump points: a player ship that stays inside for EXIT.dwell seconds leaves the battle, not destroyed", () => {
    const b = startBattle(
      scenario({
        arena: {
          width: 12000,
          height: 8000,
          asteroids: [],
          gravityWells: [],
          exits: [{ position: [-3000, 0], radius: 400 }],
        },
        enemies: [
          {
            designId: "fleet-wasp",
            aiProfile: "balanced",
            spawn: { position: [5000, 3000], angle: 180 },
            team: 1,
          },
        ],
      }),
      [D("fleet-wasp")],
      cat,
      opts,
    );
    const me = b.playerShips[0]!;
    for (let i = 0; i < EXIT.dwell * 60 - 2; i++) stepBattle(b);
    expect(me.escaped).toBe(false);
    for (let i = 0; i < 4; i++) stepBattle(b);
    expect(me.escaped).toBe(true);
    expect(me.defeated).toBe(false);
    expect(b.world.hasShip(me.id)).toBe(false);
    expect(b.world.allShips().includes(me)).toBe(false);
    // Every ship gone, none destroyed: the fleet withdrew (a loss for destroy-all).
    expect(b.status).toBe("lost");
    expect(b.reason).toMatch(/withdrew/);
    const rep = battleReport(b);
    expect(rep.ships.find((s) => s.id === me.id)!.fate).toBe("escaped");
    expect(rep.events.some((e) => e.kind === "escaped")).toBe(true);
  });

  it("an AI ship only jumps when getting away, and a disengage order takes it to the nearest jump point", () => {
    const b = startBattle(
      scenario({
        arena: {
          width: 12000,
          height: 8000,
          asteroids: [],
          gravityWells: [],
          exits: [
            { position: [-3000, 0], radius: 400 },
            { position: [-1000, 2500], radius: 400, team: 1 },
          ],
        },
      }),
      [D("fleet-rapier"), D("fleet-wasp")],
      cat,
      opts,
    );
    const [a, w] = b.playerShips;
    b.world.setAi(a!.id, aiProfile("balanced"), { kind: "hold", point: vec2(-3000, 0) });
    const st = b.world.setAi(w!.id, aiProfile("balanced"), { kind: "retreat" });
    for (let i = 0; i < 60 * 30 && !w!.escaped; i++) stepBattle(b);
    expect(w!.escaped).toBe(true);
    expect(st.behaviour).toBe("retreat");
    // The holding ship sat in the jump point all along and stayed.
    expect(a!.escaped).toBe(false);
  });

  it("escort: the escorted ship flies to the zone on its own; reaching it wins, losing it loses", () => {
    const s = scenario({
      enemies: [
        {
          designId: "demo-hauler",
          aiProfile: "balanced",
          spawn: { position: [-3000, -300], angle: 0 },
          team: 0,
        },
        {
          designId: "fleet-wasp",
          aiProfile: "balanced",
          spawn: { position: [5500, 3500], angle: 180 },
          team: 1,
        },
      ],
      objective: { type: "escort", designId: "demo-hauler", zone: { position: [-1500, -300], radius: 300 } },
    });
    const b = startBattle(s, [D("fleet-wasp")], cat, opts);
    expect(b.protectId).not.toBeNull();
    expect(b.world.ai.get(b.protectId!)?.order?.kind).toBe("move");
    expect(runBattle(b, 120)).toBe("won");
    expect(b.reason).toMatch(/reached/);
    const lost = startBattle(s, [D("fleet-wasp")], cat, opts);
    const hauler = lost.world.getShip(lost.protectId!);
    hauler.destroyPart(hauler.parts.find((p) => p.def.def.command)!.uid);
    lost.world.step();
    expect(updateBattle(lost)).toBe("lost");
  });

  it("hold: time counts only while a ship of yours is inside and no enemy is; it adds up", () => {
    const s = scenario({
      objective: { type: "hold", zone: { position: [-3000, 0], radius: 500 }, seconds: 2 },
      enemies: [
        { designId: "fleet-wasp", aiProfile: "none", spawn: { position: [5000, 3000], angle: 180 }, team: 1 },
      ],
    });
    const b = startBattle(s, [D("fleet-wasp")], cat, opts);
    for (let i = 0; i < 60; i++) stepBattle(b);
    expect(b.held).toBeGreaterThan(0.9);
    expect(b.status).toBe("running");
    for (let i = 0; i < 70 && b.status === "running"; i++) stepBattle(b);
    expect(b.status).toBe("won");
    // The enemy's guards hold the zone (hold orders on the beacon).
    const g = startBattle(
      scenario({
        objective: { type: "hold", zone: { position: [0, 0], radius: 500 }, seconds: 30 },
        enemies: [
          {
            designId: "fleet-wasp",
            aiProfile: "balanced",
            spawn: { position: [100, 0], angle: 180 },
            team: 1,
          },
        ],
      }),
      [D("fleet-wasp")],
      cat,
      opts,
    );
    expect(g.world.ai.get(g.enemyShips[0]!.id)?.order?.kind).toBe("hold");
  });

  it("breakout: enough ships through the jump point wins; too few left loses", () => {
    const s = scenario({
      playerSpawns: [
        { position: [-3000, 0], angle: 0 },
        { position: [-3000, 300], angle: 0 },
      ],
      objective: { type: "breakout", zone: { position: [-3000, 0], radius: 600 }, count: 2 },
    });
    const b = startBattle(s, [D("fleet-wasp"), D("fleet-wasp")], cat, opts);
    expect(b.world.exits.length).toBe(1);
    expect(runBattle(b, 10)).toBe("won");
    expect(b.reason).toMatch(/2 ships broke out/);
    const l = startBattle(s, [D("fleet-wasp"), D("fleet-wasp")], cat, opts);
    const victim = l.playerShips[1]!;
    victim.destroyPart(victim.parts.find((p) => p.def.def.command)!.uid);
    l.world.step();
    expect(updateBattle(l)).toBe("lost");
  });

  it("a time limit ends an unfinished battle as lost", () => {
    const b = startBattle(scenario({ timeLimit: 1 }), [D("fleet-wasp")], cat, opts);
    expect(runBattle(b, 3)).toBe("lost");
    expect(b.reason).toMatch(/Time ran out/);
  });
});

describe("strategy orders: focus fire and rules of engagement", () => {
  const two = () =>
    startBattle(
      scenario({
        enemies: [
          {
            designId: "fleet-wasp",
            aiProfile: "none",
            spawn: { position: [-1800, 300], angle: 180 },
            team: 1,
          },
          {
            designId: "fleet-maul",
            aiProfile: "none",
            spawn: { position: [-1500, -300], angle: 180 },
            team: 1,
          },
        ],
      }),
      [D("fleet-rapier")],
      cat,
      opts,
    );

  it("focus fire puts the focused enemy first among the targets", () => {
    const b = two();
    const me = b.playerShips[0]!;
    const st = b.world.setAi(me.id, aiProfile("balanced"));
    stepBattle(b);
    const first = st.targetId;
    const other = b.enemyShips.find((s) => s.id !== first)!;
    st.focus = other.id;
    st.nextEval = 0;
    stepBattle(b);
    expect(st.targetId).toBe(other.id);
  });

  it("hold fire keeps the guns quiet; return fire waits until the enemy has fired on this side", () => {
    const quiet = (roe: "hold" | "return" | "free", foe = "demo-hauler") => {
      const b = startBattle(
        scenario({
          enemies: [
            { designId: foe, aiProfile: "none", spawn: { position: [-1800, 300], angle: 180 }, team: 1 },
          ],
        }),
        [D("fleet-rapier")],
        cat,
        opts,
      );
      const me = b.playerShips[0]!;
      const st = b.world.setAi(me.id, aiProfile("balanced"));
      st.roe = roe;
      for (let i = 0; i < 60 * 20; i++) stepBattle(b);
      return b.world.combat.gunnery[me.id]?.shots ?? 0;
    };
    expect(quiet("free")).toBeGreaterThan(0);
    expect(quiet("hold")).toBe(0);
    // An unarmed hauler never fires: nothing to return. A pilotless Wasp's automatic guns do fire.
    expect(quiet("return")).toBe(0);
    expect(quiet("return", "fleet-wasp")).toBeGreaterThan(0);
  });
});

describe("battle report", () => {
  it("credits kills and keeps a timeline and a strength curve", () => {
    const b = startBattle(
      scenario({
        enemies: [
          { designId: "fleet-wasp", aiProfile: "none", spawn: { position: [-2000, 0], angle: 180 }, team: 1 },
        ],
      }),
      [D("fleet-rapier")],
      cat,
      opts,
    );
    b.world.setAi(b.playerShips[0]!.id, aiProfile("aggressive"));
    expect(runBattle(b, 120)).toBe("won");
    const rep = battleReport(b);
    const me = rep.ships.find((s) => s.side === "yours")!;
    const foe = rep.ships.find((s) => s.side === "enemy")!;
    expect(foe.fate).toBe("destroyed");
    expect(foe.killedBy).toBe(me.name);
    expect(me.kills).toBe(1);
    expect(me.dealt).toBeGreaterThan(0);
    expect(me.accuracy).not.toBeNull();
    expect(me.behaviours.length).toBeGreaterThan(0);
    expect(rep.strength.length).toBeGreaterThan(1);
    expect(rep.strength.at(-1)!.enemy).toBe(0);
    expect(rep.events.some((e) => e.kind === "destroyed")).toBe(true);
  });
});

describe("scenario editor: objectives and jump points", () => {
  it("switches objectives, keeping the zone, and places, moves and removes jump points", () => {
    const m = new ScenarioModel(scenario({}));
    m.edit((s) => (s.objective = makeObjective(s, "hold")));
    expect(m.scenario.objective.type).toBe("hold");
    expect(m.items().some((i) => i.kind === "zone")).toBe(true);
    m.move({ kind: "zone", index: 0 }, 100, 200);
    m.edit((s) => (s.objective = makeObjective(s, "breakout")));
    const o = m.scenario.objective;
    expect(o.type === "breakout" && o.zone.position).toEqual([100, 200]);
    const e = m.addExit(-500, 500);
    expect(m.position(e)).toEqual([-500, 500]);
    m.remove(e);
    expect(m.scenario.arena.exits).toBeUndefined();
    expect(validateScenario(m.scenario).ok).toBe(true);
    m.edit((s) => (s.objective = makeObjective(s, "escort")));
    expect(m.problems(BUNDLED_DESIGNS, new Set(AI_PROFILES.keys())).join()).toMatch(/No allied ship/);
  });
});
