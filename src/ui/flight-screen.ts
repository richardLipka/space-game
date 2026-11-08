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

export interface FlightSetup {
  readonly world: World;
  /** Ships the player can control (Tab cycles). */
  readonly playerShips: Ship[];
  /** Label shown in the HUD (e.g. "Test flight"). */
  readonly title: string;
}

const TIME_SCALES = [0.25, 0.5, 1, 2] as const;

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

  /** Debug destroy tool: hold K and click a part (plan M3 task 10). */
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
    this.input.enabled = true;
    this.input.takeCommands();
    this.hudEl.hidden = false;
    this.loop = new FixedStepLoop(() => {
      const w = setup.world;
      this.scene!.capture(w);
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
      };
      w.step();
    });
  }

  stop(): void {
    this.scene?.destroy();
    this.scene = null;
    this.setup = null;
    this.loop = null;
    this.input.enabled = false;
    this.hudEl.hidden = true;
    this.powerPanel.hidden = true;
  }

  frame(dtReal: number): void {
    const setup = this.setup;
    const scene = this.scene;
    if (!setup || !scene || !this.loop) return;
    this.fps = this.fps * 0.95 + (dtReal > 0 ? 1 / dtReal : 60) * 0.05;
    const ships = setup.playerShips;
    for (const cmd of this.input.takeCommands()) {
      switch (cmd) {
        case "camera-mode":
          this.camera.mode =
            CAMERA_MODES[(CAMERA_MODES.indexOf(this.camera.mode) + 1) % CAMERA_MODES.length]!;
          break;
        case "switch-ship":
          this.input.ejectMode = false;
          setup.world.setIntent(ships[this.controlled]!.id, IDLE_INTENT);
          ships[this.controlled]!.weaponCommand = {
            ...ships[this.controlled]!.weaponCommand,
            trigger: false,
          };
          this.controlled = (this.controlled + 1) % ships.length;
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
    for (const c of this.input.takeClicks()) {
      if (c.kill) this.killAt(c);
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
    this.hud.update({
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
    });
    this.renderPowerPanel();
  }
}
