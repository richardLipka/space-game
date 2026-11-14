import type { ShipDesign } from "../data/schemas/design";
import type { Scenario } from "../data/schemas/scenario";
import { SCENARIOS } from "../data/scenarios/index";
import { TUNING_TESTS } from "../headless/tuning/tests";
import { designSection, orderSections } from "../data/designs/index";
import { validateScenario } from "../data/validate";
import {
  asteroidRadius,
  emptyScenario,
  type ItemRef,
  loadGithubFolder,
  NO_AI,
  parseGithubFolder,
  ScenarioModel,
} from "../editor/scenario-model";
import { layoutOf } from "../editor/placement";
import type { PartCatalogue } from "../sim/ship/catalogue";
import { safeStorage } from "./storage";
import { el } from "./editor/dom";

/** What the scenario editor needs from the app. */
export interface ScenarioEditorServices {
  /** Bundled and library designs by id. */
  designs(): Promise<Map<string, ShipDesign>>;
  /** Adds designs to the library (ships a GitHub folder brings along). */
  importDesigns(designs: ShipDesign[]): Promise<void>;
  profiles: readonly string[];
  catalogue(): PartCatalogue;
  /** Watches the scenario with AI ships only. */
  watch(s: Scenario): void;
  /** Plays it with the design open in the ship editor. */
  play(s: Scenario): void;
  back(): void;
  toast(message: string, kind?: "info" | "error"): void;
}

type Tool = "select" | "ship" | "asteroid" | "well" | "spawn";
const SAVED_KEY = "space-game.scenarios.v1";
export const DEFAULT_GITHUB_FOLDER =
  "https://github.com/richardLipka/space-game/tree/main/src/data/scenarios/tests";
const SVG = "http://www.w3.org/2000/svg";
const TEAM_COLORS = ["#3ba4ff", "#ff5a5f", "#ffb347", "#7dffb0"];

function svg(tag: string, attrs: Record<string, string | number> = {}): SVGElement {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

export function savedScenarios(): Scenario[] {
  try {
    const list = JSON.parse(safeStorage.get(SAVED_KEY) ?? "[]") as unknown[];
    return list.flatMap((j) => {
      const r = validateScenario(j);
      return r.ok ? [r.value] : [];
    });
  } catch {
    return [];
  }
}

function storeScenario(s: Scenario): void {
  const list = savedScenarios().filter((x) => x.id !== s.id);
  safeStorage.set(SAVED_KEY, JSON.stringify([...list, s]));
}

/**
 * Scenario editor: ships, asteroids and black holes placed directly on the map (SVG view over the canvas).
 * Scenarios save locally, export as JSON, and load from bundled ones, saved ones or a GitHub folder.
 */
export class ScenarioEditor {
  readonly root: HTMLElement;
  private readonly model = new ScenarioModel(emptyScenario(`scenario-${Date.now().toString(36)}`));
  private readonly map: SVGSVGElement;
  private readonly side: HTMLElement;
  private readonly palette: HTMLElement;
  private readonly status: HTMLElement;
  private readonly openDialog: HTMLDialogElement;
  private designs = new Map<string, ShipDesign>();
  private tool: Tool = "select";
  private selected: ItemRef | null = null;
  /** View: centre (m) and metres per pixel. */
  private view = { x: 0, y: 0, mpp: 10 };
  private drag: {
    ref: ItemRef | null;
    sx: number;
    sy: number;
    vx: number;
    vy: number;
    moved: boolean;
  } | null = null;
  private placing = { design: "fleet-wasp", team: 1, ai: "balanced", asteroid: 60 };
  private readonly outlines = new Map<string, number[][][]>();

  constructor(private readonly services: ScenarioEditorServices) {
    this.map = svg("svg", { class: "sc-map", "data-testid": "scenario-map" }) as SVGSVGElement;
    this.palette = el("aside", { class: "sc-palette", "data-testid": "scenario-palette" });
    this.side = el("aside", { class: "sc-side", "data-testid": "scenario-props" });
    this.status = el("div", { class: "sc-status", "data-testid": "scenario-status" });
    const name = el("input", {
      class: "sc-name",
      "data-testid": "scenario-name",
      "aria-label": "Scenario name",
    });
    name.addEventListener("change", () => {
      const v = (name as HTMLInputElement).value.trim() || "Untitled";
      this.model.edit((s) => (s.name = v));
      this.render();
    });
    const btn = (label: string, id: string, f: () => void, title = "") => {
      const b = el("button", { "data-testid": id, title }, label);
      b.addEventListener("click", f);
      return b;
    };
    // File menu: a floating drop-down like the ship editor's Export menu.
    const file = el("details", { class: "sc-menu" }, el("summary", { "data-testid": "sc-file" }, "File"));
    file.append(
      btn("New scenario", "sc-new", () => this.newScenario()),
      btn("Open…", "sc-open", () => void this.showOpen()),
      btn("Save in this browser", "sc-save", () => this.save()),
      btn("Export JSON file", "sc-export", () => this.exportJson()),
    );
    file.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest("button")) file.removeAttribute("open");
    });
    const view = el("details", { class: "sc-menu" }, el("summary", { "data-testid": "sc-view" }, "View"));
    view.append(
      btn("Fit the arena", "sc-fit", () => {
        this.fit();
        this.render();
      }),
      btn("Zoom in", "sc-zoom-in", () => this.zoom(0.7)),
      btn("Zoom out", "sc-zoom-out", () => this.zoom(1 / 0.7)),
    );
    view.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest("button")) view.removeAttribute("open");
    });
    const toolbar = el(
      "header",
      { class: "sc-toolbar" },
      el("span", { class: "sc-title" }, "SCENARIO EDITOR"),
      name,
      file,
      view,
      el("span", { class: "sc-sep" }),
      btn("↶", "sc-undo", () => this.model.undo() && this.render(), "Undo (Ctrl+Z)"),
      btn("↷", "sc-redo", () => this.model.redo() && this.render(), "Redo (Ctrl+Y)"),
      el("span", { class: "sc-sep" }),
      btn("Watch", "sc-watch", () => this.launch("watch"), "Watch the AI ships fight"),
      btn("Play", "sc-play", () => this.launch("play"), "Play it with the ship open in the ship editor"),
      btn("Ship editor", "sc-back", () => services.back()),
    );
    this.openDialog = el("dialog", {
      class: "ed-dialog",
      "data-testid": "scenario-open",
    }) as HTMLDialogElement;
    // Full screen like the ship editor: the map underneath, toolbar and panels floating over it.
    this.root = el(
      "div",
      { class: "sc-editor sc-root", "data-testid": "scenario-editor", hidden: "" },
      this.map,
      toolbar,
      this.palette,
      this.side,
      this.status,
    );
    document.body.append(this.root, this.openDialog);
    this.bindMap();
    window.addEventListener("keydown", (e) => this.onKey(e));
  }

  get scenario(): Scenario {
    return this.model.scenario;
  }

  async show(s?: Scenario): Promise<void> {
    this.designs = await this.services.designs();
    if (s) this.model.load(s);
    this.root.hidden = false;
    this.fit();
    this.render();
  }

  hide(): void {
    this.root.hidden = true;
  }

  get visible(): boolean {
    return !this.root.hidden;
  }

  // ---------- coordinates ----------
  private size() {
    const r = this.map.getBoundingClientRect();
    return { w: r.width || 800, h: r.height || 600, left: r.left, top: r.top };
  }
  private toWorld(cx: number, cy: number): [number, number] {
    const { w, h, left, top } = this.size();
    return [
      this.view.x + (cx - left - w / 2) * this.view.mpp,
      this.view.y - (cy - top - h / 2) * this.view.mpp,
    ];
  }
  private zoom(f: number): void {
    this.view.mpp = Math.min(200, Math.max(0.05, this.view.mpp * f));
    this.render();
  }

  /** Fits the arena into the map area left free between the floating panels. */
  fit(): void {
    const { w, h } = this.size();
    const left = this.palette.offsetWidth || 0;
    const right = this.side.offsetWidth || 0;
    const top = (this.root.querySelector(".sc-toolbar") as HTMLElement | null)?.offsetHeight ?? 44;
    const a = this.model.scenario.arena;
    const mpp = Math.max(
      a.width / Math.max(200, w - left - right - 40),
      a.height / Math.max(200, h - top - 68),
    );
    // The arena's centre sits in the middle of the free area, not of the screen.
    this.view = { x: ((right - left) / 2) * mpp, y: ((top - 28) / 2) * mpp, mpp };
  }

  // ---------- input ----------
  private hit(wx: number, wy: number): ItemRef | null {
    const s = this.model.scenario;
    const tol = 12 * this.view.mpp;
    // Topmost first: ships, spawns, asteroids, wells.
    for (const r of this.model.items().reverse()) {
      const [x, y] = this.model.position(r);
      const d = Math.hypot(wx - x, wy - y);
      const radius =
        r.kind === "asteroid"
          ? asteroidRadius(s.arena.asteroids[r.index]!)
          : r.kind === "well"
            ? s.arena.gravityWells[r.index]!.coreRadius
            : 0;
      if (d <= Math.max(radius, tol)) return r;
    }
    return null;
  }

  private bindMap(): void {
    this.map.addEventListener("pointerdown", (e) => {
      const [wx, wy] = this.toWorld(e.clientX, e.clientY);
      this.map.setPointerCapture(e.pointerId);
      const hit = this.tool === "select" || e.button !== 0 ? this.hit(wx, wy) : null;
      if (e.button === 0 && this.tool !== "select") {
        this.selected = this.place(wx, wy);
        this.render();
        return;
      }
      if (hit) {
        this.selected = hit;
        this.model.checkpoint();
      }
      this.drag = { ref: hit, sx: e.clientX, sy: e.clientY, vx: this.view.x, vy: this.view.y, moved: false };
      if (!hit) this.selected = null;
      this.render();
    });
    this.map.addEventListener("pointermove", (e) => {
      const d = this.drag;
      if (!d) {
        const [wx, wy] = this.toWorld(e.clientX, e.clientY);
        this.status.textContent = `${wx.toFixed(0)}, ${wy.toFixed(0)} m · ${this.hint()}`;
        return;
      }
      d.moved = true;
      if (d.ref) {
        const [wx, wy] = this.toWorld(e.clientX, e.clientY);
        this.model.move(d.ref, wx, wy, false);
      } else {
        this.view.x = d.vx - (e.clientX - d.sx) * this.view.mpp;
        this.view.y = d.vy + (e.clientY - d.sy) * this.view.mpp;
      }
      this.render();
    });
    const end = () => {
      if (this.drag?.ref && !this.drag.moved) this.model.undo(); // a click, not a move: drop the checkpoint
      this.drag = null;
    };
    this.map.addEventListener("pointerup", end);
    this.map.addEventListener("pointercancel", end);
    this.map.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const [wx, wy] = this.toWorld(e.clientX, e.clientY);
        const f = Math.exp(e.deltaY * 0.0015);
        this.view.mpp = Math.min(200, Math.max(0.05, this.view.mpp * f));
        const [nx, ny] = this.toWorld(e.clientX, e.clientY);
        this.view.x += wx - nx;
        this.view.y += wy - ny;
        this.render();
      },
      { passive: false },
    );
  }

  private onKey(e: KeyboardEvent): void {
    if (!this.visible || (e.target as HTMLElement).closest("input, select, textarea")) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
      if (this.model.undo()) this.render();
      e.preventDefault();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
      if (this.model.redo()) this.render();
      e.preventDefault();
    } else if (this.selected && (e.key === "Delete" || e.key === "Backspace")) {
      this.model.remove(this.selected);
      this.selected = null;
      this.render();
    } else if (this.selected && (e.key === "q" || e.key === "e")) {
      this.model.rotate(this.selected, e.key === "q" ? 15 : -15);
      this.render();
    } else if (e.key === "Escape") {
      this.setTool("select");
    }
  }

  private place(x: number, y: number): ItemRef {
    const p = this.placing;
    if (this.tool === "ship") return this.model.addShip(p.design, x, y, p.team, p.ai);
    if (this.tool === "asteroid") return this.model.addAsteroid(x, y, p.asteroid);
    if (this.tool === "well") return this.model.addWell(x, y);
    return this.model.addSpawn(x, y);
  }

  private setTool(t: Tool): void {
    this.tool = t;
    this.renderPalette();
    this.status.textContent = this.hint();
  }

  private hint(): string {
    switch (this.tool) {
      case "ship":
        return "Click to place the ship. Esc: back to select.";
      case "asteroid":
        return "Click to place an asteroid.";
      case "well":
        return "Click to place a black hole.";
      case "spawn":
        return "Click to place a player spawn point.";
      default:
        return "Drag items to move them, drag empty space to pan, wheel to zoom. Q/E rotate, Delete removes.";
    }
  }

  // ---------- drawing ----------
  render(): void {
    (this.root.querySelector(".sc-name") as HTMLInputElement).value = this.model.scenario.name;
    this.renderMap();
    this.renderPalette();
    this.renderSide();
  }

  private shipOutline(designId: string): number[][][] {
    const cached = this.outlines.get(designId);
    if (cached) return cached;
    const d = this.designs.get(designId);
    let polys: number[][][] = [];
    if (d) {
      try {
        polys = [...layoutOf(d, this.services.catalogue()).outlines.values()].map((o) =>
          o.map((v) => [v.x, v.y]),
        );
      } catch {
        polys = [];
      }
    }
    this.outlines.set(designId, polys);
    return polys;
  }

  private renderMap(): void {
    const { w, h } = this.size();
    const s = this.model.scenario;
    const v = this.view;
    this.map.setAttribute("viewBox", `0 0 ${w} ${h}`);
    this.map.replaceChildren();
    // World group: metres, y up.
    const g = svg("g", {
      transform: `translate(${w / 2} ${h / 2}) scale(${1 / v.mpp} ${-1 / v.mpp}) translate(${-v.x} ${-v.y})`,
    });
    const px = v.mpp; // one screen pixel in metres
    const a = s.arena;
    g.append(
      svg("rect", {
        x: -a.width / 2,
        y: -a.height / 2,
        width: a.width,
        height: a.height,
        class: "sc-arena",
        "stroke-width": 1.5 * px,
        "stroke-dasharray": `${8 * px} ${6 * px}`,
      }),
    );
    const isSel = (r: ItemRef) => this.selected?.kind === r.kind && this.selected.index === r.index;
    s.arena.gravityWells.forEach((well, i) => {
      const sel = isSel({ kind: "well", index: i });
      const [x, y] = well.position;
      if (well.cutoffRadius)
        g.append(
          svg("circle", { cx: x, cy: y, r: well.cutoffRadius, class: "sc-well-reach", "stroke-width": px }),
        );
      g.append(
        svg("circle", {
          cx: x,
          cy: y,
          r: Math.max(well.coreRadius, 4 * px),
          class: `sc-well${sel ? " selected" : ""}`,
          "stroke-width": 2 * px,
        }),
      );
    });
    s.arena.asteroids.forEach((ast, i) => {
      const sel = isSel({ kind: "asteroid", index: i });
      const t = (ast.angle * Math.PI) / 180;
      const pts = ast.outline
        .map(([x, y]) => [
          ast.position[0] + x * Math.cos(t) - y * Math.sin(t),
          ast.position[1] + x * Math.sin(t) + y * Math.cos(t),
        ])
        .map((p) => p.join(","))
        .join(" ");
      g.append(
        svg("polygon", {
          points: pts,
          class: `sc-asteroid${sel ? " selected" : ""}`,
          "stroke-width": 1.5 * px,
        }),
      );
    });
    s.playerSpawns.forEach((sp, i) => {
      const sel = isSel({ kind: "spawn", index: i });
      const [x, y] = sp.position;
      const r = 9 * px;
      g.append(
        svg("rect", {
          x: x - r,
          y: y - r,
          width: 2 * r,
          height: 2 * r,
          class: `sc-spawn${sel ? " selected" : ""}`,
          "stroke-width": 2 * px,
        }),
      );
    });
    s.enemies.forEach((e, i) => {
      const sel = isSel({ kind: "ship", index: i });
      const [x, y] = e.spawn.position;
      const ship = svg("g", { transform: `translate(${x} ${y}) rotate(${e.spawn.angle})` });
      const color = TEAM_COLORS[e.team % TEAM_COLORS.length]!;
      for (const poly of this.shipOutline(e.designId))
        ship.append(
          svg("polygon", {
            points: poly.map((p) => p.join(",")).join(" "),
            fill: color,
            "fill-opacity": 0.5,
            stroke: color,
            "stroke-width": px,
          }),
        );
      // A marker that stays readable at any zoom: an arrow pointing where the ship faces.
      const m = 8 * px;
      ship.append(
        svg("polygon", {
          points: `${1.6 * m},0 ${-m},${m} ${-0.4 * m},0 ${-m},${-m}`,
          class: `sc-ship${sel ? " selected" : ""}`,
          stroke: color,
          "stroke-width": 1.5 * px,
          fill: sel ? color : "none",
        }),
      );
      g.append(ship);
    });
    this.map.append(g);
    // Labels in screen space (not mirrored).
    s.enemies.forEach((e) => {
      const [x, y] = e.spawn.position;
      const sx = w / 2 + (x - v.x) / v.mpp;
      const sy = h / 2 - (y - v.y) / v.mpp;
      const t = svg("text", { x: sx + 12, y: sy - 10, class: "sc-label" });
      t.textContent = `${this.designs.get(e.designId)?.name ?? e.designId}${e.aiProfile === NO_AI ? " (no AI)" : ""}`;
      this.map.append(t);
    });
  }

  private paletteKey = "";
  private paletteQuery = "";
  private readonly openSections = new Set<string>(["Playable", "Test platforms"]);

  private renderPalette(): void {
    const key = `${this.tool}|${this.placing.design}|${this.placing.team}|${this.placing.ai}|${this.paletteQuery}|${this.designs.size}`;
    if (key === this.paletteKey) return;
    this.paletteKey = key;
    const tools: [Tool, string][] = [
      ["select", "Select / move"],
      ["asteroid", "Asteroid"],
      ["well", "Black hole"],
      ["spawn", "Player spawn"],
    ];
    const items: (HTMLElement | string)[] = [el("h3", {}, "Tools")];
    for (const [t, label] of tools) {
      const b = el(
        "button",
        { "data-testid": `sc-tool-${t}`, class: `sc-part${this.tool === t ? " active" : ""}` },
        label,
      );
      b.addEventListener("click", () => this.setTool(t));
      items.push(b);
    }
    items.push(
      this.numberField(
        "Asteroid radius (m)",
        this.placing.asteroid,
        (v) => (this.placing.asteroid = Math.max(5, v)),
        "sc-place-radius",
      ),
    );
    items.push(el("h3", {}, "Ships"));
    items.push(this.teamSelect(this.placing.team, (t) => (this.placing.team = t), "sc-place-team"));
    items.push(this.aiSelect(this.placing.ai, (a) => (this.placing.ai = a), "sc-place-ai"));
    const search = el("input", {
      class: "sc-search",
      placeholder: "Search ships…",
      "data-testid": "sc-ship-search",
    }) as HTMLInputElement;
    search.value = this.paletteQuery;
    search.addEventListener("input", () => {
      this.paletteQuery = search.value;
      const pos = search.selectionStart;
      this.renderPalette();
      const again = this.palette.querySelector(".sc-search") as HTMLInputElement | null;
      again?.focus();
      if (pos !== null) again?.setSelectionRange(pos, pos);
    });
    items.push(search);
    // Gallery: ships grouped by library section, drawn like the part palette (thumbnail, name, cost).
    const q = this.paletteQuery.trim().toLowerCase();
    const by = new Map<string, ShipDesign[]>();
    for (const d of this.designs.values()) {
      if (d.drone || (q && !d.name.toLowerCase().includes(q) && !d.id.includes(q))) continue;
      const sec = designSection(d);
      by.set(sec, [...(by.get(sec) ?? []), d]);
    }
    const cat = this.services.catalogue();
    const list = el("div", { class: "sc-part-list", "data-testid": "sc-ship-gallery" });
    for (const section of orderSections(by.keys())) {
      const ships = by.get(section)!.sort((a, b) => a.name.localeCompare(b.name));
      const box = el("details", {
        class: "sc-cat",
        "data-testid": `sc-gallery-${section}`,
      }) as HTMLDetailsElement;
      box.open = q !== "" || this.openSections.has(section);
      box.addEventListener("toggle", () => {
        if (q) return;
        if (box.open) this.openSections.add(section);
        else this.openSections.delete(section);
      });
      box.append(el("summary", {}, section, el("span", { class: "sc-cat-count" }, String(ships.length))));
      for (const d of ships) {
        const cost = d.parts.reduce((t, p) => t + (cat.has(p.partId) ? cat.get(p.partId).def.cost : 0), 0);
        const on = this.tool === "ship" && this.placing.design === d.id;
        const item = el("button", {
          class: `sc-part${on ? " active" : ""}`,
          "data-testid": `sc-ship-${d.id}`,
          title: d.description ?? d.id,
        });
        item.append(
          this.shipThumb(d.id),
          el("span", { class: "sc-part-name" }, d.name),
          el("span", { class: "sc-part-cost" }, String(cost)),
        );
        item.addEventListener("click", () => {
          this.placing.design = d.id;
          this.setTool("ship");
        });
        box.append(item);
      }
      list.append(box);
    }
    if (by.size === 0) list.append(el("p", { class: "dim" }, `No ships match "${this.paletteQuery}".`));
    items.push(list);
    this.palette.replaceChildren(...items);
  }

  /** Small outline of a design (nose to the right), like the part thumbnails. */
  private shipThumb(designId: string, size = 28): SVGSVGElement {
    const polys = this.shipOutline(designId);
    const pts = polys.flat();
    const t = svg("svg", { width: size, height: size, class: "sc-thumb" }) as SVGSVGElement;
    if (!pts.length) return t;
    const xs = pts.map((p) => p[0]!);
    const ys = pts.map((p) => p[1]!);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const span = Math.max(maxX - minX, maxY - minY) || 1;
    const pad = span * 0.08;
    t.setAttribute("viewBox", `${minX - pad} ${-maxY - pad} ${span + 2 * pad} ${span + 2 * pad}`);
    for (const poly of polys)
      t.append(
        svg("polygon", {
          points: poly.map(([x, y]) => `${x},${-y!}`).join(" "),
          class: "thumb-fill",
          "vector-effect": "non-scaling-stroke",
        }),
      );
    return t;
  }

  private designSelect(value: string, onChange: (id: string) => void, testid: string): HTMLElement {
    const sel = el("select", { "data-testid": testid, "aria-label": "Design" }) as HTMLSelectElement;
    const by = new Map<string, ShipDesign[]>();
    for (const d of this.designs.values()) {
      if (d.drone) continue;
      const s = designSection(d);
      by.set(s, [...(by.get(s) ?? []), d]);
    }
    for (const section of orderSections(by.keys())) {
      const og = el("optgroup", { label: section });
      for (const d of by.get(section)!.sort((a, b) => a.name.localeCompare(b.name)))
        og.append(el("option", { value: d.id }, d.name));
      sel.append(og);
    }
    sel.value = value;
    sel.addEventListener("change", () => onChange(sel.value));
    return sel;
  }

  private teamSelect(value: number, onChange: (t: number) => void, testid: string): HTMLElement {
    const sel = el("select", { "data-testid": testid, "aria-label": "Team" }) as HTMLSelectElement;
    for (const [t, label] of [
      [0, "Team 0 (player's side)"],
      [1, "Team 1 (enemy)"],
      [2, "Team 2"],
      [3, "Team 3"],
    ] as const)
      sel.append(el("option", { value: String(t) }, label));
    sel.value = String(value);
    sel.addEventListener("change", () => onChange(Number(sel.value)));
    return sel;
  }

  private aiSelect(value: string, onChange: (a: string) => void, testid: string): HTMLElement {
    const sel = el("select", { "data-testid": testid, "aria-label": "AI profile" }) as HTMLSelectElement;
    sel.append(el("option", { value: NO_AI }, "No AI (stays put)"));
    for (const p of this.services.profiles) sel.append(el("option", { value: p }, `AI: ${p}`));
    sel.value = value;
    sel.addEventListener("change", () => onChange(sel.value));
    return sel;
  }

  private numberField(
    label: string,
    value: number,
    onChange: (v: number) => void,
    testid: string,
  ): HTMLElement {
    const input = el("input", {
      type: "number",
      value: String(value),
      "data-testid": testid,
    }) as HTMLInputElement;
    input.addEventListener("change", () => {
      const v = Number(input.value);
      if (Number.isFinite(v)) onChange(v);
      this.render();
    });
    return el("label", { class: "sc-field" }, label, input);
  }

  private textField(
    label: string,
    value: string,
    onChange: (v: string) => void,
    testid: string,
  ): HTMLElement {
    const input = el("textarea", { "data-testid": testid, rows: "3" }) as HTMLTextAreaElement;
    input.value = value;
    input.addEventListener("change", () => onChange(input.value));
    return el("label", { class: "sc-field" }, label, input);
  }

  private renderSide(): void {
    const s = this.model.scenario;
    const out: (HTMLElement | string)[] = [];
    const r = this.selected;
    const edit = (f: (s: Scenario) => void) => {
      this.model.edit(f);
      this.render();
    };
    if (r) {
      const [x, y] = this.model.position(r);
      out.push(
        el(
          "h3",
          {},
          { ship: "Ship", asteroid: "Asteroid", well: "Black hole", spawn: "Player spawn" }[r.kind],
        ),
      );
      out.push(this.numberField("X (m)", x, (v) => this.model.move(r, v, y), "sc-prop-x"));
      out.push(this.numberField("Y (m)", y, (v) => this.model.move(r, x, v), "sc-prop-y"));
      if (r.kind === "ship") {
        const e = s.enemies[r.index]!;
        out.push(
          this.designSelect(
            e.designId,
            (id) => edit((t) => (t.enemies[r.index]!.designId = id)),
            "sc-prop-design",
          ),
        );
        out.push(this.teamSelect(e.team, (v) => edit((t) => (t.enemies[r.index]!.team = v)), "sc-prop-team"));
        out.push(
          this.aiSelect(e.aiProfile, (v) => edit((t) => (t.enemies[r.index]!.aiProfile = v)), "sc-prop-ai"),
        );
        out.push(
          this.numberField(
            "Angle (°)",
            e.spawn.angle,
            (v) => edit((t) => (t.enemies[r.index]!.spawn.angle = v)),
            "sc-prop-angle",
          ),
        );
      } else if (r.kind === "well") {
        const wl = s.arena.gravityWells[r.index]!;
        out.push(
          this.numberField(
            "Mass μ (m³/s²)",
            wl.mu,
            (v) => edit((t) => (t.arena.gravityWells[r.index]!.mu = Math.max(1, v))),
            "sc-prop-mu",
          ),
        );
        out.push(
          this.numberField(
            "Core radius (m)",
            wl.coreRadius,
            (v) => edit((t) => (t.arena.gravityWells[r.index]!.coreRadius = Math.max(1, v))),
            "sc-prop-core",
          ),
        );
        out.push(
          this.numberField(
            "Reach (m)",
            wl.cutoffRadius ?? 0,
            (v) =>
              edit((t) => {
                const w = t.arena.gravityWells[r.index]!;
                if (v > 0) w.cutoffRadius = v;
                else delete w.cutoffRadius;
              }),
            "sc-prop-reach",
          ),
        );
        out.push(el("p", { class: "dim" }, `Pull at 1 km: ${(wl.mu / 1e6).toFixed(0)} m/s².`));
      } else if (r.kind === "asteroid") {
        const ast = s.arena.asteroids[r.index]!;
        out.push(
          this.numberField(
            "Angle (°)",
            ast.angle,
            (v) => edit((t) => (t.arena.asteroids[r.index]!.angle = v)),
            "sc-prop-angle",
          ),
        );
        const fixed = el("input", { type: "checkbox", "data-testid": "sc-prop-static" }) as HTMLInputElement;
        fixed.checked = !!ast.static;
        fixed.addEventListener("change", () =>
          edit((t) => (t.arena.asteroids[r.index]!.static = fixed.checked)),
        );
        out.push(el("label", { class: "sc-field" }, fixed, " Fixed in place"));
      } else {
        out.push(
          this.numberField(
            "Angle (°)",
            s.playerSpawns[r.index]!.angle,
            (v) => edit((t) => (t.playerSpawns[r.index]!.angle = v)),
            "sc-prop-angle",
          ),
        );
      }
      const del = el("button", { class: "danger", "data-testid": "sc-delete" }, "Delete");
      del.addEventListener("click", () => {
        this.model.remove(r);
        this.selected = null;
        this.render();
      });
      out.push(del);
    }
    out.push(el("h3", {}, "Scenario"));
    out.push(
      this.textField("Description", s.description, (v) => edit((t) => (t.description = v)), "sc-description"),
    );
    out.push(
      this.numberField(
        "Arena width (m)",
        s.arena.width,
        (v) => edit((t) => (t.arena.width = Math.max(500, v))),
        "sc-width",
      ),
    );
    out.push(
      this.numberField(
        "Arena height (m)",
        s.arena.height,
        (v) => edit((t) => (t.arena.height = Math.max(500, v))),
        "sc-height",
      ),
    );
    out.push(
      this.numberField("Budget", s.budget, (v) => edit((t) => (t.budget = Math.max(0, v))), "sc-budget"),
    );
    out.push(
      this.numberField(
        "Player ships",
        s.maxPlayerShips,
        (v) => edit((t) => (t.maxPlayerShips = Math.max(0, Math.round(v)))),
        "sc-max-ships",
      ),
    );
    out.push(this.numberField("Seed", s.seed, (v) => edit((t) => (t.seed = Math.round(v))), "sc-seed"));
    const obj = el("select", { "data-testid": "sc-objective" }) as HTMLSelectElement;
    for (const [v, label] of [
      ["destroyAll", "Destroy every enemy"],
      ["survive", "Survive"],
    ] as const)
      obj.append(el("option", { value: v }, label));
    obj.value = s.objective.type === "survive" ? "survive" : "destroyAll";
    obj.addEventListener("change", () =>
      edit(
        (t) =>
          (t.objective =
            obj.value === "survive" ? { type: "survive", seconds: 120 } : { type: "destroyAll" }),
      ),
    );
    out.push(el("label", { class: "sc-field" }, "Objective", obj));
    if (s.objective.type === "survive") {
      const o = s.objective;
      out.push(
        this.numberField(
          "Seconds",
          o.seconds,
          (v) => edit((t) => (t.objective = { type: "survive", seconds: Math.max(1, v) })),
          "sc-survive",
        ),
      );
    }
    const problems = this.model.problems(this.designs, new Set(this.services.profiles));
    out.push(el("h3", {}, problems.length ? `Problems (${problems.length})` : "Ready to play"));
    for (const p of problems) out.push(el("p", { class: "sc-problem" }, p));
    out.push(
      el(
        "p",
        { class: "dim" },
        `${s.enemies.length} ships · ${s.arena.asteroids.length} asteroids · ${s.arena.gravityWells.length} black holes`,
      ),
    );
    this.side.replaceChildren(...out);
  }

  // ---------- files ----------
  private newScenario(): void {
    this.model.load(emptyScenario(`scenario-${Date.now().toString(36)}`));
    this.selected = null;
    this.fit();
    this.render();
  }

  private save(): void {
    storeScenario(this.model.scenario);
    this.services.toast(`Saved “${this.model.scenario.name}” in this browser`);
  }

  private exportJson(): void {
    const blob = new Blob([JSON.stringify(this.model.scenario, null, 2) + "\n"], {
      type: "application/json",
    });
    const a = el("a", {
      href: URL.createObjectURL(blob),
      download: `${this.model.scenario.name.replace(/[^\w-]+/g, "-").toLowerCase() || "scenario"}.json`,
    }) as HTMLAnchorElement;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  private launch(how: "watch" | "play"): void {
    const problems = this.model.problems(this.designs, new Set(this.services.profiles));
    if (problems.length) {
      this.services.toast(problems[0]!, "error");
      return;
    }
    if (how === "watch") this.services.watch(this.model.scenario);
    else this.services.play(this.model.scenario);
  }

  /** Open: bundled scenarios as templates, saved ones, or a GitHub folder. */
  async showOpen(folderUrl?: string): Promise<void> {
    const d = this.openDialog;
    const list = el("div", { class: "lib-list" });
    const pick = (s: Scenario, copy: boolean) => {
      d.close();
      const loaded = copy ? { ...structuredClone(s), id: `scenario-${Date.now().toString(36)}` } : s;
      this.model.load(loaded);
      this.selected = null;
      this.fit();
      this.render();
    };
    const row = (s: Scenario, copy: boolean, extra = "") => {
      const b = el("button", { "data-testid": `sc-open-${s.id}` }, copy ? "Copy" : "Open");
      b.addEventListener("click", () => pick(s, copy));
      return el(
        "div",
        { class: "lib-item" },
        el("span", { class: "name" }, s.name),
        el(
          "span",
          { class: "dim" },
          `${s.enemies.length} ships · ${s.arena.asteroids.length} asteroids${extra}`,
        ),
        b,
      );
    };
    const saved = savedScenarios();
    list.append(el("h3", {}, `Saved in this browser (${saved.length})`));
    for (const s of saved) list.append(row(s, false));
    list.append(el("h3", {}, "From a GitHub folder"));
    const url = el("input", {
      "data-testid": "sc-github-url",
      class: "sc-github",
      value: folderUrl ?? DEFAULT_GITHUB_FOLDER,
    }) as HTMLInputElement;
    const results = el("div", { "data-testid": "sc-github-results" });
    const load = el("button", { "data-testid": "sc-github-load" }, "Load");
    load.addEventListener("click", async () => {
      const f = parseGithubFolder(url.value);
      if (!f) {
        results.replaceChildren(el("p", { class: "sc-problem" }, "Not a GitHub folder address."));
        return;
      }
      results.replaceChildren(el("p", { class: "dim" }, "Loading…"));
      try {
        const r = await loadGithubFolder(f);
        if (r.designs.length) {
          await this.services.importDesigns(r.designs);
          this.designs = await this.services.designs();
          this.outlines.clear();
        }
        results.replaceChildren(
          el(
            "p",
            { class: "dim" },
            `${r.scenarios.length} scenario(s)${r.designs.length ? `, ${r.designs.length} ship design(s) added to the library` : ""}${r.skipped.length ? `, ${r.skipped.length} file(s) skipped` : ""}.`,
          ),
          ...r.scenarios.map((s) => row(s, false, " · GitHub")),
          ...r.skipped.map((x) => el("p", { class: "dim" }, x)),
        );
      } catch (e) {
        results.replaceChildren(el("p", { class: "sc-problem" }, e instanceof Error ? e.message : String(e)));
      }
    });
    list.append(el("div", { class: "sc-github-row" }, url, load), results);
    list.append(el("h3", {}, "Tuning tests (test platforms; opens a copy)"));
    for (const t of TUNING_TESTS) list.append(row(t.scenario, true));
    list.append(el("h3", {}, "Game scenarios (opens a copy)"));
    for (const s of SCENARIOS) list.append(row(s, true));
    const close = el("button", { "data-testid": "sc-open-close" }, "Close");
    close.addEventListener("click", () => d.close());
    d.replaceChildren(el("h2", {}, "Open scenario"), list, el("div", { class: "actions" }, close));
    if (!d.open) d.showModal();
  }
}
