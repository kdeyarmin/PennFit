// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

import { PLATFORM_ICON_URL } from "@/lib/branding";
import { BrandHeader } from "./BrandHeader";

// The branding module fires a one-time GET /api/storefront-branding on
// first use. Stub it so the test never touches the network and the header
// stays on its bundled platform fallback.
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("BrandHeader", () => {
  it("renders the platform logo asset, not a text monogram", () => {
    render(<BrandHeader />);
    const mark = screen.getByTestId("admin-brand-mark");
    expect(mark.tagName).toBe("IMG");
    expect(mark.getAttribute("src")).toBe(PLATFORM_ICON_URL);
    // The wordmark-free square crop — the full lockup is illegible at 36px.
    expect(mark.getAttribute("src")).toContain("caremetric-icon");
    // The old placeholder is gone while the asset loads fine.
    expect(screen.queryByText("CB")).toBeNull();
  });

  it("falls back to the CB monogram when the asset fails to load", () => {
    render(<BrandHeader />);
    fireEvent.error(screen.getByTestId("admin-brand-mark"));
    expect(screen.queryByTestId("admin-brand-mark")).toBeNull();
    expect(screen.getByText("CB")).toBeTruthy();
  });
});
