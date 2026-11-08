import { defineConfig } from "vite";

export default defineConfig({
  server: { port: 5173, strictPort: true },
  // PixiJS alone is ~500 kB minified; one bundle is fine for a game prototype.
  build: { target: "es2022", sourcemap: true, chunkSizeWarningLimit: 1500 },
});
