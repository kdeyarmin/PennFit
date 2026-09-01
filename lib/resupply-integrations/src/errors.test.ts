// The adapter failure vocabulary.
//
// Every distinction below exists because collapsing it sends an operator
// to the wrong fix — and two of them ("do not translate every failure
// into no data", "do not retry a bad credential") are safety rules, not
// ergonomics.

import { describe, expect, it } from "vitest";

import {
  ADAPTER_ERRORS,
  ADAPTER_ERROR_CLASS,
  ADAPTER_ERROR_REMEDY,
  classifyHttpStatus,
  classifyNetworkError,
  indicatesUnhealthyConnector,
  inferPathKind,
  isRetryable,
} from "./errors";

describe("classifyHttpStatus", () => {
  it("returns null for a success", () => {
    expect(classifyHttpStatus(200)).toBeNull();
    expect(classifyHttpStatus(204)).toBeNull();
  });

  it("separates 401 (bad secret) from 403 (missing entitlement)", () => {
    // Reported identically, a 403 sends someone to rotate a perfectly
    // good credential. It is almost always a missing agreement.
    expect(classifyHttpStatus(401)).toBe("auth_failed");
    expect(classifyHttpStatus(403)).toBe("forbidden");
  });

  it("treats a 403 on the token endpoint as an auth failure", () => {
    // At the OAuth endpoint there is no resource to be un-entitled to.
    expect(classifyHttpStatus(403, "auth")).toBe("auth_failed");
  });

  it("separates a patient 404 from an endpoint 404", () => {
    // This is the one that lets a wrong URL survive a nightly sync: as
    // `not_found` it reads as "the vendor has no data for these
    // patients", which is exactly what a thousand-link sync then logs.
    expect(classifyHttpStatus(404, "patient")).toBe("not_found");
    expect(classifyHttpStatus(404, "collection")).toBe("endpoint_not_found");
  });

  it("defaults a 404 to endpoint_not_found — the loud reading", () => {
    // Erring this way produces an investigable configuration error about
    // a real 404. Erring the other way produces silence.
    expect(classifyHttpStatus(404)).toBe("endpoint_not_found");
  });

  it.each([
    [400, "bad_request"],
    [422, "bad_request"],
    [408, "timeout"],
    [429, "rate_limited"],
    [500, "server_error"],
    [503, "server_error"],
    [418, "unknown_error"],
  ])("classifies %i as %s", (status, expected) => {
    expect(classifyHttpStatus(status)).toBe(expected);
  });
});

describe("classifyNetworkError", () => {
  it("separates a timeout from a refused connection", () => {
    expect(classifyNetworkError({ name: "AbortError" })).toBe("timeout");
    expect(classifyNetworkError({ name: "TimeoutError" })).toBe("timeout");
    expect(classifyNetworkError({ code: "ETIMEDOUT" })).toBe("timeout");
    expect(classifyNetworkError({ code: "ECONNREFUSED" })).toBe("unavailable");
    expect(classifyNetworkError(new Error("boom"))).toBe("unavailable");
  });

  it("never throws on junk", () => {
    expect(classifyNetworkError(null)).toBe("unavailable");
    expect(classifyNetworkError(undefined)).toBe("unavailable");
    expect(classifyNetworkError("string")).toBe("unavailable");
  });
});

describe("inferPathKind", () => {
  it.each([
    "/v1/patients/abc123/therapy",
    "/api/patients/abc123",
    "/members/9/usage",
    "/v2/subjects/xyz/devices",
  ])("reads %s as a patient path", (path) => {
    expect(inferPathKind(path)).toBe("patient");
  });

  it.each(["/v1/patients", "/oauth/token", "/v1/devices", "/health"])(
    "reads %s as a collection path",
    (path) => {
      expect(inferPathKind(path)).toBe("collection");
    },
  );
});

describe("isRetryable", () => {
  it("never retries a configuration failure", () => {
    // Retrying a wrong client secret across a thousand links is how an
    // account gets locked out by the vendor.
    for (const error of [
      "auth_failed",
      "forbidden",
      "endpoint_not_found",
      "bad_request",
      "mapping_failed",
    ] as const) {
      expect(isRetryable(error)).toBe(false);
    }
  });

  it("retries a transient failure", () => {
    for (const error of [
      "rate_limited",
      "unavailable",
      "server_error",
      "timeout",
      "unknown_error",
    ] as const) {
      expect(isRetryable(error)).toBe(true);
    }
  });

  it("never retries a successful negative answer", () => {
    expect(isRetryable("not_found")).toBe(false);
    expect(isRetryable("no_data")).toBe(false);
  });
});

describe("indicatesUnhealthyConnector", () => {
  it("does not blame the connector for a patient the vendor never had", () => {
    expect(indicatesUnhealthyConnector("not_found")).toBe(false);
    expect(indicatesUnhealthyConnector("no_data")).toBe(false);
  });

  it("does blame the connector for everything else", () => {
    expect(indicatesUnhealthyConnector("auth_failed")).toBe(true);
    expect(indicatesUnhealthyConnector("forbidden")).toBe(true);
    expect(indicatesUnhealthyConnector("server_error")).toBe(true);
  });
});

describe("completeness", () => {
  it("classifies and gives a remedy for every error in the vocabulary", () => {
    // A new error with no class silently defaults to nothing; a new
    // error with no remedy shows an operator a bare code.
    for (const error of ADAPTER_ERRORS) {
      expect(ADAPTER_ERROR_CLASS[error]).toBeDefined();
      expect(ADAPTER_ERROR_REMEDY[error]).toBeTruthy();
    }
  });

  it("keeps the historical five, so stored values still mean what they meant", () => {
    for (const legacy of [
      "auth_failed",
      "not_found",
      "rate_limited",
      "unavailable",
      "unknown_error",
    ]) {
      expect(ADAPTER_ERRORS).toContain(legacy);
    }
  });

  it("tells an operator NOT to rotate a secret on a 403", () => {
    expect(ADAPTER_ERROR_REMEDY.forbidden).toContain("Do NOT rotate");
  });
});
