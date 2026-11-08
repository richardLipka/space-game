import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import type { TSchema, Static } from "@sinclair/typebox";
import { Catalogue, PartDef } from "./schemas/part";
import { ShipDesign } from "./schemas/design";
import { Scenario } from "./schemas/scenario";
import { InputStream } from "./schemas/inputs";

const ajv = new Ajv({ allErrors: true, strict: true, allowUnionTypes: true });
const cache = new WeakMap<TSchema, ValidateFunction>();

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

function formatError(e: ErrorObject): string {
  const path = e.instancePath || "/";
  if (e.keyword === "additionalProperties") {
    return `${path}: unexpected property "${(e.params as { additionalProperty: string }).additionalProperty}"`;
  }
  if (e.keyword === "required") {
    return `${path}: missing property "${(e.params as { missingProperty: string }).missingProperty}"`;
  }
  return `${path}: ${e.message ?? e.keyword}`;
}

export function validate<S extends TSchema>(schema: S, data: unknown): ValidationResult<Static<S>> {
  let fn = cache.get(schema);
  if (!fn) {
    fn = ajv.compile(schema);
    cache.set(schema, fn);
  }
  if (fn(data)) return { ok: true, value: data as Static<S> };
  return { ok: false, errors: [...new Set((fn.errors ?? []).map(formatError))] };
}

// ---------- Semantic checks that JSON Schema cannot express ----------

type Pt = readonly [number, number];

/** Signed area; positive = counter-clockwise. */
export function signedArea(poly: readonly Pt[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i]!;
    const [x2, y2] = poly[(i + 1) % poly.length]!;
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

export function isConvexCcw(poly: readonly Pt[]): boolean {
  if (poly.length < 3 || signedArea(poly) <= 0) return false;
  for (let i = 0; i < poly.length; i++) {
    const [ax, ay] = poly[i]!;
    const [bx, by] = poly[(i + 1) % poly.length]!;
    const [cx, cy] = poly[(i + 2) % poly.length]!;
    if ((bx - ax) * (cy - by) - (by - ay) * (cx - bx) < -1e-12) return false;
  }
  return true;
}

export function partSemanticErrors(p: PartDef): string[] {
  const errs: string[] = [];
  if (p.edges.length !== p.outline.length) {
    errs.push(`${p.id}: edges has ${p.edges.length} entries but outline has ${p.outline.length} vertices`);
  }
  if (signedArea(p.outline) <= 0) errs.push(`${p.id}: outline must be counter-clockwise with positive area`);
  if (p.convexPieces) {
    p.convexPieces.forEach((piece, i) => {
      if (!isConvexCcw(piece)) errs.push(`${p.id}: convexPieces[${i}] is not convex and counter-clockwise`);
    });
  } else if (!isConvexCcw(p.outline)) {
    errs.push(`${p.id}: concave outline requires convexPieces`);
  }
  if (p.weapon?.mount === "turret" && p.weapon.traverseRate === undefined)
    errs.push(`${p.id}: turret weapons need a traverseRate (deg/s)`);
  if (p.hangar && !p.edges.includes("function"))
    errs.push(`${p.id}: a hangar needs a "function" edge (its launch bay)`);
  if (p.engine && p.edges[p.engine.nozzleEdge] !== "function") {
    errs.push(`${p.id}: engine.nozzleEdge ${p.engine.nozzleEdge} must reference a "function" edge`);
  }
  if ((p.source === "core") !== p.id.startsWith("core:"))
    errs.push(`${p.id}: id prefix does not match source`);
  return errs;
}

function withSemantics<T>(r: ValidationResult<T>, check: (v: T) => string[]): ValidationResult<T> {
  if (!r.ok) return r;
  const errors = check(r.value);
  return errors.length ? { ok: false, errors } : r;
}

export const validatePart = (d: unknown) => withSemantics(validate(PartDef, d), partSemanticErrors);
export const validateCatalogue = (d: unknown) =>
  withSemantics(validate(Catalogue, d), (c) => {
    const errs = c.parts.flatMap(partSemanticErrors);
    const seen = new Set<string>();
    for (const p of c.parts) {
      if (seen.has(p.id)) errs.push(`duplicate part id ${p.id}`);
      seen.add(p.id);
    }
    return errs;
  });
export const validateDesign = (d: unknown) =>
  withSemantics(validate(ShipDesign, d), (s) => {
    const uids = new Set<string>();
    const errs: string[] = [];
    for (const p of s.parts) {
      if (uids.has(p.uid)) errs.push(`duplicate part uid ${p.uid}`);
      uids.add(p.uid);
    }
    return errs;
  });
export const validateScenario = (d: unknown) =>
  withSemantics(validate(Scenario, d), (s) =>
    s.arena.asteroids.flatMap((a, i) =>
      isConvexCcw(a.outline) ? [] : [`asteroid ${i}: outline must be convex CCW`],
    ),
  );
export const validateInputs = (d: unknown) =>
  withSemantics(validate(InputStream, d), (s) => {
    const errs: string[] = [];
    for (let i = 1; i < s.frames.length; i++) {
      if (s.frames[i]!.tick < s.frames[i - 1]!.tick) errs.push(`/frames/${i}: ticks must be non-decreasing`);
    }
    return errs;
  });
