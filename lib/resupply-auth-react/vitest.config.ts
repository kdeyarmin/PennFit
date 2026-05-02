import { defineConfig } from "vitest/config";

// The createAuthClient tests in src/client.test.ts manipulate
// `document.cookie` to verify CSRF-cookie injection, so we need a
// browser-like environment. jsdom is the lightest option that gives
// us `document` without spinning up a real browser.
//
// IMPORTANT: jsdom must be declared in this package's devDependencies
// (not just hoisted from somewhere else in the monorepo) — pnpm's
// strict workspace resolution won't let vitest reach into another
// package's node_modules to find it. If you see ERR_MODULE_NOT_FOUND
// for jsdom on a fresh install, that's the regression to look for.
export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["src/**/*.{test,spec}.ts"],
  },
});
