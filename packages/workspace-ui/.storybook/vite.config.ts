import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Never inherit the application config: TanStack Start loads server/runtime code.
export default defineConfig({
  plugins: [tailwindcss(), react()],
  server: { host: "127.0.0.1", fs: { strict: true } },
});
