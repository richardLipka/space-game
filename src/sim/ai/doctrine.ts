import { type Vec2, add, angleOf, dot, length, normalize, scale, sub, vec2 } from "../core/vec2";
import type { Ship } from "../ship/ship-entity";
import type { World } from "../world";
import type { CapabilityProfile } from "./capabilities";
import type { AiState } from "./brain";
import type { Steering } from "./steering";

/**
 * Fleet doctrines (docs/ai-types.md): ways of fighting that go beyond one ship's behaviour scores.
 *
 * - **pass** (in the style of The Lost Fleet): the ships form up abreast on a leader, which flies at the
 *   enemy fleet at high speed aiming just past it, so the fleets cross with a short, violent contact in the
 *   middle; past the enemy the formation runs on to a turn-around distance, comes about and passes again on
 *   the other side. During the contact every ship turns its strongest side to the nearest enemy.
 * - **missile-line** (in the style of the Honorverse): the ships stand off near their missile range in a
 *   line abreast across the enemy bearing (a wall of battle) and launch together on a shared salvo clock,
 *   so their missiles arrive as one wave against the enemy's point defense.
 */
export type Doctrine = "standard" | "pass" | "missile-line";

export const DOCTRINE = {
  pass: { speed: 300, offset: 400, turnDistance: 4000, spacing: 120 },
  missileLine: { standoff: 0.85, salvoInterval: 12, spacing: 250 },
  /** Followers close on their formation slot at this rate (1/s). */
  slotGain: 0.4,
} as const;

const doctrineOf = (st: AiState): Doctrine => st.profile.doctrine ?? "standard";

/** The ships of `ship`'s side flying the same doctrine, sorted by id (the first leads). */
export function squadron(world: World, ship: Ship, doctrine: Doctrine): Ship[] {
  return world
    .allShips()
    .filter(
      (s) =>
        s.team === ship.team &&
        !s.drone &&
        !s.defeated &&
        !s.inert &&
        world.ai.get(s.id) !== undefined &&
        doctrineOf(world.ai.get(s.id)!) === doctrine,
    );
}

/** Centre of the enemy fleet (undefeated ships, drones left out), or null without enemies. */
export function enemyCentre(world: World, ship: Ship): Vec2 | null {
  let x = 0;
  let y = 0;
  let n = 0;
  for (const s of world.allShips()) {
    if (s.team === ship.team || s.drone || s.defeated || s.inert) continue;
    const p = world.physics.getWorldCenter(s.id);
    x += p.x;
    y += p.y;
    n++;
  }
  return n ? vec2(x / n, y / n) : null;
}

/** Offset of slot `i` of `n` across a line abreast (centred), `spacing` apart. */
const abreast = (i: number, n: number, spacing: number) => (i - (n - 1) / 2) * spacing;
const perp = (v: Vec2) => vec2(-v.y, v.x);

/**
 * Pass doctrine steering. The leader runs the passes; the others hold their slot abreast of it (across its
 * direction of flight) and match its velocity. Null when there is no enemy left (normal behaviour then).
 */
export function passSteering(
  world: World,
  ship: Ship,
  st: AiState,
  me: { pos: Vec2; vel: Vec2; angle: number },
  caps: CapabilityProfile,
): Steering | null {
  const p = st.profile;
  const speed = p.passSpeed ?? DOCTRINE.pass.speed;
  const offset = p.passOffset ?? DOCTRINE.pass.offset;
  const turn = p.passTurnDistance ?? DOCTRINE.pass.turnDistance;
  const spacing = p.formationSpacing ?? DOCTRINE.pass.spacing;
  const centre = enemyCentre(world, ship);
  if (!centre) return null;
  const sq = squadron(world, ship, "pass");
  const leader = sq[0] ?? ship;
  const slot = Math.max(0, sq.indexOf(ship));
  // Facing: the strongest side to the target in contact, otherwise along the way (main engine).
  const face = (vel: Vec2): number | null => {
    const t = st.targetId && world.hasShip(st.targetId) ? world.physics.getWorldCenter(st.targetId) : null;
    const reach = Math.max(caps.weapons.maxRange, caps.missiles.range * 0.5, 800) * 1.3;
    if (t && length(sub(t, me.pos)) < reach && st.broadsideAngle !== null) return st.broadsideAngle;
    return length(vel) > 1 ? angleOf(vel) : null;
  };
  if (leader === ship) {
    const rel = sub(centre, me.pos);
    const dist = length(rel);
    const along = dist > 1e-6 ? scale(rel, 1 / dist) : vec2(1, 0);
    if (st.passPhase === "out") {
      // Past the enemy: run on until far enough to come about (or, when chased, until the time that would
      // take has passed), then pass again on the other side.
      if (dist > turn || (world.tick - st.passOutTick) / 60 > turn / speed) {
        st.passPhase = "in";
        st.passSide = st.passSide === 1 ? -1 : 1;
      }
      const v = length(me.vel) > 1 ? scale(normalize(me.vel), speed) : scale(along, -speed);
      return { desiredVel: v, faceAngle: face(v), mayBurn: true };
    }
    // Inbound: aim just past the enemy centre, on this pass's side. While the formation is strung out the
    // leader slows (to 60 % at 1 km off station) so the others can take their slots before the contact.
    const aim = add(centre, scale(perp(along), offset * st.passSide));
    const heading = normalize(sub(aim, me.pos));
    let worst = 0;
    sq.forEach((f, i) => {
      if (f === ship) return;
      const slotPos = add(me.pos, scale(perp(heading), abreast(i, sq.length, spacing)));
      worst = Math.max(worst, length(sub(world.physics.getWorldCenter(f.id), slotPos)));
    });
    const v = scale(heading, speed * (1 - 0.4 * Math.min(1, worst / 1000)));
    // Through the enemy line: moving away from its centre, close abeam.
    if (dot(me.vel, rel) < 0 && dist < offset * 3) {
      st.passPhase = "out";
      st.passOutTick = world.tick;
    }
    return { desiredVel: v, faceAngle: face(v), mayBurn: true };
  }
  // Followers: a line abreast across the leader's flight, matching its velocity.
  const l = world.physics.getBodyState(leader.id);
  const lp = world.physics.getWorldCenter(leader.id);
  const dir = length(l.linearVelocity) > 5 ? normalize(l.linearVelocity) : normalize(sub(centre, lp));
  const slotPos = add(lp, scale(perp(dir), abreast(slot, sq.length, spacing)));
  const v = add(l.linearVelocity, scale(sub(slotPos, me.pos), DOCTRINE.slotGain));
  return { desiredVel: v, faceAngle: face(v), mayBurn: true };
}

/**
 * Missile-line doctrine: lateral offset (m) of this ship's place in the wall of battle, across the bearing
 * to the enemy, so the ships hold a line abreast instead of bunching on the same standoff point.
 */
export function wallOffset(world: World, ship: Ship, st: AiState): number {
  const sq = squadron(world, ship, "missile-line");
  const i = sq.indexOf(ship);
  return i < 0 ? 0 : abreast(i, sq.length, st.profile.formationSpacing ?? DOCTRINE.missileLine.spacing);
}

/**
 * Missile-line salvo clock: the whole side launches in the same tick window every `salvoInterval` seconds,
 * so its missiles arrive together. True during the first second of a window this ship has not fired in.
 */
export function salvoDue(world: World, st: AiState): boolean {
  const every = Math.max(
    1,
    Math.round((st.profile.salvoInterval ?? DOCTRINE.missileLine.salvoInterval) * 60),
  );
  // Only in the first second of a window: a ship whose launchers were not ready waits for the next one
  // instead of firing late and alone.
  if (world.tick % every >= Math.min(60, every)) return false;
  const window = Math.floor(world.tick / every);
  return window > Math.floor(st.lastVolleyTick / every);
}

export const isPass = (st: AiState) => doctrineOf(st) === "pass";
export const isMissileLine = (st: AiState) => doctrineOf(st) === "missile-line";
