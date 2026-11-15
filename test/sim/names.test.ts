import { describe, expect, it } from "vitest";
import namesJson from "../../src/data/names/names.json";
import { validateNames } from "../../src/data/validate";
import { generateName, MIXED, NAMES, poolName } from "../../src/sim/crew/names";
import { crewRng, PORTRAIT_COUNTS, randomPortrait } from "../../src/sim/crew/officers";
import { chevronsSvg, PART_LABELS, portraitSvg } from "../../src/ui/portrait";

describe("name generator", () => {
  it("the bundled descriptor is valid and has English, German and Japanese styles", () => {
    const v = validateNames(namesJson);
    expect(v.ok, v.ok ? "" : v.errors.join("; ")).toBe(true);
    expect(NAMES.styles.map((s) => s.id)).toEqual(["english", "german", "japanese"]);
  });

  it("every style gives two-part names in its own order, the same for the same seed", () => {
    for (const s of NAMES.styles) {
      const random = crewRng(11);
      for (let i = 0; i < 300; i++) {
        const { name, origin } = generateName(random, s.id);
        expect(origin).toBe(s.id);
        expect(name.length).toBeGreaterThan(3);
        expect(name.length).toBeLessThanOrEqual(60);
        expect(name).toMatch(/^\S.*\S$/);
      }
    }
    const jp = generateName(crewRng(3), "japanese");
    const family = NAMES.styles.find((s) => s.id === "japanese")!.family;
    // Family name first: the first word is a listed family name or built from family syllables.
    const first = jp.name.split(" ")[0]!;
    expect(family.names.includes(first) || family.parts![0]!.some((p) => first.startsWith(p))).toBe(true);
    expect(generateName(crewRng(5), "german")).toEqual(generateName(crewRng(5), "german"));
  });

  it("mixed draws every style by weight", () => {
    const random = crewRng(1);
    const seen = new Map<string, number>();
    for (let i = 0; i < 2000; i++) {
      const o = generateName(random, MIXED).origin;
      seen.set(o, (seen.get(o) ?? 0) + 1);
    }
    expect([...seen.keys()].sort()).toEqual(["english", "german", "japanese"]);
    // English has weight 2 of 4.
    expect(seen.get("english")! / 2000).toBeGreaterThan(0.4);
    expect(seen.get("english")! / 2000).toBeLessThan(0.6);
  });

  it("built names join one piece per group, capitalised, never the same piece twice", () => {
    const pool = {
      names: ["X"],
      parts: [
        ["Stein", "Berg"],
        ["berg", "stein"],
      ],
      partChance: 1,
    };
    const random = crewRng(2);
    for (let i = 0; i < 100; i++) expect(["Steinberg", "Bergstein"]).toContain(poolName(pool, random));
    const pref = { names: ["Krause"], prefix: { values: ["von "], chance: 1 } };
    expect(poolName(pref, random)).toBe("von Krause");
  });

  it("rejects descriptors with duplicate styles or bad fields", () => {
    const style = NAMES.styles[0]!;
    expect(validateNames({ formatVersion: 1, styles: [style, style] }).ok).toBe(false);
    expect(validateNames({ formatVersion: 1, styles: [{ ...style, order: "backwards" }] }).ok).toBe(false);
    expect(validateNames({ formatVersion: 1, styles: [] }).ok).toBe(false);
  });
});

describe("portraits", () => {
  it("every part has as many labels as options, and every option draws", () => {
    for (const [k, n] of Object.entries(PORTRAIT_COUNTS))
      expect(PART_LABELS[k as keyof typeof PART_LABELS], k).toHaveLength(n);
    const base = randomPortrait(crewRng(4));
    for (const [k, n] of Object.entries(PORTRAIT_COUNTS))
      for (let i = 0; i < n; i++) {
        const svg = portraitSvg({ ...base, [k]: i });
        expect(svg).toMatch(/^<svg[^]*<\/svg>$/);
        expect(svg).not.toMatch(/undefined|NaN/);
      }
  });

  it("level chevrons: one per level", () => {
    for (let l = 1; l <= 5; l++) {
      expect(chevronsSvg(l).match(/<path /g)).toHaveLength(l);
      expect(portraitSvg(randomPortrait(crewRng(l)), 96, l)).toContain(`stroke-width="2.2"`);
    }
  });
});
