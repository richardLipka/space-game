import type { ControlIntent } from "../sim/flight/controller";
import type { Vec2 } from "../sim/core/vec2";

/** Discrete UI commands raised by key presses (handled by the app, not the sim). */
export type UiCommand =
  | "camera-mode"
  | "switch-ship"
  | "pause"
  | "time-faster"
  | "time-slower"
  | "theme"
  | "overlays"
  | "face-cursor"
  | "help"
  | "exit"
  | "power-panel"
  | "radiators"
  | "networks"
  | "cycle-group-mode"
  | "eject-wrecks"
  | "launch-missile"
  | "launch-salvo"
  | "launch-drone"
  | "launch-drones"
  | "pd-ships"
  | "order-follow"
  | "order-attack"
  | "order-hold"
  | "missile-type"
  | "drone-type"
  | "drive-mode";

/**
 * Layout-independent key name: letters, digits and the time-scale keys by their physical position
 * (`KeyboardEvent.code`), so a Czech, German or French layout works like US QWERTY. On a Czech layout the
 * key above Q types "+", which must still select group 1, not speed the game up.
 */
export function keyName(e: Pick<KeyboardEvent, "code" | "key" | "shiftKey">): string {
  const code = e.code ?? "";
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^(Digit|Numpad)[0-9]$/.test(code)) return `digit${code.slice(-1)}`;
  switch (code) {
    case "Space":
      return " ";
    case "Tab":
      return "tab";
    case "Escape":
      return "escape";
    case "F1":
      return "f1";
    case "Equal":
    case "NumpadAdd":
    case "BracketRight":
      return "+";
    case "Minus":
    case "NumpadSubtract":
    case "BracketLeft":
      return "-";
  }
  // Synthetic events without a code, and keys not covered above.
  const k = e.key.toLowerCase();
  if (/^[0-9]$/.test(k)) return `digit${k}`;
  return k;
}

export interface Click {
  readonly x: number;
  readonly y: number;
  readonly kill: boolean;
  readonly eject: boolean;
  readonly select: boolean;
  readonly add: boolean;
}

/**
 * Keyboard/mouse → ControlIntent (spec §10). Continuous axes come from held keys; one-shot commands
 * (speed kill) stay pending until a simulation tick consumes them via `takeIntent`.
 */
export class InputController {
  private readonly held = new Set<string>();
  private pendingSpeedKill: "keep" | "flip" | "cancel" | undefined;
  faceCursor = false;
  /** Mouse position in screen pixels. */
  mouse: Vec2 = { x: 0, y: 0 };
  wheel = 0;
  private dragging = false;
  private dragDelta: Vec2 = { x: 0, y: 0 };
  private readonly commands: UiCommand[] = [];
  /**
   * Left clicks on the canvas since the last read: `kill` when Y was held (debug destroy tool), `select`
   * with Ctrl (pick allies for orders; `add` with Ctrl+Shift).
   */
  private clicks: Click[] = [];
  /** Eject mode (B): left clicks jettison the part under the cursor instead of firing. */
  ejectMode = false;
  /** Right clicks (target selection). */
  private rightClicks: { x: number; y: number }[] = [];
  /** Group keys pressed: 1–9, add = Shift held (spec §9.2). */
  private groupKeys: { group: number; add: boolean }[] = [];
  /** Left mouse button held on the canvas (fire trigger). */
  leftHeld = false;
  /** Set by the app so X can toggle: cancel when active. */
  speedKillActive: () => boolean = () => false;
  /** When false, all input is ignored (another screen owns the keyboard). */
  enabled = false;

  attach(target: Window, canvas: HTMLCanvasElement): void {
    target.addEventListener("keydown", (e) => {
      if (!this.enabled) return;
      if ((e.target as HTMLElement | null)?.closest?.("input, textarea, select")) return;
      const k = keyName(e);
      if (["tab", " ", "w", "a", "s", "d", "q", "e", "f1"].includes(k)) e.preventDefault();
      if (e.repeat) {
        this.held.add(k);
        return;
      }
      this.held.add(k);
      switch (k) {
        case "x":
          this.pendingSpeedKill = e.shiftKey ? "flip" : this.speedKillActive() ? "cancel" : "keep";
          break;
        case "c":
          this.commands.push("camera-mode");
          break;
        case "tab":
          this.commands.push("switch-ship");
          break;
        case " ":
          this.commands.push("pause");
          break;
        case "+":
          this.commands.push("time-faster");
          break;
        case "-":
          this.commands.push("time-slower");
          break;
        case "t":
          this.commands.push("theme");
          break;
        case "v":
          this.commands.push("overlays");
          break;
        case "f":
          this.faceCursor = !this.faceCursor;
          this.commands.push("face-cursor");
          break;
        case "?":
        case "f1":
          this.commands.push("help");
          break;
        case "m":
          this.commands.push(e.shiftKey ? "launch-salvo" : "launch-missile");
          break;
        case "h":
          this.commands.push(e.shiftKey ? "launch-drones" : "launch-drone");
          break;
        case "o":
          this.commands.push("pd-ships");
          break;
        case "j":
          this.commands.push("order-follow");
          break;
        case "k":
          this.commands.push("order-attack");
          break;
        case "l":
          this.commands.push("order-hold");
          break;
        case "escape":
          if (this.ejectMode) this.ejectMode = false;
          else this.commands.push("exit");
          break;
        case "b":
          if (e.shiftKey) this.commands.push("eject-wrecks");
          else {
            this.ejectMode = !this.ejectMode;
            this.leftHeld = false;
          }
          break;
        case "p":
          this.commands.push("power-panel");
          break;
        case "r":
          this.commands.push("radiators");
          break;
        case "n":
          this.commands.push("networks");
          break;
        case "g":
          this.commands.push("cycle-group-mode");
          break;
        case "z":
          this.commands.push("missile-type");
          break;
        case "u":
          this.commands.push("drone-type");
          break;
        case "i":
          this.commands.push("drive-mode");
          break;
        default:
          // Group keys 1–9: the row above the letters (any layout) or the numpad.
          if (/^digit[1-9]$/.test(k)) this.groupKeys.push({ group: Number(k.slice(5)), add: e.shiftKey });
      }
    });
    target.addEventListener("keyup", (e) => this.held.delete(keyName(e)));
    target.addEventListener("blur", () => {
      this.held.clear();
      this.leftHeld = false;
    });
    canvas.addEventListener("mousemove", (e) => {
      if (!this.enabled) return;
      if (this.dragging)
        this.dragDelta = { x: this.dragDelta.x + e.movementX, y: this.dragDelta.y + e.movementY };
      this.mouse = { x: e.offsetX, y: e.offsetY };
    });
    canvas.addEventListener("mousedown", (e) => {
      if (!this.enabled) return;
      if (e.button === 0) {
        const kill = this.held.has("y");
        const select = e.ctrlKey && !kill;
        this.clicks.push({
          x: e.offsetX,
          y: e.offsetY,
          kill,
          eject: this.ejectMode && !kill && !select,
          select,
          add: select && e.shiftKey,
        });
        if (!kill && !select && !this.ejectMode) this.leftHeld = true;
      }
      if (e.button === 2) this.rightClicks.push({ x: e.offsetX, y: e.offsetY });
      if (e.button === 1) {
        this.dragging = true;
        e.preventDefault();
      }
    });
    target.addEventListener("mouseup", (e) => {
      this.dragging = false;
      if (e.button === 0) this.leftHeld = false;
    });
    canvas.addEventListener(
      "wheel",
      (e) => {
        if (!this.enabled) return;
        this.wheel += e.deltaY;
        e.preventDefault();
      },
      { passive: false },
    );
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  /** Current intent; consumes pending one-shot commands. `faceAngle` is supplied by the caller (needs world state). */
  takeIntent(faceAngle: number | undefined): ControlIntent {
    const h = (k: string) => (this.held.has(k) ? 1 : 0);
    const rotate = h("q") - h("e");
    const intent: ControlIntent = {
      thrust: { x: h("w") - h("s"), y: h("a") - h("d") },
      rotate,
      faceAngle: this.faceCursor && rotate === 0 ? faceAngle : undefined,
      speedKill: this.pendingSpeedKill,
    };
    this.pendingSpeedKill = undefined;
    return intent;
  }

  takeCommands(): UiCommand[] {
    return this.commands.splice(0);
  }

  takeClicks(): Click[] {
    return this.clicks.splice(0);
  }

  takeRightClicks(): { x: number; y: number }[] {
    return this.rightClicks.splice(0);
  }

  takeGroupKeys(): { group: number; add: boolean }[] {
    return this.groupKeys.splice(0);
  }

  takeWheel(): number {
    const w = this.wheel;
    this.wheel = 0;
    return w;
  }

  takeDrag(): Vec2 {
    const d = this.dragDelta;
    this.dragDelta = { x: 0, y: 0 };
    return d;
  }
}
