import { DOCTRINE, isMissileLine, isPass, passSteering, salvoDue, wallOffset } from "./doctrine";
import { bearingOf, FIREPOWER, liveFirepower } from "./firepower";
import type { AiProfile } from "../../data/schemas/ai";
import {
  type Vec2,
  add,
  angleOf,
  cross,
  dot,
  length,
  normalize,
  rotate,
  scale,
  sub,
  vec2,
} from "../core/vec2";
import { compareIds } from "../core/ids";
import { intercept } from "../combat/lead";
import type { GroupMode } from "../combat/weapons";
import type { Ship } from "../ship/ship-entity";
import type { World } from "../world";
import { burstKind } from "../flight/burst";
import type { BurstKind } from "../flight/controller";
import { toShipDir } from "../ship/ship";
import { DRONE } from "../combat/constants";
import { capabilityProfile, type CapabilityProfile } from "./capabilities";
import { avoidObstacles, steerToIntent, type Steering } from "./steering";

/**
 * Utility AI (spec §11, plan M6). Each AI ship re-evaluates its target and behaviour every
 * AI_TUNING.evalInterval, then steers and fires every tick through the same ControlIntent and weapon
 * commands as the player. It never touches physics directly (plan test 6.1).
 */

export type Behaviour =
  | "approach"
  | "hold"
  | "broadside"
  | "face"
  | "evade"
  | "retreat"
  | "cool"
  | "follow"
  | "station"
  | "idle"
  /** Aggressive AI out of ammunition: flies into its target. */
  | "ram";

/** Allied orders (spec §11.3). They replace the top-level goal; evade, cool down and retreat still apply. */
export type Order =
  | { readonly kind: "follow"; readonly leader: string }
  | { readonly kind: "attack"; readonly target: string }
  /** `facing`: world direction the attack front should point while holding (rad). */
  | { readonly kind: "hold"; readonly point: Vec2; readonly facing?: number }
  /** Defensive AI: stay with `target` and engage enemies within `radius` of it. */
  | { readonly kind: "guard"; readonly target: string; readonly radius: number }
  /** Strategy mode: fly to `point`, then hold there (engaging armed enemies near it). */
  | {
      readonly kind: "move";
      readonly point: Vec2;
      /** World direction the attack front points on arrival (rad); kept while holding there. */
      readonly facing?: number;
      /** On the way, turn the attack front towards this point when the main engine is not needed. */
      readonly aimAt?: Vec2;
    }
  /** Strategy mode: fly round `points` in a loop, engaging armed enemies near the path. */
  | { readonly kind: "patrol"; readonly points: readonly Vec2[] }
  /**
   * Strategy mode, timed actions: hold at `point` until ship `ship` has arrived (no move orders left, or it
   * is gone); then the next order starts. "When A arrives, B departs or attacks" is B: wait for A, then
   * move or attack.
   */
  | { readonly kind: "wait"; readonly ship: string; readonly point: Vec2 };

export const AI_TUNING = {
  /** Seconds between behaviour and target evaluations. */
  evalInterval: 0.5,
  /** Utility bonus for the current behaviour (hysteresis). */
  stickiness: 0.15,
  /** Target score bonus for the current target (hysteresis). */
  targetStickiness: 1.2,
  /** Missiles closer to impact than this (s) trigger evasion. */
  evadeHorizon: 6,
  /** Seconds before a missile arrives when a ship with burst engines jolts sideways out of its path. */
  burstDodge: 1.2,
  /** Cool down above this heat level, until it drops below `coolExit`. */
  coolEnter: 0.7,
  coolExit: 0.5,
  /**
   * Fuel: the AI never asks for more speed than this share of the Δv left (nor less than `fuelMinSpeed`),
   * so it does not burn its tanks dry in the first minutes and drift helplessly afterwards.
   */
  fuelSpeedShare: 0.4,
  fuelMinSpeed: 25,
  /** A gunless carrier stands off at this share of its drone launch range (within drone control range). */
  carrierStandoff: 0.6,
  /** Hit probability used when planning the preferred range (see preferredRange). */
  rangePlanningProbability: 0.2,
  /** Retreat speed as a share of the profile's top speed (a pursuer at full speed catches up). */
  retreatSpeed: 0.6,
  /** Kiters back off when an enemy comes inside this share of their range. */
  kiteInside: 0.8,
  /**
   * Outgunned check: enemies and friends within this multiple of the preferred range (at least
   * `outgunnedMinReach`), so a superior force is seen coming before it is in gun range.
   */
  outgunnedReach: 3,
  outgunnedMinReach: 4000,
  /** A ship stops escaping once the odds fall below this share of its outgunned ratio. */
  outgunnedExit: 0.75,
  /** Escaping ships run at this multiple of the profile's top speed (fuel permitting): to get away. */
  escapeSpeed: 1.6,
  /** Escaping ships slide along the arena edge within this distance of it (m). */
  escapeEdgeMargin: 1500,
  /** Rammers keep ramming while their hull is above this share. */
  ramMinHull: 0.15,
  /** Retreating AI type: falls back while an enemy is within this multiple of its engage range. */
  withdrawReach: 1.6,
  /** While cooling, guns (not PD) also hold fire above this heat level. */
  holdGunsAbove: 0.9,
  /** Position gain for steering toward a goal point (1/s). */
  gain: 0.5,
  /** Followers and holders engage armed enemies this close to their leader or point (m). */
  engageRadius: 2000,
  /** Formation spacing behind the leader (m), at least; larger ships keep more. */
  formationSpacing: 60,
  /** Above this speed (m/s) a formation turns with its leader's direction of travel. */
  formationTurnSpeed: 5,
  /** A move order or patrol waypoint counts as reached within this distance (m), or 3 ship radii. */
  arriveDistance: 120,
} as const;

export interface AiState {
  profile: AiProfile;
  order: Order | null;
  /** Orders waiting after the current one (strategy mode, Shift+right click). */
  queue: Order[];
  /** Waypoint a patrol is flying to. */
  patrolIndex: number;
  /** Pass doctrine (leader): inbound to the enemy or out past it, and which side of it this pass goes. */
  passPhase: "in" | "out";
  passSide: 1 | -1;
  /** Tick the formation went past the enemy (it comes about after a while even if chased). */
  passOutTick: number;
  behaviour: Behaviour;
  /**
   * How a retreat is flown: "fight" is the hull-based fighting withdrawal (a pursuer catches up); "escape"
   * runs at full speed, for a ship with nothing left to fight with or one that is outgunned (cautious), so it
   * survives to fight again.
   */
  retreatMode: "fight" | "escape";
  scores: Partial<Record<Behaviour, number>>;
  targetId: string | null;
  /** Tick of the next evaluation. */
  nextEval: number;
  /** Cool-down latch (heat hysteresis). */
  cooling: boolean;
  lastVolleyTick: number;
  dronesLaunched: boolean;
  decoysLaunchedTick: number;
  /** Heading that lets the most turrets bear on the target (rad), refreshed at each evaluation. */
  broadsideAngle: number | null;
  /** Size of the current target for hit-probability range planning (m). */
  targetRadius: number;
  /** Formation slot among the leader's followers. */
  slot: number;
  /**
   * Direction the formation is laid out along (rad): the leader's direction of travel, kept while it is
   * slow. Not its heading: a leader that flips to burn would swing every slot through itself.
   */
  formationAngle: number | null;
  /** Weapon group modes before the AI took over, restored when the player takes control. */
  readonly savedModes: [number, GroupMode][];
  /** Last steering request, for the debug view. */
  debug: { desiredVel: Vec2; faceAngle: number | null };
  caps: CapabilityProfile | null;
}

export function createAiState(ship: Ship, profile: AiProfile, order: Order | null, slot = 0): AiState {
  return {
    profile,
    order,
    queue: [],
    patrolIndex: 0,
    passPhase: "in",
    passSide: 1,
    passOutTick: 0,
    behaviour: "idle",
    retreatMode: "fight",
    scores: {},
    targetId: null,
    nextEval: 0,
    cooling: false,
    lastVolleyTick: -1e9,
    dronesLaunched: false,
    decoysLaunchedTick: -1e9,
    broadsideAngle: null,
    targetRadius: 3,
    slot,
    formationAngle: null,
    savedModes: [...ship.groupModes],
    debug: { desiredVel: vec2(0, 0), faceAngle: null },
    caps: null,
  };
}

/**
 * Preferred engagement range (m): each gun counts with the distance at which it still meets the profile's
 * hit-probability floor against a target of `targetRadius` (or its reach, if shorter), weighted by DPS,
 * then scaled by the profile's range factor. Ships without guns stand off at missile range.
 */
export function preferredRange(
  caps: CapabilityProfile,
  profile: AiProfile,
  targetRadius = 3,
  mounts: "fixed" | "turret" | "main" = "main",
): number {
  // "main": the ship's dominant armament (fixed if most of the DPS is fixed).
  const want = mounts === "main" ? (caps.weapons.fixedShare >= 0.5 ? "fixed" : "turret") : mounts;
  const pick = caps.weapons.guns.filter((g) => (want === "fixed") === g.fixed);
  let sum = 0;
  let dps = 0;
  for (const g of pick.length ? pick : caps.weapons.guns) {
    // Range is planned at one fixed hit probability, so the profile's range factor alone sets the
    // distance and its fire threshold only decides when to shoot (a picky shooter waits for good shots
    // instead of closing in; an eager one does not stand further off).
    const plan = AI_TUNING.rangePlanningProbability;
    const pReach = g.spread > 0 && plan > 0 ? targetRadius / (2 * Math.tan(g.spread) * plan) : g.reach;
    sum += g.dps * Math.min(g.reach, pReach);
    dps += g.dps;
  }
  // Missile-line doctrine: stand off near missile range whatever the guns could reach.
  if (profile.doctrine === "missile-line" && caps.missiles.range > 0)
    return caps.missiles.range * (profile.standoffFactor ?? DOCTRINE.missileLine.standoff);
  // Gunless ships: missile ships stand off within missile range; carriers stand off and let drones fight
  // (also once the drones are out, so the carrier does not drift into gun range).
  const base =
    dps > 0
      ? sum / dps
      : caps.missiles.range > 0
        ? caps.missiles.range * 0.7
        : caps.drones.hangars > 0
          ? Math.min(profile.droneLaunchRange, DRONE.controlRange) * AI_TUNING.carrierStandoff
          : 1000;
  return Math.max(150, base * profile.rangeFactor);
}

/** The range the current behaviour aims for: turret range in broadside, fixed range when facing, else the main armament's. */
export function engagementRange(st: AiState): number {
  if (!st.caps) return 1000;
  const mounts = st.behaviour === "broadside" ? "turret" : st.behaviour === "face" ? "fixed" : "main";
  return preferredRange(st.caps, st.profile, st.targetRadius, mounts);
}

/** Highest closing speed from which the ship can still stop within `d`, counting a turn to burn (m/s). */
function arrivalSpeed(caps: CapabilityProfile, d: number): number {
  const a = 0.6 * Math.max(caps.accel.fwd, caps.accel.back, caps.accel.left, caps.accel.right);
  if (a <= 0) return 0;
  const T = Math.min(caps.turnTime180, 10);
  const x = Math.max(0, d - 20);
  return a * (-T + Math.sqrt(T * T + (2 * x) / a));
}

const wrap = (a: number): number => {
  let x = (a + Math.PI) % (2 * Math.PI);
  if (x < 0) x += 2 * Math.PI;
  return x - Math.PI;
};

interface Pose {
  readonly pos: Vec2;
  readonly vel: Vec2;
  readonly angle: number;
}
const poseOf = (world: World, id: string): Pose => {
  const b = world.physics.getBodyState(id);
  return { pos: world.physics.getWorldCenter(id), vel: b.linearVelocity, angle: b.angle };
};

/** Enemy missiles homing on `ship` and arriving within the evade horizon, soonest first. */
function incomingMissiles(world: World, ship: Ship, me: Pose) {
  const out: { pos: Vec2; vel: Vec2; t: number }[] = [];
  for (const m of world.combat.missiles) {
    if (m.team === ship.team || m.target !== ship.id || m.hp <= 0) continue;
    const r = sub(me.pos, m.pos);
    const v = sub(m.vel, me.vel);
    const closing = (r.x * v.x + r.y * v.y) / Math.max(1e-6, length(r));
    const t = closing > 1 ? length(r) / closing : Infinity;
    if (t <= AI_TUNING.evadeHorizon) out.push({ pos: m.pos, vel: m.vel, t });
  }
  return out.sort((a, b) => a.t - b.t);
}

/**
 * Burst engines: a missile about to hit makes the ship jolt sideways, across the missile's path (the side it
 * is already on, or the other one when only that engine is ready). Ships without burst engines never do.
 */
function burstDodge(world: World, ship: Ship, me: Pose): BurstKind | null {
  const engines = ship.burstEngines;
  if (!engines.length) return null;
  const ready = new Set<BurstKind>();
  for (const p of engines)
    if (p.hp > 0 && ship.burstReadyIn(p.uid) <= 0) ready.add(burstKind(toShipDir(p, p.def.burstDir!)));
  if (!ready.has("left") && !ready.has("right")) return null;
  const m = incomingMissiles(world, ship, me)[0];
  if (!m || m.t > AI_TUNING.burstDodge) return null;
  const mv = length(m.vel) > 1e-6 ? normalize(m.vel) : vec2(1, 0);
  const side = cross(mv, sub(me.pos, m.pos)) >= 0 ? 1 : -1;
  const local = rotate(scale(vec2(-mv.y, mv.x), side), -me.angle);
  const want: BurstKind = local.y >= 0 ? "left" : "right";
  return ready.has(want) ? want : want === "left" ? "right" : "left";
}

/** Target choice (spec §11.2): threat ÷ distance, preferring weakened targets; orders narrow the field. */
function chooseTarget(world: World, ship: Ship, st: AiState, me: Pose): string | null {
  const order = st.order;
  if (order?.kind === "attack" && world.hasShip(order.target)) {
    const t = world.getShip(order.target);
    if (!t.defeated && !t.inert && t.team !== ship.team) return t.id;
  }
  const guarded = order?.kind === "guard" && world.hasShip(order.target) ? order : null;
  const anchor =
    order?.kind === "follow" && world.hasShip(order.leader)
      ? world.physics.getWorldCenter(order.leader)
      : order?.kind === "hold" || order?.kind === "move" || order?.kind === "patrol" || order?.kind === "wait"
        ? orderPoint(st)
        : guarded
          ? world.physics.getWorldCenter(guarded.target)
          : null;
  const radius = guarded ? guarded.radius : AI_TUNING.engageRadius;
  let best: string | null = null;
  let bestScore = 0;
  for (const s of world.allShips()) {
    if (s.team === ship.team || s.defeated || s.inert) continue;
    const pos = world.physics.getWorldCenter(s.id);
    const caps = capabilityProfile(s);
    const armed = caps.threat > 0;
    // Followers and holders only engage armed enemies near their leader or point.
    if (anchor && (!armed || length(sub(pos, anchor)) > radius)) continue;
    // Guards rank threats by how close they are to the guarded ship, not to themselves.
    const dist = Math.max(100, length(sub(pos, guarded && anchor ? anchor : me.pos)));
    let score = ((caps.threat + 1) / dist) * (1 + st.profile.preferWeakened * (1 - caps.hp));
    if (s.drone) score *= 0.3;
    if (s.id === st.targetId) score *= AI_TUNING.targetStickiness;
    if (score > bestScore || (score === bestScore && best !== null && compareIds(s.id, best) < 0)) {
      bestScore = score;
      best = s.id;
    }
  }
  return best;
}

/**
 * Heading (rad) that turns the ship's strongest firepower (weapons as they are now, see firepower.ts) on
 * `bearing`: of the directions within `FIREPOWER.tie` of the best, the one needing the least turn, so a
 * symmetric ship uses the nearer broadside. Null without working weapons.
 */
function bestHeading(ship: Ship, bearing: number, current: number): number | null {
  const { profile } = liveFirepower(ship);
  const max = Math.max(...profile);
  if (max <= 0) return null;
  let best: number | null = null;
  let bestTurn = Infinity;
  profile.forEach((d, i) => {
    if (d < max * FIREPOWER.tie) return;
    const h = wrap(bearing - bearingOf(i));
    const turn = Math.abs(wrap(h - current));
    if (turn < bestTurn) {
      best = h;
      bestTurn = turn;
    }
  });
  return best;
}

/** Utility scores (spec §11.2) for this evaluation. */
function scoreBehaviours(
  ship: Ship,
  st: AiState,
  caps: CapabilityProfile,
  dist: number | null,
  incoming: number,
  outgunned = false,
): Partial<Record<Behaviour, number>> {
  const w = st.profile.weights;
  const R = preferredRange(caps, st.profile, st.targetRadius);
  const s: Partial<Record<Behaviour, number>> = {};
  let escape = false;
  const gunDps = caps.weapons.fixedDps + caps.weapons.turretDps;
  const armed = gunDps > 0 || caps.missiles.stock > 0 || caps.drones.stored > 0 || ship.liveDrones > 0;
  if (dist !== null) {
    s.approach = w.approach * Math.min(1.5, Math.max(0, (dist - R * 1.15) / R));
    const inBand = 1 - Math.min(1, Math.max(0, (dist - R * 1.15) / (R * 0.5)));
    s.hold = w.hold * inBand * 0.7;
    if (gunDps > 0) {
      s.face = w.face * inBand * caps.weapons.fixedShare * 1.1;
      if (caps.weapons.turretDps > 0)
        s.broadside = w.broadside * inBand * (1 - caps.weapons.fixedShare) * 1.1;
    }
    // Out of weapons (spent or shot off) → retreat. Ships built without any (PD escorts) stay in the fight.
    const builtArmed = ship.parts.some(
      (p) => p.def.def.hangar || (p.def.def.weapon && p.def.def.weapon.kind !== "pd"),
    );
    if (!armed && builtArmed) {
      // Aggressive ships ram while they can take the knock; the rest get away to fight another day.
      if (st.profile.ramWhenDry && caps.hp > AI_TUNING.ramMinHull) s.ram = 3;
      else {
        s.retreat = w.retreat * 2;
        escape = true;
      }
    }
    // Retreating stance: always falling back while an enemy is in sight (it keeps firing).
    // Once out of reach it stops and waits (and turns to fight whoever follows).
    if (st.profile.stance === "retreating" && dist < R * AI_TUNING.withdrawReach)
      s.retreat = Math.max(s.retreat ?? 0, w.retreat * 3);
  } else if (st.order?.kind === "follow" || st.order?.kind === "guard") s.follow = 0.5;
  else if (
    st.order?.kind === "hold" ||
    st.order?.kind === "move" ||
    st.order?.kind === "patrol" ||
    st.order?.kind === "wait"
  )
    s.station = 0.5;
  // A move order goes first: the ship flies there before it fights (it still fires on the way).
  if (st.order?.kind === "move") s.station = 2;
  else s.idle = 0.1;
  // Missile line: every ship holds its place in the wall (hold faces the strongest side anyway), instead of
  // orbiting off on a broadside of its own.
  if (isMissileLine(st) && dist !== null) {
    s.hold = Math.max(s.hold ?? 0, s.broadside ?? 0, s.face ?? 0);
    delete s.broadside;
    delete s.face;
  }
  if (incoming > 0) s.evade = w.evade * (0.9 + 0.2 * Math.min(incoming, 4));
  // Badly damaged: retreat outranks closing in (approach tops out at 1.5).
  if (caps.hp < st.profile.retreatHp) s.retreat = Math.max(s.retreat ?? 0, w.retreat * 2.2);
  // Outgunned (cautious, carrier): disengage and get clear.
  if (outgunned && dist !== null) {
    s.retreat = Math.max(s.retreat ?? 0, w.retreat * 2.5);
    escape = true;
  }
  if (st.cooling) s.cool = w.cool * 1.4;
  st.retreatMode = escape ? "escape" : "fight";
  return s;
}

/**
 * Escape direction near the arena edge: the part heading out of the arena is dropped, so the ship slides
 * along the edge instead of stopping against it (cornered: across the threat's bearing).
 */
function slideAlongEdge(world: World, pos: Vec2, away: Vec2, toThreat: Vec2 | null): Vec2 {
  const arena = world.arena;
  if (!arena) return away;
  const margin = AI_TUNING.escapeEdgeMargin;
  let x = away.x;
  let y = away.y;
  if (Math.abs(pos.x) > arena.width / 2 - margin && Math.sign(x) === Math.sign(pos.x)) x = 0;
  if (Math.abs(pos.y) > arena.height / 2 - margin && Math.sign(y) === Math.sign(pos.y)) y = 0;
  if (Math.hypot(x, y) > 0.2) return normalize(vec2(x, y));
  // Cornered: run across the threat's bearing, towards the arena's middle.
  const across = toThreat && length(toThreat) > 1e-6 ? normalize(vec2(-toThreat.y, toThreat.x)) : vec2(0, 1);
  return dot(across, pos) > 0 ? scale(across, -1) : across;
}

/**
 * Outgunned (profiles with `outgunnedRatio`): the threat of the enemies near the ship is above that multiple
 * of its own side's threat there (damage counted). Once escaping it keeps going until the odds have eased.
 */
function isOutgunned(world: World, ship: Ship, st: AiState, me: Pose, caps: CapabilityProfile): boolean {
  const ratio = st.profile.outgunnedRatio;
  if (!ratio) return false;
  const reach = Math.max(
    AI_TUNING.outgunnedMinReach,
    preferredRange(caps, st.profile, st.targetRadius) * AI_TUNING.outgunnedReach,
  );
  let foes = 0;
  let friends = 0;
  for (const s of world.allShips()) {
    if (s.defeated || s.inert || s.drone) continue;
    if (length(sub(world.physics.getWorldCenter(s.id), me.pos)) > reach) continue;
    const c = s === ship ? caps : capabilityProfile(s);
    const threat = c.threat * Math.max(0.25, c.hp);
    if (s.team === ship.team) friends += threat;
    else foes += threat;
  }
  const escaping = st.behaviour === "retreat" && st.retreatMode === "escape";
  return foes > ratio * (escaping ? AI_TUNING.outgunnedExit : 1) * Math.max(1, friends);
}

/** One evaluation: target, cool-down latch, broadside heading and behaviour (with hysteresis). */
/** Where a hold, move or patrol order is taking the ship, if it is one. */
export function orderPoint(st: AiState): Vec2 | null {
  const o = st.order;
  if (o?.kind === "hold" || o?.kind === "move" || o?.kind === "wait") return o.point;
  if (o?.kind === "patrol" && o.points.length) return o.points[st.patrolIndex % o.points.length]!;
  return null;
}

/** Starts the next queued order, or holds where the ship is when the queue is empty. */
export function nextOrder(st: AiState, here: Vec2): void {
  st.order = st.queue.shift() ?? { kind: "hold", point: here };
  st.patrolIndex = 0;
}

/** Finished orders give way to the next in the queue (strategy mode); patrols move to their next waypoint. */
function advanceOrders(world: World, ship: Ship, st: AiState, me: Pose): void {
  const o = st.order;
  if (!o) {
    if (st.queue.length) nextOrder(st, me.pos);
    return;
  }
  const arrive = Math.max(AI_TUNING.arriveDistance, ship.layout.boundingRadius * 3);
  if (o.kind === "move" && length(sub(o.point, me.pos)) < arrive) {
    if (st.queue.length) nextOrder(st, me.pos);
    else st.order = { kind: "hold", point: o.point, ...(o.facing !== undefined ? { facing: o.facing } : {}) };
  } else if (o.kind === "attack") {
    const t = world.hasShip(o.target) ? world.getShip(o.target) : null;
    if (!t || t.defeated || t.inert) nextOrder(st, me.pos);
  } else if (o.kind === "patrol" && o.points.length) {
    if (length(sub(orderPoint(st)!, me.pos)) < arrive)
      st.patrolIndex = (st.patrolIndex + 1) % o.points.length;
  } else if (o.kind === "wait") {
    if (arrived(world, o.ship)) nextOrder(st, me.pos);
  } else if (o.kind === "hold" && st.queue.length) nextOrder(st, me.pos);
}

/** A ship has arrived (for wait orders): it has no move orders left, or it is gone or defeated. */
export function arrived(world: World, shipId: string): boolean {
  if (!world.hasShip(shipId)) return true;
  const s = world.getShip(shipId);
  if (s.defeated || s.inert) return true;
  const st = world.ai.get(shipId);
  if (!st) return true;
  return st.order?.kind !== "move" && !st.queue.some((o) => o.kind === "move");
}

function evaluate(world: World, ship: Ship, st: AiState, me: Pose): void {
  advanceOrders(world, ship, st, me);
  const caps = capabilityProfile(ship);
  st.caps = caps;
  if (caps.heat > AI_TUNING.coolEnter) st.cooling = true;
  else if (caps.heat < AI_TUNING.coolExit) st.cooling = false;
  st.targetId = chooseTarget(world, ship, st, me);
  st.targetRadius = st.targetId ? Math.max(1, world.getShip(st.targetId).layout.boundingRadius * 0.6) : 3;
  const tPos = st.targetId ? world.physics.getWorldCenter(st.targetId) : null;
  const dist = tPos ? length(sub(tPos, me.pos)) : null;
  // Present the strongest side of the weapons as they are now (turrets lost change it).
  st.broadsideAngle = tPos ? bestHeading(ship, angleOf(sub(tPos, me.pos)), me.angle) : null;
  const scores = scoreBehaviours(
    ship,
    st,
    caps,
    dist,
    incomingMissiles(world, ship, me).length,
    isOutgunned(world, ship, st, me, caps),
  );
  st.scores = scores;
  let best: Behaviour = st.behaviour;
  let bestScore = -Infinity;
  for (const [b, v] of Object.entries(scores) as [Behaviour, number][]) {
    const score = v + (b === st.behaviour ? AI_TUNING.stickiness : 0);
    if (score > bestScore) {
      bestScore = score;
      best = b;
    }
  }
  st.behaviour = bestScore > 0 ? best : "idle";
}

const clampLen = (v: Vec2, max: number): Vec2 => {
  const l = length(v);
  return l > max ? scale(v, max / l) : v;
};

/** Steering request for the current behaviour, from this tick's poses. */
function behaviourSteering(
  world: World,
  ship: Ship,
  st: AiState,
  me: Pose,
  caps: CapabilityProfile,
): Steering {
  const p = st.profile;
  const R = preferredRange(caps, p, st.targetRadius);
  const t = st.targetId && world.hasShip(st.targetId) ? poseOf(world, st.targetId) : null;
  /** Velocity toward a goal moving at goalVel: proportional, capped by top speed and by stopping distance. */
  const seek = (goal: Vec2, goalVel: Vec2) => {
    const off = sub(goal, me.pos);
    const cap = Math.min(p.maxSpeed, arrivalSpeed(caps, length(off)));
    return add(goalVel, clampLen(scale(off, AI_TUNING.gain), cap));
  };
  /** Guards never chase beyond their radius around the guarded ship. */
  const leash = (goal: Vec2): Vec2 => {
    const o = st.order;
    if (o?.kind !== "guard" || !world.hasShip(o.target)) return goal;
    const c = world.physics.getWorldCenter(o.target);
    const off = sub(goal, c);
    return length(off) > o.radius ? add(c, scale(normalize(off), o.radius)) : goal;
  };
  /** Kiter: an enemy inside its comfort range: back away at speed, guns still on it. */
  const kiting = (tp: Pose) => !!p.kite && length(sub(tp.pos, me.pos)) < R * AI_TUNING.kiteInside;
  const kiteAway = (tp: Pose, face: number | null): Steering => {
    const off = sub(me.pos, tp.pos);
    const away = length(off) > 1e-6 ? normalize(off) : rotate(vec2(-1, 0), me.angle);
    return { desiredVel: add(tp.vel, scale(away, p.maxSpeed)), faceAngle: face, mayBurn: false };
  };
  const leadAngle = (tp: Pose) => {
    const speed = caps.weapons.fixedSpeed;
    const sol = speed > 0 ? intercept(me.pos, me.vel, tp.pos, tp.vel, speed) : null;
    return angleOf(sub(sol?.aimPoint ?? tp.pos, me.pos));
  };
  switch (st.behaviour) {
    case "approach":
    case "hold":
    case "face": {
      if (!t) break;
      const dir = length(sub(t.pos, me.pos)) > 1e-6 ? normalize(sub(t.pos, me.pos)) : vec2(1, 0);
      // Missile line: each ship takes its place along a wall across the bearing to the enemy.
      const wall = isMissileLine(st) ? scale(vec2(-dir.y, dir.x), wallOffset(world, ship, st)) : vec2(0, 0);
      const goal = leash(add(sub(t.pos, scale(dir, R)), wall));
      const face =
        caps.weapons.fixedShare >= 0.5 || st.behaviour === "face"
          ? leadAngle(t)
          : (st.broadsideAngle ?? angleOf(dir));
      const far = length(sub(goal, me.pos)) > R * 0.3;
      if (kiting(t)) return kiteAway(t, face);
      return { desiredVel: seek(goal, t.vel), faceAngle: face, mayBurn: st.behaviour === "approach" || far };
    }
    case "broadside": {
      if (!t) break;
      const radial = length(sub(me.pos, t.pos)) > 1e-6 ? normalize(sub(me.pos, t.pos)) : vec2(1, 0);
      const side = cross(radial, sub(me.vel, t.vel)) >= 0 ? 1 : -1;
      const tangent = scale(vec2(-radial.y, radial.x), side * p.orbitSpeed);
      const Rt = preferredRange(caps, p, st.targetRadius, "turret");
      if (kiting(t)) return kiteAway(t, st.broadsideAngle);
      const err = Rt - length(sub(me.pos, t.pos));
      // Radial correction capped by stopping distance, like approach (heavy ships overshoot otherwise).
      const radialSpeed = Math.min(Math.abs(err) * AI_TUNING.gain, arrivalSpeed(caps, Math.abs(err)));
      const radialFix = scale(radial, Math.sign(err) * radialSpeed);
      const desired = add(t.vel, clampLen(add(tangent, radialFix), p.maxSpeed));
      return { desiredVel: desired, faceAngle: st.broadsideAngle, mayBurn: Math.abs(err) > Rt * 0.3 };
    }
    case "evade": {
      const m = incomingMissiles(world, ship, me)[0];
      if (!m) break;
      const mv = length(m.vel) > 1e-6 ? normalize(m.vel) : vec2(1, 0);
      const side = cross(mv, sub(me.pos, m.pos)) >= 0 ? 1 : -1;
      const perp = scale(vec2(-mv.y, mv.x), side);
      return { desiredVel: add(me.vel, scale(perp, p.maxSpeed)), faceAngle: null, mayBurn: true };
    }
    case "retreat": {
      // A fighting withdrawal: a damaged ship falls back slower than a healthy pursuer can close, with its
      // guns toward the threat, so retreats end the fight one way or the other instead of in a chase.
      const from = t?.pos ?? me.pos;
      const away =
        length(sub(me.pos, from)) > 1e-6 ? normalize(sub(me.pos, from)) : rotate(vec2(-1, 0), me.angle);
      const face = t
        ? caps.weapons.fixedShare >= 0.5
          ? leadAngle(t)
          : (st.broadsideAngle ?? angleOf(sub(t.pos, me.pos)))
        : null;
      // Escaping (disarmed or outgunned): full speed, nose along the way to burn hardest.
      if (st.retreatMode === "escape") {
        const run = slideAlongEdge(world, me.pos, away, t ? sub(t.pos, me.pos) : null);
        return { desiredVel: scale(run, p.maxSpeed * AI_TUNING.escapeSpeed), faceAngle: null, mayBurn: true };
      }
      return {
        desiredVel: scale(
          away,
          p.stance === "retreating" && p.withdrawSpeed !== undefined
            ? p.withdrawSpeed
            : p.maxSpeed * AI_TUNING.retreatSpeed,
        ),
        faceAngle: face,
        mayBurn: true,
      };
    }
    case "ram": {
      if (!t) break;
      // Straight at the target at full speed (plus its own velocity, so a fleeing target is run down).
      const dir = length(sub(t.pos, me.pos)) > 1e-6 ? normalize(sub(t.pos, me.pos)) : vec2(1, 0);
      return { desiredVel: add(t.vel, scale(dir, p.maxSpeed)), faceAngle: angleOf(dir), mayBurn: true };
    }
    case "cool":
      return {
        desiredVel: me.vel,
        faceAngle: t ? angleOf(sub(t.pos, me.pos)) : me.angle,
        mayBurn: false,
        coast: true,
      };
    case "follow": {
      const o = st.order;
      const leader = o?.kind === "follow" ? o.leader : o?.kind === "guard" ? o.target : null;
      if (!leader || !world.hasShip(leader)) break;
      const l = poseOf(world, leader);
      const row = Math.floor(st.slot / 2) + 1;
      const side = st.slot % 2 === 0 ? 1 : -1;
      if (length(l.vel) > AI_TUNING.formationTurnSpeed) st.formationAngle = angleOf(l.vel);
      else if (st.formationAngle === null) st.formationAngle = l.angle;
      // Slots far enough apart for the ships' size (a cruiser behind a gunboat needs more than 60 m).
      const spacing = Math.max(
        AI_TUNING.formationSpacing,
        2.5 * (ship.layout.boundingRadius + world.getShip(leader).layout.boundingRadius),
      );
      const slot = add(l.pos, rotate(vec2(-row * spacing, side * row * spacing * 0.8), st.formationAngle));
      // Face along the formation's way, not the leader's nose (it may have flipped to burn).
      return { desiredVel: seek(slot, l.vel), faceAngle: st.formationAngle, mayBurn: true };
    }
    case "station": {
      const point = orderPoint(st);
      if (!point) break;
      // Patrols keep moving: they aim through the waypoint at cruising speed instead of stopping on it.
      const o = st.order;
      const patrol = o?.kind === "patrol";
      const off = sub(point, me.pos);
      const desiredVel =
        patrol && length(off) > 1e-6 ? scale(normalize(off), p.maxSpeed * 0.6) : seek(point, vec2(0, 0));
      // Turning the attack front: towards the leg's aim point on the way, to the ordered facing near the
      // end. The steering still turns away to burn when the engines need it (mayBurn).
      const front = liveFirepower(ship).front;
      const near = length(off) < Math.max(AI_TUNING.arriveDistance * 3, ship.layout.boundingRadius * 10);
      let face: number = length(off) > 50 ? angleOf(off) : me.angle;
      if (o?.kind === "move" && o.aimAt && !near) face = angleOf(sub(o.aimAt, me.pos)) - front;
      else if (
        (o?.kind === "move" || o?.kind === "hold") &&
        o.facing !== undefined &&
        (near || o.kind === "hold")
      )
        face = o.facing - front;
      else if (o?.kind === "hold") face = me.angle;
      return { desiredVel, faceAngle: face, mayBurn: true };
    }
    default:
      break;
  }
  return { desiredVel: vec2(0, 0), faceAngle: me.angle, mayBurn: false };
}

/** Fire control (spec §11.2): AI-mode guns with a hit-probability floor, missile volleys, drones, decoys. */
function fireControl(world: World, ship: Ship, st: AiState, me: Pose, caps: CapabilityProfile): void {
  for (const w of ship.weapons) ship.groupModes.set(w.group, "ai");
  ship.minHitProbability = st.profile.minHitProbability;
  ship.radiatorsExtended = true;
  let launch = false;
  const t = st.targetId && world.hasShip(st.targetId) ? world.getShip(st.targetId) : null;
  const dist = t ? length(sub(world.physics.getWorldCenter(t.id), me.pos)) : Infinity;
  if (
    t &&
    caps.missiles.launchers > 0 &&
    // A volley waits for every launcher that still has a round; empty launchers do not hold it up.
    caps.missiles.ready > 0 &&
    caps.missiles.ready >= caps.missiles.loaded &&
    dist <= caps.missiles.range * 0.85 &&
    // Missile-line ships launch together on the side's salvo clock; others on their own volley timer.
    (isMissileLine(st)
      ? salvoDue(world, st)
      : world.tick - st.lastVolleyTick >= st.profile.volleyInterval * 60)
  ) {
    launch = true;
    st.lastVolleyTick = world.tick;
  }
  if (
    t &&
    !st.dronesLaunched &&
    dist <= st.profile.droneLaunchRange &&
    caps.drones.stored > caps.drones.decoys
  ) {
    ship.requestDroneLaunch((type) => !type.includes("decoy"));
    st.dronesLaunched = true;
  }
  if (st.behaviour === "evade" && caps.drones.decoys > 0 && world.tick - st.decoysLaunchedTick > 120) {
    ship.requestDroneLaunch((type) => type.includes("decoy"));
    st.decoysLaunchedTick = world.tick;
  }
  ship.weaponCommand = {
    trigger: false,
    aimPoint: null,
    selected: new Set(),
    targetId: st.targetId,
    launch,
    holdBeams: st.cooling,
    // Past the throttle point the ship would cook its own heat producers (command module included).
    holdGuns: st.cooling && caps.heat > AI_TUNING.holdGunsAbove,
    missileVolleys: true,
  };
}

/**
 * Speed the AI may ask for (world frame): the profile's top speed while fighting or repositioning (a heavy
 * sniper does not chase a fighter at 250 m/s), never more than the fuel left allows. Evading, following a
 * leader and doctrine manoeuvres (a pass at pass speed) are only held to the fuel limit.
 */
export function speedLimit(st: AiState, caps: CapabilityProfile, doctrine: boolean): number {
  const fuel = Math.max(AI_TUNING.fuelMinSpeed, caps.deltaV * AI_TUNING.fuelSpeedShare);
  const free = doctrine || st.behaviour === "evade" || st.behaviour === "follow" || st.behaviour === "ram";
  const escaping = st.behaviour === "retreat" && st.retreatMode === "escape";
  return Math.min(fuel, free ? Infinity : st.profile.maxSpeed * (escaping ? AI_TUNING.escapeSpeed : 1));
}

const limitSpeed = (v: Vec2, max: number): Vec2 => clampLen(v, max);

/** Step 0e: every AI ship thinks (every evalInterval) and acts (every tick). */
export function runAi(world: World, dt: number): void {
  const every = Math.max(1, Math.round(AI_TUNING.evalInterval / dt));
  for (const ship of world.allShips()) {
    const st = world.ai.get(ship.id);
    if (!st || ship.inert || (world.enforceDefeat && ship.defeated)) continue;
    const me = poseOf(world, ship.id);
    if (world.tick >= st.nextEval || !st.caps) {
      evaluate(world, ship, st, me);
      st.nextEval = world.tick + every;
    }
    const caps = st.caps!;
    // Pass doctrine flies the formation passes itself, unless the ship is retreating or cooling down.
    const own =
      isPass(st) && st.behaviour !== "retreat" && st.behaviour !== "cool" && !st.order
        ? passSteering(world, ship, st, me, caps)
        : null;
    const steering = own ?? behaviourSteering(world, ship, st, me, caps);
    const avoided = {
      ...steering,
      desiredVel: avoidObstacles(
        world,
        ship,
        limitSpeed(steering.desiredVel, speedLimit(st, caps, !!own)),
        !own,
      ),
    };
    st.debug = { desiredVel: avoided.desiredVel, faceAngle: avoided.faceAngle };
    ship.intent = steerToIntent(world, ship, caps, avoided);
    const dodge = burstDodge(world, ship, me);
    if (dodge) ship.intent = { ...ship.intent, burst: dodge };
    fireControl(world, ship, st, me, caps);
  }
}
