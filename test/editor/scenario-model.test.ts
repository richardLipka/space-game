import { describe, expect, it } from "vitest";
import { BUNDLED_DESIGNS } from "../../src/data/designs/index";
import { validateScenario } from "../../src/data/validate";
import { AI_PROFILES } from "../../src/data/ai/index";
import catalogueJson from "../../src/data/core/catalogue.json";
import { validateCatalogue } from "../../src/data/validate";
import { PartCatalogue } from "../../src/sim/ship/catalogue";
import { startBattle } from "../../src/sim/scenario/battle";
import {
  asteroidOutline,
  emptyScenario,
  loadGithubFolder,
  NO_AI,
  parseGithubFolder,
  ScenarioModel,
} from "../../src/editor/scenario-model";

const profiles = new Set(AI_PROFILES.keys());

describe("scenario editor model", () => {
  it("places ships, asteroids, black holes and spawns; the result is a valid scenario", () => {
    const m = new ScenarioModel(emptyScenario("t1"));
    m.addShip("fleet-wasp", 1000.4, 20, 1, "balanced");
    m.addShip("platform-gatling", -1000, 0, 0, NO_AI);
    m.addAsteroid(0, 800, 60);
    m.addWell(0, -1500);
    m.addSpawn(-2000, 500);
    const s = m.scenario;
    expect(validateScenario(s).ok).toBe(true);
    expect(s.enemies.map((e) => e.spawn)).toEqual([
      { position: [1000, 20], angle: 180 },
      { position: [-1000, 0], angle: 0 },
    ]);
    expect(s.arena.asteroids).toHaveLength(1);
    expect(s.arena.gravityWells[0]!.position).toEqual([0, -1500]);
    expect(s.playerSpawns).toHaveLength(2);
    expect(m.problems(BUNDLED_DESIGNS, profiles)).toEqual([]);
  });

  it("moves, rotates and removes items with undo and redo", () => {
    const m = new ScenarioModel(emptyScenario("t2"));
    const a = m.addShip("fleet-wasp", 0, 0, 1, "balanced");
    m.move(a, 300, -200);
    m.rotate(a, 15);
    expect(m.scenario.enemies[0]!.spawn).toEqual({ position: [300, -200], angle: 195 });
    m.undo();
    expect(m.scenario.enemies[0]!.spawn.angle).toBe(180);
    m.redo();
    m.remove(a);
    expect(m.scenario.enemies).toHaveLength(0);
    m.undo();
    expect(m.scenario.enemies).toHaveLength(1);
  });

  it("removing a ship fixes the guard indices of the others", () => {
    const m = new ScenarioModel(emptyScenario("t3"));
    m.addShip("fleet-wasp", 0, 0, 1, "balanced");
    m.addShip("fleet-maul", 100, 0, 1, "balanced");
    m.addShip("fleet-spark", 200, 0, 1, "balanced");
    m.edit((s) => {
      s.enemies[2]!.guard = 1;
      s.enemies[0]!.guard = 1;
    });
    m.remove({ kind: "ship", index: 0 });
    expect(m.scenario.enemies[1]!.guard).toBe(0);
    m.remove({ kind: "ship", index: 0 });
    expect(m.scenario.enemies[0]!.guard).toBeUndefined();
  });

  it("reports unknown designs, items outside the arena and a battle without enemies", () => {
    const m = new ScenarioModel(emptyScenario("t4"));
    m.addShip("no-such-ship", 99999, 0, 0, "balanced");
    const p = m.problems(BUNDLED_DESIGNS, profiles).join("\n");
    expect(p).toMatch(/unknown design/);
    expect(p).toMatch(/outside the arena/);
    expect(p).toMatch(/No enemy ship/);
  });

  it("asteroid outlines are convex, counter-clockwise and deterministic", () => {
    const o = asteroidOutline(50, 7);
    expect(asteroidOutline(50, 7)).toEqual(o);
    for (let i = 0; i < o.length; i++) {
      const [a, b, c] = [o[i]!, o[(i + 1) % o.length]!, o[(i + 2) % o.length]!];
      const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
      expect(cross).toBeGreaterThan(0);
    }
  });

  it("a ship with AI 'none' gets no pilot in the battle; the others do", () => {
    const r = validateCatalogue(catalogueJson);
    if (!r.ok) throw new Error("catalogue");
    const cat = PartCatalogue.fromJson(r.value);
    const m = new ScenarioModel(emptyScenario("t5"));
    m.addShip("platform-gatling", -500, 0, 0, NO_AI);
    m.addShip("fleet-wasp", 500, 0, 1, "balanced");
    const b = startBattle(m.scenario, [], cat, { designs: BUNDLED_DESIGNS, profiles: AI_PROFILES });
    expect(b.world.ai.has(b.allyShips[0]!.id)).toBe(false);
    expect(b.world.ai.has(b.enemyShips[0]!.id)).toBe(true);
  });
});

describe("loading scenarios from a GitHub folder", () => {
  it("reads folder addresses", () => {
    expect(parseGithubFolder("https://github.com/o/r/tree/main/src/data/scenarios/tests")).toEqual({
      owner: "o",
      repo: "r",
      ref: "main",
      path: "src/data/scenarios/tests",
    });
    expect(parseGithubFolder("o/r/scenarios/")).toEqual({
      owner: "o",
      repo: "r",
      ref: null,
      path: "scenarios",
    });
    expect(parseGithubFolder("https://github.com/o/r")).toEqual({
      owner: "o",
      repo: "r",
      ref: null,
      path: "",
    });
    expect(parseGithubFolder("not a folder")).toBeNull();
  });

  it("loads scenarios and ship designs and skips other files (contents API)", async () => {
    const scenario = emptyScenario("gh-1");
    const design = BUNDLED_DESIGNS.get("fleet-wasp")!;
    const files: Record<string, unknown> = {
      "https://raw/a.json": scenario,
      "https://raw/b.json": { ...design, id: "gh-ship" },
      "https://raw/c.json": { hello: 1 },
    };
    const calls: string[] = [];
    const fetcher = async (url: string) => {
      calls.push(url);
      if (url.startsWith("https://api.github.com/"))
        return {
          ok: true,
          status: 200,
          json: async () => [
            { name: "a.json", type: "file", download_url: "https://raw/a.json" },
            { name: "b.json", type: "file", download_url: "https://raw/b.json" },
            { name: "c.json", type: "file", download_url: "https://raw/c.json" },
            { name: "notes.md", type: "file", download_url: "https://raw/notes.md" },
            { name: "sub", type: "dir", download_url: null },
          ],
        };
      return { ok: true, status: 200, json: async () => files[url] };
    };
    const r = await loadGithubFolder({ owner: "o", repo: "r", ref: "main", path: "tests" }, fetcher);
    expect(calls[0]).toBe("https://api.github.com/repos/o/r/contents/tests?ref=main");
    expect(r.scenarios.map((s) => s.id)).toEqual(["gh-1"]);
    expect(r.designs.map((d) => d.id)).toEqual(["gh-ship"]);
    expect(r.skipped).toHaveLength(1);
  });

  it("says when GitHub refuses", async () => {
    const fetcher = async () => ({ ok: false, status: 404, json: async () => ({}) });
    await expect(loadGithubFolder({ owner: "o", repo: "r", ref: null, path: "x" }, fetcher)).rejects.toThrow(
      /404/,
    );
  });
});
