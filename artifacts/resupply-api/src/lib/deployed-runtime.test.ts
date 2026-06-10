// Tests for the deployed-runtime detector that arms the boot-time
// SPA-dist guard (app.ts). The 2026-06-10 outage shape: Railway never
// injects NODE_ENV, so a NODE_ENV-only guard stays quiet on Railway
// and a dist-less image goes live behind the liveness probe. The
// detector must treat ANY Railway runtime marker as "deployed".

import { describe, it, expect } from "vitest";

import { isDeployedRuntime } from "./deployed-runtime";

describe("isDeployedRuntime", () => {
  it("is false for a bare dev environment", () => {
    expect(isDeployedRuntime({})).toBe(false);
    expect(isDeployedRuntime({ NODE_ENV: "development" })).toBe(false);
    expect(isDeployedRuntime({ NODE_ENV: "test" })).toBe(false);
  });

  it("is true under NODE_ENV=production (historical key)", () => {
    expect(isDeployedRuntime({ NODE_ENV: "production" })).toBe(true);
  });

  it("is true under each Railway-injected marker, without NODE_ENV", () => {
    expect(isDeployedRuntime({ RAILWAY_ENVIRONMENT: "production" })).toBe(true);
    expect(isDeployedRuntime({ RAILWAY_ENVIRONMENT_NAME: "production" })).toBe(
      true,
    );
    expect(isDeployedRuntime({ RAILWAY_PROJECT_ID: "p-123" })).toBe(true);
    expect(
      isDeployedRuntime({ RAILWAY_PUBLIC_DOMAIN: "pennfit.up.railway.app" }),
    ).toBe(true);
  });

  it("ignores empty / whitespace-only markers", () => {
    expect(
      isDeployedRuntime({ RAILWAY_ENVIRONMENT: "", RAILWAY_PROJECT_ID: "  " }),
    ).toBe(false);
  });
});
