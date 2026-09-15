import { describe, expect, it } from "vitest";
import {
  pricingDestinationFingerprint,
  pricingShippingAddress,
} from "./shipping";

const address = {
  line1: "123 Fixture St",
  city: "York",
  state: "PA",
  country: "US",
};
describe("pricing shipping address compatibility", () => {
  it("normalizes the PacWare postalCode field to the carrier ZIP without changing the saved address", () => {
    const imported = { ...address, postalCode: " 17401 " };
    expect(pricingShippingAddress(imported)?.zip).toBe("17401");
    expect(pricingDestinationFingerprint(imported)).toBe(
      pricingDestinationFingerprint({ ...address, zip: "17401" }),
    );
    expect(imported).toEqual({ ...address, postalCode: " 17401 " });
  });
  it("prefers the explicit ZIP and uses imported postalCode when ZIP is blank", () => {
    expect(
      pricingShippingAddress({ ...address, zip: "17402", postalCode: "17401" })
        ?.zip,
    ).toBe("17402");
    expect(
      pricingShippingAddress({ ...address, zip: "  ", postalCode: "17401" })
        ?.zip,
    ).toBe("17401");
    expect(pricingShippingAddress({ ...address, postalCode: "" })).toBeNull();
    expect(pricingShippingAddress(null)).toBeNull();
  });
});
