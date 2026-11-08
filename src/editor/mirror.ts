import type { PartPlacement } from "../data/schemas/design";
import { type Vec2, degToRad, rotate } from "../sim/core/vec2";
import type { PartCatalogue, RuntimePartDef } from "../sim/ship/catalogue";
import { tidyAngleDeg, tidyCoord } from "./placement";

/**
 * Mirror mode (spec §3.2): the symmetry axis is the ship's x axis (forward), so (x, y) → (x, −y).
 * A part placed at angle a is mirrored by placing it at −a − 2β, where β is a local reflection-symmetry axis
 * of the part (outline AND functional vectors must be symmetric about it). Parts without such an axis use
 * their catalogue mirror variant (`mirrorOf`), otherwise mirroring is approximate.
 */
const reflect = (v: Vec2, beta: number): Vec2 => {
  const c = Math.cos(2 * beta);
  const s = Math.sin(2 * beta);
  return { x: v.x * c + v.y * s, y: v.x * s - v.y * c };
};

const near = (a: Vec2, b: Vec2) => Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6;

function symmetricAbout(def: RuntimePartDef, beta: number): boolean {
  for (const v of def.outline) if (!def.outline.some((w) => near(reflect(v, beta), w))) return false;
  // Edge types must map onto edges of the same type.
  for (const e of def.edges) {
    const ra = reflect(e.a, beta);
    const rb = reflect(e.b, beta);
    const match = def.edges.find((f) => (near(f.a, rb) && near(f.b, ra)) || (near(f.a, ra) && near(f.b, rb)));
    if (!match || match.type !== e.type) return false;
  }
  const vectors: Vec2[] = [];
  if (def.engineThrustDir) vectors.push(def.engineThrustDir);
  if (def.thrusterDir) vectors.push(def.thrusterDir);
  const w = def.def.weapon;
  if (w) {
    vectors.push({ x: 1, y: 0 }); // mount axis
    if (!near(reflect({ x: w.muzzle[0], y: w.muzzle[1] }, beta), { x: w.muzzle[0], y: w.muzzle[1] }))
      return false;
  }
  return vectors.every((v) => near(reflect(v, beta), v));
}

const CANDIDATE_AXES = [0, 90, 45, 135].map(degToRad);
const axisCache = new WeakMap<RuntimePartDef, number | null>();

/** Local reflection axis (radians) of a part, or null if it has none. */
export function mirrorAxis(def: RuntimePartDef): number | null {
  if (axisCache.has(def)) return axisCache.get(def)!;
  const beta = CANDIDATE_AXES.find((b) => symmetricAbout(def, b)) ?? null;
  axisCache.set(def, beta);
  return beta;
}

export interface MirrorResult {
  readonly partId: string;
  readonly x: number;
  readonly y: number;
  /** Degrees. */
  readonly angle: number;
  /** False when no symmetry axis or mirror variant exists (placement is a best effort). */
  readonly exact: boolean;
}

export function mirrorPlacement(
  pl: Pick<PartPlacement, "partId" | "x" | "y" | "angle">,
  catalogue: PartCatalogue,
): MirrorResult {
  const def = catalogue.get(pl.partId);
  const beta = mirrorAxis(def);
  const a = degToRad(pl.angle);
  if (beta !== null) {
    return {
      partId: pl.partId,
      x: tidyCoord(pl.x),
      y: tidyCoord(-pl.y),
      angle: tidyAngleDeg(((-a - 2 * beta) * 180) / Math.PI),
      exact: true,
    };
  }
  const variant = def.def.mirrorOf ?? catalogue.all().find((p) => p.def.mirrorOf === pl.partId)?.id;
  if (variant && catalogue.has(variant)) {
    return {
      partId: variant,
      x: tidyCoord(pl.x),
      y: tidyCoord(-pl.y),
      angle: tidyAngleDeg(-pl.angle),
      exact: true,
    };
  }
  return {
    partId: pl.partId,
    x: tidyCoord(pl.x),
    y: tidyCoord(-pl.y),
    angle: tidyAngleDeg(-pl.angle),
    exact: false,
  };
}

/** True when `b` is the mirror twin of `a` (same part pair, mirrored pose). */
export function isMirrorTwin(a: PartPlacement, b: PartPlacement, catalogue: PartCatalogue): boolean {
  const m = mirrorPlacement(a, catalogue);
  const da = Math.abs(tidyAngleDeg(m.angle - b.angle));
  return (
    m.partId === b.partId &&
    Math.abs(m.x - b.x) < 1e-4 &&
    Math.abs(m.y - b.y) < 1e-4 &&
    (da < 1e-3 || Math.abs(da - 360) < 1e-3)
  );
}

/** Rotation helper re-exported for UI previews. */
export const rotateVec = rotate;
