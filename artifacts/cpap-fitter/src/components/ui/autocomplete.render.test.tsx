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

  it("matches on an option's description, not just its label", async () => {
    function DescHarness() {
      const [value, setValue] = useState("");
      return (
        <Autocomplete
          aria-label="HCPCS"
          value={value}
          onValueChange={setValue}
          options={[
            { value: "A7037", label: "A7037", description: "Tubing" },
            { value: "A7035", label: "A7035", description: "Headgear" },
          ]}
        />
      );
    }
    render(<DescHarness />);
    const input = screen.getByLabelText("HCPCS");
    fireEvent.change(input, { target: { value: "tub" } });
    await screen.findByRole("option", { name: /A7037/ });
    expect(screen.queryByRole("option", { name: /A7035/ })).toBeNull();
  });

  it("renders server-filtered options as-is when filterOptions is false", async () => {
    function ServerHarness() {
      const [value, setValue] = useState("");
      // Options that do NOT contain the typed text — as a server search
      // (matching on a hidden field like NPI) might return.
      return (
        <Autocomplete
          aria-label="Provider"
          value={value}
          onValueChange={setValue}
          filterOptions={false}
          options={[{ value: "Dr. Anna Singh", label: "Dr. Anna Singh" }]}
        />
      );
    }
    render(<ServerHarness />);
    const input = screen.getByLabelText("Provider");
    fireEvent.change(input, { target: { value: "1234" } });
    expect(
      await screen.findByRole("option", { name: /Dr\. Anna Singh/ }),
    ).toBeTruthy();
  });

  it("clamps a chosen suggestion to the field's maxLength", async () => {
    function MaxLenHarness() {
      const [value, setValue] = useState("");
      return (
        <Autocomplete
          aria-label="Payer"
          value={value}
          onValueChange={setValue}
          maxLength={5}
          options={["Highmark"]}
        />
      );
    }
    render(<MaxLenHarness />);
    const input = screen.getByLabelText("Payer") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "high" } });
    fireEvent.mouseDown(
      await screen.findByRole("option", { name: /Highmark/ }),
    );
    // "Highmark" (8 chars) is clamped to the maxLength of 5.
    expect(input.value).toBe("Highm");
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
