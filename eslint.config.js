// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

/**
 * Simulation boundary rules (spec §13.2, §13.4).
 * /src/sim must stay pure and deterministic: no rendering/UI/editor imports,
 * no DOM, no wall-clock time, no unseeded randomness.
 */
const simBoundary = {
  files: ["src/sim/**/*.ts"],
  rules: {
    "no-restricted-imports": [
      "error",
      {
        patterns: [
          {
            group: ["pixi.js", "pixi.js/*", "@pixi/*"],
            message: "The simulation must not depend on rendering (spec §13.2).",
          },
          {
            group: ["**/render", "**/render/**", "**/ui", "**/ui/**", "**/editor", "**/editor/**"],
            message: "/sim must not import render, ui or editor code (spec §13.2).",
          },
        ],
      },
    ],
    "no-restricted-properties": [
      "error",
      { object: "Math", property: "random", message: "Use the seeded Rng from sim/core/rng (spec §13.4)." },
      {
        object: "Date",
        property: "now",
        message: "Wall-clock time is not allowed in /sim; use the tick counter.",
      },
      {
        object: "performance",
        property: "now",
        message: "Wall-clock time is not allowed in /sim; use the tick counter.",
      },
    ],
    "no-restricted-globals": [
      "error",
      { name: "window", message: "No DOM access in /sim." },
      { name: "document", message: "No DOM access in /sim." },
      { name: "performance", message: "No wall-clock time in /sim." },
      { name: "crypto", message: "Use sim/core/hash (deterministic, sync) instead." },
    ],
    "no-restricted-syntax": [
      "error",
      { selector: "NewExpression[callee.name='Date']", message: "Wall-clock time is not allowed in /sim." },
    ],
  },
};

export default tseslint.config(
  { ignores: ["dist/", "node_modules/", "coverage/", "playwright-report/", "test-results/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  simBoundary,
  prettier,
);
