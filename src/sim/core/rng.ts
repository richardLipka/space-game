/**
 * Seeded pseudo-random number generator (xoshiro128**), the only randomness source allowed in /sim
 * (spec §13.4). Seeded via splitmix32 so that any 32-bit seed gives a well-mixed state.
 *
 * All arithmetic is 32-bit integer maths, so sequences are bit-identical across JS engines.
 * Derived helpers that use Math.log/Math.cos (normal) are only guaranteed identical per engine.
 */
export type RngState = readonly [number, number, number, number];

function splitmix32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    return (z ^ (z >>> 16)) >>> 0;
  };
}

const rotl = (x: number, k: number): number => ((x << k) | (x >>> (32 - k))) >>> 0;

export class Rng {
  private s0: number;
  private s1: number;
  private s2: number;
  private s3: number;

  constructor(seed: number) {
    if (!Number.isInteger(seed)) throw new Error(`Rng seed must be an integer, got ${seed}`);
    const sm = splitmix32(seed);
    this.s0 = sm();
    this.s1 = sm();
    this.s2 = sm();
    this.s3 = sm();
    // xoshiro must never have an all-zero state.
    if ((this.s0 | this.s1 | this.s2 | this.s3) === 0) this.s0 = 1;
  }

  static fromState(state: RngState): Rng {
    const r = new Rng(0);
    [r.s0, r.s1, r.s2, r.s3] = state.map((v) => v >>> 0) as [number, number, number, number];
    return r;
  }

  getState(): RngState {
    return [this.s0, this.s1, this.s2, this.s3];
  }

  /** Next unsigned 32-bit integer. */
  nextU32(): number {
    const result = Math.imul(rotl(Math.imul(this.s1, 5) >>> 0, 7), 9) >>> 0;
    const t = (this.s1 << 9) >>> 0;
    this.s2 ^= this.s0;
    this.s3 ^= this.s1;
    this.s1 ^= this.s2;
    this.s0 ^= this.s3;
    this.s2 ^= t;
    this.s3 = rotl(this.s3, 11);
    this.s0 >>>= 0;
    this.s1 >>>= 0;
    this.s2 >>>= 0;
    return result;
  }

  /** Uniform float in [0, 1), 32 bits of precision. */
  next(): number {
    return this.nextU32() / 4294967296;
  }

  /** Uniform float in [min, max). */
  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  /** Uniform integer in [min, max] inclusive, without modulo bias. */
  int(min: number, max: number): number {
    if (!Number.isInteger(min) || !Number.isInteger(max) || max < min) {
      throw new Error(`Invalid int range [${min}, ${max}]`);
    }
    const span = max - min + 1;
    if (span > 4294967296) throw new Error("Range too large");
    const limit = 4294967296 - (4294967296 % span);
    let x: number;
    do x = this.nextU32();
    while (x >= limit);
    return min + (x % span);
  }

  bool(pTrue = 0.5): boolean {
    return this.next() < pTrue;
  }

  /** Normal distribution (Box–Muller). Identical per JS engine, not guaranteed across engines. */
  normal(mean = 0, stdDev = 1): number {
    let u = 0;
    while (u === 0) u = this.next();
    const v = this.next();
    return mean + stdDev * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /** Independent child stream, e.g. one per subsystem, so adding draws in one place doesn't shift another. */
  fork(): Rng {
    return new Rng(this.nextU32() | 0);
  }
}
