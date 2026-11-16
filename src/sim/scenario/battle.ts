import { missingPartsNote, resolveDesign } from "../ship/resolve";
import type { ShipDesign } from "../../data/schemas/design";
import type { Scenario, Zone } from "../../data/schemas/scenario";
import { SIM_DT } from "../core/loop";
import { BattleLog, type BattleReport, type Side } from "./report";
import type { AiProfile } from "../../data/schemas/ai";
import { degToRad, vec2 } from "../core/vec2";
import type { PartCatalogue } from "../ship/catalogue";
import type { Ship } from "../ship/ship-entity";
import type { World } from "../world";
import { createWorldFromScenario } from "./setup";

/**
 * Scenario battles (spec §12, plan M7 tasks 1–3): fleet budget check, set-up from a scenario, objective
 * tracking and the numbers for the results screen. Pure simulation code: no DOM, no storage.
 */

/** Default guard radius for defensive AI in scenarios (m); matches the Defensive type default. */
export const GUARD_RADIUS = 2500;

export interface FleetCheck {
  readonly ok: boolean;
  readonly cost: number;
  readonly errors: readonly string[];
}

/** Fleet cost (sum of part costs) against the scenario's budget, ship limit and allowed parts (7.4). */
export function checkFleet(
  scenario: Scenario,
  fleet: readonly ShipDesign[],
  catalogue: PartCatalogue,
): FleetCheck {
  const errors: string[] = [];
  let cost = 0;
  for (const d of fleet)
    for (const p of d.parts) cost += catalogue.has(p.partId) ? catalogue.get(p.partId).def.cost : 0;
  if (fleet.length === 0) errors.push("Add at least one ship to the fleet.");
  if (fleet.length > scenario.maxPlayerShips)
    errors.push(`Too many ships: ${fleet.length} of at most ${scenario.maxPlayerShips}.`);
  if (cost > scenario.budget) errors.push(`Over budget: ${cost} of ${scenario.budget}.`);
  const allowed = scenario.allowedParts ? new Set(scenario.allowedParts) : null;
  if (allowed)
    for (const d of fleet)
      for (const p of d.parts)
        if (!allowed.has(p.partId)) errors.push(`${d.name}: ${p.partId} is not allowed in this scenario.`);
  return { ok: errors.length === 0, cost, errors: [...new Set(errors)] };
}

export type BattleStatus = "running" | "won" | "lost";

export interface BattleTally {
  /** Hull damage dealt by the player's side and taken by it. */
  dealt: number;
  taken: number;
  /** Player parts destroyed (wrecked or ejected). */
  partsLost: number;
}

/** Called around every world step of a battle (the replay recorder). */
export interface StepHooks {
  beforeStep(world: World): void;
  afterStep(world: World): void;
}

export interface Battle {
  readonly scenario: Scenario;
  readonly world: World;
  readonly playerShips: Ship[];
  readonly enemyShips: Ship[];
  /** Allied AI ships from the scenario (team 0), e.g. the ship to protect. */
  readonly allyShips: Ship[];
  /** The ship to protect (protect) or to bring to the zone (escort). */
  readonly protectId: string | null;
  /** Zone of an escort, hold or breakout objective. */
  readonly zone: Zone | null;
  /** Hold objective: seconds the zone has been held so far. */
  held: number;
  /** Battle log for the after-action report (docs/battle-report.md). */
  readonly log: BattleLog;
  /** Replay recorder, when the battle is being recorded. */
  recorder: StepHooks | null;
  /** The ship spawned for each `scenario.enemies` entry (undefined where it could not be built). */
  readonly scenarioShips: readonly (Ship | undefined)[];
  /** What could not be loaded as written (unknown designs, parts or AI profiles) and what was done instead. */
  readonly warnings: string[];
  status: BattleStatus;
  reason: string;
  /** Battle time when the status changed (s). */
  endTime: number | null;
  readonly tally: BattleTally;
}

export interface BattleOptions {
  readonly seed?: number;
  /** Resolves design ids used by the scenario (enemies, protect target). */
  readonly designs: ReadonlyMap<string, ShipDesign>;
  readonly profiles: ReadonlyMap<string, AiProfile>;
  /** Drone designs hangars can launch. */
  readonly droneDesigns?: readonly ShipDesign[];
}

/** Builds the world and spawns the player's fleet and the scenario's AI ships. */
export function startBattle(
  scenario: Scenario,
  fleet: readonly ShipDesign[],
  catalogue: PartCatalogue,
  opts: BattleOptions,
): Battle {
  const world = createWorldFromScenario(scenario, opts.seed !== undefined ? { seed: opts.seed } : {});
  for (const d of opts.droneDesigns ?? []) world.registerDesign(d);
  const playerShips = fleet.map((d, i) => {
    const sp = scenario.playerSpawns[i] ?? scenario.playerSpawns[0];
    const pos = sp?.position ?? [0, 0];
    const offset = i >= scenario.playerSpawns.length ? i * 60 : 0;
    return world.addShip(d, catalogue, {
      position: vec2(pos[0], pos[1] + offset),
      angle: degToRad(sp?.angle ?? 0),
      team: 0,
    });
  });
  const enemyShips: Ship[] = [];
  const allyShips: Ship[] = [];
  let protectId: string | null = null;
  const spawned: (Ship | undefined)[] = [];
  const warnings: string[] = [];
  const fallbackProfile = opts.profiles.get("balanced") ?? [...opts.profiles.values()][0] ?? null;
  for (const [i, e] of scenario.enemies.entries()) {
    const d = opts.designs.get(e.designId);
    if (!d) {
      // A design this game does not have (another player's library, a newer version): the ship is left out.
      warnings.push(`Ship ${i + 1}: unknown design "${e.designId}" left out.`);
      spawned.push(undefined);
      continue;
    }
    // "none": no pilot; the ship stays where it is placed (test platforms), its automatic weapons still fire.
    let profile = e.aiProfile === "none" ? null : opts.profiles.get(e.aiProfile);
    if (profile === undefined) {
      warnings.push(`${d.name}: unknown AI "${e.aiProfile}", flies as ${fallbackProfile?.id ?? "no AI"}.`);
      profile = fallbackProfile;
    }
    const resolved = resolveDesign(d, catalogue);
    if (resolved.missing.length) warnings.push(missingPartsNote(d.name, resolved.missing));
    if (!resolved.design) {
      spawned.push(undefined);
      continue;
    }
    const s = world.addShip(resolved.design, catalogue, {
      position: vec2(e.spawn.position[0], e.spawn.position[1]),
      angle: degToRad(e.spawn.angle),
      team: e.team,
    });
    spawned.push(s);
    if (e.team === 0) {
      allyShips.push(s);
      if (profile) world.setAi(s.id, profile, { kind: "hold", point: world.physics.getWorldCenter(s.id) });
      const o = scenario.objective;
      if ((o.type === "protect" || o.type === "escort") && e.designId === o.designId && !protectId) {
        protectId = s.id;
        // The escorted ship makes for the zone on its own.
        if (o.type === "escort" && profile)
          world.setAi(s.id, profile, { kind: "move", point: vec2(o.zone.position[0], o.zone.position[1]) });
      }
    } else {
      enemyShips.push(s);
      if (profile) world.setAi(s.id, profile);
    }
  }
  // Guard orders once every ship exists (a guard may protect a ship listed after it).
  scenario.enemies.forEach((e, i) => {
    const charge = e.guard !== undefined ? spawned[e.guard] : undefined;
    if (!charge || e.guard === i) return;
    const own = spawned[i];
    if (!own) return;
    const st = world.ai.get(own.id);
    if (st) st.order = { kind: "guard", target: charge.id, radius: e.guardRadius ?? GUARD_RADIUS };
  });
  // Nothing to protect (its design is unknown): fight to destroy every enemy instead.
  let goal = scenario;
  const o = scenario.objective;
  if ((o.type === "protect" || o.type === "escort") && !protectId) {
    warnings.push(`No ship to ${o.type} ("${o.designId}"); the goal is to destroy every enemy.`);
    goal = { ...scenario, objective: { type: "destroyAll" } };
  }
  const g = goal.objective;
  const zone = g.type === "escort" || g.type === "hold" || g.type === "breakout" ? g.zone : null;
  if (zone && g.type === "hold") {
    // The enemy holds the beacon: ships without guard orders stay on it and fight what comes near.
    const point = vec2(zone.position[0], zone.position[1]);
    for (const s of enemyShips) {
      const st = world.ai.get(s.id);
      if (st && !st.order) st.order = { kind: "hold", point };
    }
  }
  // Raiders go for the convoy: escort enemies fire at the escorted ship first whenever they can.
  if (g.type === "escort" && protectId)
    for (const s of enemyShips) {
      const st = world.ai.get(s.id);
      if (st) st.focus = protectId;
    }
  if (zone && g.type === "breakout") {
    // A blockade: enemies without orders hold where they are placed and fight what comes near.
    for (const s of enemyShips) {
      const st = world.ai.get(s.id);
      if (st && !st.order) st.order = { kind: "hold", point: world.physics.getWorldCenter(s.id) };
    }
  }
  if (zone && g.type === "breakout")
    world.exits.push({
      position: vec2(zone.position[0], zone.position[1]),
      radius: zone.radius,
      team: 0,
      label: zone.label ?? "Jump point",
    });
  const sides: { ship: Ship; side: Side }[] = [
    ...playerShips.map((ship) => ({ ship, side: "yours" as const })),
    // Without a player fleet (strategy mode, watching) the team-0 ships are the player's side.
    ...allyShips.map((ship) => ({ ship, side: playerShips.length ? ("ally" as const) : ("yours" as const) })),
    ...enemyShips.map((ship) => ({ ship, side: "enemy" as const })),
  ];
  return {
    scenario: goal,
    scenarioShips: spawned,
    warnings,
    world,
    playerShips,
    enemyShips,
    allyShips,
    protectId,
    zone,
    held: 0,
    log: new BattleLog(sides),
    recorder: null,
    status: "running",
    reason: "",
    endTime: null,
    tally: { dealt: 0, taken: 0, partsLost: 0 },
  };
}

const hull = (s: Ship) => s.parts.reduce((t, p) => t + Math.max(0, p.hp), 0);
const maxHull = (s: Ship) => s.parts.reduce((t, p) => t + p.def.def.hp, 0);

/**
 * Checks the objective after a world step (7.3). The status changes once; later calls keep it. Also
 * updates the tally (damage dealt and taken, player parts lost).
 */
export function updateBattle(b: Battle): BattleStatus {
  const w = b.world;
  b.log.update(w);
  const playerIds = new Set(b.playerShips.map((s) => s.id));
  let dealt = 0;
  for (const [attacker, row] of Object.entries(w.combat.damage))
    if (playerIds.has(attacker)) for (const v of Object.values(row)) dealt += v;
  b.tally.dealt = dealt;
  let taken = 0;
  let lost = 0;
  for (const s of b.playerShips) {
    taken += Math.max(0, maxHull(s) - hull(s));
    lost += s.parts.filter((p) => p.hp <= 0).length + (s.design.parts.length - s.parts.length);
  }
  b.tally.taken = taken;
  b.tally.partsLost = lost;
  if (b.status !== "running") return b.status;
  const end = (status: BattleStatus, reason: string) => {
    b.status = status;
    b.reason = reason;
    b.endTime = w.time;
    b.log.note(w, reason);
  };
  const gone = (s: Ship) => s.defeated || s.escaped;
  // A watched battle (no player ships) is decided by the player side's AI ships.
  const ours = b.playerShips.length ? b.playerShips : b.allyShips;
  const o = b.scenario.objective;
  const out = ours.filter((s) => s.escaped).length;
  // Breakout: enough ships through the jump point wins, too few left to make it loses.
  if (o.type === "breakout") {
    const need = Math.min(o.count ?? ours.length, ours.length);
    if (need > 0 && out >= need) {
      end("won", `${out} ship${out === 1 ? "" : "s"} broke out.`);
      return b.status;
    }
    if (ours.filter((s) => !s.defeated).length < need) {
      end("lost", "Too few ships are left to break out.");
      return b.status;
    }
  }
  if (ours.length > 0 && ours.every(gone)) {
    end("lost", out > 0 ? "Your fleet withdrew from the battle." : "All your ships were defeated.");
    return b.status;
  }
  const enemiesDown = b.enemyShips.every(gone);
  const enemyFled = b.enemyShips.some((s) => s.escaped);
  if (o.type === "protect" || o.type === "escort") {
    const p = b.protectId ? w.getShip(b.protectId) : null;
    const name = p ? shortName(p) : "The escorted ship";
    if (!p || p.defeated) end("lost", `${name} was destroyed.`);
    else if (o.type === "protect" && enemiesDown) end("won", `${name} is safe.`);
    else if (o.type === "escort" && (p.escaped || inZone(w, p, o.zone)))
      end("won", `${name} reached ${o.zone.label ?? "the zone"}.`);
  } else if (o.type === "survive") {
    if (w.time >= o.seconds) end("won", `You held out for ${o.seconds} s.`);
  } else if (o.type === "hold") {
    const mine = ours.some((s) => !gone(s) && !s.drone && inZone(w, s, o.zone));
    const contested = b.enemyShips.some((s) => !gone(s) && !s.inert && inZone(w, s, o.zone));
    if (mine && !contested) {
      if (b.held === 0) b.log.note(w, `${o.zone.label ?? "The zone"} is yours`);
      const before = b.held;
      b.held += SIM_DT;
      if (before < o.seconds / 2 && b.held >= o.seconds / 2) b.log.note(w, "Halfway held");
    }
    if (b.held >= o.seconds - 1e-9) end("won", `You held ${o.zone.label ?? "the zone"} for ${o.seconds} s.`);
  } else if (o.type === "breakout") {
    // Decided above.
  } else if (enemiesDown)
    end("won", enemyFled ? "Every enemy ship was destroyed or fled." : "Every enemy ship was defeated.");
  if (
    b.status === "running" &&
    b.scenario.timeLimit &&
    w.time >= b.scenario.timeLimit &&
    o.type !== "survive"
  )
    end("lost", "Time ran out.");
  return b.status;
}

/** A ship's centre is inside a zone. */
export function inZone(world: World, s: Ship, zone: Zone): boolean {
  const c = world.physics.getWorldCenter(s.id);
  return Math.hypot(c.x - zone.position[0], c.y - zone.position[1]) <= zone.radius;
}

const shortName = (s: Ship) => s.design.name.split(" (")[0]!;

/** One battle tick: the recorder around the world step, then the objective check. */
export function stepBattle(b: Battle): BattleStatus {
  b.recorder?.beforeStep(b.world);
  b.world.step();
  b.recorder?.afterStep(b.world);
  return updateBattle(b);
}

/** The after-action report as it stands (docs/battle-report.md). */
export function battleReport(b: Battle): BattleReport {
  return b.log.report(b.world, {
    scenario: b.scenario.name,
    status: b.status,
    reason: b.reason,
    time: b.endTime ?? b.world.time,
  });
}

/** Steps the battle until it ends or `maxSeconds` pass (headless runs, tests). */
export function runBattle(b: Battle, maxSeconds: number): BattleStatus {
  const ticks = Math.round(maxSeconds * 60);
  for (let i = 0; i < ticks && b.status === "running"; i++) stepBattle(b);
  return b.status;
}
