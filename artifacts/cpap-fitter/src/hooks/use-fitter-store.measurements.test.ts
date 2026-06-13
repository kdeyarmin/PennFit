// @vitest-environment jsdom

import React from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { FacialMeasurements } from "@workspace/api-client-react/storefront";

import { FitterProvider, useFitterStore } from "./use-fitter-store";

const MEASUREMENTS_STORAGE_KEY = "fitter_measurements";

const sampleMeasurements: FacialMeasurements = {
  noseWidth: 31,
  noseHeight: 42,
  noseToChin: 88,
  mouthWidth: 51,
  faceWidthAtCheekbones: 139,
  calibrationMethod: "creditCard",
};

function StoreProbe() {
  const store = useFitterStore();
  return React.createElement(
    "div",
    null,
    React.createElement(
      "output",
      { "data-testid": "measurements" },
      JSON.stringify(store.measurements),
    ),
    React.createElement(
      "button",
      {
        type: "button",
        onClick: () =>
          store.setMeasurements({
            ...sampleMeasurements,
            capturedImage: "data:image/png;base64,not-for-storage",
          } as FacialMeasurements),
      },
      "save measurements",
    ),
    React.createElement(
      "button",
      {
        type: "button",
        onClick: () =>
          store.setCapturedImage("data:image/png;base64,also-not-for-storage"),
      },
      "save image",
    ),
    React.createElement(
      "button",
      { type: "button", onClick: store.reset },
      "reset",
    ),
  );
}

function renderStore() {
  render(
    React.createElement(FitterProvider, null, React.createElement(StoreProbe)),
  );
}

function visibleMeasurements(): FacialMeasurements | null {
  return JSON.parse(screen.getByTestId("measurements").textContent ?? "null");
}

beforeEach(() => {
  cleanup();
  sessionStorage.clear();
});

describe("use-fitter-store measurement persistence", () => {
  it("loads numeric measurements from sessionStorage on provider mount", () => {
    sessionStorage.setItem(
      MEASUREMENTS_STORAGE_KEY,
      JSON.stringify({
        ...sampleMeasurements,
        capturedImage: "data:image/png;base64,should-be-dropped",
      }),
    );

    renderStore();

    expect(visibleMeasurements()).toEqual(sampleMeasurements);
  });

  it("persists only measurement numbers and calibration method", () => {
    renderStore();

    fireEvent.click(screen.getByRole("button", { name: "save image" }));
    fireEvent.click(screen.getByRole("button", { name: "save measurements" }));

    const persisted = JSON.parse(
      sessionStorage.getItem(MEASUREMENTS_STORAGE_KEY) ?? "null",
    );
    expect(persisted).toEqual(sampleMeasurements);
    expect(persisted).not.toHaveProperty("capturedImage");
  });

  it("clears persisted measurements on reset", () => {
    sessionStorage.setItem(
      MEASUREMENTS_STORAGE_KEY,
      JSON.stringify(sampleMeasurements),
    );
    renderStore();

    fireEvent.click(screen.getByRole("button", { name: "reset" }));

    expect(sessionStorage.getItem(MEASUREMENTS_STORAGE_KEY)).toBeNull();
    expect(visibleMeasurements()).toBeNull();
  });
});
