/**
 * Fixed-timestep accumulator (spec §2, §13.1). The caller feeds real elapsed time (from the renderer's
 * frame clock, outside /sim); the loop decides how many fixed simulation ticks to run and returns the
 * interpolation alpha for rendering between the last two states.
 */
export const SIM_HZ = 60;
export const SIM_DT = 1 / SIM_HZ;

export interface AdvanceResult {
  /** Number of simulation ticks executed during this call. */
  readonly steps: number;
  /** Fraction of a tick left in the accumulator, in [0, 1): render-interpolation factor. */
  readonly alpha: number;
  /** True when steps were dropped because the frame took too long (spiral-of-death guard). */
  readonly droppedTime: boolean;
}

export class FixedStepLoop {
  private accumulator = 0;

  constructor(
    private readonly step: (dt: number) => void,
    readonly dt: number = SIM_DT,
    /** Maximum ticks per advance() call; excess time is dropped. */
    private readonly maxStepsPerAdvance = 8,
  ) {
    if (!(dt > 0)) throw new Error("dt must be positive");
  }

  /** @param elapsedSeconds real time since the previous call; time scale is applied by the caller. */
  advance(elapsedSeconds: number): AdvanceResult {
    if (!(elapsedSeconds >= 0)) elapsedSeconds = 0;
    this.accumulator += elapsedSeconds;
    let steps = 0;
    // Small epsilon so that e.g. 2 × (1/120) reliably yields one 1/60 tick despite float rounding.
    const eps = 1e-9;
    while (this.accumulator + eps >= this.dt && steps < this.maxStepsPerAdvance) {
      this.step(this.dt);
      this.accumulator -= this.dt;
      steps++;
    }
    let droppedTime = false;
    if (this.accumulator + eps >= this.dt) {
      this.accumulator %= this.dt;
      droppedTime = true;
    }
    if (this.accumulator < 0) this.accumulator = 0;
    return { steps, alpha: this.accumulator / this.dt, droppedTime };
  }

  reset(): void {
    this.accumulator = 0;
  }
}
