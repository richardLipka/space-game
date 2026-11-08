import type { Scenario } from "../../data/schemas/scenario";
import { degToRad, vec2 } from "../core/vec2";
import { World } from "../world";

export interface ScenarioOptions {
  /** Overrides scenario.seed. */
  readonly seed?: number;
}

/** Builds a World from a validated scenario. Ships are added by later milestones. */
export function createWorldFromScenario(scenario: Scenario, options: ScenarioOptions = {}): World {
  const world = new World({ seed: options.seed ?? scenario.seed, enforceDefeat: true });
  world.arena = { width: scenario.arena.width, height: scenario.arena.height };
  for (const a of scenario.arena.asteroids) {
    const id = world.ids.next("asteroid");
    world.physics.createBody({
      id,
      type: a.static ? "static" : "dynamic",
      position: vec2(a.position[0], a.position[1]),
      angle: degToRad(a.angle),
      linearVelocity: a.velocity ? vec2(a.velocity[0], a.velocity[1]) : undefined,
      angularVelocity: a.angularVelocity ? degToRad(a.angularVelocity) : 0,
    });
    const outline = a.outline.map(([x, y]) => vec2(x, y));
    world.asteroids.push({ id, outline });
    world.physics.addPolygon(id, {
      vertices: outline,
      density: a.density ?? 2500,
      friction: 0.4,
      restitution: 0.2,
      tag: id,
    });
  }
  for (const g of scenario.arena.gravityWells) {
    world.gravityWells.push({
      position: vec2(g.position[0], g.position[1]),
      mu: g.mu,
      softening: g.softening,
      coreRadius: g.coreRadius,
      cutoffRadius: g.cutoffRadius,
    });
  }
  return world;
}
