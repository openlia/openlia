import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const packageRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  plugins: [react({ jsxRuntime: "automatic" })],
  test: {
    environment: "happy-dom",
    include: [
      `${packageRoot}/src/client/**/*.test.ts`,
      `${packageRoot}/src/client/**/*.test.tsx`,
    ],
    setupFiles: [`${packageRoot}/src/client/test/setup.ts`],
  },
});
