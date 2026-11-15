import { CrewStrip } from "./crew-ui";
import { describeBearing, liveFirepower } from "../sim/ai/firepower";
import type { Application } from "pixi.js";
import { AI_PROFILES } from "../data/ai/index";
import type { AiProfile } from "../data/schemas/ai";
import { commanderAi } from "../sim/crew/officers";
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

/** AI for a commanded ship without a pilot: its commanding officer's chosen profile, else the default. */
const profileFor = (s: Ship): AiProfile => {
  const id = commanderAi(s.crew);
  return (id && AI_PROFILES.get(id)) || AI_PROFILES.get(DEFAULT_PROFILE)!;
};

type Mode = "select" | "move" | "attack" | "patrol" | "wait" | "facing" | "aim";

/** A point of an order that can be dragged on the map: ship, order (-1 = current, else queue index), point. */
interface HandleRef {
  readonly ship: string;
  readonly slot: number;
  readonly point: number;
  /** A patrol midpoint: pressing it inserts a waypoint after `point`. */
  readonly insert?: boolean;
}

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
    case "wait":
      return `waiting for ${ship(o.ship)} to arrive`;
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
  /** Order point being dragged on the map. */
  private dragHandle: HandleRef | null = null;
  /** Pointer position (screen), for the facing arrow being set. */
  private cursor: Vec2 = { x: 0, y: 0 };
  /** M mode, second click: the move point waiting for its facing (world), and whether it queues. */
  private pendingMove: { point: Vec2; queue: boolean } | null = null;
  /** Aim mode: the move order (ship, slot) whose aim point the next click sets. */
  private aimRef: { ship: string; slot: number } | null = null;
  private panelKey = "";
  private bannerShown = false;
  /** Details of the selected ship (schematic, systems, supply), kept across panel rebuilds. */
  private readonly details: HTMLElement;
  private readonly detailText: HTMLElement;
  private readonly plan = Object.assign(new ShipPlan(), { showFirepower: true });
  private detailsAge = 0;
  /** Officers of the focused ship along the bottom. */
  private readonly crewStrip = new CrewStrip("strategy-crew");

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
    // Queue editing buttons in the card (the card is rebuilt a few times a second, so one listener).
    this.detailText.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest("button[data-act]") as HTMLButtonElement | null;
      const list = b?.closest("ol[data-ship]") as HTMLElement | null;
      if (!b || !list) return;
      const act = b.dataset.act!;
      const ref = { ship: list.dataset.ship!, slot: Number(b.dataset.slot) };
      if (act === "aim") {
        this.setMode("aim");
        this.aimRef = ref;
      } else if (act === "noaim") this.setAim(ref, null);
      else this.editQueue(ref.ship, ref.slot, act as "up" | "down" | "del");
    });
    this.root = el(
      "div",
      { class: "st-root", "data-testid": "strategy", hidden: "" },
      this.input,
      this.overlay,
      this.bar,
      this.panel,
      this.status,
      this.crewStrip.el,
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
        setup.world.setAi(s.id, profileFor(s), {
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
      // Pressing an order point of a selected ship starts dragging it (a "+" midpoint adds a waypoint).
      if (e.button === 0 && this.mode === "select") {
        const h = this.handleAt(p.x, p.y);
        if (h) this.dragHandle = h.ref.insert ? this.insertWaypoint(h.ref) : h.ref;
      }
    });
    this.input.addEventListener("pointermove", (e) => {
      this.cursor = local(e);
      const d = this.drag;
      if (!d) return;
      const p = local(e);
      if (Math.hypot(p.x - d.x0, p.y - d.y0) > 5) d.moved = true;
      if (this.dragHandle) {
        this.setHandlePoint(this.dragHandle, this.camera.screenToWorld(p));
        d.x = p.x;
        d.y = p.y;
        return;
      }
      // Middle drag pans the map; so does a right drag with nothing selected (with ships selected it sets
      // the facing of a move order instead).
      if ((d.button === 1 || (d.button === 2 && !this.selected.size)) && d.moved)
        this.camera.pan(p.x - d.x, p.y - d.y);
      d.x = p.x;
      d.y = p.y;
    });
    this.input.addEventListener("pointerup", (e) => {
      const d = this.drag;
      this.drag = null;
      if (!d || !this.setup) return;
      const p = local(e);
      if (this.dragHandle) {
        this.dragHandle = null;
        return;
      }
      if (d.button === 0) {
        if (this.mode === "patrol") {
          if (d.moved) this.patrolArea(d.x0, d.y0, p.x, p.y, e.shiftKey);
          else this.patrolPoints.push(this.camera.screenToWorld(p));
        } else if (this.mode === "move") {
          // First click: where to; second click: which way the attack front then points.
          this.pendingMove = { point: this.camera.screenToWorld(p), queue: e.shiftKey };
          this.mode = "facing";
          this.renderBar();
        } else if (this.mode === "facing" && this.pendingMove) {
          const at = this.camera.worldToScreen(this.pendingMove.point);
          this.moveTo(this.pendingMove.point, this.pendingMove.queue, Math.atan2(-(p.y - at.y), p.x - at.x));
          this.pendingMove = null;
        } else if (this.mode === "aim" && this.aimRef) {
          this.setAim(this.aimRef, this.camera.screenToWorld(p));
        } else if (this.mode === "attack") {
          this.orderAt(p.x, p.y, e.shiftKey, "attack");
        } else if (this.mode === "wait") {
          this.waitFor(p.x, p.y, e.shiftKey);
        } else if (d.moved) this.boxSelect(d.x0, d.y0, p.x, p.y, e.shiftKey);
        else this.clickSelect(p.x, p.y, e.shiftKey);
      } else if (d.button === 2 && d.moved && this.selected.size) {
        // Right press on the destination and drag: the drag sets which way the attack front points there.
        this.moveTo(
          this.camera.screenToWorld({ x: d.x0, y: d.y0 }),
          e.shiftKey,
          Math.atan2(-(p.y - d.y0), p.x - d.x0),
        );
      } else if (d.button === 2 && !d.moved) {
        if (this.mode === "patrol" && this.patrolPoints.length) this.finishPatrol(e.shiftKey);
        else if (this.mode === "facing" && this.pendingMove) {
          this.moveTo(this.pendingMove.point, this.pendingMove.queue);
          this.pendingMove = null;
        } else this.orderAt(p.x, p.y, e.shiftKey);
      }
    });
    this.input.addEventListener("dblclick", (e) => {
      if (this.mode === "patrol" && this.patrolPoints.length >= 2) return this.finishPatrol(false);
      // Double click on a patrol waypoint removes it (a patrol keeps at least two).
      const p = local(e);
      const h = this.handleAt(p.x, p.y);
      if (h && !h.ref.insert) this.removeWaypoint(h.ref);
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
      case "KeyW":
        this.setMode("wait");
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
        else if (this.mode === "facing" && this.pendingMove) {
          this.moveTo(this.pendingMove.point, this.pendingMove.queue);
          this.pendingMove = null;
        }
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
    if (m !== "facing") this.pendingMove = null;
    if (m !== "aim") this.aimRef = null;
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

  // ---------- editing orders ----------
  /** Order of a ship by slot (-1 = current, else queue index). */
  private orderOf(st: AiState, slot: number): Order | null {
    return slot < 0 ? st.order : (st.queue[slot] ?? null);
  }

  private setOrder(st: AiState, slot: number, o: Order): void {
    if (slot < 0) st.order = o;
    else st.queue[slot] = o;
    st.nextEval = 0;
  }

  /** Drag handles of the selected ships' orders, in screen space. */
  private handles(): { ref: HandleRef; at: Vec2 }[] {
    const w = this.setup?.world;
    if (!w) return [];
    const out: { ref: HandleRef; at: Vec2 }[] = [];
    const at = (p: Vec2) => this.camera.worldToScreen(p);
    for (const id of [...this.selected].sort()) {
      const st = w.ai.get(id);
      if (!st) continue;
      for (let slot = -1; slot < st.queue.length; slot++) {
        const o = this.orderOf(st, slot);
        if (!o) continue;
        if (o.kind === "move" || o.kind === "hold" || o.kind === "wait")
          out.push({ ref: { ship: id, slot, point: 0 }, at: at(o.point) });
        else if (o.kind === "patrol")
          o.points.forEach((p, i) => {
            out.push({ ref: { ship: id, slot, point: i }, at: at(p) });
            const q = o.points[(i + 1) % o.points.length]!;
            out.push({
              ref: { ship: id, slot, point: i, insert: true },
              at: at({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 }),
            });
          });
      }
    }
    return out;
  }

  private handleAt(x: number, y: number): { ref: HandleRef; at: Vec2 } | null {
    let best: { ref: HandleRef; at: Vec2 } | null = null;
    let bestD = 9;
    for (const h of this.handles()) {
      const d = Math.hypot(h.at.x - x, h.at.y - y);
      // Real points win over "+" midpoints at the same spot.
      if (d < bestD || (best?.ref.insert && !h.ref.insert && d <= bestD)) {
        best = h;
        bestD = d;
      }
    }
    return best;
  }

  /** Moves an order point (path editing): a move, hold or wait point, or a patrol waypoint. */
  setHandlePoint(ref: HandleRef, p: Vec2): void {
    const st = this.setup?.world.ai.get(ref.ship);
    const o = st ? this.orderOf(st, ref.slot) : null;
    if (!st || !o) return;
    if (o.kind === "move" || o.kind === "hold" || o.kind === "wait")
      this.setOrder(st, ref.slot, { ...o, point: p });
    else if (o.kind === "patrol")
      this.setOrder(st, ref.slot, { ...o, points: o.points.map((q, i) => (i === ref.point ? p : q)) });
  }

  /** Inserts a patrol waypoint after `ref.point` (at the midpoint) and returns its handle. */
  insertWaypoint(ref: HandleRef): HandleRef | null {
    const st = this.setup?.world.ai.get(ref.ship);
    const o = st ? this.orderOf(st, ref.slot) : null;
    if (!st || o?.kind !== "patrol") return null;
    const a = o.points[ref.point]!;
    const b = o.points[(ref.point + 1) % o.points.length]!;
    const points = [...o.points];
    points.splice(ref.point + 1, 0, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    this.setOrder(st, ref.slot, { ...o, points });
    return { ship: ref.ship, slot: ref.slot, point: ref.point + 1 };
  }

  removeWaypoint(ref: HandleRef): void {
    const st = this.setup?.world.ai.get(ref.ship);
    const o = st ? this.orderOf(st, ref.slot) : null;
    if (!st || o?.kind !== "patrol" || o.points.length <= 2) return;
    this.setOrder(st, ref.slot, { ...o, points: o.points.filter((_, i) => i !== ref.point) });
    if (ref.slot < 0) st.patrolIndex %= o.points.length - 1;
  }

  /** Queue editing from the details card: move an order up or down, or delete it (-1 = current). */
  editQueue(shipId: string, slot: number, act: "up" | "down" | "del"): void {
    const w = this.setup?.world;
    const st = w?.ai.get(shipId);
    if (!w || !st) return;
    if (act === "del") {
      if (slot < 0) nextOrder(st, w.physics.getWorldCenter(shipId));
      else st.queue.splice(slot, 1);
    } else {
      const to = act === "up" ? slot - 1 : slot + 1;
      if (slot < 0 || to >= st.queue.length) return;
      if (to < 0) {
        // Up from the first queued order: it becomes the current one, the current one goes next.
        const cur = st.order;
        st.order = st.queue[0]!;
        if (cur) st.queue[0] = cur;
        else st.queue.shift();
        st.patrolIndex = 0;
      } else [st.queue[slot], st.queue[to]] = [st.queue[to]!, st.queue[slot]!];
    }
    st.nextEval = 0;
    this.detailsAge = 1; // refresh the card now
  }

  /** Where a ship's orders leave it: the last move, hold or wait point (a wait order holds there). */
  private endPoint(id: string): Vec2 {
    const w = this.setup!.world;
    const st = w.ai.get(id);
    const all = st ? [st.order, ...st.queue] : [];
    for (let i = all.length - 1; i >= 0; i--) {
      const o = all[i];
      if (o && (o.kind === "move" || o.kind === "hold" || o.kind === "wait")) return o.point;
      if (o?.kind === "patrol") return o.points[0]!;
    }
    return w.physics.getWorldCenter(id);
  }

  /**
   * Timed action: the selected ships wait (holding) until the clicked own ship has arrived, then go on with
   * the orders queued after the wait. With Shift the wait is queued, so: move, wait for A, then attack.
   */
  private waitFor(x: number, y: number, queue: boolean): void {
    const team = this.mine[0]?.team ?? 0;
    const a = this.shipAt(x, y, (s) => s.team === team);
    if (!a) return;
    const w = this.setup!.world;
    this.selected.delete(a.id);
    const points = new Map(
      [...this.selected].map((id) => [id, queue ? this.endPoint(id) : w.physics.getWorldCenter(id)]),
    );
    this.give((s) => ({ kind: "wait", ship: a.id, point: points.get(s.id)! }), queue);
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
        const st = w.ai.get(id) ?? w.setAi(id, profileFor(s));
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
    this.moveTo(this.camera.screenToWorld({ x, y }), queue);
  }

  /**
   * Move order for the selection; several ships spread on a small ring round the point instead of piling
   * onto it. `facing`: world direction their attack fronts then point (rad).
   */
  private moveTo(p: Vec2, queue: boolean, facing?: number): void {
    const n = this.selected.size;
    const f = facing !== undefined ? { facing } : {};
    this.give((s, i) => {
      if (n === 1) return { kind: "move", point: p, ...f };
      const a = (i / n) * Math.PI * 2;
      const r = 40 + n * 12;
      return { kind: "move", point: { x: p.x + Math.cos(a) * r, y: p.y + Math.sin(a) * r }, ...f };
    }, queue);
  }

  /** Aim of one move order (a leg of the route): its attack front turns to this point on the way. */
  setAim(ref: { ship: string; slot: number }, at: Vec2 | null): void {
    const st = this.setup?.world.ai.get(ref.ship);
    const o = st ? this.orderOf(st, ref.slot) : null;
    if (!st || o?.kind !== "move") return;
    const { aimAt: _old, ...rest } = o;
    void _old;
    this.setOrder(st, ref.slot, at ? { ...rest, aimAt: at } : rest);
    this.aimRef = null;
    this.setMode("select");
    this.detailsAge = 1;
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
    // Arrow from a screen point towards a world direction (y flips on screen).
    const arrow = (p: Vec2, dir: number, cls: string, len = 34) => {
      const t = { x: p.x + Math.cos(dir) * len, y: p.y - Math.sin(dir) * len };
      const h = (a: number) => ({ x: t.x - Math.cos(dir + a) * 9, y: t.y + Math.sin(dir + a) * 9 });
      const l = h(0.5);
      const r = h(-0.5);
      this.overlay.append(
        svg("polyline", {
          points: `${p.x},${p.y} ${t.x},${t.y} ${l.x},${l.y} ${t.x},${t.y} ${r.x},${r.y}`,
          class: cls,
        }),
      );
    };
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
          if (o.facing !== undefined) arrow(p, o.facing, `st-facing${cls}`);
          if (o.kind === "move" && o.aimAt) {
            const mid = { x: (from.x + p.x) / 2, y: (from.y + p.y) / 2 };
            const t = at(o.aimAt);
            line(mid, t, `st-order aim${cls}`);
            dot(t, `st-point aim${cls}`, 5);
          }
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
        } else if (o.kind === "wait") {
          const p = at(o.point);
          if (current) line(from, p, `st-order move${cls}`);
          dot(p, `st-point wait${cls}`, 5);
          if (w.hasShip(o.ship))
            line(p, at(this.scene!.shipCenter(w.getShip(o.ship), w, this.alpha)), `st-order wait${cls}`);
          from = p;
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
    // Drag handles on the selected ships' order points; "+" midpoints insert patrol waypoints.
    for (const h of this.handles())
      this.overlay.append(
        svg("circle", {
          cx: h.at.x,
          cy: h.at.y,
          r: h.ref.insert ? 4 : 6,
          class: h.ref.insert ? "st-handle insert" : "st-handle",
        }),
      );
    // Facing being set: from the chosen point (M mode) or the right press (drag) towards the pointer.
    const from0 =
      this.mode === "facing" && this.pendingMove
        ? at(this.pendingMove.point)
        : this.drag && this.drag.button === 2 && this.drag.moved && this.selected.size
          ? { x: this.drag.x0, y: this.drag.y0 }
          : null;
    if (from0) {
      const to = this.drag?.moved ? { x: this.drag.x, y: this.drag.y } : this.cursor;
      dot(from0, "st-point move", 5);
      if (Math.hypot(to.x - from0.x, to.y - from0.y) > 4)
        arrow(
          from0,
          Math.atan2(-(to.y - from0.y), to.x - from0.x),
          "st-facing",
          Math.max(34, Math.hypot(to.x - from0.x, to.y - from0.y)),
        );
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
        "Click or drag to select · right click: move / attack enemy / follow own ship · Shift queues · M move · A attack · P patrol · W wait for · H hold · S stop · drag order points to edit paths",
      move: "Move: click the destination, then the facing (Shift queues) · Esc cancels",
      attack: "Attack: click an enemy ship (Shift queues) · Esc cancels",
      patrol:
        "Patrol: click waypoints, then Enter, P, a double click or a right click to start · or drag an area · Esc cancels",
      wait: "Wait for: click one of your ships; the selected ships hold until it arrives, then go on (Shift queues) · Esc cancels",
      facing:
        "Move: click which way the attack front should point there · Enter or right click: no facing · Esc cancels",
      aim: "Aim: click the point the attack front turns to on this leg of the route · Esc cancels",
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
    const modeOf: Record<string, Mode> = {
      "st-move": "move",
      "st-attack": "attack",
      "st-patrol": "patrol",
      "st-wait": "wait",
    };
    const orderBtn = (label: string, id: string, f: () => void, title: string) => {
      const b = el(
        "button",
        { "data-testid": id, title, class: modeOf[id] === this.mode ? "on" : "" },
        label,
      );
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
            "Wait for",
            "st-wait",
            () => this.setMode("wait"),
            "W, then click one of your ships: hold until it arrives, then go on (Shift queues)",
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
    this.crewStrip.update(s);
    if (!s) return;
    this.plan.update(s, null, w.physics.getBodyState(s.id).angle);
    this.detailsAge += dt;
    // Slower while the pointer is on the card, so its buttons are not rebuilt under a click.
    const every = this.details.matches(":hover") ? 1 : 0.2;
    if (this.detailsAge < every && this.detailText.dataset.ship === s.id) return;
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
    // Orders with editing buttons: up, down, delete (handled by a click listener on the card).
    const orders = st
      ? [st.order, ...st.queue]
          .map((o, i) => {
            const slot = i - 1;
            if (!o) return "";
            const btn = (act: string, label: string, title: string, off = false) =>
              `<button data-act="${act}" data-slot="${slot}" title="${title}"${off ? " disabled" : ""}>${label}</button>`;
            return (
              `<li class="${slot < 0 ? "current" : ""}"><span>${slot < 0 ? "now" : `${slot + 1}.`} ${esc(describeOrder(o, w))}</span>` +
              btn("up", "↑", "earlier", slot < 0) +
              btn("down", "↓", "later", slot < 0 || slot >= st.queue.length - 1) +
              btn("del", "✕", slot < 0 ? "skip to the next order" : "remove") +
              (o.kind === "move"
                ? o.aimAt
                  ? btn("noaim", "◎✕", "stop aiming on this leg")
                  : btn("aim", "◎", "aim: click a point the attack front turns to on this leg")
                : "") +
              `</li>`
            );
          })
          .join("")
      : "";
    const queue = orders ? `<ol class="st-queue" data-ship="${s.id}">${orders}</ol>` : "";
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
      queue +
      `<div>attack front <b>${esc(describeBearing(liveFirepower(s).front))}</b></div>` +
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
