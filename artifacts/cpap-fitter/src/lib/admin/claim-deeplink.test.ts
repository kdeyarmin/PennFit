import { describe, expect, it } from "vitest";

import { consumeClaimParam } from "./claim-deeplink";

describe("consumeClaimParam", () => {
  it("extracts the claim id and strips it from the search", () => {
    expect(consumeClaimParam("?claim=abc")).toEqual({
      claimId: "abc",
      nextSearch: "",
    });
  });

  it("preserves the other params when stripping claim", () => {
    expect(consumeClaimParam("?claim=abc&tab=lines")).toEqual({
      claimId: "abc",
      nextSearch: "?tab=lines",
    });
  });

  it("returns null and leaves the search intact when claim is absent", () => {
    expect(consumeClaimParam("?tab=lines")).toEqual({
      claimId: null,
      nextSearch: "?tab=lines",
    });
  });

  it("handles an empty search", () => {
    expect(consumeClaimParam("")).toEqual({ claimId: null, nextSearch: "" });
  });

  it("treats an explicit empty claim value as no claim, and still strips it", () => {
    // ?claim= (no value) is not a real claim to open.
    expect(consumeClaimParam("?claim=")).toEqual({
      claimId: null,
      nextSearch: "",
    });
  });
});
