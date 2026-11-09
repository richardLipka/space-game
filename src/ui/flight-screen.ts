import type { Application } from "pixi.js";
import { FixedStepLoop } from "../sim/core/loop";
import { angleOf, sub } from "../sim/core/vec2";
import { IDLE_INTENT } from "../sim/flight/controller";
import type { Ship } from "../sim/ship/ship-entity";
import type { World } from "../sim/world";
import { Camera, CAMERA_MODES } from "../render/camera";
import { Scene } from "../render/scene";
import type { ThemeResolver } from "../render/theme";
import { Hud } from "./hud";
import type { InputController, UiCommand } from "./input";
import type { PowerGroup } from "../data/schemas/design";
import { partCentroid, partPiecesShipFrame } from "../sim/ship/ship";
import { rotate as rot } from "../sim/core/vec2";
import { pointInPolygon } from "../sim/core/geometry";
import { aiProfile } from "../data/ai/index";
import type { AiProfile } from "../data/schemas/ai";
import type { Order } from "../sim/ai/brain";
import { updateBattle, type Battle } from "../sim/scenario/battle";
import { el } from "./editor/dom";

export interface FlightSetup {
  readonly world: World;
  /** Ships the player can control (Tab cycles). */
  readonly playerShips: Ship[];
  /** Label shown in the HUD (e.g. "Test flight"). */
  readonly title: string;
  /** Scenario battle (spec §12): objective tracking and the results screen. */
  readonly battle?: Battle;
  /** Called once when the battle ends (results are saved here). */
  readonly onBattleEnd?: (b: Battle) => void;
  /** Starts the same battle again. */
  readonly retry?: () => void;
  /**
   * Watch mode (balance tooling): the AI flies every ship; input only moves the camera (Tab follows the
   * next ship), pauses and changes the time scale.
   */
  readonly spectate?: boolean;
}

/** Commands that still work while watching: they change only the view or the clock. */
const SPECTATOR_COMMANDS = new Set<string>([
  "camera-mode",
  "switch-ship",
  "pause",
  "time-faster",
  "time-slower",
  "overlays",
  "help",
  "power-panel",
  "networks",
  "theme",
  "exit",
]);

const TIME_SCALES = [0.25, 0.5, 1, 2, 4, 8] as const;

/** Flight view: fixed-step sim, interpolated rendering, camera and HUD (spec §10). */
export class FlightScreen {
  private scene: Scene | null = null;
  private setup: FlightSetup | null = null;
  private loop: FixedStepLoop | null = null;
  private readonly camera = new Camera();
  private readonly hud: Hud;
  private controlled = 0;
  paused = false;
  private timeScaleIndex = 2;
  private showHelp = false;
  private showOverlays = true;
  private fps = 60;
  private showNetworks = false;
  /** Selected weapon groups and RMB target (spec §9.2). */
  readonly selectedGroups = new Set<number>([1]);
  targetId: string | null = null;
  /** Test hook: hold the trigger regardless of the mouse. */
  debugTrigger = false;
  /** M (one) or Shift+M (salvo) pressed: launch on the next tick (needs a target). */
  private pendingLaunch: false | "one" | "salvo" = false;
  /** Allies picked with Ctrl+click for orders (empty = all allies). */
  readonly selectedAllies = new Set<string>();
  /** Profile allied ships fly with. */
  allyProfile: AiProfile = aiProfile("balanced");
  private readonly powerPanel: HTMLElement;
  private powerPanelKey = "";
  /** UI commands this screen does not handle itself (theme, exit). */
  onCommand: (cmd: UiCommand) => void = () => {};
  themeName: () => string = () => "";

  constructor(
    private readonly app: Application,
    private readonly theme: ThemeResolver,
    private readonly hudEl: HTMLElement,
    private readonly input: InputController,
  ) {
    this.hud = new Hud(hudEl);
    this.powerPanel = document.createElement("div");
    this.powerPanel.className = "power-panel";
    this.powerPanel.dataset.testid = "power-panel";
    this.powerPanel.hidden = true;
    document.body.append(this.powerPanel);
    this.resultsPanel = el("div", { class: "results-panel", "data-testid": "results", hidden: "" });
    document.body.append(this.resultsPanel);
    this.weaponBar = el("div", { class: "weapon-bar", "data-testid": "weapon-bar", hidden: "" });
    document.body.append(this.weaponBar);
    this.launchPanel = el("div", { class: "launch-panel", "data-testid": "launch-panel", hidden: "" });
    document.body.append(this.launchPanel);
  }

  private readonly weaponBar: HTMLElement;
  private weaponBarKey = "";

  /**
   * Weapon groups along the bottom of the screen (spec §9.2): one card per group with its key, mode and
   * the weapons in it as a column (one row per weapon type: count, loaded rounds, reload), the selected
   * groups highlighted. Click selects, Shift+click adds. Missile launchers and hangars are listed one by
   * one in the launch panel on the right (renderLaunchPanel).
   */
  private renderWeaponBar(): void {
    const ship = this.controlledShip;
    const bar = this.weaponBar;
    const ws = ship ? ship.weapons.filter((w) => w.def.kind !== "pd") : [];
    this.renderLaunchPanel();
    if (!ship || ws.length === 0) {
      bar.hidden = true;
      this.weaponBarKey = "";
      return;
    }
    const groups = [...new Set(ws.map((w) => w.group))].sort((a, b) => a - b);
    const info = groups.map((g) => {
      const list = ws.filter((w) => w.group === g);
      const mode = ship.groupModes.get(g) ?? "manual";
      const types = [...new Set(list.map((w) => w.part.def.def.id))].map((id) => {
        const same = list.filter((w) => w.part.def.def.id === id);
        const alive = same.filter((w) => w.part.hp > 0);
        const def = same[0]!.def;
        const usesAmmo = !!def.ammoType && def.internalMagazine > 0;
        const loaded = alive.reduce((n, w) => n + Math.floor(w.part.ammo), 0);
        const cap = alive.reduce((n, w) => n + w.def.internalMagazine, 0);
        const ready = alive.filter((w) => w.cooldown <= 1e-9 && (!usesAmmo || w.part.ammo >= 1)).length;
        const wait = alive.length ? Math.min(...alive.map((w) => w.cooldown)) : 0;
        return {
          name: same[0]!.part.def.def.name.replace(/ \(.*\)$/, ""),
          count: same.length,
          alive: alive.length,
          ammo: usesAmmo ? `${loaded}/${cap}` : def.kind === "beam" ? "power" : "",
          state: alive.length === 0 ? "lost" : ready > 0 ? "ready" : `${wait.toFixed(1)} s`,
        };
      });
      const name = ship.groupSettings.get(g)?.name ?? "";
      return { g, mode, name, types, alive: types.some((t) => t.alive > 0) };
    });
    const key = `${ship.id}|${[...this.selectedGroups].join()}|${JSON.stringify(info)}`;
    bar.hidden = false;
    if (key === this.weaponBarKey) return;
    this.weaponBarKey = key;
    bar.replaceChildren();
    for (const x of info) {
      const sel = this.selectedGroups.has(x.g);
      const rows = x.types.map((t) =>
        el(
          "div",
          { class: `wb-weapon${t.alive === 0 ? " lost" : ""}` },
          el("span", { class: "wb-wname" }, `${t.count > 1 ? `${t.alive}/${t.count}× ` : ""}${t.name}`),
          el("span", { class: "wb-ammo" }, t.ammo),
          el("span", { class: `wb-state${t.state === "ready" ? " ready" : ""}` }, t.state),
        ),
      );
      const chip = el(
        "button",
        {
          class: `wb-group mode-${x.mode}${sel ? " sel" : ""}${x.alive ? "" : " dead"}`,
          "data-testid": `wb-group-${x.g}`,
          "aria-pressed": String(sel),
          title: "Click selects, Shift+click adds · G cycles the mode of the selected groups",
        },
        el(
          "div",
          { class: "wb-head" },
          el("span", { class: "wb-key" }, String(x.g)),
          el("span", { class: "wb-mode", "data-testid": `wb-mode-${x.g}` }, x.mode.toUpperCase()),
          el("span", { class: "wb-gname" }, x.name),
        ),
        ...rows,
      );
      chip.addEventListener("mousedown", (e) => e.stopPropagation());
      chip.addEventListener("click", (e) => {
        if (e.shiftKey) {
          if (this.selectedGroups.has(x.g) && this.selectedGroups.size > 1) this.selectedGroups.delete(x.g);
          else this.selectedGroups.add(x.g);
        } else {
          this.selectedGroups.clear();
          this.selectedGroups.add(x.g);
        }
        (e.currentTarget as HTMLElement).blur();
      });
      bar.append(chip);
    }
  }

  private readonly launchPanel: HTMLElement;
  private launchPanelKey = "";

  /**
   * Launch panel on the right: every missile launcher and every hangar on its own row with what it holds,
   * whether it can launch now and a bar filling up while it reloads. M / Shift+M and H / Shift+H launch.
   */
  private renderLaunchPanel(): void {
    const ship = this.controlledShip;
    const panel = this.launchPanel;
    const launchers = ship
      ? ship.weapons
          .filter((w) => w.def.kind === "missile")
          .sort((a, b) => (a.part.uid < b.part.uid ? -1 : 1))
      : [];
    const hangars = ship
      ? ship.parts.filter((p) => p.def.def.hangar).sort((a, b) => (a.uid < b.uid ? -1 : 1))
      : [];
    if (!ship || (launchers.length === 0 && hangars.length === 0)) {
      panel.hidden = true;
      this.launchPanelKey = "";
      return;
    }
    const lRows = launchers.map((w) => {
      const lost = w.part.hp <= 0;
      const loaded = lost ? 0 : Math.floor(w.part.ammo);
      const interval = Math.max(1e-6, w.def.fireInterval);
      const state = lost
        ? "lost"
        : loaded < 1
          ? "empty"
          : w.cooldown <= 1e-9
            ? "ready"
            : `${w.cooldown.toFixed(1)} s`;
      return {
        loaded,
        cap: w.def.internalMagazine,
        state,
        fill: lost || loaded < 1 ? 0 : 1 - w.cooldown / interval,
      };
    });
    const hRows = hangars.map((p) => {
      const h = p.def.def.hangar!;
      const st = ship.hangarState(p.uid);
      const lost = p.hp <= 0;
      const state = lost
        ? "lost"
        : st.stored < 1
          ? "empty"
          : st.wait <= 1e-9 && !st.pending
            ? "ready"
            : `${st.wait.toFixed(1)} s`;
      return {
        kind: h.droneType.replace(/^drone-/, ""),
        stored: st.stored,
        cap: h.capacity,
        state,
        fill: lost || st.stored < 1 ? 0 : 1 - st.wait / Math.max(1e-6, h.launchInterval),
      };
    });
    const left = lRows.reduce((n, r) => n + r.loaded, 0);
    const ammoType = launchers[0]?.def.ammoType;
    const magazine = ship.parts.reduce(
      (n, p) =>
        n + (p.hp > 0 && ammoType && p.def.def.magazine?.ammoType === ammoType ? Math.floor(p.ammo) : 0),
      0,
    );
    const readyL = lRows.filter((r) => r.state === "ready").length;
    const key = JSON.stringify([
      ship.id,
      lRows.map((r) => [r.state, r.loaded, Math.round(r.fill * 20)]),
      hRows.map((r) => [r.state, r.stored, Math.round(r.fill * 20)]),
      magazine,
    ]);
    panel.hidden = false;
    if (key === this.launchPanelKey) return;
    this.launchPanelKey = key;
    const waitOf = (rows: { state: string }[]) => rows.find((r) => r.state.endsWith(" s"))?.state ?? "empty";
    const row = (testid: string, label: string, count: string, state: string, fill: number) =>
      el(
        "div",
        {
          class: `lp-row ${state === "ready" ? "ready" : state === "lost" || state === "empty" ? "off" : "reloading"}`,
          "data-testid": testid,
        },
        el("span", { class: "lp-name" }, label),
        el("span", { class: "lp-count" }, count),
        el(
          "span",
          { class: "lp-bar" },
          el("span", {
            class: "lp-fill",
            style: `width:${Math.round(Math.max(0, Math.min(1, fill)) * 100)}%`,
          }),
        ),
        el("span", { class: "lp-state" }, state),
      );
    panel.replaceChildren();
    if (launchers.length) {
      panel.append(
        el(
          "div",
          { class: "lp-head", "data-testid": "wb-missiles" },
          el("b", {}, "M"),
          ` Missiles · ${readyL}/${launchers.length} ready · ${left + magazine} left `,
          el(
            "span",
            { class: "lp-status", "data-testid": "wb-missiles-status" },
            readyL ? "ready" : waitOf(lRows),
          ),
        ),
        ...lRows.map((r, i) =>
          row(`wb-launcher-${i + 1}`, `Launcher ${i + 1}`, `${r.loaded}/${r.cap}`, r.state, r.fill),
        ),
      );
    }
    if (hangars.length) {
      const stored = hRows.reduce((n, r) => n + r.stored, 0);
      const readyH = hRows.filter((r) => r.state === "ready").length;
      panel.append(
        el(
          "div",
          { class: "lp-head", "data-testid": "wb-drones" },
          el("b", {}, "H"),
          ` Drones · ${stored} aboard `,
          el(
            "span",
            { class: "lp-status", "data-testid": "wb-drones-status" },
            readyH ? "ready" : waitOf(hRows),
          ),
        ),
        ...hRows.map((r, i) =>
          row(`wb-hangar-${i + 1}`, `Hangar ${r.kind}`, `${r.stored}/${r.cap}`, r.state, r.fill),
        ),
      );
    }
  }

  private readonly resultsPanel: HTMLElement;
  private battleShown = false;

  /** Results screen (plan M7 task 2): win or loss, time, damage dealt and taken, parts lost. */
  private showResults(b: Battle): void {
    const t = b.tally;
    const won = b.status === "won";
    const retry = el("button", { "data-testid": "btn-retry" }, "Retry");
    retry.addEventListener("click", () => this.setup?.retry?.());
    const back = el("button", { "data-testid": "btn-results-editor" }, "Back to editor");
    back.addEventListener("click", () => this.onCommand("exit"));
    const row = (k: string, v: string, id: string) =>
      el("div", { class: "row" }, el("span", {}, k), el("b", { "data-testid": `result-${id}` }, v));
    this.resultsPanel.replaceChildren(
      el("h2", { class: won ? "won" : "lost", "data-testid": "result-status" }, won ? "Victory" : "Defeat"),
      el("p", {}, b.reason),
      row("Scenario", b.scenario.name, "scenario"),
      row("Time", `${(b.endTime ?? b.world.time).toFixed(1)} s`, "time"),
      row("Damage dealt", Math.round(t.dealt).toString(), "dealt"),
      row("Damage taken", Math.round(t.taken).toString(), "taken"),
      row("Parts lost", t.partsLost.toString(), "parts"),
      el("div", { class: "actions" }, retry, back),
    );
    this.resultsPanel.hidden = false;
  }

  /** Live power priority panel (P), spec §7.2. Clicking ▲ moves a group up. */
  private renderPowerPanel(): void {
    const ship = this.controlledShip;
    if (!ship || this.powerPanel.hidden) return;
    const pw = ship.power;
    const key =
      ship.powerPriority.join() +
      ship.powerPriority
        .map((g) => `${Math.round(pw.groups[g].factor * 100)}|${Math.round(pw.groups[g].demand / 1000)}`)
        .join();
    if (key === this.powerPanelKey) return;
    this.powerPanelKey = key;
    const rows = ship.powerPriority.map((g: PowerGroup, i) => {
      const { demand, factor } = pw.groups[g];
      const cls = demand <= 0 ? "dim" : factor >= 0.999 ? "" : factor > 0 ? "warn" : "alert";
      return `<div class="row ${cls}"><span>${i + 1}. ${g}</span><span>${demand > 0 ? `${(demand / 1000).toFixed(0)} kW · ${Math.round(factor * 100)}%` : "idle"}</span><button data-group="${g}" data-testid="power-up-${g}" ${i === 0 ? "disabled" : ""}>▲</button></div>`;
    });
    this.powerPanel.innerHTML = `<h3>Power priority <span class="dim">(P)</span></h3>${rows.join("")}<p class="dim">Higher groups are served first; the first group that does not fit shares what is left.</p>`;
    for (const b of this.powerPanel.querySelectorAll("button[data-group]")) {
      b.addEventListener("click", () => {
        const g = (b as HTMLElement).dataset.group as PowerGroup;
        const order = [...ship.powerPriority];
        const i = order.indexOf(g);
        if (i > 0) [order[i - 1], order[i]] = [order[i]!, order[i - 1]!];
        ship.powerPriority = order;
        this.powerPanelKey = "";
        this.renderPowerPanel();
      });
    }
  }

  /** Screen position of a ship's centre of mass (test helper). */
  screenOfShip(id: string): { x: number; y: number } | null {
    const w = this.setup?.world;
    if (!w || !w.hasShip(id)) return null;
    return this.camera.worldToScreen(w.physics.getWorldCenter(id));
  }

  /** Screen position of a part's centre on the controlled ship (test helper). */
  screenOfPart(uid: string): { x: number; y: number } | null {
    const w = this.setup?.world;
    const ship = this.controlledShip;
    const part = ship?.parts.find((p) => p.uid === uid);
    if (!w || !ship || !part) return null;
    const s = w.physics.getBodyState(ship.id);
    const c = partCentroid(part);
    const r = rot(c, s.angle);
    return this.camera.worldToScreen({ x: s.position.x + r.x, y: s.position.y + r.y });
  }

  /** RMB: target the ship nearest the cursor (within 60 px); RMB on empty space clears the target. */
  private pickTarget(screen: { x: number; y: number }): void {
    const world = this.setup?.world;
    const me = this.controlledShip;
    if (!world || !me) return;
    let best: string | null = null;
    let bestD = 60;
    for (const other of world.allShips()) {
      if (other === me) continue;
      const c = this.camera.worldToScreen(world.physics.getWorldCenter(other.id));
      const d = Math.hypot(c.x - screen.x, c.y - screen.y) - other.layout.boundingRadius * this.camera.zoom;
      if (d < bestD) {
        bestD = d;
        best = other.id;
      }
    }
    this.targetId = best;
  }

  /** Part of the controlled ship under a screen point, or null (eject mode). */
  private partUnder(screen: { x: number; y: number }): string | null {
    const world = this.setup?.world;
    const ship = this.controlledShip;
    if (!world || !ship) return null;
    const p = this.camera.screenToWorld(screen);
    const s = world.physics.getBodyState(ship.id);
    return ship.layout.partAt(rot({ x: p.x - s.position.x, y: p.y - s.position.y }, -s.angle));
  }

  /** Eject mode click: jettison the clicked part (not the command module). */
  private ejectAt(screen: { x: number; y: number }): void {
    const uid = this.partUnder(screen);
    if (uid) this.controlledShip?.requestEject(uid);
  }

  /** Current scenario battle, if any. */
  get battle(): Battle | null {
    return this.setup?.battle ?? null;
  }

  /** Ids of the player's ships (test helper). */
  playerIds(): string[] {
    return this.setup?.playerShips.map((s) => s.id) ?? [];
  }

  /** Allied ships: the player's other ships, flown by the AI (spec §11.3). */
  private allies(): Ship[] {
    const setup = this.setup;
    if (!setup) return [];
    return setup.playerShips.filter((_, i) => i !== this.controlled);
  }

  /** Hands every ally to the AI following the controlled ship (keeps existing orders). */
  private assignAllies(previous?: string): void {
    const world = this.setup?.world;
    const me = this.controlledShip;
    if (!world || !me) return;
    world.clearAi(me.id);
    this.selectedAllies.delete(me.id);
    this.allies().forEach((s, i) => {
      const st = world.ai.get(s.id);
      if (!st) world.setAi(s.id, this.allyProfile, { kind: "follow", leader: me.id }, i);
      else {
        st.slot = i;
        if (st.order?.kind === "follow" || s.id === previous) st.order = { kind: "follow", leader: me.id };
      }
    });
  }

  /** J / K / L: orders for the selected allies (all when none are selected), also while paused. */
  private giveOrder(kind: Order["kind"]): void {
    const world = this.setup?.world;
    const me = this.controlledShip;
    if (!world || !me) return;
    const targets = this.allies().filter(
      (s) => this.selectedAllies.size === 0 || this.selectedAllies.has(s.id),
    );
    for (const s of targets) {
      const st = world.ai.get(s.id);
      if (!st) continue;
      if (kind === "follow") st.order = { kind: "follow", leader: me.id };
      else if (kind === "attack") {
        if (!this.targetId) continue;
        st.order = { kind: "attack", target: this.targetId };
      } else st.order = { kind: "hold", point: world.physics.getWorldCenter(s.id) };
      st.nextEval = 0;
    }
  }

  /** Ctrl+click: select the ally nearest the cursor (Ctrl+Shift adds); on empty space, clear. */
  private selectAllyAt(screen: { x: number; y: number }, add: boolean): void {
    const world = this.setup?.world;
    if (!world) return;
    let best: string | null = null;
    let bestD = 60;
    for (const s of this.allies()) {
      const c = this.camera.worldToScreen(world.physics.getWorldCenter(s.id));
      const d = Math.hypot(c.x - screen.x, c.y - screen.y) - s.layout.boundingRadius * this.camera.zoom;
      if (d < bestD) {
        bestD = d;
        best = s.id;
      }
    }
    if (!add) this.selectedAllies.clear();
    if (best) {
      if (add && this.selectedAllies.has(best)) this.selectedAllies.delete(best);
      else this.selectedAllies.add(best);
    }
  }

  /** Debug destroy tool: hold Y and click a part (plan M3 task 10). */
  private killAt(screen: { x: number; y: number }): void {
    const world = this.setup?.world;
    if (!world) return;
    const p = this.camera.screenToWorld(screen);
    for (const ship of world.allShips()) {
      const s = world.physics.getBodyState(ship.id);
      const local = rot({ x: p.x - s.position.x, y: p.y - s.position.y }, -s.angle);
      for (const part of ship.parts) {
        if (part.hp <= 0) continue;
        if (partPiecesShipFrame(part).some((piece) => pointInPolygon(local, piece))) {
          ship.destroyPart(part.uid);
          return;
        }
      }
    }
  }

  get world(): World | null {
    return this.setup?.world ?? null;
  }

  get controlledShip(): Ship | null {
    return this.setup?.playerShips[this.controlled] ?? null;
  }

  start(setup: FlightSetup): void {
    this.stop();
    this.setup = setup;
    this.controlled = 0;
    this.paused = false;
    this.targetId = null;
    this.debugTrigger = false;
    this.selectedAllies.clear();
    this.selectedGroups.clear();
    this.selectedGroups.add(1);
    this.scene = new Scene(this.theme, this.app);
    this.scene.showOverlays = this.showOverlays;
    this.scene.showNetworks = this.showNetworks;
    this.camera.mode = "follow-target";
    this.camera.userZoom = 1;
    const ship = setup.playerShips[0];
    if (ship) this.camera.center = setup.world.physics.getWorldCenter(ship.id);
    this.input.speedKillActive = () => this.controlledShip?.flight.speedKill !== "off";
    this.battleShown = false;
    // Every flight starts at real time (a left-over ×8 made the game look uncontrollably fast).
    this.timeScaleIndex = TIME_SCALES.indexOf(1);
    this.paused = false;
    this.resultsPanel.hidden = true;
    this.weaponBar.hidden = true;
    this.launchPanel.hidden = true;
    if (setup.spectate) {
      // Keep AI that the battle already set up (skirmish types and guard orders).
      for (const s of setup.playerShips)
        if (!setup.world.ai.has(s.id)) setup.world.setAi(s.id, this.allyProfile);
    } else this.assignAllies();
    this.input.enabled = true;
    this.input.takeCommands();
    this.hudEl.hidden = false;
    this.loop = new FixedStepLoop(
      () => {
        const w = setup.world;
        this.scene!.capture(w);
        if (setup.spectate) {
          w.step();
          if (setup.battle) updateBattle(setup.battle);
          return;
        }
        const s = this.controlledShip!;
        const center = w.physics.getWorldCenter(s.id);
        const mouseWorld = this.camera.screenToWorld(this.input.mouse);
        w.setIntent(s.id, this.input.takeIntent(angleOf(sub(mouseWorld, center))));
        if (this.targetId && !w.hasShip(this.targetId)) this.targetId = null;
        s.weaponCommand = {
          trigger: this.input.leftHeld || this.debugTrigger,
          aimPoint: mouseWorld,
          selected: new Set(this.selectedGroups),
          targetId: this.targetId,
          launch: this.pendingLaunch,
        };
        this.pendingLaunch = false;
        w.step();
        if (setup.battle) updateBattle(setup.battle);
      },
      undefined,
      // ×8 time needs 8 ticks per 60 Hz frame; allow slower frames to catch up too.
      16,
    );
  }

  stop(): void {
    this.scene?.destroy();
    this.scene = null;
    this.setup = null;
    this.loop = null;
    this.input.enabled = false;
    this.hudEl.hidden = true;
    this.powerPanel.hidden = true;
    this.resultsPanel.hidden = true;
    this.weaponBar.hidden = true;
    this.launchPanel.hidden = true;
  }

  frame(dtReal: number): void {
    const setup = this.setup;
    const scene = this.scene;
    if (!setup || !scene || !this.loop) return;
    this.fps = this.fps * 0.95 + (dtReal > 0 ? 1 / dtReal : 60) * 0.05;
    const ships = setup.playerShips;
    for (const cmd of this.input.takeCommands()) {
      if (setup.spectate && !SPECTATOR_COMMANDS.has(cmd)) continue;
      switch (cmd) {
        case "camera-mode":
          this.camera.mode =
            CAMERA_MODES[(CAMERA_MODES.indexOf(this.camera.mode) + 1) % CAMERA_MODES.length]!;
          break;
        case "switch-ship": {
          this.input.ejectMode = false;
          const prev = ships[this.controlled]!;
          if (setup.spectate) {
            this.controlled = (this.controlled + 1) % ships.length;
            break;
          }
          setup.world.setIntent(prev.id, IDLE_INTENT);
          prev.weaponCommand = { ...prev.weaponCommand, trigger: false };
          this.controlled = (this.controlled + 1) % ships.length;
          // The previous ship goes to the AI on this same frame; the new one leaves it (spec §11.3).
          if (!setup.spectate) this.assignAllies(prev.id);
          break;
        }
        case "order-follow":
          this.giveOrder("follow");
          break;
        case "order-attack":
          this.giveOrder("attack");
          break;
        case "order-hold":
          this.giveOrder("hold");
          break;
        case "pause":
          this.paused = !this.paused;
          break;
        case "time-faster":
          this.timeScaleIndex = Math.min(TIME_SCALES.length - 1, this.timeScaleIndex + 1);
          break;
        case "time-slower":
          this.timeScaleIndex = Math.max(0, this.timeScaleIndex - 1);
          break;
        case "overlays":
          this.showOverlays = !this.showOverlays;
          scene.showOverlays = this.showOverlays;
          break;
        case "help":
          this.showHelp = !this.showHelp;
          break;
        case "face-cursor":
          break;
        case "power-panel":
          this.powerPanel.hidden = !this.powerPanel.hidden;
          this.powerPanelKey = "";
          break;
        case "radiators": {
          const s = this.controlledShip;
          if (s) s.radiatorsExtended = !s.radiatorsExtended;
          break;
        }
        case "cycle-group-mode": {
          const ship = this.controlledShip;
          if (!ship) break;
          const order = ["manual", "hold", "ai"] as const;
          for (const g of this.selectedGroups) {
            const cur = ship.groupModes.get(g) ?? "manual";
            ship.groupModes.set(g, order[(order.indexOf(cur) + 1) % order.length]!);
          }
          break;
        }
        case "networks":
          this.showNetworks = !this.showNetworks;
          scene.showNetworks = this.showNetworks;
          break;
        case "launch-missile":
          if (this.controlledShip) this.pendingLaunch = "one";
          break;
        case "launch-salvo":
          if (this.controlledShip) this.pendingLaunch = "salvo";
          break;
        case "launch-drone":
          this.controlledShip?.launchOneDrone();
          break;
        case "launch-drones":
          this.controlledShip?.requestDroneLaunch();
          break;
        case "pd-ships": {
          const ship = this.controlledShip;
          if (ship) ship.pdEngageShips = !ship.pdEngageShips;
          break;
        }
        case "eject-wrecks": {
          const ship = this.controlledShip;
          if (ship) for (const p of ship.parts) if (p.hp <= 0) ship.requestEject(p.uid);
          break;
        }
        default:
          this.onCommand(cmd);
      }
    }
    if (this.setup !== setup) return; // a command ended the session
    if (setup.spectate) {
      this.input.takeClicks();
      this.input.takeGroupKeys();
      this.input.takeRightClicks();
    }
    for (const c of this.input.takeClicks()) {
      if (c.kill) this.killAt(c);
      else if (c.select) this.selectAllyAt(c, c.add);
      else if (c.eject) this.ejectAt(c);
    }
    for (const k of this.input.takeGroupKeys()) {
      if (k.add) {
        if (this.selectedGroups.has(k.group) && this.selectedGroups.size > 1)
          this.selectedGroups.delete(k.group);
        else this.selectedGroups.add(k.group);
      } else {
        this.selectedGroups.clear();
        this.selectedGroups.add(k.group);
      }
    }
    for (const c of this.input.takeRightClicks()) this.pickTarget(c);
    const wheel = this.input.takeWheel();
    if (wheel !== 0) this.camera.zoomBy(Math.pow(1.0015, -wheel));
    const drag = this.input.takeDrag();
    if (this.camera.mode === "free" && (drag.x !== 0 || drag.y !== 0)) this.camera.pan(drag.x, drag.y);

    const { alpha } = this.loop.advance(this.paused ? 0 : dtReal * TIME_SCALES[this.timeScaleIndex]!);
    const world = setup.world;
    const ship = ships[this.controlled]!;
    this.camera.resize(this.app.screen.width, this.app.screen.height);
    const me = scene.shipCenter(ship, world, alpha);
    let target: { x: number; y: number } | null = null;
    let best = Infinity;
    if (this.targetId && world.hasShip(this.targetId)) {
      target = scene.shipCenter(world.getShip(this.targetId), world, alpha);
      best = 0;
    }
    for (const other of world.allShips()) {
      if (other === ship || best === 0) continue;
      const c = scene.shipCenter(other, world, alpha);
      const d = Math.hypot(c.x - me.x, c.y - me.y);
      if (d < best && d < 3000) {
        best = d;
        target = c;
      }
    }
    const radius = Math.max(...ship.parts.map((p) => Math.hypot(p.position.x, p.position.y))) + 2;
    this.camera.update(me, radius, target, dtReal);
    scene.targetId = this.targetId;
    const hoverUid = this.input.ejectMode ? this.partUnder(this.input.mouse) : null;
    scene.eject = this.input.ejectMode ? { shipId: ship.id, hoverUid } : null;
    scene.render(world, this.camera, alpha);
    const battle = setup.battle;
    if (battle && battle.status !== "running" && !this.battleShown) {
      this.battleShown = true;
      setup.onBattleEnd?.(battle);
      this.showResults(battle);
    }
    this.hud.update({
      objective: battle ? objectiveLine(battle) : null,
      ship,
      world,
      paused: this.paused,
      timeScale: TIME_SCALES[this.timeScaleIndex]!,
      cameraMode: this.camera.mode,
      theme: this.themeName(),
      faceCursor: this.input.faceCursor,
      showHelp: this.showHelp,
      fps: this.fps,
      title: setup.title,
      selectedGroups: this.selectedGroups,
      targetId: this.targetId,
      eject: this.input.ejectMode ? { hoverUid } : null,
      allies: this.allies().map((s) => {
        const st = world.ai.get(s.id);
        return {
          ship: s,
          order: st?.order?.kind ?? "-",
          behaviour: st?.behaviour ?? "-",
          selected: this.selectedAllies.has(s.id),
        };
      }),
      targetAi: (() => {
        const st = this.targetId ? world.ai.get(this.targetId) : undefined;
        if (!st || !this.showOverlays) return null;
        const top = Object.entries(st.scores)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([k, v]) => `${k} ${v.toFixed(2)}`)
          .join(", ");
        return `${st.profile.id}: ${st.behaviour} (${top})`;
      })(),
    });
    this.renderPowerPanel();
    this.renderWeaponBar();
  }
}

/** HUD objective line: what to do and how far along (survive: time left; protect: escort hull). */
function objectiveLine(b: Battle): string {
  const o = b.scenario.objective;
  const left = b.enemyShips.filter((s) => !s.defeated).length;
  if (b.status !== "running") return b.status === "won" ? "complete" : "failed";
  if (o.type === "survive")
    return `survive ${Math.max(0, o.seconds - b.world.time).toFixed(0)} s more · ${left} enemies`;
  if (o.type === "protect" && b.protectId && b.world.hasShip(b.protectId)) {
    const p = b.world.getShip(b.protectId);
    const hp =
      p.parts.reduce((t, x) => t + Math.max(0, x.hp), 0) / p.parts.reduce((t, x) => t + x.def.def.hp, 0);
    return `protect ${p.design.name.split(" (")[0]} (hull ${Math.round(hp * 100)} %) · ${left} enemies left`;
  }
  return `destroy all enemies · ${left} left`;
}
