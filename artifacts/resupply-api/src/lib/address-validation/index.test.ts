import { describe, expect, it } from "vitest";

import { validateAddress } from "./index";

describe("validateAddress", () => {
  it("accepts a complete US address", () => {
    const r = validateAddress({
      line1: "123 Main St",
      city: "Philadelphia",
      state: "PA",
      postalCode: "19104",
      country: "US",
    });
    expect(r.ok).toBe(true);
  });

  it("accepts ZIP+4", () => {
    const r = validateAddress({
      line1: "123 Main St",
      city: "Philadelphia",
      state: "PA",
      postalCode: "19104-1234",
      country: "US",
    });
    expect(r.ok).toBe(true);
  });

  it("rejects a US 4-digit ZIP", () => {
    const r = validateAddress({
      line1: "123 Main St",
      city: "Philadelphia",
      state: "PA",
      postalCode: "1910",
      country: "US",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons).toContain("us_zip_invalid_format");
  });

  it("rejects a full state name in the state field", () => {
    const r = validateAddress({
      line1: "123 Main St",
      city: "Philadelphia",
      state: "Pennsylvania",
      postalCode: "19104",
      country: "US",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons).toContain("us_state_must_be_two_letters");
  });

  it("rejects when line1 is missing", () => {
    const r = validateAddress({
      city: "Philadelphia",
      state: "PA",
      postalCode: "19104",
      country: "US",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons).toContain("street_address_too_short");
  });

  it("defaults missing country to US", () => {
    const r = validateAddress({
      line1: "123 Main St",
      city: "Philadelphia",
      state: "PA",
      postalCode: "19104",
    });
    expect(r.ok).toBe(true);
  });
});
