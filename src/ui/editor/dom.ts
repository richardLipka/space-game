import type { RuntimePartDef } from "../../sim/ship/catalogue";

/** Tiny DOM builder: el("div", { class: "x" }, "text", child). */
export function el(
  tag: string,
  attrs: Record<string, string> = {},
  ...children: (Node | string)[]
): HTMLElement {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  e.append(...children);
  return e;
}

export const fmt = {
  mass: (kg: number) => (kg >= 1000 ? `${(kg / 1000).toFixed(kg >= 1e5 ? 0 : 2)} t` : `${kg.toFixed(0)} kg`),
  watts: (w: number) =>
    w >= 1e6 ? `${(w / 1e6).toFixed(1)} MW` : w >= 1e3 ? `${(w / 1e3).toFixed(0)} kW` : `${w.toFixed(0)} W`,
};

const SVG_NS = "http://www.w3.org/2000/svg";

/** Small inline SVG of a part's outline, coloured by edge type (snap / hull / function). */
export function partThumbnail(p: RuntimePartDef, size = 28): SVGSVGElement {
  const xs = p.outline.map((v) => v.x);
  const ys = p.outline.map((v) => v.y);
  const minX = Math.min(...xs),
    maxX = Math.max(...xs),
    minY = Math.min(...ys),
    maxY = Math.max(...ys);
  const span = Math.max(maxX - minX, maxY - minY) || 1;
  const pad = span * 0.12;
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", `${minX - pad} ${-maxY - pad} ${span + pad * 2} ${span + pad * 2}`);
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.classList.add("ed-thumb", `cat-${p.def.category}`);
  const fill = document.createElementNS(SVG_NS, "polygon");
  fill.setAttribute("points", p.outline.map((v) => `${v.x},${-v.y}`).join(" "));
  fill.classList.add("thumb-fill");
  svg.append(fill);
  for (const e of p.edges) {
    const line = document.createElementNS(SVG_NS, "line");
    line.setAttribute("x1", String(e.a.x));
    line.setAttribute("y1", String(-e.a.y));
    line.setAttribute("x2", String(e.b.x));
    line.setAttribute("y2", String(-e.b.y));
    line.setAttribute("vector-effect", "non-scaling-stroke");
    line.classList.add(`edge-${e.type}`);
    svg.append(line);
  }
  return svg;
}
