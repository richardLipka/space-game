import type { Ship } from "../../sim/ship/ship-entity";
import type { PartInstance } from "../../sim/ship/ship";

const SVG_NS = "http://www.w3.org/2000/svg";

/** Damage classes of a part on the plan: 4 = intact … 1 = nearly gone, 0 = wreck. */
export function damageClass(hp: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (hp <= 0) return 0;
  const f = max > 0 ? hp / max : 1;
  return f >= 0.9 ? 4 : f >= 0.6 ? 3 : f >= 0.3 ? 2 : 1;
}

/** Share of a ship's total hit points still standing (0–1). */
export function hullFraction(ship: Ship): number {
  let hp = 0;
  let max = 0;
  for (const p of ship.parts) {
    hp += Math.max(0, p.hp);
    max += p.def.def.hp;
  }
  return max > 0 ? hp / max : 0;
}

/** Systems shown under a plan: label, part filter. */
const SYSTEMS: readonly (readonly [string, (p: PartInstance) => boolean])[] = [
  ["ENG", (p) => !!p.def.def.engine],
  ["RCS", (p) => !!p.def.def.thruster],
  ["PWR", (p) => !!p.def.def.reactor],
  ["WPN", (p) => !!p.def.def.weapon],
  ["RAD", (p) => p.def.def.category === "thermal"],
  ["HGR", (p) => !!p.def.def.hangar],
];

export interface SystemStatus {
  readonly label: string;
  readonly alive: number;
  readonly total: number;
}

/** Working / fitted counts per system (systems the ship does not have are left out). */
export function systemStatus(ship: Ship): SystemStatus[] {
  const out: SystemStatus[] = [];
  for (const [label, is] of SYSTEMS) {
    const parts = ship.parts.filter(is);
    if (parts.length === 0) continue;
    out.push({ label, alive: parts.filter((p) => p.hp > 0).length, total: parts.length });
  }
  return out;
}

/**
 * Schematic of a ship, turned the way the ship lies in the world (the camera keeps north up), every part
 * coloured by its remaining hit points (the pilot's own ship on the left of the screen, the target on the
 * right). Geometry is rebuilt only when the ship or its part list changes; each frame only the heading and
 * the damage classes are refreshed.
 */
export class ShipPlan {
  readonly el: SVGSVGElement;
  private key = "";
  private readonly group = document.createElementNS(SVG_NS, "g");
  private angleKey = "";
  private readonly polys = new Map<string, { el: SVGPolygonElement; cls: string }>();
  /** Part under the mouse, if any. */
  hoverUid: string | null = null;

  constructor() {
    this.el = document.createElementNS(SVG_NS, "svg");
    this.el.classList.add("ck-plan");
    this.el.setAttribute("preserveAspectRatio", "xMidYMid meet");
    this.el.addEventListener("mouseover", (e) => {
      this.hoverUid = (e.target as Element).getAttribute?.("data-uid") ?? null;
    });
    this.el.addEventListener("mouseleave", () => (this.hoverUid = null));
  }

  /** `angle`: the ship's heading in the world (rad, counter-clockwise from +x). */
  update(ship: Ship | null, highlightUid: string | null = null, angle = 0): void {
    if (!ship) {
      if (this.key !== "") {
        this.key = "";
        this.polys.clear();
        this.el.replaceChildren();
        this.hoverUid = null;
      }
      return;
    }
    const key = `${ship.id}|${ship.parts.map((p) => p.uid).join()}`;
    if (key !== this.key) this.build(ship, key);
    // SVG y points down, so a counter-clockwise heading is a negative SVG rotation.
    const ak = (-(angle * 180) / Math.PI).toFixed(1);
    if (ak !== this.angleKey) {
      this.angleKey = ak;
      this.group.setAttribute("transform", `rotate(${ak})`);
    }
    for (const p of ship.parts) {
      const poly = this.polys.get(p.uid);
      if (!poly) continue;
      const cls = `hp-${damageClass(p.hp, p.def.def.hp)}${p.uid === highlightUid ? " hl" : ""}`;
      if (cls !== poly.cls) {
        poly.cls = cls;
        poly.el.setAttribute("class", cls);
      }
    }
  }

  /**
   * Ship frame (x forward, y left) → SVG (y down) around the plan's centre: x' = x − cx, y' = −(y − cy).
   * The view box is a square around the centre big enough for any heading.
   */
  private build(ship: Ship, key: string): void {
    this.key = key;
    this.angleKey = "";
    this.polys.clear();
    this.hoverUid = null;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const p of ship.parts)
      for (const v of ship.layout.outlines.get(p.uid) ?? []) {
        minX = Math.min(minX, v.x);
        maxX = Math.max(maxX, v.x);
        minY = Math.min(minY, v.y);
        maxY = Math.max(maxY, v.y);
      }
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    let r = 0;
    const nodes: SVGPolygonElement[] = [];
    for (const p of ship.parts) {
      const outline = ship.layout.outlines.get(p.uid);
      if (!outline) continue;
      const pts = outline.map((v) => ({ x: v.x - cx, y: -(v.y - cy) }));
      for (const v of pts) r = Math.max(r, Math.hypot(v.x, v.y));
      const poly = document.createElementNS(SVG_NS, "polygon");
      poly.setAttribute("points", pts.map((v) => `${v.x.toFixed(3)},${v.y.toFixed(3)}`).join(" "));
      poly.setAttribute("data-uid", p.uid);
      nodes.push(poly);
      this.polys.set(p.uid, { el: poly, cls: "" });
    }
    if (nodes.length === 0) {
      this.el.replaceChildren();
      return;
    }
    const half = r * 1.04 + 0.3;
    this.el.setAttribute(
      "viewBox",
      `${(-half).toFixed(2)} ${(-half).toFixed(2)} ${(2 * half).toFixed(2)} ${(2 * half).toFixed(2)}`,
    );
    this.group.replaceChildren(...nodes);
    this.el.replaceChildren(this.group);
  }
}
