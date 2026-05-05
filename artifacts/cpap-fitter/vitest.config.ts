import { defineConfig } from "vitest/config";
import path from "node:path";

// The first round of tests under src/lib/* are pure helpers — no DOM,
// no React rendering. We use the default node environment so we don't
// pay the jsdom startup cost. If a future test needs `document` or RTL,
// switch this to "jsdom" and add jsdom to devDependencies.
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.{test,spec}.ts"],
  },
});
