import { describe, expect, it } from "vitest";
import catalogueJson from "../../src/data/core/catalogue.json";
import { validateCatalogue } from "../../src/data/validate";
import { PartCatalogue } from "../../src/sim/ship/catalogue";
import { BUNDLED_DESIGNS } from "../../src/data/designs/index";
import { aiProfile } from "../../src/data/ai/index";
import { World } from "../../src/sim/world";
import { length, sub, vec2 } from "../../src/sim/core/vec2";

const r = validateCatalogue(catalogueJson);
if (!r.ok) throw new Error(r.errors.join("\n"));
const cat = PartCatalogue.fromJson(r.value);
const wasp = BUNDLED_DESIGNS.get("fleet-wasp")!;

const setup = () => {
  const w = new World({ seed: 1 });
  const s = w.addShip(wasp, cat, { position: vec2(0, 0) });
  return { w, s, st: w.setAi(s.id, aiProfile("balanced")) };
};
const at = (w: World, id: string) => w.physics.getWorldCenter(id);

describe("strategy orders (move, patrol, queue)", () => {
  it("a move order flies to the point and then holds there", () => {
    const { w, s, st } = setup();
    st.order = { kind: "move", point: vec2(1500, 600) };
    w.run(60 * 60);
    expect(length(sub(at(w, s.id), vec2(1500, 600)))).toBeLessThan(200);
    expect(st.order?.kind).toBe("hold");
  });

  it("queued orders run one after the other", () => {
    const { w, s, st } = setup();
    st.order = { kind: "move", point: vec2(1000, 0) };
    st.queue.push({ kind: "move", point: vec2(1000, 1000) });
    w.run(60 * 40);
    expect(st.queue.length + (st.order?.kind === "move" ? 1 : 0)).toBeLessThan(2);
    w.run(60 * 60);
    expect(length(sub(at(w, s.id), vec2(1000, 1000)))).toBeLessThan(250);
    expect(st.queue).toHaveLength(0);
  });

  it("a patrol keeps flying round its waypoints", () => {
    const { w, st } = setup();
    st.order = {
      kind: "patrol",
      points: [vec2(800, 0), vec2(800, 800), vec2(0, 800)],
    };
    const seen = new Set<number>();
    for (let i = 0; i < 180; i++) {
      w.run(60);
      seen.add(st.patrolIndex);
    }
    expect(seen.size).toBe(3);
    expect(st.order?.kind).toBe("patrol");
  });

  it("an attack order ends when the target is defeated and the next order starts", () => {
    const { w, s, st } = setup();
    const t = w.addShip(BUNDLED_DESIGNS.get("platform-target")!, cat, { position: vec2(1500, 0), team: 1 });
    st.order = { kind: "attack", target: t.id };
    st.queue.push({ kind: "move", point: vec2(-500, 0) });
    w.run(30);
    t.defeated = true;
    w.run(60);
    expect(st.order?.kind).toBe("move");
    expect(s.defeated).toBe(false);
  });
});
