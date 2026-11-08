import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    exclude: ["e2e/**", "node_modules/**"],
    testTimeout: 30_000,
    coverage: { include: ["src/**/*.ts"], exclude: ["src/main.ts"] },
  },
});
