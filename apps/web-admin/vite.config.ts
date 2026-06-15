import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

// The API normally serves this build at / (and prod fronts it via CloudFront), so
// the SPA calls `/api/*` and `/health` same-origin. When running the Vite dev server
// standalone, proxy those paths to the local API so login/session work end-to-end.
const API_TARGET = process.env.API_PROXY ?? "http://localhost:3000";

export default defineConfig({
  plugins: [svelte()],
  build: {
    outDir: "dist",
  },
  server: {
    // Bind all interfaces so the standalone dev server is reachable on the LAN.
    host: true,
    proxy: {
      "/api": { target: API_TARGET, changeOrigin: true },
      "/health": { target: API_TARGET, changeOrigin: true },
    },
  },
});
