// Pins the security-header values the middleware emits — specifically
// the Permissions-Policy camera/microphone allowlists. This process serves
// BOTH the JSON API and the cpap-fitter SPA's HTML (post-May-2026
// consolidation); the face-scan capture page calls getUserMedia({video})
// and the telehealth video-visit page calls getUserMedia({video, audio}):
// an empty `camera=()` / `microphone=()` allowlist on the top-level
// document makes Chromium reject it with NotAllowedError. That regression
// shipped twice (the production face-scan was dead on arrival —
// docs/app-review-2026-06-10.md P0-1 — and later the video visit, blocked
// by `microphone=()`) and the e2e suite can't catch it because it stubs
// getUserMedia. `camera=(self)` and `microphone=(self)` are load-bearing;
// everything else stays denied.

import type { NextFunction, Request, Response } from "express";
import { describe, expect, it } from "vitest";

import { securityHeaders } from "./securityHeaders";

function run(headers: Record<string, string> = {}): Map<string, string> {
  const set = new Map<string, string>();
  const req = {
    secure: false,
    // A real Express request always carries `headers`; the stub omitted it
    // because nothing here read it until the middleware started resolving the
    // request host (to noindex the non-canonical deploy hosts).
    headers,
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

describe("securityHeaders X-Robots-Tag (non-canonical deploy hosts)", () => {
  // The Railway *.up.railway.app hosts serve the same content as the
  // canonical domains, so anything indexed from them is duplicate content.
  // The SPA sets a noindex meta tag there, but that needs the crawler to run
  // JavaScript; this header states it without that dependency and covers
  // non-HTML responses too. robots.txt on these hosts allows crawling
  // precisely so this gets read — see buildNoindexRobotsTxt.
  it("marks a Railway preview host noindex", () => {
    for (const host of [
      "pennfit.up.railway.app",
      "resupply-api-pennfit-pr-1290.up.railway.app",
    ]) {
      expect(run({ host }).get("X-Robots-Tag"), host).toBe("noindex");
    }
  });

  it("leaves the canonical apex and tenant domains indexable", () => {
    for (const host of [
      "cmbreathe.com",
      "www.cmbreathe.com",
      "pennpaps.com",
      "acme.cmbreathe.com",
    ]) {
      expect(run({ host }).has("X-Robots-Tag"), host).toBe(false);
    }
  });

  it("does not set the header when there is no host at all", () => {
    expect(run().has("X-Robots-Tag")).toBe(false);
  });
});

describe("securityHeaders Permissions-Policy", () => {
  it("allows same-origin camera (the SPA face-scan needs getUserMedia)", () => {
    const policy = run().get("Permissions-Policy") ?? "";
    expect(policy).toContain("camera=(self)");
    expect(policy).not.toContain("camera=()");
  });

  it("allows same-origin microphone (the video visit needs getUserMedia audio)", () => {
    const policy = run().get("Permissions-Policy") ?? "";
    expect(policy).toContain("microphone=(self)");
    expect(policy).not.toContain("microphone=()");
  });

  it("keeps every other capability denied", () => {
    const policy = run().get("Permissions-Policy") ?? "";
    expect(policy).toContain("geolocation=()");
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
