import test from "node:test";
import assert from "node:assert/strict";

import { downloadModelWithRetry } from "./setup-mediapipe.mjs";

test("downloadModelWithRetry retries failures and eventually succeeds", async () => {
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  let calls = 0;
  console.warn = () => {};

  globalThis.fetch = async () => {
    calls += 1;
    if (calls < 3) {
      throw new Error("transient");
    }
    return {
      ok: true,
      arrayBuffer: async () => new Uint8Array(1024 * 1024 + 10).buffer,
    };
  };

  try {
    const buf = await downloadModelWithRetry(3);
    assert.ok(buf.length > 1024 * 1024);
    assert.equal(calls, 3);
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  }
});

test("downloadModelWithRetry throws after exhausting retries", async () => {
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  let calls = 0;
  console.warn = () => {};

  globalThis.fetch = async () => {
    calls += 1;
    throw new Error("always fails");
  };

  try {
    await assert.rejects(() => downloadModelWithRetry(2), /always fails/);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  }
});

test("downloadModelWithRetry rejects undersized payload", async () => {
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  console.warn = () => {};

  globalThis.fetch = async () => ({
    ok: true,
    arrayBuffer: async () => new Uint8Array(128).buffer,
  });

  try {
    await assert.rejects(
      () => downloadModelWithRetry(1),
      /Downloaded file is too small/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  }
});

// ---------------------------------------------------------------------------
// Source-level assertions for the isProductionBuild / strictMode changes
// introduced in the railway-hosting R1 fix (see
// docs/railway-hosting-review-2026-05-29.md). The error-handler block that
// implements strictMode runs at process-exit time and is not exported, so
// we verify the structural invariants directly from the source text.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __scriptDir = dirname(fileURLToPath(import.meta.url));
const SCRIPT_SRC = readFileSync(
  join(__scriptDir, "setup-mediapipe.mjs"),
  "utf8",
);

// Strip single-line comments so pattern searches aren't confused by
// comment-only references to the same identifier.
const SCRIPT_CODE = SCRIPT_SRC.replace(/(^|[^:])\/\/[^\n]*/gm, "$1");

test("isProductionBuild triggers on npm_lifecycle_event === 'prebuild'", () => {
  assert.ok(
    SCRIPT_CODE.includes('lifecycle === "prebuild"'),
    "Expected isProductionBuild to check lifecycle === \"prebuild\"",
  );
});

test("isProductionBuild triggers on npm_lifecycle_event === 'build'", () => {
  assert.ok(
    SCRIPT_CODE.includes('lifecycle === "build"'),
    "Expected isProductionBuild to check lifecycle === \"build\"",
  );
});

test("isProductionBuild checks for any RAILWAY_* environment variable via startsWith", () => {
  assert.ok(
    SCRIPT_CODE.includes('startsWith("RAILWAY_")'),
    "Expected isProductionBuild to detect any RAILWAY_* env var via k.startsWith(\"RAILWAY_\")",
  );
});

test("isProductionBuild uses Object.keys(process.env) to detect RAILWAY_* vars", () => {
  assert.ok(
    SCRIPT_CODE.includes("Object.keys(process.env)"),
    "Expected Object.keys(process.env) scan for RAILWAY_* vars",
  );
});

test("strictMode includes isProductionBuild as a trigger condition", () => {
  // The new strictMode must be the union of: CI, NODE_ENV=production, AND isProductionBuild.
  const strictModeMatch = SCRIPT_CODE.match(
    /const strictMode\s*=\s*([\s\S]*?);/,
  );
  assert.ok(strictModeMatch, "Could not locate strictMode declaration");
  const strictExpr = strictModeMatch[1];
  assert.ok(
    strictExpr.includes("isProductionBuild"),
    "Expected strictMode to include isProductionBuild",
  );
});

test("strictMode still includes CI === 'true' as a trigger condition", () => {
  const strictModeMatch = SCRIPT_CODE.match(
    /const strictMode\s*=\s*([\s\S]*?);/,
  );
  assert.ok(strictModeMatch, "Could not locate strictMode declaration");
  const strictExpr = strictModeMatch[1];
  assert.ok(
    strictExpr.includes('process.env.CI === "true"'),
    "Expected strictMode to retain CI === \"true\" condition",
  );
});

test("strictMode still includes NODE_ENV === 'production' as a trigger condition", () => {
  const strictModeMatch = SCRIPT_CODE.match(
    /const strictMode\s*=\s*([\s\S]*?);/,
  );
  assert.ok(strictModeMatch, "Could not locate strictMode declaration");
  const strictExpr = strictModeMatch[1];
  assert.ok(
    strictExpr.includes('process.env.NODE_ENV === "production"'),
    "Expected strictMode to retain NODE_ENV === \"production\" condition",
  );
});

test("npm_lifecycle_event is read from process.env before isProductionBuild is computed", () => {
  const lifecycleIdx = SCRIPT_CODE.indexOf("npm_lifecycle_event");
  const productionBuildIdx = SCRIPT_CODE.indexOf("isProductionBuild");
  assert.ok(lifecycleIdx > -1, "npm_lifecycle_event not found in source");
  assert.ok(productionBuildIdx > -1, "isProductionBuild not found in source");
  assert.ok(
    lifecycleIdx < productionBuildIdx,
    "npm_lifecycle_event must be read before isProductionBuild is declared",
  );
});

test("error message names storage.googleapis.com so the operator knows what to unblock", () => {
  // Extract the console.error string literal and check the hostname appears
  // inside the error message itself (not anywhere in the source file). This
  // also avoids CodeQL's js/incomplete-url-substring-sanitization heuristic,
  // which flags bare `.includes("…domain…")` calls on URL-looking strings.
  const errorMsgMatch = SCRIPT_SRC.match(
    /console\.error\(\s*([\s\S]*?)\s*\);/,
  );
  assert.ok(errorMsgMatch, "Could not locate console.error call");
  assert.ok(
    /\bstorage\.googleapis\.com\b/.test(errorMsgMatch[1]),
    "Expected error message to mention storage.googleapis.com as the blocked endpoint",
  );
});

test("error message mentions SKIP_MEDIAPIPE_MODEL_DOWNLOAD=1 as the escape hatch", () => {
  // The operator should know how to opt out of strict mode without removing the guard.
  // Use raw source (not comment-stripped) to check the error string itself.
  const errorMsgMatch = SCRIPT_SRC.match(
    /console\.error\(\s*([\s\S]*?)\s*\);/,
  );
  assert.ok(errorMsgMatch, "Could not locate console.error call");
  assert.ok(
    errorMsgMatch[1].includes("SKIP_MEDIAPIPE_MODEL_DOWNLOAD=1"),
    "Expected error message to mention SKIP_MEDIAPIPE_MODEL_DOWNLOAD=1",
  );
});

test("error message says the deploy would ship a broken face-scan", () => {
  const errorMsgMatch = SCRIPT_SRC.match(
    /console\.error\(\s*([\s\S]*?)\s*\);/,
  );
  assert.ok(errorMsgMatch, "Could not locate console.error call");
  const errorText = errorMsgMatch[1].toLowerCase();
  assert.ok(
    errorText.includes("broken face-scan") || errorText.includes("broken face"),
    "Expected error message to convey that the deploy would ship a broken face-scan",
  );
});

test("process.exit(1) follows the strict-mode guard when model is absent", () => {
  // The strict-mode guard must lead to process.exit(1). Match the guard
  // structurally (strictMode + hasCachedModel) rather than pinning its
  // exact phrasing, so a hardening such as `(setupFailed || !hasCachedModel)`
  // doesn't break this assertion.
  const guardMatch = SCRIPT_CODE.match(
    /if \(strictMode &&.*hasCachedModel.*\)\s*\{/,
  );
  assert.ok(guardMatch, "Could not find strictMode guard");
  const strictModeIdx = guardMatch.index;
  const exitOneIdx = SCRIPT_CODE.indexOf("process.exit(1)");
  assert.ok(exitOneIdx > -1, "Could not find process.exit(1)");
  assert.ok(
    exitOneIdx > strictModeIdx,
    "process.exit(1) must come after the strictMode guard",
  );
});

// ---------------------------------------------------------------------------

test("main() honors SKIP_MEDIAPIPE_MODEL_DOWNLOAD=1 and does not fetch the model", async () => {
  const { main } = await import("./setup-mediapipe.mjs");

  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  const originalLog = console.log;
  const originalSkip = process.env.SKIP_MEDIAPIPE_MODEL_DOWNLOAD;
  let fetchCalls = 0;

  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("should not be called when skip flag is set");
  };
  console.warn = () => {};
  console.log = () => {};
  process.env.SKIP_MEDIAPIPE_MODEL_DOWNLOAD = "1";

  try {
    // We can't easily assert main()'s WASM copy step here (it requires
    // node_modules layout); accept either successful return or a WASM-
    // related error, as long as we never reached the network fetch.
    await main().catch((err) => {
      if (!/tasks-vision\/wasm/.test(String(err?.message ?? ""))) throw err;
    });
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
    console.log = originalLog;
    if (originalSkip === undefined)
      delete process.env.SKIP_MEDIAPIPE_MODEL_DOWNLOAD;
    else process.env.SKIP_MEDIAPIPE_MODEL_DOWNLOAD = originalSkip;
  }
});
