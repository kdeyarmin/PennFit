// @vitest-environment jsdom
//
// Regression tests for the global demo-mode banner (app-review
// 2026-06-10, P2-7): `?demo=1` persists in localStorage, so without a
// visible banner + exit a customer who followed a shared demo link
// would browse a fake-data storefront indefinitely with no indication
// and no way out.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DemoBanner } from "./DemoBanner";
import { DemoModeProvider } from "./DemoModeProvider";
import { __resetDemoStateForTests, setDemoActive } from "./state";

// reloadIntoMode calls window.location.reload(); stub it so the exit
// click is observable instead of fatal in jsdom.
const reloadMock = vi.fn();

beforeEach(() => {
  __resetDemoStateForTests();
  window.localStorage.clear();
  reloadMock.mockClear();
  Object.defineProperty(window, "location", {
    value: { ...window.location, reload: reloadMock },
    writable: true,
  });
});

afterEach(() => {
  cleanup();
  __resetDemoStateForTests();
  window.localStorage.clear();
});

function renderBanner() {
  return render(
    <DemoModeProvider>
      <DemoBanner />
    </DemoModeProvider>,
  );
}

describe("DemoBanner", () => {
  it("renders nothing when demo mode is off", () => {
    renderBanner();
    expect(screen.queryByTestId("demo-mode-banner")).toBeNull();
  });

  it("names the mode and offers an exit while demo mode is active", () => {
    setDemoActive(true);
    renderBanner();
    expect(screen.getByTestId("demo-mode-banner").textContent).toContain(
      "sample data",
    );
    expect(screen.getByTestId("demo-mode-exit")).toBeTruthy();
  });

  it("exit click leaves demo mode and reloads into the live site", () => {
    setDemoActive(true);
    renderBanner();
    fireEvent.click(screen.getByTestId("demo-mode-exit"));
    expect(window.localStorage.getItem("pennfit:demo-mode:v1")).not.toBe("1");
    expect(reloadMock).toHaveBeenCalled();
  });
});
