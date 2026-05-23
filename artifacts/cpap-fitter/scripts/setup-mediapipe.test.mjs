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

// Regression: SKIP_MEDIAPIPE_MODEL_DOWNLOAD escape hatch was removed in this
// PR. Setting the env var must no longer suppress the model download — the
// fetch should still be attempted (and here it immediately throws because the
// WASM copy step fails first, but the important invariant is that we do NOT
// return early before reaching the network path).
test("SKIP_MEDIAPIPE_MODEL_DOWNLOAD=1 is no longer honored — main() does not short-circuit", async () => {
  const { main } = await import("./setup-mediapipe.mjs");

  const originalSkip = process.env.SKIP_MEDIAPIPE_MODEL_DOWNLOAD;
  const originalWarn = console.warn;
  const originalLog = console.log;
  process.env.SKIP_MEDIAPIPE_MODEL_DOWNLOAD = "1";
  console.warn = () => {};
  console.log = () => {};

  try {
    // main() will throw because the WASM node_modules path doesn't exist in
    // the test environment. What we're asserting is that the early-return
    // escape hatch is gone: the function must throw (attempt to proceed) rather
    // than silently return when SKIP_MEDIAPIPE_MODEL_DOWNLOAD is set.
    //
    // Previously, setting the flag caused main() to resolve (return undefined).
    // After this PR's removal, main() must throw (no silent skip).
    let threw = false;
    try {
      await main();
    } catch {
      threw = true;
    }
    assert.ok(
      threw,
      "main() should throw (attempt to run) when SKIP_MEDIAPIPE_MODEL_DOWNLOAD=1, not silently return",
    );
  } finally {
    if (originalSkip === undefined) {
      delete process.env.SKIP_MEDIAPIPE_MODEL_DOWNLOAD;
    } else {
      process.env.SKIP_MEDIAPIPE_MODEL_DOWNLOAD = originalSkip;
    }
    console.warn = originalWarn;
    console.log = originalLog;
  }
});
