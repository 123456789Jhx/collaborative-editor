import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const proxy = {
  "/ws": {
    target: "ws://localhost:3000",
    ws: true,
  },
} as const;

export default defineConfig({
  resolve: {
    alias: {
      "@collab/shared": fileURLToPath(new URL("../shared/src/index.ts", import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy,
  },
  preview: {
    port: 4173,
    proxy,
  },
});
