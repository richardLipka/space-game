import type { PartPlacement, ShipDesign } from "../data/schemas/design";
import { attachEdges } from "../editor/guide";
import { mirrorPlacement } from "../editor/mirror";
import { layoutOf, tidyAngleDeg, tidyCoord } from "../editor/placement";
import { designStats } from "../editor/stats";
import { validateDesignLayout } from "../editor/validate";
import { type Vec2, add, rotate, scale, sub } from "../sim/core/vec2";
import type { PartCatalogue } from "../sim/ship/catalogue";
import { turretBlockedRanges } from "../sim/ship/layout";
import { auditDesign } from "./design-audit";

/**
 * Brings a design up to the design rules by adding parts (docs/design-rules.md): magazines for weapons
 * short of ammunition, reactors for power, heat sinks for cooling. Parts go in mirrored pairs on free
 * attach edges, where they add no layout issue and block no turret, as close to the ship's centre (and its
 * rear) as possible.
 */

const MAGAZINE: Record<string, string> = {
  "kinetic-120": "core:magazine.kinetic.s",
  "autocannon-30": "core:magazine.autocannon.s",
  "pd-20": "core:magazine.pd.s",
  "flak-40": "core:magazine.flak.s",
  missile: "core:magazine.missile.s",
};

const issueKeys = (d: ShipDesign, cat: PartCatalogue) =>
  new Set(validateDesignLayout(d, cat).issues.map((i) => i.code + "|" + [...i.parts].sort().join(",")));

const blockedOf = (d: ShipDesign, cat: PartCatalogue): number => {
  const layout = layoutOf(d, cat);
  let sum = 0;
  for (const p of layout.parts)
    if (p.def.def.weapon?.mount === "turret")
      for (const [a, b] of turretBlockedRanges(layout, p, 60, 3)) sum += b - a;
  return sum;
};

/** Every flush placement of `partId` against a free snap edge of the design (four headings, three slides). */
export function candidates(
  d: ShipDesign,
  cat: PartCatalogue,
  partId: string,
): Pick<PartPlacement, "x" | "y" | "angle">[] {
  const layout = layoutOf(d, cat);
  const def = cat.get(partId);
  const out: Pick<PartPlacement, "x" | "y" | "angle">[] = [];
  for (const target of attachEdges(layout).free)
    for (const deg of [0, 90, 180, 270]) {
      const ang = (deg * Math.PI) / 180;
      def.edges.forEach((e) => {
        if (e.type !== "snap") return;
        const n = rotate(e.normal, ang);
        // Own edge must face the target edge.
        if (n.x * target.normal.x + n.y * target.normal.y > -0.999) return;
        const a = rotate(e.a, ang);
        const b = rotate(e.b, ang);
        const mid = scale(add(a, b), 0.5);
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        const tmid = scale(add(target.a, target.b), 0.5);
        const dir = scale(sub(target.b, target.a), 1 / target.length);
        const slide = Math.max(0, (target.length - len) / 2);
        for (const s of slide > 1e-6 ? [-slide, 0, slide] : [0]) {
          const at: Vec2 = add(tmid, scale(dir, s));
          const pos = sub(at, mid);
          out.push({ x: tidyCoord(pos.x), y: tidyCoord(pos.y), angle: tidyAngleDeg(deg) });
        }
      });
    }
  return out;
}

/**
 * Adds one part (with its mirror twin unless it sits on the axis) at the best valid place. Returns the new
 * design, or null when there is no valid place.
 */
export function addPart(
  d: ShipDesign,
  cat: PartCatalogue,
  partId: string,
  prefix: string,
  maxExtraBlocked = MAX_EXTRA_BLOCKED,
): ShipDesign | null {
  const before = issueKeys(d, cat);
  const blocked = blockedOf(d, cat);
  const com = designStats(d, cat).center;
  const uids = uidMaker(d, prefix);
  const seen = new Set<string>();
  let best: { design: ShipDesign; score: number } | null = null;
  for (const c of candidates(d, cat, partId)) {
    const k = `${c.x}|${c.y}|${c.angle}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const first: PartPlacement = { uid: uids(0), partId, ...c };
    const parts = [...d.parts, first];
    if (Math.abs(c.y) > 1e-6) {
      const m = mirrorPlacement(first, cat);
      parts.push({ uid: uids(1), partId: m.partId, x: m.x, y: m.y, angle: m.angle });
    }
    const next: ShipDesign = { ...d, parts };
    if ([...issueKeys(next, cat)].some((x) => !before.has(x))) continue;
    // Turret arcs: a little more blocked arc is accepted on crowded small ships, never much.
    const extra = blockedOf(next, cat) - blocked;
    if (extra > maxExtraBlocked) continue;
    const score = Math.hypot(c.x - com.x, c.y - com.y) + 0.5 * Math.max(0, c.x - com.x) + extra / 10;
    if (!best || score < best.score) best = { design: next, score };
  }
  return best?.design ?? null;
}

/** Most extra turret arc (degrees, summed over turrets) one added pair may block; twice that as a last resort. */
const MAX_EXTRA_BLOCKED = 45;

function uidMaker(d: ShipDesign, prefix: string): (k: number) => string {
  let n = 1;
  while (d.parts.some((p) => p.uid === `${prefix}${n}` || p.uid === `${prefix}${n + 1}`)) n += 2;
  return (k) => `${prefix}${n + k}`;
}

/**
 * Fallback for ships with no free outer edge (armored hulls): an interior 2 × 2 hull block (and its mirror
 * twin) becomes magazines, keeping the outline. Square magazines fill it four to a block; missile magazines
 * (1.5 × 1) two to a block.
 */
export function replaceHull(
  d: ShipDesign,
  cat: PartCatalogue,
  partId: string,
  prefix: string,
): ShipDesign | null {
  const def = cat.get(partId).def;
  const xs = def.outline.map((v) => v[0]!);
  const ys = def.outline.map((v) => v[1]!);
  const w = Math.max(...xs) - Math.min(...xs);
  const h = Math.max(...ys) - Math.min(...ys);
  const fill: [number, number][] =
    Math.abs(w - 1) < 1e-6 && Math.abs(h - 1) < 1e-6
      ? [
          [-0.5, -0.5],
          [0.5, -0.5],
          [-0.5, 0.5],
          [0.5, 0.5],
        ]
      : Math.abs(w - 1.5) < 1e-6 && Math.abs(h - 1) < 1e-6
        ? [
            [-0.25, -0.5],
            [-0.25, 0.5],
          ]
        : [];
  if (!fill.length) return null;
  const before = issueKeys(d, cat);
  const com = designStats(d, cat).center;
  const blocks = d.parts
    .filter((p) => p.partId === "core:hull.square.m" && p.y >= -1e-6)
    .sort((a, b) => Math.hypot(a.x - com.x, a.y - com.y) - Math.hypot(b.x - com.x, b.y - com.y));
  for (const b of blocks) {
    const twin =
      Math.abs(b.y) > 1e-6
        ? d.parts.find(
            (p) => p.partId === b.partId && Math.abs(p.x - b.x) < 1e-6 && Math.abs(p.y + b.y) < 1e-6,
          )
        : undefined;
    if (Math.abs(b.y) > 1e-6 && !twin) continue;
    const gone = new Set([b.uid, twin?.uid].filter(Boolean));
    let n = 0;
    const added: PartPlacement[] = [];
    for (const blk of [b, twin].filter((x): x is PartPlacement => !!x))
      for (const [dx, dy] of fill) {
        // Keep the twin a mirror image: mirror the offsets for the lower block.
        const sy = blk === twin ? -1 : 1;
        let u: string;
        do u = `${prefix}${++n}`;
        while (d.parts.some((p) => p.uid === u));
        added.push({ uid: u, partId, x: tidyCoord(blk.x + dx), y: tidyCoord(blk.y + sy * dy), angle: 0 });
      }
    const next: ShipDesign = { ...d, parts: [...d.parts.filter((p) => !gone.has(p.uid)), ...added] };
    if ([...issueKeys(next, cat)].some((x) => !before.has(x))) continue;
    return next;
  }
  return null;
}

/** Adds parts until the design follows every rule it can be fixed for; lists what was added and what is left. */
export function fixDesign(
  d: ShipDesign,
  cat: PartCatalogue,
  maxSteps = 24,
): { design: ShipDesign; added: string[]; left: string[] } {
  let design = d;
  const added: string[] = [];
  for (let step = 0; step < maxSteps; step++) {
    const a = auditDesign(design, cat);
    const bad = a.rules.find((r) => !r.ok);
    if (!bad) break;
    const partId = bad.rule.startsWith("ammo ")
      ? MAGAZINE[bad.rule.slice(5)]
      : bad.rule === "power"
        ? "core:reactor.s"
        : bad.rule === "cooling"
          ? "core:heatsink.s"
          : undefined;
    if (!partId) break;
    const prefix = `fix-${partId.split(":")[1]!.split(".")[1] ?? "part"}-`;
    const next =
      addPart(design, cat, partId, prefix) ??
      replaceHull(design, cat, partId, prefix) ??
      addPart(design, cat, partId, prefix, 2 * MAX_EXTRA_BLOCKED);
    if (!next) break;
    const n =
      next.parts.filter((p) => p.partId === partId).length -
      design.parts.filter((p) => p.partId === partId).length;
    added.push(`${partId.replace("core:", "")} ×${n} (${bad.rule})`);
    design = next;
  }
  const left = auditDesign(design, cat)
    .rules.filter((r) => !r.ok)
    .map((r) => `${r.rule} ${r.value.toFixed(2)}`);
  return { design, added, left };
}
