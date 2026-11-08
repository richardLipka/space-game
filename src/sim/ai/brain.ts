import type { AiProfile } from "../../data/schemas/ai";
import {
  type Vec2,
  add,
  angleOf,
  cross,
  degToRad,
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
import { capabilityProfile, type CapabilityProfile } from "./capabilities";
import { avoidObstacles, steerToIntent, type Steering } from "./steering";

/**
 * Utility AI (spec §11, plan M6). Each AI ship re-evaluates its target and behaviour every
 * AI_TUNING.evalInterval, then steers and fires every tick through the same ControlIntent and weapon
 * commands as the player. It never touches physics directly (plan test 6.1).
 */

export type Behaviour =
  "approach" | "hold" | "broadside" | "face" | "evade" | "retreat" | "cool" | "follow" | "station" | "idle";

/** Allied orders (spec §11.3). They replace the top-level goal; evade, cool down and retreat still apply. */
export type Order =
  | { readonly kind: "follow"; readonly leader: string }
  | { readonly kind: "attack"; readonly target: string }
  | { readonly kind: "hold"; readonly point: Vec2 };

export const AI_TUNING = {
  /** Seconds between behaviour and target evaluations. */
  evalInterval: 0.5,
  /** Utility bonus for the current behaviour (hysteresis). */
  stickiness: 0.15,
  /** Target score bonus for the current target (hysteresis). */
  targetStickiness: 1.2,
  /** Missiles closer to impact than this (s) trigger evasion. */
  evadeHorizon: 6,
  /** Cool down above this heat level, until it drops below `coolExit`. */
  coolEnter: 0.7,
  coolExit: 0.5,
  /** Position gain for steering toward a goal point (1/s). */
  gain: 0.5,
  /** Followers and holders engage armed enemies this close to their leader or point (m). */
  engageRadius: 2000,
  /** Formation spacing behind the leader (m). */
  formationSpacing: 60,
} as const;

export interface AiState {
  profile: AiProfile;
  order: Order | null;
  behaviour: Behaviour;
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
    behaviour: "idle",
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
    const pReach =
      g.spread > 0 && profile.minHitProbability > 0
        ? targetRadius / (2 * Math.tan(g.spread) * profile.minHitProbability)
        : g.reach;
    sum += g.dps * Math.min(g.reach, pReach);
    dps += g.dps;
  }
  const base = dps > 0 ? sum / dps : caps.missiles.range > 0 ? caps.missiles.range * 0.7 : 1000;
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

/** Target choice (spec §11.2): threat ÷ distance, preferring weakened targets; orders narrow the field. */
function chooseTarget(world: World, ship: Ship, st: AiState, me: Pose): string | null {
  const order = st.order;
  if (order?.kind === "attack" && world.hasShip(order.target)) {
    const t = world.getShip(order.target);
    if (!t.defeated && !t.inert && t.team !== ship.team) return t.id;
  }
  const anchor =
    order?.kind === "follow" && world.hasShip(order.leader)
      ? world.physics.getWorldCenter(order.leader)
      : order?.kind === "hold"
        ? order.point
        : null;
  let best: string | null = null;
  let bestScore = 0;
  for (const s of world.allShips()) {
    if (s.team === ship.team || s.defeated || s.inert) continue;
    const pos = world.physics.getWorldCenter(s.id);
    const caps = capabilityProfile(s);
    const armed = caps.threat > 0;
    // Followers and holders only engage armed enemies near their leader or point.
    if (anchor && (!armed || length(sub(pos, anchor)) > AI_TUNING.engageRadius)) continue;
    const dist = Math.max(100, length(sub(pos, me.pos)));
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

/** Heading (rad) at which the most usable turrets can bear on `bearing`, nearest the current heading. */
function bestBroadside(ship: Ship, bearing: number, current: number): number | null {
  const turrets = ship.weapons.filter(
    (w) => w.def.mount === "turret" && w.def.kind !== "pd" && w.def.kind !== "missile" && w.part.hp > 0,
  );
  if (turrets.length === 0) return null;
  let best: number | null = null;
  let bestCount = -1;
  let bestTurn = Infinity;
  for (let deg = -180; deg < 180; deg += 15) {
    const h = degToRad(deg);
    let count = 0;
    for (const w of turrets) {
      const rel = wrap(bearing - (h + w.part.angle));
      const [a0, a1] = (w.def.arc ?? [-180, 180]).map(degToRad) as [number, number];
      if (rel >= a0 && rel <= a1 && !w.blocked.some(([a, b]) => rel >= a && rel <= b)) count++;
    }
    const turn = Math.abs(wrap(h - current));
    if (count > bestCount || (count === bestCount && turn < bestTurn)) {
      best = h;
      bestCount = count;
      bestTurn = turn;
    }
  }
  return best;
}

/** Utility scores (spec §11.2) for this evaluation. */
function scoreBehaviours(
  ship: Ship,
  st: AiState,
  caps: CapabilityProfile,
  dist: number | null,
  incoming: number,
): Partial<Record<Behaviour, number>> {
  const w = st.profile.weights;
  const R = preferredRange(caps, st.profile, st.targetRadius);
  const s: Partial<Record<Behaviour, number>> = {};
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
    if (!armed && builtArmed) s.retreat = w.retreat * 2;
  } else if (st.order?.kind === "follow") s.follow = 0.5;
  else if (st.order?.kind === "hold") s.station = 0.5;
  else s.idle = 0.1;
  if (incoming > 0) s.evade = w.evade * (0.9 + 0.2 * Math.min(incoming, 4));
  // Badly damaged: retreat outranks closing in (approach tops out at 1.5).
  if (caps.hp < st.profile.retreatHp) s.retreat = Math.max(s.retreat ?? 0, w.retreat * 2.2);
  if (st.cooling) s.cool = w.cool * 1.4;
  return s;
}

/** One evaluation: target, cool-down latch, broadside heading and behaviour (with hysteresis). */
function evaluate(world: World, ship: Ship, st: AiState, me: Pose): void {
  const caps = capabilityProfile(ship);
  st.caps = caps;
  if (caps.heat > AI_TUNING.coolEnter) st.cooling = true;
  else if (caps.heat < AI_TUNING.coolExit) st.cooling = false;
  st.targetId = chooseTarget(world, ship, st, me);
  st.targetRadius = st.targetId ? Math.max(1, world.getShip(st.targetId).layout.boundingRadius * 0.6) : 3;
  const tPos = st.targetId ? world.physics.getWorldCenter(st.targetId) : null;
  const dist = tPos ? length(sub(tPos, me.pos)) : null;
  st.broadsideAngle = tPos ? bestBroadside(ship, angleOf(sub(tPos, me.pos)), me.angle) : null;
  const scores = scoreBehaviours(ship, st, caps, dist, incomingMissiles(world, ship, me).length);
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
      const goal = sub(t.pos, scale(dir, R));
      const face =
        caps.weapons.fixedShare >= 0.5 || st.behaviour === "face"
          ? leadAngle(t)
          : (st.broadsideAngle ?? angleOf(dir));
      const far = length(sub(goal, me.pos)) > R * 0.3;
      return { desiredVel: seek(goal, t.vel), faceAngle: face, mayBurn: st.behaviour === "approach" || far };
    }
    case "broadside": {
      if (!t) break;
      const radial = length(sub(me.pos, t.pos)) > 1e-6 ? normalize(sub(me.pos, t.pos)) : vec2(1, 0);
      const side = cross(radial, sub(me.vel, t.vel)) >= 0 ? 1 : -1;
      const tangent = scale(vec2(-radial.y, radial.x), side * p.orbitSpeed);
      const Rt = preferredRange(caps, p, st.targetRadius, "turret");
      const err = Rt - length(sub(me.pos, t.pos));
      const radialFix = scale(radial, err * AI_TUNING.gain);
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
      const from = t?.pos ?? me.pos;
      const away =
        length(sub(me.pos, from)) > 1e-6 ? normalize(sub(me.pos, from)) : rotate(vec2(-1, 0), me.angle);
      return { desiredVel: scale(away, p.maxSpeed), faceAngle: null, mayBurn: true };
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
      if (o?.kind !== "follow" || !world.hasShip(o.leader)) break;
      const l = poseOf(world, o.leader);
      const row = Math.floor(st.slot / 2) + 1;
      const side = st.slot % 2 === 0 ? 1 : -1;
      const slot = add(
        l.pos,
        rotate(
          vec2(-row * AI_TUNING.formationSpacing, side * row * AI_TUNING.formationSpacing * 0.8),
          l.angle,
        ),
      );
      return { desiredVel: seek(slot, l.vel), faceAngle: l.angle, mayBurn: true };
    }
    case "station": {
      const o = st.order;
      if (o?.kind !== "hold") break;
      return {
        desiredVel: seek(o.point, vec2(0, 0)),
        faceAngle: me.angle,
        mayBurn: true,
      };
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
    caps.missiles.ready >= caps.missiles.launchers &&
    dist <= caps.missiles.range * 0.85 &&
    world.tick - st.lastVolleyTick >= st.profile.volleyInterval * 60
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
    missileVolleys: true,
  };
}

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
    const steering = behaviourSteering(world, ship, st, me, caps);
    const avoided = { ...steering, desiredVel: avoidObstacles(world, ship, steering.desiredVel) };
    st.debug = { desiredVel: avoided.desiredVel, faceAngle: avoided.faceAngle };
    ship.intent = steerToIntent(world, ship, caps, avoided);
    fireControl(world, ship, st, me, caps);
  }
}
