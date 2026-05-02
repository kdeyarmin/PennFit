import { describe, expect, it } from "vitest";
import {
  dashboardChunkForPackage,
  fitterChunkForPackage,
} from "../../../shared/vite/chunk-groups";

describe("dashboardChunkForPackage", () => {
  it("maps known dashboard deps", () => {
    expect(dashboardChunkForPackage("react")).toBe("react");
    expect(dashboardChunkForPackage("react-dom")).toBe("react");
    expect(dashboardChunkForPackage("@tanstack/react-query")).toBe("query");
    expect(dashboardChunkForPackage("wouter")).toBe("router");
  });

  it("returns undefined for unknown deps", () => {
    expect(dashboardChunkForPackage("zod")).toBeUndefined();
  });
});

describe("fitterChunkForPackage", () => {
  it("maps fitter groups", () => {
    expect(fitterChunkForPackage("@radix-ui/react-dialog")).toBe("ui");
    expect(fitterChunkForPackage("cmdk")).toBe("ui");
    expect(fitterChunkForPackage("vaul")).toBe("ui");
    expect(fitterChunkForPackage("recharts")).toBe("viz-motion");
    expect(fitterChunkForPackage("framer-motion")).toBe("viz-motion");
  });
});
