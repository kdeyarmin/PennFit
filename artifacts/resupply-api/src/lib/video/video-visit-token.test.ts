import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  signVideoVisitToken,
  verifyVideoVisitToken,
} from "./video-visit-token";

const KEY_ENV = "RESUPPLY_LINK_HMAC_KEY";
const VISIT_ID = "5b6f0a51-7e57-4a3e-9a39-2f9be9e9c001";

describe("video-visit-token", () => {
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env[KEY_ENV];
    process.env[KEY_ENV] = "test-key-for-video-visit-tokens";
  });

  afterEach(() => {
    if (saved === undefined) delete process.env[KEY_ENV];
    else process.env[KEY_ENV] = saved;
  });

  it("round-trips a patient token", () => {
    const token = signVideoVisitToken(VISIT_ID, "patient", 1);
    const result = verifyVideoVisitToken(token);
    expect(result).toEqual({
      valid: true,
      visitId: VISIT_ID,
      role: "patient",
      linkVersion: 1,
    });
  });

  it("round-trips a staff token", () => {
    const token = signVideoVisitToken(VISIT_ID, "staff", 3);
    const result = verifyVideoVisitToken(token);
    expect(result).toEqual({
      valid: true,
      visitId: VISIT_ID,
      role: "staff",
      linkVersion: 3,
    });
  });

  it("rejects an expired token", () => {
    const token = signVideoVisitToken(VISIT_ID, "patient", 1, -10);
    expect(verifyVideoVisitToken(token)).toEqual({ valid: false });
  });

  it("rejects a tampered payload", () => {
    const token = signVideoVisitToken(VISIT_ID, "patient", 1);
    const [payload, sig] = token.split(".");
    // Flip one character of the payload; signature no longer matches.
    const flipped =
      (payload![0] === "A" ? "B" : "A") + payload!.slice(1) + "." + sig!;
    expect(verifyVideoVisitToken(flipped)).toEqual({ valid: false });
  });

  it("rejects a token signed with a different key", () => {
    const token = signVideoVisitToken(VISIT_ID, "patient", 1);
    process.env[KEY_ENV] = "a-completely-different-key";
    expect(verifyVideoVisitToken(token)).toEqual({ valid: false });
  });

  it("rejects garbage shapes", () => {
    expect(verifyVideoVisitToken("")).toEqual({ valid: false });
    expect(verifyVideoVisitToken("no-dot-here")).toEqual({ valid: false });
    expect(verifyVideoVisitToken(".leading-dot")).toEqual({ valid: false });
    expect(verifyVideoVisitToken("trailing-dot.")).toEqual({ valid: false });
    expect(verifyVideoVisitToken("not!base64url.also!bad")).toEqual({
      valid: false,
    });
  });

  it("a patient token cannot be replayed after a link_version bump (verifier returns the embedded version for the caller to compare)", () => {
    const token = signVideoVisitToken(VISIT_ID, "patient", 1);
    const result = verifyVideoVisitToken(token);
    expect(result.valid).toBe(true);
    if (result.valid) {
      // The DB row would now carry link_version=2; callers must reject.
      expect(result.linkVersion).not.toBe(2);
    }
  });
});
