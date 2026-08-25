import { describe, expect, it } from "vitest";

import { hashToAccountTab } from "./account";

describe("account hash deep links", () => {
  it("opens the overview tab for insights push-notification links", () => {
    expect(hashToAccountTab("#insights")).toBe("overview");
    expect(hashToAccountTab("insights")).toBe("overview");
  });

  it("no longer resolves the retired orders/autoship links", () => {
    // The orders tab retired with cash-pay. An old push or email deep link
    // now falls through to the account page's default tab rather than
    // targeting a tab that no longer exists.
    expect(hashToAccountTab("#orders")).toBeNull();
    expect(hashToAccountTab("#autoship")).toBeNull();
  });

  it("ignores unknown hashes so the account page can use its default tab", () => {
    expect(hashToAccountTab("#does-not-exist")).toBeNull();
    expect(hashToAccountTab("")).toBeNull();
  });
});
