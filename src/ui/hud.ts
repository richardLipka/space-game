import type { Ship } from "../sim/ship/ship-entity";
import type { World } from "../sim/world";
import { capabilities } from "../sim/flight/propulsion";
import { nearBoundary } from "../sim/physics/forces";
import { length, radToDeg, sub } from "../sim/core/vec2";
import { el } from "./editor/dom";
import { hullFraction, ShipPlan, systemStatus } from "./hud/ship-plan";

/** A ship in the contacts list. */
export interface Contact {
  readonly ship: Ship;
  /** Same team as the pilot. */
  readonly friendly: boolean;
  /** Friendly AI ship that takes orders. */
  readonly commandable: boolean;
  readonly order: string;
  readonly behaviour: string;
  /** Picked for orders (Ctrl+click or a click on its row). */
  readonly selected: boolean;
}

/** What the pilot can do from the HUD panels. */
export interface HudActions {
  /** Make a ship the pilot's target. */
  target(id: string): void;
  /** Order one friendly ship, or (no id) the selected ones, or all when none are selected. */
  order(kind: OrderKind, id?: string): void;
  /** Ask every friendly ship to attack whoever is attacking the pilot. */
  help(): void;
  /** Toggle an enemy as the fleet's priority target. */
  priority(id: string): void;
  /** Pick a friendly ship for orders (add = keep the others picked). */
  select(id: string, add: boolean): void;
  /** Watch mode: follow this ship with the camera. */
  watch(id: string): void;
}

export type OrderKind = "follow" | "attack" | "hold" | "guard" | "free";

export interface HudInfo {
  readonly ship: Ship;
  readonly world: World;
  readonly paused: boolean;
  readonly timeScale: number;
  readonly cameraMode: string;
  readonly theme: string;
  readonly faceCursor: boolean;
  readonly showHelp: boolean;
  readonly fps: number;
  readonly title?: string;
  /** Scenario objective and progress. */
  readonly objective?: string | null;
  readonly targetId?: string | null;
  /** Every other ship in the arena (drones are only counted). */
  readonly contacts: readonly Contact[];
  /** Enemy the fleet was told to attack first. */
  readonly priorityId?: string | null;
  /** Watch mode: no ship is flown, the panels only show the followed ship. */
  readonly spectate?: boolean;
  /** Target's AI state (debug view, overlays on): behaviour and top utility scores. */
  readonly targetAi?: string | null;
  /** Eject mode is on; the part under the cursor, if any. */
  readonly eject?: { readonly hoverUid: string | null } | null;
}

const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
const shortName = (s: Ship) => s.design.name.split(" (")[0]!;
const kw = (w: number) => (w >= 1e6 ? `${(w / 1e6).toFixed(1)} MW` : `${(w / 1000).toFixed(0)} kW`);
const kn = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)} MN` : `${(n / 1000).toFixed(0)} kN`);
const metres = (d: number) =>
  d >= 10000
    ? `${(d / 1000).toFixed(0)} km`
    : d >= 1000
      ? `${(d / 1000).toFixed(1)} km`
      : `${d.toFixed(0)} m`;
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const wrapDeg = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;

const HELP = `FLIGHT    W/S thrust · A/D strafe · Q/E rotate · F face cursor · X speed kill · Shift+X flip & burn
WEAPONS   LMB fire · 1–9 weapon group (Shift adds) · G group mode · RMB target (or click a contact)
ORDNANCE  M launch a missile (Shift+M salvo) · H launch a drone (Shift+H all) · O PD also fires at ships
FLEET     J follow · K attack my target · L hold · Ctrl+click or click a contact to pick ships (Shift adds)
          contacts panel: Help me, Protect me, ★ priority target, orders per ship
SHIP      P power priority · R radiators · N networks · B eject mode (click a part) · Shift+B eject all wrecks
          Tab switch ship · hold Y + click: destroy part (debug)
VIEW      C camera · wheel zoom · middle-drag pan (free cam) · V overlays · T theme
TIME      +/- or [ ] time scale (×1 at start) · Space pause · ? help · Esc editor`;

/** Sets text, class or HTML only when it changed (the HUD is refreshed every frame). */
const cache = new WeakMap<Element, { t?: string; c?: string; h?: string; s?: string }>();
const memo = (n: Element) => {
  let m = cache.get(n);
  if (!m) cache.set(n, (m = {}));
  return m;
};
function txt(n: Element, s: string): void {
  const m = memo(n);
  if (m.t !== s) {
    m.t = s;
    n.textContent = s;
  }
}
function cls(n: Element, c: string): void {
  const m = memo(n);
  if (m.c !== c) {
    m.c = c;
    n.setAttribute("class", c);
  }
}
function html(n: Element, h: string): void {
  const m = memo(n);
  if (m.h !== h) {
    m.h = h;
    n.innerHTML = h;
  }
}
function css(n: HTMLElement, s: string): void {
  const m = memo(n);
  if (m.s !== s) {
    m.s = s;
    n.style.cssText = s;
  }
}

interface Gauge {
  readonly root: HTMLElement;
  readonly fill: HTMLElement;
  readonly value: HTMLElement;
  readonly detail: HTMLElement;
}

function gauge(label: string, id: string): Gauge {
  const fill = el("i");
  const value = el("span", { class: "ck-value" });
  const detail = el("div", { class: "ck-detail" });
  const root = el(
    "div",
    { class: "ck-inst", "data-testid": `inst-${id}` },
    el(
      "div",
      { class: "ck-gauge-row" },
      el("span", { class: "ck-label" }, label),
      el("span", { class: "ck-gauge" }, fill),
      value,
    ),
    detail,
  );
  return { root, fill, value, detail };
}

function setGauge(g: Gauge, frac: number, state: "" | "warn" | "alert" = ""): void {
  css(g.fill, `width:${(clamp01(frac) * 100).toFixed(1)}%`);
  cls(g.root, `ck-inst${state ? ` ${state}` : ""}`);
}

function panel(
  title: string,
  id: string,
  ...body: (Node | string)[]
): { root: HTMLElement; head: HTMLElement } {
  const head = el("span", { class: "ck-head-info" });
  const root = el(
    "section",
    { class: `ck-panel ck-${id}`, "data-testid": `panel-${id}` },
    el("header", { class: "ck-head" }, el("span", { class: "ck-head-title" }, title), head),
    ...body,
  );
  return { root, head };
}

/** Heading tape: pixels per degree and the degrees drawn either side of 0–360. */
const TAPE_PX = 3;
const TAPE_PAD = 180;

interface Row {
  readonly root: HTMLElement;
  readonly arrow: HTMLElement;
  readonly name: HTMLElement;
  readonly dist: HTMLElement;
  readonly hull: HTMLElement;
  readonly pct: HTMLElement;
  readonly sub: HTMLElement;
  readonly star: HTMLElement | null;
}

/**
 * Cockpit HUD (spec §13.7): plain DOM around the edge of the screen, styled by the theme stylesheet.
 *   top     status bar, heading tape, alerts
 *   left    helm instruments (speed, thrust, fuel, heat, power) and the own ship's damage plan
 *   right   target damage plan, contacts with orders, ordnance (missiles, drones, PD)
 *   bottom  fire control (weapon groups and magazines)
 * The panels are built once; every frame only the values that changed are written.
 */
export class Hud {
  /** Slots the flight screen fills: weapon groups (bottom) and launchers/hangars (right). */
  readonly fireControlSlot: HTMLElement;
  readonly ordnanceSlot: HTMLElement;

  private readonly title = el("b", { class: "ck-title" });
  private readonly objective = el("span", { class: "ck-objective", "data-testid": "objective" });
  private readonly clock = el("span", { class: "ck-clock" });
  private readonly alerts = el("div", { class: "ck-alerts", "data-testid": "alerts" });
  private readonly tapeStrip = el("div", { class: "ck-tape-strip" });
  private readonly tapeCourse = el("span", { class: "ck-tape-course" }, "▲");
  private readonly tapeValue = el("span", { class: "ck-tape-value" });
  private readonly help = el("pre", { class: "ck-help", "data-testid": "help", hidden: "" }, HELP);
  private readonly ejectBanner = el("div", { class: "ck-eject", hidden: "" });

  private readonly shipName = el("b", { "data-testid": "ship-name" });
  private readonly speed = el("span", { class: "ck-big", "data-testid": "speed" });
  private readonly nav = el("div", { class: "ck-nav" });
  private readonly gThrust = gauge("THRUST", "thrust");
  private readonly gFuel = gauge("FUEL", "fuel");
  private readonly gHeat = gauge("HEAT", "heat");
  private readonly gPower = gauge("POWER", "power");
  private readonly gBatt = gauge("BATT", "battery");
  private readonly modes = el("div", { class: "ck-modes" });

  private readonly ownPlan = new ShipPlan();
  private readonly ownHull = el("span", { "data-testid": "own-hull" });
  private readonly ownSystems = el("div", { class: "ck-systems" });
  private readonly ownReadout = el("div", { class: "ck-readout" });

  private readonly targetPlan = new ShipPlan();
  private readonly targetPanel: HTMLElement;
  private readonly targetName = el("span", { "data-testid": "target" });
  private readonly targetData = el("div", { class: "ck-target-data" });
  private readonly targetSystems = el("div", { class: "ck-systems" });
  private readonly targetReadout = el("div", { class: "ck-readout" });

  private readonly contactsHead: HTMLElement;
  private readonly fleetButtons = el("div", { class: "ck-fleet" });
  private readonly contactList = el("div", { class: "ck-contacts-list", "data-testid": "contacts" });
  private readonly allyList = el("div", { class: "ck-contact-group", "data-testid": "allies" });
  private readonly foeList = el("div", { class: "ck-contact-group", "data-testid": "hostiles" });
  private readonly droneLine = el("div", { class: "ck-contact-drones" });
  private readonly leftCol: HTMLElement;
  private readonly rightCol: HTMLElement;
  private readonly tape: HTMLElement;
  private readonly rows = new Map<string, Row>();
  private rowsKey = "";
  private order: string[] = [];
  private sortedAt = -Infinity;
  private contactsHover = false;

  constructor(
    root: HTMLElement,
    private readonly actions: HudActions,
  ) {
    root.classList.add("cockpit");
    this.fireControlSlot = el("div", { class: "ck-bottom" });
    this.ordnanceSlot = el("div", { class: "ck-ordnance-slot" });

    // Heading tape: a tick every 10°, a label every 30°.
    for (let d = -TAPE_PAD; d <= 360 + TAPE_PAD; d += 10) {
      const major = d % 30 === 0;
      const tick = el("span", { class: major ? "ck-tick major" : "ck-tick" });
      tick.style.left = `${(d + TAPE_PAD) * TAPE_PX}px`;
      if (major) tick.textContent = String(((d % 360) + 360) % 360).padStart(3, "0");
      this.tapeStrip.append(tick);
    }
    const top = this.buildDiv(
      "ck-top",
      this.buildDiv("ck-top-left", this.title, this.objective),
      this.buildDiv("ck-top-right", this.clock),
    );
    const tape = (this.tape = this.buildDiv(
      "ck-tape",
      this.tapeStrip,
      this.tapeCourse,
      this.buildDiv("ck-tape-mark"),
      this.tapeValue,
    ));

    const helm = panel(
      "HELM",
      "helm",
      this.buildDiv("ck-speed", this.speed, el("span", { class: "ck-unit" }, "m/s"), this.nav),
      this.gThrust.root,
      this.gFuel.root,
      this.gHeat.root,
      this.gPower.root,
      this.gBatt.root,
      this.modes,
    );
    helm.head.append(this.shipName);
    const hull = panel("HULL", "hull", this.ownPlan.el, this.ownSystems, this.ownReadout);
    hull.head.append(this.ownHull);
    const left = (this.leftCol = this.buildDiv("ck-left", helm.root, hull.root));

    const target = panel(
      "TARGET",
      "target",
      this.targetData,
      this.targetPlan.el,
      this.targetSystems,
      this.targetReadout,
    );
    target.head.append(this.targetName);
    this.targetPanel = target.root;
    this.contactList.append(this.allyList, this.foeList, this.droneLine);
    const contacts = panel("CONTACTS", "contacts", this.fleetButtons, this.contactList);
    this.contactsHead = contacts.head;
    contacts.root.addEventListener("mouseenter", () => (this.contactsHover = true));
    contacts.root.addEventListener("mouseleave", () => (this.contactsHover = false));
    const fleet: [string, string, string, () => void][] = [
      ["help", "Help me", "Every friendly ship attacks whoever is attacking you", () => actions.help()],
      [
        "guard",
        "Protect me",
        "Friendly ships stay close and engage what comes near you",
        () => actions.order("guard"),
      ],
      ["follow", "Follow", "Friendly ships form up on you (J)", () => actions.order("follow")],
      ["attack", "Attack tgt", "Friendly ships attack your target (K)", () => actions.order("attack")],
      ["hold", "Hold", "Friendly ships hold their position (L)", () => actions.order("hold")],
      ["free", "Free", "Friendly ships choose their own targets", () => actions.order("free")],
    ];
    for (const [id, label, title, run] of fleet) {
      const b = el("button", { class: `ck-btn ck-fleet-${id}`, "data-testid": `fleet-${id}`, title }, label);
      b.addEventListener("click", () => {
        run();
        b.blur();
      });
      this.fleetButtons.append(b);
    }
    const right = (this.rightCol = this.buildDiv("ck-right", target.root, contacts.root, this.ordnanceSlot));

    root.replaceChildren(
      top,
      tape,
      this.alerts,
      left,
      right,
      this.fireControlSlot,
      this.ejectBanner,
      this.help,
    );
  }

  private insetsAt = -Infinity;
  private insetsValue = { left: 0, right: 0, top: 0, bottom: 0 };

  /** Screen edges covered by the panels (px), so the camera can frame the action in what is left. */
  viewInsets(): { left: number; right: number; top: number; bottom: number } {
    const now = performance.now();
    if (now - this.insetsAt < 400) return this.insetsValue;
    this.insetsAt = now;
    const w = window.innerWidth;
    const h = window.innerHeight;
    const l = this.leftCol.getBoundingClientRect();
    const r = this.rightCol.getBoundingClientRect();
    const b = this.fireControlSlot.getBoundingClientRect();
    const t = this.tape.getBoundingClientRect();
    this.insetsValue = {
      left: l.width > 0 ? Math.min(l.right + 8, w * 0.35) : 0,
      right: r.width > 0 ? Math.min(w - r.left + 8, w * 0.35) : 0,
      top: Math.min(t.bottom + 4, h * 0.2),
      bottom: b.height > 0 ? Math.min(h - b.top + 4, h * 0.3) : 0,
    };
    return this.insetsValue;
  }

  private buildDiv(className: string, ...children: (Node | string)[]): HTMLElement {
    return el("div", { class: className }, ...children);
  }

  update(info: HudInfo): void {
    const { ship, world } = info;
    const s = world.physics.getBodyState(ship.id);
    const mp = ship.massProps;
    const acts = ship.propulsion.actuators;
    const caps = capabilities(acts);
    const speed = length(s.linearVelocity);
    const hdg = ((radToDeg(s.angle) % 360) + 360) % 360;
    const alerts: string[] = [];
    const alert = (level: "warn" | "alert", text: string, testid?: string) =>
      alerts.push(
        `<span class="ck-alert ${level}"${testid ? ` data-testid="${testid}"` : ""}>${text}</span>`,
      );

    // ---- Top bar ----
    txt(this.title, info.title ?? "");
    html(
      this.objective,
      info.objective ? `<span class="ck-tag">OBJECTIVE</span> ${esc(info.objective)}` : "",
    );
    html(
      this.clock,
      `<span class="dim">T+</span>${world.time.toFixed(1)} s <span class="dim">tick <span data-testid="tick">${world.tick}</span></span> ` +
        `<b data-testid="time-scale">×${info.timeScale}</b>${info.paused ? ' <b class="warn">PAUSED</b>' : ""} ` +
        `<span class="dim">cam ${info.cameraMode} · ${info.theme} · ${info.fps.toFixed(0)} fps · ? help · Esc editor</span>`,
    );

    // ---- Heading tape ----
    css(this.tapeStrip, `transform:translateX(${(-(hdg + TAPE_PAD) * TAPE_PX).toFixed(1)}px)`);
    txt(this.tapeValue, `HDG ${hdg.toFixed(0).padStart(3, "0")}°`);
    const course = radToDeg(Math.atan2(s.linearVelocity.y, s.linearVelocity.x));
    const drift = speed > 1 ? wrapDeg(course - hdg) : 0;
    if (speed > 1) {
      const off = Math.max(-38, Math.min(38, drift));
      css(this.tapeCourse, `transform:translateX(${(off * TAPE_PX).toFixed(1)}px)`);
      cls(this.tapeCourse, `ck-tape-course${Math.abs(drift) > 38 ? " off" : ""}`);
    } else cls(this.tapeCourse, "ck-tape-course hidden");

    // ---- Helm ----
    html(this.shipName, `${esc(ship.design.name)} <span class="dim">${ship.id}</span>`);
    txt(this.speed, speed.toFixed(1));
    html(
      this.nav,
      `<span><i>HDG</i>${hdg.toFixed(0).padStart(3, "0")}°</span>` +
        `<span><i>ROT</i>${radToDeg(s.angularVelocity).toFixed(1)}°/s</span>` +
        `<span><i>DRIFT</i>${speed > 1 ? `${drift.toFixed(0)}°` : "–"}</span>`,
    );
    // Thrust actually delivered now (all engines and thrusters), against the best the ship can do forward.
    const w = ship.lastWrench;
    const thrust = Math.hypot(w.fx, w.fy);
    const maxThrust = Math.max(caps.fwd, 1);
    setGauge(this.gThrust, thrust / maxThrust);
    txt(this.gThrust.value, `${Math.round(clamp01(thrust / maxThrust) * 100)}% · ${kn(thrust)}`);
    html(
      this.gThrust.detail,
      `accel <b>${(thrust / mp.mass).toFixed(1)}</b> m/s² · max fwd ${(caps.fwd / mp.mass).toFixed(1)} lat ${(Math.min(caps.left, caps.right) / mp.mass).toFixed(1)} · turn ${radToDeg(caps.torqueCcw / mp.inertia).toFixed(0)}°/s² · ${(mp.mass / 1000).toFixed(2)} t`,
    );
    const fuelFrac = ship.fuelCapacity > 0 ? ship.totalFuel / ship.fuelCapacity : 0;
    const burn = acts.reduce((sum, a, i) => sum + a.fuelFlow * (ship.throttles[i] ?? 0), 0);
    setGauge(this.gFuel, fuelFrac, ship.totalFuel <= 0 ? "alert" : fuelFrac < 0.15 ? "warn" : "");
    txt(this.gFuel.value, `${ship.totalFuel.toFixed(0)} kg`);
    const left = burn > 1e-6 ? ship.totalFuel / burn : Infinity;
    html(
      this.gFuel.detail,
      `${Math.round(fuelFrac * 100)}% of ${ship.fuelCapacity.toFixed(0)} kg` +
        (burn > 1e-3
          ? ` · burning ${burn.toFixed(1)} kg/s · ${left >= 3600 ? "&gt;1 h" : `${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, "0")}`} left`
          : ""),
    );
    // Heat (spec §7.4).
    const lvl = ship.heatLevel;
    const hf = ship.heatFlow;
    const net = hf.generation - hf.dissipation;
    const trend = net > 1000 ? "rising" : net < -1000 && ship.heat > 0 ? "falling" : "steady";
    setGauge(this.gHeat, lvl, lvl > 1 ? "alert" : lvl > 0.7 ? "warn" : "");
    html(this.gHeat.value, `<span data-testid="heat">${Math.round(lvl * 100)}</span>% ${trend}`);
    const src = hf.sources;
    const made = (
      [
        ["reactors", src.reactors],
        ["engines", src.propulsion],
        ["gyros", src.gyros],
        ["weapons", src.weapons],
      ] as const
    )
      .filter(([, x]) => x >= 500)
      .map(([n, x]) => `${n} ${kw(x)}`);
    html(
      this.gHeat.detail,
      `made <b data-testid="heat-made">+${kw(hf.generation)}</b>${made.length ? ` (${made.join(" · ")})` : ""}<br>` +
        `shed <b data-testid="heat-shed">−${kw(hf.dissipation)}</b> (hull ${kw(hf.hull)}${hf.radiators > 0 || ship.radiatorExposure.size > 0 ? ` · radiators ${kw(hf.radiators)} ${ship.radiatorsExtended ? "out" : "in"}` : " · no radiators"})`,
    );
    if (lvl > 1) alert("alert", "OVERHEATING · parts taking damage");
    else if (lvl > 0.7)
      alert("warn", `HOT · output ${Math.round(100 * (1 - 0.5 * Math.min(1, (lvl - 0.7) / 0.3)))}%`);
    // Power (command network, spec §7.2).
    const pw = ship.power;
    const short = ship.powerPriority.some((g) => pw.groups[g].demand > 0 && pw.groups[g].factor < 0.999);
    setGauge(this.gPower, pw.supply > 0 ? pw.used / pw.supply : 0, short ? "warn" : "");
    html(this.gPower.value, `<span data-testid="power-used">${kw(pw.used)}</span> / ${kw(pw.supply)}`);
    html(
      this.gPower.detail,
      ship.powerPriority
        .filter((g) => pw.groups[g].demand > 0)
        .map((g) => {
          const f = pw.groups[g].factor;
          return `<span class="${f >= 0.999 ? "" : f > 0 ? "warn" : "alert"}" data-testid="power-factor-${g}">${g} ${Math.round(f * 100)}%</span>`;
        })
        .join(" · "),
    );
    this.gBatt.root.hidden = pw.batteryCapacity <= 0;
    if (pw.batteryCapacity > 0) {
      const f = pw.batteryCharge / pw.batteryCapacity;
      setGauge(this.gBatt, f, f < 0.15 ? "warn" : "");
      txt(this.gBatt.value, `${Math.round(f * 100)}%`);
    }
    const sk = ship.flight.speedKill;
    html(
      this.modes,
      `<span class="ck-chip${sk === "off" ? "" : " on"}">SPEED KILL <b data-testid="speedkill">${sk}</b></span>` +
        `<span class="ck-chip${info.faceCursor ? " on" : ""}">FACE CURSOR <b>${info.faceCursor ? "on" : "off"}</b></span>` +
        (ship.radiatorExposure.size > 0
          ? `<span class="ck-chip${ship.radiatorsExtended ? " on" : ""}">RADIATORS <b>${ship.radiatorsExtended ? "out" : "in"}</b></span>`
          : ""),
    );

    // ---- Own ship plan ----
    const eject = info.eject ?? null;
    this.ownPlan.update(ship, eject?.hoverUid ?? null);
    const own = hullFraction(ship);
    html(
      this.ownHull,
      `hull <b class="${own < 0.35 ? "alert" : own < 0.7 ? "warn" : ""}">${Math.round(own * 100)}%</b>`,
    );
    html(this.ownSystems, systemsHtml(ship));
    html(this.ownReadout, partReadout(ship, this.ownPlan.hoverUid ?? eject?.hoverUid ?? null));

    // Networks and propulsion faults (spec §7.1).
    const nets = ship.networks.members.length;
    if (nets > 1) {
      const cut = ship.networks.members
        .filter((_, i) => i !== ship.commandNetwork)
        .reduce((n, m) => n + m.length, 0);
      alert("warn", `${cut} part(s) cut off from command (${nets - 1} section(s))`, "cut-off");
    }
    const noFuelPath = ship.parts.filter(
      (p) =>
        (p.def.def.engine || p.def.def.thruster) &&
        p.hp > 0 &&
        ship.isCommanded(p.uid) &&
        ship.fuelInNetwork(ship.networkOf(p.uid)) <= 0,
    ).length;
    if (noFuelPath > 0 && ship.totalFuel > 0) alert("alert", `${noFuelPath} engine(s) have no fuel path`);
    const outOfGimbal = ship.propulsion.engines.filter((e) => e.outOfGimbal).length;
    if (outOfGimbal > 0) alert("alert", `${outOfGimbal} engine(s) out of gimbal`);
    if (ship.totalFuel <= 0 && ship.fuelCapacity > 0) alert("alert", "NO FUEL");
    if (ship.commandNetwork === null) alert("alert", "COMMAND MODULE DESTROYED");
    if (nearBoundary(world.arena, world.physics.getWorldCenter(ship.id))) alert("warn", "ARENA BOUNDARY");
    const incoming = world.combat.missiles.filter((m) => m.team !== ship.team && m.target === ship.id).length;
    if (incoming) alert("alert", `INCOMING ${incoming}`, "incoming");
    if (ship.defeated)
      alert(
        "alert",
        `DEFEATED: ${ship.defeatReason === "command-destroyed" ? "command module destroyed" : "cannot move or fight"}`,
        "defeated",
      );
    html(this.alerts, alerts.join(""));

    // ---- Target ----
    const target = info.targetId && world.hasShip(info.targetId) ? world.getShip(info.targetId) : null;
    this.targetPlan.update(target);
    cls(this.targetPanel, `ck-panel ck-target${target ? "" : " empty"}`);
    if (target) {
      const ts = world.physics.getBodyState(target.id);
      const rel = sub(world.physics.getWorldCenter(target.id), world.physics.getWorldCenter(ship.id));
      const d = length(rel);
      const closing =
        d > 1e-6
          ? -(
              (ts.linearVelocity.x - s.linearVelocity.x) * rel.x +
              (ts.linearVelocity.y - s.linearVelocity.y) * rel.y
            ) / d
          : 0;
      const hp = hullFraction(target);
      html(
        this.targetName,
        `${esc(target.design.name)}${target.defeated ? ' <span class="alert">DEFEATED</span>' : ""}`,
      );
      html(
        this.targetData,
        `<span><i>RANGE</i>${metres(d)}</span>` +
          `<span><i>${closing >= 0 ? "CLOSING" : "OPENING"}</i>${Math.abs(closing).toFixed(0)} m/s</span>` +
          `<span data-testid="target-hull" class="${hp < 0.35 ? "alert" : hp < 0.7 ? "warn" : ""}"><i>HULL</i>${Math.round(hp * 100)}%</span>`,
      );
      html(this.targetSystems, systemsHtml(target));
      html(
        this.targetReadout,
        this.targetPlan.hoverUid
          ? partReadout(target, this.targetPlan.hoverUid)
          : info.targetAi
            ? `<span data-testid="target-ai">AI ${esc(info.targetAi)}</span>`
            : partReadout(target, null),
      );
    } else {
      html(this.targetName, `<span class="dim">none</span>`);
      html(
        this.targetData,
        `<span class="dim">${info.spectate ? "the followed ship has no target · click a contact to follow it" : "right-click a ship or pick a contact"}</span>`,
      );
      html(this.targetSystems, "");
      html(this.targetReadout, "");
    }

    this.updateContacts(info);

    // ---- Eject banner and help ----
    this.ejectBanner.hidden = !eject;
    if (!eject) html(this.ejectBanner, "");
    else {
      const hp = eject.hoverUid ? ship.parts.find((p) => p.uid === eject.hoverUid) : undefined;
      const extra = hp ? ship.ejectionSet(hp.uid).length - 1 : 0;
      const what = hp
        ? hp.def.def.command
          ? `${esc(hp.def.def.name)}: <span class="alert">cannot eject the command module</span>`
          : `click to eject <b>${esc(hp.def.def.name)}</b> (${hp.hp <= 0 ? "wreck" : `${Math.round((100 * hp.hp) / hp.def.def.hp)}% HP`})` +
            (extra > 0
              ? ` <span class="warn" data-testid="eject-extra">+ ${extra} attached part${extra > 1 ? "s" : ""}</span>`
              : "")
        : "point at a part of your ship";
      html(
        this.ejectBanner,
        `<span class="alert" data-testid="eject-mode">EJECT MODE</span> ${what} <span class="dim">Shift+B all wrecks · B/Esc exit</span>`,
      );
    }
    this.help.hidden = !info.showHelp;
  }

  /** Contacts: friendly ships first (they take orders), then hostiles by distance; drones are only counted. */
  private updateContacts(info: HudInfo): void {
    const { ship, world } = info;
    const me = world.physics.getWorldCenter(ship.id);
    const dist = new Map<string, number>();
    const ships = info.contacts.filter((c) => !c.ship.drone);
    for (const c of ships) dist.set(c.ship.id, length(sub(world.physics.getWorldCenter(c.ship.id), me)));
    const key = `${info.spectate ? "w" : "p"}|${ships.map((c) => `${c.ship.id}${c.friendly ? "f" : "e"}${c.commandable ? "c" : ""}`).join()}`;
    const now = performance.now();
    if (key !== this.rowsKey) {
      this.rowsKey = key;
      this.rows.clear();
      this.allyList.replaceChildren();
      this.foeList.replaceChildren();
      for (const c of ships) this.rows.set(c.ship.id, this.buildRow(c, !!info.spectate));
      this.sortedAt = -Infinity;
    }
    // Re-sort by distance every 2 s, and never under the pointer (rows must not jump away from a click).
    if (now - this.sortedAt > 2000 && !this.contactsHover) {
      this.sortedAt = now;
      const rank = (c: Contact) => (c.ship.defeated ? 1e9 : 0) + (dist.get(c.ship.id) ?? 0);
      const order = [...ships].sort((a, b) => rank(a) - rank(b)).map((c) => c.ship.id);
      if (order.join() !== this.order.join()) {
        this.order = order;
        for (const c of [...ships].sort((a, b) => rank(a) - rank(b))) {
          const row = this.rows.get(c.ship.id)!;
          (c.friendly ? this.allyList : this.foeList).append(row.root);
        }
      }
    }
    for (const c of ships) {
      const row = this.rows.get(c.ship.id)!;
      const id = c.ship.id;
      const p = world.physics.getWorldCenter(id);
      const hp = hullFraction(c.ship);
      cls(
        row.root,
        `ck-contact ${c.friendly ? "friend" : "foe"}${c.selected ? " sel" : ""}${id === info.targetId ? " tgt" : ""}${c.ship.defeated ? " dead" : ""}${id === info.priorityId ? " prio" : ""}`,
      );
      // Arrow toward the contact as seen on screen (world y is up, screen y is down).
      css(row.arrow, `transform:rotate(${(-radToDeg(Math.atan2(p.y - me.y, p.x - me.x))).toFixed(0)}deg)`);
      txt(row.dist, metres(dist.get(id) ?? 0));
      css(row.hull, `width:${(hp * 100).toFixed(0)}%`);
      cls(row.hull, hp < 0.35 ? "alert" : hp < 0.7 ? "warn" : "");
      txt(row.pct, c.ship.defeated ? "✗" : `${Math.round(hp * 100)}%`);
      txt(
        row.sub,
        c.ship.defeated
          ? "defeated"
          : c.commandable
            ? `${c.order} · ${c.behaviour}`
            : c.friendly
              ? c.behaviour !== "-"
                ? c.behaviour
                : "friendly"
              : id === info.priorityId
                ? "priority target"
                : id === info.targetId
                  ? "your target"
                  : c.behaviour !== "-"
                    ? c.behaviour
                    : "",
      );
      if (row.star) cls(row.star, `ck-btn ck-star${id === info.priorityId ? " on" : ""}`);
    }
    const drones = info.contacts.filter((c) => c.ship.drone && !c.ship.defeated && !c.ship.inert);
    const fd = drones.filter((c) => c.friendly).length;
    txt(this.droneLine, drones.length ? `drones: ${fd} friendly · ${drones.length - fd} hostile` : "");
    const friends = ships.filter((c) => c.friendly && !c.ship.defeated).length;
    const foes = ships.filter((c) => !c.friendly && !c.ship.defeated).length;
    html(
      this.contactsHead,
      `<span class="friend">${friends} friendly</span> · <span class="foe">${foes} hostile</span>`,
    );
    this.fleetButtons.hidden = !!info.spectate || !ships.some((c) => c.commandable);
  }

  private buildRow(c: Contact, spectate: boolean): Row {
    const id = c.ship.id;
    const arrow = el("span", { class: "ck-c-arrow" }, "➤");
    const name = el("span", { class: "ck-c-name" }, shortName(c.ship));
    const dist = el("span", { class: "ck-c-dist" });
    const hull = el("i");
    const pct = el("span", { class: "ck-c-pct" });
    const sub = el("span", { class: "ck-c-sub" });
    const buttons = el("span", { class: "ck-c-btns" });
    let star: HTMLElement | null = null;
    const button = (testid: string, label: string, title: string, run: () => void, className = "ck-btn") => {
      const b = el("button", { class: className, "data-testid": `${testid}-${id}`, title }, label);
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        run();
        b.blur();
      });
      buttons.append(b);
      return b;
    };
    if (!spectate && c.commandable) {
      button("contact-follow", "FOL", "Follow me", () => this.actions.order("follow", id));
      button("contact-attack", "ATK", "Attack my target", () => this.actions.order("attack", id));
      button("contact-hold", "HLD", "Hold position", () => this.actions.order("hold", id));
      button("contact-guard", "GRD", "Protect me: stay close and engage what comes near", () =>
        this.actions.order("guard", id),
      );
    } else if (!spectate && !c.friendly) {
      star = button(
        "contact-priority",
        "★",
        "Priority target: friendly ships attack it first (click again to release)",
        () => this.actions.priority(id),
        "ck-btn ck-star",
      );
    }
    const root = el(
      "div",
      {
        class: "ck-contact",
        "data-testid": `contact-${id}`,
        title: spectate
          ? "Click: follow this ship"
          : c.friendly
            ? c.commandable
              ? "Click: pick for orders (Shift adds)"
              : "Friendly ship"
            : "Click: make it your target",
      },
      arrow,
      name,
      dist,
      el("span", { class: "ck-c-hull" }, hull),
      pct,
      sub,
      buttons,
    );
    root.addEventListener("click", (e) => {
      if (spectate) this.actions.watch(id);
      else if (!c.friendly) this.actions.target(id);
      else if (c.commandable) this.actions.select(id, e.shiftKey);
    });
    return { root, arrow, name, dist, hull, pct, sub, star };
  }
}

/** "ENG 2/2  WPN 3/4 …": working and fitted parts per system. */
function systemsHtml(ship: Ship): string {
  return systemStatus(ship)
    .map(
      (x) =>
        `<span class="${x.alive === 0 ? "alert" : x.alive < x.total ? "warn" : ""}"><i>${x.label}</i>${x.alive}/${x.total}</span>`,
    )
    .join("");
}

/** One line about the part under the pointer on a plan. */
function partReadout(ship: Ship, uid: string | null): string {
  const p = uid ? ship.parts.find((x) => x.uid === uid) : undefined;
  if (!p) return `<span class="dim">point at a part for its state</span>`;
  const max = p.def.def.hp;
  return p.hp <= 0
    ? `${esc(p.def.def.name)} <span class="alert">destroyed</span>`
    : `${esc(p.def.def.name)} <b>${Math.round(p.hp)}</b>/${max} HP (${Math.round((100 * p.hp) / max)}%)`;
}
