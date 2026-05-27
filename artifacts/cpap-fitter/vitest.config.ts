import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

// Most tests under src/** are pure helpers — no DOM, no React
// rendering — and run in the default node environment so we don't
// pay the jsdom startup cost. The React renderer is wired in here
// (via @vitejs/plugin-react) so that a small set of `*.render.test.tsx`
// files can opt into jsdom with a `// @vitest-environment jsdom`
// directive at the top of the file. Keep new render tests in that
// `.render.test.tsx` shape so the split stays obvious.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
  },
});
