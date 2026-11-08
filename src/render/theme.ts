/**
 * CSS-driven theme layer (spec §13.7). The renderer never hardcodes colours: it asks for a style by
 * semantic selector ("part cat-propulsion team-1 state-ok") and this resolver reads CSS custom properties
 * from a hidden probe element carrying those classes. Results are cached per selector.
 */
export interface DrawStyle {
  readonly stroke: string;
  readonly strokeWidth: number;
  readonly strokeAlpha: number;
  readonly fill: string;
  readonly fillAlpha: number;
  readonly glow: string;
  readonly glowWidth: number;
  readonly glowAlpha: number;
  /** Generic scalar used by effects (e.g. thrust plume length multiplier). */
  readonly scale: number;
  /** Minimum on-screen size in px (icons, projectiles). */
  readonly minSize: number;
}

/** Returns a property reader for an element with the given classes. */
export type StyleSource = (classes: string) => (prop: string) => string;

const num = (v: string, fallback: number): number => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
};
const str = (v: string, fallback: string): string => (v.trim() === "" ? fallback : v.trim());

export class ThemeResolver {
  private cache = new Map<string, DrawStyle>();
  /** Number of style computations (cache misses), for tests and perf checks. */
  computes = 0;
  /** Bumped on invalidate so renderers can rebuild cached geometry. */
  version = 0;

  constructor(private readonly source: StyleSource) {}

  resolve(classes: string): DrawStyle {
    const hit = this.cache.get(classes);
    if (hit) return hit;
    this.computes++;
    const get = this.source(classes);
    const style: DrawStyle = {
      stroke: str(get("--stroke"), "#ffffff"),
      strokeWidth: num(get("--stroke-width"), 1),
      strokeAlpha: num(get("--stroke-alpha"), 1),
      fill: str(get("--fill"), "#000000"),
      fillAlpha: num(get("--fill-alpha"), 0),
      glow: str(get("--glow"), str(get("--stroke"), "#ffffff")),
      glowWidth: num(get("--glow-width"), 0),
      glowAlpha: num(get("--glow-alpha"), 0),
      scale: num(get("--scale"), 1),
      minSize: num(get("--min-size"), 0),
    };
    this.cache.set(classes, style);
    return style;
  }

  invalidate(): void {
    this.cache.clear();
    this.version++;
  }
}

/** Probe-element style source for the browser. One hidden element per distinct selector. */
export function domStyleSource(doc: Document): StyleSource {
  let host = doc.getElementById("theme-probes");
  if (!host) {
    host = doc.createElement("div");
    host.id = "theme-probes";
    host.style.display = "none";
    doc.body.appendChild(host);
  }
  const probes = new Map<string, HTMLElement>();
  return (classes) => {
    let el = probes.get(classes);
    if (!el) {
      el = doc.createElement("div");
      el.className = classes;
      host.appendChild(el);
      probes.set(classes, el);
    }
    const cs = doc.defaultView!.getComputedStyle(el);
    return (prop) => cs.getPropertyValue(prop);
  };
}

export const THEMES = ["neon", "flat"] as const;
export type ThemeName = (typeof THEMES)[number];

/** Swaps the theme stylesheet; resolves once the new sheet has loaded. */
export function applyTheme(doc: Document, name: ThemeName, resolver: ThemeResolver): Promise<void> {
  const link = doc.getElementById("theme") as HTMLLinkElement | null;
  if (!link) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      resolver.invalidate();
      doc.documentElement.dataset.theme = name;
      resolve();
    };
    link.addEventListener("load", done, { once: true });
    link.addEventListener("error", done, { once: true });
    link.href = new URL(`../themes/${name}.css`, import.meta.url).href;
  });
}
