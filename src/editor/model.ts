import type { PartPlacement, PowerGroup, ShipDesign } from "../data/schemas/design";
import type { PartCatalogue } from "../sim/ship/catalogue";
import type { LayoutIndex } from "../sim/ship/layout";
import { History } from "./history";
import { isMirrorTwin, mirrorPlacement } from "./mirror";
import { layoutOf, placementFromPose } from "./placement";
import { designStats, type DesignStats } from "./stats";
import { validateDesignLayout, type ValidationReport } from "./validate";

export const DEFAULT_POWER_PRIORITY: PowerGroup[] = [
  "gyro",
  "propulsion",
  "pointDefense",
  "weapons",
  "hangar",
];

export function emptyDesign(id: string, name: string, nowIso: string): ShipDesign {
  return {
    formatVersion: 1,
    id,
    name,
    createdAt: nowIso,
    modifiedAt: nowIso,
    parts: [],
    weaponGroupModes: {},
    powerPriority: [...DEFAULT_POWER_PRIORITY],
  }; // parts is empty while editing; saving requires ≥ 1 part (schema)
}

/**
 * Editor state: the design with undo/redo, mirror mode and cached analysis (spec §3.5).
 * Pure logic: no DOM, so it is unit-testable and shared with the editor UI.
 */
export class EditorModel {
  private readonly history: History<ShipDesign>;
  mirror = false;
  budget: number | undefined;
  private dragBase: ShipDesign | null = null;
  private cache: {
    design: ShipDesign;
    layout?: LayoutIndex;
    report?: ValidationReport;
    stats?: DesignStats;
  } | null = null;

  constructor(
    private cat: PartCatalogue,
    initial: ShipDesign,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    this.history = new History(initial);
  }

  get catalogue(): PartCatalogue {
    return this.cat;
  }

  /** Swap the catalogue (e.g. after importing user parts); analysis is recomputed. */
  set catalogue(c: PartCatalogue) {
    this.cat = c;
    this.cache = null;
  }

  get design(): ShipDesign {
    return this.history.current;
  }

  // ---------- analysis (memoised per design snapshot) ----------
  private c() {
    if (!this.cache || this.cache.design !== this.design) this.cache = { design: this.design };
    return this.cache;
  }
  get layout(): LayoutIndex {
    const c = this.c();
    return (c.layout ??= layoutOf(this.design, this.catalogue));
  }
  get report(): ValidationReport {
    const c = this.c();
    return (c.report ??= validateDesignLayout(
      this.design,
      this.catalogue,
      this.budget !== undefined ? { budget: this.budget } : {},
      this.layout,
    ));
  }
  /** Null for an empty design. */
  get stats(): DesignStats | null {
    if (this.design.parts.length === 0) return null;
    const c = this.c();
    return (c.stats ??= designStats(this.design, this.catalogue, this.layout));
  }

  // ---------- edits ----------
  private commit(parts: PartPlacement[], extra: Partial<ShipDesign> = {}): void {
    this.history.push({ ...this.design, ...extra, parts, modifiedAt: this.now() });
  }

  nextUid(taken: Iterable<string> = this.design.parts.map((p) => p.uid)): string {
    const used = new Set(taken);
    let n = used.size + 1;
    while (used.has(`p${n}`)) n++;
    return `p${n}`;
  }

  private twinOf(
    uid: string,
    parts: readonly PartPlacement[] = this.design.parts,
  ): PartPlacement | undefined {
    const p = parts.find((x) => x.uid === uid);
    if (!p) return undefined;
    return parts.find((q) => q.uid !== uid && isMirrorTwin(p, q, this.catalogue));
  }

  /** Adds a part; in mirror mode also adds its twin (unless it lies on the axis). Returns the new uids. */
  addPart(partId: string, x: number, y: number, angleRad: number): string[] {
    const uid = this.nextUid();
    const pl = placementFromPose(uid, partId, x, y, angleRad);
    const parts = [...this.design.parts, pl];
    const added = [uid];
    if (this.mirror) {
      const m = mirrorPlacement(pl, this.catalogue);
      const onAxis =
        Math.abs(m.y - pl.y) < 1e-6 && m.partId === pl.partId && Math.abs(m.angle - pl.angle) < 1e-6;
      if (!onAxis) {
        const twinUid = this.nextUid(parts.map((p) => p.uid));
        parts.push({ uid: twinUid, partId: m.partId, x: m.x, y: m.y, angle: m.angle });
        added.push(twinUid);
      }
    }
    this.commit(parts);
    return added;
  }

  removeParts(uids: readonly string[]): void {
    const remove = new Set(uids);
    if (this.mirror)
      for (const u of uids) {
        const t = this.twinOf(u);
        if (t) remove.add(t.uid);
      }
    this.commit(this.design.parts.filter((p) => !remove.has(p.uid)));
  }

  /** Start a drag: subsequent `dragTo` calls update without undo steps; `endDrag` makes one undo step. */
  beginDrag(): void {
    this.dragBase = this.design;
  }

  /**
   * Moves `uid` to (x, y, angle). Parts in `carry` (what hangs on it, see attachedTo) keep their pose
   * relative to it: same rotation, positions turned about the moved part. In mirror mode each moved part's
   * twin follows mirrored, unless the twin is itself being moved.
   */
  dragTo(uid: string, x: number, y: number, angleRad: number, carry: readonly string[] = []): void {
    const base = this.dragBase ?? this.design;
    const from = base.parts.find((p) => p.uid === uid);
    if (!from) return;
    const dTheta = angleRad - (from.angle * Math.PI) / 180;
    const cos = Math.cos(dTheta);
    const sin = Math.sin(dTheta);
    const moving = new Set([uid, ...carry]);
    const parts = base.parts.map((p) => {
      if (p.uid === uid)
        return { ...p, ...placementFromPose(uid, p.partId, x, y, angleRad), weaponGroup: p.weaponGroup };
      if (!moving.has(p.uid)) return p;
      const rx = p.x - from.x;
      const ry = p.y - from.y;
      return {
        ...p,
        ...placementFromPose(
          p.uid,
          p.partId,
          x + rx * cos - ry * sin,
          y + rx * sin + ry * cos,
          (p.angle * Math.PI) / 180 + dTheta,
        ),
        weaponGroup: p.weaponGroup,
      };
    });
    if (this.mirror) {
      for (const u of moving) {
        const twin = this.twinOf(u, base.parts);
        if (!twin || moving.has(twin.uid)) continue;
        const moved = parts.find((p) => p.uid === u)!;
        const m = mirrorPlacement(moved, this.catalogue);
        const i = parts.findIndex((p) => p.uid === twin.uid);
        parts[i] = { ...parts[i]!, partId: m.partId, x: m.x, y: m.y, angle: m.angle };
      }
    }
    const next = { ...base, parts, modifiedAt: this.now() };
    if (this.dragBase) this.history.replace(next);
    else this.history.push(next);
  }

  endDrag(): void {
    if (!this.dragBase) return;
    const final = this.design;
    if (final !== this.dragBase) {
      this.history.replace(this.dragBase);
      this.history.push(final);
    }
    this.dragBase = null;
  }

  cancelDrag(): void {
    if (this.dragBase) this.history.replace(this.dragBase);
    this.dragBase = null;
  }

  setWeaponGroup(uid: string, group: number | undefined): void {
    this.commit(
      this.design.parts.map((p) => {
        if (p.uid !== uid) return p;
        const { weaponGroup: _old, ...rest } = p;
        return group === undefined ? rest : { ...rest, weaponGroup: group };
      }),
    );
  }

  setGroupMode(group: number, mode: "hold" | "manual" | "ai"): void {
    this.commit([...this.design.parts], {
      weaponGroupModes: { ...this.design.weaponGroupModes, [String(group)]: mode },
    });
  }

  setPowerPriority(order: PowerGroup[]): void {
    this.commit([...this.design.parts], { powerPriority: [...order] });
  }

  rename(name: string): void {
    this.commit([...this.design.parts], { name });
  }

  undo(): boolean {
    return this.history.undo();
  }

  redo(): boolean {
    return this.history.redo();
  }

  get canUndo(): boolean {
    return this.history.canUndo;
  }

  get canRedo(): boolean {
    return this.history.canRedo;
  }

  load(design: ShipDesign): void {
    this.history.reset(design);
  }
}
