import { type Vec2, angleBetween, cross, degToRad, length, normalize, sub, ZERO } from "../core/vec2";
import { hpFactor, isIntact, partCentroid, toShipDir, type MassProps, type PartInstance } from "../ship/ship";

export const G0 = 9.80665;

/**
 * One controllable force/torque source at full throttle, expressed in the ship frame about the CoM.
 * Gyros are split into a +τ and a −τ actuator so every throttle lives in [0, 1].
 */
export interface Actuator {
  readonly kind: "engine" | "thruster" | "gyro";
  readonly partUid: string;
  readonly fx: number;
  readonly fy: number;
  readonly torque: number;
  /** kg/s at full throttle. */
  readonly fuelFlow: number;
  /** Allocator penalty per unit throttle (prefers gyro over fuel-burning thrusters). */
  readonly cost: number;
}

export interface EngineStatus {
  readonly partUid: string;
  /** Angle between nominal thrust axis and the line to the CoM (radians). */
  readonly phi: number;
  readonly outOfGimbal: boolean;
  /** Effective thrust direction (ship frame). */
  readonly direction: Vec2;
}

export interface PropulsionModel {
  readonly actuators: readonly Actuator[];
  readonly engines: readonly EngineStatus[];
}

const GYRO_COST = 1e-6;
const FUEL_COST = 1e-5;

/**
 * Builds actuators from the current ship state (spec §6.3–6.5).
 * - Main engines gimbal so the thrust line passes through the CoM: force T·u·cos φ along f̂, zero torque.
 *   Outside gimbalMax the engine cannot fire. Fuel use is based on T·u (cos φ is an efficiency loss).
 * - Thrusters push along a fixed direction at their position, producing torque r × F.
 * - Gyros (command module + gyro parts) give torque without fuel.
 */
/** Per-part availability from the resource systems (spec §7). */
export interface PropulsionContext {
  /** Fuel reachable through the part's network. */
  hasFuel(uid: string): boolean;
  /** Output multiplier: power served × heat throttle (1 = full). */
  factor(uid: string): number;
  /** Part's network contains the command module (otherwise it cannot be commanded). */
  commanded(uid: string): boolean;
}

export function buildPropulsion(
  parts: readonly PartInstance[],
  mp: MassProps,
  context: boolean | PropulsionContext,
): PropulsionModel {
  const ctx: PropulsionContext =
    typeof context === "boolean"
      ? { hasFuel: () => context, factor: () => 1, commanded: () => true }
      : context;
  const actuators: Actuator[] = [];
  const engines: EngineStatus[] = [];
  let maxFlow = 0;
  for (const p of parts) {
    const t = p.def.def.engine?.thrust ?? p.def.def.thruster?.thrust ?? 0;
    const isp = p.def.def.engine?.isp ?? p.def.def.thruster?.isp ?? 1;
    if (t > 0) maxFlow = Math.max(maxFlow, t / (isp * G0));
  }

  for (const p of parts) {
    if (!isIntact(p)) continue;
    const def = p.def.def;
    if (!ctx.commanded(p.uid)) continue;
    const hf = hpFactor(p) * ctx.factor(p.uid);
    const hasFuel = ctx.hasFuel(p.uid);
    const pos = partCentroid(p);

    if (def.engine && p.def.engineThrustDir) {
      const nominal = toShipDir(p, p.def.engineThrustDir);
      const toCom = sub(mp.center, pos);
      const dir = length(toCom) < 1e-9 ? nominal : normalize(toCom);
      const phi = Math.abs(angleBetween(nominal, dir));
      const outOfGimbal = phi > degToRad(def.engine.gimbalMax) + 1e-12;
      engines.push({ partUid: p.uid, phi, outOfGimbal, direction: outOfGimbal ? ZERO : dir });
      if (!outOfGimbal && hasFuel && hf > 0) {
        const f = def.engine.thrust * hf * Math.cos(phi);
        const flow = (def.engine.thrust * hf) / (def.engine.isp * G0);
        actuators.push({
          kind: "engine",
          partUid: p.uid,
          fx: dir.x * f,
          fy: dir.y * f,
          torque: 0,
          fuelFlow: flow,
          cost: FUEL_COST * (maxFlow > 0 ? flow / maxFlow : 1),
        });
      }
    }

    if (def.thruster && p.def.thrusterDir && hasFuel && hf > 0) {
      const dir = toShipDir(p, p.def.thrusterDir);
      const f = def.thruster.thrust * hf;
      const r = sub(pos, mp.center);
      const flow = f / (def.thruster.isp * G0);
      actuators.push({
        kind: "thruster",
        partUid: p.uid,
        fx: dir.x * f,
        fy: dir.y * f,
        torque: cross(r, { x: dir.x * f, y: dir.y * f }),
        fuelFlow: flow,
        cost: FUEL_COST * (maxFlow > 0 ? flow / maxFlow : 1),
      });
    }

    const gyroTorque = (def.command?.gyroTorque ?? 0) + (def.gyro?.torque ?? 0);
    if (gyroTorque > 0 && hf > 0) {
      const tq = gyroTorque * hf;
      actuators.push({
        kind: "gyro",
        partUid: p.uid,
        fx: 0,
        fy: 0,
        torque: tq,
        fuelFlow: 0,
        cost: GYRO_COST,
      });
      actuators.push({
        kind: "gyro",
        partUid: p.uid,
        fx: 0,
        fy: 0,
        torque: -tq,
        fuelFlow: 0,
        cost: GYRO_COST,
      });
    }
  }
  return { actuators, engines };
}

export interface Capabilities {
  /** Maximum force along local +x, −x, +y, −y (N). */
  readonly fwd: number;
  readonly back: number;
  readonly left: number;
  readonly right: number;
  /** Maximum counter-clockwise / clockwise torque (N·m). */
  readonly torqueCcw: number;
  readonly torqueCw: number;
}

export function capabilities(acts: readonly Actuator[]): Capabilities {
  let fwd = 0,
    back = 0,
    left = 0,
    right = 0,
    ccw = 0,
    cw = 0;
  for (const a of acts) {
    if (a.fx > 0) fwd += a.fx;
    else back -= a.fx;
    if (a.fy > 0) left += a.fy;
    else right -= a.fy;
    if (a.torque > 0) ccw += a.torque;
    else cw -= a.torque;
  }
  return { fwd, back, left, right, torqueCcw: ccw, torqueCw: cw };
}
