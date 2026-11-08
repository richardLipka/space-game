import type { Catalogue as CatalogueJson, PartDef } from "../../data/schemas/part";
import { shapeMassInfo } from "../core/geometry";
import { type Vec2, normalize, perp, sub, vec2, neg, lerp } from "../core/vec2";
import { contentHash } from "../core/hash";

export interface RuntimeEdge {
  readonly type: "snap" | "hull" | "function";
  readonly a: Vec2;
  readonly b: Vec2;
  readonly mid: Vec2;
  /** Outward unit normal (outline is counter-clockwise, so outward = edge direction rotated −90°). */
  readonly normal: Vec2;
}

/** Part definition with derived geometry, ready for the simulation. Immutable. */
export interface RuntimePartDef {
  readonly def: PartDef;
  readonly id: string;
  readonly hash: string;
  readonly outline: readonly Vec2[];
  readonly pieces: readonly (readonly Vec2[])[];
  readonly edges: readonly RuntimeEdge[];
  readonly area: number;
  readonly centroid: Vec2;
  readonly unitInertia: number;
  /** Main engines: nominal thrust direction in part-local frame (opposite of the nozzle edge normal). */
  readonly engineThrustDir?: Vec2;
  /** Thrusters: unit force direction in part-local frame. */
  readonly thrusterDir?: Vec2;
}

const toVec = ([x, y]: readonly [number, number]): Vec2 => vec2(x, y);

export function buildRuntimePart(def: PartDef): RuntimePartDef {
  const outline = def.outline.map(toVec);
  const pieces = def.convexPieces ? def.convexPieces.map((p) => p.map(toVec)) : [outline];
  const edges: RuntimeEdge[] = outline.map((a, i) => {
    const b = outline[(i + 1) % outline.length]!;
    const dir = normalize(sub(b, a));
    return { type: def.edges[i]!, a, b, mid: lerp(a, b, 0.5), normal: neg(perp(dir)) };
  });
  const info = shapeMassInfo(pieces);
  const nozzle = def.engine ? edges[def.engine.nozzleEdge] : undefined;
  return {
    def,
    id: def.id,
    hash: contentHash(def),
    outline,
    pieces,
    edges,
    area: info.area,
    centroid: info.centroid,
    unitInertia: info.unitInertia,
    engineThrustDir: nozzle ? neg(nozzle.normal) : undefined,
    thrusterDir: def.thruster ? normalize(toVec(def.thruster.direction)) : undefined,
  };
}

export class PartCatalogue {
  private readonly parts = new Map<string, RuntimePartDef>();

  constructor(
    readonly version: string,
    defs: readonly PartDef[],
  ) {
    for (const d of defs) this.parts.set(d.id, buildRuntimePart(d));
  }

  static fromJson(json: CatalogueJson): PartCatalogue {
    return new PartCatalogue(json.catalogueVersion, json.parts);
  }

  get(id: string): RuntimePartDef {
    const p = this.parts.get(id);
    if (!p) throw new Error(`Unknown part ${id}`);
    return p;
  }

  has(id: string): boolean {
    return this.parts.has(id);
  }

  all(): RuntimePartDef[] {
    return [...this.parts.values()];
  }
}
