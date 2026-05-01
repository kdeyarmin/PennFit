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
