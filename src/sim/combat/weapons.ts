import type { WeaponDef } from "../../data/schemas/part";
import { type Vec2, add, angleOf, degToRad, fromAngle, rotate, sub } from "../core/vec2";
import type { Rng } from "../core/rng";
import { hpFactor, isIntact, type PartInstance } from "../ship/ship";
import { COMBAT } from "./constants";
import type { Engagement, Mount } from "./targeting";

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
  /** Selected target ship id (RMB), used by AI-mode groups and missiles. */
  targetId: string | null;
  /**
   * One-shot missile launch at the selected target: "one" (M) fires the first ready launcher, "salvo"
   * (Shift+M, and true for older callers) fires every ready launcher. Each launcher then reloads.
   */
  launch?: boolean | "one" | "salvo";
  /** Beams hold fire (AI cool-down, spec §11.2). */
  holdBeams?: boolean;
  /** AI-mode launchers wait for `launch` instead of firing on their own, so missiles go out in volleys. */
  missileVolleys?: boolean;
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

/** Target choice for automatic weapons, supplied by the world from the shared targeting module. */
export interface WeaponTargeting {
  /** AI-mode groups and AI-mode missile launchers: the enemy ship to engage. */
  ship(w: WeaponState, mount: Mount): Engagement | null;
  /** PD turrets: the most urgent missile or drone (or a ship, when the PD may engage ships). */
  pd(w: WeaponState, mount: Mount): Engagement | null;
}

export const NO_TARGETING: WeaponTargeting = { ship: () => null, pd: () => null };

export interface FireOrder {
  readonly weapon: WeaponState;
  readonly kind: "projectile" | "beam" | "missile";
  /** World muzzle position and unit fire direction (spread applied). */
  readonly muzzle: Vec2;
  readonly dir: Vec2;
  /** Shooter velocity at the muzzle (inherited by projectiles). */
  readonly muzzleVelocity: Vec2;
  /** Missiles: the ship to home on. */
  readonly targetId?: string | null;
  /** Burst shells (flak): seconds until the predicted intercept, when the shell bursts by itself. */
  readonly fuseTime?: number;
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
 * One tick of weapon logic (spec §9.1–9.6): aim, traverse, decide, fire.
 * Manual groups follow the pilot; AI-mode groups and PD turrets pick targets through `targeting`;
 * missile launchers fire on M, on the trigger (manual) or by themselves (AI mode).
 * PD keeps working in sections cut off from the command module (spec §7.1).
 * Returns fire orders; projectiles, beams and missiles are resolved by the world.
 */
export function updateWeapons(
  weapons: readonly WeaponState[],
  host: WeaponHost,
  cmd: WeaponCommand,
  modes: ReadonlyMap<number, GroupMode>,
  pose: ShooterPose,
  targeting: WeaponTargeting,
  rng: Rng,
  dt: number,
  enabled: boolean,
): FireOrder[] {
  const orders: FireOrder[] = [];
  let launchedOne = false;
  for (const w of weapons) {
    w.cooldown = Math.max(0, w.cooldown - dt);
    const def = w.def;
    const isPd = def.kind === "pd";
    const ok = enabled && isIntact(w.part) && (isPd || host.isCommanded(w.uid));
    if (!ok) {
      if (w.beamActive) host.setBeamActive(w.uid, false);
      w.beamActive = false;
      continue;
    }
    const mode = modes.get(w.group) ?? "manual";
    const { muzzle, mountAngle } = mountOf(w, pose);
    const mount: Mount = { muzzle, mountAngle, muzzleVelocity: pose.velocityAt(muzzle) };

    if (def.kind === "missile") {
      // Launchers do not aim: missiles steer themselves (spec §9.5).
      let targetId: string | null = null;
      const launching = cmd.launch === "one" ? !launchedOne : !!cmd.launch;
      if (launching || (mode === "manual" && cmd.selected.has(w.group) && cmd.trigger))
        targetId = cmd.targetId;
      else if (mode === "ai" && !cmd.missileVolleys) targetId = targeting.ship(w, mount)?.id ?? null;
      w.aimError = 0;
      if (!targetId || w.cooldown > 1e-9) continue;
      if (def.ammoType && host.drawRounds(w.uid, 1) < 1) continue;
      const perf = weaponPerformance(w);
      w.cooldown += perf.interval;
      if (cmd.launch === "one") launchedOne = true;
      if (def.heatPerShot) host.addHeat(def.heatPerShot);
      const angle = mountAngle + (perf.spread > 0 ? rng.normal(0, perf.spread) : 0);
      orders.push({
        weapon: w,
        kind: "missile",
        muzzle,
        dir: fromAngle(angle),
        muzzleVelocity: mount.muzzleVelocity,
        targetId,
      });
      continue;
    }

    // What to aim at and whether the trigger is pulled.
    let aim: Vec2 | null = null;
    let wantsFire = false;
    let fuseTime: number | undefined;
    if (isPd) {
      const e = targeting.pd(w, mount);
      if (e) {
        aim = e.aimPoint;
        wantsFire = true;
        fuseTime = e.t;
      }
    } else if (mode === "manual" && cmd.selected.has(w.group)) {
      aim = cmd.aimPoint;
      wantsFire = cmd.trigger;
    } else if (mode === "ai") {
      const e = targeting.ship(w, mount);
      if (e) {
        aim = e.aimPoint;
        wantsFire = true;
      }
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
    const canAct = wantsFire && aimed && !w.isBlocked && !(def.kind === "beam" && cmd.holdBeams);

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
      muzzleVelocity: mount.muzzleVelocity,
      ...(fuseTime !== undefined && def.projectile?.burstRadius ? { fuseTime } : {}),
    });
  }
  return orders;
}
