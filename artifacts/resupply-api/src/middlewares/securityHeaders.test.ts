// Pins the security-header values the middleware emits — specifically
// the Permissions-Policy camera allowlist. This process serves BOTH the
// JSON API and the cpap-fitter SPA's HTML (post-May-2026 consolidation),
// and the face-scan capture page calls getUserMedia: an empty `camera=()`
// allowlist on the top-level document makes Chromium reject it with
// NotAllowedError. That regression shipped once (the production face-scan
// was dead on arrival — docs/app-review-2026-06-10.md P0-1) and the e2e
// suite can't catch it because it stubs getUserMedia. `camera=(self)` is
// load-bearing; everything else stays denied.

import type { NextFunction, Request, Response } from "express";
import { describe, expect, it } from "vitest";

import { securityHeaders } from "./securityHeaders";

function run(headers: Record<string, string> = {}): Map<string, string> {
  const set = new Map<string, string>();
  const req = {
    secure: false,
    get: (name: string) => headers[name.toLowerCase()],
  } as unknown as Request;
  const res = {
    setHeader: (name: string, value: string) => {
      set.set(name, value);
    },
  } as unknown as Response;
  const next: NextFunction = () => {};
  securityHeaders(req, res, next);
  return set;
}

describe("securityHeaders Permissions-Policy", () => {
  it("allows same-origin camera (the SPA face-scan needs getUserMedia)", () => {
    const policy = run().get("Permissions-Policy") ?? "";
    expect(policy).toContain("camera=(self)");
    expect(policy).not.toContain("camera=()");
  });

  it("keeps every other capability denied", () => {
    const policy = run().get("Permissions-Policy") ?? "";
    expect(policy).toContain("geolocation=()");
    expect(policy).toContain("microphone=()");
    expect(policy).toContain("payment=()");
    expect(policy).toContain("usb=()");
  });
});

describe("securityHeaders HSTS", () => {
  it("is omitted on plain-HTTP requests", () => {
    expect(run().has("Strict-Transport-Security")).toBe(false);
  });

  it("is emitted when X-Forwarded-Proto says https", () => {
    expect(
      run({ "x-forwarded-proto": "https" }).get("Strict-Transport-Security"),
    ).toContain("max-age=31536000");
  });
});
