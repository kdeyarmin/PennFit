import { describe, expect, it } from "vitest";

import { validateReceiverAddress } from "./validate";
import type { XpsAddress } from "./config";

const VALID: XpsAddress = {
  name: "Jane Patient",
  address1: "54 Green St",
  city: "Salt Lake City",
  state: "UT",
  zip: "84106",
  country: "US",
};

describe("validateReceiverAddress", () => {
  it("accepts a complete US address", () => {
    expect(validateReceiverAddress(VALID)).toEqual({ ok: true, issues: [] });
  });

  it("accepts ZIP+4", () => {
    expect(validateReceiverAddress({ ...VALID, zip: "84106-1234" }).ok).toBe(
      true,
    );
  });

  it("flags every missing required field at once", () => {
    const res = validateReceiverAddress({
      name: "",
      address1: "",
      city: "",
      state: "",
      zip: "",
      country: "US",
    });
    expect(res.ok).toBe(false);
    expect(res.issues.map((i) => i.field).sort()).toEqual([
      "address1",
      "city",
      "name",
      "state",
      "zip",
    ]);
  });

  it("rejects a non-2-letter state for US", () => {
    const res = validateReceiverAddress({ ...VALID, state: "Utah" });
    expect(res.ok).toBe(false);
    expect(res.issues[0]).toMatchObject({ field: "state" });
  });

  it("rejects a malformed US ZIP", () => {
    const res = validateReceiverAddress({ ...VALID, zip: "841" });
    expect(res.ok).toBe(false);
    expect(res.issues[0]).toMatchObject({ field: "zip" });
  });
});
