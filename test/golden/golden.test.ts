import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { goldenCases } from "./cases";

const stored = JSON.parse(readFileSync(join(__dirname, "hashes.json"), "utf8")) as Record<string, string>;

describe("golden runs", () => {
  for (const [name, run] of Object.entries(goldenCases)) {
    it(name, () => {
      expect(stored[name], `no stored hash for ${name}; run npm run golden:update`).toBeDefined();
      expect(run(), "hash changed: explain it in the PR, then npm run golden:update").toBe(stored[name]);
    });
  }

  it("no stale hashes", () => {
    expect(Object.keys(stored).sort()).toEqual(Object.keys(goldenCases).sort());
  });
});
