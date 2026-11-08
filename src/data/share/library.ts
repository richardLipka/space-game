import type { PartDef } from "../schemas/part";
import type { ShipDesign } from "../schemas/design";

/** A user part plus where it came from. */
export interface StoredPart {
  readonly def: PartDef;
  readonly importedFrom?: string;
}

/**
 * Local library of designs and user parts (spec §4.5). Async so the browser implementation can use IndexedDB;
 * the in-memory implementation serves tests and headless tools.
 */
export interface Library {
  listDesigns(): Promise<ShipDesign[]>;
  getDesign(id: string): Promise<ShipDesign | undefined>;
  putDesign(design: ShipDesign): Promise<void>;
  deleteDesign(id: string): Promise<void>;
  listParts(): Promise<StoredPart[]>;
  getPart(id: string): Promise<StoredPart | undefined>;
  putPart(part: StoredPart): Promise<void>;
}

export class MemoryLibrary implements Library {
  readonly designs = new Map<string, ShipDesign>();
  readonly parts = new Map<string, StoredPart>();

  async listDesigns() {
    return [...this.designs.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
  }
  async getDesign(id: string) {
    return this.designs.get(id);
  }
  async putDesign(d: ShipDesign) {
    this.designs.set(d.id, structuredClone(d));
  }
  async deleteDesign(id: string) {
    this.designs.delete(id);
  }
  async listParts() {
    return [...this.parts.values()].sort((a, b) => (a.def.id < b.def.id ? -1 : 1));
  }
  async getPart(id: string) {
    return this.parts.get(id);
  }
  async putPart(p: StoredPart) {
    this.parts.set(p.def.id, structuredClone(p));
  }
}

/** Which designs use a part ("used by" view). */
export async function designsUsingPart(lib: Library, partId: string): Promise<string[]> {
  return (await lib.listDesigns()).filter((d) => d.parts.some((p) => p.partId === partId)).map((d) => d.id);
}

/** Snapshot maps for dependency collection / import. */
export async function librarySnapshot(lib: Library) {
  const [designs, parts] = await Promise.all([lib.listDesigns(), lib.listParts()]);
  return {
    designs: new Map(designs.map((d) => [d.id, d])),
    userParts: new Map(parts.map((p) => [p.def.id, p.def])),
  };
}
