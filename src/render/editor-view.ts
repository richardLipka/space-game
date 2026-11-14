import { Container, Graphics, type Application } from "pixi.js";
import type { EditorModel } from "../editor/model";
import type { RuntimePartDef } from "../sim/ship/catalogue";
import { turretBlockedRanges, type PlacedEdge } from "../sim/ship/layout";
import type { AttachEdges, Contact } from "../editor/guide";
import { transformPoints } from "../sim/core/geometry";
import { type Vec2, add, degToRad, fromAngle, rotate } from "../sim/core/vec2";
import { buildPropulsion } from "../sim/flight/propulsion";
import { computeMassProps, instantiateParts } from "../sim/ship/ship";
import { components } from "../editor/validate";
import { connectionGraph, RESOURCES } from "../editor/graph";
import type { Camera } from "./camera";
import type { DrawStyle, ThemeResolver } from "./theme";

export interface EditorOverlays {
  com: boolean;
  thrust: boolean;
  arcs: boolean;
  networks: boolean;
  exposed: boolean;
  connections: boolean;
  /** Connection graph: parts as nodes, connections as edges, with the resources each edge carries. */
  graph: boolean;
}

export interface EditorViewState {
  readonly ghost: {
    def: RuntimePartDef;
    position: Vec2;
    angle: number;
    valid: boolean;
    snapped: boolean;
  } | null;
  readonly selected: ReadonlySet<string>;
  readonly highlighted: ReadonlySet<string>;
  readonly overlays: EditorOverlays;
  /** Parts not attached to the main structure (always highlighted). */
  readonly disconnected: ReadonlySet<string>;
  /** Connection guidance while placing or dragging a part. */
  readonly guide: {
    readonly attach: AttachEdges;
    readonly ghostEdges: readonly PlacedEdge[];
    readonly contacts: readonly Contact[];
  } | null;
  /** Radiator keep-clear zones (nothing of the ship may be placed inside). */
  readonly radiatorZones?: readonly (readonly Vec2[])[];
}

function stroke(g: Graphics, s: DrawStyle, z: number): void {
  if (s.glowAlpha > 0 && s.glowWidth > 0)
    g.stroke({ width: s.glowWidth / z, color: s.glow, alpha: s.glowAlpha, join: "round", cap: "round" });
  g.stroke({ width: s.strokeWidth / z, color: s.stroke, alpha: s.strokeAlpha, join: "round", cap: "round" });
}

function poly(g: Graphics, pts: readonly Vec2[], s: DrawStyle, z: number): void {
  g.poly(
    pts.flatMap((p) => [p.x, p.y]),
    true,
  );
  if (s.fillAlpha > 0) g.fill({ color: s.fill, alpha: s.fillAlpha });
  stroke(g, s, z);
}

/** Pixi rendering of the ship editor (spec §3.5). Reads the model; never mutates it. */
export class EditorView {
  readonly root = new Container();
  private readonly world = new Container();
  private readonly gridG = new Graphics();
  private readonly partsG = new Graphics();
  private readonly overlayG = new Graphics();
  private readonly ghostG = new Graphics();
  private partsKey = "";
  private overlayKey = "";

  constructor(
    private readonly theme: ThemeResolver,
    app: Application,
  ) {
    this.world.addChild(this.gridG, this.partsG, this.overlayG, this.ghostG);
    this.root.addChild(this.world);
    app.stage.addChild(this.root);
  }

  set visible(v: boolean) {
    this.root.visible = v;
  }

  render(model: EditorModel, camera: Camera, state: EditorViewState): void {
    const z = camera.zoom;
    this.world.position.set(camera.width / 2 - camera.center.x * z, camera.height / 2 + camera.center.y * z);
    this.world.scale.set(z, -z);
    this.drawGrid(camera, model.mirror);

    const zoomKey = Math.round(Math.log2(z) * 4);
    const zq = Math.pow(2, zoomKey / 4);
    const sel = [...state.selected].sort().join(",");
    const hi = [...state.highlighted].sort().join(",") + "|" + [...state.disconnected].sort().join(",");
    const design = model.design;
    const key = `${this.theme.version}|${zoomKey}|${sel}|${hi}|${design.modifiedAt}|${design.parts.length}|${design.parts.map((p) => p.uid + p.x + p.y + p.angle).join(";")}`;
    if (key !== this.partsKey) {
      this.partsKey = key;
      const g = this.partsG;
      g.clear();
      const layout = model.layout;
      for (const p of layout.parts) {
        const state_ = state.selected.has(p.uid)
          ? "selected"
          : state.highlighted.has(p.uid)
            ? "issue"
            : state.disconnected.has(p.uid)
              ? "disconnected"
              : "ok";
        poly(
          g,
          layout.outlines.get(p.uid)!,
          this.theme.resolve(`part cat-${p.def.def.category} team-0 state-${state_}`),
          zq,
        );
      }
    }
    const ov = state.overlays;
    const okey = `${key}|${JSON.stringify(ov)}`;
    if (okey !== this.overlayKey) {
      this.overlayKey = okey;
      this.drawOverlays(model, ov, zq);
    }
    this.drawGhost(state, z);
  }

  private drawGrid(camera: Camera, mirror: boolean): void {
    const g = this.gridG;
    const z = camera.zoom;
    g.clear();
    const tl = camera.screenToWorld({ x: 0, y: 0 });
    const br = camera.screenToWorld({ x: camera.width, y: camera.height });
    for (const [step, cls] of [
      [0.5, "editor-grid"],
      [5, "editor-grid major"],
    ] as const) {
      if (step * z < 6) continue;
      const s = this.theme.resolve(cls);
      for (let x = Math.floor(tl.x / step) * step; x <= br.x; x += step) g.moveTo(x, br.y).lineTo(x, tl.y);
      for (let y = Math.floor(br.y / step) * step; y <= tl.y; y += step) g.moveTo(tl.x, y).lineTo(br.x, y);
      g.stroke({ width: s.strokeWidth / z, color: s.stroke, alpha: s.strokeAlpha });
    }
    const axis = this.theme.resolve(mirror ? "editor-axis mirror" : "editor-axis");
    g.moveTo(tl.x, 0).lineTo(br.x, 0).moveTo(0, br.y).lineTo(0, tl.y);
    g.stroke({ width: axis.strokeWidth / z, color: axis.stroke, alpha: axis.strokeAlpha });
  }

  private drawOverlays(model: EditorModel, ov: EditorOverlays, z: number): void {
    const g = this.overlayG;
    g.clear();
    const design = model.design;
    if (design.parts.length === 0) return;
    const layout = model.layout;

    if (ov.networks) {
      const comps = components(design, layout);
      comps.forEach((comp, i) => {
        const s = this.theme.resolve(`overlay-net-${Math.min(i, 5)}`);
        for (const uid of comp) poly(g, layout.outlines.get(uid)!, s, z);
      });
    }
    if (ov.connections) {
      const s = this.theme.resolve("overlay-connection");
      for (const c of layout.connections()) {
        const ea = layout.edges.get(c.a)![c.edgeA]!;
        const eb = layout.edges.get(c.b)![c.edgeB]!;
        // Draw the shared segment slightly thickened.
        const pts = [ea.a, ea.b, eb.a, eb.b];
        const dir = { x: (ea.b.x - ea.a.x) / ea.length, y: (ea.b.y - ea.a.y) / ea.length };
        const ts = pts.map((p) => (p.x - ea.a.x) * dir.x + (p.y - ea.a.y) * dir.y);
        const lo = Math.max(Math.min(ts[0]!, ts[1]!), Math.min(ts[2]!, ts[3]!));
        const hi = Math.min(Math.max(ts[0]!, ts[1]!), Math.max(ts[2]!, ts[3]!));
        g.moveTo(ea.a.x + dir.x * lo, ea.a.y + dir.y * lo).lineTo(ea.a.x + dir.x * hi, ea.a.y + dir.y * hi);
      }
      stroke(g, s, z);
    }
    if (ov.graph) this.drawGraph(model, z);
    if (ov.exposed) {
      const okS = this.theme.resolve("overlay-exposed");
      const badS = this.theme.resolve("overlay-covered");
      for (const p of layout.parts) {
        for (const e of layout.edges.get(p.uid)!) {
          if (e.type === "snap") continue;
          const covered = layout.coveredLength(p.uid, e.index) > 1e-3;
          g.moveTo(e.a.x, e.a.y).lineTo(e.b.x, e.b.y);
          stroke(g, covered ? badS : okS, z);
        }
      }
    }
    if (ov.arcs) {
      const arcS = this.theme.resolve("overlay-arc");
      const blockedS = this.theme.resolve("overlay-arc-blocked");
      for (const p of layout.parts) {
        const w = p.def.def.weapon;
        if (!w) continue;
        const muzzle = add(p.position, rotate({ x: w.muzzle[0], y: w.muzzle[1] }, p.angle));
        const r = 70 / z; // fixed on-screen size
        if (w.mount === "fixed") {
          const d = fromAngle(p.angle);
          g.moveTo(muzzle.x, muzzle.y).lineTo(muzzle.x + d.x * r * 2, muzzle.y + d.y * r * 2);
          stroke(g, arcS, z);
          continue;
        }
        const [a0, a1] = w.arc ?? [-180, 180];
        const arcPath = (from: number, to: number) => {
          const steps = Math.max(2, Math.ceil(Math.abs(to - from) / 5));
          g.moveTo(muzzle.x, muzzle.y);
          for (let i = 0; i <= steps; i++) {
            const d = fromAngle(p.angle + degToRad(from + ((to - from) * i) / steps));
            g.lineTo(muzzle.x + d.x * r, muzzle.y + d.y * r);
          }
          g.lineTo(muzzle.x, muzzle.y);
        };
        arcPath(a0, a1);
        stroke(g, arcS, z);
        for (const [b0, b1] of turretBlockedRanges(layout, p, 60, 3)) {
          arcPath(b0, b1);
          g.fill({ color: blockedS.fill, alpha: blockedS.fillAlpha });
          stroke(g, blockedS, z);
        }
      }
    }
    if (ov.thrust || ov.com) {
      const parts = instantiateParts(design, model.catalogue);
      const mp = computeMassProps(parts);
      if (ov.thrust) {
        const prop = buildPropulsion(parts, mp, true);
        const good = this.theme.resolve("overlay-thrust");
        const bad = this.theme.resolve("overlay-gimbal-bad");
        for (const e of prop.engines) {
          const p = layout.parts.find((x) => x.uid === e.partUid)!;
          const c = transformPoints([p.def.centroid], p.angle, p.position)[0]!;
          if (e.outOfGimbal) {
            g.circle(c.x, c.y, 0.6);
            stroke(g, bad, z);
          } else {
            g.moveTo(c.x, c.y).lineTo(mp.center.x, mp.center.y);
            stroke(g, good, z);
          }
        }
        const rcs = this.theme.resolve("overlay-thrust rcs");
        for (const a of prop.actuators) {
          if (a.kind !== "thruster") continue;
          const p = layout.parts.find((x) => x.uid === a.partUid)!;
          const c = transformPoints([p.def.centroid], p.angle, p.position)[0]!;
          const len = Math.hypot(a.fx, a.fy);
          g.moveTo(c.x, c.y).lineTo(c.x + (a.fx / len) * 0.8, c.y + (a.fy / len) * 0.8);
        }
        stroke(g, rcs, z);
      }
      if (ov.com) {
        const s = this.theme.resolve("overlay-com");
        const c = mp.center;
        const r = s.minSize / z;
        g.circle(c.x, c.y, r)
          .moveTo(c.x - r * 1.6, c.y)
          .lineTo(c.x + r * 1.6, c.y)
          .moveTo(c.x, c.y - r * 1.6)
          .lineTo(c.x, c.y + r * 1.6);
        stroke(g, s, z);
      }
    }
  }

  /**
   * Connection graph overlay: a node at each part's centre, a line per structural connection, and one
   * coloured lane per resource routed along it (power, fuel, ammo always in the same lane order).
   * Structural-only links (through non-conducting parts) and parts missing a supply are styled apart.
   */
  private drawGraph(model: EditorModel, z: number): void {
    const g = this.overlayG;
    const graph = connectionGraph(model.layout);
    const pos = new Map(graph.nodes.map((n) => [n.uid, n.position]));
    const lane = 5 / z; // on-screen spacing between resource lanes
    for (const e of graph.edges) {
      const a = pos.get(e.a)!;
      const b = pos.get(e.b)!;
      g.moveTo(a.x, a.y).lineTo(b.x, b.y);
      stroke(g, this.theme.resolve(e.conducts ? "graph-edge" : "graph-edge structural"), z);
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len < 1e-9) continue;
      const nx = -(b.y - a.y) / len;
      const ny = (b.x - a.x) / len;
      for (const r of e.flows) {
        const off = (RESOURCES.indexOf(r) - 1) * lane;
        g.moveTo(a.x + nx * off, a.y + ny * off).lineTo(b.x + nx * off, b.y + ny * off);
        stroke(g, this.theme.resolve(`graph-flow flow-${r}`), z);
      }
    }
    const missing = new Set(graph.unsupplied.map((u) => u.uid));
    for (const n of graph.nodes) {
      const s = this.theme.resolve(`graph-node cat-${n.category}${n.conducts ? "" : " structural"}`);
      g.circle(n.position.x, n.position.y, s.minSize / z);
      if (s.fillAlpha > 0) g.fill({ color: s.fill, alpha: s.fillAlpha });
      stroke(g, s, z);
      if (missing.has(n.uid)) {
        const m = this.theme.resolve("graph-node unsupplied");
        g.circle(n.position.x, n.position.y, m.minSize / z);
        stroke(g, m, z);
      }
    }
  }

  private drawEdges(g: Graphics, edges: readonly PlacedEdge[], cls: string, z: number): void {
    if (edges.length === 0) return;
    for (const e of edges) g.moveTo(e.a.x, e.a.y).lineTo(e.b.x, e.b.y);
    stroke(g, this.theme.resolve(cls), z);
  }

  private drawGhost(state: EditorViewState, z: number): void {
    const g = this.ghostG;
    g.clear();
    if (state.radiatorZones?.length) {
      const zs = this.theme.resolve("radiator-zone");
      for (const zone of state.radiatorZones) poly(g, zone, zs, z);
    }
    const guide = state.guide;
    if (guide) {
      // Where things can (green) and cannot (red) attach on the ship.
      this.drawEdges(g, guide.attach.free, "guide-attach", z);
      this.drawEdges(g, guide.attach.noAttach, "guide-no-attach", z);
    }
    const ghost = state.ghost;
    if (guide) {
      // The moving part's own edge types.
      this.drawEdges(
        g,
        guide.ghostEdges.filter((e) => e.type === "snap"),
        "guide-ghost-snap",
        z,
      );
      this.drawEdges(
        g,
        guide.ghostEdges.filter((e) => e.type !== "snap"),
        "guide-ghost-no-attach",
        z,
      );
      // What would connect, be too short, or wrongly cover a no-attach edge.
      for (const kind of ["connect", "short", "blocked"] as const) {
        const cs = guide.contacts.filter((c) => c.kind === kind);
        if (cs.length === 0) continue;
        for (const c of cs) g.moveTo(c.a.x, c.a.y).lineTo(c.b.x, c.b.y);
        stroke(g, this.theme.resolve(`guide-contact ${kind}`), z);
      }
    }
    if (!ghost) return;
    const s = this.theme.resolve(
      `editor-ghost ${ghost.valid ? (ghost.snapped ? "snapped" : "valid") : "invalid"}`,
    );
    poly(g, transformPoints(ghost.def.outline, ghost.angle, ghost.position), s, z);
  }
}
