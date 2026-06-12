// Tests for ErrorPanel's describeError() — the function that turns a thrown
// query error into the panel's headline detail + optional "HTTP nnn" badge.
//
// The key behaviour under test: a non-ApiError (e.g. the plain Error that the
// hand-rolled admin API wrappers throw) must surface its REAL message rather
// than the generic "Network error. Check your connection and retry." copy,
// which is now reserved for genuine network-layer failures.

import { ApiError } from "@workspace/api-client-react/admin";
import { describe, expect, test } from "vitest";

import { describeError } from "./ErrorPanel";

function apiError(status: number, data: unknown = null): ApiError {
  const response = {
    status,
    statusText: "",
    headers: new Headers(),
    url: "https://example.test/x",
  } as unknown as Response;
  return new ApiError(response, data, { method: "GET", url: "/x" });
}

describe("describeError — ApiError handling", () => {
  test("401 maps to the signed-out message with HTTP badge", () => {
    const { detail, statusLabel } = describeError(apiError(401));
    expect(statusLabel).toBe("HTTP 401");
    expect(detail).toMatch(/signed out/i);
  });

  test("403 maps to the no-access message", () => {
    expect(describeError(apiError(403)).detail).toMatch(/don't have access/i);
  });

  test("404 maps to the not-found message", () => {
    expect(describeError(apiError(404)).detail).toMatch(/not found/i);
  });

  test("500 maps to the server-error message", () => {
    const { detail, statusLabel } = describeError(apiError(500));
    expect(statusLabel).toBe("HTTP 500");
    expect(detail).toMatch(/server returned an error/i);
  });

  test("invalid_query validation surfaces the first issue", () => {
    const err = apiError(400, {
      error: "invalid_query",
      issues: [{ path: "region", message: "bad value" }],
    });
    expect(describeError(err).detail).toMatch(/region — bad value/);
  });

  test("invalid_body validation surfaces the first issue", () => {
    const err = apiError(400, {
      error: "invalid_body",
      issues: [{ path: "recipientFaxE164", message: "Fax must be E.164" }],
    });
    expect(describeError(err).detail).toMatch(
      /recipientFaxE164 — Fax must be E\.164/,
    );
  });

  test("a server-provided message wins over the generic status copy", () => {
    const err = apiError(502, {
      error: "fax_send_failed",
      message: "Telnyx fax error: number unreachable",
    });
    expect(describeError(err).detail).toBe(
      "Telnyx fax error: number unreachable",
    );
  });
});

describe("describeError — non-ApiError (plain Error) handling", () => {
  test("surfaces the real message instead of the network-error copy", () => {
    const { detail } = describeError(
      new Error("Failed to load analytics (500)"),
    );
    expect(detail).toBe("Failed to load analytics (500)");
    expect(detail).not.toMatch(/check your connection/i);
  });

  test("extracts an HTTP badge from a parenthesised status", () => {
    expect(
      describeError(new Error("Failed to load customers (403)")).statusLabel,
    ).toBe("HTTP 403");
  });

  test("extracts an HTTP badge from an 'HTTP nnn' message", () => {
    expect(
      describeError(new Error("Failed to load documents (HTTP 503)."))
        .statusLabel,
    ).toBe("HTTP 503");
  });

  test("extracts an HTTP badge from a leading status code", () => {
    expect(describeError(new Error("403 Forbidden")).statusLabel).toBe(
      "HTTP 403",
    );
  });

  test("no badge when the message carries no plausible status", () => {
    const { detail, statusLabel } = describeError(new Error("Something broke"));
    expect(statusLabel).toBeNull();
    expect(detail).toBe("Something broke");
  });

  test("does not badge unrelated multi-digit numbers", () => {
    expect(
      describeError(new Error("Loaded 1234 rows but parse failed")).statusLabel,
    ).toBeNull();
  });

  test("truncates very long messages", () => {
    const long = `x${"y".repeat(400)}`;
    const { detail } = describeError(new Error(long));
    expect(detail.length).toBeLessThanOrEqual(200);
    expect(detail.endsWith("…")).toBe(true);
  });
});

describe("describeError — genuine network failures keep the connection copy", () => {
  test("a TypeError (fetch rejection) is treated as a network error", () => {
    const { detail, statusLabel } = describeError(
      new TypeError("Failed to fetch"),
    );
    expect(statusLabel).toBeNull();
    expect(detail).toMatch(/check your connection/i);
  });

  test("a 'NetworkError' message is treated as a network error", () => {
    expect(
      describeError(new Error("NetworkError when attempting to fetch resource"))
        .detail,
    ).toMatch(/check your connection/i);
  });

  test("non-Error throwables fall back to a generic retry message", () => {
    const { detail, statusLabel } = describeError("just a string");
    expect(statusLabel).toBeNull();
    expect(detail).toMatch(/request failed/i);
  });
});
