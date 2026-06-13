import { describe, expect, it } from "vitest";

import { hashToAccountTab } from "./account";

describe("account hash deep links", () => {
  it("opens the overview tab for insights push-notification links", () => {
    expect(hashToAccountTab("#insights")).toBe("overview");
    expect(hashToAccountTab("insights")).toBe("overview");
  });

  it("opens the orders tab for order and autoship links", () => {
    expect(hashToAccountTab("#orders")).toBe("orders");
    expect(hashToAccountTab("#autoship")).toBe("orders");
  });

  it("ignores unknown hashes so the account page can use its default tab", () => {
    expect(hashToAccountTab("#does-not-exist")).toBeNull();
    expect(hashToAccountTab("")).toBeNull();
  });
});
