// @vitest-environment jsdom
//
// Keyboard-navigation coverage for the admin GlobalLookup combobox:
// ArrowDown/ArrowUp move the active option (with aria-activedescendant /
// aria-selected tracking), Enter opens the active hit, Escape closes.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

const navSpy = vi.fn();
vi.mock("wouter", () => ({
  useLocation: () => ["/", navSpy],
}));

import { GlobalLookup } from "./GlobalLookup";

const HITS = [
  {
    kind: "patient",
    id: "p1",
    label: "Jordan Rivera",
    href: "/admin/patients/p1",
    hint: "555-1234",
  },
  {
    kind: "shop_order",
    id: "o1",
    label: "Order #1001",
    href: "/admin/orders/o1",
    hint: null,
  },
];

beforeEach(() => {
  navSpy.mockReset();
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ hits: HITS }),
  }) as unknown as typeof fetch;
});
afterEach(() => cleanup());

async function openWithResults() {
  render(<GlobalLookup />);
  const input = screen.getByRole("combobox");
  fireEvent.change(input, { target: { value: "jordan" } });
  // The fetch is debounced 250ms; wait for the options to render.
  const options = await screen.findAllByRole("option", {}, { timeout: 2000 });
  expect(options).toHaveLength(2);
  return input;
}

describe("GlobalLookup keyboard navigation", () => {
  it("ArrowDown highlights the first option and tracks aria-activedescendant", async () => {
    const input = await openWithResults();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    const options = screen.getAllByRole("option");
    expect(options[0]!.getAttribute("aria-selected")).toBe("true");
    expect(options[1]!.getAttribute("aria-selected")).toBe("false");
    expect(input.getAttribute("aria-activedescendant")).toBe(
      "global-lookup-option-0",
    );
  });

  it("ArrowDown twice then Enter navigates to the second hit", async () => {
    const input = await openWithResults();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(navSpy).toHaveBeenCalledWith("/admin/orders/o1");
  });

  it("clamps at the last option (no wrap)", async () => {
    const input = await openWithResults();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" }); // would be index 2 — clamps to 1
    fireEvent.keyDown(input, { key: "Enter" });
    expect(navSpy).toHaveBeenCalledWith("/admin/orders/o1");
  });

  it("Enter without an active option does not navigate", async () => {
    const input = await openWithResults();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(navSpy).not.toHaveBeenCalled();
  });

  it("Escape closes the dropdown", async () => {
    const input = await openWithResults();
    expect(screen.getByRole("listbox")).toBeTruthy();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});

describe("GlobalLookup focus shortcut", () => {
  it("⌘K from anywhere focuses the lookup input", () => {
    render(<GlobalLookup />);
    const input = screen.getByRole("combobox");
    expect(document.activeElement).not.toBe(input);
    fireEvent.keyDown(document.body, { key: "k", metaKey: true });
    expect(document.activeElement).toBe(input);
  });

  it("Ctrl+K from anywhere focuses the lookup input", () => {
    render(<GlobalLookup />);
    const input = screen.getByRole("combobox");
    fireEvent.keyDown(document.body, { key: "K", ctrlKey: true });
    expect(document.activeElement).toBe(input);
  });

  it("a bare / focuses the lookup when not already typing", () => {
    render(<GlobalLookup />);
    const input = screen.getByRole("combobox");
    fireEvent.keyDown(document.body, { key: "/" });
    expect(document.activeElement).toBe(input);
  });

  it("/ does not steal focus while typing in another field", () => {
    render(<GlobalLookup />);
    const other = document.createElement("input");
    document.body.appendChild(other);
    other.focus();
    expect(document.activeElement).toBe(other);
    fireEvent.keyDown(other, { key: "/" });
    expect(document.activeElement).toBe(other);
    other.remove();
  });

  it("shows a keycap hint while empty and hides it once focused", () => {
    render(<GlobalLookup />);
    const input = screen.getByRole("combobox");
    expect(screen.getByText(/K$/)).toBeTruthy();
    fireEvent.focus(input);
    expect(screen.queryByText(/K$/)).toBeNull();
  });
});
