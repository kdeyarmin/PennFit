// Regression tests for the Supabase fetch timeout (app-review
// 2026-06-10, P2-1): without a per-request abort, a stalled PostgREST
// call rides undici's ~300s default and holds the caller the whole
// time. These tests exercise the pure helpers directly — the client
// builder wires them in via `global.fetch`.

import { describe, expect, it } from "vitest";

import {
  DEFAULT_SUPABASE_FETCH_TIMEOUT_MS,
  createTimeoutFetch,
  resolveSupabaseFetchTimeoutMs,
} from "./supabase-client";

describe("resolveSupabaseFetchTimeoutMs", () => {
  it("falls back to the default when unset", () => {
    expect(resolveSupabaseFetchTimeoutMs(undefined)).toBe(
      DEFAULT_SUPABASE_FETCH_TIMEOUT_MS,
    );
  });

  it("parses a positive integer", () => {
    expect(resolveSupabaseFetchTimeoutMs("5000")).toBe(5000);
  });

  it.each(["0", "-10", "abc", ""])("falls back on invalid value %j", (raw) => {
    expect(resolveSupabaseFetchTimeoutMs(raw)).toBe(
      DEFAULT_SUPABASE_FETCH_TIMEOUT_MS,
    );
  });
});

describe("createTimeoutFetch", () => {
  it("passes through a response that completes before the timeout", async () => {
    const response = new Response("ok");
    const wrapped = createTimeoutFetch(1_000, async () => response);
    await expect(wrapped("https://example.test/")).resolves.toBe(response);
  });

  it("always attaches an AbortSignal to the underlying fetch", async () => {
    let seenSignal: AbortSignal | null | undefined;
    const wrapped = createTimeoutFetch(1_000, async (_input, init) => {
      seenSignal = init?.signal;
      return new Response("ok");
    });
    await wrapped("https://example.test/");
    expect(seenSignal).toBeInstanceOf(AbortSignal);
  });

  it("aborts a fetch that outlives the timeout", async () => {
    // Base fetch that never resolves on its own — only the signal
    // can end it, exactly like a stalled PostgREST socket.
    const wrapped = createTimeoutFetch(20, (_input, init) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(init.signal?.reason ?? new Error("aborted")),
        );
      });
    });
    await expect(wrapped("https://example.test/")).rejects.toMatchObject({
      name: "TimeoutError",
    });
  });

  it("still honors the caller's own abort signal", async () => {
    const controller = new AbortController();
    const wrapped = createTimeoutFetch(60_000, (_input, init) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(init.signal?.reason ?? new Error("aborted")),
        );
      });
    });
    const pending = wrapped("https://example.test/", {
      signal: controller.signal,
    });
    controller.abort(new Error("caller-cancelled"));
    await expect(pending).rejects.toMatchObject({
      message: "caller-cancelled",
    });
  });
});
