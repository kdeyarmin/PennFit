// @vitest-environment jsdom

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

import { FitRangeDiagram } from "./fit-range-diagram";

afterEach(cleanup);

describe("FitRangeDiagram", () => {
  it("states plainly when every measurement fits", () => {
    render(
      <FitRangeDiagram
        rows={[
          { label: "Nose width", value: 35, min: 30, max: 40 },
          { label: "Mouth width", value: 50, min: 45, max: 55 },
        ]}
      />,
    );
    // getByText throws when absent, so this asserts presence directly.
    expect(screen.getByText(/Every measurement sits inside/i)).toBeTruthy();
  });

  it("says how many measurements fall outside, and that it may still work", () => {
    // The patient is about to order this. Flagging the mismatch without
    // saying it can still work would push them off a viable mask; hiding
    // it would be worse.
    render(
      <FitRangeDiagram
        rows={[
          { label: "Nose width", value: 22, min: 30, max: 40 },
          { label: "Mouth width", value: 50, min: 45, max: 55 },
        ]}
      />,
    );
    expect(screen.getByText(/One measurement sits outside/i)).toBeTruthy();
    expect(screen.getByText(/can still work/i)).toBeTruthy();
  });

  it("gives every track a screen-reader description of the comparison", () => {
    // The bars carry the whole message; without a label they are decoration.
    render(
      <FitRangeDiagram
        rows={[{ label: "Nose width", value: 35, min: 30, max: 40 }]}
      />,
    );
    expect(
      screen.getByLabelText(
        /Nose width: yours 35 mm, this mask fits 30 mm to 40 mm — within range/i,
      ),
    ).toBeTruthy();
  });

  it("renders nothing when no row can be drawn honestly", () => {
    // An inverted range is bad data — better to show no diagram than a
    // diagram that reads as "no range".
    const { container } = render(
      <FitRangeDiagram
        rows={[{ label: "Nose width", value: 35, min: 40, max: 30 }]}
      />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("drops only the undrawable row and keeps the rest", () => {
    render(
      <FitRangeDiagram
        rows={[
          { label: "Bad", value: Number.NaN, min: 30, max: 40 },
          { label: "Nose width", value: 35, min: 30, max: 40 },
        ]}
      />,
    );
    expect(screen.getByText("Nose width")).toBeTruthy();
    expect(screen.queryByText("Bad")).toBeNull();
  });
});
