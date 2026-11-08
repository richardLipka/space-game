import type { PartPlacement, ShipDesign } from "../data/schemas/design";
import type { PartCatalogue } from "../sim/ship/catalogue";
import { LayoutIndex, type PlacedPart } from "../sim/ship/layout";
import { degToRad, radToDeg, vec2 } from "../sim/core/vec2";

export function placedPart(pl: PartPlacement, catalogue: PartCatalogue): PlacedPart {
  return {
    uid: pl.uid,
    def: catalogue.get(pl.partId),
    position: vec2(pl.x, pl.y),
    angle: degToRad(pl.angle),
  };
}

export function placedParts(design: ShipDesign, catalogue: PartCatalogue): PlacedPart[] {
  return design.parts.map((pl) => placedPart(pl, catalogue));
}

export function layoutOf(design: ShipDesign, catalogue: PartCatalogue): LayoutIndex {
  return new LayoutIndex(placedParts(design, catalogue));
}

/** Normalise degrees to (−180, 180] and round away float noise so saved files stay tidy. */
export function tidyAngleDeg(deg: number): number {
  let a = ((((deg + 180) % 360) + 360) % 360) - 180;
  if (a === -180) a = 180;
  return Math.round(a * 1e6) / 1e6;
}

export const tidyCoord = (v: number): number => Math.round(v * 1e6) / 1e6;

export function placementFromPose(
  uid: string,
  partId: string,
  x: number,
  y: number,
  angleRad: number,
): PartPlacement {
  return { uid, partId, x: tidyCoord(x), y: tidyCoord(y), angle: tidyAngleDeg(radToDeg(angleRad)) };
}
