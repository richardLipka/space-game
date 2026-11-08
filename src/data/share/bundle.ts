import { Type, type Static } from "@sinclair/typebox";
import { deflateSync, inflateSync, strFromU8, strToU8 } from "fflate";
import { PartDef } from "../schemas/part";
import { ShipDesign } from "../schemas/design";
import { contentHash } from "../../sim/core/hash";
import type { PartCatalogue } from "../../sim/ship/catalogue";

/** Export bundle (spec §4.5): a self-contained ship/fleet file with every non-core dependency. */
export const BUNDLE_FORMAT_VERSION = 1;
export const GAME_VERSION = "0.2.0-m2";

const strict = { additionalProperties: false } as const;
export const AmmoTypeDef = Type.Object({ id: Type.String({ minLength: 1 }), name: Type.String() }, strict);
export type AmmoTypeDef = Static<typeof AmmoTypeDef>;

export const BundleFormat = Type.Union([
  Type.Literal("spacegame.ship"),
  Type.Literal("spacegame.fleet"),
  Type.Literal("spacegame.scenario"),
]);

export const ShipExport = Type.Object(
  {
    format: BundleFormat,
    formatVersion: Type.Integer({ minimum: 1 }),
    gameVersion: Type.String(),
    exportedAt: Type.String(),
    core: Type.Object(
      {
        catalogueVersion: Type.String(),
        parts: Type.Record(Type.String(), Type.String({ pattern: "^[0-9a-f]{16}$" })),
        /** Archival export: full definitions of the core parts used. */
        archived: Type.Optional(Type.Array(PartDef)),
      },
      strict,
    ),
    designs: Type.Array(ShipDesign, { minItems: 1 }),
    dependencies: Type.Object({ parts: Type.Array(PartDef), ammoTypes: Type.Array(AmmoTypeDef) }, strict),
    summary: Type.Object(
      { cost: Type.Number(), mass: Type.Number(), class: Type.String(), partCount: Type.Integer() },
      strict,
    ),
  },
  strict,
);
export type ShipExport = Static<typeof ShipExport>;

/** Where dependency collection looks things up. */
export interface DependencySources {
  readonly core: PartCatalogue;
  readonly userParts: ReadonlyMap<string, PartDef>;
  readonly designs: ReadonlyMap<string, ShipDesign>;
}

export class MissingDependencyError extends Error {
  constructor(readonly missing: string[]) {
    super(`Missing dependencies: ${missing.join(", ")}`);
  }
}

export function coreAmmoTypes(core: PartCatalogue): Set<string> {
  const s = new Set<string>();
  for (const p of core.all()) {
    if (p.def.magazine) s.add(p.def.magazine.ammoType);
    if (p.def.weapon?.ammoType) s.add(p.def.weapon.ammoType);
  }
  return s;
}

export interface CollectedDependencies {
  readonly designs: ShipDesign[];
  readonly coreParts: Record<string, string>;
  readonly coreDefs: PartDef[];
  readonly parts: PartDef[];
  readonly ammoTypes: AmmoTypeDef[];
}

/**
 * Walks everything the designs reference (placed parts, mirror variants, ammo types, hangar drone designs
 * and their parts, recursively) and splits it into core references and embedded user content.
 */
export function collectDependencies(
  roots: readonly ShipDesign[],
  src: DependencySources,
): CollectedDependencies {
  const designs = new Map<string, ShipDesign>();
  const parts = new Map<string, PartDef>();
  const coreParts = new Map<string, PartDef>();
  const ammo = new Set<string>();
  const missing = new Set<string>();
  const coreAmmo = coreAmmoTypes(src.core);
  const designQueue = [...roots];
  const partQueue: string[] = [];

  const visitPart = (id: string) => {
    if (parts.has(id) || coreParts.has(id)) return;
    if (id.startsWith("core:")) {
      if (!src.core.has(id)) return void missing.add(id);
      coreParts.set(id, src.core.get(id).def);
    } else {
      const def = src.userParts.get(id);
      if (!def) return void missing.add(id);
      parts.set(id, def);
    }
    partQueue.push(id);
  };

  while (designQueue.length || partQueue.length) {
    const d = designQueue.shift();
    if (d) {
      if (designs.has(d.id)) continue;
      designs.set(d.id, d);
      for (const pl of d.parts) visitPart(pl.partId);
      continue;
    }
    const id = partQueue.shift()!;
    const def = parts.get(id) ?? coreParts.get(id)!;
    if (def.mirrorOf) visitPart(def.mirrorOf);
    for (const t of [def.magazine?.ammoType, def.weapon?.ammoType]) if (t && !coreAmmo.has(t)) ammo.add(t);
    if (def.hangar) {
      const drone = designs.get(def.hangar.droneType) ?? src.designs.get(def.hangar.droneType);
      if (!drone) missing.add(`design:${def.hangar.droneType}`);
      else designQueue.push(drone);
    }
  }
  if (missing.size) throw new MissingDependencyError([...missing].sort());

  const sortById = <T extends { id: string }>(xs: Iterable<T>) =>
    [...xs].sort((a, b) => (a.id < b.id ? -1 : 1));
  const rootIds = new Set(roots.map((r) => r.id));
  return {
    // Roots first (in given order), then dependency designs sorted by id.
    designs: [...roots, ...sortById([...designs.values()].filter((x) => !rootIds.has(x.id)))],
    coreParts: Object.fromEntries(sortById(coreParts.values()).map((p) => [p.id, contentHash(p)])),
    coreDefs: sortById(coreParts.values()),
    parts: sortById(parts.values()),
    ammoTypes: [...ammo].sort().map((id) => ({ id, name: id })),
  };
}

export interface BuildOptions {
  readonly format?: "spacegame.ship" | "spacegame.fleet";
  readonly archival?: boolean;
  readonly exportedAt?: string;
  readonly summary: ShipExport["summary"];
}

export function buildExport(
  roots: readonly ShipDesign[],
  src: DependencySources,
  options: BuildOptions,
): ShipExport {
  const deps = collectDependencies(roots, src);
  return {
    format: options.format ?? (roots.length > 1 ? "spacegame.fleet" : "spacegame.ship"),
    formatVersion: BUNDLE_FORMAT_VERSION,
    gameVersion: GAME_VERSION,
    exportedAt: options.exportedAt ?? new Date().toISOString(),
    core: {
      catalogueVersion: src.core.version,
      parts: deps.coreParts,
      ...(options.archival ? { archived: deps.coreDefs } : {}),
    },
    designs: deps.designs,
    dependencies: { parts: deps.parts, ammoTypes: deps.ammoTypes },
    summary: options.summary,
  };
}

// ---------- Share codes ----------

export const SHARE_PREFIX = "SG1:";

function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Compact one-line share code: SG1: + base64url(deflate(minified JSON)). */
export function encodeShareCode(bundle: ShipExport): string {
  return SHARE_PREFIX + toBase64Url(deflateSync(strToU8(JSON.stringify(bundle)), { level: 9 }));
}

export type ParseResult = { ok: true; data: unknown; source: "json" | "code" } | { ok: false; error: string };

/** Detects raw JSON or an SG1 code in pasted/dropped text. Never throws. */
export function parseShareText(text: string): ParseResult {
  const t = text.trim();
  if (t.startsWith(SHARE_PREFIX)) {
    try {
      const json = strFromU8(inflateSync(fromBase64Url(t.slice(SHARE_PREFIX.length).replace(/\s+/g, ""))));
      return { ok: true, data: JSON.parse(json), source: "code" };
    } catch {
      return { ok: false, error: "The share code is damaged or incomplete." };
    }
  }
  if (t.startsWith("{")) {
    try {
      return { ok: true, data: JSON.parse(t), source: "json" };
    } catch (e) {
      return { ok: false, error: `Not valid JSON: ${(e as Error).message}` };
    }
  }
  return { ok: false, error: "This is not a ship file or SG1 share code." };
}

export const prettyJson = (bundle: ShipExport): string => JSON.stringify(bundle, null, 2) + "\n";
