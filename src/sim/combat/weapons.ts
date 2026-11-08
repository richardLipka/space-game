import type { WeaponDef } from "../../data/schemas/part";
import { type Vec2, add, angleOf, degToRad, fromAngle, rotate, sub, length } from "../core/vec2";
import type { Rng } from "../core/rng";
import { hpFactor, isIntact, type PartInstance } from "../ship/ship";
import { COMBAT } from "./constants";
import { intercept } from "./lead";

export type GroupMode = "hold" | "manual" | "ai";

/** Runtime state of one weapon (spec §9). Angles in radians. */
export interface WeaponState {
  readonly uid: string;
  readonly part: PartInstance;
  readonly def: WeaponDef;
  /** Weapon group 1–9 (ungrouped weapons belong to group 1). */
  group: number;
  /** Turret angle relative to the mount axis (0 for fixed mounts). */
  turret: number;
  /** Seconds until the next shot is allowed. */
  cooldown: number;
  /** Angle ranges (relative to the mount axis) blocked by the ship's own parts. */
  blocked: readonly (readonly [number, number])[];
  /** True while the turret points into a blocked range (it keeps tracking but will not fire). */
  isBlocked: boolean;
  /** Beam weapons: firing this tick. */
  beamActive: boolean;
  /** Angle between where the weapon points and where it wants to point (rad). */
  aimError: number;
}

/** What the pilot asks of the weapons this tick (spec §9.2). */
export interface WeaponCommand {
  /** LMB held. */
  trigger: boolean;
  /** World point the selected manual groups aim at (mouse), or null. */
  aimPoint: Vec2 | null;
  /** Selected weapon groups. */
  selected: ReadonlySet<number>;
  /** Selected target ship id (RMB), used by AI-mode groups. */
  targetId: string | null;
}

export const IDLE_WEAPONS: WeaponCommand = {
  trigger: false,
  aimPoint: null,
  selected: new Set([1]),
  targetId: null,
};

export interface ShooterPose {
  /** Ship body origin (world). */
  readonly position: Vec2;
  readonly angle: number;
  /** World velocity of a point on the shooter. */
  velocityAt(p: Vec2): Vec2;
}

export interface TargetInfo {
  readonly id: string;
  readonly position: Vec2;
  readonly velocity: Vec2;
}

export interface FireOrder {
  readonly weapon: WeaponState;
  readonly kind: "projectile" | "beam";
  /** World muzzle position and unit fire direction (spread applied). */
  readonly muzzle: Vec2;
  readonly dir: Vec2;
  /** Shooter velocity at the muzzle (inherited by projectiles). */
  readonly muzzleVelocity: Vec2;
}

/** Services the weapon update needs from the ship it belongs to. */
export interface WeaponHost {
  isCommanded(uid: string): boolean;
  /** Served power fraction for a powered weapon (1 when it needs none). */
  powerFactor(uid: string): number;
  drawRounds(uid: string, n: number): number;
  addHeat(joules: number): void;
  setBeamActive(uid: string, on: boolean): void;
}

const wrap = (a: number): number => {
  let x = (a + Math.PI) % (2 * Math.PI);
  if (x < 0) x += 2 * Math.PI;
  return x - Math.PI;
};

export function createWeaponState(
  part: PartInstance,
  group: number | undefined,
  blockedDeg: readonly [number, number][],
): WeaponState {
  return {
    uid: part.uid,
    part,
    def: part.def.def.weapon!,
    group: group ?? 1,
    turret: 0,
    cooldown: 0,
    blocked: blockedDeg.map(([a, b]) => [degToRad(a), degToRad(b)] as const),
    isBlocked: false,
    beamActive: false,
    aimError: Infinity,
  };
}

/** World muzzle position and mount-axis angle for a weapon on a ship at `pose`. */
export function mountOf(w: WeaponState, pose: ShooterPose): { muzzle: Vec2; mountAngle: number } {
  const p = w.part;
  const local = add(p.position, rotate({ x: w.def.muzzle[0], y: w.def.muzzle[1] }, p.angle));
  return { muzzle: add(pose.position, rotate(local, pose.angle)), mountAngle: pose.angle + p.angle };
}

/** Effective fire interval and spread for a weapon at its current HP (spec §8: function scales with HP). */
export function weaponPerformance(w: WeaponState): { interval: number; spread: number } {
  const hf = Math.max(COMBAT.hpFloor, hpFactor(w.part));
  return { interval: w.def.fireInterval / hf, spread: degToRad(w.def.spread) / hf };
}

/**
 * One tick of weapon logic (spec §9.1–9.3): aim, traverse, decide, fire.
 * Returns fire orders; projectiles and beams are resolved by the world.
 */
export function updateWeapons(
  weapons: readonly WeaponState[],
  host: WeaponHost,
  cmd: WeaponCommand,
  modes: ReadonlyMap<number, GroupMode>,
  pose: ShooterPose,
  target: TargetInfo | null,
  rng: Rng,
  dt: number,
  enabled: boolean,
): FireOrder[] {
  const orders: FireOrder[] = [];
  for (const w of weapons) {
    w.cooldown = Math.max(0, w.cooldown - dt);
    const def = w.def;
    const ok =
      enabled && isIntact(w.part) && host.isCommanded(w.uid) && def.kind !== "pd" && def.kind !== "missile";
    if (!ok) {
      if (w.beamActive) host.setBeamActive(w.uid, false);
      w.beamActive = false;
      continue;
    }
    const mode = modes.get(w.group) ?? "manual";
    const { muzzle, mountAngle } = mountOf(w, pose);

    // What to aim at and whether the trigger is pulled.
    let aim: Vec2 | null = null;
    let wantsFire = false;
    if (mode === "manual" && cmd.selected.has(w.group)) {
      aim = cmd.aimPoint;
      wantsFire = cmd.trigger;
    } else if (mode === "ai" && target) {
      const dist = length(sub(target.position, muzzle));
      if (def.kind === "projectile" && def.projectile) {
        const sol = intercept(
          muzzle,
          pose.velocityAt(muzzle),
          target.position,
          target.velocity,
          def.projectile.speed,
        );
        aim = sol?.aimPoint ?? target.position;
      } else aim = target.position;
      wantsFire = dist <= def.range;
    }

    let fireAngle = mountAngle + w.turret;
    let aimed = false;
    if (aim) {
      const rel = wrap(angleOf(sub(aim, muzzle)) - mountAngle);
      if (def.mount === "turret") {
        const [a0, a1] = (def.arc ?? [-180, 180]).map(degToRad) as [number, number];
        const goal = Math.min(a1, Math.max(a0, rel));
        const step = degToRad(def.traverseRate ?? 90) * dt;
        const d = goal - w.turret;
        w.turret += Math.abs(d) <= step ? d : Math.sign(d) * step;
        fireAngle = mountAngle + w.turret;
        w.aimError = Math.abs(rel - w.turret);
        aimed =
          rel >= a0 && rel <= a1 && w.aimError <= Math.max(COMBAT.turretAimTolerance, degToRad(def.spread));
      } else {
        const clamped = Math.min(COMBAT.fixedAimCone, Math.max(-COMBAT.fixedAimCone, rel));
        fireAngle = mountAngle + clamped;
        w.aimError = Math.abs(rel - clamped);
        aimed = true; // fixed weapons fire along their (cone-limited) axis whenever triggered
      }
    }
    w.isBlocked = def.mount === "turret" && w.blocked.some(([a, b]) => w.turret >= a && w.turret <= b);
    const canAct = wantsFire && aimed && !w.isBlocked;

    if (def.kind === "beam") {
      // Demand power exactly while the beam wants to fire; it fires once power is served (next tick).
      host.setBeamActive(w.uid, canAct);
      const on = canAct && host.powerFactor(w.uid) > 0;
      w.beamActive = on;
      if (on)
        orders.push({
          weapon: w,
          kind: "beam",
          muzzle,
          dir: fromAngle(fireAngle),
          muzzleVelocity: pose.velocityAt(muzzle),
        });
      continue;
    }

    if (!canAct || w.cooldown > 1e-9) continue;
    if ((def.powerPerShot ?? 0) > 0 && host.powerFactor(w.uid) < 0.999) continue;
    if (def.ammoType && host.drawRounds(w.uid, 1) < 1) continue;
    const perf = weaponPerformance(w);
    w.cooldown += perf.interval;
    if (def.heatPerShot) host.addHeat(def.heatPerShot);
    const angle = fireAngle + (perf.spread > 0 ? rng.normal(0, perf.spread) : 0);
    orders.push({
      weapon: w,
      kind: "projectile",
      muzzle,
      dir: fromAngle(angle),
      muzzleVelocity: pose.velocityAt(muzzle),
    });
  }
  return orders;
}
