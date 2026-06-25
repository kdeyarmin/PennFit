/**
 * Side-effecting boot guard: validate required env vars BEFORE any other
 * side-effecting import runs.
 *
 * Why a dedicated module rather than a bare `assertRequiredEnv()` statement
 * in index.ts: ES-module `import` statements are HOISTED, so every imported
 * module BODY (e.g. `./app`, which throws at module-eval when CORS env is
 * missing in production, and its transitive imports) is fully evaluated
 * BEFORE any top-level statement in index.ts executes. A bare
 * `assertRequiredEnv()` call sandwiched between imports therefore runs AFTER
 * those side effects — defeating the aggregated "list EVERY missing var in
 * one error" guarantee. esbuild (the production bundler) orders imported
 * module bodies by import-statement source order, so making this the FIRST
 * import of index.ts guarantees the env check runs first.
 *
 * This module only validates env. It does NOT start the HTTP listener or the
 * worker, so it does not affect the HTTP-before-worker decoupling.
 */

import { assertRequiredEnv } from "./env-check";

// Fail fast on a misconfigured deploy. Surfaces a single clear startup error
// listing every missing required variable, rather than a confusing
// mid-request throw deep in a route handler.
assertRequiredEnv();
