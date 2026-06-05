// @vitest-environment jsdom
//
// Anti-trap regression test for AdminSettingsPage.
//
// The demo on/off toggle lives on the Settings page. If the page crashes
// when /admin/system-info returns an unexpected shape (the historical
// behavior: a raw TypeError mid-render bubbling to the global
// ErrorBoundary), the user is trapped in demo mode — the only toggle to
// get out is on the page that just crashed.
//
// fetchSystemInfo now rejects on a bad shape, so the query lands in its
// `isError` branch. This test pins that down: on a query error the page
// must still render, show its own graceful inline error, and keep the demo
// toggle on screen and operable.

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

import { AdminSettingsPage } from "./admin-settings";

afterEach(() => cleanup());

describe("AdminSettingsPage — query error path", () => {
  it("renders without crashing into the ErrorBoundary", () => {
    expect(() => render(<AdminSettingsPage />)).not.toThrow();
    expect(screen.getByTestId("admin-settings-page")).toBeDefined();
  });

  it("shows the graceful inline error instead of a blank/crash screen", () => {
    render(<AdminSettingsPage />);
    expect(screen.getByRole("alert").textContent).toMatch(
      /Couldn.t load system info/i,
    );
  });

  it("keeps the demo toggle reachable so the user can exit demo mode", () => {
    render(<AdminSettingsPage />);
    expect(screen.getByLabelText("Toggle demo mode")).toBeDefined();
  });
});
