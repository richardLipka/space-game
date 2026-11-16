import type { ReplayData } from "../sim/scenario/record";

/**
 * Recorded battles kept in this browser (IndexedDB: a replay of a five-minute battle flown by hand is about a
 * megabyte, too much for localStorage). The newest MAX are kept. Without IndexedDB (private window) they live
 * in memory until the page closes.
 */
const DB = "space-game-replays";
const STORE = "replays";
export const MAX_REPLAYS = 20;

export class ReplayStore {
  private db: Promise<IDBDatabase | null>;
  private memory: ReplayData[] = [];

  constructor() {
    this.db = new Promise((resolve) => {
      try {
        const open = indexedDB.open(DB, 1);
        open.onupgradeneeded = () => {
          if (!open.result.objectStoreNames.contains(STORE))
            open.result.createObjectStore(STORE, { keyPath: "id" });
        };
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => resolve(null);
        open.onblocked = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }

  private async tx<T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
    const db = await this.db;
    if (!db) return null;
    return new Promise((resolve) => {
      try {
        const req = f(db.transaction(STORE, mode).objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }

  /** Every stored replay, newest first. */
  async list(): Promise<ReplayData[]> {
    const db = await this.db;
    const all = db
      ? ((await this.tx("readonly", (s) => s.getAll() as IDBRequest<ReplayData[]>)) ?? [])
      : this.memory;
    return [...all].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async get(id: string): Promise<ReplayData | null> {
    if (!(await this.db)) return this.memory.find((r) => r.id === id) ?? null;
    return (await this.tx("readonly", (s) => s.get(id) as IDBRequest<ReplayData | undefined>)) ?? null;
  }

  /** Stores (or replaces) a replay and drops the oldest beyond MAX_REPLAYS. */
  async put(r: ReplayData): Promise<void> {
    if (!(await this.db)) {
      this.memory = [r, ...this.memory.filter((x) => x.id !== r.id)].slice(0, MAX_REPLAYS);
      return;
    }
    await this.tx("readwrite", (s) => s.put(r));
    const all = await this.list();
    for (const old of all.slice(MAX_REPLAYS)) await this.delete(old.id);
  }

  async delete(id: string): Promise<void> {
    if (!(await this.db)) {
      this.memory = this.memory.filter((r) => r.id !== id);
      return;
    }
    await this.tx("readwrite", (s) => s.delete(id));
  }
}
