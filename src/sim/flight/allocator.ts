import type { Actuator } from "./propulsion";

export interface Wrench {
  readonly fx: number;
  readonly fy: number;
  readonly torque: number;
}

export interface AllocatorOptions {
  /** Fixed number of coordinate-descent sweeps (determinism: no convergence-dependent exit). */
  readonly sweeps?: number;
  /** Relative importance of each wrench component (default 1). Lower = "don't care much". */
  readonly weights?: { readonly fx: number; readonly fy: number; readonly torque: number };
}

/**
 * Thrust allocation (spec §6.6): find throttles u ∈ [0,1]ⁿ minimising
 *   ‖W(Au − w)‖² + Σ costᵢ·uᵢ
 * by projected coordinate descent with a fixed sweep count and fixed actuator order.
 * Rows are normalised by total capacity so force and torque errors are comparable.
 */
export function allocate(
  acts: readonly Actuator[],
  desired: Wrench,
  options: AllocatorOptions = {},
): number[] {
  const n = acts.length;
  const u = new Array<number>(n).fill(0);
  if (n === 0) return u;
  const sweeps = options.sweeps ?? 30;

  // One shared scale for both force axes (so a tiny parasitic side force isn't over-weighted),
  // one for torque.
  let capF = 0,
    capT = 0;
  for (const a of acts) {
    capF += Math.hypot(a.fx, a.fy);
    capT += Math.abs(a.torque);
  }
  const rw = options.weights ?? { fx: 1, fy: 1, torque: 1 };
  const wx = capF > 0 ? rw.fx / capF : 0;
  const wy = capF > 0 ? rw.fy / capF : 0;
  const wt = capT > 0 ? rw.torque / capT : 0;

  // Scaled columns and residual r = W(Au − w), starting from u = 0.
  const sx = acts.map((a) => a.fx * wx);
  const sy = acts.map((a) => a.fy * wy);
  const st = acts.map((a) => a.torque * wt);
  let rx = -desired.fx * wx;
  let ry = -desired.fy * wy;
  let rt = -desired.torque * wt;

  for (let s = 0; s < sweeps; s++) {
    for (let i = 0; i < n; i++) {
      const cx = sx[i]!,
        cy = sy[i]!,
        ct = st[i]!;
      const h = cx * cx + cy * cy + ct * ct;
      if (h === 0) continue;
      const g = cx * rx + cy * ry + ct * rt + acts[i]!.cost / 2;
      const old = u[i]!;
      let next = old - g / h;
      next = next < 0 ? 0 : next > 1 ? 1 : next;
      const d = next - old;
      if (d !== 0) {
        u[i] = next;
        rx += cx * d;
        ry += cy * d;
        rt += ct * d;
      }
    }
  }
  return u;
}

/** Resulting wrench for given throttles. */
export function wrenchOf(acts: readonly Actuator[], u: readonly number[]): Wrench {
  let fx = 0,
    fy = 0,
    torque = 0;
  acts.forEach((a, i) => {
    const t = u[i] ?? 0;
    fx += a.fx * t;
    fy += a.fy * t;
    torque += a.torque * t;
  });
  return { fx, fy, torque };
}
