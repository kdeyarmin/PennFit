// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ResolvedScenario } from "@/lib/admin/pricing-api";
import { PricingVolumeScenarios } from "./PricingVolumeScenarios";
afterEach(cleanup);
describe("explicit pricing volume assumptions", () => {
  it("does not invent demand and weights margins by revenue instead of averaging percentages", () => {
    const entries = [
      {
        scenario: { lines: [{ sku: "A", quantity: 1 }] },
        evaluation: {
          calculationComplete: true,
          netRevenueCents: 10000,
          contributionCents: 5000,
        },
      },
      {
        scenario: { lines: [{ sku: "B", quantity: 1 }] },
        evaluation: {
          calculationComplete: true,
          netRevenueCents: 1000,
          contributionCents: 100,
        },
      },
    ] as ResolvedScenario[];
    render(<PricingVolumeScenarios entries={entries} />);
    expect(screen.getByText(/Enter a whole-number volume/)).toBeTruthy();
    const inputs = screen.getAllByPlaceholderText("Enter an assumption");
    fireEvent.change(inputs[0], { target: { value: "1" } });
    fireEvent.change(inputs[1], { target: { value: "10" } });
    expect(
      screen.getByText(
        /Combined monthly revenue \$200.00 · Contribution \$60.00 · Weighted margin 30.00%/,
      ),
    ).toBeTruthy();
    fireEvent.change(inputs[0], { target: { value: "1.5" } });
    expect(screen.getByText(/Enter a whole-number volume/)).toBeTruthy();
  });
});
