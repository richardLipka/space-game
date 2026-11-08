import { describe, expect, it } from "vitest";
import { World } from "../../src/sim/world";
import { length, sub, vec2 } from "../../src/sim/core/vec2";
import { design, testCatalogue } from "../helpers";

const cat = testCatalogue();

describe("M1 environment", () => {
  it("1.25 circular orbit stays within 1% radius over 5 orbits", () => {
    const w = new World({ seed: 1 });
    const r = 1000;
    const period = 60;
    const mu = (4 * Math.PI * Math.PI * r ** 3) / period ** 2;
    w.addGravityWell({ position: vec2(0, 0), mu, softening: 0, coreRadius: 50 });
    const ship = w.addShip(design("brick"), cat, {
      position: vec2(r, 0),
      velocity: vec2(0, Math.sqrt(mu / r)),
    });
    let maxDev = 0;
    for (let i = 0; i < 5 * period * 60; i++) {
      w.step();
      const d = length(w.physics.getWorldCenter(ship.id));
      maxDev = Math.max(maxDev, Math.abs(d - r) / r);
    }
    expect(maxDev).toBeLessThan(0.01);
  });

  it("1.25b gravity well core is a solid body", () => {
    const w = new World({ seed: 1 });
    w.addGravityWell({ position: vec2(0, 0), mu: 1, softening: 0, coreRadius: 50 });
    const ship = w.addShip(design("brick"), cat, { position: vec2(200, 0), velocity: vec2(-50, 0) });
    w.run(600);
    expect(length(w.physics.getWorldCenter(ship.id))).toBeGreaterThan(50);
  });

  it("1.26 soft boundary turns a 50 m/s ship back within boundary + margin", () => {
    const w = new World({ seed: 1 });
    w.arena = { width: 2000, height: 2000 };
    const ship = w.addShip(design("brick"), cat, { position: vec2(900, 0), velocity: vec2(50, 0) });
    let maxX = 0;
    for (let i = 0; i < 60 * 30; i++) {
      w.step();
      maxX = Math.max(maxX, w.physics.getWorldCenter(ship.id).x);
    }
    expect(maxX).toBeGreaterThan(1000);
    expect(maxX).toBeLessThan(1000 + 100);
    expect(w.physics.getBodyState(ship.id).linearVelocity.x).toBeLessThan(0);
  });

  it("asteroids outside the boundary are pushed back too", () => {
    const w = new World({ seed: 1 });
    w.arena = { width: 200, height: 200 };
    w.physics.createBody({ id: "rock", type: "dynamic", position: vec2(150, 0), angle: 0 });
    w.physics.addPolygon("rock", { vertices: [vec2(-1, -1), vec2(1, -1), vec2(1, 1), vec2(-1, 1)] });
    w.run(600);
    expect(length(sub(w.physics.getWorldCenter("rock"), vec2(0, 0)))).toBeLessThan(150);
  });
});
