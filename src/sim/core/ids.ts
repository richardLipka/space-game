/**
 * Deterministic, stable entity IDs (spec §13.4). IDs are sequential per prefix and owned by the world,
 * so the same sequence of spawns always produces the same IDs. Zero-padded so lexical order = creation order.
 */
export class IdGenerator {
  private readonly counters = new Map<string, number>();

  next(prefix: string): string {
    if (!/^[a-z][a-z0-9-]*$/.test(prefix)) throw new Error(`Invalid id prefix "${prefix}"`);
    const n = (this.counters.get(prefix) ?? 0) + 1;
    this.counters.set(prefix, n);
    return `${prefix}-${String(n).padStart(6, "0")}`;
  }

  /** Serializable snapshot, sorted by prefix for stable hashing. */
  getState(): Record<string, number> {
    return Object.fromEntries([...this.counters.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  }

  static fromState(state: Record<string, number>): IdGenerator {
    const g = new IdGenerator();
    for (const [k, v] of Object.entries(state)) g.counters.set(k, v);
    return g;
  }
}

/** Compare function for sorting by ID; use instead of relying on Map/Set insertion order in hot paths. */
export const compareIds = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
