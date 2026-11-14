import { describe, expect, it } from "vitest";
import catalogueJson from "../../src/data/core/catalogue.json";
import { validateCatalogue } from "../../src/data/validate";
import { PartCatalogue } from "../../src/sim/ship/catalogue";
import { BUNDLED_DESIGNS } from "../../src/data/designs/index";
import { World } from "../../src/sim/world";
import { length, sub, vec2 } from "../../src/sim/core/vec2";

const r = validateCatalogue(catalogueJson);
if (!r.ok) throw new Error(r.errors.join("\n"));
const cat = PartCatalogue.fromJson(r.value);
const wasp = BUNDLED_DESIGNS.get("fleet-wasp")!;
const idle = { thrust: vec2(0, 0), rotate: 0 };

function setup() {
  const w = new World({ seed: 1 });
  const me = w.addShip(wasp, cat, { position: vec2(0, 0) });
  // Guns hold fire: the test is about flying, not about shooting the target to pieces.
  for (let g = 1; g <= 9; g++) me.groupModes.set(g, "hold");
  const t = w.addShip(BUNDLED_DESIGNS.get("platform-target")!, cat, {
    position: vec2(3000, 500),
    velocity: vec2(-20, 12),
    team: 1,
  });
  return { w, me, t };
}

describe("course matching (C, V, Shift+V)", () => {
  it("C matches the target's velocity and keeps holding it", () => {
    const { w, me, t } = setup();
    w.setIntent(me.id, { ...idle, match: { kind: "velocity", targetId: t.id, distance: 1000, lock: false } });
    w.run(60 * 40);
    const rel = sub(
      w.physics.getBodyState(me.id).linearVelocity,
      w.physics.getBodyState(t.id).linearVelocity,
    );
    expect(length(rel)).toBeLessThan(1);
    expect(me.flight.match?.kind).toBe("velocity");
  });

  it("V closes to the set distance and stays there", () => {
    const { w, me, t } = setup();
    w.setIntent(me.id, { ...idle, match: { kind: "distance", targetId: t.id, distance: 800, lock: false } });
    w.run(60 * 100);
    const d = length(sub(w.physics.getWorldCenter(t.id), w.physics.getWorldCenter(me.id)));
    expect(Math.abs(d - 800)).toBeLessThan(40);
    const rel = sub(
      w.physics.getBodyState(me.id).linearVelocity,
      w.physics.getBodyState(t.id).linearVelocity,
    );
    expect(length(rel)).toBeLessThan(3);
  });

  it("manual thrust ends unlocked matching; locked matching resumes after it; X replaces it", () => {
    const { w, me, t } = setup();
    w.setIntent(me.id, { ...idle, match: { kind: "distance", targetId: t.id, distance: 800, lock: false } });
    w.run(10);
    w.setIntent(me.id, { thrust: vec2(1, 0), rotate: 0 });
    w.run(5);
    expect(me.flight.match ?? null).toBeNull();
    w.setIntent(me.id, { ...idle, match: { kind: "distance", targetId: t.id, distance: 800, lock: true } });
    w.run(5);
    w.setIntent(me.id, { thrust: vec2(1, 0), rotate: 0 });
    w.run(30);
    expect(me.flight.match?.lock).toBe(true);
    w.setIntent(me.id, { ...idle, speedKill: "keep" });
    w.run(1);
    expect(me.flight.match ?? null).toBeNull();
  });

  it("matching ends when the target is gone", () => {
    const { w, me, t } = setup();
    w.setIntent(me.id, { ...idle, match: { kind: "velocity", targetId: t.id, distance: 1000, lock: false } });
    w.run(5);
    t.defeated = true;
    w.run(2);
    expect(me.flight.match ?? null).toBeNull();
  });
});
