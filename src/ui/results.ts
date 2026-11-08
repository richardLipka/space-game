/** A finished scenario battle (plan M7 task 3), kept in local storage. */
export interface ScenarioResult {
  readonly scenarioId: string;
  readonly won: boolean;
  /** Battle length (s). */
  readonly time: number;
  readonly dealt: number;
  readonly taken: number;
  readonly partsLost: number;
  /** Fleet cost and the design names flown. */
  readonly cost: number;
  readonly fleet: readonly string[];
  readonly at: string;
}

const KEY = "space-game.results.v1";
const MAX = 200;

/** Results history per browser. Storage may be unavailable (private window): then results live in memory. */
export class ResultStore {
  private memory: ScenarioResult[] | null = null;

  all(): ScenarioResult[] {
    if (this.memory) return this.memory;
    try {
      const raw = localStorage.getItem(KEY);
      const list = raw ? (JSON.parse(raw) as ScenarioResult[]) : [];
      return Array.isArray(list) ? list : [];
    } catch {
      this.memory = [];
      return this.memory;
    }
  }

  add(r: ScenarioResult): void {
    const list = [...this.all(), r].slice(-MAX);
    if (this.memory) {
      this.memory = list;
      return;
    }
    try {
      localStorage.setItem(KEY, JSON.stringify(list));
    } catch {
      this.memory = list;
    }
  }

  /** Best result for a scenario: a win beats a loss, then the faster win. */
  best(scenarioId: string): ScenarioResult | null {
    let best: ScenarioResult | null = null;
    for (const r of this.all()) {
      if (r.scenarioId !== scenarioId) continue;
      if (!best || (r.won && !best.won) || (r.won === best.won && r.won && r.time < best.time)) best = r;
    }
    return best;
  }
}
