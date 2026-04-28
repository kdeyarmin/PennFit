// Vitest config for the Penn Resupply Console.
//
// Standalone (does not extend `vite.config.ts`) because the vite
// config refuses to load unless PORT and BASE_PATH are set — those
// are dev-server concerns and shouldn't gate the test runner.
//
// `environment: "jsdom"` is required for any test that imports
// React or anything that touches `window` / `document`. Test files
// that genuinely run in node-only context (none today) can opt out
// per-file with `// @vitest-environment node`.
//
// `globals: false` — we deliberately do NOT inject `expect`,
// `describe`, etc. into the global scope. Tests import them from
// "vitest" so the source files remain ESM-explicit and grep-able.
//
// `plugins: [react()]` is required even for tests that don't render
// JSX directly — `.tsx` files compiled without the React plugin
// produce calls into the React runtime (`jsxDEV`, `Fragment`, etc.)
// that resolve to `React.createElement` under the classic transform,
// and tests fail at module-eval time with `React is not defined`.
// The plugin defaults to the automatic JSX runtime (React 17+),
// which matches the dev/build config in `vite.config.ts`.
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    environment: "jsdom",
    globals: false,
    // CSS is irrelevant to the assertions we make and pulling in
    // tailwind through the test runner is slow and noisy. Mark it
    // off so vite doesn't try to parse `.css` imports during a
    // jsdom render.
    css: false,
  },
});
