import type { SceneZone } from "../render/scene";
import type { Scenario } from "../data/schemas/scenario";
import { EXIT } from "../sim/world";
import { inZone, type Battle } from "../sim/scenario/battle";
import type { Ship } from "../sim/ship/ship-entity";

/** Battle UI shared by the flight and strategy screens: zones on the map and the objective line. */

const shortName = (s: Ship) => s.design.name.split(" (")[0]!;
const hull = (s: Ship) =>
  s.parts.reduce((t, x) => t + Math.max(0, x.hp), 0) /
  Math.max(
    1,
    s.parts.reduce((t, x) => t + x.def.def.hp, 0),
  );

/** Jump points and the objective's zone (with the hold progress) for the scene. */
export function battleZones(b: Battle): SceneZone[] {
  const out: SceneZone[] = b.world.exits.map((e) => ({
    x: e.position.x,
    y: e.position.y,
    r: e.radius,
    kind: "exit" as const,
    label: e.label ?? "Jump point",
  }));
  const o = b.scenario.objective;
  if (o.type === "escort" || o.type === "hold")
    out.push({
      x: o.zone.position[0],
      y: o.zone.position[1],
      r: o.zone.radius,
      kind: "objective",
      label: o.zone.label ?? (o.type === "hold" ? "Beacon" : "Rendezvous"),
      ...(o.type === "hold" ? { progress: b.held / o.seconds } : {}),
    });
  return out;
}

/** Objective in a few words, for lists (scenario dialog, panels). */
export function objectiveText(s: Scenario): string {
  const o = s.objective;
  const limit = s.timeLimit ? ` within ${Math.round(s.timeLimit)} s` : "";
  switch (o.type) {
    case "survive":
      return `Survive ${o.seconds} s`;
    case "protect":
      return `Protect the escorted ship${limit}`;
    case "escort":
      return `Escort the convoy ship to ${o.zone.label ?? "the zone"}${limit}`;
    case "hold":
      return `Hold ${o.zone.label ?? "the zone"} for ${o.seconds} s${limit}`;
    case "breakout":
      return `Break out: ${o.count ? `${o.count} ship${o.count === 1 ? "" : "s"}` : "every ship"} through ${o.zone.label ?? "the jump point"}${limit}`;
    case "destroyAll":
      return `Destroy every enemy ship${limit}`;
  }
}

/** HUD objective line: what to do and how far along. */
export function objectiveLine(b: Battle): string {
  const o = b.scenario.objective;
  const w = b.world;
  const left = b.enemyShips.filter((s) => !s.defeated && !s.escaped).length;
  if (b.status !== "running") return b.status === "won" ? "complete" : "failed";
  const limit = b.scenario.timeLimit
    ? ` · ${Math.max(0, b.scenario.timeLimit - w.time).toFixed(0)} s left`
    : "";
  const ours = b.playerShips.length ? b.playerShips : b.allyShips;
  switch (o.type) {
    case "survive":
      return `survive ${Math.max(0, o.seconds - w.time).toFixed(0)} s more · ${left} enemies`;
    case "protect":
    case "escort": {
      const p = b.protectId ? w.getShip(b.protectId) : null;
      if (!p) break;
      const where =
        o.type === "escort"
          ? ` to ${o.zone.label ?? "the zone"} (${Math.round(
              Math.max(
                0,
                Math.hypot(
                  w.physics.getWorldCenter(p.id).x - o.zone.position[0],
                  w.physics.getWorldCenter(p.id).y - o.zone.position[1],
                ) - o.zone.radius,
              ),
            )} m)`
          : "";
      return `${o.type} ${shortName(p)}${where} · hull ${Math.round(hull(p) * 100)} % · ${left} enemies${limit}`;
    }
    case "hold": {
      const mine = ours.some((s) => !s.defeated && !s.escaped && !s.drone && inZone(w, s, o.zone));
      const contested = b.enemyShips.some(
        (s) => !s.defeated && !s.escaped && !s.inert && inZone(w, s, o.zone),
      );
      const state = contested ? (mine ? "contested" : "enemy holds it") : mine ? "holding" : "not held";
      return `hold ${o.zone.label ?? "the zone"} · ${b.held.toFixed(0)} / ${o.seconds} s · ${state}${limit}`;
    }
    case "breakout": {
      const out = ours.filter((s) => s.escaped).length;
      const need = Math.min(o.count ?? ours.length, ours.length);
      const dwell = Math.max(0, ...ours.map((s) => w.exitDwell.get(s.id) ?? 0));
      const jumping = dwell > 0 ? ` · jumping in ${Math.max(0, EXIT.dwell - dwell).toFixed(1)} s` : "";
      return `break out through ${o.zone.label ?? "the jump point"} · ${out} / ${need} out${jumping}${limit}`;
    }
    case "destroyAll":
      break;
  }
  return `destroy all enemies · ${left} left${limit}`;
}
