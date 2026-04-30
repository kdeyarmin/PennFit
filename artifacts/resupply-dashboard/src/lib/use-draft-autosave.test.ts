// Unit tests for useDraftAutosave. We exercise:
//   - hydration from a pre-existing localStorage entry on mount
//   - debounced write on value change
//   - clear() drops the entry and resets `restored`
//   - re-keying (key change) re-hydrates from the new key
//   - empty existing draft → restored stays false
//
// jsdom provides a real-ish localStorage implementation, so we use
// that directly instead of stubbing. We do use `vi.useFakeTimers`
// to keep the debounce window deterministic — otherwise the tests
// would have to insert real-time setTimeouts which is flaky in CI.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

import { useDraftAutosave } from "./use-draft-autosave";

const STORAGE_PREFIX = "reply-draft:";

function lsGet(key: string): string | null {
  return window.localStorage.getItem(STORAGE_PREFIX + key);
}
function lsSet(key: string, value: string): void {
  window.localStorage.setItem(STORAGE_PREFIX + key, value);
}

describe("useDraftAutosave", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    window.localStorage.clear();
  });

  it("hydrates and reports restored=true when a draft exists", () => {
    lsSet("conv-1", "half-typed reply");
    const apply = vi.fn();
    const { result } = renderHook(() =>
      useDraftAutosave("conv-1", "", apply),
    );
    // Mount effect runs synchronously inside renderHook.
    expect(apply).toHaveBeenCalledWith("half-typed reply");
    expect(result.current.restored).toBe(true);
  });

  it("reports restored=false when no draft exists", () => {
    const apply = vi.fn();
    const { result } = renderHook(() =>
      useDraftAutosave("fresh-conv", "", apply),
    );
    expect(apply).not.toHaveBeenCalled();
    expect(result.current.restored).toBe(false);
  });

  it("debounces writes on value change", () => {
    const apply = vi.fn();
    const { rerender } = renderHook(
      ({ v }: { v: string }) => useDraftAutosave("conv-2", v, apply),
      { initialProps: { v: "" } },
    );

    rerender({ v: "h" });
    rerender({ v: "he" });
    rerender({ v: "hel" });
    // Inside the debounce window — nothing has been persisted yet.
    expect(lsGet("conv-2")).toBeNull();

    act(() => {
      vi.advanceTimersByTime(300);
    });
    // Only the latest value lands in storage.
    expect(lsGet("conv-2")).toBe("hel");
  });

  it("clear() drops the entry and resets restored to false", () => {
    lsSet("conv-3", "previously saved");
    const apply = vi.fn();
    const { result } = renderHook(() =>
      useDraftAutosave("conv-3", "previously saved", apply),
    );
    expect(result.current.restored).toBe(true);
    expect(lsGet("conv-3")).toBe("previously saved");

    act(() => {
      result.current.clear();
    });
    expect(lsGet("conv-3")).toBeNull();
    expect(result.current.restored).toBe(false);
  });

  it("re-hydrates when the key changes (e.g. switching conversations)", () => {
    lsSet("conv-A", "draft for A");
    lsSet("conv-B", "draft for B");
    const apply = vi.fn();
    const { rerender, result } = renderHook(
      ({ k }: { k: string }) => useDraftAutosave(k, "", apply),
      { initialProps: { k: "conv-A" } },
    );
    expect(apply).toHaveBeenLastCalledWith("draft for A");
    expect(result.current.restored).toBe(true);

    rerender({ k: "conv-B" });
    expect(apply).toHaveBeenLastCalledWith("draft for B");
    expect(result.current.restored).toBe(true);
  });

  it("clears the storage entry when value is set to empty string", () => {
    lsSet("conv-4", "some content");
    const apply = vi.fn();
    const { rerender } = renderHook(
      ({ v }: { v: string }) => useDraftAutosave("conv-4", v, apply),
      { initialProps: { v: "some content" } },
    );

    rerender({ v: "" });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    // Empty value → entry removed, not stored as "".
    expect(lsGet("conv-4")).toBeNull();
  });
});
