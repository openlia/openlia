import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { defineConfig } from "vite";

const backendUrl =
  process.env.OPENLIA_WORKSPACE_UI_BACKEND_URL ?? "http://127.0.0.1:8089";
const backendOrigin = new URL(backendUrl).origin;

export default defineConfig(() => ({
  plugins: [tanstackStart(), tailwindcss(), react()],
  build: {
    sourcemap: false,
  },
  server: {
    host: process.env.OPENLIA_WORKSPACE_UI_DEV_HOST ?? "127.0.0.1",
    port: Number(process.env.OPENLIA_WORKSPACE_UI_DEV_PORT ?? "5173"),
    proxy: {
      "/api/": {
        changeOrigin: true,
        headers: { origin: backendOrigin },
        target: backendUrl,
      },
      "/health": {
        changeOrigin: true,
        target: backendUrl,
      },
    },
  },
}));
