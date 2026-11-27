import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: resolve(__dirname, "src/client"),
  plugins: [tailwindcss(), react()],
  build: {
    outDir: resolve(__dirname, "dist/client"),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (
            id.includes("node_modules/@codemirror") ||
            id.includes("node_modules/@lezer")
          ) {
            return "codemirror";
          }
          if (
            id.includes("node_modules/@openuidev") ||
            id.includes("node_modules/lucide-react") ||
            id.includes("node_modules/refractor") ||
            id.includes("node_modules/react-syntax-highlighter")
          ) {
            return "openui";
          }
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8089",
      "/health": "http://127.0.0.1:8089",
    },
  },
});
