// The return target is a query parameter, so every one of these inputs is
// something an attacker can put in a link and send to a clinician.

import { describe, expect, it } from "vitest";

import { safeReturnTo } from "./safe-return";

describe("safeReturnTo", () => {
  it("accepts a path inside the provider portal", () => {
    expect(safeReturnTo("?return=%2Fprovider%2Freferrals%2Fabc")).toBe(
      "/provider/referrals/abc",
    );
  });

  it("returns null when no target was asked for", () => {
    expect(safeReturnTo("")).toBeNull();
    expect(safeReturnTo("?other=1")).toBeNull();
  });

  it.each([
    ["absolute url", "https://evil.example/steal"],
    ["protocol-relative", "//evil.example/steal"],
    ["backslash protocol-relative", "/\\evil.example/steal"],
    ["javascript scheme", "javascript:alert(1)"],
    ["outside the portal", "/admin/patients"],
    ["bare path", "provider/referrals/abc"],
  ])("refuses %s", (_label, value) => {
    expect(safeReturnTo(`?return=${encodeURIComponent(value)}`)).toBeNull();
  });
});
