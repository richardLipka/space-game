import { describe, expect, it } from "vitest";
import namesJson from "../../src/data/names/names.json";
import { validateNames } from "../../src/data/validate";
import { generateName, MIXED, NAMES, poolName } from "../../src/sim/crew/names";
import { crewRng, PORTRAIT_COUNTS, randomPortrait, UNIFORM_STYLES } from "../../src/sim/crew/officers";
import { repairOfficer } from "../../src/data/repair";
import { validateOfficer } from "../../src/data/validate";
import { accessoriesOf, chevronsSvg, PART_LABELS, portraitSvg, withAccessories } from "../../src/ui/portrait";

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

  it("three uniform styles: colonial whites, modern with metal stripes, Kaisermarine", () => {
    const base = randomPortrait(crewRng(8));
    const svgs = Object.entries(UNIFORM_STYLES).map(([id, st]) => {
      expect(PART_LABELS.uniform[st.uniform], id).toBeDefined();
      expect(PART_LABELS.hair[st.hair], id).toMatch(/cap/i);
      expect(PART_LABELS.collar[st.collar], id).toBeDefined();
      return portraitSvg({ ...base, ...st, suit: false });
    });
    expect(new Set(svgs).size).toBe(3);
    expect(svgs[0]).toContain("#f4f1e8"); // colonial whites
  });

  it("several accessories are worn together and survive repair", () => {
    const base = withAccessories(randomPortrait(crewRng(5)), [5, 2, 10]);
    expect(accessoriesOf(base)).toEqual([5, 2, 10]);
    expect(base.accessory).toBe(5);
    expect(base.extras).toEqual([2, 10]);
    const one = portraitSvg(withAccessories(base, [5]));
    const three = portraitSvg(base);
    expect(three.length).toBeGreaterThan(one.length);
    expect(withAccessories(base, []).accessory).toBe(0);
    expect(withAccessories(base, []).extras).toBeUndefined();
    const o = {
      id: "a1",
      name: "A B",
      position: "pilot",
      level: 1,
      traits: ["steady-hand", "cool-head", "pd-ace", "nervous", "wasteful"],
      portrait: { ...base, extras: [2, "x", 300, 10] },
    };
    const r = repairOfficer(o);
    expect(r.officer!.portrait.extras).toEqual([2, 10]);
    expect(validateOfficer(r.officer).ok).toBe(true);
    // Random portraits sometimes wear two accessories and a uniform style.
    const random = crewRng(12);
    const many = Array.from({ length: 200 }, () => randomPortrait(random));
    expect(many.some((p) => (p.extras?.length ?? 0) > 0)).toBe(true);
    expect(many.some((p) => p.uniform === UNIFORM_STYLES.kaiser.uniform)).toBe(true);
  });

  it("level chevrons: one per level", () => {
    for (let l = 1; l <= 5; l++) {
      expect(chevronsSvg(l).match(/<path /g)).toHaveLength(l);
      expect(portraitSvg(randomPortrait(crewRng(l)), 96, l)).toContain(`stroke-width="2.2"`);
    }
  });
});
