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
