/**
 * Undo/redo over immutable snapshots. Designs are small (≤ a few hundred parts), so storing whole
 * snapshots is simpler and safer than inverse commands, and makes "undo everything = original" exact.
 */
export class History<T> {
  private past: T[] = [];
  private future: T[] = [];

  constructor(
    private present: T,
    private readonly limit = 500,
  ) {}

  get current(): T {
    return this.present;
  }

  push(next: T): void {
    this.past.push(this.present);
    if (this.past.length > this.limit) this.past.shift();
    this.present = next;
    this.future = [];
  }

  /** Replace the present without creating an undo step (e.g. continuous drag updates). */
  replace(next: T): void {
    this.present = next;
  }

  undo(): boolean {
    const prev = this.past.pop();
    if (prev === undefined) return false;
    this.future.push(this.present);
    this.present = prev;
    return true;
  }

  redo(): boolean {
    const next = this.future.pop();
    if (next === undefined) return false;
    this.past.push(this.present);
    this.present = next;
    return true;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  reset(value: T): void {
    this.past = [];
    this.future = [];
    this.present = value;
  }
}
