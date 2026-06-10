// @vitest-environment jsdom
//
// Unit tests for the vite:preloadError → one-shot reload recovery. The
// host is a structural fake (real EventTarget + in-memory storage) because
// jsdom's location.reload is non-configurable and can't be spied on.

import { describe, it, expect, vi, afterEach } from "vitest";

import {
  installStaleChunkRecovery,
  type StaleChunkRecoveryHost,
} from "./stale-chunk-recovery";

function createHost(opts: { brokenStorage?: boolean } = {}) {
  const target = new EventTarget();
  const store = new Map<string, string>();
  const reload = vi.fn();
  const host: StaleChunkRecoveryHost = {
    addEventListener: (type, listener) =>
      target.addEventListener(type, listener),
    sessionStorage: opts.brokenStorage
      ? {
          getItem: () => {
            throw new Error("storage disabled");
          },
          setItem: () => {
            throw new Error("storage disabled");
          },
        }
      : {
          getItem: (k) => store.get(k) ?? null,
          setItem: (k, v) => void store.set(k, v),
        },
    location: { reload },
  };
  const dispatch = () =>
    // dispatchEvent returns false when preventDefault() was called.
    target.dispatchEvent(new Event("vite:preloadError", { cancelable: true }));
  return { host, dispatch, reload };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("installStaleChunkRecovery", () => {
  it("reloads once on the first preload error and suppresses the throw", () => {
    const { host, dispatch, reload } = createHost();
    installStaleChunkRecovery(host);

    const defaultNotPrevented = dispatch();

    expect(reload).toHaveBeenCalledTimes(1);
    expect(defaultNotPrevented).toBe(false);
  });

  it("does NOT reload again within the loop window — error reaches the boundary", () => {
    const { host, dispatch, reload } = createHost();
    installStaleChunkRecovery(host);

    dispatch();
    const defaultNotPrevented = dispatch();

    expect(reload).toHaveBeenCalledTimes(1);
    expect(defaultNotPrevented).toBe(true);
  });

  it("reloads again once the loop window has elapsed", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-10T12:00:00Z"));
    const { host, dispatch, reload } = createHost();
    installStaleChunkRecovery(host);

    dispatch();
    vi.setSystemTime(new Date("2026-06-10T12:02:00Z"));
    dispatch();

    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("never reloads when storage is unavailable (can't guard against a loop)", () => {
    const { host, dispatch, reload } = createHost({ brokenStorage: true });
    installStaleChunkRecovery(host);

    const defaultNotPrevented = dispatch();

    expect(reload).not.toHaveBeenCalled();
    expect(defaultNotPrevented).toBe(true);
  });
});
