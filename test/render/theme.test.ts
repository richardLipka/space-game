import { describe, expect, it } from "vitest";
import { ThemeResolver } from "../../src/render/theme";

describe("theme resolver", () => {
  it("1.29 10k lookups of the same selector compute the style once", () => {
    let calls = 0;
    const r = new ThemeResolver(() => {
      calls++;
      return (prop) => ({ "--stroke": "#ff0000", "--stroke-width": "2" })[prop] ?? "";
    });
    for (let i = 0; i < 10_000; i++) r.resolve("part cat-command team-0 state-ok");
    expect(calls).toBe(1);
    expect(r.computes).toBe(1);
    expect(r.resolve("part cat-command team-0 state-ok").strokeWidth).toBe(2);
  });

  it("invalidate re-reads styles and bumps the version", () => {
    let colour = "#ff0000";
    const r = new ThemeResolver(() => (prop) => (prop === "--stroke" ? colour : ""));
    expect(r.resolve("x").stroke).toBe("#ff0000");
    colour = "#00ff00";
    expect(r.resolve("x").stroke).toBe("#ff0000");
    const v = r.version;
    r.invalidate();
    expect(r.resolve("x").stroke).toBe("#00ff00");
    expect(r.version).toBe(v + 1);
  });

  it("falls back to defaults for missing or malformed properties", () => {
    const r = new ThemeResolver(() => (prop) => (prop === "--stroke-width" ? "abc" : ""));
    const s = r.resolve("x");
    expect(s.strokeWidth).toBe(1);
    expect(s.stroke).toBe("#ffffff");
    expect(s.fillAlpha).toBe(0);
  });
});
