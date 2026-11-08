import type { ShipDesign } from "../schemas/design";
import type { Library, StoredPart } from "./library";

const DB_NAME = "space-game";
const DB_VERSION = 1;

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

/** Browser library in IndexedDB: object stores `designs` (key: id) and `parts` (key: def.id). */
export class IdbLibrary implements Library {
  private constructor(private readonly db: IDBDatabase) {}

  static async open(name = DB_NAME): Promise<IdbLibrary> {
    const open = indexedDB.open(name, DB_VERSION);
    open.onupgradeneeded = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains("designs")) db.createObjectStore("designs", { keyPath: "id" });
      if (!db.objectStoreNames.contains("parts")) db.createObjectStore("parts", { keyPath: "def.id" });
    };
    return new IdbLibrary(await req(open));
  }

  private store(name: "designs" | "parts", mode: IDBTransactionMode = "readonly"): IDBObjectStore {
    return this.db.transaction(name, mode).objectStore(name);
  }

  async listDesigns(): Promise<ShipDesign[]> {
    const all = await req(this.store("designs").getAll() as IDBRequest<ShipDesign[]>);
    return all.sort((a, b) => (a.name < b.name ? -1 : 1));
  }
  async getDesign(id: string) {
    return (await req(this.store("designs").get(id))) as ShipDesign | undefined;
  }
  async putDesign(d: ShipDesign) {
    await req(this.store("designs", "readwrite").put(structuredClone(d)));
  }
  async deleteDesign(id: string) {
    await req(this.store("designs", "readwrite").delete(id));
  }
  async listParts(): Promise<StoredPart[]> {
    const all = await req(this.store("parts").getAll() as IDBRequest<StoredPart[]>);
    return all.sort((a, b) => (a.def.id < b.def.id ? -1 : 1));
  }
  async getPart(id: string) {
    return (await req(this.store("parts").get(id))) as StoredPart | undefined;
  }
  async putPart(p: StoredPart) {
    await req(this.store("parts", "readwrite").put(structuredClone(p)));
  }
}
