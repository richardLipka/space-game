import { describe, expect, it } from "vitest";
import catalogueJson from "../../src/data/core/catalogue.json";
import { validateCatalogue } from "../../src/data/validate";
import { AI_PROFILES, aiProfile } from "../../src/data/ai/index";
import { BUNDLED_DESIGNS } from "../../src/data/designs/index";
import { SCENARIOS } from "../../src/data/scenarios/index";
import { PartCatalogue } from "../../src/sim/ship/catalogue";
import { battleReport, startBattle, stepBattle, type Battle } from "../../src/sim/scenario/battle";
import {
  BattleRecorder,
  fromJson,
  ReplayPlayer,
  toJson,
  type ReplayData,
} from "../../src/sim/scenario/record";
import { vec2 } from "../../src/sim/core/vec2";

const r = validateCatalogue(catalogueJson);
if (!r.ok) throw new Error(r.errors.join("\n"));
const cat = PartCatalogue.fromJson(r.value);
const scenario = SCENARIOS.find((s) => s.id === "s11-mirror-destroyers")!;
const fleet = ["fleet-rapier", "fleet-viper"].map((id) => BUNDLED_DESIGNS.get(id)!);
const opts = { designs: BUNDLED_DESIGNS, profiles: AI_PROFILES };

/** A scripted "player": flies ship 0 by hand and commands ship 1 through the AI, between steps. */
function play(b: Battle, ticks: number): void {
  const w = b.world;
  const [me, wing] = b.playerShips;
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) * 2 - 1;
  for (let i = 0; i < ticks; i++) {
    if (i === 0) w.setAi(wing!.id, aiProfile("balanced"), { kind: "follow", leader: me!.id });
    if (i % 7 === 0 && !me!.defeated) {
      w.setIntent(me!.id, { thrust: vec2(rnd(), rnd() * 0.5), rotate: 0, faceAngle: rnd() * Math.PI });
      me!.weaponCommand = {
        trigger: rnd() > 0,
        aimPoint: vec2(2500 + rnd() * 300, rnd() * 300),
        selected: new Set([1, 2]),
        targetId: b.enemyShips[0]!.id,
        launch: i % 210 === 0 ? "salvo" : false,
      };
    }
    const st = w.ai.get(wing!.id);
    if (st && i === 600) st.order = { kind: "move", point: vec2(800, 900) };
    if (st && i === 900) {
      st.profile = aiProfile("kiter");
      st.nextEval = 0;
      st.focus = b.enemyShips[1]!.id;
    }
    if (st && i === 1200) st.roe = "return";
    if (i === 1300) me!.pdEngageShips = true;
    stepBattle(b);
  }
}

function record(ticks: number): { data: ReplayData; hash: string } {
  const b = startBattle(scenario, fleet, cat, opts);
  const rec = new BattleRecorder(b, {
    title: "test",
    fleet,
    designs: BUNDLED_DESIGNS,
    droneDesigns: [],
    profiles: AI_PROFILES,
    id: "r1",
    createdAt: "2026-01-01T00:00:00Z",
  });
  play(b, ticks);
  return { data: rec.data(battleReport(b)), hash: b.world.hash() };
}

function replay(data: ReplayData): ReplayPlayer {
  const p = new ReplayPlayer(data, cat);
  while (!p.done) stepBattle(p.battle);
  return p;
}

describe("battle replays (docs/battle-report.md)", () => {
  it("a recorded battle with manual flying and orders replays to the same world", () => {
    const { data, hash } = record(1800);
    expect(data.frames.length).toBeGreaterThan(100);
    expect(data.checks.length).toBe(6);
    const p = replay(data);
    expect(p.diverged).toBeNull();
    expect(p.battle.world.hash()).toBe(hash);
    // The report of the replayed battle matches the recorded one.
    expect(toJson(battleReport(p.battle).ships)).toBe(toJson(data.report!.ships));
  });

  it("survives a round trip through JSON (a saved file), −0 included", () => {
    const { data, hash } = record(900);
    expect(fromJson<number>(toJson(-0))).toBe(-0);
    const p = replay(fromJson<ReplayData>(toJson(data)));
    expect(p.diverged).toBeNull();
    expect(p.battle.world.hash()).toBe(hash);
  });

  it("notices when a replay no longer matches", () => {
    const { data } = record(900);
    const frames = data.frames.filter((f) => !("intent" in f.c) || f.t < 120);
    const p = replay({ ...data, frames });
    expect(p.diverged).not.toBeNull();
  });
});
