// @vitest-environment jsdom
//
// Two regressions in one file, both about not trapping the user:
//
//  1. PlatformSystemInfoPage (the deployment-metadata view on the
//     platform console) must render its own graceful inline error — not
//     crash into the global ErrorBoundary — when /admin/system-info
//     returns an unexpected shape. fetchSystemInfo rejects on a bad shape,
//     so the query lands in its `isError` branch.
//  2. The demo on/off toggle now lives on its OWN slim tenant Settings
//     page with NO data fetch, so it can never be trapped behind a failed
//     system-info load. This pins that the toggle stays reachable.

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-query")>(
    "@tanstack/react-query",
  );
  return {
    ...actual,
    useQuery: () => ({
      data: undefined,
      isPending: false,
      isError: true,
      error: new Error("System info response was missing expected fields"),
    }),
  };
});

vi.mock("@/demo/DemoModeProvider", () => ({
  useDemoMode: () => ({
    isDemo: true,
    enterDemo: vi.fn(),
    exitDemo: vi.fn(),
  }),
}));

import { AdminSettingsPage, PlatformSystemInfoPage } from "./admin-settings";

afterEach(() => cleanup());

describe("PlatformSystemInfoPage — query error path", () => {
  it("renders without crashing into the ErrorBoundary", () => {
    expect(() => render(<PlatformSystemInfoPage />)).not.toThrow();
    expect(screen.getByTestId("platform-system-info-page")).toBeDefined();
  });

  it("shows the graceful inline error instead of a blank/crash screen", () => {
    render(<PlatformSystemInfoPage />);
    expect(screen.getByRole("alert").textContent).toMatch(
      /Couldn.t load system info/i,
    );
  });
});

describe("AdminSettingsPage — demo toggle is never trapped", () => {
  it("keeps the demo toggle reachable (no data fetch to fail)", () => {
    render(<AdminSettingsPage />);
    expect(screen.getByLabelText("Toggle demo mode")).toBeDefined();
  });
});
