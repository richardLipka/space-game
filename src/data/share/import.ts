import { lenient, repairCrew } from "../repair";
import type { CrewEntry } from "../schemas/officer";
import type { PartDef } from "../schemas/part";
import type { ShipDesign } from "../schemas/design";
import { validateDesign, validatePart } from "../validate";
import { contentHash } from "../../sim/core/hash";
import { PartCatalogue } from "../../sim/ship/catalogue";
import { BUNDLE_FORMAT_VERSION, ShipExport, parseShareText } from "./bundle";
import type { Library } from "./library";

/** Sanity limits for imported content (spec §4.5). Out-of-range values reject the import, never clamp. */
export const SANITY = {
  maxVertices: 32,
  maxCoord: 30,
  maxMass: 1e6,
  maxHp: 1e6,
  maxCost: 1e5,
  maxThrust: 5e6,
  maxTorque: 1e7,
  maxPower: 1e8,
  maxCapacity: 1e9,
  maxDesignParts: 1000,
  maxDesignCoord: 2000,
} as const;

export function sanityErrors(def: PartDef): string[] {
  const errs: string[] = [];
  const at = (path: string, v: number, max: number) => {
    if (!(Math.abs(v) <= max)) errs.push(`${def.id}: ${path} = ${v} exceeds limit ${max}`);
  };
  if (def.outline.length > SANITY.maxVertices)
    errs.push(`${def.id}: outline has ${def.outline.length} vertices (max ${SANITY.maxVertices})`);
  def.outline.forEach(
    ([x, y], i) => (at(`outline[${i}].x`, x, SANITY.maxCoord), at(`outline[${i}].y`, y, SANITY.maxCoord)),
  );
  for (const piece of def.convexPieces ?? [])
    if (piece.length > SANITY.maxVertices) errs.push(`${def.id}: convex piece has too many vertices`);
  at("mass", def.mass, SANITY.maxMass);
  at("hp", def.hp, SANITY.maxHp);
  at("cost", def.cost, SANITY.maxCost);
  if (def.engine) at("engine.thrust", def.engine.thrust, SANITY.maxThrust);
  if (def.thruster) at("thruster.thrust", def.thruster.thrust, SANITY.maxThrust);
  if (def.burst) at("burst.thrust", def.burst.thrust, SANITY.maxThrust);
  if (def.gyro) at("gyro.torque", def.gyro.torque, SANITY.maxTorque);
  if (def.command) at("command.gyroTorque", def.command.gyroTorque, SANITY.maxTorque);
  if (def.reactor) at("reactor.maxOutput", def.reactor.maxOutput, SANITY.maxPower);
  if (def.fuelTank) at("fuelTank.capacity", def.fuelTank.capacity, SANITY.maxCapacity);
  if (def.battery) at("battery.capacity", def.battery.capacity, SANITY.maxCapacity);
  if (def.magazine) at("magazine.capacity", def.magazine.capacity, SANITY.maxCapacity);
  if (def.weapon?.projectile) at("weapon.projectile.damage", def.weapon.projectile.damage, SANITY.maxHp);
  return errs;
}

export interface ImportContext {
  readonly core: PartCatalogue;
  readonly userParts: ReadonlyMap<string, PartDef>;
  readonly designs: ReadonlyMap<string, ShipDesign>;
}

export interface ImportPlan {
  readonly bundle: ShipExport;
  /** Designs after part renames (roots first). */
  readonly designs: ShipDesign[];
  /** New user parts to store (after renames). */
  readonly newParts: PartDef[];
  /** Imported part id → local id, for parts that clashed with a different local definition. */
  readonly renamed: Record<string, string>;
  /** Imported user parts identical to local ones (reused). */
  readonly reused: string[];
  /** Core parts whose hash differs from the local catalogue (rebalanced since export). */
  readonly coreMismatches: string[];
  /** True when the bundle carries the original definitions of all mismatched core parts. */
  readonly canPinOriginal: boolean;
  /** Imported design ids that already exist locally. */
  readonly designConflicts: string[];
  readonly warnings: string[];
  readonly author: string;
  /** Officers each design carried (same order as `designs`); they join the roster on import. */
  readonly crews: (CrewEntry[] | undefined)[];
}

export type AnalyzeResult = { ok: true; plan: ImportPlan } | { ok: false; errors: string[] };

function rewriteDesign(d: ShipDesign, map: Record<string, string>): ShipDesign {
  if (Object.keys(map).length === 0) return d;
  return { ...d, parts: d.parts.map((p) => (map[p.partId] ? { ...p, partId: map[p.partId]! } : p)) };
}

function rewritePart(
  p: PartDef,
  map: Record<string, string>,
  designMap: Record<string, string> = {},
): PartDef {
  let out = p;
  if (map[p.id]) out = { ...out, id: map[p.id]! };
  if (p.mirrorOf && map[p.mirrorOf]) out = { ...out, mirrorOf: map[p.mirrorOf]! };
  if (p.hangar && designMap[p.hangar.droneType])
    out = { ...out, hangar: { ...p.hangar, droneType: designMap[p.hangar.droneType]! } };
  return out;
}

function freeId(id: string, taken: (id: string) => boolean): string {
  for (let n = 2; ; n++) {
    const candidate = `${id}~${n}`;
    if (!taken(candidate)) return candidate;
  }
}

/** Steps 1–4 and 6 of the import rules (spec §4.5). Pure: nothing is written. */
export function analyzeImport(input: string | unknown, ctx: ImportContext): AnalyzeResult {
  let data: unknown = input;
  if (typeof input === "string") {
    const parsed = parseShareText(input);
    if (!parsed.ok) return { ok: false, errors: [parsed.error] };
    data = parsed.data;
  }
  const head = data as { format?: unknown; formatVersion?: unknown };
  if (
    typeof head === "object" &&
    head &&
    typeof head.formatVersion === "number" &&
    head.formatVersion > BUNDLE_FORMAT_VERSION
  ) {
    return {
      ok: false,
      errors: [
        `This file was made by a newer version of the game (format ${head.formatVersion}); this version reads format ${BUNDLE_FORMAT_VERSION}.`,
      ],
    };
  }
  // Officers travel with the design. They are taken out before validation and repaired on their own, so a
  // crew from another version never blocks the ship; they go to the roster, not the library.
  const rawCrews: unknown[] = [];
  if (data && typeof data === "object" && Array.isArray((data as { designs?: unknown }).designs)) {
    const designsRaw = (data as { designs: unknown[] }).designs;
    data = {
      ...(data as object),
      designs: designsRaw.map((d) => {
        if (!d || typeof d !== "object") return d;
        const { crew, ...rest } = d as { crew?: unknown };
        rawCrews.push(crew);
        return rest;
      }),
    };
  }
  // A newer file may carry settings this version does not know: they are ignored (with a warning).
  const r = lenient(ShipExport, data);
  if (!r.ok) return { ok: false, errors: r.errors };
  const loadNotes = [...r.notes];
  const bundle0 = r.value;
  const crews: (CrewEntry[] | undefined)[] = bundle0.designs.map((_, i) => {
    if (rawCrews[i] === undefined) return undefined;
    const c = repairCrew(rawCrews[i], 31 + i);
    loadNotes.push(...c.notes);
    return c.crew;
  });
  let bundle = bundle0;

  if (bundle.format === "spacegame.scenario")
    return { ok: false, errors: ["Scenario import is not supported yet."] };

  const errors: string[] = [];
  for (const p of bundle.dependencies.parts) {
    const pr = validatePart(p);
    if (!pr.ok) errors.push(...pr.errors);
    if (p.source === "core" || p.id.startsWith("core:"))
      errors.push(`${p.id}: embedded parts must be user parts`);
    errors.push(...sanityErrors(p));
  }
  for (const d of bundle.designs) {
    const dr = validateDesign(d);
    if (!dr.ok) errors.push(...dr.errors.map((e) => `${d.id}: ${e}`));
    if (d.parts.length > SANITY.maxDesignParts) errors.push(`${d.id}: too many parts (${d.parts.length})`);
    for (const p of d.parts)
      if (Math.abs(p.x) > SANITY.maxDesignCoord || Math.abs(p.y) > SANITY.maxDesignCoord)
        errors.push(`${d.id}/${p.uid}: position out of range`);
  }
  if (errors.length) return { ok: false, errors };

  // Core resolution: parts from a newer game version that this one lacks are left out of the ships.
  const missingCore = Object.keys(bundle.core.parts).filter((id) => !ctx.core.has(id));
  if (missingCore.length) {
    const gone = new Set(missingCore);
    const designs = bundle.designs.map((d) => ({ ...d, parts: d.parts.filter((p) => !gone.has(p.partId)) }));
    const empty = designs.filter((d) => d.parts.length === 0).map((d) => d.name);
    if (empty.length)
      return {
        ok: false,
        errors: [`${empty.join(", ")}: every part is from a newer game version (${missingCore.join(", ")}).`],
      };
    const parts = Object.fromEntries(Object.entries(bundle.core.parts).filter(([id]) => !gone.has(id)));
    bundle = { ...bundle, designs, core: { ...bundle.core, parts } };
    loadNotes.push(
      `Parts from a newer game version are missing here and were left out: ${missingCore.join(", ")}. Check the ship before flying it.`,
    );
  }
  const coreMismatches = Object.entries(bundle.core.parts)
    .filter(([id, hash]) => ctx.core.get(id).hash !== hash)
    .map(([id]) => id);
  const archived = new Map((bundle.core.archived ?? []).map((p) => [p.id, p]));
  const canPinOriginal =
    coreMismatches.length > 0 &&
    coreMismatches.every(
      (id) => archived.has(id) && contentHash(archived.get(id)!) === bundle.core.parts[id],
    );

  // Every referenced part must be core or embedded.
  const embedded = new Map(bundle.dependencies.parts.map((p) => [p.id, p]));
  for (const d of bundle.designs) {
    for (const pl of d.parts) {
      if (!pl.partId.startsWith("core:") && !embedded.has(pl.partId))
        errors.push(`${d.id}: part ${pl.partId} is not included in the file`);
      if (pl.partId.startsWith("core:") && !(pl.partId in bundle.core.parts))
        errors.push(`${d.id}: core part ${pl.partId} is not listed in core.parts`);
    }
  }
  if (errors.length) return { ok: false, errors };

  // User part resolution.
  const renamed: Record<string, string> = {};
  const reused: string[] = [];
  const newIds = new Set<string>();
  for (const p of bundle.dependencies.parts) {
    const local = ctx.userParts.get(p.id);
    if (!local) continue;
    if (contentHash(local) === contentHash(p)) reused.push(p.id);
    else
      renamed[p.id] = freeId(
        p.id,
        (id) =>
          ctx.userParts.has(id) || embedded.has(id) || newIds.has(id) || Object.values(renamed).includes(id),
      );
    newIds.add(renamed[p.id] ?? p.id);
  }
  const newParts = bundle.dependencies.parts
    .filter((p) => !reused.includes(p.id))
    .map((p) => rewritePart(p, renamed));
  const designs = bundle.designs.map((d) => rewriteDesign(d, renamed));
  const designConflicts = designs.filter((d) => ctx.designs.has(d.id)).map((d) => d.id);

  const warnings: string[] = [...loadNotes];
  if (coreMismatches.length) {
    warnings.push(
      `${coreMismatches.length} core part(s) changed since this ship was exported (${coreMismatches.join(", ")}); it may perform differently.`,
    );
  }
  for (const [from, to] of Object.entries(renamed))
    warnings.push(`Part ${from} differs from your local part with the same id; imported as ${to}.`);
  // Step 6: the summary is informational only. Recompute and flag differences.
  const catalogue = new PartCatalogue(ctx.core.version, [
    ...ctx.core.all().map((p) => p.def),
    ...ctx.userParts.values(),
    ...newParts.filter((p) => !ctx.userParts.has(p.id)),
  ]);
  const root = designs[0]!;
  const cost = root.parts.reduce((s, p) => s + catalogue.get(p.partId).def.cost, 0);
  if (cost !== bundle.summary.cost || root.parts.length !== bundle.summary.partCount) {
    warnings.push("The file's summary does not match the ship; values are recomputed from its parts.");
  }
  const author = root.author ?? bundle.dependencies.parts.find((p) => p.author)?.author ?? "unknown";
  return {
    ok: true,
    plan: {
      bundle,
      designs,
      newParts,
      renamed,
      reused,
      coreMismatches,
      canPinOriginal,
      designConflicts,
      warnings,
      author,
      crews,
    },
  };
}

export type ConflictChoice = "replace" | "keep-both" | "cancel";

export interface ApplyOptions {
  /** How to resolve design id collisions (required when the plan has conflicts). */
  readonly onConflict?: ConflictChoice;
  /** Keep the exporter's original definitions of rebalanced core parts as pinned user parts. */
  readonly pinOriginal?: boolean;
  /** Generates fresh design ids for "keep-both". */
  readonly newId: () => string;
}

export interface ApplyResult {
  readonly applied: boolean;
  /** Ids of stored designs, roots first. */
  readonly designIds: string[];
  readonly partIds: string[];
}

/** Step 5 and the write: stores parts and designs in the library. */
export async function applyImport(
  plan: ImportPlan,
  lib: Library,
  options: ApplyOptions,
): Promise<ApplyResult> {
  if (plan.designConflicts.length && (!options.onConflict || options.onConflict === "cancel")) {
    return { applied: false, designIds: [], partIds: [] };
  }
  let designs = plan.designs;
  let parts = plan.newParts;

  if (options.pinOriginal && plan.canPinOriginal) {
    const map: Record<string, string> = {};
    const archived = new Map((plan.bundle.core.archived ?? []).map((p) => [p.id, p]));
    for (const id of plan.coreMismatches) {
      const original = archived.get(id)!;
      const pinnedId = `user:pinned/${id.slice("core:".length)}~${plan.bundle.core.parts[id]!.slice(0, 6)}`;
      map[id] = pinnedId;
      parts = [...parts, { ...original, id: pinnedId, source: "user", name: `${original.name} (pinned)` }];
    }
    designs = designs.map((d) => rewriteDesign(d, map));
    parts = parts.map((p) => rewritePart(p, map));
  }

  const designMap: Record<string, string> = {};
  if (options.onConflict === "keep-both") {
    for (const id of plan.designConflicts) designMap[id] = options.newId();
    designs = designs.map((d) => (designMap[d.id] ? { ...d, id: designMap[d.id]! } : d));
    parts = parts.map((p) => rewritePart(p, {}, designMap));
  }

  for (const p of parts) await lib.putPart({ def: p, importedFrom: plan.author });
  for (const d of designs) await lib.putDesign(d);
  return { applied: true, designIds: designs.map((d) => d.id), partIds: parts.map((p) => p.id) };
}
