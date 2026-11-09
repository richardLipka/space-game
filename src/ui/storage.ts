/** localStorage that never throws (private mode, blocked storage): reads give null, writes are dropped. */
export const safeStorage = {
  get(k: string): string | null {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string): void {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* unavailable (private mode) */
    }
  },
};
