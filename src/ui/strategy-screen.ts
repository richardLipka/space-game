import type { Application } from "pixi.js";
import { AI_PROFILES } from "../data/ai/index";
import { Camera } from "../render/camera";
import { Scene } from "../render/scene";
import type { ThemeResolver } from "../render/theme";
import { nextOrder, type AiState, type Order } from "../sim/ai/brain";
import { FixedStepLoop } from "../sim/core/loop";
import type { Vec2 } from "../sim/core/vec2";
import { type Battle, updateBattle } from "../sim/scenario/battle";
import type { Ship } from "../sim/ship/ship-entity";
import type { World } from "../sim/world";
import { el } from "./editor/dom";
import { type HelpDialog } from "./help";
import { ammoSummary, hullFraction, ShipPlan } from "./hud/ship-plan";
import { partReadout, systemsHtml } from "./hud";

const SVG = "http://www.w3.org/2000/svg";
const TIME_SCALES = [0.25, 0.5, 1, 2, 4, 8] as const;
/** Default AI type for ships the player commands that had no pilot yet (test platforms). */
const DEFAULT_PROFILE = "balanced";

type Mode = "select" | "move" | "attack" | "patrol";

export interface StrategySetup {
  readonly world: World;
  readonly battle: Battle;
  readonly title: string;
  /** Back to where the battle was set up (scenario editor). */
  readonly exit: () => void;
  readonly retry: () => void;
}

function svg(tag: string, attrs: Record<string, string | number> = {}): SVGElement {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

const name = (s: Ship) => s.design.name.split(" (")[0]!;
const hullShare = (s: Ship) => {
  let hp = 0;
  let max = 0;
  for (const p of s.parts) {
    hp += Math.max(0, p.hp);
    max += p.def.def.hp;
  }
  return max > 0 ? hp / max : 0;
};

export function describeOrder(o: Order | null, world: World): string {
  if (!o) return "no orders";
  const ship = (id: string) => (world.hasShip(id) ? name(world.getShip(id)) : "?");
  switch (o.kind) {
    case "move":
      return "moving";
    case "hold":
      return "holding";
    case "patrol":
      return `patrolling (${o.points.length} points)`;
    case "attack":
      return `attacking ${ship(o.target)}`;
    case "follow":
      return `following ${ship(o.leader)}`;
    case "guard":
      return `guarding ${ship(o.target)}`;
  }
}

/**
 * Strategy mode (real-time strategy): the scenario's team-0 ships are commanded, not flown. The camera is
 * free over the map; ships are selected with clicks and boxes and given orders (move, attack, patrol in a
 * path or an area, hold, stop), queued with Shift. Every ship's orders are drawn on the map, and the AI
 * type of the selected ships can be changed.
 */
export class StrategyScreen {
  readonly root: HTMLElement;
  private readonly overlay: SVGSVGElement;
  private readonly input: HTMLElement;
  private readonly panel: HTMLElement;
  private readonly bar: HTMLElement;
  private readonly status: HTMLElement;
  private readonly banner: HTMLElement;
  private readonly camera = new Camera();
  private scene: Scene | null = null;
  private loop: FixedStepLoop | null = null;
  private setup: StrategySetup | null = null;
  private readonly selected = new Set<string>();
  private readonly groups = new Map<number, string[]>();
  private mode: Mode = "select";
  private patrolPoints: Vec2[] = [];
  private paused = false;
  private timeScaleIndex = 2;
  private alpha = 0;
  private drag: { x0: number; y0: number; x: number; y: number; button: number; moved: boolean } | null =
    null;
  private readonly keys = new Set<string>();
  private panelKey = "";
  private bannerShown = false;
  /** Details of the selected ship (schematic, systems, supply), kept across panel rebuilds. */
  private readonly details: HTMLElement;
  private readonly detailText: HTMLElement;
  private readonly plan = new ShipPlan();
  private detailsAge = 0;

  constructor(
    private readonly app: Application,
    private readonly theme: ThemeResolver,
    private readonly help: HelpDialog,
  ) {
    this.overlay = svg("svg", { class: "st-overlay", "data-testid": "strategy-overlay" }) as SVGSVGElement;
    this.input = el("div", { class: "st-input", "data-testid": "strategy-map" });
    this.panel = el("aside", { class: "st-panel", "data-testid": "strategy-panel" });
    this.status = el("div", { class: "st-status", "data-testid": "strategy-status" });
    this.banner = el("div", { class: "st-banner", "data-testid": "strategy-banner", hidden: "" });
    this.bar = el("header", { class: "st-bar" });
    this.detailText = el("div", { class: "st-detail-text" });
    this.details = el(
      "section",
      { class: "st-details", "data-testid": "strategy-details", hidden: "" },
      this.plan.el,
      this.detailText,
    );
    this.root = el(
      "div",
      { class: "st-root", "data-testid": "strategy", hidden: "" },
      this.input,
      this.overlay,
      this.bar,
      this.panel,
      this.status,
      this.banner,
    );
    document.body.append(this.root);
    this.bindInput();
  }

  get active(): boolean {
    return this.setup !== null;
  }

  /** Ships the player commands: the scenario's team-0 ships. */
  private get mine(): Ship[] {
    const b = this.setup?.battle;
    return b ? [...b.allyShips, ...b.playerShips].filter((s) => this.setup!.world.hasShip(s.id)) : [];
  }

  start(setup: StrategySetup): void {
    this.stop();
    this.setup = setup;
    this.selected.clear();
    this.groups.clear();
    this.mode = "select";
    this.patrolPoints = [];
    this.paused = false;
    this.timeScaleIndex = 2;
    this.bannerShown = false;
    this.banner.hidden = true;
    this.scene = new Scene(this.theme, this.app);
    this.camera.mode = "free";
    // Every commanded ship needs a pilot: ships placed without AI get the default type, holding position.
    for (const s of this.mine)
      if (!setup.world.ai.has(s.id))
        setup.world.setAi(s.id, AI_PROFILES.get(DEFAULT_PROFILE)!, {
          kind: "hold",
          point: setup.world.physics.getWorldCenter(s.id),
        });
    this.loop = new FixedStepLoop(
      () => {
        this.scene!.capture(setup.world);
        setup.world.step();
        updateBattle(setup.battle);
      },
      undefined,
      16,
    );
    this.renderBar();
    this.root.hidden = false;
    this.fit();
  }

  stop(): void {
    this.scene?.destroy();
    this.scene = null;
    this.loop = null;
    this.setup = null;
    this.root.hidden = true;
  }

  /** Frames the whole arena between the panels. */
  fit(): void {
    const w = this.setup?.world;
    this.camera.resize(this.app.screen.width, this.app.screen.height);
    this.camera.insets = {
      left: 0,
      right: this.panel.offsetWidth || 280,
      top: this.bar.offsetHeight || 40,
      bottom: 26,
    };
    const a = w?.arena ?? { width: 8000, height: 6000 };
    this.camera.center = { x: 0, y: 0 };
    this.camera.zoom = Math.min(this.camera.viewWidth / a.width, this.camera.viewHeight / a.height) * 0.95;
  }

  // ---------- input ----------
  private shipAt(x: number, y: number, filter: (s: Ship) => boolean): Ship | null {
    const setup = this.setup;
    if (!setup || !this.scene) return null;
    let best: Ship | null = null;
    let bestD = Infinity;
    for (const s of setup.world.allShips()) {
      if (s.defeated || s.drone || !filter(s)) continue;
      const c = this.camera.worldToScreen(this.scene.shipCenter(s, setup.world, this.alpha));
      const d = Math.hypot(c.x - x, c.y - y);
      if (d < Math.max(14, s.layout.boundingRadius * this.camera.zoom) && d < bestD) {
        best = s;
        bestD = d;
      }
    }
    return best;
  }

  private bindInput(): void {
    const local = (e: MouseEvent) => {
      const r = this.input.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    this.input.addEventListener("contextmenu", (e) => e.preventDefault());
    this.input.addEventListener("pointerdown", (e) => {
      if (!this.setup) return;
      const p = local(e);
      try {
        this.input.setPointerCapture(e.pointerId);
      } catch {
        /* synthetic or already released pointer */
      }
      this.drag = { x0: p.x, y0: p.y, x: p.x, y: p.y, button: e.button, moved: false };
    });
    this.input.addEventListener("pointermove", (e) => {
      const d = this.drag;
      if (!d) return;
      const p = local(e);
      if (Math.hypot(p.x - d.x0, p.y - d.y0) > 5) d.moved = true;
      // Right or middle drag pans the map.
      if (d.button !== 0 && d.moved) this.camera.pan(p.x - d.x, p.y - d.y);
      d.x = p.x;
      d.y = p.y;
    });
    this.input.addEventListener("pointerup", (e) => {
      const d = this.drag;
      this.drag = null;
      if (!d || !this.setup) return;
      const p = local(e);
      if (d.button === 0) {
        if (this.mode === "patrol") {
          if (d.moved) this.patrolArea(d.x0, d.y0, p.x, p.y, e.shiftKey);
          else this.patrolPoints.push(this.camera.screenToWorld(p));
        } else if (this.mode === "move") {
          this.orderAt(p.x, p.y, e.shiftKey, "move");
        } else if (this.mode === "attack") {
          this.orderAt(p.x, p.y, e.shiftKey, "attack");
        } else if (d.moved) this.boxSelect(d.x0, d.y0, p.x, p.y, e.shiftKey);
        else this.clickSelect(p.x, p.y, e.shiftKey);
      } else if (d.button === 2 && !d.moved) {
        if (this.mode === "patrol" && this.patrolPoints.length) this.finishPatrol(e.shiftKey);
        else this.orderAt(p.x, p.y, e.shiftKey);
      }
    });
    this.input.addEventListener("dblclick", () => {
      if (this.mode === "patrol" && this.patrolPoints.length >= 2) this.finishPatrol(false);
    });
    this.input.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const p = local(e);
        const before = this.camera.screenToWorld(p);
        this.camera.zoomBy(Math.pow(1.0015, -e.deltaY));
        const after = this.camera.screenToWorld(p);
        this.camera.center = {
          x: this.camera.center.x + before.x - after.x,
          y: this.camera.center.y + before.y - after.y,
        };
      },
      { passive: false },
    );
    window.addEventListener("keydown", (e) => this.onKey(e));
    window.addEventListener("keyup", (e) => this.keys.delete(e.code));
  }

  private onKey(e: KeyboardEvent): void {
    if (!this.setup || this.root.hidden) return;
    if ((e.target as HTMLElement | null)?.closest?.("input, select, textarea")) return;
    if (this.help.open) {
      if (e.code === "Escape" || e.code === "F1") this.help.close();
      return;
    }
    this.keys.add(e.code);
    const digit = /^Digit([1-9])$/.exec(e.code);
    if (digit) {
      const g = Number(digit[1]);
      if (e.ctrlKey || e.metaKey) this.groups.set(g, [...this.selected]);
      else {
        this.selected.clear();
        for (const id of this.groups.get(g) ?? []) this.selected.add(id);
      }
      e.preventDefault();
      return;
    }
    switch (e.code) {
      case "Escape":
        if (this.mode !== "select") this.setMode("select");
        else this.selected.clear();
        break;
      case "KeyA":
        if (e.ctrlKey || e.metaKey) {
          for (const s of this.mine) if (!s.defeated) this.selected.add(s.id);
          e.preventDefault();
        } else this.setMode("attack");
        break;
      case "KeyM":
        this.setMode("move");
        break;
      case "KeyP":
        if (this.mode === "patrol" && this.patrolPoints.length >= 2) this.finishPatrol(e.shiftKey);
        else this.setMode("patrol");
        break;
      case "Enter":
        if (this.mode === "patrol" && this.patrolPoints.length >= 2) this.finishPatrol(e.shiftKey);
        break;
      case "KeyH":
        this.give(
          (s) => ({ kind: "hold", point: this.setup!.world.physics.getWorldCenter(s.id) }),
          e.shiftKey,
        );
        break;
      case "KeyS":
        this.stopSelected();
        break;
      case "Space":
        this.paused = !this.paused;
        e.preventDefault();
        break;
      case "Equal":
      case "NumpadAdd":
      case "BracketRight":
        this.timeScaleIndex = Math.min(TIME_SCALES.length - 1, this.timeScaleIndex + 1);
        break;
      case "Minus":
      case "NumpadSubtract":
      case "BracketLeft":
        this.timeScaleIndex = Math.max(0, this.timeScaleIndex - 1);
        break;
      case "Home":
        this.fit();
        break;
      case "F1":
        this.help.show("strategy");
        e.preventDefault();
        break;
      default:
        if (e.key === "?") this.help.show("strategy");
        return;
    }
    this.renderBar();
  }

  private setMode(m: Mode): void {
    this.mode = m;
    this.patrolPoints = [];
    this.renderBar();
  }

  private clickSelect(x: number, y: number, add: boolean): void {
    const mine = new Set(this.mine.map((s) => s.id));
    const s = this.shipAt(x, y, (t) => mine.has(t.id));
    if (!add) this.selected.clear();
    if (s) {
      if (add && this.selected.has(s.id)) this.selected.delete(s.id);
      else this.selected.add(s.id);
    }
  }

  private boxSelect(x0: number, y0: number, x1: number, y1: number, add: boolean): void {
    if (!add) this.selected.clear();
    const [lx, hx, ly, hy] = [Math.min(x0, x1), Math.max(x0, x1), Math.min(y0, y1), Math.max(y0, y1)];
    for (const s of this.mine) {
      if (s.defeated) continue;
      const c = this.camera.worldToScreen(this.scene!.shipCenter(s, this.setup!.world, this.alpha));
      if (c.x >= lx && c.x <= hx && c.y >= ly && c.y <= hy) this.selected.add(s.id);
    }
  }

  /** Orders for every selected ship: replace its orders, or append to its queue with `queue`. */
  private give(order: (s: Ship, i: number) => Order, queue: boolean): void {
    const w = this.setup?.world;
    if (!w) return;
    [...this.selected]
      .filter((id) => w.hasShip(id) && !w.getShip(id).defeated)
      .sort()
      .forEach((id, i) => {
        const s = w.getShip(id);
        const st = w.ai.get(id) ?? w.setAi(id, AI_PROFILES.get(DEFAULT_PROFILE)!);
        const o = order(s, i);
        if (queue) st.queue.push(o);
        else {
          st.queue = [];
          st.order = o;
          st.patrolIndex = 0;
          st.nextEval = 0; // react now, not at the next evaluation
        }
      });
    this.setMode("select");
  }

  /** Right click: attack an enemy ship, follow an own one, or move to the point (ships spread around it). */
  private orderAt(x: number, y: number, queue: boolean, force?: "move" | "attack"): void {
    if (!this.selected.size) return;
    const team = this.mine[0]?.team ?? 0;
    const enemy = this.shipAt(x, y, (s) => s.team !== team);
    if (enemy && force !== "move") {
      this.give(() => ({ kind: "attack", target: enemy.id }), queue);
      return;
    }
    if (force === "attack") return;
    const own = this.shipAt(x, y, (s) => s.team === team && !this.selected.has(s.id));
    if (own && !force) {
      this.give(() => ({ kind: "follow", leader: own.id }), queue);
      return;
    }
    const p = this.camera.screenToWorld({ x, y });
    const n = this.selected.size;
    // Ships spread on a small ring around the point instead of piling onto it.
    this.give((s, i) => {
      if (n === 1) return { kind: "move", point: p };
      const a = (i / n) * Math.PI * 2;
      const r = 40 + n * 12;
      return { kind: "move", point: { x: p.x + Math.cos(a) * r, y: p.y + Math.sin(a) * r } };
    }, queue);
  }

  private finishPatrol(queue: boolean): void {
    const pts = this.patrolPoints;
    if (pts.length < 2) return;
    this.give(() => ({ kind: "patrol", points: [...pts] }), queue);
  }

  /** A dragged rectangle in patrol mode: patrol round its corners. */
  private patrolArea(x0: number, y0: number, x1: number, y1: number, queue: boolean): void {
    const c = (x: number, y: number) => this.camera.screenToWorld({ x, y });
    this.patrolPoints = [c(x0, y0), c(x1, y0), c(x1, y1), c(x0, y1)];
    this.finishPatrol(queue);
  }

  private stopSelected(): void {
    const w = this.setup!.world;
    for (const id of this.selected) {
      const st = w.ai.get(id);
      if (!st || !w.hasShip(id)) continue;
      st.queue = [];
      nextOrder(st, w.physics.getWorldCenter(id));
    }
  }

  // ---------- frame ----------
  frame(dtReal: number): void {
    const setup = this.setup;
    if (!setup || !this.scene || !this.loop) return;
    // Keyboard panning (arrow keys; letters are orders), at a screen speed independent of zoom.
    const pan = 600 * dtReal;
    const k = this.keys;
    const dx = (k.has("ArrowLeft") ? pan : 0) - (k.has("ArrowRight") ? pan : 0);
    const dy = (k.has("ArrowUp") ? pan : 0) - (k.has("ArrowDown") ? pan : 0);
    if (dx || dy) this.camera.pan(dx, dy);
    const { alpha } = this.loop.advance(this.paused ? 0 : dtReal * TIME_SCALES[this.timeScaleIndex]!);
    this.alpha = alpha;
    this.camera.resize(this.app.screen.width, this.app.screen.height);
    this.camera.insets = {
      left: 0,
      right: this.panel.offsetWidth || 280,
      top: this.bar.offsetHeight || 40,
      bottom: 26,
    };
    for (const id of [...this.selected])
      if (!setup.world.hasShip(id) || setup.world.getShip(id).defeated) this.selected.delete(id);
    this.scene.targetId = null;
    this.scene.courseIds = [];
    this.scene.render(setup.world, this.camera, alpha);
    this.renderOverlay();
    this.renderPanel();
    this.updateDetails(dtReal);
    if (setup.battle.status !== "running" && !this.bannerShown) this.showBanner();
  }

  private renderOverlay(): void {
    const setup = this.setup!;
    const w = setup.world;
    const W = this.app.screen.width;
    const H = this.app.screen.height;
    this.overlay.setAttribute("viewBox", `0 0 ${W} ${H}`);
    this.overlay.replaceChildren();
    const at = (p: Vec2) => this.camera.worldToScreen(p);
    const line = (a: Vec2, b: Vec2, cls: string) =>
      this.overlay.append(svg("line", { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: cls }));
    const dot = (p: Vec2, cls: string, r = 4) =>
      this.overlay.append(svg("circle", { cx: p.x, cy: p.y, r, class: cls }));
    for (const s of this.mine) {
      if (s.defeated) continue;
      const c = at(this.scene!.shipCenter(s, w, this.alpha));
      const sel = this.selected.has(s.id);
      const r = Math.max(10, s.layout.boundingRadius * this.camera.zoom + 4);
      this.overlay.append(
        svg("circle", { cx: c.x, cy: c.y, r, class: sel ? "st-ring selected" : "st-ring" }),
      );
      const st = w.ai.get(s.id);
      if (!st) continue;
      // Orders are drawn for selected ships, and faintly for the rest.
      const cls = sel ? "" : " faint";
      let from = c;
      const draw = (o: Order, current: boolean, state: AiState) => {
        if (o.kind === "move" || o.kind === "hold") {
          const p = at(o.point);
          if (o.kind === "move" || current) line(from, p, `st-order move${cls}`);
          dot(p, `st-point ${o.kind}${cls}`);
          from = p;
        } else if (o.kind === "patrol") {
          const pts = o.points.map(at);
          const first = current ? (pts[state.patrolIndex % pts.length] ?? pts[0]!) : pts[0]!;
          line(from, first, `st-order patrol${cls}`);
          this.overlay.append(
            svg("polygon", { points: pts.map((p) => `${p.x},${p.y}`).join(" "), class: `st-patrol${cls}` }),
          );
          for (const p of pts) dot(p, `st-point patrol${cls}`, 3);
          from = first;
        } else {
          const id = o.kind === "attack" ? o.target : o.kind === "follow" ? o.leader : o.target;
          if (!w.hasShip(id)) return;
          const p = at(this.scene!.shipCenter(w.getShip(id), w, this.alpha));
          line(from, p, `st-order ${o.kind}${cls}`);
          from = p;
        }
      };
      if (st.order) draw(st.order, true, st);
      for (const q of st.queue) draw(q, false, st);
    }
    // Patrol being drawn, and the selection box.
    if (this.patrolPoints.length) {
      const pts = this.patrolPoints.map(at);
      this.overlay.append(
        svg("polyline", { points: pts.map((p) => `${p.x},${p.y}`).join(" "), class: "st-patrol drafting" }),
      );
      for (const p of pts) dot(p, "st-point patrol", 4);
    }
    const d = this.drag;
    if (d && d.button === 0 && d.moved && this.mode !== "move" && this.mode !== "attack")
      this.overlay.append(
        svg("rect", {
          x: Math.min(d.x0, d.x),
          y: Math.min(d.y0, d.y),
          width: Math.abs(d.x - d.x0),
          height: Math.abs(d.y - d.y0),
          class: this.mode === "patrol" ? "st-box patrol" : "st-box",
        }),
      );
  }

  private renderBar(): void {
    const setup = this.setup;
    if (!setup) return;
    const btn = (label: string, id: string, f: () => void, title = "", on = false) => {
      const b = el("button", { "data-testid": id, title, class: on ? "on" : "" }, label);
      b.addEventListener("click", () => {
        f();
        this.renderBar();
      });
      return b;
    };
    const scale = TIME_SCALES[this.timeScaleIndex]!;
    this.bar.replaceChildren(
      el("span", { class: "ed-title" }, "STRATEGY"),
      el("span", { class: "st-title" }, setup.title),
      el("span", { class: "ed-sep" }),
      btn(this.paused ? "▶ Resume" : "❚❚ Pause", "st-pause", () => (this.paused = !this.paused), "Space"),
      btn("−", "st-slower", () => (this.timeScaleIndex = Math.max(0, this.timeScaleIndex - 1)), "Slower (−)"),
      el("span", { class: "st-scale", "data-testid": "st-scale" }, `×${scale}`),
      btn(
        "+",
        "st-faster",
        () => (this.timeScaleIndex = Math.min(TIME_SCALES.length - 1, this.timeScaleIndex + 1)),
        "Faster (+)",
      ),
      btn("Fit map", "st-fit", () => this.fit(), "Home"),
      el("span", { class: "ed-sep" }),
      btn("? Help", "st-help", () => this.help.show("strategy"), "F1 or ?"),
      btn("Exit", "st-exit", () => setup.exit(), "Back to the scenario editor"),
    );
    const hint: Record<Mode, string> = {
      select:
        "Click or drag to select · right click: move / attack enemy / follow own ship · Shift queues · M move · A attack · P patrol · H hold · S stop",
      move: "Move: click the destination (Shift queues) · Esc cancels",
      attack: "Attack: click an enemy ship (Shift queues) · Esc cancels",
      patrol:
        "Patrol: click waypoints, then Enter, P, a double click or a right click to start · or drag an area · Esc cancels",
    };
    this.status.textContent = hint[this.mode];
    this.panelKey = "";
  }

  private renderPanel(): void {
    const setup = this.setup!;
    const w = setup.world;
    const sel = [...this.selected].filter((id) => w.hasShip(id)).map((id) => w.getShip(id));
    const key = `${sel.map((s) => `${s.id}:${Math.round(hullShare(s) * 20)}:${describeOrder(w.ai.get(s.id)?.order ?? null, w)}:${w.ai.get(s.id)?.queue.length}:${w.ai.get(s.id)?.profile.id}`).join("|")}|${this.mine.filter((s) => !s.defeated).length}|${this.mode}`;
    if (key === this.panelKey) return;
    this.panelKey = key;
    const out: (HTMLElement | string)[] = [];
    const live = this.mine.filter((s) => !s.defeated);
    out.push(this.details);
    out.push(el("h3", {}, `Your ships (${live.length})`));
    if (!sel.length) out.push(el("p", { class: "dim" }, "Click a ship, drag a box, or Ctrl+A to select."));
    const orderBtn = (label: string, id: string, f: () => void, title: string) => {
      const b = el("button", { "data-testid": id, title }, label);
      b.addEventListener("click", f);
      return b;
    };
    if (sel.length) {
      out.push(
        el(
          "div",
          { class: "st-orders" },
          orderBtn("Move", "st-move", () => this.setMode("move"), "M, then click"),
          orderBtn("Attack", "st-attack", () => this.setMode("attack"), "A, then click an enemy"),
          orderBtn(
            "Patrol",
            "st-patrol",
            () => this.setMode("patrol"),
            "P, then click waypoints or drag an area",
          ),
          orderBtn(
            "Hold",
            "st-hold",
            () => this.give((s) => ({ kind: "hold", point: w.physics.getWorldCenter(s.id) }), false),
            "H",
          ),
          orderBtn("Stop", "st-stop", () => this.stopSelected(), "S: drop every order and hold"),
        ),
      );
      // AI type of the selection.
      const profiles = el("select", {
        "data-testid": "st-profile",
        "aria-label": "AI type",
      }) as HTMLSelectElement;
      const current = new Set(sel.map((s) => w.ai.get(s.id)?.profile.id ?? ""));
      if (current.size > 1) profiles.append(el("option", { value: "" }, "(mixed)"));
      for (const p of AI_PROFILES.values()) profiles.append(el("option", { value: p.id }, p.name));
      profiles.value = current.size === 1 ? [...current][0]! : "";
      profiles.addEventListener("change", () => {
        const p = AI_PROFILES.get(profiles.value);
        if (!p) return;
        for (const s of sel) {
          const st = w.ai.get(s.id);
          if (st) {
            st.profile = p;
            st.nextEval = 0;
          } else w.setAi(s.id, p, { kind: "hold", point: w.physics.getWorldCenter(s.id) });
        }
        this.panelKey = "";
      });
      out.push(el("label", { class: "sc-field" }, "AI type", profiles));
    }
    for (const s of (sel.length ? sel : live).slice(0, 24)) {
      const st = w.ai.get(s.id);
      const row = el(
        "div",
        { class: `st-ship${this.selected.has(s.id) ? " selected" : ""}`, "data-ship": s.id },
        el("span", { class: "name" }, name(s)),
        el(
          "span",
          { class: "dim" },
          `${Math.round(hullShare(s) * 100)}% · ${describeOrder(st?.order ?? null, w)}${st?.queue.length ? ` · +${st.queue.length} queued` : ""} · ${st?.profile.name ?? "no AI"}`,
        ),
      );
      row.addEventListener("click", (e) => {
        if (!(e as MouseEvent).shiftKey) this.selected.clear();
        this.selected.add(s.id);
      });
      out.push(row);
    }
    const enemies = setup.battle.enemyShips.filter((s) => !s.defeated).length;
    out.push(el("p", { class: "dim" }, `Enemy ships left: ${enemies}`));
    this.panel.replaceChildren(...out);
  }

  /** The ship the details card shows: the selected one, or the first of several. */
  private focus(): Ship | null {
    const w = this.setup?.world;
    if (!w) return null;
    const id = [...this.selected].sort().find((x) => w.hasShip(x));
    return id ? w.getShip(id) : null;
  }

  /**
   * Overview of the focused ship, like the flight cockpit: damage schematic (turned as in the world; point at
   * a part for its HP), systems, speed, fuel, heat, power, AI state and orders, and the munition supply.
   * The schematic follows every frame; the numbers a few times a second.
   */
  private updateDetails(dt: number): void {
    const w = this.setup!.world;
    const s = this.focus();
    this.details.hidden = !s;
    if (!s) return;
    this.plan.update(s, null, w.physics.getBodyState(s.id).angle);
    this.detailsAge += dt;
    if (this.detailsAge < 0.2 && this.detailText.dataset.ship === s.id && !this.plan.hoverUid) return;
    this.detailsAge = 0;
    this.detailText.dataset.ship = s.id;
    const esc = (t: string) => t.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
    const pct = (f: number) => `${Math.round(Math.max(0, Math.min(1, f)) * 100)}%`;
    const cls = (f: number) => (f < 0.2 ? "alert" : f < 0.5 ? "warn" : "");
    const kw = (x: number) => (x >= 1e6 ? `${(x / 1e6).toFixed(1)} MW` : `${(x / 1e3).toFixed(0)} kW`);
    const st = w.ai.get(s.id);
    const v = w.physics.getBodyState(s.id).linearVelocity;
    const hull = hullFraction(s);
    const fuel = s.fuelCapacity > 0 ? s.totalFuel / s.fuelCapacity : 0;
    const heat = s.heatLevel;
    const pw = s.power;
    const short = s.powerPriority.filter((g) => pw.groups[g].demand > 0 && pw.groups[g].factor < 0.999);
    const target = st?.targetId && w.hasShip(st.targetId) ? name(w.getShip(st.targetId)) : null;
    const others =
      this.selected.size > 1 ? ` <span class="dim">(1 of ${this.selected.size} selected)</span>` : "";
    const queue = st?.queue.length
      ? `<div class="dim">then: ${st.queue.map((o) => esc(describeOrder(o, w))).join(" → ")}</div>`
      : "";
    const ammo = ammoSummary(s)
      .map((a) => {
        const f = a.capacity > 0 ? a.left / a.capacity : 0;
        const secs =
          a.seconds !== undefined
            ? ` · ${Math.floor(a.seconds / 60)}:${String(Math.floor(a.seconds % 60)).padStart(2, "0")} of fire`
            : "";
        return `<div class="st-ammo"><span>${esc(a.label)}</span><span class="st-bar-track"><span class="st-bar-fill ${cls(f)}" style="width:${pct(f)}"></span></span><b class="${cls(f)}">${Math.round(a.left)}</b><span class="dim">/${a.capacity}${secs}</span></div>`;
      })
      .join("");
    this.detailText.innerHTML =
      `<h3>${esc(s.design.name)}</h3>${others}` +
      `<div>hull <b class="${cls(hull)}">${pct(hull)}</b> · ${st ? `${esc(st.profile.name)} · ${st.behaviour}${target ? ` → ${esc(target)}` : ""}` : "no AI"}</div>` +
      `<div>${esc(describeOrder(st?.order ?? null, w))}</div>${queue}` +
      `<div class="st-systems">${systemsHtml(s)}</div>` +
      `<div class="st-readout">${partReadout(s, this.plan.hoverUid)}</div>` +
      `<div class="st-gauges">` +
      `<span><i>SPEED</i>${Math.hypot(v.x, v.y).toFixed(0)} m/s</span>` +
      `<span><i>FUEL</i><b class="${cls(fuel)}">${pct(fuel)}</b> ${s.totalFuel.toFixed(0)} kg</span>` +
      `<span><i>HEAT</i><b class="${heat > 1 ? "alert" : heat > 0.7 ? "warn" : ""}">${pct(heat)}</b></span>` +
      `<span><i>POWER</i>${kw(pw.used)} / ${kw(pw.supply)}${short.length ? ` <b class="warn">short: ${short.join(", ")}</b>` : ""}</span>` +
      `</div>` +
      `<h3>Munitions</h3>${ammo || `<div class="dim">no ammunition stores</div>`}`;
  }

  private showBanner(): void {
    const setup = this.setup!;
    this.bannerShown = true;
    const b = setup.battle;
    const exit = el("button", { "data-testid": "st-banner-exit" }, "Back to the editor");
    exit.addEventListener("click", () => setup.exit());
    const retry = el("button", { "data-testid": "st-banner-retry" }, "Play again");
    retry.addEventListener("click", () => setup.retry());
    this.banner.replaceChildren(
      el("h2", {}, b.status === "won" ? "Victory" : "Defeat"),
      el("p", {}, b.reason ?? ""),
      el("p", { class: "dim" }, `${Math.round(b.endTime ?? setup.world.time)} s`),
      el("div", { class: "actions" }, retry, exit),
    );
    this.banner.hidden = false;
  }
}
