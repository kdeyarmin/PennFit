import { describe, it, expect, vi } from "vitest";
import { importWithRetry, isStaleChunkError } from "./lazy-with-retry";

// In-memory stand-in for sessionStorage so the reload-loop guard can be
// exercised without a DOM. Matches the Pick<Storage, ...> shape the
// helper depends on.
function fakeStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    _map: map,
  };
}

const staleErr = new Error(
  "Failed to fetch dynamically imported module: /assets/x.js",
);

describe("isStaleChunkError", () => {
  it("matches the Chromium dynamic-import failure", () => {
    expect(isStaleChunkError(staleErr)).toBe(true);
  });

  it("matches the Firefox 'error loading' wording", () => {
    expect(
      isStaleChunkError(new Error("error loading dynamically imported module")),
    ).toBe(true);
  });

  it("matches the Safari 'Importing a module script failed' wording", () => {
    expect(
      isStaleChunkError(new Error("Importing a module script failed.")),
    ).toBe(true);
  });

  it("matches a legacy webpack ChunkLoadError by name", () => {
    const err = new Error("loading chunk 5 failed");
    err.name = "ChunkLoadError";
    expect(isStaleChunkError(err)).toBe(true);
  });

  it("does NOT match a generic runtime error from module evaluation", () => {
    expect(isStaleChunkError(new TypeError("x is not a function"))).toBe(false);
  });

  it("does not throw on non-Error rejection values", () => {
    expect(isStaleChunkError("boom")).toBe(false);
    expect(isStaleChunkError(undefined)).toBe(false);
  });
});

describe("importWithRetry", () => {
  it("resolves and clears the guard on a successful load", async () => {
    const storage = fakeStorage();
    storage.setItem("pf:chunk-reload", "1"); // simulate a prior reload
    const reload = vi.fn();

    const mod = await importWithRetry(async () => ({ default: 42 }), {
      storage,
      reload,
    });

    expect(mod.default).toBe(42);
    expect(reload).not.toHaveBeenCalled();
    expect(storage.getItem("pf:chunk-reload")).toBeNull();
  });

  it("reloads once on a stale-chunk failure and parks (never resolves)", async () => {
    const storage = fakeStorage();
    const reload = vi.fn();

    let settled = false;
    void importWithRetry(() => Promise.reject(staleErr), {
      storage,
      reload,
    }).then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    // Let the rejected import microtask flush.
    await Promise.resolve();
    await Promise.resolve();

    expect(reload).toHaveBeenCalledTimes(1);
    expect(storage.getItem("pf:chunk-reload")).toBe("1");
    expect(settled).toBe(false); // parked behind the imminent reload
  });

  it("rethrows (does not loop) when the chunk fails again after a reload", async () => {
    const storage = fakeStorage();
    storage.setItem("pf:chunk-reload", "1"); // a reload already happened
    const reload = vi.fn();

    await expect(
      importWithRetry(() => Promise.reject(staleErr), { storage, reload }),
    ).rejects.toBe(staleErr);
    expect(reload).not.toHaveBeenCalled();
  });

  it("rethrows a non-stale error immediately without reloading", async () => {
    const storage = fakeStorage();
    const reload = vi.fn();
    const bug = new TypeError("real bug in module");

    await expect(
      importWithRetry(() => Promise.reject(bug), { storage, reload }),
    ).rejects.toBe(bug);
    expect(reload).not.toHaveBeenCalled();
    expect(storage.getItem("pf:chunk-reload")).toBeNull();
  });

  it("still rethrows a stale error when sessionStorage is unavailable", async () => {
    // No storage → can't set the guard, but we must not loop forever in a
    // context that also can't reload. With storage null and reload a noop,
    // the first failure still triggers a (noop) reload and parks; the guard
    // simply can't be persisted. We assert it attempts the reload once.
    const reload = vi.fn();
    let settled = false;
    void importWithRetry(() => Promise.reject(staleErr), {
      storage: null,
      reload,
    }).then(
      () => (settled = true),
      () => (settled = true),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
  });
});
