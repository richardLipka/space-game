import { describe, expect, it } from "vitest";
import { ESLint } from "eslint";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const eslint = new ESLint({ cwd: root });

async function ruleIds(code: string, filePath: string): Promise<string[]> {
  const [res] = await eslint.lintText(code, { filePath });
  return (res?.messages ?? []).map((m) => m.ruleId ?? "fatal");
}

describe("0.6 /sim boundary lint rules", () => {
  const simFile = "src/sim/core/__lint_probe__.ts";

  it.each([
    ['import { Application } from "pixi.js";\nexport const a = Application;', "no-restricted-imports"],
    ['import { x } from "../../render/scene";\nexport const a = x;', "no-restricted-imports"],
    ['import { y } from "../../ui/hud";\nexport const a = y;', "no-restricted-imports"],
    ['import { z } from "../../editor/snap";\nexport const a = z;', "no-restricted-imports"],
    ["export const r = Math.random();", "no-restricted-properties"],
    ["export const t = Date.now();", "no-restricted-properties"],
    ["export const d = new Date();", "no-restricted-syntax"],
    ["export const w = window.innerWidth;", "no-restricted-globals"],
    ["export const p = performance.now();", "no-restricted-globals"],
  ])("rejects %s", async (code, rule) => {
    expect(await ruleIds(code, simFile)).toContain(rule);
  });

  it("allows the same code outside /sim", async () => {
    const ids = await ruleIds("export const r = Math.random();", "src/render/__lint_probe__.ts");
    expect(ids).not.toContain("no-restricted-properties");
  });

  it("allows sim-internal imports", async () => {
    const ids = await ruleIds('import { Rng } from "./rng";\nexport const r = new Rng(1);', simFile);
    expect(ids).toEqual([]);
  });
});
