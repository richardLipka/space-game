import type { Ship } from "../sim/ship/ship-entity";
import type { World } from "../sim/world";
import { capabilities } from "../sim/flight/propulsion";
import { nearBoundary } from "../sim/physics/forces";
import { length, radToDeg, sub } from "../sim/core/vec2";

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
  readonly selectedGroups?: ReadonlySet<number>;
  readonly targetId?: string | null;
  /** Eject mode is on; the part under the cursor, if any. */
  readonly eject?: { readonly hoverUid: string | null } | null;
}

const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);

function bar(frac: number, width = 16): string {
  const n = Math.max(0, Math.min(width, Math.round(frac * width)));
  return "█".repeat(n) + "░".repeat(width - n);
}

const HELP = `W/S thrust   A/D strafe   Q/E rotate   F face cursor
X speed kill   Shift+X flip & burn   Tab switch ship
C camera   wheel zoom   middle-drag pan (free cam)
+/- time scale   Space pause   T theme   V overlays   H help   Esc editor
P power priority   R radiators   N networks   hold K + click: destroy part (debug)
LMB fire   1–9 weapon group (Shift adds)   G group mode   RMB target
B eject mode (click a part to jettison)   Shift+B eject all wrecks`;

/** " + N attached parts" when ejecting this part also takes parts held on only through it. */
function ejectExtra(ship: Ship, uid: string): string {
  const n = ship.ejectionSet(uid).length - 1;
  return n > 0
    ? ` <span class="warn" data-testid="eject-extra">+ ${n} attached part${n > 1 ? "s" : ""}</span>`
    : "";
}

/** DOM HUD (plain HTML/CSS so the theme stylesheet styles it directly, spec §13.7). */
export class Hud {
  constructor(private readonly el: HTMLElement) {}

  update(info: HudInfo): void {
    const { ship, world } = info;
    const s = world.physics.getBodyState(ship.id);
    const mp = ship.massProps;
    const caps = capabilities(ship.propulsion.actuators);
    const speed = length(s.linearVelocity);
    const fuelFrac = ship.fuelCapacity > 0 ? ship.totalFuel / ship.fuelCapacity : 0;
    const outOfGimbal = ship.propulsion.engines.filter((e) => e.outOfGimbal).length;
    const pos = world.physics.getWorldCenter(ship.id);
    const lines: string[] = [];
    if (info.title)
      lines.push(`<span class="warn">${esc(info.title)}</span> <span class="dim">Esc: back to editor</span>`);
    lines.push(`<b>${esc(ship.design.name)}</b> <span class="dim">${ship.id}</span>`);
    lines.push(
      `speed <span data-testid="speed">${speed.toFixed(1)}</span> m/s   ω ${radToDeg(s.angularVelocity).toFixed(1)}°/s   hdg ${(((radToDeg(s.angle) % 360) + 360) % 360).toFixed(0)}°`,
    );
    lines.push(`mass ${(mp.mass / 1000).toFixed(2)} t   I ${mp.inertia.toExponential(2)} kg·m²`);
    lines.push(
      `accel fwd ${(caps.fwd / mp.mass).toFixed(1)}  lat ${(Math.min(caps.left, caps.right) / mp.mass).toFixed(1)} m/s²   α ${radToDeg(caps.torqueCcw / mp.inertia).toFixed(0)}°/s²`,
    );
    lines.push(`fuel   ${bar(fuelFrac)} ${ship.totalFuel.toFixed(0)} kg`);
    // Power (command network, spec §7.2).
    const pw = ship.power;
    const kw = (w: number) => (w >= 1e6 ? `${(w / 1e6).toFixed(1)} MW` : `${(w / 1000).toFixed(0)} kW`);
    lines.push(
      `power  ${bar(pw.supply > 0 ? pw.used / pw.supply : 0)} <span data-testid="power-used">${kw(pw.used)}</span> / ${kw(pw.supply)}`,
    );
    const groups = ship.powerPriority
      .filter((g) => pw.groups[g].demand > 0)
      .map((g) => {
        const f = pw.groups[g].factor;
        return `<span class="${f >= 0.999 ? "dim" : f > 0 ? "warn" : "alert"}" data-testid="power-factor-${g}">${g} ${Math.round(f * 100)}%</span>`;
      });
    if (groups.length) lines.push(`       ${groups.join("  ")}`);
    if (pw.batteryCapacity > 0)
      lines.push(
        `batt   ${bar(pw.batteryCharge / pw.batteryCapacity)} ${Math.round((100 * pw.batteryCharge) / pw.batteryCapacity)}%`,
      );
    // Heat (spec §7.4).
    const lvl = ship.heatLevel;
    const heatCls = lvl > 1 ? "alert" : lvl > 0.7 ? "warn" : "dim";
    const hf = ship.heatFlow;
    const net = hf.generation - hf.dissipation;
    lines.push(
      `heat   <span class="${heatCls}">${bar(Math.min(1, lvl))} <span data-testid="heat">${Math.round(lvl * 100)}</span>%</span>  <span class="${net > 1000 ? "warn" : "dim"}">${net > 1000 ? "rising" : net < -1000 && ship.heat > 0 ? "falling" : "steady"}</span>`,
    );
    const src = hf.sources;
    const made = (
      [
        ["reactors", src.reactors],
        ["engines", src.propulsion],
        ["gyros", src.gyros],
        ["weapons", src.weapons],
      ] as const
    )
      .filter(([, w]) => w >= 500)
      .map(([n, w]) => `${n} ${kw(w)}`);
    lines.push(
      `  made  <span data-testid="heat-made">+${kw(hf.generation)}</span>${made.length ? ` <span class="dim">(${made.join(" · ")})</span>` : ""}`,
    );
    lines.push(
      `  shed  <span data-testid="heat-shed">−${kw(hf.dissipation)}</span> <span class="dim">(hull ${kw(hf.hull)}${hf.radiators > 0 || ship.radiatorExposure.size > 0 ? ` · radiators ${kw(hf.radiators)} ${ship.radiatorsExtended ? "out" : "in"}` : " · no radiators"})</span>`,
    );
    if (lvl > 1) lines.push(`<span class="alert">OVERHEATING: heat-producing parts are taking damage</span>`);
    else if (lvl > 0.7)
      lines.push(
        `<span class="warn">HOT: output throttled to ${Math.round(100 * (1 - 0.5 * Math.min(1, (lvl - 0.7) / 0.3)))}%</span>`,
      );
    // Networks (spec §7.1).
    const nets = ship.networks.members.length;
    if (nets > 1) {
      const cut = ship.networks.members
        .filter((_, i) => i !== ship.commandNetwork)
        .reduce((s, m) => s + m.length, 0);
      lines.push(
        `<span class="warn" data-testid="cut-off">${cut} part(s) cut off from command (${nets - 1} section(s))</span>`,
      );
    }
    const noFuelPath = ship.parts.filter(
      (p) =>
        (p.def.def.engine || p.def.def.thruster) &&
        p.hp > 0 &&
        ship.isCommanded(p.uid) &&
        ship.fuelInNetwork(ship.networkOf(p.uid)) <= 0,
    ).length;
    if (noFuelPath > 0 && ship.totalFuel > 0)
      lines.push(`<span class="alert">${noFuelPath} engine(s) have no fuel path</span>`);
    if (ship.commandNetwork === null) lines.push(`<span class="alert">COMMAND MODULE DESTROYED</span>`);
    // Weapons (spec §9.2): one line per group, then ammunition stock per type.
    const wgroups = [...new Set(ship.weapons.filter((w) => w.def.kind !== "pd").map((w) => w.group))].sort(
      (a, b) => a - b,
    );
    if (wgroups.length) {
      const sel = info.selectedGroups ?? new Set<number>();
      lines.push(`weapons <span class="dim">(1–9 select · G mode · LMB fire)</span>`);
      for (const g of wgroups) {
        const ws = ship.weapons.filter((w) => w.group === g && w.def.kind !== "pd");
        const alive = ws.filter((w) => w.part.hp > 0);
        const mode = ship.groupModes.get(g) ?? "manual";
        const names = [...new Set(ws.map((w) => w.part.def.def.name))].join(", ");
        const usesAmmo = ws.some((w) => w.def.ammoType && w.def.internalMagazine > 0);
        const loaded = alive.reduce((n, w) => n + Math.floor(w.part.ammo), 0);
        const capacity = alive.reduce((n, w) => n + w.def.internalMagazine, 0);
        const ammo = usesAmmo
          ? `loaded <span class="${loaded === 0 ? "alert" : loaded < capacity / 4 ? "warn" : ""}">${loaded}/${capacity}</span>`
          : `<span class="dim">power</span>`;
        const blocked = ws.some((w) => w.isBlocked && w.part.hp > 0)
          ? ' <span class="warn">⊘ blocked</span>'
          : "";
        const cls = sel.has(g) ? "sel" : "dim";
        lines.push(
          `  <span class="${cls}" data-testid="group-${g}">[${g}] ${mode.padEnd(6)} ${alive.length}/${ws.length} ${esc(names)}  ${ammo}${blocked}</span>`,
        );
      }
    }
    const ammoTypes = [
      ...new Set(
        ship.weapons
          .filter((w) => w.def.ammoType && w.def.internalMagazine > 0)
          .map((w) => w.def.ammoType as string),
      ),
    ].sort();
    for (const type of ammoTypes) {
      const mags = ship.parts.filter((p) => p.def.def.magazine?.ammoType === type);
      const stock = mags.filter((p) => p.hp > 0).reduce((n, p) => n + Math.floor(p.ammo), 0);
      const cap = mags.reduce((n, p) => n + p.def.def.magazine!.capacity, 0);
      const frac = cap > 0 ? stock / cap : 0;
      const cls = stock === 0 ? "alert" : frac < 0.25 ? "warn" : "dim";
      lines.push(
        `ammo   <span class="${cls}">${bar(frac, 10)}</span> <span data-testid="ammo-${type}">${stock}</span>/${cap} ${esc(type)}${cap === 0 ? ' <span class="alert">no magazine</span>' : ""}`,
      );
    }
    if (info.targetId && world.hasShip(info.targetId)) {
      const t = world.getShip(info.targetId);
      const d = length(sub(world.physics.getWorldCenter(t.id), world.physics.getWorldCenter(ship.id)));
      const hp =
        t.parts.reduce((a, p) => a + Math.max(0, p.hp), 0) / t.parts.reduce((a, p) => a + p.def.def.hp, 0);
      lines.push(
        `target  <span data-testid="target">${esc(t.design.name)}</span> ${d.toFixed(0)} m  hull ${Math.round(hp * 100)}%${t.defeated ? ' <span class="alert">DEFEATED</span>' : ""}`,
      );
    } else if (wgroups.length) lines.push(`<span class="dim">target  none (right-click a ship)</span>`);
    if (ship.defeated) {
      lines.push(
        `<span class="alert" data-testid="defeated">DEFEATED: ${ship.defeatReason === "command-destroyed" ? "command module destroyed" : "cannot move or fight"}</span>`,
      );
    }
    if (info.eject) {
      const hp = info.eject.hoverUid ? ship.parts.find((p) => p.uid === info.eject!.hoverUid) : undefined;
      const what = hp
        ? hp.def.def.command
          ? `${esc(hp.def.def.name)}: <span class="alert">cannot eject the command module</span>`
          : `click to eject <b>${esc(hp.def.def.name)}</b> (${hp.hp <= 0 ? "wreck" : `${Math.round((100 * hp.hp) / hp.def.def.hp)}% HP`})${ejectExtra(ship, hp.uid)}`
        : "point at a part of your ship";
      lines.push(
        `<span class="alert" data-testid="eject-mode">EJECT MODE</span> ${what}  <span class="dim">Shift+B all wrecks · B/Esc exit</span>`,
      );
    }
    const sk = ship.flight.speedKill;
    lines.push(
      `speed kill <span data-testid="speedkill" class="${sk === "off" ? "dim" : "warn"}">${sk}</span>   face cursor ${info.faceCursor ? "on" : '<span class="dim">off</span>'}`,
    );
    if (outOfGimbal > 0) lines.push(`<span class="alert">${outOfGimbal} engine(s) out of gimbal</span>`);
    if (ship.totalFuel <= 0) lines.push(`<span class="alert">NO FUEL</span>`);
    if (nearBoundary(world.arena, pos)) lines.push(`<span class="warn">ARENA BOUNDARY</span>`);
    lines.push(
      `<span class="dim">t ${world.time.toFixed(1)} s  tick <span data-testid="tick">${world.tick}</span>  ×${info.timeScale}${info.paused ? "  PAUSED" : ""}  cam ${info.cameraMode}  theme ${info.theme}  ${info.fps.toFixed(0)} fps</span>`,
    );
    lines.push(info.showHelp ? `<span class="dim">${HELP}</span>` : `<span class="dim">H for help</span>`);
    this.el.innerHTML = lines.join("\n");
  }
}
