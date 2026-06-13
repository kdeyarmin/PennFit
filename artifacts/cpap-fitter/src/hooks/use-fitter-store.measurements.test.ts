// Static regression checks for fitter measurement persistence. The
// captured camera image must remain in memory only; numeric measurements
// may survive a refresh so the flow can continue safely.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "use-fitter-store.tsx"), "utf8");

describe("use-fitter-store measurement persistence", () => {
  it("loads initial measurements from the fitter_measurements session key", () => {
    expect(SRC).toContain(
      'const MEASUREMENTS_STORAGE_KEY = "fitter_measurements"',
    );
    expect(SRC).toContain(
      "useState<FacialMeasurements | null>(readStoredMeasurements)",
    );
  });

  it("persists only numeric measurement fields and calibration method", () => {
    const setterStart = SRC.indexOf("const setMeasurements =");
    const resetStart = SRC.indexOf("const reset =", setterStart);
    const setterSrc = SRC.slice(setterStart, resetStart);

    expect(setterSrc).toContain("sessionStorage.setItem(");
    expect(setterSrc).toContain("MEASUREMENTS_STORAGE_KEY");
    expect(setterSrc).toContain("noseWidth: nextMeasurements.noseWidth");
    expect(setterSrc).toContain(
      "calibrationMethod: nextMeasurements.calibrationMethod",
    );
    expect(setterSrc).not.toContain("capturedImage");
  });

  it("clears persisted measurements on reset", () => {
    expect(SRC).toContain(
      "sessionStorage.removeItem(MEASUREMENTS_STORAGE_KEY)",
    );
  });
});
