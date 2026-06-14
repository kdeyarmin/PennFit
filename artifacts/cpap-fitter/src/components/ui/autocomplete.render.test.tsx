// @vitest-environment jsdom
//
// Behavioral test for the reusable <Autocomplete>: it surfaces filtered
// suggestions after typing, fills the field when one is chosen, supports
// keyboard navigation, and never blocks arbitrary free text.

import { describe, it, expect, beforeEach } from "vitest";
import { useState } from "react";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react";

import { Autocomplete } from "./autocomplete";

const PAYERS = ["Highmark", "Aetna", "Cigna", "Medicare Part B"];

function Harness({ initial = "" }: { initial?: string }) {
  const [value, setValue] = useState(initial);
  return (
    <Autocomplete
      aria-label="Payer"
      value={value}
      onValueChange={setValue}
      options={PAYERS}
    />
  );
}

describe("Autocomplete", () => {
  beforeEach(() => cleanup());

  it("shows no list before typing", () => {
    render(<Harness />);
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("filters and surfaces a matching suggestion after typing", async () => {
    render(<Harness />);
    const input = screen.getByLabelText("Payer");
    fireEvent.change(input, { target: { value: "high" } });
    await waitFor(() => {
      expect(screen.getByRole("option", { name: /Highmark/ })).toBeTruthy();
    });
    // Non-matching options are not shown.
    expect(screen.queryByRole("option", { name: /Aetna/ })).toBeNull();
  });

  it("fills the field when a suggestion is clicked", async () => {
    render(<Harness />);
    const input = screen.getByLabelText("Payer") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "high" } });
    const option = await screen.findByRole("option", { name: /Highmark/ });
    fireEvent.mouseDown(option);
    expect(input.value).toBe("Highmark");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("selects the highlighted suggestion with the keyboard", async () => {
    render(<Harness />);
    const input = screen.getByLabelText("Payer") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "med" } });
    await screen.findByRole("option", { name: /Medicare Part B/ });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input.value).toBe("Medicare Part B");
  });

  it("allows free text not present in the catalog", () => {
    render(<Harness />);
    const input = screen.getByLabelText("Payer") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Some Local Plan" } });
    expect(input.value).toBe("Some Local Plan");
    // No matches -> no listbox, and the typed value stands.
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("hides the list once the value exactly matches a single option", async () => {
    render(<Harness />);
    const input = screen.getByLabelText("Payer");
    fireEvent.change(input, { target: { value: "Aetna" } });
    await waitFor(() => {
      expect(screen.queryByRole("option")).toBeNull();
    });
  });
});
