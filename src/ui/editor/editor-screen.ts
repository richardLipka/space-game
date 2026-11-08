import type { Application } from "pixi.js";
import type { PowerGroup, ShipDesign } from "../../data/schemas/design";
import type { Library } from "../../data/share/library";
import { librarySnapshot } from "../../data/share/library";
import { buildExport, encodeShareCode, prettyJson } from "../../data/share/bundle";
import { validateDesign } from "../../data/validate";
import { EditorModel, emptyDesign } from "../../editor/model";
import { findSnap, quantizeAngle, SNAP } from "../../editor/snap";
import type { Issue } from "../../editor/validate";
import {
  attachEdges,
  describePreview,
  ghostEdges,
  previewPlacement,
  type AttachEdges,
  type Contact,
  type Hint,
} from "../../editor/guide";
import type { PlacedEdge } from "../../sim/ship/layout";
import type { PartCatalogue, RuntimePartDef } from "../../sim/ship/catalogue";
import { type Vec2, degToRad, radToDeg, sub, add, rotate } from "../../sim/core/vec2";
import { Camera } from "../../render/camera";
import { EditorView, type EditorOverlays } from "../../render/editor-view";
import type { ThemeResolver } from "../../render/theme";
import { ImportDialog } from "./import-dialog";
import { LibraryDialog } from "./library-dialog";
import { el, fmt, partThumbnail } from "./dom";
import { matchesSearch, partInfoRows } from "./part-info";
import { connectionGraph } from "../../editor/graph";

export interface EditorServices {
  readonly library: Library;
  /** Core catalogue only (for export/import resolution). */
  core(): PartCatalogue;
  /** Core + user parts (for building and stats). */
  catalogue(): PartCatalogue;
  refreshCatalogue(): Promise<void>;
  newId(): string;
  now(): string;
  testFlight(design: ShipDesign): void;
  openSandbox(): void;
  /** Player squadron against an AI squadron (M6). */
  openSkirmish(): void;
  cycleTheme(): void;
  toast(message: string, kind?: "info" | "error"): void;
}

type Mode =
  | { kind: "idle" }
  | { kind: "placing"; def: RuntimePartDef; angle: number }
  | { kind: "dragging"; uid: string; grab: Vec2; angle: number; moved: boolean; downScreen: Vec2 };

/** Palette categories open by default (the player's choice is remembered afterwards). */
const DEFAULT_OPEN = ["command", "structure"];
const PREF_PREFIX = "space-game.palette.";
/** Per-viewer palette layout; storage may be unavailable (private window), so failures are ignored. */
function loadPref(key: string): string | null {
  try {
    return localStorage.getItem(PREF_PREFIX + key);
  } catch {
    return null;
  }
}
function savePref(key: string, value: string): void {
  try {
    localStorage.setItem(PREF_PREFIX + key, value);
  } catch {
    /* ignore */
  }
}

const CATEGORY_ORDER = [
  "command",
  "structure",
  "armor",
  "propulsion",
  "storage",
  "power",
  "thermal",
  "weapon",
  "hangar",
];
const ROTATE_SPEED = degToRad(90);
const LAST_DESIGN_KEY = "space-game.lastDesignId";

function pointInPolygon(p: Vec2, poly: readonly Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!,
      b = poly[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Ship editor screen (spec §3.5): palette, canvas interaction, stats, issues, groups, power, library, sharing. */
export class EditorScreen {
  readonly model: EditorModel;
  private readonly view: EditorView;
  readonly camera = new Camera();
  private readonly root: HTMLElement;
  private mode: Mode = { kind: "idle" };
  readonly selected = new Set<string>();
  private highlighted = new Set<string>();
  private mouseScreen: Vec2 = { x: 0, y: 0 };
  private ghost: {
    def: RuntimePartDef;
    position: Vec2;
    angle: number;
    valid: boolean;
    snapped: boolean;
  } | null = null;
  private readonly held = new Set<string>();
  private altHeld = false;
  private rotating = false;
  /** Connection guidance while placing/dragging (drawn by the view, explained in the status line). */
  private guide: {
    attach: AttachEdges;
    ghostEdges: readonly PlacedEdge[];
    contacts: readonly Contact[];
  } | null = null;
  private hint: Hint | null = null;
  private attachCache: { design: ShipDesign; edges: AttachEdges } | null = null;
  private active = false;
  private panelKey = "";
  readonly overlays: EditorOverlays = {
    com: true,
    thrust: true,
    arcs: false,
    networks: false,
    exposed: false,
    connections: false,
    graph: false,
  };
  private readonly overlayBoxes = new Map<keyof EditorOverlays, HTMLInputElement>();
  private readonly importDialog: ImportDialog;
  private readonly libraryDialog: LibraryDialog;
  private readonly ui: Record<string, HTMLElement> = {};
  /** Palette row the info card belongs to. */
  private infoAnchor: HTMLElement | null = null;
  /** Current palette search text. */
  private paletteQuery = "";
  /** True when the design differs from the saved library copy. */
  dirty = false;

  constructor(
    app: Application,
    theme: ThemeResolver,
    private readonly canvas: HTMLCanvasElement,
    private readonly services: EditorServices,
    initial: ShipDesign,
  ) {
    this.model = new EditorModel(services.catalogue(), initial, services.now);
    this.view = new EditorView(theme, app);
    this.root = this.buildDom();
    document.body.appendChild(this.root);
    this.importDialog = new ImportDialog(services, (d) => this.loadDesign(d));
    this.libraryDialog = new LibraryDialog(services, (d) => this.loadDesign(d));
    this.attachInput();
    window.addEventListener("resize", () => this.syncToolbarHeight());
    this.camera.mode = "free";
    this.camera.zoom = 40;
    this.rebuildPalette();
  }

  // ---------- lifecycle ----------
  /** Panels start below the toolbar, which may wrap onto two rows on narrow windows. */
  private syncToolbarHeight(): void {
    const bar = this.root.querySelector(".ed-toolbar") as HTMLElement | null;
    if (bar) this.root.style.setProperty("--toolbar-h", `${bar.offsetHeight}px`);
  }

  show(): void {
    this.active = true;
    this.root.hidden = false;
    this.syncToolbarHeight();
    this.view.visible = true;
    this.panelKey = "";
  }

  hide(): void {
    this.active = false;
    this.root.hidden = true;
    this.view.visible = false;
    this.cancelMode();
  }

  loadDesign(d: ShipDesign): void {
    this.model.catalogue = this.services.catalogue();
    this.model.load(d);
    this.selected.clear();
    this.cancelMode();
    this.dirty = false;
    this.rebuildPalette();
    this.fitView();
    this.panelKey = "";
  }

  onCatalogueChanged(): void {
    this.model.catalogue = this.services.catalogue();
    this.rebuildPalette();
    this.panelKey = "";
  }

  // ---------- DOM ----------
  private button(label: string, testid: string, onClick: () => void, title = ""): HTMLButtonElement {
    const b = el("button", { "data-testid": testid, title }, label) as HTMLButtonElement;
    b.addEventListener("click", (e) => {
      e.preventDefault();
      onClick();
      b.blur();
    });
    return b;
  }

  private buildDom(): HTMLElement {
    const name = el("input", {
      class: "ed-name",
      "data-testid": "design-name",
      maxlength: "80",
      spellcheck: "false",
    }) as HTMLInputElement;
    name.addEventListener("change", () => {
      if (name.value.trim()) this.edit(() => this.model.rename(name.value.trim()));
    });
    this.ui.name = name;
    const mirror = this.button("Mirror", "btn-mirror", () => this.toggleMirror(), "Mirror mode (M)");
    this.ui.mirror = mirror;
    const overlays = el("details", { class: "ed-overlays" }, el("summary", {}, "Overlays"));
    for (const [k, label] of Object.entries({
      com: "Centre of mass",
      thrust: "Thrust & gimbal",
      arcs: "Turret arcs",
      networks: "Networks",
      exposed: "Exposed edges",
      connections: "Connections",
      graph: "Connection graph (G)",
    })) {
      const cb = el("input", { type: "checkbox", "data-testid": `overlay-${k}` }) as HTMLInputElement;
      cb.checked = this.overlays[k as keyof EditorOverlays];
      this.overlayBoxes.set(k as keyof EditorOverlays, cb);
      cb.addEventListener("change", () => {
        this.overlays[k as keyof EditorOverlays] = cb.checked;
        this.panelKey = "";
      });
      overlays.append(el("label", {}, cb, ` ${label}`));
    }
    const exportMenu = el(
      "details",
      { class: "ed-menu" },
      el("summary", { "data-testid": "btn-export" }, "Export"),
    );
    exportMenu.append(
      this.button("Download file", "btn-export-file", () => void this.exportDesign("file")),
      this.button("Copy JSON", "btn-copy-json", () => void this.exportDesign("json")),
      this.button("Copy share code", "btn-copy-code", () => void this.exportDesign("code")),
      this.button(
        "Download archival file",
        "btn-export-archival",
        () => void this.exportDesign("file", true),
      ),
    );
    // Close the menu once an item is chosen.
    exportMenu.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest("button")) exportMenu.removeAttribute("open");
    });
    const toolbar = el(
      "header",
      { class: "ed-toolbar" },
      el("span", { class: "ed-title" }, "SHIP EDITOR"),
      name,
      this.button("New", "btn-new", () => this.newDesign()),
      this.button("Library", "btn-library", () => void this.libraryDialog.open()),
      this.button("Save", "btn-save", () => void this.save(), "Save to library (Ctrl+S)"),
      exportMenu,
      this.button("Import", "btn-import", () => this.importDialog.open("")),
      el("span", { class: "ed-sep" }),
      this.button("↶", "btn-undo", () => this.edit(() => this.model.undo()), "Undo (Ctrl+Z)"),
      this.button("↷", "btn-redo", () => this.edit(() => this.model.redo()), "Redo (Ctrl+Y)"),
      mirror,
      overlays,
      el("span", { class: "ed-sep" }),
      this.button("Test flight", "btn-test-flight", () => this.testFlight()),
      this.button("Sandbox", "btn-sandbox", () => this.services.openSandbox()),
      this.button(
        "Skirmish",
        "btn-skirmish",
        () => this.services.openSkirmish(),
        "Your two ships against an AI squadron",
      ),
      this.button("Theme", "btn-theme", () => this.services.cycleTheme()),
    );
    this.ui.palette = el("aside", { class: "ed-palette", "data-testid": "palette" });
    this.ui.stats = el("section", { class: "ed-stats", "data-testid": "stats" });
    this.ui.issues = el("section", { class: "ed-issues", "data-testid": "issues" });
    this.ui.groups = el("section", { class: "ed-groups", "data-testid": "groups" });
    this.ui.graph = el("section", { class: "ed-graph", "data-testid": "graph-panel" });
    this.ui.power = el("section", { class: "ed-power", "data-testid": "power" });
    const side = el(
      "aside",
      { class: "ed-side" },
      this.ui.stats,
      this.ui.issues,
      this.ui.graph,
      this.ui.groups,
      this.ui.power,
    );
    this.ui.status = el("div", { class: "ed-status" });
    this.ui.partInfo = el("section", { class: "ed-partinfo", "data-testid": "part-info", hidden: "" });
    return el(
      "div",
      { class: "editor", id: "editor" },
      toolbar,
      this.ui.palette,
      side,
      this.ui.status,
      this.ui.partInfo,
    );
  }

  /** How parts connect, always visible above the palette. */
  private edgeLegend(): HTMLElement {
    const line = (cls: string) => el("span", { class: `legend-line ${cls}` });
    return el(
      "div",
      { class: "edge-legend", "data-testid": "edge-legend" },
      el("h3", {}, "How parts connect"),
      el(
        "div",
        {},
        line("snap"),
        " attach edge: connects when it lies on another attach edge (≥ 0.25 m shared)",
      ),
      el("div", {}, line("hull"), " outer hull: nothing may attach"),
      el("div", {}, line("function"), " functional (nozzle, radiator, muzzle): keep exposed"),
      el("p", { class: "dim" }, "While placing, green edges on the ship show where a part can connect."),
    );
  }

  private rebuildPalette(): void {
    const pal = this.ui.palette!;
    const search = el("input", {
      class: "ed-search",
      type: "search",
      placeholder: "Search parts…",
      "data-testid": "palette-search",
      "aria-label": "Search parts",
    }) as HTMLInputElement;
    search.value = this.paletteQuery;
    const list = el("div", { class: "ed-part-list" });
    const legend = el("details", { class: "edge-legend-box" }, el("summary", {}, "How parts connect"));
    legend.append(this.edgeLegend());
    if (loadPref("legend") !== "closed") (legend as HTMLDetailsElement).open = true;
    legend.addEventListener("toggle", () =>
      savePref("legend", (legend as HTMLDetailsElement).open ? "open" : "closed"),
    );
    pal.replaceChildren(legend, search, list);
    list.addEventListener("scroll", () => this.placePartInfo(), { passive: true });
    search.addEventListener("input", () => {
      this.paletteQuery = search.value;
      this.fillPartList(list);
    });
    search.addEventListener("keydown", (e) => {
      e.stopPropagation(); // typing must not trigger editor shortcuts
      if (e.key === "Escape") {
        search.value = "";
        this.paletteQuery = "";
        this.fillPartList(list);
        search.blur();
      }
    });
    this.fillPartList(list);
    this.showPartInfo(null);
  }

  /** Category accordion; a non-empty search shows every match with its category open. */
  private fillPartList(list: HTMLElement): void {
    const query = this.paletteQuery.trim();
    const groups = new Map<string, RuntimePartDef[]>();
    for (const p of this.services.catalogue().all()) {
      if (query && !matchesSearch(p.def, query)) continue;
      const cat = p.def.source === "user" ? "user parts" : p.def.category;
      if (!groups.has(cat)) groups.set(cat, []);
      groups.get(cat)!.push(p);
    }
    const order = [...CATEGORY_ORDER, "user parts"];
    const open = new Set((loadPref("open") ?? DEFAULT_OPEN.join(",")).split(",").filter(Boolean));
    list.replaceChildren();
    if (groups.size === 0) list.append(el("p", { class: "dim" }, `No parts match "${query}".`));
    for (const cat of [...groups.keys()].sort((a, b) => order.indexOf(a) - order.indexOf(b))) {
      const items = groups.get(cat)!.sort((a, b) => a.def.name.localeCompare(b.def.name));
      const box = el("details", {
        class: "ed-cat",
        "data-testid": `palette-cat-${cat}`,
      }) as HTMLDetailsElement;
      box.open = query !== "" || open.has(cat);
      box.append(el("summary", {}, cat, el("span", { class: "ed-cat-count" }, String(items.length))));
      box.addEventListener("toggle", () => {
        if (query) return; // search results do not change the remembered layout
        if (box.open) open.add(cat);
        else open.delete(cat);
        savePref("open", [...open].join(","));
      });
      for (const p of items) {
        const item = el("button", {
          class: "ed-part",
          "data-testid": `palette-${p.id}`,
          title: p.id,
        });
        item.append(
          partThumbnail(p),
          el("span", { class: "ed-part-name" }, p.def.name),
          el("span", { class: "ed-part-cost" }, String(p.def.cost)),
        );
        item.addEventListener("click", () => {
          this.startPlacing(p);
          item.blur();
        });
        item.addEventListener("mouseenter", () => this.showPartInfo(p, item));
        item.addEventListener("mouseleave", () => this.showPartInfo(null));
        box.append(item);
      }
      list.append(box);
    }
  }

  /**
   * Floating card beside the palette with the hovered part's key numbers. It sits over the canvas, next
   * to the hovered row, and ignores the mouse, so it never covers or shifts the palette list.
   */
  private showPartInfo(p: RuntimePartDef | null, anchor?: HTMLElement): void {
    const box = this.ui.partInfo;
    if (!box) return;
    if (!p || !anchor) {
      box.hidden = true;
      this.infoAnchor = null;
      return;
    }
    box.replaceChildren(el("h3", {}, p.def.name));
    for (const [k, v] of partInfoRows(p.def))
      box.append(el("div", { class: "row" }, el("span", {}, k), el("b", {}, v)));
    this.infoAnchor = anchor;
    box.hidden = false;
    this.placePartInfo();
  }

  /** Keeps the info card next to its palette row (after scrolling); hides it if the row scrolled away. */
  private placePartInfo(): void {
    const box = this.ui.partInfo;
    const anchor = this.infoAnchor;
    if (!box || box.hidden || !anchor) return;
    const row = anchor.getBoundingClientRect();
    const list = anchor.closest(".ed-part-list")?.getBoundingClientRect();
    if (!anchor.isConnected || (list && (row.bottom < list.top || row.top > list.bottom))) {
      box.hidden = true;
      return;
    }
    const root = box.parentElement!.getBoundingClientRect();
    const pal = this.ui.palette!.getBoundingClientRect();
    const maxTop = root.height - 28 - box.offsetHeight - 4; // stay above the status line
    box.style.left = `${pal.right - root.left + 8}px`;
    box.style.top = `${Math.max(4, Math.min(maxTop, row.top - root.top))}px`;
  }

  private renderPanels(): void {
    const m = this.model;
    const key = `${this.overlays.graph}|${m.design.modifiedAt}|${m.design.parts.length}|${[...this.selected].join()}|${m.mirror}|${this.dirty}|${m.catalogue.version}`;
    if (key === this.panelKey) return;
    this.panelKey = key;
    const name = this.ui.name as HTMLInputElement;
    if (document.activeElement !== name) name.value = m.design.name;
    this.ui.mirror!.classList.toggle("on", m.mirror);

    const s = m.stats;
    const stats = this.ui.stats!;
    stats.replaceChildren(el("h3", {}, `Stats${this.dirty ? " •" : ""}`));
    const row = (label: string, value: string, id: string) =>
      stats.append(
        el("div", { class: "row" }, el("span", {}, label), el("b", { "data-testid": `stat-${id}` }, value)),
      );
    if (!s) {
      stats.append(
        el("p", { class: "dim" }, "Pick a part from the palette to start. A ship needs a command module."),
      );
    } else {
      row("Parts", String(s.partCount), "parts");
      row("Cost", String(s.cost), "cost");
      row("Class", `${s.shipClass} · ${s.length.toFixed(1)} m`, "class");
      row("Mass", fmt.mass(s.mass), "mass");
      row("Inertia", `${s.inertia.toExponential(2)} kg·m²`, "inertia");
      row("Accel fwd / back", `${s.accel.fwd.toFixed(1)} / ${s.accel.back.toFixed(1)} m/s²`, "accel-fb");
      row("Accel left / right", `${s.accel.left.toFixed(1)} / ${s.accel.right.toFixed(1)} m/s²`, "accel-lr");
      row("Turn 180°", Number.isFinite(s.turn180) ? `${s.turn180.toFixed(1)} s` : "—", "turn");
      row("Fuel / Δv", `${fmt.mass(s.fuel.capacity)} · ${s.fuel.deltaV.toFixed(0)} m/s`, "dv");
      const demand = Object.values(s.power.demand).reduce((a, b) => a + b, 0);
      row("Power", `${fmt.watts(s.power.production)} / ${fmt.watts(demand)} demand`, "power");
      row("Heat at full", `${fmt.watts(s.heat.generation)} vs ${fmt.watts(s.heat.dissipation)} out`, "heat");
      row(
        "  shed by",
        `hull ${fmt.watts(s.heat.hull)} · radiators ${fmt.watts(s.heat.radiators)}`,
        "heat-shed",
      );
      const ammo = Object.entries(s.ammo);
      if (ammo.length) row("Ammo", ammo.map(([t, n]) => `${t} ${n}`).join(", "), "ammo");
    }

    const report = m.report;
    const issues = this.ui.issues!;
    issues.replaceChildren(
      el(
        "h3",
        {},
        `Issues `,
        el("span", { "data-testid": "issue-count" }, `${report.errors} errors · ${report.warnings} warnings`),
      ),
    );
    for (const issue of report.issues) {
      const li = el("div", { class: `issue ${issue.severity}`, "data-code": issue.code }, issue.message);
      li.addEventListener("mouseenter", () => (this.highlighted = new Set(issue.parts)));
      li.addEventListener("mouseleave", () => (this.highlighted = new Set()));
      li.addEventListener("click", () => this.selectParts(issue.parts));
      issues.append(li);
    }

    this.renderGraph();
    this.renderGroups();
    this.renderPower();
    this.updateStatus();
  }

  setOverlay(k: keyof EditorOverlays, on: boolean): void {
    this.overlays[k] = on;
    const cb = this.overlayBoxes.get(k);
    if (cb) cb.checked = on;
    this.panelKey = "";
  }

  /** Legend and supply problems for the connection graph overlay (shown only while it is on). */
  private renderGraph(): void {
    const box = this.ui.graph!;
    box.hidden = !this.overlays.graph;
    if (!this.overlays.graph) return;
    const m = this.model;
    box.replaceChildren(el("h3", {}, "Connection graph"));
    // Swatches use the theme's own classes, so they match the canvas colours in every theme.
    const lane = (cls: string, label: string) =>
      el("div", {}, el("span", { class: `legend-line graph-swatch ${cls}` }), ` ${label}`);
    box.append(
      lane("graph-flow flow-power", "power"),
      lane("graph-flow flow-fuel", "fuel"),
      lane("graph-flow flow-ammo", "ammunition"),
      lane("graph-edge structural", "structure only (part does not conduct)"),
      el("p", { class: "dim" }, "Each consumer is fed from the nearest source along the fewest connections."),
    );
    if (m.design.parts.length === 0) return;
    const graph = connectionGraph(m.layout);
    const name = (uid: string) => m.layout.parts.find((p) => p.uid === uid)?.def.def.name ?? uid;
    if (graph.unsupplied.length === 0) {
      box.append(el("p", { class: "ok", "data-testid": "graph-ok" }, "✓ Every part gets what it needs."));
      return;
    }
    const list = el("div", {});
    for (const u of graph.unsupplied) {
      const li = el(
        "div",
        { class: "issue warning", "data-testid": "graph-unsupplied" },
        `${name(u.uid)}: ${u.detail}`,
      );
      li.addEventListener("mouseenter", () => (this.highlighted = new Set([u.uid])));
      li.addEventListener("mouseleave", () => (this.highlighted = new Set()));
      li.addEventListener("click", () => this.selectParts([u.uid]));
      list.append(li);
    }
    box.append(list);
  }

  private renderGroups(): void {
    const m = this.model;
    const box = this.ui.groups!;
    box.replaceChildren(el("h3", {}, "Weapon groups"));
    const weapons = m.design.parts.filter(
      (p) => m.catalogue.get(p.partId).def.weapon && m.catalogue.get(p.partId).def.weapon!.kind !== "pd",
    );
    if (weapons.length === 0) {
      box.append(el("p", { class: "dim" }, "No group weapons. Point defense is always automatic."));
      return;
    }
    const used = [
      ...new Set(weapons.map((w) => w.weaponGroup).filter((g): g is number => g !== undefined)),
    ].sort();
    for (const g of used) {
      const sel = el("select", { "data-testid": `group-mode-${g}` }) as HTMLSelectElement;
      for (const mode of ["manual", "hold", "ai"]) sel.append(el("option", { value: mode }, mode));
      sel.value = m.design.weaponGroupModes[String(g)] ?? "manual";
      sel.addEventListener("change", () =>
        this.edit(() => m.setGroupMode(g, sel.value as "hold" | "manual" | "ai")),
      );
      box.append(
        el(
          "div",
          { class: "row" },
          el("span", {}, `Group ${g} · ${weapons.filter((w) => w.weaponGroup === g).length} weapon(s)`),
          sel,
        ),
      );
    }
    const unassigned = weapons.filter((w) => w.weaponGroup === undefined).length;
    box.append(
      el(
        "p",
        { class: "dim" },
        `${unassigned ? `${unassigned} unassigned. ` : ""}Select a weapon and press 1–9 (0 clears).`,
      ),
    );
  }

  private renderPower(): void {
    const m = this.model;
    const box = this.ui.power!;
    box.replaceChildren(el("h3", {}, "Power priority"));
    const order = m.design.powerPriority as PowerGroup[];
    order.forEach((g, i) => {
      const up = this.button("▲", `power-up-${g}`, () => {
        if (i === 0) return;
        const next = [...order];
        [next[i - 1], next[i]] = [next[i]!, next[i - 1]!];
        this.edit(() => m.setPowerPriority(next));
      });
      box.append(el("div", { class: "row" }, el("span", {}, `${i + 1}. ${g}`), up));
    });
  }

  private updateStatus(): void {
    if (this.hint) return;
    const sel = [...this.selected];
    const m = this.model;
    let text =
      "Click a part in the palette, then click to place · Q/E rotate (Shift: 15°) · Alt: no snap · M mirror · G graph · Del delete · Ctrl+Z undo · F fit";
    if (this.mode.kind === "placing")
      text = `Placing ${this.mode.def.def.name} · ${radToDeg(this.mode.angle).toFixed(0)}° · click to place, Esc/right-click to stop`;
    else if (sel.length === 1) {
      const p = m.design.parts.find((x) => x.uid === sel[0]);
      if (p) {
        const d = m.catalogue.get(p.partId).def;
        text = `${d.name} (${p.uid}) · ${p.angle.toFixed(1)}° · mass ${fmt.mass(d.mass)} · hp ${d.hp}${d.weapon ? ` · group ${p.weaponGroup ?? "—"}` : ""}`;
      }
    } else if (sel.length > 1) text = `${sel.length} parts selected`;
    this.ui.status!.textContent = text;
  }

  // ---------- actions ----------
  /** Runs an edit, marks dirty and refreshes panels. */
  private edit(fn: () => unknown): void {
    fn();
    this.dirty = true;
    this.panelKey = "";
    for (const uid of [...this.selected])
      if (!this.model.design.parts.some((p) => p.uid === uid)) this.selected.delete(uid);
  }

  private toggleMirror(): void {
    this.model.mirror = !this.model.mirror;
    this.panelKey = "";
  }

  newDesign(): void {
    if (this.dirty && this.model.design.parts.length && !confirm("Discard unsaved changes?")) return;
    this.loadDesign(emptyDesign(this.services.newId(), "New ship", this.services.now()));
    this.camera.center = { x: 0, y: 0 };
    this.camera.zoom = 40;
  }

  private savableDesign(): ShipDesign | null {
    const r = validateDesign(this.model.design);
    if (!r.ok) {
      this.services.toast(
        this.model.design.parts.length === 0 ? "Add at least one part first." : `Cannot save: ${r.errors[0]}`,
        "error",
      );
      return null;
    }
    return r.value;
  }

  async save(): Promise<void> {
    const d = this.savableDesign();
    if (!d) return;
    await this.services.library.putDesign(d);
    try {
      localStorage.setItem(LAST_DESIGN_KEY, d.id);
    } catch {
      /* storage may be unavailable */
    }
    this.dirty = false;
    this.panelKey = "";
    this.services.toast(`Saved “${d.name}”`);
  }

  private async exportDesign(kind: "file" | "json" | "code", archival = false): Promise<void> {
    const d = this.savableDesign();
    const s = this.model.stats;
    if (!d || !s) return;
    const snap = await librarySnapshot(this.services.library);
    const designs = new Map(snap.designs);
    designs.set(d.id, d);
    let bundle;
    try {
      bundle = buildExport(
        [d],
        { core: this.services.core(), userParts: snap.userParts, designs },
        {
          archival,
          summary: { cost: s.cost, mass: s.mass, class: s.shipClass, partCount: s.partCount },
        },
      );
    } catch (e) {
      this.services.toast(`Export failed: ${(e as Error).message}`, "error");
      return;
    }
    if (kind === "file") {
      const blob = new Blob([prettyJson(bundle)], { type: "application/json" });
      const a = el("a", {
        href: URL.createObjectURL(blob),
        download: `${d.name.replace(/[^\w.-]+/g, "_") || "ship"}.ship.json`,
      }) as HTMLAnchorElement;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      this.services.toast("Ship file downloaded");
    } else {
      const text = kind === "json" ? prettyJson(bundle) : encodeShareCode(bundle);
      try {
        await navigator.clipboard.writeText(text);
        this.services.toast(
          kind === "json" ? "Ship JSON copied" : `Share code copied (${text.length} chars)`,
        );
      } catch {
        this.importDialog.showText(text, kind === "json" ? "Ship JSON" : "Share code");
      }
    }
  }

  private testFlight(): void {
    const d = this.savableDesign();
    if (!d) return;
    const errors = this.model.report.issues.filter((i: Issue) => i.severity === "error");
    if (errors.length) {
      this.services.toast(`Fix ${errors.length} error(s) before test flight: ${errors[0]!.message}`, "error");
      return;
    }
    this.services.testFlight(d);
  }

  private selectParts(uids: readonly string[]): void {
    this.selected.clear();
    for (const u of uids) this.selected.add(u);
    this.panelKey = "";
  }

  private startPlacing(def: RuntimePartDef): void {
    const angle = this.mode.kind === "placing" ? this.mode.angle : 0;
    this.cancelMode();
    this.selected.clear();
    this.mode = { kind: "placing", def, angle };
    this.panelKey = "";
  }

  private cancelMode(): void {
    if (this.mode.kind === "dragging") this.model.cancelDrag();
    this.mode = { kind: "idle" };
    this.ghost = null;
    this.clearGuide();
  }

  fitView(): void {
    const layout = this.model.layout;
    if (layout.parts.length === 0) {
      this.camera.center = { x: 0, y: 0 };
      return;
    }
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const box of layout.aabbs.values()) {
      minX = Math.min(minX, box.minX);
      minY = Math.min(minY, box.minY);
      maxX = Math.max(maxX, box.maxX);
      maxY = Math.max(maxY, box.maxY);
    }
    this.camera.center = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
    const w = Math.max(this.camera.width - 560, 200);
    const h = Math.max(this.camera.height - 120, 200);
    this.camera.zoom = Math.max(2, Math.min(80, Math.min(w / (maxX - minX + 6), h / (maxY - minY + 6))));
  }

  // ---------- input ----------
  private worldMouse(): Vec2 {
    return this.camera.screenToWorld(this.mouseScreen);
  }

  private hitPart(p: Vec2): string | null {
    const layout = this.model.layout;
    for (const part of [...layout.parts].reverse()) {
      for (const piece of layout.pieces.get(part.uid)!) if (pointInPolygon(p, piece)) return part.uid;
    }
    return null;
  }

  private attachInput(): void {
    const c = this.canvas;
    c.addEventListener("mousemove", (e) => {
      if (!this.active) return;
      this.mouseScreen = { x: e.offsetX, y: e.offsetY };
      if (e.buttons & 4) this.camera.pan(e.movementX, e.movementY);
      this.altHeld = e.altKey;
      this.updateGhostOrDrag();
    });
    c.addEventListener("mousedown", (e) => {
      if (!this.active) return;
      this.mouseScreen = { x: e.offsetX, y: e.offsetY };
      if (e.button === 1) return e.preventDefault();
      if (e.button !== 0) return;
      const m = this.mode;
      if (m.kind === "placing") {
        this.updateGhostOrDrag();
        const g = this.ghost;
        // Stays in placing mode so several copies can be placed; Esc or right-click stops.
        if (g && g.valid) {
          this.model.addPart(g.def.id, g.position.x, g.position.y, g.angle);
          this.dirty = true;
          this.panelKey = "";
        }
        return;
      }
      const hit = this.hitPart(this.worldMouse());
      if (!hit) {
        this.selected.clear();
        this.panelKey = "";
        return;
      }
      if (e.shiftKey) {
        if (this.selected.has(hit)) this.selected.delete(hit);
        else this.selected.add(hit);
        this.panelKey = "";
        return;
      }
      if (!this.selected.has(hit)) this.selectParts([hit]);
      const pl = this.model.design.parts.find((p) => p.uid === hit)!;
      this.mode = {
        kind: "dragging",
        uid: hit,
        grab: sub({ x: pl.x, y: pl.y }, this.worldMouse()),
        angle: degToRad(pl.angle),
        moved: false,
        downScreen: this.mouseScreen,
      };
      this.model.beginDrag();
    });
    window.addEventListener("mouseup", () => {
      if (!this.active || this.mode.kind !== "dragging") return;
      if (this.mode.moved) {
        this.model.endDrag();
        this.dirty = true;
      } else this.model.cancelDrag();
      this.mode = { kind: "idle" };
      this.clearGuide();
      this.panelKey = "";
    });
    c.addEventListener(
      "wheel",
      (e) => {
        if (!this.active) return;
        e.preventDefault();
        const before = this.worldMouse();
        this.camera.zoom = Math.max(2, Math.min(120, this.camera.zoom * Math.pow(1.0015, -e.deltaY)));
        const after = this.worldMouse();
        this.camera.center = add(this.camera.center, sub(before, after));
      },
      { passive: false },
    );
    c.addEventListener("contextmenu", (e) => {
      if (!this.active) return;
      e.preventDefault();
      if (this.mode.kind !== "idle") this.cancelMode();
      else this.selected.clear();
      this.panelKey = "";
    });
    window.addEventListener("keydown", (e) => this.onKey(e, true));
    window.addEventListener("keyup", (e) => this.onKey(e, false));
    window.addEventListener("blur", () => this.held.clear());
    document.addEventListener("paste", (e) => {
      if (!this.active || this.isTyping(e.target)) return;
      const text = e.clipboardData?.getData("text") ?? "";
      if (text.trim()) {
        e.preventDefault();
        this.importDialog.open(text);
      }
    });
    document.addEventListener("dragover", (e) => {
      if (this.active) e.preventDefault();
    });
    document.addEventListener("drop", (e) => {
      if (!this.active) return;
      e.preventDefault();
      const file = e.dataTransfer?.files?.[0];
      if (file) void file.text().then((t) => this.importDialog.open(t, file.name));
      else {
        const text = e.dataTransfer?.getData("text");
        if (text) this.importDialog.open(text);
      }
    });
  }

  private isTyping(target: EventTarget | null): boolean {
    return !!(target as HTMLElement | null)?.closest?.("input, textarea, select, dialog[open]");
  }

  private onKey(e: KeyboardEvent, down: boolean): void {
    if (!this.active || this.isTyping(e.target)) return;
    const k = e.key.toLowerCase();
    this.altHeld = e.altKey;
    if (!down) {
      this.held.delete(k);
      // Holding Q/E on a selected part is one undo step, committed on release.
      if (this.rotating && !this.held.has("q") && !this.held.has("e")) {
        this.model.endDrag();
        this.rotating = false;
      }
      return;
    }
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && k === "z") {
      e.preventDefault();
      this.edit(() => (e.shiftKey ? this.model.redo() : this.model.undo()));
      return;
    }
    if (ctrl && k === "y") {
      e.preventDefault();
      this.edit(() => this.model.redo());
      return;
    }
    if (ctrl && k === "s") {
      e.preventDefault();
      void this.save();
      return;
    }
    if (ctrl) return;
    switch (k) {
      case "escape":
        this.cancelMode();
        this.selected.clear();
        this.panelKey = "";
        break;
      case "delete":
      case "backspace":
        if (this.selected.size) {
          this.edit(() => this.model.removeParts([...this.selected]));
          this.selected.clear();
        }
        break;
      case "m":
        this.toggleMirror();
        break;
      case "g":
        this.setOverlay("graph", !this.overlays.graph);
        break;
      case "f":
        this.fitView();
        break;
      case "t":
        this.services.cycleTheme();
        break;
      case "q":
      case "e":
        if (e.shiftKey) this.rotateStep(k === "q" ? 1 : -1);
        else this.held.add(k);
        e.preventDefault();
        break;
      default:
        if (/^[0-9]$/.test(k)) {
          const group = Number(k) || undefined;
          const weapons = [...this.selected].filter((u) => {
            const p = this.model.design.parts.find((x) => x.uid === u);
            return p && this.model.catalogue.get(p.partId).def.weapon;
          });
          if (weapons.length) this.edit(() => weapons.forEach((u) => this.model.setWeaponGroup(u, group)));
        }
    }
  }

  private rotateStep(dir: number): void {
    const step = degToRad(SNAP.rotationStepDeg) * dir;
    if (this.mode.kind === "placing") {
      this.mode.angle = quantizeAngle(this.mode.angle + step);
      this.updateGhostOrDrag();
      this.panelKey = "";
    } else if (this.selected.size === 1) {
      const uid = [...this.selected][0]!;
      const pl = this.model.design.parts.find((p) => p.uid === uid)!;
      this.edit(() => {
        this.model.beginDrag();
        this.model.dragTo(uid, pl.x, pl.y, quantizeAngle(degToRad(pl.angle) + step));
        this.model.endDrag();
      });
    }
  }

  private updateGhostOrDrag(): void {
    const m = this.mode;
    const mouse = this.worldMouse();
    if (m.kind === "placing") {
      const layout = this.model.layout;
      const snap = this.altHeld ? null : findSnap(layout, m.def, mouse, m.angle);
      const position = snap?.position ?? mouse;
      const angle = snap?.angle ?? m.angle;
      const preview = previewPlacement(layout, m.def, position, angle);
      const valid = !preview.overlaps;
      this.ghost = { def: m.def, position, angle, valid, snapped: !!snap };
      this.guide = {
        attach: this.freeAttachEdges(),
        ghostEdges: ghostEdges(m.def, position, angle),
        contacts: preview.contacts,
      };
      this.setHint(describePreview(preview, this.model.design.parts.length === 0, m.def.def.name));
    } else if (m.kind === "dragging") {
      const def = this.model.catalogue.get(this.model.design.parts.find((p) => p.uid === m.uid)!.partId);
      const target = add(mouse, m.grab);
      // Small jitter on click is not a drag.
      if (
        !m.moved &&
        Math.hypot(this.mouseScreen.x - m.downScreen.x, this.mouseScreen.y - m.downScreen.y) < 4
      )
        return;
      m.moved = true;
      // Snap against everything except the dragged part (layout from the drag base).
      const exclude = new Set([m.uid]);
      const snap = this.altHeld ? null : findSnap(this.model.layout, def, target, m.angle, exclude);
      this.model.dragTo(
        m.uid,
        snap?.position.x ?? target.x,
        snap?.position.y ?? target.y,
        snap?.angle ?? m.angle,
      );
      this.panelKey = "";
      const pl = this.model.design.parts.find((p) => p.uid === m.uid)!;
      const pos = { x: pl.x, y: pl.y };
      const ang = degToRad(pl.angle);
      const preview = previewPlacement(this.model.layout, def, pos, ang, exclude);
      this.guide = {
        attach: attachEdges(this.model.layout, exclude),
        ghostEdges: ghostEdges(def, pos, ang),
        contacts: preview.contacts,
      };
      this.setHint(describePreview(preview, this.model.design.parts.length === 1, def.def.name));
    } else {
      this.ghost = null;
      this.clearGuide();
    }
  }

  /** Free attach edges for the current design (memoised; placing does not change the design). */
  private freeAttachEdges(): AttachEdges {
    const d = this.model.design;
    if (this.attachCache?.design !== d)
      this.attachCache = { design: d, edges: attachEdges(this.model.layout) };
    return this.attachCache.edges;
  }

  private setHint(h: Hint | null): void {
    this.hint = h;
    const st = this.ui.status!;
    if (h) {
      st.textContent = h.text;
      st.dataset.level = h.level;
    } else {
      delete st.dataset.level;
      this.updateStatus();
    }
  }

  private clearGuide(): void {
    this.guide = null;
    if (this.hint) this.setHint(null);
  }

  private disconnectedParts(): ReadonlySet<string> {
    return new Set(this.model.report.issues.filter((i) => i.code === "disconnected").flatMap((i) => i.parts));
  }

  // ---------- frame ----------
  frame(dt: number, width: number, height: number): void {
    if (!this.active) return;
    this.camera.resize(width, height);
    const dir = (this.held.has("q") ? 1 : 0) - (this.held.has("e") ? 1 : 0);
    if (dir !== 0) {
      if (this.mode.kind === "placing") {
        this.mode.angle += dir * ROTATE_SPEED * dt;
        this.updateGhostOrDrag();
        this.panelKey = "";
      } else if (this.selected.size === 1 && this.mode.kind === "idle") {
        const uid = [...this.selected][0]!;
        const pl = this.model.design.parts.find((p) => p.uid === uid);
        if (pl) {
          if (!this.rotating) {
            this.model.beginDrag();
            this.rotating = true;
          }
          this.model.dragTo(uid, pl.x, pl.y, degToRad(pl.angle) + dir * ROTATE_SPEED * dt);
          this.dirty = true;
          this.panelKey = "";
        }
      }
    }
    this.renderPanels();
    this.view.render(this.model, this.camera, {
      ghost: this.mode.kind === "placing" ? this.ghost : null,
      selected: this.selected,
      highlighted: this.highlighted,
      overlays: this.overlays,
      disconnected: this.disconnectedParts(),
      guide: this.mode.kind === "idle" ? null : this.guide,
    });
  }

  // ---------- test helpers ----------
  /** Screen point at `distance` metres outward from the midpoint of a part's edge. */
  attachPoint(uid: string, edgeIndex: number, distance: number): Vec2 {
    const e = this.model.layout.edges.get(uid)![edgeIndex]!;
    const mid = { x: (e.a.x + e.b.x) / 2, y: (e.a.y + e.b.y) / 2 };
    return this.camera.worldToScreen(add(mid, { x: e.normal.x * distance, y: e.normal.y * distance }));
  }

  /** Canvas-relative screen position of a world point. */
  toScreen(p: Vec2): Vec2 {
    return this.camera.worldToScreen(p);
  }

  /** Rotation helper for tests. */
  static rotate = rotate;
}
